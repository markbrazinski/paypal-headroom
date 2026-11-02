// One read of the run partition's S3 records: suppliers, commitments (+ generated occurrences), stated inflows, bills, verifications, terms.
// ponytail: computed on read like S1/S2 read models; ceiling is the 1 MB Query page (S03 §6.5).
import type { Commitment, LocalDate, Occurrence, StatedInflow, Supplier } from '@headroom/contracts';
import { K } from '../../adapters/store/keys.ts';
import type { Item, Store } from '../../adapters/store/port.ts';
import { addDays } from '../time.ts';
import { firstOnOrAfter, MATCH_WINDOW_DAYS, occKey, occurrencesOf, type StoredObligation } from './obligations.ts';

/** A stored bill: the Bill contract fields plus the internal ones matching and commands need. */
export type BillItem = Item & {
  billId: string; runId: string; tenantId: string; documentSha256: string; storageKey: string; source: 'OWNER_UPLOAD' | 'OPERATOR_INJECTED' | 'MAIL'; fileName: string; bytes: number;
  state: 'RECEIVED' | 'PROPOSED' | 'HELD' | 'READ_FAILED' | 'VERIFIED' | 'TERMS_ACCEPTED' | 'SUPERSEDED'; version: number; readGeneration: number; supersededBy?: string | null;
  classification: string | null; flags: string[]; holdReasons: string[]; fields: any[] | null;
  supplierName: string | null; billNumber: string | null; reference: string | null; dueOn: LocalDate | null;
  amount: { currency: 'USD'; minor: number } | null; printedMinor: number | null; printedTotal: string | null; currencyBasis: 'ISO' | 'BARE_DOLLAR' | null; remittanceLast4: string | null;
  supplierId: string | null; candidates: string[]; occurrenceKey: string | null; proposedTerms: { dueOn: LocalDate; amount: { currency: 'USD'; minor: number } } | null;
  changedFields: ('dueOn' | 'amount')[]; revisionOf: string | null; readFailure: string | null; receivedAt: string; updatedAt: string;
};

export interface RunObligations {
  suppliers: Supplier[];
  commitments: Commitment[];
  stored: Map<string, StoredObligation & Item>;
  occurrences: Occurrence[];
  inflows: StatedInflow[];
  bills: BillItem[];
  verifications: Item[];
  terms: Item[];
  models: Item[];
}

export async function loadRun(store: Store, tenantId: string, runId: string, today: LocalDate): Promise<RunObligations> {
  const items = await store.query('core', K.run(tenantId, runId));
  const by = (p: string) => items.filter((i) => i.sk.startsWith(p));
  const commitments = by('CMT#') as unknown as Commitment[];
  const stored = new Map(by('OBL#').map((o) => [occKey(o.commitmentId, o.n), o as StoredObligation & Item]));
  const until = addDays(today, 41 + MATCH_WINDOW_DAYS);
  return {
    suppliers: by('SUP#') as unknown as Supplier[],
    commitments,
    stored,
    // Generated through the matching window; a commitment with nothing from today on there also gets its next occurrence, however far
    // ahead, so its saved date stays visible as "not yet assessed" (S3-IM-05). Nothing beyond the horizon is ever counted.
    occurrences: commitments.flatMap((c) => {
      const occs = occurrencesOf(c, stored, until);
      if (occs.some((o) => o.dueOn >= today)) return occs;
      const next = firstOnOrAfter(c.schedule, today > c.createdOn ? today : c.createdOn);
      return next && next > until ? occurrencesOf(c, stored, next) : occs;
    }),
    inflows: by('INFLOW#') as unknown as StatedInflow[],
    bills: by('BILL#') as BillItem[],
    verifications: by('VERIFY#'),
    terms: by('TERMS#'),
    models: by('MODEL#'),
  };
}

/** The supplier name to show for a bill: the matched supplier's, else what the document says (grounded), else null. */
export const supplierLabel = (r: RunObligations, b: BillItem) => r.suppliers.find((s) => s.supplierId === b.supplierId)?.displayName ?? b.supplierName;
