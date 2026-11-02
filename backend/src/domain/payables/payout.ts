// S6 supplier payout (S06 §6.1 D5–D10 as amended by §6.17 R1–R8). One record per intent: `EFFECT#pay:…`.
//   PAY due job → refresh → fenced snapshot → readiness → ONE queue TX (effect READY with frozen bytes, OBL payment RESERVED,
//   day charge, RESV# + funds bump) → dispatch claim TX (grants CONSUMED, authority frozen, charge moved to the dispatch day)
//   → POST the stored bytes (PayPal-Request-Id = sender_batch_id) → item GETs → only a bound item SUCCESS is PAID.
// UNKNOWN replays the same bytes and id until a batch id is known (then GET only) and never after the mutation deadline.
// Only the worker runs the executor (it holds the writer). Readiness is computed by the pure functions in payout-core.ts.
import { leaseClaimOps } from '../demo/lease.ts';
import { assertTransition, canTransition, TERMINAL_PAYOUT_STATES, type GrantKind, type HoldCode, type Occurrence, type PayoutEffect, type PayoutEffectState } from '@headroom/contracts';
import { createHash } from 'node:crypto';
import { basisBumpOp, fundsBumpOp, K } from '../../adapters/store/keys.ts';
import { TxCancelled, type Item, type Op } from '../../adapters/store/port.ts';
import { NoResponse, type HttpResult } from '../../adapters/paypal/types.ts';
import type { Deps } from '../../deps.ts';
import { finishOp, leaseCheck, newJob, putJobOp, requestRun, type Finish, type Lease } from '../../jobs/lease.ts';
import { fundsInputs, type ReadCtx } from '../../read/models.ts';
import { auditOp } from '../audit/audit.ts';
import { syncJobId, bindingOf } from '../bank-mirror/connect.ts';
import { decidePayout } from '../delegation/policy.ts';
import { LeaseLost } from '../executor/invoice-issue.ts';
import type { BillItem } from '../obligations/load.ts';
import { oblSk, parseOccKey } from '../obligations/obligations.ts';
import { observeBalance } from '../paypal-mirror/observe-balance.ts';
import { retainGet } from '../paypal-mirror/evidence.ts';
import { planCtxFor, runFenceCheck } from '../plan/authority.ts';
import { windowOf, windowOpen, zonedInstant, type Window } from '../plan/dates.ts';
import { grantCovers, loadPlanState, termsHashOf, type ActItem, type GrantItem, type PlanState } from '../plan/state.ts';
import type { SkipBlocker } from '../plan/skip.ts';
import { addMs, businessDate, DAY, MIN } from '../time.ts';
import { payeeSk, type PayeeItem } from './payee.ts';
import { assertSandboxReceivers } from '../../adapters/paypal/types.ts';
import { grantStopped } from '../../adapters/grant.ts';
import { classifyItem, companyVerdict, feeCeilingMinor, maxDebitMinor, MUTATION_WINDOW_MS, payKey, payoutBody, railVerdict, senderBatchIdOf, type CompanyResult, type RailResult } from './payout-core.ts';

export type PayEff = PayoutEffect & Item & { requestBytes: string };
type Obl = Item & { version: number; amount: { minor: number }; dueOn: string; substantiatedBy?: string; payment?: Occurrence['payment']; state?: string; nextPaymentVersion?: number; lastAttempt?: number; lastAttemptPv?: number };

export const PAY_AT_HHMM = '09:00';
/** RECHECK cadence while waiting for funds or evidence (S6-D5): every 15 min during business hours. */
export const RECHECK_MS = 15 * MIN;
const EVIDENCE_WAIT_MS = 15_000;
const VERIFY_STEPS_MS = [10_000, 20_000, 40_000];
const WATCH_DAYS = 30;
/** Holds that clear by themselves when money or evidence moves: rechecked. Anything else waits for the owner (release re-runs it). */
const FUNDS_CODES: HoldCode[] = ['RAIL_SHORT', 'COMPANY_RESERVE', 'WAITING_FOR_REPORT', 'EVIDENCE', 'PAYOUT_UNRESOLVED', 'INPUTS_CHANGED'];

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const dollars = (m: number) => `$${(m / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const spendDayPk = (connectionId: string, localDate: string) => `SPENDDAY#${connectionId}#${localDate}`;
export const resvSk = (effectKey: string) => `RESV#${effectKey}`;

// ---------- the fenced assessment (S6-D4 + R1/R3/R4) ----------
export interface Check { key: string; ok: boolean; code: HoldCode | null; text: string; ref: string | null }
export interface Assessment {
  occ: Occurrence | undefined; obl: Obl | undefined; payee: PayeeItem | undefined; bill: BillItem | undefined;
  faceMinor: number; localDate: string; dayOtherMinor: number; spendDay: Item | undefined;
  rail: RailResult; company: CompanyResult; checks: Check[];
  /** First failing check in the pill order (pause, paid, bill, payee, consent, split, rail, company, evidence, authority); null = ready. */
  hold: { code: HoldCode; text: string } | null;
  /** Only authority fails: "FUNDED · NEEDS APPROVAL". */
  fundedNeedsApproval: boolean;
  exception: boolean; grants: GrantItem[];
  conds: Op[]; checkedAt: string; asOf: string | null; fetchedAt: string | null;
  /** Other payouts' residual reservations already subtracted from the PayPal lower bound (display: "reserved"). */
  otherReservedMinor: number;
}

const stampOps = async (d: Pick<Deps, 'store'>, s: PlanState, itemId: string | null) => {
  const [plan, pp, bk] = await Promise.all([
    d.store.get('core', s.pk, 'PLAN'),
    s.ctx.connectionId ? d.store.get('provider', K.conn(s.ctx.connectionId), 'FUNDS') : undefined,
    itemId ? d.store.get('provider', K.plaid(itemId), 'FUNDS') : undefined,
  ]);
  const fence = (pk: string, it: Item | undefined): Op => (it ? { op: 'check', table: 'provider', pk, sk: 'FUNDS', cond: { eq: { stamp: it.stamp } } } : { op: 'check', table: 'provider', pk, sk: 'FUNDS', cond: { notExists: true } });
  return {
    key: `${plan?.basisStamp ?? 0}/${pp?.stamp ?? 0}/${bk?.stamp ?? 0}`,
    ops: [
      { op: 'check', table: 'core', pk: s.pk, sk: 'PLAN', cond: { eq: { basisStamp: plan?.basisStamp ?? 0 } } } as Op,
      ...(s.ctx.connectionId ? [fence(K.conn(s.ctx.connectionId), pp)] : []),
      ...(itemId ? [fence(K.plaid(itemId), bk)] : []),
    ],
  };
};
/** DynamoDB allows one op per item per TX: a check on an item that is also written becomes that write's condition. */
export function mergeChecks(ops: Op[]): Op[] {
  const key = (o: Op) => `${o.table}|${o.op === 'put' ? o.item.pk : o.pk}|${o.op === 'put' ? o.item.sk : o.sk}`;
  const writes = new Map(ops.filter((o) => o.op !== 'check').map((o) => [key(o), o]));
  const out: Op[] = [];
  for (const o of ops) {
    const w = o.op === 'check' ? writes.get(key(o)) : undefined;
    if (o.op === 'check' && w) { w.cond = { ...w.cond, ...o.cond, ...(w.cond?.eq || o.cond.eq ? { eq: { ...o.cond.eq, ...w.cond?.eq } } : {}) }; continue; }
    out.push(o);
  }
  return out;
}
const versionCheck = (table: 'core' | 'work', pk: string, sk: string, it: Item | undefined): Op =>
  it ? { op: 'check', table, pk, sk, cond: { eq: { version: it.version } } } : { op: 'check', table, pk, sk, cond: { notExists: true } };

/**
 * Readiness of one PAYOUT action now, with the TX conditions that fence everything it read (R3). The action's own reservation is
 * excluded and its payment applied at the ceiling, so the answer is the same whether it is unreserved, reserved or held (R1).
 * `ownCharge`: what this intent already charged to the day bucket (the claim re-decides limits without double counting it).
 */
export async function assessPayout(d: Pick<Deps, 'store' | 'now'>, s: PlanState, a: ActItem, o: { lockedAt?: string | null; ownCharge?: { date: string; minor: number } | null; extraBlockers?: SkipBlocker[]; ownEffectKey?: string | null } = {}): Promise<Assessment> {
  const now = d.now();
  const tz = s.ctx.run.settings.timeZone;
  const occKey = a.subject.occurrenceKey!;
  const occ = s.f.r.occurrences.find((x) => x.occurrenceKey === occKey);
  const p = parseOccKey(occKey);
  const binding = await bindingOf(d.store, s.ctx.tenantId, s.ctx.run.runId);
  const itemId = binding?.itemId ?? null;
  const localDate = businessDate(now, tz);
  const dayPk = spendDayPk(s.ctx.connectionId ?? 'none', localDate);
  for (let i = 0; ; i++) {
    const st = await stampOps(d, s, itemId);
    const [obl, payee, spendDay, x] = await Promise.all([
      p ? (d.store.get('core', s.pk, oblSk(p.commitmentId, p.n)) as Promise<Obl | undefined>) : undefined,
      d.store.get('core', s.pk, payeeSk(a.counterparty.id)) as Promise<PayeeItem | undefined>,
      d.store.get('work', dayPk, 'DAY'),
      // R1 own-intent exclusion (S6-IM-02): only this payment version's own unsent reservation, never an earlier version's debit.
      fundsInputs(s.ctx, { excludeOccurrence: occKey, excludePaymentVersion: a.terms.paymentVersion ?? 0 }),
    ]);
    const again = await stampOps(d, s, itemId);
    if (again.key !== st.key && i < 2) continue;
    const bill = occ?.substantiatedBy ? s.f.r.bills.find((b) => b.billId === occ.substantiatedBy) : undefined;
    const face = occ?.amount.minor ?? a.terms.amount.minor;
    const blockers: SkipBlocker[] = [...x.blockers, ...(o.extraBlockers ?? [])];
    if (again.key !== st.key) blockers.push({ code: 'INPUTS_MOVING', text: 'Inputs kept changing while checking', ref: null });
    if (o.lockedAt && itemId && (!x.bank.retrievedAt || x.bank.retrievedAt < o.lockedAt)) blockers.push({ code: 'REFRESH_INCOMPLETE', text: 'Bank balance not re-read since this check started', ref: 'bank' });
    const rail = railVerdict({ now, faceMinor: face, paypal: x.paypal, blockers: blockers.filter((b) => !b.code.startsWith('BANK') && b.ref !== 'bank') });
    const items = (x.f.days ?? []).flatMap((dd) => dd.items).filter((it) => it.key !== occKey);
    const company = companyVerdict({ now, today: x.f.today, reserveMinor: x.f.reserveMinor, faceMinor: face, bank: x.bank, paypal: x.paypal, items, blockers });
    const charged = o.ownCharge?.date === localDate ? o.ownCharge.minor : 0;
    const dayOther = Math.max(0, (spendDay?.sumMinor ?? 0) - charged);
    const current = decidePayout(s.policy, a.counterparty.id, maxDebitMinor(face), dayOther, face);
    const covering = (k: GrantKind) => s.grants.find((g) => g.kind === k && grantCovers(g, { ...a, authority: current }, now));
    const auth = covering('PAYOUT_AUTHORITY');
    const exc = current.grantKinds.includes('PAYOUT_EXCEPTION') ? covering('PAYOUT_EXCEPTION') : undefined;
    const t = a.terms;
    const billOk = !!bill && (bill.state === 'VERIFIED' || bill.state === 'TERMS_ACCEPTED');
    const checks: Check[] = [
      { key: 'paused', ok: !s.policy.pauses.payments, code: 'PAYMENTS_PAUSED', text: s.policy.pauses.payments ? 'Payments are paused' : 'Not paused', ref: 'POLICY' },
      // S6-IM-03: one live intent per obligation; only the claim of that very intent passes.
      { key: 'paid', ok: !(obl?.payment && obl.payment.effectKey !== o.ownEffectKey) && obl?.state !== 'PAID', code: 'ALREADY_PAID', text: obl?.state === 'PAID' ? 'Already paid through PayPal' : obl?.payment ? 'Another payment of this bill is in progress' : 'Not paid yet', ref: obl?.payment?.effectKey ?? null },
      { key: 'bill', ok: billOk, code: 'BILL_NOT_ACCEPTED', text: billOk ? `Bill ${bill!.billNumber ?? bill!.fileName} verified${bill!.state === 'TERMS_ACCEPTED' ? ' and its terms accepted by you' : ''}` : 'Bill not verified and accepted yet', ref: bill?.billId ?? null },
      { key: 'remittance', ok: !bill?.flags.includes('REMITTANCE_CHANGE'), code: 'REMITTANCE_CHANGED', text: bill?.flags.includes('REMITTANCE_CHANGE') ? 'The bill asks to pay different details · needs your review; never paid automatically' : 'No change to payment details', ref: bill?.billId ?? null },
      { key: 'payee', ok: payee?.state === 'CONFIRMED', code: 'PAYEE_UNCONFIRMED', text: payee?.state === 'CONFIRMED' ? `PayPal address ${payee.masked} confirmed by you` : payee ? `Confirm ${a.counterparty.name}'s PayPal address (${payee.masked})` : 'No PayPal address for this supplier', ref: payee ? payee.sk : null },
      { key: 'payeeVersion', ok: !!payee && !!t.payee && t.payee.version === payee.version && t.payee.receiverSha256 === payee.receiverSha256, code: 'PAYEE_CHANGED', text: !t.payee ? 'Needs your approval again: the payment now names the PayPal address and the maximum fee' : payee && t.payee.version !== payee.version ? 'The PayPal address changed after you approved this payment' : 'Approved for this exact address', ref: null },
      { key: 'consent', ok: !!t.maxDebit && t.maxDebit.minor === maxDebitMinor(face) && !!t.paymentVersion, code: 'CONSENT_CHANGED', text: t.maxDebit ? `Approved by you for this bill and this address · up to ${dollars(t.maxDebit.minor)} may leave PayPal` : 'Needs your approval again: the payment now names the PayPal address and the maximum fee', ref: null },
      { key: 'split', ok: t.amount.minor === face, code: 'SPLIT_REFUSED', text: t.amount.minor === face ? `Whole bill: ${dollars(face)}` : `Approved ${dollars(t.amount.minor)} but the bill is ${dollars(face)} · splitting a payment isn't supported`, ref: null },
      { key: 'running', ok: s.plan.running === a.revisionId, code: 'NOT_AUTHORIZED', text: s.plan.running === a.revisionId ? 'In the running plan' : 'Not in the running plan', ref: a.revisionId },
      { key: 'authority', ok: !!auth, code: 'NOT_AUTHORIZED', text: auth ? `Approved by you · revision ${s.revisions.find((r) => r.revisionId === auth.revisionId)?.n ?? '?'}` : 'Needs your payout authority', ref: auth?.grantId ?? null },
      { key: 'limits', ok: !current.grantKinds.includes('PAYOUT_EXCEPTION') || !!exc, code: 'LIMIT_NEEDS_EXCEPTION', text: current.grantKinds.includes('PAYOUT_EXCEPTION') ? (exc ? `Over your limits · one-time exception approved by you (${current.reasons.filter((r) => r.includes('limit')).join('; ')})` : `Needs a one-time exception: ${current.reasons.filter((r) => r.includes('limit')).join('; ')}`) : `Within your limits: ${dollars(maxDebitMinor(face))} incl. the fee ceiling`, ref: exc?.grantId ?? null },
    ];
    const order = ['paused', 'paid', 'bill', 'remittance', 'payee', 'payeeVersion', 'consent', 'split'];
    const authOrder = ['running', 'authority', 'limits'];
    const firstFail = order.map((k) => checks.find((c) => c.key === k)!).find((c) => !c.ok);
    const fundsHold: Assessment['hold'] = rail.verdict === 'FAIL' ? { code: 'RAIL_SHORT', text: rail.reasons[0] } : rail.verdict === 'HELD_EVIDENCE' ? { code: 'WAITING_FOR_REPORT', text: rail.reasons[0] }
      : company.verdict === 'FAIL' ? { code: 'COMPANY_RESERVE', text: `Company cash: ${company.reasons[0]}` } : rail.verdict === 'UNKNOWN' || company.verdict === 'UNKNOWN' ? { code: blockers.some((b) => b.code === 'PAYOUT_UNRESOLVED') ? 'PAYOUT_UNRESOLVED' : blockers.some((b) => b.code === 'INPUTS_MOVING') ? 'INPUTS_CHANGED' : 'EVIDENCE', text: `Can't verify the balance yet: ${[...new Set([...rail.reasons, ...company.reasons])].join('; ')}` } : null;
    const authFail = authOrder.map((k) => checks.find((c) => c.key === k)!).find((c) => !c.ok);
    const hold = firstFail ? { code: firstFail.code!, text: firstFail.text } : fundsHold ?? (authFail ? { code: authFail.code!, text: authFail.text } : null);
    const conds: Op[] = [
      runFenceCheck(s.ctx.tenantId, s.ctx.run.epoch), ...st.ops,
      { op: 'check', table: 'core', pk: a.pk, sk: a.sk, cond: { eq: { version: a.version, state: a.state, intentVersion: a.intentVersion } } },
      { op: 'check', table: 'core', pk: s.pk, sk: 'POLICY', cond: { eq: { version: s.policy.version } } },
      versionCheck('core', s.pk, payeeSk(a.counterparty.id), payee),
      ...(bill ? [versionCheck('core', s.pk, bill.sk, bill)] : []),
      ...[auth, exc].filter((g): g is GrantItem => !!g).map((g): Op => ({ op: 'check', table: 'core', pk: s.pk, sk: `GRANT#${g.grantId}`, cond: { eq: { state: 'ACTIVE', termsHash: g.termsHash } } })),
    ];
    return {
      occ, obl, payee, bill, faceMinor: face, localDate, dayOtherMinor: dayOther, spendDay, rail, company, checks, hold,
      fundedNeedsApproval: !firstFail && !fundsHold && !!authFail, exception: !!exc, grants: [auth, exc].filter((g): g is GrantItem => !!g),
      conds, checkedAt: now, asOf: x.paypal.asOf, fetchedAt: x.paypal.fetchedAt,
      otherReservedMinor: (x.estimate?.payouts ?? []).reduce((t, p) => t + p.residualLowerMinor, 0),
    };
  }
}

// ---------- PAY / RECHECK due job (S6-D5, T4) ----------
const audit = (d: Pick<Deps, 'now'>, tenantId: string, runId: string, type: Parameters<typeof auditOp>[0]['type'], result: string, refs: Record<string, string>, allowedBy: string | null = null) =>
  auditOp({ tenantId, runId, type, by: 'HEADROOM', allowedBy, result, refs, correlationId: refs.effectKey ?? `pay:${refs.actionId}:${d.now()}`, now: d.now() });
const actOp = (a: ActItem, to: ActItem['state'] | null, set: Record<string, unknown>): Op => {
  if (to && to !== a.state) assertTransition('Action', a.state, to);
  return { op: 'update', table: 'core', pk: a.pk, sk: a.sk, set: { ...set, ...(to ? { state: to } : {}), version: a.version + 1 }, cond: { eq: { version: a.version, state: a.state } } };
};
/** The next recheck inside the owner's window (Delegation `comms.window`); outside it, the next opening. */
function nextRecheck(now: string, tz: string, w: Window): string {
  const t = addMs(now, RECHECK_MS);
  const day = businessDate(t, tz);
  if (t < zonedInstant(day, w.open, tz)) return zonedInstant(day, w.open, tz);
  if (t > zonedInstant(day, w.close, tz)) return zonedInstant(businessDate(addMs(t, DAY), tz), w.open, tz);
  return t;
}

export async function runPayDue(d: Deps, l: Lease, s: PlanState, a: ActItem): Promise<void> {
  const [tenantId, runId] = [s.ctx.tenantId, s.ctx.run.runId];
  const now = d.now();
  const job = l.job as Lease['job'] & { phase?: string | null; lockedAt?: string | null };
  const finish = (f: Finish, ops: Op[] = []) => d.store.transact([...ops, finishOp(l, f)]).then(() => undefined, (e) => { if (!(e instanceof TxCancelled)) throw e; return d.store.transact([finishOp(l, { kind: 'requeue', at: d.now(), error: 'Inputs changed while deciding; re-checking' })]).catch(() => {}); });
  // 1. Evidence: PayPal re-read inline, a bank read requested; come back once it has had time (S5-D8 pattern).
  // A job revived later (a release, a recheck) starts with a fresh refresh: an evaluation phase is valid for 2 minutes only.
  if (job.phase !== 'EVALUATE' || !job.lockedAt || Date.parse(now) - Date.parse(job.lockedAt) > 2 * MIN) {
    await observeBalance(d).catch(() => undefined);
    const binding = await bindingOf(d.store, tenantId, runId);
    if (binding?.itemId) await requestRun(d.store, newJob(syncJobId(binding.itemId), 'PLAID_SYNC', binding.itemId, now, null, null), now);
    await d.store.transact([finishOp(l, { kind: 'requeue', at: addMs(now, binding?.itemId ? EVIDENCE_WAIT_MS : 0), resetAttempts: true, set: { phase: 'EVALUATE', lockedAt: now } })]);
    if (binding?.itemId) await d.queue.send(syncJobId(binding.itemId)).catch(() => {});
    return;
  }
  const back = { phase: null, lockedAt: null };
  const fresh = await loadPlanState((await planCtxFor(d, tenantId, runId))!);
  const cur = fresh.actions.find((x) => x.actionId === a.actionId) ?? a;
  // S6-IM-03: re-check on the fresh action; an unsent intent of this action is resumed by its own exec job, never queued twice.
  if (!['SCHEDULED', 'HELD', 'HELD_EVIDENCE'].includes(cur.state) || cur.intentVersion !== a.intentVersion) return finish({ kind: 'done' });
  const p0 = parseOccKey(cur.subject.occurrenceKey!);
  const held = p0 ? ((await d.store.get('core', fresh.pk, oblSk(p0.commitmentId, p0.n))) as Obl | undefined)?.payment : null;
  const heldEff = held ? await loadEff(d, held.effectKey) : undefined;
  if (heldEff && heldEff.actionId === cur.actionId && (heldEff.state === 'READY' || heldEff.state === 'HELD_READY')) {
    await finish({ kind: 'done' });
    await requestRun(d.store, newJob(`exec#${heldEff.effectKey}`, 'EXECUTE_EFFECT', heldEff.effectKey, now, tenantId, runId), now);
    await d.queue.send(`exec#${heldEff.effectKey}`).catch(() => {});
    return;
  }
  const as = await assessPayout(d, fresh, cur, { lockedAt: job.lockedAt });
  if (as.hold) {
    const code = as.hold.code;
    const to = code === 'WAITING_FOR_REPORT' || code === 'EVIDENCE' || code === 'PAYOUT_UNRESOLVED' || code === 'INPUTS_CHANGED' ? 'HELD_EVIDENCE' : 'HELD';
    const recheck = FUNDS_CODES.includes(code);
    const same = cur.state === to && cur.holdCode === code && cur.heldReasons[0] === as.hold.text;
    const ops: Op[] = same ? [] : [actOp(cur, cur.state === to ? null : to, { holdCode: code, heldReasons: [as.hold.text] }), audit(d, tenantId, runId, 'PayoutHeld', `${cur.counterparty.name}: not paid now · ${as.hold.text}${recheck ? ' · Headroom checks again every 15 minutes' : ''}`, { actionId: cur.actionId })];
    return finish(recheck ? { kind: 'requeue', at: nextRecheck(now, fresh.ctx.run.settings.timeZone, windowOf(fresh.policy)), resetAttempts: true, error: null, set: back } : { kind: 'done' }, ops);
  }
  const q = await queueOps(d, fresh, cur, as);
  await finish({ kind: 'done' }, q.ops);
  await d.queue.send(`exec#${q.effectKey}`).catch(() => {});
}

/** S6-D6 queue TX: the unique intent with frozen bytes, the obligation's lock, the day charge and the reservation, in one TX. */
async function queueOps(d: Deps, s: PlanState, a: ActItem, as: Assessment): Promise<{ ops: Op[]; effectKey: string }> {
  const [tenantId, runId, conn] = [s.ctx.tenantId, s.ctx.run.runId, s.ctx.connectionId!];
  const now = d.now();
  const pv = a.terms.paymentVersion!;
  const obl = as.obl!;
  const attempt = obl.lastAttemptPv === pv ? (obl.lastAttempt ?? 0) + 1 : 1;
  const occKey = a.subject.occurrenceKey!;
  const effectKey = payKey(tenantId, runId, occKey, pv, attempt);
  const sbid = senderBatchIdOf(runId, occKey, pv, attempt);
  const face = as.faceMinor;
  const ceiling = feeCeilingMinor(face);
  const bytes = payoutBody({ senderBatchId: sbid, receiver: as.payee!.receiver, amountMinor: face, business: s.ctx.run.settings.businessName ?? 'Headroom sandbox business', billNo: as.bill?.billNumber ?? null, senderItemId: `${parseOccKey(occKey)?.commitmentId ?? 'occ'}-${parseOccKey(occKey)?.n ?? 0}-v${pv}a${attempt}`.slice(0, 63) });
  assertSandboxReceivers(bytes); // S6-IM-08: refused here, before any reservation or claim, never after
  const eff: PayEff = {
    pk: K.effect(effectKey), sk: 'EFFECT', effectKey, tenantId, runId, epoch: s.ctx.run.epoch, connectionId: conn, actionId: a.actionId, rootId: a.rootId, occurrenceKey: occKey, supplierId: a.counterparty.id,
    paymentVersion: pv, attempt, intentVersion: a.intentVersion, state: 'READY', version: 1,
    amount: { currency: 'USD', minor: face }, feeCeiling: { currency: 'USD', minor: ceiling }, maxDebit: { currency: 'USD', minor: face + ceiling },
    payee: { version: as.payee!.version, receiverSha256: as.payee!.receiverSha256, masked: as.payee!.masked }, termsHash: a.termsHash,
    senderBatchId: sbid, request: { sha256: sha(bytes) }, requestBytes: bytes, chargedDate: as.localDate,
    firstDispatchAt: null, mutationDeadline: null, authority: [], batchId: null, itemId: null, itemStatus: null, transactionId: null, fee: null, timeProcessed: null,
    attempts: 0, unknownSince: null, failure: null, heldReason: null, timeline: [{ at: now, event: `Reserved ${dollars(face)} on PayPal`, ref: sbid }], updatedAt: now,
  };
  const dayPk = spendDayPk(conn, as.localDate);
  return {
    effectKey,
    ops: mergeChecks([
      ...as.conds.filter((op) => !(op.op === 'check' && op.pk === a.pk && op.sk === a.sk)),
      { op: 'put', table: 'work', item: eff, cond: { notExists: true } },
      { op: 'update', table: 'core', pk: obl.pk, sk: obl.sk, set: { payment: { effectKey, stage: 'RESERVED' }, lastEffectKey: effectKey, lastAttempt: attempt, lastAttemptPv: pv, version: obl.version + 1 }, cond: { eq: { version: obl.version } } },
      as.spendDay ? { op: 'update', table: 'work', pk: dayPk, sk: 'DAY', add: { sumMinor: face + ceiling, version: 1 }, cond: { eq: { version: as.spendDay.version } } }
        : { op: 'put', table: 'work', item: { pk: dayPk, sk: 'DAY', connectionId: conn, localDate: as.localDate, sumMinor: face + ceiling, version: 1 }, cond: { notExists: true } },
      { op: 'put', table: 'provider', item: { pk: K.conn(conn), sk: resvSk(effectKey), effectKey, tenantId, runId, occurrenceKey: occKey, state: 'ACTIVE', faceMinor: face, debitMinor: face + ceiling, transactionId: null, itemId: null, inFlight: false, version: 1 }, cond: { notExists: true } },
      fundsBumpOp(K.conn(conn)), basisBumpOp(s.pk),
      actOp(a, 'QUEUED', { holdCode: null, heldReasons: [`Reserved ${dollars(face)} on PayPal · sending to PayPal`] }),
      putJobOp(newJob(`exec#${effectKey}`, 'EXECUTE_EFFECT', effectKey, now, tenantId, runId)),
      audit(d, tenantId, runId, 'PayoutReserved', `${a.counterparty.name}: ${dollars(face)} set aside for this payout · not paid yet · counts toward ${as.localDate}'s payment limit`, { actionId: a.actionId, effectKey }),
    ]),
  };
}

/** The action re-proposed at payment version `pv` (R7): its terms hash changes, so no earlier grant covers it. */
function nextVersionTerms(a: ActItem, pv: number) {
  const terms = { ...a.terms, paymentVersion: pv };
  return { terms, termsHash: termsHashOf({ ...a, terms }) };
}

// ---------- the executor (worker only) ----------
const loadEff = async (d: Pick<Deps, 'store'>, key: string) => (await d.store.get('work', K.effect(key), 'EFFECT')) as PayEff | undefined;
const loadAct = async (d: Pick<Deps, 'store'>, e: PayEff) => (await d.store.get('core', K.run(e.tenantId, e.runId), `ACT#${e.actionId}`)) as ActItem | undefined;
const loadObl = async (d: Pick<Deps, 'store'>, e: PayEff) => { const p = parseOccKey(e.occurrenceKey)!; return (await d.store.get('core', K.run(e.tenantId, e.runId), oblSk(p.commitmentId, p.n))) as Obl | undefined; };
const effAudit = (d: Pick<Deps, 'now'>, e: PayEff, type: Parameters<typeof auditOp>[0]['type'], result: string, allowedBy: string | null = null) =>
  auditOp({ tenantId: e.tenantId, runId: e.runId, type, by: 'HEADROOM', allowedBy, result, refs: { effectKey: e.effectKey, actionId: e.actionId, senderBatchId: e.senderBatchId }, correlationId: e.effectKey, now: d.now() });
const allowedText = (e: PayEff) => (e.authority.length ? `Your permission ${e.authority.map((x) => x.id).join(' + ')}` : null);
const resvOp = (e: PayEff, set: Record<string, unknown>, cond: Record<string, unknown> = {}): Op => ({ op: 'update', table: 'provider', pk: K.conn(e.connectionId), sk: resvSk(e.effectKey), set, add: { version: 1 }, cond: { exists: true, ...(Object.keys(cond).length ? { eq: cond } : {}) } });

async function step(d: Deps, l: Lease, e: PayEff, to: PayoutEffectState, x: { set?: Record<string, unknown>; ops?: Op[]; finish?: Finish; event?: string; ref?: string | null } = {}) {
  if (to !== e.state) assertTransition('PayoutEffect', e.state, to);
  const timeline = x.event ? [...e.timeline, { at: d.now(), event: x.event, ref: x.ref ?? null }] : e.timeline;
  try {
    await d.store.transact([
      { op: 'update', table: 'work', pk: e.pk, sk: 'EFFECT', set: { state: to, updatedAt: d.now(), timeline, ...x.set }, add: { version: 1 }, cond: { eq: { state: e.state, version: e.version } } },
      ...(x.ops ?? []),
      x.finish ? finishOp(l, x.finish) : leaseCheck(l),
    ]);
  } catch (err) {
    if (err instanceof TxCancelled) throw new LeaseLost(`payout ${e.effectKey} ${e.state} → ${to} refused`);
    throw err;
  }
  Object.assign(e, { state: to, version: e.version + 1, timeline, ...x.set });
}
async function call(fn: () => Promise<HttpResult>): Promise<HttpResult | undefined> {
  try { return await fn(); } catch (err) { if (err instanceof NoResponse) return undefined; throw err; }
}
const requeue = (d: Deps, l: Lease, at: string, error: string | null = null, type?: 'RECONCILE_EFFECT') => d.store.transact([finishOp(l, { kind: 'requeue', at, error, ...(type ? { type } : {}) })]).then(() => undefined);

/** EXECUTE_EFFECT / RECONCILE_EFFECT for a `pay:` key: the effect's state decides what happens. */
export async function executePayout(d: Deps, l: Lease): Promise<void> {
  if (!d.writer) throw new Error('payout executor constructed without a PayPal writer');
  const e = await loadEff(d, l.job.ref);
  if (!e || TERMINAL_PAYOUT_STATES.includes(e.state) || e.state === 'UNKNOWN_UNRESOLVED') return d.store.transact([finishOp(l, { kind: 'done' })]);
  // HELD_READY runs only when a release (resume, confirm) or the reset sweep pulled it: back to READY, and the claim re-checks everything.
  if (e.state === 'HELD_READY') await step(d, l, e, 'READY', { set: { heldReason: null }, event: 'Resumed · re-checking before sending' });
  if (e.state === 'READY') return claimAndPost(d, l, e);
  if (e.state === 'DISPATCHED') { await toUnknown(d, l, e, 'Worker stopped after dispatch'); return; }
  if (e.state === 'UNKNOWN') return reconcileUnknown(d, l, e);
  return verify(d, l, e);
}

/** R7: never claimed, so release everything it held, in one TX. The grants were never consumed. */
async function cancelUnsent(d: Deps, l: Lease, e: PayEff, code: HoldCode, text: string, recheck: boolean) {
  const a = await loadAct(d, e);
  const obl = await loadObl(d, e);
  const day = await d.store.get('work', spendDayPk(e.connectionId, e.chargedDate), 'DAY');
  const ops: Op[] = [
    resvOp(e, { state: 'RELEASED', inFlight: false }, { state: 'ACTIVE' }), fundsBumpOp(K.conn(e.connectionId)), basisBumpOp(K.run(e.tenantId, e.runId)),
    ...(day ? [{ op: 'update', table: 'work', pk: day.pk, sk: 'DAY', add: { sumMinor: -e.maxDebit.minor, version: 1 }, cond: { eq: { version: day.version } } } as Op] : []),
    ...(obl?.payment?.effectKey === e.effectKey ? [{ op: 'update', table: 'core', pk: obl.pk, sk: obl.sk, set: { payment: null, version: obl.version + 1 }, cond: { eq: { version: obl.version } } } as Op] : []),
    ...(a && a.state === 'QUEUED' ? [actOp(a, 'HELD', { holdCode: code, heldReasons: [text] })] : a && a.state === 'HELD' ? [actOp(a, null, { holdCode: code, heldReasons: [text] })] : []),
    // The PAY job comes back for holds that clear by themselves; owner-cleared ones are re-run by the release.
    ...(a && recheck ? [putJobOp(newJob(`due#${a.actionId}#${a.intentVersion}#PAY#${e.attempt}`, 'ACTION_DUE', a.actionId, addMs(d.now(), RECHECK_MS), e.tenantId, e.runId))] : []),
    effAudit(d, e, 'PayoutCancelledUnsent', `Not sent: ${text} · the reservation and day charge are released; nothing went to PayPal`),
  ];
  await step(d, l, e, 'CANCELLED_UNSENT', { set: { failure: text }, ops, finish: { kind: 'done' }, event: `Not sent · ${text}` });
}

async function holdReady(d: Deps, l: Lease, e: PayEff, code: HoldCode, text: string) {
  const a = await loadAct(d, e);
  await step(d, l, e, 'HELD_READY', {
    set: { heldReason: text },
    ops: [...(a && a.state === 'QUEUED' ? [actOp(a, 'HELD', { holdCode: code, heldReasons: [text] })] : []), effAudit(d, e, 'PayoutHeldReady', `Held before sending: ${text} · the reservation is kept until you resume`)],
    finish: { kind: 'done' }, event: `Held · ${text}`,
  });
}

/** Dispatch claim (S6-D7 + R3/R5/R8), then POST the stored bytes. */
async function claimAndPost(d: Deps, l: Lease, e: PayEff) {
  await d.hooks?.beforePayoutClaim?.(e.effectKey);
  const fence = await d.store.get('core', K.tenant(e.tenantId), 'RUN_FENCE');
  if (fence?.epoch !== e.epoch) return cancelUnsent(d, l, e, 'NOT_AUTHORIZED', 'the run was reset before this payout was sent', false);
  const rc = await planCtxFor(d, e.tenantId, e.runId);
  const a = rc && (await loadAct(d, e));
  if (!rc || !a) return cancelUnsent(d, l, e, 'NOT_AUTHORIZED', 'its plan action no longer exists', false);
  const s = await loadPlanState(rc);
  const cur = s.actions.find((x) => x.actionId === a.actionId)!;
  const as = await assessPayout(d, s, cur, { ownCharge: { date: e.chargedDate, minor: e.maxDebit.minor }, ownEffectKey: e.effectKey });
  // S6-IM-08: a spent PayPal payout budget is known before the claim: wait (nothing claimed, nothing sent).
  const stopped = await grantStopped(d.store, d.config.grant, 'paypal', 'payouts', d.now());
  if (stopped) return requeue(d, l, addMs(d.now(), RECHECK_MS), `Not sent: ${stopped}`);
  // S7a-IR-04: payouts go only inside the owner's contact and payment window, rechecked at the claim (the window may have changed).
  const opens = windowOpen(d.now(), s.ctx.run.settings.timeZone, windowOf(s.policy));
  if (opens) return requeue(d, l, opens, 'Not sent yet: outside your payment window; sends when it opens');
  // R3: the intent's frozen terms must still be what the current records say, or it is never sent.
  const frozenOk = as.faceMinor === e.amount.minor && cur.termsHash === e.termsHash && as.payee?.version === e.payee.version && as.payee?.receiverSha256 === e.payee.receiverSha256 && cur.intentVersion === e.intentVersion;
  if (!frozenOk) return cancelUnsent(d, l, e, 'CONSENT_CHANGED', 'the bill, the address or your approval changed after it was reserved', false);
  if (as.hold) {
    if (as.hold.code === 'PAYMENTS_PAUSED' || as.hold.code === 'PAYEE_UNCONFIRMED') return holdReady(d, l, e, as.hold.code, as.hold.text);
    if (as.hold.code === 'INPUTS_CHANGED' && l.job.attempts <= 3) return requeue(d, l, d.now(), 'Inputs moved before the claim; re-checking');
    return cancelUnsent(d, l, e, as.hold.code, as.hold.text, FUNDS_CODES.includes(as.hold.code));
  }
  const now = d.now();
  // R8: the day charge follows the actual dispatch day, under that day's cap (or the exception), in this same TX.
  const moveOps: Op[] = [];
  if (as.localDate !== e.chargedDate) {
    const src = await d.store.get('work', spendDayPk(e.connectionId, e.chargedDate), 'DAY');
    if (src) moveOps.push({ op: 'update', table: 'work', pk: src.pk, sk: 'DAY', add: { sumMinor: -e.maxDebit.minor, version: 1 }, cond: { eq: { version: src.version } } });
    const dst = spendDayPk(e.connectionId, as.localDate);
    moveOps.push(as.spendDay ? { op: 'update', table: 'work', pk: dst, sk: 'DAY', add: { sumMinor: e.maxDebit.minor, version: 1 }, cond: { eq: { version: as.spendDay.version } } }
      : { op: 'put', table: 'work', item: { pk: dst, sk: 'DAY', connectionId: e.connectionId, localDate: as.localDate, sumMinor: e.maxDebit.minor, version: 1 }, cond: { notExists: true } },
    effAudit(d, e, 'PayoutChargeMoved', `Day charge moved from ${e.chargedDate} to ${as.localDate}, the day it is sent`));
  } else if (as.spendDay) moveOps.push({ op: 'check', table: 'work', pk: as.spendDay.pk, sk: 'DAY', cond: { eq: { version: as.spendDay.version } } });
  const obl = as.obl!;
  const authority = as.grants.map((g) => ({ kind: 'GRANT' as const, id: g.grantId, policyVersion: null, winningRule: null }));
  const grantSks = new Set(as.grants.map((g) => `GRANT#${g.grantId}`));
  try {
    await step(d, l, e, 'DISPATCHED', {
      set: { authority, firstDispatchAt: e.firstDispatchAt ?? now, mutationDeadline: e.mutationDeadline ?? addMs(now, MUTATION_WINDOW_MS), chargedDate: as.localDate },
      ops: mergeChecks([
        // One op per item per TX: the grants and (when held) the action are updated below with their own conditions.
        ...as.conds.filter((op) => !(op.op === 'check' && op.table === 'core' && (grantSks.has(op.sk) || (cur.state === 'HELD' && op.sk === cur.sk)))),
        ...as.grants.map((g): Op => ({ op: 'update', table: 'core', pk: s.pk, sk: `GRANT#${g.grantId}`, set: { state: 'CONSUMED', consumedBy: e.effectKey }, cond: { eq: { state: 'ACTIVE', termsHash: g.termsHash } } })),
        // The consent of this payment version is spent: any new payment of this bill needs a new version and a new approval.
        { op: 'update', table: 'core', pk: obl.pk, sk: obl.sk, set: { payment: { effectKey: e.effectKey, stage: 'IN_FLIGHT' }, nextPaymentVersion: e.paymentVersion + 1, version: obl.version + 1 }, cond: { eq: { version: obl.version } } },
        resvOp(e, { inFlight: true }, { state: 'ACTIVE' }), fundsBumpOp(K.conn(e.connectionId)),
        ...(await leaseClaimOps(d.store, e.connectionId, e.tenantId, e.runId, now)),
        ...moveOps,
        ...(cur.state === 'HELD' ? [actOp(cur, 'QUEUED', { holdCode: null, heldReasons: ['Sending to PayPal'] })] : []),
        ...as.grants.map((g) => effAudit(d, e, 'GrantConsumed', `Permission ${g.grantId} used by this payout; it can't be used again`)),
        effAudit(d, e, 'PayoutDispatched', `Sending ${dollars(e.amount.minor)} to ${e.payee.masked} through PayPal Payouts`, allowedText({ ...e, authority })),
      ]),
      event: `Sent to PayPal · payment id ${e.senderBatchId}`, ref: e.senderBatchId,
    });
  } catch (err) {
    // Something moved between the gate and the claim (pause, revoke, a charge, a reset): nothing was sent. Re-check now.
    if (err instanceof LeaseLost) return requeue(d, l, d.now(), 'Dispatch claim refused: something changed; re-checking').catch(() => {});
    throw err;
  }
  const res = await call(() => d.writer!.createPayout(e.requestBytes, e.senderBatchId));
  return afterCreate(d, l, e, res, true);
}

const linkBatchId = (r: HttpResult) => {
  const href: string | undefined = r.body?.details?.flatMap((x: any) => (Array.isArray(x.link) ? x.link : x.link ? [x.link] : [])).find((k: any) => /\/v1\/payments\/payouts\//.test(k?.href ?? ''))?.href;
  return href ? decodeURIComponent(href.split('/').pop()!) : null;
};
const isDuplicate = (r: HttpResult) => r.status === 400 && (r.body?.details ?? []).some((x: any) => /already exists/i.test(x.issue ?? ''));

/** Classify a create (or replay) response. Only the first dispatch's own synchronous 4xx with no batch is definitive (R5). */
async function afterCreate(d: Deps, l: Lease, e: PayEff, r: HttpResult | undefined, first: boolean) {
  if (r) await retainGet(d.store, K.conn(e.connectionId), 'payout create', r, d.now()).catch(() => undefined);
  if (r?.status === 201 && r.body?.batch_header?.payout_batch_id) return submitted(d, l, e, r.body.batch_header.payout_batch_id, 'PayPal accepted the payout');
  if (r && isDuplicate(r)) {
    const id = linkBatchId(r);
    if (id) return submitted(d, l, e, id, 'PayPal already had this payment id: reading that batch, never a second one');
  }
  if (r && first && (r.status === 422 || (r.status === 400 && !isDuplicate(r)))) return rejected(d, l, e, r);
  return toUnknown(d, l, e, !r ? 'No response from PayPal' : `PayPal answered ${r.status}`);
}

/** The batch id is persisted in its own TX before anything else: from now on, GET only (R5). */
async function submitted(d: Deps, l: Lease, e: PayEff, batchId: string, why: string) {
  const a = await loadAct(d, e);
  await step(d, l, e, 'SUBMITTED', {
    set: { batchId, heldReason: null },
    ops: [
      ...(a && (a.state === 'QUEUED' || a.state === 'UNCERTAIN') ? [actOp(a, 'APPLIED', { heldReasons: [`Sent to PayPal · waiting for ${a.counterparty.name}'s item`] })] : []),
      effAudit(d, e, 'PayoutSubmitted', `${why}. Not paid until PayPal confirms the payment reached the supplier`, allowedText(e)),
    ],
    finish: { kind: 'requeue', at: addMs(d.now(), VERIFY_STEPS_MS[0]), type: 'RECONCILE_EFFECT', resetAttempts: true, error: null },
    event: `PayPal batch ${batchId}`, ref: batchId,
  });
}

/** Probe 006: a synchronous 422 (e.g. INSUFFICIENT_FUNDS) creates no batch. Released; the grants stay spent (a retry needs a new approval). */
async function rejected(d: Deps, l: Lease, e: PayEff, r: HttpResult) {
  const reason = `${r.body?.name ?? r.status}${r.body?.message ? `: ${r.body.message}` : ''}`;
  const a = await loadAct(d, e);
  const obl = await loadObl(d, e);
  const day = await d.store.get('work', spendDayPk(e.connectionId, e.chargedDate), 'DAY');
  await step(d, l, e, 'REJECTED', {
    set: { failure: reason },
    ops: [
      resvOp(e, { state: 'RELEASED', inFlight: false }), fundsBumpOp(K.conn(e.connectionId)), basisBumpOp(K.run(e.tenantId, e.runId)),
      ...(day ? [{ op: 'update', table: 'work', pk: day.pk, sk: 'DAY', add: { sumMinor: -e.maxDebit.minor, version: 1 }, cond: { eq: { version: day.version } } } as Op] : []),
      ...(obl?.payment?.effectKey === e.effectKey ? [{ op: 'update', table: 'core', pk: obl.pk, sk: obl.sk, set: { payment: null, version: obl.version + 1 }, cond: { eq: { version: obl.version } } } as Op] : []),
      // R7/S6-IM-01: the spent consent can't be reused: the action moves to the next payment version, so re-approval records new grants.
      ...(a && canTransition('Action', a.state, 'HELD') ? [actOp(a, 'HELD', { holdCode: 'PROVIDER_REFUSED', heldReasons: [`PayPal refused: ${reason} · nothing was paid · approve again to try a new payment`], ...nextVersionTerms(a, e.paymentVersion + 1) })] : []),
      effAudit(d, e, 'PayoutRejected', `PayPal refused the payout (${reason}); no batch was created, the reservation is released, and it is never retried automatically`, allowedText(e)),
    ],
    finish: { kind: 'done' }, event: `PayPal refused · ${reason}`,
  });
}

async function toUnknown(d: Deps, l: Lease, e: PayEff, reason: string) {
  const now = d.now();
  const a = await loadAct(d, e);
  const first = e.state !== 'UNKNOWN';
  const wait = [30_000, 2 * MIN][e.attempts] ?? RECHECK_MS;
  await step(d, l, e, 'UNKNOWN', {
    set: { unknownSince: e.unknownSince ?? now, attempts: e.attempts + (first ? 0 : 1) },
    ops: [
      ...(a?.state === 'QUEUED' ? [actOp(a, 'UNCERTAIN', { heldReasons: [`Checking with PayPal · payment id ${e.senderBatchId}`] })] : []),
      ...(first ? [effAudit(d, e, 'PayoutUnknown', `${reason}; checking with PayPal using the same payment id ${e.senderBatchId}, never a new one`)] : []),
    ],
    finish: { kind: 'requeue', at: addMs(now, wait), type: 'RECONCILE_EFFECT', error: reason, unknownSince: e.unknownSince ?? now },
    ...(first ? { event: `Unknown · ${reason} · checking with PayPal`, ref: e.senderBatchId } : {}),
  });
}

/** R5: replay the stored bytes with the same id until the deadline; paused → no POST; past the deadline → UNKNOWN_UNRESOLVED. */
async function reconcileUnknown(d: Deps, l: Lease, e: PayEff) {
  if (e.batchId) return submitted(d, l, e, e.batchId, 'Batch id already known');
  const now = d.now();
  if (e.mutationDeadline && now >= e.mutationDeadline) {
    return step(d, l, e, 'UNKNOWN_UNRESOLVED', {
      ops: [effAudit(d, e, 'PayoutUnknownUnresolved', `Headroom can't confirm whether PayPal payment ${e.senderBatchId} was made, and it no longer resends after 25 days. Check PayPal activity; if you find the batch, the operator can attach its id. The reservation stays`)],
      finish: { kind: 'done' }, event: "Can't confirm with PayPal · needs you", ref: e.senderBatchId,
    });
  }
  const policy = await d.store.get('core', K.run(e.tenantId, e.runId), 'POLICY');
  const fence = await d.store.get('core', K.tenant(e.tenantId), 'RUN_FENCE');
  const active = fence && fence.runId !== e.runId ? await d.store.get('core', K.run(e.tenantId, fence.runId), 'POLICY') : undefined;
  // R5/S6-IM-09: a pause blocks every POST, replays included: this run's pause or the active run's after a reset.
  if (policy?.pauses?.payments || active?.pauses?.payments) {
    await d.store.transact([{ op: 'update', table: 'work', pk: e.pk, sk: 'EFFECT', set: { heldReason: 'Unknown · paused · resume to let Headroom check with PayPal' }, cond: { eq: { version: e.version } } }, finishOp(l, { kind: 'requeue', at: addMs(now, RECHECK_MS), error: 'Paused: no replay' })]);
    return;
  }
  const r = await call(() => d.writer!.createPayout(e.requestBytes, e.senderBatchId));
  return afterCreate(d, l, e, r, false);
}

/** Item GET (S6-D8). Only a bound SUCCESS pays; PENDING/UNCLAIMED/ONHOLD wait; FAILED & co. are final; other figures → HOLD. */
async function verify(d: Deps, l: Lease, e: PayEff) {
  const now = d.now();
  let itemId = e.itemId;
  if (!itemId) {
    const b = await call(() => d.reader.getPayoutBatch(e.batchId!));
    if (b) await retainGet(d.store, K.conn(e.connectionId), 'payout batch', b, now).catch(() => undefined);
    itemId = b?.status === 200 ? (b.body?.items?.[0]?.payout_item_id ?? null) : null;
    if (!itemId) return requeue(d, l, addMs(now, VERIFY_STEPS_MS[Math.min(l.job.attempts, 2)] ?? RECHECK_MS), 'Waiting for PayPal to list the item', 'RECONCILE_EFFECT');
  }
  const g = await call(() => d.reader.getPayoutItem(itemId!));
  if (g?.status !== 200) return requeue(d, l, addMs(now, MIN), `Item read ${g?.status ?? 'failed'}`, 'RECONCILE_EFFECT');
  await retainGet(d.store, K.conn(e.connectionId), 'payout item', g, now).catch(() => undefined);
  const v = classifyItem(g.body, { senderBatchId: e.senderBatchId, amountMinor: e.amount.minor, receiverSha256: e.payee.receiverSha256, batchId: e.batchId });
  const txn = g.body?.transaction_id ?? null;
  const a = await loadAct(d, e);
  if (v.kind === 'PAID') return paid(d, l, e, a, v, itemId);
  if (v.kind === 'MISMATCH') {
    const text = `PayPal shows a different payment (${v.why}); check PayPal · never counted as paid`;
    if (e.state === 'HOLD') return requeue(d, l, addMs(now, RECHECK_MS), text, 'RECONCILE_EFFECT');
    return step(d, l, e, 'HOLD', { set: { itemId, itemStatus: g.body?.transaction_status ?? null, heldReason: text }, ops: [effAudit(d, e, 'ReconciliationHold', text)], finish: { kind: 'requeue', at: addMs(now, RECHECK_MS), type: 'RECONCILE_EFFECT', error: text }, event: `Hold · ${text}` });
  }
  if (v.kind === 'FINAL') return notPaidFinal(d, l, e, a, v.status, v.reason, itemId, txn);
  if (v.kind === 'NOT_PAID' || v.kind === 'RETURNED') {
    const status = v.kind === 'NOT_PAID' ? v.status : v.status;
    const unclaimed = status === 'UNCLAIMED';
    const text = unclaimed
      ? `Not paid · ${a?.counterparty.name ?? 'The supplier'} hasn't claimed it at ${e.payee.masked}. PayPal returns unclaimed payments after 30 days. Ask them to sign in to PayPal with this address.`
      : `Not paid yet · PayPal shows the item ${status.toLowerCase()}`;
    const steps = l.job.attempts;
    const at = unclaimed ? addMs(now, DAY) : addMs(now, VERIFY_STEPS_MS[steps] ?? RECHECK_MS);
    const changed = e.itemStatus !== status || e.state !== 'NOT_PAID';
    return step(d, l, e, 'NOT_PAID', {
      set: { itemId, itemStatus: status, transactionId: txn },
      ops: [
        ...(txn && !e.transactionId ? [resvOp(e, { transactionId: txn, itemId })] : []),
        ...(a && changed && (a.state === 'APPLIED' || a.state === 'UNCERTAIN' || a.state === 'QUEUED') ? [actOp(a, a.state === 'APPLIED' ? null : 'APPLIED', { heldReasons: [text] })] : []),
        ...(changed ? [effAudit(d, e, 'PayoutItemObserved', `PayPal status ${String(status).toLowerCase().replace(/_/g, ' ')}: ${text}`)] : []),
      ],
      finish: { kind: 'requeue', at, type: 'RECONCILE_EFFECT', error: null },
      ...(changed ? { event: `Item ${status}${unclaimed ? ' · not paid' : ''}`, ref: itemId } : {}),
    });
  }
}

/** The PAID TX (S6-D8 + R1/R4/R6): one bound item SUCCESS → paid once, settled at the actual fee, watched for 30 days. */
async function paid(d: Deps, l: Lease, e: PayEff, a: ActItem | undefined, v: Extract<ReturnType<typeof classifyItem>, { kind: 'PAID' }>, itemId: string) {
  const now = d.now();
  const obl = await loadObl(d, e);
  const face = e.amount.minor;
  const debit = face + v.feeMinor;
  const day = await d.store.get('work', spendDayPk(e.connectionId, e.chargedDate), 'DAY');
  const over = v.feeMinor > e.feeCeiling.minor;
  const ops: Op[] = [
    { op: 'put', table: 'provider', item: { pk: `PPREF#PAYOUTITEM#${itemId}`, sk: 'REF', effectKey: e.effectKey, tenantId: e.tenantId, runId: e.runId }, cond: { notExists: true } },
    resvOp(e, { state: 'SETTLED', debitMinor: debit, transactionId: v.transactionId, itemId, inFlight: false }, { state: 'ACTIVE' }),
    fundsBumpOp(K.conn(e.connectionId)), basisBumpOp(K.run(e.tenantId, e.runId)),
    // R4: the day keeps face + actual fee.
    ...(day ? [{ op: 'update', table: 'work', pk: day.pk, sk: 'DAY', add: { sumMinor: -(e.maxDebit.minor - debit), version: 1 }, cond: { eq: { version: day.version } } } as Op] : []),
    // R6: the holder stays the paid intent, so the bill can't be paid twice.
    ...(obl ? [(() => { assertTransition('Obligation', obl.state ?? 'SCHEDULED', 'PAID'); return { op: 'update', table: 'core', pk: obl.pk, sk: obl.sk, set: { state: 'PAID', payment: { effectKey: e.effectKey, stage: 'PAID' }, version: obl.version + 1 }, cond: { eq: { version: obl.version } } } as Op; })()] : []),
    ...(a ? (() => {
      const steps: Op[] = [];
      if (a.state === 'UNCERTAIN' || a.state === 'QUEUED') assertTransition('Action', a.state, 'APPLIED');
      if (a.state !== 'COMPLETED') { assertTransition('Action', a.state === 'APPLIED' || a.state === 'UNCERTAIN' || a.state === 'QUEUED' ? 'APPLIED' : a.state, 'COMPLETED'); steps.push({ op: 'update', table: 'core', pk: a.pk, sk: a.sk, set: { state: 'COMPLETED', holdCode: null, heldReasons: [`Paid ${dollars(face)} through PayPal`], version: a.version + 1 }, cond: { eq: { version: a.version } } }); }
      return steps;
    })() : []),
    putJobOp(newJob(`paywatch#${e.effectKey}`, 'PAYOUT_WATCH', e.effectKey, addMs(now, DAY), e.tenantId, e.runId)),
    effAudit(d, e, 'PayoutPaid', `Paid: PayPal confirmed ${dollars(face)} reached ${e.payee.masked}${over ? ' · PayPal charged more than Headroom kept aside for it' : ''}`, allowedText(e)),
  ];
  try {
    await step(d, l, e, 'PAID', { set: { itemId, itemStatus: 'SUCCESS', transactionId: v.transactionId, fee: { currency: 'USD', minor: v.feeMinor }, timeProcessed: v.timeProcessed, heldReason: null }, ops, finish: { kind: 'done' }, event: 'Item SUCCESS · Paid', ref: itemId });
  } catch (err) {
    // Another verifier already recorded this item (R7 race): the effect moved on; nothing is paid twice.
    if (err instanceof LeaseLost) return requeue(d, l, d.now(), 'Already recorded').catch(() => {});
    throw err;
  }
}

async function notPaidFinal(d: Deps, l: Lease, e: PayEff, a: ActItem | undefined, status: string, reason: string, itemId: string, txn: string | null) {
  const obl = await loadObl(d, e);
  const day = await d.store.get('work', spendDayPk(e.connectionId, e.chargedDate), 'DAY');
  const text = `Not paid · PayPal shows the item ${status.toLowerCase()} (${reason}); the bill stays open`;
  // ponytail: the reservation stays (ACTIVE, not in flight) until PayPal's report proves the money came back; only R2 may release it.
  // Ceiling: a failed payout keeps lowering the PayPal lower bound by its ceiling. Upgrade: release on a reconciled hold + release with no T0001.
  await step(d, l, e, 'NOT_PAID_FINAL', {
    set: { itemId, itemStatus: status, transactionId: txn, failure: text },
    ops: [
      resvOp(e, { inFlight: false, finalNotPaid: true, ...(txn ? { transactionId: txn, itemId } : {}) }), fundsBumpOp(K.conn(e.connectionId)), basisBumpOp(K.run(e.tenantId, e.runId)),
      ...(day ? [{ op: 'update', table: 'work', pk: day.pk, sk: 'DAY', add: { sumMinor: -e.maxDebit.minor, version: 1 }, cond: { eq: { version: day.version } } } as Op] : []),
      ...(obl?.payment?.effectKey === e.effectKey ? [{ op: 'update', table: 'core', pk: obl.pk, sk: obl.sk, set: { payment: null, version: obl.version + 1 }, cond: { eq: { version: obl.version } } } as Op] : []),
      ...(a && canTransition('Action', a.state, 'FAILED') ? [actOp(a, 'FAILED', { heldReasons: [text] })] : []),
      effAudit(d, e, 'PayoutNotPaid', text, allowedText(e)),
    ],
    finish: { kind: 'done' }, event: text, ref: itemId,
  });
}

/** PAYOUT_WATCH (R6): daily item GET for 30 days after PAID; a refund is a separate credit, the debit is never altered. */
export async function runPayoutWatch(d: Deps, l: Lease): Promise<void> {
  const e = await loadEff(d, l.job.ref);
  if (!e || e.state !== 'PAID' || !e.itemId) return d.store.transact([finishOp(l, { kind: 'done' })]);
  const now = d.now();
  const end = addMs(e.timeProcessed ?? e.updatedAt, WATCH_DAYS * DAY);
  const g = await call(() => d.reader.getPayoutItem(e.itemId!));
  if (g?.status === 200) {
    const v = classifyItem(g.body, { senderBatchId: e.senderBatchId, amountMinor: e.amount.minor, receiverSha256: e.payee.receiverSha256 }, true);
    if (v.kind === 'RETURNED') {
      await retainGet(d.store, K.conn(e.connectionId), 'payout item after paid', g, now).catch(() => undefined);
      const obl = await loadObl(d, e);
      return step(d, l, e, 'REFUNDED', {
        set: { itemStatus: v.status },
        ops: [
          { op: 'put', table: 'provider', item: { pk: K.conn(e.connectionId), sk: `PAYRET#${e.itemId}#${v.status}`, itemId: e.itemId, status: v.status, effectKey: e.effectKey, tenantId: e.tenantId, runId: e.runId, observedAt: now, amountMinor: null }, cond: { notExists: true } },
          ...(obl && obl.state === 'PAID' ? [{ op: 'update', table: 'core', pk: obl.pk, sk: obl.sk, set: { state: 'REOPENED', payment: null, reopenedFrom: e.effectKey, version: obl.version + 1 }, cond: { eq: { version: obl.version, state: 'PAID' } } } as Op] : []),
          fundsBumpOp(K.conn(e.connectionId)), basisBumpOp(K.run(e.tenantId, e.runId)),
          effAudit(d, e, 'PayoutRefunded', `PayPal shows the paid item ${e.itemId} ${v.status.toLowerCase()}: a separate credit (counted only once PayPal's report shows it); the original payment stays recorded; the bill is open again and a new payment needs your approval`),
        ],
        finish: { kind: 'done' }, event: `Item ${v.status} after it was paid · bill reopened`, ref: e.itemId,
      });
    }
  }
  if (now >= end) return d.store.transact([finishOp(l, { kind: 'done' })]);
  return d.store.transact([finishOp(l, { kind: 'requeue', at: addMs(now, DAY), resetAttempts: true, error: null })]).then(() => undefined);
}

// ---------- releases: resume / confirm re-run held payouts ----------
/** Actions held for `codes` get their PAY job pulled; a HELD_READY effect goes back to READY and its claim re-checks everything (R7). */
export async function releasePayoutHolds(rc: ReadCtx, now: string, codes: HoldCode[]): Promise<{ ops: Op[]; afterCommit: () => Promise<void> }> {
  const s = await loadPlanState(rc);
  const ops: Op[] = [];
  const jobs: string[] = [];
  for (const a of s.actions.filter((x) => x.kind === 'PAYOUT' && x.state === 'HELD' && x.holdCode && codes.includes(x.holdCode))) {
    const obl = s.f.r.stored.get(a.subject.occurrenceKey!) as Obl | undefined;
    const e = obl?.payment ? await loadEff(rc, obl.payment.effectKey) : undefined;
    // The API never writes a payout effect (S6-D17): it only pulls the job; the worker resumes HELD_READY itself.
    jobs.push(e?.state === 'HELD_READY' && e.actionId === a.actionId ? `exec#${e.effectKey}` : `due#${a.actionId}#${a.intentVersion}#PAY#0`);
  }
  const { pull } = await import('../comms/commands.ts');
  return { ops, afterCommit: async () => { for (const j of jobs) await pull(rc.store, j, now); } };
}

/** UNKNOWN resolution after the sweep finds an expired DISPATCHED lease (beside `upd:`): same id, never a new one. */
export const unknownFromSweepOps = (eff: Item, now: string): Op[] => [
  { op: 'update', table: 'work', pk: eff.pk, sk: 'EFFECT', set: { state: 'UNKNOWN', unknownSince: now, updatedAt: now }, add: { version: 1 }, cond: { eq: { state: 'DISPATCHED' } } },
  auditOp({ tenantId: eff.tenantId, runId: eff.runId, type: 'PayoutUnknown', by: 'HEADROOM', result: `Worker stopped after sending; checking with PayPal using the same payment id ${eff.senderBatchId}, never a new one`, refs: { effectKey: eff.effectKey }, correlationId: eff.effectKey, now }),
];

/** Operator (R5): attach a batch found in PayPal to an UNKNOWN_UNRESOLVED payout, only if its sender_batch_id is ours. */
export async function attachPayoutBatch(d: Deps, effectKey: string, payoutBatchId: string): Promise<{ ok: boolean; reason: string }> {
  const e = await loadEff(d, effectKey);
  if (!e || (e.state !== 'UNKNOWN_UNRESOLVED' && e.state !== 'UNKNOWN')) return { ok: false, reason: 'Not an unresolved payout' };
  const b = await call(() => d.reader.getPayoutBatch(payoutBatchId));
  if (b?.status !== 200 || b.body?.batch_header?.sender_batch_header?.sender_batch_id !== e.senderBatchId) return { ok: false, reason: "That batch's payment id isn't this payout's; nothing attached" };
  assertTransition('PayoutEffect', e.state, 'SUBMITTED');
  await d.store.transact([
    { op: 'update', table: 'work', pk: e.pk, sk: 'EFFECT', set: { state: 'SUBMITTED', batchId: payoutBatchId, updatedAt: d.now(), timeline: [...e.timeline, { at: d.now(), event: `Batch ${payoutBatchId} attached by the operator`, ref: payoutBatchId }] }, add: { version: 1 }, cond: { eq: { version: e.version } } },
    putJobOp(newJob(`attach#${e.effectKey}#${payoutBatchId}`, 'RECONCILE_EFFECT', e.effectKey, d.now(), e.tenantId, e.runId)),
    effAudit(d, e, 'PayoutBatchAttached', `Operator attached PayPal batch ${payoutBatchId} (its payment id matches ${e.senderBatchId}); checking its item`),
  ]);
  return { ok: true, reason: 'Attached' };
}
