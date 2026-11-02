// Regression tests for the S2 implementation-review findings S2-IM-01…05 (Codex, 1 Nov 2026). STUB Plaid.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.ts';
import { K } from '../../backend/src/adapters/store/keys.ts';
import { processBatch, processJob } from '../../backend/src/jobs/worker.ts';
import { operatorReset } from '../../backend/src/handlers/operator.ts';

type H = Awaited<ReturnType<typeof harness>>;
const seedEffect = async (h: H) => h.store.dump('work').find((i) => i.pk.startsWith('EFFECT#bankseed#') && i.state !== 'VERIFIED_SUCCESS')!;

test('S2-IM-01 a seed never dispatches without budget for the call + capture; it yields READY, then CREATED, and continues with the same key', async () => {
  const h = await harness({ plaid: true, bank: 'none' });
  await h.drain();
  await operatorReset(h.deps, 'tenant-a', 'budget', { bank: 'seed', hero: false });
  const e0 = await seedEffect(h);
  const jobId = `eff#${e0.effectKey}`;
  h.queue.pending.length = 0;
  h.plaid.delayMs = 16_000;
  await processJob(h.deps, jobId, 15_000); // late batch slot: deadline = 5 s
  assert.equal(h.plaid.count('SANDBOX_CREATE'), 0, 'no create without 20 s + capture reserve');
  assert.equal((await h.store.get('work', e0.pk, 'EFFECT'))!.state, 'READY');
  await processJob(h.deps, jobId, 40_000); // deadline 30 s: the create fits, the exchange (10 s + reserve) no longer does
  assert.deepEqual([h.plaid.count('SANDBOX_CREATE'), h.plaid.count('EXCHANGE')], [1, 0]);
  assert.equal((await h.store.get('work', e0.pk, 'EFFECT'))!.state, 'CREATED', 'durable checkpoint, then yield');
  await processJob(h.deps, jobId); // fresh invocation continues from CREATED
  assert.deepEqual([h.plaid.count('SANDBOX_CREATE'), h.plaid.count('EXCHANGE')], [1, 1], 'same key: never a second create');
  assert.equal((await h.store.get('work', e0.pk, 'EFFECT'))!.state, 'VERIFIED_SUCCESS');
});

test('S2-IM-01 batch: a record that cannot get 15 s of Lambda time is returned unclaimed; later records too', async () => {
  const h = await harness({ plaid: true, bank: 'none' });
  await h.drain();
  await operatorReset(h.deps, 'tenant-a', 'batch', { bank: 'seed', hero: false });
  const e0 = await seedEffect(h);
  let left = 26_000; // slot 1 gets 20 s (runs), slot 2 gets 14 s (returned unclaimed)
  const r = await processBatch(h.deps, [{ messageId: 'm1', body: 'nonexistent-job' }, { messageId: 'm2', body: `eff#${e0.effectKey}` }], () => (left -= 6_000));
  assert.deepEqual(r.batchItemFailures, [{ itemIdentifier: 'm2' }]);
  const job = await h.store.get('work', K.job(`eff#${e0.effectKey}`), 'JOB');
  assert.equal(job!.state, 'QUEUED', 'not claimed');
  assert.equal(h.plaid.count('SANDBOX_CREATE'), 0);
});

test('S2-IM-02 key-service failure before any provider call is visible (FAILED, reason, audited once), keeps the last good read, then recovers', async () => {
  const h = await harness({ plaid: true });
  await h.drain();
  const audits = () => h.store.dump('audit').filter((a) => a.eventType === 'BankObservationFailed').length;
  const a0 = audits();
  const calls0 = h.plaid.calls.length;
  h.vault.failNext = 1;
  await h.api('POST', '/v1/cash/bank/refresh');
  await h.drain();
  let b = await h.bank();
  assert.equal(h.plaid.calls.length, calls0, 'no provider call happened');
  assert.deepEqual([b.state, b.freshness, b.counted.minor], ['HEALTHY', 'FAILED', 813_000]);
  assert.match(b.lastError, /key service is unavailable/);
  assert.ok(b.retrievedAt, 'last good read kept');
  assert.equal(audits(), a0 + 1);
  await h.advance(16_000); // backoff retry, key service back
  b = await h.bank();
  assert.deepEqual([b.freshness, b.lastError], ['RECENT', null]);
});

test('S2-IM-02 before a first observation: a missing bank reader shows the reason instead of an indefinite loading state; recovery reads the bank', async () => {
  const h = await harness({ plaid: true, bank: 'none' });
  await h.drain();
  const reader = h.deps.plaid!.reader;
  h.deps.plaid!.reader = undefined;
  await h.api('POST', '/v1/cash/bank/exchange', { publicToken: h.plaid.linkPublicToken() });
  await h.drain();
  let b = await h.bank();
  assert.deepEqual([b.state, b.freshness, b.retrievedAt], ['SYNCING', 'FAILED', null]);
  assert.match(b.lastError, /not configured/);
  h.deps.plaid!.reader = reader;
  await h.api('POST', '/v1/cash/bank/refresh');
  await h.drain();
  b = await h.bank();
  assert.deepEqual([b.state, b.freshness], ['HEALTHY', 'RECENT']);
});

test('S2-IM-03 staggered identical connect (same key, same body): the late request replays the stored 202, never 409', async () => {
  const h = await harness({ plaid: true, bank: 'none' });
  await h.drain();
  const pub = h.plaid.linkPublicToken();
  const s = h.store as any;
  const get = s.get.bind(s);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let paused = false;
  s.get = async (t: string, pk: string, sk: string) => {
    const v = await get(t, pk, sk);
    if (sk === 'IDEM' && !paused) { paused = true; await gate; } // first request: pause right after its empty IDEM read
    return v;
  };
  const first = h.api('POST', '/v1/cash/bank/exchange', { publicToken: pub }, { 'idempotency-key': 'stagger' });
  while (!paused) await new Promise((r) => setTimeout(r, 1));
  const second = await h.api('POST', '/v1/cash/bank/exchange', { publicToken: pub }, { 'idempotency-key': 'stagger' });
  release();
  const a = await first;
  assert.deepEqual([second.status, a.status], [202, 202]);
  assert.deepEqual(a.body, second.body);
  const other = await h.api('POST', '/v1/cash/bank/exchange', { publicToken: h.plaid.linkPublicToken() }, { 'idempotency-key': 'other' });
  assert.deepEqual([other.status, other.body.code], [409, 'ALREADY_CONNECTED'], 'a different key is still refused');
  const diffBody = await h.api('POST', '/v1/cash/bank/exchange', { publicToken: 'different' }, { 'idempotency-key': 'stagger' });
  assert.deepEqual([diffBody.status, diffBody.body.code], [409, 'IDEMPOTENCY_CONFLICT']);
});

test('S2-IM-04 the DTO carries checking current separately from counted available (UI renders both; browser check in browser.mjs)', async () => {
  const h = await harness({ plaid: true });
  await h.drain();
  const chk = (await h.bank()).accounts.find((a: any) => a.mask === '0101');
  assert.deepEqual([chk.eligible.minor, chk.provider.current.value, chk.provider.available.value], [633_000, '6650', '6330']);
});

const connectWith = async (h: H, accounts: any[]) => {
  await h.api('POST', '/v1/cash/bank/exchange', { publicToken: h.plaid.linkPublicToken({ override_accounts: accounts }) });
  await h.drain();
};
const chk = (o: any) => ({ type: 'depository', subtype: 'checking', starting_balance: 100, currency: 'USD', meta: { name: 'Ops', mask: '1111' }, ...o });

test('S2-IM-05 basis and numbers agree: incomplete / refused / zero / historical / healthy bank', async () => {
  // Incomplete: one countable USD checking + one EUR checking with null available → bank not counted.
  let h = await harness({ plaid: true, bank: 'none' });
  await h.drain();
  await connectWith(h, [chk({}), chk({ currency: 'EUR', starting_balance: 50, balances: { available: null }, meta: { name: 'Euro', mask: '2222' } })]);
  let c = await h.cash();
  assert.equal(c.totals.parts.bank, null);
  assert.equal(c.lowestPoint.low.minor, 500_000);
  assert.equal(c.lowestPoint.basis, 'PayPal only · bank checking not counted (Euro ··2222: figure missing or refused) · no bills yet');
  assert.match((await h.api('GET', '/v1/overview')).body.statusLine, /PayPal only · bank checking not counted/);
  // Refused precision on the only checking account.
  h = await harness({ plaid: true, bank: 'none' });
  await h.drain();
  await connectWith(h, [chk({ starting_balance: 1024.502621, balances: { available: 1024.502621 } })]);
  c = await h.cash();
  assert.deepEqual([c.totals.parts.bank, c.lowestPoint.low.minor], [null, 500_000]);
  assert.match(c.lowestPoint.basis, /^PayPal only · bank checking not counted \(Ops ··1111: figure missing or refused\)/);
  // Zero is a known figure and is included.
  h = await harness({ plaid: true, bank: 'none' });
  await h.drain();
  await connectWith(h, [chk({ starting_balance: 0 })]);
  c = await h.cash();
  assert.deepEqual([c.totals.parts.bank.minor, c.lowestPoint.low.minor], [0, 500_000]);
  assert.equal(c.lowestPoint.basis, 'PayPal + bank checking · no bills yet');
  // Healthy and historical.
  h = await harness({ plaid: true });
  await h.drain();
  c = await h.cash();
  assert.deepEqual([c.totals.parts.bank.minor, c.lowestPoint.low.minor, c.lowestPoint.basis], [813_000, 1_313_000, 'PayPal + bank checking · no bills yet']);
  await h.api('POST', '/v1/cash/bank/disconnect', undefined, { 'if-match': String(c.sources[1].connection.version) });
  c = await h.cash();
  assert.deepEqual([c.totals.parts.bank, c.lowestPoint.low.minor], [null, 500_000]);
  assert.match(c.lowestPoint.basis, /^PayPal only · bank removal pending/);
});

// ---------- independent Claude reviewer findings S2-IR-* ----------
test('S2-IR-02 a reset WITHOUT seeding still removes the previous run\'s Item (no credential left behind)', async () => {
  const h = await harness({ plaid: true });
  await h.drain();
  const itemId = (await (await import('../../backend/src/handlers/operator.ts')).operatorGetRun(h.deps, 'tenant-a'))!.bank!.itemId as string;
  await operatorReset(h.deps, 'tenant-a', 'no bank this time', { bank: 'none', hero: false });
  await h.drain();
  const old = await h.store.get('provider', K.plaid(itemId), 'ITEM');
  assert.deepEqual([old!.state, old!.sealedAccessToken], ['DISCONNECTED', undefined]);
  assert.equal(h.plaid.items.get(itemId)!.removed, true);
  assert.equal((await h.bank()).state, 'NOT_CONNECTED');
});

test('S2-IR-02 a seed reset while the Plaid grant is stopped still queues removal of the old Item (waits READY, never failed)', async () => {
  const h = await harness({ plaid: true });
  await h.drain();
  const { operatorGetRun } = await import('../../backend/src/handlers/operator.ts');
  const itemId = (await operatorGetRun(h.deps, 'tenant-a'))!.bank!.itemId as string;
  await h.store.transact([{ op: 'update', table: 'work', pk: K.counter('S1', 'plaid'), sk: 'COUNTER', set: { items: h.deps.config.grant!.budgets.items } }]);
  const r = await operatorReset(h.deps, 'tenant-a', 'grant stopped', { bank: 'seed', hero: false });
  assert.equal(r!.state, 'BLOCKED');
  await h.drain();
  assert.equal((await h.store.get('provider', K.plaid(itemId), 'ITEM'))!.state, 'DISCONNECTED', 'remove needs only the calls budget');
});

test('S2-IR-06 a terminal UNKNOWN seed is not shown as "checking": terminal flag, watching false, run BLOCKED', async () => {
  const h = await harness({ plaid: true, bank: 'none' });
  await h.drain();
  h.plaid.faults.add('create-timeout');
  await operatorReset(h.deps, 'tenant-a', 'lost create', { bank: 'seed', hero: false });
  await h.drain();
  const pe = (await h.bank()).pendingEffect;
  assert.deepEqual([pe.state, pe.terminal, pe.canAbandon], ['UNKNOWN', true, false]);
  assert.equal((await h.api('GET', '/v1/session')).body.watching, false);
});

test('S2-IR-07 sweep: a CREATED seed whose worker died is requeued without UNKNOWN and continues to one exchange', async () => {
  const { SimulatedCrash } = await import('../../backend/src/deps.ts');
  let armed = true;
  const h = await harness({ plaid: true, bank: 'none', hooks: { beforeBankCommit: async () => {} } });
  await h.drain();
  const step0 = h.store.transact.bind(h.store);
  (h.store as any).transact = async (ops: any[]) => {
    // die after the CREATED capture, just before the exchange dispatch checkpoint is written
    if (armed && ops[0]?.set?.state === 'EXCHANGE_DISPATCHED') { armed = false; throw new SimulatedCrash('died after CREATED'); }
    return step0(ops);
  };
  await operatorReset(h.deps, 'tenant-a', 'crash after create', { bank: 'seed', hero: false });
  await h.drain();
  const e = await seedEffect(h);
  assert.equal(e.state, 'CREATED');
  await h.advance(91_000);
  const e2 = h.store.dump('work').find((i) => i.pk === e.pk)!;
  assert.equal(e2.state, 'VERIFIED_SUCCESS');
  assert.deepEqual([h.plaid.count('SANDBOX_CREATE'), h.plaid.count('EXCHANGE')], [1, 1], 'exchange dispatched once from CREATED, not treated as a replay');
  assert.equal(e2.replayed, false, 'a first exchange, not a replay');
  assert.equal(h.store.dump('audit').filter((x) => x.eventType === 'BankEffectOutcomeUnknown').length, 0, 'CREATED was never turned into UNKNOWN');
});

test('S2-IR-09 replay answered 200 (live sandbox behaviour) → bound, and the audit says so', async () => {
  const h = await harness({ plaid: true, bank: 'none' });
  await h.drain();
  h.plaid.replayAnswers200 = true;
  h.plaid.faults.add('exchange-lost-response');
  await h.api('POST', '/v1/cash/bank/exchange', { publicToken: h.plaid.linkPublicToken() });
  await h.drain();
  await h.advance(60_000);
  assert.equal((await h.bank()).state, 'HEALTHY');
  assert.equal(h.plaid.items.size, 1);
  assert.ok(h.store.dump('audit').some((a) => a.eventType === 'BankConnected' && /same-token replay/.test(a.result)));
});

test('S2-IR-10 / S2-R28 grant expiry is a validUntil boundary: after it, "Bank not being checked: Plaid grant ended"', async () => {
  const h = await harness({ plaid: true });
  await h.drain();
  const exp = h.deps.config.grant!.expiresAt;
  h.setNow(new Date(Date.parse(exp) - 60_000).toISOString());
  const c0 = await h.cash();
  assert.equal(c0.validUntil, new Date(Date.parse(exp) + 1).toISOString());
  h.setNow(new Date(Date.parse(exp) + 2).toISOString());
  const b = await h.bank();
  assert.equal(b.checksStopped, 'Bank not being checked: Plaid grant ended');
});

test('S2-IR-15 while history loads, a real-time read under 15 min old is not repeated every minute', async () => {
  const h = await harness({ plaid: true, bank: 'none' });
  await h.drain();
  const orig = h.plaid.connector.exchange;
  h.plaid.connector.exchange = async (t) => { const r = await orig(t); for (const it of h.plaid.items.values()) it.updateStatus = 'INITIAL_UPDATE_COMPLETE'; return r; };
  await operatorReset(h.deps, 'tenant-a', 'slow history', { bank: 'seed', hero: false });
  await h.drain();
  const b0 = h.plaid.count('BALANCE');
  for (let i = 0; i < 5; i++) await h.advance(61_000);
  assert.equal(h.plaid.count('BALANCE'), b0, 'no balance call within 15 min while history loads');
  for (let i = 0; i < 11; i++) await h.advance(61_000);
  assert.ok(h.plaid.count('BALANCE') > b0, 'after 15 min it reads again');
});
