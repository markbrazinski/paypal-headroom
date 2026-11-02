import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.ts';
import { throttled } from './fake-interpreter.ts';
import { K } from '../../backend/src/adapters/store/keys.ts';
import { SimulatedCrash } from '../../backend/src/deps.ts';
import { pdf } from '../../scripts/demo/bill-pdf.ts';
import { BEDROCK_CAPS_MICROS, BudgetReached, reserve, reserveOp, worstCaseMicros } from '../../backend/src/adapters/bedrock/spend.ts';
import { TxCancelled } from '../../backend/src/adapters/store/port.ts';

const hero = (o: Parameters<typeof harness>[0] = {}) => harness({ plaid: true, hero: true, paypalMinor: 180_000, ...o });
const runOf = (billId: string) => `run-${billId.split('_')[1]}`;
const billItem = (h: any, id: string) => h.store.get('core', K.run('tenant-a', runOf(id)), `BILL#${id}`);
const job = (h: any, id: string, gen = 1) => h.store.get('work', K.job(`ingest#${id}#${gen}`), 'JOB');
const models = (h: any, id: string) => h.store.query('core', K.run('tenant-a', runOf(id)), { skPrefix: `MODEL#${id}#` });
const counter = (h: any) => h.store.get('work', 'COUNTER#bedrock#local', 'COUNTER');
/** Run every due job, letting backoffs elapse (each ingest attempt is a separate job claim). */
const settle = async (h: any) => { for (let i = 0; i < 12; i++) await h.advance(16 * 60_000); };

test('W1/S3-R34 admission: under 30 s of job budget → requeued in 1 min, attempts unchanged, zero model calls', async () => {
  let bump = 0;
  const h = await hero({ hooks: { afterJobClaim: async (id) => { if (id.startsWith('ingest#')) h.setElapsed((bump += 15_000)); } } });
  await h.drain();
  const r = await h.inject('hero', { drain: false });
  await h.drain();
  const j = await job(h, r.billId);
  assert.deepEqual([j.state, j.attempts], ['QUEUED', 0]);
  assert.equal(h.model.calls.length, 0);
  assert.equal((await billItem(h, r.billId)).state, 'RECEIVED');
});

test('W2/G8/S3-R20 invalid output (extra keys) → one re-ask per attempt; ×4 attempts → READ_FAILED in one TX with the audit, job DONE, never requeued; every request has its MODEL# record', async () => {
  const h = await hero();
  await h.drain();
  h.model.script = Array(8).fill(JSON.stringify({ markPaid: true }));
  const r = await h.inject('hero');
  await settle(h);
  const b = await billItem(h, r.billId);
  assert.equal(b.state, 'READ_FAILED');
  assert.match(b.readFailure, /did not match the required shape.*after 4 attempts/);
  assert.equal(h.model.calls.length, 8);
  assert.equal(h.model.calls.filter((c) => c.reask).length, 4, 'one re-ask per attempt, with the refusal reason');
  const ms = await models(h, r.billId);
  assert.deepEqual([ms.length, ms.every((m: any) => m.state === 'INVALID_OUTPUT')], [8, true]);
  assert.deepEqual([(await job(h, r.billId)).state], ['DONE']);
  const c = await counter(h);
  assert.equal(c.reservedMicros, 0);
  assert.equal(c.requests, 8);
  const audit = await h.store.query('audit', K.run('tenant-a', runOf(r.billId)));
  assert.equal(audit.filter((a) => a.eventType === 'BillExtractionFailed').length, 1);
});

test('W3 a throttle counts an attempt and backs off; a request is not sent with under 8 s left', async () => {
  const h = await hero();
  await h.drain();
  h.model.script = [throttled()];
  const r = await h.inject('hero');
  let j = await job(h, r.billId);
  assert.deepEqual([j.state, j.attempts, /throttled/.test(j.lastError)], ['QUEUED', 1, true]);
  const ms = await models(h, r.billId);
  assert.deepEqual([ms[0].state, ms[0].actualMicros, ms[0].reservedMicros], ['ERROR', ms[0].reservedMicros, worstCaseMicros(ms[0].inputChars)], 'no usage known: the reservation stays charged');
  // Next attempt: the first answer is invalid and eats the clock, so the re-ask can't fit.
  h.model.script = [() => { h.setElapsed(30_000); return '{}'; }];
  await h.advance(60_000);
  j = await job(h, r.billId);
  assert.deepEqual([j.attempts, j.lastError], [2, 'Not enough time left in this run for a model request']);
  assert.equal(h.model.calls.length, 2, 'the re-ask was not sent');
  h.setElapsed(0);
  await settle(h);
  assert.equal((await billItem(h, r.billId)).state, 'PROPOSED');
});

test('W4/S3-R34 retry race: an old-generation worker’s final write fails; the new generation publishes', async () => {
  let once = true;
  const h = await hero({ hooks: { beforeIngestCommit: async (billId) => {
    if (!once) return;
    once = false;
    // Meanwhile: this read was given up on (READ_FAILED) and the owner pressed Retry → generation 2.
    const b = await billItem(h, billId);
    await h.store.transact([{ op: 'update', table: 'core', pk: b.pk, sk: b.sk, set: { state: 'READ_FAILED', readFailure: 'test', version: b.version + 1 }, cond: { eq: { version: b.version } } }]);
    const rr = await h.api('POST', `/v1/bills/${billId}/retry`, undefined, { 'if-match': String(b.version + 1) });
    assert.equal(rr.status, 202, JSON.stringify(rr.body));
  } } });
  await h.drain();
  const r = await h.inject('hero');
  const b = await billItem(h, r.billId);
  assert.deepEqual([b.state, b.readGeneration], ['PROPOSED', 2], 'generation 2 published; generation 1 could not');
  assert.equal(h.model.calls.length, 2);
});

test('W5 malformed PDF → READ_FAILED at once (deterministic), not a loop, no model call', async () => {
  const h = await hero();
  await h.drain();
  const r = await h.inject('hero', { bytes: Buffer.from('%PDF-1.4\nthis is not really a pdf\n%%EOF') });
  const b = await billItem(h, r.billId);
  assert.equal(b.state, 'READ_FAILED');
  assert.match(b.readFailure, /Not a readable PDF/);
  assert.equal(h.model.calls.length, 0);
});

test('S3-R13 model not configured → READ_FAILED shown with the reason, no fields invented; Retry reads it once a model is there', async () => {
  const h = await hero({ interpreter: false });
  await h.drain();
  const r = await h.inject('hero');
  let b = (await h.api('GET', `/v1/bills/${r.billId}`)).body;
  assert.deepEqual([b.bill.state, b.readFailure, b.fields, b.actions.retry.allowed], ['READ_FAILED', 'Model not configured here', [], true]);
  assert.match((await h.overview()).needs[0].title, /Couldn't read/);
  h.deps.interpreter = h.model;
  const rr = await h.api('POST', `/v1/bills/${r.billId}/retry`, undefined, { 'if-match': String(b.bill.version) });
  assert.equal(rr.status, 202);
  await h.drain();
  b = (await h.api('GET', `/v1/bills/${r.billId}`)).body;
  assert.equal(b.bill.state, 'PROPOSED');
});

test('S3-R21 evidence bytes changed after upload → HELD (DOCUMENT_CHANGED), not read', async () => {
  const h = await hero();
  await h.drain();
  const r = await h.inject('hero', { drain: false });
  const b = await billItem(h, r.billId);
  h.evidence.overwriteForTest(b.storageKey, pdf({ lines: ['Keller Drafting Co.', 'Amount due USD $1.00'] }));
  await h.drain();
  const after = await billItem(h, r.billId);
  assert.deepEqual([after.state, after.flags], ['HELD', ['DOCUMENT_CHANGED']]);
  assert.equal(h.model.calls.length, 0);
});

test('S1/S3-R35 a worker dying mid-request leaves DISPATCHING with its reservation kept; the next attempt succeeds and settles', async () => {
  const h = await hero();
  await h.drain();
  h.model.script = [() => { throw new SimulatedCrash('worker died mid-request'); }];
  const r = await h.inject('hero');
  const [m0] = await models(h, r.billId);
  assert.equal(m0.state, 'DISPATCHING');
  assert.equal((await counter(h)).committedMicros, m0.reservedMicros);
  await h.advance(2 * 60_000); // lease expires → sweep requeues
  const ms = await models(h, r.billId);
  assert.deepEqual(ms.map((m: any) => m.state), ['DISPATCHING', 'OK']);
  const c = await counter(h);
  assert.equal(c.committedMicros, m0.reservedMicros + ms[1].actualMicros, 'the dead request stays charged at its worst case');
  assert.equal(c.reservedMicros, m0.reservedMicros);
  assert.equal((await billItem(h, r.billId)).state, 'PROPOSED');
});

test('S2/S3-R35 near the cap: two concurrent reservations where one fits → exactly one; an ingest that cannot reserve → READ_FAILED with zero dispatch', async () => {
  const h = await hero();
  await h.drain();
  const cost = worstCaseMicros(1000);
  const cap = BEDROCK_CAPS_MICROS.local;
  await h.store.transact([{ op: 'put', table: 'work', item: { pk: 'COUNTER#bedrock#local', sk: 'COUNTER', committedMicros: cap - Math.floor(cost * 1.5), reservedMicros: 0, spentMicros: cap - Math.floor(cost * 1.5) } }]);
  const one = (i: number) => reserve(h.store, [reserveOp('local', cost), { op: 'put', table: 'core', item: { pk: 'X', sk: `M${i}` } }]).then(() => 'ok', (e) => (e instanceof BudgetReached ? 'refused' : (e instanceof TxCancelled ? 'cancel' : String(e))));
  assert.deepEqual((await Promise.all([one(1), one(2)])).sort(), ['ok', 'refused']);
  const r = await h.inject('hero');
  const b = await billItem(h, r.billId);
  assert.deepEqual([b.state, b.readFailure], ['READ_FAILED', 'Model budget reached']);
  assert.equal(h.model.calls.length, 0, 'refusal → zero dispatch');
  const audit = await h.store.query('audit', K.run('tenant-a', runOf(r.billId)));
  assert.ok(audit.some((a) => a.eventType === 'ModelCallBudgetReached'));
});

test('S3 input ceiling: over 24,000 characters → TOO_LONG_TO_READ, zero calls', async () => {
  const h = await hero();
  await h.drain();
  const lines = ['Keller Drafting Co.', ...Array.from({ length: 200 }, (_, i) => `Line ${i} ${'x'.repeat(140)}`)];
  const r = await h.inject('hero', { bytes: pdf({ lines, size: 2.5 }) });
  const b = await billItem(h, r.billId);
  assert.deepEqual([b.state, b.classification], ['HELD', 'TOO_LONG_TO_READ']);
  assert.equal(h.model.calls.length, 0);
});
