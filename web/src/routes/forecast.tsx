// Cash › Forecast views (UI-CA-03…07, 09): Calendar, Timeline and Chart over the server's 42 daily closes. The UI renders the
// DTO; it never adds up cash. A comparison (D-COMPARE) is an overlay from the server, never a change to the forecast.
import { Component, useMemo, type ReactNode } from 'react';
import { AgCharts } from 'ag-charts-react';
import type { AgCartesianChartOptions } from 'ag-charts-community';
import type { ResponseOf } from '@headroom/contracts';
import { Pill } from '../components.tsx';
import { day, money, shortDay } from '../format.ts';

export type Ready = Extract<ResponseOf<'getForecast'>, { state: 'READY' }>;
type Day = Ready['days'][number];
type Item = Day['items'][number];
type Cmp = Ready['comparisons'][number];

const STATE: Record<Day['state'], { glyph: string; label: string; tone: 'green' | 'slate' | 'amber' | 'red' }> = {
  ABOVE: { glyph: '✓', label: 'Above', tone: 'green' }, AT: { glyph: '=', label: 'At reserve', tone: 'slate' },
  BELOW: { glyph: '▽', label: 'Below', tone: 'amber' }, NEGATIVE: { glyph: '✕', label: 'Negative', tone: 'red' },
};
export const StatePill = ({ s }: { s: Day['state'] }) => <Pill tone={STATE[s].tone} glyph={STATE[s].glyph}>{STATE[s].label}</Pill>;
/** "12.0k" / "−6.0k": the calendar's compact figure (exact values are in the title and aria-label). */
const k = (m: { minor: number }) => `${m.minor < 0 ? '−' : ''}${(Math.abs(m.minor) / 100_000).toFixed(1)}k`;
const signedMoney = (m: { currency: 'USD'; minor: number }, dir: 'IN' | 'OUT') => `${dir === 'OUT' ? '−' : '+'}${money(m)}`;
const BASIS_TAG: Record<Item['basis'], string> = { COMMITMENT: 'Commitment', BILL: 'Bill', STATED: 'Stated', PAST_DUE: 'Past due', TARGET: 'Target · not agreed', PROMISE: 'Promise · not a receipt' };
const active = (d: Day, i: number) => i === 0 || d.items.length > 0;
const dayNum = (on: string, first: boolean) => (first || on.endsWith('-01') ? shortDay(on) : String(Number(on.slice(8))));

export function ForecastTiles({ f, cmp }: { f: Ready; cmp: Cmp | null }) {
  const s = f.summary;
  const c = cmp?.summary;
  return (
    <>
      <div className="tile">
        <div className="label">Lowest point <span className="q" title={f.basis}>?</span></div>
        <div className={`fig ${s.low.minor < f.reserve.minor ? 'neg' : ''}`}>{money(s.low)} · {shortDay(s.lowOn)}</div>
        <div className="sub">{s.negativeDays} negative · {s.atReserveDays} at reserve</div>
        {c && <div className="sub cmp">Compared: {money(c.low)} · {shortDay(c.lowOn)}</div>}
      </div>
      <div className="tile">
        <div className="label">First time below reserve <span className="q" title="The first day the projected close is under your reserve">?</span></div>
        {s.firstBelowReserve ? <div className="fig neg">{day(s.firstBelowReserve)}</div> : <div className="fig">Not in the next 6 weeks</div>}
        <div className="sub">{s.firstBelowReserve ? `${s.belowReserveDays} day${s.belowReserveDays === 1 ? '' : 's'} below reserve` : `✓ above through ${shortDay(f.horizon.to)}`}</div>
        {c && <div className="sub cmp">Compared: {c.firstBelowReserve ? day(c.firstBelowReserve) : 'none in period'}</div>}
      </div>
      <div className="tile">
        <div className="label">Reserve gap <span className="q" title="How far the lowest point is below your reserve. The funding deficit is how far it is below zero.">?</span></div>
        <div className={`fig ${s.reserveGap.minor ? 'gap' : ''}`}>{money(s.reserveGap)}</div>
        <div className="sub">Balance at low {money(s.low)} · funding deficit {money(s.fundingDeficit)}</div>
        {c && <div className="sub cmp">Compared: {money(c.reserveGap)} · deficit {money(c.fundingDeficit)}</div>}
      </div>
    </>
  );
}

/** UI-CA-05: Monday-to-Sunday weeks covering all 42 dates: 6 rows when day 0 is a Monday, 7 otherwise (C1). */
export function Calendar({ f, sel, onSelect, cmp }: { f: Ready; sel: string; onSelect: (on: string) => void; cmp: Cmp | null }) {
  const lead = (new Date(`${f.days[0].on}T00:00:00Z`).getUTCDay() + 6) % 7; // Monday = 0
  const cells: (Day | null)[] = [...Array(lead).fill(null), ...f.days];
  while (cells.length % 7) cells.push(null);
  const cmpOf = new Map(cmp?.closes.map((c) => [c.on, c.close]) ?? []);
  return (
    <div className="cal" role="grid" aria-label="Forecast calendar">
      {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((w) => <div key={w} className="cal-h" role="columnheader">{w}</div>)}
      {cells.map((d, i) => {
        if (!d) return <div key={`x${i}`} className="cell blank" aria-hidden />;
        const idx = f.days.indexOf(d);
        const show = active(d, idx);
        const ins = d.items.filter((x) => x.direction === 'IN');
        const outs = d.items.filter((x) => x.direction === 'OUT');
        const label = `${day(d.on)} · projected close ${money(d.close)} · ${STATE[d.state].label.toLowerCase()}${ins.length ? ` · in ${money(d.in)}` : ''}${outs.length ? ` · out ${money(d.out)}` : ''}${d.sameDay ? ' · same-day timing' : ''}`;
        return (
          <button key={d.on} role="gridcell" className={`cell s-${d.state} ${show ? 'active' : 'quiet'} ${sel === d.on ? 'sel' : ''}`} title={label} aria-label={label} aria-selected={sel === d.on} onClick={() => onSelect(d.on)} data-day={d.on}>
            <span className="cell-top"><span>{dayNum(d.on, idx === 0)}{idx === 0 ? ' today' : ''}</span>{show && <span className={`st t-${STATE[d.state].tone}`}>{STATE[d.state].glyph} {STATE[d.state].label}</span>}</span>
            {show && <span className="cell-fig">{k(d.close)}{d.sameDay && <span title="Money in and out on the same day: covering it depends on timing" aria-hidden> ◆</span>}</span>}
            {show && (ins.length || outs.length) ? <span className="cell-sub">{ins.length ? `▲${ins.length} ${k(d.in)}` : ''}{ins.length && outs.length ? ' · ' : ''}{outs.length ? `▼${outs.length} −${k(d.out)}` : ''}</span> : null}
            {cmpOf.has(d.on) && cmpOf.get(d.on)!.minor !== d.close.minor && <span className="cell-cmp">Compared: {k(cmpOf.get(d.on)!)}</span>}
          </button>
        );
      })}
    </div>
  );
}

/** Timeline: active days only, quiet stretches collapsed ("N quiet days · balance holds at $x"). */
export function Timeline({ f, onSelect, onOpen }: { f: Ready; onSelect: (on: string) => void; onOpen: (i: Item) => void }) {
  const out: ReactNode[] = [];
  let quiet = 0;
  const flush = (bal: Day['close'], last: boolean) => { if (quiet) out.push(<div key={`q${out.length}`} className="tl-gap">{quiet} quiet day{quiet === 1 ? '' : 's'}{last ? ` to ${shortDay(f.horizon.to)}` : ` · balance holds at ${money(bal)}`}</div>); quiet = 0; };
  f.days.forEach((d, i) => {
    if (!active(d, i)) { quiet++; if (i === f.days.length - 1) flush(d.close, true); return; }
    flush(f.days[i - 1]?.close ?? d.close, false);
    out.push(
      <div key={d.on} className="tl-day">
        <button className="linkbtn tl-date" onClick={() => onSelect(d.on)}><strong>{day(d.on)}</strong><br /><span className="muted small">{i === 0 ? 'Today' : `in ${i} day${i === 1 ? '' : 's'}`}</span></button>
        <div className="tl-items">
          {d.items.length === 0 && <span className="muted">Starting balance · nothing moves today</span>}
          {d.items.map((x) => (
            <div key={x.key} className="tl-item">
              <span className={x.direction === 'IN' ? 'up' : 'down'} aria-hidden>{x.direction === 'IN' ? '▲' : '▼'}</span>
              <span>{x.ref.kind === 'INFLOW' ? x.label : <button className="linkbtn plain" onClick={() => onOpen(x)}>{x.label}</button>}{x.note ? <span className="muted small"> · {x.note}</span> : null}</span>
              <span className="btag">{BASIS_TAG[x.basis]}</span>
              <span className="num amt">{signedMoney(x.feeEstimate ? { currency: 'USD', minor: x.amount.minor + x.feeEstimate.minor } : x.amount, x.direction)}</span>
            </div>
          ))}
        </div>
        <div className="tl-close"><span className="muted small">Closing balance</span><span className={`num big ${d.close.minor <= 0 ? 'neg' : ''}`}>{money(d.close)}{d.sameDay ? ' ◆' : ''}</span><StatePill s={d.state} /></div>
      </div>,
    );
  });
  return <div className="tl">{out}</div>;
}

class ChartBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <div className="err-banner">Chart failed to load. The timeline shows the same data.</div> : this.props.children; }
}

/** UI-CA-07: AG Charts Community. Bars in (+) and out (−), the balance line, the reserve band 0–reserve, a dashed comparison. */
export function Chart({ f, onSelect, cmp }: { f: Ready; onSelect: (on: string) => void; cmp: Cmp | null }) {
  const options = useMemo<AgCartesianChartOptions>(() => {
    const cmpOf = new Map(cmp?.closes.map((c) => [c.on, c.close.minor / 100]) ?? []);
    const data = f.days.map((d) => ({ on: d.on, label: shortDay(d.on), in: d.in.minor / 100, out: -d.out.minor / 100, close: d.close.minor / 100, ...(cmp ? { cmp: cmpOf.get(d.on) } : {}) }));
    const pick = (e: { datum: { on: string } }) => onSelect(e.datum.on);
    return {
      data, height: 380, background: { fill: '#FFFDF8' },
      series: [
        { type: 'bar', xKey: 'label', yKey: 'in', yName: 'Money in', fill: '#7FA391', stacked: true, listeners: { nodeClick: pick } },
        { type: 'bar', xKey: 'label', yKey: 'out', yName: 'Money out', fill: '#D99A8C', stacked: true, listeners: { nodeClick: pick } },
        // nodeClickRange 'nearest': a click anywhere on the plot picks the nearest day (the line has no markers to hit).
        { type: 'line', xKey: 'label', yKey: 'close', yName: 'Balance', stroke: '#1B211E', strokeWidth: 2, marker: { enabled: false }, nodeClickRange: 'nearest', listeners: { nodeClick: pick } },
        ...(cmp ? [{ type: 'line' as const, xKey: 'label', yKey: 'cmp', yName: cmp.label, stroke: '#3E5A7A', strokeWidth: 2, lineDash: [6, 4], marker: { enabled: false } }] : []),
      ],
      axes: [
        { type: 'category', position: 'bottom', label: { rotation: -35, fontSize: 10 } },
        { type: 'number', position: 'left', label: { formatter: (p: { value: number }) => `${(p.value / 1000).toFixed(1)}k` },
          crossLines: [
            { type: 'range', range: [0, f.reserve.minor / 100], fill: '#F8E9D2', fillOpacity: 0.7, strokeWidth: 0, label: { text: `Reserve ${money(f.reserve)}`, position: 'inside-top-left', color: '#8A4B08', fontSize: 11 } },
            { type: 'line', value: 0, stroke: '#A23B2A', strokeWidth: 1 },
          ] },
      ],
      legend: { position: 'bottom' },
    };
  }, [f, cmp, onSelect]);
  return (
    <div className="box chartbox">
      <ChartBoundary><AgCharts options={options} /></ChartBoundary>
      <div className="small muted" style={{ padding: '0 18px 14px' }}>Bars show money in (up) and out (down) each day; the line is your projected balance; the shaded band is your reserve. Click a bar or the line to see that day.</div>
    </div>
  );
}

/** UI-CA-06: the selected day's ledger. */
export function Agenda({ f, on, onOpen }: { f: Ready; on: string; onOpen: (i: Item) => void }) {
  const i = Math.max(0, f.days.findIndex((d) => d.on === on));
  const d = f.days[i];
  const ins = d.items.filter((x) => x.direction === 'IN');
  const outs = d.items.filter((x) => x.direction === 'OUT');
  const diff = d.close.minor - f.reserve.minor;
  return (
    <div className="box agenda" aria-label={`Day ${day(d.on)}`}>
      <div className="ag-h"><strong>{day(d.on)}</strong> · <StatePill s={d.state} />{d.sameDay && <span className="small" style={{ color: 'var(--amber)' }}> ◆ money in and out the same day: covering it depends on timing</span>}</div>
      <div className="kv"><span>Opening {i === 0 ? '(today, before movements)' : `(${shortDay(f.days[i - 1].on)} close)`}</span><span className="num">{money(d.opening)}</span></div>
      <div className="kv"><span>Expected in · {ins.length}</span><span className="num">{money(d.in)}</span></div>
      <div className="kv"><span>Expected out · {outs.length}</span><span className="num">{d.out.minor ? `−${money(d.out)}` : money(d.out)}</span></div>
      <div className="kv total"><span>Projected close</span><span className={`num ${d.close.minor <= 0 ? 'neg' : ''}`}>{money(d.close)}</span></div>
      <div className="kv"><span>Reserve</span><span className="num">{money(f.reserve)}</span></div>
      <div className="kv strong"><span>{diff >= 0 ? 'Headroom above reserve' : 'Gap below reserve'}</span><span className={`num ${diff < 0 ? 'neg' : ''}`}>{money({ currency: 'USD', minor: Math.abs(diff) })}</span></div>
      {d.items.length > 0 && <div className="ag-items">
        {d.items.map((x) => (
          <div key={x.key} className="kv ag-item">
            <span>
              {x.ref.kind === 'INFLOW' ? <>{x.label} <span className="muted small">· stated receipt (no record to open)</span></> : <button className="linkbtn plain" onClick={() => onOpen(x)}>{x.label}</button>}
              {x.note && <span className="muted small"> · {x.note}</span>}
            </span>
            <span><span className="btag">{BASIS_TAG[x.basis]}</span> <span className="num">{signedMoney(x.amount, x.direction)}</span></span>
          </div>
        ))}
      </div>}
    </div>
  );
}

/** UI-CA-09: everything the forecast leaves out, with the reason for each (collapsed). */
export function NotInForecast({ rows, onOpenBill }: { rows: ResponseOf<'getForecast'>['notInForecast']; onOpenBill: (id: string) => void }) {
  const total = rows.reduce((a, r) => a + (r.amount?.minor ?? 0), 0);
  return (
    <details className="nif">
      <summary><strong>Not in the forecast yet · {rows.length} item{rows.length === 1 ? '' : 's'}{total ? ` · ${money({ currency: 'USD', minor: total })}` : ''}</strong> <span className="muted">No accepted date or amount yet, so Headroom doesn't count them.</span></summary>
      {rows.length === 0 ? <div className="muted small" style={{ padding: '8px 0' }}>Nothing left out.</div> : rows.map((r) => (
        <div key={r.key} className="kv nif-row">
          <span>{r.ref?.kind === 'BILL' ? <button className="linkbtn plain" onClick={() => onOpenBill(r.ref!.id)}>{r.label}</button> : r.label}<br /><span className="muted small">{r.reason}</span></span>
          <span className="num">{r.amount ? money(r.amount) : '—'}</span>
        </div>
      ))}
    </details>
  );
}
