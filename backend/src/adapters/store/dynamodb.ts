// DynamoDB adapter for the `dev` stage: same port and condition semantics as the memory store.
import { DynamoDBClient, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand, type TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { TxCancelled, type Cond, type Item, type Op, type QueryOpts, type Store, type Table } from './port.ts';

export type TableNames = Record<Table, string>;

export function expr(c: Cond | undefined, names: Record<string, string>, values: Record<string, unknown>, prefix: string): string | undefined {
  if (!c) return undefined;
  const parts: string[] = [];
  let i = 0;
  const n = (k: string) => { const t = `#${prefix}${i}`; names[t] = k; return t; };
  const v = (x: unknown) => { const t = `:${prefix}${i++}`; values[t] = x; return t; };
  if (c.notExists) parts.push('attribute_not_exists(pk)');
  if (c.exists) parts.push('attribute_exists(pk)');
  for (const [k, x] of Object.entries(c.eq ?? {})) parts.push(`${n(k)} = ${v(x)}`);
  for (const [k, xs] of Object.entries(c.in ?? {})) { const nk = n(k); parts.push(`${nk} IN (${xs.map((x) => v(x)).join(', ')})`); }
  for (const k of c.missing ?? []) parts.push(`attribute_exists(pk) AND attribute_not_exists(${n(k)})`), i++;
  for (const [k, x] of Object.entries(c.ltOrMissing ?? {})) { const nk = n(k); parts.push(`(attribute_not_exists(${nk}) OR ${nk} < ${v(x)})`); }
  return parts.join(' AND ');
}

export class DynamoStore implements Store {
  private doc: DynamoDBDocumentClient;
  private names: TableNames;
  constructor(names: TableNames, client = new DynamoDBClient({})) {
    this.names = names;
    this.doc = DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
  }

  async get(table: Table, pk: string, sk: string) {
    const r = await this.doc.send(new GetCommand({ TableName: this.names[table], Key: { pk, sk }, ConsistentRead: true }));
    return r.Item as Item | undefined;
  }

  async query(table: Table, pk: string, o: QueryOpts = {}) {
    const out: Item[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const r = await this.doc.send(new QueryCommand({
        TableName: this.names[table], ConsistentRead: true, ScanIndexForward: !o.newestFirst, ExclusiveStartKey: start,
        KeyConditionExpression: o.skPrefix ? 'pk = :pk AND begins_with(sk, :p)' : 'pk = :pk',
        ExpressionAttributeValues: { ':pk': pk, ...(o.skPrefix ? { ':p': o.skPrefix } : {}) },
        ...(o.limit ? { Limit: o.limit - out.length } : {}),
      }));
      out.push(...((r.Items ?? []) as Item[]));
      start = r.LastEvaluatedKey;
    } while (start && (!o.limit || out.length < o.limit));
    return out;
  }

  async dueJobs(now: string, limit: number) {
    const r = await this.doc.send(new QueryCommand({
      TableName: this.names.work, IndexName: 'due', Limit: limit,
      KeyConditionExpression: 'gsiDue = :d AND dueKey <= :b', ExpressionAttributeValues: { ':d': 'DUE', ':b': `${now}#~` },
    }));
    return (r.Items ?? []) as Item[];
  }

  async transact(ops: Op[]) {
    const items: NonNullable<TransactWriteCommandInput['TransactItems']> = ops.map((o, idx) => {
      const names: Record<string, string> = {};
      const values: Record<string, unknown> = {};
      const TableName = this.names[o.table];
      const cond = expr(o.cond, names, values, `c${idx}_`);
      const attrs = () => ({ ...(Object.keys(names).length ? { ExpressionAttributeNames: names } : {}), ...(Object.keys(values).length ? { ExpressionAttributeValues: values } : {}) });
      if (o.op === 'put') return { Put: { TableName, Item: o.item, ...(cond ? { ConditionExpression: cond } : {}), ...attrs() } };
      if (o.op === 'check') return { ConditionCheck: { TableName, Key: { pk: o.pk, sk: o.sk }, ConditionExpression: cond!, ...attrs() } };
      const clauses: string[] = [];
      let j = 0;
      const set = Object.entries(o.set ?? {}).map(([k, v]) => { names[`#u${j}`] = k; values[`:u${j}`] = v; return `#u${j++} = :u${j - 1}`; });
      const add = Object.entries(o.add ?? {}).map(([k, v]) => { names[`#u${j}`] = k; values[`:u${j}`] = v; return `#u${j++} :u${j - 1}`; });
      const rem = (o.remove ?? []).map((k) => { names[`#u${j}`] = k; return `#u${j++}`; });
      if (set.length) clauses.push(`SET ${set.join(', ')}`);
      if (add.length) clauses.push(`ADD ${add.join(', ')}`);
      if (rem.length) clauses.push(`REMOVE ${rem.join(', ')}`);
      return { Update: { TableName, Key: { pk: o.pk, sk: o.sk }, UpdateExpression: clauses.join(' '), ...(cond ? { ConditionExpression: cond } : {}), ...attrs() } };
    });
    for (let attempt = 0; ; attempt++) {
      try {
        await this.doc.send(new TransactWriteCommand({ TransactItems: items }));
        return;
      } catch (e) {
        if (!(e instanceof TransactionCanceledException)) throw e;
        const codes = (e.CancellationReasons ?? []).map((r) => r.Code ?? 'None');
        if (codes.some((c) => c === 'ConditionalCheckFailed')) throw new TxCancelled(codes.map((c) => c === 'ConditionalCheckFailed'));
        if (attempt < 3 && codes.some((c) => c === 'TransactionConflict')) { await new Promise((r) => setTimeout(r, 50 * 2 ** attempt + Math.random() * 50)); continue; }
        throw e;
      }
    }
  }
}
