// Delegation (S04 §6.7: UI-DL-01…09, UI-SH-07/12). Rules, pauses, the 3 editable rules with a live server preview, Approved once
// (S4 grants revocable until acted on; S3 bill records listed, never revocable), tiers and precedence. All decisions are the server's.
import { useEffect, useState } from 'react';
import type { ResponseOf } from '@headroom/contracts';
import { ApiFailure, call } from '../api/client.ts';
import { useApp, useLoad } from '../data.ts';
import { Dialog, Failed, Loading } from '../components.tsx';
import { dateTime, day, money, words } from '../format.ts';

type D = ResponseOf<'getDelegation'>;
type Rule = D['rules'][number];
const GROUPS: [Rule['group'], string][] = [['MESSAGES', 'Talking to customers and suppliers'], ['GETTING_PAID', 'Getting paid'], ['PAYING_BILLS', 'Paying bills'], ['CASH_SAFETY', 'Cash safety']];
const FILTERS: [string, string][] = [['ALL', 'All rules'], ['MESSAGES', 'Messages'], ['GETTING_PAID', 'Getting paid'], ['PAYING_BILLS', 'Paying bills'], ['CASH_SAFETY', 'Cash safety'], ['TIERS', 'By relationship']];

function useCommand() {
  const { toast } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [key] = useState(() => crypto.randomUUID());
  const run = async (f: (key: string) => Promise<unknown>, ok: string, done: () => void) => {
    setBusy(true); setError(null);
    try { await f(key); toast(ok); done(); } catch (e) { setError(e instanceof ApiFailure ? e.error.message : (e as Error).message); } finally { setBusy(false); }
  };
  return { busy, error, run };
}

export function Delegation() {
  const q = useLoad(() => call('getDelegation'));
  const [filter, setFilter] = useState('ALL');
  const [editing, setEditing] = useState<{ r: Rule; start?: Rule['everywhere'] } | null>(null);
  const [pause, setPause] = useState<'OUTREACH' | 'PAYMENTS' | null>(null);
  const [revoke, setRevoke] = useState<D['grants'][number] | null>(null);
  const d = q.data;
  if (q.error) return <div className="page"><h1>Delegation</h1><Failed error={q.error} /></div>;
  if (!d) return <div className="page"><h1>Delegation</h1><Loading /></div>;
  const count = (g: string) => d.rules.filter((r) => r.group === g).length;
  return (
    <div className="page">
      <h1>Delegation</h1>
      <div className="box dl-pauses">
        {(['OUTREACH', 'PAYMENTS'] as const).map((k) => {
          const on = k === 'OUTREACH' ? d.pauses.outreach : d.pauses.payments;
          return (
            <div key={k} className="dl-pause">
              <div><div className="kicker">Stop everything</div><strong>{k === 'OUTREACH' ? 'Pause all outreach' : 'Pause all payment preparation'}</strong><div className="small muted">{k === 'OUTREACH' ? 'Stops every scheduled message in Receivables and Payables. Approving is still allowed.' : 'Holds every payment at its current status. Nothing becomes ready, even if funded and authorized.'}</div></div>
              <button className={`slide ${on ? 'on' : ''}`} role="switch" aria-checked={on} aria-label={k === 'OUTREACH' ? 'Pause all outreach' : 'Pause all payment preparation'} onClick={() => setPause(k)}>
                <span className="slide-track" aria-hidden><span className="slide-knob" /></span><span className="slide-text">{on ? 'On · paused' : 'Off'}</span>
              </button>
            </div>
          );
        })}
      </div>
      <div className="seg dl-filter" role="group" aria-label="Filter rules">
        {FILTERS.map(([k, label]) => <button key={k} className={filter === k ? 'on' : ''} aria-pressed={filter === k} onClick={() => setFilter(k)}>{label}{k !== 'ALL' && k !== 'TIERS' ? ` · ${count(k)}` : ''}</button>)}
      </div>
      {filter === 'TIERS' && <Tiers d={d} />}
      <div className="dl-cols">
        <div>
          {filter !== 'TIERS' && GROUPS.filter(([g]) => filter === 'ALL' || filter === g).map(([g, title]) => (
            <div key={g} className="box"><div className="box-h"><h3>{title}</h3></div>
              {d.rules.filter((r) => r.group === g).map((r) => (
                <div key={r.key} id={r.key} className={`box-b dl-rule ${editing?.r.key === r.key ? 'on' : ''}`}>
                  <div className="dl-rule-h"><span>{r.text}</span><span className="small muted">{r.scoped ? (r.scoped.scope === 'PAYABLES' ? 'Payables' : 'Receivables') : 'Everywhere'} {r.editable && <button className="btn small-btn" onClick={() => setEditing({ r })}>Change</button>}</span></div>
                  {r.safety && r.loosenedFromDefault && <div className="dl-loosened"><span className="chip warn">Loosened by you{r.changedAt ? ` · ${day(r.changedAt.slice(0, 10))}` : ''}</span> <span className="small muted">Default: {r.defaultText}</span> <button className="btn small-btn" onClick={() => setEditing({ r, start: r.defaultValue })}>Restore default</button></div>}
                  <div className="small muted">Why: {r.why}{r.safety ? ' · Safety rule' : ''}{r.provenance === 'PLANNER_VALUE' ? ' · value proposed by Headroom’s planner, not yet confirmed by you' : r.provenance === 'OWNER' ? ' · set by you' : ''}</div>
                  {r.scopedText && <div className="small muted">{r.scopedText}</div>}
                  <div className="small">{r.enforcedNow ? <span style={{ color: 'var(--amber)' }}>{r.enforcedNow}</span> : 'Enforced now'}</div>
                  <Affects r={r} />
                </div>
              ))}
            </div>
          ))}
          {filter === 'TIERS' && <div className="box"><div className="box-b muted small">Choose a rule group above to see the rules each relationship starts from.</div></div>}
        </div>
        <div>
          {editing && <RuleEditor key={`${editing.r.key}:${editing.start === undefined ? 'edit' : 'restore'}`} r={editing.r} start={editing.start} version={d.version} onClose={() => setEditing(null)} onDone={() => { setEditing(null); q.reload(); }} />}
          <div className="box"><div className="box-h"><h3>Approved once</h3></div>
            {d.grants.length === 0 && <div className="box-b small muted">None yet. Approving something once never edits a rule.</div>}
            {d.grants.map((g) => (
              <div key={g.grantId} className="box-b dl-grant">
                <div><strong>{g.text}</strong></div>
                <div className="small">{g.scope}</div>
                <div className="small muted">{GRANT_STATE[g.state] ?? words(g.state)} · {g.by} · {dateTime(g.at)}{g.expiresAt ? ` · expires ${day(g.expiresAt.slice(0, 10))}` : ''}{g.state !== 'RECORD' ? (g.rulesUnchanged ? ' · rules unchanged' : ' · rules changed since') : ''}</div>
                {g.note && <div className="small muted">{g.note}</div>}
                {g.revocable && <button className="btn" onClick={() => setRevoke(g)}>Revoke…</button>}
              </div>
            ))}
            <div className="box-b"><a href="/overview">Rule changes and approvals are in Activity ›</a></div>
          </div>
          <div className="box dl-precedence"><div className="box-h"><h3>Precedence and limits</h3></div>
            <div className="box-b">
              <div className="kicker">Which rule wins · most specific first</div>
              <ol className="dl-steps">{[...d.precedence.slice(0, 4)].reverse().map((x, i) => <li key={x}><span className="dl-step-n">{i + 1}</span>{x}</li>)}</ol>
              <div className="small muted">{d.precedence[4]}.</div>
              <div className="kicker" style={{ marginTop: 14 }}>Hard stops · no rule can override these</div>
              <ul className="dl-stops">{d.hardStops.map((x) => <li key={x}>{x}</li>)}</ul>
            </div>
          </div>
        </div>
      </div>
      {filter === 'ALL' && <Tiers d={d} />}
      {pause && <PauseDialog kind={pause} on={!(pause === 'OUTREACH' ? d.pauses.outreach : d.pauses.payments)} version={d.version} onClose={() => setPause(null)} onDone={() => { setPause(null); q.reload(); }} />}
      {revoke && <RevokeDialog g={revoke} onClose={() => setRevoke(null)} onDone={() => { setRevoke(null); q.reload(); }} />}
    </div>
  );
}

/** Owner, 2 Nov 2026 (auditability): what this rule decides right now, listed on hover, keyboard focus or click (pinned). */
function Affects({ r }: { r: Rule }) {
  const { nav } = useApp();
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  if (!r.affectsNow.length) return <div className="small muted">Affects nothing planned right now</div>;
  const n = r.affectsNow.length;
  return (
    <div className="affects" onMouseEnter={() => setOpen(true)} onMouseLeave={() => !pinned && setOpen(false)}>
      <button className="affects-chip" aria-expanded={open} aria-controls={`affects-${r.key}`} onFocus={() => setOpen(true)} onBlur={() => !pinned && setOpen(false)} onClick={() => { setPinned((p) => !p); setOpen(true); }}>
        Affects {n} planned action{n === 1 ? '' : 's'} now <span aria-hidden>▾</span>
      </button>
      {open && (
        <div className="affects-pop" id={`affects-${r.key}`} role="region" aria-label={`What "${r.text}" affects now`}>
          <div className="kicker">Decided by this rule now</div>
          <table><thead><tr><th>Planned action</th><th>Decision</th><th>State</th><th className="num">Amount</th></tr></thead>
            <tbody>{r.affectsNow.map((a) => (
              <tr key={a.actionId}>
                <td><a href="/plan" onClick={(e) => { e.preventDefault(); nav('/plan'); }}>{a.label}</a><div className="muted">Revision {a.revisionN} · winning rule: {a.winning}</div></td>
                <td>{a.decision}</td><td>{a.state}</td><td className="num">{money(a.amount)}</td>
              </tr>
            ))}</tbody></table>
          {pinned && <button className="linkbtn" onClick={() => { setPinned(false); setOpen(false); }}>Close</button>}
        </div>
      )}
    </div>
  );
}

function Tiers({ d }: { d: D }) {
  return (
        <div className="box"><div className="box-h"><h3>By relationship</h3><span className="small muted">Each business gets the defaults for its relationship. Labels are rules, not scores.</span></div>
          <table className="ledger plan-outlook"><thead><tr><th>Relationship</th><th>Messages</th><th>Early-pay discount</th><th>Contact at most every</th></tr></thead>
            <tbody>{d.tiers.map((t) => <tr key={t.tier}><td><strong>{t.label}</strong> <span className="small muted">{t.meaning}</span><div className="small">{t.counterparties.join(' · ') || '—'}</div></td><td>{t.reviewFirst || d.rules.find((x) => x.key === 'comms.remindersWithoutReview')?.everywhere === false ? 'You review every message' : 'Send without review'}</td><td>{t.discount ? `Up to ${d.rules.find((x) => x.key === 'ar.discount')?.value ?? ''}` : 'None'}</td><td>{d.rules.find((x) => x.key === 'comms.contactEveryBd')?.value ?? `${t.contactEveryBd} business days`}</td></tr>)}</tbody></table>
          <div className="box-b"><strong>Individual exceptions</strong><div className="small muted">{d.exceptions.length ? d.exceptions.map((e) => `${e.name}: ${e.text}`).join(' · ') : 'None: every business uses its relationship defaults.'}</div></div>
        </div>
  );
}

type Value = Rule['everywhere'];
/** Grant states in plain words (UX audit F16). */
const GRANT_STATE: Record<string, string> = { RECORD: 'Record', ACTIVE: 'Active', CONSUMED: 'Used', EXPIRED: 'Expired', REVOKED: 'Revoked', LAPSED: 'Lapsed' };
type Disc = { bp: number; capMinor: number; cumulativeMinor: number; tiers: string[]; ask?: 'ALWAYS' | 'ABOVE_LIMITS' };
type Diff = { mode: 'ALWAYS_ASK' | 'AUTO_ACCEPT'; maxAmountDiffMinor: number; maxDaysEarlier: number };
const TIERS: [string, string][] = [['STRONG', 'Strong'], ['GOOD', 'Good'], ['MIXED', 'Mixed'], ['AT_RISK', 'At risk']];
const dollarsOf = (minor: number) => String(minor / 100);
const minorOf = (t: string) => Math.round(Number(t) * 100);

/** S7-D1: one typed control per rule; the server checks the value against the same schema (contracts RULE_VALUE). */
function ValueInput({ r, v, set }: { r: Rule; v: Value; set: (v: Value) => void }) {
  const num = (label: string, x: number, to: (n: number) => Value, money = false) => (
    <label className="field"><span>{label}</span><input inputMode="decimal" aria-label={label} defaultValue={money ? dollarsOf(x) : String(x)} onChange={(e) => set(to(money ? minorOf(e.target.value) : Number(e.target.value)))} /></label>
  );
  const radios = (opts: { value: string; label: string }[], cur: string, to: (s: string) => Value) => (
    <fieldset className="dl-choices"><legend className="small muted">Choose one</legend>
      {opts.map((o) => <label key={o.value} className="dl-choice"><input type="radio" name={`r-${r.key}`} checked={cur === o.value} onChange={() => set(to(o.value))} /> {o.label}</label>)}
    </fieldset>
  );
  switch (r.editor) {
    case 'MONEY': return num('Amount (USD)', Number(v), (n) => n, true);
    case 'DAYS': return num('Days from the promise', Number(v), (n) => n);
    case 'BUSINESS_DAYS': return num('Business days', Number(v), (n) => n);
    case 'SET_ASIDE': return num('Days before each protected payment (0 = on the due date)', (v as { setAsideDays: number }).setAsideDays, (n) => ({ setAsideDays: n }));
    case 'TOGGLE': return radios([{ value: 'true', label: 'Send without review' }, { value: 'false', label: 'You review each one first' }], String(v), (x) => x === 'true');
    case 'CHOICE': return radios(r.choices, String(v), (x) => x);
    case 'WINDOW': {
      const w = v as { open: string; close: string };
      return (<div className="dl-pair">
        <label className="field"><span>From</span><input type="time" aria-label="From" value={w.open} onChange={(e) => set({ ...w, open: e.target.value })} /></label>
        <label className="field"><span>Until</span><input type="time" aria-label="Until" value={w.close} onChange={(e) => set({ ...w, close: e.target.value })} /></label>
      </div>);
    }
    case 'DISCOUNT': {
      const d = v as unknown as Disc;
      const upd = (x: Partial<Disc>) => set({ ...d, ...x } as unknown as Value);
      return (<div style={{ display: 'grid', gap: 8 }}>
        <label className="dl-choice"><input type="checkbox" aria-label="Every offer needs my approval" checked={(d.ask ?? 'ABOVE_LIMITS') === 'ALWAYS'} onChange={(e) => upd({ ask: e.target.checked ? 'ALWAYS' : 'ABOVE_LIMITS' })} /> Every offer needs my approval <span className="small muted">{(d.ask ?? 'ALWAYS') === 'ALWAYS' ? '· approving one schedules it; it goes out only if still needed' : '· within these limits, offers go out under your delegation'}</span></label>
        <div className="dl-pair">
          <label className="field"><span>Up to (%)</span><input inputMode="decimal" aria-label="Up to percent" defaultValue={String(d.bp / 100)} onChange={(e) => upd({ bp: Math.round(Number(e.target.value) * 100) })} /></label>
          <label className="field"><span>Or at most, per offer (USD)</span><input inputMode="decimal" aria-label="Per-offer cap" defaultValue={dollarsOf(d.capMinor)} onChange={(e) => upd({ capMinor: minorOf(e.target.value) })} /></label>
        </div>
        <label className="field"><span>At most offered in total (USD)</span><input inputMode="decimal" aria-label="Total offered" defaultValue={dollarsOf(d.cumulativeMinor)} onChange={(e) => upd({ cumulativeMinor: minorOf(e.target.value) })} /></label>
        <fieldset className="dl-choices"><legend className="small muted">Only to these relationships</legend>
          {TIERS.map(([k, l]) => <label key={k} className="dl-choice"><input type="checkbox" checked={d.tiers.includes(k)} onChange={(e) => upd({ tiers: e.target.checked ? TIERS.map(([t]) => t).filter((t) => t === k || d.tiers.includes(t)) : d.tiers.filter((t) => t !== k) })} /> {l}</label>)}
        </fieldset>
      </div>);
    }
    case 'DIFFERING': {
      const d = v as unknown as Diff;
      const upd = (x: Partial<Diff>) => set({ ...d, ...x } as unknown as Value);
      return (<div style={{ display: 'grid', gap: 8 }}>
        {radios([{ value: 'ALWAYS_ASK', label: 'Always come to you' }, { value: 'AUTO_ACCEPT', label: 'Accept automatically when…' }], d.mode, (m) => ({ ...d, mode: m } as unknown as Value))}
        {d.mode === 'AUTO_ACCEPT' && <div className="dl-pair">
          <label className="field"><span>Amount differs by at most (USD)</span><input inputMode="decimal" aria-label="Amount bound" defaultValue={dollarsOf(d.maxAmountDiffMinor)} onChange={(e) => upd({ maxAmountDiffMinor: minorOf(e.target.value) })} /></label>
          <label className="field"><span>Date earlier by at most (days)</span><input inputMode="decimal" aria-label="Days bound" defaultValue={String(d.maxDaysEarlier)} onChange={(e) => upd({ maxDaysEarlier: Number(e.target.value) })} /></label>
        </div>}
        <div className="small muted">Changed payment details always come to you, and paying the bill always needs your payout authority.</div>
      </div>);
    }
  }
}

function RuleEditor({ r, version, start, onClose, onDone }: { r: Rule; version: number; start?: Value; onClose: () => void; onDone: () => void }) {
  const area = r.scoped?.scope ?? 'EVERYWHERE';
  const [scope, setScope] = useState<'EVERYWHERE' | 'RECEIVABLES' | 'PAYABLES'>(r.scoped && r.scoped.value !== null ? r.scoped.scope : 'EVERYWHERE');
  const [v, setV] = useState<Value>(start ?? (scope !== 'EVERYWHERE' && r.scoped?.value != null ? r.scoped.value : r.everywhere));
  const [preview, setPreview] = useState<ResponseOf<'previewPolicyChange'> | null>(null);
  const [sent, setSent] = useState<Value | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [review, setReview] = useState(false);
  const ask = async (value: Value | null) => {
    setErr(null); setPreview(null);
    try { setPreview(await call('previewPolicyChange', { body: { key: r.key, scope, value } })); setSent(value); } catch (e) { setErr(e instanceof ApiFailure ? e.error.message : (e as Error).message); }
  };
  useEffect(() => { if (start !== undefined) void ask(start); }, []); // Restore default: preview straight away
  return (
    <div className="box"><div className="box-h"><h3>Change rule · {area === 'PAYABLES' ? 'Payables' : area === 'RECEIVABLES' ? 'Receivables' : 'Everywhere'}</h3><button className="linkbtn" onClick={onClose}>Close</button></div>
      <div className="box-b" style={{ display: 'grid', gap: 10 }}>
        <div className="serif" style={{ fontSize: 20 }}>{r.text}</div>
        {r.scoped && <div className="seg" role="group" aria-label="Where it applies">{(['EVERYWHERE', r.scoped.scope] as const).map((s) => <button key={s} className={scope === s ? 'on' : ''} aria-pressed={scope === s} onClick={() => { setScope(s); setPreview(null); }}>{s === 'EVERYWHERE' ? 'Everywhere' : s === 'PAYABLES' ? 'Paying bills only' : 'Getting paid only'}</button>)}</div>}
        <ValueInput key={scope} r={r} v={v} set={(x) => { setV(x); setPreview(null); }} />
        <div><button className="btn" onClick={() => ask(v)}>Preview</button>{scope !== 'EVERYWHERE' && r.scoped?.value !== null && <> <button className="btn" onClick={() => ask(null)}>Use the everywhere value</button></>}</div>
        {err && <div className="err-banner">{err}</div>}
        {preview && (
          <div className="note" role="status"><strong>What this would change</strong> · {preview.before} → {preview.after}{preview.safety ? ' · This loosens a safety rule' : preview.loosens ? ' · This loosens your delegation' : ''}
            {preview.affected.length ? preview.affected.map((a) => <div key={a.ref}>{a.label}: {a.after}</div>) : <div>Nothing planned right now is affected.</div>}
          </div>
        )}
        <button className="btn primary" disabled={!preview} onClick={() => setReview(true)}>Review change…</button>
      </div>
      {review && preview && <SaveDialog r={r} scope={scope} value={sent} preview={preview} version={version} onClose={() => setReview(false)} onDone={onDone} />}
    </div>
  );
}

function SaveDialog({ r, scope, value, preview, version, onClose, onDone }: { r: Rule; scope: 'EVERYWHERE' | 'RECEIVABLES' | 'PAYABLES'; value: Value | null; preview: ResponseOf<'previewPolicyChange'>; version: number; onClose: () => void; onDone: () => void }) {
  const c = useCommand();
  const [ack, setAck] = useState(false);
  const { refresh } = useApp();
  return (
    <Dialog kicker="Delegation · change rule" title={preview.safety ? 'This loosens a safety rule' : preview.loosens ? 'This loosens your delegation' : 'Save rule change'} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={c.busy || (preview.safety && !ack)} onClick={() => c.run((key) => call('changePolicy', { ifMatch: version, idempotencyKey: key, body: { key: r.key, scope, value, previewHash: preview.previewHash, ...(preview.safety ? { acknowledgeSafety: ack } : {}) } }), 'Rule saved. Delegation updated', () => { refresh(); onDone(); })}>Save</button></>}>
      <div className="what"><h5>CHANGE</h5>{preview.before} → {preview.after}</div>
      {preview.safety && <div className="what"><h5>WHAT HEADROOM MAY THEN DO</h5>{preview.safetyText} The hard stops below still always apply.</div>}
      <div className="what"><h5>CONSEQUENCE</h5>{preview.affected.length ? preview.affected.map((a) => <div key={a.ref}>{a.label}: {a.after}</div>) : 'Nothing planned right now is affected.'} An open plan approval will ask you to review again.</div>
      <div className="what"><h5>SCOPE</h5>Applies from now; recorded in Activity. Hard stops are unchanged.</div>
      {preview.safety && <label className="dl-choice"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> I understand this loosens a safety rule</label>}
      {c.error && <div className="err-banner">{c.error}</div>}
    </Dialog>
  );
}

function PauseDialog({ kind, on, version, onClose, onDone }: { kind: 'OUTREACH' | 'PAYMENTS'; on: boolean; version: number; onClose: () => void; onDone: () => void }) {
  const c = useCommand();
  const { refresh } = useApp();
  const what = kind === 'OUTREACH' ? 'all outreach' : 'all payment preparation';
  return (
    <Dialog kicker="Delegation · stop everything" title={on ? `Pause ${what}` : `Resume ${what}`} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={c.busy} onClick={() => c.run((key) => call('setPause', { ifMatch: version, idempotencyKey: key, body: { kind, on } }), on ? `Paused ${what}` : `Resumed ${what}`, () => { refresh(); onDone(); })}>{on ? 'Pause' : 'Resume'}</button></>}>
      <div className="what"><h5>CONSEQUENCE</h5>{on ? `Nothing of this kind will run while the pause is on, whatever any rule says. You can still approve plans.` : 'Planned work of this kind can run again once its own checks pass.'}</div>
      <div className="what"><h5>SCOPE</h5>The whole business, every page. A banner shows while it is on.</div>
      {c.error && <div className="err-banner">{c.error}</div>}
    </Dialog>
  );
}

function RevokeDialog({ g, onClose, onDone }: { g: D['grants'][number]; onClose: () => void; onDone: () => void }) {
  const c = useCommand();
  return (
    <Dialog kicker="Delegation · approved once" title={`Revoke: ${g.text}`} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={c.busy} onClick={() => c.run((key) => call('revokeGrant', { params: { id: g.grantId }, idempotencyKey: key, body: {} }), 'Permission revoked. Its action needs your approval again', onDone)}>Revoke</button></>}>
      <div>{g.scope}</div>
      <div className="what"><h5>CONSEQUENCE</h5>The action it covered goes back to “Needs your approval”. Nothing has acted on this permission yet. The record stays in Approved once, marked revoked.</div>
      {c.error && <div className="err-banner">{c.error}</div>}
    </Dialog>
  );
}
