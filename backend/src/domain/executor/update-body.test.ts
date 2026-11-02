import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyAfter, discountMinor, targetHolds, updateBody } from './update-body.ts';

// Sanitized shape of a sandbox invoice GET (S05 §10a step 0): fresh invoices report a zero invoice discount.
const get = (o: { note?: string; lut?: string; status?: string; discount?: { percent: string; amount: string } | null; partial?: boolean; memo?: string } = {}) => ({
  id: 'INV2-TEST', status: o.status ?? 'UNPAID',
  detail: { invoice_number: 'HR-TEST-0001', currency_code: 'USD', note: o.note ?? 'Invoice note', ...(o.memo ? { memo: o.memo } : {}), invoice_date: '2026-11-09', payment_term: { due_date: '2026-11-25' }, metadata: { last_update_time: o.lut ?? '2026-11-09T10:00:00Z', recipient_view_url: 'https://www.sandbox.paypal.com/invoice/p/#X' } },
  invoicer: { email_address: 'merchant@example.com' }, primary_recipients: [{ billing_info: { email_address: 'ar@example.com', business_name: 'Mercer Architects' } }],
  items: [{ name: 'Services', quantity: '1', unit_amount: { currency_code: 'USD', value: '4500.00' } }],
  configuration: { tax_calculated_after_discount: true, ...(o.partial ? { partial_payment: { allow_partial_payment: true, minimum_amount_due: { currency_code: 'USD', value: '7200.00' } } } : {}) },
  amount: { currency_code: 'USD', value: '4500.00', breakdown: { item_total: { currency_code: 'USD', value: '4500.00' }, discount: o.discount ? { invoice_discount: { percent: o.discount.percent, amount: { currency_code: 'USD', value: o.discount.amount } }, item_discount: { currency_code: 'USD', value: '0.00' } } : { invoice_discount: { amount: { currency_code: 'USD', value: '0.00' } } } } },
  due_amount: { currency_code: 'USD', value: '4500.00' }, links: [{ rel: 'self' }],
});
const LINE = 'Early-payment discount 2% if paid by Fri Nov 13 18:00';

test('E3 offer: apply and expire bodies (2% on 4500.00; removal from the fresh GET minus only the discount)', () => {
  const pre = get();
  const body = updateBody(pre, { kind: 'APPLY_DISCOUNT', percentBp: 200, noteLine: LINE });
  assert.deepEqual(body.amount, { breakdown: { discount: { invoice_discount: { percent: '2' } } } });
  assert.equal(body.detail.note, `Invoice note\n${LINE}`);
  for (const k of ['id', 'status', 'links', 'due_amount']) assert.equal(k in body, false, `${k} is read-only`);
  assert.equal('metadata' in body.detail, false);
  // PayPal applied it: GET shows the computed −90.00 and due 4410.00
  const applied = { ...get({ note: body.detail.note, lut: '2026-11-11T09:00:05Z', status: 'SENT', discount: { percent: '2', amount: '-90.00' } }), due_amount: { currency_code: 'USD', value: '4410.00' } };
  assert.equal(classifyAfter(applied, pre, body), 'SUCCESS');
  assert.equal(discountMinor(applied), 9000, 'the concession is read from PayPal, not computed');
  // a GET claiming success but showing no discount is not success
  assert.notEqual(classifyAfter(get({ lut: '2026-11-11T09:00:05Z' }), pre, body), 'SUCCESS');
  // removal at expiry is built from a FRESH GET (here someone also set a memo since): only the discount and its note line change
  const fresh = { ...applied, detail: { ...applied.detail, memo: 'set later in PayPal' } };
  const rm = updateBody(fresh, { kind: 'REMOVE_DISCOUNT', noteLine: LINE });
  assert.equal(rm.amount, undefined);
  assert.equal(rm.detail.note, 'Invoice note');
  assert.equal(rm.detail.memo, 'set later in PayPal', 'never the apply preimage');
  assert.ok(targetHolds(get(), { kind: 'REMOVE_DISCOUNT', noteLine: null }), 'a zero discount is no discount');
  assert.ok(!targetHolds(applied, { kind: 'REMOVE_DISCOUNT', noteLine: null }));
});

test('E1 effects: GET classification (a) success, (b) not landed → resend stored bytes, (c) changed by someone else → CONFLICT', () => {
  const pre = get();
  const sent = updateBody(pre, { kind: 'ENABLE_PARTIAL', minimumMinor: 720_000 });
  assert.deepEqual(sent.configuration.partial_payment, { allow_partial_payment: true, minimum_amount_due: { currency_code: 'USD', value: '7200.00' } });
  assert.equal(sent.configuration.tax_calculated_after_discount, true, 'non-target configuration kept');
  const landed = { ...get({ partial: true, lut: '2026-11-09T10:00:07Z', status: 'SENT' }), configuration: { ...get().configuration, partial_payment: { allow_partial_payment: true, minimum_amount_due: { currency_code: 'USD', value: '7200.00' } } } };
  assert.equal(classifyAfter(landed, pre, sent), 'SUCCESS');
  assert.equal(classifyAfter(pre, pre, sent), 'NOT_LANDED');
  assert.equal(classifyAfter(get({ memo: 'owner edit', lut: '2026-11-09T10:00:03Z' }), pre, sent), 'CONFLICT', 'edited before our PUT landed');
  assert.equal(classifyAfter({ ...landed, detail: { ...landed.detail, memo: 'owner edit' } }, pre, sent), 'CONFLICT', 'edited after');
  assert.equal(classifyAfter(get({ status: 'PAID' }), pre, sent), 'CONFLICT', 'status changed: never resent');
  assert.throws(() => updateBody({ id: 'x' }, { kind: 'ENABLE_PARTIAL', minimumMinor: 1 }), /no detail/);
});
