// npm run demo:get-run -- --stage local|dev [--run <runId>]
import { readFileSync } from 'node:fs';
import { invokeOperator, arg, LOCAL } from './operator-client.ts';

const stage = arg('--stage');
const runId = arg('--run');
if (stage === 'local') {
  const token = readFileSync(new URL('../../.headroom-local/operator-token', import.meta.url), 'utf8');
  const r = await fetch(`${LOCAL}/__operator/run${runId ? `?runId=${runId}` : ''}`, { headers: { 'x-operator-token': token } });
  console.log(JSON.stringify(await r.json(), null, 2));
} else if (stage === 'dev') {
  console.log(JSON.stringify(await invokeOperator({ action: 'getRun', tenantId: arg('--tenant') ?? 'tenant-owner', runId }), null, 2));
} else { console.error('usage: npm run demo:get-run -- --stage local|dev [--run id]'); process.exit(2); }
