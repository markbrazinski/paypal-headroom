// Action dates (S4-D13 as revised by S04 §6.17 R5). Business-local, Mon–Fri, inside the Delegation window (`comms.window`, S7), no holidays. Pure: `now` is passed in.
// Nothing is ever scheduled in the past: a target that can't land before need-by is flagged Late, and a conditional fallback
// whose 09:00 check has already passed is not offered as scheduled work (TOO_LATE).
import type { LocalDate, Policy } from '@headroom/contracts';
import { valueOf } from '../delegation/policy.ts';
import type { Window } from '../delegation/specs.ts';
import { addDays, businessDate } from '../time.ts';

/** S7 §6.1a: the contact/payout window is the owner's Delegation value (seed 08:00–18:00). */
export const windowOf = (p: Policy) => valueOf<Window>(p, 'comms.window');
export type { Window };
export const FALLBACK_CHECK_HHMM = '09:00';
export const REPLY_CHECK_BD = 3;

const weekday = (d: LocalDate) => new Date(`${d}T00:00:00Z`).getUTCDay();
export const isBusinessDay = (d: LocalDate) => weekday(d) !== 0 && weekday(d) !== 6;

/** n business days after (n > 0) or before (n < 0) `d`. */
export function addBusinessDays(d: LocalDate, n: number): LocalDate {
  let x = d;
  for (let left = Math.abs(n); left > 0;) { x = addDays(x, Math.sign(n)); if (isBusinessDay(x)) left--; }
  return x;
}

const hhmm = (instant: string, tz: string) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(instant));

/** The UTC instant of local `date` at `time` in `tz`, using that date's own offset (DST-safe for whole-hour zones). */
export function zonedInstant(date: LocalDate, time: string, tz: string): string {
  const [h, m] = time.split(':').map(Number);
  const guess = Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10), h, m);
  const offsetAt = (ms: number) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - ms;
  };
  let ms = guess - offsetAt(guess);
  ms = guess - offsetAt(ms);
  return new Date(ms).toISOString();
}

/** The earliest moment Headroom may contact someone: now inside business hours, else the next opening. */
export function earliestContact(now: string, tz: string, w: Window): { on: LocalDate; at: string } {
  const today = businessDate(now, tz);
  const t = hhmm(now, tz);
  if (isBusinessDay(today) && t >= w.open && t < w.close) return { on: today, at: now };
  const on = isBusinessDay(today) && t < w.open ? today : addBusinessDays(today, 1);
  return { on, at: zonedInstant(on, w.open, tz) };
}

/** Inside the owner's messaging window (Delegation `comms.window`, business days)? Else when it opens next. */
export function windowOpen(now: string, tz: string, w: Window): string | null {
  const t = hhmm(now, tz);
  return isBusinessDay(businessDate(now, tz)) && t >= w.open && t < w.close ? null : earliestContact(now, tz, w).at;
}

export interface PlanDates {
  contactOn: LocalDate;
  contactAt: string;
  replyCheckOn: LocalDate;
  targetOn: LocalDate;
  /** Set when the target can't land before need-by: it is priced where it can land, never backdated. */
  late: string | null;
  /**
   * Owner, 2 Nov 2026: an overdue, undisputed invoice already has a PayPal pay link, so Headroom asks today and aims for the next
   * business day (same day if that is the last day before need-by), checking for payment on the target day.
   */
  overdue: { targetOn: LocalDate; replyCheckOn: LocalDate; late: string | null };
  fallback: { checkAt: string; expiresOn: LocalDate } | { tooLate: string };
}

const short = (d: LocalDate) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(`${d}T00:00:00Z`));

export function planDates(needBy: LocalDate, now: string, tz: string, w: Window): PlanDates {
  const c = earliestContact(now, tz, w);
  const wanted = addBusinessDays(needBy, -1);
  const targetOn = wanted < c.on ? c.on : wanted;
  const replyCheckOn = [addBusinessDays(c.on, REPLY_CHECK_BD), targetOn].sort()[0];
  const checkOn = addBusinessDays(needBy, -2);
  const checkAt = zonedInstant(checkOn, FALLBACK_CHECK_HHMM, tz);
  const soon = addBusinessDays(c.on, 1);
  const overdueTarget = soon < wanted ? soon : wanted < c.on ? c.on : wanted;
  return {
    overdue: { targetOn: overdueTarget, replyCheckOn: overdueTarget, late: overdueTarget >= needBy ? `Too late to arrive before ${short(needBy)}; it still shrinks the later gap` : null },
    contactOn: c.on, contactAt: c.at, replyCheckOn, targetOn,
    late: targetOn >= needBy ? `Too late to arrive before ${short(needBy)}; it still shrinks the later gap` : null,
    fallback: checkAt > c.at ? { checkAt, expiresOn: needBy } : { tooLate: `Its check time, ${short(checkOn)} ${FALLBACK_CHECK_HHMM}, has passed before the gap` },
  };
}

/** Estimated PayPal fee on a receipt (S4-D12): 3.49% half-up + $0.49. Captured fees replace it in S5. */
export const estimatedFeeMinor = (grossMinor: number) => Math.floor((grossMinor * 349 + 5_000) / 10_000) + 49;

/** S5-D8: when a still-unproven fallback goes to the owner: checkAt + 1 business day, same local time (hero Thu Nov 12 09:00). */
export const decideByOf = (checkAt: string, tz: string) => zonedInstant(addBusinessDays(businessDate(checkAt, tz), 1), hhmm(checkAt, tz), tz);
