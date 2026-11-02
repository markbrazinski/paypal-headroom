// Bill ingestion (S03 T3–T5). Upload and operator inject share ingestCommand(); the worker job INGEST_DOCUMENT reads the text
// layer, asks the EvidenceInterpreter (metered, S3-D18), grounds every field and matches deterministically. Nothing here
// changes the forecast: a bill only proposes, the owner verifies and accepts (S03 T8/T9).
import { createHash, randomBytes } from 'node:crypto';
import { EvidenceInterpreterOutput, MAX_DOCUMENT_BYTES } from '@headroom/contracts';
import { basisBumpOp, K } from '../../adapters/store/keys.ts';
import { TxCancelled, type Op } from '../../adapters/store/port.ts';
import { evidenceKey, type EvidenceStore } from '../../adapters/evidence-store/port.ts';
import { InterpreterFailure } from '../../adapters/bedrock/converse.ts';
import { BudgetReached, MAX_INPUT_CHARS, costMicros, reserve, reserveOp, settleOp, worstCaseMicros } from '../../adapters/bedrock/spend.ts';
import { ApiError } from '../../api-error.ts';
import { SimulatedCrash, type Deps } from '../../deps.ts';
import { auditOp } from '../audit/audit.ts';
import { backoff, finishOp, leaseCheck, newJob, putJobOp, type Lease } from '../../jobs/lease.ts';
import { fenceCheck, type CommandCtx, type CommandResult } from '../receivables/commands.ts';
import { addMs, businessDate, MIN } from '../time.ts';
import { getRun } from '../identity-run/run.ts';
import { loadRun, type BillItem } from '../obligations/load.ts';
import { billNoSk, matchBill, resolveSupplier } from '../obligations/match.ts';
import { oblSk, parseOccKey } from '../obligations/obligations.ts';
import { changedFieldsOf } from '../obligations/match.ts';
import { termsHash } from '../obligations/commands.ts';
import { ruleOf, ruleText, valueOf } from '../delegation/policy.ts';
import type { Differing } from '../delegation/specs.ts';
import type { Policy } from '@headroom/contracts';
import { addDays } from '../time.ts';
import { ground } from './grounding.ts';
import { MIN_TEXT_CHARS, nonSpace, pdfText, PdfUnreadable } from './pdf-text.ts';

export const newBillId = (runId: string) => `bill_${runId.replace(/^run-/, '')}_${randomBytes(5).toString('hex')}`;
export const runOfBillId = (billId: string) => { const m = /^bill_([a-z0-9]+)_/.exec(billId); return m ? `run-${m[1]}` : null; };
export const ingestJobId = (billId: string, gen: number) => `ingest#${billId}#${gen}`;
const genOfJob = (jobId: string) => Number(jobId.split('#').at(-1));

// S3-D17: ingest's own bounded attempt policy.
export const MIN_ADMISSION_MS = 30_000;
export const FINALIZE_RESERVE_MS = 5_000;
export const MIN_REQUEST_MS = 8_000;
export const MAX_REQUEST_MS = 15_000;
export const MAX_INGEST_ATTEMPTS = 4;

export interface IngestInput { fileName: string; bytes: Uint8Array; source: 'OWNER_UPLOAD' | 'OPERATOR_INJECTED' | 'MAIL' }

/** Original bytes only (C-DEMO: the control endpoint can't set fields, classification or state). One TX; the bytes are stored first, write-once. */
export async function ingestCommand(ev: EvidenceStore | undefined, s: Deps['store'], c: CommandCtx, i: IngestInput): Promise<CommandResult> {
  if (!ev) throw new ApiError(503, 'PROVIDER_UNAVAILABLE', 'Document storage is not configured here');
  if (i.bytes.length > MAX_DOCUMENT_BYTES) throw new ApiError(400, 'INVALID_INPUT', 'The file is larger than 4 MB');
  if (Buffer.from(i.bytes.subarray(0, 5)).toString('latin1') !== '%PDF-') throw new ApiError(400, 'INVALID_INPUT', 'Only PDF bills can be read');
  const sha = createHash('sha256').update(i.bytes).digest('hex');
  const pk = K.run(c.tenantId, c.run.runId);
  const who = i.source === 'OWNER_UPLOAD' ? 'OWNER' : i.source === 'MAIL' ? 'HEADROOM' : 'OPERATOR';
  const allowedBy = i.source === 'OWNER_UPLOAD' ? c.ownerEmail : i.source === 'MAIL' ? 'Bill arrived by email' : 'Operator: inject bill (sandbox)';
  const existing = await s.get('core', pk, `DOC#${sha}`);
  if (existing) {
    return {
      status: 202, body: { status: 'DUPLICATE_DOCUMENT', billId: existing.billId },
      ops: [fenceCheck(c), auditOp({ tenantId: c.tenantId, runId: c.run.runId, type: 'DuplicateDocumentReceived', by: who, allowedBy, result: `Already received (${i.fileName}); no second bill`, refs: { billId: existing.billId, sha256: sha }, correlationId: c.correlationId, now: c.now })],
    };
  }
  const storageKey = evidenceKey(c.tenantId, c.run.runId, sha);
  await ev.put(storageKey, i.bytes);
  const billId = newBillId(c.run.runId);
  const jobId = ingestJobId(billId, 1);
  const bill: BillItem = {
    pk, sk: `BILL#${billId}`, billId, runId: c.run.runId, tenantId: c.tenantId, documentSha256: sha, storageKey, source: i.source, fileName: i.fileName, bytes: i.bytes.length,
    state: 'RECEIVED', version: 1, readGeneration: 1, classification: null, flags: [], holdReasons: [], fields: null, supplierName: null, billNumber: null, reference: null,
    dueOn: null, amount: null, printedMinor: null, printedTotal: null, currencyBasis: null, remittanceLast4: null, supplierId: null, candidates: [], occurrenceKey: null,
    proposedTerms: null, changedFields: [], revisionOf: null, readFailure: null, receivedAt: c.now, updatedAt: c.now,
  };
  return {
    status: 202, body: { status: 'RECEIVED', billId, jobId }, rerunOnConflict: true,
    ops: [
      fenceCheck(c),
      // Per-run document uniqueness: a racing identical upload fails here, and the re-run answers DUPLICATE_DOCUMENT (S3-R1).
      { op: 'put', table: 'core', item: { pk, sk: `DOC#${sha}`, sha256: sha, bytes: i.bytes.length, fileName: i.fileName, contentType: 'application/pdf', source: i.source, storageKey, receivedAt: c.now, billId }, cond: { notExists: true } },
      { op: 'put', table: 'core', item: bill, cond: { notExists: true } },
      putJobOp(newJob(jobId, 'INGEST_DOCUMENT', billId, c.now, c.tenantId, c.run.runId)),
      auditOp({ tenantId: c.tenantId, runId: c.run.runId, type: 'IngestionReceived', by: who, allowedBy, result: `${i.source === 'OWNER_UPLOAD' ? 'Uploaded' : i.source === 'MAIL' ? 'Arrived by email' : 'Injected (sandbox operator)'}: ${i.fileName}; reading it now. Nothing changes until you decide`, refs: { billId, sha256: sha }, correlationId: c.correlationId, now: c.now }),
    ],
  };
}

type Budget = { deadline: number; elapsed: () => number };
const usd = (minor: number) => ({ currency: 'USD' as const, minor });

/** Strip a code fence the model may add, then parse; null on anything that isn't one JSON object. */
function parseJson(s: string): unknown { try { return JSON.parse(s.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')); } catch { return null; } }

/** Worker: INGEST_DOCUMENT (S03 T5) under the S3-D17 attempt policy and S3-D18 metering. */
export async function readBill(d: Deps, l: Lease, budget: Budget): Promise<void> {
  const left = () => budget.deadline - budget.elapsed();
  const now = d.now();
  const [tenantId, runId, billId, gen] = [l.job.tenantId!, l.job.runId!, l.job.ref, genOfJob(l.jobId)];
  // Admission: too little time left in this invocation → back in a minute, no attempt counted, nothing called.
  if (left() < MIN_ADMISSION_MS) {
    await d.store.transact([finishOp(l, { kind: 'requeue', at: addMs(now, MIN), set: { attempts: l.job.attempts - 1 } })]).catch(ignoreCancel);
    return;
  }
  const pk = K.run(tenantId, runId);
  const bill = (await d.store.get('core', pk, `BILL#${billId}`)) as BillItem | undefined;
  if (!bill || bill.readGeneration !== gen || bill.state !== 'RECEIVED') { await d.store.transact([finishOp(l, { kind: 'done' })]).catch(ignoreCancel); return; }
  const corr = `ingest:${billId}:${gen}`;
  const audit = (type: Parameters<typeof auditOp>[0]['type'], result: string, refs: Record<string, string> = {}) => auditOp({ tenantId, runId, type, by: 'HEADROOM', result, refs: { billId, ...refs }, correlationId: corr, now: d.now() });
  /** Final write, fenced on the lease, the generation and the bill version (an old worker can't publish into a retry). */
  const finalize = async (state: BillItem['state'], patch: Partial<BillItem>, audits: Op[]) => {
    try {
      await d.store.transact([
        finishOp(l, { kind: 'done' }),
        { op: 'update', table: 'core', pk, sk: bill.sk, set: { ...patch, state, version: bill.version + 1, updatedAt: d.now() }, cond: { eq: { state: 'RECEIVED', readGeneration: gen, version: bill.version } } },
        ...audits,
      ]);
    } catch (e) { ignoreCancel(e); }
  };
  const readFailed = (reason: string) => finalize('READ_FAILED', { readFailure: reason }, [audit('BillExtractionFailed', `Couldn't read ${bill.fileName}: ${reason}. Retry is available; nothing was guessed`)]);
  /** A counted failure: back off, or READ_FAILED on the last attempt (one TX with the audit; the job is DONE, never requeued). */
  const failAttempt = async (reason: string) => {
    if (l.job.attempts >= MAX_INGEST_ATTEMPTS) return readFailed(`${reason} (after ${l.job.attempts} attempts)`);
    await d.store.transact([finishOp(l, { kind: 'requeue', at: backoff(d.now(), l.job.attempts), error: reason })]).catch(ignoreCancel);
  };
  const held = (classification: string, reasons: string[], audits: Op[], patch: Partial<BillItem> = {}) =>
    finalize('HELD', { classification, holdReasons: reasons, ...patch }, [...audits, audit('BillHeld', `Held: ${reasons.join('; ')}`)]);

  // S3-IM-04: a generation whose attempts are used up (e.g. the worker died mid-request each time) ends here, before any read or model call.
  if (l.job.attempts > MAX_INGEST_ATTEMPTS) return readFailed(`Stopped after ${MAX_INGEST_ATTEMPTS} attempts (the read kept stopping part-way)`);
  // Every other failure inside an attempt (storage, store, parser…) goes through the same bounded policy, never the generic requeue.
  try { await attemptRead(bill); }
  catch (e) {
    if (e instanceof SimulatedCrash) throw e;
    await failAttempt(`Couldn't read the document: ${(e as Error).message}`);
  }

  async function attemptRead(bill: BillItem): Promise<void> {
      if (!d.evidence) return failAttempt('Document storage is not configured here');
    const bytes = await d.evidence.get(bill.storageKey);
    if (!bytes) return failAttempt('The original document is not in storage yet');
    if (createHash('sha256').update(bytes).digest('hex') !== bill.documentSha256)
      return held('UNREADABLE_NEEDS_OCR_OR_VISION', ['The stored document changed after upload; it is not read'], [], { flags: ['DOCUMENT_CHANGED'] });
    let text: string;
    try { text = await pdfText(bytes, Math.min(5_000, left() - FINALIZE_RESERVE_MS)); }
    catch (e) {
      if (e instanceof PdfUnreadable && !/took longer/.test(e.message)) return readFailed(e.message); // malformed: deterministic, not retried
      return failAttempt((e as Error).message);
    }
    if (nonSpace(text) < MIN_TEXT_CHARS) return held('UNREADABLE_NEEDS_OCR_OR_VISION', ['No text layer (a scan or image). Reading scans needs OCR or vision, which this build does not have'], [audit('DocumentUnreadable', `${bill.fileName}: no text layer; nothing was guessed and no model was asked`)]);
    if (text.length > MAX_INPUT_CHARS) return held('TOO_LONG_TO_READ', [`The document text is longer than ${MAX_INPUT_CHARS.toLocaleString('en-US')} characters`], []);
    if (!d.interpreter) return readFailed('Model not configured here');

    const env = d.bedrockEnv ?? 'local';
    const inputSha = createHash('sha256').update(text).digest('hex');
    let k = (await d.store.query('core', pk, { skPrefix: `MODEL#${billId}#${gen}#` })).length;
    let reask: string | undefined;
    let out: EvidenceInterpreterOutput | null = null;
    for (let ask = 0; ask < 2 && !out; ask++) {
      const timeoutMs = Math.min(MAX_REQUEST_MS, left() - FINALIZE_RESERVE_MS);
      if (timeoutMs < MIN_REQUEST_MS) return failAttempt('Not enough time left in this run for a model request');
      const cost = worstCaseMicros(text.length);
      const sk = `MODEL#${billId}#${gen}#${String(k).padStart(3, '0')}`;
      try {
        await reserve(d.store, [
          reserveOp(env, cost, d.bedrockCapMicros),
          { op: 'put', table: 'core', cond: { notExists: true }, item: { pk, sk, task: 'EvidenceInterpreter', modelId: d.interpreter.modelId, billId, generation: gen, k, inputSha256: inputSha, inputChars: text.length, reservedMicros: cost, state: 'DISPATCHING', outputText: null, outputSha256: null, inputTokens: null, outputTokens: null, actualMicros: null, latencyMs: null, error: null, dispatchedAt: d.now(), settledAt: null } },
          leaseCheck(l),
        ]);
      } catch (e) {
        if (e instanceof BudgetReached) {
          return finalize('READ_FAILED', { readFailure: 'Model budget reached' }, [audit('ModelCallBudgetReached', `Bedrock ${env} budget reached; ${bill.fileName} was not sent`), audit('BillExtractionFailed', `Couldn't read ${bill.fileName}: model budget reached`)]);
        }
        return ignoreCancel(e);
      }
      k++;
      const settle = (state: string, set: Record<string, unknown>, actual: number | null) =>
        d.store.transact([{ op: 'update', table: 'core', pk, sk, set: { state, settledAt: d.now(), actualMicros: actual ?? cost, ...set }, cond: { eq: { state: 'DISPATCHING' } } }, settleOp(env, cost, actual)]);
      let r;
      try { r = await d.interpreter.interpret(text, { timeoutMs, reask }); }
      catch (e) {
        if (e instanceof SimulatedCrash) throw e; // test seam: the process died mid-request (S3-R35)
        // No usable answer: usage unknown, so the reservation stays charged.
        await settle('ERROR', { error: (e as Error).message }, null);
        return failAttempt(e instanceof InterpreterFailure ? `Model ${e.kind.toLowerCase()}: ${e.message}` : (e as Error).message);
      }
      const actual = r.inputTokens !== null && r.outputTokens !== null ? costMicros(r.inputTokens, r.outputTokens) : null;
      const usage = { outputText: r.outputText.slice(0, 8_192), outputSha256: createHash('sha256').update(r.outputText).digest('hex'), inputTokens: r.inputTokens, outputTokens: r.outputTokens, latencyMs: Math.round(r.latencyMs) };
      const parsed = EvidenceInterpreterOutput.safeParse(parseJson(r.outputText));
      if (!parsed.success) {
        reask = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
        await settle('INVALID_OUTPUT', { ...usage, error: reask }, actual);
        continue;
      }
      await settle('OK', usage, actual);
      out = parsed.data;
    }
    if (!out) return failAttempt("The model's answer did not match the required shape, twice");

    const g = ground(out, text);
    const fieldsPatch = { fields: g.fields, supplierName: g.supplierName, billNumber: g.billNumber, reference: g.reference, dueOn: g.dueOn, printedMinor: g.totalMinor, printedTotal: g.printedTotal, remittanceLast4: g.remittanceLast4 };
    const flags = g.untrustedInstructions ? ['UNTRUSTED_INSTRUCTION_TEXT'] : [];
    let extracted = audit('BillFieldsExtracted', `Read ${bill.fileName}: ${g.fields.filter((f) => f.grounded).length} of ${g.fields.length} fields found in the document${flags.length ? '; it contains instructions, which were ignored' : ''}`);
    await d.hooks?.beforeIngestCommit?.(billId);
    if (g.hold) return held(g.hold.classification, g.hold.reasons, [extracted], { ...fieldsPatch, flags });

    const run = await getRun(d.store, tenantId, runId);
    const today = businessDate(d.now(), run!.settings.timeZone);
    // S3-IM-02: one current bill per supplier + bill number. A revision is matched against the slot's holder (never a random earlier
    // bill), and replaces it in the same TX that publishes this bill, so two revisions can't both become outflows. A race on the slot
    // re-reads and matches again (a bounded loop) while this worker still holds the lease.
    for (let tries = 0; ; tries++) {
      const r = await loadRun(d.store, tenantId, runId, today);
      const sup = resolveSupplier(g.supplierName!, r.suppliers);
      const slotSk = sup.kind === 'MATCH' && g.billNumber ? billNoSk(sup.supplier.supplierId, g.billNumber) : null;
      const slot = slotSk ? await d.store.get('core', pk, slotSk) : undefined;
      const holder = slot ? r.bills.find((b) => b.billId === slot.billId && b.billId !== billId) : undefined;
      const earlier = holder ? [{ billId: holder.billId, supplierId: holder.supplierId, billNumber: holder.billNumber, dueOn: holder.dueOn, totalMinor: holder.printedMinor, occurrenceKey: holder.occurrenceKey }] : [];
      const m = matchBill({ supplierName: g.supplierName!, billNumber: g.billNumber, reference: g.reference, dueOn: g.dueOn!, totalMinor: g.totalMinor!, currency: g.currency!, remittanceLast4: g.remittanceLast4 }, r.suppliers, r.commitments, r.occurrences, earlier);
      const iso = g.currency === 'USD';
      const patch: Partial<BillItem> = {
        ...fieldsPatch, flags: [...flags, ...(m.remittanceChange ? ['REMITTANCE_CHANGE'] : [])], classification: m.classification, holdReasons: m.holdReasons,
        amount: iso ? usd(g.totalMinor!) : null, currencyBasis: iso ? 'ISO' : 'BARE_DOLLAR', supplierId: m.supplierId, candidates: m.candidates, occurrenceKey: m.occurrenceKey,
        proposedTerms: m.occurrenceKey && iso ? { dueOn: g.dueOn!, amount: usd(g.totalMinor!) } : null, changedFields: m.changedFields, revisionOf: m.revisionOf, supersededBy: null,
      };
      if (m.held) return held(m.classification, m.holdReasons, [extracted], patch);
      const slotOps: Op[] = !slotSk ? [] : [
        slot ? { op: 'update', table: 'core', pk, sk: slotSk, set: { billId, version: slot.version + 1 }, cond: { eq: { billId: slot.billId, version: slot.version } } }
          : { op: 'put', table: 'core', item: { pk, sk: slotSk, billId, version: 1 }, cond: { notExists: true } },
        // The replaced bill becomes SUPERSEDED (history; no further actions). A TERMS_ACCEPTED one stays as the accepted record.
        ...(holder && m.revisionOf === holder.billId && (holder.state === 'PROPOSED' || holder.state === 'VERIFIED') ? [
          { op: 'update' as const, table: 'core' as const, pk, sk: holder.sk, set: { state: 'SUPERSEDED', supersededBy: billId, version: holder.version + 1, updatedAt: d.now() }, cond: { eq: { version: holder.version, state: holder.state } } },
          audit('BillSuperseded', `${holder.billNumber ?? holder.fileName} was replaced by a revised copy (${bill.fileName}); only the revision can be acted on`, { supersededBillId: holder.billId }),
        ] : []),
      ];
      // S4-D17: a bill that exactly matches a planned cost from a known supplier (ISO USD, no flag, no hold, not a revision) is verified by
      // Headroom when Delegation says so. Same records as the owner's verify; nothing changes in the forecast and nothing is paid.
      const policy = (await d.store.get('core', pk, 'POLICY')) as (Policy & { pk: string }) | undefined;
      const auto = !!policy && valueOf(policy, 'ap.exactMatchBills', 'PAYABLES') === 'AUTO_VERIFY';
      const occ = m.occurrenceKey ? r.occurrences.find((o) => o.occurrenceKey === m.occurrenceKey) : undefined;
      const clean = sup.kind === 'MATCH' && iso && !patch.flags!.length && !m.revisionOf && occ && !occ.substantiatedBy;
      const exact = auto && m.classification === 'EXACT_MATCH' && clean;
      // S7 §6.1a ap.differingBills (safety rule): inside the owner's bounds Headroom accepts a changed amount / earlier date itself.
      // Two records as always (§E 8): VERIFY# then TERMS#, both by HEADROOM with the policy version. A later date, changed payment
      // details (held above as REMITTANCE_CHANGE, a hard stop), a revision or a flag still come to the owner. Payment stays a grant.
      const diff = policy ? valueOf<Differing>(policy, 'ap.differingBills', 'PAYABLES') : null;
      const after = { dueOn: g.dueOn!, amountMinor: g.totalMinor! };
      const within = !!occ && diff?.mode === 'AUTO_ACCEPT' && ['DATE_CHANGE_REQUESTED', 'AMOUNT_DISCREPANCY', 'TERMS_DIFFER'].includes(m.classification)
        && Math.abs(after.amountMinor - occ.amount.minor) <= diff.maxAmountDiffMinor && after.dueOn <= occ.dueOn && after.dueOn >= addDays(occ.dueOn, -diff.maxDaysEarlier) && after.dueOn >= today;
      const accept = !exact && clean && within;
      const verifyOps: Op[] = [];
      if (exact || accept) {
        const { commitmentId, n } = parseOccKey(occ.occurrenceKey)!;
        const stored = r.stored.get(occ.occurrenceKey);
        const allowedBy = exact ? `Delegation v${policy!.version} · Bills exactly matching a planned cost` : `Delegation v${policy!.version} · ${ruleText(ruleOf(policy!, 'ap.differingBills'), diff!)}`;
        // Same records and hash as the owner's acceptBillTerms; the occurrence is written once with both the link and the new terms.
        const changed = accept ? changedFieldsOf(occ, after.dueOn, after.amountMinor) : [];
        const tv = (stored?.termsVersion ?? 0) + 1;
        const hash = accept ? termsHash(occ, changed, after, bill.documentSha256) : null;
        const terms = accept ? { dueOn: after.dueOn, amount: usd(after.amountMinor), termsVersion: tv, termsHash: hash } : {};
        verifyOps.push(
          // S7a-IR-11: decided under this Delegation version; a rule change committing meanwhile refuses the TX (re-read and matched again).
          { op: 'check', table: 'core', pk, sk: 'POLICY', cond: { eq: { version: policy!.version } } },
          { op: 'put', table: 'core', cond: { notExists: true }, item: { pk, sk: `VERIFY#${billId}`, billId, by: 'HEADROOM', allowedBy, at: d.now(), documentSha256: bill.documentSha256, occurrenceKey: occ.occurrenceKey, occurrenceVersion: occ.version, currencyAttested: null, billVersion: bill.version + 1 } },
          stored ? { op: 'update', table: 'core', pk: stored.pk, sk: stored.sk, set: { substantiatedBy: billId, ...terms, version: stored.version + 1 }, cond: { eq: { version: occ.version }, missing: ['substantiatedBy'] } }
            : { op: 'put', table: 'core', cond: { notExists: true }, item: { pk, sk: oblSk(commitmentId, n), occurrenceKey: occ.occurrenceKey, commitmentId, n, scheduledOn: occ.scheduledOn, dueOn: occ.dueOn, amount: occ.amount, state: 'SCHEDULED', termsVersion: 0, termsHash: null, substantiatedBy: billId, version: 1, ...terms } },
          basisBumpOp(pk),
          auditOp({ tenantId, runId, type: 'BillVerified', by: 'HEADROOM', allowedBy, result: exact ? `Verified ${g.billNumber ?? bill.fileName} automatically: it exactly matches a planned cost (${allowedBy}). Nothing changes in the forecast; payment not authorized` : `Verified ${g.billNumber ?? bill.fileName} automatically under your differing-bills rule (${allowedBy}); payment not authorized`, refs: { billId, occurrenceKey: occ.occurrenceKey }, correlationId: corr, now: d.now() }),
        );
        if (accept) {
          const what = changed.map((f) => (f === 'dueOn' ? `date ${occ.dueOn} → ${after.dueOn}` : `amount $${(occ.amount.minor / 100).toFixed(2)} → $${(after.amountMinor / 100).toFixed(2)}`)).join(', ');
          verifyOps.push(
            { op: 'put', table: 'core', cond: { notExists: true }, item: { pk, sk: `TERMS#${occ.occurrenceKey}#${tv}`, kind: 'CHANGED_TERMS', billId, occurrenceKey: occ.occurrenceKey, changedFields: changed, before: { dueOn: occ.dueOn, amount: occ.amount }, after: { dueOn: after.dueOn, amount: usd(after.amountMinor) }, termsHash: hash, by: 'HEADROOM', allowedBy, policyVersion: policy!.version, at: d.now() } },
            auditOp({ tenantId, runId, type: 'BillTermsAccepted', by: 'HEADROOM', allowedBy, result: `Accepted ${g.billNumber ?? 'bill'} by your rule: ${what} (${allowedBy}). Still one payment; payment not authorized`, refs: { billId, occurrenceKey: occ.occurrenceKey, policyVersion: String(policy!.version) }, correlationId: corr, now: d.now() }),
          );
        }
      }
      try {
        await d.store.transact([
          finishOp(l, { kind: 'done' }),
          { op: 'update', table: 'core', pk, sk: bill.sk, set: { ...patch, ...(exact || accept ? { candidates: [occ.occurrenceKey] } : {}), state: exact ? 'VERIFIED' : accept ? 'TERMS_ACCEPTED' : 'PROPOSED', version: bill.version + 1, updatedAt: d.now() }, cond: { eq: { state: 'RECEIVED', readGeneration: gen, version: bill.version } } },
          ...slotOps,
          extracted, audit('BillMatchProposed', proposedText(m.classification, g.billNumber ?? bill.fileName)),
          ...verifyOps,
        ]);
        // O6 (S7): terms accepted by the owner's rule → the plan builds by itself when they leave a shortfall.
        if (accept) {
          const rc = await (await import('../plan/authority.ts')).planCtxFor(d, tenantId, runId);
          if (rc) await (await import('../plan/build.ts')).autoBuild(rc, { tenantId, run: rc.run, now: d.now(), correlationId: corr, ownerEmail: 'headroom' }, d.queue).catch(() => {});
        }
        return;
      } catch (e) {
        ignoreCancel(e);
        const j = await d.store.get('work', K.job(l.jobId), 'JOB');
        const b = await d.store.get('core', pk, bill.sk);
        if (tries >= 3 || j?.state !== 'LEASED' || j.leaseToken !== l.token || b?.state !== 'RECEIVED' || b.readGeneration !== gen) return; // not ours any more
        extracted = audit('BillFieldsExtracted', `Read ${bill.fileName} (matched again after a concurrent change)`);
      }
    }
  }
}

const proposedText = (c: string, ref: string) => ({
  EXACT_MATCH: `${ref} matches a commitment exactly; verify it to link it (nothing changes in the forecast)`,
  DATE_CHANGE_REQUESTED: `${ref} matches a commitment but asks for a different date; the forecast keeps the agreed date until you decide`,
  AMOUNT_DISCREPANCY: `${ref} matches a commitment but the amount differs; the forecast keeps the agreed amount until you decide`,
  TERMS_DIFFER: `${ref} matches a commitment but the date and amount differ; the forecast keeps the agreed terms until you decide`,
  REVISION_CHANGED_TERMS: `${ref} is a revised bill with changed terms; the forecast keeps the agreed terms until you decide`,
  AMBIGUOUS_COMMITMENT: `${ref} could match more than one payment; choose which one`,
  NEW_OBLIGATION_KNOWN_SUPPLIER: `${ref} doesn't match a commitment; it is not in the forecast unless you add it`,
} as Record<string, string>)[c] ?? `${ref} read`;

function ignoreCancel(e: unknown): void { if (!(e instanceof TxCancelled)) throw e; }
