// Plan builds (S04 T2/T3 as revised by §6.17 R1/R8). `requestBuild` is idempotent per basis hash; the PLAN_BUILD job writes real
// check progress to BUILD#, asks the RecoveryPlanner and MessageDrafter (or uses Headroom's templates), and publishes one DRAFT
// revision under the lease, the build generation and the PLAN basis stamp it read. A moved stamp ends the build STALE.
import { assertTransition, PlanAction, type PlanRevision } from '@headroom/contracts';
import { K } from '../../adapters/store/keys.ts';
import { TxCancelled, type Op } from '../../adapters/store/port.ts';
import { ApiError } from '../../api-error.ts';
import { SimulatedCrash, type Deps } from '../../deps.ts';
import { backoff, finishOp, leaseCheck, newJob, putJobOp, type Lease } from '../../jobs/lease.ts';
import type { ReadCtx } from '../../read/models.ts';
import { auditOp } from '../audit/audit.ts';
import { connectionFor, getRun } from '../identity-run/run.ts';
import { fenceCheck, type CommandCtx, type CommandResult } from '../receivables/commands.ts';
import { addMs, MIN } from '../time.ts';
import { generateCandidates, type Candidate } from './candidates.ts';
import { editAction, recheckOffers, type EditChanges } from './edit.ts';
import { DEFAULT_WHY, drafterGate, helpsBeforeShortfall, messageFor, plannerGate, renderWhy, SUMMARY_TEXT, WHY_FOR } from './gates.ts';
import { askRole } from './model.ts';
import { actionFrom, basisHashOf, loadPlanState, otherConcessionsMinor, planInputs, type ActItem, type BuildItem, type PlanState } from './state.ts';

export const buildIdOf = (basisHash: string) => `build-${basisHash.slice(0, 16)}`;
export const buildJobId = (basisHash: string, gen: number) => `plan#${basisHash.slice(0, 24)}#${gen}`;
const genOfJob = (jobId: string) => Number(jobId.split('#').at(-1));
export const CHECKS = [
  { key: 'breach', label: 'Reading the shortfall' },
  { key: 'evidence', label: 'Gathering invoices, history and your delegation' },
  { key: 'candidates', label: 'Working out what could help' },
  { key: 'planner', label: 'Choosing and explaining' },
  { key: 'drafts', label: 'Drafting the messages (not sent)' },
] as const;

/** The precondition every plan command shares: a forecast with an opening and a breach. */
export function requireBreach(s: PlanState): string {
  if (!s.f.opening) throw new ApiError(409, 'CASH_IMPACT_UNKNOWN', `Cash impact unknown: ${s.f.noOpeningReason}`);
  const h = basisHashOf(s);
  if (!h) throw new ApiError(409, 'NOTHING_TO_PLAN', 'No plan needed · Forecast above reserve under stated assumptions');
  return h;
}

export async function requestBuild(rc: ReadCtx, c: CommandCtx, body: { retry?: { buildId: string; generation: number } }, by: 'OWNER' | 'HEADROOM' = 'OWNER'): Promise<CommandResult> {
  const s = await loadPlanState(rc);
  const hash = requireBreach(s);
  const pk = s.pk;
  const b = s.builds.find((x) => x.basisHash === hash);
  const rev = b?.revisionId ? s.revisions.find((r) => r.revisionId === b.revisionId) : undefined;
  const answer = (status: 'STARTED' | 'IN_PROGRESS' | 'DONE' | 'FAILED', jobId: string | null = null) => ({ status, buildId: b?.buildId ?? buildIdOf(hash), generation: b?.generation ?? 1, jobId, revisionId: b?.revisionId ?? null });
  const audit = (result: string) => auditOp({ tenantId: c.tenantId, runId: c.run.runId, type: 'PlanBuildRequested', by, allowedBy: by === 'OWNER' ? c.ownerEmail : null, result: by === 'HEADROOM' ? `${result} (started by itself: an accepted bill changed your cash picture)` : result, refs: { buildId: buildIdOf(hash) }, correlationId: c.correlationId, now: c.now });
  if (!b) {
    const jobId = buildJobId(hash, 1);
    const item: BuildItem = {
      pk, sk: `BUILD#${hash}`, buildId: buildIdOf(hash), basisHash: hash, state: 'BUILDING', generation: 1, basisStamp: s.plan.basisStamp,
      checks: CHECKS.map((x) => ({ ...x, result: 'PENDING', detail: null })), revisionId: null, failure: null, attempts: [], requestedAt: c.now,
    };
    return { status: 202, body: { ...answer('STARTED', jobId), buildId: item.buildId }, ops: [fenceCheck(c), { op: 'put', table: 'core', item, cond: { notExists: true } }, putJobOp(newJob(jobId, 'PLAN_BUILD', hash, c.now, c.tenantId, c.run.runId)), audit('Headroom is building a plan for the shortfall')], rerunOnConflict: true };
  }
  const retryable = b.state === 'FAILED' || (b.state === 'DONE' && rev?.state === 'REJECTED');
  if (!retryable || !body.retry) return { status: 200, body: answer(b.state === 'BUILDING' ? 'IN_PROGRESS' : b.state), ops: [fenceCheck(c)] };
  if (body.retry.buildId !== b.buildId || body.retry.generation !== b.generation) return { status: 200, body: answer(b.state === 'BUILDING' ? 'IN_PROGRESS' : b.state), ops: [fenceCheck(c)] };
  assertTransition('PlanBuild', b.state, 'BUILDING');
  const gen = b.generation + 1;
  const jobId = buildJobId(hash, gen);
  return {
    status: 202, body: { ...answer('STARTED', jobId), generation: gen, revisionId: null }, rerunOnConflict: true,
    ops: [
      fenceCheck(c),
      { op: 'update', table: 'core', pk, sk: b.sk, cond: { eq: { state: b.state, generation: b.generation } }, set: {
        state: 'BUILDING', generation: gen, basisStamp: s.plan.basisStamp, revisionId: null, failure: null, checks: CHECKS.map((x) => ({ ...x, result: 'PENDING', detail: null })),
        attempts: [...b.attempts, { generation: b.generation, kind: b.state === 'FAILED' ? b.failure?.kind ?? 'DATA' : 'REJECTED', reason: b.failure?.reason ?? 'Revision rejected; built again', at: c.now }],
      } },
      putJobOp(newJob(jobId, 'PLAN_BUILD', hash, c.now, c.tenantId, c.run.runId)),
      audit(b.state === 'FAILED' ? 'Trying the plan build again' : 'Building again after you rejected the revision'),
    ],
  };
}

/**
 * O6 (S7): when accepting a bill's terms leaves a shortfall, the plan builds by itself, so the draft is waiting on the Plan page.
 * One build per basis hash (requestBuild is idempotent); no shortfall → nothing. Model spend is metered as for any build.
 */
export async function autoBuild(rc: ReadCtx, c: CommandCtx, queue: { send(id: string): Promise<unknown> }): Promise<void> {
  let r: CommandResult;
  try { r = await requestBuild(rc, c, {}, 'HEADROOM'); }
  catch (e) { if (e instanceof ApiError && (e.code === 'NOTHING_TO_PLAN' || e.code === 'CASH_IMPACT_UNKNOWN')) return; throw e; }
  if (r.status !== 202) return;
  await rc.store.transact(r.ops).catch(ignoreCancel);
  const jobId = (r.body as { jobId?: string | null }).jobId;
  if (jobId) await queue.send(jobId).catch(() => {});
}

export const PLAN_ADMISSION_MS = 20_000;
export const MAX_BUILD_ATTEMPTS = 4;
type Budget = { deadline: number; elapsed: () => number };
const ignoreCancel = (e: unknown) => { if (!(e instanceof TxCancelled)) throw e; };

/** Worker: PLAN_BUILD. */
export async function planBuild(d: Deps, l: Lease, budget: Budget): Promise<void> {
  const left = () => budget.deadline - budget.elapsed();
  const [tenantId, runId, hash, gen] = [l.job.tenantId!, l.job.runId!, l.job.ref, genOfJob(l.jobId)];
  if (left() < PLAN_ADMISSION_MS) { await d.store.transact([finishOp(l, { kind: 'requeue', at: addMs(d.now(), MIN), set: { attempts: l.job.attempts - 1 } })]).catch(ignoreCancel); return; }
  const pk = K.run(tenantId, runId);
  const b = (await d.store.get('core', pk, `BUILD#${hash}`)) as BuildItem | undefined;
  if (!b || b.generation !== gen || b.state !== 'BUILDING') { await d.store.transact([finishOp(l, { kind: 'done' })]).catch(ignoreCancel); return; }
  const corr = `plan:${b.buildId}:${gen}`;
  const audit = (type: Parameters<typeof auditOp>[0]['type'], result: string, refs: Record<string, string> = {}) => auditOp({ tenantId, runId, type, by: 'HEADROOM', result, refs: { buildId: b.buildId, ...refs }, correlationId: corr, now: d.now() });
  const checks = b.checks.map((x) => ({ ...x }));
  const progress = async (key: string, result: 'OK' | 'NOTE', detail: string) => {
    Object.assign(checks.find((x) => x.key === key)!, { result, detail });
    await d.store.transact([leaseCheck(l), { op: 'update', table: 'core', pk, sk: b.sk, set: { checks }, cond: { eq: { generation: gen, state: 'BUILDING' } } }]).catch(ignoreCancel);
  };
  const fail = async (kind: 'DATA' | 'STALE', reason: string) => {
    assertTransition('PlanBuild', 'BUILDING', 'FAILED');
    await d.store.transact([finishOp(l, { kind: 'done' }), { op: 'update', table: 'core', pk, sk: b.sk, set: { state: 'FAILED', failure: { kind, reason }, checks }, cond: { eq: { generation: gen, state: 'BUILDING' } } }, audit('PlanBuildFailed', `Couldn't build a plan: ${reason}`)]).catch(ignoreCancel);
  };
  if (l.job.attempts > MAX_BUILD_ATTEMPTS) return fail('DATA', `Stopped after ${MAX_BUILD_ATTEMPTS} attempts`);
  try { await attempt(b); }
  catch (e) {
    if (e instanceof SimulatedCrash) throw e;
    if (l.job.attempts >= MAX_BUILD_ATTEMPTS) return fail('DATA', (e as Error).message);
    await d.store.transact([finishOp(l, { kind: 'requeue', at: backoff(d.now(), l.job.attempts), error: (e as Error).message })]).catch(ignoreCancel);
  }

  async function attempt(b: BuildItem) {
    const run = (await getRun(d.store, tenantId, runId))!;
    const rc: ReadCtx = { store: d.store, config: d.config, tenantId, run, connectionId: await connectionFor(d.store, tenantId), email: 'headroom', now: d.now(), evidence: d.evidence };
    const s = await loadPlanState(rc);
    const stamp = s.plan.basisStamp;
    const fault = d.hooks?.planBuildFault?.();
    if (fault) return fail('DATA', fault);
    if (basisHashOf(s) !== hash) return fail('STALE', 'Your cash picture changed while Headroom was building');
    const x = planInputs(s)!;
    await progress('breach', 'OK', `First below your reserve on ${new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(`${x.needBy}T00:00:00Z`))}`);
    await progress('evidence', 'OK', `${x.invoices.length} open invoices, ${x.claims.length} acknowledged dispute, Delegation v${s.policy.version}`);
    const { candidates, considered } = generateCandidates(x);
    if (!candidates.length) return fail('DATA', 'Nothing Headroom is allowed to do would help; see what was considered');
    await progress('candidates', 'OK', `${candidates.length} possible actions, ${considered.length} considered and not possible`);

    // RecoveryPlanner: choose and explain, or the template (select every candidate in order). Supplier asks are not its choice (S7 R6).
    const choosable = candidates.filter((c) => c.kind !== 'ASK_SUPPLIER');
    // The model is told the rule its gate enforces: anything that can land before the shortfall is marked mustInclude (4 Nov 2026).
    const plannerInput = JSON.stringify({
      shortfall: { firstBelowReserve: x.needBy, closeThatDay: x.needByClose, gapAtLow: x.gapMinor, currency: 'USD minor units' },
      candidates: choosable.map((c) => ({ id: c.rootId, kind: c.kind, title: c.title, counterparty: c.counterparty.name, relationship: x.tiers.get(c.counterparty.id)?.label ?? null, authority: { decision: c.authority.decision, reasons: c.authority.reasons }, condition: c.condition?.text ?? null, mustInclude: c.mustInclude || helpsBeforeShortfall(c), allowedReasons: WHY_FOR[c.kind].filter((r) => (r !== 'NEEDS_YOUR_APPROVAL' || c.authority.decision !== 'ALLOW') && (r !== 'FALLBACK_ONLY_IF_SHORT' || c.condition)), sources: c.sources.map((s2) => ({ n: s2.n, label: s2.label, detail: s2.detail })) })),
    });
    const planned = await askRole(d, l, left, { role: d.planner, task: 'RecoveryPlanner', pk, buildId: b.buildId, gen, input: plannerInput, gate: (raw) => plannerGate(raw, choosable) });
    const order = new Map<string, number>(planned.ok ? planned.value.selected.map((x2) => [x2.candidateId, x2.order]) : candidates.map((c, i) => [c.rootId, i + 1]));
    // S7 R6 / O1 (S7a-IR-06): the planner is never given a supplier ask to choose. Under `ap.askSuppliers = WITHOUT_REVIEW` it is in
    // the plan and runs under your rule; under the default (you approve each ask) it is an option you add with one click. Either way the
    // supplier's answer changes nothing until you accept it.
    const consideredBy = new Map<string, string>([...(planned.ok ? planned.value.considered.map((x2) => [x2.candidateId, x2.reasonCode] as [string, string]) : []), ...candidates.filter((c) => c.kind === 'ASK_SUPPLIER' && c.authority.decision !== 'ALLOW').map((c) => [c.rootId, 'ASK_OPTIONAL'] as [string, string])]);
    const whyBy = new Map(planned.ok ? planned.value.why.map((w) => [w.candidateId, w]) : []);
    const hasFallback = candidates.some((c) => c.kind === 'DISCOUNT_FALLBACK' && (!planned.ok || planned.value.selected.some((x2) => x2.candidateId === c.rootId)));
    const summary = SUMMARY_TEXT[planned.ok ? planned.value.summary : hasFallback ? 'COLLECT_WITH_FALLBACK' : candidates.some((c) => c.kind !== 'PAYOUT') ? 'COLLECT_FIRST' : 'HOLD_PAYOUT_ONLY'];
    await progress('planner', planned.ok ? 'OK' : 'NOTE', planned.ok ? `Chosen and explained by Nova (${planned.modelId})` : `Written by Headroom's template: ${planned.reason}`);

    // MessageDrafter: openings and closings only; every factual clause is Headroom's.
    const outreach = candidates.filter((c) => c.kind !== 'PAYOUT');
    const drafted = await askRole(d, l, left, {
      role: d.drafter, task: 'MessageDrafter', pk, buildId: b.buildId, gen,
      input: JSON.stringify({ drafts: outreach.map((c) => ({ candidateId: c.rootId, customer: c.counterparty.name, relationship: x.tiers.get(c.counterparty.id)?.label ?? null, purpose: c.kind === 'DISCOUNT_FALLBACK' ? 'early-payment offer' : c.kind === 'COLLECT_UNDISPUTED_SLICE' ? 'request for the acknowledged part of a disputed invoice' : c.kind === 'COLLECT_DISPUTED' ? 'careful request about an amount the customer disputes' : c.kind === 'ASK_SUPPLIER' ? 'polite request to a supplier about a payment date' : 'reminder about an overdue invoice' })) }),
      gate: (raw) => drafterGate(raw, outreach),
    });
    await progress('drafts', drafted.ok ? 'OK' : 'NOTE', drafted.ok ? 'Greetings and closings by Nova; every figure and date by Headroom · not sent' : `Headroom's template: ${drafted.reason} · not sent`);

    const n = s.plan.nextN;
    const revisionId = `rev${n}-${hash.slice(0, 8)}`;
    const prev = [s.plan.draft, s.plan.running].map((id) => s.revisions.find((r) => r.revisionId === id)).find(Boolean);
    const prevActs = prev ? s.actions.filter((a) => a.revisionId === prev.revisionId) : [];
    const sorted = [...candidates].sort((a, z) => (order.get(a.rootId) ?? 99) - (order.get(z.rootId) ?? 99));
    const actions: PlanAction[] = sorted.map((c, i) => {
      const w = whyBy.get(c.rootId);
      const words = drafted.ok ? drafted.value.drafts.find((x2) => x2.candidateId === c.rootId) : undefined;
      const msg = c.kind === 'PAYOUT' ? null : { ...messageFor(c, factsFor(s, c), run.settings.businessName, words && { opening: words.opening, closing: words.closing }), writtenBy: words ? 'MODEL' as const : 'TEMPLATE' as const };
      const reason = consideredBy.get(c.rootId);
      const codes = w?.reasons ?? DEFAULT_WHY[c.kind];
      const base = actionFrom(c, revisionId, i, {
        why: { text: renderWhy(c, codes, x.tz), codes, citations: w?.citations ?? c.sources.map((x2) => x2.n), writtenBy: w ? 'MODEL' : 'TEMPLATE' },
        message: msg, decision: reason ? 'OUT' : 'IN', consideredReason: reason ? CONSIDERED_TEXT[reason] : null,
      });
      return carryEdits(base, prevActs.find((p) => p.rootId === c.rootId), s, x.needBy);
    });
    // S4-IM-02: the cumulative concession limit is decided on the final included set (the planner may have left offers out).
    for (const a of recheckOffers(actions, s)) Object.assign(actions.find((x2) => x2.actionId === a.actionId)!, a);
    // S4-IM-07: never persist an action the shared contract would refuse to read back.
    for (const a of actions) PlanAction.parse(a);
    const diff = prev?.state === 'RUNNING' ? diffOf(prevActs, actions) : null;
    const rev: PlanRevision = {
      revisionId, n, state: 'DRAFT', version: 1, buildId: b.buildId, basisHash: hash, basisStamp: stamp,
      basisSnapshot: { needBy: x.needBy, gapMinor: x.gapMinor, lowMinor: s.f.summary!.lowMinor, lowOn: s.f.summary!.lowOn, openingMinor: s.f.opening!.amountMinor, policyVersion: s.policy.version },
      trigger: prev ? 'Your cash picture changed since the last revision' : 'Cash falls below your reserve', planner: { mode: planned.ok ? 'MODEL' : 'TEMPLATE', reason: planned.ok ? null : planned.reason, summary },
      considered, diff, approvals: 0, createdAt: d.now(), approvedAt: null, approvedBy: null, rejectedAt: null, rejectedReason: null,
    };
    await d.hooks?.beforePlanPublish?.(b.buildId);
    const oldDraft = s.plan.draft ? s.revisions.find((r) => r.revisionId === s.plan.draft && r.state === 'DRAFT') : undefined;
    try {
      await d.store.transact([
        finishOp(l, { kind: 'done' }),
        { op: 'update', table: 'core', pk, sk: b.sk, set: { state: 'DONE', revisionId, checks }, cond: { eq: { generation: gen, state: 'BUILDING' } } },
        { op: 'update', table: 'core', pk, sk: 'PLAN', set: { draft: revisionId, nextN: n + 1, version: s.plan.version + 1 }, cond: { eq: { version: s.plan.version, basisStamp: stamp } } },
        ...(oldDraft ? [{ op: 'update' as const, table: 'core' as const, pk, sk: oldDraft.sk, set: { state: 'SUPERSEDED', version: oldDraft.version + 1 }, cond: { eq: { version: oldDraft.version, state: 'DRAFT' } } }, audit('PlanRevisionSuperseded', `Revision ${oldDraft.n} (draft) replaced by revision ${n}`, { revisionId: oldDraft.revisionId })] : []),
        { op: 'put', table: 'core', item: { pk, sk: `REV#${revisionId}`, ...rev }, cond: { notExists: true } },
        ...actions.map((a): Op => ({ op: 'put', table: 'core', item: { pk, sk: `ACT#${a.actionId}`, ...a }, cond: { notExists: true } })),
        audit('PlanRevisionDrafted', `Revision ${n} drafted: ${actions.filter((a) => a.decision === 'IN').length} actions, ${planned.ok ? 'chosen by Nova' : "Headroom's template"}; nothing is sent or paid until you approve`, { revisionId }),
      ]);
    } catch (e) {
      ignoreCancel(e);
      const [j, p] = await Promise.all([d.store.get('work', K.job(l.jobId), 'JOB'), d.store.get('core', pk, 'PLAN')]);
      if (j?.state !== 'LEASED' || j.leaseToken !== l.token) return; // not ours any more
      if (p?.basisStamp !== stamp) return fail('STALE', 'Your cash picture changed while Headroom was building');
      throw new Error('The plan changed while building; trying again');
    }
  }
}

const CONSIDERED_TEXT: Record<string, string> = { ASK_OPTIONAL: 'An option: add it to ask the supplier to keep the date or split it', NOT_NEEDED: 'Not needed to close the gap', FEWER_ACTIONS: 'Fewer actions do the job', HIGHER_COST: 'Costs more than the alternatives', LESS_CERTAIN: 'Less certain than the alternatives' };

export function factsFor(s: PlanState, c: Pick<Candidate, 'subject'>) {
  if (c.subject.occurrenceKey && !c.subject.invoiceId) {
    const o = s.f.r.occurrences.find((x) => x.occurrenceKey === c.subject.occurrenceKey);
    const bill = o?.substantiatedBy ? s.f.r.bills.find((b) => b.billId === o.substantiatedBy) : undefined;
    return { invoiceNumber: bill?.billNumber ?? 'bill', dueOn: o?.dueOn ?? '', openMinor: o?.amount.minor ?? 0, supplierPlannedOn: o?.scheduledOn };
  }
  const inv = s.invoices.find((i) => i.invoiceId === c.subject.invoiceId);
  const claim = s.claims.find((x) => x.invoiceId === c.subject.invoiceId);
  return { invoiceNumber: inv?.invoiceNumber ?? 'invoice', dueOn: inv?.dueOn ?? '', openMinor: inv?.openGross.minor ?? 0, disputedMinor: claim?.disputed.minor, ackOn: claim?.acknowledgement.on };
}

/** S4-D20: owner edits carry into the next revision; an edit that no longer fits is flagged on the card, not overwritten. */
function carryEdits(a: PlanAction, prev: ActItem | undefined, s: PlanState, needBy: string): PlanAction {
  if (!prev?.ownerEdited.length) return a;
  const ch: EditChanges = {};
  for (const k of prev.ownerEdited) {
    if (k === 'contactOn' || k === 'targetOn') ch[k] = prev.terms[k]!;
    if (k === 'amountMinor') ch.amountMinor = prev.terms.amount.minor;
    if (k === 'discountBp') ch.discountBp = prev.terms.discountBp!;
    if (k === 'message' && prev.message) ch.message = { subject: prev.message.subject, body: prev.message.body };
  }
  try {
    const r = editAction(a, ch, editCtx(s, a, needBy));
    return { ...r.action, version: 1, staleEdits: r.stale };
  } catch (e) {
    return { ...a, staleEdits: [`Your edit to ${prev.ownerEdited.join(', ')} no longer fits: ${(e as Error).message}`] };
  }
}

/** What an edit is checked against. `acts`: the revision's actions as they will be (other offers' concessions, S4-IM-02). */
export function editCtx(s: PlanState, a: Pick<PlanAction, 'counterparty' | 'subject' | 'rootId'>, needBy: string, acts: PlanAction[] = []) {
  const inv = s.invoices.find((i) => i.invoiceId === a.subject.invoiceId);
  const claim = s.claims.find((x) => x.invoiceId === a.subject.invoiceId);
  // S4-IM-06: after any receipt on a disputed invoice, nothing is undisputed-collectible until attribution is proven.
  const received = inv ? inv.amount.minor - inv.openGross.minor : 0;
  const bk = (s.customers.find((x) => x.customerId === a.counterparty.id) as { businessKey?: string } | undefined)?.businessKey ?? a.counterparty.id;
  return {
    lastContactAt: (s.contacts.find((x) => x.sk === `CONTACT#${bk}`)?.lastSentAt as string | null | undefined) ?? null,
    now: s.ctx.now, tz: s.ctx.run.settings.timeZone, needBy, policy: s.policy, tier: s.assessments.get(a.counterparty.id)?.tier ?? 'NOT_ENOUGH_HISTORY',
    undisputedMinor: claim ? (received > 0 ? 0 : Math.min(claim.undisputed.minor, inv?.openGross.minor ?? 0)) : null, openMinor: inv?.openGross.minor ?? null,
    otherConcessionsMinor: otherConcessionsMinor(acts, a.rootId), facts: factsFor(s, a), businessName: s.ctx.run.settings.businessName,
  };
}

function diffOf(prev: ActItem[], next: PlanAction[]): NonNullable<PlanRevision['diff']> {
  const out: NonNullable<PlanRevision['diff']> = next.map((a) => {
    const p = prev.find((x) => x.rootId === a.rootId && x.state !== 'REMOVED');
    return { rootId: a.rootId, change: !p ? 'ADDED' : p.termsHash === a.termsHash ? 'UNCHANGED' : 'CHANGED', detail: !p ? 'New in this revision' : p.termsHash === a.termsHash ? 'Same terms as the running revision' : 'Terms differ from the running revision' };
  });
  for (const p of prev) if (p.state !== 'REMOVED' && !next.some((a) => a.rootId === p.rootId)) out.push({ rootId: p.rootId, change: 'DROPPED', detail: 'Not in this revision' });
  return out;
}
