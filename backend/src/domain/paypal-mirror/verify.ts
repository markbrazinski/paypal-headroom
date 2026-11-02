import { decimalToMinor, type Money, type PpCapture } from '@headroom/contracts';

export type CaptureCheck =
  | { ok: true; gross: Money; fee: Money; net: Money; capturedAt: string }
  | { ok: false; kind: 'NOT_COMPLETED' | 'MISMATCH'; reason: string };

const REVERSAL_STATUSES = ['PARTIALLY_REFUNDED', 'REFUNDED', 'REVERSED'];
export const isReversalStatus = (status: string) => REVERSAL_STATUSES.includes(status);

/**
 * PROVIDER_CONFIRMED_CAPTURE (FUNDS gates): capture COMPLETED, belongs to this PayPal invoice,
 * same currency, breakdown present with gross = fee + net in integer cents, and gross ≤ open gross.
 */
export function verifyCapture(inv: { ppInvoiceId: string; currency: 'USD'; openMinor: number; txAmountMinor?: number }, c: PpCapture): CaptureCheck {
  if (c.status !== 'COMPLETED') {
    // A refund or reversal before we ever verified the capture is not a pending state: surface it.
    if (isReversalStatus(c.status)) return { ok: false, kind: 'MISMATCH', reason: `Capture is ${c.status} before Headroom verified it` };
    return { ok: false, kind: 'NOT_COMPLETED', reason: `Capture status ${c.status}` };
  }
  if (c.invoice_id !== inv.ppInvoiceId) return { ok: false, kind: 'MISMATCH', reason: `Capture invoice ${c.invoice_id ?? 'missing'} ≠ ${inv.ppInvoiceId}` };
  const b = c.seller_receivable_breakdown;
  if (!b || !b.paypal_fee || !b.net_amount) return { ok: false, kind: 'MISMATCH', reason: 'Capture has no seller receivable breakdown' };
  const currencies = [c.amount.currency_code, b.gross_amount.currency_code, b.paypal_fee.currency_code, b.net_amount.currency_code];
  if (currencies.some((x) => x !== inv.currency)) return { ok: false, kind: 'MISMATCH', reason: `Currency ${currencies.join('/')} ≠ ${inv.currency}` };
  const gross = decimalToMinor(b.gross_amount.value);
  const fee = decimalToMinor(b.paypal_fee.value);
  const net = decimalToMinor(b.net_amount.value);
  if (gross !== decimalToMinor(c.amount.value)) return { ok: false, kind: 'MISMATCH', reason: 'Breakdown gross ≠ capture amount' };
  if (gross !== fee + net || gross <= 0 || fee < 0 || net < 0) return { ok: false, kind: 'MISMATCH', reason: `Gross ${gross} ≠ fee ${fee} + net ${net}` };
  if (inv.txAmountMinor !== undefined && gross !== inv.txAmountMinor) return { ok: false, kind: 'MISMATCH', reason: `Capture gross ${gross} ≠ invoice transaction amount ${inv.txAmountMinor}` };
  if (gross > inv.openMinor) return { ok: false, kind: 'MISMATCH', reason: `Capture gross ${gross} exceeds open ${inv.openMinor}` };
  const m = (minor: number): Money => ({ currency: 'USD', minor });
  return { ok: true, gross: m(gross), fee: m(fee), net: m(net), capturedAt: new Date(c.create_time).toISOString() };
}
