// Browser verification (VERIFICATION layers 4–5): drives the real entry point, exercises S1 controls,
// records console errors and failed requests, and captures screenshots at the baseline viewports.
//   node scripts/verify/browser.mjs --base http://127.0.0.1:8787 --out <dir> [--issue] [--wait-payment]
// --issue creates a real PayPal sandbox invoice (PP-S2). --wait-payment pauses for a human payer.
// --bank (S2, after `demo:reset --bank seed`): seeded bank figures → Disconnect → Connect through the real Plaid Link
// iframe (sandbox user_good) → login broken by the test harness → Reconnect through Link update mode → healthy.
// --stage local|dev tells the harness where the store is (for the login break).
import { chromium } from 'playwright-core';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const base = arg('--base', 'http://127.0.0.1:8787');
const out = arg('--out', '.headroom-local/browser');
const issue = process.argv.includes('--issue');
const autoPay = process.argv.includes('--auto-pay'); // AUTOMATED-PAYER (OPEN-GATES OD-AUTO-PAY)
const waitPayment = process.argv.includes('--wait-payment') || autoPay;
// --login ownerA: sign in through Cognito managed login with credentials from .headroom-local/dev-users.json (never printed).
const loginAs = arg('--login');
const bankFlow = process.argv.includes('--bank');
const stage = arg('--stage', base.includes('127.0.0.1') || base.includes('localhost') ? 'local' : 'dev');
const creds = loginAs ? JSON.parse(readFileSync('.headroom-local/dev-users.json', 'utf8'))[loginAs] : null;
async function signInIfAsked(page) {
  if (!page.url().includes('amazoncognito.com')) return;
  if (!creds) throw new Error('Cognito login page shown; pass --login ownerA');
  await page.locator('input[name="username"]:visible').fill(creds.email);
  await page.locator('input[name="password"]:visible').fill(creds.password);
  await page.locator('input[type="submit"]:visible, button[type="submit"]:visible').first().click();
  await page.waitForURL((u) => !u.href.includes('amazoncognito.com'), { timeout: 30_000 });
}
const executablePath = arg('--chrome', join(homedir(), 'Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'));
mkdirSync(out, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` · ${detail}` : ''}`); };
const browser = await chromium.launch({ executablePath, headless: true });
const consoleErrors = [];
const failed = [];
const httpErrors = [];

for (const [w, h] of [[1440, 900], [1280, 800]]) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  // Cognito's own hosted page 404s on its favicon (outside Headroom). The create-dialog checks provoke two deliberate 400 validation responses; Chromium logs those as console errors.
  page.on('console', (m) => { if (m.type() === 'error' && !/status of 400/.test(m.text()) && !/amazoncognito\.com\/favicon\.ico/.test(m.location()?.url ?? '')) consoleErrors.push(`${w}: ${m.text()} @ ${m.location()?.url ?? "?"}`); });
  page.on('requestfailed', (r) => failed.push(`${w}: ${r.method()} ${r.url()} ${r.failure()?.errorText}`));
  page.on('response', (r) => { if (r.status() >= 400) httpErrors.push(`${w}: ${r.status()} ${r.request().method()} ${r.url()}`); });
  page.on('response', (r) => { if (r.status() >= 500 || (r.url().includes('/v1/') && r.status() >= 400 && r.request().method() === 'GET')) failed.push(`${w}: ${r.status()} ${r.url()}`); });
  const shot = (n) => page.screenshot({ path: join(out, `${w}-${n}.png`), fullPage: true });

  await page.goto(`${base}/overview`);
  // The SPA polls its session every 5 s while watching, so the network never idles: wait for the sign-in page or the app.
  await page.waitForFunction(() => location.host.includes('amazoncognito') || document.body.innerText.includes('Cash now'), null, { timeout: 30_000 });
  if (creds) check(`${w} unauthenticated visit lands on Cognito sign-in`, page.url().includes('amazoncognito.com'));
  await signInIfAsked(page);
  await page.getByText('Cash now', { exact: false }).first().waitFor();
  await page.waitForTimeout(600);
  check(`${w} overview strip renders four tiles`, (await page.locator('.strip .tile').count()) === 4);
  check(`${w} cash now shows PayPal as-of, not "synced"`, await page.getByText(/PayPal as of/).first().isVisible() && !(await page.getByText(/synced/i).count()));
  await shot('01-overview');

  await page.locator('.strip .tile').first().click();
  await page.getByRole('complementary', { name: 'Cash now' }).waitFor();
  await page.getByText(/Reserve met now|Below your reserve now|Reserve right now/).first().waitFor();
  check(`${w} cash now panel opens with reserve line and badge`, await page.getByText(/Reserve met now|Below your reserve now|Reserve right now/).first().isVisible() && await page.getByText(/Your reserve \(kept aside\)/).isVisible());
  await shot('02-cash-now-panel');
  if (w === 1440) {
    await page.getByRole('button', { name: 'Refresh PayPal' }).click();
    await page.getByText(/Reading PayPal balance/).waitFor();
    check('refresh queues a PayPal read (toast)', true);
  }
  await page.getByRole('button', { name: 'Close panel' }).click();
  await page.getByRole('tab', { name: 'Activity' }).click();
  await page.locator('.ag-row').first().waitFor();
  check(`${w} activity grid has rows`, (await page.locator('.ag-row').count()) > 0);
  await shot('09-activity');

  await page.getByRole('link', { name: 'Receivables' }).click();
  await page.getByRole('tab', { name: /Invoices/ }).waitFor();
  await page.waitForTimeout(400);
  await shot('23-ar-invoices');
  await page.getByRole('tab', { name: /Incoming/ }).click();
  await shot('25-ar-incoming');
  await page.getByRole('tab', { name: /Invoices/ }).click();

  // Built in S3 (Inbox, Payables) and S4 (Plan, Customers & Suppliers, Delegation): the page renders and is no longer a placeholder
  // (their own checks live in browser-s3.mjs / browser-s4.mjs).
  for (const [route, h1] of [['Inbox', 'Inbox'], ['Payables', 'Payables'], ['Plan', 'Plan'], ['Customers & Suppliers', 'Customers & Suppliers'], ['Delegation', 'Delegation']]) {
    await page.getByRole('link', { name: route, exact: true }).click();
    await page.locator('h1', { hasText: h1 }).waitFor({ timeout: 15_000 });
    await page.waitForTimeout(1500);
    check(`${w} ${route} is built, not a placeholder`, !(await page.getByText('Not in this build yet.').count()));
  }
  await page.getByRole('link', { name: 'Cash', exact: true }).click();
  const horizon = await page.getByText(/^Next 6 weeks · /).first().waitFor({ timeout: 15_000 }).then(() => true, () => false);
  check(`${w} cash route shows the fixed six-week horizon`, horizon);
  await shot('cash');

  if (w === 1440) {
    await page.getByRole('link', { name: 'Receivables' }).click();
    await page.getByRole('button', { name: 'New', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Create invoice' }).click();
    await page.getByRole('dialog').waitFor();
    await shot('27-ar-create-invoice');
    await page.getByRole('button', { name: 'Save draft' }).click();
    check('create: format errors shown before any request', await page.getByText('Enter an amount like 1800').isVisible());
    await page.getByLabel('Amount (USD)').fill('0');
    await page.getByLabel('Due date').fill('2026-11-15');
    await page.getByRole('button', { name: 'Save draft' }).click();
    await page.getByText('Amount must be more than $0.00').waitFor();
    check('create: server validation message shown', true);
    await page.getByLabel('Due date').fill('2020-01-01');
    await page.getByLabel('Amount (USD)').fill('12.34');
    await page.getByRole('button', { name: 'Save draft' }).click();
    await page.getByText('Due date cannot be before today').waitFor();
    check('create: past due date refused by server', true);
    await page.getByLabel('Due date').fill('2026-11-15');
    await page.keyboard.press('Escape');
    check('create: Esc closes the dialog', (await page.getByRole('dialog').count()) === 0);
    await page.getByRole('button', { name: 'New', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Create invoice' }).click();
    await page.getByLabel('Amount (USD)').fill('12.34');
    await page.getByLabel('Due date').fill('2026-11-15');
    await page.getByRole('button', { name: 'Save draft' }).click();
    await page.getByText('Draft saved. Not counted in the forecast.').waitFor();
    await page.getByRole('button', { name: 'Issue on PayPal' }).waitFor();
    check('create: draft saved, panel opens', true);
    await shot('28-ar-invoice-draft');
    await page.getByRole('button', { name: 'Issue on PayPal' }).click();
    check('issue: confirm dialog states consequence and scope', await page.getByText('No email is sent').isVisible() && await page.getByText('This invoice only.').isVisible());
    await shot('issue-confirm');
    if (!issue) {
      await page.getByRole('button', { name: 'Cancel' }).click();
    } else {
      await page.getByRole('dialog').getByRole('button', { name: 'Issue on PayPal' }).click();
      await page.getByText(/Issuing|Payer link/).first().waitFor();
      await page.getByText('Payer link').waitFor({ timeout: 60_000 });
      check('issue: ISSUED with payer link and not-emailed note', await page.getByText('Not emailed: no email channel yet.').isVisible());
      const href = await page.getByRole('link', { name: 'Open' }).getAttribute('href');
      console.log(`\nPAYER LINK (pay as a guest with a sandbox card): ${href}\n`);
      writeFileSync(join(out, 'payer-link.txt'), href ?? '');
      await shot('issued');
      if (autoPay) {
        const { execFileSync } = await import('node:child_process');
        console.log(execFileSync(process.execPath, ['scripts/demo/pay-sandbox.mjs', '--link', href, '--out', join(out, 'payer')], { encoding: 'utf8' }).trim());
      }
      if (waitPayment) {
        await page.getByText('Payer link').waitFor();
        console.log('Waiting up to 30 min for the human payment…');
        await page.getByText(/PayPal capture ·/).waitFor({ timeout: 30 * 60_000 });
        await page.getByText(/PayPal capture ·/).first().click();
        await page.getByText('PayPal-reported').waitFor();
        check('receipt panel shows PayPal-reported fee and capture id', await page.getByText('PayPal capture', { exact: true }).isVisible());
        await shot('78-receipt-panel');
        await page.getByRole('link', { name: 'Overview' }).click();
        await page.waitForTimeout(800);
        await shot('01-overview-after-payment');
      }
    }
  }
  await page.close();
}
/** Drives the Plaid Link iframe the way the probe's link/drive.mjs did (logic re-written here, not imported). */
async function driveLink(page, until, maxSteps = 30) {
  const log = [];
  const frame = () => page.frames().find((f) => /plaid\.com\/link/.test(f.url()) && f !== page.mainFrame());
  for (let step = 1; step <= maxSteps; step++) {
    await page.waitForTimeout(2500);
    if (await until()) return log;
    const f = frame();
    if (!f) { log.push(`${step}: no Link frame`); continue; }
    const text = (await f.innerText('body').catch(() => '')).replace(/\s+/g, ' ').slice(0, 300);
    const vis = async (sel) => (await f.$(sel)) && (await f.isVisible(sel).catch(() => false));
    let action = 'wait';
    if (await vis('input[type=password]:not([readonly])')) {
      const user = (await f.$$('input:not([type=password]):not([type=hidden]):not([type=search])'))[0];
      if (user && await user.isEditable().catch(() => false)) await user.fill('user_good');
      await f.fill('input[type=password]', 'pass_good');
      await f.press('input[type=password]', 'Enter');
      action = 'credentials';
    } else if (/associated institutions/i.test(text)) {
      await f.getByText('First Platypus Bank', { exact: true }).nth(1).click(); // the plain (non-OAuth) variant
      action = 'pick non-OAuth First Platypus Bank';
    } else if (/select your (bank|institution)|search/i.test(text) && (await vis('input[type=search], input[placeholder*="earch" i]'))) {
      const tile = f.getByText(/First Platypus Bank/i).first();
      if (await tile.isVisible().catch(() => false)) { await tile.click(); action = 'pick First Platypus'; }
      else { await f.fill('input[type=search], input[placeholder*="earch" i]', 'First Platypus'); action = 'search'; }
    } else {
      for (const re of [/without phone|continue as guest|not now|skip|i'?ll do this later/i, /^continue$|continue to|^submit$|^allow|^agree|^connect|^done$|^finish|^next$|^save$|^confirm|^share/i]) {
        const b = f.getByRole('button', { name: re }).first();
        if (await b.isVisible().catch(() => false) && await b.isEnabled().catch(() => false)) { action = `click ${(await b.innerText().catch(() => '')).trim().slice(0, 30)}`; await b.click(); break; }
      }
    }
    log.push(`${step}: ${action} | ${text.slice(0, 90)}`);
    await page.screenshot({ path: join(out, `link-${String(log.length).padStart(2, '0')}.png`) }).catch(() => {});
  }
  return log;
}

// S2-R28 (local only; operator clock seam): with no audit event and no reload, an open screen changes when PayPal's report
// crosses its 3 h STALE boundary, because the DTO's server-computed validUntil schedules the refetch.
if (process.argv.includes('--r28')) {
  const token = readFileSync('.headroom-local/operator-token', 'utf8');
  const clock = (offsetMs) => fetch(`${base}/__operator/clock`, { method: 'POST', headers: { 'x-operator-token': token }, body: JSON.stringify({ offsetMs }) });
  const asOf = (await (await fetch(`${base}/v1/cash/position`)).json()).sources[0].asOf;
  await clock(Date.parse(asOf) + 3 * 3600_000 - 90_000 - Date.now());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${base}/overview`);
  await page.locator('.strip .tile').first().click();
  const panel = page.getByRole('complementary', { name: 'Cash now' });
  await panel.getByText('Report within 3 h · not live').waitFor({ timeout: 30_000 });
  const freshFirst = (await panel.getByText(/PayPal report \d+ (h \d+ m|min) old$/).count()) === 0;
  const t0 = Date.now();
  const crossed = await panel.getByText(/PayPal report \d+ (h \d+ m|min) old$/).waitFor({ timeout: 150_000 }).then(() => true, () => false);
  check('S2-R28 open panel turns STALE at the 3 h boundary via validUntil (no reload, no audit event)', freshFirst && crossed && Date.now() - t0 > 20_000, `fresh first: ${freshFirst}; turned STALE after ${Math.round((Date.now() - t0) / 1000)} s`);
  await page.screenshot({ path: join(out, '1440-r28-stale-after-validuntil.png'), fullPage: true });
  await clock(0);
  await page.close();
}

if (bankFlow) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', (m) => { if (m.type() === 'error' && !/plaid\.com|status of 40[09]/.test(`${m.text()} ${m.location()?.url ?? ''}`)) consoleErrors.push(`bank: ${m.text()} @ ${m.location()?.url ?? '?'}`); });
  page.on('response', (r) => { if (r.url().includes('/v1/') && r.status() >= 500) failed.push(`bank: ${r.status()} ${r.url()}`); });
  const shot = (n) => page.screenshot({ path: join(out, `1440-${n}.png`), fullPage: true });
  await page.goto(`${base}/overview`);
  await page.waitForFunction(() => location.host.includes('amazoncognito') || document.body.innerText.includes('Cash now'), null, { timeout: 30_000 });
  await signInIfAsked(page);
  await page.getByText(/bank read/).first().waitFor({ timeout: 60_000 });
  check('bank: overview header and tile say "bank read <time>", never "as of" for a fetch', await page.getByText(/Your cash · PayPal as of .* · bank read/).isVisible());
  check('bank: demo bank is two checking accounts, none listed as not counted (owner, 1 Nov 2026)', (await page.getByText(/not counted/).count()) === 0);
  await page.locator('.strip .tile').first().click();
  const panel = page.getByRole('complementary', { name: 'Cash now' });
  await panel.getByTestId('bank-block').waitFor();
  await panel.getByText('Available · counted').first().waitFor();
  check('bank: two checking accounts, both "Available · counted" ($6,330.00 + $1,800.00)', (await panel.getByText('Available · counted', { exact: false }).count()) === 2 && await panel.getByText('$6,330.00').isVisible() && await panel.getByText('$1,800.00').first().isVisible());
  check('bank: checking shows current separately from counted available (S2-IM-04)', await panel.getByTestId('checking-current').first().innerText().then((t) => t === 'current $6,650.00'));
  check('bank: SEEDED label on the demo bank', await panel.getByTestId('bank-block').locator('.tag.SEEDED').isVisible());
  check('bank: activity with pending rows and PayPal candidates (not verified)', await panel.getByTestId('bank-activity').isVisible() && (await panel.getByText('PayPal? · candidate, not verified').count()) === 2 && (await panel.getByTestId('bank-activity').getByText('Pending').count()) === 1);
  check('bank: ledger names PayPal + checking', await panel.getByText(/Reported available \(PayPal \+ checking\) − reserve/).isVisible());
  await shot('02-cash-now-panel-bank');
  await panel.getByTestId('bank-block').screenshot({ path: join(out, '1440-bank-block-seeded.png') });

  // Disconnect (UI-SH-07 confirm) → stops counting at once → removal completes.
  await panel.getByRole('button', { name: 'Disconnect' }).click();
  check('bank: disconnect dialog states consequence and scope', await page.getByText(/Its last figures stop counting now. Nothing at the bank changes./).isVisible() && await page.getByText(/Scope: First Platypus Bank only./).isVisible());
  await shot('bank-disconnect-confirm');
  await page.getByRole('dialog').getByRole('button', { name: 'Disconnect' }).click();
  await panel.getByText(/Removal pending|Disconnected/).first().waitFor({ timeout: 30_000 });
  check('bank: after Disconnect the total is PayPal only (no "PayPal + checking")', !(await panel.getByText(/Reported available \(PayPal \+ checking\)/).count()));
  await panel.getByRole('button', { name: 'Connect bank' }).waitFor({ timeout: 90_000 });
  check('bank: removal completes → Disconnected + Connect bank', true);
  await panel.getByTestId('bank-block').screenshot({ path: join(out, '1440-bank-block-disconnected.png') });

  // Connect through the real Plaid Link iframe.
  await panel.getByRole('button', { name: 'Connect bank' }).click();
  const linkLog = await driveLink(page, async () => (await panel.getByText(/Connecting to|Bank read/).count()) > 0 || (await panel.getByText(/Bank not connected ·/).count()) > 0);
  writeFileSync(join(out, 'link-connect-steps.json'), JSON.stringify(linkLog, null, 2));
  await panel.getByText(/Linked by you/).waitFor({ timeout: 120_000 }).catch(() => {});
  await panel.getByText(/Bank read /).waitFor({ timeout: 120_000 }).catch(() => {});
  check('bank: Connect through Plaid Link (user_good) → linked by you, bank read', await panel.getByText(/Linked by you/).isVisible() && await panel.getByText(/Bank read /).isVisible(), `${linkLog.length} Link steps`);
  await panel.getByTestId('bank-block').screenshot({ path: join(out, '1440-bank-block-linked.png') });
  await shot('02-cash-now-panel-linked');

  // Login broken by the test harness → Reconnect through Link update mode.
  const { execFileSync } = await import('node:child_process');
  const broke = execFileSync(process.execPath, ['scripts/live/s2.ts', '--stage', stage, '--case', 'A3-break'], { encoding: 'utf8', env: { ...process.env, HEADROOM_GRANT: 'S2' } });
  console.log(broke.trim());
  await panel.getByRole('button', { name: 'Refresh bank' }).click();
  await panel.getByRole('button', { name: 'Reconnect' }).waitFor({ timeout: 60_000 });
  check('bank: broken login → "Reconnect required · last read … · figures not fresh"', await panel.getByText(/Reconnect required · last read .* figures not fresh/).isVisible());
  await panel.getByTestId('bank-block').screenshot({ path: join(out, '1440-bank-block-reconnect.png') });
  await panel.getByRole('button', { name: 'Reconnect' }).click();
  const upd = await driveLink(page, async () => (await panel.getByRole('button', { name: 'Reconnect' }).count()) === 0);
  writeFileSync(join(out, 'link-update-steps.json'), JSON.stringify(upd, null, 2));
  await panel.getByText(/Bank read /).waitFor({ timeout: 120_000 }).catch(() => {});
  check('bank: Reconnect via Link update mode (password only) → healthy again', await panel.getByText(/Bank read /).isVisible() && !(await panel.getByRole('button', { name: 'Reconnect' }).count()), `${upd.length} Link steps`);
  await panel.getByTestId('bank-block').screenshot({ path: join(out, '1440-bank-block-reconnected.png') });
  await page.close();
}

check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 5).join(' | '));
check('no failed requests', failed.length === 0, failed.slice(0, 5).join(' | '));
writeFileSync(join(out, 'results.json'), JSON.stringify({ base, at: new Date().toISOString(), results, consoleErrors, failed, httpErrors }, null, 2));
await browser.close();
process.exit(results.every((r) => r.ok) ? 0 : 1);
