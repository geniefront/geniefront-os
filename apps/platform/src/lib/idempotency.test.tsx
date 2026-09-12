import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { platformSend } from './api';
import { useIdempotentSend } from './idempotency';
vi.mock('./api', () => ({ platformSend: vi.fn() }));
vi.mock('./session', () => ({ usePlatformSession: () => ({ session: { user: { id: 'operator-A' } } }) }));
it('keeps the original intent key after a lost response and resets only that intent on success', async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  let send!: ReturnType<typeof useIdempotentSend>;
  function Probe() { send = useIdempotentSend(); return null; }
  const container = document.createElement('div'); const root = createRoot(container);
  await act(async () => root.render(<Probe />));
  vi.mocked(platformSend).mockRejectedValueOnce(new Error('lost')).mockRejectedValueOnce(new Error('lost')).mockResolvedValue({ ok: true });
  await send('POST', '/store-A/license/apply', { amount: 500 }).catch(() => {});
  await send('POST', '/store-B/license/apply', { amount: 500 }).catch(() => {});
  await send('POST', '/store-A/license/apply', { amount: 500 });
  await send('POST', '/store-A/license/apply', { amount: 500 });
  const calls = vi.mocked(platformSend).mock.calls;
  expect(calls[0]![3]).toBeTruthy();
  expect(calls[0]![3]).toBe(calls[2]![3]);
  expect(calls[1]![3]).not.toBe(calls[0]![3]);
  expect(calls[3]![3]).not.toBe(calls[0]![3]);
  await act(async () => root.unmount());
});
