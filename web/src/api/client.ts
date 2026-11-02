// Typed client over the shared route table. The UI renders DTOs as given and does no cash arithmetic.
import { pathFor, routes, type OperationId, type ResponseOf, type ContractError } from '@headroom/contracts';
import { freshToken, signIn, isLocal } from '../auth.ts';
import { goldenCall, goldenOn } from './golden.ts'; // golden: experimental ?demo=1 replay

export class ApiFailure extends Error {
  readonly status: number;
  readonly error: ContractError;
  constructor(status: number, error: ContractError) { super(error.message); this.status = status; this.error = error; }
}

let runId: string | null = null;
/** Server clock skew from the HTTP Date header (1 s resolution): server-computed instants (validUntil) are timed against it. */
let skewMs = 0;
export const serverNow = () => Date.now() + skewMs;
export const setRun = (id: string) => { runId = id; };

/** Commands take the caller's Idempotency-Key, one per user action, so a retry after a lost response replays instead of duplicating. */
export async function call<O extends OperationId>(op: O, o: { params?: Record<string, string>; query?: Record<string, string>; body?: unknown; ifMatch?: number; idempotencyKey?: string } = {}): Promise<ResponseOf<O>> {
  const r = routes[op];
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const t = await freshToken();
  if (t) headers.authorization = `Bearer ${t}`;
  if (r.command) headers['idempotency-key'] = o.idempotencyKey ?? crypto.randomUUID();
  if (o.ifMatch !== undefined) headers['if-match'] = String(o.ifMatch);
  if (r.method === 'POST' && runId) headers['x-headroom-run'] = runId;
  const qs = o.query && Object.keys(o.query).length ? `?${new URLSearchParams(o.query)}` : '';
  // golden: answer from the recording; the clock reads as the recorded moment. A signed-in dock still reads the live run's status.
  if (goldenOn() && !(t && r.path.startsWith('/v1/demo/'))) {
    const g = await goldenCall(r.method, pathFor(op, o.params), qs);
    skewMs = Date.parse(g.now) - Date.now();
    if (g.status >= 400) throw new ApiFailure(g.status, g.body as ContractError);
    return g.body as ResponseOf<O>;
  }
  const res = await fetch(pathFor(op, o.params) + qs, { method: r.method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
  const date = Date.parse(res.headers.get('date') ?? '');
  if (Number.isFinite(date) && !goldenOn()) skewMs = date - Date.now(); // golden keeps the recorded clock
  if (res.status === 401 && !isLocal()) { await signIn(); throw new Error('signing in'); }
  const body = await res.json().catch(() => ({ code: 'INTERNAL', outcome: 'UNKNOWN', message: `HTTP ${res.status}`, correlationId: '' }));
  if (!res.ok) throw new ApiFailure(res.status, body);
  return body;
}
