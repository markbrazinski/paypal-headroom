// Bill panel (UI-AP-09), the obligation panel (UI-AP-01 row) and the PayPal payout panel (UI-AP-03…07). Verify, accept terms and add-as-separate are separate controls,
// each with its own confirm dialog stating the cash consequence and the scope (C4: verification ≠ acceptance ≠ payment).
import { useMemo, useState } from 'react';
import type { ResponseOf } from '@headroom/contracts';
import { ApiFailure, call } from '../api/client.ts';
import { Dialog, Failed, Loading, Panel, Pill } from '../components.tsx';
import { useApp, useLoad } from '../data.ts';
import { dateTime, day, money } from '../format.ts';

type Detail = ResponseOf<'getBill'>;
type Impact = Detail['impact']['operative'];
type Status = Detail['bill']['status'];

const TONE: Record<Status, ['amber' | 'grey' | 'green' | 'red' | 'slate' | 'brand', string]> = {
  READING: ['grey', '◐'], DATE_DIFFERS: ['amber', '≠'], AMOUNT_DIFFERS: ['amber', '≠'], TERMS_DIFFER: ['amber', '≠'], MATCHES: ['green', '✓'],
  CHOOSE_MATCH: ['amber', '?'], NEW_OBLIGATION: ['slate', '+'], CONFIRM_CURRENCY: ['amber', '$'], VERIFIED: ['brand', '✓'], ACCEPTED: ['green', '✓'],
  HELD: ['amber', '‖'], COULDNT_READ: ['red', '✕'], SUPERSEDED: ['grey', '↻'],
};
export const BillPill = ({ b }: { b: { status: Status; statusLabel: string } }) => <Pill tone={TONE[b.status][0]} glyph={TONE[b.status][1]}>{b.statusLabel}</Pill>;

/** Opens the original PDF from the authenticated JSON route as a Blob (no token in a URL, no public link; C2). */
export async function openOriginal(billId: string) {
  const w = window.open('', '_blank');
  const d = await call('getBillDocument', { params: { id: billId } });
  const url = URL.createObjectURL(new Blob([Uint8Array.from(atob(d.contentBase64), (c) => c.charCodeAt(0))], { type: 'application/pdf' }));
  if (w) w.location.href = url; else location.href = url;
}

function ImpactRows({ title, i, due }: { title: string; i: Impact; due?: string | null }) {
  if (i.state === 'UNKNOWN') return <><div className="kv strong"><span>{title}</span></div><div className="small" style={{ color: 'var(--amber)' }}>Cash impact unknown: {i.reason}</div></>;
  const s = i.summary;
  return (
    <>
      <div className="kv strong"><span>{title}</span></div>
      {due && i.closeOnDue && <div className="kv"><span>{day(i.closeOnDue.on)} projected balance</span><span className={`num ${i.closeOnDue.close.minor <= 0 ? 'neg' : ''}`}>{money(i.closeOnDue.close)}</span></div>}
      <div className="kv"><span>Lowest projected</span><span className="num">{money(s.low)} · {day(s.lowOn)}</span></div>
      <div className="kv"><span>First reserve breach</span><span className="num">{s.firstBelowReserve ? day(s.firstBelowReserve) : 'None in the next 6 weeks'}</span></div>
      <div className="kv"><span>Reserve gap</span><span className={`num ${s.reserveGap.minor ? 'neg' : ''}`}>{money(s.reserveGap)}</span></div>
      <div className="kv"><span>Funding deficit</span><span className="num">{money(s.fundingDeficit)}</span></div>
    </>
  );
}

const consequence = (i: Impact | null | undefined) => !i ? null : i.state === 'UNKNOWN' ? `Cash impact unknown: ${i.reason}.`
  : `${i.closeOnDue ? `${day(i.closeOnDue.on)} closes at ${money(i.closeOnDue.close)}. ` : ''}${i.summary.firstBelowReserve ? `First below reserve ${day(i.summary.firstBelowReserve)}; ` : 'Stays above your reserve; '}lowest point ${money(i.summary.low)} on ${day(i.summary.lowOn)}; reserve gap ${money(i.summary.reserveGap)}, funding deficit ${money(i.summary.fundingDeficit)}. Cash now unchanged.`;

export function BillPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const { nav, toast, session } = useApp();
  const q = useLoad(() => call('getBill', { params: { id } }), [id]);
  const [dialog, setDialog] = useState<'verify' | 'accept' | 'separate' | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const b = q.data;
  const retry = async () => {
    if (!b) return;
    setBusy(true);
    try { await call('retryBill', { params: { id }, ifMatch: b.bill.version }); toast('Reading the bill again.'); q.reload(); }
    catch (e) { toast((e as Error).message); } finally { setBusy(false); }
  };
  const chosen = b?.candidates.find((c) => c.occurrenceKey === pick) ?? null;
  return (
    <Panel kicker={b ? `Bill · ${b.bill.ref ?? b.document.fileName} · ${b.bill.supplierName ?? 'unknown sender'} · received ${dateTime(b.bill.receivedAt)}` : 'Bill'} onClose={onClose}
      title={b?.headline ?? 'Bill'} status={b && <div style={{ marginTop: 4 }}><BillPill b={b.bill} /> <span className="muted small">Nothing paid · payment not authorized</span></div>}>
      {q.error ? <Failed error={q.error} /> : !b ? <Loading /> : (
        <>
          <div className="sec actions">
            {b.actions.verify.allowed && <button className="btn primary" onClick={() => setDialog('verify')} disabled={b.bill.status === 'CHOOSE_MATCH' && !chosen}>{b.actions.verify.label}</button>}
            {b.actions.acceptTerms.allowed && <button className="btn primary" onClick={() => setDialog('accept')}>{b.actions.acceptTerms.label}</button>}
            {!b.actions.acceptTerms.allowed && b.changedFields.length > 0 && b.bill.state === 'PROPOSED' && <button className="btn" disabled title={b.actions.acceptTerms.reason ?? undefined}>{b.actions.acceptTerms.label}</button>}
            {b.actions.addSeparate.allowed && <button className="btn" onClick={() => setDialog('separate')}>{b.actions.addSeparate.label}</button>}
            {b.actions.compare.allowed && <button className="btn" onClick={() => nav(`/cash?compare=bill:${id}`)}>{b.actions.compare.label}</button>}
            {b.actions.retry.allowed && <button className="btn primary" onClick={retry} disabled={busy}>{b.actions.retry.label}</button>}
            {b.changedFields.includes('dueOn') && !b.asks.length && <button className="btn" onClick={() => nav('/plan')} title={b.actions.askSupplier.reason ?? undefined}>{b.actions.askSupplier.label} on the Plan ›</button>}
            {b.changedFields.includes('dueOn') && !b.asks.length && <div className="small muted" style={{ width: '100%' }}>{b.actions.askSupplier.reason}</div>}
            {b.bill.state === 'PROPOSED' && b.bill.status === 'CHOOSE_MATCH' && !chosen && <div className="small muted" style={{ width: '100%' }}>Choose the payment below to verify.</div>}
          </div>
          {b.asks.map((k) => <AskSection key={k.askId} k={k} supplier={b.bill.supplierName ?? 'the supplier'} onDone={q.reload} />)}
          {b.bill.amount && b.occurrence && (
            <div className="facts">
              <div><div className="muted small">Amount</div><div className="v">{money(b.bill.amount)}</div><div className="small muted">{b.changedFields.includes('amount') ? `agreed ${money(b.occurrence.amount)}` : '✓ matches'}</div></div>
              <div><div className="muted small">Agreed</div><div className="v">{day(b.occurrence.dueOn)}</div><div className="small muted">{b.occurrence.commitmentName}</div></div>
              <div><div className="muted small">Requested</div><div className="v">{day(b.bill.dueOn)}</div><div className="small muted">on the bill</div></div>
            </div>
          )}
          {(b.holdReasons.length > 0 || b.readFailure) && <div className="sec"><h4>{b.bill.state === 'READ_FAILED' ? "Couldn't read" : 'Held'}</h4>{[...(b.readFailure ? [b.readFailure] : []), ...b.holdReasons].map((r) => <div key={r} className="small" style={{ color: 'var(--amber)' }}>‖ {r}</div>)}</div>}
          {b.checks.length > 0 && <div className="sec"><h4>{b.occurrence ? 'Proposed match' : 'Checks'}</h4>
            {b.checks.map((c) => <div key={c.key} className="check"><span className={`ck ck-${c.result}`} aria-hidden>{c.result === 'OK' ? '✓' : c.result === 'UNKNOWN' ? '?' : '!'}</span><span><strong>{c.label}</strong>{c.detail ? <span className="muted"> · {c.detail}</span> : null}</span></div>)}
          </div>}
          {b.note && <div className="sec small">{b.note}</div>}
          {b.candidates.length > 0 && (
            <div className="sec"><h4>Which payment is this bill for?</h4>
              <div role="radiogroup" aria-label="Candidate payments">
                {b.candidates.map((c) => (
                  <label key={c.occurrenceKey} className={`choice ${pick === c.occurrenceKey ? 'on' : ''}`}>
                    <input type="radio" name="cand" checked={pick === c.occurrenceKey} onChange={() => setPick(c.occurrenceKey)} />
                    <span><strong>{c.commitmentName} · {day(c.dueOn)} · {money(c.amount)}</strong>{c.reference ? ` · ${c.reference}` : ''}<br />
                      <span className="small muted">{c.alreadyBilled ? 'Already has a bill' : 'No bill yet'} · {c.ifSelected.state === 'KNOWN' ? `if chosen: lowest ${money(c.ifSelected.summary.low)} on ${day(c.ifSelected.summary.lowOn)}, reserve gap ${money(c.ifSelected.summary.reserveGap)}` : `impact unknown: ${c.ifSelected.reason}`}</span></span>
                  </label>
                ))}
              </div>
            </div>
          )}
          {(b.impact.ifAccepted || b.bill.state !== 'RECEIVED') && (
            <div className="sec"><h4>Impact comparison</h4>
              <ImpactRows title={b.occurrence ? `Operative · agreed ${day(b.occurrence.dueOn)}` : 'Operative forecast'} i={b.impact.operative} />
              {b.impact.ifAccepted && <div style={{ marginTop: 8 }}><ImpactRows title={b.classification === 'NEW_OBLIGATION_KNOWN_SUPPLIER' ? 'If added as a separate obligation' : `If ${b.bill.dueOn ? day(b.bill.dueOn) : 'the new terms are'} accepted`} i={b.impact.ifAccepted} due={b.bill.dueOn} /></div>}
            </div>
          )}
          {b.fields.length > 0 && (
            <div className="sec"><h4>Read from the bill</h4>
              {b.fields.map((f) => (
                <div key={f.name} className="kv small field-row">
                  <span>{f.name.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase())}</span>
                  <span style={{ textAlign: 'right' }}>{f.grounded ? <>{f.value}<br /><span className="muted">“{f.quote}”</span></> : <span className="muted">— {f.reason}</span>}</span>
                </div>
              ))}
              {b.flags.includes('UNTRUSTED_INSTRUCTION_TEXT') && <div className="small" style={{ color: 'var(--amber)', marginTop: 6 }}>‖ The document contains instructions. Headroom ignored them: nothing in it sets an amount, date, payee or state.</div>}
            </div>
          )}
          <div className="sec"><h4>Original document</h4>
            <div className="small">{b.document.fileName} · {(b.document.bytes / 1024).toFixed(1)} KB · {b.document.source === 'OWNER_UPLOAD' ? 'uploaded by you' : b.document.source === 'MAIL' ? 'arrived by email' : 'brought in by the operator'}</div>
            <button className="btn" style={{ marginTop: 8 }} onClick={() => openOriginal(id).catch((e) => toast((e as Error).message))}>Open original</button>
          </div>
          <div className="sec small">
            <div><strong>Authority</strong></div>
            <div className="muted">Verifying says the document is a genuine bill. It does not change dates or amounts and does not permit payment. Accepting new terms changes only the fields named. Paying it needs your separate payout authority in a plan, and a PayPal address you confirmed.</div>
            {b.verification && <div style={{ marginTop: 6 }}>✓ Verified by {b.verification.by} · {dateTime(b.verification.at)}{b.verification.currencyAttested ? ' · confirmed US dollars' : ''}</div>}
            {b.acceptance && <div>✓ {b.acceptance.kind === 'SEPARATE_OBLIGATION' ? 'Added as a separate obligation' : `Accepted ${b.acceptance.changedFields.map((x) => (x === 'dueOn' ? 'date' : 'amount')).join(' and ')}`} by {b.acceptance.by} · {dateTime(b.acceptance.at)}</div>}
          </div>
          {b.extraction.length > 0 && <div className="sec small"><h4>How it was read</h4><div className="muted">Read by Headroom’s model{b.extraction.length > 1 ? ` (${b.extraction.length} attempts)` : ''}. Values were kept only where the quoted text is in the document.</div>
            {/* UX audit F09: model id, tokens, latency and the document hash are operator diagnostics, not owner copy. */}
            {session.role === 'OPERATOR' && <details className="muted"><summary>Technical details (operator)</summary>{b.extraction.map((m) => <div key={`${m.generation}-${m.k}`}>{m.modelId} · {m.state.toLowerCase().replace(/_/g, ' ')}{m.inputTokens !== null ? ` · ${m.inputTokens} in / ${m.outputTokens} out tokens` : ''}{m.latencyMs !== null ? ` · ${m.latencyMs} ms` : ''}</div>)}<div className="mono">sha256 {b.document.sha256}</div></details>}</div>}
          {b.audit.length > 0 && <div className="sec small"><h4>Activity</h4>{b.audit.slice(0, 8).map((a) => <div key={a.eventId} className="muted">{dateTime(a.when)} · {a.by} · {a.result}</div>)}</div>}
          {dialog === 'verify' && <VerifyDialog b={b} occ={chosen ?? b.occurrence} onClose={() => setDialog(null)} onDone={() => { setDialog(null); q.reload(); }} />}
          {dialog === 'accept' && <AcceptDialog b={b} onClose={() => setDialog(null)} onDone={() => { setDialog(null); q.reload(); }} />}
          {dialog === 'separate' && <SeparateDialog b={b} onClose={() => setDialog(null)} onDone={() => { setDialog(null); q.reload(); }} />}
        </>
      )}
    </Panel>
  );
}

function useCommand() {
  const { toast } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [key] = useState(() => crypto.randomUUID());
  const run = async (f: (key: string) => Promise<unknown>, ok: string, done: () => void) => {
    setBusy(true); setError(null);
    try { await f(key); toast(ok); done(); }
    catch (e) { setError(e instanceof ApiFailure ? `${e.error.message}${e.error.code === 'VERSION_CONFLICT' || e.error.code === 'TERMS_CHANGED' ? ' Close this and reload the bill.' : ''}` : (e as Error).message); }
    finally { setBusy(false); }
  };
  return { busy, error, run };
}

function VerifyDialog({ b, occ, onClose, onDone }: { b: Detail; occ: Detail['occurrence']; onClose: () => void; onDone: () => void }) {
  const c = useCommand();
  const bare = b.currencyBasis === 'BARE_DOLLAR';
  const [usd, setUsd] = useState(false);
  return (
    <Dialog kicker="Payables · Verify bill" title={`Verify ${b.bill.ref ?? 'this bill'}`} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={c.busy || (bare && !usd) || !occ} onClick={() => c.run((key) => call('verifyBill', { params: { id: b.bill.billId }, ifMatch: b.bill.version, idempotencyKey: key, body: { occurrenceKey: occ!.occurrenceKey, occurrenceVersion: occ!.version, ...(bare ? { currency: 'USD' as const } : {}) } }), 'Bill verified. The forecast is unchanged.', onDone)}>Verify bill</button></>}>
      <div>This document is a genuine bill from <strong>{b.bill.supplierName}</strong> for <strong>{occ?.commitmentName}</strong> ({day(occ?.dueOn)}, {money(occ?.amount)}).</div>
      {bare && <label className="field" style={{ fontWeight: 400 }}><span><input type="checkbox" checked={usd} onChange={(e) => setUsd(e.target.checked)} style={{ width: 'auto', height: 'auto', marginRight: 8 }} />This bill is in US dollars</span><span className="small muted">Only "$" is printed, which could be another dollar. Headroom uses the amount only once you confirm.</span></label>}
      <div className="what"><h5>WHAT CHANGES</h5>The bill is linked to the payment. Dates, amount and payment are not changed{b.changedFields.length ? `; the bill's different ${b.changedFields.map((x) => (x === 'dueOn' ? 'date' : 'amount')).join(' and ')} stays a comparison until you accept it` : ''}. Payment stays not authorized.</div>
      {c.error && <div className="err-banner">{c.error}</div>}
    </Dialog>
  );
}

function AcceptDialog({ b, onClose, onDone }: { b: Detail; onClose: () => void; onDone: () => void }) {
  const c = useCommand();
  const o = b.occurrence!;
  const p = b.proposedTerms!;
  const names = b.changedFields.map((x) => (x === 'dueOn' ? 'date' : 'amount'));
  return (
    <Dialog kicker="Payables · Accept bill terms" title={b.actions.acceptTerms.label.replace('…', '')} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={c.busy} onClick={() => c.run((key) => call('acceptBillTerms', { params: { id: b.bill.billId }, ifMatch: b.bill.version, idempotencyKey: key, body: { termsHash: b.termsHash!, changedFields: b.changedFields } }), `New ${names.join(' and ')} accepted. Still one payment; nothing paid.`, onDone)}>Accept new {names.join(' and ')}</button></>}>
      <div><strong>{o.commitmentName}</strong> · {b.bill.ref}</div>
      {b.changedFields.includes('dueOn') && <div className="kv"><span>Date</span><span className="num">{day(o.dueOn)} → <strong>{day(p.dueOn)}</strong></span></div>}
      {b.changedFields.includes('amount') && <div className="kv"><span>Amount (USD)</span><span className="num">{money(o.amount)} → <strong>{money(p.amount)}</strong></span></div>}
      <div className="what"><h5>CASH CONSEQUENCE</h5>{consequence(b.impact.ifAccepted)}</div>
      <div className="what"><h5>SCOPE</h5>Changes only the {names.join(' and ')} of this one payment. Payment stays not authorized; your rules are unchanged.</div>
      {c.error && <div className="err-banner">{c.error}</div>}
    </Dialog>
  );
}

export function SeparateDialog({ b, onClose, onDone }: { b: Detail; onClose: () => void; onDone: () => void }) {
  const c = useCommand();
  const bare = b.currencyBasis === 'BARE_DOLLAR';
  const [usd, setUsd] = useState(false);
  const amount = b.bill.amount ?? null;
  return (
    <Dialog kicker="Payables · Separate obligation" title={`Add ${b.bill.ref ?? 'this bill'} as a new outflow`} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={c.busy || (bare && !usd)} onClick={() => c.run((key) => call('addBillAsObligation', { params: { id: b.bill.billId }, ifMatch: b.bill.version, idempotencyKey: key, body: { termsHash: b.separateTermsHash!, ...(bare ? { currency: 'USD' as const } : {}) } }), 'Bill verified and added as a new outflow. Nothing paid.', onDone)}>Verify and add</button></>}>
      <div>✓ This bill is genuine (verification).</div>
      <div>✓ Add {amount ? money(amount) : (b.bill.printedTotal ?? 'the amount')} due {day(b.bill.dueOn)} to {b.bill.supplierName} as a new outflow (terms).</div>
      {b.occurrence && <div className="small muted">{b.occurrence.commitmentName} stays as it is; this adds a second outflow. Choose only if it is really billed twice.</div>}
      {bare && <label className="field" style={{ fontWeight: 400 }}><span><input type="checkbox" checked={usd} onChange={(e) => setUsd(e.target.checked)} style={{ width: 'auto', height: 'auto', marginRight: 8 }} />This bill is in US dollars</span></label>}
      <div className="what"><h5>CASH CONSEQUENCE</h5>{consequence(b.impact.ifAdded) ?? 'Cash impact unknown until the currency is confirmed.'}</div>
      <div className="what"><h5>SCOPE</h5>Two records: the verification and the new terms. Payment stays not authorized.</div>
      {c.error && <div className="err-banner">{c.error}</div>}
    </Dialog>
  );
}

/** One scheduled payment: its terms, basis, substantiation and terms history. A PayPal-payout obligation opens the payout panel. */
export function ObligationPanel({ occurrenceKey, onClose, onBill }: { occurrenceKey: string; onClose: () => void; onBill: (id: string) => void }) {
  const q = useLoad(() => call('listPayables'), [occurrenceKey]);
  const o = q.data?.obligations.find((x) => x.occurrenceKey === occurrenceKey);
  if (o?.payout) return <PayoutPanel occurrenceKey={occurrenceKey} title={`${o.name}${o.supplierName ? ` · ${o.supplierName}` : ''}`} onClose={onClose} onBill={onBill} />;
  return (
    <Panel kicker="Payment · Payables" title={o ? `${o.name}${o.supplierName ? ` · ${o.supplierName}` : ''}` : 'Payment'} onClose={onClose}
      status={o && <div className="small muted"><Pill tone={o.pastDue ? 'amber' : 'grey'} glyph="○">{o.pastDue ? 'Past due' : 'Scheduled'}</Pill> {money(o.amount)} · due {day(o.dueOn)} · {o.billApproved ? `bill ${o.billApproved}` : 'no bill yet'}</div>}>
      {q.error ? <Failed error={q.error} /> : !q.data ? <Loading /> : !o ? <div className="sec muted">This payment is no longer scheduled.</div> : (
        <>
          <div className="facts">
            <div><div className="muted small">Amount</div><div className="v">{money(o.amount)}</div></div>
            <div><div className="muted small">Due</div><div className="v">{day(o.dueOn)}</div><div className="small muted">{o.afterHorizon ? 'after the forecast window' : o.pastDue ? 'past due, not paid' : 'in the forecast'}</div></div>
            <div><div className="muted small">Bill</div><div className="v">{o.billApproved ?? 'Not received'}</div>{o.substantiatedBy && <button className="linkbtn small" onClick={() => onBill(o.substantiatedBy!)}>Open bill</button>}</div>
          </div>
          <div className="sec small"><h4>In the forecast</h4>Counted as one {money(o.amount)} outflow on {day(o.dueOn)}{o.afterHorizon ? ' once the forecast window reaches it' : ''}. When its bill arrives, Headroom matches it to this payment instead of adding a second outflow.</div>
          <div className="sec small"><h4>Permission to pay</h4>Not needed here. Bill approval isn't permission to pay. Headroom pays only suppliers paid through PayPal Payouts{o.afterHorizon ? ', once the payment is inside the forecast window' : ''}; this one is paid outside Headroom.</div>
          {o.history.length > 0 && <div className="sec small"><h4>Terms history</h4>{o.history.map((h) => <div key={h.at}>{dateTime(h.at)} · {h.changedFields.length ? `${h.changedFields.map((x) => (x === 'dueOn' ? 'date' : 'amount')).join(' and ')} ${h.before} → ${h.after}` : `added from a bill: ${h.after}`} · <button className="linkbtn" onClick={() => onBill(h.billId)}>bill</button></div>)}</div>}
        </>
      )}
    </Panel>
  );
}

type Payout = ResponseOf<'getPayout'>;
type PayoutPillName = Payout['pill'];
const PAYOUT_TONE: Record<PayoutPillName, ['amber' | 'grey' | 'green' | 'red' | 'slate' | 'brand', string, string]> = {
  PAID: ['green', '✓', 'Paid'], NOT_PAID: ['red', '✕', 'Not paid'], UNKNOWN: ['amber', '?', 'Checking with PayPal'], SUBMITTED: ['brand', '◐', 'Sent to PayPal'],
  RESERVED: ['brand', '◐', 'Reserved'], PAUSED: ['grey', '‖', 'Paused'], HELD: ['amber', '‖', 'Held'], WAITING_FOR_REPORT: ['amber', '◐', "Waiting for PayPal's report"],
  FUNDED_NEEDS_APPROVAL: ['amber', '!', 'Funded · needs approval'], READY: ['green', '✓', 'Ready'], NOT_DUE: ['grey', '○', 'Not due'], NO_PLAN: ['grey', '○', 'Not in a plan'],
};
export const PayoutPill = ({ pill }: { pill: PayoutPillName }) => <Pill tone={PAYOUT_TONE[pill][0]} glyph={PAYOUT_TONE[pill][1]}>{PAYOUT_TONE[pill][2]}</Pill>;

type Verdict = NonNullable<Payout['readiness']>['rail']['verdict'];
const VERDICT: Record<Verdict, [string, string, string]> = { PASS: ['OK', '✓', ''], FAIL: ['FAIL', '✕', 'no'], HELD_EVIDENCE: ['HELD', '‖', 'held: waiting for evidence'], UNKNOWN: ['UNKNOWN', '?', 'unknown'] };
const VerdictLine = ({ label, v, detail }: { label: string; v: Verdict; detail: string[] }) => (
  <div className="check"><span className={`ck ck-${VERDICT[v][0]}`} aria-hidden>{VERDICT[v][1]}</span><span><strong>{label}</strong>{VERDICT[v][2] && <span className="muted"> · {VERDICT[v][2]}</span>}{detail.length > 0 && <span className="muted"> · {detail.join('; ')}</span>}</span></div>
);

/** S6 Keller panel (UI-AP-03…07): readiness with the PayPal rail and the company kept apart, then PayPal's payment result. Every figure and sentence is the server's. */
function PayoutPanel({ occurrenceKey, title, onClose, onBill }: { occurrenceKey: string; title: string; onClose: () => void; onBill: (id: string) => void }) {
  const { nav } = useApp();
  const q = useLoad(() => call('getPayout', { params: { id: occurrenceKey } }), [occurrenceKey]);
  const [confirm, setConfirm] = useState(false);
  const v = q.data;
  const r = v?.readiness;
  const e = v?.effect;
  return (
    <Panel kicker={`Payment${v?.billRef ? ` · ${v.billRef}` : ''} · Payables`} title={title} onClose={onClose}
      status={v && <div className="small muted"><PayoutPill pill={v.pill} /> {money(v.amount)} · due {day(v.payBy)}{r ? ` · checked ${dateTime(r.checkedAt)}` : ''}</div>}>
      {q.error ? <Failed error={q.error} /> : !v ? <Loading /> : (
        <>
          <div className="sec actions">
            {v.payee?.state === 'UNCONFIRMED' && <button className="btn primary" onClick={() => setConfirm(true)}>Confirm {v.supplier.name}'s PayPal address…</button>}
            {v.pill === 'FUNDED_NEEDS_APPROVAL' && <button className="btn primary" onClick={() => nav('/plan')}>Approve this payment once…</button>}
            {v.billId && <button className="btn" onClick={() => onBill(v.billId!)}>Open bill</button>}
            {(v.pill === 'FUNDED_NEEDS_APPROVAL' || v.pill === 'PAUSED' || v.pill === 'HELD') && <button className="btn" onClick={() => nav('/delegation')}>Open Delegation › Payables</button>}
            {v.pill === 'FUNDED_NEEDS_APPROVAL' && <div className="small muted" style={{ width: '100%' }}>{v.supplier.name}{v.billRef ? ` ${v.billRef}` : ''} only · your limits are unchanged</div>}
            {(v.pill === 'NOT_DUE' || v.pill === 'READY') && <div className="small" style={{ width: '100%' }}>{v.pillText}</div>}
          </div>
          <div className="facts">
            <div><div className="muted small">Amount</div><div className="v">{money(v.amount)}</div></div>
            <div><div className="muted small">Pays</div><div className="v">{day(v.payBy)}</div><div className="small muted">{v.payee ? `to ${v.payee.masked}` : 'no PayPal address'}</div></div>
            <div><div className="muted small">Checked</div><div className="v">{r ? dateTime(r.checkedAt) : '—'}</div></div>
          </div>
          <div className="sec"><h4>Status</h4><div className="what">{v.status}</div></div>
          {r && <>
            <div className="sec"><h4>Payment readiness · now</h4>
              {r.checks.map((c) => <div key={c.key} className="check"><span className={`ck ck-${c.ok ? 'OK' : 'FAIL'}`} aria-hidden>{c.ok ? '✓' : '✕'}</span><span>{c.text}</span></div>)}
              <VerdictLine label="PayPal balance can fund it" v={r.rail.verdict} detail={r.rail.reasons} />
              <VerdictLine label="Company: stays above reserve" v={r.company.verdict} detail={[...(r.company.min ? [`lowest ${money(r.company.min.amount)} on ${day(r.company.min.on)}, reserve ${money(r.company.reserve)}`] : []), ...r.company.reasons]} />
            </div>
            <div className="sec"><h4>Usable for this payment · PayPal</h4>
              {/* The server's lower bound already has every other payout taken out (S6 R1): shown once, never subtracted again here. */}
              <div className="kv"><span>Usable on PayPal · as of {dateTime(r.rail.asOf)}</span><span className="num">{money(r.rail.usable)}</span></div>
              {r.rail.otherReserved.minor > 0 && <div className="kv small muted"><span>already after {money(r.rail.otherReserved)} reserved for other payouts</span><span /></div>}
              {r.rail.upper && r.rail.lower && r.rail.upper.minor !== r.rail.lower.minor && <div className="kv small muted"><span>Upper figure (captured, not yet in PayPal's report), not counted</span><span className="num">{money(r.rail.upper)}</span></div>}
              <div className="kv strong"><span>Needed on PayPal · the most this payment may take</span><span className="num">{money(r.rail.need)}</span></div>
              {r.rail.short ? <div className="kv strong"><span>Short</span><span className="num neg">{money(r.rail.short)}</span></div>
                : r.rail.remainingAfter && <div className="kv strong"><span>Remaining after payment</span><span className="num">{money(r.rail.remainingAfter)}</span></div>}
              <div className="small muted">Read from PayPal {dateTime(r.rail.fetchedAt)}</div>
            </div>
            <div className="sec small"><h4>Not counted</h4>{r.notCounted.map((t) => <div key={t}>• {t}</div>)}</div>
            {r.toReady.length > 0 && <div className="sec small"><h4>What would make it ready</h4>{r.toReady.map((t) => <div key={t}>• {t}</div>)}</div>}
          </>}
          {e && (
            <div className="sec"><h4>Payment result</h4>
              {e.timeline.map((t, i) => <div key={i} className="kv small"><span>{t.event}{t.ref && <span className="muted mono"> {t.ref}</span>}</span><span className="muted">{dateTime(t.at)}</span></div>)}
              {v.pill === 'UNKNOWN' && <div className="small" style={{ color: 'var(--amber)', marginTop: 6 }}>? Checking with PayPal{e.unknownSince ? ` since ${dateTime(e.unknownSince)}` : ''}. Headroom asks PayPal about this same payment; it is never sent again under a new id.</div>}
              <div className="ledger small" style={{ marginTop: 8 }}>
                <div className="kv"><span>Payment id</span><span className="mono">{e.senderBatchId}</span></div>
                <div className="kv"><span>PayPal batch</span><span className="mono">{e.batchId ?? '—'}</span></div>
                <div className="kv"><span>Item</span><span className="mono">{e.itemId ?? '—'}{e.itemStatus ? ` · ${e.itemStatus}` : ''}</span></div>
                <div className="kv"><span>Transaction</span><span className="mono">{e.transactionId ?? '—'}</span></div>
                
                <div className="kv"><span>Time processed</span><span>{dateTime(e.timeProcessed)}</span></div>
                {e.state === 'PAID' && <div className="kv strong"><span>{e.inReport ? "✓ In PayPal's report" : "Paid · awaiting PayPal's report"}</span></div>}
              </div>
            </div>
          )}
          {confirm && v.payee && <ConfirmPayeeDialog v={v} onClose={() => setConfirm(false)} onDone={() => { setConfirm(false); q.reload(); }} />}
        </>
      )}
    </Panel>
  );
}

/** R9: the owner types the address the supplier gave them; the server compares hashes. Identity only, never permission to pay. */
function ConfirmPayeeDialog({ v, onClose, onDone }: { v: Payout; onClose: () => void; onDone: () => void }) {
  const { toast, refresh } = useApp();
  const [addr, setAddr] = useState('');
  const [full, setFull] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const key = useMemo(() => crypto.randomUUID(), [addr]); // one key per typed address: a double click replays, an edit is a new attempt
  const reveal = () => call('revealPayee', { params: { id: v.supplier.id } }).then((x) => setFull(x.address), (e) => setMsg((e as Error).message));
  const submit = async () => {
    setBusy(true); setMsg(null);
    try {
      const res = await call('confirmPayee', { params: { id: v.supplier.id }, idempotencyKey: key, body: { version: v.payee!.version, address: addr.trim() } });
      if (res.matched) { toast(res.message); refresh(); onDone(); } else setMsg(res.message);
    } catch (e) {
      setMsg(e instanceof ApiFailure && e.error.code === 'CONSENT_CHANGED' ? `${v.supplier.name}'s address changed while this was open · review again` : e instanceof ApiFailure ? e.error.message : (e as Error).message);
    } finally { setBusy(false); }
  };
  return (
    <Dialog kicker="Payables · PayPal address" title={`Confirm ${v.supplier.name}'s PayPal address`} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || addr.trim().length < 3} onClick={submit}>Confirm address</button></>}>
      <label className="field">The PayPal address {v.supplier.name} gave you
        <input type="email" autoComplete="off" value={addr} onChange={(e) => setAddr(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !busy && addr.trim().length >= 3) submit(); }} />
      </label>
      <div className="small">Headroom would pay <strong className="mono">{full ?? v.payee!.masked}</strong>{!full && <> · <button className="linkbtn" onClick={reveal}>Show full address</button></>}</div>
      <div className="what"><h5>SCOPE</h5>Confirms who Headroom pays. It does not approve any payment; payments still need your approval in the plan.</div>
      {msg && <div className="err-banner">{msg}</div>}
    </Dialog>
  );
}

/** S7 R6: Headroom's ask to the supplier, the code-made options, and each answer. Their reply changes nothing until you accept it. */
function AskSection({ k, supplier, onDone }: { k: ResponseOf<'getBill'>['asks'][number]; supplier: string; onDone: () => void }) {
  const { toast, refresh } = useApp();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [key] = useState(() => crypto.randomUUID());
  const opt = (code: 'KEEP' | 'SPLIT') => k.options.find((o) => o.code === code);
  const text = (code: 'KEEP' | 'SPLIT') => opt(code)?.parts.map((p) => `${money(p.amount)} on ${day(p.dueOn)}`).join(' + ') ?? '';
  const go = async (f: () => Promise<unknown>, ok: string) => {
    setBusy(true); setErr(null);
    try { await f(); toast(ok); refresh(); onDone(); } catch (e) { setErr(e instanceof ApiFailure ? e.error.message : (e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="sec">
      <h4>Asked {supplier} about the date</h4>
      <div className="small muted">{k.status} · offered: keep {text('KEEP')}{opt('SPLIT') ? ` · or split ${text('SPLIT')}` : ''}</div>
      {k.answers.length === 0 && <div className="small muted" style={{ marginTop: 6 }}>No answer yet.</div>}
      {k.answers.map((a) => (
        <div key={a.answerId} className="mail-card" style={{ marginTop: 8 }}>
          <div className="small"><strong>From</strong> {a.from} · <span className="muted">{dateTime(a.receivedAt)}</span></div>
          <blockquote className="quote">“{a.quote}”</blockquote>
          <div className="small">{a.intent === 'TERMS_AGREED' ? `Agrees to ${a.matched === 'KEEP' ? `keep ${text('KEEP')}` : `the split: ${text('SPLIT')}`}` : a.intent === 'TERMS_COUNTER' ? 'Proposes different terms: Headroom changes nothing; talk to them, then decline or ask again' : a.intent === 'TERMS_DECLINED' ? 'Declines' : 'A reply about the ask'} · {a.state === 'OPEN' ? 'waiting for you' : a.state.toLowerCase()}</div>
          {a.state === 'OPEN' && (
            <div className="act-btns" style={{ marginTop: 6 }}>
              {a.matched && <button className="btn primary" disabled={busy} onClick={() => go(() => call('acceptSupplierAnswer', { params: { id: k.askId }, idempotencyKey: key, body: { answerId: a.answerId, option: a.matched!, obligationVersion: k.obligationVersion, billVersion: k.billVersion } }), 'Accepted · the bill’s terms changed; paying still needs your payout authority')}>Accept: {a.matched === 'KEEP' ? 'keep the date' : 'split the payment'}</button>}
              <button className="btn" disabled={busy} onClick={() => go(() => call('declineSupplierAnswer', { params: { id: k.askId }, body: { answerId: a.answerId } }), 'Declined · terms unchanged')}>Decline</button>
            </div>
          )}
        </div>
      ))}
      {err && <div className="err-banner">{err}</div>}
    </div>
  );
}
