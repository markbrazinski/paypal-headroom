// Emits contracts/openapi/api.yaml from the route table. `--check` exits 1 if the committed file is stale.
// ponytail: the output is JSON, which is valid YAML 1.2; no YAML library needed.
import { readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { ContractError, routes } from '../src/index.ts';

export function buildOpenApi(): string {
  const paths: Record<string, Record<string, unknown>> = {};
  const errorSchema = z.toJSONSchema(ContractError);
  for (const [operationId, r] of Object.entries(routes)) {
    const params = [...r.path.matchAll(/\{(\w+)\}/g)].map((m) => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } }));
    if (r.command) params.push({ name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string' } });
    if (r.ifMatch) params.push({ name: 'If-Match', in: 'header', required: true, schema: { type: 'string' } });
    if ('query' in r) for (const [name, schema] of Object.entries((z.toJSONSchema(r.query, { io: 'input' }) as { properties: Record<string, unknown> }).properties)) params.push({ name, in: 'query', required: false, schema: schema as never });
    paths[r.path] ??= {};
    paths[r.path][r.method.toLowerCase()] = {
      operationId,
      summary: r.summary,
      security: r.auth === 'jwt' ? [{ cognito: [] }] : [],
      parameters: params,
      ...('body' in r ? { requestBody: { required: true, content: { 'application/json': { schema: z.toJSONSchema(r.body) } } } } : {}),
      responses: {
        [r.status]: { description: 'OK', content: { 'application/json': { schema: z.toJSONSchema(r.response) } } },
        ...(r.errors.length ? { default: { description: `Errors: ${r.errors.join(', ')}`, content: { 'application/json': { schema: errorSchema } } } } : {}),
      },
    };
  }
  const doc = {
    openapi: '3.1.0',
    info: { title: 'Headroom API (S4)', version: '0.4.0', description: 'Generated from contracts/src/api.ts. Do not edit by hand.' },
    components: { securitySchemes: { cognito: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } } },
    paths,
  };
  return JSON.stringify(doc, null, 2) + '\n';
}

const target = new URL('../openapi/api.yaml', import.meta.url);
if (import.meta.main) {
  const out = buildOpenApi();
  if (process.argv.includes('--check')) {
    const current = readFileSync(target, 'utf8');
    if (current !== out) { console.error('contracts/openapi/api.yaml is stale: run npm run openapi'); process.exit(1); }
  } else writeFileSync(target, out);
}
