// S7a browser verification (VERIFICATION layers 4–5; S07 §6.18 R13). Named scenarios against the labelled REPLAY server
// (scripts/verify/s7-replay-server.ts: real router + acceptance harness + fake PayPal + simulated mailbox): controls and rendering,
// never a payment or a real email. Screenshots at 1440×900 and 1280×800 in the same pass.
//   node scripts/verify/browser-s7.mjs [--base http://127.0.0.1:8797] [--out <dir>] [--only A1,A2] [--failed <prevDir>]
import { chromium } from 'playwright-core';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const base = arg('--base', 'http://127.0.0.1:8797');
const out = arg('--out', `.private/headroom/evidence/S07/browser-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const only = arg('--only') ? arg('--only').split(',') : null;
const failedDir = arg('--failed');
const prevFailed = failedDir && existsSync(join(failedDir, 'results.json')) ? [...new Set(JSON.parse(readFileSync(join(failedDir, 'results.json'), 'utf8')).filter((r) => !r.ok).map((r) => r.scenario))] : null;
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
const api = (path) => fetch(`${base}${path}`).then((r) => r.json());
const ruleBox = (p, key) => p.locator(`[id="${key}"]`);
async function openEditor(p, key) {
  await go(p, '/delegation');
  const box = ruleBox(p, key);
  await box.getByRole('button', { name: 'Change' }).click();
  return seen(p.getByRole('heading', { name: /Change rule/ }));
}
async function previewSave(p, { ack = false } = {}) {
  await p.getByRole('button', { name: 'Preview', exact: true }).click();
  const okPrev = await seen(p.getByText('What this would change'));
  await p.getByRole('button', { name: 'Review change…' }).click();
  const dlg = p.getByRole('dialog');
  const save = dlg.getByRole('button', { name: 'Save' });
  if (ack) {
    const disabled = await save.isDisabled();
    await dlg.getByLabel('I understand this loosens a safety rule').check();
    return { okPrev, ackGate: disabled, saved: await save.click().then(() => seen(p.getByText('Rule saved'))) };
  }
  return { okPrev, saved: await save.click().then(() => seen(p.getByText('Rule saved'))) };
}

const SCENARIOS = {
  /** A1 every editable row has Change; each editor type previews and saves (S7-A3, UI-DA rows). */
  async A1(p) {
    await scenario('hero');
    await go(p, '/delegation');
    const d = await api('/v1/delegation');
    const editable = d.rules.filter((r) => r.editable);
    check('every rule is editable (13)', editable.length === 13, `${editable.length}`);
    check('every editable row shows Change', (await p.getByRole('button', { name: 'Change' }).count()) === editable.length);
    // MONEY
    await openEditor(p, 'ap.dailyLimitMinor');
    await p.getByLabel('Amount (USD)').fill('7000');
    let r = await previewSave(p); check('MONEY: daily limit saved', r.okPrev && r.saved);
    check('MONEY: row shows $7,000', await seen(ruleBox(p, 'ap.dailyLimitMinor').getByText(/\$7,000/)));
    // WINDOW
    await openEditor(p, 'comms.window');
    await p.getByLabel('From').fill('09:00'); await p.getByLabel('Until').fill('17:00');
    r = await previewSave(p); check('WINDOW: saved', r.okPrev && r.saved);
    check('WINDOW: sentence renders 09:00–17:00', await seen(ruleBox(p, 'comms.window').getByText(/between 09:00 and 17:00/)));
    await shot(p, 'delegation-window-saved', 1440);
    // TOGGLE
    await openEditor(p, 'comms.remindersWithoutReview');
    await p.getByLabel('You review each one first').check();
    r = await previewSave(p); check('TOGGLE: saved', r.okPrev && r.saved);
    check('TOGGLE: sentence says review', await seen(ruleBox(p, 'comms.remindersWithoutReview').getByText(/waits for your review/)));
    // DISCOUNT (percent + caps + tier checkboxes)
    await openEditor(p, 'ar.discount');
    await p.getByLabel('Up to percent').fill('3');
    await p.getByRole('checkbox', { name: 'Mixed' }).check();
    await shot(p, 'delegation-discount-editor', 1440);
    r = await previewSave(p); check('DISCOUNT: saved', r.okPrev && r.saved);
    check('DISCOUNT: sentence renders 3% and Mixed', await seen(ruleBox(p, 'ar.discount').getByText(/3%.*Strong, Good or Mixed/)));
    check('tier table: Mixed now offers the discount', await seen(p.locator('tr').filter({ hasText: 'Mixed' }).getByText(/Up to 3%/)));
    // CHOICE
    await openEditor(p, 'ap.exactMatchBills');
    await p.getByLabel('Come to you').check();
    r = await previewSave(p); check('CHOICE: saved', r.okPrev && r.saved);
    // SET_ASIDE (tightening a safety rule needs no acknowledgement)
    await openEditor(p, 'cash.protectedPayments');
    await p.getByLabel(/Days before each protected payment/).fill('3');
    r = await previewSave(p); check('SET_ASIDE: tightening saved without the safety checkbox', r.okPrev && r.saved);
    // BUSINESS_DAYS
    await openEditor(p, 'comms.contactEveryBd');
    await p.getByLabel('Business days').fill('2');
    r = await previewSave(p); check('BUSINESS_DAYS: saved', r.okPrev && r.saved);
    // Out of range → the server's message, nothing saved
    await openEditor(p, 'cash.reserveMinor');
    await p.getByLabel('Amount (USD)').fill('-5');
    const before = errors.length;
    await p.getByRole('button', { name: 'Preview', exact: true }).click();
    check('out-of-range value refused with a message', await seen(p.locator('.err-banner')));
    // The 400 is the refusal under test, not a defect.
    errors.splice(before).filter((e) => !/400|Bad Request/.test(e.text)).forEach((e) => errors.push(e));
  },
  /** A2 safety loosen: Save waits for "I understand"; chip + Overview notice; Restore default clears both (S7-A7, S7-R5). */
  async A2(p) {
    await scenario('hero');
    await openEditor(p, 'ap.differingBills');
    await p.getByLabel('Accept automatically when…').check();
    await p.getByLabel('Days bound').fill('30');
    await shot(p, 'delegation-differing-editor', 1440);
    const r = await previewSave(p, { ack: true });
    check('safety dialog: Save disabled until "I understand"', r.ackGate === true);
    check('safety change saved after the checkbox', r.okPrev && r.saved);
    check('chip "Loosened by you"', await seen(ruleBox(p, 'ap.differingBills').getByText(/Loosened by you/)));
    await shot(p, 'delegation-safety-loosened', 1440);
    await go(p, '/overview');
    check('Overview notice', await seen(p.getByText(/You loosened a safety rule/)));
    await shot(p, 'overview-safety-notice', 1440);
    await go(p, '/delegation');
    await ruleBox(p, 'ap.differingBills').getByRole('button', { name: 'Restore default' }).click();
    check('restore previews at once', await seen(p.getByText('What this would change')));
    await p.getByRole('button', { name: 'Review change…' }).click();
    await p.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
    check('restored', await seen(p.getByText('Rule saved')));
    check('chip gone', (await ruleBox(p, 'ap.differingBills').getByText(/Loosened by you/).count()) === 0);
    await go(p, '/overview');
    check('Overview notice gone', (await p.getByText(/You loosened a safety rule/).count()) === 0);
  },
  /** A3 reserve $3,000 → Cash shows it (S7-A6, one source). */
  async A3(p) {
    await scenario('hero');
    await openEditor(p, 'cash.reserveMinor');
    await p.getByLabel('Amount (USD)').fill('3000');
    const r = await previewSave(p); check('reserve saved', r.okPrev && r.saved);
    await go(p, '/cash');
    check('Cash shows the $3,000 reserve', await seen(p.getByText(/\$3,000\.00/)));
    await shot(p, 'cash-reserve-3000', 1440);
  },
  /** A4 disputes loosened → a new revision proposes the disputed ask, needing approval (S7-A4). */
  async A4(p) {
    await scenario('hero');
    await openEditor(p, 'ar.disputes');
    await p.getByLabel(/Also propose collecting the disputed part/).check();
    const r = await previewSave(p, { ack: true }); check('disputes loosened (ack)', r.okPrev && r.saved);
    await fetch(`${base}/v1/plan/revisions`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    await go(p, '/plan');
    // UX repair (F01): the running revision stays on the page; the new draft opens from the "proposed" line.
    check('the new revision is offered beside the running one', await seen(p.getByRole('button', { name: /Open revision \d/ })));
    await p.getByRole('button', { name: /Open revision \d/ }).click();
    check('Plan shows the disputed ask', await seen(p.getByText(/Ask Harrow Developments for \$1,800\.00 of the disputed amount/)));
    check('it needs your approval', await seen(p.getByText(/needs your approval each time/i)));
    await shot(p, 'plan-disputed-ask', 1440);
  },
  /** D1 Harrow's dispute email on the invoice: shown as an email; confirm the split (S7-A12). */
  async D1(p) {
    await scenario('dispute');
    await go(p, '/overview');
    check('Overview Needs row for the dispute', await seen(p.getByText(/Harrow Developments disputes/)));
    const recv = await api('/v1/receivables');
    const harrow = recv.invoices.find((i) => i.customerId === 'cust-harrow');
    await go(p, `/receivables?invoice=${encodeURIComponent(harrow.invoiceId)}`);
    check('dispute section shows the email', await seen(p.getByText('Dispute waiting for you')) && await seen(p.getByText(/accounts\.harrow@example\.com/)));
    check('quote shown', await seen(p.getByText(/dispute the \$1,800 change order/)));
    check('amounts prefilled from the email', (await p.getByLabel('Disputed amount', { exact: true }).inputValue()) === '1800' && (await p.getByLabel('Undisputed amount', { exact: true }).inputValue()) === '7200');
    await shot(p, 'receivables-dispute-email', 1440);
    await p.getByRole('button', { name: 'Confirm split' }).click();
    check('confirmed', await seen(p.getByText(/Split confirmed/)));
    check('section gone after confirm', await p.getByText('Dispute waiting for you').waitFor({ state: 'detached', timeout: 8000 }).then(() => true, () => false));
  },
  /** K1 Keller's answer on the bill: options, the quoted answer, Accept split → two payments (S7-A14). */
  async K1(p) {
    await scenario('ask');
    const pay = await api('/v1/payables');
    const bill = (pay.bills ?? pay.inbox ?? []).find?.((b) => /K-2207/.test(b.ref ?? b.title ?? '')) ?? null;
    const billId = bill?.billId ?? (await api('/v1/overview')).needs.find((n) => n.key.startsWith('answer:'))?.action.to.billId;
    check('Needs row links to the bill', !!billId);
    await go(p, `/payables?bill=${billId}`);
    check('asks section', await seen(p.getByText(/Asked Keller Drafting Co\. about the date/)));
    check('offered options listed', await seen(p.getByText(/split \$1,400\.00 on Fri, Nov 13 \+ \$8,600\.00 on Thu, Dec 3/)));
    check('answer quoted', await seen(p.getByText(/Fine: \$1,400 on Nov 13 and \$8,600 on Dec 3/)));
    await shot(p, 'payables-keller-answer', 1440);
    await p.getByRole('button', { name: 'Accept: split the payment' }).click();
    check('accepted', await seen(p.getByText(/Accepted · the bill’s terms changed/)));
    const f = await api('/v1/cash/forecast');
    const kel = f.days.flatMap((d) => d.items).filter((i) => /Keller/.test(i.label));
    check('forecast now has two Keller payments', kel.length === 2, JSON.stringify(kel.map((i) => [i.on, i.amount])));
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
  for (const [sc, path, n] of [['hero', '/delegation', 'delegation'], ['hero', '/overview', 'overview'], ['dispute', '/overview', 'overview-dispute-needs'], ['ask', '/plan', 'plan-ask-running']]) {
    await scenario(sc); await go(p, path); await p.waitForTimeout(500); await shot(p, n, 1280);
  }
  check('1280 set captured', true);
}
await browser.close();
writeFileSync(join(out, 'results.json'), JSON.stringify(results, null, 2));
const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} checks passed · evidence ${out}${bad.length ? `\nrerun: node scripts/verify/browser-s7.mjs --failed ${out}` : ''}`);
process.exit(bad.length ? 1 : 0);
