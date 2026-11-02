// S5 browser verification (VERIFICATION layers 4–5; S05 §6.11). From the real entry point on the local server (real PayPal + Plaid
// sandboxes; mail = Gmail when connected, else MAIL_CHANNEL=simulated, labelled): approve the plan → the operator runs due work early
// (audited, no state change) → Harrow's partial enabled on the SAME PayPal invoice, Pellow's reminder sent, the Mercer check visible,
// Inbox threads and controls, Reconciliation answers; screenshots at 1440×900 and 1280×800.
//   node scripts/verify/browser-s5.mjs --base http://127.0.0.1:8787 --out <dir> [--only C1,C13] [--failed <prevDir>] [--login ownerA] [--keep-run]
// --keep-run (cumulative journey, VERIFICATION §5): no reset; use the CURRENT run as S1–S4 left it (browser.mjs → browser-s3 A →
// browser-s4 J). Collection actions J removed are restored, ones Nova left out are included ("Ask anyway"), and the plan is
// re-approved only if something is waiting for approval.
// C2/C3 pay Pellow in full and Harrow's undisputed $7,200 through PayPal's hosted page (AUTOMATED-PAYER, sandbox only; the
// receipt still comes only from PayPal's invoice and capture GETs).
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { billPdf } from '../demo/bill-pdf.ts';
import { invokeOperator } from '../demo/operator-client.ts';

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const base = arg('--base', 'http://127.0.0.1:8787');
const out = arg('--out', '.headroom-local/browser-s5');
const executablePath = join(homedir(), 'Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
mkdirSync(out, { recursive: true });
const stage = arg('--stage', base.includes('127.0.0.1') ? 'local' : 'dev');
const tenant = stage === 'dev' ? 'tenant-owner' : 'tenant-local';
const loginAs = arg('--login');
const creds = loginAs ? JSON.parse(readFileSync('.headroom-local/dev-users.json', 'utf8'))[loginAs] : null;
const token = stage === 'local' ? readFileSync('.headroom-local/operator-token', 'utf8') : '';
const DEV_ACTION = { reset: 'reset', 'inject-bill': 'injectBill', 'run-action': 'runActionNow' };
/** Operator lane: the local server's routes, or the dev operator Lambda (owner IAM). */
const op = (path, body) => (stage === 'local'
  ? fetch(`${base}/__operator/${path}`, { method: 'POST', headers: { 'x-operator-token': token }, body: JSON.stringify(body) }).then((r) => r.json())
  : invokeOperator({ action: DEV_ACTION[path], tenantId: tenant, ...body }));
const getRun = (runId) => (stage === 'local' ? fetch(`${base}/__operator/run?runId=${runId}`, { headers: { 'x-operator-token': token } }).then((r) => r.json()) : invokeOperator({ action: 'getRun', tenantId: tenant, runId }));
const keepRun = process.argv.includes('--keep-run');
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

const results = [];
let current = 'setup';
/** A check that can't run here (e.g. Gmail not connected on dev: owner sign-in pending). Recorded, never counted as a pass. */
const notRun = (name, why) => { results.push({ scenario: current, name, ok: true, notRun: why, detail: `NOT RUN: ${why}` }); console.log(`NOT RUN ${name} · ${why}`); };
const check = (name, ok, detail = '') => { results.push({ scenario: current, name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` · ${detail}` : ''}`); };
const browser = await chromium.launch({ executablePath, headless: true });
const consoleErrors = [], failed = [];
const expected = (url, status) => status === 409 && /\/(approve|edit|send|hold|answer|decide)$/.test(url);
const watch = (p, w) => {
  // Tagged with the running scenario (VERIFICATION §8: errors are checked per scenario, not globally).
  p.on('console', (m) => { if (m.type() === 'error' && !/status of 409/.test(m.text())) consoleErrors.push({ scenario: current, text: `${w}: ${m.text()}` }); });
  p.on('requestfailed', (r) => failed.push({ scenario: current, text: `${w}: ${r.method()} ${r.url()} ${r.failure()?.errorText}` }));
  p.on('response', (r) => { if (r.status() >= 400 && !expected(r.url(), r.status())) failed.push({ scenario: current, text: `${w}: ${r.status()} ${r.request().method()} ${r.url()}` }); });
};
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
watch(page, 1440);
const shot = (n, p = page, w = 1440) => p.screenshot({ path: join(out, `${w}-${n}.png`), fullPage: true });
const go = async (path, p = page) => {
  await p.goto(`${base}${path}`);
  await p.waitForFunction(() => location.host.includes('amazoncognito') || !!document.querySelector('.nav'), null, { timeout: 30_000 });
  if (p.url().includes('amazoncognito.com')) {
    await p.locator('input[name="username"]:visible').fill(creds.email);
    await p.locator('input[name="password"]:visible').fill(creds.password);
    await p.locator('input[type="submit"]:visible, button[type="submit"]:visible').first().click();
    await p.waitForURL((u) => !u.href.includes('amazoncognito.com'), { timeout: 30_000 });
    await p.goto(`${base}${path}`);
  }
  await p.locator('.nav').waitFor({ timeout: 30_000 });
  await p.waitForLoadState('networkidle').catch(() => {});
};
const seen = (loc, ms = 15_000) => loc.first().waitFor({ timeout: ms }).then(() => true, () => false);
const card = (name) => page.locator('.act').filter({ hasText: name });
const actionId = async (name) => ((await card(name).first().getAttribute('id')) ?? '').replace(/^act-/, '');
const settle = (ms = 8_000) => new Promise((x) => setTimeout(x, ms));

/** Fresh run → hero bill → verify → accept (UI) → Plan → approve everything (UI). Shared by all scenarios (one reset per pass). */
let ready = false;
async function running() {
  if (ready) return true;
  if (keepRun) return (ready = await keep());
  // A business hour in New York (Tue 10:00 next week from the reset's view is not needed: contact runs are pulled forward by the operator).
  let r = await op('reset', { reason: 'browser-s5', bank: 'seed' });
  for (let i = 0; i < 100 && r?.state === 'PREPARING'; i++) { await settle(3000); r = await getRun(r.runId); }
  if (r?.state !== 'READY') { check('reset READY', false, JSON.stringify(r).slice(0, 200)); return false; }
  const inj = await op('inject-bill', { fileName: 'hero.pdf', contentBase64: billPdf('hero', today()).toString('base64'), reason: 'browser-s5' });
  await go(`/payables?bill=${inj.billId}`);
  const panel = page.locator('aside.panel');
  for (let i = 0; i < 12 && !(await seen(panel.getByRole('button', { name: 'Verify bill…' }), 8_000)); i++) await go(`/payables?bill=${inj.billId}`);
  await panel.getByRole('button', { name: 'Verify bill…' }).click();
  await page.locator('.dialog .df button', { hasText: 'Verify bill' }).click();
  await panel.getByRole('button', { name: 'Accept new date…' }).click({ timeout: 20_000 });
  await page.locator('.dialog .df button', { hasText: 'Accept new date' }).click();
  await settle(2000);
  await go('/plan');
  if (!(await seen(page.getByRole('button', { name: /Approve selected actions/ }), 120_000))) { check('draft plan built', false); return false; }
  for (const n of ['Mercer Architects · early-payment offer', 'Harrow Developments · collection', 'Pellow Dental Group · collection']) {
    const row = page.locator('.considered .box-b').filter({ hasText: n });
    if (await row.count()) { await row.getByRole('button', { name: 'Ask anyway' }).click(); await settle(1500); }
  }
  await page.getByRole('button', { name: /Approve selected actions/ }).click();
  await page.locator('.dialog .df button', { hasText: /Approve/ }).last().click();
  ready = await seen(page.getByText(/RECOVERING A GAP|GAP COVERED/), 30_000);
  check('plan approved and running', ready);
  return ready;
}

/** --keep-run: the journey run's running plan; Harrow, Pellow and Mercer back in it (Restore / Ask anyway), re-approved if needed. */
async function keep() {
  await go('/plan');
  if (!(await seen(page.locator('.act'), 60_000))) { check('keep-run: a plan on the current run', false); return false; }
  for (const n of ['Mercer Architects · early-payment offer', 'Harrow Developments · collection', 'Pellow Dental Group · collection']) {
    const row = page.locator('.considered .box-b').filter({ hasText: n });
    if (await row.count()) { await row.getByRole('button', { name: 'Ask anyway' }).click(); await settle(2000); }
  }
  for (const n of ['Offer Mercer', 'Ask Harrow', 'Ask Pellow']) {
    const restore = card(n).getByRole('button', { name: 'Restore' });
    if (await restore.count()) { await restore.first().click(); await settle(2000); }
  }
  const approve = page.getByRole('button', { name: /Approve selected actions/ });
  if (await approve.isEnabled().catch(() => false)) {
    await approve.click();
    await page.locator('.dialog .df button', { hasText: /Approve/ }).last().click();
    await settle(3000);
  }
  const ok = await seen(page.getByText(/RECOVERING A GAP|GAP COVERED/), 30_000);
  check('keep-run: plan running on the journey run with Harrow, Pellow and Mercer', ok && (await card('Ask Harrow').count()) > 0 && (await card('Ask Pellow').count()) > 0 && (await card('Offer Mercer').count()) > 0);
  await shot('keep-run-plan');
  return ok;
}

/** AUTOMATED-PAYER on the invoice's own PayPal payer link (sandbox); then "Check PayPal now". Returns the payer script's last line. */
async function payInvoice(customer, amount) {
  await go('/receivables');
  await page.locator('.ag-row').filter({ hasText: customer }).first().click();
  const panel = page.locator('aside.panel');
  const link = await panel.locator('.kv', { hasText: 'Payer link' }).locator('a').getAttribute('href', { timeout: 20_000 });
  const outLine = execFileSync(process.execPath, ['scripts/demo/pay-sandbox.mjs', '--link', link, '--out', join(out, `payer-${customer.toLowerCase()}`), ...(amount ? ['--amount', amount] : [])], { encoding: 'utf8', timeout: 300_000 }).trim().split('\n').pop();
  // PayPal's capture GET is the receipt: ask for a check now and wait for the poll to land.
  for (let i = 0; i < 12; i++) {
    await go('/receivables');
    await page.locator('.ag-row').filter({ hasText: customer }).first().click();
    const now = panel.getByRole('button', { name: 'Check PayPal now' });
    if (await now.count()) await now.click().catch(() => {});
    await settle(10_000);
    if (await panel.locator('.kv', { hasText: 'PayPal status' }).filter({ hasText: amount ? /PARTIALLY_PAID/ : /\bPAID\b/ }).count()) break;
  }
  return outLine;
}

const wanted = (() => {
  const all = ['C1', 'C13', 'C9', 'C10', 'C2', 'C3', 'C4', 'V'];
  const only = arg('--only');
  if (only) return only.split(',');
  const prev = arg('--failed');
  if (prev) return [...new Set(JSON.parse(readFileSync(join(prev, 'results.json'), 'utf8')).results.filter((r) => !r.ok).map((r) => r.scenario))];
  return all;
})();
async function scenario(name, f) {
  if (!wanted.includes(name)) return;
  current = name;
  try { if (await running()) await f(); } catch (e) { check(`${name} ran`, false, e.message.split('\n')[0]); }
  const mine = (xs) => [...new Set(xs.filter((x) => x.scenario === name || x.scenario === 'setup').map((x) => x.text))];
  check(`${name} no console errors`, mine(consoleErrors).length === 0, mine(consoleErrors).slice(0, 3).join(' | '));
  check(`${name} no failed requests`, mine(failed).length === 0, mine(failed).slice(0, 3).join(' | '));
  for (const xs of [consoleErrors, failed]) for (const x of xs) if (x.scenario === 'setup') x.scenario = `setup→${name}`;
}

// C1 (S5-A4, G-P1 app path): Harrow's partial enabled on the same real PayPal sandbox invoice; the card and invoice panel say so.
await scenario('C1', async () => {
  await go('/plan');
  const id = await actionId('Ask Harrow');
  const r = await op('run-action', { actionId: id });
  // Inside business hours the contact job has usually run on its own already; either way the result below is what counts.
  check('C1 Harrow due work ran (early by the operator, or on schedule)', r.ok || /Nothing scheduled/.test(r.error ?? ''), JSON.stringify(r));
  await settle(15_000);
  await go('/plan');
  check('C1 Harrow applied on PayPal', await seen(card('Ask Harrow').getByText(/Applied on PayPal · PayPal invoice now accepts \$7,200\.00 \(minimum\)/), 30_000));
  check('C1 executed action reads Approved by you, not Needs you', await seen(card('Ask Harrow').getByText(/Approved by you/)));
  if (await seen(card('Ask Harrow').getByText(/Not sent · Gmail is not connected/), 5_000)) {
    notRun('C1 schedule says the email was sent', 'OWNER-PENDING: Gmail not connected on this stage (npm run mail:connect -- --stage dev)');
    check('C1 Harrow message truthfully "Not sent · Gmail is not connected"', true);
  } else check('C1 schedule says the email was sent', await seen(page.locator('.mk-CONTACT', { hasText: 'Email sent' })));
  await shot('c1-plan');
  await go('/receivables');
  await page.locator('.ag-row').filter({ hasText: 'Harrow' }).first().click();
  check('C1 invoice panel shows the partial setting', await seen(page.locator('aside.panel').getByText(/accepts \$7,200\.00 minimum/)));
  check('C1 disputed shown as paused, never collected', await seen(page.locator('aside.panel').getByText(/paused · never collected/)));
  await shot('c1-invoice');
});

// C13 (S5-D19): Pellow's reminder sends; the Inbox shows it as sent on the channel actually used.
await scenario('C13', async () => {
  await go('/plan');
  await op('run-action', { actionId: await actionId('Ask Pellow') });
  await settle(10_000);
  await go('/inbox');
  const t = page.locator('.inbox-row').filter({ hasText: 'Pellow' });
  check('C13 Pellow thread present', await seen(t));
  const gmailOff = await seen(page.getByText(/Gmail is not connected|Gmail needs reconnecting|Gmail not connected/), 5_000);
  if (gmailOff) {
    notRun('C13 Pellow message SENT (channel named)', 'OWNER-PENDING: Gmail not connected on this stage (npm run mail:connect -- --stage dev)');
    await t.first().click().catch(() => {});
    check('C13 Pellow message truthfully not sent while Gmail is not connected', await seen(page.getByText(/Not sent · Gmail is not connected/), 15_000));
  } else check('C13 Pellow message SENT (channel named)', await seen(t.getByText(/SENT · (Gmail|simulated mailbox)/), 20_000));
  check('C13 channel banner', await seen(page.locator('.note').filter({ hasText: /Gmail|Simulated mailbox|not set up/ })));
  await shot('c13-inbox');
});

// C9: the thread panel: entries, take over / hand back.
await scenario('C9', async () => {
  await go('/inbox');
  await page.locator('.inbox-row').filter({ hasText: 'Pellow' }).first().click();
  const panel = page.locator('aside.panel');
  check('C9 thread panel opens', await seen(panel.getByText('Conversation')));
  await panel.getByRole('button', { name: 'Take over' }).click();
  check('C9 You handle it', await seen(panel.getByText(/You handle it/i)));
  await panel.getByRole('button', { name: 'Hand back' }).click();
  check('C9 handed back', await seen(panel.getByRole('button', { name: 'Take over' })));
  await shot('c9-thread');
});

// C10 (S5-D15): Reconciliation Yes / Change answer on the seeded PayPal transfer; a label only.
await scenario('C10', async () => {
  await go('/receivables');
  await page.getByRole('tab', { name: 'Reconciliation' }).click();
  const row = page.locator('.row').filter({ hasText: /PAYPAL/i }).first();
  check('C10 transfer candidate listed', await seen(row));
  await row.getByRole('button', { name: 'Yes, PayPal transfer' }).click();
  check('C10 answered', await seen(page.getByText(/you said yes, a PayPal transfer/)));
  await page.getByRole('button', { name: 'Change answer' }).first().click();
  check('C10 answer changed', await seen(page.getByText(/you said no, not a transfer/)));
  await shot('c10-reconciliation');
});

// C2 (S5-A1): Pellow pays in full on PayPal's hosted page → receipt (with PayPal's fee) → Pellow's action COMPLETED.
await scenario('C2', async () => {
  const r = await payInvoice('Pellow');
  check('C2 hosted payment made (AUTOMATED-PAYER)', /PAID|ALREADY_PAID/.test(r ?? ''), r);
  const panel = page.locator('aside.panel');
  check('C2 PayPal status PAID in the invoice panel', await seen(panel.locator('.kv', { hasText: 'PayPal status' }).filter({ hasText: /\bPAID\b/ }), 30_000));
  await shot('c2-invoice');
  await go('/plan');
  check('C2 Pellow collection Completed on the plan', await seen(card('Ask Pellow').getByText(/Completed/), 60_000));
  await shot('c2-plan');
});

// C3 (S5-A2/A4): Harrow pays the undisputed $7,200 on the SAME PayPal invoice → PARTIALLY_PAID; the disputed $1,800 stays open, paused.
await scenario('C3', async () => {
  const r = await payInvoice('Harrow', '7200.00');
  check('C3 hosted partial payment of $7,200 made (AUTOMATED-PAYER)', /PAID/.test(r ?? ''), r);
  const panel = page.locator('aside.panel');
  check('C3 PayPal status PARTIALLY_PAID', await seen(panel.locator('.kv', { hasText: 'PayPal status' }).filter({ hasText: /PARTIALLY_PAID/ }), 30_000));
  check('C3 PayPal shows $1,800.00 due', await seen(panel.locator('.kv', { hasText: 'PayPal shows due' }).filter({ hasText: '$1,800.00' })));
  check('C3 disputed $1,800.00 paused, never collected', await seen(panel.getByText(/\$1,800\.00 · paused · never collected/)));
  await shot('c3-invoice');
  await go('/plan');
  check('C3 Harrow slice Completed on the plan', await seen(card('Ask Harrow').getByText(/Completed/), 60_000));
  await shot('c3-plan');
});

// C4: the Mercer check runs early (operator); the card shows the recorded calculation, whatever the merchant balance decides.
await scenario('C4', async () => {
  await go('/plan');
  await op('run-action', { actionId: await actionId('Offer Mercer') });
  // dev: run 2 of the check comes on the next sweep (every minute) after the bank read; poll up to ~4 minutes.
  let recorded = false;
  for (let i = 0; i < 12 && !recorded; i++) { await settle(20_000); await go('/plan'); recorded = await seen(card('Offer Mercer').locator('details.check summary', { hasText: 'Fallback check' }), 5_000); }
  check('C4 check recorded on the card', recorded);
  check('C4 run early by the operator', await seen(card('Offer Mercer').getByText(/run early by the operator/)));
  await shot('c4-mercer');
});

await scenario('V', async () => {
  const p = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  watch(p, 1280);
  for (const [n, r] of [['plan', '/plan'], ['inbox', '/inbox'], ['receivables', '/receivables'], ['overview', '/overview']]) { await go(r, p); await p.waitForTimeout(1500); await shot(`v-${n}`, p, 1280); await go(r); await shot(`v-${n}`); }
  check('V screenshots captured', true);
  await p.close();
});

await browser.close();
const bad = results.filter((r) => !r.ok);
writeFileSync(join(out, 'results.json'), JSON.stringify({ at: new Date().toISOString(), base, keepRun, scenarios: wanted, results, consoleErrors, failed }, null, 2));
console.log(`${results.filter((r) => r.ok && !r.notRun).length}/${results.length} PASS · ${results.filter((r) => r.notRun).length} NOT RUN${bad.length ? ` · rerun just these: node scripts/verify/browser-s5.mjs --base ${base} --out <newDir> --failed ${out}` : ''}`);
process.exit(bad.length ? 1 : 0);
