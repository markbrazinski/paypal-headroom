// Static IAM check (S01 §6.8): role actions and key conditions, secret access, no writer reachable from api/webhook.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { HeadroomDev } from './headroom-dev.ts';

const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } }); // synth without bundling
const t = Template.fromStack(new HeadroomDev(app, 'T', { env: { account: '123456789012', region: 'us-east-1' } }));
const policies = t.findResources('AWS::IAM::Policy');
const roleOf = (fnName: string) => {
  const fn = Object.values(t.findResources('AWS::Lambda::Function')).find((f: any) => f.Properties.FunctionName === `HeadroomDev-${fnName}`) as any;
  return fn.Properties.Role['Fn::GetAtt'][0] as string;
};
const statementsFor = (fnName: string) => {
  const role = roleOf(fnName);
  return Object.values(policies).filter((p: any) => p.Properties.Roles.some((r: any) => r.Ref === role)).flatMap((p: any) => p.Properties.PolicyDocument.Statement) as any[];
};
const actions = (s: any) => ([] as string[]).concat(s.Action);

const secretRef = (logical: string) => (s: any) => actions(s).includes('secretsmanager:GetSecretValue') && JSON.stringify(s.Resource).includes(logical);
const ppSecret = Object.keys(t.findResources('AWS::SecretsManager::Secret')).find((k) => k.startsWith('PayPalSecret'))!;
const plaidSecret = Object.keys(t.findResources('AWS::SecretsManager::Secret')).find((k) => k.startsWith('PlaidSecret'))!;

test('only worker and operator can read the PayPal secret; webhook and sweep have no secretsmanager:*', () => {
  for (const f of ['webhook', 'sweep']) assert.ok(!statementsFor(f).some((s) => actions(s).some((a) => a.startsWith('secretsmanager:'))), f);
  assert.ok(!statementsFor('api').some(secretRef(ppSecret)), 'api cannot read the PayPal secret');
  for (const f of ['worker', 'operator']) assert.ok(statementsFor(f).some(secretRef(ppSecret)), f);
});

test('S2 §6.8: Plaid secret and KMS only for api + worker; webhook, sweep, operator have neither', () => {
  for (const f of ['api', 'worker']) {
    assert.ok(statementsFor(f).some(secretRef(plaidSecret)), `${f} reads the Plaid secret`);
    const k = statementsFor(f).find((s) => actions(s).includes('kms:GenerateDataKey'));
    assert.deepEqual(actions(k).sort(), ['kms:Decrypt', 'kms:GenerateDataKey']);
    assert.deepEqual(k.Condition, { Null: { 'kms:EncryptionContext:tenantId': 'false' } }, 'data keys require a tenantId context');
  }
  for (const f of ['webhook', 'sweep', 'operator']) {
    assert.ok(!statementsFor(f).some((s) => actions(s).some((a) => a.startsWith('kms:'))), `${f} has kms`);
    assert.ok(!statementsFor(f).some(secretRef(plaidSecret)), `${f} reads the Plaid secret`);
  }
  t.hasResourceProperties('AWS::KMS::Key', { EnableKeyRotation: true });
});

test('S2 §6.8: api has no PutItem on PLAID#* and writes only COUNTER#plaid#* counters', () => {
  const s = statementsFor('api');
  const keysOf = (x: any) => x.Condition?.['ForAllValues:StringLike']?.['dynamodb:LeadingKeys'] ?? [];
  assert.deepEqual(actions(s.find((x) => keysOf(x).includes('PLAID#*'))).sort(), ['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:UpdateItem']);
  assert.ok(!s.some((x) => keysOf(x).includes('PLAID#*') && actions(x).some((a) => a === 'dynamodb:PutItem' || a === 'dynamodb:ConditionCheckItem')));
  const counterWrites = s.filter((x) => keysOf(x).some((k: string) => k.startsWith('COUNTER#')) && actions(x).some((a) => /Put|Update/.test(a)));
  assert.deepEqual(counterWrites.map(keysOf), [['COUNTER#plaid#*']]);
});

test('S2-IR-08: TTL enabled on the provider table (STAGE# pages expire after 7 days)', () => {
  t.hasResourceProperties('AWS::DynamoDB::Table', { TableName: 'HeadroomDev-provider', TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true } });
});

test('S2-PR-06: worker timeout 60 s, batch size 5, report batch item failures (the sync time budget assumes these)', () => {
  const fn = Object.values(t.findResources('AWS::Lambda::Function')).find((f: any) => f.Properties.FunctionName === 'HeadroomDev-worker') as any;
  assert.equal(fn.Properties.Timeout, 60);
  t.hasResourceProperties('AWS::Lambda::EventSourceMapping', { BatchSize: 5, FunctionResponseTypes: ['ReportBatchItemFailures'] });
});

test('api: provider writes only PPREF#INVNUM#*; work access scoped by leading keys; no delete anywhere', () => {
  const s = statementsFor('api');
  const providerPut = s.filter((x) => actions(x).includes('dynamodb:PutItem') && x.Condition?.['ForAllValues:StringLike']?.['dynamodb:LeadingKeys']?.includes('PPREF#INVNUM#*'));
  assert.equal(providerPut.length, 1);
  const keysOf = (x: any) => x.Condition?.['ForAllValues:StringLike']?.['dynamodb:LeadingKeys'] ?? [];
  assert.deepEqual(keysOf(s.find((x) => keysOf(x).includes('IDEM#*'))), ['JOB#*', 'IDEM#*']);
  assert.deepEqual(actions(s.find((x) => keysOf(x).includes('COUNTER#*'))), ['dynamodb:GetItem'], 'api never writes the grant counter');
  assert.ok(!actions(s.find((x) => keysOf(x).includes('EFFECT#*'))).includes('dynamodb:UpdateItem'), 'api never moves an effect');
  assert.ok(!s.some((x) => actions(x).some((a) => /DeleteItem|BatchWrite|Scan/.test(a))));
});

test('webhook: only Put on WEBHOOK#* in provider and JOB#whv#* in work; route throttled', () => {
  const s = statementsFor('webhook').filter((x) => actions(x).some((a) => a.startsWith('dynamodb:')));
  assert.equal(s.length, 2);
  assert.deepEqual(actions(s.find((x) => x.Condition['ForAllValues:StringLike']['dynamodb:LeadingKeys'][0] === 'WEBHOOK#*')), ['dynamodb:PutItem']);
  t.hasResourceProperties('AWS::ApiGatewayV2::Stage', { RouteSettings: { 'POST /v1/webhooks/paypal': { ThrottlingRateLimit: 2, ThrottlingBurstLimit: 10 } } });
  const keys = s.map((x) => x.Condition['ForAllValues:StringLike']['dynamodb:LeadingKeys'][0]).sort();
  assert.deepEqual(keys, ['JOB#whv#*', 'WEBHOOK#*']);
});

test('API routes: /v1/{proxy+} has the JWT authorizer; only the webhook route is unauthenticated', () => {
  const routes = Object.values(t.findResources('AWS::ApiGatewayV2::Route')) as any[];
  const byKey = Object.fromEntries(routes.map((r) => [r.Properties.RouteKey, r.Properties]));
  assert.equal(byKey['ANY /v1/{proxy+}'].AuthorizationType, 'JWT');
  assert.ok(!byKey['POST /v1/webhooks/paypal'].AuthorizationType || byKey['POST /v1/webhooks/paypal'].AuthorizationType === 'NONE');
  // S7 R10: the demo lane rides the same authorizer (the operator Lambda checks the Cognito group).
  for (const k of ['ANY /v1/demo/{proxy+}', 'ANY /v1/operator/{proxy+}']) assert.equal(byKey[k].AuthorizationType, 'JWT', k);
  assert.equal(routes.length, 4);
});

test('S7 B6: the payer Lambda is isolated: own secret, no PayPal or Plaid secret, no Bedrock, invoked only by the worker', () => {
  t.hasResourceProperties('AWS::Lambda::Function', { FunctionName: 'HeadroomDev-payer', Architectures: ['x86_64'], MemorySize: 2048, Timeout: 120, ReservedConcurrentExecutions: 2 });
  const st = statementsFor('payer');
  assert.ok(!st.some((s) => actions(s).some((a) => a.startsWith('bedrock:') || a.startsWith('kms:') || a === 'dynamodb:DeleteItem')));
  assert.ok(st.some(secretRef('PayerSecret')) && !st.some(secretRef('PayPalSecret')) && !st.some(secretRef('PlaidSecret')) && !st.some(secretRef('GmailSecret')));
  assert.ok(statementsFor('worker').some((s) => actions(s).includes('lambda:InvokeFunction')));
  // S7-R28: no async retry; table access is the attempt's job item only.
  t.hasResourceProperties('AWS::Lambda::EventInvokeConfig', { MaximumRetryAttempts: 0, MaximumEventAgeInSeconds: 60 });
  const ddbRes = st.filter((s) => actions(s).some((a) => a.startsWith('dynamodb:')));
  assert.ok(ddbRes.length === 1 && JSON.stringify(ddbRes[0].Resource).includes('work') && JSON.stringify(ddbRes[0].Condition).includes('JOB#payer#*'), JSON.stringify(ddbRes));
  t.hasResourceProperties('AWS::Cognito::UserPoolGroup', { GroupName: 'judge' });
  t.hasResourceProperties('AWS::Cognito::UserPoolGroup', { GroupName: 'operator' });
});

test('Cognito: no self sign-up; code flow only', () => {
  t.hasResourceProperties('AWS::Cognito::UserPool', { AdminCreateUserConfig: { AllowAdminCreateUserOnly: true } });
  t.hasResourceProperties('AWS::Cognito::UserPoolClient', { AllowedOAuthFlows: ['code'], GenerateSecret: false });
});

test('S3 §6.8: only the worker may invoke Bedrock, and only Nova 2 Lite (profile + foundation-model ARNs)', () => {
  for (const f of ['api', 'webhook', 'sweep', 'operator']) assert.ok(!statementsFor(f).some((s) => actions(s).some((a) => a.startsWith('bedrock:'))), `${f} has bedrock`);
  const b = statementsFor('worker').filter((s) => actions(s).some((a) => a.startsWith('bedrock:')));
  assert.equal(b.length, 1);
  assert.deepEqual(actions(b[0]), ['bedrock:InvokeModel']);
  const res = JSON.stringify(b[0].Resource);
  assert.ok(res.includes('inference-profile/us.amazon.nova-2-lite-v1:0') && res.includes('foundation-model/amazon.nova-2-lite-v1:0'));
  assert.ok(!res.includes('*'), 'no wildcard model');
  const fn = Object.values(t.findResources('AWS::Lambda::Function')).find((f: any) => f.Properties.FunctionName === 'HeadroomDev-worker') as any;
  assert.equal(fn.Properties.Environment.Variables.HEADROOM_MODEL, 'us.amazon.nova-2-lite-v1:0');
});

test('S3 §6.8: evidence bucket RETAIN + versioned + block public access + SSE-S3 + TLS only', () => {
  const [id, b] = Object.entries(t.findResources('AWS::S3::Bucket')).find(([k]) => k.startsWith('Evidence'))! as [string, any];
  assert.equal(b.DeletionPolicy, 'Retain');
  assert.deepEqual(b.Properties.VersioningConfiguration, { Status: 'Enabled' });
  assert.deepEqual(b.Properties.PublicAccessBlockConfiguration, { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true });
  assert.equal(b.Properties.BucketEncryption.ServerSideEncryptionConfiguration[0].ServerSideEncryptionByDefault.SSEAlgorithm, 'AES256');
  const policy = Object.values(t.findResources('AWS::S3::BucketPolicy')).find((p: any) => JSON.stringify(p.Properties.Bucket).includes(id)) as any;
  assert.ok(JSON.stringify(policy.Properties.PolicyDocument).includes('aws:SecureTransport'));
});

test('S3 §6.8: evidence S3 actions exactly — api Put+Get, operator Put, worker Get; webhook and sweep none; no delete', () => {
  const s3Of = (f: string) => statementsFor(f).filter((s) => actions(s).some((a) => a.startsWith('s3:'))).flatMap(actions).sort();
  assert.deepEqual(s3Of('api'), ['s3:GetObject', 's3:PutObject']);
  assert.deepEqual(s3Of('operator'), ['s3:PutObject']);
  assert.deepEqual(s3Of('worker'), ['s3:GetObject']);
  assert.deepEqual(s3Of('webhook'), []);
  assert.deepEqual(s3Of('sweep'), []);
});

test('S6-D17: the api role has no payout write path; only the worker and operator bundles construct the PayPal writer', async () => {
  const { apiAllows } = await import('./api-grants.ts');
  for (const a of ['dynamodb:PutItem', 'dynamodb:UpdateItem']) assert.equal(apiAllows('work', a, 'EFFECT#pay:tenant:run:occ#cmt#0:v1:a1'), false, a);
  assert.equal(apiAllows('work', 'dynamodb:GetItem', 'EFFECT#pay:tenant:run:occ#cmt#0:v1:a1'), true, 'reads it for the panel');
  assert.equal(apiAllows('work', 'dynamodb:UpdateItem', 'SPENDDAY#pp#2026-11-13'), false);
  assert.equal(apiAllows('provider', 'dynamodb:PutItem', 'PPREF#PAYOUTITEM#X'), false);
  const { readdirSync, readFileSync } = await import('node:fs');
  const dir = new URL('../../backend/src/handlers/', import.meta.url);
  const writers = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && /paypalWriter\(/.test(readFileSync(new URL(f, dir), 'utf8')));
  assert.deepEqual(writers.sort(), ['local-server.ts', 'paypal-runtime.ts'], 'local-server runs the worker locally; dev builds the writer only in paypal-runtime (worker + operator)');
});

test('S7-D10 the review stage shares no resource name with dev (tables, functions, secrets, key alias, bucket, pool, domain, API, budgets)', async () => {
  const { HeadroomStack } = await import('./headroom-dev.ts');
  const env = { account: '123456789012', region: 'us-east-1' };
  const names = (stage: 'dev' | 'review') => {
    const tt = Template.fromStack(new HeadroomStack(new App({ context: { 'aws:cdk:bundling-stacks': [] } }), `S-${stage}`, { env, stage }));
    const out: string[] = [];
    const walk = (x: unknown, k = '') => {
      if (typeof x === 'string' && /(Name|Prefix|AliasName|Namespace)$/.test(k)) out.push(x);
      else if (x && typeof x === 'object') for (const [kk, v] of Object.entries(x)) walk(v, kk);
    };
    walk(tt.toJSON().Resources);
    return out.filter((n) => /headroom/i.test(n));
  };
  const [dev, review] = [names('dev'), names('review')];
  assert.ok(dev.length >= 15 && review.length === dev.length, `${dev.length} / ${review.length}`);
  assert.deepEqual(dev.filter((n) => review.includes(n)), []);
  assert.ok(review.every((n) => !/dev/i.test(n)), review.filter((n) => /dev/i.test(n)).join(', '));
});
