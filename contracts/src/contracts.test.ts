import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Money, ProviderAmount, decimalToMinor, minorToDecimal, transitions, canTransition, routes, CreateInvoiceDraftBody, EvidenceInterpreterOutput, Forecast, ForecastSummary } from './index.ts';
import { buildOpenApi } from '../scripts/openapi.ts';

test('money rejects float / negative / mixed currency', () => {
  assert.equal(Money.safeParse({ currency: 'USD', minor: 1.5 }).success, false);
  assert.equal(Money.safeParse({ currency: 'USD', minor: -1 }).success, false);
  assert.equal(Money.safeParse({ currency: 'EUR', minor: 100 }).success, false);
  assert.equal(Money.safeParse({ currency: 'USD', minor: 12345 }).success, true);
});

test('decimal ↔ minor is exact and refuses sub-cent values', () => {
  assert.equal(decimalToMinor('120.00'), 12000);
  assert.equal(decimalToMinor('-3.08'), -308);
  assert.equal(decimalToMinor('5'), 500);
  assert.equal(decimalToMinor('0.5'), 50);
  assert.throws(() => decimalToMinor('1.005'));
  assert.throws(() => decimalToMinor('1e3'));
  assert.equal(minorToDecimal(11532), '115.32');
  assert.equal(minorToDecimal(-308), '-3.08');
  assert.equal(minorToDecimal(5), '0.05');
});

test('every state machine edge points at a listed state, and every non-initial state is reachable', () => {
  for (const [machine, edges] of Object.entries(transitions) as [string, Record<string, readonly string[]>][]) {
    const states = Object.keys(edges);
    const reached = new Set(Object.values(edges).flat());
    for (const to of reached) assert.ok(states.includes(to), `${machine}: ${to} not listed`);
    for (const s of states.slice(1)) assert.ok(reached.has(s), `${machine}: ${s} unreachable`);
  }
  assert.equal(canTransition('Effect', 'READY', 'UNKNOWN'), false, 'READY never becomes UNKNOWN: nothing was dispatched');
  assert.equal(canTransition('Effect', 'UNKNOWN', 'READY'), false, 'UNKNOWN never re-dispatches with a new key');
});

test('draft body is strict and money-typed', () => {
  assert.equal(CreateInvoiceDraftBody.safeParse({ customerId: 'c', amount: { currency: 'USD', minor: 100 }, dueOn: '2026-11-20', tenantId: 'x' }).success, false);
});

test('openapi api.yaml is up to date with api.ts', () => {
  const committed = readFileSync(new URL('../openapi/api.yaml', import.meta.url), 'utf8');
  assert.equal(committed, buildOpenApi(), 'run npm run openapi');
  assert.equal(Object.keys(routes).length, 68); // + judge dock (takeLiveRun) + golden run email (goldenMail, getGoldenMail) + S7b demo lane (11, incl. demoKellerReply) // S6: getPayout, confirmPayee, revealPayee; S7: acceptPromise, confirmDispute, dismissDispute
});

test('S2-R13 no schema key carries a token except the link token response', () => {
  const keys = new Set<string>();
  const walk = (j: unknown) => { if (j && typeof j === 'object') for (const [k, v] of Object.entries(j)) { if (k === 'properties' && v && typeof v === 'object') Object.keys(v).forEach((x) => keys.add(x)); walk(v); } };
  walk(JSON.parse(buildOpenApi()));
  // inputTokens/outputTokens are model usage counts (S3 extraction provenance), not credentials.
  const tokenish = [...keys].filter((k) => /token/i.test(k) && !/^(input|output)Tokens$/.test(k));
  assert.deepEqual(tokenish.sort(), ['linkToken', 'publicToken'], 'publicToken only in the exchange request body; linkToken only in its response');
});

test('bank machines: nothing leaves DISCONNECTING except DISCONNECTED; UNKNOWN never re-dispatches', () => {
  assert.deepEqual(transitions.BankConnection.DISCONNECTING, ['DISCONNECTED']);
  assert.equal(canTransition('BankEffect', 'UNKNOWN', 'READY'), false);
  assert.equal(canTransition('BankEffect', 'READY', 'UNKNOWN'), false);
  assert.equal(canTransition('BankEffect', 'EXCHANGED', 'UNKNOWN'), false, 'a captured exchange is definitive');
});

test('ProviderAmount is display-only: Money refuses EUR and non-integer minor', () => {
  assert.equal(ProviderAmount.safeParse({ value: '1024.502621', currencyCode: 'USD', currencyKind: 'ISO' }).success, true);
  assert.equal(Money.safeParse({ currency: 'EUR', minor: 12345 }).success, false);
});

test('S3 bill machine: HELD terminal; PROPOSED → TERMS_ACCEPTED only exists for the separate-obligation path; retry from READ_FAILED', () => {
  assert.deepEqual(transitions.Bill.HELD, []);
  // S4-D17: RECEIVED → VERIFIED exists only for the read's own final write (exact match under Delegation); still nothing is verified unread.
  assert.equal(canTransition('Bill', 'RECEIVED', 'VERIFIED'), true);
  assert.equal(canTransition('Bill', 'READ_FAILED', 'RECEIVED'), true);
  assert.equal(canTransition('Bill', 'VERIFIED', 'PROPOSED'), false);
});

test('S3-R20 EvidenceInterpreterOutput refuses unknown keys (e.g. markPaid)', () => {
  const q = { value: null, quote: null };
  const ok = { supplierName: q, billNumber: q, reference: q, issueDate: q, dueDate: q, total: q, currency: q, remittanceLast4: q, documentKind: 'BILL', instructionsInDocument: false, instructionQuotes: [] };
  assert.equal(EvidenceInterpreterOutput.safeParse(ok).success, true);
  assert.equal(EvidenceInterpreterOutput.safeParse({ ...ok, markPaid: true }).success, false);
  assert.equal(EvidenceInterpreterOutput.safeParse({ ...ok, total: { value: '1', quote: '1', confidence: 0.9 } }).success, false);
});

test('S3 forecast: 42 days exactly; reserve gap and funding deficit are non-negative Money', () => {
  const s = { low: { currency: 'USD', minor: -1 }, lowOn: '2026-11-09', negativeDays: 1, atReserveDays: 0, belowReserveDays: 1, firstBelowReserve: '2026-11-09', reserveGap: { currency: 'USD', minor: -5 }, fundingDeficit: { currency: 'USD', minor: 1 } };
  assert.equal(ForecastSummary.safeParse(s).success, false, 'negative gap refused');
  assert.equal(Forecast.options[1].shape.state.value, 'READY');
  assert.equal(Forecast.options[1].shape.days.safeParse([]).success, false);
});

test('S3 routes have specific bodies (no generic object) and every command declares its body', () => {
  const doc = JSON.parse(buildOpenApi());
  for (const op of ['uploadDocument', 'verifyBill', 'acceptBillTerms', 'addBillAsObligation', 'createCommitment'] as const) {
    const r = routes[op];
    const schema = doc.paths[r.path].post.requestBody.content['application/json'].schema;
    assert.equal(schema.additionalProperties, false, `${op} body is strict`);
    assert.ok(Object.keys(schema.properties).length > 0, `${op} body has named properties`);
  }
});

test('S4 contracts: no likelihood figure, strict model outputs with no fact-bearing keys, no generic bodies, all edit ops', async () => {
  const { OutlookRow, RecoveryPlannerOutput, MessageDrafterOutput, EditRevisionBody } = await import('./index.ts');
  assert.equal(OutlookRow.shape.likelihood.safeParse('NOT_ASSESSED').success, true);
  assert.equal(OutlookRow.shape.likelihood.safeParse('0.7').success, false);
  const keys = (j: unknown, out = new Set<string>()): Set<string> => { if (j && typeof j === 'object') for (const [k, v] of Object.entries(j)) { if (k === 'properties' && v && typeof v === 'object') Object.keys(v).forEach((x) => out.add(x)); keys(v, out); } return out; };
  const { z } = await import('zod');
  for (const s of [RecoveryPlannerOutput, MessageDrafterOutput]) {
    assert.equal(s.safeParse({ ...(s === RecoveryPlannerOutput ? { selected: [], considered: [], why: [], summary: '' } : { drafts: [] }), amount: 1 }).success, false, 'unknown keys refused');
    for (const k of keys(z.toJSONSchema(s))) assert.doesNotMatch(k, /^(amount|.*minor|.*date|due.*|.*On|.*At|percent|bp|discount.*|state|recipient.*|grant.*|email)$/i, `model output key ${k}`);
  }
  for (const [op, r] of Object.entries(routes)) if ('body' in r && r.body) assert.notEqual(JSON.stringify(z.toJSONSchema(r.body)), JSON.stringify({ type: 'object' }), op);
  assert.deepEqual(EditRevisionBody.options.map((o) => o.shape.op.value).sort(), ['EDIT_ACTION', 'INCLUDE_CONSIDERED', 'REMOVE', 'RESTORE', 'USE_ALTERNATIVE']);
  assert.equal(canTransition('Action', 'SCHEDULED', 'REMOVED'), true, 'S4-PR-04: running work can be removed');
  assert.equal(canTransition('PlanBuild', 'FAILED', 'BUILDING'), true, 'S4-PR-08: a failed build can be retried');
});

test('S5 contracts: executed actions never edited/removed/superseded; CONSUMED/UPDATE machines; check series of 42; claim required (S05 §6.3)', async () => {
  const { ActionStates, EXECUTED_ACTION_STATES, Allocation, SkipCheck, UpdateEffect, Grant } = await import('./index.ts');
  assert.ok(!(ActionStates as readonly string[]).includes('CHECKING'), 'no CHECKING state (S5-D23)');
  for (const s of EXECUTED_ACTION_STATES) for (const to of ['REMOVED', 'SUPERSEDED', 'PROPOSED']) assert.equal(canTransition('Action', s, to), false, `${s} → ${to}`);
  assert.deepEqual(transitions.Grant.ACTIVE, ['REVOKED', 'LAPSED', 'CONSUMED']);
  assert.equal(canTransition('Grant', 'CONSUMED', 'ACTIVE'), false);
  assert.equal(Grant.shape.consumedBy.parse(undefined), null, 'S4-era grants read back');
  assert.equal(canTransition('UpdateEffect', 'UNKNOWN', 'READY'), false, 'an UNKNOWN update is never re-prepared with a new body');
  assert.equal(canTransition('UpdateEffect', 'DISPATCHED', 'READY'), false, 'only a never-dispatched PREPARED may go back to READY');
  assert.equal(canTransition('UpdateEffect', 'PREPARED', 'READY'), true);
  assert.deepEqual(transitions.UpdateEffect.CONFLICT, [], 'a conflict never writes');
  assert.equal(canTransition('OfferExpiry', 'HELD_PAUSED', 'REMOVED'), false, 'a paused removal waits for resume (Build Book §E 10)');
  assert.equal(UpdateEffect.shape.request.safeParse({ rawRef: 'r', method: 'POST', pathAndQuery: '/x', sha256: 's' }).success, false, 'updates are PUT only');
  assert.equal(Allocation.safeParse({ allocationId: 'a', captureId: 'c', invoiceId: 'i', amount: { currency: 'USD', minor: 1 }, at: '2026-11-09T00:00:00.000Z' }).success, false, 'claim required');
  // S7 R5: DISPUTED exists only under a consumed COLLECT_DISPUTED allowance (allocateClaim; backend Y5 tests); never automatically.
  assert.deepEqual(Allocation.shape.claim.options, ['WHOLE', 'UNDISPUTED', 'DISPUTED', 'UNALLOCATED']);
  assert.equal(SkipCheck.shape.lowerSeries.safeParse(Array.from({ length: 41 }, () => ({ on: '2026-11-09', closeMinor: 0 }))).success, false, 'series are 42 days');
  assert.deepEqual(SkipCheck.shape.decision.options, ['SKIP', 'HELD_EVIDENCE', 'NEEDED', 'HELD']);
});
