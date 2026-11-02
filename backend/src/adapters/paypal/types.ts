// Adapter split (invariant 16): the reader does GETs, search and signature verification; only the
// effect executor (worker, operator) is ever constructed with a writer. Handlers import types only.
import type { HttpResult } from '../grant.ts';
export { CallRefused, NoResponse, type Grant, type HttpResult } from '../grant.ts';

export interface PayPalReader {
  getInvoice(ppInvoiceId: string): Promise<HttpResult>;
  searchInvoiceByNumber(invoiceNumber: string): Promise<HttpResult>;
  getCapture(captureId: string): Promise<HttpResult>;
  getBalances(): Promise<HttpResult>;
  getTransactions(startIso: string, endIso: string, page: number): Promise<HttpResult>;
  verifyWebhookSignature(headers: Record<string, string>, webhookId: string, event: unknown): Promise<HttpResult>;
  getPayoutBatch(payoutBatchId: string): Promise<HttpResult>;
  getPayoutItem(payoutItemId: string): Promise<HttpResult>;
}

export interface CreateInvoiceArgs {
  invoiceNumber: string;
  invoiceDate: string;
  dueOn: string;
  amountMinor: number;
  merchantEmail: string;
  recipient: { name: string; email: string };
  itemName: string;
  note: string;
}

export interface PayPalWriter {
  createInvoice(a: CreateInvoiceArgs, requestId: string): Promise<HttpResult>;
  sendInvoice(ppInvoiceId: string, requestId: string): Promise<HttpResult>;
  /**
   * Full-replace PUT of an invoice with the exact stored body bytes (S5-D4). Always
   * `?send_to_recipient=false&send_to_invoicer=false`: no PayPal email to the payer or the merchant, and no argument to change it.
   */
  updateInvoice(ppInvoiceId: string, bodyBytes: string, requestId: string): Promise<HttpResult>;
  /**
   * POST /v1/payments/payouts with the exact stored body bytes (S6-D6), `PayPal-Request-Id` = the sender_batch_id.
   * Refuses (before any call) a body whose receivers are not sandbox `*.example.com` addresses (S6-D1 guard; not identity proof).
   */
  createPayout(bodyBytes: string, requestId: string): Promise<HttpResult>;
}

/** S6-D1: the sandbox safety bound on payout receivers. Throws if any item's receiver isn't an `@….example.com` email. */
export function assertSandboxReceivers(bodyBytes: string) {
  const items = (JSON.parse(bodyBytes) as { items?: { receiver?: unknown }[] }).items ?? [];
  if (!items.length) throw new Error('payout body has no items');
  for (const it of items) {
    if (typeof it.receiver !== 'string' || !/^[^@\s]+@([a-z0-9-]+\.)*example\.com$/i.test(it.receiver)) throw new Error('refusing payout: receiver is not a sandbox *.example.com address');
  }
}

/** The only invoice-update path and query (S5-PR-10). Exported so the request frozen at PREPARED records exactly what is sent. */
export const updateInvoicePath = (ppInvoiceId: string) => `/v2/invoicing/invoices/${encodeURIComponent(ppInvoiceId)}?send_to_recipient=false&send_to_invoicer=false`;

export type CallKind = 'reads' | 'creates' | 'sends' | 'verifies' | 'updates' | 'payouts';
