// Owner commands on bills and commitments (S03 T8–T10). Verification ≠ term acceptance ≠ payment authorization: each is its
// own command and its own immutable record. Each returns the ops for ONE transaction; the router adds the idempotency marker.
import { createHash, randomBytes } from 'node:crypto';
import { assertTransition, type ChangedField, type Commitment, type LocalDate, type Occurrence } from '@headroom/contracts';
import { basisBumpOp, K } from '../../adapters/store/keys.ts';
import type { Op, Store } from '../../adapters/store/port.ts';
import { ApiError } from '../../api-error.ts';
import { auditOp } from '../audit/audit.ts';
import { newJob, putJobOp } from '../../jobs/lease.ts';
import { fenceCheck, type CommandCtx, type CommandResult } from '../receivables/commands.ts';
import { addDays, businessDate } from '../time.ts';
import { ingestJobId, runOfBillId } from '../evidence/ingest.ts';
import { loadRun, supplierLabel, type BillItem, type RunObligations } from './load.ts';
import { billNoSk, changedFieldsOf, classOf } from './match.ts';
import { occKey, oblSk, parseOccKey } from './obligations.ts';

const usd = (minor: number) => ({ currency: 'USD' as const, minor });
const sha = (x: unknown) => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const money = (minor: number) => `$${(minor / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** The consent binds exactly what changes: occurrence (+version), the changed fields, before → after, and the document (S3-PR-03). */
export const termsHash = (o: Pick<Occurrence, 'occurrenceKey' | 'version' | 'dueOn' | 'amount'>, changed: ChangedField[], after: { dueOn: LocalDate; amountMinor: number }, docSha: string) =>
  sha(['CHANGED_TERMS', o.occurrenceKey, o.version, [...changed].sort(), { dueOn: o.dueOn, amount: o.amount.minor }, { dueOn: after.dueOn, amount: after.amountMinor, currency: 'USD' }, docSha]);
export const separateHash = (billId: string, dueOn: LocalDate, amountMinor: number, docSha: string) => sha(['SEPARATE', billId, dueOn, amountMinor, 'USD', docSha]);

export const billAmountMinor = (b: BillItem) => b.amount?.minor ?? null;

/**
 * S3-IM-02: only the current bill for its supplier + number may verify or add an outflow. Holding the slot is checked in the
 * command's TX; a bill read before slots existed claims it (put-if-absent), so a superseded or rival copy can't act.
 */
async function slotOp(s: Store, b: BillItem): Promise<Op[]> {
  if (!b.supplierId || !b.billNumber) return [];
  const sk = billNoSk(b.supplierId, b.billNumber);
  const cur = await s.get('core', b.pk, sk);
  if (cur && cur.billId !== b.billId) throw new ApiError(409, 'VERSION_CONFLICT', 'A newer copy of this bill replaced it; open the latest one');
  return [cur ? { op: 'check', table: 'core', pk: b.pk, sk, cond: { eq: { billId: b.billId } } } : { op: 'put', table: 'core', item: { pk: b.pk, sk, billId: b.billId, version: 1 }, cond: { notExists: true } }];
}

export async function loadBill(s: Store, c: { tenantId: string; run: { runId: string } }, billId: string): Promise<BillItem> {
  const runId = runOfBillId(billId);
  if (!runId) throw new ApiError(404, 'NOT_FOUND', 'No such bill');
  const b = (await s.get('core', K.run(c.tenantId, runId), `BILL#${billId}`)) as BillItem | undefined;
  if (!b) throw new ApiError(404, 'NOT_FOUND', 'No such bill'); // includes other tenants' ids (S3-R14)
  if (runId !== c.run.runId) throw new ApiError(409, 'RUN_SEALED', `Bill belongs to sealed run ${runId}`);
  return b;
}

function checkVersion(b: BillItem, ifMatch: string | undefined) {
  if (ifMatch === undefined || String(b.version) !== ifMatch.replace(/"/g, '')) throw new ApiError(409, 'VERSION_CONFLICT', `Bill is at version ${b.version}; reload`);
}
const heldError = (b: BillItem) => new ApiError(422, 'BILL_HELD', `Held: ${b.holdReasons.join('; ') || 'needs checking'}`);
const today = (c: CommandCtx) => businessDate(c.now, c.run.settings.timeZone);

/** The terms a verified bill would set on its occurrence, with the bill's (or the owner-attested) amount. */
function proposal(b: BillItem, attested: boolean) {
  const minor = b.amount?.minor ?? (attested ? b.printedMinor : null);
  return minor === null || !b.dueOn ? null : { dueOn: b.dueOn, amountMinor: minor };
}

/** T8: the document is a genuine bill for this occurrence. No dates or amounts change; payment stays not authorized. */
export async function verifyBill(s: Store, c: CommandCtx, billId: string, ifMatch: string | undefined, body: { occurrenceKey: string | null; occurrenceVersion: number; currency?: 'USD' }): Promise<CommandResult> {
  const b = await loadBill(s, c, billId);
  checkVersion(b, ifMatch);
  if (b.state === 'HELD') throw heldError(b);
  if (b.state !== 'PROPOSED') throw new ApiError(409, 'VERSION_CONFLICT', `Bill is ${b.state.toLowerCase().replace('_', ' ')}`);
  if (b.currencyBasis === 'BARE_DOLLAR' && body.currency !== 'USD') throw new ApiError(400, 'INVALID_INPUT', 'Only "$" is printed: confirm the bill is in US dollars');
  if (!body.occurrenceKey) throw new ApiError(400, 'INVALID_INPUT', 'This bill matches no commitment: add it as a separate obligation instead');
  if (!b.candidates.includes(body.occurrenceKey)) throw new ApiError(422, 'NOT_A_CANDIDATE', 'That payment is not one this bill could match');
  const r = await loadRun(s, c.tenantId, c.run.runId, today(c));
  const o = r.occurrences.find((x) => x.occurrenceKey === body.occurrenceKey);
  if (!o) throw new ApiError(422, 'NOT_A_CANDIDATE', 'That payment is no longer scheduled');
  const stale = new ApiError(409, 'VERSION_CONFLICT', 'That payment changed or another bill was verified for it; the choices have been refreshed');
  if (o.version !== body.occurrenceVersion || (o.substantiatedBy && o.substantiatedBy !== b.revisionOf)) throw stale;
  const p = proposal(b, body.currency === 'USD')!;
  // Server recompute against the SELECTED occurrence (S3-PR-08).
  const changed = changedFieldsOf(o, p.dueOn, p.amountMinor);
  const classification = b.revisionOf ? (changed.length ? 'REVISION_CHANGED_TERMS' : 'REVISION_SAME_TERMS') : classOf(changed);
  assertTransition('Bill', 'PROPOSED', 'VERIFIED');
  const { commitmentId, n } = parseOccKey(o.occurrenceKey)!;
  const stored = r.stored.get(o.occurrenceKey);
  // substantiatedBy is absent until set, never null; a second bill for the occurrence fails these conditions (one outflow).
  const oblOp: Op = stored
    ? { op: 'update', table: 'core', pk: stored.pk, sk: stored.sk, set: { substantiatedBy: billId, version: stored.version + 1 }, cond: o.substantiatedBy ? { eq: { version: o.version, substantiatedBy: o.substantiatedBy } } : { eq: { version: o.version }, missing: ['substantiatedBy'] } }
    : { op: 'put', table: 'core', cond: { notExists: true }, item: { pk: K.run(c.tenantId, c.run.runId), sk: oblSk(commitmentId, n), occurrenceKey: o.occurrenceKey, commitmentId, n, scheduledOn: o.scheduledOn, dueOn: o.dueOn, amount: o.amount, state: 'SCHEDULED', termsVersion: 0, termsHash: null, substantiatedBy: billId, version: 1 } };
  const name = r.commitments.find((x) => x.commitmentId === commitmentId)?.name ?? 'the commitment';
  const attested = body.currency === 'USD' && b.currencyBasis === 'BARE_DOLLAR';
  return {
    status: 200, body: { billId, state: 'VERIFIED', version: b.version + 1 }, conflict: stale,
    ops: [
      fenceCheck(c),
      basisBumpOp(K.run(c.tenantId, c.run.runId)), // S4 §6.17 R1: plan inputs changed
      ...(await slotOp(s, b)),
      { op: 'update', table: 'core', pk: b.pk, sk: b.sk, cond: { eq: { version: b.version, state: 'PROPOSED' } },
        set: { state: 'VERIFIED', version: b.version + 1, updatedAt: c.now, occurrenceKey: o.occurrenceKey, candidates: [o.occurrenceKey], classification, changedFields: changed, proposedTerms: { dueOn: p.dueOn, amount: usd(p.amountMinor) }, ...(attested ? { amount: usd(p.amountMinor) } : {}) } },
      { op: 'put', table: 'core', cond: { notExists: true }, item: { pk: b.pk, sk: `VERIFY#${billId}`, billId, by: c.ownerEmail, at: c.now, documentSha256: b.documentSha256, occurrenceKey: o.occurrenceKey, occurrenceVersion: o.version, currencyAttested: attested ? 'USD' : null, billVersion: b.version } },
      oblOp,
      auditOp({ tenantId: c.tenantId, runId: c.run.runId, type: 'BillVerified', by: 'OWNER', allowedBy: c.ownerEmail, result: `Verified ${b.billNumber ?? b.fileName} as the bill for ${name}${attested ? ' (in US dollars, as you confirmed)' : ''}. ${changed.length ? 'Its different terms are not applied until you accept them' : 'Terms match; nothing changes in the forecast'}. Payment not authorized`, refs: { billId, occurrenceKey: o.occurrenceKey }, correlationId: c.correlationId, now: c.now }),
    ],
  };
}

/** T9: accept exactly the changed fields. The forecast moves (still one outflow). Payment stays not authorized. */
export async function acceptBillTerms(s: Store, c: CommandCtx, billId: string, ifMatch: string | undefined, body: { termsHash: string; changedFields: ChangedField[] }): Promise<CommandResult> {
  const b = await loadBill(s, c, billId);
  checkVersion(b, ifMatch);
  if (b.state === 'HELD') throw heldError(b);
  if (b.state === 'PROPOSED') throw new ApiError(422, 'NOT_VERIFIED', 'Verify the bill first');
  if (b.state !== 'VERIFIED') throw new ApiError(422, 'NOTHING_TO_ACCEPT', `Bill is ${b.state.toLowerCase().replace('_', ' ')}`);
  const r = await loadRun(s, c.tenantId, c.run.runId, today(c));
  const o = r.occurrences.find((x) => x.occurrenceKey === b.occurrenceKey);
  const stored = b.occurrenceKey ? r.stored.get(b.occurrenceKey) : undefined;
  if (!o || !stored || !b.proposedTerms) throw new ApiError(422, 'NOTHING_TO_ACCEPT', 'This bill has no terms to accept');
  if (stored.substantiatedBy !== billId) throw new ApiError(409, 'VERSION_CONFLICT', 'A newer copy of this bill now stands for this payment; open the latest one');
  const after = { dueOn: b.proposedTerms.dueOn, amountMinor: b.proposedTerms.amount.minor };
  const changed = changedFieldsOf(o, after.dueOn, after.amountMinor);
  if (!changed.length) throw new ApiError(422, 'NOTHING_TO_ACCEPT', 'The bill already matches the forecast');
  if ([...body.changedFields].sort().join() !== [...changed].sort().join()) throw new ApiError(409, 'TERMS_CHANGED', `What changes is now ${changed.join(' and ')}; review again`);
  if (body.termsHash !== termsHash(o, changed, after, b.documentSha256)) throw new ApiError(409, 'TERMS_CHANGED', 'The terms changed since you looked; review again');
  assertTransition('Bill', 'VERIFIED', 'TERMS_ACCEPTED');
  const tv = stored.termsVersion + 1;
  const hash = termsHash(o, changed, after, b.documentSha256);
  const fmt = (f: ChangedField, x: { dueOn: string; amountMinor: number }) => (f === 'dueOn' ? x.dueOn : money(x.amountMinor));
  const what = changed.map((f) => `${f === 'dueOn' ? 'date' : 'amount'} ${fmt(f, { dueOn: o.dueOn, amountMinor: o.amount.minor })} → ${fmt(f, after)}`).join(', ');
  const conflict = new ApiError(409, 'VERSION_CONFLICT', 'Changed concurrently; reload and try again');
  return {
    status: 200, body: { billId, state: 'TERMS_ACCEPTED', version: b.version + 1 }, conflict,
    ops: [
      fenceCheck(c),
      basisBumpOp(K.run(c.tenantId, c.run.runId)), // S4 §6.17 R1: plan inputs changed
      { op: 'put', table: 'core', cond: { notExists: true }, item: { pk: b.pk, sk: `TERMS#${o.occurrenceKey}#${tv}`, kind: 'CHANGED_TERMS', billId, occurrenceKey: o.occurrenceKey, changedFields: changed, before: { dueOn: o.dueOn, amount: o.amount }, after: { dueOn: after.dueOn, amount: usd(after.amountMinor) }, termsHash: hash, by: c.ownerEmail, at: c.now } },
      // Only the bill that currently substantiates the payment may change its terms (a replaced copy can't, S3-IM-02).
      { op: 'update', table: 'core', pk: stored.pk, sk: stored.sk, set: { dueOn: after.dueOn, amount: usd(after.amountMinor), termsVersion: tv, termsHash: hash, version: stored.version + 1 }, cond: { eq: { version: stored.version, substantiatedBy: billId } } },
      { op: 'update', table: 'core', pk: b.pk, sk: b.sk, set: { state: 'TERMS_ACCEPTED', version: b.version + 1, updatedAt: c.now }, cond: { eq: { version: b.version, state: 'VERIFIED' } } },
      auditOp({ tenantId: c.tenantId, runId: c.run.runId, type: 'BillTermsAccepted', by: 'OWNER', allowedBy: c.ownerEmail, result: `Accepted ${b.billNumber ?? 'bill'}: ${what}. Still one payment; payment not authorized; rules unchanged`, refs: { billId, occurrenceKey: o.occurrenceKey }, correlationId: c.correlationId, now: c.now }),
    ],
  };
}

/** T8a: a known supplier's bill as one new outflow. One dialog, two separate immutable records (verification, terms). */
export async function addBillAsObligation(s: Store, c: CommandCtx, billId: string, ifMatch: string | undefined, body: { termsHash: string; currency?: 'USD' }): Promise<CommandResult> {
  const b = await loadBill(s, c, billId);
  checkVersion(b, ifMatch);
  if (b.state === 'HELD') throw heldError(b);
  if (b.state !== 'PROPOSED') throw new ApiError(409, 'VERSION_CONFLICT', `Bill is ${b.state.toLowerCase().replace('_', ' ')}`);
  if (!b.supplierId) throw new ApiError(400, 'INVALID_INPUT', 'Only bills from a known supplier can be added');
  if (b.currencyBasis === 'BARE_DOLLAR' && body.currency !== 'USD') throw new ApiError(400, 'INVALID_INPUT', 'Only "$" is printed: confirm the bill is in US dollars');
  const p = proposal(b, body.currency === 'USD');
  if (!p) throw new ApiError(400, 'INVALID_INPUT', 'The bill has no grounded amount and due date');
  if (body.termsHash !== separateHash(billId, p.dueOn, p.amountMinor, b.documentSha256)) throw new ApiError(409, 'TERMS_CHANGED', 'The bill changed since you looked; review again');
  assertTransition('Bill', 'PROPOSED', 'TERMS_ACCEPTED');
  const r = await loadRun(s, c.tenantId, c.run.runId, today(c));
  const supplier = supplierLabel(r, b);
  const commitmentId = `bill-${billId}`;
  const key = occKey(commitmentId, 0);
  const t = today(c);
  const cmt: Commitment = {
    commitmentId, supplierId: b.supplierId, name: `${supplier} · bill ${b.billNumber ?? ''}`.trim(), reference: b.billNumber, amount: usd(p.amountMinor), schedule: { kind: 'ONCE', on: p.dueOn },
    rail: 'NOT_HEADROOM', estimate: false, protected: false, provenance: 'BILL', createdOn: p.dueOn < t ? p.dueOn : t, createdAt: c.now,
  };
  const attested = body.currency === 'USD' && b.currencyBasis === 'BARE_DOLLAR';
  const pk = K.run(c.tenantId, c.run.runId);
  return {
    status: 200, body: { billId, state: 'TERMS_ACCEPTED', version: b.version + 1 }, conflict: new ApiError(409, 'VERSION_CONFLICT', 'This bill was already added or changed; reload'),
    ops: [
      fenceCheck(c),
      basisBumpOp(K.run(c.tenantId, c.run.runId)), // S4 §6.17 R1: plan inputs changed
      ...(await slotOp(s, b)),
      { op: 'put', table: 'core', cond: { notExists: true }, item: { pk, sk: `CMT#${commitmentId}`, ...cmt } },
      // One outflow per bill, ever.
      { op: 'put', table: 'core', cond: { notExists: true }, item: { pk, sk: oblSk(commitmentId, 0), occurrenceKey: key, commitmentId, n: 0, scheduledOn: p.dueOn, dueOn: p.dueOn, amount: usd(p.amountMinor), state: 'SCHEDULED', termsVersion: 1, termsHash: body.termsHash, substantiatedBy: billId, version: 1 } },
      { op: 'put', table: 'core', cond: { notExists: true }, item: { pk, sk: `VERIFY#${billId}`, billId, by: c.ownerEmail, at: c.now, documentSha256: b.documentSha256, occurrenceKey: key, occurrenceVersion: 0, currencyAttested: attested ? 'USD' : null, billVersion: b.version } },
      { op: 'put', table: 'core', cond: { notExists: true }, item: { pk, sk: `TERMS#${key}#1`, kind: 'SEPARATE_OBLIGATION', billId, occurrenceKey: key, changedFields: [], before: null, after: { dueOn: p.dueOn, amount: usd(p.amountMinor) }, termsHash: body.termsHash, by: c.ownerEmail, at: c.now } },
      { op: 'update', table: 'core', pk: b.pk, sk: b.sk, cond: { eq: { version: b.version, state: 'PROPOSED' } },
        set: { state: 'TERMS_ACCEPTED', version: b.version + 1, updatedAt: c.now, occurrenceKey: key, candidates: [key], changedFields: [], proposedTerms: { dueOn: p.dueOn, amount: usd(p.amountMinor) }, amount: usd(p.amountMinor) } },
      auditOp({ tenantId: c.tenantId, runId: c.run.runId, type: 'BillVerified', by: 'OWNER', allowedBy: c.ownerEmail, result: `Verified ${b.billNumber ?? b.fileName} from ${supplier} as genuine`, refs: { billId }, correlationId: c.correlationId, now: c.now }),
      auditOp({ tenantId: c.tenantId, runId: c.run.runId, type: 'BillTermsAccepted', by: 'OWNER', allowedBy: c.ownerEmail, result: `Added ${money(p.amountMinor)} due ${p.dueOn} to ${supplier} as a new outflow (separate obligation). Payment not authorized`, refs: { billId, occurrenceKey: key }, correlationId: c.correlationId, now: c.now }),
    ],
  };
}

/** Read again after READ_FAILED: a new generation, so an older worker can never publish into it (S3-D17). */
export async function retryBill(s: Store, c: CommandCtx, billId: string, ifMatch: string | undefined): Promise<CommandResult> {
  const b = await loadBill(s, c, billId);
  checkVersion(b, ifMatch);
  if (b.state !== 'READ_FAILED') throw new ApiError(400, 'INVALID_INPUT', 'Only a bill that could not be read can be retried');
  assertTransition('Bill', 'READ_FAILED', 'RECEIVED');
  const gen = b.readGeneration + 1;
  const jobId = ingestJobId(billId, gen);
  return {
    status: 202, body: { billId, jobId },
    ops: [
      fenceCheck(c),
      { op: 'update', table: 'core', pk: b.pk, sk: b.sk, set: { state: 'RECEIVED', readGeneration: gen, readFailure: null, version: b.version + 1, updatedAt: c.now }, cond: { eq: { version: b.version, state: 'READ_FAILED' } } },
      putJobOp(newJob(jobId, 'INGEST_DOCUMENT', billId, c.now, c.tenantId, c.run.runId)),
      auditOp({ tenantId: c.tenantId, runId: c.run.runId, type: 'BillRetryRequested', by: 'OWNER', allowedBy: c.ownerEmail, result: `Reading ${b.fileName} again`, refs: { billId }, correlationId: c.correlationId, now: c.now }),
    ],
  };
}

/** T10 (UI-AP-12). A date after the horizon is saved and "not yet assessed"; it enters the forecast when the horizon reaches it. */
export async function createCommitment(_s: Store, c: CommandCtx, body: { name: string; amount: { currency: 'USD'; minor: number }; on: LocalDate; recurrence: 'NONE' | 'MONTHLY'; estimate: boolean; protected: boolean }): Promise<CommandResult> {
  const t = today(c);
  if (body.amount.minor <= 0) throw new ApiError(400, 'INVALID_INPUT', 'Amount must be more than zero', [{ path: 'amount', message: 'must be more than zero' }]);
  if (body.on < t) throw new ApiError(400, 'INVALID_INPUT', `The date ${body.on} is before today`, [{ path: 'on', message: 'before today' }]);
  const commitmentId = `cmt-${randomBytes(5).toString('hex')}`;
  const cmt: Commitment = {
    commitmentId, supplierId: null, name: body.name, reference: null, amount: body.amount, schedule: body.recurrence === 'MONTHLY' ? { kind: 'MONTHLY', anchorOn: body.on, endOn: null } : { kind: 'ONCE', on: body.on },
    rail: 'NOT_HEADROOM', estimate: body.estimate, protected: body.protected, provenance: 'OWNER_ENTERED', createdOn: t, createdAt: c.now,
  };
  const end = addDays(t, 41);
  const effect = body.on > end
    ? `Saved. ${body.on} is after the forecast window (ends ${end}), so it is not yet assessed; it enters the forecast when the window reaches it`
    : `Adds ${money(body.amount.minor)} out on ${body.on}${body.recurrence === 'MONTHLY' ? ', then monthly' : ''} to the forecast`;
  const row = { commitmentId, name: cmt.name, supplierName: null, reference: null, amount: cmt.amount, nextOn: body.on, recurrence: cmt.schedule.kind, substantiation: 'OWNER-ENTERED', provenance: cmt.provenance, protected: cmt.protected, estimate: cmt.estimate, afterHorizon: body.on > end };
  return {
    status: 201, body: { commitment: row, effect },
    ops: [
      fenceCheck(c),
      basisBumpOp(K.run(c.tenantId, c.run.runId)), // S4 §6.17 R1: plan inputs changed
      { op: 'put', table: 'core', cond: { notExists: true }, item: { pk: K.run(c.tenantId, c.run.runId), sk: `CMT#${commitmentId}`, ...cmt } },
      auditOp({ tenantId: c.tenantId, runId: c.run.runId, type: 'CommitmentAdded', by: 'OWNER', allowedBy: c.ownerEmail, result: `${body.name}: ${effect}`, refs: { commitmentId }, correlationId: c.correlationId, now: c.now }),
    ],
  };
}

export type { RunObligations };
