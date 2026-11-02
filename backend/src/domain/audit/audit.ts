import { randomUUID } from 'node:crypto';
import type { AuditEvent, AuditEventType } from '@headroom/contracts';
import type { Op } from '../../adapters/store/port.ts';
import { K } from '../../adapters/store/keys.ts';

export interface AuditArgs {
  tenantId: string;
  runId: string;
  type: AuditEventType;
  by: AuditEvent['by'];
  allowedBy?: string | null;
  result: string;
  refs?: Record<string, string>;
  correlationId: string;
  now: string;
}

/** Append-only audit row as a transaction op (written in the same TX as the change it records). */
export function auditOp(a: AuditArgs): Op {
  const eventId = randomUUID();
  const ev: AuditEvent = {
    eventId, tenantId: a.tenantId, runId: a.runId, occurredAt: a.now, eventType: a.type, by: a.by,
    allowedBy: a.allowedBy ?? null, result: a.result, refs: a.refs ?? {}, correlationId: a.correlationId,
  };
  return { op: 'put', table: 'audit', item: { pk: K.run(a.tenantId, a.runId), sk: `${a.now}#${eventId}`, ...ev }, cond: { notExists: true } };
}
