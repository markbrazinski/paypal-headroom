// Response classification for the invoice-issue effect (S01 T2.11). Pure.
export interface HttpResult { status: number; body: any }

export type CreateOutcome =
  | { kind: 'CREATED'; ppInvoiceId: string }
  | { kind: 'DUPLICATE' } // the number exists; PPREF#INVNUM uniqueness makes it ours → reconcile by number
  | { kind: 'FAILURE'; reason: string }
  | { kind: 'UNKNOWN'; reason: string };

/** `r` is undefined when the call failed without an HTTP response (timeout, network): always UNKNOWN. */
export function classifyCreate(r: HttpResult | undefined): CreateOutcome {
  if (!r) return { kind: 'UNKNOWN', reason: 'No HTTP response (timeout or network)' };
  if (r.status >= 200 && r.status < 300 && typeof r.body?.id === 'string') return { kind: 'CREATED', ppInvoiceId: r.body.id };
  if (r.status >= 200 && r.status < 300) return { kind: 'UNKNOWN', reason: 'Create succeeded without an invoice id' };
  if (r.status === 422 && (r.body?.details ?? []).some((d: any) => d.issue === 'DUPLICATE_INVOICE_NUMBER')) return { kind: 'DUPLICATE' };
  if (r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429) return { kind: 'FAILURE', reason: providerReason(r) };
  return { kind: 'UNKNOWN', reason: `PayPal answered ${r.status}` };
}

export type SendOutcome = { kind: 'SENT' } | { kind: 'CHECK_STATUS'; reason: string } | { kind: 'UNKNOWN'; reason: string };

export function classifySend(r: HttpResult | undefined): SendOutcome {
  if (!r) return { kind: 'UNKNOWN', reason: 'No HTTP response (timeout or network)' };
  if (r.status >= 200 && r.status < 300) return { kind: 'SENT' };
  if (r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429) return { kind: 'CHECK_STATUS', reason: providerReason(r) };
  return { kind: 'UNKNOWN', reason: `PayPal answered ${r.status}` };
}

/** Invoice statuses that mean PayPal has issued it (send took effect). */
export const ISSUED_PROVIDER_STATUSES = ['UNPAID', 'SENT', 'SCHEDULED', 'PARTIALLY_PAID', 'PAID', 'MARKED_AS_PAID', 'PAYMENT_PENDING', 'PARTIALLY_REFUNDED', 'REFUNDED', 'MARKED_AS_REFUNDED'];

export const providerReason = (r: HttpResult) =>
  `PayPal ${r.status} ${r.body?.name ?? ''} ${(r.body?.details ?? []).map((d: any) => d.issue).join(',')}`.trim();
