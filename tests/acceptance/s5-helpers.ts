// Shared S5 acceptance setup (S05 §6.11 layer 3): real S1–S4 upstream, REPLAY fake PayPal (PUT as observed on the sandbox),
// the labelled SIMULATED mailbox. Captures are made by the fake and are never evidence of a payment.
import assert from 'node:assert/strict';
import { minorToDecimal } from '@headroom/contracts';
import { harness } from './harness.ts';
import { K } from '../../backend/src/adapters/store/keys.ts';
import type { Interpreter, InterpretResult } from '../../backend/src/adapters/bedrock/converse.ts';
import { b64url, buildMessage } from '../../backend/src/adapters/mail/rfc5322.ts';

export const MON_10AM = '2026-11-09T15:00:00.000Z'; // hero day 0, 10:00 New York
export const TUE_0805 = '2026-11-10T13:05:00.000Z';
export const WED_0900 = '2026-11-11T14:00:00.000Z';
export const FEES = { pellow: 26_573, harrow: 25_177 }; // hero v1a: nets 733427 / 694823
export type H = Awaited<ReturnType<typeof harness>>;
export const amt = (minor: number) => ({ currency_code: 'USD', value: minorToDecimal(minor) });

/** Hero breach → template plan built and approved (S4), with a baseline report row so PayPal reconciliation can PASS. */
export async function approved(o: Parameters<typeof harness>[0] = {}) {
  const h = await harness({ plaid: true, hero: true, paypalMinor: 180_000, start: MON_10AM, mail: { redirectTo: null }, ...o });
  h.pp.rows = [{ transaction_id: 'BASELINE-1', transaction_event_code: 'T0000', transaction_status: 'S', transaction_initiation_date: '2026-11-08T12:00:00Z', transaction_amount: amt(180_000), available_balance: amt(180_000) }];
  await h.api('POST', '/v1/cash/paypal/refresh');
  await h.drain();
  const inj = await h.inject('hero');
  let b = await h.bill(inj.billId);
  await h.api('POST', `/v1/bills/${b.bill.billId}/verify`, { occurrenceKey: b.occurrence.occurrenceKey, occurrenceVersion: b.occurrence.version }, { 'if-match': String(b.bill.version) });
  b = await h.bill(inj.billId);
  assert.equal((await h.api('POST', `/v1/bills/${b.bill.billId}/accept-terms`, { termsHash: b.termsHash, changedFields: b.changedFields }, { 'if-match': String(b.bill.version) })).status, 200);
  assert.ok([200, 202].includes((await h.api('POST', '/v1/plan/revisions', {})).status)); // O6: it may already be building by itself
  await h.drain();
  const rev = (await h.api('GET', '/v1/plan')).body.revision;
  const ap = await h.api('POST', `/v1/plan/revisions/${rev.revisionId}/approve`, { selected: rev.approval.selected, consentHash: rev.approval.consentHash }, { 'if-match': String(rev.version) });
  assert.equal(ap.status, 200, JSON.stringify(ap.body));
  return { h, rev };
}
export const pk = (h: H) => K.run(h.tenantId, h.run!.runId);
export const items = (h: H, p: string) => h.store.query('core', pk(h), { skPrefix: p });
export const actionOf = async (h: H, kind: string) => (await items(h, 'ACT#')).find((a) => a.kind === kind && a.state !== 'SUPERSEDED')!;
export const invOf = async (h: H, cust: string) => (await items(h, 'INV#')).find((i) => i.customerId === cust)!;
export const puts = (h: H) => h.pp.count('PUT');

/** Customers pay through the fake at `now` (after PayPal's as-of: captured, not yet in the report). */
export async function pay(h: H, cust: 'cust-pellow' | 'cust-harrow' | 'cust-mercer', grossMinor: number, feeMinor: number) {
  const inv = await invOf(h, cust);
  const cap = h.pp.pay(inv.ppInvoiceId, { grossMinor, feeMinor, createTime: h.clock() });
  await h.api('POST', `/v1/invoices/${inv.invoiceId}/refresh`);
  await h.drain();
  return { cap, inv };
}
/** PayPal's next report includes these captures: balance moves by net, rows carry the running balance. */
export async function report(h: H, caps: { cap: string; gross: number; fee: number; number: string }[]) {
  let bal = h.pp.balance.availableMinor;
  for (const c of caps) {
    bal += c.gross - c.fee;
    h.pp.rows.push({ transaction_id: c.cap, transaction_event_code: 'T0006', transaction_status: 'S', transaction_initiation_date: new Date(Date.parse(h.clock()) - 10 * 60_000).toISOString().replace('.000', ''), transaction_amount: amt(c.gross), fee_amount: { currency_code: 'USD', value: `-${minorToDecimal(c.fee)}` }, available_balance: amt(bal), invoice_id: c.number });
  }
  h.pp.balance = { ...h.pp.balance, availableMinor: bal, asOf: h.clock() };
}
export const scenario = async (h: H, sc: string) => {
  const { handle } = await import('../../backend/src/handlers/router.ts');
  return JSON.parse((await handle({ store: h.store, queue: h.queue, config: h.deps.config, now: h.clock, evidence: h.evidence }, { method: 'GET', path: '/v1/cash/forecast', query: { scenario: sc }, headers: {}, body: undefined, identity: { sub: 'owner-a', email: 'owner-a@example.com' } })).body);
};
/** PayPal's report lags real time (~2 h, probe 01): its as-of moves with the clock, rows only for what it includes. */
export const lagReport = (h: H, lagMs = 2 * 3600_000) => { h.pp.balance = { ...h.pp.balance, asOf: new Date(Date.parse(h.clock()) - lagMs).toISOString() }; };
/** Run the Mercer check: run 1 (lock, PayPal refresh, bank sync request), then run 2 after the bank read. */
export async function check(h: H) {
  await h.drain();
  await h.advance(20_000);
  await h.drain();
  const a = await actionOf(h, 'DISCOUNT_FALLBACK');
  const chk = a.lastCheckId ? await h.store.get('core', pk(h), a.lastCheckId) : null;
  return { a, chk };
}


// Moved from s5-inbox.test.ts so S7 cases reuse them.
/** FAKE ReplyInterpreter: answers with the scripted output (verbatim quotes are still checked by the real gate). */
export class FakeReplier implements Interpreter {
  modelId = 'FAKE';
  next: unknown = null;
  async interpret(): Promise<InterpretResult> { return { outputText: JSON.stringify(this.next), inputTokens: 300, outputTokens: 60, latencyMs: 5 }; }
}
export const PELLOW = 'accounts.pellow@example.com';
export async function reply(h: H, o: { from: string; text: string; inReplyTo: string | null; auth?: 'pass' | 'fail'; pdf?: Buffer }) {
  const raw = buildMessage({ from: o.from, to: ['headroom@headroom.example'], subject: 'Re: invoice', text: o.text, messageId: `<r.${Math.random().toString(36).slice(2)}@pellow.example>`, inReplyTo: o.inReplyTo, references: o.inReplyTo ? [o.inReplyTo] : [], date: h.clock(), attachments: o.pdf ? [{ name: 'K-2207.pdf', mime: 'application/pdf', bytes: o.pdf }] : [] });
  const pass = (o.auth ?? 'pass') === 'pass' ? 'pass' : 'fail';
  await h.mailbox.inject({ raw: b64url.encode(raw), auth: { source: 'SIMULATED', dkim: pass, spf: pass, dmarc: pass } });
  await h.advance(61_000); // MAIL_SYNC runs on its schedule
  await h.drain();
}
export const pellowOut = async (h: H) => (await items(h, 'OUTMSG#')).find((o) => o.customerId === 'cust-pellow')!;

