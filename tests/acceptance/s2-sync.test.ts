import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { harness } from './harness.ts';
import { K } from '../../backend/src/adapters/store/keys.ts';
import { SimulatedCrash } from '../../backend/src/deps.ts';
import { operatorGetRun } from '../../backend/src/handlers/operator.ts';
import { countedRows, decodeProjection } from '../../backend/src/domain/bank-mirror/bank.ts';
import { MAX_STAGED_PAGES } from '../../backend/src/domain/bank-mirror/observe-bank.ts';

type H = Awaited<ReturnType<typeof harness>>;
const itemOf = async (h: H) => (await operatorGetRun(h.deps, 'tenant-a'))!.bank!.itemId as string;
const publishes = (h: H, itemId: string) => h.store.dump('provider').filter((i) => i.pk === K.plaid(itemId) && i.sk.startsWith('SYNC#')).length;
const projection = async (h: H, itemId: string) => decodeProjection((await h.store.get('provider', K.plaid(itemId), 'TXNS')) as never);
const ready = async (o: Parameters<typeof harness>[0] = {}) => { const h = await harness({ plaid: true, ...o }); await h.drain(); return { h, itemId: await itemOf(h) }; };

test('S2-R6 MUTATION_DURING_PAGINATION mid-loop → stage abandoned, restart from c0 → one publish, no orphan pending (STUB)', async () => {
  const { h, itemId } = await ready();
  h.plaid.pageSize = 2;
  h.plaid.post(itemId, 'SUPPLIER ACME PARTS');
  h.plaid.addPage(itemId, 5);
  h.plaid.faults.add('sync-mutation');
  const before = publishes(h, itemId);
  const c0 = (await h.store.get('provider', K.plaid(itemId), 'TXNS'))!.cursor;
  await h.api('POST', '/v1/cash/bank/refresh');
  await h.drain();
  assert.equal(publishes(h, itemId), before + 1, 'exactly one publish for the update cycle');
  const rows = countedRows(await projection(h, itemId));
  assert.equal(rows.filter((r) => r.description === 'SUPPLIER ACME PARTS').length, 1, 'posted replaces pending: one debit');
  assert.equal(rows.find((r) => r.description === 'SUPPLIER ACME PARTS')!.state, 'posted');
  assert.ok(h.plaid.calls.filter((c) => c === `SYNC ${c0}`).length >= 2, 'restarted from the cycle-start cursor');
});

test('S2-R7 process dies after a staged page → nothing published; the next claim continues from the stage; result == clean sync', async () => {
  let n = 0;
  const { h, itemId } = await ready({ hooks: { beforeBankCommit: async (phase) => { if (phase === 'stage' && armed && ++n === 2) throw new SimulatedCrash('died mid-pagination'); } } });
  var armed = true; // eslint-disable-line no-var
  h.plaid.pageSize = 2;
  h.plaid.addPage(itemId, 5);
  const before = publishes(h, itemId);
  await h.api('POST', '/v1/cash/bank/refresh');
  await h.drain();
  assert.equal(publishes(h, itemId), before, 'nothing published while the worker is dead');
  armed = false;
  await h.advance(91_000);
  assert.equal(publishes(h, itemId), before + 1);
  const rows = countedRows(await projection(h, itemId));
  assert.equal(rows.filter((r) => r.description.startsWith('FILLER')).length, 5, 'no loss, no duplicate');
  const clean = await ready();
  clean.h.plaid.addPage(clean.itemId, 5);
  await clean.h.api('POST', '/v1/cash/bank/refresh');
  await clean.h.drain();
  const shape = (rs: typeof rows) => rs.map((r) => [r.description, r.amountMinor, r.state]).sort().join('|');
  assert.equal(shape(rows), shape(countedRows(await projection(clean.h, clean.itemId))));
});

test('S2-R8 TRANSACTIONS_SYNC_LIMIT mid-loop → nothing committed, stage kept, visible "Couldn\'t reach the bank", backoff; later one publish', async () => {
  let h!: H;
  let armed = false;
  const r = await ready({ hooks: { beforeBankCommit: async (p) => { if (armed && p === 'stage') { armed = false; h.plaid.faults.add('sync-limit'); } } } });
  h = r.h;
  const itemId = r.itemId;
  h.plaid.pageSize = 2;
  h.plaid.addPage(itemId, 5);
  armed = true; // the limit hits after the first page is staged: mid-loop
  const v0 = (await h.store.get('provider', K.plaid(itemId), 'TXNS'))!.version;
  await h.api('POST', '/v1/cash/bank/refresh');
  await h.drain();
  assert.equal((await h.store.get('provider', K.plaid(itemId), 'TXNS'))!.version, v0, 'cursor and projection untouched');
  const b = await h.bank();
  assert.equal(b.freshness, 'FAILED');
  assert.match(b.lastError, /Couldn't reach the bank \(TRANSACTIONS_SYNC_LIMIT/);
  const job = await h.store.get('work', K.job(`plaid#${itemId}`), 'JOB');
  assert.ok(job!.cycle.stagedPages >= 1, 'stage kept for the continuation');
  h.plaid.faults.delete('sync-limit');
  await h.advance(16_000);
  assert.equal((await h.store.get('provider', K.plaid(itemId), 'TXNS'))!.version, v0 + 1);
  assert.equal((await h.bank()).freshness, 'RECENT');
});

test('S2-R9 / probe B1, C1–C2 ten Refresh clicks + sweep → one cycle; a repeat sync changes nothing and is not audited', async () => {
  const { h, itemId } = await ready();
  h.plaid.addPage(itemId, 3);
  const before = publishes(h, itemId);
  await Promise.all(Array.from({ length: 10 }, () => h.api('POST', '/v1/cash/bank/refresh')));
  await h.drain();
  assert.equal(publishes(h, itemId), before + 1);
  const synced = () => h.store.dump('audit').filter((a) => a.eventType === 'BankTransactionsSynced').length;
  const s0 = synced();
  await h.api('POST', '/v1/cash/bank/refresh');
  await h.drain();
  assert.equal(synced(), s0, 'zero changes → no BankTransactionsSynced');
  assert.equal(countedRows(await projection(h, itemId)).filter((r) => r.description.startsWith('FILLER')).length, 3);
});

for (const phase of ['stage', 'publish', 'balance', 'error'] as const) {
  test(`S2-R25 Disconnect commits while the sync is paused before its ${phase} commit → commit rejected; no OBS / STATUS ok / ITEM change; no resurrection`, async () => {
    let h!: H;
    let armed = false;
    const { h: hh, itemId } = await ready({ hooks: { beforeBankCommit: async (p) => { if (armed && p === phase) { armed = false; const b = await h.bank(); assert.equal((await h.api('POST', '/v1/cash/bank/disconnect', undefined, { 'if-match': String(b.connection.version) })).status, 202); } } } });
    h = hh;
    if (phase === 'error') h.plaid.faults.add('balance-500');
    h.plaid.addPage(itemId, 2);
    const obs0 = h.store.dump('provider').filter((i) => i.pk === K.plaid(itemId) && i.sk.startsWith('OBS#')).length;
    const st0 = await h.store.get('provider', K.plaid(itemId), 'STATUS');
    armed = true;
    await h.api('POST', '/v1/cash/bank/refresh');
    await h.drain();
    await h.advance(91_000);
    const conn = await h.store.get('provider', K.plaid(itemId), 'ITEM');
    assert.equal(conn!.state, 'DISCONNECTED', 'removal proceeds; the paused sync never resurrects it');
    assert.equal(h.store.dump('provider').filter((i) => i.pk === K.plaid(itemId) && i.sk.startsWith('OBS#')).length, obs0, 'no observation appended');
    assert.deepEqual(await h.store.get('provider', K.plaid(itemId), 'STATUS'), st0, 'STATUS unchanged');
    if (phase === 'stage') assert.equal(h.store.dump('provider').filter((i) => i.pk === K.plaid(itemId) && i.sk.startsWith('STAGE#')).length, 1, 'only the initial cycle\'s page');
    assert.ok(h.store.dump('provider').some((i) => i.pk === K.plaid(itemId) && i.sk.startsWith('RAW#') && i.what === 'item/get'), 'raw bodies kept with their provenance');
  });
}

test('S2-R26 the lease is reclaimed before a sync commit → the stale worker\'s commit is rejected; the new holder publishes once', async () => {
  let h!: H;
  let armed = false;
  const { h: hh, itemId } = await ready({ hooks: { beforeBankCommit: async (p) => {
    if (armed && p === 'publish') { armed = false; const j = (await h.store.get('work', K.job(`plaid#${itemId}`), 'JOB'))!; await h.store.transact([{ op: 'update', table: 'work', pk: j.pk, sk: 'JOB', set: { leaseToken: j.leaseToken + 1 } }]); }
  } } });
  h = hh;
  h.plaid.addPage(itemId, 2);
  const before = publishes(h, itemId);
  armed = true;
  await h.api('POST', '/v1/cash/bank/refresh');
  await h.drain();
  assert.equal(publishes(h, itemId), before, 'stale commit rejected');
  await h.advance(91_000);
  assert.equal(publishes(h, itemId), before + 1);
});

test('S2-R29 slow pages: progress across invocations to ONE atomic publish within the per-job budget; never the same-cursor loop', async () => {
  const { h, itemId } = await ready();
  h.plaid.pageSize = 1;
  h.plaid.addPage(itemId, 6);
  h.plaid.delayMs = 9_000; // each call just under the 10 s timeout
  const before = publishes(h, itemId);
  const syncs0 = h.plaid.count('SYNC');
  await h.api('POST', '/v1/cash/bank/refresh');
  await h.drain();
  assert.equal(publishes(h, itemId), before + 1);
  const cursors = h.plaid.calls.filter((c) => c.startsWith('SYNC')).slice(syncs0);
  assert.equal(new Set(cursors).size, cursors.length, 'each cursor requested once');
  assert.ok(h.plaid.calls.length > 9, 'took several invocations');
});

test(`S2-R20 a cycle needing more than ${MAX_STAGED_PAGES} pages → visible refusal, nothing published, previous projection intact`, async () => {
  const { h, itemId } = await ready();
  h.plaid.pageSize = 1;
  h.plaid.addPage(itemId, MAX_STAGED_PAGES + 1);
  const t0 = await h.store.get('provider', K.plaid(itemId), 'TXNS');
  await h.api('POST', '/v1/cash/bank/refresh');
  await h.drain();
  assert.deepEqual(await h.store.get('provider', K.plaid(itemId), 'TXNS'), t0);
  assert.equal((await h.bank()).lastError, 'Bank history too large for this build');
});

test('S2-R19 history not ready → run stays PREPARING, "history still loading", partial history published; re-sync in 1 min → READY', async () => {
  const h = await harness({ plaid: true, bank: 'none' });
  await h.drain();
  const orig = h.plaid.connector.exchange;
  h.plaid.connector.exchange = async (t) => { const r = await orig(t); for (const it of h.plaid.items.values()) it.updateStatus = 'INITIAL_UPDATE_COMPLETE'; return r; };
  const { operatorReset } = await import('../../backend/src/handlers/operator.ts');
  await operatorReset(h.deps, 'tenant-a', 'slow history', { bank: 'seed', hero: false });
  await h.drain();
  assert.equal((await operatorGetRun(h.deps, 'tenant-a'))!.state, 'PREPARING');
  const b = await h.bank();
  assert.deepEqual([b.state, b.historyLoading, b.counted.minor], ['HEALTHY', true, 813_000], 'balances shown while history loads');
  for (const it of h.plaid.items.values()) it.updateStatus = 'HISTORICAL_UPDATE_COMPLETE';
  await h.advance(61_000);
  assert.equal((await operatorGetRun(h.deps, 'tenant-a'))!.state, 'READY');
  assert.equal((await h.bank()).historyLoading, false);
});

test('10-minute readiness deadline: a seed that never finishes → BLOCKED "Bank not ready within 10 min"', async () => {
  const h = await harness({ plaid: true, bank: 'none' });
  await h.drain();
  h.plaid.faults.add('balance-500');
  const { operatorReset } = await import('../../backend/src/handlers/operator.ts');
  await operatorReset(h.deps, 'tenant-a', 'balance never reads', { bank: 'seed', hero: false });
  await h.drain();
  for (let i = 0; i < 11; i++) await h.advance(60_000);
  const run = await operatorGetRun(h.deps, 'tenant-a');
  assert.equal(run!.state, 'BLOCKED');
  assert.match(run!.blockers.join(';'), /Bank not ready within 10 min: Couldn't reach the bank/);
});

test('S2-R28 / S2-PR-05 validUntil drives refetch: crossing retrievedAt+15 min and the PayPal 3 h boundary changes the DTO with no audit event', async () => {
  const { h } = await ready();
  const c0 = await h.cash();
  assert.equal(c0.sources[1].freshness, 'RECENT');
  assert.equal(c0.validUntil, '2026-11-01T14:15:00.001Z', 'earliest of bank +15 min, bank +3 h, PayPal as-of +3 h, grant expiry');
  const audits = h.store.dump('audit').length;
  h.setNow('2026-11-01T14:15:00.002Z');
  const c1 = await h.cash();
  assert.equal(c1.sources[1].freshness, 'AGING');
  assert.equal(c1.validUntil, '2026-11-01T15:00:00.001Z', 'next: PayPal STALE at as-of + 3 h');
  h.setNow('2026-11-01T15:00:00.002Z');
  assert.equal((await h.cash()).sources[0].refreshState, 'STALE');
  assert.equal(h.store.dump('audit').length, audits, 'no audit event fabricated for elapsed time');
  assert.equal((await h.api('GET', '/v1/overview')).body.validUntil, '2026-11-01T17:00:00.001Z');
});

test('S2-R30 provider amounts through schema → producer → consumer: EUR, unofficial currency, non-cent value shown exactly, never counted', async () => {
  const h = await harness({ plaid: true, bank: 'none' });
  await h.drain();
  const config = { override_accounts: [
    { type: 'depository', subtype: 'checking', starting_balance: 100, currency: 'USD', meta: { name: 'Ops', mask: '1111' } },
    { type: 'depository', subtype: 'checking', starting_balance: 123.45, currency: 'EUR', balances: { available: null }, meta: { name: 'Euro', mask: '2222' } },
    { type: 'depository', subtype: 'checking', starting_balance: 5, currency: null, unofficial: 'XBT', meta: { name: 'Coin', mask: '3333' } },
    { type: 'depository', subtype: 'checking', starting_balance: 1024.502621, currency: 'USD', balances: { available: null, current: 1024.502621 }, meta: { name: 'Odd', mask: '4444' } },
  ] };
  await h.api('POST', '/v1/cash/bank/exchange', { publicToken: h.plaid.linkPublicToken(config) });
  await h.drain();
  const b = await h.bank();
  const by = (m: string) => b.accounts.find((a: any) => a.mask === m);
  assert.deepEqual([by('2222').provider.current, by('2222').refusal, by('2222').eligible], [{ value: '123.45', currencyCode: 'EUR', currencyKind: 'ISO' }, 'UNSUPPORTED_CURRENCY', null]);
  assert.deepEqual([by('3333').provider.available.currencyKind, by('3333').eligible], ['UNOFFICIAL', null]);
  assert.deepEqual([by('4444').provider.current.value, by('4444').eligible], ['1024.502621', null]);
  assert.equal(b.counted, null, 'a checking account not countable makes the bank figure incomplete');
  assert.deepEqual(b.incomplete, ['Euro ··2222', 'Coin ··3333', 'Odd ··4444']);
  assert.equal((await h.cash()).totals.parts.bank, null);
});

test('invariant 16 / S2-PR-01 import graph: only the worker reaches the Plaid connector; no product file has the test-harness calls; bank never funds PayPal (invariant 6)', () => {
  const root = resolve(import.meta.dirname, '../../backend/src');
  const graph = (entry: string) => {
    const seen = new Set<string>();
    const walk = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      // static imports, re-exports and dynamic import() (S2-IR-11); type-only imports carry no code
      for (const m of readFileSync(file, 'utf8').matchAll(/^(?:import|export)\s+(?!type\b)[^'";]*?from\s+['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]\s*\)/gm)) walk(resolve(dirname(file), m[1] ?? m[2]));
    };
    walk(resolve(root, entry));
    return [...seen];
  };
  for (const entry of ['handlers/api.ts', 'handlers/webhook.ts', 'handlers/sweep.ts', 'handlers/operator-lambda.ts']) {
    assert.ok(!graph(entry).some((f) => f.endsWith('adapters/plaid/connector.ts')), `${entry} reaches the Plaid connector`);
  }
  assert.ok(graph('handlers/worker.ts').some((f) => f.endsWith('adapters/plaid/connector.ts')));
  for (const entry of ['domain/paypal-mirror/observe-balance.ts', 'domain/paypal-mirror/reconcile-invoice.ts', 'domain/executor/invoice-issue.ts', 'domain/cash-forecast/estimate.ts']) {
    assert.ok(!graph(entry).some((f) => f.includes('/bank-mirror/')), `${entry} imports bank-mirror (bank never funds PayPal)`);
  }
  const files = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? files(p) : [p]; });
  for (const f of [...files(root), ...files(resolve(root, '../../web/src'))].filter((x) => /\.(ts|tsx)$/.test(x) && !x.endsWith('.test.ts'))) {
    const src = readFileSync(f, 'utf8');
    assert.ok(!src.includes('/sandbox/item/reset_login') && !src.includes("'/transactions/refresh'"), `${f} contains a test-harness Plaid call`);
  }
  const callers = files(root).filter((f) => !f.endsWith('.test.ts') && /\.connector!?\.\w|connector\.(exchange|remove|sandboxPublicTokenCreate)/.test(readFileSync(f, 'utf8')));
  assert.deepEqual(callers.map((f) => f.slice(root.length + 1)), ['domain/executor/bank-effects.ts'], 'connector methods are called only from the bank effect executor');
});
