// Acceptance harness: in-memory store + queue, REPLAY fake PayPal, controllable clock, the real router/worker/sweep.
import { K } from '../../backend/src/adapters/store/keys.ts';
import type { Store } from '../../backend/src/adapters/store/port.ts';
import { MemoryStore } from '../../backend/src/adapters/store/memory.ts';
import { MemoryQueue } from '../../backend/src/adapters/queue/port.ts';
import { S1_GRANT, SimulatedCrash, type Deps, type Hooks } from '../../backend/src/deps.ts';
import { bootstrapTenant } from '../../backend/src/domain/identity-run/run.ts';
import { operatorReset } from '../../backend/src/handlers/operator.ts';
import { handle, type Req } from '../../backend/src/handlers/router.ts';
import { processJob } from '../../backend/src/jobs/worker.ts';
import { sweep } from '../../backend/src/jobs/sweep.ts';
import { FakePayPal } from './fake-paypal.ts';
import { FakePlaid } from './fake-plaid.ts';
import { LocalVault } from '../../backend/src/adapters/vault.ts';
import { MemoryEvidence } from '../../backend/src/adapters/evidence-store/memory.ts';
import { operatorInjectBill } from '../../backend/src/handlers/operator.ts';
import { billPdf, type Variant } from '../../scripts/demo/bill-pdf.ts';
import { FakeInterpreter } from './fake-interpreter.ts';
import type { FakeRole } from './fake-planner.ts';
import type { Interpreter } from '../../backend/src/adapters/bedrock/converse.ts';
import { SimulatedMailbox } from '../../backend/src/adapters/mail/simulated.ts';
import { apiScoped } from './api-scope.ts';

export const OWNER = { sub: 'owner-a', email: 'owner-a@example.com' };
export const OWNER_B = { sub: 'owner-b', email: 'owner-b@example.com' };

/** `plaid`: wire the STUB Plaid + a local vault; tenant-a's reset then seeds the demo bank unless `bank: 'none'`. */
/**
 * `hero`: S3 seed (supplier, commitments, stated receipts) on tenant-a's reset. `paypalMinor`: the fake PayPal available balance
 * (hero v1a opening = PayPal $1,800 + seeded bank $8,130). `interpreter: false` leaves the model unconfigured.
 */
/** S6: the synthetic registered sandbox receiver seeded as Keller's payee (sandbox `*.example.com`). */
export const KELLER_RECEIVER = 'keller-pay@supplier.example.com';

export async function harness(o: { start?: string; hooks?: Hooks; asOfLagMs?: number; plaid?: boolean; bank?: 'seed' | 'none'; hero?: boolean; paypalMinor?: number; noPayPalReport?: boolean; interpreter?: false | Interpreter; planner?: FakeRole | Interpreter; drafter?: FakeRole | Interpreter; heroB?: boolean; mail?: { redirectTo: string | null }; replier?: Interpreter; payee?: 'confirmed' | 'unconfirmed' | 'none'; dispute?: 'SEEDED' | 'EMAIL'; payer?: 'fake' | 'fake-async' | 'none'; grantExpiresAt?: string; bills?: 'AUTO' | 'ASK'; store?: Store; connectionId?: string; tenantId?: string } = {}) {
  let now = Date.parse(o.start ?? '2026-11-01T14:00:00.000Z');
  const clock = () => new Date(now).toISOString();
  // `store`/`connectionId`: the S6 dev race script runs this same flow on real DynamoDB with an isolated PayPal connection.
  // Typed as MemoryStore for the tests' seams (beforeTransact); the race script's DynamoStore simply never has them set.
  const store = (o.store ?? new MemoryStore()) as MemoryStore;
  const conn = o.connectionId ?? 'pp-test';
  // `tenantId`: the dev race script runs cases in parallel, each with its own tenant and owner identity (defaults: tenant-a / owner-a).
  const T = o.tenantId ?? 'tenant-a';
  const ME = o.tenantId ? { sub: `${o.tenantId}-owner`, email: `${o.tenantId}-owner@example.com` } : OWNER;
  const TB = o.tenantId ? `${o.tenantId}-b` : 'tenant-b';
  const queue = new MemoryQueue();
  const pp = new FakePayPal();
  pp.balance.asOf = o.noPayPalReport ? undefined : new Date(now - (o.asOfLagMs ?? 2 * 3600_000)).toISOString();
  if (o.paypalMinor !== undefined) pp.balance.availableMinor = o.paypalMinor;
  const evidence = new MemoryEvidence();
  const model = new FakeInterpreter();
  let elapsedMs = 0;
  const plaid = new FakePlaid();
  plaid.today = () => clock().slice(0, 10);
  const vault = new LocalVault();
  const deps: Deps = {
    store, queue, reader: pp.reader, writer: pp.writer, now: clock, hooks: o.hooks ?? {},
    // S7 R3: FAKE payer (tests only): what the real one does on PayPal's hosted page, against the fake PayPal. Labelled AUTOMATED-PAYER in data.
    ...(o.payer === 'fake' || o.payer === 'fake-async' ? { payer: { pay: async (r: { url: string; amountMinor: number }) => { const id = r.url.split('#').pop()!; pp.pay(id, { grossMinor: r.amountMinor, feeMinor: Math.floor((r.amountMinor * 349 + 5_000) / 10_000) + 49, createTime: clock() }); return { phaseReached: 'SUBMITTED' as const, error: null, screenshots: [] }; } } } : {}),
    config: { stage: 'local', connectionId: conn, merchantEmail: 'merchant@example.com', webhookId: 'WH-TEST', grant: { ...S1_GRANT, ...(o.grantExpiresAt ? { expiresAt: o.grantExpiresAt } : {}), budgets: { ...S1_GRANT.budgets, payouts: 500 } }, payoutReceiver: o.payee === 'none' ? null : KELLER_RECEIVER },
    ...(o.plaid ? { plaid: { reader: plaid.reader, connector: plaid.connector, linkToken: plaid.linkToken }, vault, elapsed: () => plaid.elapsed + elapsedMs } : { elapsed: () => elapsedMs }),
    evidence, bedrockEnv: 'local', ...(o.interpreter === false ? {} : { interpreter: o.interpreter ?? model }), planner: o.planner, drafter: o.drafter, replier: o.replier,
  };
  // S7 B6: the dev/review shape: the worker hands the SUBMITTING attempt to the payer Lambda (here: payOnce on the same deps).
  if (o.payer === 'fake-async') deps.payerAsync = async (req) => { await (await import('../../backend/src/domain/demo/payer.ts')).payOnce(deps, req); };
  // S5: the labelled SIMULATED mailbox stands in for Gmail (same port; the shared contract suite runs on both).
  const mailbox = new SimulatedMailbox(store, 'headroom@headroom.example', clock);
  if (o.mail) { deps.mail = { channel: mailbox, address: 'headroom@headroom.example', redirectTo: o.mail.redirectTo }; deps.config.mail = { kind: 'SIMULATED', sender: 'headroom@headroom.example', inbox: o.mail.redirectTo }; }
  await bootstrapTenant(store, { sub: ME.sub, email: ME.email, tenantId: T, connectionId: conn });
  await bootstrapTenant(store, { sub: o.tenantId ? `${TB}-owner` : OWNER_B.sub, email: OWNER_B.email, tenantId: TB, connectionId: null });
  const run = await operatorReset(deps, T, 'acceptance', { bank: o.bank ?? (o.plaid ? 'seed' : 'none'), hero: o.hero ?? false, dispute: o.dispute ?? 'SEEDED', bills: o.bills ?? 'ASK' });
  await operatorReset(deps, TB, 'acceptance', { hero: false });
  // S6: earlier slices' journeys assume the owner already confirmed Keller's PayPal address (SETUP, not a product path; S6 tests use 'unconfirmed').
  if (o.hero && (o.payee ?? 'confirmed') === 'confirmed') await store.transact([{ op: 'update', table: 'core', pk: K.run(T, run!.runId), sk: 'PAYEE#sup-keller', set: { state: 'CONFIRMED', confirmedBy: ME.email, confirmedAt: clock() }, cond: { eq: { state: 'UNCONFIRMED' } } }]);

  let n = 0;
  const api = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}, identity: typeof OWNER | null = ME) => {
    const req: Req = { method, path, headers: { ...(method === 'POST' && !path.includes('/refresh') && !path.includes('webhooks') ? { 'idempotency-key': `k-${++n}` } : {}), ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body), identity };
    // The router runs with the API role's dev permissions enforced (api-scope.ts); the webhook route is its own Lambda and role.
    const r = await handle({ store: path.startsWith('/v1/webhooks/') ? store : apiScoped(store), queue, config: deps.config, now: clock, evidence, ...(o.plaid ? { plaidLink: plaid.linkToken, vault } : {}) }, req);
    return { status: r.status, body: JSON.parse(r.body) };
  };

  /** Run sweep + queued jobs until quiet (jobs due later stay queued). */
  const drain = async (max = 200) => {
    for (let i = 0; i < max; i++) {
      await sweep({ store, queue, now: clock });
      if (!queue.pending.length) return;
      while (queue.pending.length) {
        const id = queue.take()!;
        try { await processJob(deps, id); } catch (e) { if (!(e instanceof SimulatedCrash)) throw e; }
      }
    }
  };
  const advance = async (ms: number) => { now += ms; await drain(); };

  const draftAndIssue = async (minor = 4200, customerId = 'cust-alder') => {
    const d = await api('POST', '/v1/invoices', { customerId, amount: { currency: 'USD', minor }, dueOn: '2026-11-20' });
    if (d.status !== 201) throw new Error(JSON.stringify(d));
    const id = d.body.invoice.invoiceId;
    const s = await api('POST', `/v1/invoices/${id}/send`, undefined, { 'if-match': '1' });
    return { id, send: s };
  };
  const invoice = async (id: string) => (await api('GET', `/v1/invoices/${id}`)).body;
  const ppIdOf = async (id: string) => (await invoice(id)).ppInvoiceId as string;

  const cash = async (identity: typeof OWNER | null = ME) => (await api('GET', '/v1/cash/position', undefined, {}, identity)).body;
  const bank = async (identity: typeof OWNER | null = ME) => (await cash(identity)).sources[1];
  /** S3: the business date of the reset (day 0) and the operator inject path (original bytes only). */
  const day0 = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
  const inject = async (v: Variant, o2: { drain?: boolean; bytes?: Buffer; d0?: string } = {}) => {
    const r = await operatorInjectBill(deps, T, { action: 'injectBill', tenantId: T, fileName: `${v}.pdf`, contentBase64: (o2.bytes ?? billPdf(v, o2.d0 ?? day0())).toString('base64'), reason: 'acceptance' });
    if (o2.drain !== false) await drain();
    return r;
  };
  const bill = async (id: string) => (await api('GET', `/v1/bills/${id}`)).body;
  const forecast = async () => (await api('GET', '/v1/cash/forecast')).body;
  const overview = async () => (await api('GET', '/v1/overview')).body;
  /** S7 R10: the demo lane (operator Lambda) with a VERIFIED role, as the JWT authorizer would pass it. */
  const demo = async (method: string, path: string, body?: unknown, role: 'OWNER' | 'JUDGE' | 'OPERATOR' = 'JUDGE', identity: typeof OWNER = ME) => {
    const { handleDemo } = await import('../../backend/src/handlers/demo.ts');
    const r = await handleDemo(deps, { method, path, headers: {}, body: body === undefined ? undefined : JSON.stringify(body), identity: { ...identity, role } });
    return { status: r.status, body: JSON.parse(r.body) };
  };
  return { demo, tenantId: T, mailbox, store, queue, pp, plaid, vault, deps, clock, api, drain, advance, draftAndIssue, invoice, ppIdOf, run, cash, bank, setNow: (iso: string) => { now = Date.parse(iso); },
    evidence, model, inject, bill, forecast, overview, day0, setElapsed: (ms: number) => { elapsedMs = ms; } };
}
