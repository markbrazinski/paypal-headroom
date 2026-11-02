import { z } from 'zod';

// Money is integer minor units with a currency. Only forecast balances may be negative (SignedMoney).
export const Currency = z.enum(['USD']);
export const Money = z.object({ currency: Currency, minor: z.number().int().nonnegative() });
export const SignedMoney = z.object({ currency: Currency, minor: z.number().int() });
export type Money = z.infer<typeof Money>;
export type SignedMoney = z.infer<typeof SignedMoney>;

// A real calendar date (month lengths, leap years), not just the YYYY-MM-DD spelling (S1-IM-06).
export const LocalDate = z.iso.date({ error: 'expected a real calendar date, YYYY-MM-DD' });
export const UtcInstant = z.iso.datetime({ offset: false });
export type LocalDate = z.infer<typeof LocalDate>;
export type UtcInstant = z.infer<typeof UtcInstant>;

export const Id = z.string().min(1).max(128);
export const Basis = z.enum(['ACTUAL', 'SEEDED', 'PENDING']);

export const ErrorCode = z.enum([
  'INVALID_INPUT', 'UNAUTHENTICATED', 'NOT_FOUND', 'IDEMPOTENCY_CONFLICT', 'VERSION_CONFLICT',
  'RUN_SEALED', 'NOT_DRAFT', 'NOT_CONNECTED', 'ALREADY_CONNECTED', 'PROVIDER_UNAVAILABLE', 'INTERNAL',
  // S3 bills (S03 §6.3)
  'BILL_HELD', 'NOT_VERIFIED', 'TERMS_CHANGED', 'NOTHING_TO_ACCEPT', 'NOT_A_CANDIDATE',
  // S4 plan and delegation (S04 §6.3)
  'REVISION_NOT_DRAFT', 'NOT_EDITABLE', 'CONSENT_CHANGED', 'SAFETY_ACK_REQUIRED', 'NOTHING_SELECTED', 'HARD_STOP', 'GRANT_NOT_ACTIVE', 'NOTHING_TO_PLAN', 'CASH_IMPACT_UNKNOWN',
  // S5 execution (S05 §6.3)
  'ACTION_EXECUTED', 'OUTREACH_PAUSED', 'YOU_TOOK_OVER',
  // S7 supplier asks (S07 §6.18 R6)
  'PAYOUT_IN_FLIGHT', 'SPLIT_REFUSED',
  // S7b roles, lease and demo lane (S07 §6.18 R1–R3, R10)
  'FORBIDDEN_ROLE', 'READ_ONLY', 'MERCHANT_LEASED', 'PREVIOUS_RUN_UNRESOLVED', 'RESET_IN_PROGRESS', 'NOTHING_TO_COLLECT',
]);
export const Outcome = z.enum(['NOT_APPLIED', 'APPLIED', 'UNKNOWN']);
export const ContractError = z.object({
  code: ErrorCode,
  outcome: Outcome,
  message: z.string(),
  correlationId: z.string(),
  details: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});
export type ErrorCode = z.infer<typeof ErrorCode>;
export type ContractError = z.infer<typeof ContractError>;

/** Server-derived request context. Never built from a request body. */
export interface Ctx {
  tenantId: string;
  runId: string;
  epoch: number;
  actor: { kind: 'OWNER' | 'HEADROOM' | 'OPERATOR'; id: string };
  correlationId: string;
  now: string;
}

/**
 * What a provider reported, exactly, for display (S2-PR-07). `value` is the provider's number in ECMAScript's shortest
 * round-trip form, so 1024.502621 stays "1024.502621". Deliberately not Money: no aggregation accepts it.
 */
export const ProviderAmount = z.object({
  value: z.string(),
  currencyCode: z.string().nullable(),
  currencyKind: z.enum(['ISO', 'UNOFFICIAL', 'UNKNOWN']),
});
export type ProviderAmount = z.infer<typeof ProviderAmount>;

export const usd = (minor: number): Money => Money.parse({ currency: 'USD', minor });

/** PayPal decimal string ("120.00", "-3.08") → integer minor units. Refuses anything that isn't exact cents. */
export function decimalToMinor(value: string): number {
  const m = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (!m) throw new Error(`not a 2-dp decimal: ${value}`);
  const minor = Number(m[2]) * 100 + Number((m[3] ?? '0').padEnd(2, '0'));
  return m[1] ? -minor : minor;
}
export const minorToDecimal = (minor: number): string =>
  `${minor < 0 ? '-' : ''}${Math.floor(Math.abs(minor) / 100)}.${String(Math.abs(minor) % 100).padStart(2, '0')}`;
