import type { LocalDate } from '@headroom/contracts';
import { addDays } from '../time.ts';

export const HORIZON_DAYS = 42; // IC-6, owner reconfirmed 1 Nov 2026

export interface DatedMovement { on: LocalDate; minor: number }

/** Expected series over the horizon from an opening balance. Movements outside the horizon are ignored. */
export function forecast42(openingMinor: number, movements: DatedMovement[], businessToday: LocalDate) {
  const series: { on: LocalDate; balanceMinor: number }[] = [];
  let bal = openingMinor;
  let low = { minor: openingMinor, on: businessToday };
  for (let i = 0; i < HORIZON_DAYS; i++) {
    const on = addDays(businessToday, i);
    for (const m of movements) if (m.on === on) bal += m.minor;
    series.push({ on, balanceMinor: bal });
    if (bal < low.minor) low = { minor: bal, on };
  }
  return { series, lowMinor: low.minor, lowOn: low.on, to: addDays(businessToday, HORIZON_DAYS - 1) };
}

// ---------- S3: daily closes with items, states and the reserve summary (DATA-CONTRACT D-SERIES … D-DEF) ----------

export type DayState = 'ABOVE' | 'AT' | 'BELOW' | 'NEGATIVE';
export type ForecastBasis = 'COMMITMENT' | 'BILL' | 'STATED' | 'PAST_DUE' | 'TARGET' | 'PROMISE';

export interface FItem {
  key: string;
  on: LocalDate;
  direction: 'IN' | 'OUT';
  amountMinor: number;
  /** Estimated payout fee on top of an outflow (S3-D12); 0 when none. */
  feeMinor: number;
  basis: ForecastBasis;
  label: string;
  provenance: 'SEEDED' | 'OWNER_ENTERED' | 'DOCUMENT';
  ref: { kind: 'OBLIGATION' | 'BILL' | 'INFLOW' | 'INVOICE'; id: string };
  note: string | null;
}

export interface FDay { on: LocalDate; openingMinor: number; inMinor: number; outMinor: number; closeMinor: number; state: DayState; sameDay: boolean; items: FItem[] }
export interface FSummary {
  lowMinor: number;
  lowOn: LocalDate;
  negativeDays: number;
  atReserveDays: number;
  belowReserveDays: number;
  firstBelowReserve: LocalDate | null;
  reserveGapMinor: number;
  fundingDeficitMinor: number;
}

/** D-STATE: NEGATIVE if close ≤ 0; BELOW if 0 < close < reserve; AT if close = reserve; ABOVE otherwise. */
export const dayState = (closeMinor: number, reserveMinor: number): DayState =>
  closeMinor <= 0 ? 'NEGATIVE' : closeMinor < reserveMinor ? 'BELOW' : closeMinor === reserveMinor ? 'AT' : 'ABOVE';

/**
 * D-SERIES over 42 days from business-today. Items must already sit inside the horizon (past-due ones moved to day 0 by the
 * caller); anything else is the caller's "not in the forecast yet". close[d] = close[d−1] + in[d] − out[d] (out includes fees).
 */
export function forecastDays(openingMinor: number, items: FItem[], today: LocalDate, reserveMinor: number): { days: FDay[]; summary: FSummary } {
  const byDay = new Map<string, FItem[]>();
  for (const i of items) byDay.set(i.on, [...(byDay.get(i.on) ?? []), i]);
  const days: FDay[] = [];
  let bal = openingMinor;
  for (let d = 0; d < HORIZON_DAYS; d++) {
    const on = addDays(today, d);
    const its = byDay.get(on) ?? [];
    const inMinor = its.filter((i) => i.direction === 'IN').reduce((a, i) => a + i.amountMinor, 0);
    const outMinor = its.filter((i) => i.direction === 'OUT').reduce((a, i) => a + i.amountMinor + i.feeMinor, 0);
    const openingDay = bal;
    bal = bal + inMinor - outMinor;
    // D-SAMEDAY ◆: both directions on one day and the outflows exceed the opening (funding depends on intraday timing).
    const sameDay = inMinor > 0 && outMinor > 0 && outMinor > openingDay;
    days.push({ on, openingMinor: openingDay, inMinor, outMinor, closeMinor: bal, state: dayState(bal, reserveMinor), sameDay, items: its });
  }
  return { days, summary: summarize(days.map((d) => ({ on: d.on, closeMinor: d.closeMinor })), reserveMinor) };
}

/** D-LOW (first day reached), D-BREACH, D-RGAP, D-DEF and the day counts, from a close series. */
export function summarize(closes: { on: LocalDate; closeMinor: number }[], reserveMinor: number): FSummary {
  let low = closes[0];
  for (const c of closes) if (c.closeMinor < low.closeMinor) low = c;
  return {
    lowMinor: low.closeMinor,
    lowOn: low.on,
    negativeDays: closes.filter((c) => c.closeMinor <= 0).length,
    atReserveDays: closes.filter((c) => c.closeMinor === reserveMinor).length,
    belowReserveDays: closes.filter((c) => c.closeMinor < reserveMinor).length,
    firstBelowReserve: closes.find((c) => c.closeMinor < reserveMinor)?.on ?? null,
    reserveGapMinor: Math.max(0, reserveMinor - low.closeMinor),
    fundingDeficitMinor: Math.max(0, -low.closeMinor),
  };
}
