// S3 read models (S03 T2, T6, T11): forecast, payables, bill panel, inbox, Overview alert and needs. Computed on read from the
// run partition, like S1/S2. Every figure comes from forecastDays(); the UI never computes cash.
import type { ActivityRow, BillDetail, BillRow, ForecastSummary, ImpactSummary, LocalDate, NeedRow, Occurrence, ResponseOf } from '@headroom/contracts';
import { forecastDays, summarize, type FDay, type FSummary } from '../domain/cash-forecast/forecast.ts';
import { movements, parseOccKey, payoutFeeEstimateMinor, type NotInForecast, type TermsChange } from '../domain/obligations/obligations.ts';
import { supplierLabel, type BillItem, type RunObligations } from '../domain/obligations/load.ts';
import { separateHash, termsHash } from '../domain/obligations/commands.ts';
import { addDays } from '../domain/time.ts';

const usd = (minor: number) => ({ currency: 'USD' as const, minor });
const signed = usd;
const money = (minor: number) => `${minor < 0 ? '−' : ''}$${(Math.abs(minor) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const dayName = (d: string) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(`${d}T00:00:00Z`));

/** `amountMinor` = PayPal lower + bank + captured-awaiting-report (S5-D6: Expected/Ideal only; DROP_PENDING removes it). */
export interface Opening { amountMinor: number; paypalLowerMinor: number; bankMinor: number | null; paypalAsOf: string | null; bankReadAt: string | null; capturedPendingMinor: number }

/** The run's forecast state: the operative series, the movements behind it, and how to price a change (D-COMPARE). */
export interface ForecastModel {
  today: LocalDate;
  reserveMinor: number;
  opening: Opening | null;
  noOpeningReason: string;
  r: RunObligations;
  billRefs: Map<string, string>;
  days: FDay[] | null;
  summary: FSummary | null;
  notInForecast: NotInForecast[];
  /** The forecast with one change applied; null when there is no opening (impact unknown, S3-D16). */
  withChange(ch: TermsChange | TermsChange[]): { days: FDay[]; summary: FSummary } | null;
}

/** `rules`: the Delegation reserve and protected-payment set-aside (S7-D5: the policy is the reserve's only source). */
export function forecastModel(r: RunObligations, today: LocalDate, rules: { reserveMinor: number; setAsideDays: number }, opening: Opening | null, noOpeningReason: string): ForecastModel {
  const reserveMinor = rules.reserveMinor;
  const billRefs = new Map(r.bills.map((b) => [b.billId, b.billNumber ?? b.fileName]));
  const x = { commitments: r.commitments, occurrences: r.occurrences, inflows: r.inflows, billRefs, setAsideDays: rules.setAsideDays };
  const base = movements(x, today);
  const f = opening ? forecastDays(opening.amountMinor, base.items, today, reserveMinor) : null;
  return {
    today, reserveMinor, opening, noOpeningReason, r, billRefs, days: f?.days ?? null, summary: f?.summary ?? null, notInForecast: base.notInForecast,
    withChange: (ch) => {
      if (!opening) return null;
      const drop = (Array.isArray(ch) ? ch : [ch]).some((c) => c.kind === 'DROP_PENDING');
      return forecastDays(opening.amountMinor - (drop ? opening.capturedPendingMinor : 0), movements(x, today, ch).items, today, reserveMinor);
    },
  };
}

export const summaryDto = (s: FSummary): ForecastSummary => ({
  low: signed(s.lowMinor), lowOn: s.lowOn, negativeDays: s.negativeDays, atReserveDays: s.atReserveDays, belowReserveDays: s.belowReserveDays,
  firstBelowReserve: s.firstBelowReserve, reserveGap: usd(s.reserveGapMinor), fundingDeficit: usd(s.fundingDeficitMinor),
});
const impactOf = (f: { days: FDay[]; summary: FSummary } | null, unknown: string, dueOn: LocalDate | null): ImpactSummary => {
  if (!f) return { state: 'UNKNOWN', reason: unknown };
  const d = dueOn ? f.days.find((x) => x.on === dueOn) : undefined;
  return { state: 'KNOWN', summary: summaryDto(f.summary), closeOnDue: d ? { on: d.on, close: signed(d.closeMinor) } : null };
};

// ---------- bills ----------
const pending = (b: BillItem) => (b.state === 'PROPOSED' || b.state === 'VERIFIED') && !!b.occurrenceKey && b.changedFields.length > 0;

/** The bill added as one more outflow (what addBillAsObligation does), whatever it matched. null without a known amount and date. */
export function addChange(b: BillItem): TermsChange | null {
  const minor = b.amount?.minor;
  if (minor === undefined || !b.dueOn) return null;
  return { kind: 'ADD', key: `bill:${b.billId}`, dueOn: b.dueOn, amountMinor: minor, label: `${b.supplierName ?? 'Bill'} · ${b.billNumber ?? ''}`.trim(), feeMinor: 0 };
}

/** The change a bill proposes, priced as a comparison (never persisted). null when its amount isn't known yet (bare "$"). */
export function billChange(b: BillItem, occurrenceKey = b.occurrenceKey): TermsChange | null {
  const minor = b.amount?.minor;
  if (minor === undefined || !b.dueOn) return null;
  if (b.classification === 'NEW_OBLIGATION_KNOWN_SUPPLIER' && b.state === 'PROPOSED') return { kind: 'ADD', key: `bill:${b.billId}`, dueOn: b.dueOn, amountMinor: minor, label: `${b.supplierName ?? 'Bill'} · ${b.billNumber ?? ''}`.trim(), feeMinor: 0 };
  return occurrenceKey ? { kind: 'REPLACE', occurrenceKey, dueOn: b.dueOn, amountMinor: minor } : null;
}

function status(b: BillItem): Pick<BillRow, 'status' | 'statusLabel'> {
  const diff = (verified: boolean): Pick<BillRow, 'status' | 'statusLabel'> => {
    const pre = verified ? 'Verified · ' : '';
    if (b.changedFields.length === 2) return { status: 'TERMS_DIFFER', statusLabel: `${pre}date and amount differ` };
    if (b.changedFields[0] === 'amount') return { status: 'AMOUNT_DIFFERS', statusLabel: `${pre}amount differs` };
    return { status: 'DATE_DIFFERS', statusLabel: `${pre}date differs` };
  };
  switch (b.state) {
    case 'RECEIVED': return { status: 'READING', statusLabel: 'Reading…' };
    case 'READ_FAILED': return { status: 'COULDNT_READ', statusLabel: "Couldn't read" };
    case 'HELD': return { status: 'HELD', statusLabel: b.classification === 'REVISION_SAME_TERMS' ? 'Already received' : b.flags.includes('REMITTANCE_CHANGE') ? 'Held · payment details differ' : 'Held' };
    case 'TERMS_ACCEPTED': return { status: 'ACCEPTED', statusLabel: 'Accepted' };
    case 'SUPERSEDED': return { status: 'SUPERSEDED', statusLabel: 'Replaced by a revised copy' };
    case 'VERIFIED': return b.changedFields.length ? diff(true) : { status: 'VERIFIED', statusLabel: 'Verified · matches' };
    case 'PROPOSED':
      if (b.currencyBasis === 'BARE_DOLLAR') return { status: 'CONFIRM_CURRENCY', statusLabel: 'Confirm currency' };
      if (b.classification === 'AMBIGUOUS_COMMITMENT') return { status: 'CHOOSE_MATCH', statusLabel: 'Choose the payment' };
      if (b.classification === 'NEW_OBLIGATION_KNOWN_SUPPLIER') return { status: 'NEW_OBLIGATION', statusLabel: 'No matching commitment' };
      return b.changedFields.length ? diff(false) : { status: 'MATCHES', statusLabel: 'Matches' };
  }
}

const cmtName = (r: RunObligations, key: string | null) => { const p = key ? parseOccKey(key) : null; return p ? r.commitments.find((c) => c.commitmentId === p.commitmentId)?.name ?? null : null; };

export function billRow(r: RunObligations, b: BillItem): BillRow {
  const occ = b.occurrenceKey ? r.occurrences.find((o) => o.occurrenceKey === b.occurrenceKey) : undefined;
  const name = cmtName(r, b.occurrenceKey);
  const relationship = b.state === 'SUPERSEDED' ? `Replaced by a revised copy${b.supersededBy ? ` (${r.bills.find((x) => x.billId === b.supersededBy)?.fileName ?? 'later bill'})` : ''} · history only`
    : b.state === 'RECEIVED' ? 'Reading the document'
    : b.state === 'READ_FAILED' ? 'Not read · nothing in the forecast'
    : b.state === 'HELD' ? `Held · ${b.amount ? 'potential only, not in the forecast' : 'not in the forecast'}`
    : b.state === 'TERMS_ACCEPTED' ? (r.commitments.find((c) => c.commitmentId === `bill-${b.billId}`) ? 'New outflow · added by you' : `The bill for "${name}" · terms accepted`)
    : b.state === 'VERIFIED' ? `The bill for "${name}"${b.changedFields.length ? ` · forecast keeps ${occ ? dayName(occ.dueOn) : 'agreed terms'} until you decide` : ''}`
    : b.classification === 'AMBIGUOUS_COMMITMENT' ? `Could be ${b.candidates.length} payments · choose one`
    : b.classification === 'NEW_OBLIGATION_KNOWN_SUPPLIER' ? 'No commitment · not in the forecast unless you add it'
    : `Proposed match to "${name}"${occ ? ` · agreed ${dayName(occ.dueOn)}` : ''}`;
  return {
    billId: b.billId, ref: b.billNumber, supplierName: supplierLabel(r, b), amount: b.amount, printedTotal: b.printedTotal, dueOn: b.dueOn, operativeDueOn: occ?.dueOn ?? null,
    state: b.state, ...status(b), relationship, source: b.source, receivedAt: b.receivedAt, version: b.version,
  };
}

const occView = (r: RunObligations, o: Occurrence) => {
  const c = r.commitments.find((x) => x.commitmentId === o.commitmentId)!;
  return { occurrenceKey: o.occurrenceKey, version: o.version, commitmentName: c.name, dueOn: o.dueOn, amount: o.amount, reference: c.reference, basis: o.substantiatedBy ? 'BILL' as const : 'COMMITMENT' as const, alreadyBilled: !!o.substantiatedBy };
};

export function billDetail(f: ForecastModel, b: BillItem, audit: ActivityRow[]): BillDetail {
  const r = f.r;
  const row = billRow(r, b);
  const supplier = supplierLabel(r, b) ?? 'Unknown supplier';
  const sup = r.suppliers.find((s) => s.supplierId === b.supplierId);
  const occ = b.occurrenceKey ? r.occurrences.find((o) => o.occurrenceKey === b.occurrenceKey) : undefined;
  const cmt = occ ? r.commitments.find((c) => c.commitmentId === occ.commitmentId) : undefined;
  const ref = b.billNumber ?? b.fileName;
  const bare = b.currencyBasis === 'BARE_DOLLAR' && b.state === 'PROPOSED';
  const unknown = bare ? 'Only "$" is printed: confirm the currency first' : f.noOpeningReason;
  const ch = pending(b) || (b.state === 'PROPOSED' && b.classification === 'NEW_OBLIGATION_KNOWN_SUPPLIER') ? billChange(b) : null;
  const operative = impactOf(f.days && f.summary ? { days: f.days, summary: f.summary } : null, f.noOpeningReason, b.dueOn);
  const ifAccepted = ch ? impactOf(f.withChange(ch), unknown, b.dueOn) : bare && b.occurrenceKey ? { state: 'UNKNOWN' as const, reason: unknown } : null;

  const checks: BillDetail['checks'] = [];
  if (b.state !== 'RECEIVED' && b.state !== 'READ_FAILED') {
    checks.push(sup ? { key: 'supplier', result: 'OK', label: `Supplier: ${sup.displayName}`, detail: null }
      : { key: 'supplier', result: 'HELD', label: b.classification === 'AMBIGUOUS_SUPPLIER' ? 'Supplier unclear' : 'Unknown supplier', detail: b.supplierName ? `The bill says "${b.supplierName}"` : null });
    if (occ && cmt && b.dueOn) {
      const amt = b.amount?.minor ?? b.printedMinor;
      checks.push(amt === null ? { key: 'amount', result: 'UNKNOWN', label: 'Amount not read', detail: null }
        : amt === occ.amount.minor ? { key: 'amount', result: bare ? 'UNKNOWN' : 'OK', label: `Amount matches · ${money(amt)} = "${cmt.name}"`, detail: bare ? 'Only "$" is printed; confirm US dollars' : null }
        : { key: 'amount', result: 'DIFFERS', label: 'Amount differs', detail: `agreed ${money(occ.amount.minor)} · bill asks ${money(amt)}` });
      checks.push(cmt.reference && (b.reference === cmt.reference || b.billNumber === cmt.reference) ? { key: 'reference', result: 'OK', label: `Reference: ${cmt.reference}`, detail: null }
        : { key: 'reference', result: 'UNKNOWN', label: 'No matching reference', detail: cmt.reference ? `"${cmt.name}" is ${cmt.reference}` : null });
      checks.push(b.dueOn === occ.dueOn ? { key: 'date', result: 'OK', label: `Payment date matches · ${dayName(occ.dueOn)}`, detail: null }
        : { key: 'date', result: 'DIFFERS', label: 'Payment date differs', detail: `agreed ${dayName(occ.dueOn)} · bill requests ${dayName(b.dueOn)}` });
    }
    if (sup?.verifiedRemittanceLast4) checks.push(!b.remittanceLast4 ? { key: 'remittance', result: 'UNKNOWN', label: 'Payment details not printed', detail: null }
      : b.flags.includes('REMITTANCE_CHANGE') ? { key: 'remittance', result: 'HELD', label: 'Payment details differ', detail: `bill: account ending ${b.remittanceLast4} · verified: ending ${sup.verifiedRemittanceLast4}. Confirm with ${sup.displayName} by phone; a document alone never changes them` }
      : { key: 'remittance', result: 'OK', label: `Payment details match (ending ${b.remittanceLast4})`, detail: null });
    if (b.flags.includes('UNTRUSTED_INSTRUCTION_TEXT')) checks.push({ key: 'instructions', result: 'HELD', label: 'Contains instructions', detail: 'The document tells someone to do something (e.g. mark paid or pay elsewhere). Headroom ignored it' });
  }

  const pendingVerified = b.state === 'VERIFIED' && occ && b.proposedTerms && b.changedFields.length;
  const tHash = pendingVerified ? termsHash(occ, b.changedFields, { dueOn: b.proposedTerms!.dueOn, amountMinor: b.proposedTerms!.amount.minor }, b.documentSha256) : null;
  const sepMinor = b.amount?.minor ?? b.printedMinor;
  const canSeparate = b.state === 'PROPOSED' && !!b.supplierId && !!b.dueOn && sepMinor !== null && b.classification !== 'REVISION_CHANGED_TERMS';
  const label = b.changedFields.length === 2 ? 'Accept new date and amount…' : b.changedFields[0] === 'amount' ? 'Accept new amount…' : 'Accept new date…';
  const askDate = occ ? dayName(occ.dueOn) : '';
  const headline = b.state === 'RECEIVED' ? `Reading ${b.fileName}…`
    : b.state === 'READ_FAILED' ? `Couldn't read ${b.fileName}`
    : occ && b.dueOn && b.changedFields.includes('dueOn') ? `${supplier} billed ${ref} for ${dayName(b.dueOn)}. Your forecast had ${dayName(occ.dueOn)}.`
    : occ && b.changedFields.includes('amount') && b.amount ? `${supplier} billed ${ref} for ${money(b.amount.minor)}. Your forecast had ${money(occ.amount.minor)}.`
    : `${supplier} · bill ${ref}`;
  const allow = (allowed: boolean, reason: string | null, l: string) => ({ allowed, reason: allowed ? null : reason, label: l });
  return {
    bill: row, headline, classification: (b.classification as BillDetail['classification']) ?? null, flags: b.flags as BillDetail['flags'], holdReasons: b.holdReasons, readFailure: b.readFailure,
    checks,
    note: occ && b.state !== 'HELD' && b.state !== 'TERMS_ACCEPTED' ? `One obligation${b.changedFields.length ? ' with conflicting terms' : ''}, not two outflows. Receiving the bill doesn't change the agreement${b.changedFields.length ? `: the forecast keeps ${b.changedFields.includes('dueOn') ? dayName(occ.dueOn) : money(occ.amount.minor)} until you accept a change` : ''}.` : null,
    fields: (b.fields ?? []) as BillDetail['fields'],
    currencyBasis: b.currencyBasis,
    document: { sha256: b.documentSha256, fileName: b.fileName, bytes: b.bytes, source: b.source, receivedAt: b.receivedAt },
    occurrence: occ ? occView(r, occ) : null,
    proposedTerms: b.proposedTerms, changedFields: b.changedFields, termsHash: tHash,
    separateTermsHash: canSeparate ? separateHash(b.billId, b.dueOn!, sepMinor!, b.documentSha256) : null,
    impact: { operative, ifAccepted, ifAdded: !canSeparate ? null : addChange(b) ? impactOf(f.withChange(addChange(b)!), unknown, b.dueOn) : { state: 'UNKNOWN', reason: unknown } },
    candidates: b.state === 'PROPOSED' && b.classification === 'AMBIGUOUS_COMMITMENT'
      ? b.candidates.flatMap((k) => { const o = r.occurrences.find((x) => x.occurrenceKey === k); if (!o) return []; const c = billChange(b, k); return [{ ...occView(r, o), ifSelected: c ? impactOf(f.withChange(c), unknown, b.dueOn) : { state: 'UNKNOWN' as const, reason: unknown } }]; })
      : [],
    actions: {
      verify: allow(b.state === 'PROPOSED' && b.candidates.length > 0, b.state === 'HELD' ? 'Held: see the reasons above' : b.state === 'PROPOSED' ? 'This bill matches no commitment' : b.state === 'RECEIVED' ? 'Still reading' : 'Already verified', 'Verify bill…'),
      acceptTerms: allow(!!pendingVerified, b.state === 'PROPOSED' && b.changedFields.length ? 'Verify the bill first' : 'Nothing to accept', label),
      addSeparate: allow(canSeparate, b.supplierId ? 'Only for a proposed bill with a grounded amount and date' : 'Only for a known supplier', 'Add as a separate obligation…'),
      askSupplier: allow(false, 'Headroom proposes this ask on the Plan when the new date causes the shortfall; approve it there', occ && b.changedFields.includes('dueOn') ? `Ask ${supplier} to keep ${askDate}` : `Ask ${supplier}`),
      retry: allow(b.state === 'READ_FAILED', 'Only after a read failed', 'Read again'),
      compare: allow(!!ch && !!f.opening && !!b.amount, 'No comparison for this bill', 'Compare in forecast'),
    },
    extraction: r.models.filter((m) => m.billId === b.billId).sort((a, z) => (a.sk < z.sk ? -1 : 1))
      .map((m) => ({ k: m.k, generation: m.generation, state: m.state, modelId: m.modelId, inputTokens: m.inputTokens, outputTokens: m.outputTokens, latencyMs: m.latencyMs, at: m.dispatchedAt })),
    verification: ((v) => (v ? { by: v.by, at: v.at, currencyAttested: v.currencyAttested ?? null } : null))(r.verifications.find((v) => v.billId === b.billId)),
    acceptance: ((t) => (t ? { by: t.by, at: t.at, kind: t.kind, changedFields: t.changedFields } : null))(r.terms.find((t) => t.billId === b.billId)),
    asks: [], // S7 R6: filled by read/models.ts getBill (needs plan actions and mail)
    audit: audit.filter((a) => a.refs.billId === b.billId),
  };
}

// ---------- forecast DTO ----------
export function notInForecastRows(f: ForecastModel, undatedInvoices: { invoiceId: string; label: string; minor: number }[]): ResponseOf<'getForecast'>['notInForecast'] {
  const rows = f.notInForecast.map((n) => ({ key: n.key, label: n.label, amount: n.amountMinor === null ? null : usd(n.amountMinor), reason: n.reason, ref: n.ref }));
  for (const i of undatedInvoices) rows.push({ key: `inv:${i.invoiceId}`, label: i.label, amount: usd(i.minor), reason: 'Owed to you, no reliable payment date yet', ref: null });
  for (const b of f.r.bills) {
    const ref = { kind: 'BILL' as const, id: b.billId };
    const label = `${supplierLabel(f.r, b) ?? 'Unknown sender'} · ${b.billNumber ?? b.fileName}`;
    if (b.state === 'HELD' && b.classification !== 'REVISION_SAME_TERMS') rows.push({ key: `bill:${b.billId}`, label, amount: b.amount, reason: `Held: ${b.holdReasons[0] ?? 'needs checking'} · potential only`, ref });
    else if (pending(b)) rows.push({ key: `bill:${b.billId}`, label, amount: b.amount, reason: b.changedFields.includes('dueOn') ? 'Requested date not accepted' : 'Requested amount not accepted', ref });
    else if (b.state === 'PROPOSED' && (b.classification === 'NEW_OBLIGATION_KNOWN_SUPPLIER' || b.classification === 'AMBIGUOUS_COMMITMENT' || b.currencyBasis === 'BARE_DOLLAR'))
      rows.push({ key: `bill:${b.billId}`, label, amount: b.amount, reason: b.classification === 'NEW_OBLIGATION_KNOWN_SUPPLIER' ? 'New bill, not added' : b.currencyBasis === 'BARE_DOLLAR' ? 'Currency not confirmed' : 'Payment not chosen yet', ref });
  }
  return rows;
}

type ReadyForecast = Extract<ResponseOf<'getForecast'>, { state: 'READY' }>;
/** S4: a scenario other than Expected replaces the series; extra comparisons (before-bill, proposals) and the overlaid one are added. */
export interface ForecastExtra { scenario: ReadyForecast['scenario']; scenarioBasis: string; series?: { days: FDay[]; summary: FSummary }; comparisons: ReadyForecast['comparisons']; compare: string | null }
export function forecastDto(f: ForecastModel, basis: string, horizon: { from: LocalDate; to: LocalDate; days: 42 }, undated: { invoiceId: string; label: string; minor: number }[], validUntil: string | null, extra?: ForecastExtra): ResponseOf<'getForecast'> {
  const notInForecast = notInForecastRows(f, undated);
  if (!f.opening || !f.days || !f.summary) return { state: 'NO_OPENING', horizon, reason: f.noOpeningReason, notInForecast, validUntil };
  const series = extra?.series ?? { days: f.days, summary: f.summary };
  const days = series.days.map((d) => ({
    on: d.on, opening: signed(d.openingMinor), in: usd(d.inMinor), out: usd(d.outMinor), close: signed(d.closeMinor), state: d.state, sameDay: d.sameDay,
    items: d.items.map((i) => ({ key: i.key, on: i.on, direction: i.direction, amount: usd(i.amountMinor), feeEstimate: i.feeMinor ? usd(i.feeMinor) : null, basis: i.basis, label: i.label, provenance: i.provenance, ref: i.ref, note: i.note })),
  }));
  const comparisons = f.r.bills.filter(pending).flatMap((b) => {
    const ch = billChange(b);
    const w = ch && f.withChange(ch);
    return w ? [{ id: `bill:${b.billId}`, kind: 'BILL' as const, billId: b.billId, revisionId: null, linked: null, label: `If you accept ${b.billNumber ?? 'this bill'}`, builtBy: 'HEADROOM' as const, reason: `${supplierLabel(f.r, b)} asks for ${b.changedFields.map((x) => (x === 'dueOn' ? dayName(b.dueOn!) : money(b.amount!.minor))).join(' and ')}`, closes: w.days.map((d) => ({ on: d.on, close: signed(d.closeMinor) })), summary: summaryDto(w.summary) }] : [];
  });
  const o = f.opening;
  return {
    state: 'READY', horizon, scenario: extra?.scenario ?? 'EXPECTED', scenarioBasis: extra?.scenarioBasis ?? 'Expected · accepted terms and stated dates; nothing Headroom is aiming for', basis,
    opening: { amount: signed(o.amountMinor), paypalLower: signed(o.paypalLowerMinor), bank: o.bankMinor === null ? null : signed(o.bankMinor), paypalAsOf: o.paypalAsOf, bankReadAt: o.bankReadAt },
    reserve: usd(f.reserveMinor), days, summary: summaryDto(series.summary), notInForecast, comparisons: [...comparisons, ...(extra?.comparisons ?? [])], compare: extra?.compare ?? null, validUntil,
  };
}

// ---------- overview ----------
/** D-DUE-OUT: obligation amounts (no fees) of scheduled outflows in the horizon, including past-due ones on day 0. */
export function billsDue(f: ForecastModel) {
  const end = addDays(f.today, 41);
  // UX audit F17: a payment PayPal confirmed as paid is no longer due.
  const due = f.r.occurrences.filter((o) => o.dueOn <= end && (o as { payment?: { stage: string } }).payment?.stage !== 'PAID');
  return { sum: usd(due.reduce((a, o) => a + o.amount.minor, 0)), count: due.length };
}

/** D-NEEDS for bills: ranked by deadline, then amount. */
export function needs(f: ForecastModel): NeedRow[] {
  const rows: (NeedRow & { rank: string })[] = [];
  for (const b of f.r.bills) {
    const sup = supplierLabel(f.r, b) ?? 'Unknown sender';
    const ref = b.billNumber ?? b.fileName;
    const occ = b.occurrenceKey ? f.r.occurrences.find((o) => o.occurrenceKey === b.occurrenceKey) : undefined;
    const ch = pending(b) ? billChange(b) : null;
    const w = ch ? f.withChange(ch) : null;
    const gap = w && w.summary.reserveGapMinor > 0 ? ` Accepting it leaves you ${money(w.summary.reserveGapMinor)} below your reserve at the low.` : '';
    const add = (title: string, reason: string, label: string) => rows.push({ key: `bill:${b.billId}`, title, reason, where: `Payables · Bills · ${ref}`, amount: b.amount, deadline: b.dueOn, action: { label, to: { kind: 'BILL', billId: b.billId } }, rank: `${b.dueOn ?? '9999'}#${String(1e12 - (b.amount?.minor ?? 0)).padStart(13, '0')}` });
    if (b.state === 'READ_FAILED') add(`Couldn't read ${b.fileName}`, `${b.readFailure ?? 'Reading failed'}. Nothing was guessed.`, 'Read again');
    else if (b.state === 'HELD' && b.classification !== 'REVISION_SAME_TERMS')
      add(b.flags.includes('REMITTANCE_CHANGE') ? `Confirm ${sup}'s payment details` : `${sup}'s bill ${ref} is held`, b.flags.includes('REMITTANCE_CHANGE') ? `The bill asks to pay a different account. Confirm by phone, not from the document. Nothing paid.` : `${b.holdReasons[0] ?? 'Needs checking'}. Not in the forecast.`, 'Open bill');
    else if (b.state === 'PROPOSED' && b.currencyBasis === 'BARE_DOLLAR') add(`Confirm ${ref}'s currency`, 'Only "$" is printed. Headroom needs you to confirm US dollars before using the amount.', 'Check bill');
    else if (b.state === 'PROPOSED' && b.classification === 'AMBIGUOUS_COMMITMENT') add(`Which payment is ${sup}'s ${ref} for?`, `It could match ${b.candidates.length} scheduled payments. Nothing changes until you choose.`, 'Choose');
    else if (b.state === 'PROPOSED' && b.classification === 'NEW_OBLIGATION_KNOWN_SUPPLIER') add(`${sup} sent ${ref}, which matches no commitment`, `Not in the forecast unless you add it.`, 'Check bill');
    else if (b.state === 'PROPOSED' && occ) add(b.changedFields.includes('dueOn') && b.dueOn && b.dueOn < occ.dueOn ? `${sup}'s bill is earlier than your forecast` : b.changedFields.length ? `${sup}'s bill differs from your forecast` : `Check ${sup}'s bill ${ref}`,
      b.changedFields.length ? `Due ${dayName(b.dueOn!)}; forecast had ${dayName(occ.dueOn)}.${gap} Nothing paid yet.` : 'It matches the commitment. Verify it to link it.', b.changedFields.length ? 'Review impact' : 'Check bill');
    else if (b.state === 'VERIFIED' && b.changedFields.length) add(`Decide on ${ref} ${b.changedFields.length === 2 ? 'date and amount' : b.changedFields[0] === 'dueOn' ? 'date' : 'amount'}`, `Verified. The forecast keeps the agreed terms until you accept.${gap}`, 'Decide');
  }
  return rows.sort((a, z) => (a.rank < z.rank ? -1 : 1)).map(({ rank: _r, ...x }) => x);
}

/** UI-OV-08: a pending bill change (the most consequential), else a reserve breach in the operative forecast. */
export function alertOf(f: ForecastModel, cashNow: { minor: number } | null): ResponseOf<'getOverview'>['alert'] {
  // A bare-"$" bill has no amount until the owner confirms the currency (S3-IM-06): it raises its own "Confirm currency" need, not
  // an alert built on an amount that doesn't exist yet.
  const cand = f.r.bills.filter((b) => pending(b) && b.amount !== null).map((b) => ({ b, w: billChange(b) && f.withChange(billChange(b)!) })).sort((a, z) => (z.w?.summary.reserveGapMinor ?? 0) - (a.w?.summary.reserveGapMinor ?? 0))[0];
  if (cand) {
    const { b, w } = cand;
    const occ = f.r.occurrences.find((o) => o.occurrenceKey === b.occurrenceKey)!;
    const sup = supplierLabel(f.r, b) ?? 'A supplier';
    const ref = b.billNumber ?? 'a bill';
    const earlier = b.changedFields.includes('dueOn') && b.dueOn! < occ.dueOn;
    const what = b.changedFields.includes('dueOn') ? `for ${dayName(b.dueOn!)}. Your forecast had ${dayName(occ.dueOn)}.` : `for ${money(b.amount!.minor)}. Your forecast had ${money(occ.amount.minor)}.`;
    const keeps = b.changedFields.includes('dueOn') ? dayName(occ.dueOn) : 'the agreed amount';
    return {
      kind: 'BILL_TERMS_DIFFER', kicker: `${b.state === 'VERIFIED' ? 'Verified bill' : 'New bill'} · ${earlier ? 'earlier than' : 'differs from'} your forecast`,
      headline: `${sup} billed ${ref} ${what}`,
      body: w ? `${w.summary.reserveGapMinor > 0 ? `If you accept it, you'd be ${money(w.summary.reserveGapMinor)} below your reserve at the low point (${dayName(w.summary.lowOn)}). ` : 'Accepting it keeps you above your reserve. '}Nothing has been paid, and the forecast keeps ${keeps} until you decide.`
        : `Cash impact unknown: ${f.noOpeningReason}. Nothing has been paid, and the forecast keeps ${keeps} until you decide.`,
      impact: w ? { state: 'KNOWN', cashNow: cashNow ? signed(cashNow.minor) : null, low: signed(w.summary.lowMinor), lowOn: w.summary.lowOn, needed: usd(w.summary.reserveGapMinor) } : { state: 'UNKNOWN', reason: f.noOpeningReason },
      cta: { label: 'Review impact', to: { kind: 'BILL', billId: b.billId } },
    };
  }
  const s = f.summary;
  if (s?.firstBelowReserve) return {
    kind: 'RESERVE_GAP', kicker: 'Needs you · below your reserve', headline: `Cash falls below your reserve on ${dayName(s.firstBelowReserve)}.`,
    body: `The lowest point is ${money(s.lowMinor)} on ${dayName(s.lowOn)}: ${money(s.reserveGapMinor)} below your reserve${s.fundingDeficitMinor ? ` (${money(s.fundingDeficitMinor)} short of zero)` : ''}. Headroom can build a plan to close it; nothing runs until you approve. Nothing has been paid.`,
    impact: { state: 'KNOWN', cashNow: cashNow ? signed(cashNow.minor) : null, low: signed(s.lowMinor), lowOn: s.lowOn, needed: usd(s.reserveGapMinor) },
    cta: { label: 'Review plan', to: { kind: 'PLAN' } },
  };
  return null;
}

// ---------- payables, inbox ----------
export function payables(f: ForecastModel, horizon: { from: LocalDate; to: LocalDate; days: 42 }): ResponseOf<'listPayables'> {
  const r = f.r;
  const end = addDays(f.today, 41);
  const byCmt = new Map(r.commitments.map((c) => [c.commitmentId, c]));
  const fmt = (x: { dueOn: string; amount: { minor: number } }, k: string) => (k === 'dueOn' ? x.dueOn : money(x.amount.minor));
  const seen = new Set<string>();
  const obligations = r.occurrences.sort((a, z) => (a.dueOn < z.dueOn ? -1 : 1)).filter((o) => {
    // Every occurrence in the horizon, plus each commitment's next one after it.
    if (o.dueOn <= end) return true;
    if (seen.has(o.commitmentId)) return false;
    seen.add(o.commitmentId);
    return true;
  }).map((o) => {
    const c = byCmt.get(o.commitmentId)!;
    const bill = o.substantiatedBy ? r.bills.find((b) => b.billId === o.substantiatedBy) : undefined;
    return {
      occurrenceKey: o.occurrenceKey, commitmentId: c.commitmentId, name: c.name, supplierName: r.suppliers.find((s) => s.supplierId === c.supplierId)?.displayName ?? null,
      dueOn: o.dueOn, amount: o.amount, feeEstimate: c.rail === 'PAYPAL_PAYOUT' ? usd(payoutFeeEstimateMinor(o.amount.minor)) : null, rail: c.rail, protected: c.protected, estimate: c.estimate, provenance: c.provenance,
      billApproved: bill && bill.state !== 'PROPOSED' ? bill.billNumber ?? bill.fileName : null, substantiatedBy: o.substantiatedBy ?? null,
      pastDue: o.dueOn < f.today && !o.payment, afterHorizon: o.dueOn > end, termsVersion: r.stored.get(o.occurrenceKey)?.termsVersion ?? 0, payout: null,
      history: r.terms.filter((t) => t.occurrenceKey === o.occurrenceKey).map((t) => ({ at: t.at, changedFields: t.changedFields, before: t.before ? t.changedFields.map((k: string) => fmt(t.before, k)).join(', ') : '—', after: t.changedFields.length ? t.changedFields.map((k: string) => fmt(t.after, k)).join(', ') : `${t.after.dueOn}, ${money(t.after.amount.minor)}`, billId: t.billId })),
    };
  });
  const commitments = r.commitments.map((c) => {
    const occs = r.occurrences.filter((o) => o.commitmentId === c.commitmentId);
    const next = occs.find((o) => o.dueOn >= f.today) ?? occs[0];
    const billed = occs.find((o) => o.substantiatedBy);
    const bill = billed && r.bills.find((b) => b.billId === billed.substantiatedBy);
    return {
      commitmentId: c.commitmentId, name: c.name, supplierName: r.suppliers.find((s) => s.supplierId === c.supplierId)?.displayName ?? null, reference: c.reference, amount: c.amount,
      nextOn: next?.dueOn ?? null, recurrence: c.schedule.kind, substantiation: bill ? `BILL ${bill.billNumber ?? bill.fileName}` : c.provenance === 'OWNER_ENTERED' ? 'OWNER-ENTERED' : c.provenance,
      provenance: c.provenance, protected: c.protected, estimate: c.estimate, afterHorizon: !!next && next.dueOn > end,
    };
  });
  return { horizon, obligations, bills: [...r.bills].sort((a, z) => z.receivedAt.localeCompare(a.receivedAt)).map((b) => billRow(r, b)), commitments };
}

export function inbox(r: RunObligations): Pick<ResponseOf<'getInbox'>, 'items' | 'note'> {
  return {
    items: [...r.bills].sort((a, z) => z.receivedAt.localeCompare(a.receivedAt)).map((b) => {
      const row = billRow(r, b);
      return { key: `bill:${b.billId}`, billId: b.billId, from: supplierLabel(r, b) ?? 'Unknown sender', source: b.source === 'OWNER_UPLOAD' ? 'Uploaded by you' : b.source === 'MAIL' ? 'By email' : 'Injected by operator · sandbox', title: `Bill ${b.billNumber ?? b.fileName}`, status: row.status, statusLabel: row.statusLabel, at: b.receivedAt };
    }),
    note: 'Messages Headroom sends or receives appear by customer; bills arrive by email, upload, or the sandbox operator.',
  };
}

export { summarize };
