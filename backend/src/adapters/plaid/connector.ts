// Plaid connection mutations (S02 §6.2a). Constructed only by the worker composition and called only from
// domain/executor/bank-effects.ts; the import-graph test proves no api, operator, webhook or sweep bundle reaches it.
import type { HttpResult } from '../grant.ts';
import type { PlaidHttp } from './http.ts';

export interface PlaidConnector {
  /** Activates the Item and mints its access token. The single-use public token is its own idempotency key. */
  exchange(publicToken: string): Promise<HttpResult>;
  remove(accessToken: string): Promise<HttpResult>;
  /** Sandbox only: creates an Item for a sandbox user (the demo bank seed). Not idempotent; never replayed. */
  sandboxPublicTokenCreate(institutionId: string, username: string, password: string): Promise<HttpResult>;
}

export const plaidConnector = (http: PlaidHttp): PlaidConnector => ({
  exchange: (publicToken) => http.call('/item/public_token/exchange', { public_token: publicToken }, { items: true }),
  remove: (accessToken) => http.call('/item/remove', { access_token: accessToken }),
  sandboxPublicTokenCreate: (institutionId, username, password) => http.call('/sandbox/public_token/create', {
    institution_id: institutionId, initial_products: ['transactions'], options: { override_username: username, override_password: password },
  }, { items: true, timeoutMs: 20_000 }),
});
