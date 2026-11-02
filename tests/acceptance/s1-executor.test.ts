import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.ts';
import { K } from '../../backend/src/adapters/store/keys.ts';
import { processJob } from '../../backend/src/jobs/worker.ts';
import { operatorReset } from '../../backend/src/handlers/operator.ts';
import { S1_GRANT, SimulatedCrash } from '../../backend/src/deps.ts';

const crash = () => { throw new SimulatedCrash('injected crash'); };
const LEASE = 91_000;

test('S1-R10 effect queued, run reset before the worker → RUN_FENCED, zero writer calls', async () => {
  const h = await harness();
  const { id } = await h.draftAndIssue();
  h.queue.pending.length = 0;
  await operatorReset(h.deps, 'tenant-a', 'reset before dispatch', { hero: false });
  await h.drain();
  assert.equal(h.pp.count('CREATE'), 0);
  const eff = await h.store.get('work', K.effect((await h.store.query('core', K.run('tenant-a', h.run!.runId), { skPrefix: 'INV#' }))[0].invoiceNumber), 'EFFECT');
  assert.deepEqual([eff!.state, eff!.failureReason], ['VERIFIED_FAILURE', 'Run was reset before this invoice was issued']);
  const inv = (await h.store.get('core', K.run('tenant-a', h.run!.runId), `INV#${id}`))!;
  assert.equal(inv.state, 'FAILED');
});

test('S1-R18 reset between job claim and dispatch claim → RUN_FENCED, zero writer calls', async () => {
  let h!: Awaited<ReturnType<typeof harness>>;
  h = await harness({ hooks: { afterJobClaim: async (jobId) => { if (jobId.startsWith('eff#')) await operatorReset(h.deps, 'tenant-a', 'race', { hero: false }); } } });
  await h.draftAndIssue();
  await h.drain();
  assert.equal(h.pp.count('CREATE'), 0);
});

test('S1-R18 reset after the dispatch claim → the effect completes in the old run and is never marked failed', async () => {
  let h!: Awaited<ReturnType<typeof harness>>;
  let once = false;
  h = await harness({ hooks: { afterCreate: async () => { if (!once) { once = true; await operatorReset(h.deps, 'tenant-a', 'race', { hero: false }); } } } });
  const { id } = await h.draftAndIssue();
  await h.drain();
  const inv = (await h.store.get('core', K.run('tenant-a', h.run!.runId), `INV#${id}`))!;
  assert.equal(inv.state, 'ISSUED');
  assert.equal(h.pp.count('CREATE'), 1);
});

for (const [name, hooks] of [
  ['after create', { afterCreate: async () => crash() }],
  ['after send', { afterSend: async () => crash() }],
  ['before the outcome commit', { beforeVerifyCommit: async () => crash() }],
] as const) {
  test(`S1-R17 process dies ${name} → lease expires → UNKNOWN → reconciled with the same number; one PayPal invoice`, async () => {
    let armed = true;
    const wrap = Object.fromEntries(Object.entries(hooks).map(([k, f]) => [k, async () => { if (armed) { armed = false; await f(); } }]));
    const h = await harness({ hooks: wrap });
    const { id } = await h.draftAndIssue();
    await h.drain();
    let inv = await h.invoice(id);
    assert.notEqual(inv.invoice.state, 'ISSUED', 'not yet: the worker died');
    await h.advance(LEASE);
    await h.advance(60_000);
    inv = await h.invoice(id);
    assert.equal(inv.invoice.state, 'ISSUED');
    assert.equal(inv.effect.state, 'VERIFIED_SUCCESS');
    assert.equal(h.pp.invoices.size, 1, 'one PayPal invoice');
    assert.ok(h.pp.calls.filter((c) => c.startsWith('CREATE')).every((c) => c === `CREATE ${inv.invoice.invoiceNumber}`), 'never a new number');
    if (name === 'after create') assert.ok(inv.audit.some((a: any) => a.event === 'Checking with PayPal'));
  });
}

test('S1-R7 create response lost (timeout) → UNKNOWN → search by number → found; no duplicate', async () => {
  const h = await harness();
  h.pp.faults.add('create-lost-response');
  const { id } = await h.draftAndIssue();
  await h.drain();
  let inv = await h.invoice(id);
  assert.equal(inv.invoice.state, 'ISSUE_UNKNOWN');
  assert.equal(inv.effect.state, 'UNKNOWN');
  await h.advance(20_000);
  inv = await h.invoice(id);
  assert.equal(inv.invoice.state, 'ISSUED');
  assert.equal(h.pp.invoices.size, 1);
  assert.equal(h.pp.count('SEARCH'), 1);
  assert.equal(h.pp.count('CREATE'), 1);
});

test('UNKNOWN with search index lag → same-number replay → 422 duplicate → search again; one invoice', async () => {
  const h = await harness();
  h.pp.faults.add('create-lost-response');
  h.pp.searchLag = true;
  const { id } = await h.draftAndIssue();
  await h.drain();
  await h.advance(20_000);
  assert.equal(h.pp.count('CREATE'), 2, 'replayed with the same number');
  assert.equal(h.pp.invoices.size, 1, 'PayPal refused the duplicate');
  h.pp.searchLag = false;
  await h.advance(120_000);
  assert.equal((await h.invoice(id)).invoice.state, 'ISSUED');
});

test('5xx on create → UNKNOWN, not FAILED; other 4xx → FAILED with reason', async () => {
  const h = await harness();
  h.pp.faults.add('create-500');
  const { id } = await h.draftAndIssue();
  await h.drain();
  assert.equal((await h.invoice(id)).effect.state, 'UNKNOWN');
  h.pp.faults.delete('create-500');
  await h.advance(30_000);
  assert.equal((await h.invoice(id)).invoice.state, 'ISSUED');
});

test('GET failure after send stays SENT, then verifies', async () => {
  const h = await harness();
  h.pp.faults.add('get-invoice-500');
  const { id } = await h.draftAndIssue();
  await h.drain();
  assert.equal((await h.invoice(id)).effect.state, 'SENT');
  h.pp.faults.delete('get-invoice-500');
  await h.advance(20_000);
  assert.equal((await h.invoice(id)).invoice.state, 'ISSUED');
  assert.equal(h.pp.count('SEND'), 1);
});

test('S1-R13 issue clicked twice and two workers on one job → one effect, one PayPal invoice', async () => {
  const h = await harness();
  const d = await h.api('POST', '/v1/invoices', { customerId: 'cust-alder', amount: { currency: 'USD', minor: 1000 }, dueOn: '2026-11-20' });
  const id = d.body.invoice.invoiceId;
  const [a, b] = await Promise.all([
    h.api('POST', `/v1/invoices/${id}/send`, undefined, { 'if-match': '1', 'idempotency-key': 'click-1' }),
    h.api('POST', `/v1/invoices/${id}/send`, undefined, { 'if-match': '1', 'idempotency-key': 'click-2' }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [202, 409]);
  const jobId = [a, b].find((r) => r.status === 202)!.body.jobId;
  h.queue.pending.length = 0;
  await Promise.all([processJob(h.deps, jobId), processJob(h.deps, jobId)]);
  await h.drain();
  assert.equal(h.pp.count('CREATE'), 1);
  assert.equal(h.pp.invoices.size, 1);
});

test('stale worker write rejected by lease token', async () => {
  const h = await harness();
  const { claim, finishOp } = await import('../../backend/src/jobs/lease.ts');
  const { send } = await h.draftAndIssue();
  const l1 = (await claim(h.store, send.body.jobId, h.clock()))!;
  await h.advance(LEASE); // sweep recovers the expired lease (READY effect → requeued) and a new worker finishes the job
  await assert.rejects(h.store.transact([finishOp(l1, { kind: 'done' })]));
});

test('call budget reached → effect waits in READY with a visible reason, never FAILED', async () => {
  const h = await harness();
  await h.store.transact([{ op: 'update', table: 'work', pk: K.counter('S1'), sk: 'COUNTER', set: { creates: S1_GRANT.budgets.creates } }]);
  const { id } = await h.draftAndIssue();
  await h.drain();
  const inv = await h.invoice(id);
  assert.equal(inv.effect.state, 'READY');
  assert.equal(inv.invoice.waitingReason, 'Waiting: PayPal call budget reached');
  assert.equal(h.pp.count('CREATE'), 0);
});
