import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useLanguage } from '@/LanguageContext';

type Save = () => Promise<boolean>;
const Context = createContext<{ register: (save: Save) => () => void; flush: Save } | null>(null);
export function SetupSaveProvider({ children }: { children: ReactNode }) {
  const saves = useRef(new Set<Save>());
  const register = useCallback((save: Save) => { saves.current.add(save); return () => { saves.current.delete(save); }; }, []);
  const flush = useCallback(async () => {
    for (const save of saves.current) if (!await save()) return false;
    return true;
  }, []);
  return <Context.Provider value={{ register, flush }}>{children}</Context.Provider>;
}
export const useSetupSave = () => useContext(Context);

/** Serialize writes, preserve edits during refetch, and flush before changing steps. */
export function useSetupDraft<T>(server: T | null, save: (value: T) => Promise<unknown>) {
  const [value, setValue] = useState<T | null>(server);
  const current = useRef(server);
  const persisted = useRef(JSON.stringify(server));
  const running = useRef<Promise<boolean> | null>(null);
  const saveRef = useRef(save); saveRef.current = save;
  const [state, setState] = useState<'saved' | 'pending' | 'saving' | 'error'>('saved');
  const [error, setError] = useState('');
  const context = useSetupSave();
  const serverKey = JSON.stringify(server);
  useEffect(() => {
    if (server === null || running.current || JSON.stringify(current.current) !== persisted.current) return;
    current.current = server; persisted.current = serverKey; setValue(server);
  }, [serverKey]);
  const set = useCallback((next: T | ((old: T) => T)) => {
    if (current.current === null) return;
    current.current = typeof next === 'function' ? (next as (old: T) => T)(current.current) : next;
    setValue(current.current); setState('pending'); setError('');
  }, []);
  const flush = useCallback(async (): Promise<boolean> => {
    if (running.current) return running.current;
    const work = async () => {
      while (current.current !== null && JSON.stringify(current.current) !== persisted.current) {
        const snapshot = current.current;
        setState('saving');
        try { await saveRef.current(snapshot); persisted.current = JSON.stringify(snapshot); }
        catch (e) { setError(e instanceof Error ? e.message : String(e)); setState('error'); return false; }
      }
      setState('saved'); return true;
    };
    running.current = work();
    try { return await running.current; } finally { running.current = null; }
  }, []);
  useEffect(() => context?.register(flush), [context?.register, flush]);
  useEffect(() => {
    if (state !== 'pending') return;
    const timer = window.setTimeout(() => { void flush(); }, 700);
    return () => window.clearTimeout(timer);
  }, [value, state, flush]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (JSON.stringify(current.current) !== persisted.current) { e.preventDefault(); e.returnValue = ''; }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);
  return { value, set, flush, state, error };
}
export function SaveStatus({ state, error, flush }: { state: string; error: string; flush: Save }) {
  const { t } = useLanguage();
  return <div role={state === 'error' ? 'alert' : 'status'} className={`text-sm ${state === 'error' ? 'text-red-700' : 'text-slate-500'}`}>
    {state === 'error' ? <>{t('setupAutoSaveError')} <button type="button" className="underline" onClick={() => void flush()}>{t('setupRetry')}</button><span className="block text-xs">{error}</span></> : t(state === 'saved' ? 'setupAutoSaved' : 'setupAutoSaving')}
  </div>;
}
