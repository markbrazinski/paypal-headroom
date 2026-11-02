// S4 browser verification (VERIFICATION layers 4–5; S04 §6.11 as revised by §6.17 R9). From the real entry point: breach → Review
// plan → building checks → draft → citations, edits, remove/restore, alternatives, approve → grants, revoke → reapprove, running
// removal, delegation preview/save, pauses, relationships, cash scenarios/compare, reject; screenshots at 1440×900 and 1280×800.
//   node scripts/verify/browser-s4.mjs --base http://127.0.0.1:8787 --out <dir> [--stage local|dev] [--login ownerA] [--only P2,P6] [--failed <prevDir>]
// Each scenario that needs a plan in a given state reaches it through the UI (reset → injected original bill → verify → accept → Plan).
// The planner is live Nova when the server has a model; its choices vary (G-M1), so scenarios include an action with "Ask anyway"
// when Nova left it out, rather than assuming a selection.
import { chromium } from 'playwright-core';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { invokeOperator } from '../demo/operator-client.ts';
import { billPdf } from '../demo/bill-pdf.ts';

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const base = arg('--base', 'http://127.0.0.1:8787');
const out = arg('--out', '.headroom-local/browser-s4');
const stage = arg('--stage', base.includes('127.0.0.1') ? 'local' : 'dev');
const tenant = arg('--tenant', stage === 'dev' ? 'tenant-owner' : 'tenant-local');
const loginAs = arg('--login');
const creds = loginAs ? JSON.parse(readFileSync('.headroom-local/dev-users.json', 'utf8'))[loginAs] : null;
const executablePath = arg('--chrome', join(homedir(), 'Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'));
mkdirSync(out, { recursive: true });

// ---------- operator (reset, inject) ----------
const token = stage === 'local' ? readFileSync('.headroom-local/operator-token', 'utf8') : null;
const local = (path, body) => fetch(`${base}/__operator/${path}`, { method: 'POST', headers: { 'x-operator-token': token }, body: JSON.stringify(body) }).then((r) => r.json());
async function reset(reason) {
  let r = stage === 'local' ? await local('reset', { reason, bank: 'seed' }) : await invokeOperator({ action: 'reset', tenantId: tenant, reason, bank: 'seed' });
  for (let i = 0; i < 200 && r?.state === 'PREPARING'; i++) {
    await new Promise((x) => setTimeout(x, 3000));
    r = stage === 'local' ? await (await fetch(`${base}/__operator/run?runId=${r.runId}`, { headers: { 'x-operator-token': token } })).json() : await invokeOperator({ action: 'getRun', tenantId: tenant, runId: r.runId });
  }
  if (r?.state !== 'READY') throw new Error(`reset not READY: ${JSON.stringify(r)}`);
  return r;
}
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const inject = async (variant) => {
  const payload = { fileName: `${variant}.pdf`, contentBase64: billPdf(variant, today()).toString('base64'), reason: 'browser-s4' };
  return stage === 'local' ? local('inject-bill', payload) : invokeOperator({ action: 'injectBill', tenantId: tenant, ...payload });
};

// ---------- checks ----------
const results = [];
let current = 'setup';
const check = (name, ok, detail = '') => { results.push({ scenario: current, name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` · ${detail}` : ''}`); };
const soft = async (name, f) => { try { await f(); } catch (e) { check(name, false, e.message.split('\n')[0]); } };
const browser = await chromium.launch({ executablePath, headless: true });
const consoleErrors = [], failed = [];
// Deliberate refusals the scenarios provoke: a stale approval (409).
// Deliberate refusals: a stale approval, or a click on a view older than the plan (the page refreshes itself; scenarios retry).
const expected = (url, status) => status === 409 && /\/(approve|edit)$/.test(url);
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const watch = (p, w) => {
  // Cognito's hosted sign-in page has no favicon (outside Headroom); everything else counts.
  p.on('console', (m) => { if (m.type() === 'error' && !/status of 409/.test(m.text()) && !/amazoncognito\.com\/favicon\.ico/.test(m.location()?.url ?? '')) consoleErrors.push(`${w}: ${m.text()} @ ${m.location()?.url ?? '?'}`); });
  p.on('requestfailed', (r) => { if (!r.url().startsWith('blob:')) failed.push(`${w}: ${r.method()} ${r.url()} ${r.failure()?.errorText}`); });
  p.on('response', (r) => { if (r.status() >= 400 && !expected(r.url(), r.status())) failed.push(`${w}: ${r.status()} ${r.request().method()} ${r.url()}`); });
};
const page = await ctx.newPage();
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
  }
  await p.locator('.nav').waitFor({ timeout: 30_000 });
  const want = new URL(`${base}${path}`);
  if (new URL(p.url()).pathname + new URL(p.url()).search !== want.pathname + want.search) { await p.goto(want.href); await p.locator('.nav').waitFor({ timeout: 30_000 }); }
};
const seen = (loc, ms = 15_000) => loc.first().waitFor({ timeout: ms }).then(() => true, () => false);
const dialogButton = (name, p = page) => p.locator('.dialog .df button', { hasText: name });
const card = (name) => page.locator('.act').filter({ hasText: name });

/** Fresh run → hero bill → verify → accept (the S3 path, through the UI) → Plan draft visible. */
async function toDraft(reason) {
  await go('/overview').catch(() => {});
  await reset(reason);
  const r = await inject('hero');
  await go(`/payables?bill=${r.billId}`);
  const panel = page.locator('aside.panel');
  for (let i = 0; i < 12 && !(await seen(panel.getByRole('button', { name: 'Verify bill…' }), 8_000)); i++) await go(`/payables?bill=${r.billId}`);
  await panel.getByRole('button', { name: 'Verify bill…' }).click();
  await dialogButton('Verify bill').click();
  await panel.getByRole('button', { name: 'Accept new date…' }).waitFor({ state: 'visible', timeout: 20_000 });
  await panel.getByRole('button', { name: 'Accept new date…' }).click();
  await dialogButton('Accept new date').click();
  await page.getByText(/Terms accepted|Accepted/).first().waitFor({ timeout: 20_000 }).catch(() => {});
  await go('/plan');
  return seen(page.getByRole('button', { name: /Approve selected actions/ }), 120_000);
}
/**
 * Shared runs (owner, 2 Nov 2026): a scenario reuses the current run when it already has the state it needs and resets only when it
 * doesn't, so a full pass resets twice instead of once per scenario, and --only / --failed still work on their own.
 */
async function planState() {
  await go('/plan');
  await page.waitForLoadState('networkidle').catch(() => {});
  const head = await page.locator('.plan-head').first().innerText({ timeout: 10_000 }).catch(() => '');
  if (/DRAFT · NOT RUNNING/.test(head)) return 'DRAFT';
  if (/RECOVERING|GAP COVERED|REVISION NEEDS REVIEW/.test(head)) return 'RUNNING';
  return 'NONE';
}
async function needDraft(reason) { return (await planState()) === 'DRAFT' ? true : toDraft(reason); }
async function needPlan(reason) { return (await planState()) !== 'NONE' ? true : toDraft(reason); }
async function needRunning(reason, include) {
  if ((await planState()) === 'RUNNING' && (await Promise.all(include.map((n) => card(n).count()))).every(Boolean)) return true;
  if (!(await toDraft(reason))) return false;
  for (const n of include) await ensureIncluded(n);
  await approveAll();
  return true;
}
const draftN = async () => Number((/Draft (\d+)/.exec(await page.locator('.plan-head').first().innerText().catch(() => '')) ?? [])[1] ?? 0);

/** If Nova left an action out, include it with "Ask anyway" so a scenario can use it. */
const CONSIDERED_TITLE = { 'Offer Mercer': 'Mercer Architects · early-payment offer', 'Ask Harrow': 'Harrow Developments · collection', 'Ask Pellow': 'Pellow Dental Group · collection' };
async function ensureIncluded(name) {
  await page.waitForLoadState('networkidle').catch(() => {}); // a click on a stale view is correctly refused (409)
  if (await card(name).count()) return true;
  const row = page.locator('.considered .box-b').filter({ hasText: CONSIDERED_TITLE[name] ?? name });
  if (!(await row.count())) return false;
  await row.getByRole('button', { name: 'Ask anyway' }).click();
  // A click on a view older than the plan is refused and the page refreshes itself: try once more, as a person would.
  if (await seen(page.getByText(/has been refreshed\. Please try again/), 4_000)) { await page.waitForLoadState('networkidle').catch(() => {}); await page.locator('.considered .box-b').filter({ hasText: CONSIDERED_TITLE[name] ?? name }).getByRole('button', { name: 'Ask anyway' }).click(); }
  return seen(card(name));
}
async function approveAll() {
  await page.getByRole('button', { name: /Approve selected actions/ }).click();
  await page.locator('.dialog').waitFor();
  await dialogButton('Approve').click();
  await page.locator('.dialog').waitFor({ state: 'detached', timeout: 20_000 });
  await page.waitForLoadState('networkidle').catch(() => {}); // the page re-reads the revision; a click before that is correctly refused (409)
}

// ---------- scenarios (VERIFICATION §8) ----------
const ALL = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9', 'P10', 'P11', 'P12', 'P14', 'P15', 'V'];
const prevDir = arg('--failed');
const wanted = arg('--only') ? arg('--only').split(',')
  : prevDir ? [...new Set(JSON.parse(readFileSync(join(prevDir, 'results.json'), 'utf8')).results.filter((r) => !r.ok).map((r) => r.scenario))].filter((s) => ALL.includes(s))
  : ALL;
console.log(`scenarios: ${wanted.join(', ') || '(none failed: nothing to rerun)'}`);
async function scenario(name, body) {
  if (!wanted.includes(name)) return;
  current = name;
  const [c0, f0] = [consoleErrors.length, failed.length];
  try { await body(); } catch (e) { check(`${name} stopped`, false, e.message.split('\n').slice(0, 3).join(' ')); await shot(`${name}-failure`).catch(() => {}); }
  check(`${name} no console errors`, consoleErrors.length === c0, consoleErrors.slice(c0, c0 + 3).join(' | '));
  check(`${name} no failed requests`, failed.length === f0, failed.slice(f0, f0 + 3).join(' | '));
}

// P1: a reset issues the three hero invoices on PayPal (real sandbox), visible on Receivables.
await scenario('P1', async () => {
  await reset('S4 browser P1');
  await go('/receivables');
  let n = 0;
  for (let i = 0; i < 20 && n < 3; i++) { await page.locator('.ag-row, .empty').first().waitFor({ timeout: 20_000 }).catch(() => {}); n = await page.locator('.ag-row').filter({ hasText: /Pellow|Harrow|Mercer/ }).filter({ hasText: /Overdue|Open/ }).count(); if (n < 3) { await page.waitForTimeout(3000); await go('/receivables'); } }
  check('P1 Pellow, Harrow and Mercer invoices issued on PayPal', n === 3, `${n} issued`);
  await shot('p1-receivables-hero');
});

// P2: breach → Overview → Review plan → building → draft: header, outlook, schedule, cards, considered.
await scenario('P2', async () => {
  check('P2 draft built from the Plan page', await toDraft('S4 browser P2'));
  await go('/overview');
  check('P2 Overview plan card', await seen(page.locator('.plan-card').filter({ hasText: 'DRAFT · NOT RUNNING' })));
  check('P2 Needs: Approve revision 1', await seen(page.locator('.need').filter({ hasText: 'Approve revision 1' })));
  await shot('p2-overview-plan');
  await page.locator('.need').filter({ hasText: 'Approve revision 1' }).getByRole('button').click();
  await page.getByRole('button', { name: /Approve selected actions/ }).waitFor({ timeout: 20_000 });
  check('P2 header names the accepted bill and the need-by date', await seen(page.locator('.plan-headline').filter({ hasText: /K-2207.*accepted by you/ })));
  await ensureIncluded('Ask Pellow');
  check('P2 schedule rows name the business and the proposed action', await seen(page.locator('.sched-lane').filter({ hasText: 'Pellow Dental Group' }).filter({ hasText: 'Ask to pay the overdue invoice' })));
  check('P2 schedule says what happens in words', await seen(page.locator('.mk', { hasText: 'Payment due' })));
  await page.getByRole('tab', { name: 'Outlook · if…' }).click();
  check('P2 outlook sub-tab, first row "Nothing arrives early"', await seen(page.locator('.plan-outlook tr').filter({ hasText: 'Nothing arrives early' })));
  check('P2 outlook says likelihood not assessed and no % anywhere', await seen(page.getByText('Likelihood: not assessed').first()) && !/\d\s?%\s*(likely|chance)/i.test(await page.locator('.plan').innerText()));
  await page.getByRole('tab', { name: 'Plan', exact: true }).click();
  check('P2 Keller payout card with an exception tag', await seen(card('Pay Keller').locator('.auth-ex')));
  check('P2 disputed $1,800 considered, never askable', await seen(page.locator('.considered .box-b').filter({ hasText: 'disputed $1,800' })) && (await page.locator('.considered .box-b').filter({ hasText: 'disputed $1,800' }).getByRole('button').count()) === 0);
  await page.locator('.mk-OBLIGATION').first().click();
  check('P2 schedule marker focuses its card', await page.evaluate(() => document.activeElement?.id?.startsWith('act-') ?? false));
  await shot('p2-plan-draft');
});

// P3: citations show a source card on hover and keyboard focus; clicking opens the record.
await scenario('P3', async () => {
  check('P3 a plan to read', await needPlan('S4 browser P3'));
  const c = page.locator('.act .cite').first();
  await c.hover();
  check('P3 hover shows the source card', await seen(page.locator('.cite-card')));
  await page.mouse.move(0, 0);
  await c.focus();
  check('P3 keyboard focus shows the source card', await seen(page.locator('.cite-card')));
  await shot('p3-citation');
  await c.click();
  check('P3 click opens the record', await page.waitForURL((u) => !u.pathname.startsWith('/plan'), { timeout: 10_000 }).then(() => true, () => false), page.url());
});

// P4: edit Pellow's contact → recheck note; Mercer 5% → exception + one more approval; back to 2%.
await scenario('P4', async () => {
  check('P4 draft', await needDraft('S4 browser P4'));
  check('P4 Pellow in the plan (Ask anyway if Nova left it out)', await ensureIncluded('Ask Pellow'));
  const p = card('Ask Pellow');
  await p.getByRole('button', { name: 'Edit' }).click();
  const d = await p.locator('input[type="date"]').first().inputValue();
  const next = new Date(`${d}T00:00:00Z`); do next.setUTCDate(next.getUTCDate() + 1); while ([0, 6].includes(next.getUTCDay()));
  await p.locator('input[type="date"]').first().fill(next.toISOString().slice(0, 10));
  // The target may not precede the ask (correctly refused): move it along when needed.
  if ((await p.locator('input[type="date"]').nth(1).inputValue()) < next.toISOString().slice(0, 10)) await p.locator('input[type="date"]').nth(1).fill(next.toISOString().slice(0, 10));
  await p.getByRole('button', { name: 'Save and recheck' }).click();
  check('P4 recheck note: still within delegation', await seen(page.getByText(/Still within your delegation/)));
  check('P4 Mercer offer in the plan (Ask anyway if Nova left it out)', await ensureIncluded('Offer Mercer'));
  const before = await page.getByRole('button', { name: /Approve selected actions/ }).innerText();
  const m = card('Offer Mercer');
  await m.getByRole('button', { name: 'Edit' }).click();
  await m.locator('select').selectOption('500');
  await m.getByRole('button', { name: 'Save and recheck' }).click();
  check('P4 5% → Exception, new approval required', await seen(page.getByText(/Exception · 5% = \$225\.00 is above/)));
  check('P4 the approval dialog lists the discount permission', await (async () => { await page.getByRole('button', { name: /Approve selected actions/ }).click(); const ok = await seen(page.locator('.dialog').getByText(/One-time permission for the discount/)); await page.keyboard.press('Escape'); await page.locator('.dialog').waitFor({ state: 'detached' }); return ok; })(), before);
  await shot('p4-mercer-5pct');
  await card('Offer Mercer').getByRole('button', { name: 'Edit' }).click();
  await card('Offer Mercer').locator('select').selectOption('200');
  await card('Offer Mercer').getByRole('button', { name: 'Save and recheck' }).click();
  check('P4 back to 2%: within delegation', await seen(card('Offer Mercer').locator('.auth-ok')));
  await page.getByRole('tab', { name: 'Outlook · if…' }).click();
  check('P4 a fallback outlook row priced net', await seen(page.locator('.plan-outlook tr').filter({ hasText: /offer sent and paid early/ }).filter({ hasText: /net/ })));
  await page.getByRole('tab', { name: 'Plan', exact: true }).click();
});

// P5: remove Harrow with a reason → restore; ask for an alternative → dismiss.
await scenario('P5', async () => {
  check('P5 draft', await needDraft('S4 browser P5'));
  await ensureIncluded('Ask Pellow');
  check('P5 Harrow in the plan (Ask anyway if Nova left it out)', await ensureIncluded('Ask Harrow'));
  await card('Ask Harrow').getByRole('button', { name: 'Remove…' }).click();
  await card('Ask Harrow').getByRole('button', { name: 'Talk to them first' }).click();
  await card('Ask Harrow').getByRole('button', { name: 'Remove from this revision' }).click();
  check('P5 removed: shown under "Removed by you" with the note', await seen(page.locator('.act').filter({ hasText: 'Removed by you · Talk to them first' })));
  await shot('p5-harrow-removed');
  await page.locator('.act').filter({ hasText: 'Removed by you' }).getByRole('button', { name: 'Restore' }).click();
  check('P5 restored: back in the plan as proposed with its delegation line', await seen(page.getByText(/Back in the plan as proposed · An invoice with a dispute/)));
  const p = card('Ask Pellow');
  await p.getByRole('button', { name: 'Ask for alternative' }).click();
  check('P5 alternative shown or truthfully none', await seen(p.locator('.editor').filter({ hasText: /Use alternative|No other action/ })));
  await p.locator('.editor').getByRole('button', { name: 'Dismiss' }).click();
});

// P6: approve → running; grants in Approved once (with S3 records) and Activity.
await scenario('P6', async () => {
  check('P6 draft', await needDraft('S4 browser P6'));
  await ensureIncluded('Ask Harrow');
  await page.getByRole('button', { name: /Approve selected actions/ }).click();
  check('P6 dialog: permissions recorded separately', await seen(page.locator('.dialog').getByText(/PERMISSIONS RECORDED SEPARATELY/)));
  check('P6 dialog: scope says nothing is sent or paid', await seen(page.locator('.dialog').getByText(/Nothing is sent or paid in this build/)));
  await shot('p6-approve-dialog');
  await dialogButton('Approve').click();
  check('P6 running', await seen(page.getByText(/RECOVERING A GAP|GAP COVERED IF TARGETS MET/), 20_000));
  await shot('p6-plan-running');
  await go('/delegation');
  check('P6 Approved once lists payout authority', await seen(page.locator('.dl-grant').filter({ hasText: 'Payout authority' })));
  check('P6 S3 bill verification listed, not revocable', await seen(page.locator('.dl-grant').filter({ hasText: 'Bill verified' })) && (await page.locator('.dl-grant').filter({ hasText: 'Bill verified' }).getByRole('button').count()) === 0);
  await shot('p6-delegation-approved-once');
  await go('/overview');
  await page.getByRole('tab', { name: /Activity/ }).click().catch(() => {});
  check('P6 Activity shows the approval', await seen(page.getByText(/permissions? recorded separately/)));
});

// P7: revoke Harrow's message permission → the card needs approval again → approve again.
await scenario('P7', async () => {
  check('P7 running with Harrow', await needRunning('S4 browser P7', ['Ask Harrow']));
  await go('/delegation');
  await page.locator('.dl-grant').filter({ hasText: 'send the message as written' }).getByRole('button', { name: 'Revoke…' }).click();
  await dialogButton('Revoke').click();
  await page.locator('.dialog').waitFor({ state: 'detached' });
  await go('/plan');
  check('P7 revision needs review', await seen(page.getByText('REVISION NEEDS REVIEW')));
  check('P7 Harrow card proposed again', await seen(card('Ask Harrow').getByText('Proposed · needs your approval')));
  await approveAll();
  check('P7 approved again', await seen(card('Ask Harrow').getByText(/Scheduled for/)));
});

// P8: running removal of a scheduled action → restore → approve again (S4-PR-04).
await scenario('P8', async () => {
  check('P8 running with Pellow', await needRunning('S4 browser P8', ['Ask Pellow']));
  const removePellow = async () => { await card('Ask Pellow').getByRole('button', { name: 'Remove…' }).click(); await card('Ask Pellow').getByRole('button', { name: 'Remove from this revision' }).click(); };
  await removePellow();
  // A click that lands before the page re-read the approved revision is refused and the page refreshes itself: try once more, as a person would.
  if (await seen(page.getByText(/has been refreshed\. Please try again/), 4_000)) { await page.waitForLoadState('networkidle').catch(() => {}); await removePellow(); }
  check('P8 scheduled action removed', await seen(page.locator('.act').filter({ hasText: 'Removed by you' })));
  await page.locator('.act').filter({ hasText: 'Removed by you' }).getByRole('button', { name: 'Restore' }).click();
  check('P8 restored action needs approval', await seen(page.getByText('REVISION NEEDS REVIEW')));
  await approveAll();
  check('P8 approved again', await seen(card('Ask Pellow').getByText(/Scheduled for/)));
});

// P9: Payables limit → $15,000 preview → review → save → Keller keeps only the daily-limit reason.
await scenario('P9', async () => {
  check('P9 a plan', await needPlan('S4 browser P9'));
  const before9 = Math.max(await draftN(), 1);
  await go('/delegation');
  await page.locator('[id="ap.paymentLimitMinor"] .affects-chip').hover();
  check('P9 "Affects" popover lists the impacted payout for audit', await seen(page.locator('.affects-pop').filter({ hasText: /Keller Drafting Co\./ }).filter({ hasText: /Exception/ })));
  await shot('p9-affects-popover');
  await page.mouse.move(0, 0);
  await page.locator('[id="ap.paymentLimitMinor"]').getByRole('button', { name: 'Change' }).click();
  await page.getByRole('button', { name: 'Paying bills only' }).click();
  await page.locator('.box').filter({ hasText: 'Change rule' }).locator('input').fill('15000');
  await page.getByRole('button', { name: 'Preview' }).click();
  check('P9 preview: Keller loses the per-payment reason, keeps the exception', await seen(page.locator('.note').filter({ hasText: /No longer: \$10,020\.00 is above the \$5,000\.00 per-payment limit/ }).filter({ hasText: /still needs payout authority and an exception/ })));
  await shot('p9-rule-preview');
  await page.getByRole('button', { name: 'Review change…' }).click();
  check('P9 review dialog says this loosens', await seen(page.locator('.dialog').getByText('This loosens your delegation')));
  await dialogButton('Save').click();
  check('P9 rule saved', await page.locator('.dialog').waitFor({ state: 'detached', timeout: 20_000 }).then(() => true, () => false));
  await go('/plan');
  // The basis changed (rules are plan inputs), so Plan builds revision 2 under Delegation v2: Keller keeps only the daily-limit reason.
  check('P9 a new revision under the new rules', await seen(page.getByText(new RegExp(`Draft ${before9 + 1}\\b|Draft [${before9 + 1}-9]`)), 120_000));
  await shot('p9-after-save');
  check('P9 Keller: daily-limit exception only, no per-payment reason', await seen(card('Pay Keller').getByText(/daily limit/)) && !(await card('Pay Keller').getByText(/per-payment/).count()));
});

// P10: pause payments → banner on every route → resume.
await scenario('P10', async () => {
  await go('/delegation');
  await page.getByRole('switch').nth(1).click();
  await dialogButton('Pause').click();
  let all = true;
  for (const r of ['/overview', '/plan', '/cash', '/receivables', '/payables', '/relationships', '/delegation']) { await go(r); all = all && await seen(page.locator('.pause-banner'), 8_000); }
  check('P10 banner on every route', all);
  await shot('p10-paused');
  await go('/delegation');
  await page.getByRole('switch').nth(1).click();
  await dialogButton('Resume').click();
  await page.locator('.dialog').waitFor({ state: 'detached' });
  check('P10 resumed: the banner goes without a reload', await page.locator('.pause-banner').waitFor({ state: 'detached', timeout: 15_000 }).then(() => true, () => false));
});

// P11: Customers & Suppliers directory → Pellow record → factors and treatment.
await scenario('P11', async () => {
  await go('/relationships');
  check('P11 directory with labels', await seen(page.locator('.ag-row').filter({ hasText: 'Strong' })));
  await page.locator('.ag-row').filter({ hasText: 'Pellow' }).click();
  check('P11 record: what the label is built from', await seen(page.locator('aside.panel').getByText('What this is built from')));
  check('P11 record: median days late factor', await seen(page.locator('aside.panel').getByText('Median days late')));
  await shot('p11-pellow-record');
});

// P12: Cash Expected / Ideal / Downside; compare chips; Scenarios tab → Compare.
await scenario('P12', async () => {
  check('P12 a plan', await needPlan('S4 browser P12'));
  await go('/cash');
  for (const s of ['Ideal', 'Downside', 'Expected']) { await page.getByRole('button', { name: s, exact: true }).click(); check(`P12 ${s} basis line`, await seen(page.getByText(new RegExp(`^${s} ·`)))); }
  check('P12 compare chip "Before the bill"', await seen(page.getByRole('button', { name: 'Before the bill' })));
  await page.getByRole('button', { name: 'Before the bill' }).click();
  check('P12 comparing banner', await seen(page.locator('.comparing')));
  await page.getByRole('tab', { name: 'Scenarios' }).click();
  check('P12 Scenarios table with proposals and linked work', await seen(page.locator('tr').filter({ hasText: 'Headroom proposal' }).filter({ hasText: /Revision \d+/ })));
  await shot('p12-cash-scenarios');
  await page.locator('tr').filter({ hasText: 'Headroom proposal' }).first().getByRole('button', { name: 'Compare' }).click();
  check('P12 Compare switches to the calendar with the comparison', await seen(page.locator('.comparing').filter({ hasText: 'Headroom proposal' })));
});

// P14: reject a draft → "You rejected revision N" → Build again → revision N+1.
await scenario('P14', async () => {
  check('P14 draft', await needDraft('S4 browser P14'));
  const n14 = await draftN();
  await page.getByRole('button', { name: 'Reject revision…' }).click();
  await dialogButton('Reject').click();
  check('P14 rejected note with Build again', await seen(page.getByText(new RegExp(`You rejected revision ${n14}`))));
  await page.getByRole('button', { name: 'Build again' }).click();
  check('P14 next revision drafted', await seen(page.getByText(new RegExp(`Draft ${n14 + 1}\\b`)), 120_000));
});

// P15: an obligation added in another tab while the approval dialog is open → the approval is refused (S4-PR-01).
await scenario('P15', async () => {
  check('P15 draft', await needDraft('S4 browser P15'));
  await page.getByRole('button', { name: /Approve selected actions/ }).click();
  await page.locator('.dialog').waitFor();
  const p2 = await ctx.newPage();
  watch(p2, 'tab2');
  await go('/payables', p2);
  await p2.getByRole('button', { name: 'New', exact: true }).click();
  await p2.getByRole('menuitem', { name: 'Add commitment' }).click();
  await p2.locator('.dialog input').nth(0).fill('Van repair (browser-s4)');
  await p2.locator('.dialog input').nth(1).fill('300.00');
  const d = new Date(); d.setUTCDate(d.getUTCDate() + 20);
  await p2.locator('.dialog input[type="date"]').fill(d.toISOString().slice(0, 10));
  await dialogButton('Add commitment', p2).click();
  await p2.locator('.dialog').waitFor({ state: 'detached', timeout: 20_000 });
  await p2.close();
  await dialogButton('Approve').click();
  check('P15 stale approval refused: cash picture changed', await seen(page.locator('.dialog .err-banner').filter({ hasText: /cash picture changed/ })));
  await shot('p15-stale-consent');
  await page.locator('.dialog .df button', { hasText: 'Cancel' }).click();
});

// J (cumulative journey, VERIFICATION §5; only with --only J): on the CURRENT run, after S1/S2 (browser.mjs) and S3 A (browser-s3 --keep-run)
// accepted the bill: the plan builds → edit → remove → approve → grants visible. Never resets.
if (wanted.includes('J')) await scenario('J', async () => {
  await go('/plan');
  check('J plan built on the journey run', await seen(page.getByRole('button', { name: /Approve selected actions/ }), 120_000));
  const p = card('Ask Pellow');
  if (await p.count()) {
    // Edit the wording, not a date, so the journey never leaves the demo run with a moved target (owner, 2 Nov 2026).
    await p.getByRole('button', { name: 'Edit' }).click();
    const t = p.locator('textarea');
    await t.fill(`${await t.inputValue()}\n(Edited during the cumulative check.)`);
    await p.getByRole('button', { name: 'Save and recheck' }).click();
    check('J edit rechecked', await seen(page.locator('.note').filter({ hasText: /delegation|approval/ })));
  } else check('J Pellow in the plan', await ensureIncluded('Ask Pellow'));
  const victim = (await card('Offer Mercer').count()) ? 'Offer Mercer' : 'Ask Harrow';
  check(`J ${victim} in the plan (Ask anyway if Nova left it out)`, await ensureIncluded(victim));
  await card(victim).getByRole('button', { name: 'Remove…' }).click();
  await card(victim).getByRole('button', { name: 'Remove from this revision' }).click();
  check(`J removed ${victim}`, await seen(page.locator('.act').filter({ hasText: 'Removed by you' })));
  await approveAll();
  check('J running', await seen(page.getByText(/RECOVERING A GAP|GAP COVERED IF TARGETS MET/), 20_000));
  await shot('j-plan-running');
  await go('/delegation');
  check('J grants visible in Approved once', await seen(page.locator('.dl-grant').filter({ hasText: 'Payout authority' })));
  await shot('j-delegation');
});

// V: 1280×800 screenshots of the S4 routes.
await scenario('V', async () => {
  const p = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  watch(p, 1280);
  for (const [n, r] of [['plan', '/plan'], ['delegation', '/delegation'], ['relationships', '/relationships'], ['cash', '/cash'], ['overview', '/overview']]) { await go(r, p); await p.waitForTimeout(1500); await shot(`v-${n}`, p, 1280); }
  check('V 1280 screenshots captured', true);
  await p.close();
});

await browser.close();
const bad = results.filter((r) => !r.ok);
writeFileSync(join(out, 'results.json'), JSON.stringify({ at: new Date().toISOString(), base, stage, scenarios: wanted, results, consoleErrors, failed }, null, 2));
console.log(`${results.length - bad.length}/${results.length} PASS${bad.length ? ` · rerun just these: node scripts/verify/browser-s4.mjs --base ${base} --out <newDir> --failed ${out}` : ''}`);
process.exit(bad.length ? 1 : 0);
