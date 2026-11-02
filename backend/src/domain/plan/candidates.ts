// Deterministic plan candidates (S04 §6.2 T3, S4-D7). Code sets every amount, date, condition, authority decision and source;
// the model only chooses among these and phrases. Pure. Never candidates: disputed amounts, stated inflows with no invoice,
// supplier requests, discounts to tiers below Good, invoices not on PayPal, and fallbacks whose check time has passed.
import { feeCeilingMinor, maxDebitMinor } from '../payables/payout-core.ts';
import type { ActionKind, ActionTerms, Citation, ClaimSplit, LocalDate, Policy, PolicyDecision, StatedInflow, SupplierAskOption, Tier } from '@headroom/contracts';
import type { TermsChange } from '../obligations/obligations.ts';
import { decideAsk, decideCollect, decideDisputed, decideOffer, decidePayout, decideSlice, discountLimits, discountMinor, resolve, ruleOf, ruleText, valueOf } from '../delegation/policy.ts';
import { DISPUTES_TEXT, type DisputesMode } from '../delegation/specs.ts';
import { addBusinessDays, estimatedFeeMinor, planDates, windowOf } from './dates.ts';
import { businessDate } from '../time.ts';

export const money = (minor: number) => `${minor < 0 ? '−' : ''}$${(Math.abs(minor) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const dayName = (d: string) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(`${d.slice(0, 10)}T00:00:00Z`));
export const localTime = (instant: string, tz: string) => new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(instant));
const usd = (minor: number) => ({ currency: 'USD' as const, minor });

/** `amountMinor`: the invoice's original gross; less than that open means a receipt was allocated to it (S4-IM-06). */
/** `undisputedOpenMinor` (S5-D3): from UNDISPUTED allocations; null = no claim. `unattributed`: a pre-S5 WHOLE allocation on a claimed invoice. */
/** S7: `disputePending` = a dispute email waits for the owner (nothing collects); `disputedAskableMinor` = disputed − already-approved allowance. */
/** `lastContactAt` (UX repair, S7 audit F03): the last confirmed send to this customer's business (contact spacing). */
export interface InvoiceInput { lastContactAt?: string | null; disputePending?: boolean; disputedAskableMinor?: number | null; invoiceId: string; number: string | null; customerId: string; customerName: string; state: string; amountMinor: number; openMinor: number; dueOn: LocalDate; failureReason: string | null; undisputedOpenMinor?: number | null; unattributed?: boolean }
/** `payee`: the supplier's PayPal payee as it stands (S6 R4: bound into the consent); `paid`: a payment already holds this occurrence (R6). */
export interface PayoutInput { occurrenceKey: string; supplierId: string; supplierName: string; name: string; dueOn: LocalDate; amountMinor: number; feeMinor: number; billRef: string | null; billId: string | null; termsText: string | null; termsId: string | null; payee: { version: number; receiverSha256: string; masked: string; confirmed: boolean } | null; paymentVersion: number; paid: string | null }
export interface PlanInputs {
  now: string;
  tz: string;
  today: LocalDate;
  needBy: LocalDate;
  /** The Expected close on need-by and the gap, for the forecast-day citation. */
  needByClose: number;
  gapMinor: number;
  invoices: InvoiceInput[];
  claims: ClaimSplit[];
  tiers: Map<string, { tier: Tier; label: string; factorText: string }>;
  inflows: StatedInflow[];
  payouts: PayoutInput[];
  policy: Policy;
  /** S7 R6: payments a supplier's accepted terms moved earlier into the shortfall, with the code-made options. */
  asks?: { occurrenceKey: string; supplierId: string; supplierName: string; termsVersion: number; dueOn: LocalDate; scheduledOn: LocalDate; amountMinor: number; billRef: string | null; options: SupplierAskOption[] }[];
  /** S5-D12: roots whose action was dispatched or finished, with its state. They are never proposed again. */
  doneRoots?: Map<string, string>;
}

export interface Candidate {
  rootId: string;
  kind: ActionKind;
  title: string;
  counterparty: { kind: 'CUSTOMER' | 'SUPPLIER'; id: string; name: string };
  subject: { invoiceId: string | null; occurrenceKey: string | null };
  terms: ActionTerms;
  estimate: { gross: { currency: 'USD'; minor: number }; fee: { currency: 'USD'; minor: number }; net: { currency: 'USD'; minor: number } } | null;
  condition: { kind: 'VERIFIED_FUNDS_SHORT'; checkAt: string; needBy: LocalDate; text: string } | null;
  late: string | null;
  authority: PolicyDecision;
  heldReasons: string[];
  sources: Citation[];
  alternatives: string[];
  /** The held payout of a breaching obligation can't be dropped by the planner (S4-D7). */
  mustInclude: boolean;
  /** How this action changes the forecast if it happens (net target receipt, a replaced stated inflow). Payouts change nothing: they are already in it. */
  changes: TermsChange[];
  conditional: boolean;
}
export interface Considered { rootId: string; title: string; reasonCode: string; reason: string; canAsk: boolean; sources: Citation[] }

/**
 * UX repair (S7 audit F03, S7-UX1): asking earlier than the contact-spacing rule allows needs the owner's one-time CONTACT_SPACING
 * approval for this reminder only; the rule itself is unchanged and the send claim still enforces it for everything else (R9).
 * Used when a plan is built and when an owner edits the ask date (a date after the rule's next contact needs no exception).
 */
export function contactSpacing(p: Policy, customerId: string, lastContactAt: string | null, contactOn: LocalDate | null, tz: string): { last: LocalDate; next: LocalDate; n: number } | null {
  if (!lastContactAt || !contactOn) return null;
  const n = valueOf<number>(p, 'comms.contactEveryBd', 'RECEIVABLES', customerId);
  const last = businessDate(lastContactAt, tz) as LocalDate;
  const next = addBusinessDays(last, n);
  return contactOn < next ? { last, next, n } : null;
}
export function withContactSpacing(p: Policy, customerId: string, lastContactAt: string | null, contactOn: LocalDate | null, tz: string, base: PolicyDecision): PolicyDecision {
  const sp = contactSpacing(p, customerId, lastContactAt, contactOn, tz);
  if (!sp) return base;
  const why = `Last contacted ${dayName(sp.last)}: your rule is at most one contact every ${sp.n} business days, so the next is ${dayName(sp.next)}. Asking ${dayName(contactOn!)} needs your one-time approval; the rule stays as it is`;
  return { ...base, decision: base.decision === 'ALLOW' ? 'REQUIRES_APPROVAL' : base.decision, reasons: [why, ...(base.decision === 'ALLOW' ? [] : base.reasons)],
    winning: base.decision === 'ALLOW' ? resolve(p, 'comms.contactEveryBd', 'RECEIVABLES', customerId).winning : base.winning, grantKinds: [...base.grantKinds, 'CONTACT_SPACING'] };
}

/** S6: what an approved payout waits for (replaces S4's "Payouts arrive in a later build"). */
export const PAYOUT_RUNS = 'Headroom pays on the due date at 09:00 through PayPal Payouts, only if PayPal funds can cover it then';

export function generateCandidates(x: PlanInputs): { candidates: Candidate[]; considered: Considered[] } {
  const d = planDates(x.needBy, x.now, x.tz, windowOf(x.policy));
  const p = x.policy;
  const candidates: Candidate[] = [];
  const considered: Considered[] = [];
  const day: Citation = { n: 0, kind: 'FORECAST_DAY', id: x.needBy, label: `Forecast ${dayName(x.needBy)}`, detail: `Expected close ${money(x.needByClose)}: first day below your reserve; ${money(x.gapMinor)} short at the low` };
  const cite = (cs: Omit<Citation, 'n'>[]): Citation[] => cs.map((c, i) => ({ ...c, n: i + 1 }));
  const tierOf = (id: string) => x.tiers.get(id) ?? { tier: 'NOT_ENOUGH_HISTORY' as Tier, label: 'Not enough history', factorText: 'No earlier payments recorded' };
  const invCite = (i: InvoiceInput): Omit<Citation, 'n'> => ({ kind: 'INVOICE', id: i.invoiceId, label: `${i.customerName} · ${i.number ?? 'invoice'}`, detail: `${money(i.openMinor)} open · due ${dayName(i.dueOn)}${i.dueOn < x.today ? ' · overdue' : ''} · on PayPal (sandbox)` });
  const histCite = (id: string): Omit<Citation, 'n'> => ({ kind: 'HISTORY', id, label: `Relationship · ${tierOf(id).label}`, detail: tierOf(id).factorText });
  const policyCite = (key: Parameters<typeof ruleOf>[1]): Omit<Citation, 'n'> => ({ kind: 'POLICY', id: key, label: `Delegation v${p.version}`, detail: ruleText(ruleOf(p, key)) });
  const blank = { contactOn: null, replyCheckOn: null, targetOn: null, discountBp: null, discountAmount: null, payBy: null, expiresOn: null, checkAt: null, maxDebit: null, payee: null, paymentVersion: null, askOptions: null };
  const targetIn = (rootId: string, inv: InvoiceInput, gross: number, label: string, on = d.targetOn): { estimate: Candidate['estimate']; changes: TermsChange[] } => {
    const fee = estimatedFeeMinor(gross);
    return { estimate: { gross: usd(gross), fee: usd(fee), net: usd(gross - fee) }, changes: [{ kind: 'TARGET_IN', key: `target:${rootId}`, on, netMinor: gross - fee, label, note: `Headroom's aim, not agreed · ${money(gross)} less an estimated ${money(fee)} PayPal fee`, ref: { kind: 'INVOICE', id: inv.invoiceId } }] };
  };

  const spacingNeeded = (inv: InvoiceInput, contactOn: LocalDate | null) => contactSpacing(p, inv.customerId, inv.lastContactAt ?? null, contactOn, x.tz);
  const spacingAware = (inv: InvoiceInput, contactOn: LocalDate | null, base: PolicyDecision) => withContactSpacing(p, inv.customerId, inv.lastContactAt ?? null, contactOn, x.tz, base);
  /** S4-IM-07: a target receipt that nets nothing after PayPal's estimated fixed fee is never proposed. */
  const tooSmall = (gross: number) => gross - estimatedFeeMinor(gross) <= 0;
  const offers: { inv: InvoiceInput; tier: Tier; disc: number; build: (authority: PolicyDecision) => void; title: string; sources: Citation[]; rootId: string }[] = [];
  // Stable order whatever the store order (S4-IM-02 decides offers on the whole set, so order changes no decision, only display).
  for (const inv of [...x.invoices].sort((a, z) => a.dueOn.localeCompare(z.dueOn) || a.invoiceId.localeCompare(z.invoiceId))) {
    const name = inv.customerName;
    if (inv.state === 'FAILED' || inv.state === 'ISSUING' || inv.state === 'ISSUE_UNKNOWN') {
      considered.push({ rootId: `COLLECT:${inv.invoiceId}`, title: `Collect ${name}'s invoice`, reasonCode: 'NOT_ON_PAYPAL', reason: inv.state === 'FAILED' ? `Not issued on PayPal: ${inv.failureReason ?? 'PayPal refused it'}` : 'Still being issued on PayPal; build again once it is issued', canAsk: false, sources: cite([invCite(inv)]) });
      continue;
    }
    if (inv.state !== 'ISSUED' && inv.state !== 'PARTIALLY_PAID') continue;
    const claim = x.claims.find((c) => c.invoiceId === inv.invoiceId);
    const t = tierOf(inv.customerId);
    // S7 R4: a dispute email waiting for the owner stops every collection on the invoice until it is confirmed or dismissed.
    if (inv.disputePending) { considered.push({ rootId: `${claim ? 'SLICE' : inv.dueOn < x.today ? 'COLLECT' : 'OFFER'}:${inv.invoiceId}`, title: `Collect ${name}'s invoice`, reasonCode: 'DISPUTE_PENDING', reason: 'Dispute waiting for you: confirm or dismiss it on Receivables. Nothing is collected on this invoice until then', canAsk: false, sources: cite([invCite(inv)]) }); continue; }
    const mode = valueOf<DisputesMode>(p, 'ar.disputes', 'RECEIVABLES', inv.customerId);
    if (claim && mode === 'PAUSE_INVOICE') { considered.push({ rootId: `SLICE:${inv.invoiceId}`, title: `Collect the undisputed part from ${name}`, reasonCode: 'PAUSED_BY_RULE', reason: `${DISPUTES_TEXT.PAUSE_INVOICE} (Delegation v${p.version})`, canAsk: false, sources: cite([invCite(inv), policyCite('ar.disputes')]) }); continue; }
    // S7 R5 (ar.disputes = PROPOSE_DISPUTED, a loosened safety rule): one more candidate per disputed invoice, always needing approval.
    const disputedAsk = (): void => {
      const gross = inv.disputedAskableMinor ?? 0;
      if (!claim || mode !== 'PROPOSE_DISPUTED' || gross <= 0 || tooSmall(gross)) return;
      const rootId = `DISPUTED:${inv.invoiceId}`;
      const tin = targetIn(rootId, inv, gross, `${name} · disputed amount (target)`);
      candidates.push({
        rootId, kind: 'COLLECT_DISPUTED', title: `Ask ${name} for the disputed ${money(gross)}`, counterparty: { kind: 'CUSTOMER', id: inv.customerId, name }, subject: { invoiceId: inv.invoiceId, occurrenceKey: null },
        terms: { ...blank, amount: usd(gross), contactOn: d.contactOn, replyCheckOn: d.replyCheckOn, targetOn: d.targetOn }, ...tin, condition: null, late: d.late,
        authority: decideDisputed(p, t.tier, inv.customerId), heldReasons: [], mustInclude: false, conditional: false, alternatives: [],
        sources: cite([invCite(inv), { kind: 'CLAIM', id: inv.invoiceId, label: `${claim.acknowledgement.from}, ${dayName(claim.acknowledgement.on)}`, detail: `Disputed ${money(claim.disputed.minor)}: “${claim.acknowledgement.quote}” · ${claim.basis === 'SEEDED' ? 'SEEDED' : 'from their email, confirmed by you'}` }, histCite(inv.customerId), policyCite('ar.disputes'), day]),
      });
    };
    if (claim) {
      const rootId = `SLICE:${inv.invoiceId}`;
      const disputedCard: Considered = { rootId: `DISPUTED:${inv.invoiceId}`, title: `Collect the disputed ${money(claim.disputed.minor)} from ${name}`, reasonCode: 'DISPUTED', reason: mode === 'PROPOSE_DISPUTED' ? 'Nothing left to ask: the disputed amount is already covered by an approved ask, or too small' : `Headroom never collects disputed amounts under your delegation (Delegation v${p.version})`, canAsk: false, sources: cite([{ kind: 'CLAIM', id: inv.invoiceId, label: claim.acknowledgement.from, detail: `Disputed ${money(claim.disputed.minor)} · ${claim.basis === 'SEEDED' ? 'SEEDED' : 'from their email'}` }]) };
      const disputedOut = () => { const n = candidates.length; disputedAsk(); if (candidates.length === n) considered.push(disputedCard); };
      // S4-IM-06: once anything was received on this invoice, which part it settled isn't proven, so the remaining balance is never
      // relabelled as undisputed. Nothing is asked until the owner sorts it out (S5 attributes partial payments).
      // Unattributed: a pre-S5 WHOLE allocation, or receipts whose split the caller didn't supply (never guess which part was paid).
      if (inv.unattributed || (inv.undisputedOpenMinor === undefined && inv.openMinor < inv.amountMinor)) {
        considered.push({ rootId, title: `Collect the undisputed part from ${name}`, reasonCode: 'RECEIPT_UNATTRIBUTED', reason: `${money(inv.amountMinor - inv.openMinor)} was already received on this invoice; Headroom can't tell which part it settled, so it doesn't ask for more. The disputed amount stays with you`, canAsk: false, sources: cite([invCite(inv)]) });
        disputedOut();
        continue;
      }
      const gross = Math.min(inv.undisputedOpenMinor ?? claim.undisputed.minor, inv.openMinor);
      if (gross <= 0) { considered.push({ rootId, title: `Collect the undisputed part from ${name}`, reasonCode: 'SLICE_PAID', reason: 'The undisputed part is paid. Headroom never collects disputed amounts', canAsk: false, sources: cite([invCite(inv)]) }); disputedOut(); continue; }
      if (tooSmall(gross)) { considered.push({ rootId, title: `Collect the undisputed part from ${name}`, reasonCode: 'TOO_SMALL', reason: 'Too small: it would net nothing after the estimated PayPal fee', canAsk: false, sources: [] }); disputedOut(); continue; }
      const tin = targetIn(rootId, inv, gross, `${name} · undisputed part (target)`);
      candidates.push({
        rootId, kind: 'COLLECT_UNDISPUTED_SLICE', title: `Collect the undisputed ${money(gross)} from ${name}`, counterparty: { kind: 'CUSTOMER', id: inv.customerId, name }, subject: { invoiceId: inv.invoiceId, occurrenceKey: null },
        terms: { ...blank, amount: usd(gross), contactOn: d.contactOn, replyCheckOn: d.replyCheckOn, targetOn: d.targetOn }, ...tin, condition: null, late: d.late,
        authority: decideSlice(p, t.tier, inv.customerId), heldReasons: [], mustInclude: false, conditional: false, alternatives: [],
        sources: cite([invCite(inv), { kind: 'CLAIM', id: inv.invoiceId, label: `${claim.acknowledgement.from}, ${dayName(claim.acknowledgement.on)}`, detail: `“${claim.acknowledgement.quote}” · ${claim.basis === 'SEEDED' ? 'SEEDED' : 'from their email, confirmed by you'}` }, histCite(inv.customerId), policyCite('ar.disputes'), day]),
      });
      disputedOut();
      continue;
    }
    if (inv.dueOn < x.today) {
      const rootId = `COLLECT:${inv.invoiceId}`;
      if (tooSmall(inv.openMinor)) { considered.push({ rootId, title: `Collect ${name}'s overdue invoice`, reasonCode: 'TOO_SMALL', reason: 'Too small: it would net nothing after the estimated PayPal fee', canAsk: false, sources: cite([invCite(inv)]) }); continue; }
      const tin = targetIn(rootId, inv, inv.openMinor, `${name} · overdue invoice (target)`, d.overdue.targetOn);
      candidates.push({
        rootId, kind: 'COLLECT_OVERDUE', title: `Collect ${name}'s overdue ${money(inv.openMinor)}`, counterparty: { kind: 'CUSTOMER', id: inv.customerId, name }, subject: { invoiceId: inv.invoiceId, occurrenceKey: null },
        terms: { ...blank, amount: usd(inv.openMinor), contactOn: d.contactOn, replyCheckOn: d.overdue.replyCheckOn, targetOn: d.overdue.targetOn }, ...tin, condition: null, late: d.overdue.late,
        authority: spacingAware(inv, d.contactOn, decideCollect(p, t.tier)), heldReasons: [], mustInclude: false, conditional: false, alternatives: [],
        sources: cite([invCite(inv), histCite(inv.customerId), policyCite('comms.remindersWithoutReview'), ...(spacingNeeded(inv, d.contactOn) ? [policyCite('comms.contactEveryBd')] : []), day]),
      });
      continue;
    }
    // Not yet due: only a paying-early offer can help before need-by, and only as a conditional fallback (IC-2).
    if (inv.dueOn <= x.needBy) continue;
    const rootId = `OFFER:${inv.invoiceId}`;
    const l = discountLimits(p, inv.customerId);
    const bp = l.bp;
    const disc = discountMinor(inv.openMinor, bp);
    const pays = inv.openMinor - disc;
    const title = `Offer ${name} ${bp / 100}% (${money(disc)}) to pay ${money(pays)} early`;
    const sources = cite([invCite(inv), histCite(inv.customerId), policyCite('ar.discount'), day]);
    if (decideOffer(p, t.tier, inv.customerId, inv.openMinor, bp, 0).decision === 'BLOCK') { considered.push({ rootId, title, reasonCode: 'TIER_BLOCK', reason: decideOffer(p, t.tier, inv.customerId, inv.openMinor, bp, 0).reasons[0], canAsk: false, sources }); continue; }
    if ('tooLate' in d.fallback) { considered.push({ rootId, title, reasonCode: 'TOO_LATE', reason: d.fallback.tooLate, canAsk: false, sources }); continue; }
    if (tooSmall(pays)) { considered.push({ rootId, title, reasonCode: 'TOO_SMALL', reason: 'Too small: it would net nothing after the estimated PayPal fee', canAsk: false, sources }); continue; }
    const fb = d.fallback;
    const linked = x.inflows.find((s) => s.invoiceId === inv.invoiceId);
    const tin = targetIn(rootId, inv, pays, `${name} · paid early after the offer (target)`);
    const condText = `Only if verified funds don't already cover the gap at ${localTime(fb.checkAt, x.tz)}. A promise doesn't count.`;
    offers.push({ inv, tier: t.tier, disc, title, sources, rootId, build: (authority) => candidates.push({
      rootId, kind: 'DISCOUNT_FALLBACK', title, counterparty: { kind: 'CUSTOMER', id: inv.customerId, name }, subject: { invoiceId: inv.invoiceId, occurrenceKey: null },
      terms: { ...blank, amount: usd(pays), discountBp: bp, discountAmount: usd(disc), payBy: d.targetOn, targetOn: d.targetOn, expiresOn: fb.expiresOn, checkAt: fb.checkAt },
      ...tin, changes: [...(linked ? [{ kind: 'DROP_INFLOW' as const, inflowId: linked.inflowId }] : []), ...tin.changes],
      condition: { kind: 'VERIFIED_FUNDS_SHORT', checkAt: fb.checkAt, needBy: x.needBy, text: condText }, late: null,
      authority, heldReasons: [], mustInclude: false, conditional: true, alternatives: [], sources,
    }) });
  }
  // S4-IM-02: the cumulative concession limit counts every OTHER offer in the plan, so the answer doesn't depend on order.
  const offered = offers.reduce((t, o) => t + o.disc, 0);
  for (const o of offers) o.build(decideOffer(p, o.tier, o.inv.customerId, o.inv.openMinor, discountLimits(p, o.inv.customerId).bp, offered - o.disc));

  for (const s of x.inflows) if (!s.invoiceId) considered.push({ rootId: `INFLOW:${s.inflowId}`, title: s.label, reasonCode: 'NO_INVOICE', reason: 'No invoice to act on: a stated date only', canAsk: false, sources: [] });
  const dayTotals = new Map<string, number>();
  for (const o of x.payouts) {
    // S6 R6: a paid occurrence is never proposed again; a reopened one comes back with paymentVersion + 1.
    if (o.paid) { considered.push({ rootId: `PAYOUT:${o.occurrenceKey}`, title: `Pay ${o.supplierName} ${money(o.amountMinor)}`, reasonCode: 'ALREADY_PAID', reason: `Already paid: ${o.paid}`, canAsk: false, sources: [] }); continue; }
    // S6 R4: limits count face + the fee ceiling while unresolved (the estimate stays for display).
    const total = o.amountMinor + feeCeilingMinor(o.amountMinor);
    const authority = decidePayout(p, o.supplierId, total, dayTotals.get(o.dueOn) ?? 0, o.amountMinor);
    dayTotals.set(o.dueOn, (dayTotals.get(o.dueOn) ?? 0) + total);
    const rootId = `PAYOUT:${o.occurrenceKey}`;
    const sources = cite([
      { kind: 'OBLIGATION', id: o.occurrenceKey, label: `${o.name}`, detail: `${money(o.amountMinor)} · due ${dayName(o.dueOn)}` },
      ...(o.termsId ? [{ kind: 'TERMS' as const, id: o.termsId, label: `Accepted bill ${o.billRef ?? ''}`.trim(), detail: o.termsText ?? '' }] : []),
      policyCite('ap.paymentLimitMinor'), policyCite('ap.dailyLimitMinor'),
    ]);
    candidates.push({
      rootId, kind: 'PAYOUT', title: `Pay ${o.supplierName} ${money(o.amountMinor)} on ${dayName(o.dueOn)}`, counterparty: { kind: 'SUPPLIER', id: o.supplierId, name: o.supplierName }, subject: { invoiceId: null, occurrenceKey: o.occurrenceKey },
      terms: { ...blank, amount: usd(o.amountMinor), payBy: o.dueOn, maxDebit: usd(maxDebitMinor(o.amountMinor)), payee: o.payee && { supplierId: o.supplierId, version: o.payee.version, receiverSha256: o.payee.receiverSha256 }, paymentVersion: o.paymentVersion },
      estimate: null, condition: null, late: null, authority,
      heldReasons: [PAYOUT_RUNS, ...(o.payee?.confirmed ? [] : ['Confirm the supplier\'s PayPal address first (Payables)']), ...authority.reasons.filter((r) => r.includes('limit'))],
      mustInclude: true, conditional: false, changes: [], alternatives: [], sources,
    });
  }
  // S7 R6: ask the supplier to keep the original date, or to split; their answer changes nothing until you accept it.
  for (const k of x.asks ?? []) {
    const split = k.options.find((o) => o.code === 'SPLIT');
    candidates.push({
      rootId: `ASK:${k.occurrenceKey}:${k.termsVersion}`, kind: 'ASK_SUPPLIER', title: `Ask ${k.supplierName} to keep ${dayName(k.scheduledOn)}${split ? ` or split the ${money(k.amountMinor)}` : ''}`,
      counterparty: { kind: 'SUPPLIER', id: k.supplierId, name: k.supplierName }, subject: { invoiceId: null, occurrenceKey: k.occurrenceKey },
      terms: { ...blank, amount: usd(k.amountMinor), contactOn: d.contactOn, replyCheckOn: d.replyCheckOn, askOptions: k.options }, estimate: null, condition: null, late: null,
      authority: decideAsk(p), heldReasons: ['Their answer changes nothing until you accept it'], mustInclude: false, conditional: false, changes: [], alternatives: [],
      sources: cite([{ kind: 'OBLIGATION', id: k.occurrenceKey, label: `${k.supplierName}${k.billRef ? ` · bill ${k.billRef}` : ''}`, detail: `${money(k.amountMinor)} now due ${dayName(k.dueOn)}; planned for ${dayName(k.scheduledOn)}` }, policyCite('ap.askSuppliers'), day]),
    });
  }
  if (!(x.asks ?? []).length) considered.push({ rootId: 'ASK_SUPPLIER', title: 'Ask a supplier to keep a date', reasonCode: 'NO_CHANGED_TERMS', reason: "No supplier's accepted terms moved a payment into the shortfall", canAsk: false, sources: [] });

  // Stable order whatever the store order: collections, the undisputed slice, fallbacks, payouts; then by name.
  const RANK: Record<ActionKind, number> = { COLLECT_OVERDUE: 0, COLLECT_UNDISPUTED_SLICE: 1, COLLECT_DISPUTED: 2, DISCOUNT_FALLBACK: 3, ASK_SUPPLIER: 4, PAYOUT: 5 };
  candidates.sort((a, z) => RANK[a.kind] - RANK[z.kind] || a.counterparty.name.localeCompare(z.counterparty.name));
  // Alternatives: the other receivable actions that can cover the same need (UI-PL-11). Real candidates only.
  const recv = candidates.filter((c) => c.kind !== 'PAYOUT' && c.kind !== 'ASK_SUPPLIER').map((c) => c.rootId);
  for (const c of candidates) if (c.kind !== 'PAYOUT' && c.kind !== 'ASK_SUPPLIER') c.alternatives = recv.filter((r) => r !== c.rootId);
  // S5-D12: done or in-flight roots leave the candidate set and are listed with their state.
  const done = x.doneRoots ?? new Map();
  for (const c of candidates.filter((c) => done.has(c.rootId))) considered.push({ rootId: c.rootId, title: c.title, reasonCode: 'ALREADY_DONE', reason: `Already done or in progress: ${String(done.get(c.rootId)).toLowerCase().replace(/_/g, ' ')}. It stays in its revision's history`, canAsk: false, sources: c.sources });
  return { candidates: candidates.filter((c) => !done.has(c.rootId)), considered };
}
