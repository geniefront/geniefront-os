import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
const { save, archive, bulk, generate, refetch, settings, permission } = vi.hoisted(() => ({
  generate: vi.fn(), save: vi.fn(), archive: vi.fn(), bulk: vi.fn(), refetch: vi.fn(), permission: { allowed: true },
  settings: { location: { businessType: 'massage' }, serviceCategories: [{ id: 'cat', name: { en: 'Massage' }, displayName: 'Massage', sort: 0 }], services: [
    { id: 'regular', name: { en: 'Deep Tissue' }, displayName: 'Deep Tissue', durationMin: 60, basePriceCents: 7500, active: true, isAddon: false, onlineBookable: false, staffCount: 1, updatedAt: 'v1', categoryId: 'cat' },
    { id: 'addon', name: { en: 'Hot Stone' }, displayName: 'Hot Stone', durationMin: 15, basePriceCents: 1500, active: true, isAddon: true, onlineBookable: false, staffCount: 1, updatedAt: 'v2' },
    { id: 'removed', name: { en: 'Old Service' }, displayName: 'Old Service', durationMin: 30, basePriceCents: 3000, active: false, isAddon: false, onlineBookable: true, staffCount: 1, updatedAt: 'v3' },
  ] },
}));
vi.mock('@/LanguageContext', () => ({ useLanguage: () => ({ t: (key: string) => key, language: 'en' }) }));
vi.mock('@/lib/permissions', () => ({ useCan: () => permission.allowed }));
vi.mock('@/lib/errorMessage', () => ({ useErrorMessage: () => (e: Error) => e.message }));
vi.mock('./api', () => ({ useGenerateServiceShortNames:()=>({mutateAsync:generate,isPending:false}), useDeskSettingsQuery: () => ({ data: settings, refetch }), useSaveService: () => ({ mutateAsync: save }), useArchiveService: () => ({ mutateAsync: archive }), useBulkUpdateServices: () => ({ mutateAsync: bulk }), useSaveServiceCategory: () => ({ mutateAsync: vi.fn() }) }));
vi.mock('@/features/setup/ImportWorkspace', () => ({ ImportWorkspace: () => <p>Import tools</p> }));
vi.mock('@/features/setup/CatalogPresetPicker', () => ({ CatalogPresetPicker: () => <p>Presets</p> }));
vi.mock('@/components/ui/BookingImagePicker', () => ({ BookingImagePicker: () => null }));
import { ServiceCatalog } from './ServiceCatalog';
beforeEach(() => { generate.mockReset().mockResolvedValue({shortNames:{en:"Deep","zh-Hans":"深层","zh-Hant":"深層",ko:"심부",vi:"Sâu",es:"Profundo"},updated:2,skipped:0}); save.mockReset().mockResolvedValue({}); archive.mockReset().mockResolvedValue({}); bulk.mockReset().mockResolvedValue({ updated: 1 }); permission.allowed = true; });
const mount = () => render(<MemoryRouter><ServiceCatalog /></MemoryRouter>);
it('shows name, price and actions without expanding cards and separates deleted services', () => {
  mount(); expect(screen.getByText('$75.00')).toBeVisible(); expect(screen.queryByText('Old Service')).not.toBeInTheDocument();
  fireEvent.change(screen.getByRole('textbox', { name: 'settings.stServiceSearch' }), { target: { value: 'Deep' } });
  expect(screen.queryByText('Hot Stone')).not.toBeInTheDocument();
  fireEvent.change(screen.getByRole('textbox', { name: 'settings.stServiceSearch' }), { target: { value: '' } });
  fireEvent.click(screen.getByRole('button', { name: /catalogDeleted/ }));
  expect(screen.getByText('Old Service')).toBeVisible(); expect(screen.queryByText('Deep Tissue')).not.toBeInTheDocument();
});
it('deletes through the archive command only after confirmation', async () => {
  mount(); fireEvent.click(screen.getByRole('button', { name: 'catalogDelete: Deep Tissue' }));
  expect(archive).not.toHaveBeenCalled();
  const dialog = within(await screen.findByRole('dialog'));
  fireEvent.click(dialog.getByRole('button', { name: 'catalogDelete' }));
  await waitFor(() => expect(archive).toHaveBeenCalledWith({ serviceId: 'regular' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
});
it('keeps failed deletion open for retry', async () => {
  archive.mockRejectedValueOnce(new Error('Could not delete'));
  mount(); fireEvent.click(screen.getByRole('button', { name: 'catalogDelete: Deep Tissue' }));
  const dialog = within(await screen.findByRole('dialog')); fireEvent.click(dialog.getByRole('button', { name: 'catalogDelete' }));
  await waitFor(() => expect(archive).toHaveBeenCalledTimes(1));
  expect(screen.getByRole('dialog')).toBeVisible();
});
it('adds new services with online booking on by default', async () => {
  mount(); fireEvent.click(screen.getByRole('button', { name: 'setupAddService' }));
  const dialog = within(await screen.findByRole('dialog'));
  expect(dialog.getByRole('switch', { name: /catalogOnline/ })).toHaveAttribute('aria-checked', 'true');
  fireEvent.change(dialog.getByRole('textbox', { name: 'setupFieldServiceName' }), { target: { value: 'Massage' } });
  fireEvent.change(dialog.getByRole('spinbutton', { name: 'setupFieldPriceUsd' }), { target: { value: '80' } });
  fireEvent.click(dialog.getByRole('button', { name: 'save' }));
  await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ onlineBookable: true, active: true, basePriceCents: 8000, durationMin: 60 })));
});
it('enables online booking only for active ordinary services with version checks', async () => {
  mount(); fireEvent.click(screen.getByRole('button', { name: 'catalogEnableAll' }));
  const dialog = within(await screen.findByRole('dialog')); fireEvent.click(dialog.getByRole('button', { name: 'catalogEnableAll' }));
  await waitFor(() => expect(bulk).toHaveBeenCalledWith({ serviceIds: ['regular'], expectedVersions: { regular: 'v1' }, set: { onlineBookable: true } }));
});
it('restores deleted items without replacing their saved booking choice', async () => {
  mount(); fireEvent.click(screen.getByRole('button', { name: /catalogDeleted/ })); fireEvent.click(screen.getByRole('button', { name: 'catalogRestore' }));
  await waitFor(() => expect(save).toHaveBeenCalledWith({ serviceId: 'removed', name: { en: 'Old Service' }, durationMin: 30, basePriceCents: 3000, active: true }));
});
it('does not enable write controls without catalog permission', () => {
  permission.allowed = false; mount();
  expect(screen.getByRole('button', { name: 'setupAddService' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'catalogDelete: Deep Tissue' })).toBeDisabled();
});

it('AI fills all six short names into the editor and manual edits are saved',async()=>{
 mount();fireEvent.click(screen.getByRole('button',{name:'edit: Deep Tissue'}));
 const dialog=within(await screen.findByRole('dialog'));
 fireEvent.click(dialog.getByRole('button',{name:'AI fill all languages'}));
 await waitFor(()=>expect(dialog.getByRole('textbox',{name:'SMS short names · 简体中文'})).toHaveValue('深层'));
 fireEvent.change(dialog.getByRole('textbox',{name:'SMS short names · 简体中文'}),{target:{value:'深压'}});
 fireEvent.click(dialog.getByRole('button',{name:'save'}));
 await waitFor(()=>expect(save).toHaveBeenCalledWith(expect.objectContaining({shortNames:expect.objectContaining({'zh-Hans':'深压','zh-Hant':'深層',en:'Deep'})})));
});
it('bulk AI targets active services and add-ons only',async()=>{
 mount();fireEvent.click(screen.getByRole('button',{name:'AI fill missing short names'}));
 await waitFor(()=>expect(generate).toHaveBeenCalledWith({serviceIds:['regular','addon']}));
});
