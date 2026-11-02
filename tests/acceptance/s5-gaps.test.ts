// S5 layer 3: the remaining refusal cases (S05 §7a): bill mid-check, two runners one check, old-run work after reset, cross-tenant
// ids, mail intake crash replay. Setup in s5-helpers.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { K } from '../../backend/src/adapters/store/keys.ts';
import { SimulatedCrash } from '../../backend/src/deps.ts';
import { operatorReset } from '../../backend/src/handlers/operator.ts';
import { newJob, putJobOp } from '../../backend/src/jobs/lease.ts';
import { b64url, buildMessage } from '../../backend/src/adapters/mail/rfc5322.ts';
import { OWNER_B } from './harness.ts';
import { actionOf, approved, check, FEES, items, lagReport, pay, pk, puts, TUE_0805, WED_0900, type H } from './s5-helpers.ts';

/** Both paid, and PayPal's report has stopped moving (> 8 h old, S7-B10): the Wednesday check holds for evidence (no NEEDED write races these cases). */
async function bothPaid() {
  const { h } = await approved();
  h.setNow(TUE_0805);
  await h.drain();
  h.setNow('2026-11-11T13:30:00.000Z');
  await pay(h, 'cust-pellow', 760_000, FEES.pellow);
  await pay(h, 'cust-harrow', 720_000, FEES.harrow);
  h.setNow(WED_0900);
  lagReport(h, 9 * 3600_000);
  return h;
}

test('S5-R10/AT-F06 a bill arriving during the check is an undecided input: the check holds, never skips on the old picture', async () => {
  const h = await bothPaid();
  await h.drain(); // run 1: lock + refresh
  await h.inject('amount', { drain: false }); // a new bill lands before run 2
  await h.advance(20_000);
  const a = await actionOf(h, 'DISCOUNT_FALLBACK');
  const chk = await h.store.get('core', pk(h), a.lastCheckId);
  assert.notEqual(a.state, 'SKIPPED_NOT_NEEDED');
  assert.ok(chk!.blockers.some((b: any) => b.code === 'BILL_UNDECIDED') || chk!.decision !== 'SKIP', JSON.stringify(chk!.blockers));
});

test('S5-R11/L1 two runners on one check: one lease, one generation decides, one outcome', async () => {
  const h = await bothPaid();
  const a = await actionOf(h, 'DISCOUNT_FALLBACK');
  // A second runner for the same check (e.g. a duplicate delivery): another job id, same action and intent.
  await h.store.transact([putJobOp(newJob(`due#${a.actionId}#${a.intentVersion}#CHECK#1`, 'ACTION_DUE', a.actionId, h.clock(), 'tenant-a', h.run!.runId))]);
  await check(h);
  const checks = await items(h, `CHECK#${a.actionId}#`);
  assert.equal(checks.length, 1, 'one decision');
  assert.equal((await actionOf(h, 'DISCOUNT_FALLBACK')).state, 'HELD_EVIDENCE');
  const run = await h.store.get('core', pk(h), `CHECKRUN#${a.actionId}`);
  assert.equal(run!.phase, 'DONE');
});

test('S5-R20 after a reset, the earlier run’s due work ends in its own run: no PayPal update, no message, nothing in the new run', async () => {
  const { h } = await approved();
  const oldPk = pk(h);
  const p0 = puts(h);
  const m0 = (await h.mailbox.list()).length;
  await operatorReset(h.deps, 'tenant-a', 'acceptance: reset mid-plan', { bank: 'seed', hero: true });
  h.setNow(TUE_0805);
  await h.drain();
  assert.equal(puts(h), p0, 'no update dispatched for the old run');
  assert.equal((await h.mailbox.list()).length, m0, 'no message sent for the old run');
  const old = (await h.store.query('core', oldPk, { skPrefix: 'ACT#' })).filter((a) => a.kind === 'COLLECT_UNDISPUTED_SLICE');
  assert.ok(old.every((a) => a.state !== 'APPLIED'));
  const skipped = (await h.store.query('audit', oldPk)).filter((e) => e.eventType === 'ActionDueSkipped' && /reset/.test(e.result));
  assert.ok(skipped.length >= 1, 'audited in the old run');
});

test('S5-R21 another tenant’s action, customer or message id is NOT_FOUND', async () => {
  const { h } = await approved();
  const a = await actionOf(h, 'DISCOUNT_FALLBACK');
  const asB = (method: string, path: string, body: unknown, headers: Record<string, string> = {}) => h.api(method, path, body, headers, OWNER_B);
  assert.equal((await asB('POST', `/v1/plan/actions/${a.actionId}/decide`, { decision: 'DONT_SEND', checkId: 'x' }, { 'if-match': String(a.version) })).status, 404);
  assert.equal((await asB('POST', `/v1/inbox/messages/${a.actionId}/hold`, { held: true })).status, 404);
  assert.equal((await asB('POST', '/v1/receivables/threads/cust-mercer/owner', { owner: 'YOU' }, { 'if-match': '0' })).status, 404);
  assert.equal((await h.store.query('core', pk(h), { skPrefix: 'THREAD#' })).length, 0, 'tenant-a untouched');
});

test('S5-PR-09/M7/R39 a crash after taking a reply in, before the cursor moves: the replay finds it taken in; exactly one interpretation job', async () => {
  const { h } = await approved();
  h.setNow(TUE_0805);
  await h.drain();
  const out = (await items(h, 'OUTMSG#')).find((o) => o.customerId === 'cust-pellow')!;
  const raw = buildMessage({ from: 'accounts.pellow@example.com', to: ['headroom@headroom.example'], subject: 'Re: invoice', text: 'Thanks, we will look into it.', messageId: '<r.crash@pellow.example>', inReplyTo: out.rfcMessageId, references: [out.rfcMessageId], date: h.clock() });
  await h.mailbox.inject({ raw: b64url.encode(raw), auth: { source: 'SIMULATED', dkim: 'pass', spf: 'pass', dmarc: 'pass' } });
  let crashed = false;
  h.store.beforeTransact = (ops) => { if (!crashed && ops.some((o) => o.op === 'update' && o.sk === 'MAILCURSOR')) { crashed = true; throw new SimulatedCrash('crash before the cursor commit'); } };
  await h.advance(61_000);
  h.store.beforeTransact = undefined;
  assert.ok(crashed);
  await h.advance(120_000); // lease expiry → the sweep re-delivers MAIL_SYNC → replay
  const mails = await items(h, 'MAIL#');
  assert.equal(mails.length, 1);
  const jobs = (await h.store.dump('work')).filter((j) => String(j.pk).startsWith(`JOB#reply#`));
  assert.equal(jobs.length, 1, 'one interpretation job, none lost, none doubled');
  void K;
});

test('Adopted 2 Nov 2026: Inbox and Overview load under the API role’s dev permissions with Gmail as the channel (the dev 500 that local runs missed)', async () => {
  const { h } = await approved();
  h.deps.config.mail = { kind: 'GMAIL', sender: null, inbox: null };
  const inbox = await h.api('GET', '/v1/inbox');
  assert.equal(inbox.status, 200, JSON.stringify(inbox.body));
  assert.equal(inbox.body.channel.state, 'NOT_CONNECTED');
  const ov = await h.api('GET', '/v1/overview');
  assert.equal(ov.status, 200, JSON.stringify(ov.body));
  assert.ok(ov.body.needs.some((n: any) => n.key === 'mail:channel'), 'Gmail not connected is a Needs row');
});
