import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.ts';
import { K } from '../../backend/src/adapters/store/keys.ts';
import { addDays } from '../../backend/src/domain/time.ts';
import { pdf } from '../../scripts/demo/bill-pdf.ts';

const hero = (o: Parameters<typeof harness>[0] = {}) => harness({ plaid: true, hero: true, paypalMinor: 180_000, ...o });
const items = (f: any) => f.days.flatMap((d: any) => d.items.map((i: any) => ({ ...i, day: d.on })));
const commit = (h: any, body: Record<string, unknown>) => h.api('POST', '/v1/commitments', { amount: { currency: 'USD', minor: 50_000 }, recurrence: 'NONE', estimate: false, protected: false, ...body });

test('S3-R22/A3 add commitment: Feb 30 → INVALID_INPUT; a past date → INVALID_INPUT; after the horizon → saved, "not yet assessed", forecast unchanged', async () => {
  const h = await hero();
  await h.drain();
  const before = await h.forecast();
  assert.equal((await commit(h, { name: 'Bad', on: '2027-02-30' })).body.code, 'INVALID_INPUT');
  assert.equal((await commit(h, { name: 'Past', on: addDays(h.day0(), -1) })).body.code, 'INVALID_INPUT');
  const late = await commit(h, { name: 'Van lease', on: addDays(h.day0(), 50) });
  assert.equal(late.status, 201);
  assert.equal(late.body.commitment.afterHorizon, true);
  assert.match(late.body.effect, /not yet assessed/);
  const f = await h.forecast();
  assert.deepEqual(f.days, before.days);
  assert.ok(f.notInForecast.some((r: any) => /Van lease/.test(r.label) && /not yet assessed/.test(r.reason)));
  const p = (await h.api('GET', '/v1/payables')).body;
  assert.ok(p.commitments.some((c: any) => c.name === 'Van lease' && c.substantiation === 'OWNER-ENTERED' && c.afterHorizon));
});

test('S3-R31 a one-time commitment after the horizon enters the forecast once the horizon reaches it', async () => {
  const h = await hero();
  await h.drain();
  const d0 = h.day0();
  await commit(h, { name: 'Van lease', on: addDays(d0, 45) });
  assert.equal(items(await h.forecast()).filter((i: any) => i.label === 'Van lease').length, 0);
  h.setNow(`${addDays(d0, 5)}T15:00:00.000Z`);
  const f = await h.forecast();
  assert.deepEqual(items(f).filter((i: any) => i.label === 'Van lease').map((i: any) => [i.day, i.amount.minor]), [[addDays(d0, 45), 50_000]]);
});

test('S3-R30 a monthly commitment: the next occurrence appears exactly once as the horizon advances; none disappears', async () => {
  const h = await hero();
  await h.drain();
  const d0 = h.day0();
  const r = await commit(h, { name: 'Software', on: addDays(d0, 14), recurrence: 'MONTHLY' });
  assert.match(r.body.effect, /then monthly/);
  const at = async (offset: number) => { h.setNow(`${addDays(d0, offset)}T15:00:00.000Z`); return items(await h.forecast()).filter((i: any) => i.label === 'Software').map((i: any) => `${i.day}:${i.basis}`); };
  const first = await at(0);
  assert.equal(first.length, 1);
  const later = await at(20);
  assert.equal(later.length, 2, JSON.stringify(later));
  assert.equal(new Set(later).size, 2, 'no duplicate');
  assert.ok(later.some((x: string) => x.endsWith(':PAST_DUE')), 'the first, unpaid, stays on day 0');
});

test('S3-R23 a past-due unpaid obligation is counted on day 0 as past due', async () => {
  const h = await hero();
  await h.drain();
  const d0 = h.day0();
  h.setNow(`${addDays(d0, 8)}T15:00:00.000Z`);
  const f = await h.forecast();
  const rental = f.days[0].items.find((i: any) => i.label === 'Equipment rental');
  assert.deepEqual([rental.basis, rental.on], ['PAST_DUE', addDays(d0, 8)]);
  assert.match(rental.note, /Was due/);
});

test('S3-R33 badge: with recent sources and a due-today $10,020.00 obligation, Reserve currently met is NOT_MET, never MET', async () => {
  const h = await hero({ asOfLagMs: 60_000 });
  await h.drain();
  const before = (await h.cash()).currentBadge;
  const d = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' }).format(new Date(`${h.day0()}T00:00:00Z`));
  const lines = ['Keller Drafting Co.', 'INVOICE K-2260', 'Reference: MS-2', `Payment due: ${d}`, 'Amount due USD $10,000.00', 'Remit to account ending 4417'];
  const id = (await h.inject('hero', { bytes: pdf({ lines }) })).billId;
  let b = await h.bill(id);
  await h.api('POST', `/v1/bills/${id}/verify`, { occurrenceKey: b.occurrence.occurrenceKey, occurrenceVersion: b.occurrence.version }, { 'if-match': String(b.bill.version) });
  b = await h.bill(id);
  assert.equal((await h.api('POST', `/v1/bills/${id}/accept-terms`, { termsHash: b.termsHash, changedFields: b.changedFields }, { 'if-match': String(b.bill.version) })).status, 200);
  const after = (await h.cash()).currentBadge;
  assert.notEqual(after.state, 'MET', JSON.stringify({ before, after }));
  if (before.state === 'MET') assert.equal(after.state, 'NOT_MET', 'same fresh sources: the due obligation alone flips it');
});

test('O4 two concurrent verifications of one occurrence (put-if-absent) → one OBL#, one winner, the loser gets VERSION_CONFLICT', async () => {
  const h = await hero();
  await h.drain();
  const a = await h.bill((await h.inject('hero')).billId);
  const b = await h.bill((await h.inject('amount')).billId);
  assert.equal(a.occurrence.occurrenceKey, b.occurrence.occurrenceKey);
  const v = (x: any) => h.api('POST', `/v1/bills/${x.bill.billId}/verify`, { occurrenceKey: x.occurrence.occurrenceKey, occurrenceVersion: 0 }, { 'if-match': String(x.bill.version) });
  const [ra, rb] = await Promise.all([v(a), v(b)]);
  assert.deepEqual([ra.status, rb.status].sort(), [200, 409]);
  const runId = `run-${a.bill.billId.split('_')[1]}`;
  const obl = await h.store.query('core', K.run('tenant-a', runId), { skPrefix: 'OBL#cmt-keller-ms2#' });
  assert.equal(obl.length, 1);
  assert.ok([a.bill.billId, b.bill.billId].includes(obl[0].substantiatedBy));
});

test('C1/S3-R39 calendar data: 42 consecutive days from business-today, whatever the weekday', async () => {
  const h = await hero({ start: '2026-11-08T15:00:00.000Z' }); // a Sunday in New York
  await h.drain();
  const f = await h.forecast();
  assert.equal(f.days.length, 42);
  assert.equal(new Date(`${f.days[0].on}T00:00:00Z`).getUTCDay(), 0);
  assert.equal(f.days[41].on, addDays(f.days[0].on, 41));
  assert.equal(f.horizon.to, f.days[41].on);
});
