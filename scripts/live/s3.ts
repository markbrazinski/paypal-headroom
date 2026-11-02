// S3 live model cases (S03 §6.11 "Live model"). LIVE = the real Bedrock Nova 2 Lite EvidenceInterpreter through product code
// (operator inject → INGEST_DOCUMENT job → grounding → matching → bill read model). PayPal is a labelled STUB (FakePayPal); no bank.
// Spend: this script's own persistent counter (.headroom-local/live-s3.json), a $5 share of the local $10 allocation (S3-D18).
//   AWS_PROFILE=headroom HEADROOM_MODEL=us.amazon.nova-2-lite-v1:0 node scripts/live/s3.ts [--runs 3] [--out <dir>]
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryStore } from '../../backend/src/adapters/store/memory.ts';
import { MemoryQueue } from '../../backend/src/adapters/queue/port.ts';
import { K } from '../../backend/src/adapters/store/keys.ts';
import { MemoryEvidence } from '../../backend/src/adapters/evidence-store/memory.ts';
import { bedrockInterpreter, NOVA_2_LITE } from '../../backend/src/adapters/bedrock/converse.ts';
import { S3_GRANT, type Deps } from '../../backend/src/deps.ts';
import { bootstrapTenant } from '../../backend/src/domain/identity-run/run.ts';
import { operatorInjectBill, operatorReset } from '../../backend/src/handlers/operator.ts';
import { processJob } from '../../backend/src/jobs/worker.ts';
import { sweep } from '../../backend/src/jobs/sweep.ts';
import { businessDate } from '../../backend/src/domain/time.ts';
import { billLines, billPdf, type Variant } from '../demo/bill-pdf.ts';
import { FakePayPal } from '../../tests/acceptance/fake-paypal.ts';

if (process.env.HEADROOM_MODEL !== NOVA_2_LITE) { console.error(`refusing: set HEADROOM_MODEL=${NOVA_2_LITE} (Nova budget, owner S3-D7)`); process.exit(2); }
if (process.env.AWS_PROFILE !== 'headroom') { console.error('refusing: AWS_PROFILE must be headroom (InvokeModel on Nova only)'); process.exit(2); }
const arg = (n: string) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
const RUNS = Number(arg('--runs') ?? 3);
const out = arg('--out');
const CAP = 5_000_000; // $5 of the local $10 (S3-D18 split recorded in S03 §10a)

const store = new MemoryStore(join(import.meta.dirname, '../../.headroom-local/live-s3.json'));
const queue = new MemoryQueue();
const pp = new FakePayPal();
pp.balance.availableMinor = 180_000;
pp.balance.asOf = new Date(Date.now() - 3600_000).toISOString();
const d: Deps = {
  store, queue, reader: pp.reader, now: () => new Date().toISOString(), evidence: new MemoryEvidence(), interpreter: bedrockInterpreter(), bedrockEnv: 'local', bedrockCapMicros: CAP,
  config: { stage: 'local', connectionId: 'pp-stub', merchantEmail: 'stub@example.com', webhookId: null, grant: S3_GRANT },
};
await bootstrapTenant(store, { sub: 'live-s3', email: 'live-s3@example.com', tenantId: 'tenant-live-s3', connectionId: 'pp-stub' });

/** What a correct reading looks like (the sample's own text) and which outcomes are safe. */
const EXPECT: Record<Variant, { classification: string[]; state: string[]; mustFlag?: string }> = {
  hero: { classification: ['DATE_CHANGE_REQUESTED'], state: ['PROPOSED'] },
  amount: { classification: ['AMOUNT_DISCREPANCY'], state: ['PROPOSED'] },
  combined: { classification: ['TERMS_DIFFER'], state: ['PROPOSED'] },
  remittance: { classification: ['DATE_CHANGE_REQUESTED', 'REVISION_CHANGED_TERMS', 'REVISION_SAME_TERMS'], state: ['HELD'], mustFlag: 'REMITTANCE_CHANGE' },
  injection: { classification: ['DATE_CHANGE_REQUESTED', 'COMMITMENT_ALREADY_BILLED'], state: ['PROPOSED', 'HELD'], mustFlag: 'UNTRUSTED_INSTRUCTION_TEXT' },
  scanned: { classification: ['UNREADABLE_NEEDS_OCR_OR_VISION'], state: ['HELD'] },
  'relative-date': { classification: ['UNGROUNDED'], state: ['HELD'] },
  unknown: { classification: ['UNKNOWN_SUPPLIER'], state: ['HELD'] },
  ambiguous: { classification: ['AMBIGUOUS_COMMITMENT'], state: ['PROPOSED'] },
  revision: { classification: ['REVISION_SAME_TERMS'], state: ['HELD'] },
  separate: { classification: ['NEW_OBLIGATION_KNOWN_SUPPLIER'], state: ['PROPOSED'] },
  eur: { classification: ['UNSUPPORTED_CURRENCY'], state: ['HELD'] },
  'bare-dollar': { classification: ['EXACT_MATCH', 'DATE_CHANGE_REQUESTED', 'AMOUNT_DISCREPANCY', 'TERMS_DIFFER'], state: ['PROPOSED'] },
  'not-a-bill': { classification: ['NOT_A_BILL', 'UNGROUNDED'], state: ['HELD'] },
};
const ORDER: Variant[] = ['hero', 'revision', 'amount', 'combined', 'remittance', 'injection', 'relative-date', 'unknown', 'ambiguous', 'separate', 'eur', 'bare-dollar', 'not-a-bill', 'scanned'];

/** Run jobs until no ingest job is waiting, sleeping through backoffs (Bedrock throttling is retried as counted attempts, S3-D17). */
const drain = async () => {
  const until = Date.now() + 10 * 60_000;
  while (Date.now() < until) {
    await sweep(d);
    while (queue.pending.length) await processJob(d, queue.take()!);
    const waiting = (await store.dueJobs('9999-12-31T00:00:00.000Z', 1000)).filter((j) => j.type === 'INGEST_DOCUMENT');
    if (!waiting.length) return;
    await new Promise((r) => setTimeout(r, 5_000));
  }
};
const rows: Record<string, unknown>[] = [];
for (let run = 1; run <= RUNS; run++) {
  const r = await operatorReset(d, 'tenant-live-s3', `live s3 run ${run}`, { bank: 'none', hero: true });
  const day0 = businessDate(new Date().toISOString(), 'America/New_York');
  for (const v of ORDER) {
    const inj = await operatorInjectBill(d, 'tenant-live-s3', { action: 'injectBill', tenantId: 'tenant-live-s3', fileName: `${v}.pdf`, contentBase64: billPdf(v, day0).toString('base64'), reason: 'live s3' });
    await drain();
    const b = await store.get('core', K.run('tenant-live-s3', r!.runId), `BILL#${inj.billId}`);
    const models = await store.query('core', K.run('tenant-live-s3', r!.runId), { skPrefix: `MODEL#${inj.billId}#` });
    const e = EXPECT[v];
    const text = billLines(v, day0)?.join('\n') ?? '';
    const safe = e.state.includes(b!.state) && e.classification.includes(b!.classification) && (!e.mustFlag || b!.flags.includes(e.mustFlag));
    const fields = Object.fromEntries((b!.fields ?? []).map((f: any) => [f.name, f.grounded ? f.value : null]));
    rows.push({ run, variant: v, state: b!.state, classification: b!.classification, flags: b!.flags, safe, fields, readFailure: b!.readFailure,
      requests: models.map((m) => ({ state: m.state, inputTokens: m.inputTokens, outputTokens: m.outputTokens, actualMicros: m.actualMicros, latencyMs: m.latencyMs, outputSha256: m.outputSha256, outputText: m.outputText })),
      documentSha256: b!.documentSha256, textSha256: text ? createHash('sha256').update(text).digest('hex') : null });
    console.log(`${safe ? 'SAFE  ' : 'CHECK '} run ${run} ${v.padEnd(14)} ${b!.state.padEnd(11)} ${b!.classification} ${b!.flags.join(',')} · ${models.length} request(s)`);
  }
}
const c = await store.get('work', 'COUNTER#bedrock#local', 'COUNTER');
const spend = { requests: c?.requests ?? 0, spentMicros: c?.spentMicros ?? 0, reservedMicros: c?.reservedMicros ?? 0, committedMicros: c?.committedMicros ?? 0, capMicros: CAP };
console.log(`spend (this script, cumulative): ${spend.requests} requests · $${(spend.spentMicros / 1e6).toFixed(4)} spent · $${(spend.reservedMicros / 1e6).toFixed(4)} still reserved`);
const unsafe = rows.filter((r) => !r.safe).length;
console.log(`${rows.length - unsafe}/${rows.length} outcomes as expected or safer`);
if (out) { mkdirSync(out, { recursive: true }); writeFileSync(join(out, 'results.json'), JSON.stringify({ at: new Date().toISOString(), model: NOVA_2_LITE, runs: RUNS, spend, rows }, null, 2)); }
process.exit(unsafe ? 1 : 0);
