// REPLAY server for the S6 browser scenarios (S06 §6.18). Each scenario is built by the acceptance harness on real S1–S5 upstream
// with the REPLAY fake PayPal, then the built web app and the real router serve it. Screenshots from it prove rendering and controls
// (layers 4–5), never a payment. Labelled REPLAY in every evidence file name.
//   node scripts/verify/s6-replay-server.ts [--port 8796]      then  POST /__replay/scenario {"name":"held"}  and browse /payables
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { approved, type H } from '../../tests/acceptance/s5-helpers.ts';
import { heroPaid } from '../../tests/acceptance/s6-helpers.ts';

const arg = (n: string, d: string) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const PORT = Number(arg('--port', '8796'));
const DIST = join(process.cwd(), 'web/dist');
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };

/** Each scenario: a fresh harness driven to one S6 state (hero day 0 is Mon 9 Nov; Keller's PAY job runs Fri 13 Nov 09:00). */
const SCENARIOS: Record<string, () => Promise<H>> = {
  held: async () => (await approved()).h,
  unconfirmed: async () => (await approved({ payee: 'unconfirmed' })).h,
  waiting: async () => { const { h } = await approved(); await heroPaid(h, { reported: false }); return h; },
  paid: async () => {
    const { h } = await approved();
    await heroPaid(h);
    const [b] = [...h.pp.payouts.keys()];
    h.pp.reportPayout(b, { at: '2026-11-13T14:05:00+0000' });
    h.setNow('2026-11-13T16:10:00.000Z');
    h.pp.balance = { ...h.pp.balance, asOf: '2026-11-13T16:00:00.000Z' };
    await h.api('POST', '/v1/cash/paypal/refresh');
    await h.drain();
    return h;
  },
  unknown: async () => { const { h } = await approved(); h.pp.faults.add('payout-500'); await heroPaid(h, { stop: 'afterPost' }); return h; },
  unclaimed: async () => { const { h } = await approved(); h.pp.payoutScript = ['PENDING', 'UNCLAIMED']; await heroPaid(h); return h; },
  rejected: async () => { const { h } = await approved(); h.pp.faults.add('payout-422'); await heroPaid(h); return h; },
};

let h: H | null = null;
let name = 'none';
const body = (req: import('node:http').IncomingMessage) => new Promise<string>((ok) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => ok(b)); });

createServer(async (req, res) => {
  const send = (status: number, b: string | Buffer, headers: Record<string, string> = { 'content-type': 'application/json' }) => { res.writeHead(status, headers); res.end(b); };
  try {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
    if (url.pathname === '/__replay/scenario' && req.method === 'POST') {
      const n = JSON.parse((await body(req)) || '{}').name as string;
      if (!SCENARIOS[n]) return send(404, JSON.stringify({ error: `unknown scenario ${n}`, known: Object.keys(SCENARIOS) }));
      h = await SCENARIOS[n]();
      name = n;
      return send(200, JSON.stringify({ scenario: n, runId: h.run!.runId, now: h.clock(), label: 'REPLAY' }));
    }
    if (url.pathname.startsWith('/v1/')) {
      if (!h) return send(409, JSON.stringify({ code: 'NO_SCENARIO' }));
      const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v])) as Record<string, string>;
      // The harness's api() is the real router under the API role's scope (query strings aren't needed by the S6 routes).
      const r = await h.api(req.method!, url.pathname, req.method === 'POST' ? (await body(req)) || undefined : undefined, headers);
      if (req.method === 'POST') await h.drain();
      return send(r.status, JSON.stringify(r.body), { 'content-type': 'application/json', 'x-headroom-replay': name });
    }
    if (!existsSync(DIST)) return send(404, 'web/dist not built: npm run build -w web', { 'content-type': 'text/plain' });
    const file = join(DIST, url.pathname);
    const target = file.startsWith(DIST) && existsSync(file) && statSync(file).isFile() ? file : join(DIST, 'index.html');
    return send(200, readFileSync(target), { 'content-type': TYPES[extname(target)] ?? 'application/octet-stream' });
  } catch (e) {
    console.error(e);
    send(500, '{"code":"INTERNAL"}');
  }
}).listen(PORT, '127.0.0.1', () => console.log(`REPLAY payout server on http://127.0.0.1:${PORT} · scenarios: ${Object.keys(SCENARIOS).join(', ')} · recorded PayPal, never a payment`));
