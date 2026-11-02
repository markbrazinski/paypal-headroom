// S5-D9: one pure authority check shared by every stage (skip decision, queue, dispatch claim). The caller re-asserts the same
// items as TX conditions (POLICY version + pauses, THREAD#, grant/OWNERAUTH state, action version); this decides what they mean.
// Reconcile and the bound removal never call it: they act under the authority frozen at the dispatch claim.
import type { EffectAuthority, Grant, GrantKind, HoldCode, PlanAction, PolicyDecision } from '@headroom/contracts';
import type { Op } from '../../adapters/store/port.ts';
import { K } from '../../adapters/store/keys.ts';
import type { Deps } from '../../deps.ts';
import { connectionFor, getRun } from '../identity-run/run.ts';
import type { ReadCtx } from '../../read/models.ts';
import { decideAsk, decideCollect, decideDisputed, decideOffer, decideSlice } from '../delegation/policy.ts';
import { grantCovers, otherConcessionsMinor, type ActItem, type PlanState } from './state.ts';

export type Stage = 'SKIP' | 'QUEUE' | 'DISPATCH';
/** What authorizes the effect: the update or offer itself (EFFECT) or the message that follows it (MESSAGE). */
export type Purpose = 'EFFECT' | 'MESSAGE';

export interface AuthorityCtx {
  stage: Stage;
  purpose: Purpose;
  action: Pick<PlanAction, 'kind' | 'rootId' | 'revisionId' | 'termsHash' | 'authority' | 'counterparty'>;
  runningRevisionId: string | null;
  now: string;
  paused: boolean;
  threadOwner: 'HEADROOM' | 'YOU';
  /** The action's decision re-derived under the CURRENT policy (A-002: an in-limit offer is authorized by policy at dispatch). */
  current: PolicyDecision;
  grants: Grant[];
  ownerAuth: { id: string; termsHash: string; state: string } | null;
  /** QUEUE/DISPATCH of a provider write: the invoice can still take it. */
  invoice: { payable: boolean; why: string } | null;
}
export type AuthorityResult = { ok: true; authority: EffectAuthority; grant: Grant | null } | { ok: false; code: HoldCode; text: string };

const no = (code: HoldCode, text: string): AuthorityResult => ({ ok: false, code, text });

/**
 * The grant kind this purpose spends, if the current decision requires one: COLLECT_SLICE for the slice update; MESSAGE_AS_WRITTEN
 * for a review-first message (the slice message never re-spends COLLECT_SLICE); DISCOUNT_OFFER for an offer beyond the limits.
 */
function kindFor(a: AuthorityCtx['action'], purpose: Purpose, current: PolicyDecision): GrantKind | null {
  const k: GrantKind | null = purpose === 'MESSAGE' ? 'MESSAGE_AS_WRITTEN' : a.kind === 'COLLECT_UNDISPUTED_SLICE' ? 'COLLECT_SLICE' : a.kind === 'COLLECT_DISPUTED' ? 'COLLECT_DISPUTED' : a.kind === 'DISCOUNT_FALLBACK' ? 'DISCOUNT_OFFER' : null;
  return k && current.grantKinds.includes(k) ? k : null;
}

export function authorize(x: AuthorityCtx): AuthorityResult {
  const a = x.action;
  if (x.runningRevisionId !== a.revisionId) return no('NOT_AUTHORIZED', 'Not in the running plan');
  if (x.paused) return no('PAUSED', 'Outreach is paused');
  if (x.threadOwner === 'YOU') return no('YOU_TOOK_OVER', `You took over ${a.counterparty.name}`);
  if (x.stage !== 'SKIP' && x.purpose === 'EFFECT' && x.invoice && !x.invoice.payable) return no('INVOICE_NOT_PAYABLE', x.invoice.why);
  if (x.ownerAuth) {
    if (x.ownerAuth.state === 'ACTIVE' && x.ownerAuth.termsHash === a.termsHash) return { ok: true, authority: { kind: 'OWNER', id: x.ownerAuth.id, policyVersion: null, winningRule: null }, grant: null };
    return no('NOT_AUTHORIZED', 'Your one-time approval was already used or no longer matches');
  }
  if (x.current.decision === 'BLOCK') return no('NOT_AUTHORIZED', x.current.reasons[0] ?? 'Blocked by a hard stop');
  const kind = kindFor(a, x.purpose, x.current);
  // No grant needed for this purpose: the delegation rule authorizes it (A-002); the slice message also needs its update verified (caller).
  if (!kind) return { ok: true, authority: { kind: 'POLICY', id: null, policyVersion: x.current.policyVersion, winningRule: `${x.current.winning.key} · ${x.current.winning.label}` }, grant: null };
  const g = x.grants.find((gr) => gr.kind === kind && grantCovers(gr, { ...a, authority: x.current }, x.now));
  if (g) return { ok: true, authority: { kind: 'GRANT', id: g.grantId, policyVersion: null, winningRule: null }, grant: g };
  // Approved under policy but the rules are now tighter: never sent on the old approval (S5-R12).
  if (a.authority.decision === 'ALLOW') return no('RULES_CHANGED', 'Needs your approval (rules changed)');
  return no('NOT_AUTHORIZED', 'Your permission for this was revoked, used, lapsed or expired');
}


// ---------- loaders for the worker stages (S5-D9): the decision under the CURRENT policy and the TX conditions that fence it ----------

/** A worker's read context for a run (same as the plan build's). */
export async function planCtxFor(d: Pick<Deps, 'store' | 'config' | 'now' | 'evidence'>, tenantId: string, runId: string): Promise<ReadCtx | null> {
  const run = await getRun(d.store, tenantId, runId);
  return run ? { store: d.store, config: d.config, tenantId, run, connectionId: await connectionFor(d.store, tenantId), email: 'headroom', now: d.now(), evidence: d.evidence } : null;
}

/** The action's decision re-derived under the current policy, exactly as S4 decides it (A-002: recheck at dispatch). */
export function currentDecision(s: PlanState, a: ActItem): PolicyDecision {
  const tier = s.assessments.get(a.counterparty.id)?.tier ?? 'NOT_ENOUGH_HISTORY';
  // S7a-IR-07: a full-amount reminder approved before a dispute was confirmed never asks for the disputed money.
  if (a.kind === 'COLLECT_OVERDUE') return s.claims.some((c) => c.invoiceId === a.subject.invoiceId) ? { ...decideCollect(s.policy, tier), decision: 'BLOCK', reasons: ['This invoice now has a confirmed dispute: the full-amount reminder is superseded; build a new revision'], grantKinds: [] } : decideCollect(s.policy, tier);
  if (a.kind === 'COLLECT_UNDISPUTED_SLICE') return decideSlice(s.policy, tier, a.counterparty.id);
  if (a.kind === 'COLLECT_DISPUTED') return decideDisputed(s.policy, tier, a.counterparty.id);
  if (a.kind === 'ASK_SUPPLIER') return decideAsk(s.policy);
  const inv = s.invoices.find((i) => i.invoiceId === a.subject.invoiceId);
  const live = s.actions.filter((x) => x.revisionId === a.revisionId);
  return decideOffer(s.policy, tier, a.counterparty.id, inv?.openGross.minor ?? a.terms.amount.minor + (a.terms.discountAmount?.minor ?? 0), a.terms.discountBp!, otherConcessionsMinor(live, a.rootId));
}

/** Authority at `stage` plus the conditions a decide/claim TX re-asserts (policy version incl. pauses, thread owner, action version). */
export async function authorityFor(s: PlanState, a: ActItem, stage: Stage, purpose: Purpose, o: { invoice?: AuthorityCtx['invoice']; ownerAuth?: AuthorityCtx['ownerAuth'] } = {}): Promise<{ res: AuthorityResult; conds: Op[] }> {
  const thread = await s.ctx.store.get('core', s.pk, `THREAD#${a.counterparty.id}`);
  // S7 R4: a dispute email waiting for the owner stops every claim on that invoice (fenced: a new pending after this read fails the TX).
  const inv = a.subject.invoiceId;
  const pending = inv ? await s.ctx.store.get('core', s.pk, `DISPUTEPENDING#${inv}`) : undefined;
  const disputeConds: Op[] = !inv ? [] : [pending ? { op: 'check', table: 'core', pk: s.pk, sk: pending.sk, cond: { eq: { version: pending.version } } } : { op: 'check', table: 'core', pk: s.pk, sk: `DISPUTEPENDING#${inv}`, cond: { notExists: true } }];
  if (pending?.state === 'PENDING') return { res: no('DISPUTE_PENDING', 'Dispute waiting for you: confirm or dismiss it on Receivables'), conds: disputeConds };
  const res = authorize({
    stage, purpose, action: a, runningRevisionId: s.plan.running, now: s.ctx.now, paused: s.policy.pauses.outreach,
    threadOwner: thread?.owner ?? 'HEADROOM', current: currentDecision(s, a), grants: s.grants, ownerAuth: o.ownerAuth ?? null, invoice: o.invoice ?? null,
  });
  const conds: Op[] = [
    { op: 'check', table: 'core', pk: s.pk, sk: 'POLICY', cond: { eq: { version: s.policy.version } } },
    thread ? { op: 'check', table: 'core', pk: s.pk, sk: thread.sk, cond: { eq: { version: thread.version, owner: thread.owner } } } : { op: 'check', table: 'core', pk: s.pk, sk: `THREAD#${a.counterparty.id}`, cond: { notExists: true } },
    ...disputeConds,
  ];
  return { res, conds };
}
/** The action's own fence: unchanged since it was read. */
export const actionCheck = (a: ActItem): Op => ({ op: 'check', table: 'core', pk: a.pk, sk: a.sk, cond: { eq: { version: a.version, state: a.state } } });
export const runFenceCheck = (tenantId: string, epoch: number): Op => ({ op: 'check', table: 'core', pk: K.tenant(tenantId), sk: 'RUN_FENCE', cond: { eq: { epoch } } });
