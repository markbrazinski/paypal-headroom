// AUTOMATED-PAYER (owner decision, 1 Nov 2026): pays a PayPal SANDBOX invoice as a guest with a PayPal test card,
// through PayPal's own hosted payer page. The capture is genuine; Headroom still only believes the capture GET.
//   node scripts/demo/pay-sandbox.mjs --link <payer-url> [--amount 7200.00] [--card <sandbox test card>] [--out <dir>]
// --amount pays that amount on an invoice that allows partial payment (S5: Harrow's undisputed slice); PayPal enforces its minimum.
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const link = arg('--link');
const out = arg('--out', '.headroom-local/payer');
const amount = arg('--amount');
// --card: another PayPal sandbox test card when the default one is declined for velocity (2 Nov 2026: repeated guest declines on 4111…).
const card = arg('--card', '4111111111111111');
if (!/^\d{15,16}$/.test(card)) { console.error('refusing: --card must be a 15–16 digit sandbox test card number'); process.exit(2); }
if (amount !== undefined && !/^\d+\.\d{2}$/.test(amount)) { console.error('refusing: --amount must look like 7200.00'); process.exit(2); }
if (!link || !/^https:\/\/www\.sandbox\.paypal\.com\/invoice\/p\/#[A-Z0-9]+$/.test(link)) { console.error('refusing: --link must be a sandbox.paypal.com invoice payer link'); process.exit(2); }
mkdirSync(out, { recursive: true });

const launch = (o) => chromium.launch({ headless: true, ...o });
const browser = await launch({ channel: 'chrome' }).catch(() => launch({ executablePath: join(homedir(), 'Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing') }));
const ctx = await browser.newContext({ viewport: { width: 1200, height: 1600 } });
const page = await ctx.newPage();
try {
  await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  const text = async () => (await page.innerText('body')).replace(/\s+/g, ' ');
  await page.waitForTimeout(4000);
  if (/Amount due \$0\.00|This invoice (has been|is) paid/i.test(await text())) {
    console.log('ALREADY_PAID: PayPal shows this invoice as paid; nothing to do');
    process.exit(0);
  }
  // Invoices that allow partial payment show an extra "Continue to Payment" step first.
  const cont = page.getByRole('button', { name: 'Continue to Payment' });
  if (await cont.count()) { await cont.click({ timeout: 30_000 }); await page.waitForTimeout(5000); }
  if (amount) {
    // Partial: PayPal's second payment option is "Other amount" (probe 01 #13).
    const opts = page.locator('input[name=payment_option]');
    if ((await opts.count()) < 2) throw new Error('--amount given but this invoice offers no partial payment');
    await opts.nth(1).check({ force: true });
    await page.waitForTimeout(1000);
    await page.locator('input[type=text], input[inputmode=decimal]').first().fill(amount);
    await page.waitForTimeout(2000);
  }
  // PayPal loads the card-button frame late on a slow page: wait for it rather than a fixed delay.
  let frame;
  for (let i = 0; i < 30 && !frame; i++) { frame = page.frames().find((f) => f.url().includes('style.color=black')); if (!frame) await page.waitForTimeout(1000); }
  if (!frame) { await page.screenshot({ path: join(out, 'no-card-frame.png'), fullPage: true }); throw new Error('guest card button frame not found after 30 s'); }
  const [popup] = await Promise.all([ctx.waitForEvent('page', { timeout: 30_000 }), frame.locator('[role=link], [role=button]').first().click()]);
  await popup.waitForLoadState('domcontentloaded');
  await popup.waitForTimeout(6000);
  const fill = (n, v) => popup.locator(`input[name=${n}], input#${n}`).first().fill(v);
  // PayPal sandbox test card and a synthetic guest identity.
  await fill('cardnumber', card); await fill('exp-date', '12/30'); await fill('cvv', '123');
  await fill('fname', 'Synthetic'); await fill('lname', 'Payer');
  await fill('billingLine1', '1 Test Street'); await fill('billingCity', 'San Jose');
  await popup.locator('select[name=billingState]').selectOption('CA'); await fill('billingPostalCode', '95131');
  await fill('phone', '4085550123'); await fill('email', `headroom-payer-${Date.now().toString(36)}@example.com`);
  // Some sessions default "Save info & create your PayPal account" on, which swaps the button for
  // "Create Account & Pay Now". Never create an account: switch it off and pay as a guest.
  const guest = popup.getByRole('button', { name: 'Pay now as guest' });
  if (!(await guest.isVisible())) {
    // The switch is a zero-width input[role=switch]; its visible label isn't a <label>, so click the input itself.
    const save = popup.locator('input[role=switch]:checked');
    if (await save.count()) await save.first().evaluate((e) => e.click());
    if (await popup.locator('input[role=switch]:checked').count()) throw new Error('could not switch off "Save info & create your PayPal account"');
  }
  await popup.screenshot({ path: join(out, 'popup-before-pay.png'), fullPage: true }).catch(() => {});
  await guest.click({ timeout: 30_000 });
  for (let i = 0; i < 4 && !popup.isClosed(); i++) { await popup.waitForTimeout(2000).catch(() => {}); await popup.screenshot({ path: join(out, `popup-after-click-${i}.png`), fullPage: true }).catch(() => {}); }
  await Promise.race([popup.waitForEvent('close', { timeout: 60_000 }), page.waitForTimeout(60_000)]).catch(() => {});
  await page.waitForTimeout(6000);
  await page.screenshot({ path: join(out, 'after-pay.png'), fullPage: true });
  const after = await text();
  const ok = /successful|paid|thank/i.test(after);
  console.log(ok ? 'PAID: PayPal reported the guest payment as successful' : `UNCONFIRMED: ${after.slice(0, 300)}`);
  process.exit(ok ? 0 : 1);
} catch (e) {
  // Keep what PayPal showed, so a changed or slow hosted page can be diagnosed.
  for (const [i, p] of ctx.pages().entries()) await p.screenshot({ path: join(out, `failed-page-${i}.png`), fullPage: true }).catch(() => {});
  throw e;
} finally {
  await browser.close();
}
