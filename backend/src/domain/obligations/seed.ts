// SEEDED hero obligations (S3-D1/D2, inherited from the owner-accepted S1 D-7 / S2-D2 seeds). Fictional names, labelled SEEDED
// in data and UI. Dates are day offsets from the reset business date (day 0); with the seeded bank and a $1,800 PayPal
// opening they reproduce hero fixture v1a (tests/fixtures/hero-v1a/closes.json).
import type { Commitment, LocalDate, StatedInflow, Supplier } from '@headroom/contracts';
import { addDays } from '../time.ts';
import { addBusinessDays } from '../plan/dates.ts';

export const KELLER = 'sup-keller';
export const BRIGHTLINE = 'sup-brightline';
export const MILESTONE = 'cmt-keller-ms2';

export const SEED_SUPPLIERS: Supplier[] = [
  { supplierId: KELLER, displayName: 'Keller Drafting Co.', aliases: ['Keller Drafting'], verifiedRemittanceLast4: '4417', basis: 'SEEDED', contactEmail: 'billing@keller.example' },
  // Payroll runs through a provider so its two same-amount occurrences give a real ambiguous-match case (S3-PR-08).
  { supplierId: BRIGHTLINE, displayName: 'Brightline Payroll Services', aliases: ['Brightline Payroll'], verifiedRemittanceLast4: '2290', basis: 'SEEDED' },
];

const usd = (minor: number) => ({ currency: 'USD' as const, minor });

/** Business-day anchors (F10): Keller's milestone (+18 business days) and Mercer's due date (+12), equal to hero v1a on a Monday. */
export const MILESTONE_ON = (day0: string) => addBusinessDays(day0 as LocalDate, 18);
export const MERCER_DUE_ON = (day0: string) => addBusinessDays(day0 as LocalDate, 12);

export function seedCommitments(day0: string, createdAt: string): Commitment[] {
  const d = (n: number) => addDays(day0, n);
  const base = { estimate: false, provenance: 'SEEDED' as const, createdOn: day0, createdAt };
  // UX repair (S7 audit F10): the supplier milestone is 18 business days after day 0 (Thu Dec 3 for a Monday Nov 9 reset, as in
  // hero v1a), so a reset on any weekday keeps it on a business day; other seeded dates stay calendar offsets (forecast only).
  return [
    { ...base, commitmentId: MILESTONE, supplierId: KELLER, name: 'Keller milestone 2', reference: 'MS-2', amount: usd(1_000_000), schedule: { kind: 'ONCE', on: MILESTONE_ON(day0) }, rail: 'PAYPAL_PAYOUT', protected: false },
    { ...base, commitmentId: 'cmt-rental', supplierId: null, name: 'Equipment rental', reference: null, amount: usd(65_000), schedule: { kind: 'ONCE', on: d(7) }, rail: 'NOT_HEADROOM', protected: false },
    { ...base, commitmentId: 'cmt-payroll', supplierId: BRIGHTLINE, name: 'Payroll', reference: null, amount: usd(380_000), schedule: { kind: 'DATES', dates: [d(11), d(41)] }, rail: 'NOT_HEADROOM', protected: true },
    { ...base, commitmentId: 'cmt-rent', supplierId: null, name: 'Office rent', reference: null, amount: usd(150_000), schedule: { kind: 'ONCE', on: d(22) }, rail: 'NOT_HEADROOM', protected: true },
  ];
}

export function seedInflows(day0: string): StatedInflow[] {
  const s = (inflowId: string, label: string, counterpartyName: string | null, n: number, minor: number): StatedInflow =>
    ({ inflowId, label, counterpartyName, on: addDays(day0, n), amount: usd(minor), basis: 'STATED', provenance: 'SEEDED' });
  return [
    { ...s('in-mercer', 'Mercer Architects · invoice due', 'Mercer Architects', 16, 450_000), on: MERCER_DUE_ON(day0) },
    s('in-retainer', 'Retainer · Alder Street Dental', 'Alder Street Dental', 22, 600_000),
    s('in-copper', 'Copperline Studios · stage payment', 'Copperline Studios', 35, 250_000),
    s('in-birch', 'Birchway Property Group · maintenance', 'Birchway Property Group', 38, 200_000),
  ];
}
