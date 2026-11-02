// Payer Lambda (S7 B6): the AUTOMATED-PAYER's browser, isolated from the worker (x86_64, 2 GB, 120 s, concurrency 2). Invoked async by
// the worker with a SUBMITTING attempt's request; payOnce claims the browser once on the job item, records the result there and wakes the job
// (the worker applies it; PayPal's GETs decide paid). Its only table access is that job item.
// Holds only the sandbox buyer's login (its own secret); no PayPal API client.
import { hostedPayer } from '../adapters/payer/hosted.ts';
import { payOnce, type PayRequest } from '../domain/demo/payer.ts';
import { evidence, now, queue, store } from './runtime.ts';

async function creds() {
  const { GetSecretValueCommand, SecretsManagerClient } = await import('@aws-sdk/client-secrets-manager');
  const s = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: process.env.HR_PAYER_SECRET_ID! }));
  const v = JSON.parse(s.SecretString ?? '{}');
  return { email: v.email as string, password: v.password as string };
}

// ponytail: @sparticuz/chromium 130 (matches playwright-core 1.48's Chromium 130) only knows nodejs20.x as Amazon Linux 2023; nodejs22.x is
// the same AL2023 base, so say so before it loads, or it unpacks the AL2 libraries (libnspr4.so missing). Drop when both move up together.
process.env.AWS_EXECUTION_ENV = 'AWS_Lambda_nodejs20.x';

async function launch() {
  const [{ chromium }, sparticuz] = await Promise.all([import('playwright-core'), import('@sparticuz/chromium')]);
  return chromium.launch({ executablePath: await sparticuz.default.executablePath(), args: sparticuz.default.args, headless: true });
}

/** `{ probe: true }`: launch and close the browser only (post-deploy smoke; no page, no PayPal). */
export const handler = async (e: PayRequest | { probe: true }) => {
  if ('probe' in e) { const b = await launch(); const v = b.version(); await b.close(); return { browser: v }; }
  return payOnce({ store, queue, now, evidence, payer: hostedPayer(launch, await creds()) }, e);
};
