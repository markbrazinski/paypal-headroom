import { DAY, HOUR, MIN, addMs } from '../time.ts';

/**
 * Poll cadence (S01 T3.3): 1, 2, 5, 15 min after issue, then hourly until day 7, then every 6 h;
 * after PAID a daily capture re-read for refunds. No fixed cutoff: the read grant/budget is the limit.
 */
export function nextPollAt(issuedAt: string, now: string, paid: boolean): string {
  if (paid) return addMs(now, DAY);
  const age = Date.parse(now) - Date.parse(issuedAt);
  for (const step of [1, 2, 5, 15].map((m) => m * MIN)) if (age < step) return addMs(issuedAt, step);
  if (age < 7 * DAY) return addMs(issuedAt, (Math.floor(age / HOUR) + 1) * HOUR);
  return addMs(now, 6 * HOUR);
}
