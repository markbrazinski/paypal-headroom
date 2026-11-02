// Invoice-update effect executor (S5-D4): Harrow's partial enable, Mercer's discount apply and its bound removal (S5-D25).
// READY → PREPARED (request bytes + preimage frozen, UPDLOCK taken; nothing sent) → dispatch claim (authority consumed and frozen)
// → PUT the stored bytes → GET → classify. An UNKNOWN is reconciled by GET with the same key: resend the SAME bytes only if the
// invoice is exactly the preimage; anything else is CONFLICT (no write, ever). Only the worker runs this (it holds the writer).
import { leaseClaimOps } from '../demo/lease.ts';
import { assertTransition, canTransition, TERMINAL_UPDATE_STATES, type EffectAuthority, type UpdateEffect, type UpdateEffectState } from '@headroom/contracts';
import { createHash } from 'node:crypto';
import { basisBumpOp, K } from '../../adapters/store/keys.ts';
import { TxCancelled, type Item, type Op } from '../../adapters/store/port.ts';
import { NoResponse, updateInvoicePath, type HttpResult } from '../../adapters/paypal/types.ts';
import type { Deps } from '../../deps.ts';
import { auditOp } from '../audit/audit.ts';
import { backoff, finishOp, leaseCheck, newJob, putJobOp, type Finish, type Lease } from '../../jobs/lease.ts';
import { addMs, MIN } from '../time.ts';
import { retainGet } from '../paypal-mirror/evidence.ts';
import { classifyAfter, discountMinor, dueMinor, targetHolds, updateBody, type UpdateTarget } from './update-body.ts';
import { LeaseLost } from './invoice-issue.ts';
import { actionCheck, authorityFor, planCtxFor, runFenceCheck } from '../plan/authority.ts';
import { loadPlanState, type ActItem } from '../plan/state.ts';

export type UpdItem = UpdateEffect & Item & { requestBytes: string | null; preimageBytes: string | null; expiresAt: string | null; waitingReason?: string | null };

export const updateKey = (rootId: string, intentVersion: number, kind: UpdateEffect['kind']) => `upd:${rootId}:${intentVersion}:${kind}`;
export const isUpdateEffectKey = (key: string) => key.startsWith('upd:');
/** Resends of the stored request after a GET proves it didn't land (S5-D4 (b)); then it stays UNKNOWN for the owner. */
export const MAX_RESENDS = 3;
const RECONCILE_RETRY_MS = 60_000;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export function newUpdateEffect(o: { kind: UpdateEffect['kind']; tenantId: string; runId: string; epoch: number; invoiceId: string; ppInvoiceId: string; actionId: string; rootId: string; intentVersion: number; target: UpdateEffect['target']; now: string; notBefore?: string | null; authority?: EffectAuthority | null; expiresAt?: string | null }): UpdItem {
  const effectKey = updateKey(o.rootId, o.intentVersion, o.kind);
  return {
    pk: K.effect(effectKey), sk: 'EFFECT', effectKey, kind: o.kind, tenantId: o.tenantId, runId: o.runId, epoch: o.epoch, invoiceId: o.invoiceId, ppInvoiceId: o.ppInvoiceId,
    actionId: o.actionId, rootId: o.rootId, intentVersion: o.intentVersion, state: 'READY', version: 1, target: o.target, request: null, preimage: null, requestBytes: null, preimageBytes: null,
    notBefore: o.notBefore ?? null, authority: o.authority ?? null, attempts: 0, unknownSince: null, providerStatus: null, failure: null, updatedAt: o.now, expiresAt: o.expiresAt ?? null,
  };
}
export const executeJobOp = (e: UpdItem, at: string) => putJobOp(newJob(`exec#${e.effectKey}`, 'EXECUTE_EFFECT', e.effectKey, at, e.tenantId, e.runId));

// ---------- UPDLOCK#<invoiceId>: one in-flight update per invoice (S5-D4/D22). Released = holder ''. ----------
export const lockPk = (invoiceId: string) => `UPDLOCK#${invoiceId}`;
export const readLock = (d: Pick<Deps, 'store'>, invoiceId: string) => d.store.get('work', lockPk(invoiceId), 'LOCK');
/** Condition: nobody holds the lock (missing or released). */
export const lockFreeCheck = (lock: Item | undefined, invoiceId: string): Op =>
  lock ? { op: 'check', table: 'work', pk: lock.pk, sk: 'LOCK', cond: { eq: { holder: '', version: lock.version } } } : { op: 'check', table: 'work', pk: lockPk(invoiceId), sk: 'LOCK', cond: { notExists: true } };
const takeLock = (lock: Item | undefined, invoiceId: string, key: string): Op =>
  lock ? { op: 'update', table: 'work', pk: lock.pk, sk: 'LOCK', set: { holder: key, version: lock.version + 1 }, cond: { eq: { holder: '', version: lock.version } } }
    : { op: 'put', table: 'work', item: { pk: lockPk(invoiceId), sk: 'LOCK', invoiceId, holder: key, version: 1 }, cond: { notExists: true } };
const releaseLock = (invoiceId: string, key: string): Op => ({ op: 'update', table: 'work', pk: lockPk(invoiceId), sk: 'LOCK', set: { holder: '' }, add: { version: 1 }, cond: { eq: { holder: key } } });

const targetOf = (e: UpdItem): UpdateTarget =>
  e.kind === 'ENABLE_PARTIAL' ? { kind: 'ENABLE_PARTIAL', minimumMinor: e.target.minimumMinor! }
    : e.kind === 'APPLY_DISCOUNT' ? { kind: 'APPLY_DISCOUNT', percentBp: e.target.percentBp!, noteLine: e.target.noteLine! }
      : { kind: 'REMOVE_DISCOUNT', noteLine: e.target.noteLine };

async function call(fn: () => Promise<HttpResult>): Promise<HttpResult | undefined> {
  try { return await fn(); } catch (e) { if (e instanceof NoResponse) return undefined; throw e; }
}
const loadEff = async (d: Deps, key: string) => {
  const e = (await d.store.get('work', K.effect(key), 'EFFECT')) as UpdItem | undefined;
  if (!e) throw new Error(`update effect ${key} missing`);
  return e;
};
const loadAction = async (d: Deps, e: UpdItem) => (await d.store.get('core', K.run(e.tenantId, e.runId), `ACT#${e.actionId}`)) as ActItem | undefined;
const audit = (d: Deps, e: UpdItem, type: Parameters<typeof auditOp>[0]['type'], result: string, allowedBy: string | null = null, refs: Record<string, string> = {}) =>
  auditOp({ tenantId: e.tenantId, runId: e.runId, type, by: 'HEADROOM', allowedBy, result, refs: { effectKey: e.effectKey, invoiceId: e.invoiceId, actionId: e.actionId, ...refs }, correlationId: e.effectKey, now: d.now() });
const allowedText = (a: EffectAuthority | null) => (!a ? null : a.kind === 'GRANT' ? `Your permission ${a.id}` : a.kind === 'OWNER' ? 'You: Send offer' : `Delegation v${a.policyVersion}: ${a.winningRule}`);
const dollars = (m: number) => `$${(m / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Move the effect (and anything else) in one TX that also checks the lease. */
async function step(d: Deps, l: Lease, e: UpdItem, to: UpdateEffectState, x: { set?: Record<string, unknown>; ops?: Op[]; finish?: Finish } = {}) {
  assertTransition('UpdateEffect', e.state, to);
  try {
    await d.store.transact([
      { op: 'update', table: 'work', pk: e.pk, sk: 'EFFECT', set: { state: to, updatedAt: d.now(), ...x.set }, add: { version: 1 }, cond: { eq: { state: e.state, version: e.version } } },
      ...(x.ops ?? []),
      x.finish ? finishOp(l, x.finish) : leaseCheck(l),
    ]);
  } catch (err) {
    if (err instanceof TxCancelled) throw new LeaseLost(`update ${e.effectKey} ${e.state} → ${to} refused`);
    throw err;
  }
  Object.assign(e, { state: to, version: e.version + 1, ...x.set });
}

/** The action op for an effect outcome: fenced on the action's current version. */
const actUpdate = (a: ActItem, set: Record<string, unknown>): Op => ({ op: 'update', table: 'core', pk: a.pk, sk: a.sk, set: { ...set, version: a.version + 1 }, cond: { eq: { version: a.version } } });
function actTo(a: ActItem | undefined, to: ActItem['state'], set: Record<string, unknown> = {}): Op[] {
  if (!a || a.state === to) return a ? [actUpdate(a, set)] : [];
  assertTransition('Action', a.state, to);
  return [actUpdate(a, { state: to, ...set })];
}

/** EXECUTE_EFFECT / RECONCILE_EFFECT for an `upd:` key. */
export async function executeUpdate(d: Deps, l: Lease): Promise<void> {
  if (!d.writer) throw new Error('executor constructed without a PayPal writer');
  const e = await loadEff(d, l.job.ref);
  if (TERMINAL_UPDATE_STATES.includes(e.state)) return d.store.transact([finishOp(l, { kind: 'done' })]);
  if (e.state === 'READY' || e.state === 'PREPARED') {
    // Never dispatched and its run was reset: it ends here (S5-R20). Dispatched ones still reconcile in the run that claimed them.
    const fence = await d.store.get('core', K.tenant(e.tenantId), 'RUN_FENCE');
    if (fence?.epoch !== e.epoch) {
      const lock = await readLock(d, e.invoiceId);
      return step(d, l, e, 'VERIFIED_FAILURE', { set: { failure: 'Run was reset before this update was sent' }, ops: [...(lock?.holder === e.effectKey ? [releaseLock(e.invoiceId, e.effectKey)] : []), audit(d, e, 'EffectRunFenced', 'Not sent: the demo was reset to a new run')], finish: { kind: 'done' } });
    }
  }
  if (e.state === 'READY' && e.notBefore && e.notBefore > d.now()) return d.store.transact([finishOp(l, { kind: 'requeue', at: e.notBefore, resetAttempts: true })]);
  if (e.state === 'READY') { if (!(await prepare(d, l, e))) return; return dispatch(d, l, e, true); }
  if (e.state === 'PREPARED') return dispatch(d, l, e, false);
  return reconcile(d, l, e);
}

/** GET = preimage; freeze the body built from it; take UPDLOCK. Returns false when it ended the job (waiting, released, done). */
async function prepare(d: Deps, l: Lease, e: UpdItem): Promise<boolean> {
  const g = await call(() => d.reader.getInvoice(e.ppInvoiceId));
  if (g?.status !== 200) { await d.store.transact([finishOp(l, { kind: 'requeue', at: backoff(d.now(), l.job.attempts), error: `Invoice read ${g?.status ?? 'failed'} before update` })]); return false; }
  const target = targetOf(e);
  // The bound removal finds the discount already gone (the owner removed it in PayPal): nothing to write (S5-D25).
  if (e.kind === 'REMOVE_DISCOUNT' && targetHolds(g.body, target)) { await succeed(d, l, e, g, 'Discount already removed in PayPal'); return false; }
  let body: unknown;
  try { body = updateBody(g.body, target); } catch (err) { await finishFailed(d, l, e, `PayPal invoice shape not understood: ${(err as Error).message}`); return false; }
  const bytes = JSON.stringify(body);
  const lock = await readLock(d, e.invoiceId);
  if (lock && lock.holder && lock.holder !== e.effectKey) {
    await d.store.transact([{ op: 'update', table: 'work', pk: e.pk, sk: 'EFFECT', set: { waitingReason: 'Another update to this invoice is in flight' }, cond: { eq: { state: 'READY' } } }, finishOp(l, { kind: 'requeue', at: addMs(d.now(), MIN), resetAttempts: true })]);
    return false;
  }
  const preRef = await retainGet(d.store, K.conn(d.config.connectionId), 'invoice preimage', g, d.now());
  await step(d, l, e, 'PREPARED', {
    set: {
      request: { rawRef: `${e.pk}#requestBytes`, method: 'PUT', pathAndQuery: updateInvoicePath(e.ppInvoiceId), sha256: sha(bytes) }, requestBytes: bytes,
      preimage: { rawRef: preRef, sha256: g.rawSha256, lastUpdateTime: g.body?.detail?.metadata?.last_update_time ?? null, status: g.body.status, dueMinor: dueMinor(g.body) }, preimageBytes: g.raw, waitingReason: null,
    },
    ops: lock?.holder === e.effectKey ? [] : [takeLock(lock, e.invoiceId, e.effectKey)],
  });
  return true;
}

/** Hold or release the unsent update: back to READY (never dispatched), lock released, the action/expiry shows why. */
async function holdUnsent(d: Deps, l: Lease, e: UpdItem, a: ActItem | undefined, code: string, text: string) {
  const ops: Op[] = [releaseLock(e.invoiceId, e.effectKey)];
  if (e.kind === 'REMOVE_DISCOUNT') {
    const state = code === 'PAUSED' ? 'HELD_PAUSED' : code === 'YOU_TOOK_OVER' ? 'HELD_TAKEOVER' : null;
    if (a?.expiry && state && canTransition('OfferExpiry', a.expiry.state, state)) ops.push(actUpdate(a, { expiry: { ...a.expiry, state } }));
    ops.push(audit(d, e, 'OfferRemovalHeld', `Discount end reached but still on PayPal: ${text} · Mercer can still pay the discounted amount · resume or hand back to remove it`));
  } else {
    ops.push(...actTo(a, 'HELD', { holdCode: code, heldReasons: [text] }), audit(d, e, 'ActionHeld', `Not sent: ${text}`));
  }
  await step(d, l, e, 'READY', { set: { waitingReason: text, request: null, requestBytes: null, preimage: null, preimageBytes: null }, ops, finish: { kind: 'done' } });
}

/** PREPARED → (re-check) → dispatch claim → PUT the stored bytes → GET → classify. */
async function dispatch(d: Deps, l: Lease, e: UpdItem, fresh: boolean) {
  if (!fresh) {
    // Crash recovery: PREPARED means nothing was sent. Send the stored request only if the invoice is still exactly the preimage.
    const g = await call(() => d.reader.getInvoice(e.ppInvoiceId));
    if (g?.status !== 200) return d.store.transact([finishOp(l, { kind: 'requeue', at: backoff(d.now(), l.job.attempts), error: 'Invoice read failed before dispatch' })]).then(() => undefined);
    if (classifyAfter(g.body, JSON.parse(e.preimageBytes!), JSON.parse(e.requestBytes!)) !== 'NOT_LANDED') {
      return step(d, l, e, 'READY', { set: { request: null, requestBytes: null, preimage: null, preimageBytes: null }, ops: [releaseLock(e.invoiceId, e.effectKey)], finish: { kind: 'requeue', at: d.now() } });
    }
  }
  const rc = await planCtxFor(d, e.tenantId, e.runId);
  const a = await loadAction(d, e);
  if (!rc || !a) return finishFailed(d, l, e, 'Run or action no longer exists');
  const ops: Op[] = [runFenceCheck(e.tenantId, e.epoch), ...(await leaseClaimOps(d.store, d.config.connectionId, e.tenantId, e.runId, d.now()))];
  let authority = e.authority;
  if (e.kind === 'REMOVE_DISCOUNT') {
    // Bound removal: run fence, pause and takeover only, under the apply's frozen authority (S5-D25).
    const s = await loadPlanState(rc);
    const thread = await d.store.get('core', s.pk, `THREAD#${a.counterparty.id}`);
    if (s.policy.pauses.outreach) return holdUnsent(d, l, e, a, 'PAUSED', 'Headroom is paused');
    if (thread?.owner === 'YOU') return holdUnsent(d, l, e, a, 'YOU_TOOK_OVER', `you took over ${a.counterparty.name}`);
    ops.push({ op: 'check', table: 'core', pk: s.pk, sk: 'POLICY', cond: { eq: { version: s.policy.version } } },
      thread ? { op: 'check', table: 'core', pk: s.pk, sk: thread.sk, cond: { eq: { version: thread.version } } } : { op: 'check', table: 'core', pk: s.pk, sk: `THREAD#${a.counterparty.id}`, cond: { notExists: true } });
  } else {
    const s = await loadPlanState(rc);
    const inv = s.invoices.find((i) => i.invoiceId === e.invoiceId);
    const payable = !!inv && (inv.state === 'ISSUED' || inv.state === 'PARTIALLY_PAID');
    const owner = (await d.store.query('core', s.pk, { skPrefix: `OWNERAUTH#${a.actionId}#` })).find((o) => o.state === 'ACTIVE');
    const { res, conds } = await authorityFor(s, a, 'DISPATCH', 'EFFECT', { invoice: { payable, why: inv ? `Invoice is ${inv.state.toLowerCase().replace('_', ' ')}` : 'Invoice missing' }, ownerAuth: owner ? { id: owner.sk, termsHash: owner.termsHash, state: owner.state } : null });
    if (!res.ok) return holdUnsent(d, l, e, a, res.code, res.text);
    authority = res.authority;
    ops.push(...conds, actionCheck(a));
    if (res.grant) ops.push({ op: 'update', table: 'core', pk: s.pk, sk: `GRANT#${res.grant.grantId}`, set: { state: 'CONSUMED', consumedBy: e.effectKey }, cond: { eq: { state: 'ACTIVE', termsHash: res.grant.termsHash } } }, audit(d, e, 'GrantConsumed', `Permission ${res.grant.grantId} used by this update; it is never checked or spent again`));
    // S7 R5: asking for a disputed amount consumes its grant here and freezes the authority (AUTHZ#) and the allowance (DISPALLOW#).
    // Later rule changes or grant expiry never revoke it; they only stop new asks.
    if (a.kind === 'COLLECT_DISPUTED' && e.kind === 'ENABLE_PARTIAL') {
      if (!res.grant) return holdUnsent(d, l, e, a, 'NOT_AUTHORIZED', 'Asking for a disputed amount needs your approval each time');
      const allow = await d.store.get('core', s.pk, `DISPALLOW#${e.invoiceId}`);
      const minor = a.terms.amount.minor;
      ops.push(
        { op: 'put', table: 'core', item: { pk: s.pk, sk: `AUTHZ#${e.effectKey}`, effectKey: e.effectKey, invoiceId: e.invoiceId, portion: 'DISPUTED', allowanceMinor: minor, grantId: res.grant.grantId, policyVersion: s.policy.version, termsHash: res.grant.termsHash, at: d.now() }, cond: { notExists: true } },
        allow ? { op: 'update', table: 'core', pk: s.pk, sk: allow.sk, set: { allowedMinor: allow.allowedMinor + minor }, add: { version: 1 }, cond: { eq: { version: allow.version } } }
          : { op: 'put', table: 'core', item: { pk: s.pk, sk: `DISPALLOW#${e.invoiceId}`, invoiceId: e.invoiceId, allowedMinor: minor, usedMinor: 0, version: 1 }, cond: { notExists: true } },
        basisBumpOp(s.pk),
        audit(d, e, 'DisputedCollectionAuthorized', `You approved asking for ${(minor / 100).toFixed(2)} of the disputed amount; up to that much of a payment may settle it (permission ${res.grant.grantId}, used now)`),
      );
    }
    if (res.authority.kind === 'OWNER') ops.push({ op: 'update', table: 'core', pk: s.pk, sk: res.authority.id!, set: { state: 'CONSUMED', consumedBy: e.effectKey }, cond: { eq: { state: 'ACTIVE' } } });
  }
  try {
    await step(d, l, e, 'DISPATCHED', { set: { authority, waitingReason: null }, ops: [...ops, audit(d, e, 'EffectDispatchClaimed', `Updating the PayPal invoice (${e.kind.toLowerCase().replace(/_/g, ' ')}); no PayPal email`, allowedText(authority))] });
  } catch (err) {
    if (err instanceof LeaseLost) {
      // A condition moved (pause, takeover, revoke, policy, reset) between the gate and the claim: nothing was sent. Re-run from PREPARED.
      await d.store.transact([finishOp(l, { kind: 'requeue', at: d.now(), error: 'Dispatch claim refused: something changed; re-checking' })]).catch(() => {});
      return;
    }
    throw err;
  }
  const put = await call(() => d.writer!.updateInvoice(e.ppInvoiceId, e.requestBytes!, e.effectKey));
  return settle(d, l, e, put);
}

/** After a PUT (or none, on reconcile): GET and classify against the frozen preimage and request. */
async function settle(d: Deps, l: Lease, e: UpdItem, put: HttpResult | undefined) {
  if (put && put.status >= 400 && put.status < 500) {
    const g = await call(() => d.reader.getInvoice(e.ppInvoiceId));
    if (g?.status === 200 && classifyAfter(g.body, JSON.parse(e.preimageBytes!), JSON.parse(e.requestBytes!)) === 'SUCCESS') return succeed(d, l, e, g);
    return failVerified(d, l, e, `PayPal refused the update: ${put.body?.details?.[0]?.issue ?? put.body?.name ?? put.status}`);
  }
  const g = await call(() => d.reader.getInvoice(e.ppInvoiceId));
  const verdict = g?.status === 200 ? classifyAfter(g.body, JSON.parse(e.preimageBytes!), JSON.parse(e.requestBytes!)) : null;
  if (verdict === 'SUCCESS') return succeed(d, l, e, g!);
  if (verdict === 'CONFLICT') return conflict(d, l, e, g!);
  return toUnknown(d, l, e, !put ? 'No response from PayPal' : put.status >= 500 ? `PayPal ${put.status}` : verdict === 'NOT_LANDED' ? 'PayPal accepted the update but the invoice shows no change yet' : 'Invoice read failed after the update');
}

async function toUnknown(d: Deps, l: Lease, e: UpdItem, reason: string) {
  const now = d.now();
  const a = await loadAction(d, e);
  const firstTime = e.state !== 'UNKNOWN';
  await step(d, l, e, 'UNKNOWN', {
    set: { unknownSince: e.unknownSince ?? now },
    ops: [...(e.kind !== 'REMOVE_DISCOUNT' && a?.state === 'QUEUED' ? actTo(a, 'UNCERTAIN', { heldReasons: ['Checking with PayPal'] }) : []), ...(firstTime ? [audit(d, e, 'InvoiceUpdateUnknown', `${reason}; checking with PayPal using the same request, never a new one`)] : [])],
    finish: { kind: 'requeue', at: addMs(now, RECONCILE_RETRY_MS * Math.min(Math.max(1, l.job.attempts), 15)), type: 'RECONCILE_EFFECT', error: reason, unknownSince: e.unknownSince ?? now },
  });
}

/** RECONCILE_EFFECT: GET; success, conflict, or — only if the invoice is exactly the preimage — the stored bytes again. */
async function reconcile(d: Deps, l: Lease, e: UpdItem) {
  const g = await call(() => d.reader.getInvoice(e.ppInvoiceId));
  if (g?.status !== 200) return d.store.transact([finishOp(l, { kind: 'requeue', at: addMs(d.now(), RECONCILE_RETRY_MS), error: 'Invoice read failed while reconciling' })]).then(() => undefined);
  const verdict = classifyAfter(g.body, JSON.parse(e.preimageBytes!), JSON.parse(e.requestBytes!));
  if (verdict === 'SUCCESS') return succeed(d, l, e, g);
  if (verdict === 'CONFLICT') return conflict(d, l, e, g);
  if (e.attempts >= MAX_RESENDS) return d.store.transact([finishOp(l, { kind: 'requeue', at: addMs(d.now(), 15 * MIN), error: `Not visible on PayPal after ${MAX_RESENDS} resends of the same request; needs you` })]).then(() => undefined);
  if (e.state === 'DISPATCHED') await step(d, l, e, 'UNKNOWN', { set: { unknownSince: e.unknownSince ?? d.now() } });
  await step(d, l, e, 'UNKNOWN', { set: { attempts: e.attempts + 1 } });
  const put = await call(() => d.writer!.updateInvoice(e.ppInvoiceId, e.requestBytes!, e.effectKey));
  return settle(d, l, e, put);
}

async function finishFailed(d: Deps, l: Lease, e: UpdItem, reason: string) {
  const a = await loadAction(d, e);
  const ops: Op[] = [audit(d, e, 'InvoiceUpdateFailed', reason)];
  if (e.kind !== 'REMOVE_DISCOUNT' && a && (a.state === 'QUEUED' || a.state === 'UNCERTAIN')) ops.push(...actTo(a, 'FAILED', { heldReasons: [reason] }));
  const lock = await readLock(d, e.invoiceId);
  if (lock?.holder === e.effectKey) ops.push(releaseLock(e.invoiceId, e.effectKey));
  await step(d, l, e, 'VERIFIED_FAILURE', { set: { failure: reason }, ops, finish: { kind: 'done' } });
}
async function failVerified(d: Deps, l: Lease, e: UpdItem, reason: string) {
  const text = e.kind === 'ENABLE_PARTIAL' ? `${reason} · collection held · no second invoice` : reason;
  const a = await loadAction(d, e);
  const ops: Op[] = [releaseLock(e.invoiceId, e.effectKey), audit(d, e, 'InvoiceUpdateFailed', text, allowedText(e.authority)), basisBumpOp(K.run(e.tenantId, e.runId))];
  if (e.kind === 'REMOVE_DISCOUNT') { if (a?.expiry) { assertTransition('OfferExpiry', a.expiry.state, 'CONFLICT'); ops.push(actUpdate(a, { expiry: { ...a.expiry, state: 'CONFLICT' } })); } }
  else ops.push(...actTo(a, 'FAILED', { heldReasons: [text] }));
  await step(d, l, e, 'VERIFIED_FAILURE', { set: { failure: text }, ops, finish: { kind: 'done' } });
}

async function conflict(d: Deps, l: Lease, e: UpdItem, g: HttpResult) {
  await retainGet(d.store, K.conn(d.config.connectionId), 'invoice after conflict', g, d.now());
  const a = await loadAction(d, e);
  const text = 'PayPal invoice changed outside Headroom · Needs you';
  const ops: Op[] = [releaseLock(e.invoiceId, e.effectKey), audit(d, e, 'EffectConflict', `${text}; nothing written, and the earlier invoice is never written back`, allowedText(e.authority)), basisBumpOp(K.run(e.tenantId, e.runId))];
  if (e.kind === 'REMOVE_DISCOUNT') { if (a?.expiry && a.expiry.state === 'SCHEDULED') ops.push(actUpdate(a, { expiry: { ...a.expiry, state: 'CONFLICT' } })); }
  else ops.push(...actTo(a, 'HELD', { holdCode: 'PROVIDER_CHANGED', heldReasons: [text] }));
  await step(d, l, e, 'CONFLICT', { set: { providerStatus: g.body?.status ?? null, failure: text }, ops, finish: { kind: 'done' } });
}

/** VERIFIED_SUCCESS: the GET shows exactly what we sent. Writes the kind's consequences in the same TX. */
async function succeed(d: Deps, l: Lease, e: UpdItem, g: HttpResult, note?: string) {
  const now = d.now();
  await retainGet(d.store, K.conn(d.config.connectionId), 'invoice after update', g, now);
  const a = await loadAction(d, e);
  const pk = K.run(e.tenantId, e.runId);
  const lock = await readLock(d, e.invoiceId);
  // Enabling partial payment changes no plan input; a discount (concession) changes what Mercer still owes, so it does.
  const ops: Op[] = [...(lock?.holder === e.effectKey ? [releaseLock(e.invoiceId, e.effectKey)] : []), ...(e.kind === 'ENABLE_PARTIAL' ? [] : [basisBumpOp(pk)])];
  const due = dueMinor(g.body);
  if (e.kind === 'ENABLE_PARTIAL') {
    ops.push(...actTo(a, 'APPLIED', { holdCode: null, heldReasons: [`PayPal invoice now accepts ${dollars(e.target.minimumMinor!)} (minimum) · verified`] }),
      audit(d, e, 'InvoiceUpdated', `Partial payment enabled on the same PayPal invoice: minimum ${dollars(e.target.minimumMinor!)}, ${dollars(due ?? 0)} due; no second invoice, no PayPal email`, allowedText(e.authority)));
  } else if (e.kind === 'APPLY_DISCOUNT') {
    const removeKey = updateKey(e.rootId, e.intentVersion, 'REMOVE_DISCOUNT');
    const conc = discountMinor(g.body);
    const rm = newUpdateEffect({ kind: 'REMOVE_DISCOUNT', tenantId: e.tenantId, runId: e.runId, epoch: e.epoch, invoiceId: e.invoiceId, ppInvoiceId: e.ppInvoiceId, actionId: e.actionId, rootId: e.rootId, intentVersion: e.intentVersion, target: { minimumMinor: null, percentBp: null, noteLine: e.target.noteLine }, now, notBefore: e.expiresAt, authority: e.authority });
    ops.push(...actTo(a, 'APPLIED', { holdCode: null, heldReasons: [], expiry: { state: 'SCHEDULED', at: e.expiresAt!, applyKey: e.effectKey, removeKey } }),
      { op: 'put', table: 'core', item: { pk, sk: `CONCESSION#${e.invoiceId}#${e.effectKey}`, invoiceId: e.invoiceId, applyKey: e.effectKey, amount: { currency: 'USD', minor: conc }, state: 'ACTIVE', appliedBy: e.effectKey, removedBy: null, settledBy: [] }, cond: { notExists: true } },
      { op: 'put', table: 'core', item: { pk, sk: `EXPIRY#${e.invoiceId}#${e.effectKey}`, invoiceId: e.invoiceId, applyKey: e.effectKey, at: e.expiresAt, removeKey, authority: e.authority, ownerRevisionId: a?.revisionId ?? null }, cond: { notExists: true } },
      { op: 'put', table: 'work', item: rm, cond: { notExists: true } }, executeJobOp(rm, e.expiresAt!),
      audit(d, e, 'OfferApplied', `${e.target.percentBp! / 100}% discount on PayPal (${dollars(conc)}): ${dollars(due ?? 0)} due · Headroom removes it ${e.expiresAt} · no PayPal email`, allowedText(e.authority)));
  } else {
    const concs = await d.store.query('core', pk, { skPrefix: `CONCESSION#${e.invoiceId}#` });
    for (const c of concs.filter((x) => x.state === 'ACTIVE')) ops.push({ op: 'update', table: 'core', pk, sk: c.sk, set: { state: 'REMOVED', removedBy: e.effectKey }, cond: { eq: { state: 'ACTIVE' } } });
    const open = due !== null && due > 0;
    if (a?.expiry) ops.push(actUpdate(a, { expiry: { ...a.expiry, state: 'REMOVED' }, ...(a.state === 'APPLIED' && open ? (assertTransition('Action', 'APPLIED', 'EXPIRED'), { state: 'EXPIRED' }) : {}) }));
    ops.push(audit(d, e, 'OfferExpired', `${note ?? 'Discount removed on PayPal at the end of the offer'}: ${dollars(due ?? 0)} due; nothing sent to Mercer`, allowedText(e.authority)));
  }
  // The message that follows a verified slice or discount (S5-D19 requiresEffect): its own due job, its own gates.
  if (e.kind !== 'REMOVE_DISCOUNT') ops.push(putJobOp(newJob(`due#${e.actionId}#${e.intentVersion}#MESSAGE#0`, 'ACTION_DUE', e.actionId, now, e.tenantId, e.runId)));
  // A receipt may have landed while this was in flight: progress runs again now (S5-D13).
  ops.push(putJobOp(newJob(`progress#${e.invoiceId}#upd#${e.effectKey}`, 'PLAN_PROGRESS', e.invoiceId, now, e.tenantId, e.runId)));
  // READY → VERIFIED_SUCCESS: verified without a write (the removal found the discount already gone in PayPal).
  await step(d, l, e, 'VERIFIED_SUCCESS', { set: { providerStatus: g.body?.status ?? null, ...(note ? { failure: null, note } : {}) }, ops, finish: { kind: 'done' } });
}
