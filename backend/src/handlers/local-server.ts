// `npm run dev` backend (STAGE=local only): API + webhook route + operator route + sweep/worker loop in one process,
// sharing one in-memory store. A fixed local identity is used here and nowhere else.
import { createServer, type IncomingMessage } from 'node:http';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { MemoryStore } from '../adapters/store/memory.ts';
import { MemoryQueue } from '../adapters/queue/port.ts';
import { K } from '../adapters/store/keys.ts';
import { PayPalHttp } from '../adapters/paypal/http.ts';
import { paypalReader } from '../adapters/paypal/reader.ts';
import { paypalWriter } from '../adapters/paypal/writer.ts';
import { GRANTS, withGrantExpiry, type Deps } from '../deps.ts';
import { hostedPayer } from '../adapters/payer/hosted.ts';
import { PlaidHttp } from '../adapters/plaid/http.ts';
import { plaidLinkToken, plaidReader } from '../adapters/plaid/clients.ts';
import { plaidConnector } from '../adapters/plaid/connector.ts';
import { LocalVault } from '../adapters/vault.ts';
import { activeRun, bootstrapTenant } from '../domain/identity-run/run.ts';
import { handleDemo, isDemoPath } from './demo.ts';
import { handle } from './router.ts';
import { operatorGetRun, operatorInjectBill, operatorReset } from './operator.ts';
import { processJob } from '../jobs/worker.ts';
import { MemoryEvidence } from '../adapters/evidence-store/memory.ts';
import { bedrockInterpreter, bedrockRole, DRAFTER_PROMPT, PLANNER_PROMPT, REPLY_PROMPT } from '../adapters/bedrock/converse.ts';
import { mailFromEnv } from '../adapters/mail/compose.ts';
import { gmailEnv, mailConfig } from '../adapters/mail/config.ts';
import { gmailPk, saveConnection } from '../adapters/mail/gmail.ts';
import { SimulatedMailbox } from '../adapters/mail/simulated.ts';
import { b64url, buildMessage } from '../adapters/mail/rfc5322.ts';
import { operatorRunActionNow } from './operator.ts';
import { sweep } from '../jobs/sweep.ts';

if (process.env.STAGE !== 'local') throw new Error('local-server runs only with STAGE=local');
const ROOT = resolve(import.meta.dirname, '../../..');
const STATE = join(ROOT, '.headroom-local');
mkdirSync(STATE, { recursive: true });
process.loadEnvFile(join(ROOT, '.env'));
if (process.env.PAYPAL_ENV !== 'sandbox') throw new Error('PAYPAL_ENV must be sandbox');

// S7: a local-only role knob (127.0.0.1, no JWT here) to see the judge drawer; deployed stages read the role from Cognito groups only.
const LOCAL_ROLE = (['JUDGE', 'OPERATOR'] as const).find((r) => r === process.env.HEADROOM_LOCAL_ROLE);
const LOCAL_IDENTITY = { sub: 'local-owner', email: process.env.HEADROOM_LOCAL_EMAIL ?? 'owner@local.test', ...(LOCAL_ROLE ? { role: LOCAL_ROLE } : {}) };
const TENANT = 'tenant-local';
const PORT = Number(process.env.PORT ?? 8787);
// HEADROOM_GRANT=S2 selects the slice renewal (PP-S2 / PLAID-S2) for both providers; unset → every provider call is refused.
const grant = GRANTS[process.env.HEADROOM_GRANT ?? ''] ? withGrantExpiry(GRANTS[process.env.HEADROOM_GRANT ?? '']) : null;

const store = new MemoryStore(join(STATE, 'store.json'));
const queue = new MemoryQueue();
// Clock offset: a local-only test seam (S2-R28), set through the operator route. Never present in dev.
let clockOffsetMs = 0;
const now = () => new Date(Date.now() + clockOffsetMs).toISOString();
const http = new PayPalHttp({ clientId: process.env.PAYPAL_CLIENT_ID!, secret: process.env.PAYPAL_CLIENT_SECRET!, store, grant, now });
const keyFile = join(STATE, 'vault-key');
if (!existsSync(keyFile)) writeFileSync(keyFile, randomBytes(32).toString('base64'), { mode: 0o600 });
const vault = new LocalVault(Buffer.from(readFileSync(keyFile, 'utf8'), 'base64'));
const plaid = process.env.PLAID_CLIENT_ID ? new PlaidHttp({ clientId: process.env.PLAID_CLIENT_ID, secret: process.env.PLAID_SECRET!, env: process.env.PLAID_ENV ?? '', store, grant, now }) : null;
// S3: original documents on disk (write-once); Nova only when HEADROOM_MODEL is set, else bills go READ_FAILED "Model not configured
// here" (truthful, never a fake). Spend: the local server's $5 share of the local $10 (S3-D18; the live script has the other $5).
const evidence = new MemoryEvidence(join(STATE, 'evidence'));
const interpreter = process.env.HEADROOM_MODEL ? bedrockInterpreter({ modelId: process.env.HEADROOM_MODEL }) : undefined;
const deps: Deps = {
  store, queue, now, reader: paypalReader(http), writer: paypalWriter(http),
  config: { stage: 'local', connectionId: 'paypal-sandbox', merchantEmail: process.env.PAYPAL_MERCHANT_EMAIL!, webhookId: process.env.PAYPAL_WEBHOOK_ID || null, grant, mail: mailConfig(), payoutReceiver: process.env.PAYPAL_BUYER_EMAIL || null },
  ...(plaid ? { plaid: { reader: plaidReader(plaid), connector: plaidConnector(plaid) } } : {}), vault,
  evidence, interpreter, bedrockEnv: 'local', bedrockCapMicros: 5_000_000,
  ...(process.env.HEADROOM_MODEL ? { planner: bedrockRole(PLANNER_PROMPT, 'candidates', { modelId: process.env.HEADROOM_MODEL }), drafter: bedrockRole(DRAFTER_PROMPT, 'drafts', { modelId: process.env.HEADROOM_MODEL }), replier: bedrockRole(REPLY_PROMPT, 'reply', { modelId: process.env.HEADROOM_MODEL }) } : {}),
  mail: mailFromEnv(store, vault, now),
  // S7 R3: AUTOMATED-PAYER through the local Google Chrome, as the sandbox buyer in .env (absent → attempts end NOT_SUBMITTED).
  ...(process.env.PAYPAL_PAYER_EMAIL && process.env.PAYPAL_PAYER_PASSWORD ? { payer: hostedPayer(async () => (await import('playwright-core')).chromium.launch({ channel: 'chrome', headless: true }), { email: process.env.PAYPAL_PAYER_EMAIL, password: process.env.PAYPAL_PAYER_PASSWORD }) } : {}),
};

const token = randomBytes(24).toString('hex');
writeFileSync(join(STATE, 'operator-token'), token, { mode: 0o600 });

await bootstrapTenant(store, { sub: LOCAL_IDENTITY.sub, email: LOCAL_IDENTITY.email, tenantId: TENANT, connectionId: 'paypal-sandbox' });
if (!(await activeRun(store, TENANT))) console.log('No run yet: start one with `npm run reset -- --stage local`');

const body = (req: IncomingMessage) => new Promise<string>((ok) => { let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => ok(s)); });
const DIST = join(ROOT, 'web/dist');
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://local');
  // Date from this server's clock (incl. the local test offset): the SPA times server instants (validUntil) against it.
  const send = (status: number, b: string, headers: Record<string, string> = { 'content-type': 'application/json' }) => { res.writeHead(status, { ...headers, date: new Date(now()).toUTCString() }); res.end(b); };
  try {
    if (url.pathname.startsWith('/__operator/')) {
      if (req.headers['x-operator-token'] !== token) return send(403, '{"error":"operator token required"}');
      if (url.pathname === '/__operator/reset' && req.method === 'POST') {
        const b = JSON.parse((await body(req)) || '{}');
        return send(200, JSON.stringify(await operatorReset(deps, TENANT, b.reason ?? 'local reset', { bank: b.bank === 'none' ? 'none' : 'seed', dispute: b.dispute === 'EMAIL' ? 'EMAIL' : 'SEEDED' })));
      }
      if (url.pathname === '/__operator/inject-bill' && req.method === 'POST') return send(200, JSON.stringify(await operatorInjectBill(deps, TENANT, { action: 'injectBill', tenantId: TENANT, ...JSON.parse((await body(req)) || '{}') })));
      if (url.pathname === '/__operator/clock' && req.method === 'POST') { clockOffsetMs = Number(JSON.parse((await body(req)) || '{}').offsetMs ?? 0); return send(200, JSON.stringify({ now: now(), offsetMs: clockOffsetMs })); }
      // S5 operator lane: run an action's due work early (no clock change, audited), the Gmail connect callback, and the
      // simulated double's inbox (labelled SIMULATED; there is no other way to put mail into it).
      if (url.pathname === '/__operator/run-action' && req.method === 'POST') return send(200, JSON.stringify(await operatorRunActionNow(deps, TENANT, JSON.parse((await body(req)) || '{}').actionId)));
      if (url.pathname === '/__operator/mail/token' && req.method === 'POST') {
        const b = JSON.parse((await body(req)) || '{}');
        await saveConnection(store, vault, gmailEnv().sender ?? '', { email: b.email, refreshToken: b.refreshToken, scopes: b.scopes, now: now() });
        return send(200, JSON.stringify({ ok: true, email: b.email }));
      }
      if (url.pathname === '/__operator/mail/status') {
        const conn = await store.get('provider', gmailPk(gmailEnv().sender ?? ''), 'CONN');
        return send(200, JSON.stringify(conn ? { email: conn.email, state: conn.state, connectedAt: conn.connectedAt, expiredAt: conn.expiredAt, scopes: conn.scopes } : { state: 'NOT_CONNECTED' }));
      }
      if (url.pathname === '/__operator/mail/inject' && req.method === 'POST') {
        if (!(deps.mail?.channel instanceof SimulatedMailbox)) return send(409, JSON.stringify({ error: 'inject is only for the simulated mailbox (MAIL_CHANNEL=simulated)' }));
        const b = JSON.parse((await body(req)) || '{}');
        const raw = buildMessage({ from: b.from, to: [deps.mail.address], subject: b.subject ?? 'Re: invoice', text: b.text ?? '', messageId: `<inj.${Date.now()}@${String(b.from).split('@')[1] ?? 'example.com'}>`, inReplyTo: b.inReplyTo ?? null, references: b.inReplyTo ? [b.inReplyTo] : [], date: now(), attachments: b.pdfBase64 ? [{ name: b.pdfName ?? 'bill.pdf', mime: 'application/pdf', bytes: Buffer.from(b.pdfBase64, 'base64') }] : [] });
        const pass = b.auth !== 'fail';
        return send(200, JSON.stringify(await deps.mail.channel.inject({ raw: b64url.encode(raw), auth: { source: 'SIMULATED', dkim: pass ? 'pass' : 'fail', spf: pass ? 'pass' : 'fail', dmarc: pass ? 'pass' : 'fail' } })));
      }
      if (url.pathname === '/__operator/mail/fault' && req.method === 'POST') {
        if (!(deps.mail?.channel instanceof SimulatedMailbox)) return send(409, JSON.stringify({ error: 'faults are only for the simulated mailbox' }));
        await deps.mail.channel.setFault(JSON.parse((await body(req)) || '{}').failNext ?? null);
        return send(200, '{"ok":true}');
      }
      if (url.pathname === '/__operator/run') return send(200, JSON.stringify(await operatorGetRun(deps, TENANT, url.searchParams.get('runId') ?? undefined)));
      if (url.pathname === '/__operator/calls') return send(200, JSON.stringify({ paypal: (await store.get('work', K.counter(grant?.id ?? '-'), 'COUNTER')) ?? {}, plaid: (await store.get('work', K.counter(grant?.id ?? '-', 'plaid'), 'COUNTER')) ?? {} }));
      return send(404, '{}');
    }
    if (isDemoPath(url.pathname)) {
      const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));
      // S7b review P3-4: the reset machine's housekeeping moves sandbox money against one merchant ledger; local shares the dev
      // PayPal app but keeps its own store, so a local Start could misjudge the merchant. Start runs on dev and review only.
      if (url.pathname === '/v1/demo/start') return send(409, JSON.stringify({ code: 'MERCHANT_LEASED', message: 'Demo Start runs on dev and review only (the local store isn’t the merchant’s ledger)' }));
      const r = await handleDemo(deps, { method: req.method!, path: url.pathname, headers, body: req.method === 'POST' ? await body(req) : undefined, identity: LOCAL_IDENTITY });
      return send(r.status, r.body, r.headers);
    }
    if (url.pathname.startsWith('/v1/')) {
      const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));
      const r = await handle({ store, queue, config: deps.config, now, plaidLink: plaid ? plaidLinkToken(plaid) : undefined, vault, evidence }, { method: req.method!, path: url.pathname, query: Object.fromEntries(url.searchParams), headers, body: req.method === 'POST' ? await body(req) : undefined, identity: url.pathname === '/v1/webhooks/paypal' ? null : LOCAL_IDENTITY });
      return send(r.status, r.body, r.headers);
    }
    if (!existsSync(DIST)) return send(404, 'web/dist not built; use the Vite dev server (npm run dev) or npm run build', { 'content-type': 'text/plain' });
    const file = join(DIST, url.pathname);
    const target = file.startsWith(DIST) && existsSync(file) && statSync(file).isFile() ? file : join(DIST, 'index.html');
    return send(200, readFileSync(target) as unknown as string, { 'content-type': TYPES[extname(target)] ?? 'application/octet-stream' });
  } catch (e) {
    console.error(e);
    send(500, '{"code":"INTERNAL"}');
  }
}).listen(PORT, '127.0.0.1', () => console.log(`Headroom local API on http://127.0.0.1:${PORT} (STAGE=local, PayPal grant ${grant ? grant.id : 'NONE: PayPal calls refused'}, model ${interpreter ? interpreter.modelId : 'NOT CONFIGURED'})`));

// Sweep + worker loop. ponytail: one in-process loop every 2 s instead of EventBridge + SQS.
let busy = false;
setInterval(async () => {
  if (busy) return;
  busy = true;
  try {
    await sweep({ store, queue, now });
    for (let id = queue.take(); id; id = queue.take()) await processJob(deps, id);
  } catch (e) { console.error('worker loop', e); } finally { busy = false; }
}, 2000);

const logCalls = async () => {
  const c = await store.get('work', K.counter(grant?.id ?? '-'), 'COUNTER');
  const p = await store.get('work', K.counter(grant?.id ?? '-', 'plaid'), 'COUNTER');
  writeFileSync(join(STATE, 'paypal-calls.json'), JSON.stringify({ at: now(), grant: grant?.id ?? null, counter: c ?? {}, plaid: p ?? {} }, null, 2));
};
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, async () => { await logCalls(); process.exit(0); });
