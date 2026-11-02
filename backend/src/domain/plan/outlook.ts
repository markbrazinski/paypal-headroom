// Outlook rows and scenarios (S4-D11, P-rules; §6.17 R6): every figure is a forecastDays() run over the Expected movements plus
// the changes an included action would make. Targets are net of the estimated fee, labelled "not agreed". No likelihood anywhere.
import type { LocalDate } from '@headroom/contracts';
import type { FDay, FSummary } from '../cash-forecast/forecast.ts';
import type { TermsChange } from '../obligations/obligations.ts';
import type { Candidate } from './candidates.ts';
import { dayName, money } from './candidates.ts';

/** A candidate, or a stored action with its changes derived (edit.ts changesOf). */
export type OutlookAction = Pick<Candidate, 'kind' | 'rootId' | 'counterparty' | 'terms' | 'estimate' | 'changes' | 'conditional'>;
export type Price = (changes: TermsChange[]) => { days: FDay[]; summary: FSummary } | null;
export interface Row { key: string; label: string; condition: string; changes: TermsChange[]; concessionMinor: number }
export interface PricedRow extends Row { needByClose: number; lowMinor: number; lowOn: LocalDate; firstBelowReserve: LocalDate | null; gapMinor: number }

const short = (c: OutlookAction) => c.counterparty.name.split(' ')[0];

/** The "If…" rows: nothing early; each collection alone; all of them; each alone (and none) with the fallback paid early. */
export function outlookRowsFor(included: OutlookAction[]): Row[] {
  const coll = included.filter((c) => c.kind === 'COLLECT_OVERDUE' || c.kind === 'COLLECT_UNDISPUTED_SLICE' || c.kind === 'COLLECT_DISPUTED');
  const fb = included.filter((c) => c.kind === 'DISCOUNT_FALLBACK');
  const by = (c: OutlookAction) => dayName(c.terms.targetOn!);
  const rows: Row[] = [{ key: 'none', label: 'Nothing arrives early', condition: 'Accepted terms and stated dates only', changes: [], concessionMinor: 0 }];
  for (const c of coll) rows.push({ key: `only:${c.rootId}`, label: `${short(c)} pays by the target, ${by(c)}`, condition: `${money(c.estimate!.net.minor)} net after an estimated ${money(c.estimate!.fee.minor)} fee · not agreed`, changes: c.changes, concessionMinor: 0 });
  if (coll.length > 1) rows.push({ key: 'all', label: `${coll.map(short).join(' and ')} both pay by the target`, condition: 'Each net of its estimated fee · not agreed', changes: coll.flatMap((c) => c.changes), concessionMinor: 0 });
  for (const f of fb) {
    const early = `${short(f)} offer sent and paid early (${money(f.terms.amount.minor)} by ${dayName(f.terms.payBy!)})`;
    for (const c of coll) rows.push({ key: `only:${c.rootId}+${f.rootId}`, label: `Only ${short(c)} pays; ${early}`, condition: `Fallback runs only if verified funds fall short · ${money(f.estimate!.net.minor)} net`, changes: [...c.changes, ...f.changes], concessionMinor: f.terms.discountAmount!.minor });
    rows.push({ key: `none+${f.rootId}`, label: `No collection arrives; ${early}`, condition: `Fallback only · ${money(f.estimate!.net.minor)} net`, changes: f.changes, concessionMinor: f.terms.discountAmount!.minor });
  }
  return rows;
}

export function priceRows(rows: Row[], price: Price, needBy: LocalDate): PricedRow[] | null {
  const out: PricedRow[] = [];
  for (const r of rows) {
    const f = price(r.changes);
    if (!f) return null;
    out.push({ ...r, needByClose: f.days.find((d) => d.on === needBy)?.closeMinor ?? f.days[0].closeMinor, lowMinor: f.summary.lowMinor, lowOn: f.summary.lowOn, firstBelowReserve: f.summary.firstBelowReserve, gapMinor: f.summary.reserveGapMinor });
  }
  return out;
}

/** S4-D11: Ideal adds every included non-conditional collection target; Downside leaves out every stated inflow. */
export function scenarioChanges(scenario: 'EXPECTED' | 'IDEAL' | 'DOWNSIDE', included: OutlookAction[], statedInflowIds: string[]): TermsChange[] {
  if (scenario === 'IDEAL') return included.filter((c) => !c.conditional && c.kind !== 'PAYOUT').flatMap((c) => c.changes);
  if (scenario === 'DOWNSIDE') return [...statedInflowIds.map((inflowId) => ({ kind: 'DROP_INFLOW' as const, inflowId })), { kind: 'DROP_PENDING' as const }];
  return [];
}
export const SCENARIO_BASIS = {
  EXPECTED: 'Expected · accepted terms and stated dates; nothing Headroom is aiming for',
  IDEAL: "Ideal · Expected plus every planned collection paid by its target (Headroom's aim, not agreed; net of estimated fees). Fallbacks excluded",
  DOWNSIDE: "Downside · Expected without any stated receipt or captured money still awaiting PayPal's report (only what is agreed and verified)",
} as const;
