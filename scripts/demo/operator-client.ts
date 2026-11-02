import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';

export const LOCAL = `http://127.0.0.1:${process.env.PORT ?? 8787}`;
export const arg = (name: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };

/** S7-D10: the deployed stack for `--stage dev|review` (dev when absent). */
export const stackOf = (stage = arg('--stage')) => (stage === 'review' ? 'HeadroomReview' : 'HeadroomDev');

/** Invokes the stage's operator Lambda with the owner's AWS profile (AWS_PROFILE, default headroom-admin). */
export async function invokeOperator(payload: unknown) {
  process.env.AWS_PROFILE ??= 'headroom-admin';
  const fn = process.env.HR_OPERATOR_FN ?? `${stackOf()}-operator`;
  const r = await new LambdaClient({ region: process.env.AWS_REGION ?? 'us-east-1' }).send(new InvokeCommand({ FunctionName: fn, Payload: Buffer.from(JSON.stringify(payload)) }));
  const out = r.Payload ? JSON.parse(Buffer.from(r.Payload).toString()) : null;
  if (r.FunctionError) throw new Error(`operator failed: ${JSON.stringify(out)}`);
  return out;
}
