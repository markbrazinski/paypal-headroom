import { App } from 'aws-cdk-lib';
import { fileURLToPath } from 'node:url';
import { HeadroomStack } from '../lib/headroom-dev.ts';

const app = new App();
const webDist = fileURLToPath(new URL('../../web/dist', import.meta.url));
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'us-east-1' };
new HeadroomStack(app, 'HeadroomDev', { env, webDist, stage: 'dev' });
// S7-D10: the judge stage. Sandbox only, its own merchant, credentials, pool and URL. Deployed only by name (`cdk deploy HeadroomReview`).
new HeadroomStack(app, 'HeadroomReview', { env, webDist, stage: 'review' });
