// C-PLAID: the parts of Plaid responses Headroom relies on, validated at the adapter boundary.
// Unknown fields pass through (z.object is non-strict); missing required fields fail loudly.
import { z } from 'zod';

export const PlaidError = z.object({ error_type: z.string(), error_code: z.string(), error_message: z.string().optional(), display_message: z.string().nullable().optional() });
export type PlaidError = z.infer<typeof PlaidError>;

export const PlaidLinkToken = z.object({ link_token: z.string(), expiration: z.string() });
export const PlaidExchange = z.object({ access_token: z.string(), item_id: z.string() });
export const PlaidSandboxPublicToken = z.object({ public_token: z.string() });

export const PlaidItemGet = z.object({
  item: z.object({
    item_id: z.string(),
    institution_id: z.string().nullable().optional(),
    institution_name: z.string().nullable().optional(),
    error: PlaidError.nullable(),
    consent_expiration_time: z.string().nullable().optional(),
  }),
  status: z.object({ transactions: z.object({ last_successful_update: z.string().nullable().optional() }).nullable().optional() }).nullable().optional(),
});
export type PlaidItemGet = z.infer<typeof PlaidItemGet>;

export const PlaidAccount = z.object({
  account_id: z.string(),
  name: z.string(),
  mask: z.string().nullable(),
  type: z.string(),
  subtype: z.string().nullable(),
  holder_category: z.string().nullable().optional(),
  balances: z.object({
    available: z.number().nullable(),
    current: z.number().nullable(),
    limit: z.number().nullable().optional(),
    // Observed 1 Nov 2026: sandbox user_good omits both currency fields; absent = currency not reported (never assumed USD).
    iso_currency_code: z.string().nullable().optional(),
    unofficial_currency_code: z.string().nullable().optional(),
    last_updated_datetime: z.string().nullable().optional(),
  }),
});
export type PlaidAccount = z.infer<typeof PlaidAccount>;
export const PlaidBalanceGet = z.object({ accounts: z.array(PlaidAccount) });

export const PlaidTransaction = z.object({
  transaction_id: z.string(),
  account_id: z.string(),
  amount: z.number(),
  iso_currency_code: z.string().nullable().optional(),
  unofficial_currency_code: z.string().nullable().optional(),
  date: z.string(),
  authorized_date: z.string().nullable().optional(),
  name: z.string(),
  pending: z.boolean(),
  pending_transaction_id: z.string().nullable().optional(),
  counterparties: z.array(z.object({ name: z.string() })).optional(),
});
export type PlaidTransaction = z.infer<typeof PlaidTransaction>;

export const PlaidSyncPage = z.object({
  added: z.array(PlaidTransaction),
  modified: z.array(PlaidTransaction),
  removed: z.array(z.object({ transaction_id: z.string() })),
  next_cursor: z.string(),
  has_more: z.boolean(),
  transactions_update_status: z.string().optional(),
});
export type PlaidSyncPage = z.infer<typeof PlaidSyncPage>;
