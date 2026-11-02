// Display formatting only: minor units → "$1,234.56", instants in the business time zone.
import type { Money, SignedMoney } from '@headroom/contracts';
import { serverNow } from './api/client.ts';

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
export const money = (m: Money | SignedMoney | null | undefined) => (m ? usd.format(m.minor / 100) : '—');
/** A lower–upper pair as one value when both ends agree (UX audit: no "$X–$X"). */
export const range = (lo: Money | SignedMoney | null | undefined, hi: Money | SignedMoney | null | undefined) => (lo && hi && lo.minor === hi.minor ? money(lo) : `${money(lo)}–${money(hi)}`);
/** Plan action states in plain words (UX audit F16): never "skipped not_needed". */
const ACTION_STATE: Record<string, string> = {
  PROPOSED: 'Proposed', SCHEDULED: 'Scheduled', WAITING_CONDITION: 'Waiting for its check', HELD: 'Held', HELD_EVIDENCE: 'Waiting for evidence', QUEUED: 'Starting',
  UNCERTAIN: 'Checking', APPLIED: 'In progress', COMPLETED: 'Done', FAILED: 'Failed', SKIPPED_NOT_NEEDED: 'Skipped · not needed', CANCELLED: 'Cancelled',
  EXPIRED: 'Expired', REMOVED: 'Removed', SUPERSEDED: 'Replaced by a later revision',
};
export const actionState = (s: string) => ACTION_STATE[s] ?? words(s);
/** Enum → words for any state without a dedicated label: SKIPPED_NOT_NEEDED → "Skipped not needed". */
export const words = (s: string | null | undefined) => (s ? s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ') : '—');

let zone = 'UTC';
export const setZone = (z: string) => { zone = z; };
export const time = (iso: string | null | undefined) => (iso ? new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', minute: '2-digit' }).format(new Date(iso)) : '—');
export const dateTime = (iso: string | null | undefined) => (iso ? new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso)) : '—');
export const day = (d: string | null | undefined) => (d ? new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(`${d}T00:00:00Z`)) : '—');
export const shortDay = (d: string | null | undefined) => (d ? new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(new Date(`${d}T00:00:00Z`)) : '—');

export function ago(iso: string | null | undefined, now = serverNow()) {
  if (!iso) return '—';
  const m = Math.max(0, Math.round((now - Date.parse(iso)) / 60000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} m ago`;
}

/** A provider-reported amount, exactly as reported (S2-PR-07): never rounded, never shown as $ unless it is USD. */
export function providerAmount(p: { value: string; currencyCode: string | null; currencyKind: string } | null | undefined): string {
  if (!p) return '—';
  const [i, f] = p.value.replace(/^-/, '').split('.');
  const grouped = `${p.value.startsWith('-') ? '-' : ''}${Number(i).toLocaleString('en-US')}${f ? `.${f}` : ''}`;
  if (p.currencyKind === 'UNKNOWN' || !p.currencyCode) return `${grouped} (currency not reported)`;
  if (p.currencyCode === 'USD' && (!f || f.length <= 2)) return usd.format(Number(p.value));
  if (p.currencyCode === 'USD') return `USD ${grouped} · unexpected precision`;
  return `${p.currencyCode} ${grouped}`;
}
