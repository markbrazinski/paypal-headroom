// S5 owner commands (T6, T8, T9, UI-AR-06/07, UI-IN-03). Each returns the ops for ONE transaction; `afterCommit` only pulls
// existing due/effect jobs forward (requestRun), which the sweep would otherwise reach on its own schedule.
import { assertTransition, type ActionState } from '@headroom/contracts';
import { basisBumpOp, K } from '../../adapters/store/keys.ts';
import type { Item, Op, Store } from '../../adapters/store/port.ts';
import { ApiError } from '../../api-error.ts';
import { requestRun } from '../../jobs/lease.ts';
import type { ReadCtx } from '../../read/models.ts';
import { auditOp } from '../audit/audit.ts';
import { fenceCheck, type CommandCtx, type CommandResult } from '../receivables/commands.ts';
import { approvedState, loadPlanState, type ActItem, type PlanState } from '../plan/state.ts';
import { dueJobId, queueUpdateOps } from '../plan/due.ts';
import { outSk, type OutItem } from './send.ts';

const ifMatchOf = (h: string | undefined) => (h === undefined ? undefined : Number(h.replace(/"/g, '')));
const auditOf = (c: CommandCtx) => (type: Parameters<typeof auditOp>[0]['type'], result: string, refs: Record<string, string>) =>
  auditOp({ tenantId: c.tenantId, runId: c.run.runId, type, by: 'OWNER', allowedBy: c.ownerEmail, result, refs, correlationId: c.correlationId, now: c.now });
const actOf = (s: PlanState, id: string) => { const a = s.actions.find((x) => x.actionId === id); if (!a) throw new ApiError(404, 'NOT_FOUND', 'No such action'); return a; };
const actUpdate = (a: ActItem, set: Record<string, unknown>): Op => ({ op: 'update', table: 'core', pk: a.pk, sk: a.sk, set: { ...set, version: a.version + 1 }, cond: { eq: { version: a.version, state: a.state } } });

/** Run an existing job now, reviving a DONE one (a due job that held its action); never creates one. A job that no longer fits no-ops. */
export async function pull(store: Store, jobId: string, now: string) {
  const j = (await store.get('work', K.job(jobId), 'JOB')) as Item | undefined;
  if (j) await requestRun(store, j as never, now);
}
const purposeOf = (a: ActItem) => (a.kind === 'DISCOUNT_FALLBACK' ? (a.state === 'APPLIED' ? 'MESSAGE' : 'CHECK') : a.state === 'APPLIED' ? 'MESSAGE' : 'CONTACT') as 'CONTACT' | 'CHECK' | 'MESSAGE';

/**
 * Release what a pause or a takeover held (resume / hand back): HELD actions with that reason go back to their approved state and
 * their due job runs again; a bound discount removal held by it goes back to SCHEDULED and runs at once (S5-D25).
 */
export async function releaseHolds(s: PlanState, code: 'PAUSED' | 'YOU_TOOK_OVER' | 'DISPUTE_PENDING', customerId: string | null): Promise<{ ops: Op[]; jobs: string[] }> {
  const ops: Op[] = [];
  const jobs: string[] = [];
  for (const a of s.actions.filter((x) => (!customerId || x.counterparty.id === customerId))) {
    if (a.state === 'HELD' && a.holdCode === code) {
      const to: ActionState = a.kind === 'DISCOUNT_FALLBACK' ? (a.lastCheckId ? 'HELD_EVIDENCE' : 'WAITING_CONDITION') : approvedState(a) as ActionState;
      assertTransition('Action', 'HELD', to);
      ops.push(actUpdate(a, { state: to, holdCode: null, heldReasons: [] }));
      jobs.push(dueJobId(a.actionId, a.intentVersion, a.kind === 'DISCOUNT_FALLBACK' ? 'CHECK' : 'CONTACT'));
    }
    const held = code === 'PAUSED' ? 'HELD_PAUSED' : code === 'YOU_TOOK_OVER' ? 'HELD_TAKEOVER' : null;
    if (held && a.expiry?.state === held) {
      ops.push(actUpdate(a, { expiry: { ...a.expiry, state: 'SCHEDULED' } }));
      jobs.push(`exec#${a.expiry.removeKey}`);
    }
    // A message that went back to draft because of this hold is queued again by its due job.
    if (a.state === 'APPLIED' || a.state === 'SCHEDULED') jobs.push(dueJobId(a.actionId, a.intentVersion, purposeOf(a)));
  }
  return { ops, jobs };
}

/** T6 decideFallback: the owner's answer when the offer is still unproven at decideBy. SEND authorizes it once; a pause is never bypassed. */
export async function decideFallback(rc: ReadCtx, c: CommandCtx, actionId: string, ifMatch: string | undefined, body: { decision: 'SEND' | 'DONT_SEND'; checkId: string }): Promise<CommandResult> {
  const s = await loadPlanState(rc);
  const a = actOf(s, actionId);
  if (a.kind !== 'DISCOUNT_FALLBACK') throw new ApiError(409, 'NOT_EDITABLE', 'Only a fallback offer waits for this decision');
  if (ifMatchOf(ifMatch) !== a.version) throw new ApiError(409, 'VERSION_CONFLICT', 'This offer changed; reload');
  if (a.state !== 'HELD_EVIDENCE') throw new ApiError(409, 'NOT_EDITABLE', `The offer is ${a.state.toLowerCase().replace(/_/g, ' ')}; nothing to decide`);
  if (a.lastCheckId !== body.checkId) throw new ApiError(409, 'CONSENT_CHANGED', 'A newer check exists; review it first');
  const audit = auditOf(c);
  if (body.decision === 'DONT_SEND') {
    assertTransition('Action', a.state, 'CANCELLED');
    return { status: 200, body: { actionId, state: 'CANCELLED' }, ops: [fenceCheck(c), actUpdate(a, { state: 'CANCELLED', heldReasons: ["You decided not to send the offer"] }), audit('FallbackDecided', `${a.counterparty.name}: you decided not to send the offer (check ${body.checkId}). Nothing sent`, { actionId, checkId: body.checkId })] };
  }
  const thread = await rc.store.get('core', s.pk, `THREAD#${a.counterparty.id}`);
  if (s.policy.pauses.outreach) throw new ApiError(409, 'OUTREACH_PAUSED', 'Outreach is paused; resume it first. A pause is never bypassed');
  if (thread?.owner === 'YOU') throw new ApiError(409, 'YOU_TOOK_OVER', `You took over ${a.counterparty.name}; hand back first`);
  const authId = `OWNERAUTH#${actionId}#${body.checkId}`;
  const q = await queueUpdateOps({ store: rc.store, now: () => c.now } as never, s, a, 'APPLY_DISCOUNT', { ownerAuth: { id: authId, termsHash: a.termsHash, state: 'ACTIVE' } });
  if (!q.ok) throw new ApiError(409, 'NOT_EDITABLE', q.text);
  return {
    status: 200, body: { actionId, state: 'QUEUED' }, conflict: new ApiError(409, 'CONSENT_CHANGED', 'The offer changed while you were deciding; reload'),
    ops: [fenceCheck(c), { op: 'put', table: 'core', item: { pk: s.pk, sk: authId, actionId, checkId: body.checkId, termsHash: a.termsHash, state: 'ACTIVE', consumedBy: null, by: c.ownerEmail, at: c.now }, cond: { notExists: true } },
      ...q.ops, audit('OwnerAuthorityGranted', `${a.counterparty.name}: you approved sending the offer once (check ${body.checkId}); it is used by this one update`, { actionId, checkId: body.checkId })],
    afterCommit: async () => { if (q.jobId) await pull(rc.store, q.jobId, c.now); },
  };
}

/** T8 take over / hand back (UI-AR-07): per customer. Taking over stops every Headroom write for them; handing back re-runs what it held. */
export async function setThreadOwner(rc: ReadCtx, c: CommandCtx, customerId: string, ifMatch: string | undefined, body: { owner: 'YOU' | 'HEADROOM' }): Promise<CommandResult> {
  const s = await loadPlanState(rc);
  const cust = s.customers.find((x) => x.customerId === customerId);
  if (!cust) throw new ApiError(404, 'NOT_FOUND', 'No such customer');
  const t = await rc.store.get('core', s.pk, `THREAD#${customerId}`);
  if ((t?.version ?? 0) !== (ifMatchOf(ifMatch) ?? 0)) throw new ApiError(409, 'VERSION_CONFLICT', 'Changed; reload');
  if ((t?.owner ?? 'HEADROOM') === body.owner) throw new ApiError(409, 'VERSION_CONFLICT', body.owner === 'YOU' ? 'You already own this conversation' : 'Headroom already handles it');
  const version = (t?.version ?? 0) + 1;
  const rel = body.owner === 'HEADROOM' ? await releaseHolds(s, 'YOU_TOOK_OVER', customerId) : { ops: [], jobs: [] };
  return {
    status: 200, body: { customerId, owner: body.owner, version },
    ops: [fenceCheck(c), { op: 'put', table: 'core', item: { pk: s.pk, sk: `THREAD#${customerId}`, customerId, owner: body.owner, by: c.ownerEmail, at: c.now, seenVersion: t?.seenVersion ?? 0, version }, cond: t ? { eq: { version: t.version } } : { notExists: true } },
      { op: 'update', table: 'core', pk: s.pk, sk: 'PLAN', add: { basisStamp: 1 } }, ...rel.ops,
      auditOf(c)('ThreadOwnerChanged', body.owner === 'YOU' ? `You took over ${cust.displayName}: Headroom sends nothing and changes nothing on PayPal for them until you hand back` : `You handed ${cust.displayName} back to Headroom; held work runs again under its own checks`, { customerId })],
    afterCommit: async () => { for (const j of rel.jobs) await pull(rc.store, j, c.now); },
  };
}

/** UI-AR-06 hold / release one action's message. A held message never sends; release re-queues the same message (same Message-ID). */
export async function holdMessage(rc: ReadCtx, c: CommandCtx, actionId: string, body: { held: boolean }): Promise<CommandResult> {
  const s = await loadPlanState(rc);
  const a = actOf(s, actionId);
  if (!a.message) throw new ApiError(409, 'NOT_EDITABLE', 'This action has no message');
  const sk = outSk(a.rootId, a.intentVersion);
  const out = (await rc.store.get('core', s.pk, sk)) as OutItem | undefined;
  if (out && out.state !== 'DRAFT' && out.state !== 'QUEUED') throw new ApiError(409, 'ACTION_EXECUTED', `The message is already ${out.state === 'SENT' ? 'sent' : out.state.toLowerCase().replace('_', ' ')}`);
  if ((out?.held ?? false) === body.held) throw new ApiError(409, 'VERSION_CONFLICT', body.held ? 'Already held' : 'Not held');
  const op: Op = out
    ? { op: 'update', table: 'core', pk: s.pk, sk, set: { held: body.held, ...(out.state === 'QUEUED' && body.held ? { state: 'DRAFT', reason: 'Held by you' } : {}), updatedAt: c.now }, add: { version: 1 }, cond: { eq: { version: out.version, state: out.state } } }
    : { op: 'put', table: 'core', item: { pk: s.pk, sk, rootId: a.rootId, intentVersion: a.intentVersion, actionId, customerId: a.counterparty.id, state: 'DRAFT', held: true, version: 1, rfcMessageId: '', effectKey: '', subject: a.message.subject, to: '', preparedFor: null, rawB64: null, rawSha256: null, channel: 'GMAIL', sentMessageId: null, threadId: null, reason: 'Held by you', updatedAt: c.now }, cond: { notExists: true } };
  if (out?.state === 'QUEUED' && body.held) assertTransition('OutMsg', 'QUEUED', 'DRAFT');
  return {
    status: 200, body: { actionId, held: body.held },
    ops: [fenceCheck(c), op, auditOf(c)(body.held ? 'MessageHeld' : 'MessageReleased', `${a.counterparty.name}: message ${body.held ? 'held by you; it will not send until you release it' : 'released; it sends at the next allowed time'}`, { actionId })],
    afterCommit: async () => { if (!body.held) await pull(rc.store, dueJobId(a.actionId, a.intentVersion, purposeOf(a)), c.now); },
  };
}

/** UI-IN-03 Send now = pull the action's existing due job forward: one job, one lease, one Message-ID. Never a second message. */
export async function sendNow(rc: ReadCtx, c: CommandCtx, actionId: string): Promise<CommandResult> {
  const s = await loadPlanState(rc);
  const a = actOf(s, actionId);
  const out = (await rc.store.get('core', s.pk, outSk(a.rootId, a.intentVersion))) as OutItem | undefined;
  if (out && out.state !== 'DRAFT') throw new ApiError(409, 'ACTION_EXECUTED', `The message is already ${out.state === 'SENT' ? 'sent' : out.state.toLowerCase().replace('_', ' ')}`);
  if (out?.held) throw new ApiError(409, 'NOT_EDITABLE', 'Release the message first');
  const jobId = dueJobId(a.actionId, a.intentVersion, purposeOf(a));
  if (!(await rc.store.get('work', K.job(jobId), 'JOB'))) throw new ApiError(409, 'NOT_EDITABLE', 'This message is not scheduled (approve the plan first)');
  return { status: 202, body: { jobId }, ops: [fenceCheck(c)], afterCommit: () => pull(rc.store, jobId, c.now) };
}

/** T9 Reconciliation answer on a bank PayPal-transfer candidate (S5-D15). A label: no receipt, no cash moves. */
export async function answerMatch(rc: ReadCtx, c: CommandCtx, bankTxId: string, ifMatch: string | undefined, body: { answer: 'TRANSFER' | 'NOT_TRANSFER' }): Promise<CommandResult> {
  const pk = K.run(c.tenantId, c.run.runId);
  const cur = await rc.store.get('core', pk, `MATCH#${bankTxId}`);
  if ((cur?.version ?? 0) !== (ifMatchOf(ifMatch) ?? 0)) throw new ApiError(409, 'VERSION_CONFLICT', 'Changed; reload');
  const version = (cur?.version ?? 0) + 1;
  return {
    status: 200, body: { bankTxId, answer: body.answer, version },
    ops: [fenceCheck(c), { op: 'put', table: 'core', item: { pk, sk: `MATCH#${bankTxId}`, bankTxId, answer: body.answer, by: c.ownerEmail, at: c.now, version }, cond: cur ? { eq: { version: cur.version } } : { notExists: true } },
      auditOf(c)('MatchAnswered', `${body.answer === 'TRANSFER' ? 'Marked a PayPal transfer' : 'Marked not a PayPal transfer'}${cur ? ' (answer changed)' : ''}: a label only; no receipt and no cash moved`, { bankTxId })],
  };
}


/** S7 ar.newDateDays: the owner counts a promised date that is beyond their limit. Expected only; never cash, never skips a fallback. */
export async function acceptPromise(rc: ReadCtx, c: CommandCtx, promiseId: string): Promise<CommandResult> {
  const pk = K.run(c.tenantId, c.run.runId);
  const p = await rc.store.get('core', pk, `PROMISE#${promiseId}`);
  if (!p) throw new ApiError(404, 'NOT_FOUND', 'No such promise');
  if (!p.beyondLimitDays || p.acceptedBy) throw new ApiError(409, 'VERSION_CONFLICT', p.acceptedBy ? 'Already counted' : 'This promise is already inside your limit');
  return {
    status: 200, body: { promiseId, accepted: true },
    ops: [fenceCheck(c), { op: 'update', table: 'core', pk, sk: `PROMISE#${promiseId}`, set: { acceptedBy: { by: c.ownerEmail, at: c.now } }, cond: { eq: { acceptedBy: null } } }, basisBumpOp(pk),
      auditOf(c)('PromiseAccepted', `You counted the promised date ${p.on} (beyond your ${p.beyondLimitDays}-day limit). Expected only; never cash, never skips a fallback`, { promiseId })],
  };
}
