// Shared S6 acceptance setup (also used by the labelled REPLAY browser server): Keller's payout around its Fri 09:00 PAY job,
// on real S1–S5 upstream with the REPLAY fake PayPal. Never evidence of a payment.
import { FEES, items, pay, report, type H } from './s5-helpers.ts';
import { K } from '../../backend/src/adapters/store/keys.ts';

export const FRI_0900 = '2026-11-13T14:00:00.000Z'; // Keller's accepted due date, 09:00 New York
export const keller = async (h: H) => (await items(h, 'ACT#')).find((a) => a.kind === 'PAYOUT' && a.state !== 'SUPERSEDED')!;
export const occKey = async (h: H) => (await keller(h)).subject.occurrenceKey as string;
export const payout = async (h: H) => (await h.api('GET', `/v1/payables/payouts/${encodeURIComponent(await occKey(h))}`)).body;
export const resv = (h: H) => h.store.query('provider', K.conn(h.deps.config.connectionId), { skPrefix: 'RESV#' });
/** Every payout intent of the run, through its reservation (each intent has exactly one). */
export const effects = async (h: H) => Promise.all((await resv(h)).map(async (r) => (await h.store.get('work', K.effect(r.effectKey), 'EFFECT'))!));

/** Both customers pay (captured now), PayPal's report catches up `reported` ms later, then the PAY job runs at Fri 09:00. */
export async function heroPaid(h: H, o: { reported?: boolean; only?: 'pellow'; stop?: 'afterPost' } = {}) {
  // Not yet reported: customers pay Fri 07:30 local, after PayPal's 07:00 as-of (captured, awaiting the report: upper only).
  if (o.reported === false) h.setNow('2026-11-13T12:30:00.000Z');
  const p = await pay(h, 'cust-pellow', 760_000, FEES.pellow);
  const caps = [{ cap: p.cap, gross: 760_000, fee: FEES.pellow, number: p.inv.invoiceNumber }];
  if (o.only !== 'pellow') { const x = await pay(h, 'cust-harrow', 720_000, FEES.harrow); caps.push({ cap: x.cap, gross: 720_000, fee: FEES.harrow, number: x.inv.invoiceNumber }); }
  h.setNow(FRI_0900);
  if (o.reported !== false) report(h, caps); else h.pp.balance = { ...h.pp.balance, asOf: '2026-11-13T12:00:00.000Z' };
  h.pp.payoutFloat = caps.reduce((t, c) => t + c.gross - c.fee, 0); // PayPal's live balance holds the captures either way
  await h.api('POST', '/v1/cash/paypal/refresh');
  await h.drain();
  await h.advance(20_000); // bank re-read after the PAY job's lock, then evaluate → queue → claim → POST
  if (o.stop === 'afterPost') return caps;
  for (let i = 0; i < 4; i++) await h.advance(30_000); // item GETs: PENDING → SUCCESS
  return caps;
}

