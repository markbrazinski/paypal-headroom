// S5-D4: an invoice update is a full-replace PUT built from the preimage GET with only the target fields changed.
// Pure: the executor freezes the bytes `updateBody` returns at PREPARED and classifies every later GET with `classifyAfter`.
// Sandbox (S05 §10a step 0): PayPal echoes the inputs back unchanged, last_update_time moves on every PUT, no compare-and-swap.
import { minorToDecimal } from '@headroom/contracts';

export type UpdateTarget =
  | { kind: 'ENABLE_PARTIAL'; minimumMinor: number }
  | { kind: 'APPLY_DISCOUNT'; percentBp: number; noteLine: string }
  | { kind: 'REMOVE_DISCOUNT'; noteLine: string | null };

/** Fields PayPal computes or owns; never sent back. */
const READ_ONLY = ['id', 'status', 'links', 'payments', 'refunds', 'due_amount', 'gratuity', 'unilateral_metadata'] as const;
const usd = (minor: number) => ({ currency_code: 'USD', value: minorToDecimal(minor) });

/**
 * The invoice's inputs: what a "no change" PUT would send. Totals are derived by PayPal from items; only invoice-level adjustments
 * are inputs, and a zero invoice discount (PayPal reports `amount 0.00` on a fresh invoice) is no discount.
 */
export function inputsOf(inv: any): any {
  if (!inv?.detail || !Array.isArray(inv.items)) throw new Error('invoice has no detail/items');
  const b = structuredClone(inv);
  for (const k of READ_ONLY) delete b[k];
  delete b.detail.metadata;
  const br = inv.amount?.breakdown ?? {};
  const keep: any = {};
  const d = br.discount?.invoice_discount;
  if (d?.percent !== undefined && Number(d.percent) !== 0) keep.discount = { invoice_discount: { percent: String(d.percent) } };
  else if (d?.amount && Number(d.amount.value) !== 0) keep.discount = { invoice_discount: { amount: structuredClone(d.amount) } };
  if (br.shipping) keep.shipping = structuredClone(br.shipping);
  if (br.custom) keep.custom = structuredClone(br.custom);
  delete b.amount;
  if (Object.keys(keep).length) b.amount = { breakdown: keep };
  return b;
}

/** The body for `target`, from the invoice GET `pre`. Throws on a shape this code doesn't understand (never guesses). */
export function updateBody(pre: any, target: UpdateTarget): any {
  const b = inputsOf(pre);
  const note = (b.detail.note ?? '') as string;
  if (target.kind === 'ENABLE_PARTIAL') {
    b.configuration = { ...(b.configuration ?? {}), partial_payment: { allow_partial_payment: true, minimum_amount_due: usd(target.minimumMinor) } };
    return b;
  }
  const br = { ...(b.amount?.breakdown ?? {}) };
  delete br.discount;
  if (target.kind === 'APPLY_DISCOUNT') {
    br.discount = { invoice_discount: { percent: String(target.percentBp / 100) } };
    b.detail.note = note.split('\n').includes(target.noteLine) ? note : note ? `${note}\n${target.noteLine}` : target.noteLine;
  } else if (target.noteLine) b.detail.note = note.split('\n').filter((l) => l !== target.noteLine).join('\n');
  if (Object.keys(br).length) b.amount = { breakdown: br };
  else delete b.amount;
  return b;
}

const stable = (x: any): string => (Array.isArray(x) ? `[${x.map(stable).join(',')}]` : x && typeof x === 'object' ? `{${Object.keys(x).sort().map((k) => `${JSON.stringify(k)}:${stable(x[k])}`).join(',')}}` : JSON.stringify(x));
export const lastUpdateTime = (inv: any): string | null => inv?.detail?.metadata?.last_update_time ?? null;

/**
 * S5-D4 classification of a GET taken after (or instead of knowing whether) the stored PUT landed:
 *   SUCCESS    every input equals the stored body (target included);
 *   NOT_LANDED same last_update_time and inputs as the preimage: resend the stored bytes, same key;
 *   CONFLICT   anything else (someone edited it, status changed): no write, ever; an older invoice is never written back.
 */
export function classifyAfter(get: any, preimage: any, sentBody: any): 'SUCCESS' | 'NOT_LANDED' | 'CONFLICT' {
  if (stable(inputsOf(get)) === stable(inputsOf(sentBody))) return 'SUCCESS';
  if (lastUpdateTime(get) === lastUpdateTime(preimage) && get.status === preimage.status && stable(inputsOf(get)) === stable(inputsOf(preimage))) return 'NOT_LANDED';
  return 'CONFLICT';
}

/** Due amount in minor units from an invoice GET, or null. */
export const dueMinor = (inv: any): number | null => {
  const v = inv?.due_amount?.value;
  return typeof v === 'string' && /^\d+\.\d{2}$/.test(v) ? Number(v.replace('.', '')) : null;
};

/** The invoice-level discount PayPal applied, in minor units (S5-D3 concession amount), or 0. */
export const discountMinor = (inv: any): number => {
  const v = inv?.amount?.breakdown?.discount?.invoice_discount?.amount?.value;
  return typeof v === 'string' && /^-?\d+\.\d{2}$/.test(v) ? Math.abs(Number(v.replace('.', ''))) : 0;
};

/** Does GET `inv` show `target` in effect? */
export function targetHolds(inv: any, target: UpdateTarget): boolean {
  if (target.kind === 'ENABLE_PARTIAL') {
    const p = inv?.configuration?.partial_payment;
    return p?.allow_partial_payment === true && p?.minimum_amount_due?.value === minorToDecimal(target.minimumMinor);
  }
  const d = inputsOf(inv).amount?.breakdown?.discount?.invoice_discount;
  if (target.kind === 'APPLY_DISCOUNT') return d?.percent !== undefined && Math.round(Number(d.percent) * 100) === target.percentBp;
  return !d;
}
