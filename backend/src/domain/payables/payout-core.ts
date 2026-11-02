// S6 pure payout rules (S06 §6.1, §6.17): fee ceiling, the frozen request, the item verdict, the report-group residual (R2)
// and the rail / company readiness verdicts. No I/O. The executor and the read models call these; they never re-derive them.
import { createHash } from 'node:crypto';
import { minorToDecimal, type LocalDate, type ReportingRow } from '@headroom/contracts';
import { forecastDays, type FItem } from '../cash-forecast/forecast.ts';
import { evidenceBlockers, type SkipBlocker, type SkipInputs } from '../plan/skip.ts';

/** R4: the fee ceiling is 2% of face, rounded up (planner value S6-P2; F0 observed $20.00 on $5,000, well inside it). */
export const FEE_CEILING_BP = 200;
export const feeCeilingMinor = (faceMinor: number) => Math.ceil((faceMinor * FEE_CEILING_BP) / 10_000);
export const maxDebitMinor = (faceMinor: number) => faceMinor + feeCeilingMinor(faceMinor);
/** R5: mutating replays stop 25 days after the first dispatch, inside PayPal's 30-day sender_batch_id retention. */
export const MUTATION_WINDOW_MS = 25 * 24 * 3_600_000;

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
export const normalizeReceiver = (s: string) => s.trim().toLowerCase();
export const receiverSha256 = (s: string) => sha(normalizeReceiver(s));
/** "s•••@•••.example.com": first letter and the last two domain labels only. Two addresses can share a mask (R9). */
export function maskReceiver(s: string): string {
  const [local, domain = ''] = normalizeReceiver(s).split('@');
  return `${local.slice(0, 1)}•••@•••.${domain.split('.').slice(-2).join('.')}`;
}

/** The unique payment intent = the effect key (one record, S6-D6). The occurrence key holds '#', which is fine inside a key. */
export const payKey = (tenantId: string, runId: string, occurrenceKey: string, paymentVersion: number, attempt: number) => `pay:${tenantId}:${runId}:${occurrenceKey}:v${paymentVersion}:a${attempt}`;
export const isPayoutEffectKey = (key: string) => key.startsWith('pay:');
/** Deterministic, ≤ 30 characters, unique per (run, occurrence, payment version, attempt): PayPal dedupes on it for 30 days. */
export const senderBatchIdOf = (runId: string, occurrenceKey: string, paymentVersion: number, attempt: number) => `HR${sha(`${runId}|${occurrenceKey}`).slice(0, 16)}v${paymentVersion}a${attempt}`;

/** S6-D16: exactly one EMAIL item; no Headroom email (PayPal's own sandbox notice stays inside the sandbox). */
export function payoutBody(o: { senderBatchId: string; receiver: string; amountMinor: number; business: string; billNo: string | null; senderItemId: string }): string {
  const bill = o.billNo ? `Bill ${o.billNo}` : 'Payment';
  return JSON.stringify({
    sender_batch_header: { sender_batch_id: o.senderBatchId, recipient_type: 'EMAIL', email_subject: `Payment from ${o.business}`, email_message: bill },
    items: [{ recipient_type: 'EMAIL', amount: { value: minorToDecimal(o.amountMinor), currency: 'USD' }, receiver: o.receiver, sender_item_id: o.senderItemId, note: bill }],
  });
}

// ---------- item verdict (S6-D8, Y7/Y8) ----------
export type ItemVerdict =
  | { kind: 'PAID'; itemId: string; transactionId: string; feeMinor: number; timeProcessed: string | null }
  | { kind: 'MISMATCH'; why: string }
  | { kind: 'NOT_PAID'; status: string }
  | { kind: 'FINAL'; status: string; reason: string }
  | { kind: 'RETURNED'; status: 'REFUNDED' | 'RETURNED' | 'REVERSED' };
const PENDING = ['PENDING', 'ONHOLD', 'UNCLAIMED', 'NEW'];
const FINAL = ['FAILED', 'BLOCKED', 'RETURNED', 'REFUNDED', 'REVERSED', 'DENIED'];
const toMinor = (v: unknown) => (typeof v === 'string' && /^\d+(\.\d{1,2})?$/.test(v) ? Math.round(Number(v) * 100) : null);

/**
 * Only an item SUCCESS bound to the frozen request (amount, currency, receiver hash, sender_batch_id) pays. Batch SUCCESS,
 * `transaction_id` and `activity_id` prove nothing (probe 04: UNCLAIMED carries them too). `afterPaid`: the post-success watch (R6).
 */
export function classifyItem(item: any, frozen: { senderBatchId: string; amountMinor: number; receiverSha256: string; batchId?: string | null }, afterPaid = false): ItemVerdict {
  const p = item?.payout_item ?? {};
  const status = String(item?.transaction_status ?? 'UNKNOWN');
  // S6-IM-07: both ids must be present and ours (probe 4b's item GET carries both).
  if (item?.sender_batch_id !== frozen.senderBatchId) return { kind: 'MISMATCH', why: 'a different or missing payment id (sender_batch_id)' };
  if (frozen.batchId && item?.payout_batch_id !== frozen.batchId) return { kind: 'MISMATCH', why: 'a different PayPal batch' };
  if (p.amount?.currency !== 'USD') return { kind: 'MISMATCH', why: `currency ${p.amount?.currency ?? 'missing'}` };
  if (toMinor(p.amount?.value) !== frozen.amountMinor) return { kind: 'MISMATCH', why: `amount ${p.amount?.value}` };
  if (typeof p.receiver !== 'string' || receiverSha256(p.receiver) !== frozen.receiverSha256) return { kind: 'MISMATCH', why: 'a different receiver' };
  if (afterPaid) return status === 'REFUNDED' || status === 'RETURNED' || status === 'REVERSED' ? { kind: 'RETURNED', status } : { kind: 'NOT_PAID', status };
  if (status === 'SUCCESS') {
    const fee = toMinor(item.payout_item_fee?.value);
    if (fee === null || item.payout_item_fee?.currency !== 'USD' || !item.transaction_id) return { kind: 'MISMATCH', why: 'SUCCESS without a USD fee or transaction id' };
    return { kind: 'PAID', itemId: item.payout_item_id, transactionId: item.transaction_id, feeMinor: fee, timeProcessed: item.time_processed ?? null };
  }
  if (PENDING.includes(status)) return { kind: 'NOT_PAID', status };
  if (FINAL.includes(status)) return { kind: 'FINAL', status, reason: item.errors?.message ?? item.errors?.name ?? status };
  return { kind: 'NOT_PAID', status };
}

// ---------- R2: residual of one reservation against a PayPal snapshot ----------
export interface ResvLike { effectKey: string; runId: string; state: 'ACTIVE' | 'SETTLED' | 'RELEASED'; faceMinor: number; debitMinor: number; transactionId: string | null }
export interface Residual { lowerMinor: number; upperMinor: number; reported: boolean; mismatch: string | null; rowIds: string[] }

/**
 * The part of a payout's debit the snapshot does not already contain. The group is keyed by the hold id H (T0001's
 * paypal_reference_id), and matched only on a full fingerprint. S = Σ group rows dated ≤ asOf, used only when the report is
 * complete and reconciled (`trusted`); otherwise 0. lower = max(0, D + S) (never adds back an unreported release); upper = D + S.
 */
export function residualOf(r: ResvLike, rows: ReportingRow[], asOf: string, trusted: boolean): Residual {
  if (r.state === 'RELEASED') return { lowerMinor: 0, upperMinor: 0, reported: false, mismatch: null, rowIds: [] };
  const D = r.debitMinor;
  const none = { lowerMinor: D, upperMinor: D, reported: false, mismatch: null, rowIds: [] as string[] };
  if (!r.transactionId) return none;
  const t1 = rows.filter((x) => x.transactionId === r.transactionId);
  if (!t1.length) return none;
  const fee = r.state === 'SETTLED' ? D - r.faceMinor : null;
  const p = t1.find((x) => x.eventCode === 'T0001' && x.currency === 'USD' && (x.status === 'S' || x.status === 'P') && x.amount?.minor === -r.faceMinor && (fee === null || x.fee?.minor === -fee) && x.paypalReferenceId);
  if (!p) return { ...none, mismatch: `PayPal's report row ${r.transactionId} has different figures`, rowIds: t1.map((x) => x.transactionId) };
  const debit = r.faceMinor + -(p.fee?.minor ?? 0);
  const hold = rows.find((x) => x.transactionId === p.paypalReferenceId && /^T15/.test(x.eventCode));
  const release = rows.filter((x) => x.paypalReferenceId === p.paypalReferenceId && x.eventCode === 'T1105');
  if (hold && (hold.currency !== 'USD' || hold.amount?.minor !== -debit)) return { ...none, mismatch: `PayPal's hold ${hold.transactionId} has different figures`, rowIds: [p.transactionId, hold.transactionId] };
  if (release.some((x) => x.currency !== 'USD' || x.amount?.minor !== debit)) return { ...none, mismatch: "PayPal's release row has different figures", rowIds: [p.transactionId, ...release.map((x) => x.transactionId)] };
  const group = [p, ...(hold ? [hold] : []), ...release];
  const rowIds = group.map((x) => x.transactionId);
  if (!trusted) return { ...none, rowIds };
  const delta = (x: ReportingRow) => (x.amount?.minor ?? 0) + (x.eventCode === 'T0001' ? (x.fee?.minor ?? 0) : 0);
  const S = group.filter((x) => x.initiatedAt <= asOf).reduce((t, x) => t + delta(x), 0);
  const complete = !!hold && release.length > 0 && group.every((x) => x.initiatedAt <= asOf);
  return { lowerMinor: Math.max(0, D + S), upperMinor: D + S, reported: complete, mismatch: null, rowIds };
}

// ---------- readiness verdicts (S6-D4 as amended by R1/R4) ----------
export type Verdict = 'PASS' | 'FAIL' | 'HELD_EVIDENCE' | 'UNKNOWN';
const dollars = (m: number) => `${m < 0 ? '−' : ''}$${(Math.abs(m) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export interface RailInput {
  now: string; faceMinor: number;
  /** C-BAL-1 bounds with every OTHER payout's residual already subtracted (own-intent exclusion, R1). Bank never enters (AT-F03). */
  paypal: SkipInputs['paypal'] & { upperMinor: number | null };
  blockers: SkipBlocker[];
}
export interface RailResult { verdict: Verdict; lowerMinor: number | null; upperMinor: number | null; needMinor: number; feeCeilingMinor: number; shortMinor: number | null; reasons: string[] }

export function railVerdict(x: RailInput): RailResult {
  const need = maxDebitMinor(x.faceMinor);
  const base = { lowerMinor: x.paypal.lowerMinor, upperMinor: x.paypal.upperMinor, needMinor: need, feeCeilingMinor: feeCeilingMinor(x.faceMinor) };
  const blockers = evidenceBlockers({ now: x.now, today: '', reserveMinor: 0, bank: { availableMinor: 0, retrievedAt: x.now }, paypal: x.paypal, items: [], blockers: x.blockers });
  if (blockers.length) return { ...base, verdict: 'UNKNOWN', shortMinor: null, reasons: blockers.map((b) => b.text) };
  // Only money PayPal has released funds a payout (S7-B10 live: confirmed-but-unreleased captures were refused INSUFFICIENT_FUNDS).
  const lower = x.paypal.spendableMinor ?? x.paypal.lowerMinor!;
  if (lower >= need) return { ...base, verdict: 'PASS', shortMinor: null, reasons: [`PayPal can fund it: ${dollars(lower)} usable ≥ ${dollars(need)} needed`] };
  if ((x.paypal.upperMinor ?? lower) >= need) return { ...base, verdict: 'HELD_EVIDENCE', shortMinor: need - lower, reasons: [`Waiting for PayPal to release today's customer payments (${dollars((x.paypal.upperMinor ?? lower) - lower)}); PayPal holds new payments for a few hours, then Headroom sends it`] };
  return { ...base, verdict: 'FAIL', shortMinor: need - lower, reasons: [`PayPal balance can't cover it: ${dollars(lower)} usable < ${dollars(need)} · short ${dollars(need - lower)} · money in your bank can't fund PayPal payouts`] };
}

export interface CompanyInput {
  now: string; today: LocalDate; reserveMinor: number; faceMinor: number;
  bank: SkipInputs['bank']; paypal: SkipInputs['paypal'];
  /** Accepted outflows of the conservative series WITHOUT this payment's own dated OUT item (R1 own-intent exclusion). */
  items: FItem[]; blockers: SkipBlocker[];
}
export interface CompanyResult { verdict: Verdict; min: { amountMinor: number; on: LocalDate } | null; reasons: string[] }

/** The S5 conservative series (lower; no inflows), with this payment moved to today at face + fee ceiling. */
export function companyVerdict(x: CompanyInput): CompanyResult {
  const blockers = evidenceBlockers({ now: x.now, today: x.today, reserveMinor: x.reserveMinor, bank: x.bank, paypal: x.paypal, items: [], blockers: x.blockers });
  if (blockers.length) return { verdict: 'UNKNOWN', min: null, reasons: blockers.map((b) => b.text) };
  const outs = x.items.filter((i) => i.direction === 'OUT');
  const opening = x.bank.availableMinor! + x.paypal.lowerMinor! - maxDebitMinor(x.faceMinor);
  const f = forecastDays(opening, outs, x.today, x.reserveMinor);
  const min = { amountMinor: Math.min(opening, f.summary.lowMinor), on: opening < f.summary.lowMinor ? x.today : f.summary.lowOn };
  if (min.amountMinor >= x.reserveMinor) return { verdict: 'PASS', min, reasons: [`Stays above your ${dollars(x.reserveMinor)} reserve: lowest ${dollars(min.amountMinor)} on ${min.on}`] };
  return { verdict: 'FAIL', min, reasons: [`Lowest ${dollars(min.amountMinor)} on ${min.on}, ${dollars(x.reserveMinor - min.amountMinor)} below your reserve`] };
}
