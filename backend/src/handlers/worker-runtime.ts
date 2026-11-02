// Worker composition: PayPal reader + writer (paypal-runtime) and the Plaid reader + connector + KMS vault.
// The only bundle that holds the Plaid connector (import-graph test). A missing or unreadable Plaid secret must not stop
// PayPal work: bank jobs then wait with a visible "not configured here" reason, and the next invocation retries.
import { plaidReader } from '../adapters/plaid/clients.ts';
import { plaidConnector } from '../adapters/plaid/connector.ts';
import type { Deps } from '../deps.ts';
import { paypalDeps } from './paypal-runtime.ts';
import { plaidHttp, plaidVault } from './plaid-runtime.ts';
import { bedrockInterpreter, bedrockRole, DRAFTER_PROMPT, PLANNER_PROMPT, REPLY_PROMPT } from '../adapters/bedrock/converse.ts';
import { mailFromEnv } from '../adapters/mail/compose.ts';

// S3: the worker is the only composition with a model (S3-D6). Spend: the dev $20 allocation (S3-D18).
const interpreter = process.env.HEADROOM_MODEL ? bedrockInterpreter({ modelId: process.env.HEADROOM_MODEL }) : undefined;
// S4: RecoveryPlanner and MessageDrafter on the same model and allocation; absent → Headroom's templates.
const planner = process.env.HEADROOM_MODEL ? bedrockRole(PLANNER_PROMPT, 'candidates', { modelId: process.env.HEADROOM_MODEL }) : undefined;
const drafter = process.env.HEADROOM_MODEL ? bedrockRole(DRAFTER_PROMPT, 'drafts', { modelId: process.env.HEADROOM_MODEL }) : undefined;
// S5: ReplyInterpreter on the same model and allocation; absent → every authorized reply is "Needs you: read the reply".
const replier = process.env.HEADROOM_MODEL ? bedrockRole(REPLY_PROMPT, 'reply', { modelId: process.env.HEADROOM_MODEL }) : undefined;

// S7 B6: the payer's browser runs in its own Lambda; the worker only hands it the SUBMITTING attempt.
const payerAsync = process.env.HR_PAYER_FN ? async (req: import('../domain/demo/payer.ts').PayRequest) => {
  const { InvokeCommand, LambdaClient } = await import('@aws-sdk/client-lambda');
  await new LambdaClient({}).send(new InvokeCommand({ FunctionName: process.env.HR_PAYER_FN, InvocationType: 'Event', Payload: Buffer.from(JSON.stringify(req)) }));
} : undefined;

export async function workerDeps(): Promise<Deps> {
  const d = { ...(await paypalDeps()), interpreter, planner, drafter, payerAsync, bedrockEnv: 'dev' as const };
  try {
    const [http, vault] = await Promise.all([plaidHttp(), plaidVault()]);
    return { ...d, replier, plaid: { reader: plaidReader(http), connector: plaidConnector(http) }, vault, mail: mailFromEnv(d.store, vault, d.now, await gmailSecretEnv()) };
  } catch (e) {
    console.error(JSON.stringify({ level: 'error', msg: 'Plaid composition unavailable; bank jobs will wait', error: (e as Error).message }));
    return { ...d, replier };
  }
}

/** S5-D26: the Gmail OAuth client and test addresses from Secrets Manager (worker only); absent → no mail channel, messages wait. */
async function gmailSecretEnv(): Promise<NodeJS.ProcessEnv> {
  if (!process.env.HR_GMAIL_SECRET_ID) return {};
  try {
    const { GetSecretValueCommand, SecretsManagerClient } = await import('@aws-sdk/client-secrets-manager');
    const s = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: process.env.HR_GMAIL_SECRET_ID }));
    const v = JSON.parse(s.SecretString ?? '{}');
    return { google_oauth_client_id: v.client_id, google_oauth_client_secret: v.client_secret, gmail_test_recipient: v.recipient, gmail_test_sender: v.sender };
  } catch (e) {
    console.error(JSON.stringify({ level: 'error', msg: 'Gmail secret unavailable; messages wait', error: (e as Error).message }));
    return {};
  }
}
