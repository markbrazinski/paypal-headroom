// SEEDED demo bank (owner decision S2-D2, 1 Nov 2026): the Plaid sandbox `user_custom` config. Fictional names and
// amounts, labelled SEEDED in data and UI. Day fields are offsets from business-today; posted ≥ +2 makes a row pending
// (a +1 date can already be today in UTC and arrive posted). Amounts use Plaid's sign: + = money out.
// starting_balance is reported verbatim as current (Plaid does not apply transactions to it).
import { addDays } from '../time.ts';

export const DEMO_INSTITUTION = { id: 'ins_109508', name: 'First Platypus Bank' };

// Owner, 1 Nov 2026: the demo bank is two checking accounts only (no savings, no card). They split hero fixture v1a's checking
// figures exactly (available $8,130, current $8,450, $320 pending), so the company starting total stays $9,930 and every
// later forecast beat is unchanged. Null-available and card-owed handling stay covered by tests and the live user_good case.
const ACCOUNTS = [
  { type: 'depository', subtype: 'checking', starting_balance: 6650.0, currency: 'USD', meta: { name: 'Headroom Operating', mask: '0101' }, transactions: [
    [-10, -9, 2100.0, 'OFFICE RENT OCT'],
    [-6, -5, 89.99, 'SOFTWARE SUBSCRIPTION'],
    [-4, -3, -1200.0, 'CUSTOMER RECEIPT ACH INV-1001'],
    [-3, -2, -400.0, 'PAYPAL TRANSFER WITHDRAWAL'],
    [-2, -1, 250.0, 'PAYPAL INST XFER ADD FUNDS'],
    [-1, 2, 320.0, 'SUPPLIER ACME PARTS'],
  ] },
  { type: 'depository', subtype: 'checking', starting_balance: 1800.0, currency: 'USD', meta: { name: 'Headroom Payroll', mask: '0202' }, transactions: [
    [-12, -11, -1800.0, 'TRANSFER FROM OPERATING'],
    [-5, -5, -3.12, 'INTEREST PAYMENT'],
  ] },
] as const;

/** The concrete `override_password` config for a reset on `today` (business date in the tenant zone). */
export function seedConfig(today: string) {
  return {
    override_accounts: ACCOUNTS.map(({ transactions, ...a }) => ({
      ...a,
      transactions: transactions.map(([t, p, amount, description]) => ({ date_transacted: addDays(today, t), date_posted: addDays(today, p), amount, description, currency: 'USD' })),
    })),
  };
}
