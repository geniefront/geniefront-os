import { useState, useMemo } from 'react';
import {
  User,
  Users,
  UserCheck,
  UserX,
  Plus,
  Search,
  Edit2,
  Trash2,
  Phone,
  Mail,
  Calendar,
  Briefcase,
  Award,
  DollarSign,
  Tag,
  FileText,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Percent,
  Clock,
  ShieldAlert,
  Sliders,
  Filter,
  Check,
  X,
  RefreshCw,
  Ban,
  Scissors,
  Sparkles,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { toast, Spinner } from '@heroui/react';
import { Card, CardContent } from '@/components/ui/Card';
import { fuzzySearch } from '@/lib/fuzzySearch';
import { useErrorMessage } from '@/lib/errorMessage';
import { formatPhoneDisplay, formatPhoneInput, normalizePhoneE164 } from '@/lib/utils';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { PageHeader } from '@/components/ui/PageHeader';
import { useLanguage } from '@/LanguageContext';
import { useStaffListQuery, useSaveStaffProfile, useSetEmploymentStatus } from '@/features/staff/api';
import type { StaffPayrollInfo, PlanKind, CommissionBase } from '@/features/payroll/types';
import type { StaffDirectoryItem } from '@/features/staff/types';
import type { TranslationKey } from '@/i18n';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { PageLoading, PageError } from '@/components/ui/QueryState';
import { useSchedule } from '@/context/ScheduleContext';
import { DirectorySettings } from '@/features/staff/DirectorySettings';
import { matchStaffServices } from '@/features/staff/serviceMatch';
import { centsToDollars } from '@/features/checkout/api';

/**
 * 预设职位 / 职级 / 技能标签的展示译文映射。
 *
 * ⚠️ 只翻译**显示的文字**，不改数据本身 —— 下拉框和技能徽章的
 * value/匹配键仍然是上面那组中文原文，因为它就是存进
 * `staff_profiles.job_title` / `.level` / `.skills` 的原始值。
 * 改 value 会让已有员工档案的筛选和「可接项目」比对全部失配。
 * 查不到映射的自定义职位（老板自己手打的）原样显示，不当作漏译。
 */
const PRESET_LABEL_KEYS: Record<string, TranslationKey> = {
  '美甲师': 'rotation.empRoleNail',
  '芳疗理疗师': 'rotation.empRoleSpa',
  'Lashes & Brows师': 'rotation.empRoleLash',
  'Hair Styling师': 'rotation.empRoleHair',
  '前台店务收银': 'rotation.empRoleFrontDesk',
  '门店店长/主管': 'rotation.empRoleManager',
  '见习学徒': 'rotation.empLevelTrainee',
  '初级技师': 'rotation.empLevelJunior',
  '中级技师': 'rotation.empLevelMid',
  '资深技师': 'rotation.empLevelSenior',
  '首席大师': 'rotation.empLevelMaster',
  '技术总监': 'rotation.empLevelDirector',
  '店长主管': 'rotation.empLevelManager',
  '日式光疗美甲': 'rotation.empSkillGelNail',
  '水晶琉璃延长': 'rotation.empSkillCrystalExt',
  '俄式极致修甲': 'rotation.empSkillRussianMani',
  '手足精油SPA': 'rotation.empSkillHandFootSpa',
  '全身芳香开背': 'rotation.empSkillAromaMassage',
  '火山热石理疗': 'rotation.empSkillHotStone',
  '足底全息反射': 'rotation.empSkillFootReflex',
  '头部舒压理疗': 'rotation.empSkillScalpRelax',
  '日式单根美睫': 'rotation.empSkillLashSingle',
  '3D云朵开花': 'rotation.empSkillLashVolume',
  '半永久野生眉': 'rotation.empSkillMicroblading',
  '染烫色彩造型': 'rotation.empSkillColorPerm',
};

// 员工档案接口
export interface StaffMember {
  id: string;
  membershipId: string;
  isBookable: boolean;
  maxConcurrentAppointments: number;
  employeeNo: string; // 员工工号 如 EMP-01
  name: string; // 员工姓名
  phone: string; // 手机号码
  email?: string; // 电子邮箱
  jobTitle: string; // 岗位职位显示名（展示用）
  jobTitleId: string | null; // 岗位目录项 ID（关联主键）
  level: string; // 职位等级显示名（展示用）
  levelId: string | null; // 职级目录项 ID（关联主键）
  skills: string[];
  skillIds: string[]; // 技能标签
  status: 'active' | 'on_leave' | 'resigned'; // 状态: 在职 / 休假 / 离职
  hireDate: string; // 入职日期
  payroll: {
    kind: PlanKind;
    ratePercent: number; // 提成比例 %
    hourlyRateDollars: number; // 底薪/时薪 $
    base: CommissionBase; // 计提基数: 折后实收 (net) / 服务原价 (gross)
  };
  note?: string; // 备注说明
}

interface ConfirmModalState {
  title: string;
  description: string;
  confirmText?: string;
  confirmTone?: 'primary' | 'danger' | 'warning' | 'emerald';
  onConfirm: () => Promise<void> | void;
}

function EmployeePerformanceContent() {
  const errorMessage = useErrorMessage();
  const { t, language } = useLanguage();
  const zh = language === 'zh-Hans';
  /** 预设职位/职级/技能 → 展示译文；查不到映射（老板自己手打的）原样返回 */
  const presetLabel = (value: string): string => {
    const key = PRESET_LABEL_KEYS[value];
    return staffData?.skills?.find((skill) => skill.id === value)?.name ?? (key ? t(key) : value);
  };

  const { services } = useSchedule();
  const serviceCatalog = useMemo(
    () => services.map((service) => ({
      id: service.id,
      name: service.name,
      requiredSkillIds: service.requiredSkills.map((skill) => skill.id),
      categoryName: service.categoryName ?? '',
      priceCents: service.priceCents,
    })),
    [services],
  );
  const { data: staffData, isLoading: isStaffLoading, isError: isStaffError, error: staffErr, refetch: refetchStaff } = useStaffListQuery();
  const saveStaffMutation = useSaveStaffProfile();
  const setEmploymentMutation = useSetEmploymentStatus();

  const isInitialLoading = isStaffLoading && !staffData;

  // 员工数据状态
  const staffList: StaffMember[] = staffData?.staff ?? [];

  // 刷新全量数据
  const handleRefetchAll = () => {
    void refetchStaff();

  };

  // 筛选与搜索
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedJobFilter, setSelectedJobFilter] = useState('all');
  const [selectedLevelFilter, setSelectedLevelFilter] = useState('all');
  const [selectedStatusFilter, setSelectedStatusFilter] = useState('all');

  // 控制不可接项目展开收起（全局或单卡）
  const [expandedCannotDoStaffId, setExpandedCannotDoStaffId] = useState<string | null>(null);

  // 通用二次防误触确认弹窗
  const [confirmModal, setConfirmModal] = useState<ConfirmModalState | null>(null);
  const [confirmPending, setConfirmPending] = useState(false);

  // 员工编辑/新增弹窗表单状态
  const [isFormModalOpen, setIsFormModalOpen] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editingStaffId, setEditingStaffId] = useState<string | null>(null);

  const [saveKey, setSaveKey] = useState(crypto.randomUUID());
  const [formBookable, setFormBookable] = useState(false);
  const [formConcurrency, setFormConcurrency] = useState(1);
  const [formName, setFormName] = useState('');
  const [formEmployeeNo, setFormEmployeeNo] = useState('');
  const [formPhone, setFormPhone] = useState('');
  const [formEmail, setFormEmail] = useState('');
  // 岗位 / 职级 / 技能一律存目录项 ID，只能从本店已启用目录中选（U02 / W2）
  const [formJobTitleId, setFormJobTitleId] = useState('');
  const [formLevelId, setFormLevelId] = useState('');
  const [formSkills, setFormSkills] = useState<string[]>([]);
  const [formStatus, setFormStatus] = useState<'active' | 'on_leave' | 'resigned'>('active');
  const [formHireDate, setFormHireDate] = useState(new Date().toISOString().slice(0, 10));
  const [formPlanKind, setFormPlanKind] = useState<PlanKind>('commission');
  const [formRatePercent, setFormRatePercent] = useState<number>(45);
  const [formHourlyRate, setFormHourlyRate] = useState<number>(18);
  const [formCommBase, setFormCommBase] = useState<CommissionBase>('net');
  const [formNote, setFormNote] = useState('');

  // 顶部紧凑统计指标
  const metrics = useMemo(() => {
    const total = staffList.length;
    const activeCount = staffList.filter((s) => s.status === 'active').length;
    const onLeaveCount = staffList.filter((s) => s.status === 'on_leave').length;
    const resignedCount = staffList.filter((s) => s.status === 'resigned').length;
    const allSkillsCount = new Set(staffList.flatMap((s) => s.skills)).size;

    return {
      total,
      activeCount,
      onLeaveCount,
      resignedCount,
      allSkillsCount,
    };
  }, [staffList]);

  // 过滤后的员工列表 (支持错别字容错模糊搜索)
  const filteredStaff = useMemo(() => {
    let list = staffList;
    if (selectedStatusFilter !== 'all') {
      list = list.filter((staff) => staff.status === selectedStatusFilter);
    }
    if (selectedJobFilter !== 'all') {
      list = list.filter((staff) => staff.jobTitle === selectedJobFilter);
    }
    if (selectedLevelFilter !== 'all') {
      list = list.filter((staff) => staff.level === selectedLevelFilter);
    }
    if (searchQuery.trim()) {
      list = fuzzySearch(list, searchQuery, {
        keys: [
          { name: 'name', weight: 0.5 },
          { name: 'employeeNo', weight: 0.2 },
          { name: 'phone', weight: 0.2 },
          { name: 'skills', weight: 0.25 },
          { name: 'jobTitle', weight: 0.15 },
        ],
        threshold: 0.45,
      });
    }
    return list;
  }, [staffList, selectedStatusFilter, selectedJobFilter, selectedLevelFilter, searchQuery]);

  const getStaffServicesStatus = (skills: string[]) => matchStaffServices(skills, serviceCatalog);

  // 弹窗表单中根据当前勾选技能实时预览可接与不可接项目
  const formServiceStatus = useMemo(
    () => matchStaffServices(formSkills, serviceCatalog),
    [formSkills, serviceCatalog],
  );

  // ──────────────────────────────────────────────────────────── 增删改查动作

  // 1. 打开新增员工弹窗
  const handleOpenAddModal = () => {
    setSaveKey(crypto.randomUUID());
    setFormBookable(false);
    setFormConcurrency(1);
    setIsEditing(false);
    setEditingStaffId(null);
    setFormName('');
    setFormEmployeeNo('');
    setFormPhone('');
    setFormEmail('');
    setFormJobTitleId('');
    setFormLevelId('');
    setFormSkills([]);
    setFormStatus('active');
    setFormHireDate(new Date().toISOString().slice(0, 10));
    setFormPlanKind('commission');
    setFormRatePercent(45);
    setFormHourlyRate(18);
    setFormCommBase('net');
    setFormNote('');
    setIsFormModalOpen(true);
  };

  // 2. 打开编辑员工弹窗
  const handleOpenEditModal = (staff: StaffMember) => {
    setSaveKey(crypto.randomUUID());
    setFormBookable(staff.isBookable);
    setFormConcurrency(staff.maxConcurrentAppointments);
    setIsEditing(true);
    setEditingStaffId(staff.id);
    setFormName(staff.name);
    setFormEmployeeNo(staff.employeeNo);
    setFormPhone(formatPhoneDisplay(staff.phone) || '');
    setFormEmail(staff.email || '');
    setFormJobTitleId(staff.jobTitleId ?? '');
    setFormLevelId(staff.levelId ?? '');
    setFormSkills([...staff.skillIds]);
    setFormStatus(staff.status);
    setFormHireDate(staff.hireDate);
    setFormPlanKind(staff.payroll.kind);
    setFormRatePercent(staff.payroll.ratePercent);
    setFormHourlyRate(staff.payroll.hourlyRateDollars);
    setFormCommBase(staff.payroll.base);
    setFormNote(staff.note || '');
    setIsFormModalOpen(true);
  };

  // 3. 提交表单保存 (带二次确认)
  const handleSubmitFormWithConfirm = () => {
    if (!formName.trim()) {
      toast.danger(t('rotation.empNameRequired'));
      return;
    }
    if (!formPhone.trim()) {
      toast.danger(t('rotation.empPhoneRequired'));
      return;
    }

    const actionText = isEditing ? t('rotation.empActionSave') : t('rotation.empActionCreate');

    setConfirmModal({
      title: isEditing ? t('rotation.empEditConfirmTitle', { p0: formName }) : t('rotation.empAddConfirmTitle', { p0: formName }),
      description: isEditing
        ? t('rotation.empEditConfirmDesc', { p0: formName, p1: formServiceStatus.canDo.length, p2: formServiceStatus.cannotDo.length })
        : t('rotation.empAddConfirmDesc', {
            p0: formName,
            p1: formEmployeeNo,
            p2: staffData?.jobs?.find((job) => job.id === formJobTitleId)?.name ?? '—',
            p3: staffData?.levels?.find((level) => level.id === formLevelId)?.name ?? '—',
          }),
      confirmText: t('rotation.empSaveConfirmButton', { p0: actionText }),
      confirmTone: 'primary',
      onConfirm: async () => {
        const targetStaff = staffList.find((s) => s.id === editingStaffId);
        if (isEditing && !targetStaff) throw new Error(zh ? '员工档案已变化，请刷新后重试' : 'Staff record changed. Refresh and retry.');
          await saveStaffMutation.mutateAsync({
            idempotencyKey: saveKey,
            isBookable: formBookable,
            maxConcurrentAppointments: formConcurrency,
            membershipId: isEditing ? targetStaff?.membershipId : undefined,
            name: formName.trim(),
            phone: normalizePhoneE164(formPhone),
            email: formEmail.trim(),
            employeeNo: formEmployeeNo.trim(),
            jobTitleId: formJobTitleId || null,
            levelId: formLevelId || null,
            skillIds: formSkills.filter((id) => staffData?.skills.some((skill) => skill.id === id)),
            status: formStatus,
            hireDate: formHireDate || undefined,
            note: formNote.trim() || undefined,
            payroll: {
              kind: formPlanKind,
              ratePercent: formRatePercent,
              hourlyRateDollars: formHourlyRate,
              base: formCommBase,
            },
          });
        toast.success(t(isEditing ? 'rotation.empUpdated' : 'rotation.empAdded', { p0: formName }));
        setIsFormModalOpen(false);
      },
    });
  };

  // 4. 删除员工档案 (严格二次确认)
  const handleDeleteStaffWithConfirm = (staff: StaffMember) => {
    setConfirmModal({
      title: t('rotation.empDeleteConfirmTitle', { p0: staff.name }),
      description: t('rotation.empDeleteConfirmDesc', { p0: staff.name, p1: staff.employeeNo }),
      confirmText: t('rotation.empDeleteConfirmButton'),
      confirmTone: 'danger',
      onConfirm: async () => {

          await setEmploymentMutation.mutateAsync({
            membershipId: staff.membershipId,
            status: 'resigned',
          });

        toast.success(t('rotation.empDeleted', { p0: staff.name }));
      },
    });
  };

  // 5. 快捷切换在职/休假状态 (带二次确认)
  const handleToggleStatusWithConfirm = (staff: StaffMember, nextStatus: StaffMember['status']) => {
    const statusLabels: Record<string, string> = {
      active: t('rotation.empStatusLabelActive'),
      on_leave: t('rotation.empStatusLabelOnLeave'),
      resigned: t('rotation.empStatusLabelResigned'),
    };

    setConfirmModal({
      title: t('rotation.empStatusChangeConfirmTitle', { p0: staff.name }),
      description: t('rotation.empStatusChangeConfirmDesc', { p0: staff.name, p1: statusLabels[staff.status], p2: statusLabels[nextStatus] }),
      confirmText: t('rotation.empStatusChangeConfirmButton'),
      confirmTone: nextStatus === 'resigned' ? 'warning' : 'primary',
      onConfirm: async () => {

          await setEmploymentMutation.mutateAsync({
            membershipId: staff.membershipId,
            status: nextStatus,
          });

        toast.success(t('rotation.empStatusChanged', { p0: staff.name, p1: statusLabels[nextStatus] }));
      },
    });
  };

  // 技能标签勾选/取消
  const toggleSkill = (skill: string) => {
    setFormSkills((prev) =>
      prev.includes(skill) ? prev.filter((s) => s !== skill) : [...prev, skill],
    );
  };

  // 执行通用二次确认
  const handleExecuteConfirmModal = async () => {
    if (!confirmModal) return;
    setConfirmPending(true);
    try {
      await confirmModal.onConfirm();
      setConfirmModal(null);
    } catch (err: any) {
      toast.danger(errorMessage(err));
    } finally {
      setConfirmPending(false);
    }
  };

  // 状态徽章渲染
  const getStatusBadge = (status: StaffMember['status']) => {
    switch (status) {
      case 'active':
        return (
          <Badge className="bg-emerald-100 text-emerald-900 border-emerald-300 font-bold text-xs px-2 py-0.5">

            {t('rotation.empStatusActive')}
          </Badge>
        );
      case 'on_leave':
        return (
          <Badge className="bg-amber-100 text-amber-900 border-amber-300 font-bold text-xs px-2 py-0.5">

            {t('rotation.empStatusLeave')}
          </Badge>
        );
      case 'resigned':
        return (
          <Badge className="bg-slate-100 text-slate-500 border-slate-300 font-medium text-xs px-2 py-0.5">

            {t('rotation.empStatusLeft')}
          </Badge>
        );
      default:
        return null;
    }
  };

  if (isInitialLoading) {
    return <PageLoading title={t('rotation.empLoading')} description={t('rotation.empLoadingDesc')} />;
  }

  if (isStaffError && !staffData) {
    return (
      <PageError
        title={t('rotation.empLoadError')}
        error={staffErr}
        onRetry={() => {
          void refetchStaff();

        }}
      />
    );
  }

  return (
    <div className="space-y-4 max-w-7xl mx-auto w-full pb-20">
      {/* 1. High-Density Compact Top Header & Action Bar */}
      <div className="bg-white p-3.5 rounded-2xl border border-slate-200 shadow-xs flex flex-col md:flex-row items-start md:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-slate-900 text-white flex items-center justify-center font-black shrink-0">
            <Users className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="font-extrabold text-slate-900 text-base">{t('rotation.empTitle')}</h2>
              <Badge className="bg-teal-50 text-teal-900 border-teal-200 font-bold text-xs">

                {t('rotation.empActive')} {metrics.activeCount}  {t('rotation.empPeople')}
              </Badge>
              {metrics.onLeaveCount > 0 && (
                <Badge className="bg-amber-50 text-amber-900 border-amber-200 font-bold text-xs">

                  {t('rotation.empOnLeave')} {metrics.onLeaveCount}  {t('rotation.empPeople2')}
                </Badge>
              )}
              <span className="text-slate-300">|</span>
              <span className="text-xs text-slate-500 font-medium">

                {t('rotation.empCovering')} {metrics.allSkillsCount}  {t('rotation.empSkillsNote')}
              </span>
            </div>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex items-center gap-2 shrink-0">
          <DirectorySettings jobs={staffData?.jobs ?? []} levels={staffData?.levels ?? []} skills={staffData?.skills ?? []} />
          <Button
            variant="secondary"
            size="sm"
            onClick={handleRefetchAll}
            className="gap-1 text-xs font-semibold h-8"
            disabled={isStaffLoading}
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isStaffLoading ? 'animate-spin' : ''}`} />
            <span>{t('rotation.empRefresh')}</span>
          </Button>
          <Button
            className="bg-teal-600 hover:bg-teal-700 text-white font-bold text-xs shadow-xs gap-1.5 h-8 px-3"
            size="sm"
            onClick={handleOpenAddModal}
          >
            <Plus className="w-4 h-4" />
            <span>{t('rotation.empAdd')}</span>
          </Button>
        </div>
      </div>

      {/* 2. High-Density Search & Filter Toolbar */}
      <div className="bg-white p-3 rounded-2xl border border-slate-200 shadow-xs flex flex-col md:flex-row items-stretch md:items-center justify-between gap-2.5">
        <div className="flex items-center gap-2 flex-wrap flex-1">
          {/* 职位筛选 */}
          <select
            value={selectedJobFilter}
            onChange={(e) => setSelectedJobFilter(e.target.value)}
            className="h-8 px-2.5 rounded-xl border border-slate-200 bg-white text-xs font-semibold text-slate-700"
          >
            <option value="all">{t('rotation.empAllRoles')}</option>
            {Array.from(new Set(staffList.map((staff) => staff.jobTitle))).filter(Boolean).map((jobTitle) => (
              <option key={jobTitle} value={jobTitle}>
                {presetLabel(jobTitle)}
              </option>
            ))}
          </select>

          {/* 职级筛选 */}
          <select
            value={selectedLevelFilter}
            onChange={(e) => setSelectedLevelFilter(e.target.value)}
            className="h-8 px-2.5 rounded-xl border border-slate-200 bg-white text-xs font-semibold text-slate-700"
          >
            <option value="all">{t('rotation.empAllLevels')}</option>
            {Array.from(new Set(staffList.map((staff) => staff.level))).filter(Boolean).map((level) => (
              <option key={level} value={level}>
                {presetLabel(level)}
              </option>
            ))}
          </select>

          {/* 状态筛选 */}
          <select
            value={selectedStatusFilter}
            onChange={(e) => setSelectedStatusFilter(e.target.value)}
            className="h-8 px-2.5 rounded-xl border border-slate-200 bg-white text-xs font-semibold text-slate-700"
          >
            <option value="all">{t('rotation.empAllStatus')}</option>
            <option value="active">{t('rotation.empOnlyActive')}</option>
            <option value="on_leave">{t('rotation.empOnlyLeave')}</option>
            <option value="resigned">{t('rotation.empOnlyLeft')}</option>
          </select>
        </div>

        {/* 搜索框 */}
        <div className="relative w-full sm:w-64">
          <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-2.5" />
          <input
            type="text"
            placeholder={t('rotation.empSearchPlaceholder')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full h-8 pl-8 pr-2.5 rounded-xl border border-slate-200 bg-slate-50 text-xs focus:outline-none focus:border-teal-500 focus:bg-white transition-all"
          />
        </div>
      </div>



      {/* 3. High-Density Staff Cards with Can-Do & Cannot-Do Services */}
      {filteredStaff.length === 0 ? (
        <div className="p-16 text-center text-slate-400 bg-white rounded-2xl border border-slate-200">
          <Users className="w-10 h-10 mx-auto text-slate-300 mb-2" />
          <p className="font-bold text-slate-700">{t('rotation.empNoMatch')}</p>
          <p className="text-xs text-slate-400 mt-1">{t('rotation.empNoMatchHint')}</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
          {filteredStaff.map((staff) => {
            const { canDo, cannotDo } = getStaffServicesStatus(staff.skillIds);
            const isCannotDoExpanded = expandedCannotDoStaffId === staff.id;

            return (
              <Card
                key={staff.id}
                className="rounded-2xl border-2 border-slate-200 hover:border-teal-400 transition-all shadow-xs hover:shadow-md bg-white flex flex-col justify-between overflow-hidden"
              >
                <CardContent className="p-4 space-y-3">
                  {/* Row 1: Header Info & Status & Commission */}
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-2.5">
                      <div className="w-10 h-10 rounded-xl bg-slate-900 text-white flex items-center justify-center font-black text-base shadow-xs shrink-0">
                        {staff.name.slice(0, 1)}
                      </div>

                      <div className="space-y-0.5">
                        <div className="flex items-center gap-2 flex-wrap">
                          <h3 className="font-extrabold text-slate-900 text-base leading-tight">
                            {staff.name}
                          </h3>
                          <span className="font-mono text-[10px] text-slate-500 font-bold bg-slate-100 px-1.5 py-0.2 rounded">
                            {staff.employeeNo}
                          </span>
                          {getStatusBadge(staff.status)}
                        </div>

                        <div className="flex items-center gap-1.5 text-xs pt-0.5">
                          <Badge className="bg-teal-50 text-teal-900 border-teal-200 font-bold text-[10px]">
                            {presetLabel(staff.jobTitle)}
                          </Badge>
                          <Badge className="bg-purple-50 text-purple-900 border-purple-200 font-bold text-[10px]">
                            {presetLabel(staff.level)}
                          </Badge>
                          <span className="text-[11px] text-slate-400">· 📞 {formatPhoneDisplay(staff.phone)}</span>
                        </div>
                      </div>
                    </div>

                    <div className="text-right shrink-0">
                      <span className="text-xs font-mono font-black text-teal-700 bg-teal-50 px-2 py-0.5 rounded-lg border border-teal-200 block">

                        {t('rotation.empCommission')} {staff.payroll.ratePercent}% ({staff.payroll.base === 'net' ? t('rotation.empNetBasis') : t('rotation.empGrossBasis')})
                      </span>
                    </div>
                  </div>

                  {/* Row 2: Can-Do Services (可接项目) */}
                  <div className="p-2.5 rounded-xl bg-emerald-50/50 border border-emerald-200/80 space-y-1.5">
                    <div className="flex items-center justify-between text-xs font-bold text-emerald-950">
                      <span className="flex items-center gap-1">
                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                        <span>{t('rotation.empQualifiedPrefix')}{canDo.length}{t('rotation.empCountSuffix')}</span>
                      </span>
                      <span className="text-[10px] text-emerald-700 font-medium">{t('rotation.empPriorityDispatch')}</span>
                    </div>

                    <div className="flex flex-wrap gap-1">
                      {canDo.length > 0 ? (
                        canDo.map((srv) => (
                          <span
                            key={srv.id}
                            className="bg-white text-emerald-900 border border-emerald-300 text-[11px] font-semibold px-2 py-0.5 rounded-md shadow-2xs"
                          >
                            {srv.name}{srv.requiredSkillIds.length === 0 ? t('rotation.empNoSkillReq') : ''} (${centsToDollars(srv.priceCents)})
                          </span>
                        ))
                      ) : (
                        <span className="text-[11px] text-slate-400 italic">

                          {t('rotation.empNoQualified')}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Row 3: Cannot-Do Services (技能盲区 / 不可接项目) */}
                  <div className="p-2.5 rounded-xl bg-slate-50 border border-slate-200 space-y-1.5">
                    <div className="flex items-center justify-between text-xs font-bold text-slate-700">
                      <span className="flex items-center gap-1 text-slate-700">
                        <Ban className="w-3.5 h-3.5 text-slate-400" />
                        <span>{t('rotation.empBlockedPrefix')}{cannotDo.length}{t('rotation.empCountSuffix2')}</span>
                      </span>
                      <button
                        onClick={() =>
                          setExpandedCannotDoStaffId(isCannotDoExpanded ? null : staff.id)
                        }
                        className="text-[10px] text-teal-700 hover:text-teal-900 font-bold flex items-center gap-0.5"
                      >
                        <span>{isCannotDoExpanded ? t('rotation.empCollapse') : t('rotation.empExpand')}</span>
                        {isCannotDoExpanded ? (
                          <ChevronUp className="w-3 h-3" />
                        ) : (
                          <ChevronDown className="w-3 h-3" />
                        )}
                      </button>
                    </div>

                    {isCannotDoExpanded ? (
                      <div className="flex flex-wrap gap-1 pt-1">
                        {cannotDo.map((srv) => (
                          <span
                            key={srv.id}
                            className="bg-white text-slate-500 border border-dashed border-slate-300 text-[10px] font-medium px-1.5 py-0.2 rounded"
                          >
                            {srv.name}{srv.requiredSkillIds.length === 0 ? t('rotation.empNoSkillReq') : ''}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <p className="text-[11px] text-slate-400 truncate">
                        {cannotDo.map((s) => s.name).join('、') || t('rotation.empAllCategories')}
                      </p>
                    )}
                  </div>

                  {/* Note */}
                  {staff.note && (
                    <p className="text-[11px] text-slate-500 bg-slate-50 p-1.5 rounded-lg border border-slate-100">
                      📝 {staff.note}
                    </p>
                  )}
                </CardContent>

                {/* Card Action Footer */}
                <div className="p-2.5 bg-slate-50/80 border-t border-slate-100 flex items-center justify-between gap-2 text-xs">
                  <div className="flex items-center gap-1.5">
                    {staff.status === 'active' ? (
                      <button
                        onClick={() => handleToggleStatusWithConfirm(staff, 'on_leave')}
                        className="text-xs text-amber-700 hover:text-amber-900 font-semibold px-2 py-1 rounded hover:bg-amber-50"
                      >

                        {t('rotation.empMarkLeave')}
                      </button>
                    ) : (
                      <button
                        onClick={() => handleToggleStatusWithConfirm(staff, 'active')}
                        className="text-xs text-emerald-700 hover:text-emerald-900 font-semibold px-2 py-1 rounded hover:bg-emerald-50"
                      >

                        {t('rotation.empRestoreActive')}
                      </button>
                    )}
                    <button
                      onClick={() => handleDeleteStaffWithConfirm(staff)}
                      className="text-xs text-red-600 hover:text-red-800 font-semibold px-2 py-1 rounded hover:bg-red-50"
                    >

                      {t('rotation.empDelete')}
                    </button>
                  </div>

                  <Button
                    size="sm"
                    className="bg-teal-600 hover:bg-teal-700 text-white font-bold text-xs h-7.5 gap-1"
                    onClick={() => handleOpenEditModal(staff)}
                  >
                    <Edit2 className="w-3.5 h-3.5" />
                    <span>{t('rotation.empEditSkills')}</span>
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {/* ─────────────────────────────────────────────────────────────────── */}
      {/* 弹窗部分 (Modals)                                                  */}
      {/* ─────────────────────────────────────────────────────────────────── */}

      {/* 0. 通用二次防误触确认 Modal */}
      <Modal
        isOpen={Boolean(confirmModal)}
        onOpenChange={(open) => {
          if (!open) setConfirmModal(null);
        }}
        size="sm"
        title={confirmModal?.title || t('rotation.empConfirmTitle')}
        footer={
          <div className="flex justify-end gap-2 w-full">
            <Button variant="secondary" onClick={() => setConfirmModal(null)}>
              {t('cancel') || t('rotation.empConfirmCancel')}
            </Button>
            <Button
              className={
                confirmModal?.confirmTone === 'danger'
                  ? 'bg-red-600 hover:bg-red-700 text-white font-bold'
                  : confirmModal?.confirmTone === 'warning'
                    ? 'bg-amber-600 hover:bg-amber-700 text-white font-bold'
                    : 'bg-teal-600 hover:bg-teal-700 text-white font-bold'
              }
              onClick={handleExecuteConfirmModal}
              disabled={confirmPending}
            >
              {confirmPending ? t('rotation.empProcessing') : confirmModal?.confirmText || t('rotation.empConfirm')}
            </Button>
          </div>
        }
      >
        <div className="py-2 text-xs text-slate-700 font-medium leading-relaxed">
          {confirmModal?.description}
        </div>
      </Modal>

      {/* 1. 员工档案录入 / 编辑 Modal (带可做/不可做项目动态实时对比) */}
      <Modal
        isOpen={isFormModalOpen}
        onOpenChange={setIsFormModalOpen}
        size="lg"
        title={isEditing ? t('rotation.empEditTitle', { p0: formName }) : t('rotation.empAddTitle')}
        footer={
          <div className="flex justify-end gap-2 w-full">
            <Button variant="secondary" onClick={() => setIsFormModalOpen(false)}>
              {t('cancel') || t('rotation.empCancel')}
            </Button>
            <Button
              className="bg-teal-600 hover:bg-teal-700 text-white font-bold"
              onClick={handleSubmitFormWithConfirm}
            >
              {isEditing ? t('rotation.empSaveChanges') : t('rotation.empConfirmCreate')}
            </Button>
          </div>
        }
      >
        <div className="space-y-4 py-1 text-xs max-h-[72vh] overflow-y-auto pr-1">
          {/* 基本信息 */}
          <div>
            <h4 className="font-bold text-slate-900 text-xs mb-2 flex items-center gap-1.5">
              <User className="w-3.5 h-3.5 text-teal-600" />
              <span>{t('rotation.empBasicInfo')}</span>
            </h4>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="block font-bold text-slate-700 uppercase mb-1">

                  {t('rotation.empNameLabel')}
                </label>
                <Input
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  placeholder={t('rotation.empNamePlaceholder')}
                />
              </div>

              <div>
                <label className="block font-bold text-slate-700 uppercase mb-1">

                  {t('rotation.empNoLabel')}
                </label>
                <Input
                  value={formEmployeeNo}
                  onChange={(e) => setFormEmployeeNo(e.target.value)}
                  placeholder={t('rotation.empNoPlaceholder')}
                />
              </div>

              <div>
                <label className="block font-bold text-slate-700 uppercase mb-1">

                  {t('rotation.empPhoneLabel')}
                </label>
                <Input
                  value={formPhone}
                  onChange={(e) => setFormPhone(formatPhoneInput(e.target.value))}
                  placeholder="(555) 000-0000"
                  maxLength={14}
                />
              </div>

              <div>
                <label className="block font-bold text-slate-700 uppercase mb-1">

                  {t('rotation.empEmailLabel')}
                </label>
                <Input
                  value={formEmail}
                  onChange={(e) => setFormEmail(e.target.value)}
                  placeholder={t('rotation.empEmailPlaceholder')}
                />
              </div>

              <div>
                <label className="block font-bold text-slate-700 uppercase mb-1">

                  {t('rotation.empHireDate')}
                </label>
                <Input
                  type="date"
                  value={formHireDate}
                  onChange={(e) => setFormHireDate(e.target.value)}
                />
              </div>

              <div>
                <label className="block font-bold text-slate-700 uppercase mb-1">

                  {t('rotation.empStatusLabel')}
                </label>
                <select
                  value={formStatus}
                  onChange={(e) => setFormStatus(e.target.value as any)}
                  className="w-full h-10 px-3 rounded-xl border border-slate-200 bg-white text-xs font-medium text-slate-700"
                >
                  <option value="active">{t('rotation.empStatusActiveOpt')}</option>
                  <option value="on_leave">{t('rotation.empStatusLeaveOpt')}</option>
                  <option value="resigned">{t('rotation.empStatusLeftOpt')}</option>
                </select>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3 border-t pt-3">
            <label><input type="checkbox" checked={formBookable} onChange={(event) => setFormBookable(event.target.checked)} /> {t('rotation.empBookable')}</label>
            <label>{t('rotation.empConcurrency')}<Input type="number" min={1} max={5} value={String(formConcurrency)} onChange={(event) => setFormConcurrency(Number(event.target.value))} /></label>
          </div>
          {/* 职位与等级 */}
          <div className="pt-2 border-t border-slate-100">
            <h4 className="font-bold text-slate-900 text-xs mb-2 flex items-center gap-1.5">
              <Briefcase className="w-3.5 h-3.5 text-teal-600" />
              <span>{t('rotation.empRoleLevelTitle')}</span>
            </h4>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block font-bold text-slate-700 uppercase mb-1">
                  {t('rotation.empRoleLabel')}
                </label>
                <select
                  value={formJobTitleId}
                  onChange={(e) => setFormJobTitleId(e.target.value)}
                  className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm"
                >
                  <option value="">{t('rotation.empUnset')}</option>
                  {(staffData?.jobs ?? [])
                    .filter((option) => option.active || option.id === formJobTitleId)
                    .map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.name}{!option.active ? ` ${t('rotation.empOptionInactive')}` : ''}
                      </option>
                    ))}
                </select>
                {(staffData?.jobs ?? []).length === 0 && (
                  <p className="mt-1 text-[11px] text-amber-700">{t('rotation.empDirectoryEmptyHint')}</p>
                )}
              </div>

              <div>
                <label className="block font-bold text-slate-700 uppercase mb-1">
                  {t('rotation.empLevelLabel')}
                </label>
                <select
                  value={formLevelId}
                  onChange={(e) => setFormLevelId(e.target.value)}
                  className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm"
                >
                  <option value="">{t('rotation.empUnset')}</option>
                  {(staffData?.levels ?? [])
                    .filter((option) => option.active || option.id === formLevelId)
                    .map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.name}{!option.active ? ` ${t('rotation.empOptionInactive')}` : ''}
                      </option>
                    ))}
                </select>
                {(staffData?.levels ?? []).length === 0 && (
                  <p className="mt-1 text-[11px] text-amber-700">{t('rotation.empDirectoryEmptyHint')}</p>
                )}
              </div>
            </div>
          </div>

          {/* 技能勾选与实时可接/不可接项目动态预览 */}
          <div className="pt-2 border-t border-slate-100 space-y-2">
            <h4 className="font-bold text-slate-700 uppercase text-xs flex items-center justify-between">
              <span>{t('rotation.empSkillTagsTitle')}</span>
              <span className="text-[11px] text-teal-700 font-normal">{t('rotation.empSelected')} {formSkills.length}  {t('rotation.empSelectedUnit')}</span>
            </h4>

            {/* 技能标签选择 —— 只能勾选本店已有技能目录项（U02 / W2） */}
            <div className="flex flex-wrap gap-1.5">
              {Array.from(new Set([...(staffData?.skills ?? []).filter((skill) => skill.active).map((skill) => skill.id), ...formSkills])).map((skill) => {
                const isSelected = formSkills.includes(skill);
                const meta = staffData?.skills?.find((option) => option.id === skill);
                return (
                  <button
                    key={skill}
                    type="button"
                    onClick={() => toggleSkill(skill)}
                    className={`px-2.5 py-1 rounded-lg border text-xs font-medium transition-all ${
                      isSelected
                        ? 'bg-teal-600 text-white border-teal-700 font-bold shadow-xs'
                        : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                    }`}
                  >
                    {isSelected && '✓ '}
                    {presetLabel(skill)}
                    {meta && !meta.active ? ` ${t('rotation.empOptionInactive')}` : ''}
                  </button>
                );
              })}
            </div>
            {(staffData?.skills ?? []).length === 0 && (
              <p className="text-[11px] text-amber-700">{t('rotation.empDirectoryEmptyHint')}</p>
            )}

            {/* 动态对比：可做 vs 不可做项目 */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 pt-2">
              <div className="p-2.5 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-950 space-y-1">
                <p className="font-bold text-xs flex items-center gap-1">
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                  <span>{t('rotation.empUnlockedPrefix')}{formServiceStatus.canDo.length}{t('rotation.empCountSuffix3')}</span>
                </p>
                <div className="flex flex-wrap gap-1">
                  {formServiceStatus.canDo.length > 0 ? (
                    formServiceStatus.canDo.map((s) => (
                      <span
                        key={s.id}
                        className="bg-white text-emerald-900 border border-emerald-300 text-[10px] font-semibold px-1.5 py-0.2 rounded"
                      >
                        {s.name}{s.requiredSkillIds.length === 0 ? t('rotation.empNoSkillReq') : ''}
                      </span>
                    ))
                  ) : (
                    <span className="text-[11px] text-slate-400">{t('rotation.empNoUnlocked')}</span>
                  )}
                </div>
              </div>

              <div className="p-2.5 rounded-xl bg-slate-50 border border-slate-200 text-slate-700 space-y-1">
                <p className="font-bold text-xs flex items-center gap-1 text-slate-600">
                  <Ban className="w-3.5 h-3.5 text-slate-400" />
                  <span>{t('rotation.empStillBlockedPrefix')}{formServiceStatus.cannotDo.length}{t('rotation.empCountSuffix4')}</span>
                </p>
                <div className="flex flex-wrap gap-1">
                  {formServiceStatus.cannotDo.slice(0, 6).map((s) => (
                    <span
                      key={s.id}
                      className="bg-white text-slate-500 border border-dashed border-slate-300 text-[10px] px-1.5 py-0.2 rounded"
                    >
                      {s.name}
                    </span>
                  ))}
                  {formServiceStatus.cannotDo.length > 6 && (
                    <span className="text-[10px] text-slate-400">

                      {t('rotation.empAndMore')} {formServiceStatus.cannotDo.length}  {t('rotation.empMoreUnit')}
                    </span>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* 薪酬提成配置 */}
          <div className="pt-2 border-t border-slate-100">
            <h4 className="font-bold text-slate-900 text-xs mb-2 flex items-center gap-1.5">
              <DollarSign className="w-3.5 h-3.5 text-teal-600" />
              <span>{t('rotation.empPayTitle')}</span>
            </h4>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="block font-bold text-slate-700 uppercase mb-1">

                  {t('rotation.empPayMode')}
                </label>
                <select
                  value={formPlanKind}
                  onChange={(e) => setFormPlanKind(e.target.value as any)}
                  className="w-full h-10 px-3 rounded-xl border border-slate-200 bg-white text-xs font-medium text-slate-700"
                >
                  <option value="commission">{t('rotation.empPayCommission')}</option>
                  <option value="hourly">{t('rotation.empPayHourly')}</option>
                  <option value="commission_vs_hourly">{t('rotation.empPayHybrid')}</option>
                  <option value="booth_rent">{t('rotation.empPayBoothRent')}</option>
                </select>
              </div>

              <div>
                <label className="block font-bold text-slate-700 uppercase mb-1">

                  {t('rotation.empCommissionRate')}
                </label>
                <Input
                  type="number"
                  value={String(formRatePercent)}
                  onChange={(e) => setFormRatePercent(parseFloat(e.target.value) || 0)}
                />
              </div>

              <div>
                <label className="block font-bold text-slate-700 uppercase mb-1">

                  {t('rotation.empCommissionBasis')}
                </label>
                <select
                  value={formCommBase}
                  onChange={(e) => setFormCommBase(e.target.value as any)}
                  className="w-full h-10 px-3 rounded-xl border border-slate-200 bg-white text-xs font-medium text-slate-700"
                >
                  <option value="net">{t('rotation.empBasisNet')}</option>
                  <option value="gross">{t('rotation.empBasisGross')}</option>
                </select>
              </div>
            </div>
          </div>

          {formPlanKind !== 'commission' && <label className="block">{t('rotation.empHourlyRate')}<Input type="number" min={0} step="0.01" value={String(formHourlyRate)} onChange={(event) => setFormHourlyRate(Number(event.target.value))} /></label>}
          {/* 备注 */}
          <div className="pt-2 border-t border-slate-100">
            <label className="block font-bold text-slate-700 uppercase mb-1">

              {t('rotation.empNotes')}
            </label>
            <Input
              value={formNote}
              onChange={(e) => setFormNote(e.target.value)}
              placeholder={t('rotation.empNotesPlaceholder')}
            />
          </div>
        </div>
      </Modal>
    </div>
  );
}

export function EmployeePerformance() {
  return (
    <ErrorBoundary fallbackTitleKey="employeePerformance">
      <EmployeePerformanceContent />
    </ErrorBoundary>
  );
}
