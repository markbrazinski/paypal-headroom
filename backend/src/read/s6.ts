// S6 read models (S06 §6.7): the Keller payout panel and the Payables row summary. Readiness is computed on read by the same
// assessPayout() the PAY job and the dispatch claim use; nothing here writes except the owner-only reveal's audit row.
import type { PayoutView, ResponseOf } from '@headroom/contracts';
import { K } from '../adapters/store/keys.ts';
import type { Item } from '../adapters/store/port.ts';
import { ApiError } from '../api-error.ts';
import { oblSk, parseOccKey, payoutFeeEstimateMinor } from '../domain/obligations/obligations.ts';
import { payeeSk, type PayeeItem } from '../domain/payables/payee.ts';
import { feeCeilingMinor, maxDebitMinor } from '../domain/payables/payout-core.ts';
import { assessPayout, type Assessment, type PayEff } from '../domain/payables/payout.ts';
import { dayName } from '../domain/plan/candidates.ts';
import { loadPlanState, type ActItem, type PlanState } from '../domain/plan/state.ts';
import { fundsInputs, type ReadCtx } from './models.ts';

const usd = (minor: number) => ({ currency: 'USD' as const, minor });
const signed = (minor: number | null) => (minor === null ? null : { currency: 'USD' as const, minor });
const dollars = (m: number) => `$${(m / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const NOT_COUNTED = ['Promises and stated receipts', "Money in your bank: it can't fund PayPal payouts", "Captured money PayPal hasn't confirmed yet (upper figure only)"];

/** The payout action for an occurrence: in flight or done in any revision, else the running revision's, else the newest draft's. */
function actionFor(s: PlanState, occKey: string): ActItem | undefined {
  const mine = s.actions.filter((a) => a.kind === 'PAYOUT' && a.subject.occurrenceKey === occKey && a.decision === 'IN' && a.state !== 'SUPERSEDED' && a.state !== 'REMOVED');
  const n = (a: ActItem) => s.revisions.find((r) => r.revisionId === a.revisionId)?.n ?? 0;
  const executed = mine.filter((a) => ['QUEUED', 'UNCERTAIN', 'APPLIED', 'COMPLETED', 'FAILED'].includes(a.state)).sort((a, z) => n(z) - n(a))[0];
  return executed ?? mine.find((a) => a.revisionId === s.plan.running) ?? mine.sort((a, z) => n(z) - n(a))[0];
}

type Pill = PayoutView['pill'];
function pillOf(e: PayEff | undefined, a: ActItem | undefined, as: Assessment | null, today: string, payBy: string, paused: boolean): { pill: Pill; text: string } {
  if (e) {
    if (e.state === 'PAID') return { pill: 'PAID', text: 'Paid · PayPal confirmed the payment reached the supplier' };
    if (e.state === 'REFUNDED') return { pill: 'NOT_PAID', text: `Returned after payment (${e.itemStatus?.toLowerCase().replace(/_/g, ' ')}) · bill open again` };
    if (e.state === 'NOT_PAID' || e.state === 'HOLD' || e.state === 'NOT_PAID_FINAL') return { pill: 'NOT_PAID', text: `Not paid · ${e.state === 'HOLD' ? 'PayPal shows a different payment' : (e.itemStatus ?? 'item').toLowerCase().replace(/_/g, ' ')}` };
    if (e.state === 'UNKNOWN' || e.state === 'DISPATCHED' || e.state === 'UNKNOWN_UNRESOLVED') return { pill: 'UNKNOWN', text: e.state === 'UNKNOWN_UNRESOLVED' ? "Unknown · can't confirm with PayPal · needs you" : `Unknown · checking with PayPal${e.heldReason ? ` · ${e.heldReason.replace(/^Unknown · /, '')}` : ''}` };
    if (e.state === 'SUBMITTED') return { pill: 'SUBMITTED', text: 'Sent to PayPal · waiting for the item' };
    if (e.state === 'READY') return { pill: 'RESERVED', text: 'Reserved on PayPal · sending' };
  }
  if (!a) return { pill: 'NO_PLAN', text: 'Headroom pays only payments you approve in a plan' };
  if (paused) return { pill: 'PAUSED', text: 'Paused · payments are paused' };
  if (as?.hold?.code === 'WAITING_FOR_REPORT') return { pill: 'WAITING_FOR_REPORT', text: as.hold.text };
  if (as?.fundedNeedsApproval || a.state === 'PROPOSED') return { pill: 'FUNDED_NEEDS_APPROVAL', text: as?.hold?.code === 'PAYEE_UNCONFIRMED' ? as.hold.text : `Needs your approval · ${as?.hold?.text ?? 'approve it in the plan'}` };
  if (as?.hold) return { pill: 'HELD', text: as.hold.text };
  if (today >= payBy) return { pill: 'READY', text: 'Ready · Headroom pays at its next check' };
  return { pill: 'NOT_DUE', text: `Ready · Headroom pays ${dayName(payBy)} 09:00 through PayPal Payouts` };
}

/** One PayPal-payout occurrence (UI-AP-03/04/06). `s`: the plan state, shared across rows of one read. */
export async function payoutView(c: ReadCtx, s: PlanState, occKey: string): Promise<PayoutView> {
  const occ = s.f.r.occurrences.find((o) => o.occurrenceKey === occKey);
  const cmt = occ && s.f.r.commitments.find((x) => x.commitmentId === occ.commitmentId);
  if (!occ || !cmt || cmt.rail !== 'PAYPAL_PAYOUT' || !cmt.supplierId) throw new ApiError(404, 'NOT_FOUND', 'No such PayPal payout');
  const p = parseOccKey(occKey)!;
  const [obl, payee] = await Promise.all([c.store.get('core', s.pk, oblSk(p.commitmentId, p.n)), c.store.get('core', s.pk, payeeSk(cmt.supplierId)) as Promise<PayeeItem | undefined>]);
  const effKey: string | undefined = (obl as Item | undefined)?.payment?.effectKey ?? (obl as Item | undefined)?.lastEffectKey;
  const e = effKey ? ((await c.store.get('work', K.effect(effKey), 'EFFECT')) as PayEff | undefined) : undefined;
  const a = actionFor(s, occKey);
  const settled = e && ['PAID', 'REFUNDED', 'SUBMITTED', 'NOT_PAID', 'HOLD', 'UNKNOWN', 'UNKNOWN_UNRESOLVED', 'DISPATCHED'].includes(e.state);
  const as = a && !settled ? await assessPayout({ store: c.store, now: () => c.now }, s, a) : null;
  const face = occ.amount.minor;
  const pill = pillOf(e, a, as, s.f.today, occ.dueOn, s.policy.pauses.payments && !settled);
  const inReport = !!e && e.state === 'PAID' && !!(await fundsInputs(c)).estimate?.payouts.find((x) => x.effectKey === e.effectKey)?.reported;
  const bill = occ.substantiatedBy ? s.f.r.bills.find((b) => b.billId === occ.substantiatedBy) : undefined;
  return {
    occurrenceKey: occKey, supplier: { id: cmt.supplierId, name: s.f.r.suppliers.find((x) => x.supplierId === cmt.supplierId)?.displayName ?? cmt.supplierId }, name: cmt.name,
    billRef: bill?.billNumber ?? null, billId: bill?.billId ?? null,
    payee: payee ? { masked: payee.masked, state: payee.state, version: payee.version } : null,
    amount: usd(face), feeCeiling: usd(feeCeilingMinor(face)), maxDebit: usd(maxDebitMinor(face)), feeEstimate: usd(payoutFeeEstimateMinor(face)), payBy: occ.dueOn,
    pill: pill.pill, pillText: pill.text, status: e?.heldReason ?? e?.failure ?? a?.heldReasons[0] ?? pill.text,
    readiness: as && {
      checkedAt: as.checkedAt,
      rail: { verdict: as.rail.verdict, lower: signed(as.rail.lowerMinor), upper: signed(as.rail.upperMinor), need: usd(as.rail.needMinor), short: as.rail.shortMinor === null ? null : usd(as.rail.shortMinor), asOf: as.asOf, fetchedAt: as.fetchedAt, otherReserved: usd(as.otherReservedMinor), usable: signed(as.rail.lowerMinor), remainingAfter: signed(as.rail.lowerMinor === null ? null : as.rail.lowerMinor - as.rail.needMinor), reasons: as.rail.reasons },
      company: { verdict: as.company.verdict, min: as.company.min && { amount: { currency: 'USD', minor: as.company.min.amountMinor }, on: as.company.min.on }, reserve: { currency: 'USD', minor: s.f.reserveMinor }, reasons: as.company.reasons },
      checks: as.checks.map((x) => ({ key: x.key, ok: x.ok, text: x.text })),
      notCounted: NOT_COUNTED,
      toReady: [...as.checks.filter((x) => !x.ok).map((x) => x.text), ...(as.rail.verdict === 'PASS' ? [] : as.rail.reasons), ...(as.company.verdict === 'PASS' ? [] : as.company.reasons)],
    },
    action: a ? { actionId: a.actionId, revisionId: a.revisionId, revisionN: s.revisions.find((r) => r.revisionId === a.revisionId)?.n ?? 0, state: a.state } : null,
    effect: e ? {
      state: e.state, senderBatchId: e.senderBatchId, batchId: e.batchId, itemId: e.itemId, itemStatus: e.itemStatus, transactionId: e.transactionId, fee: e.fee, timeProcessed: e.timeProcessed,
      unknownSince: e.unknownSince, mutationDeadline: e.mutationDeadline, failure: e.failure, heldReason: e.heldReason, inReport, timeline: e.timeline,
    } : null,
  };
}

export async function getPayout(c: ReadCtx, occKey: string): Promise<ResponseOf<'getPayout'>> {
  return payoutView(c, await loadPlanState(c), occKey);
}

/** Payables rows (UI-AP-01): pill and permission for each PayPal-payout obligation in the horizon. */
export async function withPayouts(c: ReadCtx, res: ResponseOf<'listPayables'>): Promise<ResponseOf<'listPayables'>> {
  const rows = res.obligations.filter((o) => o.rail === 'PAYPAL_PAYOUT' && !o.afterHorizon);
  if (!rows.length) return res;
  const s = await loadPlanState(c);
  const out = new Map<string, NonNullable<ResponseOf<'listPayables'>['obligations'][number]['payout']>>();
  for (const r of rows) {
    // A row whose payout view fails keeps payout: null (the grid shows "—"), and the failure is logged, never silent.
    const v = await payoutView(c, s, r.occurrenceKey).catch((e) => { console.error(JSON.stringify({ level: 'error', msg: 'payout view failed', occurrenceKey: r.occurrenceKey, error: String(e) })); return null; });
    if (!v) continue;
    const auth = v.readiness?.checks.find((x) => x.key === 'authority');
    const limits = v.readiness?.checks.find((x) => x.key === 'limits');
    const permission = !v.action ? 'Not in a plan' : v.effect && v.effect.state !== 'CANCELLED_UNSENT' && v.effect.state !== 'REJECTED' ? `Approved by you · revision ${v.action.revisionN}`
      : auth?.ok ? `${auth.text}${limits && !limits.ok ? ` · ${limits.text}` : ''}` : `Needs you · ${limits && limits.text.startsWith('Needs') ? limits.text.replace(/^Needs a one-time exception: /, 'over ') : 'payout authority'}`;
    out.set(r.occurrenceKey, { pill: v.pill, pillText: v.pillText, permission, checkedAt: v.readiness?.checkedAt ?? null, paidRef: v.effect?.state === 'PAID' ? `${dollars(v.amount.minor)} confirmed by PayPal` : null });
  }
  return { ...res, obligations: res.obligations.map((o) => (out.has(o.occurrenceKey) ? { ...o, payout: out.get(o.occurrenceKey)! } : o)) };
}
