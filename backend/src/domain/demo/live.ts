// Judge dock (owner, 4 Nov 2026): one shared live run on the review merchant. Judges sign in to the recorded run; choosing Live takes
// this run when it is fresh (no reset, no wait). 10 minutes after its holder goes quiet it resets by itself (operator Lambda, every
// 5 min), so the next judge finds a fresh run, or an honest "resetting, expected about …". The reset itself is reset.ts, unchanged.
import { K } from '../../adapters/store/keys.ts';
import { TxCancelled } from '../../adapters/store/port.ts';
import type { Deps } from '../../deps.ts';
import { activeRun, type RunItem } from '../identity-run/run.ts';
import { addMs, MIN } from '../time.ts';
import { AUTO_HOLDER, leaseExpired, leaseOf, type Lease } from './lease.ts';
import { requestStart, RESET_STATES_DONE, type ResetRecord } from './reset.ts';

/** Every judge login maps to this business (scripts/dev/setup.ts, review). */
export const LIVE_TENANT = 'tenant-live';
// ponytail: a constant from the measured report lag (3–5 h, 3 Nov 2026). Upgrade: derive from the report's as-of lag.
export const RESET_ETA_MS = 5 * 60 * MIN;
const BUMP_MS = MIN;
/**
 * Blocks a later try can clear with nothing left in flight at PayPal: money not yet released (refused, nothing sent), the report
 * late, a housekeeping item returned, the lease moved. 30 minutes after one, the live run starts its reset again by itself
 * (requestStart still refuses while a housekeeping item is unsettled). The rest (below the opening, abandoned) need the operator.
 */
const RETRYABLE = ['HOUSEKEEPING_REFUSED', 'RAIL_REPORT_LATE', 'HOUSEKEEPING_FAILED', 'LEASE_MOVED'];
export const RETRY_MS = 30 * MIN;
const retryAt = (r: ResetRecord) => (r.state === 'BLOCKED' && r.tenantId === LIVE_TENANT && RETRYABLE.includes(r.blocker?.code ?? '') ? addMs(r.updatedAt, RETRY_MS) : null);

export type LiveState = 'READY' | 'MINE' | 'IN_USE' | 'RESETTING' | 'BLOCKED';
export interface Live { state: LiveState; text: string | null; readyAt: string | null }

const resetOf = async (d: Deps, l: Lease | undefined) => (l?.resetSk ? ((await d.store.get('provider', K.conn(d.config.connectionId), l.resetSk)) as ResetRecord | undefined) : undefined);
/** Fresh = seeded and untouched: Keller's bill (the first beat) hasn't come in. */
const fresh = async (d: Deps, run: RunItem | undefined) => !!run && (await d.store.query('core', K.run(run.tenantId, run.runId), { skPrefix: 'BILL#' })).length === 0;
const eta = (r: ResetRecord, now: string) => {
  const est = ['RETURNING', 'SEEDING'].includes(r.state) ? addMs(now, 10 * MIN) : addMs(r.createdAt, RESET_ETA_MS);
  return est > addMs(now, 15 * MIN) ? est : addMs(now, 15 * MIN); // past the estimate: "any time now", never a time already gone
};

/** Pure-ish read: what the dock shows for `sub` on `tenantId`. */
export async function liveOf(d: Deps, tenantId: string, sub: string): Promise<Live> {
  const now = d.now();
  const l = await leaseOf(d.store, d.config.connectionId);
  if (!l?.leased) return { state: 'READY', text: null, readyAt: null }; // dev: no lease, the stage's own run is live
  const rec = await resetOf(d, l);
  const run = await activeRun(d.store, tenantId);
  const ours = l.tenantId === tenantId && !!run && l.runId === run.runId;
  const expired = !l.tenantId || leaseExpired(l, now);
  // The operator has the merchant for another business (e.g. the showcase): the live run waits; nothing here takes it over.
  if (l.tenantId && l.tenantId !== tenantId) return { state: 'BLOCKED', text: 'The operator is using the sandbox merchant right now. The live run comes back when they finish.', readyAt: null };
  if (rec && !RESET_STATES_DONE.includes(rec.state)) return { state: 'RESETTING', text: rec.waiting, readyAt: eta(rec, now) };
  if (ours && l.holderSub === sub && !expired) return { state: 'MINE', text: null, readyAt: null };
  if (l.tenantId && l.holderSub && l.holderSub !== sub && l.holderSub !== AUTO_HOLDER && !expired)
    return { state: 'IN_USE', text: 'Another judge is using the live run. It resets by itself 10 minutes after their last activity.', readyAt: null };
  if (ours && (await fresh(d, run))) return { state: 'READY', text: null, readyAt: null };
  const retry = rec && retryAt(rec);
  if (retry) return { state: 'RESETTING', text: `The last reset stopped (${rec!.blocker!.text}); it tries again by itself`, readyAt: [addMs(retry, 15 * MIN), addMs(now, 15 * MIN)].sort().at(-1)! };
  if (rec?.state === 'BLOCKED') return { state: 'BLOCKED', text: `The live run needs the operator: ${rec.blocker?.text ?? 'the last reset stopped'}`, readyAt: null };
  return { state: 'RESETTING', text: 'Starting a reset of the previous run', readyAt: addMs(now, RESET_ETA_MS) };
}

/** Choosing Live: take the fresh run (holder moves to this judge, no reset), or keep the one already held. */
export async function takeLive(d: Deps, tenantId: string, sub: string): Promise<{ ok: true } | { ok: false; code: 'MERCHANT_LEASED' | 'RESET_IN_PROGRESS'; text: string }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const live = await liveOf(d, tenantId, sub);
    if (live.state === 'MINE' || (live.state === 'READY' && !(await leaseOf(d.store, d.config.connectionId))?.leased)) return { ok: true };
    if (live.state === 'IN_USE') return { ok: false, code: 'MERCHANT_LEASED', text: live.text! };
    if (live.state !== 'READY') return { ok: false, code: 'RESET_IN_PROGRESS', text: live.text ?? 'The live run is resetting' };
    const l = (await leaseOf(d.store, d.config.connectionId))!;
    const now = d.now();
    try {
      // Same version/claims fence as a Start: a concurrent take or Start makes one of them re-read.
      await d.store.transact([{ op: 'update', table: 'provider', pk: K.conn(d.config.connectionId), sk: 'TENANT', set: { holderSub: sub, leasedAt: now, lastActiveAt: now, version: (l.version ?? 0) + 1 }, cond: { eq: { version: l.version, claims: l.claims ?? 0 } } }]);
      return { ok: true };
    } catch (e) { if (!(e instanceof TxCancelled)) throw e; }
  }
  return { ok: false, code: 'MERCHANT_LEASED', text: 'Another judge just took the live run' };
}

/** The holder's dock is open: keep the lease alive (at most once a minute; the 10-minute idle clock restarts). */
export async function bumpLive(d: Deps, sub: string) {
  const l = await leaseOf(d.store, d.config.connectionId);
  const now = d.now();
  if (!l?.leased || l.holderSub !== sub || leaseExpired(l, now) || Date.parse(now) - Date.parse(l.lastActiveAt ?? '1970-01-01T00:00:00Z') < BUMP_MS) return;
  await d.store.transact([{ op: 'update', table: 'provider', pk: K.conn(d.config.connectionId), sk: 'TENANT', set: { lastActiveAt: now }, cond: { eq: { holderSub: sub, runId: l.runId ?? null } } }]).catch(() => {});
}

/**
 * Operator Lambda, every 5 minutes: an idle, used live run starts its reset; a fresh one waits as it is. It never takes the merchant
 * from another business (the operator's showcase) unless the operator asks (`takeOver`, e.g. the first live run on a stage).
 */
export async function autoReset(d: Deps, o: { takeOver?: boolean } = {}): Promise<string> {
  const l = await leaseOf(d.store, d.config.connectionId);
  if (!l?.leased) return 'no lease on this stage';
  const rec = await resetOf(d, l);
  if (rec && !RESET_STATES_DONE.includes(rec.state)) return `resetting (${rec.state})`;
  if (rec?.state === 'BLOCKED' && rec.tenantId === LIVE_TENANT && !l.runId) {
    const at = retryAt(rec);
    if (!at) return `blocked: ${rec.blocker?.code}`; // the operator steps in
    if (d.now() < at) return `blocked: ${rec.blocker?.code}; retry at ${at}`;
    const s = await requestStart(d, { tenantId: LIVE_TENANT, holderSub: AUTO_HOLDER, reason: `Automatic retry after ${rec.blocker?.code}` });
    return s.ok ? `retry started ${s.resetKey}` : `not yet: ${s.text}`;
  }
  if (l.tenantId && l.tenantId !== LIVE_TENANT && !o.takeOver) return `held for ${l.tenantId}`;
  if (l.tenantId && l.holderSub !== AUTO_HOLDER && !leaseExpired(l, d.now())) return 'in use';
  const run = await activeRun(d.store, LIVE_TENANT);
  if (l.tenantId === LIVE_TENANT && run && l.runId === run.runId && (await fresh(d, run))) return 'ready';
  const s = await requestStart(d, { tenantId: LIVE_TENANT, holderSub: AUTO_HOLDER, reason: 'Automatic reset: the live run was idle for 10 minutes' });
  return s.ok ? `reset started ${s.resetKey}` : `not yet: ${s.text}`;
}
