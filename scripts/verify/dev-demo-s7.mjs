// S7b dev demo-lane journey (VERIFICATION §8/§9): the operator drawer on the real site, the payer Lambda paying on PayPal's hosted page,
// and the receipt coming only from PayPal's GETs. Scenarios run in order; each picks up from the run's current state, so one can rerun alone.
//   reset    operator CLI reset of the dev hero run (sandbox invoices + seeded bank)
//   bill     Keller's bill via the drawer → verify + accept in Payables → the plan builds by itself
//   approve  approve the draft (sandbox invoices issued; mail only to the test inbox)
//   advance  drawer "Advance to next step" until a collection can be paid
//   collect  drawer "Customers pay": every asked customer pays in order, verified, 4 s apart (O7 / S7-A15); --want N in advance
//   pay      drawer "Pay on PayPal" → Paid · PayPal capture … (VERIFIED_PAID) within 4 min
//   drawer   the drawer opens and reads the run (no writes)
//   end      drawer "End my run" (release the merchant; refused while PayPal work is in flight)
//   start    (judge, review) drawer "Start a new run": lease → report wait → housekeeping payout → seeded run (waits up to --start-min, default 20)
//   AWS_PROFILE=headroom-admin node scripts/verify/dev-demo-s7.mjs --base <site> [--stage dev|review] [--login ownerA|judge1] [--only pay] [--failed <prevDir>] [--out <dir>]
import { chromium } from 'playwright-core';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { invokeOperator } from '../demo/operator-client.ts';

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const base = arg('--base');
const out = arg('--out', `.private/headroom/evidence/S07/dev-demo-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const only = arg('--only') ? arg('--only').split(',') : null;
const failedDir = arg('--failed');
const prevFailed = failedDir && existsSync(join(failedDir, 'results.json')) ? [...new Set(JSON.parse(readFileSync(join(failedDir, 'results.json'), 'utf8')).results.filter((r) => !r.ok).map((r) => r.scenario))] : null;
const stage = arg('--stage', 'dev');
const creds = JSON.parse(readFileSync(`.headroom-local/${stage}-users.json`, 'utf8'))[arg('--login', stage === 'review' ? 'judge1' : 'ownerA')];
mkdirSync(out, { recursive: true });
const results = [];
let scenario = '';
const check = (name, ok, detail = '') => { results.push({ scenario, name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} [${scenario}] ${name}${detail ? ` · ${detail}` : ''}`); return !!ok; };

const browser = await chromium.launch({ headless: true, executablePath: join(homedir(), 'Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing') });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const api = [];
page.on('response', (r) => { if (r.url().includes('/v1/')) api.push({ status: r.status(), method: r.request().method(), url: r.url().replace(/^https?:\/\/[^/]+/, '') }); });
const go = async (path) => {
  await page.goto(`${base}${path}`);
  await page.waitForFunction(() => location.host.includes('amazoncognito') || !!document.querySelector('.nav'), null, { timeout: 30_000 });
  if (page.url().includes('amazoncognito.com')) {
    await page.locator('input[name="username"]:visible').fill(creds.email);
    await page.locator('input[name="password"]:visible').fill(creds.password);
    await page.locator('input[type="submit"]:visible, button[type="submit"]:visible').first().click();
    await page.waitForURL((u) => !u.href.includes('amazoncognito.com'), { timeout: 30_000 });
    await page.goto(`${base}${path}`);
  }
  await page.locator('.nav').waitFor({ timeout: 30_000 });
  await page.waitForLoadState('networkidle').catch(() => {});
};
const seen = (loc, ms = 15_000) => loc.first().waitFor({ timeout: ms }).then(() => true, () => false);
const get = (path) => page.evaluate(async (p) => (await fetch(p, { headers: { authorization: `Bearer ${sessionStorage.getItem('hr.idToken') ?? ''}` } })).json(), path);
const drawer = () => page.locator('.demo-drawer');
const openDrawer = async () => { if (!(await drawer().count())) await page.getByRole('button', { name: 'Sandbox controls' }).click(); await drawer().getByText(/Effects log/).waitFor({ timeout: 15_000 }); };

const SCENARIOS = {
  async reset() {
    if (stage !== 'dev') return check('reset is dev-only (judges use start)', true);
    let r = await invokeOperator({ action: 'reset', tenantId: 'tenant-owner', reason: 'dev-demo-s7', bank: 'seed' });
    for (let i = 0; i < 60 && r?.state === 'PREPARING'; i++) { await new Promise((x) => setTimeout(x, 3000)); r = await invokeOperator({ action: 'getRun', tenantId: 'tenant-owner', runId: r.runId }); }
    check('dev reset ready', r?.state === 'READY', `${r?.runId} ${r?.state}`);
  },
  async drawer() {
    await go('/overview');
    check('Sandbox controls button (operator group)', await seen(page.getByRole('button', { name: 'Sandbox controls' })));
    await openDrawer();
    check('getDemoRun 200 through the demo route', api.some((x) => /\/v1\/demo\/run$/.test(x.url) && x.status === 200), api.filter((x) => x.url.includes('/demo/')).map((x) => `${x.status} ${x.url}`).join(' ').slice(0, 200));
    await page.screenshot({ path: join(out, `${stage}-1440-drawer.png`), fullPage: true });
  },
  async start() {
    await go('/overview');
    await openDrawer();
    // --tenant <id>: the operator starts that tenant's run (e.g. tenant-showcase); judges use the drawer button.
    if (arg('--tenant')) console.log('  start', await page.evaluate(async (t) => (await fetch('/v1/demo/start', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${sessionStorage.getItem('hr.idToken') ?? ''}` }, body: JSON.stringify({ tenantId: t }) })).text(), arg('--tenant')));
    else { const btn = drawer().getByRole('button', { name: 'Start a new run' }); if (await btn.isEnabled()) await btn.click(); }
    let r;
    for (let i = 0; i < Number(arg('--start-min', '20')) * 4; i++) {
      r = await get('/v1/demo/run');
      if (r.reset && ['DONE', 'BLOCKED'].includes(r.reset.state)) break;
      if (i % 4 === 0) console.log(`  … ${r.reset?.state ?? 'no reset'} ${r.reset?.waiting ?? r.startBlocked ?? ''}`);
      await page.waitForTimeout(15_000);
    }
    await page.screenshot({ path: join(out, `${stage}-1440-start.png`), fullPage: true });
    check('fresh run seeded (reset DONE, lease mine)', r?.reset?.state === 'DONE' && r?.lease?.mine, JSON.stringify({ reset: r?.reset && { state: r.reset.state, waiting: r.reset.waiting, blocker: r.reset.blocker, hk: r.reset.housekeeping, landing: r.reset.landing }, run: r?.run }).slice(0, 600));
  },
  async end() {
    await go('/overview');
    await openDrawer();
    const [resp] = await Promise.all([page.waitForResponse((r) => r.url().endsWith('/v1/demo/end'), { timeout: 30_000 }), drawer().getByRole('button', { name: 'End my run' }).click()]);
    check('End my run releases the merchant', resp.status() === 200, `${resp.status()} ${(await resp.text()).slice(0, 200)}`);
  },
  async bill() {
    await go('/payables');
    await openDrawer();
    const [resp] = await Promise.all([page.waitForResponse((r) => r.url().endsWith('/v1/demo/bill'), { timeout: 60_000 }), drawer().getByRole('button', { name: 'Bring in Keller’s bill' }).click()]);
    const b = resp.status() === 202 ? await resp.json() : null;
    if (!check('demoBill 202', !!b?.billId, `${resp.status()}`)) return;
    let state = '';
    for (let i = 0; i < 40 && b; i++) { await page.waitForTimeout(3000); state = (await get(`/v1/bills/${b.billId}`)).bill?.state ?? ''; if (state && state !== 'RECEIVED') break; }
    await go(`/payables${b ? `?bill=${b.billId}` : ''}`);
    if (!check('bill read', await seen(page.getByRole('button', { name: /Verify bill/ }), 60_000), state)) return;
    await page.getByRole('button', { name: /Verify bill/ }).click();
    await page.getByRole('dialog').getByRole('button', { name: /Verify/ }).last().click();
    await seen(page.getByRole('button', { name: /Accept/ }), 20_000);
    await page.getByRole('button', { name: /Accept/ }).first().click();
    const [acc] = await Promise.all([page.waitForResponse((r) => r.request().method() === 'POST' && /accept-terms$/.test(r.url()), { timeout: 30_000 }).catch(() => null), page.getByRole('dialog').getByRole('button', { name: /Accept/ }).last().click()]);
    if (!check('acceptBillTerms 200', acc?.status() === 200, String(acc?.status()))) return;
    await go('/plan');
    check('plan built by itself', await seen(page.getByRole('button', { name: /Approve selected actions/ }), 150_000));
  },
  async approve() {
    await go('/plan');
    const approve = page.getByRole('button', { name: /Approve selected actions/ });
    if (!check('draft present', await seen(approve, 60_000))) return;
    await approve.click();
    await page.locator('.dialog .df button', { hasText: /Approve/ }).last().click();
    check('plan running', await seen(page.getByText(/Approved by you/), 60_000));
    await page.screenshot({ path: join(out, `${stage}-1440-plan-running.png`), fullPage: true });
  },
  async advance() {
    await go('/overview');
    await openDrawer();
    for (let i = 0; i < 6; i++) {
      const run = await get('/v1/demo/run');
      if ((run.collections ?? []).filter((c) => c.canPay).length >= Number(arg('--want', '1'))) break;
      const btn = drawer().getByRole('button', { name: /Advance to next step/ });
      if (await btn.isDisabled()) { await page.waitForTimeout(10_000); continue; }
      await btn.click();
      await page.waitForTimeout(15_000);
    }
    const run = await get('/v1/demo/run');
    check(`${arg('--want', '1')}+ collections can be paid`, (run.collections ?? []).filter((c) => c.canPay).length >= Number(arg('--want', '1')), JSON.stringify((run.collections ?? []).map((c) => [c.counterparty, c.canPay, c.why])));
  },
  async collect() {
    // O7 / S7-A15: the drawer's "Customers pay" — the asked customers pay in order, each verified by PayPal's GETs, the next ≥ 4 s later.
    await go('/receivables');
    await openDrawer();
    const want = ((await get('/v1/demo/run')).collections ?? []).filter((c) => c.canPay);
    if (!check('customers to collect', want.length >= 1, want.map((c) => c.counterparty).join(', '))) return;
    await drawer().getByRole('button', { name: /Customers pay/ }).click();
    const seen = {};
    const t0 = Date.now();
    while (Date.now() - t0 < 8 * 60_000 && Object.keys(seen).length < want.length) {
      await page.waitForTimeout(3_000);
      for (const c of (await get('/v1/demo/run')).collections ?? []) if (want.some((w) => w.actionId === c.actionId) && c.attempt && !seen[c.actionId] && ['VERIFIED_PAID', 'NOT_SUBMITTED', 'REFUSED', 'VERIFIED_NOT_PAID', 'UNKNOWN_UNRESOLVED'].includes(c.attempt.phase)) seen[c.actionId] = { ...c.attempt, who: c.counterparty, t: Date.now() };
    }
    const done = Object.values(seen);
    check('every asked customer paid · verified by PayPal’s GETs', done.length === want.length && done.every((a) => a.phase === 'VERIFIED_PAID'), done.map((a) => `${a.who}: ${a.text}`).join(' | '));
    await page.screenshot({ path: join(out, `${stage}-1440-collect-drawer.png`), fullPage: true });
  },
  async pay() {
    await go('/receivables');
    await openDrawer();
    const run = await get('/v1/demo/run');
    const c = (run.collections ?? []).find((x) => x.canPay);
    if (!check('payable collection', !!c, JSON.stringify(run.collections ?? []).slice(0, 300))) return;
    const row = drawer().locator('.kv', { hasText: c.counterparty });
    const t0 = Date.now();
    await row.getByRole('button', { name: 'Pay on PayPal' }).click();
    let last;
    for (let i = 0; i < 48; i++) {
      await page.waitForTimeout(5_000);
      last = ((await get('/v1/demo/run')).collections ?? []).find((x) => x.actionId === c.actionId)?.attempt;
      if (last && ['VERIFIED_PAID', 'NOT_SUBMITTED', 'REFUSED', 'VERIFIED_NOT_PAID'].includes(last.phase)) break;
    }
    check('VERIFIED_PAID from PayPal’s GETs', last?.phase === 'VERIFIED_PAID', `${c.counterparty} ${last?.phase} · ${last?.text} · ${Math.round((Date.now() - t0) / 1000)} s`);
    await page.screenshot({ path: join(out, `${stage}-1440-paid-drawer.png`), fullPage: true });
    await go('/receivables');
    await page.screenshot({ path: join(out, `${stage}-1440-receivables-after.png`), fullPage: true });
    await go('/cash');
    check('Cash: the capture counts in the upper figure only until PayPal’s report includes it', await seen(page.getByText(/Payments after that report/), 15_000));
    await page.screenshot({ path: join(out, `${stage}-1440-cash-after.png`), fullPage: true });
  },
};

const names = Object.keys(SCENARIOS).filter((n) => (!only || only.includes(n)) && (!prevFailed || prevFailed.includes(n)));
for (const n of ['end', 'reset', 'drawer', 'start', 'bill', 'approve', 'advance', 'collect', 'pay'].filter((x) => names.includes(x))) {
  scenario = n;
  try { await SCENARIOS[n](); } catch (e) { check('threw', false, String(e.message ?? e).slice(0, 300)); await page.screenshot({ path: join(out, `dev-fail-${n}.png`), fullPage: true }).catch(() => {}); }
}
scenario = 'all';
const bad = api.filter((x) => x.status >= 500);
check('no 5xx on any API call', bad.length === 0, JSON.stringify(bad));
await browser.close();
writeFileSync(join(out, 'results.json'), JSON.stringify({ results, api }, null, 2));
const fails = results.filter((r) => !r.ok);
console.log(`\n${results.length - fails.length}/${results.length} checks passed · evidence ${out}`);
process.exit(fails.length ? 1 : 0);
