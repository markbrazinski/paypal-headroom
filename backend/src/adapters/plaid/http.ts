// Direct REST over fetch: hard-wired sandbox host, a timeout on every call, the shared grant counter (S02 §6.6).
// Credentials go in the JSON body and are never logged. Response bodies that carry tokens are never retained.
import { createHash } from 'node:crypto';
import type { Store } from '../store/port.ts';
import { NoResponse, spend, type BudgetKind, type Grant, type HttpResult } from '../grant.ts';

export const PLAID_SANDBOX = 'https://sandbox.plaid.com';
/** The API version the probe observed and the contracts were written against. Unpinned, Plaid applies the Dashboard default. */
export const PLAID_VERSION = '2020-09-14';

export interface PlaidHttpOpts {
  clientId: string;
  secret: string;
  env: string;
  store: Store;
  grant: Grant | null;
  now: () => string;
  /** LIVE-FAULT test seam: wraps fetch (e.g. sends the request, then discards the response). */
  fetchImpl?: typeof fetch;
  onBudgetReached?: (kind: BudgetKind) => Promise<void>;
}

export class PlaidHttp {
  private o: PlaidHttpOpts;
  constructor(o: PlaidHttpOpts) {
    if (o.env !== 'sandbox') throw new Error('PLAID_ENV must be sandbox');
    if (!o.clientId || !o.secret) throw new Error('Plaid credentials missing');
    this.o = o;
  }

  /** `items`: this call creates or activates an Item (exchange, sandbox create), so it also spends the Items budget. */
  async call(path: string, body: Record<string, unknown>, opts: { timeoutMs?: number; items?: boolean } = {}): Promise<HttpResult> {
    await spend(this.o.store, this.o.grant, 'plaid', opts.items ? ['calls', 'items'] : ['calls'], this.o.now(), this.o.onBudgetReached);
    const url = `${PLAID_SANDBOX}${path}`;
    if (!url.startsWith(`${PLAID_SANDBOX}/`)) throw new Error(`refusing non-sandbox Plaid URL ${url}`);
    let r: Response;
    try {
      r = await (this.o.fetchImpl ?? fetch)(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Plaid-Version': PLAID_VERSION },
        body: JSON.stringify({ client_id: this.o.clientId, secret: this.o.secret, ...body }), signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
      });
    } catch (e) {
      throw new NoResponse(`Plaid call failed without a response: ${(e as Error).name}`);
    }
    let text: string;
    try { text = await r.text(); } catch { throw new NoResponse('Plaid response body lost'); }
    let parsed: unknown = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { unparsed: text.slice(0, 200) }; }
    return { status: r.status, body: parsed, raw: text, rawSha256: createHash('sha256').update(text).digest('hex') };
  }
}
