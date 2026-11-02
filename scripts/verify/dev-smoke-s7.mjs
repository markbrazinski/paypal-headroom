// S7a dev smoke (VERIFICATION §9.2): after a deploy, the S7a routes answer under the real API role and the hero still works.
// Operator reset of the dev hero run (sandbox PayPal invoices + seeded Plaid bank, DEV-STANDING), then from the real site (Cognito):
// Overview (safetyNotices), Delegation (13 Change controls, a preview: no write), the hero bill injected by the operator, verified and
// accepted in the UI → the plan builds by itself (O6, Nova metered) with the Keller ask as an option. Nothing is approved or sent.
//   AWS_PROFILE=headroom-admin node scripts/verify/dev-smoke-s7.mjs --base <site> --login ownerA [--out <dir>] [--no-reset]
import { chromium } from 'playwright-core';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { invokeOperator } from '../demo/operator-client.ts';

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const base = arg('--base');
const out = arg('--out', `.private/headroom/evidence/S07/dev-smoke-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const creds = JSON.parse(readFileSync('.headroom-local/dev-users.json', 'utf8'))[arg('--login', 'ownerA')];
mkdirSync(out, { recursive: true });
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` · ${detail}` : ''}`); };

if (!process.argv.includes('--no-reset')) {
  let r = await invokeOperator({ action: 'reset', tenantId: 'tenant-owner', reason: 'dev-smoke-s7', bank: 'seed' });
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

await go('/overview');
check('getOverview 200', api.some((x) => /\/v1\/overview$/.test(x.url) && x.status === 200));
await page.screenshot({ path: join(out, 'dev-1440-overview.png'), fullPage: true });
await go('/delegation');
check('getDelegation 200', api.some((x) => /\/v1\/delegation$/.test(x.url) && x.status === 200));
check('13 Change controls', (await page.getByRole('button', { name: 'Change' }).count()) === 13, String(await page.getByRole('button', { name: 'Change' }).count()));
await page.locator('[id="cash.reserveMinor"]').getByRole('button', { name: 'Change' }).click();
await page.getByLabel('Amount (USD)').fill('3500');
await page.getByRole('button', { name: 'Preview', exact: true }).click();
check('previewPolicyChange 200 (no write)', await seen(page.getByText('What this would change')));
await page.screenshot({ path: join(out, 'dev-1440-delegation-preview.png'), fullPage: true });
// The hero bill: original bytes through ingestion (Nova reads it), then verify + accept in the UI.
const { billPdf } = await import('../demo/bill-pdf.ts');
const day0 = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const inj = await invokeOperator({ action: 'injectBill', tenantId: 'tenant-owner', fileName: 'hero.pdf', contentBase64: billPdf('hero', day0).toString('base64'), reason: 'dev-smoke-s7' });
check('injectBill accepted', !!inj?.billId, JSON.stringify(inj).slice(0, 200));
let state = '';
for (let i = 0; i < 40; i++) { await page.waitForTimeout(3000); const r = await page.evaluate(async (id) => (await (await fetch(`/v1/bills/${id}`, { headers: { authorization: `Bearer ${sessionStorage.getItem('hr.idToken') ?? ''}` } })).json()).bill?.state ?? '', inj.billId).catch(() => ''); state = r; if (state && state !== 'RECEIVED') break; }
await go(`/payables?bill=${inj.billId}`);
check('bill read (PROPOSED)', await seen(page.getByRole('button', { name: /Verify bill/ }), 60_000));
await page.getByRole('button', { name: /Verify bill/ }).click();
await page.getByRole('dialog').getByRole('button', { name: /Verify/ }).last().click();
check('verified', await seen(page.getByRole('button', { name: /Accept/ }), 20_000));
await page.getByRole('button', { name: /Accept/ }).first().click();
await page.getByRole('dialog').getByRole('button', { name: /Accept/ }).last().click();
await page.waitForTimeout(3000);
check('acceptBillTerms 200', api.some((x) => x.method === 'POST' && /accept-terms$/.test(x.url) && x.status === 200));
await go('/plan');
check('plan built by itself (O6)', await seen(page.getByText(/DRAFT · NOT RUNNING/), 120_000));
check('collections in the draft (live Nova behind the gate)', await seen(page.getByText(/Pellow Dental Group/).first(), 5_000) && (await page.getByText('Not needed to close the gap').count()) === 0);
check('Keller ask listed as an option', await seen(page.getByText(/An option: add it to ask the supplier/), 10_000));
await page.screenshot({ path: join(out, 'dev-1440-plan.png'), fullPage: true });
const bad = api.filter((x) => x.status >= 500);
check('no 5xx on any API call', bad.length === 0, JSON.stringify(bad));
await browser.close();
writeFileSync(join(out, 'results.json'), JSON.stringify({ results, api }, null, 2));
const fails = results.filter((r) => !r.ok);
console.log(`\n${results.length - fails.length}/${results.length} checks passed · evidence ${out}`);
process.exit(fails.length ? 1 : 0);
