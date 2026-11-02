// Worker: claims a job by id and runs it. The only place the effect executors run (with the PayPal writer and the Plaid connector).
import { executePayout, runPayoutWatch } from '../domain/payables/payout.ts';
import { isPayoutEffectKey } from '../domain/payables/payout-core.ts';
import { isBankEffectKey, K } from '../adapters/store/keys.ts';
import { TxCancelled, type Op } from '../adapters/store/port.ts';
import { CallRefused } from '../adapters/paypal/types.ts';
import { SimulatedCrash, type Deps } from '../deps.ts';
import { executeInvoiceIssue, LeaseLost, reconcileInvoiceIssue } from '../domain/executor/invoice-issue.ts';
import { executeBankEffect, reconcileBankEffect } from '../domain/executor/bank-effects.ts';
import { runReadyDeadline, syncBank } from '../domain/bank-mirror/observe-bank.ts';
import { reconcileInvoice } from '../domain/paypal-mirror/reconcile-invoice.ts';
import { observeBalance } from '../domain/paypal-mirror/observe-balance.ts';
import { verifyWebhook } from '../domain/paypal-mirror/webhook.ts';
import { readBill } from '../domain/evidence/ingest.ts';
import { planBuild } from '../domain/plan/build.ts';
import { runActionDue, runProgress } from '../domain/plan/due.ts';
import { executeUpdate, isUpdateEffectKey } from '../domain/executor/invoice-update.ts';
import { executeMail, isMailEffectKey } from '../domain/comms/send.ts';
import { runMailSync, runReplyInterpret } from '../domain/comms/inbound.ts';
import { nextPollAt } from '../domain/paypal-mirror/schedule.ts';
import { addMs, HOUR } from '../domain/time.ts';
import { auditOp } from '../domain/audit/audit.ts';
import { backoff, claim, finishOp, MAX_ATTEMPTS, requeueRecurring, type Lease } from './lease.ts';

export const OBSERVE_EVERY_MS = 30 * 60_000;

/** Per-job time budget (S2-PR-06): until min(start + 40 s, Lambda remaining − 10 s). */
export const JOB_BUDGET_MS = 40_000;
/** A batch item that can't get this much Lambda time is returned to SQS unclaimed. */
export const MIN_REMAINING_MS = 15_000;

/**
 * One SQS batch, sequentially. A record that can't get MIN_REMAINING_MS of Lambda time is returned unclaimed for SQS to
 * redeliver; every claimed job runs inside min(40 s, remaining − 10 s), so a batch never runs past the Lambda (S2-PR-06).
 */
export async function processBatch(d: Deps, records: { messageId: string; body: string }[], remainingMs: () => number) {
  const failures: { itemIdentifier: string }[] = [];
  for (const r of records) {
    const remaining = remainingMs();
    if (remaining < MIN_REMAINING_MS) { failures.push({ itemIdentifier: r.messageId }); continue; }
    try { await processJob(d, r.body, remaining); }
    catch (err) { console.error(JSON.stringify({ level: 'error', jobId: r.body, error: (err as Error).message })); failures.push({ itemIdentifier: r.messageId }); }
  }
  return { batchItemFailures: failures };
}

export async function processJob(d: Deps, jobId: string, remainingMs = Number.POSITIVE_INFINITY): Promise<void> {
  const elapsed = d.elapsed ?? (() => performance.now());
  const start = elapsed();
  const budget = { deadline: Math.min(start + JOB_BUDGET_MS, start + remainingMs - 10_000), elapsed };
  const l = await claim(d.store, jobId, d.now());
  if (!l) {
    const j = await d.store.get('work', K.job(jobId), 'JOB');
    console.log(JSON.stringify({ level: 'info', msg: 'job not claimable', jobId, state: j?.state ?? 'MISSING', dueAt: j?.dueAt, leaseToken: j?.leaseToken }));
    return;
  }
  await d.hooks?.afterJobClaim?.(jobId);
  // No job goes DEAD (S1-IR-03/04): polls, balance reads, reconciles and webhook checks keep retrying with backoff
  // capped at 15 min, inside the grant/budget. Repeated failure is surfaced (FAILING state, metric), never silent.
  if (l.job.attempts > MAX_ATTEMPTS) console.log(JSON.stringify({ metric: 'JobFailing', jobId, type: l.job.type, attempts: l.job.attempts, lastError: l.job.lastError }));
  try {
    switch (l.job.type) {
      case 'EXECUTE_EFFECT':
      case 'RECONCILE_EFFECT':
        if (isUpdateEffectKey(l.job.ref)) return await executeUpdate(d, l); // S5-D4: one entry; the effect state decides
        if (isPayoutEffectKey(l.job.ref)) return await executePayout(d, l); // S6: same rule
        if (isMailEffectKey(l.job.ref)) return await executeMail(d, l); // S5-D19
        if (l.job.type === 'EXECUTE_EFFECT') return await (isBankEffectKey(l.job.ref) ? executeBankEffect(d, l, budget) : executeInvoiceIssue(d, l));
        return await (isBankEffectKey(l.job.ref) ? reconcileBankEffect(d, l, budget) : reconcileInvoiceIssue(d, l));
      case 'PLAID_SYNC': return await syncBank(d, l, budget);
      case 'RUN_READY_DEADLINE': return await runReadyDeadline(d, l);
      case 'POLL_INVOICE': return await pollInvoice(d, l);
      case 'OBSERVE_BALANCE': return await observe(d, l);
      case 'VERIFY_WEBHOOK': return await verifyWebhook(d, l);
      case 'INGEST_DOCUMENT': return await readBill(d, l, budget);
      case 'PLAN_BUILD': return await planBuild(d, l, budget);
      case 'ACTION_DUE': return await runActionDue(d, l, budget);
      case 'PLAN_PROGRESS': return await runProgress(d, l);
      case 'MAIL_SYNC': return await runMailSync(d, l);
      case 'REPLY_INTERPRET': return await runReplyInterpret(d, l, budget);
      case 'PAYOUT_WATCH': return await runPayoutWatch(d, l);
      case 'PAYER': return await (await import('../domain/demo/payer.ts')).runPayer(d, l);
      case 'FIXTUREMAIL': return String(l.job.ref).startsWith('GOLDEN#') ? await (await import('../domain/demo/golden-mail.ts')).runGoldenMail(d, l) : await (await import('../domain/demo/fixture-mail.ts')).runFixtureMail(d, l);
      case 'RESET_STEP': return await (await import('../domain/demo/reset.ts')).runResetStep(d, l);
    }
  } catch (e) {
    if (e instanceof LeaseLost) return; // the sweep finds the expired lease
    if (e instanceof SimulatedCrash) throw e;
    const refused = e instanceof CallRefused;
    const at = refused ? addMs(d.now(), HOUR) : backoff(d.now(), l.job.attempts);
    const error = (e as Error).message;
    const audit = l.job.type === 'POLL_INVOICE' ? checkingChanged(d, l, checkingShown(error, refused ? 0 : l.job.attempts), error) : [];
    await requeueRecurring(d.store, l, { kind: 'requeue', at, error, ...(refused ? { resetAttempts: true } : {}) }, audit).catch((x) => {
      if (!(x instanceof TxCancelled)) throw x;
    });
    if (!refused) console.error(JSON.stringify({ level: 'error', jobId, type: l.job.type, error: (e as Error).message }));
  }
}

/** Why PayPal checks can't run right now, or null. Shown on the invoice as "Not being checked". */
export async function checksStopped(d: Pick<Deps, 'store' | 'config' | 'now'>): Promise<string | null> {
  const g = d.config.grant;
  if (!g) return 'Not being checked: no PayPal read grant';
  if (d.now() > g.expiresAt) return 'Not being checked: PayPal read grant ended';
  const c = await d.store.get('work', K.counter(g.id), 'COUNTER');
  if ((c?.reads ?? 0) >= g.budgets.reads) return 'Not being checked: PayPal read budget reached';
  return null;
}

/** What the invoice's Checking section shows for a poll job's stored lastError/attempts (mirrors read/models invoiceRow). */
const checkingShown = (lastError: string | null | undefined, attempts: number) =>
  !lastError ? 'ACTIVE' : lastError.startsWith('Not being checked') ? 'STOPPED' : attempts >= 3 ? 'FAILING' : 'ACTIVE';

/** An audit row when a poll changes what Checking shows: the session's lastChangeAt then moves and open screens refetch (S1-IM-04). */
function checkingChanged(d: Deps, l: Lease, next: string, detail: string | null): Op[] {
  const before = checkingShown(l.job.lastError, l.job.attempts - 1);
  if (before === next || !l.job.tenantId || !l.job.runId) return [];
  const result = next === 'ACTIVE' ? 'PayPal checks working again' : next === 'FAILING' ? `Couldn't reach PayPal on ${l.job.attempts} checks in a row (${detail}); still retrying` : detail!;
  return [auditOp({ tenantId: l.job.tenantId, runId: l.job.runId, type: 'InvoiceCheckingChanged', by: 'HEADROOM', result, refs: { invoiceId: l.job.ref }, correlationId: `poll:${l.job.ref}:${d.now()}`, now: d.now() })];
}

async function pollInvoice(d: Deps, l: Lease) {
  const [tenantId, runId] = [l.job.tenantId!, l.job.runId!];
  const inv = await d.store.get('core', K.run(tenantId, runId), `INV#${l.job.ref}`);
  if (!inv || !['ISSUED', 'PARTIALLY_PAID', 'PAID'].includes(inv.state)) return d.store.transact([finishOp(l, { kind: 'done' })]);
  const stopped = await checksStopped(d);
  if (stopped) return requeueRecurring(d.store, l, { kind: 'requeue', at: addMs(d.now(), HOUR), error: stopped, resetAttempts: true }, checkingChanged(d, l, 'STOPPED', stopped));
  const r = await reconcileInvoice(d, { tenantId, runId, invoiceId: l.job.ref }, 'POLL', l);
  await requeueRecurring(d.store, l, { kind: 'requeue', at: nextPollAt(inv.issuedAt ?? inv.createdAt, d.now(), r.paid), error: null, resetAttempts: true }, checkingChanged(d, l, 'ACTIVE', null));
}

async function observe(d: Deps, l: Lease) {
  const stopped = await checksStopped(d);
  if (stopped) return requeueRecurring(d.store, l, { kind: 'requeue', at: addMs(d.now(), HOUR), error: stopped, resetAttempts: true });
  const r = await observeBalance(d);
  await requeueRecurring(d.store, l, { kind: 'requeue', at: addMs(d.now(), OBSERVE_EVERY_MS), error: r.error ?? null, resetAttempts: true });
}
