import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
const { command, access, result } = vi.hoisted(() => ({
  command: vi.fn(), access: { allowed: true },
  result: { error: false, data: { location: { phone: '+17577317358' }, phone: { storefrontE164: '+17577317358', aiVoiceE164: '+17577317358', transferTargetE164: '+16676606667', forwardingMode: null }, phoneAssistant: { greetingPrompt: 'Welcome to our shop', autoBookEnabled: true }, voiceNotifications: { email: 'shop@example.com', phone: '+16676606667' } } },
}));
vi.mock('@/LanguageContext', () => ({ useLanguage: () => ({ t: (key: string) => key, language: 'en' }) }));
vi.mock('@/lib/session', () => ({ useSession: () => ({ membershipId: 'current-shop' }) }));
vi.mock('@/lib/permissions', () => ({ useCan: () => access.allowed }));
vi.mock('@/lib/api', () => ({ runCommand: command }));
vi.mock('@/lib/errorMessage', () => ({ useErrorMessage: () => (error: Error) => error.message }));
vi.mock('@/features/settings/api', () => ({
  useDeskSettingsQuery: () => ({ data: result.data, isError: result.error, error: new Error('Load failed'), refetch: vi.fn() }),
  useSetupReadinessQuery: () => ({ data: { aiVoice: { state: 'on', effectiveAiAnswer: true, ready: true } }, refetch: vi.fn() }),
}));
import { VoiceRoutingSettings } from './VoiceRoutingSettings';
function mount() {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}><MemoryRouter><VoiceRoutingSettings /></MemoryRouter></QueryClientProvider>);
}
beforeEach(() => { command.mockReset(); access.allowed = true; result.error = false; command.mockResolvedValue({ result: { requestId: 'ticket-123', status: 'open' } }); });
it('shows the current mode 2 and numbers without editable live settings', () => {
  mount();
  expect(screen.getByRole('button', { name: /voiceRouteMode2/ })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByText('+1 757 731 7358')).toBeVisible();
  expect(screen.getAllByText('+1 667 660 6667').length).toBeGreaterThan(0);
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  expect(command).not.toHaveBeenCalled();
});
it('previews all three modes locally and preserves the current mode badge', () => {
  mount();
  fireEvent.click(screen.getByRole('button', { name: /voiceRouteMode3/ }));
  expect(screen.getByText('voiceRouteBusyCalls')).toBeVisible();
  expect(screen.getByText('voiceRouteNormalAnswer')).toBeVisible();
  expect(screen.getByText('voiceRoutePreviewOnly')).toBeVisible();
  expect(screen.getByRole('button', { name: /voiceRouteMode2/ })).toHaveTextContent('voiceRouteCurrentBadge');
  fireEvent.click(screen.getByRole('button', { name: /voiceRouteMode1/ }));
  expect(screen.getByText('voiceRouteAllCalls')).toBeVisible();
  expect(command).not.toHaveBeenCalled();
});
it('submits a line-specific support ticket with the current snapshot and does not alter routing', async () => {
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'voiceRouteRequestChange: voiceRouteHumanNode' }));
  const dialog = within(await screen.findByRole('dialog'));
  expect(dialog.getByRole('button', { name: 'support.submit' })).toBeDisabled();
  fireEvent.change(dialog.getByRole('textbox'), { target: { value: 'Change the human line to +12125550123 tomorrow.' } });
  fireEvent.click(dialog.getByRole('button', { name: 'support.submit' }));
  await waitFor(() => expect(screen.getByText('voiceRouteSubmitted')).toBeVisible());
  expect(command).toHaveBeenCalledTimes(1);
  expect(command).toHaveBeenCalledWith('support.submitRequest', expect.objectContaining({ category: 'technical', subject: expect.stringContaining('voiceRouteTarget_human'), description: expect.stringContaining('+1 757 731 7358') }), 'current-shop', expect.any(String));
  expect(command.mock.calls[0][1].description).toContain('+1 667 660 6667');
  expect(command.mock.calls[0][1].description).toContain('Change the human line');
  expect(screen.getByText('voiceRouteAwaiting')).toBeVisible();
});
it('includes the selected preview mode in a request while keeping current mode in the snapshot', async () => {
  mount();
  fireEvent.click(screen.getByRole('button', { name: /voiceRouteMode3/ }));
  fireEvent.click(screen.getByRole('button', { name: 'voiceRouteRequestMode' }));
  const dialog = within(await screen.findByRole('dialog'));
  expect(dialog.getByRole('combobox')).toHaveValue('3');
  fireEvent.change(dialog.getByRole('textbox'), { target: { value: 'Use our original number for busy forwarding.' } });
  fireEvent.click(dialog.getByRole('button', { name: 'support.submit' }));
  await waitFor(() => expect(command).toHaveBeenCalledTimes(1));
  expect(command.mock.calls[0][1].description).toContain('voiceRouteCurrent: voiceRouteMode2');
  expect(command.mock.calls[0][1].description).toContain('voiceRouteRequestedMode: voiceRouteMode3');
});
it('keeps the same idempotency key and draft when a failed submission is retried', async () => {
  command.mockRejectedValueOnce(new Error('Network failed'));
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'voiceRouteRequestChange: voiceRouteHumanNode' }));
  const dialog = within(await screen.findByRole('dialog'));
  fireEvent.change(dialog.getByRole('textbox'), { target: { value: 'Please update the transfer number.' } });
  fireEvent.click(dialog.getByRole('button', { name: 'support.submit' }));
  await waitFor(() => expect(dialog.getByRole('alert')).toHaveTextContent('Network failed'));
  expect(dialog.getByRole('textbox')).toHaveValue('Please update the transfer number.');
  fireEvent.click(dialog.getByRole('button', { name: 'support.submit' }));
  await waitFor(() => expect(screen.getByText('voiceRouteSubmitted')).toBeVisible());
  expect(command.mock.calls[0][3]).toBe(command.mock.calls[1][3]);
});
it('does not permit tickets without settings permission', () => {
  access.allowed = false;
  mount();
  expect(screen.getByRole('button', { name: 'voiceRouteRequestChange: voiceRouteHumanNode' })).toBeDisabled();
  expect(command).not.toHaveBeenCalled();
});
it('locks repeated clicks while a ticket is being submitted', async () => {
  let resolve!: (value: unknown) => void;
  command.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'voiceRouteRequestChange: voiceRouteHumanNode' }));
  const dialog = within(await screen.findByRole('dialog'));
  fireEvent.change(dialog.getByRole('textbox'), { target: { value: 'Update this line.' } });
  const button = dialog.getByRole('button', { name: 'support.submit' });
  fireEvent.click(button); fireEvent.click(button);
  await waitFor(() => expect(command).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(button).toBeDisabled());
  resolve({ result: { requestId: 'ticket-locked', status: 'open' } });
  await waitFor(() => expect(screen.getByText('voiceRouteSubmitted')).toBeVisible());
});
it('provides a retry state instead of editable settings when loading fails', () => {
  result.error = true;
  mount();
  expect(screen.queryByRole('button', { name: 'voiceRouteRequestChange: voiceRouteHumanNode' })).not.toBeInTheDocument();
  expect(command).not.toHaveBeenCalled();
});
