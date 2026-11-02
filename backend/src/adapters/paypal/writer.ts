// PayPal writes. Constructed only by the worker and operator (import-graph test enforces this).
import { minorToDecimal } from '@headroom/contracts';
import type { PayPalHttp } from './http.ts';
import { assertSandboxReceivers, updateInvoicePath, type PayPalWriter } from './types.ts';

export function paypalWriter(http: PayPalHttp): PayPalWriter {
  return {
    createInvoice: (a, requestId) =>
      http.call('creates', 'POST', '/v2/invoicing/invoices', {
        detail: { currency_code: 'USD', invoice_number: a.invoiceNumber, invoice_date: a.invoiceDate, payment_term: { due_date: a.dueOn }, note: a.note },
        invoicer: { email_address: a.merchantEmail },
        primary_recipients: [{ billing_info: { email_address: a.recipient.email, business_name: a.recipient.name } }],
        items: [{ name: a.itemName, quantity: '1', unit_amount: { currency_code: 'USD', value: minorToDecimal(a.amountMinor) } }],
      }, { 'PayPal-Request-Id': requestId }), // not honoured by PayPal (probe 01 #5); the invoice number is the key
    sendInvoice: (id, requestId) =>
      http.call('sends', 'POST', `/v2/invoicing/invoices/${encodeURIComponent(id)}/send`, { send_to_recipient: false, send_to_invoicer: false }, { 'PayPal-Request-Id': requestId }),
    // PayPal-Request-Id is sent but not relied on for PUT (S5-D4; probe L5 records whether it is honoured).
    updateInvoice: (id, bodyBytes, requestId) => http.call('updates', 'PUT', updateInvoicePath(id), undefined, { 'PayPal-Request-Id': requestId }, bodyBytes),
    createPayout: async (bodyBytes, requestId) => {
      assertSandboxReceivers(bodyBytes);
      return http.call('payouts', 'POST', '/v1/payments/payouts', undefined, { 'PayPal-Request-Id': requestId }, bodyBytes);
    },
  };
}
