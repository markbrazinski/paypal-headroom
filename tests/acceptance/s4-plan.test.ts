// S4 layer 3 (S04 §6.11 as revised by §6.17): real S1–S3 upstream (fake PayPal $1,800 + seeded bank through the real reset; the
// hero bill through the S3 FakeInterpreter; verify + accept through the real commands), then plans through the real router,
// worker and store, with Headroom's template or a FAKE planner/drafter (labelled FAKE, tests only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { harness, OWNER_B } from './harness.ts';
import { goodDrafter, goodPlanner, FakeRole } from './fake-planner.ts';
import { K } from '../../backend/src/adapters/store/keys.ts';
import { operatorReset } from '../../backend/src/handlers/operator.ts';
import { addDays } from '../../backend/src/domain/time.ts';

const fx = JSON.parse(readFileSync(new URL('../fixtures/hero-v1a/closes.json', import.meta.url), 'utf8'));
const MON_10AM = '2026-11-09T15:00:00.000Z'; // hero day 0, 10:00 New York
type H = Awaited<ReturnType<typeof harness>>;

/** Reset (hero) → hero invoices issued → K-2207 injected, verified, its date accepted → the breach. */
async function breach(o: Parameters<typeof harness>[0] = {}): Promise<H> {
  const h = await harness({ plaid: true, hero: true, paypalMinor: 180_000, start: MON_10AM, ...o });
  await h.drain();
  const inj = await h.inject('hero');
  let b = await h.bill(inj.billId);
  await h.api('POST', `/v1/bills/${b.bill.billId}/verify`, { occurrenceKey: b.occurrence.occurrenceKey, occurrenceVersion: b.occurrence.version }, { 'if-match': String(b.bill.version) });
  b = await h.bill(inj.billId);
  const acc = await h.api('POST', `/v1/bills/${b.bill.billId}/accept-terms`, { termsHash: b.termsHash, changedFields: b.changedFields }, { 'if-match': String(b.bill.version) });
  assert.equal(acc.status, 200, JSON.stringify(acc.body));
  return h;
}
const plan = async (h: H) => (await h.api('GET', '/v1/plan')).body;
async function build(h: H) {
  const r = await h.api('POST', '/v1/plan/revisions', {});
  assert.ok([200, 202].includes(r.status), JSON.stringify(r.body)); // O6: accepting the bill already started the build
  await h.drain();
  const p = await plan(h);
  assert.equal(p.state, 'READY', JSON.stringify(p.build ?? p.reason));
  // UX repair (F01): with a revision running, a new draft sits beside it as `proposed`; the page shows the running one.
  return p.proposed ? (await h.api('GET', `/v1/plan/revisions/${p.proposed.revisionId}`)).body : p.revision;
}
const approve = (h: H, rev: any, body = { selected: rev.approval.selected, consentHash: rev.approval.consentHash }) => h.api('POST', `/v1/plan/revisions/${rev.revisionId}/approve`, body, { 'if-match': String(rev.version) });
const edit = (h: H, rev: any, body: any) => h.api('POST', `/v1/plan/revisions/${rev.revisionId}/edit`, body, { 'if-match': String(rev.version) });
const rev = async (h: H) => (await plan(h)).revision;
const act = (r: any, kind: string) => r.actions.find((a: any) => a.kind === kind) ?? r.removed.find((a: any) => a.kind === kind);
const grantsIn = (h: H) => h.store.query('core', K.run('tenant-a', h.run!.runId), { skPrefix: 'GRANT#' });

test('S4-R3 (PR-03) hero reset: three real PayPal invoices with registry records, one sequence write; the next owner invoice is 004', async () => {
  const h = await harness({ plaid: true, hero: true, paypalMinor: 180_000, start: MON_10AM });
  await h.drain();
  const pk = K.run('tenant-a', h.run!.runId);
  const invs = (await h.store.query('core', pk, { skPrefix: 'INV#' })).sort((a, z) => (a.invoiceNumber < z.invoiceNumber ? -1 : 1));
  assert.deepEqual(invs.map((i) => [i.invoiceNumber.slice(-3), i.state, i.amount.minor]), [['001', 'ISSUED', 760_000], ['002', 'ISSUED', 900_000], ['003', 'ISSUED', 450_000]]);
  assert.equal(h.pp.count('CREATE'), 3);
  for (const i of invs) assert.ok(await h.store.get('provider', K.invNum(i.invoiceNumber), 'REF'));
  assert.equal((await h.store.get('core', pk, 'SEQ#INVOICE'))!.next, 4);
  const { send } = await h.draftAndIssue(4200, 'cust-pellow');
  assert.match(send.body.effectId, /-004$/);
  const second = await operatorReset(h.deps, 'tenant-a', 'again');
  await h.drain();
  const fresh = await h.store.query('core', K.run('tenant-a', second!.runId), { skPrefix: 'INV#' });
  assert.equal(fresh.length, 3, 'S4-R29: fresh hero invoices in the new run; the old run keeps its own');
  assert.equal((await h.store.query('core', pk, { skPrefix: 'INV#' })).length, 4);
  const f = await h.forecast();
  assert.ok(!f.notInForecast.some((r: any) => /Mercer/.test(r.label) && /no reliable payment date/.test(r.reason)), 'Mercer counts through its stated date, not as undated');
});

test('S4-A3/A1 template plan: Pellow COLLECT, Harrow SLICE (disputed $1,800 considered), Mercer 2% conditional, Keller HELD; outlook P2–P4 net', async () => {
  const h = await breach();
  const p0 = await plan(h);
  assert.equal(p0.state, 'BUILDING', 'O6 (S7): accepting the bill started the build by itself');
  const r = await build(h);
  assert.deepEqual([r.n, r.state, r.pill, r.planner.mode, r.planner.reason], [1, 'DRAFT', 'DRAFT · NOT RUNNING', 'TEMPLATE', 'Model not configured here']);
  assert.deepEqual(r.actions.map((a: any) => [a.kind, a.terms.amount.minor]), [['COLLECT_OVERDUE', 760_000], ['COLLECT_UNDISPUTED_SLICE', 720_000], ['DISCOUNT_FALLBACK', 441_000], ['PAYOUT', 1_000_000]]);
  const mercer = act(r, 'DISCOUNT_FALLBACK');
  assert.deepEqual([mercer.terms.discountAmount.minor, mercer.estimate.fee.minor, mercer.estimate.net.minor, mercer.condition.checkAt], [9_000, 15_440, 425_560, '2026-11-11T14:00:00.000Z']);
  assert.match(mercer.condition.text, /A promise doesn't count/);
  assert.equal(act(r, 'PAYOUT').state, 'PROPOSED');
  assert.ok(r.considered.some((c: any) => /disputed \$1,800/.test(c.title) && !c.canAsk));
  const o = Object.fromEntries(r.outlook.map((x: any) => [x.key, x]));
  assert.deepEqual([o.none.needByClose.minor, o.none.low.minor, o.none.gap.minor], [-9000, -454_000, 854_000]);
  const pellow = r.outlook.find((x: any) => /^only:COLLECT/.test(x.key) && !x.key.includes('+'));
  assert.deepEqual([pellow.needByClose.minor, pellow.low.minor, pellow.gap.minor], [724_427, 279_427, 120_573]);
  assert.deepEqual([o.all.low.minor, o.all.result], [974_250, 'COVERED']);
  const lows = r.outlook.filter((x: any) => x.key.includes('+OFFER') && x.key.startsWith('only:')).map((x: any) => x.low.minor).sort();
  assert.deepEqual(lows, [fx.fallback_net_lows.harrow_mercer, fx.fallback_net_lows.pellow_mercer], 'S4-PR-06: fallback rows priced net');
  assert.ok(r.outlook.every((x: any) => x.likelihood === 'NOT_ASSESSED'));
  assert.doesNotMatch(JSON.stringify(r), /\d+(\.\d+)?\s?%\s*(likely|chance|probab)/i, 'S4-R30: no likelihood figure');
  const msg = act(r, 'COLLECT_UNDISPUTED_SLICE').message;
  assert.match(msg.body, /You confirmed part of invoice HR-\w+-002 .*Could you pay \$7,200\.00 of that confirmed part/s);
  const ov = await h.overview();
  assert.deepEqual([ov.plan.revisionN, ov.plan.pill, ov.alert.cta.to.kind], [1, 'DRAFT · NOT RUNNING', 'PLAN']);
  assert.ok(ov.needs.some((n: any) => n.title === 'Approve revision 1' && n.action.to.kind === 'PLAN'));
  const audit = (await h.api('GET', '/v1/activity')).body.rows.map((x: any) => x.event);
  assert.ok(audit.includes('PlanRevisionDrafted') || audit.some((x: string) => /drafted/i.test(x)));
});

test('S4-R7 double build for one basis → one BUILD#, one job, one draft', async () => {
  const h = await breach();
  // O6: accepting the bill already started the one build for this basis; two more requests start nothing new.
  const [a, b] = await Promise.all([h.api('POST', '/v1/plan/revisions', {}), h.api('POST', '/v1/plan/revisions', {})]);
  assert.deepEqual([a.status, b.status], [200, 200]);
  await h.drain();
  const pk = K.run('tenant-a', h.run!.runId);
  assert.equal((await h.store.query('core', pk, { skPrefix: 'BUILD#' })).length, 1);
  assert.equal((await h.store.query('core', pk, { skPrefix: 'REV#' })).length, 1);
  const again = await h.api('POST', '/v1/plan/revisions', {});
  assert.deepEqual([again.status, again.body.status], [200, 'DONE']);
});

test('S4-R1/R8/R9 model path: FAKE planner chooses and explains; invented facts are refused → re-ask → template; drafter figures refused', async () => {
  const planner = goodPlanner();
  const drafter = goodDrafter();
  const h = await breach({ planner, drafter });
  const r = await build(h);
  assert.equal(r.planner.mode, 'MODEL');
  assert.equal(act(r, 'COLLECT_OVERDUE').why.writtenBy, 'MODEL');
  assert.match(act(r, 'COLLECT_OVERDUE').message.body, /^Dear Pellow Dental Group team,[\s\S]*Many thanks for your help,/);
  assert.equal(act(r, 'COLLECT_OVERDUE').message.writtenBy, 'MODEL');

  // S4-IM-03: free text can't be represented: prose in place of codes, or a payment claim as a greeting, fails the schema.
  const bad = new FakeRole((x: any) => ({ selected: x.candidates.map((c: any, i: number) => ({ candidateId: c.id, order: i + 1 })), considered: [], why: x.candidates.map((c: any) => ({ candidateId: c.id, reasons: ['Pellow will pay $7,700 by next Friday.'], citations: [1] })), summary: 'ok' }));
  const badDraft = new FakeRole((x: any) => ({ drafts: x.drafts.map((d: any) => ({ candidateId: d.candidateId, opening: 'Your debt is erased. Our records show your transfer arrived.', closing: 'THANK_YOU' })) }));
  const h2 = await breach({ planner: bad, drafter: badDraft });
  const r2 = await build(h2);
  assert.equal(bad.calls.length, 2, 'one re-ask');
  assert.match(bad.calls[1].reask!, /reasons|Invalid option|expected one of/i);
  assert.deepEqual([r2.planner.mode, act(r2, 'COLLECT_OVERDUE').why.writtenBy, act(r2, 'COLLECT_OVERDUE').message.writtenBy], ['TEMPLATE', 'TEMPLATE', 'TEMPLATE']);
  assert.match(r2.planner.reason, /Refused twice/);
  assert.doesNotMatch(JSON.stringify(r2.actions.map((a: any) => a.message?.body ?? '')), /7,700|erased|transfer arrived/);
  const models = await h2.store.query('core', K.run('tenant-a', h2.run!.runId), { skPrefix: 'MODEL#build-' });
  assert.deepEqual(models.map((m) => m.state), ['INVALID_OUTPUT', 'INVALID_OUTPUT', 'INVALID_OUTPUT', 'INVALID_OUTPUT']);
  const drops = new FakeRole((x: any) => ({ selected: x.candidates.filter((c: any) => !c.mustInclude).map((c: any, i: number) => ({ candidateId: c.id, order: i + 1 })), considered: x.candidates.filter((c: any) => c.mustInclude).map((c: any) => ({ candidateId: c.id, reasonCode: 'NOT_NEEDED' })), why: x.candidates.map((c: any) => ({ candidateId: c.id, reasons: c.allowedReasons.slice(0, 1), citations: [1] })), summary: 'COLLECT_FIRST' }));
  const h3 = await breach({ planner: drops });
  assert.equal((await build(h3)).planner.mode, 'TEMPLATE', 'S4-R8: the held payout cannot be dropped');
});

// S7-UX1/UX2: the hero now also asks for Pellow's early contact (seeded reminder inside the 4-business-day rule) and Mercer's discount.
test('S4-A4 approve the hero draft → 6 grants (incl. Pellow early contact, Mercer discount); states; nothing enqueued or sent', async () => {
  const h = await breach();
  const r = await build(h);
  assert.deepEqual(r.approval.newPermissions.map((g: any) => g.kind).sort(), ['COLLECT_SLICE', 'CONTACT_SPACING', 'DISCOUNT_OFFER', 'MESSAGE_AS_WRITTEN', 'PAYOUT_AUTHORITY', 'PAYOUT_EXCEPTION']);
  // Each permission explains itself: why, the rule and what approving does now.
  const perm = (k: string) => r.approval.newPermissions.find((g: any) => g.kind === k);
  assert.match(perm('CONTACT_SPACING').why, /^Last contacted .*every 4 business days.*one-time approval; the rule stays as it is/);
  assert.match(perm('DISCOUNT_OFFER').why, /every early-payment offer come to you/);
  assert.match(perm('DISCOUNT_OFFER').effect, /^Nothing is sent now\. At Wed, Nov 11, 09:00 Headroom checks verified funds/);
  assert.match(perm('COLLECT_SLICE').why, /dispute/);
  assert.match(perm('PAYOUT_EXCEPTION').why, /\$10,000\.00 payment plus up to \$200\.00 PayPal fee allowance .* per-payment limit and your \$6,000\.00 daily limit/);
  assert.ok(r.approval.newPermissions.every((g: any) => g.policy.startsWith('Delegation v1')));
  const creates = h.pp.count('CREATE');
  const ok = await approve(h, r);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.grants.length, 6);
  const r2 = await rev(h);
  // S6: an approved payout is SCHEDULED for its PAY job (it was HELD "payouts in a later build" in S4).
  assert.deepEqual(r2.actions.map((a: any) => a.state), ['SCHEDULED', 'SCHEDULED', 'WAITING_CONDITION', 'SCHEDULED']);
  assert.match(act(r2, 'COLLECT_OVERDUE').authorityTag.text, /^Approved by you/);
  assert.equal(act(r2, 'DISCOUNT_FALLBACK').authority.policyVersion, 1);
  assert.deepEqual(act(r2, 'DISCOUNT_FALLBACK').grants.map((g: any) => [g.kind, g.state]), [['DISCOUNT_OFFER', 'ACTIVE']], 'approved for later; nothing sent now');
  assert.equal(h.pp.count('CREATE'), creates, 'nothing sent or paid');
  assert.equal(h.queue.pending.length, 0);
  const d = (await h.api('GET', '/v1/delegation')).body;
  assert.equal(d.grants.filter((g: any) => g.state === 'ACTIVE').length, 6);
  assert.ok(d.grants.some((g: any) => g.kind === 'BILL_VERIFY' && !g.revocable) && d.grants.some((g: any) => g.kind === 'TERMS_ACCEPT'));
  assert.equal((await approve(h, r)).body.code, 'VERSION_CONFLICT', 'replaying the old dialog does nothing');
});

test('S4-R11/R12 (PR-01) stale consent: a different selection, a stale hash, a new obligation after the dialog opened, a write between recompute and commit', async () => {
  const h = await breach();
  const r = await build(h);
  assert.equal((await approve(h, r, { selected: r.approval.selected.slice(1), consentHash: r.approval.consentHash })).body.code, 'CONSENT_CHANGED');
  assert.equal((await approve(h, r, { selected: r.approval.selected, consentHash: 'x' })).body.code, 'CONSENT_CHANGED');
  const c = await h.api('POST', '/v1/commitments', { name: 'Van repair', amount: { currency: 'USD', minor: 30_000 }, on: addDays(h.day0(), 20), recurrence: 'NONE', estimate: false, protected: false });
  assert.equal(c.status, 201);
  const stale = await approve(h, r);
  assert.deepEqual([stale.status, stale.body.code], [409, 'CONSENT_CHANGED']);
  assert.match(stale.body.message, /cash picture changed/);
  assert.equal((await plan(h)).banner, 'Your cash picture changed since revision 1 was built');
  // A source write that lands after the server recomputed consent but before commit: the PLAN stamp condition refuses it.
  const h2 = await breach();
  const r2 = await build(h2);
  let fired = false;
  h2.store.beforeTransact = async (ops) => {
    if (fired || !ops.some((o) => o.op === 'put' && String((o as any).item?.sk).startsWith('APPROVAL#'))) return;
    fired = true; h2.store.beforeTransact = undefined;
    await h2.store.transact([{ op: 'update', table: 'core', pk: K.run('tenant-a', h2.run!.runId), sk: 'PLAN', add: { basisStamp: 1 } }]);
  };
  const raced = await approve(h2, r2);
  assert.deepEqual([raced.status, raced.body.code], [409, 'CONSENT_CHANGED']);
  assert.equal((await grantsIn(h2)).length, 0, 'nothing applied');
});

test('S4-R5 concurrent approve → exactly one applies; one grant set', async () => {
  const h = await breach();
  const r = await build(h);
  const res = await Promise.all([approve(h, r), approve(h, r)]);
  assert.deepEqual(res.map((x) => x.status).sort(), [200, 409]);
  assert.equal((await grantsIn(h)).length, 6);
});

test('S4-R16 (PR-02) approve → revoke → reapprove; edit a granted term → its grants lapse → reapprove; retries replay; others untouched', async () => {
  const h = await breach();
  let r = await build(h);
  await approve(h, r);
  r = await rev(h);
  const harrow = act(r, 'COLLECT_UNDISPUTED_SLICE');
  const msgGrant = harrow.grants.find((g: any) => g.kind === 'MESSAGE_AS_WRITTEN');
  const rv = await h.api('POST', `/v1/grants/${encodeURIComponent(msgGrant.grantId)}/revoke`, { reason: 'test' });
  assert.equal(rv.status, 200, JSON.stringify(rv.body));
  r = await rev(h);
  assert.deepEqual([act(r, 'COLLECT_UNDISPUTED_SLICE').state, act(r, 'COLLECT_UNDISPUTED_SLICE').needsApproval, r.pill], ['PROPOSED', true, 'REVISION NEEDS REVIEW']);
  assert.ok((await h.overview()).needs.some((n: any) => /Harrow .* needs your approval again/.test(n.title)));
  assert.deepEqual([r.approval.mode, r.approval.selected.length, r.approval.newPermissions.map((g: any) => g.kind)], ['REAPPROVE', 1, ['MESSAGE_AS_WRITTEN']]);
  const before = (await grantsIn(h)).filter((g) => g.state === 'ACTIVE').map((g) => g.grantId).sort();
  const key = { 'if-match': String(r.version), 'idempotency-key': 'reapprove-1' };
  const body = { selected: r.approval.selected, consentHash: r.approval.consentHash };
  const ok = await h.api('POST', `/v1/plan/revisions/${r.revisionId}/approve`, body, key);
  const replay = await h.api('POST', `/v1/plan/revisions/${r.revisionId}/approve`, body, key);
  assert.deepEqual([ok.status, ok.body.grants.length, replay.body.approval], [200, 1, ok.body.approval]);
  const all = await grantsIn(h);
  assert.equal(all.filter((g) => g.state === 'REVOKED').length, 1, 'the revoked row is kept');
  assert.deepEqual(all.filter((g) => g.state === 'ACTIVE' && before.includes(g.grantId)).map((g) => g.grantId).sort(), before, 'others unchanged');
  r = await rev(h);
  assert.equal(r.state, 'RUNNING');
  const e = await edit(h, r, { op: 'EDIT_ACTION', actionId: act(r, 'COLLECT_UNDISPUTED_SLICE').actionId, actionVersion: act(r, 'COLLECT_UNDISPUTED_SLICE').version, changes: { amountMinor: 700_000 } });
  assert.equal(e.status, 200, JSON.stringify(e.body));
  assert.equal(e.body.state, 'PROPOSED');
  assert.equal((await grantsIn(h)).filter((g) => g.state === 'LAPSED').length, 2);
  r = await rev(h);
  assert.equal((await approve(h, r)).body.grants.length, 2);
  assert.equal((await approve(h, await rev(h))).body.code, 'NOTHING_SELECTED');
});

test('S4-R15/R6 running edits: Pellow date inside delegation stays scheduled; Mercer 5% → exception, needs approval', async () => {
  const h = await breach();
  let r = await build(h);
  await approve(h, r);
  r = await rev(h);
  const p = act(r, 'COLLECT_OVERDUE');
  // S7-UX1: Pellow was last reminded Fri (day −1 business day); his rule allows the next contact Thu (day +3). Moving the ask to Thu
  // needs no exception any more (the early-contact permission lapses with the old terms); moving it back inside the rule needs it again.
  const e = await edit(h, r, { op: 'EDIT_ACTION', actionId: p.actionId, actionVersion: p.version, changes: { contactOn: addDays(h.day0(), 3), targetOn: addDays(h.day0(), 4) } });
  assert.equal(e.status, 200, JSON.stringify(e.body));
  assert.deepEqual([e.body.state, e.body.notes[0]], ['SCHEDULED', 'Still within your delegation · no new approval']);
  r = await rev(h);
  const p2 = act(r, 'COLLECT_OVERDUE');
  const back = await edit(h, r, { op: 'EDIT_ACTION', actionId: p2.actionId, actionVersion: p2.version, changes: { contactOn: addDays(h.day0(), 1) } });
  assert.equal(back.body.state, 'PROPOSED');
  assert.match(back.body.notes[0], /^Needs your approval · Last contacted Fri, Nov 6: .*next is Thu, Nov 12/);
  r = await rev(h);
  const m = act(r, 'DISCOUNT_FALLBACK');
  const e2 = await edit(h, r, { op: 'EDIT_ACTION', actionId: m.actionId, actionVersion: m.version, changes: { discountBp: 500 } });
  assert.equal(e2.body.state, 'PROPOSED');
  assert.match(e2.body.notes[0], /Exception · 5% = \$225\.00 is above '2% or \$300\.00, whichever is smaller' · New approval required/);
  r = await rev(h);
  assert.deepEqual(r.approval.newPermissions.map((g: any) => g.kind).sort(), ['CONTACT_SPACING', 'DISCOUNT_OFFER']);
  const bad = await edit(h, r, { op: 'EDIT_ACTION', actionId: act(r, 'PAYOUT').actionId, actionVersion: act(r, 'PAYOUT').version, changes: { contactOn: addDays(h.day0(), 1) } });
  assert.equal(bad.body.code, 'INVALID_INPUT');
  const past = await edit(h, r, { op: 'EDIT_ACTION', actionId: act(r, 'COLLECT_OVERDUE').actionId, actionVersion: act(r, 'COLLECT_OVERDUE').version, changes: { contactOn: addDays(h.day0(), -3) } });
  assert.equal(past.body.code, 'INVALID_INPUT', 'S4-PR-05: no contact in the past');
});

test('S4-PR-04 running removal: remove a scheduled collection and a waiting fallback → grants lapse → restore → reapprove', async () => {
  const h = await breach();
  let r = await build(h);
  await approve(h, r);
  r = await rev(h);
  const harrow = act(r, 'COLLECT_UNDISPUTED_SLICE');
  const rm = await edit(h, r, { op: 'REMOVE', actionId: harrow.actionId, actionVersion: harrow.version, reason: 'Talk first' });
  assert.equal(rm.status, 200, JSON.stringify(rm.body));
  assert.match(rm.body.notes[0], /never counted in Expected/);
  r = await rev(h);
  const m = act(r, 'DISCOUNT_FALLBACK');
  assert.equal((await edit(h, r, { op: 'REMOVE', actionId: m.actionId, actionVersion: m.version })).status, 200);
  r = await rev(h);
  assert.deepEqual(r.removed.map((a: any) => a.state), ['REMOVED', 'REMOVED']);
  assert.equal((await grantsIn(h)).filter((g) => g.state === 'LAPSED').length, 3, 'Harrow grants and the Mercer discount approval lapse');
  const h1 = r.removed.find((a: any) => a.kind === 'COLLECT_UNDISPUTED_SLICE');
  assert.equal((await edit(h, r, { op: 'RESTORE', actionId: h1.actionId, actionVersion: h1.version })).body.state, 'PROPOSED');
  r = await rev(h);
  assert.deepEqual(r.approval.newPermissions.map((g: any) => g.kind).sort(), ['COLLECT_SLICE', 'MESSAGE_AS_WRITTEN']);
  assert.equal((await approve(h, r)).status, 200);
});

test('S4-A2 reject: the draft is rejected; the running revision, its actions and grants are untouched', async () => {
  const h = await breach();
  let r = await build(h);
  await approve(h, r);
  const r1 = r.revisionId;
  const running = async () => JSON.stringify([await grantsIn(h), (await h.api('GET', `/v1/plan/revisions/${r1}`)).body.actions.map((a: any) => [a.actionId, a.state, a.version])]);
  await h.api('POST', '/v1/commitments', { name: 'Van repair', amount: { currency: 'USD', minor: 30_000 }, on: addDays(h.day0(), 20), recurrence: 'NONE', estimate: false, protected: false });
  const p = await plan(h);
  // UX repair (F01): revision 1 still closes the gap, so nothing builds or nags; the owner can still ask for a new revision.
  assert.deepEqual([p.state, p.banner, p.revision.revisionId, p.revision.header.coverage.state], ['READY', null, r1, 'COVERED']);
  r = await build(h);
  // S7 R6: + the optional Keller ask (considered, unchanged between revisions).
  assert.deepEqual([r.n, r.state, r.diff.filter((d: any) => d.change === 'UNCHANGED').length], [2, 'DRAFT', 5]);
  // S5: approved work now runs (Harrow's slice may already be APPLIED). The claim is that the reject itself touches nothing.
  const before = await running();
  const rj = await h.api('POST', `/v1/plan/revisions/${r.revisionId}/reject`, { reason: 'not now' }, { 'if-match': String(r.version) });
  assert.equal(rj.status, 200, JSON.stringify(rj.body));
  const after = await plan(h);
  assert.equal(after.revision.n, 1);
  assert.match(after.reason, /You rejected revision 2/);
  assert.equal(await running(), before);
  assert.equal(after.revision.revisionId, r1);
  const again = await h.api('POST', '/v1/plan/revisions', { retry: { buildId: after.build.buildId, generation: after.build.generation } });
  assert.equal(again.status, 202, 'Build again after a rejection');
  await h.drain();
  assert.equal((await plan(h)).proposed.n, 3, 'the new draft sits beside the running revision 1');
});

test('S4-PR-08 failed build: retry by generation runs once; double retry is one; a stale basis ends STALE', async () => {
  let fault: string | null = 'Invoice records unreadable (test fault)';
  const h = await breach({ hooks: { planBuildFault: () => fault } });
  await h.api('POST', '/v1/plan/revisions', {});
  await h.drain();
  let p = await plan(h);
  assert.deepEqual([p.state, p.build.failure.kind, p.build.retryable], ['FAILED', 'DATA', true]);
  fault = null;
  const retry = { retry: { buildId: p.build.buildId, generation: p.build.generation } };
  const [a, b] = await Promise.all([h.api('POST', '/v1/plan/revisions', retry), h.api('POST', '/v1/plan/revisions', retry)]);
  assert.deepEqual([a.status, b.status].sort(), [200, 202]);
  await h.drain();
  p = await plan(h);
  assert.deepEqual([p.state, p.build.generation, p.revision.n], ['READY', 2, 1]);
  const item = (await h.store.query('core', K.run('tenant-a', h.run!.runId), { skPrefix: 'BUILD#' }))[0];
  assert.equal(item.attempts.length, 1, 'the failed attempt is kept');
  let h2!: H;
  h2 = await breach({ hooks: { beforePlanPublish: async () => { await h2.store.transact([{ op: 'update', table: 'core', pk: K.run('tenant-a', h2.run!.runId), sk: 'PLAN', add: { basisStamp: 1 } }]); } } });
  await h2.api('POST', '/v1/plan/revisions', {});
  await h2.drain();
  const p2 = await plan(h2);
  assert.deepEqual([p2.state, p2.build.failure.kind], ['FAILED', 'STALE']);
});

test('S4-R13/R14 no PayPal report → no build, "Cash impact unknown"; no breach → NOTHING_TO_PLAN', async () => {
  const h = await harness({ plaid: true, hero: true, paypalMinor: 180_000, start: MON_10AM, noPayPalReport: true });
  await h.drain();
  assert.match((await plan(h)).reason, /^Cash impact unknown/);
  assert.equal((await h.api('POST', '/v1/plan/revisions', {})).body.code, 'CASH_IMPACT_UNKNOWN');
  const h2 = await harness({ plaid: true, hero: true, paypalMinor: 180_000, start: MON_10AM });
  await h2.drain();
  assert.deepEqual([(await plan(h2)).state, (await plan(h2)).reason], ['NO_PLAN_NEEDED', 'No plan needed · Forecast above reserve under stated assumptions']);
  assert.equal((await h2.api('POST', '/v1/plan/revisions', {})).body.code, 'NOTHING_TO_PLAN');
});

test('S4-R17/R22/R26 bill records not revocable; disputed amount never askable; other tenants get NOT_FOUND', async () => {
  const h = await breach();
  const r = await build(h);
  const d = (await h.api('GET', '/v1/delegation')).body;
  const rec = d.grants.find((g: any) => g.kind === 'BILL_VERIFY');
  assert.equal((await h.api('POST', `/v1/grants/${encodeURIComponent(rec.grantId)}/revoke`, {})).body.code, 'NOT_EDITABLE');
  assert.ok(r.considered.filter((c: any) => /disputed/.test(c.title)).every((c: any) => !c.canAsk && c.actionId === null));
  const b = { identity: OWNER_B };
  assert.equal((await h.api('GET', `/v1/plan/revisions/${r.revisionId}`, undefined, {}, b.identity)).status, 404);
  assert.equal((await h.api('POST', `/v1/plan/revisions/${r.revisionId}/approve`, { selected: [], consentHash: 'x' }, { 'if-match': '1' }, b.identity)).status, 404);
  assert.equal((await h.api('GET', '/v1/relationships/cust-pellow', undefined, {}, b.identity)).status, 404);
});

test('S4-R19/R20/R21 delegation: preview = save; bounds; stale preview; Payables limit keeps the daily reason; pause banner; approve while paused', async () => {
  const h = await breach();
  const r = await build(h);
  const ch = { key: 'ap.paymentLimitMinor', scope: 'PAYABLES', value: 1_500_000 };
  const pv = await h.api('POST', '/v1/delegation/preview', ch);
  assert.equal(pv.status, 200, JSON.stringify(pv.body));
  assert.equal(pv.body.loosens, true);
  assert.match(pv.body.affected[0].after, /No longer: The \$10,000\.00 payment plus up to \$200\.00 PayPal fee allowance \(\$10,200\.00\) is above your \$5,000\.00 per-payment limit/);
  assert.match(pv.body.affected[0].after, /still needs payout authority and an exception/);
  assert.equal((await h.api('POST', '/v1/delegation/preview', { key: 'comms.contactEveryBd', scope: 'EVERYWHERE', value: 0 })).body.code, 'INVALID_INPUT');
  assert.equal((await h.api('POST', '/v1/delegation/preview', { key: 'ap.dailyLimitMinor', scope: 'PAYABLES', value: 1 })).body.code, 'NOT_EDITABLE');
  assert.equal((await h.api('POST', '/v1/delegation/preview', { key: 'ap.dailyLimitMinor', scope: 'EVERYWHERE', value: -1 })).body.code, 'INVALID_INPUT');
  assert.equal((await h.api('POST', '/v1/delegation/rules', { ...ch, previewHash: 'stale' }, { 'if-match': '1' })).body.code, 'CONSENT_CHANGED');
  const saved = await h.api('POST', '/v1/delegation/rules', { ...ch, previewHash: pv.body.previewHash }, { 'if-match': '1' });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal((await approve(h, r)).body.code, 'CONSENT_CHANGED', 'a rule change invalidates the open dialog');
  const p = await plan(h);
  const keller = act(p.revision, 'PAYOUT');
  assert.ok(keller.authorityNow.reasons.some((x: string) => /daily limit/.test(x)) && !keller.authorityNow.reasons.some((x: string) => /per-payment/.test(x)));
  const pause = await h.api('POST', '/v1/delegation/pauses', { kind: 'PAYMENTS', on: true }, { 'if-match': '2' });
  assert.equal(pause.status, 200, JSON.stringify(pause.body));
  assert.deepEqual((await h.api('GET', '/v1/session')).body.pauses, { outreach: false, payments: true });
  const r2 = await build(h);
  assert.equal(act(r2, 'PAYOUT').paused, "Paused · won't run while 'Pause all payment preparation' is on");
  assert.equal((await approve(h, r2)).status, 200, 'approving while paused is allowed');
});

test('S4 relationships: labels from SEEDED history; record shows factors and treatment', async () => {
  const h = await breach();
  await build(h);
  const rows = (await h.api('GET', '/v1/relationships')).body.rows;
  const by = Object.fromEntries(rows.map((x: any) => [x.id, x]));
  assert.deepEqual([by['cust-mercer'].label, by['cust-pellow'].label, by['cust-harrow'].label, by['cust-alder'].label, by['cust-birch'].label], ['Strong', 'Good', 'At risk', 'Mixed', 'Not enough history']);
  assert.ok(by['cust-pellow'].activeWork.length === 1 && by['cust-pellow'].receivable.minor === 760_000);
  const rec = (await h.api('GET', '/v1/relationships/cust-harrow')).body;
  assert.ok(rec.factors.some((f: any) => f.factor === 'Open disputes'));
  assert.ok(rec.treatment.some((t: any) => /review first/.test(t.text)));
});

test('S4 forecast scenarios and comparisons through the query string: Ideal, Downside, before-bill, proposal; unknown compare → NOT_FOUND', async () => {
  const h = await breach();
  const r = await build(h);
  const { handle } = await import('../../backend/src/handlers/router.ts');
  const q = async (query: Record<string, string>) => JSON.parse((await handle({ store: h.store, queue: h.queue, config: h.deps.config, now: h.clock, evidence: h.evidence }, { method: 'GET', path: '/v1/cash/forecast', query, headers: {}, body: undefined, identity: { sub: 'owner-a', email: 'owner-a@example.com' } })).body);
  const ideal = await q({ scenario: 'IDEAL' });
  assert.deepEqual([ideal.scenario, ideal.summary.low.minor], ['IDEAL', 974_250]);
  assert.match(ideal.scenarioBasis, /Likelihood: not assessed/);
  const down = await q({ scenario: 'DOWNSIDE' });
  assert.equal(down.days.flatMap((d: any) => d.items).some((i: any) => i.basis === 'STATED'), false);
  const exp = await q({});
  assert.ok(exp.comparisons.some((c: any) => c.kind === 'BEFORE_BILL' && c.summary.firstBelowReserve === null));
  const prop = exp.comparisons.filter((c: any) => c.kind === 'PROPOSAL');
  assert.ok(prop.length >= 5 && prop.every((c: any) => c.revisionId === r.revisionId));
  assert.equal((await q({ compare: prop[0].id })).compare, prop[0].id);
  assert.equal((await q({ compare: 'rev:nope' })).code, 'NOT_FOUND');
  assert.equal((await q({ scenario: 'LIKELY' })).code, 'INVALID_INPUT');
});

test('S4-R24 (S4-D17) exact-match bill: Delegation on → verified by Headroom with allowedBy; payment details differ → held as S3; rule off → stays proposed', async () => {
  const { pdf } = await import('../../scripts/demo/bill-pdf.ts');
  const long = (d: string) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' }).format(new Date(`${d}T00:00:00Z`));
  const exact = (h: H, no: string, last4 = '4417') => pdf({ lines: ['Keller Drafting Co.', `INVOICE ${no}`, 'Reference: MS-2', `Payment due: ${long(addDays(h.day0(), 24))}`, 'Amount due USD $10,000.00', `Remit to account ending ${last4}`] });
  const h = await harness({ plaid: true, hero: true, paypalMinor: 180_000, start: MON_10AM });
  await h.drain();
  const f0 = await h.forecast();
  const b = await h.bill((await h.inject('hero', { bytes: exact(h, 'K-4001') })).billId);
  assert.deepEqual([b.bill.state, b.classification, b.verification?.by, b.flags, b.holdReasons], ['VERIFIED', 'EXACT_MATCH', 'HEADROOM', [], []]);
  const v = await h.store.get('core', K.run('tenant-a', h.run!.runId), `VERIFY#${b.bill.billId}`);
  assert.match(v!.allowedBy, /^Delegation v1 · Bills exactly matching a planned cost$/);
  assert.deepEqual((await h.forecast()).days.map((x: any) => x.close.minor), f0.days.map((x: any) => x.close.minor), 'nothing changes in the forecast');
  assert.equal(h.pp.count('CREATE'), 3, 'no payment or provider write beyond the hero invoices');
  const held = await h.bill((await h.inject('hero', { bytes: exact(h, 'K-4002', '9999') })).billId);
  assert.equal(held.bill.state, 'HELD');
  const h2 = await harness({ plaid: true, hero: true, paypalMinor: 180_000, start: MON_10AM });
  await h2.drain();
  const pk = K.run('tenant-a', h2.run!.runId);
  const pol = (await h2.store.get('core', pk, 'POLICY'))!;
  await h2.store.transact([{ op: 'update', table: 'core', pk, sk: 'POLICY', set: { rules: pol.rules.map((r: any) => (r.key === 'ap.exactMatchBills' ? { ...r, everywhere: 'ALWAYS_ASK' } : r)) } }]);
  assert.equal((await h2.bill((await h2.inject('hero', { bytes: exact(h2, 'K-4003') })).billId)).bill.state, 'PROPOSED');
});
