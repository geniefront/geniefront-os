import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useCallAudio } from './useCallAudio';
class FakeAudio {
  static instances: FakeAudio[] = [];
  paused = true; currentTime = 0; duration = 14; playbackRate = 1;
  ontimeupdate: (() => void) | null = null; onloadedmetadata: (() => void) | null = null;
  onended: (() => void) | null = null; onerror: (() => void) | null = null;
  pause = vi.fn(() => { this.paused = true; });
  play = vi.fn(async () => { this.paused = false; });
  load = vi.fn(); removeAttribute = vi.fn();
  constructor(public src: string) { FakeAudio.instances.push(this); }
}
const call = (id: string) => ({ callId: id, recordingId: id, recordingUrl: null });
function setup(resolve = vi.fn(async () => 'https://example.com/audio.mp3')) {
  FakeAudio.instances = []; vi.stubGlobal('Audio', FakeAudio);
  const onError = vi.fn();
  return { ...renderHook(({ id }) => useCallAudio(id, resolve, onError), { initialProps: { id: 'a' as string | null } }), onError };
}
afterEach(() => vi.unstubAllGlobals());
it('switching recordings clears position, duration and speed and ignores old audio callbacks', async () => {
  const h = setup();
  await act(async () => { await h.result.current.toggle(call('a')); });
  const a = FakeAudio.instances[0]!;
  act(() => { a.currentTime = 9; a.ontimeupdate?.(); h.result.current.changeSpeed(2); });
  expect(h.result.current.currentTime).toBe(9);
  const staleUpdate = a.ontimeupdate;
  h.rerender({ id: 'b' });
  expect(a.pause).toHaveBeenCalled();
  expect(h.result.current).toMatchObject({ currentTime: 0, duration: 0, speed: 1, playingCallId: null });
  act(() => staleUpdate?.());
  expect(h.result.current.currentTime).toBe(0);
  await act(async () => { await h.result.current.toggle(call('b')); });
  expect(FakeAudio.instances[1]!.playbackRate).toBe(1);
  h.unmount(); expect(FakeAudio.instances[1]!.pause).toHaveBeenCalled();
});
it('pause and resume keep the same recording and position', async () => {
  const h = setup();
  await act(async () => { await h.result.current.toggle(call('a')); });
  act(() => h.result.current.seek(6));
  await act(async () => { await h.result.current.toggle(call('a')); });
  expect(h.result.current.playingCallId).toBeNull();
  await act(async () => { await h.result.current.toggle(call('a')); });
  expect(FakeAudio.instances).toHaveLength(1);
  expect(FakeAudio.instances[0]!.currentTime).toBe(6);
  expect(h.result.current.playingCallId).toBe('a');
  h.unmount();
});
it('closing during URL fetch prevents delayed playback', async () => {
  let finish!: (value: string) => void;
  const h = setup(vi.fn(() => new Promise<string>(r => { finish = r; })));
  let pending!: Promise<void>;
  act(() => { pending = h.result.current.toggle(call('a')); });
  h.rerender({ id: null });
  await act(async () => { finish('https://example.com/old.mp3'); await pending; });
  expect(FakeAudio.instances).toHaveLength(0);
  expect(h.result.current.playingCallId).toBeNull();
  expect(h.onError).not.toHaveBeenCalled();
  h.unmount();
});
