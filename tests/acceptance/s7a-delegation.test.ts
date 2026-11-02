// S7a layer 3 (S07 §6.18, §7a): every Delegation rule through preview → save on the real router, the safety-rule acknowledgement,
// one reserve source, and the differing-bills rule in real ingestion. Real S1–S6 upstream with fake PayPal/Plaid and the S3 FakeInterpreter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { harness } from './harness.ts';
import { K } from '../../backend/src/adapters/store/keys.ts';
import { addDays } from '../../backend/src/domain/time.ts';

const fx = JSON.parse(readFileSync(new URL('../fixtures/hero-v1a/closes.json', import.meta.url), 'utf8'));
const MON_10AM = '2026-11-09T15:00:00.000Z';
type H = Awaited<ReturnType<typeof harness>>;
const hero = () => harness({ plaid: true, hero: true, paypalMinor: 180_000, start: MON_10AM }).then(async (h) => { await h.drain(); return h; });
const deleg = async (h: H) => (await h.api('GET', '/v1/delegation')).body;

/** Preview then save one rule change; returns the save response. */
async function change(h: H, key: string, value: unknown, o: { scope?: string; ack?: boolean } = {}) {
  const body = { key, scope: o.scope ?? 'EVERYWHERE', value };
  const pv = await h.api('POST', '/v1/delegation/preview', body);
  if (pv.status !== 200) return pv;
  const v = (await deleg(h)).version;
  return h.api('POST', '/v1/delegation/rules', { ...body, previewHash: pv.body.previewHash, ...(o.ack === undefined ? {} : { acknowledgeSafety: o.ack }) }, { 'if-match': String(v) });
}

test('S7-A3 every editable rule: preview → save → the row shows the value; set by you', async () => {
  const h = await hero();
  const LOOSE: Record<string, unknown> = {
    'comms.remindersWithoutReview': false, 'ar.discount': { bp: 300, capMinor: 40_000, cumulativeMinor: 40_000, tiers: ['STRONG', 'GOOD', 'MIXED'] },
    'ap.paymentLimitMinor': 700_000, 'ap.dailyLimitMinor': 800_000, 'ap.exactMatchBills': 'ALWAYS_ASK', 'cash.reserveMinor': 350_000, 'cash.protectedPayments': { setAsideDays: 3 },
    'comms.window': { open: '07:30', close: '19:00' }, 'ap.differingBills': { mode: 'AUTO_ACCEPT', maxAmountDiffMinor: 50_000, maxDaysEarlier: 30 },
    'ar.disputes': 'PAUSE_INVOICE', 'comms.contactEveryBd': 3, 'ar.newDateDays': 21, 'ap.askSuppliers': 'WITHOUT_REVIEW',
  };
  const rows = (await deleg(h)).rules;
  for (const r of rows.filter((x: any) => x.editable)) {
    assert.ok(r.key in LOOSE, `test covers ${r.key}`);
    const saved = await change(h, r.key, LOOSE[r.key], { ack: true });
    assert.equal(saved.status, 200, `${r.key}: ${JSON.stringify(saved.body)}`);
    const now = (await deleg(h)).rules.find((x: any) => x.key === r.key);
    assert.equal(now.provenance, 'OWNER', r.key);
    assert.notEqual(now.text, r.text, `${r.key}: the sentence renders the new value`);
  }
  for (const r of rows.filter((x: any) => !x.editable)) assert.ok(r.enforcedNow, `${r.key}: a rule without a Change control says why`);
});

test('S7-R5/S7-A7 loosening a safety rule needs "I understand"; chip + Overview notice while loose; Restore default clears both; audited', async () => {
  const h = await hero();
  const without = await change(h, 'ar.disputes', 'PROPOSE_DISPUTED');
  assert.deepEqual([without.status, without.body.code], [400, 'SAFETY_ACK_REQUIRED']);
  assert.equal((await deleg(h)).version, 1, 'nothing saved');
  const pv = (await h.api('POST', '/v1/delegation/preview', { key: 'ar.disputes', scope: 'EVERYWHERE', value: 'PROPOSE_DISPUTED' })).body;
  assert.deepEqual([pv.loosens, pv.safety], [true, true]);
  assert.match(pv.safetyText, /each ask still needs your approval/i);
  assert.equal((await change(h, 'ar.disputes', 'PROPOSE_DISPUTED', { ack: true })).status, 200);
  const row = (await deleg(h)).rules.find((x: any) => x.key === 'ar.disputes');
  assert.deepEqual([row.safety, row.loosenedFromDefault, row.defaultValue], [true, true, 'UNDISPUTED_ONLY']);
  const ov = await h.overview();
  assert.deepEqual(ov.safetyNotices.map((n: any) => n.key), ['ar.disputes']);
  // Restore default is a tightening change: no acknowledgement needed.
  assert.equal((await change(h, 'ar.disputes', 'UNDISPUTED_ONLY')).status, 200);
  assert.equal((await deleg(h)).rules.find((x: any) => x.key === 'ar.disputes').loosenedFromDefault, false);
  assert.deepEqual((await h.overview()).safetyNotices, []);
  const audit = await h.store.query('audit', K.run('tenant-a', h.run!.runId), {});
  const changes = audit.filter((a) => a.eventType === 'PolicyChanged');
  assert.equal(changes.length, 2);
  assert.equal(changes.filter((a) => a.refs.safety === 'true').length, 1);
});

test('S7-R6 wrong type / out of range at the API → INVALID_INPUT', async () => {
  const h = await hero();
  for (const [key, value] of [['cash.reserveMinor', 'x'], ['comms.window', { open: '05:00', close: '18:00' }], ['ar.disputes', 'ALWAYS'], ['cash.protectedPayments', { setAsideDays: 20 }]] as const) {
    const r = await h.api('POST', '/v1/delegation/preview', { key, scope: 'EVERYWHERE', value });
    assert.deepEqual([r.status, r.body.code], [400, 'INVALID_INPUT'], key);
  }
});

test('S7-A6 reserve changed to $3,000: forecast reserve and gap, Cash and Overview all use it (one source)', async () => {
  const h = await hero();
  const inj = await h.inject('hero');
  let b = await h.bill(inj.billId);
  await h.api('POST', `/v1/bills/${b.bill.billId}/verify`, { occurrenceKey: b.occurrence.occurrenceKey, occurrenceVersion: b.occurrence.version }, { 'if-match': String(b.bill.version) });
  b = await h.bill(inj.billId);
  await h.api('POST', `/v1/bills/${b.bill.billId}/accept-terms`, { termsHash: b.termsHash, changedFields: b.changedFields }, { 'if-match': String(b.bill.version) });
  const before = await h.forecast();
  assert.equal(before.reserve.minor, fx.reserveMinor);
  assert.equal((await change(h, 'cash.reserveMinor', 300_000)).status, 200);
  const f = await h.forecast();
  assert.equal(f.reserve.minor, 300_000);
  assert.equal(f.summary.reserveGap.minor, before.summary.reserveGap.minor - 100_000);
  assert.equal((await h.cash()).reserve.amount.minor, 300_000);
});

test('S7-A5 differing bills accepted by rule: VERIFY# + TERMS# by HEADROOM with the policy version; forecast moves; payout still needs a grant', async () => {
  const h = await hero();
  assert.equal((await change(h, 'ap.differingBills', { mode: 'AUTO_ACCEPT', maxAmountDiffMinor: 0, maxDaysEarlier: 30 }, { ack: true })).status, 200);
  const inj = await h.inject('hero');
  const b = await h.bill(inj.billId);
  assert.equal(b.bill.state, 'TERMS_ACCEPTED');
  const pk = K.run('tenant-a', h.run!.runId);
  const terms = await h.store.query('core', pk, { skPrefix: 'TERMS#' });
  assert.equal(terms.length, 1);
  assert.deepEqual([terms[0].by, terms[0].policyVersion], ['HEADROOM', 2]);
  assert.match(terms[0].allowedBy, /Delegation v2 · Accept a differing bill automatically/);
  assert.ok(await h.store.get('core', pk, `VERIFY#${inj.billId}`));
  const f = await h.forecast();
  assert.equal(f.summary.firstBelowReserve, addDays(h.day0(), 4));
  assert.equal(f.summary.reserveGap.minor, 854_000, 'the A-001 gap, reached by the rule instead of the owner');
  const r = await h.api('POST', '/v1/plan/revisions', {});
  assert.ok([200, 202].includes(r.status), 'O6: it may already be building by itself');
  await h.drain();
  const pay = (await h.api('GET', '/v1/plan')).body.revision.actions.find((a: any) => a.kind === 'PAYOUT');
  assert.ok(pay.authority.grantKinds.includes('PAYOUT_AUTHORITY'), 'paying is still a separate grant');
});

test('S7-R8 under auto-accept: changed payment details, an out-of-bounds amount, or a later date still come to the owner', async () => {
  const h = await hero();
  assert.equal((await change(h, 'ap.differingBills', { mode: 'AUTO_ACCEPT', maxAmountDiffMinor: 10_000, maxDaysEarlier: 30 }, { ack: true })).status, 200);
  const rem = await h.bill((await h.inject('remittance')).billId);
  assert.equal(rem.bill.state, 'HELD', 'REMITTANCE_CHANGE is a hard stop');
  const amt = await h.bill((await h.inject('amount')).billId);
  assert.equal(amt.bill.state, 'PROPOSED', '$400 more is above the $100 bound');
  assert.equal((await h.store.query('core', K.run('tenant-a', h.run!.runId), { skPrefix: 'TERMS#' })).length, 0);
});

test('S7-R7 every rule at its loosest: the hard stops still hold (pause, payout authority, verified recipient)', async () => {
  const h = await hero();
  for (const [k, v] of [['ap.paymentLimitMinor', 100_000_000], ['ap.dailyLimitMinor', 100_000_000], ['ap.differingBills', { mode: 'AUTO_ACCEPT', maxAmountDiffMinor: 100_000, maxDaysEarlier: 30 }], ['ar.disputes', 'PROPOSE_DISPUTED'], ['cash.reserveMinor', 0]] as const)
    assert.equal((await change(h, k, v, { ack: true })).status, 200, k);
  const rem = await h.bill((await h.inject('remittance')).billId);
  assert.equal(rem.bill.state, 'HELD', 'verified recipient');
  const v = (await deleg(h)).version;
  assert.equal((await h.api('POST', '/v1/delegation/pauses', { kind: 'PAYMENTS', on: true }, { 'if-match': String(v) })).status, 200);
  const inj = await h.inject('hero');
  assert.equal((await h.bill(inj.billId)).bill.state, 'TERMS_ACCEPTED');
  await h.drain(); // O6: the accepted terms leave a shortfall even with a $0 reserve? Build explicitly if not.
  let rev = (await h.api('GET', '/v1/plan')).body.revision;
  if (!rev) { await h.api('POST', '/v1/plan/revisions', {}); await h.drain(); rev = (await h.api('GET', '/v1/plan')).body.revision; }
  const plan = (await h.api('GET', '/v1/plan')).body;
  // With the reserve at $0 the hero may need no plan at all; then the hard stops are checked on what remains: nothing pays without authority.
  if (!rev) { assert.equal(plan.state, 'NO_PLAN_NEEDED', JSON.stringify(plan.state)); assert.equal((await h.store.query('core', K.run('tenant-a', h.run!.runId), { skPrefix: 'GRANT#' })).length, 0); return; }
  const pay = rev.actions.find((a: any) => a.kind === 'PAYOUT');
  assert.ok(pay, 'the held payout is always in the plan');
  assert.ok(pay.authority.grantKinds.includes('PAYOUT_AUTHORITY'), 'consent: payout authority is always a grant');
  assert.match(pay.paused ?? '', /Paused/, 'the payments pause still holds');
  const ask = [...rev.actions, ...rev.considered].find((a: any) => a.kind === 'COLLECT_DISPUTED');
  if (ask) assert.equal(ask.authority.decision, 'REQUIRES_APPROVAL', 'a disputed ask is never autonomous');
});

test('Y2 ar.newDateDays: a promise beyond the limit is kept, not counted, Needs you; "Count this date" counts it in Expected only', async () => {
  const { approved, FakeReplier, items, pellowOut, PELLOW, reply, TUE_0805 } = await import('./s5-helpers.ts');
  const replier = new FakeReplier();
  const { h } = await approved({ replier });
  // Tighten to 2 days (Getting paid scope). A promise for Nov 20 sent Tue Nov 10 is 10 days out.
  const v = (await deleg(h)).version;
  const pv = await h.api('POST', '/v1/delegation/preview', { key: 'ar.newDateDays', scope: 'RECEIVABLES', value: 2 });
  assert.equal((await h.api('POST', '/v1/delegation/rules', { key: 'ar.newDateDays', scope: 'RECEIVABLES', value: 2, previewHash: pv.body.previewHash }, { 'if-match': String(v) })).status, 200);
  h.setNow(TUE_0805);
  await h.drain();
  const out = await pellowOut(h);
  const before = await h.forecast();
  replier.next = { intent: 'PROMISE', quote: "We'll pay $7,600 on Nov 20.", quotedDate: 'Nov 20', quotedAmount: '$7,600' };
  await reply(h, { from: PELLOW, text: "Thanks. We'll pay $7,600 on Nov 20.", inReplyTo: out.rfcMessageId });
  const [p] = await items(h, 'PROMISE#');
  assert.deepEqual([p.on, p.beyondLimitDays, p.acceptedBy], ['2026-11-20', 2, null]);
  const f = await h.forecast();
  assert.ok(!f.days.flatMap((d: any) => d.items).some((i: any) => i.basis === 'PROMISE'), 'not counted');
  assert.equal(f.summary.low.minor, before.summary.low.minor);
  const ov = await h.overview();
  assert.ok(ov.needs.some((n: any) => n.key === `promise:${p.promiseId}`), 'Needs you row');
  const entry = (await h.api('GET', '/v1/inbox')).body.threads.flatMap((t: any) => t.entries).find((e: any) => e.promise);
  assert.deepEqual([entry.promise.beyondLimitDays, entry.promise.accepted, entry.needsYou], [2, false, true]);
  assert.equal((await h.api('POST', `/v1/inbox/promises/${p.promiseId}/accept`, {})).status, 200);
  assert.equal((await h.api('POST', `/v1/inbox/promises/${p.promiseId}/accept`, {})).body.code, 'VERSION_CONFLICT', 'once');
  assert.ok((await h.forecast()).days.flatMap((d: any) => d.items).some((i: any) => i.basis === 'PROMISE'), 'counted after you accept');
  assert.ok(!(await h.overview()).needs.some((n: any) => n.key === `promise:${p.promiseId}`));
});

test('Y15/R9 contact spacing: two customers of one business share one slot; the second waits until N business days after the first send', async () => {
  const { approved, items, TUE_0805 } = await import('./s5-helpers.ts');
  const { h } = await approved();
  // Harrow and Pellow are the same business (fixture only): one slot.
  const pk = K.run('tenant-a', h.run!.runId);
  for (const c of (await h.store.query('core', pk, { skPrefix: 'CUST#' })).filter((x) => x.customerId === 'cust-harrow' || x.customerId === 'cust-pellow'))
    await h.store.transact([{ op: 'update', table: 'core', pk, sk: c.sk, set: { businessKey: 'biz-shared' } }]);
  h.setNow(TUE_0805);
  for (let i = 0; i < 4; i++) { await h.drain(); await h.advance(61_000); }
  // A claim made while the first send was in flight retries 15 min later and then sees the recorded send.
  await h.advance(16 * 60_000); await h.drain();
  const outs = await items(h, 'OUTMSG#');
  const sent = outs.filter((o) => o.state === 'SENT');
  const waiting = outs.filter((o) => o.state === 'QUEUED' && /Waiting · Last contacted/.test(o.reason ?? ''));
  assert.equal(sent.length, 1, JSON.stringify(outs.map((o) => [o.customerId, o.state, o.reason])));
  assert.equal(waiting.length, 1, 'the other message to the same business waits');
  assert.match(waiting[0].reason, /every 4 business days, so next allowed/);
  const slot = await h.store.get('core', pk, 'CONTACT#biz-shared');
  assert.deepEqual([slot!.pendingEffect, !!slot!.lastSentAt], [null, true]);
});

test('S7-A16 (O6) accepting the bill’s terms builds the plan by itself: the draft is waiting without opening Plan; audited as Headroom', async () => {
  const h = await hero();
  const inj = await h.inject('hero');
  let b = await h.bill(inj.billId);
  await h.api('POST', `/v1/bills/${b.bill.billId}/verify`, { occurrenceKey: b.occurrence.occurrenceKey, occurrenceVersion: b.occurrence.version }, { 'if-match': String(b.bill.version) });
  b = await h.bill(inj.billId);
  assert.equal((await h.api('POST', `/v1/bills/${b.bill.billId}/accept-terms`, { termsHash: b.termsHash, changedFields: b.changedFields }, { 'if-match': String(b.bill.version) })).status, 200);
  await h.drain();
  const p = (await h.api('GET', '/v1/plan')).body;
  assert.deepEqual([p.state, p.revision?.n], ['READY', 1]);
  const audit = await h.store.query('audit', K.run('tenant-a', h.run!.runId), {});
  assert.ok(audit.some((a) => a.eventType === 'PlanBuildRequested' && a.by === 'HEADROOM' && /by itself/.test(a.result)));
});

test('S7-R43 a history-only label change (live facts) makes the plan stale and dispatch re-decides with the new tier', async () => {
  const { approved, items } = await import('./s5-helpers.ts');
  const { h } = await approved();
  const pk = K.run('tenant-a', h.run!.runId);
  assert.equal((await h.api('GET', '/v1/plan')).body.banner ?? null, null);
  // Mercer (Strong) gains an open seeded dispute in history: At risk, review-first; nothing else changes.
  await h.store.transact([{ op: 'put', table: 'core', item: { pk, sk: 'HIST#cust-mercer#099', counterpartyId: 'cust-mercer', n: 99, kind: 'DISPUTE', ref: 'test', dueOn: h.day0(), paidOn: null, amount: { currency: 'USD', minor: 1 }, note: 'test dispute', open: true, basis: 'SEEDED' } }]);
  const p = (await h.api('GET', '/v1/plan')).body;
  assert.match(p.banner ?? '', /changed/i, JSON.stringify([p.state, p.banner]));
  const mercer = (await items(h, 'ACT#')).find((a) => a.kind === 'DISCOUNT_FALLBACK')!;
  const { authorityFor } = await import('../../backend/src/domain/plan/authority.ts');
  const { loadPlanState } = await import('../../backend/src/domain/plan/state.ts');
  const { planCtxFor } = await import('../../backend/src/domain/plan/authority.ts');
  const s = await loadPlanState((await planCtxFor(h.deps, 'tenant-a', h.run!.runId))!);
  const { res } = await authorityFor(s, mercer as never, 'DISPATCH', 'EFFECT');
  assert.equal(res.ok, false, 'At risk: the offer is no longer authorized at dispatch');
});
