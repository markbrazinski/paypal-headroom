// Run identity, epoch fence and reset (S01 T6). Old run data, audit, PPREF# and capture markers are kept.
import { randomBytes } from 'node:crypto';
import { assertTransition, type Run, type RunFence, type Settings } from '@headroom/contracts';
import { K } from '../../adapters/store/keys.ts';
import { TxCancelled, type Op, type Store } from '../../adapters/store/port.ts';
import { auditOp } from '../audit/audit.ts';
import { SEED_CUSTOMERS, SEED_SETTINGS } from './seed.ts';
import { seedPolicy } from '../delegation/policy.ts';

/** `pendingBlockers`: PayPal blockers stored at reset while the run waits PREPARING for its seeded bank (S2-D6). */
export type RunItem = Run & { settings: Settings; pk: string; sk: string; pendingBlockers?: string[]; bankSeed?: boolean; bankReady?: boolean };

export const getFence = (s: Store, tenantId: string) => s.get('core', K.tenant(tenantId), 'RUN_FENCE') as Promise<(RunFence & { pk: string }) | undefined>;
export const getRun = (s: Store, tenantId: string, runId: string) => s.get('core', K.run(tenantId, runId), 'RUN') as Promise<RunItem | undefined>;

export async function tenantForUser(s: Store, sub: string): Promise<{ tenantId: string; email: string } | undefined> {
  return (await s.get('core', K.user(sub), 'TENANT')) as any;
}
export async function connectionFor(s: Store, tenantId: string): Promise<string | null> {
  return ((await s.get('core', K.tenant(tenantId), 'CONN#paypal')) as any)?.connectionId ?? null;
}

/** Bind a user to a tenant, and the tenant to a PayPal connection (operator setup). Idempotent. */
export async function bootstrapTenant(s: Store, a: { sub: string; email: string; tenantId: string; connectionId: string | null }) {
  const ops: Op[] = [{ op: 'put', table: 'core', item: { pk: K.user(a.sub), sk: 'TENANT', tenantId: a.tenantId, email: a.email } }];
  if (a.connectionId) {
    ops.push({ op: 'put', table: 'core', item: { pk: K.tenant(a.tenantId), sk: 'CONN#paypal', connectionId: a.connectionId } });
    ops.push({ op: 'put', table: 'provider', item: { pk: K.conn(a.connectionId), sk: 'TENANT', tenantId: a.tenantId } });
  }
  await s.transact(ops);
}

const newRunId = () => `run-${randomBytes(4).toString('base64url').replace(/[^a-zA-Z0-9]/g, '').toLowerCase().padEnd(6, '0').slice(0, 6)}`;

/**
 * One TX moves the fence {run, epoch} → {newRun, epoch+1}. The executor's dispatch claim checks the same item,
 * so DynamoDB serializes reset against dispatch: either the claim committed first (the effect finishes in the
 * old run) or the reset did (no provider call).
 */
export async function resetRun(s: Store, tenantId: string, reason: string, now: string, correlationId: string, o: { extra?: (run: RunItem, oldRunId: string | null) => Promise<Op[]>; bankSeed?: boolean; invoiceSeqNext?: number; bills?: 'AUTO' | 'ASK' } = {}): Promise<RunItem> {
  const fence = await getFence(s, tenantId);
  const runId = newRunId();
  const epoch = (fence?.epoch ?? 0) + 1;
  const run: RunItem = {
    pk: K.run(tenantId, runId), sk: 'RUN', runId, tenantId, epoch, state: 'PREPARING', seeded: true, createdAt: now, blockers: [], reason,
    settings: SEED_SETTINGS, ...(o.bankSeed ? { bankSeed: true } : {}),
  };
  const ops: Op[] = [
    { op: 'put', table: 'core', item: { pk: K.tenant(tenantId), sk: 'RUN_FENCE', tenantId, runId, epoch }, cond: fence ? { eq: { epoch: fence.epoch, runId: fence.runId } } : { notExists: true } },
    { op: 'put', table: 'core', item: run, cond: { notExists: true } },
    // One sequence write per reset (S04 §6.17 R3): the hero's operator-issued invoices take the first numbers.
    { op: 'put', table: 'core', item: { pk: run.pk, sk: 'SEQ#INVOICE', next: o.invoiceSeqNext ?? 1 } },
    ...SEED_CUSTOMERS.map((c): Op => ({ op: 'put', table: 'core', item: { pk: run.pk, sk: `CUST#${c.customerId}`, ...c } })),
    // S4: the plan root (basis stamp, running/draft pointers) and Delegation v1 (current + immutable snapshot), in every run.
    { op: 'put', table: 'core', item: { pk: run.pk, sk: 'PLAN', version: 1, basisStamp: 0, running: null, draft: null, nextN: 1 } },
    { op: 'put', table: 'core', item: { pk: run.pk, sk: 'POLICY', ...seedPolicy(now, { bills: o.bills }) } },
    { op: 'put', table: 'core', item: { pk: run.pk, sk: 'POLICYV#0001', ...seedPolicy(now, { bills: o.bills }) } },
    auditOp({ tenantId, runId, type: 'RunReset', by: 'OPERATOR', result: `Run ${runId} (epoch ${epoch}) started${fence ? `; ${fence.runId} sealed` : ''}`, refs: { runId, ...(fence ? { previousRunId: fence.runId } : {}) }, correlationId, now }),
  ];
  if (fence) {
    const old = await getRun(s, tenantId, fence.runId);
    if (old && old.state !== 'SEALED') {
      assertTransition('Run', old.state === 'PREPARING' ? 'READY' : old.state, 'SEALED');
      ops.push({ op: 'update', table: 'core', pk: old.pk, sk: 'RUN', set: { state: 'SEALED', sealedAt: now }, cond: { eq: { state: old.state } } });
    }
  }
  if (o.extra) ops.push(...(await o.extra(run, fence?.runId ?? null)));
  try {
    await s.transact(ops);
  } catch (e) {
    if (e instanceof TxCancelled && e.failed[0]) throw new Error('Run fence moved during reset; retry');
    throw e;
  }
  return run;
}

export async function setRunReadiness(s: Store, run: RunItem, blockers: string[]) {
  const state = blockers.length ? 'BLOCKED' : 'READY';
  assertTransition('Run', 'PREPARING', state);
  await s.transact([{ op: 'update', table: 'core', pk: run.pk, sk: 'RUN', set: { state, blockers }, cond: { eq: { state: 'PREPARING' } } }]);
}

/** Active run for a tenant, or undefined. Commands require it; old runs return RUN_SEALED. */
export async function activeRun(s: Store, tenantId: string) {
  const f = await getFence(s, tenantId);
  return f ? getRun(s, tenantId, f.runId) : undefined;
}

/**
 * A seeded run is ready when both halves are known: the operator's PayPal read (pendingBlockers) and the bank (history
 * complete + balance observed). Whichever finishes second finalizes; each side's write is conditioned on the other's
 * marker being absent, so exactly one finalizes.
 */
export function bankReadyOp(run: RunItem): Op | null {
  if (run.state !== 'PREPARING') return null;
  if (run.pendingBlockers) return readinessOp(run);
  return { op: 'update', table: 'core', pk: run.pk, sk: 'RUN', set: { bankReady: true }, cond: { eq: { state: 'PREPARING' }, missing: ['pendingBlockers'] } };
}
export async function recordPayPalBlockers(s: Store, run: RunItem, blockers: string[]) {
  try {
    await s.transact([{ op: 'update', table: 'core', pk: run.pk, sk: 'RUN', set: { pendingBlockers: blockers }, cond: { eq: { state: 'PREPARING' }, missing: ['bankReady'] } }]);
  } catch (e) {
    if (!(e instanceof TxCancelled)) throw e;
    const cur = await getRun(s, run.tenantId, run.runId);
    const op = cur?.bankReady ? readinessOp({ ...cur, pendingBlockers: blockers }) : null;
    if (op) await s.transact([op]);
    // Already BLOCKED by the bank half (e.g. a seed failure): keep the PayPal reasons too (S2-IR-05). Not a state change.
    else if (cur?.state === 'BLOCKED' && blockers.length) await s.transact([{ op: 'update', table: 'core', pk: cur.pk, sk: 'RUN', set: { blockers: [...cur.blockers, ...blockers.filter((x) => !cur.blockers.includes(x))] }, cond: { eq: { state: 'BLOCKED' } } }]).catch(() => {});
  }
}

/** PREPARING → READY/BLOCKED as an op inside a queued-work TX (S2-PR-06), combining the PayPal blockers stored at reset. */
export function readinessOp(run: RunItem, extraBlocker?: string): Op | null {
  if (run.state !== 'PREPARING') return null;
  const blockers = [...(run.pendingBlockers ?? []), ...(extraBlocker ? [extraBlocker] : [])];
  const state = blockers.length ? 'BLOCKED' : 'READY';
  assertTransition('Run', 'PREPARING', state);
  return { op: 'update', table: 'core', pk: run.pk, sk: 'RUN', set: { state, blockers }, cond: { eq: { state: 'PREPARING' } } };
}
