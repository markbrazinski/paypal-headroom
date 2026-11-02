// Retire every dev job left by the S6 race harness (test tenants `tenant-a`, `tenant-race-*`, and `tenant-b` runs it reset), plus the
// tenant-less jobs of their STUB connections and Items, so the deployed sweep never runs them on the hero-week dates (S5-races rule).
//   AWS_PROFILE=headroom-admin node scripts/live/s6-races-retire.ts [--dry]
import { DynamoStore } from '../../backend/src/adapters/store/dynamodb.ts';
import { K } from '../../backend/src/adapters/store/keys.ts';

process.env.AWS_REGION ??= 'us-east-1';
const dry = process.argv.includes('--dry');
const store = new DynamoStore({ core: 'HeadroomDev-core', work: 'HeadroomDev-work', provider: 'HeadroomDev-provider', audit: 'HeadroomDev-audit' });
const testTenant = (t: string | null) => !!t && (t === 'tenant-a' || t.startsWith('tenant-race-'));
const all = await store.dueJobs('9999-12-31T00:00:00.000Z', 1000);
const runReason = new Map<string, string>();
const harnessRun = async (t: string, r: string) => { const k = `${t}|${r}`; if (!runReason.has(k)) runReason.set(k, ((await store.get('core', K.run(t, r), 'RUN'))?.reason as string) ?? ''); return runReason.get(k) === 'acceptance'; };
const itemTenant = async (ref: string) => (await store.get('provider', K.plaid(ref), 'ITEM'))?.tenantId ?? null;
const pick = [];
for (const j of all) {
  if (testTenant(j.tenantId)) pick.push(j);
  else if (j.tenantId === 'tenant-b' && j.runId && (await harnessRun('tenant-b', j.runId))) pick.push(j);
  else if (!j.tenantId && (/^pp-(test|race-)/.test(String(j.ref)) || testTenant(await itemTenant(String(j.ref))))) pick.push(j);
}
console.log(`${all.length} due/leased jobs in dev; ${pick.length} belong to the S6 race harness`);
for (const j of pick.slice(0, 8)) console.log(`  ${j.jobId} ${j.type} ${j.state} ${j.tenantId ?? '-'} due ${j.dueAt}`);
let retired = 0;
if (!dry) for (const j of pick) {
  try { await store.transact([{ op: 'update', table: 'work', pk: j.pk, sk: 'JOB', set: { state: 'DONE', leaseUntil: null, lastError: 's6-races: retired (test tenant, hero-week clock)' }, remove: ['gsiDue', 'dueKey'], cond: { eq: { leaseToken: j.leaseToken, state: j.state } } }]); retired++; } catch { /* moved meanwhile */ }
}
console.log(dry ? 'dry run: nothing changed' : `retired ${retired}`);
