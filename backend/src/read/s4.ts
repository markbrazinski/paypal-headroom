// S4 read models (S04 T4, T10–T12): Plan, revision, Delegation, relationships, forecast scenarios and comparisons, the Overview
// plan card and plan needs. Computed on read from the stored revision + current records; the UI never computes cash or authority.
import { EXECUTED_ACTION_STATES } from '@headroom/contracts';
import type { ActionCard, GrantKind, LocalDate, NeedRow, PlanAction, PolicyValue, ResponseOf, RevisionView } from '@headroom/contracts';
import { ApiError } from '../api-error.ts';
import { K } from '../adapters/store/keys.ts';
import { summaryDto, type ForecastModel } from './s3.ts';
import * as read from './models.ts';
import { nextBusinessMidnight } from './models.ts';
import type { ReadCtx } from './models.ts';
import { dayName, localTime, money } from '../domain/plan/candidates.ts';
import { changesOf } from '../domain/plan/edit.ts';
import { outlookRowsFor, priceRows, SCENARIO_BASIS, scenarioChanges } from '../domain/plan/outlook.ts';
import { basisHashOf, grantCovers, grantExpired, loadPlanState, missingKinds, occName, type ActItem, type PlanState, type RevItem } from '../domain/plan/state.ts';
import { consentOf, KIND_TEXT } from '../domain/plan/commands.ts';
import { currentDecision } from '../domain/plan/authority.ts';
import { authorityUnder, sameDecision } from '../domain/delegation/commands.ts';
import { discountLimits, HARD_STOPS, loosenedFromDefault, resolve, ruleOf, ruleText, safetyNotices } from '../domain/delegation/policy.ts';
import { ENFORCED_LATER, normalizeValue, RULE_SPECS } from '../domain/delegation/specs.ts';
import { TIER_DOTS, TIER_LABEL } from '../domain/relationships/assess.ts';
import { addDays } from '../domain/time.ts';


const usd = (minor: number) => ({ currency: 'USD' as const, minor });
const actsOf = (s: PlanState, revisionId: string) => s.actions.filter((a) => a.revisionId === revisionId).sort((a, z) => a.order - z.order);
const revOf = (s: PlanState, id: string | null) => (id ? s.revisions.find((r) => r.revisionId === id) : undefined);
const live = (a: PlanAction) => a.decision === 'IN' && a.state !== 'REMOVED' && a.state !== 'SUPERSEDED';
const APPROVED = ['SCHEDULED', 'WAITING_CONDITION', 'HELD', 'HELD_EVIDENCE'];
/** UX repair (F01/§11): a finished action's money is already in the actuals (a receipt) or never comes (skipped, expired), so
 * projections never add its target again (no double counting). */
const FINISHED = ['COMPLETED', 'SKIPPED_NOT_NEEDED', 'CANCELLED', 'EXPIRED', 'FAILED'];
const pending = (a: PlanAction) => live(a) && !FINISHED.includes(a.state);

/** The latest accepted bill change (TERMS# with a before), for the impact header and the BEFORE_BILL comparison. */
function lastAcceptance(f: ForecastModel) {
  const t = [...f.r.terms].filter((x) => x.before).sort((a, z) => (a.at < z.at ? 1 : -1))[0];
  if (!t) return null;
  const bill = f.r.bills.find((b) => b.billId === t.billId);
  const sup = bill ? f.r.suppliers.find((x) => x.supplierId === bill.supplierId)?.displayName ?? bill.supplierName : null;
  const what = t.changedFields.map((k: string) => (k === 'dueOn' ? `${dayName(t.before.dueOn)} → ${dayName(t.after.dueOn)}` : `${money(t.before.amount.minor)} → ${money(t.after.amount.minor)}`)).join(', ');
  return { id: `before:${t.sk.replace(/^TERMS#/, '')}`, text: `${sup ?? 'Supplier'} bill ${bill?.billNumber ?? ''}: ${what}, accepted by you ${dayName(t.at)}`.replace('  ', ' '), change: { kind: 'REPLACE' as const, occurrenceKey: t.occurrenceKey, dueOn: t.before.dueOn as LocalDate, amountMinor: t.before.amount.minor as number } };
}

function card(s: PlanState, rev: RevItem, a: ActItem): ActionCard {
  const now = s.ctx.now;
  const a2 = s.assessments.get(a.counterparty.id);
  const grants = s.grants.filter((g) => g.rootId === a.rootId && (g.revisionId === rev.revisionId || g.carriedTo.includes(rev.revisionId)));
  const missing = missingKinds(a, s.grants, now);
  // S4-IM-05: authority comes from current grant coverage, not the stored state: an approved action whose grant expired needs renewal.
  const needsApproval = a.decision === 'IN' && (a.state === 'PROPOSED' || APPROVED.includes(a.state)) && missing.length > 0;
  const lapsed = needsApproval && APPROVED.includes(a.state);
  const now2 = a.authority.policyVersion !== s.policy.version ? authorityUnder(s.policy, s, a) : null;
  const authorityNow = now2 && !sameDecision(now2, a.authority) ? now2 : null;
  const au = a.authority;
  const approvedAt = rev.approvedAt && (APPROVED.includes(a.state) || EXECUTED_ACTION_STATES.includes(a.state)) ? dayName(rev.approvedAt) : null;
  const authorityTag = au.decision === 'BLOCK' ? { tone: 'BLOCKED' as const, text: `Not allowed · ${au.reasons[0]}` }
    : lapsed ? { tone: 'NEEDS_YOU' as const, text: 'Approval expired · renew it to keep this scheduled' }
    : approvedAt && au.grantKinds.length ? { tone: 'APPROVED' as const, text: `Approved by you · ${approvedAt}` }
    : au.decision === 'ALLOW' ? { tone: 'DELEGATION' as const, text: `Within delegation · Delegation v${au.policyVersion}` }
    : au.decision === 'EXCEPTION' ? { tone: 'EXCEPTION' as const, text: `Exception · ${au.reasons.find((r) => /above/.test(r)) ?? au.reasons[0]}` }
    : { tone: 'NEEDS_YOU' as const, text: `Needs you · ${au.reasons[0]}` };
  const t = a.terms;
  const stateText = lapsed ? 'Approval expired · needs your approval again; nothing runs on an expired permission'
    : a.state === 'PROPOSED' ? (a.decision === 'OUT' ? `Considered, not used · ${a.consideredReason ?? ''}` : needsApproval ? 'Proposed · needs your approval' : 'Proposed · runs under your delegation once you approve the revision')
    : a.state === 'REMOVED' ? `Removed by you${a.removedReason ? ` · ${a.removedReason}` : ''}`
    : a.state === 'SUPERSEDED' ? 'Superseded by a later revision'
    : lifecycleText(a, s.ctx.run.settings.timeZone);
  // UX repair: a finished action reads as what happened, not as a projection.
  const rcpts = s.receipts.filter((r) => r.invoiceId === a.subject.invoiceId);
  const cashEffect = a.state === 'COMPLETED' && a.kind !== 'PAYOUT' && rcpts.length ? `Received · ${money(rcpts.reduce((x, r) => x + r.gross.minor, 0))} paid on PayPal, ${money(rcpts.reduce((x, r) => x + r.net.minor, 0))} after PayPal's fee; counted in your cash now`
    : a.state === 'COMPLETED' && a.kind === 'PAYOUT' ? `Paid · −${money(t.amount.minor)} left PayPal; the bill no longer appears as due`
    : a.state === 'SKIPPED_NOT_NEEDED' ? `None · the offer was never sent, so no discount was given (${money(t.discountAmount?.minor ?? 0)} kept)`
    : a.kind === 'PAYOUT' ? `Already in the forecast: −${money(t.amount.minor)} on ${dayName(t.payBy!)}`
    : a.kind === 'ASK_SUPPLIER' ? 'Changes nothing in the forecast until you accept the supplier’s answer'
    : `Not counted in Expected. If paid by ${dayName(t.targetOn!)}: +${money(a.estimate!.net.minor)} net (${money(a.estimate!.gross.minor)} less an estimated ${money(a.estimate!.fee.minor)} fee)${a.kind === 'DISCOUNT_FALLBACK' ? `; replaces the stated date for this invoice; costs ${money(t.discountAmount!.minor)}` : ''}`;
  const pause = a.kind === 'PAYOUT' ? (s.policy.pauses.payments ? "Paused · won't run while 'Pause all payment preparation' is on" : null) : s.policy.pauses.outreach ? "Paused · won't run while 'Pause all outreach' is on" : null;
  // S5-D12: what was dispatched or finished is history: no edit, remove or swap.
  const editable = (rev.state === 'DRAFT' || rev.state === 'RUNNING') && !EXECUTED_ACTION_STATES.includes(a.state);
  const out = s.outs.find((o) => o.rootId === a.rootId && o.intentVersion === a.intentVersion);
  const chk = a.lastCheckId ? s.checks.find((c) => c.sk === a.lastCheckId) : undefined;
  const tz = s.ctx.run.settings.timeZone;
  const fields: ActionCard['editable'] = !editable || a.state === 'REMOVED' || a.state === 'SUPERSEDED' ? [] : a.kind === 'COLLECT_OVERDUE' ? ['contactOn', 'targetOn', 'message'] : a.kind === 'COLLECT_UNDISPUTED_SLICE' ? ['contactOn', 'targetOn', 'amountMinor', 'message'] : a.kind === 'DISCOUNT_FALLBACK' ? ['discountBp', 'message'] : [];
  const { pk: _p, sk: _s, ...rest } = a;
  return {
    ...rest, authorityTag, needsApproval, authorityNow, stateText, cashEffect, paused: pause,
    relationship: a2 ? { tier: a2.tier, label: a2.label, dots: a2.dots, meaning: s.policy.tiers.find((x) => x.tier === a2.tier)?.meaning ?? '' } : null,
    grants: grants.map((g) => ({ grantId: g.grantId, kind: g.kind, text: KIND_TEXT[g.kind], state: g.state === 'ACTIVE' && grantExpired(g, now) ? 'EXPIRED' : g.state })),
    editable: fields, canRemove: editable && live(a), canRestore: editable && a.state === 'REMOVED', canAsk: editable && a.decision === 'OUT' && a.state === 'PROPOSED' && !!a.consideredReason && au.decision !== 'BLOCK',
    invoiceNumber: s.invoices.find((i) => i.invoiceId === a.subject.invoiceId)?.invoiceNumber ?? null,
    messageState: !a.message || !out ? null : { state: out.state, label: messageLabel(out as never), held: !!out.held, reason: out.reason ?? null, to: out.to || null, preparedFor: out.preparedFor ?? null },
    check: !chk ? null : {
      checkId: chk.sk, at: chk.at, decision: chk.decision, early: !!chk.early, reserve: usd(chk.inputs.reserveMinor), blockers: chk.blockers.map((b: { text: string }) => b.text),
      lowerMin: chk.lowerMin ? { on: chk.lowerMin.on, close: { currency: 'USD', minor: chk.lowerMin.closeMinor } } : null,
      upperMin: chk.upperMin ? { on: chk.upperMin.on, close: { currency: 'USD', minor: chk.upperMin.closeMinor } } : null,
      sources: `Bank ${chk.inputs.bank.amountMinor === null ? 'not read' : money(chk.inputs.bank.amountMinor)}${chk.inputs.bank.retrievedAt ? ` read ${localTime(chk.inputs.bank.retrievedAt, tz)}` : ''} · PayPal verified ${chk.inputs.paypal.lowerMinor === null ? 'not read' : money(chk.inputs.paypal.lowerMinor)}${chk.inputs.paypal.asOf ? ` (report as of ${localTime(chk.inputs.paypal.asOf, tz)})` : ''} · reconciliation ${String(chk.inputs.paypal.reconciliation).toLowerCase()} · no promise, stated date or open invoice counted`,
    },
    decide: a.state === 'HELD_EVIDENCE' && a.decideBy && a.lastCheckId ? { checkId: a.lastCheckId, by: a.decideBy, due: now >= a.decideBy } : null,
    canHold: !!a.message && (!out || out.state === 'DRAFT' || out.state === 'QUEUED') && live(a) && !['COMPLETED', 'CANCELLED', 'SKIPPED_NOT_NEEDED', 'EXPIRED', 'FAILED'].includes(a.state),
    canSendNow: !!a.message && (!out || (out.state === 'DRAFT' && !out.held)) && (a.state === 'SCHEDULED' || (a.state === 'APPLIED' && a.kind !== 'COLLECT_OVERDUE')),
  };
}

const dollars = (m: number) => money(m);
/** What an outbound message is, in words: "Sent" only after the channel confirmed it (S5-D19/D26). */
function messageLabel(o: { state: string; channel: string; held?: boolean; preparedFor?: string | null; reason?: string | null }): string {
  const via = o.channel === 'GMAIL' ? `Gmail${o.preparedFor ? ' · to your test inbox' : ''}` : 'simulated mailbox · no real email left Headroom';
  if (o.held) return 'Draft · held by you · not sent';
  switch (o.state) {
    case 'DRAFT': return `Draft · not sent${o.reason ? ` · ${o.reason}` : ''}`;
    case 'QUEUED': return `Queued · ${via}${o.reason ? ` · ${o.reason}` : ''}`;
    case 'SENDING': return `Sending · ${via}`;
    case 'SENT': return `Sent · ${via}`;
    case 'SEND_UNKNOWN': return `Delivery unknown · ${o.reason ?? 'checking the mailbox; won’t resend'}`;
    case 'FAILED': return `Not sent · ${o.reason ?? 'refused by the mail channel'}`;
    default: return `Not sent · ${o.reason ?? 'paid first'}`;
  }
}

/** S5 lifecycle sentences (UI-PL-16): what happened, by kind, from the action's own state and reasons. */
function lifecycleText(a: ActItem, tz: string): string {
  const t = a.terms;
  const r = a.heldReasons[0] ?? '';
  const slice = a.kind === 'COLLECT_UNDISPUTED_SLICE' || a.kind === 'COLLECT_DISPUTED', offer = a.kind === 'DISCOUNT_FALLBACK';
  // S6 PAYOUT sentences (UI-PL-16, §(d)2): never "payment ready" on a receipt; only an item SUCCESS reads "Paid".
  if (a.kind === 'PAYOUT') {
    switch (a.state) {
      case 'SCHEDULED': return `Scheduled · Headroom pays ${dayName(t.payBy!)} 09:00 through PayPal, if PayPal funds can cover it then`;
      case 'HELD_EVIDENCE': return `Waiting for balance evidence · ${r} · checked again every 15 minutes`;
      case 'HELD': return `Held · ${a.heldReasons.join(' · ')}`;
      case 'QUEUED': return `Reserved on PayPal · sending to PayPal`;
      case 'UNCERTAIN': return `Checking with PayPal · ${r || 'same payment id, never sent twice'}`;
      case 'APPLIED': return r || 'Sent to PayPal · waiting for the item';
      case 'COMPLETED': return r || 'Paid through PayPal';
      case 'FAILED': return `Not paid · ${r}`;
    }
  }
  switch (a.state) {
    case 'SCHEDULED': return slice ? `Scheduled · ${dayName(t.contactOn!)} 08:00 Headroom lets the same PayPal invoice accept ${dollars(t.amount.minor)}, then sends the message` : `Scheduled · sends ${dayName(t.contactOn!)} 08:00`;
    case 'WAITING_CONDITION': return `Waiting · Headroom checks verified funds ${localTime(a.condition!.checkAt, tz)}; the offer goes out only if they fall short`;
    case 'HELD_EVIDENCE': return `Waiting for balance evidence · ${r}`;
    case 'HELD': return `Held · ${a.heldReasons.join(' · ')}`;
    case 'QUEUED': return slice ? 'Queued · updating the PayPal invoice' : offer ? 'Queued · applying the discount on PayPal' : 'Queued · sending';
    case 'UNCERTAIN': return offer || slice ? 'Checking with PayPal · never sent twice' : 'Delivery unknown · checking the mailbox; won’t resend';
    case 'APPLIED': {
      if (offer && a.expiry) {
        const end = localTime(a.expiry.at, tz);
        const held = a.expiry.state === 'HELD_PAUSED' ? `Discount ended ${end} but is still on PayPal because Headroom is paused · resume to remove it, or remove it in PayPal`
          : a.expiry.state === 'HELD_TAKEOVER' ? `Discount ended ${end} but is still on PayPal because you took over · hand back to remove it, or remove it in PayPal`
          : a.expiry.state === 'CONFLICT' ? 'PayPal invoice changed outside Headroom · the discount end needs you' : `Headroom removes it ${end}`;
        return `Applied on PayPal · ${held}`;
      }
      if (slice) return `Applied on PayPal · ${r}${a.progress ? ` · paid ${dollars(a.progress.paidMinor)} of ${dollars(a.progress.ofMinor)}` : ''}`;
      return r || 'Sent · awaiting payment';
    }
    case 'COMPLETED': return `Completed · ${r}`;
    case 'FAILED': return `Failed · ${r}`;
    case 'SKIPPED_NOT_NEEDED': return `Skipped · not needed · ${r} · nothing was sent`;
    case 'CANCELLED': return `Cancelled · ${r}`;
    case 'EXPIRED': return `Expired · ${r || 'the offer ended; nothing sent'}`;
    default: return a.state;
  }
}

const outlookOf = (s: PlanState, acts: PlanAction[]) => {
  const inflows = s.f.r.inflows;
  const actions = acts.filter(pending).map((a) => ({ ...a, changes: changesOf(a, inflows), conditional: !!a.condition }));
  return { actions, rows: outlookRowsFor(actions) };
};

export function revisionView(s: PlanState, rev: RevItem): RevisionView {
  const f = s.f;
  const acts = actsOf(s, rev.revisionId);
  const needBy = rev.basisSnapshot.needBy;
  const { actions: outActs, rows } = outlookOf(s, acts);
  const priced = priceRows(rows, (ch) => f.withChange(ch), needBy) ?? [];
  const met = f.withChange(outActs.filter((a) => !a.conditional).flatMap((a) => a.changes));
  const waitingApproval = acts.some((a) => a.decision === 'IN' && a.state === 'PROPOSED');
  const later = met?.summary.firstBelowReserve && met.summary.firstBelowReserve > needBy ? met.summary.firstBelowReserve : null;
  const cash = outActs.filter((a) => !a.conditional && a.kind !== 'PAYOUT');
  const fallbackCovers = priced.some((r) => r.key.includes('OFFER:') && !r.firstBelowReserve);
  const noun = rev.state === 'DRAFT' ? 'This draft' : 'This plan';
  const resolved = rev.state === 'RUNNING' && !!f.summary && !f.summary.firstBelowReserve;
  const coverage = resolved ? { state: 'RESOLVED' as const, text: `Gap closed: the forecast stays above your ${money(f.reserveMinor)} reserve (lowest ${money(f.summary!.lowMinor)} on ${dayName(f.summary!.lowOn)}).` }
    : !met || !cash.length
    ? (fallbackCovers ? { state: 'FALLBACK_ONLY' as const, text: `${noun} covers it only if the fallback offer runs and is paid.` } : { state: 'NOT_COVERED' as const, text: `${noun} doesn't close the gap: nothing it includes brings cash in before ${dayName(needBy)}.` })
    : !met.summary.firstBelowReserve ? { state: 'COVERED' as const, text: `${noun} covers it if its targets are met.` }
    : met.summary.firstBelowReserve > needBy ? { state: 'LATER_GAP' as const, text: `If its targets are met, ${dayName(needBy)} is covered, but cash falls to ${money(met.summary.lowMinor)} on ${dayName(met.summary.lowOn)}.` }
    : fallbackCovers ? { state: 'FALLBACK_ONLY' as const, text: `${noun} covers it only if the fallback offer runs and is paid.` }
    : { state: 'NOT_COVERED' as const, text: `${noun} doesn't close the gap: even if every target is met, cash falls to ${money(met.summary.lowMinor)} on ${dayName(met.summary.lowOn)}.` };
  const pill = rev.state === 'DRAFT' ? 'DRAFT · NOT RUNNING' : rev.state === 'REJECTED' ? 'REJECTED' : rev.state === 'SUPERSEDED' ? 'SUPERSEDED'
    : waitingApproval || acts.some((a) => a.decision === 'IN' && APPROVED.includes(a.state) && missingKinds(a, s.grants, s.ctx.now).length) ? 'REVISION NEEDS REVIEW' : coverage.state === 'RESOLVED' ? 'GAP CLOSED' : coverage.state === 'COVERED' ? 'GAP COVERED IF TARGETS MET' : later ? `GAP COVERED IF TARGETS MET · LATER GAP ${dayName(later).toUpperCase()}` : 'RECOVERING A GAP';
  const acc = lastAcceptance(f);
  const before = acc ? f.withChange(acc.change) : null;
  const tz = s.ctx.run.settings.timeZone;
  const lanes = new Map<string, { key: string; label: string; markers: RevisionView['schedule']['lanes'][number]['markers'] }>();
  for (const a of acts.filter(live)) {
    const l = lanes.get(a.counterparty.id) ?? { key: a.counterparty.id, label: a.counterparty.name, markers: [] };
    const t = a.terms;
    const m = (on: string | null, kind: RevisionView['schedule']['lanes'][number]['markers'][number]['kind'], label: string, at: string | null = null) => { if (on) l.markers.push({ on, at, kind, label, actionId: a.actionId }); };
    if (a.kind === 'PAYOUT') m(t.payBy, 'OBLIGATION', `${a.counterparty.name} payout due ${dayName(t.payBy!)} · held`);
    else if (a.kind === 'DISCOUNT_FALLBACK') { m(a.condition!.checkAt.slice(0, 10) <= needBy ? isoLocal(a.condition!.checkAt, tz) : null, 'CONDITIONAL', `Fallback check ${localTime(a.condition!.checkAt, tz)}`, a.condition!.checkAt); m(t.payBy, 'TARGET', `Pay-by for the offer · Headroom's aim, not agreed`); m(t.expiresOn, 'EXPIRY', `Offer ends ${dayName(t.expiresOn!)}`); }
    else if (a.kind === 'ASK_SUPPLIER') { m(t.contactOn, 'CONTACT', `Ask ${a.counterparty.name} about the date · ${dayName(t.contactOn!)}`); m(t.replyCheckOn, 'CHECK', `Reply check · ${dayName(t.replyCheckOn!)}`); }
    else { m(t.contactOn, 'CONTACT', `Ask ${a.counterparty.name} · ${dayName(t.contactOn!)}`); m(t.replyCheckOn, 'CHECK', `Reply check · ${dayName(t.replyCheckOn!)}`); m(t.targetOn, 'TARGET', `Target ${dayName(t.targetOn!)} · Headroom's aim, not agreed`); }
    lanes.set(a.counterparty.id, l);
  }
  const k = consentOf(s, rev);
  const byId = new Map(acts.map((a) => [a.actionId, a]));
  const pendingBills = f.r.bills.filter((b) => (b.state === 'PROPOSED' || b.state === 'VERIFIED') && b.changedFields.length);
  return {
    revisionId: rev.revisionId, n: rev.n, state: rev.state, version: rev.version, pill,
    header: {
      title: `Revision ${rev.n} · ${rev.trigger}`, change: acc?.text ?? null,
      before: before ? { low: usd(before.summary.lowMinor), lowOn: before.summary.lowOn } : null,
      after: { low: usd(f.summary?.lowMinor ?? rev.basisSnapshot.lowMinor), lowOn: f.summary?.lowOn ?? rev.basisSnapshot.lowOn }, needBy, gap: usd(f.summary?.reserveGapMinor ?? rev.basisSnapshot.gapMinor), compareId: acc?.id ?? null, coverage,
      reserve: usd(f.reserveMinor),
    },
    updates: updatesOf(s, rev, acts),
    progress: rev.state === 'RUNNING' && rev.basisSnapshot.gapMinor > 0 && s.receipts.some((r) => acts.some((a) => a.subject.invoiceId === r.invoiceId)) ? { gapAtApproval: usd(rev.basisSnapshot.gapMinor), gapNow: usd(f.summary?.reserveGapMinor ?? 0) } : null,
    kept: keptOf(s, acts),
    planner: rev.planner,
    outlook: priced.map((r) => ({ key: r.key, label: r.label, condition: r.condition, needByClose: usd(r.needByClose), low: usd(r.lowMinor), lowOn: r.lowOn, result: r.firstBelowReserve ? 'GAP' : 'COVERED', gap: usd(r.gapMinor), concessionCost: usd(r.concessionMinor), firstBelowReserve: r.firstBelowReserve, likelihood: 'NOT_ASSESSED' })),
    outlookNote: 'Each row is a forecast under its stated condition. Targets are Headroom’s aims, not agreed, and count net of estimated PayPal fees. Likelihood: not assessed.',
    schedule: { from: f.today, to: addDays(f.today, 13), needBy, lanes: [...lanes.values()] },
    actions: acts.filter((a) => a.decision === 'IN' && a.state !== 'REMOVED').map((a) => card(s, rev, a)),
    considered: [
      ...acts.filter((a) => a.decision === 'OUT' && a.state === 'PROPOSED' && a.consideredReason).map((a) => ({ key: a.rootId, title: a.counterparty.name + ' · ' + (a.kind === 'DISCOUNT_FALLBACK' ? 'early-payment offer' : a.kind === 'PAYOUT' ? 'payout' : a.kind === 'ASK_SUPPLIER' ? 'ask about the date' : a.kind === 'COLLECT_DISPUTED' ? 'disputed amount' : 'collection'), reason: a.consideredReason!, canAsk: a.authority.decision !== 'BLOCK' && (rev.state === 'DRAFT' || rev.state === 'RUNNING'), actionId: a.actionId, actionVersion: a.version, sources: a.sources })),
      ...rev.considered.map((c) => ({ key: c.rootId, title: c.title, reason: c.reason, canAsk: false, actionId: null, actionVersion: null, sources: c.sources })),
    ],
    removed: acts.filter((a) => a.state === 'REMOVED').map((a) => card(s, rev, a)),
    approval: !k ? null : {
      mode: k.mode, selected: k.selected, consentHash: k.hash, basisMoved: k.basisMoved,
      blocked: k.basisMoved ? `Your cash picture changed since revision ${rev.n} was built. Build revision ${s.plan.nextN} and review it` : !k.selected.length ? 'Nothing is waiting for your approval' : null,
      groups: {
        included: k.selected.map((id) => byId.get(id)!).filter((a) => !a.condition).map((a) => ({ actionId: a.actionId, title: titleOf(a), terms: termsText(a), authority: a.authority.reasons[0] })),
        conditional: k.selected.map((id) => byId.get(id)!).filter((a) => a.condition).map((a) => ({ actionId: a.actionId, title: titleOf(a), condition: a.condition!.text })),
        exceptions: k.selected.map((id) => byId.get(id)!).filter((a) => a.authority.decision === 'EXCEPTION').map((a) => ({ actionId: a.actionId, title: titleOf(a), reasons: a.authority.reasons.filter((r) => /above/.test(r)) })),
        alreadyDone: [...f.r.verifications.map((v) => ({ label: `Bill ${f.r.bills.find((b) => b.billId === v.billId)?.billNumber ?? ''} verified`.replace('  ', ' '), by: v.by, at: v.at })), ...f.r.terms.map((t) => ({ label: `Terms accepted: ${t.changedFields.length ? t.changedFields.map((k: string) => (k === 'dueOn' ? 'new due date' : k === 'amount' ? 'new amount' : k)).join(' and ') : 'separate obligation'}`, by: t.by, at: t.at }))],
        pendingBills: pendingBills.map((b) => ({ billId: b.billId, label: `${b.billNumber ?? b.fileName}: decide in the bill panel` })),
        removed: acts.filter((a) => a.state === 'REMOVED').map((a) => ({ actionId: a.actionId, title: titleOf(a) })),
      },
      newPermissions: k.newGrants.map((g) => ({ actionId: g.actionId, kind: g.kind, scope: KIND_TEXT[g.kind], ...permissionDetail(s, byId.get(g.actionId)!, g.kind) })), carried: k.carried.length,
      scope: `Approves ${k.mode === 'ACTIVATE' ? 'these actions in' : 'the actions waiting in'} revision ${rev.n}. Nothing is sent or paid now; each runs only at its own time and only when its own checks pass. Your delegation rules don't change. A payout is paid through PayPal on its due date, only if PayPal funds can cover it and only to the address you confirmed.`,
    },
    diff: rev.diff, laterGap: later && rev.state === 'RUNNING' ? `${dayName(needBy)} is covered if targets are met · ${dayName(later)} falls to ${money(met!.summary.lowMinor)} · Build revision ${s.plan.nextN}` : null,
    createdAt: rev.createdAt, approvedAt: rev.approvedAt, approvedBy: rev.approvedBy,
  };
}
/** UX repair (F03): each permission in the approval dialog: why it is asked, the rule behind it, and what approving does (and doesn't) do now. */
function permissionDetail(s: PlanState, a: ActItem, kind: GrantKind): { title: string; why: string; policy: string; effect: string } {
  const p = s.policy, t = a.terms, tz = s.ctx.run.settings.timeZone, rs = a.authority.reasons;
  const rule = (key: Parameters<typeof ruleOf>[1]) => `Delegation v${p.version} · ${ruleText(ruleOf(p, key))}`;
  const claim = s.claims.find((c) => c.invoiceId === a.subject.invoiceId);
  const tier = s.assessments.get(a.counterparty.id)?.tier;
  switch (kind) {
    case 'CONTACT_SPACING': return { title: `Remind ${a.counterparty.name} early`, why: rs.find((r) => r.startsWith('Last contacted')) ?? rs[0], policy: rule('comms.contactEveryBd'),
      effect: `Only this reminder may go before the rule allows, on ${dayName(t.contactOn!)} inside your contact window. Every other contact still follows the rule.` };
    case 'COLLECT_SLICE': return { title: `Collect ${money(t.amount.minor)} from ${a.counterparty.name}`, why: rs.find((r) => /dispute/i.test(r)) ?? rs[0], policy: rule('ar.disputes'),
      effect: `On ${dayName(t.contactOn!)} the same PayPal invoice is set to accept ${money(t.amount.minor)}${claim ? `; the disputed ${money(claim.disputed.minor)} stays open and is never asked for` : ''}. Nothing changes on PayPal now.` };
    case 'MESSAGE_AS_WRITTEN': return { title: `${a.counterparty.name} message, as written`, why: rs.find((r) => /wording/.test(r)) ?? 'You approve the wording', policy: tier === 'AT_RISK' ? `Delegation v${p.version} · By relationship · At risk · review first` : rule('comms.remindersWithoutReview'),
      effect: 'The message goes out exactly as written, at its scheduled time. Nothing is sent now.' };
    case 'DISCOUNT_OFFER': return { title: `Offer ${a.counterparty.name} ${(t.discountBp ?? 0) / 100}% (${money(t.discountAmount?.minor ?? 0)})`, why: rs[0], policy: rule('ar.discount'),
      effect: `Nothing is sent now. At ${a.condition ? localTime(a.condition.checkAt, tz) : 'its check time'} Headroom checks verified funds; the offer goes out only if they still fall short of your reserve.` };
    case 'PAYOUT_AUTHORITY': return { title: `Pay ${a.counterparty.name} ${money(t.amount.minor)}`, why: 'Supplier payouts always need your payout authority', policy: rule('ap.paymentLimitMinor'),
      effect: `Nothing is paid now. On ${dayName(t.payBy!)} at 09:00 Headroom pays through PayPal, only if PayPal's released funds cover it and only to the PayPal address you confirmed.` };
    case 'PAYOUT_EXCEPTION': return { title: `Exception to your payment limits for ${a.counterparty.name}`, why: rs.find((r) => /above/.test(r)) ?? rs[0], policy: `${rule('ap.paymentLimitMinor')} · ${ruleText(ruleOf(p, 'ap.dailyLimitMinor'))}`,
      effect: 'For this payment only. Your limits stay as they are, and funding and address checks still apply.' };
    case 'COLLECT_DISPUTED': return { title: `Ask ${a.counterparty.name} for a disputed amount`, why: rs[0], policy: rule('ar.disputes'), effect: 'This one ask only, at its scheduled time; each later ask needs you again.' };
  }
}

/** UX (owner, 3 Nov 2026): the climax: a concession Headroom never had to make, from the skipped fallback's own check. */
function keptOf(s: PlanState, acts: ActItem[]): RevisionView['kept'] {
  const a = acts.find((x) => x.kind === 'DISCOUNT_FALLBACK' && x.state === 'SKIPPED_NOT_NEEDED');
  if (!a) return null;
  const c = a.lastCheckId ? s.checks.find((x) => x.sk === a.lastCheckId) : undefined;
  return { amount: usd(a.terms.discountAmount?.minor ?? 0), actionId: a.actionId, headline: `The ${a.counterparty.name} discount isn't needed: you keep ${money(a.terms.discountAmount?.minor ?? 0)}`,
    text: `Payments PayPal confirmed already keep cash above your ${money(c?.inputs?.reserveMinor ?? s.f.reserveMinor)} reserve${c?.lowerMin ? ` (lowest ${money(c.lowerMin.closeMinor)} on ${dayName(c.lowerMin.on)}, verified funds only)` : ''}, so the ${(a.terms.discountBp ?? 0) / 100}% offer was never sent.` };
}

/** UX repair (F06): what happened since the revision was approved, plus a reassessment against the current forecast. */
function updatesOf(s: PlanState, rev: RevItem, acts: ActItem[]): RevisionView['updates'] {
  if (rev.state !== 'RUNNING' || !rev.approvedAt) return [];
  const f = s.f, tz = s.ctx.run.settings.timeZone;
  const out: RevisionView['updates'] = [];
  const invIds = new Set(acts.map((a) => a.subject.invoiceId).filter(Boolean));
  for (const r of s.receipts.filter((x) => invIds.has(x.invoiceId) && x.capturedAt >= rev.createdAt)) {
    const a = acts.find((x) => x.subject.invoiceId === r.invoiceId)!;
    const claim = s.claims.find((c) => c.invoiceId === r.invoiceId);
    out.push({ at: r.capturedAt, kind: 'RECEIPT', amount: usd(r.gross.minor), to: `/receivables?invoice=${encodeURIComponent(r.invoiceId)}`, text: `${a.counterparty.name} paid ${money(r.gross.minor)} on PayPal (${money(r.net.minor)} after PayPal's ${money(r.fee.minor)} fee). PayPal confirmed the payment${claim ? `; the disputed ${money(claim.disputed.minor)} stays open` : ''}.` });
  }
  for (const a of acts.filter((x) => x.kind === 'DISCOUNT_FALLBACK' && x.state === 'SKIPPED_NOT_NEEDED')) {
    const c = a.lastCheckId ? s.checks.find((x) => x.sk === a.lastCheckId) : undefined;
    out.push({ at: c?.at ?? null, kind: 'SKIPPED', amount: usd(a.terms.discountAmount?.minor ?? 0), to: `/plan#act-${a.actionId}`, text: `${a.counterparty.name} discount not sent: verified funds alone stay above your reserve${c?.lowerMin ? ` (lowest ${money(c.lowerMin.closeMinor)} on ${dayName(c.lowerMin.on)})` : ''}. The ${money(a.terms.discountAmount?.minor ?? 0)} discount was never offered.` });
  }
  for (const o of s.outs.filter((x) => x.state === 'SENT' && acts.some((a) => a.rootId === x.rootId && a.decision === 'IN'))) {
    const a = acts.find((x) => x.rootId === o.rootId)!;
    out.push({ at: (o.updatedAt as string) ?? null, kind: 'SENT', to: `/plan#act-${a.actionId}`, text: a.kind === 'ASK_SUPPLIER' ? `Asked ${a.counterparty.name} about the date.` : `Asked ${a.counterparty.name} to pay ${money(a.terms.amount.minor)}${a.kind === 'COLLECT_UNDISPUTED_SLICE' ? ' (the undisputed part)' : ''}.` });
  }
  for (const a of acts.filter((x) => x.kind === 'PAYOUT' && x.state === 'COMPLETED')) out.push({ at: null, kind: 'PAID', amount: usd(a.terms.amount.minor), to: '/payables', text: `${a.counterparty.name} paid ${money(a.terms.amount.minor)} through PayPal; PayPal confirmed the payment to the supplier.` });
  if (!out.length || !f.summary) return out.sort((x, y) => (x.at ?? '9').localeCompare(y.at ?? '9'));
  const fb = acts.find((x) => x.kind === 'DISCOUNT_FALLBACK' && (x.state === 'WAITING_CONDITION' || x.state === 'HELD_EVIDENCE'));
  const fbText = !fb ? '' : f.summary.firstBelowReserve
    ? ` So the ${fb.counterparty.name} offer stays as the fallback, checked ${localTime(fb.condition!.checkAt, tz)}.`
    : ` At ${localTime(fb.condition!.checkAt, tz)} Headroom confirms this with verified funds only; if they cover the gap, the ${money(fb.terms.discountAmount?.minor ?? 0)} ${fb.counterparty.name} offer is not sent.`;
  const now = f.summary.firstBelowReserve
    ? `Lowest point now ${money(f.summary.lowMinor)} on ${dayName(f.summary.lowOn)}, still ${money(f.summary.reserveGapMinor)} below your ${money(f.reserveMinor)} reserve.${fbText}`
    : `Lowest point now ${money(f.summary.lowMinor)} on ${dayName(f.summary.lowOn)}, above your ${money(f.reserveMinor)} reserve.${fbText}`;
  return [...out.sort((x, y) => (x.at ?? '9').localeCompare(y.at ?? '9')), { at: null, kind: 'REASSESSED', text: now }];
}

const isoLocal = (instant: string, tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(instant));
const titleOf = (a: PlanAction) => a.kind === 'PAYOUT' ? `Pay ${a.counterparty.name}` : a.kind === 'DISCOUNT_FALLBACK' ? `Offer ${a.counterparty.name} an early-payment discount` : a.kind === 'COLLECT_UNDISPUTED_SLICE' ? `Collect the undisputed part from ${a.counterparty.name}` : a.kind === 'COLLECT_DISPUTED' ? `Ask ${a.counterparty.name} for the disputed amount` : `Collect ${a.counterparty.name}'s overdue invoice`;
const termsText = (a: PlanAction) => { const t = a.terms; return a.kind === 'ASK_SUPPLIER' ? (t.askOptions ?? []).map((o) => `${o.code === 'KEEP' ? 'keep' : 'split'}: ${o.parts.map((p) => `${money(p.amount.minor)} ${dayName(p.dueOn)}`).join(' + ')}`).join(' or ') : a.kind === 'PAYOUT' ? `${money(t.amount.minor)} on ${dayName(t.payBy!)} · held` : `${money(t.amount.minor)} · ask ${dayName(t.contactOn!)} · target ${dayName(t.targetOn!)} (not agreed)`; };

export async function getPlan(c: ReadCtx): Promise<ResponseOf<'getPlan'>> {
  const s = await loadPlanState(c);
  const f = s.f;
  const running = revOf(s, s.plan.running);
  const draft = revOf(s, s.plan.draft);
  const trail = [...s.revisions].sort((a, z) => z.n - a.n).map((r) => ({ revisionId: r.revisionId, n: r.n, title: `Revision ${r.n}`, at: r.createdAt, trigger: r.trigger, approvedBy: r.approvedBy, status: r.revisionId === s.plan.running ? 'Current' : r.state === 'DRAFT' ? 'Draft' : r.state === 'REJECTED' ? 'Rejected' : r.state === 'SUPERSEDED' ? 'Superseded' : r.state }));
  const outside = f.r.bills.filter((b) => (b.state === 'PROPOSED' || b.state === 'VERIFIED') && b.changedFields.length).map((b) => ({ billId: b.billId, label: `${b.billNumber ?? b.fileName}`, reason: 'A bill that differs from your forecast: decide it in the bill panel' }));
  // S4-IM-05: an open Plan page re-reads when a permission expires or the business day changes (dates and need-by move).
  const expiries = s.grants.filter((g) => g.state === 'ACTIVE' && !grantExpired(g, c.now)).map((g) => g.expiresAt);
  const validUntil = [nextBusinessMidnight(c.now, c.run.settings.timeZone), ...expiries].sort()[0];
  const base = { outside, trail, running: running ? { revisionId: running.revisionId, n: running.n } : null, validUntil };
  if (!f.opening) return { ...base, proposed: null, state: 'NO_OPENING', reason: `Cash impact unknown: ${f.noOpeningReason}`, build: null, revision: running ? revisionView(s, running) : null, banner: null };
  const hash = basisHashOf(s);
  const b = hash ? s.builds.find((x) => x.basisHash === hash) : undefined;
  const bRev = b?.revisionId ? revOf(s, b.revisionId) : undefined;
  const build = b ? { buildId: b.buildId, generation: b.generation, state: b.state, checks: b.checks, failure: b.failure, retryable: b.state === 'FAILED' || bRev?.state === 'REJECTED' } : null;
  // UX repair (F01): the running revision owns the page; a draft beside it is `proposed`. Reading never builds or changes anything.
  const shown = running ?? draft;
  const revision = shown ? revisionView(s, shown) : null;
  const runningCovers = !!running && !!revision && revision.revisionId === running.revisionId && ['COVERED', 'FALLBACK_ONLY', 'RESOLVED'].includes(revision.header.coverage.state);
  const draftCurrent = !!draft && !!hash && draft.basisHash === hash;
  const proposed = running && draft ? { revisionId: draft.revisionId, n: draft.n, current: draftCurrent,
    text: draftCurrent ? `Revision ${draft.n} is proposed: review it before it replaces revision ${running.n}` : !hash ? `Revision ${draft.n} is no longer needed: cash now stays above your reserve` : `Revision ${draft.n} was built on an earlier cash picture` } : null;
  const withP = { ...base, proposed };
  if (!hash) return { ...withP, state: shown ? 'READY' : 'NO_PLAN_NEEDED', reason: shown ? null : 'No plan needed · Forecast above reserve under stated assumptions', build: null, revision, banner: null };
  if (b?.state === 'BUILDING') return { ...withP, state: 'BUILDING', reason: null, build, revision, banner: null };
  if (b?.state === 'FAILED') return { ...withP, state: 'FAILED', reason: `Headroom couldn't build a plan: ${b.failure?.reason ?? 'unknown'}`, build, revision, banner: null };
  // A new revision is offered only when nothing current covers the gap, or a running action would now be refused (a rule or a
  // relationship label changed, S7 R8); the owner builds it (an explicit request), never the page.
  const refused = running ? actsOf(s, running.revisionId).filter((a) => pending(a) && a.kind !== 'PAYOUT' && a.authority.decision !== 'BLOCK' && currentDecision(s, a).decision === 'BLOCK') : [];
  const needsBuild = !b && (running ? !runningCovers || refused.length > 0 : !draftCurrent);
  if (needsBuild) return { ...withP, state: 'NEEDS_BUILD', reason: null, build: null, revision,
    banner: refused.length ? `Something revision ${running!.n} depends on changed: ${refused[0].counterparty.name} · ${currentDecision(s, refused[0]).reasons[0]}`
      : running ? `Your cash picture changed and revision ${running.n} no longer closes the gap` : draft ? `Your cash picture changed since revision ${draft.n} was built` : null };
  return { ...withP, state: 'READY', reason: bRev?.state === 'REJECTED' ? `You rejected revision ${bRev.n}.${running ? ' The running revision keeps going.' : ''} Build again when you're ready.` : null, build, revision, banner: null };
}

export async function getRevision(c: ReadCtx, id: string): Promise<ResponseOf<'getRevision'>> {
  const s = await loadPlanState(c);
  const rev = revOf(s, id);
  if (!rev) throw new ApiError(404, 'NOT_FOUND', 'No such revision');
  return revisionView(s, rev);
}

// ---------- Overview and Session (UI-OV-08/09/10, UI-SH-02/12) ----------
export async function getOverview(c: ReadCtx): Promise<ResponseOf<'getOverview'>> {
  const [o, s] = await Promise.all([read.getOverview(c), loadPlanState(c)]);
  // UX repair (F01): the running revision leads; a draft asks for approval only while it is built on today's picture and still needed.
  const running0 = revOf(s, s.plan.running), draft0 = revOf(s, s.plan.draft);
  const shown = running0 ?? draft0;
  const v = shown ? revisionView(s, shown) : null;
  const extra: NeedRow[] = [];
  const hash = basisHashOf(s);
  const dv = draft0 && hash && draft0.basisHash === hash ? (draft0 === shown ? v : revisionView(s, draft0)) : null;
  if (dv && draft0) extra.push({ key: `plan:${draft0.revisionId}`, title: running0 ? `Review proposed revision ${draft0.n}` : `Approve revision ${draft0.n}`, reason: `${dv.actions.length} actions proposed to close the ${dayName(draft0.basisSnapshot.needBy)} shortfall. Nothing runs until you approve.`, where: 'Plan', amount: null, deadline: draft0.basisSnapshot.needBy, action: { label: 'Review plan', to: { kind: 'PLAN' } } });
  for (const a of v && shown!.state === 'RUNNING' ? v.actions.filter((x) => x.needsApproval) : []) extra.push({ key: `act:${a.actionId}`, title: `${a.counterparty.name} ${a.kind === 'PAYOUT' ? 'payout' : 'action'} needs your approval again`, reason: a.grants.some((g) => g.state === 'EXPIRED') ? 'Its permission expired.' : a.grants.some((g) => g.state === 'REVOKED') ? 'You revoked its permission.' : 'It changed, or was restored, after approval.', where: 'Plan', amount: a.terms.amount, deadline: a.terms.targetOn ?? a.terms.payBy, action: { label: 'Review plan', to: { kind: 'PLAN' } } });
  const covers = !!v && running0 === shown && ['COVERED', 'FALLBACK_ONLY', 'RESOLVED'].includes(v.header.coverage.state);
  if (hash && running0 && !covers && !dv) extra.push({ key: 'plan:stale', title: 'Your cash picture changed: the running plan no longer closes the gap', reason: `Build a new revision on the Plan page; revision ${running0.n} keeps running until you approve one.`, where: 'Plan', amount: null, deadline: null, action: { label: 'Review plan', to: { kind: 'PLAN' } } });
  if (hash && !running0 && draft0 && !dv) extra.push({ key: 'plan:stale', title: 'Your cash picture changed: review a new revision', reason: `Revision ${draft0.n} was built on an earlier picture.`, where: 'Plan', amount: null, deadline: null, action: { label: 'Review plan', to: { kind: 'PLAN' } } });
  extra.push(...(await s5Needs(c, s)));
  // S5: with a plan running, the reserve alert says so instead of "nothing runs until you approve".
  const running = revOf(s, s.plan.running);
  // UX (owner, 3 Nov 2026): a bill your rule verified and accepted that causes the breach reads as one message with one way forward.
  const byRule = [...s.f.r.terms].filter((t) => t.before && t.by === 'HEADROOM').sort((x, y) => (x.at < y.at ? 1 : -1))[0];
  const ruleBill = byRule ? s.f.r.bills.find((b) => b.billId === byRule.billId) : undefined;
  const ruleSup = ruleBill ? s.f.r.suppliers.find((x) => x.supplierId === ruleBill.supplierId)?.displayName ?? ruleBill.supplierName : null;
  if (o.alert?.kind === 'RESERVE_GAP' && !running && byRule && ruleBill) {
    const fb = s.f.summary?.firstBelowReserve;
    o.alert = { ...o.alert, kicker: 'New bill · verified by your rule',
      headline: `You have a new verified bill from ${ruleSup} that makes your cash fall below your reserve${fb ? ` on ${dayName(fb)}` : ''}.`,
      body: `${ruleBill.billNumber ?? 'The bill'} moved its date ${dayName(byRule.before.dueOn)} → ${dayName(byRule.after.dueOn)}; your Delegation rule verified it and accepted the date (same amount, payment details on file). ${draft0 ? 'Headroom built a plan to close the gap; nothing runs until you approve it.' : 'Headroom is building a plan to close the gap.'}`,
      cta: { label: 'Open your plan', to: { kind: 'PLAN' } } };
    for (let i = extra.length - 1; i >= 0; i--) if (String(extra[i].key).startsWith('plan:')) extra.splice(i, 1);
  }
  const needs = [...extra, ...o.needs];
  const alert = o.alert && o.alert.kind === 'RESERVE_GAP' && running
    ? { ...o.alert, kicker: `Plan running · revision ${running.n}`, body: `${o.alert.body.split('. Headroom can build')[0]}. Revision ${running.n} is running: Headroom acts only within what you approved and your delegation; each step and its result is on the Plan.`, cta: { label: 'Open plan', to: { kind: 'PLAN' as const } } }
    : o.alert;
  return {
    ...o, alert, needs, needsCount: needs.length, safetyNotices: safetyNotices(s.policy),
    validUntil: [o.validUntil, ...s.grants.filter((g) => g.state === 'ACTIVE' && !grantExpired(g, c.now)).map((g) => g.expiresAt)].filter((x): x is string => !!x).sort()[0] ?? null,
    plan: v ? { revisionN: v.n, state: v.state, pill: v.pill, steps: v.actions.slice(0, 4).map((a) => ({ title: a.kind === 'PAYOUT' ? `Pay ${a.counterparty.name}` : a.kind === 'DISCOUNT_FALLBACK' ? `Fallback offer · ${a.counterparty.name}` : `Collect · ${a.counterparty.name}`, mode: a.authorityTag.tone === 'DELEGATION' ? 'Within delegation' : a.authorityTag.tone === 'APPROVED' ? 'Approved' : 'Needs you', state: a.state === 'SKIPPED_NOT_NEEDED' ? `Not needed · ${money(a.terms.discountAmount?.minor ?? 0)} kept` : a.stateText.split(' · ')[0] })) } : null,
  };
}

// ---------- Forecast scenarios and comparisons (UI-PL-04, UI-CA-10/11) ----------
export async function getForecast(c: ReadCtx, q: { scenario: 'EXPECTED' | 'IDEAL' | 'DOWNSIDE'; compare?: string }): Promise<ResponseOf<'getForecast'>> {
  const s = await loadPlanState(c);
  const shown = revOf(s, s.plan.running) ?? revOf(s, s.plan.draft);
  const out = await read.getForecast(c, async (f) => {
    const acts = shown ? outlookOf(s, actsOf(s, shown.revisionId)) : { actions: [], rows: [] };
    const ch = scenarioChanges(q.scenario, acts.actions, f.r.inflows.map((i) => i.inflowId));
    const series = q.scenario === 'EXPECTED' ? undefined : f.withChange(ch) ?? undefined;
    const comp = (id: string, kind: 'BEFORE_BILL' | 'PROPOSAL', label: string, reason: string, w: ReturnType<ForecastModel['withChange']>, linked: { label: string; status: string } | null) =>
      w ? [{ id, kind, billId: null, revisionId: kind === 'PROPOSAL' ? shown!.revisionId : null, label, builtBy: 'HEADROOM' as const, reason, closes: w.days.map((d) => ({ on: d.on, close: usd(d.closeMinor) })), summary: summaryDto(w.summary), linked }] : [];
    const acc = lastAcceptance(f);
    const comparisons = [
      ...(acc ? comp(acc.id, 'BEFORE_BILL', 'Before you accepted the bill', acc.text, f.withChange(acc.change), null) : []),
      ...acts.rows.filter((r) => r.key !== 'none').flatMap((r) => comp(`rev:${shown!.revisionId}:${r.key}`, 'PROPOSAL', `Headroom proposal: ${r.label}`, `${r.condition} · likelihood not assessed`, f.withChange(r.changes), { label: `Revision ${shown!.n}`, status: shown!.state === 'RUNNING' ? 'Running' : shown!.state === 'DRAFT' ? 'Draft · not running' : shown!.state })),
    ];
    return { scenario: q.scenario, scenarioBasis: `${SCENARIO_BASIS[q.scenario]} · Likelihood: not assessed`, series: series ? { days: series.days, summary: series.summary } : undefined, comparisons, compare: q.compare ?? null };
  });
  if (q.compare && out.state === 'READY' && !out.comparisons.some((x) => x.id === q.compare)) throw new ApiError(404, 'NOT_FOUND', 'No such comparison');
  return out;
}

// ---------- Delegation (T10, UI-DL-*) ----------
export async function getDelegation(c: ReadCtx): Promise<ResponseOf<'getDelegation'>> {
  const s = await loadPlanState(c);
  const p = s.policy;
  const liveActs = s.actions.filter((a) => (a.revisionId === s.plan.running || a.revisionId === s.plan.draft) && live(a));
  const names = new Map([...s.customers.map((x) => [x.customerId, x.displayName] as const), ...s.f.r.suppliers.map((x) => [x.supplierId, x.displayName] as const)]);
  const now = c.now;
  const revN = (id: string) => s.revisions.find((r) => r.revisionId === id)?.n ?? null;
  const fmtVal = (key: keyof typeof RULE_SPECS, v: PolicyValue) => RULE_SPECS[key].short(normalizeValue(key, v));
  return {
    version: p.version, pauses: p.pauses,
    rules: p.rules.map((r) => {
      const area = r.group === 'PAYING_BILLS' ? 'PAYABLES' : 'RECEIVABLES';
      const eff = resolve(p, r.key, area);
      const spec = RULE_SPECS[r.key];
      return {
        ...r, everywhere: normalizeValue(r.key, r.everywhere), scoped: r.scoped && { ...r.scoped, value: r.scoped.value === null ? null : normalizeValue(r.key, r.scoped.value) },
        sentence: ruleText(r), editable: !ENFORCED_LATER[r.key], enforcedNow: ENFORCED_LATER[r.key] ?? null,
        editor: spec.editor, choices: spec.choices ?? [], safety: spec.safety, loosenedFromDefault: spec.safety && loosenedFromDefault(p, r.key), defaultValue: spec.seed, defaultText: spec.short(spec.seed),
        text: ruleText(r, eff.value), value: fmtVal(r.key, eff.value), scopedText: r.scoped ? (r.scoped.value === null ? `${r.scoped.scope === 'PAYABLES' ? 'Paying bills' : 'Getting paid'} uses the everywhere value` : `${r.scoped.scope === 'PAYABLES' ? 'Paying bills' : 'Getting paid'}: ${fmtVal(r.key, r.scoped.value)} (overrides everywhere)`) : null,
        affectsNow: liveActs.filter((a) => a.authority.winning.key === r.key || (r.key === 'ap.dailyLimitMinor' && a.kind === 'PAYOUT')).map((a) => ({ label: titleOf(a), winning: r.key === 'ap.dailyLimitMinor' ? resolve(p, r.key, 'PAYABLES').winning.label : a.authority.winning.label, actionId: a.actionId, revisionN: revN(a.revisionId) ?? 0, decision: a.authority.decision === 'ALLOW' ? 'Within delegation' : a.authority.decision === 'EXCEPTION' ? `Exception · ${a.authority.reasons.find((x) => /above/.test(x)) ?? ''}` : a.authority.decision === 'BLOCK' ? 'Not allowed' : `Needs your approval · ${a.authority.reasons[0]}`, state: a.state.toLowerCase().replace('_', ' '), amount: a.terms.amount })),
      };
    }),
    // S7 §6.1a: the discount column is the ar.discount rule's tiers (the stored tier flag no longer decides anything).
    tiers: p.tiers.map((t) => ({ ...t, discount: discountLimits(p).bp > 0 && discountLimits(p).tiers.includes(t.tier), label: TIER_LABEL[t.tier], counterparties: [...s.assessments].filter(([id, a]) => a.tier === t.tier && names.has(id)).map(([id]) => names.get(id)!) })),
    exceptions: p.exceptions.map((e) => ({ counterpartyId: e.counterpartyId, name: names.get(e.counterpartyId) ?? e.counterpartyId, text: ruleText(ruleOf(p, e.key), e.value) })),
    precedence: ['Everywhere', 'Getting paid / Paying bills', 'By relationship tier', 'Individual exception', 'The most specific explicit rule wins for ordinary values; hard stops sit above all of them'],
    hardStops: HARD_STOPS,
    grants: [
      ...s.grants.sort((a, z) => (a.at < z.at ? 1 : -1)).map((g) => ({
        grantId: g.grantId, kind: g.kind, text: KIND_TEXT[g.kind], scope: g.scope, revisionN: revN(g.revisionId),
        state: g.state === 'ACTIVE' && grantExpired(g, now) ? 'EXPIRED' as const : g.state, by: g.by, at: g.at, expiresAt: g.expiresAt, rulesUnchanged: g.policyVersion === p.version,
        revocable: g.state === 'ACTIVE' && !grantExpired(g, now), note: g.lapsedReason ?? (g.carriedTo.length ? `Carried into revision ${g.carriedTo.map(revN).join(', ')} unchanged` : null),
      })),
      ...s.f.r.verifications.map((v) => ({ grantId: `bill:${v.billId}`, kind: 'BILL_VERIFY' as const, text: 'Bill verified', scope: `Bill ${s.f.r.bills.find((b) => b.billId === v.billId)?.billNumber ?? v.billId} is a genuine bill for its payment; changes no terms, permits no payment`, revisionN: null, state: 'RECORD' as const, by: v.by, at: v.at, expiresAt: null, rulesUnchanged: true, revocable: false, note: 'A record of what happened; not revocable' })),
      ...s.f.r.terms.map((t) => ({ grantId: `terms:${t.sk.replace(/^TERMS#/, '')}`, kind: 'TERMS_ACCEPT' as const, text: 'Terms accepted', scope: t.changedFields.length ? `${t.changedFields.map((k: string) => (k === 'dueOn' ? `date ${dayName(t.before.dueOn)} → ${dayName(t.after.dueOn)}` : `amount ${money(t.before.amount.minor)} → ${money(t.after.amount.minor)}`)).join(' and ').replace(/^./, (x: string) => x.toUpperCase())} accepted for ${occName(s, t.occurrenceKey)}` : `Added as a separate obligation: ${occName(s, t.occurrenceKey)}`, revisionN: null, state: 'RECORD' as const, by: t.by, at: t.at, expiresAt: null, rulesUnchanged: true, revocable: false, note: 'Agreed terms; not revocable' })),
    ],
  };
}

// ---------- Customers & Suppliers (T11, UI-CS-*) ----------
const ORDER = ['STRONG', 'GOOD', 'MIXED', 'NOT_ENOUGH_HISTORY', 'AT_RISK'];
function rows(s: PlanState) {
  const end = addDays(s.f.today, 41);
  const liveActs = s.actions.filter((a) => (a.revisionId === s.plan.running || a.revisionId === s.plan.draft) && live(a));
  const lastPaid = (id: string) => s.history.filter((h) => h.counterpartyId === id && h.paidOn).map((h) => h.paidOn!).sort().at(-1) ?? null;
  const people: { id: string; name: string; roles: ('CUSTOMER' | 'SUPPLIER')[] }[] = [
    ...s.customers.map((x) => ({ id: x.customerId, name: x.displayName, roles: ['CUSTOMER' as const] })),
    ...s.f.r.suppliers.map((x) => ({ id: x.supplierId, name: x.displayName, roles: ['SUPPLIER' as const] })),
  ];
  return people.map((p) => {
    const a = s.assessments.get(p.id)!;
    const receivable = s.invoices.filter((i) => i.customerId === p.id && (i.state === 'ISSUED' || i.state === 'PARTIALLY_PAID')).reduce((t, i) => t + i.openGross.minor, 0);
    const payable = s.f.r.occurrences.filter((o) => o.dueOn <= end && s.f.r.commitments.find((c) => c.commitmentId === o.commitmentId)?.supplierId === p.id).reduce((t, o) => t + o.amount.minor, 0);
    return {
      id: p.id, name: p.name, roles: p.roles, tier: a.tier, label: p.roles[0] === 'SUPPLIER' && a.tier === 'NOT_ENOUGH_HISTORY' ? 'Not enough history' : a.label, dots: TIER_DOTS[a.tier], meaning: s.policy.tiers.find((t) => t.tier === a.tier)?.meaning ?? '',
      receivable: usd(receivable), payable: usd(payable), activeWork: liveActs.filter((x) => x.counterparty.id === p.id).map((x) => titleOf(x)), lastContact: lastPaid(p.id), basis: 'SEEDED' as const,
    };
  }).sort((a, z) => ORDER.indexOf(a.tier) - ORDER.indexOf(z.tier) || a.name.localeCompare(z.name));
}

export async function listRelationships(c: ReadCtx): Promise<ResponseOf<'listRelationships'>> {
  return { rows: rows(await loadPlanState(c)) };
}

export async function getRelationship(c: ReadCtx, id: string): Promise<ResponseOf<'getRelationship'>> {
  const s = await loadPlanState(c);
  const all = rows(s);
  const r = all.find((x) => x.id === id);
  if (!r) throw new ApiError(404, 'NOT_FOUND', 'No such customer or supplier');
  const a = s.assessments.get(id)!;
  const p = s.policy;
  const hist = s.history.filter((h) => h.counterpartyId === id).sort((x, z) => (x.dueOn < z.dueOn ? 1 : -1));
  const tierRow = p.tiers.find((t) => t.tier === a.tier)!;
  const customers = all.filter((x) => x.roles.includes('CUSTOMER'));
  const area = r.roles.includes('SUPPLIER') ? 'PAYABLES' : 'RECEIVABLES';
  const treat = r.roles.includes('SUPPLIER')
    ? [{ text: ruleText(ruleOf(p, 'ap.paymentLimitMinor'), resolve(p, 'ap.paymentLimitMinor', 'PAYABLES', id).value), winning: resolve(p, 'ap.paymentLimitMinor', 'PAYABLES', id).winning.label }, { text: 'Payouts only to verified payment details', winning: 'Hard stop' }]
    : [
      { text: discountLimits(p, id).bp > 0 && discountLimits(p, id).tiers.includes(a.tier) ? `Early-payment discounts may be offered within your delegation: ${ruleText(ruleOf(p, 'ar.discount'), resolve(p, 'ar.discount', 'RECEIVABLES', id).value)}` : `No early-payment discounts for a ${TIER_LABEL[a.tier]} relationship (your delegation)`, winning: `By relationship · ${TIER_LABEL[a.tier]}` },
      { text: tierRow.reviewFirst ? 'Every message waits for you (review first)' : ruleText(ruleOf(p, 'comms.remindersWithoutReview')), winning: tierRow.reviewFirst ? `By relationship · ${TIER_LABEL[a.tier]}` : resolve(p, 'comms.remindersWithoutReview', area).winning.label },
      { text: ruleText(ruleOf(p, 'ar.disputes'), resolve(p, 'ar.disputes', 'RECEIVABLES', id).value), winning: resolve(p, 'ar.disputes', 'RECEIVABLES', id).winning.label },
    ];
  return {
    ...r, since: hist.at(-1)?.dueOn ?? null, factors: a.factors, treatment: treat,
    inPlan: s.actions.filter((x) => (x.revisionId === s.plan.running || x.revisionId === s.plan.draft) && x.counterparty.id === id && x.state !== 'SUPERSEDED').map((x) => ({ actionId: x.actionId, title: titleOf(x), state: x.state })),
    history: hist.map((h) => ({ ref: h.ref, kind: h.kind, dueOn: h.dueOn, paidOn: h.paidOn, daysLate: h.paidOn ? Math.max(0, Math.round((Date.parse(h.paidOn) - Date.parse(h.dueOn)) / 86_400_000)) : null, amount: h.amount, note: h.note })),
    open: s.invoices.filter((i) => i.customerId === id && ['ISSUING', 'ISSUED', 'PARTIALLY_PAID'].includes(i.state)).map((i) => ({ ref: i.invoiceNumber ?? 'invoice', text: `${money(i.openGross.minor)} open · due ${dayName(i.dueOn)}${i.dueOn < s.f.today ? ' · overdue' : ''}${s.claims.some((x) => x.invoiceId === i.invoiceId) ? ' · part disputed' : ''}`, invoiceId: i.invoiceId })),
    rank: r.roles.includes('CUSTOMER') ? `${customers.findIndex((x) => x.id === id) + 1} of ${customers.length} customers by relationship strength` : 'Supplier',
  };
}

export { grantCovers };

/** S5 Needs rows (UI-OV-10): only what genuinely waits on the owner. */
async function s5Needs(c: ReadCtx, s: PlanState): Promise<NeedRow[]> {
  const out: NeedRow[] = [];
  const plan = { label: 'Review plan', to: { kind: 'PLAN' as const } };
  const inbox = { label: 'Open Inbox', to: { kind: 'INBOX' as const } };
  for (const a of s.actions) {
    if (a.state === 'HELD_EVIDENCE' && a.decideBy && c.now >= a.decideBy) out.push({ key: `decide:${a.actionId}`, title: `${a.counterparty.name} offer: Headroom can't yet prove the gap is covered`, reason: 'Send the offer once, or don’t send it. A pause is never bypassed.', where: 'Plan', amount: a.terms.amount, deadline: a.terms.expiresOn, action: plan });
    if (a.holdCode === 'PROVIDER_CHANGED' || a.expiry?.state === 'CONFLICT') out.push({ key: `conflict:${a.actionId}`, title: `${a.counterparty.name}: PayPal invoice changed outside Headroom`, reason: 'Headroom wrote nothing and never restores an older invoice. Check it in PayPal.', where: 'Plan', amount: null, deadline: null, action: plan });
    if (a.expiry && (a.expiry.state === 'HELD_PAUSED' || a.expiry.state === 'HELD_TAKEOVER')) out.push({ key: `expiry:${a.actionId}`, title: `${a.counterparty.name}: the discount ended but is still on PayPal`, reason: a.expiry.state === 'HELD_PAUSED' ? 'Headroom is paused. Resume to remove it, or remove it in PayPal.' : 'You took over. Hand back to remove it, or remove it in PayPal.', where: 'Plan', amount: null, deadline: null, action: plan });
    // S5-D25 / L3b (observed 2 Nov 2026): a checkout opened at the discounted price can still complete after the removal.
    if (a.kind === 'DISCOUNT_FALLBACK' && a.expiry?.state === 'REMOVED') {
      const inv = s.invoices.find((i) => i.invoiceId === a.subject.invoiceId);
      const paid = s.allocs.some((x) => x.invoiceId === a.subject.invoiceId);
      if (inv && paid && inv.openGross.minor > 0 && inv.openGross.minor <= (a.terms.discountAmount?.minor ?? 0)) out.push({ key: `lateoffer:${a.actionId}`, title: `${a.counterparty.name} paid the discounted amount after the offer ended`, reason: `PayPal shows ${money(inv.openGross.minor)} still due. Headroom changes nothing on its own: ask for it, or write it off in PayPal.`, where: 'Receivables', amount: inv.openGross, deadline: null, action: plan });
    }
    // S6 (UI-OV-10): payouts that wait on the owner. The payout panel shows the ids and what to do.
    if (a.kind === 'PAYOUT' && a.subject.occurrenceKey && a.state !== 'SUPERSEDED') {
      const panel = { label: 'Open payment', to: { kind: 'PAYOUT' as const, occurrenceKey: a.subject.occurrenceKey } };
      const pe = s.payees.find((p) => p.supplierId === a.counterparty.id);
      if (pe && pe.state !== 'CONFIRMED' && (a.state === 'PROPOSED' || a.holdCode === 'PAYEE_UNCONFIRMED')) out.push({ key: `payee:${a.counterparty.id}`, title: `Confirm ${a.counterparty.name}'s PayPal address`, reason: `Headroom pays only an address you confirm against what ${a.counterparty.name} gave you outside Headroom (${pe.masked}).`, where: 'Payables', amount: null, deadline: a.terms.payBy, action: panel });
      if (a.holdCode === 'PROVIDER_REFUSED') out.push({ key: `refused:${a.actionId}`, title: `PayPal refused the ${a.counterparty.name} payout`, reason: `${a.heldReasons[0] ?? ''} Nothing was paid; a new attempt needs your approval.`, where: 'Payables', amount: a.terms.amount, deadline: null, action: panel });
      if (a.state === 'APPLIED' && /hasn't claimed/.test(a.heldReasons[0] ?? '')) out.push({ key: `unclaimed:${a.actionId}`, title: `${a.counterparty.name} hasn't claimed the PayPal payment`, reason: 'Not paid yet. Ask them to sign in to PayPal with the address you confirmed; PayPal returns it after 30 days.', where: 'Payables', amount: a.terms.amount, deadline: null, action: panel });
      if (a.state === 'UNCERTAIN') out.push({ key: `unknown:${a.actionId}`, title: `Checking with PayPal whether the ${a.counterparty.name} payout went through`, reason: 'Headroom checks with the same payment id and never sends a second one.', where: 'Payables', amount: a.terms.amount, deadline: null, action: panel });
    }
    if (a.state === 'FAILED') out.push({ key: `failed:${a.actionId}`, title: `${a.counterparty.name}: ${a.heldReasons[0] ?? 'failed'}`, reason: 'Nothing was retried on a new invoice or a new message.', where: 'Plan', amount: null, deadline: null, action: plan });
  }
  for (const o of s.outs.filter((x) => x.state === 'SEND_UNKNOWN' && /Needs you/.test(x.reason ?? ''))) out.push({ key: `mail:${o.sk}`, title: 'A message’s delivery is unknown', reason: 'Headroom will not resend it. Check the mailbox.', where: 'Inbox', amount: null, deadline: null, action: inbox });
  const mails = await c.store.query('core', s.pk, { skPrefix: 'MAIL#' });
  const held = mails.filter((m) => m.processing === 'HELD' || m.interpretation?.refused || (m.interpretation && !['PROMISE'].includes(m.interpretation.intent)));
  if (held.length) out.push({ key: 'mail:review', title: `${held.length} repl${held.length === 1 ? 'y' : 'ies'} for you to read`, reason: 'Held senders are not read; other replies change nothing until you decide.', where: 'Inbox', amount: null, deadline: null, action: inbox });
  // S7 R6: a supplier's answer waits for you; nothing changes until you accept or decline it.
  for (const x of s.answers.filter((y) => y.state === 'OPEN')) {
    const ask = s.actions.find((a) => a.rootId === x.askId);
    const occ = ask?.subject.occurrenceKey ? s.f.r.occurrences.find((o) => o.occurrenceKey === ask.subject.occurrenceKey) : undefined;
    const what = x.intent === 'TERMS_AGREED' ? (x.matched === 'KEEP' ? 'agrees to keep the original date' : 'agrees to the split') : x.intent === 'TERMS_COUNTER' ? 'answered with different terms' : x.intent === 'TERMS_DECLINED' ? 'declined' : 'replied';
    out.push({ key: `answer:${x.answerId}`, title: `${ask?.counterparty.name ?? 'A supplier'} ${what}`, reason: `“${x.quote}” Nothing changes until you accept or decline it.`, where: 'Payables', amount: null, deadline: null, action: occ?.substantiatedBy ? { label: 'Open bill', to: { kind: 'BILL', billId: occ.substantiatedBy } } : plan });
  }
  // S7 R4: a dispute email waiting for you (nothing collects on the invoice until you confirm or dismiss it).
  for (const x of s.disputes.filter((y) => y.state === 'PENDING')) {
    const inv = s.invoices.find((i) => i.invoiceId === x.invoiceId);
    const who = s.customers.find((y) => y.customerId === inv?.customerId)?.displayName ?? 'A customer';
    out.push({ key: `dispute:${x.invoiceId}`, title: `${who} disputes ${inv?.invoiceNumber ?? 'an invoice'}: confirm what is disputed`, reason: 'Read from their email. Nothing is collected on this invoice until you confirm the split or dismiss it.', where: 'Receivables', amount: inv?.openGross ?? null, deadline: null, action: { label: 'Open invoice', to: { kind: 'INVOICE', invoiceId: x.invoiceId } } });
  }
  for (const p of (await c.store.query('core', s.pk, { skPrefix: 'PROMISE#' })).filter((x) => x.beyondLimitDays && !x.acceptedBy))
    out.push({ key: `promise:${p.promiseId}`, title: `${s.customers.find((x) => x.customerId === p.customerId)?.displayName ?? 'A customer'} promised ${dayName(p.on)}: beyond your ${p.beyondLimitDays}-day limit`, reason: 'Not counted in Expected until you accept the date. A promise is never cash and never skips a fallback.', where: 'Inbox', amount: p.amount, deadline: null, action: inbox });
  const unalloc = s.allocs.filter((a) => a.claim === 'UNALLOCATED'); // reversal rows are negative: the sum nets refunds
  if (unalloc.reduce((t, a) => t + a.amount.minor, 0) > 0) out.push({ key: 'unallocated', title: 'Money received toward a disputed amount', reason: 'It is recorded, not applied: the dispute is your decision.', where: 'Receivables', amount: { currency: 'USD', minor: unalloc.reduce((t, a) => t + a.amount.minor, 0) }, deadline: null, action: plan });
  const { mailStatus } = await import('./s5.ts');
  const ch = await mailStatus(c);
  if (ch.state === 'EXPIRED' || ch.state === 'NOT_CONNECTED') out.push({ key: 'mail:channel', title: ch.state === 'EXPIRED' ? 'Gmail needs reconnecting' : 'Gmail is not connected', reason: `${ch.text}.`, where: 'Inbox', amount: null, deadline: null, action: inbox });
  return out;
}

// ---------- Session notice (UX repair, S7 audit F06) ----------
const NOTABLE = ['InvoiceCaptureVerified', 'FallbackSkipped', 'PayoutPaid'];
/** The newest confirmed receipt, skipped offer or supplier payment, in words, for a once-only shell notice. Persistent record: the
 * Activity row with the same event id. Cheap: one audit page and at most three item reads (the session polls every 2 s while watching). */
export async function noticeOf(c: ReadCtx): Promise<{ eventId: string; at: string; text: string; to?: string | null } | null> {
  const pk = K.run(c.tenantId, c.run.runId);
  const rows = await c.store.query('audit', pk, { newestFirst: true, limit: 30 });
  const hit = rows.find((r) => NOTABLE.includes(r.eventType));
  if (!hit) return null;
  const base = { eventId: hit.eventId as string, at: hit.occurredAt as string };
  if (hit.eventType === 'InvoiceCaptureVerified') {
    const [rc, inv] = await Promise.all([c.store.get('core', pk, `RCPT#${hit.refs?.captureId}`), c.store.get('core', pk, `INV#${hit.refs?.invoiceId}`)]);
    const cust = inv ? await c.store.get('core', pk, `CUST#${inv.customerId}`) : undefined;
    return rc ? { ...base, to: `/receivables?invoice=${encodeURIComponent(String(hit.refs?.invoiceId))}`, text: `${cust?.displayName ?? 'A customer'} paid ${money(rc.gross.minor)} on PayPal · confirmed by PayPal` } : null;
  }
  if (hit.eventType === 'FallbackSkipped') {
    const act = hit.refs?.actionId ? await c.store.get('core', pk, `ACT#${hit.refs.actionId}`) : undefined;
    return { ...base, to: act ? `/plan#act-${act.actionId}` : '/plan', text: act ? `${act.counterparty.name} discount not needed · you keep ${money(act.terms.discountAmount?.minor ?? 0)}` : 'Discount offer not needed · nothing was sent' };
  }
  const act = hit.refs?.actionId ? await c.store.get('core', pk, `ACT#${hit.refs.actionId}`) : undefined;
  return act ? { ...base, to: '/payables', text: `${act.counterparty.name} paid ${money(act.terms.amount.minor)} through PayPal · PayPal confirmed the payment` } : null;
}
