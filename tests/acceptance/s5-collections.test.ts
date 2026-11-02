// S5 layer 3: the hero money path (S05 §6.11). Setup in s5-helpers.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actionOf, approved, check, FEES, invOf, items, lagReport, pay, puts, report, scenario, TUE_0805, WED_0900 } from './s5-helpers.ts';

test('S5-A4/A2/A1/C1 contact time: Pellow reminder sent, Harrow partial enabled on the SAME invoice (one PUT), both pay → claim-aware receipts', async () => {
  const { h } = await approved();
  const invoicesBefore = h.pp.invoices.size;
  h.setNow(TUE_0805);
  await h.drain();
  const harrow = await invOf(h, 'cust-harrow');
  const fake = h.pp.invoices.get(harrow.ppInvoiceId)!;
  assert.deepEqual(fake.doc.configuration.partial_payment, { allow_partial_payment: true, minimum_amount_due: { currency_code: 'USD', value: '7200.00' } });
  assert.equal(puts(h), 1, 'one PUT for the slice');
  assert.equal(h.pp.invoices.size, invoicesBefore, 'no second invoice (B3)');
  const slice = await actionOf(h, 'COLLECT_UNDISPUTED_SLICE');
  assert.equal(slice.state, 'APPLIED');
  const grants = await items(h, 'GRANT#');
  const cs = grants.find((g) => g.kind === 'COLLECT_SLICE')!;
  assert.deepEqual([cs.state, cs.consumedBy], ['CONSUMED', `upd:${slice.rootId}:${slice.intentVersion}:ENABLE_PARTIAL`]);
  const pellow = await actionOf(h, 'COLLECT_OVERDUE');
  assert.equal(pellow.state, 'APPLIED', 'reminder sent at contact time');
  const outs = await items(h, 'OUTMSG#');
  assert.equal(outs.filter((o) => o.state === 'SENT').length, 2, 'Pellow reminder + Harrow message after its verified update');
  const sent = await h.mailbox.list();
  assert.equal(sent.filter((m) => m.labelIds.includes('SENT')).length, 2, 'exactly two messages in the mailbox');
  assert.ok(outs.every((o) => o.channel === 'SIMULATED'));

  const p = await pay(h, 'cust-pellow', 760_000, FEES.pellow);
  const r = await pay(h, 'cust-harrow', 720_000, FEES.harrow);
  const allocs = await items(h, 'ALLOC#');
  assert.deepEqual(allocs.filter((a) => a.invoiceId === r.inv.invoiceId).map((a) => [a.claim, a.amount.minor]), [['UNDISPUTED', 720_000]]);
  assert.deepEqual(allocs.filter((a) => a.invoiceId === p.inv.invoiceId).map((a) => [a.claim, a.amount.minor]), [['WHOLE', 760_000]]);
  const hv = await invOf(h, 'cust-harrow');
  assert.deepEqual([hv.state, hv.openGross.minor, hv.providerDueMinor, hv.conservation], ['PARTIALLY_PAID', 180_000, 180_000, 'PASS']);
  assert.equal((await actionOf(h, 'COLLECT_UNDISPUTED_SLICE')).state, 'COMPLETED', 'slice paid; the disputed $1,800 stays open');
  assert.equal((await actionOf(h, 'COLLECT_OVERDUE')).state, 'COMPLETED');
  // K6 / beat 5: Expected counts both captures before PayPal's report; Downside doesn't.
  const f = await h.forecast();
  assert.deepEqual([f.summary.low.minor, f.summary.lowOn], [974_250, '2026-11-20']);
  const down = await scenario(h, 'DOWNSIDE');
  assert.ok(down.summary.low.minor < 974_250, 'Downside excludes captured money awaiting the report');
});

test('S5-A5/A6/K1/K2 + S7-B10 Mercer check: both captures confirmed COMPLETED by PayPal → SKIPPED_NOT_NEEDED at once (no wait for the report), zero PUT and zero send', async () => {
  const { h } = await approved();
  h.setNow(TUE_0805);
  await h.drain();
  // Both pay Wednesday 08:30; the check runs 09:00 while PayPal's report is as of 07:00 (captured, not yet reported: AT-F01).
  h.setNow('2026-11-11T13:30:00.000Z');
  const putsBefore = puts(h);
  const sentBefore = (await h.mailbox.list()).length;
  await pay(h, 'cust-pellow', 760_000, FEES.pellow);
  await pay(h, 'cust-harrow', 720_000, FEES.harrow);
  h.setNow(WED_0900);
  lagReport(h);
  const { a, chk } = await check(h);
  // S7-B10 (owner, 3 Nov 2026): PayPal's own capture GETs confirm both COMPLETED, so they count now; the report confirms them later.
  assert.equal(a.state, 'SKIPPED_NOT_NEEDED', JSON.stringify(chk?.blockers ?? a.heldReasons));
  assert.deepEqual([chk!.decision, chk!.lowerMin.closeMinor, chk!.lowerMin.on], ['SKIP', 444_250, '2026-12-20']);
  assert.equal(puts(h), putsBefore + 0, 'zero PayPal updates on skip');
  assert.equal((await h.mailbox.list()).length, sentBefore, 'zero messages on skip');
  assert.equal(chk!.lowerSeries.length, 42);
  const acts = (await h.api('GET', '/v1/activity')).body.rows.map((x: any) => x.result).join('\n');
  assert.match(acts, /Mercer Architects offer not needed: .*the \$90\.00 discount was never offered/);
});
