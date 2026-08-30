import { useState, useEffect, useRef } from 'react';
import { useErrorMessage } from '@/lib/errorMessage';
import { useSearchParams } from 'react-router-dom';
import { useLanguage } from '@/LanguageContext';
import { cn, formatPhoneDisplay, formatPhoneInput } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Modal, ConfirmDialog } from '@/components/ui/Modal';
import { Badge } from '@/components/ui/Badge';
import { PageHeader } from '@/components/ui/PageHeader';
import { PageLoading, PageError } from '@/components/ui/QueryState';
import { ImageUploader } from '@/components/ui/ImageUploader';
import {
  Store,
  Scissors,
  Users,
  Globe,
  PhoneCall,
  TabletSmartphone,
  CreditCard,
  Plus,
  Trash2,
  Edit2,
  Copy,
  Check,
  RotateCcw,
  Sparkles,
  AlertCircle,
  Clock,
  ShieldCheck,
  ShieldAlert,
  FileText,
  CheckCircle2,
  Lock,
  Building,
  ChevronRight,
  Receipt,
  CalendarCheck,
  Percent,
  DollarSign,
  Smartphone,
  Sliders,
  Webhook,
  HelpCircle,
  Search,
  CheckCircle,
  XCircle,
  ExternalLink,
  MapPin,
  Mail,
  Phone,
  Printer,
  Sparkle,
} from 'lucide-react';
import { toast } from '@heroui/react';
import {
  useDeskSettingsQuery,
  useDeskBillingQuery,
  useSaveLocationProfile,
  useSaveBusinessHours,
  useSaveService,
  useArchiveService,
  useSaveStaffProfile,
  useSetRotationParticipation,
  useSaveOnlineBooking,
  useAddWebOrigin,
  useRemoveWebOrigin,
  useSavePhoneAssistant,
  useSaveCheckoutSettings,
  useApply10Dlc,
  useSaveWebhooks,
} from '@/features/settings/api';
import type { QuotaView } from '@/features/billing/types';
import { useChangePlanMutation, useCreateBillingPortalSession } from '@/features/billing/api';
import type {
  ServiceItem,
  StaffItem,
  CheckoutSettings,
  WebhookConfigItem,
} from '@/features/settings/types';
import { HardwareServer } from './HardwareServer';
import { dollarsToCents, centsToDollars } from '@/features/checkout/api';
import {
  PRESET_STORE_AVATARS,
  PRESET_STORE_THEMES,
  getSavedStoreAvatar,
  saveStoreAvatar,
} from '@/lib/avatarPresets';

// ── 营业日定义 ─────────────────────────────────────────────────────────────
const DAYS_OF_WEEK = [
  { key: 'mon', labelZh: '周一', labelEn: 'Monday' },
  { key: 'tue', labelZh: '周二', labelEn: 'Tuesday' },
  { key: 'wed', labelZh: '周三', labelEn: 'Wednesday' },
  { key: 'thu', labelZh: '周四', labelEn: 'Thursday' },
  { key: 'fri', labelZh: '周五', labelEn: 'Friday' },
  { key: 'sat', labelZh: '周六', labelEn: 'Saturday' },
  { key: 'sun', labelZh: '周日', labelEn: 'Sunday' },
] as const;

// ── 导航分组与 Tab 定义 ───────────────────────────────────────────────────
interface NavGroup {
  groupName: string;
  items: {
    id: string;
    label: string;
    icon: any;
    badge?: string;
    badgeTone?: 'default' | 'success' | 'warning' | 'error';
  }[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    groupName: 'Basic Profile',
    items: [
      { id: 'store', label: '门店品牌档案', icon: Store },
      { id: 'hours', label: '营业时间与作息', icon: Clock },
    ],
  },
  {
    groupName: 'Checkout & Rules',
    items: [
      { id: 'checkout', label: '收银与小费偏好', icon: Receipt },
      { id: 'booking', label: '预约与排班规则', icon: CalendarCheck },
    ],
  },
  {
    groupName: 'Services & Staff',
    items: [
      { id: 'services', label: '服务项目与价目', icon: Scissors },
      { id: 'staff', label: '员工团队与调度', icon: Users },
    ],
  },
  {
    groupName: 'Smart Comms',
    items: [
      { id: 'ai_phone', label: 'AI 电话语音助手', icon: PhoneCall },
      { id: '10dlc', label: '10DLC 短信资质代办', icon: ShieldCheck, badge: '合规认证' },
    ],
  },
  {
    groupName: 'Hardware & Devices',
    items: [
      { id: 'hardware', label: '设备与顾客副屏', icon: TabletSmartphone },
      { id: 'integrations', label: '网站插件与 API', icon: Globe },
    ],
  },
  {
    groupName: '订阅与财务',
    items: [
      { id: 'billing', label: 'SaaS 订阅与算力', icon: CreditCard, badge: 'Growth' },
    ],
  },
];

// ── 表单排版辅助组件 ────────────────────────────────────────────────────────
interface SettingsRowProps {
  label: string;
  description?: string;
  required?: boolean;
  children: React.ReactNode;
  alignTop?: boolean;
}

function SettingsRow({ label, description, required, children, alignTop }: SettingsRowProps) {
  return (
    <div
      className={`grid grid-cols-1 md:grid-cols-12 gap-3 py-4 border-b border-slate-100 last:border-b-0 ${
        alignTop ? 'items-start' : 'items-center'
      }`}
    >
      <div className="md:col-span-5 space-y-1 pr-2">
        <label className="text-xs font-bold text-slate-800 flex items-center gap-1">
          <span>{label}</span>
          {required && <span className="text-red-500">*</span>}
        </label>
        {description && <p className="text-[11px] text-slate-500 leading-relaxed">{description}</p>}
      </div>
      <div className="md:col-span-7 min-w-0">{children}</div>
    </div>
  );
}

function SettingsCard({
  title,
  description,
  badge,
  actions,
  children,
}: {
  title: string;
  description?: string;
  badge?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card className="border border-slate-200/90 shadow-sm rounded-2xl overflow-hidden bg-white">
      <CardHeader className="bg-slate-50/50 px-6 py-4 border-b border-slate-100 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2.5">
            <CardTitle className="text-sm font-bold text-slate-900">{title}</CardTitle>
            {badge}
          </div>
          {description && <CardDescription className="text-xs text-slate-500 mt-0.5">{description}</CardDescription>}
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </CardHeader>
      <CardContent className="p-6">{children}</CardContent>
    </Card>
  );
}

// ── 主设置组件 ─────────────────────────────────────────────────────────────
export function Settings() {
  const errorMessage = useErrorMessage();
  const { t } = useLanguage();
  const [searchParams, setSearchParams] = useSearchParams();
  const currentTab = searchParams.get('tab') || 'store';

  const { data: settings, isLoading, error, refetch } = useDeskSettingsQuery();
  const { data: billingData } = useDeskBillingQuery();
  const billing = (billingData as any)?.billing ?? billingData;
  const voiceQuota = billing?.quotas?.find((quota: QuotaView) => quota.unit === 'voice_minute');
  const creditQuota = billing?.quotas?.find((quota: QuotaView) => quota.unit === 'credit');
  const voiceUsagePercent = voiceQuota?.included && voiceQuota.included.total > 0
    ? Math.min(100, Math.round((voiceQuota.included.used / voiceQuota.included.total) * 100))
    : 0;
  const creditUsagePercent = creditQuota?.included && creditQuota.included.total > 0
    ? Math.min(100, Math.round((creditQuota.included.used / creditQuota.included.total) * 100))
    : 0;

  // Mutations
  const saveLocationMutation = useSaveLocationProfile();
  const saveHoursMutation = useSaveBusinessHours();
  const saveServiceMutation = useSaveService();
  const archiveServiceMutation = useArchiveService();
  const saveStaffMutation = useSaveStaffProfile();
  const setRotationMutation = useSetRotationParticipation();
  const saveOnlineBookingMutation = useSaveOnlineBooking();
  const addOriginMutation = useAddWebOrigin();
  const removeOriginMutation = useRemoveWebOrigin();
  const savePhoneAssistantMutation = useSavePhoneAssistant();
  const saveCheckoutMutation = useSaveCheckoutSettings();
  const apply10DlcMutation = useApply10Dlc();
  const saveWebhooksMutation = useSaveWebhooks();
  const changePlanMutation = useChangePlanMutation();
  const createPortalMutation = useCreateBillingPortalSession();

  // 1. 门店品牌档案
  const [storeName, setStoreName] = useState('');
  const [storeSlug, setStoreSlug] = useState('');
  const [storeAvatarPresetId, setStoreAvatarPresetId] = useState('store-1');
  const [storeThemeId, setStoreThemeId] = useState('theme-teal');
  const [customStoreLogoUrl, setCustomStoreLogoUrl] = useState('');
  const [storePhone, setStorePhone] = useState('');
  const [storeEmail, setStoreEmail] = useState('');
  const [storeAddressStreet, setStoreAddressStreet] = useState('');
  const [storeCity, setStoreCity] = useState('');
  const [storeState, setStoreState] = useState('');
  const [storeZip, setStoreZip] = useState('');
  const [businessType, setBusinessType] = useState<'nail' | 'massage' | 'foot_spa' | 'lash' | 'scalp' | 'hair' | 'mixed'>('mixed');
  const [storeTimezone, setStoreTimezone] = useState('America/New_York');
  const [storeCutoff, setStoreCutoff] = useState('03:00');
  const [currencySymbol, setCurrencySymbol] = useState('$ (USD)');

  useEffect(() => {
    const saved = getSavedStoreAvatar();
    if (saved) {
      if (saved.presetId) setStoreAvatarPresetId(saved.presetId);
      if (saved.themeId) setStoreThemeId(saved.themeId);
      if (saved.customLogoUrl) setCustomStoreLogoUrl(saved.customLogoUrl);
    }
  }, []);

  // 2. 营业时间
  const [businessHours, setBusinessHours] = useState<
    Record<string, { open: string; close: string } | null>
  >({
    mon: null, tue: null, wed: null, thu: null, fri: null, sat: null, sun: null,
  });

  // 3. 收银与小费偏好
  const [taxRate, setTaxRate] = useState('0');
  const [taxMode, setTaxMode] = useState<'exclusive' | 'inclusive'>('exclusive');
  const [tipPresets, setTipPresets] = useState<string[]>([]);
  const [allowCustomTip, setAllowCustomTip] = useState(false);
  const [cashDrawerFloat, setCashDrawerFloat] = useState('0.00');
  const [receiptFooter, setReceiptFooter] = useState('');
  const [autoPrintReceipt, setAutoPrintReceipt] = useState(false);
  const [autoSendSmsReceipt, setAutoSendSmsReceipt] = useState(false);
  const [checkoutTiming, setCheckoutTiming] = useState<'service_then_tip' | 'upfront_combined' | 'after_service_combined'>('after_service_combined');

  // 4. 在线预约与排班规则
  const [onlineEnabled, setOnlineEnabled] = useState(false);
  const [maxDaysAhead, setMaxDaysAhead] = useState('0');
  const [minMinutesAhead, setMinMinutesAhead] = useState('0');
  const [cancelCutoffHours, setCancelCutoffHours] = useState('0');
  const [slotInterval, setSlotInterval] = useState<'15' | '30' | '60'>('30');
  const [requireDeposit, setRequireDeposit] = useState(false);
  const [depositAmount, setDepositAmount] = useState('0.00');
  const [allowPickStaff, setAllowPickStaff] = useState(false);

  // 5. 服务目录表单
  const [serviceSearch, setServiceSearch] = useState('');
  const [serviceCategoryFilter, setServiceCategoryFilter] = useState('all');
  const [serviceModalOpen, setServiceModalOpen] = useState(false);
  const [editingService, setEditingService] = useState<ServiceItem | null>(null);
  const [serviceNameZh, setServiceNameZh] = useState('');
  const [serviceNameEn, setServiceNameEn] = useState('');
  const [serviceDuration, setServiceDuration] = useState('45');
  const [servicePrice, setServicePrice] = useState('50.00');
  const [serviceTaxable, setServiceTaxable] = useState(true);
  const [serviceOnlineBookable, setServiceOnlineBookable] = useState(true);
  const [serviceIsAddon, setServiceIsAddon] = useState(false);
  const [serviceStaffCount, setServiceStaffCount] = useState('1');
  const [serviceRequiredSkillIds, setServiceRequiredSkillIds] = useState<string[]>([]);
  const [archivingService, setArchivingService] = useState<ServiceItem | null>(null);

  // 6. 员工管理表单
  const [staffSearch, setStaffSearch] = useState('');
  const [staffModalOpen, setStaffModalOpen] = useState(false);
  const [editingStaff, setEditingStaff] = useState<StaffItem | null>(null);
  const [staffDisplayName, setStaffDisplayName] = useState('');
  const [staffPhone, setStaffPhone] = useState('');
  const [staffBookable, setStaffBookable] = useState(true);
  const [staffInRotation, setStaffInRotation] = useState(true);
  const [staffMaxConcurrent, setStaffMaxConcurrent] = useState('1');
  const [staffCommissionRate, setStaffCommissionRate] = useState('50');

  // 7. AI 电话助手
  const [greetingPrompt, setGreetingPrompt] = useState('');
  const [forwardPhone, setForwardPhone] = useState('');
  const [autoBookEnabled, setAutoBookEnabled] = useState(false);
  const [voiceTone, setVoiceTone] = useState<'warm' | 'professional' | 'concise'>('warm');
  const [afterHoursVoicemail, setAfterHoursVoicemail] = useState(false);
  const greetingTextareaRef = useRef<HTMLTextAreaElement>(null);

  // 8. 10DLC 资质代办
  const [tenDlcStatus, setTenDlcStatus] = useState<'not_submitted' | 'pending_review' | 'approved' | 'rejected'>('not_submitted');
  const [legalName, setLegalName] = useState('');
  const [ein, setEin] = useState('');
  const [businessStructure, setBusinessStructure] = useState<'llc' | 'corp' | 'sole_prop' | 'partnership'>('llc');
  const [regAddress, setRegAddress] = useState('');
  const [repName, setRepName] = useState('');
  const [repTitle, setRepTitle] = useState('');
  const [repEmail, setRepEmail] = useState('');
  const [repPhone, setRepPhone] = useState('');
  const [sampleMsg1, setSampleMsg1] = useState('');
  const [sampleMsg2, setSampleMsg2] = useState('');
  const [optInMethod, setOptInMethod] = useState('');

  // 10. 网站插件与 API (CORS, Webhooks)
  const [newOriginUrl, setNewOriginUrl] = useState('');
  const [copiedKey, setCopiedKey] = useState(false);
  const [webhookUrl, setWebhookUrl] = useState('');
  const [webhookEvents, setWebhookEvents] = useState({
    bookingCreated: true,
    bookingCancelled: true,
    ticketPaid: true,
  });

  // 二次确认弹窗状态
  const [confirmSaveStoreOpen, setConfirmSaveStoreOpen] = useState(false);
  const [confirmSaveHoursOpen, setConfirmSaveHoursOpen] = useState(false);
  const [confirmSaveCheckoutOpen, setConfirmSaveCheckoutOpen] = useState(false);
  const [confirmSaveBookingOpen, setConfirmSaveBookingOpen] = useState(false);
  const [confirmTenDlcOpen, setConfirmTenDlcOpen] = useState(false);
  const [confirmSavePhoneOpen, setConfirmSavePhoneOpen] = useState(false);
  const [confirmChangePlan, setConfirmChangePlan] = useState<string | null>(null);

  // Walk-in Guest轮牌状态切换二次确认弹窗
  const [confirmRotationTarget, setConfirmRotationTarget] = useState<{
    staff: StaffItem;
    nextInRotation: boolean;
  } | null>(null);

  // 同步远端数据
  useEffect(() => {
    if (settings) {
      if (settings.location) {
        setStoreName(settings.location.name ?? '');
        setStoreSlug(settings.location.slug ?? '');
        if (settings.location.timezone) setStoreTimezone(settings.location.timezone);
        if (settings.location.businessType) setBusinessType(settings.location.businessType as any);
        setStorePhone(formatPhoneDisplay(settings.location.phone) ?? '');
        setStoreEmail(settings.location.email ?? '');
        setStoreAddressStreet(settings.location.addressStreet ?? '');
        setStoreCity(settings.location.addressCity ?? '');
        setStoreState(settings.location.addressState ?? '');
        setStoreZip(settings.location.addressZip ?? '');
        if (settings.location.businessDayCutoff) setStoreCutoff(settings.location.businessDayCutoff);
        if (settings.location.businessHours) {
          setBusinessHours(settings.location.businessHours as any);
        }
      }
      if (settings.checkout) {
        if (settings.checkout.salesTaxRatePercent !== undefined) setTaxRate(String(settings.checkout.salesTaxRatePercent));
        if (settings.checkout.taxCalculationMode) setTaxMode(settings.checkout.taxCalculationMode);
        setTipPresets((settings.checkout.suggestedTipPercentages ?? []).map(String));
        if (settings.checkout.allowCustomTip !== undefined) setAllowCustomTip(settings.checkout.allowCustomTip);
        if (settings.checkout.defaultCashFloatCents !== undefined) {
          setCashDrawerFloat(centsToDollars(settings.checkout.defaultCashFloatCents));
        }
        setReceiptFooter(settings.checkout.receiptFooterMessage ?? '');
        if (settings.checkout.autoPrintReceipt !== undefined) setAutoPrintReceipt(settings.checkout.autoPrintReceipt);
        if (settings.checkout.autoSendSmsReceipt !== undefined) setAutoSendSmsReceipt(settings.checkout.autoSendSmsReceipt);
        if (settings.checkout.checkoutTiming) setCheckoutTiming(settings.checkout.checkoutTiming);
      }
      if (settings.guest?.onlineBooking) {
        setOnlineEnabled(Boolean(settings.guest.onlineBooking.enabled));
        setMaxDaysAhead(String(settings.guest.onlineBooking.maxDaysAhead ?? 0));
        setMinMinutesAhead(String(settings.guest.onlineBooking.minMinutesAhead ?? 0));
        setCancelCutoffHours(String(settings.guest.onlineBooking.cancelCutoffHours ?? 0));
        if (settings.guest.onlineBooking.slotIntervalMinutes) {
          setSlotInterval(String(settings.guest.onlineBooking.slotIntervalMinutes) as any);
        }
        if (settings.guest.onlineBooking.depositRequired !== undefined) {
          setRequireDeposit(settings.guest.onlineBooking.depositRequired);
        }
        if (settings.guest.onlineBooking.depositAmountCents !== undefined) {
          setDepositAmount(centsToDollars(settings.guest.onlineBooking.depositAmountCents));
        }
        if (settings.guest.onlineBooking.allowClientPickStaff !== undefined) {
          setAllowPickStaff(settings.guest.onlineBooking.allowClientPickStaff);
        }
      }
      if (settings.phoneAssistant) {
        setGreetingPrompt(settings.phoneAssistant.greetingPrompt ?? '');
        setForwardPhone(formatPhoneDisplay(settings.phoneAssistant.forwardPhoneNumber) ?? '');
        if (settings.phoneAssistant.autoBookEnabled !== undefined) setAutoBookEnabled(settings.phoneAssistant.autoBookEnabled);
        if (settings.phoneAssistant.voiceTone) setVoiceTone(settings.phoneAssistant.voiceTone as any);
        if (settings.phoneAssistant.afterHoursVoicemail !== undefined) setAfterHoursVoicemail(settings.phoneAssistant.afterHoursVoicemail);
      }
      if (settings.tenDlc) {
        if (settings.tenDlc.status) setTenDlcStatus(settings.tenDlc.status);
        setLegalName(settings.tenDlc.legalBusinessName ?? '');
        setEin(settings.tenDlc.ein ?? '');
        if (settings.tenDlc.businessStructure) setBusinessStructure(settings.tenDlc.businessStructure as any);
        setRegAddress(settings.tenDlc.registeredAddress ?? '');
        setRepName(settings.tenDlc.repName ?? '');
        setRepTitle(settings.tenDlc.repTitle ?? '');
        setRepEmail(settings.tenDlc.repEmail ?? '');
        setRepPhone(formatPhoneDisplay(settings.tenDlc.repPhone) ?? '');
        setOptInMethod(settings.tenDlc.optInMethod ?? '');
        setSampleMsg1(settings.tenDlc.sampleMessages?.[0] ?? '');
        setSampleMsg2(settings.tenDlc.sampleMessages?.[1] ?? '');
      }
      if (settings.webhooks && settings.webhooks.length > 0) {
        const primaryWebhook = settings.webhooks[0];
        setWebhookUrl(primaryWebhook.url);
        setWebhookEvents({
          bookingCreated: primaryWebhook.events.includes('booking.created'),
          bookingCancelled: primaryWebhook.events.includes('booking.cancelled'),
          ticketPaid: primaryWebhook.events.includes('ticket.paid'),
        });
      }
    }
  }, [settings]);

  // 快捷插入变量至文本域
  const handleInsertVariable = (variableText: string) => {
    if (!greetingTextareaRef.current) return;
    const textarea = greetingTextareaRef.current;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const text = greetingPrompt;
    const before = text.substring(0, start);
    const after = text.substring(end, text.length);
    setGreetingPrompt(before + variableText + after);
    setTimeout(() => {
      textarea.focus();
      textarea.setSelectionRange(start + variableText.length, start + variableText.length);
    }, 0);
  };

  // 营业时间快捷操作
  const copyMonToWeekdays = () => {
    const mon = businessHours.mon || { open: '09:30', close: '19:30' };
    setBusinessHours({
      ...businessHours,
      mon: { ...mon },
      tue: { ...mon },
      wed: { ...mon },
      thu: { ...mon },
      fri: { ...mon },
    });
    toast.success(t('settings.stHoursCopiedWeekdays'));
  };

  const copyMonToAllDays = () => {
    const mon = businessHours.mon || { open: '09:30', close: '19:30' };
    const all: Record<string, { open: string; close: string }> = {};
    DAYS_OF_WEEK.forEach((d) => {
      all[d.key] = { ...mon };
    });
    setBusinessHours(all);
    toast.success(t('settings.stHoursCopiedWeek'));
  };

  // 保存处理函数
  const handleSaveStoreProfile = async () => {
    try {
      saveStoreAvatar({
        presetId: storeAvatarPresetId,
        icon: PRESET_STORE_AVATARS.find((s) => s.id === storeAvatarPresetId)?.icon || '🪷',
        themeId: storeThemeId,
        bg: PRESET_STORE_THEMES.find((t) => t.id === storeThemeId)?.bg || 'bg-teal-600',
        customLogoUrl: customStoreLogoUrl,
      });

      await saveLocationMutation.mutateAsync({
        name: storeName.trim() || undefined,
        slug: storeSlug.trim() || undefined,
        businessType,
        phone: storePhone.trim() || undefined,
        email: storeEmail.trim() || undefined,
        addressStreet: storeAddressStreet.trim() || undefined,
        addressCity: storeCity.trim() || undefined,
        addressState: storeState.trim() || undefined,
        addressZip: storeZip.trim() || undefined,
        businessDayCutoff: storeCutoff.trim() || undefined,
      });
      toast.success(t('settings.stStoreSaved'));
    } catch (err: any) {
      toast.danger(errorMessage(err));
    }
  };

  const handleSaveHours = async () => {
    try {
      await saveHoursMutation.mutateAsync({
        hours: businessHours,
      });
      toast.success(t('settings.stHoursSaved'));
    } catch (err: any) {
      toast.danger(errorMessage(err));
    }
  };

  const handleSaveCheckoutRules = async () => {
    try {
      await saveCheckoutMutation.mutateAsync({
        salesTaxRatePercent: parseFloat(taxRate) || 0,
        taxCalculationMode: taxMode,
        suggestedTipPercentages: tipPresets.map((t) => parseInt(t, 10) || 0),
        allowCustomTip,
        defaultCashFloatCents: dollarsToCents(cashDrawerFloat),
        receiptFooterMessage: receiptFooter.trim() || null,
        autoPrintReceipt,
        autoSendSmsReceipt,
        checkoutTiming,
      });
      toast.success(t('settings.stCheckoutSaved'));
    } catch (err: any) {
      toast.danger(errorMessage(err));
    }
  };

  const handleSaveBookingRules = async () => {
    try {
      await saveOnlineBookingMutation.mutateAsync({
        enabled: onlineEnabled,
        maxDaysAhead: parseInt(maxDaysAhead, 10) || 60,
        minMinutesAhead: parseInt(minMinutesAhead, 10) || 120,
        cancelCutoffHours: parseInt(cancelCutoffHours, 10) || 4,
        slotIntervalMinutes: (parseInt(slotInterval, 10) as any) || 30,
        depositRequired: requireDeposit,
        depositAmountCents: dollarsToCents(depositAmount),
        allowClientPickStaff: allowPickStaff,
      });
      toast.success(t('settings.stBookingSaved'));
    } catch (err: any) {
      toast.danger(errorMessage(err));
    }
  };

  const handleOpenServiceModal = (svc?: ServiceItem) => {
    if (svc) {
      setEditingService(svc);
      setServiceNameZh(svc.displayName || (svc.name as any)?.zh || (svc.name as any)?.en || '');
      setServiceNameEn((svc.name as any)?.en || '');
      setServiceDuration(String(svc.durationMin));
      setServicePrice(centsToDollars(svc.basePriceCents));
      setServiceTaxable(svc.taxable);
      setServiceOnlineBookable(svc.onlineBookable);
      setServiceIsAddon(svc.isAddon);
      setServiceStaffCount(String(svc.staffCount || 1));
      setServiceRequiredSkillIds(svc.requiredSkillIds || []);
    } else {
      setEditingService(null);
      setServiceNameZh('');
      setServiceNameEn('');
      setServiceDuration('45');
      setServicePrice('50.00');
      setServiceTaxable(true);
      setServiceOnlineBookable(true);
      setServiceIsAddon(false);
      setServiceStaffCount('1');
      setServiceRequiredSkillIds([]);
    }
    setServiceModalOpen(true);
  };

  const handleSaveServiceItem = async () => {
    if (!serviceNameZh.trim()) {
      toast.danger(t('settings.stServiceNameRequired'));
      return;
    }
    try {
      await saveServiceMutation.mutateAsync({
        serviceId: editingService?.id,
        name: serviceNameZh.trim(),
        durationMin: parseInt(serviceDuration, 10) || 30,
        basePriceCents: dollarsToCents(servicePrice),
        taxable: serviceTaxable,
        onlineBookable: serviceOnlineBookable,
        isAddon: serviceIsAddon,
        staffCount: Math.max(1, Math.min(5, parseInt(serviceStaffCount, 10) || 1)),
        requiredSkillIds: serviceRequiredSkillIds,
        active: true,
      });
      toast.success(editingService ? t('settings.stServiceUpdated') : t('settings.stServiceCreated'));
      setServiceModalOpen(false);
    } catch (err: any) {
      toast.danger(errorMessage(err));
    }
  };

  const handleArchiveServiceItem = async () => {
    if (!archivingService) return;
    try {
      await archiveServiceMutation.mutateAsync({ serviceId: archivingService.id });
      toast.success(t('settings.stServiceArchived'));
      setArchivingService(null);
    } catch (err: any) {
      toast.danger(errorMessage(err));
    }
  };

  const handleOpenStaffModal = (stf: StaffItem) => {
    setEditingStaff(stf);
    setStaffDisplayName(stf.name || '');
    setStaffPhone(formatPhoneDisplay(stf.phoneE164) || '');
    setStaffBookable(stf.isBookable);
    setStaffInRotation(stf.inRotation);
    setStaffMaxConcurrent(String(stf.maxConcurrent || 1));
    setStaffModalOpen(true);
  };

  const handleSaveStaffProfile = async () => {
    if (!editingStaff) return;
    try {
      await saveStaffMutation.mutateAsync({
        membershipId: editingStaff.membershipId,
        displayName: staffDisplayName.trim() || undefined,
        isBookable: staffBookable,
        maxConcurrentAppointments: parseInt(staffMaxConcurrent, 10) || 1,
      });
      toast.success(t('settings.stStaffSaved'));
      setStaffModalOpen(false);
    } catch (err: any) {
      toast.danger(errorMessage(err));
    }
  };

  const handleSavePhoneAssistant = async () => {
    try {
      await savePhoneAssistantMutation.mutateAsync({
        greetingPrompt: greetingPrompt.trim() || undefined,
        forwardPhoneNumber: forwardPhone.trim() || undefined,
        autoBookEnabled,
        voiceTone,
        afterHoursVoicemail,
      });
      toast.success(t('settings.stAiPhoneSaved'));
    } catch (err: any) {
      toast.danger(errorMessage(err));
    }
  };

  const handleSaveTenDlc = async () => {
    try {
      const res = await apply10DlcMutation.mutateAsync({
        legalBusinessName: legalName.trim(),
        ein: ein.trim(),
        businessStructure,
        registeredAddress: regAddress.trim(),
        repName: repName.trim(),
        repTitle: repTitle.trim(),
        repEmail: repEmail.trim(),
        repPhone: repPhone.trim(),
        optInMethod: optInMethod.trim() || undefined,
        sampleMessages: [sampleMsg1.trim(), sampleMsg2.trim()].filter(Boolean),
      });
      setTenDlcStatus('pending_review');
      toast.success(t('settings.st10dlcSubmitted'));
    } catch (err: any) {
      toast.danger(errorMessage(err));
    }
  };

  const handleSaveWebhooks = async () => {
    if (!webhookUrl.trim()) return;
    try {
      const events: string[] = [];
      if (webhookEvents.bookingCreated) events.push('booking.created');
      if (webhookEvents.ticketPaid) events.push('ticket.paid');
      if (webhookEvents.bookingCancelled) events.push('booking.cancelled');

      await saveWebhooksMutation.mutateAsync({
        url: webhookUrl.trim(),
        events,
        active: true,
      });
      toast.success(t('settings.stWebhookSaved'));
    } catch (err: any) {
      toast.danger(errorMessage(err));
    }
  };

  const copyPublicKey = () => {
    if (!settings?.guest?.publicKey) return;
    void navigator.clipboard.writeText(settings.guest.publicKey);
    setCopiedKey(true);
    toast.success(t('settings.stApiKeyCopied'));
    setTimeout(() => setCopiedKey(false), 2000);
  };

  const handleAddOrigin = async () => {
    if (!newOriginUrl.trim()) return;
    try {
      await addOriginMutation.mutateAsync({ origin: newOriginUrl.trim() });
      toast.success(t('settings.stDomainAdded'));
      setNewOriginUrl('');
    } catch (err: any) {
      toast.danger(errorMessage(err));
    }
  };

  const handleRemoveOrigin = async (originId: string) => {
    try {
      await removeOriginMutation.mutateAsync({ originId });
      toast.success(t('settings.stDomainRemoved'));
    } catch (err: any) {
      toast.danger(errorMessage(err));
    }
  };

  if (isLoading && !settings) {
    return <PageLoading title={t('settings.stLoading')} description={t('settings.stLoadingDesc')} />;
  }

  if (error && !settings) {
    return <PageError title={t('settings.stLoadError')} error={error} onRetry={refetch} />;
  }

  // 过滤服务列表
  const filteredServices = (settings?.services || []).filter((s) => {
    if (serviceCategoryFilter === 'addon' && !s.isAddon) return false;
    if (serviceCategoryFilter === 'online' && !s.onlineBookable) return false;
    if (serviceSearch.trim()) {
      const q = serviceSearch.toLowerCase();
      const displayName = typeof s.displayName === 'string' ? s.displayName : '';
      const zhName = typeof s.name === 'object' ? ((s.name as any)?.['zh-Hans'] || (s.name as any)?.zh || '') : (typeof s.name === 'string' ? s.name : '');
      const enName = typeof s.name === 'object' ? ((s.name as any)?.en || '') : '';
      return (
        displayName.toLowerCase().includes(q) ||
        zhName.toLowerCase().includes(q) ||
        enName.toLowerCase().includes(q)
      );
    }
    return true;
  });

  // 过滤员工列表
  const filteredStaff = (settings?.staff || []).filter((stf) => {
    if (staffSearch.trim()) {
      const q = staffSearch.toLowerCase();
      return (
        (stf.name || '').toLowerCase().includes(q) ||
        (stf.phoneE164 && stf.phoneE164.includes(q)) ||
        (stf.roleKeys && stf.roleKeys.some((r) => r.toLowerCase().includes(q)))
      );
    }
    return true;
  });

  return (
    <div className="space-y-6 max-w-6xl mx-auto w-full pb-24">
      {/* 顶部 PageHeader */}
      <PageHeader
        title={t('settings.stTitle')}
        description={t('settings.stSubtitle', { p0: storeName, p1: storeTimezone })}
        actions={
          <Button variant="secondary" size="sm" onClick={() => refetch()} className="gap-2 text-xs font-semibold">
            <RotateCcw className="w-3.5 h-3.5" />
            <span>{t('settings.stRefresh')}</span>
          </Button>
        }
      />

      {/* 主布局：左侧分类导航 + 右侧设置面板 */}
      <div className="flex flex-col lg:flex-row gap-6 w-full items-start">
        {/* 左侧导航栏 */}
        <div className="w-full lg:w-64 shrink-0 space-y-4">
          <div className="bg-white border border-slate-200 rounded-2xl p-3 shadow-xs space-y-4 sticky top-4">
            {NAV_GROUPS.map((group, idx) => (
              <div key={group.groupName} className={idx > 0 ? 'pt-3 border-t border-slate-100' : ''}>
                <div className="px-3 pb-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-400">
                  {group.groupName}
                </div>
                <div className="space-y-1">
                  {group.items.map((item) => {
                    const Icon = item.icon;
                    const isActive = currentTab === item.id;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => setSearchParams({ tab: item.id })}
                        className={`w-full flex items-center justify-between px-3 py-2 rounded-xl text-xs font-semibold transition-all ${
                          isActive
                            ? 'bg-teal-50 text-teal-900 font-bold border border-teal-200/80 shadow-xs'
                            : 'text-slate-600 hover:text-slate-900 hover:bg-slate-50'
                        }`}
                      >
                        <div className="flex items-center gap-2.5 min-w-0">
                          <Icon
                            className={`w-4 h-4 shrink-0 ${
                              isActive ? 'text-teal-600' : 'text-slate-400 group-hover:text-slate-600'
                            }`}
                          />
                          <span className="truncate">{item.label}</span>
                        </div>
                        {item.badge && (
                          <span
                            className={`text-[10px] px-1.5 py-0.5 rounded-full font-bold shrink-0 ${
                              isActive
                                ? 'bg-teal-600 text-white'
                                : 'bg-slate-100 text-slate-500'
                            }`}
                          >
                            {item.badge}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* 右侧主配置面板 */}
        <div className="flex-1 min-w-0 space-y-6">
          {/* ============================================================ */}
          {/* TAB 1: 门店品牌档案 (store) */}
          {/* ============================================================ */}
          {currentTab === 'store' && (
            <div className="space-y-6">
              <SettingsCard
                title={t('settings.stStoreInfoTitle')}
                description={t('settings.stStoreInfoDesc')}
                actions={
                  <Button
                    onClick={() => setConfirmSaveStoreOpen(true)}
                    disabled={saveLocationMutation.isPending}
                    className="bg-teal-600 hover:bg-teal-700 text-white font-bold text-xs"
                  >
                    {saveLocationMutation.isPending ? t('settings.stSaving') : t('settings.stSaveChanges')}
                  </Button>
                }
              >
                <SettingsRow
                  label={t('settings.stLegalName')}
                  description={t('settings.stLegalNameDesc')}
                  required
                >
                  <div className="relative">
                    <Input
                      value={storeName}
                      onChange={(e) => setStoreName(e.target.value)}
                      placeholder={t('settings.stLegalNamePlaceholder')}
                      className="pl-8"
                    />
                    <Building className="w-4 h-4 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                  </div>
                </SettingsRow>

                <SettingsRow
                  label={t('settings.stAvatarTitle')}
                  description={t('settings.stAvatarDesc')}
                  alignTop
                >
                  <div className="space-y-4">
                    {/* 实时品牌徽标预览 */}
                    <div className="flex items-center gap-3 p-3 bg-slate-50 border border-slate-200 rounded-2xl">
                      {customStoreLogoUrl ? (
                        <img
                          src={customStoreLogoUrl}
                          alt={storeName}
                          className="w-12 h-12 rounded-2xl object-cover border-2 border-white shadow-sm shrink-0"
                          onError={() => toast.danger(t('settings.stImageUnreachable'))}
                        />
                      ) : (
                        <div
                          className={`w-12 h-12 rounded-2xl ${
                            PRESET_STORE_THEMES.find((t) => t.id === storeThemeId)?.bg || 'bg-teal-600'
                          } flex items-center justify-center text-2xl shadow-sm shrink-0 border-2 border-white`}
                        >
                          {PRESET_STORE_AVATARS.find((s) => s.id === storeAvatarPresetId)?.icon || '🪷'}
                        </div>
                      )}
                      <div className="min-w-0">
                        <h4 className="text-sm font-bold text-slate-900 truncate">{storeName || t('settings.stMyStore')}</h4>
                        <p className="text-[11px] text-slate-500 truncate">
                          {PRESET_STORE_AVATARS.find((s) => s.id === storeAvatarPresetId)?.desc || t('settings.stBrandMark')}
                        </p>
                      </div>
                    </div>

                    {/* 1. 预设品牌图标 (12款) */}
                    <div className="space-y-1.5">
                      <label className="text-[11px] font-bold text-slate-700 block">{t('settings.stCuratedIcons')}</label>
                      <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
                        {PRESET_STORE_AVATARS.map((item) => (
                          <button
                            key={item.id}
                            type="button"
                            onClick={() => {
                              setStoreAvatarPresetId(item.id);
                              saveStoreAvatar({
                                presetId: item.id,
                                icon: item.icon,
                                themeId: storeThemeId,
                                bg: PRESET_STORE_THEMES.find((t) => t.id === storeThemeId)?.bg || 'bg-teal-600',
                                customLogoUrl: customStoreLogoUrl,
                              });
                            }}
                            className={`flex flex-col items-center gap-1 p-2 rounded-xl border transition-all cursor-pointer ${
                              storeAvatarPresetId === item.id && !customStoreLogoUrl
                                ? 'bg-teal-50/60 border-teal-500 ring-2 ring-teal-500/20 shadow-2xs'
                                : 'bg-white border-slate-200 hover:bg-slate-50'
                            }`}
                          >
                            <span className="text-xl leading-none">{item.icon}</span>
                            <span className="text-[10px] font-bold text-slate-700 truncate w-full text-center">
                              {item.name}
                            </span>
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* 2. 品牌主题色 */}
                    <div className="space-y-1.5">
                      <label className="text-[11px] font-bold text-slate-700 block">{t('settings.stAccentColor')}</label>
                      <div className="flex items-center gap-2.5 flex-wrap">
                        {PRESET_STORE_THEMES.map((theme) => (
                          <button
                            key={theme.id}
                            type="button"
                            onClick={() => {
                              setStoreThemeId(theme.id);
                              saveStoreAvatar({
                                presetId: storeAvatarPresetId,
                                icon: PRESET_STORE_AVATARS.find((s) => s.id === storeAvatarPresetId)?.icon || '🪷',
                                themeId: theme.id,
                                bg: theme.bg,
                                customLogoUrl: customStoreLogoUrl,
                              });
                            }}
                            className={`w-7 h-7 rounded-xl ${theme.bg} flex items-center justify-center text-white transition-all cursor-pointer ${
                              storeThemeId === theme.id
                                ? 'ring-3 ring-teal-500/30 scale-110 shadow-sm'
                                : 'opacity-85 hover:opacity-100'
                            }`}
                            title={theme.name}
                          >
                            {storeThemeId === theme.id && <Check className="w-3.5 h-3.5" />}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* 3. 自定义门店 Logo 上传与图片设置 */}
                    <div className="pt-1">
                      <ImageUploader
                        value={customStoreLogoUrl}
                        onChange={(url) => {
                          setCustomStoreLogoUrl(url);
                          saveStoreAvatar({
                            presetId: storeAvatarPresetId,
                            icon: PRESET_STORE_AVATARS.find((s) => s.id === storeAvatarPresetId)?.icon || '🪷',
                            themeId: storeThemeId,
                            bg: PRESET_STORE_THEMES.find((t) => t.id === storeThemeId)?.bg || 'bg-teal-600',
                            customLogoUrl: url,
                          });
                        }}
                        label={t('settings.stCustomLogoTitle')}
                        description={t('settings.stCustomLogoDesc')}
                        bucket="store_logos"
                        aspectRatio="square"
                        maxWidth={512}
                        maxHeight={512}
                      />
                    </div>
                  </div>
                </SettingsRow>

                <SettingsRow
                  label={t('settings.stSlug')}
                  description={t('settings.stSlugDesc')}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-slate-400 font-mono">book.geniefront.com/</span>
                    <Input
                      value={storeSlug}
                      onChange={(e) => setStoreSlug(e.target.value)}
                      placeholder="lotus-spa-nyc"
                      className="font-mono text-xs"
                    />
                  </div>
                </SettingsRow>

                <SettingsRow
                  label={t('settings.stCategory')}
                  description={t('settings.stCategoryDesc')}
                >
                  <select
                    value={businessType}
                    onChange={(e) => setBusinessType(e.target.value as any)}
                    className="w-full px-3 py-2 text-xs border border-slate-200 rounded-xl bg-white text-slate-900 focus:outline-none focus:ring-2 focus:ring-teal-500/20 focus:border-teal-500"
                  >
                    <option value="mixed">{t('settings.stCatMixed')}</option>
                    <option value="massage">{t('settings.stCatMassage')}</option>
                    <option value="nail">{t('settings.stCatNails')}</option>
                    <option value="foot_spa">{t('settings.stCatFoot')}</option>
                    <option value="scalp">{t('settings.stCatScalp')}</option>
                    <option value="hair">{t('settings.stCatHair')}</option>
                  </select>
                </SettingsRow>

                <SettingsRow
                  label={t('settings.stContact')}
                  description={t('settings.stContactDesc')}
                >
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="relative">
                      <Input
                        value={storePhone}
                        onChange={(e) => setStorePhone(formatPhoneInput(e.target.value))}
                        placeholder="(212) 580-8888"
                        maxLength={14}
                        className="pl-8"
                      />
                      <Phone className="w-4 h-4 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                    </div>
                    <div className="relative">
                      <Input
                        value={storeEmail}
                        onChange={(e) => setStoreEmail(e.target.value)}
                        placeholder="contact@lotusspanyc.com"
                        className="pl-8"
                      />
                      <Mail className="w-4 h-4 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                    </div>
                  </div>
                </SettingsRow>

                <SettingsRow
                  label={t('settings.stAddress')}
                  description={t('settings.stAddressDesc')}
                  alignTop
                >
                  <div className="space-y-2">
                    <div className="relative">
                      <Input
                        value={storeAddressStreet}
                        onChange={(e) => setStoreAddressStreet(e.target.value)}
                        placeholder={t('settings.stStreet')}
                        className="pl-8"
                      />
                      <MapPin className="w-4 h-4 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      <Input
                        value={storeCity}
                        onChange={(e) => setStoreCity(e.target.value)}
                        placeholder={t('settings.stCity')}
                      />
                      <Input
                        value={storeState}
                        onChange={(e) => setStoreState(e.target.value)}
                        placeholder={t('settings.stState')}
                      />
                      <Input
                        value={storeZip}
                        onChange={(e) => setStoreZip(e.target.value)}
                        placeholder={t('settings.stZip')}
                      />
                    </div>
                  </div>
                </SettingsRow>
              </SettingsCard>

              {/* 区域与核算偏好 */}
              <SettingsCard
                title={t('settings.stTimezoneTitle')}
                description={t('settings.stTimezoneDesc')}
              >
                <SettingsRow
                  label={t('settings.stStoreTimezone')}
                  description={t('settings.stStoreTimezoneDesc')}
                >
                  <Input
                    disabled
                    value={storeTimezone}
                    className="bg-slate-50 text-slate-500 font-mono text-xs"
                  />
                </SettingsRow>

                <SettingsRow
                  label={t('settings.stCutoff')}
                  description={t('settings.stCutoffDesc')}
                >
                  <div className="flex items-center gap-3">
                    <Input
                      type="time"
                      value={storeCutoff}
                      onChange={(e) => setStoreCutoff(e.target.value)}
                      className="w-36 text-xs"
                    />
                    <span className="text-xs text-slate-500">{t('settings.stNextDayCutoff')}</span>
                  </div>
                </SettingsRow>

                <SettingsRow
                  label={t('settings.stCurrency')}
                  description={t('settings.stCurrencyDesc')}
                >
                  <Input
                    disabled
                    value={currencySymbol}
                    className="bg-slate-50 text-slate-500 font-mono text-xs w-36"
                  />
                </SettingsRow>
              </SettingsCard>
            </div>
          )}

          {/* ============================================================ */}
          {/* TAB 2: 营业时间与作息 (hours) */}
          {/* ============================================================ */}
          {currentTab === 'hours' && (
            <div className="space-y-6">
              <SettingsCard
                title={t('settings.stHoursTitle')}
                description={t('settings.stHoursDesc')}
                actions={
                  <div className="flex items-center gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={copyMonToWeekdays}
                      className="text-xs font-medium"
                    >
                      
                      {t('settings.stCopyWeekdays')}
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={copyMonToAllDays}
                      className="text-xs font-medium"
                    >
                      
                      {t('settings.stApplyWholeWeek')}
                    </Button>
                    <Button
                      onClick={() => setConfirmSaveHoursOpen(true)}
                      disabled={saveHoursMutation.isPending}
                      className="bg-teal-600 hover:bg-teal-700 text-white font-bold text-xs"
                    >
                      {saveHoursMutation.isPending ? t('settings.stHoursSavingLabel') : t('settings.stSaveHours')}
                    </Button>
                  </div>
                }
              >
                <div className="space-y-3">
                  {DAYS_OF_WEEK.map(({ key, labelZh, labelEn }) => {
                    const current = businessHours[key];
                    const isOpen = Boolean(current);

                    return (
                      <div
                        key={key}
                        className={`flex flex-col sm:flex-row sm:items-center justify-between p-3.5 rounded-2xl border transition-all ${
                          isOpen
                            ? 'bg-white border-slate-200/90 shadow-2xs'
                            : 'bg-slate-50/70 border-slate-200/50 opacity-70'
                        }`}
                      >
                        <div className="flex items-center gap-3 w-44 mb-2 sm:mb-0">
                          <div
                            className={`w-3 h-3 rounded-full ${
                              isOpen ? 'bg-teal-500 ring-4 ring-teal-50' : 'bg-slate-300'
                            }`}
                          />
                          <div>
                            <span className="font-bold text-slate-800 text-xs">{labelZh}</span>
                            <span className="text-[11px] text-slate-400 ml-1.5 font-normal">{labelEn}</span>
                          </div>
                        </div>

                        <div className="flex items-center gap-3">
                          {isOpen ? (
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-xs text-slate-500 font-medium">{t('settings.stOpenPeriod')}</span>
                              <Input
                                type="time"
                                className="w-28 h-8 text-xs font-mono"
                                value={current?.open || '09:30'}
                                onChange={(e) =>
                                  setBusinessHours({
                                    ...businessHours,
                                    [key]: { open: e.target.value, close: current?.close || '19:30' },
                                  })
                                }
                              />
                              <span className="text-slate-400 font-bold">{t('settings.stTo')}</span>
                              <Input
                                type="time"
                                className="w-28 h-8 text-xs font-mono"
                                value={current?.close || '19:30'}
                                onChange={(e) =>
                                  setBusinessHours({
                                    ...businessHours,
                                    [key]: { open: current?.open || '09:30', close: e.target.value },
                                  })
                                }
                              />
                              <Button
                                variant="ghost"
                                size="sm"
                                className="text-xs text-red-600 hover:bg-red-50 hover:text-red-700 h-8 px-2.5 ml-1"
                                onClick={() =>
                                  setBusinessHours({
                                    ...businessHours,
                                    [key]: null,
                                  })
                                }
                              >
                                
                                {t('settings.stSetClosed')}
                              </Button>
                            </div>
                          ) : (
                            <div className="flex items-center gap-3">
                              <Badge variant="default" className="bg-slate-100 text-slate-500 text-xs">
                                
                                {t('settings.stClosedAllDay')}
                              </Badge>
                              <Button
                                variant="secondary"
                                size="sm"
                                className="text-xs h-8"
                                onClick={() =>
                                  setBusinessHours({
                                    ...businessHours,
                                    [key]: { open: '09:30', close: '19:30' },
                                  })
                                }
                              >
                                
                                {t('settings.stOpenForBusiness')}
                              </Button>
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </SettingsCard>
            </div>
          )}

          {/* ============================================================ */}
          {/* TAB 3: 收银与小费偏好 (checkout) */}
          {/* ============================================================ */}
          {currentTab === 'checkout' && (
            <div className="space-y-6">
              <SettingsCard
                title={t('settings.stCheckoutTitle')}
                description={t('settings.stCheckoutDesc')}
                actions={
                  <Button
                    onClick={() => setConfirmSaveCheckoutOpen(true)}
                    disabled={saveCheckoutMutation.isPending}
                    className="bg-teal-600 hover:bg-teal-700 text-white font-bold text-xs"
                  >
                    {saveCheckoutMutation.isPending ? t('settings.stCheckoutSaving') : t('settings.stSaveCheckout')}
                  </Button>
                }
              >
                <SettingsRow
                  label={t('settings.stCheckoutTiming')}
                  description={t('settings.stCheckoutTimingDesc')}
                  alignTop
                >
                  <div className="grid gap-2 max-w-xl">
                    {([
                      ['service_then_tip', 'settings.stTimingServiceThenTip', 'settings.stTimingServiceThenTipDesc'],
                      ['upfront_combined', 'settings.stTimingUpfrontCombined', 'settings.stTimingUpfrontCombinedDesc'],
                      ['after_service_combined', 'settings.stTimingAfterCombined', 'settings.stTimingAfterCombinedDesc'],
                    ] as const).map(([value, label, description]) => (
                      <label
                        key={value}
                        className={cn(
                          'flex gap-3 rounded-xl border p-3 cursor-pointer transition-colors',
                          checkoutTiming === value ? 'border-teal-500 bg-teal-50' : 'border-slate-200 hover:bg-slate-50',
                        )}
                      >
                        <input
                          type="radio"
                          name="checkoutTiming"
                          checked={checkoutTiming === value}
                          onChange={() => setCheckoutTiming(value)}
                          className="mt-0.5 text-teal-600 focus:ring-teal-500"
                        />
                        <span>
                          <span className="block text-xs font-bold text-slate-900">{t(label)}</span>
                          <span className="block mt-0.5 text-[11px] leading-5 text-slate-500">{t(description)}</span>
                        </span>
                      </label>
                    ))}
                    <p className="text-[11px] text-amber-700">{t('settings.stCheckoutTimingSnapshotHint')}</p>
                  </div>
                </SettingsRow>

                <SettingsRow
                  label={t('settings.stTaxRate')}
                  description={t('settings.stTaxRateDesc')}
                  required
                >
                  <div className="flex items-center gap-2 max-w-xs">
                    <div className="relative flex-1">
                      <Input
                        type="number"
                        step="0.001"
                        value={taxRate}
                        onChange={(e) => setTaxRate(e.target.value)}
                        placeholder="8.875"
                        className="pr-8 font-mono text-xs"
                      />
                      <Percent className="w-3.5 h-3.5 text-slate-400 absolute right-2.5 top-1/2 -translate-y-1/2" />
                    </div>
                    <span className="text-xs text-slate-500 font-mono">%</span>
                  </div>
                </SettingsRow>

                <SettingsRow
                  label={t('settings.stTaxMode')}
                  description={t('settings.stTaxModeDesc')}
                >
                  <div className="flex items-center gap-4 text-xs">
                    <label className="flex items-center gap-2 cursor-pointer font-medium text-slate-700">
                      <input
                        type="radio"
                        name="taxMode"
                        checked={taxMode === 'exclusive'}
                        onChange={() => setTaxMode('exclusive')}
                        className="text-teal-600 focus:ring-teal-500 w-4 h-4"
                      />
                      <span>{t('settings.stTaxExclusive')}</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer font-medium text-slate-700">
                      <input
                        type="radio"
                        name="taxMode"
                        checked={taxMode === 'inclusive'}
                        onChange={() => setTaxMode('inclusive')}
                        className="text-teal-600 focus:ring-teal-500 w-4 h-4"
                      />
                      <span>{t('settings.stTaxInclusive')}</span>
                    </label>
                  </div>
                </SettingsRow>

                <SettingsRow
                  label={t('settings.stTipPresets')}
                  description={t('settings.stTipPresetsDesc')}
                >
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      {tipPresets.map((tip, idx) => (
                        <div key={idx} className="relative w-20">
                          <Input
                            type="number"
                            value={tip}
                            onChange={(e) => {
                              const newTips = [...tipPresets];
                              newTips[idx] = e.target.value;
                              setTipPresets(newTips);
                            }}
                            className="pr-6 font-mono text-center text-xs"
                          />
                          <span className="text-xs text-slate-400 absolute right-2 top-1/2 -translate-y-1/2 font-mono">
                            %
                          </span>
                        </div>
                      ))}
                    </div>
                    <label className="flex items-center gap-2 cursor-pointer text-xs text-slate-600 pt-1">
                      <input
                        type="checkbox"
                        checked={allowCustomTip}
                        onChange={(e) => setAllowCustomTip(e.target.checked)}
                        className="rounded border-slate-300 text-teal-600 focus:ring-teal-500 w-4 h-4"
                      />
                      <span>{t('settings.stAllowCustomTip')}</span>
                    </label>
                  </div>
                </SettingsRow>

                <SettingsRow
                  label={t('settings.stCashFloat')}
                  description={t('settings.stCashFloatDesc')}
                >
                  <div className="relative max-w-xs">
                    <Input
                      type="number"
                      value={cashDrawerFloat}
                      onChange={(e) => setCashDrawerFloat(e.target.value)}
                      placeholder="200.00"
                      className="pl-8 font-mono text-xs"
                    />
                    <DollarSign className="w-4 h-4 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                  </div>
                </SettingsRow>

                <SettingsRow
                  label={t('settings.stReceiptFooter')}
                  description={t('settings.stReceiptFooterDesc')}
                  alignTop
                >
                  <textarea
                    rows={3}
                    value={receiptFooter}
                    onChange={(e) => setReceiptFooter(e.target.value)}
                    placeholder={t('settings.stReceiptFooterPlaceholder')}
                    className="w-full p-2.5 text-xs rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-teal-500/20 focus:border-teal-500 leading-relaxed"
                  />
                </SettingsRow>

                <SettingsRow label={t('settings.stAutoReceipts')}>
                  <div className="space-y-2 text-xs">
                    <label className="flex items-center gap-2 cursor-pointer text-slate-700">
                      <input
                        type="checkbox"
                        checked={autoPrintReceipt}
                        onChange={(e) => setAutoPrintReceipt(e.target.checked)}
                        className="rounded border-slate-300 text-teal-600 focus:ring-teal-500 w-4 h-4"
                      />
                      <span>{t('settings.stAutoPrint')}</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer text-slate-700">
                      <input
                        type="checkbox"
                        checked={autoSendSmsReceipt}
                        onChange={(e) => setAutoSendSmsReceipt(e.target.checked)}
                        className="rounded border-slate-300 text-teal-600 focus:ring-teal-500 w-4 h-4"
                      />
                      <span>{t('settings.stAutoSms')}</span>
                    </label>
                  </div>
                </SettingsRow>
              </SettingsCard>
            </div>
          )}

          {/* ============================================================ */}
          {/* TAB 4: 预约与排班规则 (booking) */}
          {/* ============================================================ */}
          {currentTab === 'booking' && (
            <div className="space-y-6">
              <SettingsCard
                title={t('settings.stBookingTitle')}
                description={t('settings.stBookingDesc')}
                actions={
                  <Button
                    onClick={() => setConfirmSaveBookingOpen(true)}
                    disabled={saveOnlineBookingMutation.isPending}
                    className="bg-teal-600 hover:bg-teal-700 text-white font-bold text-xs"
                  >
                    {saveOnlineBookingMutation.isPending ? t('settings.stBookingSaving') : t('settings.stSaveBooking')}
                  </Button>
                }
              >
                <SettingsRow
                  label={t('settings.stBookingMaster')}
                  description={t('settings.stBookingMasterDesc')}
                >
                  <div className="flex items-center justify-between p-3 rounded-xl border border-slate-200 bg-slate-50/60 max-w-md">
                    <div>
                      <span className="font-bold text-xs text-slate-900 block">
                        {onlineEnabled ? t('settings.stBookingOn') : t('settings.stBookingOff')}
                      </span>
                      <span className="text-[11px] text-slate-500">
                        {onlineEnabled ? t('settings.stBookingOnDesc') : t('settings.stBookingOffDesc')}
                      </span>
                    </div>
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input
                        type="checkbox"
                        checked={onlineEnabled}
                        onChange={(e) => setOnlineEnabled(e.target.checked)}
                        className="sr-only peer"
                      />
                      <div className="w-10 h-5 bg-slate-200 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-teal-600" />
                    </label>
                  </div>
                </SettingsRow>

                <SettingsRow
                  label={t('settings.stBookingWindow')}
                  description={t('settings.stBookingWindowDesc')}
                >
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-w-md">
                    <div className="space-y-1">
                      <label className="text-[11px] font-bold text-slate-600">{t('settings.stMaxAdvance')}</label>
                      <div className="relative">
                        <Input
                          type="number"
                          value={maxDaysAhead}
                          onChange={(e) => setMaxDaysAhead(e.target.value)}
                          placeholder="60"
                          className="pr-12 font-mono text-xs"
                        />
                        <span className="text-xs text-slate-400 absolute right-3 top-1/2 -translate-y-1/2">
                          
                          {t('settings.stDaysUnit')}
                        </span>
                      </div>
                    </div>
                    <div className="space-y-1">
                      <label className="text-[11px] font-bold text-slate-600">{t('settings.stMinAdvance')}</label>
                      <div className="relative">
                        <Input
                          type="number"
                          value={minMinutesAhead}
                          onChange={(e) => setMinMinutesAhead(e.target.value)}
                          placeholder="120"
                          className="pr-14 font-mono text-xs"
                        />
                        <span className="text-xs text-slate-400 absolute right-3 top-1/2 -translate-y-1/2">
                          
                          {t('settings.stMinutesUnit')}
                        </span>
                      </div>
                    </div>
                  </div>
                </SettingsRow>

                <SettingsRow
                  label={t('settings.stCancelWindow')}
                  description={t('settings.stCancelWindowDesc')}
                >
                  <div className="flex items-center gap-2 max-w-xs">
                    <div className="relative flex-1">
                      <Input
                        type="number"
                        value={cancelCutoffHours}
                        onChange={(e) => setCancelCutoffHours(e.target.value)}
                        placeholder="4"
                        className="pr-14 font-mono text-xs"
                      />
                      <span className="text-xs text-slate-400 absolute right-3 top-1/2 -translate-y-1/2">
                        
                        {t('settings.stHoursBefore')}
                      </span>
                    </div>
                  </div>
                </SettingsRow>

                <SettingsRow
                  label={t('settings.stSlotGranularity')}
                  description={t('settings.stSlotGranularityDesc')}
                >
                  <div className="flex items-center gap-3">
                    {[
                      { val: '15', label: t('settings.stSlot15') },
                      { val: '30', label: t('settings.stSlot30') },
                      { val: '60', label: t('settings.stSlot60') },
                    ].map((opt) => (
                      <button
                        key={opt.val}
                        type="button"
                        onClick={() => setSlotInterval(opt.val as any)}
                        className={`px-3 py-1.5 rounded-xl border text-xs font-semibold transition-all ${
                          slotInterval === opt.val
                            ? 'bg-teal-50 border-teal-300 text-teal-900 shadow-2xs'
                            : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </SettingsRow>

                <SettingsRow
                  label={t('settings.stDepositTitle')}
                  description={t('settings.stDepositDesc')}
                >
                  <div className="space-y-3 max-w-md">
                    <label className="flex items-center gap-2 cursor-pointer text-xs font-medium text-slate-700">
                      <input
                        type="checkbox"
                        checked={requireDeposit}
                        onChange={(e) => setRequireDeposit(e.target.checked)}
                        className="rounded border-slate-300 text-teal-600 focus:ring-teal-500 w-4 h-4"
                      />
                      <span>{t('settings.stRequireDeposit')}</span>
                    </label>

                    {requireDeposit && (
                      <div className="p-3 bg-slate-50 rounded-xl border border-slate-200 space-y-2">
                        <label className="text-[11px] font-bold text-slate-700 block">{t('settings.stDefaultDeposit')}</label>
                        <div className="relative max-w-xs">
                          <Input
                            type="number"
                            value={depositAmount}
                            onChange={(e) => setDepositAmount(e.target.value)}
                            placeholder="20.00"
                            className="pl-8 font-mono text-xs"
                          />
                          <DollarSign className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                        </div>
                      </div>
                    )}
                  </div>
                </SettingsRow>
              </SettingsCard>
            </div>
          )}

          {/* ============================================================ */}
          {/* TAB 5: 服务项目与价目表 (services) */}
          {/* ============================================================ */}
          {currentTab === 'services' && (
            <div className="space-y-6">
              <SettingsCard
                title={t('settings.stServiceCatalogTitle')}
                description={t('settings.stServiceCatalogDesc', { p0: settings?.services.length || 0 })}
                actions={
                  <Button
                    size="sm"
                    onClick={() => handleOpenServiceModal()}
                    className="gap-1.5 bg-teal-600 hover:bg-teal-700 text-white font-bold text-xs shadow-xs"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>{t('settings.stAddService')}</span>
                  </Button>
                }
              >
                {/* 筛选与搜索栏 */}
                <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 mb-4">
                  <div className="relative flex-1 max-w-sm">
                    <Input
                      value={serviceSearch}
                      onChange={(e) => setServiceSearch(e.target.value)}
                      placeholder={t('settings.stServiceSearch')}
                      className="pl-8 text-xs"
                    />
                    <Search className="w-4 h-4 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                  </div>
                  <div className="flex items-center gap-1.5 text-xs">
                    <button
                      type="button"
                      onClick={() => setServiceCategoryFilter('all')}
                      className={`px-2.5 py-1.5 rounded-lg font-medium ${
                        serviceCategoryFilter === 'all'
                          ? 'bg-slate-900 text-white'
                          : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                      }`}
                    >
                      
                      {t('settings.stFilterAll')}{settings?.services.length || 0})
                    </button>
                    <button
                      type="button"
                      onClick={() => setServiceCategoryFilter('online')}
                      className={`px-2.5 py-1.5 rounded-lg font-medium ${
                        serviceCategoryFilter === 'online'
                          ? 'bg-slate-900 text-white'
                          : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                      }`}
                    >
                      
                      {t('settings.stFilterBookable')}
                    </button>
                    <button
                      type="button"
                      onClick={() => setServiceCategoryFilter('addon')}
                      className={`px-2.5 py-1.5 rounded-lg font-medium ${
                        serviceCategoryFilter === 'addon'
                          ? 'bg-slate-900 text-white'
                          : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                      }`}
                    >
                      
                      {t('settings.stFilterAddOn')}
                    </button>
                  </div>
                </div>

                {/* 服务列表 */}
                <div className="rounded-2xl border border-slate-200 overflow-hidden divide-y divide-slate-100 bg-white">
                  {filteredServices.length === 0 ? (
                    <div className="p-8 text-center text-slate-400 text-xs">
                      
                      {t('settings.stNoServiceMatch')}
                    </div>
                  ) : (
                    filteredServices.map((svc) => (
                      <div
                        key={svc.id}
                        className="p-4 flex items-center justify-between hover:bg-slate-50/80 transition-colors"
                      >
                        <div className="space-y-1">
                          <div className="flex items-center gap-2">
                            <span className="font-bold text-slate-900 text-xs sm:text-sm">
                              {svc.displayName}
                            </span>
                            {svc.onlineBookable && (
                              <Badge className="bg-teal-50 text-teal-700 border-teal-200 text-[10px]">
                                
                                {t('settings.stBookableTag')}
                              </Badge>
                            )}
                            {svc.isAddon && (
                              <Badge className="bg-purple-50 text-purple-700 border-purple-200 text-[10px]">
                                
                                {t('settings.stAddOnTag')}
                              </Badge>
                            )}
                            {svc.taxable && (
                              <Badge className="bg-slate-100 text-slate-600 text-[10px]">
                                
                                {t('settings.stTaxableTag')}
                              </Badge>
                            )}
                          </div>
                          <p className="text-xs text-slate-500 font-mono">
                            Duration: <span className="font-bold text-slate-700">{svc.durationMin}  {t('settings.stMinutesUnit2')}</span>  {t('settings.stBasePriceLabel')}{' '}
                            <span className="font-bold text-teal-700">${centsToDollars(svc.basePriceCents)}</span>
                          </p>
                        </div>

                        <div className="flex items-center gap-1.5">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleOpenServiceModal(svc)}
                            className="text-xs text-slate-600 gap-1"
                          >
                            <Edit2 className="w-3.5 h-3.5 text-slate-400" />
                            <span>{t('settings.stEdit')}</span>
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setArchivingService(svc)}
                            className="text-xs text-red-600 hover:bg-red-50 hover:text-red-700"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </Button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </SettingsCard>
            </div>
          )}

          {/* ============================================================ */}
          {/* TAB 6: 员工管理与调度 (staff) */}
          {/* ============================================================ */}
          {currentTab === 'staff' && (
            <div className="space-y-6">
              <SettingsCard
                title={t('settings.stStaffTitle')}
                description={t('settings.stStaffDesc', { p0: settings?.staff.length || 0 })}
              >
                {/* 搜索 */}
                <div className="mb-4 max-w-sm relative">
                  <Input
                    value={staffSearch}
                    onChange={(e) => setStaffSearch(e.target.value)}
                    placeholder={t('settings.stStaffSearch')}
                    className="pl-8 text-xs"
                  />
                  <Search className="w-4 h-4 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                </div>

                <div className="rounded-2xl border border-slate-200 overflow-hidden divide-y divide-slate-100 bg-white">
                  {filteredStaff.length === 0 ? (
                    <div className="p-8 text-center text-slate-400 text-xs">
                      
                      {t('settings.stNoStaffMatch')}
                    </div>
                  ) : (
                    filteredStaff.map((stf) => (
                      <div
                        key={stf.membershipId}
                        className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 hover:bg-slate-50/80 transition-colors"
                      >
                        <div className="flex items-center gap-3.5">
                          <div className="w-10 h-10 rounded-full bg-teal-100 text-teal-800 font-bold flex items-center justify-center text-sm border border-teal-200 shrink-0">
                            {stf.name.charAt(0)}
                          </div>
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="font-bold text-slate-900 text-xs sm:text-sm">{stf.name}</span>
                              <span className="text-[10px] font-semibold text-slate-500 bg-slate-100 px-2 py-0.5 rounded-full">
                                {stf.roleKeys?.join(' · ') || 'Staff'}
                              </span>
                              {stf.hasAccount && (
                                <Badge className="bg-emerald-50 text-emerald-700 border-emerald-200 text-[10px]">
                                  
                                  {t('settings.stAccountActive')}
                                </Badge>
                              )}
                            </div>
                            <p className="text-xs text-slate-500 mt-0.5 font-mono">
                              
                              {t('settings.stPhoneLabel')} {stf.phoneE164 ? formatPhoneDisplay(stf.phoneE164) : '—'}  {t('settings.stMaxConcurrentLabel')} {stf.maxConcurrent}
                            </p>
                          </div>
                        </div>

                        <div className="flex items-center gap-4 self-end sm:self-center">
                          <label
                            className="flex items-center gap-2 cursor-pointer text-xs font-semibold text-slate-700 select-none"
                            onClick={(e) => {
                              e.preventDefault();
                              setConfirmRotationTarget({
                                staff: stf,
                                nextInRotation: !stf.inRotation,
                              });
                            }}
                          >
                            <input
                              type="checkbox"
                              checked={stf.inRotation}
                              readOnly
                              className="rounded border-slate-300 text-teal-600 focus:ring-teal-500 w-4 h-4 pointer-events-none"
                            />
                            <span>{t('settings.stJoinRotation')}</span>
                          </label>

                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleOpenStaffModal(stf)}
                            className="text-xs text-slate-600 gap-1"
                          >
                            <Edit2 className="w-3.5 h-3.5 text-slate-400" />
                            <span>{t('settings.stConfigure')}</span>
                          </Button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </SettingsCard>
            </div>
          )}

          {/* ============================================================ */}
          {/* TAB 7: AI 电话助手 (ai_phone) */}
          {/* ============================================================ */}
          {currentTab === 'ai_phone' && (
            <div className="space-y-6">
              <SettingsCard
                title={t('settings.stAiTitle')}
                description={t('settings.stAiDesc')}
                actions={
                  <Button
                    onClick={() => setConfirmSavePhoneOpen(true)}
                    disabled={savePhoneAssistantMutation.isPending}
                    className="bg-teal-600 hover:bg-teal-700 text-white font-bold text-xs"
                  >
                    {savePhoneAssistantMutation.isPending ? t('settings.stAiSaving') : t('settings.stSaveAi')}
                  </Button>
                }
              >
                {/* 线路绑定状态 */}
                <div className="p-4 rounded-2xl border border-slate-200 bg-slate-50/60 mb-4 grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs">
                  <div>
                    <span className="text-slate-500 block mb-1 font-medium">{t('settings.stPublicMainNumber')}</span>
                    <span className="font-mono font-bold text-slate-900 text-sm">
                      {formatPhoneDisplay(settings?.phone.storefrontE164 || storePhone) || '—'}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-500 block mb-1 font-medium">{t('settings.stAiDidNumber')}</span>
                    <span className="font-mono font-bold text-teal-700 text-sm">
                      {formatPhoneDisplay(settings?.phone.aiVoiceE164) || t('settings.stDidReady')}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-500 block mb-1 font-medium">{t('settings.stAgentTransferNumber')}</span>
                    <span className="font-mono font-bold text-slate-900 text-sm">
                      {formatPhoneDisplay(forwardPhone || settings?.phone.transferTargetE164) || '—'}
                    </span>
                  </div>
                </div>

                <SettingsRow
                  label={t('settings.stGreetingPrompt')}
                  description={t('settings.stGreetingPromptDesc')}
                  alignTop
                >
                  <div className="space-y-2">
                    <textarea
                      ref={greetingTextareaRef}
                      rows={4}
                      value={greetingPrompt}
                      onChange={(e) => setGreetingPrompt(e.target.value)}
                      className="w-full p-3 text-xs rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-teal-500/20 focus:border-teal-500 leading-relaxed font-sans"
                    />
                    <div className="flex items-center gap-1.5 flex-wrap text-xs">
                      <span className="text-slate-400 text-[11px]">{t('settings.stInsertVariables')}</span>
                      <button
                        type="button"
                        onClick={() => handleInsertVariable(t('settings.stVarStoreName'))}
                        className="px-2 py-0.5 bg-slate-100 hover:bg-slate-200 rounded text-[11px] font-mono text-slate-700"
                      >
                        + {t('settings.stVarStoreName2')}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleInsertVariable(t('settings.stVarHoursToday'))}
                        className="px-2 py-0.5 bg-slate-100 hover:bg-slate-200 rounded text-[11px] font-mono text-slate-700"
                      >
                        + {t('settings.stVarHoursToday2')}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleInsertVariable(t('settings.stVarFeaturedService'))}
                        className="px-2 py-0.5 bg-slate-100 hover:bg-slate-200 rounded text-[11px] font-mono text-slate-700"
                      >
                        + {t('settings.stVarFeaturedService2')}
                      </button>
                    </div>
                  </div>
                </SettingsRow>

                <SettingsRow
                  label={t('settings.stFallbackPhone')}
                  description={t('settings.stFallbackPhoneDesc')}
                  required
                >
                  <div className="relative max-w-sm">
                    <Input
                      value={forwardPhone}
                      onChange={(e) => setForwardPhone(formatPhoneInput(e.target.value))}
                      placeholder="(212) 555-0199"
                      maxLength={14}
                      className="pl-8 font-mono text-xs"
                    />
                    <Phone className="w-4 h-4 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                  </div>
                </SettingsRow>

                <SettingsRow
                  label={t('settings.stVoiceStyle')}
                  description={t('settings.stVoiceStyleDesc')}
                >
                  <div className="flex items-center gap-3">
                    {[
                      { val: 'warm', label: t('settings.stVoiceWarm') },
                      { val: 'professional', label: t('settings.stVoiceProfessional') },
                      { val: 'concise', label: t('settings.stVoiceEfficient') },
                    ].map((tone) => (
                      <button
                        key={tone.val}
                        type="button"
                        onClick={() => setVoiceTone(tone.val as any)}
                        className={`px-3 py-1.5 rounded-xl border text-xs font-semibold transition-all ${
                          voiceTone === tone.val
                            ? 'bg-teal-50 border-teal-300 text-teal-900 shadow-2xs'
                            : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
                        }`}
                      >
                        {tone.label}
                      </button>
                    ))}
                  </div>
                </SettingsRow>

                <SettingsRow
                  label={t('settings.stAutoBook')}
                  description={t('settings.stAutoBookDesc')}
                >
                  <label className="flex items-center gap-2 cursor-pointer text-xs font-medium text-slate-700">
                    <input
                      type="checkbox"
                      checked={autoBookEnabled}
                      onChange={(e) => setAutoBookEnabled(e.target.checked)}
                      className="rounded border-slate-300 text-teal-600 focus:ring-teal-500 w-4 h-4"
                    />
                    <span>{t('settings.stAutoBookLockDesc')}</span>
                  </label>
                </SettingsRow>
              </SettingsCard>
            </div>
          )}

          {/* ============================================================ */}
          {/* TAB 8: 10DLC 短信资质代办 (10dlc) */}
          {/* ============================================================ */}
          {currentTab === '10dlc' && (
            <div className="space-y-6">
              <SettingsCard
                title={t('settings.st10dlcTitle')}
                description={t('settings.st10dlcDesc')}
                badge={
                  tenDlcStatus === 'approved' ? (
                    <Badge variant="success" className="text-xs font-bold gap-1">
                      <CheckCircle2 className="w-3.5 h-3.5" />  {t('settings.st10dlcApproved')}
                    </Badge>
                  ) : tenDlcStatus === 'pending_review' ? (
                    <Badge variant="warning" className="text-xs font-bold gap-1">
                      <Clock className="w-3.5 h-3.5" />  {t('settings.st10dlcReviewing')}
                    </Badge>
                  ) : (
                    <Badge variant="error" className="text-xs font-bold gap-1">
                      <Lock className="w-3.5 h-3.5" />  {t('settings.st10dlcNotSubmitted')}
                    </Badge>
                  )
                }
              >
                {/* 状态提示卡片 */}
                {tenDlcStatus === 'approved' ? (
                  <div className="p-4 rounded-2xl bg-emerald-50 border border-emerald-200 text-emerald-950 text-xs space-y-1 mb-4">
                    <p className="font-bold flex items-center gap-1.5 text-sm text-emerald-900">
                      <ShieldCheck className="w-4 h-4 text-emerald-600" />
                      
                      {t('settings.st10dlcActiveTitle')}
                    </p>
                    <p className="text-emerald-800 leading-relaxed">
                      
                      {t('settings.st10dlcActiveDesc')}
                    </p>
                  </div>
                ) : tenDlcStatus === 'pending_review' ? (
                  <div className="p-4 rounded-2xl bg-amber-50 border border-amber-200 text-amber-950 text-xs space-y-1 mb-4">
                    <p className="font-bold flex items-center gap-1.5 text-sm text-amber-900">
                      <Clock className="w-4 h-4 text-amber-600" />
                      
                      {t('settings.st10dlcReviewTitle')}
                    </p>
                    <p className="text-amber-800 leading-relaxed">
                      
                      {t('settings.st10dlcReviewDesc')}
                    </p>
                  </div>
                ) : (
                  <div className="p-4 rounded-2xl bg-red-50 border border-red-200 text-red-950 text-xs space-y-1 mb-4">
                    <p className="font-bold flex items-center gap-1.5 text-sm text-red-900">
                      <ShieldAlert className="w-4 h-4 text-red-600" />
                      
                      {t('settings.st10dlcNoneTitle')}
                    </p>
                    <p className="text-red-800 leading-relaxed">
                      
                      {t('settings.st10dlcNoneDesc')}
                    </p>
                  </div>
                )}

                {/* 表单字段 */}
                <div className="space-y-4">
                  <div className="border-b border-slate-100 pb-3">
                    <h4 className="font-bold text-slate-900 text-xs flex items-center gap-1.5">
                      <Building className="w-4 h-4 text-teal-600" />
                      
                      {t('settings.st10dlcSection1')}
                    </h4>
                  </div>

                  <SettingsRow
                    label={t('settings.stLegalCompanyName')}
                    description={t('settings.stLegalCompanyPlaceholder')}
                    required
                  >
                    <Input
                      value={legalName}
                      onChange={(e) => setLegalName(e.target.value)}
                      placeholder="Lotus Spa & Wellness LLC"
                      className="text-xs"
                    />
                  </SettingsRow>

                  <SettingsRow
                    label={t('settings.stEin')}
                    description={t('settings.stEinDesc')}
                    required
                  >
                    <Input
                      value={ein}
                      onChange={(e) => setEin(e.target.value)}
                      placeholder="12-3456789"
                      className="font-mono text-xs max-w-xs"
                    />
                  </SettingsRow>

                  <SettingsRow
                    label={t('settings.stRegisteredAddress')}
                    description={t('settings.stRegisteredAddressDesc')}
                    required
                  >
                    <Input
                      value={regAddress}
                      onChange={(e) => setRegAddress(e.target.value)}
                      placeholder="128 E 56th St, New York, NY 10022"
                      className="text-xs"
                    />
                  </SettingsRow>

                  <SettingsRow label={t('settings.stEntityType')}>
                    <select
                      value={businessStructure}
                      onChange={(e) => setBusinessStructure(e.target.value as any)}
                      className="w-full max-w-xs px-3 py-2 text-xs border border-slate-200 rounded-xl bg-white text-slate-900 focus:outline-none focus:ring-2 focus:ring-teal-500/20"
                    >
                      <option value="llc">{t('settings.stEntityLlc')}</option>
                      <option value="corp">{t('settings.stEntityCorp')}</option>
                      <option value="sole_prop">{t('settings.stEntitySole')}</option>
                      <option value="partnership">{t('settings.stEntityPartnership')}</option>
                    </select>
                  </SettingsRow>

                  <div className="border-b border-slate-100 pb-3 pt-4">
                    <h4 className="font-bold text-slate-900 text-xs flex items-center gap-1.5">
                      <Users className="w-4 h-4 text-teal-600" />
                      
                      {t('settings.st10dlcSection2')}
                    </h4>
                  </div>

                  <SettingsRow label={t('settings.stRepNameTitle')} required>
                    <div className="grid grid-cols-2 gap-3">
                      <Input
                        value={repName}
                        onChange={(e) => setRepName(e.target.value)}
                        placeholder="Emily Zhang"
                        className="text-xs"
                      />
                      <Input
                        value={repTitle}
                        onChange={(e) => setRepTitle(e.target.value)}
                        placeholder="Store Owner / Manager"
                        className="text-xs"
                      />
                    </div>
                  </SettingsRow>

                  <SettingsRow label={t('settings.stRepContact')} required>
                    <div className="grid grid-cols-2 gap-3">
                      <Input
                        value={repEmail}
                        onChange={(e) => setRepEmail(e.target.value)}
                        placeholder="owner@lotusspanyc.com"
                        className="text-xs"
                      />
                      <Input
                        value={repPhone}
                        onChange={(e) => setRepPhone(formatPhoneInput(e.target.value))}
                        placeholder="(212) 580-8888"
                        maxLength={14}
                        className="text-xs"
                      />
                    </div>
                  </SettingsRow>

                  <div className="border-b border-slate-100 pb-3 pt-4">
                    <h4 className="font-bold text-slate-900 text-xs flex items-center gap-1.5">
                      <FileText className="w-4 h-4 text-teal-600" />
                      
                      {t('settings.st10dlcSection3')}
                    </h4>
                  </div>

                  <SettingsRow
                    label={t('settings.stOptInWorkflow')}
                    description={t('settings.stOptInDesc')}
                    alignTop
                  >
                    <Input
                      value={optInMethod}
                      onChange={(e) => setOptInMethod(e.target.value)}
                      className="text-xs"
                    />
                  </SettingsRow>

                  <SettingsRow
                    label={t('settings.stSmsSample')}
                    alignTop
                  >
                    <textarea
                      rows={2}
                      value={sampleMsg1}
                      onChange={(e) => setSampleMsg1(e.target.value)}
                      className="w-full p-2.5 text-xs rounded-xl border border-slate-200 font-mono text-slate-800"
                    />
                  </SettingsRow>
                </div>

                {/* 底部操作 */}
                <div className="pt-6 border-t border-slate-100 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                  <div className="text-xs text-slate-500">
                    
                    {t('settings.st10dlcSubmitNote')}
                  </div>

                  <Button
                    onClick={() => setConfirmTenDlcOpen(true)}
                    disabled={apply10DlcMutation.isPending}
                    className="bg-teal-600 hover:bg-teal-700 text-white font-bold text-xs shadow-md"
                  >
                    {apply10DlcMutation.isPending ? t('settings.st10dlcSubmitting') : t('settings.stSubmit10dlc')}
                  </Button>
                </div>
              </SettingsCard>
            </div>
          )}

          {/* ============================================================ */}
          {/* TAB 9: 硬件设备与大堂副屏 (hardware) */}
          {/* ============================================================ */}
          {currentTab === 'hardware' && (
            <HardwareServer embedded />
          )}

          {/* ============================================================ */}
          {/* TAB 10: 网站插件与 API (integrations) */}
          {/* ============================================================ */}
          {currentTab === 'integrations' && (
            <div className="space-y-6">
              <SettingsCard
                title={t('settings.stApiTitle')}
                description={t('settings.stApiDesc')}
              >
                {/* API Key */}
                <div className="p-4 rounded-2xl bg-slate-50 border border-slate-200 space-y-2 mb-6">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-bold text-slate-700 uppercase">{t('settings.stPublicKey')}</span>
                    <button
                      type="button"
                      onClick={copyPublicKey}
                      className="text-teal-600 hover:text-teal-700 font-bold flex items-center gap-1"
                    >
                      {copiedKey ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                      <span>{copiedKey ? t('settings.stCopied') : t('settings.stCopyApiKey')}</span>
                    </button>
                  </div>
                  <code className="block p-3 rounded-xl bg-white border border-slate-200 text-xs font-mono text-slate-800 break-all select-all font-semibold">
                    {settings?.guest?.publicKey || 'pk_live_gf_demo_8829910248201'}
                  </code>
                </div>

                {/* 允许域名 */}
                <div className="space-y-3">
                  <label className="text-xs font-bold text-slate-800 block">
                    
                    {t('settings.stCorsOrigins')}
                  </label>
                  <p className="text-[11px] text-slate-500">
                    
                    {t('settings.stCorsDesc')}
                  </p>
                  <div className="flex gap-2">
                    <Input
                      placeholder="https://www.mybrandspa.com"
                      value={newOriginUrl}
                      onChange={(e) => setNewOriginUrl(e.target.value)}
                      className="text-xs font-mono"
                    />
                    <Button
                      onClick={handleAddOrigin}
                      disabled={addOriginMutation.isPending}
                      className="shrink-0 bg-teal-600 text-white font-bold text-xs"
                    >
                      
                      {t('settings.stAddDomain')}
                    </Button>
                  </div>

                  <div className="space-y-2 pt-2">
                    {settings?.guest?.allowedOrigins?.map((orig) => (
                      <div
                        key={orig.id}
                        className="flex items-center justify-between p-3 bg-slate-50 rounded-xl border border-slate-200 text-xs"
                      >
                        <span className="font-mono font-bold text-slate-800">{orig.origin}</span>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-xs text-red-600 hover:bg-red-50"
                          onClick={() => handleRemoveOrigin(orig.id)}
                        >
                          
                          {t('settings.stRemove')}
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Webhook */}
                <div className="pt-6 border-t border-slate-100 space-y-3">
                  <div className="flex items-center gap-2">
                    <Webhook className="w-4 h-4 text-teal-600" />
                    <h4 className="font-bold text-slate-900 text-xs">{t('settings.stWebhookEvents')}</h4>
                  </div>
                  <Input
                    value={webhookUrl}
                    onChange={(e) => setWebhookUrl(e.target.value)}
                    placeholder="https://api.mybrand.com/webhooks/gf-events"
                    className="text-xs font-mono"
                  />
                  <div className="flex items-center gap-4 text-xs pt-1">
                    <label className="flex items-center gap-1.5 cursor-pointer text-slate-700">
                      <input
                        type="checkbox"
                        checked={webhookEvents.bookingCreated}
                        onChange={(e) =>
                          setWebhookEvents({ ...webhookEvents, bookingCreated: e.target.checked })
                        }
                        className="rounded border-slate-300 text-teal-600 w-3.5 h-3.5"
                      />
                      <span>{t('settings.stEventBookingCreated')}</span>
                    </label>
                    <label className="flex items-center gap-1.5 cursor-pointer text-slate-700">
                      <input
                        type="checkbox"
                        checked={webhookEvents.ticketPaid}
                        onChange={(e) =>
                          setWebhookEvents({ ...webhookEvents, ticketPaid: e.target.checked })
                        }
                        className="rounded border-slate-300 text-teal-600 w-3.5 h-3.5"
                      />
                      <span>{t('settings.stEventTicketPaid')}</span>
                    </label>
                    <label className="flex items-center gap-1.5 cursor-pointer text-slate-700">
                      <input
                        type="checkbox"
                        checked={webhookEvents.bookingCancelled}
                        onChange={(e) =>
                          setWebhookEvents({ ...webhookEvents, bookingCancelled: e.target.checked })
                        }
                        className="rounded border-slate-300 text-teal-600 w-3.5 h-3.5"
                      />
                      <span>{t('settings.stEventBookingCancelled')}</span>
                    </label>
                  </div>
                  <div className="flex justify-end pt-2">
                    <Button
                      onClick={handleSaveWebhooks}
                      disabled={saveWebhooksMutation.isPending}
                      className="bg-teal-600 hover:bg-teal-700 text-white font-bold text-xs"
                    >
                      {saveWebhooksMutation.isPending ? t('settings.stWebhookSaving') : t('settings.stSaveWebhook')}
                    </Button>
                  </div>
                </div>
              </SettingsCard>
            </div>
          )}

          {/* ============================================================ */}
          {/* TAB 11: SaaS 订阅方案与账单 (billing) */}
          {/* ============================================================ */}
          {currentTab === 'billing' && (
            <div className="space-y-6">
              <SettingsCard
                title={t('settings.stBillingTitle')}
                description={t('settings.stBillingDesc')}
                badge={
                  <Badge variant="success" className="text-xs font-bold gap-1">
                    <CheckCircle2 className="w-3.5 h-3.5" />  {t('settings.stGrowthActive')}
                  </Badge>
                }
              >
                {/* 当前订阅主卡片 */}
                <div className="p-5 rounded-2xl bg-gradient-to-r from-teal-900 to-slate-900 text-white shadow-md flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-6">
                  <div className="space-y-1">
                    <span className="text-[10px] uppercase tracking-wider text-teal-300 font-bold">
                      Current Active Subscription
                    </span>
                    <h3 className="text-xl font-black text-white">
                      
                      {t('settings.stGrowthPrice')}
                    </h3>
                    <p className="text-xs text-teal-100/80">
                      
                      {t('settings.stRenewalInfo')}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={createPortalMutation.isPending}
                      onClick={async () => {
                        try {
                          const res = await createPortalMutation.mutateAsync();
                          if (res?.url) {
                            window.open(res.url, '_blank');
                          } else {
                            toast.success(t('settings.stStripeRedirect'));
                          }
                        } catch (err: any) {
                          toast.danger(errorMessage(err));
                        }
                      }}
                      className="text-xs font-bold bg-white/10 hover:bg-white/20 text-white border-white/20"
                    >
                      {createPortalMutation.isPending ? t('settings.stBillingLoading') : t('settings.stManageCard')}
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => setConfirmChangePlan(t('settings.stPlanEnterprise'))}
                      className="text-xs font-bold bg-teal-500 hover:bg-teal-600 text-white shadow-sm"
                    >
                      
                      {t('settings.stUpgradeEnterprise')}
                    </Button>
                  </div>
                </div>

                {/* AI 算力仪表板 */}
                <div className="space-y-3 mb-6">
                  <h4 className="font-bold text-slate-900 text-xs uppercase tracking-wider text-slate-500">
                    
                    {t('settings.stUsageQuotas')}
                  </h4>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="p-4 rounded-2xl border border-slate-200 bg-white space-y-2.5 shadow-2xs">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold text-slate-700 flex items-center gap-1.5">
                          <PhoneCall className="w-4 h-4 text-teal-600" />
                          
                          {t('settings.stVoiceMinutes')}
                        </span>
                        <span className="text-xs font-mono font-bold text-teal-700">
                          {voiceQuota ? `${voiceQuota.included.used} / ${voiceQuota.included.total}` : '—'}
                        </span>
                      </div>
                      <div className="w-full h-2 rounded-full bg-slate-100 overflow-hidden">
                        <div className="h-full bg-teal-600 rounded-full" style={{ width: `${voiceUsagePercent}%` }} />
                      </div>
                      <p className="text-[11px] text-slate-400">
                        
                        {t('settings.stVoiceMinutesDesc')}
                      </p>
                    </div>

                    <div className="p-4 rounded-2xl border border-slate-200 bg-white space-y-2.5 shadow-2xs">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold text-slate-700 flex items-center gap-1.5">
                          <Sparkles className="w-4 h-4 text-purple-600" />
                          
                          {t('settings.stAiTokens')}
                        </span>
                        <span className="text-xs font-mono font-bold text-purple-700">
                          {creditQuota ? `${creditQuota.included.used} / ${creditQuota.included.total} (${creditUsagePercent}%)` : '—'}
                        </span>
                      </div>
                      <div className="w-full h-2 rounded-full bg-slate-100 overflow-hidden">
                        <div className="h-full bg-purple-600 rounded-full" style={{ width: `${creditUsagePercent}%` }} />
                      </div>
                      <p className="text-[11px] text-slate-400">
                        
                        {t('settings.stAiTokensDesc')}
                      </p>
                    </div>
                  </div>
                </div>

                {/* 套餐列表 */}
                <div className="space-y-3 mb-6">
                  <h4 className="font-bold text-slate-900 text-xs uppercase tracking-wider text-slate-500">
                    
                    {t('settings.stAvailablePlans')}
                  </h4>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    {[
                      {
                        name: t('settings.stPlanStarter'),
                        price: '$89',
                        desc: t('settings.stPlanStarterDesc'),
                        active: false,
                      },
                      {
                        name: t('settings.stPlanGrowth'),
                        price: '$169',
                        desc: t('settings.stPlanGrowthDesc'),
                        active: true,
                      },
                      {
                        name: t('settings.stPlanEnterprise2'),
                        price: '$299',
                        desc: t('settings.stPlanEnterpriseDesc'),
                        active: false,
                      },
                    ].map((plan) => (
                      <div
                        key={plan.name}
                        className={`p-4 rounded-2xl border flex flex-col justify-between space-y-3 ${
                          plan.active
                            ? 'bg-teal-50/60 border-teal-300 shadow-2xs'
                            : 'bg-white border-slate-200'
                        }`}
                      >
                        <div className="space-y-1">
                          <div className="flex items-center justify-between">
                            <span className="font-bold text-xs text-slate-900">{plan.name}</span>
                            {plan.active && (
                              <Badge variant="success" className="text-[10px] font-bold">
                                
                                {t('settings.stPlanActive')}
                              </Badge>
                            )}
                          </div>
                          <div className="text-xl font-black text-slate-900">
                            {plan.price} <span className="text-xs font-normal text-slate-400">{t('settings.stPerMonth')}</span>
                          </div>
                          <p className="text-[11px] text-slate-500 leading-relaxed">{plan.desc}</p>
                        </div>
                        <Button
                          variant={plan.active ? 'secondary' : 'default'}
                          size="sm"
                          disabled={plan.active}
                          onClick={() => setConfirmChangePlan(plan.name)}
                          className={`w-full text-xs font-bold ${
                            plan.active ? 'text-teal-800' : 'bg-slate-900 hover:bg-slate-800 text-white'
                          }`}
                        >
                          {plan.active ? t('settings.stCurrentPlan') : t('settings.stSwitchPlan')}
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>

                {/* 历史账单与发票 */}
                <div className="space-y-3">
                  <h4 className="font-bold text-slate-900 text-xs uppercase tracking-wider text-slate-500">
                    
                    {t('settings.stInvoicesTitle')}
                  </h4>
                  <div className="border border-slate-200 rounded-2xl overflow-hidden text-xs">
                    <div className="bg-slate-50 p-3 font-bold text-slate-600 grid grid-cols-4 border-b border-slate-200">
                      <span>{t('settings.stInvoiceNo')}</span>
                      <span>{t('settings.stBillingPeriod')}</span>
                      <span>Amount</span>
                      <span className="text-right">{t('settings.stDownloadReceipt')}</span>
                    </div>
                    {[
                      { id: 'INV-2026-0801', date: '2026-08-01', amount: '$169.00' },
                      { id: 'INV-2026-0701', date: '2026-07-01', amount: '$169.00' },
                      { id: 'INV-2026-0601', date: '2026-06-01', amount: '$169.00' },
                    ].map((inv) => (
                      <div
                        key={inv.id}
                        className="p-3 grid grid-cols-4 items-center border-b last:border-b-0 border-slate-100 hover:bg-slate-50/50"
                      >
                        <span className="font-mono font-bold text-slate-800">{inv.id}</span>
                        <span className="text-slate-600">{inv.date}</span>
                        <span className="font-mono font-bold text-slate-900">{inv.amount}</span>
                        <div className="text-right">
                          <button
                            type="button"
                            onClick={() => toast.success(t('settings.stInvoiceDownloading', { p0: inv.id }))}
                            className="text-xs font-bold text-teal-600 hover:text-teal-700 hover:underline"
                          >
                            
                            {t('settings.stDownloadPdf')}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </SettingsCard>
            </div>
          )}
        </div>
      </div>

      {/* ============================================================ */}
      {/* 模态弹窗与二次确认对话框 (Modals & ConfirmDialogs) */}
      {/* ============================================================ */}

      {/* 1. 服务项目编辑/新建弹窗 */}
      <Modal
        isOpen={serviceModalOpen}
        onOpenChange={setServiceModalOpen}
        size="md"
        title={editingService ? 'Edit Service Item' : t('settings.stAddServiceModal')}
        footer={
          <div className="flex justify-end gap-2 w-full">
            <Button variant="secondary" onClick={() => setServiceModalOpen(false)} className="text-xs">
              
              {t('settings.stServiceCancel')}
            </Button>
            <Button
              onClick={handleSaveServiceItem}
              disabled={saveServiceMutation.isPending}
              className="bg-teal-600 text-white font-bold text-xs"
            >
              {saveServiceMutation.isPending ? t('settings.stServiceSaving') : t('settings.stSaveService')}
            </Button>
          </div>
        }
      >
        <div className="space-y-4 text-xs">
          <div>
            <label className="block text-[11px] font-bold text-slate-700 uppercase mb-1">
              
              {t('settings.stServiceNameLabel')} <span className="text-red-500">*</span>
            </label>
            <Input
              value={serviceNameZh}
              onChange={(e) => setServiceNameZh(e.target.value)}
              placeholder={t('settings.stServiceNamePlaceholder')}
              className="text-xs"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] font-bold text-slate-700 uppercase mb-1">
                
                {t('settings.stServiceDuration')}
              </label>
              <div className="relative">
                <Input
                  type="number"
                  value={serviceDuration}
                  onChange={(e) => setServiceDuration(e.target.value)}
                  className="pr-10 font-mono text-xs"
                />
                <span className="text-xs text-slate-400 absolute right-2.5 top-1/2 -translate-y-1/2">
                  min
                </span>
              </div>
            </div>
            <div>
              <label className="block text-[11px] font-bold text-slate-700 uppercase mb-1">
                
                {t('settings.stServicePrice')}
              </label>
              <div className="relative">
                <Input
                  value={servicePrice}
                  onChange={(e) => setServicePrice(e.target.value)}
                  className="pl-7 font-mono text-xs"
                />
                <DollarSign className="w-3.5 h-3.5 text-slate-400 absolute left-2 top-1/2 -translate-y-1/2" />
              </div>
            </div>
          </div>

          <div className="space-y-2 pt-2 border-t border-slate-100">
            <div className="space-y-2 rounded-xl border border-slate-200 bg-slate-50 p-3">
              <label className="block text-[11px] font-bold text-slate-700 uppercase">
                {t('settings.stRequiredStaffCount')}
              </label>
              <Input
                type="number"
                min="1"
                max="5"
                value={serviceStaffCount}
                onChange={(event) => setServiceStaffCount(event.target.value)}
                className="w-24 font-mono text-xs"
              />
              <div className="text-[10px] leading-relaxed text-slate-500">{t('settings.stRequiredSkillsHint')}</div>
              <div className="flex flex-wrap gap-1.5">
                {(settings?.skills ?? []).map((skill) => {
                  const checked = serviceRequiredSkillIds.includes(skill.id);
                  return (
                    <button
                      key={skill.id}
                      type="button"
                      onClick={() => setServiceRequiredSkillIds((current) => checked
                        ? current.filter((id) => id !== skill.id)
                        : [...current, skill.id])}
                      className={cn(
                        'rounded-full border px-2.5 py-1 text-[10px] font-bold transition',
                        checked ? 'border-teal-500 bg-teal-50 text-teal-800' : 'border-slate-200 bg-white text-slate-600',
                      )}
                    >
                      {checked ? '✓ ' : ''}{skill.name}
                    </button>
                  );
                })}
                {(settings?.skills ?? []).length === 0 && (
                  <span className="text-[10px] text-amber-700">{t('settings.stNoSkillsConfigured')}</span>
                )}
              </div>
            </div>

            <label className="flex items-center gap-2 cursor-pointer text-slate-700">
              <input
                type="checkbox"
                checked={serviceOnlineBookable}
                onChange={(e) => setServiceOnlineBookable(e.target.checked)}
                className="rounded border-slate-300 text-teal-600 focus:ring-teal-500 w-4 h-4"
              />
              <span>{t('settings.stOnlineBookable')}</span>
            </label>

            <label className="flex items-center gap-2 cursor-pointer text-slate-700">
              <input
                type="checkbox"
                checked={serviceIsAddon}
                onChange={(e) => setServiceIsAddon(e.target.checked)}
                className="rounded border-slate-300 text-teal-600 focus:ring-teal-500 w-4 h-4"
              />
              <span>{t('settings.stMarkAddOn')}</span>
            </label>

            <label className="flex items-center gap-2 cursor-pointer text-slate-700">
              <input
                type="checkbox"
                checked={serviceTaxable}
                onChange={(e) => setServiceTaxable(e.target.checked)}
                className="rounded border-slate-300 text-teal-600 focus:ring-teal-500 w-4 h-4"
              />
              <span>{t('settings.stTaxable')}</span>
            </label>
          </div>
        </div>
      </Modal>

      {/* 2. 员工配置弹窗 */}
      <Modal
        isOpen={staffModalOpen}
        onOpenChange={setStaffModalOpen}
        size="sm"
        title={t('settings.stStaffModalTitle', { p0: editingStaff?.name ?? '' })}
        footer={
          <div className="flex justify-end gap-2 w-full">
            <Button variant="secondary" onClick={() => setStaffModalOpen(false)} className="text-xs">
              
              {t('settings.stStaffCancel')}
            </Button>
            <Button
              onClick={handleSaveStaffProfile}
              disabled={saveStaffMutation.isPending}
              className="bg-teal-600 text-white font-bold text-xs"
            >
              {saveStaffMutation.isPending ? t('settings.stStaffSaving') : t('settings.stSaveStaff')}
            </Button>
          </div>
        }
      >
        <div className="space-y-4 text-xs">
          <div>
            <label className="block text-[11px] font-bold text-slate-700 uppercase mb-1">
              
              {t('settings.stDisplayName')}
            </label>
            <Input
              value={staffDisplayName}
              onChange={(e) => setStaffDisplayName(e.target.value)}
              className="text-xs"
            />
          </div>

          <div>
            <label className="block text-[11px] font-bold text-slate-700 uppercase mb-1">
              
              {t('settings.stMaxConcurrent')}
            </label>
            <Input
              type="number"
              min={1}
              max={5}
              value={staffMaxConcurrent}
              onChange={(e) => setStaffMaxConcurrent(e.target.value)}
              className="text-xs font-mono"
            />
            <p className="text-[10px] text-slate-400 mt-1">
              
              {t('settings.stMaxConcurrentDesc')}
            </p>
          </div>

          <label className="flex items-center gap-2 cursor-pointer text-slate-700 pt-2 border-t border-slate-100">
            <input
              type="checkbox"
              checked={staffBookable}
              onChange={(e) => setStaffBookable(e.target.checked)}
              className="rounded border-slate-300 text-teal-600 focus:ring-teal-500 w-4 h-4"
            />
            <span>{t('settings.stPubliclyBookable')}</span>
          </label>
        </div>
      </Modal>

      {/* 3. 下架服务确认 */}
      <ConfirmDialog
        isOpen={archivingService !== null}
        onOpenChange={(open) => {
          if (!open) setArchivingService(null);
        }}
        tone="danger"
        title={t('settings.stArchiveServiceTitle', { p0: archivingService?.displayName ?? '' })}
        description={t('settings.stArchiveServiceBody')}
        confirmLabel={t('settings.stArchiveServiceAction')}
        onConfirm={handleArchiveServiceItem}
      />

      {/* 4. 保存门店信息确认 */}
      <ConfirmDialog
        isOpen={confirmSaveStoreOpen}
        onOpenChange={setConfirmSaveStoreOpen}
        title={t('settings.stSaveStoreConfirmTitle')}
        description={t('settings.stSaveStoreConfirmBody')}
        confirmLabel={t('settings.stSaveStoreConfirmAction')}
        onConfirm={async () => {
          await handleSaveStoreProfile();
          setConfirmSaveStoreOpen(false);
        }}
      />

      {/* 5. 保存营业时间确认 */}
      <ConfirmDialog
        isOpen={confirmSaveHoursOpen}
        onOpenChange={setConfirmSaveHoursOpen}
        title={t('settings.stSaveHoursConfirmTitle')}
        description={t('settings.stSaveHoursConfirmBody')}
        confirmLabel={t('settings.stSaveHoursConfirmAction')}
        onConfirm={async () => {
          await handleSaveHours();
          setConfirmSaveHoursOpen(false);
        }}
      />

      {/* 6. 保存收银规则确认 */}
      <ConfirmDialog
        isOpen={confirmSaveCheckoutOpen}
        onOpenChange={setConfirmSaveCheckoutOpen}
        title={t('settings.stSaveCheckoutConfirmTitle')}
        description={t('settings.stSaveCheckoutConfirmBody')}
        confirmLabel={t('settings.stSaveCheckoutConfirmAction')}
        onConfirm={async () => {
          await handleSaveCheckoutRules();
          setConfirmSaveCheckoutOpen(false);
        }}
      />

      {/* 7. 保存在线预约规则确认 */}
      <ConfirmDialog
        isOpen={confirmSaveBookingOpen}
        onOpenChange={setConfirmSaveBookingOpen}
        title={t('settings.stSaveBookingConfirmTitle')}
        description={t('settings.stSaveBookingConfirmBody', { p0: maxDaysAhead, p1: minMinutesAhead, p2: cancelCutoffHours })}
        confirmLabel={t('settings.stSaveBookingConfirmAction')}
        onConfirm={async () => {
          await handleSaveBookingRules();
          setConfirmSaveBookingOpen(false);
        }}
      />

      {/* 8. 提交 10DLC 代办确认 */}
      <ConfirmDialog
        isOpen={confirmTenDlcOpen}
        onOpenChange={setConfirmTenDlcOpen}
        title={t('settings.stSubmit10dlcConfirmTitle')}
        description={t('settings.stSubmit10dlcConfirmBody', { p0: legalName, p1: ein })}
        confirmLabel={t('settings.stSubmit10dlcConfirmAction')}
        onConfirm={async () => {
          await handleSaveTenDlc();
          setConfirmTenDlcOpen(false);
        }}
      />

      {/* 9. 保存 AI 电话设置确认 */}
      <ConfirmDialog
        isOpen={confirmSavePhoneOpen}
        onOpenChange={setConfirmSavePhoneOpen}
        title={t('settings.stSaveAiConfirmTitle')}
        description={t('settings.stSaveAiConfirmBody')}
        confirmLabel={t('settings.stSaveAiConfirmAction')}
        onConfirm={async () => {
          await handleSavePhoneAssistant();
          setConfirmSavePhoneOpen(false);
        }}
      />

      {/* 11. 切换套餐确认 */}
      <ConfirmDialog
        isOpen={confirmChangePlan !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmChangePlan(null);
        }}
        title={t('settings.stChangePlanConfirmTitle', { p0: confirmChangePlan ?? '' })}
        description={t('settings.stChangePlanConfirmBody')}
        confirmLabel={t('settings.stChangePlanConfirmAction')}
        onConfirm={async () => {
          if (!confirmChangePlan) return;
          const targetPlan: 'starter' | 'growth' | 'enterprise' = confirmChangePlan.includes('Starter')
            ? 'starter'
            : confirmChangePlan.includes('Growth')
            ? 'growth'
            : 'enterprise';
          try {
            await changePlanMutation.mutateAsync({ targetPlan, billingCycle: 'monthly' });
            toast.success(t('settings.stPlanChanged', { p0: confirmChangePlan ?? '' }));
            setConfirmChangePlan(null);
          } catch (err: any) {
            toast.danger(errorMessage(err));
            setConfirmChangePlan(null);
          }
        }}
      />

      {/* 12. 参与Walk-in Guest轮牌状态切换二次确认弹窗 */}
      <ConfirmDialog
        isOpen={confirmRotationTarget !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmRotationTarget(null);
        }}
        title={
          confirmRotationTarget?.nextInRotation
            ? t('settings.stJoinRotationConfirm', { p0: confirmRotationTarget?.staff.name ?? '' })
            : t('settings.stLeaveRotationConfirm', { p0: confirmRotationTarget?.staff.name ?? '' })
        }
        description={
          confirmRotationTarget?.nextInRotation
            ? t('settings.stJoinRotationBody')
            : t('settings.stLeaveRotationBody')
        }
        confirmLabel={confirmRotationTarget?.nextInRotation ? t('settings.stJoinRotationAction') : t('settings.stLeaveRotationAction')}
        onConfirm={async () => {
          if (!confirmRotationTarget) return;
          try {
            await setRotationMutation.mutateAsync({
              membershipId: confirmRotationTarget.staff.membershipId,
              inRotation: confirmRotationTarget.nextInRotation,
            });
            toast.success(t('settings.stRotationUpdated', { p0: confirmRotationTarget.staff.name }));
            await refetch();
            setConfirmRotationTarget(null);
          } catch (err: any) {
            toast.danger(errorMessage(err));
            setConfirmRotationTarget(null);
          }
        }}
      />
    </div>
  );
}
