// S3 implementation-review repairs (S03 §11, findings S3-IM-01…06): each finding's acceptance criteria.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.ts';
import { K } from '../../backend/src/adapters/store/keys.ts';
import { SimulatedCrash } from '../../backend/src/deps.ts';
import { addDays } from '../../backend/src/domain/time.ts';
import { pdf } from '../../scripts/demo/bill-pdf.ts';

const hero = (o: Parameters<typeof harness>[0] = {}) => harness({ plaid: true, hero: true, paypalMinor: 180_000, ...o });
const long = (d: string) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' }).format(new Date(`${d}T00:00:00Z`));
/** A Keller bill with chosen number, due offset, total and reference (fictional sample). */
const keller = (h: any, no: string, dueOffset: number, total: string, ref: string | null = null, extra: string[] = []) =>
  pdf({ lines: ['Keller Drafting Co.', `INVOICE ${no}`, ...(ref ? [`Reference: ${ref}`] : []), `Payment due: ${long(addDays(h.day0(), dueOffset))}`, `Amount due ${total}`, 'Remit to account ending 4417', ...extra] });
const runOf = (id: string) => `run-${id.split('_')[1]}`;
const outflows = (f: any, re: RegExp) => f.days.flatMap((d: any) => d.items).filter((i: any) => i.direction === 'OUT' && re.test(i.label));
const verify = (h: any, b: any, occ = b.occurrence) => h.api('POST', `/v1/bills/${b.bill.billId}/verify`, { occurrenceKey: occ.occurrenceKey, occurrenceVersion: occ.version }, { 'if-match': String(b.bill.version) });
const accept = (h: any, b: any) => h.api('POST', `/v1/bills/${b.bill.billId}/accept-terms`, { termsHash: b.termsHash, changedFields: b.changedFields }, { 'if-match': String(b.bill.version) });
const addSep = (h: any, b: any) => h.api('POST', `/v1/bills/${b.bill.billId}/add-obligation`, { termsHash: b.separateTermsHash }, { 'if-match': String(b.bill.version) });

// ---------- IM-01 ----------
test('S3-IM-01 the separate-obligation consequence equals the forecast after adding it (date-only, amount-only, combined, exact, ambiguous); the matched payment stays; replace stays distinct', async () => {
  for (const [label, make] of [
    ['date-only', (h: any) => keller(h, 'K-3001', 4, 'USD $10,000.00', 'MS-2')],
    ['amount-only', (h: any) => keller(h, 'K-3002', 24, 'USD $10,400.00', 'MS-2')],
    ['combined', (h: any) => keller(h, 'K-3003', 4, 'USD $10,400.00', 'MS-2')],
    ['exact', (h: any) => keller(h, 'K-3004', 24, 'USD $10,000.00', 'MS-2')],
    ['ambiguous', (h: any) => pdf({ lines: ['Brightline Payroll Services', 'INVOICE BP-9', `Payment due: ${long(addDays(h.day0(), 11))}`, 'Amount due USD $3,800.00'] })],
  ] as const) {
    const h = await hero();
    await h.drain();
    // S3 consent arithmetic, so S4-D17 (exact-match bills verified by Delegation) is switched off in this run's policy.
    const pk = K.run('tenant-a', h.run!.runId);
    const pol = (await h.store.get('core', pk, 'POLICY'))!;
    await h.store.transact([{ op: 'update', table: 'core', pk, sk: 'POLICY', set: { rules: pol.rules.map((r: any) => (r.key === 'ap.exactMatchBills' ? { ...r, everywhere: 'ALWAYS_ASK' } : r)) } }]);
    const id = (await h.inject('hero', { bytes: make(h) })).billId;
    const b = await h.bill(id);
    assert.equal(b.actions.addSeparate.allowed, true, label);
    assert.equal(b.impact.ifAdded.state, 'KNOWN', `${label}: explicit USD is never "currency unknown"`);
    const before = await h.forecast();
    assert.equal((await addSep(h, b)).status, 200, label);
    const after = await h.forecast();
    assert.deepEqual(b.impact.ifAdded.summary, after.summary, `${label}: the consent shows exactly what happens`);
    if (b.impact.ifAccepted?.state === 'KNOWN' && b.changedFields.length) assert.notDeepEqual(b.impact.ifAccepted.summary, b.impact.ifAdded.summary, `${label}: replace ≠ add`);
    const matched = label === 'ambiguous' ? /^Payroll$/ : /^Keller milestone 2$/;
    assert.equal(outflows(after, matched).length, outflows(before, matched).length, `${label}: the matched payment remains`);
  }
});

// ---------- IM-02 ----------
test('S3-IM-02 a changed revision of an unlinked bill replaces it: the first is SUPERSEDED and cannot be added; one outflow in total', async () => {
  const h = await hero();
  await h.drain();
  const a = await h.bill((await h.inject('hero', { bytes: keller(h, 'K-2230', 9, 'USD $480.00') })).billId);
  const bRes = await h.inject('hero', { bytes: keller(h, 'K-2230', 9, 'USD $500.00', null, ['REVISED']) });
  const b = await h.bill(bRes.billId);
  const a2 = await h.bill(a.bill.billId);
  assert.deepEqual([a2.bill.state, a2.bill.status, a2.actions.addSeparate.allowed, a2.actions.verify.allowed], ['SUPERSEDED', 'SUPERSEDED', false, false]);
  assert.equal((await addSep(h, a)).body.code, 'VERSION_CONFLICT', 'the stale panel is refused');
  assert.equal((await addSep(h, b)).status, 200);
  assert.deepEqual(outflows(await h.forecast(), /K-2230/).map((i: any) => i.amount.minor), [50_000], 'one outflow, the revised amount');
  assert.equal((await h.overview()).needs.filter((n: any) => /K-2230/.test(n.where)).length, 0);
});

test('S3-IM-02 concurrent reads of two same-number copies before linking → one current bill, one SUPERSEDED, one outflow', async () => {
  const h = await hero();
  await h.drain();
  const x = await h.inject('hero', { bytes: keller(h, 'K-2231', 9, 'USD $480.00'), drain: false });
  const y = await h.inject('hero', { bytes: keller(h, 'K-2231', 9, 'USD $500.00', null, ['REVISED']), drain: false });
  await h.drain();
  const states = [(await h.bill(x.billId)).bill.state, (await h.bill(y.billId)).bill.state].sort();
  assert.deepEqual(states, ['PROPOSED', 'SUPERSEDED']);
  for (const id of [x.billId, y.billId]) { const b = await h.bill(id); if (b.bill.state === 'PROPOSED') assert.equal((await addSep(h, b)).status, 200); else assert.notEqual((await addSep(h, b)).status, 200); }
  assert.equal(outflows(await h.forecast(), /K-2231/).length, 1);
});

test('S3-IM-02 three successive attached revisions stay operable (each resolves to the current one), and a replaced verified bill can no longer change terms', async () => {
  const h = await hero();
  await h.drain();
  let cur = await h.bill((await h.inject('hero', { bytes: keller(h, 'K-2207', 4, 'USD $10,000.00', 'MS-2') })).billId);
  assert.equal((await verify(h, cur)).status, 200);
  const first = await h.bill(cur.bill.billId); // VERIFIED, terms pending
  for (const [n, due] of [[1, 5], [2, 6], [3, 7]] as const) {
    const next = await h.bill((await h.inject('hero', { bytes: keller(h, 'K-2207', due, 'USD $10,000.00', 'MS-2', [`REVISION ${n}`]) })).billId);
    assert.equal(next.classification, 'REVISION_CHANGED_TERMS', `revision ${n}`);
    assert.equal((await verify(h, next)).status, 200, `revision ${n} verifies against the current substantiation`);
    const v = await h.bill(next.bill.billId);
    assert.equal((await accept(h, v)).status, 200, `revision ${n} accepts`);
    cur = v;
  }
  const f = await h.forecast();
  assert.deepEqual(outflows(f, /Keller milestone 2/).map((i: any) => i.on), [addDays(h.day0(), 7)], 'one outflow on the latest accepted date');
  const stale = await accept(h, first);
  assert.notEqual(stale.status, 200, 'the replaced first bill cannot move the date back');
  assert.deepEqual(outflows(await h.forecast(), /Keller milestone 2/).map((i: any) => i.on), [addDays(h.day0(), 7)]);
  assert.equal((await h.bill(first.bill.billId)).bill.state, 'SUPERSEDED');
});

test('S3-IM-02 a same-terms copy of the current bill stays non-actionable', async () => {
  const h = await hero();
  await h.drain();
  await h.inject('hero');
  const copy = await h.bill((await h.inject('revision')).billId);
  assert.deepEqual([copy.classification, copy.actions.verify.allowed, copy.actions.addSeparate.allowed], ['REVISION_SAME_TERMS', false, false]);
});

// ---------- IM-03 ----------
test('S3-IM-03 full ingestion: a negative or parenthesized total holds; a leading-decimal total is cents', async () => {
  const h = await hero();
  await h.drain();
  for (const t of ['USD -100.00', 'USD (100.00)']) {
    const b = await h.bill((await h.inject('hero', { bytes: keller(h, `K-NEG${t.length}`, 9, t) })).billId);
    assert.deepEqual([b.bill.state, b.classification, b.bill.amount], ['HELD', 'UNGROUNDED', null], t);
  }
  const half = await h.bill((await h.inject('hero', { bytes: keller(h, 'K-HALF', 9, 'USD .50') })).billId);
  assert.equal(half.bill.amount.minor, 50);
});

// ---------- IM-04 ----------
test('S3-IM-04 an evidence-store failure ends READ_FAILED at the fourth attempt (audit, job DONE), and Retry starts a new generation', async () => {
  const h = await hero();
  await h.drain();
  const real = h.evidence.get.bind(h.evidence);
  h.evidence.get = async () => { throw new Error('S3 GetObject failed (synthetic)'); };
  const r = await h.inject('hero');
  for (let i = 0; i < 8; i++) await h.advance(16 * 60_000);
  const b = await h.store.get('core', K.run('tenant-a', runOf(r.billId)), `BILL#${r.billId}`);
  assert.equal(b!.state, 'READ_FAILED');
  assert.match(b!.readFailure, /S3 GetObject failed.*after 4 attempts/);
  assert.equal((await h.store.get('work', K.job(`ingest#${r.billId}#1`), 'JOB'))!.state, 'DONE');
  h.evidence.get = real;
  assert.equal((await h.api('POST', `/v1/bills/${r.billId}/retry`, undefined, { 'if-match': String(b!.version) })).status, 202);
  await h.drain();
  assert.equal((await h.bill(r.billId)).bill.state, 'PROPOSED');
});

test('S3-IM-04 four worker deaths mid-request → no fifth model call; READ_FAILED', async () => {
  const h = await hero();
  await h.drain();
  h.model.script = Array(6).fill(() => { throw new SimulatedCrash('worker died (synthetic)'); });
  const r = await h.inject('hero');
  for (let i = 0; i < 8; i++) await h.advance(3 * 60_000);
  assert.equal(h.model.calls.length, 4, 'exactly four dispatched requests');
  const b = await h.store.get('core', K.run('tenant-a', runOf(r.billId)), `BILL#${r.billId}`);
  assert.equal(b!.state, 'READ_FAILED');
});

// ---------- IM-05 ----------
test('S3-IM-05 commitments beyond the matching window keep their saved date and "not yet assessed"; nothing is counted early; they enter as the window rolls', async () => {
  const h = await hero();
  await h.drain();
  const d0 = h.day0();
  const before = await h.forecast();
  for (const [name, recurrence] of [['Insurance renewal', 'NONE'], ['Annual audit', 'MONTHLY']] as const)
    assert.equal((await h.api('POST', '/v1/commitments', { name, amount: { currency: 'USD', minor: 70_000 }, on: addDays(d0, 365), recurrence, estimate: false, protected: false })).status, 201);
  const p = (await h.api('GET', '/v1/payables')).body;
  for (const name of ['Insurance renewal', 'Annual audit']) {
    const c = p.commitments.find((x: any) => x.name === name);
    assert.deepEqual([c.nextOn, c.afterHorizon], [addDays(d0, 365), true], name);
    assert.ok(p.obligations.some((o: any) => o.name === name && o.afterHorizon), `${name} on the payment plan as after the forecast`);
  }
  const f = await h.forecast();
  assert.deepEqual(f.days, before.days, 'nothing counted early');
  assert.equal(f.notInForecast.filter((r: any) => /Insurance renewal|Annual audit/.test(r.label) && /not yet assessed/.test(r.reason)).length, 2);
  h.setNow(`${addDays(d0, 330)}T15:00:00.000Z`);
  assert.equal(outflows(await h.forecast(), /Insurance renewal/).length, 1, 'enters when the window reaches it');
});

// ---------- IM-06 ----------
test('S3-IM-06 bare-"$" exact/date/amount/combined/ambiguous: Overview stays readable; impact unknown until attested; then the right alert', async () => {
  for (const [label, make] of [
    ['exact', (h: any) => keller(h, 'K-B1', 24, '$10,000.00', 'MS-2')],
    ['date', (h: any) => keller(h, 'K-B2', 4, '$10,000.00', 'MS-2')],
    ['amount', (h: any) => keller(h, 'K-B3', 24, '$10,400.00', 'MS-2')],
    ['combined', (h: any) => keller(h, 'K-B4', 4, '$10,400.00', 'MS-2')],
    ['ambiguous', (h: any) => pdf({ lines: ['Brightline Payroll Services', 'INVOICE BP-B5', `Payment due: ${long(addDays(h.day0(), 11))}`, 'Amount due $3,800.00'] })],
  ] as const) {
    const h = await hero();
    await h.drain();
    const id = (await h.inject('hero', { bytes: make(h) })).billId;
    const ov = await h.api('GET', '/v1/overview');
    assert.equal(ov.status, 200, `${label}: Overview readable`);
    assert.ok(ov.body.alert === null || ov.body.alert.kind !== 'BILL_TERMS_DIFFER', `${label}: no alert built on an unconfirmed amount`);
    assert.ok(ov.body.needs.some((n: any) => /currency/i.test(n.title)), `${label}: the currency need is shown`);
    const b = await h.bill(id);
    if (b.impact.ifAccepted) assert.equal(b.impact.ifAccepted.state, 'UNKNOWN', label);
    if (label === 'amount' || label === 'combined') {
      assert.equal((await h.api('POST', `/v1/bills/${id}/verify`, { occurrenceKey: b.occurrence.occurrenceKey, occurrenceVersion: b.occurrence.version, currency: 'USD' }, { 'if-match': String(b.bill.version) })).status, 200);
      const ov2 = (await h.overview());
      assert.equal(ov2.alert?.kind, 'BILL_TERMS_DIFFER', `${label}: after attestation, the alert`);
      assert.match(ov2.alert.headline, label === 'amount' ? /\$10,400\.00/ : /billed K-B4 for/);
    }
  }
});
