import { useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import type { ActivityRow, ResponseOf } from '@headroom/contracts';
import { call } from '../api/client.ts';
import { Failed, gridTheme, Loading } from '../components.tsx';
import { useApp, useLoad } from '../data.ts';
import { ago, dateTime, day, money, range, shortDay, time } from '../format.ts';
import { CashNowPanel } from './cash.tsx';

export function ActivityGrid({ rows, height = 420 }: { rows: ActivityRow[]; height?: number }) {
  return (
    <div style={{ height }}>
      <AgGridReact<ActivityRow> theme={gridTheme} rowData={rows} getRowId={(p) => p.data.eventId}
        columnDefs={[
          { field: 'when', headerName: 'When', width: 170, valueFormatter: (p) => dateTime(p.value) },
          { field: 'event', headerName: 'Event', flex: 1.2 },
          { field: 'by', headerName: 'By', width: 110 },
          { field: 'allowedBy', headerName: 'Allowed by', flex: 1, valueFormatter: (p) => p.value ?? '—' },
          { field: 'result', headerName: 'Result', flex: 2, tooltipField: 'result' },
          // Raw provider and record ids stay inspectable without cluttering the record (UX audit F08).
          { headerName: 'Details', width: 90, valueGetter: (p) => (p.data && Object.keys(p.data.refs).length ? 'ids ⓘ' : ''), tooltipValueGetter: (p) => (p.data ? Object.entries(p.data.refs).map(([k, v]) => `${k}: ${v}`).join('\n') : '') },
        ]} />
    </div>
  );
}

type CashNowBank = ResponseOf<'getOverview'>['cashNow']['bank'];
/** "bank read 4:58 AM": our fetch time, labelled "read", never "as of" (S2-D4). */
const bankHead = (b: CashNowBank) =>
  b.state === 'NOT_CONNECTED' ? 'bank not connected' : b.state === 'RECONNECT_REQUIRED' ? 'bank needs reconnecting'
    : !b.contributes ? (b.state === 'SYNCING' ? 'bank connecting' : b.state === 'DISCONNECTING' ? 'bank removal pending' : 'bank not counted')
    : `bank read ${time(b.retrievedAt)}`;

export function Overview() {
  const { nav } = useApp();
  const [tab, setTab] = useState<'summary' | 'activity'>('summary');
  const [panel, setPanel] = useState(false);
  const q = useLoad(() => call('getOverview'));
  const act = useLoad(() => (tab === 'activity' ? call('getActivity') : Promise.resolve(null)), [tab]);
  const o = q.data;
  const lp = o?.lowestPoint;
  return (
    <div className={`layout ${panel ? 'with-panel' : ''}`}>
      <div className="page">
        <h1>Overview</h1>
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'summary'} className={tab === 'summary' ? 'on' : ''} onClick={() => setTab('summary')}>Summary</button>
          <button role="tab" aria-selected={tab === 'activity'} className={tab === 'activity' ? 'on' : ''} onClick={() => setTab('activity')}>Activity</button>
        </div>
        {q.error ? <Failed error={q.error} /> : !o ? <Loading /> : tab === 'activity' ? (
          act.data ? <ActivityGrid rows={act.data.rows} height={560} /> : <Loading />
        ) : (
          <>
            <div className="strip-head">
              <span>Your cash · PayPal as of {o.cashNow.asOf ? time(o.cashNow.asOf) : 'unknown'} · {bankHead(o.cashNow.bank)}</span>
              <span>Next 6 weeks · {shortDay(o.horizon.from)} – {shortDay(o.horizon.to)}</span>
            </div>
            <div className="strip">
              <button className={`tile ${panel ? 'on' : ''}`} onClick={() => setPanel(true)} aria-expanded={panel}>
                <div className="label">Cash now <span className="q" title="PayPal's reported available balance at its as-of time plus counted bank checking at its read time. Not a live balance.">?</span></div>
                {o.cashNow.reportedAvailable ? <div className="fig">{money(o.cashNow.reportedAvailable)}</div> : <div className="fig none">Not reported yet</div>}
                <div className="sub">PayPal as of {o.cashNow.asOf ? time(o.cashNow.asOf) : 'unknown'} · {bankHead(o.cashNow.bank)}</div>
                {o.cashNow.estimate && <div className="sub">Est. now {range(o.cashNow.estimate.lower, o.cashNow.estimate.upper)} · not verified spendable</div>}
                {o.cashNow.refreshState === 'STALE' && <div className="sub" style={{ color: 'var(--amber)' }}>◔ PayPal report {ago(o.cashNow.asOf).replace(' ago', '')} old</div>}
                {o.cashNow.refreshState === 'FAILED' && <div className="sub neg">✕ Couldn't reach PayPal · last good as of {time(o.cashNow.asOf)}</div>}
                {o.cashNow.bank.state === 'RECONNECT_REQUIRED' ? <div className="sub neg">✕ Bank needs reconnecting</div>
                  : o.cashNow.bank.freshness === 'FAILED' ? <div className="sub neg">✕ Couldn't reach the bank · last read {time(o.cashNow.bank.retrievedAt)}</div>
                  : o.cashNow.bank.freshness === 'STALE' && o.cashNow.bank.contributes ? <div className="sub" style={{ color: 'var(--amber)' }}>◔ Bank read {ago(o.cashNow.bank.retrievedAt)}</div>
                  : o.cashNow.bank.notCounted.length ? <div className="sub">{o.cashNow.bank.notCounted[0]} · not counted</div> : null}
              </button>
              <button className="tile" onClick={() => nav('/receivables')}>
                <div className="label">Owed to you <span className="q" title="Open amount on invoices issued on PayPal">?</span></div>
                <div className="fig">{money(o.owedToYou.sum)}</div>
                <div className="sub">{o.owedToYou.count} payment{o.owedToYou.count === 1 ? '' : 's'} expected · {o.owedToYou.undatedCount} not yet dated</div>
              </button>
              <button className="tile" onClick={() => nav('/payables')}>
                <div className="label">Bills due <span className="q" title="Scheduled outflows in the next 6 weeks: commitments and bills you accepted. Excludes bills not yet accepted.">?</span></div>
                <div className="fig">{money(o.billsDue.sum)}</div>
                <div className="sub">{o.billsDue.count} bill{o.billsDue.count === 1 ? '' : 's'} and planned payments · excludes bills not yet accepted</div>
              </button>
              <button className="tile" onClick={() => nav('/cash')}>
                <div className="label">Lowest point <span className="q" title={lp?.basis}>?</span></div>
                {lp?.low ? <div className={`fig ${lp.vsReserve === 'BELOW' ? 'neg' : ''}`}>{money(lp.low)}</div> : <div className="fig none">Unknown</div>}
                <div className="sub">{lp?.on ? `${shortDay(lp.on)} · ` : ''}{lp?.vsReserve === 'ABOVE' ? '✓ Forecast above reserve under stated assumptions' : lp?.vsReserve === 'BELOW' ? '▽ Forecast below reserve under stated assumptions' : 'waiting for PayPal'}</div>
              </button>
            </div>
            {o.safetyNotices.map((n) => <div key={n.key} className="statusline warn notice-safety" role="status">{n.text}{n.since ? ` · since ${day(n.since.slice(0, 10))}` : ''} · <a href={`/delegation#${n.key}`}>Review in Delegation ›</a></div>)}
            {o.alert ? <AlertBox a={o.alert} /> : <div className={`statusline ${lp?.vsReserve === 'ABOVE' ? 'ok' : 'warn'}`}>
              <span>{lp?.vsReserve === 'ABOVE' ? '✓ ' : lp?.vsReserve === 'BELOW' ? '▽ ' : ''}{o.statusLine}</span>
              <a href="/cash" onClick={(e) => { e.preventDefault(); nav('/cash'); }}>See forecast ›</a>
            </div>}
            {/* UI-OV-09: the running or draft revision, as a real link; hidden while there is no plan. */}
            {o.plan && (
              <a className="box plan-card" href="/plan" onClick={(e) => { e.preventDefault(); nav('/plan'); }}>
                <div className="box-h"><h3>Cash plan · revision {o.plan.revisionN}</h3><span className="pill p-grey">{o.plan.pill}</span></div>
                <div className="rows">{o.plan.steps.map((st, i) => <div key={i} className="r"><span>{i + 1}. {st.title}</span><span className="muted small">{st.mode}</span><span className="small">{st.state}</span></div>)}</div>
              </a>
            )}
            <div className="two">
              <Needs needs={o.needs} above={o.alert && o.plan?.state === 'DRAFT' ? o.alert.cta.label : null} />
              <div className="box">
                <div className="box-h"><h3>In progress</h3><span className="muted small">No action needed</span></div>
                <div className="rows">
                  <div className="r"><span className="muted">Collecting</span><span>{o.inProgress.collecting.count} open invoice{o.inProgress.collecting.count === 1 ? '' : 's'} on PayPal · checked automatically</span><span className="num">{money(o.inProgress.collecting.sum)} open</span></div>
                  <div className="r"><span className="muted">Customers</span><span><a href="/inbox" onClick={(e) => { e.preventDefault(); nav('/inbox'); }}>Messages and replies · Inbox ›</a></span><span /></div>
                  <div className="r"><span className="muted">Matching</span><span><a href="/receivables" onClick={(e) => { e.preventDefault(); nav('/receivables'); }}>Bank lines and PayPal transfers · Receivables › Reconciliation</a></span><span /></div>
                  <div className="r"><span className="muted">Paying</span><span><a href="/payables" onClick={(e) => { e.preventDefault(); nav('/payables'); }}>Bills and supplier payouts · Payables ›</a></span><span /></div>
                  <div className="r"><span className="muted">Suppliers</span><span><a href="/relationships" onClick={(e) => { e.preventDefault(); nav('/relationships'); }}>Who you pay and how · Customers &amp; Suppliers ›</a></span><span /></div>
                  <div className="r" style={{ gridTemplateColumns: '1fr' }}><a href="#" onClick={(e) => { e.preventDefault(); setTab('activity'); }}>See what Headroom did · Activity ›</a></div>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
      {panel && <CashNowPanel onClose={() => setPanel(false)} />}
    </div>
  );
}


type Ov = ResponseOf<'getOverview'>;

/** UI-OV-08: the server's alert, with its impact trio and one action. */
function AlertBox({ a }: { a: NonNullable<Ov['alert']> }) {
  const { nav } = useApp();
  const to = a.cta.to;
  const go = () => nav(to.kind === 'BILL' ? `/payables?bill=${to.billId}` : to.kind === 'PLAN' ? '/plan' : `/cash?day=${to.on}`);
  const i = a.impact;
  return (
    // Owner, 3 Nov 2026: a new alert eases in (CSS `alert-in`; none under reduced motion) instead of popping in.
    <div className="alert alert-in" key={a.headline} role="region" aria-label="Needs you">
      <div className="alert-b">
        <div><span className="pill p-amber">! Needs you</span> <span className="muted small">{a.kicker}</span></div>
        <div className="alert-h serif">{a.headline}</div>
        <div className="alert-body">{a.body}</div>
        <button className="btn primary alert-cta" onClick={go}>{a.cta.label}</button>
      </div>
      {i.state === 'KNOWN' ? (
        <div className="trio">
          <div><div className="muted small">Cash now</div><div className="v">{money(i.cashNow)}</div><div className="small muted">unchanged</div></div>
          <div><div className="muted small">{a.kind === 'BILL_TERMS_DIFFER' ? 'Lowest point with this bill' : 'Lowest point'}</div><div className={`v ${i.low.minor < 0 ? 'neg' : ''}`}>{money(i.low)}</div><div className="small muted">{shortDay(i.lowOn)}</div></div>
          <div><div className="muted small">{a.kind === 'BILL_TERMS_DIFFER' ? 'Needed to stay above reserve' : 'Reserve gap'}</div><div className="v gap">{money(i.needed)}</div><div className="small muted">at the low point</div></div>
        </div>
      ) : <div className="trio"><div className="small" style={{ color: 'var(--amber)' }}>Cash impact unknown: {i.reason}</div></div>}
    </div>
  );
}

const needHref = (to: Ov['needs'][number]['action']['to']) => (to.kind === 'BILL' ? `/payables?bill=${to.billId}` : to.kind === 'INVOICE' ? `/receivables?invoice=${encodeURIComponent(to.invoiceId)}` : to.kind === 'PAYOUT' ? `/payables?payout=${encodeURIComponent(to.occurrenceKey)}` : to.kind === 'GRANT' ? '/delegation?tab=approved' : to.kind === 'INBOX' ? '/inbox' : '/plan');

/** UI-OV-10: decisions waiting on the owner, ranked by deadline then amount. */
/** `above`: the alert above already carries the one decision (e.g. "Open your plan"), so an empty list points to it instead of "nothing". */
function Needs({ needs, above }: { needs: Ov['needs']; above: string | null }) {
  const { nav } = useApp();
  const [all, setAll] = useState(false);
  const shown = all ? needs : needs.slice(0, 3);
  return (
    <div className="box needs" style={{ borderColor: 'var(--ink)' }}>
      <div className="box-h"><h3>Needs your decision {needs.length > 0 && <span className="waiting">{needs.length} waiting on you</span>}</h3>{needs.length > 3 && <button className="linkbtn" onClick={() => setAll((x) => !x)}>{all ? 'Show fewer' : 'View all'}</button>}</div>
      {needs.length === 0 ? (above ? <div className="box-b">One decision, above: <strong>{above}</strong></div> : <div className="box-b" style={{ color: 'var(--green)' }}>✓ Nothing needs you</div>) : shown.map((n, i) => (
        <div key={n.key} className="need">
          <span className="muted">{i + 1}</span>
          <span><strong>{n.title}</strong><br /><span className="small">{n.reason}</span><br /><span className="small muted">{n.where}</span></span>
          <span className="need-r"><span className="num">{n.amount ? money(n.amount) : ''}</span>{n.deadline && <span className="small" style={{ color: 'var(--amber)' }}>{shortDay(n.deadline)}</span>}</span>
          <button className="btn primary" onClick={() => nav(needHref(n.action.to))}>{n.action.label}</button>
        </div>
      ))}
    </div>
  );
}
