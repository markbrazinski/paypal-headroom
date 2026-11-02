// Disputes from a customer's own email (S07 §6.18 R4). A DISPUTE / DISPUTE_PARTIAL reading writes an immutable PROPOSAL# and a
// DISPUTEPENDING# stop in one TX with holds on the invoice's actions; nothing collects on the invoice while it is PENDING. Only the
// owner turns a proposal into a CLAIM# (confirmDispute) or dismisses it. Amounts come only from the email's words (gates.disputeSplit).
import type { ClaimSplit, DisputePending, DisputeProposal } from '@headroom/contracts';
import { basisBumpOp, K } from '../../adapters/store/keys.ts';
import type { Item, Op, Store } from '../../adapters/store/port.ts';
import { ApiError } from '../../api-error.ts';
import type { ReadCtx } from '../../read/models.ts';
import { auditOp } from '../audit/audit.ts';
import { loadPlanState } from '../plan/state.ts';
import { businessDate } from '../time.ts';
import { fenceCheck, type CommandCtx, type CommandResult, type InvItem } from './commands.ts';

export type PendingItem = DisputePending & Item;
export const pendingSk = (invoiceId: string) => `DISPUTEPENDING#${invoiceId}`;
export const proposalSk = (invoiceId: string, messageId: string) => `PROPOSAL#${invoiceId}#${messageId}`;
const usd = (minor: number) => ({ currency: 'USD' as const, minor });
const dollars = (m: number) => `$${(m / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** Approved actions that a pending dispute holds (nothing of them is sent or claimed yet). */
const HOLDABLE = ['SCHEDULED', 'WAITING_CONDITION', 'HELD_EVIDENCE'];

/** The ops a dispute reading writes (worker, REPLY_INTERPRET). Idempotent per message through PROPOSAL#'s notExists. */
export async function proposeDisputeOps(s: Store, x: { tenantId: string; runId: string; inv: InvItem; messageId: string; quote: string; split: { disputedMinor: number | null; undisputedMinor: number | null; derived: 'DISPUTED' | 'UNDISPUTED' | null }; now: string }): Promise<Op[]> {
  const pk = K.run(x.tenantId, x.runId);
  const proposalId = `${x.inv.invoiceId}#${x.messageId}`;
  const p: DisputeProposal = {
    proposalId, invoiceId: x.inv.invoiceId, customerId: x.inv.customerId, messageId: x.messageId, quote: x.quote, invoiceVersion: x.inv.version, openMinor: x.inv.openGross.minor,
    disputed: x.split.disputedMinor === null ? null : usd(x.split.disputedMinor), undisputed: x.split.undisputedMinor === null ? null : usd(x.split.undisputedMinor), derived: x.split.derived, at: x.now,
  };
  const cur = (await s.get('core', pk, pendingSk(x.inv.invoiceId))) as PendingItem | undefined;
  const pending: DisputePending = { invoiceId: x.inv.invoiceId, proposalId, messageId: x.messageId, invoiceVersion: x.inv.version, openMinor: x.inv.openGross.minor, state: 'PENDING', version: (cur?.version ?? 0) + 1 };
  const acts = (await s.query('core', pk, { skPrefix: 'ACT#' })).filter((a) => a.subject?.invoiceId === x.inv.invoiceId && HOLDABLE.includes(a.state));
  const amounts = p.disputed && p.undisputed ? `disputes ${dollars(p.disputed.minor)}, accepts ${dollars(p.undisputed.minor)}${p.derived ? ` (${p.derived.toLowerCase()} part worked out from the open amount)` : ''}` : 'amounts not clear from the email: you enter them';
  return [
    { op: 'put', table: 'core', item: { pk, sk: proposalSk(x.inv.invoiceId, x.messageId), ...p }, cond: { notExists: true } },
    cur ? { op: 'put', table: 'core', item: { pk, sk: pendingSk(x.inv.invoiceId), ...pending }, cond: { eq: { version: cur.version } } } : { op: 'put', table: 'core', item: { pk, sk: pendingSk(x.inv.invoiceId), ...pending }, cond: { notExists: true } },
    ...acts.map((a): Op => ({ op: 'update', table: 'core', pk, sk: a.sk, set: { state: 'HELD', holdCode: 'DISPUTE_PENDING', heldReasons: [`Dispute waiting for you: “${x.quote}”`], version: a.version + 1 }, cond: { eq: { version: a.version, state: a.state } } })),
    basisBumpOp(pk),
    auditOp({ tenantId: x.tenantId, runId: x.runId, type: 'DisputeProposed', by: 'HEADROOM', result: `Dispute read from the customer’s email (“${x.quote}”): ${amounts}. Nothing collects on ${x.inv.invoiceNumber} until you confirm or dismiss it`, refs: { invoiceId: x.inv.invoiceId, mailId: x.messageId, proposalId }, correlationId: `dispute:${proposalId}`, now: x.now }),
  ];
}

async function load(rc: ReadCtx, invoiceId: string, proposalId: string) {
  const s = await loadPlanState(rc);
  const inv = s.invoices.find((i) => i.invoiceId === invoiceId);
  if (!inv) throw new ApiError(404, 'NOT_FOUND', 'No such invoice');
  const pending = (await rc.store.get('core', s.pk, pendingSk(invoiceId))) as PendingItem | undefined;
  if (!pending || pending.state !== 'PENDING') throw new ApiError(409, 'VERSION_CONFLICT', 'No dispute is waiting on this invoice');
  if (pending.proposalId !== proposalId) throw new ApiError(409, 'VERSION_CONFLICT', 'A newer email about this dispute arrived; review it');
  const p = (await rc.store.get('core', s.pk, proposalSk(invoiceId, pending.messageId))) as (DisputeProposal & Item) | undefined;
  if (!p) throw new ApiError(404, 'NOT_FOUND', 'Proposal missing');
  return { s, inv, pending, p };
}

/** Held actions on the invoice go back to their approved state; their due jobs re-run and re-check everything (claims are fenced). */
async function releaseOps(rc: ReadCtx, s: Awaited<ReturnType<typeof loadPlanState>>, invoiceId: string) {
  const { releaseHolds, pull } = await import('../comms/commands.ts');
  const r = await releaseHolds({ ...s, actions: s.actions.filter((a) => a.subject.invoiceId === invoiceId) }, 'DISPUTE_PENDING', null);
  return { ops: r.ops, after: async (now: string) => { for (const j of r.jobs) await pull(rc.store, j, now); } };
}

/** The owner's split decides what may be collected. It creates no permission; collecting still follows Delegation and approvals. */
export async function confirmDispute(rc: ReadCtx, c: CommandCtx, invoiceId: string, body: { proposalId: string; undisputedMinor: number; disputedMinor: number; invoiceVersion: number }): Promise<CommandResult> {
  const { s, inv, pending, p } = await load(rc, invoiceId, body.proposalId);
  // S7a-IR-03: fenced on the invoice as it is now (a payment while pending changes what is open); the parts must sum to that.
  if (inv.version !== body.invoiceVersion) throw new ApiError(409, 'VERSION_CONFLICT', 'The invoice changed since you opened it (for example a payment); review the amounts again');
  if (body.undisputedMinor + body.disputedMinor !== inv.openGross.minor) throw new ApiError(400, 'INVALID_INPUT', `The two parts must add up to the ${dollars(inv.openGross.minor)} still open`);
  const mail = await rc.store.get('core', s.pk, `MAIL#${pending.messageId}`);
  const claim: ClaimSplit = {
    invoiceId, undisputed: usd(body.undisputedMinor), disputed: usd(body.disputedMinor),
    acknowledgement: { from: String(mail?.from ?? 'The customer'), quote: p.quote, on: businessDate(String(mail?.receivedAt ?? c.now), rc.run.settings.timeZone) },
    basis: 'CUSTOMER_REPLY', source: { messageId: pending.messageId, proposalId: p.proposalId, by: 'OWNER' },
  };
  // A claim is immutable: an invoice already split keeps its split; a later email about it can only be dismissed here.
  if (await rc.store.get('core', s.pk, `CLAIM#${invoiceId}`)) throw new ApiError(409, 'VERSION_CONFLICT', 'This invoice already has a confirmed split; it is never changed. Dismiss this email, or handle the change in PayPal');
  const rel = await releaseOps(rc, s, invoiceId);
  return {
    status: 200, body: { invoiceId, undisputed: claim.undisputed, disputed: claim.disputed },
    afterCommit: () => rel.after(c.now),
    ops: [
      fenceCheck(c),
      { op: 'check', table: 'core', pk: s.pk, sk: inv.sk, cond: { eq: { version: inv.version } } },
      { op: 'put', table: 'core', item: { pk: s.pk, sk: `CLAIM#${invoiceId}`, ...claim }, cond: { notExists: true } },
      { op: 'update', table: 'core', pk: s.pk, sk: pending.sk, set: { state: 'CONFIRMED' }, add: { version: 1 }, cond: { eq: { version: pending.version, state: 'PENDING' } } },
      ...rel.ops, basisBumpOp(s.pk),
      auditOp({ tenantId: c.tenantId, runId: c.run.runId, type: 'DisputeConfirmed', by: 'OWNER', allowedBy: c.ownerEmail, result: `You confirmed ${inv.invoiceNumber}: ${dollars(body.disputedMinor)} disputed, ${dollars(body.undisputedMinor)} undisputed (from the customer’s email${p.disputed && p.disputed.minor !== body.disputedMinor ? `; you changed Headroom’s reading of ${dollars(p.disputed.minor)}` : ''}). No permission created`, refs: { invoiceId, proposalId: p.proposalId, mailId: pending.messageId }, correlationId: c.correlationId, now: c.now }),
    ],
  };
}

export async function dismissDispute(rc: ReadCtx, c: CommandCtx, invoiceId: string, body: { proposalId: string }): Promise<CommandResult> {
  const { s, inv, pending } = await load(rc, invoiceId, body.proposalId);
  const rel = await releaseOps(rc, s, invoiceId);
  return {
    status: 200, body: { invoiceId, state: 'NOT_A_DISPUTE' },
    afterCommit: () => rel.after(c.now),
    ops: [
      fenceCheck(c),
      { op: 'update', table: 'core', pk: s.pk, sk: pending.sk, set: { state: 'NOT_A_DISPUTE' }, add: { version: 1 }, cond: { eq: { version: pending.version, state: 'PENDING' } } },
      ...rel.ops, basisBumpOp(s.pk),
      auditOp({ tenantId: c.tenantId, runId: c.run.runId, type: 'DisputeDismissed', by: 'OWNER', allowedBy: c.ownerEmail, result: `You marked the email about ${inv.invoiceNumber} as not a dispute; held work on it can run again once its own checks pass`, refs: { invoiceId, proposalId: body.proposalId }, correlationId: c.correlationId, now: c.now }),
    ],
  };
}
