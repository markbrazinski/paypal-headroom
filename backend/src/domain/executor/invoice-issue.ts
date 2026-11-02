// Invoice-issue effect executor (S01 T2.6–T2.12). Only this module calls the PayPal writer.
// Effect key = invoice number. UNKNOWN is reconciled with the same key; a new number is never minted.
import { leaseClaimOps } from '../demo/lease.ts';
import { assertTransition, PpInvoice, TERMINAL_EFFECT_STATES, type EffectRecord, type EffectState, type InvoiceMirror } from '@headroom/contracts';
import { K, basisBumpOp } from '../../adapters/store/keys.ts';
import { TxCancelled, type Op } from '../../adapters/store/port.ts';
import { CallRefused, NoResponse, type HttpResult } from '../../adapters/paypal/types.ts';
import type { Deps } from '../../deps.ts';
import { auditOp } from '../audit/audit.ts';
import { backoff, finishOp, leaseCheck, newJob, putJobOp, type Finish, type Lease } from '../../jobs/lease.ts';
import { classifyCreate, classifySend, ISSUED_PROVIDER_STATUSES, providerReason } from './classify.ts';
import { addMs, businessDate } from '../time.ts';
import { getRun } from '../identity-run/run.ts';

export type EffectItem = EffectRecord & { pk: string; sk: string };
type InvItem = InvoiceMirror & { pk: string; sk: string; tenantId: string; issuedAt?: string | null };

/** The worker lost its lease or died mid-step. The sweep will find the expired lease and reconcile. */
export class LeaseLost extends Error {}

const RECONCILE_RETRY_MS = 60_000;

async function load(d: Deps, key: string) {
  const eff = (await d.store.get('work', K.effect(key), 'EFFECT')) as EffectItem | undefined;
  if (!eff) throw new Error(`effect ${key} missing`);
  const inv = (await d.store.get('core', K.run(eff.tenantId, eff.runId), `INV#${eff.invoiceId}`)) as InvItem;
  return { eff, inv };
}

/** Move the effect checkpoint (and optionally the invoice) in one TX that also checks the lease. */
async function step(d: Deps, l: Lease, eff: EffectItem, to: EffectState, extra: { set?: Record<string, unknown>; ops?: Op[]; finish?: Finish } = {}) {
  assertTransition('Effect', eff.state, to);
  const ops: Op[] = [
    { op: 'update', table: 'work', pk: eff.pk, sk: 'EFFECT', set: { state: to, updatedAt: d.now(), ...extra.set }, cond: { eq: { state: eff.state } } },
    ...(extra.ops ?? []),
    extra.finish ? finishOp(l, extra.finish) : leaseCheck(l),
  ];
  try {
    await d.store.transact(ops);
  } catch (e) {
    if (e instanceof TxCancelled) throw new LeaseLost(`checkpoint ${eff.state} → ${to} refused`);
    throw e;
  }
  Object.assign(eff, { state: to, ...extra.set });
}

function invUpdate(inv: InvItem, set: Record<string, unknown>, to?: InvoiceMirror['state']): Op {
  if (to && to !== inv.state) assertTransition('Invoice', inv.state, to);
  return { op: 'update', table: 'core', pk: inv.pk, sk: inv.sk, set: { ...set, ...(to ? { state: to } : {}), version: inv.version + 1 }, cond: { eq: { version: inv.version } } };
}

const audit = (d: Deps, eff: EffectItem, type: Parameters<typeof auditOp>[0]['type'], result: string, refs: Record<string, string> = {}) =>
  auditOp({ tenantId: eff.tenantId, runId: eff.runId, type, by: 'HEADROOM', allowedBy: 'Owner: Issue on PayPal', result, refs: { effectKey: eff.effectKey, invoiceId: eff.invoiceId, ...refs }, correlationId: eff.effectKey, now: d.now() });

async function call(fn: () => Promise<HttpResult>): Promise<HttpResult | undefined> {
  try { return await fn(); } catch (e) { if (e instanceof NoResponse) return undefined; throw e; }
}

/** Record an ambiguous outcome: effect → UNKNOWN, invoice → ISSUE_UNKNOWN, job → RECONCILE_EFFECT with backoff. */
async function toUnknown(d: Deps, l: Lease, eff: EffectItem, inv: InvItem, reason: string) {
  const now = d.now();
  await step(d, l, eff, 'UNKNOWN', {
    ops: [invUpdate(inv, {}, inv.state === 'ISSUING' ? 'ISSUE_UNKNOWN' : undefined), basisBumpOp(inv.pk), audit(d, eff, 'EffectOutcomeUnknown', reason)],
    finish: { kind: 'requeue', at: backoff(now, l.job.attempts), type: 'RECONCILE_EFFECT', error: reason, unknownSince: now },
  });
}

async function fail(d: Deps, l: Lease, eff: EffectItem, inv: InvItem, reason: string, type: 'EffectRunFenced' | 'InvoiceIssueFailed') {
  await step(d, l, eff, 'VERIFIED_FAILURE', {
    set: { failureReason: reason },
    ops: [invUpdate(inv, { failureReason: reason }, 'FAILED'), basisBumpOp(inv.pk), audit(d, eff, type, reason)],
    finish: { kind: 'done' },
  });
}

/** EXECUTE_EFFECT job: READY → dispatch claim → create → send → verify. */
export async function executeInvoiceIssue(d: Deps, l: Lease): Promise<void> {
  if (!d.writer) throw new Error('executor constructed without a PayPal writer');
  const { eff, inv } = await load(d, l.job.ref);
  if (TERMINAL_EFFECT_STATES.includes(eff.state)) return d.store.transact([finishOp(l, { kind: 'done' })]);
  if (eff.state !== 'READY') return reconcileInvoiceIssue(d, l);

  // Budget/grant: wait in READY before the dispatch claim, never fail (S01 §6.6).
  const refusal = await budgetRefusal(d);
  if (refusal) {
    return d.store.transact([
      { op: 'update', table: 'work', pk: eff.pk, sk: 'EFFECT', set: { waitingReason: refusal }, cond: { eq: { state: 'READY' } } },
      finishOp(l, { kind: 'requeue', at: addMs(d.now(), 15 * 60_000), error: refusal, resetAttempts: true }),
    ]);
  }

  // Dispatch claim: the linearization point against reset (PR-04).
  try {
    assertTransition('Effect', 'READY', 'CREATE_DISPATCHED');
    await d.store.transact([
      { op: 'check', table: 'core', pk: K.tenant(eff.tenantId), sk: 'RUN_FENCE', cond: { eq: { epoch: eff.epoch } } },
      // S7 R2: on a leased merchant, only the lease holder's run may write to PayPal (and this claim serializes with a Start).
      ...(await leaseClaimOps(d.store, d.config.connectionId, eff.tenantId, eff.runId, d.now())),
      leaseCheck(l),
      { op: 'update', table: 'work', pk: eff.pk, sk: 'EFFECT', set: { state: 'CREATE_DISPATCHED', updatedAt: d.now(), waitingReason: null }, cond: { eq: { state: 'READY' } } },
      audit(d, eff, 'EffectDispatchClaimed', 'Dispatch claimed; creating on PayPal'),
    ]);
    eff.state = 'CREATE_DISPATCHED';
  } catch (e) {
    if (!(e instanceof TxCancelled)) throw e;
    if (e.failed[0]) return fail(d, l, eff, inv, 'Run was reset before this invoice was issued', 'EffectRunFenced');
    throw new LeaseLost('dispatch claim refused');
  }

  const run = await getRun(d.store, eff.tenantId, eff.runId);
  const cust = (await d.store.get('core', inv.pk, `CUST#${inv.customerId}`))!;
  const created = classifyCreate(await call(() => d.writer!.createInvoice({
    invoiceNumber: eff.effectKey,
    invoiceDate: businessDate(d.now(), run!.settings.timeZone),
    dueOn: inv.dueOn,
    amountMinor: inv.amount.minor,
    merchantEmail: d.config.merchantEmail,
    recipient: { name: cust.displayName, email: cust.billingEmail },
    itemName: 'Services',
    note: 'Headroom sandbox invoice. Not a real bill.',
  }, eff.effectKey)));
  await d.hooks?.afterCreate?.();

  if (created.kind === 'FAILURE') return fail(d, l, eff, inv, created.reason, 'InvoiceIssueFailed');
  if (created.kind === 'UNKNOWN') return toUnknown(d, l, eff, inv, created.reason);
  if (created.kind === 'DUPLICATE') return toUnknown(d, l, eff, inv, 'PayPal already has this invoice number; reconciling by number');
  await recordCreated(d, l, eff, created.ppInvoiceId);
  return sendAndVerify(d, l, eff);
}

async function recordCreated(d: Deps, l: Lease, eff: EffectItem, ppInvoiceId: string) {
  await step(d, l, eff, 'CREATED', {
    set: { ppInvoiceId },
    ops: [{ op: 'put', table: 'provider', item: { pk: K.ppInvoice(ppInvoiceId), sk: 'REF', tenantId: eff.tenantId, runId: eff.runId, epoch: eff.epoch, invoiceId: eff.invoiceId, invoiceNumber: eff.effectKey } }],
  });
}

async function sendAndVerify(d: Deps, l: Lease, eff: EffectItem) {
  await step(d, l, eff, 'SEND_DISPATCHED');
  const sent = classifySend(await call(() => d.writer!.sendInvoice(eff.ppInvoiceId!, `${eff.effectKey}:send`)));
  await d.hooks?.afterSend?.();
  if (sent.kind === 'UNKNOWN') return toUnknown(d, l, eff, (await load(d, eff.effectKey)).inv, sent.reason);
  if (sent.kind === 'CHECK_STATUS') {
    // A 4xx on send may mean it was already sent. Only the invoice's status decides.
    const g = await call(() => d.reader.getInvoice(eff.ppInvoiceId!));
    const status = g?.status === 200 ? PpInvoice.parse(g.body).status : null;
    if (status === 'DRAFT') return fail(d, l, eff, (await load(d, eff.effectKey)).inv, sent.reason, 'InvoiceIssueFailed');
    if (!status || !ISSUED_PROVIDER_STATUSES.includes(status)) return toUnknown(d, l, eff, (await load(d, eff.effectKey)).inv, `${sent.reason}; status ${status ?? 'unreadable'}`);
  }
  await step(d, l, eff, 'SENT');
  return verifyIssued(d, l, eff);
}

/** GET the invoice: UNPAID or later → VERIFIED_SUCCESS, ISSUED, and polling starts. A failed GET never fails the send. */
async function verifyIssued(d: Deps, l: Lease, eff: EffectItem) {
  const g = await call(() => d.reader.getInvoice(eff.ppInvoiceId!));
  const ok = g?.status === 200 ? PpInvoice.safeParse(g.body) : null;
  if (!ok?.success || !ISSUED_PROVIDER_STATUSES.includes(ok.data.status)) {
    return d.store.transact([finishOp(l, { kind: 'requeue', at: backoff(d.now(), l.job.attempts), type: 'RECONCILE_EFFECT', error: `Verify read failed (${g?.status ?? 'no response'})` })]);
  }
  await d.hooks?.beforeVerifyCommit?.();
  const { inv } = await load(d, eff.effectKey);
  const now = d.now();
  await step(d, l, eff, 'VERIFIED_SUCCESS', {
    ops: [
      invUpdate(inv, {
        ppInvoiceId: eff.ppInvoiceId, providerStatus: ok.data.status, payerUrl: ok.data.detail.metadata?.recipient_view_url ?? null,
        lastRawSha256: g!.rawSha256, lastCheckedAt: now, issuedAt: now,
      }, 'ISSUED'),
      basisBumpOp(inv.pk), // S4 §6.17 R1: an open invoice is a plan input
      audit(d, eff, 'InvoiceIssued', `Issued on PayPal (${ok.data.status}); not emailed`, { ppInvoiceId: eff.ppInvoiceId! }),
      putJobOp(newJob(`poll#${eff.invoiceId}`, 'POLL_INVOICE', eff.invoiceId, addMs(now, 60_000), eff.tenantId, eff.runId)),
    ],
    finish: { kind: 'done' },
  });
}

/**
 * RECONCILE_EFFECT job. Holds the lease, ignores the run fence (an effect past the dispatch claim
 * completes in the run that claimed it), and only definitive provider evidence moves it.
 */
export async function reconcileInvoiceIssue(d: Deps, l: Lease): Promise<void> {
  const { eff, inv } = await load(d, l.job.ref);
  if (TERMINAL_EFFECT_STATES.includes(eff.state)) return d.store.transact([finishOp(l, { kind: 'done' })]);
  const retry = (error: string) => d.store.transact([finishOp(l, { kind: 'requeue', at: addMs(d.now(), RECONCILE_RETRY_MS * Math.min(l.job.attempts, 15)), error })]);

  if (eff.state === 'READY') return executeInvoiceIssue(d, l);
  if (!eff.ppInvoiceId) {
    const found = await findByNumber(d, eff.effectKey);
    if (found === 'UNREADABLE') return retry('Search by number failed');
    if (found) {
      if (eff.state !== 'UNKNOWN' && eff.state !== 'CREATE_DISPATCHED') return retry(`unexpected state ${eff.state} without PayPal id`);
      if (eff.state === 'CREATE_DISPATCHED') await step(d, l, eff, 'UNKNOWN');
      await recordCreated(d, l, eff, found);
      await d.store.transact([audit(d, eff, 'EffectReconciled', `Found ${eff.effectKey} on PayPal by number`, { ppInvoiceId: found })]);
    } else {
      // Not on PayPal: replay the create with the SAME number. A duplicate leads back to a search.
      if (!d.writer) throw new Error('reconcile needs the writer to replay a create');
      const args = await createArgs(d, eff, inv);
      const created = classifyCreate(await call(() => d.writer!.createInvoice(args, eff.effectKey)));
      if (created.kind === 'FAILURE') return fail(d, l, eff, inv, created.reason, 'InvoiceIssueFailed');
      if (created.kind !== 'CREATED') return retry(created.kind === 'DUPLICATE' ? 'Duplicate number; search index lagging' : created.reason);
      if (eff.state === 'CREATE_DISPATCHED') await step(d, l, eff, 'UNKNOWN');
      await recordCreated(d, l, eff, created.ppInvoiceId);
    }
  }
  // PayPal id known: its status decides the next step.
  const g = await call(() => d.reader.getInvoice(eff.ppInvoiceId!));
  if (g?.status !== 200) return retry(`Invoice read failed (${g?.status ?? 'no response'})`);
  const status = PpInvoice.parse(g.body).status;
  if (status === 'DRAFT') {
    if (eff.state === 'UNKNOWN') await step(d, l, eff, 'CREATED');
    if (eff.state === 'SEND_DISPATCHED' || eff.state === 'SENT') await step(d, l, eff, 'UNKNOWN').then(() => step(d, l, eff, 'CREATED'));
    if (!d.writer) throw new Error('reconcile needs the writer to send');
    return sendAndVerify(d, l, eff);
  }
  if (ISSUED_PROVIDER_STATUSES.includes(status)) {
    if (eff.state !== 'SENT') { if (eff.state !== 'UNKNOWN') await step(d, l, eff, 'UNKNOWN'); await step(d, l, eff, 'SENT'); }
    return verifyIssued(d, l, eff);
  }
  if (eff.state !== 'UNKNOWN') await step(d, l, eff, 'UNKNOWN');
  return fail(d, l, eff, (await load(d, eff.effectKey)).inv, `PayPal invoice is ${status}`, 'InvoiceIssueFailed');
}

async function createArgs(d: Deps, eff: EffectItem, inv: InvItem) {
  const run = await getRun(d.store, eff.tenantId, eff.runId);
  const cust = (await d.store.get('core', inv.pk, `CUST#${inv.customerId}`))!;
  return {
    invoiceNumber: eff.effectKey, invoiceDate: businessDate(d.now(), run!.settings.timeZone), dueOn: inv.dueOn, amountMinor: inv.amount.minor,
    merchantEmail: d.config.merchantEmail, recipient: { name: cust.displayName, email: cust.billingEmail }, itemName: 'Services',
    note: 'Headroom sandbox invoice. Not a real bill.',
  };
}

async function findByNumber(d: Deps, number: string): Promise<string | null | 'UNREADABLE'> {
  const r = await call(() => d.reader.searchInvoiceByNumber(number));
  if (r?.status !== 200) return 'UNREADABLE';
  const hit = ((r.body?.items ?? []) as any[]).find((i) => i?.detail?.invoice_number === number);
  return hit?.id ?? null;
}

async function budgetRefusal(d: Deps): Promise<string | null> {
  const g = d.config.grant;
  if (!g) return 'Waiting: no PayPal grant configured';
  if (d.now() > g.expiresAt) return `Waiting: PayPal grant ${g.id} ended`;
  const c = await d.store.get('work', K.counter(g.id), 'COUNTER');
  if ((c?.creates ?? 0) >= g.budgets.creates || (c?.sends ?? 0) >= g.budgets.sends || (c?.reads ?? 0) + 4 > g.budgets.reads) return 'Waiting: PayPal call budget reached';
  return null;
}

export { CallRefused };
