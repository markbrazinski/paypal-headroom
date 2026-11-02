// The recorded grant (Build Book §I) and its call counter, shared by every provider adapter so the counting rule exists once.
import { K } from './store/keys.ts';
import { TxCancelled, type Store } from './store/port.ts';

/** `raw` is the response text exactly as received; `rawSha256` is its hash. */
export interface HttpResult { status: number; body: any; raw: string; rawSha256: string }

/** The call went out (or may have) and no HTTP response came back: the outcome is unknown. */
export class NoResponse extends Error {}
/** The recorded grant's budget or expiry stops this call before it is sent. */
export class CallRefused extends Error {
  readonly reason: 'BUDGET_REACHED' | 'GRANT_ENDED' | 'NO_GRANT';
  constructor(reason: 'BUDGET_REACHED' | 'GRANT_ENDED' | 'NO_GRANT', message: string) { super(message); this.reason = reason; }
}

/** One slice's renewal of the standing grants: PayPal kinds (reads…verifies) and Plaid kinds (calls, items). */
export interface Grant {
  id: string;
  expiresAt: string;
  budgets: { reads: number; creates: number; sends: number; verifies: number; updates: number; payouts: number; calls: number; items: number };
}
export type Provider = 'paypal' | 'plaid';
export type BudgetKind = keyof Grant['budgets'];

/** Atomic ADD on `COUNTER#<provider>#<grant>`, conditioned on every named kind staying under budget. Runs before every call. */
export async function spend(store: Store, grant: Grant | null, provider: Provider, kinds: BudgetKind[], now: string, onBudgetReached?: (kind: BudgetKind) => Promise<void>) {
  const name = provider === 'paypal' ? 'PayPal' : 'Plaid';
  if (!grant) throw new CallRefused('NO_GRANT', `No ${name} grant configured (HEADROOM_GRANT)`);
  if (now > grant.expiresAt) throw new CallRefused('GRANT_ENDED', `${name} grant ${grant.id} ended ${grant.expiresAt}`);
  try {
    await store.transact([{
      op: 'update', table: 'work', pk: K.counter(grant.id, provider), sk: 'COUNTER',
      add: Object.fromEntries(kinds.map((k) => [k, 1])), cond: { ltOrMissing: Object.fromEntries(kinds.map((k) => [k, grant.budgets[k]])) },
    }]);
  } catch (e) {
    if (!(e instanceof TxCancelled)) throw e;
    await onBudgetReached?.(kinds[0]);
    throw new CallRefused('BUDGET_REACHED', `${name} ${kinds.join('+')} budget reached for grant ${grant.id}`);
  }
}

/** Why calls to `provider` can't run right now (grant missing, ended, or `kind` budget spent), or null. */
export async function grantStopped(store: Store, grant: Grant | null, provider: Provider, kind: BudgetKind, now: string): Promise<string | null> {
  const name = provider === 'paypal' ? 'PayPal' : 'Plaid';
  if (!grant) return `no ${name} grant`;
  if (now > grant.expiresAt) return `${name} grant ended`;
  const c = await store.get('work', K.counter(grant.id, provider), 'COUNTER');
  return (c?.[kind] ?? 0) >= grant.budgets[kind] ? `${name} call budget reached` : null;
}
