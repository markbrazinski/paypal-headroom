import { useCallback, useState } from 'react';
import type { ResponseOf } from '@headroom/contracts';
import { call } from '../api/client.ts';
import { Failed, Loading, Panel, Picker, Pill, Tag } from '../components.tsx';
import { useApp, useLoad } from '../data.ts';
import { ago, dateTime, money, range, shortDay, time } from '../format.ts';
import { BankActivity, BankBlock } from './bank.tsx';
import { Agenda, Calendar, Chart, ForecastTiles, NotInForecast, Timeline, type Ready } from './forecast.tsx';
import { BillPanel, ObligationPanel } from './bill-panel.tsx';

type Cash = ResponseOf<'getCashPosition'>;
type PP = Cash['sources'][0];

export function FreshnessPill({ pp }: { pp: PP }) {
  if (pp.refreshState === 'FAILED') return <Pill tone="red" glyph="✕">Couldn't reach PayPal</Pill>;
  if (pp.refreshState === 'STALE') return <Pill tone="amber" glyph="◔">PayPal report {ago(pp.asOf).replace(' ago', '')} old</Pill>;
  if (pp.refreshState === 'NEVER') return <Pill tone="grey" glyph="○">No PayPal report yet</Pill>;
  return <Pill tone="grey" glyph="◷">Report within 3 h · not live</Pill>;
}

/** Cash now breakdown (UI-OV-02 / UI-CA-01 per owner-accepted D-6): reported, estimated and reserve kept separate. */
export function CashBreakdown({ cash, onRefreshed }: { cash: Cash; onRefreshed: () => void }) {
  const { toast } = useApp();
  const [busy, setBusy] = useState(false);
  const pp = cash.sources[0];
  const refresh = async () => {
    setBusy(true);
    try { await call('refreshPayPalBalance'); toast('Reading PayPal balance. Figures update when PayPal answers.'); onRefreshed(); }
    catch (e) { toast((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <>
      <div className="sec">
        <h4>By account</h4>
        <BankBlock bank={cash.sources[1]} onChanged={onRefreshed} />
        <div className="kv" style={{ marginTop: 14 }}><span><strong>PayPal Business</strong><br /><span className="muted small">Reported available · as of {dateTime(pp.asOf)} · fetched {ago(pp.retrievedAt)}</span></span><span className="num">{pp.reportedAvailable ? money(pp.reportedAvailable) : 'Not reported'}</span></div>
        <div style={{ margin: '6px 0' }}><FreshnessPill pp={pp} /></div>
        {pp.refreshState === 'FAILED' && <div className="small neg">✕ {pp.lastError} · last good as of {dateTime(pp.asOf)}</div>}
        {pp.checksStopped && <div className="small" style={{ color: 'var(--amber)' }}>◔ {pp.checksStopped}</div>}
        <button className="btn" aria-label="Refresh PayPal" style={{ marginTop: 8 }} onClick={refresh} disabled={busy || !!pp.checksStopped} title={pp.checksStopped ?? undefined}>Refresh</button>
      </div>
      {/* Ledger straight after the accounts, opened by a double rule (design: Cash now − reserve = result); labels per IC-3. */}
      <div className="sec">
        <div className="ledger">
          {cash.totals.parts.bank && <>
            <div className="kv"><span>PayPal reported available</span><span className="num">{money(cash.totals.parts.paypal)}</span></div>
            <div className="kv"><span>Bank checking available (counted)</span><span className="num">{money(cash.totals.parts.bank)}</span></div>
          </>}
          <div className="kv strong"><span>Reported available{cash.totals.parts.bank ? ' (PayPal + checking)' : ''}</span><span className="num">{money(cash.totals.reportedAvailable)}</span></div>
          <div className="kv"><span>Your reserve (kept aside) · Delegation</span><span className="num">−{money(cash.reserve.amount)}</span></div>
          <div className="kv strong"><span>Reported available{cash.totals.parts.bank ? ' (PayPal + checking)' : ''} − reserve</span><span className={`num ${cash.ledger.vsReserve === 'BELOW' ? 'neg' : ''}`}>{money(cash.ledger.reportedMinusReserve)}</span></div>
        </div>
        <div className="small muted">{cash.ledger.vsReserve === 'UNKNOWN' ? 'Unknown until PayPal reports' : `${cash.ledger.vsReserve === 'ABOVE' ? 'Above' : 'Below'} reserve · PayPal as of ${dateTime(cash.ledger.asOf)}${cash.totals.parts.bank && cash.sources[1].state !== 'NOT_CONNECTED' ? ` · bank read ${dateTime(cash.sources[1].retrievedAt)}` : ''}`}</div>
        <div style={{ margin: '10px 0 4px' }}><Pill tone={cash.currentBadge.state === 'MET' ? 'green' : cash.currentBadge.state === 'NOT_MET' ? 'amber' : 'grey'} glyph={cash.currentBadge.state === 'MET' ? '✓' : '◷'}>{BADGE[cash.currentBadge.state]}</Pill></div>
        {cash.currentBadge.reasons.map((r) => <div key={r} className="small muted">· {r}</div>)}
      </div>
      {pp.estimate && (
        <div className="sec">
          <h4>Estimated now · not verified spendable</h4>
          <div className="kv"><span>Estimate range{cash.totals.parts.bank ? ' (PayPal estimate + bank checking)' : ''}</span><span className="num">{range(cash.totals.estimate?.lower, cash.totals.estimate?.upper)}</span></div>
          <div className="small muted">{cash.totals.parts.bank ? 'PayPal estimate plus bank checking. The bank has no estimate of its own; its transactions are never added.' : 'Headroom-known PayPal payments placed against PayPal\'s latest report.'}</div>
          {pp.estimate.summary.map((g) => (
            <div key={g.group} className={`kv small ${g.group === 'NOT_COUNTED' ? 'muted' : ''}`}><span>{g.label} · {g.count}</span><span className="num">{money(g.net)}</span></div>
          ))}
          {pp.estimate.notes.map((n) => <div key={n} className="small" style={{ color: 'var(--amber)' }}>‖ {n}</div>)}
          {pp.estimate.included.length + pp.estimate.excluded.length > 0 && (
            <details className="small" style={{ marginTop: 6 }}>
              <summary className="muted" style={{ cursor: 'pointer' }}>Show each payment</summary>
              {[...pp.estimate.included, ...pp.estimate.excluded].map((l) => <div key={l.key} className="kv small muted"><span>{l.reason}</span><span className="num">{money(l.net)}</span></div>)}
            </details>
          )}
        </div>
      )}
      {cash.sources[1].state !== 'NOT_CONNECTED' && <BankActivity bank={cash.sources[1]} />}
    </>
  );
}

type Bank = Cash['sources'][1];
const BADGE: Record<Cash['currentBadge']['state'], string> = { MET: 'Reserve met now (verified)', NOT_MET: 'Below your reserve now', NOT_VERIFIABLE: 'Reserve right now: can’t confirm yet (see why below)' };
const bankLine = (bank: Bank | undefined) => !bank || bank.state === 'NOT_CONNECTED' ? 'bank not connected' : bank.state === 'RECONNECT_REQUIRED' ? 'bank needs reconnecting' : !bank.contributes ? `bank ${bank.state === 'DISCONNECTING' ? 'removal pending' : bank.state === 'SYNCING' ? 'connecting' : bank.state === 'HEALTHY' ? 'history loading' : 'disconnected'} (not counted)` : `bank read ${time(bank.retrievedAt)}`;

type CashQuery = ReturnType<typeof useLoad<Cash>>;

/** The shared Cash now record panel. `openForecast` is false on the Cash route itself, where the button would do nothing. */
function CashNowPanelView({ q, onClose, openForecast = true }: { q: CashQuery; onClose: () => void; openForecast?: boolean }) {
  const { nav } = useApp();
  const pp = q.data?.sources[0];
  const t = q.data?.totals;
  return (
    <Panel kicker="Cash now" onClose={onClose} title={t?.reportedAvailable ? `${money(t.reportedAvailable)} reported${t.parts.bank ? ' · PayPal + bank checking' : ' by PayPal'}` : 'No reported figure yet'}
      status={pp && <div className="muted">PayPal as of {dateTime(pp.asOf)} · fetched {ago(pp.retrievedAt)} · {bankLine(q.data?.sources[1])}</div>}>
      {openForecast && <div className="sec"><button className="btn primary" onClick={() => nav('/cash')}>Open forecast</button></div>}
      {q.error ? <Failed error={q.error} /> : !q.data ? <Loading /> : <CashBreakdown cash={q.data} onRefreshed={q.reload} />}
    </Panel>
  );
}

export function CashNowPanel({ onClose }: { onClose: () => void }) {
  const q = useLoad(() => call('getCashPosition'));
  return <CashNowPanelView q={q} onClose={onClose} />;
}

type Tab = 'forecast' | 'scenarios';
type View = 'calendar' | 'timeline' | 'chart';
type Side = { kind: 'cash' } | { kind: 'bill'; id: string } | { kind: 'obligation'; key: string } | null;
// UX audit: the Analysis tab had nothing behind it, so it isn't offered (no inert tab on a filmed screen).
const TABS: [Tab, string][] = [['forecast', 'Forecast'], ['scenarios', 'Scenarios']];
const VIEWS: [View, string][] = [['calendar', 'Calendar'], ['timeline', 'Timeline'], ['chart', 'Chart']];
type Scenario = 'EXPECTED' | 'IDEAL' | 'DOWNSIDE';
const SCENARIOS: [Scenario, string][] = [['EXPECTED', 'Expected'], ['IDEAL', 'Ideal'], ['DOWNSIDE', 'Downside']];
const param = (k: string) => new URLSearchParams(location.search).get(k);
/** Keep ?day= and ?compare= in the address so a link (e.g. Overview's "See the calendar") lands on the same view. */
const setParam = (k: string, v: string | null) => { const u = new URL(location.href); if (v) u.searchParams.set(k, v); else u.searchParams.delete(k); history.replaceState(null, '', u); };

export function Cash() {
  const q = useLoad(() => call('getCashPosition'));
  const [scenario, setScenario] = useState<Scenario>((param('scenario') as Scenario) ?? 'EXPECTED');
  const fq = useLoad(() => call('getForecast', { query: scenario === 'EXPECTED' ? {} : { scenario } }), [scenario]);
  const [tab, setTab] = useState<Tab>('forecast');
  const [view, setView] = useState<View>('calendar');
  const [daySel, setDaySel] = useState<string | null>(param('day'));
  const [compare, setCompare] = useState<string | null>(param('compare'));
  // ponytail: the Cash now panel is open by default here; the bank and PayPal account controls have no other designed home on Cash (matrix (e)).
  const [side, setSide] = useState<Side>({ kind: 'cash' });
  const c = q.data;
  const f = fq.data?.state === 'READY' ? fq.data : null;
  const cmp = f && compare ? f.comparisons.find((x) => x.id === compare) ?? null : null;
  const sel = f ? (daySel && f.days.some((d) => d.on === daySel) ? daySel : f.days[0].on) : null;
  const pickDay = useCallback((on: string) => { setDaySel(on); setParam('day', on); }, []);
  const stopCompare = () => { setCompare(null); setParam('compare', null); };
  const openItem = (i: { ref: { kind: string; id: string } }) => setSide(i.ref.kind === 'BILL' ? { kind: 'bill', id: i.ref.id.replace(/^bill:/, '') } : { kind: 'obligation', key: i.ref.id });
  const lp = c?.lowestPoint;
  return (
    <div className={`layout ${side ? 'with-panel' : ''}`}>
      <div className="page">
        <h1>Cash</h1>
        <div className="tabs" role="tablist">
          {TABS.map(([k, label]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{label}</button>)}
        </div>
        {tab === 'scenarios' ? <Scenarios f={f} onCompare={(id) => { setCompare(id); setParam('compare', id); setTab('forecast'); setView('calendar'); }} /> : q.error ? <Failed error={q.error} /> : !c || !lp || !fq.data ? <Loading /> : (
          <>
            <div className="viewbar">
              <div className="seg" role="group" aria-label="Forecast view">
                {VIEWS.map(([k, label]) => <button key={k} className={view === k ? 'on' : ''} aria-pressed={view === k} onClick={() => setView(k)}>{label}</button>)}
              </div>
              <span className="muted">Next 6 weeks · {shortDay(c.horizon.from)} – {shortDay(c.horizon.to)}{f ? ' · projected end-of-day closing balances' : ''}</span>
              {/* UI-PL-04: each scenario is a named basis; there is no likelihood figure. */}
              <div className="seg" role="group" aria-label="Scenario">
                {SCENARIOS.map(([k, label]) => <button key={k} className={scenario === k ? 'on' : ''} aria-pressed={scenario === k} onClick={() => { setScenario(k); setParam('scenario', k === 'EXPECTED' ? null : k); }}>{label}</button>)}
              </div>
            </div>
            {f && <div className="small muted" style={{ margin: '4px 0' }}>{f.scenarioBasis}</div>}
            {f && f.comparisons.length > 0 && (
              // UX audit: one compact selector instead of a strip of long proposal columns; each option's reason shows on the comparing line.
              <Picker label="Compare with" value={compare ?? ''} onChange={(v) => { if (v) { setCompare(v); setParam('compare', v); } else stopCompare(); }}
                options={[{ value: '', label: 'Nothing' }, ...f.comparisons.map((x) => ({ value: x.id, label: x.kind === 'BEFORE_BILL' ? 'Before the bill' : x.label.replace('Headroom proposal: ', 'Proposal: '), hint: x.reason }))]} />
            )}
            {compare && (cmp
              ? <div className="comparing">Comparing: <strong>{cmp.label}</strong> · built by Headroom · {cmp.reason}. The forecast itself is unchanged. <button className="linkbtn" onClick={stopCompare}>Stop comparing</button></div>
              : <div className="comparing">That comparison is no longer available (the bill was decided or changed). <button className="linkbtn" onClick={stopCompare}>Dismiss</button></div>)}
            <div className="strip compact">
              <button className={`tile ${side?.kind === 'cash' ? 'on' : ''}`} onClick={() => setSide({ kind: 'cash' })} aria-expanded={side?.kind === 'cash'}>
                <div className="label">Cash now <span className="q" title="PayPal's reported available balance at its as-of time plus counted bank checking at its read time. Not a live balance.">?</span></div>
                {c.totals.reportedAvailable ? <div className="fig">{money(c.totals.reportedAvailable)}</div> : <div className="fig none">Not reported yet</div>}
                <div className="sub">PayPal as of {c.sources[0].asOf ? time(c.sources[0].asOf) : 'unknown'} · {bankLine(c.sources[1])}</div>
                {/* Progressive disclosure: when PayPal's report is old, the estimate is the figure to read; the reported one stays as reported. */}
                {c.sources[0].refreshState === 'STALE' && c.totals.estimate && <div className="sub" style={{ color: 'var(--amber)' }}>PayPal report {ago(c.sources[0].asOf).replace(' ago', '')} old · estimated now {range(c.totals.estimate.lower, c.totals.estimate.upper)}</div>}
                {cmp && <div className="sub cmp">Compared: unchanged</div>}
              </button>
              {f ? <ForecastTiles f={f} cmp={cmp} /> : (
                <>
                  <div className="tile"><div className="label">Lowest point</div><div className="fig none">No forecast yet</div><div className="sub">{lp.label}</div></div>
                  <div className="tile"><div className="label">First time below reserve</div><div className="fig none">No forecast yet</div><div className="sub">Needs a PayPal report</div></div>
                  <div className="tile"><div className="label">Reserve gap</div><div className="fig none">No forecast yet</div><div className="sub">Needs a PayPal report</div></div>
                </>
              )}
            </div>
            <div className="reserve-line muted">Your reserve is {money(c.reserve.amount)} (your Delegation rule): the amount Headroom keeps aside. <a href="/delegation#cash.reserveMinor">Change in Delegation ›</a>{f && <> · <span title={f.basis}>Basis: {f.basis}</span></>}</div>
            {fq.error ? <Failed error={fq.error} /> : !f ? (
              <div className="notbuilt">No forecast yet: {fq.data.state === 'NO_OPENING' ? fq.data.reason : ''}. Headroom needs PayPal's reported balance to start the 42-day forecast; nothing is guessed.</div>
            ) : view === 'calendar' ? (
              <><Calendar f={f} sel={sel!} onSelect={pickDay} cmp={cmp} /><Agenda f={f} on={sel!} onOpen={openItem} /></>
            ) : view === 'timeline' ? <Timeline f={f} onSelect={(on) => { pickDay(on); setView('calendar'); }} onOpen={openItem} />
              : <><Chart f={f} onSelect={pickDay} cmp={cmp} /><Agenda f={f} on={sel!} onOpen={openItem} /></>}
            <NotInForecast rows={fq.data.notInForecast} onOpenBill={(id) => setSide({ kind: 'bill', id })} />
          </>
        )}
      </div>
      {side?.kind === 'cash' && <CashNowPanelView q={q} onClose={() => setSide(null)} openForecast={false} />}
      {side?.kind === 'bill' && <BillPanel key={side.id} id={side.id} onClose={() => setSide({ kind: 'cash' })} />}
      {side?.kind === 'obligation' && <ObligationPanel key={side.key} occurrenceKey={side.key} onClose={() => setSide({ kind: 'cash' })} onBill={(id) => setSide({ kind: 'bill', id })} />}
    </div>
  );
}

/** UI-CA-11: each scenario and comparison as a row; Compare overlays it on the calendar. Records are unchanged. */
function Scenarios({ f, onCompare }: { f: Ready | null; onCompare: (id: string) => void }) {
  const ideal = useLoad(() => call('getForecast', { query: { scenario: 'IDEAL' } }));
  const down = useLoad(() => call('getForecast', { query: { scenario: 'DOWNSIDE' } }));
  if (!f) return <div className="notbuilt">No forecast yet: Headroom needs PayPal's reported balance first.</div>;
  const rows = [
    { key: 'EXPECTED', label: 'Expected', by: 'Your records', s: f.summary, linked: '—', basis: f.scenarioBasis, id: null as string | null },
    ...[ideal.data, down.data].flatMap((x) => (x?.state === 'READY' ? [{ key: x.scenario, label: x.scenario === 'IDEAL' ? 'Ideal' : 'Downside', by: 'Headroom', s: x.summary, linked: '—', basis: x.scenarioBasis, id: null }] : [])),
    ...f.comparisons.map((x) => ({ key: x.id, label: x.label, by: 'Headroom', s: x.summary, linked: x.linked ? `${x.linked.label} · ${x.linked.status}` : x.kind === 'BILL' ? 'Bill not decided' : '—', basis: x.reason, id: x.id })),
  ];
  return (
    <table className="ledger plan-outlook">
      <thead><tr><th>Scenario</th><th>Built by</th><th className="num">Lowest</th><th>First below reserve</th><th>Linked work</th><th /></tr></thead>
      <tbody>{rows.map((r) => (
        <tr key={r.key}>
          <td><strong>{r.label}</strong><div className="small muted">{r.basis}</div></td><td>{r.by}</td>
          <td className={`num ${r.s.low.minor < 0 ? 'neg' : ''}`}>{money(r.s.low)} <span className="small muted">{shortDay(r.s.lowOn)}</span></td>
          <td>{r.s.firstBelowReserve ? shortDay(r.s.firstBelowReserve) : 'Never in 6 weeks'}</td><td className="small">{r.linked}</td>
          <td>{r.id && <button className="btn" onClick={() => onCompare(r.id!)}>Compare</button>}</td>
        </tr>
      ))}</tbody>
    </table>
  );
}
