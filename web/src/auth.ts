// Cognito managed login, authorization code + PKCE with Web Crypto. No Amplify.
// /config.json exists only in deployed stages; without it the SPA talks to the local server (STAGE=local identity).
export interface AuthConfig { domain: string; clientId: string }

let config: AuthConfig | null = null;
const KEY = 'hr.idToken';
const VERIFIER = 'hr.pkce';
const REFRESH = 'hr.refresh';

const b64url = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const redirectUri = () => `${location.origin}/`;

export async function initAuth(): Promise<'local' | 'signed-in' | 'redirecting'> {
  const golden = (await import('./api/golden.ts')).goldenOn();
  if (golden && !token() && !sessionStorage.getItem(REFRESH)) return 'local'; // golden: the ?demo=1 replay needs no sign-in
  const r = await fetch('/config.json').catch(() => null);
  if (!r || !r.ok || !(r.headers.get('content-type') ?? '').includes('json')) return 'local';
  config = await r.json();
  const code = new URLSearchParams(location.search).get('code');
  if (code) {
    const res = await fetch(`https://${config!.domain}/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: config!.clientId, code, redirect_uri: redirectUri(), code_verifier: sessionStorage.getItem(VERIFIER) ?? '' }),
    });
    const t = await res.json();
    if (t.id_token) sessionStorage.setItem(KEY, t.id_token);
    if (t.refresh_token) sessionStorage.setItem(REFRESH, t.refresh_token);
    history.replaceState(null, '', sessionStorage.getItem('hr.return') ?? '/overview');
  }
  await freshToken();
  // Judge dock (owner, 4 Nov 2026): a judge lands in the recorded run unless they chose Live in this tab.
  if (token() && groups().includes('judge') && !sessionStorage.getItem('hr.mode') && sessionStorage.getItem('hr.golden') === null) sessionStorage.setItem('hr.golden', '0');
  if (token()) return 'signed-in';
  if (golden) return 'local'; // the sign-in lapsed mid-replay: the recording plays on; Live asks for sign-in again
  await signIn();
  return 'redirecting';
}

export async function signIn() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  sessionStorage.setItem(VERIFIER, verifier);
  sessionStorage.setItem('hr.return', location.pathname === '/' ? '/overview' : location.pathname);
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const q = new URLSearchParams({ response_type: 'code', client_id: config!.clientId, redirect_uri: redirectUri(), scope: 'openid email', code_challenge_method: 'S256', code_challenge: challenge });
  location.assign(`https://${config!.domain}/oauth2/authorize?${q}`);
}

const expMs = (t: string) => { try { return JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).exp * 1000; } catch { return 0; } };
export function token(): string | null {
  const t = sessionStorage.getItem(KEY);
  return t && expMs(t) >= Date.now() + 30_000 ? t : null;
}

/** The id token lasts an hour; within 5 minutes of that, renew it silently with the refresh token (30 days), so nobody signs in again. */
let renewing: Promise<string | null> | null = null;
export async function freshToken(): Promise<string | null> {
  const t = sessionStorage.getItem(KEY), rt = sessionStorage.getItem(REFRESH);
  if ((t && expMs(t) > Date.now() + 5 * 60_000) || !rt || !config) return token();
  renewing ??= fetch(`https://${config.domain}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: config.clientId, refresh_token: rt }),
  }).then((r) => r.json()).then((j) => { if (j.id_token) sessionStorage.setItem(KEY, j.id_token); else sessionStorage.removeItem(REFRESH); return token(); }, () => token())
    .finally(() => { renewing = null; });
  return renewing;
}

export function signOut() {
  sessionStorage.removeItem(KEY); sessionStorage.removeItem(REFRESH);
  if (!config) { location.reload(); return; }
  location.assign(`https://${config.domain}/logout?${new URLSearchParams({ client_id: config.clientId, logout_uri: redirectUri() })}`);
}

export const isLocal = () => config === null;
/** The signed-in user's email (the recorded run's session carries the recording's owner, not who is signed in). */
export function signedInEmail(): string | null {
  const t = token();
  try { return t ? JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).email ?? null : null; } catch { return null; }
}
/** The signed-in user's Cognito groups (display only; the server takes the role from the verified claim). */
export function groups(): string[] {
  const t = token();
  try { return t ? JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))['cognito:groups'] ?? [] : []; } catch { return []; }
}
