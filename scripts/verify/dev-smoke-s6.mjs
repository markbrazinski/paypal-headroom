// S6 dev smoke (VERIFICATION §9.2): after a deploy, every new or changed route answers under the real API role.
// Operator reset of the dev hero run (sandbox PayPal invoices + seeded Plaid bank, DEV-STANDING), then from the real site (Cognito):
// Payables (listPayables), the Keller panel (getPayout), Show full address (revealPayee) and Confirm address (confirmPayee).
//   AWS_PROFILE=headroom-admin node scripts/verify/dev-smoke-s6.mjs --base <site> --login ownerA [--out <dir>] [--no-reset]
import { chromium } from 'playwright-core';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { invokeOperator } from '../demo/operator-client.ts';

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const base = arg('--base');
const out = arg('--out', `.private/headroom/evidence/S06/dev-smoke-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const creds = JSON.parse(readFileSync('.headroom-local/dev-users.json', 'utf8'))[arg('--login', 'ownerA')];
mkdirSync(out, { recursive: true });
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` · ${detail}` : ''}`); };

if (!process.argv.includes('--no-reset')) {
  let r = await invokeOperator({ action: 'reset', tenantId: 'tenant-owner', reason: 'dev-smoke-s6', bank: 'seed' });
  for (let i = 0; i < 60 && r?.state === 'PREPARING'; i++) { await new Promise((x) => setTimeout(x, 3000)); r = await invokeOperator({ action: 'getRun', tenantId: 'tenant-owner', runId: r.runId }); }
  check('dev reset ready', r?.state === 'READY', `${r?.runId} ${r?.state} ${JSON.stringify(r?.blockers ?? [])}`);
}
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
await go(`/payables?payout=${encodeURIComponent('occ#cmt-keller-ms2#0')}`);
check('listPayables 200', api.some((x) => x.method === 'GET' && /\/v1\/payables$/.test(x.url) && x.status === 200));
if (!(await seen(page.getByText('Payment readiness', { exact: false }).or(page.getByText(/Confirm .*PayPal address/i)), 5000))) await page.locator('.ag-row').filter({ hasText: 'Keller' }).first().click();
await page.waitForTimeout(2500);
check('getPayout 200', api.some((x) => /\/v1\/payables\/payouts\//.test(x.url) && x.status === 200), JSON.stringify(api.filter((x) => /payouts/.test(x.url))));
check('Keller panel renders', await seen(page.getByText(/Payment readiness|Confirm .*PayPal address/i)));
await page.screenshot({ path: join(out, 'dev-1440-keller.png'), fullPage: true });
const open = page.getByRole('button', { name: /Confirm .*PayPal address/ });
if (await seen(open, 8000)) {
  await open.first().click();
  await page.getByRole('button', { name: /Show full address/ }).first().click();
  await page.waitForTimeout(1500);
  check('revealPayee 200', api.some((x) => /\/reveal$/.test(x.url) && x.status === 200));
  const addr = await page.locator('.mono, code').filter({ hasText: '@' }).first().innerText().catch(() => '');
  await page.locator('input[type="text"], input[type="email"]').last().fill(addr.trim());
  await page.getByRole('button', { name: /^Confirm address$/ }).last().click();
  await page.waitForTimeout(2500);
  check('confirmPayee 200', api.some((x) => x.method === 'POST' && /\/confirm$/.test(x.url) && x.status === 200), addr ? 'exact address typed from the reveal' : 'reveal text not found');
} else check('confirm control (payee already confirmed?)', false);
const bad = api.filter((x) => x.status >= 400 && x.status !== 409);
check('no failed API calls', bad.length === 0, JSON.stringify(bad).slice(0, 400));
await browser.close();
writeFileSync(join(out, 'results.json'), JSON.stringify({ results, api }, null, 2));
console.log(`${results.filter((r) => r.ok).length}/${results.length} · ${out}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
