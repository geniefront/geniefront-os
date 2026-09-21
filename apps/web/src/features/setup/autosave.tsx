import { UNSAFE_NavigationContext } from 'react-router-dom';
import { toast } from '@heroui/react';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useLanguage } from '@/LanguageContext';

type Save = () => Promise<boolean>;
const Context = createContext<{ register: (save: Save) => () => void; flush: Save } | null>(null);
export function SetupSaveProvider({ children }: { children: ReactNode }) {
  const saves = useRef(new Set<Save>());
  const navigation = useContext(UNSAFE_NavigationContext);
  const register = useCallback((save: Save) => { saves.current.add(save); return () => { saves.current.delete(save); }; }, []);
  const flush = useCallback(async () => {
    for (const save of saves.current) if (!await save()) return false;
    return true;
  }, []);
  useEffect(() => {
    if (!navigation?.navigator) return;
    const navigator = navigation.navigator;
    const push = navigator.push.bind(navigator), replace = navigator.replace.bind(navigator);
    let pending = false;
    const run = async (action: () => void) => {
      if (pending) return;
      pending = true;
      try { if (await flush()) action(); } finally { pending = false; }
    };
    navigator.push = (...args) => { void run(() => { push(...args); currentIndex = window.history.state?.idx ?? currentIndex; }); };
    navigator.replace = (...args) => { void run(() => { replace(...args); currentIndex = window.history.state?.idx ?? currentIndex; }); };
    let currentIndex = window.history.state?.idx ?? 0;
    let restore: (() => void) | null = null;
    let allowNext = false;
    const onPop = (event: PopStateEvent) => {
      if (allowNext) { allowNext = false; currentIndex = event.state?.idx ?? currentIndex; return; }
      event.stopImmediatePropagation();
      if (restore) { const resumed = restore; restore = null; resumed(); return; }
      const nextIndex = event.state?.idx;
      if (typeof nextIndex !== 'number' || nextIndex === currentIndex) return;
      const delta = nextIndex - currentIndex;
      restore = () => { void run(() => { allowNext = true; window.history.go(delta); }); };
      window.history.go(-delta);
    };
    window.addEventListener('popstate', onPop, true);
    return () => { navigator.push = push; navigator.replace = replace; window.removeEventListener('popstate', onPop, true); };
  }, [navigation?.navigator, flush]);
  return <Context.Provider value={{ register, flush }}>{children}</Context.Provider>;
}
export const useSetupSave = () => useContext(Context);

/** Serialize writes, preserve edits during refetch, and flush before changing steps. */
export function useSetupDraft<T>(server: T | null, save: (value: T) => Promise<unknown>, storageKey?: string) {
  const [value, setValue] = useState<T | null>(server);
  const current = useRef(server);
  const persisted = useRef(JSON.stringify(server));
  const running = useRef<Promise<boolean> | null>(null);
  const saveRef = useRef(save); saveRef.current = save;
  const [state, setState] = useState<'saved' | 'pending' | 'saving' | 'error'>('saved');
  const [error, setError] = useState('');
  const conflict = useRef(false);
  const restored = useRef<string | null>(null);
  const context = useSetupSave();
  const serverKey = JSON.stringify(server);
  useEffect(() => {
    if (!storageKey || server === null || restored.current === storageKey) return;
    restored.current = storageKey;
    try {
      const raw = sessionStorage.getItem(storageKey);
      if (!raw) return;
      const cached = JSON.parse(raw) as { value: T; base: string };
      current.current = cached.value; persisted.current = cached.base; setValue(cached.value);
      conflict.current = cached.base !== serverKey;
      setState(conflict.current ? 'error' : 'pending');
      if (conflict.current) setError('This setting changed elsewhere. Discard the saved draft and reload the current value.');
    } catch { /* An unavailable cache must not prevent editing. */ }
  }, [storageKey, serverKey]);
  useEffect(() => {
    if (server === null || running.current || JSON.stringify(current.current) !== persisted.current) return;
    current.current = server; persisted.current = serverKey; setValue(server);
  }, [serverKey]);
  const set = useCallback((next: T | ((old: T) => T)) => {
    if (current.current === null) return;
    current.current = typeof next === 'function' ? (next as (old: T) => T)(current.current) : next;
    setValue(current.current); setState(conflict.current ? 'error' : 'pending');
    if (!conflict.current) setError('');
    if (storageKey) { try { sessionStorage.setItem(storageKey, JSON.stringify({ value: current.current, base: persisted.current })); } catch {} }
  }, [storageKey]);
  const flush = useCallback(async (): Promise<boolean> => {
    if (conflict.current) return false;
    if (running.current) return running.current;
    const work = async () => {
      while (current.current !== null && JSON.stringify(current.current) !== persisted.current) {
        const snapshot = current.current;
        setState('saving');
        try {
          await saveRef.current(snapshot); persisted.current = JSON.stringify(snapshot);
          if (storageKey) { try {
            if (JSON.stringify(current.current) === persisted.current) sessionStorage.removeItem(storageKey);
            else sessionStorage.setItem(storageKey, JSON.stringify({ value: current.current, base: persisted.current }));
          } catch {} }
        }
        catch (e) { setError(e instanceof Error ? e.message : String(e)); setState('error'); return false; }
      }
      setState('saved'); return true;
    };
    running.current = work();
    try { return await running.current; } finally { running.current = null; }
  }, [storageKey]);
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
  const discard = () => {
    conflict.current = false; current.current = server; persisted.current = serverKey;
    setValue(server); setState('saved'); setError('');
    if (storageKey) sessionStorage.removeItem(storageKey);
  };
  return { value, set, flush, state, error, discard };
}
export function SaveStatus({ state, error, flush, discard }: { state: string; error: string; flush: Save; discard?: () => void }) {
  const { t } = useLanguage();
  return <div role={state === 'error' ? 'alert' : 'status'} className={`text-sm ${state === 'error' ? 'text-red-700' : 'text-slate-500'}`}>
    {state === 'error' ? <>{t('setupAutoSaveError')} <button type="button" className="underline" onClick={() => void flush()}>{t('setupRetry')}</button>{discard && <button type="button" className="ml-3 underline" onClick={discard}>{t('setupDiscardDraft')}</button>}<span className="block text-xs">{error}</span></> : t(state === 'saved' ? 'setupAutoSaved' : 'setupAutoSaving')}
  </div>;
}

/** New records use an explicit Add button; do not silently discard unfinished input. */
export function useSetupNewRecordGuard(dirty: boolean) {
  const context = useSetupSave();
  const { t } = useLanguage();
  const latest = useRef(dirty); latest.current = dirty;
  const message = useRef(t('setupNewRecordUnsaved')); message.current = t('setupNewRecordUnsaved');
  useEffect(() => context?.register(async () => {
    if (!latest.current) return true;
    toast.danger(message.current); return false;
  }), [context?.register]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (latest.current) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);
}
