import { StrictMode, useCallback, useEffect, useRef, useState } from 'react';
import { DemoDrawer } from './routes/demo-drawer.tsx';
import { DemoDock } from './routes/demo-dock.tsx';
import { createRoot } from 'react-dom/client';
import { AllCommunityModule, ModuleRegistry } from 'ag-grid-community';
import './tokens.css';
import { call, setRun } from './api/client.ts';
import { initAuth, isLocal, signedInEmail, signOut } from './auth.ts';
import { SessionCtx, type Session } from './data.ts';
import { setZone } from './format.ts';
import { Failed, Toast } from './components.tsx';
import { Overview } from './routes/overview.tsx';
import { Receivables } from './routes/receivables.tsx';
import { Cash } from './routes/cash.tsx';
import { Payables } from './routes/payables.tsx';
import { Inbox } from './routes/inbox.tsx';
import { Plan } from './routes/plan.tsx';
import { Delegation } from './routes/delegation.tsx';
import { Relationships } from './routes/relationships.tsx';
import { useLoad } from './data.ts';

ModuleRegistry.registerModules([AllCommunityModule]);

const NAV = [
  ['overview', 'Overview'], ['inbox', 'Inbox'], ['plan', 'Plan'], ['cash', 'Cash'], ['receivables', 'Receivables'],
  ['payables', 'Payables'], ['relationships', 'Customers & Suppliers'], ['delegation', 'Delegation'],
] as const;

const Mark = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden>
    <rect x="2.75" y="2.75" width="18.5" height="18.5" fill="none" stroke="#1B211E" strokeWidth="1.5" />
    <rect x="3.5" y="14.5" width="17" height="2" fill="#2E5E47" /><rect x="3.5" y="18" width="17" height="1" fill="#2E5E47" />
  </svg>
);

function NotBuilt({ title }: { title: string }) {
  return (
    <div className="page">
      <h1>{title}</h1>
      <div className="notbuilt"><strong style={{ color: 'var(--ink)' }}>Not in this build yet.</strong> This part of Headroom arrives in a later build. Nothing here is simulated.</div>
    </div>
  );
}

/** UI-SH-02: "N new" on Inbox (unsent drafts + replies waiting for you), from the server's threads. */
function InboxBadge() {
  const q = useLoad(() => call('getInbox'));
  const n = (q.data?.threads ?? []).reduce((t, x) => t + x.unread, 0);
  return n ? <span className="badge">{n} new</span> : null;
}

/** UI-SH-02: "N need you" on Overview from the server's needsCount. */
function NeedsBadge() {
  const q = useLoad(() => call('getOverview'));
  const n = q.data?.needsCount ?? 0;
  return n ? <span className="badge">{n} need{n === 1 ? 's' : ''} you</span> : null;
}

function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [changed, setChanged] = useState(0);
  const [demo, setDemo] = useState(false);
  const [path, setPath] = useState(location.pathname);
  const [toast, setToast] = useState<{ text: string; to?: string | null } | null>(null);
  const say = useCallback((text: string) => setToast({ text }), []);
  const last = useRef<string | null | undefined>(undefined);
  // UX repair (S7 audit F06): a confirmed receipt, skipped offer or supplier payment shows once as a notice; Activity keeps the record.
  const seenNotice = useRef<string | null | undefined>(undefined);
  const refreshRef = useRef<() => void>(() => {});

  const nav = useCallback((p: string) => { history.pushState(null, '', p); setPath(p); }, []);
  useEffect(() => { const f = () => setPath(location.pathname + location.search); window.addEventListener('popstate', f); return () => window.removeEventListener('popstate', f); }, []);

  // Refresh signal (S01 T7; S7 R11 live updates): poll getSession every 2 s while watching and visible, else 60 s; refetch on lastChangeAt change.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let watching = false;
    const tick = async () => {
      try {
        const s = await call('getSession');
        setZone(s.timeZone); setRun(s.run.runId); setSession(s); setError(null);
        watching = s.watching;
        if (last.current !== undefined && s.lastChangeAt !== last.current) setChanged((c) => c + 1);
        last.current = s.lastChangeAt;
        const n = s.notice ?? null;
        if (seenNotice.current !== undefined && n && n.eventId !== seenNotice.current) setToast({ text: n.text, to: n.to ?? null });
        seenNotice.current = n?.eventId ?? null;
      } catch (e) { setError(e); }
      timer = setTimeout(tick, watching && document.visibilityState === 'visible' ? 2000 : 60000);
    };
    refreshRef.current = () => { clearTimeout(timer); tick(); };
    tick();
    const vis = () => { if (document.visibilityState === 'visible') { clearTimeout(timer); tick(); } };
    document.addEventListener('visibilitychange', vis);
    return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', vis); };
  }, []);

  if (!session) return error ? <div style={{ padding: 28 }}><Failed error={error} /></div> : <div className="muted" style={{ padding: 28 }}>Loading Headroom…</div>;
  const route = path.split(/[/?#]/)[1] || 'overview';
  // Keyed by path so a link with new query parameters (e.g. /payables?bill=…) mounts the route afresh.
  const page = route === 'overview' ? <Overview /> : route === 'receivables' ? <Receivables /> : route === 'cash' ? <Cash key={path} />
    : route === 'payables' ? <Payables key={path} /> : route === 'inbox' ? <Inbox /> : route === 'plan' ? <Plan /> : route === 'delegation' ? <Delegation /> : route === 'relationships' ? <Relationships key={path} />
    : <NotBuilt title={NAV.find(([k]) => k === route)?.[1] ?? 'Not found'} />;

  return (
    <SessionCtx.Provider value={{ session, changed, nav, toast: say, refresh: () => refreshRef.current() }}>
      <div className="app">
        <header className="top">
          <a className="brand" href="/overview" onClick={(e) => { e.preventDefault(); nav('/overview'); }}><Mark />Headroom</a>
          <input className="search" placeholder="Search customers, invoices, bills…" disabled aria-label="Search" />
          <div className="identity">
            {/* One environment indicator (S7 audit F14); the run id lives in the operator drawer. */}
            <div>{session.tenantName} <span className="tag SEEDED" title="PayPal and Plaid sandbox with seeded sample data: no real money or customers">Sandbox · sample data</span></div>
            <div className="muted">{signedInEmail() ?? session.userEmail}{!isLocal() && <> · <button className="linkbtn" onClick={signOut}>Sign out</button></>}</div>
          </div>
          {session.role !== 'OWNER' && <button className="btn demo-btn" aria-expanded={demo} onClick={() => setDemo((x) => !x)}>Sandbox controls</button>}
        </header>
        <nav className="nav" aria-label="Main">
          {NAV.map(([k, label]) => (
            <a key={k} href={`/${k}`} className={route === k ? 'on' : ''} aria-current={route === k ? 'page' : undefined} onClick={(e) => { e.preventDefault(); nav(`/${k}`); }}>{label}{k === 'overview' && <NeedsBadge />}{k === 'inbox' && <InboxBadge />}</a>
          ))}
        </nav>
        {(session.pauses.outreach || session.pauses.payments) && (
          <div className="pause-banner" role="status">Paused: {[session.pauses.outreach && 'all outreach', session.pauses.payments && 'all payment preparation'].filter(Boolean).join(' and ')}. Nothing of that kind runs until you resume. <a href="/delegation" onClick={(e) => { e.preventDefault(); nav('/delegation'); }}>Delegation ›</a></div>
        )}
        {error ? <div style={{ padding: '8px 28px' }}><Failed error={error} /></div> : null}
        {page}
        <DemoDock onControls={() => setDemo(true)} />
        {demo && session.role !== 'OWNER' && <DemoDrawer onClose={() => setDemo(false)} />}
        {session.view === 'SHOWCASE' && <div className="pause-banner" role="status">You are watching the finished showcase run: read-only. Open “Sandbox controls” to go back to your own run.</div>}
        {toast && <Toast text={toast.text} onClose={() => setToast(null)} onOpen={toast.to ? () => nav(toast.to!) : undefined} />}
      </div>
    </SessionCtx.Provider>
  );
}

initAuth().then((mode) => { if (mode !== 'redirecting') createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>); });
