import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness, OWNER_B } from './harness.ts';
import { K } from '../../backend/src/adapters/store/keys.ts';
import { operatorGetRun, operatorReset } from '../../backend/src/handlers/operator.ts';

const runOf = async (h: Awaited<ReturnType<typeof harness>>) => operatorGetRun(h.deps, 'tenant-a');

test('S2-A1/A2 seeded reset (STUB Plaid): READY; two checking accounts (owner, 1 Nov 2026) both counted, v1a totals unchanged; total = PayPal + checking', async () => {
  const h = await harness({ plaid: true });
  assert.equal(h.run!.state, 'PREPARING', 'no Plaid call inside the operator: the run waits for queued work');
  assert.equal(h.plaid.calls.length, 0);
  await h.drain();
  const run = await runOf(h);
  assert.equal(run!.state, 'READY', JSON.stringify(run));
  const b = await h.bank();
  assert.equal(b.state, 'HEALTHY');
  assert.equal(b.connection.basis, 'SEEDED');
  assert.equal(b.accounts.length, 2);
  const [op, pay] = b.accounts;
  assert.deepEqual([op.subtype, op.role, op.eligible.minor, op.provider.current.value, op.label], ['checking', 'COUNTED', 633_000, '6650', 'Available · counted']);
  assert.deepEqual([pay.subtype, pay.role, pay.eligible.minor, pay.provider.current.value], ['checking', 'COUNTED', 180_000, '1800']);
  assert.equal(b.counted.minor, 813_000);
  assert.equal(b.freshness, 'RECENT');
  assert.equal(b.historyLoading, false);
  const c = await h.cash();
  assert.deepEqual([c.totals.parts.paypal.minor, c.totals.parts.bank.minor, c.totals.reportedAvailable.minor], [500_000, 813_000, 1_313_000]);
  assert.equal(c.totals.estimate.lower.minor, 500_000 + 813_000);
  assert.equal(c.lowestPoint.basis, 'PayPal + bank checking · no bills yet');
  assert.equal(c.ledger.reportedMinusReserve.minor, 1_313_000 - 400_000);
  assert.equal(c.currentBadge.state, 'NOT_VERIFIABLE', 'PayPal (~2 h lag) is never recent in S2');
  assert.ok(c.validUntil, 'time-derived fields have a refetch instant');
  const cands = b.activity.rows.filter((r: any) => r.paypalCandidate).map((r: any) => r.description).sort();
  assert.deepEqual(cands, ['PAYPAL INST XFER ADD FUNDS', 'PAYPAL TRANSFER WITHDRAWAL']);
  assert.equal(b.activity.pendingCount, 1);
  const ov = (await h.api('GET', '/v1/overview')).body;
  assert.equal(ov.cashNow.reportedAvailable.minor, 1_313_000);
  assert.deepEqual(ov.cashNow.bank.notCounted, []);
  assert.equal(ov.statusLine, 'Forecast above reserve under stated assumptions · PayPal + bank checking · no bills yet', 'status line names the same basis as the lowest point');
  assert.ok(c.sources[0].estimate.included.every((l: any) => !/bank/i.test(l.reason)), 'bank rows never enter C-BAL-1 movements (S2-R11)');
});

test('S2-A2 two consecutive seeded resets: same fingerprint, new provider ids, old Item removed, active view has none of the old ids', async () => {
  const h = await harness({ plaid: true });
  await h.drain();
  const r1 = await runOf(h);
  const b1 = await h.bank();
  await operatorReset(h.deps, 'tenant-a', 'second reset', { bank: 'seed', hero: false });
  await h.drain();
  const r2 = await runOf(h);
  assert.equal(r2!.state, 'READY');
  assert.equal(r2!.bank!.fingerprint, r1!.bank!.fingerprint, 'same content');
  assert.notEqual(r2!.bank!.itemId, r1!.bank!.itemId);
  assert.equal((r2!.bank!.accountIds as string[]).some((a) => (r1!.bank!.accountIds as string[]).includes(a)), false, 'new account ids');
  const old = await h.store.get('provider', K.plaid(r1!.bank!.itemId as string), 'ITEM');
  assert.equal(old!.state, 'DISCONNECTED', 'previous run\'s Item removed (BANK_REMOVE, audited in the old run)');
  assert.equal(old!.sealedAccessToken, undefined, 'its credential is dropped');
  assert.ok((await h.store.query('provider', K.plaid(r1!.bank!.itemId as string), { skPrefix: 'OBS#' })).length, 'old observations kept as evidence');
  const body = JSON.stringify(await h.cash());
  for (const id of [r1!.bank!.itemId as string, ...(r1!.bank!.accountIds as string[]), ...b1.activity.rows.map((r: any) => r.transactionId)]) assert.ok(!body.includes(id), `old id ${id} leaked`);
  assert.equal(h.plaid.count('REMOVE'), 1);
});

test('T1/T2 owner connect: link token → exchange claim (no Plaid call in the API) → worker exchanges → HEALTHY; S2-R13 no plaintext token anywhere', async () => {
  const h = await harness({ plaid: true, bank: 'none' });
  await h.drain();
  assert.equal((await h.bank()).state, 'NOT_CONNECTED');
  const lt = await h.api('POST', '/v1/cash/bank/link-token', { mode: 'connect' });
  assert.equal(lt.status, 200);
  assert.ok(lt.body.linkToken);
  const pub = h.plaid.linkPublicToken();
  const ex = await h.api('POST', '/v1/cash/bank/exchange', { publicToken: pub, institutionId: 'ins_109508', institutionName: 'First Platypus Bank' }, { 'idempotency-key': 'connect-1' });
  assert.equal(ex.status, 202);
  assert.equal(h.plaid.count('EXCHANGE'), 0, 'the API only claims');
  const pending = await h.bank();
  assert.deepEqual([pending.state, pending.pendingEffect.kind, pending.pendingEffect.institutionName], ['NOT_CONNECTED', 'CONNECTING', 'First Platypus Bank']);
  assert.equal((await h.api('GET', '/v1/session')).body.watching, true);
  const replay = await h.api('POST', '/v1/cash/bank/exchange', { publicToken: pub, institutionId: 'ins_109508', institutionName: 'First Platypus Bank' }, { 'idempotency-key': 'connect-1' });
  assert.deepEqual([replay.status, replay.body], [202, ex.body], 'same key replays the stored 202');
  const other = await h.api('POST', '/v1/cash/bank/exchange', { publicToken: h.plaid.linkPublicToken() }, { 'idempotency-key': 'connect-2' });
  assert.deepEqual([other.status, other.body.code], [409, 'ALREADY_CONNECTED']);
  assert.deepEqual([(await h.api('POST', '/v1/cash/bank/link-token', { mode: 'connect' })).body.code], ['ALREADY_CONNECTED']);
  await h.drain();
  const b = await h.bank();
  assert.deepEqual([b.state, b.connection.basis, b.counted.minor], ['HEALTHY', 'OWNER_LINKED', 813_000]);
  assert.equal(h.plaid.count('EXCHANGE'), 1);
  const upd = await h.api('POST', '/v1/cash/bank/link-token', { mode: 'update' });
  assert.equal(upd.status, 200, 'update-mode token decrypts the stored credential');
  const tokens = [pub, ...[...h.plaid.items.values()].map((i) => i.accessToken)];
  for (const t of ['core', 'work', 'provider', 'audit'] as const) {
    const dump = JSON.stringify(h.store.dump(t));
    for (const tok of tokens) assert.ok(!dump.includes(tok), `plaintext token in ${t}`);
  }
});

test('S2-R24 two identical connect requests overlapping (same key): one effect, one dispatch, both 202', async () => {
  const h = await harness({ plaid: true, bank: 'none' });
  await h.drain();
  const pub = h.plaid.linkPublicToken();
  const req = () => h.api('POST', '/v1/cash/bank/exchange', { publicToken: pub }, { 'idempotency-key': 'same' });
  const [a, b] = await Promise.all([req(), req()]);
  assert.deepEqual([a.status, b.status], [202, 202]);
  assert.deepEqual(a.body, b.body);
  await h.drain();
  assert.equal(h.plaid.count('EXCHANGE'), 1);
  assert.equal(h.store.dump('work').filter((i) => i.pk.startsWith('EFFECT#bankconn#')).length, 1);
});

test('S2-R15 exchange 4xx (definitive) → VERIFIED_FAILURE, slot released, "Not connected · reason", Connect works again', async () => {
  const h = await harness({ plaid: true, bank: 'none' });
  await h.drain();
  h.plaid.faults.add('exchange-400');
  await h.api('POST', '/v1/cash/bank/exchange', { publicToken: h.plaid.linkPublicToken() });
  await h.drain();
  const b = await h.bank();
  assert.deepEqual([b.state, b.pendingEffect.kind, b.pendingEffect.state], ['NOT_CONNECTED', 'CONNECT_FAILED', 'VERIFIED_FAILURE']);
  assert.match(b.pendingEffect.reason, /INVALID_PUBLIC_TOKEN/);
  assert.equal((await h.api('POST', '/v1/cash/bank/exchange', { publicToken: h.plaid.linkPublicToken() })).status, 202);
  await h.drain();
  assert.equal((await h.bank()).state, 'HEALTHY');
});

test('S2-R22a exchange 200 then the capture write fails transiently → retried in process → bound (one Item)', async () => {
  const h = await harness({ plaid: true, bank: 'none' });
  await h.drain();
  let failOnce = true;
  h.store.beforeTransact = (ops) => { if (failOnce && ops.length === 1 && ops[0].op === 'update' && (ops[0] as any).set?.state === 'EXCHANGED') { failOnce = false; throw new Error('injected: store unavailable'); } };
  await h.api('POST', '/v1/cash/bank/exchange', { publicToken: h.plaid.linkPublicToken() });
  await h.drain();
  assert.equal(failOnce, false);
  assert.equal((await h.bank()).state, 'HEALTHY');
  assert.equal(h.plaid.items.size, 1);
});

test('S2-R22b process dies after exchange 200, before capture → UNKNOWN → same-token replay → INVALID_PUBLIC_TOKEN → UNKNOWN + owner Abandon; never a silent fresh connect', async () => {
  const { SimulatedCrash } = await import('../../backend/src/deps.ts');
  let armed = true;
  const h = await harness({ plaid: true, bank: 'none', hooks: { afterBankResult: async (k) => { if (armed && k.startsWith('bankconn#')) { armed = false; throw new SimulatedCrash('died before capture'); } } } });
  await h.drain();
  await h.api('POST', '/v1/cash/bank/exchange', { publicToken: h.plaid.linkPublicToken() });
  await h.drain();
  await h.advance(91_000); // lease expiry → sweep → UNKNOWN → RECONCILE (replay)
  await h.advance(60_000);
  const b = await h.bank();
  assert.deepEqual([b.state, b.pendingEffect.state, b.pendingEffect.canAbandon], ['NOT_CONNECTED', 'UNKNOWN', true]);
  assert.equal(h.plaid.count('EXCHANGE'), 2, 'one original + one same-token replay, never a new key');
  assert.equal(h.plaid.items.size, 1, 'the orphan Plaid holds; Headroom never received its token');
  assert.equal((await h.api('GET', '/v1/session')).body.watching, false, 'nothing is automated any more; it waits for the owner');
  const ab = await h.api('POST', '/v1/cash/bank/connect/abandon', undefined, { 'if-match': String(b.pendingEffect.effectVersion) });
  assert.deepEqual([ab.status, ab.body.binding], [200, 'RELEASED']);
  assert.equal((await h.bank()).pendingEffect, null);
  assert.equal((await h.api('POST', '/v1/cash/bank/link-token', { mode: 'connect' })).status, 200, 'Connect possible again');
  const audit = (await h.api('GET', '/v1/activity')).body.rows;
  assert.ok(audit.some((a: any) => a.event === 'Bank connection abandoned' && /may hold a connection/.test(a.result)));
});

test('S2-R22c the exchange response is lost (applied at Plaid) → UNKNOWN → replay → INVALID_PUBLIC_TOKEN → abandonable', async () => {
  const h = await harness({ plaid: true, bank: 'none' });
  await h.drain();
  h.plaid.faults.add('exchange-lost-response');
  await h.api('POST', '/v1/cash/bank/exchange', { publicToken: h.plaid.linkPublicToken() });
  await h.drain();
  await h.advance(60_000);
  const b = await h.bank();
  assert.deepEqual([b.pendingEffect.state, b.pendingEffect.canAbandon], ['UNKNOWN', true]);
});

test('S2-R22 replay succeeds when the first exchange never landed (5xx) → EXCHANGED → bound', async () => {
  const h = await harness({ plaid: true, bank: 'none' });
  await h.drain();
  h.plaid.faults.add('exchange-500');
  await h.api('POST', '/v1/cash/bank/exchange', { publicToken: h.plaid.linkPublicToken() });
  await h.drain();
  assert.equal((await h.bank()).pendingEffect.state, 'UNKNOWN');
  await h.advance(60_000);
  assert.equal((await h.bank()).state, 'HEALTHY');
  assert.equal(h.plaid.count('EXCHANGE'), 2);
});

test('GenerateDataKey fails → no dispatch (stays READY, zero Plaid calls), then dispatched once; KMS seal fails at claim → 503 NOT_APPLIED, nothing written', async () => {
  const h = await harness({ plaid: true, bank: 'none' });
  await h.drain();
  h.vault.failNext = 1;
  const r = await h.api('POST', '/v1/cash/bank/exchange', { publicToken: h.plaid.linkPublicToken() });
  assert.deepEqual([r.status, r.body.code, r.body.outcome], [503, 'PROVIDER_UNAVAILABLE', 'NOT_APPLIED']);
  assert.equal(h.store.dump('work').filter((i) => i.pk.startsWith('EFFECT#bankconn#')).length, 0);
  assert.equal((await h.bank()).pendingEffect, null);
  await h.api('POST', '/v1/cash/bank/exchange', { publicToken: h.plaid.linkPublicToken() });
  h.vault.failNext = 1; // the worker's pre-dispatch GenerateDataKey
  await h.drain();
  assert.equal(h.plaid.count('EXCHANGE'), 0);
  assert.equal((await h.bank()).pendingEffect.state, 'READY');
  await h.advance(60_000);
  assert.equal((await h.bank()).state, 'HEALTHY');
  assert.equal(h.plaid.count('EXCHANGE'), 1);
});

test('S2-R23 reset between claim and dispatch → RUN_FENCED, zero Plaid calls, slot released in its own run', async () => {
  const h = await harness({ plaid: true, bank: 'none' });
  await h.drain();
  await h.api('POST', '/v1/cash/bank/exchange', { publicToken: h.plaid.linkPublicToken() });
  h.queue.pending.length = 0;
  const oldRun = (await runOf(h))!.runId;
  await operatorReset(h.deps, 'tenant-a', 'reset before dispatch', { bank: 'none', hero: false });
  await h.drain();
  assert.equal(h.plaid.count('EXCHANGE'), 0);
  const eff = h.store.dump('work').find((i) => i.pk.startsWith('EFFECT#bankconn#'))!;
  assert.deepEqual([eff.state, eff.failureReason.startsWith('RUN_FENCED')], ['VERIFIED_FAILURE', true]);
  assert.equal((await h.store.get('core', K.run('tenant-a', oldRun), 'CONN#plaid'))!.state, 'RELEASED');
});

test('S2-R23 reset after dispatch → bound in the OLD run and BANK_REMOVE queued in the same TX; the new run never shows it', async () => {
  let h!: Awaited<ReturnType<typeof harness>>;
  let once = true;
  h = await harness({ plaid: true, bank: 'none', hooks: { afterBankResult: async (k) => { if (once && k.startsWith('bankconn#')) { once = false; await operatorReset(h.deps, 'tenant-a', 'race', { bank: 'none', hero: false }); } } } });
  await h.drain();
  once = true;
  await h.api('POST', '/v1/cash/bank/exchange', { publicToken: h.plaid.linkPublicToken() });
  await h.drain();
  const [it] = [...h.plaid.items.values()];
  const conn = await h.store.get('provider', K.plaid(it.itemId), 'ITEM');
  assert.equal(conn!.state, 'DISCONNECTED', 'owned, bound in the old run, then removed');
  assert.equal(it.removed, true);
  assert.equal((await h.bank()).state, 'NOT_CONNECTED');
});

test('S2-R21 process death before dispatch → stays READY → dispatched exactly once later; SEED create UNKNOWN → run BLOCKED, never replayed', async () => {
  const { SimulatedCrash } = await import('../../backend/src/deps.ts');
  let armed = true;
  const h = await harness({ plaid: true, bank: 'none', hooks: { afterJobClaim: async (j) => { if (armed && j.startsWith('eff#bankconn#')) { armed = false; throw new SimulatedCrash('died before dispatch'); } } } });
  await h.drain();
  await h.api('POST', '/v1/cash/bank/exchange', { publicToken: h.plaid.linkPublicToken() });
  await h.drain();
  assert.equal(h.plaid.count('EXCHANGE'), 0);
  await h.advance(91_000);
  assert.equal(h.plaid.count('EXCHANGE'), 1);
  assert.equal((await h.bank()).state, 'HEALTHY');

  const s = await harness({ plaid: true, bank: 'none' });
  await s.drain();
  s.plaid.faults.add('create-timeout');
  await operatorReset(s.deps, 'tenant-a', 'seed with lost create', { bank: 'seed' });
  await s.drain();
  await s.advance(5 * 60_000);
  const run = await operatorGetRun(s.deps, 'tenant-a');
  assert.equal(run!.state, 'BLOCKED');
  assert.ok(run!.blockers.some((b: string) => /Bank seed outcome unknown: reset again/.test(b)), JSON.stringify(run!.blockers));
  assert.equal(s.plaid.count('SANDBOX_CREATE'), 1, 'never replayed');
});

test('T6 / S2-PR-04 / S2-R27 disconnect: stops counting at commit; removal UNKNOWN → item/get not found → DISCONNECTED (S2-R14); evidence kept; connect again (S2-R31 local)', async () => {
  const h = await harness({ plaid: true });
  await h.drain();
  const b0 = await h.bank();
  h.plaid.faults.add('remove-timeout');
  const dc = await h.api('POST', '/v1/cash/bank/disconnect', undefined, { 'if-match': String(b0.connection.version) });
  assert.equal(dc.status, 202);
  const c = await h.cash();
  assert.deepEqual([c.sources[1].state, c.sources[1].contributes, c.totals.parts.bank, c.totals.reportedAvailable.minor], ['DISCONNECTING', false, null, 500_000], 'bank absent from the total at once; never 0');
  assert.equal(c.totals.estimate.lower.minor, 500_000);
  assert.match(c.lowestPoint.basis, /^PayPal only · bank removal pending \(last bank read .*, not counted\)/);
  assert.ok(c.currentBadge.reasons.includes('Bank removal pending'));
  assert.equal(c.sources[1].counted.minor, 813_000, 'old figures shown as history');
  assert.equal(c.sources[1].pendingEffect.kind, 'REMOVAL_PENDING');
  await h.drain();
  assert.equal((await h.bank()).state, 'DISCONNECTING', 'remove timed out → UNKNOWN; still excluded');
  h.plaid.faults.delete('remove-timeout');
  await h.advance(60_000);
  const b = await h.bank();
  assert.deepEqual([b.state, b.contributes], ['DISCONNECTED', false]);
  const conn = await h.store.get('provider', K.plaid(b0.accounts.length ? (await runOf(h))!.bank!.itemId as string : ''), 'ITEM');
  assert.equal(conn!.sealedAccessToken, undefined);
  assert.ok(h.store.dump('provider').some((i) => i.sk.startsWith('SYNC#')), 'sync batches kept');
  assert.equal((await h.api('POST', '/v1/cash/bank/exchange', { publicToken: h.plaid.linkPublicToken() })).status, 202, 'binding RELEASED in the same TX as DISCONNECTED');
  await h.drain();
  assert.equal((await h.bank()).state, 'HEALTHY');
});

test('S2-A3 / S2-R3 login required → RECONNECT_REQUIRED, last observation kept, badge reason; update link token; reconnect → HEALTHY + BankReconnected; revoked → ended, not counted', async () => {
  const h = await harness({ plaid: true });
  await h.drain();
  const itemId = (await runOf(h))!.bank!.itemId as string;
  h.plaid.resetLogin(itemId);
  await h.api('POST', '/v1/cash/bank/refresh');
  await h.drain();
  let c = await h.cash();
  assert.deepEqual([c.sources[1].state, c.sources[1].contributes, c.sources[1].counted.minor], ['RECONNECT_REQUIRED', true, 813_000], 'last reading, with its read time and state');
  assert.ok(c.currentBadge.reasons.includes('Bank needs reconnecting'));
  assert.equal(c.lowestPoint.basis, 'PayPal + bank checking · bank needs reconnecting · no bills yet');
  assert.equal((await h.api('POST', '/v1/cash/bank/link-token', { mode: 'update' })).status, 200);
  h.plaid.completeUpdateMode(itemId); // Link update mode (password) — the browser case drives the real UI
  await h.api('POST', '/v1/cash/bank/refresh');
  await h.drain();
  c = await h.cash();
  assert.equal(c.sources[1].state, 'HEALTHY');
  assert.ok((await h.api('GET', '/v1/activity')).body.rows.some((a: any) => a.event === 'Bank reconnected'));
  h.plaid.removeOutOfBand(itemId);
  await h.api('POST', '/v1/cash/bank/refresh');
  await h.drain();
  c = await h.cash();
  assert.deepEqual([c.sources[1].state, c.sources[1].contributes, c.totals.parts.bank], ['REVOKED', false, null]);
  assert.equal((await h.api('POST', '/v1/cash/bank/disconnect', undefined, { 'if-match': String(c.sources[1].connection.version) })).status, 202, 'Disconnect cleans up an ended connection');
  await h.drain();
  assert.equal((await h.bank()).state, 'DISCONNECTED');
});

test('S2-R12 tenant B (no bank): refresh / disconnect / update link → 409 NOT_CONNECTED; B\'s responses carry none of A\'s ids', async () => {
  const h = await harness({ plaid: true });
  await h.drain();
  const a = (await runOf(h))!.bank!;
  for (const [path, body, headers] of [['/v1/cash/bank/refresh', undefined, {}], ['/v1/cash/bank/disconnect', undefined, { 'if-match': '1', 'idempotency-key': 'b-1' }], ['/v1/cash/bank/link-token', { mode: 'update' }, {}]] as const) {
    const r = await h.api('POST', path, body, headers as Record<string, string>, OWNER_B);
    assert.deepEqual([r.status, r.body.code], [409, 'NOT_CONNECTED'], path);
  }
  const bodies = JSON.stringify([await h.cash(OWNER_B), (await h.api('GET', '/v1/overview', undefined, {}, OWNER_B)).body]);
  for (const id of [a.itemId as string, ...(a.accountIds as string[])]) assert.ok(!bodies.includes(id));
  assert.equal((await h.bank(OWNER_B)).state, 'NOT_CONNECTED');
});

test('S2-R17 Plaid budget reached → "Bank not being checked", last observation kept with its time; effects wait READY, never failed', async () => {
  const h = await harness({ plaid: true });
  await h.drain();
  await h.store.transact([{ op: 'update', table: 'work', pk: K.counter('S1', 'plaid'), sk: 'COUNTER', set: { calls: h.deps.config.grant!.budgets.calls } }]);
  const b = await h.bank();
  assert.equal(b.checksStopped, 'Bank not being checked: Plaid call budget reached');
  assert.equal(b.counted.minor, 813_000);
  assert.ok(b.retrievedAt);
  await h.api('POST', '/v1/cash/bank/disconnect', undefined, { 'if-match': String(b.connection.version) });
  await h.drain();
  const after = await h.bank();
  assert.deepEqual([after.state, after.pendingEffect.state, after.pendingEffect.reason], ['DISCONNECTING', 'READY', 'Waiting: Plaid call budget reached']);
  assert.equal(after.contributes, false);
});
