import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { LanguageProvider } from '@/LanguageContext';
import { translations } from '@/i18n';
import { Settings } from './Settings';

const toast = vi.hoisted(() => ({
  success: vi.fn(),
  danger: vi.fn(),
}));

const { applyMutate, idleMutation } = vi.hoisted(() => ({
  applyMutate: vi.fn(),
  idleMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

const settingsState = vi.hoisted(() => ({
  data: {
    location: {
      name: 'Lotus Spa',
      timezone: 'America/New_York',
      businessType: 'mixed',
      phone: '+12125808888',
      email: 'owner@lotusspanyc.com',
      addressStreet: '128 E 56th St',
      addressCity: 'New York',
      addressState: 'NY',
      addressZip: '10022',
      businessHours: {},
      businessDayCutoff: '03:00',
    },
    services: [],
    staff: [],
    levels: [],
    skills: [],
    guest: { publicKey: 'pk_test', allowedOrigins: [], onlineBooking: { enabled: false } },
    phone: {},
    tenDlc: {
      status: 'not_submitted' as 'not_submitted' | 'pending_review' | 'approved' | 'rejected',
      legalBusinessName: 'Lotus Spa & Wellness LLC',
      ein: '12-3456789',
      businessStructure: 'llc',
      registeredAddress: '128 E 56th St, New York, NY 10022',
      repName: 'Emily Zhang',
      repTitle: 'Store Owner',
      repEmail: 'owner@lotusspanyc.com',
      repPhone: '+12125808888',
      optInMethod: 'Website checkbox',
      sampleMessages: ['Lotus Spa: Hi {Name}, your appointment is confirmed.'],
    },
  },
  isLoading: false,
  error: null as Error | null,
  refetch: vi.fn(),
}));

vi.mock('@heroui/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@heroui/react')>();
  return { ...actual, toast };
});

vi.mock('@/features/billing/BillingPanel', () => ({
  BillingPanel: () => null,
}));

vi.mock('./HardwareServer', () => ({
  HardwareServer: () => null,
}));

vi.mock('@/components/ui/ImageUploader', () => ({
  ImageUploader: () => null,
}));

vi.mock('@/features/settings/api', () => ({
  useDeskSettingsQuery: () => settingsState,
  useDeskBillingQuery: () => ({ data: null }),
  useSaveLocationProfile: idleMutation,
  useSaveBusinessHours: idleMutation,
  useSaveService: idleMutation,
  useArchiveService: idleMutation,
  useSaveStaffProfile: idleMutation,
  useSetRotationParticipation: idleMutation,
  useSaveOnlineBooking: idleMutation,
  useAddWebOrigin: idleMutation,
  useRemoveWebOrigin: idleMutation,
  useSavePhoneAssistant: idleMutation,
  useSaveCheckoutSettings: idleMutation,
  useApply10Dlc: () => ({ mutateAsync: applyMutate, isPending: false }),
  useSaveWebhooks: idleMutation,
}));

function renderTab() {
  return render(
    <MemoryRouter initialEntries={['/settings?tab=10dlc']}>
      <LanguageProvider>
        <Settings />
      </LanguageProvider>
    </MemoryRouter>,
  );
}

const carrierClaim = /carrier review|filed with the US TCR|TCR 机构|运营商审核|自动发起运营商|starts the carrier review/i;

describe('Settings 10DLC copy and persist semantics', () => {
  beforeEach(() => {
    toast.success.mockReset();
    toast.danger.mockReset();
    applyMutate.mockReset();
    settingsState.data.tenDlc.status = 'not_submitted';
    settingsState.data.tenDlc.legalBusinessName = 'Lotus Spa & Wellness LLC';
  });

  it('success copy says GenieFront received the application, not a carrier filing', async () => {
    applyMutate.mockResolvedValue({
      locationId: 'loc-1',
      status: 'pending_review',
      submittedAt: '2026-08-30T00:00:00.000Z',
    });
    const user = userEvent.setup();
    renderTab();

    expect(screen.getByText(translations['zh-Hans']['settings.st10dlcNoneTitle'])).toBeTruthy();
    expect(screen.getByText(translations['zh-Hans']['settings.st10dlcSubmitNote'])).toBeTruthy();
    expect(screen.getByText(translations['zh-Hans']['settings.st10dlcSubmitNote']).textContent)
      .not.toMatch(carrierClaim);

    await user.click(screen.getByRole('button', { name: translations['zh-Hans']['settings.stSubmit10dlc'] }));
    await user.click(screen.getByRole('button', { name: translations['zh-Hans']['settings.stSubmit10dlcConfirmAction'] }));

    await waitFor(() => expect(applyMutate).toHaveBeenCalled());
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(translations['zh-Hans']['settings.st10dlcSubmitted']));
    expect(toast.success.mock.calls.flat().join(' ')).not.toMatch(carrierClaim);
    expect(toast.success.mock.calls.flat().join(' ')).toMatch(/GenieFront/);
    expect(screen.getByText(translations['zh-Hans']['settings.st10dlcReviewTitle'])).toBeTruthy();
    expect(screen.getByText(translations['zh-Hans']['settings.st10dlcReviewDesc']).textContent)
      .not.toMatch(/正对接运营商|working with the carriers/i);
  });

  it('failure does not claim success and keeps the form values', async () => {
    applyMutate.mockRejectedValue(new Error('offline'));
    const user = userEvent.setup();
    renderTab();

    const legal = screen.getByDisplayValue('Lotus Spa & Wellness LLC');
    await user.click(screen.getByRole('button', { name: translations['zh-Hans']['settings.stSubmit10dlc'] }));
    await user.click(screen.getByRole('button', { name: translations['zh-Hans']['settings.stSubmit10dlcConfirmAction'] }));

    await waitFor(() => expect(applyMutate).toHaveBeenCalled());
    await waitFor(() => expect(toast.danger).toHaveBeenCalled());
    expect(toast.success).not.toHaveBeenCalled();
    expect((legal as HTMLInputElement).value).toBe('Lotus Spa & Wellness LLC');
  });

  it('reload of pending_review shows GenieFront internal review, not carrier submission', () => {
    settingsState.data.tenDlc.status = 'pending_review';
    renderTab();
    expect(screen.getByText(translations['zh-Hans']['settings.st10dlcReviewing'])).toBeTruthy();
    expect(screen.getByText(translations['zh-Hans']['settings.st10dlcReviewTitle'])).toBeTruthy();
    expect(screen.getByDisplayValue('Lotus Spa & Wellness LLC')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(carrierClaim);
    expect(document.body.textContent).toMatch(/GenieFront/);
  });
});
