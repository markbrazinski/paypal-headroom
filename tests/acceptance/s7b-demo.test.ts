// S7b layer 3 (S07 §6.18 R3, R7, R10): the demo lane with verified roles, the read-only showcase, the payer as an executor (FAKE payer
// on the fake PayPal — tests only; receipts still come only from the invoice + capture GETs) and the demo clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness, OWNER_B } from './harness.ts';
import { K } from '../../backend/src/adapters/store/keys.ts';

const MON_10AM = '2026-11-09T15:00:00.000Z';
const amt = (minor: number) => ({ currency_code: 'USD', value: (minor / 100).toFixed(2) });
type H = Awaited<ReturnType<typeof harness>>;

async function judgeWorld(payer: 'fake' | 'fake-async' = 'fake') {
  const h = await harness({ plaid: true, hero: true, paypalMinor: 180_000, start: MON_10AM, mail: { redirectTo: null }, payer });
  h.pp.rows = [{ transaction_id: 'BASELINE-1', transaction_event_code: 'T0000', transaction_status: 'S', transaction_initiation_date: '2026-11-08T12:00:00Z', transaction_amount: amt(180_000), available_balance: amt(180_000) }];
  await h.drain();
  return h;
}
async function started(h: H) {
  const s = await h.demo('POST', '/v1/demo/start', {});
  assert.equal(s.status, 202, JSON.stringify(s.body));
  for (let i = 0; i < 10; i++) { await h.drain(); const r = (await h.demo('GET', '/v1/demo/run')).body; if (r.reset && ['DONE', 'BLOCKED'].includes(r.reset.state)) return r; await h.advance(60_000); }
  return (await h.demo('GET', '/v1/demo/run')).body;
}

test('Y12/S7-R14/R15 role matrix: owners get 403 on the demo lane; judges get 403 on operator routes; the role comes only from the verified claim', async () => {
  const h = await judgeWorld();
  assert.deepEqual([(await h.demo('GET', '/v1/demo/run', undefined, 'OWNER')).status, (await h.demo('GET', '/v1/demo/run', undefined, 'OWNER')).body.code], [403, 'FORBIDDEN_ROLE']);
  assert.equal((await h.demo('GET', '/v1/demo/run', undefined, 'JUDGE')).status, 200);
  assert.equal((await h.demo('POST', '/v1/operator/release', {}, 'JUDGE')).body.code, 'FORBIDDEN_ROLE');
  assert.equal((await h.demo('POST', '/v1/operator/release', {}, 'OPERATOR')).status, 200);
  // The API Lambda never serves the lane, whatever is claimed in a header.
  const api = await h.api('GET', '/v1/demo/run', undefined, { 'x-headroom-role': 'OPERATOR', 'cognito:groups': 'operator' });
  assert.equal(api.status, 404);
  const { roleOf } = await import('../../backend/src/handlers/http-event.ts');
  assert.deepEqual([roleOf('[judge]'), roleOf('[judge operator]'), roleOf(undefined), roleOf('admin')], ['JUDGE', 'OPERATOR', 'OWNER', 'OWNER']);
});

test('S7-R13 a judge watching the showcase: every write is 403 READ_ONLY (product and demo); the exits work', async () => {
  const h = await judgeWorld();
  assert.equal((await h.demo('POST', '/v1/demo/view', { view: 'SHOWCASE' })).status, 200);
  // The judge's product reads now come from the showcase tenant (none here → no run), and any product write is refused.
  const w = await h.api('POST', '/v1/plan/revisions', {}, {}, undefined);
  assert.ok([403, 409].includes(w.status));
  assert.equal((await h.demo('POST', '/v1/demo/bill', {})).body.code, 'READ_ONLY');
  assert.equal((await h.demo('POST', '/v1/demo/advance', {})).body.code, 'READ_ONLY');
  assert.equal((await h.demo('POST', '/v1/demo/view', { view: 'MY_RUN' })).status, 200);
});

for (const mode of ['fake', 'fake-async'] as const) test(`S7-A9/A10/A11/R27/R29 judge path (${mode === 'fake' ? 'inline payer' : 'payer Lambda hand-off'}): Start → bill → plan → approve → Pellow’s reminder sent → the payer pays on PayPal → verified by GETs; one attempt per action`, async () => {
  const h = await judgeWorld(mode);
  const r0 = await started(h);
  assert.equal(r0.reset.state, 'DONE', JSON.stringify(r0.reset));
  assert.equal(r0.lease.mine, true);
  // Nothing to collect before the plan asks (S7-R29).
  assert.equal((await h.demo('POST', '/v1/demo/bill', {})).status, 202);
  await h.drain();
  const pk = K.run('tenant-a', r0.run.runId);
  const bill = (await h.store.query('core', pk, { skPrefix: 'BILL#' }))[0];
  // A demo Start seeds the business's own bill rule (owner, 3 Nov 2026): the bill is verified and its earlier date accepted by rule.
  assert.equal((await h.bill(bill.billId)).bill.state, 'TERMS_ACCEPTED');
  await h.drain();
  const rev = (await h.api('GET', '/v1/plan')).body.revision;
  const pellow = rev.actions.find((a: any) => a.kind === 'COLLECT_OVERDUE');
  assert.equal((await h.demo('POST', '/v1/demo/collect', { actionId: pellow.actionId })).body.code, 'NOTHING_TO_COLLECT', 'not approved, not sent');
  assert.equal((await h.api('POST', `/v1/plan/revisions/${rev.revisionId}/approve`, { selected: rev.approval.selected, consentHash: rev.approval.consentHash }, { 'if-match': String(rev.version) })).status, 200);
  for (let i = 0; i < 3; i++) { await h.drain(); await h.advance(61_000); }
  const run = (await h.demo('GET', '/v1/demo/run')).body;
  const row = run.collections.find((c: any) => c.actionId === pellow.actionId);
  assert.deepEqual([row.canPay, row.amount.minor], [true, 760_000], JSON.stringify(row));
  const [x, y] = await Promise.all([h.demo('POST', '/v1/demo/collect', { actionId: pellow.actionId }), h.demo('POST', '/v1/demo/collect', { actionId: pellow.actionId })]);
  assert.equal(x.body.attemptId, y.body.attemptId, 'S7-R27 one attempt');
  for (let i = 0; i < 6; i++) { await h.drain(); await h.advance(5_000); }
  const att = (await h.store.query('core', pk, { skPrefix: 'PAYER#' }));
  assert.equal(att.length, 1);
  assert.equal(att[0].phase, 'VERIFIED_PAID', JSON.stringify(att[0]));
  assert.equal(att[0].label, 'AUTOMATED-PAYER');
  const rc = (await h.store.query('core', pk, { skPrefix: 'RCPT#' })).find((r) => r.captureId === att[0].captureId);
  assert.equal(rc?.gross.minor, 760_000, 'the receipt is from the capture GET');
  const eff = (await h.demo('GET', '/v1/demo/effects')).body.rows;
  assert.ok(eff.some((e: any) => e.kind === 'CAPTURE' && e.providerIds.includes(att[0].captureId)), 'S7-A11 effects log shows the capture id');
  assert.ok(eff.some((e: any) => e.kind === 'INVOICE' && e.providerIds.length));
  // S7-A10: advance runs the next scheduled step early; provider times stay real.
  const before = (await h.demo('GET', '/v1/demo/run')).body.clock.next;
  assert.ok(before, 'a next step exists (e.g. the Mercer check)');
  const adv = await h.demo('POST', '/v1/demo/advance', {});
  assert.equal(adv.status, 200, JSON.stringify(adv.body));
  assert.equal(adv.body.virtualNow, before.at);
  const audit = await h.store.query('audit', pk, {});
  assert.ok(audit.some((a) => /Sandbox clock advanced/.test(a.result)));
});

test('S7-R17/R1 a second judge while the first holds the merchant → 409 MERCHANT_LEASED with the time; they may watch the showcase', async () => {
  const h = await judgeWorld();
  await started(h);
  const second = await h.demo('POST', '/v1/demo/start', {}, 'JUDGE', OWNER_B);
  assert.deepEqual([second.status, second.body.code], [409, 'MERCHANT_LEASED']);
  assert.match(second.body.message, /until about/);
  const view = (await h.demo('GET', '/v1/demo/run', undefined, 'JUDGE', OWNER_B)).body;
  assert.deepEqual([view.lease.held, view.canStart], [true, false]);
  assert.equal((await h.demo('POST', '/v1/demo/collect', { actionId: 'x' }, 'JUDGE', OWNER_B)).body.code, 'MERCHANT_LEASED', 'no writes without the lease');
});

/** A judge world up to "Pellow can be paid" (approved, reminder sent), with the payer Lambda hand-off captured instead of run. */
async function payableWorld() {
  const h = await judgeWorld('fake-async');
  const r0 = await started(h);
  await h.demo('POST', '/v1/demo/bill', {});
  await h.drain();
  const pk = K.run('tenant-a', r0.run.runId);
  const bill = (await h.store.query('core', pk, { skPrefix: 'BILL#' }))[0];
  let b = await h.bill(bill.billId);
  await h.api('POST', `/v1/bills/${b.bill.billId}/verify`, { occurrenceKey: b.occurrence.occurrenceKey, occurrenceVersion: b.occurrence.version }, { 'if-match': String(b.bill.version) });
  b = await h.bill(bill.billId);
  await h.api('POST', `/v1/bills/${b.bill.billId}/accept-terms`, { termsHash: b.termsHash, changedFields: b.changedFields }, { 'if-match': String(b.bill.version) });
  await h.drain();
  const rev = (await h.api('GET', '/v1/plan')).body.revision;
  const pellow = rev.actions.find((a: any) => a.kind === 'COLLECT_OVERDUE');
  await h.api('POST', `/v1/plan/revisions/${rev.revisionId}/approve`, { selected: rev.approval.selected, consentHash: rev.approval.consentHash }, { 'if-match': String(rev.version) });
  for (let i = 0; i < 3; i++) { await h.drain(); await h.advance(61_000); }
  const sent: any[] = [];
  h.deps.payerAsync = async (req) => { sent.push(req); };
  let browsers = 0;
  const real = h.deps.payer!;
  h.deps.payer = { pay: async (r) => { browsers++; return real.pay(r); } };
  assert.equal((await h.demo('POST', '/v1/demo/collect', { actionId: pellow.actionId })).status, 202);
  await h.drain();
  const att = async () => (await h.store.query('core', pk, { skPrefix: 'PAYER#' }))[0];
  assert.equal((await att()).phase, 'SUBMITTING');
  assert.equal(sent.length, 1, 'handed to the payer Lambda once');
  return { h, pk, sent, att, browsers: () => browsers };
}

test('S7-R28 the browser runs at most once per attempt: a duplicate/retried invocation does nothing; a payer that never started is fenced → NOT_SUBMITTED', async () => {
  const w = await payableWorld();
  const { payOnce } = await import('../../backend/src/domain/demo/payer.ts');
  await Promise.all([payOnce(w.h.deps, w.sent[0]), payOnce(w.h.deps, w.sent[0])]);
  await payOnce(w.h.deps, w.sent[0]); // an AWS retry minutes later
  assert.equal(w.browsers(), 1, 'one browser run');
  for (let i = 0; i < 4; i++) { await w.h.drain(); await w.h.advance(5_000); }
  assert.equal((await w.att()).phase, 'VERIFIED_PAID');

  // A second world: the hand-off is lost (event expired). The 4-min backstop fences the browser off → NOT_SUBMITTED; a late invoke can't run.
  const v = await payableWorld();
  await v.h.advance(4 * 60_000 + 1_000);
  await v.h.drain();
  const a = await v.att();
  assert.equal(a.phase, 'NOT_SUBMITTED', a.text);
  await payOnce(v.h.deps, v.sent[0]);
  assert.equal(v.browsers(), 0, 'a late invocation never runs the browser');
});

test('S7b review P2-1: a browser that died mid-run is never re-run; with PayPal unreadable the attempt stays UNKNOWN_UNRESOLVED, not "not paid"', async () => {
  const w = await payableWorld();
  // The browser claimed the attempt, then died (no result written).
  const job = (await w.h.store.query('work', `JOB#payer#${w.sent[0].attemptId}`, {}))[0];
  await w.h.store.transact([{ op: 'update', table: 'work', pk: job.pk, sk: 'JOB', set: { browserAt: w.h.clock() } }]);
  const reader = w.h.deps.reader;
  w.h.deps.reader = { ...reader, getInvoice: async () => ({ status: 503, body: {}, raw: '', rawSha256: '' }) } as unknown as typeof reader;
  await w.h.advance(4 * 60_000 + 1_000);
  for (let i = 0; i < 20; i++) await w.h.advance(60_000);
  const a = await w.att();
  assert.equal(a.phase, 'UNKNOWN_UNRESOLVED', a.text);
  assert.equal(w.browsers(), 0);
  const run = (await w.h.demo('GET', '/v1/demo/run')).body;
  assert.equal(run.collections.find((c: any) => c.attempt)?.canPay, false, 'no second payment while unresolved');
});

test('One dock (owner, 5 Nov 2026): following the live run’s journey.next from a fresh Start moves through the beats in order; only the holder gets one', async () => {
  const h = await judgeWorld();
  await started(h);
  const steps: number[] = [], kinds: string[] = [];
  for (let i = 0; i < 40; i++) {
    const j = (await h.demo('GET', '/v1/demo/run')).body.journey;
    assert.ok(j, 'the holder gets a journey');
    steps.push(j.step); kinds.push(j.next.kind);
    if (j.next.kind === 'DONE') break;
    if (j.next.kind === 'BILL') assert.equal((await h.demo('POST', '/v1/demo/bill', {})).status, 202);
    if (j.next.kind === 'CONFIRM_PAYEE') { const r = await h.api('GET', '/v1/payables/payees/sup-keller/reveal'); assert.equal((await h.api('POST', '/v1/payables/payees/sup-keller/confirm', { version: r.body.version, address: r.body.address })).body.state, 'CONFIRMED'); }
    if (j.next.kind === 'APPROVE') { const rev = (await h.api('GET', '/v1/plan')).body.revision; assert.equal((await h.api('POST', `/v1/plan/revisions/${rev.revisionId}/approve`, { selected: rev.approval.selected, consentHash: rev.approval.consentHash }, { 'if-match': String(rev.version) })).status, 200); }
    if (j.next.kind === 'PAY') assert.equal((await h.demo('POST', '/v1/demo/collect', { actionId: j.next.actionId })).status, 202);
    if (j.next.kind === 'ADVANCE') assert.equal((await h.demo('POST', '/v1/demo/advance', {})).status, 200);
    await h.drain(); await h.advance(30_000);
  }
  const trail = `${steps.join(',')} · ${kinds.join(',')}`;
  assert.ok(steps.every((s, i) => i === 0 || s >= steps[i - 1]), `beats only move forward: ${trail}`);
  assert.ok(Math.max(...steps) >= 5, `reaches both customers paid: ${trail}`);
  assert.equal((await h.demo('GET', '/v1/demo/run', undefined, 'JUDGE', OWNER_B)).body.journey, null, 'a judge not holding the run gets none');
  const last = (await h.demo('GET', '/v1/demo/run')).body.journey.next;
  // The fake PayPal never releases today's captures, so the run ends on Keller's payout held, with PayPal's reason as the dock's text.
  assert.deepEqual([last.kind, /release today's customer payments/.test(last.label)], ['WAIT', true], `${trail} · ${last.label}`);
  for (const k of ['BILL', 'CONFIRM_PAYEE', 'APPROVE', 'PAY', 'ADVANCE']) assert.ok(kinds.includes(k), `${k} was a Next: ${trail}`);
  assert.ok(kinds.indexOf('CONFIRM_PAYEE') < kinds.indexOf('APPROVE'), 'Keller’s address is confirmed before the approval, so the payout is in it (as recorded)');
  assert.equal(kinds.filter((k) => k === 'APPROVE').length, 1, 'one approval covers the payout too');
});
