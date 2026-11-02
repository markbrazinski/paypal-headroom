// S6 acceptance (S06 §6.11 layer 3, §7/§7a): real S1–S5 upstream (reset → bill → accept → plan → approve → captures) with the
// REPLAY fake PayPal (payouts, item status scripts, report rows in the observed −D/−D/+D shape). Never evidence of a payment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approved, FEES, items, pay, pk, report, type H } from './s5-helpers.ts';
import { KELLER_RECEIVER } from './harness.ts';
import { K } from '../../backend/src/adapters/store/keys.ts';
import { effects, FRI_0900, heroPaid, keller, occKey, payout, resv } from './s6-helpers.ts';

test('S6-A2/A3 hero: both captures in PayPal\'s report → rail and company PASS at Fri 09:00 → one intent, one POST → item SUCCESS → PAID at the actual fee; Keller leaves the forecast; Cash drops once', async () => {
  const { h } = await approved();
  assert.equal((await keller(h)).state, 'SCHEDULED');
  const before = await payout(h);
  // Before collections: PayPal $1,800 can't fund $10,000 + up to $200 → rail FAIL short $8,400 (S6-D4), with bank cash never counted (AT-F03).
  assert.equal(before.pill, 'HELD');
  assert.deepEqual([before.readiness.rail.verdict, before.readiness.rail.short.minor], ['FAIL', 840_000]);
  assert.match(before.pillText, /money in your bank can't fund PayPal payouts/);
  assert.ok(before.readiness.checks.every((c: any) => c.ok), 'authority is complete: only funds hold it');
  await heroPaid(h);
  const posts = h.pp.count('POST payout');
  assert.equal(posts, 1, h.pp.calls.filter((c) => c.includes('payout')).join('\n'));
  const [e] = await effects(h);
  assert.equal(e.state, 'PAID', JSON.stringify(e.timeline));
  assert.equal(e.fee.minor, 2_000);
  assert.ok(e.senderBatchId.length <= 30);
  assert.equal(JSON.parse(e.requestBytes).items[0].receiver, KELLER_RECEIVER);
  assert.equal((await keller(h)).state, 'COMPLETED');
  const obl = (await items(h, 'OBL#')).find((x) => x.payment)!;
  assert.deepEqual([obl.state, obl.payment.stage], ['PAID', 'PAID']);
  const [r] = await resv(h);
  assert.deepEqual([r.state, r.debitMinor, r.inFlight], ['SETTLED', 1_002_000, false]);
  const v = await payout(h);
  assert.equal(v.pill, 'PAID');
  assert.equal(v.effect.itemId, e.itemId);
  // Cash: PayPal lower = report (1,608,250) − (face + actual fee) until PayPal's report includes the payout.
  const cash = (await h.api('GET', '/v1/cash/position')).body;
  assert.equal(cash.sources[0].estimate.lower.minor, 1_608_250 - 1_002_000);
  // Forecast: the PAID obligation is out of the dated items (its debit is in the opening, once).
  const f = (await h.api('GET', '/v1/cash/forecast')).body;
  assert.ok(!JSON.stringify(f.days ?? []).includes(await occKey(h)), 'Keller is not a dated outflow any more');
  // PayPal's report later shows T1503 / T0001 / T1105 for the payout: the residual goes to 0 and the figure is the report's.
  h.pp.reportPayout(e.batchId, { at: '2026-11-13T14:05:00+0000' });
  h.setNow('2026-11-13T16:10:00.000Z');
  h.pp.balance = { ...h.pp.balance, asOf: '2026-11-13T16:00:00.000Z' };
  await h.api('POST', '/v1/cash/paypal/refresh');
  await h.drain();
  const cash2 = (await h.api('GET', '/v1/cash/position')).body;
  assert.equal(cash2.sources[0].estimate.lower.minor, 1_608_250 - 1_002_000, 'counted exactly once after the report');
  assert.equal((await payout(h)).effect.inReport, true);
  const pl = (await h.api('GET', '/v1/payables')).body.obligations.find((o: any) => o.payout);
  assert.equal(pl.payout.pill, 'PAID');
});

const pause = async (h: H, on: boolean) => {
  const pol = await h.store.get('core', pk(h), 'POLICY');
  const r = await h.api('POST', '/v1/delegation/pauses', { kind: 'PAYMENTS', on }, { 'if-match': String(pol!.version) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
};
const day = async (h: H) => (await h.store.get('work', 'SPENDDAY#pp-test#2026-11-13', 'DAY'))?.sumMinor ?? 0;

test('S6-R7 both captured, confirmed by PayPal but not yet released to the balance → HELD_EVIDENCE, nothing reserved or sent (live 3 Nov: PayPal refuses INSUFFICIENT_FUNDS); the report arrives → the recheck pays', async () => {
  const { h } = await approved();
  const caps = await heroPaid(h, { reported: false });
  assert.equal(h.pp.count('POST payout'), 0);
  assert.equal((await resv(h)).length, 0);
  const a = await keller(h);
  assert.deepEqual([a.state, a.holdCode], ['HELD_EVIDENCE', 'WAITING_FOR_REPORT']);
  assert.equal((await payout(h)).pill, 'WAITING_FOR_REPORT');
  report(h, caps);
  await h.advance(15 * 60_000); // the recheck
  await h.advance(20_000);
  for (let i = 0; i < 4; i++) await h.advance(30_000);
  assert.equal(h.pp.count('POST payout'), 1);
  assert.equal((await effects(h))[0].state, 'PAID');
});

test('S6-R8/R6 Pellow only (PayPal $1,800 replayed): rail FAIL short $1,065.73 at the ceiling; bank cash never funds it; nothing reserved', async () => {
  const { h } = await approved();
  await heroPaid(h, { only: 'pellow' });
  assert.equal(h.pp.count('POST payout'), 0);
  const v = await payout(h);
  assert.deepEqual([v.readiness.rail.verdict, v.readiness.rail.lower.minor, v.readiness.rail.short.minor], ['FAIL', 913_427, 106_573]);
  assert.equal(v.readiness.company.verdict, 'FAIL');
  assert.deepEqual([(await keller(h)).state, (await keller(h)).holdCode], ['HELD', 'RAIL_SHORT']);
  assert.equal((await resv(h)).length, 0);
  assert.equal(await day(h), 0);
});

test('S6-A4/R9/R36 payee: no payout grant while unconfirmed; a near-miss address is refused and audited by hash; a stale version is refused; the exact address confirms; then the payout is approvable', async () => {
  const { h, rev } = await approved({ payee: 'unconfirmed' });
  const g = await items(h, 'GRANT#');
  assert.ok(!g.some((x) => x.kind.startsWith('PAYOUT')), 'no payout grant without a confirmed address');
  const sup = (await keller(h)).counterparty.id;
  const miss = await h.api('POST', `/v1/payables/payees/${sup}/confirm`, { version: 1, address: 'keller-pay@supplier.example.co' });
  assert.deepEqual([miss.status, miss.body.matched, miss.body.state], [200, false, 'UNCONFIRMED']);
  assert.equal((await h.api('POST', `/v1/payables/payees/${sup}/confirm`, { version: 2, address: KELLER_RECEIVER })).body.code, 'CONSENT_CHANGED');
  const reveal = await h.api('GET', `/v1/payables/payees/${sup}/reveal`);
  assert.equal(reveal.body.address, KELLER_RECEIVER);
  const ok = await h.api('POST', `/v1/payables/payees/${sup}/confirm`, { version: 1, address: '  Keller-Pay@Supplier.Example.com ' });
  assert.deepEqual([ok.body.matched, ok.body.state], [true, 'CONFIRMED']);
  const audit = await h.store.query('audit', pk(h));
  assert.ok(audit.some((x) => x.eventType === 'PayeeConfirmFailed') && audit.some((x) => x.eventType === 'PayeeConfirmed') && audit.some((x) => x.eventType === 'PayeeRevealed'));
  assert.ok(!JSON.stringify(audit).includes(KELLER_RECEIVER), 'no full address in any audit row');
  assert.ok(!JSON.stringify((await h.api('GET', '/v1/payables')).body).includes(KELLER_RECEIVER), 'list views show the mask only');
  // The waiting payout in the running revision is now selectable; approving records both payout grants.
  const r2 = (await h.api('GET', '/v1/plan')).body.revision;
  assert.equal(r2.revisionId, rev.revisionId);
  assert.deepEqual(r2.approval.newPermissions.map((x: any) => x.kind).sort(), ['PAYOUT_AUTHORITY', 'PAYOUT_EXCEPTION']);
});

test('S6-R13 PayPal 422 INSUFFICIENT_FUNDS → REJECTED: reservation, day charge and lock released; grants stay spent; HELD "PayPal refused"; never retried', async () => {
  const { h } = await approved();
  h.pp.faults.add('payout-422');
  await heroPaid(h);
  assert.equal(h.pp.count('POST payout'), 1);
  const [e] = await effects(h);
  assert.equal(e.state, 'REJECTED');
  assert.equal((await resv(h))[0].state, 'RELEASED');
  assert.equal(await day(h), 0);
  const a = await keller(h);
  assert.deepEqual([a.state, a.holdCode], ['HELD', 'PROVIDER_REFUSED']);
  assert.ok((await items(h, 'GRANT#')).filter((x) => x.kind.startsWith('PAYOUT')).every((x) => x.state === 'CONSUMED'));
  assert.equal((await items(h, 'OBL#')).find((x) => x.lastEffectKey)!.payment, null);
  await h.advance(3600_000);
  assert.equal(h.pp.count('POST payout'), 1, 'no automatic retry');
});

test('S6-R2/R14 lost response → UNKNOWN → the same bytes and id are replayed → 400 duplicate + link → that batch is read → PAID; one batch, never a second id', async () => {
  const { h } = await approved();
  h.pp.faults.add('payout-lost-response');
  await heroPaid(h);
  await h.advance(60_000);
  await h.advance(60_000);
  const posts = h.pp.calls.filter((c) => c.startsWith('POST payout'));
  assert.equal(posts.length, 2);
  assert.equal(new Set(posts).size, 1, 'same sender_batch_id');
  assert.equal(h.pp.payouts.size, 1);
  const [e] = await effects(h);
  assert.equal(e.state, 'PAID', JSON.stringify(e.timeline));
  assert.ok(e.timeline.some((t: any) => /Unknown/.test(t.event)));
});

test('S6-R15/R31 replay pending while payments are paused: zero POSTs until resume; then the same id', async () => {
  const { h } = await approved();
  h.pp.faults.add('payout-lost-response');
  await heroPaid(h, { stop: 'afterPost' });
  const [e0] = await effects(h);
  assert.equal(e0.state, 'UNKNOWN');
  await pause(h, true);
  await h.advance(16 * 60_000);
  assert.equal(h.pp.count('POST payout'), 1, 'paused: no replay');
  assert.match((await payout(h)).pillText, /paused/);
  await pause(h, false);
  await h.advance(16 * 60_000);
  for (let i = 0; i < 4; i++) await h.advance(30_000);
  assert.equal(h.pp.count('POST payout'), 2);
  assert.equal((await effects(h))[0].state, 'PAID');
});

test('S6-R3/R34 pause after reserving, before the claim → HELD_READY, reservation kept, zero POSTs; resume → the same attempt is claimed and paid', async () => {
  const { h } = await approved();
  let paused = false;
  h.deps.hooks!.beforePayoutClaim = async () => { if (!paused) { paused = true; await pause(h, true); } };
  await heroPaid(h);
  const [e] = await effects(h);
  assert.equal(e.state, 'HELD_READY');
  assert.equal(h.pp.count('POST payout'), 0);
  assert.equal((await resv(h))[0].state, 'ACTIVE');
  assert.deepEqual([(await keller(h)).state, (await keller(h)).holdCode], ['HELD', 'PAYMENTS_PAUSED']);
  await pause(h, false);
  for (let i = 0; i < 4; i++) await h.advance(30_000);
  const all = await effects(h);
  assert.equal(all.length, 1, 'same attempt');
  assert.equal(all[0].state, 'PAID');
  assert.equal(h.pp.count('POST payout'), 1);
});

test('S6-R34 revoke before the claim → CANCELLED_UNSENT: reservation, day charge and lock released; grant not consumed; zero POSTs', async () => {
  const { h } = await approved();
  h.deps.hooks!.beforePayoutClaim = async () => {
    h.deps.hooks!.beforePayoutClaim = undefined;
    const g = (await items(h, 'GRANT#')).find((x) => x.kind === 'PAYOUT_EXCEPTION')!;
    assert.equal((await h.api('POST', `/v1/grants/${encodeURIComponent(g.grantId)}/revoke`, { reason: 'test' })).status, 200);
  };
  await heroPaid(h);
  assert.equal(h.pp.count('POST payout'), 0);
  const [e] = await effects(h);
  assert.equal(e.state, 'CANCELLED_UNSENT');
  assert.equal((await resv(h))[0].state, 'RELEASED');
  assert.equal(await day(h), 0);
  assert.ok((await items(h, 'GRANT#')).some((x) => x.kind === 'PAYOUT_AUTHORITY' && x.state === 'ACTIVE'), 'never consumed');
  assert.equal((await items(h, 'OBL#')).find((x) => x.lastEffectKey)!.payment, null);
});

test('S6-R4/R17 item UNCLAIMED (batch SUCCESS, transaction_id present) → NOT PAID with recovery text; the obligation stays open; the reservation stays', async () => {
  const { h } = await approved();
  h.pp.payoutScript = ['PENDING', 'UNCLAIMED'];
  await heroPaid(h);
  const [e] = await effects(h);
  assert.deepEqual([e.state, e.itemStatus], ['NOT_PAID', 'UNCLAIMED']);
  assert.ok(e.transactionId, 'a transaction id is not proof');
  const v = await payout(h);
  assert.equal(v.pill, 'NOT_PAID');
  assert.match(v.status, /hasn't claimed it at k•••@•••\.example\.com.*30 days/);
  assert.notEqual((await items(h, 'OBL#')).find((x) => x.lastEffectKey)!.state, 'PAID');
  assert.equal((await resv(h))[0].state, 'ACTIVE');
});

test('S6-R16 the item shows a different amount → HOLD, never PAID', async () => {
  const { h } = await approved();
  h.pp.itemTamper = (b) => { b.payout_item.amount.value = '9999.99'; };
  await heroPaid(h);
  const [e] = await effects(h);
  assert.equal(e.state, 'HOLD');
  assert.notEqual((await keller(h)).state, 'COMPLETED');
});

test('S6-R30 UNKNOWN past the 25-day mutation deadline → UNKNOWN_UNRESOLVED, zero POSTs after it, reservation kept', async () => {
  const { h } = await approved();
  h.pp.faults.add('payout-500');
  await heroPaid(h, { stop: 'afterPost' });
  const [e0] = await effects(h);
  assert.equal(e0.state, 'UNKNOWN');
  const n = h.pp.count('POST payout');
  h.setNow(new Date(Date.parse(e0.mutationDeadline) + 1000).toISOString());
  h.pp.faults.add('payout-401');
  await h.drain();
  await h.advance(20 * 60_000);
  const [e] = await effects(h);
  assert.equal(e.state, 'UNKNOWN_UNRESOLVED');
  assert.equal(h.pp.count('POST payout'), n);
  assert.equal((await resv(h))[0].state, 'ACTIVE');
});

test('S6-R1/AT-F07 two PAY workers at once → one intent, one reservation, one POST', async () => {
  const { h } = await approved();
  const p = await pay(h, 'cust-pellow', 760_000, FEES.pellow);
  const x = await pay(h, 'cust-harrow', 720_000, FEES.harrow);
  h.setNow(FRI_0900);
  report(h, [{ cap: p.cap, gross: 760_000, fee: FEES.pellow, number: p.inv.invoiceNumber }, { cap: x.cap, gross: 720_000, fee: FEES.harrow, number: x.inv.invoiceNumber }]);
  h.pp.payoutFloat = 1_500_000;
  const a = await keller(h);
  const { newJob, putJobOp } = await import('../../backend/src/jobs/lease.ts');
  await h.store.transact([putJobOp(newJob(`due#${a.actionId}#${a.intentVersion}#PAY#9`, 'ACTION_DUE', a.actionId, FRI_0900, 'tenant-a', h.run!.runId))]);
  const { processJob } = await import('../../backend/src/jobs/worker.ts');
  const ids = [`due#${a.actionId}#${a.intentVersion}#PAY#0`, `due#${a.actionId}#${a.intentVersion}#PAY#9`];
  await Promise.all(ids.map((id) => processJob(h.deps, id))); // phase 1 each
  await h.advance(20_000); // bank sync
  h.queue.pending.length = 0;
  await Promise.all(ids.map((id) => processJob(h.deps, id))); // both evaluate and try to queue at once
  for (let i = 0; i < 4; i++) await h.advance(30_000);
  assert.equal((await resv(h)).length, 1);
  assert.equal(h.pp.count('POST payout'), 1);
  assert.equal((await effects(h))[0].state, 'PAID');
});

test('S6-R25/R20 (AT-F06) a $10 payout still unresolved on the same PayPal account (an earlier demo run) → the Mercer check is HELD_EVIDENCE "a PayPal payout is unresolved", never SKIPPED; resolved → it skips', async () => {
  const { check, lagReport, TUE_0805, WED_0900 } = await import('./s5-helpers.ts');
  const { K: Keys } = await import('../../backend/src/adapters/store/keys.ts');
  const { h } = await approved();
  h.setNow(TUE_0805);
  await h.drain();
  h.setNow('2026-11-11T13:30:00.000Z');
  const p = await pay(h, 'cust-pellow', 760_000, FEES.pellow);
  const r = await pay(h, 'cust-harrow', 720_000, FEES.harrow);
  // SETUP (labelled): another run's payout of $10.00 is in flight on this PayPal connection (ample funds otherwise).
  await h.store.transact([{ op: 'put', table: 'provider', item: { pk: Keys.conn('pp-test'), sk: 'RESV#pay:other-run', effectKey: 'pay:other-run', tenantId: 'tenant-a', runId: 'run-older', occurrenceKey: 'occ#x#0', state: 'ACTIVE', faceMinor: 1_000, debitMinor: 1_020, transactionId: null, itemId: null, inFlight: true, version: 1 } }]);
  h.setNow('2026-11-11T15:40:00.000Z');
  report(h, [{ cap: p.cap, gross: 760_000, fee: FEES.pellow, number: p.inv.invoiceNumber }, { cap: r.cap, gross: 720_000, fee: FEES.harrow, number: r.inv.invoiceNumber }]);
  lagReport(h, 5 * 60_000);
  let { a, chk } = await check(h);
  assert.equal(a.state, 'HELD_EVIDENCE');
  assert.ok(chk!.blockers.some((b: any) => b.code === 'PAYOUT_UNRESOLVED'), JSON.stringify(chk!.blockers));
  // Its item resolves (SETTLED, no longer in flight): the next check skips, with its $10.20 counted once in the lower bound.
  await h.store.transact([{ op: 'update', table: 'provider', pk: Keys.conn('pp-test'), sk: 'RESV#pay:other-run', set: { inFlight: false, state: 'SETTLED', debitMinor: 1_010 } }]);
  h.setNow('2026-11-11T16:00:00.000Z');
  lagReport(h, 5 * 60_000);
  ({ a, chk } = await check(h));
  assert.equal(a.state, 'SKIPPED_NOT_NEEDED', JSON.stringify(chk?.blockers));
  assert.equal(chk!.lowerMin.closeMinor, 444_250 - 1_010);
});

const approveRunning = async (h: H) => {
  const rev = (await h.api('GET', '/v1/plan')).body.revision;
  return { rev, res: await h.api('POST', `/v1/plan/revisions/${rev.revisionId}/approve`, { selected: rev.approval.selected, consentHash: rev.approval.consentHash }, { 'if-match': String(rev.version) }) };
};

test('S6-IM-01/Y22/R13 422 → approve again (new payment version, new grants) → the PAY job runs → PAID under a new sender_batch_id', async () => {
  const { h } = await approved();
  h.pp.faults.add('payout-422');
  await heroPaid(h);
  const a1 = await keller(h);
  assert.deepEqual([a1.state, a1.holdCode, a1.terms.paymentVersion], ['HELD', 'PROVIDER_REFUSED', 2]);
  const { rev, res } = await approveRunning(h);
  assert.ok(rev.approval.selected.includes(a1.actionId), JSON.stringify(rev.approval));
  assert.deepEqual(rev.approval.newPermissions.map((g: any) => g.kind).sort(), ['PAYOUT_AUTHORITY', 'PAYOUT_EXCEPTION']);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal((await keller(h)).state, 'SCHEDULED');
  await h.drain();
  await h.advance(20_000);
  for (let i = 0; i < 4; i++) await h.advance(30_000);
  const effs = (await effects(h)).sort((x: any, z: any) => x.paymentVersion - z.paymentVersion);
  assert.deepEqual(effs.map((e: any) => [e.paymentVersion, e.state]), [[1, 'REJECTED'], [2, 'PAID']]);
  assert.notEqual(effs[0].senderBatchId, effs[1].senderBatchId);
  assert.equal(h.pp.count('POST payout'), 2);
});

test('S6-IM-02/R18/R32 refund after PAID → one separate return, bill reopened, the debit stays; the next payment version\'s PayPal check still counts it', async () => {
  const { planCtxFor } = await import('../../backend/src/domain/plan/authority.ts');
  const { fundsInputs } = await import('../../backend/src/read/models.ts');
  const { h } = await approved();
  h.pp.payoutScript = ['PENDING', 'SUCCESS', 'REFUNDED'];
  await heroPaid(h);
  const [e] = await effects(h);
  assert.equal(e.state, 'PAID');
  const cashLower = (await h.api('GET', '/v1/cash/position')).body.sources[0].estimate.lower.minor;
  await h.advance(24 * 3600_000 + 60_000); // the daily watch sees REFUNDED
  await h.advance(24 * 3600_000 + 60_000); // a duplicate observation changes nothing
  const [e2] = await effects(h);
  assert.equal(e2.state, 'REFUNDED');
  const rets = await h.store.query('provider', K.conn('pp-test'), { skPrefix: 'PAYRET#' });
  assert.equal(rets.length, 1);
  const obl = (await items(h, 'OBL#')).find((x) => x.lastEffectKey)!;
  assert.deepEqual([obl.state, obl.payment, obl.nextPaymentVersion], ['REOPENED', null, 2]);
  assert.equal((await h.api('GET', '/v1/cash/position')).body.sources[0].estimate.lower.minor, cashLower, 'the original debit is never altered; the credit waits for the report');
  const rc = (await planCtxFor(h.deps, 'tenant-a', h.run!.runId))!;
  const all = await fundsInputs(rc), v2 = await fundsInputs(rc, { excludeOccurrence: e.occurrenceKey, excludePaymentVersion: 2 });
  assert.equal(v2.paypal.lowerMinor, all.paypal.lowerMinor, 'payment version 2 still sees the first payment\'s unreported debit');
});

test('S6-IM-03 a second PAY job while the first intent is HELD_READY never makes a second intent; resume claims the same attempt', async () => {
  const { h } = await approved();
  let paused = false;
  h.deps.hooks!.beforePayoutClaim = async () => { if (!paused) { paused = true; await pause(h, true); } };
  await heroPaid(h);
  const a = await keller(h);
  const { newJob, putJobOp } = await import('../../backend/src/jobs/lease.ts');
  await h.store.transact([putJobOp(newJob(`due#${a.actionId}#${a.intentVersion}#PAY#9`, 'ACTION_DUE', a.actionId, h.clock(), 'tenant-a', h.run!.runId))]);
  await pause(h, false);
  for (let i = 0; i < 5; i++) await h.advance(30_000);
  const effs = await effects(h);
  assert.equal(effs.length, 1, 'one intent');
  assert.equal(effs[0].state, 'PAID');
  assert.equal((await resv(h)).length, 1);
  assert.equal(h.pp.count('POST payout'), 1);
});

test('S6-R19/R34 reset with a reserved-but-unsent payout → it is cancelled and released (epoch fence), never claimed; nothing sent', async () => {
  const { operatorReset } = await import('../../backend/src/handlers/operator.ts');
  const { h } = await approved();
  let paused = false;
  h.deps.hooks!.beforePayoutClaim = async () => { if (!paused) { paused = true; await pause(h, true); } };
  await heroPaid(h);
  assert.equal((await effects(h))[0].state, 'HELD_READY');
  h.deps.hooks!.beforePayoutClaim = undefined;
  await operatorReset(h.deps, 'tenant-a', 'reset with a held payout', { hero: false });
  await h.drain();
  const [e] = await effects(h);
  assert.equal(e.state, 'CANCELLED_UNSENT');
  assert.equal((await resv(h))[0].state, 'RELEASED');
  assert.equal(h.pp.count('POST payout'), 0);
});
