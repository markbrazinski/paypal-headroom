// Bank mirror rules (S02 §6.4). Pure: no store, no clock, no provider. Balances drive cash; transactions only explain.
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import {
  BANK_ACTIVE_STATES, decimalToMinor,
  type BankAccountBalance, type BankBalanceObservation, type BankBinding, type BankConnection, type BankEffectRecord, type BankSource,
  type BankTransaction, type PlaidAccount, type PlaidSyncPage, type PlaidTransaction, type ProviderAmount,
} from '@headroom/contracts';
import { MIN, HOUR, addDays, addMs } from '../time.ts';

// ---------- amounts ----------
export function providerAmount(v: number | null | undefined, iso: string | null | undefined, unofficial: string | null | undefined): ProviderAmount | null {
  if (v === null || v === undefined) return null;
  return { value: String(v), currencyCode: iso ?? unofficial ?? null, currencyKind: iso ? 'ISO' : unofficial ? 'UNOFFICIAL' : 'UNKNOWN' };
}

/** Exact cents → minor units; anything else (1024.502621, 1e+21) → null. Never rounded. */
export function exactMinor(v: number | null | undefined): number | null {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  try { return decimalToMinor(String(v)); } catch { return null; }
}

export function toObservation(itemId: string, accounts: PlaidAccount[], retrievedAt: string, rawSha256: string): BankBalanceObservation {
  return {
    itemId, source: 'REALTIME', retrievedAt, rawSha256,
    accounts: accounts.map((a): BankAccountBalance => {
      const b = a.balances;
      const usd = b.iso_currency_code === 'USD';
      return {
        accountId: a.account_id, name: a.name, mask: a.mask, type: a.type, subtype: a.subtype, holderCategory: a.holder_category ?? null,
        available: providerAmount(b.available, b.iso_currency_code, b.unofficial_currency_code),
        current: providerAmount(b.current, b.iso_currency_code, b.unofficial_currency_code),
        limit: providerAmount(b.limit, b.iso_currency_code, b.unofficial_currency_code),
        availableMinor: usd ? exactMinor(b.available) : null,
        currentMinor: usd ? exactMinor(b.current) : null,
        precisionRefused: (b.available != null && exactMinor(b.available) === null) || (b.current != null && exactMinor(b.current) === null),
        lastUpdatedAt: b.last_updated_datetime ?? null,
      };
    }),
  };
}

// ---------- S2-D1 / OD-4: which bank figures count ----------
export type Role = 'COUNTED' | 'NOT_COUNTED' | 'OWED' | 'NOT_CASH';
export type Refusal = 'NOT_CHECKING' | 'AVAILABILITY_NOT_REPORTED' | 'PROVIDER_PRECISION' | 'UNSUPPORTED_CURRENCY' | 'UNKNOWN_CURRENCY' | 'CREDIT_OWED' | 'NOT_CASH';
export interface Classified { role: Role; label: string; eligibleMinor: number | null; refusal: Refusal | null; reason: string | null }

/**
 * Only a depository/checking account with a non-null, USD, exact-cent `available` is COUNTED.
 * `holder_category` is shown but never used to exclude: the sandbox reports the demo accounts as "personal".
 */
export function classifyAccount(a: BankAccountBalance): Classified {
  const not = (role: Role, refusal: Refusal, label: string, reason: string): Classified => ({ role, label, eligibleMinor: null, refusal, reason });
  if (a.type === 'credit') return not('OWED', 'CREDIT_OWED', 'Owed on card · not cash', 'A card balance is money owed, never cash');
  if (a.type !== 'depository') return not('NOT_CASH', 'NOT_CASH', 'Not cash', `${a.type} accounts are not cash`);
  if (a.subtype !== 'checking') {
    return a.available === null
      ? not('NOT_COUNTED', 'AVAILABILITY_NOT_REPORTED', 'Balance — availability not reported · not counted', 'The bank did not report an available balance')
      : not('NOT_COUNTED', 'NOT_CHECKING', 'Available · not counted (only checking counts)', 'Only checking accounts count as cash');
  }
  const cur = a.available ?? a.current;
  if (cur && cur.currencyKind === 'UNKNOWN') return not('NOT_COUNTED', 'UNKNOWN_CURRENCY', 'Currency not reported · not counted', 'The bank did not report a currency');
  if (cur && cur.currencyCode !== 'USD') return not('NOT_COUNTED', 'UNSUPPORTED_CURRENCY', `Reported in ${cur.currencyCode} · not counted (only USD counts)`, `Only USD balances count (this one is ${cur.currencyCode})`);
  if (a.available === null) return not('NOT_COUNTED', 'AVAILABILITY_NOT_REPORTED', 'Balance — availability not reported · not counted', 'The bank did not report an available balance');
  if (a.availableMinor === null) return not('NOT_COUNTED', 'PROVIDER_PRECISION', 'Unexpected precision · not counted', `The bank reported ${a.available.value}, which is not whole cents`);
  return { role: 'COUNTED', label: 'Available · counted', eligibleMinor: a.availableMinor, refusal: null, reason: null };
}

/** Sum of COUNTED accounts, or null when nothing is countable or a checking account's figure is missing or refused. */
export function countedOf(accounts: BankAccountBalance[]): { countedMinor: number | null; incomplete: string[] } {
  const c = accounts.map((a) => ({ a, k: classifyAccount(a) }));
  const incomplete = c.filter(({ a, k }) => a.type === 'depository' && a.subtype === 'checking' && k.role !== 'COUNTED').map(({ a }) => `${a.name}${a.mask ? ` ··${a.mask}` : ''}`);
  const counted = c.filter(({ k }) => k.role === 'COUNTED');
  return { countedMinor: !counted.length || incomplete.length ? null : counted.reduce((s, { k }) => s + k.eligibleMinor!, 0), incomplete };
}

// ---------- transactions (probe D2/D4, B1; cases 2–5) ----------
export const isPayPalCandidate = (t: Pick<PlaidTransaction, 'name' | 'counterparties'>) => /paypal/i.test(t.name) || (t.counterparties ?? []).some((c) => /paypal/i.test(c.name));

function toRow(t: PlaidTransaction, prev: BankTransaction | undefined, now: string): BankTransaction {
  return {
    transactionId: t.transaction_id, accountId: t.account_id, state: t.pending ? 'pending' : 'posted', pendingTransactionId: t.pending_transaction_id ?? null,
    amountMinor: t.iso_currency_code === 'USD' ? exactMinor(t.amount) : null, rawAmount: t.amount, currency: t.iso_currency_code ?? t.unofficial_currency_code ?? null,
    date: t.date, authorizedDate: t.authorized_date ?? null, description: t.name, counterparties: (t.counterparties ?? []).map((c) => c.name),
    // Plaid's category is deliberately ignored for treatment: it is description-sensitive and misfires (probe §7.3).
    paypalCandidate: isPayPalCandidate(t),
    firstSeenAt: prev?.firstSeenAt ?? now, updatedAt: now,
  };
}
const content = (r: BankTransaction) => JSON.stringify({ ...r, firstSeenAt: 0, updatedAt: 0 });

export interface SyncChange { transactionId: string; change: 'added' | 'modified' | 'removed'; state: BankTransaction['state'] }

/** Apply one whole update cycle. Upsert by transaction_id; removals are tombstones; a change row only on a real change. */
export function applySync(projection: BankTransaction[], pages: Pick<PlaidSyncPage, 'added' | 'modified' | 'removed'>[], now: string): { projection: BankTransaction[]; changes: SyncChange[] } {
  const by = new Map(projection.map((r) => [r.transactionId, r]));
  const changes: SyncChange[] = [];
  for (const p of pages) {
    for (const t of [...p.added, ...p.modified]) {
      const prev = by.get(t.transaction_id);
      const row = toRow(t, prev, now);
      if (prev && content(prev) === content(row)) continue;
      by.set(row.transactionId, row);
      changes.push({ transactionId: row.transactionId, change: prev && prev.state !== 'removed' ? 'modified' : 'added', state: row.state });
    }
    for (const { transaction_id } of p.removed) {
      const prev = by.get(transaction_id);
      if (!prev || prev.state === 'removed') continue;
      by.set(transaction_id, { ...prev, state: 'removed', updatedAt: now });
      changes.push({ transactionId: transaction_id, change: 'removed', state: 'removed' });
    }
  }
  return { projection: [...by.values()], changes };
}

/** Pending ids replaced by an active posted row: hidden even before Plaid's removal arrives (probe D4). */
export function supersededIds(rows: BankTransaction[]): Set<string> {
  return new Set(rows.filter((r) => r.state === 'posted' && r.pendingTransactionId).map((r) => r.pendingTransactionId!));
}
export function countedRows(rows: BankTransaction[]): BankTransaction[] {
  const sup = supersededIds(rows);
  return rows.filter((r) => r.state !== 'removed' && !(r.state === 'pending' && sup.has(r.transactionId)));
}

// ---------- provider errors (probe F1–F3) ----------
export type ErrorClass = 'LOGIN_REQUIRED' | 'REVOKED' | 'MUTATION' | 'RATE_LIMIT' | 'TRANSIENT';
export function classifyError(status: number | null, body: any): { kind: ErrorClass; code: string; message: string } {
  const code: string = body?.error_code ?? (status === null ? 'NO_RESPONSE' : `HTTP_${status}`);
  const message = `${code}${body?.error_message ? `: ${String(body.error_message).slice(0, 160)}` : ''}`;
  if (code === 'ITEM_LOGIN_REQUIRED') return { kind: 'LOGIN_REQUIRED', code, message };
  if (code === 'INVALID_ACCESS_TOKEN' || code === 'ITEM_NOT_FOUND') return { kind: 'REVOKED', code, message };
  if (code === 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION') return { kind: 'MUTATION', code, message };
  if (code === 'TRANSACTIONS_SYNC_LIMIT' || code === 'RATE_LIMIT_EXCEEDED' || status === 429) return { kind: 'RATE_LIMIT', code, message };
  return { kind: 'TRANSIENT', code, message };
}

/** The TXNS projection item (gzip JSON) → rows. */
export const decodeProjection = (t: { projectionGz: string } | undefined): BankTransaction[] => (t ? JSON.parse(gunzipSync(Buffer.from(t.projectionGz, 'base64')).toString('utf8')) : []);

// ---------- read model ----------
export const RECENT_MS = 15 * MIN; // S2-D4 / Build Book §E: a real-time read ≤ 15 min old is "recent"
export const STALE_MS = 3 * HOUR;
type Freshness = 'RECENT' | 'AGING' | 'STALE' | 'FAILED' | 'NEVER';

export function freshnessOf(retrievedAt: string | null, failed: boolean, now: string): Freshness {
  if (failed) return 'FAILED';
  if (!retrievedAt) return 'NEVER';
  const age = Date.parse(now) - Date.parse(retrievedAt);
  return age <= RECENT_MS ? 'RECENT' : age <= STALE_MS ? 'AGING' : 'STALE';
}

export interface BankInput {
  binding?: BankBinding;
  item?: BankConnection;
  status?: { ok: boolean; lastError: string | null; lastAttemptAt: string };
  obs?: BankBalanceObservation;
  accounts?: { accountId: string; notReturned: boolean }[];
  txns?: { projection: BankTransaction[]; syncedAt: string | null; updateStatus: string | null };
  effect?: BankEffectRecord;
  checksStopped: string | null;
  today: string;
}

const NOT_COUNTED: Record<string, string> = {
  DISCONNECTING: 'Removal pending · not counted', REVOKED: 'Connection ended · not counted', DISCONNECTED: 'Disconnected · not counted',
};

function pendingEffect(e: BankEffectRecord | undefined, institutionName: string | null): BankSource['pendingEffect'] {
  if (!e) return null;
  const kind = e.kind === 'BANK_REMOVE' ? 'REMOVAL_PENDING' : e.state === 'VERIFIED_FAILURE' ? 'CONNECT_FAILED' : 'CONNECTING';
  if (e.kind === 'BANK_REMOVE' && e.state === 'VERIFIED_SUCCESS') return null;
  if (e.kind !== 'BANK_REMOVE' && (e.state === 'VERIFIED_SUCCESS' || e.state === 'ABANDONED')) return null;
  return { kind, state: e.state, reason: e.failureReason ?? e.waitingReason ?? null, canAbandon: e.kind === 'BANK_CONNECT' && e.state === 'UNKNOWN' && !!e.canAbandon, terminal: e.state === 'UNKNOWN' && (!!e.terminal || !!e.canAbandon), effectVersion: e.version, institutionName };
}

/** The BankSource DTO (S02 §6.3). Figures of a non-contributing connection are kept as history and never counted. */
export function bankSource(i: BankInput, now: string): BankSource {
  if (!i.item) return { kind: 'BANK', state: 'NOT_CONNECTED', checksStopped: i.checksStopped, pendingEffect: pendingEffect(i.effect, i.effect?.institution?.name ?? null) };
  const it = i.item;
  const accts = i.obs?.accounts ?? [];
  const { countedMinor, incomplete } = countedOf(accts);
  const contributes = BANK_ACTIVE_STATES.includes(it.state) && !!i.obs;
  const rows = i.txns?.projection ?? [];
  const sup = supersededIds(rows);
  const counted = countedRows(rows);
  const mask = (id: string) => accts.find((a) => a.accountId === id)?.mask ?? null;
  const since = addDays(i.today, -14);
  const notReturned = new Set((i.accounts ?? []).filter((a) => a.notReturned).map((a) => a.accountId));
  return {
    kind: 'BANK', state: it.state,
    connection: { version: it.version, institutionName: it.institution.name, basis: it.basis, connectedAt: it.connectedAt },
    counted: countedMinor === null ? null : { currency: 'USD', minor: countedMinor },
    incomplete, contributes, notCountedReason: NOT_COUNTED[it.state] ?? null,
    retrievedAt: i.obs?.retrievedAt ?? null, readKind: i.obs ? 'REALTIME' : null,
    providerAsOf: accts.map((a) => a.lastUpdatedAt).filter(Boolean).sort()[0] ?? null,
    institutionDataAsOf: it.institutionDataAsOf,
    freshness: freshnessOf(i.obs?.retrievedAt ?? null, !!i.status && !i.status.ok, now),
    lastError: i.status && !i.status.ok ? i.status.lastError : null,
    checksStopped: i.checksStopped,
    historyLoading: BANK_ACTIVE_STATES.includes(it.state) && i.txns?.updateStatus !== 'HISTORICAL_UPDATE_COMPLETE',
    pendingEffect: pendingEffect(i.effect, it.institution.name),
    accounts: accts.map((a) => {
      const k = classifyAccount(a);
      return {
        accountId: a.accountId, name: a.name, mask: a.mask, type: a.type, subtype: a.subtype, holderCategory: a.holderCategory, role: k.role, label: k.label,
        provider: { available: a.available, current: a.current, limit: a.limit },
        eligible: k.eligibleMinor === null ? null : { currency: 'USD', minor: k.eligibleMinor }, refusal: k.refusal, reason: k.reason, notReturned: notReturned.has(a.accountId),
      };
    }),
    activity: {
      rows: counted.filter((r) => r.date >= since).sort((a, b) => b.date.localeCompare(a.date) || a.transactionId.localeCompare(b.transactionId)).slice(0, 20).map((r) => ({
        transactionId: r.transactionId, accountMask: mask(r.accountId), date: r.date, description: r.description,
        amount: r.amountMinor === null ? null : { currency: 'USD' as const, minor: -r.amountMinor }, pending: r.state === 'pending', paypalCandidate: r.paypalCandidate,
      })),
      pendingCount: counted.filter((r) => r.state === 'pending').length,
      hiddenSuperseded: rows.filter((r) => r.state !== 'posted' && sup.has(r.transactionId)).length,
      syncedAt: i.txns?.syncedAt ?? null,
    },
  } as BankSource;
}

/** Earliest future instant at which a time-derived field reads differently (S2-PR-05), or null. */
export function validUntil(instants: (string | null | undefined)[], now: string): string | null {
  return instants.filter((x): x is string => !!x && x > now).sort()[0] ?? null;
}
export function bankBoundaries(retrievedAt: string | null): string[] {
  return retrievedAt ? [addMs(retrievedAt, RECENT_MS + 1), addMs(retrievedAt, STALE_MS + 1)] : [];
}

/** Content fingerprint of a seeded bank (S2-A2): same content with different provider ids → same hash. */
export function bankFingerprint(obs: BankBalanceObservation | undefined, rows: BankTransaction[], resetDate: string): string {
  const accts = (obs?.accounts ?? []).map((a) => [a.type, a.subtype, a.mask, a.name, a.available?.value ?? null, a.current?.value ?? null, a.limit?.value ?? null]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const mask = (id: string) => obs?.accounts.find((a) => a.accountId === id)?.mask ?? null;
  const off = (d: string) => Math.round((Date.parse(`${d}T00:00:00Z`) - Date.parse(`${resetDate}T00:00:00Z`)) / 86_400_000);
  const txns = countedRows(rows).map((r) => [mask(r.accountId), r.description, r.amountMinor, off(r.date), r.state === 'pending']).map((x) => JSON.stringify(x)).sort();
  return createHash('sha256').update(JSON.stringify({ accts, txns })).digest('hex').slice(0, 16);
}
