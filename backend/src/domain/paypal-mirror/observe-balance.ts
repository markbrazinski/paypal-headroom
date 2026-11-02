// OBSERVE_BALANCE (S01 T5): reporting balance + every transaction page → per-connection observation.
// Merchant-level records survive resets and are never run-scoped.
import { PpBalances, PpTransactionsPage, type BalanceObservation } from '@headroom/contracts';
import { basisBumpOp, fundsBumpOp, K } from '../../adapters/store/keys.ts';
import { TxCancelled, type Op } from '../../adapters/store/port.ts';
import type { Deps } from '../../deps.ts';
import { auditOp } from '../audit/audit.ts';
import { checkBalance, coverageOf, toReportingRows } from './observe.ts';
import { addMs, DAY } from '../time.ts';

const usd = (minor: number) => `$${(minor / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
import { CallRefused } from '../../adapters/paypal/types.ts';
import { activeRun } from '../identity-run/run.ts';
import type { CaptureMarker } from './reconcile-invoice.ts';
import { retainGet } from './evidence.ts';

export type StatusItem = { lastAttemptAt: string; ok: boolean; lastError: string | null; lastGoodRetrievedAt: string | null };

export async function observeBalance(d: Deps): Promise<{ ok: boolean; error?: string }> {
  const conn = d.config.connectionId;
  const pk = K.conn(conn);
  const binding = await d.store.get('provider', pk, 'TENANT');
  const run = binding ? await activeRun(d.store, binding.tenantId) : undefined;
  const retrievedAt = d.now();
  const prev = (await d.store.get('provider', pk, 'STATUS')) as StatusItem | undefined;
  const auditTo = (type: Parameters<typeof auditOp>[0]['type'], result: string, refs: Record<string, string> = {}): Op[] =>
    run ? [auditOp({ tenantId: run.tenantId, runId: run.runId, type, by: 'HEADROOM', result, refs, correlationId: `obs:${retrievedAt}`, now: retrievedAt })] : [];
  const failed = async (error: string, type: 'PayPalObservationRejected' | 'PayPalCallBudgetReached' = 'PayPalObservationRejected') => {
    await d.store.transact([
      { op: 'put', table: 'provider', item: { pk, sk: 'STATUS', lastAttemptAt: retrievedAt, ok: false, lastError: error, lastGoodRetrievedAt: prev?.lastGoodRetrievedAt ?? null } },
      ...(prev?.lastError === error ? [] : auditTo(type, error)),
    ]);
    return { ok: false, error };
  };

  try {
    const b = await d.reader.getBalances();
    if (b.status !== 200) return failed(`PayPal balance read ${b.status}`);
    const bal = PpBalances.parse(b.body);
    const pinned = await d.store.get('provider', pk, 'ACCOUNT');
    const chk = checkBalance(bal, pinned?.accountId ?? null, retrievedAt);
    if (!chk.ok) return failed(chk.reason);
    if (!pinned) {
      try { await d.store.transact([{ op: 'put', table: 'provider', item: { pk, sk: 'ACCOUNT', accountId: chk.accountId, pinnedAt: retrievedAt }, cond: { notExists: true } }]); }
      catch (e) { if (!(e instanceof TxCancelled)) throw e; return failed('ACCOUNT_MISMATCH'); }
    }
    // Reporting caps a range at 31 days; the window ends now and covers as-of with ~31 days of history.
    const start = addMs(retrievedAt, -31 * DAY + 60_000);
    const pages: PpTransactionsPage[] = [];
    const pageSha256: string[] = []; // every report page behind this observation is retained (S1-IM-07)
    for (let page = 1; ; page++) {
      const r = await d.reader.getTransactions(start, retrievedAt, page);
      if (r.status !== 200) break; // coverage becomes PARTIAL
      const p = PpTransactionsPage.parse(r.body);
      pages.push(p);
      pageSha256.push(await retainGet(d.store, pk, `transactions page ${page}`, r, retrievedAt));
      if (page >= p.total_pages) break;
    }
    const rows = toReportingRows(pages);
    const obs: BalanceObservation = {
      connectionId: conn, accountId: chk.accountId, availableMinor: chk.availableMinor, withheldMinor: chk.withheldMinor, currency: 'USD',
      reportedAsOf: chk.reportedAsOf, retrievedAt, coverage: coverageOf(pages, chk.reportedAsOf), lastRefreshedAt: chk.lastRefreshedAt,
      rowIds: rows.map((r) => r.transactionId), rawSha256: b.rawSha256,
    };
    await retainGet(d.store, pk, 'balances', b, retrievedAt);
    // ponytail: one put per row (idempotent by transaction id), then the observation. Ceiling: a few hundred rows per fetch.
    for (const row of rows) await d.store.transact([{ op: 'put', table: 'provider', item: { pk, sk: `RPT#${row.transactionId}`, ...row } }, fundsBumpOp(pk)]);
    await recordRefunds(d, rows.filter((r) => r.eventCode === 'T1107' && r.paypalReferenceId), retrievedAt);
    await d.store.transact([
      { op: 'put', table: 'provider', item: { pk, sk: `OBS#${retrievedAt}`, ...obs, pageSha256 } },
      fundsBumpOp(pk),
      { op: 'put', table: 'provider', item: { pk, sk: 'STATUS', lastAttemptAt: retrievedAt, ok: true, lastError: null, lastGoodRetrievedAt: retrievedAt } },
      ...auditTo('PayPalBalanceObserved', obs.availableMinor === null ? 'PayPal balance has no as-of time: no reported figure' : `PayPal reported available ${usd(obs.availableMinor)} as of ${obs.reportedAsOf}${obs.coverage === 'COMPLETE' ? '' : ' (partial report)'}`),
    ]);
    return { ok: true };
  } catch (e) {
    if (e instanceof CallRefused) return failed(e.message, e.reason === 'BUDGET_REACHED' ? 'PayPalCallBudgetReached' : 'PayPalObservationRejected');
    return failed(`Couldn't reach PayPal: ${(e as Error).message}`);
  }
}

/**
 * S7 R5 / S7-R36: a refund of a capture on a disputed invoice reverses that capture's claim allocations last-in first-out
 * (unapplied, then DISPUTED, then UNDISPUTED) as negative ALLOC rows in the refund's own TX, and gives the used disputed allowance back.
 * The customer's claim record is never touched. Invoices without a claim are unchanged (S5: the receipt stands; refunds are cash only).
 */
async function claimReversalOps(d: Deps, m: CaptureMarker, refundTx: string, refundMinor: number, now: string): Promise<Op[]> {
  const pk = K.run(m.tenantId, m.runId);
  if (!(await d.store.get('core', pk, `CLAIM#${m.invoiceId}`))) return [];
  const mine = (await d.store.query('core', pk, { skPrefix: `ALLOC#${m.captureId}` })).filter((a) => a.invoiceId === m.invoiceId);
  const left = (claim: string) => mine.filter((a) => (a.claim ?? 'WHOLE') === claim).reduce((t, a) => t + a.amount.minor, 0);
  let rest = refundMinor;
  const ops: Op[] = [];
  let disputed = 0;
  const done: string[] = [];
  for (const claim of ['UNALLOCATED', 'DISPUTED', 'UNDISPUTED'] as const) {
    const x = Math.min(rest, Math.max(0, left(claim)));
    if (!x) continue;
    rest -= x;
    if (claim === 'DISPUTED') disputed = x;
    done.push(`${(x / 100).toFixed(2)} ${claim.toLowerCase()}`);
    ops.push({ op: 'put', table: 'core', item: { pk, sk: `ALLOC#${m.captureId}#REV#${refundTx}#${claim}`, allocationId: `rev-${refundTx}-${claim.toLowerCase()}`, captureId: m.captureId, invoiceId: m.invoiceId, amount: { currency: 'USD', minor: -x }, at: now, claim, reversalOf: refundTx }, cond: { notExists: true } });
  }
  const allow = disputed ? await d.store.get('core', pk, `DISPALLOW#${m.invoiceId}`) : undefined;
  if (allow) ops.push({ op: 'update', table: 'core', pk, sk: allow.sk, set: { usedMinor: Math.max(0, allow.usedMinor - disputed) }, add: { version: 1 }, cond: { eq: { version: allow.version } } });
  if (ops.length) ops.push(basisBumpOp(pk), auditOp({ tenantId: m.tenantId, runId: m.runId, type: 'ReceiptRefundObserved', by: 'PAYPAL', result: `Refund on a disputed invoice: allocations reversed last-in first-out (${done.join(', ')}); the dispute record is unchanged`, refs: { captureId: m.captureId, refundId: refundTx, invoiceId: m.invoiceId }, correlationId: `refund:${refundTx}:claims`, now }));
  return ops;
}

/** A T1107 row referencing one of our captures → one immutable negative movement, audited once, in the capture's run. */
async function recordRefunds(d: Deps, rows: ReturnType<typeof toReportingRows>, now: string) {
  const pk = K.conn(d.config.connectionId);
  for (const r of rows) {
    const m = (await d.store.get('provider', pk, `CAPTURE#${r.paypalReferenceId}`)) as CaptureMarker | undefined;
    if (!m || !r.amount) continue;
    const amount = { currency: 'USD' as const, minor: -r.amount.minor };
    for (let attempt = 0; attempt < 3; attempt++) {
      const rev = await claimReversalOps(d, m, r.transactionId, Math.abs(r.amount.minor), now);
      try {
        await d.store.transact([
          ...rev,
          { op: 'put', table: 'provider', item: { pk, sk: `REFUND#${r.transactionId}`, transactionId: r.transactionId, captureId: m.captureId, connectionId: d.config.connectionId, amount, at: r.initiatedAt, source: 'PAYPAL_REPORTING', runId: m.runId, tenantId: m.tenantId }, cond: { notExists: true } },
          fundsBumpOp(pk),
          auditOp({ tenantId: m.tenantId, runId: m.runId, type: 'ReceiptRefundObserved', by: 'PAYPAL', result: `Refund ${amount.minor} on capture ${m.captureId}; receipt unchanged`, refs: { captureId: m.captureId, refundId: r.transactionId }, correlationId: `refund:${r.transactionId}`, now }),
        ]);
        break;
      } catch (e) {
        if (!(e instanceof TxCancelled)) throw e;
        if (e.failed[rev.length]) break; // already recorded: no second negative
        // an allowance or allocation moved underneath (a concurrent capture): recompute the reversal and try again
      }
    }
  }
}

