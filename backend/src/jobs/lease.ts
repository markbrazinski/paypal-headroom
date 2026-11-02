// Durable jobs with lease tokens (S01 T2.6). A worker's later writes carry `leaseToken = mine`; a stale worker's write fails.
import type { Job, JobType } from '@headroom/contracts';
import { K } from '../adapters/store/keys.ts';
import { TxCancelled, type Item, type Op, type Store } from '../adapters/store/port.ts';
import { addMs } from '../domain/time.ts';

export const LEASE_MS = 90_000; // Lambda timeout is 60 s, so a live worker never outlives its lease
export const MAX_ATTEMPTS = 8;

export type JobItem = Item & Job & { unknownSince?: string | null; rerunAt?: string | null; cycle?: SyncCycle | null };

/** PLAID_SYNC progress across invocations (S2-PR-06): pages are staged durably and published only as a whole update cycle. */
export interface SyncCycle { id: string; phase: 'SYNC' | 'PUBLISH' | 'BALANCE'; c0: string; cursor: string; stagedPages: number; restarts: number; updateStatus: string | null; institutionDataAsOf: string | null; consentExpiresAt: string | null }

export function newJob(jobId: string, type: JobType, ref: string, dueAt: string, tenantId: string | null, runId: string | null): JobItem {
  return {
    pk: K.job(jobId), sk: 'JOB', jobId, type, ref, state: 'QUEUED', tenantId, runId, dueAt,
    leaseToken: 0, leaseUntil: null, attempts: 0, lastError: null, gsiDue: 'DUE', dueKey: `${dueAt}#${jobId}`,
  };
}

/** Put a new job op (fails if the id exists). */
export const putJobOp = (j: JobItem): Op => ({ op: 'put', table: 'work', item: j, cond: { notExists: true } });

export interface Lease { jobId: string; token: number; job: JobItem }

/** Claim a due QUEUED job. Two workers racing on one job: exactly one wins. */
export async function claim(store: Store, jobId: string, now: string): Promise<Lease | null> {
  const j = (await store.get('work', K.job(jobId), 'JOB')) as JobItem | undefined;
  if (!j || j.state !== 'QUEUED' || j.dueAt > now) return null;
  const token = j.leaseToken + 1;
  const leaseUntil = addMs(now, LEASE_MS);
  try {
    await store.transact([{
      op: 'update', table: 'work', pk: j.pk, sk: 'JOB',
      set: { state: 'LEASED', leaseToken: token, leaseUntil, dueKey: `${leaseUntil}#${jobId}`, rerunAt: null },
      add: { attempts: 1 },
      cond: { eq: { state: 'QUEUED', leaseToken: j.leaseToken } },
    }]);
  } catch (e) {
    if (e instanceof TxCancelled) return null;
    throw e;
  }
  return { jobId, token, job: { ...j, state: 'LEASED', leaseToken: token, leaseUntil, attempts: j.attempts + 1 } };
}

/** Condition-only op: this worker still holds the lease. */
export const leaseCheck = (l: Lease): Op => ({ op: 'check', table: 'work', pk: K.job(l.jobId), sk: 'JOB', cond: { eq: { leaseToken: l.token, state: 'LEASED' } } });

export type Finish =
  | { kind: 'done' }
  | { kind: 'requeue'; at: string; type?: JobType; error?: string | null; resetAttempts?: boolean; unknownSince?: string | null; set?: Record<string, unknown> }
  | { kind: 'dead'; error: string };

/** Job update op that both finishes the job and checks the lease (one op per item per TX). */
export function finishOp(l: Lease, f: Finish): Op {
  const pk = K.job(l.jobId);
  const cond = { eq: { leaseToken: l.token, state: 'LEASED' } };
  if (f.kind === 'done') return { op: 'update', table: 'work', pk, sk: 'JOB', set: { state: 'DONE', leaseUntil: null, lastError: null }, remove: ['gsiDue', 'dueKey'], cond };
  if (f.kind === 'dead') return { op: 'update', table: 'work', pk, sk: 'JOB', set: { state: 'DEAD', leaseUntil: null, lastError: f.error }, remove: ['gsiDue', 'dueKey'], cond };
  const at = f.at;
  return {
    op: 'update', table: 'work', pk, sk: 'JOB', cond,
    set: {
      state: 'QUEUED', dueAt: at, dueKey: `${at}#${l.jobId}`, leaseUntil: null, gsiDue: 'DUE',
      ...(f.type ? { type: f.type } : {}),
      ...(f.error !== undefined ? { lastError: f.error } : {}),
      ...(f.resetAttempts ? { attempts: 0 } : {}),
      ...(f.unknownSince !== undefined ? { unknownSince: f.unknownSince } : {}),
      ...f.set,
    },
  };
}

/**
 * Requeue a recurring job (poll, balance) and honour a Refresh accepted while it ran (S1-IM-03).
 * requestRun stores rerunAt on a LEASED job; the lease snapshot can't see it, so re-read after the requeue commits.
 * A request racing this either landed before the requeue (seen here) or finds the job QUEUED and pulls it forward itself.
 */
export async function requeueRecurring(store: Store, l: Lease, f: Extract<Finish, { kind: 'requeue' }>, extra: Op[] = []): Promise<void> {
  await store.transact([finishOp(l, f), ...extra]);
  const j = (await store.get('work', K.job(l.jobId), 'JOB')) as JobItem | undefined;
  if (!j || j.state !== 'QUEUED' || j.leaseToken !== l.token || !j.rerunAt || j.rerunAt >= j.dueAt) return;
  try {
    await store.transact([{
      op: 'update', table: 'work', pk: j.pk, sk: 'JOB',
      set: { dueAt: j.rerunAt, dueKey: `${j.rerunAt}#${l.jobId}`, rerunAt: null },
      cond: { eq: { state: 'QUEUED', leaseToken: l.token, dueAt: j.dueAt } },
    }]);
  } catch (e) {
    if (!(e instanceof TxCancelled)) throw e; // claimed or already pulled forward: the refresh is served either way
  }
}

/** Exponential backoff for retries: 15 s, 30 s, 60 s … capped at 15 min. */
export const backoff = (now: string, attempts: number) => addMs(now, Math.min(15_000 * 2 ** Math.max(0, attempts - 1), 15 * 60_000));

/**
 * Ask for a deterministic recurring job (poll, balance) to run at `at` or sooner. Creates it if missing.
 * Not part of a domain TX: a lost request is covered by the job's own schedule.
 */
export async function requestRun(store: Store, j: JobItem, at: string): Promise<void> {
  for (let i = 0; i < 3; i++) {
    const cur = (await store.get('work', j.pk, 'JOB')) as JobItem | undefined;
    try {
      if (!cur) { await store.transact([putJobOp({ ...j, dueAt: at, dueKey: `${at}#${j.jobId}` })]); return; }
      if (cur.state === 'LEASED') { await store.transact([{ op: 'update', table: 'work', pk: j.pk, sk: 'JOB', set: { rerunAt: at }, cond: { eq: { leaseToken: cur.leaseToken, state: 'LEASED' } } }]); return; }
      if (cur.state === 'QUEUED' && cur.dueAt <= at) return;
      await store.transact([{
        op: 'update', table: 'work', pk: j.pk, sk: 'JOB',
        set: { state: 'QUEUED', dueAt: at, dueKey: `${at}#${j.jobId}`, gsiDue: 'DUE', ...(cur.state === 'DEAD' ? { attempts: 0 } : {}) },
        cond: { eq: { leaseToken: cur.leaseToken, state: cur.state } },
      }]);
      return;
    } catch (e) {
      if (!(e instanceof TxCancelled)) throw e;
    }
  }
}
