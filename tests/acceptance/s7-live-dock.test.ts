// Judge dock (owner, 4 Nov 2026): the shared live run. Fresh → a judge takes it without a reset; another judge is refused; idle 10 min
// after use → it resets by itself and the dock shows an estimate; a fresh idle run is never reset. Fake PayPal (never a real payment).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.ts';
import { K } from '../../backend/src/adapters/store/keys.ts';
import { bootstrapTenant } from '../../backend/src/domain/identity-run/run.ts';
import { autoReset, LIVE_TENANT } from '../../backend/src/domain/demo/live.ts';
import { AUTO_HOLDER, leaseOf } from '../../backend/src/domain/demo/lease.ts';
import { requestStart } from '../../backend/src/domain/demo/reset.ts';

const J1 = { sub: 'judge-1', email: 'judge1@example.com' }, J2 = { sub: 'judge-2', email: 'judge2@example.com' };
const amt = (minor: number) => ({ currency_code: 'USD', value: (minor / 100).toFixed(2) });

async function live() {
  const h = await harness({ plaid: true, hero: true, paypalMinor: 180_000, start: '2026-11-09T15:00:00.000Z' });
  h.pp.rows = [{ transaction_id: 'BASELINE-1', transaction_event_code: 'T0000', transaction_status: 'S', transaction_initiation_date: '2026-11-08T12:00:00Z', transaction_amount: amt(180_000), available_balance: amt(180_000) }];
  for (const j of [J1, J2]) await bootstrapTenant(h.store, { ...j, tenantId: LIVE_TENANT, connectionId: null });
  assert.equal(await autoReset(h.deps), 'no lease on this stage', 'dev (no lease): nothing happens');
  await h.drain();
  const first = await requestStart(h.deps, { tenantId: LIVE_TENANT, holderSub: AUTO_HOLDER, reason: 'review bootstrap' }); // review's first lease
  assert.ok(first.ok, JSON.stringify(first));
  for (let i = 0; i < 12; i++) { await h.drain(); if ((await autoReset(h.deps)) === 'ready') break; await h.advance(60_000); }
  return h;
}
const status = async (h: Awaited<ReturnType<typeof live>>, j: typeof J1) => (await h.demo('GET', '/v1/demo/run', undefined, 'JUDGE', j)).body.live;

test('LIVE-1 fresh run: judge 1 takes it with no reset; judge 2 sees it in use and can’t drive it; owners can’t take it', async () => {
  const h = await live();
  assert.equal((await status(h, J1)).state, 'READY');
  const resets = (await h.store.query('provider', K.conn(h.deps.config.connectionId), { skPrefix: 'RESET#' })).length;
  assert.equal((await h.demo('POST', '/v1/demo/live', {}, 'JUDGE', J1)).status, 200);
  assert.equal((await h.store.query('provider', K.conn(h.deps.config.connectionId), { skPrefix: 'RESET#' })).length, resets, 'taking a fresh run starts no reset');
  assert.equal((await status(h, J1)).state, 'MINE');
  assert.equal((await status(h, J2)).state, 'IN_USE');
  const r2 = await h.demo('POST', '/v1/demo/live', {}, 'JUDGE', J2);
  assert.deepEqual([r2.status, r2.body.code], [409, 'MERCHANT_LEASED']);
  assert.equal((await h.demo('POST', '/v1/demo/bill', {}, 'JUDGE', J2)).body.code, 'MERCHANT_LEASED', 'only the holder drives the shared run');
  assert.equal((await h.demo('POST', '/v1/demo/live', {}, 'OPERATOR', J2)).status, 403);
});

test('LIVE-2 used, then idle 10 min → resets by itself; the dock shows RESETTING with an estimate; the holder’s poll keeps it alive', async () => {
  const h = await live();
  await h.demo('POST', '/v1/demo/live', {}, 'JUDGE', J1);
  assert.equal((await h.demo('POST', '/v1/demo/bill', {}, 'JUDGE', J1)).status, 202);
  for (let i = 0; i < 3; i++) { await h.advance(4 * 60_000); await status(h, J1); } // 12 min with the dock open
  assert.equal(await autoReset(h.deps), 'in use', 'the open dock is a sign of life');
  await h.advance(11 * 60_000); // dock closed
  assert.match(await autoReset(h.deps), /^reset started/);
  const s = await status(h, J2);
  assert.equal(s.state, 'RESETTING');
  assert.ok(Date.parse(s.readyAt) >= Date.parse(h.clock()) + 15 * 60_000, 'an estimate in the future');
  assert.equal((await h.demo('POST', '/v1/demo/live', {}, 'JUDGE', J2)).body.code, 'RESET_IN_PROGRESS');
});

test('LIVE-3 a fresh run left idle is not reset; the next judge takes it', async () => {
  const h = await live();
  await h.demo('POST', '/v1/demo/live', {}, 'JUDGE', J1);
  await h.advance(11 * 60_000);
  assert.equal(await autoReset(h.deps), 'ready');
  assert.equal((await h.demo('POST', '/v1/demo/live', {}, 'JUDGE', J2)).status, 200);
  assert.equal((await leaseOf(h.store, h.deps.config.connectionId))!.holderSub, 'judge-2');
});

test('LIVE-4 the operator holding the merchant for another business: the dock says so and the timer never takes it; takeOver does', async () => {
  const h = await live();
  await h.advance(11 * 60_000); // the fresh live run sits idle; the operator starts the showcase
  const op = await requestStart(h.deps, { tenantId: h.tenantId, holderSub: 'operator', reason: 'showcase' });
  assert.ok(op.ok, JSON.stringify(op));
  for (let i = 0; i < 12; i++) { await h.drain(); await h.advance(60_000); }
  await h.advance(11 * 60_000);
  const s = await status(h, J1);
  assert.deepEqual([s.state, /operator is using/.test(s.text)], ['BLOCKED', true]);
  assert.equal(await autoReset(h.deps), `held for ${h.tenantId}`);
  assert.match(await autoReset(h.deps, { takeOver: true }), /^reset started/);
});

test('LIVE-5 a reset blocked with nothing in flight at PayPal retries by itself after 30 min; one the operator stopped waits for them', async () => {
  const h = await live();
  const conn = h.deps.config.connectionId;
  await h.demo('POST', '/v1/demo/live', {}, 'JUDGE', J1);
  await h.demo('POST', '/v1/demo/bill', {}, 'JUDGE', J1);
  await h.advance(11 * 60_000);
  assert.match(await autoReset(h.deps), /^reset started/);
  // What dev hit on 3 Nov: PayPal refused the housekeeping payout (money not yet released); nothing was sent.
  const block = async (code: string) => { const l = (await leaseOf(h.store, conn))!; await h.store.transact([{ op: 'update', table: 'provider', pk: K.conn(conn), sk: l.resetSk!, set: { state: 'BLOCKED', blocker: { code, text: 'PayPal refused housekeeping payout 1: INSUFFICIENT_FUNDS; nothing was sent' }, updatedAt: h.clock() } }]); };
  await block('HOUSEKEEPING_REFUSED');
  const s = await status(h, J2);
  assert.deepEqual([s.state, /tries again by itself/.test(s.text)], ['RESETTING', true], 'judges see a retry coming, not "needs the operator"');
  assert.ok(Date.parse(s.readyAt) >= Date.parse(h.clock()) + 30 * 60_000);
  assert.match(await autoReset(h.deps), /^blocked: HOUSEKEEPING_REFUSED; retry at /);
  await h.advance(31 * 60_000);
  assert.match(await autoReset(h.deps), /^retry started/);
  await block('ABANDONED');
  await h.advance(31 * 60_000);
  assert.equal(await autoReset(h.deps), 'blocked: ABANDONED', 'an operator stop is never retried');
  assert.equal((await status(h, J2)).state, 'BLOCKED');
});
