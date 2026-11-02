// Pure parts of OBSERVE_BALANCE (S01 T5.2): validate a reporting balance and normalise transaction rows.
import { decimalToMinor, type BalanceObservation, type PpBalances, type PpTransactionsPage, type ReportingRow } from '@headroom/contracts';
import { MIN } from '../time.ts';

const iso = (s: string) => new Date(s).toISOString();

export type BalanceCheck =
  | { ok: true; accountId: string; availableMinor: number | null; withheldMinor: number | null; reportedAsOf: string | null; lastRefreshedAt: string | null }
  | { ok: false; reason: 'ACCOUNT_MISMATCH' | 'FUTURE_ASOF' | 'NO_USD_BALANCE' | 'NO_ACCOUNT_ID' };

export function checkBalance(b: PpBalances, pinnedAccountId: string | null, retrievedAt: string): BalanceCheck {
  if (!b.account_id) return { ok: false, reason: 'NO_ACCOUNT_ID' };
  if (pinnedAccountId && b.account_id !== pinnedAccountId) return { ok: false, reason: 'ACCOUNT_MISMATCH' };
  const usd = b.balances.find((x) => x.currency === 'USD');
  if (!usd) return { ok: false, reason: 'NO_USD_BALANCE' };
  const asOf = b.as_of_time ? iso(b.as_of_time) : null;
  if (asOf && Date.parse(asOf) > Date.parse(retrievedAt) + 5 * MIN) return { ok: false, reason: 'FUTURE_ASOF' };
  const minor = (a?: { currency_code: string; value: string }) => (a && a.currency_code === 'USD' ? decimalToMinor(a.value) : null);
  return {
    ok: true,
    accountId: b.account_id,
    // S1-R14: with no as-of there is no reported figure at all.
    availableMinor: asOf ? minor(usd.available_balance) : null,
    withheldMinor: minor(usd.withheld_balance),
    reportedAsOf: asOf,
    lastRefreshedAt: b.last_refresh_time ? iso(b.last_refresh_time) : null,
  };
}

export function toReportingRows(pages: PpTransactionsPage[]): ReportingRow[] {
  let order = 0;
  return pages.flatMap((p) =>
    p.transaction_details.map(({ transaction_info: t }) => {
      const cur = t.transaction_amount.currency_code;
      const usd = (a?: { currency_code: string; value: string } | null) => (a && a.currency_code === 'USD' ? { currency: 'USD' as const, minor: decimalToMinor(a.value) } : null);
      return {
        transactionId: t.transaction_id,
        eventCode: t.transaction_event_code,
        status: t.transaction_status,
        amount: usd(t.transaction_amount),
        fee: usd(t.fee_amount),
        currency: cur,
        initiatedAt: iso(t.transaction_initiation_date),
        updatedAt: t.transaction_updated_date ? iso(t.transaction_updated_date) : null,
        paypalReferenceId: t.paypal_reference_id ?? null,
        invoiceNumber: t.invoice_id ?? null,
        availableBalance: usd(t.available_balance),
        order: order++,
      };
    }),
  );
}

/** COMPLETE only if every page was read and the report is refreshed to at least as-of. */
export function coverageOf(pages: PpTransactionsPage[], asOf: string | null): BalanceObservation['coverage'] {
  if (!pages.length || !asOf) return 'PARTIAL';
  const total = pages[0].total_pages;
  const got = new Set(pages.map((p) => p.page));
  for (let i = 1; i <= total; i++) if (!got.has(i)) return 'PARTIAL';
  const refreshed = pages[pages.length - 1].last_refreshed_datetime;
  return refreshed && Date.parse(refreshed) >= Date.parse(asOf) ? 'COMPLETE' : 'PARTIAL';
}

/** Newest as-of wins, never newest retrievedAt. Observations without a reported figure are skipped. */
export function pickSnapshot(obs: BalanceObservation[]): BalanceObservation | null {
  return obs.filter((o) => o.availableMinor !== null && o.reportedAsOf !== null)
    .sort((a, b) => b.reportedAsOf!.localeCompare(a.reportedAsOf!) || b.retrievedAt.localeCompare(a.retrievedAt))[0] ?? null;
}
