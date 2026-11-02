// FAKE RecoveryPlanner / MessageDrafter for acceptance tests only (S04 §6.11 layer 3). Never wired into the app: the app has the
// Bedrock adapter or Headroom's templates ("Model not configured here"). `script` entries override the next answers.
import type { Interpreter, InterpretResult } from '../../backend/src/adapters/bedrock/converse.ts';

export class FakeRole implements Interpreter {
  modelId = 'FAKE';
  calls: { input: string; reask?: string }[] = [];
  script: ((input: any) => unknown)[] = [];
  private answer: (input: any) => unknown;
  constructor(answer: (input: any) => unknown) { this.answer = answer; }
  async interpret(text: string, o: { timeoutMs: number; reask?: string }): Promise<InterpretResult> {
    this.calls.push({ input: text, reask: o.reask });
    const input = JSON.parse(text);
    const out = (this.script.shift() ?? this.answer)(input);
    return { outputText: typeof out === 'string' ? out : JSON.stringify(out), inputTokens: 900, outputTokens: 300, latencyMs: 5 };
  }
}

/** Selects every candidate in order and explains each with its first source, within the wording rules. */
export const goodPlanner = () => new FakeRole((x: any) => ({
  selected: x.candidates.map((c: any, i: number) => ({ candidateId: c.id, order: i + 1 })), considered: [],
  why: x.candidates.map((c: any) => ({ candidateId: c.id, reasons: c.allowedReasons.slice(0, 2), citations: [c.sources[0].n] })),
  summary: x.candidates.some((c: any) => c.kind === 'DISCOUNT_FALLBACK') ? 'COLLECT_WITH_FALLBACK' : 'COLLECT_FIRST',
}));
export const goodDrafter = () => new FakeRole((x: any) => ({ drafts: x.drafts.map((d: any) => ({ candidateId: d.candidateId, opening: 'DEAR_TEAM', closing: 'MANY_THANKS' })) }));
