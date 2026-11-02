// S4 races on REAL DynamoDB (S04 §6.11 / §6.17 R9). The dev tables' conditional writes decide each race. Separate test tenant
// `tenant-races-s4` bound to a STUB PayPal connection (FakePayPal, labelled); the bill reader is the FAKE interpreter and the
// planner is Headroom's template (no Bedrock spend). Jobs this script queues are processed here at once; the hero reset's invoice
// effects are drained immediately with the FAKE writer so the dev sweep finds them done.
//   AWS_PROFILE=headroom-admin node scripts/live/s4-races.ts [--only R1,R4] [--failed <prevDir>] [--out <dir>]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DynamoStore } from '../../backend/src/adapters/store/dynamodb.ts';
import { MemoryQueue } from '../../backend/src/adapters/queue/port.ts';
import { K } from '../../backend/src/adapters/store/keys.ts';
import type { Op, Store } from '../../backend/src/adapters/store/port.ts';
import { S3Evidence } from '../../backend/src/adapters/evidence-store/s3.ts';
import { S4_GRANT, type Deps } from '../../backend/src/deps.ts';
import { bootstrapTenant } from '../../backend/src/domain/identity-run/run.ts';
import { operatorInjectBill, operatorReset } from '../../backend/src/handlers/operator.ts';
import { handle } from '../../backend/src/handlers/router.ts';
import { processJob } from '../../backend/src/jobs/worker.ts';
import { businessDate } from '../../backend/src/domain/time.ts';
import { billPdf } from '../demo/bill-pdf.ts';
import { FakeInterpreter } from '../../tests/acceptance/fake-interpreter.ts';
import { FakePayPal } from '../../tests/acceptance/fake-paypal.ts';

process.env.AWS_PROFILE ??= 'headroom-admin';
process.env.AWS_REGION ??= 'us-east-1';
const arg = (n: string) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
const out = arg('--out');
const ALL = ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9'];
const prev = arg('--failed');
const wanted = arg('--only')?.split(',') ?? (prev ? [...new Set(JSON.parse(readFileSync(join(prev, 'results.json'), 'utf8')).results.filter((r: any) => !r.ok).map((r: any) => r.case))] as string[] : ALL);
const TENANT = 'tenant-races-s4';
const OWNER = { sub: 'races-s4-owner', email: 'races-s4@example.com' };
const dynamo = new DynamoStore({ core: 'HeadroomDev-core', work: 'HeadroomDev-work', provider: 'HeadroomDev-provider', audit: 'HeadroomDev-audit' });
/** A one-shot hook before the next transaction (inject a write between a command's reads and its commit). */
let before: ((ops: Op[]) => Promise<void>) | null = null;
const store: Store = { get: (...a) => dynamo.get(...a), query: (...a) => dynamo.query(...a), dueJobs: (...a) => dynamo.dueJobs(...a), transact: async (ops) => { const b = before; if (b) { before = null; await b(ops); } return dynamo.transact(ops); } };
const queue = new MemoryQueue();
const pp = new FakePayPal();
pp.balance.availableMinor = 180_000;
pp.balance.asOf = new Date(Date.now() - 3600_000).toISOString();
let publishHook: ((id: string) => Promise<void>) | undefined;
const d: Deps = {
  store, queue, reader: pp.reader, writer: pp.writer, now: () => new Date().toISOString(), evidence: new S3Evidence(process.env.EVIDENCE_BUCKET ?? (() => { throw new Error('set EVIDENCE_BUCKET (stack output EvidenceBucket)'); })()),
  interpreter: new FakeInterpreter(), bedrockEnv: 'local', hooks: { beforePlanPublish: (id) => publishHook?.(id) ?? Promise.resolve() },
  config: { stage: 'dev', connectionId: 'pp-races-s4-stub', merchantEmail: 'stub@example.com', webhookId: null, grant: S4_GRANT },
};
const results: { case: string; ok: boolean; detail: string }[] = [];
const record = (c: string, ok: boolean, detail: string) => { results.push({ case: c, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${c} · ${detail}`); };
let n = 0;
const api = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const r = await handle({ store, queue, config: d.config, now: d.now, evidence: d.evidence }, { method, path, headers: { ...(method === 'POST' ? { 'idempotency-key': `races4-${Date.now()}-${++n}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body), identity: OWNER });
  return { status: r.status, body: JSON.parse(r.body) };
};
const drain = async () => { for (let i = 0; i < 50 && queue.pending.length; i++) await processJob(d, queue.take()!); };
const pk = (run: string) => K.run(TENANT, run);

/** Fresh run → hero invoices issued (FAKE writer) → bill accepted → breach. Returns the run id. */
async function breach(why: string) {
  const run = (await operatorReset(d, TENANT, `S4 races: ${why}`, { bank: 'none', hero: true }))!.runId as string;
  for (const j of await store.query('core', pk(run), { skPrefix: 'INV#' })) queue.send(`eff#${j.invoiceNumber}`);
  await drain();
  const inj = await operatorInjectBill(d, TENANT, { action: 'injectBill', tenantId: TENANT, fileName: 'hero.pdf', contentBase64: billPdf('hero', businessDate(d.now(), 'America/New_York')).toString('base64'), reason: 'S4 races (FAKE model)' });
  await drain();
  let b = (await api('GET', `/v1/bills/${inj.billId}`)).body;
  await api('POST', `/v1/bills/${inj.billId}/verify`, { occurrenceKey: b.occurrence.occurrenceKey, occurrenceVersion: b.occurrence.version }, { 'if-match': String(b.bill.version) });
  b = (await api('GET', `/v1/bills/${inj.billId}`)).body;
  const a = await api('POST', `/v1/bills/${inj.billId}/accept-terms`, { termsHash: b.termsHash, changedFields: b.changedFields }, { 'if-match': String(b.bill.version) });
  if (a.status !== 200) throw new Error(`accept ${JSON.stringify(a.body)}`);
  return run;
}
const plan = async () => (await api('GET', '/v1/plan')).body;
async function draft(why: string) { const run = await breach(why); await api('POST', '/v1/plan/revisions', {}); await drain(); return { run, r: (await plan()).revision }; }
const approve = (r: any) => api('POST', `/v1/plan/revisions/${r.revisionId}/approve`, { selected: r.approval.selected, consentHash: r.approval.consentHash }, { 'if-match': String(r.version) });
const count = async (run: string, p: string) => (await store.query('core', pk(run), { skPrefix: p })).length;

await bootstrapTenant(store, { sub: OWNER.sub, email: OWNER.email, tenantId: TENANT, connectionId: 'pp-races-s4-stub' });
const kase = async (name: string, f: () => Promise<void>) => { if (!wanted.includes(name)) return; try { await f(); } catch (e) { record(name, false, `stopped: ${(e as Error).message}`); } };

await kase('R1', async () => {
  const run = await breach('double build');
  const rs = await Promise.all([api('POST', '/v1/plan/revisions', {}), api('POST', '/v1/plan/revisions', {})]);
  await drain();
  const [b, r] = [await count(run, 'BUILD#'), await count(run, 'REV#')];
  record('R1 double build → one BUILD#, one draft', b === 1 && r === 1, `${rs.map((x) => x.status).join('/')} · BUILD# ${b} · REV# ${r}`);
});
await kase('R2', async () => {
  const { run, r } = await draft('double approve');
  const rs = await Promise.all([approve(r), approve(r)]);
  const g = await count(run, 'GRANT#');
  record('R2 double approve → one RUNNING, one grant set', rs.map((x) => x.status).sort().join() === '200,409' && g === 4, `${rs.map((x) => x.status).join('/')} · grants ${g}`);
});
await kase('R3', async () => {
  const { r } = await draft('edit vs approve');
  const a = r.actions.find((x: any) => x.kind === 'COLLECT_OVERDUE');
  const rs = await Promise.all([approve(r), api('POST', `/v1/plan/revisions/${r.revisionId}/edit`, { op: 'REMOVE', actionId: a.actionId, actionVersion: a.version }, { 'if-match': String(r.version) })]);
  record('R3 edit vs approve → exactly one applies', rs.filter((x) => x.status === 200).length === 1, rs.map((x) => `${x.status} ${x.body.code ?? ''}`).join(' / '));
});
await kase('R4', async () => {
  const { run, r } = await draft('source write vs approve');
  const hook = async (ops: Op[]) => { if (ops.some((o) => o.op === 'put' && String((o as any).item?.sk).startsWith('APPROVAL#'))) await dynamo.transact([{ op: 'update', table: 'core', pk: pk(run), sk: 'PLAN', add: { basisStamp: 1 } }]); else before = hook; };
  before = hook;
  const x = await approve(r);
  record('R4 a source write between recompute and commit → CONSENT_CHANGED, nothing applied', x.body.code === 'CONSENT_CHANGED' && (await count(run, 'GRANT#')) === 0, `${x.status} ${x.body.code}`);
});
await kase('R5', async () => {
  const { r } = await draft('double revoke');
  await approve(r);
  const g = (await plan()).revision.actions.flatMap((a: any) => a.grants)[0];
  const rs = await Promise.all([api('POST', `/v1/grants/${encodeURIComponent(g.grantId)}/revoke`, {}), api('POST', `/v1/grants/${encodeURIComponent(g.grantId)}/revoke`, {})]);
  record('R5 concurrent revokes → one revocation', rs.filter((x) => x.status === 200).length === 1, rs.map((x) => `${x.status} ${x.body.code ?? ''}`).join(' / '));
});
await kase('R6', async () => {
  await breach('double pause');
  const v = (await api('GET', '/v1/delegation')).body.version;
  const rs = await Promise.all([api('POST', '/v1/delegation/pauses', { kind: 'PAYMENTS', on: true }, { 'if-match': String(v) }), api('POST', '/v1/delegation/pauses', { kind: 'OUTREACH', on: true }, { 'if-match': String(v) })]);
  const after = (await api('GET', '/v1/delegation')).body;
  record('R6 concurrent pause toggles → one new version', rs.filter((x) => x.status === 200).length === 1 && after.version === v + 1, `${rs.map((x) => x.status).join('/')} · v${v} → v${after.version}`);
});
await kase('R7', async () => {
  const run = await breach('lease loss');
  await api('POST', '/v1/plan/revisions', {});
  publishHook = async () => { publishHook = undefined; const job = (await store.query('core', pk(run), { skPrefix: 'BUILD#' }))[0]; const id = `plan#${job.basisHash.slice(0, 24)}#${job.generation}`; const cur = await store.get('work', K.job(id), 'JOB'); await dynamo.transact([{ op: 'update', table: 'work', pk: K.job(id), sk: 'JOB', set: { leaseToken: cur!.leaseToken + 1 } }]); };
  await drain();
  record('R7 lease lost during PLAN_BUILD → the old worker cannot publish', (await count(run, 'REV#')) === 0, `REV# ${await count(run, 'REV#')}`);
});
await kase('R8', async () => {
  const run = await breach('reset during build');
  await api('POST', '/v1/plan/revisions', {});
  let next = '';
  publishHook = async () => { publishHook = undefined; next = (await operatorReset(d, TENANT, 'S4 races: reset mid-build', { bank: 'none', hero: false }))!.runId as string; };
  await drain();
  record('R8 (S4-R25) reset during a build → only the old run is written; the new run has no revision', (await count(next, 'REV#')) === 0, `old REV# ${await count(run, 'REV#')} · new REV# ${await count(next, 'REV#')}`);
});
await kase('R9', async () => {
  const run = await breach('double retry');
  d.hooks!.planBuildFault = () => 'races: data fault';
  await api('POST', '/v1/plan/revisions', {});
  await drain();
  d.hooks!.planBuildFault = undefined;
  const b = (await plan()).build;
  const rs = await Promise.all([1, 2].map(() => api('POST', '/v1/plan/revisions', { retry: { buildId: b.buildId, generation: b.generation } })));
  await drain();
  record('R9 double retry → one retry, one draft', rs.filter((x) => x.status === 202).length === 1 && (await count(run, 'REV#')) === 1, `${rs.map((x) => x.status).join('/')} · REV# ${await count(run, 'REV#')}`);
});
console.log(`${results.filter((r) => r.ok).length}/${results.length} PASS · FAKE PayPal/reader, template planner (no Bedrock spend)`);
if (out) { mkdirSync(out, { recursive: true }); writeFileSync(join(out, 'results.json'), JSON.stringify({ at: new Date().toISOString(), tables: 'HeadroomDev-*', tenant: TENANT, results }, null, 2)); }
process.exit(results.every((r) => r.ok) ? 0 : 1);
