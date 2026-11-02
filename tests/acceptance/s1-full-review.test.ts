// Regression tests for the full implementation review (S1-IM-02/03/04/06/07). REPLAY fake only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { harness } from './harness.ts';
import { K } from '../../backend/src/adapters/store/keys.ts';
import { reconcileInvoice } from '../../backend/src/domain/paypal-mirror/reconcile-invoice.ts';
import { observeBalance } from '../../backend/src/domain/paypal-mirror/observe-balance.ts';

const amt = (minor: number) => ({ currency_code: 'USD', value: (minor / 100).toFixed(2) });

/** $100 capture ($4 fee) on a fresh invoice, a reported $20 partial refund, reconciled snapshot $5,076. */
async function partiallyRefunded() {
  const h = await harness();
  const { id } = await h.draftAndIssue(10000);
  await h.drain();
  const capId = h.pp.pay(await h.ppIdOf(id), { feeMinor: 400, createTime: '2026-11-01T14:01:00Z' });
  const ref = { tenantId: 'tenant-a', runId: h.run!.runId, invoiceId: id };
  h.setNow('2026-11-01T14:02:00.000Z');
  await reconcileInvoice(h.deps, ref, 'POLL');
  h.pp.captures.get(capId).status = 'PARTIALLY_REFUNDED';
  await reconcileInvoice(h.deps, ref, 'POLL');
  const num = (await h.invoice(id)).invoice.invoiceNumber;
  h.pp.balance = { ...h.pp.balance, availableMinor: 507600, asOf: '2026-11-01T14:05:00Z' };
  h.pp.rows = [
    { transaction_id: capId, transaction_event_code: 'T0006', transaction_status: 'S', transaction_amount: amt(10000), fee_amount: amt(-400), transaction_initiation_date: '2026-11-01T14:01:00Z', invoice_id: num, available_balance: amt(509600) },
    { transaction_id: 'REFUND-PARTIAL', transaction_event_code: 'T1107', transaction_status: 'S', transaction_amount: amt(-2000), paypal_reference_id: capId, transaction_initiation_date: '2026-11-01T14:03:00Z', available_balance: amt(507600) },
  ];
  h.setNow('2026-11-01T16:00:00.000Z');
  assert.equal((await observeBalance(h.deps)).ok, true);
  return { h, id, capId, ref };
}

test('S1-IM-02 a later full refund is not masked by an earlier reported partial refund', async () => {
  const { h, capId, ref } = await partiallyRefunded();
  const est = async () => (await h.api('GET', '/v1/cash/position')).body.sources[0].estimate;
  assert.deepEqual([(await est()).lower.minor, (await est()).upper.minor], [507600, 507600]);
  h.pp.captures.get(capId).status = 'REFUNDED'; // the other $80 isn't in the delayed report yet
  h.setNow('2026-11-01T16:01:00.000Z');
  await reconcileInvoice(h.deps, ref, 'POLL');
  const after = await est();
  assert.deepEqual([after.lower.minor, after.upper.minor], [499600, 499600], 'the unreported $80 is subtracted');
  const rest = after.excluded.find((l: any) => l.key === `capture:${capId}:unreported-reversal`);
  assert.equal(rest.net.minor, -8000);
  const audit = (await h.api('GET', '/v1/activity')).body.rows;
  assert.ok(JSON.stringify(audit).includes('Capture now REFUNDED'), 'the new reversal status is audited');
});

test('S1-IM-03 a Refresh accepted while the balance job is leased runs at the refresh time, not 30 min later', async () => {
  const h = await harness();
  await h.drain();
  const reads = () => h.pp.count('GET balances');
  const before = reads();
  const getBalances = h.pp.reader.getBalances;
  let refresh: { status: number } | undefined;
  h.pp.reader.getBalances = async () => {
    const r = await getBalances();
    if (!refresh) { h.setNow('2026-11-01T14:00:01.000Z'); refresh = await h.api('POST', '/v1/cash/paypal/refresh'); } // after the read, before completion
    return r;
  };
  h.setNow('2026-11-01T14:00:00.000Z');
  await h.api('POST', '/v1/cash/paypal/refresh');
  await h.drain();
  assert.equal(refresh!.status, 202);
  assert.equal(reads() - before, 2, 'the refresh accepted mid-run produced its own read');
  const job = await h.store.get('work', K.job('obs#pp-test'), 'JOB');
  assert.equal(job!.rerunAt ?? null, null);
  assert.equal(job!.dueAt, '2026-11-01T14:30:01.000Z', 'normal schedule resumes after the extra read');
});

test('S1-IM-04 checking FAILING and recovery each move session.lastChangeAt, so the open screen refetches', async () => {
  const h = await harness();
  const { id } = await h.draftAndIssue();
  await h.drain();
  const t0 = (await h.api('GET', '/v1/session')).body.lastChangeAt;
  h.pp.faults.add('get-invoice-500');
  for (const iso of ['2026-11-01T14:01:01.000Z', '2026-11-01T14:02:01.000Z', '2026-11-01T14:04:01.000Z']) { h.setNow(iso); await h.drain(); }
  assert.equal((await h.invoice(id)).invoice.checking.state, 'FAILING');
  const t1 = (await h.api('GET', '/v1/session')).body.lastChangeAt;
  assert.notEqual(t1, t0);
  h.pp.faults.delete('get-invoice-500');
  h.setNow('2026-11-01T14:30:00.000Z');
  await h.drain();
  const inv = await h.invoice(id);
  assert.equal(inv.invoice.checking.state, 'ACTIVE');
  assert.notEqual((await h.api('GET', '/v1/session')).body.lastChangeAt, t1);
  assert.deepEqual(inv.audit.filter((a: any) => a.event === 'PayPal checking changed').map((a: any) => a.result.split(' ')[0]), ['PayPal', "Couldn't"], 'newest first: recovered, failing');
});

test('S1-IM-06 an impossible due date is refused; a leap day is accepted', async () => {
  const h = await harness();
  const post = (dueOn: string) => h.api('POST', '/v1/invoices', { customerId: 'cust-alder', amount: { currency: 'USD', minor: 1000 }, dueOn });
  for (const bad of ['2027-02-31', '2027-02-29', '2027-04-31', '2027-13-01', '2027-00-10', '2027-01-00']) {
    const r = await post(bad);
    assert.deepEqual([r.status, r.body.code], [400, 'INVALID_INPUT'], bad);
  }
  assert.equal((await post('2028-02-29')).status, 201);
});

test('S1-IM-07 the raw invoice, capture, balance and report GET bodies behind a receipt and an estimate are retained', async () => {
  const { h, id, capId } = await partiallyRefunded();
  const raw = async (sha: string) => {
    const it = await h.store.get('provider', K.conn('pp-test'), `RAW#${sha}`);
    assert.ok(it, `retained ${sha}`);
    const text = gunzipSync(Buffer.from(it!.body, 'base64')).toString();
    assert.equal(createHash('sha256').update(text).digest('hex'), sha, 'body matches its hash');
    return JSON.parse(text);
  };
  const rcpt = await h.store.get('core', K.run('tenant-a', h.run!.runId), `RCPT#${capId}`);
  assert.equal((await raw(rcpt!.rawSha256)).id, capId);
  assert.equal((await raw(rcpt!.invoiceRawSha256)).id, await h.ppIdOf(id));
  const obs = (await h.store.query('provider', K.conn('pp-test'))).filter((i) => i.sk.startsWith('OBS#')).at(-1)!;
  await raw(obs.rawSha256);
  assert.equal(obs.pageSha256.length, 1);
  assert.equal((await raw(obs.pageSha256[0])).transaction_details.length, 2);
});
