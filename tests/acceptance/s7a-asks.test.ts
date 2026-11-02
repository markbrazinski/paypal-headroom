// S7a layer 3 (S07 §6.18 R6): the Keller ask. Code-made options (KEEP / SPLIT), sent through the mail path under the rule, a grounded
// reply recorded as an answer that changes nothing, and the owner's accept (fenced, refused once a payout holds the payment).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.ts';
import { FakeReplier, items, MON_10AM, reply, TUE_0805, type H } from './s5-helpers.ts';

async function setup(o: { rule?: 'NEEDS_YOU' | 'WITHOUT_REVIEW' } = {}) {
  const replier = new FakeReplier();
  const h = await harness({ plaid: true, hero: true, paypalMinor: 180_000, start: MON_10AM, mail: { redirectTo: null }, replier });
  await h.drain();
  if (o.rule === 'WITHOUT_REVIEW') {
    const pv = await h.api('POST', '/v1/delegation/preview', { key: 'ap.askSuppliers', scope: 'EVERYWHERE', value: 'WITHOUT_REVIEW' });
    assert.equal((await h.api('POST', '/v1/delegation/rules', { key: 'ap.askSuppliers', scope: 'EVERYWHERE', value: 'WITHOUT_REVIEW', previewHash: pv.body.previewHash }, { 'if-match': '1' })).status, 200);
  }
  const inj = await h.inject('hero');
  let b = await h.bill(inj.billId);
  await h.api('POST', `/v1/bills/${b.bill.billId}/verify`, { occurrenceKey: b.occurrence.occurrenceKey, occurrenceVersion: b.occurrence.version }, { 'if-match': String(b.bill.version) });
  b = await h.bill(inj.billId);
  assert.equal((await h.api('POST', `/v1/bills/${b.bill.billId}/accept-terms`, { termsHash: b.termsHash, changedFields: b.changedFields }, { 'if-match': String(b.bill.version) })).status, 200);
  assert.ok([200, 202].includes((await h.api('POST', '/v1/plan/revisions', {})).status)); // O6: it may already be building by itself
  await h.drain();
  return { h, replier, billId: inj.billId };
}
const plan = async (h: H) => (await h.api('GET', '/v1/plan')).body;
const askOf = (rev: any) => [...rev.actions, ...rev.considered].find((a: any) => a.kind === 'ASK_SUPPLIER' || /keep|split/i.test(a.title ?? ''));

test('S7 R6 options: KEEP Dec 3, or SPLIT $1,400 now + $8,600 Dec 3 (the largest $100 step that keeps the reserve through Dec 3)', async () => {
  const { h } = await setup();
  const rev = (await plan(h)).revision;
  const acts = await items(h, 'ACT#');
  const ask = acts.find((a) => a.kind === 'ASK_SUPPLIER')!;
  assert.ok(ask, 'the ask is a real candidate');
  assert.deepEqual([ask.decision, ask.consideredReason], ['OUT', 'An option: add it to ask the supplier to keep the date or split it'], 'template: optional, not in the default hero');
  const o = ask.terms.askOptions;
  assert.deepEqual(o.map((x: any) => [x.code, x.parts.map((p: any) => [p.dueOn, p.amount.minor])]), [
    ['KEEP', [[h.day0() <= '2026-11-09' ? '2026-12-03' : '', 1_000_000]]],
    ['SPLIT', [['2026-11-13', 140_000], ['2026-12-03', 860_000]]],
  ]);
  assert.match(ask.message.body, /Could we keep Thu, Dec 3\? If that doesn't work, could we pay \$1,400\.00 on Fri, Nov 13 and \$8,600\.00 on Thu, Dec 3\?/);
  assert.equal(ask.authority.decision, 'REQUIRES_APPROVAL', 'ap.askSuppliers default: you approve the wording');
  assert.ok(rev);
});

test('S7-A14/R22/R37/R38 included → sent to Keller without review under the rule → reply agreeing to SPLIT → Needs you; a reply alone changes nothing; you accept → two payments', async () => {
  const { h, replier, billId } = await setup({ rule: 'WITHOUT_REVIEW' });
  let rev = (await plan(h)).revision;
  const ask = (await items(h, 'ACT#')).find((a) => a.kind === 'ASK_SUPPLIER')!;
  assert.equal(ask.decision, 'IN', 'O1 / S7a-IR-06: under WITHOUT_REVIEW the ask is in the plan by itself');
  const card = rev.actions.find((a: any) => a.kind === 'ASK_SUPPLIER');
  assert.equal(card.authority.decision, 'ALLOW', 'WITHOUT_REVIEW: runs under the rule');
  assert.equal((await h.api('POST', `/v1/plan/revisions/${rev.revisionId}/approve`, { selected: rev.approval.selected, consentHash: rev.approval.consentHash }, { 'if-match': String(rev.version) })).status, 200);
  h.setNow(TUE_0805);
  for (let i = 0; i < 3; i++) { await h.drain(); await h.advance(61_000); }
  const out = (await items(h, 'OUTMSG#')).find((o) => o.counterpartyRole === 'SUPPLIER');
  assert.deepEqual([out?.state, out?.to], ['SENT', 'billing@keller.example'], JSON.stringify((await items(h, 'OUTMSG#')).map((o) => [o.customerId, o.state, o.reason])));
  const occBefore = (await h.bill(billId)).occurrence;
  // R37: a counter (different amounts) → recorded as COUNTER, nothing changes.
  replier.next = { intent: 'TERMS_AGREED', quote: 'We can do $2,000 on Nov 13 and $8,000 on Dec 3.', quotedDate: null, quotedAmount: null, termsQuotes: [{ date: 'Nov 13', amount: '$2,000' }, { date: 'Dec 3', amount: '$8,000' }] };
  await reply(h, { from: 'billing@keller.example', text: 'Hi, We can do $2,000 on Nov 13 and $8,000 on Dec 3. Thanks', inReplyTo: out!.rfcMessageId });
  replier.next = { intent: 'TERMS_AGREED', quote: 'Fine: $1,400 on Nov 13 and $8,600 on Dec 3.', quotedDate: null, quotedAmount: null, termsQuotes: [{ date: 'Nov 13', amount: '$1,400' }, { date: 'Dec 3', amount: '$8,600' }] };
  await reply(h, { from: 'billing@keller.example', text: 'Fine: $1,400 on Nov 13 and $8,600 on Dec 3.', inReplyTo: out!.rfcMessageId });
  const answers = (await items(h, 'SUPPLIERANSWER#')).sort((a, z) => (a.at < z.at ? -1 : 1));
  assert.deepEqual(answers.map((a) => [a.intent, a.matched, a.state]), [['TERMS_COUNTER', null, 'OPEN'], ['TERMS_AGREED', 'SPLIT', 'OPEN']]);
  const b = await h.bill(billId);
  assert.deepEqual([b.occurrence.dueOn, b.occurrence.amount.minor], [occBefore.dueOn, occBefore.amount.minor], 'R22: a reply alone changes nothing');
  assert.ok((await h.overview()).needs.some((n: any) => n.key.startsWith('answer:')), 'Needs you');
  const asks = b.asks;
  assert.equal(asks.length, 1);
  assert.equal(asks[0].answers.length, 2);
  const agreed = answers[1];
  // R38: an option that wasn't offered is refused.
  const bad = await h.api('POST', `/v1/payables/asks/${encodeURIComponent(ask.rootId)}/accept`, { answerId: agreed.answerId, option: 'SPLIT', obligationVersion: asks[0].obligationVersion - 1, billVersion: asks[0].billVersion });
  assert.equal(bad.body.code, 'VERSION_CONFLICT', 'fenced on the payment version');
  const ok = await h.api('POST', `/v1/payables/asks/${encodeURIComponent(ask.rootId)}/accept`, { answerId: agreed.answerId, option: 'SPLIT', obligationVersion: asks[0].obligationVersion, billVersion: asks[0].billVersion });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const f = await h.forecast();
  const kel = f.days.flatMap((d: any) => d.items).filter((i: any) => /Keller/.test(i.label));
  assert.deepEqual(kel.map((i: any) => [i.on, i.amount?.minor ?? i.amountMinor]).sort(), [['2026-11-13', 140_000], ['2026-12-03', 860_000]], JSON.stringify(kel));
  const terms = (await items(h, 'TERMS#')).find((t) => t.source === agreed.answerId);
  assert.equal(terms?.by, 'owner-a@example.com');
  assert.equal((await h.api('POST', `/v1/payables/asks/${encodeURIComponent(ask.rootId)}/accept`, { answerId: agreed.answerId, option: 'SPLIT', obligationVersion: asks[0].obligationVersion, billVersion: asks[0].billVersion })).body.code, 'VERSION_CONFLICT', 'once');
});

test('S7 R6 PAYOUT_IN_FLIGHT: once a payout holds the payment, an answer can no longer re-term it', async () => {
  const { h, replier, billId } = await setup({ rule: 'WITHOUT_REVIEW' });
  let rev = (await plan(h)).revision;
  const ask = (await items(h, 'ACT#')).find((a) => a.kind === 'ASK_SUPPLIER')!;
  await h.api('POST', `/v1/plan/revisions/${rev.revisionId}/approve`, { selected: rev.approval.selected, consentHash: rev.approval.consentHash }, { 'if-match': String(rev.version) });
  h.setNow(TUE_0805);
  for (let i = 0; i < 3; i++) { await h.drain(); await h.advance(61_000); }
  const out = (await items(h, 'OUTMSG#')).find((o) => o.counterpartyRole === 'SUPPLIER')!;
  replier.next = { intent: 'TERMS_AGREED', quote: 'OK, keep Dec 3.', quotedDate: null, quotedAmount: null, termsQuotes: [{ date: 'Dec 3', amount: null }] };
  await reply(h, { from: 'billing@keller.example', text: 'OK, keep Dec 3.', inReplyTo: out.rfcMessageId });
  const [ans] = await items(h, 'SUPPLIERANSWER#');
  assert.deepEqual([ans.intent, ans.matched], ['TERMS_AGREED', 'KEEP'], 'a date-only "keep Dec 3" matches KEEP');
  // The payout queue TX reserved the payment (simulated here by its marker): accepting is refused.
  const obl = (await items(h, 'OBL#')).find((o) => o.commitmentId === 'cmt-keller-ms2')!;
  await h.store.transact([{ op: 'update', table: 'core', pk: obl.pk, sk: obl.sk, set: { payment: { effectKey: 'payout:test', stage: 'RESERVED' } }, add: { version: 1 } }]);
  const asks = (await h.bill(billId)).asks;
  const r = await h.api('POST', `/v1/payables/asks/${encodeURIComponent(ask.rootId)}/accept`, { answerId: ans.answerId, option: 'KEEP', obligationVersion: asks[0].obligationVersion, billVersion: asks[0].billVersion });
  assert.deepEqual([r.status, r.body.code], [409, 'PAYOUT_IN_FLIGHT']);
});

test('S7-R39 a duplicate reply is one answer; a reply that isn’t threaded to the ask changes nothing', async () => {
  const { h, replier } = await setup({ rule: 'WITHOUT_REVIEW' });
  const rev = (await plan(h)).revision;
  await h.api('POST', `/v1/plan/revisions/${rev.revisionId}/approve`, { selected: rev.approval.selected, consentHash: rev.approval.consentHash }, { 'if-match': String(rev.version) });
  h.setNow(TUE_0805);
  for (let i = 0; i < 3; i++) { await h.drain(); await h.advance(61_000); }
  const out = (await items(h, 'OUTMSG#')).find((o) => o.counterpartyRole === 'SUPPLIER')!;
  replier.next = { intent: 'TERMS_AGREED', quote: 'OK, keep Dec 3.', quotedDate: null, quotedAmount: null, termsQuotes: [{ date: 'Dec 3', amount: null }] };
  await reply(h, { from: 'billing@keller.example', text: 'OK, keep Dec 3.', inReplyTo: out.rfcMessageId });
  // The same message seen again by the next sync is the same MAIL# (one answer); a second, unthreaded email from Keller has no ask.
  await h.advance(61_000); await h.drain();
  await reply(h, { from: 'billing@keller.example', text: 'OK, keep Dec 3.', inReplyTo: null });
  assert.equal((await items(h, 'SUPPLIERANSWER#')).length, 1);
  const unthreaded = (await items(h, 'MAIL#')).filter((m) => !m.binding?.rootId);
  assert.equal(unthreaded.length, 1);
  assert.notEqual(unthreaded[0].processing, 'ROUTED', 'not read as an answer');
});
