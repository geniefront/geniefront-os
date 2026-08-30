import {
  createContext, useCallback, useContext, useEffect, useMemo, useState,
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

  useEffect(() => {
    setUnauthenticatedHandler(() => {
      setSession(null);
      setOperator(null);
      setStatus('unauthenticated');
    });
    return () => setUnauthenticatedHandler(null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function resolve(next: Session | null) {
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
        const res = await platformGet<OperatorSession>('/v1/platform/session');
        if (cancelled) return;
        setOperator(res.operator);
        setError(null);
        setStatus('ready');
      } catch (e) {
        if (cancelled) return;
        const statusCode = e && typeof e === 'object' && 'status' in e ? Number(e.status) : 0;
        if (statusCode === 401) {
          setOperator(null);
          setStatus('unauthenticated');
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

    void supabase.auth.getSession().then(({ data }) => resolve(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      void resolve(next);
    });
    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, [nonce]);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
    setOperator(null);
    setSession(null);
    setStatus('unauthenticated');
  }, []);

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
