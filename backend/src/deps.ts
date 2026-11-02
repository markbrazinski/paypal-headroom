import type { Queue } from './adapters/queue/port.ts';
import type { Store } from './adapters/store/port.ts';
import type { Grant, PayPalReader, PayPalWriter } from './adapters/paypal/types.ts';
import type { PlaidLinkTokenClient, PlaidReader } from './adapters/plaid/clients.ts';
import type { PlaidConnector } from './adapters/plaid/connector.ts';
import type { Vault } from './adapters/vault.ts';
import type { EvidenceStore } from './adapters/evidence-store/port.ts';
import type { Interpreter } from './adapters/bedrock/converse.ts';
import type { MailChannel } from './adapters/mail/types.ts';

export interface Config {
  stage: 'local' | 'dev' | 'review';
  connectionId: string;
  merchantEmail: string;
  webhookId: string | null;
  grant: Grant | null;
  /** S5-D26: which mail channel this deployment uses (no secrets). The API reads the connection's state from the store. */
  mail?: { kind: 'GMAIL' | 'SIMULATED' | 'NONE'; sender: string | null; inbox: string | null };
  /** S6-D1: the registered sandbox receiver seeded as Keller's payee at reset (operator/worker only; never in an API response). */
  payoutReceiver?: string | null;
}

/** Test seams for crash and race cases (S1-R17, R18, R19). A hook that throws simulates process death. */
export interface Hooks {
  afterJobClaim?: (jobId: string) => Promise<void>;
  afterCreate?: () => Promise<void>;
  afterSend?: () => Promise<void>;
  beforeVerifyCommit?: () => Promise<void>;
  afterWebhookCommit?: () => Promise<void>;
  /** S2: between a Plaid exchange/create 200 and its result-capture write (S2-R22b). */
  afterBankResult?: (effectKey: string) => Promise<void>;
  /** S2: before each sync commit (stage | publish | balance | error), for fence and lease races (S2-R25/R26). */
  beforeBankCommit?: (phase: 'stage' | 'publish' | 'balance' | 'error') => Promise<void>;
  /** S3: after the model answered and before the ingest's final commit (lease-loss and retry-race cases, S3-R34). */
  beforeIngestCommit?: (billId: string) => Promise<void>;
  /** S4: before a plan build's final publish (stale-basis, lease-loss and reset races, §6.17 R1/R8). */
  beforePlanPublish?: (buildId: string) => Promise<void>;
  /** S4: a data failure while building (retry case, §6.17 R8). */
  planBuildFault?: () => string | null;
  /** S5: between a skip check's calculation and its decide TX (funds-fence races, S5-PR-02). */
  beforeSkipDecide?: (actionId: string) => Promise<void>;
  /** S6: after a payout is reserved and before its dispatch claim (pause/revoke/race cases, §6.17 R3/R7). */
  beforePayoutClaim?: (effectKey: string) => Promise<void>;
}

/** Plaid clients by role. `connector` exists only in the worker composition (and local-server, which runs the worker). */
export interface PlaidDeps { reader?: PlaidReader; connector?: PlaidConnector; linkToken?: PlaidLinkTokenClient }

export interface Deps {
  store: Store;
  queue: Queue;
  reader: PayPalReader;
  writer?: PayPalWriter;
  now: () => string;
  config: Config;
  hooks?: Hooks;
  plaid?: PlaidDeps;
  vault?: Vault;
  /** Monotonic ms clock for the per-job time budget (S2-PR-06). Wall time by default; tests drive it. */
  elapsed?: () => number;
  /** S3: original documents (S3 bucket in dev, memory/disk locally). */
  evidence?: EvidenceStore;
  /** S3: EvidenceInterpreter. Absent → bills go READ_FAILED "Model not configured"; never a fake in the app. */
  interpreter?: Interpreter;
  /** S4: RecoveryPlanner and MessageDrafter (Nova). Absent → Headroom's templates, labelled "Model not configured here"; never a fake. */
  planner?: Interpreter;
  drafter?: Interpreter;
  /**
   * S5-D26: the mail channel (Gmail; SimulatedMailbox only as the test double), Headroom's sending address, and the private test
   * inbox every send is redirected to (required for Gmail in S5: no customer is ever contacted). Absent → messages wait as drafts.
   */
  mail?: { channel: MailChannel; address: string; redirectTo: string | null };
  /** S5-D20: ReplyInterpreter (Nova). Absent → every authorized reply goes to "Needs you: read the reply"; never a fake. */
  replier?: Interpreter;
  /** S7 R3: AUTOMATED-PAYER (sandbox buyer on PayPal's hosted page). Only the PAYER job calls it; absent → attempts end NOT_SUBMITTED. */
  payer?: import('./adapters/payer/hosted.ts').Payer;
  /** S7 B6: in dev/review the browser runs in its own Lambda; the worker hands it the SUBMITTING attempt (async invoke). */
  payerAsync?: (req: import('./domain/demo/payer.ts').PayRequest) => Promise<void>;
  /** S3-D18: which Bedrock spend allocation this composition draws on. */
  bedrockEnv?: 'local' | 'dev';
  /** S3-D18: a smaller share of the allocation for this process (e.g. the live script's $5 of local $10). */
  bedrockCapMicros?: number;
}

/**
 * A slice's renewal of the standing grants PP-STANDING / PLAID-STANDING (Build Book §I): fresh counters per slice, no hand-edited budgets.
 * Owner, 1 Nov 2026: no product limit on sandbox invoices or payments. The budgets are runaway-loop guards only; the providers'
 * own sandbox rate limits are the real ceiling. verifies stays low: it bounds forged webhook traffic (S1-IR-05).
 */
export const sliceGrant = (id: string, expiresAt: string): Grant =>
  ({ id, expiresAt, budgets: { reads: 100_000, creates: 10_000, sends: 10_000, verifies: 200, updates: 1_000, payouts: 0, calls: 20_000, items: 200 } }); // items: owner raised 60 → 200, 2 Nov 2026 (every demo reset creates one sandbox Item and removes the last)
export const S1_GRANT = sliceGrant('S1', '2026-11-30T23:59:59.000Z');
/** PP-S2 / PLAID-S2: S2 closure or 31 Dec 2026. */
export const S2_GRANT = sliceGrant('S2', '2026-12-31T23:59:59.000Z');
/** PP-S3 / PLAID-S3: S3 closure or 31 Dec 2026 (Bedrock spend is metered separately, S3-D18). */
export const S3_GRANT = sliceGrant('S3', '2026-12-31T23:59:59.000Z');
/** PP-STANDING / PLAID-STANDING renewal for S4 (hero invoices at reset, cumulative journey): S4 closure or 31 Dec 2026. */
export const S4_GRANT = sliceGrant('S4', '2026-12-31T23:59:59.000Z');
/** PP-STANDING / PLAID-STANDING renewal for S5 (invoice updates, collections, cumulative journey): S5 closure or 31 Dec 2026. */
export const S5_GRANT = sliceGrant('S5', '2026-12-31T23:59:59.000Z');
/** PP-S6: payouts to registered sandbox receivers named in the S6 plan (PP-STANDING, ENV-4); 500 items is the runaway guard. S6 closure or 31 Dec 2026. */
const s6 = sliceGrant('S6', '2026-12-31T23:59:59.000Z');
export const S6_GRANT: Grant = { ...s6, budgets: { ...s6.budgets, payouts: 500 } };
/**
 * UX repair (S7-UX3): the end of the provider grant can be set per deployment (the judging window plus a buffer, an owner decision)
 * with HEADROOM_GRANT_EXPIRES_AT (ISO UTC). Expiry stays enforced; unset keeps the recorded cutoff above.
 */
export function withGrantExpiry(g: Grant, iso: string | undefined = process.env.HEADROOM_GRANT_EXPIRES_AT): Grant {
  if (!iso) return g;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(iso) || !Number.isFinite(Date.parse(iso))) throw new Error('HEADROOM_GRANT_EXPIRES_AT must be an ISO UTC instant like 2027-02-28T23:59:59Z');
  return { ...g, expiresAt: new Date(Date.parse(iso)).toISOString() };
}
// SANDBOX: the full sandbox profile (invoices, payments, payouts) under a name that needs no slice history.
export const GRANTS: Record<string, Grant> = { S1: S1_GRANT, S2: S2_GRANT, S3: S3_GRANT, S4: S4_GRANT, S5: S5_GRANT, S6: S6_GRANT, SANDBOX: { ...S6_GRANT, id: 'SANDBOX' } };

/** Thrown by a test hook to simulate the process dying: the worker does not catch it, so the lease just expires. */
export class SimulatedCrash extends Error {}
