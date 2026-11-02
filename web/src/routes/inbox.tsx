// Inbox (UI-IN-01…05, UI-AR-06/07): conversations by customer (drafts, what was sent, replies) and documents received.
// "Sent" appears only after the mail channel confirmed it; every Gmail send goes to the owner's private test inbox (S5-D26).
import { useState } from 'react';
import type { ResponseOf } from '@headroom/contracts';
import { ApiFailure, call } from '../api/client.ts';
import { Failed, Loading, Pill } from '../components.tsx';
import { useApp, useLoad } from '../data.ts';
import { dateTime } from '../format.ts';
import { BillPanel, BillPill } from './bill-panel.tsx';

/** Thread status in sentence case (UX audit F16); the server's value still drives the tone. */
const PILL_TEXT: Record<string, string> = { 'YOU OWN THIS': 'You handle it', 'NEEDS YOU': 'Needs you', DRAFT: 'Draft' };

type Data = ResponseOf<'getInbox'>;
type Thread = Data['threads'][number];

export function Inbox() {
  const q = useLoad(() => call('getInbox'));
  const [sel, setSel] = useState<{ kind: 'bill' | 'thread'; id: string } | null>(null);
  const thread = sel?.kind === 'thread' ? q.data?.threads.find((t) => t.customerId === sel.id) : undefined;
  return (
    <div className={`layout ${sel ? 'with-panel' : ''}`}>
      <div className="page">
        <h1>Inbox</h1>
        {q.error ? <Failed error={q.error} /> : !q.data ? <Loading /> : (
          <>
            <div className={`note ${q.data.channel.state === 'CONNECTED' ? '' : 'warn'}`} role="status">{q.data.channel.text}{q.data.channel.expiresAbout && q.data.channel.state === 'CONNECTED' ? ` · test sign-in renews by ${dateTime(q.data.channel.expiresAbout)}` : ''}</div>
            <div className="box list" style={{ marginTop: 0 }}>
              <div className="sh">Conversations</div>
              {q.data.threads.length === 0 ? <div className="empty muted">Nothing said on your behalf yet.</div> : q.data.threads.map((t) => (
                <button key={t.customerId} className={`row inbox-row ${thread?.customerId === t.customerId ? 'on' : ''}`} onClick={() => setSel({ kind: 'thread', id: t.customerId })}>
                  <span>{t.unread > 0 ? <strong>{t.name} ●</strong> : t.name}<br /><span className="muted small">{t.contact} · {t.entries[0]?.subject ?? ''}</span></span>
                  <span><Pill tone={t.pill.startsWith('YOU') || t.pill.startsWith('NEEDS') || t.pill.startsWith('DELIVERY') ? 'amber' : t.pill.startsWith('SENT') ? 'green' : 'grey'} glyph="✉">{PILL_TEXT[t.pill] ?? t.pill}</Pill></span>
                  <span className="muted small" style={{ textAlign: 'right' }}>{t.entries[0]?.at ? dateTime(t.entries[0].at) : 'draft'}</span>
                </button>
              ))}
            </div>
            <div className="box list">
              <div className="sh">Documents</div>
              {q.data.items.length === 0 ? <div className="empty muted">Nothing received yet. Bills arrive by email, or upload one from Payables › New › Capture bill.</div> : q.data.items.map((i) => (
                <button key={i.key} className={`row inbox-row ${sel?.kind === 'bill' && sel.id === i.billId ? 'on' : ''}`} onClick={() => setSel({ kind: 'bill', id: i.billId })}>
                  <span><strong>{i.from}</strong><br /><span className="muted small">{i.title} · {i.source}</span></span>
                  <span><BillPill b={i} /></span>
                  <span className="muted small" style={{ textAlign: 'right' }}>{dateTime(i.at)}</span>
                </button>
              ))}
            </div>
            {q.data.unfiled.length > 0 && (
              <div className="box list">
                <div className="sh">Unfiled · no effect</div>
                {q.data.unfiled.map((e) => <div key={e.key} className="row"><span>{e.subject}<br /><span className="muted small">{e.detail}</span></span><span className="small">{e.label}</span><span className="muted small">{e.at ? dateTime(e.at) : ''}</span></div>)}
              </div>
            )}
            <div className="foot">{q.data.note}</div>
          </>
        )}
      </div>
      {sel?.kind === 'bill' && <BillPanel key={sel.id} id={sel.id} onClose={() => setSel(null)} />}
      {thread && <ThreadPanel t={thread} onClose={() => setSel(null)} reload={q.reload} />}
    </div>
  );
}

function ThreadPanel({ t, onClose, reload }: { t: Thread; onClose: () => void; reload: () => void }) {
  const { toast } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (f: () => Promise<unknown>, ok: string) => {
    setBusy(true); setError(null);
    try { await f(); toast(ok); reload(); } catch (e) { setError(e instanceof ApiFailure ? e.error.message : (e as Error).message); } finally { setBusy(false); }
  };
  const take = t.owner === 'YOU' ? 'HEADROOM' : 'YOU';
  return (
    <aside className="panel" aria-label={`Conversation with ${t.name}`}>
      <button className="close" aria-label="Close" onClick={onClose}>×</button>
      <div className="ph"><div className="kicker">Conversation</div><h2>{t.name}</h2><div className="small muted">{t.contact}</div></div>
      <div className="pb">
      <div className="act-btns">
        <button className="btn" disabled={busy} onClick={() => run(() => call('setThreadOwner', { params: { id: t.customerId }, ifMatch: t.ownerVersion, body: { owner: take } }), take === 'YOU' ? 'You own this conversation · Headroom sends and changes nothing for them' : 'Handed back · held work runs again under its checks')}>{take === 'YOU' ? 'Take over' : 'Hand back'}</button>
      </div>
      {t.owner === 'YOU' && <div className="note">You handle this conversation · Headroom won't send messages or change their PayPal invoices until you hand back.</div>}
      {t.entries.map((e) => (
        <div key={e.key} className="box" style={{ marginTop: 8 }}>
          <div className="kicker">{e.kind === 'IN' ? 'Received' : e.kind === 'DRAFT' ? 'Draft' : 'Sent by Headroom'} · {e.label}</div>
          <div><strong>{e.subject}</strong></div>
          {e.detail && <div className="small muted">{e.detail}</div>}
          {e.at && <div className="small muted">{dateTime(e.at)}</div>}
          {e.promise?.beyondLimitDays && !e.promise.accepted && <div className="act-btns"><button className="btn" disabled={busy} onClick={() => run(() => call('acceptPromise', { params: { id: e.promise!.promiseId }, body: {} }), 'Date counted in Expected (not cash)')}>Count this date</button></div>}
          {e.actionId && (e.canSendNow || e.canHold) && (
            <div className="act-btns">
              {e.canSendNow && <button className="btn" disabled={busy} onClick={() => run(() => call('sendNow', { params: { id: e.actionId! }, body: {} }), 'Sending now (still checked first)')}>Send now</button>}
              {e.canHold && <button className="btn" disabled={busy} onClick={() => run(() => call('holdMessage', { params: { id: e.actionId! }, body: { held: !e.held } }), e.held ? 'Released' : 'Held · it will not send')}>{e.held ? 'Release message' : 'Hold message'}</button>}
            </div>
          )}
        </div>
      ))}
      {error && <div className="err-banner">{error}</div>}
      </div>
    </aside>
  );
}
