// API Lambda: `/v1/*` behind the Cognito JWT authorizer. No PayPal secret, no PayPal writer, no Plaid connector (invariant 16).
// Plaid: link tokens only (a session token) + the vault to seal a claimed public token.
import { plaidLinkToken } from '../adapters/plaid/clients.ts';
import { handle } from './router.ts';
import { plaidHttp, plaidVault } from './plaid-runtime.ts';
import { toReq, toResult, type HttpEvent } from './http-event.ts';
import { baseConfig, evidence, now, queue, store } from './runtime.ts';

export const handler = async (e: HttpEvent) => {
  // A missing Plaid secret or key must not take down the PayPal routes: bank routes then answer 503.
  const [http, vault] = await Promise.all([plaidHttp().catch(() => null), plaidVault().catch(() => null)]);
  return toResult(await handle({ store, queue, config: baseConfig, now, plaidLink: http ? plaidLinkToken(http) : undefined, vault: vault ?? undefined, evidence }, toReq(e, true)));
};
