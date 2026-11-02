// Operator functions (C-DEMO subset). Locally behind /__operator (STAGE=local, 127.0.0.1, token);
// in dev, the operator Lambda invoked directly with the owner's AWS profile. No public route.
// The operator holds no Plaid client: it only QUEUES bank effects (S2-PR-01/06).
import { createHash, randomUUID } from 'node:crypto';
import type { Op } from '../adapters/store/port.ts';
import { K } from '../adapters/store/keys.ts';
import { ApiError } from '../api-error.ts';
import { grantStopped } from '../adapters/grant.ts';
import type { Deps } from '../deps.ts';
import { connectionFor, getFence, getRun, recordPayPalBlockers, resetRun, setRunReadiness, type RunItem } from '../domain/identity-run/run.ts';
import { observeBalance } from '../domain/paypal-mirror/observe-balance.ts';
import { newJob, putJobOp, requestRun } from '../jobs/lease.ts';
import { OBSERVE_EVERY_MS } from '../jobs/worker.ts';
import { addMs, businessDate, MIN } from '../domain/time.ts';
import { auditOp } from '../domain/audit/audit.ts';
import { bindingOf, connOf, effectJobId, removalOps, type BankEffItem, type BindingItem } from '../domain/bank-mirror/connect.ts';
import { DEMO_INSTITUTION, seedConfig } from '../domain/bank-mirror/seed.ts';
import { bankFingerprint, decodeProjection } from '../domain/bank-mirror/bank.ts';
import { KELLER, SEED_SUPPLIERS, seedCommitments, seedInflows } from '../domain/obligations/seed.ts';
import { payeeSeedOps } from '../domain/payables/payee.ts';
import { ingestCommand } from '../domain/evidence/ingest.ts';
import { activeRun } from '../domain/identity-run/run.ts';
import { TxCancelled } from '../adapters/store/port.ts';
import { HERO_INVOICE_COUNT, heroReceivableOps, MERCER } from '../domain/receivables/hero.ts';
import { invoiceNumber } from '../domain/receivables/commands.ts';
import { mailSyncJob } from '../domain/comms/inbound.ts';

export const READY_DEADLINE_MS = 10 * MIN;

/**
 * `bank: 'seed'` (S2-D6): the reset TX itself queues BANK_REMOVE for the previous run's Item and BANK_SEED for the new run.
 * The run stays PREPARING until queued work records READY/BLOCKED (bank ready + PayPal read), or 10 min pass.
 */
/** `dispute` (S7): SEEDED keeps Harrow's acknowledged split as a seed (default until mail is connected on the stage); EMAIL waits for her email. */
/** `extraOps` (S7 R1): ops added to the reset TX itself, e.g. binding the new run to the merchant lease. */
export async function operatorReset(d: Deps, tenantId: string, reason: string, opts: { bank?: 'seed' | 'none'; hero?: boolean; dispute?: 'SEEDED' | 'EMAIL'; extraOps?: (run: RunItem) => Op[]; bills?: 'AUTO' | 'ASK' } = {}) {
  const now = d.now();
  const correlationId = `reset:${randomUUID()}`;
  // S7b review P2-3: on a leased merchant (review, or after a drawer Start) a direct operator/CLI reset must not make a run whose PayPal
  // claims silently fail: it re-binds the lease to the new run when this tenant holds it, and is refused otherwise.
  if (!opts.extraOps) {
    const { leaseOf } = await import('../domain/demo/lease.ts');
    const l = await leaseOf(d.store, d.config.connectionId);
    if (l?.leased) {
      if (l.resetSk) {
        const rs = await d.store.get('provider', K.conn(d.config.connectionId), l.resetSk);
        if (rs && !['DONE', 'BLOCKED'].includes(rs.state)) throw new ApiError(409, 'RESET_IN_PROGRESS', 'A sandbox reset is in progress on the merchant; wait for it to finish');
      }
      if (l.tenantId !== tenantId) throw new ApiError(409, 'MERCHANT_LEASED', `The sandbox merchant is held by ${l.tenantId ?? 'nobody (released)'}: use the drawer's Start for ${tenantId}`);
      opts = { ...opts, extraOps: (nr) => [{ op: 'update', table: 'provider', pk: K.conn(d.config.connectionId), sk: 'TENANT', set: { runId: nr.runId, lastActiveAt: now, version: (l.version ?? 0) + 1 }, cond: { eq: { version: l.version, claims: l.claims ?? 0, tenantId } } }] };
    }
  }
  const ppBound = (await connectionFor(d.store, tenantId)) === d.config.connectionId;
  const plaidStopped = opts.bank === 'seed' ? (await grantStopped(d.store, d.config.grant, 'plaid', 'items', now)) ?? (await grantStopped(d.store, d.config.grant, 'plaid', 'calls', now)) : null;
  const seed = opts.bank === 'seed' && !plaidStopped;
  // Every reset removes the previous run's Item, whatever `bank` is and whether the grant is active (the effect waits READY
  // until it is): a sealed run never uses its Item, so no credential is left behind (S2-IR-02).
  const run = await resetRun(d.store, tenantId, reason, now, correlationId, {
    bankSeed: seed, invoiceSeqNext: opts.hero === false ? 1 : HERO_INVOICE_COUNT + 1, bills: opts.bills,
    extra: async (r, old) => [...(await previousItemRemovalOps(d, r, old, now, correlationId)), ...(seed ? bankSeedOps(r, now, correlationId) : []), ...(opts.hero === false ? [] : heroSeedOps(r, now, correlationId, d.config.payoutReceiver ?? null, opts.dispute ?? 'SEEDED')), ...(opts.extraOps?.(r) ?? [])],
  });
  // S6 R7: the old run's never-sent payouts are now unclaimable (epoch fence); their jobs run once to cancel and release them.
  await sweepUnsentPayouts(d, tenantId, now);
  if (opts.bank === 'seed' && plaidStopped) {
    await setRunReadiness(d.store, run, [`Bank not seeded: ${plaidStopped}`]);
    return operatorGetRun(d, tenantId, run.runId);
  }
  if (seed) await d.queue.send(effectJobId(`bankseed#${run.runId}`)).catch(() => {});
  // S4: the hero invoices are issued now, not at the next sweep (the sweep stays the backstop).
  if (opts.hero !== false) for (let i = 1; i <= HERO_INVOICE_COUNT; i++) await d.queue.send(`eff#${invoiceNumber(run.runId, i)}`).catch(() => {});
  if (!ppBound) {
    // No PayPal reads on its behalf (S1-IR-01).
    if (seed) await recordPayPalBlockers(d.store, run, ['PayPal not connected for this business']);
    else await setRunReadiness(d.store, run, ['PayPal not connected for this business']);
    return operatorGetRun(d, tenantId, run.runId);
  }
  // The PayPal balance read runs inline, as in S1; with a seeded bank its blockers wait for the bank half.
  const obs = await observeBalance(d);
  const blockers = obs.ok ? [] : [`PayPal balance read failed: ${obs.error}`];
  if (seed) await recordPayPalBlockers(d.store, run, blockers);
  else await setRunReadiness(d.store, run, blockers);
  await requestRun(d.store, newJob(`obs#${d.config.connectionId}`, 'OBSERVE_BALANCE', d.config.connectionId, addMs(now, OBSERVE_EVERY_MS), null, null), addMs(now, OBSERVE_EVERY_MS));
  return operatorGetRun(d, tenantId, run.runId);
}

/** Remove the previous run's Item (SEEDED or owner-linked; sandbox only). Fence-exempt cleanup, audited in the OLD run. */
async function previousItemRemovalOps(d: Deps, run: RunItem, oldRunId: string | null, now: string, correlationId: string): Promise<Op[]> {
  const old = oldRunId ? await bindingOf(d.store, run.tenantId, oldRunId) : undefined;
  const conn = old?.state === 'BOUND' && old.itemId ? await connOf(d.store, old.itemId) : undefined;
  if (!conn || conn.state === 'DISCONNECTING' || conn.state === 'DISCONNECTED') return [];
  return [
    // Conditioned on state + generation, not version (the sync bumps version every cycle; S2-IR-13).
    { op: 'update', table: 'provider', pk: conn.pk, sk: 'ITEM', set: { state: 'DISCONNECTING', version: conn.version + 1, generation: conn.generation + 1 }, cond: { eq: { state: conn.state, generation: conn.generation } } },
    ...removalOps(conn, now),
    auditOp({ tenantId: run.tenantId, runId: conn.runId, type: 'BankDisconnectRequested', by: 'OPERATOR', allowedBy: 'Operator: sandbox reset', result: `Run reset: ${conn.institution.name ?? 'bank'} connection is being removed; its readings stay as evidence`, refs: { itemId: conn.itemId }, correlationId, now }),
  ];
}

function bankSeedOps(run: RunItem, now: string, correlationId: string): Op[] {
  const ops: Op[] = [];
  // A fresh SEEDED Item for the new run. The config is tracked fixture data (S2-D2), not a secret, so it is not sealed.
  const effectKey = `bankseed#${run.runId}`;
  const config = seedConfig(businessDate(now, run.settings.timeZone));
  const eff: BankEffItem = {
    pk: K.effect(effectKey), sk: 'EFFECT', effectKey, kind: 'BANK_SEED', tenantId: run.tenantId, runId: run.runId, epoch: run.epoch, state: 'READY', version: 1,
    argsHash: createHash('sha256').update(JSON.stringify(config)).digest('hex'), institution: DEMO_INSTITUTION, seedConfig: config, failureReason: null, updatedAt: now,
  };
  const binding: BindingItem = { pk: run.pk, sk: 'CONN#plaid', state: 'CONNECTING', version: 1, effectKey, itemId: null, basis: 'SEEDED', boundAt: null };
  ops.push(
    { op: 'put', table: 'work', item: eff, cond: { notExists: true } },
    { op: 'put', table: 'core', item: binding, cond: { notExists: true } },
    putJobOp(newJob(effectJobId(effectKey), 'EXECUTE_EFFECT', effectKey, now, run.tenantId, run.runId)),
    putJobOp(newJob(`ready#${run.runId}`, 'RUN_READY_DEADLINE', run.runId, addMs(now, READY_DEADLINE_MS), run.tenantId, run.runId)),
    auditOp({ tenantId: run.tenantId, runId: run.runId, type: 'BankConnectRequested', by: 'OPERATOR', allowedBy: 'Operator: sandbox reset', result: 'Sample bank seed queued (SEEDED, Plaid sandbox, read-only)', refs: { effectKey }, correlationId, now }),
  );
  return ops;
}

/**
 * S3 T1: SEEDED supplier, commitments and stated inflows on reset-day offsets (S3-D1/D2). No OBL#: occurrences are generated on read.
 * S4 T1: the hero receivables (customers, 3 real PayPal sandbox invoices through the S1 issue ops, Harrow's claim, history); the
 * stated Mercer receipt is linked to Mercer's invoice so it isn't also listed as undated.
 */
function heroSeedOps(run: RunItem, now: string, correlationId: string, receiver: string | null, dispute: 'SEEDED' | 'EMAIL'): Op[] {
  const day0 = businessDate(now, run.settings.timeZone);
  const cmts = seedCommitments(day0, now);
  const recv = heroReceivableOps(run, day0, now, correlationId, dispute);
  return [
    ...recv.ops,
    // S5-D20: the run's mail sync starts at the mailbox's current position, so an earlier run's mail is never taken in.
    putJobOp(mailSyncJob(run.tenantId, run.runId, now)),
    ...SEED_SUPPLIERS.map((x): Op => ({ op: 'put', table: 'core', item: { pk: run.pk, sk: `SUP#${x.supplierId}`, ...x } })),
    ...cmts.map((x): Op => ({ op: 'put', table: 'core', item: { pk: run.pk, sk: `CMT#${x.commitmentId}`, ...x } })),
    ...seedInflows(day0).map((x): Op => ({ op: 'put', table: 'core', item: { pk: run.pk, sk: `INFLOW#${x.inflowId}`, ...x, ...(x.inflowId === 'in-mercer' ? { invoiceId: recv.invoiceIds[MERCER] } : {}) } })),
    auditOp({ tenantId: run.tenantId, runId: run.runId, type: 'ObligationsSeeded', by: 'OPERATOR', allowedBy: 'Operator: sandbox reset', result: `SEEDED: ${SEED_SUPPLIERS.length} suppliers, ${cmts.length} commitments and 4 stated receipts (fictional, dated from ${day0})`, refs: {}, correlationId, now }),
    // S6-D1: Keller's PayPal payee is the registered sandbox receiver from the operator config, UNCONFIRMED until the owner checks it.
    ...(receiver ? payeeSeedOps(run, KELLER, 'Keller Drafting Co.', receiver, now, correlationId) : []),
  ];
}

/** S6 R7 reset sweep: every unsent (READY/HELD_READY) payout of an earlier epoch on this tenant gets its job pulled; the executor cancels it. */
async function sweepUnsentPayouts(d: Deps, tenantId: string, now: string) {
  const conn = await connectionFor(d.store, tenantId);
  if (!conn) return;
  const resv = (await d.store.query('provider', K.conn(conn), { skPrefix: 'RESV#' })).filter((r) => r.tenantId === tenantId && r.state === 'ACTIVE' && !r.inFlight);
  for (const r of resv) {
    const e = await d.store.get('work', K.effect(r.effectKey), 'EFFECT');
    if (e && (e.state === 'READY' || e.state === 'HELD_READY')) {
      await requestRun(d.store, newJob(`exec#${r.effectKey}`, 'EXECUTE_EFFECT', r.effectKey, now, e.tenantId, e.runId), now);
      await d.queue.send(`exec#${r.effectKey}`).catch(() => {});
    }
  }
}

/**
 * C-DEMO injectBill (S03 T4): original bytes only, through the same ingestCommand() as an owner upload. The payload can't carry
 * fields, classification or state (S3-R26). Sandbox operator lane only.
 */
export async function operatorInjectBill(d: Deps, tenantId: string, e: Record<string, unknown>) {
  const allowed = new Set(['action', 'tenantId', 'fileName', 'contentBase64', 'reason']);
  const extra = Object.keys(e).filter((k) => !allowed.has(k));
  if (extra.length) throw new Error(`injectBill accepts only fileName, contentBase64 and reason; refused: ${extra.join(', ')}`);
  if (typeof e.fileName !== 'string' || typeof e.contentBase64 !== 'string' || typeof e.reason !== 'string') throw new Error('injectBill needs fileName, contentBase64 and reason');
  const run = await activeRun(d.store, tenantId);
  if (!run) throw new Error('No active run');
  const c = { tenantId, run, now: d.now(), correlationId: `inject:${randomUUID()}`, ownerEmail: `operator (${e.reason})` };
  const input = { fileName: e.fileName, bytes: new Uint8Array(Buffer.from(e.contentBase64, 'base64')), source: 'OPERATOR_INJECTED' as const };
  for (let attempt = 0; ; attempt++) {
    const res = await ingestCommand(d.evidence, d.store, c, input);
    try { await d.store.transact(res.ops); } catch (x) { if (x instanceof TxCancelled && attempt === 0) continue; throw x; }
    if ((res.body as { jobId?: string }).jobId) await d.queue.send((res.body as { jobId: string }).jobId).catch(() => {});
    return res.body as { status: string; billId: string; jobId?: string };
  }
}

export async function operatorGetRun(d: Pick<Deps, 'store'>, tenantId: string, runId?: string) {
  const id = runId ?? (await getFence(d.store, tenantId))?.runId;
  const run = id ? await getRun(d.store, tenantId, id) : undefined;
  if (!run) return null;
  const fence = await getFence(d.store, tenantId);
  const b = await bindingOf(d.store, tenantId, run.runId);
  let bank: Record<string, unknown> | null = null;
  if (b) {
    const conn = b.itemId ? await connOf(d.store, b.itemId) : undefined;
    const obs = conn ? (await d.store.query('provider', conn.pk, { skPrefix: 'OBS#', newestFirst: true, limit: 1 }))[0] : undefined;
    const txns = conn ? await d.store.get('provider', conn.pk, 'TXNS') : undefined;
    const eff = await d.store.get('work', K.effect(b.effectKey), 'EFFECT');
    bank = {
      binding: b.state, basis: b.basis, effectState: eff?.state ?? null, effectReason: eff?.failureReason ?? null, itemId: b.itemId, state: conn?.state ?? null,
      accountIds: (obs?.accounts ?? []).map((a: { accountId: string }) => a.accountId),
      fingerprint: obs ? bankFingerprint(obs as never, decodeProjection(txns as never), businessDate(run.createdAt, run.settings.timeZone)) : null,
    };
  }
  return { runId: run.runId, epoch: run.epoch, state: run.state, blockers: run.blockers, active: fence?.runId === run.runId, createdAt: run.createdAt, bank };
}

/**
 * S5-D11 runActionNow: pull one action's due job (check, contact or message) forward. No clock change and no state change; the run
 * is marked early on the job so the check record and card say "Run early by the operator". The owner UI has no such control.
 */
export async function operatorRunActionNow(d: Deps, tenantId: string, actionId: string) {
  const run = await activeRun(d.store, tenantId);
  if (!run || !actionId) return { ok: false, error: 'No active run or action id' };
  const a = await d.store.get('core', run.pk, `ACT#${actionId}`);
  if (!a) return { ok: false, error: 'No such action in the active run' };
  const now = d.now();
  for (const purpose of ['CHECK', 'CONTACT', 'MESSAGE', 'PAY'] as const) {
    const jobId = `due#${actionId}#${a.intentVersion}#${purpose}#0`;
    const j = await d.store.get('work', K.job(jobId), 'JOB');
    if (!j || j.state === 'DONE') continue;
    await d.store.transact([{ op: 'update', table: 'work', pk: j.pk, sk: 'JOB', set: { early: { by: 'operator', scheduledAt: j.dueAt } }, cond: { eq: { leaseToken: j.leaseToken } } },
      auditOp({ tenantId, runId: run.runId, type: 'OperatorRanActionEarly', by: 'OPERATOR', allowedBy: 'Operator: run check now (sandbox)', result: `${a.counterparty.name}: ${purpose.toLowerCase()} scheduled ${j.dueAt} run now (${now}); nothing else changed`, refs: { actionId }, correlationId: `early:${actionId}:${now}`, now })]);
    await requestRun(d.store, j as never, now);
    await d.queue.send(jobId).catch(() => {});
    return { ok: true, jobId, scheduledAt: j.dueAt };
  }
  return { ok: false, error: 'Nothing scheduled to run for this action' };
}

/**
 * UX repair (F12): read-only status for filming and the final-state check (`npm run demo:status`). The owner's own read models
 * (Plan, Overview) under the run's ReadCtx; no write, no provider call. `final` = Mercer skipped, Keller paid, gap closed.
 */
export async function operatorStatus(d: Deps, tenantId: string) {
  const run = await activeRun(d.store, tenantId);
  if (!run) return { run: null };
  const { planCtxFor } = await import('../domain/plan/authority.ts');
  const s4 = await import('../read/s4.ts');
  const rc = await planCtxFor(d, tenantId, run.runId);
  if (!rc) return { run: { runId: run.runId, state: run.state } };
  const [p, o] = await Promise.all([s4.getPlan(rc), s4.getOverview(rc)]);
  const r = p.revision;
  const acts = (r?.actions ?? []).map((a) => ({ kind: a.kind, counterparty: a.counterparty.name, state: a.state, text: a.stateText }));
  const mercer = acts.find((a) => a.kind === 'DISCOUNT_FALLBACK'), keller = acts.find((a) => a.kind === 'PAYOUT');
  return {
    run: { runId: run.runId, state: run.state, epoch: run.epoch },
    plan: r ? { n: r.n, state: r.state, pill: r.pill, coverage: r.header.coverage.text, lowest: `${(r.header.after.low.minor / 100).toFixed(2)} on ${r.header.after.lowOn}`, proposed: p.proposed?.text ?? null } : { state: p.state, reason: p.reason },
    actions: acts,
    updates: r?.updates.map((u) => u.text) ?? [],
    cash: o.cashNow ?? null,
    needs: o.needs.map((n) => n.title),
    final: mercer?.state === 'SKIPPED_NOT_NEEDED' && keller?.state === 'COMPLETED' && r?.header.coverage.state === 'RESOLVED',
  };
}
