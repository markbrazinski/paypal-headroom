import type { Customer, InvoiceMirror, LocalDate, Money } from '@headroom/contracts';
import { assertTransition } from '@headroom/contracts';

export interface DraftCommand { customerId: string; amount: Money; dueOn: LocalDate }
export type DraftRefusal = { path: string; message: string };

/** Pure validation for createInvoiceDraft. The server decides; the client only checks format. */
export function validateDraft(cmd: DraftCommand, customers: Customer[], businessToday: LocalDate): DraftRefusal[] {
  const out: DraftRefusal[] = [];
  if (!Number.isInteger(cmd.amount.minor) || cmd.amount.minor <= 0) out.push({ path: 'amount', message: 'Amount must be more than $0.00' });
  if (cmd.amount.currency !== 'USD') out.push({ path: 'amount', message: 'Only USD invoices are supported' });
  if (cmd.dueOn < businessToday) out.push({ path: 'dueOn', message: 'Due date cannot be before today' });
  if (!customers.some((c) => c.customerId === cmd.customerId)) out.push({ path: 'customerId', message: 'Customer is not in this run' });
  return out;
}

/** Gross allocation of one verified capture to its invoice. Never exceeds open or captured gross. */
export function allocate(invoice: Pick<InvoiceMirror, 'openGross' | 'state'>, gross: Money): { amount: Money; openGross: Money; state: 'PAID' | 'PARTIALLY_PAID' } {
  if (gross.currency !== invoice.openGross.currency) throw new Error('currency mismatch');
  const amount = Math.min(gross.minor, invoice.openGross.minor);
  if (amount !== gross.minor) throw new Error('allocation would exceed open gross');
  const open = invoice.openGross.minor - amount;
  const state = open === 0 ? 'PAID' : 'PARTIALLY_PAID';
  assertTransition('Invoice', invoice.state, state);
  return { amount: { currency: gross.currency, minor: amount }, openGross: { currency: gross.currency, minor: open }, state };
}
