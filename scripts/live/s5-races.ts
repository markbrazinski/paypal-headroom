// S5 races on REAL DynamoDB (S05 §6.11 "Real persistence" R1–R12). The dev tables' conditional writes decide each race.
// Separate test tenant `tenant-races-s5`; every case builds its own world: a fresh STUB PayPal connection (FakePayPal, labelled),
// a STUB Plaid Item (FakePlaid + a local vault), the labelled SIMULATED mailbox on the same store, the FAKE bill reader and
// Headroom's template planner (no Bedrock, no real PayPal/Plaid/Gmail call). The clock is a script clock in the hero week
// (Mon 9 Nov 2026 10:00 New York), so the deployed dev sweep never sees this tenant's jobs as due; the script's own sweep only
// touches the current case's run, and the end of the script retires every job of this tenant still queued (`retire`).
//   AWS_PROFILE=headroom-admin node scripts/live/s5-races.ts [--only R1,R4] [--failed <prevDir>] [--out <dir>]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { minorToDecimal } from '@headroom/contracts';
import { DynamoStore } from '../../backend/src/adapters/store/dynamodb.ts';
import { MemoryQueue } from '../../backend/src/adapters/queue/port.ts';
import { K } from '../../backend/src/adapters/store/keys.ts';
import { TxCancelled, type Item, type Op, type Store } from '../../backend/src/adapters/store/port.ts';
import { S3Evidence } from '../../backend/src/adapters/evidence-store/s3.ts';
import { LocalVault } from '../../backend/src/adapters/vault.ts';
import { SimulatedMailbox } from '../../backend/src/adapters/mail/simulated.ts';
import { b64url, buildMessage } from '../../backend/src/adapters/mail/rfc5322.ts';
import { sliceGrant, SimulatedCrash, type Deps } from '../../backend/src/deps.ts';
import { bootstrapTenant } from '../../backend/src/domain/identity-run/run.ts';
import { bindingOf, syncJobId } from '../../backend/src/domain/bank-mirror/connect.ts';
import { observeBalance } from '../../backend/src/domain/paypal-mirror/observe-balance.ts';
import { reconcileInvoice } from '../../backend/src/domain/paypal-mirror/reconcile-invoice.ts';
import { lockPk } from '../../backend/src/domain/executor/invoice-update.ts';
import { mailSyncJobId } from '../../backend/src/domain/comms/inbound.ts';
import { operatorInjectBill, operatorReset } from '../../backend/src/handlers/operator.ts';
import { handle } from '../../backend/src/handlers/router.ts';
import { processJob } from '../../backend/src/jobs/worker.ts';
import { sweep } from '../../backend/src/jobs/sweep.ts';
import { newJob, putJobOp, requestRun } from '../../backend/src/jobs/lease.ts';
import { businessDate } from '../../backend/src/domain/time.ts';
import { billPdf } from '../demo/bill-pdf.ts';
import { FakeInterpreter } from '../../tests/acceptance/fake-interpreter.ts';
import { FakePayPal } from '../../tests/acceptance/fake-paypal.ts';
import { FakePlaid } from '../../tests/acceptance/fake-plaid.ts';

process.env.AWS_PROFILE ??= 'headroom-admin';
process.env.AWS_REGION ??= 'us-east-1';
const arg = (n: string) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
const out = arg('--out');
const ALL = ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9', 'R10', 'R11', 'R12'];
const prev = arg('--failed');
const wanted = arg('--only')?.split(',') ?? (prev ? [...new Set(JSON.parse(readFileSync(join(prev, 'results.json'), 'utf8')).results.filter((r: any) => !r.ok).map((r: any) => String(r.case).split(' ')[0]))] as string[] : ALL);
const TENANT = 'tenant-races-s5';
const OWNER = { sub: 'races-s5-owner', email: 'races-s5@example.com' };
const TAG = randomBytes(3).toString('hex');
const GRANT = sliceGrant('S5-RACES', '2026-12-31T23:59:59.000Z'); // own counters: never spends the dev deployment's S5 budgets
const MON_10AM = '2026-11-09T15:00:00.000Z', TUE_0805 = '2026-11-10T13:05:00.000Z', WED_0900 = '2026-11-11T14:00:00.000Z';
const FEES = { pellow: 26_573, harrow: 25_177 };
const amt = (minor: number) => ({ currency_code: 'USD', value: minorToDecimal(minor) });

// ---------- store: real DynamoDB + test seams (one-shot hook before a matching TX, a two-party barrier, a log of refused TXs) ----------
const dynamo = new DynamoStore({ core: 'HeadroomDev-core', work: 'HeadroomDev-work', provider: 'HeadroomDev-provider', audit: 'HeadroomDev-audit' });
type Hook = { match: (ops: Op[]) => boolean; run: (ops: Op[]) => Promise<void> };
let hooks: Hook[] = [];
let barrier: { match: (ops: Op[]) => boolean; waiting: (() => void)[]; n: number; reached: number } | null = null;
const refused: { ops: Op[]; failed: boolean[] }[] = [];
const skOf = (o: Op) => (o.op === 'put' ? o.item.sk : o.sk) as string;
const has = (ops: Op[], f: (o: Op) => boolean) => ops.some(f);
const store: Store = {
  get: (...a) => dynamo.get(...a), query: (...a) => dynamo.query(...a), dueJobs: (...a) => dynamo.dueJobs(...a),
  transact: async (ops) => {
    const h = hooks.find((x) => x.match(ops));
    if (h) { hooks = hooks.filter((x) => x !== h); await h.run(ops); }
    const b = barrier;
    if (b && b.match(ops)) {
      b.reached++;
      if (b.reached >= b.n) { barrier = null; b.waiting.forEach((w) => w()); }
      else await new Promise<void>((res) => { b.waiting.push(res); setTimeout(res, 30_000); }); // never hang: released after 30 s
    }
    try { return await dynamo.transact(ops); } catch (e) { if (e instanceof TxCancelled) refused.push({ ops, failed: e.failed }); throw e; }
  },
};

// ---------- one world per case ----------
let now = Date.parse(MON_10AM);
const clock = () => new Date(now).toISOString();
const queue = new MemoryQueue();
const cur = { runId: '', refs: new Set<string>() };
const allRefs = new Set<string>(); // every STUB connection and Item this process made (for the retire step)
/** The script's sweep sees only the current case's jobs (its run, its STUB connection and Item). */
const mine = (j: Item) => (j.tenantId === TENANT && (!j.runId || j.runId === cur.runId)) || cur.refs.has(j.ref);
const sweepStore: Store = { ...store, dueJobs: async (n, lim) => (await dynamo.dueJobs(n, 1000)).filter(mine).slice(0, lim) };
const evidence = new S3Evidence(process.env.EVIDENCE_BUCKET ?? (() => { throw new Error('set EVIDENCE_BUCKET (stack output EvidenceBucket)'); })());
let pp: FakePayPal, plaid: FakePlaid, mailbox: SimulatedMailbox, d: Deps;
let n = 0;
const api = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const r = await handle({ store, queue, config: d.config, now: clock, evidence, vault: d.vault }, { method, path, headers: { ...(method === 'POST' && !path.includes('/refresh') ? { 'idempotency-key': `races5-${TAG}-${++n}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body), identity: OWNER });
  return { status: r.status, body: JSON.parse(r.body) };
};
const run1 = async (id: string) => { try { await processJob(d, id); } catch (e) { if (!(e instanceof SimulatedCrash)) throw e; } };
/** Sweep + queued jobs until quiet; one more sweep after a pause covers the due index's eventual consistency. */
async function drain(max = 200) {
  for (let i = 0, quiet = 0; i < max && quiet < 2; i++) {
    await sweep({ store: sweepStore, queue, now: clock });
    if (!queue.pending.length) { quiet++; if (quiet < 2) await new Promise((r) => setTimeout(r, 1200)); continue; }
    quiet = 0;
    while (queue.pending.length) await run1(queue.take()!);
  }
}
const advance = async (ms: number) => { now += ms; await drain(); };
const setNow = (iso: string) => { now = Date.parse(iso); };
const pk = () => K.run(TENANT, cur.runId);
const items = (p: string) => store.query('core', pk(), { skPrefix: p });
const actionOf = async (kind: string) => (await items('ACT#')).find((a) => a.kind === kind && a.state !== 'SUPERSEDED')!;
const invOf = async (cust: string) => (await items('INV#')).find((i) => i.customerId === cust)!;
const audits = async (type: string) => (await store.query('audit', pk())).filter((e) => e.eventType === type);
const job = (id: string) => store.get('work', K.job(id), 'JOB');

async function world(name: string) {
  hooks = []; barrier = null; refused.length = 0; queue.pending.length = 0;
  setNow(MON_10AM);
  const connectionId = `pp-races-s5-${TAG}-${name}`;
  pp = new FakePayPal();
  pp.balance.availableMinor = 180_000;
  pp.balance.asOf = new Date(now - 2 * 3600_000).toISOString();
  plaid = new FakePlaid();
  plaid.today = () => clock().slice(0, 10);
  const vault = new LocalVault();
  mailbox = new SimulatedMailbox(store, `races-${TAG}-${name.toLowerCase()}@headroom.example`, clock);
  d = {
    store, queue, reader: pp.reader, writer: pp.writer, now: clock, hooks: {}, evidence, interpreter: new FakeInterpreter(), bedrockEnv: 'local',
    plaid: { reader: plaid.reader, connector: plaid.connector, linkToken: plaid.linkToken }, vault, elapsed: () => plaid.elapsed,
    mail: { channel: mailbox, address: `races-${TAG}-${name.toLowerCase()}@headroom.example`, redirectTo: null },
    config: { stage: 'dev', connectionId, merchantEmail: 'stub@example.com', webhookId: null, grant: GRANT, mail: { kind: 'SIMULATED', sender: null, inbox: null } },
  };
  cur.refs = new Set([connectionId]);
  await bootstrapTenant(store, { sub: OWNER.sub, email: OWNER.email, tenantId: TENANT, connectionId });
  const r = (await operatorReset(d, TENANT, `S5 races ${TAG}: ${name}`, { bank: 'seed', hero: true }))!;
  cur.runId = r.runId as string;
  await drain();
  const b = await bindingOf(store, TENANT, cur.runId);
  if (b?.itemId) cur.refs.add(b.itemId);
  for (const r of cur.refs) allRefs.add(r);
  pp.rows = [{ transaction_id: `BASELINE-${TAG}`, transaction_event_code: 'T0000', transaction_status: 'S', transaction_initiation_date: '2026-11-08T12:00:00Z', transaction_amount: amt(180_000), available_balance: amt(180_000) }];
  await api('POST', '/v1/cash/paypal/refresh');
  await drain();
}
/** Hero breach → template plan → approved (as tests/acceptance/s5-helpers.ts `approved`). */
async function approved(name: string) {
  await world(name);
  const inj = await operatorInjectBill(d, TENANT, { action: 'injectBill', tenantId: TENANT, fileName: 'hero.pdf', contentBase64: billPdf('hero', businessDate(clock(), 'America/New_York')).toString('base64'), reason: 'S5 races (FAKE model)' });
  await drain();
  let b = (await api('GET', `/v1/bills/${inj.billId}`)).body;
  await api('POST', `/v1/bills/${inj.billId}/verify`, { occurrenceKey: b.occurrence.occurrenceKey, occurrenceVersion: b.occurrence.version }, { 'if-match': String(b.bill.version) });
  b = (await api('GET', `/v1/bills/${inj.billId}`)).body;
  const a = await api('POST', `/v1/bills/${inj.billId}/accept-terms`, { termsHash: b.termsHash, changedFields: b.changedFields }, { 'if-match': String(b.bill.version) });
  if (a.status !== 200) throw new Error(`accept ${JSON.stringify(a.body)}`);
  if ((await api('POST', '/v1/plan/revisions', {})).status !== 202) throw new Error('plan build refused');
  await drain();
  const rev = (await api('GET', '/v1/plan')).body.revision;
  const ap = await api('POST', `/v1/plan/revisions/${rev.revisionId}/approve`, { selected: rev.approval.selected, consentHash: rev.approval.consentHash }, { 'if-match': String(rev.version) });
  if (ap.status !== 200) throw new Error(`approve ${ap.status} ${JSON.stringify(ap.body)}`);
  return rev;
}
async function pay(cust: string, grossMinor: number, feeMinor: number) {
  const inv = await invOf(cust);
  const cap = pp.pay(inv.ppInvoiceId, { grossMinor, feeMinor, createTime: clock() });
  await api('POST', `/v1/invoices/${inv.invoiceId}/refresh`);
  await drain();
  return { cap, inv };
}
function report(caps: { cap: string; gross: number; fee: number; number: string }[]) {
  let bal = pp.balance.availableMinor;
  for (const c of caps) {
    bal += c.gross - c.fee;
    pp.rows.push({ transaction_id: c.cap, transaction_event_code: 'T0006', transaction_status: 'S', transaction_initiation_date: new Date(now - 10 * 60_000).toISOString().replace('.000', ''), transaction_amount: amt(c.gross), fee_amount: { currency_code: 'USD', value: `-${minorToDecimal(c.fee)}` }, available_balance: amt(bal), invoice_id: c.number });
  }
  pp.balance = { ...pp.balance, availableMinor: bal, asOf: clock() };
}
const lagReport = (lagMs = 2 * 3600_000) => { pp.balance = { ...pp.balance, asOf: new Date(now - lagMs).toISOString() }; };
/** The Mercer check: run 1 (lock, PayPal refresh, bank sync request), then run 2 after the bank read. */
async function check() {
  await drain();
  await advance(20_000);
  const a = await actionOf('DISCOUNT_FALLBACK');
  return { a, chk: a.lastCheckId ? await store.get('core', pk(), a.lastCheckId) : undefined };
}
/** Contact day: Pellow's reminder and Harrow's partial setting run (Tue 08:05). */
async function tue(name: string) { const rev = await approved(name); setNow(TUE_0805); await drain(); return rev; }
/** Both pay Wed 08:30; the 09:00 check sees them captured but not yet reported → HELD_EVIDENCE (S5-A5). */
async function bothPaid(name: string, reported = false) {
  await tue(name);
  setNow('2026-11-11T13:30:00.000Z');
  const p = await pay('cust-pellow', 760_000, FEES.pellow);
  const h = await pay('cust-harrow', 720_000, FEES.harrow);
  setNow(WED_0900);
  if (reported) { report([{ cap: p.cap, gross: 760_000, fee: FEES.pellow, number: p.inv.invoiceNumber }, { cap: h.cap, gross: 720_000, fee: FEES.harrow, number: h.inv.invoiceNumber }]); lagReport(5 * 60_000); }
  else lagReport();
}
/** Only Pellow pays (reported): verified funds fall short at the check → NEEDED (S5-R2). */
async function onePayer(name: string) {
  await tue(name);
  setNow('2026-11-10T16:00:00.000Z');
  const p = await pay('cust-pellow', 760_000, FEES.pellow);
  setNow('2026-11-11T13:00:00.000Z');
  report([{ cap: p.cap, gross: 760_000, fee: FEES.pellow, number: p.inv.invoiceNumber }]);
  lagReport(5 * 60_000);
  setNow(WED_0900);
}
const checkJobOf = (a: Item) => `due#${a.actionId}#${a.intentVersion}#CHECK#0`;
const checks = async (actionId: string) => items(`CHECK#${actionId}#`);
const updEffect = (key: string) => store.get('work', K.effect(key), 'EFFECT');

// ---------- results ----------
const results: { case: string; ok: boolean; detail: string }[] = [];
const record = (c: string, ok: boolean, detail: string) => { results.push({ case: c, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${c} · ${detail}`); };
const notRun = (c: string, why: string) => { results.push({ case: c, ok: true, detail: `NOT RUN: ${why}` }); console.log(`NOT RUN ${c} · ${why}`); };
const runs: Record<string, string> = {};
const kase = async (name: string, f: () => Promise<void>) => {
  if (!wanted.includes(name)) return;
  const t0 = Date.now();
  try { await f(); } catch (e) { record(name, false, `stopped: ${(e as Error).stack?.split('\n').slice(0, 3).join(' | ')}`); }
  runs[name] = cur.runId;
  console.log(`   (${name}: run ${cur.runId}, ${Math.round((Date.now() - t0) / 1000)} s)`);
};

// R1: two ACTION_DUE workers for one check, both at the lock at once → one CHECKRUN generation, one CHECK#, one outcome.
await kase('R1', async () => {
  await bothPaid('R1');
  const a = await actionOf('DISCOUNT_FALLBACK');
  const j0 = checkJobOf(a), j1 = `due#${a.actionId}#${a.intentVersion}#CHECK#1`;
  await store.transact([putJobOp(newJob(j1, 'ACTION_DUE', a.actionId, clock(), TENANT, cur.runId))]);
  barrier = { match: (ops) => has(ops, (o) => o.op === 'put' && skOf(o) === `CHECKRUN#${a.actionId}`), waiting: [], n: 2, reached: 0 };
  await Promise.all([run1(j0), run1(j1)]);
  const lockRefused = refused.filter((r) => has(r.ops, (o) => o.op === 'put' && skOf(o) === `CHECKRUN#${a.actionId}`)).length;
  const { a: after } = await check();
  const cs = await checks(a.actionId);
  const cr = await store.get('core', pk(), `CHECKRUN#${a.actionId}`);
  record('R1 two workers, one check → one lock, one CHECK# generation, one outcome', lockRefused === 1 && cs.length === 1 && cr?.generation === 1 && cr?.phase === 'DONE' && after.state === 'HELD_EVIDENCE',
    `lock TXs refused ${lockRefused} · CHECK# ${cs.map((c) => `${c.generation}:${c.decision}`).join(',')} · CHECKRUN g${cr?.generation} ${cr?.phase} · ${after.state}`);
});

// R2: the owner revokes the offer's permission between the check's calculation and its decide → no update dispatched after revoke.
await kase('R2', async () => {
  await onePayer('R2');
  const a = await actionOf('DISCOUNT_FALLBACK');
  const grants = (await items('GRANT#')).filter((g) => g.rootId === a.rootId && g.state === 'ACTIVE');
  if (!grants.length) {
    // The offer runs under delegation policy (in-limit, A-002) with no grant to revoke: the owner's lever is Remove on the running revision.
    let res: any = null;
    d.hooks!.beforeSkipDecide = async () => {
      if (res) return;
      const r = (await api('GET', '/v1/plan')).body.revision;
      const cur = r.actions.find((x: any) => x.actionId === a.actionId) ?? a;
      res = await api('POST', `/v1/plan/revisions/${r.revisionId}/edit`, { op: 'REMOVE', actionId: a.actionId, actionVersion: cur.version, reason: 'races R2' }, { 'if-match': String(r.version) });
    };
    const p0 = pp.count('PUT');
    await check();
    await drain();
    const fin = await actionOf('DISCOUNT_FALLBACK');
    const decideRefused = refused.some((r) => has(r.ops, (o) => o.op === 'put' && skOf(o).startsWith(`CHECK#${a.actionId}#`)));
    const effects = (await audits('ActionQueued')).filter((x) => x.refs?.actionId === a.actionId).length;
    record('R2 owner removes the offer between calculation and decide → one wins (the remove); nothing queued or dispatched after it', res?.status === 200 && decideRefused && pp.count('PUT') === p0 && effects === 0 && !['QUEUED', 'APPLIED', 'UNCERTAIN'].includes(fin.state),
      `no grant on the offer (policy) · remove ${res?.status} ${res?.body?.code ?? ''} · decide on the old picture refused ${decideRefused} · ActionQueued ${effects} · PUT +${pp.count('PUT') - p0} · offer ${fin.state}`);
    return;
  }
  let res: any = null;
  d.hooks!.beforeSkipDecide = async () => { if (res) return; res = await api('POST', `/v1/grants/${encodeURIComponent(grants[0].grantId)}/revoke`, { reason: 'races R2' }); };
  const p0 = pp.count('PUT');
  await check();
  await drain();
  const fin = await actionOf('DISCOUNT_FALLBACK');
  const g = await store.get('core', pk(), grants[0].sk);
  record('R2 revoke between calculation and decide → one wins; no update dispatched after the revoke', res?.status === 200 && g?.state === 'REVOKED' && pp.count('PUT') === p0 && !['QUEUED', 'APPLIED'].includes(fin.state),
    `revoke ${res?.status} ${res?.body?.code ?? ''} · grant ${g?.state} · PUT +${pp.count('PUT') - p0} · offer ${fin.state} ${fin.holdCode ?? ''}`);
});

// R3 (AT-F06): a receipt lands mid-check (stamp moves) → the decide on the old inputs is refused; the check re-runs on the new ones.
await kase('R3', async () => {
  await bothPaid('R3', true); // reported: the check would SKIP on these inputs
  // A second payment toward a non-hero invoice lands between calculation and decide (a capture → receipt TX → funds stamps).
  const dr = await api('POST', '/v1/invoices', { customerId: 'cust-alder', amount: { currency: 'USD', minor: 4_200 }, dueOn: '2026-11-20' });
  if (dr.status !== 201) throw new Error(`draft ${JSON.stringify(dr.body)}`);
  const extra = dr.body.invoice.invoiceId;
  await api('POST', `/v1/invoices/${extra}/send`, undefined, { 'if-match': '1' });
  await drain();
  const a = await actionOf('DISCOUNT_FALLBACK');
  let calls = 0, capId = '';
  d.hooks!.beforeSkipDecide = async () => {
    if (calls++) return;
    const inv = (await items('INV#')).find((i) => i.invoiceId === extra)!;
    capId = pp.pay(inv.ppInvoiceId, { grossMinor: 4_200, feeMinor: 180, createTime: clock() });
    await reconcileInvoice(d, { tenantId: TENANT, runId: cur.runId, invoiceId: extra }, 'REFRESH');
  };
  const before = (await store.get('provider', K.conn(d.config.connectionId), 'FUNDS'))?.stamp ?? 0;
  await check();
  await advance(20_000);
  const fin = await actionOf('DISCOUNT_FALLBACK');
  const cs = await checks(a.actionId);
  const firstRefused = refused.some((r) => has(r.ops, (o) => o.op === 'put' && skOf(o).startsWith(`CHECK#${a.actionId}#`)));
  const c = cs[0];
  const stampNow = (await store.get('provider', K.conn(d.config.connectionId), 'FUNDS'))?.stamp ?? 0;
  record('R3 receipt mid-check → stale decide refused, re-run decides on the new inputs (never skips on the old picture)',
    calls >= 2 && firstRefused && cs.length === 1 && c.stamps.paypal > before && c.inputs.paypal.captureIds.includes(capId),
    `decide attempts ${calls} · stale decide refused ${firstRefused} · CHECK# ${cs.length} (${c?.decision}) · stamp paypal ${before}→${c?.stamps.paypal} (now ${stampNow}) · new capture in inputs ${c?.inputs.paypal.captureIds.includes(capId)} · ${fin.state}`);
});

// R4: one update effect dispatched by two workers at once → one PREPARED/DISPATCHED claim, one PUT.
await kase('R4', async () => {
  await approved('R4');
  setNow(TUE_0805);
  const slice = await actionOf('COLLECT_UNDISPUTED_SLICE');
  const contact = `due#${slice.actionId}#${slice.intentVersion}#CONTACT#0`;
  await run1(contact); // queue stage: QUEUED + effect READY + exec job (sent to our queue)
  const execId = queue.pending.find((x) => x.startsWith('exec#upd:'));
  queue.pending.length = 0;
  if (!execId) throw new Error(`no update job queued; slice ${(await actionOf('COLLECT_UNDISPUTED_SLICE')).state}`);
  const key = execId.slice('exec#'.length);
  const dup = `${execId}#dup`;
  await store.transact([putJobOp(newJob(dup, 'EXECUTE_EFFECT', key, clock(), TENANT, cur.runId))]);
  barrier = { match: (ops) => has(ops, (o) => o.op === 'update' && o.pk === K.effect(key) && o.sk === 'EFFECT'), waiting: [], n: 2, reached: 0 };
  const p0 = pp.count('PUT');
  await Promise.all([run1(execId), run1(dup)]);
  await drain();
  const e = await updEffect(key);
  const claims = (await audits('EffectDispatchClaimed')).filter((x) => x.refs?.effectKey === key).length;
  const fin = await actionOf('COLLECT_UNDISPUTED_SLICE');
  record('R4 double dispatch of one update effect → one claim, one PUT', pp.count('PUT') - p0 === 1 && claims === 1 && e?.state === 'VERIFIED_SUCCESS' && fin.state === 'APPLIED',
    `PUT ${pp.count('PUT') - p0} · dispatch claims ${claims} · effect ${e?.state} · refused TXs ${refused.length} · slice ${fin.state}`);
});

// R5: the owner pauses outreach between the check's calculation and its decide → HELD (paused), never dispatched after the pause.
await kase('R5', async () => {
  await onePayer('R5');
  let res: any = null;
  d.hooks!.beforeSkipDecide = async () => { if (res) return; const v = (await api('GET', '/v1/delegation')).body.version; res = await api('POST', '/v1/delegation/pauses', { kind: 'OUTREACH', on: true }, { 'if-match': String(v) }); };
  const p0 = pp.count('PUT');
  await check();
  await drain();
  const fin = await actionOf('DISCOUNT_FALLBACK');
  const dispatched = (await audits('EffectDispatchClaimed')).filter((x) => String(x.refs?.effectKey).includes('APPLY_DISCOUNT')).length;
  const decideRefused = refused.some((r) => has(r.ops, (o) => o.op === 'put' && skOf(o).startsWith('CHECK#')));
  record('R5 pause mid-check → HELD PAUSED, never dispatched after the pause', res?.status === 200 && pp.count('PUT') === p0 && dispatched === 0 && fin.state === 'HELD' && fin.holdCode === 'PAUSED',
    `pause ${res?.status} · decide on the pre-pause inputs refused ${decideRefused} · PUT +${pp.count('PUT') - p0} · discount dispatch claims ${dispatched} · offer ${fin.state} ${fin.holdCode ?? ''}`);
});

// R6: two answerMatch on one bank candidate with the same version → one new version.
await kase('R6', async () => {
  await world('R6');
  const t = (await api('GET', '/v1/reconciliation')).body.transfers?.[0];
  if (!t) throw new Error('no PayPal-transfer candidate in the seeded bank');
  const rs = await Promise.all(['TRANSFER', 'NOT_TRANSFER'].map((answer) => api('POST', `/v1/reconciliation/bank/${encodeURIComponent(t.bankTxId)}/answer`, { answer }, { 'if-match': String(t.version) })));
  const m = await store.get('core', pk(), `MATCH#${t.bankTxId}`);
  record('R6 two answerMatch → one version', rs.filter((x) => x.status === 200).length === 1 && m?.version === t.version + 1,
    `${rs.map((x) => `${x.status} ${x.body.code ?? x.body.answer}`).join(' / ')} · MATCH# v${m?.version} ${m?.answer}`);
});

/** R7–R9 share a shape: the SKIP world; something publishes between calculation and decide; the decide must be refused. */
async function fenced(name: string, label: string, inject: () => Promise<string>, expectAfter: (fin: Item, cs: Item[]) => boolean) {
  await bothPaid(name, true);
  const a = await actionOf('DISCOUNT_FALLBACK');
  let calls = 0, what = '';
  d.hooks!.beforeSkipDecide = async () => { if (calls++ === 0) what = await inject(); };
  await check();
  await advance(20_000);
  const fin = await actionOf('DISCOUNT_FALLBACK');
  const cs = await checks(a.actionId);
  const firstRefused = refused.find((r) => has(r.ops, (o) => o.op === 'put' && skOf(o).startsWith(`CHECK#${a.actionId}#`)));
  const failedAt = firstRefused ? firstRefused.ops.filter((_, i) => firstRefused.failed[i]).map((o) => `${o.table}:${skOf(o)}`).join(',') : '';
  record(`${name} ${label}`, calls >= 2 && !!firstRefused && cs.length <= 1 && expectAfter(fin, cs),
    `${what} · decide attempts ${calls} · stale decide refused on [${failedAt}] · CHECK# ${cs.map((c) => `${c.generation}:${c.decision}`).join(',') || 'none'} · offer ${fin.state}`);
}
await kase('R7', () => fenced('R7', 'refund published between calculation and decide → decide refused → re-run', async () => {
  const cap = (await items('ALLOC#'))[0]?.captureId ?? [...pp.captures.keys()][0];
  pp.rows.push({ transaction_id: `REF-${TAG}`, transaction_event_code: 'T1107', transaction_status: 'S', transaction_initiation_date: new Date(now - 60_000).toISOString().replace('.000', ''), transaction_amount: { currency_code: 'USD', value: '-100.00' }, paypal_reference_id: cap, available_balance: amt(pp.balance.availableMinor - 10_000) });
  pp.balance = { ...pp.balance, availableMinor: pp.balance.availableMinor - 10_000, asOf: clock() };
  const r = await observeBalance(d);
  const refunds = (await store.query('provider', K.conn(d.config.connectionId), { skPrefix: 'REFUND#' })).length;
  return `refund on ${cap} via PayPal's report (observe ${r.ok ? 'ok' : r.error}; REFUND# ${refunds})`;
}, (_fin, cs) => cs.length === 1));
await kase('R8', () => fenced('R8', 'lower bank balance published between calculation and decide → decide refused → re-run', async () => {
  const itemId = (await bindingOf(store, TENANT, cur.runId))!.itemId!;
  const it = plaid.items.get(itemId)!;
  for (const acct of it.accounts) if (acct.balances) { acct.balances.available = (acct.balances.available ?? 0) - 1000; acct.balances.current = (acct.balances.current ?? 0) - 1000; }
  const s0 = (await store.get('provider', K.plaid(itemId), 'FUNDS'))?.stamp ?? 0;
  let s1 = s0;
  for (let i = 0; i < 5 && s1 === s0; i++) { // a sync cycle may take more than one invocation (S2-PR-06)
    await requestRun(store, newJob(syncJobId(itemId), 'PLAID_SYNC', itemId, clock(), null, null), clock());
    await run1(syncJobId(itemId));
    s1 = (await store.get('provider', K.plaid(itemId), 'FUNDS'))?.stamp ?? 0;
  }
  return `bank sync published (bank FUNDS stamp ${s0}→${s1}, balance −$1,000)`;
}, (_fin, cs) => cs.length === 1));
await kase('R9', async () => {
  // (a) a competing update takes Mercer's UPDLOCK between calculation and decide → refused; while it holds the lock, no skip.
  let holder = '';
  await fenced('R9', 'competing update holds Mercer UPDLOCK between calculation and decide → decide refused; no skip while held', async () => {
    const inv = await invOf('cust-mercer');
    holder = `upd:races-${TAG}:1:APPLY_DISCOUNT`;
    await store.transact([{ op: 'put', table: 'work', item: { pk: lockPk(inv.invoiceId), sk: 'LOCK', invoiceId: inv.invoiceId, holder, version: 1 }, cond: { notExists: true } }]);
    return `UPDLOCK taken by a competing effect key (STUB holder ${holder})`;
  }, (fin, cs) => fin.state !== 'SKIPPED_NOT_NEEDED' && cs.every((c) => c.decision !== 'SKIP'));
  // While the lock is held, every decide is refused (it is fenced on a free lock), so no CHECK# (and no UPDATE_IN_FLIGHT hold) is
  // ever recorded and the check re-runs its PayPal refresh each round. Recorded as observed; then the lock is released.
  const a9 = await actionOf('DISCOUNT_FALLBACK');
  const lockDecides = refused.filter((r) => has(r.ops, (o) => o.op === 'put' && skOf(o).startsWith(`CHECK#${a9.actionId}#`))).length;
  const heldChecks = (await checks(a9.actionId)).length;
  const inv = await invOf('cust-mercer');
  await store.transact([{ op: 'update', table: 'work', pk: lockPk(inv.invoiceId), sk: 'LOCK', set: { holder: '' }, add: { version: 1 }, cond: { eq: { holder } } }]);
  await advance(20_000);
  await advance(20_000);
  const after = await checks(a9.actionId);
  const fin9 = await actionOf('DISCOUNT_FALLBACK');
  record('R9 after the competing update releases the lock, the check decides once on fresh inputs', after.length === 1 && fin9.state === 'SKIPPED_NOT_NEEDED',
    `while held: ${lockDecides} decide TXs refused, CHECK# ${heldChecks} (no UPDATE_IN_FLIGHT hold recorded) · after release: CHECK# ${after.map((c) => `${c.generation}:${c.decision}`).join(',')} · offer ${fin9.state}`);
  // (b) two update effects on one invoice prepared at once → one lock holder.
  await approved('R9b');
  setNow(TUE_0805);
  const slice = await actionOf('COLLECT_UNDISPUTED_SLICE');
  await run1(`due#${slice.actionId}#${slice.intentVersion}#CONTACT#0`);
  const execId = queue.pending.find((x) => x.startsWith('exec#upd:'))!;
  queue.pending.length = 0;
  const key = execId.slice('exec#'.length);
  const e = (await updEffect(key))!;
  // A second, STUB update effect on the same invoice (another key), READY with its own job: both race for UPDLOCK in prepare.
  const key2 = `upd:races-${TAG}-second:1:ENABLE_PARTIAL`;
  const { pk: _p, ...rest } = e;
  await store.transact([{ op: 'put', table: 'work', item: { ...rest, pk: K.effect(key2), effectKey: key2 }, cond: { notExists: true } }, putJobOp(newJob(`exec#${key2}`, 'EXECUTE_EFFECT', key2, clock(), TENANT, cur.runId))]);
  barrier = { match: (ops) => has(ops, (o) => (o.op === 'put' || o.op === 'update') && o.table === 'work' && String((o as any).pk ?? (o as any).item?.pk) === lockPk(e.invoiceId)), waiting: [], n: 2, reached: 0 };
  const p0 = pp.count('PUT');
  await Promise.all([run1(execId), run1(`exec#${key2}`)]);
  const lock = await store.get('work', lockPk(e.invoiceId), 'LOCK');
  const [s1, s2] = [(await updEffect(key))?.state, (await updEffect(key2))?.state];
  const prepared = [s1, s2].filter((s) => s !== 'READY').length;
  record('R9 (b) two update effects on one invoice → one UPDLOCK holder, one PUT', prepared === 1 && pp.count('PUT') - p0 === 1,
    `effects ${s1} / ${s2} (second is a STUB copy) · PUT ${pp.count('PUT') - p0} · lock holder now '${lock?.holder}' v${lock?.version}`);
});

// R10 (S5-PR-08): a check worker stops after the lock; before leaseUntil a second worker waits; after it, takes over at g+1;
// the first worker's late decide is refused on the generation fence.
await kase('R10', async () => {
  await bothPaid('R10');
  const a = await actionOf('DISCOUNT_FALLBACK');
  const jA = checkJobOf(a), jB = `due#${a.actionId}#${a.intentVersion}#CHECK#1`;
  await run1(jA); // run 1: lock g1 + evidence; requeued for run 2
  for (const q of queue.pending.splice(0)) if (q !== jA) await run1(q); // the bank read run 2 needs
  await store.transact([putJobOp(newJob(jB, 'ACTION_DUE', a.actionId, clock(), TENANT, cur.runId))]);
  await run1(jB);
  const waited = (await job(jB))?.lastError ?? '';
  let calls = 0;
  d.hooks!.beforeSkipDecide = async () => {
    if (calls++) return;
    // Worker A is "stopped" here (after the lock, before its decide). Past leaseUntil, worker B takes over.
    const cr = await store.get('core', pk(), `CHECKRUN#${a.actionId}`);
    now = Date.parse(cr!.leaseUntil) + 5_000;
    await requestRun(store, newJob(jB, 'ACTION_DUE', a.actionId, clock(), TENANT, cur.runId), clock());
    await run1(jB); // takeover (g2) + evidence
    for (const q of queue.pending.splice(0)) if (q !== jA) await run1(q);
    now += 20_000;
    await requestRun(store, newJob(jB, 'ACTION_DUE', a.actionId, clock(), TENANT, cur.runId), clock());
    await run1(jB); // B decides at g2
  };
  now += 20_000;
  await requestRun(store, newJob(jA, 'ACTION_DUE', a.actionId, clock(), TENANT, cur.runId), clock());
  for (const q of queue.pending.splice(0)) if (q !== jA && q !== jB) await run1(q); // the bank read run 2 needs
  await run1(jA); // A computes, then (hook) B takes over and decides; then A's decide is attempted
  const cs = await checks(a.actionId);
  const aRefused = refused.find((r) => has(r.ops, (o) => o.op === 'put' && skOf(o) === `CHECK#${a.actionId}#1`));
  const genFenced = !!aRefused && aRefused.failed[aRefused.ops.findIndex((o) => skOf(o) === `CHECKRUN#${a.actionId}`)];
  const took = (await audits('CheckLeaseTakenOver')).length;
  record('R10 lease takeover after leaseUntil at g+1; the stopped worker\'s decide is refused',
    /Another check/.test(waited) && took >= 1 && cs.length === 1 && cs[0].generation === 2 && genFenced,
    `before leaseUntil: "${waited}" · takeover audits ${took} · CHECK# ${cs.map((c) => `g${c.generation}:${c.decision}`).join(',')} · A's decide refused on CHECKRUN generation ${genFenced} · hook ${calls}`);
});

// R11 (S5-PR-03): revoke or pause between READY and the dispatch claim → no dispatch, the grant not consumed.
await kase('R11', async () => {
  for (const variant of ['pause', 'revoke'] as const) {
    await approved(`R11${variant[0]}`);
    setNow(TUE_0805);
    const slice = await actionOf('COLLECT_UNDISPUTED_SLICE');
    const grant = (await items('GRANT#')).find((g) => g.rootId === slice.rootId && g.state === 'ACTIVE');
    await run1(`due#${slice.actionId}#${slice.intentVersion}#CONTACT#0`);
    const execId = queue.pending.find((x) => x.startsWith('exec#upd:'))!;
    queue.pending.length = 0;
    const key = execId.slice('exec#'.length);
    let res: any = null;
    hooks.push({
      match: (ops) => has(ops, (o) => o.op === 'update' && o.pk === K.effect(key) && (o.set as any)?.state === 'DISPATCHED'),
      run: async () => {
        if (variant === 'pause') { const v = (await api('GET', '/v1/delegation')).body.version; res = await api('POST', '/v1/delegation/pauses', { kind: 'OUTREACH', on: true }, { 'if-match': String(v) }); }
        else res = grant ? await api('POST', `/v1/grants/${encodeURIComponent(grant.grantId)}/revoke`, { reason: 'races R11' }) : { status: 0, body: { code: 'no grant on the slice' } };
      },
    });
    const p0 = pp.count('PUT');
    await run1(execId);
    await drain();
    const g = grant ? await store.get('core', pk(), grant.sk) : undefined;
    const fin = await actionOf('COLLECT_UNDISPUTED_SLICE');
    const e = await updEffect(key);
    const claimRefused = refused.some((r) => has(r.ops, (o) => o.op === 'update' && o.pk === K.effect(key) && (o.set as any)?.state === 'DISPATCHED'));
    record(`R11 ${variant} between READY and the dispatch claim → no dispatch, grant not consumed`, res?.status === 200 && claimRefused && pp.count('PUT') === p0 && g?.state !== 'CONSUMED' && e?.state === 'READY',
      `${variant} ${res?.status} ${res?.body?.code ?? ''} · claim refused ${claimRefused} · PUT +${pp.count('PUT') - p0} · grant ${g?.state ?? 'none'} · effect ${e?.state} · slice ${fin.state} ${fin.holdCode ?? ''}`);
  }
});

// R12 (S5-PR-09): one inbound message taken in by two concurrent intakes → one MAIL#, one job set.
await kase('R12', async () => {
  await tue('R12');
  const outMsg = (await items('OUTMSG#')).find((o) => o.customerId === 'cust-pellow');
  if (!outMsg) throw new Error('Pellow reminder not sent');
  const mid = `<r.${TAG}@pellow.example>`;
  const raw = buildMessage({ from: 'accounts.pellow@example.com', to: [d.mail!.address], subject: 'Re: invoice', text: 'Thanks, we will look into it.', messageId: mid, inReplyTo: outMsg.rfcMessageId, references: [outMsg.rfcMessageId], date: clock() });
  await mailbox.inject({ raw: b64url.encode(raw), auth: { source: 'SIMULATED', dkim: 'pass', spf: 'pass', dmarc: 'pass' } });
  now += 61_000;
  const j0 = mailSyncJobId(cur.runId), j1 = `${j0}#dup`;
  await requestRun(store, newJob(j0, 'MAIL_SYNC', cur.runId, clock(), TENANT, cur.runId), clock());
  await store.transact([putJobOp(newJob(j1, 'MAIL_SYNC', cur.runId, clock(), TENANT, cur.runId))]);
  barrier = { match: (ops) => has(ops, (o) => o.op === 'put' && skOf(o).startsWith('MAIL#')), waiting: [], n: 2, reached: 0 };
  const errs: string[] = [];
  await Promise.all([j0, j1].map((j) => run1(j).catch((e) => errs.push((e as Error).message))));
  const mails = await items('MAIL#');
  const replyJobs = await Promise.all(mails.map((m) => job(`reply#${m.messageId}`)));
  const received = (await audits('MailReceived')).length;
  const mailRefused = refused.filter((r) => has(r.ops, (o) => o.op === 'put' && skOf(o).startsWith('MAIL#'))).length;
  record('R12 duplicate concurrent intake of one message → one MAIL#, one job set', mails.length === 1 && replyJobs.filter(Boolean).length === 1 && received === 1 && mailRefused === 1,
    `MAIL# ${mails.length} · reply jobs ${replyJobs.filter(Boolean).length} · MailReceived ${received} · intake TXs refused ${mailRefused}${errs.length ? ` · errors ${errs.join('; ')}` : ''}`);
});

// ---------- retire: this tenant's queued jobs (all runs of this script) so the dev sweep never runs them on the hero dates ----------
const left = (await dynamo.dueJobs('9999-12-31T00:00:00.000Z', 1000)).filter((j) => j.tenantId === TENANT || String(j.ref).startsWith('pp-races-s5-') || String(j.jobId).startsWith('obs#pp-races-s5-'));
let retired = 0;
for (const j of left) {
  try { await dynamo.transact([{ op: 'update', table: 'work', pk: j.pk, sk: 'JOB', set: { state: 'DONE', leaseUntil: null, lastError: 's5-races: retired at script end (test tenant)' }, remove: ['gsiDue', 'dueKey'], cond: { eq: { leaseToken: j.leaseToken, state: j.state } } }]); retired++; } catch { /* moved meanwhile */ }
}
// Jobs that carry no tenant (PLAID_SYNC, OBSERVE_BALANCE): retire those of this process's STUB Items and connections by ref.
for (const j of (await dynamo.dueJobs('9999-12-31T00:00:00.000Z', 1000)).filter((x) => !x.tenantId && allRefs.has(x.ref))) {
  try { await dynamo.transact([{ op: 'update', table: 'work', pk: j.pk, sk: 'JOB', set: { state: 'DONE', leaseUntil: null, lastError: 's5-races: retired at script end (STUB Item, hero-week clock)' }, remove: ['gsiDue', 'dueKey'], cond: { eq: { leaseToken: j.leaseToken, state: j.state } } }]); retired++; } catch { /* moved */ }
}
console.log(`${results.filter((r) => r.ok).length}/${results.length} PASS · retired ${retired} queued test-tenant jobs · FAKE PayPal/Plaid/reader, SIMULATED mailbox, template planner (no Bedrock, no real provider call)`);
const bad = results.filter((r) => !r.ok);
if (bad.length) console.log(`rerun just these: AWS_PROFILE=headroom-admin node scripts/live/s5-races.ts --out <newDir> --failed ${out ?? '<thisDir>'}`);
if (out) { mkdirSync(out, { recursive: true }); writeFileSync(join(out, 'results.json'), JSON.stringify({ at: new Date().toISOString(), tables: 'HeadroomDev-*', tenant: TENANT, tag: TAG, runs, results }, null, 2)); }
process.exit(bad.length ? 1 : 0);
