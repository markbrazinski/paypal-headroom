// Read models (S01 T7), computed on each GET from the run partition + the connection's provider rows.
// ponytail: no projection tables. Ceiling: the 1 MB Query page once a run holds thousands of records;
// upgrade is projection items written in the same TX.
import type { ResponseOf, InvoiceRow, ReceiptRow, ActivityRow, Customer, ReportingRow, BalanceObservation, Money, SignedMoney, BankSource, BankBalanceObservation, Policy } from '@headroom/contracts';
import { valueOf } from '../domain/delegation/policy.ts';
import { K } from '../adapters/store/keys.ts';
import type { Item, Store } from '../adapters/store/port.ts';
import type { Config } from '../deps.ts';
import type { RunItem } from '../domain/identity-run/run.ts';
import { estimateCurrent, type EstimateResult, type Movement } from '../domain/cash-forecast/estimate.ts';
import { reserveCurrentlyMet, type LiquidSource } from '../domain/cash-forecast/current.ts';
import { grantStopped } from '../adapters/grant.ts';
import { bankBoundaries, bankSource, decodeProjection, validUntil } from '../domain/bank-mirror/bank.ts';
import { bankEffectOf, bindingOf, connOf } from '../domain/bank-mirror/connect.ts';
import { addMs } from '../domain/time.ts';
import { forecast42, HORIZON_DAYS } from '../domain/cash-forecast/forecast.ts';
import { pickSnapshot } from '../domain/paypal-mirror/observe.ts';
import { businessDate, addDays, HOUR } from '../domain/time.ts';
import { checksStopped } from '../jobs/worker.ts';
import type { InvItem } from '../domain/receivables/commands.ts';
import type { StatusItem } from '../domain/paypal-mirror/observe-balance.ts';
import type { EvidenceStore } from '../adapters/evidence-store/port.ts';
import { ApiError } from '../api-error.ts';
import { loadRun } from '../domain/obligations/load.ts';
import { dueObligationsMinor } from '../domain/obligations/obligations.ts';
import { loadBill } from '../domain/obligations/commands.ts';
import { alertOf, billDetail, billsDue, forecastDto, forecastModel, inbox, needs, payables, type ForecastExtra, type ForecastModel } from './s3.ts';
import { conservationText, invoiceProjection } from '../domain/receivables/claims.ts';

/** `role` / `view` (S7-D11, R10): from the verified Cognito groups claim and the user's own record; never from the request body. */
export interface ReadCtx { store: Store; config: Config; tenantId: string; run: RunItem; connectionId: string | null; email: string; now: string; evidence?: EvidenceStore; role?: 'OWNER' | 'JUDGE' | 'OPERATOR'; view?: 'MY_RUN' | 'SHOWCASE' }

const usd = (minor: number): Money => ({ currency: 'USD', minor });
const signed = (minor: number): SignedMoney => ({ currency: 'USD', minor });
const STALE_MS = 3 * HOUR;
const BASIS = 'PayPal only · no bank or bills yet';
const clock = (iso: string | null, tz: string) => (iso ? new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(new Date(iso)) : 'unknown');

async function runItems(c: ReadCtx) {
  const items = await c.store.query('core', K.run(c.tenantId, c.run.runId));
  const by = (p: string) => items.filter((i) => i.sk.startsWith(p));
  return { invoices: by('INV#') as InvItem[], customers: by('CUST#') as unknown as (Customer & Item)[], receipts: by('RCPT#'), allocations: by('ALLOC#') };
}

// ---------- cash (C-BAL-1 / C-CURRENT-1) ----------
interface CashState {
  snapshot: BalanceObservation | null;
  status: StatusItem | undefined;
  estimate: EstimateResult | null;
  refreshState: 'FRESH' | 'STALE' | 'FAILED' | 'NEVER';
  markers: Item[];
  refunds: Item[];
  /** S6: every payout reservation on this PayPal connection, any run or tenant (the money is the merchant's), own-intent excluded. */
  reservations: Item[];
}

/** S6 R1 own-intent exclusion: readiness for one occurrence builds the PayPal bounds without that occurrence's own reservation. */
export interface CashOpts { excludeOccurrence?: string; excludePaymentVersion?: number; merchantWide?: boolean }

/** S7 R1: the merchant's C-BAL-1 estimate across every tenant (the reset decides the rail from it). */
export async function merchantEstimate(d: { store: Store; config: Config; now: () => string }) {
  const s = await cashState({ store: d.store, config: d.config, tenantId: '*', run: { runId: '*' } as never, connectionId: d.config.connectionId, email: 'headroom', now: d.now(), evidence: undefined } as ReadCtx, { merchantWide: true });
  return { estimate: s.estimate, snapshot: s.snapshot };
}

async function cashState(c: ReadCtx, o: CashOpts = {}): Promise<CashState> {
  if (!c.connectionId || c.connectionId !== c.config.connectionId) return { snapshot: null, status: undefined, estimate: null, refreshState: 'NEVER', markers: [], refunds: [], reservations: [] };
  const all = await c.store.query('provider', K.conn(c.connectionId));
  const by = (p: string) => all.filter((i) => i.sk.startsWith(p));
  const snapshot = pickSnapshot(by('OBS#') as unknown as BalanceObservation[]);
  const status = all.find((i) => i.sk === 'STATUS') as StatusItem | undefined;
  const ids = new Set(snapshot?.rowIds ?? []);
  const rows = by('RPT#').filter((r) => ids.has(r.transactionId)) as unknown as ReportingRow[];
  // Only this tenant's own movements (S1-IR-01); merchant-level rows (balance, report) are the shared truth.
  // S7 R1: the reset machine reads the merchant as a whole (every tenant's movements on this connection).
  const markers = by('CAPTURE#').filter((m) => o.merchantWide || m.tenantId === c.tenantId);
  const refunds = by('REFUND#').filter((r) => o.merchantWide || r.tenantId === c.tenantId);
  const movements: Movement[] = [
    ...markers.map((m): Movement => ({ kind: 'CAPTURE', key: `capture:${m.captureId}`, runId: m.runId, captureId: m.captureId, invoiceNumber: m.invoiceNumber, grossMinor: m.grossMinor, feeMinor: m.feeMinor, netMinor: m.netMinor, settledAt: m.capturedAt, reversalDetected: m.reversalDetected, captureStatus: m.lastStatus })),
    ...refunds.map((r): Movement => ({ kind: 'REFUND', key: `refund:${r.transactionId}`, runId: r.runId ?? null, captureId: r.captureId, transactionId: r.transactionId, amountMinor: r.amount.minor, settledAt: r.at })),
  ];
  // Only this payment version's own unsent reservation (S6-IM-02): an earlier version's debit, or one kept after a failure, still counts.
  const own = (r: Item) => r.tenantId === c.tenantId && r.runId === c.run.runId && r.occurrenceKey === o.excludeOccurrence && r.state === 'ACTIVE' && !r.inFlight && !r.finalNotPaid && String(r.effectKey).includes(`:v${o.excludePaymentVersion ?? 0}:`);
  const reservations = by('RESV#').filter((r) => r.state !== 'RELEASED' && !own(r));
  // A reservation's payout rows count from PayPal's report as soon as the snapshot covers them, even if older than this snapshot's row window.
  const rpt = by('RPT#');
  const txns = new Set(reservations.map((v) => v.transactionId).filter(Boolean));
  const holdIds = new Set(rpt.filter((r) => txns.has(r.transactionId)).map((r) => r.paypalReferenceId).filter(Boolean));
  const resvRows = rpt.filter((r) => !ids.has(r.transactionId) && (txns.has(r.transactionId) || holdIds.has(r.transactionId) || holdIds.has(r.paypalReferenceId))) as unknown as ReportingRow[];
  const estimate = snapshot ? estimateCurrent(snapshot, [...rows, ...resvRows], movements, reservations as never) : null;
  const failedSince = !!status && !status.ok; // STATUS is the latest attempt
  const refreshState = failedSince ? 'FAILED' : !snapshot ? 'NEVER' : Date.parse(c.now) - Date.parse(snapshot.reportedAsOf!) > STALE_MS ? 'STALE' : 'FRESH';
  return { snapshot, status, estimate, refreshState, markers, refunds, reservations };
}

// ---------- bank (S02 T4) ----------
/** The run's bank source, from its own CONN#plaid only (no client-supplied provider id, T8). */
async function bankState(c: ReadCtx): Promise<BankSource> {
  const today = businessDate(c.now, c.run.settings.timeZone);
  const stopped = await grantStopped(c.store, c.config.grant, 'plaid', 'calls', c.now);
  const checksStopped = stopped && `Bank not being checked: ${stopped}`;
  const binding = await bindingOf(c.store, c.tenantId, c.run.runId);
  if (!binding) return bankSource({ checksStopped, today }, c.now);
  const found = binding.itemId ? await connOf(c.store, binding.itemId) : undefined;
  const item = found && found.tenantId === c.tenantId ? found : undefined;
  const effect = !item ? await bankEffectOf(c.store, binding.effectKey) : item.state === 'DISCONNECTING' ? await bankEffectOf(c.store, `bankrm#${item.itemId}`) : undefined;
  if (!item) return bankSource({ binding, effect, checksStopped, today }, c.now);
  const [status, obs, accounts, txns] = await Promise.all([
    c.store.get('provider', item.pk, 'STATUS'),
    c.store.query('provider', item.pk, { skPrefix: 'OBS#', newestFirst: true, limit: 1 }),
    c.store.get('provider', item.pk, 'ACCOUNTS'),
    c.store.get('provider', item.pk, 'TXNS'),
  ]);
  return bankSource({
    binding, item, effect, checksStopped, today, status: status as never, obs: obs[0] as unknown as BankBalanceObservation | undefined, accounts: accounts?.accounts,
    txns: txns ? { projection: decodeProjection(txns as never), syncedAt: txns.syncedAt ?? null, updateStatus: txns.updateStatus ?? null } : undefined,
  }, c.now);
}

/** The bank's contribution to every company figure (total, estimate, forecast opening): null — never 0 — when it contributes nothing (S2-PR-04). */
const bankPart = (b: BankSource) => (b.state !== 'NOT_CONNECTED' && b.contributes && b.counted ? b.counted.minor : null);

function bankLiquid(b: BankSource): LiquidSource {
  if (b.state === 'NOT_CONNECTED') return { name: 'Bank', connected: false, reportedAvailableMinor: null, lowerBoundMinor: null, unresolvedLines: 0, asOf: null, reconciliation: null, holds: [] };
  const why: Record<string, string> = { SYNCING: 'Bank still syncing', RECONNECT_REQUIRED: 'Bank needs reconnecting', DISCONNECTING: 'Bank removal pending', REVOKED: 'Bank connection ended', DISCONNECTED: 'Bank disconnected' };
  return {
    name: 'Bank', connected: b.state === 'HEALTHY', notConnectedReason: why[b.state],
    reportedAvailableMinor: b.counted?.minor ?? null, lowerBoundMinor: b.counted?.minor ?? null, unresolvedLines: 0,
    // S2-D4: a provider as-of only when Plaid supplies one; otherwise a REALTIME read's fetch time, used only for the recency test.
    asOf: b.providerAsOf ?? (b.readKind === 'REALTIME' ? b.retrievedAt : null),
    reconciliation: 'NOT_APPLICABLE', holds: [],
  };
}

/** Wording from the same effective bank part the arithmetic uses (S2-IM-05); a known 0 is included. */
function basisOf(c: ReadCtx, b: BankSource, hasObligations = false): string {
  const tail = hasObligations ? ' · commitments, bills you accepted, stated receipts' : ' · no bills yet';
  return basisCore(c, b).replace(' · no bills yet', tail);
}
function basisCore(c: ReadCtx, b: BankSource): string {
  if (b.state === 'NOT_CONNECTED') return BASIS;
  if (b.contributes && bankPart(b) === null) {
    const why = b.incomplete.length ? `${b.incomplete.join(', ')}: figure missing or refused` : 'no countable checking account';
    return `PayPal only · bank checking not counted (${why}) · no bills yet`;
  }
  if (!b.contributes) {
    const what = b.state === 'DISCONNECTING' ? 'bank removal pending' : b.state === 'SYNCING' ? 'bank still syncing' : b.state === 'REVOKED' ? 'bank connection ended' : 'bank disconnected';
    return `PayPal only · ${what}${b.retrievedAt ? ` (last bank read ${clock(b.retrievedAt, c.run.settings.timeZone)}, not counted)` : ''} · no bills yet`;
  }
  const note = b.state === 'RECONNECT_REQUIRED' ? ' · bank needs reconnecting' : b.freshness === 'FAILED' ? " · couldn't reach the bank on the last read" : b.freshness === 'STALE' ? ' · bank read over 3 h ago' : '';
  return `PayPal + bank checking${note} · no bills yet`;
}

/** The run's forecast (S3 T2): opening = PayPal C-BAL-1 lower bound + counted bank checking; null opening without a PayPal report (S1 rule). */
async function forecastFor(c: ReadCtx, s: CashState, bank: BankSource): Promise<ForecastModel> {
  const today = businessDate(c.now, c.run.settings.timeZone);
  const r = await loadRun(c.store, c.tenantId, c.run.runId, today);
  const est = s.estimate;
  const bk = bankPart(bank);
  const pending = capturedPendingMinor(est);
  const opening = est ? { amountMinor: est.lowerMinor + (bk ?? 0) + pending, paypalLowerMinor: est.lowerMinor, bankMinor: bk, paypalAsOf: s.snapshot?.reportedAsOf ?? null, bankReadAt: bk === null || bank.state === 'NOT_CONNECTED' ? null : bank.retrievedAt, capturedPendingMinor: pending } : null;
  // A stated date that belongs to a real invoice never counts more than the invoice still has open (S5: once paid, it's a receipt).
  const open = await openByInvoice(c);
  // S5-D20: a customer's dated promise (from an authorized reply) is an Expected-only inflow on its invoice; the newest per invoice.
  const promises = (await c.store.query('core', K.run(c.tenantId, c.run.runId), { skPrefix: 'PROMISE#' })).sort((a, z) => (a.at < z.at ? 1 : -1));
  const seen = new Set<string>();
  for (const p of promises) {
    if (p.beyondLimitDays && !p.acceptedBy) continue; // S7 ar.newDateDays: beyond the owner's limit → not counted until accepted
    if (seen.has(p.invoiceId)) continue;
    seen.add(p.invoiceId);
    r.inflows.push({ inflowId: `promise:${p.promiseId}`, label: 'Customer promise (not a receipt)', counterpartyName: null, on: p.on, amount: p.amount ?? { currency: 'USD', minor: open.get(p.invoiceId) ?? 0 }, basis: 'PROMISE', provenance: 'CUSTOMER_REPLY', invoiceId: p.invoiceId });
  }
  r.inflows = r.inflows.flatMap((i) => {
    const o = i.invoiceId ? open.get(i.invoiceId) : undefined;
    if (o === undefined || o >= i.amount.minor) return [i];
    return o > 0 ? [{ ...i, amount: { ...i.amount, minor: o } }] : [];
  });
  return forecastModel(r, today, await forecastRules(c), opening, 'No PayPal report yet, so there is no forecast');
}
/** S7-D5: the reserve and the protected set-aside come only from the run's Delegation policy (seeded at every reset). */
export async function forecastRules(c: Pick<ReadCtx, 'store' | 'tenantId' | 'run'>) {
  const p = (await c.store.get('core', K.run(c.tenantId, c.run.runId), 'POLICY')) as Policy | undefined;
  if (!p) throw new Error('Run has no Delegation policy');
  return { reserveMinor: valueOf<number>(p, 'cash.reserveMinor'), setAsideDays: valueOf<{ setAsideDays: number }>(p, 'cash.protectedPayments').setAsideDays };
}
/** S5-D6: net of captures after PayPal's as-of that PayPal hasn't confirmed COMPLETED (ELIGIBILITY_UNCONFIRMED): Expected counts it,
 *  labelled; Cash now and Downside don't. Confirmed captures (CONFIRMED_BY_CAPTURE, S7-B10) are already inside the lower figure. */
export const capturedPendingMinor = (est: EstimateResult | null) => (est ? est.lines.filter((l) => l.status === 'ELIGIBILITY_UNCONFIRMED' && l.netMinor > 0).reduce((t, l) => t + l.netMinor, 0) : 0);

/** S5-D3 collectible open per invoice of the run (projection from ALLOC# and CONCESSION#). */
export async function openByInvoice(c: Pick<ReadCtx, 'store' | 'tenantId' | 'run'>): Promise<Map<string, number>> {
  const items = await c.store.query('core', K.run(c.tenantId, c.run.runId));
  const allocs = items.filter((i) => i.sk.startsWith('ALLOC#'));
  const conc = items.filter((i) => i.sk.startsWith('CONCESSION#'));
  return new Map(items.filter((i) => i.sk.startsWith('INV#')).map((inv) => [inv.invoiceId as string,
    invoiceProjection(inv as never, { dueMinor: null, status: null }, null, allocs.filter((a) => a.invoiceId === inv.invoiceId) as never, conc.filter((x) => x.invoiceId === inv.invoiceId) as never).collectibleOpen.minor]));
}

/**
 * The C-SKIP-1 inputs from the same sources as Cash and the forecast (S5-D7). `blockers` are the estimate's own
 * (holds, reversal held out, reconciliation hold on a line); the caller adds refresh, bill, mail and lock blockers.
 */
export async function fundsInputs(c: ReadCtx, o: CashOpts = {}) {
  const [s, bank] = await Promise.all([cashState(c, o), bankState(c)]);
  const f = await forecastFor(c, s, bank);
  const est = s.estimate;
  const blockers = [
    // AT-F06 (S6 R1): a payout whose provider outcome isn't settled yet, on this connection, in any run.
    ...s.reservations.filter((r) => r.inFlight).map((r) => ({ code: 'PAYOUT_UNRESOLVED', text: 'A PayPal payout is unresolved', ref: r.effectKey as string })),
    ...(est?.holds ?? []).map((h) => ({ code: 'PAYPAL_HOLD', text: h, ref: null })),
    ...(est?.lines ?? []).filter((l) => l.status === 'HELD_OUT' || l.status === 'RECONCILIATION_HOLD').map((l) => ({ code: l.status === 'HELD_OUT' ? 'CAPTURE_REVERSAL' : 'RECONCILIATION_HOLD', text: l.reason, ref: l.key })),
  ];
  return {
    f, blockers,
    bank: { availableMinor: bankPart(bank), retrievedAt: bank.state === 'NOT_CONNECTED' ? null : bank.retrievedAt },
    paypal: { lowerMinor: est?.lowerMinor ?? null, spendableMinor: est?.spendableMinor ?? null, upperMinor: est?.upperMinor ?? null, capturedPendingMinor: capturedPendingMinor(est), asOf: s.snapshot?.reportedAsOf ?? null, fetchedAt: s.snapshot?.retrievedAt ?? null, reconciliation: est?.reconciliation ?? ('UNKNOWN' as const) },
    captureIds: s.markers.map((m) => m.captureId as string),
    estimate: est, reservations: s.reservations, bankSource: bank,
  };
}

/** S4: the run's operative forecast for plan builds, approvals and plan reads (same opening and movements as Cash). */
export async function runForecast(c: ReadCtx): Promise<ForecastModel> {
  const [s, bank] = await Promise.all([cashState(c), bankState(c)]);
  return forecastFor(c, s, bank);
}
const hasObligations = (f: ForecastModel) => f.r.commitments.length + f.r.inflows.length > 0;

function lowestPoint(c: ReadCtx, f: ForecastModel, bank: BankSource): ResponseOf<'getOverview'>['lowestPoint'] {
  const basis = basisOf(c, bank, hasObligations(f));
  if (!f.summary) return { low: null, on: null, vsReserve: 'UNKNOWN', label: 'No PayPal report yet', basis };
  const above = f.summary.lowMinor >= f.reserveMinor;
  return { low: signed(f.summary.lowMinor), on: f.summary.lowOn, vsReserve: above ? 'ABOVE' : 'BELOW', label: `Forecast ${above ? 'above' : 'below'} reserve under stated assumptions`, basis };
}

/** D-6 company figures: PayPal reported available + bank counted, each only where non-null and contributing. */
function totals(s: CashState, bank: BankSource) {
  const paypal = s.snapshot?.availableMinor ?? null;
  const bk = bankPart(bank);
  return {
    reportedAvailable: paypal === null && bk === null ? null : signed((paypal ?? 0) + (bk ?? 0)),
    parts: { paypal: paypal === null ? null : signed(paypal), bank: bk === null ? null : signed(bk) },
    estimate: s.estimate && { lower: signed(s.estimate.lowerMinor + (bk ?? 0)), upper: signed(s.estimate.upperMinor + (bk ?? 0)) },
  };
}

/** S2-PR-05: the earliest instant a time-derived field reads differently. No audit event is fabricated for elapsed time. */
function validUntilOf(c: ReadCtx, s: CashState, bank: BankSource) {
  const active = bank.state === 'SYNCING' || bank.state === 'HEALTHY' || bank.state === 'RECONNECT_REQUIRED';
  return validUntil([
    ...(active ? bankBoundaries(bank.retrievedAt) : []),
    s.snapshot?.reportedAsOf ? addMs(s.snapshot.reportedAsOf, STALE_MS + 1) : null,
    c.config.grant?.expiresAt ? addMs(c.config.grant.expiresAt, 1) : null,
    nextBusinessMidnight(c.now, c.run.settings.timeZone),
  ], c.now);
}

/** The rolling 42-day horizon changes at the business zone's midnight (S3 T2): the first instant whose business date differs. */
export function nextBusinessMidnight(now: string, tz: string): string {
  const d0 = businessDate(now, tz);
  let lo = Date.parse(now), hi = lo + 26 * HOUR;
  while (hi - lo > 1000) { const mid = Math.floor((lo + hi) / 2); if (businessDate(new Date(mid).toISOString(), tz) === d0) lo = mid; else hi = mid; }
  return new Date(Math.ceil(hi / 1000) * 1000).toISOString();
}

// Owner-facing estimate (cleanup, 1 Nov 2026): plain words, business-time clocks, no status codes or raw ids. The figures are unchanged.
const STATUS_WORDS: Record<string, string> = {
  INCLUDED: 'Already in PayPal\'s report', CONFIRMED_BY_CAPTURE: 'After the report · confirmed by PayPal, counted', ELIGIBILITY_UNCONFIRMED: 'After the report · upper figure only', SUBTRACTED: 'After the report · subtracted',
  HELD_OUT: 'Not counted · held', RECONCILIATION_HOLD: 'Not counted · figures differ from PayPal\'s report', OVERLAP_UNKNOWN: 'Not counted · can\'t place against the report',
};
const GROUP: Record<string, 'IN_REPORT' | 'CONFIRMED' | 'AFTER_REPORT' | 'SUBTRACTED' | 'NOT_COUNTED'> = { INCLUDED: 'IN_REPORT', CONFIRMED_BY_CAPTURE: 'CONFIRMED', ELIGIBILITY_UNCONFIRMED: 'AFTER_REPORT', SUBTRACTED: 'SUBTRACTED' };
const humanTimes = (s: string, tz: string) => s.replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, (iso) => clock(iso, tz));
function lineOut(c: ReadCtx, l: EstimateResult['lines'][number]) {
  const earlier = l.runId && l.runId !== c.run.runId ? ' · earlier sandbox run' : '';
  return { key: l.key, runId: l.runId, net: signed(l.netMinor), reason: `${STATUS_WORDS[l.status] ?? l.status}${earlier}${l.status === 'INCLUDED' ? '' : ` · ${humanTimes(l.reason, c.run.settings.timeZone)}`}` };
}
function estimateSummary(c: ReadCtx, est: EstimateResult, asOf: string | null) {
  const at = clock(asOf, c.run.settings.timeZone);
  const labels = { IN_REPORT: `Payments already in PayPal's ${at} report`, CONFIRMED: 'Payments PayPal confirmed after that report · counted now', AFTER_REPORT: 'Payments after that report · counted in the upper figure only', SUBTRACTED: 'Refunds after that report · subtracted from both figures', NOT_COUNTED: 'Not counted yet · waiting to match PayPal\'s report' } as const;
  const groups = new Map<keyof typeof labels, { count: number; net: number }>();
  for (const l of est.lines) { const g = GROUP[l.status] ?? 'NOT_COUNTED'; const x = groups.get(g) ?? { count: 0, net: 0 }; groups.set(g, { count: x.count + 1, net: x.net + l.netMinor }); }
  const summary = (Object.keys(labels) as (keyof typeof labels)[]).filter((g) => groups.has(g)).map((g) => ({ group: g, label: labels[g], count: groups.get(g)!.count, net: signed(groups.get(g)!.net) }));
  const pending = est.holds.filter((h) => h.startsWith('Pending PayPal row')).length;
  const heldAfter = est.holds.filter((h) => h.startsWith('Hold ')).length;
  const withheld = est.holds.find((h) => h.startsWith('PayPal withheld balance'));
  const earlier = est.lines.filter((l) => l.runId && l.runId !== c.run.runId).length;
  const notes = [
    ...(est.reconciliation === 'PASS' ? [] : [`PayPal's figures don't fully reconcile yet (${est.reconciliation === 'HOLD' ? 'they differ from its running balance' : 'not enough report rows'}), so the range is held wide`]),
    ...(pending ? [`${pending} PayPal transaction${pending === 1 ? ' is' : 's are'} still pending at PayPal and not counted`] : []),
    ...(heldAfter ? [`${heldAfter} PayPal hold${heldAfter === 1 ? '' : 's'} after the report time`] : []),
    ...(withheld ? [`PayPal is withholding ${money(Number(withheld.replace(/\D/g, '')))}`] : []),
    ...(earlier ? [`Includes ${earlier} sandbox test payment${earlier === 1 ? '' : 's'} from earlier sandbox runs on the shared PayPal merchant`] : []),
  ];
  return { summary, notes };
}
const money = (minor: number) => `$${(minor / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** S6 (UI-CA-01): each supplier payout on the connection, once: reserved (ceiling), paid awaiting the report, or in the report (0 left). */
function payoutLines(c: ReadCtx, s: CashState) {
  return (s.estimate?.payouts ?? []).map((p) => {
    const r = s.reservations.find((x) => x.effectKey === p.effectKey);
    const what = p.reported ? "Supplier payout · already in PayPal's report" : r?.finalNotPaid ? "Failed supplier payout · still subtracted until PayPal's report shows the money back" : r?.state === 'SETTLED' ? "Supplier payout · paid through PayPal · subtracted until PayPal's report shows it" : 'Supplier payout · reserved for PayPal · subtracted';
    return { key: `payout:${p.effectKey}`, runId: p.runId, net: signed(-p.residualLowerMinor), reason: `${what}${p.runId !== c.run.runId ? ' · earlier sandbox run' : ''}${p.mismatch ? ` · ${p.mismatch}` : ''}` };
  });
}

export async function getCashPosition(c: ReadCtx): Promise<ResponseOf<'getCashPosition'>> {
  const [s, bank] = await Promise.all([cashState(c), bankState(c)]);
  const f = await forecastFor(c, s, bank);
  const t = totals(s, bank);
  const est = s.estimate;
  const reported = s.snapshot && s.snapshot.availableMinor !== null ? signed(s.snapshot.availableMinor) : null;
  const reserve = { currency: 'USD' as const, minor: f.reserveMinor };
  const stopped = await checksStopped({ ...c, now: () => c.now });
  const badge = reserveCurrentlyMet([
    {
      name: 'PayPal', connected: !!c.connectionId, reportedAvailableMinor: s.snapshot?.availableMinor ?? null, lowerBoundMinor: est?.lowerMinor ?? null,
      unresolvedLines: est?.lines.filter((l) => ['RECONCILIATION_HOLD', 'OVERLAP_UNKNOWN', 'HELD_OUT'].includes(l.status)).length ?? 0,
      asOf: s.snapshot?.reportedAsOf ?? null, reconciliation: est?.reconciliation ?? null, holds: est?.holds ?? [],
    },
    bankLiquid(bank),
  ], reserve.minor, c.now, dueObligationsMinor(f.r.commitments, f.r.occurrences, f.today)); // S3-PR-04: due unpaid obligations
  const diff = t.reportedAvailable ? t.reportedAvailable.minor - reserve.minor : null;
  const today = businessDate(c.now, c.run.settings.timeZone);
  return {
    horizon: { from: today, to: addDays(today, HORIZON_DAYS - 1), days: 42 },
    sources: [
      {
        kind: 'PAYPAL', reportedAvailable: reported, asOf: s.snapshot?.reportedAsOf ?? null, retrievedAt: s.snapshot?.retrievedAt ?? null,
        refreshState: s.refreshState, lastError: s.status?.ok === false ? s.status.lastError : null, checksStopped: stopped,
        estimate: est && {
          lower: signed(est.lowerMinor), upper: signed(est.upperMinor), reconciliation: est.reconciliation, coverage: est.coverage,
          included: [...est.lines.filter((l) => ['INCLUDED', 'CONFIRMED_BY_CAPTURE', 'ELIGIBILITY_UNCONFIRMED', 'SUBTRACTED'].includes(l.status)).map((l) => lineOut(c, l)), ...payoutLines(c, s)],
          excluded: est.lines.filter((l) => !['INCLUDED', 'CONFIRMED_BY_CAPTURE', 'ELIGIBILITY_UNCONFIRMED', 'SUBTRACTED'].includes(l.status)).map((l) => lineOut(c, l)),
          ...estimateSummary(c, est, s.snapshot?.reportedAsOf ?? null),
          holds: est.reconciliation === 'PASS' ? est.holds : [`Reconciliation ${est.reconciliation}: ${est.reconciliationReason}`, ...est.holds],
        },
      },
      bank,
    ],
    reserve: { amount: reserve, basis: 'SEEDED' },
    ledger: { reportedMinusReserve: diff === null ? null : signed(diff), asOf: s.snapshot?.reportedAsOf ?? null, vsReserve: diff === null ? 'UNKNOWN' : diff >= 0 ? 'ABOVE' : 'BELOW' },
    currentBadge: badge,
    lowestPoint: lowestPoint(c, f, bank),
    totals: t,
    validUntil: validUntilOf(c, s, bank),
  };
}

// ---------- receivables ----------
function inclusion(est: EstimateResult | null, captureId: string): Pick<ReceiptRow, 'inReportedBalance' | 'inclusionReason'> {
  if (!est) return { inReportedBalance: 'UNKNOWN', inclusionReason: 'No PayPal report yet' };
  const l = est.lines.find((x) => x.key === `capture:${captureId}`);
  if (!l) return { inReportedBalance: 'UNKNOWN', inclusionReason: 'Not evaluated' };
  if (l.status === 'INCLUDED') return { inReportedBalance: 'INCLUDED', inclusionReason: null };
  if (l.status === 'ELIGIBILITY_UNCONFIRMED' || l.status === 'CONFIRMED_BY_CAPTURE') return { inReportedBalance: 'NOT_YET', inclusionReason: l.reason };
  return { inReportedBalance: 'UNKNOWN', inclusionReason: l.reason };
}

function receiptRow(r: Item, s: CashState, customerName: string): Omit<ReceiptRow, 'allocations'> {
  const m = s.markers.find((x) => x.captureId === r.captureId);
  return {
    captureId: r.captureId, invoiceId: r.invoiceId, invoiceNumber: r.invoiceNumber, ppInvoiceId: r.ppInvoiceId, customerName, runId: r.runId,
    capturedAt: r.capturedAt, retrievedAt: r.retrievedAt, gross: r.gross, fee: r.fee, net: r.net,
    ...inclusion(s.estimate, r.captureId), reportAsOf: s.snapshot?.reportedAsOf ?? null,
    reversalDetected: !!(m?.reversalDetected ?? r.reversalDetected),
    refunds: s.refunds.filter((x) => x.captureId === r.captureId).map((x) => ({ transactionId: x.transactionId, amount: x.amount, at: x.at })),
    refundsCheckedAt: m?.lastReadAt ?? null,
  };
}

export function invoiceRow(inv: InvItem, customerName: string, eff: Item | undefined, stopped: string | null, poll?: Item): InvoiceRow {
  const polled = ['ISSUED', 'PARTIALLY_PAID', 'PAID'].includes(inv.state);
  // Same rule as checkingShown in jobs/worker.ts, which audits each change so open screens refresh (S1-IM-04).
  const failing = polled && !stopped && poll?.lastError && poll.attempts >= 3 ? `Couldn't reach PayPal on the last ${poll.attempts} checks (${poll.lastError}) · still retrying` : null;
  return {
    invoiceId: inv.invoiceId, invoiceNumber: inv.invoiceNumber, customerId: inv.customerId, customerName, issuedAt: inv.issuedAt ?? null,
    dueOn: inv.dueOn, amount: inv.amount, open: inv.openGross, state: inv.state, effectState: eff?.state ?? null, waitingReason: eff?.waitingReason ?? null,
    hold: inv.hold?.reason ?? null,
    checking: { state: !polled ? 'DONE' : stopped ? 'STOPPED' : failing ? 'FAILING' : 'ACTIVE', reason: polled ? stopped ?? failing : null, lastCheckedAt: inv.lastCheckedAt },
    expected: { basis: 'UNDATED' }, version: inv.version,
  };
}

const effectOf = (c: ReadCtx, inv: InvItem) => (inv.invoiceNumber ? c.store.get('work', K.effect(inv.invoiceNumber), 'EFFECT') : Promise.resolve(undefined));
const pollOf = (c: ReadCtx, inv: InvItem) => (inv.ppInvoiceId ? c.store.get('work', K.job(`poll#${inv.invoiceId}`), 'JOB') : Promise.resolve(undefined));

export async function listReceivables(c: ReadCtx): Promise<ResponseOf<'listReceivables'>> {
  const [r, s, stopped] = await Promise.all([runItems(c), cashState(c), checksStopped({ ...c, now: () => c.now })]);
  const name = (id: string) => r.customers.find((x) => x.customerId === id)?.displayName ?? id;
  const invoices = await Promise.all(r.invoices.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(async (i) => invoiceRow(i, name(i.customerId), await effectOf(c, i), stopped, await pollOf(c, i))));
  const byInvoice = new Map(r.invoices.map((i) => [i.invoiceId, i]));
  const { workRows } = await import('./s5.ts');
  return {
    ...(await workRows(c)),
    invoices,
    incoming: r.receipts.sort((a, b) => b.capturedAt.localeCompare(a.capturedAt)).map((x) => ({ ...receiptRow(x, s, name(byInvoice.get(x.invoiceId)?.customerId ?? '')), allocations: allocsOf(r.allocations, x.captureId) })),
    customers: r.customers.map(({ customerId, displayName, billingEmail, basis }) => ({ customerId, displayName, billingEmail, basis })),
    population: { total: invoices.length, open: invoices.filter((i) => i.state === 'ISSUED' || i.state === 'PARTIALLY_PAID').length },
  };
}

// S7-R36: refund reversals are negative ALLOC rows; projections sum them, lists show only the original allocations.
const allocsOf = (all: Item[], captureId: string) => all.filter((a) => a.captureId === captureId && !a.reversalOf).map((a) => ({ claim: (a.claim ?? 'WHOLE') as 'WHOLE' | 'UNDISPUTED' | 'DISPUTED' | 'UNALLOCATED', gross: a.amount }));

/** S5-D3 projection beside PayPal's due, and the partial-payment setting verified on PayPal (the ENABLE_PARTIAL effect's own GET). */
async function projectionOf(c: ReadCtx, inv: InvItem, allocations: Item[]) {
  if (!inv.ppInvoiceId) return { projection: null, partialPayment: null };
  const pk = K.run(c.tenantId, c.run.runId);
  const [claim, concs, effs] = await Promise.all([c.store.get('core', pk, `CLAIM#${inv.invoiceId}`), c.store.query('core', pk, { skPrefix: `CONCESSION#${inv.invoiceId}#` }), c.store.query('core', pk, { skPrefix: 'ACT#' })]);
  const p = invoiceProjection(inv, { dueMinor: (inv as { providerDueMinor?: number | null }).providerDueMinor ?? null, status: inv.providerStatus }, (claim as never) ?? null, allocations.filter((a) => a.invoiceId === inv.invoiceId) as never, concs as never);
  const slice = effs.find((a) => (a.kind === 'COLLECT_UNDISPUTED_SLICE' || a.kind === 'COLLECT_DISPUTED') && a.subject?.invoiceId === inv.invoiceId && ['APPLIED', 'COMPLETED'].includes(a.state));
  const eff = slice ? await c.store.get('work', `EFFECT#upd:${slice.rootId}:${slice.intentVersion}:ENABLE_PARTIAL`, 'EFFECT') : undefined;
  const stored = (inv as { conservation?: 'PASS' | 'HOLD' | 'UNKNOWN' }).conservation;
  return {
    projection: { ...p, conservation: stored ?? p.conservation, text: (stored ?? p.conservation) === 'HOLD' ? conservationText(p) : null },
    partialPayment: eff?.state === 'VERIFIED_SUCCESS' ? { minimum: usd(eff.target.minimumMinor), verifiedAt: eff.updatedAt } : null,
  };
}

export async function getInvoice(c: ReadCtx, inv: InvItem): Promise<ResponseOf<'getInvoice'>> {
  const [r, s, stopped, eff, audit, poll] = await Promise.all([runItems(c), cashState(c), checksStopped({ ...c, now: () => c.now }), effectOf(c, inv), activityRows(c, 200), pollOf(c, inv)]);
  const name = r.customers.find((x) => x.customerId === inv.customerId)?.displayName ?? inv.customerId;
  return {
    invoice: invoiceRow(inv, name, eff, stopped, poll),
    ppInvoiceId: inv.ppInvoiceId, providerStatus: inv.providerStatus, payerUrl: inv.payerUrl, failureReason: inv.failureReason,
    effect: eff ? { effectKey: eff.effectKey, state: eff.state, failureReason: eff.failureReason ?? null, updatedAt: eff.updatedAt } : null,
    ownerAssertions: inv.ownerAssertions,
    receipts: r.receipts.filter((x) => x.invoiceId === inv.invoiceId).map((x) => ({ ...receiptRow(x, s, name), allocations: allocsOf(r.allocations, x.captureId) })),
    allocations: r.allocations.filter((a) => a.invoiceId === inv.invoiceId && !a.reversalOf).map((a) => ({ captureId: a.captureId, amount: a.amount, at: a.at, claim: a.claim ?? 'WHOLE' })),
    audit: audit.filter((a) => a.refs.invoiceId === inv.invoiceId),
    ...(await projectionOf(c, inv, r.allocations)),
    ...(await disputeOf(c, inv)),
  };
}

/** S7 R4/R5: the dispute waiting for the owner on this invoice, and the consumed disputed-collection allowance. */
async function disputeOf(c: ReadCtx, inv: InvItem): Promise<Pick<ResponseOf<'getInvoice'>, 'dispute' | 'disputedAllowance'>> {
  const pk = K.run(c.tenantId, c.run.runId);
  const [pend, allow] = await Promise.all([c.store.get('core', pk, `DISPUTEPENDING#${inv.invoiceId}`), c.store.get('core', pk, `DISPALLOW#${inv.invoiceId}`)]);
  const disputedAllowance = allow ? { allowed: usd(allow.allowedMinor), used: usd(allow.usedMinor) } : null;
  if (pend?.state !== 'PENDING') return { dispute: null, disputedAllowance };
  const [p, m] = await Promise.all([c.store.get('core', pk, `PROPOSAL#${inv.invoiceId}#${pend.messageId}`), c.store.get('core', pk, `MAIL#${pend.messageId}`)]);
  return {
    disputedAllowance,
    dispute: p ? { proposalId: p.proposalId, from: String(m?.from ?? ''), subject: String(m?.subject ?? ''), receivedAt: String(m?.receivedAt ?? p.at), quote: p.quote, ...(inv.openGross.minor === p.openMinor ? { disputed: p.disputed, undisputed: p.undisputed, derived: p.derived } : { disputed: null, undisputed: null, derived: null }), openMinor: inv.openGross.minor, invoiceVersion: inv.version } : null,
  };
}

// ---------- overview, activity, session ----------
const EVENT_LABELS: Record<string, string> = {
  InvoiceDraftSaved: 'Invoice draft saved', InvoiceIssueRequested: 'Issue on PayPal requested', EffectDispatchClaimed: 'Sending to PayPal',
  EffectRunFenced: 'Not issued: run was reset', InvoiceIssued: 'Invoice issued on PayPal', InvoiceIssueFailed: 'Invoice not issued',
  EffectOutcomeUnknown: 'Checking with PayPal', EffectReconciled: 'Confirmed with PayPal', InvoiceCaptureVerified: 'Payment verified',
  ReceiptAllocated: 'Receipt allocated', ReceiptReversalDetected: 'Refund or reversal detected', ReceiptRefundObserved: 'Refund recorded',
  OwnerAssertionObserved: 'Recorded payment seen (not cash)', ReconciliationHold: 'Held for reconciliation', PayPalBalanceObserved: 'PayPal balance read',
  PayPalObservationRejected: 'PayPal balance not used', PayPalCallBudgetReached: 'PayPal call budget reached', WebhookVerified: 'PayPal notification verified',
  WebhookQuarantined: 'PayPal notification quarantined', RunReset: 'Run started', OldRunEventRouted: 'Event routed to an earlier run', InvoiceCheckingChanged: 'PayPal checking changed',
  BankConnectRequested: 'Bank connection requested', BankConnected: 'Bank connected', BankConnectFailed: 'Bank not connected', BankConnectAbandoned: 'Bank connection abandoned',
  BankSeeded: 'Sample bank added', BankSeedFailed: 'Sample bank not added', BankTransactionsSynced: 'Bank activity synced', BankBalanceObserved: 'Bank balance read',
  BankObservationFailed: "Couldn't read the bank", BankHealthChanged: 'Bank connection changed', BankReconnected: 'Bank reconnected', BankDisconnectRequested: 'Bank disconnect requested',
  BankDisconnected: 'Bank disconnected', BankEffectOutcomeUnknown: 'Checking with Plaid', PlaidCallBudgetReached: 'Plaid call budget reached', RunReadinessChanged: 'Run readiness',
  ObligationsSeeded: 'Sample commitments added', IngestionReceived: 'Document received', DuplicateDocumentReceived: 'Duplicate document', DocumentUnreadable: "Document couldn't be read",
  BillFieldsExtracted: 'Bill read', BillExtractionFailed: "Bill couldn't be read", BillMatchProposed: 'Bill matched', BillHeld: 'Bill held', BillVerified: 'Bill verified',
  BillTermsAccepted: 'Bill terms accepted', CommitmentAdded: 'Commitment added', ModelCallBudgetReached: 'Model budget reached', BillRetryRequested: 'Reading bill again',
  // S4–S7 (UX audit F08): plain words for every event a filmed run produces. Reservation is never described as payment.
  PlanBuildRequested: 'Plan requested', PlanRevisionBuilt: 'Plan revision ready', PlanRevisionApproved: 'Plan approved', PlanRevisionRejected: 'Plan revision rejected',
  PlanRevisionEdited: 'Plan changed by you', ActionQueued: 'Action started', ActionHeld: 'Action held', ActionDueSkipped: 'Scheduled step not run', OperatorRanActionEarly: 'Sandbox clock: next step run early',
  GrantRecorded: 'Permission recorded', GrantConsumed: 'Permission used', GrantLapsed: 'Permission lapsed', GrantRevoked: 'Permission revoked',
  MessageQueued: 'Message queued', MessageSent: 'Message sent', MessageHeld: 'Message held', MessageFailed: 'Message not sent', MessageSendUnknown: 'Checking whether a message was sent',
  MailReceived: 'Email received', FixtureMailSent: 'Test-inbox email sent', SenderHeld: 'Email held for review',
  InvoiceUpdated: 'PayPal invoice updated', InvoiceUpdateFailed: 'PayPal invoice not updated', InvoiceUpdateUnknown: 'Checking a PayPal invoice update', EffectConflict: 'Changed outside Headroom',
  OfferApplied: 'Discount offer applied on PayPal', OfferExpired: 'Discount offer ended', OfferRemovalHeld: 'Discount removal held', FallbackSkipped: 'Discount offer not needed', ConcessionRealized: 'Discount taken by the customer',
  UnallocatedGross: 'Payment beyond the undisputed part', ConservationHold: 'Held: invoice totals don’t add up',
  DisputeProposed: 'Possible dispute found in an email', DisputeConfirmed: 'Dispute confirmed by you', DisputeDismissed: 'Not a dispute (your decision)', DisputedCollectionAuthorized: 'You approved asking for a disputed amount',
  SupplierAnswerRecorded: 'Supplier replied', SupplierAnswerAccepted: 'Supplier’s answer accepted by you', SupplierAnswerDeclined: 'Supplier’s answer declined by you',
  PayoutReserved: 'Payout reserved on PayPal · not paid yet', PayoutChargeMoved: 'Payout limit day moved', PayoutDispatched: 'Payout sent to PayPal', PayoutSubmitted: 'PayPal accepted the payout · not paid yet',
  PayoutItemObserved: 'PayPal payout status', PayoutPaid: 'Supplier paid', PayoutNotPaid: 'Supplier not paid', PayoutRejected: 'PayPal refused the payout', PayoutUnknown: 'Checking a payout with PayPal',
  PayoutUnknownUnresolved: 'Payout outcome unknown', PayoutCancelledUnsent: 'Payout cancelled before sending', PayoutHeldReady: 'Payout held before sending', PayoutRefunded: 'Paid payout came back', PayoutBatchAttached: 'Operator attached a PayPal batch',
  PayeeSeeded: 'Sample supplier payment details added', PayeeConfirmed: 'Supplier payment details confirmed', PayeeRevealed: 'Supplier payment details shown',
  PolicyChanged: 'Delegation rule changed', PauseChanged: 'Pause changed', HeroReceivablesSeeded: 'Sample customers and invoices added', ModelOutputRefused: 'Headroom’s model answer not used',
  DemoClockAdvanced: 'Sandbox clock: next step run', DemoPayerSubmitted: 'Sandbox: customer paying on PayPal', DemoPayerVerified: 'Sandbox: customer payment verified',
};
/** Never render a raw event name: unknown PascalCase types read as a sentence ("PayoutChargeMoved" → "Payout charge moved"). */
export const eventLabel = (t: string) => EVENT_LABELS[t] ?? t.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/(?<= )[A-Z](?=[a-z])/g, (x) => x.toLowerCase());
const GRANT_WORDS: Record<string, string> = {
  COLLECT_SLICE: 'your permission to collect the undisputed part', MESSAGE_AS_WRITTEN: 'your approval of the message wording', DISCOUNT_OFFER: 'your one-time permission for the discount',
  PAYOUT_AUTHORITY: 'your payout authority', PAYOUT_EXCEPTION: 'your one-time exception to the payment limits', COLLECT_DISPUTED: 'your permission to ask for a disputed amount', CONTACT_SPACING: 'your one-time permission to contact early',
};
const money2 = (minor: number) => `$${(minor / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** Readable activity text (UX audit F08): grant ids → their names, ISO times/dates → business-local, bare cents after "available" → dollars. Raw ids stay in `refs`. */
export function readableText(text: string, tz: string): string {
  const time = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const date = (iso: string) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(`${iso}T00:00:00Z`));
  return text
    .replace(/(?:Your permission |Permission )?[\w-]+#\d+#[\w-]+#([A-Z_]+)/g, (_m, kind: string) => GRANT_WORDS[kind] ?? kind.toLowerCase().replace(/_/g, ' '))
    .replace(/ \+ your/g, ' and your').replace(/^your/, 'Your')
    .replace(/\(SEEDED ([a-z ]+)\)/g, '(sample $1)').replace(/ \((?:S\d+-[A-Z]*\d+[a-z]?)\)/g, '')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})/g, (iso) => time.format(new Date(iso)))
    .replace(/\b(\d{4}-\d{2}-\d{2})\b/g, (_m, iso: string) => date(iso))
    .replace(/(available(?: [a-z]+)?) (\d{3,})(, (\d{3,}))?\b/g, (_m, w: string, a: string, _b: string, b?: string) => `${w} ${money2(Number(a))}${b ? ` and ${money2(Number(b))}` : ''}`);
}
const BY: Record<string, string> = { OWNER: 'You', HEADROOM: 'Headroom', PAYPAL: 'PayPal', OPERATOR: 'Operator' };

export async function activityRows(c: ReadCtx, limit = 100): Promise<ActivityRow[]> {
  const rows = await c.store.query('audit', K.run(c.tenantId, c.run.runId), { newestFirst: true, limit });
  const tz = c.run.settings.timeZone;
  return rows.map((a) => ({ eventId: a.eventId, when: a.occurredAt, event: eventLabel(a.eventType), by: BY[a.by] ?? a.by, allowedBy: a.allowedBy && readableText(a.allowedBy, tz), result: readableText(a.result, tz), refs: a.refs }));
}

export async function getOverview(c: ReadCtx): Promise<ResponseOf<'getOverview'>> {
  const [r, s, activity, bank] = await Promise.all([runItems(c), cashState(c), activityRows(c, 8), bankState(c)]);
  const f = await forecastFor(c, s, bank);
  const t = totals(s, bank);
  const need = needs(f);
  const open = r.invoices.filter((i) => i.state === 'ISSUED' || i.state === 'PARTIALLY_PAID');
  const sum = usd(open.reduce((a, i) => a + i.openGross.minor, 0));
  const today = businessDate(c.now, c.run.settings.timeZone);
  const lp = lowestPoint(c, f, bank);
  return {
    horizon: { from: today, to: addDays(today, HORIZON_DAYS - 1), days: 42 },
    cashNow: {
      reportedAvailable: t.reportedAvailable,
      asOf: s.snapshot?.reportedAsOf ?? null, retrievedAt: s.snapshot?.retrievedAt ?? null, refreshState: s.refreshState,
      estimate: t.estimate, parts: t.parts,
      bank: bank.state === 'NOT_CONNECTED'
        ? { state: 'NOT_CONNECTED', contributes: false, counted: null, retrievedAt: null, freshness: 'NEVER', notCounted: [] }
        : {
          state: bank.state, contributes: bank.contributes, counted: bank.counted, retrievedAt: bank.retrievedAt, freshness: bank.freshness,
          notCounted: bank.accounts.filter((a) => a.role === 'NOT_COUNTED').map((a) => `${a.name}${a.mask ? ` ··${a.mask}` : ''} ${a.refusal === 'AVAILABILITY_NOT_REPORTED' ? 'availability not reported' : a.label.replace(' · not counted', '').toLowerCase()}`),
        },
    },
    owedToYou: { sum, count: open.length, undatedCount: open.filter((i) => !f.r.inflows.some((x) => x.invoiceId === i.invoiceId)).length },
    billsDue: billsDue(f),
    lowestPoint: lp,
    statusLine: lp.vsReserve === 'UNKNOWN' ? 'Waiting for a PayPal report before a forecast can be shown' : `${lp.label} · ${lp.basis}`,
    inProgress: { collecting: { count: open.length, sum } },
    needsCount: need.length,
    needs: need,
    alert: alertOf(f, t.reportedAvailable),
    plan: null, // S4: filled by read/s4.ts getOverview
    safetyNotices: [], // S7: filled by read/s4.ts getOverview
    activity,
    validUntil: validUntilOf(c, s, bank),
  };
}

export async function getSession(c: ReadCtx): Promise<ResponseOf<'getSession'>> {
  const [r, s, last, bank] = await Promise.all([runItems(c), cashState(c), c.store.query('audit', K.run(c.tenantId, c.run.runId), { newestFirst: true, limit: 1 }), bankState(c)]);
  const bankBusy = (bank.pendingEffect && bank.pendingEffect.kind !== 'CONNECT_FAILED' && !bank.pendingEffect.terminal)
    || (bank.state !== 'NOT_CONNECTED' && (bank.state === 'SYNCING' || bank.state === 'DISCONNECTING' || bank.historyLoading));
  const watching = r.invoices.some((i) => ['ISSUING', 'ISSUE_UNKNOWN', 'ISSUED', 'PARTIALLY_PAID'].includes(i.state))
    || r.receipts.some((x) => inclusion(s.estimate, x.captureId).inReportedBalance !== 'INCLUDED') || !!bankBusy
    || (await c.store.query('core', K.run(c.tenantId, c.run.runId), { skPrefix: 'BILL#' })).some((b) => b.state === 'RECEIVED');
  return {
    tenantName: c.run.settings.businessName, timeZone: c.run.settings.timeZone, businessToday: businessDate(c.now, c.run.settings.timeZone),
    run: { runId: c.run.runId, epoch: c.run.epoch, state: c.run.state, seeded: true },
    userEmail: c.email, lastChangeAt: last[0]?.occurredAt ?? null, watching, role: c.role ?? 'OWNER', view: c.view ?? 'MY_RUN',
    pauses: ((await c.store.get('core', K.run(c.tenantId, c.run.runId), 'POLICY'))?.pauses as { outreach: boolean; payments: boolean } | undefined) ?? { outreach: false, payments: false },
  };
}

// ---------- S3 (S03 T2, T6, T11) ----------
async function s3Base(c: ReadCtx) {
  const [s, bank] = await Promise.all([cashState(c), bankState(c)]);
  return { s, bank, f: await forecastFor(c, s, bank) };
}
const horizonOf = (c: ReadCtx) => { const today = businessDate(c.now, c.run.settings.timeZone); return { from: today, to: addDays(today, HORIZON_DAYS - 1), days: 42 as const }; };

export async function getForecast(c: ReadCtx, extra?: (f: ForecastModel) => Promise<ForecastExtra>): Promise<ResponseOf<'getForecast'>> {
  const [{ s, bank, f }, r] = await Promise.all([s3Base(c), runItems(c)]);
  const name = (id: string) => r.customers.find((x) => x.customerId === id)?.displayName ?? id;
  // An invoice with a stated date (S4-D5: Mercer) is counted through that inflow, so it isn't also listed as undated.
  const stated = new Set(f.r.inflows.flatMap((i) => (i.invoiceId ? [i.invoiceId] : [])));
  const undated = r.invoices.filter((i) => (i.state === 'ISSUED' || i.state === 'PARTIALLY_PAID') && !stated.has(i.invoiceId)).map((i) => ({ invoiceId: i.invoiceId, label: `${name(i.customerId)} · ${i.invoiceNumber ?? 'invoice'}`, minor: i.openGross.minor }));
  return forecastDto(f, basisOf(c, bank, hasObligations(f)), horizonOf(c), undated, validUntilOf(c, s, bank), extra ? await extra(f) : undefined);
}

export async function listPayables(c: ReadCtx): Promise<ResponseOf<'listPayables'>> {
  const { f } = await s3Base(c);
  return (await import('./s6.ts')).withPayouts(c, payables(f, horizonOf(c)));
}

export async function getBill(c: ReadCtx, billId: string): Promise<ResponseOf<'getBill'>> {
  const b = await loadBillForRead(c, billId);
  const [{ f }, audit] = await Promise.all([s3Base(c), activityRows(c, 300)]);
  const detail = billDetail(f, f.r.bills.find((x) => x.billId === b.billId) ?? b, audit);
  return { ...detail, asks: await asksFor(c, f, detail.bill.billId, b.occurrenceKey) };
}

/** S7 R6: the plan's asks to the supplier about this bill's payment and their answers, newest first. */
async function asksFor(c: ReadCtx, f: ForecastModel, billId: string, occurrenceKey: string | null): Promise<ResponseOf<'getBill'>['asks']> {
  if (!occurrenceKey) return [];
  const pk = K.run(c.tenantId, c.run.runId);
  const items = await c.store.query('core', pk);
  const acts = items.filter((i) => i.sk.startsWith('ACT#') && i.kind === 'ASK_SUPPLIER' && i.subject?.occurrenceKey === occurrenceKey && i.state !== 'SUPERSEDED' && i.state !== 'PROPOSED');
  const byRoot = new Map(acts.map((a) => [a.rootId, a]));
  const stored = f.r.stored.get(occurrenceKey);
  const bill = f.r.bills.find((x) => x.billId === billId);
  return [...byRoot.values()].map((a) => ({
    askId: a.rootId, status: String(a.heldReasons?.[0] ?? a.state).replace(/_/g, ' '), options: a.terms.askOptions ?? [], obligationVersion: stored?.version ?? 0, billVersion: bill?.version ?? 0,
    answers: items.filter((i) => i.sk.startsWith(`SUPPLIERANSWER#${a.rootId}#`)).map((x) => {
      const m = items.find((i) => i.sk === `MAIL#${x.messageId}`);
      return { answerId: x.answerId, intent: x.intent, quote: x.quote, matched: x.matched, state: x.state, from: String(m?.from ?? ''), receivedAt: String(m?.receivedAt ?? x.at) };
    }),
  }));
}

export async function getBillDocument(c: ReadCtx, billId: string): Promise<ResponseOf<'getBillDocument'>> {
  const b = await loadBillForRead(c, billId);
  const bytes = c.evidence ? await c.evidence.get(b.storageKey) : null;
  if (!bytes) throw new ApiError(404, 'NOT_FOUND', 'The original document is not available here');
  return { fileName: b.fileName, contentType: 'application/pdf', sha256: b.documentSha256, contentBase64: Buffer.from(bytes).toString('base64') };
}

export async function getInbox(c: ReadCtx): Promise<ResponseOf<'getInbox'>> {
  const { inboxThreads, mailStatus } = await import('./s5.ts');
  const [docs, threads, channel] = await Promise.all([loadRun(c.store, c.tenantId, c.run.runId, businessDate(c.now, c.run.settings.timeZone)).then(inbox), inboxThreads(c), mailStatus(c)]);
  return { ...docs, ...threads, channel };
}

/** Reads of an earlier run's bill answer NOT_FOUND here (the active run's screens only); commands answer RUN_SEALED. */
async function loadBillForRead(c: ReadCtx, id: string) {
  try { return await loadBill(c.store, c, id); }
  catch (e) { if (e instanceof ApiError && e.code === 'RUN_SEALED') throw new ApiError(404, 'NOT_FOUND', 'Bill is in an earlier run'); throw e; }
}
