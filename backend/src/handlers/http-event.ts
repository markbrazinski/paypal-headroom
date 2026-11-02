// API Gateway HTTP API (payload v2) ↔ router Req/Res.
import type { Req, Res } from './router.ts';

export interface HttpEvent {
  rawPath: string;
  rawQueryString?: string;
  requestContext: { http: { method: string }; authorizer?: { jwt?: { claims?: Record<string, string> } } };
  headers?: Record<string, string>;
  body?: string;
  isBase64Encoded?: boolean;
}

export function toReq(e: HttpEvent, withIdentity: boolean): Req {
  const claims = e.requestContext.authorizer?.jwt?.claims;
  const headers = Object.fromEntries(Object.entries(e.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    method: e.requestContext.http.method,
    path: e.rawPath,
    query: Object.fromEntries(new URLSearchParams(e.rawQueryString ?? '')),
    headers,
    body: e.body === undefined ? undefined : e.isBase64Encoded ? Buffer.from(e.body, 'base64').toString('utf8') : e.body,
    identity: withIdentity && claims?.sub ? { sub: claims.sub, email: claims.email ?? claims['cognito:username'] ?? '', role: roleOf(claims['cognito:groups']) } : null,
  };
}

/**
 * S7-D11: the role comes only from the JWT authorizer's verified `cognito:groups` claim (HTTP API passes it as "[operator]" or
 * "[judge operator]"); no header or body can set it. No group = the business owner.
 */
export function roleOf(groups: string | undefined): 'OWNER' | 'JUDGE' | 'OPERATOR' {
  const g = (groups ?? '').replace(/[[\]"]/g, '').split(/[\s,]+/).filter(Boolean);
  return g.includes('operator') ? 'OPERATOR' : g.includes('judge') ? 'JUDGE' : 'OWNER';
}

export const toResult = (r: Res) => ({ statusCode: r.status, headers: r.headers, body: r.body });
