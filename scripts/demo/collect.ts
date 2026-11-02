// O7 `demo:collect` (S07 §6.18 R3): the customers Headroom has already asked pay in plan order on PayPal's hosted page (AUTOMATED-PAYER,
// sandbox), one browser at a time; each is shown as paid only once PayPal's invoice + capture GETs show the receipt; then a 4 s gap.
// If one fails, the earlier ones stay paid and the failure is printed. Nobody pays by hand.
//   npm run demo:collect -- --stage dev|review [--tenant tenant-owner] [--gap 4] [--only "Pellow Dental Group"]
// --only (UX repair, F12): pay just that customer (name match, case-insensitive), so the plan's reassessment can be filmed between payments.
import { arg, invokeOperator } from './operator-client.ts';

const stage = arg('--stage') ?? 'dev';
const tenantId = arg('--tenant') ?? (stage === 'review' ? 'tenant-showcase' : 'tenant-owner');
const gapMs = Number(arg('--gap') ?? 4) * 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DONE = ['VERIFIED_PAID', 'VERIFIED_NOT_PAID', 'NOT_SUBMITTED', 'REFUSED', 'UNKNOWN_UNRESOLVED'];

const view = await invokeOperator({ action: 'demoRun', tenantId });
const only = arg('--only')?.toLowerCase();
const todo = (view.collections as any[]).filter((c) => c.canPay && (!only || String(c.counterparty).toLowerCase().includes(only)));
if (only && !todo.length) { const c = (view.collections as any[]).find((x) => String(x.counterparty).toLowerCase().includes(only)); console.log(c ? `${c.counterparty} can't pay now: ${c.why ?? c.attempt?.text ?? 'not payable'}` : `No approved collection matches "${arg('--only')}"`); process.exit(1); }
if (!todo.length) { console.log(`Nothing to collect on ${tenantId}: ${(view.collections as any[]).map((c) => `${c.counterparty} (${c.why ?? c.attempt?.text ?? 'not payable'})`).join('; ') || 'no approved collections'}`); process.exit(1); }
for (const [i, c] of todo.entries()) {
  if (i) await sleep(gapMs);
  await invokeOperator({ action: 'collect', tenantId, actionId: c.actionId });
  const t0 = Date.now();
  let last = '';
  for (;;) {
    await sleep(3_000);
    const a = ((await invokeOperator({ action: 'demoRun', tenantId })).collections as any[]).find((x) => x.actionId === c.actionId)?.attempt;
    if (a && a.text !== last) { last = a.text; console.log(`${new Date().toISOString().slice(11, 19)} ${c.counterparty} · ${a.text}`); }
    if (a && DONE.includes(a.phase)) {
      if (a.phase !== 'VERIFIED_PAID') { console.log(`Stopped: ${c.counterparty} ${a.phase.toLowerCase().replace(/_/g, ' ')}; earlier receipts stand`); process.exit(1); }
      console.log(`  verified by PayPal in ${Math.round((Date.now() - t0) / 1000)} s`);
      break;
    }
  }
}
