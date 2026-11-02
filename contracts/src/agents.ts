// Model role outputs (C-AI). Strict: unknown keys are refused (S3-R20). Values are quoted text; code parses and grounds them.
import { z } from 'zod';

const Quoted = z.object({ value: z.string().nullable(), quote: z.string().nullable() }).strict();

/** EvidenceInterpreter: what the document says, each value with the exact text it came from. Dates and totals as printed. */
export const EvidenceInterpreterOutput = z.object({
  supplierName: Quoted,
  billNumber: Quoted,
  reference: Quoted,
  issueDate: Quoted,
  dueDate: Quoted,
  total: Quoted,
  currency: Quoted,
  remittanceLast4: Quoted,
  documentKind: z.enum(['BILL', 'NOT_A_BILL', 'UNSURE']),
  instructionsInDocument: z.boolean(),
  instructionQuotes: z.array(z.string()).max(5),
}).strict();
export type EvidenceInterpreterOutput = z.infer<typeof EvidenceInterpreterOutput>;

// ---------- S4 (S04 §6.3 as revised by §6.17 R7 and S4-IM-03). The model chooses from finite sets only: no free text, so no output can
// carry an amount, date, concession, outcome or payment claim. Code renders every sentence from these codes and its own figures. ----------
export const ConsideredReason = z.enum(['NOT_NEEDED', 'FEWER_ACTIONS', 'HIGHER_COST', 'LESS_CERTAIN']);
/** Why an action is in the plan, as reasons code renders; each is valid only for some action kinds (gates.ts WHY_FOR). */
export const WhyCode = z.enum([
  'OVERDUE_UNDISPUTED', 'RELIABLE_PAYER', 'ACKNOWLEDGED_IN_WRITING', 'DISPUTE_STAYS_WITH_YOU', 'FALLBACK_ONLY_IF_SHORT', 'SMALL_CONCESSION',
  'OWED_UNDER_AGREED_TERMS', 'NEEDS_YOUR_APPROVAL', 'HELPS_BEFORE_NEED_BY', 'HELD_FOR_YOUR_AUTHORITY',
]);
export type WhyCode = z.infer<typeof WhyCode>;
export const PlanSummaryCode = z.enum(['COLLECT_FIRST', 'COLLECT_WITH_FALLBACK', 'HOLD_PAYOUT_ONLY']);
/** RecoveryPlanner: chooses and orders deterministic candidates and picks the reasons for each. Every figure and sentence comes from code. */
export const RecoveryPlannerOutput = z.object({
  selected: z.array(z.object({ candidateId: z.string(), order: z.number().int().min(1).max(20) }).strict()).max(20),
  considered: z.array(z.object({ candidateId: z.string(), reasonCode: ConsideredReason }).strict()).max(20),
  why: z.array(z.object({ candidateId: z.string(), reasons: z.array(WhyCode).min(1).max(3), citations: z.array(z.number().int().min(1).max(9)).max(5) }).strict()).max(20),
  summary: PlanSummaryCode,
}).strict();
export type RecoveryPlannerOutput = z.infer<typeof RecoveryPlannerOutput>;
/** Template codes (no model) or a short line Nova wrote (owner, 2 Nov 2026); the drafter gate checks a written line carries no fact. */
export const OPENING_CODES = ['HELLO_TEAM', 'DEAR_TEAM', 'HI_NAME', 'GOOD_DAY'] as const;
export const CLOSING_CODES = ['THANK_YOU', 'MANY_THANKS', 'KIND_REGARDS', 'APPRECIATE_HELP'] as const;
export const Opening = z.string().min(1).max(60);
export const Closing = z.string().min(1).max(60);
/** MessageDrafter: picks a greeting and a closing for each email (tone). Headroom writes the name and every factual clause. */
export const MessageDrafterOutput = z.object({
  drafts: z.array(z.object({ candidateId: z.string(), opening: Opening, closing: Closing }).strict()).max(10),
}).strict();
export type MessageDrafterOutput = z.infer<typeof MessageDrafterOutput>;
