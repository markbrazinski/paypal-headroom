import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Commitment, Occurrence, Supplier } from '@headroom/contracts';
import { forecastDays } from '../cash-forecast/forecast.ts';
import { reserveCurrentlyMet } from '../cash-forecast/current.ts';
import { addDays } from '../time.ts';
import { dueObligationsMinor, monthlyOn, movements, occKey, occurrencesOf, scheduleDates, type StoredObligation } from './obligations.ts';
import { MILESTONE, SEED_SUPPLIERS, seedCommitments, seedInflows } from './seed.ts';
import { changedFieldsOf, classOf, matchBill, resolveSupplier, type MatchInput } from './match.ts';

const fx = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/hero-v1a/closes.json', import.meta.url), 'utf8'));
const DAY0 = fx.day0 as string;
const RESERVE = fx.reserveMinor as number;
const cmts = seedCommitments(DAY0, `${DAY0}T14:00:00.000Z`);
const inflows = seedInflows(DAY0);
const until = addDays(DAY0, 41 + 92);
const occs = (stored = new Map<string, StoredObligation>(), cs: Commitment[] = cmts) => cs.flatMap((c) => occurrencesOf(c, stored, until));
const hero = (stored?: Map<string, StoredObligation>, today = DAY0) => {
  const m = movements({ commitments: cmts, occurrences: occs(stored), inflows, billRefs: new Map() }, today);
  return { ...forecastDays(fx.openingMinor, m.items, today, RESERVE), notInForecast: m.notInForecast };
};
const accepted = () => new Map([[occKey(MILESTONE, 0), { commitmentId: MILESTONE, n: 0, scheduledOn: addDays(DAY0, 24), dueOn: addDays(DAY0, 4), amount: { currency: 'USD' as const, minor: 1_000_000 }, version: 2, substantiatedBy: 'b1', termsVersion: 1 }]]);

test('F1 forecast: hero v1a before acceptance equals the tracked fixture', () => {
  const f = hero();
  assert.deepEqual(f.days.map((d) => d.closeMinor), fx.prior_accepted_terms);
  assert.deepEqual([f.summary.lowMinor, f.summary.lowOn], [446_000, addDays(DAY0, 24)]);
  assert.equal(f.summary.firstBelowReserve, null);
  assert.equal(f.summary.reserveGapMinor, 0);
});

test('F2 forecast: hero v1a after acceptance — Nov 13 −$90.00 NEGATIVE, low −$4,540.00 Nov 20, gap $8,540.00, deficit $4,540.00, 18 negative days', () => {
  const f = hero(accepted());
  assert.deepEqual(f.days.map((d) => d.closeMinor), fx.bill_accepted_no_collection);
  assert.deepEqual([f.days[4].closeMinor, f.days[4].state], [-9000, 'NEGATIVE']);
  assert.equal(f.summary.firstBelowReserve, addDays(DAY0, 4));
  assert.deepEqual([f.summary.lowMinor, f.summary.lowOn], [-454_000, addDays(DAY0, 11)]);
  assert.equal(f.summary.reserveGapMinor, 854_000);
  assert.equal(f.summary.fundingDeficitMinor, 454_000);
  assert.equal(f.summary.negativeDays, 18);
  assert.ok(f.days.slice(4, 22).every((d) => d.state === 'NEGATIVE'));
});

test('F3 forecast: day states at boundaries', () => {
  const s = (close: number) => forecastDays(close, [], DAY0, RESERVE).days[0].state;
  assert.deepEqual([s(0), s(RESERVE), s(RESERVE - 1), s(RESERVE + 1), s(-1)], ['NEGATIVE', 'AT', 'BELOW', 'ABOVE', 'NEGATIVE']);
});

test('F4 forecast: same-day dependency ◆ on day +22 after acceptance (opening −$40.00, out $1,500)', () => {
  const d = hero(accepted()).days[22];
  assert.deepEqual([d.openingMinor, d.outMinor, d.inMinor, d.sameDay], [-4000, 150_000, 600_000, true]);
  assert.equal(hero().days[22].sameDay, false, 'before acceptance the opening covers it');
});

test('F7 forecast: a past-due unpaid occurrence lands on day 0 with basis PAST_DUE', () => {
  const f = hero(undefined, addDays(DAY0, 8)); // rental (+7) has passed unpaid
  const d0 = f.days[0];
  const rental = d0.items.find((i) => i.label === 'Equipment rental')!;
  assert.equal(rental.basis, 'PAST_DUE');
  assert.match(rental.note!, /Was due/);
});

test('F8 forecast: after the horizon → not yet assessed, no movement', () => {
  const late: Commitment = { ...cmts[1], commitmentId: 'cmt-late', name: 'Van lease', schedule: { kind: 'ONCE', on: addDays(DAY0, 50) } };
  const m = movements({ commitments: [...cmts, late], occurrences: occs(undefined, [...cmts, late]), inflows, billRefs: new Map() }, DAY0);
  assert.ok(!m.items.some((i) => i.label === 'Van lease'));
  assert.ok(m.notInForecast.some((r) => r.key === 'after:cmt-late' && /not yet assessed/.test(r.reason)));
});

test('F9 forecast: the PAYPAL_PAYOUT rail adds a separate $20.00 fee estimate; the obligation amount is unchanged', () => {
  const k = hero().days[24].items.find((i) => i.ref.id === occKey(MILESTONE, 0))!;
  assert.deepEqual([k.amountMinor, k.feeMinor], [1_000_000, 2000]);
  assert.equal(hero().days[24].outMinor, 1_002_000);
});

test('F5/F6: occurrences, not bills, make outflows; a REPLACE change is comparison only and equals the accepted series', () => {
  const m = movements({ commitments: cmts, occurrences: occs(), inflows, billRefs: new Map() }, DAY0, { kind: 'REPLACE', occurrenceKey: occKey(MILESTONE, 0), dueOn: addDays(DAY0, 4), amountMinor: 1_000_000 });
  assert.deepEqual(forecastDays(fx.openingMinor, m.items, DAY0, RESERVE).days.map((d) => d.closeMinor), fx.bill_accepted_no_collection);
  assert.deepEqual(hero().days.map((d) => d.closeMinor), fx.prior_accepted_terms, 'operative unchanged');
  assert.equal(m.items.filter((i) => i.ref.id === occKey(MILESTONE, 0)).length, 1, 'one outflow, moved');
});

test('O1 occurrences: an after-horizon ONCE commitment enters on the read where the horizon reaches it', () => {
  const c: Commitment = { ...cmts[1], commitmentId: 'c1', schedule: { kind: 'ONCE', on: addDays(DAY0, 45) } };
  const items = (today: string) => movements({ commitments: [c], occurrences: occurrencesOf(c, new Map(), addDays(today, 133)), inflows: [], billRefs: new Map() }, today).items;
  assert.equal(items(DAY0).length, 0);
  assert.equal(items(addDays(DAY0, 4)).length, 1);
});

test('O2 occurrences: monthly created Nov 1 for Nov 15 → Dec 15 appears once the horizon reaches it, exactly once', () => {
  const c: Commitment = { ...cmts[1], commitmentId: 'm', createdOn: '2026-11-01', schedule: { kind: 'MONTHLY', anchorOn: '2026-11-15', endOn: null } };
  const keys = (today: string) => movements({ commitments: [c], occurrences: occurrencesOf(c, new Map(), addDays(today, 133)), inflows: [], billRefs: new Map() }, today).items.map((i) => `${i.key}@${i.on}`);
  assert.deepEqual(keys('2026-11-01'), ['occ#m#0@2026-11-15']);
  assert.deepEqual(keys('2026-11-10'), ['occ#m#0@2026-11-15', 'occ#m#1@2026-12-15']);
});

test('O3 occurrences: Jan 31 anchor → Feb 28 (Feb 29 in 2028) → Mar 31', () => {
  assert.deepEqual([0, 1, 2].map((n) => monthlyOn('2027-01-31', n)), ['2027-01-31', '2027-02-28', '2027-03-31']);
  assert.equal(monthlyOn('2028-01-31', 1), '2028-02-29');
  assert.deepEqual(scheduleDates({ kind: 'MONTHLY', anchorOn: '2026-11-15', endOn: '2026-12-31' }, '2026-11-01', '2027-06-01').map((x) => x.on), ['2026-11-15', '2026-12-15']);
});

test('O5 occurrences: accepted per-occurrence terms survive later reads and rollovers; other occurrences keep the defaults', () => {
  const c: Commitment = { ...cmts[2], commitmentId: 'p', schedule: { kind: 'MONTHLY', anchorOn: DAY0, endOn: null } };
  const stored = new Map([[occKey('p', 1), { commitmentId: 'p', n: 1, scheduledOn: monthlyOn(DAY0, 1), dueOn: addDays(monthlyOn(DAY0, 1), -2), amount: { currency: 'USD' as const, minor: 400_000 }, version: 2, termsVersion: 1 }]]);
  for (const today of [DAY0, addDays(DAY0, 20)]) {
    const o = occurrencesOf(c, stored, addDays(today, 133));
    assert.deepEqual([o[1].dueOn, o[1].amount.minor, o[1].materialized], [addDays(monthlyOn(DAY0, 1), -2), 400_000, true]);
    assert.deepEqual([o[2].amount.minor, o[2].materialized], [380_000, false]);
  }
});

test('O6 occurrences: generation starts at max(anchor, created date); unpaid past occurrences stay on day 0', () => {
  const c: Commitment = { ...cmts[1], commitmentId: 'm', createdOn: '2026-11-20', schedule: { kind: 'MONTHLY', anchorOn: '2026-10-15', endOn: null } };
  assert.equal(scheduleDates(c.schedule, c.createdOn, '2027-01-31')[0].on, '2026-12-15', 'Oct 15 and Nov 15 precede creation');
  const items = movements({ commitments: [c], occurrences: occurrencesOf(c, new Map(), '2027-05-01'), inflows: [], billRefs: new Map() }, '2026-12-20').items;
  assert.deepEqual(items.map((i) => [i.on, i.basis]), [['2026-12-20', 'PAST_DUE'], ['2027-01-15', 'COMMITMENT']]);
});

test('B1 badge: fresh $9,930 with a due $10,020.00 occurrence → NOT_MET; the same occurrence due tomorrow → not subtracted', () => {
  const src = [{ name: 'All', connected: true, reportedAvailableMinor: 993_000, lowerBoundMinor: 993_000, unresolvedLines: 0, asOf: `${DAY0}T13:59:00.000Z`, reconciliation: 'PASS' as const, holds: [] }];
  const now = `${DAY0}T14:00:00.000Z`;
  const dueToday = new Map([[occKey(MILESTONE, 0), { ...accepted().get(occKey(MILESTONE, 0))!, dueOn: DAY0 }]]);
  const d = dueObligationsMinor(cmts, occs(dueToday), DAY0);
  assert.deepEqual(d, [1_002_000]);
  assert.equal(reserveCurrentlyMet(src, RESERVE, now, d).state, 'NOT_MET');
  const tomorrow = new Map([[occKey(MILESTONE, 0), { ...dueToday.get(occKey(MILESTONE, 0))!, dueOn: addDays(DAY0, 1) }]]);
  assert.deepEqual(dueObligationsMinor(cmts, occs(tomorrow), DAY0), []);
  assert.equal(reserveCurrentlyMet(src, RESERVE, now, []).state, 'MET');
});

// ---------- matching ----------
const keller: MatchInput = { supplierName: 'Keller Drafting Co.', billNumber: 'K-2207', reference: 'MS-2', dueOn: addDays(DAY0, 4), totalMinor: 1_000_000, currency: 'USD', remittanceLast4: '4417' };
const sups: Supplier[] = [...SEED_SUPPLIERS, { supplierId: 'sup-north-a', displayName: 'Northwind Logistics', aliases: [], verifiedRemittanceLast4: null, basis: 'SEEDED' }, { supplierId: 'sup-north-b', displayName: 'Northwind Leasing', aliases: [], verifiedRemittanceLast4: null, basis: 'SEEDED' }];

test('M1 match: supplier resolution — exact/alias, shared first token → ambiguous, else unknown', () => {
  assert.equal(resolveSupplier('KELLER DRAFTING', sups).kind, 'MATCH');
  assert.equal(resolveSupplier('Keller Drafting Co', sups).kind, 'MATCH');
  assert.deepEqual(resolveSupplier('Northwind', sups), { kind: 'AMBIGUOUS', ids: ['sup-north-a', 'sup-north-b'] });
  assert.equal(resolveSupplier('Keller Design Studio', sups).kind, 'AMBIGUOUS');
  assert.equal(resolveSupplier('Tidewater Supply', sups).kind, 'UNKNOWN');
});

test('M2/M3 match: reference wins → DATE_CHANGE_REQUESTED; amount-only, both, exact; no commitment → NEW_OBLIGATION; two same-amount → AMBIGUOUS_COMMITMENT', () => {
  const m = (b: Partial<MatchInput>) => matchBill({ ...keller, ...b }, sups, cmts, occs(), []);
  const r = m({});
  assert.deepEqual([r.classification, r.occurrenceKey, r.changedFields, r.held], ['DATE_CHANGE_REQUESTED', occKey(MILESTONE, 0), ['dueOn'], false]);
  assert.deepEqual(m({ dueOn: addDays(DAY0, 24), totalMinor: 1_040_000 }).changedFields, ['amount']);
  assert.equal(m({ dueOn: addDays(DAY0, 24), totalMinor: 1_040_000 }).classification, 'AMOUNT_DISCREPANCY');
  assert.equal(m({ totalMinor: 1_040_000 }).classification, 'TERMS_DIFFER');
  assert.equal(m({ dueOn: addDays(DAY0, 24) }).classification, 'EXACT_MATCH');
  assert.equal(m({ reference: null, billNumber: 'K-2300', totalMinor: 48_000 }).classification, 'NEW_OBLIGATION_KNOWN_SUPPLIER');
  const amb = matchBill({ supplierName: 'Brightline Payroll Services', billNumber: 'BP-1', reference: null, dueOn: addDays(DAY0, 11), totalMinor: 380_000, currency: 'USD', remittanceLast4: null }, sups, cmts, occs(), []);
  assert.deepEqual([amb.classification, amb.candidates.length, amb.held], ['AMBIGUOUS_COMMITMENT', 2, false]);
  assert.deepEqual([classOf(changedFieldsOf({ dueOn: DAY0, amount: { currency: 'USD', minor: 1 } }, DAY0, 1))], ['EXACT_MATCH']);
});

test('M4 match: revision same terms → held, nothing to do; changed terms → REVISION_CHANGED_TERMS on the same occurrence; another number on a billed occurrence → ALREADY_BILLED', () => {
  const prior = { billId: 'b1', supplierId: 'sup-keller', billNumber: 'K-2207', dueOn: addDays(DAY0, 4), totalMinor: 1_000_000, occurrenceKey: occKey(MILESTONE, 0) };
  const same = matchBill(keller, sups, cmts, occs(), [prior]);
  assert.deepEqual([same.classification, same.held, same.revisionOf], ['REVISION_SAME_TERMS', true, 'b1']);
  assert.match(same.holdReasons[0], /already received; nothing to do/);
  const changed = matchBill({ ...keller, totalMinor: 1_020_000 }, sups, cmts, occs(), [prior]);
  assert.deepEqual([changed.classification, changed.occurrenceKey, changed.revisionOf, changed.held], ['REVISION_CHANGED_TERMS', occKey(MILESTONE, 0), 'b1', false]);
  const billed = matchBill({ ...keller, billNumber: 'K-9999' }, sups, cmts, occs(accepted()), []);
  assert.deepEqual([billed.classification, billed.held], ['COMMITMENT_ALREADY_BILLED', true]);
});

test('M5 match: remittance last-4 that differs from the verified value → held with REMITTANCE_CHANGE, match kept for context', () => {
  const r = matchBill({ ...keller, remittanceLast4: '9999' }, sups, cmts, occs(), []);
  assert.deepEqual([r.held, r.remittanceChange, r.classification], [true, true, 'DATE_CHANGE_REQUESTED']);
  assert.match(r.holdReasons.at(-1)!, /ending 9999.*4417/);
});

test('C6 currency: bill currency ≠ occurrence currency → HELD CURRENCY_MISMATCH', () => {
  const r = matchBill({ ...keller, currency: 'CAD' }, sups, cmts, occs(), []);
  assert.deepEqual([r.classification, r.held], ['CURRENCY_MISMATCH', true]);
});

test('unknown and ambiguous suppliers are held (potential only, no outflow)', () => {
  assert.deepEqual([matchBill({ ...keller, supplierName: 'Tidewater Supply' }, sups, cmts, occs(), []).classification], ['UNKNOWN_SUPPLIER']);
  const a = matchBill({ ...keller, supplierName: 'Keller Design Studio' }, sups, cmts, occs(), []);
  assert.deepEqual([a.classification, a.held], ['AMBIGUOUS_SUPPLIER', true]);
});
