// S2 live cases (S02 §6.11). LIVE = the real Plaid sandbox through product code (router → executor → sync job → read model).
// The PayPal half is a labelled STUB (FakePayPal): these cases are about the bank. Grant PLAID-S2 / PP-S2 (Build Book §I).
//   HEADROOM_GRANT=S2 node scripts/live/s2.ts --stage local --case env5|A1|A2|A3|R3|R1|R22|all [--out <dir>]
// The test-harness calls (/sandbox/item/reset_login, /transactions/refresh, out-of-band /item/remove, a sandbox user's
// public token) live here and nowhere in product code (import-graph test).
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { MemoryStore } from '../../backend/src/adapters/store/memory.ts';
import { MemoryQueue } from '../../backend/src/adapters/queue/port.ts';
import { K } from '../../backend/src/adapters/store/keys.ts';
import { PlaidHttp } from '../../backend/src/adapters/plaid/http.ts';
import { plaidLinkToken, plaidReader } from '../../backend/src/adapters/plaid/clients.ts';
import { plaidConnector } from '../../backend/src/adapters/plaid/connector.ts';
import { LocalVault, unseal } from '../../backend/src/adapters/vault.ts';
import { S2_GRANT, SimulatedCrash, type Deps } from '../../backend/src/deps.ts';
import { bootstrapTenant } from '../../backend/src/domain/identity-run/run.ts';
import { operatorGetRun, operatorReset } from '../../backend/src/handlers/operator.ts';
import { handle } from '../../backend/src/handlers/router.ts';
import { processJob } from '../../backend/src/jobs/worker.ts';
import { sweep } from '../../backend/src/jobs/sweep.ts';
import { countedRows, decodeProjection } from '../../backend/src/domain/bank-mirror/bank.ts';
import { FakePayPal } from '../../tests/acceptance/fake-paypal.ts';

if (process.env.HEADROOM_GRANT !== 'S2') { console.error('refusing: set HEADROOM_GRANT=S2 (PLAID-S2, Build Book §I)'); process.exit(2); }
process.loadEnvFile('.env');
if (process.env.PLAID_ENV !== 'sandbox') { console.error('refusing: PLAID_ENV must be sandbox'); process.exit(2); }
const arg = (n: string) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
const which = arg('--case') ?? 'all';
const outDir = arg('--out');
const pseud = (s: string) => `#${createHash('sha256').update(`s2-live:${s}`).digest('hex').slice(0, 10)}`;
const results: { case: string; label: string; ok: boolean; detail: string }[] = [];
const record = (c: string, label: string, ok: boolean, detail: string) => { results.push({ case: c, label, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${c} [${label}] ${detail}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One in-process stack: in-memory store, real Plaid sandbox, local vault, STUB PayPal. Optional LIVE-FAULT transport. */
function stack(o: { dropExchange?: boolean; hooks?: Deps['hooks'] } = {}) {
  const store = new MemoryStore();
  const queue = new MemoryQueue();
  const now = () => new Date().toISOString();
  const fetchImpl: typeof fetch = async (url, init) => {
    const r = await fetch(url, init);
    if (o.dropExchange && String(url).endsWith('/item/public_token/exchange')) { await r.text(); o.dropExchange = false; throw new Error('LIVE-FAULT: exchange response discarded'); }
    return r;
  };
  const http = new PlaidHttp({ clientId: process.env.PLAID_CLIENT_ID!, secret: process.env.PLAID_SECRET!, env: process.env.PLAID_ENV!, store, grant: S2_GRANT, now, fetchImpl });
  const vault = new LocalVault();
  const pp = new FakePayPal();
  pp.balance.asOf = new Date(Date.now() - 2 * 3600_000).toISOString();
  const d: Deps = {
    store, queue, now, reader: pp.reader, writer: pp.writer, hooks: o.hooks ?? {}, vault,
    plaid: { reader: plaidReader(http), connector: plaidConnector(http) },
    config: { stage: 'local', connectionId: 'pp-stub', merchantEmail: 'merchant@example.com', webhookId: null, grant: S2_GRANT },
  };
  const api = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const r = await handle({ store, queue, config: d.config, now, plaidLink: plaidLinkToken(http), vault }, { method, path, headers: { ...(method === 'POST' ? { 'idempotency-key': crypto.randomUUID() } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body), identity: { sub: 'live-owner', email: 'live@example.com' } });
    return { status: r.status, body: JSON.parse(r.body) };
  };
  /** Sweep + worker until quiet or `until` holds (real time). */
  const drain = async (until: () => Promise<boolean> = async () => false, ms = 60_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      await sweep({ store, queue, now });
      for (let id = queue.take(); id; id = queue.take()) { try { await processJob(d, id); } catch (e) { if (!(e instanceof SimulatedCrash)) throw e; } }
      if (await until()) return true;
      await sleep(1_000);
    }
    return until();
  };
  const bank = async () => (await api('GET', '/v1/cash/position')).body.sources[1];
  const harness = (path: string, body: Record<string, unknown>) => http.call(path, body); // test harness only
  return { store, d, api, drain, bank, harness, vault };
}
async function tenant(s: ReturnType<typeof stack>, bank: 'seed' | 'none') {
  await bootstrapTenant(s.store, { sub: 'live-owner', email: 'live@example.com', tenantId: 'tenant-live', connectionId: 'pp-stub' });
  const r = await operatorReset(s.d, 'tenant-live', 'S2 live case', { bank });
  if (bank === 'none') return r;
  await s.drain(async () => (await operatorGetRun(s.d, 'tenant-live'))!.state !== 'PREPARING', 120_000);
  return operatorGetRun(s.d, 'tenant-live');
}
async function connectSandboxUser(s: ReturnType<typeof stack>, username: string) {
  const pt = await s.harness('/sandbox/public_token/create', { institution_id: 'ins_109508', initial_products: ['transactions'], options: { override_username: username, override_password: 'pass_good' } });
  if (pt.status !== 200) throw new Error(`sandbox public token ${pt.status} ${pt.body?.error_code}`);
  const ex = await s.api('POST', '/v1/cash/bank/exchange', { publicToken: pt.body.public_token, institutionId: 'ins_109508', institutionName: 'First Platypus Bank' });
  if (ex.status !== 202) throw new Error(`exchange claim ${ex.status} ${JSON.stringify(ex.body)}`);
  await s.drain(async () => ['HEALTHY', 'RECONNECT_REQUIRED'].includes((await s.bank()).state) && !(await s.bank()).historyLoading, 120_000);
  return s.bank();
}
async function cleanup(s: ReturnType<typeof stack>) {
  const b = await s.bank();
  if (b.state === 'NOT_CONNECTED' || b.state === 'DISCONNECTED') return;
  await s.api('POST', '/v1/cash/bank/disconnect', undefined, { 'if-match': String(b.connection.version) });
  await s.drain(async () => (await s.bank()).state === 'DISCONNECTED', 60_000);
}
const accessTokenOf = async (s: ReturnType<typeof stack>) => {
  const run = await operatorGetRun(s.d, 'tenant-live');
  const conn = await s.store.get('provider', K.plaid(run!.bank!.itemId as string), 'ITEM');
  return unseal(s.vault, conn!.sealedAccessToken);
};

/** Test harness for the browser reconnect case: break the active run's Item login (local snapshot or dev DynamoDB + KMS). */
async function breakLogin(stage: string) {
  const { readFileSync } = await import('node:fs');
  let store, vault, tenantId;
  if (stage === 'local') {
    store = new MemoryStore('.headroom-local/store.json'); // read only: nothing is written back
    vault = new LocalVault(Buffer.from(readFileSync('.headroom-local/vault-key', 'utf8'), 'base64'));
    tenantId = 'tenant-local';
  } else {
    process.env.AWS_PROFILE ??= 'headroom-admin';
    process.env.AWS_REGION ??= 'us-east-1';
    const { DynamoStore } = await import('../../backend/src/adapters/store/dynamodb.ts');
    const { kmsVault } = await import('../../backend/src/adapters/vault.ts');
    const out = JSON.parse(readFileSync('.headroom-local/dev-outputs.json', 'utf8')).HeadroomDev;
    store = new DynamoStore({ core: 'HeadroomDev-core', work: 'HeadroomDev-work', provider: 'HeadroomDev-provider', audit: 'HeadroomDev-audit' });
    vault = await kmsVault(out.PlaidKeyId);
    tenantId = arg('--tenant') ?? 'tenant-owner';
  }
  const fence = await store.get('core', K.tenant(tenantId), 'RUN_FENCE');
  const b = await store.get('core', K.run(tenantId, fence!.runId), 'CONN#plaid');
  const conn = await store.get('provider', K.plaid(b!.itemId), 'ITEM');
  const token = await unseal(vault, conn!.sealedAccessToken);
  const http = new PlaidHttp({ clientId: process.env.PLAID_CLIENT_ID!, secret: process.env.PLAID_SECRET!, env: process.env.PLAID_ENV!, store: new MemoryStore(), grant: S2_GRANT, now: () => new Date().toISOString() });
  const r = await http.call('/sandbox/item/reset_login', { access_token: token });
  record('A3-break', 'TEST-HARNESS', r.status === 200, `/sandbox/item/reset_login on item ${pseud(b!.itemId)} (${stage}) → ${r.status}`);
}

const cases: Record<string, () => Promise<void>> = {
  'A3-break': () => breakLogin(arg('--stage') ?? 'local'),
  async env5() {
    const s = stack();
    await tenant(s, 'none');
    const r = await s.api('POST', '/v1/cash/bank/link-token', { mode: 'connect' });
    record('ENV-5', 'LIVE', r.status === 200 && typeof r.body.linkToken === 'string', `/link/token/create ${r.status}${r.body.code ? ` ${r.body.message}` : ''}`);
  },
  async A1() {
    const s = stack();
    await tenant(s, 'none');
    const b = await connectSandboxUser(s, 'user_good');
    const roles = b.accounts.map((a: any) => `${a.subtype}:${a.role}`).join(',');
    const nullAvail = b.accounts.filter((a: any) => a.type === 'depository' && a.provider.available === null);
    const card = b.accounts.find((a: any) => a.type === 'credit');
    // Without a pinned Plaid-Version the sandbox omits currency fields (seen 1 Nov 2026); the adapter pins 2020-09-14. Rule (S2-PR-07)
    // still holds if a currency is ever missing: shown exactly, never counted.
    const noCurrency = b.accounts.filter((a: any) => (a.provider.available ?? a.provider.current)?.currencyKind === 'UNKNOWN');
    const ok = b.state === 'HEALTHY' && b.accounts.some((a: any) => a.role === 'COUNTED') && card?.role === 'OWED' && nullAvail.every((a: any) => a.eligible === null) && noCurrency.every((a: any) => a.eligible === null) && b.freshness === 'RECENT'
      && b.accounts.filter((a: any) => a.role === 'COUNTED').every((a: any) => a.provider.available?.currencyCode === 'USD');
    record('S2-A1', 'LIVE', ok, `user_good via product exchange → ${b.state}; ${b.accounts.length} accounts (${roles}); counted ${b.counted?.minor ?? 'null'}; currency not reported on ${noCurrency.length} accounts (none counted); null-available depository: ${nullAvail.map((a: any) => a.subtype).join(',') || 'none'} (not counted)`);
    await cleanup(s);
  },
  async A2() {
    const s = stack();
    const r1 = await tenant(s, 'seed');
    const b1 = await s.bank();
    const r2 = await operatorReset(s.d, 'tenant-live', 'S2-A2 second reset', { bank: 'seed' }).then(async () => { await s.drain(async () => (await operatorGetRun(s.d, 'tenant-live'))!.state !== 'PREPARING', 120_000); return operatorGetRun(s.d, 'tenant-live'); });
    await s.drain(async () => (await s.store.get('provider', K.plaid(r1!.bank!.itemId as string), 'ITEM'))?.state === 'DISCONNECTED', 60_000);
    const old = await s.store.get('provider', K.plaid(r1!.bank!.itemId as string), 'ITEM');
    const b2 = await s.bank();
    const body = JSON.stringify(b2);
    const leaked = [r1!.bank!.itemId as string, ...(r1!.bank!.accountIds as string[])].filter((x) => body.includes(x));
    const ok = r1!.state === 'READY' && r2!.state === 'READY' && r1!.bank!.fingerprint === r2!.bank!.fingerprint && r1!.bank!.itemId !== r2!.bank!.itemId && !leaked.length && old?.state === 'DISCONNECTED'
      && b2.counted?.minor === 813_000 && b2.accounts.length === 2 && b2.accounts.every((a: any) => a.role === 'COUNTED');
    record('S2-A2', 'LIVE+SEEDED', ok, `fingerprints ${r1!.bank!.fingerprint} / ${r2!.bank!.fingerprint}; items ${pseud(r1!.bank!.itemId as string)} → ${pseud(r2!.bank!.itemId as string)}; old item ${old?.state}; leaked old ids ${leaked.length}; checking counted ${b2.counted?.minor} across ${b2.accounts.length} checking accounts`);
    // S2-R2 (null available) is asserted on the live user_good CD in S2-A1; the seeded demo bank is two checking accounts (owner, 1 Nov 2026).
    const cands = b1.activity.rows.filter((r: any) => r.paypalCandidate).map((r: any) => r.description).sort();
    record('S2-R4', 'LIVE+SEEDED', cands.join('|') === 'PAYPAL INST XFER ADD FUNDS|PAYPAL TRANSFER WITHDRAWAL', `PayPal candidates: ${cands.join(', ')} (labelled "not verified"; never receipt/funding)`);
    await cleanup(s);
  },
  async A3() {
    const s = stack();
    await tenant(s, 'none');
    await connectSandboxUser(s, 'user_good');
    const token = await accessTokenOf(s);
    const rl = await s.harness('/sandbox/item/reset_login', { access_token: token });
    await s.api('POST', '/v1/cash/bank/refresh');
    await s.drain(async () => (await s.bank()).state === 'RECONNECT_REQUIRED', 60_000);
    const b = await s.bank();
    const c = (await s.api('GET', '/v1/cash/position')).body;
    const upd = await s.api('POST', '/v1/cash/bank/link-token', { mode: 'update' });
    record('S2-A3', 'LIVE', rl.status === 200 && b.state === 'RECONNECT_REQUIRED' && b.retrievedAt && b.counted !== undefined && c.currentBadge.reasons.includes('Bank needs reconnecting') && upd.status === 200,
      `reset_login ${rl.status} → ${b.state}; last read kept (${b.retrievedAt}); badge "${c.currentBadge.reasons.find((x: string) => /Bank/.test(x))}"; update-mode link token ${upd.status}. Link's password step is a browser case (S2-U1)`);
    await cleanup(s);
  },
  async R3() {
    const s = stack();
    await tenant(s, 'none');
    await connectSandboxUser(s, 'user_good');
    const token = await accessTokenOf(s);
    const rm = await s.harness('/item/remove', { access_token: token }); // out of band: Plaid forgets the Item
    await s.api('POST', '/v1/cash/bank/refresh');
    await s.drain(async () => (await s.bank()).state === 'REVOKED', 60_000);
    const b = await s.bank();
    const c = (await s.api('GET', '/v1/cash/position')).body;
    record('S2-R3', 'LIVE', rm.status === 200 && b.state === 'REVOKED' && !b.contributes && c.totals.parts.bank === null && !!b.retrievedAt, `out-of-band remove ${rm.status} → ${b.state}; contributes ${b.contributes}; last read ${b.retrievedAt} kept; parts.bank ${c.totals.parts.bank}`);
    await cleanup(s);
    record('S2-R14', 'LIVE', (await s.bank()).state === 'DISCONNECTED', `Disconnect of a revoked Item → /item/remove answers ITEM_NOT_FOUND → ${(await s.bank()).state}`);
  },
  async R1() {
    const s = stack();
    await tenant(s, 'none');
    await connectSandboxUser(s, 'user_transactions_dynamic');
    const token = await accessTokenOf(s);
    const itemId = (await operatorGetRun(s.d, 'tenant-live'))!.bank!.itemId as string;
    const before = countedRows(decodeProjection((await s.store.get('provider', K.plaid(itemId), 'TXNS')) as never));
    const rf = await s.harness('/transactions/refresh', { access_token: token });
    let after = before;
    for (let i = 0; i < 12; i++) {
      await sleep(5_000);
      await s.api('POST', '/v1/cash/bank/refresh');
      await s.drain(async () => false, 8_000);
      after = countedRows(decodeProjection((await s.store.get('provider', K.plaid(itemId), 'TXNS')) as never));
      if (after.some((r) => r.pendingTransactionId)) break;
    }
    const all = decodeProjection((await s.store.get('provider', K.plaid(itemId), 'TXNS')) as never);
    const posted = new Set(all.filter((r) => r.state === 'posted' && r.pendingTransactionId).map((r) => r.pendingTransactionId));
    const orphan = after.filter((r) => r.state === 'pending' && posted.has(r.transactionId)).length;
    record('S2-R1', 'LIVE', rf.status === 200 && posted.size > 0 && orphan === 0, `refresh ${rf.status}; ${before.length} → ${after.length} counted rows; ${posted.size} posted rows replacing a pending; ${orphan} pending left active next to its successor`);
    await s.api('POST', '/v1/cash/bank/refresh');
    const synced = () => s.store.dump('audit').filter((a) => a.eventType === 'BankTransactionsSynced').length;
    const n0 = synced();
    await s.drain(async () => false, 6_000);
    record('S2-R5/B1', 'LIVE', synced() === n0, `repeat sync after settle: ${synced() - n0} BankTransactionsSynced audits (0 = nothing changed)`);
    await cleanup(s);
  },
  async R22() {
    const s = stack({ dropExchange: true });
    await tenant(s, 'none');
    const pt = await s.harness('/sandbox/public_token/create', { institution_id: 'ins_109508', initial_products: ['transactions'], options: { override_username: 'user_good', override_password: 'pass_good' } });
    await s.api('POST', '/v1/cash/bank/exchange', { publicToken: pt.body.public_token });
    await s.drain(async () => { const x = await s.bank(); return x.pendingEffect?.canAbandon === true || x.state === 'HEALTHY'; }, 90_000);
    const b = await s.bank();
    if (b.state === 'HEALTHY') {
      // Observed 1 Nov 2026: the sandbox answers a same-token replay with 200, so the replay recovers the lost response.
      const ex = s.store.dump('work').find((i) => i.pk.startsWith('EFFECT#bankconn#'));
      record('S2-R22c', 'LIVE-FAULT', ex?.state === 'VERIFIED_SUCCESS' && ex?.replayed === true && s.store.dump('provider').filter((i) => i.sk === 'ITEM').length === 1,
        `genuine sandbox exchange, response discarded by the test transport → UNKNOWN → same-token replay answered 200 → Headroom bound exactly one Item (replayed=${ex?.replayed}). Whether Plaid also holds an Item behind the discarded response is not observable`);
      await cleanup(s);
      return;
    }
    const ab = b.pendingEffect?.canAbandon ? await s.api('POST', '/v1/cash/bank/connect/abandon', undefined, { 'if-match': String(b.pendingEffect.effectVersion) }) : null;
    record('S2-R22c', 'LIVE-FAULT', b.pendingEffect?.state === 'UNKNOWN' && b.pendingEffect.canAbandon && ab?.status === 200,
      `genuine sandbox exchange, response discarded by the test transport → ${b.pendingEffect?.state}; same-token replay → "${b.pendingEffect?.reason}"; owner Abandon ${ab?.status}. One orphan sandbox Item expires in 30 days`);
  },
};

// ---------- dev stage (deployed stack, real IAM, Cognito) ----------
const devOut = () => JSON.parse(readFileSync('.headroom-local/dev-outputs.json', 'utf8')).HeadroomDev;
async function devApi(userKey: 'ownerA' | 'ownerB') {
  const { chromium } = await import('playwright-core');
  const creds = JSON.parse(readFileSync('.headroom-local/dev-users.json', 'utf8'))[userKey];
  const out = devOut();
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
    const r = await fetch(`${out.SiteUrl}${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(method === 'POST' ? { 'idempotency-key': crypto.randomUUID() } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) as any };
  };
}
const until = async (f: () => Promise<boolean>, ms: number) => { const end = Date.now() + ms; while (Date.now() < end) { if (await f()) return true; await sleep(3_000); } return f(); };
const devStore = async () => { process.env.AWS_PROFILE ??= 'headroom-admin'; process.env.AWS_REGION ??= 'us-east-1'; const { DynamoStore } = await import('../../backend/src/adapters/store/dynamodb.ts'); return new DynamoStore({ core: 'HeadroomDev-core', work: 'HeadroomDev-work', provider: 'HeadroomDev-provider', audit: 'HeadroomDev-audit' }); };
async function devOperator(payload: unknown) { process.env.AWS_PROFILE ??= 'headroom-admin'; const { invokeOperator } = await import('../demo/operator-client.ts'); return invokeOperator(payload); }

Object.assign(cases, {
  /** S2-A2 on dev: a second seeded reset through the operator Lambda; the deployed worker seeds, syncs and removes the old Item. */
  async 'dev-A2'() {
    const r1 = await devOperator({ action: 'getRun', tenantId: 'tenant-owner' });
    await devOperator({ action: 'reset', tenantId: 'tenant-owner', reason: 'S2-A2 dev second reset', bank: 'seed' });
    let r2: any;
    await until(async () => (r2 = await devOperator({ action: 'getRun', tenantId: 'tenant-owner' })).state !== 'PREPARING', 600_000);
    const store = await devStore();
    await until(async () => (await store.get('provider', K.plaid(r1.bank.itemId), 'ITEM'))?.state === 'DISCONNECTED', 120_000);
    const old = await store.get('provider', K.plaid(r1.bank.itemId), 'ITEM');
    record('S2-A2 (dev)', 'LIVE+SEEDED', r2.state === 'READY' && r2.bank.fingerprint === r1.bank.fingerprint && r2.bank.itemId !== r1.bank.itemId && old?.state === 'DISCONNECTED' && !old?.sealedAccessToken,
      `run ${r1.runId} → ${r2.runId} ${r2.state}; fingerprint ${r1.bank.fingerprint} / ${r2.bank.fingerprint}; item ${pseud(r1.bank.itemId)} → ${pseud(r2.bank.itemId)}; old item ${old?.state}, credential ${old?.sealedAccessToken ? 'kept' : 'dropped'}`);
  },
  /** S2-R12 on dev: two Cognito users; B has no bank. */
  async 'dev-R12'() {
    const a = await devApi('ownerA');
    const b = await devApi('ownerB');
    const ca = (await a('GET', '/v1/cash/position')).body;
    const runB = await devOperator({ action: 'getRun', tenantId: 'tenant-b' });
    const refusals = [];
    for (const [path, body, headers] of [['/v1/cash/bank/refresh', undefined, {}], ['/v1/cash/bank/disconnect', undefined, { 'if-match': '1' }], ['/v1/cash/bank/link-token', { mode: 'update' }, {}]] as const) {
      const r = await b('POST', path, body, headers as Record<string, string>);
      refusals.push(`${path.split('/').pop()} ${r.status} ${r.body?.code}`);
    }
    const bodies = JSON.stringify([(await b('GET', '/v1/cash/position')).body, (await b('GET', '/v1/overview')).body]);
    const ids = [ca.sources[1].accounts.map((x: any) => x.accountId), ca.sources[1].activity.rows.map((x: any) => x.transactionId)].flat();
    const leaked = ids.filter((id: string) => bodies.includes(id));
    record('S2-R12 (dev)', 'LIVE', runB?.state !== undefined && refusals.every((x) => x.includes('409 NOT_CONNECTED')) && !leaked.length && ids.length > 0,
      `tenant-b run ${runB?.runId} (${runB?.state}); B: ${refusals.join('; ')}; A ids checked ${ids.length}, leaked ${leaked.length}`);
  },
  /** S2-R31 on dev: Disconnect → Connect again with the real deployed roles; no AccessDenied in api/worker logs. */
  async 'dev-R31'() {
    const startMs = Date.now();
    const a = await devApi('ownerA');
    const bank = async () => (await a('GET', '/v1/cash/position')).body.sources[1];
    let b = await bank();
    const dc = await a('POST', '/v1/cash/bank/disconnect', undefined, { 'if-match': String(b.connection.version) });
    const contributesAfter = (await bank()).contributes;
    await until(async () => (await bank()).state === 'DISCONNECTED', 180_000);
    const lt = await a('POST', '/v1/cash/bank/link-token', { mode: 'connect' });
    const http = new PlaidHttp({ clientId: process.env.PLAID_CLIENT_ID!, secret: process.env.PLAID_SECRET!, env: 'sandbox', store: new MemoryStore(), grant: S2_GRANT, now: () => new Date().toISOString() });
    const pt = await http.call('/sandbox/public_token/create', { institution_id: 'ins_109508', initial_products: ['transactions'], options: { override_username: 'user_good', override_password: 'pass_good' } });
    const ex = await a('POST', '/v1/cash/bank/exchange', { publicToken: pt.body.public_token, institutionId: 'ins_109508', institutionName: 'First Platypus Bank' });
    await until(async () => { const x = await bank(); return x.state === 'HEALTHY' && !x.historyLoading; }, 300_000);
    b = await bank();
    const upd = await a('POST', '/v1/cash/bank/link-token', { mode: 'update' });
    const { execFileSync } = await import('node:child_process');
    const denied = ['api', 'worker'].map((f) => {
      const o = JSON.parse(execFileSync('aws', ['logs', 'filter-log-events', '--log-group-name', `/aws/lambda/HeadroomDev-${f}`, '--start-time', String(startMs), '--filter-pattern', '"AccessDenied"', '--output', 'json', '--profile', process.env.AWS_PROFILE ?? 'headroom-admin', '--region', 'us-east-1'], { encoding: 'utf8' }));
      return `${f}:${o.events.length}`;
    });
    record('S2-R31 (dev)', 'LIVE', dc.status === 202 && contributesAfter === false && lt.status === 200 && ex.status === 202 && b.state === 'HEALTHY' && b.connection.basis === 'OWNER_LINKED' && upd.status === 200 && denied.every((x) => x.endsWith(':0')),
      `disconnect ${dc.status} (contributes immediately ${contributesAfter}) → DISCONNECTED → link token ${lt.status} → exchange claim ${ex.status} → ${b.state} (${b.connection.basis}, counted ${b.counted?.minor}); update-mode token ${upd.status} (api KMS Decrypt); AccessDenied log events ${denied.join(', ')}`);
  },
  /** S2-R9/R25/R26 on real DynamoDB (STUB Plaid, separate tenant): the real conditional writes decide the races. */
  async 'dev-ddb'() {
    const { FakePlaid } = await import('../../tests/acceptance/fake-plaid.ts');
    const store = await devStore();
    const queue = new MemoryQueue();
    const fp = new FakePlaid();
    fp.today = () => new Date().toISOString().slice(0, 10);
    const vault = new LocalVault();
    let hook: ((p: string) => Promise<void>) | null = null;
    const pp = new FakePayPal();
    pp.balance.asOf = new Date(Date.now() - 2 * 3600_000).toISOString();
    const grant = { ...S2_GRANT, id: 'S2-STUB' };
    const d: Deps = { store, queue, now: () => new Date().toISOString(), reader: pp.reader, writer: pp.writer, vault, plaid: { reader: fp.reader, connector: fp.connector },
      hooks: { beforeBankCommit: async (p) => { if (hook) await hook(p); } }, config: { stage: 'dev', connectionId: 'stub-bank', merchantEmail: 'm@example.com', webhookId: null, grant } };
    await bootstrapTenant(store, { sub: 'stub-bank-owner', email: 'stub-bank@example.com', tenantId: 'tenant-stub-bank', connectionId: 'stub-bank' });
    const api = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
      const r = await handle({ store, queue, config: d.config, now: d.now, plaidLink: fp.linkToken, vault }, { method, path, headers: { ...(method === 'POST' && !path.endsWith('/refresh') ? { 'idempotency-key': crypto.randomUUID() } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body), identity: { sub: 'stub-bank-owner', email: 'stub-bank@example.com' } });
      return { status: r.status, body: JSON.parse(r.body) };
    };
    const drain = async () => { for (let i = 0; i < 30; i++) { for (let id = queue.take(); id; id = queue.take()) { try { await processJob(d, id); } catch (e) { if (!(e instanceof SimulatedCrash)) throw e; } } if (!queue.pending.length) return; } };
    await operatorReset(d, 'tenant-stub-bank', 'STUB S2 races on dev DynamoDB', { bank: 'none' });
    await api('POST', '/v1/cash/bank/exchange', { publicToken: fp.linkPublicToken() });
    await drain();
    const b0 = (await api('GET', '/v1/cash/position')).body.sources[1];
    const itemId = (await operatorGetRun(d, 'tenant-stub-bank'))!.bank!.itemId as string;
    const syncs = async () => (await store.query('provider', K.plaid(itemId), { skPrefix: 'SYNC#' })).length;
    // R9: ten Refresh clicks → one publish per cursor.
    fp.addPage(itemId, 3);
    const s0 = await syncs();
    await Promise.all(Array.from({ length: 10 }, () => api('POST', '/v1/cash/bank/refresh')));
    await drain();
    record('S2-R9 (dev DDB)', 'STUB', (await syncs()) === s0 + 1, `bound ${b0.state}; 10 refreshes → ${(await syncs()) - s0} publish`);
    // R26: lease reclaimed before the publish commit → rejected by the real condition.
    fp.addPage(itemId, 2);
    const s1 = await syncs();
    hook = async (p) => { if (p === 'publish') { hook = null; const j = (await store.get('work', K.job(`plaid#${itemId}`), 'JOB'))!; await store.transact([{ op: 'update', table: 'work', pk: j.pk, sk: 'JOB', set: { leaseToken: j.leaseToken + 1 } }]); } };
    await api('POST', '/v1/cash/bank/refresh');
    await drain();
    const after26 = await syncs();
    record('S2-R26 (dev DDB)', 'STUB', after26 === s1, `stale holder's publish rejected by DynamoDB (${after26 - s1} publishes)`);
    // R25: Disconnect commits while the sync is paused before its balance commit → no OBS / STATUS ok / ITEM change.
    const j = (await store.get('work', K.job(`plaid#${itemId}`), 'JOB'))!;
    await store.transact([{ op: 'update', table: 'work', pk: j.pk, sk: 'JOB', set: { state: 'QUEUED', dueAt: d.now(), dueKey: `${d.now()}#${j.jobId}`, gsiDue: 'DUE', leaseUntil: null } }]);
    const obs0 = (await store.query('provider', K.plaid(itemId), { skPrefix: 'OBS#' })).length;
    const st0 = await store.get('provider', K.plaid(itemId), 'STATUS');
    hook = async (p) => { if (p === 'balance') { hook = null; const v = (await api('GET', '/v1/cash/position')).body.sources[1].connection.version; await api('POST', '/v1/cash/bank/disconnect', undefined, { 'if-match': String(v) }); } };
    queue.pending.push(`plaid#${itemId}`);
    await drain();
    const conn = await store.get('provider', K.plaid(itemId), 'ITEM');
    const obs1 = (await store.query('provider', K.plaid(itemId), { skPrefix: 'OBS#' })).length;
    const st1 = await store.get('provider', K.plaid(itemId), 'STATUS');
    record('S2-R25 (dev DDB)', 'STUB', obs1 === obs0 && JSON.stringify(st1) === JSON.stringify(st0) && ['DISCONNECTING', 'DISCONNECTED'].includes(conn!.state),
      `disconnect mid-sync: OBS ${obs0} → ${obs1}; STATUS unchanged ${JSON.stringify(st1) === JSON.stringify(st0)}; item ${conn!.state}`);
    // Retire the stub tenant's remaining jobs so the deployed sweep never runs them (they'd hit the real worker without the stub).
    for (const job of (await store.dueJobs('9999-12-31T00:00:00.000Z', 1000)).filter((x: any) => x.tenantId === 'tenant-stub-bank'))
      await store.transact([{ op: 'update', table: 'work', pk: job.pk, sk: 'JOB', set: { state: 'DONE', lastError: 'retired after STUB case' }, remove: ['gsiDue', 'dueKey'] }]);
  },
});

const order = ['env5', 'A1', 'A2', 'A3', 'R3', 'R1', 'R22'];
for (const c of which === 'all' ? order : which.split(',')) {
  try { await cases[c](); } catch (e) { record(c, 'LIVE', false, `threw: ${(e as Error).message}`); }
}
if (outDir) { mkdirSync(outDir, { recursive: true }); writeFileSync(`${outDir}/results.json`, JSON.stringify({ at: new Date().toISOString(), grant: 'PLAID-S2 / PP-S2', results }, null, 2)); }
console.log(`${results.filter((r) => r.ok).length}/${results.length} passed`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
