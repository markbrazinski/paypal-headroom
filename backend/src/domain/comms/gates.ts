// Inbound mail gates (probe 03). Pure. The sender gate decides whose words these are; the reply gate keeps only facts the code can
// read verbatim out of the body. A model proposes intent and quotes; dates and amounts are parsed here, never taken from the model.
import type { ParsedMessage } from '../../adapters/mail/rfc5322.ts';
import type { AuthVerdict } from '../../adapters/mail/types.ts';

export type SenderHold = 'HOLD_UNAUTHORIZED' | 'HOLD_UNVERIFIED' | 'HOLD_AMBIGUOUS_SENDER';

export function senderGate(parsed: ParsedMessage, auth: AuthVerdict | null, knownContact: string | null):
  { ok: true; address: string } | { ok: false; code: SenderHold; text: string } {
  if (parsed.fromAddresses.length !== 1) return { ok: false, code: 'HOLD_AMBIGUOUS_SENDER', text: `expected one From address, found ${parsed.fromAddresses.length}` };
  const address = parsed.fromAddresses[0];
  if (!knownContact || address !== knownContact.trim().toLowerCase()) return { ok: false, code: 'HOLD_UNAUTHORIZED', text: `${address} is not the known contact for this counterparty` };
  if (auth?.dmarc !== 'pass') return { ok: false, code: 'HOLD_UNVERIFIED', text: `sender authentication did not pass (DMARC ${auth?.dmarc ?? 'unknown'})` };
  return { ok: true, address };
}

export type ReplyIntent = 'PROMISE' | 'ACKNOWLEDGE_UNDISPUTED' | 'DISPUTE' | 'DISPUTE_PARTIAL' | 'PAID_CLAIM' | 'QUESTION' | 'OTHER' | 'TERMS_AGREED' | 'TERMS_COUNTER' | 'TERMS_DECLINED';
export type TermsQuote = { date: string | null; amount: string | null };

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MON = '([a-z]+)\\.?';
const DAY = '(\\d{1,2})(?:st|nd|rd|th)?';
const YEAR = '(?:,?\\s+(\\d{4}))?';
const month = (w: string) => {
  if (w === 'sept') return 9;
  const i = w.length >= 3 ? MONTHS.findIndex((m) => m.startsWith(w)) : -1;
  return i < 0 ? null : i + 1;
};

/** An exact calendar date from a quoted string, YYYY-MM-DD; null for anything relative, ambiguous or unparseable. */
export function exactDate(s: string, today: string): string | null {
  const t = s.trim().toLowerCase();
  let y: number | null = null, m: number | null = null, d: number | null = null, r: RegExpExecArray | null;
  if ((r = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t))) [y, m, d] = [+r[1], +r[2], +r[3]];
  // ponytail: n/n/yyyy read as US month/day (USD invoices); no-year numeric dates are refused as ambiguous.
  else if ((r = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t))) [m, d, y] = [+r[1], +r[2], +r[3]];
  else if ((r = new RegExp(`^${MON}\\s+${DAY}${YEAR}$`).exec(t))) [m, d, y] = [month(r[1]), +r[2], r[3] ? +r[3] : null];
  else if ((r = new RegExp(`^${DAY}\\s+(?:of\\s+)?${MON}${YEAR}$`).exec(t))) [d, m, y] = [+r[1], month(r[2]), r[3] ? +r[3] : null];
  if (m === null || d === null) return null;
  const iso = (yy: number) => {
    const dt = new Date(Date.UTC(yy, m! - 1, d!));
    return dt.getUTCMonth() === m! - 1 && dt.getUTCDate() === d ? dt.toISOString().slice(0, 10) : null;
  };
  if (y !== null) return iso(y);
  const ty = Number(today.slice(0, 4));
  const thisYear = iso(ty);
  return thisYear !== null && thisYear >= today ? thisYear : iso(ty + 1); // the next occurrence on/after today
}

/** Minor units from "$7,600", "$7,600.00", "7600 USD", "USD 7,600"; null without a currency marker or in words. */
export function exactAmountMinor(s: string): number | null {
  const r = /^(\$|usd\s*)?\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{2}))?\s*(usd)?$/i.exec(s.trim());
  if (!r || (!r[1] && !r[4])) return null;
  const minor = Number(r[2].replaceAll(',', '')) * 100 + Number(r[3] ?? 0);
  return Number.isSafeInteger(minor) ? minor : null;
}

export function replyGate(
  body: string,
  out: { intent: ReplyIntent; quote: string; quotedDate: string | null; quotedAmount: string | null; amountQuotes?: { disputed: string | null; undisputed: string | null } | null; termsQuotes?: TermsQuote[] | null },
  today: string,
): { ok: true; intent: ReplyIntent; quote: string; on: string | null; amountMinor: number | null; amountQuotes: { disputed: string | null; undisputed: string | null } | null; termsQuotes: TermsQuote[] | null } | { ok: false; reason: string } {
  for (const [k, v] of [['quote', out.quote], ['quotedDate', out.quotedDate], ['quotedAmount', out.quotedAmount], ['amountQuotes.disputed', out.amountQuotes?.disputed ?? null], ['amountQuotes.undisputed', out.amountQuotes?.undisputed ?? null], ...(out.termsQuotes ?? []).flatMap((t, i) => [[`termsQuotes.${i}.date`, t.date], [`termsQuotes.${i}.amount`, t.amount]] as const)] as const) {
    if (v !== null && (!v.trim() || !body.includes(v))) return { ok: false, reason: `${k} is not a verbatim part of the message` };
  }
  const on = out.quotedDate === null ? null : exactDate(out.quotedDate, today);
  const amountMinor = out.quotedAmount === null ? null : exactAmountMinor(out.quotedAmount);
  // A relative/ambiguous date or a dateless promise needs the owner. A dispute or paid claim keeps its intent: demoting it would hide it.
  const vague = (out.quotedDate !== null && on === null) || (out.intent === 'PROMISE' && on === null);
  const intent = vague && out.intent !== 'DISPUTE' && out.intent !== 'DISPUTE_PARTIAL' && out.intent !== 'PAID_CLAIM' ? 'QUESTION' : out.intent;
  return { ok: true, intent, quote: out.quote, on, amountMinor, amountQuotes: out.amountQuotes ?? null, termsQuotes: out.termsQuotes ?? null };
}

/** The one money amount in a verbatim quote ("the $1,800 change order"), or null when there is none or more than one. */
export function oneAmountMinor(quote: string): number | null {
  const hits = quote.match(/(?:\$|usd\s*)\s*\d{1,3}(?:,\d{3})+(?:\.\d{2})?|(?:\$|usd\s*)\s*\d+(?:\.\d{2})?|\d{1,3}(?:,\d{3})+(?:\.\d{2})?\s*usd|\d+(?:\.\d{2})?\s*usd/gi) ?? [];
  return hits.length === 1 ? exactAmountMinor(hits[0]) : null;
}

/**
 * S7 R4: a dispute's split from the reply's own words. Both parts quoted → they must sum to what is open; one quoted → the other is
 * open − it (labelled derived); none, or a mismatch → null amounts and the owner types them. The model never supplies a number.
 */
export function disputeSplit(q: { disputed: string | null; undisputed: string | null } | null, openMinor: number): { disputedMinor: number | null; undisputedMinor: number | null; derived: 'DISPUTED' | 'UNDISPUTED' | null } {
  const none = { disputedMinor: null, undisputedMinor: null, derived: null };
  const dis = q?.disputed ? oneAmountMinor(q.disputed) : null;
  const und = q?.undisputed ? oneAmountMinor(q.undisputed) : null;
  const fits = (d: number, u: number) => d > 0 && u >= 0 && d + u === openMinor;
  if (dis !== null && und !== null) return fits(dis, und) ? { disputedMinor: dis, undisputedMinor: und, derived: null } : none;
  if (dis !== null) return fits(dis, openMinor - dis) ? { disputedMinor: dis, undisputedMinor: openMinor - dis, derived: 'UNDISPUTED' } : none;
  if (und !== null) return fits(openMinor - und, und) ? { disputedMinor: openMinor - und, undisputedMinor: und, derived: 'DISPUTED' } : none;
  return none;
}
