// C-SKIP-1 evaluator (S5-D7): one pure function over one fenced snapshot. Two runs of the same 42-day series:
//   lower = bank available + PayPal C-BAL-1 lower (payout reservations already inside it, S6 R1);  upper = lower + captured-awaiting-report net.
// Each applies every accepted outflow (with its fee) and NO inflow of any kind: stated, target, promise, open invoice, the offer.
import type { LocalDate } from '@headroom/contracts';
import { forecastDays, type FItem } from '../cash-forecast/forecast.ts';

export const BANK_FRESH_MS = 15 * 60_000;
export const PAYPAL_FETCH_FRESH_MS = 5 * 60_000;
// S7-B10 (3 Nov 2026): PayPal's report normally runs 3–5 h behind (measured), so 3 h held almost every check; captures after it are
// confirmed one by one by PayPal's GETs. 8 h still catches a report that has stopped moving.
export const PAYPAL_ASOF_STALE_MS = 8 * 3_600_000;

export interface SkipBlocker { code: string; text: string; ref: string | null }
export interface SkipInputs {
  now: string;
  today: LocalDate;
  reserveMinor: number;
  bank: { availableMinor: number | null; retrievedAt: string | null };
  paypal: { lowerMinor: number | null; spendableMinor?: number | null; capturedPendingMinor: number; asOf: string | null; fetchedAt: string | null; reconciliation: 'PASS' | 'UNKNOWN' | 'HOLD' };
  /** Expected forecast items; only OUT items are used. */
  items: FItem[];
  /** Found by the caller from the refresh set, captures/refunds, bills, mail and the update lock (S5-D7 list). */
  blockers: SkipBlocker[];
}
export interface SkipPoint { on: LocalDate; closeMinor: number }
export interface SkipResult {
  decision: 'SKIP' | 'HELD_EVIDENCE' | 'NEEDED';
  blockers: SkipBlocker[];
  lowerSeries: SkipPoint[] | null; upperSeries: SkipPoint[] | null;
  lowerMin: SkipPoint | null; upperMin: SkipPoint | null;
  reason: string;
}

const age = (now: string, t: string | null) => (t ? Date.parse(now) - Date.parse(t) : Number.POSITIVE_INFINITY);
/** A business date in words ("Sun, Dec 20"): reasons are read by the owner (UX repair, S7 audit F07). */
const on = (d: string) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(`${d.slice(0, 10)}T00:00:00Z`));
const dollars = (m: number) => `${m < 0 ? '−' : ''}$${(Math.abs(m) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Source freshness and evidence blockers that hold before any arithmetic. */
export function evidenceBlockers(x: SkipInputs): SkipBlocker[] {
  const out = [...x.blockers];
  if (x.bank.availableMinor === null) out.push({ code: 'BANK_MISSING', text: 'No verified bank balance', ref: null });
  else if (age(x.now, x.bank.retrievedAt) > BANK_FRESH_MS) out.push({ code: 'BANK_STALE', text: 'Bank balance older than 15 minutes', ref: null });
  if (x.paypal.lowerMinor === null) out.push({ code: 'PAYPAL_MISSING', text: 'No verified PayPal balance', ref: null });
  else {
    if (age(x.now, x.paypal.fetchedAt) > PAYPAL_FETCH_FRESH_MS) out.push({ code: 'PAYPAL_FETCH_STALE', text: 'PayPal balance fetched more than 5 minutes ago', ref: null });
    if (age(x.now, x.paypal.asOf) > PAYPAL_ASOF_STALE_MS) out.push({ code: 'PAYPAL_ASOF_STALE', text: "PayPal's report is more than 8 hours old", ref: null });
  }
  if (x.paypal.reconciliation !== 'PASS') out.push({ code: `RECONCILIATION_${x.paypal.reconciliation}`, text: `PayPal reconciliation is ${x.paypal.reconciliation.toLowerCase()}`, ref: null });
  return out;
}

export function evaluateSkip(x: SkipInputs): SkipResult {
  const blockers = evidenceBlockers(x);
  if (blockers.length) return { decision: 'HELD_EVIDENCE', blockers, lowerSeries: null, upperSeries: null, lowerMin: null, upperMin: null, reason: `Waiting for evidence: ${blockers.map((b) => b.text).join('; ')}` };
  const outs = x.items.filter((i) => i.direction === 'OUT');
  const run = (opening: number) => {
    const f = forecastDays(opening, outs, x.today, x.reserveMinor);
    return { series: f.days.map((d) => ({ on: d.on, closeMinor: d.closeMinor })), min: { on: f.summary.lowOn, closeMinor: f.summary.lowMinor } };
  };
  const lowerOpening = x.bank.availableMinor! + x.paypal.lowerMinor!;
  const lo = run(lowerOpening);
  const up = run(lowerOpening + x.paypal.capturedPendingMinor);
  const base = { blockers, lowerSeries: lo.series, upperSeries: up.series, lowerMin: lo.min, upperMin: up.min };
  if (lo.min.closeMinor >= x.reserveMinor) return { ...base, decision: 'SKIP', reason: `Verified funds alone stay at or above the ${dollars(x.reserveMinor)} reserve: lowest ${dollars(lo.min.closeMinor)} on ${on(lo.min.on)}` };
  if (up.min.closeMinor >= x.reserveMinor) return { ...base, decision: 'HELD_EVIDENCE', reason: `Captured money not yet in PayPal's report: with it the lowest is ${dollars(up.min.closeMinor)} on ${on(up.min.on)}; without it ${dollars(lo.min.closeMinor)}` };
  return { ...base, decision: 'NEEDED', reason: `Verified funds fall to ${dollars(lo.min.closeMinor)} on ${on(lo.min.on)}, below the ${dollars(x.reserveMinor)} reserve` };
}
