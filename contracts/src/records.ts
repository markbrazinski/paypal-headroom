import { z } from 'zod';
import { Basis, Id, LocalDate, Money, ProviderAmount, SignedMoney, UtcInstant } from './primitives.ts';
import { Closing, Opening, WhyCode } from './agents.ts';
import { ActionStates, BankBindingStates, BankConnectionStates, BankEffectStates, BillStates, EffectStates, GrantStates, InvoiceStates, JobStates, ObligationStates, MailEffectStates, OfferExpiryStates, OutMsgStates, OwnerAuthStates, PlanBuildStates, PlanRevisionStates, RunStates, UpdateEffectStates, PayoutEffectStates, ReservationStates, PayeeStates } from './states.ts';

export const Run = z.object({
  runId: Id,
  tenantId: Id,
  epoch: z.number().int().nonnegative(),
  state: z.enum(RunStates),
  seeded: z.literal(true),
  createdAt: UtcInstant,
  blockers: z.array(z.string()),
  reason: z.string(),
});
export type Run = z.infer<typeof Run>;

export const RunFence = z.object({ tenantId: Id, runId: Id, epoch: z.number().int().nonnegative() });
export type RunFence = z.infer<typeof RunFence>;

export const Settings = z.object({
  businessName: z.string(),
  timeZone: z.string(),
  basis: z.literal('SEEDED'),
});
export type Settings = z.infer<typeof Settings>;

export const Customer = z.object({
  customerId: Id,
  displayName: z.string(),
  billingEmail: z.string(),
  basis: Basis,
  businessKey: z.string().optional(),
});
export type Customer = z.infer<typeof Customer>;

/** An EXTERNAL transaction on a PayPal invoice: the owner's assertion, never a receipt or cash. */
export const OwnerAssertion = z.object({ providerPaymentId: z.string(), amount: Money, date: z.string().nullable(), method: z.string().nullable() });
export type OwnerAssertion = z.infer<typeof OwnerAssertion>;

export const InvoiceMirror = z.object({
  invoiceId: Id,
  runId: Id,
  customerId: Id,
  amount: Money,
  dueOn: LocalDate,
  state: z.enum(InvoiceStates),
  version: z.number().int().positive(),
  invoiceNumber: z.string().nullable(),
  ppInvoiceId: z.string().nullable(),
  providerStatus: z.string().nullable(),
  payerUrl: z.string().nullable(),
  openGross: Money,
  ownerAssertions: z.array(OwnerAssertion),
  hold: z.object({ reason: z.string(), at: UtcInstant }).nullable(),
  failureReason: z.string().nullable(),
  lastCheckedAt: UtcInstant.nullable(),
  lastRawSha256: z.string().nullable(),
  createdAt: UtcInstant,
});
export type InvoiceMirror = z.infer<typeof InvoiceMirror>;

/** Immutable once written. Only the reversal flag may be set later. */
export const CaptureReceipt = z.object({
  captureId: z.string(),
  connectionId: Id,
  invoiceId: Id,
  ppInvoiceId: z.string(),
  invoiceNumber: z.string(),
  runId: Id,
  gross: Money,
  fee: Money,
  net: Money,
  capturedAt: UtcInstant,
  retrievedAt: UtcInstant,
  captureStatus: z.string(),
  reversalDetected: z.boolean(),
  rawSha256: z.string(),
});
export type CaptureReceipt = z.infer<typeof CaptureReceipt>;

/**
 * S5-D3: which part of the invoice a capture's gross went to. WHOLE on an invoice with no claim; on a claimed invoice the undisputed
 * part first, the rest UNALLOCATED (received toward the disputed amount, the owner's decision). Never DISPUTED automatically.
 */
/** DISPUTED (S7 R5): only up to an approved, consumed COLLECT_DISPUTED allowance (`DISPALLOW#`). */
export const AllocationClaim = z.enum(['WHOLE', 'UNDISPUTED', 'DISPUTED', 'UNALLOCATED']);
export const Allocation = z.object({ allocationId: Id, captureId: z.string(), invoiceId: Id, amount: Money, at: UtcInstant, claim: AllocationClaim });
export type Allocation = z.infer<typeof Allocation>;

/** A refund seen in PayPal reporting (T1107): an immutable negative economic movement. */
export const RefundObservation = z.object({
  transactionId: z.string(),
  captureId: z.string(),
  connectionId: Id,
  amount: Money,
  at: UtcInstant,
  source: z.literal('PAYPAL_REPORTING'),
});
export type RefundObservation = z.infer<typeof RefundObservation>;

export const ReportingRow = z.object({
  transactionId: z.string(),
  eventCode: z.string(),
  status: z.string(),
  amount: SignedMoney.nullable(), // null when the row is in another currency
  fee: SignedMoney.nullable(),
  currency: z.string(),
  initiatedAt: UtcInstant,
  updatedAt: UtcInstant.nullable(),
  paypalReferenceId: z.string().nullable(),
  invoiceNumber: z.string().nullable(),
  availableBalance: SignedMoney.nullable(),
  order: z.number().int(), // PayPal's order within the fetch
});
export type ReportingRow = z.infer<typeof ReportingRow>;

export const Coverage = z.enum(['COMPLETE', 'PARTIAL']);
export const BalanceObservation = z.object({
  connectionId: Id,
  accountId: z.string(),
  availableMinor: z.number().int().nullable(),
  withheldMinor: z.number().int().nullable(),
  currency: z.literal('USD'),
  reportedAsOf: UtcInstant.nullable(),
  retrievedAt: UtcInstant,
  coverage: Coverage,
  lastRefreshedAt: UtcInstant.nullable(),
  rowIds: z.array(z.string()),
  rawSha256: z.string(),
});
export type BalanceObservation = z.infer<typeof BalanceObservation>;

export const EffectRecord = z.object({
  effectKey: z.string(), // = invoice number for invoice issue (PayPal dedupes on it, not on Request-Id)
  kind: z.literal('INVOICE_ISSUE'),
  tenantId: Id,
  runId: Id,
  epoch: z.number().int(),
  invoiceId: Id,
  state: z.enum(EffectStates),
  argsHash: z.string(),
  ppInvoiceId: z.string().nullable(),
  failureReason: z.string().nullable(),
  updatedAt: UtcInstant,
});
export type EffectRecord = z.infer<typeof EffectRecord>;

export const JobType = z.enum(['EXECUTE_EFFECT', 'RECONCILE_EFFECT', 'POLL_INVOICE', 'OBSERVE_BALANCE', 'VERIFY_WEBHOOK', 'PLAID_SYNC', 'RUN_READY_DEADLINE', 'INGEST_DOCUMENT', 'PLAN_BUILD', 'ACTION_DUE', 'PLAN_PROGRESS', 'MAIL_SYNC', 'REPLY_INTERPRET', 'PAYOUT_WATCH', 'RESET_STEP', 'PAYER', 'FIXTUREMAIL']);
export const Job = z.object({
  jobId: Id,
  type: JobType,
  state: z.enum(JobStates),
  tenantId: Id.nullable(),
  runId: Id.nullable(),
  ref: z.string(), // effect key, invoice id, connection id or webhook event id
  dueAt: UtcInstant,
  leaseToken: z.number().int().nonnegative(),
  leaseUntil: UtcInstant.nullable(),
  attempts: z.number().int().nonnegative(),
  lastError: z.string().nullable(),
});
export type Job = z.infer<typeof Job>;
export type JobType = z.infer<typeof JobType>;

export const AuditEventType = z.enum([
  'InvoiceDraftSaved', 'InvoiceIssueRequested', 'EffectDispatchClaimed', 'EffectRunFenced', 'InvoiceIssued', 'InvoiceIssueFailed',
  'EffectOutcomeUnknown', 'EffectReconciled', 'InvoiceCaptureVerified', 'ReceiptAllocated', 'ReceiptReversalDetected',
  'ReceiptRefundObserved', 'OwnerAssertionObserved', 'ReconciliationHold', 'PayPalBalanceObserved', 'PayPalObservationRejected',
  'PayPalCallBudgetReached', 'WebhookVerified', 'WebhookQuarantined', 'RunReset', 'OldRunEventRouted', 'InvoiceCheckingChanged',
  'BankConnectRequested', 'BankConnected', 'BankConnectFailed', 'BankConnectAbandoned', 'BankSeeded', 'BankSeedFailed', 'BankTransactionsSynced',
  'BankBalanceObserved', 'BankObservationFailed', 'BankHealthChanged', 'BankReconnected', 'BankDisconnectRequested', 'BankDisconnected',
  'BankEffectOutcomeUnknown', 'PlaidCallBudgetReached', 'RunReadinessChanged',
  // S3 (v1's BillTimingAccepted is BillTermsAccepted: acceptance covers the amount as well as the date)
  'ObligationsSeeded', 'IngestionReceived', 'DuplicateDocumentReceived', 'DocumentUnreadable', 'BillFieldsExtracted', 'BillExtractionFailed',
  'BillMatchProposed', 'BillHeld', 'BillVerified', 'BillTermsAccepted', 'CommitmentAdded', 'ModelCallBudgetReached', 'BillRetryRequested', 'BillSuperseded',
  // S4 (S04 §6.3)
  'HeroReceivablesSeeded', 'SupplierAnswerRecorded', 'SupplierAnswerAccepted', 'SupplierAnswerDeclined', 'DisputeProposed', 'DisputeConfirmed', 'DisputeDismissed', 'DisputedCollectionAuthorized', 'PolicySeeded', 'PlanBuildRequested', 'PlanBuildFailed', 'PlanRevisionDrafted', 'PlanActionEdited', 'PlanActionRemoved',
  'PlanActionRestored', 'PlanRevisionApproved', 'PlanRevisionRejected', 'PlanRevisionSuperseded', 'GrantRecorded', 'GrantRevoked', 'GrantLapsed',
  'PolicyChanged', 'PauseChanged', 'ModelOutputRefused',
  // S5 (S05 §6.3)
  'ActionQueued', 'ActionDueSkipped', 'InvoiceUpdated', 'InvoiceUpdateFailed', 'InvoiceUpdateUnknown', 'FallbackChecked', 'FallbackSkipped',
  'FallbackHeldEvidence', 'FallbackDecided', 'OfferApplied', 'OfferExpired', 'ActionCompleted', 'ActionCancelled', 'ActionHeld', 'UnallocatedGross',
  'ThreadOwnerChanged', 'MatchAnswered', 'OperatorRanActionEarly', 'GrantConsumed', 'OwnerAuthorityGranted', 'ConcessionRealized',
  'ConservationHold', 'EffectConflict', 'OfferRemovalHeld', 'CheckLeaseTakenOver',
  'MessageQueued', 'FixtureMailSent', 'MessageSent', 'MessageSendUnknown', 'MessageFailed', 'MessageHeld', 'MessageReleased', 'MailReceived', 'SenderHeld', 'ReplyInterpreted', 'PromiseRecorded', 'PromiseAccepted',
  // S6 (§6.3, §6.17)
  'PayeeSeeded', 'PayeeConfirmed', 'PayeeConfirmFailed', 'PayeeRevealed', 'PayoutReserved', 'PayoutHeld', 'PayoutHeldReady', 'PayoutCancelledUnsent', 'PayoutChargeMoved',
  'PayoutDispatched', 'PayoutSubmitted', 'PayoutRejected', 'PayoutUnknown', 'PayoutUnknownUnresolved', 'PayoutBatchAttached', 'PayoutItemObserved', 'PayoutPaid',
  'PayoutNotPaid', 'PayoutRefunded', 'ReservationReleased',
]);
export type AuditEventType = z.infer<typeof AuditEventType>;
// ---------- S2 bank (C-PLAID). No field anywhere holds a plaintext access, public or link token. ----------

/** Envelope-encrypted secret: a KMS data key (encrypted, bound to `context`) + AES-256-GCM over the plaintext. */
export const Sealed = z.object({ encDataKey: z.string(), iv: z.string(), ciphertext: z.string(), tag: z.string(), context: z.record(z.string(), z.string()) });
export type Sealed = z.infer<typeof Sealed>;

export const BankEffectKind = z.enum(['BANK_CONNECT', 'BANK_SEED', 'BANK_REMOVE']);
export const BankEffectRecord = z.object({
  effectKey: z.string(), // bankconn#<opId> | bankseed#<runId> | bankrm#<itemId>; immutable
  kind: BankEffectKind,
  tenantId: Id,
  runId: Id,
  epoch: z.number().int(),
  state: z.enum(BankEffectStates),
  version: z.number().int().positive(),
  argsHash: z.string(),
  itemId: z.string().optional(),
  institution: z.object({ id: z.string().nullable(), name: z.string().nullable() }).nullable(),
  sealedPublicToken: Sealed.optional(),
  sealedAccessToken: Sealed.optional(),
  encDataKey: z.string().optional(), // generated before dispatch so a 200 is sealed locally, never lost to a KMS failure
  seedConfig: z.unknown().optional(), // BANK_SEED: tracked fixture data (SEEDED), not a secret
  replayed: z.boolean().optional(),
  canAbandon: z.boolean().optional(),
  /** No automation will touch it again (UNKNOWN that cannot be resolved): the owner abandons, or the operator resets. */
  terminal: z.boolean().optional(),
  failureReason: z.string().nullable(),
  waitingReason: z.string().nullable().optional(),
  updatedAt: UtcInstant,
});
export type BankEffectRecord = z.infer<typeof BankEffectRecord>;

export const BankBasis = z.enum(['OWNER_LINKED', 'SEEDED']);
/** Run partition `CONN#plaid`: the run's single bank slot. Per run, so old evidence keeps pointing at its own Item. */
export const BankBinding = z.object({
  state: z.enum(BankBindingStates),
  version: z.number().int().positive(),
  effectKey: z.string(),
  itemId: z.string().nullable(),
  basis: BankBasis,
  boundAt: UtcInstant.nullable(),
});
export type BankBinding = z.infer<typeof BankBinding>;

/** `PLAID#<itemId>/ITEM`. `generation` fences every sync commit; Disconnect, removal and reconnect bump it. */
export const BankConnection = z.object({
  itemId: z.string(),
  tenantId: Id,
  runId: Id,
  state: z.enum(BankConnectionStates),
  version: z.number().int().positive(),
  generation: z.number().int().positive(),
  institution: z.object({ id: z.string().nullable(), name: z.string().nullable() }),
  basis: BankBasis,
  sealedAccessToken: Sealed.optional(),
  effectKey: z.string(),
  connectedAt: UtcInstant,
  institutionDataAsOf: UtcInstant.nullable(),
  consentExpiresAt: z.string().nullable(),
  itemError: z.string().nullable(),
});
export type BankConnection = z.infer<typeof BankConnection>;

export const BankAccountBalance = z.object({
  accountId: z.string(),
  name: z.string(),
  mask: z.string().nullable(),
  type: z.string(),
  subtype: z.string().nullable(),
  holderCategory: z.string().nullable(),
  available: ProviderAmount.nullable(),
  current: ProviderAmount.nullable(),
  limit: ProviderAmount.nullable(),
  /** USD minor units when the reported value is exact cents; null otherwise (never rounded). */
  availableMinor: z.number().int().nullable(),
  currentMinor: z.number().int().nullable(),
  precisionRefused: z.boolean(),
  lastUpdatedAt: z.string().nullable(),
});
export type BankAccountBalance = z.infer<typeof BankAccountBalance>;

/** `PLAID#<itemId>/OBS#<retrievedAt>`: one real-time balance read. Append-only. retrievedAt is our fetch time, not a bank as-of. */
export const BankBalanceObservation = z.object({
  itemId: z.string(),
  source: z.literal('REALTIME'),
  retrievedAt: UtcInstant,
  accounts: z.array(BankAccountBalance),
  rawSha256: z.string(),
});
export type BankBalanceObservation = z.infer<typeof BankBalanceObservation>;

/** One row of the transaction projection (`TXNS`). Amount uses Plaid's sign: + = money out. */
export const BankTransaction = z.object({
  transactionId: z.string(),
  accountId: z.string(),
  state: z.enum(['pending', 'posted', 'removed']),
  pendingTransactionId: z.string().nullable(),
  amountMinor: z.number().int().nullable(),
  rawAmount: z.number(),
  currency: z.string().nullable(),
  date: z.string(),
  authorizedDate: z.string().nullable(),
  description: z.string(),
  counterparties: z.array(z.string()),
  paypalCandidate: z.boolean(),
  firstSeenAt: UtcInstant,
  updatedAt: UtcInstant,
});
export type BankTransaction = z.infer<typeof BankTransaction>;

// ---------- S3 bills, commitments and obligations (S03 §6.3). Money here is USD minor units; a bill's printed text is kept verbatim. ----------

/** SUPPLIER_TERMS (S7 R6): the second part of a split the supplier agreed and the owner accepted. */
export const Provenance = z.enum(['SEEDED', 'OWNER_ENTERED', 'BILL', 'SUPPLIER_TERMS']);
/** `businessKey` (S7 R9): the business behind a customer and/or supplier record; one contact-spacing slot per business. Absent = its own id. */
export const Supplier = z.object({ supplierId: Id, displayName: z.string(), aliases: z.array(z.string()), verifiedRemittanceLast4: z.string().nullable(), basis: z.enum(['SEEDED', 'OWNER_ENTERED']), businessKey: z.string().optional(),
  /** S7 R6: where a supplier ask goes (test redirect applies). */
  contactEmail: z.string().optional() });
export type Supplier = z.infer<typeof Supplier>;

/** Occurrence n of MONTHLY falls on the anchor's day in month anchor+n, clamped to month end, always from the original anchor (S3-D15). DATES: seed only. */
export const CommitmentSchedule = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ONCE'), on: LocalDate }),
  z.object({ kind: z.literal('MONTHLY'), anchorOn: LocalDate, endOn: LocalDate.nullable() }),
  z.object({ kind: z.literal('DATES'), dates: z.array(LocalDate).min(1) }),
]);
export type CommitmentSchedule = z.infer<typeof CommitmentSchedule>;

export const Rail = z.enum(['PAYPAL_PAYOUT', 'NOT_HEADROOM']);
export const Commitment = z.object({
  commitmentId: Id,
  supplierId: Id.nullable(),
  name: z.string(),
  reference: z.string().nullable(),
  amount: Money,
  schedule: CommitmentSchedule,
  rail: Rail,
  estimate: z.boolean(),
  protected: z.boolean(),
  provenance: Provenance,
  createdOn: LocalDate,
  createdAt: UtcInstant,
});
export type Commitment = z.infer<typeof Commitment>;

/** `OBL#<commitmentId>#<n>`: stored only once a bill substantiates or re-terms the occurrence. `substantiatedBy` is absent until set, never null. */
export const Obligation = z.object({
  occurrenceKey: z.string(),
  commitmentId: Id,
  n: z.number().int().nonnegative(),
  scheduledOn: LocalDate,
  dueOn: LocalDate,
  amount: Money,
  state: z.enum(ObligationStates),
  termsVersion: z.number().int().nonnegative(),
  termsHash: z.string().nullable(),
  substantiatedBy: Id.optional(),
  version: z.number().int().positive(),
  /**
   * S6 (§6.17 R1/R6): the one live payment of this occurrence, which is also its lock (no splitting, no second intent). RESERVED from
   * the queue TX, IN_FLIGHT from the dispatch claim, PAID at a verified item SUCCESS (the holder stays: no duplicate payment).
   * Past RESERVED the occurrence leaves the forecast and its debit lives once, in the PayPal opening (the reservation).
   */
  payment: z.object({ effectKey: z.string(), stage: z.enum(['RESERVED', 'IN_FLIGHT', 'PAID']) }).nullable().default(null),
  reopenedFrom: z.string().nullable().default(null),
});
export type Obligation = z.infer<typeof Obligation>;

/** Computed per read from a commitment's schedule, overlaid by any stored Obligation. version 0 = not materialized. */
export const Occurrence = z.object({
  occurrenceKey: z.string(),
  commitmentId: Id,
  n: z.number().int().nonnegative(),
  scheduledOn: LocalDate,
  dueOn: LocalDate,
  amount: Money,
  version: z.number().int().nonnegative(),
  substantiatedBy: Id.optional(),
  materialized: z.boolean(),
  /** S6: from the stored OBL#; absent = SCHEDULED with no live payment. */
  state: z.enum(ObligationStates).optional(),
  payment: Obligation.shape.payment.optional(),
});
export type Occurrence = z.infer<typeof Occurrence>;

/** `invoiceId` (S4-D5): the real invoice this stated date belongs to, so the invoice is not also listed as undated. */
/** basis PROMISE (S5-D20): a customer's dated promise from an authorized reply; Expected only, never cash or the skip check. */
export const StatedInflow = z.object({ inflowId: Id, label: z.string(), counterpartyName: z.string().nullable(), on: LocalDate, amount: Money, basis: z.enum(['STATED', 'PROMISE']), provenance: z.enum(['SEEDED', 'CUSTOMER_REPLY']), invoiceId: Id.optional() });
export type StatedInflow = z.infer<typeof StatedInflow>;

export const DocumentSource = z.enum(['OWNER_UPLOAD', 'OPERATOR_INJECTED', 'MAIL']);
export const DocumentRecord = z.object({ sha256: z.string(), bytes: z.number().int().positive(), fileName: z.string(), contentType: z.literal('application/pdf'), source: DocumentSource, storageKey: z.string(), receivedAt: UtcInstant, billId: Id });
export type DocumentRecord = z.infer<typeof DocumentRecord>;

export const BillFieldName = z.enum(['supplierName', 'billNumber', 'reference', 'issueDate', 'dueDate', 'total', 'currency', 'remittanceLast4']);
export const BillField = z.object({ name: BillFieldName, value: z.string().nullable(), quote: z.string().nullable(), grounded: z.boolean(), reason: z.string().nullable() });
export type BillField = z.infer<typeof BillField>;

export const BillClassification = z.enum([
  'EXACT_MATCH', 'DATE_CHANGE_REQUESTED', 'AMOUNT_DISCREPANCY', 'TERMS_DIFFER', 'REVISION_SAME_TERMS', 'REVISION_CHANGED_TERMS',
  'AMBIGUOUS_COMMITMENT', 'AMBIGUOUS_SUPPLIER', 'UNKNOWN_SUPPLIER', 'NEW_OBLIGATION_KNOWN_SUPPLIER', 'COMMITMENT_ALREADY_BILLED', 'NOT_A_BILL',
  'UNREADABLE_NEEDS_OCR_OR_VISION', 'UNGROUNDED', 'UNSUPPORTED_CURRENCY', 'CONFLICTING_CURRENCY', 'CURRENCY_MISSING', 'CURRENCY_MISMATCH', 'TOO_LONG_TO_READ',
]);
export type BillClassification = z.infer<typeof BillClassification>;
export const BillFlag = z.enum(['UNTRUSTED_INSTRUCTION_TEXT', 'REMITTANCE_CHANGE', 'DOCUMENT_CHANGED']);
export type BillFlag = z.infer<typeof BillFlag>;
export const ChangedField = z.enum(['dueOn', 'amount']);
export type ChangedField = z.infer<typeof ChangedField>;

export const Bill = z.object({
  billId: Id,
  runId: Id,
  documentSha256: z.string(),
  source: DocumentSource,
  fileName: z.string(),
  state: z.enum(BillStates),
  version: z.number().int().positive(),
  readGeneration: z.number().int().positive(),
  classification: BillClassification.nullable(),
  flags: z.array(BillFlag),
  holdReasons: z.array(z.string()),
  fields: z.array(BillField).nullable(),
  dueOn: LocalDate.nullable(),
  /** Grounded USD only; null for a bare "$" until the owner attests the currency (S3-D14). */
  amount: Money.nullable(),
  currencyBasis: z.enum(['ISO', 'BARE_DOLLAR']).nullable(),
  printedTotal: z.string().nullable(),
  supplierId: Id.nullable(),
  candidates: z.array(z.string()),
  occurrenceKey: z.string().nullable(),
  proposedTerms: z.object({ dueOn: LocalDate, amount: Money }).nullable(),
  changedFields: z.array(ChangedField),
  readFailure: z.string().nullable(),
  /** The earlier bill (same supplier + number) this one revises, and the later one that replaced this one (S3-IM-02). */
  revisionOf: Id.nullable(),
  supersededBy: Id.nullable(),
  receivedAt: UtcInstant,
  updatedAt: UtcInstant,
});
export type Bill = z.infer<typeof Bill>;

/** Immutable. Verification says the document is a genuine bill for that occurrence; it changes no terms and permits no payment. */
export const BillVerification = z.object({ billId: Id, by: z.string(), at: UtcInstant, documentSha256: z.string(), occurrenceKey: z.string().nullable(), occurrenceVersion: z.number().int().nonnegative(), currencyAttested: z.literal('USD').nullable(), billVersion: z.number().int() });
export type BillVerification = z.infer<typeof BillVerification>;

/** Immutable. The owner's acceptance of exactly `changedFields`, or of a new separate obligation (kind SEPARATE_OBLIGATION). */
export const TermsAcceptance = z.object({
  kind: z.enum(['CHANGED_TERMS', 'SEPARATE_OBLIGATION']),
  billId: Id,
  occurrenceKey: z.string(),
  changedFields: z.array(ChangedField),
  before: z.object({ dueOn: LocalDate, amount: Money }).nullable(),
  after: z.object({ dueOn: LocalDate, amount: Money }),
  termsHash: z.string(),
  by: z.string(),
  at: UtcInstant,
});
export type TermsAcceptance = z.infer<typeof TermsAcceptance>;

/** One per transport request, written before dispatch with its reserved worst-case cost (S3-D18). A DISPATCHING record that never settles keeps its reservation. */
export const ModelCall = z.object({
  task: z.enum(['EvidenceInterpreter', 'RecoveryPlanner', 'MessageDrafter', 'ReplyInterpreter']),
  modelId: z.string(),
  /** The bill (EvidenceInterpreter) or the plan build (RecoveryPlanner, MessageDrafter) the request was for. */
  billId: Id.optional(),
  buildId: Id.optional(),
  /** ReplyInterpreter: the inbound MAIL# message id. */
  mailId: z.string().optional(),
  generation: z.number().int().positive(),
  k: z.number().int().nonnegative(),
  inputSha256: z.string(),
  inputChars: z.number().int().nonnegative(),
  reservedMicros: z.number().int().nonnegative(),
  state: z.enum(['DISPATCHING', 'OK', 'INVALID_OUTPUT', 'ERROR']),
  outputText: z.string().nullable(),
  outputSha256: z.string().nullable(),
  inputTokens: z.number().int().nullable(),
  outputTokens: z.number().int().nullable(),
  actualMicros: z.number().int().nullable(),
  latencyMs: z.number().int().nullable(),
  error: z.string().nullable(),
  dispatchedAt: UtcInstant,
  settledAt: UtcInstant.nullable(),
});
export type ModelCall = z.infer<typeof ModelCall>;

export const AuditEvent = z.object({
  eventId: Id,
  tenantId: Id,
  runId: Id,
  occurredAt: UtcInstant,
  eventType: AuditEventType,
  by: z.enum(['OWNER', 'HEADROOM', 'OPERATOR', 'PAYPAL']),
  allowedBy: z.string().nullable(),
  result: z.string(),
  refs: z.record(z.string(), z.string()),
  correlationId: z.string(),
});
export type AuditEvent = z.infer<typeof AuditEvent>;

// ---------- S4 plan, delegation, relationships and grants (S04 §6.3 as revised by §6.17). Amounts are USD minor units. ----------

export const Tier = z.enum(['STRONG', 'GOOD', 'MIXED', 'AT_RISK', 'NOT_ENOUGH_HISTORY']);
export type Tier = z.infer<typeof Tier>;
export const PolicyScope = z.enum(['EVERYWHERE', 'RECEIVABLES', 'PAYABLES']);
/** Hard stops are not policy fields (S4-D2): no key exists for verified recipient, consent, model authority, provider limits or tax. */
export const PolicyKey = z.enum([
  'comms.contactEveryBd', 'comms.window', 'comms.remindersWithoutReview', 'ar.newDateDays', 'ar.discount', 'ar.disputes', 'ap.paymentLimitMinor', 'ap.dailyLimitMinor', 'ap.exactMatchBills',
  'ap.differingBills', 'ap.askSuppliers', 'cash.reserveMinor', 'cash.protectedPayments',
]);
export type PolicyKey = z.infer<typeof PolicyKey>;
export const PolicyValue = z.union([z.number().int(), z.boolean(), z.string(), z.record(z.string(), z.union([z.number().int(), z.string(), z.array(z.string())]))]);
export type PolicyValue = z.infer<typeof PolicyValue>;

// S7-D1: one value schema per rule key, shared by the API body check and the server's applyRuleChange. Bounds are the owner's range.
const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const minorUpTo = (max: number) => z.number().int().min(0).max(max);
export const DisputesMode = z.enum(['PAUSE_INVOICE', 'UNDISPUTED_ONLY', 'PROPOSE_DISPUTED']);
export const RULE_VALUE: Record<z.infer<typeof PolicyKey>, z.ZodType<PolicyValue>> = {
  'comms.contactEveryBd': z.number().int().min(1).max(20),
  'comms.window': z.object({ open: HHMM, close: HHMM }).strict()
    .refine((w) => w.open >= '06:00' && w.close <= '22:00', 'The window must sit between 06:00 and 22:00')
    .refine((w) => Number(w.close.slice(0, 2)) * 60 + Number(w.close.slice(3)) - (Number(w.open.slice(0, 2)) * 60 + Number(w.open.slice(3))) >= 60, 'Open at least an hour before closing'),
  'comms.remindersWithoutReview': z.boolean(),
  'ar.newDateDays': z.number().int().min(0).max(60),
  // UX repair (S7 audit F03/F18): `ask` ALWAYS = every early-payment offer needs the owner's one-time approval, even inside the limits.
  'ar.discount': z.object({ bp: z.number().int().min(0).max(500), capMinor: minorUpTo(200_000), cumulativeMinor: minorUpTo(500_000), tiers: z.array(z.enum(['STRONG', 'GOOD', 'MIXED', 'AT_RISK'])).max(4), ask: z.enum(['ALWAYS', 'ABOVE_LIMITS']).optional() }).strict()
    .refine((v) => new Set(v.tiers).size === v.tiers.length, 'Each relationship once'),
  'ar.disputes': DisputesMode,
  'ap.paymentLimitMinor': minorUpTo(100_000_000),
  'ap.dailyLimitMinor': minorUpTo(100_000_000),
  'ap.exactMatchBills': z.enum(['AUTO_VERIFY', 'ALWAYS_ASK']),
  'ap.differingBills': z.object({ mode: z.enum(['ALWAYS_ASK', 'AUTO_ACCEPT']), maxAmountDiffMinor: minorUpTo(100_000), maxDaysEarlier: z.number().int().min(0).max(30) }).strict(),
  'ap.askSuppliers': z.enum(['NEEDS_YOU', 'WITHOUT_REVIEW']),
  'cash.reserveMinor': minorUpTo(100_000_000),
  'cash.protectedPayments': z.object({ setAsideDays: z.number().int().min(0).max(14) }).strict(),
};
/** `enforcedNow` null = enforced in this build; otherwise when it starts to apply (AGENTS §E: no success UI for missing behavior). */
export const PolicyRule = z.object({
  key: PolicyKey, group: z.enum(['MESSAGES', 'GETTING_PAID', 'PAYING_BILLS', 'CASH_SAFETY']), sentence: z.string(), why: z.string(),
  everywhere: PolicyValue, scoped: z.object({ scope: PolicyScope, value: PolicyValue.nullable() }).nullable(),
  editable: z.boolean(), enforcedNow: z.string().nullable(), provenance: z.enum(['SEEDED', 'PLANNER_VALUE', 'OWNER']),
  /** S7-D3: when the owner last changed this rule (the "Loosened by you · <date>" chip). */
  changedAt: UtcInstant.optional(),
});
export type PolicyRule = z.infer<typeof PolicyRule>;
export const TierDefault = z.object({ tier: Tier, meaning: z.string(), discount: z.boolean(), reviewFirst: z.boolean(), contactEveryBd: z.number().int() });
export const PolicyException = z.object({ counterpartyId: Id, key: PolicyKey, value: PolicyValue, setBy: z.string(), at: UtcInstant, basis: z.literal('SEEDED') });
export const Policy = z.object({
  version: z.number().int().positive(),
  rules: z.array(PolicyRule),
  tiers: z.array(TierDefault),
  exceptions: z.array(PolicyException),
  pauses: z.object({ outreach: z.boolean(), payments: z.boolean() }),
  change: z.object({ kind: z.enum(['SEED', 'RULE', 'PAUSE']), key: z.string(), before: z.string(), after: z.string(), loosens: z.boolean() }),
  by: z.string(),
  at: UtcInstant,
});
export type Policy = z.infer<typeof Policy>;

export const GrantKind = z.enum(['COLLECT_SLICE', 'MESSAGE_AS_WRITTEN', 'DISCOUNT_OFFER', 'PAYOUT_AUTHORITY', 'PAYOUT_EXCEPTION', 'COLLECT_DISPUTED', 'CONTACT_SPACING']);
export type GrantKind = z.infer<typeof GrantKind>;
export const PolicyDecision = z.object({
  decision: z.enum(['ALLOW', 'REQUIRES_APPROVAL', 'EXCEPTION', 'BLOCK']),
  reasons: z.array(z.string()),
  policyVersion: z.number().int().positive(),
  winning: z.object({ key: z.string(), scope: z.string(), source: z.enum(['EVERYWHERE', 'SCOPE', 'TIER', 'EXCEPTION', 'HARD_STOP']), label: z.string() }),
  grantKinds: z.array(GrantKind),
});
export type PolicyDecision = z.infer<typeof PolicyDecision>;

/** Harrow's acknowledged split (S4-D6): SEEDED, read-only in S4. */
/** A claim split. SEEDED (tests, and the dev reset until Gmail is connected) or CUSTOMER_REPLY: from a customer's email, confirmed by the owner (S7 R4). Immutable. */
export const ClaimSplit = z.object({ invoiceId: Id, undisputed: Money, disputed: Money, acknowledgement: z.object({ from: z.string(), quote: z.string(), on: LocalDate }), basis: z.enum(['SEEDED', 'CUSTOMER_REPLY']),
  source: z.object({ messageId: z.string(), proposalId: z.string(), by: z.literal('OWNER') }).optional() });
/** S7 R4: a dispute read from a customer's email, waiting for the owner. While PENDING nothing collects on the invoice. */
export const DisputeProposal = z.object({ proposalId: z.string(), invoiceId: Id, customerId: Id, messageId: z.string(), quote: z.string(), invoiceVersion: z.number().int(), openMinor: z.number().int(),
  disputed: Money.nullable(), undisputed: Money.nullable(), derived: z.enum(['DISPUTED', 'UNDISPUTED']).nullable(), at: UtcInstant });
export const DisputePending = z.object({ invoiceId: Id, proposalId: z.string(), messageId: z.string(), invoiceVersion: z.number().int(), openMinor: z.number().int(), state: z.enum(['PENDING', 'CONFIRMED', 'NOT_A_DISPUTE']), version: z.number().int() });
/** S7 R5: consumed authority to collect a disputed amount, frozen at the dispatch claim; never revoked by later rule changes. */
export const DisputedAuthz = z.object({ effectKey: z.string(), invoiceId: Id, portion: z.literal('DISPUTED'), allowanceMinor: z.number().int().positive(), grantId: z.string(), policyVersion: z.number().int(), termsHash: z.string(), at: UtcInstant });
export const DisputedAllowance = z.object({ invoiceId: Id, allowedMinor: z.number().int().nonnegative(), usedMinor: z.number().int().nonnegative(), version: z.number().int() });
export type DisputeProposal = z.infer<typeof DisputeProposal>;
/** S7 R6 `SUPPLIERANSWER#<askId>#<messageId>`: a supplier's reply. A reply alone changes nothing; only the owner accepts one option. */
export const SupplierAnswer = z.object({ askId: z.string(), answerId: z.string(), supplierId: Id, messageId: z.string(), intent: z.enum(['TERMS_AGREED', 'TERMS_COUNTER', 'TERMS_DECLINED', 'OTHER']), quote: z.string(),
  parsed: z.array(z.object({ dueOn: LocalDate.nullable(), amount: Money.nullable() })), matched: z.enum(['KEEP', 'SPLIT']).nullable(), state: z.enum(['OPEN', 'ACCEPTED', 'DECLINED']), at: UtcInstant });
export type SupplierAnswer = z.infer<typeof SupplierAnswer>;
export type DisputePending = z.infer<typeof DisputePending>;
export type DisputedAuthz = z.infer<typeof DisputedAuthz>;
export type DisputedAllowance = z.infer<typeof DisputedAllowance>;
export type ClaimSplit = z.infer<typeof ClaimSplit>;
/** SEEDED payment history behind relationship labels; never cash. */
export const HistoryEntry = z.object({ counterpartyId: Id, n: z.number().int(), kind: z.enum(['INVOICE_PAID', 'DISPUTE', 'ARRANGEMENT_MISSED', 'REMINDER_SENT']), ref: z.string(), dueOn: LocalDate, paidOn: LocalDate.nullable(), amount: Money, note: z.string().nullable(), open: z.boolean(), basis: z.enum(['SEEDED', 'LIVE']) });
export type HistoryEntry = z.infer<typeof HistoryEntry>;

export const PlanCheck = z.object({ key: z.string(), label: z.string(), result: z.enum(['PENDING', 'OK', 'NOTE']), detail: z.string().nullable() });
export const PlanBuild = z.object({
  buildId: Id, basisHash: z.string(), state: z.enum(PlanBuildStates), generation: z.number().int().positive(), basisStamp: z.number().int().nonnegative(),
  checks: z.array(PlanCheck), revisionId: Id.nullable(), failure: z.object({ kind: z.enum(['DATA', 'STALE']), reason: z.string() }).nullable(),
  attempts: z.array(z.object({ generation: z.number().int(), kind: z.string(), reason: z.string(), at: UtcInstant })), requestedAt: UtcInstant,
});
export type PlanBuild = z.infer<typeof PlanBuild>;

/** S7 R6 supplier ask options: KEEP the original date, or SPLIT into parts that sum to the obligation exactly. */
export const SupplierAskOption = z.object({ code: z.enum(['KEEP', 'SPLIT']), parts: z.array(z.object({ dueOn: LocalDate, amount: Money })).min(1).max(2) });
export type SupplierAskOption = z.infer<typeof SupplierAskOption>;
export const ActionKind = z.enum(['COLLECT_OVERDUE', 'COLLECT_UNDISPUTED_SLICE', 'COLLECT_DISPUTED', 'DISCOUNT_FALLBACK', 'PAYOUT', 'ASK_SUPPLIER']);
/** Why S5 held an approved action (S5-D9). heldReasons carries the sentence. */
export const HoldCode = z.enum(['PAUSED', 'YOU_TOOK_OVER', 'NOT_AUTHORIZED', 'INVOICE_NOT_PAYABLE', 'UPDATE_IN_FLIGHT', 'PROVIDER_CHANGED', 'DISPUTE_RAISED', 'DISPUTE_PENDING', 'RULES_CHANGED',
  // S6 payouts (§6.3, §6.17)
  'BILL_NOT_ACCEPTED', 'PAYEE_UNCONFIRMED', 'PAYEE_CHANGED', 'REMITTANCE_CHANGED', 'LIMIT_NEEDS_EXCEPTION', 'PAYMENTS_PAUSED', 'RAIL_SHORT', 'COMPANY_RESERVE',
  'WAITING_FOR_REPORT', 'EVIDENCE', 'PROVIDER_REFUSED', 'PAYOUT_UNRESOLVED', 'INPUTS_CHANGED', 'ALREADY_PAID', 'SPLIT_REFUSED', 'CONSENT_CHANGED']);
export type HoldCode = z.infer<typeof HoldCode>;
export type ActionKind = z.infer<typeof ActionKind>;
export const Citation = z.object({ n: z.number().int().positive(), kind: z.enum(['INVOICE', 'CLAIM', 'HISTORY', 'POLICY', 'FORECAST_DAY', 'BILL', 'TERMS', 'OBLIGATION']), id: z.string(), label: z.string(), detail: z.string() });
export type Citation = z.infer<typeof Citation>;
export const ActionTerms = z.object({
  amount: Money, contactOn: LocalDate.nullable(), replyCheckOn: LocalDate.nullable(), targetOn: LocalDate.nullable(),
  discountBp: z.number().int().nullable(), discountAmount: Money.nullable(), payBy: LocalDate.nullable(), expiresOn: LocalDate.nullable(), checkAt: UtcInstant.nullable(),
  /** S6 PAYOUT consent scope (§6.17 R4), inside the termsHash: face + fee ceiling, the exact payee version and the payment version. */
  maxDebit: Money.nullable().default(null),
  payee: z.object({ supplierId: Id, version: z.number().int().positive(), receiverSha256: z.string() }).nullable().default(null),
  paymentVersion: z.number().int().positive().nullable().default(null),
  /** S7 R6 ASK_SUPPLIER: the code-made options offered to the supplier (inside the termsHash). */
  askOptions: z.array(z.lazy(() => SupplierAskOption)).nullable().default(null),
});
export type ActionTerms = z.infer<typeof ActionTerms>;
export const PlanAction = z.object({
  actionId: Id, rootId: z.string(), revisionId: Id, kind: ActionKind,
  counterparty: z.object({ kind: z.enum(['CUSTOMER', 'SUPPLIER']), id: Id, name: z.string() }),
  subject: z.object({ invoiceId: Id.nullable(), occurrenceKey: z.string().nullable() }),
  terms: ActionTerms,
  /** Estimated PayPal fee and net on a target receipt (S4-D12, §6.17 R6). */
  estimate: z.object({ gross: Money, fee: Money, net: Money }).nullable(),
  condition: z.object({ kind: z.literal('VERIFIED_FUNDS_SHORT'), checkAt: UtcInstant, needBy: LocalDate, text: z.string() }).nullable(),
  late: z.string().nullable(),
  /** `codes`: the reasons (chosen by Nova or Headroom); `text` is rendered by code from them and the current terms (S4-IM-01/03). */
  why: z.object({ text: z.string(), codes: z.array(WhyCode), citations: z.array(z.number().int()), writtenBy: z.enum(['MODEL', 'TEMPLATE']) }),
  /** Greeting/closing codes are null for wording you wrote yourself. */
  message: z.object({ subject: z.string(), body: z.string(), writtenBy: z.enum(['MODEL', 'TEMPLATE', 'OWNER']), opening: Opening.nullable(), closing: Closing.nullable() }).nullable(),
  sources: z.array(Citation), alternatives: z.array(z.string()), authority: PolicyDecision,
  /** OUT with `consideredReason`: the planner left it out ("Considered, not used", Ask anyway). OUT with REMOVED: removed by you. */
  decision: z.enum(['IN', 'OUT']), consideredReason: z.string().nullable(), removedReason: z.string().nullable(), ownerEdited: z.array(z.string()), staleEdits: z.array(z.string()), heldReasons: z.array(z.string()),
  state: z.enum(ActionStates), termsHash: z.string(), version: z.number().int().positive(), order: z.number().int(),
  // S5 (defaults let S4-era stored actions read back)
  /** Moves only on approve, reapprove or an edit of terms/wording; due jobs carry it (S5-D24). action.version moves on every change. */
  intentVersion: z.number().int().nonnegative().default(0),
  holdCode: HoldCode.nullable().default(null),
  progress: z.object({ paidMinor: z.number().int().nonnegative(), ofMinor: z.number().int().positive() }).nullable().default(null),
  decideBy: UtcInstant.nullable().default(null),
  lastCheckId: z.string().nullable().default(null),
  /** OFFER only, once applied on PayPal (S5-D25). */
  expiry: z.object({ state: z.enum(OfferExpiryStates), at: UtcInstant, applyKey: z.string(), removeKey: z.string() }).nullable().default(null),
  followUpOf: z.string().nullable().default(null),
});
export type PlanAction = z.infer<typeof PlanAction>;
export const PlanRevision = z.object({
  revisionId: Id, n: z.number().int().positive(), state: z.enum(PlanRevisionStates), version: z.number().int().positive(), buildId: Id,
  basisHash: z.string(), basisStamp: z.number().int().nonnegative(),
  basisSnapshot: z.object({ needBy: LocalDate, gapMinor: z.number().int(), lowMinor: z.number().int(), lowOn: LocalDate, openingMinor: z.number().int(), policyVersion: z.number().int() }),
  trigger: z.string(), planner: z.object({ mode: z.enum(['MODEL', 'TEMPLATE']), reason: z.string().nullable(), summary: z.string() }),
  considered: z.array(z.object({ rootId: z.string(), title: z.string(), reasonCode: z.string(), reason: z.string(), canAsk: z.boolean(), sources: z.array(Citation) })),
  diff: z.array(z.object({ rootId: z.string(), change: z.enum(['ADDED', 'CHANGED', 'UNCHANGED', 'DROPPED']), detail: z.string() })).nullable(),
  approvals: z.number().int().nonnegative(),
  createdAt: UtcInstant, approvedAt: UtcInstant.nullable(), approvedBy: z.string().nullable(), rejectedAt: UtcInstant.nullable(), rejectedReason: z.string().nullable(),
});
export type PlanRevision = z.infer<typeof PlanRevision>;
export const Grant = z.object({
  grantId: Id, kind: GrantKind, revisionId: Id, approvalSeq: z.number().int().positive(), actionId: Id, rootId: z.string(), objectRef: z.string(), termsHash: z.string(),
  policyVersion: z.number().int(), scope: z.string(), by: z.string(), at: UtcInstant, expiresAt: UtcInstant, state: z.enum(GrantStates),
  revokedAt: UtcInstant.nullable(), lapsedReason: z.string().nullable(), carriedTo: z.array(Id),
  /** S5-D9: the effect whose dispatch claim spent this grant (set with CONSUMED, never otherwise). */
  consumedBy: z.string().nullable().default(null),
});
export type Grant = z.infer<typeof Grant>;

// ---------- S5 execution (S05 §6.3). Amounts are USD minor units. ----------

/** Frozen at the dispatch claim; reconcile and the bound removal act under it, never re-checking a spent grant (S5-D9). */
export const EffectAuthority = z.object({ kind: z.enum(['GRANT', 'POLICY', 'OWNER']), id: z.string().nullable(), policyVersion: z.number().int().nullable(), winningRule: z.string().nullable() });
export type EffectAuthority = z.infer<typeof EffectAuthority>;
export const UpdateKind = z.enum(['ENABLE_PARTIAL', 'APPLY_DISCOUNT', 'REMOVE_DISCOUNT']);
export type UpdateKind = z.infer<typeof UpdateKind>;
/** `EFFECT#upd#<rootId>#<intentVersion>#<kind>` (S5-D4). `request` and `preimage` are written once, at PREPARED. */
export const UpdateEffect = z.object({
  effectKey: z.string(), kind: UpdateKind, tenantId: Id, runId: Id, epoch: z.number().int(), invoiceId: Id, ppInvoiceId: z.string(), actionId: Id, rootId: z.string(),
  intentVersion: z.number().int().nonnegative(), state: z.enum(UpdateEffectStates), version: z.number().int().positive(),
  target: z.object({ minimumMinor: z.number().int().positive().nullable(), percentBp: z.number().int().positive().nullable(), noteLine: z.string().nullable() }),
  request: z.object({ rawRef: z.string(), method: z.literal('PUT'), pathAndQuery: z.string(), sha256: z.string() }).nullable(),
  preimage: z.object({ rawRef: z.string(), sha256: z.string(), lastUpdateTime: z.string().nullable(), status: z.string(), dueMinor: z.number().int().nullable() }).nullable(),
  notBefore: UtcInstant.nullable(), authority: EffectAuthority.nullable(), attempts: z.number().int().nonnegative(),
  unknownSince: UtcInstant.nullable(), providerStatus: z.string().nullable(), failure: z.string().nullable(), updatedAt: UtcInstant,
});
export type UpdateEffect = z.infer<typeof UpdateEffect>;

/** `CONCESSION#<invoiceId>#<applyKey>`: written only from the verified GET after a discount apply or removal (S5-D3). Not revenue, not a receipt. */
export const Concession = z.object({ invoiceId: Id, applyKey: z.string(), amount: Money, state: z.enum(['ACTIVE', 'REMOVED', 'SETTLED']), appliedBy: z.string(), removedBy: z.string().nullable(), settledBy: z.array(z.string()) });
export type Concession = z.infer<typeof Concession>;

/** Derived on read (S5-D3). The provider mirror is copied, never computed; `conservation` HOLD when collectibleOpen ≠ providerDue. */
export const InvoiceProjection = z.object({
  providerDue: Money.nullable(), providerStatus: z.string().nullable(), collectibleOpen: Money, undisputedOpen: Money.nullable(), disputedUnresolved: Money.nullable(),
  unallocatedCredit: Money.nullable(), concessions: Money, conservation: z.enum(['PASS', 'HOLD', 'UNKNOWN']),
});
export type InvoiceProjection = z.infer<typeof InvoiceProjection>;

/** `UPDLOCK#<invoiceId>`: one in-flight invoice update per invoice (S5-D4/D22). */
export const UpdLock = z.object({ invoiceId: Id, holder: z.string().nullable(), version: z.number().int().nonnegative() });
/** `CHECKRUN#<actionId>`: the skip check's lease; the action state does not change while checking (S5-D23). */
export const CheckRun = z.object({ actionId: Id, generation: z.number().int().nonnegative(), holder: z.string().nullable(), leaseUntil: UtcInstant.nullable(), phase: z.enum(['EVIDENCE', 'EVALUATE', 'DONE']) });
/** `OWNERAUTH#<actionId>#<checkId>`: single-use owner authority for "Send offer" (S5-D9). */
export const OwnerAuth = z.object({ actionId: Id, checkId: z.string(), termsHash: z.string(), state: z.enum(OwnerAuthStates), consumedBy: z.string().nullable(), by: z.string(), at: UtcInstant });
/** `EXPIRY#<invoiceId>#<applyKey>`: the removal bound to an applied discount, independent of revision and policy (S5-D25). */
export const OfferExpiry = z.object({ invoiceId: Id, applyKey: z.string(), at: UtcInstant, removeKey: z.string(), authority: EffectAuthority, ownerRevisionId: Id });

export const SkipDecision = z.enum(['SKIP', 'HELD_EVIDENCE', 'NEEDED', 'HELD']);
export const SkipBlocker = z.object({ code: z.string(), text: z.string(), ref: z.string().nullable() });
export const SeriesPoint = z.object({ on: LocalDate, closeMinor: z.number().int() });
/** `CHECK#<actionId>#<generation>`: one immutable C-SKIP-1 evaluation (S5-D7). */
export const SkipCheck = z.object({
  checkId: z.string(), actionId: Id, generation: z.number().int().positive(), at: UtcInstant,
  early: z.object({ by: z.string(), scheduledAt: UtcInstant }).nullable(),
  stamps: z.object({ plan: z.number().int(), paypal: z.number().int(), bank: z.number().int() }),
  refreshes: z.array(z.object({ resource: z.string(), requestRef: z.string(), completedAt: UtcInstant.nullable(), ok: z.boolean() })),
  inputs: z.object({
    bank: z.object({ amountMinor: z.number().int().nullable(), retrievedAt: UtcInstant.nullable(), accountIds: z.array(z.string()) }),
    paypal: z.object({ lowerMinor: z.number().int().nullable(), upperMinor: z.number().int().nullable(), asOf: UtcInstant.nullable(), fetchedAt: UtcInstant.nullable(), reconciliation: z.string(), captureIds: z.array(z.string()) }),
    obligations: z.array(z.object({ key: z.string(), on: LocalDate, amountMinor: z.number().int() })),
    reserveMinor: z.number().int(),
  }),
  lowerSeries: z.array(SeriesPoint).length(42).nullable(), upperSeries: z.array(SeriesPoint).length(42).nullable(),
  lowerMin: SeriesPoint.nullable(), upperMin: SeriesPoint.nullable(),
  blockers: z.array(SkipBlocker), decision: SkipDecision,
});
export type SkipCheck = z.infer<typeof SkipCheck>;

/** `THREAD#<customerId>`: who talks to the customer (S5-D10). YOU = the owner took over; Headroom writes nothing for them. */
export const Thread = z.object({ customerId: Id, owner: z.enum(['HEADROOM', 'YOU']), by: z.string(), at: UtcInstant, seenVersion: z.number().int().nonnegative(), version: z.number().int().positive() });
export type Thread = z.infer<typeof Thread>;
/** `MATCH#<bankTxId>`: the owner's label on a bank PayPal-transfer candidate. Moves no cash, creates no receipt (S5-D15). */
export const MatchAnswer = z.object({ bankTxId: z.string(), answer: z.enum(['TRANSFER', 'NOT_TRANSFER']), by: z.string(), at: UtcInstant, version: z.number().int().positive() });
export type MatchAnswer = z.infer<typeof MatchAnswer>;

// ---------- S5 mail (S5-D1, D19–D21). The only channel in S5 is SIMULATED: never delivery evidence. ----------
/** `OUTMSG#<rootId>#<intentVersion>`: one per outreach intent; its Message-ID comes from the root, so no revision mints a second one. */
export const OutboundMessage = z.object({
  rootId: z.string(), intentVersion: z.number().int().nonnegative(), actionId: Id, customerId: Id, counterpartyRole: z.enum(['CUSTOMER', 'SUPPLIER']).optional(), state: z.enum(OutMsgStates), held: z.boolean(), version: z.number().int().positive(),
  rfcMessageId: z.string(), effectKey: z.string(), subject: z.string(), to: z.string(),
  /** TEST_REDIRECT (S5-D26): the customer address it was prepared for; that customer is never contacted. null = sent to `to` directly. */
  preparedFor: z.string().nullable(), rawB64: z.string().nullable(), rawSha256: z.string().nullable(),
  channel: z.enum(['SIMULATED', 'GMAIL']), sentMessageId: z.string().nullable(), threadId: z.string().nullable(), reason: z.string().nullable(), updatedAt: UtcInstant,
});
export type OutboundMessage = z.infer<typeof OutboundMessage>;
export const MailEffect = z.object({ effectKey: z.string(), tenantId: Id, runId: Id, epoch: z.number().int(), actionId: Id, rootId: z.string(), intentVersion: z.number().int(), state: z.enum(MailEffectStates), version: z.number().int().positive(), authority: EffectAuthority.nullable(), unknownSince: UtcInstant.nullable(), failure: z.string().nullable(), updatedAt: UtcInstant });
export type MailEffect = z.infer<typeof MailEffect>;
/** `MAIL#<messageId>`: an inbound message, written once with its downstream work in the same TX (S5-PR-09). */
export const MailMessage = z.object({
  messageId: z.string(), threadId: z.string(), rfcMessageId: z.string().nullable(), direction: z.literal('IN'), channel: z.enum(['SIMULATED', 'GMAIL']),
  from: z.string(), subject: z.string(), receivedAt: UtcInstant, rawSha256: z.string(), storageKey: z.string(),
  authVerdict: z.object({ source: z.enum(['SIMULATED', 'PROVIDER']), dkim: z.string(), spf: z.string(), dmarc: z.string() }).nullable(),
  attachments: z.array(z.object({ name: z.string(), mime: z.string(), sha256: z.string() })),
  processing: z.enum(['ROUTED', 'HELD', 'UNFILED']), binding: z.object({ runId: Id, rootId: z.string().nullable(), customerId: Id.nullable(), invoiceId: Id.nullable().optional() }),
  heldCode: z.string().nullable(), interpretation: z.object({ intent: z.string(), quote: z.string(), on: LocalDate.nullable(), amountMinor: z.number().int().nullable(), refused: z.string().nullable() }).nullable(),
  seen: z.boolean(),
});
export type MailMessage = z.infer<typeof MailMessage>;
/** `PROMISE#<messageId>`: forecast-only (Expected, basis PROMISE); never Cash, Downside or the skip check (IC-2). */
/** S7 §6.1a `ar.newDateDays`: `beyondLimitDays` set = the promised date is past the owner's limit; it counts only once `acceptedBy` is set. */
export const PromiseRecord = z.object({ promiseId: z.string(), invoiceId: Id, customerId: Id, amount: Money.nullable(), on: LocalDate, quote: z.string(), sourceMessageId: z.string(), basis: z.literal('PROMISE'), at: UtcInstant,
  beyondLimitDays: z.number().int().nullable().optional(), acceptedBy: z.object({ by: z.string(), at: UtcInstant }).nullable().optional() });
export type PromiseRecord = z.infer<typeof PromiseRecord>;
/** Strict ReplyInterpreter output: facts only as verbatim quotes; code parses dates and amounts (S5-D20). */
/** S7 R4: DISPUTE_PARTIAL carries `amountQuotes` — each the exact words of one amount; code parses and checks they sum to what is open. */
export const ReplyInterpreterOutput = z.object({ intent: z.enum(['PROMISE', 'ACKNOWLEDGE_UNDISPUTED', 'DISPUTE', 'DISPUTE_PARTIAL', 'PAID_CLAIM', 'QUESTION', 'OTHER', 'TERMS_AGREED', 'TERMS_COUNTER', 'TERMS_DECLINED']),
  /** S7 R6 supplier answers: each payment part as the exact words of its date and amount. */
  termsQuotes: z.array(z.object({ date: z.string().max(80).nullable(), amount: z.string().max(80).nullable() }).strict()).max(3).nullable().optional(), quote: z.string().max(500), quotedDate: z.string().max(80).nullable(), quotedAmount: z.string().max(80).nullable(),
  amountQuotes: z.object({ disputed: z.string().max(80).nullable(), undisputed: z.string().max(80).nullable() }).nullable().optional() }).strict();

// ---------- S6 payouts (S06 §6.3, §6.17). Amounts are USD minor units. ----------

/** `PAYEE#<supplierId>` in the run partition. The raw address lives only here and in the frozen request bytes; reads show `masked`. */
export const Payee = z.object({
  supplierId: Id, rail: z.literal('PAYPAL'), receiverType: z.literal('EMAIL'), receiverSha256: z.string(), masked: z.string(), version: z.number().int().positive(),
  state: z.enum(PayeeStates), source: z.literal('SEEDED'), confirmedBy: z.string().nullable(), confirmedAt: UtcInstant.nullable(),
});
export type Payee = z.infer<typeof Payee>;

/**
 * `EFFECT#pay:<tenant>:<run>:<occurrenceKey>:v<paymentVersion>:a<attempt>`: the unique payment intent and its executor state in one record.
 * `senderBatchId` and the request bytes are frozen at the queue TX and never change (S6-D6, D16).
 */
export const PayoutEffect = z.object({
  effectKey: z.string(), tenantId: Id, runId: Id, epoch: z.number().int(), connectionId: Id, actionId: Id, rootId: z.string(), occurrenceKey: z.string(), supplierId: Id,
  paymentVersion: z.number().int().positive(), attempt: z.number().int().positive(), intentVersion: z.number().int().nonnegative(),
  state: z.enum(PayoutEffectStates), version: z.number().int().positive(),
  amount: Money, feeCeiling: Money, maxDebit: Money, payee: z.object({ version: z.number().int().positive(), receiverSha256: z.string(), masked: z.string() }), termsHash: z.string(),
  senderBatchId: z.string().max(30), request: z.object({ sha256: z.string() }), chargedDate: LocalDate,
  firstDispatchAt: UtcInstant.nullable(), mutationDeadline: UtcInstant.nullable(), authority: z.array(EffectAuthority),
  batchId: z.string().nullable(), itemId: z.string().nullable(), itemStatus: z.string().nullable(), transactionId: z.string().nullable(), fee: Money.nullable(), timeProcessed: UtcInstant.nullable(),
  attempts: z.number().int().nonnegative(), unknownSince: UtcInstant.nullable(), failure: z.string().nullable(), heldReason: z.string().nullable(),
  timeline: z.array(z.object({ at: UtcInstant, event: z.string(), ref: z.string().nullable() })), updatedAt: UtcInstant,
});
export type PayoutEffect = z.infer<typeof PayoutEffect>;

/**
 * `RESV#<effectKey>` on the PayPal connection partition (hr_provider): survives resets with the money it guards (S6-D13).
 * `debitMinor` = face + fee ceiling while ACTIVE; face + actual fee once SETTLED. Subtracted from the C-BAL-1 bounds by residual (R2).
 */
export const Reservation = z.object({
  effectKey: z.string(), tenantId: Id, runId: Id, occurrenceKey: z.string(), state: z.enum(ReservationStates), faceMinor: z.number().int().positive(), debitMinor: z.number().int().positive(),
  transactionId: z.string().nullable(), itemId: z.string().nullable(), version: z.number().int().positive(),
});
export type Reservation = z.infer<typeof Reservation>;

/** `PAYRET#<itemId>#<status>` (hr_provider): a separate credit after SUCCESS (R6). Amount unknown until PayPal's report shows it. */
export const PayoutReturn = z.object({ itemId: z.string(), status: z.enum(['REFUNDED', 'RETURNED', 'REVERSED']), effectKey: z.string(), tenantId: Id, runId: Id, observedAt: UtcInstant, amountMinor: z.number().int().nullable() });
export type PayoutReturn = z.infer<typeof PayoutReturn>;
