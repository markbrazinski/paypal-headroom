// reconcileInvoice (S01 T3): the only path from PayPal evidence to a receipt. Poll and webhook both land here.
import { decimalToMinor, PpCapture, PpInvoice, type CaptureReceipt, type InvoiceMirror, type OwnerAssertion } from '@headroom/contracts';
import { K, basisBumpOp, fundsBumpOp } from '../../adapters/store/keys.ts';
import { TxCancelled, type Op } from '../../adapters/store/port.ts';
import type { Deps } from '../../deps.ts';
import { auditOp } from '../audit/audit.ts';
import { assertTransition } from '@headroom/contracts';
import { allocateClaim, conservationText, invoiceProjection } from '../receivables/claims.ts';
import { dueMinor } from '../executor/update-body.ts';
import { newJob as job, putJobOp } from '../../jobs/lease.ts';
import { isReversalStatus, verifyCapture } from './verify.ts';

const usd = (minor: number) => `$${(minor / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
import { leaseCheck, newJob, requestRun, type Lease } from '../../jobs/lease.ts';
import { retainGet } from './evidence.ts';
import type { HttpResult } from '../../adapters/paypal/types.ts';

type InvItem = InvoiceMirror & { pk: string; sk: string; tenantId: string; issuedAt?: string | null };
export type CaptureMarker = { pk: string; sk: string; captureId: string; connectionId: string; tenantId: string; runId: string; invoiceId: string; invoiceNumber: string; grossMinor: number; feeMinor: number; netMinor: number; capturedAt: string; reversalDetected: boolean; lastStatus: string; lastReadAt: string };

export interface ReconcileResult { receiptsCreated: number; paid: boolean; open: boolean }

export async function reconcileInvoice(d: Deps, ref: { tenantId: string; runId: string; invoiceId: string }, source: 'POLL' | 'WEBHOOK' | 'REFRESH', lease?: Lease): Promise<ReconcileResult> {
  const pk = K.run(ref.tenantId, ref.runId);
  let inv = (await d.store.get('core', pk, `INV#${ref.invoiceId}`)) as InvItem | undefined;
  if (!inv || !inv.ppInvoiceId || !['ISSUED', 'PARTIALLY_PAID', 'PAID'].includes(inv.state)) return { receiptsCreated: 0, paid: inv?.state === 'PAID', open: false };
  const corr = `${source}:${ref.invoiceId}:${d.now()}`;
  const by = { tenantId: ref.tenantId, runId: ref.runId, correlationId: corr };
  const guard = (): Op[] => (lease ? [leaseCheck(lease)] : []);

  const g = await d.reader.getInvoice(inv.ppInvoiceId);
  if (g.status !== 200) throw new Error(`invoice read ${g.status}`);
  const ppInv = PpInvoice.parse(g.body);
  const txs = ppInv.payments?.transactions ?? [];

  // EXTERNAL = owner assertion (record-external-payment). Never a receipt or cash (S1-R5).
  const known = new Set(inv.ownerAssertions.map((a) => a.providerPaymentId));
  const fresh: OwnerAssertion[] = txs.filter((t) => t.type === 'EXTERNAL' && !known.has(t.payment_id)).map((t) => ({
    providerPaymentId: t.payment_id, amount: { currency: 'USD', minor: decimalToMinor(t.amount.value) }, date: t.payment_date ?? null, method: t.method ?? null,
  }));
  if (fresh.length) {
    await d.store.transact([
      { op: 'update', table: 'core', pk, sk: inv.sk, set: { ownerAssertions: [...inv.ownerAssertions, ...fresh], version: inv.version + 1 }, cond: { eq: { version: inv.version } } },
      ...fresh.map((a) => auditOp({ ...by, type: 'OwnerAssertionObserved', by: 'PAYPAL', result: `Recorded payment ${a.amount.minor} on PayPal invoice: owner assertion, not cash`, refs: { invoiceId: inv!.invoiceId, paymentId: a.providerPaymentId }, now: d.now() })),
      ...guard(),
    ]);
    inv = (await d.store.get('core', pk, inv.sk)) as InvItem;
  }

  // S5-D3: the claim split, allocations so far and discounts given: the capture ceiling is what is still collectible.
  const claim = (await d.store.get('core', pk, `CLAIM#${inv.invoiceId}`)) as { undisputed: { minor: number }; disputed: { minor: number } } | undefined;
  const projectionNow = async () => {
    const [allocs, concs] = await Promise.all([d.store.query('core', pk, { skPrefix: 'ALLOC#' }), d.store.query('core', pk, { skPrefix: `CONCESSION#${inv!.invoiceId}#` })]);
    const mine = allocs.filter((a) => a.invoiceId === inv!.invoiceId);
    return { allocs: mine, concs, p: invoiceProjection(inv!, { dueMinor: dueMinor(g.body), status: ppInv.status }, (claim as never) ?? null, mine as never, concs as never) };
  };
  let receiptsCreated = 0;
  for (const t of txs.filter((x) => x.type === 'PAYPAL')) {
    // Re-read the capture every time; the marker only prevents a second insert (PR-06).
    const cr = await d.reader.getCapture(t.payment_id);
    if (cr.status !== 200) throw new Error(`capture read ${cr.status}`);
    const cap = PpCapture.parse(cr.body);
    const mk = K.conn(d.config.connectionId);
    const marker = (await d.store.get('provider', mk, `CAPTURE#${cap.id}`)) as CaptureMarker | undefined;
    if (marker) {
      await recordCaptureStatus(d, marker, cr, cap.status, corr);
      continue;
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const pr = await projectionNow();
      const check = verifyCapture({ ppInvoiceId: inv.ppInvoiceId!, currency: 'USD', openMinor: pr.p.collectibleOpen.minor, txAmountMinor: decimalToMinor(t.amount.value) }, cap);
      if (!check.ok && check.kind === 'NOT_COMPLETED') break; // no receipt; re-poll (S1-R3)
      if (!check.ok) {
        if (inv.hold?.reason !== check.reason) {
          await d.store.transact([
            { op: 'update', table: 'core', pk, sk: inv.sk, set: { hold: { reason: check.reason, at: d.now() }, version: inv.version + 1 }, cond: { eq: { version: inv.version } } },
            auditOp({ ...by, type: 'ReconciliationHold', by: 'HEADROOM', result: check.reason, refs: { invoiceId: inv.invoiceId, captureId: cap.id }, now: d.now() }),
            ...guard(),
          ]);
        }
        break;
      }
      const allow = await d.store.get('core', pk, `DISPALLOW#${inv.invoiceId}`);
      const parts = allocateClaim(check.gross.minor, (claim as never) ?? null, pr.allocs as never, allow ? { allowedMinor: allow.allowedMinor, usedMinor: allow.usedMinor } : null);
      const disputedPart = parts.find((x) => x.claim === 'DISPUTED')?.minor ?? 0;
      const left = pr.p.collectibleOpen.minor - check.gross.minor;
      const state = left === 0 ? 'PAID' : 'PARTIALLY_PAID';
      assertTransition('Invoice', inv.state, state);
      const alloc = { amount: check.gross, openGross: { currency: 'USD' as const, minor: left }, state };
      const now = d.now();
      const receipt: CaptureReceipt = {
        captureId: cap.id, connectionId: d.config.connectionId, invoiceId: inv.invoiceId, ppInvoiceId: inv.ppInvoiceId!, invoiceNumber: inv.invoiceNumber!,
        runId: ref.runId, gross: check.gross, fee: check.fee, net: check.net, capturedAt: check.capturedAt, retrievedAt: now,
        captureStatus: cap.status, reversalDetected: false, rawSha256: cr.rawSha256,
      };
      // Retained before the receipt TX (S1-IM-07): a receipt never references a body that wasn't kept.
      await retainGet(d.store, K.conn(d.config.connectionId), 'capture', cr, now);
      await retainGet(d.store, K.conn(d.config.connectionId), 'invoice', g, now);
      const m: CaptureMarker = {
        pk: mk, sk: `CAPTURE#${cap.id}`, captureId: cap.id, connectionId: d.config.connectionId, tenantId: ref.tenantId, runId: ref.runId,
        invoiceId: inv.invoiceId, invoiceNumber: inv.invoiceNumber!, grossMinor: check.gross.minor, feeMinor: check.fee.minor, netMinor: check.net.minor,
        capturedAt: check.capturedAt, reversalDetected: false, lastStatus: cap.status, lastReadAt: now,
      };
      try {
        await d.store.transact([
          { op: 'put', table: 'provider', item: m, cond: { notExists: true } },
          fundsBumpOp(mk),
          { op: 'put', table: 'core', item: { pk, sk: `RCPT#${cap.id}`, ...receipt, invoiceRawSha256: g.rawSha256 }, cond: { notExists: true } },
          ...parts.map((x, i): Op => ({ op: 'put', table: 'core', item: { pk, sk: i === 0 ? `ALLOC#${cap.id}` : `ALLOC#${cap.id}#${x.claim}`, allocationId: `alloc-${cap.id}${i ? `-${x.claim.toLowerCase()}` : ''}`, captureId: cap.id, invoiceId: inv!.invoiceId, amount: { currency: 'USD', minor: x.minor }, at: now, claim: x.claim }, cond: { notExists: true } })),
          // A discount given is realized when the invoice is paid under it: not revenue, not a receipt (S5-D3).
          ...(left === 0 ? pr.concs.filter((c) => c.state === 'ACTIVE').flatMap((c): Op[] => [
            { op: 'update', table: 'core', pk, sk: c.sk, set: { state: 'SETTLED', settledBy: [...c.settledBy, cap.id] }, cond: { eq: { state: 'ACTIVE' } } },
            auditOp({ ...by, type: 'ConcessionRealized', by: 'HEADROOM', result: `Discount given ${(c.amount.minor / 100).toFixed(2)}: paid under the offer · not revenue, not a receipt`, refs: { invoiceId: inv!.invoiceId, captureId: cap.id }, now }),
          ]) : []),
          // S7 R5: concurrent captures serialize on the allowance's version.
          ...(disputedPart && allow ? [{ op: 'update' as const, table: 'core' as const, pk, sk: allow.sk, set: { usedMinor: allow.usedMinor + disputedPart }, add: { version: 1 }, cond: { eq: { version: allow.version } } }] : []),
          ...parts.filter((x) => x.claim === 'UNALLOCATED').map((x) => auditOp({ ...by, type: 'UnallocatedGross', by: 'HEADROOM', result: `${(x.minor / 100).toFixed(2)} received toward the disputed amount · your decision; the dispute is not closed`, refs: { invoiceId: inv!.invoiceId, captureId: cap.id }, now })),
          putJobOp(job(`progress#${inv.invoiceId}#${cap.id}`, 'PLAN_PROGRESS', inv.invoiceId, now, ref.tenantId, ref.runId)),
          { op: 'update', table: 'core', pk, sk: inv.sk, set: { openGross: alloc.openGross, state: alloc.state, providerStatus: ppInv.status, hold: null, version: inv.version + 1 }, cond: { eq: { version: inv.version } } },
          basisBumpOp(pk), // S4 §6.17 R1: open amount changed
          auditOp({ ...by, type: 'InvoiceCaptureVerified', by: 'HEADROOM', allowedBy: `PayPal capture ${String(cap.status).toLowerCase()}`, result: `Payment verified with PayPal: ${usd(check.gross.minor)} received, ${usd(check.fee.minor)} PayPal fee, ${usd(check.net.minor)} net`, refs: { invoiceId: inv.invoiceId, captureId: cap.id }, now }),
          auditOp({ ...by, type: 'ReceiptAllocated', by: 'HEADROOM', result: `Applied ${parts.map((x) => `${usd(x.minor)} ${x.claim === 'WHOLE' ? 'to the whole invoice' : `to the ${x.claim.toLowerCase()} part`}`).join(' + ')} on ${inv.invoiceNumber}; ${alloc.state === 'PAID' ? 'paid in full' : `${usd(alloc.openGross.minor)} still open`}`, refs: { invoiceId: inv.invoiceId, captureId: cap.id }, now }),
          ...guard(),
        ]);
        receiptsCreated++;
        inv = (await d.store.get('core', pk, inv.sk)) as InvItem;
        break;
      } catch (e) {
        if (!(e instanceof TxCancelled)) throw e;
        if (e.failed[0] || e.failed[1]) break; // another path already recorded this capture: no-op success (S1-A2, S1-R1)
        if (lease && e.failed[e.failed.length - 1]) throw new Error('lease lost during receipt');
        inv = (await d.store.get('core', pk, inv.sk)) as InvItem; // invoice changed underneath; re-verify against the new open amount
      }
    }
  }

  // S5-D3 conservation gate: PayPal's due must equal what Headroom expects. Not judged while our own update is in flight.
  const fin = await projectionNow();
  const lock = await d.store.get('work', `UPDLOCK#${inv.invoiceId}`, 'LOCK');
  const conservation = lock?.holder ? 'UNKNOWN' : fin.p.conservation;
  const prevC = (inv as { conservation?: string }).conservation;
  await d.store.transact([
    { op: 'update', table: 'core', pk, sk: inv.sk, set: { lastCheckedAt: d.now(), providerStatus: ppInv.status, lastRawSha256: g.rawSha256, providerDueMinor: dueMinor(g.body), conservation } },
    ...(conservation !== prevC && (conservation === 'HOLD' || prevC === 'HOLD') ? [basisBumpOp(pk), auditOp({ ...by, type: 'ConservationHold', by: 'HEADROOM', result: conservation === 'HOLD' ? `${conservationText(fin.p)}: reconciliation held; the Mercer offer can't be skipped on it` : 'PayPal and Headroom agree again on what is due', refs: { invoiceId: inv.invoiceId }, now: d.now() })] : []),
  ]);
  if (receiptsCreated) await requestRun(d.store, newJob(`obs#${d.config.connectionId}`, 'OBSERVE_BALANCE', d.config.connectionId, d.now(), null, null), d.now());
  return { receiptsCreated, paid: inv.state === 'PAID', open: inv.state === 'ISSUED' || inv.state === 'PARTIALLY_PAID' };
}

/** A known capture's latest status: every new reversal status is recorded (S1-IM-02); a changed status bumps the funds stamp (S5-D22). */
async function recordCaptureStatus(d: Deps, marker: CaptureMarker, cr: HttpResult, status: string, corr: string) {
  const mk = marker.pk;
  if (isReversalStatus(status) && status !== marker.lastStatus) {
    await retainGet(d.store, mk, 'capture', cr, d.now());
    await d.store.transact([
      { op: 'update', table: 'provider', pk: mk, sk: marker.sk, set: { reversalDetected: true, lastStatus: status, lastReadAt: d.now() } },
      { op: 'update', table: 'core', pk: K.run(marker.tenantId, marker.runId), sk: `RCPT#${marker.captureId}`, set: { reversalDetected: true, captureStatus: status } },
      fundsBumpOp(mk),
      auditOp({ tenantId: marker.tenantId, runId: marker.runId, correlationId: corr, type: 'ReceiptReversalDetected', by: 'PAYPAL', result: `Capture now ${status}; net held out of the estimate until the amount is verified`, refs: { captureId: marker.captureId }, now: d.now() }),
    ]);
    return;
  }
  // A changed status is a funds input (S5-D22); a plain re-read is not, or every check's own reads would refence it.
  await d.store.transact([{ op: 'update', table: 'provider', pk: mk, sk: marker.sk, set: { lastStatus: status, lastReadAt: d.now() } }, ...(status !== marker.lastStatus ? [fundsBumpOp(mk)] : [])]);
}

/** S5-D8 refresh set: re-read one capture we already recorded (PAID invoices and earlier runs included). false = read failed. */
export async function refreshCapture(d: Deps, marker: CaptureMarker, corr: string): Promise<boolean> {
  const cr = await d.reader.getCapture(marker.captureId).catch(() => null);
  if (cr?.status !== 200) return false;
  const cap = PpCapture.safeParse(cr.body);
  if (!cap.success) return false;
  await recordCaptureStatus(d, marker, cr, cap.data.status, corr);
  return true;
}
