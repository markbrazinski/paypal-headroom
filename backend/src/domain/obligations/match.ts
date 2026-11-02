// Deterministic bill → supplier → occurrence matching (probe 02 classes; S03 §6.4 M-rules). Pure.
import type { BillClassification, ChangedField, Commitment, LocalDate, Occurrence, Supplier } from '@headroom/contracts';

export interface MatchInput {
  supplierName: string;
  billNumber: string | null;
  reference: string | null;
  dueOn: LocalDate;
  /** Printed total in minor units (provisional for a bare "$"). */
  totalMinor: number;
  currency: string; // 'USD' (or 'BARE_DOLLAR', compared as USD for matching only)
  remittanceLast4: string | null;
}
export interface EarlierBill { billId: string; supplierId: string | null; billNumber: string | null; dueOn: LocalDate | null; totalMinor: number | null; occurrenceKey: string | null }

export interface MatchResult {
  classification: BillClassification;
  held: boolean;
  holdReasons: string[];
  remittanceChange: boolean;
  supplierId: string | null;
  candidates: string[];
  occurrenceKey: string | null;
  changedFields: ChangedField[];
  revisionOf: string | null;
}

const STOP = new Set(['the', 'and', 'of', 'co', 'inc', 'llc', 'ltd', 'company', 'services', 'group']);
const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
const key = (s: string) => norm(s).filter((w) => !['co', 'inc', 'llc', 'ltd'].includes(w)).join(' ');
const firstToken = (s: string) => norm(s).find((w) => !STOP.has(w)) ?? null;
const sameRef = (a: string | null, b: string | null) => !!a && !!b && key(a) === key(b);
/** The one-current-bill slot per supplier + bill number (S3-IM-02). */
export const billNoSk = (supplierId: string, billNumber: string) => `BILLNO#${supplierId}#${key(billNumber)}`;

/**
 * M1. `ponytail:` naive name matching (the probe 02 ceiling): exact normalized name or alias, else a shared first significant
 * token → ambiguous. Upgrade to verified supplier ids when Relationships lands (S4).
 */
export function resolveSupplier(name: string, suppliers: Supplier[]): { kind: 'MATCH'; supplier: Supplier } | { kind: 'AMBIGUOUS'; ids: string[] } | { kind: 'UNKNOWN' } {
  const k = key(name);
  const exact = suppliers.filter((s) => [s.displayName, ...s.aliases].some((n) => key(n) === k));
  if (exact.length === 1) return { kind: 'MATCH', supplier: exact[0] };
  const t = firstToken(name);
  const near = exact.length > 1 ? exact : suppliers.filter((s) => t && [s.displayName, ...s.aliases].some((n) => firstToken(n) === t));
  return near.length ? { kind: 'AMBIGUOUS', ids: near.map((s) => s.supplierId) } : { kind: 'UNKNOWN' };
}

/** M3: the bill's terms against the occurrence's operative terms. */
export function changedFieldsOf(o: Pick<Occurrence, 'dueOn' | 'amount'>, dueOn: LocalDate, totalMinor: number): ChangedField[] {
  return [...(o.dueOn !== dueOn ? ['dueOn' as const] : []), ...(o.amount.minor !== totalMinor ? ['amount' as const] : [])];
}
export const classOf = (changed: ChangedField[]): BillClassification =>
  changed.length === 2 ? 'TERMS_DIFFER' : changed[0] === 'dueOn' ? 'DATE_CHANGE_REQUESTED' : changed[0] === 'amount' ? 'AMOUNT_DISCREPANCY' : 'EXACT_MATCH';

export function matchBill(b: MatchInput, suppliers: Supplier[], commitments: Commitment[], occurrences: Occurrence[], earlier: EarlierBill[]): MatchResult {
  const base = { held: false, holdReasons: [] as string[], remittanceChange: false, supplierId: null as string | null, candidates: [] as string[], occurrenceKey: null as string | null, changedFields: [] as ChangedField[], revisionOf: null as string | null };
  const hold = (classification: BillClassification, reason: string, extra: Partial<MatchResult> = {}): MatchResult => ({ ...base, ...extra, classification, held: true, holdReasons: [...(extra.holdReasons ?? []), reason] });
  const s = resolveSupplier(b.supplierName, suppliers);
  if (s.kind === 'UNKNOWN') return hold('UNKNOWN_SUPPLIER', `"${b.supplierName}" is not one of your suppliers yet; adding suppliers arrives with Customers & Suppliers`);
  if (s.kind === 'AMBIGUOUS') return hold('AMBIGUOUS_SUPPLIER', `"${b.supplierName}" could be ${s.ids.length === 1 ? 'an existing supplier' : `${s.ids.length} suppliers`}; the name doesn't match exactly`);
  const sup = s.supplier;
  const r = matchKnown(b, sup, commitments, occurrences, earlier, base, hold);
  // M5: a changed remittance is never accepted from a document alone (FG C-PAYOUT-1). The match itself is kept for context.
  if (b.remittanceLast4 && sup.verifiedRemittanceLast4 && b.remittanceLast4 !== sup.verifiedRemittanceLast4)
    return { ...r, held: true, remittanceChange: true, holdReasons: [...r.holdReasons, `Payment details differ: the bill says account ending ${b.remittanceLast4}; ${sup.displayName}'s verified details end ${sup.verifiedRemittanceLast4}. Confirm with ${sup.displayName} by phone, not from this document`] };
  return r;
}

type Base = Omit<MatchResult, 'classification'>;
function matchKnown(b: MatchInput, sup: Supplier, commitments: Commitment[], occurrences: Occurrence[], earlier: EarlierBill[], base: Base, hold: (c: BillClassification, reason: string, extra?: Partial<MatchResult>) => MatchResult): MatchResult {
  const withSupplier = { supplierId: sup.supplierId };

  const cmts = new Map(commitments.filter((c) => c.supplierId === sup.supplierId).map((c) => [c.commitmentId, c]));
  const occs = occurrences.filter((o) => cmts.has(o.commitmentId));
  const compare = (o: Occurrence, extra: Partial<MatchResult> = {}): MatchResult => {
    if (o.amount.currency !== (b.currency === 'BARE_DOLLAR' ? 'USD' : b.currency)) return hold('CURRENCY_MISMATCH', `The bill's currency differs from ${cmts.get(o.commitmentId)!.name}'s`, withSupplier);
    const changed = changedFieldsOf(o, b.dueOn, b.totalMinor);
    return { ...base, ...withSupplier, classification: classOf(changed), occurrenceKey: o.occurrenceKey, candidates: [o.occurrenceKey], changedFields: changed, ...extra };
  };

  // M4: same supplier and bill number as an earlier bill → a revision of it, not a second outflow.
  const prior = earlier.find((e) => e.supplierId === sup.supplierId && sameRef(e.billNumber, b.billNumber));
  if (prior) {
    if (prior.dueOn === b.dueOn && prior.totalMinor === b.totalMinor) return hold('REVISION_SAME_TERMS', `Same as bill ${b.billNumber} already received; nothing to do`, { ...withSupplier, revisionOf: prior.billId, occurrenceKey: prior.occurrenceKey });
    const o = prior.occurrenceKey ? occs.find((x) => x.occurrenceKey === prior.occurrenceKey) : undefined;
    if (o) { const r = compare(o, { revisionOf: prior.billId }); return r.held ? r : { ...r, classification: 'REVISION_CHANGED_TERMS' }; }
    // Not linked to a payment yet (S3-IM-02): match it normally, but as a revision, so the earlier bill is replaced, not added to.
    return { ...matchNormal(), revisionOf: prior.billId };
  }
  return matchNormal();

  function matchNormal(): MatchResult {

    // M2: a reference match wins; else unbilled same-amount occurrences. "Unbilled" = no bill substantiates it.
    const byRef = occs.filter((o) => sameRef(cmts.get(o.commitmentId)!.reference, b.reference) || sameRef(cmts.get(o.commitmentId)!.reference, b.billNumber));
    const pool = byRef.length ? byRef : occs.filter((o) => o.amount.minor === b.totalMinor);
    const open = pool.filter((o) => !o.substantiatedBy);
    if (!open.length && pool.length) return hold('COMMITMENT_ALREADY_BILLED', `${cmts.get(pool[0].commitmentId)!.name} already has a bill; this looks like a second bill for the same payment`, withSupplier);
    if (!open.length) return { ...base, ...withSupplier, classification: 'NEW_OBLIGATION_KNOWN_SUPPLIER' };
    if (open.length > 1) return { ...base, ...withSupplier, classification: 'AMBIGUOUS_COMMITMENT', candidates: open.map((o) => o.occurrenceKey) };
    return compare(open[0]);
  }
}
