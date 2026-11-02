// Allowed transitions as data (S01 §6.3). Code that changes a state calls assertTransition,
// and states.test.ts checks every listed state is reachable and every used edge is listed.

export const InvoiceStates = ['DRAFT', 'ISSUING', 'ISSUED', 'ISSUE_UNKNOWN', 'FAILED', 'PARTIALLY_PAID', 'PAID'] as const;
export const EffectStates = [
  'READY', 'CREATE_DISPATCHED', 'CREATED', 'SEND_DISPATCHED', 'SENT', 'VERIFIED_SUCCESS', 'VERIFIED_FAILURE', 'UNKNOWN',
] as const;
export const JobStates = ['QUEUED', 'LEASED', 'DONE', 'DEAD'] as const;
export const RunStates = ['PREPARING', 'READY', 'BLOCKED', 'SEALED'] as const;
export const BankConnectionStates = ['SYNCING', 'HEALTHY', 'RECONNECT_REQUIRED', 'REVOKED', 'DISCONNECTING', 'DISCONNECTED'] as const;
export const BankBindingStates = ['CONNECTING', 'BOUND', 'RELEASED'] as const;
export const BankEffectStates = [
  'READY', 'CREATE_DISPATCHED', 'CREATED', 'EXCHANGE_DISPATCHED', 'EXCHANGED', 'REMOVE_DISPATCHED',
  'VERIFIED_SUCCESS', 'VERIFIED_FAILURE', 'UNKNOWN', 'ABANDONED',
] as const;
/** S3 bills (S03 §6.3). HELD is terminal in S3; S4/S6 add exits. */
/** SUPERSEDED (S3-IM-02): a later revision with the same supplier + bill number replaced it; terminal and non-actionable, kept as history. */
export const BillStates = ['RECEIVED', 'PROPOSED', 'HELD', 'READ_FAILED', 'VERIFIED', 'TERMS_ACCEPTED', 'SUPERSEDED'] as const;
/** S6 (§6.17 R6): PAID only from a verified item-SUCCESS TX; REOPENED only from a return event; a new payment needs paymentVersion + 1. */
export const ObligationStates = ['SCHEDULED', 'PAID', 'REOPENED'] as const;
/** S4 plan (S04 §6.3, §6.17 R2/R4/R8). FAILED → BUILDING is a fenced retry; DONE → BUILDING only after its revision was rejected. */
export const PlanBuildStates = ['BUILDING', 'DONE', 'FAILED'] as const;
export const PlanRevisionStates = ['DRAFT', 'RUNNING', 'SUPERSEDED', 'REJECTED'] as const;
/**
 * S4 states + S5 execution states (S05 §6.3). There is no CHECKING state: a skip check holds a CHECKRUN# lease (S5-D23).
 * Executed or in-flight states (QUEUED onward) have no REMOVED, SUPERSEDED or edit edge (S5-D12): they persist across revisions.
 */
export const ActionStates = [
  'PROPOSED', 'REMOVED', 'SCHEDULED', 'WAITING_CONDITION', 'HELD', 'SUPERSEDED',
  'QUEUED', 'APPLIED', 'UNCERTAIN', 'COMPLETED', 'FAILED', 'SKIPPED_NOT_NEEDED', 'HELD_EVIDENCE', 'CANCELLED', 'EXPIRED',
] as const;
/** EXPIRED is computed on read from expiresAt, never stored. CONSUMED (S5-D9): spent by exactly one effect's dispatch claim. */
export const GrantStates = ['ACTIVE', 'REVOKED', 'LAPSED', 'CONSUMED'] as const;
/** S5-D9: the owner's single-use "Send offer" at decideBy. VOID when the check it answered is superseded. */
export const OwnerAuthStates = ['ACTIVE', 'CONSUMED', 'VOID'] as const;
/** S5-D4 invoice-update effects (enable partial, apply/remove discount). PREPARED = request bytes + preimage frozen, nothing sent. */
export const UpdateEffectStates = ['READY', 'PREPARED', 'DISPATCHED', 'VERIFIED_SUCCESS', 'VERIFIED_FAILURE', 'UNKNOWN', 'CONFLICT'] as const;
/** S5-D25: the bound removal of an applied discount. RELEASED = paid before the end, removal never sent. */
export const OfferExpiryStates = ['SCHEDULED', 'HELD_PAUSED', 'HELD_TAKEOVER', 'REMOVED', 'CONFLICT', 'RELEASED'] as const;
/** S5-D19 outbound message (OUTMSG#<rootId>#<intentVersion>). SENT only after the channel's get confirms it; SEND_UNKNOWN is never resent. */
export const OutMsgStates = ['DRAFT', 'QUEUED', 'SENDING', 'SENT', 'SEND_UNKNOWN', 'FAILED', 'NOT_SENT'] as const;
/** S5-D19 mail send effect (EFFECT#mail:<Message-ID>). UNKNOWN resolves only by search, never by a resend. */
export const MailEffectStates = ['READY', 'DISPATCHED', 'VERIFIED_SUCCESS', 'VERIFIED_FAILURE', 'UNKNOWN'] as const;
/**
 * S6 payout effect (`EFFECT#pay:…`, §6.17 R5–R7). READY/HELD_READY were never claimed: only they can be released (CANCELLED_UNSENT).
 * REJECTED = the first dispatch's own synchronous 4xx with no batch. Only an item SUCCESS bound to the frozen request is PAID.
 */
export const PayoutEffectStates = [
  'READY', 'HELD_READY', 'CANCELLED_UNSENT', 'DISPATCHED', 'SUBMITTED', 'UNKNOWN', 'UNKNOWN_UNRESOLVED', 'REJECTED',
  'NOT_PAID', 'HOLD', 'PAID', 'NOT_PAID_FINAL', 'REFUNDED',
] as const;
/** S6 reservation on the merchant (`RESV#`, hr_provider). REPORTED is computed on read from PayPal's report (R2), never stored. */
export const ReservationStates = ['ACTIVE', 'SETTLED', 'RELEASED'] as const;
/** S6 payee identity (`PAYEE#`). A new version always starts UNCONFIRMED. */
export const PayeeStates = ['UNCONFIRMED', 'CONFIRMED'] as const;

export type InvoiceState = (typeof InvoiceStates)[number];
export type EffectState = (typeof EffectStates)[number];
export type JobState = (typeof JobStates)[number];
export type RunState = (typeof RunStates)[number];
export type BankConnectionState = (typeof BankConnectionStates)[number];
export type BankBindingState = (typeof BankBindingStates)[number];
export type BankEffectState = (typeof BankEffectStates)[number];
export type BillState = (typeof BillStates)[number];
export type ObligationState = (typeof ObligationStates)[number];
export type PlanBuildState = (typeof PlanBuildStates)[number];
export type PlanRevisionState = (typeof PlanRevisionStates)[number];
export type ActionState = (typeof ActionStates)[number];
export type GrantState = (typeof GrantStates)[number];
export type OwnerAuthState = (typeof OwnerAuthStates)[number];
export type UpdateEffectState = (typeof UpdateEffectStates)[number];
export type OfferExpiryState = (typeof OfferExpiryStates)[number];
export type OutMsgState = (typeof OutMsgStates)[number];
export type MailEffectState = (typeof MailEffectStates)[number];
export type PayoutEffectState = (typeof PayoutEffectStates)[number];
export type ReservationState = (typeof ReservationStates)[number];
export type PayeeState = (typeof PayeeStates)[number];

export const transitions = {
  Invoice: {
    DRAFT: ['ISSUING'],
    ISSUING: ['ISSUED', 'ISSUE_UNKNOWN', 'FAILED'],
    ISSUE_UNKNOWN: ['ISSUED', 'FAILED'],
    ISSUED: ['PARTIALLY_PAID', 'PAID'],
    PARTIALLY_PAID: ['PARTIALLY_PAID', 'PAID'],
    PAID: [],
    FAILED: [],
  },
  Effect: {
    READY: ['CREATE_DISPATCHED', 'VERIFIED_FAILURE'],
    CREATE_DISPATCHED: ['CREATED', 'VERIFIED_FAILURE', 'UNKNOWN'],
    CREATED: ['SEND_DISPATCHED', 'UNKNOWN'],
    SEND_DISPATCHED: ['SENT', 'VERIFIED_FAILURE', 'UNKNOWN'],
    SENT: ['VERIFIED_SUCCESS', 'UNKNOWN'],
    UNKNOWN: ['CREATED', 'SENT', 'VERIFIED_SUCCESS', 'VERIFIED_FAILURE'],
    VERIFIED_SUCCESS: [],
    VERIFIED_FAILURE: [],
  },
  Job: {
    QUEUED: ['LEASED'],
    LEASED: ['DONE', 'QUEUED', 'DEAD'],
    DONE: [],
    DEAD: [],
  },
  Run: {
    PREPARING: ['READY', 'BLOCKED'],
    READY: ['SEALED'],
    BLOCKED: ['SEALED'],
    SEALED: [],
  },
  // S02 §6.3. Nothing leaves DISCONNECTING except DISCONNECTED, so a removed connection can't be resurrected.
  BankConnection: {
    SYNCING: ['HEALTHY', 'RECONNECT_REQUIRED', 'REVOKED', 'DISCONNECTING'],
    HEALTHY: ['RECONNECT_REQUIRED', 'REVOKED', 'DISCONNECTING'],
    RECONNECT_REQUIRED: ['HEALTHY', 'REVOKED', 'DISCONNECTING'],
    REVOKED: ['DISCONNECTING'],
    DISCONNECTING: ['DISCONNECTED'],
    DISCONNECTED: [],
  },
  /** The run's single bank slot (CONN#plaid). RELEASED is "may connect again". */
  BankBinding: {
    CONNECTING: ['BOUND', 'RELEASED'],
    BOUND: ['RELEASED'],
    RELEASED: ['CONNECTING'],
  },
  /** BANK_CONNECT / BANK_SEED / BANK_REMOVE executor effects (S02 §6.2a). ABANDONED is an owner command on BANK_CONNECT only. */
  BankEffect: {
    READY: ['CREATE_DISPATCHED', 'EXCHANGE_DISPATCHED', 'REMOVE_DISPATCHED', 'VERIFIED_FAILURE'],
    CREATE_DISPATCHED: ['CREATED', 'VERIFIED_FAILURE', 'UNKNOWN'],
    CREATED: ['EXCHANGE_DISPATCHED', 'UNKNOWN'],
    EXCHANGE_DISPATCHED: ['EXCHANGED', 'VERIFIED_FAILURE', 'UNKNOWN'],
    EXCHANGED: ['VERIFIED_SUCCESS'],
    REMOVE_DISPATCHED: ['VERIFIED_SUCCESS', 'UNKNOWN'],
    UNKNOWN: ['EXCHANGED', 'VERIFIED_SUCCESS', 'VERIFIED_FAILURE', 'ABANDONED'],
    VERIFIED_SUCCESS: [],
    VERIFIED_FAILURE: [],
    ABANDONED: [],
  },
  /** PROPOSED → TERMS_ACCEPTED only by the separate-obligation path, which writes verification and terms as two records (T8a). READ_FAILED → RECEIVED is an owner retry. */
  Bill: {
    // RECEIVED → VERIFIED: an exact match verified by Headroom under Delegation (S4-D17); it changes no terms and permits no payment.
    RECEIVED: ['PROPOSED', 'HELD', 'READ_FAILED', 'VERIFIED'],
    READ_FAILED: ['RECEIVED'],
    PROPOSED: ['VERIFIED', 'TERMS_ACCEPTED', 'SUPERSEDED'],
    VERIFIED: ['TERMS_ACCEPTED', 'SUPERSEDED'],
    HELD: [],
    TERMS_ACCEPTED: [],
    SUPERSEDED: [],
  },
  Obligation: { SCHEDULED: ['PAID'], PAID: ['REOPENED'], REOPENED: ['PAID'] },
  PlanBuild: { BUILDING: ['DONE', 'FAILED'], FAILED: ['BUILDING'], DONE: ['BUILDING'] },
  PlanRevision: { DRAFT: ['RUNNING', 'REJECTED', 'SUPERSEDED'], RUNNING: ['SUPERSEDED'], SUPERSEDED: [], REJECTED: [] },
  Action: {
    PROPOSED: ['REMOVED', 'SCHEDULED', 'WAITING_CONDITION', 'HELD', 'SUPERSEDED'],
    REMOVED: ['PROPOSED', 'SUPERSEDED'],
    // → HELD_EVIDENCE: a payout at its PAY job waiting for PayPal's report or fresh balances (S6-D5).
    SCHEDULED: ['PROPOSED', 'REMOVED', 'SUPERSEDED', 'QUEUED', 'HELD', 'COMPLETED', 'CANCELLED', 'HELD_EVIDENCE'],
    WAITING_CONDITION: ['PROPOSED', 'REMOVED', 'SUPERSEDED', 'SKIPPED_NOT_NEEDED', 'HELD_EVIDENCE', 'HELD', 'QUEUED', 'CANCELLED', 'EXPIRED'],
    HELD_EVIDENCE: ['HELD_EVIDENCE', 'SKIPPED_NOT_NEEDED', 'QUEUED', 'HELD', 'CANCELLED', 'EXPIRED', 'PROPOSED', 'REMOVED', 'SUPERSEDED'],
    // HELD → QUEUED: a payout whose hold cleared at its PAY/RECHECK job (S6-D5).
    HELD: ['PROPOSED', 'SCHEDULED', 'WAITING_CONDITION', 'HELD_EVIDENCE', 'REMOVED', 'SUPERSEDED', 'COMPLETED', 'CANCELLED', 'QUEUED'],
    QUEUED: ['APPLIED', 'UNCERTAIN', 'FAILED', 'HELD'],
    UNCERTAIN: ['APPLIED', 'FAILED', 'HELD'],
    APPLIED: ['COMPLETED', 'EXPIRED', 'FAILED'], // → FAILED: a submitted payout whose item failed definitively (S6-D8)
    SUPERSEDED: [], COMPLETED: [], FAILED: [], SKIPPED_NOT_NEEDED: [], CANCELLED: [], EXPIRED: [],
  },
  Grant: { ACTIVE: ['REVOKED', 'LAPSED', 'CONSUMED'], REVOKED: [], LAPSED: [], CONSUMED: [] },
  OwnerAuth: { ACTIVE: ['CONSUMED', 'VOID'], CONSUMED: [], VOID: [] },
  UpdateEffect: {
    READY: ['PREPARED', 'VERIFIED_SUCCESS', 'VERIFIED_FAILURE'], // → VERIFIED_SUCCESS only when a GET shows it already done (no write)
    PREPARED: ['DISPATCHED', 'READY', 'VERIFIED_FAILURE'],
    DISPATCHED: ['VERIFIED_SUCCESS', 'VERIFIED_FAILURE', 'UNKNOWN', 'CONFLICT'],
    UNKNOWN: ['VERIFIED_SUCCESS', 'VERIFIED_FAILURE', 'CONFLICT', 'UNKNOWN'],
    VERIFIED_SUCCESS: [], VERIFIED_FAILURE: [], CONFLICT: [],
  },
  OfferExpiry: {
    SCHEDULED: ['REMOVED', 'HELD_PAUSED', 'HELD_TAKEOVER', 'CONFLICT', 'RELEASED'],
    HELD_PAUSED: ['SCHEDULED', 'RELEASED'], HELD_TAKEOVER: ['SCHEDULED', 'RELEASED'],
    REMOVED: [], CONFLICT: [], RELEASED: [],
  },
  OutMsg: {
    DRAFT: ['QUEUED', 'NOT_SENT'],
    QUEUED: ['SENDING', 'DRAFT', 'NOT_SENT'], // → DRAFT: held before the send claim; nothing sent, same Message-ID
    SENDING: ['SENT', 'SEND_UNKNOWN', 'FAILED'],
    SEND_UNKNOWN: ['SENT'],
    SENT: [], FAILED: [], NOT_SENT: [],
  },
  MailEffect: {
    READY: ['DISPATCHED', 'VERIFIED_FAILURE'],
    DISPATCHED: ['VERIFIED_SUCCESS', 'VERIFIED_FAILURE', 'UNKNOWN'],
    UNKNOWN: ['VERIFIED_SUCCESS'],
    VERIFIED_SUCCESS: [], VERIFIED_FAILURE: [],
  },
  PayoutEffect: {
    READY: ['DISPATCHED', 'HELD_READY', 'CANCELLED_UNSENT'],
    HELD_READY: ['READY', 'CANCELLED_UNSENT'],
    DISPATCHED: ['SUBMITTED', 'UNKNOWN', 'REJECTED'],
    UNKNOWN: ['SUBMITTED', 'UNKNOWN', 'UNKNOWN_UNRESOLVED'],
    UNKNOWN_UNRESOLVED: ['SUBMITTED'],
    SUBMITTED: ['PAID', 'NOT_PAID', 'NOT_PAID_FINAL', 'HOLD'],
    NOT_PAID: ['PAID', 'NOT_PAID', 'NOT_PAID_FINAL', 'HOLD'],
    HOLD: ['PAID', 'NOT_PAID', 'NOT_PAID_FINAL'],
    PAID: ['REFUNDED'],
    CANCELLED_UNSENT: [], REJECTED: [], NOT_PAID_FINAL: [], REFUNDED: [],
  },
  Reservation: { ACTIVE: ['SETTLED', 'RELEASED'], SETTLED: [], RELEASED: [] },
  Payee: { UNCONFIRMED: ['CONFIRMED'], CONFIRMED: [] },
} as const satisfies {
  Invoice: Record<InvoiceState, readonly InvoiceState[]>;
  Effect: Record<EffectState, readonly EffectState[]>;
  Job: Record<JobState, readonly JobState[]>;
  Run: Record<RunState, readonly RunState[]>;
  BankConnection: Record<BankConnectionState, readonly BankConnectionState[]>;
  BankBinding: Record<BankBindingState, readonly BankBindingState[]>;
  BankEffect: Record<BankEffectState, readonly BankEffectState[]>;
  Bill: Record<BillState, readonly BillState[]>;
  Obligation: Record<ObligationState, readonly ObligationState[]>;
  PlanBuild: Record<PlanBuildState, readonly PlanBuildState[]>;
  PlanRevision: Record<PlanRevisionState, readonly PlanRevisionState[]>;
  Action: Record<ActionState, readonly ActionState[]>;
  Grant: Record<GrantState, readonly GrantState[]>;
  OwnerAuth: Record<OwnerAuthState, readonly OwnerAuthState[]>;
  UpdateEffect: Record<UpdateEffectState, readonly UpdateEffectState[]>;
  OfferExpiry: Record<OfferExpiryState, readonly OfferExpiryState[]>;
  OutMsg: Record<OutMsgState, readonly OutMsgState[]>;
  MailEffect: Record<MailEffectState, readonly MailEffectState[]>;
  PayoutEffect: Record<PayoutEffectState, readonly PayoutEffectState[]>;
  Reservation: Record<ReservationState, readonly ReservationState[]>;
  Payee: Record<PayeeState, readonly PayeeState[]>;
};

export type Machine = keyof typeof transitions;

export function canTransition(machine: Machine, from: string, to: string): boolean {
  const edges = (transitions[machine] as Record<string, readonly string[]>)[from];
  return !!edges && edges.includes(to);
}

export function assertTransition(machine: Machine, from: string, to: string): void {
  if (!canTransition(machine, from, to)) throw new Error(`illegal ${machine} transition ${from} → ${to}`);
}

/** Effect states that mean a provider call may have gone out and its outcome is not yet definitive. */
export const IN_FLIGHT_EFFECT_STATES: readonly EffectState[] = ['CREATE_DISPATCHED', 'CREATED', 'SEND_DISPATCHED', 'SENT'];
export const TERMINAL_EFFECT_STATES: readonly EffectState[] = ['VERIFIED_SUCCESS', 'VERIFIED_FAILURE'];
export const IN_FLIGHT_BANK_EFFECT_STATES: readonly BankEffectState[] = ['CREATE_DISPATCHED', 'CREATED', 'EXCHANGE_DISPATCHED', 'EXCHANGED', 'REMOVE_DISPATCHED'];
export const TERMINAL_BANK_EFFECT_STATES: readonly BankEffectState[] = ['VERIFIED_SUCCESS', 'VERIFIED_FAILURE', 'ABANDONED'];
/** Connection states whose figures may count and whose sync commits are allowed (S2-PR-03/04). */
export const BANK_ACTIVE_STATES: readonly BankConnectionState[] = ['SYNCING', 'HEALTHY', 'RECONNECT_REQUIRED'];
/** S5-D12: an action in one of these states was dispatched, executed or finished. It is never edited, removed, superseded or re-proposed. */
export const EXECUTED_ACTION_STATES: readonly ActionState[] = ['QUEUED', 'APPLIED', 'UNCERTAIN', 'COMPLETED', 'FAILED', 'SKIPPED_NOT_NEEDED', 'CANCELLED', 'EXPIRED'];
export const IN_FLIGHT_UPDATE_STATES: readonly UpdateEffectState[] = ['PREPARED', 'DISPATCHED', 'UNKNOWN'];
export const TERMINAL_UPDATE_STATES: readonly UpdateEffectState[] = ['VERIFIED_SUCCESS', 'VERIFIED_FAILURE', 'CONFLICT'];
/** S6: a payout whose provider outcome isn't settled yet; any one on the connection blocks the C-SKIP-1 skip (AT-F06, §6.17 R1). */
export const UNRESOLVED_PAYOUT_STATES: readonly PayoutEffectState[] = ['DISPATCHED', 'UNKNOWN', 'UNKNOWN_UNRESOLVED', 'SUBMITTED', 'NOT_PAID', 'HOLD'];
/** S6: never claimed, so releasable (R7). */
export const UNSENT_PAYOUT_STATES: readonly PayoutEffectState[] = ['READY', 'HELD_READY'];
export const TERMINAL_PAYOUT_STATES: readonly PayoutEffectState[] = ['CANCELLED_UNSENT', 'REJECTED', 'NOT_PAID_FINAL', 'PAID', 'REFUNDED'];
