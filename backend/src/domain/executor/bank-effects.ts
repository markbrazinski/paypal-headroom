// Bank connection effects (S02 §6.2a): BANK_CONNECT, BANK_SEED, BANK_REMOVE. The only caller of the Plaid connector.
// Immutable keys; a dispatch claim (run fence + lease + state) before any call; UNKNOWN is reconciled with the same key.
import { assertTransition, canTransition, PlaidExchange, PlaidSandboxPublicToken, TERMINAL_BANK_EFFECT_STATES, type BankEffectState } from '@headroom/contracts';
import { K } from '../../adapters/store/keys.ts';
import { TxCancelled, type Op } from '../../adapters/store/port.ts';
import { grantStopped, NoResponse, type HttpResult } from '../../adapters/grant.ts';
import { sealWith, unseal, type DataKey, type VaultContext } from '../../adapters/vault.ts';
import type { Deps } from '../../deps.ts';
import { auditOp } from '../audit/audit.ts';
import { backoff, finishOp, leaseCheck, newJob, putJobOp, type Finish, type Lease } from '../../jobs/lease.ts';
import { addMs } from '../time.ts';
import { getFence, getRun, readinessOp } from '../identity-run/run.ts';
import { bankEffectOf, bindingOf, connOf, removalOps, syncJobId, type BankEffItem, type ConnItem } from '../bank-mirror/connect.ts';
import { DEMO_INSTITUTION } from '../bank-mirror/seed.ts';
import { LeaseLost } from './invoice-issue.ts';
import type { Budget } from '../bank-mirror/observe-bank.ts';

/** Per-call timeouts (S02 §6.6) and the time kept back for the durable result capture after a 200 (S2-IM-01). */
const CREATE_MS = 20_000, CALL_MS = 10_000, CAPTURE_RESERVE_MS = 5_000;
/** A provider call starts only if it, its capture and a 2 s margin fit inside the invocation's budget (S2-PR-06). */
const fits = (b: Budget, timeoutMs: number) => b.deadline - b.elapsed() >= timeoutMs + CAPTURE_RESERVE_MS + 2_000;
/** Not enough budget for the next call: keep the current checkpoint and continue in a fresh invocation (same key, same state). */
const yieldNow = (d: Deps, l: Lease, why: string) => d.store.transact([finishOp(l, { kind: 'requeue', at: d.now(), error: `Continuing in a new invocation: ${why}` })])
  .catch((err) => { if (err instanceof TxCancelled) throw new LeaseLost('yield refused'); throw err; });

const ctxOf = (e: BankEffItem): VaultContext => ({ tenantId: e.tenantId, effectKey: e.effectKey });
const NOT_FOUND = ['ITEM_NOT_FOUND', 'INVALID_ACCESS_TOKEN'];

async function call(fn: () => Promise<HttpResult>): Promise<HttpResult | undefined> {
  try { return await fn(); } catch (e) { if (e instanceof NoResponse) return undefined; throw e; }
}
/** 2xx → OK; definitive 4xx (not 408/429) → FAILED with Plaid's code; no response, 5xx, 408, 429 → UNKNOWN. */
function outcome(r: HttpResult | undefined): { kind: 'OK' } | { kind: 'FAILED' | 'UNKNOWN'; code: string; reason: string } {
  if (r && r.status >= 200 && r.status < 300) return { kind: 'OK' };
  const code = r?.body?.error_code ?? (r ? `HTTP_${r.status}` : 'NO_RESPONSE');
  const reason = r ? `Plaid ${r.status} ${code}` : 'No response from Plaid (timeout or network)';
  return r && r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429 ? { kind: 'FAILED', code, reason } : { kind: 'UNKNOWN', code, reason };
}

const audit = (d: Deps, e: { tenantId: string; runId: string; effectKey: string }, type: Parameters<typeof auditOp>[0]['type'], result: string, refs: Record<string, string> = {}, allowedBy = 'Owner: Connect bank') =>
  auditOp({ tenantId: e.tenantId, runId: e.runId, type, by: 'HEADROOM', allowedBy, result, refs: { effectKey: e.effectKey, ...refs }, correlationId: e.effectKey, now: d.now() });
const allowedBy = (e: BankEffItem) => e.kind === 'BANK_SEED' ? 'Operator: sandbox reset (SEEDED bank)' : e.kind === 'BANK_REMOVE' ? 'Disconnect / reset cleanup' : 'Owner: Connect bank';

/** Move the effect checkpoint (+ ops) in one lease-checked TX. */
async function step(d: Deps, l: Lease, e: BankEffItem, to: BankEffectState, x: { set?: Record<string, unknown>; remove?: string[]; ops?: Op[]; finish?: Finish } = {}) {
  assertTransition('BankEffect', e.state, to);
  try {
    await d.store.transact([
      { op: 'update', table: 'work', pk: e.pk, sk: 'EFFECT', set: { state: to, version: e.version + 1, updatedAt: d.now(), ...x.set }, ...(x.remove ? { remove: x.remove } : {}), cond: { eq: { state: e.state } } },
      ...(x.ops ?? []),
      x.finish ? finishOp(l, x.finish) : leaseCheck(l),
    ]);
  } catch (err) {
    if (err instanceof TxCancelled) throw new LeaseLost(`bank checkpoint ${e.state} → ${to} refused`);
    throw err;
  }
  Object.assign(e, { state: to, version: e.version + 1, ...x.set });
}

/**
 * Record definitive provider evidence (a 200's result). Deliberately NOT lease-conditioned: it is monotone (first writer
 * wins on state) and can't double-apply. Retried in process for up to 20 s so a transient store error doesn't lose it.
 */
async function capture(d: Deps, b: Budget, e: BankEffItem, from: BankEffectState[], to: BankEffectState, set: Record<string, unknown>) {
  for (const f of from) if (canTransition('BankEffect', f, to) === false) throw new Error(`illegal capture ${f} → ${to}`);
  const until = Date.now() + 20_000;
  for (let i = 0; ; i++) {
    try {
      await d.store.transact([{ op: 'update', table: 'work', pk: e.pk, sk: 'EFFECT', set: { state: to, version: e.version + 1, updatedAt: d.now(), ...set }, cond: { in: { state: from }, eq: { version: e.version } } }]);
      Object.assign(e, { state: to, version: e.version + 1, ...set });
      return;
    } catch (err) {
      if (err instanceof TxCancelled) {
        const cur = (await bankEffectOf(d.store, e.effectKey))!;
        if (cur.state === to) { Object.assign(e, cur); return; } // another writer captured the same evidence
        if (from.includes(cur.state)) { Object.assign(e, cur); continue; } // version moved (e.g. sweep → UNKNOWN): retry on it
        throw new LeaseLost(`capture refused in ${cur.state}`);
      }
      if (Date.now() > until || b.deadline - b.elapsed() < 1_000) throw err; // the lease then expires → UNKNOWN → same-key replay
      await new Promise((r) => setTimeout(r, Math.min(200 * 2 ** i, 2_000)));
    }
  }
}

/** Waiting reasons keep the effect READY, never failed (the S1 rule). */
async function waiting(d: Deps, e: BankEffItem): Promise<string | null> {
  if (!d.plaid?.connector || !d.vault) return 'Waiting: bank connection is not configured here';
  const g = d.config.grant;
  const stopped = await grantStopped(d.store, g, 'plaid', 'calls', d.now()) ?? (e.kind !== 'BANK_REMOVE' ? await grantStopped(d.store, g, 'plaid', 'items', d.now()) : null);
  return stopped && `Waiting: ${stopped}`;
}

async function load(d: Deps, key: string) {
  const e = await bankEffectOf(d.store, key);
  if (!e) throw new Error(`bank effect ${key} missing`);
  return e;
}

/** EXECUTE_EFFECT for a bank effect: READY → dispatch claim → provider call → capture → bind / remove. */
export async function executeBankEffect(d: Deps, l: Lease, b: Budget): Promise<void> {
  const e = await load(d, l.job.ref);
  if (TERMINAL_BANK_EFFECT_STATES.includes(e.state)) return d.store.transact([finishOp(l, { kind: 'done' })]);
  if (e.state !== 'READY') return reconcileBankEffect(d, l, b);

  const wait = await waiting(d, e);
  if (wait) {
    return d.store.transact([
      { op: 'update', table: 'work', pk: e.pk, sk: 'EFFECT', set: { waitingReason: wait }, cond: { eq: { state: 'READY' } } },
      finishOp(l, { kind: 'requeue', at: addMs(d.now(), 15 * 60_000), error: wait, resetAttempts: true }),
    ]);
  }
  if (!fits(b, e.kind === 'BANK_SEED' ? CREATE_MS : CALL_MS)) return yieldNow(d, l, 'not enough time left to dispatch');
  // Everything that can fail without a provider call happens BEFORE the claim: the data key that will seal the result
  // (S2-PR-02), the public token and, for removal, the access token. A failure here leaves the effect READY.
  let dk: DataKey | undefined, publicToken: string | undefined, accessToken: string | undefined, conn: ConnItem | undefined;
  try {
    if (e.kind !== 'BANK_REMOVE') dk = await d.vault!.generateDataKey(ctxOf(e));
    if (e.kind === 'BANK_CONNECT') publicToken = await unseal(d.vault!, e.sealedPublicToken!);
    if (e.kind === 'BANK_REMOVE') {
      conn = await connOf(d.store, e.itemId!);
      if (conn?.sealedAccessToken) accessToken = await unseal(d.vault!, conn.sealedAccessToken);
    }
  } catch (err) {
    const error = `Not dispatched: key service unavailable (${(err as Error).message})`;
    return d.store.transact([finishOp(l, { kind: 'requeue', at: backoff(d.now(), l.job.attempts), error })]);
  }
  const to: BankEffectState = e.kind === 'BANK_SEED' ? 'CREATE_DISPATCHED' : e.kind === 'BANK_CONNECT' ? 'EXCHANGE_DISPATCHED' : 'REMOVE_DISPATCHED';
  assertTransition('BankEffect', 'READY', to);
  try {
    // BANK_REMOVE is fence-exempt by design: it only withdraws our own credential and must also clean up old runs.
    await d.store.transact([
      ...(e.kind === 'BANK_REMOVE' ? [] : [{ op: 'check' as const, table: 'core' as const, pk: K.tenant(e.tenantId), sk: 'RUN_FENCE', cond: { eq: { epoch: e.epoch } } }]),
      leaseCheck(l),
      { op: 'update', table: 'work', pk: e.pk, sk: 'EFFECT', set: { state: to, version: e.version + 1, updatedAt: d.now(), waitingReason: null, ...(dk ? { encDataKey: dk.encDataKey } : {}) }, cond: { eq: { state: 'READY' } } },
      audit(d, e, 'EffectDispatchClaimed', e.kind === 'BANK_REMOVE' ? 'Dispatch claimed; asking Plaid to remove the connection' : 'Dispatch claimed; calling Plaid', {}, allowedBy(e)),
    ]);
    Object.assign(e, { state: to, version: e.version + 1, encDataKey: dk?.encDataKey });
  } catch (err) {
    if (!(err instanceof TxCancelled)) throw err;
    if (e.kind !== 'BANK_REMOVE' && err.failed[0]) return fenced(d, l, e);
    throw new LeaseLost('bank dispatch claim refused');
  }
  if (e.kind === 'BANK_REMOVE') return accessToken ? removeAfterDispatch(d, l, e, accessToken) : removed(d, l, e, 'No credential left to remove');
  if (e.kind === 'BANK_SEED') {
    const created = await seedCreate(d, l, b, e, dk!);
    if (!created) return;
    publicToken = created;
    if (!fits(b, CALL_MS)) return yieldNow(d, l, 'seed created; exchange continues in a new invocation'); // CREATED is a durable checkpoint
    await step(d, l, e, 'EXCHANGE_DISPATCHED');
  }
  return exchange(d, l, b, e, dk!, publicToken!);
}

/** READY effect from an old epoch: no Plaid call; the slot is released in its own run. */
async function fenced(d: Deps, l: Lease, e: BankEffItem) {
  await step(d, l, e, 'VERIFIED_FAILURE', {
    set: { failureReason: 'RUN_FENCED: the run was reset before this bank connection was made' }, remove: ['sealedPublicToken'],
    ops: [...(await releaseOps(d, e)), audit(d, e, 'EffectRunFenced', 'Not connected: the run was reset first; no Plaid call was made', {}, allowedBy(e))],
    finish: { kind: 'done' },
  });
}

async function releaseOps(d: Deps, e: BankEffItem): Promise<Op[]> {
  const b = await bindingOf(d.store, e.tenantId, e.runId);
  if (!b || b.state !== 'CONNECTING' || b.effectKey !== e.effectKey) return [];
  assertTransition('BankBinding', 'CONNECTING', 'RELEASED');
  return [{ op: 'update', table: 'core', pk: b.pk, sk: b.sk, set: { state: 'RELEASED', version: b.version + 1 }, cond: { eq: { state: 'CONNECTING', effectKey: e.effectKey } } }];
}

/** A seed problem blocks the run (if still PREPARING) with a visible reason. */
async function blockOps(d: Deps, e: BankEffItem, reason: string): Promise<Op[]> {
  if (e.kind !== 'BANK_SEED') return [];
  const run = await getRun(d.store, e.tenantId, e.runId);
  const op = run && readinessOp(run, reason);
  return op ? [op, audit(d, e, 'RunReadinessChanged', `Run BLOCKED: ${reason}`, {}, allowedBy(e))] : [];
}

async function failed(d: Deps, l: Lease, e: BankEffItem, reason: string) {
  await step(d, l, e, 'VERIFIED_FAILURE', {
    set: { failureReason: reason }, remove: ['sealedPublicToken'],
    ops: [...(await releaseOps(d, e)), ...(await blockOps(d, e, `Bank seed failed: ${reason}`)), audit(d, e, e.kind === 'BANK_SEED' ? 'BankSeedFailed' : 'BankConnectFailed', `Not connected: ${reason}`, {}, allowedBy(e))],
    finish: { kind: 'done' },
  });
}

async function toUnknown(d: Deps, l: Lease, e: BankEffItem, reason: string, o: { terminal?: boolean; canAbandon?: boolean } = {}) {
  const now = d.now();
  const blocked = e.kind === 'BANK_SEED' && (o.terminal || !e.sealedPublicToken) ? await blockOps(d, e, 'Bank seed outcome unknown: reset again') : [];
  if (e.state === 'UNKNOWN') {
    // Already UNKNOWN (a replay): record the verdict in place; no state edge.
    return d.store.transact([
      { op: 'update', table: 'work', pk: e.pk, sk: 'EFFECT', set: { failureReason: reason, version: e.version + 1, updatedAt: now, ...(o.canAbandon ? { canAbandon: true } : {}), ...(o.terminal ? { terminal: true } : {}) }, cond: { eq: { state: 'UNKNOWN', version: e.version } } },
      ...blocked, audit(d, e, 'BankEffectOutcomeUnknown', reason, {}, allowedBy(e)),
      finishOp(l, o.terminal ? { kind: 'done' } : { kind: 'requeue', at: backoff(now, l.job.attempts), type: 'RECONCILE_EFFECT', error: reason }),
    ]).catch((err) => { if (err instanceof TxCancelled) throw new LeaseLost('unknown verdict refused'); throw err; });
  }
  await step(d, l, e, 'UNKNOWN', {
    set: { failureReason: reason, ...(o.canAbandon ? { canAbandon: true } : {}), ...(o.terminal ? { terminal: true } : {}) },
    ops: [...blocked, audit(d, e, 'BankEffectOutcomeUnknown', reason, {}, allowedBy(e))],
    finish: o.terminal ? { kind: 'done' } : { kind: 'requeue', at: backoff(now, l.job.attempts), type: 'RECONCILE_EFFECT', error: reason, unknownSince: now },
  });
}

/** BANK_SEED create. Not idempotent and no lookup exists, so an unknown outcome is never replayed (invariant 14). */
async function seedCreate(d: Deps, l: Lease, b: Budget, e: BankEffItem, dk: DataKey): Promise<string | null> {
  const r = await call(() => d.plaid!.connector!.sandboxPublicTokenCreate(DEMO_INSTITUTION.id, 'user_custom', JSON.stringify(e.seedConfig)));
  await d.hooks?.afterBankResult?.(e.effectKey);
  const o = outcome(r);
  const ok = o.kind === 'OK' ? PlaidSandboxPublicToken.safeParse(r!.body) : null;
  if (o.kind === 'FAILED') { await failed(d, l, e, o.reason); return null; }
  if (!ok?.success) { await toUnknown(d, l, e, o.kind === 'UNKNOWN' ? o.reason : 'Plaid answered without a public token', { terminal: true }); return null; }
  await capture(d, b, e, ['CREATE_DISPATCHED'], 'CREATED', { sealedPublicToken: sealWith(dk, ok.data.public_token, ctxOf(e)) });
  return ok.data.public_token;
}

/** /item/public_token/exchange, then capture and bind. Also the same-key replay (a public token is single-use). */
async function exchange(d: Deps, l: Lease, b: Budget, e: BankEffItem, dk: DataKey, publicToken: string, replay = false) {
  const r = await call(() => d.plaid!.connector!.exchange(publicToken));
  await d.hooks?.afterBankResult?.(e.effectKey);
  const o = outcome(r);
  const ok = o.kind === 'OK' ? PlaidExchange.safeParse(r!.body) : null;
  if (ok?.success) {
    // Sealed locally with the pre-generated key: no network call stands between Plaid's 200 and this write.
    await capture(d, b, e, ['EXCHANGE_DISPATCHED', 'UNKNOWN'], 'EXCHANGED', { itemId: ok.data.item_id, sealedAccessToken: sealWith(dk, ok.data.access_token, ctxOf(e)), replayed: replay || !!e.replayed });
    return bind(d, l, e);
  }
  if (replay && o.kind === 'FAILED') {
    // Consumed (or expired) on the first attempt: whether Plaid made an Item can't be determined. Terminal for automation.
    return toUnknown(d, l, e, `Same-token replay answered ${o.code}: can't tell whether Plaid connected this bank`, { terminal: true, canAbandon: e.kind === 'BANK_CONNECT' });
  }
  if (o.kind === 'FAILED') return failed(d, l, e, o.reason);
  if (e.state === 'UNKNOWN') return d.store.transact([finishOp(l, { kind: 'requeue', at: backoff(d.now(), l.job.attempts), error: o.kind === 'UNKNOWN' ? o.reason : 'exchange answered without a token' })]);
  return toUnknown(d, l, e, o.kind === 'UNKNOWN' ? o.reason : 'Plaid answered without an access token');
}

/**
 * Binding phase. If the run was reset meanwhile, the effect still completes in its own (old) run, and the same TX queues
 * BANK_REMOVE: a sealed run never uses the Item, and every Item Plaid returned is owned and bound or owned and being removed.
 */
async function bind(d: Deps, l: Lease, e: BankEffItem) {
  const seeded = e.kind === 'BANK_SEED';
  const institution = seeded ? DEMO_INSTITUTION : { id: e.institution?.id ?? null, name: e.institution?.name ?? null };
  const b = await bindingOf(d.store, e.tenantId, e.runId);
  for (let attempt = 0; attempt < 2; attempt++) {
    const sealedRun = attempt > 0 || (await getFence(d.store, e.tenantId))?.epoch !== e.epoch;
    const now = d.now();
    const conn: ConnItem = {
      pk: K.plaid(e.itemId!), sk: 'ITEM', itemId: e.itemId!, tenantId: e.tenantId, runId: e.runId, state: sealedRun ? 'DISCONNECTING' : 'SYNCING', version: 1, generation: 1,
      institution, basis: seeded ? 'SEEDED' : 'OWNER_LINKED', sealedAccessToken: e.sealedAccessToken!, effectKey: e.effectKey, connectedAt: now,
      institutionDataAsOf: null, consentExpiresAt: null, itemError: null,
    };
    const ops: Op[] = [
      { op: 'put', table: 'provider', item: conn, cond: { notExists: true } },
      ...(b && b.state === 'CONNECTING' && b.effectKey === e.effectKey
        ? [{ op: 'update' as const, table: 'core' as const, pk: b.pk, sk: b.sk, set: { state: 'BOUND', itemId: e.itemId, boundAt: now, version: b.version + 1, basis: conn.basis }, cond: { eq: { state: 'CONNECTING', effectKey: e.effectKey } } }]
        : []),
      ...(sealedRun
        ? [...removalOps(conn, now), audit(d, e, seeded ? 'BankSeeded' : 'BankConnected', `${institution.name ?? 'Bank'} connected after its run was reset; removing it (never used)`, { itemId: e.itemId! }, allowedBy(e))]
        : [{ op: 'check' as const, table: 'core' as const, pk: K.tenant(e.tenantId), sk: 'RUN_FENCE', cond: { eq: { epoch: e.epoch } } },
           putJobOp(newJob(syncJobId(e.itemId!), 'PLAID_SYNC', e.itemId!, now, e.tenantId, e.runId)),
           audit(d, e, seeded ? 'BankSeeded' : 'BankConnected', `${institution.name ?? 'Bank'} connected (read-only, ${seeded ? 'SEEDED sample bank' : 'linked by you'}); reading accounts and transactions${e.replayed ? '. Bound after a same-token replay of a lost exchange response; Plaid may also hold an Item Headroom never received' : ''}`, { itemId: e.itemId! }, allowedBy(e))]),
    ];
    try {
      assertTransition('BankEffect', 'EXCHANGED', 'VERIFIED_SUCCESS');
      await d.store.transact([
        { op: 'update', table: 'work', pk: e.pk, sk: 'EFFECT', set: { state: 'VERIFIED_SUCCESS', version: e.version + 1, updatedAt: now }, remove: ['sealedPublicToken', 'sealedAccessToken', 'encDataKey'], cond: { eq: { state: 'EXCHANGED' } } },
        ...ops,
        finishOp(l, { kind: 'done' }),
      ]);
      if (!sealedRun) await d.queue.send(syncJobId(e.itemId!)).catch(() => {});
      return;
    } catch (err) {
      if (!(err instanceof TxCancelled)) throw err;
      const fenceIdx = ops.findIndex((o) => o.op === 'check') + 1;
      if (!sealedRun && fenceIdx > 0 && err.failed[fenceIdx]) continue; // reset raced the bind: bind in the old run and queue removal
      throw new LeaseLost('bind refused');
    }
  }
}

async function removeAfterDispatch(d: Deps, l: Lease, e: BankEffItem, accessToken: string, replay = false) {
  const r = await call(() => d.plaid!.connector!.remove(accessToken));
  if (r && (outcome(r).kind === 'OK' || NOT_FOUND.includes(r.body?.error_code))) return removed(d, l, e, outcome(r).kind === 'OK' ? 'Plaid removed the connection' : 'Plaid no longer had the connection');
  const why = outcome(r);
  if (replay || e.state === 'UNKNOWN') return d.store.transact([finishOp(l, { kind: 'requeue', at: backoff(d.now(), l.job.attempts), error: 'reason' in why ? why.reason : 'remove failed' })]);
  return toUnknown(d, l, e, 'reason' in why ? why.reason : 'remove failed');
}

/** ITEM → DISCONNECTED (token dropped), the run's slot → RELEASED (Connect possible again), one TX. Evidence is kept. */
async function removed(d: Deps, l: Lease, e: BankEffItem, result: string) {
  const conn = await connOf(d.store, e.itemId!);
  const b = conn ? await bindingOf(d.store, conn.tenantId, conn.runId) : undefined;
  const ops: Op[] = [];
  if (conn && conn.state !== 'DISCONNECTED') {
    assertTransition('BankConnection', conn.state, 'DISCONNECTED');
    ops.push({ op: 'update', table: 'provider', pk: conn.pk, sk: 'ITEM', set: { state: 'DISCONNECTED', version: conn.version + 1, generation: conn.generation + 1 }, remove: ['sealedAccessToken'], cond: { eq: { state: 'DISCONNECTING' } } });
  }
  if (b && b.state === 'BOUND' && b.itemId === e.itemId) ops.push({ op: 'update', table: 'core', pk: b.pk, sk: b.sk, set: { state: 'RELEASED', version: b.version + 1 }, cond: { eq: { state: 'BOUND', itemId: e.itemId } } });
  const to: BankEffectState = 'VERIFIED_SUCCESS';
  await step(d, l, e, to, { ops: [...ops, audit(d, e, 'BankDisconnected', `${conn?.institution.name ?? 'Bank'} disconnected: ${result}. Earlier readings kept as evidence`, { itemId: e.itemId! }, allowedBy(e))], finish: { kind: 'done' } });
}

/**
 * RECONCILE_EFFECT: only definitive provider evidence moves the effect.
 * CONNECT / SEED-exchange: replay the exchange with the same sealed public token. SEED-create: never replayed.
 * REMOVE: /item/get with the token, then a same-item replay.
 */
export async function reconcileBankEffect(d: Deps, l: Lease, b: Budget): Promise<void> {
  const e = await load(d, l.job.ref);
  if (TERMINAL_BANK_EFFECT_STATES.includes(e.state)) return d.store.transact([finishOp(l, { kind: 'done' })]);
  if (e.state === 'READY') return executeBankEffect(d, l, b);
  if (e.state === 'EXCHANGED') return bind(d, l, e);
  const retry = (error: string) => d.store.transact([finishOp(l, { kind: 'requeue', at: backoff(d.now(), l.job.attempts), error })]);
  if (!d.plaid?.connector || !d.vault) return retry('bank connection not configured here');

  if (e.kind === 'BANK_REMOVE') {
    const conn = await connOf(d.store, e.itemId!);
    if (!conn?.sealedAccessToken) return removed(d, l, e, 'No credential left to remove');
    let token: string;
    try { token = await unseal(d.vault, conn.sealedAccessToken); } catch { return retry('key service unavailable'); }
    if (!fits(b, CALL_MS)) return yieldNow(d, l, 'not enough time left to check the Item');
    const g = await call(() => d.plaid!.reader!.itemGet(token));
    if (g && NOT_FOUND.includes(g.body?.error_code)) return removed(d, l, e, 'Plaid no longer had the connection');
    if (g?.status !== 200) return retry(`Item read failed (${g?.status ?? 'no response'})`);
    if (e.state !== 'UNKNOWN') await step(d, l, e, 'UNKNOWN');
    if (!fits(b, CALL_MS)) return yieldNow(d, l, 'not enough time left to replay the removal');
    return removeAfterDispatch(d, l, e, token, true);
  }
  // CONNECT / SEED
  if (!e.sealedPublicToken) {
    // SEED create with an unknown outcome: never replayed (no lookup, not idempotent). The run is blocked; reset again.
    if (e.state === 'CREATE_DISPATCHED') return toUnknown(d, l, e, 'Seed create outcome unknown (worker stopped); never replayed', { terminal: true });
    return d.store.transact([
      ...(e.state === 'UNKNOWN' ? [{ op: 'update' as const, table: 'work' as const, pk: e.pk, sk: 'EFFECT', set: { terminal: true, failureReason: 'Seed outcome unknown; never replayed. Reset the run to seed again', version: e.version + 1 }, cond: { eq: { state: 'UNKNOWN', version: e.version } } }] : []),
      ...(await blockOps(d, e, 'Bank seed outcome unknown: reset again')), finishOp(l, { kind: 'done' }),
    ]);
  }
  if (e.state === 'UNKNOWN' && e.canAbandon) return d.store.transact([finishOp(l, { kind: 'done' })]); // waits for the owner
  let dk: DataKey, publicToken: string;
  try {
    const encDataKey = e.encDataKey ?? e.sealedPublicToken.encDataKey;
    dk = { plaintext: await d.vault.decryptDataKey(encDataKey, ctxOf(e)), encDataKey };
    publicToken = await unseal(d.vault, e.sealedPublicToken);
  } catch { return retry('key service unavailable'); }
  if (!fits(b, CALL_MS)) return yieldNow(d, l, 'not enough time left for the exchange');
  if (e.state === 'CREATED') {
    await step(d, l, e, 'EXCHANGE_DISPATCHED');
    return exchange(d, l, b, e, dk, publicToken);
  }
  if (e.state === 'EXCHANGE_DISPATCHED') await step(d, l, e, 'UNKNOWN', { set: { failureReason: 'Exchange outcome unknown; replaying with the same public token' } });
  return exchange(d, l, b, e, dk, publicToken, true);
}
