// The plan's view of a run (S04 §6.2, §6.17 R1/R2): one load of the run partition's S4 records plus the operative forecast,
// the basis hash a build is deduplicated on, the inputs for candidate generation, and grant coverage.
// ponytail: computed on read like S1–S3; ceiling the 1 MB Query page.
import { createHash } from 'node:crypto';
import { EXECUTED_ACTION_STATES, type CaptureReceipt, type Customer, type Grant, type HistoryEntry, type ClaimSplit, type PlanAction, type PlanBuild, type PlanRevision, type Policy, type Tier } from '@headroom/contracts';
import { K } from '../../adapters/store/keys.ts';
import type { Item, Op } from '../../adapters/store/port.ts';
import { runForecast, type ReadCtx } from '../../read/models.ts';
import type { ForecastModel } from '../../read/s3.ts';
import type { InvItem } from '../receivables/commands.ts';
import { assess, type Assessment } from '../relationships/assess.ts';
import { liveHistory } from '../relationships/live.ts';
import { payoutFeeEstimateMinor, parseOccKey } from '../obligations/obligations.ts';
import { addDays } from '../time.ts';
import { dayName, money, type Candidate, type PlanInputs } from './candidates.ts';
import { DEFAULT_WHY, renderWhy } from './gates.ts';
import { askOptions } from '../obligations/supplier-answer.ts';

export type PolicyItem = Policy & Item;
export type PlanRoot = Item & { version: number; basisStamp: number; running: string | null; draft: string | null; nextN: number };
export type BuildItem = PlanBuild & Item;
export type RevItem = PlanRevision & Item;
export type ActItem = PlanAction & Item;
export type GrantItem = Grant & Item;

export interface PlanState {
  ctx: ReadCtx;
  pk: string;
  f: ForecastModel;
  policy: PolicyItem;
  plan: PlanRoot;
  builds: BuildItem[];
  revisions: RevItem[];
  actions: ActItem[];
  grants: GrantItem[];
  invoices: InvItem[];
  customers: Customer[];
  claims: ClaimSplit[];
  history: HistoryEntry[];
  assessments: Map<string, Assessment>;
  /** S5: allocations by claim (ALLOC#), outbound messages, skip checks and per-customer threads. */
  allocs: Item[];
  outs: Item[];
  checks: Item[];
  threads: Item[];
  /** S6: supplier PayPal payees (`PAYEE#`). */
  payees: Item[];
  /** S7 R4/R5: dispute stops (`DISPUTEPENDING#`) and consumed disputed-collection allowances (`DISPALLOW#`). */
  disputes: Item[];
  dispAllow: Item[];
  /** S7 R6: supplier answers (`SUPPLIERANSWER#`). */
  answers: Item[];
  /** S7 R9 contact slots (`CONTACT#<businessKey>`): the last confirmed send per business, for the spacing rule at plan time. */
  contacts: Item[];
  /** Verified PayPal receipts (`RCPT#`), for the running plan's "since you approved" lines. */
  receipts: (CaptureReceipt & Item)[];
}

export async function loadPlanState(c: ReadCtx): Promise<PlanState> {
  const pk = K.run(c.tenantId, c.run.runId);
  const [f, items] = await Promise.all([runForecast(c), c.store.query('core', pk)]);
  const by = <T>(p: string) => items.filter((i) => i.sk.startsWith(p)) as unknown as T[];
  // S7 R8: seeded history plus live facts from PayPal receipts, confirmed disputes and missed promises.
  const history = [...by<HistoryEntry>('HIST#'), ...liveHistory(items, f.today, c.run.settings.timeZone)];
  const customers = by<Customer>('CUST#');
  const ids = new Set([...customers.map((x) => x.customerId), ...f.r.suppliers.map((x) => x.supplierId)]);
  return {
    ctx: c, pk, f,
    policy: items.find((i) => i.sk === 'POLICY') as PolicyItem,
    plan: items.find((i) => i.sk === 'PLAN') as PlanRoot,
    builds: by<BuildItem>('BUILD#'), revisions: by<RevItem>('REV#'), actions: by<ActItem>('ACT#'), grants: by<GrantItem>('GRANT#'),
    invoices: by<InvItem>('INV#'), customers, claims: by<ClaimSplit>('CLAIM#'), history, allocs: by<Item>('ALLOC#'), outs: by<Item>('OUTMSG#'), checks: by<Item>('CHECK#'), threads: by<Item>('THREAD#'), payees: by<Item>('PAYEE#'), disputes: by<Item>('DISPUTEPENDING#'), dispAllow: by<Item>('DISPALLOW#'), answers: by<Item>('SUPPLIERANSWER#'), contacts: by<Item>('CONTACT#'), receipts: by<CaptureReceipt & Item>('RCPT#'),
    assessments: new Map([...ids].map((id) => [id, assess(history.filter((h) => h.counterpartyId === id))])),
  };
}

const sha = (x: unknown) => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const OPEN_STATES = ['ISSUING', 'ISSUE_UNKNOWN', 'ISSUED', 'PARTIALLY_PAID', 'FAILED'];

/**
 * What a plan would propose depends on (S04 T2): business today, operative occurrences in the horizon, stated inflows, open
 * invoices, claims, delegation rules (not pauses), reserve and need-by. Balance observations are excluded: figures reprice on read.
 * null when there is nothing to plan (no opening, or no breach).
 */
export function basisHashOf(s: PlanState): string | null {
  const f = s.f;
  if (!f.summary?.firstBelowReserve) return null;
  const end = addDays(f.today, 41);
  return sha({
    today: f.today, reserve: f.reserveMinor, needBy: f.summary.firstBelowReserve,
    occ: f.r.occurrences.filter((o) => o.dueOn <= end).map((o) => [o.occurrenceKey, o.dueOn, o.amount.minor, o.version]).sort(),
    inflows: f.r.inflows.map((i) => [i.inflowId, i.on, i.amount.minor, i.invoiceId ?? null]).sort(),
    invoices: s.invoices.filter((i) => OPEN_STATES.includes(i.state)).map((i) => [i.invoiceId, i.state, i.openGross.minor]).sort(),
    claims: s.claims.map((c) => [c.invoiceId, c.undisputed.minor, c.disputed.minor]).sort(),
    disputes: s.disputes.map((x) => [x.invoiceId, x.state, x.proposalId]).sort(),
    // S7 R8: a label change changes treatment (discount tiers, review-first), so the plan goes stale.
    assessment: [...s.assessments].map(([id, a]) => [id, a.tier]).sort(),
    dispAllow: s.dispAllow.map((x) => [x.invoiceId, x.allowedMinor]).sort(),
    rules: sha([s.policy.rules, s.policy.tiers, s.policy.exceptions]),
  });
}

export { basisBumpOp } from '../../adapters/store/keys.ts';

export function planInputs(s: PlanState): PlanInputs | null {
  const f = s.f;
  const needBy = f.summary?.firstBelowReserve;
  if (!f.days || !f.summary || !needBy) return null;
  const name = (id: string) => s.customers.find((x) => x.customerId === id)?.displayName ?? id;
  const tierOf = (id: string) => { const a = s.assessments.get(id)!; return { tier: a.tier as Tier, label: a.label, factorText: a.factors.map((x) => `${x.factor}: ${x.value}`).join(' · ') }; };
  const end = addDays(f.today, 41);
  const terms = (key: string) => f.r.terms.find((t) => t.occurrenceKey === key);
  return {
    now: s.ctx.now, tz: s.ctx.run.settings.timeZone, today: f.today, needBy,
    needByClose: f.days.find((d) => d.on === needBy)!.closeMinor, gapMinor: f.summary.reserveGapMinor,
    invoices: s.invoices.filter((i) => OPEN_STATES.includes(i.state)).map((i) => {
      const claim = s.claims.find((c) => c.invoiceId === i.invoiceId);
      const al = s.allocs.filter((a) => a.invoiceId === i.invoiceId);
      const und = al.filter((a) => a.claim === 'UNDISPUTED').reduce((t, a) => t + a.amount.minor, 0);
      const allowed = Number(s.dispAllow.find((x) => x.invoiceId === i.invoiceId)?.allowedMinor ?? 0);
      const bk = (s.customers.find((x) => x.customerId === i.customerId) as { businessKey?: string } | undefined)?.businessKey ?? i.customerId;
      const lastContactAt = (s.contacts.find((x) => x.sk === `CONTACT#${bk}`)?.lastSentAt as string | null | undefined) ?? null;
      return { lastContactAt, disputePending: s.disputes.some((x) => x.invoiceId === i.invoiceId && x.state === 'PENDING'), disputedAskableMinor: claim ? Math.max(0, claim.disputed.minor - allowed) : null, invoiceId: i.invoiceId, number: i.invoiceNumber, customerId: i.customerId, customerName: name(i.customerId), state: i.state, amountMinor: i.amount.minor, openMinor: i.openGross.minor, dueOn: i.dueOn, failureReason: i.failureReason,
        undisputedOpenMinor: claim ? Math.max(0, claim.undisputed.minor - und) : null, unattributed: !!claim && al.some((a) => (a.claim ?? 'WHOLE') === 'WHOLE') };
    }),
    doneRoots: new Map(s.actions.filter((a) => EXECUTED_ACTION_STATES.includes(a.state)).map((a) => [a.rootId, a.state])),
    claims: s.claims, inflows: f.r.inflows, policy: s.policy,
    tiers: new Map(s.customers.map((x) => [x.customerId, tierOf(x.customerId)])),
    payouts: f.r.occurrences.filter((o) => o.dueOn <= end && o.dueOn >= f.today).flatMap((o) => {
      const c = f.r.commitments.find((x) => x.commitmentId === o.commitmentId);
      if (!c || c.rail !== 'PAYPAL_PAYOUT' || !c.supplierId) return [];
      const t = terms(o.occurrenceKey);
      const bill = o.substantiatedBy ? f.r.bills.find((b) => b.billId === o.substantiatedBy) : undefined;
      const pe = s.payees.find((p) => p.supplierId === c.supplierId);
      const stored = f.r.stored.get(o.occurrenceKey);
      return [{
        payee: pe ? { version: pe.version, receiverSha256: pe.receiverSha256, masked: pe.masked, confirmed: pe.state === 'CONFIRMED' } : null,
        // A payment version whose grants were spent at a dispatch claim is never consented again (R5/R7): the claim moves this on.
        paymentVersion: stored?.nextPaymentVersion ?? 1,
        paid: o.payment?.stage === 'PAID' ? 'paid through PayPal' : null,
        occurrenceKey: o.occurrenceKey, supplierId: c.supplierId, supplierName: f.r.suppliers.find((x) => x.supplierId === c.supplierId)?.displayName ?? c.supplierId, name: c.name,
        dueOn: o.dueOn, amountMinor: o.amount.minor, feeMinor: payoutFeeEstimateMinor(o.amount.minor), billRef: bill?.billNumber ?? null, billId: bill?.billId ?? null,
        termsId: t ? t.sk : null, termsText: t?.before ? `${t.changedFields.map((k: string) => (k === 'dueOn' ? `${dayName(t.before.dueOn)} → ${dayName(t.after.dueOn)}` : `${money(t.before.amount.minor)} → ${money(t.after.amount.minor)}`)).join(', ')} · accepted ${t.by === 'HEADROOM' ? 'by your Delegation rule' : 'by you'}` : null,
      }];
    }),
    // S7 R6: a supplier whose accepted terms moved a payment earlier, into the shortfall: one ask per (payment, terms version),
    // never again once an answer was accepted. Only suppliers with a known contact.
    asks: f.r.occurrences.filter((o) => o.dueOn < o.scheduledOn && o.dueOn <= needBy && !o.payment && !!o.substantiatedBy).flatMap((o) => {
      const c = f.r.commitments.find((x) => x.commitmentId === o.commitmentId);
      const sup = c?.supplierId ? f.r.suppliers.find((x) => x.supplierId === c.supplierId) : undefined;
      const bill = f.r.bills.find((b) => b.billId === o.substantiatedBy);
      if (!c || c.rail !== 'PAYPAL_PAYOUT' || !sup?.contactEmail || bill?.state !== 'TERMS_ACCEPTED') return [];
      if (s.answers.some((x) => String(x.askId).startsWith(`ASK:${o.occurrenceKey}:`) && x.state === 'ACCEPTED')) return [];
      return [{ occurrenceKey: o.occurrenceKey, supplierId: sup.supplierId, supplierName: sup.displayName, termsVersion: f.r.stored.get(o.occurrenceKey)?.termsVersion ?? 0, dueOn: o.dueOn, scheduledOn: o.scheduledOn, amountMinor: o.amount.minor, billRef: bill.billNumber, options: askOptions(f, o) }];
    }),
  };
}

/** What a grant is bound to: the action's terms, condition and wording (a changed message is a changed term for MESSAGE_AS_WRITTEN). */
export const termsHashOf = (a: Pick<PlanAction, 'rootId' | 'terms' | 'condition' | 'message'>) => sha([a.rootId, a.terms, a.condition?.checkAt ?? null, a.message?.body ?? null]);

export const GRANT_DAYS = 30;
/** §6.17 R2. EXPIRED is computed here, never stored. */
export const grantExpired = (g: Grant, now: string) => now >= g.expiresAt;
export function grantCovers(g: Grant, a: Pick<PlanAction, 'rootId' | 'termsHash' | 'revisionId' | 'authority'>, now: string): boolean {
  return g.state === 'ACTIVE' && !grantExpired(g, now) && g.rootId === a.rootId && g.termsHash === a.termsHash
    && a.authority.grantKinds.includes(g.kind) && (g.revisionId === a.revisionId || g.carriedTo.includes(a.revisionId));
}
export const missingKinds = (a: ActItem, grants: Grant[], now: string) => a.authority.grantKinds.filter((k) => !grants.some((g) => g.kind === k && grantCovers(g, a, now)));

/** The state an approved action waits in: fallbacks wait on their condition; payouts and collections wait for their due job (S6). */
export const approvedState = (a: Pick<PlanAction, 'kind' | 'condition'>) => (a.condition ? 'WAITING_CONDITION' : 'SCHEDULED');

export function actionFrom(c: Candidate, revisionId: string, i: number, extra: Partial<PlanAction>): PlanAction {
  const a: PlanAction = {
    actionId: `${revisionId}-a${i + 1}`, rootId: c.rootId, revisionId, kind: c.kind, counterparty: c.counterparty, subject: c.subject, terms: c.terms, estimate: c.estimate,
    condition: c.condition, late: c.late, why: { text: renderWhy(c, DEFAULT_WHY[c.kind]), codes: DEFAULT_WHY[c.kind], citations: c.sources.map((x) => x.n), writtenBy: 'TEMPLATE' }, message: null, sources: c.sources,
    alternatives: c.alternatives, authority: c.authority, decision: 'IN', consideredReason: null, removedReason: null, ownerEdited: [], staleEdits: [], heldReasons: c.heldReasons,
    state: 'PROPOSED', termsHash: '', version: 1, order: i + 1,
    intentVersion: 0, holdCode: null, progress: null, decideBy: null, lastCheckId: null, expiry: null, followUpOf: null, ...extra,
  };
  return { ...a, termsHash: termsHashOf(a) };
}

export const occName = (s: PlanState, key: string) => { const p = parseOccKey(key); return s.f.r.commitments.find((c) => c.commitmentId === p?.commitmentId)?.name ?? key; };

/** Concessions of the other live offers in a revision (S4-IM-02): included, not removed, a different root. */
export const otherConcessionsMinor = (acts: Pick<PlanAction, 'kind' | 'decision' | 'state' | 'rootId' | 'terms'>[], rootId: string) =>
  acts.filter((x) => x.kind === 'DISCOUNT_FALLBACK' && x.decision === 'IN' && x.state !== 'REMOVED' && x.state !== 'SUPERSEDED' && x.rootId !== rootId).reduce((t, x) => t + (x.terms.discountAmount?.minor ?? 0), 0);
