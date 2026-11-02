// C-PP: the parts of PayPal responses Headroom relies on, validated at the adapter boundary.
// Unknown fields pass through (z.object is non-strict); missing required fields fail loudly.
import { z } from 'zod';

const Amount = z.object({ currency_code: z.string(), value: z.string() });

export const PpInvoice = z.object({
  id: z.string(),
  status: z.string(),
  detail: z.object({
    invoice_number: z.string(),
    currency_code: z.string(),
    metadata: z.object({ recipient_view_url: z.string().optional() }).optional(),
  }),
  amount: Amount.optional(),
  due_amount: Amount.optional(),
  payments: z
    .object({
      transactions: z
        .array(
          z.object({
            type: z.string(),
            payment_id: z.string(),
            payment_date: z.string().optional(),
            method: z.string().optional(),
            amount: Amount,
          }),
        )
        .optional(),
    })
    .optional(),
  refunds: z.unknown().optional(),
});
export type PpInvoice = z.infer<typeof PpInvoice>;

export const PpCapture = z.object({
  id: z.string(),
  status: z.string(),
  amount: Amount,
  invoice_id: z.string().optional(),
  create_time: z.string(),
  seller_receivable_breakdown: z
    .object({ gross_amount: Amount, paypal_fee: Amount.optional(), net_amount: Amount.optional() })
    .optional(),
});
export type PpCapture = z.infer<typeof PpCapture>;

export const PpBalances = z.object({
  account_id: z.string().optional(),
  as_of_time: z.string().optional(),
  last_refresh_time: z.string().optional(),
  balances: z.array(
    z.object({
      currency: z.string(),
      available_balance: Amount.optional(),
      withheld_balance: Amount.optional(),
    }),
  ),
});
export type PpBalances = z.infer<typeof PpBalances>;

export const PpTransactionsPage = z.object({
  last_refreshed_datetime: z.string().optional(),
  page: z.number(),
  total_pages: z.number(),
  transaction_details: z.array(
    z.object({
      transaction_info: z.object({
        transaction_id: z.string(),
        paypal_reference_id: z.string().optional().nullable(),
        transaction_event_code: z.string(),
        transaction_status: z.string(),
        transaction_initiation_date: z.string(),
        transaction_updated_date: z.string().optional(),
        transaction_amount: Amount,
        fee_amount: Amount.optional().nullable(),
        available_balance: Amount.optional().nullable(),
        invoice_id: z.string().optional().nullable(),
      }),
    }),
  ),
});
export type PpTransactionsPage = z.infer<typeof PpTransactionsPage>;

/** Only INVOICING.INVOICE.PAID is registered. The invoice id is nested (probe 01 events 002/003/005); there is no resource.id. */
export const PpInvoicePaidEvent = z.object({
  id: z.string(),
  event_type: z.literal('INVOICING.INVOICE.PAID'),
  resource: z.object({ invoice: z.object({ id: z.string() }) }),
});
export type PpInvoicePaidEvent = z.infer<typeof PpInvoicePaidEvent>;

export const WEBHOOK_HEADERS = [
  'paypal-transmission-id', 'paypal-transmission-time', 'paypal-transmission-sig', 'paypal-cert-url', 'paypal-auth-algo',
] as const;
