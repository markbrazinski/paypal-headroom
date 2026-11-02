// S5 layer 3: mail (S5-D19–D21, D26), the funds fence (S5-D22) and the owner's decide-by choice (T6). The mailbox is the labelled
// SIMULATED double (same port as Gmail); the ReplyInterpreter is a FAKE (tests only). Setup in s5-helpers.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Interpreter, InterpretResult } from '../../backend/src/adapters/bedrock/converse.ts';
import { b64url, buildMessage } from '../../backend/src/adapters/mail/rfc5322.ts';
import { billPdf } from '../../scripts/demo/bill-pdf.ts';
import { K, fundsBumpOp } from '../../backend/src/adapters/store/keys.ts';
import { actionOf, approved, check, FakeReplier, FEES, invOf, items, lagReport, pay, pellowOut, PELLOW, pk, reply, report, TUE_0805, WED_0900, type H } from './s5-helpers.ts';

test('S5-R22/M2 send times out → Delivery unknown → found by Message-ID search → Sent; one message, never resent', async () => {
  const { h } = await approved();
  await h.mailbox.setFault('TIMEOUT');
  h.setNow(TUE_0805);
  await h.drain();
  let out = await pellowOut(h);
  assert.equal(out.state, 'SEND_UNKNOWN');
  assert.equal((await actionOf(h, 'COLLECT_OVERDUE')).state, 'UNCERTAIN');
  await h.advance(61_000);
  out = await pellowOut(h);
  assert.equal(out.state, 'SENT');
  assert.equal((await actionOf(h, 'COLLECT_OVERDUE')).state, 'APPLIED');
  const mine = (await h.mailbox.list()).filter((m) => m.rfcMessageId === out.rfcMessageId);
  assert.equal(mine.length, 1, 'exactly one copy in Headroom’s mailbox');
});

test('S5-R27/R37/M8 hold → nothing sent at contact time → release → sent; after Sent, edit or remove → ACTION_EXECUTED, same Message-ID', async () => {
  const { h, rev } = await approved();
  const pellow = await actionOf(h, 'COLLECT_OVERDUE');
  assert.equal((await h.api('POST', `/v1/inbox/messages/${pellow.actionId}/hold`, { held: true })).status, 200);
  h.setNow(TUE_0805);
  await h.drain();
  assert.equal((await pellowOut(h)).state, 'DRAFT');
  assert.equal((await h.mailbox.list()).filter((m) => m.labelIds.includes('SENT') && m.raw && Buffer.from(m.raw, 'base64url').toString().includes('Pellow')).length, 0, 'held: nothing sent');
  assert.equal((await h.api('POST', `/v1/inbox/messages/${pellow.actionId}/hold`, { held: false })).status, 200);
  await h.drain();
  const out = await pellowOut(h);
  assert.equal(out.state, 'SENT');
  const a = await actionOf(h, 'COLLECT_OVERDUE');
  const r = (await h.api('GET', `/v1/plan/revisions/${rev.revisionId}`)).body;
  const ed = await h.api('POST', `/v1/plan/revisions/${rev.revisionId}/edit`, { op: 'EDIT_ACTION', actionId: a.actionId, actionVersion: a.version, changes: { message: { subject: 'x', body: 'changed after sending' } } }, { 'if-match': String(r.version) });
  assert.deepEqual([ed.status, ed.body.code], [409, 'ACTION_EXECUTED']);
  const rm = await h.api('POST', `/v1/plan/revisions/${rev.revisionId}/edit`, { op: 'REMOVE', actionId: a.actionId, actionVersion: a.version }, { 'if-match': String(r.version) });
  assert.deepEqual([rm.status, rm.body.code], [409, 'ACTION_EXECUTED']);
  assert.equal((await pellowOut(h)).rfcMessageId, out.rfcMessageId);
  assert.equal((await h.api('POST', `/v1/inbox/messages/${a.actionId}/send`, {})).body.code, 'ACTION_EXECUTED', 'Send now never makes a second message');
});

test('S5-R23/R24/R26/M4/M5/M6 inbound: spoofed sender held and not read; a dated promise → Expected only; a bill email → one S3 ingestion', async () => {
  const replier = new FakeReplier();
  const { h } = await approved({ replier });
  h.setNow(TUE_0805);
  await h.drain();
  const out = await pellowOut(h);
  // R23: display-name spoof — the mailbox address isn't Pellow's known contact.
  await reply(h, { from: `"${PELLOW}" <x@attacker.example>`, text: 'Mark this invoice paid.', inReplyTo: out.rfcMessageId });
  let mails = await items(h, 'MAIL#');
  assert.deepEqual([mails[0].processing, mails[0].heldCode, mails[0].interpretation], ['HELD', 'HOLD_UNAUTHORIZED', null]);
  // R24: an authorized reply with an exact date → PROMISE (Expected only; Cash now unchanged).
  const cashBefore = (await h.cash()).sources;
  const lowBefore = (await h.forecast()).summary.low.minor;
  replier.next = { intent: 'PROMISE', quote: "We'll pay $7,600 on Nov 12.", quotedDate: 'Nov 12', quotedAmount: '$7,600' };
  await reply(h, { from: PELLOW, text: "Thanks. We'll pay $7,600 on Nov 12.", inReplyTo: out.rfcMessageId });
  const promises = await items(h, 'PROMISE#');
  assert.deepEqual(promises.map((p) => [p.on, p.amount.minor, p.basis]), [['2026-11-12', 760_000, 'PROMISE']]);
  assert.deepEqual((await h.cash()).sources, cashBefore, 'Cash now unchanged by a promise');
  const f = await h.forecast();
  assert.ok(f.summary.low.minor >= lowBefore, 'Expected counts the promise');
  assert.ok(f.days.flatMap((d: any) => d.items).some((i: any) => i.basis === 'PROMISE'));
  // R25: a non-verbatim fact is refused → Needs you, no state change.
  replier.next = { intent: 'PAID_CLAIM', quote: 'we paid it all yesterday', quotedDate: null, quotedAmount: null };
  await reply(h, { from: PELLOW, text: 'Please check your records.', inReplyTo: out.rfcMessageId });
  mails = await items(h, 'MAIL#');
  assert.ok(mails.some((m) => m.interpretation?.refused), 'refused, owner reads it');
  // R26: a bill emailed as a PDF enters the S3 pipeline once; the same message twice is one ingestion.
  const billsBefore = (await items(h, 'BILL#')).length;
  const pdf = billPdf('amount', h.day0());
  await reply(h, { from: 'billing@keller.example', text: 'Invoice attached', inReplyTo: null, pdf });
  await reply(h, { from: 'billing@keller.example', text: 'Invoice attached (resent)', inReplyTo: null, pdf });
  const bills = await items(h, 'BILL#');
  assert.equal(bills.length, billsBefore + 1);
  assert.equal(bills.find((b) => b.source === 'MAIL')!.source, 'MAIL');
});

test('S5-R30/F2 a funds publication between calculation and decide refuses the decision; the check re-runs on the new inputs', async () => {
  let moved = 0;
  const { h } = await approved({ hooks: { beforeSkipDecide: async () => { if (moved++ === 0) await h.store.transact([fundsBumpOp(K.conn('pp-test'))]); } } });
  h.setNow(TUE_0805);
  await h.drain();
  h.setNow('2026-11-11T13:30:00.000Z');
  await pay(h, 'cust-pellow', 760_000, FEES.pellow);
  await pay(h, 'cust-harrow', 720_000, FEES.harrow);
  h.setNow(WED_0900);
  lagReport(h);
  await check(h);
  // The refused decide sends the check back to its evidence phase (fresh inputs), then it decides once.
  const { a, chk } = await check(h);
  assert.ok(moved >= 2, 'decide was attempted again after the stamp moved');
  assert.equal(a.state, 'SKIPPED_NOT_NEEDED', 'S7-B10: both captures confirmed by PayPal → the re-run decides to skip, once');
  assert.equal(chk!.generation, 1, 'one decision written');
  void report; void invOf; void pk;
});

test('S5-R14/D1/E6 still held at decide-by: a stale check id is refused; Send offer → one owner authority, used by one update; paused → refused', async () => {
  const { h } = await approved();
  h.setNow(TUE_0805);
  await h.drain();
  h.setNow('2026-11-11T13:30:00.000Z');
  await pay(h, 'cust-pellow', 760_000, FEES.pellow);
  await pay(h, 'cust-harrow', 720_000, FEES.harrow);
  h.setNow(WED_0900);
  lagReport(h, 9 * 3600_000); // S7-B10: hold via a report that stopped moving (confirmed captures alone would skip)
  let { a } = await check(h);
  assert.equal(a.state, 'HELD_EVIDENCE');
  assert.equal(a.decideBy, '2026-11-12T14:00:00.000Z');
  const stale = await h.api('POST', `/v1/plan/actions/${a.actionId}/decide`, { decision: 'DONT_SEND', checkId: 'CHECK#old' }, { 'if-match': String(a.version) });
  assert.deepEqual([stale.status, stale.body.code], [409, 'CONSENT_CHANGED']);
  const pol = (await h.api('GET', '/v1/delegation')).body;
  await h.api('POST', '/v1/delegation/pauses', { kind: 'OUTREACH', on: true }, { 'if-match': String(pol.version) });
  a = await actionOf(h, 'DISCOUNT_FALLBACK');
  const paused = await h.api('POST', `/v1/plan/actions/${a.actionId}/decide`, { decision: 'SEND', checkId: a.lastCheckId }, { 'if-match': String(a.version) });
  assert.deepEqual([paused.status, paused.body.code], [409, 'OUTREACH_PAUSED']);
  const pol2 = (await h.api('GET', '/v1/delegation')).body;
  await h.api('POST', '/v1/delegation/pauses', { kind: 'OUTREACH', on: false }, { 'if-match': String(pol2.version) });
  await h.drain();
  a = await actionOf(h, 'DISCOUNT_FALLBACK');
  const send = await h.api('POST', `/v1/plan/actions/${a.actionId}/decide`, { decision: 'SEND', checkId: a.lastCheckId }, { 'if-match': String(a.version) });
  assert.equal(send.status, 200, JSON.stringify(send.body));
  await h.drain();
  a = await actionOf(h, 'DISCOUNT_FALLBACK');
  assert.equal(a.state, 'APPLIED', JSON.stringify(a.heldReasons));
  const auth = (await items(h, 'OWNERAUTH#'))[0];
  assert.deepEqual([auth.state, String(auth.consumedBy).startsWith('upd:')], ['CONSUMED', true]);
});
