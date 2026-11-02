// Demo clock (S07 §6.18 R7): "Advance to next step" pulls the run's earliest pending scheduled step (an approved action's due job:
// contact, reply/offer check, offer end, PAY) forward and runs it now. Business time = max(wall, clock.virtualNow) only decides WHEN an
// action may run; evidence time stays real (freshness, provider timestamps, as-of, audit, the forecast's date). Monotonic: virtualNow
// never moves back. Continuations (evidence rechecks, requeues of a step that already ran) are never chosen as a next step.
import { K } from '../../adapters/store/keys.ts';
import type { Item } from '../../adapters/store/port.ts';
import type { Deps } from '../../deps.ts';
import { requestRun } from '../../jobs/lease.ts';
import { auditOp } from '../audit/audit.ts';
import type { RunItem } from '../identity-run/run.ts';

const PURPOSES = ['CONTACT', 'CHECK', 'MESSAGE', 'EXPIRY', 'PAY'] as const;
const LABEL: Record<(typeof PURPOSES)[number], string> = { CONTACT: 'asks', CHECK: 'fallback check', MESSAGE: 'message', EXPIRY: 'offer ends', PAY: 'payout due' };
export type RunClock = { virtualNow: string | null; version: number };
export const clockOf = (run: RunItem): RunClock => ((run as RunItem & { clock?: RunClock }).clock ?? { virtualNow: null, version: 0 });

/** The run's pending steps that are still in the future (a job that already ran once is a continuation, not a step). */
export async function pendingSteps(d: Pick<Deps, 'store'>, run: RunItem, now: string): Promise<{ job: Item; at: string; label: string }[]> {
  const pk = K.run(run.tenantId, run.runId);
  const plan = await d.store.get('core', pk, 'PLAN');
  const acts = (await d.store.query('core', pk, { skPrefix: 'ACT#' })).filter((a) => a.revisionId === plan?.running && a.decision === 'IN');
  const out: { job: Item; at: string; label: string }[] = [];
  for (const a of acts) for (const p of PURPOSES) {
    const j = await d.store.get('work', K.job(`due#${a.actionId}#${a.intentVersion}#${p}#0`), 'JOB');
    if (j && j.state === 'QUEUED' && !j.attempts && j.dueAt > now) out.push({ job: j, at: j.dueAt, label: `${a.counterparty.name} · ${LABEL[p]}` });
  }
  return out.sort((x, z) => x.at.localeCompare(z.at));
}

export async function advanceClock(d: Deps, run: RunItem): Promise<{ virtualNow: string; ran: string[] } | null> {
  const now = d.now();
  const c = clockOf(run);
  const steps = await pendingSteps(d, run, now);
  if (!steps.length) return null;
  const at = steps[0].at;
  const batch = steps.filter((s) => s.at === at);
  const virtualNow = c.virtualNow && c.virtualNow > at ? c.virtualNow : at;
  await d.store.transact([
    { op: 'update', table: 'core', pk: K.run(run.tenantId, run.runId), sk: 'RUN', set: { clock: { virtualNow, version: c.version + 1 }, clockVersion: c.version + 1 }, cond: c.version ? { eq: { epoch: run.epoch, clockVersion: c.version } } : { eq: { epoch: run.epoch }, missing: ['clockVersion'] } }, // one advance wins
    ...batch.map((s) => ({ op: 'update' as const, table: 'work' as const, pk: s.job.pk, sk: 'JOB', set: { early: { by: 'demo clock', scheduledAt: s.at } }, cond: { eq: { leaseToken: s.job.leaseToken, state: 'QUEUED' } } })),
    auditOp({ tenantId: run.tenantId, runId: run.runId, type: 'OperatorRanActionEarly', by: 'OPERATOR', allowedBy: 'Sandbox clock', result: `Sandbox clock advanced to ${virtualNow}: ${batch.map((s) => s.label).join(', ')} run now; PayPal and bank times stay real`, refs: { virtualNow }, correlationId: `clock:${run.runId}:${c.version + 1}`, now }),
  ]);
  for (const s of batch) { await requestRun(d.store, s.job as never, now); await d.queue.send(s.job.jobId ?? s.job.pk.replace(/^JOB#/, '')).catch(() => {}); }
  return { virtualNow, ran: batch.map((s) => s.label) };
}
