// EXPERIMENTAL golden run (owner, 3 Nov 2026): records the hero journey once, step by step, so the web app can replay it at
// `?demo=1` with no server and no PayPal (web/src/api/golden.ts). The real router and domain code produce every response, on the
// acceptance harness with its recorded-sandbox fakes and real Nova on Bedrock (AWS_PROFILE); a headless browser crawls each screen so exactly what the UI asks for is saved.
//   npm run build -w web && node scripts/demo/golden-record.ts          → web/public/golden/{index,step-N}.json
// Roll back: delete this file, web/public/golden/, web/src/api/golden.ts and the `golden` lines in web/src/api/client.ts + auth.ts.
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { harness, OWNER } from '../../tests/acceptance/harness.ts';
import { apiScoped } from '../../tests/acceptance/api-scope.ts';
import { amt, check, FEES, MON_10AM, pay, report, lagReport, WED_0900, items, type H } from '../../tests/acceptance/s5-helpers.ts';
import { handle } from '../../backend/src/handlers/router.ts';
import { bedrockInterpreter, bedrockRole, DRAFTER_PROMPT, PLANNER_PROMPT } from '../../backend/src/adapters/bedrock/converse.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const DIST = join(ROOT, 'web/dist');
const OUT = join(ROOT, 'web/public/golden');
const PORT = 8811;
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
if (!existsSync(join(DIST, 'index.html'))) throw new Error('Build the web app first: npm run build -w web');

let h!: H;
const posts: Record<string, { status: number; body: unknown; to: number | null }> = {};
/** The router as the API Lambda runs it, with query strings (the harness helper drops them). */
async function api(method: string, path: string, query: Record<string, string> = {}, body?: unknown, headers: Record<string, string> = {}) {
  const r = await handle({ store: apiScoped(h.store), queue: h.queue, config: h.deps.config, now: h.clock, evidence: h.evidence, plaidLink: h.plaid.linkToken, vault: h.vault } as never,
    { method, path, query, headers: { ...(method === 'POST' ? { 'idempotency-key': crypto.randomUUID() } : {}), ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body), identity: OWNER });
  if (method === 'POST') await h.drain();
  return { status: r.status, body: JSON.parse(r.body) };
}
/** A POST the owner makes in the UI; playback answers it with this response and moves to step `to`. */
async function ownerPost(path: string, body: unknown, headers: Record<string, string>, to: number) {
  const r = await api('POST', path, {}, body, headers);
  if (r.status >= 300) throw new Error(`${path} → ${r.status} ${JSON.stringify(r.body)}`);
  posts[`POST ${path}`] = { ...r, to };
}
const bill = async () => { const id = (await items(h, 'BILL#'))[0].billId; return (await api('GET', `/v1/bills/${id}`)).body; };
const caps: { cap: string; gross: number; fee: number; number: string }[] = [];

/** Each step: how playback reaches it (`key` = the presenter's off-camera key; `post` = the owner's own click) and what it does. */
const STEPS: { name: string; trigger: 'start' | 'key' | 'post'; run: (i: number) => Promise<void> }[] = [
  { name: 'Healthy-looking cash', trigger: 'start', run: async () => {
    h = await harness({ plaid: true, hero: true, paypalMinor: 180_000, start: MON_10AM, mail: { redirectTo: null }, bills: 'AUTO', // the demo business's bill rule
      // Real Nova on Bedrock (owner, 4 Nov 2026), as the worker composes it: it reads Keller's bill, chooses and explains the plan, writes the greetings.
      interpreter: bedrockInterpreter(), planner: bedrockRole(PLANNER_PROMPT, 'candidates'), drafter: bedrockRole(DRAFTER_PROMPT, 'drafts') });
    h.pp.rows = [{ transaction_id: 'BASELINE-1', transaction_event_code: 'T0000', transaction_status: 'S', transaction_initiation_date: '2026-11-08T12:00:00Z', transaction_amount: amt(180_000), available_balance: amt(180_000) }];
    await api('POST', '/v1/cash/paypal/refresh'); } },
  // The bill arrives through normal ingestion; the business's rule verifies it and accepts its earlier date; the plan builds by itself.
  { name: 'Keller’s bill arrives · verified by rule · plan built', trigger: 'key', run: async () => { h.setNow('2026-11-09T15:20:00.000Z'); await h.inject('hero'); const b = await bill(); if (b.bill.state !== 'TERMS_ACCEPTED') throw new Error(`bill ${b.bill.state}`); } },
  { name: 'Plan approved', trigger: 'post', run: async (i) => { const rev = (await api('GET', '/v1/plan')).body.revision; await ownerPost(`/v1/plan/revisions/${rev.revisionId}/approve`, { selected: rev.approval.selected, consentHash: rev.approval.consentHash }, { 'if-match': String(rev.version) }, i); } },
  { name: 'Headroom asks', trigger: 'key', run: async () => { h.setNow('2026-11-10T13:05:00.000Z'); await h.drain(); } },
  { name: 'Pellow pays', trigger: 'key', run: async () => { h.setNow('2026-11-10T15:00:00.000Z'); const p = await pay(h, 'cust-pellow', 760_000, FEES.pellow); caps.push({ cap: p.cap, gross: 760_000, fee: FEES.pellow, number: p.inv.invoiceNumber }); } },
  { name: 'Harrow pays', trigger: 'key', run: async () => { h.setNow('2026-11-10T17:30:00.000Z'); const r = await pay(h, 'cust-harrow', 720_000, FEES.harrow); caps.push({ cap: r.cap, gross: 720_000, fee: FEES.harrow, number: r.inv.invoiceNumber }); } },
  { name: 'Mercer check · offer skipped', trigger: 'key', run: async () => {
    h.setNow('2026-11-11T13:50:00.000Z'); await report(h, caps); lagReport(h, 5 * 60_000); await api('POST', '/v1/cash/paypal/refresh');
    h.setNow(WED_0900); lagReport(h, 5 * 60_000); const { a } = await check(h); if (a.state !== 'SKIPPED_NOT_NEEDED') throw new Error(`Mercer ${a.state}`); } },
  { name: 'Keller paid', trigger: 'key', run: async () => {
    h.setNow('2026-11-13T13:55:00.000Z'); lagReport(h, 5 * 60_000); h.pp.payoutFloat = caps.reduce((t, c) => t + c.gross - c.fee, 0);
    await api('POST', '/v1/cash/paypal/refresh'); h.setNow('2026-11-13T14:00:00.000Z'); lagReport(h, 5 * 60_000);
    await h.drain(); await h.advance(20_000); for (let i = 0; i < 4; i++) await h.advance(30_000);
    const [b] = [...h.pp.payouts.keys()]; if (!b) throw new Error('no payout'); h.pp.reportPayout(b, { at: '2026-11-13T14:05:00+0000' });
    h.setNow('2026-11-13T16:10:00.000Z'); h.pp.balance = { ...h.pp.balance, asOf: '2026-11-13T16:00:00.000Z' }; await api('POST', '/v1/cash/paypal/refresh'); } },
];

// The recording server: the built app plus the router (GET only from the crawler; it never posts).
const body = (req: import('node:http').IncomingMessage) => new Promise<string>((ok) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => ok(b)); });
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  if (url.pathname.startsWith('/v1/')) {
    if (req.method !== 'GET') { await body(req); res.writeHead(409, { 'content-type': 'application/json' }); return res.end('{"code":"RECORDING","message":"read-only while recording"}'); }
    const r = await api('GET', url.pathname, Object.fromEntries(url.searchParams));
    res.writeHead(r.status, { 'content-type': 'application/json' }); return res.end(JSON.stringify(r.body));
  }
  const file = join(DIST, url.pathname);
  const target = file.startsWith(DIST) && existsSync(file) && statSync(file).isFile() ? file : join(DIST, 'index.html');
  res.writeHead(200, { 'content-type': TYPES[extname(target)] ?? 'application/octet-stream' }); res.end(readFileSync(target));
});
await new Promise<void>((ok) => server.listen(PORT, '127.0.0.1', ok));

const require = createRequire(join(ROOT, 'package.json'));
const { chromium } = require('playwright-core');
const browser = await chromium.launch({ executablePath: join(homedir(), 'Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'), headless: true });

/** Fixed waits: the shell polls every 2 s, so the network never goes idle. Visit every screen and panel the presenter or a judge can open; keep every GET response the UI made. */
async function crawl(): Promise<Record<string, unknown>> {
  const gets: Record<string, unknown> = {};
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const pending: Promise<void>[] = [];
  page.on('response', (r: any) => { const u = new URL(r.url()); if (u.pathname.startsWith('/v1/') && r.request().method() === 'GET') pending.push(r.json().then((j: unknown) => { gets[u.pathname + u.search] = { status: r.status(), body: j }; }, () => {})); });
  const go = async (path: string) => { await page.goto(`http://127.0.0.1:${PORT}${path}`); await page.locator('.nav').waitFor({ timeout: 20_000 }).catch(() => {}); await page.waitForTimeout(700); };
  const clickAll = async (role: string, name: RegExp) => { for (const b of await page.getByRole(role as never, { name }).all()) { await b.click().catch(() => {}); await page.waitForTimeout(700); } };
  for (const r of ['/overview', '/inbox', '/plan', '/cash', '/receivables', '/payables', '/relationships', '/delegation']) await go(r);
  await go('/overview'); await page.getByText('Activity', { exact: true }).first().click().catch(() => {}); await page.waitForTimeout(700);
  await go('/cash'); await clickAll('button', /^(Ideal|Downside|Expected|Timeline|Chart|Calendar)$/);
  for (const o of await page.locator('select option').all()) { const v = await o.getAttribute('value'); if (v) { await page.locator('select').first().selectOption(v).catch(() => {}); await page.waitForTimeout(700); } }
  await go('/plan'); await clickAll('button', /^Revision \d+$/); await clickAll('tab', /Outlook/);
  for (const b of await items(h, 'BILL#')) await go(`/payables?bill=${b.billId}`);
  for (const i of await items(h, 'INV#')) await go(`/receivables?invoice=${i.invoiceId}`);
  for (const id of ['cust-pellow', 'cust-harrow', 'cust-mercer', 'sup-keller']) await go(`/relationships?id=${id}`);
  await Promise.all(pending);
  await page.close();
  return gets;
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const index = { recorded: new Date().toISOString(), note: 'Headroom golden run: the hero journey recorded on the acceptance harness (recorded sandbox behaviour) with real Nova on Bedrock reading the bill, choosing the plan and writing the greetings. Replayed at ?demo=1.', steps: [] as { name: string; trigger: string; now: string }[], posts };
for (const [i, s] of STEPS.entries()) {
  await s.run(i);
  const gets = await crawl();
  index.steps.push({ name: s.name, trigger: s.trigger, now: h.clock() });
  writeFileSync(join(OUT, `step-${i}.json`), JSON.stringify({ name: s.name, now: h.clock(), gets }));
  console.log(`step ${i} · ${s.name} · ${Object.keys(gets).length} screens' data`);
}
writeFileSync(join(OUT, 'index.json'), JSON.stringify(index, null, 1));
await browser.close();
server.close();
