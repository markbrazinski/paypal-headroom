// Supplier asks (S07 §6.18 R6). Code makes the options (KEEP the original date, or SPLIT so the reserve holds through the original date);
// a reply is grounded (verbatim quotes, code-parsed dates and amounts) and matched to exactly one option or it is a COUNTER; a reply
// alone changes nothing. Only the owner accepts an answer: one TX, fenced on the obligation and bill, refused once a payout holds it.
import type { LocalDate, Occurrence, SupplierAnswer, SupplierAskOption } from '@headroom/contracts';
import { basisBumpOp, K } from '../../adapters/store/keys.ts';
import type { Item, Op } from '../../adapters/store/port.ts';
import { ApiError } from '../../api-error.ts';
import type { ReadCtx } from '../../read/models.ts';
import type { ForecastModel } from '../../read/s3.ts';
import { auditOp } from '../audit/audit.ts';
import { exactAmountMinor, exactDate, type TermsQuote } from '../comms/gates.ts';
import { loadPlanState } from '../plan/state.ts';
import { fenceCheck, type CommandCtx, type CommandResult } from '../receivables/commands.ts';
import { oblSk, occKey, parseOccKey, payoutFeeEstimateMinor } from './obligations.ts';

const usd = (minor: number) => ({ currency: 'USD' as const, minor });
const dollars = (m: number) => `$${(m / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const SPLIT_STEP_MINOR = 10_000;
export const SPLIT_MIN_MINOR = 100_000;
export type AnswerItem = SupplierAnswer & Item;
export const answerSk = (askId: string, messageId: string) => `SUPPLIERANSWER#${askId}#${messageId}`;
/** The second part of a split is its own one-off commitment, backed by the same accepted bill (so S6 payout rules apply unchanged). */
export const splitCommitmentId = (occurrenceKey: string) => `split-${occurrenceKey.replace(/[^a-z0-9-]/gi, '-')}`;

/**
 * KEEP: the original (scheduled) date, same amount. SPLIT: part 1 on the requested date = the largest amount, in $100 steps and at
 * least $1,000, that keeps Expected ≥ reserve through the original date; part 2 the rest on the original date. No SPLIT if none fits.
 */
export function askOptions(f: ForecastModel, o: Pick<Occurrence, 'occurrenceKey' | 'dueOn' | 'scheduledOn' | 'amount'>): SupplierAskOption[] {
  const keep: SupplierAskOption = { code: 'KEEP', parts: [{ dueOn: o.scheduledOn, amount: o.amount }] };
  const total = o.amount.minor;
  for (let x = Math.floor((total - 1) / SPLIT_STEP_MINOR) * SPLIT_STEP_MINOR; x >= SPLIT_MIN_MINOR; x -= SPLIT_STEP_MINOR) {
    const g = f.withChange([{ kind: 'REPLACE', occurrenceKey: o.occurrenceKey, dueOn: o.dueOn, amountMinor: x }, { kind: 'ADD', key: `split:${o.occurrenceKey}`, dueOn: o.scheduledOn, amountMinor: total - x, label: 'Second part (if agreed)', feeMinor: payoutFeeEstimateMinor(total - x) }]);
    if (g && g.days.filter((d) => d.on <= o.scheduledOn).every((d) => d.closeMinor >= f.reserveMinor)) return [keep, { code: 'SPLIT', parts: [{ dueOn: o.dueOn, amount: usd(x) }, { dueOn: o.scheduledOn, amount: usd(total - x) }] }];
  }
  return [keep];
}

/** The parts a reply states, parsed by code from its verbatim quotes (null where a quote is missing or unreadable). */
export const parseTerms = (q: TermsQuote[] | null, today: LocalDate) => (q ?? []).map((t) => ({ dueOn: t.date ? exactDate(t.date, today) : null, amount: t.amount ? (exactAmountMinor(t.amount) === null ? null : usd(exactAmountMinor(t.amount)!)) : null }));

/** AGREED only if the stated parts equal exactly one offered option. A date-only "keep Dec 3" matches KEEP. Anything else is a counter. */
export function matchOption(parsed: { dueOn: LocalDate | null; amount: { minor: number } | null }[], options: SupplierAskOption[]): 'KEEP' | 'SPLIT' | null {
  const hits = options.filter((op) => {
    if (op.code === 'KEEP' && parsed.length === 1 && parsed[0].dueOn === op.parts[0].dueOn && (parsed[0].amount === null || parsed[0].amount.minor === op.parts[0].amount.minor)) return true;
    if (parsed.length !== op.parts.length || parsed.some((p) => p.dueOn === null || p.amount === null)) return false;
    const key = (xs: { dueOn: LocalDate | null; amount: { minor: number } | null }[]) => xs.map((p) => `${p.dueOn}:${p.amount!.minor}`).sort().join();
    return key(parsed) === key(op.parts);
  });
  return hits.length === 1 ? hits[0].code : null;
}

/** REPLY_INTERPRET for a reply to a supplier ask: one SUPPLIERANSWER#, nothing else changes. */
export function recordAnswerOps(x: { tenantId: string; runId: string; askId: string; supplierId: string; messageId: string; intent: string; quote: string; termsQuotes: TermsQuote[] | null; options: SupplierAskOption[]; today: LocalDate; now: string }): Op[] {
  const pk = K.run(x.tenantId, x.runId);
  const parsed = parseTerms(x.termsQuotes, x.today);
  const matched = x.intent === 'TERMS_AGREED' ? matchOption(parsed, x.options) : null;
  const intent = (x.intent === 'TERMS_AGREED' ? (matched ? 'TERMS_AGREED' : 'TERMS_COUNTER') : ['TERMS_COUNTER', 'TERMS_DECLINED'].includes(x.intent) ? x.intent : 'OTHER') as SupplierAnswer['intent'];
  const a: SupplierAnswer = { askId: x.askId, answerId: x.messageId, supplierId: x.supplierId, messageId: x.messageId, intent, quote: x.quote, parsed, matched, state: 'OPEN', at: x.now };
  const what = intent === 'TERMS_AGREED' ? `agrees to ${matched === 'KEEP' ? 'keep the original date' : 'the split'}` : intent === 'TERMS_COUNTER' ? 'answers with different terms' : intent === 'TERMS_DECLINED' ? 'declines' : 'replied';
  return [
    { op: 'put', table: 'core', item: { pk, sk: answerSk(x.askId, x.messageId), ...a }, cond: { notExists: true } },
    auditOp({ tenantId: x.tenantId, runId: x.runId, type: 'SupplierAnswerRecorded', by: 'HEADROOM', result: `Supplier ${what} (“${x.quote}”). Nothing changes until you accept it`, refs: { askId: x.askId, mailId: x.messageId }, correlationId: `ask:${x.askId}`, now: x.now }),
  ];
}

async function load(rc: ReadCtx, askId: string, answerId: string) {
  const s = await loadPlanState(rc);
  const ans = (await rc.store.get('core', s.pk, answerSk(askId, answerId))) as AnswerItem | undefined;
  if (!ans) throw new ApiError(404, 'NOT_FOUND', 'No such answer');
  if (ans.state !== 'OPEN') throw new ApiError(409, 'VERSION_CONFLICT', `Already ${ans.state.toLowerCase()}`);
  const ask = s.actions.filter((a) => a.rootId === askId && a.kind === 'ASK_SUPPLIER').sort((a, z) => (a.revisionId < z.revisionId ? 1 : -1))[0];
  if (!ask?.subject.occurrenceKey || !ask.terms.askOptions) throw new ApiError(404, 'NOT_FOUND', 'No such ask');
  return { s, ans, ask };
}

/** The owner accepts one offered option of an answer. SPLIT → the occurrence becomes part 1, a new one-off commitment holds part 2. */
export async function acceptSupplierAnswer(rc: ReadCtx, c: CommandCtx, askId: string, body: { answerId: string; option: 'KEEP' | 'SPLIT'; obligationVersion: number; billVersion: number }): Promise<CommandResult> {
  const { s, ans, ask } = await load(rc, askId, body.answerId);
  const opt = ask.terms.askOptions!.find((o) => o.code === body.option);
  if (!opt) throw new ApiError(400, 'INVALID_INPUT', `${body.option} was not offered`);
  // S7a-IR-05: only what the supplier actually agreed to, once per ask, and only against the terms the ask was made on.
  if (ans.intent !== 'TERMS_AGREED' || ans.matched !== body.option) throw new ApiError(400, 'INVALID_INPUT', `${ask.counterparty.name} didn't agree to that option in this reply; nothing to accept`);
  if (s.answers.some((x) => x.askId === askId && x.state === 'ACCEPTED')) throw new ApiError(409, 'VERSION_CONFLICT', 'An answer to this ask was already accepted');
  const key = ask.subject.occurrenceKey!;
  const occ = s.f.r.occurrences.find((o) => o.occurrenceKey === key);
  const stored = s.f.r.stored.get(key);
  const bill = occ?.substantiatedBy ? s.f.r.bills.find((b) => b.billId === occ.substantiatedBy) : undefined;
  if (!occ || !stored || !bill) throw new ApiError(409, 'VERSION_CONFLICT', 'The payment or its bill changed; review again');
  if (stored.version !== body.obligationVersion || bill.version !== body.billVersion) throw new ApiError(409, 'VERSION_CONFLICT', 'The payment or its bill changed since you looked; review again');
  if (Number(askId.split(':').at(-1)) !== stored.termsVersion) throw new ApiError(409, 'VERSION_CONFLICT', 'The bill’s terms changed after this ask was made; it no longer applies');
  // A payment that is queued, reserved, sending, unknown or paid is never re-termed under it (S6 fences; R6).
  if (stored.payment) throw new ApiError(409, 'PAYOUT_IN_FLIGHT', `A payout for this bill is already ${stored.payment.stage.toLowerCase().replace('_', ' ')}; its terms can't change now`);
  const sum = opt.parts.reduce((t, p) => t + p.amount.minor, 0);
  if (sum !== occ.amount.minor || opt.parts.some((p) => p.dueOn < s.f.today)) throw new ApiError(409, 'SPLIT_REFUSED', 'The offered parts no longer add up to this payment or fall in the past; ask again');
  const pk = s.pk;
  const p = parseOccKey(key)!;
  const tv = stored.termsVersion + 1;
  const [first, second] = opt.parts;
  const cmt = second && { commitmentId: splitCommitmentId(key), supplierId: ask.counterparty.id, name: `${ask.counterparty.name} · second part`, reference: bill.billNumber, amount: second.amount, schedule: { kind: 'ONCE' as const, on: second.dueOn }, rail: 'PAYPAL_PAYOUT' as const, estimate: false, protected: false, provenance: 'SUPPLIER_TERMS' as const, createdOn: s.f.today, createdAt: c.now };
  const what = second ? `${dollars(first.amount.minor)} on ${first.dueOn} and ${dollars(second.amount.minor)} on ${second.dueOn}` : `${dollars(first.amount.minor)} on ${first.dueOn}`;
  return {
    status: 200, body: { askId, option: body.option, parts: opt.parts },
    ops: [
      fenceCheck(c),
      { op: 'check', table: 'core', pk, sk: bill.sk, cond: { eq: { version: bill.version } } },
      // paymentVersion moves on: an unused PAYOUT_AUTHORITY for the old terms lapses (S6 R4 termsHash), and a later payout claim on the
      // old version fails its fence.
      { op: 'update', table: 'core', pk, sk: stored.sk, set: { dueOn: first.dueOn, amount: first.amount, termsVersion: tv, nextPaymentVersion: (stored.nextPaymentVersion ?? 1) + 1 }, add: { version: 1 }, cond: { eq: { version: stored.version }, missing: ['payment'] } },
      { op: 'put', table: 'core', cond: { notExists: true }, item: { pk, sk: `TERMS#${key}#${tv}`, kind: 'CHANGED_TERMS', billId: bill.billId, occurrenceKey: key, changedFields: second ? ['dueOn', 'amount'] : ['dueOn'], before: { dueOn: occ.dueOn, amount: occ.amount }, after: { dueOn: first.dueOn, amount: first.amount }, termsHash: `answer:${ans.answerId}:${body.option}`, by: c.ownerEmail, source: ans.answerId, at: c.now } },
      ...(cmt ? [
        { op: 'put', table: 'core', item: { pk, sk: `CMT#${cmt.commitmentId}`, ...cmt }, cond: { notExists: true } } as Op,
        { op: 'put', table: 'core', item: { pk, sk: oblSk(cmt.commitmentId, 0), occurrenceKey: occKey(cmt.commitmentId, 0), commitmentId: cmt.commitmentId, n: 0, scheduledOn: second.dueOn, dueOn: second.dueOn, amount: second.amount, state: 'SCHEDULED', termsVersion: 1, termsHash: `answer:${ans.answerId}:SPLIT`, substantiatedBy: bill.billId, version: 1 }, cond: { notExists: true } } as Op,
      ] : []),
      { op: 'update', table: 'core', pk, sk: ans.sk, set: { state: 'ACCEPTED' }, cond: { eq: { state: 'OPEN' } } },
      basisBumpOp(pk),
      auditOp({ tenantId: c.tenantId, runId: c.run.runId, type: 'SupplierAnswerAccepted', by: 'OWNER', allowedBy: c.ownerEmail, result: `You accepted ${ask.counterparty.name}’s answer (“${ans.quote}”): ${what}. Paying still needs your payout authority`, refs: { askId, answerId: ans.answerId, occurrenceKey: key }, correlationId: c.correlationId, now: c.now }),
    ],
  };
}

export async function declineSupplierAnswer(rc: ReadCtx, c: CommandCtx, askId: string, body: { answerId: string }): Promise<CommandResult> {
  const { s, ans, ask } = await load(rc, askId, body.answerId);
  return {
    status: 200, body: { askId, state: 'DECLINED' },
    ops: [fenceCheck(c), { op: 'update', table: 'core', pk: s.pk, sk: ans.sk, set: { state: 'DECLINED' }, cond: { eq: { state: 'OPEN' } } },
      auditOp({ tenantId: c.tenantId, runId: c.run.runId, type: 'SupplierAnswerDeclined', by: 'OWNER', allowedBy: c.ownerEmail, result: `You declined ${ask.counterparty.name}’s answer; the bill’s accepted terms stay as they are`, refs: { askId, answerId: ans.answerId }, correlationId: c.correlationId, now: c.now })],
  };
}
