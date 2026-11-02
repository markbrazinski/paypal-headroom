// S5-D3: claim-aware allocation and the invoice projection, from immutable records only (ALLOC#, CONCESSION#, CLAIM#).
// The provider mirror (PayPal's due and status) is copied beside it, never computed; a disagreement is a reconciliation HOLD.
import type { Allocation, ClaimSplit, Concession, InvoiceProjection, Money } from '@headroom/contracts';

const usd = (minor: number): Money => ({ currency: 'USD', minor });
const sum = (xs: { amount: Money }[]) => xs.reduce((t, x) => t + x.amount.minor, 0);

type Alloc = Pick<Allocation, 'claim' | 'amount'>;
type Conc = Pick<Concession, 'amount' | 'state'>;

/**
 * Split one verified capture's gross: on a claimed invoice the undisputed part first, then DISPUTED only up to the consumed allowance
 * the owner approved (S7 R5, `DISPALLOW#` allowed − used), the rest UNALLOCATED (the owner's decision); otherwise WHOLE.
 * Total allocated = captured gross. Without an allowance nothing ever goes to DISPUTED.
 */
export function allocateClaim(grossMinor: number, claim: Pick<ClaimSplit, 'undisputed'> | null, prior: Alloc[], allowance: { allowedMinor: number; usedMinor: number } | null = null): { claim: Allocation['claim']; minor: number }[] {
  if (!Number.isInteger(grossMinor) || grossMinor <= 0) throw new Error('gross must be a positive integer');
  if (!claim) return [{ claim: 'WHOLE', minor: grossMinor }];
  const undisputedOpen = Math.max(0, claim.undisputed.minor - sum(prior.filter((a) => a.claim === 'UNDISPUTED')));
  const u = Math.min(grossMinor, undisputedOpen);
  const dis = Math.min(grossMinor - u, Math.max(0, (allowance?.allowedMinor ?? 0) - (allowance?.usedMinor ?? 0)));
  const rest = grossMinor - u - dis;
  return [...(u ? [{ claim: 'UNDISPUTED' as const, minor: u }] : []), ...(dis ? [{ claim: 'DISPUTED' as const, minor: dis }] : []), ...(rest ? [{ claim: 'UNALLOCATED' as const, minor: rest }] : [])];
}

/**
 * collectibleOpen = original − Σ allocated gross − Σ concessions (ACTIVE or SETTLED). For a claimed invoice also undisputedOpen,
 * disputedUnresolved (disputed − what was collected under an approved disputed ask, S7 R5) and unallocatedCredit; then by construction
 * collectibleOpen = undisputedOpen + disputedUnresolved − unallocatedCredit − concessions.
 */
export function invoiceProjection(
  inv: { amount: Money },
  provider: { dueMinor: number | null; status: string | null },
  claim: Pick<ClaimSplit, 'undisputed' | 'disputed'> | null,
  allocs: Alloc[],
  concessions: Conc[],
): InvoiceProjection {
  const conc = sum(concessions.filter((c) => c.state === 'ACTIVE' || c.state === 'SETTLED'));
  const raw = inv.amount.minor - sum(allocs) - conc;
  const collectible = Math.max(0, raw);
  const conservation = raw < 0 ? 'HOLD' : provider.dueMinor === null ? 'UNKNOWN' : provider.dueMinor === collectible ? 'PASS' : 'HOLD';
  return {
    providerDue: provider.dueMinor === null ? null : usd(provider.dueMinor), providerStatus: provider.status,
    collectibleOpen: usd(collectible),
    undisputedOpen: claim ? usd(Math.max(0, claim.undisputed.minor - sum(allocs.filter((a) => a.claim === 'UNDISPUTED')))) : null,
    disputedUnresolved: claim ? usd(Math.max(0, claim.disputed.minor - sum(allocs.filter((a) => a.claim === 'DISPUTED')))) : null,
    unallocatedCredit: claim ? usd(sum(allocs.filter((a) => a.claim === 'UNALLOCATED'))) : null,
    concessions: usd(conc),
    conservation,
  };
}

/** The sentence for a conservation HOLD (shown on the invoice; it blocks the skip, S5-D7). */
export const conservationText = (p: InvoiceProjection) =>
  `PayPal shows ${p.providerDue ? `$${(p.providerDue.minor / 100).toFixed(2)}` : 'an unreadable amount'} due, Headroom expects $${(p.collectibleOpen.minor / 100).toFixed(2)}`;
