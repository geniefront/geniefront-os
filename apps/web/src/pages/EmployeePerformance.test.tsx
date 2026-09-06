import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { EmployeePerformance } from './EmployeePerformance';

const mocks = vi.hoisted(() => ({ save: vi.fn(), success: vi.fn(), danger: vi.fn() }));
vi.mock('@heroui/react', () => ({ toast: { success: mocks.success, danger: mocks.danger }, Spinner: () => null }));
vi.mock('@/LanguageContext', () => ({ useLanguage: () => ({ language: 'zh-Hans', t: (key: string) => key }) }));
vi.mock('@/lib/errorMessage', () => ({ useErrorMessage: () => (error: Error) => error.message }));
vi.mock('@/context/ScheduleContext', () => ({ useSchedule: () => ({ services: [] }) }));
vi.mock('@/features/staff/DirectorySettings', () => ({ DirectorySettings: () => null }));
vi.mock('@/features/staff/api', () => ({
  useStaffListQuery: () => ({ data: { staff: [], skills: [], levels: [], jobs: [] }, isLoading: false, refetch: vi.fn() }),
  useSaveStaffProfile: () => ({ mutateAsync: mocks.save }),
  useSetEmploymentStatus: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock('@/features/payroll/api', () => ({ usePayrollPlansQuery: () => ({ isLoading: false, refetch: vi.fn() }), useSavePayrollPlan: () => ({}) }));
vi.mock('@/components/ui/Modal', () => ({ Modal: ({ isOpen, children, footer, title }: any) => isOpen ? <section role="dialog" aria-label={title}>{children}{footer}</section> : null }));
vi.mock('@/components/ui/Button', () => ({ Button: ({ children, onClick, disabled, type }: any) => <button type={type ?? 'button'} onClick={onClick} disabled={disabled}>{children}</button> }));
vi.mock('@/components/ui/Input', () => ({ Input: (props: any) => <input {...props} /> }));
vi.mock('@/components/ui/Card', () => ({ Card: ({ children }: any) => <div>{children}</div>, CardContent: ({ children }: any) => <div>{children}</div> }));
vi.mock('@/components/ui/Badge', () => ({ Badge: ({ children }: any) => <span>{children}</span> }));

describe('EmployeePerformance save failure', () => {
  it('keeps entered values and never reports success or invents a staff card', async () => {
    mocks.save.mockRejectedValueOnce(new Error('Network failed'));
    render(<EmployeePerformance />);
    fireEvent.click(screen.getByText('rotation.empAdd'));
    fireEvent.change(screen.getByPlaceholderText('rotation.empNamePlaceholder'), { target: { value: 'Unsaved employee' } });
    fireEvent.change(screen.getByPlaceholderText('(555) 000-0000'), { target: { value: '6175550991' } });
    fireEvent.click(screen.getByText('rotation.empConfirmCreate'));
    fireEvent.click(screen.getByText('rotation.empSaveConfirmButton'));
    await waitFor(() => expect(mocks.danger).toHaveBeenCalledWith('Network failed'));
    expect(mocks.success).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText('rotation.empNamePlaceholder')).toHaveValue('Unsaved employee');
    expect(screen.queryByText('Unsaved employee')).not.toBeInTheDocument();
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ phone: '+16175550991', email: '', isBookable: false }));
  });
});
