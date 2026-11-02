// SEEDED hero receivables (S4-D5, D6, D18): three fictional customers, their real PayPal sandbox invoices (issued through the
// S1 executor like any owner invoice), Harrow's acknowledged dispute split and the payment history behind relationship labels.
// Labelled SEEDED in data and UI; history is never cash. Dates are day offsets from the reset business date.
import type { ClaimSplit, Customer, HistoryEntry } from '@headroom/contracts';
import type { Op } from '../../adapters/store/port.ts';
import { auditOp } from '../audit/audit.ts';
import type { RunItem } from '../identity-run/run.ts';
import { addDays } from '../time.ts';
import { addBusinessDays, zonedInstant } from '../plan/dates.ts';
import { MERCER_DUE_ON } from '../obligations/seed.ts';
import { invoiceNumber, issueOps, newInvoiceId, type InvItem } from './commands.ts';

const usd = (minor: number) => ({ currency: 'USD' as const, minor });
export const PELLOW = 'cust-pellow';
export const HARROW = 'cust-harrow';
export const MERCER = 'cust-mercer';

export const HERO_CUSTOMERS: Customer[] = [
  { customerId: PELLOW, displayName: 'Pellow Dental Group', billingEmail: 'accounts.pellow@example.com', basis: 'SEEDED' },
  { customerId: HARROW, displayName: 'Harrow Developments', billingEmail: 'accounts.harrow@example.com', basis: 'SEEDED' },
  { customerId: MERCER, displayName: 'Mercer Architects', billingEmail: 'ar.mercer@example.com', basis: 'SEEDED' },
];
/** Pellow overdue, Harrow overdue with a dispute, Mercer due later (its stated date is the seeded Mercer inflow). */
export const HERO_INVOICES = [
  { customerId: PELLOW, minor: 760_000, dueDay: -14 },
  { customerId: HARROW, minor: 900_000, dueDay: -7 },
  { customerId: MERCER, minor: 450_000, dueDay: 16 }, // due on MERCER_DUE_ON (12 business days; +16 calendar from a Monday)
] as const;
export const HERO_INVOICE_COUNT = HERO_INVOICES.length;

/** Paid history per counterparty as [dueDay, paidDay] offsets; disputes and missed arrangements listed separately. */
const PAID: Record<string, [number, number][]> = {
  [PELLOW]: [[-150, -147], [-120, -115], [-90, -82], [-60, -58], [-35, -29]], // median 5 days late → Good
  [HARROW]: [[-140, -126], [-100, -88], [-70, -61], [-45, -40]],
  [MERCER]: [[-160, -160], [-130, -129], [-100, -100], [-75, -73], [-50, -49], [-25, -25]], // median 0.5 → Strong
  'cust-alder': [[-90, -78], [-60, -40], [-30, -12]], // median 18 → Mixed
  'cust-birch': [[-40, -38]], // one paid invoice → Not enough history
  'cust-copper': [[-80, -79], [-50, -48], [-20, -19]], // median 1, but a missed arrangement caps it at Mixed
};

/** Pellow's last reminder: the business day before day 0 (whatever weekday the reset falls on), so it is always inside the spacing rule. */
export const PELLOW_REMINDED = (day0: string) => addBusinessDays(day0 as never, -1);

/** `dispute: 'EMAIL'` (S7 R4/O3): Harrow's dispute arrives as an email, so its seeded history entry is not written either. */
export function heroHistory(day0: string, dispute: 'SEEDED' | 'EMAIL' = 'SEEDED'): HistoryEntry[] {
  const out: HistoryEntry[] = [];
  for (const [cp, rows] of Object.entries(PAID)) rows.forEach(([due, paid], i) => out.push({ counterpartyId: cp, n: i + 1, kind: 'INVOICE_PAID', ref: `Earlier invoice ${i + 1}`, dueOn: addDays(day0, due), paidOn: addDays(day0, paid), amount: usd(250_000), note: null, open: false, basis: 'SEEDED' }));
  if (dispute === 'SEEDED') out.push({ counterpartyId: HARROW, n: 90, kind: 'DISPUTE', ref: 'Scope change on the current invoice', dueOn: addDays(day0, -7), paidOn: null, amount: usd(180_000), note: 'Disputes $1,800 of the current invoice (scope change); acknowledges $7,200', open: true, basis: 'SEEDED' });
  // UX repair (S7-UX1): Pellow was reminded on the previous business day, inside the 4-business-day contact rule (seeded, labelled).
  out.push({ counterpartyId: PELLOW, n: 91, kind: 'REMINDER_SENT', ref: 'Payment reminder for the overdue invoice', dueOn: PELLOW_REMINDED(day0), paidOn: null, amount: usd(760_000), note: 'Reminder sent; no reply yet', open: false, basis: 'SEEDED' });
  out.push({ counterpartyId: 'cust-copper', n: 90, kind: 'ARRANGEMENT_MISSED', ref: 'Two-part arrangement', dueOn: addDays(day0, -10), paidOn: null, amount: usd(120_000), note: 'Second part missed', open: false, basis: 'SEEDED' });
  return out;
}

/** The reset ops for the hero receivables. Invoice numbers 001–003 of the run; the reset's sequence starts at 4 (§6.17 R3). */
export function heroReceivableOps(run: RunItem, day0: string, now: string, correlationId: string, dispute: 'SEEDED' | 'EMAIL' = 'SEEDED'): { ops: Op[]; invoiceIds: Record<string, string> } {
  const invoiceIds: Record<string, string> = {};
  const ops: Op[] = HERO_CUSTOMERS.map((c): Op => ({ op: 'put', table: 'core', item: { pk: run.pk, sk: `CUST#${c.customerId}`, ...c } }));
  HERO_INVOICES.forEach((h, i) => {
    const invoiceId = newInvoiceId(run.runId);
    invoiceIds[h.customerId] = invoiceId;
    const number = invoiceNumber(run.runId, i + 1);
    const inv: InvItem = {
      pk: run.pk, sk: `INV#${invoiceId}`, tenantId: run.tenantId, invoiceId, runId: run.runId, customerId: h.customerId, amount: usd(h.minor), dueOn: h.customerId === MERCER ? MERCER_DUE_ON(day0) : addDays(day0, h.dueDay),
      state: 'ISSUING', version: 1, invoiceNumber: number, ppInvoiceId: null, providerStatus: null, payerUrl: null, openGross: usd(h.minor),
      ownerAssertions: [], hold: null, failureReason: null, lastCheckedAt: null, lastRawSha256: null, createdAt: now, issuedAt: null,
    };
    ops.push({ op: 'put', table: 'core', item: { ...inv, seeded: true }, cond: { notExists: true } }, ...issueOps(run, inv, number, now, { by: 'OPERATOR', allowedBy: 'Operator: sandbox reset (SEEDED invoice)', correlationId }));
  });
  const claim: ClaimSplit = { invoiceId: invoiceIds[HARROW], undisputed: usd(720_000), disputed: usd(180_000), acknowledgement: { from: 'Harrow Developments accounts team', quote: 'We accept the $7,200 for the agreed scope and dispute the $1,800 change order.', on: addDays(day0, -5) }, basis: 'SEEDED' };
  if (dispute === 'SEEDED') ops.push({ op: 'put', table: 'core', item: { pk: run.pk, sk: `CLAIM#${claim.invoiceId}`, ...claim } });
  // The contact slot (S7 R9) holds that send, so the spacing rule sees it exactly like a send Headroom made.
  ops.push({ op: 'put', table: 'core', item: { pk: run.pk, sk: `CONTACT#${PELLOW}`, lastSentAt: zonedInstant(PELLOW_REMINDED(day0) as never, '10:00', run.settings.timeZone), pendingEffect: null, version: 1, basis: 'SEEDED' } });
  for (const h of heroHistory(day0, dispute)) ops.push({ op: 'put', table: 'core', item: { pk: run.pk, sk: `HIST#${h.counterpartyId}#${String(h.n).padStart(3, '0')}`, ...h } });
  ops.push(auditOp({ tenantId: run.tenantId, runId: run.runId, type: 'HeroReceivablesSeeded', by: 'OPERATOR', allowedBy: 'Operator: sandbox reset', result: `SEEDED: Pellow, Harrow and Mercer with 3 real PayPal sandbox invoices (operator-issued), ${dispute === 'SEEDED' ? 'Harrow’s acknowledged $1,800 dispute' : 'no dispute (Harrow’s arrives by email)'} and earlier payment history (fictional)`, refs: {}, correlationId, now }));
  return { ops, invoiceIds };
}
