// Key layout (S01 §6.5). Four logical tables.
import type { Op } from './port.ts';
export const K = {
  tenant: (t: string) => `T#${t}`,
  run: (t: string, r: string) => `T#${t}#R#${r}`,
  user: (sub: string) => `USER#${sub}`,
  job: (id: string) => `JOB#${id}`,
  effect: (key: string) => `EFFECT#${key}`,
  idem: (t: string, key: string) => `IDEM#${t}#${key}`,
  counter: (grant: string, provider: 'paypal' | 'plaid' = 'paypal') => `COUNTER#${provider}#${grant}`,
  plaid: (itemId: string) => `PLAID#${itemId}`,
  invNum: (n: string) => `PPREF#INVNUM#${n}`,
  ppInvoice: (id: string) => `PPREF#INVOICE#${id}`,
  conn: (c: string) => `PPCONN#${c}`,
  webhook: (id: string) => `WEBHOOK#${id}`,
} as const;

/** Bank connection effects (S02 §6.2a) vs invoice-issue effects (key = invoice number). */
export const isBankEffectKey = (key: string) => key.startsWith('bankconn#') || key.startsWith('bankseed#') || key.startsWith('bankrm#');

/**
 * S4 (S04 §6.17 R1): every write that changes a plan input bumps the run's PLAN basis stamp in the same TX, so an approval or a
 * build publication conditioned on the stamp it read is refused after such a write. Leaf module: S1/S3 writers import it.
 */
export const basisBumpOp = (runPk: string): Op => ({ op: 'update', table: 'core', pk: runPk, sk: 'PLAN', add: { basisStamp: 1 } });

/**
 * S5-D22: the funds stamp of a provider partition (PayPal connection `PPCONN#<c>` or bank item `PLAID#<itemId>`). Bumped in the same
 * TX as every publication the C-SKIP-1 evaluator reads (balance, report rows, refunds, capture status, bank projection/balance), so a
 * skip decision conditioned on the stamp it read is refused after any such write (AT-F06).
 */
export const fundsBumpOp = (providerPk: string): Op => ({ op: 'update', table: 'provider', pk: providerPk, sk: 'FUNDS', add: { stamp: 1 } });
