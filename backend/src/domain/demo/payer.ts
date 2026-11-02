// The payer as an executor capability (S07 §6.18 R3). The server derives everything: the action must be an approved collection of the
// current run that Headroom has already sent (reminder, undisputed slice, approved disputed ask, sent offer); the amount is that
// action's remaining collectible on PayPal. One live attempt per action (`PAYER#<actionId>#a<n>`, single flight). Phases:
//   QUEUED → CLAIMED (run fence, lease, action version) → SUBMITTING (persisted BEFORE the browser runs) → SUBMITTED_UNVERIFIED
//   → VERIFIED_PAID (a capture for this invoice and amount, seen by PayPal's GETs) | VERIFIED_NOT_PAID (15 min, nothing new) |
//   UNKNOWN_UNRESOLVED. A failure before SUBMITTING is NOT_SUBMITTED (safe to retry). No browser ever runs again while unverified.
// AUTOMATED-PAYER labels stay in data; the UI shows the receipt exactly as PayPal reported it.
import { TxCancelled, type Item, type Op } from '../../adapters/store/port.ts';
import { K } from '../../adapters/store/keys.ts';
import type { Deps } from '../../deps.ts';
import { finishOp, newJob, putJobOp, requestRun, type JobItem, type Lease as JobLease } from '../../jobs/lease.ts';
import { ApiError } from '../../api-error.ts';
import { auditOp } from '../audit/audit.ts';
import { addMs, MIN } from '../time.ts';
import { leaseClaimOps, leaseOf } from './lease.ts';

export type PayerPhase = 'QUEUED' | 'CLAIMED' | 'SUBMITTING' | 'SUBMITTED_UNVERIFIED' | 'VERIFIED_PAID' | 'VERIFIED_NOT_PAID' | 'NOT_SUBMITTED' | 'UNKNOWN_UNRESOLVED' | 'REFUSED';
export const LIVE_PHASES: PayerPhase[] = ['QUEUED', 'CLAIMED', 'SUBMITTING', 'SUBMITTED_UNVERIFIED', 'UNKNOWN_UNRESOLVED'];
export interface PayerAttempt {
  pk: string; sk: string; attemptId: string; actionId: string; invoiceId: string; customer: string; n: number; tenantId: string; runId: string; epoch: number;
  amountMinor: number; partial: boolean; payerUrl: string; phase: PayerPhase; text: string; captureId: string | null; submittedAt: string | null;
  actionVersion: number; label: 'AUTOMATED-PAYER'; version: number; at: string; screenshotKeys: string[]; paypalTxBefore?: number;
}
const paypalTxs = (body: unknown) => ((body as { payments?: { transactions?: { type?: string }[] } }).payments?.transactions ?? []);
export const payerJobId = (attemptId: string) => `payer#${attemptId}`;
const VERIFY_STEPS_MS = [1_000, 5_000, 15_000, 30_000, 60_000];
const VERIFY_WINDOW_MS = 15 * MIN;
const dollars = (m: number) => `$${(m / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** What the payer may pay for this action now, from the server's records; or why not. */
export async function collectible(d: Pick<Deps, 'store'>, tenantId: string, runId: string, actionId: string): Promise<{ ok: true; invoice: Item; amountMinor: number; partial: boolean; action: Item } | { ok: false; why: string }> {
  const pk = K.run(tenantId, runId);
  const a = await d.store.get('core', pk, `ACT#${actionId}`);
  if (!a) return { ok: false, why: 'No such action in this run' };
  if (!['COLLECT_OVERDUE', 'COLLECT_UNDISPUTED_SLICE', 'COLLECT_DISPUTED', 'DISCOUNT_FALLBACK'].includes(a.kind)) return { ok: false, why: 'Only a collection can be paid' };
  const plan = await d.store.get('core', pk, 'PLAN');
  if (plan?.running !== a.revisionId) return { ok: false, why: 'Not in the running plan' };
  if (a.state !== 'APPLIED') return { ok: false, why: a.state === 'COMPLETED' ? 'Already paid' : 'Headroom hasn’t asked the customer yet (the request isn’t sent)' };
  const inv = await d.store.get('core', pk, `INV#${a.subject.invoiceId}`);
  if (!inv?.payerUrl || !['ISSUED', 'PARTIALLY_PAID'].includes(inv.state)) return { ok: false, why: 'The invoice isn’t payable on PayPal' };
  const pending = await d.store.get('core', pk, `DISPUTEPENDING#${inv.invoiceId}`);
  if (pending?.state === 'PENDING') return { ok: false, why: 'A dispute is waiting for you on this invoice' };
  const open = inv.openGross.minor as number;
  const due = (inv.providerDueMinor as number | undefined) ?? open;
  let amount = open;
  if (a.kind === 'COLLECT_UNDISPUTED_SLICE') {
    const claim = await d.store.get('core', pk, `CLAIM#${inv.invoiceId}`);
    const und = (await d.store.query('core', pk, { skPrefix: 'ALLOC#' })).filter((x) => x.invoiceId === inv.invoiceId && x.claim === 'UNDISPUTED').reduce((t, x) => t + x.amount.minor, 0);
    amount = claim ? Math.min(open, claim.undisputed.minor - und) : open;
  }
  if (a.kind === 'COLLECT_DISPUTED') {
    const allow = await d.store.get('core', pk, `DISPALLOW#${inv.invoiceId}`);
    amount = Math.min(open, allow ? allow.allowedMinor - allow.usedMinor : 0);
  }
  if (a.kind === 'DISCOUNT_FALLBACK') amount = due;
  if (a.kind === 'COLLECT_OVERDUE' || a.kind === 'DISCOUNT_FALLBACK') {
    const claim = await d.store.get('core', pk, `CLAIM#${inv.invoiceId}`);
    if (claim) return { ok: false, why: 'Part of this invoice is disputed: only the undisputed or approved disputed actions can be paid' };
  }
  if (amount <= 0) return { ok: false, why: 'Nothing left to collect on this action' };
  return { ok: true, invoice: inv, amountMinor: amount, partial: amount < due, action: a };
}

/** runCollection: create the single live attempt (or return the live one). */
export async function requestCollection(d: Deps, a: { tenantId: string; runId: string; epoch: number; actionId: string }): Promise<PayerAttempt> {
  const pk = K.run(a.tenantId, a.runId);
  const prior = (await d.store.query('core', pk, { skPrefix: `PAYER#${a.actionId}#` })) as unknown as PayerAttempt[];
  const live = prior.find((p) => LIVE_PHASES.includes(p.phase));
  if (live) return live;
  const c = await collectible(d, a.tenantId, a.runId, a.actionId);
  if (!c.ok) throw new ApiError(409, 'NOTHING_TO_COLLECT', c.why);
  const l = await leaseOf(d.store, d.config.connectionId);
  if (l?.leased && (l.tenantId !== a.tenantId || l.runId !== a.runId)) throw new ApiError(409, 'MERCHANT_LEASED', 'This run doesn’t hold the sandbox merchant');
  const n = prior.length + 1;
  const now = d.now();
  const attempt: PayerAttempt = {
    pk, sk: `PAYER#${a.actionId}#a${n}`, attemptId: `${a.runId}:${a.actionId}:a${n}`, actionId: a.actionId, invoiceId: c.invoice.invoiceId, customer: c.action.counterparty.name, n,
    tenantId: a.tenantId, runId: a.runId, epoch: a.epoch, amountMinor: c.amountMinor, partial: c.partial, payerUrl: c.invoice.payerUrl, phase: 'QUEUED',
    text: `Paying ${c.action.counterparty.name} ${dollars(c.amountMinor)} on PayPal…`, captureId: null, submittedAt: null, actionVersion: c.action.version, label: 'AUTOMATED-PAYER', version: 1, at: now, screenshotKeys: [],
  };
  const jobId = payerJobId(attempt.attemptId);
  try { await d.store.transact([
    { op: 'put', table: 'core', item: attempt as unknown as Item, cond: { notExists: true } },
    putJobOp(newJob(jobId, 'PAYER', attempt.sk, now, a.tenantId, a.runId)),
    auditOp({ tenantId: a.tenantId, runId: a.runId, type: 'ActionQueued', by: 'OPERATOR', allowedBy: 'Sandbox: customer pays (AUTOMATED-PAYER)', result: `${c.action.counterparty.name} will pay ${dollars(c.amountMinor)} on PayPal's hosted page (sandbox buyer); the receipt counts only once PayPal's GETs show it`, refs: { actionId: a.actionId, invoiceId: c.invoice.invoiceId }, correlationId: `payer:${attempt.attemptId}`, now }),
  ]); } catch (e) {
    // S7-R27: a second click raced this one; the attempt it created is the one live attempt.
    if (!(e instanceof TxCancelled)) throw e;
    const won = (await d.store.get('core', pk, attempt.sk)) as PayerAttempt | undefined;
    if (won) return won;
    throw e;
  }
  await d.queue.send(jobId).catch(() => {});
  return attempt;
}

export interface PayRequest { jobId: string; attemptId: string; tenantId: string; runId: string; url: string; amountMinor: number; partial: boolean }
export interface PayerResultRecord { phaseReached: 'NOT_SUBMITTED' | 'SUBMITTED'; error: string | null; keys: string[] }
/** Backstop: above the payer Lambda's max event age (60 s) + timeout (120 s), so a live browser always finishes or dies before it. */
const BACKSTOP_MS = 4 * MIN;

/**
 * The browser step (inline locally; the payer Lambda in dev/review). It touches only the attempt's job item: one conditional claim
 * (`browserAt`, S7-R28: a retried or duplicate invocation never runs the browser again), then the result, then it wakes the job;
 * the worker applies the result to the attempt. It never decides paid: PayPal's GETs do.
 */
export async function payOnce(d: Pick<Deps, 'store' | 'queue' | 'now' | 'payer' | 'evidence'>, r: PayRequest): Promise<void> {
  const pk = K.job(r.jobId);
  if (!d.payer) return;
  try { await d.store.transact([{ op: 'update', table: 'work', pk, sk: 'JOB', set: { browserAt: d.now() }, cond: { missing: ['browserAt'] } }]); }
  catch (e) { if (e instanceof TxCancelled) return; throw e; }
  const res = await d.payer.pay({ url: r.url, amountMinor: r.amountMinor, partial: r.partial }).catch((e) => ({ phaseReached: 'SUBMITTED' as const, error: String(e), screenshots: [] }));
  const keys: string[] = [];
  for (const s of res.screenshots) { const key = `T#${r.tenantId}/R#${r.runId}/payer/${r.attemptId}/${s.name}.png`; await d.evidence?.put(key, s.png).catch(() => {}); keys.push(key); }
  if (res.error) console.error(JSON.stringify({ level: 'warn', msg: 'payer', attemptId: r.attemptId, phaseReached: res.phaseReached, error: res.error }));
  const result: PayerResultRecord = { phaseReached: res.phaseReached, error: res.error, keys };
  await d.store.transact([{ op: 'update', table: 'work', pk, sk: 'JOB', set: { payerResult: result }, cond: { missing: ['payerResult'] } }]).catch(() => {});
  const job = await d.store.get('work', pk, 'JOB');
  if (job) { await requestRun(d.store, job as JobItem, d.now()); await d.queue.send(r.jobId).catch(() => {}); }
}

/** PAYER job (worker; the browser step is payOnce). */
export async function runPayer(d: Deps, l: JobLease): Promise<void> {
  const pk = K.run(l.job.tenantId!, l.job.runId!);
  const p = (await d.store.get('core', pk, l.job.ref)) as (PayerAttempt & Item) | undefined;
  if (!p || ['VERIFIED_PAID', 'VERIFIED_NOT_PAID', 'NOT_SUBMITTED', 'REFUSED'].includes(p.phase)) return void (await d.store.transact([finishOp(l, { kind: 'done' })]).catch(() => {}));
  const now = d.now();
  const move = (phase: PayerPhase, set: Partial<PayerAttempt>, f: Parameters<typeof finishOp>[1], ops: Op[] = []) =>
    d.store.transact([{ op: 'update', table: 'core', pk, sk: p.sk, set: { ...set, phase, at: now, version: p.version + 1 }, cond: { eq: { version: p.version, phase: p.phase } } }, ...ops, finishOp(l, f)]);

  if (p.phase === 'QUEUED') {
    const c = await collectible(d, p.tenantId, p.runId, p.actionId);
    if (!c.ok || c.amountMinor !== p.amountMinor) return move('REFUSED', { text: `Not paid: ${c.ok ? 'the amount changed' : c.why}` }, { kind: 'done' });
    // Claim: the run is still the active one, holds the merchant, and the action hasn't moved.
    try {
      await move('CLAIMED', {}, { kind: 'requeue', at: now }, [
        { op: 'check', table: 'core', pk: K.tenant(p.tenantId), sk: 'RUN_FENCE', cond: { eq: { epoch: p.epoch } } },
        { op: 'check', table: 'core', pk, sk: `ACT#${p.actionId}`, cond: { eq: { version: p.actionVersion } } },
        ...(await leaseClaimOps(d.store, d.config.connectionId, p.tenantId, p.runId, now)),
      ]);
    } catch { await d.store.transact([{ op: 'update', table: 'core', pk, sk: p.sk, set: { phase: 'REFUSED', text: 'Not paid: the run or the action changed before the payment started' }, cond: { eq: { phase: 'QUEUED' } } }, finishOp(l, { kind: 'done' })]).catch(() => {}); }
    return;
  }

  if (p.phase === 'CLAIMED') {
    if (!d.payer && !d.payerAsync) return void (await move('NOT_SUBMITTED', { text: 'Not paid: no payer is configured here' }, { kind: 'done' }));
    // Baseline for "not paid": PayPal's own count of transactions on the invoice just before the browser runs.
    const inv = await d.store.get('core', pk, `INV#${p.invoiceId}`);
    const g0 = inv?.ppInvoiceId ? await d.reader.getInvoice(inv.ppInvoiceId).catch(() => null) : null;
    if (g0?.status !== 200) return void (await move('NOT_SUBMITTED', { text: 'Not paid: couldn’t read the invoice from PayPal first; try again' }, { kind: 'done' }));
    const paypalTxBefore = paypalTxs(g0.body).filter((t) => t.type === 'PAYPAL').length;
    // Persisted before the browser runs: from here on this attempt counts as possibly submitted.
    await move('SUBMITTING', { submittedAt: now, paypalTxBefore, text: `Paying ${p.customer} on PayPal…` }, { kind: 'requeue', at: addMs(now, BACKSTOP_MS) });
    const req: PayRequest = { jobId: l.jobId, attemptId: p.attemptId, tenantId: p.tenantId, runId: p.runId, url: p.payerUrl, amountMinor: p.amountMinor, partial: p.partial };
    return d.payerAsync ? d.payerAsync(req) : payOnce(d, req);
  }

  if (p.phase === 'SUBMITTING') {
    const r = (l.job as JobItem & { payerResult?: PayerResultRecord }).payerResult;
    if (r?.phaseReached === 'NOT_SUBMITTED') return void (await move('NOT_SUBMITTED', { text: `Not paid: ${r.error ?? 'stopped before paying'}`, screenshotKeys: r.keys }, { kind: 'done' }));
    if (r) return void (await move('SUBMITTED_UNVERIFIED', { text: 'Checking with PayPal…', screenshotKeys: r.keys }, { kind: 'requeue', at: addMs(now, VERIFY_STEPS_MS[0]), resetAttempts: true }));
    if (Date.parse(now) - Date.parse(p.submittedAt ?? p.at) < BACKSTOP_MS) return void (await d.store.transact([finishOp(l, { kind: 'requeue', at: addMs(p.submittedAt ?? p.at, BACKSTOP_MS) })]).catch(() => {}));
    // Backstop. If the browser never started, fence it off for good: then nothing was submitted (safe). Otherwise it died mid-run:
    // possibly paid, so verify only — the browser never runs again (S7-R28).
    const fenced = await d.store.transact([{ op: 'update', table: 'work', pk: K.job(l.jobId), sk: 'JOB', set: { browserAt: 'FENCED' }, cond: { missing: ['browserAt'] } }]).then(() => true, () => false);
    if (fenced) return void (await move('NOT_SUBMITTED', { text: 'Not paid: the payer didn’t start' }, { kind: 'done' }));
    return void (await move('SUBMITTED_UNVERIFIED', { text: 'Checking with PayPal…' }, { kind: 'requeue', at: now }));
  }

  // SUBMITTED_UNVERIFIED / UNKNOWN_UNRESOLVED: only PayPal's invoice + capture GETs decide.
  const { reconcileInvoice } = await import('../paypal-mirror/reconcile-invoice.ts');
  await reconcileInvoice(d, { tenantId: p.tenantId, runId: p.runId, invoiceId: p.invoiceId }, 'REFRESH').catch(() => undefined);
  const since = Date.parse(p.submittedAt ?? p.at) - 2 * MIN;
  const rc = (await d.store.query('core', pk, { skPrefix: 'RCPT#' })).find((x) => x.invoiceId === p.invoiceId && x.gross?.minor === p.amountMinor && Date.parse(x.capturedAt) >= since);
  if (rc) return void (await move('VERIFIED_PAID', { captureId: rc.captureId, text: `Paid · PayPal capture ${rc.captureId} · ${dollars(rc.gross.minor)} (fee ${dollars(rc.fee.minor)})` }, { kind: 'done' }));
  const age = Date.parse(now) - Date.parse(p.submittedAt ?? p.at);
  if (age < VERIFY_WINDOW_MS) {
    const i = Math.min(l.job.attempts, VERIFY_STEPS_MS.length - 1);
    return void (await d.store.transact([finishOp(l, { kind: 'requeue', at: addMs(now, age < 60_000 ? VERIFY_STEPS_MS[i] : MIN), resetAttempts: age >= 60_000 })]).catch(() => {}));
  }
  // "Not paid" needs fresh proof (S7b review P2-1): a successful invoice GET now with no PayPal transaction since the submit (a pending
  // capture is still a transaction). A failed read, or any new transaction, stays UNKNOWN_UNRESOLVED — never a second payment.
  const inv = await d.store.get('core', pk, `INV#${p.invoiceId}`);
  const g = inv?.ppInvoiceId ? await d.reader.getInvoice(inv.ppInvoiceId).catch(() => null) : null;
  const txs = g?.status === 200 ? paypalTxs(g.body) : null;
  const unchanged = !!txs && typeof p.paypalTxBefore === 'number' && txs.filter((t) => t.type === 'PAYPAL').length === p.paypalTxBefore;
  return void (await move(unchanged ? 'VERIFIED_NOT_PAID' : 'UNKNOWN_UNRESOLVED', { text: unchanged ? 'Not paid: PayPal shows nothing new after 15 minutes' : 'PayPal shows a change that isn’t this payment; check PayPal' }, unchanged ? { kind: 'done' } : { kind: 'requeue', at: addMs(now, 10 * MIN), resetAttempts: true }));
}
