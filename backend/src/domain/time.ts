import type { LocalDate } from '@headroom/contracts';

/** Calendar date in the business's time zone. */
export function businessDate(instant: string, timeZone: string): LocalDate {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(instant));
}

export function addDays(date: LocalDate, days: number): LocalDate {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export const addMs = (instant: string, ms: number) => new Date(Date.parse(instant) + ms).toISOString();
export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;
