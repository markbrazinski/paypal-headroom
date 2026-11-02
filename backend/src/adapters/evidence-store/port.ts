// Original documents, immutable and content-addressed (S03 §6.5): key T#<t>/R#<r>/<sha256>.pdf. A put of an existing key is a
// no-op (same key = same bytes); nothing ever overwrites or deletes.
export interface EvidenceStore {
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
}
export const evidenceKey = (tenantId: string, runId: string, sha256: string) => `T#${tenantId}/R#${runId}/${sha256}.pdf`;
