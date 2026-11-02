// S7a scenario builders shared by the REPLAY browser server (scripts/verify/s7-replay-server.ts): real S1–S6 upstream, the
// simulated mailbox and a FAKE ReplyInterpreter (its quotes still pass the real gate), fake PayPal. Never a payment or a real email.
import assert from 'node:assert/strict';
import { harness } from './harness.ts';
import { b64url, buildMessage } from '../../backend/src/adapters/mail/rfc5322.ts';
import { FakeReplier, invOf, items, MON_10AM, reply, TUE_0805, type H } from './s5-helpers.ts';

export const HARROW_TEXT = 'Hello, about the invoice: we accept the $7,200 for the agreed scope and dispute the $1,800 change order.';
export const HARROW_SPLIT = { intent: 'DISPUTE_PARTIAL', quote: 'we accept the $7,200 for the agreed scope and dispute the $1,800 change order.', quotedDate: null, quotedAmount: null, amountQuotes: { disputed: 'the $1,800 change order', undisputed: 'the $7,200' } };

export async function originalEmail(h: H, o: { from: string; subject: string; text: string }) {
  const raw = buildMessage({ from: o.from, to: ['larkspur+headroom@headroom.example'], subject: o.subject, text: o.text, messageId: `<d.${Math.random().toString(36).slice(2)}@customer.example>`, inReplyTo: null, references: [], date: h.clock(), attachments: [] });
  await h.mailbox.inject({ raw: b64url.encode(raw), auth: { source: 'SIMULATED', dkim: 'pass', spf: 'pass', dmarc: 'pass' } });
  await h.advance(61_000);
  await h.drain();
}

async function heroBill(h: H) {
  const inj = await h.inject('hero');
  let b = await h.bill(inj.billId);
  await h.api('POST', `/v1/bills/${b.bill.billId}/verify`, { occurrenceKey: b.occurrence.occurrenceKey, occurrenceVersion: b.occurrence.version }, { 'if-match': String(b.bill.version) });
  b = await h.bill(inj.billId);
  assert.equal((await h.api('POST', `/v1/bills/${b.bill.billId}/accept-terms`, { termsHash: b.termsHash, changedFields: b.changedFields }, { 'if-match': String(b.bill.version) })).status, 200);
  assert.ok([200, 202].includes((await h.api('POST', '/v1/plan/revisions', {})).status)); // O6: it may already be building by itself
  await h.drain();
  return inj.billId;
}

/** Harrow's dispute email waiting for the owner (EMAIL reset, hero bill accepted, plan drafted). */
export async function disputePending(): Promise<H> {
  const replier = new FakeReplier();
  const h = await harness({ plaid: true, hero: true, paypalMinor: 180_000, start: MON_10AM, mail: { redirectTo: null }, dispute: 'EMAIL', replier });
  await h.drain();
  await h.advance(61_000); await h.drain();
  const harrow = await invOf(h, 'cust-harrow');
  replier.next = HARROW_SPLIT;
  await originalEmail(h, { from: 'Harrow Developments <accounts.harrow@example.com>', subject: `Invoice ${harrow.invoiceNumber}`, text: HARROW_TEXT });
  await heroBill(h);
  return h;
}

/** The Keller ask sent under WITHOUT_REVIEW and Keller's reply agreeing to the split, waiting for the owner. */
export async function kellerAnswered(): Promise<H> {
  const replier = new FakeReplier();
  const h = await harness({ plaid: true, hero: true, paypalMinor: 180_000, start: MON_10AM, mail: { redirectTo: null }, replier });
  await h.drain();
  const pv = await h.api('POST', '/v1/delegation/preview', { key: 'ap.askSuppliers', scope: 'EVERYWHERE', value: 'WITHOUT_REVIEW' });
  await h.api('POST', '/v1/delegation/rules', { key: 'ap.askSuppliers', scope: 'EVERYWHERE', value: 'WITHOUT_REVIEW', previewHash: pv.body.previewHash }, { 'if-match': '1' });
  await heroBill(h);
  let rev = (await h.api('GET', '/v1/plan')).body.revision;
  await h.api('POST', `/v1/plan/revisions/${rev.revisionId}/approve`, { selected: rev.approval.selected, consentHash: rev.approval.consentHash }, { 'if-match': String(rev.version) });
  h.setNow(TUE_0805);
  for (let i = 0; i < 3; i++) { await h.drain(); await h.advance(61_000); }
  const out = (await items(h, 'OUTMSG#')).find((o) => o.counterpartyRole === 'SUPPLIER')!;
  replier.next = { intent: 'TERMS_AGREED', quote: 'Fine: $1,400 on Nov 13 and $8,600 on Dec 3.', quotedDate: null, quotedAmount: null, termsQuotes: [{ date: 'Nov 13', amount: '$1,400' }, { date: 'Dec 3', amount: '$8,600' }] };
  await reply(h, { from: 'billing@keller.example', text: 'Hi, Fine: $1,400 on Nov 13 and $8,600 on Dec 3. Thanks', inReplyTo: out.rfcMessageId });
  return h;
}
