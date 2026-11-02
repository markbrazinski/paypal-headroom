// Webhook Lambda: public `/v1/webhooks/paypal`. Stores raw + job in one TX; verification happens in the worker.
import { ingestWebhook } from '../domain/paypal-mirror/webhook.ts';
import { toReq, type HttpEvent } from './http-event.ts';
import { now, queue, store } from './runtime.ts';

export const handler = async (e: HttpEvent) => {
  const req = toReq(e, false);
  const r = await ingestWebhook(store, queue, req.body ?? '', req.headers, now());
  return { statusCode: r.status, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ok: r.status === 200 }) };
};
