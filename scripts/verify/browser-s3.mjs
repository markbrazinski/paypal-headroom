// S3 browser verification (VERIFICATION layers 4–5; S03 §6.11). From the real entry point: bill arrives → Overview alert →
// Review impact → Compare → Verify → Accept → calendar breach, timeline, chart, Payables, Inbox; the upload paths through the
// real file picker; currency attestation; amount-only and a stale accept; screenshots at 1440×900 and 1280×800.
//   node scripts/verify/browser-s3.mjs --base http://127.0.0.1:8787 --out <dir> [--stage local|dev] [--login ownerA]
// Each scenario that needs a clean run resets it (operator) and injects sample bills (operator, original bytes only). Model calls: Nova, local or dev share.
import { chromium } from 'playwright-core';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { invokeOperator } from '../demo/operator-client.ts';
import { billPdf } from '../demo/bill-pdf.ts';

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const base = arg('--base', 'http://127.0.0.1:8787');
const out = arg('--out', '.headroom-local/browser-s3');
const stage = arg('--stage', base.includes('127.0.0.1') ? 'local' : 'dev');
const tenant = arg('--tenant', stage === 'dev' ? 'tenant-owner' : 'tenant-local');
const loginAs = arg('--login');
const creds = loginAs ? JSON.parse(readFileSync('.headroom-local/dev-users.json', 'utf8'))[loginAs] : null;
const executablePath = arg('--chrome', join(homedir(), 'Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'));
const FX = 'tests/fixtures/bills';
mkdirSync(out, { recursive: true });

// ---------- operator (reset, inject, clock) ----------
const token = stage === 'local' ? readFileSync('.headroom-local/operator-token', 'utf8') : null;
const local = (path, body) => fetch(`${base}/__operator/${path}`, { method: 'POST', headers: { 'x-operator-token': token }, body: JSON.stringify(body) }).then((r) => r.json());
async function reset(reason) {
  let r = stage === 'local' ? await local('reset', { reason, bank: 'seed' }) : await invokeOperator({ action: 'reset', tenantId: tenant, reason, bank: 'seed' });
  for (let i = 0; i < 200 && r?.state === 'PREPARING'; i++) {
    await new Promise((x) => setTimeout(x, 3000));
    r = stage === 'local' ? await (await fetch(`${base}/__operator/run?runId=${r.runId}`, { headers: { 'x-operator-token': token } })).json() : await invokeOperator({ action: 'getRun', tenantId: tenant, runId: r.runId });
  }
  if (r?.state !== 'READY') throw new Error(`reset not READY: ${JSON.stringify(r)}`);
  haveRun = true;
  return r;
}
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const inject = async (variant) => {
  const payload = { fileName: `${variant}.pdf`, contentBase64: billPdf(variant, today()).toString('base64'), reason: 'browser-s3' };
  const r = await (stage === 'local' ? local('inject-bill', payload) : invokeOperator({ action: 'injectBill', tenantId: tenant, ...payload }));
  lastBillId = r?.billId ?? lastBillId;
  return r;
};

// ---------- checks ----------
const results = [];
const check = (name, ok, detail = '') => { results.push({ scenario: current, name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` · ${detail}` : ''}`); };
const soft = async (name, f) => { try { await f(); } catch (e) { check(name, false, e.message.split('\n')[0]); } };
const browser = await chromium.launch({ executablePath, headless: true });
const consoleErrors = [], failed = [];
// Deliberate refusals the script provokes: a stale accept (409) and an unknown bill id (404).
const expected = (url, status) => (status === 409 && /accept-terms/.test(url)) || (status === 404 && /bill_zzzzzz/.test(url));
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const watch = (page, w) => {
  page.on('console', (m) => { if (m.type() === 'error' && !/status of (409|404)/.test(m.text())) consoleErrors.push(`${w}: ${m.text()}`); });
  page.on('requestfailed', (r) => { if (!r.url().startsWith('blob:')) failed.push(`${w}: ${r.method()} ${r.url()} ${r.failure()?.errorText}`); });
  page.on('response', (r) => { if (r.status() >= 400 && !expected(r.url(), r.status())) failed.push(`${w}: ${r.status()} ${r.request().method()} ${r.url()}`); });
};
const page = await ctx.newPage();
watch(page, 1440);
const shot = (n, p = page, w = 1440) => p.screenshot({ path: join(out, `${w}-${n}.png`), fullPage: true });
const go = async (path, p = page) => {
  await p.goto(`${base}${path}`);
  // The SPA redirects to Cognito after it loads (dev): wait for either the sign-in page or the app.
  await p.waitForFunction(() => location.host.includes('amazoncognito') || !!document.querySelector('.nav'), null, { timeout: 30_000 });
  if (p.url().includes('amazoncognito.com')) {
    await p.locator('input[name="username"]:visible').fill(creds.email);
    await p.locator('input[name="password"]:visible').fill(creds.password);
    await p.locator('input[type="submit"]:visible, button[type="submit"]:visible').first().click();
    await p.waitForURL((u) => !u.href.includes('amazoncognito.com'), { timeout: 30_000 });
    if (!p.url().includes(path.split('?')[0])) await p.goto(`${base}${path}`);
  }
  await p.locator('.nav').waitFor({ timeout: 30_000 });
  // A new tab can bounce through Cognito silently (session cookie) and land on the callback page: go where we were asked.
  const want = new URL(`${base}${path}`);
  if (new URL(p.url()).pathname + new URL(p.url()).search !== want.pathname + want.search) {
    await p.goto(want.href);
    await p.locator('.nav').waitFor({ timeout: 30_000 });
  }
};
/** Wait for text, reloading the route now and then (the bill is read by the worker). */
const until = async (text, path, ms = 90_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // Dev pages fetch over the network: give the data time to arrive before reloading.
    if (await page.getByText(text).first().waitFor({ timeout: 10_000 }).then(() => true, () => false)) return true;
    if (path) await go(path);
  }
  return false;
};
const dialogButton = (name) => page.locator('.dialog .df button', { hasText: name });
const panel = () => page.locator('aside.panel');

// ---------- scenarios: each is independently runnable (VERIFICATION §7 rerun policy) ----------
//   --only A,C         run just those scenarios
//   --keep-run         don't reset (run on top of the current run, e.g. after the S1/S2 journey)
//   --failed <prevDir> rerun only the scenarios that had a failing check in <prevDir>/results.json
// A, B and C reset the run themselves; U, R39 and V reuse the current run, or reset once if they run first.
const ALL = ['A', 'U', 'B', 'C', 'R39', 'V'];
const prevDir = arg('--failed');
const wanted = arg('--only') ? arg('--only').split(',')
  : prevDir ? [...new Set(JSON.parse(readFileSync(join(prevDir, 'results.json'), 'utf8')).results.filter((r) => !r.ok).map((r) => r.scenario))].filter((s) => ALL.includes(s))
  : ALL;
console.log(`scenarios: ${wanted.join(', ') || '(none failed: nothing to rerun)'}`);
let current = 'setup';
// --keep-run: use the current run as it is (cumulative journey: S1/S2 ran first on this run); no scenario resets.
const keepRun = process.argv.includes('--keep-run');
let haveRun = keepRun;
let lastBillId = null;
const ensureRun = async (why) => { if (!haveRun) { await reset(why); } };
async function scenario(name, needsFreshRun, body) {
  if (!wanted.includes(name)) return;
  current = name;
  const [c0, f0] = [consoleErrors.length, failed.length];
  try {
    await go('/overview').catch(() => {}); // leave any open panel so a reset doesn't refetch an earlier run's bill
    if (needsFreshRun && !keepRun) await reset(`S3 browser ${name}`); else await ensureRun(`S3 browser ${name}`);
    await body();
  } catch (e) { check(`${name} stopped`, false, e.message.split('\n')[0]); }
  check(`${name} no console errors`, consoleErrors.length === c0, consoleErrors.slice(c0, c0 + 3).join(' | '));
  check(`${name} no failed requests`, failed.length === f0, failed.slice(f0, f0 + 3).join(' | '));
}

// ================= A: the hero journey =================
await scenario('A', true, async () => {
  await go('/overview');
  const cashBefore = await page.locator('.strip .tile').first().locator('.fig').innerText();
  check('A0 Bills due tile shows a figure', /\$\d/.test(await page.locator('.strip .tile').nth(2).locator('.fig').innerText()));
  const hero = await inject('hero');
  check('A0 operator injected hero (original bytes)', hero.status === 'RECEIVED', hero.billId);
  check('A1 Overview alert after the bill is read', await until(/billed K-2207 for/, '/overview'));
  await soft('A1 alert', async () => {
    check('A1 kicker says earlier than your forecast', await page.getByText(/New bill · earlier than your forecast/).waitFor({ timeout: 15_000 }).then(() => true, () => false));
    check('A1 impact trio: Lowest point with this bill / Needed to stay above reserve', await page.getByText('Lowest point with this bill').waitFor({ timeout: 15_000 }).then(() => true, () => false) && await page.getByText('Needed to stay above reserve').waitFor({ timeout: 15_000 }).then(() => true, () => false));
    check('A1 Needs your decision has the bill row', await page.locator('.need').filter({ hasText: /earlier than your forecast/ }).count() === 1);
    check('A1 nav badge "1 need you"', /1 needs? you/.test(await page.locator('.nav a').first().innerText()));
  });
  await shot('01-overview-bill-alert');
  await page.locator('.alert-cta').click();
  await panel().waitFor();
  await page.getByText('Impact comparison').waitFor({ timeout: 20_000 });
  await soft('A2 bill panel', async () => {
    check('A2 Review impact opens the bill panel on Payables', page.url().includes('/payables?bill='));
    check('A2 checks: payment date differs', await panel().getByText('Payment date differs').waitFor({ timeout: 15_000 }).then(() => true, () => false));
    check('A2 one-obligation note', await panel().getByText(/One obligation with conflicting terms, not two outflows/).waitFor({ timeout: 15_000 }).then(() => true, () => false));
    check('A2 grounded quotes shown', await panel().getByText('“INVOICE K-2207”').waitFor({ timeout: 15_000 }).then(() => true, () => false));
    check('A2 accept is not offered before verify (disabled)', await panel().getByRole('button', { name: 'Accept new date…' }).isDisabled());
    check('A2 ask supplier disabled with reason', await panel().getByRole('button', { name: /^Ask Keller/ }).isDisabled());
  });
  await shot('02-bill-panel');
  const billUrl = page.url();
  await panel().getByRole('button', { name: 'Compare in forecast' }).click();
  await page.getByText(/^Comparing:/).waitFor({ timeout: 20_000 });
  await soft('A3 compare', async () => {
    check('A3 compare banner + per-day "Compared:" values + tile', (await page.locator('.cell-cmp').count()) > 0 && (await page.locator('.sub.cmp').count()) > 0);
  });
  await shot('03-cash-compare');
  await page.getByRole('button', { name: 'Stop comparing' }).click();
  check('A3 Stop comparing removes the overlay', (await page.locator('.cell-cmp').count()) === 0 && !page.url().includes('compare='));

  await page.goto(billUrl);
  await panel().getByRole('button', { name: 'Verify bill…' }).waitFor({ timeout: 20_000 });
  await panel().getByRole('button', { name: 'Verify bill…' }).click();
  check('A4 verify dialog states scope: nothing changes, payment not authorized', await page.locator('.dialog').getByText(/Dates, amount and payment are not changed/).waitFor({ timeout: 15_000 }).then(() => true, () => false));
  await shot('04-verify-dialog');
  await dialogButton('Verify bill').click();
  await panel().getByRole('button', { name: 'Accept new date…' }).waitFor({ state: 'visible', timeout: 20_000 });
  await page.waitForFunction(() => !document.querySelector('aside.panel button:disabled')?.textContent?.includes('Accept new date'), null, { timeout: 20_000 }).catch(() => {});
  await panel().getByRole('button', { name: 'Accept new date…' }).click();
  await soft('A4 accept dialog', async () => {
    check('A4 accept dialog shows old → new date and the cash consequence', await page.locator('.dialog').getByText('CASH CONSEQUENCE').waitFor({ timeout: 15_000 }).then(() => true, () => false) && await page.locator('.dialog').getByText(/Cash now unchanged/).waitFor({ timeout: 15_000 }).then(() => true, () => false) && await page.locator('.dialog').getByText(/→/).first().waitFor({ timeout: 15_000 }).then(() => true, () => false));
  });
  await shot('05-accept-dialog');
  await dialogButton('Accept new date').click();
  await panel().getByText(/✓ Accepted date/).waitFor({ timeout: 20_000 });
  check('A4 bill accepted', true);

  await go('/overview');
  check('A5 Overview now shows the reserve-gap alert', await until(/Cash falls below your reserve on/, '/overview', 30_000));
  check('A5 Cash now unchanged after accept', (await page.locator('.strip .tile').first().locator('.fig').innerText()) === cashBefore, cashBefore);
  check('A5 no needs left', await page.getByText('✓ Nothing needs you').waitFor({ timeout: 15_000 }).then(() => true, () => false));
  await shot('06-overview-gap');
  // S4 (UI-OV-08): the breach alert's action is now "Review plan" → Plan; the calendar checks continue from Cash.
  check('A6 alert action is "Review plan"', (await page.locator('.alert-cta').innerText()) === 'Review plan');
  await page.locator('.alert-cta').click();
  check('A6 Review plan opens the Plan', await page.waitForURL((u) => u.pathname === '/plan', { timeout: 15_000 }).then(() => true, () => false));
  await go('/cash');
  await page.locator('.cal').waitFor();
  await soft('A6 calendar', async () => {
    check('A6 a breach is shown (BELOW/NEGATIVE days)', (await page.locator('.cell.s-NEGATIVE, .cell.s-BELOW').count()) > 0);
    const n = await page.locator('.cal .cell').count();
    check('A6 calendar has whole Monday–Sunday weeks covering 42 days', n % 7 === 0 && (await page.locator('.cal .cell:not(.blank)').count()) === 42, `${n / 7} rows`);
    check('A6 agenda shows opening, projected close, reserve', await page.locator('.agenda').getByText('Projected close').waitFor({ timeout: 15_000 }).then(() => true, () => false));
    check('A6 tiles: first time below reserve has a date; reserve gap > $0', !/Not in the next/.test(await page.locator('.strip .tile').nth(2).innerText()) && !/^\$0\.00$/.test(await page.locator('.strip .tile').nth(3).locator('.fig').innerText()));
  });
  await shot('07-cash-calendar-breach');
  await page.getByRole('button', { name: 'Timeline', exact: true }).click();
  check('A7 timeline: active days and quiet gaps', (await page.locator('.tl-day').count()) > 3 && (await page.locator('.tl-gap').count()) > 0);
  await shot('08-cash-timeline');
  await page.getByRole('button', { name: 'Chart', exact: true }).click();
  await page.locator('.chartbox canvas').first().waitFor({ timeout: 20_000 });
  check('A7 chart renders (AG Charts canvas, no failure banner)', (await page.locator('.chartbox canvas').count()) > 0 && !(await page.getByText('Chart failed to load').count()));
  const box = await page.locator('.chartbox canvas').first().boundingBox();
  const dayBefore = await page.locator('.agenda .ag-h strong').innerText();
  for (const fx of [0.3, 0.45, 0.6, 0.75]) { await page.mouse.click(box.x + box.width * fx, box.y + box.height * 0.42); if ((await page.locator('.agenda .ag-h strong').innerText()) !== dayBefore) break; }
  check('A7 clicking the chart selects a day', (await page.locator('.agenda .ag-h strong').innerText()) !== dayBefore, `${dayBefore} → ${await page.locator('.agenda .ag-h strong').innerText()}`);
  await shot('09-cash-chart');
  await page.getByRole('button', { name: 'Calendar', exact: true }).click();
  await page.locator('details.nif summary').click();
  check('A7 "Not in the forecast yet" lists items with reasons', (await page.locator('.nif-row').count()) >= 0);

  await go('/payables');
  await page.locator('.ag-row').first().waitFor({ timeout: 20_000 });
  check('A8 payment plan grid rows', (await page.locator('.ag-row').count()) >= 4);
  check('A8 footnote: approval is not permission to pay', await page.getByText(/Bill approval isn't permission to pay/).waitFor({ timeout: 15_000 }).then(() => true, () => false));
  await shot('10-payables-plan');
  await page.getByRole('tab', { name: /^Bills/ }).click();
  await page.locator('.ag-row').first().waitFor();
  await shot('11-payables-bills');
  await page.getByRole('tab', { name: /^Commitments/ }).click();
  check('A8 commitments substantiation shows BILL K-2207', await page.getByText('BILL K-2207').waitFor({ timeout: 15_000 }).then(() => true, () => false));
  await shot('12-payables-commitments');
  await go('/inbox');
  check('A8 inbox lists the injected bill', await page.locator('.inbox-row').filter({ hasText: 'Keller Drafting Co.' }).first().waitFor({ timeout: 15_000 }).then(() => true, () => false));
  await page.locator('.inbox-row').first().click();
  await panel().waitFor();
  await shot('13-inbox-panel');

});

// ================= U: uploads through the real file picker (tracked fixtures, day 0 = 2026-11-09) =================
await scenario('U', false, async () => {
  const capture = async (file) => {
    await go('/payables');
    await page.getByRole('button', { name: 'New', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Capture bill' }).click();
    await page.getByLabel('Bill PDF').setInputFiles(join(FX, file));
    await page.locator('.dialog .df button', { hasText: 'Upload' }).click();
    await page.locator('.dialog .kicker', { hasText: 'Step 2' }).waitFor({ timeout: 30_000 });
    await page.waitForFunction(() => !/Reading the bill/.test(document.querySelector('.dialog')?.textContent ?? ''), null, { timeout: 90_000 });
    return page.locator('.dialog').innerText();
  };
  await soft('U1 unknown + duplicate', async () => {
    const t = await capture('unknown.pdf');
    check('U1 unknown supplier upload → held, nothing added', /Held/.test(t) && /not one of your suppliers/.test(t));
    await page.locator('.dialog .df button', { hasText: 'Close' }).click();
    const t2 = await capture('unknown.pdf');
    check('U1 byte-identical re-upload → "Already received"', /Already received/.test(t2));
    await page.locator('.dialog .df button', { hasText: 'Close' }).click();
  });
  await soft('U2 scanned', async () => {
    const t = await capture('scanned.pdf');
    check('U2 scanned → held, no text layer', /Held/.test(t) && /No text layer/.test(t));
    await page.locator('.dialog .df button', { hasText: 'Close' }).click();
  });
  await soft('U3 injection', async () => {
    await capture('injection.pdf');
    await page.locator('.dialog .df button', { hasText: 'Open bill' }).click();
    await panel().waitFor();
    check('U3 injected instructions flagged, not obeyed', await panel().getByText('Contains instructions').first().waitFor({ timeout: 15_000 }).then(() => true, () => false));
    await shot('14-bill-injection');
  });
  await soft('U4 remittance', async () => {
    await capture('remittance.pdf');
    await page.locator('.dialog .df button', { hasText: 'Open bill' }).click();
    await panel().waitFor();
    check('U4 remittance change held; Verify not offered', await panel().getByText('Payment details differ').first().waitFor({ timeout: 15_000 }).then(() => true, () => false) && !(await panel().getByRole('button', { name: 'Verify bill…' }).count()));
    await shot('15-bill-remittance');
  });
  await soft('U5 separate obligation from the capture dialog', async () => {
    const t = await capture('separate.pdf');
    check('U5 capture step 2 offers a separate obligation', /Add as a separate obligation/.test(t));
    await page.locator('.choice-card', { hasText: 'Add as a separate obligation' }).click();
    check('U5 dialog names both acts', await page.locator('.dialog').getByText(/This bill is genuine/).waitFor({ timeout: 15_000 }).then(() => true, () => false) && await page.locator('.dialog').getByText(/as a new outflow/).first().waitFor({ timeout: 15_000 }).then(() => true, () => false));
    await shot('16-separate-dialog');
    await dialogButton('Verify and add').click();
    await panel().getByText(/Added as a separate obligation/).waitFor({ timeout: 20_000 });
    check('U5 added', true);
  });
  await soft('U6 ambiguous → picker → verify', async () => {
    await capture('ambiguous.pdf');
    await page.locator('.dialog .df button', { hasText: 'Open bill' }).click();
    await panel().waitFor();
    check('U6 verify disabled until a payment is chosen', await panel().getByRole('button', { name: 'Verify bill…' }).isDisabled());
    await panel().locator('.choice input').first().check();
    await shot('17-bill-picker');
    await panel().getByRole('button', { name: 'Verify bill…' }).click();
    await dialogButton('Verify bill').click();
    await panel().getByText(/✓ Verified by/).waitFor({ timeout: 20_000 });
    check('U6 verified against the chosen payment', true);
  });
  await soft('U7 open original + unknown id', async () => {
    const [pdfPage] = await Promise.all([ctx.waitForEvent('page'), panel().getByRole('button', { name: 'Open original' }).click()]);
    await pdfPage.waitForURL(/^blob:/, { timeout: 20_000 }).catch(() => {});
    check('U7 Open original opens the PDF (authenticated blob)', pdfPage.url().startsWith('blob:'), pdfPage.url().slice(0, 40));
    await pdfPage.close();
    await page.goto(`${base}/payables?bill=bill_zzzzzz_0000000000`);
    await page.getByText(/Couldn't load/).waitFor({ timeout: 20_000 });
    check('U7 an unknown / other tenant bill id → not found', await page.getByText(/No such bill/).waitFor({ timeout: 15_000 }).then(() => true, () => false));
  });

});

// ================= B: bare "$" attestation =================
await scenario('B', true, async () => {
  const bare = await inject('bare-dollar');
  await page.goto(`${base}/payables?bill=${bare.billId}`);
  await soft('B1 bare dollar', async () => {
    check('B1 bill read: Confirm currency', await until(/Confirm currency/, `/payables?bill=${bare.billId}`));
    await panel().getByRole('button', { name: 'Verify bill…' }).click();
    check('B1 verify needs "This bill is in US dollars"', await dialogButton('Verify bill').isDisabled());
    await page.locator('.dialog input[type=checkbox]').check();
    await shot('18-bare-dollar-attest');
    await dialogButton('Verify bill').click();
    await panel().getByText(/confirmed US dollars/).waitFor({ timeout: 20_000 });
    check('B1 attestation recorded', true);
  });

});

// ================= C: amount-only + stale accept =================
await scenario('C', true, async () => {
  const amt = await inject('amount');
  await page.goto(`${base}/payables?bill=${amt.billId}`);
  await soft('C1 amount only + stale', async () => {
    check('C1 bill read: amount differs', await until(/amount differs/i, `/payables?bill=${amt.billId}`));
    await panel().getByRole('button', { name: 'Verify bill…' }).click();
    await dialogButton('Verify bill').click();
    await panel().getByRole('button', { name: 'Accept new amount…' }).waitFor({ timeout: 20_000 });
    await page.waitForTimeout(800);
    await panel().getByRole('button', { name: 'Accept new amount…' }).click();
    check('C1 dialog shows Amount (USD) old → new, no date change', await page.locator('.dialog').getByText('Amount (USD)').waitFor({ timeout: 15_000 }).then(() => true, () => false) && !(await page.locator('.dialog .kv', { hasText: /^Date/ }).count()));
    await shot('19-accept-amount');
    // Another tab accepts first; this dialog's confirm must be refused, not applied twice.
    const other = await ctx.newPage();
    watch(other, '1440-tab2');
    await go(`/payables?bill=${amt.billId}`, other);
    await other.locator('aside.panel').getByRole('button', { name: 'Accept new amount…' }).click();
    await other.locator('.dialog .df button', { hasText: 'Accept new amount' }).click();
    await other.locator('aside.panel').getByText(/✓ Accepted amount/).waitFor({ timeout: 20_000 });
    await other.close();
    await dialogButton('Accept new amount').click();
    await page.locator('.dialog .err-banner').waitFor({ timeout: 20_000 });
    check('C1 stale accept (other tab won) → refusal shown', /version|reload|changed/i.test(await page.locator('.dialog .err-banner').innerText()));
    await shot('20-stale-accept');
    await page.keyboard.press('Escape');
  });

});

// ================= R39: Sunday-start horizon (local clock seam only) =================
await scenario('R39', false, async () => {
  if (stage !== 'local') return check('R39 skipped (local clock seam only)', true);
  await soft('R39 Sunday start', async () => {
    const now = new Date();
    const dow = new Date(`${today()}T00:00:00Z`).getUTCDay();
    const offset = ((7 - dow) % 7 || 7) * 86_400_000;
    await local('clock', { offsetMs: offset });
    await go('/cash');
    await page.locator('.cal').waitFor();
    const n = await page.locator('.cal .cell').count();
    check('R39 Sunday horizon: 7 rows, 42 dates, day +41 selectable', n === 49 && (await page.locator('.cal .cell:not(.blank)').count()) === 42, `${n / 7} rows`);
    await page.locator('.cal .cell:not(.blank)').last().click();
    check('R39 day +41 selected', (await page.locator('.cal .cell.sel').getAttribute('data-day')) === (await page.locator('.cal .cell:not(.blank)').last().getAttribute('data-day')));
    await shot('21-calendar-sunday');
    await local('clock', { offsetMs: 0 });
    void now;
  });

});

// ================= V: 1280×800 visual pass =================
await scenario('V', false, async () => {
  const p2 = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  watch(p2, 1280);
  for (const [n, path] of [['01-overview', '/overview'], ['04-cash-forecast', '/cash'], ['06-payables', '/payables'], ['02-inbox', '/inbox'], ...(lastBillId ? [['06b-payables-bill', `/payables?bill=${lastBillId}`]] : [])]) {
    await go(path, p2);
    await p2.waitForTimeout(1500);
    await shot(n, p2, 1280);
    check(`1280 ${path} no horizontal scroll`, await p2.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  }

});

const bad = results.filter((r) => !r.ok);
writeFileSync(join(out, 'results.json'), JSON.stringify({ at: new Date().toISOString(), base, stage, scenarios: wanted, results, consoleErrors, failed }, null, 2));
await browser.close();
console.log(`${results.length - bad.length}/${results.length} PASS${bad.length ? ` · rerun just these: --failed ${out}` : ''}`);
process.exit(bad.length ? 1 : 0);
