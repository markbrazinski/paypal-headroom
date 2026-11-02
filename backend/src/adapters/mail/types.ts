// MailChannel port (S5-D1): mirrors the Gmail API shape so a Gmail adapter drops in later. S5 ships only SimulatedMailbox,
// labelled SIMULATED everywhere; a simulated send is never delivery evidence (Build Book §E 17).

/** The channel's verdict on an inbound message's authenticity. SIMULATED = supplied by the operator, never by a provider. */
export interface AuthVerdict { source: 'SIMULATED' | 'PROVIDER'; dkim: 'pass' | 'fail' | 'none'; spf: 'pass' | 'fail' | 'none'; dmarc: 'pass' | 'fail' | 'none' }

/** users.messages.get (format=raw), reduced. `raw` is the RFC 5322 message, base64url. */
export interface MailRecord {
  messageId: string;
  threadId: string;
  labelIds: string[]; // 'SENT' | 'INBOX'
  raw: string;
  internalDate: string; // ISO instant
  historyId: number;
  authVerdict: AuthVerdict | null;
}

/** The send reached the channel but no answer came back: outcome unknown. Reconcile by search, never resend. */
export class MailNoResponse extends Error {}
/** The channel definitively refused the message. */
export class MailRejected extends Error {}
/** No usable connection (never connected, or the 7-day test sign-in expired): nothing was sent. Reconnect, then it goes. */
export class MailNotConnected extends Error {}

export interface MailChannel {
  readonly kind: 'SIMULATED' | 'GMAIL';
  /** Checked before every send claim: a channel that can't send leaves the message waiting, never shown as sent. */
  ready(): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** users.messages.send. Throws MailNoResponse (unknown) or MailRejected (definitive). */
  send(rawBase64Url: string): Promise<{ messageId: string; threadId: string }>;
  /** users.messages.get; null when the channel has no such message. */
  get(messageId: string): Promise<MailRecord | null>;
  /** users.messages.list?q=… ; S5 uses only `rfc822msgid:<Message-ID without angle brackets>`. */
  search(query: string): Promise<{ messageId: string; threadId: string }[]>;
  /** users.history.list for the INBOX: messages added after `cursor` (null = from the start), oldest first, and the next cursor. */
  history(cursor: string | null, pageSize?: number): Promise<{ messages: { messageId: string; threadId: string }[]; nextCursor: string }>;
  /**
   * Headers only (no body): lets intake skip mail that isn't Headroom's without ever reading or storing it (S5-D26 privacy).
   * Optional: the simulated mailbox holds only Headroom's own traffic.
   */
  peek?(messageId: string): Promise<{ to: string[]; inReplyTo: string | null; references: string[] } | null>;
  /** The mailbox's current history position (a new run starts here so an old run's mail is never re-ingested). */
  currentCursor(): Promise<string>;
}
