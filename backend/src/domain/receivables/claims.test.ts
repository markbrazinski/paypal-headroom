import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allocateClaim, invoiceProjection } from './claims.ts';

const usd = (minor: number) => ({ currency: 'USD' as const, minor });
const harrow = { undisputed: usd(720_000), disputed: usd(180_000) };
const allocs = (xs: ReturnType<typeof allocateClaim>) => xs.map((x) => ({ claim: x.claim, amount: usd(x.minor) }));

test('C1 claims: allocation ceilings (undisputed first, rest UNALLOCATED, never DISPUTED; no claim → WHOLE)', () => {
  assert.deepEqual(allocateClaim(720_000, harrow, []), [{ claim: 'UNDISPUTED', minor: 720_000 }]);
  assert.deepEqual(allocateClaim(900_000, harrow, []), [{ claim: 'UNDISPUTED', minor: 720_000 }, { claim: 'UNALLOCATED', minor: 180_000 }]);
  const first = allocateClaim(70_000, harrow, []);
  assert.deepEqual(first, [{ claim: 'UNDISPUTED', minor: 70_000 }]);
  const p = invoiceProjection({ amount: usd(900_000) }, { dueMinor: 830_000, status: 'PARTIALLY_PAID' }, harrow, allocs(first), []);
  assert.equal(p.undisputedOpen!.minor, 650_000, 'DATA-MODEL "Harrow $700" case');
  // a later payment after the undisputed part is covered goes UNALLOCATED; total allocated = captured
  assert.deepEqual(allocateClaim(100_000, harrow, [{ claim: 'UNDISPUTED', amount: usd(720_000) }]), [{ claim: 'UNALLOCATED', minor: 100_000 }]);
  for (const g of [1, 70_000, 720_000, 900_000]) assert.equal(allocateClaim(g, harrow, []).reduce((t, x) => t + x.minor, 0), g);
  assert.deepEqual(allocateClaim(760_000, null, []), [{ claim: 'WHOLE', minor: 760_000 }]);
  assert.throws(() => allocateClaim(0, null, []));
});

test('P1 claims: projection conserves (discount settlement, partial under discount, overpayment, mismatch → HOLD)', () => {
  // Mercer pays 441000 under an ACTIVE $90 concession → 0 = PayPal due 0
  const mercer = invoiceProjection({ amount: usd(450_000) }, { dueMinor: 0, status: 'PAID' }, null, [{ claim: 'WHOLE', amount: usd(441_000) }], [{ amount: usd(9_000), state: 'SETTLED' }]);
  assert.equal(mercer.collectibleOpen.minor, 0);
  assert.equal(mercer.conservation, 'PASS');
  assert.equal(mercer.concessions.minor, 9_000);
  // partial 200000 under the discount → 241000; after removal → 250000 = PayPal due
  const under = invoiceProjection({ amount: usd(450_000) }, { dueMinor: 241_000, status: 'PARTIALLY_PAID' }, null, [{ claim: 'WHOLE', amount: usd(200_000) }], [{ amount: usd(9_000), state: 'ACTIVE' }]);
  assert.deepEqual([under.collectibleOpen.minor, under.conservation], [241_000, 'PASS']);
  const removed = invoiceProjection({ amount: usd(450_000) }, { dueMinor: 250_000, status: 'PARTIALLY_PAID' }, null, [{ claim: 'WHOLE', amount: usd(200_000) }], [{ amount: usd(9_000), state: 'REMOVED' }]);
  assert.deepEqual([removed.collectibleOpen.minor, removed.conservation], [250_000, 'PASS']);
  // a discounted capture after removal: $90 still due, which must equal PayPal's due
  const late = invoiceProjection({ amount: usd(450_000) }, { dueMinor: 9_000, status: 'PARTIALLY_PAID' }, null, [{ claim: 'WHOLE', amount: usd(441_000) }], [{ amount: usd(9_000), state: 'REMOVED' }]);
  assert.deepEqual([late.collectibleOpen.minor, late.conservation], [9_000, 'PASS']);
  // Harrow pays 900000: identity collectible = undisputedOpen + disputedUnresolved − unallocatedCredit − concessions
  const h = invoiceProjection({ amount: usd(900_000) }, { dueMinor: 0, status: 'PAID' }, harrow, allocs(allocateClaim(900_000, harrow, [])), []);
  assert.deepEqual([h.collectibleOpen.minor, h.undisputedOpen!.minor, h.disputedUnresolved!.minor, h.unallocatedCredit!.minor], [0, 0, 180_000, 180_000]);
  assert.equal(h.collectibleOpen.minor, h.undisputedOpen!.minor + h.disputedUnresolved!.minor - h.unallocatedCredit!.minor - h.concessions.minor);
  // PayPal disagrees → HOLD; unreadable → UNKNOWN
  assert.equal(invoiceProjection({ amount: usd(450_000) }, { dueMinor: 450_000, status: 'SENT' }, null, [], [{ amount: usd(9_000), state: 'ACTIVE' }]).conservation, 'HOLD');
  assert.equal(invoiceProjection({ amount: usd(450_000) }, { dueMinor: null, status: null }, null, [], []).conservation, 'UNKNOWN');
});

test('Y5 S7 R5 allocation: undisputed first, DISPUTED only up to the consumed allowance, the rest unallocated; projection conserves', async () => {
  const { allocateClaim: alloc, invoiceProjection: proj } = await import('./claims.ts');
  const claim = { undisputed: { currency: 'USD' as const, minor: 720_000 }, disputed: { currency: 'USD' as const, minor: 180_000 } };
  assert.deepEqual(alloc(180_000, claim, [], null), [{ claim: 'UNDISPUTED', minor: 180_000 }], 'disputed paid first still settles the undisputed part first');
  const paidU = [{ claim: 'UNDISPUTED' as const, amount: { currency: 'USD' as const, minor: 720_000 } }];
  assert.deepEqual(alloc(180_000, claim, paidU, null), [{ claim: 'UNALLOCATED', minor: 180_000 }], 'S7-R9 no allowance → never DISPUTED');
  assert.deepEqual(alloc(180_000, claim, paidU, { allowedMinor: 100_000, usedMinor: 0 }), [{ claim: 'DISPUTED', minor: 100_000 }, { claim: 'UNALLOCATED', minor: 80_000 }]);
  const all = [...paidU, { claim: 'DISPUTED' as const, amount: { currency: 'USD' as const, minor: 180_000 } }];
  const p = proj({ amount: { currency: 'USD', minor: 900_000 } }, { dueMinor: 0, status: 'PAID' }, claim, all, []);
  assert.deepEqual([p.collectibleOpen.minor, p.undisputedOpen!.minor, p.disputedUnresolved!.minor, p.conservation], [0, 0, 0, 'PASS'], 'S7-R35 both portions paid: conserves');
});
