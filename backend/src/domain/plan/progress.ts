// S5-D13: what a receipt does to the action collecting that invoice. Pure; the PLAN_PROGRESS job applies it under the action
// version. A send or update already in flight is never cancelled: progress waits for it, and its terminal TX re-runs progress.
import type { ActionState, InvoiceProjection, PlanAction } from '@headroom/contracts';

export type Progress =
  | { kind: 'NONE' }
  | { kind: 'WAIT'; why: string }
  | { kind: 'MOVE'; to: ActionState; text: string; releaseUnsent: boolean; progress: { paidMinor: number; ofMinor: number } | null };

const dollars = (m: number) => `$${(m / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function progressFor(a: Pick<PlanAction, 'kind' | 'state' | 'terms'>, p: InvoiceProjection): Progress {
  if (a.state === 'QUEUED' || a.state === 'UNCERTAIN') return { kind: 'WAIT', why: 'An update or message is in flight; progress runs again when it settles' };
  if (a.kind === 'DISCOUNT_FALLBACK') {
    if (p.collectibleOpen.minor !== 0) return { kind: 'NONE' };
    if (a.state === 'WAITING_CONDITION' || a.state === 'HELD_EVIDENCE' || a.state === 'HELD') return { kind: 'MOVE', to: 'CANCELLED', text: 'Paid in full; no offer needed', releaseUnsent: true, progress: null };
    if (a.state === 'APPLIED') return { kind: 'MOVE', to: 'COMPLETED', text: 'Paid; the discount was used', releaseUnsent: true, progress: null };
    return { kind: 'NONE' };
  }
  if (a.kind === 'COLLECT_UNDISPUTED_SLICE') {
    const of = a.terms.amount.minor;
    const open = p.undisputedOpen?.minor ?? p.collectibleOpen.minor;
    if (open === 0 && ['SCHEDULED', 'HELD', 'APPLIED'].includes(a.state)) return { kind: 'MOVE', to: 'COMPLETED', text: `Paid ${dollars(of)} of ${dollars(of)}`, releaseUnsent: a.state !== 'APPLIED', progress: { paidMinor: of, ofMinor: of } };
    return { kind: 'NONE' };
  }
  // S7 R5: a disputed ask is done once nothing of the disputed amount is outstanding.
  if (a.kind === 'COLLECT_DISPUTED') {
    if ((p.disputedUnresolved?.minor ?? p.collectibleOpen.minor) === 0 && ['SCHEDULED', 'HELD', 'APPLIED'].includes(a.state)) return { kind: 'MOVE', to: 'COMPLETED', text: `Paid ${dollars(a.terms.amount.minor)} of the disputed amount`, releaseUnsent: a.state !== 'APPLIED', progress: null };
    return { kind: 'NONE' };
  }
  if (a.kind === 'COLLECT_OVERDUE' && p.collectibleOpen.minor === 0 && ['SCHEDULED', 'HELD', 'APPLIED'].includes(a.state)) {
    return { kind: 'MOVE', to: 'COMPLETED', text: 'Paid in full', releaseUnsent: a.state !== 'APPLIED', progress: null };
  }
  return { kind: 'NONE' };
}
