// Reset machine (S07 §6.18 R1; owner decision O13: every reset looks like a fresh instance). A Start takes the merchant lease and
// writes one durable `RESET#` record; RESET_STEP jobs then move it, each step in one conditional TX:
//   WAIT_SETTLED  the previous holder's run has no PayPal work in flight (lease.ts unresolvedOf)
//   WAIT_REPORT   PayPal's report covers every earlier movement: the merchant-wide C-BAL-1 bounds collapse to one figure A
//                 (reconciled, no holds). PayPal's report runs ~3–5 h behind; deadline 8 h → BLOCKED RAIL_REPORT_LATE
//   RETURNING(n)  A above the $1,800.00 opening: one HOUSEKEEPING payout of floor((A − 1,800)/1.02) to the registered sandbox receiver,
//                 immutable sender_batch_id per (reset, n); paid only at item SUCCESS; the item's own fee gives the exact landing,
//                 so no further report wait. ≤ 3 payouts. Timeout → replay the same id (S6 R5)
//   SEEDING       the existing hero reset for the holder's tenant (fresh invoices, bank, policy, mail cursor), bound to the lease in its TX
//   DONE / BLOCKED with the reason and the landing shown
// Not built in this pass (recorded): TOPPING_UP when A is below the opening (BLOCKED RAIL_BELOW_OPENING with the shortfall).
// Funds gates unchanged: the payout's funding is C-PAYOUT-1's rail test on the lower bound; housekeeping belongs to no company.
import { createHash, randomBytes } from 'node:crypto';
import type { HttpResult } from '../../adapters/paypal/types.ts';
import { K } from '../../adapters/store/keys.ts';
import { TxCancelled, type Item, type Op } from '../../adapters/store/port.ts';
import type { Deps } from '../../deps.ts';
import { finishOp, newJob, putJobOp, type Lease as JobLease } from '../../jobs/lease.ts';
import { grantStopped } from '../../adapters/grant.ts';
import { merchantEstimate } from '../../read/models.ts';
import { observeBalance } from '../paypal-mirror/observe-balance.ts';
import { classifyItem, feeCeilingMinor, payoutBody, receiverSha256 } from '../payables/payout-core.ts';
import { addMs, MIN } from '../time.ts';
import { auditOp } from '../audit/audit.ts';
import { canAcquire, leaseOf, unresolvedOf, type AcquireCheck } from './lease.ts';

export const OPENING_MINOR = 180_000;
export const LANDING_TOLERANCE_MINOR = 100;
export const MAX_HOUSEKEEPING = 3;
export const REPORT_POLL_MS = 10 * MIN;
export const REPORT_DEADLINE_MS = 8 * 60 * MIN; // R1 said 4 h; measured 3 Nov 2026: the report ran ~5 h behind (as-of 09:59:59Z at 14:57Z)
export const RETURNING_DEADLINE_MS = 60 * MIN;
const dollars = (m: number) => `$${(m / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const sha = (x: string) => createHash('sha256').update(x).digest('hex');

export type ResetState = 'WAIT_SETTLED' | 'WAIT_REPORT' | 'RETURNING' | 'SEEDING' | 'DONE' | 'BLOCKED';
export interface Housekeeping { n: number; senderBatchId: string; amountMinor: number; state: 'POSTING' | 'SUBMITTED' | 'PAID' | 'UNKNOWN' | 'FAILED'; batchId: string | null; itemId: string | null; feeMinor: number | null; transactionId: string | null; fromMinor: number }
export interface ResetRecord {
  pk: string; sk: string; resetKey: string; tenantId: string; holderSub: string; reason: string; dispute: 'SEEDED' | 'EMAIL';
  prev: { tenantId: string; runId: string } | null; state: ResetState; version: number;
  reportSince: string | null; returningSince?: string | null; railMinor: number | null; landingMinor: number | null; hk: Housekeeping[];
  runId: string | null; blocker: { code: string; text: string } | null; waiting: string | null;
  timeline: { at: string; text: string }[]; createdAt: string; updatedAt: string;
}
export const resetJobId = (resetKey: string) => `reset#${resetKey}`;
export const RESET_STATES_DONE: ResetState[] = ['DONE', 'BLOCKED'];

/**
 * Start (judge "Start a new run", operator reset on review): take the lease for `tenantId` and open the reset. Refused with a reason
 * when another holder's lease is live, the previous run has PayPal work in flight, or a reset is already running.
 */
export async function requestStart(d: Deps, a: { tenantId: string; holderSub: string; reason: string; dispute?: 'SEEDED' | 'EMAIL' }): Promise<{ ok: true; resetKey: string } | Extract<AcquireCheck, { ok: false }>> {
  const conn = d.config.connectionId;
  for (let attempt = 0; attempt < 3; attempt++) {
    const now = d.now();
    const l = await leaseOf(d.store, conn);
    const prev = l?.tenantId && l.runId ? { tenantId: l.tenantId, runId: l.runId } : l?.tenantId ? await (async () => { const f = await d.store.get('core', K.tenant(l.tenantId!), 'RUN_FENCE'); return f ? { tenantId: l.tenantId!, runId: f.runId as string } : null; })() : null;
    const cur = l?.resetSk ? ((await d.store.get('provider', K.conn(conn), l.resetSk)) as ResetRecord | undefined) : undefined;
    const check = canAcquire(l, { tenantId: a.tenantId, holderSub: a.holderSub, now, unresolved: prev ? await unresolvedOf(d.store, prev.tenantId, prev.runId) : [], resetBusy: !!cur && !RESET_STATES_DONE.includes(cur.state) });
    if (!check.ok) return check;
    // P2-2: housekeeping money still unaccounted for by the last reset holds the merchant (an operator checks PayPal).
    const hkOpen = cur?.hk.filter((h) => h.state !== 'PAID' && h.state !== 'FAILED') ?? [];
    if (hkOpen.length) return { ok: false, code: 'PREVIOUS_RUN_UNRESOLVED', text: `Housekeeping payout ${hkOpen.map((h) => `${h.n} (${h.senderBatchId})`).join(', ')} isn't settled at PayPal; check PayPal first` };
    const fence = await d.store.get('core', K.tenant(a.tenantId), 'RUN_FENCE');
    const resetKey = `${now.replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomBytes(3).toString('hex')}`;
    const rec: ResetRecord = {
      pk: K.conn(conn), sk: `RESET#${resetKey}`, resetKey, tenantId: a.tenantId, holderSub: a.holderSub, reason: a.reason, dispute: a.dispute ?? 'SEEDED',
      prev, state: 'WAIT_SETTLED', version: 1, reportSince: null, railMinor: null, landingMinor: null, hk: [], runId: null, blocker: null, waiting: null,
      timeline: [{ at: now, text: 'Start requested; the merchant is yours until this run ends' }], createdAt: now, updatedAt: now,
    };
    const leaseCond = l?.version === undefined ? { missing: ['version'] as string[] } : { eq: { version: l.version, claims: l.claims ?? 0 } };
    const ops: Op[] = [
      { op: 'put', table: 'provider', item: rec as unknown as Item, cond: { notExists: true } },
      l ? { op: 'update', table: 'provider', pk: K.conn(conn), sk: 'TENANT', set: { leased: true, tenantId: a.tenantId, runId: null, holderSub: a.holderSub, leasedAt: now, lastActiveAt: now, resetSk: rec.sk, version: (l.version ?? 0) + 1, claims: l.claims ?? 0 }, cond: leaseCond }
        : { op: 'put', table: 'provider', item: { pk: K.conn(conn), sk: 'TENANT', leased: true, tenantId: a.tenantId, runId: null, holderSub: a.holderSub, leasedAt: now, lastActiveAt: now, resetSk: rec.sk, version: 1, claims: 0 }, cond: { notExists: true } },
      // Only the holder's tenant may cause PayPal calls (S1-IR-01): the binding moves with the lease.
      { op: 'put', table: 'core', item: { pk: K.tenant(a.tenantId), sk: 'CONN#paypal', connectionId: conn } },
      ...(l?.tenantId && l.tenantId !== a.tenantId ? [{ op: 'put', table: 'core', item: { pk: K.tenant(l.tenantId), sk: 'CONN#paypal', connectionId: null, leaseMovedAt: now } } as Op] : []),
      putJobOp(newJob(resetJobId(resetKey), 'RESET_STEP', rec.sk, now, a.tenantId, null)),
      // R1 REQUESTED: the requester's current run is sealed now (epoch bump; commands, mail, payer and executors all fence on it).
      ...(fence ? [{ op: 'update', table: 'core', pk: K.tenant(a.tenantId), sk: 'RUN_FENCE', set: { epoch: fence.epoch + 1, sealedBy: resetKey }, cond: { eq: { epoch: fence.epoch, runId: fence.runId } } } as Op] : []),
    ];
    try { await d.store.transact(ops); }
    catch (e) { if (e instanceof TxCancelled) continue; throw e; } // a claim or another Start moved the lease: read again
    await d.queue.send(resetJobId(resetKey)).catch(() => {});
    return { ok: true, resetKey };
  }
  return { ok: false, code: 'MERCHANT_LEASED', text: 'The merchant kept changing; try again' };
}

/**
 * Operator: stop a reset that can't finish (e.g. PayPal keeps a row pending for weeks). Refused while a housekeeping payout isn't settled
 * (that money must be accounted for first). The lease stays with the tenant, so a CLI reset re-binds it (S7b review P2-2/P2-3).
 */
export async function abandonReset(d: Deps, reason: string): Promise<{ ok: boolean; text: string }> {
  const l = await leaseOf(d.store, d.config.connectionId);
  const r = l?.resetSk ? ((await d.store.get('provider', K.conn(d.config.connectionId), l.resetSk)) as ResetRecord | undefined) : undefined;
  if (!r || RESET_STATES_DONE.includes(r.state)) return { ok: false, text: 'No reset in progress' };
  if (r.hk.some((h) => h.state !== 'PAID' && h.state !== 'FAILED')) return { ok: false, text: 'A housekeeping payout is still in flight at PayPal; it has to settle first' };
  const now = d.now();
  await d.store.transact([{ op: 'update', table: 'provider', pk: r.pk, sk: r.sk, set: { state: 'BLOCKED', blocker: { code: 'ABANDONED', text: `Stopped by the operator: ${reason}` }, waiting: null, timeline: [...r.timeline, { at: now, text: `Stopped by the operator: ${reason}` }], updatedAt: now, version: r.version + 1 }, cond: { eq: { version: r.version } } }]);
  return { ok: true, text: `Reset ${r.resetKey} stopped (${r.state.toLowerCase()})` };
}

async function call(fn: () => Promise<HttpResult>): Promise<HttpResult | undefined> { try { return await fn(); } catch { return undefined; } }
const isDuplicate = (r: HttpResult) => r.status === 400 && (r.body?.details ?? []).some((x: any) => /already exists/i.test(x.issue ?? ''));
const linkBatchId = (r: HttpResult) => {
  const href: string | undefined = r.body?.details?.flatMap((x: any) => (Array.isArray(x.link) ? x.link : x.link ? [x.link] : [])).find((k: any) => /\/v1\/payments\/payouts\//.test(k?.href ?? ''))?.href;
  return href ? decodeURIComponent(href.split('/').pop()!) : null;
};

/** RESET_STEP job. */
export async function runResetStep(d: Deps, l: JobLease): Promise<void> {
  const pk = K.conn(d.config.connectionId);
  const found = (await d.store.get('provider', pk, l.job.ref)) as ResetRecord | undefined;
  if (!found || RESET_STATES_DONE.includes(found.state)) return void (await d.store.transact([finishOp(l, { kind: 'done' })]).catch(() => {}));
  const r: ResetRecord = found;
  const now = d.now();
  const save = async (set: Partial<ResetRecord>, f: Parameters<typeof finishOp>[1], text: string | null = null, extra: Op[] = []) => {
    const timeline = text ? [...r.timeline, { at: now, text }] : r.timeline;
    try {
      await d.store.transact([{ op: 'update', table: 'provider', pk, sk: r.sk, set: { ...set, timeline, updatedAt: now, version: r.version + 1 }, cond: { eq: { version: r.version } } }, ...extra, finishOp(l, f)]);
    } catch (e) { if (!(e instanceof TxCancelled)) throw e; await d.store.transact([finishOp(l, { kind: 'requeue', at: now })]).catch(() => {}); }
  };
  const block = (code: string, text: string) => save({ state: 'BLOCKED', blocker: { code, text }, waiting: null }, { kind: 'done' }, `Blocked: ${text}`);

  if (r.state === 'WAIT_SETTLED') {
    const open = r.prev ? await unresolvedOf(d.store, r.prev.tenantId, r.prev.runId) : [];
    if (open.length) return save({ waiting: `Waiting for the previous run's PayPal work: ${open.join('; ')}` }, { kind: 'requeue', at: addMs(now, MIN), resetAttempts: true });
    return save({ state: 'WAIT_REPORT', reportSince: now, waiting: null }, { kind: 'requeue', at: now }, 'Previous run settled with PayPal');
  }

  if (r.state === 'WAIT_REPORT') {
    await observeBalance(d).catch(() => undefined);
    const { estimate: e, snapshot } = await merchantEstimate(d);
    // Only released money can be returned by housekeeping (live 3 Nov: confirmed-but-unreleased captures → INSUFFICIENT_FUNDS).
    const known = !!e && e.reconciliation === 'PASS' && !e.holds.length && e.spendableMinor === e.upperMinor;
    if (!known) {
      if (Date.parse(now) - Date.parse(r.reportSince ?? now) > REPORT_DEADLINE_MS) return block('RAIL_REPORT_LATE', `PayPal's report still doesn't cover the last run after 8 hours (as of ${snapshot?.reportedAsOf ?? 'unknown'})`);
      const why = !e ? 'No PayPal balance yet' : e.holds.length ? `PayPal shows ${e.holds[0]}` : e.reconciliation !== 'PASS' ? `PayPal's report isn't reconciled yet (${e.reconciliationReason})` : e.spendableMinor !== e.lowerMinor ? `Waiting for PayPal to release the last run's customer payments (${dollars(e.lowerMinor - e.spendableMinor)}; PayPal holds new payments for a few hours)` : `Waiting for PayPal's report to include the last run's money (it runs about 3–5 h behind; report as of ${snapshot?.reportedAsOf})`;
      return save({ waiting: why }, { kind: 'requeue', at: addMs(now, REPORT_POLL_MS), resetAttempts: true });
    }
    return decide(e!.spendableMinor, `PayPal balance known: ${dollars(e!.spendableMinor)}`);
  }

  if (r.state === 'RETURNING') return returning();
  if (r.state === 'SEEDING') return seeding();
  return save({}, { kind: 'done' });

  async function decide(railMinor: number, text: string) {
    if (Math.abs(railMinor - OPENING_MINOR) <= LANDING_TOLERANCE_MINOR) return save({ state: 'SEEDING', railMinor, landingMinor: railMinor, waiting: null }, { kind: 'requeue', at: now }, `${text} · already the ${dollars(OPENING_MINOR)} opening`);
    if (railMinor < OPENING_MINOR) return save({ state: 'BLOCKED', railMinor, landingMinor: railMinor, blocker: { code: 'RAIL_BELOW_OPENING', text: `PayPal holds ${dollars(railMinor)}, ${dollars(OPENING_MINOR - railMinor)} below the ${dollars(OPENING_MINOR)} opening; a top-up is needed (not automated in this build)` }, waiting: null }, { kind: 'done' }, text);
    return save({ state: 'RETURNING', railMinor, returningSince: now, waiting: null }, { kind: 'requeue', at: now }, `${text} · returning ${dollars(railMinor - OPENING_MINOR)} above the opening`);
  }

  async function returning() {
    const receiver = d.config.payoutReceiver;
    if (!receiver || !d.writer) return block('HOUSEKEEPING_UNAVAILABLE', 'No registered sandbox receiver or PayPal writer here');
    const stopped = await grantStopped(d.store, d.config.grant, 'paypal', 'payouts', now);
    if (stopped) return save({ waiting: `Housekeeping waits: ${stopped}` }, { kind: 'requeue', at: addMs(now, REPORT_POLL_MS), resetAttempts: true });
    const last = r.hk.at(-1);
    // P2-2: never loop forever on an item PayPal leaves pending; BLOCKED keeps an unsettled item holding the merchant (requestStart).
    if (last && last.state !== 'PAID' && Date.parse(now) - Date.parse(r.returningSince ?? r.updatedAt) > RETURNING_DEADLINE_MS) return block('HOUSEKEEPING_STUCK', `Housekeeping payout ${last.n} (${last.senderBatchId}) still not settled at PayPal after an hour; check PayPal`);
    const from = last?.state === 'PAID' ? r.landingMinor! : last ? last.fromMinor : r.railMinor!;
    if (!last || last.state === 'PAID') {
      if (r.hk.length >= MAX_HOUSEKEEPING) return block('HOUSEKEEPING_LIMIT', `Still ${dollars(from)} after ${MAX_HOUSEKEEPING} housekeeping payouts`);
      // Fee ≤ 2% (C-PAYOUT-1 ceiling): the merchant never lands below the opening; funded on the lower bound (lower = A here).
      const amount = Math.floor(((from - OPENING_MINOR) * 100) / 102);
      if (amount + feeCeilingMinor(amount) > from) return block('HOUSEKEEPING_UNFUNDED', `${dollars(from)} can't fund ${dollars(amount)} plus fees`);
      const n = r.hk.length + 1;
      const senderBatchId = `HK${sha(r.resetKey).slice(0, 16)}n${n}`;
      const hk: Housekeeping = { n, senderBatchId, amountMinor: amount, state: 'POSTING', batchId: null, itemId: null, feeMinor: null, transactionId: null, fromMinor: from };
      // Persisted before the POST: from here on only this id is ever sent (replayed on timeout, never a new one).
      await save({ hk: [...r.hk, hk] }, { kind: 'requeue', at: now }, `Housekeeping payout ${n}: ${dollars(amount)} to the registered sandbox receiver (payment id ${senderBatchId})`);
      return;
    }
    const body = payoutBody({ senderBatchId: last.senderBatchId, receiver, amountMinor: last.amountMinor, business: 'Headroom sandbox housekeeping', billNo: null, senderItemId: `${last.senderBatchId}-1` });
    const setHk = (x: Partial<Housekeeping>) => r.hk.map((h) => (h.n === last.n ? { ...h, ...x } : h));
    if (last.state === 'POSTING' || last.state === 'UNKNOWN') {
      const res = await call(() => d.writer!.createPayout(body, last.senderBatchId));
      const batchId = res?.status === 201 ? res.body?.batch_header?.payout_batch_id ?? null : res && isDuplicate(res) ? linkBatchId(res) : null;
      if (batchId) return save({ hk: setHk({ state: 'SUBMITTED', batchId }) }, { kind: 'requeue', at: addMs(now, 5_000) }, `PayPal accepted housekeeping payout ${last.n} (batch ${batchId})`);
      // A definitive refusal sends nothing: the item is settled as FAILED so it doesn't hold the merchant.
      if (res && last.state === 'POSTING' && (res.status === 422 || (res.status === 400 && !isDuplicate(res)))) return save({ hk: setHk({ state: 'FAILED' }), state: 'BLOCKED', blocker: { code: 'HOUSEKEEPING_REFUSED', text: `PayPal refused housekeeping payout ${last.n}: ${res.body?.name ?? res.status}; nothing was sent` }, waiting: null }, { kind: 'done' }, `Blocked: PayPal refused housekeeping payout ${last.n}`);
      return save({ hk: setHk({ state: 'UNKNOWN' }), waiting: `Housekeeping payout ${last.n}: no clear answer from PayPal; checking with the same payment id` }, { kind: 'requeue', at: addMs(now, MIN), resetAttempts: true });
    }
    // SUBMITTED: only an item SUCCESS bound to our id, amount and receiver pays; its fee gives the exact landing.
    let itemId = last.itemId;
    if (!itemId) {
      const b = await call(() => d.reader.getPayoutBatch(last.batchId!));
      itemId = b?.status === 200 ? b.body?.items?.[0]?.payout_item_id ?? null : null;
      if (!itemId) return save({ waiting: 'Waiting for PayPal to list the housekeeping item' }, { kind: 'requeue', at: addMs(now, 10_000), resetAttempts: true });
    }
    const g = await call(() => d.reader.getPayoutItem(itemId!));
    if (g?.status !== 200) return save({ hk: setHk({ itemId }) }, { kind: 'requeue', at: addMs(now, 30_000), resetAttempts: true });
    const v = classifyItem(g.body, { senderBatchId: last.senderBatchId, amountMinor: last.amountMinor, receiverSha256: receiverSha256(receiver), batchId: last.batchId });
    if (v.kind === 'NOT_PAID') return save({ hk: setHk({ itemId }), waiting: `Housekeeping payout ${last.n}: ${v.status.toLowerCase()} at PayPal` }, { kind: 'requeue', at: addMs(now, 30_000), resetAttempts: true });
    // Final at PayPal without paying (failed, or returned to the merchant): settled, so it doesn't hold the merchant; the reset stops.
    if (v.kind === 'FINAL' || v.kind === 'RETURNED') return save({ hk: setHk({ itemId, state: 'FAILED' }), state: 'BLOCKED', blocker: { code: 'HOUSEKEEPING_FAILED', text: `Housekeeping payout ${last.n}: ${v.status}${v.kind === 'FINAL' ? ` ${v.reason}` : ''}; start again` }, waiting: null }, { kind: 'done' }, `Blocked: housekeeping payout ${last.n} ${v.status}`);
    if (v.kind !== 'PAID') return block('HOUSEKEEPING_FAILED', `Housekeeping payout ${last.n}: ${v.why}`);
    const landing = last.fromMinor - last.amountMinor - v.feeMinor;
    // Counted once in the merchant ledger (C-BAL-1 reads RESV#): the debit stands until PayPal's report includes it.
    const resv: Op = { op: 'put', table: 'provider', item: { pk, sk: `RESV#hk:${last.senderBatchId}`, effectKey: `hk:${last.senderBatchId}`, tenantId: 'housekeeping', runId: r.resetKey, occurrenceKey: 'housekeeping', state: 'SETTLED', faceMinor: last.amountMinor, debitMinor: last.amountMinor + v.feeMinor, transactionId: v.transactionId, itemId, inFlight: false, version: 1, housekeeping: true }, cond: { notExists: true } };
    const hk = setHk({ state: 'PAID', itemId, feeMinor: v.feeMinor, transactionId: v.transactionId });
    const text = `Housekeeping payout ${last.n} paid: ${dollars(last.amountMinor)} + fee ${dollars(v.feeMinor)} (PayPal item ${itemId}) → ${dollars(landing)}`;
    if (Math.abs(landing - OPENING_MINOR) <= LANDING_TOLERANCE_MINOR) return save({ hk, landingMinor: landing, state: 'SEEDING', waiting: null }, { kind: 'requeue', at: now }, text, [resv]);
    if (landing < OPENING_MINOR) return save({ hk, landingMinor: landing, state: 'BLOCKED', blocker: { code: 'RAIL_BELOW_OPENING', text: `Landed at ${dollars(landing)} (PayPal's fee was above the 2% ceiling)` } }, { kind: 'done' }, text, [resv]);
    return save({ hk, landingMinor: landing }, { kind: 'requeue', at: now }, text, [resv]);
  }

  async function seeding() {
    const { operatorReset } = await import('../../handlers/operator.ts');
    // P2-2: the lease no longer names this reset (released or moved) → the seed can never bind; stop instead of retrying forever.
    const l = await leaseOf(d.store, d.config.connectionId);
    if (l?.resetSk !== r.sk || l.tenantId !== r.tenantId) return block('LEASE_MOVED', 'The merchant was released or moved during the reset; start again');
    // The new run is bound to the lease inside the reset TX, so its first PayPal claim already holds the lease.
    const run = await operatorReset(d, r.tenantId, `${r.reason} (reset ${r.resetKey})`, {
      bank: 'seed', hero: true, dispute: r.dispute, bills: 'AUTO', // the demo business's own bill rule (owner, 3 Nov 2026)
      extraOps: (nr) => [
        { op: 'update', table: 'provider', pk, sk: 'TENANT', set: { runId: nr.runId, lastActiveAt: now }, cond: { eq: { resetSk: r.sk, tenantId: r.tenantId } } },
        auditOp({ tenantId: nr.tenantId, runId: nr.runId, type: 'RunReset', by: 'OPERATOR', allowedBy: 'Sandbox run start', result: `Fresh run on the sandbox merchant: opening ${dollars(r.landingMinor ?? 0)}${r.hk.length ? ` · returned by ${r.hk.length} housekeeping payout${r.hk.length > 1 ? 's' : ''} (${r.hk.map((h) => `item ${h.itemId}`).join(', ')})` : ''}`, refs: { resetKey: r.resetKey }, correlationId: `reset:${r.resetKey}`, now }),
      ],
    });
    return save({ state: 'DONE', runId: run?.runId ?? null, waiting: null }, { kind: 'done' }, `Fresh run ${run?.runId ?? ''} seeded (${run?.state ?? 'PREPARING'})`);
  }
}
