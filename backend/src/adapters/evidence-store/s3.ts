// dev: the RETAIN, versioned, BPA evidence bucket. IfNoneMatch '*' makes every key write-once.
import { GetObjectCommand, NoSuchKey, PutObjectCommand, S3Client, S3ServiceException } from '@aws-sdk/client-s3';
import type { EvidenceStore } from './port.ts';

export class S3Evidence implements EvidenceStore {
  private c: S3Client;
  private bucket: string;
  constructor(bucket: string, client = new S3Client({})) { this.bucket = bucket; this.c = client; }
  async put(key: string, bytes: Uint8Array) {
    try {
      await this.c.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: bytes, ContentType: 'application/pdf', IfNoneMatch: '*' }));
    } catch (e) {
      // 412: the object exists. Its key is its sha256, so it is these bytes.
      if (e instanceof S3ServiceException && e.$metadata.httpStatusCode === 412) return;
      throw e;
    }
  }
  async get(key: string) {
    try {
      const r = await this.c.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      return r.Body ? new Uint8Array(await r.Body.transformToByteArray()) : null;
    } catch (e) {
      if (e instanceof NoSuchKey) return null;
      throw e;
    }
  }
}
