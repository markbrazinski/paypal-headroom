// Inbound mail (S5-D20, D21, S5-PR-09). MAIL_SYNC pulls the channel's history; per message the raw MIME is stored, the message is
// classified and sender-gated deterministically, and ONE TX writes MAIL# (notExists) with its downstream work: the REPLY_INTERPRET
// job, the S3 bill ingestion per PDF, or nothing (UNFILED / HELD). The run's cursor moves only after every message on the page has
// committed, so a crash replays the page and the notExists makes the replay harmless.
import { createHash } from 'node:crypto';
import { ReplyInterpreterOutput, type MailMessage, type Policy, type PromiseRecord } from '@headroom/contracts';
import { valueOf } from '../delegation/policy.ts';
import { basisBumpOp, K } from '../../adapters/store/keys.ts';
import { TxCancelled, type Item, type Op } from '../../adapters/store/port.ts';
import { b64url, parseMessage } from '../../adapters/mail/rfc5322.ts';
import type { Deps } from '../../deps.ts';
import { finishOp, newJob, putJobOp, requeueRecurring, type Lease } from '../../jobs/lease.ts';
import { auditOp } from '../audit/audit.ts';
import { getRun } from '../identity-run/run.ts';
import { ingestCommand } from '../evidence/ingest.ts';
import { addDays, addMs, businessDate, MIN } from '../time.ts';
import { askRole } from '../plan/model.ts';
import { disputeSplit, senderGate, replyGate } from './gates.ts';
import { proposeDisputeOps } from '../receivables/dispute.ts';
import type { InvItem } from '../receivables/commands.ts';
import { outSk, type OutItem } from './send.ts';

export const mailSyncJobId = (runId: string) => `mailsync#${runId}`;
export const MAIL_SYNC_EVERY_MS = MIN;
const PAGE = 25;
const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
type MailItem = MailMessage & Item;

/** The MAIL_SYNC job a run starts with (reset): the cursor starts at the mailbox's current position, so an old run's mail is never re-read. */
export const mailSyncJob = (tenantId: string, runId: string, at: string) => newJob(mailSyncJobId(runId), 'MAIL_SYNC', runId, at, tenantId, runId);

export async function runMailSync(d: Deps, l: Lease): Promise<void> {
  const [tenantId, runId] = [l.job.tenantId!, l.job.runId!];
  const run = await getRun(d.store, tenantId, runId);
  const fence = await d.store.get('core', K.tenant(tenantId), 'RUN_FENCE');
  if (!d.mail || !run || fence?.runId !== runId) return void (await d.store.transact([finishOp(l, { kind: 'done' })]).catch(() => {}));
  const pk = K.run(tenantId, runId);
  const again = (error: string | null = null) => requeueRecurring(d.store, l, { kind: 'requeue', at: addMs(d.now(), MAIL_SYNC_EVERY_MS), error, resetAttempts: true });
  const ready = await d.mail.channel.ready();
  if (!ready.ok) return again(ready.reason);
  const cur = await d.store.get('core', pk, 'MAILCURSOR');
  if (!cur) {
    await d.store.transact([{ op: 'put', table: 'core', item: { pk, sk: 'MAILCURSOR', historyId: await d.mail.channel.currentCursor(), version: 1 }, cond: { notExists: true } }]).catch((e) => { if (!(e instanceof TxCancelled)) throw e; });
    return again();
  }
  const page = await d.mail.channel.history(cur.historyId, PAGE);
  const outs = (await d.store.query('core', pk, { skPrefix: 'OUTMSG#' })) as OutItem[];
  for (const m of page.messages) await intake(d, { tenantId, runId, pk, run }, m.messageId, outs);
  if (page.nextCursor !== cur.historyId) await d.store.transact([{ op: 'update', table: 'core', pk, sk: 'MAILCURSOR', set: { historyId: page.nextCursor, version: cur.version + 1 }, cond: { eq: { version: cur.version } } }]);
  // A full page means more may be waiting: come straight back.
  if (page.messages.length >= PAGE) return void (await d.store.transact([finishOp(l, { kind: 'requeue', at: d.now(), resetAttempts: true })]));
  return again();
}

/**
 * Only mail meant for Headroom is taken in (S5-D26, a real personal inbox): a reply to one of Headroom's own messages, or mail sent
 * to the "+headroom" address (bills). Anything else is skipped from its headers alone: never read, never stored, never listed.
 */
export const forHeadroom = (h: { to: string[]; inReplyTo: string | null; references: string[] }) =>
  [h.inReplyTo, ...h.references].some((x) => !!x && /@headroom>?$/.test(x.trim())) || h.to.some((x) => /\+headroom[^@\s]*@/i.test(x));

async function intake(d: Deps, r: { tenantId: string; runId: string; pk: string; run: NonNullable<Awaited<ReturnType<typeof getRun>>> }, messageId: string, outs: OutItem[]) {
  if (await d.store.get('core', r.pk, `MAIL#${messageId}`)) return;
  if (d.mail!.channel.peek) {
    const h = await d.mail!.channel.peek(messageId);
    if (!h || !forHeadroom(h)) return;
  }
  const rec = await d.mail!.channel.get(messageId);
  if (!rec) return;
  const bytes = b64url.decode(rec.raw);
  const rawSha = sha(bytes);
  const storageKey = `T#${r.tenantId}/R#${r.runId}/mail/${rawSha}.eml`;
  await d.evidence?.put(storageKey, bytes); // stored before any processing (write-once, content-addressed)
  const p = parseMessage(bytes.toString('utf8'));
  const now = d.now();
  const refs = [p.inReplyTo, ...p.references].filter(Boolean) as string[];
  const out = outs.find((o) => refs.includes(o.rfcMessageId));
  const pdfs = p.attachments.filter((a) => a.mime === 'application/pdf');
  const customers = await d.store.query('core', r.pk, { skPrefix: 'CUST#' });
  const sup = out?.counterpartyRole === 'SUPPLIER' ? await d.store.get('core', r.pk, `SUP#${out.customerId}`) : undefined;
  const cust = out ? (sup ? { customerId: sup.supplierId, displayName: sup.displayName, billingEmail: sup.contactEmail } : customers.find((c) => c.customerId === out.customerId)) : undefined;
  const ops: Op[] = [];
  let processing: MailMessage['processing'] = 'UNFILED';
  let heldCode: string | null = null;
  let note = 'Not a reply to anything Headroom sent in this run, and no bill attached · no effect';
  let invoiceId: string | null = null;
  let customerId: string | null = out?.customerId ?? null;
  if (out) {
    // In test redirect the customer's stand-in is the private test inbox: the owner replies on the customer's behalf (S5-D26).
    const contact = d.mail!.redirectTo ?? cust?.billingEmail ?? null;
    const g = senderGate(p, rec.authVerdict, contact);
    if (g.ok) { processing = 'ROUTED'; note = `Reply from ${cust?.displayName ?? out.customerId}; reading it`; ops.push(putJobOp(newJob(`reply#${messageId}`, 'REPLY_INTERPRET', messageId, now, r.tenantId, r.runId))); }
    else { processing = 'HELD'; heldCode = g.code; note = `Held for you, not read: ${g.text}`; ops.push(auditOp({ tenantId: r.tenantId, runId: r.runId, type: 'SenderHeld', by: 'HEADROOM', result: `${cust?.displayName ?? 'Reply'}: ${g.text}; not interpreted, changes nothing`, refs: { mailId: messageId }, correlationId: `mail:${messageId}`, now })); }
  } else if (pdfs.length) {
    processing = 'ROUTED';
    note = `${pdfs.length} bill${pdfs.length > 1 ? 's' : ''} attached; reading through the bill pipeline`;
    const ctx = { tenantId: r.tenantId, run: r.run, now, correlationId: `mail:${messageId}`, ownerEmail: 'mail' };
    for (const a of pdfs) {
      try { ops.push(...(await ingestCommand(d.evidence, d.store, ctx, { fileName: a.name || 'bill.pdf', bytes: a.bytes, source: 'MAIL' })).ops); }
      catch (e) { note += ` · ${a.name}: ${(e as Error).message}`; }
    }
  } else if (p.to.some((x) => /\+headroom[^@\s]*@/i.test(x))) {
    // S7 R4: an original email to the business (no reply link, no bill), e.g. a customer disputing an invoice. It is read only when it
    // names exactly one invoice of THIS run and comes from that customer (or, in test redirect, from the connected test sender).
    const nums = [...new Set(`${p.subject}\n${p.text}`.match(/\bHR-[a-z0-9]+-\d{3}\b/gi) ?? [])];
    const refs = (await Promise.all(nums.map((n) => d.store.get('provider', K.invNum(n), 'REF')))).filter((x): x is Item => !!x && x.tenantId === r.tenantId);
    const mine = refs.filter((x) => x.runId === r.runId);
    if (mine.length === 1) {
      const inv = (await d.store.get('core', r.pk, `INV#${mine[0].invoiceId}`)) as InvItem | undefined;
      const c = inv && customers.find((x) => x.customerId === inv.customerId);
      const contacts = (d.mail!.redirectTo ? [d.mail!.redirectTo, d.mail!.address] : [c?.billingEmail ?? null]).filter((x): x is string => !!x);
      const gates = contacts.map((k) => senderGate(p, rec.authVerdict, k));
      const g = gates.find((x) => x.ok) ?? gates[0] ?? { ok: false as const, code: 'HOLD_UNAUTHORIZED' as const, text: 'no known contact for this customer' };
      if (inv && g.ok) {
        processing = 'ROUTED'; invoiceId = inv.invoiceId; customerId = inv.customerId;
        note = `Email from ${c?.displayName ?? inv.customerId} about ${inv.invoiceNumber}; reading it`;
        ops.push(putJobOp(newJob(`reply#${messageId}`, 'REPLY_INTERPRET', messageId, now, r.tenantId, r.runId)));
      } else {
        processing = 'HELD'; heldCode = g.ok ? 'HOLD_NO_INVOICE' : g.code; note = `Held for you, not read: ${g.ok ? 'invoice not found' : g.text}`;
        ops.push(auditOp({ tenantId: r.tenantId, runId: r.runId, type: 'SenderHeld', by: 'HEADROOM', result: `Email about ${mine[0].invoiceId}: ${note}; changes nothing`, refs: { mailId: messageId }, correlationId: `mail:${messageId}`, now }));
      }
    } else if (!mine.length && refs.length) {
      note = `About an invoice of an earlier sandbox run (${refs.map((x) => x.runId).join(', ')}) · no effect in this run`;
      ops.push(auditOp({ tenantId: r.tenantId, runId: r.runId, type: 'OldRunEventRouted', by: 'HEADROOM', result: `Email “${p.subject}” is about an earlier run’s invoice; not read in this run`, refs: { mailId: messageId, runId: refs[0].runId }, correlationId: `mail:${messageId}`, now }));
    } else {
      processing = 'HELD'; heldCode = 'HOLD_NO_INVOICE';
      note = mine.length > 1 ? 'Names more than one invoice: Headroom couldn’t tell which one this is about' : 'Couldn’t tell which invoice this is about';
    }
  }
  const item: MailItem = {
    pk: r.pk, sk: `MAIL#${messageId}`, messageId, threadId: rec.threadId, rfcMessageId: p.messageId, direction: 'IN', channel: d.mail!.channel.kind,
    from: p.from.join(', '), subject: p.subject, receivedAt: rec.internalDate, rawSha256: rawSha, storageKey, authVerdict: rec.authVerdict,
    attachments: p.attachments.map((a) => ({ name: a.name, mime: a.mime, sha256: sha(a.bytes) })), processing,
    binding: { runId: r.runId, rootId: out?.rootId ?? null, customerId, invoiceId }, heldCode, interpretation: null, seen: false,
  };
  const seen = new Set<string>();
  const unique = [{ op: 'put', table: 'core', item, cond: { notExists: true } } as Op, ...ops, auditOp({ tenantId: r.tenantId, runId: r.runId, type: 'MailReceived', by: 'HEADROOM', result: `${d.mail!.channel.kind === 'GMAIL' ? 'Gmail' : 'Simulated mailbox'}: “${p.subject}” · ${note}`, refs: { mailId: messageId }, correlationId: `mail:${messageId}`, now })]
    .filter((o) => { const k = o.op === 'put' ? `${o.table}:${o.item.pk}:${o.item.sk}` : `${o.table}:${o.pk}:${o.sk}`; if (seen.has(k)) return false; seen.add(k); return true; });
  try { await d.store.transact(unique); }
  catch (e) { if (!(e instanceof TxCancelled)) throw e; if (!e.failed[0]) throw e; } // failed[0]: already taken in, with its work
}

/** REPLY_INTERPRET: Nova reads one authorized reply; facts only as verbatim quotes, parsed by code (S5-D20). */
export async function runReplyInterpret(d: Deps, l: Lease, budget: { deadline: number; elapsed: () => number }): Promise<void> {
  const [tenantId, runId, messageId] = [l.job.tenantId!, l.job.runId!, l.job.ref];
  const pk = K.run(tenantId, runId);
  const m = (await d.store.get('core', pk, `MAIL#${messageId}`)) as MailItem | undefined;
  const run = await getRun(d.store, tenantId, runId);
  if (!m || !run || m.interpretation) return void (await d.store.transact([finishOp(l, { kind: 'done' })]).catch(() => {}));
  const raw = d.evidence ? await d.evidence.get(m.storageKey) : null;
  const body = raw ? parseMessage(Buffer.from(raw).toString('utf8')).text : null;
  const today = businessDate(d.now(), run.settings.timeZone);
  const res = !body ? { ok: false as const, reason: 'The stored message could not be read' } : await askRole(d, l, () => budget.deadline - budget.elapsed(), {
    role: d.replier, task: 'ReplyInterpreter', pk, buildId: `reply-${messageId}`, gen: 1, input: `<reply>\n${body.slice(0, 8_000)}\n</reply>`,
    gate: (x) => { const o = ReplyInterpreterOutput.safeParse(x); if (!o.success) return { ok: false, reason: 'Output does not match the reply schema' }; const g = replyGate(body, o.data, today); return g.ok ? { ok: true, value: g } : { ok: false, reason: g.reason }; },
  });
  const now = d.now();
  const audit = (type: Parameters<typeof auditOp>[0]['type'], result: string) => auditOp({ tenantId, runId, type, by: 'HEADROOM', result, refs: { mailId: messageId }, correlationId: `reply:${messageId}`, now });
  const ops: Op[] = [];
  let interpretation: MailMessage['interpretation'];
  if (!res.ok) {
    interpretation = { intent: 'OTHER', quote: '', on: null, amountMinor: null, refused: res.reason };
    ops.push(audit('ReplyInterpreted', `Needs you: read the reply (${res.reason})`));
  } else {
    const g = res.value;
    interpretation = { intent: g.intent, quote: g.quote, on: g.on, amountMinor: g.amountMinor, refused: null };
    if (m.binding.invoiceId && !['DISPUTE', 'DISPUTE_PARTIAL', 'PROMISE', 'PAID_CLAIM', 'QUESTION'].includes(g.intent)) interpretation.intent = 'OTHER';
    const outs = m.binding.rootId ? ((await d.store.query('core', pk, { skPrefix: `OUTMSG#${m.binding.rootId}#` })) as OutItem[]) : [];
    const act = outs[0] ? await d.store.get('core', pk, `ACT#${outs[0].actionId}`) : undefined;
    const invoiceId = (m.binding.invoiceId ?? act?.subject?.invoiceId) as string | undefined;
    if (m.binding.rootId?.startsWith('ASK:') && act?.kind === 'ASK_SUPPLIER') {
      // S7 R6: a supplier's answer to Headroom's ask. Recorded only; accepting it is the owner's act.
      const { recordAnswerOps } = await import('../obligations/supplier-answer.ts');
      ops.push(...recordAnswerOps({ tenantId, runId, askId: act.rootId, supplierId: act.counterparty.id, messageId, intent: g.intent, quote: g.quote, termsQuotes: g.termsQuotes, options: act.terms.askOptions ?? [], today, now }));
    } else if (g.intent === 'PROMISE' && g.on && invoiceId) {
      // S7 §6.1a ar.newDateDays: a date past the owner's limit (counted from the day the promise arrived) is kept, but counts only once the owner accepts it.
      const policy = (await d.store.get('core', pk, 'POLICY')) as unknown as Policy;
      const limit = valueOf<number>(policy, 'ar.newDateDays', 'RECEIVABLES', m.binding.customerId!);
      const beyond = g.on > addDays(businessDate(m.receivedAt ?? now, run.settings.timeZone), limit) ? limit : null;
      const pr: PromiseRecord = { promiseId: messageId, invoiceId, customerId: m.binding.customerId!, amount: g.amountMinor === null ? null : { currency: 'USD', minor: g.amountMinor }, on: g.on, quote: g.quote, sourceMessageId: messageId, basis: 'PROMISE', at: now, beyondLimitDays: beyond, acceptedBy: null };
      ops.push({ op: 'put', table: 'core', item: { pk, sk: `PROMISE#${messageId}`, ...pr }, cond: { notExists: true } }, basisBumpOp(pk),
        audit('PromiseRecorded', `Promise recorded from the reply (“${g.quote}”): ${g.on}${g.amountMinor !== null ? `, $${(g.amountMinor / 100).toFixed(2)}` : ''}. ${beyond !== null ? `Needs you: beyond your ${beyond}-day limit, so it is not counted until you accept it` : 'Expected only'}; never cash, never skips a fallback`));
    } else if ((g.intent === 'DISPUTE' || g.intent === 'DISPUTE_PARTIAL') && invoiceId) {
      // S7 R4: a pending stop + a proposal from the email's own words; the owner confirms the split (or dismisses it).
      const inv = (await d.store.get('core', pk, `INV#${invoiceId}`)) as InvItem | undefined;
      if (inv) ops.push(...(await proposeDisputeOps(d.store, { tenantId, runId, inv, messageId, quote: g.quote, split: disputeSplit(g.amountQuotes, inv.openGross.minor), now })), audit('ReplyInterpreted', `Dispute in the email (“${g.quote}”): waiting for you to confirm the split`));
    } else ops.push(audit('ReplyInterpreted', `${g.intent.replace(/_/g, ' ').toLowerCase()}: “${g.quote}” · for you to review; nothing changes`));
  }
  ops.push({ op: 'update', table: 'core', pk, sk: m.sk, set: { interpretation }, cond: { eq: { interpretation: null } } });
  await d.store.transact([...ops, finishOp(l, { kind: 'done' })]).catch(async (e) => { if (!(e instanceof TxCancelled)) throw e; await d.store.transact([finishOp(l, { kind: 'requeue', at: d.now() })]).catch(() => {}); });
}

/** S5-D7 mail blockers: inbound messages the channel has that this run hasn't taken in yet (a bill could be among them). */
export async function skipBlockers(d: Deps, runPk: string): Promise<{ blockers: { code: string; text: string; ref: string | null }[] }> {
  if (!d.mail) return { blockers: [] };
  const cur = await d.store.get('core', runPk, 'MAILCURSOR');
  if (!cur) return { blockers: [] };
  const page = await d.mail.channel.history(cur.historyId, 1).catch(() => null);
  if (!page) return { blockers: [{ code: 'MAIL_UNREADABLE', text: "Couldn't check the mailbox for new bills", ref: null }] };
  return { blockers: page.messages.length ? [{ code: 'MAIL_NOT_TAKEN_IN', text: 'New mail not read yet (it may hold a bill)', ref: null }] : [] };
}
