import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { FItem } from '../cash-forecast/forecast.ts';
import { addDays } from '../time.ts';
import { evaluateSkip, type SkipInputs } from './skip.ts';

// Tracked sanitized fixture (A-001 hero v1a): day 0 = Mon 2026-11-09, opening 993000, reserve 400000.
const fx = JSON.parse(readFileSync(new URL('../../../../tests/fixtures/hero-v1a/closes.json', import.meta.url), 'utf8'));
const cons: number[] = fx.both_captured_conservative;
const day0: string = fx.day0;
const PELLOW_NET = 733_427, HARROW_NET = 694_823;
// The conservative series' only rise is the two captures on day 1; every fall is an accepted outflow (fee included).
const outflows: FItem[] = cons.flatMap((c, i) => (i > 0 && c < cons[i - 1] ? [{ key: `out${i}`, on: addDays(day0, i), direction: 'OUT' as const, amountMinor: cons[i - 1] - c, feeMinor: 0, basis: 'BILL' as const, label: 'outflow', provenance: 'SEEDED' as const, ref: { kind: 'OBLIGATION' as const, id: `o${i}` }, note: null }] : []));
const inflow = (on: string, amountMinor: number, basis: FItem['basis'] = 'STATED'): FItem => ({ key: `in-${on}-${basis}`, on, direction: 'IN', amountMinor, feeMinor: 0, basis, label: 'inflow', provenance: 'SEEDED', ref: { kind: 'INFLOW', id: on }, note: null });

const NOW = '2026-11-11T09:00:00.000Z';
const fresh = (o: { paypalLower: number; pending?: number; items?: FItem[]; patch?: Partial<SkipInputs> }): SkipInputs => ({
  now: NOW, today: day0, reserveMinor: fx.reserveMinor,
  bank: { availableMinor: 813_000, retrievedAt: '2026-11-11T08:55:00.000Z' },
  paypal: { lowerMinor: o.paypalLower, capturedPendingMinor: o.pending ?? 0, asOf: '2026-11-11T07:00:00.000Z', fetchedAt: '2026-11-11T08:58:00.000Z', reconciliation: 'PASS' },
  items: o.items ?? outflows, blockers: [], ...o.patch,
});
const PAYPAL_OPENING = 180_000; // 993000 = bank 813000 + PayPal 180000

test('K1 skip: hero both in report → skip; lower min 444250 on day +41 (Dec 20) equals the tracked conservative fixture', () => {
  const r = evaluateSkip(fresh({ paypalLower: PAYPAL_OPENING + PELLOW_NET + HARROW_NET }));
  assert.equal(r.decision, 'SKIP');
  assert.deepEqual(r.lowerMin, { on: '2026-12-20', closeMinor: 444_250 });
  assert.equal(r.lowerMin!.closeMinor, Math.min(...cons));
  assert.deepEqual(r.lowerSeries!.slice(1).map((p) => p.closeMinor), cons.slice(1), 'same series from day 1 on (captures counted from day 0 here)');
});

test('K2 skip: both captured, neither in the report → HELD_EVIDENCE (AT-F01): lower −984000, upper 444250', () => {
  const r = evaluateSkip(fresh({ paypalLower: PAYPAL_OPENING, pending: PELLOW_NET + HARROW_NET }));
  assert.equal(r.decision, 'HELD_EVIDENCE');
  assert.deepEqual([r.lowerMin!.closeMinor, r.upperMin!.closeMinor, r.lowerMin!.on], [-984_000, 444_250, '2026-12-20']);
  assert.match(r.reason, /not yet in PayPal's report/);
});

test('K3 skip: one payer → offer needed (S5-R2): Pellow only −248598, Harrow only −287202', () => {
  const p = evaluateSkip(fresh({ paypalLower: PAYPAL_OPENING + PELLOW_NET }));
  const h = evaluateSkip(fresh({ paypalLower: PAYPAL_OPENING + HARROW_NET }));
  assert.deepEqual([p.decision, p.lowerMin!.closeMinor, p.upperMin!.closeMinor], ['NEEDED', -250_573, -250_573]);
  assert.deepEqual([h.decision, h.lowerMin!.closeMinor], ['NEEDED', -289_177]);
});

test('K4 skip: blockers hold before any arithmetic (stale/missing sources, reconciliation, caller blockers)', () => {
  const ok = PAYPAL_OPENING + PELLOW_NET + HARROW_NET;
  const cases: [string, Partial<SkipInputs>][] = [
    ['BANK_STALE', { bank: { availableMinor: 813_000, retrievedAt: '2026-11-11T08:44:00.000Z' } }],
    ['BANK_MISSING', { bank: { availableMinor: null, retrievedAt: null } }],
    ['PAYPAL_FETCH_STALE', { paypal: { lowerMinor: ok, capturedPendingMinor: 0, asOf: '2026-11-11T07:00:00.000Z', fetchedAt: '2026-11-11T08:54:00.000Z', reconciliation: 'PASS' } }],
    ['PAYPAL_ASOF_STALE', { paypal: { lowerMinor: ok, capturedPendingMinor: 0, asOf: '2026-11-11T00:59:00.000Z', fetchedAt: '2026-11-11T08:58:00.000Z', reconciliation: 'PASS' } }],
    ['RECONCILIATION_UNKNOWN', { paypal: { lowerMinor: ok, capturedPendingMinor: 0, asOf: '2026-11-11T07:00:00.000Z', fetchedAt: '2026-11-11T08:58:00.000Z', reconciliation: 'UNKNOWN' } }],
    ['RECONCILIATION_HOLD', { paypal: { lowerMinor: ok, capturedPendingMinor: 0, asOf: '2026-11-11T07:00:00.000Z', fetchedAt: '2026-11-11T08:58:00.000Z', reconciliation: 'HOLD' } }],
    ...['REFUND_UNKNOWN', 'CAPTURE_REVERSAL', 'UPDATE_IN_FLIGHT', 'BILL_UNDECIDED', 'REFRESH_INCOMPLETE'].map((code): [string, Partial<SkipInputs>] => [code, { blockers: [{ code, text: code, ref: null }] }]),
  ];
  for (const [code, patch] of cases) {
    const r = evaluateSkip(fresh({ paypalLower: ok, patch }));
    assert.equal(r.decision, 'HELD_EVIDENCE', code);
    assert.ok(r.blockers.some((b) => b.code === code), code);
    assert.equal(r.lowerSeries, null, `${code}: not evaluated`);
  }
});

test('K5 skip: promises, stated receipts, targets and open invoices never count (IC-2, S5-R6)', () => {
  const base = evaluateSkip(fresh({ paypalLower: PAYPAL_OPENING + PELLOW_NET }));
  const withIns = evaluateSkip(fresh({ paypalLower: PAYPAL_OPENING + PELLOW_NET, items: [...outflows, inflow('2026-11-12', 760_000, 'STATED'), inflow('2026-11-13', 720_000, 'TARGET'), inflow('2026-11-25', 450_000, 'PAST_DUE')] }));
  assert.deepEqual([withIns.decision, withIns.lowerMin, withIns.upperMin], [base.decision, base.lowerMin, base.upperMin]);
});
