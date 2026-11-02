// S5 read models (S05 §6.7): Inbox threads and the mail channel status, the invoice's claim projection, the work grid and
// Reconciliation. Computed on read from stored records; the UI renders them as given.
import type { ResponseOf } from '@headroom/contracts';
import { resolve, ruleOf, ruleText } from '../domain/delegation/policy.ts';
import { gmailPk, TESTING_DAYS } from '../adapters/mail/gmail.ts';
import { addMs, DAY } from '../domain/time.ts';
import { loadPlanState } from '../domain/plan/state.ts';
import type { ReadCtx } from './models.ts';

type Inbox = ResponseOf<'getInbox'>;
type Entry = Inbox['threads'][number]['entries'][number];

export async function mailStatus(c: ReadCtx): Promise<Inbox['channel']> {
  const m = c.config.mail ?? { kind: 'NONE' as const, sender: null, inbox: null };
  if (m.kind === 'SIMULATED') return { kind: 'SIMULATED', state: 'SIMULATED', text: 'Simulated mailbox for testing · no real email is sent or received', expiresAbout: null };
  if (m.kind === 'NONE') return { kind: 'NONE', state: 'NONE', text: 'Email is not set up here · messages wait as drafts; nothing is sent', expiresAbout: null };
  const conn = await c.store.get('provider', gmailPk(m.sender!), 'CONN');
  if (!conn) return { kind: 'GMAIL', state: 'NOT_CONNECTED', text: 'Gmail not connected · messages wait until the operator reconnects it', expiresAbout: null };
  const exp = addMs(conn.connectedAt, TESTING_DAYS * DAY);
  if (conn.state === 'EXPIRED') return { kind: 'GMAIL', state: 'EXPIRED', text: 'Gmail needs reconnecting (test sign-ins last 7 days) · messages wait and send once reconnected', expiresAbout: exp };
  return { kind: 'GMAIL', state: 'CONNECTED', text: `Gmail · ${conn.email} · every message goes to your private test inbox; customers are not contacted`, expiresAbout: exp };
}

const outLabel = (o: Record<string, any>) => {
  const via = o.channel === 'GMAIL' ? `Gmail${o.preparedFor ? ' · to your test inbox' : ''}` : 'simulated mailbox';
  if (o.held) return 'DRAFT · HELD';
  return ({ DRAFT: 'DRAFT', QUEUED: `QUEUED · ${via}`, SENDING: `SENDING · ${via}`, SENT: `SENT · ${via}`, SEND_UNKNOWN: 'DELIVERY UNKNOWN', FAILED: 'NOT SENT', NOT_SENT: 'NOT SENT' } as Record<string, string>)[o.state] ?? o.state;
};

export async function inboxThreads(c: ReadCtx): Promise<Pick<Inbox, 'threads' | 'unfiled'>> {
  const s = await loadPlanState(c);
  const mails = await c.store.query('core', s.pk, { skPrefix: 'MAIL#' });
  const promises = new Map((await c.store.query('core', s.pk, { skPrefix: 'PROMISE#' })).map((p) => [p.sourceMessageId as string, p]));
  const inEntry = (m: Record<string, any>) => inEntryOf(m, promises.get(m.messageId));
  const running = s.actions.filter((a) => a.message && a.decision === 'IN' && (a.revisionId === s.plan.running || s.outs.some((o) => o.actionId === a.actionId)) && !['REMOVED', 'SUPERSEDED', 'PROPOSED'].includes(a.state));
  const customers = new Set([...running.map((a) => a.counterparty.id), ...mails.map((m) => m.binding?.customerId).filter(Boolean)]);
  const threads = [...customers].map((cid) => {
    const sup = s.f.r.suppliers.find((x) => x.supplierId === cid);
    const cust = s.customers.find((x) => x.customerId === cid) ?? (sup && { displayName: sup.displayName, billingEmail: sup.contactEmail ?? '' });
    const t = s.threads.find((x) => x.customerId === cid);
    const entries: Entry[] = [];
    for (const a of running.filter((x) => x.counterparty.id === cid)) {
      const o = s.outs.find((x) => x.rootId === a.rootId && x.intentVersion === a.intentVersion);
      const draft = !o || o.state === 'DRAFT';
      entries.push({
        key: `out:${a.actionId}`, kind: draft ? 'DRAFT' : 'OUT', at: o?.updatedAt ?? null, subject: a.message!.subject, actionId: a.actionId, held: !!o?.held,
        label: o ? outLabel(o) : 'DRAFT', detail: o?.reason ?? (o?.preparedFor ? `Prepared for ${o.preparedFor}; not contacted` : null),
        canSendNow: draft && !o?.held && (a.state === 'SCHEDULED' || (a.state === 'APPLIED' && a.kind !== 'COLLECT_OVERDUE')), canHold: draft || o?.state === 'QUEUED',
        needsYou: o?.state === 'SEND_UNKNOWN' && /Needs you/.test(o.reason ?? ''), promise: null,
      });
    }
    for (const m of mails.filter((x) => x.binding?.customerId === cid)) entries.push(inEntry(m));
    entries.sort((a, z) => (z.at ?? '').localeCompare(a.at ?? ''));
    const owner = (t?.owner ?? 'HEADROOM') as 'HEADROOM' | 'YOU';
    const pill = owner === 'YOU' ? 'YOU OWN THIS' : entries.some((e) => e.needsYou) ? 'NEEDS YOU' : entries.find((e) => e.kind !== 'IN')?.label ?? 'DRAFT';
    return { customerId: cid, name: cust?.displayName ?? cid, contact: cust?.billingEmail ?? '', owner, ownerVersion: t?.version ?? 0, pill, unread: entries.filter((e) => e.kind === 'IN' && e.needsYou).length + entries.filter((e) => e.kind === 'DRAFT').length, entries };
  });
  const unfiled = mails.filter((m) => !m.binding?.customerId && (m.processing === 'UNFILED')).map(inEntry);
  return { threads, unfiled };
}

function inEntryOf(m: Record<string, any>, p: Record<string, any> | undefined): Entry {
  const i = m.interpretation;
  const beyond = !!p?.beyondLimitDays && !p.acceptedBy;
  const label = m.processing === 'HELD' ? `HELD · ${String(m.heldCode).replace('HOLD_', '').toLowerCase().replace(/_/g, ' ')} sender · not read`
    : m.processing === 'UNFILED' ? 'UNFILED · no effect'
    : !i ? 'RECEIVED · reading' : i.refused ? `NEEDS YOU · read it (${i.refused})` : i.intent === 'PROMISE' ? (beyond ? `NEEDS YOU · promised ${i.on}, beyond your ${p!.beyondLimitDays}-day limit · not counted` : `PROMISED ${i.on} · Expected only${p?.acceptedBy ? ' · counted by you' : ''}`) : `${String(i.intent).replace(/_/g, ' ')} · for you`;
  return { key: `in:${m.messageId}`, kind: 'IN', at: m.receivedAt, subject: m.subject, label, actionId: null, canSendNow: false, canHold: false, held: false,
    needsYou: m.processing === 'HELD' || !!i?.refused || (!!i && i.intent !== 'PROMISE') || beyond, detail: i?.quote ? `“${i.quote}”` : `From ${m.from}`,
    promise: p ? { promiseId: p.promiseId, on: p.on, beyondLimitDays: p.beyondLimitDays ?? null, accepted: !!p.acceptedBy } : null };
}

/** UI-AR-18 Reconciliation, from the same read models as Cash and Receivables (never re-derived). */
export async function getReconciliation(c: ReadCtx): Promise<ResponseOf<'getReconciliation'>> {
  const { getCashPosition, listReceivables } = await import('./models.ts');
  const [cash, recv] = await Promise.all([getCashPosition(c), listReceivables(c)]);
  const pk = `T#${c.tenantId}#R#${c.run.runId}`;
  const [answers, allocs, invs] = await Promise.all([c.store.query('core', pk, { skPrefix: 'MATCH#' }), c.store.query('core', pk, { skPrefix: 'ALLOC#' }), c.store.query('core', pk, { skPrefix: 'INV#' })]);
  const bank = cash.sources.find((x) => 'activity' in x) as unknown as { activity?: { rows: { transactionId: string; date: string; description: string; amount: { currency: 'USD'; minor: number } | null; paypalCandidate: boolean }[] } } | undefined;
  return {
    transfers: (bank?.activity?.rows ?? []).filter((r) => r.paypalCandidate).map((r) => {
      const a = answers.find((x) => x.bankTxId === r.transactionId);
      return { bankTxId: r.transactionId, date: r.date, description: r.description, amount: r.amount, answer: a?.answer ?? null, version: a?.version ?? 0, by: a?.by ?? null };
    }),
    awaitingReport: recv.incoming.filter((x) => x.inReportedBalance === 'NOT_YET').map((x) => ({ captureId: x.captureId, invoiceNumber: x.invoiceNumber, net: x.net, capturedAt: x.capturedAt })),
    unallocated: allocs.filter((a) => a.claim === 'UNALLOCATED' && !a.reversalOf && !allocs.some((r) => r.reversalOf && r.captureId === a.captureId && r.claim === 'UNALLOCATED')).map((a) => ({ invoiceId: a.invoiceId, invoiceNumber: invs.find((i) => i.invoiceId === a.invoiceId)?.invoiceNumber ?? null, captureId: a.captureId, amount: a.amount })),
    holds: invs.filter((i) => i.hold || i.conservation === 'HOLD').map((i) => ({ invoiceId: i.invoiceId, invoiceNumber: i.invoiceNumber, text: i.hold?.reason ?? `PayPal shows ${((i.providerDueMinor ?? 0) / 100).toFixed(2)} due; Headroom expects otherwise` })),
    note: 'Answers are labels: a PayPal transfer between your own accounts is already counted on both sides, so "Yes" creates no receipt and moves no cash.',
  };
}

/** S5-D17 collection work: open invoices with an action in the running plan, or overdue. Ranked by need-by, then gap contribution. */
export async function workRows(c: ReadCtx): Promise<Pick<ResponseOf<'listReceivables'>, 'work' | 'workPopulation'>> {
  const s = await loadPlanState(c);
  const run = s.revisions.find((r) => r.revisionId === s.plan.running);
  const today = s.f.today;
  const money = (m: number) => `$${(m / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const days = (a: string, b: string) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);
  // S7 (bug fix): the resolved Getting-paid value, rendered by its spec (was the raw everywhere value).
  const newDateLimit = ruleText(ruleOf(s.policy, 'ar.newDateDays'), resolve(s.policy, 'ar.newDateDays', 'RECEIVABLES').value);
  const rows = s.invoices.filter((i) => i.state === 'ISSUED' || i.state === 'PARTIALLY_PAID').map((inv) => {
    const a = s.actions.find((x) => x.subject.invoiceId === inv.invoiceId && x.kind !== 'PAYOUT' && x.decision === 'IN' && (x.revisionId === s.plan.running || ['QUEUED', 'APPLIED', 'UNCERTAIN'].includes(x.state)));
    const claim = s.claims.find((x) => x.invoiceId === inv.invoiceId);
    const und = claim ? Math.max(0, claim.undisputed.minor - s.allocs.filter((x) => x.invoiceId === inv.invoiceId && x.claim === 'UNDISPUTED').reduce((t, x) => t + x.amount.minor, 0)) : null;
    const t = s.threads.find((x) => x.customerId === inv.customerId);
    const owner = (t?.owner ?? 'HEADROOM') as 'HEADROOM' | 'YOU';
    const name = s.customers.find((x) => x.customerId === inv.customerId)?.displayName ?? inv.customerId;
    const out = a ? s.outs.find((o) => o.rootId === a.rootId && o.intentVersion === a.intentVersion) : undefined;
    const needsYou = !!a && (a.state === 'PROPOSED' || a.state === 'HELD' || a.state === 'FAILED' || (a.state === 'HELD_EVIDENCE' && !!a.decideBy && c.now >= a.decideBy));
    const grant = a ? s.grants.find((g) => g.rootId === a.rootId && g.kind === 'COLLECT_SLICE') : undefined;
    return {
      invoiceId: inv.invoiceId, invoiceNumber: inv.invoiceNumber, customerId: inv.customerId, customer: name, open: inv.openGross,
      undisputedOpen: und === null ? null : { currency: 'USD' as const, minor: und }, disputed: claim ? claim.disputed : null, dueOn: inv.dueOn, overdueDays: Math.max(0, days(today, inv.dueOn)),
      expected: a?.terms.targetOn ? `Target ${a.terms.targetOn} · Headroom's aim, not agreed` : 'No date agreed',
      needBy: run ? run.basisSnapshot.needBy : null,
      nextStep: !a ? 'Not in the running plan' : a.heldReasons[0] && ['HELD', 'FAILED', 'COMPLETED'].includes(a.state) ? `${a.state.toLowerCase()} · ${a.heldReasons[0]}` : a.state.toLowerCase().replace(/_/g, ' '),
      whoActs: owner === 'YOU' ? 'YOU' as const : needsYou ? 'NEEDS_YOU' as const : 'HEADROOM' as const, actionId: a?.actionId ?? null,
      gain: a?.estimate?.net.minor ?? 0,
      panel: {
        newDateLimit, why: a?.why.text ?? null, citations: (a?.sources ?? []).map((x) => `[${x.n}] ${x.label} · ${x.detail}`),
        drafts: a?.message ? [{ subject: a.message.subject, label: out ? out.state.toLowerCase().replace(/_/g, ' ') : 'draft', allowedBy: a.authority.decision === 'ALLOW' ? `${a.authority.winning.label} (Delegation v${a.authority.policyVersion})` : grant ? `Approved by you · revision ${run?.n ?? ''}`.trim() : 'Needs your approval' }] : [],
        owner, ownerVersion: t?.version ?? 0,
        claim: claim ? {
          invoice: inv.amount, undisputed: claim.undisputed, disputed: claim.disputed, acknowledgement: claim.acknowledgement, basis: claim.basis,
          // S7a-IR-10: worded from the current ar.disputes rule.
          disputedText: resolve(s.policy, 'ar.disputes', 'RECEIVABLES', inv.customerId).value === 'PROPOSE_DISPUTED' ? 'Disputed · asked for only with your approval each time' : 'Disputed · never collected by Headroom',
          cashConsequence: `Collecting the undisputed ${money(claim.undisputed.minor)} adds about ${money(a?.estimate?.net.minor ?? 0)} net after PayPal's fee; the ${money(claim.disputed.minor)} stays open${resolve(s.policy, 'ar.disputes', 'RECEIVABLES', inv.customerId).value === 'PROPOSE_DISPUTED' ? ' and is asked for only with your approval' : ' and is never collected by Headroom'}`,
          approval: grant ? (grant.state === 'CONSUMED' ? `Approved by you · revision ${run?.n ?? ''} · used to update the PayPal invoice` : `Approved by you · revision ${run?.n ?? ''}`) : a ? null : 'Not in the current plan · ask for it in Plan',
        } : null,
      },
    };
  });
  rows.sort((a, z) => (a.needBy ?? '9').localeCompare(z.needBy ?? '9') || z.gain - a.gain || z.overdueDays - a.overdueDays);
  const work = rows.map(({ gain: _g, ...r }, i) => ({ ...r, rank: i + 1 }));
  const gap = run?.basisSnapshot.gapMinor;
  return { work, workPopulation: gap ? `${work.length} open invoices · ranked for the ${money(gap)} reserve gap (need-by, then what each closes)` : `${work.length} open invoices · ranked by days overdue` };
}
