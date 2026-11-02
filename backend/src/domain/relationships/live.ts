// Live relationship facts (S07 §6.18 R8), derived on every read from immutable records, so each has a stable identity (its invoice or
// promise) and nothing is ever counted twice: `paid:<invoiceId>` once PayPal shows the invoice PAID (days late from its due date to the
// settling capture's business date; partials don't count; a refund that reopens it withdraws the fact by itself), `dispute:<invoiceId>`
// while a confirmed customer dispute has money outstanding, `missed:<promiseId>` when a promised day passed with no payment by then
// (a later payment does not remove it). Labelled LIVE beside SEEDED history.
import type { HistoryEntry, LocalDate } from '@headroom/contracts';
import type { Item } from '../../adapters/store/port.ts';
import { businessDate } from '../time.ts';

export function liveHistory(items: Item[], today: LocalDate, tz: string): HistoryEntry[] {
  const by = (p: string) => items.filter((i) => i.sk.startsWith(p));
  const rcpts = by('RCPT#');
  const out: HistoryEntry[] = [];
  let n = 1000;
  for (const inv of by('INV#').sort((a, z) => String(a.invoiceId).localeCompare(String(z.invoiceId)))) {
    const caps = rcpts.filter((r) => r.invoiceId === inv.invoiceId).sort((a, z) => String(a.capturedAt).localeCompare(String(z.capturedAt)));
    if (inv.state === 'PAID' && caps.length) out.push({ counterpartyId: inv.customerId, n: n++, kind: 'INVOICE_PAID', ref: `${inv.invoiceNumber} (PayPal)`, dueOn: inv.dueOn, paidOn: businessDate(caps.at(-1)!.capturedAt, tz), amount: inv.amount, note: 'From PayPal receipts', open: false, basis: 'LIVE' });
    const claim = items.find((i) => i.sk === `CLAIM#${inv.invoiceId}`);
    // A seeded claim's dispute is already in the seeded history; a live one comes from the customer's own email.
    if (claim && claim.basis !== 'SEEDED') {
      const settled = by('ALLOC#').filter((a) => a.invoiceId === inv.invoiceId && a.claim === 'DISPUTED').reduce((t, a) => t + a.amount.minor, 0);
      out.push({ counterpartyId: inv.customerId, n: n++, kind: 'DISPUTE', ref: `${inv.invoiceNumber} (their email)`, dueOn: inv.dueOn, paidOn: null, amount: claim.disputed, note: `Disputes $${(claim.disputed.minor / 100).toFixed(2)} of ${inv.invoiceNumber}`, open: claim.disputed.minor - settled > 0, basis: 'LIVE' });
    }
  }
  for (const p of by('PROMISE#')) {
    if (p.on >= today) continue;
    const paidBy = rcpts.some((r) => r.invoiceId === p.invoiceId && businessDate(r.capturedAt, tz) <= p.on);
    if (!paidBy && (!p.beyondLimitDays || p.acceptedBy)) out.push({ counterpartyId: p.customerId, n: n++, kind: 'ARRANGEMENT_MISSED', ref: `Promise for ${p.on} (their email)`, dueOn: p.on, paidOn: null, amount: p.amount ?? { currency: 'USD', minor: 0 }, note: `“${p.quote}” · no payment by then`, open: false, basis: 'LIVE' });
  }
  return out;
}
