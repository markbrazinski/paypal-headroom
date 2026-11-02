// Bank half of Cash now (S2; UI-CA-01/02 + the missing surfaces in matrix (e): connect, reconnect, disconnect, activity).
// Built in the export's shell and tokens. Renders the server's BankSource as given: no cash arithmetic here.
import { useState } from 'react';
import type { ResponseOf } from '@headroom/contracts';
import { call } from '../api/client.ts';
import { Dialog, Pill } from '../components.tsx';
import { useApp } from '../data.ts';
import { ago, dateTime, money, providerAmount, shortDay, time } from '../format.ts';
import { openLink } from '../plaid-link.ts';

type Bank = ResponseOf<'getCashPosition'>['sources'][1];
type Connected = Exclude<Bank, { state: 'NOT_CONNECTED' }>;

export function BankPill({ b }: { b: Connected }) {
  if (b.state === 'RECONNECT_REQUIRED') return <Pill tone="red" glyph="✕">Reconnect required</Pill>;
  if (b.state === 'REVOKED') return <Pill tone="red" glyph="✕">Bank connection ended</Pill>;
  if (b.state === 'DISCONNECTING') return <Pill tone="grey" glyph="◐">Removal pending</Pill>;
  if (b.state === 'DISCONNECTED') return <Pill tone="grey" glyph="○">Disconnected</Pill>;
  if (b.freshness === 'FAILED') return <Pill tone="red" glyph="✕">Couldn't reach the bank</Pill>;
  if (b.freshness === 'NEVER') return <Pill tone="amber" glyph="◐">Reading the bank</Pill>;
  if (b.freshness === 'STALE') return <Pill tone="amber" glyph="◔">Bank read {ago(b.retrievedAt)}</Pill>;
  return <Pill tone="grey" glyph="◷">Bank read {ago(b.retrievedAt)}</Pill>;
}

function useBankAction(onChanged: () => void) {
  const { toast } = useApp();
  const [busy, setBusy] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const run = async (f: () => Promise<string | void>) => {
    setBusy(true); setLinkError(null);
    try { const msg = await f(); if (msg) toast(msg); onChanged(); }
    catch (e) { toast((e as Error).message); } finally { setBusy(false); }
  };
  /** Connect (new Item, claimed by the API, exchanged by the worker) or Reconnect (update mode: password only, no exchange). */
  const link = (mode: 'connect' | 'update') => run(async () => {
    const t = await call('createPlaidLinkToken', { body: { mode } });
    const r = await openLink(t.linkToken);
    if (r.kind === 'exit') { if (r.error) setLinkError(r.error); return; }
    if (mode === 'connect') {
      await call('exchangePlaidToken', { body: { publicToken: r.publicToken, institutionId: r.institutionId, institutionName: r.institutionName } });
      return `Connecting to ${r.institutionName ?? 'your bank'}. Figures appear when Headroom has read it.`;
    }
    await call('refreshPlaid');
    return 'Reconnected. Reading the bank again.';
  });
  return { busy, linkError, run, link };
}

const READ_ONLY = 'Plaid sandbox · read-only. Headroom never moves bank money.';

export function BankBlock({ bank, onChanged }: { bank: Bank; onChanged: () => void }) {
  const { busy, linkError, run, link } = useBankAction(onChanged);
  const [confirm, setConfirm] = useState<'disconnect' | 'abandon' | null>(null);
  const linkErr = linkError && <div className="small neg">Bank not connected · {linkError}</div>;

  if (bank.state === 'NOT_CONNECTED') {
    const pe = bank.pendingEffect;
    return (
      <div data-testid="bank-block">
        <div className="kv"><span><strong>Bank</strong><br /><span className="muted small">{READ_ONLY}</span></span><span className="muted">—</span></div>
        {pe?.kind === 'CONNECTING' && pe.state !== 'UNKNOWN' && <div style={{ margin: '6px 0' }}><Pill tone="amber" glyph="◐">Connecting to {pe.institutionName ?? 'your bank'}</Pill>{pe.reason && <div className="small muted">{pe.reason}</div>}</div>}
        {pe?.state === 'UNKNOWN' && pe.terminal && !pe.canAbandon && (
          <div style={{ margin: '6px 0' }}><Pill tone="red" glyph="?">Bank outcome unknown</Pill><div className="small muted">{pe.reason ?? 'Plaid could not tell us what happened.'} Ask the operator to reset the run.</div></div>
        )}
        {pe?.state === 'UNKNOWN' && (!pe.terminal || pe.canAbandon) && (
          <div style={{ margin: '6px 0' }}>
            <Pill tone="amber" glyph="?">{pe.canAbandon ? "Plaid couldn't confirm this connection" : 'Checking whether Plaid connected this bank'}</Pill>
            {pe.canAbandon && <div className="small muted" style={{ marginTop: 4 }}>Plaid couldn't tell us. <button className="linkbtn" onClick={() => setConfirm('abandon')}>Abandon and connect again</button></div>}
          </div>
        )}
        {pe?.kind === 'CONNECT_FAILED' && <div className="small neg">Not connected · {pe.reason}</div>}
        {linkErr}
        {bank.checksStopped && <div className="small" style={{ color: 'var(--amber)' }}>◔ {bank.checksStopped}</div>}
        {(!pe || pe.kind === 'CONNECT_FAILED') && <button className="btn" style={{ marginTop: 8 }} disabled={busy || !!bank.checksStopped} title={bank.checksStopped ?? undefined} onClick={() => link('connect')}>Connect bank</button>}
        {confirm === 'abandon' && pe && (
          <Dialog kicker="Bank · Connection attempt" title="Abandon and connect again?" onClose={() => setConfirm(null)}
            footer={<><button className="btn" onClick={() => setConfirm(null)}>Keep waiting</button><button className="btn primary" disabled={busy} onClick={() => { setConfirm(null); run(async () => { await call('abandonBankConnect', { ifMatch: pe.effectVersion }); return 'Connection attempt abandoned. You can connect again.'; }); }}>Abandon</button></>}>
            <p><strong>Consequence.</strong> Plaid may hold a connection Headroom never received; in the sandbox it expires within 30 days. Headroom never starts a new connection on its own.</p>
            <p className="muted small">Scope: this one connection attempt.</p>
          </Dialog>
        )}
      </div>
    );
  }

  const b = bank;
  const history = !b.contributes && ['DISCONNECTING', 'REVOKED', 'DISCONNECTED'].includes(b.state);
  const read = b.retrievedAt ? `read ${time(b.retrievedAt)}` : 'not read yet';
  return (
    <div data-testid="bank-block" className={history ? 'muted' : ''}>
      <div className="small" style={{ marginBottom: 4 }}>
        <strong style={{ color: 'var(--ink)' }}>{b.connection.institutionName ?? 'Bank'}</strong> · via Plaid{' '}
        <span className="muted">· {b.connection.basis === 'SEEDED' ? 'sample bank, read-only' : 'linked by you, read-only'}</span>
      </div>
      {b.accounts.map((a) => (
        <div key={a.accountId} className="kv" data-testid="bank-account">
          <span><strong>{a.name}{a.mask ? ` ··${a.mask}` : ''}</strong><br />
            <span className="muted small">{a.label}{a.reason && a.role === 'NOT_COUNTED' && a.refusal !== 'AVAILABILITY_NOT_REPORTED' && a.refusal !== 'NOT_CHECKING' ? `: ${a.reason}` : ''} · {read}{a.notReturned ? ' · not returned on the last read' : ''}</span></span>
          <span className="num">
            {a.role === 'COUNTED' ? <>{money(a.eligible)}<br /><span className="small muted" data-testid="checking-current">current {providerAmount(a.provider.current)}</span></>
              : a.role === 'OWED' ? <>Owed {providerAmount(a.provider.current)}</>
              : a.provider.available === null ? <>Balance {providerAmount(a.provider.current)}</>
              : providerAmount(a.provider.available)}
          </span>
        </div>
      ))}
      {b.notCountedReason && <div className="small">{b.notCountedReason.replace(' · not counted', '')}{b.retrievedAt ? ` · last read ${dateTime(b.retrievedAt)}` : ''} · not counted</div>}
      {b.incomplete.length > 0 && b.contributes && <div className="small" style={{ color: 'var(--amber)' }}>◔ Checking figure incomplete ({b.incomplete.join(', ')}): the bank isn't counted until it reports</div>}
      <div style={{ margin: '6px 0' }}><BankPill b={b} />{b.historyLoading && <> <Pill tone="amber" glyph="◐">Bank history still loading</Pill></>}</div>
      {b.freshness === 'FAILED' && <div className="small neg">✕ {b.lastError}{b.retrievedAt ? ` · last good read ${dateTime(b.retrievedAt)}` : ''}</div>}
      {b.state === 'RECONNECT_REQUIRED' && <div className="small neg">✕ Reconnect required · last read {dateTime(b.retrievedAt)} · figures not fresh</div>}
      {b.state === 'REVOKED' && <div className="small neg">✕ Bank connection ended · last read {dateTime(b.retrievedAt)}</div>}
      {b.checksStopped && <div className="small" style={{ color: 'var(--amber)' }}>◔ {b.checksStopped}</div>}
      {linkErr}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 8 }}>
        {b.state === 'RECONNECT_REQUIRED' && <button className="btn primary" disabled={busy || !!b.checksStopped} onClick={() => link('update')}>Reconnect</button>}
        {['SYNCING', 'HEALTHY', 'RECONNECT_REQUIRED'].includes(b.state) && (
          <button className="btn" aria-label="Refresh bank" disabled={busy || !!b.checksStopped} title={b.checksStopped ?? undefined} onClick={() => run(async () => { await call('refreshPlaid'); return 'Reading the bank. Figures update when it answers.'; })}>Refresh</button>
        )}
        {b.state === 'DISCONNECTED' && <button className="btn" disabled={busy || !!b.checksStopped} onClick={() => link('connect')}>Connect bank</button>}
        {['SYNCING', 'HEALTHY', 'RECONNECT_REQUIRED', 'REVOKED'].includes(b.state) && <button className="linkbtn" onClick={() => setConfirm('disconnect')}>Disconnect</button>}
      </div>
      <div className="small muted" style={{ marginTop: 6 }}>No live bank notifications · checked hourly and on Refresh</div>
      {confirm === 'disconnect' && (
        <Dialog kicker="Bank · Disconnect" title="Disconnect this bank?" onClose={() => setConfirm(null)}
          footer={<><button className="btn" onClick={() => setConfirm(null)}>Cancel</button><button className="btn primary" disabled={busy} onClick={() => { setConfirm(null); run(async () => { await call('disconnectPlaid', { ifMatch: b.connection.version }); return 'Disconnecting. The bank no longer counts in your cash.'; }); }}>Disconnect</button></>}>
          <p><strong>Consequence.</strong> Headroom stops reading this bank and asks Plaid to remove the connection. Its last figures stop counting now. Nothing at the bank changes.</p>
          <p className="muted small">Scope: {b.connection.institutionName ?? 'this bank'} only.</p>
        </Dialog>
      )}
    </div>
  );
}

/** Bank activity: explains balances, never added to them (probe case 4). PayPal rows are candidates, not verified. */
export function BankActivity({ bank }: { bank: Connected }) {
  const a = bank.activity;
  if (!a.rows.length) return null;
  return (
    <div className="sec" data-testid="bank-activity">
      <h4>Bank activity · last 14 days</h4>
      {a.rows.map((r) => (
        <div key={r.transactionId} className="txn">
          <span className="muted">{shortDay(r.date)}</span>
          <span>{r.description}{r.accountMask ? ` ··${r.accountMask}` : ''}{' '}
            {r.pending ? <Pill tone="amber" glyph="◐">Pending</Pill> : <Pill tone="grey" glyph="✓">Posted</Pill>}
            {r.paypalCandidate && <> <Pill tone="slate" glyph="?">PayPal? · candidate, not verified</Pill></>}</span>
          <span className={`num ${r.amount && r.amount.minor < 0 ? 'neg' : ''}`}>{money(r.amount)}</span>
        </div>
      ))}
      <div className="small muted" style={{ marginTop: 6 }}>
        {a.hiddenSuperseded > 0 ? `${a.hiddenSuperseded} pending replaced by ${a.hiddenSuperseded === 1 ? 'its' : 'their'} posted row${a.hiddenSuperseded === 1 ? '' : 's'} · counted once · ` : ''}
        Bank activity explains balances and is not added to them.{a.syncedAt ? ` Synced ${ago(a.syncedAt)}.` : ''}
      </div>
    </div>
  );
}
