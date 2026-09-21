import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ send: vi.fn(), role: 'super_admin' }));
vi.mock('@/lib/session', () => ({ usePlatformSession: () => ({ operator: { role: state.role } }) }));
vi.mock('@/lib/idempotency', () => ({ useIdempotentSend: () => state.send }));
import { OwnerTransferPanel } from './OwnerTransferPanel';
let root: Root, container: HTMLDivElement, qc: QueryClient;
beforeEach(async () => {
 (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
 state.role = 'super_admin'; state.send.mockReset().mockResolvedValue({ transferred: true });
 container = document.createElement('div'); document.body.append(container); root = createRoot(container); qc = new QueryClient();
 await act(async () => root.render(<QueryClientProvider client={qc}><OwnerTransferPanel locationId="store" owners={[{ membershipId: 'old', email: 'old@example.com' }]} /></QueryClientProvider>));
});
afterEach(async () => { await act(async () => root.unmount()); qc.clear(); container.remove(); });
async function type(selector: string, value: string) {
 const element = container.querySelector(selector)!;
 const proto = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
 await act(async () => { Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })); });
}
it('requires explicit acknowledgement of retained payment details before transferring', async () => {
 await type('input[type=email]', 'new@example.com'); await type('textarea', 'Customer requested transfer');
 expect(container.querySelector('button')!.disabled).toBe(true);
 await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
 expect(state.send).not.toHaveBeenCalled();
 await act(async () => (container.querySelector('input[type=checkbox]') as HTMLInputElement).click());
 await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
 expect(state.send).toHaveBeenCalledWith('POST', '/v1/platform/stores/store/transfer-owner', { previousMembershipId: 'old', newOwnerEmail: 'new@example.com', reason: 'Customer requested transfer', acknowledgePaymentMethod: true });
 expect(container.textContent).toContain('号主已更换');
});
