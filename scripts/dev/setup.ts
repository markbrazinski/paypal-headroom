// Post-deploy setup for a stage (grant G-4, G-3; S7-D10/D21 `review`). Values from .env are never printed.
//   node scripts/dev/setup.ts secret | plaid | users | bootstrap | webhook | gmail | payer | all [--stage dev|review]
// review: PAYPAL_REVIEW_* credentials (its own sandbox merchant), users = 1 operator + 3 judges in Cognito groups, no owner user.
// AWS_PROFILE defaults to headroom-admin, region us-east-1.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { GetSecretValueCommand, PutSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { arg, invokeOperator, stackOf } from '../demo/operator-client.ts';

process.env.AWS_PROFILE ??= 'headroom-admin';
process.env.AWS_REGION ??= 'us-east-1';
const ROOT = new URL('../../', import.meta.url);
process.loadEnvFile(new URL('.env', ROOT));
const STATE = new URL('.headroom-local/', ROOT);
mkdirSync(STATE, { recursive: true });
const aws = (...a: string[]) => JSON.parse(execFileSync('aws', [...a, '--output', 'json'], { encoding: 'utf8' }) || 'null');
const STAGE = (arg('--stage') ?? 'dev') as 'dev' | 'review';
const outputs = Object.fromEntries((aws('cloudformation', 'describe-stacks', '--stack-name', stackOf(STAGE)).Stacks[0].Outputs as any[]).map((o) => [o.OutputKey, o.OutputValue]));
const sm = new SecretsManagerClient({});
const readSecret = async () => JSON.parse((await sm.send(new GetSecretValueCommand({ SecretId: outputs.SecretName }))).SecretString ?? '{}');
const writeSecret = (v: object) => sm.send(new PutSecretValueCommand({ SecretId: outputs.SecretName, SecretString: JSON.stringify(v) }));

/** `group`: the Cognito group that gives the role (S7-D11); none = owner. */
const USERS: { key: string; email: string; tenantId: string; withConnection: boolean; group?: 'operator' | 'judge' }[] = STAGE === 'review' ? [
  { key: 'operator', email: 'operator@headroom-review.example.com', tenantId: 'tenant-showcase', withConnection: true, group: 'operator' },
  ...[1, 2, 3].map((n) => ({ key: `judge${n}`, email: `judge${n}@headroom-review.example.com`, tenantId: 'tenant-live', withConnection: false, group: 'judge' as const })),
] : [
  { key: 'ownerA', email: 'owner@headroom-dev.example.com', tenantId: 'tenant-owner', withConnection: true },
  { key: 'ownerB', email: 'owner-b@headroom-dev.example.com', tenantId: 'tenant-b', withConnection: false },
];
const usersFile = new URL(`${STAGE}-users.json`, STATE);
/** The stage's PayPal app: review has its own sandbox merchant and REST app (PAYPAL_REVIEW_*). */
const PP = STAGE === 'review'
  ? { id: process.env.PAYPAL_REVIEW_CLIENT_ID, secret: process.env.PAYPAL_REVIEW_CLIENT_SECRET, merchant: process.env.PAYPAL_REVIEW_MERCHANT_EMAIL }
  : { id: process.env.PAYPAL_CLIENT_ID, secret: process.env.PAYPAL_CLIENT_SECRET, merchant: process.env.PAYPAL_MERCHANT_EMAIL };

async function secret() {
  if (process.env.PAYPAL_ENV !== 'sandbox') throw new Error('PAYPAL_ENV must be sandbox');
  const prev = await readSecret().catch(() => ({}));
  // S6-D1: the registered sandbox receiver Keller's payee is seeded from (worker/operator only; never printed).
  if (!PP.id || !PP.secret || !PP.merchant) throw new Error(`PayPal credentials for ${STAGE} missing in .env`);
  await writeSecret({ client_id: PP.id, secret: PP.secret, merchant_email: PP.merchant, webhook_id: prev.webhook_id ?? '', sandbox_receiver: process.env.PAYPAL_BUYER_EMAIL ?? prev.sandbox_receiver ?? '' });
  console.log(`secret ${outputs.SecretName}: populated from .env (values not printed)`);
}

/** S2: headroom/dev/plaid {client_id, secret} from .env. Values never printed; only their lengths are checked. */
async function plaid() {
  if (process.env.PLAID_ENV !== 'sandbox') throw new Error('PLAID_ENV must be sandbox');
  const id = process.env.PLAID_CLIENT_ID ?? '', sec = process.env.PLAID_SECRET ?? '';
  if (id.length !== 24 || sec.length !== 30) throw new Error(`Plaid credentials look malformed (lengths ${id.length}/${sec.length}; expected 24/30)`);
  await sm.send(new PutSecretValueCommand({ SecretId: outputs.PlaidSecretName, SecretString: JSON.stringify({ client_id: id, secret: sec }) }));
  console.log(`secret ${outputs.PlaidSecretName}: populated from .env (values not printed)`);
}

async function users() {
  const saved = existsSync(usersFile) ? JSON.parse(readFileSync(usersFile, 'utf8')) : {};
  for (const u of USERS) {
    if (!saved[u.key]) {
      // MessageAction SUPPRESS: Cognito sends no email. Password kept only in the git-ignored local file.
      const password = `Hr-${randomBytes(12).toString('base64url')}9a`;
      aws('cognito-idp', 'admin-create-user', '--user-pool-id', outputs.UserPoolId, '--username', u.email, '--message-action', 'SUPPRESS', '--user-attributes', `Name=email,Value=${u.email}`, 'Name=email_verified,Value=true');
      aws('cognito-idp', 'admin-set-user-password', '--user-pool-id', outputs.UserPoolId, '--username', u.email, '--password', password, '--permanent');
      saved[u.key] = { email: u.email, password };
    }
    const sub = (aws('cognito-idp', 'admin-get-user', '--user-pool-id', outputs.UserPoolId, '--username', u.email).UserAttributes as any[]).find((a) => a.Name === 'sub').Value;
    saved[u.key].sub = sub;
    if (u.group) aws('cognito-idp', 'admin-add-user-to-group', '--user-pool-id', outputs.UserPoolId, '--username', u.email, '--group-name', u.group);
  }
  writeFileSync(usersFile, JSON.stringify(saved, null, 2), { mode: 0o600 });
  console.log(`users: ${USERS.map((u) => `${u.email}${u.group ? ` (${u.group})` : ''}`).join(', ')} (passwords in .headroom-local/${STAGE}-users.json)`);
}

async function bootstrap() {
  const saved = JSON.parse(readFileSync(usersFile, 'utf8'));
  for (const u of USERS) await invokeOperator({ action: 'bootstrap', tenantId: u.tenantId, sub: saved[u.key].sub, email: u.email, withConnection: u.withConnection });
  // Review judges share one live business (backend live.ts LIVE_TENANT): reset each tenant once.
  for (const t of new Set(USERS.map((u) => u.tenantId))) console.log(t, JSON.stringify(await invokeOperator({ action: 'reset', tenantId: t, reason: `${STAGE} bootstrap` })));
}

/** G-3: exactly one webhook registration per stage, INVOICING.INVOICE.PAID → that stage's API URL. */
async function webhook() {
  const s = await readSecret();
  if (s.webhook_id) { console.log(`webhook already registered (${s.webhook_id})`); return; }
  const base = 'https://api-m.sandbox.paypal.com';
  const tok = await (await fetch(`${base}/v1/oauth2/token`, { method: 'POST', headers: { Authorization: `Basic ${Buffer.from(`${PP.id}:${PP.secret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials', signal: AbortSignal.timeout(10_000) })).json() as any;
  const r = await fetch(`${base}/v1/notifications/webhooks`, { method: 'POST', headers: { Authorization: `Bearer ${tok.access_token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ url: outputs.WebhookUrl, event_types: [{ name: 'INVOICING.INVOICE.PAID' }] }), signal: AbortSignal.timeout(10_000) });
  const body = await r.json() as any;
  if (!r.ok) throw new Error(`webhook registration ${r.status} ${body.name ?? ''}`);
  await writeSecret({ ...s, webhook_id: body.id });
  console.log(`webhook registered: ${body.id} → ${outputs.WebhookUrl}`);
}

/** S5-D26: headroom/dev/gmail from .env (QLOO-style names). Values never printed; only presence is checked. */
async function gmail() {
  const v = (k: string) => (process.env[k] ?? process.env[k.toUpperCase()] ?? '').trim();
  const [id, sec, rcp] = [v('google_oauth_client_id'), v('google_oauth_client_secret'), v('gmail_test_recipient')];
  if (!id || !sec || !rcp) throw new Error('set google_oauth_client_id, google_oauth_client_secret and gmail_test_recipient in .env');
  await sm.send(new PutSecretValueCommand({ SecretId: outputs.GmailSecretName, SecretString: JSON.stringify({ client_id: id, client_secret: sec, recipient: rcp, sender: v('gmail_test_sender') || rcp }) }));
  console.log(`${outputs.GmailSecretName} written (client id, secret, test addresses; values not shown)`);
}

/** S7 B6: headroom/<stage>/payer from PAYPAL_PAYER_EMAIL / PAYPAL_PAYER_PASSWORD (the sandbox personal buyer). Never printed. */
async function payer() {
  const [email, password] = [process.env.PAYPAL_PAYER_EMAIL?.trim(), process.env.PAYPAL_PAYER_PASSWORD];
  if (!email || !password) throw new Error('set PAYPAL_PAYER_EMAIL and PAYPAL_PAYER_PASSWORD in .env');
  await sm.send(new PutSecretValueCommand({ SecretId: outputs.PayerSecretName, SecretString: JSON.stringify({ email, password }) }));
  console.log(`${outputs.PayerSecretName} written (sandbox buyer login; values not shown)`);
}

const step = process.argv[2];
const steps: Record<string, () => Promise<void>> = { secret, plaid, users, bootstrap, webhook, gmail, payer };
if (step === 'all') { for (const s of ['secret', 'plaid', 'users', 'bootstrap', 'webhook', 'payer']) await steps[s](); }
else if (steps[step]) await steps[step]();
else { console.error('usage: node scripts/dev/setup.ts secret|plaid|users|bootstrap|webhook|gmail|payer|all [--stage dev|review]'); process.exit(2); }
console.log(`site: ${outputs.SiteUrl}`);
