import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
const api = vi.hoisted(() => ({ apiPost: vi.fn(), runCommand: vi.fn() }));
vi.mock('@/lib/api', () => ({ ...api, apiGet: vi.fn() }));
vi.mock('@/lib/session', () => ({ useSession: () => ({ membershipId: 'owner' }) }));
import { useSaveService } from './api';
const names = { en: 'Full body', 'zh-Hans': '全身', 'zh-Hant': '全身', ko: '전신', vi: 'Toàn thân', es: 'Corporal' };
const input = { name: { en: 'Full body Massage 60 Min' }, durationMin: 60, basePriceCents: 6000 };
function mount() {
 const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
 return renderHook(() => useSaveService(), { wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> });
}
beforeEach(() => { vi.clearAllMocks(); api.apiPost.mockResolvedValue({ shortNames: names }); api.runCommand.mockResolvedValue({ result: { serviceId: 'created' } }); });
it('fills six short names before saving a new service', async () => {
 const { result } = mount();
 await act(async () => { await result.current.mutateAsync(input); });
 expect(api.apiPost).toHaveBeenCalledWith('/v1/desk/services/short-names/generate', { name: input.name, shortNames: {} }, { membershipId: 'owner' });
 expect(api.runCommand).toHaveBeenCalledWith('catalog.saveService', { ...input, shortNames: names }, 'owner');
});
it('preserves manual names and does not create a nameless service when generation fails', async () => {
 api.apiPost.mockRejectedValue(new Error('Unavailable'));
 const { result } = mount();
 await act(async () => { await expect(result.current.mutateAsync({ ...input, shortNames: { 'zh-Hans': '手填' } })).rejects.toThrow(); });
 expect(api.apiPost.mock.calls[0]?.[1].shortNames).toEqual({ 'zh-Hans': '手填' });
 expect(api.runCommand).not.toHaveBeenCalled();
});
it('does not regenerate complete names or existing services', async () => {
 const { result } = mount();
 await act(async () => { await result.current.mutateAsync({ ...input, shortNames: names }); });
 await act(async () => { await result.current.mutateAsync({ ...input, serviceId: 'existing' }); });
 expect(api.apiPost).not.toHaveBeenCalled();
});
