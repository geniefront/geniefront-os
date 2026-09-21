import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('@/lib/session', () => ({ usePlatformSession: () => ({ session: { user: { id: 'operator' } } }) }));
vi.mock('@/lib/api', async original => ({ ...await original<typeof import('@/lib/api')>(), platformGet: vi.fn(), platformSend: vi.fn() }));
import { ApiError, platformGet, platformSend } from '@/lib/api';
import { VoiceConfigurationPanel } from './VoiceConfigurationPanel';
const initial = { revision: 'a'.repeat(64), phoneAssistant: { greetingPrompt: 'Hello', voiceTone: 'warm', autoBookEnabled: false, afterHoursVoicemail: null }, voiceNotifications: { email: 'shop@example.com', phone: '+16676606667' } };
let container: HTMLDivElement, root: Root, client: QueryClient;
beforeEach(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.mocked(platformGet).mockReset().mockResolvedValue(structuredClone(initial));
  vi.mocked(platformSend).mockReset();
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  await act(async () => { root.render(<QueryClientProvider client={client}><VoiceConfigurationPanel locationId="store-a" /></QueryClientProvider>); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
function control(label: string) {
  const element = [...container.querySelectorAll('label')].find(e => e.textContent?.startsWith(label))?.querySelector('input,textarea,select');
  if (!element) throw new Error(`Missing ${label}`);
  return element as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
}
async function change(label: string, value: string) {
  const element = control(label);
  await act(async () => {
    const prototype = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : element.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  });
}
async function save() { await act(async () => { container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); }); }
it('edits all six fields through the operator endpoint and sends explicit null for cleared channels', async () => {
  expect(control('自动预约').value).toBe('false'); expect(control('非营业时间语音留言').value).toBe('');
  await change('开场白', 'Welcome back'); await change('语音风格', 'professional');
  await change('自动预约', 'true'); await change('非营业时间语音留言', 'false');
  await change('邮件', 'operator@example.com'); await change('短信', '');
  vi.mocked(platformSend).mockResolvedValue({ ...initial, revision: 'b'.repeat(64), phoneAssistant: { greetingPrompt: 'Welcome back', voiceTone: 'professional', autoBookEnabled: true, afterHoursVoicemail: false }, voiceNotifications: { email: 'operator@example.com', phone: null } });
  await save();
  expect(platformSend).toHaveBeenCalledWith('PUT', '/v1/platform/stores/store-a/voice-configuration', { expectedRevision: initial.revision, phoneAssistant: { greetingPrompt: 'Welcome back', voiceTone: 'professional', autoBookEnabled: true, afterHoursVoicemail: false }, voiceNotifications: { email: 'operator@example.com', phone: null } }, expect.any(String));
  expect(container.querySelector('[role="status"]')?.textContent).toContain('已保存');
});
it('keeps the draft and the same idempotency key after a network failure', async () => {
  await change('开场白', 'Retry this greeting');
  vi.mocked(platformSend).mockRejectedValueOnce(new Error('lost')).mockResolvedValue({ ...initial, phoneAssistant: { ...initial.phoneAssistant, greetingPrompt: 'Retry this greeting' } });
  await save(); expect(control('开场白').value).toBe('Retry this greeting');
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('保存失败');
  await save(); const calls = vi.mocked(platformSend).mock.calls;
  expect(calls[0]![3]).toBe(calls[1]![3]);
});
it('does not overwrite a stale operator revision and requires an explicit reload', async () => {
  await change('开场白', 'Unsaved edit');
  vi.mocked(platformSend).mockRejectedValue(new ApiError('VALIDATION_FAILED', { reason: 'stale_voice_configuration' }, 400));
  await save();
  expect(control('开场白').value).toBe('Unsaved edit');
  expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('配置已被其他人修改');
});
