// Persistence port. Mirrors the DynamoDB subset Headroom uses: Get, Query by partition, a sparse "due" index,
// and TransactWriteItems with per-item conditions. The memory adapter implements the same semantics.

export type Table = 'core' | 'work' | 'provider' | 'audit';
export type Item = { pk: string; sk: string; [k: string]: any };

/** All present clauses must hold (AND). Attribute names are top-level. */
export interface Cond {
  notExists?: true;
  exists?: true;
  eq?: Record<string, unknown>;
  /** attribute < value, or the item does not exist (counters). */
  ltOrMissing?: Record<string, number>;
  /** attribute IN (values…); the item must exist (S2 sync fence: state ∈ allowed). */
  in?: Record<string, readonly unknown[]>;
  /** attribute_not_exists(attribute) on an existing item. */
  missing?: string[];
}

export type Op =
  | { op: 'put'; table: Table; item: Item; cond?: Cond }
  | { op: 'update'; table: Table; pk: string; sk: string; set?: Record<string, unknown>; add?: Record<string, number>; remove?: string[]; cond?: Cond }
  | { op: 'check'; table: Table; pk: string; sk: string; cond: Cond };

/** A transaction refused by a condition. `failed[i]` is true for each op whose condition failed. */
export class TxCancelled extends Error {
  readonly failed: boolean[];
  constructor(failed: boolean[]) {
    super(`transaction cancelled: conditions failed at ${failed.flatMap((f, i) => (f ? [i] : [])).join(',')}`);
    this.failed = failed;
  }
}

export interface QueryOpts { skPrefix?: string; newestFirst?: boolean; limit?: number }

export interface Store {
  get(table: Table, pk: string, sk: string): Promise<Item | undefined>;
  query(table: Table, pk: string, opts?: QueryOpts): Promise<Item[]>;
  /** Work-table items with gsiDue = "DUE" and dueKey ≤ `${now}#~`, oldest first. */
  dueJobs(now: string, limit: number): Promise<Item[]>;
  transact(ops: Op[]): Promise<void>;
}

export function condHolds(item: Item | undefined, c: Cond | undefined): boolean {
  if (!c) return true;
  if (c.notExists && item) return false;
  if (c.exists && !item) return false;
  if (c.eq) for (const [k, v] of Object.entries(c.eq)) if (!item || item[k] !== v) return false;
  if (c.in) for (const [k, vs] of Object.entries(c.in)) if (!item || !vs.includes(item[k])) return false;
  if (c.missing) for (const k of c.missing) if (!item || item[k] !== undefined) return false;
  if (c.ltOrMissing && item) for (const [k, v] of Object.entries(c.ltOrMissing)) if (!(typeof item[k] !== 'number' || item[k] < v)) return false;
  return true;
}
