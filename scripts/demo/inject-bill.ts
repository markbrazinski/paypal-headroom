// C-DEMO injectBill (S03 T4): npm run demo:inject-bill -- --stage local|dev|review [--variant hero|…] [--file <pdf>] [--tenant id] [--reason "..."]
// O6 automation (S7): npm run demo:bill -- --stage local|dev = the hero bill, then what happens next (you verify and accept in Payables;
// the plan then builds by itself, or Headroom accepts it under a loosened differing-bills rule).
// Sends ORIGINAL BYTES ONLY through the same ingestion as an owner upload; it can't set fields, classification or state.
// The variant is rendered with the run's dates (day 0 = today's business date in New York) into .headroom-local/bills/.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { arg, invokeOperator, LOCAL } from './operator-client.ts';
import { billPdf, VARIANTS, type Variant } from './bill-pdf.ts';
import { businessDate } from '../../backend/src/domain/time.ts';

const stage = arg('--stage');
const file = arg('--file');
const variant = (arg('--variant') ?? 'hero') as Variant;
const reason = arg('--reason') ?? 'operator inject (sandbox demo)';
if (!stage || (!file && !VARIANTS.includes(variant))) { console.error(`usage: npm run demo:inject-bill -- --stage local|dev [--variant ${VARIANTS.join('|')}] [--file <pdf>]`); process.exit(2); }
let bytes: Buffer, fileName: string;
if (file) { bytes = readFileSync(file); fileName = basename(file); }
else {
  bytes = billPdf(variant, businessDate(new Date().toISOString(), 'America/New_York'));
  fileName = `${variant}.pdf`;
  const dir = new URL('../../.headroom-local/bills/', import.meta.url).pathname;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, fileName), bytes);
}
const payload = { fileName, contentBase64: bytes.toString('base64'), reason };
let out: unknown;
if (stage === 'local') {
  const token = readFileSync(new URL('../../.headroom-local/operator-token', import.meta.url), 'utf8');
  const r = await fetch(`${LOCAL}/__operator/inject-bill`, { method: 'POST', headers: { 'x-operator-token': token }, body: JSON.stringify(payload) });
  out = await r.json();
} else if (stage === 'dev' || stage === 'review') out = await invokeOperator({ action: 'injectBill', tenantId: arg('--tenant') ?? 'tenant-owner', ...payload });
else { console.error('--stage must be local, dev or review'); process.exit(2); }
console.log(JSON.stringify(out, null, 2));
if (process.argv.includes('--then-say')) console.log('\nKeller’s bill is in (original document, read by Headroom). Next: open Payables › the bill › Verify, then Accept the new date.\nThe plan builds by itself as soon as the terms are accepted; the draft is waiting on Plan.');
