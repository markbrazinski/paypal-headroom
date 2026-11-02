// Composition for Lambdas without PayPal credentials (api, webhook, sweep). No PayPal secret, no PayPal client.
// The api adds a Plaid link-token client and the KMS vault (plaid-runtime.ts); never a connector.
import { DynamoStore } from '../adapters/store/dynamodb.ts';
import { sqsQueue } from '../adapters/queue/sqs.ts';
import { S6_GRANT, withGrantExpiry, type Config } from '../deps.ts';
import { mailConfig } from '../adapters/mail/config.ts';
import { S3Evidence } from '../adapters/evidence-store/s3.ts';

const env = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`missing env ${k}`); return v; };

export const store = new DynamoStore({ core: env('HR_TABLE_CORE'), work: env('HR_TABLE_WORK'), provider: env('HR_TABLE_PROVIDER'), audit: env('HR_TABLE_AUDIT') });
export const queue = sqsQueue(env('HR_QUEUE_URL'));
export const now = () => new Date().toISOString();
/** merchantEmail/webhookId come from the secret, which only worker/operator read. */
export const baseConfig: Config = { stage: process.env.HEADROOM_STAGE === 'review' ? 'review' : 'dev', connectionId: env('HR_CONNECTION_ID'), merchantEmail: '', webhookId: null, grant: withGrantExpiry(S6_GRANT), mail: process.env.HR_MAIL_KIND === 'GMAIL' ? { kind: 'GMAIL', sender: null, inbox: null } : mailConfig() }; // PP-S6 / PLAID-S6 renewal of the standing grants (Build Book §I): S6 adds the payouts budget
/** S3: the RETAIN evidence bucket (api writes uploads and reads for the document view; operator writes injections; worker reads). */
export const evidence = process.env.EVIDENCE_BUCKET ? new S3Evidence(process.env.EVIDENCE_BUCKET) : undefined;
