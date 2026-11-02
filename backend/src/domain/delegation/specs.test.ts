// S7a layer 2 (S07 §6.4): Y1 every rule spec, Y4 the seeded defaults reproduce A-001, Y2 the wired rules change behaviour.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PolicyKey, RULE_VALUE, type Policy, type PolicyValue } from '@headroom/contracts';
import { forecastDays } from '../cash-forecast/forecast.ts';
import { addDays } from '../time.ts';
import { movements, occKey, occurrencesOf, type StoredObligation } from '../obligations/obligations.ts';
import { MILESTONE, seedCommitments, seedInflows } from '../obligations/seed.ts';
import { applyRuleChange, decideCollect, decideOffer, safetyNotices, seedPolicy, valueOf } from './policy.ts';
import { normalizeValue, RULE_SPECS } from './specs.ts';

const fx = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/hero-v1a/closes.json', import.meta.url), 'utf8'));
const DAY0 = fx.day0 as string;
const NOW = `${DAY0}T15:00:00.000Z`;
const p0 = seedPolicy(NOW);
const set = (p: Policy, key: PolicyKey, value: PolicyValue) => {
  const r = applyRuleChange(p, { key, scope: 'EVERYWHERE', value }, 'o', NOW);
  assert.ok(!('refused' in r), `${key}: ${JSON.stringify(r)}`);
  return r;
};

/** A [looser, tighter] pair per rule. */
const PAIR: Record<PolicyKey, [PolicyValue, PolicyValue]> = {
  'comms.contactEveryBd': [2, 6],
  'comms.window': [{ open: '07:00', close: '18:00' }, { open: '09:00', close: '17:00' }],
  'comms.remindersWithoutReview': [true, false],
  'ar.newDateDays': [30, 7],
  'ar.discount': [{ bp: 300, capMinor: 30_000, cumulativeMinor: 30_000, tiers: ['STRONG', 'GOOD'] }, { bp: 200, capMinor: 30_000, cumulativeMinor: 30_000, tiers: ['STRONG'] }],
  'ar.disputes': ['PROPOSE_DISPUTED', 'PAUSE_INVOICE'],
  'ap.paymentLimitMinor': [600_000, 400_000],
  'ap.dailyLimitMinor': [700_000, 500_000],
  'ap.exactMatchBills': ['AUTO_VERIFY', 'ALWAYS_ASK'],
  'ap.differingBills': [{ mode: 'AUTO_ACCEPT', maxAmountDiffMinor: 0, maxDaysEarlier: 30 }, { mode: 'ALWAYS_ASK', maxAmountDiffMinor: 0, maxDaysEarlier: 0 }],
  'ap.askSuppliers': ['WITHOUT_REVIEW', 'NEEDS_YOU'],
  'cash.reserveMinor': [300_000, 500_000],
  'cash.protectedPayments': [{ setAsideDays: 0 }, { setAsideDays: 7 }],
};

test('Y1 every key has a spec; seeds fit their schema; loosens is judged in both directions', () => {
  for (const key of PolicyKey.options) {
    const s = RULE_SPECS[key];
    assert.ok(RULE_VALUE[key].safeParse(s.seed).success, `${key} seed fits its schema`);
    assert.deepEqual(valueOf(p0, key, key.startsWith('ap.') ? 'PAYABLES' : 'RECEIVABLES'), s.seed, `${key} is seeded at its spec default`);
    const [loose, tight] = PAIR[key];
    assert.ok(RULE_VALUE[key].safeParse(loose).success && RULE_VALUE[key].safeParse(tight).success, `${key} pair fits`);
    assert.deepEqual([s.loosens(tight, loose), s.loosens(loose, tight)], [true, false], key);
    assert.equal(typeof s.sentence(loose) + typeof s.sentence(tight), 'stringstring');
  }
});

test('Y1 S7-R6 wrong type and out-of-range values are refused', () => {
  const bad: [PolicyKey, PolicyValue][] = [
    ['comms.contactEveryBd', 0], ['comms.contactEveryBd', 'x'], ['comms.window', { open: '05:00', close: '18:00' }], ['comms.window', { open: '12:00', close: '12:30' }],
    ['comms.remindersWithoutReview', 1], ['ar.discount', { bp: 600, capMinor: 0, cumulativeMinor: 0, tiers: [] }], ['ar.discount', { bp: 100, capMinor: 0, cumulativeMinor: 0, tiers: ['STRONG', 'STRONG'] }],
    ['ar.disputes', 'COLLECT_ALL'], ['ap.dailyLimitMinor', -1], ['ap.differingBills', { mode: 'AUTO_ACCEPT', maxAmountDiffMinor: 0, maxDaysEarlier: 31 }], ['cash.protectedPayments', { setAsideDays: 15 }],
  ];
  for (const [key, value] of bad) assert.equal((applyRuleChange(p0, { key, scope: 'EVERYWHERE', value }, 'o', NOW) as { refused?: string }).refused, 'INVALID_INPUT', `${key} ${JSON.stringify(value)}`);
  assert.equal((applyRuleChange(p0, { key: 'cash.reserveMinor', scope: 'EVERYWHERE', value: 400_000 }, 'o', NOW) as { refused?: string }).refused, 'INVALID_INPUT', 'no-op change');
});

test('Y1 legacy S4 values read as the behaviour they had', () => {
  assert.equal(normalizeValue('ar.disputes', 'REVIEW_FIRST'), 'UNDISPUTED_ONLY');
  assert.deepEqual(normalizeValue('cash.protectedPayments', true), { setAsideDays: 0 });
  assert.deepEqual(normalizeValue('comms.window', '08:00-18:00'), { open: '08:00', close: '18:00' });
  assert.deepEqual(normalizeValue('ar.discount', { bp: 200, capMinor: 30_000, cumulativeMinor: 30_000, tiers: 'STRONG,GOOD' }), { bp: 200, capMinor: 30_000, cumulativeMinor: 30_000, tiers: ['STRONG', 'GOOD'] });
  assert.throws(() => normalizeValue('ar.disputes', 'NONSENSE'));
});

test('S7-D3 safety: loosening flags safety and the Overview notice; tightening and restore clear it', () => {
  const r = set(p0, 'ar.disputes', 'PROPOSE_DISPUTED');
  assert.deepEqual([r.loosens, r.safety], [true, true]);
  assert.deepEqual(safetyNotices(r.policy).map((n) => [n.key, n.since]), [['ar.disputes', NOW]]);
  const back = set(r.policy, 'ar.disputes', 'UNDISPUTED_ONLY');
  assert.deepEqual([back.loosens, back.safety, safetyNotices(back.policy).length], [false, false, 0]);
  const strict = set(p0, 'ar.disputes', 'PAUSE_INVOICE');
  assert.deepEqual([strict.safety, safetyNotices(strict.policy).length], [false, 0], 'stricter than default is not a notice');
  assert.equal(set(p0, 'cash.reserveMinor', 300_000).safety, false, 'a non-safety loosening is not a safety change');
});

// ---------- Y4 / Y2 forecast rules ----------
const cmts = seedCommitments(DAY0, NOW);
const inflows = seedInflows(DAY0);
const stored = new Map<string, StoredObligation>([[occKey(MILESTONE, 0), { commitmentId: MILESTONE, n: 0, scheduledOn: addDays(DAY0, 24), dueOn: addDays(DAY0, 4), amount: { currency: 'USD', minor: 1_000_000 }, version: 2, substantiatedBy: 'b1', termsVersion: 1 }]]);
const series = (p: Policy, accepted = false) => {
  const occs = cmts.flatMap((c) => occurrencesOf(c, accepted ? stored : new Map(), addDays(DAY0, 133)));
  const m = movements({ commitments: cmts, occurrences: occs, inflows, billRefs: new Map(), setAsideDays: valueOf<{ setAsideDays: number }>(p, 'cash.protectedPayments').setAsideDays }, DAY0);
  return forecastDays(fx.openingMinor, m.items, DAY0, valueOf<number>(p, 'cash.reserveMinor'));
};

test('Y4 S7-A8 the seeded defaults reproduce the A-001 series exactly', () => {
  assert.equal(valueOf(p0, 'cash.reserveMinor'), fx.reserveMinor);
  assert.deepEqual(series(p0).days.map((x) => x.closeMinor), fx.prior_accepted_terms);
  const f = series(p0, true);
  assert.deepEqual(f.days.map((x) => x.closeMinor), fx.bill_accepted_no_collection);
  assert.deepEqual([f.summary.firstBelowReserve, f.summary.reserveGapMinor], [addDays(DAY0, 4), 854_000]);
});

test('Y2 cash.reserveMinor: $3,000 moves the gap by exactly $1,000 (S7-A6, one source)', () => {
  const f = series(set(p0, 'cash.reserveMinor', 300_000).policy, true);
  assert.equal(f.summary.reserveGapMinor, 754_000);
});

test('Y2 cash.protectedPayments: 7 days sets payroll aside from day 4; the payment date itself is unchanged', () => {
  const p = set(p0, 'cash.protectedPayments', { setAsideDays: 7 }).policy;
  const f = series(p);
  assert.equal(f.days[4].closeMinor, fx.prior_accepted_terms[4] - 380_000, 'payroll (day 11) counts from day 4');
  assert.equal(f.days[41].closeMinor, fx.prior_accepted_terms[41], 'same money over the horizon');
  const item = f.days[4].items.find((i) => i.key.startsWith('occ#cmt-payroll#'))!;
  assert.match(item.note!, new RegExp(`Set aside 7 days before it is due ${addDays(DAY0, 11)}`));
});

test('Y2 comms.remindersWithoutReview off: every reminder needs the wording approved', () => {
  assert.equal(decideCollect(p0, 'GOOD').decision, 'ALLOW');
  const off = decideCollect(set(p0, 'comms.remindersWithoutReview', false).policy, 'GOOD');
  assert.deepEqual([off.decision, off.grantKinds], ['REQUIRES_APPROVAL', ['MESSAGE_AS_WRITTEN']]);
});

test('Y2 ar.discount tiers come from the rule alone (no AND with the tier table)', () => {
  assert.equal(decideOffer(p0, 'MIXED', 'c', 450_000, 200, 0).decision, 'BLOCK');
  const wide = set(p0, 'ar.discount', { bp: 200, capMinor: 30_000, cumulativeMinor: 30_000, tiers: ['STRONG', 'GOOD', 'MIXED'], ask: 'ABOVE_LIMITS' }).policy;
  assert.equal(decideOffer(wide, 'MIXED', 'c', 450_000, 200, 0).decision, 'ALLOW');
  // UX repair (S7-UX2): the seeded rule has every offer come to the owner; an edit that omits `ask` keeps it.
  assert.deepEqual([decideOffer(p0, 'STRONG', 'c', 450_000, 200, 0).decision, decideOffer(p0, 'STRONG', 'c', 450_000, 200, 0).grantKinds], ['REQUIRES_APPROVAL', ['DISCOUNT_OFFER']]);
  const kept = set(p0, 'ar.discount', { bp: 200, capMinor: 30_000, cumulativeMinor: 30_000, tiers: ['STRONG', 'GOOD', 'MIXED'] }).policy;
  assert.equal(decideOffer(kept, 'MIXED', 'c', 450_000, 200, 0).decision, 'REQUIRES_APPROVAL');
  const none = set(p0, 'ar.discount', { bp: 0, capMinor: 30_000, cumulativeMinor: 30_000, tiers: ['STRONG', 'GOOD'] }).policy;
  assert.match(decideOffer(none, 'STRONG', 'c', 450_000, 200, 0).reasons[0], /no early-payment discounts/);
  const bigger = set(p0, 'ar.discount', { bp: 500, capMinor: 50_000, cumulativeMinor: 50_000, tiers: ['STRONG', 'GOOD'], ask: 'ABOVE_LIMITS' }).policy;
  assert.equal(decideOffer(bigger, 'STRONG', 'c', 450_000, 500, 0).decision, 'ALLOW', '5% = $225 within the loosened limits');
});

test('Y2 comms.window: contact dates, the send gate, offer end and the PAY time follow the owner window', async () => {
  const { earliestContact, planDates, windowOf, zonedInstant } = await import('../plan/dates.ts');
  const { windowOpen } = await import('../comms/send.ts');
  const { offerEndsAt, payAtHhmm } = await import('../plan/due.ts');
  const TZ = 'America/New_York';
  const nine = zonedInstant(DAY0, '09:00', TZ);
  const narrow = set(p0, 'comms.window', { open: '10:00', close: '16:00' }).policy;
  assert.equal(windowOpen(nine, TZ, windowOf(p0)), null, 'default: 09:00 is inside 08:00–18:00');
  assert.equal(windowOpen(nine, TZ, windowOf(narrow)), zonedInstant(DAY0, '10:00', TZ), 'narrowed: waits for 10:00');
  assert.equal(earliestContact(nine, TZ, windowOf(narrow)).at, zonedInstant(DAY0, '10:00', TZ));
  assert.equal(planDates(addDays(DAY0, 4), nine, TZ, windowOf(narrow)).contactAt, zonedInstant(DAY0, '10:00', TZ));
  assert.equal(offerEndsAt({ terms: { expiresOn: addDays(DAY0, 4) } } as never, TZ, windowOf(narrow)), zonedInstant(addDays(DAY0, 4), '16:00', TZ));
  assert.deepEqual([payAtHhmm(windowOf(p0)), payAtHhmm(windowOf(narrow))], ['09:00', '10:00']);
  const early = set(p0, 'comms.window', { open: '06:00', close: '22:00' }).policy;
  assert.equal(windowOpen(zonedInstant(DAY0, '07:00', TZ), TZ, windowOf(early)), null, 'widened: 07:00 sends');
});

test('Y15 contact slot: Friday + 1 business day → Monday opening; a pending (UNKNOWN) send blocks; a tightened N applies at the claim', async () => {
  const { nextEligible, slotClaim } = await import('../comms/send.ts');
  const { zonedInstant } = await import('../plan/dates.ts');
  const TZ = 'America/New_York';
  const fri = zonedInstant('2026-11-13', '15:00', TZ);
  assert.equal(nextEligible(fri, 1, TZ, { open: '08:00', close: '18:00' }), zonedInstant('2026-11-16', '08:00', TZ));
  const s = (p: Policy) => ({ policy: p, pk: 'pk', ctx: { run: { settings: { timeZone: TZ } } } }) as never;
  const sun = zonedInstant('2026-11-15', '12:00', TZ);
  assert.equal(slotClaim(s(p0), 'b', 'RECEIVABLES', 'c', 'e2', { pk: 'pk', sk: 'CONTACT#b', lastSentAt: null, pendingEffect: 'e1', version: 3 }, sun).ok, false, 'UNKNOWN keeps the slot');
  const tue = zonedInstant('2026-11-17', '09:00', TZ);
  const slot = { pk: 'pk', sk: 'CONTACT#b', lastSentAt: fri, pendingEffect: null, version: 3 };
  assert.equal(slotClaim(s(set(p0, 'comms.contactEveryBd', 1).policy), 'b', 'RECEIVABLES', 'c', 'e2', slot, tue).ok, true, 'N = 1: Tuesday is fine');
  const blocked = slotClaim(s(p0), 'b', 'RECEIVABLES', 'c', 'e2', slot, tue);
  assert.ok(!blocked.ok && blocked.until === zonedInstant('2026-11-19', '08:00', TZ), 'N = 4: next allowed Thu');
});

test('S7 R6 answer matching: exactly one offered option or it is a counter', async () => {
  const { matchOption } = await import('../obligations/supplier-answer.ts');
  const usd = (minor: number) => ({ currency: 'USD' as const, minor });
  const opts = [{ code: 'KEEP' as const, parts: [{ dueOn: '2026-12-03', amount: usd(1_000_000) }] }, { code: 'SPLIT' as const, parts: [{ dueOn: '2026-11-13', amount: usd(140_000) }, { dueOn: '2026-12-03', amount: usd(860_000) }] }];
  assert.equal(matchOption([{ dueOn: '2026-12-03', amount: null }], opts), 'KEEP');
  assert.equal(matchOption([{ dueOn: '2026-12-03', amount: usd(1_000_000) }], opts), 'KEEP');
  assert.equal(matchOption([{ dueOn: '2026-12-03', amount: usd(860_000) }, { dueOn: '2026-11-13', amount: usd(140_000) }], opts), 'SPLIT', 'order-free');
  assert.equal(matchOption([{ dueOn: '2026-11-13', amount: usd(200_000) }, { dueOn: '2026-12-03', amount: usd(800_000) }], opts), null, 'S7-R37 counter');
  assert.equal(matchOption([{ dueOn: null, amount: usd(140_000) }], opts), null);
  assert.equal(matchOption([{ dueOn: '2026-12-10', amount: null }], opts), null, 'a later date is not KEEP');
});

test('Y14 S7 R8 live facts: a live payment 30 days late moves Strong [1,2,3] (median 2) to Good (median 2.5); seeded and live are labelled', async () => {
  const { assess } = await import('../relationships/assess.ts');
  const usd = (minor: number) => ({ currency: 'USD' as const, minor });
  const h = (n: number, late: number, basis: 'SEEDED' | 'LIVE') => ({ counterpartyId: 'c', n, kind: 'INVOICE_PAID' as const, ref: `r${n}`, dueOn: '2026-10-01', paidOn: addDays('2026-10-01', late), amount: usd(1), note: null, open: false, basis });
  const seeded = [h(1, 1, 'SEEDED'), h(2, 2, 'SEEDED'), h(3, 3, 'SEEDED')];
  assert.equal(assess(seeded).tier, 'STRONG');
  const a = assess([...seeded, h(1000, 30, 'LIVE')]);
  assert.equal(a.tier, 'GOOD');
  assert.match(a.factors[0].detail, /3 seeded, 1 live/);
});

test('S7 R8 liveHistory: paid once (PAID, settling capture date); confirmed open dispute; missed promise stays missed after a later payment', async () => {
  const { liveHistory } = await import('../relationships/live.ts');
  const usd = (minor: number) => ({ currency: 'USD' as const, minor });
  const items = [
    { pk: 'p', sk: 'INV#i1', invoiceId: 'i1', invoiceNumber: 'HR-x-001', customerId: 'c1', state: 'PAID', dueOn: '2026-10-26', amount: usd(760_000) },
    { pk: 'p', sk: 'RCPT#k1', invoiceId: 'i1', capturedAt: '2026-11-10T15:00:00.000Z' },
    { pk: 'p', sk: 'RCPT#k0', invoiceId: 'i1', capturedAt: '2026-11-03T15:00:00.000Z' },
    { pk: 'p', sk: 'INV#i2', invoiceId: 'i2', invoiceNumber: 'HR-x-002', customerId: 'c2', state: 'ISSUED', dueOn: '2026-11-02', amount: usd(900_000) },
    { pk: 'p', sk: 'CLAIM#i2', invoiceId: 'i2', basis: 'CUSTOMER_REPLY', disputed: usd(180_000), undisputed: usd(720_000) },
    { pk: 'p', sk: 'PROMISE#m1', promiseId: 'm1', invoiceId: 'i2', customerId: 'c2', on: '2026-11-09', quote: 'we pay Nov 9', amount: null },
    { pk: 'p', sk: 'RCPT#k2', invoiceId: 'i2', capturedAt: '2026-11-11T15:00:00.000Z' },
  ];
  const live = liveHistory(items as never, '2026-11-12', 'America/New_York');
  assert.deepEqual(live.map((x) => [x.counterpartyId, x.kind, x.paidOn, x.open]), [['c1', 'INVOICE_PAID', '2026-11-10', false], ['c2', 'DISPUTE', null, true], ['c2', 'ARRANGEMENT_MISSED', null, false]]);
});
