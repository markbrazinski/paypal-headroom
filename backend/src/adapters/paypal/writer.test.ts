import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../store/memory.ts';
import { K } from '../store/keys.ts';
import { S5_GRANT } from '../../deps.ts';
import { PayPalHttp } from './http.ts';
import { paypalWriter } from './writer.ts';

test('E5 paypal: update suppresses both notifications (S5-PR-10): every updateInvoice is PUT …?send_to_recipient=false&send_to_invoicer=false', async () => {
  const log: { method: string; url: string; body: string }[] = [];
  const store = new MemoryStore();
  const http = new PayPalHttp({
    clientId: 'c', secret: 's', store, grant: S5_GRANT, now: () => '2026-11-02T00:00:00.000Z',
    fetchImpl: (async (url: string, init: RequestInit) => {
      if (url.endsWith('/v1/oauth2/token')) return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }));
      log.push({ method: String(init.method), url, body: String(init.body) });
      return new Response('{}');
    }) as typeof fetch,
  });
  const w = paypalWriter(http);
  // apply, remove, partial, resend: the adapter has one path whatever the body says.
  const bodies = ['{"configuration":{"partial_payment":{"allow_partial_payment":true}}}', '{"amount":{"breakdown":{"discount":{"invoice_discount":{"percent":"2"}}}}}', '{"send_to_recipient":true}'];
  for (const b of bodies) await w.updateInvoice('INV2-AB/CD', b, 'req-1');
  assert.equal(log.length, 3);
  for (const [i, c] of log.entries()) {
    assert.equal(c.method, 'PUT');
    assert.equal(c.url, 'https://api-m.sandbox.paypal.com/v2/invoicing/invoices/INV2-AB%2FCD?send_to_recipient=false&send_to_invoicer=false');
    assert.equal(c.body, bodies[i], 'stored bytes go out unchanged');
  }
  assert.equal(new URL(log[0].url).searchParams.get('send_to_recipient'), 'false');
  assert.equal(new URL(log[0].url).searchParams.get('send_to_invoicer'), 'false');
  assert.equal(paypalWriter.length, 1, 'no option to change the flags');
  assert.equal((await store.get('work', K.counter('S5'), 'COUNTER'))?.updates, 3, 'counted under its own kind');
});

test('Y14 paypal: createPayout sends the stored bytes with Request-Id, and refuses a non-sandbox receiver before any call (S6-D1)', async () => {
  const { S6_GRANT } = await import('../../deps.ts');
  const log: { method: string; url: string; body: string; rid: string | null }[] = [];
  const store = new MemoryStore();
  const http = new PayPalHttp({
    clientId: 'c', secret: 's', store, grant: S6_GRANT, now: () => '2026-11-02T00:00:00.000Z',
    fetchImpl: (async (url: string, init: RequestInit) => {
      if (url.endsWith('/v1/oauth2/token')) return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }));
      log.push({ method: String(init.method), url, body: String(init.body), rid: (init.headers as Record<string, string>)['PayPal-Request-Id'] ?? null });
      return new Response('{}', { status: 201 });
    }) as typeof fetch,
  });
  const w = paypalWriter(http);
  const ok = '{"sender_batch_header":{"sender_batch_id":"HRX"},"items":[{"receiver":"s-1@personal.example.com"}]}';
  await w.createPayout(ok, 'HRX');
  assert.deepEqual(log, [{ method: 'POST', url: 'https://api-m.sandbox.paypal.com/v1/payments/payouts', body: ok, rid: 'HRX' }]);
  for (const bad of ['keller@gmail.com', 'x@example.com.evil.io', 'x@notexample.com', '']) {
    await assert.rejects(w.createPayout(JSON.stringify({ items: [{ receiver: bad }] }), 'HRY'), /sandbox/);
  }
  await assert.rejects(w.createPayout('{"items":[]}', 'HRZ'));
  assert.equal(log.length, 1, 'refused bodies never reach PayPal');
  assert.equal((await store.get('work', K.counter('S6'), 'COUNTER'))?.payouts, 1);
});
