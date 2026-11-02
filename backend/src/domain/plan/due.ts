// S5 due work (T1, T2, T3, S5-D13, S5-D24). Approval schedules ACTION_DUE jobs keyed by the action's intentVersion; the worker
// no-ops a job whose intent or state no longer fits. PLAN_PROGRESS applies receipts to the actions collecting that invoice.
// ponytail: an offer's CHECK job requeues itself for rechecks (one job, one lease) instead of minting RECHECK ids.
import { assertTransition, canTransition, EXECUTED_ACTION_STATES, type ActionState } from '@headroom/contracts';
import { K } from '../../adapters/store/keys.ts';
import { TxCancelled, type Op } from '../../adapters/store/port.ts';
import type { Deps } from '../../deps.ts';
import { finishOp, newJob, putJobOp, type Lease } from '../../jobs/lease.ts';
import { auditOp } from '../audit/audit.ts';
import { executeJobOp, newUpdateEffect, readLock, updateKey, type UpdItem } from '../executor/invoice-update.ts';
import { invoiceProjection } from '../receivables/claims.ts';
import { authorityFor, planCtxFor } from './authority.ts';
import { windowOf, zonedInstant, type Window } from './dates.ts';
import { progressFor } from './progress.ts';
import { loadPlanState, type ActItem, type PlanState } from './state.ts';
import { runSkipCheck } from './check.ts';
import { PAY_AT_HHMM, runPayDue } from '../payables/payout.ts';

/** MESSAGE: the message after a verified slice/discount update (S5-D19 `requiresEffect`). */
/** PAY (S6-D5): a payout's due job at 09:00 on its pay-by date; it requeues itself as the 15-minute recheck while funds or evidence are short. */
export type Purpose = 'CONTACT' | 'CHECK' | 'EXPIRY' | 'MESSAGE' | 'PAY';
export const dueJobId = (actionId: string, iv: number, purpose: Purpose) => `due#${actionId}#${iv}#${purpose}#0`;
export function parseDueJob(jobId: string): { actionId: string; iv: number; purpose: Purpose } {
  const [, actionId, iv, purpose] = jobId.split('#');
  return { actionId, iv: Number(iv), purpose: purpose as Purpose };
}
const later = (a: string, b: string) => (a > b ? a : b);

/** The offer's end: its expiry date at the close of business, local (card: "Headroom removes it Fri Nov 13 18:00"). */
export const offerEndsAt = (a: Pick<ActItem, 'terms'>, tz: string, w: Window) => (a.terms.expiresOn ? zonedInstant(a.terms.expiresOn, w.close, tz) : null);
/** PAY at 09:00, or at the window's opening when 09:00 is outside the owner's window (S7 §6.1a). */
export const payAtHhmm = (w: Window) => (PAY_AT_HHMM >= w.open && PAY_AT_HHMM < w.close ? PAY_AT_HHMM : w.open);
export const offerNoteLine = (a: Pick<ActItem, 'terms'>, endsAt: string, tz: string) =>
  `Early-payment discount ${a.terms.discountBp! / 100}% if paid by ${new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(endsAt))}`;

/** T1: the jobs an approval writes for one action at intentVersion `iv`. */
export function dueJobOps(a: Pick<ActItem, 'actionId' | 'kind' | 'terms' | 'condition'>, iv: number, o: { tenantId: string; runId: string; now: string; tz: string; window: Window }): Op[] {
  const job = (purpose: Purpose, at: string) => putJobOp(newJob(dueJobId(a.actionId, iv, purpose), 'ACTION_DUE', a.actionId, later(at, o.now), o.tenantId, o.runId));
  if (a.kind === 'COLLECT_OVERDUE' || a.kind === 'COLLECT_UNDISPUTED_SLICE' || a.kind === 'COLLECT_DISPUTED' || a.kind === 'ASK_SUPPLIER') return [job('CONTACT', a.terms.contactOn ? zonedInstant(a.terms.contactOn, o.window.open, o.tz) : o.now)];
  if (a.kind === 'DISCOUNT_FALLBACK') {
    const checkAt = a.condition?.checkAt ?? a.terms.checkAt;
    const end = offerEndsAt(a, o.tz, o.window);
    return [...(checkAt ? [job('CHECK', checkAt)] : []), ...(end ? [job('EXPIRY', end)] : [])];
  }
  if (a.kind === 'PAYOUT' && a.terms.payBy) return [job('PAY', zonedInstant(a.terms.payBy, payAtHhmm(o.window), o.tz))];
  return [];
}

/** Which states a purpose acts on. Anything else (or another intent) is a no-op (S5-D24). */
const ALLOWED: Record<Purpose, ActionState[]> = { CONTACT: ['SCHEDULED'], CHECK: ['WAITING_CONDITION', 'HELD_EVIDENCE'], EXPIRY: ['WAITING_CONDITION', 'HELD_EVIDENCE', 'HELD', 'QUEUED', 'UNCERTAIN'], MESSAGE: ['APPLIED'], PAY: ['SCHEDULED', 'HELD', 'HELD_EVIDENCE'] };

const audit = (d: Deps, a: ActItem, tenantId: string, runId: string, type: Parameters<typeof auditOp>[0]['type'], result: string, allowedBy: string | null = null) =>
  auditOp({ tenantId, runId, type, by: 'HEADROOM', allowedBy, result, refs: { actionId: a.actionId }, correlationId: `due:${a.actionId}:${d.now()}`, now: d.now() });

async function done(d: Deps, l: Lease, ops: Op[] = []) {
  try { await d.store.transact([...ops, finishOp(l, { kind: 'done' })]); } catch (e) { if (!(e instanceof TxCancelled)) throw e; await d.store.transact([finishOp(l, { kind: 'requeue', at: d.now(), error: 'Action changed while running; re-checking' })]).catch(() => {}); }
}
export const actUpdate = (a: ActItem, set: Record<string, unknown>): Op => ({ op: 'update', table: 'core', pk: a.pk, sk: a.sk, set: { ...set, version: a.version + 1 }, cond: { eq: { version: a.version, state: a.state } } });
export const actTo = (a: ActItem, to: ActionState, set: Record<string, unknown> = {}): Op => { assertTransition('Action', a.state, to); return actUpdate(a, { state: to, ...set }); };

/** ACTION_DUE job (T2). */
export async function runActionDue(d: Deps, l: Lease, budget: { deadline: number; elapsed: () => number }): Promise<void> {
  const [tenantId, runId] = [l.job.tenantId!, l.job.runId!];
  const { actionId, iv, purpose } = parseDueJob(l.jobId);
  const rc = await planCtxFor(d, tenantId, runId);
  const a = rc && ((await d.store.get('core', K.run(tenantId, runId), `ACT#${actionId}`)) as ActItem | undefined);
  if (!rc || !a) return done(d, l);
  // S5-R20: an earlier run's due work never runs after a reset; it ends in its own run, audited.
  const fence = await d.store.get('core', K.tenant(tenantId), 'RUN_FENCE');
  if (fence?.runId !== runId) return done(d, l, [audit(d, a, tenantId, runId, 'ActionDueSkipped', `${a.counterparty.name}: not run · the run was reset`)]);
  if (a.intentVersion !== iv || !ALLOWED[purpose].includes(a.state)) {
    return done(d, l, [audit(d, a, tenantId, runId, 'ActionDueSkipped', `${purpose.toLowerCase()} for ${a.counterparty.name} not run: ${a.intentVersion !== iv ? 'its terms or approval changed since it was scheduled' : `it is ${a.state.toLowerCase().replace(/_/g, ' ')}`}`)]);
  }
  const s = await loadPlanState(rc);
  if (purpose === 'EXPIRY') return expireUndecided(d, l, s, a);
  if (purpose === 'CHECK') return runSkipCheck(d, l, s, a, budget);
  if (purpose === 'PAY') return runPayDue(d, l, s, a);
  if (purpose === 'CONTACT' && (a.kind === 'COLLECT_UNDISPUTED_SLICE' || a.kind === 'COLLECT_DISPUTED')) return queueUpdate(d, l, s, a, 'ENABLE_PARTIAL');
  // COLLECT_OVERDUE's reminder, and the message after a verified update, are mail effects (S5-D19).
  const { queueMessage } = await import('../comms/send.ts');
  return queueMessage(d, l, s, a);
}

/** Queue stage (T3 1–2) as ops: gates, then QUEUED + the update effect READY + its job. Nothing is consumed here. */
export async function queueUpdateOps(d: Deps, s: PlanState, a: ActItem, kind: 'ENABLE_PARTIAL' | 'APPLY_DISCOUNT', o: { ownerAuth?: { id: string; termsHash: string; state: string } | null; set?: Record<string, unknown> } = {}): Promise<{ ok: boolean; ops: Op[]; jobId: string | null; text: string }> {
  const [tenantId, runId] = [s.ctx.tenantId, s.ctx.run.runId];
  const set = o.set ?? {};
  const inv = s.invoices.find((i) => i.invoiceId === a.subject.invoiceId);
  const payable = !!inv && !!inv.ppInvoiceId && (inv.state === 'ISSUED' || inv.state === 'PARTIALLY_PAID');
  const { res, conds } = await authorityFor(s, a, 'QUEUE', 'EFFECT', { invoice: { payable, why: inv ? `Invoice is ${inv.state.toLowerCase().replace('_', ' ')}` : 'Invoice missing' }, ownerAuth: o.ownerAuth ?? null });
  if (!res.ok) return { ok: false, jobId: null, text: res.text, ops: [actTo(a, 'HELD', { holdCode: res.code, heldReasons: [res.text], ...set }), audit(d, a, tenantId, runId, 'ActionHeld', `${a.counterparty.name}: not sent · ${res.text}`)] };
  const key = updateKey(a.rootId, a.intentVersion, kind);
  const existing = (await d.store.get('work', K.effect(key), 'EFFECT')) as UpdItem | undefined;
  if (existing && existing.state !== 'READY') return { ok: true, jobId: null, text: 'already queued', ops: [] }; // a re-run past the queue
  const tz = s.ctx.run.settings.timeZone;
  const end = kind === 'APPLY_DISCOUNT' ? offerEndsAt(a, tz, windowOf(s.policy)) : null;
  const eff = existing ?? newUpdateEffect({
    kind, tenantId, runId, epoch: s.ctx.run.epoch, invoiceId: inv!.invoiceId, ppInvoiceId: inv!.ppInvoiceId!, actionId: a.actionId, rootId: a.rootId, intentVersion: a.intentVersion, now: d.now(),
    target: kind === 'ENABLE_PARTIAL' ? { minimumMinor: a.terms.amount.minor, percentBp: null, noteLine: null } : { minimumMinor: null, percentBp: a.terms.discountBp!, noteLine: offerNoteLine(a, end!, tz) },
    expiresAt: end,
  });
  const ops: Op[] = [...conds, actTo(a, 'QUEUED', { holdCode: null, heldReasons: [], ...set }), audit(d, a, tenantId, runId, 'ActionQueued', `${a.counterparty.name}: ${kind === 'ENABLE_PARTIAL' ? `enabling partial payment of ${(a.terms.amount.minor / 100).toFixed(2)} on the same PayPal invoice` : 'applying the early-payment discount on PayPal'}`)];
  ops.push(existing ? { op: 'check', table: 'work', pk: eff.pk, sk: 'EFFECT', cond: { eq: { state: 'READY', version: existing.version } } } : { op: 'put', table: 'work', item: eff, cond: { notExists: true } });
  const jobId = `exec#${eff.effectKey}`;
  const job = await d.store.get('work', K.job(jobId), 'JOB');
  ops.push(job ? { op: 'update', table: 'work', pk: K.job(jobId), sk: 'JOB', set: { state: 'QUEUED', dueAt: d.now(), dueKey: `${d.now()}#${jobId}`, gsiDue: 'DUE' }, cond: { eq: { leaseToken: job.leaseToken, state: job.state } } } : executeJobOp(eff, d.now()));
  return { ok: true, ops, jobId, text: 'queued' };
}

/** The queue stage run by a job (or the check's NEEDED decision, whose ops come in `extra`). */
export async function queueUpdate(d: Deps, l: Lease | null, s: PlanState, a: ActItem, kind: 'ENABLE_PARTIAL' | 'APPLY_DISCOUNT', extra: Op[] = [], authorityOverride?: { ownerAuth: { id: string; termsHash: string; state: string } }, set: Record<string, unknown> = {}): Promise<void> {
  const q = await queueUpdateOps(d, s, a, kind, { ownerAuth: authorityOverride?.ownerAuth ?? null, set });
  const ops = [...extra, ...q.ops];
  if (l) await done(d, l, ops); else if (ops.length) await d.store.transact(ops);
  if (q.jobId) await d.queue.send(q.jobId).catch(() => {});
}

/** At the offer's end, an offer never sent ends EXPIRED; one in flight waits; an applied one is the bound removal's (S5-D25). */
async function expireUndecided(d: Deps, l: Lease, s: PlanState, a: ActItem) {
  if (a.state === 'QUEUED' || a.state === 'UNCERTAIN') return d.store.transact([finishOp(l, { kind: 'requeue', at: new Date(Date.parse(d.now()) + 5 * 60_000).toISOString(), error: 'Offer update in flight' })]).then(() => undefined);
  return done(d, l, [actTo(a, 'EXPIRED', { heldReasons: ['The offer window ended; nothing was sent'] }), audit(d, a, s.ctx.tenantId, s.ctx.run.runId, 'OfferExpired', `${a.counterparty.name}: offer window ended before it was needed; nothing sent`)]);
}

/** PLAN_PROGRESS (S5-D13): one invoice's receipts → the actions collecting it, in any revision (executed ones persist across revisions). */
export async function runProgress(d: Deps, l: Lease): Promise<void> {
  const [tenantId, runId, invoiceId] = [l.job.tenantId!, l.job.runId!, l.job.ref];
  const rc = await planCtxFor(d, tenantId, runId);
  if (!rc) return done(d, l);
  const s = await loadPlanState(rc);
  const inv = s.invoices.find((i) => i.invoiceId === invoiceId);
  if (!inv) return done(d, l);
  const items = await d.store.query('core', s.pk);
  const proj = invoiceProjection(inv, { dueMinor: (inv as { providerDueMinor?: number | null }).providerDueMinor ?? null, status: inv.providerStatus }, s.claims.find((c) => c.invoiceId === invoiceId) ?? null,
    items.filter((i) => i.sk.startsWith('ALLOC#') && i.invoiceId === invoiceId) as never, items.filter((i) => i.sk.startsWith('CONCESSION#') && i.invoiceId === invoiceId) as never);
  const live = s.actions.filter((a) => a.subject.invoiceId === invoiceId && (a.revisionId === s.plan.running || EXECUTED_ACTION_STATES.includes(a.state)) && a.decision === 'IN');
  const ops: Op[] = [];
  for (const a of live) {
    const p = progressFor(a, proj);
    if (p.kind !== 'MOVE' || !canTransition('Action', a.state, p.to)) continue;
    ops.push(actTo(a, p.to, { heldReasons: [p.text], holdCode: null, ...(p.progress ? { progress: p.progress } : {}), ...(a.expiry && a.expiry.state !== 'REMOVED' && a.expiry.state !== 'RELEASED' ? { expiry: { ...a.expiry, state: 'RELEASED' } } : {}) }),
      audit(d, a, tenantId, runId, p.to === 'CANCELLED' ? 'ActionCancelled' : 'ActionCompleted', `${a.counterparty.name}: ${p.text}`));
    if (p.releaseUnsent || a.expiry) ops.push(...(await releaseUnsent(d, a)));
  }
  return done(d, l, ops);
}

/** Effects of this action that were never dispatched are released (VERIFIED_FAILURE "released unsent"); the lock goes with them. */
async function releaseUnsent(d: Deps, a: ActItem): Promise<Op[]> {
  const out: Op[] = [];
  for (const kind of ['ENABLE_PARTIAL', 'APPLY_DISCOUNT', 'REMOVE_DISCOUNT'] as const) {
    const e = (await d.store.get('work', K.effect(updateKey(a.rootId, a.intentVersion, kind)), 'EFFECT')) as UpdItem | undefined;
    if (!e || (e.state !== 'READY' && e.state !== 'PREPARED')) continue;
    out.push({ op: 'update', table: 'work', pk: e.pk, sk: 'EFFECT', set: { state: 'VERIFIED_FAILURE', failure: 'Released unsent: the invoice was paid', updatedAt: d.now() }, add: { version: 1 }, cond: { eq: { state: e.state, version: e.version } } });
    const lock = await readLock(d, e.invoiceId);
    if (lock?.holder === e.effectKey) out.push({ op: 'update', table: 'work', pk: lock.pk, sk: 'LOCK', set: { holder: '' }, add: { version: 1 }, cond: { eq: { holder: e.effectKey } } });
  }
  const { releaseUnsentMail } = await import('../comms/send.ts');
  return [...out, ...(await releaseUnsentMail(d, a))];
}

