// S6 live provider cases (S06 §6.11 / §6.13). LIVE = real PayPal sandbox through Headroom's adapter.
//   HEADROOM_GRANT=S6 node scripts/live/s6.ts --case L2 | L4   (adapter + Headroom's payout rules; not the app path)
//   HEADROOM_GRANT=S6 node scripts/live/s6.ts --case F0-balance | F0-topup [--minor 500000] | F0-payout [--minor 1000000] | F0-item --item <id> | F0-report --since <iso> [--out <dir>]
// Local MemoryStore holds only the S6 grant counter. The receiver is the registered sandbox account (PAYPAL_BUYER_EMAIL, never printed).
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { MemoryStore } from '../../backend/src/adapters/store/memory.ts';
import { PayPalHttp } from '../../backend/src/adapters/paypal/http.ts';
import { paypalReader } from '../../backend/src/adapters/paypal/reader.ts';
import { paypalWriter } from '../../backend/src/adapters/paypal/writer.ts';
import { S6_GRANT } from '../../backend/src/deps.ts';
import { minorToDecimal } from '@headroom/contracts';
import { NoResponse } from '../../backend/src/adapters/paypal/types.ts';
import { classifyItem, payoutBody, receiverSha256 } from '../../backend/src/domain/payables/payout-core.ts';

if (process.env.HEADROOM_GRANT !== 'S6') { console.error('refusing: set HEADROOM_GRANT=S6 (PP-S6 renewal, Build Book §I)'); process.exit(2); }
process.loadEnvFile('.env');
const arg = (n: string, d?: string) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const kase = arg('--case', '')!;
const out = arg('--out', `.private/headroom/evidence/S06/feasibility-2026-11-02/${kase}-${new Date().toISOString().replace(/[:.]/g, '-')}`)!;
mkdirSync(out, { recursive: true });

const receiver = process.env.PAYPAL_BUYER_EMAIL ?? '';
const pseudo = (s: string) => `<email:${createHash('sha256').update(s.trim().toLowerCase()).digest('hex').slice(0, 10)}>`;
/** Evidence never carries the receiver address (S6-D1, R9). */
const scrub = (raw: string) => (receiver ? raw.split(receiver).join(pseudo(receiver)) : raw);
const now = () => new Date().toISOString();
// LIVE-FAULT seam (L2): the next payouts POST is sent, then its response is discarded (a client timeout after PayPal received it).
let dropNextPayoutResponse = false;
const fetchImpl: typeof fetch = async (url, init) => {
  const r = await fetch(url, init);
  if (dropNextPayoutResponse && String(url).endsWith('/v1/payments/payouts') && init?.method === 'POST') { dropNextPayoutResponse = false; await r.text(); throw new Error('LIVE-FAULT: response discarded'); }
  return r;
};
const http = new PayPalHttp({ clientId: process.env.PAYPAL_CLIENT_ID!, secret: process.env.PAYPAL_CLIENT_SECRET!, store: new MemoryStore(), grant: S6_GRANT, now, fetchImpl });
const reader = paypalReader(http);
const writer = paypalWriter(http);
const save = (name: string, v: { status: number; raw: string } | unknown) => writeFileSync(join(out, `${name}.json`), scrub(JSON.stringify(v, null, 2)));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function balance(name: string) {
  const r = await reader.getBalances();
  save(name, { status: r.status, at: now(), body: r.body });
  const usd = r.body?.balances?.find((b: any) => b.currency === 'USD');
  console.log(`${name}: ${r.status} available ${usd?.available_balance?.value} withheld ${usd?.withheld_balance?.value ?? '0'} as_of ${r.body?.as_of_time}`);
  return usd;
}

async function topup(minor: number) {
  const number = `HR-S6F0-${now().slice(5, 19).replace(/[-:T]/g, '')}`;
  const c = await writer.createInvoice({ invoiceNumber: number, invoiceDate: now().slice(0, 10), dueOn: '2026-11-30', amountMinor: minor, merchantEmail: process.env.PAYPAL_MERCHANT_EMAIL!,
    recipient: { name: 'Synthetic F0 Funding', email: 'headroom-s6-f0@example.com' }, itemName: 'F0 funding', note: 'SYNTHETIC Headroom S6 F0 funding. Sandbox only.' }, crypto.randomUUID());
  if (c.status !== 201) throw new Error(`create ${c.status} ${c.raw.slice(0, 300)}`);
  const s = await writer.sendInvoice(c.body.id, crypto.randomUUID());
  save('topup-invoice', { number, id: c.body.id, create: c.status, send: s.status, link: s.body?.href });
  console.log(`invoice ${number} ${c.body.id}; pay with: npm run demo:pay -- --link '${s.body?.href}' --out ${out}/payer`);
}

async function payout(minor: number) {
  if (!receiver) throw new Error('PAYPAL_BUYER_EMAIL missing from .env');
  const sbid = `HRF0${now().slice(5, 16).replace(/[-:T]/g, '')}`; // planner-marked: F0 prefix
  const bytes = JSON.stringify({
    sender_batch_header: { sender_batch_id: sbid, recipient_type: 'EMAIL', email_subject: 'SYNTHETIC Headroom S6 F0 payout', email_message: 'F0 hero-size fee probe' },
    items: [{ recipient_type: 'EMAIL', amount: { value: minorToDecimal(minor), currency: 'USD' }, receiver, sender_item_id: `${sbid}-1`, note: 'SYNTHETIC F0 hero-size payout. Sandbox only.' }],
  });
  const t0 = Date.now();
  const r = await writer.createPayout(bytes, sbid);
  save('payout-create', { sender_batch_id: sbid, status: r.status, at: now(), body: r.body });
  console.log(`create ${r.status} batch ${r.body?.batch_header?.payout_batch_id ?? '-'} ${r.body?.name ?? ''}`);
  const batchId = r.body?.batch_header?.payout_batch_id;
  if (!batchId) return;
  for (let i = 0; i < 20; i++) {
    await sleep(i < 6 ? 8_000 : 30_000);
    const b = await reader.getPayoutBatch(batchId);
    const item = b.body?.items?.[0];
    console.log(`+${Math.round((Date.now() - t0) / 1000)}s batch ${b.body?.batch_header?.batch_status} item ${item?.transaction_status} fee ${item?.payout_item_fee?.value}`);
    if (item?.payout_item_id && !['PENDING', 'UNKNOWN', undefined].includes(item?.transaction_status)) {
      const it = await reader.getPayoutItem(item.payout_item_id);
      save('payout-item', { status: it.status, at: now(), elapsedS: Math.round((Date.now() - t0) / 1000), body: it.body });
      save('payout-batch', { status: b.status, at: now(), body: b.body });
      console.log(`item ${item.payout_item_id} ${it.body?.transaction_status} fee ${it.body?.payout_item_fee?.value} processed ${it.body?.time_processed} txn ${it.body?.transaction_id}`);
      return;
    }
  }
  console.log('item still not terminal after polling; rerun --case F0-item');
}

async function item(id: string) {
  const it = await reader.getPayoutItem(id);
  save('payout-item-recheck', { status: it.status, at: now(), body: it.body });
  console.log(`item ${id} ${it.body?.transaction_status} fee ${it.body?.payout_item_fee?.value}`);
}

async function report(since: string) {
  const r = await reader.getTransactions(since, now().slice(0, 19) + 'Z', 1);
  save('report-transactions', { status: r.status, at: now(), body: r.body });
  const rows = (r.body?.transaction_details ?? []).map((d: any) => d.transaction_info).filter((t: any) => /^T(1503|0001|1105)$/.test(t.transaction_event_code));
  for (const t of rows) console.log(`${t.transaction_event_code} ${t.transaction_status} ${t.transaction_amount?.value} fee ${t.fee_amount?.value ?? '-'} id ${t.transaction_id} ref ${t.paypal_reference_id ?? '-'} at ${t.transaction_initiation_date} end ${t.ending_balance?.value}`);
  console.log(`last_refreshed ${r.body?.last_refreshed_datetime}; ${rows.length} payout rows`);
}

/** L2 (G-P3): lost response → replay the identical bytes and id → 201 or 400 duplicate + link → one batch → item verdict. */
async function l2() {
  const sbid = `HRL2${now().slice(5, 16).replace(/[-:T]/g, '')}`;
  const bytes = payoutBody({ senderBatchId: sbid, receiver, amountMinor: 100, business: 'SYNTHETIC Headroom S6 L2', billNo: null, senderItemId: `${sbid}-1` });
  dropNextPayoutResponse = true;
  let first: string;
  try { await writer.createPayout(bytes, sbid); first = 'response unexpectedly kept'; } catch (e) { first = e instanceof NoResponse ? 'NoResponse (UNKNOWN)' : String(e); }
  const replay = await writer.createPayout(bytes, sbid);
  const link = (replay.body?.details ?? []).flatMap((x: any) => (Array.isArray(x.link) ? x.link : [])).find((k: any) => /payouts\//.test(k.href))?.href;
  const batchId = replay.body?.batch_header?.payout_batch_id ?? (link ? link.split('/').pop() : null);
  save('L2-replay', { sender_batch_id: sbid, first, replayStatus: replay.status, replayBody: replay.body, batchId });
  console.log(`L2 first: ${first}; replay ${replay.status} ${replay.body?.name ?? ''} → batch ${batchId}`);
  if (!batchId) return;
  for (let i = 0; i < 10; i++) {
    await sleep(8_000);
    const b = await reader.getPayoutBatch(batchId);
    const items = b.body?.items ?? [];
    const it = items[0]?.payout_item_id ? (await reader.getPayoutItem(items[0].payout_item_id)).body : null;
    const v = it ? classifyItem(it, { senderBatchId: sbid, amountMinor: 100, receiverSha256: receiverSha256(receiver) }) : null;
    console.log(`  batch items ${items.length} · item ${it?.transaction_status ?? '-'} · verdict ${v?.kind ?? '-'}`);
    if (v && v.kind !== 'NOT_PAID') { save('L2-item', { items: items.length, item: it, verdict: v }); return; }
  }
}

/** L4: amount above the balance → synchronous 422, no batch (probe 006). */
async function l4() {
  const sbid = `HRL4${now().slice(5, 16).replace(/[-:T]/g, '')}`;
  const r = await writer.createPayout(payoutBody({ senderBatchId: sbid, receiver, amountMinor: 5_000_000, business: 'SYNTHETIC Headroom S6 L4', billNo: null, senderItemId: `${sbid}-1` }), sbid);
  save('L4-create', { sender_batch_id: sbid, status: r.status, body: r.body });
  console.log(`L4 ${r.status} ${r.body?.name ?? ''} batch ${r.body?.batch_header?.payout_batch_id ?? 'none'}`);
}

if (kase === 'L2') { await balance('balance-before'); await l2(); }
else if (kase === 'L4') await l4();
else if (kase === 'F0-balance') await balance('balance');
else if (kase === 'F0-topup') await topup(Number(arg('--minor', '500000')));
else if (kase === 'F0-payout') { await balance('balance-before'); await payout(Number(arg('--minor', '1000000'))); await balance('balance-after'); }
else if (kase === 'F0-item') await item(arg('--item')!);
else if (kase === 'F0-report') await report(arg('--since')!);
else { console.error('unknown --case'); process.exit(2); }
console.log(`evidence: ${out}`);
