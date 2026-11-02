import { useMemo, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import type { InvoiceRow, ReceiptRow, ResponseOf } from '@headroom/contracts';
import { ApiFailure, call } from '../api/client.ts';
import { Dialog, Failed, gridTheme, InvoicePill, Loading, Panel, Pill, Tag } from '../components.tsx';
import { useApp, useLoad } from '../data.ts';
import { ago, dateTime, day, money, shortDay, words } from '../format.ts';

type Rec = ResponseOf<'listReceivables'>;
type Sel = { kind: 'invoice'; id: string } | { kind: 'receipt'; captureId: string; invoiceId: string } | { kind: 'work'; invoiceId: string } | null;

export function Receivables() {
  const [tab, setTab] = useState<'work' | 'invoices' | 'arrangements' | 'incoming' | 'reconciliation'>('invoices');
  const [sel, setSel] = useState<Sel>(() => { const id = new URLSearchParams(location.search).get('invoice'); return id ? { kind: 'invoice', id } : null; });
  const [menu, setMenu] = useState(false);
  const [creating, setCreating] = useState(false);
  const q = useLoad(() => call('listReceivables'));
  const r = q.data;
  const tabs = [
    ['work', 'Collection work', null], ['invoices', 'Invoices', r?.invoices.length], ['arrangements', 'Arrangements', null],
    ['incoming', 'Incoming', r?.incoming.length], ['reconciliation', 'Reconciliation', null],
  ] as const;
  return (
    <div className={`layout ${sel ? 'with-panel' : ''}`}>
      <div className="page">
        <h1>Receivables</h1>
        <div className="tabs" role="tablist">
          {tabs.map(([k, label, n]) => (
            <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{label}{n !== null && n !== undefined ? ` ${n}` : ''}</button>
          ))}
          <div className="spacer">
            <button className="btn primary new-btn" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((m) => !m)}>New<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden><path d="M2 4.5 6 8.5l4-4" fill="none" stroke="currentColor" strokeWidth="1.8" /></svg></button>
            {menu && <div className="menu" role="menu"><button role="menuitem" onClick={() => { setMenu(false); setCreating(true); }}>Create invoice</button></div>}
          </div>
        </div>
        {q.error ? <Failed error={q.error} /> : !r ? <Loading /> :
          tab === 'invoices' ? <Invoices r={r} onOpen={(id) => setSel({ kind: 'invoice', id })} selected={sel?.kind === 'invoice' ? sel.id : null} /> :
          tab === 'incoming' ? <Incoming r={r} onOpen={(x) => setSel({ kind: 'receipt', captureId: x.captureId, invoiceId: x.invoiceId })} /> :
          tab === 'reconciliation' ? <Reconciliation /> :
          tab === 'work' ? <Work r={r} onOpen={(id) => setSel({ kind: 'work', invoiceId: id })} selected={sel?.kind === 'work' ? sel.invoiceId : null} /> :
          <div className="notbuilt">Payment arrangements (instalments and agreed schedules) aren’t available yet. Customers’ promised dates appear in Inbox.</div>}
      </div>
      {/* Keyed by record (S1-IM-01): switching rows remounts the panel, so no data, confirmation or action key carries over. */}
      {sel?.kind === 'invoice' && <InvoicePanel key={sel.id} id={sel.id} onClose={() => setSel(null)} onReceipt={(x) => setSel({ kind: 'receipt', captureId: x.captureId, invoiceId: x.invoiceId })} />}
      {sel?.kind === 'work' && r && r.work.find((w) => w.invoiceId === sel.invoiceId) && <WorkPanel key={sel.invoiceId} w={r.work.find((w) => w.invoiceId === sel.invoiceId)!} onClose={() => setSel(null)} reload={q.reload} />}
      {sel?.kind === 'receipt' && <ReceiptPanel key={sel.captureId} invoiceId={sel.invoiceId} captureId={sel.captureId} onClose={() => setSel(null)} onInvoice={() => setSel({ kind: 'invoice', id: sel.invoiceId })} />}
      {creating && r && <CreateInvoice customers={r.customers} onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); setTab('invoices'); setSel({ kind: 'invoice', id }); q.reload(); }} />}
    </div>
  );
}

function Invoices({ r, onOpen, selected }: { r: Rec; onOpen: (id: string) => void; selected: string | null }) {
  const { session } = useApp();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const rows = useMemo(() => r.invoices.filter((i) => !status || i.state === status), [r.invoices, status]);
  const open = r.invoices.filter((i) => i.state === 'ISSUED' || i.state === 'PARTIALLY_PAID').reduce((a, i) => a + 1, 0);
  return (
    <>
      <div className="toolbar">
        <input placeholder="Search in Receivables" aria-label="Search invoices" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Status</option>
          {['DRAFT', 'ISSUING', 'ISSUE_UNKNOWN', 'ISSUED', 'PARTIALLY_PAID', 'PAID', 'FAILED'].map((s) => <option key={s} value={s}>{words(s)}</option>)}
        </select>
      </div>
      <div className="population">Population: {r.population.total} invoice{r.population.total === 1 ? '' : 's'} · {open} open on PayPal</div>
      {r.invoices.length === 0 ? <div className="box empty muted">No invoices yet. Use <strong>New › Create invoice</strong> to save a draft.</div> : (
        <div style={{ height: Math.min(560, 40 + rows.length * 42 + 2) }}>
          <AgGridReact<InvoiceRow> theme={gridTheme} rowData={rows} quickFilterText={search} getRowId={(p) => p.data.invoiceId}
            rowSelection={{ mode: 'singleRow', checkboxes: false, enableClickSelection: true }}
            onRowClicked={(e) => e.data && onOpen(e.data.invoiceId)}
            onFirstDataRendered={(e) => selected && e.api.getRowNode(selected)?.setSelected(true)}
            columnDefs={[
              { field: 'invoiceNumber', headerName: 'Invoice', width: 142, valueFormatter: (p) => p.value ?? 'Draft' },
              { field: 'customerName', headerName: 'Customer', flex: 1, minWidth: 130, tooltipField: 'customerName' },
              { field: 'issuedAt', headerName: 'Issued', width: 78, valueFormatter: (p) => (p.value ? new Date(p.value).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: session.timeZone }) : '—') },
              { field: 'dueOn', headerName: 'Due', width: 78, valueFormatter: (p) => shortDay(p.value) },
              { field: 'amount', headerName: 'Amount', width: 104, type: 'rightAligned', valueFormatter: (p) => money(p.value), comparator: (a, b) => a.minor - b.minor },
              { field: 'open', headerName: 'Open', width: 104, type: 'rightAligned', valueFormatter: (p) => money(p.value), comparator: (a, b) => a.minor - b.minor },
              { field: 'state', headerName: 'Status', width: 146, cellRenderer: (p: { data: InvoiceRow }) => <InvoicePill inv={p.data} today={session.businessToday} /> },
            ]} />
        </div>
      )}
      <div className="foot">Draft invoices are not counted in the forecast until issued.</div>
    </>
  );
}

function Incoming({ r, onOpen }: { r: Rec; onOpen: (x: ReceiptRow) => void }) {
  const inReport = r.incoming.filter((x) => x.inReportedBalance === 'INCLUDED');
  const notYet = r.incoming.filter((x) => x.inReportedBalance !== 'INCLUDED');
  const Row = ({ x }: { x: ReceiptRow }) => (
    <button className="row" onClick={() => onOpen(x)}>
      <span><strong>PayPal · {x.customerName}</strong><br /><span className="muted small">Captured {dateTime(x.capturedAt)} · {x.invoiceNumber}{x.inReportedBalance !== 'INCLUDED' && x.inclusionReason ? ` · ${x.inclusionReason}` : ''}</span></span>
      <span className="num" style={{ textAlign: 'right' }}>{money(x.gross)}</span>
      <span className="num" style={{ textAlign: 'right' }}>{money(x.net)}</span>
      <span style={{ textAlign: 'right' }}>{x.reversalDetected ? <Pill tone="amber" glyph="!">Refund detected</Pill> : <Pill tone="green" glyph="✓">Captured</Pill>}</span>
    </button>
  );
  return (
    <div className="box list" style={{ marginTop: 0 }}>
      <div className="sh">Captured · not yet in PayPal report</div>
      {notYet.length ? notYet.map((x) => <Row key={x.captureId} x={x} />) : <div className="empty"><div>○ Nothing waiting for a PayPal report</div><div className="muted small">Payments appear here once PayPal confirms a capture, before PayPal's report includes them.</div></div>}
      <div className="sh">In PayPal reported balance</div>
      {inReport.length ? inReport.map((x) => <Row key={x.captureId} x={x} />) : <div className="empty muted small">None yet.</div>}
    </div>
  );
}

function CreateInvoice({ customers, onClose, onCreated }: { customers: Rec['customers']; onClose: () => void; onCreated: (id: string) => void }) {
  const { toast } = useApp();
  const [customerId, setCustomer] = useState(customers[0]?.customerId ?? '');
  const [amount, setAmount] = useState('');
  const [dueOn, setDue] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [actionKey] = useState(() => crypto.randomUUID()); // one key for this dialog's Save, reused on retry
  const save = async () => {
    // Format check only; the server decides (S01 T1.1).
    const m = /^\s*\$?\s*(\d{1,7})(?:\.(\d{1,2}))?\s*$/.exec(amount.replace(/,/g, ''));
    const local: Record<string, string> = {};
    if (!m) local.amount = 'Enter an amount like 1800 or 1800.50';
    if (!dueOn) local.dueOn = 'Choose a due date';
    setErrors(local);
    if (Object.keys(local).length) return;
    setBusy(true);
    try {
      const minor = Number(m![1]) * 100 + Number((m![2] ?? '0').padEnd(2, '0'));
      const res = await call('createInvoiceDraft', { body: { customerId, amount: { currency: 'USD', minor }, dueOn }, idempotencyKey: actionKey });
      toast('Draft saved. Not counted in the forecast.');
      onCreated(res.invoice.invoiceId);
    } catch (e) {
      if (e instanceof ApiFailure && e.error.details) setErrors(Object.fromEntries(e.error.details.map((d) => [d.path.split('.')[0], d.message])));
      else setErrors({ form: (e as Error).message });
    } finally { setBusy(false); }
  };
  return (
    <Dialog kicker="Receivables · Create invoice" title="New invoice" onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save} disabled={busy}>Save draft</button></>}>
      <label className="field">Customer
        <select value={customerId} onChange={(e) => setCustomer(e.target.value)}>{customers.map((c) => <option key={c.customerId} value={c.customerId}>{c.displayName}</option>)}</select>
        {errors.customerId && <span className="err">{errors.customerId}</span>}
      </label>
      <label className="field">Amount (USD)
        <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-invalid={!!errors.amount} />
        {errors.amount && <span className="err">{errors.amount}</span>}
      </label>
      <label className="field">Due date
        <input type="date" value={dueOn} onChange={(e) => setDue(e.target.value)} aria-invalid={!!errors.dueOn} />
        {errors.dueOn && <span className="err">{errors.dueOn}</span>}
      </label>
      {errors.form && <div className="err-banner">{errors.form}</div>}
      <div className="what"><h5>WHAT HAPPENS</h5>Saved as a draft in Receivables › Invoices. Nothing goes to PayPal and nothing is counted in the forecast until you issue it on PayPal.</div>
    </Dialog>
  );
}

function InvoicePanel({ id, onClose, onReceipt }: { id: string; onClose: () => void; onReceipt: (x: ReceiptRow) => void }) {
  const { session, toast } = useApp();
  const q = useLoad(() => call('getInvoice', { params: { id } }), [id]);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [issueKey] = useState(() => crypto.randomUUID()); // one key per invoice panel's Issue action
  const d = q.data;
  const inv = d?.invoice;
  const issue = async () => {
    setBusy(true);
    // Dispatch the exact snapshot the confirmation showed: its id and version.
    try { await call('sendInvoice', { params: { id: inv!.invoiceId }, ifMatch: inv!.version, idempotencyKey: issueKey }); setConfirm(false); toast('Issuing on PayPal. No email is sent.'); q.reload(); }
    catch (e) { toast((e as Error).message); q.reload(); } finally { setBusy(false); }
  };
  const check = async () => {
    try { await call('refreshInvoice', { params: { id } }); toast('Checking with PayPal now.'); } catch (e) { toast((e as Error).message); }
  };
  if (q.error) return <Panel kicker="Invoice" title="Couldn't load invoice" onClose={onClose}><div className="sec"><Failed error={q.error} /></div></Panel>;
  if (!d || !inv) return <Panel kicker="Invoice" title="Loading…" onClose={onClose}><Loading /></Panel>;
  return (
    <Panel kicker={`Invoice · ${inv.invoiceNumber ?? 'Draft'}`} onClose={onClose} title={`${inv.invoiceNumber ?? 'Draft invoice'} · ${inv.customerName}`}
      status={<div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><InvoicePill inv={inv} today={session.businessToday} /><span className="muted small">Receivables › Invoices</span></div>}>
      <div className="facts">
        <div><div className="muted small">Amount</div><div className="v num">{money(inv.amount)}</div></div>
        <div><div className="muted small">Open</div><div className="v num">{money(inv.open)}</div></div>
        <div><div className="muted small">Due</div><div className="v">{shortDay(inv.dueOn)}</div></div>
      </div>
      <div className="sec">
        <h4>On PayPal</h4>
        {inv.state === 'DRAFT' && <><div className="muted" style={{ marginBottom: 10 }}>Draft. Not on PayPal and not counted in the forecast.</div><button className="btn primary" onClick={() => setConfirm(true)}>Issue on PayPal</button></>}
        {inv.state === 'ISSUING' && <div>◐ {inv.waitingReason ?? 'Issuing on PayPal…'}</div>}
        {inv.state === 'ISSUE_UNKNOWN' && <div>? Checking with PayPal. The outcome of the last request is unknown; Headroom is confirming it using the same invoice number. No retry is needed.</div>}
        {inv.state === 'FAILED' && <div className="neg">✕ Not issued: {d.failureReason}</div>}
        {['ISSUED', 'PARTIALLY_PAID', 'PAID'].includes(inv.state) && (
          <>
            <div className="kv"><span>PayPal status</span><span>{words(d.providerStatus)}</span></div>
            {d.payerUrl && <div className="kv"><span>Payer link</span><span><a href={d.payerUrl} target="_blank" rel="noreferrer">Open</a> · <button className="linkbtn" onClick={() => navigator.clipboard.writeText(d.payerUrl!).then(() => toast('Payer link copied'))}>Copy</button></span></div>}
            <div className="small muted">PayPal doesn't email the customer; Headroom's own messages are in the Inbox.</div>
            {d.partialPayment && <div className="kv"><span>Partial payment</span><span>On PayPal · accepts {money(d.partialPayment.minimum)} minimum · verified {dateTime(d.partialPayment.verifiedAt)}</span></div>}
            {d.projection && (
              <div className="sec">
                <h4>What is still owed</h4>
                <div className="kv"><span>PayPal shows due</span><span>{d.projection.providerDue ? money(d.projection.providerDue) : 'not read yet'}</span></div>
                <div className="kv"><span>Headroom expects</span><span>{money(d.projection.collectibleOpen)}</span></div>
                {d.projection.undisputedOpen && <div className="kv"><span>Undisputed still open</span><span>{money(d.projection.undisputedOpen)}</span></div>}
                {d.projection.disputedUnresolved && <div className="kv"><span>Disputed still outstanding</span><span>{money(d.projection.disputedUnresolved)} · {d.disputedAllowance ? 'collected only up to what you approved' : 'never collected without your approval'}</span></div>}
                {d.projection.unallocatedCredit && d.projection.unallocatedCredit.minor > 0 && <div className="kv"><span>Received toward the disputed amount</span><span>{money(d.projection.unallocatedCredit)} · your decision</span></div>}
                {d.projection.concessions.minor > 0 && <div className="kv"><span>Discount given</span><span>{money(d.projection.concessions)} · not revenue</span></div>}
                {d.projection.conservation === 'HOLD' && <div style={{ color: 'var(--amber)' }}>‖ {d.projection.text} · held for reconciliation</div>}
              </div>
            )}
          </>
        )}
        {inv.hold && <div style={{ color: 'var(--amber)', marginTop: 8 }}>‖ Held for reconciliation: {inv.hold}</div>}
      </div>
      {d.dispute && <DisputeSection invoiceId={inv.invoiceId} dsp={d.dispute} onDone={q.reload} />}
      {d.disputedAllowance && <div className="sec"><h4>Disputed amount you approved asking for</h4><div className="kv"><span>Approved</span><span className="num">{money(d.disputedAllowance.allowed)}</span></div><div className="kv"><span>Paid toward it</span><span className="num">{money(d.disputedAllowance.used)}</span></div><div className="small muted">Payments settle the undisputed part first; only up to what you approved counts against the dispute. The customer’s claim record is never changed.</div></div>}
      {inv.checking.state !== 'DONE' && (
        <div className="sec">
          <h4>Checking</h4>
          {inv.checking.state === 'STOPPED' || inv.checking.state === 'FAILING'
            ? <div style={{ color: 'var(--amber)' }}>◔ {inv.checking.reason} · last good check {dateTime(inv.checking.lastCheckedAt)}</div>
            : <div className="muted">Headroom checks PayPal automatically · last checked {ago(inv.checking.lastCheckedAt)}</div>}
          <button className="btn" style={{ marginTop: 8 }} onClick={check} disabled={inv.checking.state === 'STOPPED'} title={inv.checking.reason ?? undefined}>Check PayPal now</button>
        </div>
      )}
      {d.ownerAssertions.length > 0 && (
        <div className="sec"><h4>Recorded outside PayPal</h4>
          {d.ownerAssertions.map((a) => <div key={a.providerPaymentId} className="kv"><span>{a.method ?? 'Recorded payment'}{a.date ? ` · ${day(a.date.slice(0, 10))}` : ''}<br /><span className="small muted">Owner assertion on PayPal. Not a receipt, not cash.</span></span><span className="num">{money(a.amount)}</span></div>)}
        </div>
      )}
      {d.receipts.length > 0 && (
        <div className="sec"><h4>Receipts</h4>
          {d.receipts.map((x) => <div key={x.captureId} className="kv"><span><button className="linkbtn" onClick={() => onReceipt(x)}>PayPal capture · {dateTime(x.capturedAt)}</button></span><span className="num">{money(x.gross)}</span></div>)}
        </div>
      )}
      <div className="sec events"><h4>Activity</h4>{d.audit.length ? d.audit.map((a) => (
        <div key={a.eventId} className="e"><div className="kv small"><strong>{a.event}</strong><span className="muted">{dateTime(a.when)}</span></div><div className="small muted">{a.by}{a.allowedBy ? ` · allowed by ${a.allowedBy}` : ''} · {a.result}</div></div>
      )) : <span className="muted">None</span>}</div>
      {confirm && (
        <Dialog kicker="Receivables · Issue on PayPal" title={`Issue to ${inv.customerName} for ${money(inv.amount)}?`} onClose={() => setConfirm(false)}
          footer={<><button className="btn" onClick={() => setConfirm(false)}>Cancel</button><button className="btn primary" onClick={issue} disabled={busy}>Issue on PayPal</button></>}>
          <div><h5>CONSEQUENCE</h5>Creates the invoice on PayPal sandbox with the next HR- number and makes a payer link. No email is sent. Not cash until PayPal confirms a payment.</div>
          <div><h5>SCOPE</h5>This invoice only.</div>
        </Dialog>
      )}
    </Panel>
  );
}

function ReceiptPanel({ invoiceId, captureId, onClose, onInvoice }: { invoiceId: string; captureId: string; onClose: () => void; onInvoice: () => void }) {
  const q = useLoad(() => call('getInvoice', { params: { id: invoiceId } }), [invoiceId]);
  const x = q.data?.receipts.find((r) => r.captureId === captureId);
  if (q.error) return <Panel kicker="Receipt" title="Couldn't load receipt" onClose={onClose}><div className="sec"><Failed error={q.error} /></div></Panel>;
  if (!x) return <Panel kicker="Receipt" title={q.data ? 'Receipt not found' : 'Loading…'} onClose={onClose}>{!q.data && <Loading />}</Panel>;
  return (
    <Panel kicker="Receipt · PayPal" onClose={onClose} title={`${x.customerName} · ${money(x.gross)}`}
      status={<div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>{x.reversalDetected ? <Pill tone="amber" glyph="!">Refund detected</Pill> : <Pill tone="green" glyph="✓">Captured</Pill>}<span className="muted small">Receivables › Incoming</span></div>}>
      <div className="facts">
        <div><div className="muted small">Gross</div><div className="v num">{money(x.gross)}</div></div>
        <div><div className="muted small">Fee</div><div className="v num">−{money(x.fee)}</div><div className="muted small">PayPal-reported</div></div>
        <div><div className="muted small">Net</div><div className="v num">{money(x.net)}</div></div>
      </div>
      <div className="sec"><h4>Status</h4>
        <div>✓ Captured {dateTime(x.capturedAt)} · PayPal confirmed the payment, checked {dateTime(x.retrievedAt)}</div>
        {x.inReportedBalance === 'INCLUDED'
          ? <div>✓ In PayPal reported balance as of {dateTime(x.reportAsOf)}</div>
          : <div style={{ color: 'var(--amber)' }}>◔ Captured · not yet confirmed in a PayPal report{x.inclusionReason ? ` (${x.inclusionReason})` : ''}</div>}
        {x.reversalDetected && <div className="neg">! Refund detected · amount not yet verified</div>}
        {x.refunds.map((f) => <div key={f.transactionId}>Refund {money(f.amount)} · {dateTime(f.at)} (PayPal report)</div>)}
        <div className="small muted">Refunds last checked {dateTime(x.refundsCheckedAt)}</div>
      </div>
      <div className="sec"><h4>Allocation</h4>
        {(x.allocations.length ? x.allocations : [{ claim: 'WHOLE' as const, gross: x.gross }]).map((a) => <div key={a.claim} className="kv"><span><button className="linkbtn" onClick={onInvoice}>{x.invoiceNumber}</button>{a.claim === 'UNDISPUTED' ? ' · undisputed part' : a.claim === 'UNALLOCATED' ? ' · toward the disputed amount, not applied (your decision)' : ''}</span><span className="num">{money(a.gross)}</span></div>)}
        <div className="small muted">Gross allocated to the invoice. The fee is a cost; the invoice is not short-paid.</div>
      </div>
      <div className="sec"><h4>Evidence</h4>
        <div className="kv small"><span>PayPal capture</span><span>{x.captureId}</span></div>
        <div className="kv small"><span>PayPal invoice</span><span>{x.ppInvoiceId}</span></div>
        <div className="kv small"><span>Retrieved</span><span>{dateTime(x.retrievedAt)}</span></div>
      </div>
    </Panel>
  );
}

/** UI-AR-18 (S5-D15): answers are labels. "Yes, PayPal transfer" creates no receipt and moves no cash; it can be changed. */
function Reconciliation() {
  const q = useLoad(() => call('getReconciliation'));
  const { toast } = useApp();
  const [err, setErr] = useState<string | null>(null);
  const answer = async (t: { bankTxId: string; version: number }, a: 'TRANSFER' | 'NOT_TRANSFER') => {
    setErr(null);
    try { await call('answerMatch', { params: { id: t.bankTxId }, ifMatch: t.version, body: { answer: a } }); toast('Answer saved · a label only; no cash moved'); q.reload(); }
    catch (e) { setErr((e as Error).message); }
  };
  if (q.error) return <Failed error={q.error} />;
  if (!q.data) return <Loading />;
  const d = q.data;
  return (
    <>
      <div className="box list">
        <div className="sh">Bank lines that look like PayPal transfers</div>
        {d.transfers.length === 0 ? <div className="empty muted">None in the recent bank activity.</div> : d.transfers.map((t) => (
          <div key={t.bankTxId} className="row">
            <span>{t.description}<br /><span className="muted small">{day(t.date)}{t.answer ? ` · you said ${t.answer === 'TRANSFER' ? 'yes, a PayPal transfer' : 'no, not a transfer'}` : ''}</span></span>
            <span className="num">{t.amount ? money(t.amount) : '—'}</span>
            <span>{t.answer
              ? <button className="btn" onClick={() => answer(t, t.answer === 'TRANSFER' ? 'NOT_TRANSFER' : 'TRANSFER')}>Change answer</button>
              : <><button className="btn" onClick={() => answer(t, 'TRANSFER')}>Yes, PayPal transfer</button> <button className="btn" onClick={() => answer(t, 'NOT_TRANSFER')}>No, not a transfer</button></>}</span>
          </div>
        ))}
      </div>
      <div className="box list">
        <div className="sh">Captured · awaiting PayPal's report</div>
        {d.awaitingReport.length === 0 ? <div className="empty muted">Nothing waiting.</div> : d.awaitingReport.map((x) => <div key={x.captureId} className="row"><span>{x.invoiceNumber}<br /><span className="muted small">captured {dateTime(x.capturedAt)}</span></span><span className="num">{money(x.net)} net</span><span className="small muted">Counted in Expected only until PayPal reports it</span></div>)}
      </div>
      {d.unallocated.length > 0 && <div className="box list"><div className="sh">Received toward a disputed amount</div>{d.unallocated.map((x) => <div key={x.captureId} className="row"><span>{x.invoiceNumber}</span><span className="num">{money(x.amount)}</span><span className="small muted">Recorded, not applied · your decision</span></div>)}</div>}
      {d.holds.length > 0 && <div className="box list"><div className="sh">Held for reconciliation</div>{d.holds.map((x) => <div key={x.invoiceId} className="row"><span>{x.invoiceNumber}</span><span className="small" style={{ color: 'var(--amber)' }}>‖ {x.text}</span><span /></div>)}</div>}
      {err && <div className="err-banner">{err}</div>}
      <div className="foot">{d.note}</div>
    </>
  );
}

type Work = Rec['work'][number];
/** UI-AR-01/02/04 collection work: ranked by the server; views filter on server flags only. */
function Work({ r, onOpen, selected }: { r: Rec; onOpen: (invoiceId: string) => void; selected: string | null }) {
  const [view, setView] = useState<'all' | 'overdue' | 'you'>('all');
  const rows = r.work.filter((w) => view === 'all' || (view === 'overdue' ? w.overdueDays > 0 : w.whoActs !== 'HEADROOM'));
  return (
    <>
      <div className="tabs" role="tablist" style={{ marginTop: 0 }}>
        {([['all', 'All'], ['overdue', 'Overdue'], ['you', 'Needs you']] as const).map(([k, l]) => <button key={k} role="tab" aria-selected={view === k} className={view === k ? 'on' : ''} onClick={() => setView(k)}>{l}</button>)}
      </div>
      <div className="small muted" style={{ margin: '6px 0' }}>{r.workPopulation}</div>
      <div className="box list">
        {rows.length === 0 ? <div className="empty muted">Nothing here.</div> : rows.map((w) => (
          <button key={w.invoiceId} className={`row work-row ${selected === w.invoiceId ? 'on' : ''}`} onClick={() => onOpen(w.invoiceId)}>
            <span className="muted">{w.rank}</span>
            <span><strong>{w.customer}</strong><br /><span className="muted small">{w.invoiceNumber} · due {shortDay(w.dueOn)}{w.overdueDays ? ` · ${w.overdueDays} days overdue` : ''}</span></span>
            <span className="num">{money(w.open)}{w.disputed ? <><br /><span className="small muted">undisputed {money(w.undisputedOpen!)} · disputed {money(w.disputed)}</span></> : null}</span>
            <span className="small">{w.expected}{w.needBy ? <><br /><span className="muted">needed by {shortDay(w.needBy)}</span></> : null}</span>
            <span className="small">{w.nextStep}</span>
            <span><Pill tone={w.whoActs === 'HEADROOM' ? 'brand' : 'amber'} glyph={w.whoActs === 'YOU' ? '✋' : '◐'}>{w.whoActs === 'YOU' ? 'You handle it' : w.whoActs === 'NEEDS_YOU' ? 'Needs you' : 'Headroom'}</Pill></span>
          </button>
        ))}
      </div>
    </>
  );
}

/** UI-AR-05/07/19: why first, limits, drafts and who allowed them, take over; the dispute panel's approval goes through the Plan. */
export function WorkPanel({ w, onClose, reload }: { w: Work; onClose: () => void; reload: () => void }) {
  const { toast } = useApp();
  const [err, setErr] = useState<string | null>(null);
  const p = w.panel;
  const take = p.owner === 'YOU' ? 'HEADROOM' : 'YOU';
  const owner = async () => { setErr(null); try { await call('setThreadOwner', { params: { id: w.customerId }, ifMatch: p.ownerVersion, body: { owner: take } }); toast(take === 'YOU' ? 'You own this customer now' : 'Handed back to Headroom'); reload(); } catch (e) { setErr((e as Error).message); } };
  return (
    <Panel onClose={onClose} kicker={`Collection work · #${w.rank}`} title={w.customer}>
      <div className="sec"><h4>Why first</h4><div>{p.why ?? 'Not in the running plan.'}</div>{p.citations.map((c) => <div key={c} className="small muted">{c}</div>)}</div>
      {p.claim && (
        <div className="sec"><h4>Dispute</h4>
          <div className="kv"><span>Invoice</span><span className="num">{money(p.claim.invoice)}</span></div>
          <div className="kv"><span>Undisputed (acknowledged)</span><span className="num">{money(p.claim.undisputed)}</span></div>
          <div className="kv"><span>{p.claim.disputedText}</span><span className="num">{money(p.claim.disputed)}</span></div>
          <div className="small">“{p.claim.acknowledgement.quote}” · {p.claim.acknowledgement.from}, {shortDay(p.claim.acknowledgement.on)} <span className="muted">· {p.claim.basis === 'SEEDED' ? 'sample record' : 'from their email, confirmed by you'}</span></div>
          <div className="small">{p.claim.cashConsequence}</div>
          {p.claim.approval ? <div className="small"><strong>{p.claim.approval}</strong></div> : <a className="btn primary" href={`/plan${w.actionId ? `#act-${w.actionId}` : ''}`}>Approve in plan…</a>}
        </div>
      )}
      <div className="sec"><h4>Limits</h4><div className="small">{p.newDateLimit}</div></div>
      <div className="sec"><h4>Messages</h4>{p.drafts.length === 0 ? <div className="small muted">None.</div> : p.drafts.map((d) => <div key={d.subject} className="small"><strong>{d.subject}</strong> · {d.label}<br /><span className="muted">Allowed by: {d.allowedBy}</span></div>)}</div>
      <div className="sec"><button className="btn" onClick={owner}>{take === 'YOU' ? 'Take over' : 'Hand back'}</button>{p.owner === 'YOU' && <div className="small">You handle it · Headroom sends and changes nothing on PayPal for this customer.</div>}</div>
      {err && <div className="err-banner">{err}</div>}
    </Panel>
  );
}

/** S7 R4: a dispute read from the customer's own email. You confirm the split (it decides what may be collected) or dismiss it. */
function DisputeSection({ invoiceId, dsp, onDone }: { invoiceId: string; dsp: NonNullable<ResponseOf<'getInvoice'>['dispute']>; onDone: () => void }) {
  const { toast, refresh } = useApp();
  const [dis, setDis] = useState(dsp.disputed ? String(dsp.disputed.minor / 100) : '');
  const [und, setUnd] = useState(dsp.undisputed ? String(dsp.undisputed.minor / 100) : '');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [key] = useState(() => crypto.randomUUID());
  const go = async (f: () => Promise<unknown>, ok: string) => {
    setBusy(true); setErr(null);
    try { await f(); toast(ok); refresh(); onDone(); } catch (e) { setErr(e instanceof ApiFailure ? e.error.message : (e as Error).message); } finally { setBusy(false); }
  };
  const minor = (t: string) => Math.round(Number(t) * 100);
  return (
    <div className="sec dispute-sec">
      <h4>Dispute waiting for you</h4>
      <div className="mail-card">
        <div className="small"><strong>From</strong> {dsp.from}</div>
        <div className="small"><strong>Subject</strong> {dsp.subject}</div>
        <div className="small muted">{dateTime(dsp.receivedAt)}</div>
        <blockquote className="quote">“{dsp.quote}”</blockquote>
      </div>
      <div className="small muted" style={{ margin: '6px 0' }}>{dsp.disputed && dsp.undisputed ? `Headroom read these amounts from the email${dsp.derived ? ` (the ${dsp.derived.toLowerCase()} part is the rest of the ${money({ currency: 'USD', minor: dsp.openMinor })} open)` : ''}. Check them.` : `Enter the two parts: together they must make the ${money({ currency: 'USD', minor: dsp.openMinor })} still open (Headroom couldn’t read both from the email, or a payment arrived since).`} Nothing is collected on this invoice until you decide.</div>
      <div className="dl-pair">
        <label className="field"><span>Disputed (USD)</span><input inputMode="decimal" aria-label="Disputed amount" value={dis} onChange={(e) => setDis(e.target.value)} /></label>
        <label className="field"><span>Accepted, undisputed (USD)</span><input inputMode="decimal" aria-label="Undisputed amount" value={und} onChange={(e) => setUnd(e.target.value)} /></label>
      </div>
      <div className="act-btns" style={{ marginTop: 8 }}>
        <button className="btn primary" disabled={busy || !dis || !und} onClick={() => go(() => call('confirmDispute', { params: { id: invoiceId }, idempotencyKey: key, body: { proposalId: dsp.proposalId, disputedMinor: minor(dis), undisputedMinor: minor(und), invoiceVersion: dsp.invoiceVersion } }), 'Split confirmed · no permission created')}>Confirm split</button>
        <button className="btn" disabled={busy} onClick={() => go(() => call('dismissDispute', { params: { id: invoiceId }, body: { proposalId: dsp.proposalId } }), 'Marked not a dispute')}>Not a dispute</button>
      </div>
      {err && <div className="err-banner">{err}</div>}
    </div>
  );
}
