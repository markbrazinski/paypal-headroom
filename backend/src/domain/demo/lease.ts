// Merchant lease (S07 §6.1 S7-D13, §6.18 R2). One shared sandbox merchant hosts one active run at a time. The lease is the existing
// PayPal binding (`PPCONN#<c>` / `TENANT`, S1-IR-01) extended with the holder, run, expiry, a version and a claims counter.
// Every PayPal-writing claim TX bumps `claims` under the condition "this run holds the lease" (leaseClaimOps); a Start (reset)
// conditions on the same version and claims it read. So a claim that commits first makes the Start re-read (and see the effect
// as unresolved); a Start that commits first makes the old claim fail (nothing sent). "Unresolved" is derived from the holder run's
// own records, never stored, so no terminal path has to remember to release anything. Stages without a lease (dev) are unchanged.
import { K } from '../../adapters/store/keys.ts';
import type { Item, Op, Store } from '../../adapters/store/port.ts';

// Judge dock (owner, 4 Nov 2026): the live run frees 10 minutes after its holder's last sign of life (the dock's poll bumps lastActiveAt),
// and then resets automatically (live.ts autoReset). ponytail: a forgotten open tab keeps it at most LEASE_MAX_MS.
export const LEASE_IDLE_MS = 10 * 60_000;
export const LEASE_MAX_MS = 90 * 60_000;
/** The holder of a lease taken by the automatic reset (no judge). */
export const AUTO_HOLDER = 'auto-reset';

export interface Lease {
  pk: string; sk: 'TENANT';
  /** true once the merchant is leased per run (review stage); absent = the S1 single-owner binding (dev, local). */
  leased?: boolean;
  tenantId: string | null; runId?: string | null; holderSub?: string | null;
  leasedAt?: string | null; lastActiveAt?: string | null; version?: number; claims?: number;
  /** The reset in progress for this lease, if any (RESET# sk). */
  resetSk?: string | null;
}

export const leaseOf = (s: Store, connectionId: string) => s.get('provider', K.conn(connectionId), 'TENANT') as Promise<(Lease & Item) | undefined>;

export const expiresAt = (l: Pick<Lease, 'leasedAt' | 'lastActiveAt'>) => {
  const idle = Date.parse(l.lastActiveAt ?? l.leasedAt ?? '1970-01-01T00:00:00Z') + LEASE_IDLE_MS;
  const max = Date.parse(l.leasedAt ?? '1970-01-01T00:00:00Z') + LEASE_MAX_MS;
  return new Date(Math.min(idle, max)).toISOString();
};
export const leaseExpired = (l: Lease, now: string) => !!l.tenantId && !!l.leasedAt && now >= expiresAt(l);

/** The op every PayPal-writing claim adds (invoice issue/update, payout, payer, housekeeping). [] on stages without a lease. */
export async function leaseClaimOps(s: Store, connectionId: string, tenantId: string, runId: string, now: string): Promise<Op[]> {
  const l = await leaseOf(s, connectionId);
  if (!l?.leased) return [];
  return [{ op: 'update', table: 'provider', pk: K.conn(connectionId), sk: 'TENANT', set: { lastActiveAt: now }, add: { claims: 1 }, cond: { eq: { tenantId, runId } } }];
}

/**
 * What a run still has in flight with PayPal (S7-D13 / R2): an invoice being issued or unknown, an update or message in flight, a payout
 * reserved, sending or unknown, a payer attempt not yet verified. Derived from the run's own records.
 */
export async function unresolvedOf(s: Store, tenantId: string, runId: string): Promise<string[]> {
  const items = await s.query('core', K.run(tenantId, runId));
  // A reminder-only action is QUEUED while its email waits (OUTMSG QUEUED): no PayPal work, and the send is fenced by the run epoch.
  const mailOnly = new Set(items.filter((i) => i.sk.startsWith('OUTMSG#') && i.state === 'QUEUED').map((i) => i.actionId));
  const out: string[] = [];
  for (const i of items) {
    if (i.sk.startsWith('INV#') && (i.state === 'ISSUING' || i.state === 'ISSUE_UNKNOWN')) out.push(`invoice ${i.invoiceNumber ?? i.invoiceId} is being issued`);
    if (i.sk.startsWith('ACT#') && (i.state === 'UNCERTAIN' || (i.state === 'QUEUED' && !mailOnly.has(i.actionId))) && i.kind !== 'ASK_SUPPLIER') out.push(`${i.counterparty?.name ?? 'an action'}: ${String(i.state).toLowerCase()}`);
    if (i.sk.startsWith('OBL#') && i.payment && i.payment.stage !== 'PAID') out.push(`payout ${i.payment.effectKey} ${String(i.payment.stage).toLowerCase().replace('_', ' ')}`);
    // An invoice update holding its lock (incl. one PayPal left UNKNOWN) is PayPal work even when its action isn't QUEUED (S7b review P3-2).
    if (i.sk.startsWith('INV#') && (await s.get('work', `UPDLOCK#${i.invoiceId}`, 'LOCK'))?.holder) out.push(`invoice ${i.invoiceNumber ?? i.invoiceId} update in flight`);
    if (i.sk.startsWith('PAYER#') && ['QUEUED', 'CLAIMED', 'SUBMITTING', 'SUBMITTED_UNVERIFIED', 'UNKNOWN_UNRESOLVED'].includes(i.phase)) out.push(`payer attempt ${i.sk.slice(6)} ${String(i.phase).toLowerCase().replace(/_/g, ' ')}`);
  }
  return out;
}

export type AcquireCheck = { ok: true } | { ok: false; code: 'MERCHANT_LEASED' | 'PREVIOUS_RUN_UNRESOLVED' | 'RESET_IN_PROGRESS'; text: string; until?: string };

/** Pure: may `holderSub` (for `tenantId`) take the lease now? Same holder, a free or an expired lease; never over unresolved work. */
export function canAcquire(l: Lease | undefined, a: { tenantId: string; holderSub: string; now: string; unresolved: string[]; resetBusy: boolean }): AcquireCheck {
  if (a.resetBusy) return { ok: false, code: 'RESET_IN_PROGRESS', text: 'A reset of this merchant is already running' };
  // The plain S1 binding (never leased) is free to take; a live lease of another holder is not.
  const held = !!l?.leased && !!l.tenantId && (l.holderSub !== a.holderSub || l.tenantId !== a.tenantId) && !leaseExpired(l, a.now);
  if (held) return { ok: false, code: 'MERCHANT_LEASED', text: 'In use by another run', until: expiresAt(l!) };
  if (a.unresolved.length) return { ok: false, code: 'PREVIOUS_RUN_UNRESOLVED', text: `The previous run still has PayPal work in flight: ${a.unresolved.join('; ')}` };
  return { ok: true };
}
