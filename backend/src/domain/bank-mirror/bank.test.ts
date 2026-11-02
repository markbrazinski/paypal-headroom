import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlaidBalanceGet, PlaidSyncPage, transitions, type BankAccountBalance } from '@headroom/contracts';
import { fixture } from '../../../../tests/fixtures/plaid/index.ts';
import { applySync, bankFingerprint, bankSource, classifyAccount, classifyError, countedOf, countedRows, toObservation, validUntil, bankBoundaries, freshnessOf } from './bank.ts';

const NOW = '2026-11-01T14:00:00.000Z';
const demoObs = (retrievedAt = NOW) => toObservation('item-1', PlaidBalanceGet.parse(fixture('balance-demo').body).accounts, retrievedAt, 'sha');
const page = (n: string) => PlaidSyncPage.parse(fixture(n).body);
const acct = (o: Partial<BankAccountBalance>): BankAccountBalance => ({
  accountId: 'a', name: 'Checking', mask: '0001', type: 'depository', subtype: 'checking', holderCategory: 'business',
  available: { value: '100', currencyCode: 'USD', currencyKind: 'ISO' }, current: { value: '100', currencyCode: 'USD', currencyKind: 'ISO' }, limit: null,
  availableMinor: 10000, currentMinor: 10000, precisionRefused: false, lastUpdatedAt: null, ...o,
});

test('S2-D1 only depository/checking counts; savings, card, loan not; holder_category personal still counted (fixture guard)', () => {
  const obs = demoObs();
  const [chk, sav, card] = obs.accounts;
  assert.equal(chk.holderCategory, 'personal', 'the sandbox reports the hero checking account as personal');
  assert.deepEqual([classifyAccount(chk).role, classifyAccount(chk).eligibleMinor], ['COUNTED', 813_000]);
  assert.deepEqual([classifyAccount(sav).role, classifyAccount(sav).refusal, classifyAccount(sav).label], ['NOT_COUNTED', 'AVAILABILITY_NOT_REPORTED', 'Balance — availability not reported · not counted']);
  assert.deepEqual([classifyAccount(card).role, classifyAccount(card).eligibleMinor], ['OWED', null], 'credit is owed, never subtracted from cash');
  assert.equal(classifyAccount(acct({ type: 'loan', subtype: 'mortgage' })).role, 'NOT_CASH');
  assert.equal(classifyAccount(acct({ type: 'investment', subtype: 'brokerage' })).role, 'NOT_CASH');
  assert.equal(classifyAccount(acct({ subtype: 'savings' })).refusal, 'NOT_CHECKING');
  assert.deepEqual(countedOf(obs.accounts), { countedMinor: 813_000, incomplete: [] });
});

test('invariant 5: null available stays null: never current, never 0; a checking null makes counted null + incomplete', () => {
  const sav = demoObs().accounts[1];
  assert.equal(sav.available, null);
  assert.equal(sav.availableMinor, null);
  assert.equal(sav.currentMinor, 1_500_000, 'current is shown, never substituted');
  const r = countedOf([acct({}), acct({ accountId: 'b', name: 'Ops', mask: '0002', available: null, availableMinor: null })]);
  assert.deepEqual(r, { countedMinor: null, incomplete: ['Ops ··0002'] });
  assert.deepEqual(countedOf([acct({ subtype: 'savings' })]), { countedMinor: null, incomplete: [] }, 'nothing countable → null, not 0');
});

test('S2-R10/R30 exact money: 8130 → 813000; 1024.502621 and 446.8112897 refused with the exact value; EUR and unofficial kept apart', () => {
  const precise = toObservation('i', PlaidBalanceGet.parse(fixture('balance-dynamic-precision').body).accounts, NOW, 's').accounts.find((a) => a.available?.value === '446.8112897')!;
  assert.deepEqual([precise.availableMinor, precise.precisionRefused, classifyAccount(precise).refusal], [null, true, 'PROVIDER_PRECISION']);
  const odd = toObservation('i', [{ account_id: 'x', name: 'Chk', mask: '1', type: 'depository', subtype: 'checking', balances: { available: null, current: 1024.502621, iso_currency_code: 'USD' } }], NOW, 's').accounts[0];
  assert.deepEqual([odd.current, odd.currentMinor], [{ value: '1024.502621', currencyCode: 'USD', currencyKind: 'ISO' }, null]);
  const eur = toObservation('i', [{ account_id: 'e', name: 'Euro', mask: '9', type: 'depository', subtype: 'checking', balances: { available: null, current: 123.45, iso_currency_code: 'EUR' } }], NOW, 's').accounts[0];
  assert.deepEqual([eur.current, eur.currentMinor, classifyAccount(eur).refusal, classifyAccount(eur).eligibleMinor], [{ value: '123.45', currencyCode: 'EUR', currencyKind: 'ISO' }, null, 'UNSUPPORTED_CURRENCY', null]);
  const unoff = toObservation('i', [{ account_id: 'u', name: 'Coin', mask: '8', type: 'depository', subtype: 'checking', balances: { available: 5, current: 5, iso_currency_code: null, unofficial_currency_code: 'XBT' } }], NOW, 's').accounts[0];
  assert.deepEqual([unoff.available!.currencyKind, classifyAccount(unoff).refusal], ['UNOFFICIAL', 'UNSUPPORTED_CURRENCY']);
  const unknown = toObservation('i', [{ account_id: 'k', name: 'K', mask: '7', type: 'depository', subtype: 'checking', balances: { available: 5, current: 5, iso_currency_code: null } }], NOW, 's').accounts[0];
  assert.equal(classifyAccount(unknown).refusal, 'UNKNOWN_CURRENCY');
});

test('S2-R1 pending→posted once (REPLAY probe pages 013 → 021): zero pending active next to its successor', () => {
  const a = applySync([], [page('sync-dynamic-initial')], NOW);
  const pendingBefore = countedRows(a.projection).filter((r) => r.state === 'pending').length;
  const b = applySync(a.projection, [page('sync-dynamic-after-refresh')], '2026-11-01T15:00:00.000Z');
  const counted = countedRows(b.projection);
  const posted = new Set(counted.filter((r) => r.state === 'posted' && r.pendingTransactionId).map((r) => r.pendingTransactionId));
  assert.equal(posted.size, 16);
  assert.equal(counted.filter((r) => r.state === 'pending' && posted.has(r.transactionId)).length, 0);
  assert.equal(pendingBefore, 17);
  assert.equal(counted.filter((r) => r.state === 'pending').length, 1 + 17, 'the one unreplaced pending plus the refresh\'s 17 new pending rows');
  assert.equal(b.changes.filter((c) => c.change === 'removed').length, 16);
  assert.equal(b.projection.filter((r) => r.state === 'removed').length, 16, 'removed rows are tombstoned, history kept');
});

test('supersede before Plaid\'s removal arrives: a posted row hides its pending even if the pending is not yet removed (probe D4)', () => {
  const p = page('sync-dynamic-after-refresh');
  const withoutRemovals = applySync(applySync([], [page('sync-dynamic-initial')], NOW).projection, [{ ...p, removed: [] }], NOW);
  const counted = countedRows(withoutRemovals.projection);
  const sup = new Set(counted.filter((r) => r.pendingTransactionId).map((r) => r.pendingTransactionId));
  assert.equal(counted.filter((r) => sup.has(r.transactionId)).length, 0);
});

test('B1/A3 idempotent sync: the same pages twice → zero changes, nothing added twice', () => {
  const a = applySync([], [page('sync-demo')], NOW);
  assert.equal(a.changes.length, 9);
  const b = applySync(a.projection, [page('sync-demo')], '2026-11-01T15:00:00.000Z');
  assert.equal(b.changes.length, 0);
  assert.equal(b.projection.length, 9);
});

test('case 3 modified replaces fields with one change row; removed hidden, history kept (synthetic page, labelled: sandbox never produced modified)', () => {
  const a = applySync([], [page('sync-demo')], NOW);
  const t = page('sync-demo').added[0];
  const b = applySync(a.projection, [{ added: [], modified: [{ ...t, amount: 2150 }], removed: [] }], NOW);
  assert.deepEqual(b.changes, [{ transactionId: t.transaction_id, change: 'modified', state: 'posted' }]);
  assert.equal(b.projection.find((r) => r.transactionId === t.transaction_id)!.amountMinor, 215_000);
  const c = applySync(b.projection, [{ added: [], modified: [], removed: [{ transaction_id: t.transaction_id }] }], NOW);
  assert.equal(countedRows(c.projection).some((r) => r.transactionId === t.transaction_id), false);
  assert.equal(c.projection.length, 9);
});

test('Plaid sign: + = money out; activity shows out as negative; PayPal counterparty → candidate only, category ignored', () => {
  const a = applySync([], [page('sync-demo')], NOW);
  const rent = a.projection.find((r) => r.description === 'OFFICE RENT OCT')!;
  assert.equal(rent.amountMinor, 210_000);
  const cands = a.projection.filter((r) => r.paypalCandidate).map((r) => r.description).sort();
  assert.deepEqual(cands, ['PAYPAL INST XFER ADD FUNDS', 'PAYPAL TRANSFER WITHDRAWAL']);
  const src = bankSource({ item: item(), obs: demoObs(), txns: { projection: a.projection, syncedAt: NOW, updateStatus: 'HISTORICAL_UPDATE_COMPLETE' }, checksStopped: null, today: '2026-11-01' }, NOW);
  if (src.state === 'NOT_CONNECTED') throw new Error('connected expected');
  assert.equal(src.activity.rows.find((r) => r.description === 'OFFICE RENT OCT')!.amount!.minor, -210_000);
});

test('case 4 / S2-R18: adding transactions never moves counted', () => {
  const base = { item: item(), obs: demoObs(), checksStopped: null, today: '2026-11-01' };
  const empty = bankSource({ ...base, txns: { projection: [], syncedAt: NOW, updateStatus: 'HISTORICAL_UPDATE_COMPLETE' } }, NOW);
  const full = bankSource({ ...base, txns: { projection: applySync([], [page('sync-demo')], NOW).projection, syncedAt: NOW, updateStatus: 'HISTORICAL_UPDATE_COMPLETE' } }, NOW);
  assert.ok(empty.state !== 'NOT_CONNECTED' && full.state !== 'NOT_CONNECTED');
  assert.deepEqual([empty.counted, full.counted], [{ currency: 'USD', minor: 813_000 }, { currency: 'USD', minor: 813_000 }]);
});

test('health (F1–F3): login required, revoked, mutation, rate limit, transient', () => {
  assert.equal(classifyError(400, fixture('error-item-login-required').body).kind, 'LOGIN_REQUIRED');
  assert.equal(classifyError(400, fixture('error-invalid-access-token').body).kind, 'REVOKED');
  assert.equal(classifyError(400, fixture('error-item-not-found').body).kind, 'REVOKED');
  assert.equal(classifyError(400, { error_code: 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION' }).kind, 'MUTATION');
  assert.equal(classifyError(400, { error_code: 'TRANSACTIONS_SYNC_LIMIT' }).kind, 'RATE_LIMIT');
  assert.equal(classifyError(429, {}).kind, 'RATE_LIMIT');
  assert.equal(classifyError(null, undefined).kind, 'TRANSIENT');
  assert.equal(classifyError(500, {}).kind, 'TRANSIENT');
  assert.deepEqual(transitions.BankConnection.DISCONNECTING, ['DISCONNECTED'], 'nothing resurrects a removal');
});

test('freshness: ≤15 min RECENT, ≤3 h AGING, >3 h STALE, failed → FAILED, none → NEVER', () => {
  assert.equal(freshnessOf('2026-11-01T13:45:00.000Z', false, NOW), 'RECENT');
  assert.equal(freshnessOf('2026-11-01T13:44:59.000Z', false, NOW), 'AGING');
  assert.equal(freshnessOf('2026-11-01T10:59:59.000Z', false, NOW), 'STALE');
  assert.equal(freshnessOf('2026-11-01T13:59:00.000Z', true, NOW), 'FAILED');
  assert.equal(freshnessOf(null, false, NOW), 'NEVER');
});

test('S2-PR-04 contribution: DISCONNECTING / REVOKED / DISCONNECTED keep figures as history and never contribute', () => {
  for (const state of ['DISCONNECTING', 'REVOKED', 'DISCONNECTED'] as const) {
    const s = bankSource({ item: item({ state }), obs: demoObs(), checksStopped: null, today: '2026-11-01' }, NOW);
    assert.ok(s.state !== 'NOT_CONNECTED');
    assert.equal(s.contributes, false, state);
    assert.ok(s.notCountedReason, state);
    assert.equal(s.counted?.minor, 813_000, 'shown as history');
  }
  const syncingNoObs = bankSource({ item: item({ state: 'SYNCING' }), checksStopped: null, today: '2026-11-01' }, NOW);
  assert.ok(syncingNoObs.state !== 'NOT_CONNECTED' && syncingNoObs.contributes === false, 'SYNCING contributes only once it has an observation');
  const rr = bankSource({ item: item({ state: 'RECONNECT_REQUIRED' }), obs: demoObs('2026-11-01T09:00:00.000Z'), checksStopped: null, today: '2026-11-01' }, NOW);
  assert.ok(rr.state !== 'NOT_CONNECTED' && rr.contributes && rr.freshness === 'STALE', 'last reading with its read time and state');
});

test('S2-PR-05 validUntil = earliest future boundary; null when nothing time-derived remains', () => {
  const r = '2026-11-01T13:50:00.000Z';
  assert.equal(validUntil([...bankBoundaries(r), '2026-11-01T16:00:00.000Z', '2026-12-31T23:59:59.000Z'], NOW), '2026-11-01T14:05:00.001Z');
  assert.equal(validUntil([...bankBoundaries('2026-11-01T13:40:00.000Z')], NOW), '2026-11-01T16:40:00.001Z');
  assert.equal(validUntil(['2026-11-01T10:00:00.000Z', null], NOW), null);
});

test('S2-A2 fingerprint: different ids, same content → same hash; offsets from the reset date, not absolute dates', () => {
  const rows = applySync([], [page('sync-demo')], NOW).projection;
  const a = bankFingerprint(demoObs(), rows, '2026-10-31');
  const ren = (s: string) => `${s}-other`;
  const obs2 = demoObs();
  obs2.accounts = obs2.accounts.map((x) => ({ ...x, accountId: ren(x.accountId) }));
  const rows2 = rows.map((r) => ({ ...r, transactionId: ren(r.transactionId), accountId: ren(r.accountId), pendingTransactionId: r.pendingTransactionId && ren(r.pendingTransactionId) }));
  assert.equal(bankFingerprint(obs2, rows2, '2026-10-31'), a);
  const shifted = rows.map((r) => ({ ...r, date: new Date(Date.parse(`${r.date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10) }));
  assert.equal(bankFingerprint(demoObs(), shifted, '2026-11-01'), a, 'a reset one day later gives the same fingerprint');
  assert.notEqual(bankFingerprint(demoObs(), rows.slice(1), '2026-10-31'), a);
});

function item(o: Partial<Parameters<typeof bankSource>[0]['item'] & object> = {}) {
  return { itemId: 'item-1', tenantId: 't', runId: 'r', state: 'HEALTHY' as const, version: 1, generation: 1, institution: { id: 'ins_109508', name: 'First Platypus Bank' }, basis: 'SEEDED' as const, effectKey: 'bankseed#r', connectedAt: NOW, institutionDataAsOf: null, consentExpiresAt: null, itemError: null, ...o };
}
