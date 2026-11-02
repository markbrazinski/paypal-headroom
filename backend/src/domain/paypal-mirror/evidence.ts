// Provider GET evidence (S01 §6.5): the raw response body behind a receipt or an observation, kept immutably
// under its SHA-256 with provenance. Bodies hold no tokens: PayPal's bearer goes out in a header; Plaid token-bearing
// responses (link token, exchange) are never passed here, only data reads (item/get, sync pages, balances).
import { gzipSync } from 'node:zlib';
import { TxCancelled, type Store } from '../../adapters/store/port.ts';
import type { HttpResult } from '../../adapters/grant.ts';

/** gzip keeps a 500-row Reporting page far below DynamoDB's 400 KB item limit. */
const MAX_STORED = 350_000;

/** Write once per distinct body; the first retrieval is the provenance. Throws rather than silently dropping evidence. */
export async function retainGet(store: Store, pk: string, what: string, r: HttpResult, retrievedAt: string): Promise<string> {
  const body = gzipSync(r.raw).toString('base64');
  if (body.length > MAX_STORED) throw new Error(`${what} response too large to retain (${body.length} B gzipped)`);
  try {
    await store.transact([{
      op: 'put', table: 'provider', cond: { notExists: true },
      item: { pk, sk: `RAW#${r.rawSha256}`, sha256: r.rawSha256, what, httpStatus: r.status, retrievedAt, encoding: 'gzip+base64', body },
    }]);
  } catch (e) {
    if (!(e instanceof TxCancelled)) throw e; // the same bytes are already retained
  }
  return r.rawSha256;
}
