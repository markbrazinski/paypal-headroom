// Plaid clients by role (S02 §6.6): the link-token client (api), the reader (worker sync job).
// Connection mutations live in connector.ts, reachable only from the worker's effect executor (import-graph test).
import type { HttpResult } from '../grant.ts';
import type { PlaidHttp } from './http.ts';

/** A session token: creates no Item and no stored credential. `accessToken` only for update mode (reconnect). */
export interface PlaidLinkTokenClient { create(a: { clientUserId: string; accessToken?: string }): Promise<HttpResult> }

/** Data reads. Plaid uses POST, but nothing at Plaid changes. */
export interface PlaidReader {
  itemGet(accessToken: string): Promise<HttpResult>;
  sync(accessToken: string, cursor: string, count: number): Promise<HttpResult>;
  balance(accessToken: string): Promise<HttpResult>;
}

export const plaidLinkToken = (http: PlaidHttp): PlaidLinkTokenClient => ({
  create: ({ clientUserId, accessToken }) => http.call('/link/token/create', {
    client_name: 'Headroom', language: 'en', country_codes: ['US'], user: { client_user_id: clientUserId },
    // No webhook (S2-D5) and no redirect_uri (non-OAuth sandbox institutions only).
    ...(accessToken ? { access_token: accessToken } : { products: ['transactions'], transactions: { days_requested: 90 } }),
  }),
});

export const plaidReader = (http: PlaidHttp): PlaidReader => ({
  itemGet: (t) => http.call('/item/get', { access_token: t }),
  sync: (t, cursor, count) => http.call('/transactions/sync', { access_token: t, ...(cursor ? { cursor } : {}), count }),
  balance: (t) => http.call('/accounts/balance/get', { access_token: t }, { timeoutMs: 20_000 }),
});
