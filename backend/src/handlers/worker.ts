// Worker Lambda: SQS → processBatch. Partial batch failures let SQS redeliver only what failed or didn't fit.
import { processBatch } from '../jobs/worker.ts';
import { workerDeps } from './worker-runtime.ts';

export const handler = async (e: { Records: { messageId: string; body: string }[] }, ctx?: { getRemainingTimeInMillis(): number }) =>
  processBatch(await workerDeps(), e.Records, () => ctx?.getRemainingTimeInMillis() ?? Number.POSITIVE_INFINITY);
