import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SetupSaveProvider, useSetupDraft, useSetupSave } from './autosave';

describe('setup autosave', () => {
  it('keeps new edits through an in-flight save and stale refetch, then serializes the newest value', async () => {
    let release!: () => void;
    const save = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; })).mockResolvedValue(undefined);
    const { result, rerender } = renderHook(({ server }) => useSetupDraft(server, save), { initialProps: { server: { name: 'original' } } });
    act(() => result.current.set({ name: 'first' }));
    let pending!: Promise<boolean>;
    act(() => { pending = result.current.flush(); });
    act(() => result.current.set({ name: 'second' }));
    rerender({ server: { name: 'first' } });
    expect(result.current.value?.name).toBe('second');
    await act(async () => { release(); await pending; });
    expect(save.mock.calls.map(call => call[0].name)).toEqual(['first', 'second']);
    expect(result.current.state).toBe('saved');
  });
  it('blocks step navigation after failure and retries without losing the draft', async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error('network')).mockResolvedValue(undefined);
    const { result } = renderHook(() => ({ draft: useSetupDraft({ name: 'original' }, save), navigation: useSetupSave() }), { wrapper: SetupSaveProvider });
    act(() => result.current.draft.set({ name: 'edited' }));
    let ok = true;
    await act(async () => { ok = await result.current.navigation!.flush(); });
    expect(ok).toBe(false);
    expect(result.current.draft.value?.name).toBe('edited');
    await act(async () => { ok = await result.current.navigation!.flush(); });
    expect(ok).toBe(true);
    expect(save).toHaveBeenCalledTimes(2);
  });
  it('does not write unchanged data and accepts an externally imported update', async () => {
    const save = vi.fn();
    const { result, rerender } = renderHook(({ server }) => useSetupDraft(server, save), { initialProps: { server: { name: 'before' } } });
    await act(async () => { await result.current.flush(); });
    expect(save).not.toHaveBeenCalled();
    rerender({ server: { name: 'imported' } });
    expect(result.current.value?.name).toBe('imported');
  });
});
