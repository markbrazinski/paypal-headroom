// S6 browser verification (VERIFICATION layers 4–5; S06 §6.18). Five named scenarios against the labelled REPLAY server
// (scripts/verify/s6-replay-server.ts: real router + acceptance harness + fake PayPal): rendering and controls, never a payment.
// Screenshots for the visual comparison are taken in the same pass at 1440×900 and 1280×800.
//   node scripts/verify/browser-s6.mjs [--base http://127.0.0.1:8796] [--out <dir>] [--only B1,B3] [--failed <prevDir>]
import { chromium } from 'playwright-core';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const base = arg('--base', 'http://127.0.0.1:8796');
const out = arg('--out', `.private/headroom/evidence/S06/browser-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const only = arg('--only') ? arg('--only').split(',') : null;
const failedDir = arg('--failed');
const prevFailed = failedDir && existsSync(join(failedDir, 'results.json')) ? [...new Set(JSON.parse(readFileSync(join(failedDir, 'results.json'), 'utf8')).filter((r) => !r.ok).map((r) => r.scenario))] : null;
const RECEIVER = 'keller-pay@supplier.example.com'; // the harness's synthetic sandbox receiver (tests/acceptance/harness.ts)
mkdirSync(out, { recursive: true });
// CHROMIUM_PATH overrides; else the pinned local build if present; else Playwright's own (`npx playwright-core install chromium`).
const pinned = join(homedir(), 'Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
const executablePath = process.env.CHROMIUM_PATH ?? (existsSync(pinned) ? pinned : undefined);

const results = [];
let current = 'setup';
const check = (name, ok, detail = '') => { results.push({ scenario: current, name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${current} ${name}${detail ? ` · ${detail}` : ''}`); };
const scenario = (name) => fetch(`${base}/__replay/scenario`, { method: 'POST', body: JSON.stringify({ name }) }).then((r) => r.json());
const browser = await chromium.launch({ executablePath, headless: true });
const errors = [];

async function pageAt(w, h) {
  const p = await browser.newPage({ viewport: { width: w, height: h } });
  p.on('console', (m) => { if (m.type() === 'error' && !/status of 409/.test(m.text())) errors.push({ scenario: current, text: `${w}: ${m.text()}` }); });
  p.on('response', (r) => { if (r.status() >= 400 && r.status() !== 409) errors.push({ scenario: current, text: `${w}: ${r.status()} ${r.request().method()} ${r.url()}` }); });
  return p;
}
const shot = (p, n, w) => p.screenshot({ path: join(out, `REPLAY-${w}-${n}.png`), fullPage: true });
const go = async (p, path) => { await p.goto(`${base}${path}`); await p.locator('.nav').waitFor({ timeout: 20_000 }); await p.waitForLoadState('networkidle').catch(() => {}); };
const seen = (loc, ms = 8_000) => loc.first().waitFor({ timeout: ms }).then(() => true, () => false);
const KELLER = 'occ#cmt-keller-ms2#0';
const openKeller = async (p) => { await go(p, `/payables?payout=${encodeURIComponent(KELLER)}`); return seen(p.getByText('Payment readiness', { exact: false })); };

const SCENARIOS = {
  /** B1 Payment plan grid: permission, status pill, footer, views (UI-AP-01/02). */
  async B1(p) {
    await scenario('held');
    await go(p, '/payables');
    const row = p.locator('.ag-row, tr').filter({ hasText: 'Keller' });
    check('grid row shows permission', await seen(row.getByText(/Approved by you · revision 1/)));
    check('grid row shows status', await seen(row.getByText(/Held|PayPal balance/i)));
    check('footer: paid only when PayPal confirms the supplier payment', await seen(p.getByText(/counts a bill as paid only when PayPal confirms the payment/)));
    check('no "doesn\'t pay suppliers" text', (await p.getByText(/doesn't pay suppliers/).count()) === 0);
    await shot(p, 'payables-plan-held', 1440);
    for (const v of ['Held or paused', 'Needs approval', 'All obligations']) {
      const c = p.getByText(v, { exact: true }).first();
      if (await seen(c, 3000)) { await c.click(); await p.waitForTimeout(300); }
      check(`view "${v}" present and clickable`, await seen(c, 1000));
    }
  },
  /** B2 Keller panel rail FAIL before collections; confirm payee by typed address (UI-AP-03, R9). */
  async B2(p) {
    await scenario('held');
    check('panel opens from ?payout=', await openKeller(p));
    check('rail FAIL with bank-can\'t-fund text', await seen(p.getByText(/can't fund PayPal payouts/)));
    check('company line shown separately', await seen(p.getByText(/Company/)));
    check('no "Copy payment details"', (await p.getByText(/Copy payment details/).count()) === 0);
    await shot(p, 'keller-held', 1440);
    await scenario('unconfirmed');
    await openKeller(p);
    const open = p.getByRole('button', { name: /Confirm .*PayPal address/ });
    check('confirm-address control', await seen(open));
    await open.first().click();
    const input = p.locator('input[type="text"], input[type="email"]').last();
    await input.fill('keller-pay@supplier.example.co');
    await p.getByRole('button', { name: /^Confirm address$/ }).last().click();
    check('near miss refused, nothing changed', await seen(p.getByText(/doesn't match the address/)));
    await p.getByRole('button', { name: /Show full address/ }).first().click().catch(() => {});
    check('reveal shows the exact address', await seen(p.getByText(RECEIVER)));
    await shot(p, 'confirm-payee-dialog', 1440);
    await input.fill(RECEIVER);
    await p.getByRole('button', { name: /^Confirm address$/ }).last().click();
    check('exact address confirms', await seen(p.getByText(/confirmed by you|Confirmed:/)));
  },
  /** B3 Paid: timeline with ids and fee, in PayPal's report; Payables PAID; Reconciliation tab; Cash payout line (UI-AP-06/15, UI-CA-01). */
  async B3(p) {
    await scenario('paid');
    await openKeller(p);
    check('PAID only when PayPal confirmed the supplier payment', await seen(p.getByText(/Paid/).first()) && await seen(p.getByText(/Paid \$[\d,.]+ through PayPal/)));
    check('no fee shown in the payout panel (owner, 2 Nov 2026)', (await p.locator('aside, .panel, .drawer').getByText(/\bfee\b/i).count()) === 0);
    check('in PayPal\'s report', await seen(p.getByText(/In PayPal's report/)));
    await shot(p, 'keller-paid', 1440);
    await go(p, '/payables');
    const tab = p.getByText('Reconciliation', { exact: false }).first();
    await tab.click();
    check('reconciliation lists the payout', await seen(p.getByText(/In PayPal's report|awaiting PayPal's report/)));
    await shot(p, 'payables-reconciliation', 1440);
    await go(p, '/cash');
    await p.getByText('Show each payment').first().click().catch(() => {});
    check('cash shows the supplier payout line', await seen(p.getByText(/Supplier payout/)));
    await shot(p, 'cash-after-paid', 1440);
  },
  /** B4 Pause payments on Delegation → Keller reads PAUSED; resume → not paused (UI-AP-03 B9-pause, UI-DL-01). */
  async B4(p) {
    await scenario('held');
    await go(p, '/delegation');
    await p.getByRole('switch', { name: 'Pause all payment preparation' }).click();
    await p.getByRole('button', { name: /^Pause$/ }).last().click();
    check('payments switch on', await seen(p.getByRole('switch', { name: 'Pause all payment preparation', checked: true })));
    await openKeller(p);
    check('Keller reads PAUSED', await seen(p.getByText(/Paused · payments are paused|payments are paused/i)));
    await shot(p, 'keller-paused', 1440);
    await go(p, '/delegation');
    await p.getByRole('switch', { name: 'Pause all payment preparation' }).click();
    await p.getByRole('button', { name: /^Resume$/ }).last().click();
    check('resumed', await seen(p.getByRole('switch', { name: 'Pause all payment preparation', checked: false })));
  },
  /** B5 failure states: UNKNOWN (no retry button), UNCLAIMED recovery, 422 refused, waiting for report (UI-AP-06, AT-F08, IC-4). */
  async B5(p) {
    await scenario('unknown');
    await openKeller(p);
    check('UNKNOWN: checking with PayPal', await seen(p.getByText(/Checking with PayPal/)));
    check('no retry button', (await p.getByRole('button', { name: /retry/i }).count()) === 0);
    await shot(p, 'keller-unknown', 1440);
    await scenario('unclaimed');
    await openKeller(p);
    check('UNCLAIMED: not paid + recovery', await seen(p.getByText(/hasn't claimed it/)));
    await shot(p, 'keller-unclaimed', 1440);
    await scenario('rejected');
    await openKeller(p);
    check('422: PayPal refused', await seen(p.getByText(/PayPal refused/)));
    await shot(p, 'keller-rejected', 1440);
    await scenario('waiting');
    await openKeller(p);
    check('waiting for PayPal\'s report', await seen(p.getByText(/Waiting for PayPal's report/)));
    await shot(p, 'keller-waiting', 1440);
  },
};

const names = Object.keys(SCENARIOS).filter((n) => (!only || only.includes(n)) && (!prevFailed || prevFailed.includes(n)));
const p1440 = await pageAt(1440, 900);
for (const n of names) {
  current = n;
  try { await SCENARIOS[n](p1440); } catch (e) { check('scenario ran', false, String(e).slice(0, 300)); }
  const errs = errors.filter((e) => e.scenario === n);
  check('no console errors or failed requests', errs.length === 0, errs.map((e) => e.text).join(' | ').slice(0, 400));
}
// 1280×800 visual set (layer 5): the same key screens at the second baseline viewport.
if (!only || only.includes('V')) {
  current = 'V';
  const p = await pageAt(1280, 800);
  for (const [sc, path, n] of [['held', '/payables', 'payables-plan-held'], ['held', `/payables?payout=${encodeURIComponent(KELLER)}`, 'keller-held'], ['paid', `/payables?payout=${encodeURIComponent(KELLER)}`, 'keller-paid']]) {
    await scenario(sc); await go(p, path); await p.waitForTimeout(500); await shot(p, n, 1280);
  }
  check('1280 set captured', true);
}
await browser.close();
writeFileSync(join(out, 'results.json'), JSON.stringify(results, null, 2));
const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} checks passed · evidence ${out}${bad.length ? `\nrerun: node scripts/verify/browser-s6.mjs --failed ${out}` : ''}`);
process.exit(bad.length ? 1 : 0);
