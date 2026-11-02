// Operator-only Gmail connection (S5-D26; QLOO pattern). Not a product screen: the owner signs in once a week (Google's Testing-mode
// refresh tokens last 7 days); the worker then sends and reads in the background, every message redirected to the private test inbox.
//   npm run mail:connect -- --stage local|dev            open the printed link, sign in as the test sender, approve
//   npm run mail:connect -- --stage local|dev --status   connection state and when the 7-day sign-in runs out
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gmailEnv } from '../../backend/src/adapters/mail/config.ts';
import { GMAIL_SCOPES, gmailPk, saveConnection, TESTING_DAYS } from '../../backend/src/adapters/mail/gmail.ts';
import { arg, LOCAL } from './operator-client.ts';

process.loadEnvFile('.env');
const stage = arg('--stage');
if (stage !== 'local' && stage !== 'dev' && stage !== 'review') { console.error('usage: npm run mail:connect -- --stage local|dev|review [--status]'); process.exit(2); }
const N = stage === 'review' ? 'HeadroomReview' : 'HeadroomDev';
const g = gmailEnv();
if (!g.clientId || !g.clientSecret || !g.inbox) { console.error('refusing: set google_oauth_client_id, google_oauth_client_secret and gmail_test_recipient in .env'); process.exit(2); }
const token = stage === 'local' ? readFileSync('.headroom-local/operator-token', 'utf8') : '';

async function devStore() {
  process.env.AWS_PROFILE ??= 'headroom-admin';
  process.env.AWS_REGION ??= 'us-east-1';
  const out = JSON.parse(readFileSync(`.headroom-local/${stage}-outputs.json`, 'utf8'))[N];
  const { DynamoStore } = await import('../../backend/src/adapters/store/dynamodb.ts');
  const { kmsVault } = await import('../../backend/src/adapters/vault.ts');
  return { store: new DynamoStore({ core: `${N}-core`, work: `${N}-work`, provider: `${N}-provider`, audit: `${N}-audit` }), vault: await kmsVault(out.PlaidKeyId ?? out.HrPlaidKeyId) };
}

if (process.argv.includes('--status')) {
  const c: any = stage === 'local'
    ? await (await fetch(`${LOCAL}/__operator/mail/status`, { headers: { 'x-operator-token': token } })).json()
    : (await (await devStore()).store.get('provider', gmailPk(g.sender!), 'CONN')) ?? { state: 'NOT_CONNECTED' };
  const exp = c.connectedAt ? new Date(Date.parse(c.connectedAt) + TESTING_DAYS * 86_400_000) : null;
  console.log(`Gmail (${stage}): ${c.state}${c.email ? ` as ${c.email}` : ''} · test inbox ${g.inbox}`);
  if (exp) console.log(`connected ${c.connectedAt}; the Testing-mode sign-in runs out about ${exp.toISOString()}${exp.getTime() - Date.now() < 86_400_000 ? '  ⚠ within 24 h: reconnect now' : ''}`);
  process.exit(0);
}

const port = 8789;
const redirect = `http://127.0.0.1:${port}/oauth/callback`;
const state = randomBytes(16).toString('hex');
const url = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({ client_id: g.clientId, redirect_uri: redirect, response_type: 'code', scope: GMAIL_SCOPES, state, access_type: 'offline', prompt: 'consent', include_granted_scopes: 'false' })}`;
console.log(`Open this link and sign in as ${g.sender} (the Gmail that sends; every message goes to ${g.inbox}):\n\n${url}\n`);

const code = await new Promise<string>((resolve, reject) => {
  const srv = createServer((req, res) => {
    const u = new URL(req.url ?? '/', redirect);
    if (u.pathname !== '/oauth/callback') { res.writeHead(404).end(); return; }
    const ok = u.searchParams.get('state') === state && u.searchParams.get('code');
    res.writeHead(ok ? 200 : 400, { 'content-type': 'text/plain' }).end(ok ? 'Headroom: Gmail connected. You can close this tab.' : 'Headroom: sign-in refused or state mismatch.');
    srv.close();
    ok ? resolve(u.searchParams.get('code')!) : reject(new Error(u.searchParams.get('error') ?? 'state mismatch'));
  }).listen(port, '127.0.0.1');
  setTimeout(() => { srv.close(); reject(new Error('timed out after 30 minutes')); }, 1_800_000).unref();
});

const tr = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code, client_id: g.clientId, client_secret: g.clientSecret, redirect_uri: redirect, grant_type: 'authorization_code' }) });
const tok = (await tr.json()) as { access_token?: string; refresh_token?: string; scope?: string };
if (!tr.ok || !tok.access_token || !tok.refresh_token) { console.error(`Google didn't issue a refresh token (HTTP ${tr.status})`); process.exit(1); }
const me = (await (await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { authorization: `Bearer ${tok.access_token}` } })).json()) as { email?: string };
if (!me.email) { console.error("Google didn't say which account signed in"); process.exit(1); }
if (stage === 'local') {
  const r = await fetch(`${LOCAL}/__operator/mail/token`, { method: 'POST', headers: { 'x-operator-token': token }, body: JSON.stringify({ email: me.email, refreshToken: tok.refresh_token, scopes: tok.scope ?? '' }) });
  if (!r.ok) { console.error(`Local server refused: ${await r.text()}`); process.exit(1); }
} else {
  const { store, vault } = await devStore();
  await saveConnection(store, vault, g.sender!, { email: me.email, refreshToken: tok.refresh_token, scopes: tok.scope ?? '', now: new Date().toISOString() });
}
console.log(`Gmail connected as ${me.email} (${stage}). Reconnect within ${TESTING_DAYS} days: npm run mail:connect -- --stage ${stage}`);
