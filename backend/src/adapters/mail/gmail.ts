// Gmail over REST (S5-D26; pattern of qloo-landfall's gmail adapter). OAuth client in Google's Testing mode: refresh tokens
// last 7 days, so the owner reconnects weekly (`npm run mail:connect`). The refresh token is sealed with the S2 vault and stored
// per test sender (`GMAIL#<sender>`, provider table). A refused refresh marks the connection EXPIRED: messages wait, never faked.
import type { Sealed } from '@headroom/contracts';
import type { Store } from '../store/port.ts';
import { seal, unseal, type Vault } from '../vault.ts';
import { MailNoResponse, MailNotConnected, MailRejected, type AuthVerdict, type MailChannel, type MailRecord } from './types.ts';

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GMAIL_SCOPES = 'openid email https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly';
export const TESTING_DAYS = 7;
/** One test sender per deployment (like the PayPal connection), so the API can read the connection state without knowing it. */
export const gmailPk = (_sender?: string | null) => 'GMAIL#test-sender';
/** The dev KMS key policy requires a tenantId in every context; this connection is deployment-level. */
const ctxOf = (sender: string) => ({ tenantId: 'deployment', purpose: 'gmail-refresh-token', sender: sender.toLowerCase() });

export interface GmailOpts { store: Store; vault: Vault; sender: string; clientId: string; clientSecret: string; now: () => string; fetchImpl?: typeof fetch }
export interface GmailConn { email: string; sealed: Sealed; scopes: string; connectedAt: string; state: 'CONNECTED' | 'EXPIRED'; expiredAt: string | null }

/** Save a fresh connection (connect script / local operator endpoint). The account must be the configured test sender. */
export async function saveConnection(store: Store, vault: Vault, sender: string, o: { email: string; refreshToken: string; scopes: string; now: string }) {
  if (o.email.toLowerCase() !== sender.toLowerCase()) throw new Error(`Signed in as ${o.email}, not this deployment's test sender`);
  for (const s of ['https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.readonly']) if (!o.scopes.split(' ').includes(s)) throw new Error(`Google didn't grant ${s}`);
  const conn: GmailConn = { email: o.email.toLowerCase(), sealed: await seal(vault, o.refreshToken, ctxOf(sender)), scopes: o.scopes, connectedAt: o.now, state: 'CONNECTED', expiredAt: null };
  await store.transact([{ op: 'put', table: 'provider', item: { pk: gmailPk(sender), sk: 'CONN', ...conn } }]);
}

/** Authenticity verdict from Gmail's own Authentication-Results header (source PROVIDER), or null without one. */
export function verdictOf(rawText: string): AuthVerdict | null {
  const head = rawText.split(/\r?\n\r?\n/)[0].replace(/\r?\n[ \t]+/g, ' ');
  const ar = head.split(/\r?\n/).find((l) => /^authentication-results:/i.test(l) && /mx\.google\.com/i.test(l));
  if (!ar) return null;
  const v = (k: string) => { const m = new RegExp(`\\b${k}=(\\w+)`, 'i').exec(ar); return !m ? 'none' : m[1].toLowerCase() === 'pass' ? 'pass' : 'fail'; };
  return { source: 'PROVIDER', dkim: v('dkim'), spf: v('spf'), dmarc: v('dmarc') };
}

export class GmailChannel implements MailChannel {
  readonly kind = 'GMAIL' as const;
  private o: GmailOpts;
  private access: { token: string; until: number } | null = null;
  constructor(o: GmailOpts) { this.o = o; }

  private async conn() { return (await this.o.store.get('provider', gmailPk(this.o.sender), 'CONN')) as (GmailConn & { pk: string; sk: string }) | undefined; }

  private async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    if (!url.startsWith('https://gmail.googleapis.com/') && url !== TOKEN_URL) throw new Error(`refusing non-Google URL ${url}`);
    try { return await (this.o.fetchImpl ?? fetch)(url, { ...init, signal: AbortSignal.timeout(10_000) }); }
    catch (e) { throw new MailNoResponse(`Gmail call failed without a response: ${(e as Error).name}`); }
  }

  private async bearer(): Promise<string> {
    if (this.access && Date.now() < this.access.until) return this.access.token;
    const c = await this.conn();
    if (!c || c.state !== 'CONNECTED') throw new MailNotConnected(c ? 'Gmail sign-in expired (test sign-ins last 7 days): reconnect with npm run mail:connect' : 'Gmail is not connected: run npm run mail:connect');
    const r = await this.fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.o.clientId, client_secret: this.o.clientSecret, refresh_token: await unseal(this.o.vault, c.sealed), grant_type: 'refresh_token' }) });
    if (r.status === 400 || r.status === 401) {
      // invalid_grant: the 7-day Testing-mode token lapsed or was revoked. Recorded so every screen says "reconnect".
      await this.o.store.transact([{ op: 'update', table: 'provider', pk: c.pk, sk: 'CONN', set: { state: 'EXPIRED', expiredAt: this.o.now() }, cond: { eq: { connectedAt: c.connectedAt } } }]).catch(() => {});
      throw new MailNotConnected('Gmail sign-in expired (test sign-ins last 7 days): reconnect with npm run mail:connect');
    }
    const b = (await r.json().catch(() => ({}))) as { access_token?: string; expires_in?: number };
    if (!r.ok || !b.access_token) throw new MailNoResponse(`Google token endpoint ${r.status}`);
    this.access = { token: b.access_token, until: Date.now() + ((b.expires_in ?? 3600) - 120) * 1000 };
    return b.access_token;
  }

  private async api(path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
    const r = await this.fetch(`${API}${path}`, { ...init, headers: { Authorization: `Bearer ${await this.bearer()}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) } });
    if (r.status === 401) this.access = null;
    let body: unknown = null;
    try { body = await r.json(); } catch { if (r.ok) throw new MailNoResponse('Gmail response body lost'); }
    return { status: r.status, body };
  }

  async ready() {
    try { await this.bearer(); return { ok: true as const }; }
    catch (e) { return { ok: false as const, reason: e instanceof MailNotConnected ? e.message : `Gmail unreachable: ${(e as Error).message}` }; }
  }

  async send(raw: string) {
    const r = await this.api('/messages/send', { method: 'POST', body: JSON.stringify({ raw }) });
    if (r.status === 200 && r.body?.id && r.body?.threadId) return { messageId: r.body.id as string, threadId: r.body.threadId as string };
    if (r.status === 400) throw new MailRejected(`Gmail rejected the message: ${r.body?.error?.message ?? 'invalid request'}`);
    throw new MailNoResponse(`Gmail send ${r.status}`); // 401/5xx/other: outcome unknown → search, never resend
  }

  async get(id: string): Promise<MailRecord | null> {
    const r = await this.api(`/messages/${encodeURIComponent(id)}?format=raw`);
    if (r.status === 404) return null;
    if (r.status !== 200) throw new MailNoResponse(`Gmail get ${r.status}`);
    const text = Buffer.from(r.body.raw, 'base64url').toString('utf8');
    return { messageId: r.body.id, threadId: r.body.threadId, labelIds: r.body.labelIds ?? [], raw: r.body.raw, internalDate: new Date(Number(r.body.internalDate)).toISOString(), historyId: Number(r.body.historyId), authVerdict: verdictOf(text) };
  }

  async peek(id: string) {
    const r = await this.api(`/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=To&metadataHeaders=Delivered-To&metadataHeaders=Cc&metadataHeaders=In-Reply-To&metadataHeaders=References`);
    if (r.status === 404) return null;
    if (r.status !== 200) throw new MailNoResponse(`Gmail metadata ${r.status}`);
    const h = (n: string) => ((r.body?.payload?.headers ?? []) as { name: string; value: string }[]).filter((x) => x.name.toLowerCase() === n.toLowerCase()).map((x) => x.value);
    return { to: [...h('To'), ...h('Delivered-To'), ...h('Cc')], inReplyTo: h('In-Reply-To')[0] ?? null, references: h('References').join(' ').split(/\s+/).filter(Boolean) };
  }

  async search(q: string) {
    const r = await this.api(`/messages?q=${encodeURIComponent(q)}&includeSpamTrash=true`);
    if (r.status !== 200) throw new MailNoResponse(`Gmail list ${r.status}`);
    return ((r.body?.messages ?? []) as { id: string; threadId: string }[]).map((m) => ({ messageId: m.id, threadId: m.threadId }));
  }

  async currentCursor() {
    const r = await this.api('/profile');
    if (r.status !== 200) throw new MailNoResponse(`Gmail profile ${r.status}`);
    return String(r.body.historyId);
  }

  /** ponytail: one page of 50 per call (the cursor advances page by page). A cursor too old for Gmail (404) restarts at now. */
  async history(cursor: string | null, pageSize = 50) {
    const start = cursor ?? (await this.currentCursor());
    const r = await this.api(`/history?startHistoryId=${encodeURIComponent(start)}&historyTypes=messageAdded&labelId=INBOX&maxResults=${pageSize}`);
    if (r.status === 404) return { messages: [], nextCursor: await this.currentCursor() };
    if (r.status !== 200) throw new MailNoResponse(`Gmail history ${r.status}`);
    const seen = new Set<string>();
    const hist = (r.body?.history ?? []) as { id: string; messagesAdded?: { message: { id: string; threadId: string; labelIds?: string[] } }[] }[];
    const messages = hist.flatMap((h) => h.messagesAdded ?? []).map((m) => m.message)
      .filter((m) => (m.labelIds ?? []).includes('INBOX') && !seen.has(m.id) && seen.add(m.id))
      .map((m) => ({ messageId: m.id, threadId: m.threadId }));
    // More pages: continue after the last record read; otherwise Gmail's current position.
    return { messages, nextCursor: r.body?.nextPageToken && hist.length ? String(hist[hist.length - 1].id) : String(r.body?.historyId ?? start) };
  }
}
