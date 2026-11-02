// In-memory store (owner decision D-5): unit, acceptance and `npm run dev`.
// ponytail: one Map per table and a sorted scan per query. Ceiling: thousands of items. Real DynamoDB in `dev`.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { condHolds, TxCancelled, type Item, type Op, type QueryOpts, type Store, type Table } from './port.ts';

const k = (pk: string, sk: string) => `${pk}\u0000${sk}`;

export class MemoryStore implements Store {
  private t: Record<Table, Map<string, Item>> = { core: new Map(), work: new Map(), provider: new Map(), audit: new Map() };
  /** Test hook: runs before each transaction is applied (e.g. to inject a race or a crash). */
  beforeTransact?: (ops: Op[]) => void | Promise<void>;

  /** Optional snapshot file so a local dev server survives restarts during owner-paced payments. */
  private snapshotPath?: string;
  constructor(snapshotPath?: string) {
    this.snapshotPath = snapshotPath;
    if (snapshotPath) {
      try {
        const raw = JSON.parse(readFileSync(snapshotPath, 'utf8')) as Record<Table, Item[]>;
        for (const [table, items] of Object.entries(raw) as [Table, Item[]][]) for (const i of items) this.t[table].set(k(i.pk, i.sk), i);
      } catch { /* no snapshot yet */ }
    }
  }

  async get(table: Table, pk: string, sk: string) {
    const i = this.t[table].get(k(pk, sk));
    return i && structuredClone(i);
  }

  async query(table: Table, pk: string, o: QueryOpts = {}) {
    const out = [...this.t[table].values()]
      .filter((i) => i.pk === pk && (!o.skPrefix || i.sk.startsWith(o.skPrefix)))
      .sort((a, b) => (a.sk < b.sk ? -1 : a.sk > b.sk ? 1 : 0));
    if (o.newestFirst) out.reverse();
    return structuredClone(o.limit ? out.slice(0, o.limit) : out);
  }

  async dueJobs(now: string, limit: number) {
    const bound = `${now}#~`;
    return structuredClone(
      [...this.t.work.values()].filter((i) => i.gsiDue === 'DUE' && i.dueKey <= bound).sort((a, b) => (a.dueKey < b.dueKey ? -1 : 1)).slice(0, limit),
    );
  }

  async transact(ops: Op[]) {
    await this.beforeTransact?.(ops);
    const keys = ops.map((o) => k(o.op === 'put' ? o.item.pk : o.pk, o.op === 'put' ? o.item.sk : o.sk));
    if (new Set(keys.map((x, i) => `${ops[i].table}:${x}`)).size !== keys.length) throw new Error('two operations on one item in a transaction');
    const failed = ops.map((o, i) => !condHolds(this.t[o.table].get(keys[i]), o.cond));
    if (failed.some(Boolean)) throw new TxCancelled(failed);
    ops.forEach((o, i) => {
      const m = this.t[o.table];
      if (o.op === 'put') m.set(keys[i], structuredClone(o.item));
      else if (o.op === 'update') {
        const cur = m.get(keys[i]) ?? { pk: o.pk, sk: o.sk };
        Object.assign(cur, structuredClone(o.set ?? {}));
        for (const [a, n] of Object.entries(o.add ?? {})) cur[a] = (typeof cur[a] === 'number' ? cur[a] : 0) + n;
        for (const a of o.remove ?? []) delete cur[a];
        m.set(keys[i], cur);
      }
    });
    if (this.snapshotPath) this.save();
  }

  private save() {
    mkdirSync(dirname(this.snapshotPath!), { recursive: true });
    const raw = Object.fromEntries(Object.entries(this.t).map(([n, m]) => [n, [...m.values()]]));
    writeFileSync(this.snapshotPath!, JSON.stringify(raw));
  }

  /** Test-only view of every item in a table. */
  dump(table: Table) { return structuredClone([...this.t[table].values()]); }
}
