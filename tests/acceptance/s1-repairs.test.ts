// Regression tests for the independent implementation review (evidence/S01/impl-review-2026-11-01/FINDINGS.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness, OWNER_B } from './harness.ts';
import { K } from '../../backend/src/adapters/store/keys.ts';
import { operatorReset } from '../../backend/src/handlers/operator.ts';

test('S1-IR-01 a tenant without the PayPal connection cannot issue or refresh: 409 NOT_CONNECTED, zero writer calls, run BLOCKED', async () => {
  const h = await harness();
  const asB = (m: string, p: string, b?: unknown, hd: Record<string, string> = {}) => h.api(m, p, b, hd, OWNER_B);
  const d = await asB('POST', '/v1/invoices', { customerId: 'cust-alder', amount: { currency: 'USD', minor: 1000 }, dueOn: '2026-11-20' }, { 'idempotency-key': 'b1' });
  assert.equal(d.status, 201, 'a local draft is fine');
  const s = await asB('POST', `/v1/invoices/${d.body.invoice.invoiceId}/send`, undefined, { 'if-match': '1', 'idempotency-key': 'b2' });
  assert.deepEqual([s.status, s.body.code], [409, 'NOT_CONNECTED']);
  assert.equal((await asB('POST', '/v1/cash/paypal/refresh')).body.code, 'NOT_CONNECTED');
  await h.drain();
  assert.equal(h.pp.count('CREATE'), 0);
  const runB = (await asB('GET', '/v1/session')).body.run;
  assert.equal(runB.state, 'BLOCKED');
});

test('S1-IR-01 another tenant\'s capture markers never enter this tenant\'s estimate', async () => {
  const h = await harness();
  await h.store.transact([{ op: 'put', table: 'provider', item: { pk: K.conn('pp-test'), sk: 'CAPTURE#FOREIGN', captureId: 'FOREIGN', tenantId: 'tenant-b', runId: 'run-x', invoiceNumber: 'HR-x', grossMinor: 1000, feeMinor: 40, netMinor: 960, capturedAt: h.clock(), reversalDetected: false } }]);
  const est = (await h.api('GET', '/v1/cash/position')).body.sources[0].estimate;
  assert.equal(est.upper.minor, 500_000);
  assert.ok(![...est.included, ...est.excluded].some((l: any) => l.key === 'capture:FOREIGN'));
});

test('S1-IR-03 ten failed polls → FAILING shown, polling continues, and a later payment is still found', async () => {
  const h = await harness();
  const { id } = await h.draftAndIssue();
  await h.drain();
  const ppId = await h.ppIdOf(id);
  h.pp.faults.add('get-invoice-500');
  for (let i = 0; i < 12; i++) await h.advance(16 * 60_000);
  const failing = (await h.invoice(id)).invoice.checking;
  assert.equal(failing.state, 'FAILING');
  assert.match(failing.reason, /Couldn't reach PayPal/);
  h.pp.faults.delete('get-invoice-500');
  h.pp.pay(ppId);
  await h.advance(16 * 60_000);
  const inv = await h.invoice(id);
  assert.equal(inv.receipts.length, 1);
  assert.equal(inv.invoice.checking.state, 'ACTIVE');
});

test('S1-IR-04 an UNKNOWN effect keeps reconciling through long failures and stays visible to the alarm', async () => {
  const h = await harness();
  h.pp.faults.add('create-500');
  const { id } = await h.draftAndIssue();
  await h.drain();
  const search = h.pp.reader.searchInvoiceByNumber;
  h.pp.reader.searchInvoiceByNumber = async () => ({ status: 503, body: {}, raw: '', rawSha256: '' });
  for (let i = 0; i < 12; i++) await h.advance(16 * 60_000);
  const { sweep } = await import('../../backend/src/jobs/sweep.ts');
  const s = await sweep({ store: h.store, queue: h.queue, now: h.clock });
  assert.equal(s.unknownOlderThan15m, 1, 'still counted by the alarm');
  h.pp.faults.delete('create-500');
  h.pp.reader.searchInvoiceByNumber = search;
  await h.advance(16 * 60_000);
  assert.equal((await h.invoice(id)).invoice.state, 'ISSUED');
  assert.equal(h.pp.invoices.size, 1);
});

test('S1-IR-08 a command racing a reset is refused RUN_SEALED, not written into the sealed run', async () => {
  const h = await harness();
  let fired = false;
  h.store.beforeTransact = async (ops) => {
    if (!fired && ops.some((o) => o.op === 'put' && String((o as any).item?.sk).startsWith('INV#'))) { fired = true; h.store.beforeTransact = undefined; await operatorReset(h.deps, 'tenant-a', 'race', { hero: false }); }
  };
  const r = await h.api('POST', '/v1/invoices', { customerId: 'cust-alder', amount: { currency: 'USD', minor: 1000 }, dueOn: '2026-11-20' });
  assert.deepEqual([r.status, r.body.code], [409, 'RUN_SEALED']);
  assert.equal((await h.store.query('core', K.run('tenant-a', h.run!.runId), { skPrefix: 'INV#' })).length, 0);
});
