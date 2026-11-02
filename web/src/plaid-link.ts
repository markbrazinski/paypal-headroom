// Plaid Link, loaded from Plaid's documented CDN URL (unversioned by Plaid's design; S02 §6.14). No react-plaid-link.
declare global { interface Window { Plaid?: { create(o: { token: string; onSuccess: (publicToken: string, metadata: any) => void; onExit: (err: any, metadata: any) => void }): { open(): void; destroy(): void } } } }

let loading: Promise<void> | null = null;
function load(): Promise<void> {
  loading ??= new Promise((ok, fail) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';
    s.onload = () => ok();
    s.onerror = () => { loading = null; fail(new Error("Couldn't load Plaid Link")); };
    document.head.appendChild(s);
  });
  return loading;
}

export type LinkResult = { kind: 'success'; publicToken: string; institutionId: string | null; institutionName: string | null } | { kind: 'exit'; error: string | null };

/** Opens Link with a server-issued token. onExit without an error is the owner closing it: a no-op for the caller. */
export async function openLink(token: string): Promise<LinkResult> {
  await load();
  return new Promise((done) => {
    const h = window.Plaid!.create({
      token,
      onSuccess: (publicToken, m) => { h.destroy(); done({ kind: 'success', publicToken, institutionId: m?.institution?.institution_id ?? null, institutionName: m?.institution?.name ?? null }); },
      onExit: (err) => { h.destroy(); done({ kind: 'exit', error: err ? (err.display_message || err.error_message || err.error_code || 'Link closed with an error') : null }); },
    });
    h.open();
  });
}
