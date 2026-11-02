// Sweep (EventBridge every minute in dev; a timer locally): re-sends due jobs and recovers expired leases.
import { unknownFromSweepOps } from '../domain/payables/payout.ts';
import { assertTransition, canTransition, IN_FLIGHT_BANK_EFFECT_STATES, IN_FLIGHT_EFFECT_STATES } from '@headroom/contracts';
import { isBankEffectKey, K } from '../adapters/store/keys.ts';
import { TxCancelled } from '../adapters/store/port.ts';
import type { Deps } from '../deps.ts';
import { auditOp } from '../domain/audit/audit.ts';
import type { JobItem } from './lease.ts';

export async function sweep(d: Pick<Deps, 'store' | 'queue' | 'now'>): Promise<{ sent: number; recovered: number; unknownOlderThan15m: number }> {
  const now = d.now();
  const due = (await d.store.dueJobs(now, 200)) as JobItem[];
  let sent = 0, recovered = 0, unknownOlderThan15m = 0;
  // The alarm counts every pending reconcile, not only those due now (one in backoff is still unresolved; S1-IR-04).
  // ponytail: a full read of the sparse due index. Ceiling: a few thousand pending jobs; upgrade is a sparse UNKNOWN-effects index.
  for (const j of (await d.store.dueJobs('9999-12-31T00:00:00.000Z', 1000)) as JobItem[])
    if (j.type === 'RECONCILE_EFFECT' && j.unknownSince && Date.parse(now) - Date.parse(j.unknownSince) > 15 * 60_000) unknownOlderThan15m++;
  for (const j of due) {
    if (j.state === 'LEASED') {
      try { await recoverExpired(d, j, now); recovered++; } catch (e) { if (!(e instanceof TxCancelled)) throw e; continue; }
    }
    await d.queue.send(j.jobId).catch(() => {});
    sent++;
  }
  if (unknownOlderThan15m) console.log(JSON.stringify({ metric: 'UnknownEffectsOlderThan15m', value: unknownOlderThan15m, at: now }));
  return { sent, recovered, unknownOlderThan15m };
}

/** A worker died holding the lease. An in-flight effect becomes UNKNOWN and is reconciled with the same key (PR-03). */
async function recoverExpired(d: Pick<Deps, 'store' | 'now'>, j: JobItem, now: string) {
  const requeue = (type = j.type, extra: Record<string, unknown> = {}) => ({
    op: 'update' as const, table: 'work' as const, pk: j.pk, sk: 'JOB',
    set: { state: 'QUEUED', type, dueAt: now, dueKey: `${now}#${j.jobId}`, leaseUntil: null, ...extra },
    cond: { eq: { leaseToken: j.leaseToken, state: 'LEASED' } },
  });
  if (j.type !== 'EXECUTE_EFFECT' && j.type !== 'RECONCILE_EFFECT') return d.store.transact([requeue()]);
  const eff = await d.store.get('work', K.effect(j.ref), 'EFFECT');
  if (j.ref.startsWith('pay:')) {
    // S6-D10: a DISPATCHED payout may have reached PayPal: UNKNOWN, replayed with the same sender_batch_id. Other states just run again.
    if (!eff || eff.state !== 'DISPATCHED') return d.store.transact([requeue()]);
    return d.store.transact([requeue('RECONCILE_EFFECT', { unknownSince: now, lastError: 'Worker lease expired after dispatch' }), ...unknownFromSweepOps(eff, now)]);
  }
  if (j.ref.startsWith('upd:') || j.ref.startsWith('mail:')) {
    // S5: a DISPATCHED update or send may have gone out: UNKNOWN, reconciled with the same key (GET / Message-ID search).
    // READY/PREPARED sent nothing: the job just runs again (PREPARED re-checks the invoice against its preimage first).
    if (!eff || eff.state !== 'DISPATCHED') return d.store.transact([requeue()]);
    return d.store.transact([
      requeue('RECONCILE_EFFECT', { unknownSince: now, lastError: 'Worker lease expired after dispatch' }),
      { op: 'update', table: 'work', pk: eff.pk, sk: 'EFFECT', set: { state: 'UNKNOWN', unknownSince: now, updatedAt: now }, add: { version: 1 }, cond: { eq: { state: 'DISPATCHED' } } },
      auditOp({ tenantId: eff.tenantId, runId: eff.runId, type: j.ref.startsWith('upd:') ? 'InvoiceUpdateUnknown' : 'MessageSendUnknown', by: 'HEADROOM', result: 'Worker stopped after dispatch; checking with the same request, never a new one', refs: { effectKey: j.ref }, correlationId: j.ref, now }),
    ]);
  }
  if (isBankEffectKey(j.ref)) {
    // Bank effects (S02 §6.2a): same rule, per machine. A captured EXCHANGED result is definitive: reconcile just binds it.
    if (!eff || !IN_FLIGHT_BANK_EFFECT_STATES.includes(eff.state)) return d.store.transact([requeue()]);
    // CREATED is a durable checkpoint with no call in flight (S2-IR-07): reconcile dispatches the exchange from it.
    if (eff.state === 'CREATED' || !canTransition('BankEffect', eff.state, 'UNKNOWN')) return d.store.transact([requeue('RECONCILE_EFFECT')]);
    return d.store.transact([
      requeue('RECONCILE_EFFECT', { unknownSince: now, lastError: `Worker lease expired in ${eff.state}` }),
      { op: 'update', table: 'work', pk: eff.pk, sk: 'EFFECT', set: { state: 'UNKNOWN', version: eff.version + 1, updatedAt: now, failureReason: `Worker stopped during ${eff.state}` }, cond: { eq: { state: eff.state } } },
      auditOp({ tenantId: eff.tenantId, runId: eff.runId, type: 'BankEffectOutcomeUnknown', by: 'HEADROOM', result: `Worker stopped during ${eff.state}; checking with Plaid using the same ${eff.kind === 'BANK_REMOVE' ? 'item' : 'public token'}`, refs: { effectKey: eff.effectKey }, correlationId: eff.effectKey, now }),
    ]);
  }
  if (!eff || !IN_FLIGHT_EFFECT_STATES.includes(eff.state)) return d.store.transact([requeue()]);
  assertTransition('Effect', eff.state, 'UNKNOWN');
  const inv = await d.store.get('core', K.run(eff.tenantId, eff.runId), `INV#${eff.invoiceId}`);
  await d.store.transact([
    requeue('RECONCILE_EFFECT', { unknownSince: now, lastError: `Worker lease expired in ${eff.state}` }),
    { op: 'update', table: 'work', pk: eff.pk, sk: 'EFFECT', set: { state: 'UNKNOWN', updatedAt: now }, cond: { eq: { state: eff.state } } },
    ...(inv && inv.state === 'ISSUING' ? [{ op: 'update' as const, table: 'core' as const, pk: inv.pk, sk: inv.sk, set: { state: 'ISSUE_UNKNOWN', version: inv.version + 1 }, cond: { eq: { version: inv.version } } }] : []),
    auditOp({ tenantId: eff.tenantId, runId: eff.runId, type: 'EffectOutcomeUnknown', by: 'HEADROOM', result: `Worker stopped during ${eff.state}; checking with PayPal using the same invoice number`, refs: { effectKey: eff.effectKey, invoiceId: eff.invoiceId }, correlationId: eff.effectKey, now }),
  ]);
}
