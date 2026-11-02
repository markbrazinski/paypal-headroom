// Plan (S04 §6.7: UI-PL-01…19, 22). Renders the server's PlanView/RevisionView as given: every figure, date, authority and consent
// comes from the API. Building shows the job's real checks (no timer). Nothing here sends or pays: the cards say so.
import { useEffect, useState } from 'react';
import type { ActionCard as Card, ResponseOf } from '@headroom/contracts';
import { ApiFailure, call } from '../api/client.ts';
import { useApp, useLoad } from '../data.ts';
import { Dialog, Failed, Loading, Pill } from '../components.tsx';
import { dateTime, day, money, shortDay } from '../format.ts';

type View = ResponseOf<'getPlan'>;
type Rev = NonNullable<View['revision']>;
type Cite = Card['sources'][number];

function useCommand(onStale?: () => void) {
  const { toast } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [key, setKey] = useState(() => crypto.randomUUID());
  const run = async (f: (key: string) => Promise<unknown>, ok: string, done: () => void) => {
    setBusy(true); setError(null);
    try { await f(key); toast(ok); setKey(crypto.randomUUID()); done(); }
    catch (e) {
      // A click on a view older than the plan is refused (409); re-read the plan so the next try uses current versions.
      if (e instanceof ApiFailure && e.error.code === 'VERSION_CONFLICT' && onStale) { onStale(); setError('The plan changed while you were looking at it, so it has been refreshed. Please try again.'); }
      else setError(e instanceof ApiFailure ? e.error.message : (e as Error).message);
    }
    finally { setBusy(false); }
  };
  return { busy, error, run };
}

export function Plan() {
  const q = useLoad(() => call('getPlan'));
  const p = q.data;
  const [buildErr, setBuildErr] = useState<string | null>(null);
  // UX repair (S7 audit F01): another revision (the proposed draft, or one from the history) opens beside the running one.
  const [viewId, setViewId] = useState<string | null>(null);
  const [other, setOther] = useState<Rev | null>(null);
  const build = async (retry?: { buildId: string; generation: number }) => {
    setBuildErr(null);
    try { await call('buildRevision', { body: retry ? { retry } : {} }); } catch (e) { setBuildErr(e instanceof ApiFailure ? e.error.message : (e as Error).message); }
    q.reload();
  };
  // Opening the page never builds: a plan builds when a bill's terms are accepted (O6) or when you ask (button below).
  useEffect(() => {
    if (p?.state === 'BUILDING') { const t = setTimeout(q.reload, 1500); return () => clearTimeout(t); }
  }, [p]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const id = location.hash.slice(1);
    if (p && id.startsWith('act-')) setTimeout(() => { const el = document.getElementById(id); el?.scrollIntoView({ behavior: 'smooth', block: 'center' }); el?.focus(); }, 50);
  }, [p?.revision?.revisionId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!viewId || viewId === p?.revision?.revisionId) { setOther(null); return; }
    let live = true;
    call('getRevision', { params: { id: viewId } }).then((r) => live && setOther(r), (e) => live && setBuildErr((e as Error).message));
    return () => { live = false; };
  }, [viewId, p]);
  if (q.error) return <div className="page"><h1>Plan</h1><Failed error={q.error} /></div>;
  if (!p) return <div className="page"><h1>Plan</h1><Loading /></div>;
  const shown = other ?? p.revision;
  const reloadAll = () => { q.reload(); if (viewId) setViewId(viewId); };
  return (
    <div className="page plan">
      <h1>Plan</h1>
      {buildErr && <div className="err-banner">{buildErr}</div>}
      {other && <div className="comparing">Viewing revision {other.n} ({other.state === 'DRAFT' ? 'proposed, not running' : other.state.toLowerCase()}). <button className="linkbtn" onClick={() => setViewId(null)}>Back to {p.running ? `the running revision ${p.running.n}` : 'the current plan'}</button></div>}
      {!other && p.proposed && <div className="comparing">{p.proposed.text}. <button className="linkbtn" onClick={() => setViewId(p.proposed!.revisionId)}>Open revision {p.proposed.n}</button></div>}
      {p.state === 'NO_OPENING' && <div className="notbuilt"><strong style={{ color: 'var(--ink)' }}>{p.reason}</strong>. Headroom needs PayPal's reported balance before it can work out a plan; nothing is guessed.</div>}
      {p.state === 'NO_PLAN_NEEDED' && <div className="box"><div className="box-b"><Pill tone="green" glyph="✓">No plan needed</Pill> <span className="serif" style={{ fontSize: 20, marginLeft: 8 }}>Forecast above reserve under stated assumptions.</span></div></div>}
      {p.state === 'BUILDING' && <Building p={p} />}
      {p.state === 'NEEDS_BUILD' && (
        <div className="box"><div className="box-b">
          <div className="serif" style={{ fontSize: 20 }}>{p.banner ?? 'Cash falls below your reserve'}.</div>
          <div className="muted">Headroom builds a revision when you ask; {p.running ? 'the running revision keeps going until you approve a new one' : 'nothing runs until you approve it'}.</div>
          <div style={{ marginTop: 10 }}><button className="btn primary" onClick={() => build()}>{p.running ? 'Build a new revision' : 'Build a plan'}</button></div>
        </div></div>
      )}
      {p.state === 'FAILED' && p.build && (
        <div className="box"><div className="box-b">
          <div className="serif" style={{ fontSize: 20 }}>{p.reason}</div>
          {p.build.failure?.kind === 'STALE' ? <div className="muted">Headroom will build again for your current cash picture.</div> : null}
          <div style={{ marginTop: 10 }}><button className="btn primary" onClick={() => build({ buildId: p.build!.buildId, generation: p.build!.generation })}>Try again</button></div>
        </div></div>
      )}
      {p.reason && p.state === 'READY' && <div className="comparing">{p.reason} {p.build?.retryable && <button className="linkbtn" onClick={() => build({ buildId: p.build!.buildId, generation: p.build!.generation })}>Build again</button>}</div>}
      {shown && <Revision key={shown.revisionId} r={shown} p={p} reload={reloadAll} />}
      {p.outside.length > 0 && (
        <div className="box"><div className="box-h"><h3>Needs you outside the plan</h3></div>
          {p.outside.map((o) => <div key={o.billId} className="box-b plan-row"><span><strong>{o.label}</strong> · {o.reason}</span><a href={`/payables?bill=${o.billId}`}>Open bill ›</a></div>)}
        </div>
      )}
      <Trail p={p} open={(id) => { setViewId(id); window.scrollTo({ top: 0 }); }} current={shown?.revisionId ?? null} />
    </div>
  );
}

function Building({ p }: { p: View }) {
  return (
    <div className="box" aria-live="polite"><div className="box-h"><h3>Building a plan</h3><span className="muted small">{p.banner ?? 'Cash falls below your reserve'}</span></div>
      <div className="box-b">
        {(p.build?.checks ?? []).map((c) => (
          <div key={c.key} className="kv"><span>{c.result === 'PENDING' ? '◌' : c.result === 'OK' ? '✓' : '•'} {c.label}</span><span className="muted small">{c.detail ?? (c.result === 'PENDING' ? 'waiting' : '')}</span></div>
        ))}
        {!p.build && <div className="muted">Starting…</div>}
      </div>
    </div>
  );
}

function Revision({ r, p, reload }: { r: Rev; p: View; reload: () => void }) {
  const [dialog, setDialog] = useState<'approve' | 'reject' | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [tab, setTab] = useState<'plan' | 'outlook'>('plan');
  // Recheck notes live here, keyed by action, so they survive a card moving between lists (remove ↔ restore).
  const [notes, setNotes] = useState<Record<string, string[]>>({});
  const noteFor = (id: string) => ({ note: notes[id] ?? null, setNote: (n: string[]) => setNotes((x) => ({ ...x, [id]: n })) });
  const editable = r.state === 'DRAFT' || r.state === 'RUNNING';
  const waiting = r.approval?.selected.length ?? 0;
  // The demo dock's "Approve…" opens this same dialog, so the owner sees each approval before anything happens.
  useEffect(() => { const f = () => { if (editable && waiting && !r.approval?.blocked) setDialog('approve'); }; addEventListener('hr:approve', f); return () => removeEventListener('hr:approve', f); }, [editable, waiting, r.approval?.blocked]);
  const h = r.header;
  return (
    <>
      <div className="box plan-head">
        <div className="box-b plan-head-b">
          <div>
            <div><Pill tone={r.state === 'DRAFT' ? 'grey' : r.pill.startsWith('REVISION NEEDS') ? 'amber' : 'brand'} glyph={r.state === 'DRAFT' ? '○' : '◐'}>{r.pill}</Pill> <span className="muted small">{r.state === 'DRAFT' ? 'Draft' : 'Revision'} {r.n}{r.state === 'RUNNING' && r.approvedAt ? ` · approved ${dateTime(r.approvedAt)}` : ''}</span></div>
            <div className="serif plan-headline">{h.change ? `${h.change}. ` : ''}{h.coverage.state === 'RESOLVED' ? h.coverage.text : <>You'd be {money(h.gap)} below your reserve at the low. {h.coverage.text}</>}</div>
            <div className="small muted">Lowest point {h.before && h.before.low.minor !== h.after.low.minor ? <>{money(h.before.low)} → </> : null}<strong className={h.after.low.minor < 0 ? 'neg' : ''}>{money(h.after.low)}</strong> ({shortDay(h.after.lowOn)}) · {h.coverage.state === 'RESOLVED' ? <>Reserve {h.reserve ? money(h.reserve) : ''} · </> : <>Needed by <strong>{day(h.needBy)}</strong> · </>}{h.compareId && <a href={`/cash?compare=${encodeURIComponent(h.compareId)}`}>Compare forecasts ›</a>}</div>
            <div className="small muted" style={{ marginTop: 4 }}>{r.planner.mode === 'MODEL' ? 'Chosen and explained by Nova from Headroom’s figures' : `Written by Headroom’s template, not Nova${r.planner.reason ? ` (${r.planner.reason})` : ''}`} · {r.planner.summary}</div>
            {r.laterGap && <div className="small" style={{ color: 'var(--amber)', marginTop: 4 }}>{r.laterGap}</div>}
          </div>
          <div className="plan-head-actions">
            {editable && <button className="btn primary" disabled={!waiting || !!r.approval?.blocked} title={r.approval?.blocked ?? undefined} onClick={() => setDialog('approve')}>Approve selected actions… ({waiting})</button>}
            {r.state === 'DRAFT' && <button className="btn" onClick={() => setDialog('reject')}>Reject revision…</button>}
          </div>
        </div>
        {r.approval?.blocked && waiting > 0 && <div className="box-b" style={{ color: 'var(--amber)' }}>{r.approval.blocked}</div>}
      </div>
      {r.kept && <Kept k={r.kept} />}
      {r.updates.length > 0 && <SinceApproved r={r} />}
      {/* Owner, 2 Nov 2026: the schedule and the actions come first; the "if…" outlook is its own sub-tab. */}
      <div className="tabs plan-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'plan'} className={tab === 'plan' ? 'on' : ''} onClick={() => setTab('plan')}>Plan</button>
        <button role="tab" aria-selected={tab === 'outlook'} className={tab === 'outlook' ? 'on' : ''} onClick={() => setTab('outlook')}>Outlook · if…</button>
      </div>
      {tab === 'outlook' ? <Outlook r={r} /> : <>
      <Schedule r={r} onMarker={(id) => { setFocus(id); document.getElementById(`act-${id}`)?.focus(); }} />
      <div className="kicker" style={{ margin: '18px 0 6px' }}>Actions · same as the schedule</div>
      {r.actions.map((a) => <ActionCard key={a.actionId} a={a} r={r} focused={focus === a.actionId} reload={reload} {...noteFor(a.actionId)} />)}
      {r.removed.length > 0 && <><div className="kicker" style={{ margin: '18px 0 6px' }}>Removed by you</div>{r.removed.map((a) => <ActionCard key={a.actionId} a={a} r={r} focused={false} reload={reload} {...noteFor(a.actionId)} />)}</>}
      {r.diff && <div className="box"><div className="box-h"><h3>What changed from the running revision</h3></div><div className="box-b">{r.diff.map((d) => <div key={d.rootId} className="kv"><span>{ROOT_LABEL[d.rootId.split(':')[0]] ?? 'Action'} · {d.detail}</span><span className="muted small">{d.change}</span></div>)}</div></div>}
      <Considered r={r} reload={reload} />
      </>}
      {dialog === 'approve' && r.approval && <ApproveDialog r={r} onClose={() => setDialog(null)} onDone={() => { setDialog(null); reload(); }} />}
      {dialog === 'reject' && <RejectDialog r={r} running={!!p.running} onClose={() => setDialog(null)} onDone={() => { setDialog(null); reload(); }} />}
    </>
  );
}

const UPDATE_LABEL: Record<Rev['updates'][number]['kind'], string> = { RECEIPT: 'Payment received', REASSESSED: 'Reassessed', SKIPPED: 'Offer not needed', PAID: 'Supplier paid', SENT: 'Asked' };
const UPDATE_GLYPH: Record<Rev['updates'][number]['kind'], string> = { RECEIPT: '✓', REASSESSED: '◎', SKIPPED: '✓', PAID: '✓', SENT: '→' };

/** The demo's climax, and the product's: a concession Headroom never had to make. Shown once the fallback is skipped. */
function Kept({ k }: { k: NonNullable<Rev['kept']> }) {
  return (
    <div className="box kept" role="status">
      <div className="box-b kept-b">
        <div className="kept-amt"><span className="kicker">You keep</span><span className="kept-v">{money(k.amount)}</span></div>
        <div>
          <div className="serif kept-h">{k.headline}</div>
          <div className="small">{k.text}</div>
          <a className="small" href={`#act-${k.actionId}`} onClick={(e) => { e.preventDefault(); document.getElementById(`act-${k.actionId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }}>See the check ›</a>
        </div>
      </div>
    </div>
  );
}

/** What happened since approval, newest last, each line linked to its record; the meter shows how much of the approval-day gap is closed. */
function SinceApproved({ r }: { r: Rev }) {
  const { nav } = useApp();
  const p = r.progress;
  const closed = p ? Math.max(0, Math.min(1, 1 - p.gapNow.minor / p.gapAtApproval.minor)) : null;
  return (
    <div className="box plan-updates" aria-live="polite">
      <div className="box-h"><h3>Since you approved</h3><span className="muted small">From PayPal's confirmations and the current forecast</span></div>
      {p && closed !== null && (
        <div className="box-b gap-meter">
          <div className="small"><strong>{closed >= 1 ? 'Gap closed' : `${money(p.gapNow)} to go`}</strong> <span className="muted">of the {money(p.gapAtApproval)} gap below your reserve when you approved</span></div>
          <div className="meter" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(closed * 100)}><div className={`meter-fill ${closed >= 1 ? 'done' : ''}`} style={{ width: `${Math.round(closed * 100)}%` }} /></div>
        </div>
      )}
      {r.updates.map((u) => (
        <div key={`${u.kind}:${u.text}`} className={`box-b small upd upd-${u.kind}`}>
          <span className="upd-g" aria-hidden>{UPDATE_GLYPH[u.kind]}</span>
          <span className="upd-t"><strong>{UPDATE_LABEL[u.kind]}</strong>{u.at ? <span className="muted"> · {dateTime(u.at)}</span> : null} · {u.text}</span>
          {u.amount && <span className={`upd-a upd-a-${u.kind}`}>{u.kind === 'RECEIPT' ? '+' : u.kind === 'PAID' ? '−' : ''}{money(u.amount)}{u.kind === 'SKIPPED' ? ' kept' : ''}</span>}
          {u.to && <button className="linkbtn small" onClick={() => nav(u.to!)}>View ›</button>}
        </div>
      ))}
    </div>
  );
}

function Outlook({ r }: { r: Rev }) {
  const nb = shortDay(r.header.needBy);
  return (
    <div className="box"><div className="box-h"><h3>Outlook · if…</h3><span className="muted small">{r.outlookNote}</span></div>
      <table className="ledger plan-outlook">
        <thead><tr><th>If…</th><th className="num">{nb} close</th><th className="num">Lowest</th><th>Reserve result</th><th className="num">Concession cost</th></tr></thead>
        <tbody>{r.outlook.map((o) => (
          <tr key={o.key}>
            <td><strong>{o.label}</strong><div className="small muted">{o.condition}</div></td>
            <td className={`num ${o.needByClose.minor < 0 ? 'neg' : ''}`}>{money(o.needByClose)}</td>
            <td className={`num ${o.low.minor < 0 ? 'neg' : ''}`}>{money(o.low)} <span className="small muted">{shortDay(o.lowOn)}</span></td>
            <td style={{ color: o.result === 'COVERED' ? 'var(--green)' : 'var(--amber)', fontWeight: 600 }}>{o.result === 'COVERED' ? 'Covered' : `Gap ${money(o.gap)} · first below reserve ${shortDay(o.firstBelowReserve)}`}</td>
            <td className="num">{money(o.concessionCost)}</td>
          </tr>
        ))}</tbody>
      </table>
      <div className="box-b small muted">Likelihood: not assessed. Each row is an "if", not a forecast of what will happen.</div>
    </div>
  );
}

/** Owner, 2 Nov 2026: plain words on the calendar instead of glyphs and a legend. An ask reads by its message's real state (S5). */
const MARK: Record<string, string> = { CONTACT: 'Email ask', CHECK: 'Reply check', TARGET: 'Target payment', CONDITIONAL: 'Offer check', OBLIGATION: 'Payment due', EXPIRY: 'Offer ends' };
const DOING: Record<Card['kind'], string> = { COLLECT_OVERDUE: 'Ask to pay the overdue invoice', COLLECT_UNDISPUTED_SLICE: 'Ask to pay the undisputed part', COLLECT_DISPUTED: 'Ask about the disputed amount (needs your approval each time)', ASK_SUPPLIER: 'Ask the supplier to keep or split the date (accepting their answer needs you)', DISCOUNT_FALLBACK: 'Offer an early-payment discount (fallback)', PAYOUT: 'Pay supplier · held for you' };
function Schedule({ r, onMarker }: { r: Rev; onMarker: (actionId: string) => void }) {
  // Owner, 3 Nov 2026: only the days the plan uses (through its last entry or need-by, plus one), at least a week, at most two.
  const last = [r.schedule.needBy, ...r.schedule.lanes.flatMap((l) => l.markers.map((m) => m.on))].sort().at(-1)!;
  const span = Math.min(14, Math.max(7, Math.round((Date.parse(`${last}T00:00:00Z`) - Date.parse(`${r.schedule.from}T00:00:00Z`)) / 86_400_000) + 2));
  const days: string[] = [];
  for (let d = new Date(`${r.schedule.from}T00:00:00Z`); days.length < span; d.setUTCDate(d.getUTCDate() + 1)) days.push(d.toISOString().slice(0, 10));
  const kindOf = (id: string | null) => r.actions.find((a) => a.actionId === id)?.kind;
  const askLabel = (id: string | null) => {
    const m = r.actions.find((a) => a.actionId === id)?.messageState;
    return !m ? 'Email ask' : m.held ? 'Email held' : m.state === 'SENT' ? 'Email sent' : m.state === 'QUEUED' || m.state === 'SENDING' ? 'Email queued' : m.state === 'SEND_UNKNOWN' ? 'Delivery unknown' : m.state === 'DRAFT' ? 'Email ask' : 'Not sent';
  };
  return (
    <div className="box"><div className="box-h"><h3>Schedule</h3><span className="muted small">Cash needed by {day(r.schedule.needBy)} (amber) · targets are Headroom's aim, not agreed terms</span></div>
      <div className="sched" style={{ gridTemplateColumns: `240px repeat(${days.length}, minmax(0, 1fr))` }}>
        <div className="sched-h" />
        {days.map((d) => <div key={d} className={`sched-h ${d === r.schedule.needBy ? 'need' : ''} ${[0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay()) ? 'wknd' : ''}`}>{shortDay(d)}</div>)}
        {r.schedule.lanes.map((l) => (
          <div key={l.key} style={{ display: 'contents' }}>
            <div className="sched-lane"><strong>{l.label}</strong>{[...new Set(l.markers.map((m) => kindOf(m.actionId)).filter(Boolean))].map((k) => <div key={k} className="small sched-doing">{DOING[k!]}</div>)}</div>
            {days.map((d) => (
              <div key={d} className={`sched-cell ${d === r.schedule.needBy ? 'need' : ''} ${[0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay()) ? 'wknd' : ''}`}>
                {l.markers.filter((m) => m.on === d).map((m, i) => {
                  // A target on or after need-by can't help the gap: say so on the calendar, not only on the card.
                  const late = m.kind === 'TARGET' && m.on >= r.schedule.needBy;
                  return <button key={i} className={`mk mk-${m.kind} ${late ? 'mk-late' : ''}`} title={m.label} onClick={() => m.actionId && onMarker(m.actionId)}>{late ? `Target · too late for ${shortDay(r.schedule.needBy)}` : m.kind === 'CONTACT' ? askLabel(m.actionId) : MARK[m.kind]}</button>;
                })}
              </div>
            ))}
          </div>
        ))}
      </div>
      <div className="box-b small muted">Click an entry to go to its action. A scheduled ask is not a receipt; a payout runs on its due date at 09:00 only if PayPal funds cover it. Overdue invoices are asked to be paid by the next business day.</div>
    </div>
  );
}

function citeHref(c: Cite, a: Card): string {
  switch (c.kind) {
    case 'INVOICE': return `/receivables?invoice=${c.id}`;
    case 'CLAIM': return `/relationships?id=${a.counterparty.id}`;
    case 'HISTORY': return `/relationships?id=${a.counterparty.id}`;
    case 'POLICY': return `/delegation#${c.id}`;
    case 'FORECAST_DAY': return `/cash?day=${c.id}`;
    case 'TERMS': case 'BILL': case 'OBLIGATION': return '/payables';
  }
}
function Sources({ a }: { a: Card }) {
  const { nav } = useApp();
  const [open, setOpen] = useState<number | null>(null);
  const shown = a.sources.filter((s) => a.why.citations.includes(s.n) || a.why.citations.length === 0);
  return (
    <div className="small sources">Sources {(shown.length ? shown : a.sources).map((c) => (
      <span key={c.n} className="cite-wrap" onMouseEnter={() => setOpen(c.n)} onMouseLeave={() => setOpen(null)}>
        <button className="cite" aria-describedby={open === c.n ? `cite-${a.actionId}-${c.n}` : undefined} onFocus={() => setOpen(c.n)} onBlur={() => setOpen(null)} onClick={() => nav(citeHref(c, a))}>[{c.n}]</button>
        {open === c.n && <span role="tooltip" id={`cite-${a.actionId}-${c.n}`} className="cite-card"><strong>{c.label}</strong><br />{c.detail}</span>}
      </span>
    ))}</div>
  );
}

const KIND_LABEL: Record<Card['kind'], string> = { COLLECT_OVERDUE: 'Overdue follow-up', COLLECT_UNDISPUTED_SLICE: 'Undisputed part', COLLECT_DISPUTED: 'Disputed amount', ASK_SUPPLIER: 'Supplier ask', DISCOUNT_FALLBACK: 'Early-payment offer · fallback', PAYOUT: 'Supplier payout' };
const TAG_CLASS: Record<Card['authorityTag']['tone'], string> = { DELEGATION: 'auth-ok', APPROVED: 'auth-ok', NEEDS_YOU: 'auth-you', EXCEPTION: 'auth-ex', BLOCKED: 'auth-ex' };

function ActionCard({ a, r, focused, reload, note, setNote }: { a: Card; r: Rev; focused: boolean; reload: () => void; note: string[] | null; setNote: (n: string[]) => void }) {
  const [mode, setMode] = useState<'edit' | 'remove' | 'alt' | null>(null);
  const c = useCommand(reload);
  const t = a.terms;
  const op = (body: unknown, ok: string) =>
    c.run(async (key) => { const res = await call('editRevision', { params: { id: r.revisionId }, ifMatch: r.version, idempotencyKey: key, body }); setNote(res.notes); }, ok, () => { setMode(null); reload(); });
  const rows: [string, string][] = a.kind === 'PAYOUT'
    ? [['Pay', `${money(t.amount)} on ${day(t.payBy)}`], ['Obligation', a.sources[0]?.detail ?? ''], [a.state === 'PROPOSED' || a.state === 'HELD' ? 'Held because' : 'Runs only when', a.heldReasons.join(' · ')]]
    : a.kind === 'ASK_SUPPLIER'
      ? [['Headroom asks', `${day(t.contactOn)}${a.paused ? ' · paused' : ''}`], ['Reply check', day(t.replyCheckOn)], ['Options offered', (t.askOptions ?? []).map((o) => `${o.code === 'KEEP' ? 'Keep' : 'Split'}: ${o.parts.map((p) => `${money(p.amount)} ${day(p.dueOn)}`).join(' + ')}`).join(' · or ')], ['Their answer', 'Changes nothing until you accept it (Payables › the bill)']]
    : a.kind === 'DISCOUNT_FALLBACK'
      ? [['Condition', a.condition?.text ?? ''], ['Offer', `${(t.discountBp ?? 0) / 100}% off · ${money(t.amount)} instead of ${money({ currency: 'USD', minor: t.amount.minor + (t.discountAmount?.minor ?? 0) })} · pay by ${day(t.payBy)} · ends ${day(t.expiresOn)}`], ['Concession cost', a.state === 'SKIPPED_NOT_NEEDED' ? `${money(t.discountAmount)} · kept, never offered` : money(t.discountAmount)]]
      : [['Headroom asks', `${day(t.contactOn)}${a.paused ? ' · paused' : ''}`], ['Reply check', day(t.replyCheckOn)], ['Target receipt', `${day(t.targetOn)} · Headroom’s target, not agreed terms`], ['Amount requested', `${money(t.amount)}${a.kind === 'COLLECT_UNDISPUTED_SLICE' ? ' · undisputed part only' : ' in full'}`]];
  return (
    <div className={`box act ${focused ? 'focus' : ''}`} id={`act-${a.actionId}`} tabIndex={-1}>
      <div className="act-l">
        <div className="kicker">{KIND_LABEL[a.kind]}</div>
        <div><a href={`/relationships?id=${a.counterparty.id}`}><strong>{a.counterparty.name} ›</strong></a></div>
        {a.relationship && <div className="small"><span aria-hidden>{'●'.repeat(a.relationship.dots)}{'○'.repeat(4 - a.relationship.dots)}</span> {a.relationship.label}<div className="muted">{a.relationship.meaning}</div></div>}
        {a.invoiceNumber && <div className="small muted">Invoice {a.invoiceNumber} · on PayPal</div>}
      </div>
      <div className="act-m">
        <div className="act-title">{a.kind === 'PAYOUT' ? `Pay ${a.counterparty.name} ${money(t.amount)}` : a.kind === 'DISCOUNT_FALLBACK' ? `Offer ${a.counterparty.name} ${(t.discountBp ?? 0) / 100}% to pay early` : a.kind === 'COLLECT_UNDISPUTED_SLICE' ? `Ask ${a.counterparty.name} for the undisputed ${money(t.amount)}` : a.kind === 'COLLECT_DISPUTED' ? `Ask ${a.counterparty.name} for ${money(t.amount)} of the disputed amount` : a.kind === 'ASK_SUPPLIER' ? `Ask ${a.counterparty.name} to keep the original date${(t.askOptions ?? []).some((o) => o.code === 'SPLIT') ? ' or split the payment' : ''}` : `Ask ${a.counterparty.name} to pay ${money(t.amount)}`}</div>
        <span className={`auth ${TAG_CLASS[a.authorityTag.tone]}`}>{a.authorityTag.text}</span>
        {a.authorityNow && <div className="small" style={{ color: 'var(--amber)' }}>Rules changed (Delegation v{a.authorityNow.policyVersion}): {a.authorityNow.reasons.join(' · ')}</div>}
        {a.late && <div className="small" style={{ color: 'var(--amber)' }}>Late · {a.late}</div>}
        {a.staleEdits.map((s) => <div key={s} className="small" style={{ color: 'var(--amber)' }}>{s}</div>)}
        <dl className={`act-facts ${a.state === 'SKIPPED_NOT_NEEDED' ? 'struck' : ''}`}>{rows.map(([k, v]) => <div key={k}><dt className="muted">{k}</dt><dd>{v}</dd></div>)}</dl>
        <div className="small"><strong>Cash effect</strong> · {a.cashEffect}</div>
        <div className="why"><div className="kicker">Why · {a.why.writtenBy === 'MODEL' ? 'Nova' : 'Headroom’s template'}</div>{a.why.text}</div>
        <Sources a={a} />
        {a.message && <details className="small"><summary>{a.messageState ? a.messageState.label : 'Draft · not sent'}{a.message.writtenBy === 'MODEL' ? ' · opening and closing phrased by Nova; every figure and date from Headroom' : a.message.writtenBy === 'OWNER' ? ' · edited by you' : ''}</summary>{a.messageState?.preparedFor && <div className="muted">Prepared for {a.messageState.preparedFor} · test delivery to your inbox; the customer is not contacted</div>}<div><strong>{a.message.subject}</strong></div><pre className="msg">{a.message.body}</pre></details>}
        {a.check && <CheckView c={a.check} />}
        {a.decide && <Decide a={a} reload={reload} />}
        {note && <div className="note" role="status">{note.join(' · ')}</div>}
        {mode === 'edit' && <Editor a={a} busy={c.busy} onCancel={() => setMode(null)} onSave={(changes) => op({ op: 'EDIT_ACTION', actionId: a.actionId, actionVersion: a.version, changes }, 'Saved and rechecked')} />}
        {mode === 'remove' && <Remover busy={c.busy} onCancel={() => setMode(null)} onRemove={(reason) => op({ op: 'REMOVE', actionId: a.actionId, actionVersion: a.version, ...(reason ? { reason } : {}) }, 'Removed. It stays in the revision history')} />}
        {mode === 'alt' && <Alternative a={a} r={r} busy={c.busy} onCancel={() => setMode(null)} onUse={(root) => op({ op: 'USE_ALTERNATIVE', actionId: a.actionId, actionVersion: a.version, alternativeRootId: root }, 'Alternative in the plan')} />}
        {c.error && <div className="err-banner">{c.error}</div>}
      </div>
      <div className="act-r">
        <Pill tone={PILL_TONE[a.state] ?? 'brand'} glyph={a.state === 'PROPOSED' ? '?' : a.state === 'REMOVED' ? '–' : ['COMPLETED', 'SKIPPED_NOT_NEEDED'].includes(a.state) ? '✓' : '◐'}>{STATE_LABEL[a.state] ?? a.state.charAt(0) + a.state.slice(1).toLowerCase().replace(/_/g, ' ')}</Pill>
        <div className="small">{a.stateText}</div>
        {a.paused && <div className="small" style={{ color: 'var(--amber)' }}>{a.paused}</div>}
        {a.grants.map((g) => <div key={g.grantId} className="small muted">{g.text} · {GRANT_STATE[g.state] ?? g.state.toLowerCase()}</div>)}
        <div className="act-btns">
          {a.editable.length > 0 && <button className="btn" onClick={() => setMode('edit')}>Edit</button>}
          {a.alternatives.length > 0 && a.canRemove && <button className="btn" onClick={() => setMode('alt')}>Ask for alternative</button>}
          {a.canRemove && <button className="btn" onClick={() => setMode('remove')}>Remove…</button>}
          {a.canRestore && <button className="btn" disabled={c.busy} onClick={() => op({ op: 'RESTORE', actionId: a.actionId, actionVersion: a.version }, 'Back in the plan as proposed')}>Restore</button>}
          {a.canSendNow && <button className="btn" disabled={c.busy} onClick={() => c.run((key) => call('sendNow', { params: { id: a.actionId }, idempotencyKey: key, body: {} }), 'Sending now (still checked first)', reload)}>Send now</button>}
          {a.canHold && <button className="btn" disabled={c.busy} onClick={() => c.run((key) => call('holdMessage', { params: { id: a.actionId }, idempotencyKey: key, body: { held: !a.messageState?.held } }), a.messageState?.held ? 'Released · it sends at the next allowed time' : 'Held · it will not send', reload)}>{a.messageState?.held ? 'Release message' : 'Hold message'}</button>}
        </div>
      </div>
    </div>
  );
}

const PILL_TONE: Partial<Record<Card['state'], 'grey' | 'amber' | 'brand' | 'green' | 'red'>> = {
  PROPOSED: 'grey', REMOVED: 'grey', SUPERSEDED: 'grey', HELD: 'amber', HELD_EVIDENCE: 'amber', UNCERTAIN: 'amber', FAILED: 'red', COMPLETED: 'green', SKIPPED_NOT_NEEDED: 'green', CANCELLED: 'grey', EXPIRED: 'grey',
};
const STATE_LABEL: Partial<Record<Card['state'], string>> = {
  WAITING_CONDITION: 'Waiting', HELD_EVIDENCE: 'Waiting for evidence', UNCERTAIN: 'Checking', APPLIED: 'Applied', SKIPPED_NOT_NEEDED: 'Not needed · skipped',
  PROPOSED: 'Proposed', SCHEDULED: 'Scheduled', QUEUED: 'Sending', HELD: 'Held', COMPLETED: 'Done', FAILED: 'Failed', REMOVED: 'Removed', SUPERSEDED: 'Replaced', CANCELLED: 'Cancelled', EXPIRED: 'Expired',
};
const GRANT_STATE: Record<string, string> = { ACTIVE: 'active', CONSUMED: 'used', LAPSED: 'no longer valid', EXPIRED: 'expired', REVOKED: 'revoked by you' };

/** C-SKIP-1 calculation as Headroom recorded it (UI-PL-17): verified funds only; the reason is never a promise. */
function CheckView({ c }: { c: NonNullable<Card['check']> }) {
  const min = (m: NonNullable<Card['check']>['lowerMin']) => (m ? `${money(m.close)} on ${day(m.on)}` : 'not calculated');
  const head = c.decision === 'SKIP' ? 'Not needed: verified funds alone stay above the reserve' : c.decision === 'HELD_EVIDENCE' ? 'Waiting for balance evidence' : c.decision === 'NEEDED' ? 'Needed: verified funds fall short' : 'Held at the check';
  return (
    <details className="small fb-check" open={c.decision !== 'NEEDED'}>
      <summary><strong>Fallback check</strong> · {head} · {dateTime(c.at)}{c.early ? ' · run early by the operator' : ''}</summary>
      <dl className="act-facts">
        <div><dt className="muted">Lowest, verified funds only</dt><dd>{min(c.lowerMin)}</dd></div>
        <div><dt className="muted">Lowest, with captured money not yet in PayPal's report</dt><dd>{min(c.upperMin)}</dd></div>
        <div><dt className="muted">Reserve</dt><dd>{money(c.reserve)}</dd></div>
      </dl>
      <div className="muted">{c.sources}</div>
      {c.blockers.length > 0 && <div style={{ color: 'var(--amber)' }}>Why it can't decide yet: {c.blockers.join(' · ')}</div>}
    </details>
  );
}

/** T6: still unproven at its decide-by time → the owner decides. Send writes a one-time authority; a pause is never bypassed. */
function Decide({ a, reload }: { a: Card; reload: () => void }) {
  const c = useCommand(reload);
  const d = a.decide!;
  const go = (decision: 'SEND' | 'DONT_SEND') => c.run((key) => call('decideFallback', { params: { id: a.actionId }, ifMatch: a.version, idempotencyKey: key, body: { decision, checkId: d.checkId } }), decision === 'SEND' ? 'Offer approved once · it goes out after its own checks' : 'Offer not sent', reload);
  return (
    <div className="note" role="group" aria-label="Your decision">
      {d.due ? `Headroom can't yet prove the gap is covered (decide by ${dateTime(d.by)}).` : `If still unproven by ${dateTime(d.by)}, this needs your decision.`}{' '}
      {d.due && <><button className="btn primary" disabled={c.busy} onClick={() => go('SEND')}>Send offer</button> <button className="btn" disabled={c.busy} onClick={() => go('DONT_SEND')}>Don't send</button></>}
      {c.error && <div className="err-banner">{c.error}</div>}
    </div>
  );
}

function Editor({ a, busy, onCancel, onSave }: { a: Card; busy: boolean; onCancel: () => void; onSave: (c: Record<string, unknown>) => void }) {
  const t = a.terms;
  const [contactOn, setContact] = useState(t.contactOn ?? '');
  const [targetOn, setTarget] = useState(t.targetOn ?? '');
  const [amount, setAmount] = useState(((t.amount.minor) / 100).toFixed(2));
  const [bp, setBp] = useState(t.discountBp ?? 200);
  const [body, setBody] = useState(a.message?.body ?? '');
  const save = () => {
    const ch: Record<string, unknown> = {};
    if (a.editable.includes('contactOn') && contactOn !== t.contactOn) ch.contactOn = contactOn;
    if (a.editable.includes('targetOn') && targetOn !== t.targetOn) ch.targetOn = targetOn;
    if (a.editable.includes('amountMinor') && Math.round(Number(amount) * 100) !== t.amount.minor) ch.amountMinor = Math.round(Number(amount) * 100);
    if (a.editable.includes('discountBp') && bp !== t.discountBp) ch.discountBp = bp;
    if (a.editable.includes('message') && a.message && body !== a.message.body) ch.message = { subject: a.message.subject, body };
    onSave(ch);
  };
  return (
    <div className="editor">
      {a.editable.includes('contactOn') && <label className="field"><span>Headroom asks on</span><input type="date" value={contactOn} onChange={(e) => setContact(e.target.value)} /></label>}
      {a.editable.includes('targetOn') && <label className="field"><span>Target receipt (not agreed)</span><input type="date" value={targetOn} onChange={(e) => setTarget(e.target.value)} /></label>}
      {a.editable.includes('amountMinor') && <label className="field"><span>Amount requested (undisputed part at most)</span><input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>}
      {a.editable.includes('discountBp') && <label className="field"><span>Discount</span><select value={bp} onChange={(e) => setBp(Number(e.target.value))}>{[100, 200, 300, 500].map((b) => <option key={b} value={b}>{b / 100}%</option>)}</select></label>}
      {a.editable.includes('message') && a.message && <label className="field"><span>Message wording (your words are sent as written)</span><textarea rows={6} value={body} onChange={(e) => setBody(e.target.value)} /></label>}
      <div className="small muted">Saving rechecks dates, delegation and the outlook. Nothing is sent.</div>
      <div><button className="btn" onClick={onCancel}>Cancel</button> <button className="btn primary" disabled={busy} onClick={save}>Save and recheck</button></div>
    </div>
  );
}

function Remover({ busy, onCancel, onRemove }: { busy: boolean; onCancel: () => void; onRemove: (reason: string | null) => void }) {
  const [reason, setReason] = useState<string | null>(null);
  return (
    <div className="editor">
      <div className="small">Why remove it? (optional)</div>
      <div>{['I’ll handle it myself', 'Talk to them first', 'Not worth the cost'].map((r) => <button key={r} className={`btn chip ${reason === r ? 'on' : ''}`} aria-pressed={reason === r} onClick={() => setReason(reason === r ? null : r)}>{r}</button>)}</div>
      <div><button className="btn" onClick={onCancel}>Cancel</button> <button className="btn primary" disabled={busy} onClick={() => onRemove(reason)}>Remove from this revision</button></div>
    </div>
  );
}

function Alternative({ a, r, busy, onCancel, onUse }: { a: Card; r: Rev; busy: boolean; onCancel: () => void; onUse: (root: string) => void }) {
  const alt = r.considered.find((c) => a.alternatives.includes(c.key) && c.canAsk) ?? null;
  return (
    <div className="editor">
      {alt ? <><div><strong>{alt.title}</strong> · {alt.reason}</div><div><button className="btn" onClick={onCancel}>Dismiss</button> <button className="btn primary" disabled={busy} onClick={() => onUse(alt.key)}>Use alternative</button></div></>
        : <><div className="small">No other action Headroom is allowed to take covers this need: the others are already in the plan or not possible (see Considered, not used).</div><div><button className="btn" onClick={onCancel}>Dismiss</button></div></>}
    </div>
  );
}

function Considered({ r, reload }: { r: Rev; reload: () => void }) {
  const c = useCommand(reload);
  return (
    <div className="box considered"><div className="box-h"><h3>Considered, not used</h3></div>
      {r.considered.map((x) => (
        <div key={x.key} className="box-b">
          <strong>{x.title}</strong><div className="small">{x.reason}</div>
          {x.canAsk && x.actionId && <button className="btn" disabled={c.busy} onClick={() => c.run((key) => call('editRevision', { params: { id: r.revisionId }, ifMatch: r.version, idempotencyKey: key, body: { op: 'INCLUDE_CONSIDERED', actionId: x.actionId!, actionVersion: x.actionVersion! } }), 'Included at your request', reload)}>Ask anyway</button>}
        </div>
      ))}
      {c.error && <div className="err-banner">{c.error}</div>}
    </div>
  );
}

const ROOT_LABEL: Record<string, string> = { COLLECT: 'Overdue follow-up', SLICE: 'Undisputed part', DISPUTED: 'Disputed amount', OFFER: 'Early-payment offer', PAYOUT: 'Supplier payout', ASK: 'Supplier ask' };

/** UX repair (F01): every revision in the history opens (the running one, a proposed draft, superseded or rejected ones). */
function Trail({ p, open, current }: { p: View; open: (id: string) => void; current: string | null }) {
  if (!p.trail.length) return null;
  return (
    <div className="box"><div className="box-h"><h3>Revisions · history</h3><a href="/overview">Activity ›</a></div>
      {p.trail.map((t) => (
        <div key={t.revisionId} className="box-b plan-row">
          <span><button className="linkbtn" aria-current={t.revisionId === current ? 'true' : undefined} onClick={() => open(t.revisionId)}><strong>Revision {t.n}</strong></button> · {t.trigger}<div className="small muted">{dateTime(t.at)}{t.approvedBy ? ` · approved by ${t.approvedBy}` : ''}</div></span>
          <span className="small">{t.revisionId === current ? `${t.status} · shown` : t.status}</span>
        </div>
      ))}
    </div>
  );
}

function ApproveDialog({ r, onClose, onDone }: { r: Rev; onClose: () => void; onDone: () => void }) {
  const c = useCommand();
  const k = r.approval!;
  const g = k.groups;
  return (
    <Dialog kicker={`Plan · revision ${r.n}`} title={k.mode === 'ACTIVATE' ? `Approve ${k.selected.length} actions` : `Approve ${k.selected.length} waiting action${k.selected.length === 1 ? '' : 's'} again`} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={c.busy || !!k.blocked} onClick={() => c.run((key) => call('approveRevision', { params: { id: r.revisionId }, ifMatch: r.version, idempotencyKey: key, body: { selected: k.selected, consentHash: k.consentHash } }), k.mode === 'ACTIVATE' ? `Revision ${r.n} is running. ${k.newPermissions.length} permissions recorded separately` : 'Approved again', onDone)}>Approve</button></>}>
      {k.blocked && <div className="err-banner">{k.blocked}</div>}
      {g.included.length > 0 && <div><h5>INCLUDED ACTIONS</h5>{g.included.map((x) => <div key={x.actionId} className="kv"><span>{x.title}</span><span className="small muted">{x.terms}</span></div>)}</div>}
      {g.conditional.length > 0 && <div><h5>CONDITIONAL</h5>{g.conditional.map((x) => <div key={x.actionId}><strong>{x.title}</strong><div className="small">{x.condition}</div></div>)}</div>}
      {g.exceptions.length > 0 && <div><h5>EXCEPTIONS TO YOUR DELEGATION</h5>{g.exceptions.map((x) => <div key={x.actionId}><strong>{x.title}</strong><div className="small" style={{ color: 'var(--amber)' }}>{x.reasons.join(' · ')}</div></div>)}</div>}
      {(g.alreadyDone.length > 0 || g.pendingBills.length > 0) && <div><h5>SUPPLIER TERMS AND BILLS</h5>{g.alreadyDone.map((x) => <div key={x.label + x.at} className="small">✓ {x.label} · already done by you {dateTime(x.at)}</div>)}{g.pendingBills.map((x) => <div key={x.billId} className="small" style={{ color: 'var(--amber)' }}>{x.label}</div>)}</div>}
      {g.removed.length > 0 && <div><h5>YOU REMOVED</h5>{g.removed.map((x) => <div key={x.actionId} className="small">{x.title}</div>)}</div>}
      {/* UX repair (S7 audit F03): each permission says why it is asked, the rule behind it, and what approving does now. */}
      <div className="what"><h5>YOUR APPROVALS ({k.newPermissions.length}{k.carried ? ` · ${k.carried} carried over unchanged` : ''})</h5>
        {k.newPermissions.map((x, i) => (
          <div key={x.actionId + x.kind} className="perm">
            <div><strong>{i + 1}. {x.title || x.scope}</strong> <span className="small muted">· {x.scope}</span></div>
            {x.why && <div className="small"><span className="muted">Why you're asked:</span> {x.why}</div>}
            {x.policy && <div className="small"><span className="muted">Rule:</span> {x.policy}</div>}
            {x.effect && <div className="small"><span className="muted">What approving does:</span> {x.effect}</div>}
          </div>
        ))}
        {!k.newPermissions.length && <div className="small">None: these run under your delegation.</div>}</div>
      <div className="what"><h5>SCOPE</h5>{k.scope}</div>
      {c.error && <div className="err-banner">{c.error} Close this and review the plan again.</div>}
    </Dialog>
  );
}

function RejectDialog({ r, running, onClose, onDone }: { r: Rev; running: boolean; onClose: () => void; onDone: () => void }) {
  const c = useCommand();
  const [reason, setReason] = useState('');
  return (
    <Dialog kicker={`Plan · revision ${r.n}`} title={`Reject revision ${r.n}`} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={c.busy} onClick={() => c.run((key) => call('rejectRevision', { params: { id: r.revisionId }, ifMatch: r.version, idempotencyKey: key, body: reason ? { reason } : {} }), `Revision ${r.n} rejected`, onDone)}>Reject</button></>}>
      <label className="field"><span>Reason (optional)</span><input value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} /></label>
      <div className="what"><h5>CONSEQUENCE</h5>Nothing in this draft runs. {running ? 'The running revision keeps going unchanged.' : 'No plan is running.'} You can build again later.</div>
      {c.error && <div className="err-banner">{c.error}</div>}
    </Dialog>
  );
}
