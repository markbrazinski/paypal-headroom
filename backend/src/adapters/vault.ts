// Envelope encryption for Plaid tokens at rest (S2-D3). A data key per secret, bound to its encryption context
// ({tenantId, effectKey}); the plaintext key lives only in memory. KMS in dev; a local master key file for local/tests.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { Sealed } from '@headroom/contracts';

export type VaultContext = Record<string, string>;
export interface DataKey { plaintext: Buffer; encDataKey: string }

export interface Vault {
  generateDataKey(ctx: VaultContext): Promise<DataKey>;
  decryptDataKey(encDataKey: string, ctx: VaultContext): Promise<Buffer>;
}

/** Local AES-256-GCM with an in-memory data key: no network call, so it can't fail the way KMS can (S2-PR-02). */
export function sealWith(key: DataKey, plaintext: string, ctx: VaultContext): Sealed {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key.plaintext, iv);
  c.setAAD(Buffer.from(JSON.stringify(ctx)));
  const ciphertext = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return { encDataKey: key.encDataKey, iv: iv.toString('base64'), ciphertext: ciphertext.toString('base64'), tag: c.getAuthTag().toString('base64'), context: ctx };
}

export function openWith(dataKey: Buffer, s: Sealed): string {
  const d = createDecipheriv('aes-256-gcm', dataKey, Buffer.from(s.iv, 'base64'));
  d.setAAD(Buffer.from(JSON.stringify(s.context)));
  d.setAuthTag(Buffer.from(s.tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(s.ciphertext, 'base64')), d.final()]).toString('utf8');
}

export async function seal(v: Vault, plaintext: string, ctx: VaultContext): Promise<Sealed> {
  return sealWith(await v.generateDataKey(ctx), plaintext, ctx);
}
export async function unseal(v: Vault, s: Sealed): Promise<string> {
  return openWith(await v.decryptDataKey(s.encDataKey, s.context), s);
}

/** Local/test vault: data keys wrapped under a 32-byte master key with the context as AAD. `failNext` injects a KMS-style failure. */
export class LocalVault implements Vault {
  private master: Buffer;
  failNext = 0;
  constructor(master: Buffer = randomBytes(32)) { this.master = master; }
  private fault() { if (this.failNext > 0) { this.failNext--; throw new Error('injected: key service unavailable'); } }
  async generateDataKey(ctx: VaultContext): Promise<DataKey> {
    this.fault();
    const plaintext = randomBytes(32);
    return { plaintext, encDataKey: JSON.stringify(sealWith({ plaintext: this.master, encDataKey: '' }, plaintext.toString('base64'), ctx)) };
  }
  async decryptDataKey(encDataKey: string, ctx: VaultContext): Promise<Buffer> {
    this.fault();
    const s = JSON.parse(encDataKey) as Sealed;
    if (JSON.stringify(s.context) !== JSON.stringify(ctx)) throw new Error('vault context mismatch');
    return Buffer.from(openWith(this.master, s), 'base64');
  }
}

/** KMS vault (dev). The key policy requires a tenantId in every encryption context. */
export async function kmsVault(keyId: string): Promise<Vault> {
  const { KMSClient, GenerateDataKeyCommand, DecryptCommand } = await import('@aws-sdk/client-kms');
  const kms = new KMSClient({});
  return {
    async generateDataKey(ctx) {
      const r = await kms.send(new GenerateDataKeyCommand({ KeyId: keyId, KeySpec: 'AES_256', EncryptionContext: ctx }));
      return { plaintext: Buffer.from(r.Plaintext!), encDataKey: Buffer.from(r.CiphertextBlob!).toString('base64') };
    },
    async decryptDataKey(encDataKey, ctx) {
      const r = await kms.send(new DecryptCommand({ KeyId: keyId, CiphertextBlob: Buffer.from(encDataKey, 'base64'), EncryptionContext: ctx }));
      return Buffer.from(r.Plaintext!);
    },
  };
}
