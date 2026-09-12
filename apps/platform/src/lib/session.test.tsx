import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PlatformSessionProvider, usePlatformSession } from './session';
import { platformGet } from './api';
const auth = vi.hoisted(() => ({ getSession: vi.fn(), onAuthStateChange: vi.fn(), signOut: vi.fn() }));
vi.mock('./supabase', () => ({ supabase: { auth } }));
vi.mock('./api', () => ({ platformGet: vi.fn(), setUnauthenticatedHandler: vi.fn() }));
let emit: (event: string, session: any) => void;
let value: ReturnType<typeof usePlatformSession>;
let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
const session = (id: string) => ({ user: { id }, access_token: id });
const deferred = () => { let resolve!: (value: any) => void; const promise = new Promise<any>(r => { resolve = r; }); return { promise, resolve }; };
function Probe() { value = usePlatformSession(); return null; }
beforeEach(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  auth.getSession.mockResolvedValue({ data: { session: null } });
  auth.onAuthStateChange.mockImplementation(callback => { emit = callback; return { data: { subscription: { unsubscribe: vi.fn() } } }; });
  auth.signOut.mockResolvedValue({ error: null });
  container = document.createElement('div'); document.body.append(container);
  root = createRoot(container); client = new QueryClient();
  await act(async () => root.render(<QueryClientProvider client={client}><PlatformSessionProvider><Probe /></PlatformSessionProvider></QueryClientProvider>));
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
it('ignores old identity responses after logout and clears cached data', async () => {
  const old = deferred(); vi.mocked(platformGet).mockReturnValueOnce(old.promise);
  await act(async () => emit('SIGNED_IN', session('old')));
  client.setQueryData(['private'], { secret: true });
  await act(async () => emit('SIGNED_OUT', null));
  await act(async () => old.resolve({ operator: { userId: 'old', operatorId: 'old', role: 'super_admin' } }));
  expect(value.status).toBe('unauthenticated'); expect(value.session).toBeNull(); expect(value.operator).toBeNull();
  expect(client.getQueryData(['private'])).toBeUndefined();
});
it('accepts only the newest identity and uses its exact access token', async () => {
  const old = deferred(); const next = deferred();
  vi.mocked(platformGet).mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
  await act(async () => emit('SIGNED_IN', session('old')));
  await act(async () => emit('SIGNED_IN', session('new')));
  await act(async () => next.resolve({ operator: { userId: 'new', operatorId: 'new' } }));
  await act(async () => old.resolve({ operator: { userId: 'old', operatorId: 'old' } }));
  expect(value.status).toBe('ready'); expect(value.operator?.userId).toBe('new');
  expect(platformGet).toHaveBeenLastCalledWith('/v1/platform/session', 'new');
});
it('invalidates in-flight checks immediately when signOut starts', async () => {
  const old = deferred(); vi.mocked(platformGet).mockReturnValueOnce(old.promise);
  await act(async () => emit('SIGNED_IN', session('old')));
  await act(async () => value.signOut());
  await act(async () => old.resolve({ operator: { userId: 'old' } }));
  expect(value.status).toBe('unauthenticated');
});
