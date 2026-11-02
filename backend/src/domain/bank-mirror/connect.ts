// Owner bank commands on the API side (S02 T1, T2, T5, T8). The API makes no connection mutation: it issues link tokens
// (a session token, no Item) and CLAIMS a connection; the worker's effect executor exchanges (S2-PR-01).
// Every route resolves the Item from the active run's CONN#plaid, never from a client-supplied id (T8).
import { createHash } from 'node:crypto';
import { assertTransition, PlaidLinkToken, type BankBinding, type BankConnection, type BankEffectRecord } from '@headroom/contracts';
import { K } from '../../adapters/store/keys.ts';
import type { Op, Store } from '../../adapters/store/port.ts';
import { CallRefused, NoResponse } from '../../adapters/grant.ts';
import type { PlaidLinkTokenClient } from '../../adapters/plaid/clients.ts';
import { seal, unseal, type Vault } from '../../adapters/vault.ts';
import { ApiError } from '../../api-error.ts';
import { auditOp } from '../audit/audit.ts';
import { newJob, putJobOp } from '../../jobs/lease.ts';
import { fenceCheck, type CommandCtx, type CommandResult } from '../receivables/commands.ts';

export type BindingItem = BankBinding & { pk: string; sk: string };
export type ConnItem = BankConnection & { pk: string; sk: string };
export type BankEffItem = BankEffectRecord & { pk: string; sk: string };

export const bindingOf = (s: Store, tenantId: string, runId: string) => s.get('core', K.run(tenantId, runId), 'CONN#plaid') as Promise<BindingItem | undefined>;
export const connOf = (s: Store, itemId: string) => s.get('provider', K.plaid(itemId), 'ITEM') as Promise<ConnItem | undefined>;
export const bankEffectOf = (s: Store, key: string) => s.get('work', K.effect(key), 'EFFECT') as Promise<BankEffItem | undefined>;
export const effectJobId = (effectKey: string) => `eff#${effectKey}`;
export const syncJobId = (itemId: string) => `plaid#${itemId}`;

/** The caller's connected Item (BOUND binding), re-checked against the tenant in code before any token is decrypted (T8). */
async function boundConn(s: Store, c: { tenantId: string; run: { runId: string } }): Promise<{ binding: BindingItem; conn: ConnItem } | null> {
  const binding = await bindingOf(s, c.tenantId, c.run.runId);
  if (!binding || binding.state !== 'BOUND' || !binding.itemId) return null;
  const conn = await connOf(s, binding.itemId);
  if (!conn || conn.tenantId !== c.tenantId || conn.runId !== c.run.runId) return null;
  return { binding, conn };
}

const unavailable = (msg: string) => new ApiError(503, 'PROVIDER_UNAVAILABLE', msg);

export async function createLinkToken(s: Store, client: PlaidLinkTokenClient | undefined, vault: Vault | undefined, c: CommandCtx, mode: 'connect' | 'update') {
  if (!client || !vault) throw unavailable('Bank connection is not configured in this environment');
  let accessToken: string | undefined;
  if (mode === 'connect') {
    const b = await bindingOf(s, c.tenantId, c.run.runId);
    if (b && b.state !== 'RELEASED') throw new ApiError(409, 'ALREADY_CONNECTED', b.state === 'CONNECTING' ? 'A bank connection is already in progress' : 'A bank is already connected');
  } else {
    const bc = await boundConn(s, c);
    if (!bc || !['SYNCING', 'HEALTHY', 'RECONNECT_REQUIRED'].includes(bc.conn.state) || !bc.conn.sealedAccessToken) throw new ApiError(409, 'NOT_CONNECTED', 'No bank connection to reconnect');
    try { accessToken = await unseal(vault, bc.conn.sealedAccessToken); } catch { throw unavailable("Couldn't open the bank connection's credential; try again"); }
  }
  // client_user_id is a stable pseudonym, never the email.
  const clientUserId = createHash('sha256').update(`headroom:${c.tenantId}`).digest('hex').slice(0, 32);
  let r;
  try { r = await client.create({ clientUserId, accessToken }); } catch (e) {
    if (e instanceof CallRefused) throw unavailable(`Bank not being checked: ${e.message}`);
    if (e instanceof NoResponse) throw unavailable("Plaid didn't answer; try again");
    throw e;
  }
  const ok = r.status === 200 ? PlaidLinkToken.safeParse(r.body) : null;
  if (!ok?.success) throw unavailable(`Plaid refused the link token (${r.body?.error_code ?? r.status})`);
  return { linkToken: ok.data.link_token, expiration: ok.data.expiration };
}

/** T2: one TX holds the binding slot, the READY effect (sealed public token), its job, the audit row and (router) IDEM. */
export async function claimConnect(s: Store, vault: Vault | undefined, c: CommandCtx, idempotencyKey: string, body: { publicToken: string; institutionId?: string | null; institutionName?: string | null }): Promise<CommandResult> {
  if (!vault) throw unavailable('Bank connection is not configured in this environment');
  const pk = K.run(c.tenantId, c.run.runId);
  const b = await bindingOf(s, c.tenantId, c.run.runId);
  if (b && b.state !== 'RELEASED') throw new ApiError(409, 'ALREADY_CONNECTED', 'A bank connection is already in progress or connected');
  const opId = createHash('sha256').update(`${c.tenantId}\n${idempotencyKey}`).digest('hex').slice(0, 24);
  const effectKey = `bankconn#${opId}`;
  let sealedPublicToken;
  try { sealedPublicToken = await seal(vault, body.publicToken, { tenantId: c.tenantId, effectKey }); }
  catch { throw unavailable("Couldn't secure the bank connection, so nothing was saved; connect again"); }
  const institution = { id: body.institutionId ?? null, name: body.institutionName ?? null }; // display hint only
  if (b) assertTransition('BankBinding', b.state, 'CONNECTING');
  const eff: BankEffItem = {
    pk: K.effect(effectKey), sk: 'EFFECT', effectKey, kind: 'BANK_CONNECT', tenantId: c.tenantId, runId: c.run.runId, epoch: c.run.epoch, state: 'READY', version: 1,
    argsHash: createHash('sha256').update(JSON.stringify([c.tenantId, c.run.runId, institution])).digest('hex'), institution, sealedPublicToken, failureReason: null, updatedAt: c.now,
  };
  const binding: BindingItem = { pk, sk: 'CONN#plaid', state: 'CONNECTING', version: (b?.version ?? 0) + 1, effectKey, itemId: null, basis: 'OWNER_LINKED', boundAt: null };
  const jobId = effectJobId(effectKey);
  return {
    status: 202,
    body: { effectId: effectKey, jobId },
    conflict: new ApiError(409, 'ALREADY_CONNECTED', 'A bank connection is already in progress or connected'),
    ops: [
      fenceCheck(c),
      { op: 'put', table: 'core', item: binding, cond: b ? { eq: { state: 'RELEASED', version: b.version } } : { notExists: true } },
      { op: 'put', table: 'work', item: eff, cond: { notExists: true } },
      putJobOp(newJob(jobId, 'EXECUTE_EFFECT', effectKey, c.now, c.tenantId, c.run.runId)),
      auditOp({ tenantId: c.tenantId, runId: c.run.runId, type: 'BankConnectRequested', by: 'OWNER', allowedBy: c.ownerEmail, result: `Connect ${institution.name ?? 'bank'} requested (read-only; Headroom never moves bank money)`, refs: { effectKey }, correlationId: c.correlationId, now: c.now }),
    ],
  };
}

/** Owner gives up on a connect whose outcome Plaid can't tell us (UNKNOWN after the same-token replay). Releases the slot. */
export async function abandonConnect(s: Store, c: CommandCtx, ifMatch: string | undefined): Promise<CommandResult> {
  const b = await bindingOf(s, c.tenantId, c.run.runId);
  const eff = b?.state === 'CONNECTING' ? await bankEffectOf(s, b.effectKey) : undefined;
  if (!b || !eff || eff.kind !== 'BANK_CONNECT' || eff.state !== 'UNKNOWN' || !eff.canAbandon) throw new ApiError(409, 'NOT_CONNECTED', 'There is no undetermined bank connection to abandon');
  if (ifMatch === undefined || String(eff.version) !== ifMatch.replace(/"/g, '')) throw new ApiError(409, 'VERSION_CONFLICT', `Connection attempt is at version ${eff.version}`);
  assertTransition('BankEffect', 'UNKNOWN', 'ABANDONED');
  assertTransition('BankBinding', 'CONNECTING', 'RELEASED');
  return {
    status: 200, body: { binding: 'RELEASED' }, conflict: new ApiError(409, 'VERSION_CONFLICT', 'Changed concurrently; reload and try again'),
    ops: [
      fenceCheck(c),
      { op: 'update', table: 'work', pk: eff.pk, sk: 'EFFECT', set: { state: 'ABANDONED', version: eff.version + 1, updatedAt: c.now, canAbandon: false }, remove: ['sealedPublicToken'], cond: { eq: { state: 'UNKNOWN', version: eff.version } } },
      { op: 'update', table: 'core', pk: b.pk, sk: b.sk, set: { state: 'RELEASED', version: b.version + 1 }, cond: { eq: { state: 'CONNECTING', effectKey: b.effectKey } } },
      auditOp({ tenantId: c.tenantId, runId: c.run.runId, type: 'BankConnectAbandoned', by: 'OWNER', allowedBy: c.ownerEmail, result: 'Connection attempt abandoned. Plaid may hold a connection Headroom never received; in the sandbox it expires within 30 days', refs: { effectKey: eff.effectKey }, correlationId: c.correlationId, now: c.now }),
    ],
  };
}

/** T6: from this commit the bank stops counting (S2-PR-04); generation+1 fences every in-flight sync commit (S2-PR-03). */
export async function disconnectBank(s: Store, c: CommandCtx, ifMatch: string | undefined): Promise<CommandResult> {
  const bc = await boundConn(s, c);
  if (!bc || bc.conn.state === 'DISCONNECTING' || bc.conn.state === 'DISCONNECTED') throw new ApiError(409, 'NOT_CONNECTED', 'No bank connection to disconnect');
  const { conn } = bc;
  if (ifMatch === undefined || String(conn.version) !== ifMatch.replace(/"/g, '')) throw new ApiError(409, 'VERSION_CONFLICT', `Connection is at version ${conn.version}`);
  assertTransition('BankConnection', conn.state, 'DISCONNECTING');
  const effectKey = `bankrm#${conn.itemId}`;
  const jobId = effectJobId(effectKey);
  return {
    status: 202, body: { effectId: effectKey, jobId }, conflict: new ApiError(409, 'VERSION_CONFLICT', 'Connection changed; reload and try again'),
    ops: [
      fenceCheck(c),
      { op: 'update', table: 'provider', pk: conn.pk, sk: 'ITEM', set: { state: 'DISCONNECTING', version: conn.version + 1, generation: conn.generation + 1 }, cond: { eq: { version: conn.version } } },
      ...removalOps(conn, c.now, jobId),
      auditOp({ tenantId: c.tenantId, runId: c.run.runId, type: 'BankDisconnectRequested', by: 'OWNER', allowedBy: c.ownerEmail, result: `Disconnect ${conn.institution.name ?? 'bank'}: its figures stop counting now; Plaid is asked to remove the connection. Nothing at the bank changes`, refs: { itemId: conn.itemId, effectKey }, correlationId: c.correlationId, now: c.now }),
    ],
  };
}

/** The READY BANK_REMOVE effect + its job for an Item already moving to DISCONNECTING (one per Item). */
export function removalOps(conn: Pick<ConnItem, 'itemId' | 'tenantId' | 'runId'>, now: string, jobId = effectJobId(`bankrm#${conn.itemId}`), epoch = 0): Op[] {
  const effectKey = `bankrm#${conn.itemId}`;
  const eff: BankEffItem = {
    pk: K.effect(effectKey), sk: 'EFFECT', effectKey, kind: 'BANK_REMOVE', tenantId: conn.tenantId, runId: conn.runId, epoch, state: 'READY', version: 1,
    argsHash: createHash('sha256').update(conn.itemId).digest('hex'), itemId: conn.itemId, institution: null, failureReason: null, updatedAt: now,
  };
  return [{ op: 'put', table: 'work', item: eff, cond: { notExists: true } }, putJobOp(newJob(jobId, 'EXECUTE_EFFECT', effectKey, now, conn.tenantId, conn.runId))];
}

/** T5: pull the Item's single sync job forward; repeated clicks collapse into one cycle. */
export async function refreshTarget(s: Store, c: { tenantId: string; run: { runId: string } }) {
  const bc = await boundConn(s, c);
  if (!bc || bc.conn.state === 'DISCONNECTING' || bc.conn.state === 'DISCONNECTED') throw new ApiError(409, 'NOT_CONNECTED', 'No bank connection to refresh');
  return bc.conn;
}
