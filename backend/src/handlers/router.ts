// One router for local node:http and the API Lambda. Identity arrives verified (API Gateway JWT authorizer,
// or the fixed local identity in STAGE=local only); the tenant comes from the server USER# lookup, never the body.
import { createHash, randomUUID } from 'node:crypto';
import { routes, type OperationId } from '@headroom/contracts';
import { K } from '../adapters/store/keys.ts';
import { TxCancelled } from '../adapters/store/port.ts';
import type { Queue } from '../adapters/queue/port.ts';
import type { Store } from '../adapters/store/port.ts';
import type { Config } from '../deps.ts';
import { ApiError } from '../api-error.ts';
import { activeRun, connectionFor, getFence, tenantForUser } from '../domain/identity-run/run.ts';
import { createInvoiceDraft, loadInvoice, sendInvoice, type CommandResult } from '../domain/receivables/commands.ts';
import * as read from '../read/models.ts';
import { newJob, requestRun } from '../jobs/lease.ts';
import { ingestWebhook } from '../domain/paypal-mirror/webhook.ts';
import type { PlaidLinkTokenClient } from '../adapters/plaid/clients.ts';
import type { Vault } from '../adapters/vault.ts';
import { abandonConnect, claimConnect, createLinkToken, disconnectBank, refreshTarget, syncJobId } from '../domain/bank-mirror/connect.ts';
import type { EvidenceStore } from '../adapters/evidence-store/port.ts';
import { ingestCommand } from '../domain/evidence/ingest.ts';
import { acceptBillTerms, addBillAsObligation, createCommitment, retryBill, verifyBill } from '../domain/obligations/commands.ts';
import { requestBuild } from '../domain/plan/build.ts';
import { approveRevision, editRevision, rejectRevision, revokeGrant } from '../domain/plan/commands.ts';
import { changePolicy, previewPolicyChange, setPause } from '../domain/delegation/commands.ts';
import * as s4 from '../read/s4.ts';
import { acceptPromise, answerMatch, decideFallback, holdMessage, sendNow, setThreadOwner } from '../domain/comms/commands.ts';

/** `query`: the URL's query parameters (S4 forecast scenario/compare); both transports pass them. */
export interface Req { method: string; path: string; query?: Record<string, string>; headers: Record<string, string | undefined>; body: string | undefined; identity: { sub: string; email: string; role?: 'OWNER' | 'JUDGE' | 'OPERATOR' } | null }
/** S7-D12: the operator's finished hero run that judges without the lease may watch, read-only. */
export const SHOWCASE_TENANT = 'tenant-showcase';
export interface Res { status: number; headers: Record<string, string>; body: string }

/** `plaidLink` + `vault`: the API's only Plaid capability is a link token; it never exchanges or removes (S2-D3). */
/** `evidence`: S3 original documents (upload writes, the document view reads). */
export interface RouterDeps { store: Store; queue: Queue; config: Config; now: () => string; plaidLink?: PlaidLinkTokenClient; vault?: Vault; evidence?: EvidenceStore }

const compiled = (Object.entries(routes) as [OperationId, (typeof routes)[OperationId]][]).map(([op, r]) => ({
  op, r, re: new RegExp(`^${r.path.replace(/\{(\w+)\}/g, '(?<$1>[^/]+)')}$`),
}));

const json = (status: number, body: unknown, extra: Record<string, string> = {}): Res => ({ status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra }, body: JSON.stringify(body) });

export async function handle(d: RouterDeps, req: Req): Promise<Res> {
  const correlationId = req.headers['x-correlation-id'] ?? randomUUID();
  try {
    const m = compiled.map((c) => ({ ...c, match: c.r.method === req.method ? c.re.exec(req.path) : null })).find((c) => c.match);
    if (!m) throw new ApiError(404, 'NOT_FOUND', 'No such route');
    const params = m.match!.groups ?? {};
    if (m.op === 'paypalWebhook') {
      const r = await ingestWebhook(d.store, d.queue, req.body ?? '', req.headers, d.now());
      return json(r.status, r.status === 200 ? { ok: true } : { ok: false });
    }
    if (!req.identity) throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in required');
    // S7 R10: demo and operator routes are the operator Lambda's; this Lambda never serves them.
    if ((m.r as { lane?: string }).lane) throw new ApiError(404, 'NOT_FOUND', 'No such route');
    const user = (await tenantForUser(d.store, req.identity.sub)) as { tenantId: string; email: string; view?: 'MY_RUN' | 'SHOWCASE' } | undefined;
    if (!user) throw new ApiError(401, 'UNAUTHENTICATED', 'No business is set up for this sign-in');
    // S7-D12/R10: a judge watching the showcase reads the showcase tenant; every write there is refused.
    const view = req.identity.role === 'JUDGE' && user.view === 'SHOWCASE' ? 'SHOWCASE' as const : 'MY_RUN' as const;
    if (view === 'SHOWCASE' && m.r.method !== 'GET') throw new ApiError(403, 'READ_ONLY', 'You are watching the finished showcase run: it is read-only. Switch back to your own run to act');
    const binding = { ...user, tenantId: view === 'SHOWCASE' ? SHOWCASE_TENANT : user.tenantId };
    const run = await activeRun(d.store, binding.tenantId);
    if (!run) throw new ApiError(409, 'RUN_SEALED', 'No active run; ask the operator to reset');
    // S7 R1: a demo Start seals the current run at once (fence epoch moves on); it stays readable until the fresh run replaces it.
    if (m.r.method !== 'GET' && (await getFence(d.store, binding.tenantId))?.epoch !== run.epoch) throw new ApiError(409, 'RUN_SEALED', 'A fresh run is being prepared: this run is read-only now');
    const now = d.now();
    const ctx: read.ReadCtx = { store: d.store, config: d.config, tenantId: binding.tenantId, run, connectionId: await connectionFor(d.store, binding.tenantId), email: req.identity.email, now, evidence: d.evidence, role: req.identity.role ?? 'OWNER', view };
    // ponytail: one PayPal connection per deployment. Only the tenant bound to it may cause PayPal calls (S1-IR-01).
    if (['sendInvoice', 'refreshInvoice', 'refreshPayPalBalance'].includes(m.op) && ctx.connectionId !== d.config.connectionId)
      throw new ApiError(409, 'NOT_CONNECTED', 'PayPal is not connected for this business');
    const expectedRun = req.headers['x-headroom-run'];
    if (m.r.method === 'POST' && expectedRun && expectedRun !== run.runId) throw new ApiError(409, 'RUN_SEALED', `Run ${expectedRun} was sealed; reload`);

    let body: unknown;
    let status: number = m.r.status;
    switch (m.op) {
      case 'getSession': body = { ...(await read.getSession(ctx)), notice: await s4.noticeOf(ctx) }; break;
      case 'getOverview': body = await s4.getOverview(ctx); break;
      case 'getCashPosition': body = await read.getCashPosition(ctx); break;
      case 'listReceivables': body = await read.listReceivables(ctx); break;
      case 'getActivity': body = { rows: await read.activityRows(ctx) }; break;
      case 'getInvoice': body = await read.getInvoice(ctx, await loadInvoiceForRead(ctx, params.id)); break;
      case 'getForecast': {
        const q = routes.getForecast.query.safeParse(req.query ?? {});
        if (!q.success) throw new ApiError(400, 'INVALID_INPUT', 'scenario must be EXPECTED, IDEAL or DOWNSIDE', q.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
        body = await s4.getForecast(ctx, q.data);
        break;
      }
      case 'getPlan': body = await s4.getPlan(ctx); break;
      case 'getRevision': body = await s4.getRevision(ctx, params.id); break;
      case 'getDelegation': body = await s4.getDelegation(ctx); break;
      case 'listRelationships': body = await s4.listRelationships(ctx); break;
      case 'getRelationship': body = await s4.getRelationship(ctx, params.id); break;
      case 'previewPolicyChange': {
        const p = routes.previewPolicyChange.body.safeParse(parseJson(req.body));
        if (!p.success) throw new ApiError(400, 'INVALID_INPUT', 'Invalid rule change', p.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
        body = await previewPolicyChange(ctx, p.data);
        break;
      }
      case 'listPayables': body = await read.listPayables(ctx); break;
      case 'getPayout': body = await (await import('../read/s6.ts')).getPayout(ctx, decodeURIComponent(params.id)); break;
      case 'revealPayee': {
        // Owner-only read with one side effect: the audit row (hash only). Not a command, so the address is never stored in an IDEM# record.
        const r = await (await import('../domain/payables/payee.ts')).revealPayee(ctx, { tenantId: ctx.tenantId, run, now, correlationId, ownerEmail: req.identity.email }, decodeURIComponent(params.id));
        await d.store.transact(r.ops);
        body = r.body;
        break;
      }
      case 'getBill': body = await read.getBill(ctx, params.id); break;
      case 'getBillDocument': body = await read.getBillDocument(ctx, params.id); break;
      case 'getInbox': body = await read.getInbox(ctx); break;
      case 'getReconciliation': body = await (await import('../read/s5.ts')).getReconciliation(ctx); break;
      case 'refreshInvoice': {
        const inv = await loadInvoice(d.store, ctx, params.id);
        if (!inv.ppInvoiceId) throw new ApiError(400, 'INVALID_INPUT', "Invoice isn't on PayPal yet");
        const jobId = `poll#${inv.invoiceId}`;
        await requestRun(d.store, newJob(jobId, 'POLL_INVOICE', inv.invoiceId, now, ctx.tenantId, run.runId), now);
        await d.queue.send(jobId).catch(() => {});
        body = { jobId };
        break;
      }
      case 'refreshPayPalBalance': {
        if (!ctx.connectionId) throw new ApiError(400, 'INVALID_INPUT', 'PayPal is not connected');
        const jobId = `obs#${ctx.connectionId}`;
        await requestRun(d.store, newJob(jobId, 'OBSERVE_BALANCE', ctx.connectionId, now, null, null), now);
        await d.queue.send(jobId).catch(() => {});
        body = { jobId };
        break;
      }
      case 'createPlaidLinkToken': {
        const parsed = routes.createPlaidLinkToken.body.safeParse(parseJson(req.body));
        if (!parsed.success) throw new ApiError(400, 'INVALID_INPUT', 'mode must be connect or update');
        body = await createLinkToken(d.store, d.plaidLink, d.vault, { tenantId: ctx.tenantId, run, now, correlationId, ownerEmail: req.identity.email }, parsed.data.mode);
        break;
      }
      case 'refreshPlaid': {
        const conn = await refreshTarget(d.store, ctx);
        const jobId = syncJobId(conn.itemId);
        await requestRun(d.store, newJob(jobId, 'PLAID_SYNC', conn.itemId, now, ctx.tenantId, run.runId), now);
        await d.queue.send(jobId).catch(() => {});
        body = { jobId };
        break;
      }
      case 'createInvoiceDraft':
      case 'sendInvoice':
      case 'exchangePlaidToken':
      case 'disconnectPlaid':
      case 'abandonBankConnect':
      case 'uploadDocument':
      case 'retryBill':
      case 'verifyBill':
      case 'acceptBillTerms':
      case 'addBillAsObligation':
      case 'createCommitment':
      case 'buildRevision':
      case 'editRevision':
      case 'approveRevision':
      case 'rejectRevision':
      case 'changePolicy':
      case 'setPause':
      case 'revokeGrant':
      case 'decideFallback':
      case 'setThreadOwner':
      case 'holdMessage':
      case 'acceptPromise':
      case 'confirmDispute':
      case 'acceptSupplierAnswer':
      case 'declineSupplierAnswer':
      case 'dismissDispute':
      case 'sendNow':
      case 'answerMatch':
      case 'confirmPayee': {
        const cc = { tenantId: ctx.tenantId, run, now, correlationId, ownerEmail: req.identity.email };
        const res = await command(d, ctx.tenantId, req, async () => {
          const parse = <T>(schema: { safeParse(x: unknown): { success: true; data: T } | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } } }, what: string) => {
            const p = schema.safeParse(parseJson(req.body));
            if (!p.success) throw new ApiError(400, 'INVALID_INPUT', `Invalid ${what}`, p.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
            return p.data;
          };
          switch (m.op) {
            case 'createInvoiceDraft': return createInvoiceDraft(d.store, cc, parse(routes.createInvoiceDraft.body, 'invoice'));
            case 'exchangePlaidToken': return claimConnect(d.store, d.vault, cc, req.headers['idempotency-key']!, parse(routes.exchangePlaidToken.body, 'bank connection'));
            case 'disconnectPlaid': return disconnectBank(d.store, cc, req.headers['if-match']);
            case 'abandonBankConnect': return abandonConnect(d.store, cc, req.headers['if-match']);
            case 'uploadDocument': {
              const b = parse(routes.uploadDocument.body, 'upload');
              if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b.contentBase64)) throw new ApiError(400, 'INVALID_INPUT', 'contentBase64 is not base64');
              return ingestCommand(d.evidence, d.store, cc, { fileName: b.fileName, bytes: new Uint8Array(Buffer.from(b.contentBase64, 'base64')), source: 'OWNER_UPLOAD' });
            }
            case 'retryBill': return retryBill(d.store, cc, params.id, req.headers['if-match']);
            case 'verifyBill': return verifyBill(d.store, cc, params.id, req.headers['if-match'], parse(routes.verifyBill.body, 'verification'));
            case 'acceptBillTerms': {
              // O6 (S7): if the accepted terms leave a shortfall, the plan builds by itself right after this commit.
              const r = await acceptBillTerms(d.store, cc, params.id, req.headers['if-match'], parse(routes.acceptBillTerms.body, 'acceptance'));
              return { ...r, afterCommit: async () => { await r.afterCommit?.(); await (await import('../domain/plan/build.ts')).autoBuild({ ...ctx, now: d.now() }, { ...cc, now: d.now() }, d.queue); } };
            }
            case 'addBillAsObligation': return addBillAsObligation(d.store, cc, params.id, req.headers['if-match'], parse(routes.addBillAsObligation.body, 'separate obligation'));
            case 'createCommitment': return createCommitment(d.store, cc, parse(routes.createCommitment.body, 'commitment'));
            case 'buildRevision': return requestBuild(ctx, cc, parse(routes.buildRevision.body, 'build request'));
            case 'editRevision': return editRevision(ctx, cc, params.id, req.headers['if-match'], parse(routes.editRevision.body, 'edit'));
            case 'approveRevision': return approveRevision(ctx, cc, params.id, req.headers['if-match'], parse(routes.approveRevision.body, 'approval'));
            case 'rejectRevision': return rejectRevision(ctx, cc, params.id, req.headers['if-match'], parse(routes.rejectRevision.body, 'rejection'));
            case 'changePolicy': return changePolicy(ctx, cc, req.headers['if-match'], parse(routes.changePolicy.body, 'rule change'));
            case 'setPause': return setPause(ctx, cc, req.headers['if-match'], parse(routes.setPause.body, 'pause'));
            case 'revokeGrant': return revokeGrant(ctx, cc, decodeURIComponent(params.id), parse(routes.revokeGrant.body, 'revoke'));
            case 'decideFallback': return decideFallback(ctx, cc, decodeURIComponent(params.id), req.headers['if-match'], parse(routes.decideFallback.body, 'decision'));
            case 'setThreadOwner': return setThreadOwner(ctx, cc, decodeURIComponent(params.id), req.headers['if-match'], parse(routes.setThreadOwner.body, 'owner'));
            case 'holdMessage': return holdMessage(ctx, cc, decodeURIComponent(params.id), parse(routes.holdMessage.body, 'hold'));
            case 'sendNow': return sendNow(ctx, cc, decodeURIComponent(params.id));
            case 'acceptSupplierAnswer': return (await import('../domain/obligations/supplier-answer.ts')).acceptSupplierAnswer(ctx, cc, decodeURIComponent(params.id), parse(routes.acceptSupplierAnswer.body, 'acceptance'));
            case 'declineSupplierAnswer': return (await import('../domain/obligations/supplier-answer.ts')).declineSupplierAnswer(ctx, cc, decodeURIComponent(params.id), parse(routes.declineSupplierAnswer.body, 'decline'));
            case 'confirmDispute': return (await import('../domain/receivables/dispute.ts')).confirmDispute(ctx, cc, decodeURIComponent(params.id), parse(routes.confirmDispute.body, 'dispute confirmation'));
            case 'dismissDispute': return (await import('../domain/receivables/dispute.ts')).dismissDispute(ctx, cc, decodeURIComponent(params.id), parse(routes.dismissDispute.body, 'dismissal'));
            case 'acceptPromise': parse(routes.acceptPromise.body, 'acceptance'); return acceptPromise(ctx, cc, decodeURIComponent(params.id));
            case 'confirmPayee': return (await import('../domain/payables/payee.ts')).confirmPayee(ctx, cc, decodeURIComponent(params.id), parse(routes.confirmPayee.body, 'confirmation'));
            case 'answerMatch': return answerMatch(ctx, cc, decodeURIComponent(params.id), req.headers['if-match'], parse(routes.answerMatch.body, 'answer'));
            default: return sendInvoice(d.store, cc, params.id, req.headers['if-match']);
          }
        });
        if (res.status === 202 && (res.body as any).jobId) await d.queue.send((res.body as any).jobId).catch(() => {}); // sweep is the backstop
        status = res.status;
        body = res.body;
        break;
      }
    }
    // Every response is checked against its contract schema before it leaves (producer side of C-API).
    const out = m.r.response.safeParse(body);
    if (!out.success) {
      console.error(JSON.stringify({ level: 'error', op: m.op, contractViolation: out.error.issues.slice(0, 5) }));
      throw new ApiError(500, 'INTERNAL', 'Response failed its contract');
    }
    return json(status, out.data, { 'x-correlation-id': correlationId });
  } catch (e) {
    if (e instanceof ApiError) return json(e.status, { code: e.code, outcome: e.outcome, message: e.message, correlationId, ...(e.details ? { details: e.details } : {}) });
    console.error(JSON.stringify({ level: 'error', correlationId, error: (e as Error).stack }));
    return json(500, { code: 'INTERNAL', outcome: 'UNKNOWN', message: 'Something went wrong', correlationId });
  }
}

const parseJson = (s: string | undefined) => { try { return s ? JSON.parse(s) : undefined; } catch { throw new ApiError(400, 'INVALID_INPUT', 'Body is not JSON'); } };

/** Reads of an old run's invoice are allowed (evidence); commands are not. */
async function loadInvoiceForRead(ctx: read.ReadCtx, id: string) {
  try { return await loadInvoice(ctx.store, ctx, id); }
  catch (e) { if (e instanceof ApiError && e.code === 'RUN_SEALED') throw new ApiError(404, 'NOT_FOUND', 'Invoice is in an earlier run'); throw e; }
}

/** Idempotency-Key: same key + same body replays the stored response; a different body is 409 and writes nothing. */
async function command(d: RouterDeps, tenantId: string, req: Req, run: () => Promise<CommandResult>): Promise<{ status: number; body: unknown }> {
  const key = req.headers['idempotency-key'];
  if (!key || key.length > 128) throw new ApiError(400, 'INVALID_INPUT', 'Idempotency-Key header required');
  const hash = createHash('sha256').update(`${req.method} ${req.path}\n${req.headers['if-match'] ?? ''}\n${req.body ?? ''}`).digest('hex');
  const pk = K.idem(tenantId, key);
  const replay = async () => {
    const prior = await d.store.get('work', pk, 'IDEM');
    if (!prior) return null;
    if (prior.requestHash !== hash) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'This Idempotency-Key was used with a different request');
    return { status: prior.status as number, body: prior.body };
  };
  const prior = await replay();
  if (prior) return prior;
  let res: CommandResult;
  try {
    res = await run();
  } catch (e) {
    // An identical request may have committed between our IDEM read and the command's own precondition read (S2-IM-03):
    // its precondition now refuses (e.g. ALREADY_CONNECTED), but the stored response is the right answer for this key.
    if (e instanceof ApiError && e.status === 409) { const again = await replay(); if (again) return again; }
    throw e;
  }
  const ttl = Math.floor(Date.parse(d.now()) / 1000) + 7 * 86400;
  for (let attempt = 0; ; attempt++) {
    try {
      await d.store.transact([...res.ops, { op: 'put', table: 'work', item: { pk, sk: 'IDEM', requestHash: hash, status: res.status, body: res.body, ttl }, cond: { notExists: true } }]);
      await res.afterCommit?.().catch(() => {}); // e.g. pull due jobs forward; the sweep is the backstop
    } catch (e) {
      if (!(e instanceof TxCancelled)) throw e;
      if (e.failed[e.failed.length - 1]) { const again = await replay(); if (again) return again; }
      if (e.failed[0]) throw new ApiError(409, 'RUN_SEALED', 'The run was reset while this command was in flight; reload'); // op 0 is the fence check
      if (res.rerunOnConflict && attempt === 0) { res = await run(); continue; }
      throw res.conflict ?? new ApiError(409, 'VERSION_CONFLICT', 'Changed concurrently; reload and try again');
    }
    return { status: res.status, body: res.body };
  }
}
