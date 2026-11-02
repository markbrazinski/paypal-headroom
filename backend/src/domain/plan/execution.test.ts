import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Grant, InvoiceProjection, PlanAction } from '@headroom/contracts';
import { decideCollect, decideOffer, decideSlice, seedPolicy } from '../delegation/policy.ts';
import { authorize, type AuthorityCtx } from './authority.ts';
import { decideByOf } from './dates.ts';
import { progressFor } from './progress.ts';

const TZ = 'America/New_York';
const NOW = '2026-11-11T14:00:00.000Z';
const usd = (minor: number) => ({ currency: 'USD' as const, minor });
// A-002 cases run on the delegation mode where an in-limit offer is authorized by policy (the seed asks the owner each time, S7-UX2).
const policy = seedPolicy('2026-11-09T12:00:00.000Z');
policy.rules = policy.rules.map((r) => (r.key === 'ar.discount' ? { ...r, everywhere: { ...(r.everywhere as object), ask: 'ABOVE_LIMITS' } } : r));
const tightened = structuredClone(policy);
const disc = tightened.rules.find((r) => r.key === 'ar.discount')!;
disc.everywhere = { ...(disc.everywhere as Record<string, number | string>), bp: 100 };
tightened.version = policy.version + 1;

const offerNow = decideOffer(policy, 'STRONG', 'cust-mercer', 450_000, 200, 0);
const sliceNow = decideSlice(policy, 'GOOD');
const action = (kind: PlanAction['kind'], authority = kind === 'DISCOUNT_FALLBACK' ? offerNow : kind === 'COLLECT_UNDISPUTED_SLICE' ? sliceNow : decideCollect(policy, 'GOOD')) =>
  ({ kind, rootId: `${kind}:inv`, revisionId: 'rev-1', termsHash: 'h1', authority, counterparty: { kind: 'CUSTOMER' as const, id: 'cust', name: 'Mercer Architects' } });
const grant = (kind: Grant['kind'], o: Partial<Grant> = {}): Grant => ({
  grantId: `g-${kind}`, kind, revisionId: 'rev-1', approvalSeq: 1, actionId: 'a1', rootId: 'COLLECT_UNDISPUTED_SLICE:inv', objectRef: 'inv', termsHash: 'h1', policyVersion: 1, scope: 's', by: 'owner',
  at: '2026-11-09T12:00:00.000Z', expiresAt: '2026-12-09T12:00:00.000Z', state: 'ACTIVE', revokedAt: null, lapsedReason: null, carriedTo: [], consumedBy: null, ...o,
});
const ctx = (o: Partial<AuthorityCtx> & Pick<AuthorityCtx, 'action' | 'current'>): AuthorityCtx => ({
  stage: 'DISPATCH', purpose: 'EFFECT', runningRevisionId: 'rev-1', now: NOW, paused: false, threadOwner: 'HEADROOM', grants: [], ownerAuth: null, invoice: { payable: true, why: '' }, ...o,
});

test('D1 fallback: decideBy = checkAt + 1 business day, same local time (hero Wed 09:00 → Thu 2026-11-12 09:00 New York)', () => {
  assert.equal(decideByOf('2026-11-11T14:00:00.000Z', TZ), '2026-11-12T14:00:00.000Z');
  assert.equal(decideByOf('2026-11-13T14:00:00.000Z', TZ), '2026-11-16T14:00:00.000Z', 'Friday → Monday');
});

test('E2 preflight: every block at every stage; policy authority for an in-limit offer; the slice spends COLLECT_SLICE, its message MESSAGE_AS_WRITTEN', () => {
  for (const stage of ['SKIP', 'QUEUE', 'DISPATCH'] as const) {
    const offer = { action: action('DISCOUNT_FALLBACK'), current: offerNow, stage };
    const ok = authorize(ctx(offer));
    assert.ok(ok.ok && ok.authority.kind === 'POLICY' && ok.authority.policyVersion === policy.version, `${stage}: A-002 in-limit offer is authorized by policy`);
    assert.deepEqual(authorize(ctx({ ...offer, paused: true })), { ok: false, code: 'PAUSED', text: 'Outreach is paused' }, `${stage}: pause → no skip, no send`);
    assert.equal((authorize(ctx({ ...offer, threadOwner: 'YOU' })) as any).code, 'YOU_TOOK_OVER', stage);
    assert.equal((authorize(ctx({ ...offer, runningRevisionId: 'rev-2' })) as any).code, 'NOT_AUTHORIZED', `${stage}: not running`);
    const tight = decideOffer(tightened, 'STRONG', 'cust-mercer', 450_000, 200, 0);
    assert.equal(tight.decision, 'EXCEPTION');
    assert.equal((authorize(ctx({ ...offer, current: tight })) as any).code, 'RULES_CHANGED', `${stage}: S5-R12 rules tightened to 1%`);
    const slice = { action: action('COLLECT_UNDISPUTED_SLICE'), current: sliceNow, stage };
    assert.equal((authorize(ctx({ ...slice, grants: [] })) as any).code, 'NOT_AUTHORIZED', `${stage}: no grant`);
    for (const g of [grant('COLLECT_SLICE', { state: 'REVOKED' }), grant('COLLECT_SLICE', { state: 'LAPSED' }), grant('COLLECT_SLICE', { state: 'CONSUMED', consumedBy: 'upd:x' }), grant('COLLECT_SLICE', { expiresAt: '2026-11-10T00:00:00.000Z' }), grant('COLLECT_SLICE', { termsHash: 'other' })])
      assert.equal((authorize(ctx({ ...slice, grants: [g] })) as any).code, 'NOT_AUTHORIZED', `${stage}: ${g.state} ${g.expiresAt} ${g.termsHash}`);
    const s = authorize(ctx({ ...slice, grants: [grant('COLLECT_SLICE')] }));
    assert.ok(s.ok && s.authority.kind === 'GRANT' && s.grant?.kind === 'COLLECT_SLICE');
    const spent = grant('COLLECT_SLICE', { state: 'CONSUMED', consumedBy: 'upd:x' });
    const good = authorize(ctx({ ...slice, purpose: 'MESSAGE', grants: [spent] }));
    assert.ok(good.ok && good.authority.kind === 'POLICY' && good.grant === null, `${stage}: a Good-tier slice message runs under policy once its update is verified`);
    const reviewFirst = decideSlice(policy, 'AT_RISK');
    assert.deepEqual(reviewFirst.grantKinds, ['COLLECT_SLICE', 'MESSAGE_AS_WRITTEN']);
    const rf = { ...slice, action: action('COLLECT_UNDISPUTED_SLICE', reviewFirst), current: reviewFirst, purpose: 'MESSAGE' as const };
    const m = authorize(ctx({ ...rf, grants: [spent, grant('MESSAGE_AS_WRITTEN')] }));
    assert.ok(m.ok && m.grant?.kind === 'MESSAGE_AS_WRITTEN', `${stage}: the review-first message spends MESSAGE_AS_WRITTEN, never COLLECT_SLICE again`);
    assert.equal((authorize(ctx({ ...rf, grants: [spent] })) as any).code, 'NOT_AUTHORIZED', `${stage}: wording not approved`);
  }
  // A provider write on an unpayable invoice holds at queue and dispatch, not at the skip decision.
  const unpayable = { action: action('DISCOUNT_FALLBACK'), current: offerNow, invoice: { payable: false, why: 'Invoice is PAID on PayPal' } };
  assert.equal((authorize(ctx({ ...unpayable, stage: 'DISPATCH' })) as any).code, 'INVOICE_NOT_PAYABLE');
  assert.equal(authorize(ctx({ ...unpayable, stage: 'SKIP' })).ok, true);
  // Owner "Send offer": single use, bound to terms; a pause is never bypassed.
  const own = { action: action('DISCOUNT_FALLBACK'), current: decideOffer(tightened, 'STRONG', 'cust-mercer', 450_000, 200, 0) };
  const o = authorize(ctx({ ...own, ownerAuth: { id: 'OWNERAUTH#a#c1', termsHash: 'h1', state: 'ACTIVE' } }));
  assert.ok(o.ok && o.authority.kind === 'OWNER');
  assert.equal((authorize(ctx({ ...own, ownerAuth: { id: 'x', termsHash: 'h1', state: 'CONSUMED' } })) as any).code, 'NOT_AUTHORIZED');
  assert.equal((authorize(ctx({ ...own, paused: true, ownerAuth: { id: 'x', termsHash: 'h1', state: 'ACTIVE' } })) as any).code, 'PAUSED');
  // Pellow's reminder runs under the delegation rule.
  const c = authorize(ctx({ action: action('COLLECT_OVERDUE'), current: decideCollect(policy, 'GOOD'), purpose: 'MESSAGE' }));
  assert.ok(c.ok && c.authority.kind === 'POLICY' && /remindersWithoutReview/.test(c.authority.winningRule!));
});

const proj = (o: Partial<InvoiceProjection>): InvoiceProjection => ({ providerDue: null, providerStatus: null, collectibleOpen: usd(0), undisputedOpen: null, disputedUnresolved: null, unallocatedCredit: null, concessions: usd(0), conservation: 'PASS', ...o });
const terms = (minor: number) => ({ askOptions: null, amount: usd(minor), contactOn: null, replyCheckOn: null, targetOn: null, discountBp: null, discountAmount: null, payBy: null, expiresOn: null, checkAt: null, maxDebit: null, payee: null, paymentVersion: null });

test('S1 progress: from receipts (paid → COMPLETED/CANCELLED; partial stays APPLIED; in flight waits)', () => {
  assert.deepEqual(progressFor({ kind: 'COLLECT_OVERDUE', state: 'APPLIED', terms: terms(760_000) }, proj({})), { kind: 'MOVE', to: 'COMPLETED', text: 'Paid in full', releaseUnsent: false, progress: null });
  assert.equal((progressFor({ kind: 'COLLECT_OVERDUE', state: 'SCHEDULED', terms: terms(760_000) }, proj({})) as any).releaseUnsent, true, 'paid before the reminder: the unsent message is released');
  const half = progressFor({ kind: 'COLLECT_UNDISPUTED_SLICE', state: 'APPLIED', terms: terms(720_000) }, proj({ collectibleOpen: usd(540_000), undisputedOpen: usd(360_000), disputedUnresolved: usd(180_000) }));
  assert.equal(half.kind, 'NONE', 'Harrow $3,600: stays APPLIED, the reader shows "Paid $3,600 of $7,200"');
  const full = progressFor({ kind: 'COLLECT_UNDISPUTED_SLICE', state: 'APPLIED', terms: terms(720_000) }, proj({ collectibleOpen: usd(180_000), undisputedOpen: usd(0), disputedUnresolved: usd(180_000) }));
  assert.equal((full as any).to, 'COMPLETED', 'slice paid while the disputed $1,800 stays open');
  assert.equal((progressFor({ kind: 'DISCOUNT_FALLBACK', state: 'WAITING_CONDITION', terms: terms(450_000) }, proj({})) as any).to, 'CANCELLED');
  assert.equal((progressFor({ kind: 'DISCOUNT_FALLBACK', state: 'HELD', terms: terms(450_000) }, proj({})) as any).to, 'CANCELLED');
  assert.equal((progressFor({ kind: 'DISCOUNT_FALLBACK', state: 'APPLIED', terms: terms(450_000) }, proj({ concessions: usd(9_000) })) as any).to, 'COMPLETED');
  assert.equal(progressFor({ kind: 'DISCOUNT_FALLBACK', state: 'WAITING_CONDITION', terms: terms(450_000) }, proj({ collectibleOpen: usd(250_000) })).kind, 'NONE');
  for (const state of ['QUEUED', 'UNCERTAIN'] as const) assert.equal(progressFor({ kind: 'COLLECT_OVERDUE', state, terms: terms(1) }, proj({})).kind, 'WAIT', `${state}: never cancelled mid-flight`);
});

test('Drafter lines (owner, 2 Nov 2026): Nova writes the greeting and sign-off; any line that could carry a fact is refused', async () => {
  const { lineProblem } = await import('./gates.ts');
  for (const ok of ['Hi Pellow team,', 'Dear Harrow Developments team,', 'Thanks so much,', 'Kind regards,', 'HELLO_TEAM', 'MANY_THANKS', 'Hi Keller Drafting Co.,', 'Dear Acme Inc. team,']) assert.equal(lineProblem(ok), null, ok);
  for (const bad of ['Please pay $7,600 by Nov 12,', 'Hi team, see https://x.example', 'Your invoice is overdue,', 'Thanks!\nP.S. 2% off', 'Write to ap@pellow.example', 'x'.repeat(61), 'We expect payment soon,', 'Thanks. Talk soon,', 'Hello team. Reply now,']) assert.ok(lineProblem(bad), bad);
});
