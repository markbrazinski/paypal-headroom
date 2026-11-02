// Grounding (probe 02/06 validators, fixed per probe 06): a model value counts only when its quote is in the document text
// and the value says what the quote says. Models never set amounts or dates; code parses them from grounded text. Pure.
import type { BillField, EvidenceInterpreterOutput, LocalDate } from '@headroom/contracts';
import { LocalDate as LocalDateSchema } from '@headroom/contracts';

const squash = (s: string) => s.normalize('NFKC').replace(/\s+/g, '');

/** G1/G2: the quote appears in the text with all whitespace removed (pdf text wraps lines and splits words). */
export const quoteIn = (quote: string | null | undefined, text: string) => !!quote && squash(quote).length > 0 && squash(text).includes(squash(quote));

/**
 * A printed amount ("$10,000.00", "10000", "USD 1,480.50", ".50") → minor units, or null when it isn't exactly one positive amount
 * in cents (S3-IM-03). The whole numeric token is parsed: exactly one number in the text, valid grouping, at most 2 decimals, a
 * leading-decimal ".50" is 50 cents, and any sign or parentheses (a credit or negative total) is refused, never made positive.
 */
export function amountMinor(s: string | null | undefined): number | null {
  if (!s) return null;
  const tokens = [...s.matchAll(/\d[\d,]*(?:\.\d*)?|\.\d+/g)];
  if (tokens.length !== 1) return null; // none, or several numbers: ambiguous
  const tok = tokens[0][0];
  const before = s.slice(0, tokens[0].index).replace(/[\s$€£¥₹]|[A-Z]{3}|US|C|A|NZ|MX/g, '');
  const after = s.slice(tokens[0].index! + tok.length).trim();
  if (/[-−–(]$/.test(before) || after.startsWith(')') || after.startsWith('-') || /\bCR\b/i.test(after)) return null; // negative / credit
  const m = /^(?:(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?|\.(\d{1,2}))$/.exec(tok);
  if (!m) return null; // bad grouping, non-cent precision (G3), or a trailing "."
  const whole = m[1] ? Number(m[1].replace(/,/g, '')) : 0;
  const cents = Number((m[2] ?? m[3] ?? '0').padEnd(2, '0'));
  const minor = whole * 100 + cents;
  return Number.isSafeInteger(minor) ? minor : null;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const iso = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const real = (s: string): LocalDate | null => (LocalDateSchema.safeParse(s).success ? s : null);

/**
 * G4: absolute dates only, found anywhere in `s`: "November 13, 2026", "Nov 13, 2026", "Nov. 13 2026", "2026-11-13",
 * "13 November 2026". Relative wording ("next Friday", "in 30 days") and numeric d/m vs m/d forms are not parsed.
 */
export function parseDate(s: string | null | undefined): LocalDate | null {
  if (!s) return null;
  let m = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(s);
  if (m) return real(iso(+m[1], +m[2], +m[3]));
  const mon = (w: string) => { const i = MONTHS.indexOf(w.slice(0, 3).toLowerCase()); return i < 0 ? null : i + 1; };
  m = /\b([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})\b/.exec(s);
  if (m && mon(m[1])) return real(iso(+m[3], mon(m[1])!, +m[2]));
  m = /\b(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})\b/.exec(s);
  if (m && mon(m[2])) return real(iso(+m[3], mon(m[2])!, +m[1]));
  return null;
}

// ---------- currency (S3-D14) ----------
const ISO_OTHER = ['EUR', 'GBP', 'CAD', 'AUD', 'NZD', 'JPY', 'CHF', 'MXN', 'INR', 'CNY'];
export type CurrencyScan = { kind: 'USD' } | { kind: 'BARE_DOLLAR' } | { kind: 'UNSUPPORTED'; markers: string[] } | { kind: 'CONFLICTING'; markers: string[] } | { kind: 'MISSING' };

/** C1–C4: every currency marker in the whole text layer decides the currency; the model only has to agree. */
export function scanCurrency(text: string): CurrencyScan {
  const other = new Set<string>();
  const usd = /\bUSD\b/.test(text) || /\bUS\$/.test(text);
  for (const c of ISO_OTHER) if (new RegExp(`\\b${c}\\b`).test(text)) other.add(c);
  for (const [sym, name] of [['€', 'EUR'], ['£', 'GBP'], ['¥', 'JPY/CNY'], ['₹', 'INR']] as const) if (text.includes(sym)) other.add(name);
  for (const p of ['C$', 'CA$', 'A$', 'AU$', 'NZ$', 'MX$']) if (new RegExp(`(^|[^A-Za-z])${p.replace('$', '\\$')}`).test(text)) other.add(p);
  // A bare "$" is one not preceded by a letter (US$, C$ … are handled above).
  const bare = /(^|[^A-Za-z])\$/.test(text);
  if (other.size && usd) return { kind: 'CONFLICTING', markers: ['USD', ...other] };
  if (other.size) return { kind: 'UNSUPPORTED', markers: [...other] };
  if (usd) return { kind: 'USD' };
  if (bare) return { kind: 'BARE_DOLLAR' };
  return { kind: 'MISSING' };
}

export interface Grounded {
  fields: BillField[];
  supplierName: string | null;
  billNumber: string | null;
  reference: string | null;
  issueDate: LocalDate | null;
  dueOn: LocalDate | null;
  /** The printed total as minor units (provisional for a bare "$" until the owner attests USD). */
  totalMinor: number | null;
  printedTotal: string | null;
  currency: 'USD' | 'BARE_DOLLAR' | null;
  remittanceLast4: string | null;
  /** Hold classification decided by grounding alone, with reasons; null when the bill can go on to matching. */
  hold: { classification: 'UNGROUNDED' | 'UNSUPPORTED_CURRENCY' | 'CONFLICTING_CURRENCY' | 'CURRENCY_MISSING' | 'NOT_A_BILL'; reasons: string[] } | null;
  untrustedInstructions: boolean;
}

// G6: phrases aimed at a system or at changing payment, flagged whatever the model said.
const INSTRUCTION = /ignore (all|previous)|\bsystem\b|\bassistant\b|mark (as )?paid|\bapprove\b|change (bank|remittance|account)|pay to\b/i;

/** G1–G6 + C1–C3: every field checked against the text; nothing a check refuses survives as a value. */
export function ground(out: EvidenceInterpreterOutput, text: string): Grounded {
  const fields: BillField[] = [];
  const field = (name: BillField['name'], ok: boolean, reason: string | null) => {
    const v = out[name];
    const grounded = ok && v.value !== null;
    fields.push({ name, value: grounded ? v.value : null, quote: v.quote, grounded, reason: grounded ? null : v.value === null ? 'Not found in the document' : reason });
    return grounded ? v.value : null;
  };
  const textField = (name: 'supplierName' | 'billNumber' | 'reference') =>
    field(name, quoteIn(out[name].quote, text) && quoteIn(out[name].value, out[name].quote ?? ''), 'Quote not found in the document');
  const supplierName = textField('supplierName');
  const billNumber = textField('billNumber');
  const reference = textField('reference');
  const dateField = (name: 'issueDate' | 'dueDate') => {
    const v = out[name];
    const fromQuote = parseDate(v.quote);
    const fromValue = parseDate(v.value);
    const ok = quoteIn(v.quote, text) && !!fromQuote && fromQuote === fromValue;
    const reason = !quoteIn(v.quote, text) ? 'Quote not found in the document' : !fromQuote ? 'Not an absolute date (relative wording is never inferred)' : 'Value differs from the quoted date';
    return field(name, ok, reason) ? fromQuote : null;
  };
  const issueDate = dateField('issueDate');
  const dueOn = dateField('dueDate');
  const t = out.total;
  const qMinor = amountMinor(t.quote);
  const vMinor = amountMinor(t.value);
  const totalOk = quoteIn(t.quote, text) && qMinor !== null && qMinor === vMinor;
  const totalReason = !quoteIn(t.quote, text) ? 'Quote not found in the document' : qMinor === null || vMinor === null ? 'Not an exact amount in cents' : 'Value differs from the printed total';
  const totalMinor = field('total', totalOk, totalReason) !== null ? qMinor : null;
  const remit = out.remittanceLast4;
  const last4 = remit.value && /^\d{4}$/.test(remit.value) && quoteIn(remit.quote, text) && (remit.quote ?? '').includes(remit.value) ? remit.value : null;
  field('remittanceLast4', !!last4, 'Quote not found or not the last four digits');

  // Currency: the deterministic scan decides; an explicit-USD bill also needs the model's grounded agreement.
  const scan = scanCurrency(text);
  const c = out.currency;
  const modelSays = c.value ? (/^(USD|US\$|US DOLLARS?|\$)$/i.test(c.value.trim()) ? 'USD' : c.value.trim().toUpperCase()) : null;
  const curGrounded = quoteIn(c.quote, text);
  let currency: Grounded['currency'] = null;
  const reasons: string[] = [];
  let hold: Grounded['hold'] = null;
  // A document the model calls NOT_A_BILL is held as such first: a newsletter has no currency, and that isn't the point.
  if (out.documentKind === 'NOT_A_BILL') hold = { classification: 'NOT_A_BILL', reasons: ['This document does not look like a bill'] };
  else if (scan.kind === 'CONFLICTING') hold = { classification: 'CONFLICTING_CURRENCY', reasons: [`The bill shows more than one currency (${scan.markers.join(', ')})`] };
  else if (scan.kind === 'UNSUPPORTED') hold = { classification: 'UNSUPPORTED_CURRENCY', reasons: [`The bill is in ${scan.markers.join(', ')}; Headroom handles US dollars only`] };
  else if (scan.kind === 'MISSING') hold = { classification: 'CURRENCY_MISSING', reasons: ['The bill shows no currency'] };
  else if (scan.kind === 'BARE_DOLLAR') currency = 'BARE_DOLLAR';
  else if (curGrounded && modelSays === 'USD') currency = 'USD';
  else reasons.push('Currency not confirmed by a quote in the document');
  field('currency', currency === 'USD' || (currency === 'BARE_DOLLAR' && curGrounded), currency === 'BARE_DOLLAR' ? 'Only "$" is printed: ask the owner which dollars' : 'Quote not found or disagrees with the document');

  if (!hold) {
    for (const [v, label] of [[supplierName, 'supplier'], [totalMinor, 'total'], [dueOn, 'due date']] as const) if (v === null) reasons.push(`The ${label} could not be grounded in the document`);
    if (reasons.length) hold = { classification: 'UNGROUNDED', reasons };
  }
  const untrustedInstructions = out.instructionsInDocument || INSTRUCTION.test(text);
  return {
    fields, supplierName, billNumber, reference, issueDate, dueOn, totalMinor, printedTotal: t.quote && quoteIn(t.quote, text) ? t.quote : null,
    currency: hold && hold.classification !== 'UNGROUNDED' && hold.classification !== 'NOT_A_BILL' ? null : currency, remittanceLast4: last4, hold, untrustedInstructions,
  };
}
