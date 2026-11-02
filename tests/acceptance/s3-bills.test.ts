import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { harness, OWNER_B } from './harness.ts';
import { K } from '../../backend/src/adapters/store/keys.ts';
import { operatorReset } from '../../backend/src/handlers/operator.ts';
import { pdf } from '../../scripts/demo/bill-pdf.ts';
import { addDays } from '../../backend/src/domain/time.ts';

const fx = JSON.parse(readFileSync(new URL('../fixtures/hero-v1a/closes.json', import.meta.url), 'utf8'));
/** Hero v1a: PayPal $1,800 + seeded bank $8,130 = $9,930; the hero seed on reset-day offsets. */
const hero = (o: Parameters<typeof harness>[0] = {}) => harness({ plaid: true, hero: true, paypalMinor: 180_000, ...o });
const closes = (f: any) => f.days.map((d: any) => d.close.minor);
const outflows = (f: any, label: RegExp) => f.days.flatMap((d: any) => d.items).filter((i: any) => i.direction === 'OUT' && label.test(i.label));
const verify = (h: any, b: any, extra: Record<string, unknown> = {}) => h.api('POST', `/v1/bills/${b.bill.billId}/verify`, { occurrenceKey: b.occurrence?.occurrenceKey ?? null, occurrenceVersion: b.occurrence?.version ?? 0, ...extra }, { 'if-match': String(b.bill.version) });
const accept = (h: any, b: any, body = { termsHash: b.termsHash, changedFields: b.changedFields }) => h.api('POST', `/v1/bills/${b.bill.billId}/accept-terms`, body, { 'if-match': String(b.bill.version) });

test('S3-A1 hero: injected K-2207 → proposed date change (comparison only) → verify (forecast unchanged) → accept new date → one outflow, breach and gap equal the fixture', async () => {
  const h = await hero();
  await h.drain();
  const f0 = await h.forecast();
  assert.equal(f0.state, 'READY');
  assert.equal(f0.opening.amount.minor, 993_000, 'PayPal $1,800 + bank $8,130');
  assert.deepEqual(closes(f0), fx.prior_accepted_terms);
  assert.equal(f0.summary.firstBelowReserve, null);
  assert.match(f0.basis, /commitments, bills you accepted, stated receipts/);

  const inj = await h.inject('hero');
  assert.equal(inj.status, 'RECEIVED');
  assert.equal(h.model.calls.length, 1, 'one model request');
  const b = await h.bill(inj.billId);
  assert.deepEqual([b.bill.state, b.classification, b.changedFields, b.bill.status], ['PROPOSED', 'DATE_CHANGE_REQUESTED', ['dueOn'], 'DATE_DIFFERS']);
  assert.equal(b.bill.supplierName, 'Keller Drafting Co.');
  assert.ok(b.fields.every((x: any) => x.name === 'reference' || x.name === 'issueDate' || x.grounded), JSON.stringify(b.fields));
  assert.deepEqual(b.checks.map((c: any) => `${c.key}:${c.result}`), ['supplier:OK', 'amount:OK', 'reference:OK', 'date:DIFFERS', 'remittance:OK']);
  assert.match(b.note, /One obligation with conflicting terms, not two outflows/);
  assert.equal(b.impact.operative.summary.reserveGap.minor, 0);
  assert.equal(b.impact.ifAccepted.summary.reserveGap.minor, 854_000);
  assert.equal(b.impact.ifAccepted.closeOnDue.close.minor, -9000);
  assert.equal(b.actions.acceptTerms.allowed, false, 'verify first');
  assert.equal(b.actions.askSupplier.allowed, false);
  assert.equal(b.extraction.length, 1);

  // S3-R3/R6: the operative forecast is byte-identical; the comparison equals the accepted series (F6).
  const f1 = await h.forecast();
  assert.deepEqual(f1.days, f0.days);
  assert.deepEqual(f1.comparisons[0].closes.map((c: any) => c.close.minor), fx.bill_accepted_no_collection);
  assert.ok(f1.notInForecast.some((r: any) => r.reason === 'Requested date not accepted'));
  const ov = await h.overview();
  assert.equal(ov.alert.kind, 'BILL_TERMS_DIFFER');
  assert.match(ov.alert.headline, /Keller Drafting Co\. billed K-2207 for .+\. Your forecast had /);
  assert.deepEqual([ov.alert.impact.cashNow.minor, ov.alert.impact.low.minor, ov.alert.impact.needed.minor], [993_000, -454_000, 854_000]);
  assert.deepEqual(ov.alert.cta, { label: 'Review impact', to: { kind: 'BILL', billId: inj.billId } });
  assert.equal(ov.needsCount, 1);
  assert.match(ov.needs[0].title, /earlier than your forecast/);
  assert.deepEqual([ov.billsDue.count, ov.billsDue.sum.minor], [5, 1_000_000 + 65_000 + 380_000 * 2 + 150_000]);
  const inbox = (await h.api('GET', '/v1/inbox')).body;
  assert.deepEqual([inbox.items[0].from, inbox.items[0].source, inbox.items[0].title], ['Keller Drafting Co.', 'Injected by operator · sandbox', 'Bill K-2207']);

  const v = await verify(h, b);
  assert.equal(v.status, 200, JSON.stringify(v.body));
  assert.deepEqual(closes(await h.forecast()), fx.prior_accepted_terms, 'verification moves nothing');
  const b2 = await h.bill(inj.billId);
  assert.equal(b2.verification.by, 'owner-a@example.com');
  assert.deepEqual([b2.actions.acceptTerms.allowed, b2.actions.acceptTerms.label], [true, 'Accept new date…']);
  assert.match((await h.overview()).needs[0].title, /^Decide on K-2207 date$/);

  const a = await accept(h, b2);
  assert.equal(a.status, 200, JSON.stringify(a.body));
  const f2 = await h.forecast();
  assert.deepEqual(closes(f2), fx.bill_accepted_no_collection);
  assert.deepEqual([f2.days[4].state, f2.summary.firstBelowReserve, f2.summary.low.minor, f2.summary.reserveGap.minor, f2.summary.fundingDeficit.minor], ['NEGATIVE', addDays(h.day0(), 4), -454_000, 854_000, 454_000]);
  assert.equal(outflows(f2, /Keller/).length, 1, 'one outflow, moved');
  assert.equal(outflows(f2, /Keller/)[0].basis, 'BILL');
  const ov2 = await h.overview();
  assert.equal(ov2.alert.kind, 'RESERVE_GAP');
  assert.deepEqual(ov2.alert.cta.to, { kind: 'PLAN' }, 'S4 UI-OV-08: the breach alert now opens the plan');
  assert.equal(ov2.needsCount, 0);
  const cash = await h.cash();
  assert.equal(cash.totals.reportedAvailable.minor, 993_000, 'Cash now unchanged after accept');
  assert.equal(cash.lowestPoint.low.minor, -454_000, 'Overview and Cash share the forecast');
  const terms = await h.store.query('core', K.run('tenant-a', (await h.api('GET', '/v1/session')).body.run.runId), { skPrefix: 'TERMS#' });
  assert.equal(terms.length, 1);
  assert.deepEqual(terms[0].changedFields, ['dueOn']);
  const p = (await h.api('GET', '/v1/payables')).body;
  const k = p.obligations.find((o: any) => o.name === 'Keller milestone 2');
  assert.deepEqual([k.billApproved, k.dueOn, k.history.length, k.feeEstimate.minor], ['K-2207', addDays(h.day0(), 4), 1, 2000]);
});

test('S3-R1 duplicate: a byte-identical upload (sequential and racing) → DUPLICATE_DOCUMENT, one bill, no second read', async () => {
  const h = await hero();
  await h.drain();
  const body = { fileName: 'k.pdf', contentType: 'application/pdf', contentBase64: (await import('../../scripts/demo/bill-pdf.ts')).billPdf('hero', h.day0()).toString('base64') };
  const [a, b] = await Promise.all([h.api('POST', '/v1/documents', body), h.api('POST', '/v1/documents', body)]);
  assert.deepEqual([a.status, b.status], [202, 202]);
  assert.deepEqual([a.body.status, b.body.status].sort(), ['DUPLICATE_DOCUMENT', 'RECEIVED']);
  assert.equal(a.body.billId, b.body.billId);
  const c = await h.api('POST', '/v1/documents', body);
  assert.deepEqual([c.body.status, c.body.billId], ['DUPLICATE_DOCUMENT', a.body.billId]);
  await h.drain();
  assert.equal((await h.api('GET', '/v1/payables')).body.bills.length, 1);
  assert.equal(h.model.calls.length, 1);
});

test('S3-R12 non-PDF or > 4 MB upload → INVALID_INPUT, nothing stored, no job', async () => {
  const h = await hero();
  await h.drain();
  const up = (bytes: Buffer) => h.api('POST', '/v1/documents', { fileName: 'x.pdf', contentType: 'application/pdf', contentBase64: bytes.toString('base64') });
  assert.equal((await up(Buffer.from('hello, not a pdf'))).body.code, 'INVALID_INPUT');
  const big = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(4 * 1024 * 1024)]);
  assert.equal((await up(big)).status, 400);
  assert.equal((await h.api('POST', '/v1/documents', { fileName: 'x.pdf', contentType: 'image/png', contentBase64: 'AAAA' })).body.code, 'INVALID_INPUT');
  assert.equal((await h.api('GET', '/v1/payables')).body.bills.length, 0);
  assert.equal((await h.store.dueJobs('9999', 100)).filter((j) => j.type === 'INGEST_DOCUMENT').length, 0);
});

test('S3-R2 changed remittance → HELD, verify refused BILL_HELD, Needs says confirm out of band; S3-R5 injected instructions flagged, not obeyed', async () => {
  const h = await hero();
  await h.drain();
  const r = await h.inject('remittance');
  const b = await h.bill(r.billId);
  assert.deepEqual([b.bill.state, b.flags], ['HELD', ['REMITTANCE_CHANGE']]);
  assert.equal(b.checks.find((c: any) => c.key === 'remittance').result, 'HELD');
  const v = await verify(h, b, { occurrenceKey: b.bill.occurrenceKey ?? 'occ#cmt-keller-ms2#0', occurrenceVersion: 0 });
  assert.equal(v.body.code, 'BILL_HELD');
  assert.match((await h.overview()).needs[0].title, /Confirm Keller Drafting Co\.'s payment details/);
  assert.deepEqual(closes(await h.forecast()), fx.prior_accepted_terms);

  const i = await h.inject('injection');
  const bi = await h.bill(i.billId);
  assert.ok(bi.flags.includes('UNTRUSTED_INSTRUCTION_TEXT'));
  assert.equal(bi.fields.find((f: any) => f.name === 'remittanceLast4').value, '4417', 'the verified account, not the one the note asks for');
  assert.notEqual(bi.bill.state, 'TERMS_ACCEPTED');
  assert.equal(bi.checks.find((c: any) => c.key === 'instructions').result, 'HELD');
});

test('S3-R4/R25 scanned (image-only) PDF → HELD unreadable, zero model calls, spend counter unchanged', async () => {
  const h = await hero();
  await h.drain();
  const r = await h.inject('scanned');
  const b = await h.bill(r.billId);
  assert.deepEqual([b.bill.state, b.classification], ['HELD', 'UNREADABLE_NEEDS_OCR_OR_VISION']);
  assert.equal(h.model.calls.length, 0);
  assert.equal(await h.store.get('work', 'COUNTER#bedrock#local', 'COUNTER'), undefined);
});

test('S3-R7 a model total not in the document → ungrounded, HELD, amount null, no outflow; S3-R8 relative date → HELD, nothing inferred', async () => {
  const h = await hero();
  await h.drain();
  h.model.edit = (o) => ({ ...o, total: { value: '4900.00', quote: '$10,000.00' } });
  const b = await h.bill((await h.inject('hero')).billId);
  assert.deepEqual([b.bill.state, b.classification, b.bill.amount], ['HELD', 'UNGROUNDED', null]);
  h.model.edit = undefined;
  const rel = await h.bill((await h.inject('relative-date')).billId);
  assert.deepEqual([rel.bill.state, rel.classification, rel.bill.dueOn], ['HELD', 'UNGROUNDED', null]);
  assert.match(rel.fields.find((f: any) => f.name === 'dueDate').reason, /relative wording/);
  assert.deepEqual(closes(await h.forecast()), fx.prior_accepted_terms);
});

test('S3-R9 two concurrent accepts → applied once (one TERMS#), the other VERSION_CONFLICT; S3-R10 accept before verify; S3-R11 stale hash', async () => {
  const h = await hero();
  await h.drain();
  const id = (await h.inject('hero')).billId;
  let b = await h.bill(id);
  assert.equal((await accept(h, { ...b, termsHash: 'x', changedFields: ['dueOn'] })).body.code, 'NOT_VERIFIED');
  await verify(h, b);
  b = await h.bill(id);
  assert.equal((await accept(h, b, { termsHash: 'stale', changedFields: ['dueOn'] })).body.code, 'TERMS_CHANGED');
  const [x, y] = await Promise.all([accept(h, b), accept(h, b)]);
  assert.deepEqual([x.status, y.status].sort(), [200, 409]);
  assert.equal((await h.store.query('core', K.run('tenant-a', b.bill.billId.replace(/^bill_(\w+?)_.*/, 'run-$1')), { skPrefix: 'TERMS#' })).length, 1);
  assert.deepEqual(closes(await h.forecast()), fx.bill_accepted_no_collection);
});

test('S3-R32 amount-only discrepancy: "Accept new amount…" with old → new; TERMS# lists [amount]; a date-only consent is refused', async () => {
  const h = await hero();
  await h.drain();
  const id = (await h.inject('amount')).billId;
  let b = await h.bill(id);
  assert.deepEqual([b.classification, b.changedFields, b.bill.status], ['AMOUNT_DISCREPANCY', ['amount'], 'AMOUNT_DIFFERS']);
  await verify(h, b);
  b = await h.bill(id);
  assert.equal(b.actions.acceptTerms.label, 'Accept new amount…');
  assert.equal((await accept(h, b, { termsHash: b.termsHash, changedFields: ['dueOn'] })).body.code, 'TERMS_CHANGED');
  assert.equal((await accept(h, b)).status, 200);
  const f = await h.forecast();
  assert.deepEqual(outflows(f, /Keller/).map((i: any) => [i.on, i.amount.minor]), [[addDays(h.day0(), 24), 1_040_000]]);
  const combined = await harness({ plaid: true, hero: true, paypalMinor: 180_000 });
  await combined.drain();
  const c = await combined.bill((await combined.inject('combined')).billId);
  assert.deepEqual([c.classification, c.changedFields], ['TERMS_DIFFER', ['dueOn', 'amount']]);
  await verify(combined, c);
  assert.equal((await combined.bill(c.bill.billId)).actions.acceptTerms.label, 'Accept new date and amount…');
});

test('S3-R14 another tenant’s bill id → NOT_FOUND (read, document, commands)', async () => {
  const h = await hero();
  await h.drain();
  const id = (await h.inject('hero')).billId;
  for (const [m, p] of [['GET', `/v1/bills/${id}`], ['GET', `/v1/bills/${id}/document`], ['POST', `/v1/bills/${id}/verify`]] as const) {
    const r = await h.api(m, p, m === 'POST' ? { occurrenceKey: null, occurrenceVersion: 0 } : undefined, { 'if-match': '2' }, OWNER_B);
    assert.equal(r.body.code, 'NOT_FOUND', `${m} ${p}`);
  }
  const doc = (await h.api('GET', `/v1/bills/${id}/document`)).body;
  assert.ok(Buffer.from(doc.contentBase64, 'base64').subarray(0, 5).toString() === '%PDF-');
});

test('S3-R15 an old-run ingest finishing after a reset writes only to the old run', async () => {
  const h = await hero();
  await h.drain();
  const r = await h.inject('hero', { drain: false });
  await operatorReset(h.deps, 'tenant-a', 'mid-ingest reset', { bank: 'seed', hero: true });
  await h.drain();
  const ov = await h.overview();
  assert.equal(ov.needsCount, 0);
  assert.equal((await h.api('GET', '/v1/payables')).body.bills.length, 0);
  assert.equal((await h.bill(r.billId)).code, 'NOT_FOUND', 'earlier run');
  const old = await h.store.get('core', K.run('tenant-a', `run-${r.billId.split('_')[1]}`), `BILL#${r.billId}`);
  assert.equal(old!.state, 'PROPOSED', 'finished in its own (sealed) run');
});

test('S3-R16 revision same number and terms → REVISION_SAME_TERMS, nothing to do; S3-R17 a different bill for a billed occurrence → ALREADY_BILLED', async () => {
  const h = await hero();
  await h.drain();
  const first = await h.bill((await h.inject('hero')).billId);
  await verify(h, first);
  const rev = await h.bill((await h.inject('revision')).billId);
  assert.deepEqual([rev.classification, rev.bill.statusLabel], ['REVISION_SAME_TERMS', 'Already received']);
  assert.match(rev.holdReasons[0], /already received; nothing to do/);
  const other = await h.bill((await h.inject('injection')).billId); // K-2208 for the same milestone
  assert.deepEqual([other.classification, other.bill.state], ['COMMITMENT_ALREADY_BILLED', 'HELD']);
  assert.equal(outflows(await h.forecast(), /Keller/).length, 1);
  assert.equal((await h.overview()).needs.filter((n: any) => /K-2207/.test(n.where)).length, 1, 'the revision raises no extra need');
});

test('S3-R18 unknown supplier → HELD; its potential amount in "Not in the forecast yet"; no outflow', async () => {
  const h = await hero();
  await h.drain();
  const b = await h.bill((await h.inject('unknown')).billId);
  assert.deepEqual([b.bill.state, b.classification, b.bill.supplierName], ['HELD', 'UNKNOWN_SUPPLIER', 'Tidewater Supply']);
  const f = await h.forecast();
  assert.ok(f.notInForecast.some((r: any) => r.ref?.id === b.bill.billId && r.amount.minor === 96_000 && /potential only/.test(r.reason)));
  assert.deepEqual(closes(f), fx.prior_accepted_terms);
});

test('S3-R19/R37 ambiguous: picker lists both payroll occurrences with impact each; a non-candidate → NOT_A_CANDIDATE; a stale choice → VERSION_CONFLICT; a candidate verifies', async () => {
  const h = await hero();
  await h.drain();
  const id = (await h.inject('ambiguous')).billId;
  const b = await h.bill(id);
  assert.deepEqual([b.classification, b.bill.status, b.candidates.length], ['AMBIGUOUS_COMMITMENT', 'CHOOSE_MATCH', 2]);
  assert.ok(b.candidates.every((c: any) => c.ifSelected.state === 'KNOWN' && c.commitmentName === 'Payroll' && !c.alreadyBilled));
  assert.notDeepEqual(b.candidates[0].ifSelected.summary, b.candidates[1].ifSelected.summary, 'moving the later payroll to day +11 changes the low');
  const bad = await h.api('POST', `/v1/bills/${id}/verify`, { occurrenceKey: 'occ#cmt-keller-ms2#0', occurrenceVersion: 0 }, { 'if-match': String(b.bill.version) });
  assert.equal(bad.body.code, 'NOT_A_CANDIDATE');
  const stale = await h.api('POST', `/v1/bills/${id}/verify`, { occurrenceKey: b.candidates[0].occurrenceKey, occurrenceVersion: 7 }, { 'if-match': String(b.bill.version) });
  assert.equal(stale.body.code, 'VERSION_CONFLICT');
  const ok = await h.api('POST', `/v1/bills/${id}/verify`, { occurrenceKey: b.candidates[0].occurrenceKey, occurrenceVersion: 0 }, { 'if-match': String(b.bill.version) });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const after = await h.bill(id);
  assert.deepEqual([after.bill.state, after.classification, after.occurrence.occurrenceKey], ['VERIFIED', 'EXACT_MATCH', b.candidates[0].occurrenceKey]);
});

test('S3-R26 operator inject carrying fields or state is refused (original bytes only)', async () => {
  const h = await hero();
  await h.drain();
  const { operatorInjectBill } = await import('../../backend/src/handlers/operator.ts');
  await assert.rejects(operatorInjectBill(h.deps, 'tenant-a', { action: 'injectBill', tenantId: 'tenant-a', fileName: 'x.pdf', contentBase64: 'JVBERi0=', reason: 'x', state: 'VERIFIED', amount: 1 }), /refused: state, amount/);
});

test('S3-R27/R28 EUR → HELD UNSUPPORTED_CURRENCY (no Money, no impact, printed total kept); no currency → CURRENCY_MISSING; USD + € → CONFLICTING', async () => {
  const h = await hero();
  await h.drain();
  const e = await h.bill((await h.inject('eur')).billId);
  assert.deepEqual([e.classification, e.bill.amount, e.bill.printedTotal, e.impact.ifAccepted], ['UNSUPPORTED_CURRENCY', null, 'EUR €10,000.00', null]);
  const lines = (amount: string) => ['Keller Drafting Co.', 'INVOICE K-2250', `Payment due: ${new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' }).format(new Date(`${addDays(h.day0(), 4)}T00:00:00Z`))}`, `Amount due ${amount}`];
  const missing = await h.bill((await h.inject('hero', { bytes: pdf({ lines: lines('10,000.00') }) })).billId);
  assert.equal(missing.classification, 'CURRENCY_MISSING');
  const conflict = await h.bill((await h.inject('hero', { bytes: pdf({ lines: [...lines('USD 10,000.00'), 'Also payable as €9,200.00'] }) })).billId);
  assert.equal(conflict.classification, 'CONFLICTING_CURRENCY');
});

test('S3-R29 bare "$" → PROPOSED with impact unknown; verify needs the owner’s "US dollars" attestation, which is recorded', async () => {
  const h = await hero();
  await h.drain();
  const id = (await h.inject('bare-dollar')).billId;
  const b = await h.bill(id);
  assert.deepEqual([b.bill.state, b.currencyBasis, b.bill.amount, b.bill.status, b.impact.ifAccepted.state], ['PROPOSED', 'BARE_DOLLAR', null, 'CONFIRM_CURRENCY', 'UNKNOWN']);
  assert.match(b.impact.ifAccepted.reason, /confirm the currency/);
  assert.equal((await verify(h, b)).body.code, 'INVALID_INPUT');
  assert.equal((await verify(h, b, { currency: 'USD' })).status, 200);
  const after = await h.bill(id);
  assert.deepEqual([after.bill.amount.minor, after.verification.currencyAttested, after.classification], [1_000_000, 'USD', 'EXACT_MATCH']);
});

test('S3-R36 known supplier, no commitment → separate obligation: exactly one new outflow; repeat → conflict; unknown supplier refused', async () => {
  const h = await hero();
  await h.drain();
  const id = (await h.inject('separate')).billId;
  const b = await h.bill(id);
  assert.deepEqual([b.classification, b.bill.state, b.actions.addSeparate.allowed, b.actions.verify.allowed], ['NEW_OBLIGATION_KNOWN_SUPPLIER', 'PROPOSED', true, false]);
  assert.equal(b.impact.ifAccepted.state, 'KNOWN');
  const add = () => h.api('POST', `/v1/bills/${id}/add-obligation`, { termsHash: b.separateTermsHash }, { 'if-match': String(b.bill.version) });
  assert.equal((await add()).status, 200);
  assert.equal((await add()).body.code, 'VERSION_CONFLICT');
  const f = await h.forecast();
  assert.deepEqual(outflows(f, /K-2230/).map((i: any) => [i.on, i.amount.minor, i.basis]), [[addDays(h.day0(), 9), 48_000, 'BILL']]);
  assert.equal(f.days[41].close.minor, fx.prior_accepted_terms[41] - 48_000);
  const after = await h.bill(id);
  assert.deepEqual([after.bill.state, after.verification !== null, after.acceptance.kind], ['TERMS_ACCEPTED', true, 'SEPARATE_OBLIGATION']);
  const unk = await h.bill((await h.inject('unknown')).billId);
  const r = await h.api('POST', `/v1/bills/${unk.bill.billId}/add-obligation`, { termsHash: 'x' }, { 'if-match': String(unk.bill.version) });
  assert.equal(r.body.code, 'BILL_HELD');
});

test('S3-R24/R38 no PayPal report → forecast NO_OPENING; bill impact "unknown"; verify and accept still work; the impact appears after the first report', async () => {
  const h = await hero({ noPayPalReport: true });
  await h.drain();
  assert.equal((await h.forecast()).state, 'NO_OPENING');
  const id = (await h.inject('hero')).billId;
  let b = await h.bill(id);
  assert.deepEqual([b.impact.operative.state, b.impact.ifAccepted.state], ['UNKNOWN', 'UNKNOWN']);
  const ov = await h.overview();
  assert.deepEqual([ov.alert.kind, ov.alert.impact.state], ['BILL_TERMS_DIFFER', 'UNKNOWN']);
  assert.match(ov.alert.body, /Cash impact unknown/);
  assert.equal((await verify(h, b)).status, 200);
  b = await h.bill(id);
  assert.equal((await accept(h, b)).status, 200);
  h.pp.balance.asOf = new Date(Date.parse(h.clock()) - 3600_000).toISOString();
  await h.api('POST', '/v1/cash/paypal/refresh');
  await h.drain();
  const f = await h.forecast();
  assert.equal(f.state, 'READY');
  assert.deepEqual(closes(f), fx.bill_accepted_no_collection);
  assert.equal((await h.overview()).alert.kind, 'RESERVE_GAP');
});
