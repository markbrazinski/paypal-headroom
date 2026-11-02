// S7b layer 3 (S07 §6.18 R1/R2): the merchant lease and the reset machine on the fake PayPal (REPLAY-style; never a real payment).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.ts';
import { K } from '../../backend/src/adapters/store/keys.ts';
import { requestStart, OPENING_MINOR } from '../../backend/src/domain/demo/reset.ts';
import { leaseOf } from '../../backend/src/domain/demo/lease.ts';

const MON_10AM = '2026-11-09T15:00:00.000Z';
const amt = (minor: number) => ({ currency_code: 'USD', value: (minor / 100).toFixed(2) });
type H = Awaited<ReturnType<typeof harness>>;

/** A merchant whose report reconciles (one baseline row at the snapshot's balance). */
async function merchant(availableMinor: number) {
  const h = await harness({ plaid: true, hero: true, paypalMinor: availableMinor, start: MON_10AM });
  h.pp.rows = [{ transaction_id: 'BASELINE-1', transaction_event_code: 'T0000', transaction_status: 'S', transaction_initiation_date: '2026-11-08T12:00:00Z', transaction_amount: amt(availableMinor), available_balance: amt(availableMinor) }];
  await h.drain();
  return h;
}
const resetOf = async (h: H, key: string) => h.store.get('provider', K.conn(h.deps.config.connectionId), `RESET#${key}`);
async function settle(h: H, key: string, rounds = 12) {
  for (let i = 0; i < rounds; i++) { await h.drain(); const r = await resetOf(h, key); if (r && ['DONE', 'BLOCKED'].includes(r.state)) return r; await h.advance(60_000); }
  return resetOf(h, key);
}

test('S7-R23…/R1 rail $5,000 → housekeeping payout(s) to the receiver → lands within $1 of $1,800 → fresh hero run bound to the lease', async () => {
  const h = await merchant(500_000);
  const s = await requestStart(h.deps, { tenantId: 'tenant-a', holderSub: 'owner-a', reason: 'judge start' });
  assert.ok(s.ok, JSON.stringify(s));
  const r = await settle(h, (s as { resetKey: string }).resetKey);
  assert.equal(r!.state, 'DONE', JSON.stringify({ state: r!.state, blocker: r!.blocker, waiting: r!.waiting, timeline: r!.timeline }));
  assert.ok(r!.hk.length >= 1 && r!.hk.every((x: any) => x.state === 'PAID'));
  assert.ok(Math.abs(r!.landingMinor - OPENING_MINOR) <= 100, `landing ${r!.landingMinor}`);
  const payouts = [...h.pp.payouts.values()];
  assert.ok(payouts.every((p) => p.body.items[0].receiver === 'keller-pay@supplier.example.com'), 'only the registered sandbox receiver');
  const l = await leaseOf(h.store, h.deps.config.connectionId);
  assert.deepEqual([l!.leased, l!.tenantId, l!.runId], [true, 'tenant-a', r!.runId]);
  const fence = await h.store.get('core', K.tenant('tenant-a'), 'RUN_FENCE');
  assert.equal(fence!.runId, r!.runId, 'the new run is the active one');
  const resv = (await h.store.query('provider', K.conn(h.deps.config.connectionId), { skPrefix: 'RESV#hk:' }));
  assert.equal(resv.length, r!.hk.length, 'each housekeeping debit is in the merchant ledger once');
});

test('S7-R10 a rail below the opening → BLOCKED RAIL_BELOW_OPENING with the figure; nothing paid or faked', async () => {
  const h = await merchant(150_000);
  const s = await requestStart(h.deps, { tenantId: 'tenant-a', holderSub: 'owner-a', reason: 'judge start' });
  const r = await settle(h, (s as { resetKey: string }).resetKey);
  assert.deepEqual([r!.state, r!.blocker.code], ['BLOCKED', 'RAIL_BELOW_OPENING']);
  assert.equal(h.pp.payouts.size, 0);
});

test('S7-R23 an unconfirmed capture after PayPal’s as-of → WAIT_REPORT: no housekeeping payout until it is confirmed or reported', async () => {
  const h = await merchant(500_000);
  // A capture the snapshot doesn't include yet: upper > lower.
  await h.store.transact([{ op: 'put', table: 'provider', item: { pk: K.conn(h.deps.config.connectionId), sk: 'CAPTURE#CAPX', captureId: 'CAPX', tenantId: 'tenant-a', runId: h.run!.runId, invoiceId: 'x', invoiceNumber: 'HR-x-001', grossMinor: 100_000, feeMinor: 3_539, netMinor: 96_461, capturedAt: '2026-11-09T14:59:00Z', reversalDetected: false, lastStatus: 'PENDING' } }]); // not confirmed COMPLETED (S7-B10: a confirmed one would count at once)
  h.pp.balance = { ...h.pp.balance, asOf: '2026-11-09T12:00:00Z' };
  const s = await requestStart(h.deps, { tenantId: 'tenant-a', holderSub: 'owner-a', reason: 'judge start' });
  for (let i = 0; i < 3; i++) { await h.drain(); await h.advance(60_000); }
  const r = await resetOf(h, (s as { resetKey: string }).resetKey);
  assert.equal(r!.state, 'WAIT_REPORT');
  assert.match(r!.waiting, /PayPal's report/);
  assert.equal(h.pp.payouts.size, 0);
});

test('S7-R1/R17 lease conflict: another holder → MERCHANT_LEASED with the expiry; same holder may start again once done', async () => {
  const h = await merchant(180_000);
  const s = await requestStart(h.deps, { tenantId: 'tenant-a', holderSub: 'judge-1', reason: 'judge start' });
  assert.ok(s.ok);
  await settle(h, (s as { resetKey: string }).resetKey);
  const other = await requestStart(h.deps, { tenantId: 'tenant-b', holderSub: 'judge-2', reason: 'judge start' });
  assert.equal((other as { code: string }).code, 'MERCHANT_LEASED');
  assert.ok((other as { until?: string }).until);
  const [x, y] = await Promise.all([requestStart(h.deps, { tenantId: 'tenant-b', holderSub: 'judge-2', reason: 'race' }), requestStart(h.deps, { tenantId: 'tenant-b', holderSub: 'judge-3', reason: 'race' })]);
  assert.ok(!x.ok && !y.ok, 'a live lease refuses both');
});

test('S7-R16 after the lease moves, the old run’s PayPal claim is refused (nothing sent); S7-R12 unresolved work blocks the next Start', async () => {
  const h = await merchant(180_000);
  const s = await requestStart(h.deps, { tenantId: 'tenant-a', holderSub: 'judge-1', reason: 'start' });
  const r = await settle(h, (s as { resetKey: string }).resetKey);
  assert.equal(r!.state, 'DONE');
  const runA = r!.runId;
  // The lease expires; an invoice of run A is still being issued → judge-2 can't take it yet.
  const conn = h.deps.config.connectionId;
  const l = await leaseOf(h.store, conn);
  await h.store.transact([{ op: 'update', table: 'provider', pk: K.conn(conn), sk: 'TENANT', set: { leasedAt: '2026-11-01T00:00:00Z', lastActiveAt: '2026-11-01T00:00:00Z' }, cond: { eq: { version: l!.version } } }]);
  const inv = (await h.store.query('core', K.run('tenant-a', runA), { skPrefix: 'INV#' }))[0];
  await h.store.transact([{ op: 'update', table: 'core', pk: inv.pk, sk: inv.sk, set: { state: 'ISSUING' } }]);
  const blocked = await requestStart(h.deps, { tenantId: 'tenant-b', holderSub: 'judge-2', reason: 'start' });
  assert.equal((blocked as { code: string }).code, 'PREVIOUS_RUN_UNRESOLVED');
  await h.store.transact([{ op: 'update', table: 'core', pk: inv.pk, sk: inv.sk, set: { state: 'ISSUED' } }]);
  const s2 = await requestStart(h.deps, { tenantId: 'tenant-b', holderSub: 'judge-2', reason: 'start' });
  assert.ok(s2.ok, JSON.stringify(s2));
  // Run A's next PayPal write fails at its claim (the lease condition), so it is never sent.
  const { leaseClaimOps } = await import('../../backend/src/domain/demo/lease.ts');
  const ops = await leaseClaimOps(h.store, conn, 'tenant-a', runA, h.clock());
  await assert.rejects(h.store.transact(ops), 'claim under a moved lease is refused');
  assert.equal((await h.store.get('core', K.tenant('tenant-a'), 'CONN#paypal'))!.connectionId, null, 'tenant-a no longer causes PayPal calls');
});

test('S7-R12 unresolved: an unverified payer attempt blocks the hand-off; a reminder waiting only on email does not', async () => {
  const h = await merchant(180_000);
  const { unresolvedOf } = await import('../../backend/src/domain/demo/lease.ts');
  const pk = K.run('tenant-x', 'run-x');
  await h.store.transact([
    { op: 'put', table: 'core', item: { pk, sk: 'PAYER#act-1#a1', phase: 'SUBMITTED_UNVERIFIED' } },
    { op: 'put', table: 'core', item: { pk, sk: 'ACT#act-2', actionId: 'act-2', kind: 'COLLECT_OVERDUE', state: 'QUEUED', counterparty: { name: 'Pellow' } } },
    { op: 'put', table: 'core', item: { pk, sk: 'OUTMSG#COLLECT:inv-2#1', actionId: 'act-2', state: 'QUEUED' } },
    { op: 'put', table: 'core', item: { pk, sk: 'ACT#act-3', actionId: 'act-3', kind: 'DISCOUNT_FALLBACK', state: 'QUEUED', counterparty: { name: 'Mercer' } } },
  ]);
  assert.deepEqual(await unresolvedOf(h.store, 'tenant-x', 'run-x'), ['Mercer: queued', 'payer attempt act-1#a1 submitted unverified']);
});

test('S7b review P2-2/P2-4: Start seals the old run at once; End/release during an unfinished reset is refused; a direct operator reset can’t bypass the lease (P2-3)', async () => {
  const h = await merchant(500_000);
  await h.store.transact([{ op: 'put', table: 'provider', item: { pk: K.conn(h.deps.config.connectionId), sk: 'CAPTURE#CAPX', captureId: 'CAPX', tenantId: 'tenant-a', runId: h.run!.runId, invoiceId: 'x', invoiceNumber: 'HR-x-001', grossMinor: 100_000, feeMinor: 3_539, netMinor: 96_461, capturedAt: '2026-11-09T14:59:00Z', reversalDetected: false, lastStatus: 'PENDING' } }]); // not confirmed COMPLETED (S7-B10: a confirmed one would count at once)
  h.pp.balance = { ...h.pp.balance, asOf: '2026-11-09T12:00:00Z' };
  const s = await requestStart(h.deps, { tenantId: 'tenant-a', holderSub: 'owner-a', reason: 'judge start' });
  assert.ok(s.ok);
  // P2-4: the old run is readable but every write is refused at once.
  assert.equal((await h.api('GET', '/v1/overview')).status, 200);
  const w = await h.api('POST', '/v1/cash/paypal/refresh', {});
  assert.deepEqual([w.status, w.body.code], [409, 'RUN_SEALED']);
  assert.match(w.body.message, /fresh run is being prepared/);
  for (let i = 0; i < 2; i++) { await h.drain(); await h.advance(60_000); }
  assert.equal((await resetOf(h, (s as { resetKey: string }).resetKey))!.state, 'WAIT_REPORT');
  // P2-2: neither the holder nor the operator can release under a moving reset.
  const end = await h.demo('POST', '/v1/demo/end', {});
  assert.deepEqual([end.status, end.body.code], [409, 'RESET_IN_PROGRESS']);
  const rel = await h.demo('POST', '/v1/operator/release', {}, 'OPERATOR');
  assert.deepEqual([rel.status, rel.body.code], [409, 'RESET_IN_PROGRESS']);
  // P2-3: a direct operator reset is refused while a Start is in progress, and for a tenant that doesn't hold the merchant.
  const { operatorReset } = await import('../../backend/src/handlers/operator.ts');
  await assert.rejects(operatorReset(h.deps, 'tenant-a', 'cli'), /RESET_IN_PROGRESS|in progress/);
  await assert.rejects(operatorReset(h.deps, 'tenant-b', 'cli'), /in progress|held by/);
});

test('S7b review P2-3: after a Start finished, a direct operator reset of the holder re-binds the lease to the new run (its PayPal claims work)', async () => {
  const h = await merchant(180_000);
  const s = await requestStart(h.deps, { tenantId: 'tenant-a', holderSub: 'owner-a', reason: 'judge start' });
  assert.equal((await settle(h, (s as { resetKey: string }).resetKey))!.state, 'DONE');
  const { operatorReset } = await import('../../backend/src/handlers/operator.ts');
  const r = await operatorReset(h.deps, 'tenant-a', 'cli reset');
  const l = await leaseOf(h.store, h.deps.config.connectionId);
  assert.equal(l!.runId, r!.runId, 'the lease names the new run');
  await assert.rejects(operatorReset(h.deps, 'tenant-b', 'cli'), /held by tenant-a/);
});

test('S7b: the operator can stop a reset stuck waiting on PayPal (never with housekeeping money in flight); the tenant can be reset again', async () => {
  const h = await merchant(500_000);
  await h.store.transact([{ op: 'put', table: 'provider', item: { pk: K.conn(h.deps.config.connectionId), sk: 'CAPTURE#CAPX', captureId: 'CAPX', tenantId: 'tenant-a', runId: h.run!.runId, invoiceId: 'x', invoiceNumber: 'HR-x-001', grossMinor: 100_000, feeMinor: 3_539, netMinor: 96_461, capturedAt: '2026-11-09T14:59:00Z', reversalDetected: false, lastStatus: 'PENDING' } }]); // not confirmed COMPLETED (S7-B10: a confirmed one would count at once)
  h.pp.balance = { ...h.pp.balance, asOf: '2026-11-09T12:00:00Z' };
  const s = await requestStart(h.deps, { tenantId: 'tenant-a', holderSub: 'owner-a', reason: 'judge start' });
  for (let i = 0; i < 2; i++) { await h.drain(); await h.advance(60_000); }
  const { abandonReset } = await import('../../backend/src/domain/demo/reset.ts');
  assert.equal((await abandonReset(h.deps, 'pending row')).ok, true);
  assert.equal((await resetOf(h, (s as { resetKey: string }).resetKey))!.state, 'BLOCKED');
  const { operatorReset } = await import('../../backend/src/handlers/operator.ts');
  const r = await operatorReset(h.deps, 'tenant-a', 'cli after abandon');
  assert.equal((await leaseOf(h.store, h.deps.config.connectionId))!.runId, r!.runId);
});

test('S7-B10 a capture PayPal confirmed but hasn’t released yet → WAIT_REPORT with the reason; no housekeeping payout (PayPal would refuse it)', async () => {
  const h = await merchant(500_000);
  await h.store.transact([{ op: 'put', table: 'provider', item: { pk: K.conn(h.deps.config.connectionId), sk: 'CAPTURE#CAPY', captureId: 'CAPY', tenantId: 'tenant-a', runId: h.run!.runId, invoiceId: 'y', invoiceNumber: 'HR-y-001', grossMinor: 100_000, feeMinor: 3_539, netMinor: 96_461, capturedAt: '2026-11-09T14:59:00Z', reversalDetected: false, lastStatus: 'COMPLETED' } }]);
  h.pp.balance = { ...h.pp.balance, asOf: '2026-11-09T12:00:00Z' };
  const s = await requestStart(h.deps, { tenantId: 'tenant-a', holderSub: 'owner-a', reason: 'judge start' });
  for (let i = 0; i < 3; i++) { await h.drain(); await h.advance(60_000); }
  const r = await resetOf(h, (s as { resetKey: string }).resetKey);
  assert.equal(r!.state, 'WAIT_REPORT');
  assert.match(r!.waiting, /release/);
  assert.equal(h.pp.payouts.size, 0);
});
