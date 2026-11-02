import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from './memory.ts';
import { TxCancelled } from './port.ts';
import { expr } from './dynamodb.ts';

test('Cond.in: memory holds only for a listed value on an existing item; DynamoDB expression matches', async () => {
  const s = new MemoryStore();
  await s.transact([{ op: 'put', table: 'provider', item: { pk: 'PLAID#i', sk: 'ITEM', state: 'HEALTHY', generation: 2 } }]);
  const check = (states: string[], generation = 2) => s.transact([{ op: 'check', table: 'provider', pk: 'PLAID#i', sk: 'ITEM', cond: { eq: { generation }, in: { state: states } } }]);
  await check(['SYNCING', 'HEALTHY']);
  await assert.rejects(check(['DISCONNECTING']), TxCancelled);
  await assert.rejects(check(['HEALTHY'], 3), TxCancelled);
  await assert.rejects(s.transact([{ op: 'check', table: 'provider', pk: 'PLAID#none', sk: 'ITEM', cond: { in: { state: ['HEALTHY'] } } }]), TxCancelled);
  const names: Record<string, string> = {}, values: Record<string, unknown> = {};
  assert.equal(expr({ eq: { generation: 2 }, in: { state: ['SYNCING', 'HEALTHY'] } }, names, values, 'c0_'), '#c0_0 = :c0_0 AND #c0_1 IN (:c0_1, :c0_2)');
  assert.deepEqual([names, values], [{ '#c0_0': 'generation', '#c0_1': 'state' }, { ':c0_0': 2, ':c0_1': 'SYNCING', ':c0_2': 'HEALTHY' }]);
  await s.transact([{ op: 'check', table: 'provider', pk: 'PLAID#i', sk: 'ITEM', cond: { missing: ['bankReady'] } }]);
  await assert.rejects(s.transact([{ op: 'check', table: 'provider', pk: 'PLAID#i', sk: 'ITEM', cond: { missing: ['state'] } }]), TxCancelled);
  assert.equal(expr({ missing: ['bankReady'] }, {}, {}, 'c1_'), 'attribute_exists(pk) AND attribute_not_exists(#c1_0)');
});

test('Plaid adapter pins Plaid-Version (unpinned, the sandbox omitted currency fields on 1 Nov 2026) and refuses non-sandbox', async () => {
  const { PlaidHttp, PLAID_VERSION } = await import('../plaid/http.ts');
  const { S2_GRANT } = await import('../../deps.ts');
  let seen: Record<string, string> = {};
  const http = new PlaidHttp({ clientId: 'c', secret: 's', env: 'sandbox', store: new MemoryStore(), grant: S2_GRANT, now: () => '2026-11-01T00:00:00.000Z',
    fetchImpl: (async (_u: string, init: RequestInit) => { seen = init.headers as Record<string, string>; return new Response('{}'); }) as typeof fetch });
  await http.call('/item/get', { access_token: 'x' });
  assert.equal(seen['Plaid-Version'], PLAID_VERSION);
  assert.equal(PLAID_VERSION, '2020-09-14');
  assert.throws(() => new PlaidHttp({ clientId: 'c', secret: 's', env: 'production', store: new MemoryStore(), grant: S2_GRANT, now: () => '' }), /sandbox/);
});
