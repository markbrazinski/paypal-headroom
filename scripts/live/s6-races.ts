// S6 races on REAL DynamoDB (S06 §6.18: the four races where DynamoDB's conditional semantics decide). Each case runs the acceptance
// harness's hero flow on the dev tables with its own fresh PayPal connection id (`pp-race-<tag>-<case>`), so reservations and day
// charges never mix across cases or runs. FakePayPal (REPLAY, labelled): no real PayPal, Plaid, Gmail or Bedrock call. Test tenant
// `tenant-race-<tag>-<case>` (own tenant + owner per case, so cases run in parallel), script clock in the hero week, so the deployed sweep never treats these jobs as due.
//   AWS_PROFILE=headroom-admin node scripts/live/s6-races.ts [--only R1,R6] [--failed <prevDir>] [--out <dir>]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DynamoStore } from '../../backend/src/adapters/store/dynamodb.ts';
import { K } from '../../backend/src/adapters/store/keys.ts';
import type { Item, Store } from '../../backend/src/adapters/store/port.ts';
import { newJob, putJobOp } from '../../backend/src/jobs/lease.ts';
import { processJob } from '../../backend/src/jobs/worker.ts';
import { approved, FEES, pay, pk, report } from '../../tests/acceptance/s5-helpers.ts';
import { effects, FRI_0900, heroPaid, keller, resv } from '../../tests/acceptance/s6-helpers.ts';

process.env.AWS_PROFILE ??= 'headroom-admin';
process.env.AWS_REGION ??= 'us-east-1';
const arg = (n: string) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
const ALL = ['R1', 'R5', 'R6', 'R7'];
const prev = arg('--failed');
const wanted = arg('--only')?.split(',') ?? (prev ? [...new Set(JSON.parse(readFileSync(join(prev, 'results.json'), 'utf8')).filter((r: any) => !r.ok).map((r: any) => r.case))] as string[] : ALL);
const out = arg('--out') ?? `.private/headroom/evidence/S06/races-${new Date().toISOString().replace(/[:.]/g, '-')}`;
mkdirSync(out, { recursive: true });
const TAG = randomBytes(3).toString('hex');
const store = new DynamoStore({ core: 'HeadroomDev-core', work: 'HeadroomDev-work', provider: 'HeadroomDev-provider', audit: 'HeadroomDev-audit' });
const results: { case: string; ok: boolean; detail: string }[] = [];
/**
 * One tenant, owner and PayPal connection per case (parallel without sharing a run fence), and a store view whose due-job query returns
 * ONLY that case's jobs: the dev GSI holds every tenant's jobs, and a harness sweep must never run the real dev tenant's work with fakes.
 */
const itemOwner = new Map<string, string | null>();
const scopedStore = (T: string, conn: string): Store => ({
  get: (...a) => store.get(...a), query: (...a) => store.query(...a), transact: (ops) => store.transact(ops),
  dueJobs: async (now, limit) => {
    const mine: Item[] = [];
    for (const j of await store.dueJobs(now, 1000)) {
      if (j.tenantId === T || (!j.tenantId && j.ref === conn)) { mine.push(j); continue; }
      if (!j.tenantId && j.type === 'PLAID_SYNC') {
        if (!itemOwner.has(j.ref)) itemOwner.set(j.ref, (await store.get('provider', K.plaid(j.ref), 'ITEM'))?.tenantId ?? null);
        if (itemOwner.get(j.ref) === T) mine.push(j);
      }
    }
    return mine.slice(0, limit);
  },
});
const world = (c: string) => approved({ store: scopedStore(`tenant-race-${TAG}-${c}`, `pp-race-${TAG}-${c}`), connectionId: `pp-race-${TAG}-${c}`, tenantId: `tenant-race-${TAG}-${c}` });

/** Phase 1 of the PAY job for `ids`, then both evaluate at once (the race), then the payout settles. */
async function racePay(h: Awaited<ReturnType<typeof world>>['h'], ids: string[]) {
  await Promise.all(ids.map((id) => processJob(h.deps, id)));
  await h.advance(20_000);
  h.queue.pending.length = 0;
  await Promise.all(ids.map((id) => processJob(h.deps, id)));
}
async function toFriday(h: Awaited<ReturnType<typeof world>>['h']) {
  const p = await pay(h, 'cust-pellow', 760_000, FEES.pellow);
  const x = await pay(h, 'cust-harrow', 720_000, FEES.harrow);
  h.setNow(FRI_0900);
  report(h, [{ cap: p.cap, gross: 760_000, fee: FEES.pellow, number: p.inv.invoiceNumber }, { cap: x.cap, gross: 720_000, fee: FEES.harrow, number: x.inv.invoiceNumber }]);
  h.pp.payoutFloat = 1_500_000;
}

const CASES: Record<string, () => Promise<string>> = {
  /** AT-F07: ten PAY workers at once → one intent, one reservation, one POST. */
  async R1() {
    const { h } = await world('R1');
    await toFriday(h);
    const a = await keller(h);
    const ids = Array.from({ length: 10 }, (_, i) => `due#${a.actionId}#${a.intentVersion}#PAY#${i === 0 ? 0 : 100 + i}`);
    await h.store.transact(ids.slice(1).map((id) => putJobOp(newJob(id, 'ACTION_DUE', a.actionId, FRI_0900, h.tenantId, h.run!.runId))));
    await racePay(h, ids);
    for (let i = 0; i < 4; i++) await h.advance(30_000);
    const r = await resv(h);
    const e = await effects(h);
    if (r.length !== 1 || h.pp.count('POST payout') !== 1 || e[0]?.state !== 'PAID') throw new Error(`reservations ${r.length}, POSTs ${h.pp.count('POST payout')}, state ${e[0]?.state}`);
    return 'one intent, one reservation, one POST, PAID';
  },
  /** Pause committed against the dispatch claim: either the claim lost (HELD_READY, zero POST) or it won before the pause; never a POST after a pause the claim saw. */
  async R5() {
    const { h } = await world('R5');
    let pausedAt = 0;
    h.deps.hooks!.beforePayoutClaim = async () => {
      h.deps.hooks!.beforePayoutClaim = undefined;
      const pol = await h.store.get('core', pk(h), 'POLICY');
      await Promise.all([h.api('POST', '/v1/delegation/pauses', { kind: 'PAYMENTS', on: true }, { 'if-match': String(pol!.version) }).then(() => { pausedAt = h.pp.count('POST payout'); })]);
    };
    await heroPaid(h, { stop: 'afterPost' });
    const [e] = await effects(h);
    if (e.state === 'HELD_READY' && h.pp.count('POST payout') === 0) return 'pause won: HELD_READY, zero POST';
    if (pausedAt === 0 && h.pp.count('POST payout') === 1) return `claim won before the pause: ${e.state}, one POST`;
    throw new Error(`state ${e.state}, POSTs ${h.pp.count('POST payout')}`);
  },
  /** Two dispatch claims of one READY effect at once → exactly one DISPATCHED and one POST. */
  async R6() {
    const { h } = await world('R6');
    await toFriday(h);
    let key = '';
    h.deps.hooks!.beforePayoutClaim = async (k) => { key = k; };
    const a = await keller(h);
    await Promise.all([processJob(h.deps, `due#${a.actionId}#${a.intentVersion}#PAY#0`)]);
    await h.advance(20_000); // evaluate → queue; the exec job runs its claim here
    // Force a second, simultaneous claim attempt on the same effect through a second job id.
    if (!key) throw new Error('no effect queued');
    const e0 = (await effects(h))[0];
    if (e0.state === 'READY') {
      await h.store.transact([putJobOp(newJob(`exec2#${key}`, 'EXECUTE_EFFECT', key, FRI_0900, h.tenantId, h.run!.runId))]);
      await Promise.all([processJob(h.deps, `exec#${key}`), processJob(h.deps, `exec2#${key}`)]);
    }
    for (let i = 0; i < 4; i++) await h.advance(30_000);
    if (h.pp.count('POST payout') !== 1 || h.pp.payouts.size !== 1) throw new Error(`POSTs ${h.pp.count('POST payout')}`);
    return `one claim won, one POST, state ${(await effects(h))[0].state}`;
  },
  /** Two verifiers record the same item SUCCESS at once → one PPREF#PAYOUTITEM, one PAID, debit settled once. */
  async R7() {
    const { h } = await world('R7');
    h.pp.payoutScript = ['SUCCESS'];
    await heroPaid(h, { stop: 'afterPost' });
    const [e] = await effects(h);
    if (e.state !== 'SUBMITTED') throw new Error(`expected SUBMITTED, got ${e.state}`);
    await h.store.transact([putJobOp(newJob(`verify2#${e.effectKey}`, 'RECONCILE_EFFECT', e.effectKey, h.clock(), h.tenantId, h.run!.runId))]);
    await h.advance(10_000);
    await Promise.all([processJob(h.deps, `exec#${e.effectKey}`), processJob(h.deps, `verify2#${e.effectKey}`)]);
    await h.drain();
    const [e2] = await effects(h);
    const [r] = await resv(h);
    const ref = await h.store.get('provider', `PPREF#PAYOUTITEM#${e2.itemId}`, 'REF');
    if (e2.state !== 'PAID' || r.state !== 'SETTLED' || !ref || ref.effectKey !== e2.effectKey) throw new Error(`state ${e2.state}, resv ${r.state}, ref ${!!ref}`);
    return 'one PAID, one PPREF, reservation SETTLED once';
  },
};

for (const c of wanted.filter((x) => CASES[x])) {
  const t0 = Date.now();
  try { results.push({ case: c, ok: true, detail: await CASES[c]() }); }
  catch (e) { results.push({ case: c, ok: false, detail: String((e as Error).stack ?? e).slice(0, 500) }); }
  const r = results[results.length - 1];
  console.log(`${r.ok ? 'PASS' : 'FAIL'} ${c} (${Math.round((Date.now() - t0) / 1000)} s) · ${r.detail}`);
}
// Retire this run's leftover jobs (hero-week clock): the deployed sweep must never run them on those dates.
let retired = 0;
for (const j of await store.dueJobs('9999-12-31T00:00:00.000Z', 1000)) {
  const mine = String(j.tenantId ?? '').startsWith(`tenant-race-${TAG}-`) || String(j.ref).startsWith(`pp-race-${TAG}-`) || String(itemOwner.get(j.ref) ?? '').startsWith(`tenant-race-${TAG}-`);
  if (!mine) continue;
  try { await store.transact([{ op: 'update', table: 'work', pk: j.pk, sk: 'JOB', set: { state: 'DONE', leaseUntil: null, lastError: 's6-races: retired at script end (test tenant)' }, remove: ['gsiDue', 'dueKey'], cond: { eq: { leaseToken: j.leaseToken, state: j.state } } }]); retired++; } catch { /* moved */ }
}
console.log(`retired ${retired} leftover jobs of tag ${TAG}`);
writeFileSync(join(out, 'results.json'), JSON.stringify(results, null, 2));
console.log(`${results.filter((r) => r.ok).length}/${results.length} · tag ${TAG} · evidence ${out}${results.some((r) => !r.ok) ? `\nrerun: node scripts/live/s6-races.ts --failed ${out}` : ''}`);
