// Behavior every MailChannel adapter must show (SimulatedMailbox now, Gmail later). `deliverInbound` puts a base64url RFC 5322 message
// into the channel's INBOX from outside.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { b64url, buildMessage } from './rfc5322.ts';
import type { MailChannel } from './types.ts';

type Make = () => Promise<{ channel: MailChannel; deliverInbound: (raw: string) => Promise<void> }>;

let n = 0;
const msg = (o: { from?: string; to?: string; id?: string } = {}) => {
  const messageId = o.id ?? `<contract.${process.pid}.${++n}@headroom>`;
  const raw = b64url.encode(buildMessage({ from: o.from ?? 'owner@headroom.example', to: [o.to ?? 'ap@pellow.example'], subject: `contract ${n}`, text: `body ${n}\n`, messageId, date: '2026-11-09T15:00:00.000Z' }));
  return { messageId, raw };
};
const inbound = () => msg({ from: 'ap@pellow.example', to: 'owner@headroom.example' });

export function channelContract(name: string, make: Make) {
  describe(`M1 mail: channel contract (${name})`, () => {
    test('ready() resolves ok for a working channel', async () => {
      const { channel } = await make();
      assert.deepEqual(await channel.ready(), { ok: true });
    });

    test('send → get shows SENT and the identical raw', async () => {
      const { channel } = await make();
      const m = msg();
      const sent = await channel.send(m.raw);
      const got = await channel.get(sent.messageId);
      assert.ok(got);
      assert.ok(got.labelIds.includes('SENT'));
      assert.equal(got.raw, m.raw);
      assert.equal(got.threadId, sent.threadId);
      assert.equal(await channel.get('no-such-message'), null);
    });

    test('search by rfc822msgid finds it with and without angle brackets', async () => {
      const { channel } = await make();
      const m = msg();
      const sent = await channel.send(m.raw);
      const bare = m.messageId.slice(1, -1);
      assert.deepEqual(await channel.search(`rfc822msgid:${bare}`), [sent]);
      assert.deepEqual(await channel.search(`rfc822msgid:${m.messageId}`), [sent]);
      assert.deepEqual(await channel.search('rfc822msgid:never-sent@headroom'), []);
    });

    test('the same Message-ID sent twice is one message (duplicate delivery → same id)', async () => {
      const { channel } = await make();
      const m = msg();
      const a = await channel.send(m.raw);
      const b = await channel.send(m.raw);
      assert.deepEqual(b, a);
    });

    test('history: monotonic cursor, inbound only, page boundaries lose nothing', async () => {
      const { channel, deliverInbound } = await make();
      await channel.send(msg().raw);
      const ins = [inbound(), inbound(), inbound(), inbound(), inbound()];
      for (const m of ins) await deliverInbound(m.raw);
      await channel.send(msg().raw);
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 10; i++) {
        const page: Awaited<ReturnType<MailChannel['history']>> = await channel.history(cursor, 2);
        assert.ok(page.messages.length <= 2);
        if (cursor !== null) assert.ok(Number(page.nextCursor) >= Number(cursor));
        for (const x of page.messages) seen.push(x.messageId);
        cursor = page.nextCursor;
        if (!page.messages.length) break;
      }
      const expected = [];
      for (const m of ins) expected.push((await channel.search(`rfc822msgid:${m.messageId}`))[0].messageId);
      assert.deepEqual(seen, expected);
      assert.deepEqual((await channel.history(cursor)).messages, []);
    });

    test('currentCursor then one new inbound → history(current) returns exactly that one', async () => {
      const { channel, deliverInbound } = await make();
      await deliverInbound(inbound().raw);
      await channel.send(msg().raw);
      const cur = await channel.currentCursor();
      const m = inbound();
      await deliverInbound(m.raw);
      const [hit] = await channel.search(`rfc822msgid:${m.messageId}`);
      const h = await channel.history(cur);
      assert.deepEqual(h.messages, [hit]);
      assert.ok(Number(h.nextCursor) > Number(cur));
    });
  });
}
