import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PpBalances, PpTransactionsPage, type BalanceObservation, type ReportingRow } from '@headroom/contracts';
import { fixture } from '../../../../tests/fixtures/paypal/index.ts';
import { estimateCurrent, reconcile, type Movement } from './estimate.ts';
import { reserveCurrentlyMet } from './current.ts';
import { forecast42 } from './forecast.ts';
import { checkBalance, coverageOf, pickSnapshot, toReportingRows } from '../paypal-mirror/observe.ts';

// REPLAY: probe 01 1g snapshot + 2-day listing, sanitized.
const page = PpTransactionsPage.parse(fixture('transactions').body);
const bal = PpBalances.parse(fixture('balances').body);
const rows = toReportingRows([page]);
const checked = checkBalance(bal, null, '2026-10-31T12:55:44.000Z');
assert.ok(checked.ok);
const snap = { availableMinor: checked.availableMinor, reportedAsOf: checked.reportedAsOf, coverage: coverageOf([page], checked.reportedAsOf), withheldMinor: checked.withheldMinor };
const cap = fixture('capture-completed').body;
const capRow = rows.find((r) => r.transactionId === cap.id)!;
const capture = (over: Partial<Extract<Movement, { kind: 'CAPTURE' }>> = {}): Movement => ({
  kind: 'CAPTURE', key: `capture:${cap.id}`, runId: 'r1', captureId: cap.id, invoiceNumber: capRow.invoiceNumber!,
  grossMinor: 12000, feeMinor: 468, netMinor: 11532, settledAt: '2026-10-30T20:08:43.000Z', reversalDetected: false, captureStatus: 'COMPLETED', ...over,
});
const after = '2026-10-31T11:30:00.000Z';

test('probe 1g sample reconciles (REPLAY)', () => {
  assert.equal(snap.coverage, 'COMPLETE');
  assert.equal(snap.availableMinor, 532836);
  assert.equal(reconcile(snap.availableMinor!, snap.reportedAsOf!, 'COMPLETE', rows).state, 'PASS');
});

test('capture in reporting row not added again', () => {
  const e = estimateCurrent(snap, rows, [capture(), capture()])!;
  assert.equal(e.lines.length, 1, 'same economic key counted once');
  assert.equal(e.lines[0].status, 'INCLUDED');
  assert.equal(e.lowerMinor, 532836);
  assert.equal(e.upperMinor, 532836);
});

test('pre-asOf capture without row → OVERLAP_UNKNOWN', () => {
  const e = estimateCurrent(snap, rows, [capture({ captureId: 'NOTINREPORT', key: 'capture:NOTINREPORT' })])!;
  assert.equal(e.lines[0].status, 'OVERLAP_UNKNOWN');
  assert.equal(e.upperMinor, 532836);
});

test('S7-B10 a post-asOf capture PayPal confirms COMPLETED counts in both figures; one not confirmed stays upper-only; a pending outgoing payout row is no hold', () => {
  const e = estimateCurrent(snap, rows, [capture({ captureId: 'NEW', key: 'capture:NEW', settledAt: after })])!;
  assert.equal(e.lines[0].status, 'CONFIRMED_BY_CAPTURE');
  assert.deepEqual([e.lowerMinor, e.upperMinor], [532836 + 11532, 532836 + 11532]);
  const p = estimateCurrent(snap, rows, [capture({ captureId: 'NEW', key: 'capture:NEW', settledAt: after, captureStatus: 'PENDING' })])!;
  assert.equal(p.lines[0].status, 'ELIGIBILITY_UNCONFIRMED');
  assert.deepEqual([p.lowerMinor, p.upperMinor], [532836, 532836 + 11532]);
  assert.ok(!estimateCurrent(snap, rows, [])!.holds.some((h) => /T0001/.test(h)), 'the probe’s pending $25 payout row is not a hold');
});

test('null asOf → no reported figure', () => {
  const c = checkBalance({ ...bal, as_of_time: undefined }, null, after);
  assert.ok(c.ok && c.availableMinor === null && c.reportedAsOf === null);
  assert.equal(estimateCurrent({ ...snap, availableMinor: null, reportedAsOf: null }, rows, []), null);
});

test('future asOf rejected; account mismatch rejected', () => {
  assert.deepEqual(checkBalance({ ...bal, as_of_time: '2026-10-31T13:30:00Z' }, null, '2026-10-31T13:00:00.000Z'), { ok: false, reason: 'FUTURE_ASOF' });
  assert.deepEqual(checkBalance(bal, 'some-other-account', after), { ok: false, reason: 'ACCOUNT_MISMATCH' });
});

test('older asOf ignored', () => {
  const o = (asOf: string, retrievedAt: string, availableMinor = 1) => ({ reportedAsOf: asOf, retrievedAt, availableMinor }) as BalanceObservation;
  const picked = pickSnapshot([o('2026-10-31T10:00:00.000Z', '2026-10-31T12:00:00.000Z'), o('2026-10-31T09:00:00.000Z', '2026-10-31T13:00:00.000Z')]);
  assert.equal(picked!.reportedAsOf, '2026-10-31T10:00:00.000Z');
});

test('partial pages → OVERLAP_UNKNOWN', () => {
  assert.equal(coverageOf([{ ...page, total_pages: 2 }], snap.reportedAsOf), 'PARTIAL');
  const e = estimateCurrent({ ...snap, coverage: 'PARTIAL' }, rows, [capture()])!;
  assert.equal(e.reconciliation, 'UNKNOWN');
  assert.equal(e.lines[0].status, 'OVERLAP_UNKNOWN');
});

test('running-balance disagreement > $0.01 → RECONCILIATION_HOLD', () => {
  const e = estimateCurrent({ ...snap, availableMinor: 532836 + 2 }, rows, [capture()])!;
  assert.equal(e.reconciliation, 'HOLD');
  assert.equal(e.lines[0].status, 'OVERLAP_UNKNOWN');
  assert.equal(estimateCurrent({ ...snap, availableMinor: 532836 + 1 }, rows, [])!.reconciliation, 'PASS', 'within one cent passes');
});

test('ambiguous final row → UNKNOWN', () => {
  // The listing ends with two rows at one timestamp (5323.26 then 5328.36). A snapshot equal to the earlier one is ambiguous.
  assert.equal(reconcile(532326, snap.reportedAsOf!, 'COMPLETE', rows).state, 'UNKNOWN');
});

test('fingerprint mismatch → HOLD', () => {
  const e = estimateCurrent(snap, rows, [capture({ feeMinor: 400, netMinor: 11600 })])!;
  assert.equal(e.lines[0].status, 'RECONCILIATION_HOLD');
  const wrongInvoice = estimateCurrent(snap, rows, [capture({ invoiceNumber: 'HR-OTHER' })])!;
  assert.equal(wrongInvoice.lines[0].status, 'RECONCILIATION_HOLD');
});

test('post-asOf negative subtracted from both bounds; refund recomputes estimate once', () => {
  const refund: Movement = { kind: 'REFUND', key: 'refund:RF1', runId: 'r1', captureId: cap.id, transactionId: 'RF1', amountMinor: 3000, settledAt: after };
  const e = estimateCurrent(snap, rows, [capture(), refund, refund])!;
  assert.equal(e.lowerMinor, 532836 - 3000);
  assert.equal(e.upperMinor, 532836 - 3000);
  assert.equal(e.lines.filter((l) => l.status === 'SUBTRACTED').length, 1);
});

test('reversal status → net held; hold removes capture from upper', () => {
  const held = estimateCurrent(snap, rows, [capture({ captureId: 'NEW', key: 'capture:NEW', settledAt: after, reversalDetected: true })])!;
  assert.equal(held.lines[0].status, 'HELD_OUT');
  assert.equal(held.upperMinor, 532836);
  const holdRow: ReportingRow = { ...capRow, transactionId: 'HOLD1', eventCode: 'T1503', paypalReferenceId: 'NEW', initiatedAt: after, order: 999 };
  const e = estimateCurrent(snap, [...rows, holdRow], [capture({ captureId: 'NEW', key: 'capture:NEW', settledAt: after })])!;
  assert.equal(e.lines[0].status, 'HELD_OUT');
  assert.equal(e.upperMinor, 532836);
  assert.ok(e.holds.some((h) => h.includes('HOLD1')));
});

test('DTO keeps three figures separate: reported, estimate bounds, forecast', () => {
  const e = estimateCurrent(snap, rows, [capture({ captureId: 'NEW', key: 'capture:NEW', settledAt: after })])!;
  const f = forecast42(e.lowerMinor, [], '2026-11-01');
  assert.equal(f.series.length, 42);
  assert.equal(f.lowMinor, e.lowerMinor, 'forecast opens from the lower bound, not the upper');
  assert.notEqual(e.upperMinor, snap.availableMinor);
});

test('forecast42 low and date', () => {
  const f = forecast42(1000, [{ on: '2026-11-03', minor: -1500 }, { on: '2026-11-05', minor: 2000 }, { on: '2027-01-01', minor: -99999 }], '2026-11-01');
  assert.deepEqual([f.lowMinor, f.lowOn, f.to], [-500, '2026-11-03', '2026-12-12']);
});

const src = (o: Partial<Parameters<typeof reserveCurrentlyMet>[0][0]> = {}) => ({ name: 'PayPal', connected: true, reportedAvailableMinor: 900000, lowerBoundMinor: 900000, unresolvedLines: 0, asOf: '2026-11-01T12:00:00.000Z', reconciliation: 'PASS' as const, holds: [] as string[], ...o });
const BANK_OFF = { name: 'Bank', connected: false, reportedAvailableMinor: null, lowerBoundMinor: null, unresolvedLines: 0, asOf: null, reconciliation: null, holds: [] };

test('C-CURRENT-1: missing source → NOT_VERIFIABLE; no sources → NOT_VERIFIABLE (S1-IR-06)', () => {
  const r = reserveCurrentlyMet([src(), BANK_OFF], 400000, '2026-11-01T12:05:00.000Z');
  assert.equal(r.state, 'NOT_VERIFIABLE');
  assert.ok(r.reasons.includes('Bank not connected'));
  assert.equal(reserveCurrentlyMet([], 0, '2026-11-01T12:05:00.000Z').state, 'NOT_VERIFIABLE');
});

test('C-CURRENT-1: stale asOf → NOT_VERIFIABLE; only lower-bound reported available can pass', () => {
  assert.equal(reserveCurrentlyMet([src({ asOf: '2026-11-01T10:00:00.000Z' })], 400000, '2026-11-01T12:00:00.000Z').state, 'NOT_VERIFIABLE');
  const fresh = src({ asOf: '2026-11-01T11:55:00.000Z', reportedAvailableMinor: 500000, lowerBoundMinor: 500000 });
  assert.equal(reserveCurrentlyMet([fresh], 400000, '2026-11-01T12:00:00.000Z').state, 'MET');
  assert.equal(reserveCurrentlyMet([fresh], 400000, '2026-11-01T12:00:00.000Z', [150000]).state, 'NOT_MET');
  assert.equal(reserveCurrentlyMet([{ ...fresh, reportedAvailableMinor: null }], 0, '2026-11-01T12:00:00.000Z').state, 'NOT_VERIFIABLE');
  assert.equal(reserveCurrentlyMet([{ ...fresh, lowerBoundMinor: 390000 }], 400000, '2026-11-01T12:00:00.000Z').state, 'NOT_MET', 'a post-as-of refund lowers the lower bound below reserve');
  assert.equal(reserveCurrentlyMet([{ ...fresh, unresolvedLines: 1 }], 400000, '2026-11-01T12:00:00.000Z').state, 'NOT_VERIFIABLE', 'a held line blocks MET');
});

test('S1-IR-02 reversal detected on an INCLUDED capture → net leaves both bounds until the refund is recorded; then counted once', () => {
  const held = estimateCurrent(snap, rows, [capture({ reversalDetected: true })])!;
  assert.equal(held.lines[0].status, 'HELD_OUT');
  assert.deepEqual([held.lowerMinor, held.upperMinor], [532836 - 11532, 532836 - 11532]);
  const refund: Movement = { kind: 'REFUND', key: 'refund:RF1', runId: 'r1', captureId: cap.id, transactionId: 'RF1', amountMinor: 3000, settledAt: after };
  const recorded = estimateCurrent(snap, rows, [capture({ reversalDetected: true, captureStatus: 'PARTIALLY_REFUNDED' }), refund])!;
  assert.equal(recorded.lines[0].status, 'INCLUDED');
  assert.deepEqual([recorded.lowerMinor, recorded.upperMinor], [532836 - 3000, 532836 - 3000]);
});

test('S1-IM-02 a recorded partial refund does not clear a later full refund; the unreported remainder is subtracted once', () => {
  const refund: Movement = { kind: 'REFUND', key: 'refund:RF1', runId: 'r1', captureId: cap.id, transactionId: 'RF1', amountMinor: 3000, settledAt: after };
  const full = estimateCurrent(snap, rows, [capture({ reversalDetected: true, captureStatus: 'REFUNDED' }), refund])!;
  assert.deepEqual([full.lowerMinor, full.upperMinor], [532836 - 12000, 532836 - 12000], 'the 3000 refund plus the 9000 remainder: gross out once');
  const rest = full.lines.find((l) => l.key === `capture:${cap.id}:unreported-reversal`)!;
  assert.deepEqual([rest.status, rest.netMinor], ['HELD_OUT', -9000]);
  // The rest of the refund reaches the report: no remainder, no double subtraction.
  const refund2: Movement = { ...refund, key: 'refund:RF2', transactionId: 'RF2', amountMinor: 9000 };
  const done = estimateCurrent(snap, rows, [capture({ reversalDetected: true, captureStatus: 'REFUNDED' }), refund, refund2, refund2])!;
  assert.deepEqual([done.lowerMinor, done.upperMinor], [532836 - 12000, 532836 - 12000]);
  assert.equal(done.lines.some((l) => l.key.endsWith(':unreported-reversal')), false);
  // Several partial refunds: each subtracted once, nothing extra.
  const parts = estimateCurrent(snap, rows, [capture({ reversalDetected: true, captureStatus: 'PARTIALLY_REFUNDED' }), refund, { ...refund, key: 'refund:RF3', transactionId: 'RF3', amountMinor: 1000 }])!;
  assert.deepEqual([parts.lowerMinor, parts.upperMinor], [532836 - 4000, 532836 - 4000]);
});

test('S1-IR-10 a pending report row for our capture is "pending at PayPal", not a figures mismatch', () => {
  const pending: ReportingRow = { ...capRow, transactionId: 'NEWCAP', status: 'P', initiatedAt: after, order: 998 };
  const e = estimateCurrent(snap, [...rows, pending], [capture({ captureId: 'NEWCAP', key: 'capture:NEWCAP', settledAt: after })])!;
  assert.deepEqual([e.lines[0].status, e.lines[0].reason], ['HELD_OUT', 'Pending at PayPal']);
});

const bank = (o: Partial<Parameters<typeof reserveCurrentlyMet>[0][0]> = {}) => src({ name: 'Bank', reconciliation: 'NOT_APPLICABLE', reportedAvailableMinor: 813000, lowerBoundMinor: 813000, ...o });
test('C-CURRENT-1 with bank: reconnect required → NOT_VERIFIABLE; read > 15 min → not recent; cached read without as-of → as-of unknown; all recent → MET reachable', () => {
  const now = '2026-11-01T12:05:00.000Z';
  const pp = src({ asOf: '2026-11-01T12:00:00.000Z' });
  const rr = reserveCurrentlyMet([pp, bank({ connected: false, notConnectedReason: 'Bank needs reconnecting' })], 400000, now);
  assert.deepEqual([rr.state, rr.reasons], ['NOT_VERIFIABLE', ['Bank needs reconnecting']]);
  const old = reserveCurrentlyMet([pp, bank({ asOf: '2026-11-01T11:49:00.000Z' })], 400000, now);
  assert.equal(old.state, 'NOT_VERIFIABLE');
  assert.match(old.reasons[0], /Bank report is not recent/);
  assert.deepEqual(reserveCurrentlyMet([pp, bank({ asOf: null })], 400000, now).reasons, ['Bank as-of time unknown']);
  assert.equal(reserveCurrentlyMet([pp, bank({ asOf: '2026-11-01T12:04:00.000Z' })], 400000, now).state, 'MET', 'NOT_APPLICABLE reconciliation is satisfied');
  assert.equal(reserveCurrentlyMet([src({ asOf: '2026-11-01T10:00:00.000Z' }), bank({ asOf: '2026-11-01T12:04:00.000Z' })], 400000, now).state, 'NOT_VERIFIABLE', 'PayPal (~2 h lag) keeps S2 NOT_VERIFIABLE');
});
