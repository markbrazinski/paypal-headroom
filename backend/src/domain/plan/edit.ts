// Owner edits to an action (S04 T5, §6.17 R5): per-kind fields, ordered feasible dates, recomputed authority, estimate and terms hash.
// Pure. Contract dates, provider facts and completed events are never editable fields.
import type { LocalDate, PlanAction, Policy, PolicyDecision, StatedInflow, Tier } from '@headroom/contracts';
import { ApiError } from '../../api-error.ts';
import type { TermsChange } from '../obligations/obligations.ts';
import { decideCollect, decideOffer, decideDisputed, decideSlice, discountMinor } from '../delegation/policy.ts';
import { addBusinessDays, earliestContact, windowOf, estimatedFeeMinor, isBusinessDay, REPLY_CHECK_BD } from './dates.ts';
import { dayName, money, withContactSpacing } from './candidates.ts';
import { termsHashOf, otherConcessionsMinor, type PlanState } from './state.ts';
import { messageFor, renderWhy, type DraftFacts } from './gates.ts';

export interface EditChanges { contactOn?: LocalDate; targetOn?: LocalDate; amountMinor?: number; discountBp?: number; message?: { subject: string; body: string } }
/** `lastContactAt`: the last confirmed send to this business (contact spacing, S7-UX1). */
export interface EditCtx { lastContactAt?: string | null; now: string; tz: string; needBy: LocalDate; policy: Policy; tier: Tier; undisputedMinor: number | null; openMinor: number | null; otherConcessionsMinor: number; facts: DraftFacts; businessName: string }
export const OFFER_BPS = [100, 200, 300, 500];
const ALLOWED: Record<PlanAction['kind'], (keyof EditChanges)[]> = {
  COLLECT_OVERDUE: ['contactOn', 'targetOn', 'message'],
  COLLECT_UNDISPUTED_SLICE: ['contactOn', 'targetOn', 'amountMinor', 'message'],
  COLLECT_DISPUTED: ['contactOn', 'targetOn', 'message'],
  ASK_SUPPLIER: ['message'],
  DISCOUNT_FALLBACK: ['discountBp', 'message'],
  PAYOUT: [],
};
const usd = (minor: number) => ({ currency: 'USD' as const, minor });
const bad = (msg: string) => new ApiError(400, 'INVALID_INPUT', msg);

export interface EditResult { action: PlanAction; changed: string[]; moved: string[]; stale: string[] }

export function editAction(a: PlanAction, ch: EditChanges, x: EditCtx): EditResult {
  const keys = (Object.keys(ch) as (keyof EditChanges)[]).filter((k) => ch[k] !== undefined);
  if (!keys.length) throw bad('Nothing to change');
  const refused = keys.filter((k) => !ALLOWED[a.kind].includes(k));
  if (refused.length) throw bad(a.kind === 'PAYOUT' ? 'A payout’s date and amount come from the obligation; they can’t be edited here' : `Not editable on this action: ${refused.join(', ')}`);
  const t = { ...a.terms };
  const moved: string[] = [];
  const stale: string[] = [];
  let estimate = a.estimate;
  let authority = a.authority;
  if (ch.contactOn || ch.targetOn) {
    const contact = ch.contactOn ?? t.contactOn!;
    const target = ch.targetOn ?? t.targetOn!;
    const earliest = earliestContact(x.now, x.tz, windowOf(x.policy)).on;
    if (!isBusinessDay(contact) || contact < earliest) throw bad(`Contact must be a business day from ${dayName(earliest)}`);
    if (!isBusinessDay(target) || target < contact) throw bad('The target must be a business day on or after the contact');
    // Overdue collections check for payment on the target day (owner, 2 Nov 2026); others check 3 business days after asking.
    const reply = a.kind === 'COLLECT_OVERDUE' ? target : [addBusinessDays(contact, REPLY_CHECK_BD), target].sort()[0];
    if (reply !== t.replyCheckOn) moved.push(`Headroom moved the reply check to ${dayName(reply)}`);
    Object.assign(t, { contactOn: contact, targetOn: target, replyCheckOn: reply });
    if (target >= x.needBy) stale.push(`The target is on or after ${dayName(x.needBy)}: this no longer helps the ${dayName(x.needBy)} gap`);
  }
  if (ch.amountMinor !== undefined) {
    if (x.undisputedMinor === 0) throw bad('A payment was already received on this invoice and Headroom can’t tell which part it settled, so nothing undisputed can be asked for');
    if (!Number.isInteger(ch.amountMinor) || ch.amountMinor < MIN_REQUEST_MINOR || x.undisputedMinor === null || ch.amountMinor > x.undisputedMinor) throw bad(`The amount must be between ${money(MIN_REQUEST_MINOR)} and the undisputed ${money(x.undisputedMinor ?? 0)}`);
    t.amount = usd(ch.amountMinor);
  }
  if (ch.discountBp !== undefined) {
    if (!OFFER_BPS.includes(ch.discountBp) || x.openMinor === null) throw bad(`Discount must be one of ${OFFER_BPS.map((b) => `${b / 100}%`).join(', ')}`);
    const disc = discountMinor(x.openMinor, ch.discountBp);
    Object.assign(t, { discountBp: ch.discountBp, discountAmount: usd(disc), amount: usd(x.openMinor - disc) });
  }
  if (a.kind !== 'PAYOUT') {
    const fee = estimatedFeeMinor(t.amount.minor);
    // S4-IM-07: a request that nets nothing after the estimated fee is refused before anything is saved; money is never negative here.
    if (t.amount.minor - fee <= 0) throw bad(`Too small: ${money(t.amount.minor)} would net nothing after PayPal's estimated ${money(fee)} fee (smallest request ${money(MIN_REQUEST_MINOR)})`);
    estimate = { gross: t.amount, fee: usd(fee), net: usd(t.amount.minor - fee) };
    authority = a.kind === 'COLLECT_OVERDUE' ? withContactSpacing(x.policy, a.counterparty.id, x.lastContactAt ?? null, t.contactOn, x.tz, decideCollect(x.policy, x.tier)) : a.kind === 'COLLECT_UNDISPUTED_SLICE' ? decideSlice(x.policy, x.tier, a.counterparty.id) : a.kind === 'COLLECT_DISPUTED' ? decideDisputed(x.policy, x.tier, a.counterparty.id)
      : decideOffer(x.policy, x.tier, a.counterparty.id, x.openMinor!, t.discountBp!, x.otherConcessionsMinor);
  }
  // S4-IM-01: the message and the Why are re-rendered from the NEW terms. The owner's own wording survives only an edit that changes no
  // term; otherwise it is replaced by Headroom's wording for the new terms and the card says so (never approved silently).
  const termsChanged = keys.some((k) => k !== 'message');
  let message = a.message;
  if (ch.message && a.message) message = { subject: ch.message.subject.slice(0, 160), body: ch.message.body.slice(0, 2_000), writtenBy: 'OWNER', opening: null, closing: null };
  else if (a.message && termsChanged) {
    const owner = a.message.writtenBy === 'OWNER';
    const m = messageFor({ kind: a.kind, counterparty: a.counterparty, terms: t }, x.facts, x.businessName, owner || !a.message.opening || !a.message.closing ? undefined : { opening: a.message.opening, closing: a.message.closing });
    message = { ...m, writtenBy: owner ? 'TEMPLATE' : a.message.writtenBy };
    if (owner) stale.push('Your own wording was written for the old terms, so Headroom replaced it with its wording for the new terms; edit the wording again if you want');
  }
  const late = t.targetOn && t.targetOn >= x.needBy ? `Too late to arrive before ${dayName(x.needBy)}; it still shrinks the later gap` : a.kind === 'DISCOUNT_FALLBACK' || a.kind === 'PAYOUT' ? a.late : null;
  const next: PlanAction = { ...a, terms: t, estimate, authority, message, late, ownerEdited: [...new Set([...a.ownerEdited, ...keys])], version: a.version + 1 };
  next.why = { ...a.why, text: renderWhy(next, a.why.codes, x.tz) };
  return { action: { ...next, termsHash: termsHashOf(next) }, changed: keys, moved, stale };
}

/** Smallest request whose net after the estimated fee is positive (3.49% + $0.49 → 52 cents). */
export const MIN_REQUEST_MINOR = 52;

/**
 * S4-IM-02: decide every live offer against the concessions of the OTHER live offers in the same revision, and return the actions
 * whose decision changed (authority and Why re-rendered). Exactly-at-cap stays within delegation.
 */
export function recheckOffers(acts: PlanAction[], s: PlanState, decide: (a: PlanAction, other: number) => PolicyDecision = (a, other) => {
  const inv = s.invoices.find((i) => i.invoiceId === a.subject.invoiceId);
  return decideOffer(s.policy, s.assessments.get(a.counterparty.id)?.tier ?? 'NOT_ENOUGH_HISTORY', a.counterparty.id, inv?.openGross.minor ?? a.terms.amount.minor + (a.terms.discountAmount?.minor ?? 0), a.terms.discountBp!, other);
}): PlanAction[] {
  const out: PlanAction[] = [];
  for (const a of acts) {
    if (a.kind !== 'DISCOUNT_FALLBACK' || a.decision !== 'IN' || a.state === 'REMOVED' || a.state === 'SUPERSEDED') continue;
    const authority = decide(a, otherConcessionsMinor(acts, a.rootId));
    if (JSON.stringify([authority.decision, authority.reasons, authority.grantKinds]) === JSON.stringify([a.authority.decision, a.authority.reasons, a.authority.grantKinds])) continue;
    const next = { ...a, authority };
    out.push({ ...next, why: { ...a.why, text: renderWhy(next, a.why.codes) } });
  }
  return out;
}

/** How an action would change the forecast if it happens (net target receipt; the fallback replaces its stated inflow once). */
export function changesOf(a: Pick<PlanAction, 'kind' | 'rootId' | 'terms' | 'estimate' | 'subject' | 'counterparty'>, inflows: StatedInflow[]): TermsChange[] {
  if (a.kind === 'PAYOUT' || !a.estimate || !a.terms.targetOn) return [];
  const label = `${a.counterparty.name} · ${a.kind === 'DISCOUNT_FALLBACK' ? 'paid early after the offer' : a.kind === 'COLLECT_UNDISPUTED_SLICE' ? 'undisputed part' : a.kind === 'COLLECT_DISPUTED' ? 'disputed amount' : 'overdue invoice'} (target)`;
  const linked = a.kind === 'DISCOUNT_FALLBACK' ? inflows.find((s) => s.invoiceId === a.subject.invoiceId) : undefined;
  return [
    ...(linked ? [{ kind: 'DROP_INFLOW' as const, inflowId: linked.inflowId }] : []),
    { kind: 'TARGET_IN', key: `target:${a.rootId}`, on: a.terms.targetOn, netMinor: a.estimate.net.minor, label, note: `Headroom's aim, not agreed · ${money(a.estimate.gross.minor)} less an estimated ${money(a.estimate.fee.minor)} PayPal fee`, ref: { kind: 'INVOICE', id: a.subject.invoiceId! } },
  ];
}
