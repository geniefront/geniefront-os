import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
const { save } = vi.hoisted(() => ({ save: vi.fn().mockResolvedValue({}) }));
vi.mock('@/LanguageContext', () => ({ useLanguage: () => ({ language: 'en', t: (key: string) => key }) }));
vi.mock('@/features/settings/api', () => ({ useSaveService: () => ({ mutateAsync: save }), useSaveServiceCategory: () => ({ mutateAsync: vi.fn() }) }));
import { ServiceEditor } from './CatalogFields';
import { SetupSaveProvider } from './autosave';
it('converting a service to an add-on automatically removes standalone booking eligibility', async () => {
  render(<SetupSaveProvider><ServiceEditor categories={[]} service={{ id: 'service', categoryId: null, name: { en: 'Hot stone' }, displayName: 'Hot stone', durationMin: 15, basePriceCents: 1500, taxable: false, onlineBookable: true, isAddon: false, staffCount: 1, requiredSkillIds: [], active: true, updatedAt: '2026-09-19' }} /></SetupSaveProvider>);
  fireEvent.click(screen.getByRole('switch', { name: /settings.stAddOnTag/ }));
  await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ serviceId: 'service', isAddon: true, onlineBookable: false, basePriceCents: 1500 })), { timeout: 2000 });
  expect(screen.queryByRole('switch', { name: 'setupOnlineBookable' })).not.toBeInTheDocument();
});
