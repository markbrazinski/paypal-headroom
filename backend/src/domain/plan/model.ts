// One metered model role inside a plan build (S3-D18 reservation, S4-D7/D8 gates). Any failure — not configured, no time, budget,
// throttling, a refused output twice — returns a reason and the caller uses Headroom's template: a build never fails on the model.
import { createHash } from 'node:crypto';
import type { Interpreter } from '../../adapters/bedrock/converse.ts';
import { BudgetReached, costMicros, reserve, reserveOp, settleOp, worstCaseMicros } from '../../adapters/bedrock/spend.ts';
import { TxCancelled } from '../../adapters/store/port.ts';
import { SimulatedCrash, type Deps } from '../../deps.ts';
import { leaseCheck, type Lease } from '../../jobs/lease.ts';
import { auditOp } from '../audit/audit.ts';
import type { Gate } from './gates.ts';

export const MIN_REQUEST_MS = 8_000;
export const MAX_REQUEST_MS = 15_000;
const FINALIZE_MS = 5_000;
const parseJson = (s: string): unknown => { try { return JSON.parse(s.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')); } catch { return null; } };

export interface RoleCall<T> { role: Interpreter | undefined; task: 'RecoveryPlanner' | 'MessageDrafter' | 'ReplyInterpreter'; pk: string; buildId: string; gen: number; input: string; gate: (raw: unknown) => Gate<T> }
export type RoleResult<T> = { ok: true; value: T; modelId: string } | { ok: false; reason: string };

export async function askRole<T>(d: Deps, l: Lease, left: () => number, x: RoleCall<T>): Promise<RoleResult<T>> {
  if (!x.role) return { ok: false, reason: 'Model not configured here' };
  const env = d.bedrockEnv ?? 'local';
  let k = (await d.store.query('core', x.pk, { skPrefix: `MODEL#${x.buildId}#${x.gen}#` })).length;
  let reask: string | undefined;
  for (let ask = 0; ask < 2; ask++) {
    const timeoutMs = Math.min(MAX_REQUEST_MS, left() - FINALIZE_MS);
    if (timeoutMs < MIN_REQUEST_MS) return { ok: false, reason: 'No time left for a model request in this build' };
    const cost = worstCaseMicros(x.input.length);
    const sk = `MODEL#${x.buildId}#${x.gen}#${String(k++).padStart(3, '0')}`;
    try {
      await reserve(d.store, [
        reserveOp(env, cost, d.bedrockCapMicros),
        { op: 'put', table: 'core', cond: { notExists: true }, item: { pk: x.pk, sk, task: x.task, modelId: x.role.modelId, buildId: x.buildId, generation: x.gen, k: k - 1, inputSha256: createHash('sha256').update(x.input).digest('hex'), inputChars: x.input.length, reservedMicros: cost, state: 'DISPATCHING', outputText: null, outputSha256: null, inputTokens: null, outputTokens: null, actualMicros: null, latencyMs: null, error: null, dispatchedAt: d.now(), settledAt: null } },
        leaseCheck(l),
      ]);
    } catch (e) {
      if (e instanceof BudgetReached) return { ok: false, reason: 'Model budget reached' };
      if (e instanceof TxCancelled) return { ok: false, reason: 'This build lost its turn' };
      throw e;
    }
    const settle = (state: string, set: Record<string, unknown>, actual: number | null, extra: ReturnType<typeof auditOp>[] = []) =>
      d.store.transact([{ op: 'update', table: 'core', pk: x.pk, sk, set: { state, settledAt: d.now(), actualMicros: actual ?? cost, ...set }, cond: { eq: { state: 'DISPATCHING' } } }, settleOp(env, cost, actual), ...extra]);
    let r;
    try { r = await x.role.interpret(x.input, { timeoutMs, reask }); }
    catch (e) {
      if (e instanceof SimulatedCrash) throw e;
      await settle('ERROR', { error: (e as Error).message }, null);
      return { ok: false, reason: `Model unavailable (${(e as Error).message.slice(0, 120)})` };
    }
    const actual = r.inputTokens !== null && r.outputTokens !== null ? costMicros(r.inputTokens, r.outputTokens) : null;
    const usage = { outputText: r.outputText.slice(0, 8_192), outputSha256: createHash('sha256').update(r.outputText).digest('hex'), inputTokens: r.inputTokens, outputTokens: r.outputTokens, latencyMs: Math.round(r.latencyMs) };
    const g = x.gate(parseJson(r.outputText));
    if (g.ok) { await settle('OK', usage, actual); return { ok: true, value: g.value, modelId: x.role.modelId }; }
    reask = g.reason;
    const [tenantId, runId] = [l.job.tenantId!, l.job.runId!];
    await settle('INVALID_OUTPUT', { ...usage, error: g.reason }, actual, [auditOp({ tenantId, runId, type: 'ModelOutputRefused', by: 'HEADROOM', result: `${x.task} output refused: ${g.reason}${ask === 0 ? '; asking once more' : "; using Headroom's template"}`, refs: { buildId: x.buildId }, correlationId: `plan:${x.buildId}:${x.gen}`, now: d.now() })]);
  }
  return { ok: false, reason: `Refused twice: ${reask}` };
}
