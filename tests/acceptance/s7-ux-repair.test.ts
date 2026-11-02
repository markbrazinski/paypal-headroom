// S7 UX repair (audit `ux-audit-2026-11-03`, F01/F03/F04/F06/F07/F10): the running plan owns the page, the four approvals are real
// and scoped, each confirmed receipt reassesses visibly, the fallback is skipped only on verified funds, and the scenario holds when it
// is initialized weeks later. REPLAY fake PayPal + simulated mailbox: never evidence of a payment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actionOf, approved, check, FEES, invOf, items, MON_10AM, pay, puts, report, WED_0900, type H } from './s5-helpers.ts';
import { isBusinessDay } from '../../backend/src/domain/plan/dates.ts';
import { addDays } from '../../backend/src/domain/time.ts';

const plan = async (h: H) => (await h.api('GET', '/v1/plan')).body;
const overview = async (h: H) => (await h.api('GET', '/v1/overview')).body;
const counts = async (h: H) => [(await items(h, 'REV#')).length, (await items(h, 'BUILD#')).length];

test('UX-F01 navigation never builds; the running revision stays on the page; first receipt reassesses and keeps the fallback', async () => {
  const { h, rev } = await approved();
  h.setNow('2026-11-10T13:05:00.000Z');
  await h.drain();
  await pay(h, 'cust-pellow', 760_000, FEES.pellow);
  const before = await counts(h);
  for (let i = 0; i < 3; i++) { await plan(h); await overview(h); await h.api('GET', '/v1/session'); }
  assert.deepEqual(await counts(h), before, 'reading Plan, Overview and the session creates no revision and no build');
  const p = await plan(h);
  assert.deepEqual([p.state, p.revision.revisionId, p.revision.state, p.proposed, p.banner], ['READY', rev.revisionId, 'RUNNING', null, null]);
  const u = p.revision.updates;
  assert.match(u.find((x: any) => x.kind === 'RECEIPT').text, /^Pellow Dental Group paid \$7,600\.00 on PayPal \(\$7,334\.27 after PayPal's \$265\.73 fee\)/);
  assert.match(u.at(-1).text, /^Lowest point now \$2,794\.27 on Fri, Nov 20, still \$1,205\.73 below your \$4,000\.00 reserve\. So the Mercer Architects offer stays as the fallback, checked Wed, Nov 11, 09:00/);
  assert.equal((await actionOf(h, 'DISCOUNT_FALLBACK')).state, 'WAITING_CONDITION', 'first receipt: the fallback is retained');
  assert.ok(!(await overview(h)).needs.some((n: any) => String(n.key).startsWith('plan:')), 'no "approve a new revision" while revision 1 covers the gap');
  const s = (await h.api('GET', '/v1/session')).body;
  assert.match(s.notice.text, /^Pellow Dental Group paid \$7,600\.00 on PayPal/);
});

test('UX-F06/F07 second receipt → skip on verified funds; resolved header; $90 never offered; disputed $1,800 stays open; notice + record', async () => {
  const { h } = await approved();
  h.setNow('2026-11-10T13:05:00.000Z');
  await h.drain();
  h.setNow('2026-11-11T13:30:00.000Z');
  const p1 = await pay(h, 'cust-pellow', 760_000, FEES.pellow);
  const p2 = await pay(h, 'cust-harrow', 720_000, FEES.harrow);
  // The forecast replaces both targets with the receipts, once (no double counting).
  assert.deepEqual([(await h.forecast()).summary.low.minor, (await h.forecast()).summary.lowOn], [974_250, '2026-11-20']);
  const putsBefore = puts(h);
  h.setNow('2026-11-11T13:55:00.000Z');
  await report(h, [{ cap: p1.cap, gross: 760_000, fee: FEES.pellow, number: p1.inv.invoiceNumber }, { cap: p2.cap, gross: 720_000, fee: FEES.harrow, number: p2.inv.invoiceNumber }]);
  h.setNow(WED_0900);
  const { a } = await check(h);
  assert.equal(a.state, 'SKIPPED_NOT_NEEDED');
  assert.equal(puts(h), putsBefore, 'no PayPal update: the discount is never applied');
  assert.equal((await items(h, 'GRANT#')).find((g) => g.kind === 'DISCOUNT_OFFER')!.state, 'ACTIVE', 'the approval was never used');
  const p = await plan(h);
  assert.deepEqual([p.revision.header.coverage.state, p.revision.pill], ['RESOLVED', 'GAP CLOSED']);
  assert.match(p.revision.header.coverage.text, /^Gap closed: the forecast stays above your \$4,000\.00 reserve/);
  assert.match(p.revision.updates.find((x: any) => x.kind === 'SKIPPED').text, /Mercer Architects discount not sent: verified funds alone stay above your reserve \(lowest \$4,442\.50 on Sun, Dec 20\)\. The \$90\.00 discount was never offered\./);
  const harrow = await invOf(h, 'cust-harrow');
  assert.deepEqual([harrow.state, harrow.openGross.minor], ['PARTIALLY_PAID', 180_000], 'the disputed remainder stays open on the same invoice');
  assert.match(p.revision.updates.find((x: any) => x.kind === 'RECEIPT' && /Harrow/.test(x.text)).text, /the disputed \$1,800\.00 stays open/);
  const s = (await h.api('GET', '/v1/session')).body;
  assert.match(s.notice.text, /^Mercer Architects discount not needed · you keep \$90\.00/);
  assert.equal(s.notice.to, `/plan#act-${a.actionId}`, 'the notice links to the record');
  assert.deepEqual([p.revision.kept.amount.minor, p.revision.progress.gapNow.minor, p.revision.progress.gapAtApproval.minor], [9_000, 0, 854_000]);
  const acts = (await h.api('GET', '/v1/activity')).body.rows;
  assert.ok(acts.some((r: any) => r.eventId === s.notice.eventId), 'the notice has a persistent Activity row');
  assert.ok(!(await overview(h)).needs.some((n: any) => String(n.key).startsWith('plan:')));
});

test('UX-F03 the four approval reasons arise from the seeded scenario, each scoped; the standing rules are unchanged', async () => {
  const { h, rev } = await approved();
  const kinds = rev.approval.newPermissions.map((g: any) => g.kind).sort();
  assert.deepEqual(kinds, ['COLLECT_SLICE', 'CONTACT_SPACING', 'DISCOUNT_OFFER', 'MESSAGE_AS_WRITTEN', 'PAYOUT_AUTHORITY', 'PAYOUT_EXCEPTION']);
  const d = (await h.api('GET', '/v1/delegation')).body;
  const rule = (k: string) => JSON.stringify(d.rules?.find?.((r: any) => r.key === k) ?? d.groups?.flatMap?.((g: any) => g.rules).find((r: any) => r.key === k));
  assert.match(rule('comms.contactEveryBd'), /every 4 business days/, 'approving an early contact leaves the rule alone');
  // Pellow's early contact is spent by exactly one send; no second reminder can use it.
  h.setNow('2026-11-10T13:05:00.000Z');
  await h.drain();
  const g = (await items(h, 'GRANT#')).find((x) => x.kind === 'CONTACT_SPACING')!;
  assert.equal(g.state, 'CONSUMED');
  assert.equal((await items(h, 'OUTMSG#')).filter((o) => o.customerId === 'cust-pellow' && o.state === 'SENT').length, 1);
});

for (const [label, days] of [['28 days later (Mon Dec 7)', 28], ['30 days later (Wed Dec 9)', 30]] as const) {
  test(`UX-F10 a fresh run initialized ${label} keeps the story coherent`, async () => {
    const start = new Date(Date.parse(MON_10AM) + days * 86_400_000).toISOString();
    // S7-UX3: past the recorded grant end the provider is refused, so nothing can be forecast; a deployment sets its own end.
    const { harness } = await import('./harness.ts');
    const dead = await harness({ plaid: true, hero: true, paypalMinor: 180_000, start });
    await dead.api('POST', '/v1/cash/paypal/refresh'); await dead.drain();
    assert.equal((await dead.forecast()).state, 'NO_OPENING', 'with the 30 Nov 2026 local grant, PayPal is refused');
    const { h, rev } = await approved({ start, grantExpiresAt: '2027-02-28T23:59:59.000Z' });
    const day0 = h.day0();
    const keller = rev.actions.find((a: any) => a.kind === 'PAYOUT');
    assert.ok(isBusinessDay(keller.terms.payBy), `Keller is due on a business day (${keller.terms.payBy})`);
    assert.ok(rev.actions.filter((a: any) => a.terms.contactOn).every((a: any) => isBusinessDay(a.terms.contactOn)));
    const fb = rev.actions.find((a: any) => a.kind === 'DISCOUNT_FALLBACK');
    assert.ok(fb && fb.terms.payBy <= keller.terms.payBy, 'the discount still lands before the payment it protects');
    assert.deepEqual(rev.approval.newPermissions.map((g: any) => g.kind).sort(), ['COLLECT_SLICE', 'CONTACT_SPACING', 'DISCOUNT_OFFER', 'MESSAGE_AS_WRITTEN', 'PAYOUT_AUTHORITY', 'PAYOUT_EXCEPTION']);
    assert.equal(rev.header.gap.minor, days === 28 ? 854_000 : rev.header.gap.minor, 'a Monday start reproduces the filmed figures');
    assert.ok(rev.header.gap.minor > 0 && keller.terms.payBy > day0 && keller.terms.payBy <= addDays(day0, 6));
    assert.equal((await invOf(h, 'cust-pellow')).dueOn < day0, true, 'Pellow is overdue');
    assert.equal((await invOf(h, 'cust-mercer')).dueOn > keller.terms.payBy, true, 'Mercer is not yet due');
  });
}

test('UX-B1 the demo business’s bill rule: Keller’s bill is verified and its earlier date accepted by rule → plan builds → one Overview box', async () => {
  const { harness } = await import('./harness.ts');
  const h = await harness({ plaid: true, hero: true, paypalMinor: 180_000, start: MON_10AM, bills: 'AUTO' });
  h.pp.rows = [{ transaction_id: 'BASELINE-1', transaction_event_code: 'T0000', transaction_status: 'S', transaction_initiation_date: '2026-11-08T12:00:00Z', transaction_amount: { currency_code: 'USD', value: '1800.00' }, available_balance: { currency_code: 'USD', value: '1800.00' } }];
  await h.api('POST', '/v1/cash/paypal/refresh'); await h.drain();
  const inj = await h.inject('hero');
  const b = await h.bill(inj.billId);
  assert.equal(b.bill.state, 'TERMS_ACCEPTED', 'verified and accepted by the rule, no clicks');
  const o = await overview(h);
  assert.match(o.alert.headline, /^You have a new verified bill from Keller Drafting Co\. that makes your cash fall below your reserve on Fri, Nov 13\.$/);
  assert.deepEqual([o.alert.cta.label, o.alert.cta.to.kind], ['Open your plan', 'PLAN']);
  assert.ok(!o.needs.some((n: any) => String(n.key).startsWith('plan:')), 'one box: no second "approve" row');
  assert.equal(o.safetyNotices.length, 0, 'a business’s seeded rule is not "you loosened a safety rule"');
  const p = await plan(h);
  assert.deepEqual([p.revision.state, p.revision.actions.length], ['DRAFT', 4]);
});

test('GOLD-2 golden-run email: operator only; each ask sent once to the test inbox (never the customer); confirmed status; daily limit', async () => {
  const { harness } = await import('./harness.ts');
  const h = await harness({ plaid: true, hero: true, paypalMinor: 180_000, start: MON_10AM, mail: { redirectTo: null } });
  const msg = (n: number) => ({ preparedFor: 'accounts.pellow@example.com', subject: `Invoice HR-x-00${n}: payment request`, text: 'Hello, please pay the overdue invoice.' });
  assert.equal((await h.demo('POST', '/v1/demo/golden-mail', { messages: [msg(1)] }, 'JUDGE')).status, 403, 'judges never trigger email');
  const before = (await h.mailbox.list()).length;
  const r = await h.demo('POST', '/v1/demo/golden-mail', { messages: [msg(1), msg(2)] }, 'OPERATOR');
  assert.equal(r.status, 202, JSON.stringify(r.body));
  await h.drain(); await h.drain();
  const st = await h.demo('GET', `/v1/demo/golden-mail/${r.body.id}`, undefined, 'OPERATOR');
  assert.deepEqual([st.status, st.body.state, st.body.sent?.length], [200, 'SENT', 2], JSON.stringify(st.body));
  const sent = (await h.mailbox.list()).slice(before);
  assert.equal(sent.length, 2, 'two messages, each once');
  for (const m of sent) {
    const raw = Buffer.from(String((m as { raw: string }).raw), 'base64url').toString('utf8');
    assert.match(raw, /^To: headroom@headroom\.example\r?$/m, 'to the test inbox only');
    assert.doesNotMatch(raw, /^To: .*pellow/m, 'never the customer');
    assert.match(raw, /that customer is fictional and was not contacted/, 'the email says so');
  }
  for (let i = 0; i < 9; i++) assert.equal((await h.demo('POST', '/v1/demo/golden-mail', { messages: [msg(1), msg(2)] }, 'OPERATOR')).status, 202);
  const over = await h.demo('POST', '/v1/demo/golden-mail', { messages: [msg(1)] }, 'OPERATOR');
  assert.deepEqual([over.status, over.body.code], [409, 'HARD_STOP'], 'at most 20 demo emails a day');
});
