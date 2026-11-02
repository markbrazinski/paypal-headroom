// Plaid composition for dev Lambdas. api: link-token client + vault (seal at claim, decrypt for update mode).
// The connector is composed only in worker-runtime.ts, so only the worker bundle can mutate a connection (S2-PR-01).
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { PlaidHttp } from '../adapters/plaid/http.ts';
import { kmsVault, type Vault } from '../adapters/vault.ts';
import { baseConfig, now, store } from './runtime.ts';

let http: Promise<PlaidHttp> | null = null;
let vault: Promise<Vault> | null = null;

/** Secret headroom/dev/plaid {client_id, secret}; values never logged. */
export function plaidHttp(): Promise<PlaidHttp> {
  http ??= (async () => {
    const s = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: process.env.HR_PLAID_SECRET_ID! }));
    const v = JSON.parse(s.SecretString ?? '{}');
    return new PlaidHttp({ clientId: v.client_id, secret: v.secret, env: 'sandbox', store, grant: baseConfig.grant, now });
  })().catch((e) => { http = null; throw e; });
  return http;
}
export function plaidVault(): Promise<Vault> {
  vault ??= kmsVault(process.env.HR_PLAID_KEY_ID!).catch((e) => { vault = null; throw e; });
  return vault;
}
