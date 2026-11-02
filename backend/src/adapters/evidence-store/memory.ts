// Tests and `npm run dev`: a Map, optionally mirrored to .headroom-local/evidence/ so a local server keeps documents across restarts.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EvidenceStore } from './port.ts';

export class MemoryEvidence implements EvidenceStore {
  private m = new Map<string, Uint8Array>();
  private dir?: string;
  constructor(dir?: string) { this.dir = dir; if (dir) mkdirSync(dir, { recursive: true }); }
  private file = (key: string) => join(this.dir!, encodeURIComponent(key));
  async put(key: string, bytes: Uint8Array) {
    if (this.m.has(key) || (this.dir && existsSync(this.file(key)))) return;
    this.m.set(key, new Uint8Array(bytes));
    if (this.dir) writeFileSync(this.file(key), bytes, { flag: 'wx' });
  }
  async get(key: string) {
    const v = this.m.get(key) ?? (this.dir && existsSync(this.file(key)) ? new Uint8Array(readFileSync(this.file(key))) : undefined);
    return v ? new Uint8Array(v) : null;
  }
  /** Test-only: tamper with stored bytes (S3-R21). */
  overwriteForTest(key: string, bytes: Uint8Array) { this.m.set(key, bytes); }
}
