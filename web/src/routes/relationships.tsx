// Customers & Suppliers (S04 §6.7: UI-CS-01…05). Directory of relationship labels (rules, not scores) and a record showing what each
// label is built from, how Headroom treats the business and its active work. Navigation only; nothing here edits.
import { useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import type { ResponseOf } from '@headroom/contracts';
import { call } from '../api/client.ts';
import { useApp, useLoad } from '../data.ts';
import { Failed, gridTheme, Loading, Panel } from '../components.tsx';
import { actionState, money, shortDay } from '../format.ts';

type Row = ResponseOf<'listRelationships'>['rows'][number];
const dots = (n: number) => `${'●'.repeat(n)}${'○'.repeat(4 - n)}`;

export function Relationships() {
  const q = useLoad(() => call('listRelationships'));
  const [sel, setSel] = useState<string | null>(() => new URLSearchParams(location.search).get('id'));
  const rows = q.data?.rows ?? [];
  return (
    <div className={`layout ${sel ? 'with-panel' : ''}`}>
      <div className="page">
        <h1>Customers & Suppliers</h1>
        {q.error ? <Failed error={q.error} /> : !q.data ? <Loading /> : (
          <>
            <div className="population">{rows.length} businesses · sorted by relationship strength · labels are rules from payment history, not scores</div>
            <div style={{ height: Math.min(640, 40 + rows.length * 42 + 2) }}>
              <AgGridReact<Row> theme={gridTheme} rowData={rows} getRowId={(p) => p.data.id}
                rowSelection={{ mode: 'singleRow', checkboxes: false, enableClickSelection: true }}
                onRowClicked={(e) => e.data && setSel(e.data.id)}
                columnDefs={[
                  { field: 'name', headerName: 'Business', flex: 1, minWidth: 180 },
                  { field: 'label', headerName: 'Relationship', width: 190, valueFormatter: (p) => `${dots(p.data!.dots)} ${p.value}` },
                  { field: 'meaning', headerName: 'What it means', width: 200 },
                  { field: 'roles', headerName: 'Roles', width: 150, valueFormatter: (p) => (p.value as string[]).map((r) => (r === 'CUSTOMER' ? 'Customer' : 'Supplier')).join(' · ') },
                  { field: 'receivable', headerName: 'Owed to you', width: 120, type: 'rightAligned', valueFormatter: (p) => (p.value.minor ? money(p.value) : '—') },
                  { field: 'payable', headerName: 'You owe (6 wks)', width: 130, type: 'rightAligned', valueFormatter: (p) => (p.value.minor ? money(p.value) : '—') },
                  { field: 'activeWork', headerName: 'Active work', flex: 1, minWidth: 200, valueFormatter: (p) => (p.value as string[]).join(' · ') || '—' },
                  { field: 'lastContact', headerName: 'Last paid', width: 100, valueFormatter: (p) => shortDay(p.value) },
                ]} />
            </div>
          </>
        )}
      </div>
      {sel && <Record key={sel} id={sel} onClose={() => setSel(null)} />}
    </div>
  );
}

function Record({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useLoad(() => call('getRelationship', { params: { id } }));
  const { nav } = useApp();
  const r = q.data;
  const [pick, setTab] = useState<'CUSTOMER' | 'SUPPLIER' | null>(null);
  const tab = pick ?? (r?.roles[0] ?? 'CUSTOMER');
  return (
    <Panel kicker="Customer or supplier" title={r?.name ?? '…'} onClose={onClose}>
      {q.error ? <Failed error={q.error} /> : !r ? <Loading /> : (
        <div className="box-b" style={{ display: 'grid', gap: 12 }}>
          <div className="small muted">{r.roles.map((x) => (x === 'CUSTOMER' ? 'Customer' : 'Supplier')).join(' · ')}{r.since ? ` · history since ${shortDay(r.since)}` : ''}</div>
          <div className="tabs" role="tablist">{(['CUSTOMER', 'SUPPLIER'] as const).map((t) => <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>As {t === 'CUSTOMER' ? 'customer' : 'supplier'}</button>)}</div>
          {!r.roles.includes(tab) ? <div className="muted">None: {r.name} is not a {tab === 'CUSTOMER' ? 'customer' : 'supplier'}.</div> : (
            <>
              <div><div className="kicker">Relationship</div><div className="serif" style={{ fontSize: 20 }}><span aria-hidden>{dots(r.dots)}</span> {r.label}</div><div className="small">{r.meaning} · {r.rank}</div></div>
              <div><div className="kicker">What this is built from</div>{r.factors.map((f) => <div key={f.factor} className="kv"><span>{f.factor}<div className="small muted">{f.detail}</div></span><strong>{f.value}</strong></div>)}</div>
              <div><div className="kicker">How Headroom treats this business</div>{r.treatment.map((t) => <div key={t.text} className="small">• {t.text} <span className="muted">({t.winning})</span></div>)}<a href="/delegation" onClick={(e) => { e.preventDefault(); nav('/delegation'); }}>Delegation ›</a></div>
              <div><div className="kicker">In the current plan</div>{r.inPlan.length ? r.inPlan.map((a) => <div key={a.actionId} className="small">{a.title} · {actionState(a.state)}</div>) : <div className="small muted">Nothing</div>}<a href="/plan" onClick={(e) => { e.preventDefault(); nav('/plan'); }}>Plan ›</a></div>
              <div><div className="kicker">Open items</div>{r.open.length ? r.open.map((o) => <div key={o.ref} className="small">{o.invoiceId ? <a href={`/receivables?invoice=${o.invoiceId}`} onClick={(e) => { e.preventDefault(); nav(`/receivables?invoice=${o.invoiceId}`); }}>{o.ref}</a> : o.ref} · {o.text}</div>) : <div className="small muted">None</div>}</div>
              <div><div className="kicker">Payment history</div>{r.history.map((h) => <div key={h.ref + h.dueOn} className="kv small"><span>{h.ref}{h.note ? ` · ${h.note}` : ''}</span><span>{(h.kind as string) === 'REMINDER_SENT' ? 'Payment reminder sent' : h.daysLate === null ? h.kind === 'DISPUTE' ? 'open dispute' : 'missed' : `${h.daysLate} days late`}</span></div>)}</div>
              <div className="small muted"><a href="/inbox" onClick={(e) => { e.preventDefault(); nav('/inbox'); }}>Messages with them · Inbox ›</a></div>
            </>
          )}
        </div>
      )}
    </Panel>
  );
}
