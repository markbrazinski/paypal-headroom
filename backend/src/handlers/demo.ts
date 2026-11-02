// The demo lane (S07 §6.18 R10), served by the operator Lambda behind the same Cognito JWT authorizer; role only from the verified
// groups claim (http-event roleOf). `/v1/demo/*`: judges on their own leased run, and the operator. `/v1/operator/*`: operator only.
// Owners (no group) get 403 here. A judge watching the showcase may only switch back or Start. No control sets a financial state:
// payments go through the payer (receipts from PayPal's GETs), payouts through the S6 executor, the clock only pulls due work forward.
import { randomUUID } from 'node:crypto';
import { routes, type DemoRun } from '@headroom/contracts';
import type { z } from 'zod';
import { K } from '../adapters/store/keys.ts';
import { ApiError } from '../api-error.ts';
import type { Deps } from '../deps.ts';
import type { Item } from '../adapters/store/port.ts';
import { activeRun, connectionFor, getFence, type RunItem } from '../domain/identity-run/run.ts';
import { leaseOf, unresolvedOf, expiresAt, leaseExpired } from '../domain/demo/lease.ts';
import { requestStart, RESET_STATES_DONE, type ResetRecord } from '../domain/demo/reset.ts';
import { collectible, LIVE_PHASES, requestCollection, type PayerAttempt } from '../domain/demo/payer.ts';
import { advanceClock, clockOf, pendingSteps } from '../domain/demo/clock.ts';
import { billPdf } from '../domain/demo/bill-pdf.ts';
import { bumpLive, liveOf, takeLive } from '../domain/demo/live.ts';
import { businessDate } from '../domain/time.ts';
import { SHOWCASE_TENANT, type Req, type Res } from './router.ts';

type Role = 'OWNER' | 'JUDGE' | 'OPERATOR';
const lane = (Object.entries(routes) as [string, (typeof routes)[keyof typeof routes] & { lane?: string }][]).filter(([, r]) => r.lane)
  .map(([op, r]) => ({ op, r, re: new RegExp(`^${r.path.replace(/\{[^}]+\}/g, '[^/]+')}$`) }));
const json = (status: number, body: unknown): Res => ({ status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(body) });
const dollars = (m: number) => ({ currency: 'USD' as const, minor: m });

export const isDemoPath = (path: string) => path.startsWith('/v1/demo/') || path.startsWith('/v1/operator/');

export async function handleDemo(d: Deps, req: Req): Promise<Res> {
  const correlationId = req.headers['x-correlation-id'] ?? randomUUID();
  try {
    const m = lane.find((x) => x.r.method === req.method && x.re.test(req.path));
    if (!m) throw new ApiError(404, 'NOT_FOUND', 'No such route');
    if (!req.identity) throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in required');
    const role: Role = req.identity.role ?? 'OWNER';
    if (role === 'OWNER' || (m.r.lane === 'operator' && role !== 'OPERATOR')) throw new ApiError(403, 'FORBIDDEN_ROLE', m.r.lane === 'operator' ? 'Operator only' : 'Sandbox controls are for judges and the operator');
    const user = (await d.store.get('core', K.user(req.identity.sub), 'TENANT')) as { tenantId: string; view?: 'MY_RUN' | 'SHOWCASE' } | undefined;
    if (!user) throw new ApiError(401, 'UNAUTHENTICATED', 'No business is set up for this sign-in');
    const view = role === 'JUDGE' && user.view === 'SHOWCASE' ? 'SHOWCASE' as const : 'MY_RUN' as const;
    const body = req.method === 'POST' ? parse((m.r as { body?: z.ZodType }).body, req.body) : undefined;
    // R10: from the showcase only the two exits work; every other demo write is read-only.
    if (view === 'SHOWCASE' && req.method === 'POST' && !['setDemoView', 'startDemoRun'].includes(m.op)) throw new ApiError(403, 'READ_ONLY', 'You are watching the showcase run: switch back to your own run first');
    const tenantId = m.op === 'startDemoRun' && role === 'OPERATOR' && (body as { tenantId?: string })?.tenantId ? (body as { tenantId: string }).tenantId : view === 'SHOWCASE' ? SHOWCASE_TENANT : user.tenantId;
    const run = await activeRun(d.store, tenantId);
    const lease = await leaseOf(d.store, d.config.connectionId);
    // Judges share the live business (live.ts): a judge holds the run only as the lease's own holder.
    const holds = !!lease?.leased && lease.tenantId === tenantId && !!run && lease.runId === run.runId && (role === 'OPERATOR' || lease.holderSub === req.identity.sub);
    const needLease = () => { if (role !== 'OPERATOR' && !holds) throw new ApiError(409, 'MERCHANT_LEASED', 'Start a run first: this run doesn’t hold the sandbox merchant'); if (!run) throw new ApiError(409, 'RUN_SEALED', 'No active run'); return run; };
    const out = await (async (): Promise<[number, unknown]> => {
      switch (m.op) {
        case 'getDemoRun': {
          if (holds) await bumpLive(d, req.identity!.sub);
          return [200, { ...(await demoRun(d, { role, view, tenantId, run, holds })), live: await liveOf(d, tenantId, req.identity!.sub) }];
        }
        case 'takeLiveRun': {
          if (role !== 'JUDGE') throw new ApiError(403, 'FORBIDDEN_ROLE', 'The live run is for judges');
          if (user.view === 'SHOWCASE') await d.store.transact([{ op: 'update', table: 'core', pk: K.user(req.identity!.sub), sk: 'TENANT', set: { view: 'MY_RUN' } }]);
          const t = await takeLive(d, user.tenantId, req.identity!.sub);
          if (!t.ok) throw new ApiError(409, t.code, t.text);
          return [200, { ok: true }];
        }
        case 'getDemoEffects': return [200, { rows: run ? await effects(d, run) : [] }];
        case 'setDemoView': {
          if (role !== 'JUDGE') throw new ApiError(403, 'FORBIDDEN_ROLE', 'Only judges switch views');
          const v = (body as { view: 'MY_RUN' | 'SHOWCASE' }).view;
          await d.store.transact([{ op: 'update', table: 'core', pk: K.user(req.identity!.sub), sk: 'TENANT', set: { view: v } }]);
          return [200, { view: v }];
        }
        case 'startDemoRun': {
          if (role === 'JUDGE' && view === 'SHOWCASE') await d.store.transact([{ op: 'update', table: 'core', pk: K.user(req.identity!.sub), sk: 'TENANT', set: { view: 'MY_RUN' } }]);
          const s = await requestStart(d, { tenantId: role === 'JUDGE' ? user.tenantId : tenantId, holderSub: req.identity!.sub, reason: role === 'JUDGE' ? 'Judge: start a new run' : 'Operator: reset', dispute: (body as { dispute?: 'SEEDED' | 'EMAIL' }).dispute });
          if (!s.ok) throw new ApiError(409, s.code, s.until ? `${s.text} until about ${s.until}` : s.text);
          return [202, { resetKey: s.resetKey }];
        }
        case 'endDemoRun':
        case 'operatorRelease': {
          if (m.op === 'endDemoRun' && !holds && lease?.holderSub !== req.identity!.sub) throw new ApiError(409, 'MERCHANT_LEASED', 'You don’t hold the merchant');
          // P2-2: never release under a reset that is still moving money or seeding.
          const rs = lease?.resetSk ? ((await d.store.get('provider', K.conn(d.config.connectionId), lease.resetSk)) as ResetRecord | undefined) : undefined;
          if (rs && !RESET_STATES_DONE.includes(rs.state)) throw new ApiError(409, 'RESET_IN_PROGRESS', `A fresh start is in progress (${rs.state.toLowerCase().replace('_', ' ')}); wait for it to finish`);
          const open = lease?.tenantId && lease.runId ? await unresolvedOf(d.store, lease.tenantId, lease.runId) : [];
          if (open.length) throw new ApiError(409, 'PREVIOUS_RUN_UNRESOLVED', `PayPal work is still in flight: ${open.join('; ')}`);
          if (!lease?.leased || !lease.tenantId) return [200, { released: false }];
          await d.store.transact([{ op: 'update', table: 'provider', pk: K.conn(d.config.connectionId), sk: 'TENANT', set: { tenantId: null, runId: null, holderSub: null, version: (lease.version ?? 0) + 1 }, cond: { eq: { version: lease.version, claims: lease.claims ?? 0 } } },
            { op: 'put', table: 'core', item: { pk: K.tenant(lease.tenantId), sk: 'CONN#paypal', connectionId: null, leaseMovedAt: d.now() } }]);
          return [200, { released: true }];
        }
        case 'demoBill': {
          const r = needLease();
          const { operatorInjectBill } = await import('./operator.ts');
          const inj = await operatorInjectBill(d, r.tenantId, { action: 'injectBill', tenantId: r.tenantId, fileName: 'K-2207.pdf', contentBase64: billPdf('hero', businessDate(r.createdAt, r.settings.timeZone)).toString('base64'), reason: 'Demo: Keller’s bill arrives' } as never);
          return [202, { billId: (inj as { billId?: string }).billId ?? '' }];
        }
        case 'demoCollect': {
          const r = needLease();
          const a = await requestCollection(d, { tenantId: r.tenantId, runId: r.runId, epoch: r.epoch, actionId: (body as { actionId: string }).actionId });
          return [202, { attemptId: a.attemptId, phase: a.phase }];
        }
        case 'goldenMail': {
          if (role !== 'OPERATOR') throw new ApiError(403, 'FORBIDDEN_ROLE', 'Only the operator sends sample emails');
          const { requestGoldenMail } = await import('../domain/demo/golden-mail.ts');
          const r = await requestGoldenMail(d, user.tenantId, (body as { messages: { preparedFor: string; subject: string; text: string }[] }).messages);
          if ('refused' in r) throw new ApiError(409, 'HARD_STOP', r.refused);
          return [202, r];
        }
        case 'getGoldenMail': {
          if (role !== 'OPERATOR') throw new ApiError(403, 'FORBIDDEN_ROLE', 'Operator only');
          const { goldenMailStatus } = await import('../domain/demo/golden-mail.ts');
          const s = await goldenMailStatus(d, user.tenantId, req.path.split('/').pop()!);
          if (!s) throw new ApiError(404, 'NOT_FOUND', 'No such sample send');
          return [200, s];
        }
        case 'demoKellerReply': {
          const r = needLease();
          const { requestKellerReply } = await import('../domain/demo/fixture-mail.ts');
          if (!(await requestKellerReply(d, r.tenantId, r.runId))) throw new ApiError(404, 'NOT_FOUND', 'Headroom hasn’t asked Keller yet (include the Keller ask in the plan and approve it)');
          return [202, { queued: true }];
        }
        case 'demoAdvance': {
          const res = await advanceClock(d, needLease());
          if (!res) throw new ApiError(404, 'NOT_FOUND', 'Nothing is scheduled after now');
          return [200, res];
        }
        case 'demoReconcile': {
          const r = needLease();
          const { reconcileInvoice } = await import('../domain/paypal-mirror/reconcile-invoice.ts');
          const { observeBalance } = await import('../domain/paypal-mirror/observe-balance.ts');
          const invs = (await d.store.query('core', r.pk, { skPrefix: 'INV#' })).filter((i) => i.ppInvoiceId && ['ISSUED', 'PARTIALLY_PAID', 'PAID'].includes(i.state));
          for (const i of invs) await reconcileInvoice(d, { tenantId: r.tenantId, runId: r.runId, invoiceId: i.invoiceId }, 'REFRESH').catch(() => undefined);
          await observeBalance(d).catch(() => undefined);
          return [202, { queued: invs.length }];
        }
      }
      throw new ApiError(404, 'NOT_FOUND', 'No such route');
    })();
    return json(out[0], out[1]);
  } catch (e) {
    if (e instanceof ApiError) return json(e.status, { code: e.code, outcome: 'NOT_APPLIED', message: e.message, correlationId, ...(e.details ? { details: e.details } : {}) });
    console.error(JSON.stringify({ level: 'error', correlationId, error: String((e as Error).stack ?? e) }));
    return json(500, { code: 'INTERNAL', outcome: 'UNKNOWN', message: 'Something went wrong', correlationId });
  }
}

function parse(schema: z.ZodType | undefined, raw: string | undefined): unknown {
  if (!schema) return {};
  let v: unknown;
  try { v = raw ? JSON.parse(raw) : {}; } catch { throw new ApiError(400, 'INVALID_INPUT', 'Body is not JSON'); }
  const p = schema.safeParse(v);
  if (!p.success) throw new ApiError(400, 'INVALID_INPUT', 'Invalid body', p.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  return p.data;
}

/** O7 `demo:collect` over the operator's direct invoke (IAM, no HTTP): the drawer's view of a tenant's run, as the operator sees it. */
export async function operatorDemoRun(d: Deps, tenantId: string) {
  const run = await activeRun(d.store, tenantId);
  const lease = await leaseOf(d.store, d.config.connectionId);
  return demoRun(d, { role: 'OPERATOR', view: 'MY_RUN', tenantId, run, holds: !!lease?.leased && lease.tenantId === tenantId && !!run && lease.runId === run.runId });
}

async function demoRun(d: Deps, x: { role: Role; view: 'MY_RUN' | 'SHOWCASE'; tenantId: string; run: RunItem | undefined; holds: boolean }): Promise<z.infer<typeof DemoRun>> {
  const now = d.now();
  const lease = await leaseOf(d.store, d.config.connectionId);
  const rec = lease?.resetSk ? ((await d.store.get('provider', K.conn(d.config.connectionId), lease.resetSk)) as ResetRecord | undefined) : undefined;
  const mineReset = rec && rec.tenantId === x.tenantId ? rec : undefined;
  const busyOther = !!lease?.leased && !!lease.tenantId && lease.tenantId !== x.tenantId && !leaseExpired(lease, now);
  const pk = x.run ? K.run(x.run.tenantId, x.run.runId) : null;
  const plan = pk ? await d.store.get('core', pk, 'PLAN') : undefined;
  const acts = pk ? (await d.store.query('core', pk, { skPrefix: 'ACT#' })).filter((a) => a.revisionId === plan?.running && ['COLLECT_OVERDUE', 'COLLECT_UNDISPUTED_SLICE', 'COLLECT_DISPUTED', 'DISCOUNT_FALLBACK'].includes(a.kind) && a.decision === 'IN') : [];
  const attempts = pk ? ((await d.store.query('core', pk, { skPrefix: 'PAYER#' })) as unknown as PayerAttempt[]) : [];
  const collections = [];
  for (const a of acts) {
    const c = await collectible(d, x.run!.tenantId, x.run!.runId, a.actionId);
    const last = attempts.filter((p) => p.actionId === a.actionId).sort((p, q) => q.n - p.n)[0];
    const inv = await d.store.get('core', pk!, `INV#${a.subject.invoiceId}`);
    collections.push({
      actionId: a.actionId, counterparty: a.counterparty.name, amount: dollars(c.ok ? c.amountMinor : a.terms.amount.minor), payerUrl: inv?.payerUrl ?? null,
      canPay: c.ok && x.view === 'MY_RUN' && (x.holds || (x.role === 'OPERATOR' && !lease?.leased)) && !(last && LIVE_PHASES.includes(last.phase)), why: c.ok ? null : c.why,
      attempt: last ? { phase: last.phase, text: last.text, captureId: last.captureId, at: last.at } : null,
    });
  }
  const steps = x.run ? await pendingSteps(d, x.run, now) : [];
  const fence = await getFence(d.store, x.tenantId);
  const drives = x.view === 'MY_RUN' && x.run?.state === 'READY' && (x.holds || (x.role === 'OPERATOR' && !lease?.leased));
  const journey = drives ? await journeyOf(d, pk!, plan, collections, steps[0]) : null;
  return {
    role: x.role, view: x.view, tenantLabel: x.view === 'SHOWCASE' ? 'Showcase run (finished · read-only)' : x.role === 'OPERATOR' ? `Tenant ${x.tenantId}` : 'Your run',
    run: x.run ? { runId: x.run.runId, state: x.run.state, blockers: x.run.blockers ?? [], epoch: fence?.epoch ?? x.run.epoch } : null,
    lease: { mine: x.holds, held: busyOther, until: lease?.leased && lease.tenantId ? expiresAt(lease) : null },
    reset: mineReset ? {
      resetKey: mineReset.resetKey, state: mineReset.state, waiting: mineReset.waiting, blocker: mineReset.blocker, landing: mineReset.landingMinor === null ? null : dollars(mineReset.landingMinor),
      housekeeping: mineReset.hk.map((h) => ({ n: h.n, amount: dollars(h.amountMinor), state: h.state, itemId: h.itemId, fee: h.feeMinor === null ? null : dollars(h.feeMinor) })), timeline: mineReset.timeline.slice(-8),
    } : null,
    clock: { virtualNow: x.run ? clockOf(x.run).virtualNow : null, next: steps[0] ? { at: steps[0].at, label: steps[0].label } : null },
    collections,
    journey,
    canStart: x.view === 'SHOWCASE' || (!busyOther && !(rec && !RESET_STATES_DONE.includes(rec.state))),
    startBlocked: busyOther ? `In use by another run until about ${expiresAt(lease!)}` : rec && !RESET_STATES_DONE.includes(rec.state) ? 'A reset is running' : null,
  };
}

/**
 * The dock's beat for a live run, from the run's own records, and the one control that moves it on. Beats in order: bill in and plan
 * drafted · approved · asks sent · first receipt · second receipt · Mercer skipped · Keller paid (a paid Keller is the last beat whatever
 * happened to Mercer). Next is the first that applies: bill, approve, a customer paying, the next scheduled step, or wait for PayPal.
 */
async function journeyOf(d: Deps, pk: string, plan: Item | undefined, collections: { actionId: string; counterparty: string; canPay: boolean; attempt: ({ phase: string } & Record<string, unknown>) | null }[], due: { label: string } | undefined) {
  const items = await d.store.query('core', pk);
  const of = (p: string) => items.filter((i) => i.sk.startsWith(p));
  const kellerPaid = of('OBL#').some((o) => o.state === 'PAID');
  const paying = of('OBL#').find((o) => o.payment && o.state !== 'PAID');
  const mercer = of('ACT#').find((a) => a.kind === 'DISCOUNT_FALLBACK' && a.revisionId === plan?.running);
  const receipts = of('RCPT#').length;
  const reached = [of('BILL#').length > 0 && !!(plan?.draft || plan?.running), !!plan?.running, of('OUTMSG#').some((m) => m.state === 'SENT' && m.counterpartyRole === 'CUSTOMER'), receipts >= 1, receipts >= 2, mercer?.state === 'SKIPPED_NOT_NEEDED'];
  const step = kellerPaid ? 7 : (i => (i < 0 ? reached.length : i))(reached.findIndex((r) => !r));
  const collecting = collections.find((c) => c.attempt && (LIVE_PHASES as string[]).includes(c.attempt.phase));
  const pay = collections.find((c) => c.canPay);
  // A fresh run's Keller payee is unconfirmed until the owner checks it (S6-D1): the payout needs that, then its approval.
  const payout = of('ACT#').find((a) => a.kind === 'PAYOUT' && a.state === 'PROPOSED' && [plan?.draft, plan?.running].includes(a.revisionId));
  const payeeOpen = !!payout && of('PAYEE#').some((p) => p.state !== 'CONFIRMED');
  // Due but held (e.g. PayPal hasn't released today's customer payments): the demo clock can't speed PayPal up, so the dock waits and says why.
  const held = of('ACT#').find((a) => a.kind === 'PAYOUT' && a.revisionId === plan?.running && String(a.state).startsWith('HELD'));
  type Next = { kind: 'BILL' | 'CONFIRM_PAYEE' | 'APPROVE' | 'PAY' | 'ADVANCE' | 'WAIT' | 'DONE'; label: string; actionId: string | null };
  const confirm: Next = { kind: 'CONFIRM_PAYEE', label: `Confirm ${payout?.counterparty?.name ?? 'the supplier'}’s PayPal address`, actionId: payout?.actionId ?? null };
  const next: Next = kellerPaid ? { kind: 'DONE', label: 'Done: Keller is paid', actionId: null }
    : !of('BILL#').length ? { kind: 'BILL', label: 'Bring in Keller’s bill', actionId: null }
    : !plan?.running && !plan?.draft ? { kind: 'WAIT', label: 'Headroom is reading the bill and building the plan…', actionId: null }
    : !plan?.running ? (payeeOpen ? confirm : { kind: 'APPROVE', label: 'Approve the plan', actionId: null })
    : collecting ? { kind: 'WAIT', label: `${collecting.counterparty} is paying on PayPal…`, actionId: null }
    : pay ? { kind: 'PAY', label: `${pay.counterparty} pays on PayPal`, actionId: pay.actionId }
    : payeeOpen ? confirm
    : payout ? { kind: 'APPROVE', label: `Approve the payment to ${payout.counterparty?.name ?? 'the supplier'}`, actionId: payout.actionId }
    : held ? { kind: 'WAIT', label: held.heldReasons?.[0] ?? 'PayPal is holding the payment for now', actionId: held.actionId }
    : due ? { kind: 'ADVANCE', label: due.label, actionId: null }
    : paying ? { kind: 'WAIT', label: `Paying ${paying.counterparty?.name ?? 'the supplier'} through PayPal: it goes once PayPal’s own balance can fund it`, actionId: null }
    : { kind: 'WAIT', label: 'Waiting for PayPal to confirm', actionId: null };
  return { step, next };
}

/** S7-D19: every provider effect of the run with its PayPal ids and times (read-only; sandbox ids are shown). */
async function effects(d: Deps, run: RunItem) {
  const items = await d.store.query('core', K.run(run.tenantId, run.runId));
  const rows = [];
  for (const i of items) {
    if (i.sk.startsWith('INV#')) rows.push({ key: i.invoiceNumber ?? i.invoiceId, kind: 'INVOICE', state: i.state, providerIds: [i.ppInvoiceId].filter(Boolean), at: i.lastCheckedAt ?? i.issuedAt ?? null, detail: i.providerStatus ?? null, label: null });
    if (i.sk.startsWith('RCPT#')) rows.push({ key: i.captureId, kind: 'CAPTURE', state: i.captureStatus, providerIds: [i.captureId, i.ppInvoiceId], at: i.capturedAt, detail: `gross ${i.gross.minor / 100} · fee ${i.fee.minor / 100} · net ${i.net.minor / 100} · retrieved ${i.retrievedAt}`, label: null });
    if (i.sk.startsWith('PAYER#')) rows.push({ key: i.attemptId, kind: 'PAYER', state: i.phase, providerIds: [i.captureId].filter(Boolean), at: i.at, detail: i.text, label: 'AUTOMATED-PAYER' });
    if (i.sk.startsWith('OUTMSG#')) rows.push({ key: i.rfcMessageId || i.sk, kind: 'MESSAGE', state: i.state, providerIds: [i.sentMessageId].filter(Boolean), at: i.updatedAt, detail: i.preparedFor ? `test inbox · prepared for ${i.preparedFor}` : i.to, label: i.channel });
    if (i.sk.startsWith('OBL#') && i.payment) {
      const e = await d.store.get('work', K.effect(i.payment.effectKey), 'EFFECT');
      rows.push({ key: i.payment.effectKey, kind: 'PAYOUT', state: e?.state ?? i.payment.stage, providerIds: [e?.senderBatchId, e?.batchId, e?.itemId, e?.transactionId].filter(Boolean), at: e?.updatedAt ?? null, detail: e?.heldReason ?? null, label: null });
    }
  }
  const l = await leaseOf(d.store, d.config.connectionId);
  const rec = l?.resetSk ? ((await d.store.get('provider', K.conn(d.config.connectionId), l.resetSk)) as ResetRecord | undefined) : undefined;
  if (rec?.runId === run.runId) for (const h of rec.hk) rows.push({ key: h.senderBatchId, kind: 'HOUSEKEEPING_PAYOUT', state: h.state, providerIds: [h.batchId, h.itemId, h.transactionId].filter(Boolean) as string[], at: rec.updatedAt, detail: `${h.amountMinor / 100}${h.feeMinor !== null ? ` + fee ${h.feeMinor / 100}` : ''} to the registered sandbox receiver`, label: 'HOUSEKEEPING' });
  const routed = await d.store.query('audit', K.run(run.tenantId, run.runId), { newestFirst: true, limit: 200 });
  for (const a of routed.filter((x) => x.eventType === 'OldRunEventRouted')) rows.push({ key: a.eventId, kind: 'OLD_RUN_EVENT', state: 'ROUTED', providerIds: [], at: a.occurredAt, detail: a.result, label: null });
  void connectionFor;
  return rows.sort((a, z) => String(z.at ?? '').localeCompare(String(a.at ?? '')));
}
