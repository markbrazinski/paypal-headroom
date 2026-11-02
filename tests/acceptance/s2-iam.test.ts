// S2-PR-08 / §6.8: every (table, action, leading key) the API performs, recorded from real API flows over the in-memory
// store, is granted by the synthesized api role. A missing pair fails here, locally, instead of as AccessDenied in dev.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { HeadroomDev } from '../../infra/lib/headroom-dev.ts';
import { harness, OWNER } from './harness.ts';
import type { Op, Table } from '../../backend/src/adapters/store/port.ts';

test('API transactions ↔ api IAM role: every recorded (table, action, key) pair is granted', async () => {
  const h = await harness({ plaid: true });
  await h.drain();
  const used = new Set<string>();
  const rec = (table: Table, action: string, pk: string) => used.add(`${table} ${action} ${pk}`);
  let on = false;
  const s = h.store as any;
  const [get, query, transact] = [s.get.bind(s), s.query.bind(s), s.transact.bind(s)];
  s.get = async (t: Table, pk: string, sk: string) => { if (on) rec(t, 'GetItem', pk); return get(t, pk, sk); };
  s.query = async (t: Table, pk: string, o: unknown) => { if (on) rec(t, 'Query', pk); return query(t, pk, o); };
  s.transact = async (ops: Op[]) => { if (on) for (const o of ops) rec(o.table, { put: 'PutItem', update: 'UpdateItem', check: 'ConditionCheckItem' }[o.op], o.op === 'put' ? o.item.pk : o.pk); return transact(ops); };
  const api = async (...a: Parameters<typeof h.api>) => { on = true; try { return await h.api(...a); } finally { on = false; } };

  for (const p of ['/v1/session', '/v1/overview', '/v1/cash/position', '/v1/receivables', '/v1/activity']) await api('GET', p);
  await api('POST', '/v1/cash/bank/refresh');
  await api('POST', '/v1/cash/bank/link-token', { mode: 'update' });
  const b = await h.bank();
  assert.equal((await api('POST', '/v1/cash/bank/disconnect', undefined, { 'if-match': String(b.connection.version) })).status, 202);
  await h.drain();
  await api('POST', '/v1/cash/bank/link-token', { mode: 'connect' });
  h.plaid.faults.add('exchange-lost-response');
  assert.equal((await api('POST', '/v1/cash/bank/exchange', { publicToken: h.plaid.linkPublicToken() })).status, 202);
  await h.drain();
  await h.advance(60_000);
  const pe = (await h.bank()).pendingEffect;
  assert.equal((await api('POST', '/v1/cash/bank/connect/abandon', undefined, { 'if-match': String(pe.effectVersion) })).status, 200);
  const d = await api('POST', '/v1/invoices', { customerId: 'cust-alder', amount: { currency: 'USD', minor: 100 }, dueOn: '2026-11-20' });
  await api('POST', `/v1/invoices/${d.body.invoice.invoiceId}/send`, undefined, { 'if-match': '1' });
  await api('GET', `/v1/invoices/${d.body.invoice.invoiceId}`);
  await api('POST', '/v1/cash/paypal/refresh');
  void OWNER;

  const t = Template.fromStack(new HeadroomDev(new App({ context: { 'aws:cdk:bundling-stacks': [] } }), 'T', { env: { account: '123456789012', region: 'us-east-1' } }));
  const fn = Object.values(t.findResources('AWS::Lambda::Function')).find((f: any) => f.Properties.FunctionName === 'HeadroomDev-api') as any;
  const role = fn.Properties.Role['Fn::GetAtt'][0];
  const stmts = Object.values(t.findResources('AWS::IAM::Policy')).filter((p: any) => p.Properties.Roles.some((r: any) => r.Ref === role)).flatMap((p: any) => p.Properties.PolicyDocument.Statement) as any[];
  const tableOf = (res: unknown) => { const m = /"(core|work|provider|audit)[0-9A-F]{8}"/.exec(JSON.stringify(res)); return m?.[1]; };
  const glob = (g: string, s: string) => new RegExp(`^${g.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(s);
  const missing = [...used].filter((u) => {
    const [table, action, pk] = u.split(' ');
    return !stmts.some((st) => ([] as string[]).concat(st.Action).includes(`dynamodb:${action}`)
      && ([] as unknown[]).concat(st.Resource).some((r) => tableOf(r) === table)
      && (!st.Condition || (st.Condition['ForAllValues:StringLike']?.['dynamodb:LeadingKeys'] ?? []).some((g: string) => glob(g, pk))));
  });
  assert.deepEqual(missing, [], 'API operations not granted to the api role');
  assert.ok([...used].some((u) => u.startsWith('provider UpdateItem PLAID#')), 'disconnect was exercised');
  assert.ok([...used].some((u) => u.startsWith('work UpdateItem EFFECT#bankconn#')), 'abandon was exercised');
  assert.ok(![...used].some((u) => /^provider (PutItem|ConditionCheckItem) PLAID#/.test(u)), 'no API PutItem or ConditionCheck on PLAID#*');
});
