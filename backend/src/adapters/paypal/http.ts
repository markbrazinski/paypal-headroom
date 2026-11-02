// Direct REST over fetch with a 10 s timeout, a hard-wired sandbox host and the shared grant counter (S01 §6.6).
import { createHash } from 'node:crypto';
import type { Store } from '../store/port.ts';
import { spend } from '../grant.ts';
import { NoResponse, type CallKind, type Grant, type HttpResult } from './types.ts';

export const SANDBOX_BASE = 'https://api-m.sandbox.paypal.com';

export interface PayPalHttpOpts {
  clientId: string;
  secret: string;
  store: Store;
  grant: Grant | null;
  now: () => string;
  /** LIVE-FAULT test seam: wraps fetch (e.g. sends the request, then discards the response). */
  fetchImpl?: typeof fetch;
  onBudgetReached?: (kind: CallKind) => Promise<void>;
}

export class PayPalHttp {
  private token: { value: string; until: number } | null = null;
  private o: PayPalHttpOpts;
  constructor(o: PayPalHttpOpts) {
    this.o = o;
    if (!o.clientId || !o.secret) throw new Error('PayPal credentials missing');
  }

  private spend(kind: CallKind) { return spend(this.o.store, this.o.grant, 'paypal', [kind], this.o.now(), this.o.onBudgetReached as never); }

  private async fetch(url: string, init: RequestInit): Promise<Response> {
    if (!url.startsWith(SANDBOX_BASE + '/')) throw new Error(`refusing non-sandbox PayPal URL ${url}`);
    try {
      return await (this.o.fetchImpl ?? fetch)(url, { ...init, signal: AbortSignal.timeout(10_000) });
    } catch (e) {
      throw new NoResponse(`PayPal call failed without a response: ${(e as Error).name}`);
    }
  }

  private async bearer(): Promise<string> {
    if (this.token && Date.now() < this.token.until) return this.token.value;
    await this.spend('reads');
    const r = await this.fetch(`${SANDBOX_BASE}/v1/oauth2/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`${this.o.clientId}:${this.o.secret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    });
    const body = (await r.json().catch(() => ({}))) as { access_token?: string; expires_in?: number };
    if (!r.ok || !body.access_token) throw new Error(`PayPal auth failed: ${r.status}`);
    this.token = { value: body.access_token, until: Date.now() + ((body.expires_in ?? 600) - 300) * 1000 };
    return body.access_token;
  }

  /** `body` is JSON-encoded; a string `rawBody` is sent byte for byte (S5-D4 frozen requests). */
  async call(kind: CallKind, method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown, headers: Record<string, string> = {}, rawBody?: string): Promise<HttpResult> {
    const token = await this.bearer();
    await this.spend(kind);
    const r = await this.fetch(`${SANDBOX_BASE}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'return=representation', ...headers },
      body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
    let text: string;
    try { text = await r.text(); } catch { throw new NoResponse('PayPal response body lost'); }
    if (r.status === 401) this.token = null;
    let parsed: unknown = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { unparsed: text.slice(0, 500) }; }
    return { status: r.status, body: parsed, raw: text, rawSha256: createHash('sha256').update(text).digest('hex') };
  }
}
