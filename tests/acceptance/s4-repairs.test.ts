// S4 implementation-review repairs (S04 §11, S4-IM-01…07): each finding's counterexample through the real router, worker and store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.ts';
import { goodDrafter, goodPlanner, FakeRole } from './fake-planner.ts';
import { K } from '../../backend/src/adapters/store/keys.ts';
import { addDays } from '../../backend/src/domain/time.ts';

const MON_10AM = '2026-11-09T15:00:00.000Z';
type H = Awaited<ReturnType<typeof harness>>;
async function breach(o: Parameters<typeof harness>[0] = {}, before?: (h: H) => Promise<void>): Promise<H> {
  const h = await harness({ plaid: true, hero: true, paypalMinor: 180_000, start: MON_10AM, ...o });
  await h.drain();
  await before?.(h);
  const inj = await h.inject('hero');
  let b = await h.bill(inj.billId);
  await h.api('POST', `/v1/bills/${b.bill.billId}/verify`, { occurrenceKey: b.occurrence.occurrenceKey, occurrenceVersion: b.occurrence.version }, { 'if-match': String(b.bill.version) });
  b = await h.bill(inj.billId);
  await h.api('POST', `/v1/bills/${b.bill.billId}/accept-terms`, { termsHash: b.termsHash, changedFields: b.changedFields }, { 'if-match': String(b.bill.version) });
  return h;
}
const plan = async (h: H) => (await h.api('GET', '/v1/plan')).body;
const rev = async (h: H) => (await plan(h)).revision;
async function build(h: H) { await h.api('POST', '/v1/plan/revisions', {}); await h.drain(); return rev(h); }
const act = (r: any, kind: string) => [...r.actions, ...r.removed].find((a: any) => a.kind === kind);
const edit = (h: H, r: any, body: any) => h.api('POST', `/v1/plan/revisions/${r.revisionId}/edit`, body, { 'if-match': String(r.version) });
const approve = (h: H, r: any, key?: string) => h.api('POST', `/v1/plan/revisions/${r.revisionId}/approve`, { selected: r.approval.selected, consentHash: r.approval.consentHash }, { 'if-match': String(r.version), ...(key ? { 'idempotency-key': key } : {}) });
const grants = (h: H) => h.store.query('core', K.run('tenant-a', h.run!.runId), { skPrefix: 'GRANT#' });

test('S4-IM-01 a term edit re-renders the message, Why and grant scope; owner wording never silently survives a term change', async () => {
  const h = await breach({ planner: goodPlanner(), drafter: goodDrafter() });
  let r = await build(h);
  const m = act(r, 'DISCOUNT_FALLBACK');
  assert.equal((await edit(h, r, { op: 'EDIT_ACTION', actionId: m.actionId, actionVersion: m.version, changes: { discountBp: 500 } })).status, 200);
  r = await rev(h);
  const m2 = act(r, 'DISCOUNT_FALLBACK');
  assert.match(m2.message.body, /you can pay \$4,275\.00 instead \(5% off, \$225\.00\)/);
  assert.doesNotMatch(m2.message.body, /\$4,410|2% off|\$90\.00/);
  assert.match(m2.message.subject, /save \$225\.00/);
  assert.match(m2.message.body, /^Dear Mercer Architects team,/, 'the chosen greeting is kept');
  assert.doesNotMatch(m2.why.text, /\$90\.00|\$4,410/);
  assert.match(m2.why.text, /Mercer Architects’ payment record/);
  const s = act(r, 'COLLECT_UNDISPUTED_SLICE');
  const target = addDays(h.day0(), 4);
  assert.equal((await edit(h, r, { op: 'EDIT_ACTION', actionId: s.actionId, actionVersion: s.version, changes: { amountMinor: 100_000, targetOn: target } })).status, 200);
  r = await rev(h);
  const s2 = act(r, 'COLLECT_UNDISPUTED_SLICE');
  assert.match(s2.message.body, /Could you pay \$1,000\.00 of that confirmed part by Fri, Nov 13\?/);
  const ok = await approve(h, r);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.ok(ok.body.grants.some((g: any) => g.kind === 'DISCOUNT_OFFER' && /5% \(\$225\.00\) to pay \$4,275\.00/.test(g.scope)));
  // Owner wording, then a term change: replaced and flagged, never approved silently.
  r = await rev(h);
  const p = act(r, 'COLLECT_OVERDUE');
  await edit(h, r, { op: 'EDIT_ACTION', actionId: p.actionId, actionVersion: p.version, changes: { message: { subject: 'Hi', body: 'Please pay the $7,600 by Thursday. Thanks!' } } });
  r = await rev(h);
  const p2 = act(r, 'COLLECT_OVERDUE');
  const res = await edit(h, r, { op: 'EDIT_ACTION', actionId: p2.actionId, actionVersion: p2.version, changes: { targetOn: addDays(h.day0(), 2) } });
  assert.ok(res.body.notes.some((n: string) => /Your own wording was written for the old terms/.test(n)));
  const p3 = act(await rev(h), 'COLLECT_OVERDUE');
  assert.equal(p3.message.writtenBy, 'TEMPLATE');
  assert.match(p3.message.body, /by Wed, Nov 11\?/);
});

test('S4-IM-02 four $90 offers exceed the $300 total: every offer is an exception; removing one brings the rest back within delegation', async () => {
  const h = await breach({}, async (x) => {
    for (const n of [20, 21, 22]) {
      const d = await x.api('POST', '/v1/invoices', { customerId: 'cust-mercer', amount: { currency: 'USD', minor: 450_000 }, dueOn: addDays(x.day0(), n) });
      await x.api('POST', `/v1/invoices/${d.body.invoice.invoiceId}/send`, undefined, { 'if-match': '1' });
    }
    await x.drain();
  });
  let r = await build(h);
  const offers = () => r.actions.filter((a: any) => a.kind === 'DISCOUNT_FALLBACK');
  assert.equal(offers().length, 4);
  assert.ok(offers().every((a: any) => a.authority.decision === 'EXCEPTION' && a.authority.grantKinds.includes('DISCOUNT_OFFER')), JSON.stringify(offers().map((a: any) => a.authority.reasons)));
  assert.equal(r.approval.newPermissions.filter((g: any) => g.kind === 'DISCOUNT_OFFER').length, 4);
  const first = offers()[0];
  const rm = await edit(h, r, { op: 'REMOVE', actionId: first.actionId, actionVersion: first.version });
  assert.equal(rm.status, 200, JSON.stringify(rm.body));
  r = await rev(h);
  // S7-UX2: within the $300 total each offer still comes to the owner (seeded 'every offer needs you'); no longer an exception.
  assert.deepEqual(offers().map((a: any) => a.authority.decision), ['REQUIRES_APPROVAL', 'REQUIRES_APPROVAL', 'REQUIRES_APPROVAL'], '$270 is within the $300 total');
  const restored = r.removed.find((a: any) => a.kind === 'DISCOUNT_FALLBACK');
  await edit(h, r, { op: 'RESTORE', actionId: restored.actionId, actionVersion: restored.version });
  r = await rev(h);
  assert.ok(offers().every((a: any) => a.authority.decision === 'EXCEPTION'));
});

test('S4-IM-04 the headline follows the included actions: all collections removed → not covered; only Pellow → later gap; all → covered', async () => {
  const h = await breach();
  let r = await build(h);
  assert.equal(r.header.coverage.state, 'COVERED');
  const p = act(r, 'COLLECT_OVERDUE');
  await edit(h, r, { op: 'REMOVE', actionId: p.actionId, actionVersion: p.version });
  r = await rev(h);
  assert.equal(r.header.coverage.state, 'LATER_GAP', 'Harrow alone covers Nov 13 but not Nov 20');
  assert.match(r.header.coverage.text, /Fri, Nov 13 is covered, but cash falls to \$2,408\.23 on Fri, Nov 20/);
  for (const k of ['COLLECT_UNDISPUTED_SLICE', 'DISCOUNT_FALLBACK']) { const a = act(r, k); await edit(h, r, { op: 'REMOVE', actionId: a.actionId, actionVersion: a.version }); r = await rev(h); }
  assert.equal(r.header.coverage.state, 'NOT_COVERED');
  assert.doesNotMatch(r.header.coverage.text, /covers it/);
});

test('S4-IM-05 an expired grant: the scheduled action needs renewal, is selectable, and one concurrent renewal records exactly one grant', async () => {
  const h = await breach();
  let r = await build(h);
  await approve(h, r);
  const pk = K.run('tenant-a', h.run!.runId);
  const g = (await grants(h)).find((x) => x.kind === 'MESSAGE_AS_WRITTEN')!;
  await h.store.transact([{ op: 'update', table: 'core', pk, sk: g.sk, set: { expiresAt: '2026-11-09T14:00:00.000Z' } }]);
  r = await rev(h);
  const harrow = act(r, 'COLLECT_UNDISPUTED_SLICE');
  assert.deepEqual([harrow.state, harrow.needsApproval, harrow.authorityTag.tone], ['SCHEDULED', true, 'NEEDS_YOU']);
  assert.match(harrow.stateText, /Approval expired/);
  assert.equal(r.pill, 'REVISION NEEDS REVIEW');
  assert.deepEqual([r.approval.mode, r.approval.selected, r.approval.newPermissions.map((x: any) => x.kind)], ['REAPPROVE', [harrow.actionId], ['MESSAGE_AS_WRITTEN']]);
  assert.ok((await h.overview()).needs.some((n: any) => /Its permission expired/.test(n.reason)));
  assert.ok((await plan(h)).validUntil, 'the page re-reads at the next expiry or business midnight');
  const rs = await Promise.all([approve(h, r), approve(h, r)]);
  assert.deepEqual(rs.map((x) => x.status).sort(), [200, 409]);
  assert.equal((await grants(h)).filter((x) => x.kind === 'MESSAGE_AS_WRITTEN' && x.state === 'ACTIVE' && x.expiresAt > '2026-11-10').length, 1);
  assert.equal(act(await rev(h), 'COLLECT_UNDISPUTED_SLICE').needsApproval, false);
});

test('S4-IM-06 a $7,200 capture on Harrow (real S1 reconciliation): the remaining $1,800 is never proposed as undisputed', async () => {
  const h = await breach({}, async (x) => {
    const inv = (await x.store.query('core', K.run('tenant-a', x.run!.runId), { skPrefix: 'INV#' })).find((i) => i.customerId === 'cust-harrow')!;
    x.pp.pay(inv.ppInvoiceId, { grossMinor: 720_000, feeMinor: 25_177 });
    await x.api('POST', `/v1/invoices/${inv.invoiceId}/refresh`);
    await x.drain();
    assert.equal((await x.invoice(inv.invoiceId)).invoice.open.minor, 180_000);
  });
  const r = await build(h);
  assert.ok(!act(r, 'COLLECT_UNDISPUTED_SLICE'), 'no undisputed slice once the undisputed part is paid');
  // S5-D3 (C2): the $7,200 capture is now allocated to the undisputed part, so the reason is proven, not "can't tell".
  assert.ok(r.considered.some((c: any) => /undisputed part is paid/.test(c.reason)));
  assert.ok(r.considered.some((c: any) => /never collects disputed/.test(c.reason)));
});

test('S4-IM-07 a one-cent request is refused before anything is saved; Plan stays readable; the smallest positive-net request is accepted', async () => {
  const h = await breach();
  let r = await build(h);
  const s = act(r, 'COLLECT_UNDISPUTED_SLICE');
  const bad = await edit(h, r, { op: 'EDIT_ACTION', actionId: s.actionId, actionVersion: s.version, changes: { amountMinor: 1 } });
  assert.deepEqual([bad.status, bad.body.code], [400, 'INVALID_INPUT']);
  const p = await h.api('GET', '/v1/plan');
  assert.equal(p.status, 200);
  assert.equal(act(p.body.revision, 'COLLECT_UNDISPUTED_SLICE').version, s.version, 'unchanged');
  assert.equal((await edit(h, r, { op: 'EDIT_ACTION', actionId: s.actionId, actionVersion: s.version, changes: { amountMinor: 51 } })).body.code, 'INVALID_INPUT', 'nets zero');
  r = await rev(h);
  const ok = await edit(h, r, { op: 'EDIT_ACTION', actionId: s.actionId, actionVersion: s.version, changes: { amountMinor: 52 } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(act(await rev(h), 'COLLECT_UNDISPUTED_SLICE').estimate.net.minor, 1);
});

test('S4-IM-03 (integrated) a drafter claiming debt cancellation or a received transfer is refused twice → Headroom wording; nothing approvable carries it', async () => {
  const lie = () => ({ drafts: [] as any[] });
  const drafter = new FakeRole((x: any) => ({ ...lie(), drafts: x.drafts.map((d: any) => ({ candidateId: d.candidateId, opening: 'Your debt is erased.', closing: 'Our records show your transfer arrived.' })) }));
  const h = await breach({ drafter });
  const r = await build(h);
  assert.equal(drafter.calls.length, 2);
  for (const a of r.actions.filter((x: any) => x.message)) { assert.equal(a.message.writtenBy, 'TEMPLATE'); assert.doesNotMatch(a.message.body, /erased|transfer arrived/); }
});
