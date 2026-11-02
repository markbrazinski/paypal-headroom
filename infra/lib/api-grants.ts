// The API role's DynamoDB permissions as data (adopted 2 Nov 2026): the stack grants exactly these, and the acceptance harness wraps
// the router's store in the same rules (tests/acceptance/api-scope.ts), so an API read or write outside them fails locally, not on dev.
export type ApiTable = 'core' | 'work' | 'provider' | 'audit';
const R = ['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:ConditionCheckItem'];
const W = ['dynamodb:PutItem', 'dynamodb:UpdateItem'];
/** `prefixes`: IAM `dynamodb:LeadingKeys` StringLike patterns (null = the whole table). */
export const API_DDB_GRANTS: { table: ApiTable; actions: string[]; prefixes: string[] | null; why?: string }[] = [
  { table: 'core', actions: [...R, ...W], prefixes: null },
  { table: 'work', actions: [...R, ...W], prefixes: ['JOB#*', 'IDEM#*'] },
  // S6-D17: the API reads every effect but creates only invoice-issue, invoice-update and mail effects; never a payout (`EFFECT#pay:`).
  { table: 'work', actions: ['dynamodb:GetItem'], prefixes: ['EFFECT#*'] },
  { table: 'work', actions: ['dynamodb:PutItem'], prefixes: ['EFFECT#HR-*', 'EFFECT#upd:*', 'EFFECT#mail:*'], why: 'creates READY effects only' },
  { table: 'work', actions: ['dynamodb:GetItem'], prefixes: ['COUNTER#*'], why: 'reads the grant counter, never spends or resets it' },
  { table: 'audit', actions: ['dynamodb:PutItem', 'dynamodb:Query'], prefixes: null },
  { table: 'provider', actions: ['dynamodb:PutItem'], prefixes: ['PPREF#INVNUM#*'] },
  { table: 'provider', actions: R, prefixes: ['PPREF#*', 'PPCONN#*'] },
  { table: 'provider', actions: ['dynamodb:GetItem'], prefixes: ['GMAIL#*'], why: 'S5-D26: Inbox/Overview read the Gmail connection state; the token stays sealed' },
  // S2: claims, abandons and DISCONNECTING moves; no PutItem on PLAID#* (ITEM is created only by the worker), no standalone ConditionCheck (S2-PR-08).
  { table: 'provider', actions: ['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:UpdateItem'], prefixes: ['PLAID#*'] },
  { table: 'work', actions: ['dynamodb:PutItem', 'dynamodb:GetItem', 'dynamodb:UpdateItem'], prefixes: ['EFFECT#bank*'] },
  { table: 'work', actions: ['dynamodb:UpdateItem'], prefixes: ['COUNTER#plaid#*'] },
  // S6: readiness reads the day's payout charge; it never writes it (only the worker's queue/claim TXs do).
  { table: 'work', actions: ['dynamodb:GetItem'], prefixes: ['SPENDDAY#*'], why: 'S6: limits count every live payout of the day' },
];

/** Does the API role allow `action` on `table` for partition key `pk`? (IAM StringLike: `*` matches anything.) */
export function apiAllows(table: ApiTable, action: string, pk: string): boolean {
  const like = (p: string) => new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(pk);
  return API_DDB_GRANTS.some((g) => g.table === table && g.actions.includes(action) && (g.prefixes === null || g.prefixes.some(like)));
}
