import { useCallback, useEffect, useState } from 'react';
import { createContext, useContext } from 'react';
import type { ResponseOf } from '@headroom/contracts';
import { serverNow } from './api/client.ts';

export type Session = ResponseOf<'getSession'>;
/** `refresh`: re-read the session now (e.g. after a pause, so the banner on every route updates at once). */
export const SessionCtx = createContext<{ session: Session; changed: number; nav: (path: string) => void; toast: (t: string) => void; refresh: () => void }>(null!);
export const useApp = () => useContext(SessionCtx);

/**
 * Fetch on mount, whenever the server reports a change (session.lastChangeAt), when `reload` is called, and at the DTO's
 * server-computed `validUntil` (S2-PR-05): time-derived states (bank read aging, PayPal stale, grant ended) change with no
 * audit event. Relative ages ("4 min ago") are formatting only: a 60 s display tick re-renders them.
 */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const { changed } = useApp();
  const [state, set] = useState<{ data?: T; error?: unknown; loading: boolean }>({ loading: true });
  const [n, bump] = useState(0);
  const [, tick] = useState(0);
  useEffect(() => {
    let live = true;
    fn().then((data) => live && set({ data, loading: false }), (error) => live && set((s) => ({ ...s, error, loading: false })));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [changed, n, ...deps]);
  const until = (state.data as { validUntil?: string | null } | undefined)?.validUntil;
  useEffect(() => {
    if (!until) return;
    const t = setTimeout(() => bump((x) => x + 1), Math.max(Date.parse(until) + 1000 - serverNow(), 30_000));
    return () => clearTimeout(t);
  }, [until]);
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 60_000); return () => clearInterval(t); }, []);
  return { ...state, reload: useCallback(() => bump((x) => x + 1), []) };
}
