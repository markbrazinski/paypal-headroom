// npm run demo:reset -- --stage local|dev [--bank seed|none] [--dispute seeded|email] [--tenant id] [--reason "..."]
// --dispute email (S7): Harrow's dispute is not seeded; it must arrive as her own email to the +headroom address (the fixture sender
// arrives with S7b's reset machine). Default seeded (S7-B1).
// --bank seed (default for the PayPal-bound demo tenant): the reset queues BANK_REMOVE for the old Item and BANK_SEED
// for a fresh SEEDED one; the run stays PREPARING until queued work records READY/BLOCKED (≤ 10 min). This CLI waits.
import { readFileSync } from 'node:fs';
import { invokeOperator, arg, LOCAL } from './operator-client.ts';

const stage = arg('--stage');
const reason = arg('--reason') ?? 'operator reset';
const tenant = arg('--tenant') ?? (stage === 'dev' ? 'tenant-owner' : 'tenant-local');
const bank = (arg('--bank') ?? (tenant === 'tenant-b' ? 'none' : 'seed')) as 'seed' | 'none';
const dispute = arg('--dispute') === 'email' ? 'EMAIL' : 'SEEDED';
let reset: (() => Promise<any>) | null = null, getRun: ((id: string) => Promise<any>) | null = null;
if (stage === 'local') {
  const token = readFileSync(new URL('../../.headroom-local/operator-token', import.meta.url), 'utf8');
  reset = async () => (await fetch(`${LOCAL}/__operator/reset`, { method: 'POST', headers: { 'x-operator-token': token }, body: JSON.stringify({ reason, bank, dispute }) })).json();
  getRun = async (id) => (await fetch(`${LOCAL}/__operator/run?runId=${id}`, { headers: { 'x-operator-token': token } })).json();
} else if (stage === 'dev' || stage === 'review') {
  reset = () => invokeOperator({ action: 'reset', tenantId: tenant, reason, bank, dispute });
  getRun = (id) => invokeOperator({ action: 'getRun', tenantId: tenant, runId: id });
} else {
  console.error('usage: npm run demo:reset -- --stage local|dev|review [--bank seed|none] [--dispute seeded|email]'); process.exit(2);
}
let run = await reset!();
const until = Date.now() + 10.5 * 60_000;
while (run?.state === 'PREPARING' && Date.now() < until) { await new Promise((r) => setTimeout(r, 3000)); run = await getRun!(run.runId); }
console.log(JSON.stringify(run, null, 2));
process.exit(run?.state === 'READY' ? 0 : 1);
