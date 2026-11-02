// Delegation policy (S04 §6.1 D1–D4, D15, D16): the SEEDED v1 rules, precedence resolution and the per-action authority decision.
// Pure. Hard stops (pauses, verified recipient, consent, model authority, provider limits, tax) are not rule keys, so no narrower
// scope can address them (S4-D2); pauses block dispatch only and are reported separately from the decision.
import { RULE_VALUE, type GrantKind, type Policy, type PolicyDecision, type PolicyKey, type PolicyRule, type PolicyValue, type Tier } from '@headroom/contracts';
import { normalizeValue, RULE_SPECS, sameValue } from './specs.ts';

const money = (minor: number) => `$${(minor / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const R = (key: PolicyKey, group: PolicyRule['group'], why: string, scoped: PolicyRule['scoped'] = null, provenance: PolicyRule['provenance'] = 'SEEDED'): PolicyRule =>
  ({ key, group, sentence: RULE_SPECS[key].sentence(RULE_SPECS[key].seed), why, everywhere: RULE_SPECS[key].seed, scoped, editable: true, enforcedNow: null, provenance });

/** S4-D16 inventory; values come from RULE_SPECS (S7-D1). D15's $300 cumulative cap is a planner value, labelled so (§6.17). */
export const SEED_RULES: PolicyRule[] = [
  R('comms.contactEveryBd', 'MESSAGES', 'Steady follow-up without pestering', { scope: 'RECEIVABLES', value: null }),
  R('comms.window', 'MESSAGES', 'Plan dates are set inside this window'),
  R('comms.remindersWithoutReview', 'MESSAGES', 'Routine collection of undisputed, overdue invoices'),
  R('ar.newDateDays', 'GETTING_PAID', 'Small date moves keep work flowing', { scope: 'RECEIVABLES', value: null }),
  R('ar.discount', 'GETTING_PAID', 'Small concessions to reliable payers can close a gap', null, 'PLANNER_VALUE'),
  R('ar.disputes', 'GETTING_PAID', 'Disputes are yours to decide'),
  R('ap.paymentLimitMinor', 'PAYING_BILLS', 'Larger payments need a one-time exception', { scope: 'PAYABLES', value: null }),
  R('ap.dailyLimitMinor', 'PAYING_BILLS', 'Caps what can leave in one day'),
  R('ap.exactMatchBills', 'PAYING_BILLS', 'Nothing changes, so nothing needs you; this never pays anything'),
  R('ap.differingBills', 'PAYING_BILLS', 'A changed date or amount is your decision'),
  R('ap.askSuppliers', 'PAYING_BILLS', 'Supplier requests are your relationships'),
  R('cash.reserveMinor', 'CASH_SAFETY', 'The line every forecast is checked against'),
  R('cash.protectedPayments', 'CASH_SAFETY', 'Plans never propose moving them'),
];

/** Tier defaults (DQ-AR-04/05). Labels are rules, not scores; thresholds are planner values (S4-D18). */
export const SEED_TIERS: Policy['tiers'] = [
  { tier: 'STRONG', meaning: 'Pays on time', discount: true, reviewFirst: false, contactEveryBd: 4 },
  { tier: 'GOOD', meaning: 'Usually pays within days', discount: true, reviewFirst: false, contactEveryBd: 4 },
  { tier: 'MIXED', meaning: 'Often late', discount: false, reviewFirst: false, contactEveryBd: 4 },
  { tier: 'AT_RISK', meaning: 'Disputes · review first', discount: false, reviewFirst: true, contactEveryBd: 4 },
  { tier: 'NOT_ENOUGH_HISTORY', meaning: 'Default rules apply', discount: false, reviewFirst: false, contactEveryBd: 4 },
];

/** The demo business's own configuration (owner, 3 Nov 2026): a known supplier's bill that only moves the date earlier, by up to
 * 30 days, is verified and accepted by rule, and the owner is told at once. Amount changes and new payment details still come to the owner. */
export const DEMO_BILL_RULE = { mode: 'AUTO_ACCEPT', maxAmountDiffMinor: 0, maxDaysEarlier: 30 } as const;
export function seedPolicy(at: string, o: { bills?: 'AUTO' | 'ASK' } = {}): Policy {
  const rules = o.bills === 'AUTO' ? SEED_RULES.map((r) => (r.key === 'ap.differingBills' ? { ...r, everywhere: { ...DEMO_BILL_RULE }, sentence: RULE_SPECS[r.key].sentence(DEMO_BILL_RULE) } : r)) : SEED_RULES;
  return { version: 1, rules, tiers: SEED_TIERS, exceptions: [], pauses: { outreach: false, payments: false }, change: { kind: 'SEED', key: '', before: '', after: 'Delegation v1', loosens: false }, by: 'OPERATOR', at };
}

export const HARD_STOPS = [
  'Global pauses stop all outreach or payment preparation, whatever any rule says',
  'Payouts only to a supplier’s verified payment details',
  'Nothing runs without its own approval or a delegation rule that covers it',
  'Headroom’s model never sets amounts, dates, recipients or permissions',
  'Provider limits (PayPal, bank) always apply',
  'Tax always needs you',
];

export type Area = 'RECEIVABLES' | 'PAYABLES';
export interface Resolved { value: PolicyValue; winning: PolicyDecision['winning'] }

export const ruleOf = (p: Policy, key: PolicyKey) => p.rules.find((r) => r.key === key)!;
export const ruleText = (r: PolicyRule, v: PolicyValue = r.everywhere) => RULE_SPECS[r.key].sentence(normalizeValue(r.key, v));
/** A rule's resolved value in its current shape. */
export const valueOf = <T = PolicyValue>(p: Policy, key: PolicyKey, area: Area = 'RECEIVABLES', counterpartyId?: string) => resolve(p, key, area, counterpartyId).value as T;

/** D4 precedence: individual exception → (tier, where a tier default exists) → scope → everywhere. The winner is reported. */
export function resolve(p: Policy, key: PolicyKey, area: Area, counterpartyId?: string): Resolved {
  const r = ruleOf(p, key);
  const ex = counterpartyId ? p.exceptions.find((e) => e.counterpartyId === counterpartyId && e.key === key) : undefined;
  if (ex) return { value: normalizeValue(key, ex.value), winning: { key, scope: counterpartyId!, source: 'EXCEPTION', label: `Individual exception · ${ruleText(r, ex.value)}` } };
  if (r.scoped && r.scoped.scope === area && r.scoped.value !== null) return { value: normalizeValue(key, r.scoped.value), winning: { key, scope: area, source: 'SCOPE', label: `${area === 'PAYABLES' ? 'Paying bills' : 'Getting paid'} · ${ruleText(r, r.scoped.value)}` } };
  return { value: normalizeValue(key, r.everywhere), winning: { key, scope: 'EVERYWHERE', source: 'EVERYWHERE', label: `Everywhere · ${ruleText(r)}` } };
}

const decision = (p: Policy, d: PolicyDecision['decision'], reasons: string[], winning: PolicyDecision['winning'], grantKinds: GrantKind[]): PolicyDecision =>
  ({ decision: d, reasons, policyVersion: p.version, winning, grantKinds });

export const tierRow = (p: Policy, t: Tier) => p.tiers.find((x) => x.tier === t)!;

/** Overdue, undisputed collection (Pellow). A review-first tier needs the wording approved. */
export function decideCollect(p: Policy, tier: Tier): PolicyDecision {
  if (tierRow(p, tier).reviewFirst) return decision(p, 'REQUIRES_APPROVAL', ['Disputes · review first: you approve the wording'], { key: 'tier', scope: tier, source: 'TIER', label: 'By relationship · At risk · review first' }, ['MESSAGE_AS_WRITTEN']);
  const r = resolve(p, 'comms.remindersWithoutReview', 'RECEIVABLES');
  // S7 §6.1a: off → every reminder waits for the owner's approval of its wording.
  if (r.value !== true) return decision(p, 'REQUIRES_APPROVAL', [`${ruleText(ruleOf(p, 'comms.remindersWithoutReview'), r.value)}: you approve the wording`], r.winning, ['MESSAGE_AS_WRITTEN']);
  return decision(p, 'ALLOW', [`Within delegation · ${ruleText(ruleOf(p, 'comms.remindersWithoutReview'))}`], r.winning, []);
}

/** The acknowledged undisputed slice of a disputed invoice (Harrow): always needs approval; the disputed part is never a candidate. */
export function decideSlice(p: Policy, tier: Tier, counterpartyId?: string): PolicyDecision {
  // S7a-IR-01: re-checked at every stage; under PAUSE_INVOICE nothing on a disputed invoice is collected, even if approved earlier.
  if (valueOf(p, 'ar.disputes', 'RECEIVABLES', counterpartyId) === 'PAUSE_INVOICE') return decision(p, 'BLOCK', [`${ruleText(ruleOf(p, 'ar.disputes'), 'PAUSE_INVOICE')} (Delegation v${p.version})`], resolve(p, 'ar.disputes', 'RECEIVABLES', counterpartyId).winning, []);
  const kinds: GrantKind[] = ['COLLECT_SLICE', ...(tierRow(p, tier).reviewFirst ? ['MESSAGE_AS_WRITTEN' as const] : [])];
  return decision(p, 'REQUIRES_APPROVAL', ['An invoice with a dispute: collecting the undisputed part needs your approval', ...(kinds.length > 1 ? ['Disputes · review first: you approve the wording'] : [])],
    resolve(p, 'ar.disputes', 'RECEIVABLES').winning, kinds);
}

/** S7 ar.disputes = PROPOSE_DISPUTED: asking for a disputed amount always needs its own approval (consent hard stop; never autonomous). */
export function decideDisputed(p: Policy, tier: Tier, counterpartyId?: string): PolicyDecision {
  // S7a-IR-01: only while the loosened rule stands; tightening stops an approved but unsent ask (consumed authority alone survives).
  if (valueOf(p, 'ar.disputes', 'RECEIVABLES', counterpartyId) !== 'PROPOSE_DISPUTED') return decision(p, 'BLOCK', [`${ruleText(ruleOf(p, 'ar.disputes'), valueOf(p, 'ar.disputes', 'RECEIVABLES', counterpartyId))} (Delegation v${p.version})`], resolve(p, 'ar.disputes', 'RECEIVABLES', counterpartyId).winning, []);
  const kinds: GrantKind[] = ['COLLECT_DISPUTED', ...(tierRow(p, tier).reviewFirst ? ['MESSAGE_AS_WRITTEN' as const] : [])];
  return decision(p, 'REQUIRES_APPROVAL', ['Asking for a disputed amount always needs your approval, each time', ...(kinds.length > 1 ? ['Disputes · review first: you approve the wording'] : [])],
    resolve(p, 'ar.disputes', 'RECEIVABLES').winning, kinds);
}

/** S7 R6 ap.askSuppliers: NEEDS_YOU → you approve the wording of each ask; WITHOUT_REVIEW → sent under your delegation. Accepting any answer always needs you. */
export function decideAsk(p: Policy): PolicyDecision {
  const r = resolve(p, 'ap.askSuppliers', 'PAYABLES');
  return r.value === 'WITHOUT_REVIEW' ? decision(p, 'ALLOW', [`Within delegation · ${ruleText(ruleOf(p, 'ap.askSuppliers'), r.value)}`], r.winning, [])
    : decision(p, 'REQUIRES_APPROVAL', ['Asking a supplier for new terms needs you: you approve the wording'], r.winning, ['MESSAGE_AS_WRITTEN']);
}

/** `ask` ALWAYS (UX repair, S7 audit F03): every offer needs the owner's one-time approval, even inside the limits. Unset = ABOVE_LIMITS (A-002). */
export interface DiscountLimits { bp: number; capMinor: number; cumulativeMinor: number; tiers: string[]; ask: 'ALWAYS' | 'ABOVE_LIMITS' }
export const discountLimits = (p: Policy, counterpartyId?: string): DiscountLimits => {
  const v = valueOf<DiscountLimits>(p, 'ar.discount', 'RECEIVABLES', counterpartyId);
  return { bp: v.bp, capMinor: v.capMinor, cumulativeMinor: v.cumulativeMinor, tiers: [...v.tiers], ask: v.ask ?? 'ABOVE_LIMITS' };
};
/** Discount in minor units: bp of the open amount, half-up. */
export const discountMinor = (grossMinor: number, bp: number) => Math.floor((grossMinor * bp + 5_000) / 10_000);
const pct = (bp: number) => `${bp / 100}%`;

/** A-002: within the limits the configuration authorizes the offer (no grant); beyond → one-time DISCOUNT_OFFER; tier below Good → BLOCK. */
export function decideOffer(p: Policy, tier: Tier, counterpartyId: string, grossMinor: number, bp: number, otherOpenConcessionsMinor: number): PolicyDecision {
  const l = discountLimits(p, counterpartyId);
  const w = resolve(p, 'ar.discount', 'RECEIVABLES', counterpartyId).winning;
  // S7 §6.1a: the rule's tiers alone decide (the tier table's discount column is rendered from this rule).
  const TEXT: Record<string, string> = { STRONG: 'Strong', GOOD: 'Good', MIXED: 'Mixed', AT_RISK: 'At risk' };
  if (!l.tiers.includes(tier) || l.bp === 0) return decision(p, 'BLOCK', [l.tiers.length && l.bp ? `Offered only to reliable payers (${l.tiers.map((t) => TEXT[t]).join(' or ')})` : 'Your delegation allows no early-payment discounts'], { ...w, source: 'TIER', label: `By relationship · ${tierRow(p, tier).meaning}` }, []);
  const d = discountMinor(grossMinor, bp);
  const limit = Math.min(discountMinor(grossMinor, l.bp), l.capMinor);
  const rule = `'${pct(l.bp)} or ${money(l.capMinor)}, whichever is smaller'`;
  const over: string[] = [];
  if (d > limit || bp > l.bp) over.push(`${pct(bp)} = ${money(d)} is above ${rule}`);
  if (otherOpenConcessionsMinor + d > l.cumulativeMinor) over.push(`${money(otherOpenConcessionsMinor + d)} offered in total is above the ${money(l.cumulativeMinor)} total`);
  if (over.length) return decision(p, 'EXCEPTION', over, w, ['DISCOUNT_OFFER']);
  if (l.ask === 'ALWAYS') return decision(p, 'REQUIRES_APPROVAL', [`A discount is a concession: your delegation has every early-payment offer come to you, even inside ${rule} (Delegation v${p.version})`], w, ['DISCOUNT_OFFER']);
  return decision(p, 'ALLOW', [`Within delegation · ${pct(bp)} = ${money(d)} is inside ${rule} (Delegation v${p.version})`], w, []);
}

/**
 * A supplier payout: always needs payout authority; above the per-payment or daily limit it also needs ONE one-time exception.
 * The limits count the most that may leave PayPal (`totalMinor` = the bill + the fee allowance, S6 R4); the reason names both parts
 * and the per-payment and daily breaches are one sentence (UX repair, S7 audit F04).
 */
export function decidePayout(p: Policy, supplierId: string, totalMinor: number, sameDayOtherMinor: number, faceMinor = totalMinor): PolicyDecision {
  const per = resolve(p, 'ap.paymentLimitMinor', 'PAYABLES', supplierId);
  const daily = resolve(p, 'ap.dailyLimitMinor', 'PAYABLES', supplierId);
  const overPer = totalMinor > Number(per.value), overDay = sameDayOtherMinor + totalMinor > Number(daily.value);
  const amount = faceMinor < totalMinor ? `${money(faceMinor)} payment plus up to ${money(totalMinor - faceMinor)} PayPal fee allowance (${money(totalMinor)})` : money(totalMinor);
  const limits = [overPer && `your ${money(Number(per.value))} per-payment limit`, overDay && `your ${money(Number(daily.value))} daily limit${sameDayOtherMinor ? ` (${money(sameDayOtherMinor + totalMinor)} that day)` : ''}`].filter(Boolean).join(' and ');
  const over = overPer || overDay ? [`The ${amount} is above ${limits}`] : [];
  return decision(p, over.length ? 'EXCEPTION' : 'REQUIRES_APPROVAL', ['Supplier payouts always need your payout authority', ...over], per.winning, ['PAYOUT_AUTHORITY', ...(over.length ? ['PAYOUT_EXCEPTION' as const] : [])]);
}

export const pausedFor = (p: Policy, kind: 'OUTREACH' | 'PAYMENTS') => (kind === 'OUTREACH' ? p.pauses.outreach : p.pauses.payments);

// ---------- owner changes (T10, S7-D1/D3): spec-checked values, loosening, safety ----------
export interface RuleChange { key: PolicyKey; scope: 'EVERYWHERE' | 'RECEIVABLES' | 'PAYABLES'; value: PolicyValue | null }
export type Applied = { policy: Policy; loosens: boolean; safety: boolean; before: string; after: string };

/** The policy after an owner change, or the reason it is refused (NOT_EDITABLE / INVALID_INPUT). The API already checked the shape. */
export function applyRuleChange(p: Policy, ch: RuleChange, by: string, at: string): Applied | { refused: 'NOT_EDITABLE' | 'INVALID_INPUT'; message: string } {
  const r = p.rules.find((x) => x.key === ch.key);
  const spec = RULE_SPECS[ch.key];
  if (!r || !spec) return { refused: 'NOT_EDITABLE', message: `${ch.key} can't be changed on this page` };
  if (ch.scope !== 'EVERYWHERE' && r.scoped?.scope !== ch.scope) return { refused: 'NOT_EDITABLE', message: `${ch.key} has no ${ch.scope} setting` };
  // An editor that doesn't send the discount's `ask` mode keeps the current one, so saving the limits never silently loosens it.
  if (ch.key === 'ar.discount' && ch.value && typeof ch.value === 'object' && !Array.isArray(ch.value) && !('ask' in ch.value)) {
    const cur = (ch.scope === 'EVERYWHERE' ? r.everywhere : r.scoped?.value ?? r.everywhere) as { ask?: string } | null;
    if (cur?.ask) ch = { ...ch, value: { ...ch.value, ask: cur.ask } as PolicyValue };
  }
  if (ch.scope === 'EVERYWHERE' && ch.value === null) return { refused: 'INVALID_INPUT', message: 'The everywhere value is required' };
  // The API checked the same schema; checked again here so no caller can store a value outside the owner's range.
  const ok = ch.value === null ? null : RULE_VALUE[ch.key].safeParse(ch.value);
  if (ok && !ok.success) return { refused: 'INVALID_INPUT', message: ok.error.issues[0]?.message ?? 'Invalid value' };
  const effective = (x: PolicyRule) => normalizeValue(ch.key, ch.scope === 'EVERYWHERE' ? x.everywhere : x.scoped?.value ?? x.everywhere);
  const next: PolicyRule = ch.scope === 'EVERYWHERE' ? { ...r, everywhere: ch.value!, provenance: 'OWNER', changedAt: at } : { ...r, scoped: { scope: ch.scope, value: ch.value }, provenance: 'OWNER', changedAt: at };
  next.sentence = spec.sentence(normalizeValue(ch.key, next.everywhere));
  const [was, now] = [effective(r), effective(next)];
  if (sameValue(was, now) && JSON.stringify(r.scoped) === JSON.stringify(next.scoped)) return { refused: 'INVALID_INPUT', message: 'That is the current value' };
  const loosens = spec.loosens(was, now);
  const where = ch.scope === 'EVERYWHERE' ? 'Everywhere' : ch.scope === 'PAYABLES' ? 'Paying bills' : 'Getting paid';
  return {
    policy: { ...p, version: p.version + 1, rules: p.rules.map((x) => (x.key === ch.key ? next : x)), change: { kind: 'RULE', key: ch.key, before: `${where}: ${spec.short(was)}`, after: `${where}: ${ch.value === null ? `use the everywhere value (${spec.short(now)})` : spec.short(now)}`, loosens }, by, at },
    loosens, safety: spec.safety && loosens, before: spec.short(was), after: spec.short(now),
  };
}

/** S7-D3: a safety rule looser than its seeded default (drives the Delegation chip and the Overview notice). */
export const loosenedFromDefault = (p: Policy, key: PolicyKey) => RULE_SPECS[key].loosens(RULE_SPECS[key].seed, valueOf(p, key, key.startsWith('ap.') ? 'PAYABLES' : 'RECEIVABLES'));
export const safetyNotices = (p: Policy) => p.rules.filter((r) => RULE_SPECS[r.key].safety && r.provenance === 'OWNER' && loosenedFromDefault(p, r.key))
  .map((r) => ({ key: r.key, text: `You loosened a safety rule: ${ruleText(r)}`, since: r.changedAt ?? null }));

export function applyPause(p: Policy, kind: 'OUTREACH' | 'PAYMENTS', on: boolean, by: string, at: string): Policy {
  const pauses = kind === 'OUTREACH' ? { ...p.pauses, outreach: on } : { ...p.pauses, payments: on };
  const what = kind === 'OUTREACH' ? 'Pause all outreach' : 'Pause all payment preparation';
  return { ...p, version: p.version + 1, pauses, change: { kind: 'PAUSE', key: kind, before: on ? 'off' : 'on', after: `${what}: ${on ? 'on' : 'off'}`, loosens: !on }, by, at };
}
