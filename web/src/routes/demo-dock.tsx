// Walkthrough dock (owner, 4–5 Nov 2026): one corner panel for both ways to see the product, so there is one thing to learn. The same
// eight beats, dots and Next drive the recorded run (golden.ts, replayed in this browser) and the live sandbox run (the server's
// `journey`: where the run is and what Next does there: bill, confirm Keller's address, approve, a customer pays, the next scheduled
// step, or wait for PayPal). The approval is always the owner's own: the dock takes them to the plan, then opens the plan's real Approve
// dialog. Judges sign in to the recorded run; Live takes the shared live run (takeLiveRun) with no new sign-in; it resets itself 10
// minutes after its holder leaves, and while it resets the dock says so with the server's estimate. H hides the dock; – makes it a pill.
import { useEffect, useState } from 'react';
import type { ResponseOf } from '@headroom/contracts';
import { ApiFailure, call } from '../api/client.ts';
import { goldenGo, goldenIndex, goldenOn, goldenStart, goldenStep, goldenStop } from '../api/golden.ts';
import { freshToken, groups, token } from '../auth.ts';
import { useApp } from '../data.ts';

type Run = ResponseOf<'getDemoRun'>;
/** What each beat shows (the state after it), and where to look. No amounts: the screens carry them. */
const BEATS: { title: string; text: string; look: [string, string] }[] = [
  { title: 'A healthy-looking cash position', text: 'Cash stays above the reserve across the 42-day forecast. Nothing needs the owner yet.', look: ['/cash', 'Cash'] },
  { title: 'A supplier bill arrives', text: 'Keller Drafting’s bill came in, due earlier than forecast. The business’s own rule verified it; the forecast now dips below the reserve, so Headroom drafted a plan.', look: ['/overview', 'the alert on Overview'] },
  { title: 'Plan approved', text: 'The revision is running. Each action runs only at its own time, after its own checks.', look: ['/plan', 'Plan'] },
  { title: 'Headroom asks', text: 'Reminders went to the overdue, undisputed customers.', look: ['/plan', 'Plan › Since you approved'] },
  { title: 'Pellow Dental Group pays', text: 'Paid on PayPal’s hosted page; it counts once PayPal’s capture is verified. The discount fallback stays scheduled.', look: ['/plan', 'the plan’s meter'] },
  { title: 'Harrow pays the undisputed part', text: 'Only the undisputed amount was asked for. The disputed part stays open.', look: ['/receivables', 'Receivables'] },
  { title: 'The discount isn’t needed', text: 'At its check, verified funds already cover the gap, so the Mercer discount is never offered. That margin is kept.', look: ['/plan', 'Plan'] },
  { title: 'Keller is paid', text: 'The supplier payout ran once PayPal’s own balance could fund it, and PayPal confirmed it reached Keller.', look: ['/payables', 'Payables'] },
];
const SIZE = 'hr.dock';
const at = (iso: string) => new Date(iso).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
const errText = (e: unknown) => (e instanceof ApiFailure ? e.error.message : String(e));

export function DemoDock({ onControls }: { onControls: () => void }) {
  const { nav, toast, refresh } = useApp();
  const rec = goldenOn();
  const judge = groups().includes('judge');
  const [, tick] = useState(0);
  const [steps, setSteps] = useState<{ name: string; trigger: string }[]>([]);
  const [size, setSize] = useState(() => { try { return sessionStorage.getItem(SIZE) ?? 'open'; } catch { return 'open'; } });
  const [tab, setTab] = useState<'REC' | 'LIVE'>(rec ? 'REC' : 'LIVE');
  const [run, setRun] = useState<Run | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const resize = (s: string) => { setSize(s); try { sessionStorage.setItem(SIZE, s); } catch { /* per-tab convenience only */ } };
  const load = () => call('getDemoRun').then(setRun, () => {});

  useEffect(() => { if (rec) void goldenIndex().then((i) => setSteps(i.steps)); }, [rec]);
  useEffect(() => { const f = () => tick((x) => x + 1); document.addEventListener('visibilitychange', f); return () => document.removeEventListener('visibilitychange', f); }, []);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if ((e.key === 'h' || e.key === 'H') && !(e.target as HTMLElement)?.closest?.('input, textarea, select')) resize(size === 'hidden' ? 'open' : 'hidden'); };
    addEventListener('keydown', k); return () => removeEventListener('keydown', k);
  }, [size]);
  // The live run's status. While on it, the poll is also the holder's sign of life (the 10-minute idle clock restarts).
  useEffect(() => {
    if (!judge || !token()) return;
    load(); const t = setInterval(load, rec ? 20_000 : 5_000); return () => clearInterval(t);
  }, [judge, rec]);

  const goLive = async () => {
    setTab('LIVE'); setErr(null);
    await freshToken(); // a sign-in that lapsed while the tab slept renews here, so a judge isn't sent to sign in again
    if (!groups().includes('judge')) return goldenStop(); // presenter / signed-out viewer: the stage's own live app (sign-in if needed)
    setBusy(true);
    try { await call('takeLiveRun', { body: {} }); goldenStop(); }
    catch (e) {
      // Resetting / in use: the status below already says why, with the expected time; only other failures show as errors.
      if (!(e instanceof ApiFailure && ['RESET_IN_PROGRESS', 'MERCHANT_LEASED'].includes(e.error.code))) setErr(errText(e));
      load();
    }
    finally { setBusy(false); }
  };
  const act = async (f: () => Promise<unknown>, ok: string | null) => {
    setBusy(true); setErr(null);
    try { await f(); if (ok) toast(ok); refresh(); await load(); } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };
  const resetNow = () => { setConfirm(false); void act(() => call('startDemoRun', { body: {} }), 'Resetting the live run'); };

  if (!rec && !judge) return null;
  if (size === 'hidden') return null;
  const live = run?.live ?? null;
  const journey = !rec && live?.state === 'MINE' ? run?.journey ?? null : null;
  const n = rec ? goldenStep() : journey?.step ?? 0;
  const total = BEATS.length;
  const liveTag = live ? { READY: 'ready', MINE: 'yours', IN_USE: 'in use', RESETTING: 'resetting', BLOCKED: 'unavailable' }[live.state] : null;
  if (size === 'min') return <button className="dock-pill" onClick={() => resize('open')}>{rec ? 'Recorded run' : 'Live run'} · {n + 1}/{total} ›</button>;

  const beat = BEATS[n] ?? BEATS[0];
  const onPlan = location.pathname === '/plan';
  // Recorded: the next step is the owner's approval. Live: the server says the owner confirms Keller's address, then approves.
  const move = rec ? (steps[n + 1]?.trigger === 'post' ? 'APPROVE' : null) : journey && ['CONFIRM_PAYEE', 'APPROVE'].includes(journey.next.kind) ? journey.next.kind : null;
  const yourMove = move === 'CONFIRM_PAYEE' ? (
    <div className="dock-move">
      <div className="kicker">Your move</div>
      <p>Before approving, confirm Keller’s PayPal address in Payables. Headroom only pays an address you’ve checked.</p>
      <div className="dock-btns"><button className="btn primary" onClick={() => nav('/payables')}>Take me to Payables ›</button></div>
    </div>
  ) : move === 'APPROVE' ? (
    <div className="dock-move">
      <div className="kicker">Your move</div>
      {onPlan
        ? <p>Look over each action and its sources. <strong>Approve…</strong> shows every approval the plan asks for, each with why; nothing happens until you confirm there.</p>
        : <p>Headroom drafted a plan. Open it to see what it proposes and why.</p>}
      <div className="dock-btns">
        {rec && <button className="btn" onClick={() => goldenGo(n - 1)}>‹ Back</button>}
        {onPlan ? <button className="btn primary" onClick={() => dispatchEvent(new Event('hr:approve'))}>Approve… ›</button>
          : <button className="btn primary" onClick={() => nav('/plan')}>Take me to the plan ›</button>}
      </div>
    </div>
  ) : null;

  // Live Next: the server's next step for this run, run by the same calls as the Sandbox controls drawer.
  const liveNext = (j: NonNullable<Run['journey']>) => {
    const k = j.next.kind;
    if (k === 'BILL') return act(() => call('demoBill', { body: {} }), 'Keller’s bill is in: Headroom is reading it');
    if (k === 'PAY') return act(() => call('demoCollect', { body: { actionId: j.next.actionId! } }), `${j.next.label}…`);
    if (k === 'ADVANCE') return act(() => call('demoAdvance', { body: {} }), null);
  };

  const beatBody = (
    <>
      <div className="dock-dots" aria-hidden>{Array.from({ length: total }, (_, i) => <span key={i} className={i <= n ? 'on' : ''} />)}</div>
      <h4>{beat.title}</h4>
      <p>{beat.text}</p>
      {yourMove ?? (
        <>
          <button className="linkbtn" onClick={() => nav(beat.look[0])}>Look at {beat.look[1]} ›</button>
          {rec ? (
            <div className="dock-btns">
              <button className="btn" onClick={() => goldenGo(n - 1)} disabled={n === 0}>‹ Back</button>
              {steps[n + 1] ? <button className="btn primary" onClick={() => goldenGo(n + 1)}>Next: {BEATS[n + 1]?.title ?? steps[n + 1].name} ›</button>
                : <><button className="btn" onClick={goldenStart}>Start over</button><button className="btn primary" onClick={goLive}>Try it live ›</button></>}
            </div>
          ) : journey && (
            journey.next.kind === 'WAIT' ? (
              <div className="dock-move" role="status">
                <p>{journey.next.label}</p>
                <div className="dock-btns"><button className="btn" disabled={busy} onClick={() => act(() => call('demoReconcile', { body: {} }), 'Checking PayPal and the bank now')}>Check PayPal now</button></div>
              </div>
            ) : journey.next.kind === 'DONE' ? <div className="dock-btns"><button className="btn primary" onClick={goldenStart}>Watch the recorded run</button></div>
            : <div className="dock-btns"><button className="btn primary" disabled={busy} onClick={() => liveNext(journey)}>Next: {journey.next.label} ›</button></div>
          )}
        </>
      )}
    </>
  );

  return (
    <aside className="dock" aria-label="Walkthrough controls">
      <div className="dock-h">
        <div className="dock-tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'REC'} className={tab === 'REC' ? 'on' : ''} onClick={() => (rec ? setTab('REC') : goldenStart())}>Recorded</button>
          <button role="tab" aria-selected={tab === 'LIVE'} className={tab === 'LIVE' ? 'on' : ''} disabled={busy} onClick={() => (rec ? goLive() : setTab('LIVE'))}>Live{liveTag ? ` · ${liveTag}` : ''}</button>
        </div>
        {(rec ? tab === 'REC' : !!journey) && <span className="dock-count">{n + 1} / {total}</span>}
        <button className="dock-x" aria-label="Minimize" onClick={() => resize('min')}>–</button>
      </div>

      {tab === 'REC' && rec && (
        <div className="dock-b">
          {beatBody}
          <div className="dock-foot">Recorded from the app, replayed in your browser · <kbd>]</kbd> next · <kbd>[</kbd> back · <kbd>H</kbd> hide</div>
        </div>
      )}

      {tab === 'LIVE' && (
        <div className="dock-b">
          {!token() ? <><h4>Live sandbox run</h4><p>Sign in with your judge login to use it.</p></>
            : !live ? <p className="muted">Checking the live run…</p>
            : live.state === 'MINE' && !rec ? (
              <>
                {journey ? beatBody : <><h4>Getting your run ready…</h4><p>Headroom is setting up the sandbox business on PayPal.</p></>}
                <div className="dock-foot">
                  Live PayPal sandbox: real invoices, hosted payments and a payout · <button className="linkbtn" onClick={onControls}>More controls</button> ·{' '}
                  {confirm ? <button className="linkbtn" disabled={busy} onClick={resetNow}>Confirm reset (ready again in about 5 hours)</button>
                    : <button className="linkbtn" disabled={busy} onClick={() => setConfirm(true)}>Reset…</button>}
                  <br />Resets by itself 10 minutes after you leave. A reset waits for PayPal to reconcile the run’s money (about 3–5 hours).
                </div>
              </>
            ) : live.state === 'RESETTING' ? (
              <>
                <h4>Resetting from the previous run</h4>
                <p>This needs PayPal to reconcile the last run’s money{live.readyAt ? <>, so it’s expected to be ready about <strong>{at(live.readyAt)}</strong></> : ''}.</p>
                {live.text && <div className="dock-foot">{live.text}</div>}
              </>
            ) : live.state === 'IN_USE' || live.state === 'BLOCKED' ? <><h4>Live run unavailable</h4><p>{live.text}</p></>
            : <><h4>Live sandbox run · ready</h4><p>The same eight beats, on the real PayPal sandbox: invoices, hosted payments, captures and a supplier payout. It resets by itself 10 minutes after you leave.</p>
                <div className="dock-btns"><button className="btn primary" disabled={busy} onClick={goLive}>Start the live run ›</button></div></>}
          {err && <div className="err-banner" style={{ marginTop: 8 }}>{err}</div>}
          {(rec || live?.state !== 'MINE') && <div className="dock-btns"><button className="btn" onClick={() => (rec ? setTab('REC') : goldenStart())}>{rec ? '‹ Back to the recorded run' : 'Watch the recorded run'}</button></div>}
        </div>
      )}
    </aside>
  );
}
