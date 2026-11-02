// The API role's dev permissions, enforced on the router's store in acceptance (adopted 2 Nov 2026): any read or write the deployed
// API would be refused (AccessDenied → 500 on dev) fails here, locally, with the table, action and key.
import { apiAllows, type ApiTable } from '../../infra/lib/api-grants.ts';
import type { Op, Store } from '../../backend/src/adapters/store/port.ts';

export class ApiAccessDenied extends Error {}
const need = (table: string, action: string, pk: string) => {
  if (!apiAllows(table as ApiTable, `dynamodb:${action}`, pk)) throw new ApiAccessDenied(`API role may not ${action} ${table} key ${pk} (infra/lib/api-grants.ts)`);
};
const actionOf = (o: Op) => (o.op === 'put' ? 'PutItem' : o.op === 'update' ? 'UpdateItem' : 'ConditionCheckItem');

export function apiScoped(s: Store): Store {
  return {
    get: (t, pk, sk) => { need(t, 'GetItem', pk); return s.get(t, pk, sk); },
    query: (t, pk, o) => { need(t, 'Query', pk); return s.query(t, pk, o); },
    dueJobs: (now, limit) => s.dueJobs(now, limit),
    transact: (ops) => { for (const o of ops) need(o.table, actionOf(o), o.op === 'put' ? o.item.pk : o.pk); return s.transact(ops); },
  };
}
