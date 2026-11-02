// `npm run dev`: the local API (STAGE=local, in-memory store, worker loop) on :8787 and the Vite web app on :5173,
// which proxies /v1 to it. PayPal and Plaid calls are refused unless HEADROOM_GRANT=S2 is set (PP-S2 / PLAID-S2, Build Book §I).
import { spawn } from 'node:child_process';

const kids = [['run', 'dev:api'], ['run', 'dev', '-w', 'web']].map((args) => spawn('npm', args, { stdio: 'inherit' }));
const stop = () => kids.forEach((k) => k.kill('SIGTERM'));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const k of kids) k.on('exit', (code) => { process.exitCode ||= code ?? 1; stop(); });
