// PLAID_SYNC (S02 T3): ITEM_GET → SYNC (staged, invisible) → PUBLISH (one TX) → BALANCE. One job per Item = one lease.
// Every authoritative write carries the lease (via the job op) AND ITEM {generation = g0, state ∈ active}: a sync paused
// across a Disconnect, removal or reconnect can't write STATUS ok, an observation or the ITEM (S2-PR-03).
// Time-budgeted: a call starts only if it fits; otherwise progress is saved and the job continues later (S2-PR-06).
import { randomUUID } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { assertTransition, BANK_ACTIVE_STATES, PlaidBalanceGet, PlaidItemGet, PlaidSyncPage } from '@headroom/contracts';
import { fundsBumpOp, K } from '../../adapters/store/keys.ts';
import { TxCancelled, type Op } from '../../adapters/store/port.ts';
import { grantStopped, NoResponse, type HttpResult } from '../../adapters/grant.ts';
import { unseal } from '../../adapters/vault.ts';
import type { Deps } from '../../deps.ts';
import { auditOp } from '../audit/audit.ts';
import { backoff, finishOp, requeueRecurring, type Finish, type Lease, type SyncCycle } from '../../jobs/lease.ts';
import { LeaseLost } from '../executor/invoice-issue.ts';
import { retainGet } from '../paypal-mirror/evidence.ts';
import { addMs, HOUR, MIN, DAY } from '../time.ts';

const usd = (minor: number) => `$${(minor / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
import { bankReadyOp, getRun, readinessOp } from '../identity-run/run.ts';
import { applySync, classifyError, decodeProjection, toObservation } from './bank.ts';
import { connOf, type ConnItem } from './connect.ts';

export interface Budget { deadline: number; elapsed: () => number }
export const SYNC_TIMEOUT_MS = 10_000;
export const BALANCE_TIMEOUT_MS = 20_000;
export const MAX_STAGED_PAGES = 40; // 20,000 transactions per update cycle: the supported maximum (S2-R20)
export const MAX_RESTARTS = 5;
const MAX_PROJECTION_GZ = 350_000; // ponytail: single-item projection, ~400 KB ceiling; upgrade is an S3 object + pointer commit
export const SYNC_EVERY_MS = HOUR; // ponytail: real-time balance hourly; production would read cached /accounts/get on schedule
const fits = (b: Budget, timeoutMs: number) => b.deadline - b.elapsed() >= timeoutMs + 2_000;

export type StatusItem = { lastAttemptAt: string; ok: boolean; lastError: string | null; lastGoodRetrievedAt: string | null };
type Txns = { cursor: string; projectionGz: string; version: number; updateStatus: string | null; syncedAt: string };

const gz = (v: unknown) => gzipSync(JSON.stringify(v)).toString('base64');

async function call(fn: () => Promise<HttpResult>): Promise<HttpResult | undefined> {
  try { return await fn(); } catch (e) { if (e instanceof NoResponse) return undefined; throw e; }
}

export async function syncBank(d: Deps, l: Lease, b: Budget): Promise<void> {
  const conn = await connOf(d.store, l.job.ref);
  if (!conn || !BANK_ACTIVE_STATES.includes(conn.state)) return d.store.transact([finishOp(l, { kind: 'done' })]);
  const run = await getRun(d.store, conn.tenantId, conn.runId);
  if (!run || run.state === 'SEALED') return d.store.transact([finishOp(l, { kind: 'done' })]); // sealed runs keep their evidence, unpolled
  const pk = conn.pk;
  const g0 = conn.generation;
  const fenceCond = { eq: { generation: g0 }, in: { state: BANK_ACTIVE_STATES } };
  const fence: Op = { op: 'check', table: 'provider', pk, sk: 'ITEM', cond: fenceCond };
  const jobProgress = (cycle: SyncCycle | null): Op => ({ op: 'update', table: 'work', pk: K.job(l.jobId), sk: 'JOB', set: { cycle }, cond: { eq: { leaseToken: l.token, state: 'LEASED' } } });
  const au = (type: Parameters<typeof auditOp>[0]['type'], result: string, refs: Record<string, string> = {}) =>
    auditOp({ tenantId: conn.tenantId, runId: conn.runId, type, by: 'HEADROOM', allowedBy: conn.basis === 'SEEDED' ? 'Operator: sandbox reset (SEEDED bank)' : 'Owner: Connect bank', result, refs: { itemId: conn.itemId, ...refs }, correlationId: `sync:${conn.itemId}:${d.now()}`, now: d.now() });

  /** A fenced commit that also finishes/requeues the job (honouring a Refresh accepted meanwhile). */
  const commit = async (phase: 'stage' | 'publish' | 'balance' | 'error', ops: Op[], f: Finish | null) => {
    await d.hooks?.beforeBankCommit?.(phase);
    try {
      if (!f) await d.store.transact(ops);
      else if (f.kind === 'requeue') await requeueRecurring(d.store, l, f, ops);
      else await d.store.transact([...ops, finishOp(l, f)]);
    } catch (e) {
      if (e instanceof TxCancelled) throw new LeaseLost(`bank ${phase} commit refused (lease lost or connection changed)`);
      throw e;
    }
  };
  const status = async () => (await d.store.get('provider', pk, 'STATUS')) as StatusItem | undefined;
  /** A visible "can't sync" state that changes no connection state; audited only when its text changes. */
  const visible = async (message: string, at: string, cycle: SyncCycle | null, resetAttempts = true) => {
    const prev = await status();
    await commit('error', [fence,
      { op: 'put', table: 'provider', item: { pk, sk: 'STATUS', lastAttemptAt: d.now(), ok: false, lastError: message, lastGoodRetrievedAt: prev?.lastGoodRetrievedAt ?? null } },
      ...(prev?.lastError === message ? [] : [au('BankObservationFailed', message)]),
    ], { kind: 'requeue', at, error: message, resetAttempts, set: { cycle } });
  };
  const continuation = (cycle: SyncCycle | null) => commit('stage', [fence], { kind: 'requeue', at: d.now(), error: null, set: { cycle } });

  // Gate: the Plaid grant/budget. The job waits an hour; the read model shows "Bank not being checked".
  const stopped = await grantStopped(d.store, d.config.grant, 'plaid', 'calls', d.now());
  if (stopped) {
    const msg = `Bank not being checked: ${stopped}`;
    return commit('error', [fence, ...(l.job.lastError === msg ? [] : [au(stopped.includes('budget') ? 'PlaidCallBudgetReached' : 'BankObservationFailed', msg)])], { kind: 'requeue', at: addMs(d.now(), HOUR), error: msg, resetAttempts: true });
  }
  // Failures before any provider call are still visible bank states (S2-IM-02): fenced STATUS, audited on change, last good kept.
  if (!d.plaid?.reader || !d.vault) return visible('Bank not being read: the bank connection is not configured in this environment', addMs(d.now(), HOUR), l.job.cycle ?? null);
  let token: string;
  try { token = await unseal(d.vault, conn.sealedAccessToken!); }
  catch { return visible("Couldn't read the bank: Headroom's key service is unavailable · retrying", backoff(d.now(), l.job.attempts), l.job.cycle ?? null, false); }

  /** Provider errors (any call): fenced like every other write (S02 T3.8). */
  const providerError = async (r: HttpResult | undefined, cycle: SyncCycle | null) => {
    const k = classifyError(r ? r.status : null, r?.body);
    if (k.kind === 'LOGIN_REQUIRED' || k.kind === 'REVOKED') {
      const to = k.kind === 'LOGIN_REQUIRED' ? 'RECONNECT_REQUIRED' : 'REVOKED';
      const prev = await status();
      const ops: Op[] = [{ op: 'put', table: 'provider', item: { pk, sk: 'STATUS', lastAttemptAt: d.now(), ok: false, lastError: k.message, lastGoodRetrievedAt: prev?.lastGoodRetrievedAt ?? null } }];
      if (conn.state === to) ops.unshift(fence);
      else {
        assertTransition('BankConnection', conn.state, to);
        ops.unshift({ op: 'update', table: 'provider', pk, sk: 'ITEM', set: { state: to, itemError: k.code, version: conn.version + 1 }, cond: fenceCond });
        ops.push(au('BankHealthChanged', to === 'RECONNECT_REQUIRED' ? `Bank needs reconnecting (${k.code}); last figures kept, not fresh` : `Bank connection ended (${k.code}); last figures kept, not counted`, { code: k.code }));
      }
      // The sync never writes DISCONNECTED: that belongs to BANK_REMOVE only.
      return commit('error', ops, to === 'REVOKED' ? { kind: 'done' } : { kind: 'requeue', at: addMs(d.now(), SYNC_EVERY_MS), error: k.message, resetAttempts: true, set: { cycle: null } });
    }
    const prev = await status();
    const msg = `Couldn't reach the bank (${k.message})`;
    return commit('error', [fence,
      { op: 'put', table: 'provider', item: { pk, sk: 'STATUS', lastAttemptAt: d.now(), ok: false, lastError: msg, lastGoodRetrievedAt: prev?.lastGoodRetrievedAt ?? null } },
      ...(prev?.lastError === msg ? [] : [au('BankObservationFailed', msg, { code: k.code })]),
    ], { kind: 'requeue', at: backoff(d.now(), l.job.attempts), error: msg, set: { cycle } }); // capped at 15 min, never DEAD
  };

  const txns = (await d.store.get('provider', pk, 'TXNS')) as (Txns & { pk: string }) | undefined;
  const c0 = txns?.cursor ?? '';
  const fresh = (base: Partial<SyncCycle> = {}): SyncCycle => ({ id: randomUUID().slice(0, 8), phase: 'SYNC', c0, cursor: c0, stagedPages: 0, restarts: 0, updateStatus: null, institutionDataAsOf: null, consentExpiresAt: null, ...base });
  let cycle = l.job.cycle ?? null;

  // 1. ITEM_GET
  if (!cycle) {
    if (!fits(b, SYNC_TIMEOUT_MS)) return continuation(null);
    const r = await call(() => d.plaid!.reader!.itemGet(token));
    if (r?.status === 200) await retainGet(d.store, pk, 'item/get', r, d.now());
    const ig = r?.status === 200 ? PlaidItemGet.safeParse(r.body) : null;
    if (!ig?.success) return providerError(r, null);
    if (ig.data.item.error) return providerError({ ...r!, status: 400, body: ig.data.item.error }, null);
    cycle = fresh({ institutionDataAsOf: ig.data.status?.transactions?.last_successful_update ?? null, consentExpiresAt: ig.data.item.consent_expiration_time ?? null });
  }

  // 2. SYNC: each page retained raw and staged (invisible to reads), lease- and generation-fenced.
  while (cycle.phase === 'SYNC') {
    if (cycle.stagedPages >= MAX_STAGED_PAGES) return visible('Bank history too large for this build', addMs(d.now(), HOUR), null);
    if (!fits(b, SYNC_TIMEOUT_MS)) return continuation(cycle);
    const cur: SyncCycle = cycle;
    const r = await call(() => d.plaid!.reader!.sync(token, cur.cursor, 500));
    const p = r?.status === 200 ? PlaidSyncPage.safeParse(r.body) : null;
    if (p?.success) {
      const sha = await retainGet(d.store, pk, 'transactions/sync page', r!, d.now());
      const next: SyncCycle = { ...cycle, cursor: p.data.next_cursor, stagedPages: cycle.stagedPages + 1, updateStatus: p.data.transactions_update_status ?? null, phase: p.data.has_more ? 'SYNC' : 'PUBLISH' };
      await commit('stage', [fence, jobProgress(next), {
        op: 'put', table: 'provider',
        item: { pk, sk: `STAGE#${cycle.id}#${String(cycle.stagedPages).padStart(3, '0')}`, pageGz: gz({ added: p.data.added, modified: p.data.modified, removed: p.data.removed }), sha256: sha, ttl: Math.floor((Date.parse(d.now()) + 7 * DAY) / 1000) },
      }], null);
      cycle = next;
      continue;
    }
    const k = r && r.status !== 200 ? classifyError(r.status, r.body) : null;
    if (k?.kind === 'MUTATION') {
      // Abandon the stage (ignored, TTL-deleted) and restart from c0, the cursor at the start of the update cycle (S2-R6).
      if (cycle.restarts >= MAX_RESTARTS) return visible('Bank data is changing too fast to sync · retrying in 15 min', addMs(d.now(), 15 * MIN), null);
      cycle = fresh({ restarts: cycle.restarts + 1, institutionDataAsOf: cycle.institutionDataAsOf, consentExpiresAt: cycle.consentExpiresAt });
      continue;
    }
    if (r?.status === 200 && !p?.success) return providerError(undefined, cycle);
    return providerError(r, cycle); // rate limit / transient keep the stage; nothing is published (S2-R8)
  }

  // 3–5. PUBLISH the whole update cycle in one TX: projection + cursor + change batch, or nothing.
  if (cycle.phase === 'PUBLISH') {
    const staged = await d.store.query('provider', pk, { skPrefix: `STAGE#${cycle.id}#` });
    let pages: { added: any[]; modified: any[]; removed: any[] }[] | null = null;
    try { pages = staged.length === cycle.stagedPages ? staged.map((s) => JSON.parse(gunzipSync(Buffer.from(s.pageGz, 'base64')).toString('utf8'))) : null; } catch { pages = null; }
    if (!pages) return continuation(fresh({ institutionDataAsOf: cycle.institutionDataAsOf, consentExpiresAt: cycle.consentExpiresAt })); // unreadable stage → c0
    const now = d.now();
    const { projection, changes } = applySync(decodeProjection(txns), pages, now);
    const projectionGz = gz(projection);
    if (projectionGz.length > MAX_PROJECTION_GZ) return visible('Bank history too large for this build', addMs(now, HOUR), null);
    const v0 = txns?.version ?? 0;
    const counts = { added: changes.filter((c) => c.change === 'added').length, modified: changes.filter((c) => c.change === 'modified').length, removed: changes.filter((c) => c.change === 'removed').length };
    const next: SyncCycle = { ...cycle, phase: 'BALANCE' };
    await commit('publish', [fence, jobProgress(next),
      { op: 'put', table: 'provider', item: { pk, sk: 'TXNS', cursor: cycle.cursor, projectionGz, version: v0 + 1, updateStatus: cycle.updateStatus, syncedAt: now }, cond: txns ? { eq: { version: v0 } } : { notExists: true } },
      fundsBumpOp(pk),
      { op: 'put', table: 'provider', item: { pk, sk: `SYNC#${now}#${cycle.id}`, cursorBefore: cycle.c0, cursorAfter: cycle.cursor, changesGz: gz(changes), counts, pageSha256: staged.map((s) => s.sha256) }, cond: { notExists: true } },
      ...(changes.length ? [au('BankTransactionsSynced', `Bank activity synced: ${counts.added} added, ${counts.modified} changed, ${counts.removed} removed (explains balances; never added to them)`)] : []),
    ], null);
    cycle = next;
  }

  // 7. BALANCE: one real-time read; the observation, account list, STATUS ok and ITEM move together, fenced.
  // While history loads the job cycles every minute; a real-time read under 15 min old is not repeated (S2-IR-15).
  if (cycle.updateStatus !== 'HISTORICAL_UPDATE_COMPLETE') {
    const last = (await d.store.query('provider', pk, { skPrefix: 'OBS#', newestFirst: true, limit: 1 }))[0];
    if (last && Date.parse(d.now()) - Date.parse(last.retrievedAt) < 15 * MIN) return commit('balance', [fence], { kind: 'requeue', at: addMs(d.now(), MIN), error: null, resetAttempts: true, set: { cycle: null } });
  }
  if (!fits(b, BALANCE_TIMEOUT_MS)) return continuation(cycle);
  const r = await call(() => d.plaid!.reader!.balance(token));
  const bal = r?.status === 200 ? PlaidBalanceGet.safeParse(r.body) : null;
  if (!bal?.success) return providerError(r?.status === 200 ? undefined : r, cycle);
  const retrievedAt = d.now();
  const sha = await retainGet(d.store, pk, 'accounts/balance/get', r!, retrievedAt);
  const obs = toObservation(conn.itemId, bal.data.accounts, retrievedAt, sha);
  const prevAccts = ((await d.store.get('provider', pk, 'ACCOUNTS'))?.accounts ?? []) as { accountId: string; notReturned: boolean }[];
  const returned = new Set(obs.accounts.map((a) => a.accountId));
  const accounts = [...obs.accounts.map((a) => ({ accountId: a.accountId, notReturned: false })), ...prevAccts.filter((a) => !returned.has(a.accountId)).map((a) => ({ ...a, notReturned: true }))];
  const historyComplete = cycle.updateStatus === 'HISTORICAL_UPDATE_COMPLETE';
  const itemSet: Record<string, unknown> = { institutionDataAsOf: cycle.institutionDataAsOf, consentExpiresAt: cycle.consentExpiresAt, itemError: null, version: conn.version + 1 };
  const extra: Op[] = [];
  if (conn.state !== 'HEALTHY') {
    assertTransition('BankConnection', conn.state, 'HEALTHY');
    itemSet.state = 'HEALTHY';
    if (conn.state === 'RECONNECT_REQUIRED') { itemSet.generation = g0 + 1; extra.push(au('BankReconnected', 'Bank reconnected; figures fresh again')); }
  }
  const ready = run.bankSeed && conn.basis === 'SEEDED' && historyComplete ? bankReadyOp(run) : null;
  if (ready) extra.push(ready, au('RunReadinessChanged', !run.pendingBlockers ? 'Seeded bank ready (history complete, balances observed); waiting for the PayPal read'
    : `Run ${run.pendingBlockers.length ? 'BLOCKED' : 'READY'}: seeded bank read (history complete, balances observed)${run.pendingBlockers.length ? `; ${run.pendingBlockers.join('; ')}` : ''}`));
  const counted = obs.accounts.filter((a) => a.type === 'depository' && a.subtype === 'checking').map((a) => a.availableMinor);
  await commit('balance', [
    { op: 'update', table: 'provider', pk, sk: 'ITEM', set: itemSet, cond: fenceCond },
    { op: 'put', table: 'provider', item: { pk, sk: `OBS#${retrievedAt}#${cycle.id}`, ...obs }, cond: { notExists: true } },
    fundsBumpOp(pk),
    { op: 'put', table: 'provider', item: { pk, sk: 'ACCOUNTS', accounts } },
    { op: 'put', table: 'provider', item: { pk, sk: 'STATUS', lastAttemptAt: retrievedAt, ok: true, lastError: null, lastGoodRetrievedAt: retrievedAt } },
    au('BankBalanceObserved', `Bank read: ${obs.accounts.length} accounts; checking available ${counted.map((m) => (m === null ? 'not reported' : usd(m))).join(' and ') || 'none'}`),
    ...extra,
  ], { kind: 'requeue', at: addMs(retrievedAt, historyComplete ? SYNC_EVERY_MS : MIN), error: null, resetAttempts: true, set: { cycle: null } });
}

/** RUN_READY_DEADLINE: a run still PREPARING 10 min after reset becomes BLOCKED with the bank's last status (S2-PR-06). */
export async function runReadyDeadline(d: Deps, l: Lease): Promise<void> {
  const run = await getRun(d.store, l.job.tenantId!, l.job.runId!);
  if (!run || run.state !== 'PREPARING') return d.store.transact([finishOp(l, { kind: 'done' })]);
  const b = (await d.store.get('core', run.pk, 'CONN#plaid')) as { itemId: string | null } | undefined;
  const st = b?.itemId ? ((await d.store.get('provider', K.plaid(b.itemId), 'STATUS')) as StatusItem | undefined) : undefined;
  // Name the half that is missing (S2-IR-04).
  const reason = run.bankReady ? 'PayPal read not recorded within 10 min' : `Bank not ready within 10 min: ${st?.lastError ?? (b?.itemId ? 'no balance read yet' : 'bank seed not finished')}`;
  const blockOp = readinessOp(run, reason)!;
  await d.store.transact([blockOp, auditOp({ tenantId: run.tenantId, runId: run.runId, type: 'RunReadinessChanged', by: 'HEADROOM', result: `Run BLOCKED: ${reason}`, refs: {}, correlationId: `deadline:${run.runId}`, now: d.now() }), finishOp(l, { kind: 'done' })]);
}

export type { ConnItem };
