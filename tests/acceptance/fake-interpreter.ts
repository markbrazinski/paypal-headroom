// FAKE EvidenceInterpreter for acceptance tests only (S03 §6.11 layer 3). Never wired into the app: the app has the Bedrock
// adapter or nothing ("Model not configured"). It reads the generated sample bills the way a model is asked to: values as printed,
// each with its quote. `script` entries override the next answers (invalid output, throttling, crashes, invented values).
import type { EvidenceInterpreterOutput } from '@headroom/contracts';
import { InterpreterFailure, type Interpreter, type InterpretResult } from '../../backend/src/adapters/bedrock/converse.ts';

type Q = { value: string | null; quote: string | null };
const none: Q = { value: null, quote: null };

export function readLikeAModel(text: string): EvidenceInterpreterOutput {
  const lines = text.split('\n');
  const find = (re: RegExp, value = (m: RegExpExecArray) => m[1]): Q => { for (const l of lines) { const m = re.exec(l); if (m) return { value: value(m), quote: m[0] }; } return none; };
  const isBill = /INVOICE/.test(text);
  const total = find(/Amount due (.+)$/, (m) => m[1].replace(/[^\d.,]/g, '').replace(/,/g, ''));
  const printed = find(/Amount due (.+)$/);
  const cur = /\bEUR\b|€/.test(text) ? { value: 'EUR', quote: /€/.test(text) ? '€' : 'EUR' } : /\bUSD\b/.test(text) ? { value: 'USD', quote: 'USD' } : /\$/.test(text) ? { value: 'USD', quote: '$' } : none;
  return {
    supplierName: isBill ? { value: lines[0].trim(), quote: lines[0].trim() } : none,
    billNumber: find(/INVOICE (\S+)/),
    reference: find(/Reference: (\S+)/),
    issueDate: find(/Issue date: (.+)$/),
    dueDate: find(/Payment due: (.+)$/),
    total: total.value ? { value: total.value, quote: printed.value } : none,
    currency: cur,
    remittanceLast4: find(/account ending (\d{4})/),
    documentKind: isBill ? 'BILL' : 'NOT_A_BILL',
    instructionsInDocument: /NOTE TO ASSISTANT/.test(text),
    instructionQuotes: lines.filter((l) => /NOTE TO ASSISTANT/.test(l)).slice(0, 5),
  };
}

export type Step = string | Error | ((text: string) => string | Error | Promise<never>);

export class FakeInterpreter implements Interpreter {
  modelId = 'FAKE-evidence-interpreter';
  calls: { text: string; reask?: string; timeoutMs: number }[] = [];
  script: Step[] = [];
  /** Edit the honest reading before it is returned (e.g. an invented total, S3-R7). */
  edit?: (o: EvidenceInterpreterOutput, text: string) => EvidenceInterpreterOutput;
  async interpret(text: string, o: { timeoutMs: number; reask?: string }): Promise<InterpretResult> {
    this.calls.push({ text, reask: o.reask, timeoutMs: o.timeoutMs });
    const step = this.script.shift();
    const v = typeof step === 'function' ? await step(text) : step;
    if (v instanceof Error) throw v;
    const outputText = v ?? JSON.stringify((this.edit ?? ((x) => x))(readLikeAModel(text), text));
    return { outputText, inputTokens: Math.ceil(text.length / 4) + 600, outputTokens: Math.ceil(outputText.length / 4), latencyMs: 5 };
  }
}
export const throttled = () => new InterpreterFailure('THROTTLED', 'Too many requests (FAKE)');
