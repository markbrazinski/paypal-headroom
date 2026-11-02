import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import type { Queue } from './port.ts';

export function sqsQueue(url: string, client = new SQSClient({})): Queue {
  return { send: async (jobId) => { await client.send(new SendMessageCommand({ QueueUrl: url, MessageBody: jobId })); } };
}
