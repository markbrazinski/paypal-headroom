// Bedrock spend by reservation (S3-D18), inside the owner's $30 Nova budget (S3-D7): local $10 + dev $20, each enforced
// atomically on its own store. Before each request one TX writes the MODEL# record (DISPATCHING) and reserves the worst case;
// a refusal means zero dispatch. After a response, reserved → actual. A request with no answer keeps its reservation.
import { TxCancelled, type Op, type Store } from '../store/port.ts';

/**
 * Nova 2 Lite on-demand, regional `us.` inference profile: $0.33 / 1M input, $2.75 / 1M output tokens. Recorded 1 Nov 2026 from
 * third-party price trackers (getmaxim.ai Bifrost calculator for us.amazon.nova-2-lite-v1:0); the AWS pricing page tables did not
 * extract. The higher of the two published figure sets (global: $0.30 / $2.50) is used, so spend can only be over-counted.
 */
export const PRICE_MICROS_PER_TOKEN = { input: 0.33, output: 2.75 };
export const MAX_INPUT_CHARS = 24_000;
export const PROMPT_TOKENS = 1_500;
export const MAX_OUTPUT_TOKENS_COST = 1_200;
export const SAFETY = 1.25;
export const BEDROCK_CAPS_MICROS = { local: 10_000_000, dev: 20_000_000 } as const;

export const costMicros = (inputTokens: number, outputTokens: number) =>
  Math.ceil(inputTokens * PRICE_MICROS_PER_TOKEN.input + outputTokens * PRICE_MICROS_PER_TOKEN.output);
/** Worst case for one request: chars ÷ 3 per token + the prompt, plus the output cap, × 1.25. */
export const worstCaseMicros = (inputChars: number) => Math.ceil(costMicros(Math.ceil(inputChars / 3) + PROMPT_TOKENS, MAX_OUTPUT_TOKENS_COST) * SAFETY);

export const bedrockCounter = (env: 'local' | 'dev') => ({ pk: `COUNTER#bedrock#${env}`, sk: 'COUNTER' });

/**
 * `committedMicros` = spent + reserved, kept as one attribute because a DynamoDB condition can't add two attributes.
 * The reservation holds only while committed + cost ≤ cap.
 */
export function reserveOp(env: 'local' | 'dev', cost: number, capMicros: number = BEDROCK_CAPS_MICROS[env]): Op {
  const c = bedrockCounter(env);
  return { op: 'update', table: 'work', pk: c.pk, sk: c.sk, add: { committedMicros: cost, reservedMicros: cost, requests: 1 }, set: { capMicros }, cond: { ltOrMissing: { committedMicros: capMicros - cost + 1 } } };
}
/** reserved → actual (actual null: usage unknown, the reservation stays charged as spent). */
export function settleOp(env: 'local' | 'dev', reserved: number, actual: number | null): Op {
  const c = bedrockCounter(env);
  const a = actual ?? reserved;
  return { op: 'update', table: 'work', pk: c.pk, sk: c.sk, add: { committedMicros: a - reserved, reservedMicros: -reserved, spentMicros: a } };
}

export class BudgetReached extends Error {}

/** Reserve + MODEL# record in one TX (plus the caller's lease check). TxCancelled on the counter → BudgetReached. */
export async function reserve(store: Store, ops: Op[]): Promise<void> {
  try { await store.transact(ops); } catch (e) {
    if (e instanceof TxCancelled && e.failed[0]) throw new BudgetReached('Model budget reached');
    throw e;
  }
}
