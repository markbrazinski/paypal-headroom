// SEEDED run data (owner decision D-7, 1 Nov 2026). Fictional names, synthetic @example.com addresses.
// Labelled SEEDED in data and UI. No other demo amounts live in tracked code.
import type { Customer, Settings } from '@headroom/contracts';

export const SEED_SETTINGS: Settings = {
  businessName: 'Larkspur Home Services',
  timeZone: 'America/New_York',
  basis: 'SEEDED',
};

export const SEED_CUSTOMERS: Customer[] = [
  { customerId: 'cust-alder', displayName: 'Alder Street Dental', billingEmail: 'billing.alder@example.com', basis: 'SEEDED' },
  { customerId: 'cust-birch', displayName: 'Birchway Property Group', billingEmail: 'ap.birchway@example.com', basis: 'SEEDED' },
  { customerId: 'cust-copper', displayName: 'Copperline Studios', billingEmail: 'accounts.copperline@example.com', basis: 'SEEDED' },
];
