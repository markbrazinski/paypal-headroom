// AUTOMATED-PAYER (owner decision 1 Nov 2026; S7 O5/R3): a sandbox personal account pays a PayPal SANDBOX invoice on PayPal's own hosted
// page (gold PayPal button → login popup → review → Complete Purchase). Proven live 3 Nov 2026 (S7b B0: exact $2.00 partial, then the
// $3.00 remainder, both captures COMPLETED by GET). It never decides anything: the caller gives the exact amount; the receipt still comes
// only from PayPal's invoice and capture GETs. `submitted` is a hint: once the purchase button may have been pressed, the caller treats
// the attempt as possibly paid and only verifies (never presses again).
import type { Browser, Page } from 'playwright-core';

export interface PayerRequest { url: string; amountMinor: number; partial: boolean }
export interface PayerResult { phaseReached: 'NOT_SUBMITTED' | 'SUBMITTED'; error: string | null; screenshots: { name: string; png: Buffer }[] }
export interface PayerCredentials { email: string; password: string }
export interface Payer { pay(r: PayerRequest): Promise<PayerResult> }

const LINK = /^https:\/\/www\.sandbox\.paypal\.com\/invoice\/p\/#[A-Z0-9-]+$/;
const decimal = (minor: number) => (minor / 100).toFixed(2);

/** Runs one payment in a fresh browser context; `launch` supplies the browser (local Chrome, or @sparticuz/chromium in Lambda). */
export function hostedPayer(launch: () => Promise<Browser>, creds: PayerCredentials): Payer {
  return {
    async pay(r) {
      if (!LINK.test(r.url)) return { phaseReached: 'NOT_SUBMITTED', error: 'Refused: not a sandbox.paypal.com invoice payer link', screenshots: [] };
      const shots: { name: string; png: Buffer }[] = [];
      let submitted = false;
      let browser: Browser | undefined;
      const shot = async (p: Page, name: string) => { try { shots.push({ name, png: await p.screenshot({ fullPage: true }) }); } catch { /* keep going */ } };
      try {
        browser = await launch(); // a launch failure is NOT_SUBMITTED: nothing reached PayPal
        const ctx = await browser.newContext({ viewport: { width: 1200, height: 1600 } });
        const page = await ctx.newPage();
        await page.goto(r.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await page.waitForTimeout(5_000);
        const body = (await page.innerText('body')).replace(/\s+/g, ' ');
        if (/Amount due \$0\.00|This invoice (has been|is) paid/i.test(body)) return { phaseReached: 'NOT_SUBMITTED', error: 'PayPal shows this invoice as already paid', screenshots: shots };
        const cont = page.getByRole('button', { name: 'Continue to Payment' });
        if (await cont.count()) { await cont.click({ timeout: 30_000 }); await page.waitForTimeout(4_000); }
        if (r.partial) {
          const opts = page.locator('input[name=payment_option]');
          if ((await opts.count()) < 2) return { phaseReached: 'NOT_SUBMITTED', error: 'This invoice offers no partial payment', screenshots: shots };
          await opts.nth(1).check({ force: true });
          await page.waitForTimeout(800);
          await page.locator('input[type=text], input[inputmode=decimal], input[type=number]').first().fill(decimal(r.amountMinor));
          await page.waitForTimeout(1_500);
        }
        await shot(page, 'amount');
        let frame;
        for (let i = 0; i < 30 && !frame; i++) { frame = page.frames().find((f) => f.url().includes('smart/buttons') && f.url().includes('style.color=gold')); if (!frame) await page.waitForTimeout(1_000); }
        if (!frame) return { phaseReached: 'NOT_SUBMITTED', error: 'PayPal button not found on the hosted page', screenshots: shots };
        const [popup] = await Promise.all([ctx.waitForEvent('page', { timeout: 30_000 }), frame.locator('[role=link], [role=button]').first().click()]);
        await popup.waitForLoadState('domcontentloaded');
        await popup.waitForTimeout(5_000);
        const email = popup.locator('input#email, input[name=login_email]').first();
        if (await email.count()) {
          await email.fill(creds.email);
          const next = popup.locator('#btnNext');
          if (await next.isVisible().catch(() => false)) { await next.click(); await popup.waitForTimeout(3_000); }
        }
        await popup.locator('input#password, input[name=login_password]').first().fill(creds.password);
        await popup.getByRole('button', { name: 'Log In', exact: true }).click();
        await popup.waitForTimeout(8_000);
        await shot(popup, 'review');
        // The review must show exactly the amount we were asked to pay; anything else is never submitted.
        const review = (await popup.innerText('body').catch(() => '')).replace(/\s+/g, ' ');
        if (!review.includes(`$${Number(decimal(r.amountMinor)).toLocaleString('en-US', { minimumFractionDigits: 2 })}`)) return { phaseReached: 'NOT_SUBMITTED', error: `PayPal's review doesn't show ${decimal(r.amountMinor)}`, screenshots: shots };
        const pay = popup.getByRole('button', { name: 'Complete Purchase', exact: true });
        if (!(await pay.count())) return { phaseReached: 'NOT_SUBMITTED', error: 'No "Complete Purchase" on PayPal\'s review', screenshots: shots };
        submitted = true; // from here on the attempt may have paid
        await pay.click({ timeout: 30_000 });
        await Promise.race([popup.waitForEvent('close', { timeout: 60_000 }), page.waitForTimeout(60_000)]).catch(() => {});
        await page.waitForTimeout(5_000);
        await shot(page, 'after');
        return { phaseReached: 'SUBMITTED', error: null, screenshots: shots };
      } catch (e) {
        return { phaseReached: submitted ? 'SUBMITTED' : 'NOT_SUBMITTED', error: String((e as Error).message ?? e).slice(0, 300), screenshots: shots };
      } finally {
        await browser?.close().catch(() => {});
      }
    },
  };
}
