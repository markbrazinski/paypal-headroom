// S7a layer 3 (S07 §6.18 R4/R5): Harrow's dispute from her own email (routed by invoice number + sender, held, grounded, owner
// confirms) and disputed collection under the loosened rule (consumed authority, allowance-bounded allocation). Simulated mailbox,
// FAKE ReplyInterpreter (its quotes still pass the real gate), fake PayPal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.ts';
import { b64url, buildMessage } from '../../backend/src/adapters/mail/rfc5322.ts';
import { FakeReplier, invOf, items, MON_10AM, pay, type H } from './s5-helpers.ts';

const HARROW = 'accounts.harrow@example.com';
const TEXT = 'Hello, about the invoice: we accept the $7,200 for the agreed scope and dispute the $1,800 change order.';

async function email(h: H, o: { from: string; subject: string; text: string }) {
  const raw = buildMessage({ from: o.from, to: ['larkspur+headroom@headroom.example'], subject: o.subject, text: o.text, messageId: `<d.${Math.random().toString(36).slice(2)}@harrow.example>`, inReplyTo: null, references: [], date: h.clock(), attachments: [] });
  await h.mailbox.inject({ raw: b64url.encode(raw), auth: { source: 'SIMULATED', dkim: 'pass', spf: 'pass', dmarc: 'pass' } });
  await h.advance(61_000);
  await h.drain();
}
const SPLIT = { intent: 'DISPUTE_PARTIAL', quote: 'we accept the $7,200 for the agreed scope and dispute the $1,800 change order.', quotedDate: null, quotedAmount: null, amountQuotes: { disputed: 'the $1,800 change order', undisputed: 'the $7,200' } };

async function emailRun(o: Parameters<typeof harness>[0] = {}) {
  const replier = new FakeReplier();
  const h = await harness({ plaid: true, hero: true, paypalMinor: 180_000, start: MON_10AM, mail: { redirectTo: null }, dispute: 'EMAIL', replier, ...o });
  await h.drain();
  await h.advance(61_000); await h.drain(); // first MAIL_SYNC writes the cursor (the barrier: older mail is never read)
  const harrow = await invOf(h, 'cust-harrow');
  return { h, replier, harrow };
}
async function breach(h: H) {
  const inj = await h.inject('hero');
  let b = await h.bill(inj.billId);
  await h.api('POST', `/v1/bills/${b.bill.billId}/verify`, { occurrenceKey: b.occurrence.occurrenceKey, occurrenceVersion: b.occurrence.version }, { 'if-match': String(b.bill.version) });
  b = await h.bill(inj.billId);
  assert.equal((await h.api('POST', `/v1/bills/${b.bill.billId}/accept-terms`, { termsHash: b.termsHash, changedFields: b.changedFields }, { 'if-match': String(b.bill.version) })).status, 200);
}
async function build(h: H) {
  assert.ok([200, 202].includes((await h.api('POST', '/v1/plan/revisions', {})).status)); // O6: it may already be building by itself
  await h.drain();
  return (await h.api('GET', '/v1/plan')).body;
}

test('S7-A12 Harrow’s dispute email → routed by invoice number → pending (no collection) → you confirm → the undisputed slice is proposed', async () => {
  const { h, replier, harrow } = await emailRun();
  assert.equal((await items(h, 'CLAIM#')).length, 0, 'EMAIL mode seeds no claim');
  replier.next = SPLIT;
  await email(h, { from: `Harrow Developments <${HARROW}>`, subject: `Invoice ${harrow.invoiceNumber}`, text: TEXT });
  const [m] = await items(h, 'MAIL#');
  assert.deepEqual([m.processing, m.binding.invoiceId, m.interpretation.intent], ['ROUTED', harrow.invoiceId, 'DISPUTE_PARTIAL']);
  const inv = (await h.api('GET', `/v1/invoices/${harrow.invoiceId}`)).body;
  assert.deepEqual([inv.dispute.disputed.minor, inv.dispute.undisputed.minor, inv.dispute.derived], [180_000, 720_000, null]);
  assert.ok((await h.overview()).needs.some((n: any) => n.key === `dispute:${harrow.invoiceId}`), 'Needs you row');
  await breach(h);
  let p = await build(h);
  assert.ok(!p.revision.actions.some((a: any) => a.subject.invoiceId === harrow.invoiceId), 'nothing collects while pending');
  assert.ok(p.revision.considered.some((c: any) => /^Dispute waiting for you/.test(c.reason)));
  const conf = await h.api('POST', `/v1/receivables/invoices/${harrow.invoiceId}/dispute/confirm`, { proposalId: inv.dispute.proposalId, undisputedMinor: 720_000, disputedMinor: 180_000, invoiceVersion: inv.dispute.invoiceVersion });
  assert.equal(conf.status, 200, JSON.stringify(conf.body));
  const [claim] = await items(h, 'CLAIM#');
  assert.deepEqual([claim.basis, claim.source.by, claim.source.messageId, claim.disputed.minor], ['CUSTOMER_REPLY', 'OWNER', m.messageId, 180_000]);
  assert.equal((await h.api('POST', `/v1/receivables/invoices/${harrow.invoiceId}/dispute/confirm`, { proposalId: inv.dispute.proposalId, undisputedMinor: 720_000, disputedMinor: 180_000, invoiceVersion: inv.dispute.invoiceVersion })).body.code, 'VERSION_CONFLICT', 'once');
  assert.equal((await h.api('GET', '/v1/grants')).body?.grants?.length ?? 0, 0, 'confirming creates no permission');
  p = await build(h);
  const slice = p.revision.actions.find((a: any) => a.kind === 'COLLECT_UNDISPUTED_SLICE');
  assert.equal(slice?.terms.amount.minor, 720_000, 'the confirmed undisputed part');
  assert.ok(!p.revision.actions.some((a: any) => a.kind === 'COLLECT_DISPUTED'), 'default rule: the disputed part is never a candidate');
});

test('S7-R21/R32 mismatched amounts → owner types them; a spoofed sender or another run’s invoice changes nothing', async () => {
  const { h, replier, harrow } = await emailRun();
  replier.next = { ...SPLIT, amountQuotes: { disputed: 'the $1,800 change order', undisputed: 'Hello' } };
  await email(h, { from: `Mallory <x@attacker.example>`, subject: `Invoice ${harrow.invoiceNumber}`, text: TEXT });
  let mails = await items(h, 'MAIL#');
  assert.deepEqual([mails[0].processing, mails[0].heldCode, mails[0].interpretation], ['HELD', 'HOLD_UNAUTHORIZED', null], 'S7-R32 spoofed sender: held, not read');
  await email(h, { from: HARROW, subject: 'Invoice HR-zzzzzz-002', text: 'We dispute $1,800 on HR-zzzzzz-002.' });
  mails = await items(h, 'MAIL#');
  assert.ok(mails.some((x) => x.heldCode === 'HOLD_NO_INVOICE'), 'an unknown invoice number → held for you');
  replier.next = { intent: 'DISPUTE_PARTIAL', quote: 'we accept the $7,200 for the agreed scope', quotedDate: null, quotedAmount: null, amountQuotes: { disputed: '$1,800', undisputed: '$7,200' } };
  await email(h, { from: HARROW, subject: `Invoice ${harrow.invoiceNumber}`, text: 'Hi: we accept the $7,200 for the agreed scope. We dispute $1,800. Correction: $7,000.' });
  const inv = (await h.api('GET', `/v1/invoices/${harrow.invoiceId}`)).body;
  assert.ok(inv.dispute, 'pending');
  replier.next = SPLIT;
  // The amounts in this reading are $1,800 + $7,200 = open, so grounded; a mismatch case:
  const { disputeSplit } = await import('../../backend/src/domain/comms/gates.ts');
  assert.deepEqual(disputeSplit({ disputed: '$1,800', undisputed: '$7,000' }, 900_000).disputedMinor, null);
  const bad = await h.api('POST', `/v1/receivables/invoices/${harrow.invoiceId}/dispute/confirm`, { proposalId: inv.dispute.proposalId, undisputedMinor: 700_000, disputedMinor: 180_000, invoiceVersion: inv.dispute.invoiceVersion });
  assert.deepEqual([bad.status, bad.body.code], [400, 'INVALID_INPUT'], 'parts must add up to what is open');
  const dis = await h.api('POST', `/v1/receivables/invoices/${harrow.invoiceId}/dispute/dismiss`, { proposalId: inv.dispute.proposalId });
  assert.equal(dis.status, 200);
  assert.equal((await h.api('GET', `/v1/invoices/${harrow.invoiceId}`)).body.dispute, null);
  assert.equal((await items(h, 'CLAIM#')).length, 0);
});

test('S7-A4/R9/R34 loosened disputes: propose the disputed ask (needs approval); dispatch consumes it into AUTHZ#/DISPALLOW#; payment allocates DISPUTED only up to it', async () => {
  const { h, replier, harrow } = await emailRun();
  replier.next = SPLIT;
  await email(h, { from: HARROW, subject: `Invoice ${harrow.invoiceNumber}`, text: TEXT });
  const inv = (await h.api('GET', `/v1/invoices/${harrow.invoiceId}`)).body;
  assert.equal((await h.api('POST', `/v1/receivables/invoices/${harrow.invoiceId}/dispute/confirm`, { proposalId: inv.dispute.proposalId, undisputedMinor: 720_000, disputedMinor: 180_000, invoiceVersion: inv.dispute.invoiceVersion })).status, 200);
  const d = (await h.api('GET', '/v1/delegation')).body;
  const pv = await h.api('POST', '/v1/delegation/preview', { key: 'ar.disputes', scope: 'EVERYWHERE', value: 'PROPOSE_DISPUTED' });
  assert.equal((await h.api('POST', '/v1/delegation/rules', { key: 'ar.disputes', scope: 'EVERYWHERE', value: 'PROPOSE_DISPUTED', previewHash: pv.body.previewHash, acknowledgeSafety: true }, { 'if-match': String(d.version) })).status, 200);
  await breach(h);
  const p = await build(h);
  const ask = p.revision.actions.find((a: any) => a.kind === 'COLLECT_DISPUTED');
  assert.ok(ask, JSON.stringify(p.revision.considered.map((c: any) => c.reasonCode)));
  assert.deepEqual([ask.terms.amount.minor, ask.authority.decision, ask.authority.grantKinds.includes('COLLECT_DISPUTED')], [180_000, 'REQUIRES_APPROVAL', true]);
  // Without approval nothing is asked and nothing allocates to DISPUTED (R9).
  assert.equal((await items(h, 'DISPALLOW#')).length, 0);
  const rev = p.revision;
  const ap = await h.api('POST', `/v1/plan/revisions/${rev.revisionId}/approve`, { selected: rev.approval.selected, consentHash: rev.approval.consentHash }, { 'if-match': String(rev.version) });
  assert.equal(ap.status, 200, JSON.stringify(ap.body));
  for (let i = 0; i < 5; i++) { await h.advance(15 * 60_000); await h.drain(); }
  const allow = (await items(h, 'DISPALLOW#'))[0];
  const authz = await items(h, 'AUTHZ#');
  assert.deepEqual([allow?.allowedMinor, allow?.usedMinor, authz.length], [180_000, 0, 1], JSON.stringify((await items(h, 'ACT#')).map((a) => [a.kind, a.state, a.heldReasons])));
  assert.equal(authz[0].portion, 'DISPUTED');
  // Harrow pays the whole invoice: $7,200 settles the undisputed part, $1,800 the approved disputed ask (R5 order); the claim is unchanged.
  await pay(h, 'cust-harrow', 900_000, 31_459);
  const allocs = (await items(h, 'ALLOC#')).filter((a) => a.invoiceId === harrow.invoiceId).map((a) => [a.claim, a.amount.minor]).sort();
  assert.deepEqual(allocs, [['DISPUTED', 180_000], ['UNDISPUTED', 720_000]]);
  assert.equal((await items(h, 'DISPALLOW#'))[0].usedMinor, 180_000);
  const after = (await h.api('GET', `/v1/invoices/${harrow.invoiceId}`)).body;
  assert.deepEqual([after.projection.disputedUnresolved.minor, after.projection.undisputedOpen.minor, after.disputedAllowance.used.minor], [0, 0, 180_000]);
  assert.equal((await items(h, 'CLAIM#'))[0].disputed.minor, 180_000, 'the claim record is never altered');
  // S7-R36: a $1,800 refund on that capture reverses last-in first-out: the DISPUTED part comes back, the allowance is freed.
  const cap = (await items(h, 'ALLOC#')).find((a) => a.invoiceId === harrow.invoiceId)!.captureId;
  const amt = (minor: number) => ({ currency_code: 'USD', value: (minor / 100).toFixed(2) });
  h.pp.rows = [...(h.pp.rows ?? []), { transaction_id: 'RFND00000000000S7', paypal_reference_id: cap, transaction_event_code: 'T1107', transaction_status: 'S', transaction_initiation_date: h.clock(), transaction_amount: amt(-180_000), available_balance: amt(1_000_000), invoice_id: harrow.invoiceNumber }];
  for (let i = 0; i < 2; i++) { await h.api('POST', '/v1/cash/paypal/refresh'); await h.drain(); }
  const net = async (claim: string) => (await items(h, 'ALLOC#')).filter((a) => a.invoiceId === harrow.invoiceId && a.claim === claim).reduce((t, a) => t + a.amount.minor, 0);
  assert.deepEqual([await net('DISPUTED'), await net('UNDISPUTED')], [0, 720_000], 'LIFO: the disputed part first');
  assert.equal((await items(h, 'DISPALLOW#'))[0].usedMinor, 0);
  const back = (await h.api('GET', `/v1/invoices/${harrow.invoiceId}`)).body;
  assert.equal(back.projection.disputedUnresolved.minor, 180_000, 'the dispute is outstanding again');
  assert.ok(!back.allocations.some((a: any) => a.amount.minor < 0), 'lists show the original allocations only');
  assert.equal((await items(h, 'CLAIM#'))[0].disputed.minor, 180_000, 'the claim record is never altered');
});

for (const tightenTo of ['UNDISPUTED_ONLY', 'PAUSE_INVOICE'] as const) test(`S7a-IR-01 approved disputed ask, then ar.disputes → ${tightenTo} before dispatch: nothing asked, nothing consumed`, async () => {
  const { h, replier, harrow } = await emailRun();
  replier.next = SPLIT;
  await email(h, { from: HARROW, subject: `Invoice ${harrow.invoiceNumber}`, text: TEXT });
  const inv = (await h.api('GET', `/v1/invoices/${harrow.invoiceId}`)).body;
  assert.equal((await h.api('POST', `/v1/receivables/invoices/${harrow.invoiceId}/dispute/confirm`, { proposalId: inv.dispute.proposalId, undisputedMinor: 720_000, disputedMinor: 180_000, invoiceVersion: inv.dispute.invoiceVersion })).status, 200);
  const setRule = async (value: string, ack = false) => {
    const pv = await h.api('POST', '/v1/delegation/preview', { key: 'ar.disputes', scope: 'EVERYWHERE', value });
    const v = (await h.api('GET', '/v1/delegation')).body.version;
    return h.api('POST', '/v1/delegation/rules', { key: 'ar.disputes', scope: 'EVERYWHERE', value, previewHash: pv.body.previewHash, ...(ack ? { acknowledgeSafety: true } : {}) }, { 'if-match': String(v) });
  };
  assert.equal((await setRule('PROPOSE_DISPUTED', true)).status, 200);
  await breach(h);
  const p = await build(h);
  assert.ok(p.revision.actions.some((a: any) => a.kind === 'COLLECT_DISPUTED'));
  const rev = p.revision;
  assert.equal((await h.api('POST', `/v1/plan/revisions/${rev.revisionId}/approve`, { selected: rev.approval.selected, consentHash: rev.approval.consentHash }, { 'if-match': String(rev.version) })).status, 200);
  assert.equal((await setRule(tightenTo)).status, 200);
  for (let i = 0; i < 5; i++) { await h.advance(15 * 60_000); await h.drain(); }
  const acts = (await items(h, 'ACT#')).filter((a) => a.subject?.invoiceId === harrow.invoiceId);
  assert.equal(acts.find((a) => a.kind === 'COLLECT_DISPUTED')?.state, 'HELD');
  assert.deepEqual([(await items(h, 'DISPALLOW#')).length, (await items(h, 'AUTHZ#')).length], [0, 0]);
  if (tightenTo === 'PAUSE_INVOICE') assert.equal(acts.find((a) => a.kind === 'COLLECT_UNDISPUTED_SLICE')?.state, 'HELD', 'the whole invoice is paused');
});
