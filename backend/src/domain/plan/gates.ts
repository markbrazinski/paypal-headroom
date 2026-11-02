// Model output gates and deterministic wording (S4-D7, D8; S04 §6.17 R7 as repaired by S4-IM-03). The models choose only from finite
// sets (candidate ids, order, reason codes, a greeting and a closing): no output can express an amount, date, concession, outcome or
// payment claim. Code renders every sentence from those codes and the action's current terms, so an edit re-renders it (S4-IM-01).
// A refused output → one re-ask → the template. Pure.
import { CLOSING_CODES, MessageDrafterOutput, OPENING_CODES, RecoveryPlannerOutput, type ActionKind, type PlanAction, type WhyCode } from '@headroom/contracts';
import { dayName, localTime, money, type Candidate } from './candidates.ts';

/** Which reasons may explain which kind of action. NEEDS_YOUR_APPROVAL only where the decision isn't ALLOW. */
export const WHY_FOR: Record<ActionKind, WhyCode[]> = {
  COLLECT_OVERDUE: ['OVERDUE_UNDISPUTED', 'RELIABLE_PAYER', 'HELPS_BEFORE_NEED_BY', 'NEEDS_YOUR_APPROVAL'],
  COLLECT_UNDISPUTED_SLICE: ['ACKNOWLEDGED_IN_WRITING', 'DISPUTE_STAYS_WITH_YOU', 'HELPS_BEFORE_NEED_BY', 'NEEDS_YOUR_APPROVAL'],
  COLLECT_DISPUTED: ['NEEDS_YOUR_APPROVAL', 'HELPS_BEFORE_NEED_BY'],
  ASK_SUPPLIER: ['HELPS_BEFORE_NEED_BY', 'NEEDS_YOUR_APPROVAL'],
  DISCOUNT_FALLBACK: ['RELIABLE_PAYER', 'FALLBACK_ONLY_IF_SHORT', 'SMALL_CONCESSION', 'HELPS_BEFORE_NEED_BY', 'NEEDS_YOUR_APPROVAL'],
  PAYOUT: ['OWED_UNDER_AGREED_TERMS', 'HELD_FOR_YOUR_AUTHORITY', 'NEEDS_YOUR_APPROVAL'],
};
/** Headroom's own choice when there is no model output. */
export const DEFAULT_WHY: Record<ActionKind, WhyCode[]> = {
  COLLECT_OVERDUE: ['OVERDUE_UNDISPUTED', 'RELIABLE_PAYER', 'HELPS_BEFORE_NEED_BY'],
  COLLECT_UNDISPUTED_SLICE: ['ACKNOWLEDGED_IN_WRITING', 'DISPUTE_STAYS_WITH_YOU', 'HELPS_BEFORE_NEED_BY'],
  COLLECT_DISPUTED: ['NEEDS_YOUR_APPROVAL', 'HELPS_BEFORE_NEED_BY'],
  ASK_SUPPLIER: ['HELPS_BEFORE_NEED_BY'],
  DISCOUNT_FALLBACK: ['RELIABLE_PAYER', 'SMALL_CONCESSION', 'FALLBACK_ONLY_IF_SHORT'],
  PAYOUT: ['OWED_UNDER_AGREED_TERMS', 'HELD_FOR_YOUR_AUTHORITY'],
};
type WhyAction = Pick<PlanAction, 'kind' | 'counterparty' | 'terms' | 'estimate' | 'authority' | 'condition'>;

/** One deterministic sentence per reason code, from the action's current terms and decision. */
export function renderWhy(a: WhyAction, codes: WhyCode[], tz = 'America/New_York'): string {
  const t = a.terms;
  const s = (c: WhyCode): string | null => {
    switch (c) {
      case 'OVERDUE_UNDISPUTED': return 'The invoice is overdue and nobody disputes it';
      case 'RELIABLE_PAYER': return `${a.counterparty.name}${a.counterparty.name.endsWith('s') ? '’' : '’s'} payment record supports asking`;
      case 'ACKNOWLEDGED_IN_WRITING': return `${a.counterparty.name} acknowledged this part in writing`;
      case 'DISPUTE_STAYS_WITH_YOU': return 'The disputed amount stays with you; Headroom never collects it';
      case 'FALLBACK_ONLY_IF_SHORT': return a.condition ? `It is a fallback, reconsidered ${localTime(a.condition.checkAt, tz)}: it goes out only if verified funds don't already cover the gap` : null;
      case 'SMALL_CONCESSION': return t.discountAmount ? `The concession is ${money(t.discountAmount.minor)}` : null;
      case 'HELPS_BEFORE_NEED_BY': return a.estimate && t.targetOn ? `If paid by ${dayName(t.targetOn)} it adds about ${money(a.estimate.net.minor)} after the estimated fee` : null;
      case 'NEEDS_YOUR_APPROVAL': return a.authority.decision === 'ALLOW' ? null : `It needs your approval: ${a.authority.reasons.find((r) => /above|dispute|review/.test(r)) ?? a.authority.reasons[0]}`;
      case 'OWED_UNDER_AGREED_TERMS': return t.payBy ? `${money(t.amount.minor)} is owed on ${dayName(t.payBy)} under terms you accepted` : null;
      case 'HELD_FOR_YOUR_AUTHORITY': return 'Headroom prepares it and holds it for your payout authority; paying it never improves cash';
    }
  };
  return codes.map(s).filter(Boolean).join('. ') + '.';
}

export const SUMMARY_TEXT = {
  COLLECT_FIRST: 'Collect what is overdue and undisputed first, and prepare the supplier payout for your approval.',
  COLLECT_WITH_FALLBACK: 'Collect what is overdue and undisputed, keep an early-payment offer as a fallback, and prepare the supplier payout for your approval.',
  HOLD_PAYOUT_ONLY: 'Prepare the supplier payout for your approval; nothing else Headroom may do helps before the shortfall.',
} as const;

export type Gate<T> = { ok: true; value: T } | { ok: false; reason: string };
const issues = (e: { issues: { path: PropertyKey[]; message: string }[] }) => e.issues.slice(0, 3).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');

/** A collection or fallback that can land before the shortfall: the model may order and explain it, never leave it out. */
export const helpsBeforeShortfall = (c: Candidate) => ['COLLECT_OVERDUE', 'COLLECT_UNDISPUTED_SLICE', 'DISCOUNT_FALLBACK'].includes(c.kind) && !c.late;

/** RecoveryPlanner gate: known ids, each candidate placed once, must-includes kept, reasons valid for the kind, citations its own. */
export function plannerGate(raw: unknown, cands: Candidate[]): Gate<RecoveryPlannerOutput> {
  const p = RecoveryPlannerOutput.safeParse(raw);
  if (!p.success) return { ok: false, reason: issues(p.error) };
  const o = p.data;
  const ids = new Set(cands.map((c) => c.rootId));
  const seen = [...o.selected.map((s) => s.candidateId), ...o.considered.map((s) => s.candidateId)];
  const unknown = seen.find((i) => !ids.has(i)) ?? o.why.find((w) => !ids.has(w.candidateId))?.candidateId;
  if (unknown) return { ok: false, reason: `unknown candidate id ${unknown}` };
  if (new Set(seen).size !== seen.length || seen.length !== ids.size) return { ok: false, reason: 'every candidate must be selected or considered exactly once' };
  const dropped = cands.find((c) => c.mustInclude && !o.selected.some((s) => s.candidateId === c.rootId));
  if (dropped) return { ok: false, reason: `${dropped.rootId} must stay in the plan` };
  // S7 (live dev, 3 Nov 2026): Nova left every collection out as "not needed" while the draft didn't close the gap. A collection or
  // fallback that can land before the shortfall is never left out by the model; it may only order and explain them (re-ask → template).
  const helpful = cands.find((c) => helpsBeforeShortfall(c) && !o.selected.some((s) => s.candidateId === c.rootId));
  if (helpful) return { ok: false, reason: `${helpful.rootId} can bring cash in before the shortfall, so it must be selected` };
  if (!o.selected.length) return { ok: false, reason: 'nothing selected' };
  for (const s of o.selected) {
    const w = o.why.find((x) => x.candidateId === s.candidateId);
    if (!w) return { ok: false, reason: `no why for ${s.candidateId}` };
    const c = cands.find((x) => x.rootId === s.candidateId)!;
    const bad = w.reasons.find((r) => !WHY_FOR[c.kind].includes(r) || (r === 'NEEDS_YOUR_APPROVAL' && c.authority.decision === 'ALLOW') || (r === 'FALLBACK_ONLY_IF_SHORT' && !c.condition));
    if (bad) return { ok: false, reason: `${s.candidateId}: ${bad} doesn't apply to this action` };
    const n = new Set(c.sources.map((x) => x.n));
    const cite = w.citations.find((x) => !n.has(x));
    if (cite !== undefined) return { ok: false, reason: `${s.candidateId} cites [${cite}], which is not one of its sources` };
  }
  // The summary code must describe the selection it summarizes.
  const kinds = new Set(o.selected.map((s) => cands.find((c) => c.rootId === s.candidateId)!.kind));
  const collects = kinds.has('COLLECT_OVERDUE') || kinds.has('COLLECT_UNDISPUTED_SLICE') || kinds.has('COLLECT_DISPUTED');
  const want = collects ? (kinds.has('DISCOUNT_FALLBACK') ? 'COLLECT_WITH_FALLBACK' : 'COLLECT_FIRST') : kinds.has('DISCOUNT_FALLBACK') ? 'COLLECT_WITH_FALLBACK' : 'HOLD_PAYOUT_ONLY';
  if (o.summary !== want) return { ok: false, reason: `summary ${o.summary} does not describe the selected actions (expected ${want})` };
  return { ok: true, value: o };
}

/** MessageDrafter gate: exactly one greeting/closing choice per outreach action, from the finite sets. */
export function drafterGate(raw: unknown, outreach: Candidate[]): Gate<MessageDrafterOutput> {
  const p = MessageDrafterOutput.safeParse(raw);
  if (!p.success) return { ok: false, reason: issues(p.error) };
  const ids = outreach.map((c) => c.rootId).sort();
  const got = p.data.drafts.map((d) => d.candidateId).sort();
  if (got.join() !== ids.join()) return { ok: false, reason: 'one draft per outreach action is required' };
  for (const d of p.data.drafts) for (const line of [d.opening, d.closing]) { const why = lineProblem(line); if (why) return { ok: false, reason: `"${line}": ${why}` }; }
  return { ok: true, value: p.data };
}

/**
 * Nova writes only the greeting and sign-off (owner, 2 Nov 2026). A line is refused if it could carry a fact or an instruction:
 * more than one line or 60 characters, a digit, a money sign, a link or address, or a payment word. Template codes pass as codes.
 */
export function lineProblem(line: string): string | null {
  if ((OPENING_CODES as readonly string[]).includes(line) || (CLOSING_CODES as readonly string[]).includes(line)) return null;
  if (/[\r\n]/.test(line) || line.trim().length === 0 || line.length > 60) return 'must be one short line';
  if (/\d/.test(line)) return 'no numbers or dates';
  if (/[$€£¥%@]|https?:|www\./i.test(line)) return 'no amounts, links or addresses';
  // A business name's abbreviation ("Hi Keller Drafting Co.,", golden re-record 4 Nov 2026) is not a sentence; any other period is.
  if (/\./.test(line.replace(/\b(Co|Inc|Ltd|Corp|LLC|LLP|PLLC|Bros|Mr|Mrs|Ms|Dr)\./g, '$1'))) return 'a greeting or sign-off, not a sentence';
  if (/\b(pay|paid|payment|due|invoice|discount|refund|owe|owed|late|overdue|legal|fee|debt|erased?|waived?|transfer|arrived|received|receipt|balance|cancel\w*|settled?|credit|disputed?|months?|weeks?|days?|records?)\b/i.test(line)) return 'no payment terms or claims';
  return null;
}

export type OpeningCode = MessageDrafterOutput['drafts'][number]['opening'];
export type ClosingCode = MessageDrafterOutput['drafts'][number]['closing'];
const OPENING: Record<string, (name: string) => string> = { HELLO_TEAM: (n) => `Hello ${n} team,`, DEAR_TEAM: (n) => `Dear ${n} team,`, HI_NAME: (n) => `Hi ${n},`, GOOD_DAY: () => 'Good day,' };
const CLOSING: Record<string, string> = { THANK_YOU: 'Thank you,', MANY_THANKS: 'Many thanks for your help,', KIND_REGARDS: 'Kind regards,', APPRECIATE_HELP: 'We appreciate your help,' };
/** A template code's words, or the line Nova wrote (already gated); anything that fails the gate falls back to the template. */
const openingText = (o: string, name: string) => OPENING[o]?.(name) ?? (lineProblem(o) ? OPENING.HELLO_TEAM(name) : o);
const closingText = (c: string) => CLOSING[c] ?? (lineProblem(c) ? CLOSING.THANK_YOU : c);

export interface DraftFacts { invoiceNumber: string; dueOn: string; openMinor: number; disputedMinor?: number; ackOn?: string; supplierPlannedOn?: string }

/** Draft wording: every factual clause is Headroom's, from the CURRENT terms; the greeting/closing are chosen codes. Never sent in S4. */
export function messageFor(c: Pick<PlanAction, 'kind' | 'counterparty' | 'terms'>, f: DraftFacts, businessName: string, words: { opening: OpeningCode; closing: ClosingCode } = { opening: 'HELLO_TEAM', closing: 'THANK_YOU' }): { subject: string; body: string; opening: OpeningCode; closing: ClosingCode } {
  const t = c.terms;
  if (c.kind === 'ASK_SUPPLIER') {
    // S7 R6: the options are code-made; the email asks, never agrees or pays anything.
    const split = t.askOptions?.find((o) => o.code === 'SPLIT');
    const facts = `Your bill ${f.invoiceNumber} asks for ${money(t.amount.minor)} on ${dayName(f.dueOn)}, earlier than the ${dayName(f.supplierPlannedOn!)} we had planned for. Could we keep ${dayName(f.supplierPlannedOn!)}?${split ? ` If that doesn't work, could we pay ${money(split.parts[0].amount.minor)} on ${dayName(split.parts[0].dueOn)} and ${money(split.parts[1].amount.minor)} on ${dayName(split.parts[1].dueOn)}?` : ''} Just reply to let us know.`;
    return { subject: `Bill ${f.invoiceNumber}: payment date`, body: `${openingText(words.opening, c.counterparty.name)}\n\n${facts}\n\n${closingText(words.closing)}\n${businessName}`, ...words };
  }
  const facts = c.kind === 'COLLECT_OVERDUE'
    ? `Invoice ${f.invoiceNumber} for ${money(f.openMinor)} was due on ${dayName(f.dueOn)} and is still open. You can pay it on PayPal from the invoice. Could you pay ${t.amount.minor === f.openMinor ? 'it' : money(t.amount.minor)} by ${dayName(t.targetOn!)}?`
    : c.kind === 'COLLECT_UNDISPUTED_SLICE'
      ? `You confirmed part of invoice ${f.invoiceNumber} on ${dayName(f.ackOn!)}. Could you pay ${money(t.amount.minor)} of that confirmed part by ${dayName(t.targetOn!)}? The ${money(f.disputedMinor!)} you raised stays open and separate; this request doesn't cover it.`
      : c.kind === 'COLLECT_DISPUTED'
        ? `About the ${money(f.disputedMinor!)} you raised on invoice ${f.invoiceNumber}: could you pay ${money(t.amount.minor)} of it by ${dayName(t.targetOn!)}? If you still disagree, just reply and we will talk it through.`
      : `Invoice ${f.invoiceNumber} for ${money(f.openMinor)} is due on ${dayName(f.dueOn)}. If you pay it in full by ${dayName(t.payBy!)}, you can pay ${money(t.amount.minor)} instead (${t.discountBp! / 100}% off, ${money(t.discountAmount!.minor)}). This offer ends on ${dayName(t.expiresOn!)}.`;
  const subject = c.kind === 'DISCOUNT_FALLBACK' ? `Invoice ${f.invoiceNumber}: pay early and save ${money(t.discountAmount!.minor)}` : `Invoice ${f.invoiceNumber}: payment request`;
  return { subject, body: `${openingText(words.opening, c.counterparty.name)}\n\n${facts}\n\n${closingText(words.closing)}\n${businessName}`, ...words };
}
