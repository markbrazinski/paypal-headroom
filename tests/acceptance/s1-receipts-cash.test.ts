import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { minorToDecimal } from '@headroom/contracts';
import { harness, OWNER_B } from './harness.ts';
import { K } from '../../backend/src/adapters/store/keys.ts';
import { reconcileInvoice } from '../../backend/src/domain/paypal-mirror/reconcile-invoice.ts';
import { operatorReset } from '../../backend/src/handlers/operator.ts';

async function issued(minor = 4200) {
  const h = await harness();
  const { id } = await h.draftAndIssue(minor);
  await h.drain();
  return { h, id, ppId: await h.ppIdOf(id) };
}
const amt = (minor: number) => ({ currency_code: 'USD', value: minorToDecimal(minor) });

test('S1-R3 capture not COMPLETED → no receipt; later COMPLETED → one receipt (REPLAY)', async () => {
  const { h, id, ppId } = await issued();
  const cap = h.pp.pay(ppId, { status: 'PENDING' });
  await h.advance(61_000);
  assert.equal((await h.invoice(id)).receipts.length, 0);
  assert.equal((await h.invoice(id)).invoice.state, 'ISSUED');
  h.pp.captures.get(cap).status = 'COMPLETED';
  await h.advance(60_000);
  assert.equal((await h.invoice(id)).receipts.length, 1);
});

test('S1-R5 EXTERNAL transaction → owner assertion only; never receipt or cash', async () => {
  const { h, id, ppId } = await issued();
  h.pp.recordExternal(ppId, 4200);
  await h.advance(61_000);
  const inv = await h.invoice(id);
  assert.equal(inv.receipts.length, 0);
  assert.equal(inv.ownerAssertions.length, 1);
  assert.equal(inv.invoice.open.minor, 4200, 'invoice stays open');
  const cash = (await h.api('GET', '/v1/cash/position')).body.sources[0].estimate;
  assert.equal(cash.upper.minor, 500_000);
});

test('S1-R11 COMPLETED capture with invoice/currency/amount mismatch → no receipt; RECONCILIATION_HOLD visible; audit row', async () => {
  const { h, id, ppId } = await issued();
  h.pp.pay(ppId, { captureInvoiceId: 'INV2-SOMEONE-ELSE' });
  await h.advance(61_000);
  const inv = await h.invoice(id);
  assert.equal(inv.receipts.length, 0);
  assert.match(inv.invoice.hold, /INV2-SOMEONE-ELSE/);
  assert.ok(inv.audit.some((a: any) => a.event === 'Held for reconciliation'));
  const { h: h2, id: id2, ppId: pp2 } = await issued();
  h2.pp.pay(pp2, { currency: 'EUR' });
  await h2.advance(61_000);
  assert.match((await h2.invoice(id2)).invoice.hold, /Currency/);
});

test('S1-R13 ten parallel reconciles of one paid invoice → one receipt, one allocation', async () => {
  const { h, id, ppId } = await issued();
  h.pp.pay(ppId);
  const ref = { tenantId: 'tenant-a', runId: h.run!.runId, invoiceId: id };
  await Promise.all(Array.from({ length: 10 }, () => reconcileInvoice(h.deps, ref, 'POLL')));
  const items = await h.store.query('core', K.run('tenant-a', h.run!.runId));
  assert.equal(items.filter((i) => i.sk.startsWith('RCPT#')).length, 1);
  assert.equal(items.filter((i) => i.sk.startsWith('ALLOC#')).length, 1);
  assert.equal((await h.invoice(id)).invoice.open.minor, 0);
});

test('S1-R12 same Idempotency-Key, different body → 409 IDEMPOTENCY_CONFLICT; nothing written; same body replays', async () => {
  const h = await harness();
  const body = { customerId: 'cust-alder', amount: { currency: 'USD', minor: 1000 }, dueOn: '2026-11-20' };
  const a = await h.api('POST', '/v1/invoices', body, { 'idempotency-key': 'same' });
  const again = await h.api('POST', '/v1/invoices', body, { 'idempotency-key': 'same' });
  const b = await h.api('POST', '/v1/invoices', { ...body, amount: { currency: 'USD', minor: 2000 } }, { 'idempotency-key': 'same' });
  assert.equal(a.status, 201);
  assert.deepEqual(again.body.invoice.invoiceId, a.body.invoice.invoiceId);
  assert.deepEqual([b.status, b.body.code], [409, 'IDEMPOTENCY_CONFLICT']);
  assert.equal((await h.api('GET', '/v1/receivables')).body.invoices.length, 1);
});

test('server validation: amount, currency, past due date, unknown customer, extra fields', async () => {
  const h = await harness();
  const post = (b: unknown) => h.api('POST', '/v1/invoices', b);
  const ok = { customerId: 'cust-alder', amount: { currency: 'USD', minor: 1000 }, dueOn: '2026-11-20' };
  for (const bad of [
    { ...ok, amount: { currency: 'USD', minor: 0 } },
    { ...ok, amount: { currency: 'USD', minor: 10.5 } },
    { ...ok, amount: { currency: 'EUR', minor: 100 } },
    { ...ok, dueOn: '2026-10-01' },
    { ...ok, customerId: 'cust-nobody' },
    { ...ok, tenantId: 'tenant-b' },
  ]) assert.equal((await post(bad)).body.code, 'INVALID_INPUT', JSON.stringify(bad));
});

test('S1-R15 command on an old run after reset → 409 RUN_SEALED; If-Match mismatch → VERSION_CONFLICT; non-draft → NOT_DRAFT', async () => {
  const h = await harness();
  const d = await h.api('POST', '/v1/invoices', { customerId: 'cust-alder', amount: { currency: 'USD', minor: 1000 }, dueOn: '2026-11-20' });
  const id = d.body.invoice.invoiceId;
  assert.equal((await h.api('POST', `/v1/invoices/${id}/send`, undefined, { 'if-match': '7' })).body.code, 'VERSION_CONFLICT');
  assert.equal((await h.api('POST', `/v1/invoices/${id}/send`, undefined, { 'if-match': '1' })).status, 202);
  assert.equal((await h.api('POST', `/v1/invoices/${id}/send`, undefined, { 'if-match': '2' })).body.code, 'NOT_DRAFT');
  await operatorReset(h.deps, 'tenant-a', 'second', { hero: false });
  const r = await h.api('POST', `/v1/invoices/${id}/send`, undefined, { 'if-match': '2' });
  assert.deepEqual([r.status, r.body.code], [409, 'RUN_SEALED']);
  const stale = await h.api('POST', '/v1/invoices', { customerId: 'cust-alder', amount: { currency: 'USD', minor: 1 }, dueOn: '2026-11-20' }, { 'x-headroom-run': h.run!.runId });
  assert.equal(stale.body.code, 'RUN_SEALED');
});

test('S1-R4 / S1-R23 wrong tenant → 404 and no connection data; tenant from the token lookup only', async () => {
  const { h, id } = await issued();
  const asB = (path: string) => h.api('GET', path, undefined, {}, OWNER_B);
  assert.equal((await asB(`/v1/invoices/${id}`)).status, 404);
  const cash = (await asB('/v1/cash/position')).body;
  assert.equal(cash.sources[0].reportedAvailable, null, "owner B can't see owner A's PayPal connection");
  assert.equal((await asB('/v1/receivables')).body.invoices.length, 0);
  assert.equal((await h.api('GET', '/v1/overview', undefined, {}, { sub: 'nobody', email: 'x@example.com' })).status, 401);
  assert.equal((await h.api('GET', '/v1/overview', undefined, {}, null)).status, 401);
});

test('S1-R14 balance without as_of_time → no reported figure; source shows as-of unknown', async () => {
  const h = await harness();
  const { operatorReset } = await import('../../backend/src/handlers/operator.ts');
  h.pp.balance.asOf = undefined;
  // a fresh connection whose first observation has no as-of
  h.deps.config.connectionId = 'pp-noasof';
  await h.store.transact([{ op: 'put', table: 'core', item: { pk: K.tenant('tenant-a'), sk: 'CONN#paypal', connectionId: 'pp-noasof' } }, { op: 'put', table: 'provider', item: { pk: K.conn('pp-noasof'), sk: 'TENANT', tenantId: 'tenant-a' } }]);
  await operatorReset(h.deps, 'tenant-a', 'no as-of', { hero: false });
  const pp = (await h.api('GET', '/v1/cash/position')).body.sources[0];
  assert.deepEqual([pp.reportedAvailable, pp.asOf, pp.estimate], [null, null, null]);
  const ov = (await h.api('GET', '/v1/overview')).body;
  assert.equal(ov.lowestPoint.vsReserve, 'UNKNOWN');
});

test('S1-R8 stale PayPal snapshot → as-of shown, STALE, badge NOT_VERIFIABLE; fetch failure keeps last good', async () => {
  const h = await harness({ asOfLagMs: 3 * 3600_000 + 20 * 60_000 });
  const cash = (await h.api('GET', '/v1/cash/position')).body;
  assert.equal(cash.sources[0].refreshState, 'STALE');
  assert.ok(cash.sources[0].asOf);
  assert.equal(cash.currentBadge.state, 'NOT_VERIFIABLE');
  h.pp.faults.add('balances-500');
  assert.equal((await h.api('POST', '/v1/cash/paypal/refresh')).status, 202);
  await h.drain();
  const failed = (await h.api('GET', '/v1/cash/position')).body.sources[0];
  assert.equal(failed.refreshState, 'FAILED');
  assert.equal(failed.reportedAvailable.minor, 500_000, 'last good figure kept with its time');
});

test('S1-R6 / AT-F05 capture then a reporting row that includes it → one net delta, receipt INCLUDED', async () => {
  const { h, id, ppId } = await issued();
  const capId = h.pp.pay(ppId, { feeMinor: 194, createTime: '2026-11-01T14:05:00Z' });
  await h.advance(61_000);
  let cash = (await h.api('GET', '/v1/cash/position')).body.sources[0].estimate;
  assert.equal(cash.upper.minor, 500_000 + 4006);
  const number = (await h.invoice(id)).invoice.invoiceNumber;
  h.setNow('2026-11-01T16:00:00.000Z');
  // PayPal's next report includes the capture: balance moved by net, row carries the running balance.
  h.pp.balance = { ...h.pp.balance, availableMinor: 504_006, asOf: '2026-11-01T14:30:00.000Z' };
  h.pp.rows = [{ transaction_id: capId, transaction_event_code: 'T0006', transaction_status: 'S', transaction_initiation_date: '2026-11-01T14:05:00Z', transaction_amount: amt(4200), fee_amount: { currency_code: 'USD', value: '-1.94' }, available_balance: amt(504_006), invoice_id: number }];
  await h.api('POST', '/v1/cash/paypal/refresh');
  await h.drain();
  cash = (await h.api('GET', '/v1/cash/position')).body.sources[0].estimate;
  assert.deepEqual([cash.lower.minor, cash.upper.minor, cash.reconciliation], [504_006, 504_006, 'PASS']);
  assert.equal((await h.invoice(id)).receipts[0].inReportedBalance, 'INCLUDED');
});

test('S1-R21 account mismatch rejected and visible; partial pages → inclusion UNKNOWN; future as-of rejected', async () => {
  const { h, id, ppId } = await issued();
  h.pp.pay(ppId, { createTime: '2026-11-01T11:00:00Z' }); // before as-of, so inclusion depends on the report
  await h.advance(61_000);
  h.pp.balance.accountId = 'ACCT-OTHER';
  await h.api('POST', '/v1/cash/paypal/refresh');
  await h.drain();
  let pp = (await h.api('GET', '/v1/cash/position')).body.sources[0];
  assert.deepEqual([pp.refreshState, pp.lastError], ['FAILED', 'ACCOUNT_MISMATCH']);
  h.pp.balance.accountId = 'ACCT-FAKE';
  h.pp.balance.asOf = new Date(Date.parse(h.clock()) + 3600_000).toISOString();
  await h.api('POST', '/v1/cash/paypal/refresh');
  await h.drain();
  pp = (await h.api('GET', '/v1/cash/position')).body.sources[0];
  assert.equal(pp.lastError, 'FUTURE_ASOF');
  h.pp.balance.asOf = '2026-11-01T13:00:00.000Z';
  h.pp.totalPages = 2;
  h.pp.faults.add('page2-500');
  await h.api('POST', '/v1/cash/paypal/refresh');
  await h.drain();
  pp = (await h.api('GET', '/v1/cash/position')).body.sources[0];
  assert.equal(pp.estimate.coverage, 'PARTIAL');
  assert.equal((await h.invoice(id)).receipts[0].inReportedBalance, 'UNKNOWN');
});

test('S1-R20 refund after a receipt (REPLAY): reversal → net held; T1107 row → one negative movement; receipt unchanged', async () => {
  const { h, id, ppId } = await issued();
  const capId = h.pp.pay(ppId, { feeMinor: 194 });
  await h.advance(61_000);
  h.pp.captures.get(capId).status = 'PARTIALLY_REFUNDED';
  await h.advance(24 * 3600_000); // daily refund re-read after PAID
  let inv = await h.invoice(id);
  assert.equal(inv.receipts[0].reversalDetected, true);
  assert.deepEqual([inv.receipts[0].gross.minor, inv.receipts[0].fee.minor, inv.receipts[0].net.minor], [4200, 194, 4006]);
  let est = (await h.api('GET', '/v1/cash/position')).body.sources[0].estimate;
  assert.equal(est.upper.minor, 500_000, 'net held out of both bounds until the amount is verified');
  const refundRow = { transaction_id: 'RFND00000000000001', paypal_reference_id: capId, transaction_event_code: 'T1107', transaction_status: 'S', transaction_initiation_date: h.clock(), transaction_amount: amt(-1000), available_balance: amt(499_000), invoice_id: inv.invoice.invoiceNumber };
  h.pp.rows = [refundRow];
  for (let i = 0; i < 2; i++) { await h.api('POST', '/v1/cash/paypal/refresh'); await h.drain(); }
  inv = await h.invoice(id);
  assert.equal(inv.receipts[0].refunds.length, 1);
  est = (await h.api('GET', '/v1/cash/position')).body.sources[0].estimate;
  assert.equal(est.lower.minor, 500_000 - 1000, 'refund after as-of subtracted from both bounds, once');
  const refundAudits = (await h.store.query('audit', K.run('tenant-a', h.run!.runId))).filter((a) => a.eventType === 'ReceiptRefundObserved');
  assert.equal(refundAudits.length, 1);
});

test('S1-R22 paid on day 8 with no webhook → found by slow poll; grant ended → visible not-being-checked', async () => {
  const { h, id, ppId } = await issued();
  for (let i = 0; i < 8 * 4; i++) await h.advance(6 * 3600_000);
  h.pp.pay(ppId);
  await h.advance(6 * 3600_000);
  assert.equal((await h.invoice(id)).receipts.length, 1);
  const { h: h2, id: id2 } = await issued();
  h2.setNow('2026-12-01T00:00:00.000Z');
  const row = (await h2.invoice(id2)).invoice;
  assert.deepEqual([row.checking.state, row.checking.reason], ['STOPPED', 'Not being checked: PayPal read grant ended']);
  const reads = h2.pp.calls.length;
  await h2.drain();
  await h2.advance(3600_000);
  assert.equal(h2.pp.calls.length, reads, 'no PayPal calls after the grant ends');
});

test('invariant 16: api and webhook handlers cannot import the PayPal writer (import graph)', () => {
  const root = resolve(import.meta.dirname, '../../backend/src');
  const seen = new Set<string>();
  const walk = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/^import\s+(?!type\b)[^'"]*?from\s+['"](\.[^'"]+)['"]/gm)) walk(resolve(dirname(file), m[1]));
  };
  for (const entry of ['handlers/api.ts', 'handlers/webhook.ts']) {
    seen.clear();
    walk(resolve(root, entry));
    assert.ok(![...seen].some((f) => f.endsWith('adapters/paypal/writer.ts')), `${entry} reaches the writer`);
    assert.ok(![...seen].some((f) => f.endsWith('adapters/paypal/http.ts')), `${entry} reaches PayPal http`);
  }
});
