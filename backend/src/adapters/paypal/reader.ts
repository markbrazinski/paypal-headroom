import type { PayPalHttp } from './http.ts';
import type { PayPalReader } from './types.ts';

export function paypalReader(http: PayPalHttp): PayPalReader {
  return {
    getInvoice: (id) => http.call('reads', 'GET', `/v2/invoicing/invoices/${encodeURIComponent(id)}`),
    searchInvoiceByNumber: (n) => http.call('reads', 'POST', '/v2/invoicing/search-invoices?page=1&page_size=5', { invoice_number: n }),
    getCapture: (id) => http.call('reads', 'GET', `/v2/payments/captures/${encodeURIComponent(id)}`),
    getBalances: () => http.call('reads', 'GET', '/v1/reporting/balances?currency_code=USD'),
    getTransactions: (start, end, page) =>
      http.call('reads', 'GET', `/v1/reporting/transactions?start_date=${encodeURIComponent(start)}&end_date=${encodeURIComponent(end)}&fields=transaction_info&page_size=500&page=${page}`),
    getPayoutBatch: (id) => http.call('reads', 'GET', `/v1/payments/payouts/${encodeURIComponent(id)}`),
    getPayoutItem: (id) => http.call('reads', 'GET', `/v1/payments/payouts-item/${encodeURIComponent(id)}`),
    verifyWebhookSignature: (h, webhookId, event) =>
      http.call('verifies', 'POST', '/v1/notifications/verify-webhook-signature', {
        auth_algo: h['paypal-auth-algo'], cert_url: h['paypal-cert-url'], transmission_id: h['paypal-transmission-id'],
        transmission_sig: h['paypal-transmission-sig'], transmission_time: h['paypal-transmission-time'], webhook_id: webhookId, webhook_event: event,
      }),
  };
}
