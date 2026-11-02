// EXPERIMENTAL golden run (owner, 3 Nov 2026): `?demo=1` replays the hero journey recorded by scripts/demo/golden-record.ts
// from /golden/*.json, in this browser only. No server, no PayPal. The presenter's off-camera keys fire the outside events:
//   ]  next event (bill arrives, Headroom asks, Pellow pays, Harrow pays, Mercer check, Keller paid)    [  back one step
//   ?demo=1 starts over · ?demo=1&step=N jumps · ?demo=0 leaves. The owner's own clicks (verify, accept, approve) move it too.
// Real email (owner, 3 Nov 2026): when the presenter is signed in as the operator in this tab, the step where Headroom asks sends those
// asks as real Gmail messages to the test inbox (server route goldenMail, operator only). Only after Gmail confirms them does the
// demo relabel them "Gmail · real email to your test inbox". Not signed in (judges): nothing is sent and the recording's labels stay.
// Roll back: delete this file, web/public/golden/, scripts/demo/golden-record.ts and the `golden` lines in client.ts and auth.ts.
import { freshToken, groups } from '../auth.ts';
type Res = { status: number; body: unknown };
type Index = { steps: { name: string; trigger: 'start' | 'key' | 'post'; now: string }[]; posts: Record<string, Res & { to: number | null }> };
const K = 'hr.golden';
const MAIL = 'hr.golden.mail';
type Mail = { state: 'SENDING' | 'SENT' | 'FAILED'; id?: string; n?: number; reason?: string; at?: string };
const mail = (): Mail | null => { try { return JSON.parse(sessionStorage.getItem(MAIL) ?? 'null'); } catch { return null; } };
const setMail = (m: Mail) => { sessionStorage.setItem(MAIL, JSON.stringify(m)); document.dispatchEvent(new Event('visibilitychange')); };
const q = new URLSearchParams(location.search);
if (q.get('demo') === '0') sessionStorage.removeItem(K);
if (q.get('demo') === '1') { sessionStorage.setItem(K, q.get('step') ?? '0'); sessionStorage.removeItem(MAIL); }
export const goldenOn = () => sessionStorage.getItem(K) !== null;

let index: Index | null = null;
const steps = new Map<number, { now: string; gets: Record<string, Res> }>();
const load = async <T,>(f: string): Promise<T> => (await fetch(`/golden/${f}`)).json();
const stepNo = () => Number(sessionStorage.getItem(K) ?? 0);
async function stepData(n: number) {
  if (!steps.has(n)) steps.set(n, await load(`step-${n}.json`));
  return steps.get(n)!;
}
/** Judge dock (owner, 4 Nov 2026): the dock drives the same steps as the keys. */
export const goldenStep = () => stepNo();
export const goldenIndex = async () => (index ??= await load<Index>('index.json'));
export const goldenGo = (n: number) => moveTo(n);
/** Start the recording from the top (and leave Live); `goldenStop` leaves it for the live app. Both reload into Overview. */
export const goldenStart = () => { sessionStorage.removeItem('hr.mode'); sessionStorage.setItem(K, '0'); sessionStorage.removeItem(MAIL); location.assign('/overview'); };
export const goldenStop = () => { sessionStorage.setItem('hr.mode', 'live'); sessionStorage.removeItem(K); sessionStorage.removeItem(MAIL); location.assign('/overview'); };

export function moveTo(n: number) {
  if (!index) return;
  const to = Math.max(0, Math.min(index.steps.length - 1, n));
  sessionStorage.setItem(K, String(to));
  void stepData(to).then(() => document.dispatchEvent(new Event('visibilitychange'))); // the shell refetches at once
  if (index.steps[to]?.name === 'Headroom asks') void sendAsks(to);
}

/** The asks of this step, sent for real through the server (operator sign-in in this tab); once per playback. */
async function sendAsks(n: number) {
  const t = await freshToken();
  if (!t || !groups().includes('operator') || mail()) return; // judges: the recording's labels stay; nothing is sent
  const plan = (await stepData(n)).gets['/v1/plan']?.body as { revision?: { actions: { message?: { subject: string; body: string }; messageState?: { state: string; to: string | null } | null; counterparty: { name: string } }[] } } | undefined;
  const messages = (plan?.revision?.actions ?? []).filter((a) => a.message && a.messageState?.state === 'SENT').map((a) => ({ preparedFor: a.messageState?.to ?? a.counterparty.name, subject: a.message!.subject, text: a.message!.body }));
  if (!messages.length) return;
  setMail({ state: 'SENDING', n: messages.length });
  const h = { authorization: `Bearer ${t}`, 'content-type': 'application/json' };
  const r = await fetch('/v1/demo/golden-mail', { method: 'POST', headers: h, body: JSON.stringify({ messages }) }).catch(() => null);
  const j = r ? await r.json().catch(() => ({})) : {};
  if (!r?.ok) return setMail({ state: 'FAILED', reason: j.message ?? 'Couldn’t reach the server' });
  for (let i = 0; i < 45; i++) {
    await new Promise((ok) => setTimeout(ok, 2000));
    const s = await fetch(`/v1/demo/golden-mail/${j.id}`, { headers: h }).then((x) => x.json()).catch(() => null);
    if (s?.state === 'SENT') return setMail({ state: 'SENT', id: j.id, n: s.sent.length, at: new Date().toISOString() });
    if (s?.state === 'FAILED') return setMail({ state: 'FAILED', reason: s.reason ?? 'Gmail refused it' });
  }
  setMail({ state: 'FAILED', reason: 'Gmail didn’t confirm within 90 seconds' });
}

/** After Gmail confirmed the sends, the recording's simulated-mail wording is replaced by what really happened. */
function relabel(body: unknown, path: string, now: string): unknown {
  const m = mail();
  if (path === '/v1/session' && m && m.state !== 'SENDING') {
    const sess = body as { lastChangeAt?: string | null; notice?: unknown };
    // The change token moves with the send's outcome, so open pages refetch and show what really happened.
    const changed = { ...sess, lastChangeAt: `${sess.lastChangeAt ?? ''}~mail:${m.state}` };
    if (sess.notice) return changed; // a later step's own notice (a receipt) still shows
    const text = m.state === 'SENT' ? `${m.n} real email${m.n === 1 ? '' : 's'} sent through Gmail to your test inbox · customers not contacted` : `Sample emails not sent: ${m.reason}`;
    return { ...changed, notice: { eventId: `golden-mail-${m.state}-${m.id ?? ''}`, at: m.at ?? now, text, to: m.state === 'SENT' ? '/inbox' : null } };
  }
  if (m?.state !== 'SENT') return body;
  return JSON.parse(JSON.stringify(body)
    .replace(/simulated mailbox · no real email left Headroom/g, 'Gmail · real email to your test inbox')
    .replace(/Simulated mailbox for testing · no real email is sent or received/g, 'Gmail · sample emails go to your test inbox; customers are not contacted')
    .replace(/SIMULATED message sim-[\w-]+/g, 'Gmail message in your test inbox')
    .replace(/simulated mailbox/g, 'Gmail (test inbox)')
    .replace(/"SIMULATED"/g, '"GMAIL"'));
}
if (goldenOn()) {
  addEventListener('keydown', (e) => {
    if ((e.target as HTMLElement)?.closest?.('input, textarea, select')) return;
    if (e.key === ']') moveTo(stepNo() + 1);
    if (e.key === '[') moveTo(stepNo() - 1);
  });
}

/** One API call answered from the recording: the current step's response, else the latest earlier step that had it. */
export async function goldenCall(method: string, path: string, qs: string): Promise<Res & { now: string }> {
  index ??= await load<Index>('index.json');
  const n = stepNo();
  const cur = await stepData(n);
  if (method === 'POST') {
    const p = index.posts[`POST ${path}`];
    if (p) { if (p.to !== null && p.to > n) moveTo(p.to); return { status: p.status, body: p.body, now: cur.now }; }
    if (path.endsWith('/refresh')) return { status: 202, body: {}, now: cur.now };
    return { status: 409, body: { code: 'DEMO_FIXED_PATH', outcome: 'NOT_APPLIED', message: 'This recorded run follows one path, so that change isn’t available here.', correlationId: '' }, now: cur.now };
  }
  for (let i = n; i >= 0; i--) {
    const s = await stepData(i);
    const hit = s.gets[path + qs] ?? s.gets[path];
    if (!hit) continue;
    // Each step is its own change, so open pages refetch on every move, Back included (two steps can share a recorded minute).
    const body = path === '/v1/session' ? { ...(hit.body as object), lastChangeAt: `${(hit.body as { lastChangeAt?: string }).lastChangeAt ?? ''}~step:${n}` } : hit.body;
    return { ...hit, body: relabel(body, path, cur.now), now: cur.now };
  }
  return { status: 404, body: { code: 'NOT_FOUND', outcome: 'NOT_APPLIED', message: 'Not part of the recorded run', correlationId: '' }, now: cur.now };
}
