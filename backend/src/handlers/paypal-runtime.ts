// Composition for worker and operator: the only bundles holding PayPal credentials and the writer.
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { PayPalHttp } from '../adapters/paypal/http.ts';
import { paypalReader } from '../adapters/paypal/reader.ts';
import { paypalWriter } from '../adapters/paypal/writer.ts';
import type { Deps } from '../deps.ts';
import { baseConfig, evidence, now, queue, store } from './runtime.ts';

let cached: Promise<Deps> | null = null;
let loadedAt = 0;
const REFRESH_MS = 5 * 60_000; // a webhook id or rotated secret written after a cold start is picked up within 5 min

/** Secret {client_id, secret, merchant_email, webhook_id, sandbox_receiver}; values never logged. */
export function paypalDeps(): Promise<Deps> {
  if (Date.now() - loadedAt > REFRESH_MS) { cached = null; loadedAt = Date.now(); }
  cached ??= (async () => {
    const s = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: process.env.HR_PAYPAL_SECRET_ID! }));
    const v = JSON.parse(s.SecretString ?? '{}');
    const http = new PayPalHttp({ clientId: v.client_id, secret: v.secret, store, grant: baseConfig.grant, now });
    return { store, queue, now, evidence, reader: paypalReader(http), writer: paypalWriter(http), config: { ...baseConfig, merchantEmail: v.merchant_email, webhookId: v.webhook_id || null, payoutReceiver: v.sandbox_receiver || null } };
  })();
  return cached;
}
