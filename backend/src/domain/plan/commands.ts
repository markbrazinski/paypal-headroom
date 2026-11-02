// Owner plan commands (S04 T5–T10 as revised by §6.17 R1/R2/R4). Each returns the ops for ONE transaction; the router adds the
// idempotency marker. Approval binds the current basis (hash + PLAN stamp) and is its own immutable consent event with its grants.
import { createHash } from 'node:crypto';
import { assertTransition, EXECUTED_ACTION_STATES, PlanAction, type ActionState, type Grant, type GrantKind } from '@headroom/contracts';
import { dueJobOps } from './due.ts';
import type { Op } from '../../adapters/store/port.ts';
import { ApiError } from '../../api-error.ts';
import type { ReadCtx } from '../../read/models.ts';
import { auditOp } from '../audit/audit.ts';
import { fenceCheck, type CommandCtx, type CommandResult } from '../receivables/commands.ts';
import { addMs, DAY } from '../time.ts';
import { dayName, money } from './candidates.ts';
import { editCtx } from './build.ts';
import { windowOf } from './dates.ts';
import { changesOf, editAction, recheckOffers, type EditChanges } from './edit.ts';
import { approvedState, basisHashOf, GRANT_DAYS, grantCovers, loadPlanState, missingKinds, type ActItem, type GrantItem, type PlanState, type RevItem } from './state.ts';

const sha = (x: unknown) => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const ifMatchOf = (h: string | undefined) => (h === undefined ? undefined : Number(h.replace(/"/g, '')));
const RUNNING_STATES: ActionState[] = ['SCHEDULED', 'WAITING_CONDITION', 'HELD'];

export function revisionOf(s: PlanState, id: string): RevItem {
  const r = s.revisions.find((x) => x.revisionId === id);
  if (!r) throw new ApiError(404, 'NOT_FOUND', 'No such revision');
  return r;
}
const checkVersion = (r: RevItem, ifMatch: string | undefined) => {
  if (ifMatchOf(ifMatch) !== r.version) throw new ApiError(409, 'VERSION_CONFLICT', `Revision ${r.n} is at version ${r.version}; reload`);
};
const auditOf = (c: CommandCtx) => (type: Parameters<typeof auditOp>[0]['type'], result: string, refs: Record<string, string>) =>
  auditOp({ tenantId: c.tenantId, runId: c.run.runId, type, by: 'OWNER', allowedBy: c.ownerEmail, result, refs, correlationId: c.correlationId, now: c.now });
const actsOf = (s: PlanState, revisionId: string) => s.actions.filter((a) => a.revisionId === revisionId).sort((a, z) => a.order - z.order);
const actUpdate = (a: ActItem, set: Partial<PlanAction>): Op => ({ op: 'update', table: 'core', pk: a.pk, sk: a.sk, set: { ...set, version: a.version + 1 }, cond: { eq: { version: a.version, state: a.state } } });
const revBump = (r: RevItem, set: Record<string, unknown> = {}): Op => ({ op: 'update', table: 'core', pk: r.pk, sk: r.sk, set: { ...set, version: r.version + 1 }, cond: { eq: { version: r.version, state: r.state } } });
const activeGrantsOf = (s: PlanState, a: Pick<PlanAction, 'rootId' | 'revisionId'>) => s.grants.filter((g) => g.state === 'ACTIVE' && g.rootId === a.rootId && (g.revisionId === a.revisionId || g.carriedTo.includes(a.revisionId)));
const lapseOps = (gs: GrantItem[], reason: string, audit: ReturnType<typeof auditOf>): Op[] => gs.flatMap((g): Op[] => [
  { op: 'update', table: 'core', pk: g.pk, sk: g.sk, set: { state: 'LAPSED', lapsedReason: reason }, cond: { eq: { state: 'ACTIVE' } } },
  audit('GrantLapsed', `${KIND_TEXT[g.kind]} lapsed: ${reason}`, { grantId: g.grantId }),
]);
export const KIND_TEXT: Record<GrantKind, string> = {
  COLLECT_SLICE: 'Permission to collect the undisputed part', MESSAGE_AS_WRITTEN: 'Permission to send the message as written', DISCOUNT_OFFER: 'One-time permission for the discount',
  PAYOUT_AUTHORITY: 'Payout authority', PAYOUT_EXCEPTION: 'One-time exception to your payment limits', COLLECT_DISPUTED: 'Permission to ask for a disputed amount',
  CONTACT_SPACING: 'One-time permission to contact before your spacing rule allows',
};

// ---------- edit / remove / restore / include / alternative (T5, T6) ----------
export type EditOp =
  | { op: 'EDIT_ACTION'; actionId: string; actionVersion: number; changes: EditChanges }
  | { op: 'REMOVE'; actionId: string; actionVersion: number; reason?: string }
  | { op: 'RESTORE'; actionId: string; actionVersion: number }
  | { op: 'INCLUDE_CONSIDERED'; actionId: string; actionVersion: number }
  | { op: 'USE_ALTERNATIVE'; actionId: string; actionVersion: number; alternativeRootId: string };

/** What the plan's included actions do to the forecast if every target is met (for edit notes). */
function ifAllMet(s: PlanState, acts: PlanAction[]) {
  const w = s.f.withChange(acts.filter((a) => a.decision === 'IN' && a.state !== 'REMOVED' && !a.condition).flatMap((a) => changesOf(a, s.f.r.inflows)));
  return w ? { low: { currency: 'USD' as const, minor: w.summary.lowMinor }, lowOn: w.summary.lowOn, belowReserveFrom: w.summary.firstBelowReserve } : null;
}

export async function editRevision(rc: ReadCtx, c: CommandCtx, revisionId: string, ifMatch: string | undefined, body: EditOp): Promise<CommandResult> {
  const s = await loadPlanState(rc);
  const rev = revisionOf(s, revisionId);
  checkVersion(rev, ifMatch);
  if (rev.state !== 'DRAFT' && rev.state !== 'RUNNING') throw new ApiError(409, 'REVISION_NOT_DRAFT', `Revision ${rev.n} is ${rev.state.toLowerCase()}`);
  const acts = actsOf(s, rev.revisionId);
  const a = acts.find((x) => x.actionId === body.actionId);
  if (!a) throw new ApiError(404, 'NOT_FOUND', 'No such action in this revision');
  if (a.version !== body.actionVersion) throw new ApiError(409, 'VERSION_CONFLICT', 'This action changed; reload');
  // S5-D12: what was sent or executed is history. A change after sending is a new follow-up action, never an edit.
  if (EXECUTED_ACTION_STATES.includes(a.state)) throw new ApiError(409, 'ACTION_EXECUTED', `${a.counterparty.name}: already ${a.state.toLowerCase().replace(/_/g, ' ')}; it stays in the history and can't be changed`);
  const sent = await rc.store.get('core', s.pk, `OUTMSG#${a.rootId}#${a.intentVersion}`);
  if (sent && sent.state !== 'DRAFT' && body.op !== 'RESTORE') throw new ApiError(409, 'ACTION_EXECUTED', `${a.counterparty.name}: the message is already ${sent.state === 'QUEUED' ? 'queued' : 'sent'}; it can't be changed`);
  const audit = auditOf(c);
  const running = rev.state === 'RUNNING';
  const ops: Op[] = [fenceCheck(c), revBump(rev)];
  const notes: string[] = [];
  let next: PlanAction = a;
  const name = a.counterparty.name;
  switch (body.op) {
    case 'EDIT_ACTION': {
      if (a.state === 'REMOVED' || a.state === 'SUPERSEDED') throw new ApiError(409, 'NOT_EDITABLE', 'Restore the action before editing it');
      const r = editAction(a, body.changes, editCtx(s, a, rev.basisSnapshot.needBy, acts));
      next = r.action;
      notes.push(...r.moved, ...r.stale);
      const before = a.authority, after = next.authority;
      const grants = activeGrantsOf(s, a);
      const stillCovered = grants.filter((g) => g.termsHash === next.termsHash);
      const needsApproval = after.grantKinds.some((k) => !stillCovered.some((g) => g.kind === k));
      const recheck = after.decision === 'EXCEPTION' ? `Exception · ${after.reasons[0]} · New approval required` : needsApproval ? `Needs your approval · ${after.reasons[0]}` : 'Still within your delegation · no new approval';
      notes.unshift(recheck);
      let state = a.state;
      // An edit that only removes a need for approval (e.g. a date after the contact-spacing rule allows) keeps it scheduled; anything
      // needing a permission it doesn't hold, or now refused, goes back to Needs your approval.
      if (running && RUNNING_STATES.includes(a.state) && (needsApproval || (before.decision !== after.decision && after.decision === 'BLOCK'))) { assertTransition('Action', a.state, 'PROPOSED'); state = 'PROPOSED'; }
      const { pk: _pk, sk: _sk, version: _v, ...fields } = next as ActItem;
      ops.push(actUpdate(a, { ...fields, state }), ...lapseOps(grants.filter((g) => g.termsHash !== next.termsHash), 'The terms it was given for changed', audit),
        audit('PlanActionEdited', `${name}: ${r.changed.join(', ')} changed · ${recheck}${state === 'PROPOSED' && a.state !== 'PROPOSED' ? ' · back to Needs your approval' : running ? ' · still scheduled' : ''}`, { revisionId, actionId: a.actionId }));
      next = { ...next, state };
      break;
    }
    case 'REMOVE': {
      if (a.state === 'REMOVED' || a.state === 'SUPERSEDED' || a.decision === 'OUT') throw new ApiError(409, 'NOT_EDITABLE', 'Only an included action can be removed');
      assertTransition('Action', a.state, 'REMOVED');
      next = { ...a, state: 'REMOVED', decision: 'OUT', removedReason: body.reason?.slice(0, 200) ?? null };
      notes.push(a.kind === 'PAYOUT' ? 'The payment stays in the forecast: removing the payout action doesn’t change what you owe' : `${name} was never counted in Expected, so the projected outcome is unchanged; one fewer way to close the gap`);
      ops.push(actUpdate(a, { state: 'REMOVED', decision: 'OUT', removedReason: next.removedReason }), ...lapseOps(activeGrantsOf(s, a), 'Removed by you', audit),
        audit('PlanActionRemoved', `${name} removed from revision ${rev.n}${body.reason ? ` (${body.reason.slice(0, 80)})` : ''}; it stays in the revision history`, { revisionId, actionId: a.actionId }));
      break;
    }
    case 'RESTORE': {
      if (a.state !== 'REMOVED') throw new ApiError(409, 'NOT_EDITABLE', 'Only a removed action can be restored');
      assertTransition('Action', 'REMOVED', 'PROPOSED');
      next = { ...a, state: 'PROPOSED', decision: 'IN', removedReason: null };
      notes.push(`Back in the plan as proposed · ${a.authority.reasons[0]}`);
      ops.push(actUpdate(a, { state: 'PROPOSED', decision: 'IN', removedReason: null }), audit('PlanActionRestored', `${name} restored to revision ${rev.n}; it needs approval again`, { revisionId, actionId: a.actionId }));
      break;
    }
    case 'INCLUDE_CONSIDERED': {
      if (a.decision !== 'OUT' || a.state !== 'PROPOSED' || !a.consideredReason) throw new ApiError(409, 'NOT_EDITABLE', 'Only an action Headroom considered and left out can be asked for');
      if (a.authority.decision === 'BLOCK') throw new ApiError(409, 'HARD_STOP', a.authority.reasons[0]);
      next = { ...a, decision: 'IN', consideredReason: null };
      notes.push(`Included at your request · ${a.authority.reasons[0]}`);
      ops.push(actUpdate(a, { decision: 'IN', consideredReason: null }), audit('PlanActionRestored', `${name} included at your request (Headroom had left it out)`, { revisionId, actionId: a.actionId }));
      break;
    }
    case 'USE_ALTERNATIVE': {
      const alt = acts.find((x) => x.rootId === body.alternativeRootId);
      if (!alt || !a.alternatives.includes(alt.rootId) || alt.decision === 'IN') throw new ApiError(409, 'NOT_EDITABLE', 'That alternative is not available');
      if (alt.authority.decision === 'BLOCK') throw new ApiError(409, 'HARD_STOP', alt.authority.reasons[0]);
      if (a.state === 'REMOVED' || a.decision === 'OUT') throw new ApiError(409, 'NOT_EDITABLE', 'Only an included action can be swapped');
      assertTransition('Action', a.state, 'REMOVED');
      next = { ...a, state: 'REMOVED', decision: 'OUT', removedReason: `Replaced by ${alt.counterparty.name}` };
      ops.push(actUpdate(a, { state: 'REMOVED', decision: 'OUT', removedReason: next.removedReason }), ...lapseOps(activeGrantsOf(s, a), 'Replaced by an alternative', audit),
        actUpdate(alt, { state: 'PROPOSED', decision: 'IN', consideredReason: null, removedReason: null }),
        audit('PlanActionRemoved', `${name} swapped for ${alt.counterparty.name}; both stay in the revision history`, { revisionId, actionId: a.actionId }));
      notes.push(`${alt.counterparty.name} is in the plan instead · ${alt.authority.reasons[0]}`);
      break;
    }
  }
  const touched = new Set([a.actionId, ...(body.op === 'USE_ALTERNATIVE' ? acts.filter((x) => x.rootId === body.alternativeRootId).map((x) => x.actionId) : [])]);
  const after = acts.map((x): PlanAction => (x.actionId === a.actionId ? next : body.op === 'USE_ALTERNATIVE' && x.rootId === body.alternativeRootId ? { ...x, state: 'PROPOSED', decision: 'IN', consideredReason: null, removedReason: null } : x));
  // S4-IM-02: an edit, include, restore or removal changes the total offered, so every other live offer is decided again.
  for (const o of recheckOffers(after, s)) {
    if (touched.has(o.actionId)) continue;
    const cur = acts.find((x) => x.actionId === o.actionId)!;
    const needs = running && RUNNING_STATES.includes(cur.state) && o.authority.grantKinds.some((k) => !s.grants.some((g) => g.kind === k && grantCovers(g, { ...cur, authority: o.authority }, c.now)));
    ops.push(actUpdate(cur, { authority: o.authority, why: o.why, ...(needs ? { state: 'PROPOSED' as const } : {}) }));
    notes.push(`${o.counterparty.name}: ${o.authority.decision === 'EXCEPTION' ? `now an exception · ${o.authority.reasons[0]}` : 'back within your delegation'}`);
  }
  // S4-IM-07: never persist an action the shared contract would refuse to read back.
  { const { pk: _p, sk: _s, ...checked } = next as ActItem; PlanAction.parse(checked); }
  return {
    status: 200, conflict: new ApiError(409, 'VERSION_CONFLICT', 'The plan changed; reload'),
    body: { revisionId, revisionVersion: rev.version + 1, actionId: a.actionId, actionVersion: a.version + 1, state: next.state, notes, newApprovals: next.authority.grantKinds.map((k) => KIND_TEXT[k]), ifAllMet: { before: ifAllMet(s, acts), after: ifAllMet(s, after) } },
    ops,
  };
}

// ---------- approve (T8, §6.17 R1/R2) ----------
export interface Consent { mode: 'ACTIVATE' | 'REAPPROVE'; selected: string[]; hash: string; basisStamp: number; planVersion: number; policyVersion: number; basisMoved: boolean; newGrants: { actionId: string; kind: GrantKind }[]; carried: { grantId: string; actionId: string }[] }

/** The consent the dialog shows and the command re-derives. `basisMoved`: the cash picture changed since the revision was built. */
export function consentOf(s: PlanState, rev: RevItem): Consent | null {
  if (rev.state !== 'DRAFT' && rev.state !== 'RUNNING') return null;
  const mode = rev.state === 'DRAFT' ? 'ACTIVATE' : 'REAPPROVE';
  // S4-IM-05: approved work whose authority lapsed with time (expired grant) is selectable for renewal too.
  // S6 R4: a payout whose supplier PayPal address isn't confirmed (or changed since the action was built) gets no payout grant yet.
  const payeeReady = (a: ActItem) => a.kind !== 'PAYOUT' || s.payees.some((p) => p.supplierId === a.counterparty.id && p.state === 'CONFIRMED' && p.version === a.terms.payee?.version);
  const eligible = actsOf(s, rev.revisionId).filter((a) => a.decision === 'IN' && payeeReady(a) && (a.state === 'PROPOSED' || (rev.state === 'RUNNING' && RUNNING_STATES.includes(a.state) && missingKinds(a, s.grants, s.ctx.now).length > 0)));
  const cur = basisHashOf(s);
  const prevRunning = mode === 'ACTIVATE' && s.plan.running ? s.plan.running : null;
  const newGrants: Consent['newGrants'] = [];
  const carried: Consent['carried'] = [];
  for (const a of eligible) for (const k of a.authority.grantKinds) {
    const have = s.grants.find((g) => g.kind === k && grantCovers(g, a, s.ctx.now));
    const carry = !have && prevRunning ? s.grants.find((g) => g.kind === k && grantCovers(g, { ...a, revisionId: prevRunning }, s.ctx.now)) : undefined;
    if (carry) carried.push({ grantId: carry.grantId, actionId: a.actionId });
    else if (!have) newGrants.push({ actionId: a.actionId, kind: k });
  }
  const hash = sha([rev.revisionId, rev.version, mode, eligible.map((a) => [a.actionId, a.version, a.termsHash, a.authority.decision, a.authority.grantKinds]), s.policy.version, cur, s.plan.basisStamp]);
  // R7/S6-IM-01: re-approving only payouts of the running plan (after a refusal, a revoke or an expiry) doesn't depend on the cash picture
  // the plan was built on: each payout is re-checked against live funds before it is paid.
  const payoutsOnly = mode === 'REAPPROVE' && eligible.length > 0 && eligible.every((a) => a.kind === 'PAYOUT');
  return { mode, selected: eligible.map((a) => a.actionId), hash, basisStamp: s.plan.basisStamp, planVersion: s.plan.version, policyVersion: s.policy.version, basisMoved: cur !== rev.basisHash && !payoutsOnly, newGrants, carried };
}

export function grantScope(a: PlanAction, kind: GrantKind, n: number): string {
  const t = a.terms;
  switch (kind) {
    case 'CONTACT_SPACING': return `Send ${a.counterparty.name} this one reminder on ${dayName(t.contactOn!)} although your contact-spacing rule would wait · this reminder only · your rule is unchanged · revision ${n}`;
    case 'COLLECT_DISPUTED': return `Ask ${a.counterparty.name} for ${money(t.amount.minor)} of the amount they dispute by ${dayName(t.targetOn!)} · this ask only · revision ${n}`;
    case 'COLLECT_SLICE': return `Ask ${a.counterparty.name} for ${money(t.amount.minor)} (the undisputed part only) by ${dayName(t.targetOn!)} · revision ${n}`;
    case 'MESSAGE_AS_WRITTEN': return `Send the ${a.counterparty.name} message exactly as written · revision ${n}`;
    case 'DISCOUNT_OFFER': return `Offer ${a.counterparty.name} ${t.discountBp! / 100}% (${money(t.discountAmount!.minor)}) to pay ${money(t.amount.minor)} by ${dayName(t.payBy!)} · revision ${n}`;
    // R4/R9: the scope names the maximum debit and the payment version; the exact address is shown in the dialog, never stored in audit text.
    // S6-IM-05: the scope states the most that may leave PayPal (bound in the terms hash), without fee wording (owner, 2 Nov 2026).
    case 'PAYOUT_AUTHORITY': return `Pay ${a.counterparty.name} ${money(t.amount.minor)}${t.maxDebit ? ` (up to ${money(t.maxDebit.minor)} may leave PayPal)` : ''} on ${dayName(t.payBy!)} to the PayPal address you confirmed · this bill only · payment ${t.paymentVersion ?? 1} · revision ${n}`;
    case 'PAYOUT_EXCEPTION': return `One-time exception to your payment limits for this ${money(t.amount.minor)} payout (up to ${money(t.maxDebit?.minor ?? t.amount.minor)} may leave PayPal; payment ${t.paymentVersion ?? 1}) · your limits are unchanged · revision ${n}`;
  }
}

export async function approveRevision(rc: ReadCtx, c: CommandCtx, revisionId: string, ifMatch: string | undefined, body: { selected: string[]; consentHash: string }): Promise<CommandResult> {
  const s = await loadPlanState(rc);
  const rev = revisionOf(s, revisionId);
  checkVersion(rev, ifMatch);
  const k = consentOf(s, rev);
  if (!k) throw new ApiError(409, 'REVISION_NOT_DRAFT', `Revision ${rev.n} is ${rev.state.toLowerCase()}`);
  if (k.basisMoved) throw new ApiError(409, 'CONSENT_CHANGED', `Your cash picture changed since revision ${rev.n} was built. Build revision ${s.plan.nextN} and review it`);
  if (!k.selected.length) throw new ApiError(422, 'NOTHING_SELECTED', 'Nothing in this revision is waiting for your approval');
  if ([...body.selected].sort().join() !== [...k.selected].sort().join()) throw new ApiError(409, 'CONSENT_CHANGED', 'The actions waiting for approval changed; review the dialog again');
  if (body.consentHash !== k.hash) throw new ApiError(409, 'CONSENT_CHANGED', 'Something you approved changed (an edit, a rule or a pause); review the dialog again');
  const audit = auditOf(c);
  const pk = s.pk;
  const seq = rev.approvals + 1;
  const acts = actsOf(s, rev.revisionId);
  const selected = acts.filter((a) => k.selected.includes(a.actionId));
  const expiresAt = addMs(c.now, GRANT_DAYS * DAY);
  const ops: Op[] = [
    fenceCheck(c),
    // R1: one PLAN condition serializes this against every source write (bills, commitments, invoices, policy, pauses) and builds.
    { op: 'update', table: 'core', pk, sk: 'PLAN', set: { version: s.plan.version + 1, ...(k.mode === 'ACTIVATE' ? { running: rev.revisionId, draft: null } : {}) }, cond: { eq: { version: k.planVersion, basisStamp: k.basisStamp } } },
    revBump(rev, { approvals: seq, approvedAt: c.now, approvedBy: c.ownerEmail, ...(k.mode === 'ACTIVATE' ? { state: 'RUNNING' } : {}) }),
  ];
  if (k.mode === 'ACTIVATE') assertTransition('PlanRevision', 'DRAFT', 'RUNNING');
  for (const a of selected) {
    if (a.kind === 'PAYOUT' && a.state === 'HELD') {
      // S6-IM-01: a held payout re-approved goes back to SCHEDULED with a new intent and its PAY job (runs now if its date passed).
      const iv = a.intentVersion + 1;
      assertTransition('Action', 'HELD', 'SCHEDULED');
      ops.push(actUpdate(a, { state: 'SCHEDULED', intentVersion: iv, holdCode: null, heldReasons: [] }), ...dueJobOps(a, iv, { tenantId: c.tenantId, runId: c.run.runId, now: c.now, tz: c.run.settings.timeZone, window: windowOf(s.policy) }));
      continue;
    }
    if (a.state !== 'PROPOSED') { ops.push(actUpdate(a, {})); continue; } // renewal: state unchanged, version fenced
    // S5-D24/T1: approval moves the intent and schedules its due work; an older intent's jobs then no-op.
    const iv = a.intentVersion + 1;
    assertTransition('Action', 'PROPOSED', approvedState(a)); ops.push(actUpdate(a, { state: approvedState(a), intentVersion: iv }));
    ops.push(...dueJobOps(a, iv, { tenantId: c.tenantId, runId: c.run.runId, now: c.now, tz: c.run.settings.timeZone, window: windowOf(s.policy) }));
  }
  const grants: Grant[] = k.newGrants.map(({ actionId, kind }) => {
    const a = selected.find((x) => x.actionId === actionId)!;
    const grantId = `${rev.revisionId}#${seq}#${actionId}#${kind}`;
    return { grantId, kind, revisionId: rev.revisionId, approvalSeq: seq, actionId, rootId: a.rootId, objectRef: a.subject.invoiceId ?? a.subject.occurrenceKey ?? a.rootId, termsHash: a.termsHash, policyVersion: s.policy.version, scope: grantScope(a, kind, rev.n), by: c.ownerEmail, at: c.now, expiresAt, state: 'ACTIVE', revokedAt: null, lapsedReason: null, carriedTo: [], consumedBy: null };
  });
  ops.push({ op: 'put', table: 'core', item: { pk, sk: `APPROVAL#${rev.revisionId}#${String(seq).padStart(3, '0')}`, revisionId: rev.revisionId, seq, mode: k.mode, selected: k.selected, consentHash: k.hash, grantIds: grants.map((g) => g.grantId), by: c.ownerEmail, at: c.now }, cond: { notExists: true } });
  for (const g of grants) ops.push({ op: 'put', table: 'core', item: { pk, sk: `GRANT#${g.grantId}`, ...g }, cond: { notExists: true } }, audit('GrantRecorded', `${KIND_TEXT[g.kind]}: ${g.scope} · expires ${dayName(g.expiresAt)}`, { grantId: g.grantId, revisionId }));
  if (k.mode === 'ACTIVATE' && s.plan.running) {
    const prev = revisionOf(s, s.plan.running);
    assertTransition('PlanRevision', 'RUNNING', 'SUPERSEDED');
    ops.push({ op: 'update', table: 'core', pk, sk: prev.sk, set: { state: 'SUPERSEDED', version: prev.version + 1 }, cond: { eq: { version: prev.version, state: 'RUNNING' } } }, audit('PlanRevisionSuperseded', `Revision ${prev.n} replaced by revision ${rev.n}`, { revisionId: prev.revisionId }));
    // S5-D12: executed and in-flight actions persist across revisions; only unexecuted ones are superseded.
    for (const a of actsOf(s, prev.revisionId)) if (a.state !== 'SUPERSEDED' && !EXECUTED_ACTION_STATES.includes(a.state)) ops.push(actUpdate(a, { state: 'SUPERSEDED' }));
    const carriedIds = new Set(k.carried.map((x) => x.grantId));
    for (const g of activeGrantsOf2(s, prev.revisionId)) {
      if (carriedIds.has(g.grantId)) ops.push({ op: 'update', table: 'core', pk, sk: g.sk, set: { carriedTo: [...g.carriedTo, rev.revisionId] }, cond: { eq: { state: 'ACTIVE' } } });
      else ops.push(...lapseOps([g], acts.some((a) => a.rootId === g.rootId) ? `terms changed in revision ${rev.n}` : `not in revision ${rev.n}`, audit));
    }
  }
  ops.push(audit('PlanRevisionApproved', `${k.mode === 'ACTIVATE' ? `Revision ${rev.n} is running` : `Revision ${rev.n}: approved again`} · ${selected.length} action${selected.length === 1 ? '' : 's'} approved, ${grants.length} permission${grants.length === 1 ? '' : 's'} recorded separately${k.carried.length ? `, ${k.carried.length} carried over unchanged` : ''}. Each action runs only at its own time, after its own checks`, { revisionId, approval: String(seq) }));
  return {
    status: 200, conflict: new ApiError(409, 'CONSENT_CHANGED', 'The plan or your cash picture changed while you were approving; review it again'),
    body: { revisionId, state: k.mode === 'ACTIVATE' ? 'RUNNING' : rev.state, revisionVersion: rev.version + 1, approval: seq, grants: grants.map((g) => ({ grantId: g.grantId, kind: g.kind, scope: g.scope })), carried: k.carried.length },
    ops,
  };
}
const activeGrantsOf2 = (s: PlanState, revisionId: string) => s.grants.filter((g) => g.state === 'ACTIVE' && (g.revisionId === revisionId || g.carriedTo.includes(revisionId)));

// ---------- reject (T9), revoke (T10) ----------
export async function rejectRevision(rc: ReadCtx, c: CommandCtx, revisionId: string, ifMatch: string | undefined, body: { reason?: string }): Promise<CommandResult> {
  const s = await loadPlanState(rc);
  const rev = revisionOf(s, revisionId);
  checkVersion(rev, ifMatch);
  if (rev.state !== 'DRAFT') throw new ApiError(409, 'REVISION_NOT_DRAFT', 'Only a draft revision can be rejected');
  assertTransition('PlanRevision', 'DRAFT', 'REJECTED');
  return {
    status: 200, body: { revisionId, state: 'REJECTED', revisionVersion: rev.version + 1 },
    ops: [
      fenceCheck(c),
      { op: 'update', table: 'core', pk: s.pk, sk: 'PLAN', set: { draft: null, version: s.plan.version + 1 }, cond: { eq: { version: s.plan.version, draft: rev.revisionId } } },
      revBump(rev, { state: 'REJECTED', rejectedAt: c.now, rejectedReason: body.reason?.slice(0, 200) ?? null }),
      auditOf(c)('PlanRevisionRejected', `Revision ${rev.n} rejected${body.reason ? ` (${body.reason.slice(0, 80)})` : ''}. ${s.plan.running ? 'The running revision keeps going unchanged' : 'Nothing runs'}`, { revisionId }),
    ],
  };
}

export async function revokeGrant(rc: ReadCtx, c: CommandCtx, grantId: string, body: { reason?: string }): Promise<CommandResult> {
  if (/^(bill|terms):/.test(grantId)) throw new ApiError(409, 'NOT_EDITABLE', 'A bill verification or accepted terms is a record of what happened; it can’t be revoked');
  const s = await loadPlanState(rc);
  const g = s.grants.find((x) => x.grantId === grantId);
  if (!g) throw new ApiError(404, 'NOT_FOUND', 'No such permission');
  if (g.state !== 'ACTIVE') throw new ApiError(409, 'GRANT_NOT_ACTIVE', `This permission is already ${g.state.toLowerCase()}`);
  assertTransition('Grant', 'ACTIVE', 'REVOKED');
  const audit = auditOf(c);
  const ops: Op[] = [fenceCheck(c), { op: 'update', table: 'core', pk: s.pk, sk: g.sk, set: { state: 'REVOKED', revokedAt: c.now }, cond: { eq: { state: 'ACTIVE' } } }];
  const run = s.plan.running ? revisionOf(s, s.plan.running) : undefined;
  const a = run && (g.revisionId === run.revisionId || g.carriedTo.includes(run.revisionId)) ? actsOf(s, run.revisionId).find((x) => x.rootId === g.rootId) : undefined;
  if (run && a && RUNNING_STATES.includes(a.state)) { assertTransition('Action', a.state, 'PROPOSED'); ops.push(actUpdate(a, { state: 'PROPOSED' }), revBump(run)); }
  ops.push(audit('GrantRevoked', `${KIND_TEXT[g.kind]} revoked${body.reason ? ` (${body.reason.slice(0, 80)})` : ''}: ${g.scope}${a ? ' · the action needs your approval again' : ''}`, { grantId }));
  return { status: 200, body: { grantId, state: 'REVOKED' }, ops };
}
