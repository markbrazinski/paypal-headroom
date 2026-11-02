// The Mercer check (T5, C-SKIP-1): CHECKRUN# lease → gates → evidence refresh (S5-D8) → fenced snapshot (S5-D22) → evaluate
// (skip.ts) → ONE decide TX conditioned on the lease generation, the three funds stamps, the update lock, policy, thread and action.
// Run 1 takes the lease and refreshes PayPal inline; it asks for a bank sync and comes back. Run 2 needs a bank read completed after
// the lock, then decides. A stamp that moves between snapshot and commit fails the TX and the check re-runs on the new inputs (AT-F06).
import type { SkipCheck } from '@headroom/contracts';
import { K } from '../../adapters/store/keys.ts';
import { TxCancelled, type Item, type Op } from '../../adapters/store/port.ts';
import type { Deps } from '../../deps.ts';
import { finishOp, newJob, requestRun, type Lease } from '../../jobs/lease.ts';
import { auditOp } from '../audit/audit.ts';
import { syncJobId, bindingOf } from '../bank-mirror/connect.ts';
import { observeBalance } from '../paypal-mirror/observe-balance.ts';
import { reconcileInvoice, refreshCapture, type CaptureMarker } from '../paypal-mirror/reconcile-invoice.ts';
import { fundsInputs } from '../../read/models.ts';
import { addMs, MIN } from '../time.ts';
import { authorityFor, planCtxFor } from './authority.ts';
import { actTo, actUpdate, queueUpdate } from './due.ts';
import { decideByOf } from './dates.ts';
import { evaluateSkip, type SkipBlocker } from './skip.ts';
import { loadPlanState, type ActItem, type PlanState } from './state.ts';
import { lockFreeCheck, readLock } from '../executor/invoice-update.ts';

export const CHECK_LEASE_MS = 60_000;
export const RECHECK_FIRST_MS = 2 * MIN;
export const RECHECK_EVERY_MS = 15 * MIN;
const EVIDENCE_WAIT_MS = 15_000;
/** ponytail: refresh-set ceiling (S5-D8); above it the check holds rather than skip on unread captures. Upgrade: paged refresh. */
export const MAX_CAPTURE_READS = 200;
const REFUND_WINDOW_MS = 180 * 24 * 3_600_000;
const UNDECIDED_BILL = ['RECEIVED', 'PROPOSED', 'VERIFIED'];

type CheckRunItem = Item & { generation: number; holder: string | null; leaseUntil: string | null; phase: 'EVIDENCE' | 'EVALUATE' | 'DONE'; lockedAt?: string; refreshes?: SkipCheck['refreshes'] };
const crSk = (actionId: string) => `CHECKRUN#${actionId}`;

/** Funds stamps: run PLAN.basisStamp, PayPal connection FUNDS, bank item FUNDS (S5-D22). A missing item reads 0 and is fenced as missing. */
async function stamps(d: Deps, s: PlanState, itemId: string | null) {
  const [plan, pp, bk] = await Promise.all([
    d.store.get('core', s.pk, 'PLAN'),
    s.ctx.connectionId ? d.store.get('provider', K.conn(s.ctx.connectionId), 'FUNDS') : undefined,
    itemId ? d.store.get('provider', K.plaid(itemId), 'FUNDS') : undefined,
  ]);
  const v = { plan: plan?.basisStamp ?? 0, paypal: pp?.stamp ?? 0, bank: bk?.stamp ?? 0 };
  const fence = (pk: string, it: Item | undefined): Op => (it ? { op: 'check', table: 'provider', pk, sk: 'FUNDS', cond: { eq: { stamp: it.stamp } } } : { op: 'check', table: 'provider', pk, sk: 'FUNDS', cond: { notExists: true } });
  const ops: Op[] = [{ op: 'check', table: 'core', pk: s.pk, sk: 'PLAN', cond: { eq: { basisStamp: v.plan } } }];
  if (s.ctx.connectionId) ops.push(fence(K.conn(s.ctx.connectionId), pp));
  if (itemId) ops.push(fence(K.plaid(itemId), bk));
  return { v, ops };
}

export async function runSkipCheck(d: Deps, l: Lease, s: PlanState, a: ActItem, _budget: { deadline: number; elapsed: () => number }): Promise<void> {
  const [tenantId, runId] = [s.ctx.tenantId, s.ctx.run.runId];
  const now = d.now();
  const holder = l.jobId;
  const cr = (await d.store.get('core', s.pk, crSk(a.actionId))) as CheckRunItem | undefined;
  const audit = (type: Parameters<typeof auditOp>[0]['type'], result: string, allowedBy: string | null = null) => auditOp({ tenantId, runId, type, by: 'HEADROOM', allowedBy, result, refs: { actionId: a.actionId }, correlationId: `check:${a.actionId}:${now}`, now });
  const requeue = (at: string, error: string | null = null) => d.store.transact([finishOp(l, { kind: 'requeue', at, error, resetAttempts: true })]).then(() => undefined);

  // 1. Lock: free, done, ours, or a dead holder's (lease expired → take over at g+1).
  const mine = cr && cr.holder === holder && cr.phase !== 'DONE';
  if (cr && !mine && cr.phase !== 'DONE' && cr.leaseUntil && cr.leaseUntil >= now) return requeue(addMs(now, 30_000), 'Another check of this offer is running');
  let run: CheckRunItem;
  if (!mine) {
    const g = (cr?.generation ?? 0) + 1;
    run = { pk: s.pk, sk: crSk(a.actionId), actionId: a.actionId, generation: g, holder, leaseUntil: addMs(now, CHECK_LEASE_MS), phase: 'EVIDENCE', lockedAt: now, refreshes: [] };
    const ops: Op[] = [
      cr ? { op: 'put', table: 'core', item: run, cond: { eq: { generation: cr.generation, holder: cr.holder } } } : { op: 'put', table: 'core', item: run, cond: { notExists: true } },
      { op: 'check', table: 'core', pk: a.pk, sk: a.sk, cond: { eq: { version: a.version, intentVersion: a.intentVersion, state: a.state } } },
      ...(cr && cr.phase !== 'DONE' ? [audit('CheckLeaseTakenOver', `An earlier check (generation ${cr.generation}) stopped; this check takes over as generation ${g}`)] : []),
    ];
    try { await d.store.transact(ops); } catch (e) { if (e instanceof TxCancelled) return requeue(addMs(now, 10_000), 'Check lock refused; retrying'); throw e; }
  } else run = cr!;

  // 2. Gates at the skip stage: a pause, takeover or lost authority holds — never a skip.
  const gate = await authorityFor(s, a, 'SKIP', 'EFFECT');
  if (!gate.res.ok) return decide(d, l, s, a, run, { decision: 'HELD', code: gate.res.code, reason: gate.res.text, conds: gate.conds, blockers: [], evaluated: null, stampOps: [], stampV: null });

  // 3. Evidence (run 1): PayPal reads inline, after the lock; ask for a bank read and come back.
  const binding = await bindingOf(d.store, tenantId, runId);
  const itemId = binding?.itemId ?? null;
  if (run.phase === 'EVIDENCE') {
    const refreshes: SkipCheck['refreshes'] = [];
    const ref = `${a.actionId}#${run.generation}`;
    const r1 = await observeBalance(d);
    refreshes.push({ resource: 'paypal:balance', requestRef: ref, completedAt: r1.ok ? d.now() : null, ok: r1.ok });
    for (const inv of s.invoices.filter((i) => i.state === 'ISSUED' || i.state === 'PARTIALLY_PAID')) {
      const ok = await reconcileInvoice(d, { tenantId, runId, invoiceId: inv.invoiceId }, 'REFRESH').then(() => true, () => false);
      refreshes.push({ resource: `paypal:invoice:${inv.invoiceId}`, requestRef: ref, completedAt: ok ? d.now() : null, ok });
    }
    const markers = s.ctx.connectionId ? ((await d.store.query('provider', K.conn(s.ctx.connectionId), { skPrefix: 'CAPTURE#' })) as unknown as CaptureMarker[]).filter((m) => m.tenantId === tenantId && Date.parse(now) - Date.parse(m.capturedAt) < REFUND_WINDOW_MS) : [];
    if (markers.length > MAX_CAPTURE_READS) refreshes.push({ resource: 'paypal:captures', requestRef: ref, completedAt: null, ok: false });
    else for (const m of markers) { const ok = await refreshCapture(d, m, `check:${ref}`); refreshes.push({ resource: `paypal:capture:${m.captureId}`, requestRef: ref, completedAt: ok ? d.now() : null, ok }); }
    if (itemId) await requestRun(d.store, newJob(syncJobId(itemId), 'PLAID_SYNC', itemId, now, null, null), now);
    await d.store.transact([{ op: 'update', table: 'core', pk: s.pk, sk: run.sk, set: { phase: 'EVALUATE', refreshes, leaseUntil: addMs(d.now(), CHECK_LEASE_MS + EVIDENCE_WAIT_MS) }, cond: { eq: { generation: run.generation, holder } } }, finishOp(l, { kind: 'requeue', at: addMs(d.now(), EVIDENCE_WAIT_MS), resetAttempts: true })]);
    if (itemId) await d.queue.send(syncJobId(itemId)).catch(() => {});
    return;
  }

  // 4. Snapshot: stamps → inputs → stamps again (≤ 3 tries).
  const fresh = await loadPlanState((await planCtxFor(d, tenantId, runId))!);
  const lock = a.subject.invoiceId ? await readLock(d, a.subject.invoiceId) : undefined;
  for (let i = 0; i < 3; i++) {
    const st = await stamps(d, fresh, itemId);
    const x = await fundsInputs(fresh.ctx);
    const blockers: SkipBlocker[] = [...x.blockers];
    for (const r of run.refreshes ?? []) if (!r.ok) blockers.push({ code: 'REFRESH_INCOMPLETE', text: `Couldn't re-read ${r.resource.replace(/^paypal:/, 'PayPal ')}`, ref: r.resource });
    if (itemId && (!x.bank.retrievedAt || x.bank.retrievedAt < run.lockedAt!)) blockers.push({ code: 'REFRESH_INCOMPLETE', text: 'Bank balance not re-read since the check started', ref: 'bank' });
    if (lock?.holder) blockers.push({ code: 'UPDATE_IN_FLIGHT', text: 'An update to this invoice is in flight', ref: lock.holder });
    for (const b of x.f.r.bills.filter((b) => UNDECIDED_BILL.includes(b.state))) blockers.push({ code: 'BILL_UNDECIDED', text: `Bill ${b.billNumber ?? b.fileName} not decided yet`, ref: b.billId });
    for (const inv of fresh.invoices.filter((v) => (v as { conservation?: string }).conservation === 'HOLD')) blockers.push({ code: 'RECONCILIATION_HOLD', text: `PayPal and Headroom disagree on what ${inv.invoiceNumber} has due`, ref: inv.invoiceId });
    const { blockers: mailBlockers } = await import('../comms/inbound.ts').then((m) => m.skipBlockers(d, fresh.pk));
    blockers.push(...mailBlockers);
    const ev = evaluateSkip({ now: d.now(), today: x.f.today, reserveMinor: x.f.reserveMinor, bank: x.bank, paypal: x.paypal, items: (x.f.days ?? []).flatMap((dd) => dd.items), blockers });
    const again = await stamps(d, fresh, itemId);
    if (JSON.stringify(again.v) !== JSON.stringify(st.v)) continue;
    const { res, conds } = await authorityFor(fresh, a, 'SKIP', 'EFFECT');
    if (!res.ok) return decide(d, l, fresh, a, run, { decision: 'HELD', code: res.code, reason: res.text, conds, blockers: [], evaluated: null, stampOps: st.ops, stampV: st.v });
    return decide(d, l, fresh, a, run, {
      decision: ev.decision, code: null, reason: ev.reason, conds: [...conds, ...(a.subject.invoiceId ? [lockFreeCheck(lock, a.subject.invoiceId)] : [])], blockers: ev.blockers,
      evaluated: { ev, x }, stampOps: st.ops, stampV: st.v,
    });
  }
  return decide(d, l, fresh, a, run, { decision: 'HELD_EVIDENCE', code: null, reason: 'Inputs kept changing while checking', conds: [], blockers: [{ code: 'INPUTS_MOVING', text: 'Inputs kept changing while checking', ref: null }], evaluated: null, stampOps: [], stampV: null });
}

interface Outcome {
  decision: 'SKIP' | 'HELD_EVIDENCE' | 'NEEDED' | 'HELD';
  code: string | null; reason: string; conds: Op[]; blockers: SkipBlocker[];
  evaluated: { ev: ReturnType<typeof evaluateSkip>; x: Awaited<ReturnType<typeof fundsInputs>> } | null;
  stampOps: Op[]; stampV: { plan: number; paypal: number; bank: number } | null;
}

/** 5. One atomic decide: outcome + CHECK# + next job + CHECKRUN DONE, fenced on generation, stamps, lock, policy, thread, action. */
async function decide(d: Deps, l: Lease, s: PlanState, a: ActItem, run: CheckRunItem, o: Outcome) {
  const [tenantId, runId] = [s.ctx.tenantId, s.ctx.run.runId];
  const now = d.now();
  const tz = s.ctx.run.settings.timeZone;
  const early = (l.job as { early?: { by: string; scheduledAt: string } | null }).early ?? null;
  const checkId = `CHECK#${a.actionId}#${run.generation}`;
  const ev = o.evaluated?.ev;
  const x = o.evaluated?.x;
  const check: SkipCheck = {
    checkId, actionId: a.actionId, generation: run.generation, at: now, early,
    stamps: o.stampV ?? { plan: 0, paypal: 0, bank: 0 }, refreshes: run.refreshes ?? [],
    inputs: {
      bank: { amountMinor: x?.bank.availableMinor ?? null, retrievedAt: x?.bank.retrievedAt ?? null, accountIds: [] },
      paypal: { lowerMinor: x?.paypal.lowerMinor ?? null, upperMinor: x?.paypal.lowerMinor == null ? null : x.paypal.lowerMinor + x.paypal.capturedPendingMinor, asOf: x?.paypal.asOf ?? null, fetchedAt: x?.paypal.fetchedAt ?? null, reconciliation: x?.paypal.reconciliation ?? 'UNKNOWN', captureIds: x?.captureIds ?? [] },
      obligations: (x?.f.days ?? []).flatMap((dd) => dd.items.filter((i) => i.direction === 'OUT').map((i) => ({ key: i.key, on: i.on, amountMinor: i.amountMinor + i.feeMinor }))),
      reserveMinor: s.f.reserveMinor,
    },
    lowerSeries: ev?.lowerSeries ?? null, upperSeries: ev?.upperSeries ?? null, lowerMin: ev?.lowerMin ?? null, upperMin: ev?.upperMin ?? null,
    blockers: o.blockers, decision: o.decision,
  };
  const audit = (type: Parameters<typeof auditOp>[0]['type'], result: string, allowedBy: string | null = null) => auditOp({ tenantId, runId, type, by: 'HEADROOM', allowedBy, result, refs: { actionId: a.actionId, checkId }, correlationId: checkId, now });
  const ops: Op[] = [
    { op: 'update', table: 'core', pk: s.pk, sk: run.sk, set: { phase: 'DONE', holder: null, leaseUntil: null }, cond: { eq: { generation: run.generation, holder: run.holder } } },
    { op: 'put', table: 'core', item: { pk: s.pk, sk: checkId, ...check }, cond: { notExists: true } },
    ...o.stampOps, ...o.conds,
  ];
  const decideBy = a.decideBy ?? (a.condition?.checkAt ? decideByOf(a.condition.checkAt, tz) : null);
  const earlyText = early ? ' · run early by the operator' : '';
  let finish: Parameters<typeof finishOp>[1] = { kind: 'done' };
  if (o.decision === 'SKIP') {
    ops.push(actTo(a, 'SKIPPED_NOT_NEEDED', { heldReasons: [o.reason], lastCheckId: checkId, holdCode: null }), audit('FallbackSkipped', `${a.counterparty.name} offer not needed: ${o.reason}. Nothing sent: no PayPal update and no message; the $${((a.terms.discountAmount?.minor ?? 0) / 100).toFixed(2)} discount was never offered${earlyText}`));
  } else if (o.decision === 'HELD_EVIDENCE') {
    ops.push(a.state === 'HELD_EVIDENCE' ? actUpdate(a, { heldReasons: [o.reason], lastCheckId: checkId, decideBy }) : actTo(a, 'HELD_EVIDENCE', { heldReasons: [o.reason], lastCheckId: checkId, decideBy, holdCode: null }),
      audit('FallbackHeldEvidence', `Waiting for balance evidence: ${o.reason}${earlyText}`));
    finish = { kind: 'requeue', at: addMs(now, a.state === 'HELD_EVIDENCE' ? RECHECK_EVERY_MS : RECHECK_FIRST_MS), resetAttempts: true, error: null };
  } else if (o.decision === 'HELD') {
    ops.push(actTo(a, 'HELD', { holdCode: o.code, heldReasons: [o.reason], lastCheckId: checkId }), audit('ActionHeld', `Mercer offer held: ${o.reason}; not skipped and not sent${earlyText}`));
  } else {
    // NEEDED: the decision and the queueing are one TX (queueUpdate adds its own policy/thread checks, so ours are left out).
    const decideOps = ops.filter((op) => !o.conds.includes(op) || (op.op === 'check' && op.table === 'work'));
    decideOps.push(audit('FallbackChecked', `Verified funds fall short: ${o.reason}. Applying the offer${earlyText}`));
    await d.hooks?.beforeSkipDecide?.(a.actionId);
    return queueUpdate(d, l, s, a, 'APPLY_DISCOUNT', decideOps, undefined, { lastCheckId: checkId });
  }
  await d.hooks?.beforeSkipDecide?.(a.actionId);
  try {
    await d.store.transact([...ops, finishOp(l, finish)]);
  } catch (e) {
    if (!(e instanceof TxCancelled)) throw e;
    // A stamp, the lock, policy, thread or the action moved: re-run now on the new inputs, never decide on the old ones (AT-F06).
    await d.store.transact([finishOp(l, { kind: 'requeue', at: now, error: 'Inputs changed while deciding; re-checking' })]).catch(() => {});
    await d.store.transact([{ op: 'update', table: 'core', pk: s.pk, sk: run.sk, set: { phase: 'EVIDENCE' }, cond: { eq: { generation: run.generation, holder: run.holder } } }]).catch(() => {});
  }
}
