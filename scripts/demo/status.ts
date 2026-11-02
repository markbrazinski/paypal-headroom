// UX repair (F12): read-only status of the demo run for filming and the final-state check. No write, no provider call.
//   AWS_PROFILE=headroom-admin npm run demo:status -- --stage dev|review [--tenant id] [--watch]
// --watch prints each change and exits 0 once Mercer's offer is skipped, Keller is paid and the plan reads "Gap closed".
import { arg, invokeOperator } from './operator-client.ts';

const stage = arg('--stage') ?? 'dev';
const tenantId = arg('--tenant') ?? (stage === 'review' ? 'tenant-showcase' : 'tenant-owner');
const watch = process.argv.includes('--watch');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const show = (x: any) => [
  `Run ${x.run?.runId ?? '—'} · ${x.run?.state ?? 'no run'}`,
  x.plan?.n ? `Plan revision ${x.plan.n} · ${x.plan.pill} · ${x.plan.coverage} · lowest ${x.plan.lowest}${x.plan.proposed ? ` · ${x.plan.proposed}` : ''}` : `Plan: ${x.plan?.state ?? '—'} ${x.plan?.reason ?? ''}`,
  ...(x.actions ?? []).map((a: any) => `  ${a.counterparty} · ${a.kind.toLowerCase().replace(/_/g, ' ')} · ${a.text}`),
  ...(x.updates ?? []).map((u: string) => `  ↳ ${u}`),
  `Needs you: ${(x.needs ?? []).join(' · ') || 'nothing'}`,
  `Final state: ${x.final ? 'YES (offer skipped, supplier paid, gap closed)' : 'not yet'}`,
].join('\n');
let last = '';
for (;;) {
  const x = await invokeOperator({ action: 'status', tenantId });
  const text = show(x);
  if (text !== last) { console.log(`\n${new Date().toISOString().slice(11, 19)}\n${text}`); last = text; }
  if (!watch) process.exit(x.final ? 0 : 3);
  if (x.final) process.exit(0);
  await sleep(10_000);
}
