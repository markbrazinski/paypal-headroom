// S3 races on REAL DynamoDB (S03 §6.11 rev 1, layer 3). The dev tables' conditional writes decide each race, not the memory store.
// Separate test tenant `tenant-races-s3` (no PayPal connection, no bank); originals go to the real evidence bucket. The model is the
// labelled FAKE interpreter (tests only; no Bedrock spend). Ingest jobs are processed here at once; if the dev sweep claims one first,
// the dev worker reads it with real Nova and the case notes it.
//   AWS_PROFILE=headroom-admin node scripts/live/s3-races.ts [--out <dir>]
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DynamoStore } from '../../backend/src/adapters/store/dynamodb.ts';
import { MemoryQueue } from '../../backend/src/adapters/queue/port.ts';
import { K } from '../../backend/src/adapters/store/keys.ts';
import { TxCancelled } from '../../backend/src/adapters/store/port.ts';
import { S3Evidence } from '../../backend/src/adapters/evidence-store/s3.ts';
import { S3_GRANT, type Deps } from '../../backend/src/deps.ts';
import { bootstrapTenant } from '../../backend/src/domain/identity-run/run.ts';
import { operatorInjectBill, operatorReset } from '../../backend/src/handlers/operator.ts';
import { handle } from '../../backend/src/handlers/router.ts';
import { processJob } from '../../backend/src/jobs/worker.ts';
import { businessDate } from '../../backend/src/domain/time.ts';
import { billPdf, type Variant } from '../demo/bill-pdf.ts';
import { FakeInterpreter } from '../../tests/acceptance/fake-interpreter.ts';
import { FakePayPal } from '../../tests/acceptance/fake-paypal.ts';

process.env.AWS_PROFILE ??= 'headroom-admin';
process.env.AWS_REGION ??= 'us-east-1';
const out = (() => { const i = process.argv.indexOf('--out'); return i > 0 ? process.argv[i + 1] : null; })();
const TENANT = 'tenant-races-s3';
const OWNER = { sub: 'races-s3-owner', email: 'races-s3@example.com' };
const store = new DynamoStore({ core: 'HeadroomDev-core', work: 'HeadroomDev-work', provider: 'HeadroomDev-provider', audit: 'HeadroomDev-audit' });
const queue = new MemoryQueue();
const model = new FakeInterpreter();
const pp = new FakePayPal();
let hook: ((billId: string) => Promise<void>) | undefined;
const d: Deps = {
  store, queue, reader: pp.reader, now: () => new Date().toISOString(), evidence: new S3Evidence(process.env.EVIDENCE_BUCKET ?? (() => { throw new Error('set EVIDENCE_BUCKET (stack output EvidenceBucket)'); })()),
  interpreter: model, bedrockEnv: 'local', hooks: { beforeIngestCommit: (id) => hook?.(id) ?? Promise.resolve() },
  config: { stage: 'dev', connectionId: 'pp-races-stub', merchantEmail: 'stub@example.com', webhookId: null, grant: S3_GRANT },
};
const results: { case: string; ok: boolean; detail: string }[] = [];
const record = (c: string, ok: boolean, detail: string) => { results.push({ case: c, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${c} · ${detail}`); };
let n = 0;
const api = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const r = await handle({ store, queue, config: d.config, now: d.now, evidence: d.evidence }, { method, path, headers: { ...(method === 'POST' ? { 'idempotency-key': `races-${Date.now()}-${++n}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body), identity: OWNER });
  return { status: r.status, body: JSON.parse(r.body) };
};
const drain = async () => { while (queue.pending.length) await processJob(d, queue.take()!); };
const today = () => businessDate(new Date().toISOString(), 'America/New_York');
const inject = async (v: Variant, drainNow = true) => {
  const r = await operatorInjectBill(d, TENANT, { action: 'injectBill', tenantId: TENANT, fileName: `${v}.pdf`, contentBase64: billPdf(v, today()).toString('base64'), reason: 'S3 races (FAKE model)' });
  if (drainNow) await drain();
  return r;
};
const fresh = async (why: string) => (await operatorReset(d, TENANT, `S3 races: ${why}`, { bank: 'none', hero: true }))!.runId as string;
const bill = async (id: string) => (await api('GET', `/v1/bills/${id}`)).body;
const verifyBody = (b: any) => ({ occurrenceKey: b.occurrence.occurrenceKey, occurrenceVersion: b.occurrence.version });

await bootstrapTenant(store, { sub: OWNER.sub, email: OWNER.email, tenantId: TENANT, connectionId: null });

// 1. Concurrent identical uploads → one bill.
{
  const run = await fresh('identical uploads');
  const body = { fileName: 'k.pdf', contentType: 'application/pdf', contentBase64: billPdf('hero', today()).toString('base64') };
  const [a, b] = await Promise.all([api('POST', '/v1/documents', body), api('POST', '/v1/documents', body)]);
  const docs = await store.query('core', K.run(TENANT, run), { skPrefix: 'BILL#' });
  record('R1 concurrent identical uploads', docs.length === 1 && a.body.billId === b.body.billId && [a.body.status, b.body.status].sort().join() === 'DUPLICATE_DOCUMENT,RECEIVED', `${a.status}/${a.body.status} · ${b.status}/${b.body.status} · bills ${docs.length}`);
  await drain();
}
// 2. Competing verifies on one occurrence (also: concurrent put-if-absent materialization of OBL#).
{
  const run = await fresh('competing verifies');
  const x = await bill((await inject('hero')).billId);
  const y = await bill((await inject('amount')).billId);
  const [vx, vy] = await Promise.all([
    api('POST', `/v1/bills/${x.bill.billId}/verify`, verifyBody(x), { 'if-match': String(x.bill.version) }),
    api('POST', `/v1/bills/${y.bill.billId}/verify`, verifyBody(y), { 'if-match': String(y.bill.version) }),
  ]);
  const obl = await store.query('core', K.run(TENANT, run), { skPrefix: 'OBL#cmt-keller-ms2#' });
  record('O4/S3-R37 competing verifies → one wins, one OBL#, loser VERSION_CONFLICT', [vx.status, vy.status].sort().join() === '200,409' && obl.length === 1 && [vx, vy].some((r) => r.body.code === 'VERSION_CONFLICT'), `${vx.status}/${vy.status} · OBL ${obl.length} substantiatedBy ${obl[0]?.substantiatedBy === x.bill.billId ? 'hero' : 'amount'}`);
  // 3. Two concurrent accepts of the winner → one TERMS#.
  const winner = await bill(vx.status === 200 ? x.bill.billId : y.bill.billId);
  const body = { termsHash: winner.termsHash, changedFields: winner.changedFields };
  const [a1, a2] = await Promise.all([1, 2].map(() => api('POST', `/v1/bills/${winner.bill.billId}/accept-terms`, body, { 'if-match': String(winner.bill.version) })));
  const terms = await store.query('core', K.run(TENANT, run), { skPrefix: 'TERMS#' });
  record('S3-R9 two concurrent accepts → one TERMS#', [a1.status, a2.status].sort().join() === '200,409' && terms.length === 1, `${a1.status}/${a2.status} · TERMS ${terms.length}`);
}
// 4. Lease lost during ingest → the old worker's final write fails; the bill is not published by it.
{
  const run = await fresh('lease loss');
  hook = async (billId) => {
    hook = undefined;
    const j = (await store.query('work', K.job(`ingest#${billId}#1`)))[0];
    await store.transact([{ op: 'update', table: 'work', pk: j.pk, sk: 'JOB', set: { leaseToken: j.leaseToken + 1 }, cond: { eq: { leaseToken: j.leaseToken } } }]); // as if the sweep re-leased it
  };
  const r = await inject('hero');
  const b = await store.get('core', K.run(TENANT, run), `BILL#${r.billId}`);
  record('S3-R34 lease lost during ingest → final write refused', b!.state === 'RECEIVED', `bill ${b!.state} after the old worker finished`);
  // Cleanup: retire the re-leased job so the dev sweep doesn't hand it to the real worker later.
  const j = (await store.query('work', K.job(`ingest#${r.billId}#1`)))[0];
  await store.transact([{ op: 'update', table: 'work', pk: j.pk, sk: 'JOB', set: { state: 'DONE', leaseUntil: null }, remove: ['gsiDue', 'dueKey'] }]);
}
// 5. Retry vs an old generation → only the new generation publishes.
{
  const run = await fresh('retry generation');
  hook = async (billId) => {
    hook = undefined;
    const b = await store.get('core', K.run(TENANT, run), `BILL#${billId}`);
    await store.transact([{ op: 'update', table: 'core', pk: b!.pk, sk: b!.sk, set: { state: 'READ_FAILED', readFailure: 'races', version: b!.version + 1 }, cond: { eq: { version: b!.version } } }]);
    const rr = await api('POST', `/v1/bills/${billId}/retry`, undefined, { 'if-match': String(b!.version + 1) });
    if (rr.status !== 202) throw new Error(`retry ${rr.status}`);
  };
  const r = await inject('hero');
  await drain();
  const b = await store.get('core', K.run(TENANT, run), `BILL#${r.billId}`);
  record('S3-R34 retry vs old generation', b!.state === 'PROPOSED' && b!.readGeneration === 2, `state ${b!.state}, generation ${b!.readGeneration}`);
}
// 6. Reset during ingest → the old run's bill finishes in the old run only.
{
  const oldRun = await fresh('reset during ingest');
  const r = await inject('hero', false);
  const newRun = await fresh('reset during ingest (new run)');
  await drain();
  const oldBill = await store.get('core', K.run(TENANT, oldRun), `BILL#${r.billId}`);
  const newBills = await store.query('core', K.run(TENANT, newRun), { skPrefix: 'BILL#' });
  record('S3-R15 reset during ingest', oldBill!.state === 'PROPOSED' && newBills.length === 0, `old run bill ${oldBill!.state}; new run bills ${newBills.length}`);
}
// 8. S3-IM-02: two same-number copies read concurrently before linking → one current bill, the other SUPERSEDED; one outflow.
{
  const run = await fresh('revision race');
  const day = (n: number) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' }).format(new Date(Date.parse(`${today()}T00:00:00Z`) + n * 86_400_000));
  const { pdf } = await import('../demo/bill-pdf.ts');
  const copy = (total: string, extra: string[]) => pdf({ lines: ['Keller Drafting Co.', 'INVOICE K-2230', `Payment due: ${day(9)}`, `Amount due ${total}`, 'Remit to account ending 4417', ...extra] });
  const inj = (bytes: Buffer, name: string) => operatorInjectBill(d, TENANT, { action: 'injectBill', tenantId: TENANT, fileName: name, contentBase64: bytes.toString('base64'), reason: 'S3 races (FAKE model)' });
  const [x, y] = await Promise.all([inj(copy('USD $480.00', []), 'k-480.pdf'), inj(copy('USD $500.00', ['REVISED']), 'k-500.pdf')]);
  await Promise.all([drain(), drain()]);
  await drain();
  const bills = await Promise.all([x.billId, y.billId].map((id) => bill(id)));
  const states = bills.map((b) => b.bill.state).sort();
  const results2 = await Promise.all(bills.map((b) => api('POST', `/v1/bills/${b.bill.billId}/add-obligation`, { termsHash: b.separateTermsHash ?? 'x' }, { 'if-match': String(b.bill.version) })));
  const obl = (await store.query('core', K.run(TENANT, run), { skPrefix: 'OBL#bill-' })).length;
  record('S3-IM-02 same-number copies → one current, one SUPERSEDED, one outflow', states.join() === 'PROPOSED,SUPERSEDED' && obl === 1 && results2.filter((r) => r.status === 200).length === 1, `states ${states.join('/')} · adds ${results2.map((r) => r.status).join('/')} · OBL ${obl}`);
}
// 7. Near-cap spend reservations (synthetic counter; same condition shape as reserveOp) → exactly one.
{
  const pk = `COUNTER#bedrock#races-${Date.now()}`;
  const cap = 1000, cost = 600;
  await store.transact([{ op: 'put', table: 'work', item: { pk, sk: 'COUNTER', committedMicros: 0 } }]);
  const one = () => store.transact([{ op: 'update', table: 'work', pk, sk: 'COUNTER', add: { committedMicros: cost }, cond: { ltOrMissing: { committedMicros: cap - cost + 1 } } }]).then(() => 'ok', (e) => (e instanceof TxCancelled ? 'refused' : String(e)));
  const rs = await Promise.all([one(), one()]);
  const c = await store.get('work', pk, 'COUNTER');
  record('S3-R35 near-cap concurrent reservations', rs.sort().join() === 'ok,refused' && c!.committedMicros === cost, `${rs.join('/')} · committed ${c!.committedMicros} of cap ${cap}`);
}
console.log(`${results.filter((r) => r.ok).length}/${results.length} PASS · FAKE model calls ${model.calls.length} (no Bedrock spend)`);
if (out) { mkdirSync(out, { recursive: true }); writeFileSync(join(out, 'results.json'), JSON.stringify({ at: new Date().toISOString(), tables: 'HeadroomDev-*', tenant: TENANT, model: 'FAKE', results }, null, 2)); }
process.exit(results.every((r) => r.ok) ? 0 : 1);
