// S4 layer 2 (S04 §6.4 as revised by §6.17): hero breach, outlook rows (net, R6), dates (R5), candidates, policy, labels, gates (R7).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { ClaimSplit, Tier } from '@headroom/contracts';
import { forecastDays } from '../cash-forecast/forecast.ts';
import { addDays } from '../time.ts';
import { movements, occKey, occurrencesOf, type StoredObligation, type TermsChange } from '../obligations/obligations.ts';
import { KELLER, MILESTONE, seedCommitments, seedInflows } from '../obligations/seed.ts';
import { applyPause, applyRuleChange, decideOffer, decidePayout, resolve, seedPolicy } from '../delegation/policy.ts';
import { assess } from '../relationships/assess.ts';
import { heroHistory, HARROW, MERCER, PELLOW } from '../receivables/hero.ts';
import { addBusinessDays, earliestContact, estimatedFeeMinor, planDates, zonedInstant } from './dates.ts';
import { generateCandidates, type PlanInputs } from './candidates.ts';
import { outlookRowsFor, priceRows, scenarioChanges } from './outlook.ts';
import { drafterGate, messageFor, plannerGate, renderWhy } from './gates.ts';

const fx = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/hero-v1a/closes.json', import.meta.url), 'utf8'));
const DAY0 = fx.day0 as string; // Mon 2026-11-09
const TZ = 'America/New_York';
const NOW = zonedInstant(DAY0, '10:00', TZ);
const d = (n: number) => addDays(DAY0, n);
const cmts = seedCommitments(DAY0, NOW);
const inflows = seedInflows(DAY0).map((i) => (i.inflowId === 'in-mercer' ? { ...i, invoiceId: 'inv-mercer' } : i));
const stored = new Map<string, StoredObligation>([[occKey(MILESTONE, 0), { commitmentId: MILESTONE, n: 0, scheduledOn: d(24), dueOn: d(4), amount: { currency: 'USD', minor: 1_000_000 }, version: 2, substantiatedBy: 'b1', termsVersion: 1 }]]);
const occs = cmts.flatMap((c) => occurrencesOf(c, stored, d(133)));
const price = (ch: TermsChange[]) => forecastDays(fx.openingMinor, movements({ commitments: cmts, occurrences: occs, inflows, billRefs: new Map() }, DAY0, ch).items, DAY0, fx.reserveMinor);
const expected = price([]);
const policy = seedPolicy(NOW);
const aboveLimits = { ...policy, rules: policy.rules.map((r) => (r.key === 'ar.discount' ? { ...r, everywhere: { ...(r.everywhere as object), ask: 'ABOVE_LIMITS' } } : r)) } as typeof policy;
const W = { open: '08:00', close: '18:00' };
const tiers = new Map<string, { tier: Tier; label: string; factorText: string }>(
  [PELLOW, HARROW, MERCER].map((id) => { const a = assess(heroHistory(DAY0).filter((h) => h.counterpartyId === id)); return [id, { tier: a.tier, label: a.label, factorText: '' }]; }));
const claim: ClaimSplit = { invoiceId: 'inv-harrow', undisputed: { currency: 'USD', minor: 720_000 }, disputed: { currency: 'USD', minor: 180_000 }, acknowledgement: { from: 'Harrow', quote: 'q', on: d(-5) }, basis: 'SEEDED' };
const inputs = (now = NOW, needBy = expected.summary.firstBelowReserve!): PlanInputs => ({
  now, tz: TZ, today: DAY0, needBy, needByClose: -9000, gapMinor: 854_000, policy, tiers, inflows, claims: [claim],
  invoices: [
    { invoiceId: 'inv-pellow', number: 'HR-x-001', customerId: PELLOW, customerName: 'Pellow Dental Group', state: 'ISSUED', amountMinor: 760_000, openMinor: 760_000, dueOn: d(-14), failureReason: null },
    { invoiceId: 'inv-harrow', number: 'HR-x-002', customerId: HARROW, customerName: 'Harrow Developments', state: 'ISSUED', amountMinor: 900_000, openMinor: 900_000, dueOn: d(-7), failureReason: null },
    { invoiceId: 'inv-mercer', number: 'HR-x-003', customerId: MERCER, customerName: 'Mercer Architects', state: 'ISSUED', amountMinor: 450_000, openMinor: 450_000, dueOn: d(16), failureReason: null },
  ],
  payouts: [{ occurrenceKey: occKey(MILESTONE, 0), supplierId: KELLER, supplierName: 'Keller Drafting Co.', name: 'Keller milestone 2', dueOn: d(4), amountMinor: 1_000_000, feeMinor: 2000, billRef: 'K-2207', billId: 'b1', termsText: 'Dec 3 → Nov 13', termsId: 't1', payee: { version: 1, receiverSha256: 'h', masked: 's•••@•••.example.com', confirmed: true }, paymentVersion: 1, paid: null }],
});
const hero = () => generateCandidates(inputs());
const byKind = (k: string) => hero().candidates.find((c) => c.kind === k)!;

test('P1 hero breach: need-by Fri Nov 13 (day +4), gap $8,540.00, low −$4,540.00 on day +11', () => {
  assert.equal(expected.summary.firstBelowReserve, d(4));
  assert.deepEqual([expected.summary.reserveGapMinor, expected.summary.lowMinor, expected.summary.lowOn], [854_000, -454_000, d(11)]);
});

test('P6 fees: 3.49% half-up + $0.49 — 7,600 → 265.73; 7,200 → 251.77; 4,410 → 154.40', () => {
  assert.deepEqual([estimatedFeeMinor(760_000), estimatedFeeMinor(720_000), estimatedFeeMinor(441_000)], [26_573, 25_177, 15_440]);
});

test('P8 candidates: Pellow COLLECT 7,600; Harrow SLICE 7,200 (disputed never a candidate); Mercer 2% = $90 → 4,410; Keller payout held', () => {
  const { candidates, considered } = hero();
  assert.deepEqual(candidates.map((c) => [c.rootId, c.terms.amount.minor]), [['COLLECT:inv-pellow', 760_000], ['SLICE:inv-harrow', 720_000], ['OFFER:inv-mercer', 441_000], [`PAYOUT:${occKey(MILESTONE, 0)}`, 1_000_000]]);
  assert.ok(considered.some((c) => c.rootId === 'DISPUTED:inv-harrow' && !c.canAsk && /never collects disputed/.test(c.reason)));
  const offer = byKind('DISCOUNT_FALLBACK');
  assert.deepEqual([offer.terms.discountAmount!.minor, offer.estimate!.fee.minor, offer.estimate!.net.minor], [9_000, 15_440, 425_560]);
  assert.ok(offer.changes.some((c) => c.kind === 'DROP_INFLOW' && c.inflowId === 'in-mercer'), 'the stated Mercer receipt is replaced, not double counted');
  const pay = byKind('PAYOUT');
  assert.ok(pay.mustInclude && pay.heldReasons.some((r) => /09:00 through PayPal Payouts/.test(r)));
  // S6 R4: the consent binds the maximum debit (face + 2% ceiling), the exact payee version and the payment version.
  assert.deepEqual([pay.terms.maxDebit?.minor, pay.terms.payee?.version, pay.terms.paymentVersion], [1_020_000, 1, 1]);
  assert.deepEqual(pay.authority.grantKinds, ['PAYOUT_AUTHORITY', 'PAYOUT_EXCEPTION']);
  assert.deepEqual(byKind('COLLECT_UNDISPUTED_SLICE').authority.grantKinds, ['COLLECT_SLICE', 'MESSAGE_AS_WRITTEN']);
  // S7-UX2: the seeded discount rule has the owner approve each offer (one-time DISCOUNT_OFFER); no prior contact here, so Pellow is within delegation.
  assert.deepEqual([byKind('COLLECT_OVERDUE').authority.decision, offer.authority.decision, offer.authority.grantKinds], ['ALLOW', 'REQUIRES_APPROVAL', ['DISCOUNT_OFFER']]);
});

test('P7 hero dates: Pellow (overdue) asked Mon Nov 9, target and payment check Tue Nov 10; Harrow target Thu Nov 12; Mercer check Wed Nov 11 09:00; expiry Fri Nov 13', () => {
  const c = byKind('COLLECT_OVERDUE');
  assert.deepEqual([c.terms.contactOn, c.terms.replyCheckOn, c.terms.targetOn, c.late], [d(0), d(1), d(1), null], 'overdue: next business day (owner, 2 Nov 2026)');
  const h = byKind('COLLECT_UNDISPUTED_SLICE');
  assert.deepEqual([h.terms.contactOn, h.terms.replyCheckOn, h.terms.targetOn], [d(0), d(3), d(3)]);
  const o = byKind('DISCOUNT_FALLBACK');
  assert.deepEqual([o.terms.checkAt, o.terms.expiresOn, o.terms.payBy], [zonedInstant(d(2), '09:00', TZ), d(4), d(3)]);
  assert.equal(o.terms.checkAt, '2026-11-11T14:00:00.000Z', '09:00 New York in November is 14:00 UTC');
});

test('P7b late builds (R5): no checkpoint before contact; past fallback checks are TOO_LATE, not scheduled', () => {
  const needBy = d(4);
  const cases = { early: zonedInstant(d(0), '07:30', TZ), evening: zonedInstant(d(0), '18:30', TZ), sat: zonedInstant(d(-2), '12:00', TZ), nb1: zonedInstant(d(3), '10:00', TZ), nb: zonedInstant(d(4), '10:00', TZ), after: zonedInstant(d(7), '10:00', TZ) };
  assert.deepEqual(earliestContact(cases.early, TZ, W), { on: d(0), at: zonedInstant(d(0), '08:00', TZ) });
  assert.equal(earliestContact(cases.evening, TZ, W).on, d(1));
  assert.equal(earliestContact(cases.sat, TZ, W).on, d(0), 'Saturday → Monday');
  for (const [k, now] of Object.entries(cases)) {
    const p = planDates(needBy, now, TZ, W);
    assert.ok(p.replyCheckOn >= p.contactOn && p.targetOn >= p.contactOn && p.overdue.targetOn >= p.contactOn && p.overdue.targetOn <= p.targetOn, k);
    if (!('tooLate' in p.fallback)) assert.ok(p.fallback.checkAt > p.contactAt, k);
  }
  assert.ok('tooLate' in planDates(needBy, cases.nb1, TZ, W).fallback, 'need-by − 1: Wed 09:00 has passed');
  assert.equal(planDates(needBy, cases.nb, TZ, W).late !== null, true, 'need-by day: target can only be today → Late');
  const late = generateCandidates(inputs(cases.nb1));
  assert.ok(!late.candidates.some((c) => c.kind === 'DISCOUNT_FALLBACK'));
  assert.ok(late.considered.some((c) => c.reasonCode === 'TOO_LATE' && !c.canAsk));
  assert.equal(addBusinessDays(d(4), 1), d(7), 'Fri + 1 bd = Mon');
});

const rows = () => {
  const r = priceRows(outlookRowsFor(hero().candidates), price, d(4))!;
  return Object.fromEntries(r.map((x) => [x.key, x]));
};
test('P2 outlook "Nothing arrives early": Nov 13 close −$90.00, low −$4,540.00 Nov 20, gap $8,540.00, cost 0', () => {
  const r = rows().none;
  assert.deepEqual([r.needByClose, r.lowMinor, r.lowOn, r.gapMinor, r.concessionMinor], [-9000, -454_000, d(11), 854_000, 0]);
});
test('P3 outlook single and both collections, net of estimated fees', () => {
  const r = rows();
  const p = r['only:COLLECT:inv-pellow'], h = r['only:SLICE:inv-harrow'], b = r.all;
  assert.deepEqual([p.needByClose, p.lowMinor, p.lowOn, p.gapMinor], [724_427, 279_427, d(11), 120_573]);
  assert.deepEqual([h.needByClose, h.lowMinor, h.gapMinor], [685_823, 240_823, 159_177]);
  assert.deepEqual([b.needByClose, b.lowMinor, b.firstBelowReserve], [1_419_250, 974_250, null]);
});
test('P4 (R6) fallback rows priced net: Pellow + Mercer low $7,049.87, Harrow + Mercer $6,663.83, both covered, cost $90', () => {
  const r = rows();
  const pm = r['only:COLLECT:inv-pellow+OFFER:inv-mercer'], hm = r['only:SLICE:inv-harrow+OFFER:inv-mercer'];
  assert.deepEqual([pm.lowMinor, pm.firstBelowReserve, pm.concessionMinor], [704_987, null, 9_000]);
  assert.deepEqual([hm.lowMinor, hm.firstBelowReserve], [666_383, null]);
});
test('P5 scenarios: Ideal = both targets (low $9,742.50); Downside = no stated receipts', () => {
  const c = hero().candidates;
  assert.equal(price(scenarioChanges('IDEAL', c, [])).summary.lowMinor, 974_250);
  const down = price(scenarioChanges('DOWNSIDE', c, inflows.map((i) => i.inflowId)));
  assert.equal(down.days.flatMap((x) => x.items).some((i) => i.basis === 'STATED'), false);
  assert.equal(down.summary.lowMinor, -984_000);
});

test('D1 precedence: scope beats everywhere; the winner is reported', () => {
  assert.equal(resolve(policy, 'ap.paymentLimitMinor', 'PAYABLES').winning.source, 'EVERYWHERE');
  const ch = applyRuleChange(policy, { key: 'ap.paymentLimitMinor', scope: 'PAYABLES', value: 1_500_000 }, 'o', NOW);
  assert.ok('policy' in ch && ch.loosens);
  const r = resolve((ch as { policy: typeof policy }).policy, 'ap.paymentLimitMinor', 'PAYABLES');
  assert.deepEqual([r.value, r.winning.source], [1_500_000, 'SCOPE']);
});
test('D2 bounds checked; S7: the daily limit is editable; a scope a rule lacks is refused', () => {
  assert.equal((applyRuleChange(policy, { key: 'ap.dailyLimitMinor', scope: 'EVERYWHERE', value: 700_000 }, 'o', NOW) as { loosens: boolean }).loosens, true);
  assert.equal((applyRuleChange(policy, { key: 'ap.dailyLimitMinor', scope: 'PAYABLES', value: 1 }, 'o', NOW) as { refused: string }).refused, 'NOT_EDITABLE');
  assert.equal((applyRuleChange(policy, { key: 'comms.contactEveryBd', scope: 'EVERYWHERE', value: 0 }, 'o', NOW) as { refused: string }).refused, 'INVALID_INPUT');
  assert.equal((applyRuleChange(policy, { key: 'ap.paymentLimitMinor', scope: 'PAYABLES', value: -1 }, 'o', NOW) as { refused: string }).refused, 'INVALID_INPUT');
  const paused = applyPause(policy, 'PAYMENTS', true, 'o', NOW);
  assert.deepEqual([paused.version, paused.pauses.payments], [2, true]);
});
test('D3 discount: 2% on $4,500 ALLOW with policy v1; 5% EXCEPTION "$225"; Mixed BLOCK; cumulative over $300 EXCEPTION', () => {
  assert.equal(decideOffer(policy, 'STRONG', MERCER, 450_000, 200, 0).decision, 'REQUIRES_APPROVAL');
  assert.equal(decideOffer(aboveLimits, 'STRONG', MERCER, 450_000, 200, 0).decision, 'ALLOW', 'A-002 mode: inside the limits the delegation authorizes it');
  const five = decideOffer(policy, 'STRONG', MERCER, 450_000, 500, 0);
  assert.deepEqual([five.decision, five.grantKinds], ['EXCEPTION', ['DISCOUNT_OFFER']]);
  assert.match(five.reasons[0], /5% = \$225\.00 is above '2% or \$300\.00, whichever is smaller'/);
  assert.equal(decideOffer(policy, 'MIXED', 'x', 450_000, 200, 0).decision, 'BLOCK');
  assert.equal(decideOffer(policy, 'GOOD', 'x', 450_000, 200, 25_000).decision, 'EXCEPTION');
});
test('D4 payout 10,000.25: authority + exception; after Payables limit 15,000 only the daily-limit reason stays', () => {
  const a = decidePayout(policy, KELLER, 1_020_000, 0, 1_000_000);
  // F04: one consolidated reason names the payment, the fee allowance and both limits.
  assert.deepEqual([a.decision, a.reasons.length], ['EXCEPTION', 2]);
  assert.match(a.reasons[1], /\$10,000\.00 payment plus up to \$200\.00 PayPal fee allowance \(\$10,200\.00\) is above your \$5,000\.00 per-payment limit and your \$6,000\.00 daily limit/);
  const raised = (applyRuleChange(policy, { key: 'ap.paymentLimitMinor', scope: 'PAYABLES', value: 1_500_000 }, 'o', NOW) as { policy: typeof policy }).policy;
  const b = decidePayout(raised, KELLER, 1_020_000, 0, 1_000_000);
  assert.deepEqual([b.decision, b.reasons.length], ['EXCEPTION', 2]);
  assert.match(b.reasons[1], /daily limit/);
});

test('R1 labels: open dispute At risk; < 3 paid Not enough history; median 18 Mixed; Strong; missed arrangement caps at Mixed', () => {
  const h = heroHistory(DAY0);
  const t = (id: string) => assess(h.filter((x) => x.counterpartyId === id)).tier;
  assert.deepEqual([t(HARROW), t('cust-birch'), t('cust-alder'), t(MERCER), t(PELLOW), t('cust-copper'), t('nobody')], ['AT_RISK', 'NOT_ENOUGH_HISTORY', 'MIXED', 'STRONG', 'GOOD', 'MIXED', 'NOT_ENOUGH_HISTORY']);
});

const good = () => ({
  selected: hero().candidates.map((c, i) => ({ candidateId: c.rootId, order: i + 1 })), considered: [] as { candidateId: string; reasonCode: 'NOT_NEEDED' }[],
  why: hero().candidates.map((c) => ({ candidateId: c.rootId, reasons: (c.kind === 'PAYOUT' ? ['OWED_UNDER_AGREED_TERMS'] : ['HELPS_BEFORE_NEED_BY']) as any[], citations: [1] })),
  summary: 'COLLECT_WITH_FALLBACK' as const,
});
test('G1 planner gate: only finite codes; unknown ids, foreign citations, reasons that do not apply, free text and extra keys refused', () => {
  const c = hero().candidates;
  assert.equal(plannerGate(good(), c).ok, true);
  const bad = (f: (o: any) => unknown) => { const o: any = good(); return plannerGate(f(o) ?? o, c); };
  assert.equal(bad((o) => { o.selected[0].candidateId = 'COLLECT:inv-nope'; }).ok, false);
  assert.equal(bad((o) => { o.why[0].citations = [9]; }).ok, false);
  assert.equal(bad((o) => { o.why[0].reasons = ['HELD_FOR_YOUR_AUTHORITY']; }).ok, false, 'a payout reason on a collection');
  assert.equal(bad((o) => { o.why[0].reasons = ['NEEDS_YOUR_APPROVAL']; }).ok, false, 'Pellow runs within delegation');
  assert.equal(bad((o) => { o.why[0] = { ...o.why[0], text: 'Pellow will pay $7,700 by next Friday.' }; }).ok, false, 'no free text key exists');
  assert.equal(bad((o) => { o.summary = 'Your debt is erased.'; }).ok, false);
  assert.equal(bad((o) => { o.summary = 'HOLD_PAYOUT_ONLY'; }).ok, false, 'a summary that contradicts the selection');
  assert.equal(bad((o) => ({ ...o, amount: 1 })).ok, false);
});
test('G2 the held payout cannot be dropped', () => {
  const o = good();
  const pay = o.selected.pop()!;
  assert.equal(plannerGate({ ...o, considered: [{ candidateId: pay.candidateId, reasonCode: 'NOT_NEEDED' }] }, hero().candidates).ok, false);
});
test('G3/G5 (S4-IM-03, amended by the owner 2 Nov 2026) drafter: Nova writes the greeting and closing lines; any sentence, cancellation or receipt claim is refused', () => {
  const out = hero().candidates.filter((c) => c.kind !== 'PAYOUT');
  const ok = { drafts: out.map((c) => ({ candidateId: c.rootId, opening: 'DEAR_TEAM', closing: 'KIND_REGARDS' })) };
  assert.equal(drafterGate(ok, out).ok, true);
  for (const s2 of ['Your debt is erased.', 'Our records show your transfer arrived.', 'Please pay in three months.', 'We have waived the disputed balance.', 'We have waived the disputed balance,', 'Your debt is erased,']) {
    const b = structuredClone(ok) as any; b.drafts[0].opening = s2;
    assert.equal(drafterGate(b, out).ok, false, s2);
  }
  { const w = structuredClone(ok) as any; w.drafts[0].opening = 'Hello Pellow team,'; w.drafts[0].closing = 'Thanks so much,'; assert.equal(drafterGate(w, out).ok, true, 'a plain greeting Nova wrote'); }
  assert.equal(drafterGate({ ...ok, extra: 1 }, out).ok, false);
  assert.equal(drafterGate({ drafts: ok.drafts.slice(1) }, out).ok, false, 'one per outreach action');
  const m = messageFor(byKind('COLLECT_UNDISPUTED_SLICE'), { invoiceNumber: 'HR-x-002', dueOn: d(-7), openMinor: 900_000, disputedMinor: 180_000, ackOn: d(-5) }, 'Larkspur Home Services', { opening: 'DEAR_TEAM', closing: 'KIND_REGARDS' });
  assert.match(m.body, /^Dear Harrow Developments team,/);
  assert.match(m.body, /Could you pay \$7,200\.00 of that confirmed part/);
  assert.match(m.body, /\$1,800\.00 you raised stays open and separate/);
  const w = renderWhy(byKind('DISCOUNT_FALLBACK'), ['SMALL_CONCESSION', 'FALLBACK_ONLY_IF_SHORT']);
  assert.match(w, /The concession is \$90\.00\. It is a fallback/);
});

test('S4-IM-02 four $90 offers: each is decided on the others ($270 + $90 > $300) → exceptions; three ($270) stay within delegation', () => {
  const extra = (n: number) => Array.from({ length: n }, (_, i) => ({ invoiceId: `inv-m${i}`, number: `HR-x-1${i}`, customerId: MERCER, customerName: 'Mercer Architects', state: 'ISSUED', amountMinor: 450_000, openMinor: 450_000, dueOn: d(16 + i), failureReason: null }));
  const run = (n: number) => generateCandidates({ ...inputs(), invoices: [...inputs().invoices, ...extra(n)] }).candidates.filter((c) => c.kind === 'DISCOUNT_FALLBACK');
  assert.deepEqual(run(3).map((c) => c.authority.decision), ['EXCEPTION', 'EXCEPTION', 'EXCEPTION', 'EXCEPTION']);
  assert.ok(run(3).every((c) => c.authority.grantKinds.includes('DISCOUNT_OFFER')));
  assert.deepEqual(run(2).map((c) => c.authority.decision), ['REQUIRES_APPROVAL', 'REQUIRES_APPROVAL', 'REQUIRES_APPROVAL'], '$270 in total is within the $300 cap: each still needs you (S7-UX2)');
  const runA = (n: number) => generateCandidates({ ...inputs(), policy: aboveLimits, invoices: [...inputs().invoices, ...extra(n)] }).candidates.filter((c) => c.kind === 'DISCOUNT_FALLBACK');
  assert.deepEqual(runA(2).map((c) => c.authority.decision), ['ALLOW', 'ALLOW', 'ALLOW'], 'A-002 mode: within delegation');
});
test('S4-IM-06/07 a receipt on the disputed invoice → no undisputed slice; a below-fee balance is never a candidate', () => {
  const x = inputs();
  const paid = generateCandidates({ ...x, invoices: x.invoices.map((i) => (i.invoiceId === 'inv-harrow' ? { ...i, state: 'PARTIALLY_PAID', openMinor: 180_000 } : i)) });
  assert.ok(!paid.candidates.some((c) => c.kind === 'COLLECT_UNDISPUTED_SLICE'));
  assert.ok(paid.considered.some((c) => c.reasonCode === 'RECEIPT_UNATTRIBUTED' && !c.canAsk));
  assert.ok(paid.considered.some((c) => c.reasonCode === 'DISPUTED'));
  const tiny = generateCandidates({ ...x, invoices: x.invoices.map((i) => (i.invoiceId === 'inv-pellow' ? { ...i, amountMinor: 51, openMinor: 51 } : i)) });
  assert.ok(!tiny.candidates.some((c) => c.kind === 'COLLECT_OVERDUE') && tiny.considered.some((c) => c.reasonCode === 'TOO_SMALL'));
});
test('P3/P4 fixture: single and both collections equal hero v1a from day +3 (A-001 lands them on day +1); net fallback lows tracked', () => {
  const c = hero().candidates;
  const series = (ids: string[]) => price(c.filter((x) => ids.includes(x.rootId)).flatMap((x) => x.changes)).days.map((x) => x.closeMinor).slice(3);
  const from1 = (ids: string[]) => price(c.filter((x) => ids.includes(x.rootId)).flatMap((x) => x.changes)).days.map((x) => x.closeMinor).slice(1);
  assert.deepEqual(from1(['COLLECT:inv-pellow']), fx.pellow_only.slice(1), 'overdue Pellow now lands on day +1, exactly as A-001');
  assert.deepEqual(series(['SLICE:inv-harrow']), fx.harrow_only.slice(3));
  assert.deepEqual(series(['COLLECT:inv-pellow', 'SLICE:inv-harrow']), fx.both_captured.slice(3));
  const r = rows();
  assert.deepEqual([r['only:COLLECT:inv-pellow+OFFER:inv-mercer'].lowMinor, r['only:SLICE:inv-harrow+OFFER:inv-mercer'].lowMinor], [fx.fallback_net_lows.pellow_mercer, fx.fallback_net_lows.harrow_mercer]);
});

test('S6-R33 a paid occurrence is never proposed again: it is listed "Already paid"', () => {
  const x = inputs();
  x.payouts = x.payouts.map((p) => ({ ...p, paid: 'paid through PayPal' }));
  const r = generateCandidates(x);
  assert.equal(r.candidates.filter((c) => c.kind === 'PAYOUT').length, 0);
  assert.ok(r.considered.some((c) => c.reasonCode === 'ALREADY_PAID'));
});

test('S7 planner gate: the model may not leave out a collection or fallback that lands before the shortfall (live dev 3 Nov 2026)', () => {
  const { candidates } = generateCandidates(inputs());
  const why = (c: any) => ({ candidateId: c.rootId, reasons: ['HELPS_BEFORE_NEED_BY'], citations: [c.sources[0].n] });
  const pay = candidates.find((c) => c.kind === 'PAYOUT')!;
  const others = candidates.filter((c) => c.kind !== 'PAYOUT');
  const dropAll = { selected: [{ candidateId: pay.rootId, order: 1 }], considered: others.map((c) => ({ candidateId: c.rootId, reasonCode: 'NOT_NEEDED' })), why: [{ candidateId: pay.rootId, reasons: ['OWED_UNDER_AGREED_TERMS'], citations: [pay.sources[0].n] }], summary: 'HOLD_PAYOUT_ONLY' };
  const g = plannerGate(dropAll, candidates);
  assert.equal(g.ok, false);
  assert.match((g as { reason: string }).reason, /must be selected/);
  assert.ok(others.length && others.every((c) => !c.late), 'hero fixture: every collection lands before need-by');
  void why;
});
