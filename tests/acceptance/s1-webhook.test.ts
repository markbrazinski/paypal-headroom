import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.ts';
import { fixture } from '../fixtures/paypal/index.ts';
import { ingestWebhook } from '../../backend/src/domain/paypal-mirror/webhook.ts';
import { K } from '../../backend/src/adapters/store/keys.ts';
import { SimulatedCrash } from '../../backend/src/deps.ts';

const HEADERS = { 'paypal-transmission-id': 't1', 'paypal-transmission-time': '2026-11-01T14:00:00Z', 'paypal-transmission-sig': 'sig', 'paypal-cert-url': 'https://api.sandbox.paypal.com/cert', 'paypal-auth-algo': 'SHA256withRSA' };
const event = (ppId: string, id = 'WH-EVENT-1', type = 'INVOICING.INVOICE.PAID') => {
  const e = fixture('webhook-invoice-paid').body;
  e.id = id; e.event_type = type; e.resource.invoice.id = ppId;
  return JSON.stringify(e);
};

async function paidInvoice() {
  const h = await harness();
  const { id } = await h.draftAndIssue(4200);
  await h.drain();
  const ppId = await h.ppIdOf(id);
  h.pp.pay(ppId);
  return { h, id, ppId };
}

test('S1-A2 webhook and poll on one payment → one receipt (REPLAY, nested resource.invoice.id routed)', async () => {
  const { h, id, ppId } = await paidInvoice();
  const r = await h.api('POST', '/v1/webhooks/paypal', event(ppId), HEADERS, null);
  assert.equal(r.status, 200);
  await h.drain();
  assert.equal((await h.invoice(id)).receipts.length, 1, 'webhook path');
  await h.advance(61_000);
  const inv = await h.invoice(id);
  assert.equal(inv.receipts.length, 1, 'poll after webhook adds nothing');
  assert.ok(inv.audit.some((a: any) => a.event === 'PayPal notification verified'));
});

test('S1-R1 the same webhook delivered 10× → one receipt, one signature verification', async () => {
  const { h, id, ppId } = await paidInvoice();
  for (let i = 0; i < 10; i++) assert.equal((await h.api('POST', '/v1/webhooks/paypal', event(ppId), HEADERS, null)).status, 200);
  await h.drain();
  assert.equal((await h.invoice(id)).receipts.length, 1);
  assert.equal(h.pp.count('VERIFY'), 1);
});

test('S1-R16 failed signature → quarantined, no reconcile, 200 to sender', async () => {
  const { h, id, ppId } = await paidInvoice();
  h.pp.signature = 'FAILURE';
  const before = h.pp.count('GET invoice');
  assert.equal((await h.api('POST', '/v1/webhooks/paypal', event(ppId), HEADERS, null)).status, 200);
  await h.drain();
  assert.equal(h.pp.count('GET invoice'), before, 'no invoice read from a bad-signature event');
  assert.equal((await h.store.get('provider', K.webhook('WH-EVENT-1'), 'EVENT'))!.reason, 'BAD_SIGNATURE');
  assert.equal((await h.invoice(id)).receipts.length, 0);
  const act = (await h.api('GET', '/v1/activity')).body.rows;
  assert.ok(act.some((a: any) => a.event === 'PayPal notification quarantined' && a.result === 'BAD_SIGNATURE'));
});

test('S1-R16 unsigned POST (no transmission headers) → quarantined without any PayPal call; verify 4xx → quarantined, not retried', async () => {
  const { h, id, ppId } = await paidInvoice();
  await h.api('POST', '/v1/webhooks/paypal', event(ppId, 'WH-UNSIGNED'), {}, null);
  await h.drain();
  assert.equal(h.pp.count('VERIFY'), 0);
  assert.equal((await h.store.get('provider', K.webhook('WH-UNSIGNED'), 'EVENT'))!.reason, 'MISSING_SIGNATURE_HEADERS');
  h.pp.reader.verifyWebhookSignature = async () => ({ status: 400, body: { name: 'VALIDATION_ERROR' }, raw: '', rawSha256: '' });
  await h.api('POST', '/v1/webhooks/paypal', event(ppId, 'WH-BAD'), HEADERS, null);
  await h.drain();
  await h.advance(10 * 60_000);
  assert.match((await h.store.get('provider', K.webhook('WH-BAD'), 'EVENT'))!.reason, /^BAD_SIGNATURE/);
  const job = await h.store.get('work', K.job('whv#WH-BAD'), 'JOB');
  assert.deepEqual([job!.state, job!.attempts], ['DONE', 1], 'one verify attempt, not a retry loop');
  assert.ok(id);
});

test('S1-IR-05 deliveries that cannot be PayPal are quarantined before spending a verification', async () => {
  const { h, ppId } = await paidInvoice();
  await h.api('POST', '/v1/webhooks/paypal', event(ppId, 'WH-CERT'), { ...HEADERS, 'paypal-cert-url': 'https://evil.example.com/cert' }, null);
  await h.api('POST', '/v1/webhooks/paypal', event(ppId, 'WH-OLD'), { ...HEADERS, 'paypal-transmission-time': '2026-10-01T00:00:00Z' }, null);
  await h.api('POST', '/v1/webhooks/paypal', event(ppId, 'WH-ALGO'), { ...HEADERS, 'paypal-auth-algo': 'none' }, null);
  await h.drain();
  assert.equal(h.pp.count('VERIFY'), 0);
  for (const id of ['WH-CERT', 'WH-OLD', 'WH-ALGO']) assert.match((await h.store.get('provider', K.webhook(id), 'EVENT'))!.reason, /^BAD_SIGNATURE/);
});

test('unregistered invoice id, unexpected type and unparseable body are quarantined', async () => {
  const { h } = await paidInvoice();
  await h.api('POST', '/v1/webhooks/paypal', event('INV2-NOT-OURS', 'WH-A'), HEADERS, null);
  await h.api('POST', '/v1/webhooks/paypal', event('INV2-NOT-OURS', 'WH-B', 'INVOICING.INVOICE.CANCELLED'), HEADERS, null);
  assert.equal((await h.api('POST', '/v1/webhooks/paypal', '{not json', HEADERS, null)).status, 200);
  await h.drain();
  assert.equal((await h.store.get('provider', K.webhook('WH-A'), 'EVENT'))!.reason, 'NOT_OURS');
  assert.equal((await h.store.get('provider', K.webhook('WH-B'), 'EVENT'))!.reason, 'UNEXPECTED_TYPE');
  assert.ok(h.store.dump('provider').some((i) => i.pk.startsWith('WEBHOOK#sha256-') && i.reason === 'BAD_ENVELOPE'), 'unparseable body kept, keyed by sha256');
});

test('S1-R19 ingress dies after commit before the queue send; a duplicate arrives while pending → verified exactly once', async () => {
  const { h, id, ppId } = await paidInvoice();
  await assert.rejects(ingestWebhook(h.store, h.queue, event(ppId), HEADERS, h.clock(), { afterWebhookCommit: async () => { throw new SimulatedCrash('injected crash'); } }));
  assert.equal(h.queue.pending.length, 0, 'the queue never heard about it');
  const dup = await ingestWebhook(h.store, h.queue, event(ppId), HEADERS, h.clock());
  assert.deepEqual([dup.status, dup.duplicate], [200, true]);
  await h.drain();
  assert.equal(h.pp.count('VERIFY'), 1);
  assert.equal((await h.invoice(id)).receipts.length, 1);
});

test('S1-R9 old-run webhook after reset → reconciled into the old run only', async () => {
  const { h, id, ppId } = await paidInvoice();
  const { operatorReset } = await import('../../backend/src/handlers/operator.ts');
  const next = await operatorReset(h.deps, 'tenant-a', 'second pass', { hero: false });
  await h.api('POST', '/v1/webhooks/paypal', event(ppId), HEADERS, null);
  await h.drain();
  const oldRcpt = await h.store.query('core', K.run('tenant-a', h.run!.runId), { skPrefix: 'RCPT#' });
  const newRcpt = await h.store.query('core', K.run('tenant-a', next!.runId), { skPrefix: 'RCPT#' });
  assert.deepEqual([oldRcpt.length, newRcpt.length], [1, 0]);
  const oldAudit = await h.store.query('audit', K.run('tenant-a', h.run!.runId));
  assert.ok(oldAudit.some((a) => a.eventType === 'OldRunEventRouted'));
  assert.equal((await h.api('GET', `/v1/invoices/${id}`)).status, 404, 'UI reads the active run');
  const rec = (await h.api('GET', '/v1/receivables')).body;
  assert.equal(rec.invoices.length, 0);
});
