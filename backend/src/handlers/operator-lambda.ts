// Operator Lambda: invoked directly with the owner's IAM (no HTTP route). Queues bank effects; holds no Plaid client.
import { activeRun, bootstrapTenant } from '../domain/identity-run/run.ts';
import { operatorGetRun, operatorInjectBill, operatorReset, operatorRunActionNow } from './operator.ts';
import { paypalDeps } from './paypal-runtime.ts';
import { handleDemo, operatorDemoRun } from './demo.ts';
import { requestCollection } from '../domain/demo/payer.ts';
import { toReq, toResult, type HttpEvent } from './http-event.ts';

type OpEvent =
  | { action: 'reset'; tenantId: string; reason: string; bank?: 'seed' | 'none'; dispute?: 'SEEDED' | 'EMAIL'; bills?: 'AUTO' | 'ASK' }
  | { action: 'getRun'; tenantId: string; runId?: string }
  | { action: 'bootstrap'; tenantId: string; sub: string; email: string; withConnection: boolean }
  | { action: 'injectBill'; tenantId: string; fileName: string; contentBase64: string; reason: string }
  /** S5-D11: pull one action's due job forward (audited; no clock or state change). */
  | { action: 'runActionNow'; tenantId: string; actionId: string }
  /** O7 demo:collect: the drawer's view, and one customer paying through the AUTOMATED-PAYER (same server checks as the drawer). */
  | { action: 'demoRun'; tenantId: string }
  | { action: 'collect'; tenantId: string; actionId: string }
  | { action: 'abandonReset'; reason: string }
  /** UX repair (F12): read-only filming/final-state status (run, plan, actions, cash) for `npm run demo:status`. */
  | { action: 'status'; tenantId: string }
  /** Judge dock: EventBridge every 5 min; an idle, used live run starts its reset (live.ts). */
  | { action: 'autoReset'; takeOver?: boolean };

/** S7 R10: the same Lambda also serves `/v1/demo/*` and `/v1/operator/*` over HTTP, behind the Cognito JWT authorizer. */
export const handler = async (e: OpEvent | HttpEvent) => {
  const d = await paypalDeps();
  if ('requestContext' in e) return toResult(await handleDemo(d, toReq(e, true)));
  if (e.action === 'reset') return operatorReset(d, e.tenantId, e.reason, { bank: e.bank ?? 'none', dispute: e.dispute === 'EMAIL' ? 'EMAIL' : 'SEEDED', bills: e.bills ?? 'AUTO' });
  if (e.action === 'getRun') return operatorGetRun(d, e.tenantId, e.runId);
  if (e.action === 'demoRun') return operatorDemoRun(d, e.tenantId);
  if (e.action === 'status') return (await import('./operator.ts')).operatorStatus(d, e.tenantId);
  if (e.action === 'autoReset') return { result: await (await import('../domain/demo/live.ts')).autoReset(d, { takeOver: e.takeOver === true }) };
  if (e.action === 'abandonReset') return (await import('../domain/demo/reset.ts')).abandonReset(d, e.reason);
  if (e.action === 'collect') {
    const run = await activeRun(d.store, e.tenantId);
    if (!run) throw new Error('no active run');
    return requestCollection(d, { tenantId: e.tenantId, runId: run.runId, epoch: run.epoch, actionId: e.actionId });
  }
  if (e.action === 'runActionNow') return operatorRunActionNow(d, e.tenantId, e.actionId);
  if (e.action === 'injectBill') return operatorInjectBill(d, e.tenantId, e as unknown as Record<string, unknown>);
  if (e.action === 'bootstrap') { await bootstrapTenant(d.store, { sub: e.sub, email: e.email, tenantId: e.tenantId, connectionId: e.withConnection ? d.config.connectionId : null }); return { ok: true }; }
  throw new Error('unknown action');
};
