import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ReportingRow } from '@headroom/contracts';
import { decidePayout, seedPolicy } from '../delegation/policy.ts';
import { classifyItem, feeCeilingMinor, maskReceiver, maxDebitMinor, payoutBody, receiverSha256, residualOf, senderBatchIdOf } from './payout-core.ts';

const row = (o: Partial<ReportingRow> & Pick<ReportingRow, 'transactionId' | 'eventCode' | 'initiatedAt'>): ReportingRow =>
  ({ status: 'S', amount: null, fee: null, currency: 'USD', updatedAt: null, paypalReferenceId: null, invoiceNumber: null, availableBalance: null, order: 0, ...o });
const usd = (minor: number) => ({ currency: 'USD' as const, minor });
// The observed chain (S06 §6.17): T1503 hold −D, T0001 payout −face/−fee (running −D), T1105 release +D. Here face 5,000.00, fee 20.00 (F0).
const FACE = 500_000, FEE = 2_000, D = FACE + FEE;
const chain = [
  row({ transactionId: 'H1', eventCode: 'T1503', initiatedAt: '2026-11-13T14:00:10Z', amount: usd(-D) }),
  row({ transactionId: 'TX1', eventCode: 'T0001', initiatedAt: '2026-11-13T14:00:20Z', amount: usd(-FACE), fee: usd(-FEE), paypalReferenceId: 'H1' }),
  row({ transactionId: 'R1', eventCode: 'T1105', initiatedAt: '2026-11-13T14:00:30Z', amount: usd(D), paypalReferenceId: 'H1' }),
];
const settled = { effectKey: 'pay:x', runId: 'run-a', state: 'SETTLED' as const, faceMinor: FACE, debitMinor: D, transactionId: 'TX1' };

test('Y11a the three-row group at each snapshot: the lower bound never adds a face amount back and never counts the payout twice', () => {
  // PayPal's snapshot at as-of = B0 + the group rows it already shows; the true balance after the payout is B0 − D.
  const B0 = 1_000_000;
  const shown = (asOf: string) => chain.filter((r) => r.initiatedAt <= asOf).reduce((t, r) => t + r.amount!.minor + (r.eventCode === 'T0001' ? r.fee!.minor : 0), 0);
  for (const [asOf, lower, upper] of [['2026-11-13T14:00:00Z', D, D], ['2026-11-13T14:00:15Z', 0, 0], ['2026-11-13T14:00:25Z', 0, -D], ['2026-11-13T14:00:40Z', 0, 0]] as const) {
    const r = residualOf(settled, chain, asOf, true);
    assert.deepEqual([r.lowerMinor, r.upperMinor], [lower, upper], asOf);
    assert.ok(B0 + shown(asOf) - r.lowerMinor <= B0 - D, `lower bound never above the true balance at ${asOf}`);
  }
  assert.equal(residualOf(settled, chain, '2026-11-13T14:00:40Z', true).reported, true);
});

test('Y11b same id with a wrong fee, amount or currency → mismatch, full debit kept, never released', () => {
  for (const bad of [{ fee: usd(-2_500) }, { amount: usd(-499_999) }, { currency: 'EUR' }]) {
    const rows = chain.map((r) => (r.eventCode === 'T0001' ? { ...r, ...bad } : r));
    const r = residualOf(settled, rows, '2026-11-13T14:00:40Z', true);
    assert.ok(r.mismatch, JSON.stringify(bad));
    assert.equal(r.lowerMinor, D);
  }
});

test('Y11c an unreconciled or partial report → the full debit stays subtracted', () => {
  assert.deepEqual([residualOf(settled, chain, '2026-11-13T14:00:40Z', false).lowerMinor, residualOf(settled, [], '2026-11-13T14:00:40Z', true).lowerMinor], [D, D]);
});

test('Y11d an ACTIVE ceiling reservation with a smaller hold: residual = ceiling − hold until the item is known; RELEASED counts 0', () => {
  const active = { ...settled, state: 'ACTIVE' as const, debitMinor: maxDebitMinor(FACE) };
  const r = residualOf(active, chain.slice(0, 2), '2026-11-13T14:00:15Z', true);
  assert.equal(r.lowerMinor, maxDebitMinor(FACE) - D);
  assert.equal(residualOf({ ...active, state: 'RELEASED' }, chain, '2026-11-13T14:00:40Z', true).lowerMinor, 0);
});

const frozen = { senderBatchId: 'HRabc', amountMinor: FACE, receiverSha256: receiverSha256('s-1@personal.example.com') };
const item = (o: any = {}) => ({ payout_item_id: 'I1', transaction_id: 'TX1', transaction_status: 'SUCCESS', sender_batch_id: 'HRabc', payout_item_fee: { currency: 'USD', value: '20.00' }, time_processed: '2026-11-13T14:00:25Z', payout_item: { amount: { currency: 'USD', value: '5000.00' }, receiver: 'S-1@personal.example.com' }, ...o });

test('Y7 only an item SUCCESS bound to the frozen request pays; UNCLAIMED with a transaction id does not; FAILED & co. are final; REFUNDED after PAID is a return', () => {
  assert.deepEqual(classifyItem(item(), frozen), { kind: 'PAID', itemId: 'I1', transactionId: 'TX1', feeMinor: 2_000, timeProcessed: '2026-11-13T14:00:25Z' });
  for (const s of ['PENDING', 'UNCLAIMED', 'ONHOLD']) assert.equal(classifyItem(item({ transaction_status: s }), frozen).kind, 'NOT_PAID', s);
  for (const s of ['FAILED', 'RETURNED', 'BLOCKED', 'REFUNDED']) assert.equal(classifyItem(item({ transaction_status: s }), frozen).kind, 'FINAL', s);
  assert.deepEqual(classifyItem(item({ transaction_status: 'REFUNDED' }), frozen, true), { kind: 'RETURNED', status: 'REFUNDED' });
});

test('Y8 verify binds the frozen request: amount, receiver, sender_batch_id, currency → MISMATCH, never PAID', () => {
  for (const o of [{ payout_item: { amount: { currency: 'USD', value: '9999.99' }, receiver: 's-1@personal.example.com' } }, { payout_item: { amount: { currency: 'USD', value: '5000.00' }, receiver: 'other@personal.example.com' } }, { sender_batch_id: 'HRother' }, { payout_item: { amount: { currency: 'EUR', value: '5000.00' }, receiver: 's-1@personal.example.com' } }]) {
    assert.equal(classifyItem(item(o), frozen).kind, 'MISMATCH', JSON.stringify(o));
  }
});

test('Y14 request body: one EMAIL item, exact amount, deterministic sender_batch_id ≤ 30 chars; masking never reveals the address', () => {
  const b = JSON.parse(payoutBody({ senderBatchId: senderBatchIdOf('run-abc123', 'occ#cmt-keller-ms2#0', 1, 1), receiver: 'keller-pay@supplier.example.com', amountMinor: 1_000_000, business: 'Demo', billNo: 'K-2207', senderItemId: 'x' }));
  assert.equal(b.items.length, 1);
  assert.deepEqual([b.items[0].recipient_type, b.items[0].amount], ['EMAIL', { value: '10000.00', currency: 'USD' }]);
  const id = senderBatchIdOf('run-abc123', 'occ#cmt-keller-ms2#0', 1, 1);
  assert.ok(id.length <= 30);
  assert.equal(id, senderBatchIdOf('run-abc123', 'occ#cmt-keller-ms2#0', 1, 1));
  assert.notEqual(id, senderBatchIdOf('run-abc123', 'occ#cmt-keller-ms2#0', 1, 2));
  assert.equal(maskReceiver('keller-pay@supplier.example.com'), 'k•••@•••.example.com');
  assert.equal(maskReceiver('kim@other.example.com'), maskReceiver('keller-pay@supplier.example.com'), 'two addresses can share a mask (R9): masks are not identity');
});

test('Y16 limits count face + the 2% ceiling: $4,902.00 is inside $5,000 with the estimate but outside with the ceiling', () => {
  assert.equal(feeCeilingMinor(490_200), 9_804);
  const p = seedPolicy('2026-11-01T00:00:00Z');
  assert.equal(decidePayout(p, 'sup-keller', 490_200 + 25, 0).decision, 'REQUIRES_APPROVAL');
  assert.equal(decidePayout(p, 'sup-keller', maxDebitMinor(490_200), 0).decision, 'EXCEPTION');
});
