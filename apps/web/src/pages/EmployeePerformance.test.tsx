import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { EmployeePerformance } from './EmployeePerformance';

const mocks = vi.hoisted(() => ({
  save: vi.fn(), success: vi.fn(), danger: vi.fn(),
  staffData: { staff: [] as any[], skills: [] as any[], levels: [] as any[], jobs: [] as any[] },
}));
vi.mock('@heroui/react', () => ({ toast: { success: mocks.success, danger: mocks.danger }, Spinner: () => null }));
vi.mock('@/LanguageContext', () => ({ useLanguage: () => ({ language: 'zh-Hans', t: (key: string) => key }) }));
vi.mock('@/lib/errorMessage', () => ({ useErrorMessage: () => (error: Error) => error.message }));
vi.mock('@/context/ScheduleContext', () => ({ useSchedule: () => ({ services: [] }) }));
vi.mock('@/features/staff/DirectorySettings', () => ({ DirectorySettings: () => null }));
vi.mock('@/features/staff/api', () => ({
  useStaffListQuery: () => ({ data: mocks.staffData, isLoading: false, refetch: vi.fn() }),
  useSaveStaffProfile: () => ({ mutateAsync: mocks.save }),
  useSetEmploymentStatus: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock('@/features/payroll/api', () => ({ usePayrollPlansQuery: () => ({ isLoading: false, refetch: vi.fn() }), useSavePayrollPlan: () => ({}) }));
vi.mock('@/components/ui/Modal', () => ({ Modal: ({ isOpen, children, footer, title }: any) => isOpen ? <section role="dialog" aria-label={title}>{children}{footer}</section> : null }));
vi.mock('@/components/ui/Button', () => ({ Button: ({ children, onClick, disabled, type }: any) => <button type={type ?? 'button'} onClick={onClick} disabled={disabled}>{children}</button> }));
vi.mock('@/components/ui/Input', () => ({ Input: (props: any) => <input {...props} /> }));
vi.mock('@/components/ui/Card', () => ({ Card: ({ children }: any) => <div>{children}</div>, CardContent: ({ children }: any) => <div>{children}</div> }));
vi.mock('@/components/ui/Badge', () => ({ Badge: ({ children }: any) => <span>{children}</span> }));

const baseStaff = {
  id: 'm1', membershipId: 'm1', employeeNo: 'EMP-1', name: 'Amy', phone: '', email: undefined,
  isBookable: true, maxConcurrentAppointments: 1,
  jobTitle: '美甲师', jobTitleId: 'j1', level: '资深技师', levelId: 'l1',
  status: 'active' as const, hireDate: '2025-01-01',
  payroll: { kind: 'commission' as const, ratePercent: 45, hourlyRateDollars: 0, base: 'net' as const },
};

describe('EmployeePerformance compact card (U13 / W2b)', () => {
  it('collapses a 30-skill roster into a count + "+N more" and only reveals the full list on expand', () => {
    const skills = Array.from({ length: 30 }, (_, i) => `技能${i + 1}`);
    mocks.staffData = {
      staff: [{ ...baseStaff, skills, skillIds: skills.map((_, i) => `s${i}`) }],
      skills: skills.map((name, i) => ({ id: `s${i}`, key: name, name, active: true, sort: i })),
      levels: [], jobs: [],
    };
    render(<EmployeePerformance />);
    // 紧凑行显示技能数量，最多 3 个标签
    expect(screen.getByText('rotation.empSkillsCount')).toBeInTheDocument();
    expect(screen.getByText('技能1')).toBeInTheDocument();
    expect(screen.getByText('技能3')).toBeInTheDocument();
    // 第 4 个及之后默认不铺开
    expect(screen.queryByText('技能4')).not.toBeInTheDocument();
    expect(screen.getByText('rotation.empSkillsMore')).toBeInTheDocument();
    // 提成明细默认藏在展开区，点开后才出现
    expect(screen.queryByText(/rotation\.empCommission/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('rotation.empViewDetail'));
    expect(screen.getByText(/rotation\.empCommission/)).toBeInTheDocument();
    expect(screen.getByText('rotation.empCollapse')).toBeInTheDocument();
    expect(screen.queryByText('rotation.empViewDetail')).not.toBeInTheDocument();
  });
});

describe('EmployeePerformance save failure', () => {
  it('keeps entered values and never reports success or invents a staff card', async () => {
    mocks.staffData = { staff: [], skills: [], levels: [], jobs: [] };
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
