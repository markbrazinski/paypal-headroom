// Judge demo drawer (S07 S7-D18 as revised by §6.18 R3/R7/R10). Judges and the operator only; product pages are untouched. Everything
// shown comes from the server (getDemoRun, getDemoEffects); controls call the demo lane, which enforces the role and the lease.
// Payments are made by the sandbox AUTOMATED-PAYER on PayPal's own page; a receipt appears only once PayPal's GETs show it, and money
// captured after PayPal's last report counts once PayPal confirms the capture, labelled "confirmed by PayPal · not yet in its report".
import { useEffect, useState } from 'react';
import type { ResponseOf } from '@headroom/contracts';
import { ApiFailure, call } from '../api/client.ts';
import { useApp } from '../data.ts';
import { dateTime, money } from '../format.ts';

type Run = ResponseOf<'getDemoRun'>;
const PHASE: Record<string, string> = {
  QUEUED: 'Starting…', CLAIMED: 'Starting…', SUBMITTING: 'Paying on PayPal…', SUBMITTED_UNVERIFIED: 'Checking with PayPal…', VERIFIED_PAID: 'Paid', VERIFIED_NOT_PAID: 'Not paid',
  NOT_SUBMITTED: 'Not paid', UNKNOWN_UNRESOLVED: 'Check PayPal', REFUSED: 'Not paid',
};

export function DemoDrawer({ onClose }: { onClose: () => void }) {
  const { toast, refresh } = useApp();
  const [d, setD] = useState<Run | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fx, setFx] = useState<ResponseOf<'getDemoEffects'>['rows'] | null>(null);
  const load = () => call('getDemoRun').then(setD, (e) => setErr(e instanceof ApiFailure ? e.error.message : String(e)));
  useEffect(() => { load(); const t = setInterval(load, 2_000); return () => clearInterval(t); }, []);
  const act = async (f: () => Promise<unknown>, ok: string) => {
    setBusy(true); setErr(null);
    try { await f(); toast(ok); refresh(); await load(); } catch (e) { setErr(e instanceof ApiFailure ? e.error.message : String(e)); } finally { setBusy(false); }
  };
  // O7 / R3 "Customers pay": the asked customers pay in plan order, one browser at a time; the next starts 4 s after PayPal's GETs
  // show the previous receipt. A failure stops the sequence (earlier receipts stand). The server checks every step.
  const [seq, setSeq] = useState<string | null>(null);
  const customersPay = async () => {
    const todo = (d?.collections ?? []).filter((c) => c.canPay);
    setBusy(true); setErr(null);
    try {
      for (const [i, c] of todo.entries()) {
        if (i) { setSeq(`Next customer in 4 s…`); await new Promise((r) => setTimeout(r, 4_000)); }
        setSeq(`${c.counterparty} is paying on PayPal…`);
        await call('demoCollect', { body: { actionId: c.actionId } });
        let a: Run['collections'][number]['attempt'] = null;
        while (!a || !['VERIFIED_PAID', 'VERIFIED_NOT_PAID', 'NOT_SUBMITTED', 'REFUSED', 'UNKNOWN_UNRESOLVED'].includes(a.phase)) {
          await new Promise((r) => setTimeout(r, 2_000));
          const v = await call('getDemoRun'); setD(v); refresh();
          a = v.collections.find((x) => x.actionId === c.actionId)?.attempt ?? null;
        }
        if (a.phase !== 'VERIFIED_PAID') { setErr(`${c.counterparty}: ${a.text}. Earlier receipts stand.`); break; }
        toast(`${c.counterparty} paid · verified by PayPal`);
      }
    } catch (e) { setErr(e instanceof ApiFailure ? e.error.message : String(e)); }
    finally { setSeq(null); setBusy(false); refresh(); }
  };
  const reset = d?.reset;
  const resetting = !!reset && !['DONE', 'BLOCKED'].includes(reset.state);
  return (
    <aside className="demo-drawer" role="dialog" aria-label="Sandbox controls">
      <div className="box-h"><h3>Sandbox controls</h3><button className="linkbtn" onClick={onClose}>Close</button></div>
      {!d ? <div className="box-b muted">Loading…</div> : (
        <div className="box-b" style={{ display: 'grid', gap: 12 }}>
          <div>
            <div className="kicker">{d.tenantLabel}</div>
            <div>{d.run ? <>Run {d.run.runId} · <strong>{d.run.state.toLowerCase()}</strong>{d.run.blockers.length ? ` · ${d.run.blockers.join('; ')}` : ''}</> : 'No run yet'}</div>
            <div className="small muted">{d.lease.mine ? `You hold the sandbox merchant${d.lease.until ? ` until about ${dateTime(d.lease.until)}` : ''}` : d.lease.held ? `In use by another run${d.lease.until ? ` until about ${dateTime(d.lease.until)}` : ''}` : 'The sandbox merchant is free'}</div>
            {d.clock.virtualNow && <div className="small">Sandbox clock · {dateTime(d.clock.virtualNow)} · PayPal and bank times are real</div>}
          </div>

          <div className="act-btns">
            {d.view === 'SHOWCASE'
              ? <button className="btn" disabled={busy} onClick={() => act(() => call('setDemoView', { body: { view: 'MY_RUN' } }), 'Back to your run')}>Back to my run</button>
              : <button className="btn" disabled={busy} onClick={() => act(() => call('setDemoView', { body: { view: 'SHOWCASE' } }), 'Watching the finished showcase run (read-only)')}>View the finished showcase run</button>}
            <button className="btn primary" disabled={busy || !d.canStart || resetting} title={d.startBlocked ?? undefined} onClick={() => act(() => call('startDemoRun', { body: {} }), 'Starting a fresh run…')}>Start a new run</button>
            {d.lease.mine && <button className="btn" disabled={busy || resetting} onClick={() => act(() => call('endDemoRun', { body: {} }), 'Run ended; the merchant is free')}>End my run</button>}
          </div>
          {d.startBlocked && <div className="small muted">{d.startBlocked}</div>}

          {reset && (
            <div className="sec">
              <h4>Fresh start · {reset.state.toLowerCase().replace(/_/g, ' ')}</h4>
              {reset.waiting && <div className="small">{reset.waiting}</div>}
              {reset.blocker && <div className="err-banner">{reset.blocker.text}</div>}
              {reset.housekeeping.map((h) => <div key={h.n} className="small">Housekeeping payout {h.n}: {money(h.amount)}{h.fee ? ` + fee ${money(h.fee)}` : ''} · {h.state.toLowerCase()}{h.itemId ? ` · PayPal item ${h.itemId}` : ''}</div>)}
              {reset.landing && reset.state === 'DONE' && <div className="small">Opening {money(reset.landing)}{reset.housekeeping.length ? ' · verified by the housekeeping payout' : ''}</div>}
            </div>
          )}

          {(d.lease.mine || d.role === 'OPERATOR') && d.view === 'MY_RUN' && !resetting && (
            <>
              <div className="act-btns">
                <button className="btn" disabled={busy} onClick={() => act(() => call('demoBill', { body: {} }), 'Keller’s bill is in: verify and accept it in Payables')}>Bring in Keller’s bill</button>
                <button className="btn" disabled={busy || !d.clock.next} title={d.clock.next ? `Next: ${d.clock.next.label} · ${dateTime(d.clock.next.at)}` : 'Nothing scheduled'} onClick={() => act(() => call('demoAdvance', { body: {} }), 'Ran the next step')}>Advance to next step{d.clock.next ? ` · ${d.clock.next.label}` : ''}</button>
                <button className="btn" disabled={busy} onClick={() => act(() => call('demoReconcile', { body: {} }), 'Checking PayPal and the bank now')}>Refresh from PayPal and the bank</button>
                <button className="btn" disabled={busy} title="Sandbox fixture: Keller answers Headroom's ask from the test inbox, agreeing to the split; it arrives as a normal reply" onClick={() => act(() => call('demoKellerReply', { body: {} }), 'Keller’s reply is on its way: it shows up in Payables in about a minute')}>Keller replies: agrees to split</button>
              </div>
              <div className="sec">
                <h4>Customers pay</h4>
                {d.collections.length === 0 && <div className="small muted">Approve a plan first: customers pay once Headroom has asked them.</div>}
                {d.collections.some((c) => c.canPay) && <div className="act-btns"><button className="btn primary" disabled={busy} onClick={customersPay}>Customers pay ({d.collections.filter((c) => c.canPay).length}, in order)</button></div>}
                {seq && <div className="small" role="status">{seq}</div>}
                {d.collections.map((c) => (
                  <div key={c.actionId} className="kv">
                    <span>{c.counterparty} · {money(c.amount)}<br /><span className="small muted">{c.attempt ? `${PHASE[c.attempt.phase] ?? c.attempt.phase} · ${c.attempt.text}` : c.why ?? 'Pays on PayPal’s own page (sandbox buyer)'}</span></span>
                    <span><button className="btn" disabled={busy || !c.canPay} onClick={() => act(() => call('demoCollect', { body: { actionId: c.actionId } }), `${c.counterparty} is paying on PayPal…`)}>Pay on PayPal</button></span>
                  </div>
                ))}
                <div className="small muted">Paid money counts as soon as PayPal confirms the capture; PayPal’s balance report lists it a few hours later (shown as “confirmed by PayPal · not yet in its report”).</div>
              </div>
            </>
          )}

          <div className="sec">
            <h4>Effects log</h4>
            {!fx ? <button className="linkbtn" onClick={() => call('getDemoEffects').then((r) => setFx(r.rows), (e) => setErr(String(e)))}>Show every PayPal and bank effect</button>
              : fx.length === 0 ? <div className="small muted">Nothing yet.</div>
              : <table className="ledger small"><tbody>{fx.map((r) => <tr key={`${r.kind}:${r.key}`}><td>{r.kind.toLowerCase().replace(/_/g, ' ')}{r.label ? ` · ${r.label}` : ''}</td><td>{r.state.toLowerCase()}</td><td className="mono">{r.providerIds.join(' · ')}</td><td>{r.at ? dateTime(r.at) : ''}</td></tr>)}</tbody></table>}
          </div>
          {err && <div className="err-banner">{err}</div>}
        </div>
      )}
    </aside>
  );
}
