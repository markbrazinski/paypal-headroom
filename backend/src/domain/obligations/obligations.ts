// Commitment occurrences (S3-D15) and the forecast movements they produce (C-FUNDS). Pure.
// Occurrences are generated on each read from the schedule; a stored OBL# (written only when a bill substantiates or
// re-terms one) overrides the generated default terms, so accepted per-occurrence changes survive every later read.
import type { Commitment, CommitmentSchedule, LocalDate, Occurrence, StatedInflow } from '@headroom/contracts';
import { addDays } from '../time.ts';
import type { FItem } from '../cash-forecast/forecast.ts';

/** Matching looks this far past the horizon end, so a bill for a commitment just outside the forecast still matches. */
export const MATCH_WINDOW_DAYS = 92;
/**
 * Estimated PayPal payout fee per item: 2% of the item, at most $20.00. This is what the PayPal sandbox charged on 2–3 Nov 2026
 * ($0.84 on $41.91; $20.00 on $3,137.25 and on $5,000.00), so the demo forecast matches what leaves PayPal. An estimate, not a PayPal
 * promise: the paid record keeps PayPal's actual fee, and the funds checks keep their own, larger allowance (payout-core `feeCeilingMinor`).
 */
export const PAYOUT_FEE_RATE_BP = 200;
export const PAYOUT_FEE_CAP_MINOR = 2_000;
export const payoutFeeEstimateMinor = (faceMinor: number) => Math.min(Math.ceil((faceMinor * PAYOUT_FEE_RATE_BP) / 10_000), PAYOUT_FEE_CAP_MINOR);

export const occKey = (commitmentId: string, n: number) => `occ#${commitmentId}#${n}`;
export const oblSk = (commitmentId: string, n: number) => `OBL#${commitmentId}#${n}`;
export function parseOccKey(key: string): { commitmentId: string; n: number } | null {
  const m = /^occ#(.+)#(\d+)$/.exec(key);
  return m ? { commitmentId: m[1], n: Number(m[2]) } : null;
}

const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate(); // m is 0-based

/** Occurrence n of a monthly schedule: the anchor's day in month anchor+n, clamped to month end, always from the original anchor. */
export function monthlyOn(anchorOn: LocalDate, n: number): LocalDate {
  const [y, m, d] = anchorOn.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  const day = Math.min(d, daysInMonth(t.getUTCFullYear(), t.getUTCMonth()));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Scheduled dates with their index n, from the commitment's created date through `until`. */
export function scheduleDates(s: CommitmentSchedule, createdOn: LocalDate, until: LocalDate): { n: number; on: LocalDate }[] {
  const all = s.kind === 'ONCE' ? [{ n: 0, on: s.on }] : s.kind === 'DATES' ? s.dates.map((on, n) => ({ n, on })) : [];
  if (s.kind === 'MONTHLY') {
    for (let n = 0; ; n++) {
      const on = monthlyOn(s.anchorOn, n);
      if (on > until || (s.endOn && on > s.endOn)) break;
      all.push({ n, on });
    }
  }
  return all.filter((x) => x.on >= createdOn && x.on <= until);
}

/** The first scheduled date on or after `from`, however far ahead (S3-IM-05: a saved date beyond the matching window stays visible). */
export function firstOnOrAfter(s: CommitmentSchedule, from: LocalDate): LocalDate | null {
  if (s.kind === 'ONCE') return s.on >= from ? s.on : null;
  if (s.kind === 'DATES') return s.dates.find((d) => d >= from) ?? null;
  for (let n = 0; n < 2400; n++) { // ponytail: linear month scan, ceiling 200 years
    const on = monthlyOn(s.anchorOn, n);
    if (s.endOn && on > s.endOn) return null;
    if (on >= from) return on;
  }
  return null;
}

export interface StoredObligation { commitmentId: string; n: number; scheduledOn: LocalDate; dueOn: LocalDate; amount: { currency: 'USD'; minor: number }; version: number; substantiatedBy?: string; termsVersion: number; state?: Occurrence['state']; payment?: Occurrence['payment']; nextPaymentVersion?: number }

/** Every occurrence of `c` up to `until`, overlaid by its stored OBL# if any. */
export function occurrencesOf(c: Commitment, stored: Map<string, StoredObligation>, until: LocalDate): Occurrence[] {
  return scheduleDates(c.schedule, c.createdOn, until).map(({ n, on }) => {
    const s = stored.get(occKey(c.commitmentId, n));
    return {
      occurrenceKey: occKey(c.commitmentId, n), commitmentId: c.commitmentId, n, scheduledOn: on,
      dueOn: s?.dueOn ?? on, amount: s?.amount ?? c.amount, version: s?.version ?? 0,
      ...(s?.substantiatedBy ? { substantiatedBy: s.substantiatedBy } : {}), materialized: !!s,
      ...(s?.state ? { state: s.state } : {}), ...(s?.payment ? { payment: s.payment } : {}),
    };
  });
}

/**
 * How comparisons, bill impacts and plan outlook rows are priced (D-COMPARE): a one-off replacement of an occurrence's terms, one
 * added outflow, a Headroom target receipt (net of its estimated fee, basis TARGET, S4-D11/D12), or a stated inflow left out.
 */
export type TermsChange =
  | { kind: 'REPLACE'; occurrenceKey: string; dueOn: LocalDate; amountMinor: number }
  | { kind: 'ADD'; key: string; dueOn: LocalDate; amountMinor: number; label: string; feeMinor: number }
  | { kind: 'TARGET_IN'; key: string; on: LocalDate; netMinor: number; label: string; note: string; ref: FItem['ref'] }
  | { kind: 'DROP_INFLOW'; inflowId: string }
  /** S5-D6: price without captured money still awaiting PayPal's report (Downside, conservative views). */
  | { kind: 'DROP_PENDING' };

export interface MovementInputs {
  commitments: Commitment[];
  occurrences: Occurrence[];
  inflows: StatedInflow[];
  /** bill ref by bill id, for occurrences a verified bill substantiates (basis BILL). */
  billRefs: Map<string, string>;
  /** Delegation `cash.protectedPayments` (S7 §6.1a): a protected payment's money is set aside this many days before it is due. */
  setAsideDays?: number;
}

export interface NotInForecast { key: string; label: string; amountMinor: number | null; reason: string; ref: FItem['ref'] | null }

/**
 * Forecast items in the horizon [today, today+41] and what stays out. Past-due unpaid occurrences sit on day 0 (S3 has no
 * settlement; S6 removes paid ones). Stated inflows whose date has passed are not counted (a stated receipt that didn't arrive).
 */
export function movements(x: MovementInputs, today: LocalDate, changes: TermsChange | TermsChange[] = []): { items: FItem[]; notInForecast: NotInForecast[] } {
  const all = Array.isArray(changes) ? changes : [changes];
  const horizonEnd = addDays(today, 41);
  const byId = new Map(x.commitments.map((c) => [c.commitmentId, c]));
  const items: FItem[] = [];
  const out: NotInForecast[] = [];
  const nextAfter = new Map<string, { on: LocalDate; minor: number }>();
  const push = (key: string, on: LocalDate, minor: number, fee: number, basis: FItem['basis'], label: string, prov: FItem['provenance'], ref: FItem['ref'], note: string | null) => {
    if (on > horizonEnd) return false;
    const past = on < today;
    items.push({ key, on: past ? today : on, direction: 'OUT', amountMinor: minor, feeMinor: fee, basis: past ? 'PAST_DUE' : basis, label, provenance: prov, ref, note: past ? `Was due ${on}; not paid yet${note ? ` · ${note}` : ''}` : note });
    return true;
  };
  for (const o of x.occurrences) {
    const c = byId.get(o.commitmentId);
    if (!c) continue;
    // S6 R1: reserved, in flight or paid → its debit is in the PayPal opening (the reservation), never also a dated OUT item.
    if (o.payment) { out.push({ key: o.occurrenceKey, label: c.name, amountMinor: o.amount.minor, reason: o.payment.stage === 'PAID' ? 'Paid through PayPal' : 'Reserved for a PayPal payout · counted in Cash now', ref: { kind: 'OBLIGATION', id: o.occurrenceKey } }); continue; }
    const replaced = all.find((ch): ch is Extract<TermsChange, { kind: 'REPLACE' }> => ch.kind === 'REPLACE' && ch.occurrenceKey === o.occurrenceKey) ?? null;
    const dueOn = replaced?.dueOn ?? o.dueOn;
    const minor = replaced?.amountMinor ?? o.amount.minor;
    const fee = c.rail === 'PAYPAL_PAYOUT' ? payoutFeeEstimateMinor(minor) : 0;
    const billRef = o.substantiatedBy ? x.billRefs.get(o.substantiatedBy) : undefined;
    const basis = billRef ? 'BILL' : 'COMMITMENT';
    // A split part the supplier agreed in writing is as documented as the bill it came from (S7 R6).
    const prov = c.provenance === 'BILL' || c.provenance === 'SUPPLIER_TERMS' ? 'DOCUMENT' : c.provenance;
    const note = [billRef ? `Bill ${billRef}` : null, c.estimate ? 'Estimate' : null].filter(Boolean).join(' · ') || null;
    // Set aside early: the payment itself never moves (no action can move or delay it); only when its money stops being usable.
    const aside = c.protected && x.setAsideDays ? x.setAsideDays : 0;
    // S7a-IR-09: a payment due just past the horizon whose set-aside day falls inside it is counted (push applies the horizon to `on`).
    const on = aside ? (addDays(dueOn, -aside) < today ? today : addDays(dueOn, -aside)) : dueOn;
    const asideNote = on !== dueOn ? [note, `Set aside ${aside} day${aside === 1 ? '' : 's'} before it is due ${dueOn} (your delegation)`].filter(Boolean).join(' · ') : note;
    if (!push(o.occurrenceKey, on, minor, fee, basis, c.name, prov, { kind: 'OBLIGATION', id: o.occurrenceKey }, asideNote)) {
      const prev = nextAfter.get(c.commitmentId);
      if (!prev || dueOn < prev.on) nextAfter.set(c.commitmentId, { on: dueOn, minor });
    }
  }
  for (const ch of all) {
    if (ch.kind === 'ADD') push(ch.key, ch.dueOn, ch.amountMinor, ch.feeMinor, 'BILL', ch.label, 'DOCUMENT', { kind: 'BILL', id: ch.key }, 'If accepted');
    // A target is Headroom's aim, not agreed: it never lands before today, and one past the horizon simply isn't in it.
    if (ch.kind === 'TARGET_IN' && ch.on <= horizonEnd) items.push({ key: ch.key, on: ch.on < today ? today : ch.on, direction: 'IN', amountMinor: ch.netMinor, feeMinor: 0, basis: 'TARGET', label: ch.label, provenance: 'SEEDED', ref: ch.ref, note: ch.note });
  }
  const dropped = new Set(all.flatMap((ch) => (ch.kind === 'DROP_INFLOW' ? [ch.inflowId] : [])));
  // A commitment whose next occurrence is beyond the horizon: saved, shown, not yet assessed (design X-com-late).
  for (const [cid, n] of nextAfter) {
    const inHorizon = items.some((i) => i.ref.kind === 'OBLIGATION' && i.key.startsWith(`occ#${cid}#`));
    if (!inHorizon) out.push({ key: `after:${cid}`, label: `${byId.get(cid)!.name} · next ${n.on}`, amountMinor: n.minor, reason: 'After the forecast window · not yet assessed', ref: null });
  }
  for (const i of x.inflows) {
    if (dropped.has(i.inflowId)) continue;
    if (i.on < today) out.push({ key: `inflow:${i.inflowId}`, label: i.label, amountMinor: i.amount.minor, reason: `Stated for ${i.on} and not received · not counted`, ref: { kind: 'INFLOW', id: i.inflowId } });
    else if (i.on > horizonEnd) out.push({ key: `inflow:${i.inflowId}`, label: i.label, amountMinor: i.amount.minor, reason: 'After the forecast window', ref: { kind: 'INFLOW', id: i.inflowId } });
    else items.push({ key: `inflow:${i.inflowId}`, on: i.on, direction: 'IN', amountMinor: i.amount.minor, feeMinor: 0, basis: i.basis, label: i.label, provenance: 'SEEDED', ref: { kind: 'INFLOW', id: i.inflowId }, note: i.basis === 'PROMISE' ? 'Promised by the customer; not a receipt, never counted as cash' : 'Stated by you; not a receipt' });
  }
  return { items, notInForecast: out };
}

/** C-CURRENT-1 input (S3-PR-04): operative unpaid occurrences due today or earlier, each with its estimated fee. Later ones are not subtracted. */
export function dueObligationsMinor(commitments: Commitment[], occurrences: Occurrence[], today: LocalDate): number[] {
  const byId = new Map(commitments.map((c) => [c.commitmentId, c]));
  return occurrences.filter((o) => o.dueOn <= today && byId.has(o.commitmentId) && !o.payment)
    .map((o) => o.amount.minor + (byId.get(o.commitmentId)!.rail === 'PAYPAL_PAYOUT' ? payoutFeeEstimateMinor(o.amount.minor) : 0));
}
