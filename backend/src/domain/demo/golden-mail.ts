// EXPERIMENTAL golden run, real email (owner, 3 Nov 2026): while the operator films `?demo=1`, Headroom's two asks go out as real
// Gmail messages from the connected test inbox to the test inbox. The fictional customer is never contacted; the message says so.
// Operator-only route (demo lane) → FIXTUREMAIL job (ref GOLDEN#<id>) → the worker sends; the demo shows "real email" only after Gmail
// confirms each send. At most 20 messages per tenant per day. Roll back with the golden run (see web/src/api/golden.ts).
import { K } from '../../adapters/store/keys.ts';
import { TxCancelled } from '../../adapters/store/port.ts';
import { b64url, buildMessage } from '../../adapters/mail/rfc5322.ts';
import type { Deps } from '../../deps.ts';
import { finishOp, newJob, putJobOp, type Lease as JobLease } from '../../jobs/lease.ts';
import { auditOp } from '../audit/audit.ts';
import { addMs, MIN } from '../time.ts';

export const GOLDEN_DAILY_LIMIT = 20;
export interface GoldenMessage { preparedFor: string; subject: string; text: string }
const sk = (id: string) => `GOLDENMAIL#${id}`;

/** Queue one send of these messages; refused past the daily limit or with nowhere safe to send. */
export async function requestGoldenMail(d: Deps, tenantId: string, messages: GoldenMessage[]): Promise<{ id: string } | { refused: string }> {
  // The worker holds the Gmail connection and reports "not connected" if it isn't; this lane only queues.
  const id = `${Date.parse(d.now())}-${crypto.randomUUID().slice(0, 8)}`;
  const day = d.now().slice(0, 10);
  const pk = K.tenant(tenantId);
  const count = await d.store.get('core', pk, `GOLDENMAIL#DAY#${day}`);
  const used = Number(count?.n ?? 0);
  if (used + messages.length > GOLDEN_DAILY_LIMIT) return { refused: `Daily limit of ${GOLDEN_DAILY_LIMIT} sample emails reached` };
  try {
    await d.store.transact([
      count ? { op: 'update', table: 'core', pk, sk: `GOLDENMAIL#DAY#${day}`, set: { n: used + messages.length }, cond: { eq: { n: used } } }
        : { op: 'put', table: 'core', item: { pk, sk: `GOLDENMAIL#DAY#${day}`, n: messages.length }, cond: { notExists: true } },
      { op: 'put', table: 'core', item: { pk, sk: sk(id), id, state: 'QUEUED', messages, sent: [], at: d.now() }, cond: { notExists: true } },
      putJobOp(newJob(`golden#${id}`, 'FIXTUREMAIL', `GOLDEN#${id}`, d.now(), tenantId, 'golden')),
    ]);
  } catch (e) { if (e instanceof TxCancelled) return { refused: 'Another sample send was counted at the same moment; try again' }; throw e; }
  await d.queue.send(`golden#${id}`).catch(() => {});
  return { id };
}

export async function goldenMailStatus(d: Pick<Deps, 'store'>, tenantId: string, id: string) {
  const r = await d.store.get('core', K.tenant(tenantId), sk(id));
  return r ? { id, state: r.state as string, sent: (r.sent ?? []) as { subject: string; messageId: string }[], reason: (r.reason as string) ?? null } : null;
}

/** Worker: send each message once (claimed before the send); a channel that isn't ready retries for a few minutes, then gives up. */
export async function runGoldenMail(d: Deps, l: JobLease): Promise<void> {
  const tenantId = l.job.tenantId!, id = String(l.job.ref).slice('GOLDEN#'.length), pk = K.tenant(tenantId);
  const r = await d.store.get('core', pk, sk(id));
  const done = (set: Record<string, unknown>) => d.store.transact([{ op: 'update', table: 'core', pk, sk: sk(id), set }, finishOp(l, { kind: 'done' })]);
  if (!r || r.state === 'SENT' || r.state === 'FAILED') return void (await d.store.transact([finishOp(l, { kind: 'done' })]).catch(() => {}));
  if (!d.mail) return void (await done({ state: 'FAILED', reason: 'Gmail isn’t connected on this stage' }));
  const ready = await d.mail.channel.ready();
  if (!ready.ok) {
    if (Date.parse(d.now()) - Date.parse(r.at) > 5 * MIN) return void (await done({ state: 'FAILED', reason: ready.reason }));
    return void (await d.store.transact([finishOp(l, { kind: 'requeue', at: addMs(d.now(), 20_000), error: ready.reason })]).catch(() => {}));
  }
  const to = d.mail.redirectTo ?? d.mail.address;
  const sent = [...(r.sent ?? [])] as { subject: string; messageId: string }[];
  for (const [i, m] of (r.messages as GoldenMessage[]).entries()) {
    if (i < sent.length) continue; // sent before a crash: never twice
    const text = `${m.text}\n\n--\nSent by Headroom's recorded walkthrough to your test inbox. Prepared for ${m.preparedFor}; that customer is fictional and was not contacted.`;
    const raw = buildMessage({ from: d.mail.address, to: [to], subject: m.subject, text, messageId: `<golden.${id}.${i}@demo.headroom.test>`, date: d.now() });
    const g = await d.mail.channel.send(b64url.encode(raw));
    sent.push({ subject: m.subject, messageId: g.messageId });
    await d.store.transact([{ op: 'update', table: 'core', pk, sk: sk(id), set: { sent, state: 'SENDING' } }]);
  }
  await d.store.transact([
    { op: 'update', table: 'core', pk, sk: sk(id), set: { state: 'SENT', sent } },
    auditOp({ tenantId, runId: 'golden', type: 'FixtureMailSent', by: 'OPERATOR', allowedBy: 'Recorded walkthrough (operator)', result: `${sent.length} sample email${sent.length === 1 ? '' : 's'} sent through Gmail to the test inbox; no customer contacted`, refs: { id }, correlationId: `golden:${id}`, now: d.now() }),
    finishOp(l, { kind: 'done' }),
  ]);
}
