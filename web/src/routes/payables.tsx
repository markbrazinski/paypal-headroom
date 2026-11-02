// Payables (UI-AP-01/02 rows and views, UI-AP-08…12, UI-AP-15 reconciliation): payment plan, bills, commitments; New › Capture bill / Add commitment.
import { useEffect, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import type { ResponseOf } from '@headroom/contracts';
import { ApiFailure, call } from '../api/client.ts';
import { Dialog, Failed, gridTheme, Loading, Pill } from '../components.tsx';
import { useApp, useLoad } from '../data.ts';
import { dateTime, day, money, shortDay } from '../format.ts';
import { BillPanel, BillPill, ObligationPanel, PayoutPill, SeparateDialog } from './bill-panel.tsx';

type P = ResponseOf<'listPayables'>;
type Tab = 'plan' | 'bills' | 'commitments' | 'arrangements' | 'reconciliation';
export type Sel = { kind: 'bill'; id: string } | { kind: 'obligation'; key: string } | null;

const param = (k: string) => new URLSearchParams(location.search).get(k);

export function Payables() {
  const [tab, setTab] = useState<Tab>(() => (param('bill') ? 'bills' : 'plan'));
  const [sel, setSel] = useState<Sel>(() => (param('bill') ? { kind: 'bill', id: param('bill')! } : param('payout') ? { kind: 'obligation', key: param('payout')! } : null));
  const [menu, setMenu] = useState(false);
  const [dialog, setDialog] = useState<'capture' | 'commitment' | null>(null);
  const q = useLoad(() => call('listPayables'));
  const p = q.data;
  const tabs: [Tab, string, number | null][] = [['plan', 'Payment plan', p?.obligations.length ?? null], ['bills', 'Bills', p?.bills.length ?? null], ['commitments', 'Commitments', p?.commitments.length ?? null], ['arrangements', 'Arrangements', null], ['reconciliation', 'Reconciliation', null]];
  return (
    <div className={`layout ${sel ? 'with-panel' : ''}`}>
      <div className="page">
        <h1>Payables</h1>
        <div className="tabs" role="tablist">
          {tabs.map(([k, label, n]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{label}{n !== null ? ` ${n}` : ''}</button>)}
          <div className="spacer">
            <button className="btn primary new-btn" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((m) => !m)}>New<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden><path d="M2 4.5 6 8.5l4-4" fill="none" stroke="currentColor" strokeWidth="1.8" /></svg></button>
            {menu && <div className="menu" role="menu">
              <button role="menuitem" onClick={() => { setMenu(false); setDialog('capture'); }}>Capture bill</button>
              <button role="menuitem" onClick={() => { setMenu(false); setDialog('commitment'); }}>Add commitment</button>
            </div>}
          </div>
        </div>
        {q.error ? <Failed error={q.error} /> : !p ? <Loading /> :
          tab === 'plan' ? <Plan p={p} onOpen={(key) => setSel({ kind: 'obligation', key })} /> :
          tab === 'bills' ? <Bills p={p} onOpen={(id) => setSel({ kind: 'bill', id })} /> :
          tab === 'commitments' ? <Commitments p={p} /> :
          tab === 'arrangements' ? <Arrangements p={p} /> :
          <Reconciliation p={p} />}
      </div>
      {sel?.kind === 'bill' && <BillPanel key={sel.id} id={sel.id} onClose={() => setSel(null)} />}
      {sel?.kind === 'obligation' && <ObligationPanel key={sel.key} occurrenceKey={sel.key} onClose={() => setSel(null)} onBill={(id) => setSel({ kind: 'bill', id })} />}
      {dialog === 'capture' && <CaptureBill onClose={() => setDialog(null)} onOpen={(id) => { setDialog(null); setTab('bills'); setSel({ kind: 'bill', id }); q.reload(); }} />}
      {dialog === 'commitment' && <AddCommitment onClose={() => setDialog(null)} onDone={() => { setDialog(null); setTab('commitments'); q.reload(); }} />}
    </div>
  );
}

// UI-AP-02 views: client-side over the server's pill (no figures computed here).
const VIEWS = [['all', 'All obligations', null], ['held', 'Held or paused', ['HELD', 'PAUSED', 'WAITING_FOR_REPORT', 'NOT_PAID', 'UNKNOWN']], ['approval', 'Needs approval', ['FUNDED_NEEDS_APPROVAL']]] as const;

function Plan({ p, onOpen }: { p: P; onOpen: (key: string) => void }) {
  const [view, setView] = useState<(typeof VIEWS)[number][0]>('all');
  const pills = VIEWS.find(([k]) => k === view)![2] as readonly string[] | null;
  const rows = pills ? p.obligations.filter((r) => r.payout && pills.includes(r.payout.pill)) : p.obligations;
  // UX audit F17: a paid obligation stays listed but is no longer counted as due.
  const open = p.obligations.filter((r) => r.payout?.pill !== 'PAID');
  const paid = p.obligations.length - open.length;
  return (
    <>
      <div className="toolbar"><span className="muted">Views:</span>
        <div className="seg" role="group" aria-label="Views">{VIEWS.map(([k, label]) => <button key={k} className={view === k ? 'on' : ''} aria-pressed={view === k} onClick={() => setView(k)}>{label}</button>)}</div>
      </div>
      <div className="population">Population: {open.length} payment{open.length === 1 ? '' : 's'} due · {money({ currency: 'USD', minor: open.filter((r) => !r.afterHorizon).reduce((a, r) => a + r.amount.minor, 0) })} in the next 6 weeks{paid ? ` · ${paid} paid` : ''}{pills ? ` · ${rows.length} in this view` : ''}</div>
      {rows.length === 0 ? <div className="box empty muted">Nothing in this view.</div> : (
      <div style={{ height: Math.min(560, 40 + rows.length * 42 + 2) }}>
        <AgGridReact<P['obligations'][number]> theme={gridTheme} rowData={rows} getRowId={(x) => x.data.occurrenceKey} onRowClicked={(e) => e.data && onOpen(e.data.occurrenceKey)}
          columnDefs={[
            { field: 'dueOn', headerName: 'Due', width: 120, valueFormatter: (x) => `${shortDay(x.value)}${x.data?.afterHorizon ? ' · after forecast' : x.data?.pastDue ? ' · past due' : ''}` },
            { field: 'name', headerName: 'Obligation', flex: 1.4, minWidth: 140, valueFormatter: (x) => `${x.value}${x.data?.supplierName ? ` · ${x.data.supplierName}` : ''}` },
            { field: 'amount', headerName: 'Amount', width: 150, type: 'rightAligned', valueFormatter: (x) => `${money(x.value)}` },
            { headerName: 'Type', width: 120, valueGetter: (x) => (x.data?.estimate ? 'Estimate' : x.data?.provenance === 'BILL' ? 'Bill' : 'Commitment') },
            { field: 'billApproved', headerName: 'Bill approved', width: 120, valueFormatter: (x) => x.value ?? '—' },
            { headerName: 'Permission to pay', flex: 1, minWidth: 130, valueGetter: (x) => x.data?.payout?.permission ?? '—', tooltipValueGetter: (x) => x.data?.payout?.permission },
            { headerName: 'Status now', width: 190, tooltipValueGetter: (x) => x.data?.payout ? (x.data.payout.paidRef ?? x.data.payout.pillText) : undefined,
              cellRenderer: (x: { data: P['obligations'][number] }) => x.data.payout ? <><PayoutPill pill={x.data.payout.pill} />{x.data.payout.paidRef && <span className="small muted"> {x.data.payout.paidRef}</span>}</> : x.data.pastDue ? 'Past due' : 'Scheduled' },
            { field: 'protected', headerName: 'Protected', width: 96, valueFormatter: (x) => (x.value ? 'Protected' : '—') },
            { field: 'provenance', headerName: 'Basis', width: 96, valueFormatter: (x: { value: string }) => (x.value === 'SEEDED' ? 'Sample data' : x.value === 'BILL' ? 'Bill' : 'You') },
          ]} />
      </div>
      )}
      <div className="foot">Bill approval and permission to pay are separate. Headroom pays approved suppliers through PayPal Payouts and counts a bill as paid only when PayPal confirms the payment reached the supplier.</div>
    </>
  );
}

/** UI-AP-15: supplier payouts sent through PayPal, with PayPal's ids and whether the payment is in PayPal's report yet. */
function Reconciliation({ p }: { p: P }) {
  const keys = p.obligations.filter((o) => o.payout).map((o) => o.occurrenceKey);
  const q = useLoad(() => Promise.all(keys.map((id) => call('getPayout', { params: { id } }))), [keys.join()]);
  if (q.error) return <Failed error={q.error} />;
  if (!q.data) return <Loading />;
  const sent = q.data.filter((v) => v.effect);
  if (!sent.length) return <div className="box"><div className="box-b"><strong>○ No supplier payouts yet</strong><div className="muted">When Headroom pays an approved supplier through PayPal Payouts, the payment lands here with PayPal's item and transaction ids, and shows once PayPal's report includes it.</div></div></div>;
  return (
    <div className="box"><div className="box-h"><h3>Supplier payouts</h3><span className="muted small">Paid only when PayPal confirms the payment reached the supplier</span></div>
      {sent.map((v) => {
        const e = v.effect!;
        return (
          <div key={v.occurrenceKey} className="box-b plan-row">
            <span><strong>{v.supplier.name} · {v.name}</strong>{v.billRef ? ` · ${v.billRef}` : ''} · {money(v.amount)}
              <div className="small">{e.state === 'PAID' ? (e.inReport ? "✓ In PayPal's report" : "Paid · awaiting PayPal's report") : v.pillText}{e.timeProcessed ? ` · processed ${dateTime(e.timeProcessed)}` : ''}</div>
              <details className="small muted"><summary>PayPal references</summary><span className="mono">item {e.itemId ?? '—'} · transaction {e.transactionId ?? '—'} · payment id {e.senderBatchId}</span></details></span>
            <PayoutPill pill={v.pill} />
          </div>
        );
      })}
    </div>
  );
}

function Bills({ p, onOpen }: { p: P; onOpen: (id: string) => void }) {
  const rows = p.bills;
  return (
    <>
      <div className="population">Population: {rows.length} bill{rows.length === 1 ? '' : 's'}</div>
      {rows.length === 0 ? <div className="box empty muted">No bills yet. Use <strong>New › Capture bill</strong> to upload one.</div> : (
        <div style={{ height: Math.min(560, 40 + rows.length * 42 + 2) }}>
          <AgGridReact<P['bills'][number]> theme={gridTheme} rowData={rows} getRowId={(x) => x.data.billId} onRowClicked={(e) => e.data && onOpen(e.data.billId)}
            columnDefs={[
              { field: 'ref', headerName: 'Bill', width: 110, valueFormatter: (x) => x.value ?? '—' },
              { field: 'supplierName', headerName: 'Supplier', flex: 1, valueFormatter: (x) => x.value ?? 'Unknown sender' },
              { field: 'amount', headerName: 'Amount', width: 120, type: 'rightAligned', valueFormatter: (x) => (x.value ? money(x.value) : x.data?.printedTotal ?? '—') },
              { field: 'dueOn', headerName: 'Due', width: 160, valueFormatter: (x) => (x.value ? `${shortDay(x.value)}${x.data?.operativeDueOn && x.data.operativeDueOn !== x.value ? ` (agreed ${shortDay(x.data.operativeDueOn)})` : ''}` : '—') },
              { field: 'status', headerName: 'Status', width: 200, cellRenderer: (x: { data: P['bills'][number] }) => <BillPill b={x.data} /> },
              { field: 'relationship', headerName: 'Relationship to plan', flex: 1.6, tooltipField: 'relationship' },
            ]} />
        </div>
      )}
      <div className="foot">Headroom proposes a match for each bill. Whether you verify it, and whether a different date or amount is accepted, follows your Delegation rules; a change moves the forecast only once accepted.</div>
    </>
  );
}

function Commitments({ p }: { p: P }) {
  const rows = p.commitments;
  return (
    <>
      <div className="population">Population: {rows.length} commitment{rows.length === 1 ? '' : 's'}</div>
      <div style={{ height: Math.min(560, 40 + rows.length * 42 + 2) }}>
        <AgGridReact<P['commitments'][number]> theme={gridTheme} rowData={rows} getRowId={(x) => x.data.commitmentId}
          columnDefs={[
            { field: 'name', headerName: 'Commitment', flex: 1.3, valueFormatter: (x) => `${x.value}${x.data?.supplierName ? ` · ${x.data.supplierName}` : ''}` },
            { field: 'amount', headerName: 'Amount', width: 120, type: 'rightAligned', valueFormatter: (x) => money(x.value) },
            { field: 'nextOn', headerName: 'Next date', width: 150, valueFormatter: (x) => (x.value ? `${shortDay(x.value)}${x.data?.afterHorizon ? ' · not yet assessed' : ''}` : '—') },
            { field: 'recurrence', headerName: 'Recurrence', width: 110, valueFormatter: (x) => ({ ONCE: 'One time', MONTHLY: 'Monthly', DATES: 'Set dates' } as Record<string, string>)[x.value] },
            { field: 'substantiation', headerName: 'Substantiation', width: 150, valueFormatter: (x: { value: string }) => (x.value === 'SEEDED' ? 'Sample data' : x.value === 'OWNER-ENTERED' ? 'Entered by you' : x.value) },
            { field: 'protected', headerName: 'Protected', width: 100, valueFormatter: (x) => (x.value ? 'Protected' : '—') },
          ]} />
      </div>
    </>
  );
}

/** UI-AP-11: step 1 a real file picker (the design had none); step 2 what was read, and the design's choice. */
function CaptureBill({ onClose, onOpen }: { onClose: () => void; onOpen: (id: string) => void }) {
  const { toast } = useApp();
  const [file, setFile] = useState<File | null>(null);
  const [billId, setBillId] = useState<string | null>(null);
  const [dup, setDup] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [key] = useState(() => crypto.randomUUID());
  const [detail, setDetail] = useState<ResponseOf<'getBill'> | null>(null);
  const [separate, setSeparate] = useState(false);
  useEffect(() => {
    if (!billId) return;
    let live = true;
    const poll = async () => {
      try { const d = await call('getBill', { params: { id: billId } }); if (!live) return; setDetail(d); if (d.bill.state === 'RECEIVED') setTimeout(poll, 1500); }
      catch (e) { if (live) setError((e as Error).message); }
    };
    poll();
    return () => { live = false; };
  }, [billId]);
  const upload = async () => {
    if (!file) return;
    setBusy(true); setError(null);
    try {
      const b64 = await new Promise<string>((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1] ?? ''); r.onerror = () => no(r.error); r.readAsDataURL(file); });
      const res = await call('uploadDocument', { body: { fileName: file.name, contentType: 'application/pdf', contentBase64: b64 }, idempotencyKey: key });
      setDup(res.status === 'DUPLICATE_DOCUMENT');
      setBillId(res.billId);
    } catch (e) { setError(e instanceof ApiFailure ? e.error.message : (e as Error).message); } finally { setBusy(false); }
  };
  if (separate && detail) return <SeparateDialog b={detail} onClose={() => setSeparate(false)} onDone={() => { toast('Added as a separate obligation.'); onOpen(detail.bill.billId); }} />;
  const d = detail;
  const reading = !d || d.bill.state === 'RECEIVED';
  return (
    <Dialog kicker={`Payables · Capture bill · Step ${billId ? 2 : 1}`} title={!billId ? 'Capture a bill' : reading ? 'Reading the bill…' : `${d!.bill.supplierName ?? 'Unknown sender'} · ${d!.bill.ref ?? d!.document.fileName}${d!.bill.amount ? ` · ${money(d!.bill.amount)}` : ''}${d!.bill.dueOn ? ` · due ${shortDay(d!.bill.dueOn)}` : ''}`} onClose={onClose}
      footer={!billId ? <><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!file || busy} onClick={upload}>Upload</button></>
        : <><button className="btn" onClick={onClose}>Close</button>{d && !reading && <button className="btn primary" onClick={() => onOpen(d.bill.billId)}>Open bill</button>}</>}>
      {!billId ? (
        <>
          <label className="field">Upload a PDF<input type="file" accept="application/pdf" aria-label="Bill PDF" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>
          <div className="small muted">The original is kept unchanged. Headroom reads it, checks every value against the document, and proposes a match. Nothing changes until you decide.</div>
          <div className="small muted">Bills emailed to your Headroom address arrive the same way and show in Inbox.</div>
        </>
      ) : dup ? (
        <div><strong>Already received.</strong> This exact file was uploaded before; no second bill was created.</div>
      ) : reading ? (
        <div className="muted">Reading the bill… values are checked against the document before anything is proposed.</div>
      ) : d!.bill.state === 'READ_FAILED' || d!.bill.state === 'HELD' ? (
        <div><strong>{d!.bill.statusLabel}.</strong> {[d!.readFailure, ...d!.holdReasons].filter(Boolean).join('; ')}. Nothing was added to the forecast.</div>
      ) : (
        <>
          {d!.occurrence && (
            <button className="choice-card" onClick={() => onOpen(d!.bill.billId)}>
              <strong>● {d!.changedFields.length ? 'Matches' : 'Exact match:'} “{d!.occurrence.commitmentName}” ({money(d!.occurrence.amount)}, {shortDay(d!.occurrence.dueOn)})</strong><br />
              <span className="small muted">{d!.changedFields.length ? `The bill's ${d!.changedFields.map((x) => (x === 'dueOn' ? 'date' : 'amount')).join(' and ')} differs. ` : 'Amount and date match. '}Open the bill to verify it. Still one outflow; the forecast is unchanged until you accept any difference.</span>
            </button>
          )}
          {d!.bill.status === 'CHOOSE_MATCH' && <button className="choice-card" onClick={() => onOpen(d!.bill.billId)}><strong>● Could be {d!.candidates.length} payments</strong><br /><span className="small muted">Open the bill and choose which one.</span></button>}
          {d!.actions.addSeparate.allowed && (
            <button className="choice-card" onClick={() => setSeparate(true)}>
              <strong>○ {d!.occurrence ? 'No: this is a separate obligation' : 'Add as a separate obligation'}</strong><br />
              <span className="small muted">Adds {d!.bill.amount ? money(d!.bill.amount) : 'the amount'} on {shortDay(d!.bill.dueOn)} as {d!.occurrence ? 'a second' : 'a new'} outflow. {d!.occurrence ? 'Choose only if it is billed twice.' : ''}</span>
            </button>
          )}
          <div className="what small"><h5>READ FROM THE BILL · CHECK</h5>{d!.fields.filter((f) => f.grounded).map((f) => `${f.name.replace(/([A-Z])/g, ' $1').toLowerCase()} ${f.value}`).join(' · ')}</div>
        </>
      )}
      {error && <div className="err-banner">{error}</div>}
    </Dialog>
  );
}

/** UI-AP-12: the server says what happens (or why not); no client-side date logic beyond the format. */
function AddCommitment({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { toast } = useApp();
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [on, setOn] = useState('');
  const [monthly, setMonthly] = useState(false);
  const [estimate, setEstimate] = useState(false);
  const [prot, setProt] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [key] = useState(() => crypto.randomUUID());
  const save = async () => {
    const m = /^\s*\$?\s*(\d{1,7})(?:\.(\d{1,2}))?\s*$/.exec(amount.replace(/,/g, ''));
    if (!m) return setMsg({ ok: false, text: 'Enter an amount like 650 or 650.50' });
    setBusy(true);
    try {
      const minor = Number(m[1]) * 100 + Number((m[2] ?? '0').padEnd(2, '0'));
      const r = await call('createCommitment', { body: { name, amount: { currency: 'USD', minor }, on, recurrence: monthly ? 'MONTHLY' : 'NONE', estimate, protected: prot }, idempotencyKey: key });
      toast(r.effect);
      onDone();
    } catch (e) { setMsg({ ok: false, text: e instanceof ApiFailure ? `Not added: ${e.error.message}` : (e as Error).message }); } finally { setBusy(false); }
  };
  return (
    <Dialog kicker="Payables · Add commitment" title="New commitment" onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || !name || !on} onClick={save}>Add commitment</button></>}>
      <label className="field">Name<input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Van lease" /></label>
      <label className="field">Amount (USD)<input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="650.00" /></label>
      <label className="field">Next date<input type="date" value={on} onChange={(e) => setOn(e.target.value)} /></label>
      <div className="checks small">
        <label><input type="checkbox" checked={monthly} onChange={(e) => setMonthly(e.target.checked)} /> Repeats monthly</label>
        <label><input type="checkbox" checked={estimate} onChange={(e) => setEstimate(e.target.checked)} /> Amount is an estimate</label>
        <label><input type="checkbox" checked={prot} onChange={(e) => setProt(e.target.checked)} /> Protected (payroll, rent…)</label>
      </div>
      <div className="what small"><h5>WHAT HAPPENS</h5>Each date inside the next 6 weeks enters the forecast as an outflow. A date after that is saved and shown as "not yet assessed" until the forecast window reaches it. Nothing is paid.</div>
      {msg && <div className={msg.ok ? 'small' : 'err-banner'}>{msg.text}</div>}
    </Dialog>
  );
}

/** UI-AP-13: accepted supplier terms (AGREED, from your acceptances) and the plan's payout action with its state. No requests yet. */
function Arrangements({ p }: { p: ResponseOf<'listPayables'> }) {
  const plan = useLoad(() => call('getPlan'));
  const rev = plan.data?.revision;
  const payouts = rev ? [...rev.actions, ...rev.removed].filter((a) => a.kind === 'PAYOUT') : [];
  const agreed = p.obligations.flatMap((o) => o.history.map((h) => ({ o, h })));
  return (
    <>
      <div className="box"><div className="box-h"><h3>Agreed terms</h3><span className="muted small">Changes you accepted from a supplier's bill</span></div>
        {agreed.length ? agreed.map(({ o, h }) => <div key={o.occurrenceKey + h.at} className="box-b plan-row"><span><strong>{o.name}</strong>{o.supplierName ? ` · ${o.supplierName}` : ''}<div className="small">{h.before} → {h.after} · accepted {dateTime(h.at)}</div></span><Pill tone="green" glyph="✓">Agreed</Pill></div>) : <div className="box-b muted">No changed terms accepted yet.</div>}
      </div>
      <div className="box"><div className="box-h"><h3>In the plan</h3>{rev && <span className="muted small">Revision {rev.n} · {rev.pill}</span>}</div>
        {payouts.length ? payouts.map((a) => <div key={a.actionId} className="box-b plan-row"><span><strong>Pay {a.counterparty.name} {money(a.terms.amount)}</strong> on {day(a.terms.payBy)}<div className="small">{a.stateText}</div></span><a href="/plan">Plan ›</a></div>) : <div className="box-b muted">No supplier payout in a plan.</div>}
      </div>
      <div className="note">To ask a supplier to keep a date or split a payment, include “Ask the supplier” in the plan; their answer changes nothing until you accept it.</div>
    </>
  );
}
