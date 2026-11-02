// Relationship labels (S4-D18): rules, not scores. Inputs are SEEDED payment history plus live facts (S7 R8, relationships/live.ts); never cash. Thresholds are planner values.
import type { HistoryEntry, Tier } from '@headroom/contracts';

export const TIER_LABEL: Record<Tier, string> = { STRONG: 'Strong', GOOD: 'Good', MIXED: 'Mixed', AT_RISK: 'At risk', NOT_ENOUGH_HISTORY: 'Not enough history' };
export const TIER_DOTS: Record<Tier, number> = { STRONG: 4, GOOD: 3, MIXED: 2, AT_RISK: 1, NOT_ENOUGH_HISTORY: 0 };
export const MIN_PAID = 3;

const daysLate = (h: HistoryEntry) => Math.max(0, Math.round((Date.parse(h.paidOn!) - Date.parse(h.dueOn)) / 86_400_000));
export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

export interface Factor { factor: string; value: string; detail: string; sources: string[] }
export interface Assessment { tier: Tier; label: string; dots: number; factors: Factor[] }

export function assess(history: HistoryEntry[]): Assessment {
  const paid = history.filter((h) => h.kind === 'INVOICE_PAID' && h.paidOn);
  const disputes = history.filter((h) => h.kind === 'DISPUTE' && h.open);
  const missed = history.filter((h) => h.kind === 'ARRANGEMENT_MISSED');
  const src = (hs: HistoryEntry[]) => hs.map((h) => `${h.counterpartyId}#${h.n}`);
  const live = (hs: HistoryEntry[]) => { const k = hs.filter((h) => h.basis === 'LIVE').length; return k ? ` · ${hs.length - k} seeded, ${k} live` : ''; };
  const factors: Factor[] = [{ factor: 'Paid invoices', value: String(paid.length), detail: `${paid.length < MIN_PAID ? `Fewer than ${MIN_PAID}: default rules apply` : 'Enough to judge'}${live(paid)}`, sources: src(paid) }];
  let tier: Tier;
  if (disputes.length) tier = 'AT_RISK';
  else if (paid.length < MIN_PAID) tier = 'NOT_ENOUGH_HISTORY';
  else {
    const m = median(paid.map(daysLate));
    tier = m <= 2 ? 'STRONG' : m <= 10 ? 'GOOD' : m <= 30 ? 'MIXED' : 'AT_RISK';
    if (missed.length && (tier === 'STRONG' || tier === 'GOOD')) tier = 'MIXED';
  }
  if (paid.length) factors.push({ factor: 'Median days late', value: `${median(paid.map(daysLate))} days`, detail: '≤ 2 Strong · ≤ 10 Good · ≤ 30 Mixed · more At risk', sources: src(paid) });
  if (disputes.length) factors.push({ factor: 'Open disputes', value: String(disputes.length), detail: `${disputes.map((d) => d.note ?? d.ref).join(' · ')}${live(disputes)}`, sources: src(disputes) });
  if (missed.length) factors.push({ factor: 'Missed arrangements', value: String(missed.length), detail: `A missed arrangement caps the label at Mixed${live(missed)}`, sources: src(missed) });
  return { tier, label: TIER_LABEL[tier], dots: TIER_DOTS[tier], factors };
}
