import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.ts';

test('T1→T2→pay→T3 poll: one receipt with PayPal gross/fee/net; invoice paid; net counted once (REPLAY)', async () => {
  const h = await harness();
  const { id, send } = await h.draftAndIssue(4200);
  assert.equal(send.status, 202);
  assert.equal(send.body.effectId.startsWith('HR-'), true);
  assert.equal((await h.invoice(id)).invoice.state, 'ISSUING');

  await h.drain();
  const issued = await h.invoice(id);
  assert.equal(issued.invoice.state, 'ISSUED');
  assert.equal(issued.effect.state, 'VERIFIED_SUCCESS');
  assert.ok(issued.payerUrl);
  assert.equal(h.pp.count('CREATE'), 1);
  assert.equal(h.pp.count('SEND'), 1);

  const capId = h.pp.pay(issued.ppInvoiceId, { feeMinor: 194 });
  await h.advance(61_000); // first poll at +1 min
  const paid = await h.invoice(id);
  assert.equal(paid.invoice.state, 'PAID');
  assert.equal(paid.invoice.open.minor, 0);
  assert.equal(paid.receipts.length, 1);
  assert.deepEqual([paid.receipts[0].captureId, paid.receipts[0].gross.minor, paid.receipts[0].fee.minor, paid.receipts[0].net.minor], [capId, 4200, 194, 4006]);
  assert.equal(paid.allocations[0].amount.minor, 4200);
  // Captured after the PayPal as-of: not yet in a PayPal report; confirmed COMPLETED by the capture GET, so it counts (S7-B10).
  assert.equal(paid.receipts[0].inReportedBalance, 'NOT_YET');

  const cash = (await h.api('GET', '/v1/cash/position')).body;
  const est = cash.sources[0].estimate;
  assert.equal(cash.sources[0].reportedAvailable.minor, 500_000);
  assert.equal(est.lower.minor, 500_000 + 4006, 'S7-B10: a confirmed capture counts in both figures');
  assert.equal(est.upper.minor, 500_000 + 4006, 'net once');
  assert.equal(cash.currentBadge.state, 'NOT_VERIFIABLE');

  const rec = (await h.api('GET', '/v1/receivables')).body;
  assert.equal(rec.incoming.length, 1);
  assert.equal(rec.invoices[0].state, 'PAID');
  const ov = (await h.api('GET', '/v1/overview')).body;
  assert.equal(ov.owedToYou.sum.minor, 0);
  assert.ok(ov.activity.some((a: any) => a.event === 'Payment verified'));
});
