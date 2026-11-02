import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMessage } from '../../adapters/mail/rfc5322.ts';
import type { AuthVerdict } from '../../adapters/mail/types.ts';
import { exactAmountMinor, exactDate, replyGate, senderGate } from './gates.ts';

const PASS: AuthVerdict = { source: 'SIMULATED', dkim: 'pass', spf: 'pass', dmarc: 'pass' };
const from = (...h: string[]) => parseMessage([...h.map((v) => `From: ${v}`), 'Message-ID: <r@x>', '', 'hi'].join('\r\n'));
const AP = 'ap@pellow.example';

test('M4 mail: sender gate', () => {
  assert.deepEqual(senderGate(from(`"Pellow AP" <AP@Pellow.example>`), PASS, AP), { ok: true, address: AP });
  assert.equal(senderGate(from(AP), PASS, 'AP@pellow.example ').ok, true);

  const code = (r: ReturnType<typeof senderGate>) => (r.ok ? 'OK' : r.code);
  assert.equal(code(senderGate(from(AP, AP), PASS, AP)), 'HOLD_AMBIGUOUS_SENDER');
  assert.equal(code(senderGate(from(`${AP}, other@pellow.example`), PASS, AP)), 'HOLD_AMBIGUOUS_SENDER');
  assert.equal(code(senderGate(parseMessage('Subject: none\r\n\r\nhi'), PASS, AP)), 'HOLD_AMBIGUOUS_SENDER');

  assert.equal(code(senderGate(from(`"${AP}" <x@attacker.example>`), PASS, AP)), 'HOLD_UNAUTHORIZED');
  assert.equal(code(senderGate(from(`${AP} <x@attacker.example>`), PASS, AP)), 'HOLD_UNAUTHORIZED');
  assert.equal(code(senderGate(from(AP), PASS, null)), 'HOLD_UNAUTHORIZED');

  assert.equal(code(senderGate(from(AP), null, AP)), 'HOLD_UNVERIFIED');
  assert.equal(code(senderGate(from(AP), { ...PASS, dmarc: 'fail' }, AP)), 'HOLD_UNVERIFIED');
});

test('M5 reply: verbatim facts only', () => {
  const today = '2026-11-09';
  const body = "Hi — we'll pay $7,600 on Nov 12. Sorry for the delay.";
  assert.deepEqual(replyGate(body, { intent: 'PROMISE', quote: "we'll pay $7,600 on Nov 12", quotedDate: 'Nov 12', quotedAmount: '$7,600' }, today),
    { ok: true, intent: 'PROMISE', quote: "we'll pay $7,600 on Nov 12", on: '2026-11-12', amountMinor: 760000, amountQuotes: null, termsQuotes: null });

  // not verbatim → refused (each field, and an empty quote)
  for (const out of [
    { quote: 'we will pay $7,600 on Nov 12', quotedDate: null, quotedAmount: null },
    { quote: "we'll pay", quotedDate: 'Nov 13', quotedAmount: null },
    { quote: "we'll pay", quotedDate: null, quotedAmount: '$7,700' },
    { quote: '', quotedDate: null, quotedAmount: null },
  ]) assert.equal(replyGate(body, { intent: 'PROMISE', ...out }, today).ok, false);

  // relative date → QUESTION, no date
  const rel = "We'll pay next Friday.";
  assert.deepEqual(replyGate(rel, { intent: 'PROMISE', quote: "We'll pay next Friday.", quotedDate: 'next Friday', quotedAmount: null }, today),
    { ok: true, intent: 'QUESTION', quote: "We'll pay next Friday.", on: null, amountMinor: null, amountQuotes: null, termsQuotes: null });
  // a promise with no date at all → QUESTION; a dispute keeps its intent
  assert.equal((replyGate(rel, { intent: 'PROMISE', quote: "We'll pay", quotedDate: null, quotedAmount: null }, today) as any).intent, 'QUESTION');
  assert.equal((replyGate('We dispute this, call me tomorrow', { intent: 'DISPUTE', quote: 'We dispute this', quotedDate: 'tomorrow', quotedAmount: null }, today) as any).intent, 'DISPUTE');

  // amount in words → never guessed
  const words = 'We will send seven thousand on 2026-11-12.';
  assert.deepEqual(replyGate(words, { intent: 'PROMISE', quote: words, quotedDate: '2026-11-12', quotedAmount: 'seven thousand' }, today),
    { ok: true, intent: 'PROMISE', quote: words, on: '2026-11-12', amountMinor: null, amountQuotes: null, termsQuotes: null });
});

test('M5 reply: date and amount parsing', () => {
  const today = '2026-11-09';
  for (const [s, want] of [
    ['Nov 12', '2026-11-12'], ['November 12', '2026-11-12'], ['12 November', '2026-11-12'], ['Nov. 12th', '2026-11-12'],
    ['2026-11-12', '2026-11-12'], ['11/12/2026', '2026-11-12'], ['Nov 9', '2026-11-09'], ['Nov 8', '2027-11-08'], ['Jan 5', '2027-01-05'],
    ['November 12, 2027', '2027-11-12'], ['Feb 30', null], ['tomorrow', null], ['end of the month', null], ['soon', null], ['11/12', null], ['next Friday', null],
  ] as const) assert.equal(exactDate(s, today), want, s);
  for (const [s, want] of [['$7,600', 760000], ['$7,600.00', 760000], ['7600 USD', 760000], ['$12.34', 1234], ['7600', null], ['$7,60', null], ['seven thousand dollars', null]] as const)
    assert.equal(exactAmountMinor(s), want, s);
});

test('S5-D26 privacy: only replies to Headroom or mail to the +headroom address are taken in from a real inbox', async () => {
  const { forHeadroom } = await import('./inbound.ts');
  assert.equal(forHeadroom({ to: ['me@gmail.com'], inReplyTo: '<send.COLLECT-inv.1@headroom>', references: [] }), true);
  assert.equal(forHeadroom({ to: ['Me <me+headroom@gmail.com>'], inReplyTo: null, references: [] }), true, 'a forwarded bill');
  assert.equal(forHeadroom({ to: ['me@gmail.com'], inReplyTo: '<abc@mail.gmail.com>', references: ['<x@y.com>'] }), false, 'personal mail is never read');
  assert.equal(forHeadroom({ to: ['me@gmail.com'], inReplyTo: null, references: [] }), false);
});

test('S7 R4 dispute split: amounts only from the email, parts must sum to what is open; one part derived; S7-R21 mismatch → owner types them', async () => {
  const { disputeSplit, oneAmountMinor } = await import('./gates.ts');
  assert.equal(oneAmountMinor('dispute the $1,800 change order'), 180_000);
  assert.equal(oneAmountMinor('$1,800 of the $9,000'), null, 'two amounts in one quote → not grounded');
  assert.deepEqual(disputeSplit({ disputed: 'the $1,800 change order', undisputed: 'accept the $7,200' }, 900_000), { disputedMinor: 180_000, undisputedMinor: 720_000, derived: null });
  assert.deepEqual(disputeSplit({ disputed: '$1,800', undisputed: null }, 900_000), { disputedMinor: 180_000, undisputedMinor: 720_000, derived: 'UNDISPUTED' });
  assert.deepEqual(disputeSplit({ disputed: null, undisputed: '$7,200' }, 900_000), { disputedMinor: 180_000, undisputedMinor: 720_000, derived: 'DISPUTED' });
  assert.deepEqual(disputeSplit({ disputed: '$1,800', undisputed: '$7,000' }, 900_000), { disputedMinor: null, undisputedMinor: null, derived: null }, 'S7-R21');
  assert.deepEqual(disputeSplit(null, 900_000), { disputedMinor: null, undisputedMinor: null, derived: null });
  assert.equal(replyGate('We dispute $1,800.', { intent: 'DISPUTE_PARTIAL', quote: 'We dispute $1,800.', quotedDate: null, quotedAmount: null, amountQuotes: { disputed: '$1,900', undisputed: null } }, '2026-11-09').ok, false, 'a quote must be verbatim');
});
