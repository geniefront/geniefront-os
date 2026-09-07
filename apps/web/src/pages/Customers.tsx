import { useEffect, useMemo, useState } from 'react';
import { Spinner, toast } from '@heroui/react';
import {
  Search,
  Users,
  AlertTriangle,
  Gift,
  FileText,
  Phone,
  Mail,
  UserPlus,
  Calendar,
  Receipt,
  Crown,
  Send,
  Activity,
  Clock,
  HeartHandshake,
  LayoutGrid,
  List,
  Edit2,
  Ban,
  GitMerge,
  Download,
  Sliders,
} from 'lucide-react';
import { useLanguage } from '@/LanguageContext';
import {
  useCustomerList,
  useCustomerDetail,
  useSaveCustomerProfile,
  useSaveCustomerPreferences,
  useSetCustomerBlocked,
  useMergeCustomers,
  useSendCustomerSms,
} from '@/features/customers/api';
import type { CustomerListRow } from '@/features/customers/types';
import { centsToDollars } from '@/features/checkout/api';
import { Card, CardContent } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { GuardedButton } from '@/components/ui/GuardedButton';
import { useCan } from '@/lib/permissions';
import { Input } from '@/components/ui/Input';
import { BirthdateField } from '@/components/ui/BirthdateField';
import { parseBirthdate } from '@gf/contracts';
import { useStoreTime, instantToWallDate } from '@/lib/time';
import { Badge } from '@/components/ui/Badge';
import { PageHeader } from '@/components/ui/PageHeader';
import { EmptyState } from '@/components/ui/EmptyState';
import { Modal } from '@/components/ui/Modal';
import { ActionMenu } from '@/components/ui/ActionMenu';
import { cn, formatPhoneDisplay, formatPhoneInput } from '@/lib/utils';
import { useErrorMessage } from '@/lib/errorMessage';
import { ticketStatusI18nKey } from '@/features/tickets/orderDisplay';
import { hasAllergyContent, formatAllergies } from '@/features/customers/allergies';
import { fuzzySearch } from '@/lib/fuzzySearch';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { PageLoading, PageError } from '@/components/ui/QueryState';
import type { TranslationKey } from '@/i18n';

type ViewMode = 'split' | 'table';

// 常用禁忌预设芯片 Key 映射
const ALLERGY_CHIP_KEYS: TranslationKey[] = [
  'allergyLavender',
  'allergyAlcohol',
  'allergyLatex',
  'allergyPregnancy',
  'allergySensitiveSkin',
  'allergySpinePressure',
];

// 常用偏好预设芯片 Key 映射
const PREF_CHIP_KEYS: TranslationKey[] = [
  'prefQuiet',
  'prefHeavyPressure',
  'prefLightPressure',
  'prefWarmTea',
  'prefShortNails',
  'prefFemaleTherapist',
];

// 快捷短信模板 Key 映射
const SMS_TEMPLATE_CONFIG: { labelKey: TranslationKey; textKey: TranslationKey }[] = [
  { labelKey: 'smsBookingConfirmLabel', textKey: 'smsBookingConfirmContent' },
  { labelKey: 'smsBirthdayLabel', textKey: 'smsBirthdayContent' },
  { labelKey: 'smsWinbackLabel', textKey: 'smsWinbackContent' },
  { labelKey: 'smsNewServiceLabel', textKey: 'smsNewServiceContent' },
];

function Money({ cents, hiddenLabel }: { cents: number | null; hiddenLabel: string }) {
  if (cents === null) {
    return <span className="text-slate-400 text-xs">{hiddenLabel}</span>;
  }
  return <span className="tabular-nums font-bold">${centsToDollars(cents)}</span>;
}

function CustomersContent() {
  const errorMessage = useErrorMessage();
  const { t } = useLanguage();
  const { timeZone } = useStoreTime();
  const storeToday = instantToWallDate(new Date().toISOString(), timeZone);
  const canViewContact = useCan('customer.view_contact');

  // 从 URL 初始化默认选中 ID（如 /customers/cust_123）
  const initialId = useMemo(() => {
    const match = window.location.pathname.match(/\/customers\/([^/]+)/);
    return match ? match[1] : null;
  }, []);

  // 视图与筛选状态
  const [viewMode, setViewMode] = useState<ViewMode>('split');
  const [query, setQuery] = useState('');
  const [filterType, setFilterType] = useState<'all' | 'vip' | 'active30' | 'sleep30' | 'sleep90'>('all');
  const [selectedId, setSelectedId] = useState<string | null>(initialId);
  const [activeTab, setActiveTab] = useState<'orders' | 'giftcards' | 'forms'>('orders');

  // Mutations
  const saveProfileMutation = useSaveCustomerProfile();
  const savePreferencesMutation = useSaveCustomerPreferences();
  const setBlockedMutation = useSetCustomerBlocked();
  const mergeMutation = useMergeCustomers();
  const sendSmsMutation = useSendCustomerSms();

  // Modals state
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [editProfileOpen, setEditProfileOpen] = useState(false);
  const [editPrefOpen, setEditPrefOpen] = useState(false);
  const [mergeModalOpen, setMergeModalOpen] = useState(false);
  const [smsModalOpen, setSmsModalOpen] = useState(false);
  const [blockModalOpen, setBlockModalOpen] = useState(false);

  // Form states
  const [formName, setFormName] = useState('');
  const [formPhone, setFormPhone] = useState('');
  const [formEmail, setFormEmail] = useState('');
  const [formVip, setFormVip] = useState('0');
  const [formTags, setFormTags] = useState('');
  const [formBirthday, setFormBirthday] = useState('');
  const [formGender, setFormGender] = useState<'female' | 'male' | 'other' | 'unspecified'>('unspecified');
  const [formSource, setFormSource] = useState('Walk-in Walk-in Guest');
  const [formNotes, setFormNotes] = useState('');

  // Preferences form state
  const [prefAllergies, setPrefAllergies] = useState('');
  const [prefNotes, setPrefNotes] = useState('');

  // Merge form state
  const [mergeSearchQuery, setMergeSearchQuery] = useState('');
  const [selectedSourceCustomer, setSelectedSourceCustomer] = useState<CustomerListRow | null>(null);

  // SMS form state
  const [smsContent, setSmsContent] = useState('');

  // Block reason state
  const [blockReason, setBlockReason] = useState(() => t('crm.custBlockReasonDefault'));

  // 查询数据
  const listParams = useMemo(() => ({ limit: 200 }), []);
  const list = useCustomerList(listParams);
  const rawRows: CustomerListRow[] = list.data?.rows ?? [];

  // 计算顶部全量汇总指标 (基于门店全部客户基准，不随过滤折叠)
  const metrics = useMemo(() => {
    const total = rawRows.length;
    const vipCount = rawRows.filter((r) => r.vipLevel > 0).length;
    const active30 = rawRows.filter(
      (r) => r.daysSinceLastVisit !== null && r.daysSinceLastVisit <= 30,
    ).length;
    const sleep30 = rawRows.filter(
      (r) => r.daysSinceLastVisit !== null && r.daysSinceLastVisit > 30,
    ).length;
    const sleep90 = rawRows.filter(
      (r) => r.daysSinceLastVisit !== null && r.daysSinceLastVisit > 90,
    ).length;

    return {
      total: list.data?.total ?? total,
      vipCount,
      active30,
      sleep30,
      sleep90,
    };
  }, [rawRows, list.data?.total]);

  // 1. 容错模糊搜索过滤（即使姓名拼写打错或输入手机尾号也能搜到）
  const searchedRows = useMemo(() => {
    if (!query.trim()) return rawRows;
    return fuzzySearch(rawRows, query, {
      keys: [
        { name: 'displayName', weight: 0.7 },
        { name: 'phone', weight: 0.3 },
      ],
      threshold: 0.45,
    });
  }, [rawRows, query]);

  // 2. 根据当前选中的分群药丸标签过滤显示列表
  const rows = useMemo(() => {
    return searchedRows.filter((r) => {
      if (filterType === 'vip') return r.vipLevel > 0;
      if (filterType === 'active30')
        return r.daysSinceLastVisit !== null && r.daysSinceLastVisit <= 30;
      if (filterType === 'sleep30')
        return r.daysSinceLastVisit !== null && r.daysSinceLastVisit > 30;
      if (filterType === 'sleep90')
        return r.daysSinceLastVisit !== null && r.daysSinceLastVisit > 90;
      return true;
    });
  }, [searchedRows, filterType]);

  // 丝滑选择顾客 (使用 replaceState 同步 URL，零组件卸载重载)
  const handleSelectCustomer = (id: string) => {
    setSelectedId(id);
    window.history.replaceState(null, '', `/customers/${id}`);
  };

  // 如果没有选中的顾客或当前选中的顾客在当前筛选结果中不存在，自动选中当前筛选列表的第一位
  useEffect(() => {
    if (rows.length > 0 && viewMode === 'split') {
      const isCurrentInRows = rows.some((r) => r.id === selectedId);
      if (!selectedId || !isCurrentInRows) {
        handleSelectCustomer(rows[0]!.id);
      }
    }
  }, [rows, selectedId, viewMode]);

  // 客户详情查询
  const detail = useCustomerDetail(selectedId);
  const currentDetail = detail.data;

  // 智能合并弹窗搜索候选列表 (容错模糊搜索)
  const mergeCandidates = useMemo(() => {
    const candidates = rawRows.filter((r) => r.id !== selectedId);
    if (!mergeSearchQuery.trim()) return candidates.slice(0, 5);
    return fuzzySearch(candidates, mergeSearchQuery, {
      keys: ['displayName', 'phone'],
      threshold: 0.45,
    });
  }, [rawRows, mergeSearchQuery, selectedId]);

  // 打开新建弹窗
  const handleOpenCreateModal = () => {
    setFormName('');
    setFormPhone('');
    setFormEmail('');
    setFormVip('0');
    setFormTags('');
    setFormBirthday('');
    setFormGender('unspecified');
    setFormSource('Walk-in Walk-in Guest');
    setFormNotes('');
    setCreateModalOpen(true);
  };

  // 打开编辑基本信息弹窗
  const handleOpenEditProfile = () => {
    if (!currentDetail) return;
    setFormName(currentDetail.displayName);
    setFormPhone(formatPhoneDisplay(currentDetail.phone) || '');
    setFormEmail(currentDetail.email || '');
    setFormVip(String(currentDetail.vipLevel));
    setFormTags((currentDetail.tags || []).join(', '));
    setFormBirthday(currentDetail.birthday || '');
    setFormGender((currentDetail.gender as any) || 'unspecified');
    setFormSource(currentDetail.source || 'Walk-in Walk-in Guest');
    setFormNotes(currentDetail.notes || '');
    setEditProfileOpen(true);
  };

  // 打开偏好与禁忌弹窗
  const handleOpenEditPref = () => {
    if (!currentDetail) return;
    setPrefAllergies(
      hasAllergyContent(currentDetail.preferences.allergies)
        ? formatAllergies(currentDetail.preferences.allergies)
        : '',
    );
    setPrefNotes(currentDetail.preferences.freeNotes || '');
    setEditPrefOpen(true);
  };

  // 生日校验：留空放行；填了就按门店日历今天判有效性 / 未来
  const birthdayError = (): string | null => {
    if (!formBirthday.trim()) return null;
    const r = parseBirthdate(formBirthday, { today: storeToday, optional: true });
    if (r.ok) return null;
    return r.reason === 'future' ? t('crm.custBirthdayFuture') : t('crm.custBirthdayInvalid');
  };

  // 提交新建顾客
  const handleCreateCustomer = async () => {
    if (!formName.trim()) {
      toast.danger(t('crm.custNameRequired'));
      return;
    }
    const be = birthdayError();
    if (be) { toast.danger(be); return; }
    try {
      const res = await saveProfileMutation.mutateAsync({
        name: formName.trim(),
        phoneE164: formPhone.trim() || undefined,
        email: formEmail.trim() || undefined,
        vipLevel: parseInt(formVip, 10) || 0,
        tags: formTags
          .split(/[,，]/)
          .map((t) => t.trim())
          .filter(Boolean),
        birthday: formBirthday.trim() || undefined,
        gender: formGender,
      });
      toast.success(t('crm.custCreated', { p0: formName.trim() }));
      setCreateModalOpen(false);
      if (res.customerId) {
        handleSelectCustomer(res.customerId);
      }
    } catch (err: any) {
      toast.danger(errorMessage(err));
    }
  };

  // 保存基本信息编辑
  const handleSaveProfile = async () => {
    if (!selectedId || !formName.trim()) {
      toast.danger(t('crm.custNameRequired2'));
      return;
    }
    const be = birthdayError();
    if (be) { toast.danger(be); return; }
    try {
      await saveProfileMutation.mutateAsync({
        customerId: selectedId,
        name: formName.trim(),
        phoneE164: formPhone.trim() || undefined,
        email: formEmail.trim() || undefined,
        vipLevel: parseInt(formVip, 10) || 0,
        tags: formTags
          .split(/[,，]/)
          .map((t) => t.trim())
          .filter(Boolean),
        birthday: formBirthday.trim() || undefined,
        gender: formGender,
      });
      toast.success(t('crm.custSaved', { p0: formName.trim() }));
      setEditProfileOpen(false);
    } catch (err: any) {
      toast.danger(errorMessage(err));
    }
  };

  // 保存偏好与禁忌
  const handleSavePref = async () => {
    if (!selectedId) return;
    try {
      await savePreferencesMutation.mutateAsync({
        customerId: selectedId,
        allergies: { customNotes: prefAllergies.trim() || undefined },
        freeNotes: prefNotes.trim() || undefined,
      });
      toast.success(t('crm.custPrefsSaved'));
      setEditPrefOpen(false);
    } catch (err: any) {
      toast.danger(errorMessage(err));
    }
  };

  // 智能合并重复档案
  const handleSmartMerge = async () => {
    if (!selectedId || !selectedSourceCustomer) return;
    try {
      await mergeMutation.mutateAsync({
        sourceCustomerId: selectedSourceCustomer.id,
        targetCustomerId: selectedId,
      });
      toast.success(
        t('crm.custMerged', { p0: selectedSourceCustomer.displayName, p1: currentDetail?.displayName ?? '' }),
      );
      setMergeModalOpen(false);
      setSelectedSourceCustomer(null);
    } catch (err: any) {
      toast.danger(errorMessage(err));
    }
  };

  // Send SMS
  const handleSendSms = async () => {
    if (!selectedId || !smsContent.trim()) return;
    try {
      await sendSmsMutation.mutateAsync({
        customerId: selectedId,
        body: smsContent.trim(),
      });
      toast.success(t('crm.custSmsSent', { p0: currentDetail?.displayName ?? '' }));
      setSmsModalOpen(false);
    } catch (err: any) {
      toast.danger(errorMessage(err));
    }
  };

  // 黑名单确认
  const handleConfirmBlock = async () => {
    if (!selectedId) return;
    const isCurrentlyBlocked = Boolean(currentDetail?.blockedAt);
    try {
      await setBlockedMutation.mutateAsync({
        customerId: selectedId,
        blocked: !isCurrentlyBlocked,
        reason: !isCurrentlyBlocked ? blockReason : undefined,
      });
      toast.success(
        !isCurrentlyBlocked
          ? t('crm.custBlocked', { p0: currentDetail?.displayName ?? '' })
          : t('crm.custUnblocked', { p0: currentDetail?.displayName ?? '' }),
      );
      setBlockModalOpen(false);
    } catch (err: any) {
      toast.danger(errorMessage(err));
    }
  };

  // 导出 CSV
  const handleExportCsv = () => {
    if (rows.length === 0) {
      toast.danger(t('crm.custNoExportData'));
      return;
    }
    const headers = [
      t('crm.custExportName'), t('crm.custExportVipLevel'), t('crm.custExportPhone'),
      t('crm.custExportVisitCount'), t('crm.custExportDaysSinceVisit'), t('crm.custExportNoShowCount'),
    ];
    const csvContent = [
      headers.join(','),
      ...rows.map((r) => {
        const phone = canViewContact
          ? (r.phone || '')
          : (r.phone ? r.phone.replace(/(\+?1)?(\d{3})\d{3}(\d{4})/, '$2-***-$3') : '');
        return [
          `"${r.displayName}"`,
          r.vipLevel,
          `"${phone}"`,
          r.visitCount,
          r.daysSinceLastVisit ?? t('crm.custExportNeverVisited'),
          r.noShowCount,
        ].join(',');
      }),
    ].join('\n');

    const blob = new Blob(['\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `GenieFront_${t('crm.custExportFileSlug')}_${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
    toast.success(t('crm.custExported'));
  };

  if (list.isLoading && rawRows.length === 0) {
    return <PageLoading title={t('crm.custLoading')} description={t('crm.custLoadingDesc')} />;
  }

  if (list.error && rawRows.length === 0) {
    return <PageError title={t('crm.custLoadError')} error={list.error} onRetry={list.refetch} />;
  }

  return (
    <div className="space-y-4 max-w-7xl mx-auto w-full pb-16">
      {/* 1. Page Header */}
      <PageHeader
        title={t('crm.custTitle')}
        description={t('crm.custDesc')}
        actions={
          <div className="flex items-center gap-2">
            <GuardedButton
              permission="customer.view_contact"
              fallback="disable"
              variant="secondary"
              size="sm"
              onClick={handleExportCsv}
              className="gap-1.5 text-xs font-semibold"
            >
              <Download className="w-3.5 h-3.5 text-slate-600" />
              <span>{t('crm.custExportCsv')}</span>
            </GuardedButton>
            <Button
              size="sm"
              className="bg-teal-600 hover:bg-teal-700 text-white font-bold text-xs shadow-xs gap-1.5"
              onClick={handleOpenCreateModal}
            >
              <UserPlus className="w-3.5 h-3.5" />
              <span>{t('crm.custCreate')}</span>
            </Button>
          </div>
        }
      />

      {/* 2. High-Density Operational Status & Filter Strip */}
      <div className="bg-white p-2.5 rounded-2xl border border-slate-200 shadow-xs flex flex-wrap items-center justify-between gap-2">
        {/* Quick Filter Pills */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <button
            onClick={() => setFilterType('all')}
            className={`flex items-center gap-1.5 px-3 py-1 rounded-xl border text-xs font-bold transition-all ${
              filterType === 'all'
                ? 'bg-slate-900 text-white border-slate-900 shadow-xs'
                : 'bg-slate-100 text-slate-700 border-slate-200 hover:bg-slate-200'
            }`}
          >
            <Users className="w-3.5 h-3.5" />
            <span>{t('crm.custFilterAll')}</span>
            <strong className="font-mono text-sm ml-0.5">{metrics.total}</strong>
          </button>

          <button
            onClick={() => setFilterType(filterType === 'vip' ? 'all' : 'vip')}
            className={`flex items-center gap-1.5 px-3 py-1 rounded-xl border text-xs font-bold transition-all ${
              filterType === 'vip'
                ? 'bg-amber-600 text-white border-amber-700 shadow-xs'
                : 'bg-amber-50 text-amber-900 border-amber-200 hover:bg-amber-100'
            }`}
          >
            <Crown className="w-3.5 h-3.5" />
            <span>{t('crm.custFilterVip')}</span>
            <strong className="font-mono text-sm ml-0.5">{metrics.vipCount}</strong>
          </button>

          <button
            onClick={() => setFilterType(filterType === 'active30' ? 'all' : 'active30')}
            className={`flex items-center gap-1.5 px-3 py-1 rounded-xl border text-xs font-bold transition-all ${
              filterType === 'active30'
                ? 'bg-emerald-600 text-white border-emerald-700 shadow-xs'
                : 'bg-emerald-50 text-emerald-900 border-emerald-200 hover:bg-emerald-100'
            }`}
          >
            <Activity className="w-3.5 h-3.5" />
            <span>{t('crm.custFilterActive30')}</span>
            <strong className="font-mono text-sm ml-0.5">{metrics.active30}</strong>
          </button>

          <button
            onClick={() => setFilterType(filterType === 'sleep30' ? 'all' : 'sleep30')}
            className={`flex items-center gap-1.5 px-3 py-1 rounded-xl border text-xs font-bold transition-all ${
              filterType === 'sleep30'
                ? 'bg-indigo-600 text-white border-indigo-700 shadow-xs'
                : 'bg-indigo-50 text-indigo-900 border-indigo-200 hover:bg-indigo-100'
            }`}
          >
            <Clock className="w-3.5 h-3.5" />
            <span>{t('crm.custFilterDormant30')}</span>
            <strong className="font-mono text-sm ml-0.5">{metrics.sleep30}</strong>
          </button>

          <button
            onClick={() => setFilterType(filterType === 'sleep90' ? 'all' : 'sleep90')}
            className={`flex items-center gap-1.5 px-3 py-1 rounded-xl border text-xs font-bold transition-all ${
              filterType === 'sleep90'
                ? 'bg-purple-600 text-white border-purple-700 shadow-xs'
                : 'bg-purple-50 text-purple-900 border-purple-200 hover:bg-purple-100'
            }`}
          >
            <HeartHandshake className="w-3.5 h-3.5" />
            <span>{t('crm.custFilterWinback90')}</span>
            <strong className="font-mono text-sm ml-0.5">{metrics.sleep90}</strong>
          </button>
        </div>

        {/* Right: Search Input & View Switcher */}
        <div className="flex items-center gap-2">
          <div className="relative w-48 sm:w-56">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-2.5" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('crm.custSearchPlaceholder')}
              className="w-full h-8 pl-8 pr-2.5 rounded-xl border border-slate-200 bg-slate-50/50 text-xs placeholder:text-slate-400 focus:outline-none focus:border-teal-500 focus:bg-white transition-all"
            />
          </div>

          <div className="flex items-center bg-slate-100 p-0.5 rounded-xl border border-slate-200">
            <button
              onClick={() => setViewMode('split')}
              className={`p-1.5 rounded-lg transition-all ${
                viewMode === 'split' ? 'bg-white shadow-xs text-slate-900' : 'text-slate-400'
              }`}
              title={t('crm.custSplitView')}
            >
              <LayoutGrid className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setViewMode('table')}
              className={`p-1.5 rounded-lg transition-all ${
                viewMode === 'table' ? 'bg-white shadow-xs text-slate-900' : 'text-slate-400'
              }`}
              title={t('crm.custTableView')}
            >
              <List className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* 3. Main Workspace: Split View vs Full Table View */}
      {viewMode === 'split' ? (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
          {/* Left Customer List (4 cols) */}
          <Card className="lg:col-span-4 overflow-hidden rounded-2xl border-slate-200 shadow-xs flex flex-col h-[700px]">
            <div className="p-3 border-b border-slate-100 bg-slate-50/60 flex items-center justify-between">
              <span className="text-xs font-bold text-slate-700">
                
                {t('crm.custDirectoryTitle')}{rows.length})
              </span>
              <span className="text-[11px] text-slate-400">{t('crm.custDirectoryHint')}</span>
            </div>

            <div className="flex-1 overflow-y-auto divide-y divide-slate-100 p-1.5 custom-scrollbar">
              {rows.length === 0 ? (
                <div className="p-8 text-center text-slate-400 text-xs">
                  <Users className="w-8 h-8 mx-auto mb-2 text-slate-300" />
                  <p>{t('crm.custNoMatch')}</p>
                </div>
              ) : (
                rows.map((row) => {
                  const isSelected = row.id === selectedId;
                  return (
                    <div
                      key={row.id}
                      onClick={() => handleSelectCustomer(row.id)}
                      className={cn(
                        'p-2.5 rounded-xl cursor-pointer transition-all mb-1 border',
                        isSelected
                          ? 'bg-teal-50/90 border-teal-500 shadow-xs text-teal-950 font-bold'
                          : 'bg-white border-transparent hover:bg-slate-50 hover:border-slate-200 text-slate-700',
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <div
                            className={cn(
                              'w-7 h-7 rounded-lg flex items-center justify-center font-bold text-xs shrink-0',
                              isSelected
                                ? 'bg-teal-600 text-white'
                                : 'bg-slate-100 text-slate-600',
                            )}
                          >
                            {row.displayName.slice(0, 1).toUpperCase()}
                          </div>
                          <div className="truncate">
                            <span className="text-xs font-black text-slate-900">
                              {row.displayName}
                            </span>
                            {row.vipLevel > 0 && (
                              <Badge className="ml-1.5 bg-amber-100 text-amber-900 border-amber-300 text-[10px] px-1 py-0 font-bold">
                                VIP {row.vipLevel}
                              </Badge>
                            )}
                          </div>
                        </div>

                        <span className="text-[11px] font-mono text-slate-400 shrink-0">
                          {row.phone ? formatPhoneDisplay(row.phone) : t('crm.custNoPhone')}
                        </span>
                      </div>

                      <div className="flex items-center justify-between gap-2 mt-1.5 text-[11px] text-slate-500">
                        <span>{t('crm.custVisits')} {row.visitCount}  {t('crm.custVisitUnit')}</span>
                        <span>
                          {row.daysSinceLastVisit === null
                            ? t('crm.custNewPending')
                            : t('crm.custDaysAgo', { p0: row.daysSinceLastVisit })}
                        </span>
                        {row.noShowCount > 0 && (
                          <span className="text-red-600 font-bold bg-red-50 px-1.5 py-0.2 rounded text-[10px]">
                            
                            {t('crm.custNoShows')} {row.noShowCount}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </Card>

          {/* Right Customer 360 Profile (8 cols) */}
          <Card className="lg:col-span-8 overflow-hidden rounded-2xl border-slate-200 flex flex-col h-[700px] shadow-xs bg-white">
            {!selectedId ? (
              <div className="h-full grid place-items-center">
                <EmptyState icon={<Users className="w-10 h-10 text-slate-300" />} title={t('crm.custPickFromList')} />
              </div>
            ) : detail.isLoading && !currentDetail ? (
              <div className="h-full grid place-items-center">
                <div className="flex flex-col items-center gap-2">
                  <Spinner />
                  <p className="text-xs text-slate-400 font-medium">{t('crm.custLoadingProfile')}</p>
                </div>
              </div>
            ) : currentDetail ? (
              <div className="flex-1 overflow-y-auto p-4 space-y-4 custom-scrollbar">
                {/* 1. Header Profile Banner */}
                <div className="p-4 rounded-2xl bg-gradient-to-r from-teal-500/10 via-emerald-500/5 to-white border border-teal-200/80 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 shadow-xs">
                  <div className="flex items-center gap-3">
                    <div className="w-12 h-12 rounded-2xl bg-gradient-to-tr from-teal-600 to-emerald-500 text-white flex items-center justify-center font-black text-xl shadow-xs shrink-0">
                      {currentDetail.displayName.slice(0, 1).toUpperCase()}
                    </div>
                    <div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <h3 className="text-lg font-black text-slate-900">
                          {currentDetail.displayName}
                        </h3>
                        {currentDetail.vipLevel > 0 ? (
                          <Badge className="bg-amber-100 text-amber-900 border-amber-300 font-black text-xs">
                            ⭐ VIP {currentDetail.vipLevel}
                          </Badge>
                        ) : (
                          <Badge className="bg-slate-100 text-slate-600 border-slate-200 text-xs">
                            {t('standardMember')}
                          </Badge>
                        )}
                        {currentDetail.blockedAt && (
                          <Badge className="bg-red-100 text-red-800 border-red-300 font-black text-xs">
                            
                            {t('crm.custBlockedBadge')}
                          </Badge>
                        )}
                      </div>

                      <div className="flex items-center gap-3 text-xs text-slate-600 mt-1 flex-wrap font-medium">
                        <span className="flex items-center gap-1">
                          <Phone className="w-3.5 h-3.5 text-slate-400" />
                          <span className="font-mono">{currentDetail.phone ? formatPhoneDisplay(currentDetail.phone) : t('crm.custNoPhone2')}</span>
                        </span>
                        {currentDetail.email && (
                          <span className="flex items-center gap-1">
                            <Mail className="w-3.5 h-3.5 text-slate-400" />
                            <span>{currentDetail.email}</span>
                          </span>
                        )}
                        {currentDetail.birthday && (
                          <span className="flex items-center gap-1">
                            <Calendar className="w-3.5 h-3.5 text-slate-400" />
                            <span>{t('crm.custBirthday')} {currentDetail.birthday}</span>
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Actions Toolbar */}
                  <div className="flex items-center gap-1.5 w-full sm:w-auto justify-end flex-wrap">
                    <Button
                      size="sm"
                      className="bg-teal-600 hover:bg-teal-700 text-white font-bold text-xs h-8 gap-1 shadow-xs"
                      onClick={() => setSmsModalOpen(true)}
                    >
                      <Send className="w-3.5 h-3.5" />
                      <span>{t('crm.custSendSms')}</span>
                    </Button>

                    <Button
                      variant="secondary"
                      size="sm"
                      className="text-xs font-bold h-8 gap-1"
                      onClick={handleOpenEditPref}
                    >
                      <Sliders className="w-3.5 h-3.5 text-slate-600" />
                      <span>{t('crm.custPrefsButton')}</span>
                    </Button>

                    <ActionMenu
                      label={t('crm.custMoreActions')}
                      items={[
                        {
                          id: 'edit',
                          label: t('crm.custEditBasic'),
                          icon: <Edit2 className="w-3.5 h-3.5" />,
                          onSelect: handleOpenEditProfile,
                        },
                        {
                          id: 'merge',
                          label: t('crm.custMergeDuplicates'),
                          icon: <GitMerge className="w-3.5 h-3.5 text-indigo-600" />,
                          onSelect: () => {
                            setMergeSearchQuery('');
                            setSelectedSourceCustomer(null);
                            setMergeModalOpen(true);
                          },
                        },
                        {
                          id: 'block',
                          label: currentDetail.blockedAt ? t('crm.custUnblock') : t('crm.custBlock'),
                          icon: <Ban className="w-3.5 h-3.5" />,
                          tone: !currentDetail.blockedAt ? 'danger' : 'default',
                          onSelect: () => setBlockModalOpen(true),
                        },
                      ]}
                    />
                  </div>
                </div>

                {/* 2. Four Core Financial & Loyalty KPIs (High Density) */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                  <div className="p-2.5 rounded-xl bg-slate-50 border border-slate-200">
                    <span className="text-[11px] font-bold text-slate-500 uppercase block">
                      
                      {t('crm.custTotalVisits')}
                    </span>
                    <p className="text-base font-black text-slate-900 mt-0.5">
                      {currentDetail.visits.total}  {t('crm.custVisitUnit2')}
                    </p>
                  </div>

                  <div className="p-2.5 rounded-xl bg-slate-50 border border-slate-200">
                    <span className="text-[11px] font-bold text-slate-500 uppercase block">
                      
                      {t('crm.custFirstVisit')}
                    </span>
                    <p className="text-base font-black text-slate-900 mt-0.5 font-mono">
                      {currentDetail.visits.firstAt || t('crm.custNewPending2')}
                    </p>
                  </div>

                  <div className="p-2.5 rounded-xl bg-slate-50 border border-slate-200">
                    <span className="text-[11px] font-bold text-slate-500 uppercase block">
                      
                      {t('crm.custLtv')}
                    </span>
                    <p className="text-base font-black text-emerald-700 mt-0.5">
                      <Money cents={currentDetail.visits.lifetimeSpendCents} hiddenLabel="***" />
                    </p>
                  </div>

                  <div className="p-2.5 rounded-xl bg-slate-50 border border-slate-200">
                    <span className="text-[11px] font-bold text-slate-500 uppercase block">
                      
                      {t('crm.custAvgTicket')}
                    </span>
                    <p className="text-base font-black text-teal-700 mt-0.5">
                      <Money cents={currentDetail.visits.avgSpendCents} hiddenLabel="***" />
                    </p>
                  </div>
                </div>

                {/* 3. Health Allergies & Service Preferences Block */}
                <div className="p-3 bg-amber-50/50 border border-amber-200/80 rounded-2xl space-y-2 text-xs">
                  <div className="flex items-center justify-between">
                    <span className="font-black text-amber-950 flex items-center gap-1.5">
                      <AlertTriangle className="w-4 h-4 text-amber-600" />
                      <span>{t('crm.custContraindications')}</span>
                    </span>
                    <button
                      onClick={handleOpenEditPref}
                      className="text-amber-800 hover:underline font-bold text-[11px]"
                    >
                      
                      {t('crm.custEditContraindications')}
                    </button>
                  </div>

                  {hasAllergyContent(currentDetail.preferences.allergies) ? (
                    <div className="p-2 bg-white rounded-xl border border-amber-200 text-red-700 font-bold">
                      {formatAllergies(currentDetail.preferences.allergies)}
                    </div>
                  ) : (
                    <p className="text-slate-400 text-[11px]">{t('crm.custNoContraindications')}</p>
                  )}

                  {/* Service Preferences Notes */}
                  <div className="pt-2 border-t border-amber-100">
                    <span className="font-bold text-slate-700 block mb-1">
                      
                      {t('crm.custServiceNotes')}
                    </span>
                    {currentDetail.preferences.freeNotes ? (
                      <p className="text-slate-800 font-medium bg-white p-2 rounded-xl border border-slate-200">
                        {currentDetail.preferences.freeNotes}
                      </p>
                    ) : (
                      <p className="text-slate-400 text-[11px]">{t('crm.custNoServiceNotes')}</p>
                    )}
                  </div>
                </div>

                {/* 4. Activity & Assets Tabs */}
                <div className="space-y-3">
                  <div className="flex items-center gap-2 border-b border-slate-200 pb-2 text-xs font-bold">
                    <button
                      onClick={() => setActiveTab('orders')}
                      className={`px-3 py-1.5 rounded-xl transition-all flex items-center gap-1.5 ${
                        activeTab === 'orders'
                          ? 'bg-slate-900 text-white shadow-xs'
                          : 'text-slate-500 hover:bg-slate-100'
                      }`}
                    >
                      <Receipt className="w-3.5 h-3.5" />
                      <span>{t('crm.custTabOrders')}{currentDetail.recentTickets.length})</span>
                    </button>

                    <button
                      onClick={() => setActiveTab('giftcards')}
                      className={`px-3 py-1.5 rounded-xl transition-all flex items-center gap-1.5 ${
                        activeTab === 'giftcards'
                          ? 'bg-slate-900 text-white shadow-xs'
                          : 'text-slate-500 hover:bg-slate-100'
                      }`}
                    >
                      <Gift className="w-3.5 h-3.5" />
                      <span>{t('crm.custTabGiftCards')}{currentDetail.giftCards.length})</span>
                    </button>

                    <button
                      onClick={() => setActiveTab('forms')}
                      className={`px-3 py-1.5 rounded-xl transition-all flex items-center gap-1.5 ${
                        activeTab === 'forms'
                          ? 'bg-slate-900 text-white shadow-xs'
                          : 'text-slate-500 hover:bg-slate-100'
                      }`}
                    >
                      <FileText className="w-3.5 h-3.5" />
                      <span>{t('crm.custTabForms')}{currentDetail.forms.length})</span>
                    </button>
                  </div>

                  {/* Tab Contents */}
                  <div>
                    {activeTab === 'orders' && (
                      <div className="space-y-2 text-xs">
                        {currentDetail.recentTickets.length === 0 ? (
                          <div className="p-6 text-center text-slate-400 bg-slate-50 rounded-xl">
                            
                            {t('crm.custNoOrders')}
                          </div>
                        ) : (
                          currentDetail.recentTickets.map((tkt) => (
                            <div
                              key={tkt.id}
                              className="p-3 bg-white border border-slate-200 rounded-xl flex items-center justify-between hover:border-slate-300 transition-all"
                            >
                              <div>
                                <p className="font-bold text-slate-900">
                                  {tkt.serviceNames.join(' · ') || t('crm.custInStoreSpend')}
                                </p>
                                <p className="text-[11px] text-slate-400 mt-0.5 font-mono">
                                  
                                  {t('crm.custBusinessDate')} {tkt.businessDate}  {t('crm.custStatusSep')} {t(ticketStatusI18nKey(tkt.status))}
                                </p>
                              </div>
                              <div className="text-right">
                                <span className="font-black text-slate-900 text-sm">
                                  <Money cents={tkt.totalCents} hiddenLabel="***" />
                                </span>
                              </div>
                            </div>
                          ))
                        )}
                      </div>
                    )}

                    {activeTab === 'giftcards' && (
                      <div className="space-y-2 text-xs">
                        {currentDetail.giftCards.length === 0 ? (
                          <div className="p-6 text-center text-slate-400 bg-slate-50 rounded-xl">
                            
                            {t('crm.custNoGiftCards')}
                          </div>
                        ) : (
                          currentDetail.giftCards.map((gc) => (
                            <div
                              key={gc.id}
                              className="p-3 bg-white border border-slate-200 rounded-xl flex items-center justify-between"
                            >
                              <div className="flex items-center gap-2">
                                <Gift className="w-4 h-4 text-teal-600" />
                                <span className="font-mono font-bold text-slate-800">{gc.code}</span>
                              </div>
                              <span className="font-black text-teal-700 text-sm">
                                
                                {t('crm.custGiftBalance')}{centsToDollars(gc.balanceCents)}
                              </span>
                            </div>
                          ))
                        )}
                      </div>
                    )}

                    {activeTab === 'forms' && (
                      <div className="space-y-2 text-xs">
                        {currentDetail.forms.length === 0 ? (
                          <div className="p-6 text-center text-slate-400 bg-slate-50 rounded-xl">
                            
                            {t('crm.custNoForms')}
                          </div>
                        ) : (
                          currentDetail.forms.map((f) => (
                            <div
                              key={f.id}
                              className="p-3 bg-white border border-slate-200 rounded-xl flex items-center justify-between"
                            >
                              <div className="flex items-center gap-2">
                                <FileText className="w-4 h-4 text-slate-400" />
                                <span className="font-semibold text-slate-900">{f.templateKey}</span>
                              </div>
                              <span className="text-slate-400 font-mono">
                                
                                {t('crm.custSignedAt')} {f.submittedAt.slice(0, 10)}
                              </span>
                            </div>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ) : null}
          </Card>
        </div>
      ) : (
        /* View 2: Full Data Table View */
        <Card className="border-slate-200 overflow-hidden rounded-2xl shadow-xs">
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50 border-b border-slate-200 text-slate-600 font-bold uppercase text-[11px]">
                  <tr>
                    <th className="p-3.5 pl-5">{t('crm.custColName')}</th>
                    <th className="p-3.5">{t('crm.custColVip')}</th>
                    <th className="p-3.5">{t('crm.custColPhone')}</th>
                    <th className="p-3.5">{t('crm.custColVisits')}</th>
                    <th className="p-3.5">{t('crm.custColLastVisit')}</th>
                    <th className="p-3.5">{t('crm.custColNoShows')}</th>
                    <th className="p-3.5 pr-5 text-right">{t('crm.custColActions')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.map((row) => (
                    <tr key={row.id} className="hover:bg-slate-50/80 transition-colors">
                      <td className="p-3.5 pl-5 font-bold text-slate-900">
                        <button
                          onClick={() => {
                            handleSelectCustomer(row.id);
                            setViewMode('split');
                          }}
                          className="hover:underline text-teal-700 font-bold"
                        >
                          {row.displayName}
                        </button>
                      </td>
                      <td className="p-3.5">
                        {row.vipLevel > 0 ? (
                          <Badge className="bg-amber-100 text-amber-900 border-amber-300 font-bold">
                            ⭐ VIP {row.vipLevel}
                          </Badge>
                        ) : (
                          <span className="text-slate-400 font-medium">{t('crm.custRegular')}</span>
                        )}
                      </td>
                      <td className="p-3.5 font-mono text-slate-600">{row.phone ? formatPhoneDisplay(row.phone) : '—'}</td>
                      <td className="p-3.5 font-bold text-slate-900">{row.visitCount}  {t('crm.custVisitUnit3')}</td>
                      <td className="p-3.5 text-slate-600">
                        {row.daysSinceLastVisit === null
                          ? t('crm.custNewTag')
                          : t('crm.custDaysAgo2', { p0: row.daysSinceLastVisit })}
                      </td>
                      <td className="p-3.5">
                        {row.noShowCount > 0 ? (
                          <Badge className="bg-red-100 text-red-800 border-red-300 font-bold">
                            {row.noShowCount}  {t('crm.custNoShowUnit')}
                          </Badge>
                        ) : (
                          <span className="text-emerald-600 font-medium">{t('crm.custGoodStanding')}</span>
                        )}
                      </td>
                      <td className="p-3.5 pr-5 text-right">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 text-xs text-teal-700 hover:bg-teal-50 font-bold"
                          onClick={() => {
                            handleSelectCustomer(row.id);
                            setViewMode('split');
                          }}
                        >
                          
                          {t('crm.custView360')}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ─────────────────────────────────────────────────────────────────── */}
      {/* 弹窗部分 (5 Modals)                                                 */}
      {/* ─────────────────────────────────────────────────────────────────── */}

      {/* 1. 新建 / 编辑顾客档案 Modal */}
      <Modal
        isOpen={createModalOpen || editProfileOpen}
        onOpenChange={(open) => {
          if (!open) {
            setCreateModalOpen(false);
            setEditProfileOpen(false);
          }
        }}
        size="lg"
        title={createModalOpen ? t('crm.custNewModalTitle') : t('crm.custEditModalTitle', { p0: formName })}
        footer={
          <div className="flex justify-end gap-2 w-full">
            <Button
              variant="secondary"
              onClick={() => {
                setCreateModalOpen(false);
                setEditProfileOpen(false);
              }}
            >
              {t('cancel') || t('crm.custCancel')}
            </Button>
            <Button
              className="bg-teal-600 hover:bg-teal-700 text-white font-bold"
              onClick={createModalOpen ? handleCreateCustomer : handleSaveProfile}
              disabled={saveProfileMutation.isPending}
            >
              {saveProfileMutation.isPending ? t('crm.custSaving') : t('save') || t('crm.custSaveProfile')}
            </Button>
          </div>
        }
      >
        <div className="space-y-4 py-1 text-xs">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block font-bold text-slate-700 uppercase mb-1">
                
                {t('crm.custNameLabel')}
              </label>
              <Input
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder={t('crm.custNamePlaceholder')}
              />
            </div>

            <div>
              <label className="block font-bold text-slate-700 uppercase mb-1">
                
                {t('crm.custPhoneLabel')}
              </label>
              <Input
                value={formPhone}
                onChange={(e) => setFormPhone(formatPhoneInput(e.target.value))}
                placeholder="(555) 000-0000"
                maxLength={14}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block font-bold text-slate-700 uppercase mb-1">
                
                {t('crm.custEmailLabel')}
              </label>
              <Input
                value={formEmail}
                onChange={(e) => setFormEmail(e.target.value)}
                placeholder="lisa@example.com"
              />
            </div>

            <div>
              <label className="block font-bold text-slate-700 uppercase mb-1">
                
                {t('crm.custVipLabel')}
              </label>
              <select
                value={formVip}
                onChange={(e) => setFormVip(e.target.value)}
                className="w-full h-10 px-3 rounded-xl border border-slate-200 bg-white text-xs font-medium text-slate-700 focus:outline-none focus:border-teal-500"
              >
                <option value="0">{t('crm.custVip0')}</option>
                <option value="1">{t('crm.custVip1')}</option>
                <option value="2">{t('crm.custVip2')}</option>
                <option value="3">⭐⭐⭐ Platinum Member (VIP 3)</option>
                <option value="4">{t('crm.custVip4')}</option>
                <option value="5">{t('crm.custVip5')}</option>
              </select>
            </div>

            <div>
              <label className="block font-bold text-slate-700 uppercase mb-1">
                
                {t('crm.custGenderLabel')}
              </label>
              <select
                value={formGender}
                onChange={(e) => setFormGender(e.target.value as any)}
                className="w-full h-10 px-3 rounded-xl border border-slate-200 bg-white text-xs font-medium text-slate-700 focus:outline-none focus:border-teal-500"
              >
                <option value="unspecified">{t('crm.custGenderUnspecified')}</option>
                <option value="female">{t('crm.custGenderFemale')}</option>
                <option value="male">{t('crm.custGenderMale')}</option>
                <option value="other">{t('crm.custGenderOther')}</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <BirthdateField
              label={t('crm.custBirthdayLabel')}
              value={formBirthday}
              onChange={setFormBirthday}
              today={storeToday}
              optional
              errorText={{
                invalid_date: t('crm.custBirthdayBadDay'),
                format: t('crm.custBirthdayInvalid'),
                future: t('crm.custBirthdayFuture'),
              }}
            />

            <div>
              <label className="block font-bold text-slate-700 uppercase mb-1">
                
                {t('crm.custSourceLabel')}
              </label>
              <select
                value={formSource}
                onChange={(e) => setFormSource(e.target.value)}
                className="w-full h-10 px-3 rounded-xl border border-slate-200 bg-white text-xs font-medium text-slate-700 focus:outline-none focus:border-teal-500"
              >
                <option value="Walk-in Walk-in Guest">{t('crm.custSourceWalkIn')}</option>
                <option value="Google 搜索">{t('crm.custSourceGoogle')}</option>
                <option value="Yelp 推荐">{t('crm.custSourceYelp')}</option>
                <option value="官网预约">{t('crm.custSourceWebsite')}</option>
                <option value="朋友转介绍">{t('crm.custSourceReferral')}</option>
                <option value="社交媒体">{t('crm.custSourceSocial')}</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block font-bold text-slate-700 uppercase mb-1">
              
              {t('crm.custTagsLabel')}
            </label>
            <Input
              value={formTags}
              onChange={(e) => setFormTags(e.target.value)}
              placeholder={t('crm.custTagsPlaceholder')}
            />
          </div>
        </div>
      </Modal>

      {/* 2. 结构化偏好与健康禁忌 Modal */}
      <Modal
        isOpen={editPrefOpen}
        onOpenChange={setEditPrefOpen}
        size="md"
        title={t('crm.custPrefsModalTitle')}
        footer={
          <div className="flex justify-end gap-2 w-full">
            <Button variant="secondary" onClick={() => setEditPrefOpen(false)}>
              {t('cancel') || t('crm.custPrefsCancel')}
            </Button>
            <Button
              className="bg-teal-600 hover:bg-teal-700 text-white font-bold"
              onClick={handleSavePref}
              disabled={savePreferencesMutation.isPending}
            >
              {savePreferencesMutation.isPending ? t('crm.custPrefsSaving') : t('save') || t('crm.custPrefsSave')}
            </Button>
          </div>
        }
      >
        <div className="space-y-4 py-1 text-xs">
          {/* 禁忌快速芯片 */}
          <div>
            <label className="block font-bold text-red-700 uppercase mb-1.5">
              ⚠️ {t('allergiesTitle') || t('crm.custCommonContraindications')}：
            </label>
            <div className="flex flex-wrap gap-1.5 mb-2">
              {ALLERGY_CHIP_KEYS.map((k) => {
                const chip = t(k);
                return (
                  <button
                    key={k}
                    type="button"
                    onClick={() => {
                      if (!prefAllergies.includes(chip)) {
                        setPrefAllergies((prev) => (prev ? `${prev}, ${chip}` : chip));
                      }
                    }}
                    className="px-2 py-1 rounded-lg border border-red-200 bg-red-50/70 text-red-900 hover:bg-red-100 font-medium text-[11px] transition-all"
                  >
                    + {chip}
                  </button>
                );
              })}
            </div>
            <Input
              value={prefAllergies}
              onChange={(e) => setPrefAllergies(e.target.value)}
              placeholder="e.g. Lavender oil allergy, sensitive skin..."
            />
          </div>

          {/* 偏好快速芯片 */}
          <div className="pt-2 border-t border-slate-100">
            <label className="block font-bold text-teal-700 uppercase mb-1.5">
              💆 {t('customerPreferences') || t('crm.custCommonPrefs')}：
            </label>
            <div className="flex flex-wrap gap-1.5 mb-2">
              {PREF_CHIP_KEYS.map((k) => {
                const chip = t(k);
                return (
                  <button
                    key={k}
                    type="button"
                    onClick={() => {
                      if (!prefNotes.includes(chip)) {
                        setPrefNotes((prev) => (prev ? `${prev}, ${chip}` : chip));
                      }
                    }}
                    className="px-2 py-1 rounded-lg border border-teal-200 bg-teal-50/70 text-teal-900 hover:bg-teal-100 font-medium text-[11px] transition-all"
                  >
                    + {chip}
                  </button>
                );
              })}
            </div>
            <Input
              value={prefNotes}
              onChange={(e) => setPrefNotes(e.target.value)}
              placeholder="e.g. Quiet session, firm pressure..."
            />
          </div>
        </div>
      </Modal>

      {/* 3. 智能搜索合并顾客档案 Modal */}
      <Modal
        isOpen={mergeModalOpen}
        onOpenChange={(open) => {
          if (!open) setMergeModalOpen(false);
        }}
        size="lg"
        title={`🔀 ${t('mergeCustomer') || 'Smart Merge Duplicate Customers'}`}
        footer={
          <div className="flex justify-end gap-2 w-full">
            <Button variant="secondary" onClick={() => setMergeModalOpen(false)}>
              {t('cancel')}
            </Button>
            <Button
              className="bg-indigo-600 hover:bg-indigo-700 text-white font-bold"
              onClick={handleSmartMerge}
              disabled={!selectedSourceCustomer || mergeMutation.isPending}
            >
              {mergeMutation.isPending ? t('loading') : (t('mergeCustomer') || t('crm.custConfirmMerge'))}
            </Button>
          </div>
        }
      >
        <div className="space-y-4 py-1 text-xs">
          <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl text-amber-900">
            <p className="font-bold">
              
              {t('crm.custMergeIntro')}{currentDetail?.displayName}】
            </p>
            <p className="text-[11px] mt-0.5 text-amber-700">
              {t('mergeCustomerDesc') || t('crm.custMergeWarn')}
            </p>
          </div>

          {/* 搜索候选人 */}
          <div>
            <label className="block font-bold text-slate-700 uppercase mb-1">
              {t('search')}:
            </label>
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-2.5" />
              <input
                type="text"
                value={mergeSearchQuery}
                onChange={(e) => setMergeSearchQuery(e.target.value)}
                placeholder={t('searchPlaceholder')}
                className="w-full h-8.5 pl-8 pr-2.5 rounded-xl border border-slate-200 bg-slate-50 text-xs focus:outline-none focus:border-indigo-500 focus:bg-white"
              />
            </div>

            <div className="max-h-36 overflow-y-auto divide-y divide-slate-100 border border-slate-200 rounded-xl mt-2">
              {mergeCandidates.length === 0 ? (
                <div className="p-3 text-center text-slate-400 text-[11px]">{t('noData')}</div>
              ) : (
                mergeCandidates.map((cand) => (
                  <div
                    key={cand.id}
                    onClick={() => setSelectedSourceCustomer(cand)}
                    className={cn(
                      'p-2.5 flex items-center justify-between cursor-pointer transition-all',
                      selectedSourceCustomer?.id === cand.id
                        ? 'bg-indigo-50 text-indigo-950 font-bold border-l-4 border-indigo-600'
                        : 'hover:bg-slate-50',
                    )}
                  >
                    <div>
                      <strong className="text-slate-900">{cand.displayName}</strong>
                      <span className="text-[11px] text-slate-500 ml-2">
                        {cand.phone ? formatPhoneDisplay(cand.phone) : t('crm.custNoPhoneShort')}
                      </span>
                    </div>
                    <span className="text-[11px] text-slate-400">{t('crm.custVisits2')} {cand.visitCount}  {t('crm.custVisitUnit4')}</span>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* 选中对比 */}
          {selectedSourceCustomer && (
            <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl space-y-1">
              <span className="font-bold text-slate-700 block">{t('crm.custMergeCompare')}</span>
              <div className="flex items-center justify-between text-[11px]">
                <span>
                  
                  {t('crm.custMergeSource')} <strong>{selectedSourceCustomer.displayName}</strong>
                </span>
                <span>
                  
                  {t('crm.custMergeTarget')} <strong>{currentDetail?.displayName}</strong>
                </span>
              </div>
            </div>
          )}
        </div>
      </Modal>

      {/* 4. 快捷短信发送 Modal */}
      <Modal
        isOpen={smsModalOpen}
        onOpenChange={(open) => {
          if (!open) setSmsModalOpen(false);
        }}
        size="md"
        title={`💬 ${t('crm.custSmsTitle')} · ${currentDetail?.displayName}`}
        footer={
          <div className="flex justify-end gap-2 w-full">
            <Button variant="secondary" onClick={() => setSmsModalOpen(false)}>
              {t('cancel') || t('crm.custSmsCancel')}
            </Button>
            <Button
              className="bg-teal-600 hover:bg-teal-700 text-white font-bold gap-1"
              onClick={handleSendSms}
            >
              <Send className="w-3.5 h-3.5" />
              <span>{t('crm.custSmsConfirm')}</span>
            </Button>
          </div>
        }
      >
        <div className="space-y-3.5 py-1 text-xs">
          <div className="flex justify-between items-center bg-slate-50 p-2.5 rounded-xl border border-slate-200">
            <span className="text-slate-500">{t('crm.custSmsRecipient')}</span>
            <span className="font-bold text-slate-900">
              {currentDetail?.displayName} ({currentDetail?.phone ? formatPhoneDisplay(currentDetail.phone) : t('crm.custSmsBoundNumber')})
            </span>
          </div>

          {/* 常用模板芯片 */}
          <div>
            <span className="block font-bold text-slate-700 uppercase mb-1.5">
              
              {t('crm.custSmsTemplates')}
            </span>
            <div className="flex flex-wrap gap-1.5">
              {SMS_TEMPLATE_CONFIG.map((tpl) => (
                <button
                  key={tpl.labelKey}
                  type="button"
                  onClick={() => setSmsContent(t(tpl.textKey))}
                  className="px-2 py-1 rounded-lg border border-slate-200 bg-white hover:bg-teal-50 hover:border-teal-300 text-slate-700 font-medium text-[11px] transition-all"
                >
                  {t(tpl.labelKey)}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block font-bold text-slate-700 uppercase mb-1">
              
              {t('crm.custSmsBody')}
            </label>
            <textarea
              rows={4}
              value={smsContent}
              onChange={(e) => setSmsContent(e.target.value)}
              className="w-full p-2.5 rounded-xl border border-slate-200 text-xs focus:outline-none focus:border-teal-500 resize-none font-sans"
            />
            <div className="flex justify-between text-[11px] text-slate-400 mt-1">
              <span>{t('crm.custSmsEnteredPrefix')} {smsContent.length}  {t('crm.custSmsEnteredSuffix')}</span>
              <span>{t('crm.custSmsVariables')}</span>
            </div>
          </div>
        </div>
      </Modal>

      {/* 5. 黑名单管控确认 Modal */}
      <Modal
        isOpen={blockModalOpen}
        onOpenChange={(open) => {
          if (!open) setBlockModalOpen(false);
        }}
        size="sm"
        title={currentDetail?.blockedAt ? t('crm.custUnblockTitle') : t('crm.custBlockTitle')}
        footer={
          <div className="flex justify-end gap-2 w-full">
            <Button variant="secondary" onClick={() => setBlockModalOpen(false)}>
              {t('cancel') || t('crm.custBlockCancel')}
            </Button>
            <Button
              className={
                currentDetail?.blockedAt
                  ? 'bg-emerald-600 hover:bg-emerald-700 text-white font-bold'
                  : 'bg-red-600 hover:bg-red-700 text-white font-bold'
              }
              onClick={handleConfirmBlock}
              disabled={setBlockedMutation.isPending}
            >
              {currentDetail?.blockedAt ? t('crm.custUnblockConfirm') : t('crm.custBlockConfirm')}
            </Button>
          </div>
        }
      >
        <div className="space-y-3 py-1 text-xs">
          {!currentDetail?.blockedAt ? (
            <>
              <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-red-900">
                <p className="font-bold">{t('crm.custBlockAboutPrefix')}{currentDetail?.displayName}{t('crm.custBlockAboutSuffix')}</p>
                <p className="text-[11px] mt-0.5 text-red-700">
                  
                  {t('crm.custBlockEffect')}
                </p>
              </div>

              <div>
                <label className="block font-bold text-slate-700 uppercase mb-1">
                  
                  {t('crm.custBlockReasonLabel')}
                </label>
                <select
                  value={blockReason}
                  onChange={(e) => setBlockReason(e.target.value)}
                  className="w-full h-9 px-2.5 rounded-xl border border-slate-200 bg-white text-xs font-medium text-slate-700 focus:outline-none focus:border-red-500"
                >
                  <option value={t('crm.custBlockReasonNoShow')}>{t('crm.custBlockReasonNoShow2')}</option>
                  <option value={t('crm.custBlockReasonHarassment')}>{t('crm.custBlockReasonHarassment2')}</option>
                  <option value={t('crm.custBlockReasonChargeback')}>{t('crm.custBlockReasonChargeback2')}</option>
                  <option value={t('crm.custBlockReasonManual')}>{t('crm.custBlockReasonManual2')}</option>
                </select>
              </div>
            </>
          ) : (
            <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-xl text-emerald-900">
              <p className="font-bold">{t('crm.custUnblockAboutPrefix')}{currentDetail?.displayName}{t('crm.custUnblockAboutSuffix')}</p>
              <p className="text-[11px] mt-0.5 text-emerald-700">
                
                {t('crm.custUnblockEffect')}
              </p>
            </div>
          )}
        </div>
      </Modal>
    </div>
  );
}

export function Customers() {
  return (
    <ErrorBoundary fallbackTitleKey="customers">
      <CustomersContent />
    </ErrorBoundary>
  );
}
