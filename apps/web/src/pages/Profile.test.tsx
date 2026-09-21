import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { expect, it, vi } from 'vitest';
import { LanguageProvider } from '@/LanguageContext';
const { save, profile } = vi.hoisted(() => ({
  save: vi.fn().mockResolvedValue({}),
  profile: { fullName: 'Original name', nickname: 'Amy', phone: '', bio: '', timezone: 'America/New_York' },
}));
vi.mock('@/features/billing/useEntitlements', () => ({ useEntitlements: () => ({ data: { plan: 'voice_booking' } }) }));
vi.mock('@/lib/session', () => ({ useSession: () => ({ session: { user: { id: 'test', email: 'amy@example.com' } }, membership: null, locations: [], context: { permissions: [] } }) }));
vi.mock('@/features/profile/api', () => ({
  useUserProfileQuery: () => ({ data: profile }),
  useUpdateUserProfile: () => ({ mutateAsync: save }),
  useChangePassword: () => ({}), useSetPin: () => ({}),
  useActiveSessionsQuery: () => ({}), useRevokeSession: () => ({}),
  usePersonalNotificationPreferencesQuery: () => ({}),
  useSavePersonalNotificationPreferences: () => ({}),
}));
import { Profile } from './Profile';
it('uses one name field and saves the same display name to both compatible API fields', async () => {
  localStorage.setItem('gf.lang', 'en');
  render(<LanguageProvider><MemoryRouter><Profile /></MemoryRouter></LanguageProvider>);
  const name = screen.getByRole('textbox', { name: 'Name / nickname' });
  expect(name).toHaveValue('Amy');
  expect(screen.queryByRole('textbox', { name: 'Legal name' })).not.toBeInTheDocument();
  fireEvent.change(name, { target: { value: '  Lisa  ' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ fullName: 'Lisa', nickname: 'Lisa' })));
});
