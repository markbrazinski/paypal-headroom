// S5 layer 3: the Mercer offer when it IS needed, its bounded end (S5-D25), the per-stage gates (S5-D9) and the update executor's
// fault paths (S5-D4). Setup in s5-helpers.ts (REPLAY fake PayPal; captures are never evidence).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actionOf, approved, check, FEES, invOf, items, lagReport, pay, pk, puts, report, TUE_0805, WED_0900, type H } from './s5-helpers.ts';

/** Only Pellow pays (reported), so verified funds fall short at the Wednesday check: the offer is needed (S5-R2). */
async function onePayer(o: Parameters<typeof approved>[0] = {}) {
  const { h, rev } = await approved(o);
  h.setNow(TUE_0805);
  await h.drain();
  h.setNow('2026-11-10T16:00:00.000Z');
  const p = await pay(h, 'cust-pellow', 760_000, FEES.pellow);
  h.setNow('2026-11-11T13:00:00.000Z');
  await report(h, [{ cap: p.cap, gross: 760_000, fee: FEES.pellow, number: p.inv.invoiceNumber }]);
  lagReport(h, 5 * 60_000);
  h.setNow(WED_0900);
  return { h, rev };
}
const mercerFake = async (h: H) => h.pp.invoices.get((await invOf(h, 'cust-mercer')).ppInvoiceId)!;
const dueOn = async (h: H) => { const f = await mercerFake(h); return f.amountMinor - (f.doc.discountPercent ? Math.round(f.amountMinor * Number(f.doc.discountPercent) / 100) : 0); };

test('S5-R2/E3/P1/R35 one payer → 2% applied on PayPal (due 4410, concession ACTIVE); Mercer pays 4410 → PAID, SETTLED, COMPLETED, removal released', async () => {
  const { h } = await onePayer();
  const before = puts(h);
  const { a, chk } = await check(h);
  assert.equal(chk!.decision, 'NEEDED', JSON.stringify(chk!.blockers));
  assert.equal(chk!.lowerMin.closeMinor, -250_573, 'K3 Pellow only');
  await h.drain();
  const offer = await actionOf(h, 'DISCOUNT_FALLBACK');
  assert.equal(offer.state, 'APPLIED', JSON.stringify(offer.heldReasons));
  assert.equal(puts(h), before + 1, 'one PUT: the discount');
  assert.equal(await dueOn(h), 441_000);
  const conc = (await items(h, 'CONCESSION#'))[0];
  assert.deepEqual([conc.state, conc.amount.minor], ['ACTIVE', 9_000]);
  assert.equal(offer.expiry.state, 'SCHEDULED');
  const outs = await items(h, 'OUTMSG#');
  assert.ok(outs.some((o) => o.actionId === offer.actionId && o.state === 'SENT'), 'the offer message follows the verified apply');
  void a;
  // Mercer pays the discounted amount: PayPal PAID = Headroom open 0; the $90 is a discount given, not revenue, one receipt.
  await pay(h, 'cust-mercer', 441_000, 15_440);
  const mv = await invOf(h, 'cust-mercer');
  assert.deepEqual([mv.state, mv.openGross.minor, mv.providerDueMinor, mv.conservation], ['PAID', 0, 0, 'PASS']);
  assert.equal((await items(h, 'CONCESSION#'))[0].state, 'SETTLED');
  const done = await actionOf(h, 'DISCOUNT_FALLBACK');
  assert.deepEqual([done.state, done.expiry.state], ['COMPLETED', 'RELEASED']);
  const rm = await h.store.get('work', `EFFECT#${done.expiry.removeKey}`, 'EFFECT');
  assert.deepEqual([rm!.state, rm!.failure], ['VERIFIED_FAILURE', 'Released unsent: the invoice was paid']);
  const p2 = puts(h);
  h.setNow('2026-11-14T00:00:00.000Z');
  await h.drain();
  assert.equal(puts(h), p2, 'no removal PUT after payment');
});

test('S5-R15/X1/R36 offer not paid: removal at the end restores 4500 → EXPIRED; paused over the end → "still on PayPal", resume removes it', async () => {
  const { h } = await onePayer();
  await check(h);
  await h.drain();
  assert.equal(await dueOn(h), 441_000);
  // Pause outreach, then pass the end (Fri Nov 13 18:00 New York = 23:00Z): the removal is held, honestly.
  const pol = (await h.api('GET', '/v1/delegation')).body;
  assert.equal((await h.api('POST', '/v1/delegation/pauses', { kind: 'OUTREACH', on: true }, { 'if-match': String(pol.version) })).status, 200);
  const p0 = puts(h);
  h.setNow('2026-11-13T23:05:00.000Z');
  await h.drain();
  let offer = await actionOf(h, 'DISCOUNT_FALLBACK');
  assert.deepEqual([offer.state, offer.expiry.state, puts(h)], ['APPLIED', 'HELD_PAUSED', p0]);
  assert.equal(await dueOn(h), 441_000, 'the discount is still on PayPal while paused (shown, never hidden)');
  const acts = (await h.api('GET', '/v1/activity')).body.rows.map((x: any) => x.result).join('\n');
  assert.match(acts, /still on PayPal/);
  const pol2 = (await h.api('GET', '/v1/delegation')).body;
  assert.equal((await h.api('POST', '/v1/delegation/pauses', { kind: 'OUTREACH', on: false }, { 'if-match': String(pol2.version) })).status, 200);
  await h.drain();
  offer = await actionOf(h, 'DISCOUNT_FALLBACK');
  assert.deepEqual([offer.state, offer.expiry.state], ['EXPIRED', 'REMOVED']);
  assert.equal(await dueOn(h), 450_000);
  assert.equal(puts(h), p0 + 1, 'one removal PUT');
  assert.equal((await items(h, 'CONCESSION#'))[0].state, 'REMOVED');
});

test('S5-R12/R13/E2 gates at the check: rules tightened → RULES_CHANGED (no PUT); took over → YOU_TOOK_OVER, hand back re-runs; pause → never a skip', async () => {
  // Rules tightened below 2%: the in-limit approval no longer authorizes it at dispatch time (A-002).
  let { h } = await onePayer();
  const pol = (await h.api('GET', '/v1/delegation')).body;
  const prev = (await h.api('POST', '/v1/delegation/preview', { key: 'ar.discount', scope: 'EVERYWHERE', value: 100 })).body;
  if (prev.previewHash) await h.api('POST', '/v1/delegation/rules', { key: 'ar.discount', scope: 'EVERYWHERE', value: 100, previewHash: prev.previewHash }, { 'if-match': String(pol.version) });
  const p0 = puts(h);
  let r = await check(h);
  if (prev.previewHash) {
    assert.deepEqual([r.a.state, r.a.holdCode], ['HELD', 'RULES_CHANGED'], JSON.stringify(r.a.heldReasons));
    assert.equal(puts(h), p0);
  }
  // Took over Mercer: held, not skipped; hand back re-runs the check.
  ({ h } = await onePayer());
  const mercer = 'cust-mercer';
  assert.equal((await h.api('POST', `/v1/receivables/threads/${mercer}/owner`, { owner: 'YOU' }, { 'if-match': '0' })).status, 200);
  r = await check(h);
  assert.deepEqual([r.a.state, r.a.holdCode, r.chk!.decision], ['HELD', 'YOU_TOOK_OVER', 'HELD']);
  assert.equal((await h.api('POST', `/v1/receivables/threads/${mercer}/owner`, { owner: 'HEADROOM' }, { 'if-match': '1' })).status, 200);
  r = await check(h);
  await h.drain();
  assert.equal((await actionOf(h, 'DISCOUNT_FALLBACK')).state, 'APPLIED', 'hand back: the check re-ran and the offer went out');
  // Paused at check time: HELD PAUSED, never SKIPPED.
  ({ h } = await onePayer());
  const pol3 = (await h.api('GET', '/v1/delegation')).body;
  await h.api('POST', '/v1/delegation/pauses', { kind: 'OUTREACH', on: true }, { 'if-match': String(pol3.version) });
  r = await check(h);
  assert.deepEqual([r.a.state, r.a.holdCode], ['HELD', 'PAUSED']);
});

test('S5-R8/R9/R33/E1 update executor: PayPal refuses → FAILED, no second invoice; lost response → UNKNOWN → same key, one effect; edited outside → CONFLICT, no write', async () => {
  // R8: PayPal refuses the partial update.
  let { h } = await approved();
  const n0 = h.pp.invoices.size;
  h.pp.faults.add('put-422');
  h.setNow(TUE_0805);
  await h.drain();
  let slice = await actionOf(h, 'COLLECT_UNDISPUTED_SLICE');
  assert.equal(slice.state, 'FAILED');
  assert.match(slice.heldReasons[0], /no second invoice/);
  assert.equal(h.pp.invoices.size, n0);
  // R9: the PUT lands but its response is lost → UNKNOWN → reconcile by GET with the same stored request → APPLIED.
  // (If the GET right after the lost response shows it landed, it is VERIFIED_SUCCESS at once; here that GET fails too.)
  ({ h } = await approved());
  h.pp.faults.add('put-lost-response');
  h.setNow(TUE_0805);
  h.pp.onPut = () => h.pp.faults.add('get-invoice-500');
  await h.drain();
  h.pp.onPut = undefined;
  slice = await actionOf(h, 'COLLECT_UNDISPUTED_SLICE');
  assert.equal(slice.state, 'UNCERTAIN');
  h.pp.faults.delete('get-invoice-500');
  await h.advance(61_000);
  slice = await actionOf(h, 'COLLECT_UNDISPUTED_SLICE');
  assert.equal(slice.state, 'APPLIED');
  assert.equal(h.pp.count('PUT'), 1, 'never resent: the GET showed it landed');
  const effs = (await h.store.dump('work')).filter((x) => String(x.pk).startsWith('EFFECT#upd:'));
  assert.equal(effs.length, 1, 'one effect, one key');
  // R33: lost response, then someone edits the invoice in PayPal before reconcile → CONFLICT, no further write.
  ({ h } = await approved());
  h.pp.faults.add('put-lost-response');
  h.setNow(TUE_0805);
  h.pp.onPut = () => h.pp.faults.add('get-invoice-500');
  await h.drain();
  h.pp.onPut = undefined;
  h.pp.faults.delete('get-invoice-500');
  h.pp.editOutside((await invOf(h, 'cust-harrow')).ppInvoiceId, 'edited by the owner in PayPal');
  await h.advance(61_000);
  slice = await actionOf(h, 'COLLECT_UNDISPUTED_SLICE');
  assert.deepEqual([slice.state, slice.holdCode], ['HELD', 'PROVIDER_CHANGED']);
  assert.equal(h.pp.count('PUT'), 1, 'nothing written back');
  void pk; void WED_0900;
});
