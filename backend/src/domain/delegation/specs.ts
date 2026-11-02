// One spec per Delegation rule (S07 §6.1 S7-D1): the value schema (shared with the API, contracts RULE_VALUE), the editor, how a
// change is judged looser, the sentence rendered from the value and whether it is a safety rule (S7-D3). Editability comes from
// here, not from the stored rule, so existing runs pick it up. Pure.
import { RULE_VALUE, type PolicyKey, type PolicyValue } from '@headroom/contracts';

const money = (minor: number) => `$${(minor / 100).toLocaleString('en-US', { minimumFractionDigits: minor % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
const pct = (bp: number) => `${bp / 100}%`;
const TIER_TEXT: Record<string, string> = { STRONG: 'Strong', GOOD: 'Good', MIXED: 'Mixed', AT_RISK: 'At risk' };
const list = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} or ${xs[xs.length - 1]}`);
const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

export type Window = { open: string; close: string };
export type Discount = { bp: number; capMinor: number; cumulativeMinor: number; tiers: string[]; ask?: 'ALWAYS' | 'ABOVE_LIMITS' };
export type Differing = { mode: 'ALWAYS_ASK' | 'AUTO_ACCEPT'; maxAmountDiffMinor: number; maxDaysEarlier: number };
export type DisputesMode = 'PAUSE_INVOICE' | 'UNDISPUTED_ONLY' | 'PROPOSE_DISPUTED';

export interface RuleSpec {
  editor: 'DAYS' | 'BUSINESS_DAYS' | 'MONEY' | 'TOGGLE' | 'CHOICE' | 'WINDOW' | 'DISCOUNT' | 'DIFFERING' | 'SET_ASIDE';
  choices?: { value: string; label: string }[];
  safety: boolean;
  /** The seeded v1 value (S7-D8: every reset starts here; the A-001 oracle runs on these). */
  seed: PolicyValue;
  /** True when `after` lets Headroom do more without the owner than `before`. */
  loosens(before: PolicyValue, after: PolicyValue): boolean;
  sentence(v: PolicyValue): string;
  /** Short form for "before → after". */
  short(v: PolicyValue): string;
  /** For a safety rule: what Headroom may then do, and what still always needs the owner (the review dialog's words). */
  safetyText?: string;
  /** Values stored by runs seeded before S7 (S4 shapes), mapped to the behaviour they had. */
  legacy?: (v: PolicyValue) => PolicyValue | undefined;
}

const higher = (a: PolicyValue, b: PolicyValue) => Number(b) > Number(a);
const lower = (a: PolicyValue, b: PolicyValue) => Number(b) < Number(a);
const ordered = (order: string[]) => (a: PolicyValue, b: PolicyValue) => order.indexOf(String(b)) > order.indexOf(String(a));
const num = (fmt: (n: number) => string) => (v: PolicyValue) => fmt(Number(v));

export const DISPUTES_TEXT: Record<DisputesMode, string> = {
  PAUSE_INVOICE: 'An invoice with a dispute is paused entirely until you decide',
  UNDISPUTED_ONLY: 'Disputed amounts are never collected; collecting the undisputed part needs your approval',
  PROPOSE_DISPUTED: 'Headroom may propose asking for a disputed amount; each ask needs your approval, and the undisputed part still does',
};

export const RULE_SPECS: Record<PolicyKey, RuleSpec> = {
  'comms.contactEveryBd': { editor: 'BUSINESS_DAYS', safety: false, seed: 4, loosens: lower, short: num((n) => `${n} business day${n === 1 ? '' : 's'}`),
    sentence: (v) => `Contact the same business at most every ${v} business day${Number(v) === 1 ? '' : 's'}` },
  'comms.window': { editor: 'WINDOW', safety: false, seed: { open: '08:00', close: '18:00' },
    loosens: (a, b) => { const [x, y] = [a as Window, b as Window]; return minutes(y.open) < minutes(x.open) || minutes(y.close) > minutes(x.close); },
    short: (v) => `${(v as Window).open}–${(v as Window).close}`,
    sentence: (v) => `Contact people and send payments only between ${(v as Window).open} and ${(v as Window).close} on business days`,
    legacy: (v) => (v === '08:00-18:00' ? { open: '08:00', close: '18:00' } : undefined) },
  'comms.remindersWithoutReview': { editor: 'TOGGLE', safety: false, seed: true, loosens: (a, b) => !a && !!b, short: (v) => (v ? 'without review' : 'you review each'),
    sentence: (v) => (v ? 'Send reminders and payment requests without review' : 'Every reminder and payment request waits for your review') },
  'ar.newDateDays': { editor: 'DAYS', safety: false, seed: 14, loosens: higher, short: num((n) => `${n} days`),
    sentence: (v) => `Count a customer's promised payment date up to ${v} days after their promise; a later date needs you` },
  // UX repair (S7 audit F03): seeded ask ALWAYS: a proactive concession needs the owner each time; the limits still bound what may be proposed.
  'ar.discount': { editor: 'DISCOUNT', safety: false, seed: { bp: 200, capMinor: 30_000, cumulativeMinor: 30_000, tiers: ['STRONG', 'GOOD'], ask: 'ALWAYS' },
    loosens: (a, b) => { const [x, y] = [a as Discount, b as Discount]; return y.bp > x.bp || y.capMinor > x.capMinor || y.cumulativeMinor > x.cumulativeMinor || y.tiers.some((t) => !x.tiers.includes(t)) || ((x.ask ?? 'ABOVE_LIMITS') === 'ALWAYS' && (y.ask ?? 'ABOVE_LIMITS') !== 'ALWAYS'); },
    short: (v) => { const d = v as Discount; return `${pct(d.bp)} / ${money(d.capMinor)} / ${money(d.cumulativeMinor)} total · ${d.tiers.map((t) => TIER_TEXT[t]).join(', ') || 'nobody'}${d.ask === 'ALWAYS' ? ' · each needs you' : ''}`; },
    // F18: bp 0 or no tiers means no offer is ever proposed (the decision is BLOCK), so the sentence doesn't promise an approval path.
    sentence: (v) => { const d = v as Discount; return d.bp === 0 || !d.tiers.length ? 'No early-payment discounts' : `Early-payment discount up to ${pct(d.bp)} or ${money(d.capMinor)}, whichever is smaller, only to ${list(d.tiers.map((t) => TIER_TEXT[t]))} relationships; at most ${money(d.cumulativeMinor)} offered in total${d.ask === 'ALWAYS' ? '; each offer needs your approval' : ''}`; },
    legacy: (v) => (typeof v === 'object' && !Array.isArray(v) && typeof (v as Record<string, unknown>).tiers === 'string' ? { ...(v as Record<string, number>), tiers: String((v as Record<string, unknown>).tiers).split(',').filter(Boolean) } : undefined) },
  'ar.disputes': { editor: 'CHOICE', safety: true, seed: 'UNDISPUTED_ONLY', loosens: ordered(['PAUSE_INVOICE', 'UNDISPUTED_ONLY', 'PROPOSE_DISPUTED']),
    choices: [{ value: 'PAUSE_INVOICE', label: 'Pause the whole invoice' }, { value: 'UNDISPUTED_ONLY', label: 'Collect the undisputed part; the dispute comes to you' }, { value: 'PROPOSE_DISPUTED', label: 'Also propose collecting the disputed part, each time with your approval' }],
    short: (v) => ({ PAUSE_INVOICE: 'pause the invoice', UNDISPUTED_ONLY: 'undisputed part only', PROPOSE_DISPUTED: 'also propose the disputed part' } as Record<string, string>)[String(v)] ?? String(v),
    sentence: (v) => DISPUTES_TEXT[v as DisputesMode],
    safetyText: 'Headroom may then propose asking a customer for money they dispute. Each ask still needs your approval, on the same invoice; the customer’s claim is never altered.',
    legacy: (v) => (v === 'REVIEW_FIRST' ? 'UNDISPUTED_ONLY' : undefined) },
  'ap.paymentLimitMinor': { editor: 'MONEY', safety: false, seed: 500_000, loosens: higher, short: num(money), sentence: (v) => `Pay a supplier up to ${money(Number(v))} per payment` },
  'ap.dailyLimitMinor': { editor: 'MONEY', safety: false, seed: 600_000, loosens: higher, short: num(money), sentence: (v) => `Pay suppliers up to ${money(Number(v))} per day in total` },
  'ap.exactMatchBills': { editor: 'CHOICE', safety: false, seed: 'AUTO_VERIFY', loosens: ordered(['ALWAYS_ASK', 'AUTO_VERIFY']),
    choices: [{ value: 'AUTO_VERIFY', label: 'Verify automatically' }, { value: 'ALWAYS_ASK', label: 'Come to you' }],
    short: (v) => (v === 'AUTO_VERIFY' ? 'verified automatically' : 'come to you'),
    sentence: (v) => (v === 'AUTO_VERIFY' ? 'Bills that exactly match a planned cost are verified automatically' : 'Every bill comes to you, even one that exactly matches a planned cost') },
  'ap.differingBills': { editor: 'DIFFERING', safety: true, seed: { mode: 'ALWAYS_ASK', maxAmountDiffMinor: 0, maxDaysEarlier: 0 },
    loosens: (a, b) => { const [x, y] = [a as Differing, b as Differing]; if (x.mode !== y.mode) return y.mode === 'AUTO_ACCEPT'; return y.mode === 'AUTO_ACCEPT' && (y.maxAmountDiffMinor > x.maxAmountDiffMinor || y.maxDaysEarlier > x.maxDaysEarlier); },
    short: (v) => { const d = v as Differing; return d.mode === 'ALWAYS_ASK' ? 'come to you' : `accept within ${money(d.maxAmountDiffMinor)} and ${d.maxDaysEarlier} days earlier`; },
    sentence: (v) => { const d = v as Differing; return d.mode === 'ALWAYS_ASK' ? 'Bills that differ from the plan always need you' : `Accept a differing bill automatically when its amount differs by at most ${money(d.maxAmountDiffMinor)} and its date moves earlier by at most ${d.maxDaysEarlier} days; changed payment details always need you`; },
    safetyText: 'Headroom may then accept a supplier’s changed amount or earlier date within your bounds, and the forecast moves to it. Changed payment details and paying the bill still always need you.',
    legacy: (v) => (v === 'ALWAYS_ASK' ? { mode: 'ALWAYS_ASK', maxAmountDiffMinor: 0, maxDaysEarlier: 0 } : undefined) },
  'ap.askSuppliers': { editor: 'CHOICE', safety: false, seed: 'NEEDS_YOU', loosens: ordered(['NEEDS_YOU', 'WITHOUT_REVIEW']),
    choices: [{ value: 'NEEDS_YOU', label: 'You approve each ask' }, { value: 'WITHOUT_REVIEW', label: 'Send without review' }],
    short: (v) => (v === 'NEEDS_YOU' ? 'you approve each ask' : 'without review'),
    sentence: (v) => (v === 'NEEDS_YOU' ? 'Asking a supplier for new terms needs you' : 'Headroom may ask a supplier to keep or split a changed due date without review; accepting their answer always needs you') },
  'cash.reserveMinor': { editor: 'MONEY', safety: false, seed: 400_000, loosens: lower, short: num(money), sentence: (v) => `Keep at least ${money(Number(v))} as a minimum reserve` },
  // A0 (S07 §11a): 7 days moves payroll (day 11) into day 4 and breaks the A-001 oracle, so the seed is 0 = "on the due date".
  'cash.protectedPayments': { editor: 'SET_ASIDE', safety: true, seed: { setAsideDays: 0 }, loosens: (a, b) => Number((b as { setAsideDays: number }).setAsideDays) < Number((a as { setAsideDays: number }).setAsideDays),
    short: (v) => { const n = (v as { setAsideDays: number }).setAsideDays; return n ? `${n} days before` : 'on the due date'; },
    sentence: (v) => { const n = (v as { setAsideDays: number }).setAsideDays; return n ? `Set money aside ${n} day${n === 1 ? '' : 's'} before each protected payment (payroll, rent); they are never moved or delayed` : 'Protected payments (payroll, rent) count on their due date and are never moved or delayed'; },
    safetyText: 'Headroom will then count money for payroll and rent as usable until closer to the day they are due. They are still never moved or delayed.',
    legacy: (v) => (v === true ? { setAsideDays: 0 } : undefined) },
};

/** A stored value in its current shape: legacy S4 shapes map to the behaviour they had; anything else unreadable throws. */
export function normalizeValue(key: PolicyKey, v: PolicyValue): PolicyValue {
  if (RULE_VALUE[key].safeParse(v).success) return v;
  const mapped = RULE_SPECS[key].legacy?.(v);
  if (mapped !== undefined && RULE_VALUE[key].safeParse(mapped).success) return mapped;
  throw new Error(`Delegation rule ${key} holds an unreadable value`);
}

/** Rules whose governed behaviour is not wired yet in this build (no Change control is offered; the row says why). Emptied as S7a lands. */
export const ENFORCED_LATER: Partial<Record<PolicyKey, string>> = {
};

export const sameValue = (a: PolicyValue, b: PolicyValue) => JSON.stringify(a) === JSON.stringify(b);
