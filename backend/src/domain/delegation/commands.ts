// Delegation commands (S04 T10): preview (no write), rule change and pauses. Each change is a new immutable POLICYV#, bumps the PLAN
// basis stamp (so an open approval dialog is refused, §6.17 R1) and is audited with "loosens". Hard stops have no key to address.
import { createHash } from 'node:crypto';
import type { PlanAction, Policy, PolicyKey } from '@headroom/contracts';
import type { Op } from '../../adapters/store/port.ts';
import { ApiError } from '../../api-error.ts';
import type { ReadCtx } from '../../read/models.ts';
import { auditOp } from '../audit/audit.ts';
import { fenceCheck, type CommandCtx, type CommandResult } from '../receivables/commands.ts';
import { basisBumpOp, loadPlanState, otherConcessionsMinor, type PlanState } from '../plan/state.ts';
import { applyPause, applyRuleChange, decideAsk, decideCollect, decideDisputed, decideOffer, decidePayout, decideSlice, type RuleChange } from './policy.ts';
import { RULE_SPECS } from './specs.ts';
import { maxDebitMinor } from '../payables/payout-core.ts';

const sha = (x: unknown) => createHash('sha256').update(JSON.stringify(x)).digest('hex');

/** An action's authority under a given policy (the same decide functions the build used). */
export function authorityUnder(p: Policy, s: PlanState, a: PlanAction): PlanAction['authority'] {
  const tier = s.assessments.get(a.counterparty.id)?.tier ?? 'NOT_ENOUGH_HISTORY';
  if (a.kind === 'COLLECT_OVERDUE') return decideCollect(p, tier);
  if (a.kind === 'COLLECT_UNDISPUTED_SLICE') return decideSlice(p, tier, a.counterparty.id);
  if (a.kind === 'COLLECT_DISPUTED') return decideDisputed(p, tier, a.counterparty.id);
  if (a.kind === 'ASK_SUPPLIER') return decideAsk(p);
  if (a.kind === 'DISCOUNT_FALLBACK') { const inv = s.invoices.find((i) => i.invoiceId === a.subject.invoiceId); return decideOffer(p, tier, a.counterparty.id, inv?.openGross.minor ?? a.terms.amount.minor, a.terms.discountBp!, otherConcessionsMinor(s.actions.filter((x) => x.revisionId === a.revisionId), a.rootId)); }
  return decidePayout(p, a.counterparty.id, a.terms.maxDebit?.minor ?? maxDebitMinor(a.terms.amount.minor), 0, a.terms.amount.minor);
}

/** Live work a policy change would touch: the running and draft revisions' included actions. */
const liveActions = (s: PlanState) => s.actions.filter((a) => (a.revisionId === s.plan.running || a.revisionId === s.plan.draft) && a.decision === 'IN' && a.state !== 'REMOVED' && a.state !== 'SUPERSEDED');

/** A decision's substance, ignoring which policy version produced the same answer. */
export const sameDecision = (a: PlanAction['authority'], b: PlanAction['authority']) => {
  const norm = (d: PlanAction['authority']) => JSON.stringify([d.decision, d.grantKinds, d.reasons.map((r) => r.replace(/Delegation v\d+/g, 'Delegation'))]);
  return norm(a) === norm(b);
};

export function affectedBy(s: PlanState, next: Policy) {
  return liveActions(s).flatMap((a) => {
    const [was, now] = [authorityUnder(s.policy, s, a), authorityUnder(next, s, a)];
    if (sameDecision(was, now)) return [];
    const gone = was.reasons.filter((r) => !now.reasons.includes(r));
    const added = now.reasons.filter((r) => !was.reasons.includes(r));
    const still = now.grantKinds.length ? ` (still needs ${now.grantKinds.includes('PAYOUT_EXCEPTION') ? 'payout authority and an exception' : 'your approval'})` : '';
    return [{ label: `${a.counterparty.name} · ${a.kind === 'PAYOUT' ? 'payout' : 'action'}`, before: was.reasons.join('; '), after: `${gone.length ? `No longer: ${gone.join('; ')}` : ''}${added.length ? `${gone.length ? ' · ' : ''}Now: ${added.join('; ')}` : ''}${still}`, ref: a.actionId }];
  });
}

const previewHashOf = (p: Policy, ch: RuleChange) => sha([p.version, ch.key, ch.scope, ch.value]);

export async function previewPolicyChange(rc: ReadCtx, ch: RuleChange) {
  const s = await loadPlanState(rc);
  const r = applyRuleChange(s.policy, ch, rc.email, rc.now);
  if ('refused' in r) throw new ApiError(r.refused === 'NOT_EDITABLE' ? 409 : 400, r.refused, r.message);
  return { key: ch.key, before: r.before, after: r.after, loosens: r.loosens, safety: r.safety, safetyText: r.safety ? RULE_SPECS[ch.key].safetyText ?? null : null, affected: affectedBy(s, r.policy), previewHash: previewHashOf(s.policy, ch), policyVersion: s.policy.version };
}

const policyOps = (s: PlanState, next: Policy, c: CommandCtx): Op[] => [
  fenceCheck(c),
  { op: 'put', table: 'core', item: { ...next, pk: s.pk, sk: 'POLICY' }, cond: { eq: { version: s.policy.version } } },
  { op: 'put', table: 'core', item: { ...next, pk: s.pk, sk: `POLICYV#${String(next.version).padStart(4, '0')}` }, cond: { notExists: true } },
  basisBumpOp(s.pk),
];
const checkPolicyVersion = (s: PlanState, ifMatch: string | undefined) => {
  if (ifMatch === undefined || Number(ifMatch.replace(/"/g, '')) !== s.policy.version) throw new ApiError(409, 'VERSION_CONFLICT', `Delegation is at version ${s.policy.version}; reload`);
};

export async function changePolicy(rc: ReadCtx, c: CommandCtx, ifMatch: string | undefined, body: RuleChange & { previewHash: string; acknowledgeSafety?: boolean }): Promise<CommandResult> {
  const s = await loadPlanState(rc);
  checkPolicyVersion(s, ifMatch);
  const r = applyRuleChange(s.policy, body, c.ownerEmail, c.now);
  if ('refused' in r) throw new ApiError(r.refused === 'NOT_EDITABLE' ? 409 : 400, r.refused, r.message);
  if (body.previewHash !== previewHashOf(s.policy, body)) throw new ApiError(409, 'CONSENT_CHANGED', 'The preview is out of date; review the change again');
  // S7-D3: loosening a safety rule is its own explicit act ("I understand"); tightening needs nothing extra.
  if (r.safety && body.acknowledgeSafety !== true) throw new ApiError(400, 'SAFETY_ACK_REQUIRED', 'This loosens a safety rule: confirm you understand what Headroom may then do');
  const affected = affectedBy(s, r.policy);
  return {
    status: 200, conflict: new ApiError(409, 'VERSION_CONFLICT', 'Delegation changed; reload'),
    body: { policyVersion: r.policy.version, loosens: r.loosens, affected },
    ops: [...policyOps(s, r.policy, c), auditOp({ tenantId: c.tenantId, runId: c.run.runId, type: 'PolicyChanged', by: 'OWNER', allowedBy: c.ownerEmail, result: `${r.safety ? 'This loosens a safety rule ·' : r.loosens ? 'This loosens' : 'Changed'} ${body.key as PolicyKey}: ${r.policy.change.before} → ${r.policy.change.after} (Delegation v${r.policy.version})${affected.length ? ` · affects ${affected.length} planned action${affected.length === 1 ? '' : 's'}` : ''}`, refs: { policyVersion: String(r.policy.version), key: body.key, ...(r.safety ? { safety: 'true', loosens: 'true' } : {}) }, correlationId: c.correlationId, now: c.now })],
  };
}

export async function setPause(rc: ReadCtx, c: CommandCtx, ifMatch: string | undefined, body: { kind: 'OUTREACH' | 'PAYMENTS'; on: boolean }): Promise<CommandResult> {
  const s = await loadPlanState(rc);
  checkPolicyVersion(s, ifMatch);
  const cur = body.kind === 'OUTREACH' ? s.policy.pauses.outreach : s.policy.pauses.payments;
  if (cur === body.on) throw new ApiError(409, 'VERSION_CONFLICT', `Already ${body.on ? 'paused' : 'running'}`);
  const next = applyPause(s.policy, body.kind, body.on, c.ownerEmail, c.now);
  // S5: resuming outreach releases what the pause held (actions, and a discount removal still on PayPal, S5-D25).
  const { releaseHolds, pull } = await import('../comms/commands.ts');
  const rel = body.kind === 'OUTREACH' && !body.on ? await releaseHolds(s, 'PAUSED', null) : { ops: [], jobs: [] };
  // S6: resuming payments re-runs payouts held by the pause (a HELD_READY effect returns to READY and its claim re-checks everything).
  const pay = body.kind === 'PAYMENTS' && !body.on ? await (await import('../payables/payout.ts')).releasePayoutHolds(rc, c.now, ['PAYMENTS_PAUSED']) : null;
  if (pay) rel.ops.push(...pay.ops);
  return {
    afterCommit: async () => { for (const j of rel.jobs) await pull(rc.store, j, c.now); await pay?.afterCommit(); },
    status: 200, conflict: new ApiError(409, 'VERSION_CONFLICT', 'Delegation changed; reload'),
    body: { policyVersion: next.version, pauses: next.pauses },
    ops: [...policyOps(s, next, c), ...rel.ops, auditOp({ tenantId: c.tenantId, runId: c.run.runId, type: 'PauseChanged', by: 'OWNER', allowedBy: c.ownerEmail, result: `${next.change.after}. ${body.on ? 'Nothing of that kind will run while it is on; approving is still allowed' : 'Planned work of that kind can run again once its own checks pass'}`, refs: { policyVersion: String(next.version) }, correlationId: c.correlationId, now: c.now })],
  };
}
