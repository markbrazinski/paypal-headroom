// Send is an executor effect (S5-D19, T11). Queue: gates + exact raw bytes frozen once (OUTMSG QUEUED, EFFECT#mail READY).
// Dispatch claim: authority consumed and frozen → SENDING → channel.send(stored raw) → get(id) shows it in SENT → SENT.
// A timeout is SEND_UNKNOWN, reconciled by Message-ID search; it is never resent under any key. Channel S5 = SIMULATED.
import { assertTransition, type EffectAuthority, type MailEffect, type OutboundMessage } from '@headroom/contracts';
import { createHash } from 'node:crypto';
import { K } from '../../adapters/store/keys.ts';
import { TxCancelled, type Item, type Op } from '../../adapters/store/port.ts';
import { MailNoResponse, MailRejected } from '../../adapters/mail/types.ts';
import { b64url, buildMessage } from '../../adapters/mail/rfc5322.ts';
import type { Deps } from '../../deps.ts';
import { finishOp, leaseCheck, newJob, putJobOp, type Lease } from '../../jobs/lease.ts';
import { auditOp } from '../audit/audit.ts';
import { addMs, businessDate, HOUR, MIN } from '../time.ts';
import { LeaseLost } from '../executor/invoice-issue.ts';
import { updateKey } from '../executor/invoice-update.ts';
import { actionCheck, authorityFor, planCtxFor, runFenceCheck } from '../plan/authority.ts';
import { addBusinessDays, windowOf, windowOpen, zonedInstant, type Window } from '../plan/dates.ts';
import { valueOf } from '../delegation/policy.ts';
import { grantCovers, loadPlanState, type ActItem, type PlanState } from '../plan/state.ts';

export type OutItem = OutboundMessage & Item;
export type MailItem = MailEffect & Item & { businessKey?: string };
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const tok = (s: string) => s.replace(/[^A-Za-z0-9-]/g, '-');
/** Our Message-ID comes from the root and intent, never the action id: a carried or rebuilt revision can't mint a second one. */
export const rfcMessageIdOf = (rootId: string, iv: number) => `<send.${tok(rootId)}.${iv}@headroom>`;
export const mailKeyOf = (rfc: string) => `mail:${rfc.slice(1, -1)}`;
export const isMailEffectKey = (key: string) => key.startsWith('mail:');
export const outSk = (rootId: string, iv: number) => `OUTMSG#${rootId}#${iv}`;
export const SIMULATED_LABEL = 'Sent · simulated mailbox · no real email left Headroom';
/** What a confirmed send is called, by channel (S5-D26: a Gmail send is real and says so). */
export const sentLabel = (channel: 'SIMULATED' | 'GMAIL') => (channel === 'GMAIL' ? 'Sent · Gmail · to your test inbox' : SIMULATED_LABEL);
export const TEST_SUBJECT = '[Headroom test] ';
const UNKNOWN_NEEDS_YOU_MS = 15 * MIN;

export { windowOpen } from '../plan/dates.ts';

const audit = (d: Deps, s: { tenantId: string; runId: string }, type: Parameters<typeof auditOp>[0]['type'], result: string, refs: Record<string, string>, allowedBy: string | null = null) =>
  auditOp({ tenantId: s.tenantId, runId: s.runId, type, by: 'HEADROOM', allowedBy, result, refs, correlationId: refs.effectKey ?? refs.actionId ?? 'mail', now: d.now() });
const allowedText = (a: EffectAuthority | null) => (!a ? null : a.kind === 'GRANT' ? `Your permission ${a.id}` : a.kind === 'OWNER' ? 'You' : `Delegation v${a.policyVersion}: ${a.winningRule}`);

async function finish(d: Deps, l: Lease | null, ops: Op[], f: Parameters<typeof finishOp>[1] = { kind: 'done' }) {
  try { await d.store.transact(l ? [...ops, finishOp(l, f)] : ops); }
  catch (e) { if (!(e instanceof TxCancelled)) throw e; if (l) await d.store.transact([finishOp(l, { kind: 'requeue', at: d.now(), error: 'Changed while queueing; re-checking' })]).catch(() => {}); }
}

/**
 * Queue stage (T11 1–2) for the action's message. COLLECT: the reminder itself (action SCHEDULED → QUEUED).
 * SLICE/OFFER: the message after the PayPal update; it needs that update VERIFIED_SUCCESS (`requiresEffect`).
 */
export async function queueMessage(d: Deps, l: Lease | null, s: PlanState, a: ActItem): Promise<void> {
  const r = { tenantId: s.ctx.tenantId, runId: s.ctx.run.runId };
  const tz = s.ctx.run.settings.timeZone;
  if (!d.mail) return finish(d, l, [audit(d, r, 'ActionDueSkipped', `${a.counterparty.name}: message not sent · no mail channel in this environment`, { actionId: a.actionId })], { kind: 'requeue', at: addMs(d.now(), HOUR), resetAttempts: true });
  if (!a.message) return finish(d, l, [audit(d, r, 'ActionDueSkipped', `${a.counterparty.name}: no message to send`, { actionId: a.actionId })]);
  const sk = outSk(a.rootId, a.intentVersion);
  const out = (await d.store.get('core', s.pk, sk)) as OutItem | undefined;
  if (out && out.state !== 'DRAFT') return finish(d, l, []); // already queued or sent: one message per intent, ever
  if (out?.held) return finish(d, l, []); // released by the owner re-runs this job
  const later = windowOpen(d.now(), tz, windowOf(s.policy));
  if (later) return finish(d, l, [], { kind: 'requeue', at: later, resetAttempts: true });
  // A reminder and a supplier ask are the message itself; the slice, disputed ask and offer send after their PayPal update.
  const direct = a.kind === 'COLLECT_OVERDUE' || a.kind === 'ASK_SUPPLIER';
  if (!direct) {
    const kind = a.kind === 'COLLECT_UNDISPUTED_SLICE' || a.kind === 'COLLECT_DISPUTED' ? 'ENABLE_PARTIAL' : 'APPLY_DISCOUNT';
    const upd = await d.store.get('work', K.effect(updateKey(a.rootId, a.intentVersion, kind)), 'EFFECT');
    if (upd?.state !== 'VERIFIED_SUCCESS') return finish(d, l, [audit(d, r, 'ActionDueSkipped', `${a.counterparty.name}: message waits for the PayPal update to be verified`, { actionId: a.actionId })]);
  }
  // S7 R6: a supplier ask goes to the supplier's contact (test redirect applies exactly as for customers).
  const sup = a.counterparty.kind === 'SUPPLIER' ? s.f.r.suppliers.find((x) => x.supplierId === a.counterparty.id) : undefined;
  const cust = sup ? { customerId: sup.supplierId, displayName: sup.displayName, billingEmail: sup.contactEmail ?? '' } : s.customers.find((c) => c.customerId === a.counterparty.id);
  const { res, conds } = await authorityFor(s, a, 'QUEUE', 'MESSAGE');
  const holdOps = (text: string, code: string): Op[] => [
    ...(direct && a.state === 'SCHEDULED' ? [{ op: 'update' as const, table: 'core' as const, pk: a.pk, sk: a.sk, set: { state: 'HELD', holdCode: code, heldReasons: [text], version: a.version + 1 }, cond: { eq: { version: a.version, state: a.state } } }] : []),
    audit(d, r, 'MessageHeld', `${a.counterparty.name}: message not sent · ${text}`, { actionId: a.actionId }),
  ];
  if (!res.ok) return finish(d, l, holdOps(res.text, res.code));
  if (!cust?.billingEmail) return finish(d, l, holdOps(`No known contact for this ${sup ? 'supplier' : 'customer'}`, 'NOT_AUTHORIZED'));
  if (d.mail.channel.kind === 'GMAIL' && !d.mail.redirectTo) return finish(d, l, holdOps("Test delivery isn't set up here (no private test inbox configured)", 'NOT_AUTHORIZED'));
  const rfc = rfcMessageIdOf(a.rootId, a.intentVersion);
  const effectKey = mailKeyOf(rfc);
  // TEST_REDIRECT (S5-D26): the message goes to the owner's private test inbox only; the customer is named, never contacted.
  const redirect = d.mail.redirectTo;
  const name = a.counterparty.name;
  const subject = redirect ? `${TEST_SUBJECT}${a.message.subject}` : a.message.subject;
  const text = redirect ? `Test delivery from Headroom. Prepared for ${name} (${cust.billingEmail}); ${name} has not been contacted.\n\n${a.message.body}` : a.message.body;
  const raw = buildMessage({ from: d.mail.address, to: [redirect ?? cust.billingEmail], subject, text, messageId: rfc, inReplyTo: null, date: d.now() });
  const rawB64 = b64url.encode(raw);
  const now = d.now();
  const msg: OutItem = {
    pk: s.pk, sk, rootId: a.rootId, intentVersion: a.intentVersion, actionId: a.actionId, customerId: a.counterparty.id, counterpartyRole: sup ? 'SUPPLIER' : 'CUSTOMER', state: 'QUEUED', held: false, version: (out?.version ?? 0) + 1,
    rfcMessageId: rfc, effectKey, subject, to: redirect ?? cust.billingEmail, preparedFor: redirect ? cust.billingEmail : null, rawB64, rawSha256: sha(raw), channel: d.mail.channel.kind, sentMessageId: null, threadId: null, reason: null, updatedAt: now,
  };
  const eff: MailItem = { pk: K.effect(effectKey), sk: 'EFFECT', effectKey, tenantId: r.tenantId, runId: r.runId, epoch: s.ctx.run.epoch, actionId: a.actionId, rootId: a.rootId, intentVersion: a.intentVersion, state: 'READY', version: 1, authority: null, unknownSince: null, failure: null, updatedAt: now };
  const ops: Op[] = [
    ...conds,
    out ? { op: 'put', table: 'core', item: msg, cond: { eq: { version: out.version, state: 'DRAFT', held: false } } } : { op: 'put', table: 'core', item: msg, cond: { notExists: true } },
    ...(await effectAndJob(d, eff, now)),
    direct ? (assertTransition('Action', a.state, 'QUEUED'), { op: 'update', table: 'core', pk: a.pk, sk: a.sk, set: { state: 'QUEUED', holdCode: null, heldReasons: [`Queued · ${d.mail.channel.kind === 'GMAIL' ? 'Gmail' : 'simulated mailbox'}`], version: a.version + 1 }, cond: { eq: { version: a.version, state: a.state } } }) : actionCheck(a),
    audit(d, r, 'MessageQueued', `${name}: message queued ${redirect ? `for your private test inbox (prepared for ${cust.billingEmail}, who is not contacted)` : `to ${cust.billingEmail}`} · ${d.mail.channel.kind === 'GMAIL' ? 'Gmail' : 'simulated mailbox'}`, { actionId: a.actionId, effectKey }),
  ];
  await finish(d, l, ops);
  await d.queue.send(`exec#${effectKey}`).catch(() => {});
}

/** The READY effect and its job: created once; a re-queue after a hold reuses both (same key, nothing was sent). */
async function effectAndJob(d: Deps, eff: MailItem, now: string): Promise<Op[]> {
  const cur = (await d.store.get('work', eff.pk, 'EFFECT')) as MailItem | undefined;
  const jobId = `exec#${eff.effectKey}`;
  const job = await d.store.get('work', K.job(jobId), 'JOB');
  return [
    cur ? { op: 'check', table: 'work', pk: eff.pk, sk: 'EFFECT', cond: { eq: { state: 'READY', version: cur.version } } } : { op: 'put', table: 'work', item: eff, cond: { notExists: true } },
    job ? { op: 'update', table: 'work', pk: K.job(jobId), sk: 'JOB', set: { state: 'QUEUED', dueAt: now, dueKey: `${now}#${jobId}`, gsiDue: 'DUE' }, cond: { eq: { leaseToken: job.leaseToken, state: job.state } } }
      : putJobOp(newJob(jobId, 'EXECUTE_EFFECT', eff.effectKey, now, eff.tenantId, eff.runId)),
  ];
}

async function loadMail(d: Deps, key: string) {
  const e = (await d.store.get('work', K.effect(key), 'EFFECT')) as MailItem | undefined;
  if (!e) throw new Error(`mail effect ${key} missing`);
  const pk = K.run(e.tenantId, e.runId);
  const out = (await d.store.get('core', pk, outSk(e.rootId, e.intentVersion))) as OutItem;
  const a = (await d.store.get('core', pk, `ACT#${e.actionId}`)) as ActItem | undefined;
  return { e, out, a, pk };
}

async function tx(d: Deps, l: Lease, ops: Op[], f?: Parameters<typeof finishOp>[1]) {
  try { await d.store.transact([...ops, f ? finishOp(l, f) : leaseCheck(l)]); }
  catch (err) { if (err instanceof TxCancelled) throw new LeaseLost('mail step refused'); throw err; }
}
const effTo = (e: MailItem, to: MailEffect['state'], set: Record<string, unknown> = {}): Op => { assertTransition('MailEffect', e.state, to); return { op: 'update', table: 'work', pk: e.pk, sk: 'EFFECT', set: { state: to, updatedAt: new Date().toISOString(), ...set }, add: { version: 1 }, cond: { eq: { state: e.state, version: e.version } } }; };
const outTo = (o: OutItem, to: OutboundMessage['state'], set: Record<string, unknown> = {}): Op => { assertTransition('OutMsg', o.state, to); return { op: 'update', table: 'core', pk: o.pk, sk: o.sk, set: { state: to, ...set }, add: { version: 1 }, cond: { eq: { state: o.state, version: o.version } } }; };
const actOp = (a: ActItem | undefined, to: ActItem['state'], set: Record<string, unknown>): Op[] => {
  if (!a || (a.kind !== 'COLLECT_OVERDUE' && a.kind !== 'ASK_SUPPLIER') || a.state === to) return [];
  assertTransition('Action', a.state, to);
  return [{ op: 'update', table: 'core', pk: a.pk, sk: a.sk, set: { state: to, ...set, version: a.version + 1 }, cond: { eq: { version: a.version } } }];
};

/** EXECUTE_EFFECT / RECONCILE_EFFECT for a `mail:` key. */
export async function executeMail(d: Deps, l: Lease): Promise<void> {
  const { e, out, a, pk } = await loadMail(d, l.job.ref);
  const r = { tenantId: e.tenantId, runId: e.runId };
  const refs = { effectKey: e.effectKey, actionId: e.actionId };
  if (e.state === 'VERIFIED_SUCCESS' || e.state === 'VERIFIED_FAILURE') return tx(d, l, [], { kind: 'done' });
  if (!d.mail) return tx(d, l, [], { kind: 'requeue', at: addMs(d.now(), HOUR), error: 'No mail channel here' });
  if (e.state === 'UNKNOWN' || e.state === 'DISPATCHED') return reconcileMail(d, l, e, out, a);
  // S5-R20: never dispatched and its run was reset → it ends here, unsent.
  const fence = await d.store.get('core', K.tenant(e.tenantId), 'RUN_FENCE');
  if (fence?.epoch !== e.epoch) return tx(d, l, [effTo(e, 'VERIFIED_FAILURE', { failure: 'Run was reset before sending' }), ...(out.state === 'QUEUED' ? [outTo(out, 'NOT_SENT', { reason: 'The run was reset before sending' })] : [])], { kind: 'done' });
  // READY: dispatch claim. Held (or back to draft) before this point → nothing is sent; release re-queues the same effect.
  if (out.state === 'NOT_SENT') return tx(d, l, [effTo(e, 'VERIFIED_FAILURE', { failure: 'Released unsent' })], { kind: 'done' });
  if (out.held || out.state !== 'QUEUED') return tx(d, l, [], { kind: 'done' });
  // Fallback (S5-D26): a channel that can't send now (7-day test sign-in expired, not connected) leaves it waiting, never faked.
  const rd = await d.mail.channel.ready();
  if (!rd.ok) {
    const reason = `Not sent · ${rd.reason}`;
    return tx(d, l, [{ op: 'update', table: 'core', pk, sk: out.sk, set: { reason }, cond: { eq: { state: 'QUEUED' } } }, ...(out.reason === reason ? [] : [audit(d, r, 'MessageHeld', `${a?.counterparty.name ?? 'Customer'}: ${reason}; it goes with the same Message-ID once reconnected`, refs)])],
      { kind: 'requeue', at: addMs(d.now(), 15 * MIN), error: reason, resetAttempts: true });
  }
  const rc = await planCtxFor(d, e.tenantId, e.runId);
  if (!rc || !a) return tx(d, l, [effTo(e, 'VERIFIED_FAILURE', { failure: 'Run or action gone' }), outTo(out, 'NOT_SENT', { reason: 'Run or action gone' })], { kind: 'done' });
  const s = await loadPlanState(rc);
  // S7a-IR-04: the owner's window holds at the send itself (a message that waited on the channel or a slot doesn't go at night).
  const opens = windowOpen(d.now(), s.ctx.run.settings.timeZone, windowOf(s.policy));
  if (opens) return tx(d, l, [{ op: 'update', table: 'core', pk, sk: out.sk, set: { reason: 'Waiting · outside your contact window; sends when it opens' }, cond: { eq: { state: 'QUEUED' } } }], { kind: 'requeue', at: opens, error: 'Outside the contact window', resetAttempts: true });
  const { res, conds } = await authorityFor(s, a, 'DISPATCH', 'MESSAGE');
  if (!res.ok) {
    // Back to a draft (effect stays READY): the owner's release, resume or hand back re-queues it with the same Message-ID.
    return tx(d, l, [outTo(out, 'DRAFT', { reason: res.text }),
      ...actOp(a, 'HELD', { holdCode: res.code, heldReasons: [res.text] }), audit(d, r, 'MessageHeld', `${a.counterparty.name}: not sent · ${res.text}`, refs)], { kind: 'done' });
  }
  const bk = businessOf(s, a.counterparty.id);
  const slotNow = (await d.store.get('core', pk, contactSk(bk))) as (Slot & Item) | undefined;
  // UX repair (S7-UX1): the owner's one-time CONTACT_SPACING approval for this reminder lets it through the spacing rule once.
  const spacing = s.grants.find((g) => g.kind === 'CONTACT_SPACING' && grantCovers(g, a, d.now()));
  const slot = slotClaim(s, bk, a.counterparty.kind === 'SUPPLIER' ? 'PAYABLES' : 'RECEIVABLES', a.counterparty.id, e.effectKey, slotNow, d.now(), !!spacing);
  if (!slot.ok) {
    const reason = `Waiting · ${slot.text}`;
    return tx(d, l, [{ op: 'update', table: 'core', pk, sk: out.sk, set: { reason }, cond: { eq: { state: 'QUEUED' } } }, ...(out.reason === reason ? [] : [audit(d, r, 'MessageHeld', `${a.counterparty.name}: not sent yet · ${slot.text}`, refs)])],
      { kind: 'requeue', at: slot.until, error: reason, resetAttempts: true });
  }
  const consume: Op[] = res.grant ? [{ op: 'update', table: 'core', pk, sk: `GRANT#${res.grant.grantId}`, set: { state: 'CONSUMED', consumedBy: e.effectKey }, cond: { eq: { state: 'ACTIVE', termsHash: res.grant.termsHash } } }, audit(d, r, 'GrantConsumed', `Permission ${res.grant.grantId} used by this message`, refs)] : [];
  const spacingUsed: Op[] = slot.early && spacing ? [{ op: 'update', table: 'core', pk, sk: `GRANT#${spacing.grantId}`, set: { state: 'CONSUMED', consumedBy: e.effectKey }, cond: { eq: { state: 'ACTIVE', termsHash: spacing.termsHash } } },
    audit(d, r, 'GrantConsumed', `${a.counterparty.name}: your one-time permission to contact before the spacing rule allows was used by this reminder; it is never used again`, { ...refs, grantId: spacing.grantId })] : [];
  try {
    await tx(d, l, [runFenceCheck(e.tenantId, e.epoch), ...conds, actionCheck(a), ...consume, ...spacingUsed, slot.op, effTo(e, 'DISPATCHED', { authority: res.authority, businessKey: bk }), outTo(out, 'SENDING')]);
  } catch (err) {
    if (err instanceof LeaseLost) { await d.store.transact([finishOp(l, { kind: 'requeue', at: d.now(), error: 'Send claim refused: something changed; re-checking' })]).catch(() => {}); return; }
    throw err;
  }
  Object.assign(e, { state: 'DISPATCHED', version: e.version + 1, authority: res.authority, businessKey: bk });
  Object.assign(out, { state: 'SENDING', version: out.version + 1 });
  let sent: { messageId: string; threadId: string } | null = null;
  try { sent = await d.mail.channel.send(out.rawB64!); }
  catch (err) {
    if (err instanceof MailRejected) return tx(d, l, [effTo(e, 'VERIFIED_FAILURE', { failure: err.message }), slotRelease(pk, bk, e.effectKey, null), outTo(out, 'FAILED', { reason: err.message }), ...actOp(await fresh(d, a), 'FAILED', { heldReasons: [`The mail channel refused it: ${err.message}`] }), audit(d, r, 'MessageFailed', `${a.counterparty.name}: the mail channel refused the message (${err.message})`, refs, allowedText(res.authority))], { kind: 'done' });
    if (!(err instanceof MailNoResponse)) throw err;
  }
  if (sent) {
    const got = await d.mail.channel.get(sent.messageId).catch(() => null);
    if (got?.labelIds.includes('SENT')) return succeedMail(d, l, e, out, await fresh(d, a), got.messageId, got.threadId);
  }
  return tx(d, l, [effTo(e, 'UNKNOWN', { unknownSince: d.now() }), outTo(out, 'SEND_UNKNOWN', { reason: 'Checking the mailbox; won’t resend' }), ...actOp(await fresh(d, a), 'UNCERTAIN', { heldReasons: ['Delivery unknown · checking the mailbox; won’t resend'] }),
    audit(d, r, 'MessageSendUnknown', `${a.counterparty.name}: the mailbox didn't confirm the send; checking by Message-ID, never resending`, refs)], { kind: 'requeue', at: addMs(d.now(), MIN), type: 'RECONCILE_EFFECT', error: 'Send unconfirmed', unknownSince: d.now() });
}
// ---------- contact spacing (S7 R9, Delegation comms.contactEveryBd): one slot per business, taken at the dispatch claim ----------
export const contactSk = (businessKey: string) => `CONTACT#${businessKey}`;
interface Slot { lastSentAt: string | null; pendingEffect: string | null; version: number }
/** The window opening `n` business days after the business date of the last send (a Friday send with n = 1 → Monday's opening). */
export const nextEligible = (lastSentAt: string, n: number, tz: string, w: Window) => zonedInstant(addBusinessDays(businessDate(lastSentAt, tz), n), w.open, tz);
export function slotClaim(s: PlanState, businessKey: string, area: 'RECEIVABLES' | 'PAYABLES', counterpartyId: string, effectKey: string, slot: (Slot & Item) | undefined, now: string, approvedEarly = false): { ok: true; op: Op; early: boolean } | { ok: false; until: string; text: string } {
  const n = valueOf<number>(s.policy, 'comms.contactEveryBd', area, counterpartyId);
  const tz = s.ctx.run.settings.timeZone;
  const dayText = (t: string) => new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(t));
  if (slot?.pendingEffect && slot.pendingEffect !== effectKey) return { ok: false, until: addMs(now, 15 * MIN), text: 'Another message to this business is still being sent or checked' };
  let early = false;
  if (slot?.lastSentAt) {
    const until = nextEligible(slot.lastSentAt, n, tz, windowOf(s.policy));
    if (until > now && !approvedEarly) return { ok: false, until, text: `Last contacted ${dayText(slot.lastSentAt)}; your limit is every ${n} business day${n === 1 ? '' : 's'}, so next allowed ${dayText(until)}` };
    early = until > now;
  }
  const sk = contactSk(businessKey);
  return { ok: true, early, op: slot ? { op: 'update', table: 'core', pk: s.pk, sk, set: { pendingEffect: effectKey }, add: { version: 1 }, cond: { eq: { version: slot.version } } }
    : { op: 'put', table: 'core', item: { pk: s.pk, sk, lastSentAt: null, pendingEffect: effectKey, version: 1 }, cond: { notExists: true } } };
}
/** SENT → the slot records the send; a definitive not-sent only frees it. UNKNOWN keeps it (no other send to that business). */
const slotRelease = (pk: string, businessKey: string, effectKey: string, sentAt: string | null): Op =>
  ({ op: 'update', table: 'core', pk, sk: contactSk(businessKey), set: { pendingEffect: null, ...(sentAt ? { lastSentAt: sentAt } : {}) }, add: { version: 1 }, cond: { eq: { pendingEffect: effectKey } } });
const businessOf = (s: PlanState, id: string) => s.customers.find((c) => c.customerId === id)?.businessKey ?? s.f.r.suppliers.find((x) => x.supplierId === id)?.businessKey ?? id;

const fresh = async (d: Deps, a: ActItem) => (await d.store.get('core', a.pk, a.sk)) as ActItem | undefined;

async function reconcileMail(d: Deps, l: Lease, e: MailItem, out: OutItem, a: ActItem | undefined) {
  const hits = await d.mail!.channel.search(`rfc822msgid:${out.rfcMessageId.slice(1, -1)}`).catch(() => null);
  const hit = hits?.[0];
  const got = hit ? await d.mail!.channel.get(hit.messageId).catch(() => null) : null;
  if (got?.labelIds.includes('SENT')) {
    if (e.state === 'DISPATCHED') { await tx(d, l, [effTo(e, 'UNKNOWN', { unknownSince: d.now() }), outTo(out, 'SEND_UNKNOWN')]); Object.assign(e, { state: 'UNKNOWN', version: e.version + 1 }); Object.assign(out, { state: 'SEND_UNKNOWN', version: out.version + 1 }); }
    return succeedMail(d, l, e, out, a && (await fresh(d, a)), got.messageId, got.threadId);
  }
  if (e.state === 'DISPATCHED') {
    // Worker died between claim and send: the outcome is unknown, so the same rule applies — search, never resend.
    await tx(d, l, [effTo(e, 'UNKNOWN', { unknownSince: d.now() }), outTo(out, 'SEND_UNKNOWN', { reason: 'Checking the mailbox; won’t resend' }), ...actOp(a && (await fresh(d, a)), 'UNCERTAIN', { heldReasons: ['Delivery unknown · checking the mailbox; won’t resend'] })]);
    return void (await d.store.transact([finishOp(l, { kind: 'requeue', at: addMs(d.now(), MIN), error: 'Send unconfirmed' })]).catch(() => {}));
  }
  const long = Date.parse(d.now()) - Date.parse(e.unknownSince ?? d.now()) > UNKNOWN_NEEDS_YOU_MS;
  return tx(d, l, [{ op: 'update', table: 'core', pk: out.pk, sk: out.sk, set: { reason: long ? 'Delivery unknown · Needs you · Headroom will not resend' : 'Checking the mailbox; won’t resend' }, cond: { eq: { state: 'SEND_UNKNOWN' } } }],
    { kind: 'requeue', at: addMs(d.now(), long ? HOUR : MIN), error: long ? 'Delivery unknown; needs you' : 'Not found yet' });
}

async function succeedMail(d: Deps, l: Lease, e: MailItem, out: OutItem, a: ActItem | undefined, messageId: string, threadId: string) {
  const r = { tenantId: e.tenantId, runId: e.runId };
  const ops: Op[] = [
    effTo(e, 'VERIFIED_SUCCESS'), outTo(out, 'SENT', { sentMessageId: messageId, threadId, reason: null, updatedAt: d.now() }),
    // Pre-S7 effects dispatched without a slot have no businessKey; nothing to release.
    ...(e.businessKey ? [slotRelease(out.pk, e.businessKey, e.effectKey, d.now())] : []),
    ...actOp(a, 'APPLIED', { heldReasons: [`${sentLabel(out.channel)} · ${a?.kind === 'ASK_SUPPLIER' ? 'awaiting their answer' : 'awaiting payment'}`] }),
    audit(d, r, 'MessageSent', `${a?.counterparty.name ?? 'Customer'}: ${sentLabel(out.channel)} (${out.preparedFor ? `your test inbox; prepared for ${out.preparedFor}, not contacted` : `to ${out.to}`}; ${out.channel} message ${messageId})`, { effectKey: e.effectKey, actionId: e.actionId }, allowedText(e.authority)),
  ];
  // The sent reminder may already be paid: progress runs again now (S5-D13).
  const inv = a?.subject.invoiceId;
  if (inv) ops.push(putJobOp(newJob(`progress#${inv}#mail#${e.effectKey}`, 'PLAN_PROGRESS', inv, d.now(), e.tenantId, e.runId)));
  return tx(d, l, ops, { kind: 'done' });
}

/** S5-D13: a message never dispatched is released when the invoice is paid first. */
export async function releaseUnsentMail(d: Deps, a: ActItem): Promise<Op[]> {
  const out = (await d.store.get('core', a.pk, outSk(a.rootId, a.intentVersion))) as OutItem | undefined;
  if (!out || (out.state !== 'DRAFT' && out.state !== 'QUEUED')) return [];
  const e = (await d.store.get('work', K.effect(out.effectKey), 'EFFECT')) as MailItem | undefined;
  return [
    outTo(out, 'NOT_SENT', { reason: 'Not sent: paid first' }),
    ...(e && e.state === 'READY' ? [effTo(e, 'VERIFIED_FAILURE', { failure: 'Released unsent: paid first' })] : []),
  ];
}
