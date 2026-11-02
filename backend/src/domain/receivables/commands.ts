// Owner commands for S1 (T1, T2). Each returns the ops for ONE transaction; the router adds the idempotency marker.
import { createHash, randomBytes } from 'node:crypto';
import { assertTransition, type InvoiceMirror } from '@headroom/contracts';
import { K } from '../../adapters/store/keys.ts';
import type { Op, Store } from '../../adapters/store/port.ts';
import { ApiError } from '../../api-error.ts';
import { auditOp } from '../audit/audit.ts';
import { newJob, putJobOp } from '../../jobs/lease.ts';
import type { RunItem } from '../identity-run/run.ts';
import { businessDate } from '../time.ts';
import { validateDraft, type DraftCommand } from './receivables.ts';
import { invoiceRow } from '../../read/models.ts';

export interface CommandCtx { tenantId: string; run: RunItem; now: string; correlationId: string; ownerEmail: string }
/** `rerunOnConflict`: on a refused condition, run the command once more; its re-read decides (S3 duplicate upload race). */
export interface CommandResult { status: number; body: unknown; ops: Op[]; afterCommit?: () => Promise<void>; conflict?: ApiError; rerunOnConflict?: boolean }

export type InvItem = InvoiceMirror & { pk: string; sk: string; tenantId: string; issuedAt?: string | null };

/** Invoice ids embed their run so a command on an old run's invoice is answered RUN_SEALED, not 404. */
export const newInvoiceId = (runId: string) => `inv_${runId.replace(/^run-/, '')}_${randomBytes(5).toString('hex')}`;
export const runOfInvoiceId = (invoiceId: string) => { const m = /^inv_([a-z0-9]+)_/.exec(invoiceId); return m ? `run-${m[1]}` : null; };

export async function createInvoiceDraft(s: Store, c: CommandCtx, cmd: DraftCommand): Promise<CommandResult> {
  const pk = K.run(c.tenantId, c.run.runId);
  const customers = (await s.query('core', pk, { skPrefix: 'CUST#' })) as any[];
  const refusals = validateDraft(cmd, customers, businessDate(c.now, c.run.settings.timeZone));
  if (refusals.length) throw new ApiError(400, 'INVALID_INPUT', refusals.map((r) => r.message).join('; '), refusals);
  const invoiceId = newInvoiceId(c.run.runId);
  const inv: InvItem = {
    pk, sk: `INV#${invoiceId}`, tenantId: c.tenantId, invoiceId, runId: c.run.runId, customerId: cmd.customerId, amount: cmd.amount, dueOn: cmd.dueOn,
    state: 'DRAFT', version: 1, invoiceNumber: null, ppInvoiceId: null, providerStatus: null, payerUrl: null, openGross: cmd.amount,
    ownerAssertions: [], hold: null, failureReason: null, lastCheckedAt: null, lastRawSha256: null, createdAt: c.now, issuedAt: null,
  };
  return {
    status: 201,
    // op 0: the run fence, so a command racing a reset is refused rather than landing in a sealed run (S1-IR-08)
    body: { invoice: invoiceRow(inv, customers.find((x) => x.customerId === cmd.customerId)!.displayName, undefined, null), aggregateVersion: 1, correlationId: c.correlationId },
    ops: [
      fenceCheck(c),
      { op: 'put', table: 'core', item: inv, cond: { notExists: true } },
      auditOp({ tenantId: c.tenantId, runId: c.run.runId, type: 'InvoiceDraftSaved', by: 'OWNER', allowedBy: c.ownerEmail, result: 'Draft saved; not counted in the forecast', refs: { invoiceId }, correlationId: c.correlationId, now: c.now }),
    ],
  };
}

export async function sendInvoice(s: Store, c: CommandCtx, invoiceId: string, ifMatch: string | undefined): Promise<CommandResult> {
  const inv = await loadInvoice(s, c, invoiceId);
  if (ifMatch === undefined || String(inv.version) !== ifMatch.replace(/"/g, '')) throw new ApiError(409, 'VERSION_CONFLICT', `Invoice is at version ${inv.version}`);
  if (inv.state !== 'DRAFT') throw new ApiError(422, 'NOT_DRAFT', `Invoice is ${inv.state}`);
  assertTransition('Invoice', 'DRAFT', 'ISSUING');
  const seq = (await s.get('core', inv.pk, 'SEQ#INVOICE'))!;
  const number = invoiceNumber(c.run.runId, seq.next);
  return {
    status: 202,
    body: { effectId: number, jobId: `eff#${number}`, aggregateVersion: inv.version + 1 },
    conflict: new ApiError(409, 'VERSION_CONFLICT', 'Invoice changed; reload and try again'),
    ops: [
      fenceCheck(c),
      { op: 'update', table: 'core', pk: inv.pk, sk: inv.sk, set: { state: 'ISSUING', invoiceNumber: number, version: inv.version + 1 }, cond: { eq: { version: inv.version, state: 'DRAFT' } } },
      { op: 'update', table: 'core', pk: inv.pk, sk: 'SEQ#INVOICE', set: { next: seq.next + 1 }, cond: { eq: { next: seq.next } } },
      ...issueOps({ tenantId: c.tenantId, runId: c.run.runId, epoch: c.run.epoch }, inv, number, c.now, { by: 'OWNER', allowedBy: c.ownerEmail, correlationId: c.correlationId }),
    ],
  };
}

export const invoiceNumber = (runId: string, n: number) => `HR-${runId.replace(/^run-/, '')}-${String(n).padStart(3, '0')}`;

/**
 * The S1 issue ops shared by the owner's send and the operator's hero reset (S04 §6.17 R3): global number registry, the INVOICE_ISSUE
 * effect (key = number, epoch-fenced), its job and the audit. The caller writes the INV# item and the sequence itself.
 */
export function issueOps(run: { tenantId: string; runId: string; epoch: number }, inv: Pick<InvItem, 'invoiceId' | 'customerId' | 'amount' | 'dueOn'>, number: string, now: string, a: { by: 'OWNER' | 'OPERATOR'; allowedBy: string; correlationId: string }): Op[] {
  const argsHash = createHash('sha256').update(JSON.stringify([number, inv.customerId, inv.amount, inv.dueOn])).digest('hex');
  return [
    // Global uniqueness of the number across runs: the 422-duplicate path relies on "it exists, so it's ours".
    { op: 'put', table: 'provider', item: { pk: K.invNum(number), sk: 'REF', tenantId: run.tenantId, runId: run.runId, invoiceId: inv.invoiceId }, cond: { notExists: true } },
    { op: 'put', table: 'work', cond: { notExists: true }, item: {
      pk: K.effect(number), sk: 'EFFECT', effectKey: number, kind: 'INVOICE_ISSUE', tenantId: run.tenantId, runId: run.runId, epoch: run.epoch,
      invoiceId: inv.invoiceId, state: 'READY', argsHash, ppInvoiceId: null, failureReason: null, updatedAt: now,
    } },
    putJobOp(newJob(`eff#${number}`, 'EXECUTE_EFFECT', number, now, run.tenantId, run.runId)),
    auditOp({ tenantId: run.tenantId, runId: run.runId, type: 'InvoiceIssueRequested', by: a.by, allowedBy: a.allowedBy, result: `Issue ${number} on PayPal requested (no email)`, refs: { invoiceId: inv.invoiceId, effectKey: number }, correlationId: a.correlationId, now }),
  ];
}

export const fenceCheck = (c: CommandCtx): Op => ({ op: 'check', table: 'core', pk: K.tenant(c.tenantId), sk: 'RUN_FENCE', cond: { eq: { runId: c.run.runId, epoch: c.run.epoch } } });

export async function loadInvoice(s: Store, c: { tenantId: string; run: RunItem }, invoiceId: string): Promise<InvItem> {
  const runId = runOfInvoiceId(invoiceId);
  if (!runId) throw new ApiError(404, 'NOT_FOUND', 'No such invoice');
  const inv = (await s.get('core', K.run(c.tenantId, runId), `INV#${invoiceId}`)) as InvItem | undefined;
  if (!inv) throw new ApiError(404, 'NOT_FOUND', 'No such invoice'); // includes other tenants' ids (S1-R4)
  if (runId !== c.run.runId) throw new ApiError(409, 'RUN_SEALED', `Invoice belongs to sealed run ${runId}`);
  return inv;
}
