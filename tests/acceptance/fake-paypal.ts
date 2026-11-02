// REPLAY fake of the PayPal sandbox at the adapter boundary, built from the sanitized probe fixtures.
// Labelled REPLAY / STUB-WRITER in test names. It is never evidence of a payment.
import { createHash } from 'node:crypto';
import { minorToDecimal } from '@headroom/contracts';
import { NoResponse, type CreateInvoiceArgs, type HttpResult, type PayPalReader, type PayPalWriter } from '../../backend/src/adapters/paypal/types.ts';
import { fixture } from '../fixtures/paypal/index.ts';

const res = (status: number, body: any): HttpResult => { const raw = JSON.stringify(body); return { status, body: structuredClone(body), raw, rawSha256: createHash('sha256').update(raw).digest('hex') }; };
const amt = (minor: number) => ({ currency_code: 'USD', value: minorToDecimal(minor) });

/** `doc` = the mutable invoice inputs a full-replace PUT sets (S5): note, memo, configuration, invoice-level discount. */
interface FakeInvoice { id: string; number: string; status: string; amountMinor: number; txs: any[]; doc: { note: string; memo?: string; configuration: any; discountPercent: string | null; lut: number } }

const discountMinor = (inv: FakeInvoice) => (inv.doc.discountPercent ? Math.round((inv.amountMinor * Number(inv.doc.discountPercent)) / 100) : 0);
const paidMinor = (inv: FakeInvoice) => inv.txs.reduce((t, x) => t + Math.round(Number(x.amount.value) * 100), 0);
const dueOf = (inv: FakeInvoice) => Math.max(0, inv.amountMinor - discountMinor(inv) - paidMinor(inv));

export class FakePayPal {
  invoices = new Map<string, FakeInvoice>();
  captures = new Map<string, any>();
  calls: string[] = [];
  balance: { availableMinor: number; asOf: string | undefined; accountId: string; withheldMinor?: number } = { availableMinor: 500_000, asOf: undefined, accountId: 'ACCT-FAKE' };
  rows: any[] = [];
  totalPages = 1;
  signature: 'SUCCESS' | 'FAILURE' = 'SUCCESS';
  /** Faults: 'create-lost-response' applies the create then throws NoResponse (like a client timeout). */
  faults: Set<string> = new Set();
  searchLag = false;
  /** Test seam: runs after a PUT is applied (e.g. to fail the GET that follows it). */
  onPut?: () => void;
  /** S6 payouts: batch id → batch. Each item walks `script` one step per GET (default PENDING → SUCCESS). */
  payouts = new Map<string, { batchId: string; senderBatchId: string; body: any; item: { itemId: string; txn: string; script: string[]; step: number; feeMinor: number; at: string } }>();
  /** The next payout item's status sequence, e.g. ['PENDING', 'UNCLAIMED'] or ['FAILED']. */
  payoutScript: string[] = ['PENDING', 'SUCCESS'];
  /** Observed in F0 (2 Nov 2026): $20.00 on $5,000 → min(2%, $20) here. Tests override per case. */
  payoutFee = (faceMinor: number) => Math.min(Math.ceil(faceMinor * 0.02), 2000);
  /** Mutates the item GET (e.g. a different amount) to test the fingerprint (Y8). */
  itemTamper?: (body: any) => void;
  private seq = 0;
  /** Unique per instance: ids must not collide with an earlier run's markers in a persistent (dev) store. */
  private tag = Math.random().toString(36).slice(2, 8).toUpperCase();

  count(prefix: string) { return this.calls.filter((c) => c.startsWith(prefix)).length; }

  reader: PayPalReader = {
    getInvoice: async (id) => {
      this.calls.push(`GET invoice ${id}`);
      if (this.faults.has('get-invoice-500')) return res(500, {});
      const inv = this.invoices.get(id);
      if (!inv) return res(404, { name: 'RESOURCE_NOT_FOUND' });
      const d = discountMinor(inv);
      return res(200, {
        id, status: inv.status,
        detail: {
          invoice_number: inv.number, currency_code: 'USD', note: inv.doc.note, ...(inv.doc.memo ? { memo: inv.doc.memo } : {}),
          metadata: { recipient_view_url: `https://www.sandbox.paypal.com/invoice/p/#${id}`, last_update_time: new Date(Date.UTC(2026, 10, 1) + inv.doc.lut * 1000).toISOString().replace('.000', '') },
        },
        invoicer: { email_address: 'merchant@example.com' },
        primary_recipients: [{ billing_info: { email_address: 'customer@example.com' } }],
        items: [{ name: 'Services', quantity: '1', unit_amount: amt(inv.amountMinor) }],
        configuration: inv.doc.configuration,
        amount: { ...amt(inv.amountMinor - d), breakdown: { item_total: amt(inv.amountMinor), ...(inv.doc.discountPercent ? { discount: { invoice_discount: { percent: inv.doc.discountPercent, amount: { currency_code: 'USD', value: `-${minorToDecimal(d)}` } } } } : {}) } },
        due_amount: amt(dueOf(inv)),
        payments: inv.txs.length ? { transactions: inv.txs } : undefined,
      });
    },
    searchInvoiceByNumber: async (n) => {
      this.calls.push(`SEARCH ${n}`);
      const hits = this.searchLag ? [] : [...this.invoices.values()].filter((i) => i.number === n);
      return res(200, { items: hits.map((i) => ({ id: i.id, status: i.status, detail: { invoice_number: i.number } })) });
    },
    getCapture: async (id) => {
      this.calls.push(`GET capture ${id}`);
      const c = this.captures.get(id);
      return c ? res(200, c) : res(404, { name: 'RESOURCE_NOT_FOUND' });
    },
    getBalances: async () => {
      this.calls.push('GET balances');
      if (this.faults.has('balances-500')) return res(500, {});
      return res(200, {
        account_id: this.balance.accountId, as_of_time: this.balance.asOf, last_refresh_time: this.balance.asOf,
        balances: [{ currency: 'USD', available_balance: amt(this.balance.availableMinor), withheld_balance: amt(this.balance.withheldMinor ?? 0) }],
      });
    },
    getTransactions: async (_s, _e, page) => {
      this.calls.push(`GET transactions p${page}`);
      if (page > 1 && this.faults.has('page2-500')) return res(500, {});
      return res(200, { page, total_pages: this.totalPages, last_refreshed_datetime: this.balance.asOf, transaction_details: page === 1 ? this.rows.map((t) => ({ transaction_info: t })) : [] });
    },
    verifyWebhookSignature: async () => {
      this.calls.push('VERIFY signature');
      return res(200, { verification_status: this.signature });
    },
    getPayoutBatch: async (id) => {
      this.calls.push(`GET payout-batch ${id}`);
      const b = this.payouts.get(id);
      if (!b) return res(404, { name: 'RESOURCE_NOT_FOUND' });
      const it = this.itemBody(b);
      return res(200, { batch_header: { payout_batch_id: id, batch_status: it.transaction_status === 'PENDING' ? 'PROCESSING' : 'SUCCESS', sender_batch_header: { sender_batch_id: b.senderBatchId } }, items: [it] });
    },
    getPayoutItem: async (id) => {
      this.calls.push(`GET payout-item ${id}`);
      if (this.faults.has('payout-item-500')) return res(500, {});
      const b = [...this.payouts.values()].find((x) => x.item.itemId === id);
      if (!b) return res(404, { name: 'RESOURCE_NOT_FOUND' });
      b.item.step = Math.min(b.item.step + 1, b.item.script.length - 1);
      return res(200, this.itemBody(b));
    },
  };

  private itemBody(b: { batchId: string; senderBatchId: string; body: any; item: { itemId: string; txn: string; script: string[]; step: number; feeMinor: number; at: string } }) {
    const src = b.body.items[0];
    const status = b.item.script[b.item.step];
    const body: any = {
      payout_item_id: b.item.itemId, transaction_id: b.item.txn, transaction_status: status, payout_item_fee: { currency: 'USD', value: minorToDecimal(b.item.feeMinor) },
      payout_batch_id: b.batchId, sender_batch_id: b.senderBatchId, time_processed: status === 'PENDING' ? undefined : b.item.at,
      payout_item: { recipient_type: 'EMAIL', amount: { ...src.amount }, receiver: src.receiver, sender_item_id: src.sender_item_id, note: src.note },
    };
    this.itemTamper?.(body);
    return body;
  }

  /** S6-R2 report chain for a payout, observed −D/−D/+D (S06 §6.17): T1503 hold, T0001 payout, T1105 release, at `at` (≤ the next as-of to include them). */
  reportPayout(batchId: string, o: { at?: string; rows?: ('T1503' | 'T0001' | 'T1105')[]; status?: 'S' | 'P'; tamper?: (r: any) => void } = {}) {
    const b = this.payouts.get(batchId)!;
    const face = Math.round(Number(b.body.items[0].amount.value) * 100);
    const fee = b.item.feeMinor;
    const at = o.at ?? '2026-11-13T15:00:00+0000';
    const hold = `HOLD${b.item.txn.slice(4)}`;
    let bal = this.balance.availableMinor;
    // The running balance moves by amount + fee: −D, −D, +D (observed); a T0001 row's amount is −face and its fee −fee.
    const row = (code: string, id: string, minor: number, extra: any) => { bal += minor + (extra.fee_amount ? Math.round(Number(extra.fee_amount.value) * 100) : 0); return { transaction_id: id, transaction_event_code: code, transaction_initiation_date: at, transaction_updated_date: at, transaction_amount: amt(minor), transaction_status: 'S', available_balance: amt(bal), ...extra }; };
    const want = o.rows ?? ['T1503', 'T0001', 'T1105'];
    const out: any[] = [];
    if (want.includes('T1503')) out.push(row('T1503', hold, -(face + fee), {}));
    if (want.includes('T0001')) out.push(row('T0001', b.item.txn, -face, { fee_amount: amt(-fee), paypal_reference_id: hold, paypal_reference_id_type: 'TXN', transaction_status: o.status ?? 'S' }));
    if (want.includes('T1105')) out.push(row('T1105', `REL${b.item.txn.slice(3)}`, face + fee, { paypal_reference_id: hold, paypal_reference_id_type: 'TXN' }));
    for (const r of out) o.tamper?.(r);
    // The running balance after all rows: the ending balance moves −D, −D, +D, so a complete group nets −D (once).
    this.rows.push(...out);
    this.balance.availableMinor = out.length ? Math.round(Number(out[out.length - 1].available_balance.value) * 100) : bal;
    return out;
  }

  writer: PayPalWriter = {
    createInvoice: async (a: CreateInvoiceArgs) => {
      this.calls.push(`CREATE ${a.invoiceNumber}`);
      if (this.faults.has('create-500')) return res(500, {});
      if ([...this.invoices.values()].some((i) => i.number === a.invoiceNumber)) return fixture('create-422-duplicate') as HttpResult;
      const id = `INV2-FAKE-${this.tag}-${String(++this.seq).padStart(4, '0')}`;
      this.invoices.set(id, { id, number: a.invoiceNumber, status: 'DRAFT', amountMinor: a.amountMinor, txs: [], doc: { note: a.note, configuration: {}, discountPercent: null, lut: 0 } });
      if (this.faults.has('create-lost-response')) { this.faults.delete('create-lost-response'); throw new NoResponse('injected: response discarded'); }
      return res(201, { id, status: 'DRAFT', detail: { invoice_number: a.invoiceNumber } });
    },
    sendInvoice: async (id) => {
      this.calls.push(`SEND ${id}`);
      const inv = this.invoices.get(id);
      if (!inv) return res(404, {});
      inv.status = 'UNPAID';
      if (this.faults.has('send-lost-response')) { this.faults.delete('send-lost-response'); throw new NoResponse('injected'); }
      return res(200, { rel: 'payer-view' });
    },
    // Full replace, as observed on the sandbox (S05 §10a step 0): last_update_time moves on every PUT, Request-Id is ignored,
    // no compare-and-swap; an UNPAID invoice reads SENT afterwards.
    updateInvoice: async (id, bodyBytes) => {
      this.calls.push(`PUT ${id}`);
      if (this.faults.has('put-500')) return res(500, {});
      const inv = this.invoices.get(id);
      if (!inv) return res(404, {});
      if (['PAID', 'CANCELLED', 'MARKED_AS_PAID'].includes(inv.status) || this.faults.has('put-422')) return res(422, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'INVALID_INVOICE_STATUS' }] });
      const b = JSON.parse(bodyBytes);
      inv.doc = { note: b.detail?.note ?? '', memo: b.detail?.memo, configuration: b.configuration ?? {}, discountPercent: b.amount?.breakdown?.discount?.invoice_discount?.percent ?? null, lut: inv.doc.lut + 1 };
      if (inv.status === 'UNPAID') inv.status = 'SENT';
      this.onPut?.();
      if (this.faults.has('put-lost-response')) { this.faults.delete('put-lost-response'); throw new NoResponse('injected: response discarded'); }
      return res(200, { id, status: inv.status });
    },
    createPayout: async (bodyBytes) => {
      const b = JSON.parse(bodyBytes);
      const sbid = b.sender_batch_header.sender_batch_id;
      this.calls.push(`POST payout ${sbid}`);
      if (this.faults.has('payout-500')) { this.faults.delete('payout-500'); return res(500, { name: 'INTERNAL_SERVICE_ERROR' }); }
      if (this.faults.has('payout-401')) { this.faults.delete('payout-401'); return res(401, { name: 'AUTHENTICATION_FAILURE' }); }
      const dup = [...this.payouts.values()].find((x) => x.senderBatchId === sbid);
      if (dup) return res(400, { name: 'USER_BUSINESS_ERROR', details: [{ field: 'SENDER_BATCH_ID', issue: 'Batch with given sender_batch_id already exists', link: [{ href: `https://api.sandbox.paypal.com/v1/payments/payouts/${dup.batchId}`, rel: 'self', method: 'GET' }] }] });
      const face = Math.round(Number(b.items[0].amount.value) * 100);
      if (this.faults.has('payout-422') || face + this.payoutFee(face) > this.balance.availableMinor + this.payoutFloat) {
        this.faults.delete('payout-422');
        return res(422, { name: 'INSUFFICIENT_FUNDS', message: 'Sender does not have sufficient funds. Please add funds and retry.' });
      }
      const batchId = `PB${this.tag}${String(++this.seq).padStart(6, '0')}`;
      this.payouts.set(batchId, { batchId, senderBatchId: sbid, body: b, item: { itemId: `PI${this.tag}${String(this.seq).padStart(6, '0')}`, txn: `TXN${this.tag}${String(this.seq).padStart(8, '0')}`, script: [...this.payoutScript], step: -1, feeMinor: this.payoutFee(face), at: '2026-11-13T14:00:25Z' } });
      if (this.faults.has('payout-lost-response')) { this.faults.delete('payout-lost-response'); throw new NoResponse('injected: response discarded'); }
      return res(201, { batch_header: { payout_batch_id: batchId, batch_status: 'PENDING', sender_batch_header: { sender_batch_id: sbid } } });
    },
  };

  /** Captured money PayPal's live balance holds that the reported snapshot doesn't show yet (funds the provider-side check). */
  payoutFloat = 0;

  /** An edit made directly in PayPal (not by Headroom): S5-D4 classifies the next GET as CONFLICT. */
  editOutside(ppId: string, memo: string) { const inv = this.invoices.get(ppId)!; inv.doc = { ...inv.doc, memo, lut: inv.doc.lut + 1 }; }

  /** A "payment" on the fake. In live tests a human pays on PayPal's hosted page instead. */
  pay(ppId: string, o: { grossMinor?: number; feeMinor?: number; status?: string; captureInvoiceId?: string; currency?: string; createTime?: string } = {}) {
    const inv = this.invoices.get(ppId)!;
    const gross = o.grossMinor ?? inv.amountMinor;
    const fee = o.feeMinor ?? Math.round(gross * 0.039);
    const id = `CAP${this.tag}${String(++this.seq).padStart(8, '0')}`;
    const cur = o.currency ?? 'USD';
    const m = (minor: number) => ({ currency_code: cur, value: minorToDecimal(minor) });
    this.captures.set(id, {
      id, status: o.status ?? 'COMPLETED', amount: m(gross), invoice_id: o.captureInvoiceId ?? ppId, create_time: o.createTime ?? '2026-11-01T15:00:00Z',
      seller_receivable_breakdown: { gross_amount: m(gross), paypal_fee: m(fee), net_amount: m(gross - fee) },
    });
    inv.txs.push({ type: 'PAYPAL', payment_id: id, amount: amt(gross), payment_date: '2026-11-01' });
    inv.status = dueOf(inv) === 0 ? 'PAID' : 'PARTIALLY_PAID';
    return id;
  }

  recordExternal(ppId: string, minor: number) {
    const inv = this.invoices.get(ppId)!;
    inv.txs.push({ type: 'EXTERNAL', payment_id: `EXTR-${++this.seq}`, amount: amt(minor), method: 'BANK_TRANSFER', payment_date: '2026-11-01' });
    inv.status = 'MARKED_AS_PAID';
  }
}
