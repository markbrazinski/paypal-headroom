// C-BAL-1 snapshot overlap reducer (FUNDS-AND-EXECUTION-GATES §C-BAL-1). Pure.
import type { BalanceObservation, ReportingRow } from '@headroom/contracts';
import { residualOf, type ResvLike } from '../payables/payout-core.ts';

/** A Headroom-known economic movement on the PayPal connection. Each key is counted at most once. */
export type Movement =
  | { kind: 'CAPTURE'; key: string; runId: string; captureId: string; invoiceNumber: string; grossMinor: number; feeMinor: number; netMinor: number; settledAt: string; reversalDetected: boolean; captureStatus: string }
  | { kind: 'REFUND'; key: string; runId: string | null; captureId: string; transactionId: string; amountMinor: number; settledAt: string };

export type LineStatus =
  | 'INCLUDED' // pre-asOf, fingerprint-matched, balance reconciled: already inside the snapshot
  | 'OVERLAP_UNKNOWN' // pre-asOf but inclusion can't be proven: nothing added or subtracted
  | 'CONFIRMED_BY_CAPTURE' // post-asOf capture PayPal's GET shows COMPLETED (no refund, reversal or hold): both bounds (owner, 3 Nov 2026)
  | 'ELIGIBILITY_UNCONFIRMED' // post-asOf positive net not confirmed COMPLETED: upper bound only
  | 'SUBTRACTED' // post-asOf negative: both bounds
  | 'HELD_OUT' // reversal detected but unverified, or a known hold: never counted as cash
  | 'RECONCILIATION_HOLD'; // id matches a report row but the figures differ

export interface Line { key: string; runId: string | null; netMinor: number; status: LineStatus; reason: string }

/** S6 R1/R2: one per payout reservation on the connection (any run). `residual*` is what the snapshot doesn't contain yet. */
export interface PayoutLine { effectKey: string; runId: string; debitMinor: number; residualLowerMinor: number; residualUpperMinor: number; reported: boolean; mismatch: string | null }

export interface EstimateResult {
  payouts: PayoutLine[];
  lowerMinor: number;
  upperMinor: number;
  /** What PayPal will actually pay out from now: the lower figure without confirmed captures PayPal hasn't released yet (live 3 Nov
   *  2026: payouts funded by them were refused INSUFFICIENT_FUNDS; PayPal holds new customer payments for hours). Payouts and resets use it. */
  spendableMinor: number;
  reconciliation: 'PASS' | 'UNKNOWN' | 'HOLD';
  reconciliationReason: string;
  coverage: 'COMPLETE' | 'PARTIAL';
  lines: Line[];
  holds: string[];
}

const CENT = 1;
const byTime = (a: ReportingRow, b: ReportingRow) => a.initiatedAt.localeCompare(b.initiatedAt) || a.order - b.order;

/** Precondition for any inclusion claim: snapshot available = running balance of the last row at or before asOf. */
export function reconcile(availableMinor: number, asOf: string, coverage: 'COMPLETE' | 'PARTIAL', rows: ReportingRow[]): { state: EstimateResult['reconciliation']; reason: string } {
  if (coverage !== 'COMPLETE') return { state: 'UNKNOWN', reason: 'Reporting pages incomplete or not refreshed to as-of' };
  const usable = rows.filter((r) => r.currency === 'USD' && r.availableBalance && r.initiatedAt <= asOf).sort(byTime);
  if (usable.length === 0) return { state: 'UNKNOWN', reason: 'No reporting rows at or before as-of to reconcile against' };
  const last = usable[usable.length - 1];
  if (Math.abs(last.availableBalance!.minor - availableMinor) <= CENT) return { state: 'PASS', reason: `Matches running balance after ${last.transactionId}` };
  // Rows sharing the final timestamp: if another of them matches, PayPal's order is ambiguous rather than wrong.
  const tied = usable.filter((r) => r.initiatedAt === last.initiatedAt);
  if (tied.some((r) => Math.abs(r.availableBalance!.minor - availableMinor) <= CENT))
    return { state: 'UNKNOWN', reason: 'Several rows share the final timestamp; order is ambiguous' };
  return { state: 'HOLD', reason: `Snapshot ${availableMinor} ≠ running balance ${last.availableBalance!.minor} (${last.transactionId})` };
}

export function estimateCurrent(
  snapshot: Pick<BalanceObservation, 'availableMinor' | 'reportedAsOf' | 'coverage' | 'withheldMinor'>,
  rows: ReportingRow[],
  movements: Movement[],
  reservations: ResvLike[] = [],
): EstimateResult | null {
  if (snapshot.availableMinor === null || snapshot.reportedAsOf === null) return null;
  const asOf = snapshot.reportedAsOf;
  const rec = reconcile(snapshot.availableMinor, asOf, snapshot.coverage, rows);
  const lines: Line[] = [];
  const holds: string[] = [];
  let lower = snapshot.availableMinor;
  let upper = snapshot.availableMinor;

  // S6 R2: each payout reservation subtracts only what the snapshot doesn't already contain; its own hold, pending payout row and
  // release are explained by it, so they are not unexplained holds. A row with the payout's id but other figures is a hold on it.
  const trusted = snapshot.coverage === 'COMPLETE' && rec.state === 'PASS';
  const payouts = reservations.map((r) => ({ r, res: residualOf(r, rows, asOf, trusted) }));
  const explained = new Set(payouts.flatMap((p) => (p.res.mismatch ? [] : p.res.rowIds)));
  const holdRows = rows.filter((r) => /^T15/.test(r.eventCode) && r.initiatedAt > asOf && !explained.has(r.transactionId));
  // A pending outgoing payout row is already out of the available balance (probe 01: the balance reconciles with it); it can only come
  // back as a credit later, so it isn't an unknown (S7-B10). Pending incoming rows stay holds.
  for (const r of rows.filter((r) => r.status === 'P' && !explained.has(r.transactionId) && !(r.eventCode === 'T0001' && (r.amount?.minor ?? 0) < 0))) holds.push(`Pending PayPal row ${r.transactionId} (${r.eventCode})`);
  for (const r of holdRows) holds.push(`Hold ${r.transactionId} (${r.eventCode}) after as-of`);
  for (const p of payouts) if (p.res.mismatch) holds.push(`Payout ${p.r.transactionId}: ${p.res.mismatch}`);
  if ((snapshot.withheldMinor ?? 0) > 0) holds.push(`PayPal withheld balance ${snapshot.withheldMinor}`);

  const seen = new Set<string>();
  const refunded = new Map<string, number>(); // captureId → verified refund total, each refund key once
  for (const m of new Map(movements.filter((x) => x.kind === 'REFUND').map((x) => [x.key, x])).values())
    if (m.kind === 'REFUND') refunded.set(m.captureId, (refunded.get(m.captureId) ?? 0) + m.amountMinor);
  for (const m of movements) {
    if (seen.has(m.key)) continue; // AT-F05: each economic key once
    seen.add(m.key);
    const net = m.kind === 'CAPTURE' ? m.netMinor : -m.amountMinor;
    const line = (status: LineStatus, reason: string) => lines.push({ key: m.key, runId: m.runId, netMinor: net, status, reason });

    const sameId = m.kind === 'CAPTURE'
      ? rows.filter((r) => r.transactionId === m.captureId)
      : rows.filter((r) => r.transactionId === m.transactionId);
    const matched = sameId.find((r) =>
      m.kind === 'CAPTURE'
        ? ['T0005', 'T0006'].includes(r.eventCode) && r.status === 'S' && r.currency === 'USD' &&
          r.amount?.minor === m.grossMinor && r.fee?.minor === -m.feeMinor && r.invoiceNumber === m.invoiceNumber
        : r.eventCode === 'T1107' && r.paypalReferenceId === m.captureId && r.currency === 'USD' && r.amount?.minor === -m.amountMinor,
    );
    if (sameId.length > 0 && !matched) {
      if (sameId.every((r) => r.status === 'P')) { line('HELD_OUT', 'Pending at PayPal'); continue; } // S1-IR-10
      line('RECONCILIATION_HOLD', 'PayPal report row has the same id but different figures');
      continue;
    }

    const settledAt = matched?.initiatedAt ?? m.settledAt;
    // A detected refund/reversal whose amount isn't yet in a REFUND movement: the money may already have left.
    // Favour the lower bound on either side of as-of (C-BAL-1 step 3, T3.4; S1-IR-02). Recorded refunds are subtracted on their own lines.
    if (m.kind === 'CAPTURE' && m.reversalDetected) {
      const covered = refunded.get(m.captureId) ?? 0;
      if (covered === 0) {
        if (settledAt <= asOf) { lower -= m.netMinor; if (matched && rec.state === 'PASS') upper -= m.netMinor; }
        line('HELD_OUT', 'Refund or reversal detected; amount not yet verified (net held out)');
        continue;
      }
      // S1-IM-02: an earlier recorded refund covers a partial status, but a full refund/reversal only up to the
      // refunded total; the remainder has left PayPal without being in a report yet.
      // ponytail: a second partial refund that leaves the status PARTIALLY_REFUNDED is invisible until its report row arrives.
      const remainder = ['REFUNDED', 'REVERSED'].includes(m.captureStatus) ? Math.max(0, m.grossMinor - covered) : 0;
      if (remainder > 0) {
        lower -= remainder;
        if (settledAt > asOf || (matched && rec.state === 'PASS')) upper -= remainder;
        lines.push({ key: `${m.key}:unreported-reversal`, runId: m.runId, netMinor: -remainder, status: 'HELD_OUT',
          reason: `Capture is ${m.captureStatus}; ${remainder} beyond the reported refunds is not yet in a PayPal report (subtracted)` });
      }
    }
    if (settledAt <= asOf) {
      if (matched && rec.state === 'PASS') line('INCLUDED', `In PayPal report as of ${asOf}`);
      else line('OVERLAP_UNKNOWN', matched ? `Report not reconciled: ${rec.reason}` : 'Settled before as-of but not found in the PayPal report');
      continue;
    }
    if (m.kind === 'REFUND') { lower -= m.amountMinor; upper -= m.amountMinor; line('SUBTRACTED', 'Refund after as-of'); continue; }
    if (holdRows.some((r) => r.paypalReferenceId === m.captureId)) { line('HELD_OUT', 'PayPal hold on this capture'); continue; }
    // Owner decision, 3 Nov 2026 ("make it work"; S7-B10): a capture PayPal's own GET shows COMPLETED, with no refund/reversal and no
    // hold, is spendable now, so it counts in both figures; PayPal's report confirms it hours later (reconciliation still checks it).
    // A payout PayPal can't fund is refused with nothing sent; paid still means item SUCCESS.
    if (m.kind === 'CAPTURE' && m.captureStatus === 'COMPLETED') { lower += m.netMinor; upper += m.netMinor; line('CONFIRMED_BY_CAPTURE', 'Confirmed COMPLETED by PayPal; not yet in its balance report'); continue; }
    upper += m.netMinor;
    line('ELIGIBILITY_UNCONFIRMED', 'Captured after as-of; not yet in a PayPal report');
  }
  for (const p of payouts) { lower -= p.res.lowerMinor; upper -= p.res.upperMinor; }
  return {
    payouts: payouts.map((p) => ({ effectKey: p.r.effectKey, runId: p.r.runId, debitMinor: p.r.debitMinor, residualLowerMinor: p.res.lowerMinor, residualUpperMinor: p.res.upperMinor, reported: p.res.reported, mismatch: p.res.mismatch })),
    lowerMinor: lower, upperMinor: upper, spendableMinor: lower - lines.filter((l) => l.status === 'CONFIRMED_BY_CAPTURE').reduce((t, l) => t + l.netMinor, 0), reconciliation: rec.state, reconciliationReason: rec.reason, coverage: snapshot.coverage, lines, holds };
}
