// FIXTUREMAIL {KELLER_REPLY} (S07 §6.18, origin DEMO_SCRIPT): in the sandbox demo, Keller's answer to Headroom's ask is sent from the
// connected test inbox as a real reply in the ask's thread, so it comes back through normal mail intake (sender gate, routing, Nova
// reading, owner accept). It proposes exactly the SPLIT option Headroom offered. Sent at most once per run (FIXTURE# claim before send).
import { K } from '../../adapters/store/keys.ts';
import { TxCancelled } from '../../adapters/store/port.ts';
import { b64url, buildMessage } from '../../adapters/mail/rfc5322.ts';
import type { Deps } from '../../deps.ts';
import { finishOp, newJob, putJobOp, requestRun, type JobItem, type Lease as JobLease } from '../../jobs/lease.ts';
import { mailSyncJobId } from '../comms/inbound.ts';
import { auditOp } from '../audit/audit.ts';
import { addMs, MIN } from '../time.ts';

export const fixtureJobId = (runId: string) => `fixture#keller#${runId}`;
const dollars = (m: number) => `$${(m / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const day = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });

/** The ask this reply answers: Headroom's sent message to Keller in the run, with the SPLIT option it offered. */
export async function kellerAsk(d: Pick<Deps, 'store'>, tenantId: string, runId: string) {
  const pk = K.run(tenantId, runId);
  const outs = (await d.store.query('core', pk, { skPrefix: 'OUTMSG#' })).filter((o) => o.counterpartyRole === 'SUPPLIER' && o.state === 'SENT');
  for (const o of outs) {
    const a = await d.store.get('core', pk, `ACT#${o.actionId}`);
    const split = (a?.terms?.askOptions as { code: string; parts: { dueOn: string; amount: { minor: number } }[] }[] | undefined)?.find((x) => x.code === 'SPLIT');
    if (a?.kind === 'ASK_SUPPLIER' && split) return { out: o, split };
  }
  return null;
}

export async function requestKellerReply(d: Deps, tenantId: string, runId: string): Promise<boolean> {
  if (!(await kellerAsk(d, tenantId, runId))) return false;
  const jobId = fixtureJobId(runId);
  try { await d.store.transact([putJobOp(newJob(jobId, 'FIXTUREMAIL', 'KELLER_REPLY', d.now(), tenantId, runId))]); }
  catch (e) { if (!(e instanceof TxCancelled)) throw e; return true; } // already asked for
  await d.queue.send(jobId).catch(() => {});
  return true;
}

export async function runFixtureMail(d: Deps, l: JobLease): Promise<void> {
  const [tenantId, runId] = [l.job.tenantId!, l.job.runId!];
  const pk = K.run(tenantId, runId);
  const ask = await kellerAsk(d, tenantId, runId);
  if (!ask || !d.mail) return void (await d.store.transact([finishOp(l, { kind: 'done' })]).catch(() => {}));
  const ready = await d.mail.channel.ready();
  if (!ready.ok) return void (await d.store.transact([finishOp(l, { kind: 'requeue', at: addMs(d.now(), MIN), error: ready.reason })]).catch(() => {}));
  const now = d.now();
  // Once per run: the claim is written before the send; a crash after it never sends a second reply.
  try { await d.store.transact([{ op: 'put', table: 'core', item: { pk, sk: 'FIXTURE#KELLER_REPLY', state: 'SENDING', at: now, origin: 'DEMO_SCRIPT' }, cond: { notExists: true } }]); }
  catch (e) { if (e instanceof TxCancelled) return void (await d.store.transact([finishOp(l, { kind: 'done' })]).catch(() => {})); throw e; }
  const [p1, p2] = ask.split.parts;
  const text = `Hi,\n\nThanks for checking with us. Yes, we can split K-2207: ${dollars(p1.amount.minor)} on ${day(p1.dueOn)}${p2 ? ` and the remaining ${dollars(p2.amount.minor)} on ${day(p2.dueOn)}` : ''}. That works for us.\n\nBest,\nKeller Drafting Co.\n\n(sandbox demo reply sent from the test inbox)`;
  const raw = buildMessage({ from: d.mail.address, to: [d.mail.address], subject: `Re: ${ask.out.subject}`, text, messageId: `<fixture.keller.${runId}.${Date.parse(now)}@demo.headroom.test>`, inReplyTo: ask.out.rfcMessageId, references: [ask.out.rfcMessageId], date: now });
  const sent = await d.mail.channel.send(b64url.encode(raw));
  await d.store.transact([
    { op: 'update', table: 'core', pk, sk: 'FIXTURE#KELLER_REPLY', set: { state: 'SENT', messageId: sent.messageId } },
    auditOp({ tenantId, runId, type: 'FixtureMailSent', by: 'OPERATOR', allowedBy: 'Sandbox (test-inbox reply)', result: `Keller's reply (agreeing to the split) sent from the test inbox; it arrives through normal mail intake`, refs: { messageId: sent.messageId }, correlationId: `fixture:${runId}`, now }),
    finishOp(l, { kind: 'done' }),
  ]);
  // Pull the inbox read forward so the reply shows up now, not at the next minute.
  const mj = await d.store.get('work', K.job(mailSyncJobId(runId)), 'JOB');
  if (mj) { await requestRun(d.store, mj as JobItem, addMs(d.now(), 5_000)); await d.queue.send(mailSyncJobId(runId)).catch(() => {}); }
}
