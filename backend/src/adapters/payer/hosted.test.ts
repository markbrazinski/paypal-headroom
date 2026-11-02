import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostedPayer } from './hosted.ts';

test('S7 B6 payer: a browser that fails to launch never reached PayPal → NOT_SUBMITTED (safe to retry)', async () => {
  const r = await hostedPayer(async () => { throw new Error('libnspr4.so missing'); }, { email: 'x', password: 'y' }).pay({ url: 'https://www.sandbox.paypal.com/invoice/p/#INV2-AAAA', amountMinor: 100, partial: false });
  assert.deepEqual([r.phaseReached, /libnspr4/.test(r.error ?? '')], ['NOT_SUBMITTED', true]);
});
