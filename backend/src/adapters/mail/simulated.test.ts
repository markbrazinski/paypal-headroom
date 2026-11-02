import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../store/memory.ts';
import { channelContract } from './channel.contract.ts';
import { b64url, buildMessage, parseMessage } from './rfc5322.ts';
import { SimulatedMailbox } from './simulated.ts';
import { MailNoResponse, MailRejected, type AuthVerdict } from './types.ts';

const OWNER = 'owner@headroom.example', AP = 'ap@pellow.example';
const now = () => '2026-11-09T15:00:00.000Z';
const PASS: AuthVerdict = { source: 'SIMULATED', dkim: 'pass', spf: 'pass', dmarc: 'pass' };
const mailbox = (s = new MemoryStore()) => new SimulatedMailbox(s, OWNER, now);
const raw = (messageId: string, o: { from?: string; to?: string[]; inReplyTo?: string; references?: string[] } = {}) =>
  b64url.encode(buildMessage({ from: o.from ?? OWNER, to: o.to ?? [AP], subject: 'Invoice 0042', text: 'Hello', messageId, date: now(), inReplyTo: o.inReplyTo, references: o.references }));

channelContract('simulated', async () => {
  const channel = mailbox();
  return { channel, deliverInbound: async (r) => { await channel.inject({ raw: r, auth: PASS }); } };
});

test('M1 mail: TIMEOUT fault stores the message and throws MailNoResponse; search reconciles it', async () => {
  const mb = mailbox();
  await mb.setFault('TIMEOUT');
  await assert.rejects(mb.send(raw('<t.1@headroom>')), MailNoResponse);
  const [hit] = await mb.search('rfc822msgid:t.1@headroom');
  assert.ok(hit);
  assert.deepEqual((await mb.get(hit.messageId))?.labelIds, ['SENT']);
  assert.ok(await mb.send(raw('<t.2@headroom>'))); // fault consumed
});

test('M1 mail: REJECT fault throws MailRejected and stores nothing', async () => {
  const mb = mailbox();
  await mb.setFault('REJECT');
  await assert.rejects(mb.send(raw('<r.1@headroom>')), MailRejected);
  assert.deepEqual(await mb.search('rfc822msgid:r.1@headroom'), []);
  assert.deepEqual(await mb.list(), []);
  assert.deepEqual(await mb.list(AP), []);
  assert.equal(await mb.currentCursor(), '0');
});

test('M1 mail: each recipient gets an INBOX copy in its own mailbox', async () => {
  const mb = mailbox();
  const r = raw('<c.1@headroom>', { to: [AP, 'AR@Pellow.example'] });
  await mb.send(r);
  for (const who of [AP, 'ar@pellow.example']) {
    const [copy] = await mb.list(who);
    assert.deepEqual(copy.labelIds, ['INBOX']);
    assert.equal(copy.raw, r);
    assert.equal(copy.direction, 'IN');
    assert.equal(copy.rfcMessageId, '<c.1@headroom>');
  }
  assert.deepEqual((await mb.history(null)).messages, []); // the owner's own send is not inbound
});

test('M1 mail: a reply joins the thread it answers (In-Reply-To or References)', async () => {
  const mb = mailbox();
  const sent = await mb.send(raw('<root.1@headroom>'));
  const reply = await mb.inject({ raw: raw('<x1@pellow.example>', { from: AP, to: [OWNER], inReplyTo: '<root.1@headroom>' }), auth: PASS });
  assert.equal(reply.threadId, sent.threadId);
  const viaRefs = await mb.inject({ raw: raw('<x2@pellow.example>', { from: AP, to: [OWNER], references: ['<unknown@x>', '<root.1@headroom>'] }), auth: PASS });
  assert.equal(viaRefs.threadId, sent.threadId);
  const fresh = await mb.inject({ raw: raw('<x3@pellow.example>', { from: AP, to: [OWNER] }), auth: PASS });
  assert.notEqual(fresh.threadId, sent.threadId);
  assert.deepEqual((await mb.get(reply.messageId))?.authVerdict, PASS);
});

test('M1 mail: concurrent sends get distinct historyIds', async () => {
  const mb = mailbox();
  await Promise.all([1, 2, 3, 4, 5].map((i) => mb.send(raw(`<cc.${i}@headroom>`))));
  assert.deepEqual((await mb.list()).map((m) => m.historyId).sort(), [1, 2, 3, 4, 5]);
  assert.deepEqual((await mb.list(AP)).map((m) => m.historyId).sort(), [1, 2, 3, 4, 5]);
  assert.equal(await mb.currentCursor(), '5');
});

test('M1 mail: rfc5322 round trip with a PDF attachment and folded headers', () => {
  const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(300, 0xff)]);
  const refs = ['<a.1@headroom>', '<a.2@headroom>', '<a.3@headroom>'];
  const built = buildMessage({ from: '"Ops" <owner@headroom.example>', to: [AP], subject: 'Bill — Nov', text: 'Line 1\nLine 2\n', messageId: '<m.1@headroom>', inReplyTo: '<a.3@headroom>', references: refs, date: now(), attachments: [{ name: 'bill.pdf', mime: 'application/pdf', bytes: pdf }] });
  assert.ok(built.split('\r\n').every((l) => l.length <= 998));
  assert.match(built, /References: <a\.1@headroom>\r\n <a\.2@headroom>/);
  const p = parseMessage(built);
  assert.deepEqual(p.fromAddresses, ['owner@headroom.example']);
  assert.deepEqual(p.to, [AP]);
  assert.equal(p.subject, 'Bill — Nov');
  assert.equal(p.messageId, '<m.1@headroom>');
  assert.equal(p.inReplyTo, '<a.3@headroom>');
  assert.deepEqual(p.references, refs);
  assert.equal(p.date, now());
  assert.equal(p.text, 'Line 1\nLine 2\n');
  assert.equal(p.attachments.length, 1);
  assert.equal(p.attachments[0].name, 'bill.pdf');
  assert.equal(p.attachments[0].mime, 'application/pdf');
  assert.ok(p.attachments[0].bytes.equals(pdf));

  const folded = parseMessage('From: ap@pellow.example\nFrom: "ap@pellow.example"\n <x@attacker.example>\nSubject: a\n  folded subject\nMessage-ID: <f@x>\n\nhi');
  assert.equal(folded.subject, 'a  folded subject');
  assert.deepEqual(folded.fromAddresses, ['ap@pellow.example', 'x@attacker.example']);
  assert.equal(folded.from.length, 2);
  assert.equal(folded.text, 'hi');
  assert.throws(() => buildMessage({ from: OWNER, to: [AP], subject: 'x\r\nBcc: evil@x', text: '', messageId: '<i@h>', date: now() }));
});
