// One stack per stage (S01 §6.8; S7-D10 adds `review`): every name derives from the stage, so `dev` keeps exactly its names. Behind Cognito. Every data route needs a Cognito JWT; the only
// unauthenticated route is the PayPal webhook (signature-verified, stores raw, returns no data).
import { fileURLToPath } from 'node:url';
import { API_DDB_GRANTS } from './api-grants.ts';
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import * as ddb from 'aws-cdk-lib/aws-dynamodb';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { HttpJwtAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as cf from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as secrets from 'aws-cdk-lib/aws-secretsmanager';
import * as cw from 'aws-cdk-lib/aws-cloudwatch';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as kms from 'aws-cdk-lib/aws-kms';

const root = (p: string) => fileURLToPath(new URL(`../../${p}`, import.meta.url));
const CONNECTION_ID = 'paypal-sandbox';

export type Stage = 'dev' | 'review';
export class HeadroomStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps & { webDist?: string; stage?: Stage }) {
    super(scope, id, props);
    const stage = props?.stage ?? 'dev';
    const N = `Headroom${stage[0].toUpperCase()}${stage.slice(1)}`; // HeadroomDev / HeadroomReview

    const table = (name: string) => new ddb.Table(this, name, {
      tableName: `${N}-${name}`,
      partitionKey: { name: 'pk', type: ddb.AttributeType.STRING },
      sortKey: { name: 'sk', type: ddb.AttributeType.STRING },
      billingMode: ddb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.RETAIN, // evidence survives a stack delete
    });
    const core = table('core');
    const work = table('work');
    const provider = table('provider');
    const audit = table('audit');
    work.addGlobalSecondaryIndex({ indexName: 'due', partitionKey: { name: 'gsiDue', type: ddb.AttributeType.STRING }, sortKey: { name: 'dueKey', type: ddb.AttributeType.STRING } });
    (work.node.defaultChild as ddb.CfnTable).timeToLiveSpecification = { attributeName: 'ttl', enabled: true };
    // Only STAGE# (unpublished sync pages, 7 days) carries ttl in the provider table; evidence items never do (S2-IR-08).
    (provider.node.defaultChild as ddb.CfnTable).timeToLiveSpecification = { attributeName: 'ttl', enabled: true };

    const dlq = new sqs.Queue(this, 'WorkDlq', { retentionPeriod: Duration.days(14) });
    const queue = new sqs.Queue(this, 'WorkQueue', { visibilityTimeout: Duration.seconds(360), deadLetterQueue: { queue: dlq, maxReceiveCount: 5 } });
    const secret = new secrets.Secret(this, 'PayPalSecret', { secretName: `headroom/${stage}/paypal`, description: 'PayPal sandbox {client_id, secret, merchant_email, webhook_id}; populated from .env by the owner-approved script' });
    // S2 (S02 §6.8): Plaid sandbox credentials, and the envelope key for Plaid tokens at rest (S2-D3).
    const gmailSecret = new secrets.Secret(this, 'GmailSecret', { secretName: `headroom/${stage}/gmail`, description: 'Gmail test-mode OAuth client {client_id, client_secret, recipient, sender}; populated from .env by scripts/dev/setup.ts gmail (S5-D26)' });
    const plaidSecret = new secrets.Secret(this, 'PlaidSecret', { secretName: `headroom/${stage}/plaid`, description: 'Plaid sandbox {client_id, secret}; populated from .env by scripts/dev/setup.ts plaid' });
    const plaidKey = new kms.Key(this, 'PlaidTokens', { alias: `${N}-plaid-tokens`, enableKeyRotation: true, removalPolicy: RemovalPolicy.RETAIN, description: 'Envelope key for Plaid public/access tokens (data keys bound to {tenantId, effectKey})' });

    // S3 (S03 §6.8): original documents, write-once by key (IfNoneMatch), versioned, kept on stack delete (AWS-STANDING: RETAIN).
    const evidenceBucket = new s3.Bucket(this, 'Evidence', {
      bucketName: `headroom-${stage}-evidence-${this.account}`, blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED, versioned: true, removalPolicy: RemovalPolicy.RETAIN,
    });
    const NOVA = 'us.amazon.nova-2-lite-v1:0';

    const env = {
      HR_TABLE_CORE: core.tableName, HR_TABLE_WORK: work.tableName, HR_TABLE_PROVIDER: provider.tableName, HR_TABLE_AUDIT: audit.tableName,
      HR_QUEUE_URL: queue.queueUrl, HR_CONNECTION_ID: CONNECTION_ID, HEADROOM_STAGE: stage, NODE_OPTIONS: '--enable-source-maps',
      // S7-UX3: provider-grant end for this deployment (owner decision); unset = the recorded cutoff in backend/src/deps.ts.
      ...(process.env.HEADROOM_GRANT_EXPIRES_AT ? { HEADROOM_GRANT_EXPIRES_AT: process.env.HEADROOM_GRANT_EXPIRES_AT } : {}), EVIDENCE_BUCKET: evidenceBucket.bucketName,
    };
    const fn = (name: string, entry: string, extra: Record<string, string> = {}, timeout = 60) => new NodejsFunction(this, name, {
      functionName: `${N}-${name}`,
      entry: root(`backend/src/handlers/${entry}`),
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: Duration.seconds(timeout),
      environment: { ...env, ...extra },
      depsLockFilePath: root('package-lock.json'),
      projectRoot: root(''),
      bundling: {
        format: OutputFormat.ESM, minify: true, sourceMap: true, target: 'node22',
        externalModules: ['@aws-sdk/*'], // provided by the Lambda runtime
        banner: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);",
      },
    });
    const plaidEnv = { HR_PLAID_SECRET_ID: plaidSecret.secretName, HR_PLAID_KEY_ID: plaidKey.keyArn };
    const api = fn('api', 'api.ts', { ...plaidEnv, HR_MAIL_KIND: 'GMAIL' });
    const webhook = fn('webhook', 'webhook.ts', {}, 10);
    // Timeout 60 s, batch 5, lease 90 s are what the S2 sync time budget assumes (pinned by the infra test).
    const worker = fn('worker', 'worker.ts', { HR_PAYPAL_SECRET_ID: secret.secretName, ...plaidEnv, HEADROOM_MODEL: NOVA, HR_GMAIL_SECRET_ID: gmailSecret.secretName, HR_MAIL_KIND: 'GMAIL' });
    gmailSecret.grantRead(worker); // worker only: the API never holds the Gmail client secret
    const sweep = fn('sweep', 'sweep.ts');
    const operator = fn('operator', 'operator-lambda.ts', { HR_PAYPAL_SECRET_ID: secret.secretName }, 120);
    // S7 B6: the AUTOMATED-PAYER's browser (sandbox buyer on PayPal's hosted page). x86_64 for @sparticuz/chromium; its own secret.
    const payerSecret = new secrets.Secret(this, 'PayerSecret', { secretName: `headroom/${stage}/payer`, description: 'PayPal sandbox personal (buyer) login {email, password}; populated from .env by scripts/dev/setup.ts payer' });
    const payer = new NodejsFunction(this, 'payer', {
      functionName: `${N}-payer`, entry: root('backend/src/handlers/payer-lambda.ts'), runtime: lambda.Runtime.NODEJS_22_X, architecture: lambda.Architecture.X86_64,
      memorySize: 2048, timeout: Duration.seconds(120), reservedConcurrentExecutions: 2,
      retryAttempts: 0, maxEventAge: Duration.seconds(60), // S7-R28: AWS never re-runs the browser; the worker's 4-min backstop decides
      environment: { ...env, HR_PAYER_SECRET_ID: payerSecret.secretName },
      depsLockFilePath: root('package-lock.json'), projectRoot: root(''),
      bundling: { format: OutputFormat.ESM, minify: true, sourceMap: true, target: 'node22', externalModules: ['@aws-sdk/*'], nodeModules: ['@sparticuz/chromium', 'playwright-core'], banner: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" },
    });
    payerSecret.grantRead(payer);
    worker.addEnvironment('HR_PAYER_FN', payer.functionName);
    payer.grantInvoke(worker);

    // ---- IAM: least privilege per role (S01 §6.8). TransactWriteItems is authorised per underlying action.
    const leading = (prefixes: string[]) => ({ 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': prefixes } });
    const allow = (f: NodejsFunction, actions: string[], resources: string[], conditions?: Record<string, unknown>) =>
      f.addToRolePolicy(new iam.PolicyStatement({ actions, resources, ...(conditions ? { conditions } : {}) }));
    const R = ['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:ConditionCheckItem'];
    const W = ['dynamodb:PutItem', 'dynamodb:UpdateItem'];

    // The API's DynamoDB permissions are data (api-grants.ts): the acceptance harness enforces the same list (adopted 2 Nov 2026).
    const tables = { core, work, provider, audit };
    for (const g of API_DDB_GRANTS) allow(api, g.actions, [tables[g.table].tableArn], g.prefixes ? leading(g.prefixes) : undefined);
    queue.grantSendMessages(api);
    // KMS: data keys only with a tenantId in the encryption context.
    const kmsCond = { Null: { 'kms:EncryptionContext:tenantId': 'false' } };
    for (const f of [api, worker]) {
      allow(f, ['kms:GenerateDataKey', 'kms:Decrypt'], [plaidKey.keyArn], kmsCond);
      plaidSecret.grantRead(f);
    }

    allow(webhook, ['dynamodb:PutItem'], [provider.tableArn], leading(['WEBHOOK#*']));
    allow(webhook, ['dynamodb:PutItem', 'dynamodb:GetItem'], [work.tableArn], leading(['JOB#whv#*']));
    queue.grantSendMessages(webhook);

    for (const f of [worker, operator]) {
      for (const t of [core, work, provider, audit]) t.grantReadWriteData(f);
      secret.grantRead(f);
      queue.grantSendMessages(f);
    }
    // The payer touches only its attempt's job item (claim, result, wake); the worker applies the result. No core, provider or audit access.
    allow(payer, ['dynamodb:GetItem', 'dynamodb:UpdateItem'], [work.tableArn], leading(['JOB#payer#*']));
    queue.grantSendMessages(payer);
    worker.addEventSource(new SqsEventSource(queue, { batchSize: 5, reportBatchItemFailures: true }));

    // S3 evidence: api Put (upload) + Get (document view), operator Put (inject), worker Get (read). Keys are T#<tenant>/R#<run>/<sha>.pdf.
    const docs = evidenceBucket.arnForObjects('T#*');
    allow(api, ['s3:PutObject', 's3:GetObject'], [docs]);
    allow(operator, ['s3:PutObject'], [docs]);
    allow(worker, ['s3:GetObject'], [docs]);
    allow(payer, ['s3:PutObject'], [evidenceBucket.arnForObjects('T#*/payer/*')]); // screenshots only: T#<tenant>/R#<run>/payer/<attempt>/<step>.png
    // Bedrock: the worker only, Nova 2 Lite only: the US cross-region inference profile plus the foundation model in its regions.
    allow(worker, ['bedrock:InvokeModel'], [
      `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/${NOVA}`,
      ...['us-east-1', 'us-east-2', 'us-west-2'].map((r) => `arn:aws:bedrock:${r}::foundation-model/amazon.nova-2-lite-v1:0`),
    ]);

    // Sweep recovers expired leases: an in-flight effect → UNKNOWN updates the effect (work), the invoice (core) and writes audit.
    allow(sweep, [...R, ...W], [work.tableArn, `${work.tableArn}/index/due`]);
    allow(sweep, ['dynamodb:GetItem', 'dynamodb:UpdateItem'], [core.tableArn]);
    allow(sweep, ['dynamodb:PutItem'], [audit.tableArn]);
    queue.grantSendMessages(sweep);
    new events.Rule(this, 'SweepEveryMinute', { schedule: events.Schedule.rate(Duration.minutes(1)), targets: [new targets.LambdaFunction(sweep)] });
    // Judge dock (owner, 4 Nov 2026): the shared live run resets by itself once idle 10 min (review; a no-op without a lease).
    if (stage === 'review') new events.Rule(this, 'LiveAutoReset', { schedule: events.Schedule.rate(Duration.minutes(5)), targets: [new targets.LambdaFunction(operator, { event: events.RuleTargetInput.fromObject({ action: 'autoReset' }) })] });

    // ---- SPA bucket + CloudFront (OAC). /v1/* goes to the HTTP API on the same origin.
    const bucket = new s3.Bucket(this, 'Spa', { blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, enforceSSL: true, removalPolicy: RemovalPolicy.DESTROY, autoDeleteObjects: true });

    // ---- Cognito: managed login, code + PKCE, no self sign-up, users created with suppressed email.
    const pool = new cognito.UserPool(this, 'Users', {
      userPoolName: N, selfSignUpEnabled: false, signInAliases: { email: true },
      passwordPolicy: { minLength: 14 }, accountRecovery: cognito.AccountRecovery.NONE, removalPolicy: RemovalPolicy.DESTROY,
    });
    for (const g of ['operator', 'judge']) new cognito.CfnUserPoolGroup(this, `Group-${g}`, { userPoolId: pool.userPoolId, groupName: g }); // S7 R10 roles
    const domain = pool.addDomain('Login', { cognitoDomain: { domainPrefix: `headroom-${stage}-${this.account}` } });

    const spaRewrite = new cf.Function(this, 'SpaRewrite', {
      runtime: cf.FunctionRuntime.JS_2_0,
      code: cf.FunctionCode.fromInline("function handler(e){var r=e.request;if(r.uri.indexOf('.')===-1){r.uri='/index.html';}return r;}"),
    });

    const httpApi = new apigw.HttpApi(this, 'Api', { apiName: N, createDefaultStage: true });
    const dist = new cf.Distribution(this, 'Cdn', {
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: cf.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        functionAssociations: [{ function: spaRewrite, eventType: cf.FunctionEventType.VIEWER_REQUEST }],
      },
      additionalBehaviors: {
        '/v1/*': {
          origin: new origins.HttpOrigin(`${httpApi.apiId}.execute-api.${this.region}.amazonaws.com`),
          allowedMethods: cf.AllowedMethods.ALLOW_ALL,
          cachePolicy: cf.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cf.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          viewerProtocolPolicy: cf.ViewerProtocolPolicy.HTTPS_ONLY,
        },
      },
    });
    const site = `https://${dist.distributionDomainName}`;
    const client = pool.addClient('Spa', {
      generateSecret: false,
      authFlows: {},
      oAuth: { flows: { authorizationCodeGrant: true }, scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL], callbackUrls: [`${site}/`], logoutUrls: [`${site}/`] },
      idTokenValidity: Duration.hours(1),
      preventUserExistenceErrors: true,
    });

    const authorizer = new HttpJwtAuthorizer('Cognito', `https://cognito-idp.${this.region}.amazonaws.com/${pool.userPoolId}`, { jwtAudience: [client.userPoolClientId] });
    httpApi.addRoutes({ path: '/v1/{proxy+}', methods: [apigw.HttpMethod.ANY], integration: new HttpLambdaIntegration('ApiInt', api), authorizer });
    // S7 R10: the demo lane (judges, operator) goes to the operator Lambda; it checks the Cognito group itself (roleOf).
    const demoInt = new HttpLambdaIntegration('DemoInt', operator);
    for (const path of ['/v1/demo/{proxy+}', '/v1/operator/{proxy+}']) httpApi.addRoutes({ path, methods: [apigw.HttpMethod.ANY], integration: demoInt, authorizer });
    const [webhookRoute] = httpApi.addRoutes({ path: '/v1/webhooks/paypal', methods: [apigw.HttpMethod.POST], integration: new HttpLambdaIntegration('WebhookInt', webhook) });
    // Throttle the public surface (S1-IR-05): the webhook route tightly, everything else generously.
    const apiStage = httpApi.defaultStage!.node.defaultChild as apigw.CfnStage;
    apiStage.defaultRouteSettings = { throttlingRateLimit: 20, throttlingBurstLimit: 40 };
    apiStage.routeSettings = { 'POST /v1/webhooks/paypal': { ThrottlingRateLimit: 2, ThrottlingBurstLimit: 10 } }; // untyped map: CloudFormation casing
    apiStage.node.addDependency(webhookRoute); // a fresh stack must create the route before the stage names it (review create, 3 Nov 2026)

    if (props?.webDist) {
      new s3deploy.BucketDeployment(this, 'SpaDeploy', {
        destinationBucket: bucket, distribution: dist, distributionPaths: ['/*'],
        sources: [s3deploy.Source.asset(props.webDist), s3deploy.Source.jsonData('config.json', { domain: `${domain.domainName}.auth.${this.region}.amazoncognito.com`, clientId: client.userPoolClientId })],
      });
    }

    // ---- Alarms (no notification target: sending one would be a communication) and a budget without subscribers.
    new cw.Alarm(this, 'DlqNotEmpty', { metric: dlq.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(5) }), threshold: 0, comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD, evaluationPeriods: 1, treatMissingData: cw.TreatMissingData.NOT_BREACHING });
    new cw.Alarm(this, 'UnknownEffectsOlderThan15m', {
      metric: new cw.Metric({ namespace: `Headroom/${stage}`, metricName: 'UnknownEffectsOlderThan15m', statistic: 'Maximum', period: Duration.minutes(5) }),
      threshold: 0, comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD, evaluationPeriods: 1, treatMissingData: cw.TreatMissingData.NOT_BREACHING,
    });
    for (const amount of [10, 25, 50]) new budgets.CfnBudget(this, `Budget${amount}`, { budget: { budgetName: `${N}-${amount}`, budgetType: 'COST', timeUnit: 'MONTHLY', budgetLimit: { amount, unit: 'USD' } } });

    new CfnOutput(this, 'SiteUrl', { value: site });
    new CfnOutput(this, 'ApiUrl', { value: httpApi.apiEndpoint });
    new CfnOutput(this, 'WebhookUrl', { value: `${httpApi.apiEndpoint}/v1/webhooks/paypal` });
    new CfnOutput(this, 'UserPoolId', { value: pool.userPoolId });
    new CfnOutput(this, 'ClientId', { value: client.userPoolClientId });
    new CfnOutput(this, 'OperatorFunction', { value: operator.functionName });
    new CfnOutput(this, 'PayerSecretName', { value: payerSecret.secretName });
    new CfnOutput(this, 'SecretName', { value: secret.secretName });
    new CfnOutput(this, 'PlaidSecretName', { value: plaidSecret.secretName });
    new CfnOutput(this, 'GmailSecretName', { value: gmailSecret.secretName });
    new CfnOutput(this, 'PlaidKeyId', { value: plaidKey.keyArn });
    new CfnOutput(this, 'EvidenceBucket', { value: evidenceBucket.bucketName });
  }
}

/** The original name, kept for existing imports. */
export const HeadroomDev = HeadroomStack;
