import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { LanguageProvider } from '@/LanguageContext';
import { Settings } from './Settings';

const canState = vi.hoisted(() => ({
  allowed: false,
}));

vi.mock('@/lib/permissions', () => ({
  useCan: (permission: string) => canState.allowed && (
    permission === 'settings.manage' || permission === 'staff.manage' || permission === 'billing.manage'
  ),
  useCanAny: () => canState.allowed,
}));

const settingsQuery = vi.hoisted(() => vi.fn());
const billingQuery = vi.hoisted(() => vi.fn());

vi.mock('@/features/settings/api', () => ({
  useDeskSettingsQuery: (...args: unknown[]) => {
    settingsQuery(...args);
    return { data: undefined, isLoading: false, error: null, refetch: vi.fn() };
  },
  useDeskBillingQuery: (...args: unknown[]) => {
    billingQuery(...args);
    return { data: null };
  },
  useSaveLocationProfile: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSaveBusinessHours: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSaveService: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSaveServiceCategory: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useArchiveService: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSaveStaffProfile: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSetRotationParticipation: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSaveOnlineBooking: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useAddWebOrigin: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useRemoveWebOrigin: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSavePhoneAssistant: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSaveCheckoutSettings: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useApply10Dlc: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSaveWebhooks: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock('@/features/billing/BillingPanel', () => ({ BillingPanel: () => null }));
vi.mock('./HardwareServer', () => ({ HardwareServer: () => null }));
vi.mock('@/components/ui/ImageUploader', () => ({ ImageUploader: () => null }));

describe('Settings permission alignment', () => {
  it('rejects unauthorized access without enabling owner-only queries', () => {
    canState.allowed = false;
    render(
      <MemoryRouter initialEntries={['/settings?tab=billing']}>
        <LanguageProvider>
          <Settings />
        </LanguageProvider>
      </MemoryRouter>,
    );
    expect(screen.getByText('没有权限访问系统设置')).toBeInTheDocument();
    expect(screen.queryByText('Failed to load system settings')).not.toBeInTheDocument();
    expect(settingsQuery).toHaveBeenCalledWith({ enabled: false });
    expect(billingQuery).toHaveBeenCalledWith({ enabled: false });
  });
});
