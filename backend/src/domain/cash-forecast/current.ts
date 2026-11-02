// C-CURRENT-1 "reserve currently met". Pure. S2 adds the bank as a real source; the badge stays NOT_VERIFIABLE while PayPal (~2 h lag) can't be recent.
import { MIN } from '../time.ts';

export interface LiquidSource {
  name: string;
  connected: boolean;
  reportedAvailableMinor: number | null;
  /** C-BAL-1 lower bound for this source; the only figure that can make the badge affirmative. */
  lowerBoundMinor: number | null;
  /** Lines the reducer could not place (RECONCILIATION_HOLD, OVERLAP_UNKNOWN, HELD_OUT). */
  unresolvedLines: number;
  asOf: string | null;
  /** NOT_APPLICABLE: a source with no Headroom movements to reconcile (the bank, whose figure is the institution's own). Satisfied. */
  reconciliation: 'PASS' | 'UNKNOWN' | 'HOLD' | 'NOT_APPLICABLE' | null;
  holds: string[];
  /** Why a source counts as not connected (e.g. "Bank needs reconnecting"). */
  notConnectedReason?: string;
}

/** "Recent" for the affirmative badge. Bank evidence policy is ≤ 15 min; PayPal reporting (~2 h lag) cannot meet it. */
export const RECENT_AS_OF_MS = 15 * MIN;

export function reserveCurrentlyMet(
  sources: LiquidSource[],
  reserveMinor: number,
  now: string,
  dueObligationsMinor: number[] = [],
): { state: 'MET' | 'NOT_MET' | 'NOT_VERIFIABLE'; reasons: string[] } {
  const reasons: string[] = [];
  if (!sources.length) reasons.push('No liquid accounts designated');
  for (const s of sources) {
    if (!s.connected) { reasons.push(s.notConnectedReason ?? `${s.name} not connected`); continue; }
    if (s.reportedAvailableMinor === null) reasons.push(`${s.name} reports no available balance`);
    if (s.asOf === null) reasons.push(`${s.name} as-of time unknown`);
    else if (Date.parse(now) - Date.parse(s.asOf) > RECENT_AS_OF_MS) reasons.push(`${s.name} report is not recent (its as-of is more than 15 min old)`);
    if (s.reconciliation !== 'PASS' && s.reconciliation !== 'NOT_APPLICABLE') reasons.push(`${s.name} report not reconciled`);
    if (s.holds.length) reasons.push(`${s.name} has unexplained holds or pending rows`);
    if (s.unresolvedLines) reasons.push(`${s.name} has ${s.unresolvedLines} movement(s) not yet placed against its report`);
    if (s.lowerBoundMinor === null) reasons.push(`${s.name} has no lower-bound estimate`);
  }
  if (reasons.length) return { state: 'NOT_VERIFIABLE', reasons };
  const total = sources.reduce((a, s) => a + (s.lowerBoundMinor ?? 0), 0);
  // S6 R1: payout reservations are already inside each lower bound (C-BAL-1 residual), so nothing is subtracted twice.
  const after = total - dueObligationsMinor.reduce((a, b) => a + b, 0);
  return after >= reserveMinor ? { state: 'MET', reasons: [] } : { state: 'NOT_MET', reasons: [`Lower-bound available after due items is below reserve`] };
}
