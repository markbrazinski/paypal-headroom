import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PpCapture } from '@headroom/contracts';
import { fixture } from '../../../../tests/fixtures/paypal/index.ts';
import { verifyCapture } from './verify.ts';
import { nextPollAt } from './schedule.ts';
import { allocate } from '../receivables/receivables.ts';
import { classifyCreate, classifySend } from '../executor/classify.ts';

const cap = () => PpCapture.parse(fixture('capture-completed').body);
const inv = (c = cap()) => ({ ppInvoiceId: c.invoice_id!, currency: 'USD' as const, openMinor: 12000 });

test('verified capture gives PayPal-reported gross/fee/net and capture create_time', () => {
  const r = verifyCapture(inv(), cap());
  assert.ok(r.ok);
  assert.deepEqual([r.gross.minor, r.fee.minor, r.net.minor, r.capturedAt], [12000, 468, 11532, '2026-10-30T20:08:43.000Z']);
});

test('no receipt unless COMPLETED (REPLAY, status altered to PENDING)', () => {
  const r = verifyCapture(inv(), { ...cap(), status: 'PENDING' });
  assert.deepEqual(r, { ok: false, kind: 'NOT_COMPLETED', reason: 'Capture status PENDING' });
});

test('no receipt on invoice_id / currency mismatch', () => {
  assert.equal(verifyCapture({ ...inv(), ppInvoiceId: 'INV2-OTHER' }, cap()).ok, false);
  const c = cap();
  c.amount.currency_code = 'EUR';
  const r = verifyCapture(inv(), c);
  assert.ok(!r.ok && r.kind === 'MISMATCH');
});

test('gross must equal fee+net; allocation never exceeds open or captured', () => {
  const c = cap();
  c.seller_receivable_breakdown!.net_amount!.value = '115.33';
  assert.equal(verifyCapture(inv(), c).ok, false);
  assert.equal(verifyCapture({ ...inv(), openMinor: 11999 }, cap()).ok, false);
  assert.throws(() => allocate({ openGross: { currency: 'USD', minor: 100 }, state: 'ISSUED' }, { currency: 'USD', minor: 101 }));
  assert.deepEqual(allocate({ openGross: { currency: 'USD', minor: 12000 }, state: 'ISSUED' }, { currency: 'USD', minor: 12000 }).state, 'PAID');
  assert.deepEqual(allocate({ openGross: { currency: 'USD', minor: 12000 }, state: 'ISSUED' }, { currency: 'USD', minor: 2000 }).openGross.minor, 10000);
});

test('S1-IR-13 capture gross must equal the invoice PAYPAL transaction amount', () => {
  assert.equal(verifyCapture({ ...inv(), txAmountMinor: 12000 }, cap()).ok, true);
  assert.equal(verifyCapture({ ...inv(), txAmountMinor: 11000 }, cap()).ok, false);
});

test('refund before first verification is surfaced, not treated as pending', () => {
  const r = verifyCapture(inv(), { ...cap(), status: 'PARTIALLY_REFUNDED' });
  assert.ok(!r.ok && r.kind === 'MISMATCH');
});

test('poll cadence: 1, 2, 5, 15 min, hourly to day 7, then 6-hourly; daily after PAID; day-8 still polled', () => {
  const issued = '2026-11-01T10:00:00.000Z';
  assert.equal(nextPollAt(issued, '2026-11-01T10:00:10.000Z', false), '2026-11-01T10:01:00.000Z');
  assert.equal(nextPollAt(issued, '2026-11-01T10:01:00.000Z', false), '2026-11-01T10:02:00.000Z');
  assert.equal(nextPollAt(issued, '2026-11-01T10:03:00.000Z', false), '2026-11-01T10:05:00.000Z');
  assert.equal(nextPollAt(issued, '2026-11-01T10:06:00.000Z', false), '2026-11-01T10:15:00.000Z');
  assert.equal(nextPollAt(issued, '2026-11-01T10:15:00.000Z', false), '2026-11-01T11:00:00.000Z');
  assert.equal(nextPollAt(issued, '2026-11-09T10:00:00.000Z', false), '2026-11-09T16:00:00.000Z');
  assert.equal(nextPollAt(issued, '2026-11-02T10:00:00.000Z', true), '2026-11-03T10:00:00.000Z');
});

test('create/send classification: timeout → UNKNOWN, 422 duplicate → search, other 4xx → failure, 5xx → UNKNOWN', () => {
  assert.equal(classifyCreate(undefined).kind, 'UNKNOWN');
  assert.deepEqual(classifyCreate(fixture('create-201')).kind, 'CREATED');
  assert.equal(classifyCreate(fixture('create-422-duplicate')).kind, 'DUPLICATE');
  assert.equal(classifyCreate({ status: 400, body: { name: 'INVALID_REQUEST' } }).kind, 'FAILURE');
  assert.equal(classifyCreate({ status: 503, body: {} }).kind, 'UNKNOWN');
  assert.equal(classifyCreate({ status: 429, body: {} }).kind, 'UNKNOWN');
  assert.equal(classifySend(fixture('send-200')).kind, 'SENT');
  assert.equal(classifySend({ status: 422, body: {} }).kind, 'CHECK_STATUS');
  assert.equal(classifySend(undefined).kind, 'UNKNOWN');
});
