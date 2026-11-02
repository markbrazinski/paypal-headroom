// C-API route table: the single source the backend router and the web client both import.
import { z } from 'zod';
import { ErrorCode, Id, LocalDate, Money, ProviderAmount, SignedMoney, UtcInstant } from './primitives.ts';
import { AllocationClaim, BankBasis, BillClassification, BillField, BillFlag, ChangedField, Citation, Customer, DocumentSource, GrantKind, OwnerAssertion, PlanAction, PlanCheck, PolicyDecision, PolicyKey, PolicyRule, PolicyValue, Provenance, Rail, RULE_VALUE, SupplierAskOption, Tier } from './records.ts';
import { PayoutEffectStates, OutMsgStates, ActionStates, BankConnectionStates, BankEffectStates, BillStates, EffectStates, GrantStates, InvoiceStates, PlanBuildStates, PlanRevisionStates, RunStates } from './states.ts';

export const RefreshState = z.enum(['FRESH', 'STALE', 'FAILED', 'NEVER']);
export const Inclusion = z.enum(['INCLUDED', 'NOT_YET', 'UNKNOWN']);

export const Checking = z.object({
  state: z.enum(['ACTIVE', 'FAILING', 'STOPPED', 'DONE']),
  reason: z.string().nullable(),
  lastCheckedAt: UtcInstant.nullable(),
});

export const InvoiceRow = z.object({
  invoiceId: Id,
  invoiceNumber: z.string().nullable(),
  customerId: Id,
  customerName: z.string(),
  issuedAt: UtcInstant.nullable(),
  dueOn: LocalDate,
  amount: Money,
  open: Money,
  state: z.enum(InvoiceStates),
  effectState: z.enum(EffectStates).nullable(),
  waitingReason: z.string().nullable(),
  hold: z.string().nullable(),
  checking: Checking,
  expected: z.object({ basis: z.literal('UNDATED') }),
  version: z.number().int(),
});
export type InvoiceRow = z.infer<typeof InvoiceRow>;

export const ReceiptRow = z.object({
  captureId: z.string(),
  invoiceId: Id,
  invoiceNumber: z.string(),
  ppInvoiceId: z.string(),
  customerName: z.string(),
  runId: Id,
  capturedAt: UtcInstant,
  retrievedAt: UtcInstant,
  gross: Money,
  fee: Money,
  net: Money,
  inReportedBalance: Inclusion,
  /** S5-D3: how the gross was allocated (undisputed first; the rest toward the disputed amount, not applied). */
  allocations: z.array(z.object({ claim: AllocationClaim, gross: Money })).default([]),
  inclusionReason: z.string().nullable(),
  reportAsOf: UtcInstant.nullable(),
  reversalDetected: z.boolean(),
  refunds: z.array(z.object({ transactionId: z.string(), amount: Money, at: UtcInstant })),
  refundsCheckedAt: UtcInstant.nullable(),
});
export type ReceiptRow = z.infer<typeof ReceiptRow>;

export const ActivityRow = z.object({
  eventId: Id,
  when: UtcInstant,
  event: z.string(),
  by: z.string(),
  allowedBy: z.string().nullable(),
  result: z.string(),
  refs: z.record(z.string(), z.string()),
});
export type ActivityRow = z.infer<typeof ActivityRow>;

export const MovementLine = z.object({ key: z.string(), runId: Id.nullable(), net: SignedMoney, reason: z.string() });
export const Estimate = z.object({
  lower: SignedMoney,
  upper: SignedMoney,
  reconciliation: z.enum(['PASS', 'UNKNOWN', 'HOLD']),
  coverage: z.enum(['COMPLETE', 'PARTIAL']),
  included: z.array(MovementLine),
  excluded: z.array(MovementLine),
  holds: z.array(z.string()),
  /** Owner-facing grouping of the lines, computed on the server (count and net per group). */
  summary: z.array(z.object({ group: z.enum(['IN_REPORT', 'CONFIRMED', 'AFTER_REPORT', 'SUBTRACTED', 'NOT_COUNTED']), label: z.string(), count: z.number().int(), net: SignedMoney })),
  /** Plain-language notes (pending rows, withholds, reconciliation, earlier demo runs); no raw ids or codes. */
  notes: z.array(z.string()),
});
export type Estimate = z.infer<typeof Estimate>;

export const PayPalSource = z.object({
  kind: z.literal('PAYPAL'),
  reportedAvailable: SignedMoney.nullable(),
  asOf: UtcInstant.nullable(),
  retrievedAt: UtcInstant.nullable(),
  refreshState: RefreshState,
  lastError: z.string().nullable(),
  checksStopped: z.string().nullable(),
  estimate: Estimate.nullable(),
});
export const BankFreshness = z.enum(['RECENT', 'AGING', 'STALE', 'FAILED', 'NEVER']);
export const AccountRole = z.enum(['COUNTED', 'NOT_COUNTED', 'OWED', 'NOT_CASH']);
export const Refusal = z.enum(['NOT_CHECKING', 'AVAILABILITY_NOT_REPORTED', 'PROVIDER_PRECISION', 'UNSUPPORTED_CURRENCY', 'UNKNOWN_CURRENCY', 'CREDIT_OWED', 'NOT_CASH']);
export const BankAccountRow = z.object({
  accountId: z.string(),
  name: z.string(),
  mask: z.string().nullable(),
  type: z.string(),
  subtype: z.string().nullable(),
  holderCategory: z.string().nullable(),
  role: AccountRole,
  label: z.string(),
  /** Exactly what the bank reported, each with its own currency (display only). */
  provider: z.object({ available: ProviderAmount.nullable(), current: ProviderAmount.nullable(), limit: ProviderAmount.nullable() }),
  /** Non-null only for COUNTED: USD minor units. */
  eligible: SignedMoney.nullable(),
  refusal: Refusal.nullable(),
  reason: z.string().nullable(),
  notReturned: z.boolean(),
});
export const BankActivityRow = z.object({
  transactionId: z.string(),
  accountMask: z.string().nullable(),
  date: LocalDate,
  description: z.string(),
  amount: SignedMoney.nullable(), // negative = money out
  pending: z.boolean(),
  paypalCandidate: z.boolean(),
});
export const BankPendingEffect = z.object({
  kind: z.enum(['CONNECTING', 'REMOVAL_PENDING', 'CONNECT_FAILED']),
  state: z.enum(BankEffectStates),
  reason: z.string().nullable(),
  canAbandon: z.boolean(),
  /** True when nothing is checking any more (terminal UNKNOWN), so the UI must not say 'in progress'. */
  terminal: z.boolean(),
  effectVersion: z.number().int(),
  institutionName: z.string().nullable(),
});
export const BankSource = z.union([
  z.object({ kind: z.literal('BANK'), state: z.literal('NOT_CONNECTED'), checksStopped: z.string().nullable(), pendingEffect: BankPendingEffect.nullable() }),
  z.object({
    kind: z.literal('BANK'),
    state: z.enum(BankConnectionStates),
    connection: z.object({ version: z.number().int(), institutionName: z.string().nullable(), basis: BankBasis, connectedAt: UtcInstant }),
    counted: SignedMoney.nullable(),
    incomplete: z.array(z.string()),
    /** False for DISCONNECTING, REVOKED and DISCONNECTED: their figures are history and count nowhere (S2-PR-04). */
    contributes: z.boolean(),
    notCountedReason: z.string().nullable(),
    retrievedAt: UtcInstant.nullable(),
    readKind: z.literal('REALTIME').nullable(),
    providerAsOf: z.string().nullable(),
    institutionDataAsOf: UtcInstant.nullable(),
    freshness: BankFreshness,
    lastError: z.string().nullable(),
    checksStopped: z.string().nullable(),
    historyLoading: z.boolean(),
    pendingEffect: BankPendingEffect.nullable(),
    accounts: z.array(BankAccountRow),
    activity: z.object({ rows: z.array(BankActivityRow), pendingCount: z.number().int(), hiddenSuperseded: z.number().int(), syncedAt: UtcInstant.nullable() }),
  }),
]);
export type BankSource = z.infer<typeof BankSource>;

export const CurrentBadge = z.object({ state: z.enum(['MET', 'NOT_MET', 'NOT_VERIFIABLE']), reasons: z.array(z.string()) });

export const LowestPoint = z.object({
  low: SignedMoney.nullable(),
  on: LocalDate.nullable(),
  vsReserve: z.enum(['ABOVE', 'BELOW', 'UNKNOWN']),
  label: z.string(),
  basis: z.string(),
});

export const Horizon = z.object({ from: LocalDate, to: LocalDate, days: z.literal(42) });

// ---------- S3 forecast (C-FUNDS; DATA-CONTRACT D-SERIES … D-COMPARE). Computed on the server only. ----------
export const DayState = z.enum(['ABOVE', 'AT', 'BELOW', 'NEGATIVE']);
export const ForecastBasis = z.enum(['COMMITMENT', 'BILL', 'STATED', 'PAST_DUE', 'TARGET', 'PROMISE']);
export const ItemRef = z.object({ kind: z.enum(['OBLIGATION', 'BILL', 'INFLOW', 'INVOICE']), id: z.string() });
export const ForecastItem = z.object({
  key: z.string(),
  on: LocalDate,
  direction: z.enum(['IN', 'OUT']),
  amount: Money,
  /** Estimated PayPal payout fee, shown separately; the obligation amount is unchanged (S3-D12). */
  feeEstimate: Money.nullable(),
  basis: ForecastBasis,
  label: z.string(),
  provenance: z.enum(['SEEDED', 'OWNER_ENTERED', 'DOCUMENT']),
  ref: ItemRef,
  note: z.string().nullable(),
});
export type ForecastItem = z.infer<typeof ForecastItem>;
export const ForecastDay = z.object({ on: LocalDate, opening: SignedMoney, in: Money, out: Money, close: SignedMoney, state: DayState, sameDay: z.boolean(), items: z.array(ForecastItem) });
export type ForecastDay = z.infer<typeof ForecastDay>;
export const ForecastSummary = z.object({
  low: SignedMoney,
  lowOn: LocalDate,
  negativeDays: z.number().int().nonnegative(),
  atReserveDays: z.number().int().nonnegative(),
  belowReserveDays: z.number().int().nonnegative(),
  firstBelowReserve: LocalDate.nullable(),
  /** D-RGAP max(0, reserve − low): the owner-facing shortfall. */
  reserveGap: Money,
  /** D-DEF max(0, −low): labelled differently from the gap. */
  fundingDeficit: Money,
});
export type ForecastSummary = z.infer<typeof ForecastSummary>;
/** S4: a bill's proposed terms (S3), the forecast before you accepted a bill, or a plan proposal's outlook row. Never persisted. */
export const Comparison = z.object({
  id: z.string(), kind: z.enum(['BILL', 'BEFORE_BILL', 'PROPOSAL']), billId: Id.nullable(), revisionId: Id.nullable(), label: z.string(), builtBy: z.literal('HEADROOM'), reason: z.string(),
  closes: z.array(z.object({ on: LocalDate, close: SignedMoney })).length(42), summary: ForecastSummary, linked: z.object({ label: z.string(), status: z.string() }).nullable(),
});
export const NotInForecastRow = z.object({ key: z.string(), label: z.string(), amount: Money.nullable(), reason: z.string(), ref: ItemRef.nullable() });
export const Forecast = z.discriminatedUnion('state', [
  z.object({ state: z.literal('NO_OPENING'), horizon: Horizon, reason: z.string(), notInForecast: z.array(NotInForecastRow), validUntil: UtcInstant.nullable() }),
  z.object({
    state: z.literal('READY'),
    horizon: Horizon,
    scenario: z.enum(['EXPECTED', 'IDEAL', 'DOWNSIDE']),
    /** Each scenario's named basis; there is no likelihood figure anywhere (IC-9). */
    scenarioBasis: z.string(),
    basis: z.string(),
    opening: z.object({ amount: SignedMoney, paypalLower: SignedMoney, bank: SignedMoney.nullable(), paypalAsOf: UtcInstant.nullable(), bankReadAt: UtcInstant.nullable() }),
    reserve: Money,
    days: z.array(ForecastDay).length(42),
    summary: ForecastSummary,
    notInForecast: z.array(NotInForecastRow),
    comparisons: z.array(Comparison),
    /** The comparison overlaid (`?compare=`), if any. */
    compare: z.string().nullable(),
    validUntil: UtcInstant.nullable(),
  }),
]);
export type Forecast = z.infer<typeof Forecast>;
export const ForecastQuery = z.object({ scenario: z.enum(['EXPECTED', 'IDEAL', 'DOWNSIDE']).default('EXPECTED'), compare: z.string().max(200).optional() }).strict();

/** Cash impact of a bill, or why it can't be known yet (S3-D16): never zero-filled. */
export const ImpactSummary = z.discriminatedUnion('state', [
  z.object({ state: z.literal('KNOWN'), summary: ForecastSummary, closeOnDue: z.object({ on: LocalDate, close: SignedMoney }).nullable() }),
  z.object({ state: z.literal('UNKNOWN'), reason: z.string() }),
]);
export type ImpactSummary = z.infer<typeof ImpactSummary>;
export const Impact = z.discriminatedUnion('state', [
  z.object({ state: z.literal('KNOWN'), cashNow: SignedMoney.nullable(), low: SignedMoney, lowOn: LocalDate, needed: Money }),
  z.object({ state: z.literal('UNKNOWN'), reason: z.string() }),
]);
export const Alert = z.object({
  kind: z.enum(['BILL_TERMS_DIFFER', 'RESERVE_GAP']),
  kicker: z.string(),
  headline: z.string(),
  body: z.string(),
  impact: Impact,
  cta: z.object({ label: z.string(), to: z.discriminatedUnion('kind', [z.object({ kind: z.literal('BILL'), billId: Id }), z.object({ kind: z.literal('CASH_DAY'), on: LocalDate }), z.object({ kind: z.literal('PLAN') })]) }),
});
export type Alert = z.infer<typeof Alert>;
export const NeedTarget = z.discriminatedUnion('kind', [z.object({ kind: z.literal('BILL'), billId: Id }), z.object({ kind: z.literal('INVOICE'), invoiceId: Id }), z.object({ kind: z.literal('PLAN') }), z.object({ kind: z.literal('GRANT'), grantId: z.string() }), z.object({ kind: z.literal('INBOX') }), z.object({ kind: z.literal('PAYOUT'), occurrenceKey: z.string() })]);
export const NeedRow = z.object({ key: z.string(), title: z.string(), reason: z.string(), where: z.string(), amount: Money.nullable(), deadline: LocalDate.nullable(), action: z.object({ label: z.string(), to: NeedTarget }) });
export type NeedRow = z.infer<typeof NeedRow>;

// ---------- S3 payables, bills, inbox ----------
export const BillStatus = z.enum(['READING', 'DATE_DIFFERS', 'AMOUNT_DIFFERS', 'TERMS_DIFFER', 'MATCHES', 'CHOOSE_MATCH', 'NEW_OBLIGATION', 'CONFIRM_CURRENCY', 'VERIFIED', 'ACCEPTED', 'HELD', 'COULDNT_READ', 'SUPERSEDED']);
export const BillRow = z.object({
  billId: Id,
  ref: z.string().nullable(),
  supplierName: z.string().nullable(),
  amount: Money.nullable(),
  printedTotal: z.string().nullable(),
  dueOn: LocalDate.nullable(),
  operativeDueOn: LocalDate.nullable(),
  state: z.enum(BillStates),
  status: BillStatus,
  statusLabel: z.string(),
  relationship: z.string(),
  source: DocumentSource,
  receivedAt: UtcInstant,
  version: z.number().int(),
});
export type BillRow = z.infer<typeof BillRow>;
/** S6-D4 pill order: PAID → NOT_PAID → UNKNOWN → SUBMITTED → PAUSED → HELD → FUNDED_NEEDS_APPROVAL → READY → NOT_DUE (+ WAITING, no plan action). */
export const PayoutPill = z.enum(['PAID', 'NOT_PAID', 'UNKNOWN', 'SUBMITTED', 'RESERVED', 'PAUSED', 'HELD', 'WAITING_FOR_REPORT', 'FUNDED_NEEDS_APPROVAL', 'READY', 'NOT_DUE', 'NO_PLAN']);
const Verdict = z.enum(['PASS', 'FAIL', 'HELD_EVIDENCE', 'UNKNOWN']);
/** S6 Keller panel (UI-AP-03/04/06): rail and company readiness kept separate, authority checks, and the payment result. Never the raw address. */
export const PayoutView = z.object({
  occurrenceKey: z.string(), supplier: z.object({ id: Id, name: z.string() }), name: z.string(), billRef: z.string().nullable(), billId: Id.nullable(),
  payee: z.object({ masked: z.string(), state: z.enum(['UNCONFIRMED', 'CONFIRMED']), version: z.number().int() }).nullable(),
  amount: Money, feeCeiling: Money, maxDebit: Money, feeEstimate: Money, payBy: LocalDate, pill: PayoutPill, pillText: z.string(), status: z.string(),
  readiness: z.object({
    checkedAt: UtcInstant,
    rail: z.object({ verdict: Verdict, lower: SignedMoney.nullable(), upper: SignedMoney.nullable(), need: Money, short: Money.nullable(), asOf: UtcInstant.nullable(), fetchedAt: UtcInstant.nullable(), otherReserved: Money,
      /** Usable = PayPal lower bound with other payouts already taken out; remainingAfter = usable − need (server-computed, UI-AP-03 ledger). */
      usable: SignedMoney.nullable(), remainingAfter: SignedMoney.nullable(), reasons: z.array(z.string()) }),
    company: z.object({ verdict: Verdict, min: z.object({ amount: SignedMoney, on: LocalDate }).nullable(), reserve: Money, reasons: z.array(z.string()) }),
    checks: z.array(z.object({ key: z.string(), ok: z.boolean(), text: z.string() })),
    notCounted: z.array(z.string()), toReady: z.array(z.string()),
  }).nullable(),
  action: z.object({ actionId: Id, revisionId: Id, revisionN: z.number().int(), state: z.enum(ActionStates) }).nullable(),
  effect: z.object({
    state: z.enum(PayoutEffectStates), senderBatchId: z.string(), batchId: z.string().nullable(), itemId: z.string().nullable(), itemStatus: z.string().nullable(),
    transactionId: z.string().nullable(), fee: Money.nullable(), timeProcessed: UtcInstant.nullable(), unknownSince: UtcInstant.nullable(), mutationDeadline: UtcInstant.nullable(),
    failure: z.string().nullable(), heldReason: z.string().nullable(), inReport: z.boolean(),
    timeline: z.array(z.object({ at: UtcInstant, event: z.string(), ref: z.string().nullable() })),
  }).nullable(),
});
export type PayoutView = z.infer<typeof PayoutView>;
export const ConfirmPayeeBody = z.object({ version: z.number().int().positive(), address: z.string().min(3).max(254) }).strict();

export const ObligationRow = z.object({
  occurrenceKey: z.string(),
  commitmentId: Id,
  name: z.string(),
  supplierName: z.string().nullable(),
  dueOn: LocalDate,
  amount: Money,
  feeEstimate: Money.nullable(),
  rail: Rail,
  protected: z.boolean(),
  estimate: z.boolean(),
  provenance: Provenance,
  billApproved: z.string().nullable(), // bill ref when a verified bill substantiates it
  substantiatedBy: Id.nullable(),
  pastDue: z.boolean(),
  afterHorizon: z.boolean(),
  termsVersion: z.number().int(),
  history: z.array(z.object({ at: UtcInstant, changedFields: z.array(ChangedField), before: z.string(), after: z.string(), billId: Id })),
  /** S6 (UI-AP-01): PayPal-payout obligations only. `pill` is the first that applies (S6-D4); `permission` is the winning authority in words. */
  payout: z.object({ pill: PayoutPill, pillText: z.string(), permission: z.string(), checkedAt: UtcInstant.nullable(), paidRef: z.string().nullable() }).nullable().default(null),
});
export type ObligationRow = z.infer<typeof ObligationRow>;
export const CommitmentRow = z.object({
  commitmentId: Id,
  name: z.string(),
  supplierName: z.string().nullable(),
  reference: z.string().nullable(),
  amount: Money,
  nextOn: LocalDate.nullable(),
  recurrence: z.enum(['ONCE', 'MONTHLY', 'DATES']),
  substantiation: z.string(),
  provenance: Provenance,
  protected: z.boolean(),
  estimate: z.boolean(),
  afterHorizon: z.boolean(),
});
export type CommitmentRow = z.infer<typeof CommitmentRow>;
export const Payables = z.object({ horizon: Horizon, obligations: z.array(ObligationRow), bills: z.array(BillRow), commitments: z.array(CommitmentRow) });

const Action = z.object({ allowed: z.boolean(), reason: z.string().nullable(), label: z.string() });
export const BillCheck = z.object({ key: z.string(), result: z.enum(['OK', 'DIFFERS', 'HELD', 'UNKNOWN']), label: z.string(), detail: z.string().nullable() });
export const OccurrenceView = z.object({ occurrenceKey: z.string(), version: z.number().int().nonnegative(), commitmentName: z.string(), dueOn: LocalDate, amount: Money, reference: z.string().nullable(), basis: z.enum(['COMMITMENT', 'BILL']), alreadyBilled: z.boolean() });
export const BillDetail = z.object({
  bill: BillRow,
  headline: z.string(),
  classification: BillClassification.nullable(),
  flags: z.array(BillFlag),
  holdReasons: z.array(z.string()),
  readFailure: z.string().nullable(),
  checks: z.array(BillCheck),
  note: z.string().nullable(),
  fields: z.array(BillField),
  currencyBasis: z.enum(['ISO', 'BARE_DOLLAR']).nullable(),
  document: z.object({ sha256: z.string(), fileName: z.string(), bytes: z.number().int(), source: DocumentSource, receivedAt: UtcInstant }),
  occurrence: OccurrenceView.nullable(),
  proposedTerms: z.object({ dueOn: LocalDate, amount: Money }).nullable(),
  changedFields: z.array(ChangedField),
  termsHash: z.string().nullable(),
  separateTermsHash: z.string().nullable(),
  /** ifAccepted: the bill's terms REPLACE its matched payment's. ifAdded: the bill is added as a SECOND outflow (separate obligation), the matched payment staying (S3-IM-01). */
  impact: z.object({ operative: ImpactSummary, ifAccepted: ImpactSummary.nullable(), ifAdded: ImpactSummary.nullable() }),
  candidates: z.array(OccurrenceView.extend({ ifSelected: ImpactSummary })),
  actions: z.object({ verify: Action, acceptTerms: Action, addSeparate: Action, askSupplier: Action, retry: Action, compare: Action }),
  extraction: z.array(z.object({ k: z.number().int(), generation: z.number().int(), state: z.string(), modelId: z.string(), inputTokens: z.number().int().nullable(), outputTokens: z.number().int().nullable(), latencyMs: z.number().int().nullable(), at: UtcInstant })),
  verification: z.object({ by: z.string(), at: UtcInstant, currencyAttested: z.string().nullable() }).nullable(),
  acceptance: z.object({ by: z.string(), at: UtcInstant, kind: z.string(), changedFields: z.array(ChangedField) }).nullable(),
  /** S7 R6: Headroom's asks to the supplier about this bill's payment, the code-made options, and each answer waiting for you. */
  asks: z.array(z.object({
    askId: z.string(), status: z.string(), options: z.array(SupplierAskOption), obligationVersion: z.number().int(), billVersion: z.number().int(),
    answers: z.array(z.object({ answerId: z.string(), intent: z.enum(['TERMS_AGREED', 'TERMS_COUNTER', 'TERMS_DECLINED', 'OTHER']), quote: z.string(), matched: z.enum(['KEEP', 'SPLIT']).nullable(), state: z.enum(['OPEN', 'ACCEPTED', 'DECLINED']), from: z.string(), receivedAt: UtcInstant })),
  })).default([]),
  audit: z.array(ActivityRow),
});
export type BillDetail = z.infer<typeof BillDetail>;
export const InboxItem = z.object({ key: z.string(), billId: Id, from: z.string(), source: z.string(), title: z.string(), status: BillStatus, statusLabel: z.string(), at: UtcInstant });
export const InboxEntry = z.object({
  key: z.string(), kind: z.enum(['DRAFT', 'OUT', 'IN']), at: UtcInstant.nullable(), subject: z.string(), label: z.string(), actionId: Id.nullable(),
  canSendNow: z.boolean(), canHold: z.boolean(), held: z.boolean(), needsYou: z.boolean(), detail: z.string().nullable(),
  /** S7: a promise past the owner's `ar.newDateDays` limit waits for "Count this date" (acceptPromise). */
  promise: z.object({ promiseId: z.string(), on: LocalDate, beyondLimitDays: z.number().int().nullable(), accepted: z.boolean() }).nullable(),
});
export const InboxThread = z.object({ customerId: Id, name: z.string(), contact: z.string(), owner: z.enum(['HEADROOM', 'YOU']), ownerVersion: z.number().int(), pill: z.string(), unread: z.number().int(), entries: z.array(InboxEntry) });
/** S5-D26: what the mail channel is and whether it can send now (e.g. the 7-day test sign-in expired). */
export const MailChannelStatus = z.object({ kind: z.enum(['GMAIL', 'SIMULATED', 'NONE']), state: z.enum(['CONNECTED', 'EXPIRED', 'NOT_CONNECTED', 'SIMULATED', 'NONE']), text: z.string(), expiresAbout: UtcInstant.nullable() });
export const Inbox = z.object({ items: z.array(InboxItem), note: z.string(), threads: z.array(InboxThread), channel: MailChannelStatus, unfiled: z.array(InboxEntry) });

/** ≤ 4 MB raw PDF (S3-D5; `ponytail:` one-step upload, presigned uploads when larger documents matter). */
export const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;
export const UploadDocumentBody = z.object({ fileName: z.string().min(1).max(200), contentType: z.literal('application/pdf'), contentBase64: z.string().min(1).max(Math.ceil(MAX_DOCUMENT_BYTES / 3) * 4 + 4) }).strict();
export const VerifyBillBody = z.object({ occurrenceKey: z.string().nullable(), occurrenceVersion: z.number().int().nonnegative(), currency: z.literal('USD').optional() }).strict();
export const AcceptBillTermsBody = z.object({ termsHash: z.string().min(1), changedFields: z.array(ChangedField).min(1) }).strict();
export const AddBillAsObligationBody = z.object({ termsHash: z.string().min(1), currency: z.literal('USD').optional() }).strict();
export const CreateCommitmentBody = z.object({ name: z.string().trim().min(1).max(120), amount: Money, on: LocalDate, recurrence: z.enum(['NONE', 'MONTHLY']), estimate: z.boolean(), protected: z.boolean() }).strict();
const BillCommandResult = z.object({ billId: Id, state: z.enum(BillStates), version: z.number().int() });

export const Session = z.object({
  tenantName: z.string(),
  timeZone: z.string(),
  businessToday: LocalDate,
  run: z.object({ runId: Id, epoch: z.number().int(), state: z.enum(RunStates), seeded: z.boolean() }),
  userEmail: z.string(),
  lastChangeAt: UtcInstant.nullable(),
  watching: z.boolean(),
  /** S4 global pauses: the banner shows on every route. */
  pauses: z.object({ outreach: z.boolean(), payments: z.boolean() }),
  /** UX repair (S7 audit F06): the newest notable confirmed event (receipt verified, offer skipped, supplier paid, bill arrived). The
   * shell shows it once as a notice; its persistent record is the Activity row with the same id. */
  notice: z.object({ eventId: z.string(), at: UtcInstant, text: z.string(), to: z.string().nullable().optional() }).nullable().optional(),
  /** S7-D11: from the verified Cognito groups claim only. `view` SHOWCASE = the finished showcase run, read-only (R10). */
  role: z.enum(['OWNER', 'JUDGE', 'OPERATOR']).default('OWNER'),
  view: z.enum(['MY_RUN', 'SHOWCASE']).default('MY_RUN'),
});

export const Overview = z.object({
  horizon: Horizon,
  cashNow: z.object({
    reportedAvailable: SignedMoney.nullable(),
    asOf: UtcInstant.nullable(),
    retrievedAt: UtcInstant.nullable(),
    refreshState: RefreshState,
    estimate: z.object({ lower: SignedMoney, upper: SignedMoney }).nullable(),
    // reportedAvailable is the D-6 total: PayPal reported available + bank counted, each only where non-null and contributing.
    parts: z.object({ paypal: SignedMoney.nullable(), bank: SignedMoney.nullable() }),
    bank: z.object({
      state: z.enum(['NOT_CONNECTED', ...BankConnectionStates]),
      contributes: z.boolean(),
      counted: SignedMoney.nullable(),
      retrievedAt: UtcInstant.nullable(),
      freshness: BankFreshness,
      notCounted: z.array(z.string()),
    }),
  }),
  owedToYou: z.object({ sum: Money, count: z.number().int(), undatedCount: z.number().int() }),
  /** D-DUE-OUT: obligation amounts of scheduled outflows in the horizon (the estimated payout fee shows in the forecast, not here). */
  billsDue: z.object({ sum: Money, count: z.number().int().nonnegative() }),
  lowestPoint: LowestPoint,
  statusLine: z.string(),
  inProgress: z.object({ collecting: z.object({ count: z.number().int(), sum: Money }) }),
  needsCount: z.number().int().nonnegative(),
  /** S7-D3: every safety rule currently looser than its seeded default. */
  safetyNotices: z.array(z.object({ key: PolicyKey, text: z.string(), since: UtcInstant.nullable() })),
  needs: z.array(NeedRow),
  alert: Alert.nullable(),
  /** UI-OV-09: the running or draft plan revision, null while there is none. */
  plan: z.object({ revisionN: z.number().int(), state: z.enum(PlanRevisionStates), pill: z.string(), steps: z.array(z.object({ title: z.string(), mode: z.string(), state: z.string() })).max(4) }).nullable(),
  activity: z.array(ActivityRow),
  /** Earliest instant a time-derived field of this DTO reads differently (S2-PR-05); the client refetches then. */
  validUntil: UtcInstant.nullable(),
});

export const CashPosition = z.object({
  horizon: Horizon,
  sources: z.tuple([PayPalSource, BankSource]),
  reserve: z.object({ amount: Money, basis: z.literal('SEEDED') }),
  ledger: z.object({ reportedMinusReserve: SignedMoney.nullable(), asOf: UtcInstant.nullable(), vsReserve: z.enum(['ABOVE', 'BELOW', 'UNKNOWN']) }),
  currentBadge: CurrentBadge,
  lowestPoint: LowestPoint,
  /** D-6 company figures: PayPal + bank counted, with the parts named. */
  totals: z.object({ reportedAvailable: SignedMoney.nullable(), parts: z.object({ paypal: SignedMoney.nullable(), bank: SignedMoney.nullable() }), estimate: z.object({ lower: SignedMoney, upper: SignedMoney }).nullable() }),
  validUntil: UtcInstant.nullable(),
});

/** UI-AR-01/02/04/05/19 (S5-D17): collection work, ranked by the server; the panel carries everything it shows. */
export const WorkRow = z.object({
  rank: z.number().int().positive(), invoiceId: Id, invoiceNumber: z.string().nullable(), customerId: Id, customer: z.string(),
  open: Money, undisputedOpen: Money.nullable(), disputed: Money.nullable(), dueOn: LocalDate, overdueDays: z.number().int(),
  expected: z.string(), needBy: LocalDate.nullable(), nextStep: z.string(), whoActs: z.enum(['HEADROOM', 'YOU', 'NEEDS_YOU']), actionId: Id.nullable(),
  panel: z.object({
    newDateLimit: z.string(), why: z.string().nullable(), citations: z.array(z.string()),
    drafts: z.array(z.object({ subject: z.string(), label: z.string(), allowedBy: z.string() })),
    owner: z.enum(['HEADROOM', 'YOU']), ownerVersion: z.number().int(),
    claim: z.object({ invoice: Money, undisputed: Money, disputed: Money, acknowledgement: z.object({ from: z.string(), quote: z.string(), on: LocalDate }), basis: z.enum(['SEEDED', 'CUSTOMER_REPLY']), disputedText: z.string(), cashConsequence: z.string(), approval: z.string().nullable() }).nullable(),
  }),
});
export const Receivables = z.object({
  /** S5: collection work and the rule it is ranked by. */
  work: z.array(WorkRow), workPopulation: z.string(),
  invoices: z.array(InvoiceRow),
  incoming: z.array(ReceiptRow),
  customers: z.array(Customer),
  population: z.object({ total: z.number().int(), open: z.number().int() }),
});

export const InvoiceDetail = z.object({
  invoice: InvoiceRow,
  ppInvoiceId: z.string().nullable(),
  providerStatus: z.string().nullable(),
  payerUrl: z.string().nullable(),
  failureReason: z.string().nullable(),
  effect: z.object({ effectKey: z.string(), state: z.enum(EffectStates), failureReason: z.string().nullable(), updatedAt: UtcInstant }).nullable(),
  ownerAssertions: z.array(OwnerAssertion),
  receipts: z.array(ReceiptRow),
  allocations: z.array(z.object({ captureId: z.string(), amount: Money, at: UtcInstant, claim: AllocationClaim })),
  /** S7 R4: a dispute read from the customer's email, waiting for you (amounts null = Headroom couldn't ground them; you type them). */
  dispute: z.object({ proposalId: z.string(), from: z.string(), subject: z.string(), receivedAt: UtcInstant, quote: z.string(), disputed: Money.nullable(), undisputed: Money.nullable(), derived: z.enum(['DISPUTED', 'UNDISPUTED']).nullable(), openMinor: z.number().int(), invoiceVersion: z.number().int() }).nullable(),
  /** S7 R5: disputed money you approved collecting (consumed allowance) and how much of it PayPal has settled. */
  disputedAllowance: z.object({ allowed: Money, used: Money }).nullable(),
  audit: z.array(ActivityRow),
  /** S5-D3: PayPal's due (copied) beside Headroom's projection; HOLD when they disagree. null before the invoice is on PayPal. */
  projection: z.object({
    providerDue: Money.nullable(), collectibleOpen: Money, undisputedOpen: Money.nullable(), disputedUnresolved: Money.nullable(), unallocatedCredit: Money.nullable(),
    concessions: Money, conservation: z.enum(['PASS', 'HOLD', 'UNKNOWN']), text: z.string().nullable(),
  }).nullable(),
  /** The partial-payment setting Headroom verified on PayPal (S5-D4), or null. */
  partialPayment: z.object({ minimum: Money, verifiedAt: UtcInstant }).nullable(),
});

export const CreateInvoiceDraftBody = z.object({ customerId: Id, amount: Money, dueOn: LocalDate }).strict();
export const Accepted = z.object({ jobId: Id });
export const LinkTokenBody = z.object({ mode: z.enum(['connect', 'update']) }).strict();
export const ExchangeBody = z.object({ publicToken: z.string().min(1).max(512), institutionId: z.string().max(128).nullable().optional(), institutionName: z.string().max(200).nullable().optional() }).strict();

// ---------- S4 plan, delegation, grants, relationships (S04 §6.3 as revised by §6.17) ----------
export const OutlookRow = z.object({
  key: z.string(), label: z.string(), condition: z.string(), needByClose: SignedMoney, low: SignedMoney, lowOn: LocalDate, result: z.enum(['COVERED', 'GAP']),
  gap: Money, concessionCost: Money, firstBelowReserve: LocalDate.nullable(), likelihood: z.literal('NOT_ASSESSED'),
});
export const ActionCard = PlanAction.extend({
  authorityTag: z.object({ tone: z.enum(['DELEGATION', 'NEEDS_YOU', 'EXCEPTION', 'APPROVED', 'BLOCKED']), text: z.string() }),
  relationship: z.object({ tier: Tier, label: z.string(), dots: z.number().int(), meaning: z.string() }).nullable(),
  stateText: z.string(), cashEffect: z.string(), paused: z.string().nullable(), needsApproval: z.boolean(),
  /** Authority recomputed under the current policy when it differs from the stored decision (rules changed). */
  authorityNow: PolicyDecision.nullable(),
  grants: z.array(z.object({ grantId: z.string(), kind: GrantKind, text: z.string(), state: z.string() })),
  editable: z.array(z.enum(['contactOn', 'targetOn', 'amountMinor', 'discountBp', 'message'])), canRemove: z.boolean(), canRestore: z.boolean(), canAsk: z.boolean(),
  invoiceNumber: z.string().nullable(),
  // S5: the message's own lifecycle (never "Sent" before the channel confirms), the latest C-SKIP-1 check, the owner's decide-by choice.
  messageState: z.object({ state: z.enum(OutMsgStates), label: z.string(), held: z.boolean(), reason: z.string().nullable(), to: z.string().nullable(), preparedFor: z.string().nullable() }).nullable(),
  check: z.object({
    checkId: z.string(), at: UtcInstant, decision: z.enum(['SKIP', 'HELD_EVIDENCE', 'NEEDED', 'HELD']), early: z.boolean(), lowerMin: z.object({ on: LocalDate, close: SignedMoney }).nullable(),
    upperMin: z.object({ on: LocalDate, close: SignedMoney }).nullable(), reserve: Money, blockers: z.array(z.string()), sources: z.string(),
  }).nullable(),
  decide: z.object({ checkId: z.string(), by: UtcInstant, due: z.boolean() }).nullable(),
  canHold: z.boolean(), canSendNow: z.boolean(),
});
export type ActionCard = z.infer<typeof ActionCard>;
export const ScheduleMarker = z.object({ on: LocalDate, at: UtcInstant.nullable(), kind: z.enum(['CONTACT', 'CHECK', 'TARGET', 'CONDITIONAL', 'OBLIGATION', 'EXPIRY']), label: z.string(), actionId: Id.nullable() });
export const ApprovalDialog = z.object({
  mode: z.enum(['ACTIVATE', 'REAPPROVE']), selected: z.array(Id), consentHash: z.string(), basisMoved: z.boolean(), blocked: z.string().nullable(),
  groups: z.object({
    included: z.array(z.object({ actionId: Id, title: z.string(), terms: z.string(), authority: z.string() })),
    conditional: z.array(z.object({ actionId: Id, title: z.string(), condition: z.string() })),
    exceptions: z.array(z.object({ actionId: Id, title: z.string(), reasons: z.array(z.string()) })),
    alreadyDone: z.array(z.object({ label: z.string(), by: z.string(), at: UtcInstant })),
    pendingBills: z.array(z.object({ billId: Id, label: z.string() })),
    removed: z.array(z.object({ actionId: Id, title: z.string() })),
  }),
  /** UX repair (F03): each permission says why it is asked, the rule and its source, and what approving does and does not do now. */
  newPermissions: z.array(z.object({ actionId: Id, kind: GrantKind, scope: z.string(), title: z.string().default(''), why: z.string().default(''), policy: z.string().default(''), effect: z.string().default('') })), carried: z.number().int(), scope: z.string(),
});
export const RevisionView = z.object({
  revisionId: Id, n: z.number().int(), state: z.enum(PlanRevisionStates), version: z.number().int(), pill: z.string(),
  /** `coverage` (S4-IM-04): what the included actions do to the gap if their targets are met, computed on the server. */
  header: z.object({ title: z.string(), change: z.string().nullable(), before: z.object({ low: SignedMoney, lowOn: LocalDate }).nullable(), after: z.object({ low: SignedMoney, lowOn: LocalDate }), needBy: LocalDate, gap: Money, compareId: z.string().nullable(),
    coverage: z.object({ state: z.enum(['COVERED', 'LATER_GAP', 'FALLBACK_ONLY', 'NOT_COVERED', 'RESOLVED']), text: z.string() }),
    /** UX repair (F01): the reserve the header compares against; RESOLVED = the current forecast stays above it. */
    reserve: Money.optional() }),
  /** UX repair (F06): what happened since approval (receipts, skips, payouts) and the reassessment against the current forecast. */
  updates: z.array(z.object({ at: UtcInstant.nullable(), kind: z.enum(['RECEIPT', 'REASSESSED', 'SKIPPED', 'PAID', 'SENT']), text: z.string(), amount: Money.nullable().optional(), to: z.string().nullable().optional() })).default([]),
  /** UX (owner, 3 Nov 2026): how much of the gap at approval is closed now (from the live forecast), and what a skipped concession kept. */
  progress: z.object({ gapAtApproval: Money, gapNow: Money }).nullable().optional(),
  kept: z.object({ amount: Money, headline: z.string(), text: z.string(), actionId: Id }).nullable().optional(),
  planner: z.object({ mode: z.enum(['MODEL', 'TEMPLATE']), reason: z.string().nullable(), summary: z.string() }),
  outlook: z.array(OutlookRow), outlookNote: z.string(),
  schedule: z.object({ from: LocalDate, to: LocalDate, needBy: LocalDate, lanes: z.array(z.object({ key: z.string(), label: z.string(), markers: z.array(ScheduleMarker) })) }),
  actions: z.array(ActionCard), considered: z.array(z.object({ key: z.string(), title: z.string(), reason: z.string(), canAsk: z.boolean(), actionId: Id.nullable(), actionVersion: z.number().int().nullable(), sources: z.array(Citation) })),
  removed: z.array(ActionCard), approval: ApprovalDialog.nullable(),
  diff: z.array(z.object({ rootId: z.string(), change: z.enum(['ADDED', 'CHANGED', 'UNCHANGED', 'DROPPED']), detail: z.string() })).nullable(),
  laterGap: z.string().nullable(), createdAt: UtcInstant, approvedAt: UtcInstant.nullable(), approvedBy: z.string().nullable(),
});
export type RevisionView = z.infer<typeof RevisionView>;
export const PlanView = z.object({
  state: z.enum(['NO_OPENING', 'NO_PLAN_NEEDED', 'NEEDS_BUILD', 'BUILDING', 'FAILED', 'READY']), reason: z.string().nullable(),
  build: z.object({ buildId: z.string(), generation: z.number().int(), state: z.enum(PlanBuildStates), checks: z.array(PlanCheck), failure: z.object({ kind: z.string(), reason: z.string() }).nullable(), retryable: z.boolean() }).nullable(),
  revision: RevisionView.nullable(), running: z.object({ revisionId: Id, n: z.number().int() }).nullable(),
  /** UX repair (F01): a draft beside the running revision. `current` = built on today's cash picture and still needed. */
  proposed: z.object({ revisionId: Id, n: z.number().int(), current: z.boolean(), text: z.string() }).nullable().default(null),
  banner: z.string().nullable(), outside: z.array(z.object({ billId: Id, label: z.string(), reason: z.string() })),
  trail: z.array(z.object({ revisionId: Id, n: z.number().int(), title: z.string(), at: UtcInstant, trigger: z.string(), approvedBy: z.string().nullable(), status: z.string() })),
  validUntil: UtcInstant.nullable(),
});
export const BuildBody = z.object({ retry: z.object({ buildId: z.string().max(64), generation: z.number().int().positive() }).strict().optional() }).strict();
export const BuildResult = z.object({ status: z.enum(['STARTED', 'IN_PROGRESS', 'DONE', 'FAILED']), buildId: z.string(), generation: z.number().int(), jobId: z.string().nullable(), revisionId: z.string().nullable() });
const ActionRef = { actionId: Id, actionVersion: z.number().int().positive() };
export const EditRevisionBody = z.discriminatedUnion('op', [
  z.object({ op: z.literal('EDIT_ACTION'), ...ActionRef, changes: z.object({ contactOn: LocalDate.optional(), targetOn: LocalDate.optional(), amountMinor: z.number().int().optional(), discountBp: z.number().int().optional(), message: z.object({ subject: z.string().min(1).max(160), body: z.string().min(1).max(2000) }).strict().optional() }).strict() }).strict(),
  z.object({ op: z.literal('REMOVE'), ...ActionRef, reason: z.string().max(200).optional() }).strict(),
  z.object({ op: z.literal('RESTORE'), ...ActionRef }).strict(),
  z.object({ op: z.literal('INCLUDE_CONSIDERED'), ...ActionRef }).strict(),
  z.object({ op: z.literal('USE_ALTERNATIVE'), ...ActionRef, alternativeRootId: z.string().max(200) }).strict(),
]);
const Met = z.object({ low: SignedMoney, lowOn: LocalDate, belowReserveFrom: LocalDate.nullable() }).nullable();
export const ActionEditResult = z.object({ revisionId: Id, revisionVersion: z.number().int(), actionId: Id, actionVersion: z.number().int(), state: z.enum(ActionStates), notes: z.array(z.string()), newApprovals: z.array(z.string()), ifAllMet: z.object({ before: Met, after: Met }) });
export const ApproveBody = z.object({ selected: z.array(Id).max(50), consentHash: z.string().min(1).max(128) }).strict();
export const ApproveResult = z.object({ revisionId: Id, state: z.enum(PlanRevisionStates), revisionVersion: z.number().int(), approval: z.number().int(), grants: z.array(z.object({ grantId: z.string(), kind: GrantKind, scope: z.string() })), carried: z.number().int() });
export const ReasonBody = z.object({ reason: z.string().max(200).optional() }).strict();

/** `affectsNow`: every live planned action this rule decides, with its current decision and state, for audit (owner, 2 Nov 2026). */
/** S7-D1/D3: `editor` picks the typed control; `safety` rules show `loosenedFromDefault` with Restore default (`defaultValue`). */
export const RuleEditor = z.enum(['DAYS', 'BUSINESS_DAYS', 'MONEY', 'TOGGLE', 'CHOICE', 'WINDOW', 'DISCOUNT', 'DIFFERING', 'SET_ASIDE']);
export const RuleRow = PolicyRule.extend({
  editor: RuleEditor, choices: z.array(z.object({ value: z.string(), label: z.string() })), safety: z.boolean(), loosenedFromDefault: z.boolean(), defaultValue: PolicyValue, defaultText: z.string(),
  text: z.string(), value: z.string(), scopedText: z.string().nullable(), affectsNow: z.array(z.object({ label: z.string(), winning: z.string(), actionId: Id, revisionN: z.number().int(), decision: z.string(), state: z.string(), amount: Money })) });
export const GrantRow = z.object({
  grantId: z.string(), kind: z.union([GrantKind, z.enum(['BILL_VERIFY', 'TERMS_ACCEPT'])]), text: z.string(), scope: z.string(), revisionN: z.number().int().nullable(),
  state: z.union([z.enum(GrantStates), z.enum(['EXPIRED', 'RECORD'])]), by: z.string(), at: UtcInstant, expiresAt: UtcInstant.nullable(), rulesUnchanged: z.boolean(), revocable: z.boolean(), note: z.string().nullable(),
});
export const DelegationView = z.object({
  version: z.number().int(), pauses: z.object({ outreach: z.boolean(), payments: z.boolean() }), rules: z.array(RuleRow),
  tiers: z.array(z.object({ tier: Tier, label: z.string(), meaning: z.string(), discount: z.boolean(), reviewFirst: z.boolean(), contactEveryBd: z.number().int(), counterparties: z.array(z.string()) })),
  exceptions: z.array(z.object({ counterpartyId: Id, name: z.string(), text: z.string() })),
  precedence: z.array(z.string()), hardStops: z.array(z.string()), grants: z.array(GrantRow),
});
/** `value` is checked against the key's own schema (RULE_VALUE); null = a scoped row falls back to the everywhere value. */
const RuleChangeShape = z.object({ key: PolicyKey, scope: z.enum(['EVERYWHERE', 'RECEIVABLES', 'PAYABLES']), value: PolicyValue.nullable() });
const valueFits = (b: { key: z.infer<typeof PolicyKey>; value: unknown }, ctx: z.RefinementCtx) => {
  if (b.value === null) return;
  const r = RULE_VALUE[b.key].safeParse(b.value);
  if (!r.success) ctx.addIssue({ code: 'custom', path: ['value'], message: r.error.issues[0]?.message ?? 'Invalid value' });
};
export const RuleChangeBody = RuleChangeShape.strict().superRefine(valueFits);
/** S7-D3: loosening a safety rule needs `acknowledgeSafety: true` ("I understand"). */
export const RuleSaveBody = RuleChangeShape.extend({ previewHash: z.string().min(1).max(128), acknowledgeSafety: z.boolean().optional() }).strict().superRefine(valueFits);
export const RulePreview = z.object({ key: PolicyKey, before: z.string(), after: z.string(), loosens: z.boolean(), safety: z.boolean(), safetyText: z.string().nullable(), affected: z.array(z.object({ label: z.string(), before: z.string(), after: z.string(), ref: z.string() })), previewHash: z.string(), policyVersion: z.number().int() });
export const PauseBody = z.object({ kind: z.enum(['OUTREACH', 'PAYMENTS']), on: z.boolean() }).strict();
/** UI-AR-18 (S5-D15): labels and evidence only. A "Yes, PayPal transfer" creates no receipt and moves no cash. */
export const ReconciliationView = z.object({
  transfers: z.array(z.object({ bankTxId: z.string(), date: LocalDate, description: z.string(), amount: SignedMoney.nullable(), answer: z.enum(['TRANSFER', 'NOT_TRANSFER']).nullable(), version: z.number().int(), by: z.string().nullable() })),
  awaitingReport: z.array(z.object({ captureId: z.string(), invoiceNumber: z.string(), net: Money, capturedAt: UtcInstant })),
  unallocated: z.array(z.object({ invoiceId: Id, invoiceNumber: z.string().nullable(), captureId: z.string(), amount: Money })),
  holds: z.array(z.object({ invoiceId: Id, invoiceNumber: z.string().nullable(), text: z.string() })),
  note: z.string(),
});
export const DecideFallbackBody = z.object({ decision: z.enum(['SEND', 'DONT_SEND']), checkId: z.string().min(1).max(200) }).strict();
export const ThreadOwnerBody = z.object({ owner: z.enum(['YOU', 'HEADROOM']) }).strict();
export const HoldMessageBody = z.object({ held: z.boolean() }).strict();
export const MatchAnswerBody = z.object({ answer: z.enum(['TRANSFER', 'NOT_TRANSFER']) }).strict();

export const RelationshipRow = z.object({
  id: Id, name: z.string(), roles: z.array(z.enum(['CUSTOMER', 'SUPPLIER'])), tier: Tier, label: z.string(), dots: z.number().int(), meaning: z.string(),
  receivable: Money, payable: Money, activeWork: z.array(z.string()), lastContact: LocalDate.nullable(), basis: z.literal('SEEDED'),
});
export const RelationshipRecord = RelationshipRow.extend({
  since: LocalDate.nullable(), factors: z.array(z.object({ factor: z.string(), value: z.string(), detail: z.string(), sources: z.array(z.string()) })),
  treatment: z.array(z.object({ text: z.string(), winning: z.string() })), inPlan: z.array(z.object({ actionId: Id, title: z.string(), state: z.string() })),
  history: z.array(z.object({ ref: z.string(), kind: z.string(), dueOn: LocalDate, paidOn: LocalDate.nullable(), daysLate: z.number().int().nullable(), amount: Money, note: z.string().nullable() })),
  open: z.array(z.object({ ref: z.string(), text: z.string(), invoiceId: Id.nullable() })), rank: z.string(),
});

type RouteDef = {
  method: 'GET' | 'POST';
  path: string;
  auth: 'jwt' | 'none';
  command: boolean; // requires Idempotency-Key
  ifMatch: boolean;
  status: number;
  body?: z.ZodType;
  /** S4: validated query parameters (both transports pass them). */
  query?: z.ZodType;
  response: z.ZodType;
  errors: z.infer<typeof ErrorCode>[];
  summary: string;
  /** S7 R10: served by the operator Lambda (`/v1/demo/*` judges + operator, `/v1/operator/*` operator only), never by the API Lambda. */
  lane?: 'demo' | 'operator';
};

/** S7b judge drawer / operator lane (R1, R3, R7, R10). */
const Phase = z.enum(['QUEUED', 'CLAIMED', 'SUBMITTING', 'SUBMITTED_UNVERIFIED', 'VERIFIED_PAID', 'VERIFIED_NOT_PAID', 'NOT_SUBMITTED', 'UNKNOWN_UNRESOLVED', 'REFUSED']);
export const DemoRun = z.object({
  role: z.enum(['OWNER', 'JUDGE', 'OPERATOR']), view: z.enum(['MY_RUN', 'SHOWCASE']), tenantLabel: z.string(),
  run: z.object({ runId: Id, state: z.string(), blockers: z.array(z.string()), epoch: z.number().int() }).nullable(),
  lease: z.object({ mine: z.boolean(), held: z.boolean(), until: UtcInstant.nullable() }),
  reset: z.object({ resetKey: z.string(), state: z.string(), waiting: z.string().nullable(), blocker: z.object({ code: z.string(), text: z.string() }).nullable(), landing: Money.nullable(),
    housekeeping: z.array(z.object({ n: z.number().int(), amount: Money, state: z.string(), itemId: z.string().nullable(), fee: Money.nullable() })), timeline: z.array(z.object({ at: UtcInstant, text: z.string() })) }).nullable(),
  clock: z.object({ virtualNow: UtcInstant.nullable(), next: z.object({ at: UtcInstant, label: z.string() }).nullable() }),
  collections: z.array(z.object({ actionId: Id, counterparty: z.string(), amount: Money, payerUrl: z.string().nullable(), canPay: z.boolean(), why: z.string().nullable(),
    attempt: z.object({ phase: Phase, text: z.string(), captureId: z.string().nullable(), at: UtcInstant }).nullable() })),
  canStart: z.boolean(), startBlocked: z.string().nullable(),
  /** Judge dock (owner, 4 Nov 2026): the shared live run's availability. readyAt = when a reset is expected to finish (estimate). */
  live: z.object({ state: z.enum(['READY', 'MINE', 'IN_USE', 'RESETTING', 'BLOCKED']), text: z.string().nullable(), readyAt: UtcInstant.nullable() }).optional(),
  /** One dock (owner, 5 Nov 2026): where the run is on the hero journey (the dock's 8 beats, 0–7) and what its Next does. Null unless you can drive the run. */
  journey: z.object({ step: z.number().int().min(0).max(7), next: z.object({ kind: z.enum(['BILL', 'CONFIRM_PAYEE', 'APPROVE', 'PAY', 'ADVANCE', 'WAIT', 'DONE']), label: z.string(), actionId: Id.nullable() }) }).nullable().optional(),
});
export const EffectRow = z.object({ key: z.string(), kind: z.string(), state: z.string(), providerIds: z.array(z.string()), at: UtcInstant.nullable(), detail: z.string().nullable(), label: z.string().nullable() });
const Empty = z.object({}).strict();

export const routes = {
  getDemoRun: { method: 'GET', path: '/v1/demo/run', auth: 'jwt', command: false, ifMatch: false, status: 200, response: DemoRun, errors: ['FORBIDDEN_ROLE'], summary: 'Judge drawer: my run, lease, reset progress, demo clock and the collections the payer may pay', lane: 'demo' },
  setDemoView: { method: 'POST', path: '/v1/demo/view', auth: 'jwt', command: false, ifMatch: false, status: 200, body: z.object({ view: z.enum(['MY_RUN', 'SHOWCASE']) }).strict(), response: z.object({ view: z.enum(['MY_RUN', 'SHOWCASE']) }), errors: ['FORBIDDEN_ROLE'], summary: 'Switch between my run and the finished showcase run (read-only)', lane: 'demo' },
  startDemoRun: { method: 'POST', path: '/v1/demo/start', auth: 'jwt', command: false, ifMatch: false, status: 202, body: z.object({ tenantId: Id.optional(), dispute: z.enum(['SEEDED', 'EMAIL']).optional() }).strict(), response: z.object({ resetKey: z.string() }), errors: ['FORBIDDEN_ROLE', 'MERCHANT_LEASED', 'PREVIOUS_RUN_UNRESOLVED', 'RESET_IN_PROGRESS'], summary: 'Start a fresh run on the sandbox merchant (takes the lease; returns the rail to the opening first)', lane: 'demo' },
  endDemoRun: { method: 'POST', path: '/v1/demo/end', auth: 'jwt', command: false, ifMatch: false, status: 200, body: Empty, response: z.object({ released: z.boolean() }), errors: ['FORBIDDEN_ROLE', 'PREVIOUS_RUN_UNRESOLVED', 'RESET_IN_PROGRESS'], summary: 'End my run: release the merchant (refused while PayPal work is in flight)', lane: 'demo' },
  demoBill: { method: 'POST', path: '/v1/demo/bill', auth: 'jwt', command: false, ifMatch: false, status: 202, body: Empty, response: z.object({ billId: z.string() }), errors: ['FORBIDDEN_ROLE', 'READ_ONLY'], summary: "Bring in Keller's original bill (the hero document, through normal ingestion)", lane: 'demo' },
  demoCollect: { method: 'POST', path: '/v1/demo/collect', auth: 'jwt', command: false, ifMatch: false, status: 202, body: z.object({ actionId: Id }).strict(), response: z.object({ attemptId: z.string(), phase: Phase }), errors: ['FORBIDDEN_ROLE', 'READ_ONLY', 'NOTHING_TO_COLLECT', 'MERCHANT_LEASED'], summary: "The customer pays on PayPal's hosted page (AUTOMATED-PAYER, sandbox); the receipt still comes only from PayPal's GETs", lane: 'demo' },
  demoAdvance: { method: 'POST', path: '/v1/demo/advance', auth: 'jwt', command: false, ifMatch: false, status: 200, body: Empty, response: z.object({ virtualNow: UtcInstant, ran: z.array(z.string()) }), errors: ['FORBIDDEN_ROLE', 'READ_ONLY', 'NOT_FOUND'], summary: 'Advance the demo clock to the next scheduled step and run it (due times only; provider times stay real)', lane: 'demo' },
  demoReconcile: { method: 'POST', path: '/v1/demo/reconcile', auth: 'jwt', command: false, ifMatch: false, status: 202, body: Empty, response: z.object({ queued: z.number().int() }), errors: ['FORBIDDEN_ROLE', 'READ_ONLY'], summary: 'Refresh from PayPal and the bank now (invoice, capture and balance GETs)', lane: 'demo' },
  getDemoEffects: { method: 'GET', path: '/v1/demo/effects', auth: 'jwt', command: false, ifMatch: false, status: 200, response: z.object({ rows: z.array(EffectRow) }), errors: ['FORBIDDEN_ROLE'], summary: 'Every provider effect of the run with its ids and as-of (read-only)', lane: 'demo' },
  /** EXPERIMENTAL golden run (owner, 3 Nov 2026): real Gmail sends of the run's asks to the test inbox, operator only. */
  takeLiveRun: { method: 'POST', path: '/v1/demo/live', auth: 'jwt', command: false, ifMatch: false, status: 200, body: Empty, response: z.object({ ok: z.boolean() }), errors: ['FORBIDDEN_ROLE', 'MERCHANT_LEASED', 'RESET_IN_PROGRESS'], summary: 'Judge dock: take the shared live run when it is fresh (no reset), or keep the one you hold', lane: 'demo' },
  goldenMail: { method: 'POST', path: '/v1/demo/golden-mail', auth: 'jwt', command: false, ifMatch: false, status: 202, body: z.object({ messages: z.array(z.object({ preparedFor: z.string().max(200), subject: z.string().min(1).max(200), text: z.string().min(1).max(5000) }).strict()).min(1).max(3) }).strict(), response: z.object({ id: z.string() }), errors: ['FORBIDDEN_ROLE', 'NOT_FOUND', 'HARD_STOP'], summary: 'Golden run: send the asks as real emails to the test inbox (operator)', lane: 'demo' },
  getGoldenMail: { method: 'GET', path: '/v1/demo/golden-mail/{id}', auth: 'jwt', command: false, ifMatch: false, status: 200, response: z.object({ id: z.string(), state: z.string(), sent: z.array(z.object({ subject: z.string(), messageId: z.string() })), reason: z.string().nullable() }), errors: ['FORBIDDEN_ROLE', 'NOT_FOUND'], summary: 'Golden run: whether Gmail confirmed the demo emails', lane: 'demo' },
  demoKellerReply: { method: 'POST', path: '/v1/demo/keller-reply', auth: 'jwt', command: false, ifMatch: false, status: 202, body: Empty, response: z.object({ queued: z.boolean() }), errors: ['FORBIDDEN_ROLE', 'READ_ONLY', 'NOT_FOUND', 'MERCHANT_LEASED'], summary: "Sandbox fixture (FIXTUREMAIL, DEMO_SCRIPT): Keller replies to Headroom's ask from the test inbox, agreeing to the split; it arrives through normal mail intake", lane: 'demo' },
  operatorRelease: { method: 'POST', path: '/v1/operator/release', auth: 'jwt', command: false, ifMatch: false, status: 200, body: Empty, response: z.object({ released: z.boolean() }), errors: ['FORBIDDEN_ROLE', 'PREVIOUS_RUN_UNRESOLVED', 'RESET_IN_PROGRESS'], summary: 'Operator: release the merchant lease (refused while PayPal work is in flight)', lane: 'operator' },
  getSession: { method: 'GET', path: '/v1/session', auth: 'jwt', command: false, ifMatch: false, status: 200, response: Session, errors: ['UNAUTHENTICATED'], summary: 'Signed-in owner, tenant and active run' },
  getOverview: { method: 'GET', path: '/v1/overview', auth: 'jwt', command: false, ifMatch: false, status: 200, response: Overview, errors: ['UNAUTHENTICATED'], summary: 'Overview strip, status line and recent activity' },
  getCashPosition: { method: 'GET', path: '/v1/cash/position', auth: 'jwt', command: false, ifMatch: false, status: 200, response: CashPosition, errors: ['UNAUTHENTICATED'], summary: 'Reported, estimated and forecast cash, kept separate (C-BAL-1, C-CURRENT-1)' },
  refreshPayPalBalance: { method: 'POST', path: '/v1/cash/paypal/refresh', auth: 'jwt', command: false, ifMatch: false, status: 202, response: Accepted, errors: ['RUN_SEALED', 'NOT_CONNECTED'], summary: 'Queue a PayPal balance read' },
  listReceivables: { method: 'GET', path: '/v1/receivables', auth: 'jwt', command: false, ifMatch: false, status: 200, response: Receivables, errors: ['UNAUTHENTICATED'], summary: 'Invoices, incoming receipts and customers' },
  getInvoice: { method: 'GET', path: '/v1/invoices/{id}', auth: 'jwt', command: false, ifMatch: false, status: 200, response: InvoiceDetail, errors: ['NOT_FOUND'], summary: 'Invoice, effect, receipts, allocations and audit' },
  createInvoiceDraft: { method: 'POST', path: '/v1/invoices', auth: 'jwt', command: true, ifMatch: false, status: 201, body: CreateInvoiceDraftBody, response: z.object({ invoice: InvoiceRow, aggregateVersion: z.number().int(), correlationId: z.string() }), errors: ['INVALID_INPUT', 'IDEMPOTENCY_CONFLICT', 'RUN_SEALED'], summary: 'Save a draft invoice (no provider call)' },
  sendInvoice: { method: 'POST', path: '/v1/invoices/{id}/send', auth: 'jwt', command: true, ifMatch: true, status: 202, response: z.object({ effectId: z.string(), jobId: Id, aggregateVersion: z.number().int() }), errors: ['NOT_FOUND', 'VERSION_CONFLICT', 'RUN_SEALED', 'NOT_DRAFT', 'IDEMPOTENCY_CONFLICT', 'NOT_CONNECTED'], summary: 'Issue the draft on PayPal through the effect executor (no email)' },
  refreshInvoice: { method: 'POST', path: '/v1/invoices/{id}/refresh', auth: 'jwt', command: false, ifMatch: false, status: 202, response: Accepted, errors: ['NOT_FOUND', 'INVALID_INPUT', 'NOT_CONNECTED'], summary: 'Queue an immediate PayPal read of this invoice' },
  getActivity: { method: 'GET', path: '/v1/activity', auth: 'jwt', command: false, ifMatch: false, status: 200, response: z.object({ rows: z.array(ActivityRow) }), errors: ['UNAUTHENTICATED'], summary: 'Audit trail for the active run, newest first' },
  createPlaidLinkToken: { method: 'POST', path: '/v1/cash/bank/link-token', auth: 'jwt', command: false, ifMatch: false, status: 200, body: LinkTokenBody, response: z.object({ linkToken: z.string(), expiration: z.string() }), errors: ['RUN_SEALED', 'ALREADY_CONNECTED', 'NOT_CONNECTED', 'PROVIDER_UNAVAILABLE'], summary: 'Short-lived Plaid Link token (connect, or update mode to reconnect). Creates no Item' },
  exchangePlaidToken: { method: 'POST', path: '/v1/cash/bank/exchange', auth: 'jwt', command: true, ifMatch: false, status: 202, body: ExchangeBody, response: z.object({ effectId: z.string(), jobId: Id }), errors: ['INVALID_INPUT', 'ALREADY_CONNECTED', 'IDEMPOTENCY_CONFLICT', 'RUN_SEALED', 'PROVIDER_UNAVAILABLE'], summary: 'Claim a bank connection; the worker exchanges the sealed public token through the effect executor' },
  refreshPlaid: { method: 'POST', path: '/v1/cash/bank/refresh', auth: 'jwt', command: false, ifMatch: false, status: 202, response: Accepted, errors: ['NOT_CONNECTED', 'RUN_SEALED'], summary: 'Queue a bank sync and real-time balance read' },
  disconnectPlaid: { method: 'POST', path: '/v1/cash/bank/disconnect', auth: 'jwt', command: true, ifMatch: true, status: 202, response: z.object({ effectId: z.string(), jobId: Id }), errors: ['NOT_CONNECTED', 'VERSION_CONFLICT', 'RUN_SEALED', 'IDEMPOTENCY_CONFLICT'], summary: 'Stop counting the bank now and ask Plaid to remove the connection (executor effect)' },
  abandonBankConnect: { method: 'POST', path: '/v1/cash/bank/connect/abandon', auth: 'jwt', command: true, ifMatch: true, status: 200, response: z.object({ binding: z.literal('RELEASED') }), errors: ['NOT_CONNECTED', 'VERSION_CONFLICT', 'RUN_SEALED', 'IDEMPOTENCY_CONFLICT'], summary: 'Owner gives up on a connect whose outcome cannot be determined, so a new one can start' },
  getForecast: { method: 'GET', path: '/v1/cash/forecast', auth: 'jwt', command: false, ifMatch: false, status: 200, query: ForecastQuery, response: Forecast, errors: ['UNAUTHENTICATED', 'INVALID_INPUT', 'NOT_FOUND'], summary: '42-day forecast (Expected, Ideal or Downside): daily closes, states, summary, not-in-forecast, comparisons (C-FUNDS)' },
  listPayables: { method: 'GET', path: '/v1/payables', auth: 'jwt', command: false, ifMatch: false, status: 200, response: Payables, errors: ['UNAUTHENTICATED'], summary: 'Payment plan (obligations), bills and commitments' },
  getBill: { method: 'GET', path: '/v1/bills/{id}', auth: 'jwt', command: false, ifMatch: false, status: 200, response: BillDetail, errors: ['NOT_FOUND'], summary: 'Bill panel: checks, grounded fields, impact, candidates and actions' },
  getBillDocument: { method: 'GET', path: '/v1/bills/{id}/document', auth: 'jwt', command: false, ifMatch: false, status: 200, response: z.object({ fileName: z.string(), contentType: z.literal('application/pdf'), sha256: z.string(), contentBase64: z.string() }), errors: ['NOT_FOUND'], summary: 'The original document, as received (base64 over the authenticated JSON API)' },
  uploadDocument: { method: 'POST', path: '/v1/documents', auth: 'jwt', command: true, ifMatch: false, status: 202, body: UploadDocumentBody, response: z.union([z.object({ status: z.literal('RECEIVED'), billId: Id, jobId: Id }), z.object({ status: z.literal('DUPLICATE_DOCUMENT'), billId: Id })]), errors: ['INVALID_INPUT', 'IDEMPOTENCY_CONFLICT', 'RUN_SEALED'], summary: 'Upload an original bill PDF; it is stored immutably and read by the worker' },
  retryBill: { method: 'POST', path: '/v1/bills/{id}/retry', auth: 'jwt', command: true, ifMatch: true, status: 202, response: z.object({ billId: Id, jobId: Id }), errors: ['NOT_FOUND', 'VERSION_CONFLICT', 'INVALID_INPUT', 'RUN_SEALED', 'IDEMPOTENCY_CONFLICT'], summary: 'Read a bill again after it could not be read' },
  verifyBill: { method: 'POST', path: '/v1/bills/{id}/verify', auth: 'jwt', command: true, ifMatch: true, status: 200, body: VerifyBillBody, response: BillCommandResult, errors: ['NOT_FOUND', 'VERSION_CONFLICT', 'BILL_HELD', 'NOT_A_CANDIDATE', 'INVALID_INPUT', 'RUN_SEALED', 'IDEMPOTENCY_CONFLICT'], summary: 'Owner verifies the document is a genuine bill for an occurrence. Changes no terms; permits no payment' },
  acceptBillTerms: { method: 'POST', path: '/v1/bills/{id}/accept-terms', auth: 'jwt', command: true, ifMatch: true, status: 200, body: AcceptBillTermsBody, response: BillCommandResult, errors: ['NOT_FOUND', 'VERSION_CONFLICT', 'NOT_VERIFIED', 'NOTHING_TO_ACCEPT', 'TERMS_CHANGED', 'BILL_HELD', 'RUN_SEALED', 'IDEMPOTENCY_CONFLICT'], summary: "Owner accepts exactly the bill's changed fields (date and/or amount) for the obligation" },
  addBillAsObligation: { method: 'POST', path: '/v1/bills/{id}/add-obligation', auth: 'jwt', command: true, ifMatch: true, status: 200, body: AddBillAsObligationBody, response: BillCommandResult, errors: ['NOT_FOUND', 'VERSION_CONFLICT', 'TERMS_CHANGED', 'BILL_HELD', 'INVALID_INPUT', 'RUN_SEALED', 'IDEMPOTENCY_CONFLICT'], summary: "Owner verifies a known supplier's bill and adds it as one new outflow (separate obligation)" },
  createCommitment: { method: 'POST', path: '/v1/commitments', auth: 'jwt', command: true, ifMatch: false, status: 201, body: CreateCommitmentBody, response: z.object({ commitment: CommitmentRow, effect: z.string() }), errors: ['INVALID_INPUT', 'RUN_SEALED', 'IDEMPOTENCY_CONFLICT'], summary: 'Add a commitment (one-time or monthly); occurrences enter the forecast as the horizon reaches them' },
  getInbox: { method: 'GET', path: '/v1/inbox', auth: 'jwt', command: false, ifMatch: false, status: 200, response: Inbox, errors: ['UNAUTHENTICATED'], summary: 'Documents received (uploaded or operator-injected), newest first' },
  getPlan: { method: 'GET', path: '/v1/plan', auth: 'jwt', command: false, ifMatch: false, status: 200, response: PlanView, errors: ['UNAUTHENTICATED'], summary: 'Plan: build state, current revision (running, else draft; a draft beside a running revision is `proposed`), outlook, schedule, actions, considered, trail' },
  buildRevision: { method: 'POST', path: '/v1/plan/revisions', auth: 'jwt', command: true, ifMatch: false, status: 202, body: BuildBody, response: BuildResult, errors: ['CASH_IMPACT_UNKNOWN', 'NOTHING_TO_PLAN', 'RUN_SEALED', 'IDEMPOTENCY_CONFLICT'], summary: 'Build a plan revision for the current basis (idempotent per basis; retry a failed build by generation)' },
  getRevision: { method: 'GET', path: '/v1/plan/revisions/{id}', auth: 'jwt', command: false, ifMatch: false, status: 200, response: RevisionView, errors: ['NOT_FOUND'], summary: 'One revision with its actions, outlook and approval dialog' },
  editRevision: { method: 'POST', path: '/v1/plan/revisions/{id}/edit', auth: 'jwt', command: true, ifMatch: true, status: 200, body: EditRevisionBody, response: ActionEditResult, errors: ['NOT_FOUND', 'VERSION_CONFLICT', 'REVISION_NOT_DRAFT', 'NOT_EDITABLE', 'HARD_STOP', 'INVALID_INPUT', 'RUN_SEALED', 'IDEMPOTENCY_CONFLICT'], summary: 'Edit, remove, restore, include or swap one action; rechecked against delegation' },
  approveRevision: { method: 'POST', path: '/v1/plan/revisions/{id}/approve', auth: 'jwt', command: true, ifMatch: true, status: 200, body: ApproveBody, response: ApproveResult, errors: ['NOT_FOUND', 'VERSION_CONFLICT', 'REVISION_NOT_DRAFT', 'CONSENT_CHANGED', 'NOTHING_SELECTED', 'RUN_SEALED', 'IDEMPOTENCY_CONFLICT'], summary: 'Approve the actions waiting in a revision; records each needed permission separately. Nothing is sent or paid' },
  rejectRevision: { method: 'POST', path: '/v1/plan/revisions/{id}/reject', auth: 'jwt', command: true, ifMatch: true, status: 200, body: ReasonBody, response: z.object({ revisionId: Id, state: z.enum(PlanRevisionStates), revisionVersion: z.number().int() }), errors: ['NOT_FOUND', 'VERSION_CONFLICT', 'REVISION_NOT_DRAFT', 'RUN_SEALED', 'IDEMPOTENCY_CONFLICT'], summary: 'Reject a draft revision; the running revision is untouched' },
  getDelegation: { method: 'GET', path: '/v1/delegation', auth: 'jwt', command: false, ifMatch: false, status: 200, response: DelegationView, errors: ['UNAUTHENTICATED'], summary: 'Rules, tiers, precedence, hard stops, pauses and Approved once' },
  previewPolicyChange: { method: 'POST', path: '/v1/delegation/preview', auth: 'jwt', command: false, ifMatch: false, status: 200, body: RuleChangeBody, response: RulePreview, errors: ['NOT_EDITABLE', 'INVALID_INPUT'], summary: 'What a rule change would affect now (no write)' },
  changePolicy: { method: 'POST', path: '/v1/delegation/rules', auth: 'jwt', command: true, ifMatch: true, status: 200, body: RuleSaveBody, response: z.object({ policyVersion: z.number().int(), loosens: z.boolean(), affected: RulePreview.shape.affected }), errors: ['VERSION_CONFLICT', 'NOT_EDITABLE', 'INVALID_INPUT', 'CONSENT_CHANGED', 'SAFETY_ACK_REQUIRED', 'RUN_SEALED', 'IDEMPOTENCY_CONFLICT'], summary: 'Save an owner rule change reviewed through its preview' },
  setPause: { method: 'POST', path: '/v1/delegation/pauses', auth: 'jwt', command: true, ifMatch: true, status: 200, body: PauseBody, response: z.object({ policyVersion: z.number().int(), pauses: z.object({ outreach: z.boolean(), payments: z.boolean() }) }), errors: ['VERSION_CONFLICT', 'RUN_SEALED', 'IDEMPOTENCY_CONFLICT'], summary: 'Pause or resume all outreach or all payment preparation' },
  revokeGrant: { method: 'POST', path: '/v1/grants/{id}/revoke', auth: 'jwt', command: true, ifMatch: false, status: 200, body: ReasonBody, response: z.object({ grantId: z.string(), state: z.literal('REVOKED') }), errors: ['NOT_FOUND', 'GRANT_NOT_ACTIVE', 'NOT_EDITABLE', 'RUN_SEALED', 'IDEMPOTENCY_CONFLICT'], summary: 'Revoke a permission that has not been acted on; its action needs approval again' },
  listRelationships: { method: 'GET', path: '/v1/relationships', auth: 'jwt', command: false, ifMatch: false, status: 200, response: z.object({ rows: z.array(RelationshipRow) }), errors: ['UNAUTHENTICATED'], summary: 'Customers and suppliers with relationship labels (rules, not scores)' },
  getRelationship: { method: 'GET', path: '/v1/relationships/{id}', auth: 'jwt', command: false, ifMatch: false, status: 200, response: RelationshipRecord, errors: ['NOT_FOUND'], summary: 'One relationship: evidence behind its label, how Headroom treats it, open items and active work' },
  // S5 (S05 §6.3)
  getReconciliation: { method: 'GET', path: '/v1/reconciliation', auth: 'jwt', command: false, ifMatch: false, status: 200, response: ReconciliationView, errors: ['UNAUTHENTICATED'], summary: 'Bank PayPal-transfer candidates with your answers, captures awaiting PayPal’s report, money toward disputed amounts, holds' },
  decideFallback: { method: 'POST', path: '/v1/plan/actions/{id}/decide', auth: 'jwt', command: true, ifMatch: true, status: 200, body: DecideFallbackBody, response: z.object({ actionId: Id, state: z.enum(ActionStates) }), errors: ['NOT_FOUND', 'VERSION_CONFLICT', 'NOT_EDITABLE', 'CONSENT_CHANGED', 'OUTREACH_PAUSED', 'YOU_TOOK_OVER', 'RUN_SEALED', 'IDEMPOTENCY_CONFLICT'], summary: 'Your decision on a fallback offer still unproven at its decide-by time: send it once, or not' },
  setThreadOwner: { method: 'POST', path: '/v1/receivables/threads/{id}/owner', auth: 'jwt', command: true, ifMatch: true, status: 200, body: ThreadOwnerBody, response: z.object({ customerId: Id, owner: z.enum(['YOU', 'HEADROOM']), version: z.number().int() }), errors: ['NOT_FOUND', 'VERSION_CONFLICT', 'RUN_SEALED', 'IDEMPOTENCY_CONFLICT'], summary: 'Take over a customer (Headroom sends and changes nothing for them) or hand back' },
  acceptSupplierAnswer: { method: 'POST', path: '/v1/payables/asks/{id}/accept', auth: 'jwt', command: true, ifMatch: false, status: 200, body: z.object({ answerId: z.string().min(1).max(200), option: z.enum(['KEEP', 'SPLIT']), obligationVersion: z.number().int(), billVersion: z.number().int() }).strict(), response: z.object({ askId: z.string(), option: z.enum(['KEEP', 'SPLIT']), parts: SupplierAskOption.shape.parts }), errors: ['NOT_FOUND', 'VERSION_CONFLICT', 'INVALID_INPUT', 'PAYOUT_IN_FLIGHT', 'SPLIT_REFUSED', 'RUN_SEALED', 'IDEMPOTENCY_CONFLICT'], summary: 'Accept the supplier’s answer: one of the offered options becomes the bill’s terms. Paying still needs payout authority' },
  declineSupplierAnswer: { method: 'POST', path: '/v1/payables/asks/{id}/decline', auth: 'jwt', command: true, ifMatch: false, status: 200, body: z.object({ answerId: z.string().min(1).max(200) }).strict(), response: z.object({ askId: z.string(), state: z.literal('DECLINED') }), errors: ['NOT_FOUND', 'VERSION_CONFLICT', 'RUN_SEALED', 'IDEMPOTENCY_CONFLICT'], summary: 'Decline the supplier’s answer; the accepted terms stay' },
  confirmDispute: { method: 'POST', path: '/v1/receivables/invoices/{id}/dispute/confirm', auth: 'jwt', command: true, ifMatch: false, status: 200, body: z.object({ proposalId: z.string().min(1).max(200), undisputedMinor: z.number().int().nonnegative(), disputedMinor: z.number().int().positive(), invoiceVersion: z.number().int() }).strict(), response: z.object({ invoiceId: Id, undisputed: Money, disputed: Money }), errors: ['NOT_FOUND', 'VERSION_CONFLICT', 'INVALID_INPUT', 'RUN_SEALED', 'IDEMPOTENCY_CONFLICT'], summary: 'Confirm the split of a dispute read from the customer’s email; decides what may be collected. Creates no permission' },
  dismissDispute: { method: 'POST', path: '/v1/receivables/invoices/{id}/dispute/dismiss', auth: 'jwt', command: true, ifMatch: false, status: 200, body: z.object({ proposalId: z.string().min(1).max(200) }).strict(), response: z.object({ invoiceId: Id, state: z.literal('NOT_A_DISPUTE') }), errors: ['NOT_FOUND', 'VERSION_CONFLICT', 'RUN_SEALED', 'IDEMPOTENCY_CONFLICT'], summary: 'Not a dispute: release what the pending dispute held' },
  acceptPromise: { method: 'POST', path: '/v1/inbox/promises/{id}/accept', auth: 'jwt', command: true, ifMatch: false, status: 200, body: z.object({}).strict(), response: z.object({ promiseId: z.string(), accepted: z.literal(true) }), errors: ['NOT_FOUND', 'VERSION_CONFLICT', 'RUN_SEALED', 'IDEMPOTENCY_CONFLICT'], summary: 'Count a promised date that is beyond your new-date limit in Expected (never cash, never skips a fallback)' },
  holdMessage: { method: 'POST', path: '/v1/inbox/messages/{id}/hold', auth: 'jwt', command: true, ifMatch: false, status: 200, body: HoldMessageBody, response: z.object({ actionId: Id, held: z.boolean() }), errors: ['NOT_FOUND', 'VERSION_CONFLICT', 'NOT_EDITABLE', 'ACTION_EXECUTED', 'RUN_SEALED', 'IDEMPOTENCY_CONFLICT'], summary: "Hold or release one action's message; a held message never sends" },
  sendNow: { method: 'POST', path: '/v1/inbox/messages/{id}/send', auth: 'jwt', command: true, ifMatch: false, status: 202, body: z.object({}).strict(), response: Accepted, errors: ['NOT_FOUND', 'NOT_EDITABLE', 'ACTION_EXECUTED', 'RUN_SEALED', 'IDEMPOTENCY_CONFLICT'], summary: "Run the message's scheduled send now (same job, same Message-ID; still checked)" },
  answerMatch: { method: 'POST', path: '/v1/reconciliation/bank/{id}/answer', auth: 'jwt', command: true, ifMatch: true, status: 200, body: MatchAnswerBody, response: z.object({ bankTxId: z.string(), answer: z.enum(['TRANSFER', 'NOT_TRANSFER']), version: z.number().int() }), errors: ['VERSION_CONFLICT', 'RUN_SEALED', 'IDEMPOTENCY_CONFLICT'], summary: 'Label a bank PayPal-transfer candidate (no receipt, no cash moves)' },
  // S6 (S06 §6.3, §6.17 R9)
  getPayout: { method: 'GET', path: '/v1/payables/payouts/{id}', auth: 'jwt', command: false, ifMatch: false, status: 200, response: PayoutView, errors: ['NOT_FOUND'], summary: 'One PayPal payout obligation: rail and company readiness, authority checks and the payment result (masked address)' },
  confirmPayee: { method: 'POST', path: '/v1/payables/payees/{id}/confirm', auth: 'jwt', command: true, ifMatch: false, status: 200, body: ConfirmPayeeBody, response: z.object({ supplierId: Id, state: z.enum(['UNCONFIRMED', 'CONFIRMED']), version: z.number().int(), matched: z.boolean(), message: z.string() }), errors: ['NOT_FOUND', 'CONSENT_CHANGED', 'VERSION_CONFLICT', 'INVALID_INPUT', 'RUN_SEALED', 'IDEMPOTENCY_CONFLICT'], summary: "Owner confirms a supplier's PayPal address by typing it; only the hash is compared. Identity only: permits no payment" },
  revealPayee: { method: 'GET', path: '/v1/payables/payees/{id}/reveal', auth: 'jwt', command: false, ifMatch: false, status: 200, response: z.object({ supplierId: Id, address: z.string(), masked: z.string(), version: z.number().int() }), errors: ['NOT_FOUND'], summary: "Owner-only: the exact PayPal address Headroom would pay (audited, hash only)" },
  paypalWebhook: { method: 'POST', path: '/v1/webhooks/paypal', auth: 'none', command: false, ifMatch: false, status: 200, response: z.object({ ok: z.literal(true) }), errors: [], summary: 'PayPal webhook ingress (C-PP); stored raw, verified asynchronously' },
} as const satisfies Record<string, RouteDef>;

export type OperationId = keyof typeof routes;
export type ResponseOf<O extends OperationId> = z.infer<(typeof routes)[O]['response']>;

/** '/v1/invoices/{id}' + {id:'x'} → '/v1/invoices/x' */
export const pathFor = (op: OperationId, params: Record<string, string> = {}) =>
  routes[op].path.replace(/\{(\w+)\}/g, (_, k: string) => encodeURIComponent(params[k] ?? ''));
