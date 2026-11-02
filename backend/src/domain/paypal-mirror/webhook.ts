// Webhooks are hints (S01 T4): store raw + job in one TX, verify the signature, then GET the resource.
import { createHash } from 'node:crypto';
import { PpInvoicePaidEvent, WEBHOOK_HEADERS } from '@headroom/contracts';
import { K } from '../../adapters/store/keys.ts';
import { TxCancelled, type Op, type Store } from '../../adapters/store/port.ts';
import type { Queue } from '../../adapters/queue/port.ts';
import type { Deps, Hooks } from '../../deps.ts';
import { auditOp } from '../audit/audit.ts';
import { finishOp, newJob, putJobOp, type Lease } from '../../jobs/lease.ts';
import { activeRun } from '../identity-run/run.ts';
import { reconcileInvoice } from './reconcile-invoice.ts';

export type IngressResult = { status: 200 | 500; eventId: string; duplicate: boolean };

/** Ingress: no secrets, no PayPal calls. 200 once the raw event and its job are durable; 500 makes PayPal retry. */
export async function ingestWebhook(store: Store, queue: Queue, raw: string, headers: Record<string, string | undefined>, now: string, hooks?: Hooks): Promise<IngressResult> {
  const sha = createHash('sha256').update(raw).digest('hex');
  let eventId: string | null = null;
  try { const p = JSON.parse(raw); if (typeof p?.id === 'string' && p.id) eventId = p.id; } catch { /* quarantined below */ }
  const id = eventId ?? `sha256-${sha}`;
  const jobId = `whv#${id}`;
  const kept = Object.fromEntries(WEBHOOK_HEADERS.map((h) => [h, headers[h] ?? null]));
  const ops: Op[] = [{
    op: 'put', table: 'provider', cond: { notExists: true },
    item: { pk: K.webhook(id), sk: 'EVENT', eventId: id, raw, headers: kept, sha256: sha, receivedAt: now, state: eventId ? 'RECEIVED' : 'QUARANTINED', reason: eventId ? null : 'BAD_ENVELOPE' },
  }];
  if (eventId) ops.push(putJobOp(newJob(jobId, 'VERIFY_WEBHOOK', id, now, null, null)));
  try {
    await store.transact(ops);
  } catch (e) {
    if (!(e instanceof TxCancelled)) return { status: 500, eventId: id, duplicate: false };
    if (!e.failed[0]) return { status: 500, eventId: id, duplicate: false };
    const j = await store.get('work', K.job(jobId), 'JOB');
    if (j && j.state !== 'DONE' && j.state !== 'DEAD') await queue.send(jobId).catch(() => {});
    return { status: 200, eventId: id, duplicate: true };
  }
  await hooks?.afterWebhookCommit?.();
  if (eventId) await queue.send(jobId).catch(() => {}); // the sweep's due scan is the backstop
  return { status: 200, eventId: id, duplicate: false };
}

/** Rejects deliveries that cannot be genuine PayPal ones without calling PayPal. */
export function prefilter(h: Record<string, string>, receivedAt: string): string | null {
  if (h['paypal-auth-algo'] !== 'SHA256withRSA') return 'BAD_SIGNATURE (unexpected auth algo)';
  let host = '';
  try { const u = new URL(h['paypal-cert-url']); host = u.protocol === 'https:' ? u.hostname : ''; } catch { /* host stays empty */ }
  if (!/(^|\.)paypal\.com$/.test(host)) return 'BAD_SIGNATURE (cert URL not on paypal.com)';
  const t = Date.parse(h['paypal-transmission-time']);
  if (!Number.isFinite(t) || Math.abs(t - Date.parse(receivedAt)) > 10 * 60_000) return 'BAD_SIGNATURE (transmission time outside ±10 min)';
  return null;
}

/** VERIFY_WEBHOOK job. */
export async function verifyWebhook(d: Deps, l: Lease) {
  const ev = await d.store.get('provider', K.webhook(l.job.ref), 'EVENT');
  if (!ev || ev.state !== 'RECEIVED') return d.store.transact([finishOp(l, { kind: 'done' })]);
  const binding = await d.store.get('provider', K.conn(d.config.connectionId), 'TENANT');
  const active = binding ? await activeRun(d.store, binding.tenantId) : undefined;
  const now = d.now();
  const quarantine = (reason: string) => d.store.transact([
    { op: 'update', table: 'provider', pk: ev.pk, sk: 'EVENT', set: { state: 'QUARANTINED', reason, verifiedAt: now } },
    ...(active ? [auditOp({ tenantId: active.tenantId, runId: active.runId, type: 'WebhookQuarantined', by: 'HEADROOM', result: reason, refs: { eventId: ev.eventId }, correlationId: `wh:${ev.eventId}`, now })] : []),
    finishOp(l, { kind: 'done' }),
  ]).then(() => console.log(JSON.stringify({ metric: 'WebhookQuarantined', reason, eventId: ev.eventId })));

  if (!d.config.webhookId) return quarantine('NO_WEBHOOK_ID');
  // Unsigned: nothing to verify, so no PayPal call (S1-R16).
  if (WEBHOOK_HEADERS.some((h) => !ev.headers?.[h])) return quarantine('MISSING_SIGNATURE_HEADERS');
  // Cheap checks before spending a verification from the grant (S1-IR-05).
  const pre = prefilter(ev.headers, ev.receivedAt);
  if (pre) return quarantine(pre);
  const event = JSON.parse(ev.raw);
  const r = await d.reader.verifyWebhookSignature(ev.headers, d.config.webhookId, event);
  // A definitive 4xx means PayPal can't verify it: quarantine. Only 5xx/429 are retried (unverified stays unprocessed).
  if (r.status >= 400 && r.status < 500 && r.status !== 429) return quarantine(`BAD_SIGNATURE (verify ${r.status})`);
  if (r.status !== 200) throw new Error(`verify-webhook-signature ${r.status}`);
  if (r.body?.verification_status !== 'SUCCESS') return quarantine('BAD_SIGNATURE');
  if (event?.event_type !== 'INVOICING.INVOICE.PAID') return quarantine('UNEXPECTED_TYPE');
  const parsed = PpInvoicePaidEvent.safeParse(event);
  if (!parsed.success) return quarantine('BAD_ENVELOPE');
  const ref = await d.store.get('provider', K.ppInvoice(parsed.data.resource.invoice.id), 'REF');
  if (!ref) return quarantine('NOT_OURS');

  // Only the invoice id is used; payloads arrive out of order and carry later state (probe 01 #16–17).
  const audits: Op[] = [auditOp({ tenantId: ref.tenantId, runId: ref.runId, type: 'WebhookVerified', by: 'PAYPAL', result: 'Signature verified; reading the invoice from PayPal', refs: { eventId: ev.eventId, invoiceId: ref.invoiceId }, correlationId: `wh:${ev.eventId}`, now })];
  if (active && active.runId !== ref.runId) audits.push(auditOp({ tenantId: ref.tenantId, runId: ref.runId, type: 'OldRunEventRouted', by: 'HEADROOM', result: `Event for an invoice of sealed run ${ref.runId}; routed there, not to ${active.runId}`, refs: { eventId: ev.eventId }, correlationId: `wh:${ev.eventId}`, now }));
  await d.store.transact(audits);
  await reconcileInvoice(d, { tenantId: ref.tenantId, runId: ref.runId, invoiceId: ref.invoiceId }, 'WEBHOOK', l);
  await d.store.transact([
    { op: 'update', table: 'provider', pk: ev.pk, sk: 'EVENT', set: { state: 'PROCESSED', verifiedAt: now } },
    finishOp(l, { kind: 'done' }),
  ]);
}
