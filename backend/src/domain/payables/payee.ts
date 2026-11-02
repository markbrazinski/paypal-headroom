// S6 payee identity (S6-D2 as amended by §6.17 R9): a separate owner event from bill verification, terms and payout authority.
// The owner confirms by typing the address the supplier gave them outside Headroom; only the hash is compared and audited.
import type { Payee } from '@headroom/contracts';
import { basisBumpOp } from '../../adapters/store/keys.ts';
import type { Item, Op } from '../../adapters/store/port.ts';
import { ApiError } from '../../api-error.ts';
import type { ReadCtx } from '../../read/models.ts';
import { auditOp } from '../audit/audit.ts';
import type { RunItem } from '../identity-run/run.ts';
import { fenceCheck, type CommandCtx, type CommandResult } from '../receivables/commands.ts';
import { maskReceiver, normalizeReceiver, receiverSha256 } from './payout-core.ts';

/** The raw address is stored only here (and in a payout's frozen request bytes); every read model shows `masked`. */
export type PayeeItem = Payee & Item & { receiver: string };
export const payeeSk = (supplierId: string) => `PAYEE#${supplierId}`;

/** Reset: the operator's sandbox receiver becomes the supplier's payee, UNCONFIRMED and labelled SEEDED. */
export function payeeSeedOps(run: RunItem, supplierId: string, supplierName: string, receiver: string, now: string, correlationId: string): Op[] {
  const p: PayeeItem = {
    pk: run.pk, sk: payeeSk(supplierId), supplierId, rail: 'PAYPAL', receiverType: 'EMAIL', receiver: normalizeReceiver(receiver), receiverSha256: receiverSha256(receiver),
    masked: maskReceiver(receiver), version: 1, state: 'UNCONFIRMED', source: 'SEEDED', confirmedBy: null, confirmedAt: null,
  };
  return [
    { op: 'put', table: 'core', item: p, cond: { notExists: true } },
    auditOp({ tenantId: run.tenantId, runId: run.runId, type: 'PayeeSeeded', by: 'OPERATOR', allowedBy: 'Operator: sandbox reset', result: `SEEDED: ${supplierName}'s PayPal address ${p.masked} (sandbox), not yet confirmed by you`, refs: { supplierId }, correlationId, now }),
  ];
}

const load = async (rc: ReadCtx, supplierId: string) => {
  const p = (await rc.store.get('core', rc.run.pk, payeeSk(supplierId))) as PayeeItem | undefined;
  if (!p) throw new ApiError(404, 'NOT_FOUND', 'No PayPal payee for this supplier'); // includes other tenants' suppliers (S6-R23)
  return p;
};

/** R9: match → CONFIRMED (hash only in audit); mismatch → nothing changes, audited; a stale version → CONSENT_CHANGED. */
export async function confirmPayee(rc: ReadCtx, c: CommandCtx, supplierId: string, body: { version: number; address: string }): Promise<CommandResult> {
  const p = await load(rc, supplierId);
  if (p.version !== body.version) throw new ApiError(409, 'CONSENT_CHANGED', "The supplier's PayPal address changed while this was open · review again");
  if (p.state === 'CONFIRMED') throw new ApiError(409, 'VERSION_CONFLICT', 'Already confirmed');
  const audit = (type: 'PayeeConfirmed' | 'PayeeConfirmFailed', result: string) => auditOp({ tenantId: c.tenantId, runId: c.run.runId, type, by: 'OWNER', allowedBy: c.ownerEmail, result, refs: { supplierId, receiverSha256: p.receiverSha256.slice(0, 12) }, correlationId: c.correlationId, now: c.now });
  if (receiverSha256(body.address) !== p.receiverSha256) {
    // Not a state change: only the audit row is written (a refused confirmation is still an owner event worth keeping).
    return { status: 200, body: { supplierId, state: p.state, version: p.version, matched: false, message: "That doesn't match the address Headroom would pay. Nothing changed." }, ops: [fenceCheck(c), audit('PayeeConfirmFailed', `Typed address did not match ${p.masked}; nothing changed`)] };
  }
  const { releasePayoutHolds } = await import('./payout.ts');
  const rel = await releasePayoutHolds(rc, c.now, ['PAYEE_UNCONFIRMED']);
  return {
    status: 200, body: { supplierId, state: 'CONFIRMED', version: p.version, matched: true, message: `Confirmed: Headroom will pay only ${p.masked} for this supplier` },
    ops: [
      fenceCheck(c),
      { op: 'update', table: 'core', pk: p.pk, sk: p.sk, set: { state: 'CONFIRMED', confirmedBy: c.ownerEmail, confirmedAt: c.now }, cond: { eq: { version: p.version, state: 'UNCONFIRMED' } } },
      basisBumpOp(rc.run.pk),
      audit('PayeeConfirmed', `You confirmed the PayPal address ${p.masked} matches what the supplier gave you outside Headroom (identity only; it permits no payment)`),
      ...rel.ops,
    ],
    afterCommit: rel.afterCommit,
  };
}

/** Owner-only: the exact address, for the confirm and approve dialogs. Audited with the hash only (R9). */
export async function revealPayee(rc: ReadCtx, c: CommandCtx, supplierId: string): Promise<CommandResult> {
  const p = await load(rc, supplierId);
  return {
    status: 200, body: { supplierId, address: p.receiver, masked: p.masked, version: p.version },
    ops: [auditOp({ tenantId: c.tenantId, runId: c.run.runId, type: 'PayeeRevealed', by: 'OWNER', allowedBy: c.ownerEmail, result: `You viewed the full PayPal address for ${p.masked}`, refs: { supplierId, receiverSha256: p.receiverSha256.slice(0, 12) }, correlationId: c.correlationId, now: c.now })],
  };
}
