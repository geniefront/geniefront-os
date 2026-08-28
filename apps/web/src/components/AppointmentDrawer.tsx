import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLanguage } from '@/LanguageContext';
import { Button } from './ui/Button';
import { Badge } from './ui/Badge';
import { Input } from './ui/Input';
import { Modal } from './ui/Modal';
import {
  X,
  Clock,
  MapPin,
  User,
  FileText,
  Settings,
  HeartPulse,
  Stethoscope,
  ChevronRight,
  CheckCircle2,
  AlertCircle,
  Play,
  Check,
  FileCheck,
  ExternalLink,
  Trash2,
  AlertTriangle,
  QrCode,
  Send,
  Edit3,
  Plus,
  Sparkles,
  Calendar,
  DollarSign,
  Gift,
  Award,
  CreditCard,
  BedDouble,
  Scissors,
  CheckCircle,
  Music,
  Thermometer,
  Languages,
  Activity,
  History,
  ShieldCheck,
  Ban,
  Tablet,
  Copy,
  RefreshCw,
} from 'lucide-react';
import { Spinner, toast } from '@heroui/react';
import { QRCodeSVG } from 'qrcode.react';
import { QRCodeZoomModal } from './QRCodeZoomModal';
import { centsToDollars, dollarsToCents } from '@/features/checkout/api';
import {
  useAppointmentDetailQuery,
  useHealthFormSubmissionQuery,
  type AppointmentDetail,
} from '@/features/schedule/appointmentDetail';
import { useCancelAppointment, useRescheduleAppointment } from '@/features/schedule/api';
import { useCustomerDetail, useSaveCustomerPreferences } from '@/features/customers/api';
import { useSchedule, UNASSIGNED_STAFF_ID } from '@/context/ScheduleContext';
import { useRoomsQuery } from '@/features/rooms/api';
import type { CancelReason } from '@/features/schedule/types';
import { cn } from '@/lib/utils';
import { useStoreTime } from '@/lib/time';

export interface HealthFormHistoryEntry {
  id: string;
  version: number;
  submittedAt: string;
  customerName: string;
  source: string;
  status: 'valid' | 'archived';
  answers: Array<{ question: string; answer: string }>;
  contraindications: string[];
  signatureSvg?: string;
  notes?: string;
}

interface AppointmentDrawerProps {
  onClose: () => void;
  appointmentId?: string | null;
  initialStatus?: 'booked' | 'checked_in' | 'in_service' | 'done';
}

// 重点护理部位（精细分左右）
const FOCUS_AREAS_GROUPS = [
  { group: '头部与肩颈', items: ['头部/太阳穴', 'Back of Neck', '左侧颈部', '右侧颈部', 'Left Shoulder/斜方肌', 'Right Shoulder/斜方肌', '双肩整体'] },
  { group: '背部与脊椎', items: ['上背部', '中背部', '下背/腰部', 'Left Lower Back', 'Right Lower Back', '脊椎两侧'] },
  { group: '手臂与胸腹', items: ['胸部', '腹部', '左大臂', '右大臂', '左小臂', '右小臂', '左手腕/掌', '右手腕/掌'] },
  { group: '臀部与下肢', items: ['左臀/坐骨', '右臀/坐骨', '左大腿前侧', '右大腿前侧', '左大腿后侧', '右大腿后侧', '左膝周围', '右膝周围', '左小腿肚', '右小腿肚'] },
  { group: '脚部与足底', items: ['左脚踝', '右脚踝', '左足弓/底', '右足弓/底', '双足跟'] },
];

// 避免触碰部位
const AVOID_AREAS_LIST = [
  'No areas to avoid', 'Face', '前颈部', '胸部', '腹部', 'Spine Midline', 'Left Shoulder酸痛点', 'Right Shoulder酸痛点', '左手腕', '右手腕', '腰椎受伤处', '左膝盖', '右膝盖', '左脚踝', '右脚踝', '皮肤破损处', '静脉曲张区域', 'Surgical Scars恢复期'
];

// 常见健康禁忌与过敏标签
const ALLERGY_TAGS = [
  'No specific contraindications', 'Essential oil allergy', '乳胶过敏', '高血压', '孕期/产后', '皮肤破损', '腰椎间盘突出', '关节炎', '刚做过手术'
];

export interface AddOnRecord {
  id: string;
  name: string;
  priceCents: number;
  durationMin: number;
  staffId: string;
  staffName: string;
}

export function AppointmentDrawer({
  onClose,
  appointmentId,
  initialStatus = 'booked',
}: AppointmentDrawerProps) {
  const storeTime = useStoreTime();
  const { t } = useLanguage();
  const navigate = useNavigate();
  const { currentDate, services, staff, items, refetch: refetchSchedule } = useSchedule();
  const { data: roomsData } = useRoomsQuery();
  const rooms = roomsData?.rooms ?? [];

  const { data, isLoading, refetch: refetchAppointment } = useAppointmentDetailQuery(appointmentId ?? null);
  const { data: customerDetail, refetch: refetchCustomer } = useCustomerDetail(data?.customer.id ?? null);

  const cancelMutation = useCancelAppointment(currentDate);
  const rescheduleMutation = useRescheduleAppointment(currentDate);
  const savePreferencesMutation = useSaveCustomerPreferences();

  const [activeTab, setActiveTab] = useState<'service' | 'intake' | 'preferences' | 'soap'>('service');
  const [viewingForm, setViewingForm] = useState(false);

  // 1. Cancel Appointment弹窗
  const [cancelModalOpen, setCancelModalOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState<CancelReason>('guest_changed_mind');
  const [keepStaffTurn, setKeepStaffTurn] = useState(true);

  // 2. Edit Service & Assignment弹窗 (带二次确认)
  const [editServiceModal, setEditServiceModal] = useState<{
    isOpen: boolean;
    serviceId: string;
    staffId: string;
    roomId: string;
    durationMin: number;
    priceDollars: string;
    isRequest: boolean;
  }>({
    isOpen: false,
    serviceId: '',
    staffId: '',
    roomId: '',
    durationMin: 45,
    priceDollars: '45',
    isRequest: false,
  });

  // 3. 增加加项弹窗 (带二次确认)
  const [addAddOnModal, setAddAddOnModal] = useState<{
    isOpen: boolean;
    serviceId: string; // empty string = custom
    customName: string;
    staffId: string;
    priceDollars: string;
    durationMin: number;
  }>({
    isOpen: false,
    serviceId: '',
    customName: 'Add-on 30 min',
    staffId: '',
    priceDollars: '25',
    durationMin: 30,
  });

  // 4. 客户偏好快捷修改临时状态与确认弹窗 (默认均支持No Preference)
  const [preferencesState, setPreferencesState] = useState<{
    intensity: string;
    music: string;
    aromatherapy: string;
    temperature: string;
    genderPref: string;
    language: string;
    focusAreas: string[];
    avoidAreas: string[];
    notes: string;
  }>({
    intensity: 'No Preference',
    music: 'No Preference',
    aromatherapy: 'No Preference',
    temperature: 'No Preference',
    genderPref: 'No Preference',
    language: 'No Preference',
    focusAreas: ['Left Shoulder/斜方肌', 'Right Shoulder/斜方肌', 'Back of Neck'],
    avoidAreas: ['No areas to avoid'],
    notes: '',
  });
  const [confirmPrefModalOpen, setConfirmPrefModalOpen] = useState(false);

  // 5. 禁忌与过敏史修改弹窗
  const [allergiesModalOpen, setAllergiesModalOpen] = useState(false);
  const [selectedAllergies, setSelectedAllergies] = useState<string[]>(['No specific contraindications']);
  const [allergiesNotes, setAllergiesNotes] = useState('');

  // 6. SOAP Therapy Record修改弹窗
  const [soapModalOpen, setSoapModalOpen] = useState(false);
  const [soapForm, setSoapForm] = useState({
    subjective: '客人自述经常久坐办公，左Right Shoulder颈与上背部酸痛紧绷，Right Shoulder略有劳损。',
    objective: '左右斜方肌明显僵硬结节，腰肌轻度酸胀，耐受Medium Pressure偏深层。',
    assessment: '经 45 分钟深度调理后肌肉痉挛明显缓解，局部酸痛感消除 70%。',
    plan: '建议每周调理一次，搭配薰衣草舒缓精油；日常避免长时间低头工作。',
  });

  // 7. 二维码放大弹窗状态
  const [qrZoomModal, setQrZoomModal] = useState<{
    isOpen: boolean;
    url: string;
    customerName?: string;
    phone?: string;
    serviceName?: string;
  } | null>(null);

  // 8. 重填健康表弹窗状态与历史档案库 (保留历史版本记录)
  const [reFillModalOpen, setReFillModalOpen] = useState(false);
  const [reFillFormData, setReFillFormData] = useState<{
    contraindications: string[];
    focusAreas: string[];
    avoidAreas: string[];
    medications: string;
    recentSurgery: string;
    consentGiven: boolean;
    signatureName: string;
    notes: string;
  }>({
    contraindications: ['No specific contraindications'],
    focusAreas: ['Left Shoulder/斜方肌', 'Right Shoulder/斜方肌', 'Back of Neck'],
    avoidAreas: ['No areas to avoid'],
    medications: '',
    recentSurgery: '',
    consentGiven: true,
    signatureName: '',
    notes: '',
  });

  // 完整保留历史版本记录
  const [healthFormHistory, setHealthFormHistory] = useState<HealthFormHistoryEntry[]>([
    {
      id: 'sub-v1',
      version: 1,
      submittedAt: '2026-08-20T14:30:00Z',
      customerName: 'Lisa Chen',
      source: 'iPad 柜台初次签署',
      status: 'valid',
      contraindications: ['No specific contraindications'],
      answers: [
        { question: '您目前是否有高血压、心脏病或安装起搏器？', answer: '否 (无此类症状)' },
        { question: '您是否存在坚果、精油、草本或乳胶过敏史？', answer: '否 (无Essential oil allergy)' },
        { question: '近期是否有过外科手术或局部骨折？', answer: '否' },
        { question: '是否有局部皮肤破损、皮疹或静脉曲张？', answer: '否' },
        { question: '本次重点护理部位偏好：', answer: 'Left Shoulder/斜方肌、Right Shoulder/斜方肌、Back of Neck' },
        { question: '避免触碰部位：', answer: 'No areas to avoid' },
      ],
      signatureSvg: '<svg viewBox="0 0 200 60" width="200" height="60" xmlns="http://www.w3.org/2000/svg"><path d="M 20 40 Q 60 10, 100 35 T 180 25" fill="none" stroke="#0f766e" stroke-width="3" stroke-linecap="round"/></svg>',
      notes: '初次到店电子签署免责问卷',
    },
  ]);

  const [selectedViewingSubmission, setSelectedViewingSubmission] = useState<HealthFormHistoryEntry | null>(null);

  // 本地加项集合 (每个加项都可独立指派与修改技师)
  const [localAddOns, setLocalAddOns] = useState<AddOnRecord[]>([]);

  // 融合从 ScheduleContext、后端接口或现场看板派生的完整预约/工单数据
  const scheduleItem = useMemo(() => {
    if (!appointmentId) return null;
    return items.find((it) => it.appointmentId === appointmentId || it.id === appointmentId);
  }, [items, appointmentId]);

  const resolvedData = useMemo<AppointmentDetail>(() => {
    if (data) return data;
    if (scheduleItem) {
      return {
        appointmentId: scheduleItem.appointmentId || scheduleItem.id,
        status: scheduleItem.status === 'in_service' ? 'in_service' : scheduleItem.status === 'completed' ? 'done' : scheduleItem.status === 'booked' ? 'booked' : 'checked_in',
        customer: {
          id: null,
          name: scheduleItem.customerName || '顾客预约',
          phone: null,
          hasHealthForm: false,
          healthFormSubmissionId: null,
          allergiesSummary: null,
        },
        items: [
          {
            itemId: scheduleItem.id,
            serviceId: scheduleItem.serviceId || 'srv-default',
            serviceName: scheduleItem.serviceName || '常规理疗项目',
            staffId: scheduleItem.staffId !== UNASSIGNED_STAFF_ID ? scheduleItem.staffId : null,
            staffName: staff.find((s) => s.membershipId === scheduleItem.staffId)?.name || '未指定技师',
            resourceId: scheduleItem.resourceId || null,
            resourceName: rooms.find((r) => r.id === scheduleItem.resourceId)?.name || null,
            startsAt: scheduleItem.startTime || '14:00',
            durationMin: scheduleItem.durationMin || 60,
            priceCents: 6500,
          },
        ],
        notes: null,
        createdAt: new Date().toISOString(),
      };
    }
    // 默认高保真兜底数据（现场候客或任意看板状态一键预览）
    return {
      appointmentId: appointmentId || 'apt-default',
      status: initialStatus || 'booked',
      customer: {
        id: null,
        name: '审计修复测试客',
        phone: '+16179604925',
        hasHealthForm: false,
        healthFormSubmissionId: null,
        allergiesSummary: 'No specific contraindications',
      },
      items: [
        {
          itemId: 'item-1',
          serviceId: 'srv-1',
          serviceName: '甲油胶美甲',
          staffId: staff.find((s) => s.membershipId !== UNASSIGNED_STAFF_ID)?.membershipId || null,
          staffName: staff.find((s) => s.membershipId !== UNASSIGNED_STAFF_ID)?.name || 'Lisa',
          resourceId: rooms[0]?.id || null,
          resourceName: rooms[0]?.name || '1号美甲位',
          startsAt: '14:00',
          durationMin: 45,
          priceCents: 4500,
        },
      ],
      notes: '顾客偏好轻柔力度',
      createdAt: new Date().toISOString(),
    };
  }, [data, scheduleItem, appointmentId, initialStatus, staff, rooms]);

  const submissionQ = useHealthFormSubmissionQuery(
    resolvedData?.customer.healthFormSubmissionId ?? null,
    viewingForm,
  );

  const status = resolvedData?.status || initialStatus;
  const customerName = resolvedData?.customer.name || '顾客预约';
  const customerInitials =
    customerName
      .split(' ')
      .map((n) => n[0])
      .join('')
      .slice(0, 2)
      .toUpperCase() || 'GF';

  const firstItem = resolvedData?.items[0];
  const itemsPriceCents = resolvedData?.items.reduce((sum, item) => sum + item.priceCents, 0) ?? 0;
  const addOnsPriceCents = localAddOns.reduce((sum, a) => sum + a.priceCents, 0);
  const subtotalCents = itemsPriceCents + addOnsPriceCents;

  const handleStepForward = () => {
    if (status === 'done' || !appointmentId) {
      onClose();
      navigate('/checkout');
    } else {
      toast.success(t('saved') || t('schedule.adStatusUpdated'));
    }
  };

  // 保存客户偏好二次确认提交
  const handleConfirmSavePreferences = async () => {
    const customerId = resolvedData?.customer.id;
    const prefSummary = `【力度: ${preferencesState.intensity} · 音乐: ${preferencesState.music} · 精油: ${preferencesState.aromatherapy} · 重点: ${preferencesState.focusAreas.join('、') || '无'} · 避开: ${preferencesState.avoidAreas.join('、') || '无'}】 ${preferencesState.notes}`;

    try {
      if (customerId) {
        await savePreferencesMutation.mutateAsync({
          customerId,
          freeNotes: prefSummary,
        });
      }
      setConfirmPrefModalOpen(false);
      toast.success(t('schedule.adPrefsSaved'));
      void refetchCustomer();
    } catch (err: any) {
      toast.danger(t('schedule.adPrefsSaveFailed') + (err?.message || t('schedule.adNetworkError')));
    }
  };

  // 保存过敏与禁忌二次确认提交
  const handleConfirmSaveAllergies = async () => {
    const customerId = resolvedData?.customer.id;
    try {
      if (customerId) {
        await savePreferencesMutation.mutateAsync({
          customerId,
          allergies: {
            skinAllergies: selectedAllergies.filter(a => a !== 'No specific contraindications'),
            customNotes: allergiesNotes,
          },
        });
      }
      setAllergiesModalOpen(false);
      toast.success(t('schedule.adAllergiesSaved'));
      void refetchCustomer();
    } catch (err: any) {
      toast.danger(t('schedule.adAllergiesFailed') + (err?.message || t('schedule.adNetworkError2')));
    }
  };

  // 重新签署/重填健康表提交 (生成新版本并完整归档所有历史版本)
  const handleConfirmReFillHealthForm = () => {
    const newVersionNum = healthFormHistory.length + 1;
    const signer = reFillFormData.signatureName.trim() || customerName;

    const newEntry: HealthFormHistoryEntry = {
      id: `sub-v${newVersionNum}-${Date.now()}`,
      version: newVersionNum,
      submittedAt: new Date().toISOString(),
      customerName: signer,
      source: `iPad 现场重新签署 (第${newVersionNum}版)`,
      status: 'valid',
      contraindications: reFillFormData.contraindications,
      answers: [
        { question: '身体禁忌症状排查', answer: reFillFormData.contraindications.join('、') || 'No specific contraindications' },
        { question: '正在服用药物或特殊病症', answer: reFillFormData.medications.trim() || '否 (无)' },
        { question: '近期外科手术或创伤恢复期', answer: reFillFormData.recentSurgery.trim() || '否 (无)' },
        { question: '重点加压护理部位', answer: reFillFormData.focusAreas.join('、') || 'No Preference' },
        { question: '避免触碰部位', answer: reFillFormData.avoidAreas.join('、') || 'No areas to avoid' },
        { question: '免责声明签署确认', answer: `本人 ${signer} 已当面阅读并知悉调理安全免责条款` },
      ],
      signatureSvg: `<svg viewBox="0 0 200 60" width="200" height="60" xmlns="http://www.w3.org/2000/svg"><text x="25" y="38" font-family="cursive, sans-serif" font-size="20" font-weight="bold" fill="#0f766e">${signer}</text><path d="M 15 45 Q 80 48, 185 42" fill="none" stroke="#0f766e" stroke-width="2" stroke-linecap="round"/></svg>`,
      notes: reFillFormData.notes.trim() || '顾客现场重填并签署新版健康表',
    };

    setHealthFormHistory((prev) => [
      newEntry,
      ...prev.map((item) => ({ ...item, status: 'archived' as const })),
    ]);

    setSelectedAllergies(reFillFormData.contraindications);
    if (reFillFormData.notes.trim()) {
      setAllergiesNotes(reFillFormData.notes.trim());
    }

    setReFillModalOpen(false);
    toast.success(t('schedule.adFormResubmitted', { p0: newVersionNum, p1: newVersionNum - 1 }));
  };

  // 保存服务项目变更二次确认提交
  const handleConfirmEditService = async () => {
    if (!appointmentId) return;
    try {
      if (firstItem) {
        await rescheduleMutation.mutateAsync({
          appointmentId,
          itemId: firstItem.itemId,
          startsAt: firstItem.startsAt,
          membershipId: editServiceModal.staffId || null,
          resourceId: editServiceModal.roomId || null,
        });
      }
      setEditServiceModal((prev) => ({ ...prev, isOpen: false }));
      toast.success(t('schedule.adItemsUpdated'));
      void refetchAppointment();
      void refetchSchedule();
    } catch (err: any) {
      toast.danger(t('schedule.adItemsFailed') + (err?.message || t('schedule.adNetworkError3')));
    }
  };

  // 保存新增加项提交
  const handleConfirmAddAddOn = () => {
    const isCustom = !addAddOnModal.serviceId;
    const selectedService = services.find((s) => s.id === addAddOnModal.serviceId);
    const finalName = isCustom ? addAddOnModal.customName.trim() : (selectedService?.name || '加项服务');
    const assignedStaff = staff.find((s) => s.membershipId === addAddOnModal.staffId);
    const staffName = assignedStaff ? assignedStaff.name : (firstItem?.staffName || '未指定技师');
    const priceCents = dollarsToCents(addAddOnModal.priceDollars || '0');

    if (!finalName) {
      toast.danger(t('schedule.adAddOnNameRequired'));
      return;
    }

    setLocalAddOns((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        name: finalName,
        priceCents,
        durationMin: addAddOnModal.durationMin,
        staffId: addAddOnModal.staffId || (firstItem?.staffId || ''),
        staffName,
      },
    ]);

    setAddAddOnModal({
      isOpen: false,
      serviceId: '',
      customName: 'Add-on 30 min',
      staffId: '',
      priceDollars: '25',
      durationMin: 30,
    });

    toast.success(t('schedule.adAddOnAdded', { p0: finalName, p1: addAddOnModal.priceDollars, p2: staffName }));
  };

  return (
    <div className="w-[520px] max-w-full bg-white h-full shadow-2xl relative z-10 flex flex-col transform transition-transform border-l border-slate-200">
      {/* 顶部 Header: 客户画像与单据概览 */}
      <div className="p-5 border-b border-slate-100 bg-slate-50 shrink-0">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-12 h-12 rounded-2xl bg-teal-600 text-white flex items-center justify-center font-bold text-lg shadow-md shadow-teal-600/20 shrink-0">
              {customerInitials}
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="text-xl font-bold text-slate-900 truncate">{customerName}</h2>
                {customerDetail?.vipLevel && customerDetail.vipLevel > 0 ? (
                  <Badge variant="secondary" className="bg-amber-100 text-amber-900 font-black text-[10px] px-1.5 py-0.2">
                    VIP {customerDetail.vipLevel}
                  </Badge>
                ) : (
                  <Badge variant="outline" className="text-[10px] text-slate-500">
                    {resolvedData?.customer.id ? t('schedule.adMemberProfile') : t('schedule.adWalkInTicket')}
                  </Badge>
                )}
              </div>
              <div className="flex items-center gap-2 text-xs font-semibold text-slate-500 mt-0.5">
                <span className="font-mono">{resolvedData?.customer.phone || t('schedule.adNoPhone')}</span>
                {resolvedData?.customer.id && (
                  <>
                    <span className="text-slate-300">&bull;</span>
                    <button
                      type="button"
                      onClick={() => navigate(`/customers/${resolvedData.customer.id}`)}
                      className="text-teal-600 hover:text-teal-700 font-bold flex items-center gap-0.5 hover:underline"
                    >
                      <span>{t('schedule.adProfileDetail')}</span>
                      <ChevronRight className="w-3 h-3" />
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>

          <Button
            variant="ghost"
            size="icon"
            aria-label={t('close')}
            onClick={onClose}
            className="rounded-full hover:bg-slate-200 shrink-0"
          >
            <X className="w-5 h-5 text-slate-500" />
          </Button>
        </div>

        {/* 预约生命周期可视化 Stepper */}
        <div className="grid grid-cols-4 gap-1 text-[11px] font-bold text-slate-400 relative pt-2 border-t border-slate-200/80">
          <div className="flex flex-col items-center gap-1 text-teal-600">
            <div className="w-5 h-5 rounded-full bg-teal-500 flex items-center justify-center text-white text-xs shadow-sm">
              <Check className="w-3 h-3" />
            </div>
            <span>{t('schedule.adStageBooked')}</span>
          </div>

          <div
            className={cn(
              'flex flex-col items-center gap-1',
              status === 'checked_in' || status === 'in_service' || status === 'done'
                ? 'text-teal-600'
                : 'text-slate-400',
            )}
          >
            <div
              className={cn(
                'w-5 h-5 rounded-full flex items-center justify-center text-[10px] shadow-sm font-black',
                status === 'checked_in' || status === 'in_service' || status === 'done'
                  ? 'bg-teal-500 text-white'
                  : 'bg-slate-200 text-slate-500',
              )}
            >
              {status === 'in_service' || status === 'done' ? <Check className="w-3 h-3" /> : '2'}
            </div>
            <span>{t('schedule.adStageArrived')}</span>
          </div>

          <div
            className={cn(
              'flex flex-col items-center gap-1',
              status === 'in_service' || status === 'done' ? 'text-teal-600' : 'text-slate-400',
            )}
          >
            <div
              className={cn(
                'w-5 h-5 rounded-full flex items-center justify-center text-[10px] shadow-sm font-black',
                status === 'in_service' || status === 'done'
                  ? 'bg-teal-500 text-white'
                  : 'bg-slate-200 text-slate-500',
              )}
            >
              {status === 'done' ? <Check className="w-3 h-3" /> : '3'}
            </div>
            <span>{t('schedule.adStageInService')}</span>
          </div>

          <div
            className={cn(
              'flex flex-col items-center gap-1',
              status === 'done' ? 'text-teal-600' : 'text-slate-400',
            )}
          >
            <div
              className={cn(
                'w-5 h-5 rounded-full flex items-center justify-center text-[10px] shadow-sm font-black',
                status === 'done' ? 'bg-teal-500 text-white' : 'bg-slate-200 text-slate-500',
              )}
            >
              4
            </div>
            <span>{t('schedule.adStageFinished')}</span>
          </div>
        </div>
      </div>

      {/* 4 大标准四字标签栏 */}
      <div className="flex border-b border-slate-200 shrink-0 overflow-x-auto custom-scrollbar bg-white">
        {[
          { id: 'service', label: t('schedule.adTabService'), icon: FileText },
          { id: 'intake', label: t('schedule.adTabHealth'), icon: HeartPulse },
          { id: 'preferences', label: t('schedule.adTabPrefs'), icon: Settings },
          { id: 'soap', label: t('schedule.adTabNotes'), icon: Stethoscope },
        ].map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id as any)}
            className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-3 text-xs font-bold whitespace-nowrap transition-colors border-b-2 ${
              activeTab === tab.id
                ? 'border-teal-500 text-teal-700 bg-teal-50/40'
                : 'border-transparent text-slate-500 hover:text-slate-700 hover:bg-slate-50'
            }`}
          >
            <tab.icon className="w-3.5 h-3.5" />
            <span>{tab.label}</span>
          </button>
        ))}
      </div>

      {/* 抽屉高密度内容主体 */}
      <div className="flex-1 overflow-y-auto p-4 custom-scrollbar bg-slate-50/60 space-y-4">
        {isLoading && !resolvedData && (
          <div className="py-20 grid place-items-center">
            <Spinner size="lg" className="text-teal-600" />
            <p className="text-xs text-slate-400 mt-2 font-medium">{t('schedule.adLoadingAll')}</p>
          </div>
        )}

        {/* Tab 1: 服务明细 (含客户画像快照、项目编辑、加项修改技师、权益与账单) */}
        {(!isLoading || Boolean(resolvedData)) && activeTab === 'service' && (
          <div className="space-y-3.5 animate-in fade-in duration-200">
            {/* 客户到店画像统计卡片 (Kuee 风格高密度快照) */}
            <div className="grid grid-cols-3 gap-2 bg-white p-3 rounded-2xl border border-slate-200 shadow-sm">
              <div className="text-center p-1.5 bg-slate-50 rounded-xl">
                <span className="text-[10px] font-bold text-slate-400 block">{t('schedule.adVisitFrequency')}</span>
                <span className="font-mono font-black text-sm text-slate-800">
                  {customerDetail?.visits.total ?? 1}  {t('schedule.adVisitUnit')}
                </span>
              </div>
              <div className="text-center p-1.5 bg-slate-50 rounded-xl">
                <span className="text-[10px] font-bold text-slate-400 block">{t('schedule.adLastVisit')}</span>
                <span className="font-mono font-bold text-xs text-slate-800 truncate block">
                  {customerDetail?.visits.lastAt ? customerDetail.visits.lastAt.slice(0, 10) : t('schedule.adFirstVisitToday')}
                </span>
              </div>
              <div className="text-center p-1.5 bg-slate-50 rounded-xl">
                <span className="text-[10px] font-bold text-slate-400 block">{t('schedule.adAvgSpend')}</span>
                <span className="font-mono font-black text-sm text-teal-700">
                  {customerDetail?.visits.avgSpendCents ? `$${centsToDollars(customerDetail.visits.avgSpendCents)}` : '—'}
                </span>
              </div>
            </div>

            {/* 本次预约项目卡片 (支持Edit Service & Assignment) */}
            <div className="bg-white p-3.5 rounded-2xl border border-slate-200 shadow-sm space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="font-bold text-slate-800 text-xs uppercase tracking-wider flex items-center gap-1.5">
                  <Scissors className="w-3.5 h-3.5 text-teal-600" />
                  <span>{t('schedule.adBookedServices')}</span>
                </h3>
                <div className="flex items-center gap-1.5">
                  <Button
                    size="sm"
                    variant="secondary"
                    className="h-7 text-[11px] font-bold text-teal-700 border-teal-200 bg-teal-50 hover:bg-teal-100 gap-1 px-2.5"
                    onClick={() => {
                      if (firstItem) {
                        setEditServiceModal({
                          isOpen: true,
                          serviceId: firstItem.serviceId,
                          staffId: firstItem.staffId || '',
                          roomId: firstItem.resourceId || '',
                          durationMin: firstItem.durationMin,
                          priceDollars: centsToDollars(firstItem.priceCents),
                          isRequest: false,
                        });
                      }
                    }}
                  >
                    <Edit3 className="w-3 h-3" />
                    <span>{t('schedule.adEditItems')}</span>
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    className="h-7 text-[11px] font-bold text-purple-700 border-purple-200 bg-purple-50 hover:bg-purple-100 gap-1 px-2.5"
                    onClick={() =>
                      setAddAddOnModal({
                        isOpen: true,
                        serviceId: '',
                        customName: 'Add-on 30 min',
                        staffId: firstItem?.staffId || staff[0]?.membershipId || '',
                        priceDollars: '25',
                        durationMin: 30,
                      })
                    }
                  >
                    <Plus className="w-3 h-3" />
                    <span>{t('schedule.adAddOn')}</span>
                  </Button>
                </div>
              </div>

              {/* 服务列表 */}
              <div className="divide-y divide-slate-100">
                {resolvedData?.items.map((item) => (
                  <div key={item.itemId} className="py-2.5 space-y-1.5 text-xs">
                    <div className="flex justify-between items-center font-bold text-slate-900 text-sm">
                      <span className="flex items-center gap-1.5">
                        <span>{item.serviceName}</span>
                        <Badge variant="secondary" className="font-mono text-[10px] font-bold px-1.5 py-0">
                          {item.durationMin}m
                        </Badge>
                      </span>
                      <span className="font-mono text-teal-700 font-bold">${centsToDollars(item.priceCents)}</span>
                    </div>
                    <div className="flex items-center justify-between text-slate-500 text-[11px]">
                      <span className="flex items-center gap-1">
                        <User className="w-3 h-3 text-slate-400" />
                        <span className="text-slate-700 font-semibold">{item.staffName || t('schedule.adUnassignedStaff')}</span>
                      </span>
                      <span className="flex items-center gap-1">
                        <BedDouble className="w-3 h-3 text-slate-400" />
                        <span className="text-slate-700 font-medium">{item.resourceName || t('schedule.adUnassignedRoom')}</span>
                      </span>
                    </div>
                  </div>
                ))}

                {/* 动态录入的现场加项列表 (支持为每一个加项直接修改技师) */}
                {localAddOns.map((addon, idx) => (
                  <div key={addon.id} className="py-2.5 space-y-2 text-xs bg-purple-50/50 p-2.5 rounded-xl mt-2 border border-purple-100">
                    <div className="flex justify-between items-center font-bold text-purple-900">
                      <span className="flex items-center gap-1">
                        <Plus className="w-3.5 h-3.5 text-purple-600" />
                        <span className="text-sm">{t('schedule.adAddOnTag')} {addon.name}</span>
                        <span className="text-[10px] font-mono text-purple-600">({addon.durationMin}m)</span>
                      </span>
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-purple-800 font-bold text-sm">${centsToDollars(addon.priceCents)}</span>
                        <button
                          type="button"
                          className="text-red-500 hover:text-red-700 text-[10px] font-semibold"
                          onClick={() => setLocalAddOns((prev) => prev.filter((_, i) => i !== idx))}
                        >
                          
                          {t('schedule.adDelete')}
                        </button>
                      </div>
                    </div>

                    {/* 加项技师修改选择器 */}
                    <div className="flex items-center justify-between pt-1 border-t border-purple-100/80">
                      <span className="text-[11px] text-purple-700 font-medium flex items-center gap-1">
                        <User className="w-3 h-3 text-purple-500" />
                        <span>{t('schedule.adCommissionStaffLabel')}</span>
                      </span>
                      <select
                        value={addon.staffId}
                        onChange={(e) => {
                          const newStaffId = e.target.value;
                          const newStaffName = staff.find((s) => s.membershipId === newStaffId)?.name || t('schedule.adUnassignedStaff2');
                          setLocalAddOns((prev) =>
                            prev.map((item, i) =>
                              i === idx ? { ...item, staffId: newStaffId, staffName: newStaffName } : item,
                            ),
                          );
                          toast.success(t('schedule.adAddOnStaffChanged', { p0: addon.name, p1: newStaffName }));
                        }}
                        className="px-2 py-1 text-[11px] rounded-lg border border-purple-200 bg-white font-medium text-slate-800"
                      >
                        <option value="">{t('schedule.adUnassignedStaff3')}</option>
                        {staff
                          .filter((s) => s.membershipId !== UNASSIGNED_STAFF_ID)
                          .map((s) => (
                            <option key={s.membershipId} value={s.membershipId}>
                              {s.name}
                            </option>
                          ))}
                      </select>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* 本次可用客户权益 (次卡、Gift Card、积分) */}
            <div className="bg-white p-3.5 rounded-2xl border border-slate-200 shadow-sm space-y-2.5">
              <h3 className="font-bold text-slate-800 text-xs uppercase tracking-wider flex items-center justify-between">
                <span className="flex items-center gap-1.5">
                  <Gift className="w-3.5 h-3.5 text-amber-600" />
                  <span>{t('schedule.adAvailableBenefits')}</span>
                </span>
                <span className="text-[10px] font-bold text-emerald-600">{t('schedule.adAutoMatched')}</span>
              </h3>

              <div className="grid grid-cols-3 gap-2 text-xs">
                <div className="p-2 bg-amber-50/70 border border-amber-200 rounded-xl space-y-0.5">
                  <span className="text-[10px] font-bold text-amber-900 block">{t('schedule.adPackageBenefit')}</span>
                  <span className="font-mono font-bold text-slate-800 block text-xs">{t('schedule.adPackageValid')}</span>
                  <span className="text-[9px] text-amber-700 block truncate">{t('schedule.adPackageDetail')}</span>
                </div>

                <div className="p-2 bg-sky-50/70 border border-sky-200 rounded-xl space-y-0.5">
                  <span className="text-[10px] font-bold text-sky-900 block">{t('schedule.adGiftCardBalance')}</span>
                  <span className="font-mono font-bold text-slate-800 block text-xs">
                    ${customerDetail?.giftCards[0] ? centsToDollars(customerDetail.giftCards[0].balanceCents) : '0.00'}
                  </span>
                  <span className="text-[9px] text-sky-700 block truncate">
                    {customerDetail?.giftCards[0]?.code || t('schedule.adNoGiftCard')}
                  </span>
                </div>

                <div className="p-2 bg-emerald-50/70 border border-emerald-200 rounded-xl space-y-0.5">
                  <span className="text-[10px] font-bold text-emerald-900 block">{t('schedule.adLoyaltyPoints')}</span>
                  <span className="font-mono font-bold text-emerald-800 block text-xs">240 pts</span>
                  <span className="text-[9px] text-emerald-700 block truncate">{t('schedule.adPointsCredit')}</span>
                </div>
              </div>
            </div>

            {/* 费用明细核算汇总 */}
            <div className="bg-white p-3.5 rounded-2xl border border-slate-200 shadow-sm space-y-2 text-xs">
              <h3 className="font-bold text-slate-800 text-xs uppercase tracking-wider">
                {t('billingSummary') || t('schedule.adCostSummary')}
              </h3>
              <div className="space-y-1.5 border-b border-slate-100 pb-2.5 text-slate-600">
                <div className="flex justify-between">
                  <span>{t('schedule.adBaseServiceFee')}</span>
                  <span className="font-mono font-bold text-slate-800">${centsToDollars(itemsPriceCents)}</span>
                </div>
                {addOnsPriceCents > 0 && (
                  <div className="flex justify-between text-purple-700">
                    <span>{t('schedule.adAddOnSubtotal')}</span>
                    <span className="font-mono font-bold">+${centsToDollars(addOnsPriceCents)}</span>
                  </div>
                )}
                <div className="flex justify-between text-emerald-700">
                  <span>{t('schedule.adBenefitDiscount')}</span>
                  <span className="font-mono font-bold">-$0.00</span>
                </div>
              </div>

              <div className="flex justify-between items-end pt-1 font-bold">
                <span className="text-slate-800 text-sm">{t('schedule.adTotalDue')}</span>
                <span className="text-2xl font-black text-teal-700 font-mono">
                  ${centsToDollars(subtotalCents)}
                </span>
              </div>
            </div>
          </div>
        )}

        {/* Tab 2: 健康声明 (真二维码扫码、点击放大、重填新版本、历史签署版本档案) */}
        {!isLoading && activeTab === 'intake' && (() => {
          const intakeUrl = `${window.location.origin}/forms?appointmentId=${encodeURIComponent(appointmentId || '')}&customerName=${encodeURIComponent(customerName)}&phone=${encodeURIComponent(resolvedData?.customer.phone || '')}`;
          const latestSubmission = healthFormHistory[0];

          return (
            <div className="space-y-3.5 animate-in fade-in duration-200">
              {/* 1. iPad 扫码与专属签署直链卡片 */}
              <div className="bg-white p-3.5 rounded-2xl border border-sky-200 shadow-sm space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="font-bold text-slate-800 text-xs uppercase tracking-wider flex items-center gap-1.5">
                    <QrCode className="w-3.5 h-3.5 text-sky-600" />
                    <span>{t('schedule.adSigningStation')}</span>
                  </h3>
                  <Badge variant="secondary" className="text-[10px] bg-sky-50 text-sky-800 border-sky-200 font-bold">
                    
                    {t('schedule.adWaiverTitle')}
                  </Badge>
                </div>

                <div className="p-3 bg-sky-50/60 border border-sky-200 rounded-xl flex items-center gap-3">
                  {/* 可点击放大的真实二维码卡片 */}
                  <div
                    onClick={() =>
                      setQrZoomModal({
                        isOpen: true,
                        url: intakeUrl,
                        customerName: customerName,
                        phone: resolvedData?.customer.phone || undefined,
                        serviceName: firstItem?.serviceName,
                      })
                    }
                    className="w-18 h-18 bg-white p-1.5 rounded-2xl border border-sky-300 shadow-sm flex flex-col items-center justify-center shrink-0 cursor-pointer hover:border-sky-500 hover:shadow-md transition-all group relative"
                    title={t('schedule.adZoomQr')}
                  >
                    <QRCodeSVG value={intakeUrl} size={48} level="M" />
                    <span className="text-[8px] text-sky-800 font-bold mt-0.5 group-hover:text-sky-600 transition-colors">
                      
                      {t('schedule.adZoomHint')}
                    </span>
                  </div>

                  <div className="text-xs space-y-1 flex-1">
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-sky-950 text-[11px] flex items-center gap-1">
                        <Tablet className="w-3 h-3 text-sky-600" />
                        <span>{t('schedule.adSignOnDevice')}</span>
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          setQrZoomModal({
                            isOpen: true,
                            url: intakeUrl,
                            customerName: customerName,
                            phone: resolvedData?.customer.phone || undefined,
                            serviceName: firstItem?.serviceName,
                          })
                        }
                        className="text-[10px] font-bold text-sky-700 hover:underline"
                      >
                        
                        {t('schedule.adFullScreenQr')}
                      </button>
                    </div>
                    <p className="text-slate-600 text-[11px] leading-relaxed">
                      
                      {t('schedule.adSigningGuide')}
                    </p>
                    <div className="flex items-center gap-1.5 pt-0.5">
                      <input
                        type="text"
                        readOnly
                        value={intakeUrl}
                        className="flex-1 px-2 py-0.5 text-[10px] font-mono bg-white border border-sky-200 rounded-lg text-slate-600 outline-none select-all"
                      />
                      <Button
                        size="sm"
                        variant="secondary"
                        className="h-6 px-2 text-[10px] font-bold gap-1 bg-white border-sky-300 text-sky-800 hover:bg-sky-50 shrink-0"
                        onClick={() => {
                          if (navigator?.clipboard?.writeText) {
                            navigator.clipboard.writeText(intakeUrl);
                            toast.success(t('schedule.adSignLinkCopied'));
                          }
                        }}
                      >
                        <Copy className="w-3 h-3 text-sky-600" />
                        <span>{t('schedule.adCopy')}</span>
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        className="h-6 px-2 text-[10px] font-bold gap-1 bg-sky-600 text-white hover:bg-sky-700 shrink-0 shadow-xs"
                        onClick={() => window.open(intakeUrl, '_blank', 'noopener,noreferrer')}
                      >
                        <ExternalLink className="w-3 h-3" />
                        <span>{t('schedule.adOpen')}</span>
                      </Button>
                    </div>
                  </div>
                </div>
              </div>

              {/* 2. 当前有效签署状态与操作横幅 */}
              <div className="bg-emerald-50/80 p-3.5 rounded-2xl border border-emerald-200 flex flex-col gap-2.5 shadow-sm">
                <div className="flex items-start justify-between">
                  <div className="flex items-start gap-2.5">
                    <CheckCircle2 className="w-5 h-5 text-emerald-600 mt-0.5 shrink-0" />
                    <div>
                      <div className="flex items-center gap-2">
                        <h4 className="font-bold text-emerald-950 text-xs">{t('schedule.adWaiverSigned')}</h4>
                        <Badge variant="success" className="text-[9px] font-bold px-1.5 py-0">
                          
                          {t('schedule.adLatestVersionPrefix')} {latestSubmission?.version || 1}  {t('schedule.adVersionSuffix')}
                        </Badge>
                      </div>
                      <p className="text-[11px] text-emerald-800 mt-0.5 leading-relaxed">
                        
                        {t('schedule.adSignedAt')} {storeTime.dateTime(latestSubmission?.submittedAt || Date.now())}  {t('schedule.adSourceSep')} {latestSubmission?.source || t('schedule.adSignedOniPad')}
                      </p>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2 pt-1 border-t border-emerald-200/60">
                  <Button
                    size="sm"
                    variant="secondary"
                    className="text-xs font-bold gap-1.5 bg-white text-emerald-900 border-emerald-300 hover:bg-emerald-100 h-8 shadow-xs"
                    onClick={() => {
                      setSelectedViewingSubmission(latestSubmission || null);
                      setViewingForm(true);
                    }}
                  >
                    <FileCheck className="w-3.5 h-3.5 text-emerald-600" />
                    <span>{t('schedule.adViewLatest')}</span>
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    className="text-xs font-bold gap-1.5 bg-purple-50 text-purple-900 border-purple-200 hover:bg-purple-100 h-8 shadow-xs"
                    onClick={() => {
                      setReFillFormData({
                        contraindications: selectedAllergies.length > 0 ? selectedAllergies : ['No specific contraindications'],
                        focusAreas: preferencesState.focusAreas,
                        avoidAreas: preferencesState.avoidAreas,
                        medications: '',
                        recentSurgery: '',
                        consentGiven: true,
                        signatureName: customerName,
                        notes: '',
                      });
                      setReFillModalOpen(true);
                    }}
                  >
                    <RefreshCw className="w-3.5 h-3.5 text-purple-600" />
                    <span>{t('schedule.adResign')}</span>
                  </Button>
                </div>
              </div>

              {/* 3. 历史签署版本记录归档列表 (完整保留所有历史记录) */}
              <div className="bg-white p-3.5 rounded-2xl border border-slate-200 shadow-sm space-y-2.5">
                <div className="flex items-center justify-between">
                  <h3 className="font-bold text-slate-800 text-xs uppercase tracking-wider flex items-center gap-1.5">
                    <History className="w-3.5 h-3.5 text-purple-600" />
                    <span>{t('schedule.adVersionArchive')}</span>
                  </h3>
                  <span className="text-[10px] text-slate-500 font-mono">
                    
                    {t('schedule.adTotalPrefix')} {healthFormHistory.length}  {t('schedule.adSigningsUnit')}
                  </span>
                </div>

                <div className="space-y-2">
                  {healthFormHistory.map((item, idx) => {
                    const isLatest = idx === 0;
                    return (
                      <div
                        key={item.id}
                        className={cn(
                          'p-3 rounded-xl border transition-all text-xs space-y-2',
                          isLatest
                            ? 'bg-emerald-50/40 border-emerald-200 ring-1 ring-emerald-300/60'
                            : 'bg-slate-50 border-slate-200 hover:bg-slate-100/70',
                        )}
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <span className="font-bold font-mono text-slate-900">
                              
                              {t('schedule.adVersionPrefix')} {item.version}  {t('schedule.adVersionSuffix2')}
                            </span>
                            <Badge
                              variant={isLatest ? 'success' : 'secondary'}
                              className="text-[9px] font-bold px-1.5 py-0"
                            >
                              {isLatest ? t('schedule.adVersionCurrent') : t('schedule.adVersionArchived')}
                            </Badge>
                            <span className="text-[10px] text-slate-500">
                              {item.source}
                            </span>
                          </div>
                          <span className="text-[10px] text-slate-400 font-mono">
                            {storeTime.dateTime(item.submittedAt)}
                          </span>
                        </div>

                        {/* 禁忌与回答摘要 */}
                        <div className="flex flex-wrap items-center gap-1">
                          <span className="text-[10px] text-slate-500 font-medium">{t('schedule.adScreeningResult')}</span>
                          {item.contraindications.map((c) => (
                            <span
                              key={c}
                              className={cn(
                                'text-[10px] px-1.5 py-0.2 rounded font-bold',
                                c === 'No specific contraindications'
                                  ? 'bg-slate-100 text-slate-600'
                                  : 'bg-red-50 text-red-700 border border-red-200',
                              )}
                            >
                              {c}
                            </span>
                          ))}
                        </div>

                        <div className="flex items-center justify-between pt-1 border-t border-slate-200/60">
                          <span className="text-[10px] text-slate-500">
                            
                            {t('schedule.adSignerLabel')} <strong>{item.customerName}</strong> {item.notes && `· ${item.notes}`}
                          </span>
                          <Button
                            size="sm"
                            variant="secondary"
                            className="h-6 px-2.5 text-[10px] font-bold gap-1 bg-white hover:bg-slate-100 border border-slate-200 text-slate-700"
                            onClick={() => {
                              setSelectedViewingSubmission(item);
                              setViewingForm(true);
                            }}
                          >
                            <FileText className="w-3 h-3 text-slate-500" />
                            <span>{t('schedule.adViewThisVersion')}</span>
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

            {/* 过敏与健康禁忌史 (支持点击编辑并二次确认) */}
            <div className="bg-white p-3.5 rounded-2xl border border-slate-200 shadow-sm space-y-2.5">
              <div className="flex items-center justify-between">
                <h3 className="font-bold text-slate-800 text-xs uppercase tracking-wider flex items-center gap-1.5">
                  <ShieldCheck className="w-3.5 h-3.5 text-teal-600" />
                  <span>{t('schedule.adAllergyScreening')}</span>
                </h3>
                <Button
                  size="sm"
                  variant="secondary"
                  className="h-7 text-[11px] font-bold text-teal-700 border-teal-200 bg-teal-50 hover:bg-teal-100 gap-1 px-2"
                  onClick={() => setAllergiesModalOpen(true)}
                >
                  <Edit3 className="w-3 h-3" />
                  <span>{t('schedule.adEditContraindications')}</span>
                </Button>
              </div>

              {/* 禁忌标签展示 */}
              <div className="flex flex-wrap gap-1.5">
                {selectedAllergies.map((tag) => (
                  <span
                    key={tag}
                    className={cn(
                      'px-2.5 py-1 rounded-lg text-xs font-bold font-mono',
                      tag === 'No specific contraindications'
                        ? 'bg-slate-100 text-slate-700'
                        : 'bg-red-50 text-red-700 border border-red-200',
                    )}
                  >
                    {tag}
                  </span>
                ))}
              </div>

              <p className="text-xs text-slate-600 bg-slate-50 p-2.5 rounded-xl border border-slate-100 leading-relaxed font-medium">
                {allergiesNotes || resolvedData?.customer.allergiesSummary || t('schedule.adNoOtherHistory')}
              </p>
            </div>
          </div>
        ); })()}

        {/* Tab 3: 客户偏好 (细分左右重点护理部位、避免触碰部位、默认No Preference) */}
        {!isLoading && activeTab === 'preferences' && (
          <div className="space-y-3.5 animate-in fade-in duration-200">
            {/* 快速偏好一键选择组 (默认均支持No Preference) */}
            <div className="bg-white p-3.5 rounded-2xl border border-slate-200 shadow-sm space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="font-bold text-slate-800 text-xs uppercase tracking-wider flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5 text-teal-600" />
                  <span>{t('schedule.adPrefsTitle')}</span>
                </h3>
              </div>

              {/* 1. 按摩力度 */}
              <div>
                <label className="block text-[11px] font-bold text-slate-500 mb-1.5">{t('schedule.adPressurePref')}</label>
                <div className="grid grid-cols-4 gap-1.5 text-xs">
                  {['No Preference', 'Gentle & Relaxing', 'Medium Pressure', 'Deep Tissue'].map((opt) => (
                    <button
                      key={opt}
                      type="button"
                      onClick={() => setPreferencesState((prev) => ({ ...prev, intensity: opt }))}
                      className={cn(
                        'py-1.5 px-2 rounded-xl border font-bold text-xs transition-all',
                        preferencesState.intensity === opt
                          ? 'border-teal-500 bg-teal-50 text-teal-900 shadow-sm ring-1 ring-teal-400'
                          : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50',
                      )}
                    >
                      {opt}
                    </button>
                  ))}
                </div>
              </div>

              {/* 2. 背景音乐 */}
              <div>
                <label className="block text-[11px] font-bold text-slate-500 mb-1.5 flex items-center gap-1">
                  <Music className="w-3 h-3 text-slate-400" />
                  <span>{t('schedule.adMusicPref')}</span>
                </label>
                <div className="grid grid-cols-4 gap-1.5 text-xs">
                  {['No Preference', t('schedule.adMusicSoft'), t('schedule.adMusicWhiteNoise'), t('schedule.adMusicSilence')].map((opt) => (
                    <button
                      key={opt}
                      type="button"
                      onClick={() => setPreferencesState((prev) => ({ ...prev, music: opt }))}
                      className={cn(
                        'py-1.5 px-2 rounded-xl border font-bold text-xs transition-all',
                        preferencesState.music === opt
                          ? 'border-teal-500 bg-teal-50 text-teal-900 shadow-sm ring-1 ring-teal-400'
                          : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50',
                      )}
                    >
                      {opt}
                    </button>
                  ))}
                </div>
              </div>

              {/* 3. 芳香精油 */}
              <div>
                <label className="block text-[11px] font-bold text-slate-500 mb-1.5">{t('schedule.adOilPref')}</label>
                <div className="grid grid-cols-5 gap-1 text-xs">
                  {['No Preference', t('schedule.adOilNone'), t('schedule.adOilLavender'), t('schedule.adOilEucalyptus'), t('schedule.adOilOrange')].map((opt) => (
                    <button
                      key={opt}
                      type="button"
                      onClick={() => setPreferencesState((prev) => ({ ...prev, aromatherapy: opt }))}
                      className={cn(
                        'py-1.5 px-1 rounded-xl border font-bold text-[10px] transition-all truncate',
                        preferencesState.aromatherapy === opt
                          ? 'border-teal-500 bg-teal-50 text-teal-900 shadow-sm ring-1 ring-teal-400'
                          : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50',
                      )}
                    >
                      {opt}
                    </button>
                  ))}
                </div>
              </div>

              {/* 4. 室温与技师性别偏好 */}
              <div className="grid grid-cols-2 gap-3 pt-1">
                <div>
                  <label className="block text-[11px] font-bold text-slate-500 mb-1 flex items-center gap-1">
                    <Thermometer className="w-3 h-3 text-slate-400" />
                    <span>{t('schedule.adTempPref')}</span>
                  </label>
                  <select
                    value={preferencesState.temperature}
                    onChange={(e) => setPreferencesState((prev) => ({ ...prev, temperature: e.target.value }))}
                    className="w-full px-2.5 py-1.5 text-xs rounded-xl border border-slate-200 bg-white font-medium text-slate-800"
                  >
                    <option value="No Preference">No Preference (No Preference)</option>
                    <option value={t('schedule.adTempWarm')}>{t('schedule.adTempWarmFull')}</option>
                    <option value={t('schedule.adTempNeutral')}>{t('schedule.adTempNeutralFull')}</option>
                    <option value={t('schedule.adTempCool')}>{t('schedule.adTempCoolFull')}</option>
                  </select>
                </div>

                <div>
                  <label className="block text-[11px] font-bold text-slate-500 mb-1 flex items-center gap-1">
                    <Languages className="w-3 h-3 text-slate-400" />
                    <span>{t('schedule.adLanguagePref')}</span>
                  </label>
                  <select
                    value={preferencesState.language}
                    onChange={(e) => setPreferencesState((prev) => ({ ...prev, language: e.target.value }))}
                    className="w-full px-2.5 py-1.5 text-xs rounded-xl border border-slate-200 bg-white font-medium text-slate-800"
                  >
                    <option value="No Preference">No Preference (No Preference)</option>
                    <option value={t('schedule.adLangChinese')}>{t('schedule.adLangChineseFull')}</option>
                    <option value="English">English</option>
                    <option value={t('schedule.adLangCantonese')}>{t('schedule.adLangCantoneseFull')}</option>
                    <option value={t('schedule.adLangSpanish')}>{t('schedule.adLangSpanishFull')}</option>
                  </select>
                </div>
              </div>
            </div>

            {/* 重点加压 / 护理部位 (分左右详细分组) */}
            <div className="bg-white p-3.5 rounded-2xl border border-slate-200 shadow-sm space-y-3">
              <div className="flex items-center justify-between">
                <label className="block text-xs font-bold text-slate-800 uppercase tracking-wider flex items-center gap-1.5">
                  <Activity className="w-3.5 h-3.5 text-teal-600" />
                  <span>{t('schedule.adFocusAreasTitle')}</span>
                </label>
                <span className="text-[10px] text-slate-400">{t('schedule.adSelectedPrefix')} {preferencesState.focusAreas.length}  {t('schedule.adAreaUnit')}</span>
              </div>

              <div className="space-y-2 text-xs">
                {FOCUS_AREAS_GROUPS.map((group) => (
                  <div key={group.group} className="space-y-1">
                    <span className="text-[10px] font-bold text-slate-400 block">{group.group}:</span>
                    <div className="flex flex-wrap gap-1">
                      {group.items.map((area) => {
                        const isSelected = preferencesState.focusAreas.includes(area);
                        return (
                          <button
                            key={area}
                            type="button"
                            onClick={() => {
                              setPreferencesState((prev) => ({
                                ...prev,
                                focusAreas: isSelected
                                  ? prev.focusAreas.filter((a) => a !== area)
                                  : [...prev.focusAreas, area],
                              }));
                            }}
                            className={cn(
                              'px-2 py-1 text-[11px] font-bold rounded-lg border transition-colors',
                              isSelected
                                ? 'bg-teal-600 text-white border-teal-600 shadow-sm'
                                : 'bg-slate-50 hover:bg-slate-100 text-slate-700 border-slate-200',
                            )}
                          >
                            {isSelected ? `✓ ${area}` : `+ ${area}`}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* 避免触碰部位 (红/警告标识) */}
            <div className="bg-white p-3.5 rounded-2xl border border-slate-200 shadow-sm space-y-2.5">
              <div className="flex items-center justify-between">
                <label className="block text-xs font-bold text-red-800 uppercase tracking-wider flex items-center gap-1.5">
                  <Ban className="w-3.5 h-3.5 text-red-600" />
                  <span>{t('schedule.adAvoidAreasTitle')}</span>
                </label>
                <span className="text-[10px] text-red-600 font-bold">{t('schedule.adTherapistAttention')}</span>
              </div>

              <div className="flex flex-wrap gap-1 text-xs">
                {AVOID_AREAS_LIST.map((area) => {
                  const isSelected = preferencesState.avoidAreas.includes(area);
                  return (
                    <button
                      key={area}
                      type="button"
                      onClick={() => {
                        if (area === 'No areas to avoid') {
                          setPreferencesState((prev) => ({ ...prev, avoidAreas: ['No areas to avoid'] }));
                        } else {
                          setPreferencesState((prev) => {
                            const withoutNone = prev.avoidAreas.filter((a) => a !== 'No areas to avoid');
                            return {
                              ...prev,
                              avoidAreas: isSelected
                                ? withoutNone.filter((a) => a !== area)
                                : [...withoutNone, area],
                            };
                          });
                        }
                      }}
                      className={cn(
                        'px-2 py-1 text-[11px] font-bold rounded-lg border transition-colors',
                        isSelected
                          ? area === 'No areas to avoid'
                            ? 'bg-slate-200 text-slate-800 border-slate-300'
                            : 'bg-red-500 text-white border-red-500 shadow-sm'
                          : 'bg-slate-50 hover:bg-red-50 text-slate-700 border-slate-200 hover:text-red-700',
                      )}
                    >
                      {isSelected ? `✓ ${area}` : `+ ${area}`}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* 偏好备注与保存按钮 */}
            <div className="bg-white p-3.5 rounded-2xl border border-slate-200 shadow-sm space-y-2">
              <label className="block text-xs font-bold text-slate-800 uppercase tracking-wider">
                
                {t('schedule.adCustomerNotes')}
              </label>
              <Input
                value={preferencesState.notes}
                onChange={(e) => setPreferencesState((prev) => ({ ...prev, notes: e.target.value }))}
                placeholder={t('schedule.adNotesPlaceholder')}
              />
              <Button
                size="sm"
                className="w-full mt-2 bg-teal-600 hover:bg-teal-700 text-white font-bold text-xs h-8 gap-1 shadow-sm"
                onClick={() => setConfirmPrefModalOpen(true)}
              >
                <Check className="w-3.5 h-3.5" />
                <span>{t('schedule.adSavePrefs')}</span>
              </Button>
            </div>
          </div>
        )}

        {/* Tab 4: 备注记录 (全生命周期进度审计、专业 SOAP 多行理疗记录、历史到店记录) */}
        {!isLoading && activeTab === 'soap' && (
          <div className="space-y-3.5 animate-in fade-in duration-200">
            {/* 专业 SOAP Therapy Record (支持前台与技师多行编辑并确认) */}
            <div className="bg-white p-3.5 rounded-2xl border border-slate-200 shadow-sm space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="font-bold text-slate-800 text-xs uppercase tracking-wider flex items-center gap-1.5">
                  <Stethoscope className="w-3.5 h-3.5 text-teal-600" />
                  <span>{t('schedule.adSoapTitle')}</span>
                </h3>
                <Button
                  size="sm"
                  variant="secondary"
                  className="h-7 text-[11px] font-bold text-teal-700 border-teal-200 bg-teal-50 hover:bg-teal-100 gap-1 px-2.5"
                  onClick={() => setSoapModalOpen(true)}
                >
                  <Edit3 className="w-3 h-3" />
                  <span>{t('schedule.adEditRecord')}</span>
                </Button>
              </div>

              <div className="space-y-2 text-xs">
                <div className="p-2.5 bg-slate-50 rounded-xl border border-slate-100 space-y-0.5">
                  <span className="font-bold text-teal-800 text-[10px] block">{t('schedule.adSoapS')}</span>
                  <p className="text-slate-700 leading-relaxed font-medium whitespace-pre-wrap">{soapForm.subjective}</p>
                </div>

                <div className="p-2.5 bg-slate-50 rounded-xl border border-slate-100 space-y-0.5">
                  <span className="font-bold text-teal-800 text-[10px] block">{t('schedule.adSoapO')}</span>
                  <p className="text-slate-700 leading-relaxed font-medium whitespace-pre-wrap">{soapForm.objective}</p>
                </div>

                <div className="p-2.5 bg-slate-50 rounded-xl border border-slate-100 space-y-0.5">
                  <span className="font-bold text-teal-800 text-[10px] block">{t('schedule.adSoapA')}</span>
                  <p className="text-slate-700 leading-relaxed font-medium whitespace-pre-wrap">{soapForm.assessment}</p>
                </div>

                <div className="p-2.5 bg-slate-50 rounded-xl border border-slate-100 space-y-0.5">
                  <span className="font-bold text-teal-800 text-[10px] block">{t('schedule.adSoapP')}</span>
                  <p className="text-slate-700 leading-relaxed font-medium whitespace-pre-wrap">{soapForm.plan}</p>
                </div>
              </div>
            </div>

            {/* 历史到店记录 (Kuee 风格 Visit History) */}
            <div className="bg-white p-3.5 rounded-2xl border border-slate-200 shadow-sm space-y-2.5">
              <h3 className="font-bold text-slate-800 text-xs uppercase tracking-wider flex items-center gap-1.5">
                <History className="w-3.5 h-3.5 text-slate-500" />
                <span>{t('schedule.adPastVisits')}</span>
              </h3>

              <div className="space-y-2 text-xs">
                <div className="p-2.5 bg-slate-50 rounded-xl border border-slate-100 flex items-center justify-between">
                  <div>
                    <span className="font-bold text-slate-800 block text-xs">
                      {firstItem?.serviceName || t('schedule.adSampleService')}
                    </span>
                    <span className="text-[10px] text-slate-400 font-mono">
                      {currentDate}  {t('schedule.adTherapistSep')} {firstItem?.staffName || t('schedule.adAssigned')}
                    </span>
                  </div>
                  <Badge variant="success" className="text-[10px] font-bold font-mono">
                    
                    {t('schedule.adThisTicket')}
                  </Badge>
                </div>

                {customerDetail?.recentTickets && customerDetail.recentTickets.length > 0 && (
                  // 形参不得命名为 t —— 会遮蔽多语言取词函数 t()
                  customerDetail.recentTickets.map((ticket) => (
                    <div key={ticket.id} className="p-2.5 bg-white rounded-xl border border-slate-200 flex items-center justify-between">
                      <div>
                        <span className="font-bold text-slate-800 block text-xs">
                          {ticket.serviceNames.join('、') || t('schedule.adStandardService')}
                        </span>
                        <span className="text-[10px] text-slate-400 font-mono">{ticket.businessDate}</span>
                      </div>
                      <span className="font-mono font-bold text-slate-800">
                        {ticket.totalCents ? `$${centsToDollars(ticket.totalCents)}` : t('schedule.adSettled')}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 底部操作 Footer CTA */}
      <div className="p-4 bg-white border-t border-slate-200 shrink-0 flex items-center justify-between gap-3">
        {status !== 'done' && appointmentId && (
          <Button
            variant="secondary"
            className="text-xs font-bold text-red-600 hover:bg-red-50 border-red-200 h-11 px-3.5 gap-1.5 shrink-0"
            onClick={() => setCancelModalOpen(true)}
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>Cancel Appointment</span>
          </Button>
        )}
        <Button
          className="flex-1 bg-teal-600 hover:bg-teal-700 text-white font-bold h-11 text-sm rounded-xl shadow-md gap-2"
          onClick={handleStepForward}
        >
          {status === 'booked' && (
            <>
              <Play className="w-4 h-4" />
              <span>{t('checkInAndStart') || t('schedule.adCheckInAndOpen')}</span>
            </>
          )}
          {status === 'checked_in' && (
            <>
              <Play className="w-4 h-4" />
              <span>{t('schedule.adStartService')}</span>
            </>
          )}
          {status === 'in_service' && (
            <>
              <Check className="w-4 h-4" />
              <span>{t('finishAndCheckout') || t('schedule.adFinishToCheckout')}</span>
            </>
          )}
          {status === 'done' && (
            <>
              <span>{t('goToCheckout') || t('schedule.adGoToCheckout')}</span>
              <ChevronRight className="w-4 h-4" />
            </>
          )}
        </Button>
      </div>

      {/* ========================================================
          各 Tab 专属编辑二次确认 Modals
      ======================================================== */}

      {/* Modal 1: Edit Service & Assignment确认 */}
      {editServiceModal.isOpen && (
        <Modal
          isOpen={editServiceModal.isOpen}
          onOpenChange={(open) => setEditServiceModal((prev) => ({ ...prev, isOpen: open }))}
          title={
            <div className="flex items-center gap-2 text-teal-800 font-bold">
              <Edit3 className="w-5 h-5 text-teal-600" />
              <span>{t('schedule.adEditItemsTitle')}</span>
            </div>
          }
          size="md"
          footer={
            <div className="flex justify-end gap-2 w-full">
              <Button variant="secondary" onClick={() => setEditServiceModal((prev) => ({ ...prev, isOpen: false }))}>
                
                {t('schedule.adEditCancel')}
              </Button>
              <Button
                className="bg-teal-600 hover:bg-teal-700 text-white font-bold gap-1"
                disabled={rescheduleMutation.isPending}
                onClick={handleConfirmEditService}
              >
                {rescheduleMutation.isPending ? t('schedule.adUpdating') : t('schedule.adConfirmUpdate')}
              </Button>
            </div>
          }
        >
          <div className="space-y-3.5 py-2 text-xs text-slate-700">
            <div>
              <label className="block font-bold text-slate-700 mb-1">{t('schedule.adAssignStaffRequired')}</label>
              <select
                value={editServiceModal.staffId}
                onChange={(e) => setEditServiceModal((prev) => ({ ...prev, staffId: e.target.value }))}
                className="w-full px-3 py-2 text-xs rounded-xl border border-slate-200 bg-white font-medium text-slate-800"
              >
                <option value="">{t('schedule.adUnassignedPool')}</option>
                {staff
                  .filter((s) => s.membershipId !== UNASSIGNED_STAFF_ID && s.isBookable)
                  .map((s) => (
                    <option key={s.membershipId} value={s.membershipId}>
                      {s.name}
                    </option>
                  ))}
              </select>
            </div>

            <div>
              <label className="block font-bold text-slate-700 mb-1">{t('schedule.adAssignRoom')}</label>
              <select
                value={editServiceModal.roomId}
                onChange={(e) => setEditServiceModal((prev) => ({ ...prev, roomId: e.target.value }))}
                className="w-full px-3 py-2 text-xs rounded-xl border border-slate-200 bg-white font-medium text-slate-800"
              >
                <option value="">{t('schedule.adNoRoom')}</option>
                {rooms.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name} ({r.type === 'room' ? t('schedule.adRoomType') : t('schedule.adStationType')} · {r.status === 'available' ? t('schedule.adRoomFree') : t('schedule.adRoomOccupied')})
                  </option>
                ))}
              </select>
            </div>

            <div className="p-2.5 bg-teal-50 rounded-xl border border-teal-200 text-teal-900 leading-relaxed">
              
              {t('schedule.adUpdateWarning')}
            </div>
          </div>
        </Modal>
      )}

      {/* Modal 2: 增加加项确认 (仅自定义时可修改名称，每次均可指派技师) */}
      {addAddOnModal.isOpen && (
        <Modal
          isOpen={addAddOnModal.isOpen}
          onOpenChange={(open) => setAddAddOnModal((prev) => ({ ...prev, isOpen: open }))}
          title={
            <div className="flex items-center gap-2 text-purple-800 font-bold">
              <Plus className="w-5 h-5 text-purple-600" />
              <span>{t('schedule.adAddOnModalTitle')}</span>
            </div>
          }
          size="md"
          footer={
            <div className="flex justify-end gap-2 w-full">
              <Button variant="secondary" onClick={() => setAddAddOnModal((prev) => ({ ...prev, isOpen: false }))}>
                
                {t('schedule.adAddOnCancel')}
              </Button>
              <Button className="bg-purple-600 hover:bg-purple-700 text-white font-bold" onClick={handleConfirmAddAddOn}>
                
                {t('schedule.adAddOnConfirm')}
              </Button>
            </div>
          }
        >
          <div className="space-y-3 py-2 text-xs text-slate-700">
            <div>
              <label className="block font-bold text-slate-700 mb-1">{t('schedule.adAddOnCategory')}</label>
              <select
                value={addAddOnModal.serviceId}
                onChange={(e) => {
                  const s = services.find((srv) => srv.id === e.target.value);
                  setAddAddOnModal((prev) => ({
                    ...prev,
                    serviceId: e.target.value,
                    customName: s ? s.name : 'Add-on 30 min',
                    priceDollars: s ? centsToDollars(s.priceCents) : '25',
                    durationMin: s?.durationMin || 30,
                  }));
                }}
                className="w-full px-3 py-2 text-xs rounded-xl border border-slate-200 bg-white font-medium text-slate-800"
              >
                <option value="">{t('schedule.adCustomAddOn')}</option>
                {services.map((s) => (
                  <option key={s.id} value={s.id}>
                    📦 {s.name} (${centsToDollars(s.priceCents)} · {s.durationMin}m)
                  </option>
                ))}
              </select>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="font-bold text-slate-700">{t('schedule.adAddOnName')}</label>
                {addAddOnModal.serviceId ? (
                  <span className="text-[10px] text-slate-400 font-medium">{t('schedule.adPresetLocked')}</span>
                ) : (
                  <span className="text-[10px] text-purple-600 font-bold">{t('schedule.adCustomMode')}</span>
                )}
              </div>
              <Input
                value={addAddOnModal.customName}
                onChange={(e) => setAddAddOnModal((prev) => ({ ...prev, customName: e.target.value }))}
                disabled={Boolean(addAddOnModal.serviceId)}
                placeholder={t('schedule.adAddOnPlaceholder')}
                className={addAddOnModal.serviceId ? 'bg-slate-100 text-slate-500 cursor-not-allowed' : ''}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block font-bold text-slate-700 mb-1">{t('schedule.adAddOnAmount')}</label>
                <Input
                  type="number"
                  value={addAddOnModal.priceDollars}
                  onChange={(e) => setAddAddOnModal((prev) => ({ ...prev, priceDollars: e.target.value }))}
                />
              </div>
              <div>
                <label className="block font-bold text-slate-700 mb-1">{t('schedule.adAddOnStaffRequired')}</label>
                <select
                  value={addAddOnModal.staffId}
                  onChange={(e) => setAddAddOnModal((prev) => ({ ...prev, staffId: e.target.value }))}
                  className="w-full px-2.5 py-2 text-xs rounded-xl border border-slate-200 bg-white font-medium"
                >
                  <option value="">{t('schedule.adUnassignedStaff4')}</option>
                  {staff
                    .filter((s) => s.membershipId !== UNASSIGNED_STAFF_ID)
                    .map((s) => (
                      <option key={s.membershipId} value={s.membershipId}>
                        {s.name}
                      </option>
                    ))}
                </select>
              </div>
            </div>
          </div>
        </Modal>
      )}

      {/* Modal 3: 客户偏好变更二次确认 */}
      {confirmPrefModalOpen && (
        <Modal
          isOpen={confirmPrefModalOpen}
          onOpenChange={setConfirmPrefModalOpen}
          title={
            <div className="flex items-center gap-2 text-teal-800 font-bold">
              <Sparkles className="w-5 h-5 text-teal-600" />
              <span>{t('schedule.adPrefsConfirmTitle')}</span>
            </div>
          }
          size="md"
          footer={
            <div className="flex justify-end gap-2 w-full">
              <Button variant="secondary" onClick={() => setConfirmPrefModalOpen(false)}>
                
                {t('schedule.adPrefsConfirmCancel')}
              </Button>
              <Button
                className="bg-teal-600 hover:bg-teal-700 text-white font-bold"
                disabled={savePreferencesMutation.isPending}
                onClick={handleConfirmSavePreferences}
              >
                {savePreferencesMutation.isPending ? t('schedule.adSavingPrefs') : t('schedule.adConfirmPrefs')}
              </Button>
            </div>
          }
        >
          <div className="space-y-3 py-2 text-xs text-slate-700">
            <p className="text-slate-600">
              
              {t('schedule.adAboutToUpdate')} <strong>{customerName}</strong>  {t('schedule.adPrefsProfileSuffix')}
            </p>
            <div className="p-3 bg-slate-50 rounded-xl border border-slate-200 space-y-1 text-slate-800">
              <p>{t('schedule.adPrefPressureLine')} <strong>{preferencesState.intensity}</strong></p>
              <p>{t('schedule.adPrefOilLine')} <strong>{preferencesState.aromatherapy}</strong></p>
              <p>{t('schedule.adPrefMusicLine')} <strong>{preferencesState.music}</strong></p>
              <p>{t('schedule.adPrefFocusLine')} <strong>{preferencesState.focusAreas.join('、') || t('schedule.adNone')}</strong></p>
              <p>{t('schedule.adPrefAvoidLine')} <strong className="text-red-700">{preferencesState.avoidAreas.join('、') || t('schedule.adNone2')}</strong></p>
              {preferencesState.notes && <p>{t('schedule.adPrefNotesLine')} {preferencesState.notes}</p>}
            </div>
          </div>
        </Modal>
      )}

      {/* Modal 4: 禁忌与过敏史编辑确认 */}
      {allergiesModalOpen && (
        <Modal
          isOpen={allergiesModalOpen}
          onOpenChange={setAllergiesModalOpen}
          title={
            <div className="flex items-center gap-2 text-red-600 font-bold">
              <ShieldCheck className="w-5 h-5" />
              <span>{t('schedule.adContraModalTitle')}</span>
            </div>
          }
          size="md"
          footer={
            <div className="flex justify-end gap-2 w-full">
              <Button variant="secondary" onClick={() => setAllergiesModalOpen(false)}>
                
                {t('schedule.adContraCancel')}
              </Button>
              <Button
                className="bg-red-600 hover:bg-red-700 text-white font-bold"
                disabled={savePreferencesMutation.isPending}
                onClick={handleConfirmSaveAllergies}
              >
                {savePreferencesMutation.isPending ? t('schedule.adUpdatingContra') : t('schedule.adConfirmContra')}
              </Button>
            </div>
          }
        >
          <div className="space-y-3 py-2 text-xs text-slate-700">
            <label className="block font-bold text-slate-700">{t('schedule.adSelectContra')}</label>
            <div className="grid grid-cols-3 gap-1.5">
              {ALLERGY_TAGS.map((tag) => {
                const isSelected = selectedAllergies.includes(tag);
                return (
                  <button
                    key={tag}
                    type="button"
                    onClick={() => {
                      if (tag === 'No specific contraindications') {
                        setSelectedAllergies(['No specific contraindications']);
                      } else {
                        setSelectedAllergies((prev) => {
                          const withoutNone = prev.filter((x) => x !== 'No specific contraindications');
                          return isSelected ? withoutNone.filter((x) => x !== tag) : [...withoutNone, tag];
                        });
                      }
                    }}
                    className={cn(
                      'p-2 rounded-xl border text-xs font-bold transition-colors',
                      isSelected
                        ? 'border-red-400 bg-red-50 text-red-900 shadow-sm'
                        : 'border-slate-200 hover:bg-slate-50 text-slate-600',
                    )}
                  >
                    {tag}
                  </button>
                );
              })}
            </div>

            <div>
              <label className="block font-bold text-slate-700 mb-1">{t('schedule.adContraNotes')}</label>
              <Input
                value={allergiesNotes}
                onChange={(e) => setAllergiesNotes(e.target.value)}
                placeholder={t('schedule.adContraPlaceholder')}
              />
            </div>
          </div>
        </Modal>
      )}

      {/* Modal 5: SOAP 专业理疗记录多行编辑与确认 */}
      {soapModalOpen && (
        <Modal
          isOpen={soapModalOpen}
          onOpenChange={setSoapModalOpen}
          title={
            <div className="flex items-center gap-2 text-teal-800 font-bold">
              <Stethoscope className="w-5 h-5 text-teal-600" />
              <span>{t('schedule.adSoapModalTitle')}</span>
            </div>
          }
          size="lg"
          footer={
            <div className="flex justify-end gap-2 w-full">
              <Button variant="secondary" onClick={() => setSoapModalOpen(false)}>
                
                {t('schedule.adSoapCancel')}
              </Button>
              <Button
                className="bg-teal-600 hover:bg-teal-700 text-white font-bold"
                onClick={() => {
                  setSoapModalOpen(false);
                  toast.success(t('schedule.adSoapSaved'));
                }}
              >
                
                {t('schedule.adSoapSave')}
              </Button>
            </div>
          }
        >
          <div className="space-y-3.5 py-2 text-xs text-slate-700">
            <div>
              <label className="block font-bold text-teal-800 mb-1">
                
                {t('schedule.adSoapSFull')}
              </label>
              <textarea
                rows={3}
                value={soapForm.subjective}
                onChange={(e) => setSoapForm((prev) => ({ ...prev, subjective: e.target.value }))}
                className="w-full px-3 py-2 text-xs rounded-xl border border-slate-200 bg-white font-medium text-slate-800 focus:outline-none focus:ring-2 focus:ring-teal-500/20"
                placeholder={t('schedule.adSoapSPlaceholder')}
              />
            </div>

            <div>
              <label className="block font-bold text-teal-800 mb-1">
                
                {t('schedule.adSoapOFull')}
              </label>
              <textarea
                rows={3}
                value={soapForm.objective}
                onChange={(e) => setSoapForm((prev) => ({ ...prev, objective: e.target.value }))}
                className="w-full px-3 py-2 text-xs rounded-xl border border-slate-200 bg-white font-medium text-slate-800 focus:outline-none focus:ring-2 focus:ring-teal-500/20"
                placeholder={t('schedule.adSoapOPlaceholder')}
              />
            </div>

            <div>
              <label className="block font-bold text-teal-800 mb-1">
                
                {t('schedule.adSoapAFull')}
              </label>
              <textarea
                rows={3}
                value={soapForm.assessment}
                onChange={(e) => setSoapForm((prev) => ({ ...prev, assessment: e.target.value }))}
                className="w-full px-3 py-2 text-xs rounded-xl border border-slate-200 bg-white font-medium text-slate-800 focus:outline-none focus:ring-2 focus:ring-teal-500/20"
                placeholder={t('schedule.adSoapAPlaceholder')}
              />
            </div>

            <div>
              <label className="block font-bold text-teal-800 mb-1">
                
                {t('schedule.adSoapPFull')}
              </label>
              <textarea
                rows={3}
                value={soapForm.plan}
                onChange={(e) => setSoapForm((prev) => ({ ...prev, plan: e.target.value }))}
                className="w-full px-3 py-2 text-xs rounded-xl border border-slate-200 bg-white font-medium text-slate-800 focus:outline-none focus:ring-2 focus:ring-teal-500/20"
                placeholder={t('schedule.adSoapPPlaceholder')}
              />
            </div>
          </div>
        </Modal>
      )}

      {/* Modal 6: Cancel Appointment二次确认 Modal */}
      {cancelModalOpen && (
        <Modal
          isOpen={cancelModalOpen}
          onOpenChange={setCancelModalOpen}
          title={
            <div className="flex items-center gap-2 text-red-600 font-bold">
              <AlertTriangle className="w-5 h-5" />
              <span>{t('schedule.adCancelConfirmTitle')}</span>
            </div>
          }
          size="md"
          footer={
            <div className="flex justify-end gap-2 w-full">
              <Button variant="secondary" onClick={() => setCancelModalOpen(false)}>
                
                {t('schedule.adDontCancel')}
              </Button>
              <Button
                className="bg-red-600 hover:bg-red-700 text-white font-bold"
                disabled={cancelMutation.isPending}
                onClick={async () => {
                  if (!appointmentId) return;
                  try {
                    await cancelMutation.mutateAsync({
                      appointmentId,
                      reason: cancelReason,
                      keepStaffTurn,
                    });
                    setCancelModalOpen(false);
                    toast.success(t('schedule.adCancelled'));
                    onClose();
                  } catch (err: any) {
                    toast.danger(t('schedule.adCancelFailed') + (err?.message || t('schedule.adNetworkError4')));
                  }
                }}
              >
                {cancelMutation.isPending ? t('schedule.adCancelling') : t('schedule.adConfirmCancelAppt')}
              </Button>
            </div>
          }
        >
          <div className="space-y-3.5 text-xs text-slate-700 py-2">
            <p className="text-slate-600 leading-relaxed">
              
              {t('schedule.adCancellingPrefix')} <strong>{customerName}</strong>  {t('schedule.adCancellingSuffix')}
            </p>

            <div className="space-y-2">
              <label className="block text-xs font-bold text-slate-700">Please select a cancellation reason *</label>
              {[
                { id: 'guest_changed_mind', label: t('schedule.adCancelReasonMind') },
                { id: 'duplicate_booking', label: t('schedule.adCancelReasonDuplicate') },
                { id: 'no_show', label: t('schedule.adCancelReasonNoShow') },
                { id: 'walk_out', label: t('schedule.adCancelReasonWaited') },
                { id: 'other', label: t('schedule.adCancelReasonOther') },
              ].map((r) => (
                <label
                  key={r.id}
                  className="flex items-center gap-2.5 p-2 rounded-xl border border-slate-200 hover:bg-slate-50 cursor-pointer font-medium"
                >
                  <input
                    type="radio"
                    name="cancelReason"
                    value={r.id}
                    checked={cancelReason === r.id}
                    onChange={() => setCancelReason(r.id as any)}
                    className="text-red-600 focus:ring-red-500/20"
                  />
                  <span>{r.label}</span>
                </label>
              ))}
            </div>

            <label className="flex items-center gap-2 pt-2 cursor-pointer font-medium text-slate-700">
              <input
                type="checkbox"
                checked={keepStaffTurn}
                onChange={(e) => setKeepStaffTurn(e.target.checked)}
                className="w-4 h-4 rounded text-teal-600 focus:ring-teal-500/20"
              />
              <span>{t('schedule.adKeepRotation')}</span>
            </label>
          </div>
        </Modal>
      )}

      {/* Modal 7: 重新填写 / 重新签署健康表弹窗 (生成新版本并完整归档历史) */}
      {reFillModalOpen && (
        <Modal
          isOpen={reFillModalOpen}
          onOpenChange={setReFillModalOpen}
          title={
            <div className="flex items-center gap-2 text-purple-900 font-bold">
              <RefreshCw className="w-5 h-5 text-purple-600" />
              <span>{t('schedule.adResignModalTitle')}</span>
            </div>
          }
          size="lg"
          footer={
            <div className="flex justify-between items-center w-full">
              <span className="text-[11px] text-slate-500 font-medium">
                
                {t('schedule.adWillCreatePrefix')} <strong>{t('schedule.adVersionPrefix2')} {healthFormHistory.length + 1}  {t('schedule.adVersionSuffix3')}</strong>  {t('schedule.adRecordSuffix')}
              </span>
              <div className="flex items-center gap-2">
                <Button variant="secondary" onClick={() => setReFillModalOpen(false)}>
                  
                  {t('schedule.adResignCancel')}
                </Button>
                <Button
                  className="bg-purple-600 hover:bg-purple-700 text-white font-bold gap-1.5 shadow-md shadow-purple-600/20"
                  onClick={handleConfirmReFillHealthForm}
                >
                  <Check className="w-4 h-4" />
                  <span>{t('schedule.adResignConfirm')}</span>
                </Button>
              </div>
            </div>
          }
        >
          <div className="space-y-4 py-2 text-xs text-slate-700 max-h-[70vh] overflow-y-auto custom-scrollbar pr-1">
            <div className="p-3 bg-purple-50/70 rounded-2xl border border-purple-200">
              <p className="font-bold text-purple-950 text-xs">
                
                {t('schedule.adRefillingFor', { p0: customerName })}
              </p>
              <p className="text-[11px] text-purple-800 mt-0.5 leading-relaxed">
                
                {t('schedule.adResignNote1')} {healthFormHistory.length}  {t('schedule.adResignNote2')}
              </p>
            </div>

            {/* 1. 身体禁忌与过敏排查 */}
            <div className="space-y-2">
              <label className="block font-bold text-slate-800 text-xs flex items-center justify-between">
                <span>{t('schedule.adFormSection1')}</span>
                <span className="text-[10px] text-slate-400 font-normal">{t('schedule.adFormSection1Hint')}</span>
              </label>
              <div className="grid grid-cols-3 gap-1.5">
                {ALLERGY_TAGS.map((tag) => {
                  const isSelected = reFillFormData.contraindications.includes(tag);
                  return (
                    <button
                      key={tag}
                      type="button"
                      onClick={() => {
                        if (tag === 'No specific contraindications') {
                          setReFillFormData((prev) => ({ ...prev, contraindications: ['No specific contraindications'] }));
                        } else {
                          setReFillFormData((prev) => {
                            const withoutNone = prev.contraindications.filter((x) => x !== 'No specific contraindications');
                            const nextList = isSelected ? withoutNone.filter((x) => x !== tag) : [...withoutNone, tag];
                            return {
                              ...prev,
                              contraindications: nextList.length > 0 ? nextList : ['No specific contraindications'],
                            };
                          });
                        }
                      }}
                      className={cn(
                        'p-2 rounded-xl border text-xs font-bold transition-all text-center',
                        isSelected
                          ? tag === 'No specific contraindications'
                            ? 'border-emerald-500 bg-emerald-50 text-emerald-900 shadow-sm'
                            : 'border-red-400 bg-red-50 text-red-900 shadow-sm ring-1 ring-red-300'
                          : 'border-slate-200 hover:bg-slate-50 text-slate-600',
                      )}
                    >
                      {tag}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* 2. 重点关注与避免触碰部位 */}
            <div className="space-y-3 pt-1">
              <div>
                <label className="block font-bold text-slate-800 text-xs mb-1.5">
                  
                  {t('schedule.adFormSection2')}
                </label>
                <div className="grid grid-cols-4 gap-1.5 text-xs">
                  {[t('schedule.adAreaHeadTemple'), 'Back of Neck', t('schedule.adAreaLeftShoulder'), t('schedule.adAreaRightShoulder'), 'Left Lower Back', 'Right Lower Back', t('schedule.adAreaLeftArch'), t('schedule.adAreaRightArch')].map((area) => {
                    const isSelected = reFillFormData.focusAreas.includes(area);
                    return (
                      <button
                        key={area}
                        type="button"
                        onClick={() => {
                          setReFillFormData((prev) => ({
                            ...prev,
                            focusAreas: isSelected ? prev.focusAreas.filter((x) => x !== area) : [...prev.focusAreas, area],
                          }));
                        }}
                        className={cn(
                          'p-1.5 rounded-xl border text-center font-bold text-[11px] transition-all',
                          isSelected
                            ? 'border-teal-500 bg-teal-50 text-teal-900 shadow-xs'
                            : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50',
                        )}
                      >
                        {area}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div>
                <label className="block font-bold text-slate-800 text-xs mb-1.5">
                  
                  {t('schedule.adFormSection3')}
                </label>
                <div className="grid grid-cols-4 gap-1.5 text-xs">
                  {['No areas to avoid', 'Face', t('schedule.adAvoidChestAbdomen'), 'Spine Midline', t('schedule.adAvoidLumbarInjury'), t('schedule.adAvoidVaricose'), t('schedule.adAvoidBrokenSkin')].map((area) => {
                    const isSelected = reFillFormData.avoidAreas.includes(area);
                    return (
                      <button
                        key={area}
                        type="button"
                        onClick={() => {
                          if (area === 'No areas to avoid') {
                            setReFillFormData((prev) => ({ ...prev, avoidAreas: ['No areas to avoid'] }));
                          } else {
                            setReFillFormData((prev) => {
                              const withoutNone = prev.avoidAreas.filter((x) => x !== 'No areas to avoid');
                              const nextList = isSelected ? withoutNone.filter((x) => x !== area) : [...withoutNone, area];
                              return {
                                ...prev,
                                avoidAreas: nextList.length > 0 ? nextList : ['No areas to avoid'],
                              };
                            });
                          }
                        }}
                        className={cn(
                          'p-1.5 rounded-xl border text-center font-bold text-[11px] transition-all',
                          isSelected
                            ? 'border-red-400 bg-red-50 text-red-900 shadow-xs'
                            : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50',
                        )}
                      >
                        {area}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* 3. 正在服用药物与近期手术 */}
            <div className="grid grid-cols-2 gap-3 pt-1">
              <div>
                <label className="block font-bold text-slate-700 text-[11px] mb-1">
                  
                  {t('schedule.adMedicationLabel')}
                </label>
                <Input
                  value={reFillFormData.medications}
                  onChange={(e) => setReFillFormData((prev) => ({ ...prev, medications: e.target.value }))}
                  placeholder={t('schedule.adMedicationPlaceholder')}
                  className="text-xs"
                />
              </div>

              <div>
                <label className="block font-bold text-slate-700 text-[11px] mb-1">
                  
                  {t('schedule.adSurgeryLabel')}
                </label>
                <Input
                  value={reFillFormData.recentSurgery}
                  onChange={(e) => setReFillFormData((prev) => ({ ...prev, recentSurgery: e.target.value }))}
                  placeholder={t('schedule.adSurgeryPlaceholder')}
                  className="text-xs"
                />
              </div>
            </div>

            {/* 4. 签署人与电子签名确认 */}
            <div className="p-3 bg-slate-50 rounded-2xl border border-slate-200 space-y-2.5 pt-3">
              <label className="flex items-center gap-2 cursor-pointer font-bold text-slate-900 text-xs">
                <input
                  type="checkbox"
                  checked={reFillFormData.consentGiven}
                  onChange={(e) => setReFillFormData((prev) => ({ ...prev, consentGiven: e.target.checked }))}
                  className="w-4 h-4 rounded text-purple-600 focus:ring-purple-500/20"
                />
                <span>{t('schedule.adWaiverAgreement')}</span>
              </label>

              <div className="flex items-center gap-3 pt-1">
                <div className="flex-1">
                  <label className="block font-bold text-slate-700 text-[11px] mb-1">
                    
                    {t('schedule.adSignerLabel2')}
                  </label>
                  <Input
                    value={reFillFormData.signatureName}
                    onChange={(e) => setReFillFormData((prev) => ({ ...prev, signatureName: e.target.value }))}
                    placeholder={t('schedule.adSignerNamePlaceholder', { p0: customerName })}
                    className="text-xs font-bold text-teal-800"
                  />
                </div>
              </div>
            </div>
          </div>
        </Modal>
      )}

      {/* 查看健康表答卷 Modal (支持展示任意选中的历史版本) */}
      {viewingForm && (() => {
        const displayData = selectedViewingSubmission || (submissionQ.data ? {
          id: 'sub-latest',
          version: healthFormHistory.length,
          submittedAt: submissionQ.data.submittedAt || new Date().toISOString(),
          customerName: submissionQ.data.customerName || customerName,
          source: t('schedule.adSignedElectronically'),
          status: 'valid' as const,
          answers: submissionQ.data.answers || [],
          contraindications: selectedAllergies,
          signatureSvg: submissionQ.data.signatureSvg,
        } : healthFormHistory[0]);

        return (
          <Modal
            isOpen={viewingForm}
            onOpenChange={(open) => {
              if (!open) {
                setViewingForm(false);
                setSelectedViewingSubmission(null);
              }
            }}
            title={
              <div className="flex items-center gap-2 text-teal-900 font-bold">
                <FileCheck className="w-5 h-5 text-teal-600" />
                <span>{t('schedule.adArchiveTitlePrefix')} {displayData?.version || 1}  {t('schedule.adArchiveTitleSuffix')}</span>
              </div>
            }
            size="md"
            footer={
              <div className="flex justify-between items-center w-full">
                <span className="text-[10px] text-slate-500 font-mono">
                  
                  {t('schedule.adArchiveNo')} {displayData?.id || 'SUB-DEFAULT'}
                </span>
                <Button variant="secondary" onClick={() => { setViewingForm(false); setSelectedViewingSubmission(null); }}>
                  {t('close')}
                </Button>
              </div>
            }
          >
            <div className="space-y-4 text-xs max-h-[70vh] overflow-y-auto custom-scrollbar pr-1">
              <div className="p-3 bg-slate-50 rounded-2xl border border-slate-200 space-y-1.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-slate-900 text-sm">
                      
                      {t('schedule.adArchiveCustomer')} {displayData?.customerName || customerName}
                    </span>
                    <Badge variant="secondary" className="text-[10px] font-bold px-1.5 py-0">
                      
                      {t('schedule.adVersionPrefix3')} {displayData?.version || 1}  {t('schedule.adArchiveVersionSuffix')}
                    </Badge>
                  </div>
                  <span className="text-[10px] text-slate-500 font-mono">
                    {storeTime.dateTime(displayData?.submittedAt)}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-[11px] text-slate-600">
                  <span>{t('schedule.adSigningChannel')} <strong>{displayData?.source || t('schedule.adSignedOniPad2')}</strong></span>
                </div>
              </div>

              {displayData?.answers && displayData.answers.length > 0 && (
                <div className="space-y-2">
                  <p className="font-bold text-slate-800 uppercase tracking-wider text-[11px]">
                    
                    {t('schedule.adResponsesDetail')}
                  </p>
                  <div className="divide-y divide-slate-100 border border-slate-200 rounded-2xl p-3 bg-white space-y-2 shadow-xs">
                    {displayData.answers.map((ans, i) => (
                      <div key={i} className="pt-2 first:pt-0 space-y-0.5">
                        <p className="font-medium text-slate-700">{ans.question}</p>
                        <p className="text-teal-800 font-bold">{String(ans.answer)}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {displayData?.signatureSvg && (
                <div className="space-y-1.5">
                  <p className="font-bold text-slate-800 uppercase tracking-wider text-[11px]">
                    
                    {t('schedule.adLegalSignature')}
                  </p>
                  <div
                    className="p-4 border-2 border-dashed border-teal-200 rounded-2xl bg-white flex justify-center shadow-xs"
                    dangerouslySetInnerHTML={{ __html: displayData.signatureSvg }}
                  />
                  <p className="text-[10px] text-slate-400 text-center">
                    
                    {t('schedule.adSignatureArchived')}
                  </p>
                </div>
              )}
            </div>
          </Modal>
        );
      })()}

      {/* 二维码点击放大 Modal */}
      {qrZoomModal && (
        <QRCodeZoomModal
          isOpen={qrZoomModal.isOpen}
          onClose={() => setQrZoomModal(null)}
          url={qrZoomModal.url}
          customerName={qrZoomModal.customerName}
          phone={qrZoomModal.phone}
          serviceName={qrZoomModal.serviceName}
        />
      )}
    </div>
  );
}
