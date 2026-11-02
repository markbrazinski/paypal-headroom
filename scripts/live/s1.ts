// S1 live/dev cases (S01 §6.11). Labels: LIVE (real PayPal), STUB-WRITER (real DynamoDB, counting writer stub, no PayPal write).
//   HEADROOM_GRANT=S1 node scripts/live/s1.ts --case unauth|R16|R4|R13|R10|R18|R19|all
// Uses .headroom-local/dev-outputs.json and the owner's AWS profile. Stub cases use a separate tenant ("tenant-stub").
import { readFileSync, writeFileSync } from 'node:fs';
import { DynamoStore } from '../../backend/src/adapters/store/dynamodb.ts';
import { MemoryQueue } from '../../backend/src/adapters/queue/port.ts';
import { S1_GRANT, type Deps } from '../../backend/src/deps.ts';
import { K } from '../../backend/src/adapters/store/keys.ts';
import { bootstrapTenant } from '../../backend/src/domain/identity-run/run.ts';
import { operatorReset } from '../../backend/src/handlers/operator.ts';
import { handle } from '../../backend/src/handlers/router.ts';
import { processJob } from '../../backend/src/jobs/worker.ts';
import { reconcileInvoice } from '../../backend/src/domain/paypal-mirror/reconcile-invoice.ts';
import { ingestWebhook } from '../../backend/src/domain/paypal-mirror/webhook.ts';
import { SimulatedCrash } from '../../backend/src/deps.ts';
import { FakePayPal } from '../../tests/acceptance/fake-paypal.ts';

if (process.env.HEADROOM_GRANT !== 'S1') { console.error('refusing: set HEADROOM_GRANT=S1 (Build Book §I)'); process.exit(2); }
process.env.AWS_PROFILE ??= 'headroom-admin';
process.env.AWS_REGION ??= 'us-east-1';
const out = JSON.parse(readFileSync('.headroom-local/dev-outputs.json', 'utf8')).HeadroomDev;
const arg = (n: string) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
const results: { case: string; label: string; ok: boolean; detail: string }[] = [];
const record = (c: string, label: string, ok: boolean, detail: string) => { results.push({ case: c, label, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${c} [${label}] ${detail}`); };

const store = new DynamoStore({ core: 'HeadroomDev-core', work: 'HeadroomDev-work', provider: 'HeadroomDev-provider', audit: 'HeadroomDev-audit' });

/** Real DynamoDB, counting stub writer, separate tenant and connection. Never calls PayPal. */
async function stubDeps(hooks: Deps['hooks'] = {}) {
  const pp = new FakePayPal();
  pp.balance.asOf = new Date(Date.now() - 2 * 3600_000).toISOString();
  const queue = new MemoryQueue();
  const d: Deps = { store, queue, reader: pp.reader, writer: pp.writer, now: () => new Date().toISOString(), hooks, config: { stage: 'dev', connectionId: 'stub-writer', merchantEmail: 'merchant@example.com', webhookId: 'WH-STUB', grant: S1_GRANT } };
  // A dedicated grant counter for stub runs keeps the real G-1 counter honest.
  d.config.grant = { ...S1_GRANT, id: 'S1-STUB' };
  await bootstrapTenant(store, { sub: 'stub-owner', email: 'stub@example.com', tenantId: 'tenant-stub', connectionId: 'stub-writer' });
  const run = await operatorReset(d, 'tenant-stub', 'STUB-WRITER case');
  const api = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const r = await handle({ store, queue, config: d.config, now: d.now }, { method, path, headers, body: body === undefined ? undefined : JSON.stringify(body), identity: { sub: 'stub-owner', email: 'stub@example.com' } });
    return { status: r.status, body: JSON.parse(r.body) };
  };
  const draft = async () => (await api('POST', '/v1/invoices', { customerId: 'cust-alder', amount: { currency: 'USD', minor: 100 }, dueOn: '2026-11-20' }, { 'idempotency-key': crypto.randomUUID() })).body.invoice.invoiceId as string;
  return { d, pp, run: run!, api, draft, queue };
}

/** Signs in through Cognito managed login in headless Chromium and calls the dev API with that user's id token. */
async function devApi(userKey: 'ownerA' | 'ownerB') {
  const { chromium } = await import('playwright-core');
  const creds = JSON.parse(readFileSync('.headroom-local/dev-users.json', 'utf8'))[userKey];
  const browser = await chromium.launch({ executablePath: `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing` });
  const page = await browser.newPage();
  await page.goto(`${out.SiteUrl}/overview`);
  await page.waitForFunction(() => (globalThis as any).location.host.includes('amazoncognito'), null, { timeout: 30_000 });
  await page.locator('input[name="username"]:visible').fill(creds.email);
  await page.locator('input[name="password"]:visible').fill(creds.password);
  await page.locator('input[type="submit"]:visible, button[type="submit"]:visible').first().click();
  await page.waitForFunction(() => !!(globalThis as any).sessionStorage.getItem('hr.idToken'), null, { timeout: 30_000 });
  const token = await page.evaluate(() => (globalThis as any).sessionStorage.getItem('hr.idToken') as string);
  await browser.close();
  return async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(`${out.SiteUrl}${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) as any };
  };
}

/**
 * LIVE-FAULT: the real PayPal sandbox and the real dev DynamoDB, run from this machine under a separate tenant and connection
 * ("tenant-fault" / "paypal-sandbox-fault", same merchant). The fault is injected here; recovery is left to the DEPLOYED sweep + worker.
 */
async function faultDeps(o: { dropCreateResponse?: boolean; crashAfterCreate?: boolean }) {
  process.loadEnvFile('.env');
  const { PayPalHttp } = await import('../../backend/src/adapters/paypal/http.ts');
  const { paypalReader } = await import('../../backend/src/adapters/paypal/reader.ts');
  const { paypalWriter } = await import('../../backend/src/adapters/paypal/writer.ts');
  // Test-only transport: the create request genuinely goes to PayPal; its response is then thrown away (a client timeout).
  const fetchImpl: typeof fetch = async (url, init) => {
    const r = await fetch(url, init);
    if (o.dropCreateResponse && init?.method === 'POST' && String(url).endsWith('/v2/invoicing/invoices')) { await r.text(); throw new Error('LIVE-FAULT: response discarded'); }
    return r;
  };
  const now = () => new Date().toISOString();
  const http = new PayPalHttp({ clientId: process.env.PAYPAL_CLIENT_ID!, secret: process.env.PAYPAL_CLIENT_SECRET!, store, grant: S1_GRANT, now, fetchImpl });
  const queue = new MemoryQueue();
  const d: Deps = {
    store, queue, now, reader: paypalReader(http), writer: paypalWriter(http),
    hooks: o.crashAfterCreate ? { afterCreate: async () => { throw new SimulatedCrash('LIVE-FAULT: process died after create'); } } : {},
    config: { stage: 'dev', connectionId: 'paypal-sandbox-fault', merchantEmail: process.env.PAYPAL_MERCHANT_EMAIL!, webhookId: null, grant: S1_GRANT },
  };
  await bootstrapTenant(store, { sub: 'fault-owner', email: 'fault@example.com', tenantId: 'tenant-fault', connectionId: 'paypal-sandbox-fault' });
  if (!(await store.get('core', K.tenant('tenant-fault'), 'RUN_FENCE'))) await operatorReset(d, 'tenant-fault', 'LIVE-FAULT cases');
  const api = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const r = await handle({ store, queue, config: d.config, now }, { method, path, headers, body: body === undefined ? undefined : JSON.stringify(body), identity: { sub: 'fault-owner', email: 'fault@example.com' } });
    return { status: r.status, body: JSON.parse(r.body) };
  };
  return { d, http, api };
}

async function faultCase(name: string, o: { dropCreateResponse?: boolean; crashAfterCreate?: boolean }) {
  const { d, http, api } = await faultDeps(o);
  const draft = await api('POST', '/v1/invoices', { customerId: 'cust-copper', amount: { currency: 'USD', minor: 101 }, dueOn: '2026-11-20' }, { 'idempotency-key': crypto.randomUUID() });
  const id = draft.body.invoice.invoiceId;
  const s = await api('POST', `/v1/invoices/${id}/send`, undefined, { 'idempotency-key': crypto.randomUUID(), 'if-match': '1' });
  const number = s.body.effectId;
  try { await processJob(d, s.body.jobId); } catch (e) { if (!(e instanceof SimulatedCrash)) throw e; }
  const after = await store.get('work', K.effect(number), 'EFFECT');
  console.log(`${name}: ${number} after fault → effect ${after?.state}; waiting for the deployed sweep/worker to reconcile…`);
  let eff = after;
  for (let i = 0; i < 60 && eff?.state !== 'VERIFIED_SUCCESS' && eff?.state !== 'VERIFIED_FAILURE'; i++) { await new Promise((ok) => setTimeout(ok, 5000)); eff = await store.get('work', K.effect(number), 'EFFECT'); }
  const search = await d.reader.searchInvoiceByNumber(number);
  const onPayPal = (search.body?.items ?? []).filter((i: any) => i.detail?.invoice_number === number).length;
  const audit = (await store.query('audit', K.run('tenant-fault', after!.runId))).filter((a) => a.refs?.effectKey === number).map((a) => a.eventType);
  record(name, 'LIVE-FAULT', eff?.state === 'VERIFIED_SUCCESS' && onPayPal === 1 && audit.includes('EffectOutcomeUnknown'), `${number}: ${after?.state} → ${eff?.state}; invoices on PayPal with this number: ${onPayPal}; audit ${audit.join(' > ')}`);
  // Test invoice: stop its background polling so it doesn't spend reads for 30 days.
  const job = await store.get('work', K.job(`poll#${id}`), 'JOB');
  if (job && job.state === 'QUEUED') await store.transact([{ op: 'update', table: 'work', pk: job.pk, sk: 'JOB', set: { state: 'DONE', lastError: 'retired: LIVE-FAULT test invoice' }, remove: ['gsiDue', 'dueKey'], cond: { eq: { state: 'QUEUED' } } }]);
  void http;
}

const cases: Record<string, () => Promise<void>> = {
  R7: () => faultCase('S1-R7', { dropCreateResponse: true }),
  R17: () => faultCase('S1-R17 after-create', { crashAfterCreate: true }),
  async R1() {
    // The genuine signed event PayPal delivered for the most recent dev payment, re-posted 10× byte for byte.
    const { Items } = await import('@aws-sdk/lib-dynamodb').then(async ({ DynamoDBDocumentClient, ScanCommand }) => {
      const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
      return DynamoDBDocumentClient.from(new DynamoDBClient({})).send(new ScanCommand({ TableName: 'HeadroomDev-provider', FilterExpression: 'begins_with(pk, :w) AND #s = :p', ExpressionAttributeNames: { '#s': 'state' }, ExpressionAttributeValues: { ':w': 'WEBHOOK#', ':p': 'PROCESSED' } }));
    });
    const ev = (Items ?? []).sort((a: any, b: any) => b.receivedAt.localeCompare(a.receivedAt))[0] as any;
    if (!ev) return record('S1-R1', 'LIVE', false, 'no processed genuine event yet');
    const ref = await store.get('provider', K.ppInvoice(JSON.parse(ev.raw).resource.invoice.id), 'REF');
    const before = (await store.query('core', K.run(ref!.tenantId, ref!.runId), { skPrefix: 'RCPT#' })).filter((r) => r.invoiceId === ref!.invoiceId).length;
    const statuses: number[] = [];
    for (let i = 0; i < 10; i++) statuses.push((await fetch(out.WebhookUrl, { method: 'POST', headers: { 'content-type': 'application/json', ...Object.fromEntries(Object.entries(ev.headers).filter(([, v]) => v)) as Record<string, string> }, body: ev.raw })).status);
    await new Promise((ok) => setTimeout(ok, 70_000)); // past one sweep
    const after = (await store.query('core', K.run(ref!.tenantId, ref!.runId), { skPrefix: 'RCPT#' })).filter((r) => r.invoiceId === ref!.invoiceId).length;
    const job = await store.get('work', K.job(`whv#${ev.eventId}`), 'JOB');
    record('S1-R1', 'LIVE', statuses.every((s) => s === 200) && before === 1 && after === 1 && job?.attempts === 1, `genuine event ${ev.eventId} re-posted 10× → ${[...new Set(statuses)]}; receipts ${before} → ${after}; verify job attempts ${job?.attempts}`);
  },
  /** S1-R9 / S1-R15 phase 1: issue a real invoice, reset the run, prove the old run is sealed, print the payer link. */
  async 'R9-prepare'() {
    const a = await devApi('ownerA');
    const before = (await a('GET', '/v1/session')).body.run.runId;
    const d = await a('POST', '/v1/invoices', { customerId: 'cust-birch', amount: { currency: 'USD', minor: 1500 }, dueOn: '2026-11-20' }, { 'idempotency-key': crypto.randomUUID() });
    const id = d.body.invoice.invoiceId;
    const s = await a('POST', `/v1/invoices/${id}/send`, undefined, { 'idempotency-key': crypto.randomUUID(), 'if-match': '1' });
    let inv;
    for (let i = 0; i < 30; i++) { await new Promise((ok) => setTimeout(ok, 3000)); inv = (await a('GET', `/v1/invoices/${id}`)).body; if (inv.invoice.state === 'ISSUED') break; }
    record('R9 issue', 'LIVE', s.status === 202 && inv.invoice.state === 'ISSUED', `${inv.invoice.invoiceNumber} ${inv.invoice.state} in ${before}`);
    const { invokeOperator } = await import('../demo/operator-client.ts');
    const next = await invokeOperator({ action: 'reset', tenantId: 'tenant-owner', reason: 'S1-R9: reset, then pay the old-run invoice' });
    const sealedCmd = await a('POST', `/v1/invoices/${id}/refresh`);
    const sealedDraft = await a('POST', '/v1/invoices', { customerId: 'cust-alder', amount: { currency: 'USD', minor: 100 }, dueOn: '2026-11-20' }, { 'idempotency-key': crypto.randomUUID(), 'x-headroom-run': before });
    record('S1-R15', 'LIVE', sealedCmd.status === 409 && sealedCmd.body.code === 'RUN_SEALED' && sealedDraft.body.code === 'RUN_SEALED', `after reset to ${next.runId}: command on old invoice → ${sealedCmd.status} ${sealedCmd.body.code}; draft against old run → ${sealedDraft.body.code}`);
    writeFileSync('.headroom-local/r9.json', JSON.stringify({ oldRun: before, newRun: next.runId, invoiceId: id, number: inv.invoice.invoiceNumber, payerUrl: inv.payerUrl }));
    console.log(`\nPAY THIS OLD-RUN INVOICE (${inv.invoice.invoiceNumber}, $15.00): ${inv.payerUrl}\n`);
  },
  /** S1-R9 phase 2: after the owner pays, the payment lands in the old run only. */
  async 'R9-check'() {
    const r = JSON.parse(readFileSync('.headroom-local/r9.json', 'utf8'));
    const oldR = (await store.query('core', K.run('tenant-owner', r.oldRun), { skPrefix: 'RCPT#' })).filter((x) => x.invoiceId === r.invoiceId);
    const newR = await store.query('core', K.run('tenant-owner', r.newRun), { skPrefix: 'RCPT#' });
    const routed = (await store.query('audit', K.run('tenant-owner', r.oldRun))).filter((x) => x.eventType === 'OldRunEventRouted');
    record('S1-R9', 'LIVE', oldR.length === 1 && newR.length === 0 && routed.length >= 1, `old run ${r.oldRun}: ${oldR.length} receipt; new run ${r.newRun}: ${newR.length}; OldRunEventRouted ×${routed.length}`);
  },
  async R4() {
    const a = await devApi('ownerA');
    const b = await devApi('ownerB');
    const invA = (await a('GET', '/v1/receivables')).body.invoices.find((i: any) => i.invoiceNumber) ?? (await a('GET', '/v1/receivables')).body.invoices[0];
    const asB = await b('GET', `/v1/invoices/${invA.invoiceId}`);
    const cashB = (await b('GET', '/v1/cash/position')).body;
    const recB = (await b('GET', '/v1/receivables')).body;
    record('S1-R4', 'LIVE', asB.status === 404, `owner B GET owner A invoice ${invA.invoiceNumber} → ${asB.status}`);
    const draftB = await b('POST', '/v1/invoices', { customerId: 'cust-alder', amount: { currency: 'USD', minor: 100 }, dueOn: '2026-11-20' }, { 'idempotency-key': crypto.randomUUID() });
    const sendB = await b('POST', `/v1/invoices/${draftB.body.invoice.invoiceId}/send`, undefined, { 'idempotency-key': crypto.randomUUID(), 'if-match': '1' });
    record('S1-IR-01', 'LIVE', sendB.status === 409 && sendB.body.code === 'NOT_CONNECTED', `owner B (no PayPal connection) Issue → ${sendB.status} ${sendB.body.code}`);
    // B's own local drafts (left by earlier IR-01 runs) are fine; none of A's invoices and nothing on PayPal may appear.
    const leaked = recB.invoices.filter((i: any) => i.invoiceId === invA.invoiceId || i.invoiceNumber);
    record('S1-R23', 'LIVE', cashB.sources[0].reportedAvailable === null && cashB.sources[0].estimate === null && leaked.length === 0 && recB.incoming.length === 0, `owner B sees no PayPal connection data (reported ${cashB.sources[0].reportedAvailable}); ${recB.invoices.length} own draft(s), ${leaked.length} issued/foreign, ${recB.incoming.length} receipts`);
  },
  async unauth() {
    const r = await fetch(`${out.SiteUrl}/v1/overview`);
    record('unauth', 'LIVE', r.status === 401, `GET /v1/overview without a token → ${r.status}`);
    const s = await fetch(`${out.SiteUrl}/config.json`);
    record('unauth-shell', 'LIVE', s.ok, `static shell config served publicly (no data) → ${s.status}`);
  },
  async R16() {
    const post = async (id: string, headers: Record<string, string>) => {
      const r = await fetch(out.WebhookUrl, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ id, event_type: 'INVOICING.INVOICE.PAID', resource: { invoice: { id: 'INV2-NOT-SIGNED' } } }) });
      let ev;
      for (let i = 0; i < 30 && !(ev && ev.state !== 'RECEIVED'); i++) { await new Promise((ok) => setTimeout(ok, 4000)); ev = await store.get('provider', K.webhook(id), 'EVENT'); }
      return { status: r.status, ev };
    };
    const a = await post(`WH-R16-UNSIGNED-${Date.now()}`, {});
    record('S1-R16 unsigned', 'LIVE', a.status === 200 && a.ev?.state === 'QUARANTINED' && a.ev?.reason === 'MISSING_SIGNATURE_HEADERS', `→ ${a.status}; ${a.ev?.state} ${a.ev?.reason} (no verify call)`);
    const forged = { 'paypal-transmission-id': crypto.randomUUID(), 'paypal-transmission-time': new Date().toISOString(), 'paypal-transmission-sig': 'Zm9yZ2Vk', 'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-a5cafa77', 'paypal-auth-algo': 'SHA256withRSA' };
    const b = await post(`WH-R16-FORGED-${Date.now()}`, forged);
    record('S1-R16 forged', 'LIVE', b.status === 200 && b.ev?.state === 'QUARANTINED' && /^BAD_SIGNATURE/.test(b.ev?.reason ?? ''), `→ ${b.status}; ${b.ev?.state} ${b.ev?.reason} (one verify call)`);
  },
  async R13() {
    const { d, pp, api, draft } = await stubDeps();
    const id = await draft();
    const s = await api('POST', `/v1/invoices/${id}/send`, undefined, { 'if-match': '1', 'idempotency-key': crypto.randomUUID() });
    await Promise.all(Array.from({ length: 5 }, () => processJob(d, s.body.jobId)));
    for (let i = 0; i < 5; i++) await processJob(d, s.body.jobId);
    const inv = await store.get('core', K.run('tenant-stub', (await api('GET', '/v1/session')).body.run.runId), `INV#${id}`);
    const ppId = inv!.ppInvoiceId;
    pp.pay(ppId);
    await Promise.all(Array.from({ length: 10 }, () => reconcileInvoice(d, { tenantId: 'tenant-stub', runId: inv!.runId, invoiceId: id }, 'POLL')));
    const rcpts = await store.query('core', K.run('tenant-stub', inv!.runId), { skPrefix: 'RCPT#' });
    record('S1-R13', 'STUB-WRITER', pp.count('CREATE') === 1 && pp.invoices.size === 1 && rcpts.filter((r) => r.invoiceId === id).length === 1, `5 parallel workers on one job → ${pp.count('CREATE')} create; 10 parallel reconciles → ${rcpts.filter((r) => r.invoiceId === id).length} receipt (real DDB)`);
  },
  async R10() {
    const { d, pp, api, draft } = await stubDeps();
    const id = await draft();
    const s = await api('POST', `/v1/invoices/${id}/send`, undefined, { 'if-match': '1', 'idempotency-key': crypto.randomUUID() });
    await operatorReset(d, 'tenant-stub', 'R10 reset before dispatch');
    await processJob(d, s.body.jobId);
    const eff = await store.get('work', K.effect(s.body.effectId), 'EFFECT');
    record('S1-R10', 'STUB-WRITER', pp.count('CREATE') === 0 && eff?.failureReason === 'Run was reset before this invoice was issued', `effect ${eff?.state}; writer calls ${pp.count('CREATE')}`);
  },
  async R18() {
    let reset: (() => Promise<unknown>) | null = null;
    const a = await stubDeps({ afterJobClaim: async () => { await reset?.(); } });
    reset = () => operatorReset(a.d, 'tenant-stub', 'R18a');
    const id = await a.draft();
    const s = await a.api('POST', `/v1/invoices/${id}/send`, undefined, { 'if-match': '1', 'idempotency-key': crypto.randomUUID() });
    await processJob(a.d, s.body.jobId);
    record('S1-R18a', 'STUB-WRITER', a.pp.count('CREATE') === 0, `reset between job claim and dispatch claim → ${a.pp.count('CREATE')} writer calls`);
    let once = true;
    const b = await stubDeps({ afterCreate: async () => { if (once) { once = false; await operatorReset(b.d, 'tenant-stub', 'R18b'); } } });
    const id2 = await b.draft();
    const s2 = await b.api('POST', `/v1/invoices/${id2}/send`, undefined, { 'if-match': '1', 'idempotency-key': crypto.randomUUID() });
    await processJob(b.d, s2.body.jobId);
    const eff = await store.get('work', K.effect(s2.body.effectId), 'EFFECT');
    record('S1-R18b', 'STUB-WRITER', eff?.state === 'VERIFIED_SUCCESS' && b.pp.count('CREATE') === 1, `reset after dispatch claim → effect ${eff?.state} in old run ${eff?.runId}`);
  },
  async R19() {
    const { d, queue } = await stubDeps();
    const id = `WH-R19-${Date.now()}`;
    const raw = JSON.stringify({ id, event_type: 'INVOICING.INVOICE.PAID', resource: { invoice: { id: 'INV2-STUB-NONE' } } });
    let crashed = false;
    try { await ingestWebhook(store, queue, raw, {}, d.now(), { afterWebhookCommit: async () => { throw new SimulatedCrash('ingress died'); } }); } catch { crashed = true; }
    const dup = await ingestWebhook(store, queue, raw, {}, d.now());
    const job = await store.get('work', K.job(`whv#${id}`), 'JOB');
    record('S1-R19', 'STUB-WRITER', crashed && dup.duplicate && job?.state === 'QUEUED' && queue.pending.length === 1, `crash after commit → job durable (${job?.state}); duplicate re-sent once (queue ${queue.pending.length}); real DDB`);
  },
};

/** Stub cases must not leave due jobs: the deployed sweep would hand them to the real worker (real PayPal reads on fake ids). */
async function retireStubJobs() {
  const due = await store.dueJobs('9999-12-31T00:00:00.000Z', 1000);
  const stub = due.filter((j) => j.tenantId === 'tenant-stub' || j.jobId === 'obs#stub-writer' || String(j.jobId).startsWith('whv#WH-R19-') || String(j.ref).startsWith('HR-') && j.tenantId === 'tenant-stub');
  for (const j of stub) await store.transact([{ op: 'update', table: 'work', pk: j.pk, sk: 'JOB', set: { state: 'DONE', lastError: 'retired: STUB-WRITER case' }, remove: ['gsiDue', 'dueKey'] }]);
  console.log(`retired ${stub.length} stub job(s)`);
}

const which = arg('--case') ?? 'all';
for (const c of which === 'all' ? Object.keys(cases) : which.split(',')) {
  try { await cases[c](); } catch (e) { record(c, '?', false, (e as Error).message); }
}
await retireStubJobs();
process.exit(results.every((r) => r.ok) ? 0 : 1);
