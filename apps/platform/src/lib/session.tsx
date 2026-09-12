import { useQueryClient } from '@tanstack/react-query';
import {
  createContext, useCallback, useContext, useEffect, useMemo, useState, useRef,
  type ReactNode,
} from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './supabase';
import {
  platformGet, setUnauthenticatedHandler,
  type OperatorSession,
} from './api';

export type PlatformStatus =
  | 'loading'
  | 'unauthenticated'
  | 'denied'
  | 'ready'
  | 'error';

interface PlatformSessionValue {
  status: PlatformStatus;
  session: Session | null;
  operator: OperatorSession['operator'] | null;
  error: string | null;
  signOut: () => Promise<void>;
  retry: () => void;
}

const Ctx = createContext<PlatformSessionValue | undefined>(undefined);

export function PlatformSessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<PlatformStatus>('loading');
  const [session, setSession] = useState<Session | null>(null);
  const [operator, setOperator] = useState<OperatorSession['operator'] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const generation = useRef(0);
  const userId = useRef<string | null>(null);
  const queryClient = useQueryClient();
  const clearSession = useCallback(() => {
    generation.current++;
    userId.current = null;
    queryClient.clear();
    setSession(null);
    setOperator(null);
    setError(null);
    setStatus('unauthenticated');
  }, [queryClient]);

  useEffect(() => {
    setUnauthenticatedHandler(clearSession);
    return () => setUnauthenticatedHandler(null);
  }, [clearSession]);

  useEffect(() => {
    let cancelled = false;
    async function resolve(next: Session | null) {
      if (cancelled) return;
      const request = ++generation.current;
      if (userId.current !== (next?.user.id ?? null)) queryClient.clear();
      userId.current = next?.user.id ?? null;
      setOperator(null);
      setError(null);
      if (!next) {
        if (!cancelled) {
          setSession(null);
          setOperator(null);
          setStatus('unauthenticated');
        }
        return;
      }
      setSession(next);
      setStatus('loading');
      try {
        const res = await platformGet<OperatorSession>('/v1/platform/session', next.access_token);
        if (cancelled || request !== generation.current) return;
        setOperator(res.operator);
        setError(null);
        setStatus('ready');
      } catch (e) {
        if (cancelled || request !== generation.current) return;
        const statusCode = e && typeof e === 'object' && 'status' in e ? Number(e.status) : 0;
        if (statusCode === 401) {
          clearSession();
          return;
        }
        if (statusCode === 403) {
          setOperator(null);
          setStatus('denied');
          return;
        }
        setError(e instanceof Error ? e.message : 'session_failed');
        setStatus('error');
      }
    }

    const initial = generation.current;
    void supabase.auth.getSession().then(({ data }) => {
      if (!cancelled && initial === generation.current) void resolve(data.session);
    }).catch(e => {
      if (!cancelled && initial === generation.current) {
        setError(e instanceof Error ? e.message : 'session_failed');
        setStatus('error');
      }
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      void resolve(next);
    });
    return () => {
      cancelled = true;
      generation.current++;
      sub.subscription.unsubscribe();
    };
  }, [nonce, queryClient, clearSession]);

  const signOut = useCallback(async () => {
    clearSession();
    await supabase.auth.signOut();
  }, [clearSession]);

  const value = useMemo<PlatformSessionValue>(() => ({
    status,
    session,
    operator,
    error,
    signOut,
    retry: () => setNonce((n) => n + 1),
  }), [status, session, operator, error, signOut]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePlatformSession(): PlatformSessionValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('PlatformSessionProvider required');
  return v;
}
