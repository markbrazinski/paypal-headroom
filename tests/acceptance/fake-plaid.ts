// STUB of the Plaid sandbox at the adapter boundary, shaped from the probe's observed responses (FINDINGS §2–§6).
// Labelled STUB/REPLAY in test names. It is never evidence of a bank connection or balance.
import { createHash, randomBytes } from 'node:crypto';
import type { HttpResult } from '../../backend/src/adapters/grant.ts';
import { NoResponse } from '../../backend/src/adapters/grant.ts';
import type { PlaidLinkTokenClient, PlaidReader } from '../../backend/src/adapters/plaid/clients.ts';
import type { PlaidConnector } from '../../backend/src/adapters/plaid/connector.ts';
import { fixture } from '../fixtures/plaid/index.ts';

const res = (status: number, body: any): HttpResult => { const raw = JSON.stringify(body); return { status, body: structuredClone(body), raw, rawSha256: createHash('sha256').update(raw).digest('hex') }; };
const err = (code: string, type = 'ITEM_ERROR') => res(400, { error_type: type, error_code: code, error_message: code.toLowerCase(), display_message: null });
const id = (p: string) => `${p}${randomBytes(9).toString('base64url')}`;

type Event = { kind: 'added' | 'modified' | 'removed'; txn: any };
export interface FakeItem { itemId: string; accessToken: string; accounts: any[]; log: Event[]; loginRequired: boolean; removed: boolean; updateStatus: string }

export class FakePlaid {
  calls: string[] = [];
  items = new Map<string, FakeItem>();
  private publicTokens = new Map<string, { config: any | null; used: boolean; itemId?: string }>();
  /** Live sandbox behaviour seen 1 Nov 2026: a reused public token answers 200 with the same Item. Default: INVALID_PUBLIC_TOKEN. */
  replayAnswers200 = false;
  /** One-shot or sticky faults, e.g. 'exchange-lost-response', 'exchange-400', 'remove-timeout', 'create-timeout', 'sync-mutation', 'sync-limit', 'balance-500'. */
  faults = new Set<string>();
  /** Page size cap, to force pagination. */
  pageSize = 500;
  /** Virtual latency per call (ms), added to `elapsed` (the worker's budget clock) — a specification seam, not a measurement. */
  delayMs = 0;
  elapsed = 0;
  today = () => '2026-11-01';

  count(prefix: string) { return this.calls.filter((c) => c.startsWith(prefix)).length; }
  private hit(name: string) { this.calls.push(name); this.elapsed += this.delayMs; }
  private once(f: string) { if (this.faults.has(f)) { this.faults.delete(f); return true; } return false; }
  private byToken(t: string) { return [...this.items.values()].find((i) => i.accessToken === t); }

  /** What Plaid Link hands the browser after a successful login (test stand-in for the Link UI). */
  linkPublicToken(config: any = JSON.parse(JSON.stringify(DEFAULT_CONFIG))) { const t = id('public-sandbox-'); this.publicTokens.set(t, { config, used: false }); return t; }

  private makeItem(config: any): FakeItem {
    const itemId = id('item_');
    const accounts: any[] = [];
    const log: Event[] = [];
    for (const a of config.override_accounts) {
      const accountId = id('acct_');
      const txns = (a.transactions ?? []).map((t: any) => ({
        transaction_id: id('txn_'), account_id: accountId, amount: t.amount, iso_currency_code: a.currency ?? 'USD', unofficial_currency_code: null,
        date: t.date_posted > this.today() ? t.date_transacted : t.date_posted, authorized_date: t.date_transacted, name: t.description,
        pending: t.date_posted > this.today(), pending_transaction_id: null, counterparties: /paypal/i.test(t.description) ? [{ name: 'PayPal' }] : [],
      }));
      const pending = txns.filter((t: any) => t.pending).reduce((s: number, t: any) => s + t.amount, 0);
      const current = a.starting_balance;
      const available = a.has_null_available_balance ? null : a.type === 'credit' ? (a.meta.limit ?? 0) - current - pending : current - pending;
      accounts.push({
        account_id: accountId, name: a.meta.name, mask: a.meta.mask, type: a.type, subtype: a.subtype, holder_category: 'personal',
        balances: { available: a.balances?.available !== undefined ? a.balances.available : available, current: a.balances?.current ?? current, limit: a.meta.limit ?? null, iso_currency_code: a.currency === null ? null : a.currency ?? 'USD', unofficial_currency_code: a.unofficial ?? null, last_updated_datetime: null },
      });
      log.push(...txns.map((txn: any) => ({ kind: 'added' as const, txn })));
    }
    const it: FakeItem = { itemId, accessToken: id('access-sandbox-'), accounts, log, loginRequired: false, removed: false, updateStatus: 'HISTORICAL_UPDATE_COMPLETE' };
    this.items.set(itemId, it);
    return it;
  }

  // ---------- test harness side (never product code) ----------
  resetLogin(itemId: string) { this.items.get(itemId)!.loginRequired = true; }
  completeUpdateMode(itemId: string) { this.items.get(itemId)!.loginRequired = false; }
  removeOutOfBand(itemId: string) { this.items.get(itemId)!.removed = true; }
  /** A posted row replacing a pending one (Plaid: a new id with pending_transaction_id, and the pending id removed). */
  post(itemId: string, pendingName: string) {
    const it = this.items.get(itemId)!;
    const p = it.log.find((e) => e.kind === 'added' && e.txn.name === pendingName && e.txn.pending)!.txn;
    it.log.push({ kind: 'added', txn: { ...p, transaction_id: id('txn_'), pending: false, pending_transaction_id: p.transaction_id, date: this.today() } }, { kind: 'removed', txn: { transaction_id: p.transaction_id } });
  }
  addPage(itemId: string, n: number) {
    const it = this.items.get(itemId)!;
    const acct = it.accounts[0].account_id;
    for (let i = 0; i < n; i++) it.log.push({ kind: 'added', txn: { transaction_id: id('txn_'), account_id: acct, amount: 1, iso_currency_code: 'USD', date: '2026-10-20', authorized_date: null, name: `FILLER ${i}`, pending: false, pending_transaction_id: null, counterparties: [] } });
  }

  // ---------- adapter-boundary clients ----------
  linkToken: PlaidLinkTokenClient = {
    create: async (a) => { this.hit(`LINK_TOKEN ${a.accessToken ? 'update' : 'connect'}`); return res(200, { link_token: id('link-sandbox-'), expiration: '2026-11-01T18:00:00Z' }); },
  };

  connector: PlaidConnector = {
    exchange: async (publicToken) => {
      this.hit('EXCHANGE');
      if (this.once('exchange-500')) return res(500, { error_code: 'INTERNAL_SERVER_ERROR' });
      if (this.once('exchange-400')) return err('INVALID_PUBLIC_TOKEN', 'INVALID_INPUT');
      const p = this.publicTokens.get(publicToken);
      if (p?.used && this.replayAnswers200 && p.itemId) { const it = this.items.get(p.itemId)!; return res(200, { access_token: it.accessToken, item_id: it.itemId, request_id: 'r' }); }
      if (!p || p.used) return err('INVALID_PUBLIC_TOKEN', 'INVALID_INPUT');
      p.used = true;
      const it = this.makeItem(p.config ?? DEFAULT_CONFIG);
      p.itemId = it.itemId;
      if (this.once('exchange-lost-response')) throw new NoResponse('injected: response discarded after the exchange applied');
      return res(200, { access_token: it.accessToken, item_id: it.itemId, request_id: 'r' });
    },
    remove: async (t) => {
      this.hit('REMOVE');
      const it = this.byToken(t);
      if (this.faults.has('remove-timeout')) { if (it) it.removed = true; throw new NoResponse('injected: remove timed out'); }
      if (!it || it.removed) return err('ITEM_NOT_FOUND');
      it.removed = true;
      return res(200, { request_id: 'r' });
    },
    sandboxPublicTokenCreate: async (_inst, _user, password) => {
      this.hit('SANDBOX_CREATE');
      if (this.once('create-timeout')) throw new NoResponse('injected: create timed out');
      if (this.once('create-400')) return err('INVALID_FIELD', 'INVALID_INPUT');
      const t = id('public-sandbox-');
      this.publicTokens.set(t, { config: JSON.parse(password), used: false });
      return res(200, { public_token: t, request_id: 'r' });
    },
  };

  reader: PlaidReader = {
    itemGet: async (t) => {
      this.hit('ITEM_GET');
      const it = this.byToken(t);
      if (!it || it.removed) return err('ITEM_NOT_FOUND');
      if (this.faults.has('item-get-500')) return res(500, { error_code: 'INTERNAL_SERVER_ERROR' });
      return res(200, { item: { item_id: it.itemId, institution_id: 'ins_109508', institution_name: 'First Platypus Bank', error: it.loginRequired ? { error_type: 'ITEM_ERROR', error_code: 'ITEM_LOGIN_REQUIRED', error_message: 'login required' } : null, consent_expiration_time: null }, status: { transactions: { last_successful_update: '2026-11-01T13:00:00.000Z' } } });
    },
    sync: async (t, cursor, count) => {
      this.hit(`SYNC ${cursor || '-'}`);
      const it = this.byToken(t);
      if (!it || it.removed) return err('ITEM_NOT_FOUND');
      if (it.loginRequired) return err('ITEM_LOGIN_REQUIRED');
      if (cursor && this.once('sync-mutation')) return err('TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION', 'TRANSACTIONS_ERROR');
      if (cursor && this.faults.has('sync-limit')) return err('TRANSACTIONS_SYNC_LIMIT', 'RATE_LIMIT_EXCEEDED');
      const start = Number(cursor || 0);
      const slice = it.log.slice(start, start + Math.min(count, this.pageSize));
      const next = start + slice.length;
      return res(200, {
        added: slice.filter((e) => e.kind === 'added').map((e) => e.txn), modified: slice.filter((e) => e.kind === 'modified').map((e) => e.txn),
        removed: slice.filter((e) => e.kind === 'removed').map((e) => ({ transaction_id: e.txn.transaction_id })),
        next_cursor: String(next), has_more: next < it.log.length, transactions_update_status: it.updateStatus, request_id: 'r',
      });
    },
    balance: async (t) => {
      this.hit('BALANCE');
      const it = this.byToken(t);
      if (!it || it.removed) return err('ITEM_NOT_FOUND');
      if (it.loginRequired) return err('ITEM_LOGIN_REQUIRED');
      if (this.faults.has('balance-500')) return res(500, { error_code: 'INTERNAL_SERVER_ERROR' });
      return res(200, { accounts: it.accounts, item: { item_id: it.itemId }, request_id: 'r' });
    },
  };
}

/** Same content as the demo seed (and the probe's user_custom config) for owner-linked Items in tests. */
const DEFAULT_CONFIG = (() => {
  const accounts = fixture('balance-demo').body.accounts;
  return { override_accounts: accounts.map((a: any) => ({ type: a.type, subtype: a.subtype, starting_balance: a.balances.current, currency: 'USD', balances: { available: a.balances.available }, meta: { name: a.name, mask: a.mask, ...(a.balances.limit ? { limit: a.balances.limit } : {}) }, transactions: [] })) };
})();
