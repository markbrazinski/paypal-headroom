// SIMULATED mail channel (S5-D1): a Gmail-shaped mailbox in the provider table (survives demo resets like provider data). No mail
// ever leaves; each recipient gets a copy in its own simulated mailbox so an operator can show the other side. Never delivery evidence.
// Layout under pk SIMMAIL#<address>: HIST {historyId}, MSG#<messageId> (MailRecord + rfcMessageId + direction),
// RFC#<Message-ID without brackets> {messageId, threadId} (dedupe + search + threading), FAULT {failNext}.
// ponytail: history and list scan the whole mailbox. Ceiling: demo-sized mailboxes; a by-historyId sort key if that grows.
import { randomBytes } from 'node:crypto';
import { TxCancelled, type Op, type Store } from '../store/port.ts';
import { b64url, parseMessage, type ParsedMessage } from './rfc5322.ts';
import { MailNoResponse, MailRejected, type AuthVerdict, type MailChannel, type MailRecord } from './types.ts';

export type MailFault = 'TIMEOUT' | 'REJECT' | null;
export type StoredMail = MailRecord & { rfcMessageId: string; direction: 'OUT' | 'IN' };
type Ids = { messageId: string; threadId: string };

const pkOf = (address: string) => `SIMMAIL#${address.trim().toLowerCase()}`;
const bare = (id: string) => id.trim().replace(/^<|>$/g, '');
const record = ({ messageId, threadId, labelIds, raw, internalDate, historyId, authVerdict }: any): MailRecord =>
  ({ messageId, threadId, labelIds, raw, internalDate, historyId, authVerdict });

export class SimulatedMailbox implements MailChannel {
  readonly kind = 'SIMULATED' as const;
  private store: Store;
  private address: string;
  private now: () => string;
  constructor(store: Store, address: string, now: () => string) {
    this.store = store;
    this.address = address;
    this.now = now;
  }

  async ready() { return { ok: true } as const; }

  async send(rawBase64Url: string): Promise<Ids> {
    const p = parseMessage(b64url.decode(rawBase64Url).toString('utf8'));
    if (!p.messageId || !p.to.length) throw new MailRejected('message needs a Message-ID and a recipient');
    const own = pkOf(this.address);
    return this.retry(async () => {
      const fault = ((await this.store.get('provider', own, 'FAULT'))?.failNext ?? null) as MailFault;
      const consume: Op[] = fault ? [{ op: 'update', table: 'provider', pk: own, sk: 'FAULT', set: { failNext: null }, cond: { eq: { failNext: fault } } }] : [];
      if (fault === 'REJECT') {
        await this.store.transact(consume);
        throw new MailRejected('simulated: rejected (injected fault)');
      }
      const dup = await this.byRfc(own, p.messageId!);
      if (dup) return dup;
      const recipients = [...new Set(p.to.map(pkOf))];
      const mine = await this.entry(own, p, rawBase64Url, recipients.includes(own) ? ['SENT', 'INBOX'] : ['SENT'], null, 'OUT');
      const ops = [...mine.ops, ...consume];
      for (const r of recipients) if (r !== own && !(await this.byRfc(r, p.messageId!))) ops.push(...(await this.entry(r, p, rawBase64Url, ['INBOX'], null, 'IN')).ops);
      await this.store.transact(ops);
      if (fault === 'TIMEOUT') throw new MailNoResponse('simulated: stored but no response (injected fault)');
      return mine.ids;
    });
  }

  /** Operator: a message arriving from outside. `raw` is base64url like everywhere on the port; `auth` is operator-supplied. */
  async inject(m: { raw: string; auth: AuthVerdict }): Promise<Ids> {
    const p = parseMessage(b64url.decode(m.raw).toString('utf8'));
    if (!p.messageId) throw new Error('inbound message needs a Message-ID');
    const own = pkOf(this.address);
    return this.retry(async () => {
      const dup = await this.byRfc(own, p.messageId!);
      if (dup) return dup;
      const e = await this.entry(own, p, m.raw, ['INBOX'], m.auth, 'IN');
      await this.store.transact(e.ops);
      return e.ids;
    });
  }

  /** Test/operator: fault consumed by the next send. */
  async setFault(failNext: MailFault) {
    await this.store.transact([{ op: 'update', table: 'provider', pk: pkOf(this.address), sk: 'FAULT', set: { failNext } }]);
  }

  /** Operator: a mailbox (default this one), newest first. */
  async list(address = this.address): Promise<StoredMail[]> {
    const items = await this.store.query('provider', pkOf(address), { skPrefix: 'MSG#' });
    return items.sort((a, b) => b.historyId - a.historyId).map((i) => ({ ...record(i), rfcMessageId: i.rfcMessageId, direction: i.direction }));
  }

  async get(messageId: string) {
    const i = await this.store.get('provider', pkOf(this.address), `MSG#${messageId}`);
    return i ? record(i) : null;
  }

  async search(query: string) {
    const m = /^rfc822msgid:(.+)$/.exec(query.trim());
    if (!m) throw new Error(`simulated mailbox: unsupported query ${query}`);
    const hit = await this.byRfc(pkOf(this.address), m[1]);
    return hit ? [hit] : [];
  }

  async history(cursor: string | null, pageSize = 50) {
    const after = Number(cursor ?? 0);
    if (!Number.isInteger(after) || after < 0) throw new Error(`simulated mailbox: bad cursor ${cursor}`);
    const items = await this.store.query('provider', pkOf(this.address), { skPrefix: 'MSG#' });
    const page = items.filter((i) => i.labelIds.includes('INBOX') && i.historyId > after).sort((a, b) => a.historyId - b.historyId).slice(0, pageSize);
    // Empty page → the input position, never "current": an inbound committed after the scan would otherwise be skipped.
    return { messages: page.map((i) => ({ messageId: i.messageId, threadId: i.threadId })), nextCursor: String(page.at(-1)?.historyId ?? after) };
  }

  async currentCursor() {
    return String((await this.store.get('provider', pkOf(this.address), 'HIST'))?.historyId ?? 0);
  }

  private async byRfc(pk: string, rfcMessageId: string): Promise<Ids | null> {
    const i = await this.store.get('provider', pk, `RFC#${bare(rfcMessageId)}`);
    return i ? { messageId: i.messageId, threadId: i.threadId } : null;
  }

  /** Ops storing `p` in mailbox `pk` with the next historyId; the HIST condition makes concurrent writers serialize. */
  private async entry(pk: string, p: ParsedMessage, raw: string, labelIds: string[], authVerdict: AuthVerdict | null, direction: 'OUT' | 'IN') {
    const prev = (await this.store.get('provider', pk, 'HIST'))?.historyId as number | undefined;
    const historyId = (prev ?? 0) + 1;
    const messageId = `sim-${historyId}-${randomBytes(3).toString('hex')}`;
    let threadId = messageId;
    for (const ref of [p.inReplyTo, ...[...p.references].reverse()]) {
      const parent = ref ? await this.byRfc(pk, ref) : null;
      if (parent) { threadId = parent.threadId; break; }
    }
    const item = { pk, sk: `MSG#${messageId}`, messageId, threadId, labelIds, raw, internalDate: this.now(), historyId, authVerdict, rfcMessageId: p.messageId!, direction };
    const ops: Op[] = [
      { op: 'put', table: 'provider', item, cond: { notExists: true } },
      { op: 'put', table: 'provider', item: { pk, sk: `RFC#${bare(p.messageId!)}`, messageId, threadId }, cond: { notExists: true } },
      { op: 'update', table: 'provider', pk, sk: 'HIST', add: { historyId: 1 }, cond: prev === undefined ? { notExists: true } : { eq: { historyId: prev } } },
    ];
    return { ids: { messageId, threadId }, ops };
  }

  private async retry<T>(f: () => Promise<T>): Promise<T> {
    for (let i = 0; i < 10; i++) {
      try { return await f(); } catch (e) { if (!(e instanceof TxCancelled)) throw e; }
    }
    throw new Error('simulated mailbox: write contention');
  }
}
