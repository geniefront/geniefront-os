import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ApiError, book, getHostedShop, getServices, setPublicKey } from './api';

const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal('fetch', fetchMock); fetchMock.mockReset(); setPublicKey('public-key');
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const ok = () => new Response(JSON.stringify({ name: 'Test shop' }), { status: 200 });

it('recovers a read after a gateway HTML 503 with bounded backoff', async () => {
  fetchMock.mockResolvedValueOnce(new Response('Service Unavailable', { status: 503 })).mockResolvedValueOnce(ok());
  const request = getHostedShop('test');
  await vi.advanceTimersByTimeAsync(499);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(await request).toMatchObject({ name: 'Test shop' });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

it('does not add a JSON content-type to bodyless GETs', async () => {
  setPublicKey(''); fetchMock.mockResolvedValueOnce(ok());
  await getHostedShop('test');
  expect(fetchMock.mock.calls[0]![1]!.headers).toEqual({});
});

it.each([400, 401, 403, 404, 409, 429])('does not retry a %i read error', async status => {
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ code: 'REJECTED' }), { status }));
  await expect(getServices()).rejects.toMatchObject({ status, code: 'REJECTED' });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('aborts hung reads and stops after three attempts', async () => {
  fetchMock.mockImplementation((_url, options) => new Promise((_resolve, reject) => {
    options?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
  }));
  const result = getServices().catch(error => error);
  await vi.advanceTimersByTimeAsync(17_000);
  expect(await result).toMatchObject({ code: 'TIMEOUT', status: 0 });
  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(fetchMock.mock.calls.every(([, options]) => options?.signal?.aborted)).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it('also bounds a response whose body stalls after headers', async () => {
  fetchMock.mockImplementation((_url, options) => Promise.resolve({
    ok: true, status: 200,
    json: () => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }),
  } as Response));
  const result = getServices().catch(error => error);
  await vi.advanceTimersByTimeAsync(17_000);
  expect(await result).toMatchObject({ code: 'TIMEOUT' });
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

it('retries malformed successful responses rather than rendering missing data', async () => {
  fetchMock.mockResolvedValueOnce(new Response('<html>Gateway</html>')).mockResolvedValueOnce(ok());
  const result = getServices();
  await vi.advanceTimersByTimeAsync(500);
  expect(await result).toMatchObject({ name: 'Test shop' });
});

it.each(['network', '503'])('never automatically replays a booking after %s failure', async failure => {
  if (failure === 'network') fetchMock.mockRejectedValue(new TypeError('Network error'));
  else fetchMock.mockResolvedValue(new Response('Unavailable', { status: 503 }));
  await expect(book({ partySize: 1 } as any, 'original-idempotency-key')).rejects.toBeInstanceOf(ApiError);
  await vi.runAllTimersAsync();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0]![1]!.headers).toMatchObject({ 'Idempotency-Key': 'original-idempotency-key' });
});
