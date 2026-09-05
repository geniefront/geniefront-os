import { useState, useMemo } from 'react';
import { toast, Spinner } from '@heroui/react';
import { Card, CardContent } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/Tabs';
import { EmptyState } from '@/components/ui/EmptyState';
import { useLanguage } from '@/LanguageContext';
import { fuzzySearch } from '@/lib/fuzzySearch';
import { useErrorMessage } from '@/lib/errorMessage';
import { formatPhoneDisplay } from '@/lib/utils';
import { dollarsToCents, centsToDollars } from '@/features/checkout/api';
import { formatValidityPeriod, giftCardStatusKey } from '@/lib/deskCopy';
import {
  Plus,
  Tag,
  TrendingUp,
  Users,
  Gift,
  Star,
  Ticket,
  Trash2,
  Edit2,
  Search,
  CheckCircle2,
  AlertCircle,
  RefreshCw,
  Zap,
  Sparkles,
  Flame,
  Send,
  MessageSquare,
  Crown,
  Percent,
  Clock,
  ArrowRight,
  ShieldCheck,
  HeartHandshake,
  Cake,
  Copy,
  Receipt,
  QrCode,
  ShieldAlert,
  Coins,
  Check,
} from 'lucide-react';
import {
  usePackagesQuery,
  useCouponsQuery,
  useLoyaltyQuery,
  useGiftCardsQuery,
  useSavePackageTemplate,
  useIssuePackage,
  useRedeemPackage,
  useSaveCouponTemplate,
  useVoidCoupon,
  useSaveLoyaltyRules,
  useAdjustLoyaltyPoints,
  useIssueGiftCard,
  useAdjustGiftCard,
} from '@/features/marketing/api';
import type {
  PackageTemplateView,
  CouponTemplateView,
  GiftCardView,
  CustomerPackageView,
} from '@/features/marketing/types';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { PageLoading, PageError } from '@/components/ui/QueryState';

import type { TranslationKey } from '@/i18n';

// 自动化营销预设剧本
interface AutomatedPlaybook {
  id: string;
  nameKey: TranslationKey;
  categoryKey: TranslationKey;
  icon: any;
  triggerKey: TranslationKey;
  rewardKey: TranslationKey;
  messageTemplate: string;
  enabled: boolean;
  totalSent: number;
  conversionRate: number;
}

const DEFAULT_PLAYBOOKS: AutomatedPlaybook[] = [
  {
    id: 'birthday',
    nameKey: 'playbookBirthdayName',
    categoryKey: 'playbookBirthdayCategory',
    icon: Cake,
    triggerKey: 'playbookBirthdayTrigger',
    rewardKey: 'playbookBirthdayReward',
    messageTemplate:
      '【GenieFront】Dear {customer_name}, Happy Birthday! Enjoy 20% off all treatments and a special gift during your birthday month.',
    enabled: true,
    totalSent: 142,
    conversionRate: 38.5,
  },
  {
    id: 'winback',
    nameKey: 'playbookWinbackName',
    categoryKey: 'playbookWinbackCategory',
    icon: HeartHandshake,
    triggerKey: 'playbookWinbackTrigger',
    rewardKey: 'playbookWinbackReward',
    messageTemplate:
      '【GenieFront】Dear {customer_name}, we miss you! Enjoy a special $20 voucher on your next self-care visit.',
    enabled: true,
    totalSent: 89,
    conversionRate: 24.7,
  },
  {
    id: 'review',
    nameKey: 'playbookReviewName',
    categoryKey: 'playbookReviewCategory',
    icon: Star,
    triggerKey: 'playbookReviewTrigger',
    rewardKey: 'playbookReviewReward',
    messageTemplate:
      '【GenieFront】Thank you for visiting today! Review us to receive 100 loyalty points and a $10 next-visit voucher.',
    enabled: true,
    totalSent: 318,
    conversionRate: 52.1,
  },
  {
    id: 'seasonal',
    nameKey: 'playbookSeasonalName',
    categoryKey: 'playbookSeasonalCategory',
    icon: Sparkles,
    triggerKey: 'playbookSeasonalTrigger',
    rewardKey: 'playbookSeasonalReward',
    messageTemplate:
      '【GenieFront】Seasonal Special: Enjoy $30 off our signature Hand & Foot Spa package this week!',
    enabled: false,
    totalSent: 560,
    conversionRate: 19.3,
  },
];

// VIP 等级权益配置定义
const VIP_TIER_PERKS: { tier: number; nameKey: TranslationKey; discountPercent: number; spend: string; points: string }[] = [
  { tier: 1, nameKey: 'vipTierSilver', discountPercent: 5, spend: '$300', points: '1.0x' },
  { tier: 2, nameKey: 'vipTierGold', discountPercent: 10, spend: '$800', points: '1.2x' },
  { tier: 3, nameKey: 'vipTierPlatinum', discountPercent: 15, spend: '$1,500', points: '1.5x' },
  { tier: 4, nameKey: 'vipTierDiamond', discountPercent: 20, spend: '$3,000', points: '2.0x' },
  { tier: 5, nameKey: 'vipTierBlackDiamond', discountPercent: 25, spend: '$5,000+', points: '3.0x' },
];

function MarketingContent() {
  const errorMessage = useErrorMessage();
  const { t } = useLanguage();
  const [activeTab, setActiveTab] = useState('packages');

  // Queries
  const packagesQ = usePackagesQuery();
  const couponsQ = useCouponsQuery();
  const loyaltyQ = useLoyaltyQuery();
  const [giftCardSearch, setGiftCardSearch] = useState('');
  const [loyaltySearch, setLoyaltySearch] = useState('');
  const [couponSearch, setCouponSearch] = useState('');
  const [pkgSearch, setPkgSearch] = useState('');
  const giftCardsQ = useGiftCardsQuery();

  const rawPackages = packagesQ.data?.templates ?? [];
  const userPackages = packagesQ.data?.userPackages ?? [];
  const rawCoupons = couponsQ.data?.coupons ?? [];
  const rawGiftCards = giftCardsQ.data?.giftCards ?? giftCardsQ.data?.rows ?? [];
  const rules = loyaltyQ.data?.rules;
  const rawCustomers = loyaltyQ.data?.customers ?? [];

  const isInitialLoading = (packagesQ.isLoading || couponsQ.isLoading || loyaltyQ.isLoading) && !packagesQ.data && !couponsQ.data;

  // 容错模糊搜索过滤
  const packages = useMemo(() => {
    if (!pkgSearch.trim()) return rawPackages;
    return fuzzySearch(rawPackages, pkgSearch, {
      keys: ['name'],
      threshold: 0.45,
    });
  }, [rawPackages, pkgSearch]);

  const coupons = useMemo(() => {
    if (!couponSearch.trim()) return rawCoupons;
    return fuzzySearch(rawCoupons, couponSearch, {
      keys: ['name', 'code'],
      threshold: 0.45,
    });
  }, [rawCoupons, couponSearch]);

  const giftCards = useMemo(() => {
    if (!giftCardSearch.trim()) return rawGiftCards;
    return fuzzySearch(rawGiftCards, giftCardSearch, {
      keys: ['code', 'recipientName', 'purchaserName'],
      threshold: 0.45,
    });
  }, [rawGiftCards, giftCardSearch]);

  const customers = useMemo(() => {
    if (!loyaltySearch.trim()) return rawCustomers;
    return fuzzySearch(rawCustomers, loyaltySearch, {
      keys: ['customerName', 'phone'],
      threshold: 0.45,
    });
  }, [rawCustomers, loyaltySearch]);

  // Mutations
  const savePackageMut = useSavePackageTemplate();
  const issuePackageMut = useIssuePackage();
  const redeemPackageMut = useRedeemPackage();
  const saveCouponMut = useSaveCouponTemplate();
  const voidCouponMut = useVoidCoupon();
  const saveLoyaltyMut = useSaveLoyaltyRules();
  const adjustLoyaltyMut = useAdjustLoyaltyPoints();
  const issueGiftCardMut = useIssueGiftCard();
  const adjustGiftCardMut = useAdjustGiftCard();

  // 自动化营销剧本列表
  const [playbooks, setPlaybooks] = useState<AutomatedPlaybook[]>(DEFAULT_PLAYBOOKS);

  // 通用二次确认弹窗
  const [confirmModal, setConfirmModal] = useState<{
    title: string;
    description: string;
    confirmText?: string;
    confirmTone?: 'primary' | 'danger' | 'warning' | 'emerald';
    onConfirm: () => Promise<void> | void;
  } | null>(null);
  const [confirmPending, setConfirmPending] = useState(false);

  // 1. 新建/编辑次卡套餐 Modal
  const [packageModalOpen, setPackageModalOpen] = useState(false);
  const [pkgName, setPkgName] = useState('');
  const [pkgPrice, setPkgPrice] = useState('120.00');
  const [pkgUnits, setPkgUnits] = useState('5');
  const [pkgValidDays, setPkgValidDays] = useState('365');
  const [pkgServiceIds, setPkgServiceIds] = useState<string[]>([]);

  // 2. 发售次卡给指定顾客 Modal
  const [issuePackageModalOpen, setIssuePackageModalOpen] = useState(false);
  const [issueTargetPkg, setIssueTargetPkg] = useState<PackageTemplateView | null>(null);
  const [issueCustomerName, setIssueCustomerName] = useState('');
  const [issueCustomerPhone, setIssueCustomerPhone] = useState('');
  const [issueOverridePrice, setIssueOverridePrice] = useState('');

  // 3. 创建优惠券 Modal
  const [couponModalOpen, setCouponModalOpen] = useState(false);
  const [cpnCode, setCpnCode] = useState('');
  const [cpnName, setCpnName] = useState('');
  const [cpnKind, setCpnKind] = useState<'amount' | 'percent'>('amount');
  const [cpnValue, setCpnValue] = useState('15.00');
  const [cpnMinSpend, setCpnMinSpend] = useState('60.00');
  const [cpnValidDays, setCpnValidDays] = useState('30');

  // 4. 发售Gift Card Modal
  const [giftModalOpen, setGiftModalOpen] = useState(false);
  const [gcFaceValue, setGcFaceValue] = useState('100.00');
  const [gcSalePrice, setGcSalePrice] = useState('100.00');
  const [gcRecipient, setGcRecipient] = useState('');
  const [gcPurchaser, setGcPurchaser] = useState('');

  // 5. 积分规则 Modal
  const [loyaltyModalOpen, setLoyaltyModalOpen] = useState(false);
  const [earnRate, setEarnRate] = useState('100'); // basis points (100 = 1%)
  const [redeemRate, setRedeemRate] = useState('500'); // 100 pts = $5
  const [minRedeem, setMinRedeem] = useState('100');

  // 6. 手动调整顾客积分 Modal
  const [adjustPointsModalOpen, setAdjustPointsModalOpen] = useState(false);
  const [adjustTargetCustomer, setAdjustTargetCustomer] = useState<{ id: string; name: string; current: number } | null>(null);
  const [adjustDelta, setAdjustDelta] = useState('100');
  const [adjustReason, setAdjustReason] = useState(() => t('crm.mktAdjustReasonDefault'));

  // 7. 发起即时群发活动 Modal
  const [campaignModalOpen, setCampaignModalOpen] = useState(false);
  const [campaignTargetPlaybook, setCampaignTargetPlaybook] = useState<AutomatedPlaybook | null>(null);
  const [campaignCustomText, setCampaignCustomText] = useState('');

  // 计算顶部营销罗盘数据
  const metrics = useMemo(() => {
    const totalPkgRevenue = packages.reduce((sum, p) => sum + p.priceCents, 0) / 100;
    const totalGcPool = giftCards.reduce((sum, g) => sum + g.balanceCents, 0) / 100;
    const activeCouponsCount = coupons.filter((c) => c.active).length;
    const totalPointsAwarded = customers.reduce((sum, c) => sum + c.lifetimePoints, 0);
    const totalSmsSent = playbooks.reduce((sum, p) => sum + p.totalSent, 0);

    return {
      totalPkgRevenue,
      totalGcPool,
      activeCouponsCount,
      totalPointsAwarded,
      totalSmsSent,
    };
  }, [packages, giftCards, coupons, customers, playbooks]);

  // 1. 创建次卡套餐
  const handleCreatePackage = async () => {
    if (!pkgName.trim()) {
      toast.danger(t('crm.mktPackageNameRequired'));
      return;
    }
    if (pkgServiceIds.length === 0) {
      toast.danger(t('crm.mktPkgServicesRequired'));
      return;
    }
    try {
      await savePackageMut.mutateAsync({
        name: pkgName.trim(),
        priceCents: dollarsToCents(pkgPrice),
        serviceIds: pkgServiceIds,
        sessions: parseInt(pkgUnits, 10) || 5,
        validDays: parseInt(pkgValidDays, 10) || 365,
      });
      toast.success(t('crm.mktPackagePublished'));
      setPackageModalOpen(false);
      setPkgName('');
      setPkgServiceIds([]);
    } catch (err: any) {
      toast.danger(errorMessage(err));
    }
  };

  // 2. 发售次卡给顾客
  const handleConfirmIssuePackage = async () => {
    if (!issueTargetPkg || !issueCustomerName.trim()) {
      toast.danger(t('crm.mktBuyerNameRequired'));
      return;
    }
    try {
      await issuePackageMut.mutateAsync({
        templateId: issueTargetPkg.id,
        // 后端按「同名同号」解析真实客户：给了手机号才可能复用老客户，
        // 否则每次新建一条，事后由前台用 customer.merge 收口。
        customer: {
          name: issueCustomerName.trim(),
          phoneE164: issueCustomerPhone.trim() || undefined,
        },
        soldPriceCentsOverride: issueOverridePrice.trim()
          ? dollarsToCents(issueOverridePrice)
          : undefined,
      });
      toast.success(t('crm.mktPackageSold', { p0: issueCustomerName.trim(), p1: issueTargetPkg.name }));
      setIssuePackageModalOpen(false);
      setIssueCustomerName('');
      setIssueCustomerPhone('');
      setIssueOverridePrice('');
    } catch (err: any) {
      toast.danger(errorMessage(err));
    }
  };

  // 3. 次卡核销一次 (带二次确认)
  const handleRedeemUnitWithConfirm = (up: CustomerPackageView) => {
    setConfirmModal({
      title: t('crm.mktRedeemConfirmTitle', { p0: up.customerName }),
      description: t('crm.mktRedeemConfirmDesc', { p0: up.customerName, p1: up.templateName, p2: up.remainingUnits - 1, p3: up.totalUnits }),
      confirmText: t('crm.mktRedeemConfirmButton'),
      confirmTone: 'emerald',
      onConfirm: async () => {
        try {
          await redeemPackageMut.mutateAsync({
            customerPackageId: up.id,
            units: 1,
          });
          toast.success(t('crm.mktPackageRedeemed', { p0: up.templateName }));
        } catch (err: any) {
          toast.danger(errorMessage(err));
        }
      },
    });
  };

  // 4. 创建优惠券
  const handleCreateCoupon = async () => {
    if (!cpnCode.trim() || !cpnName.trim()) {
      toast.danger(t('crm.mktCouponFieldsRequired'));
      return;
    }
    try {
      await saveCouponMut.mutateAsync({
        code: cpnCode.trim().toUpperCase(),
        name: cpnName.trim(),
        kind: cpnKind,
        discountAmountCents: cpnKind === 'amount' ? dollarsToCents(cpnValue) : undefined,
        discountPercentBp:
          cpnKind === 'percent' ? Math.round(parseFloat(cpnValue) * 100) : undefined,
        minSpendCents: dollarsToCents(cpnMinSpend),
        validDays: parseInt(cpnValidDays, 10) || 30,
      });
      toast.success(t('crm.mktCouponPublished'));
      setCouponModalOpen(false);
      setCpnCode('');
      setCpnName('');
    } catch (err: any) {
      toast.danger(errorMessage(err));
    }
  };

  // 5. 作废优惠券 (带二次确认)
  const handleVoidCouponWithConfirm = (cpn: CouponTemplateView) => {
    setConfirmModal({
      title: t('crm.mktVoidCouponConfirmTitle', { p0: cpn.name }),
      description: t('crm.mktVoidCouponConfirmDesc', { p0: cpn.code }),
      confirmText: t('crm.mktVoidCouponConfirmButton'),
      confirmTone: 'danger',
      onConfirm: async () => {
        try {
          await voidCouponMut.mutateAsync({ couponId: cpn.id });
          toast.success(t('crm.mktCouponVoided', { p0: cpn.name }));
        } catch (err: any) {
          toast.danger(errorMessage(err));
        }
      },
    });
  };

  // 6. 发售Gift Card
  const handleCreateGiftCard = async () => {
    try {
      const res = await issueGiftCardMut.mutateAsync({
        faceValueCents: dollarsToCents(gcFaceValue),
        salePriceCents: dollarsToCents(gcSalePrice),
        recipientName: gcRecipient.trim() || undefined,
        recipientNote: gcPurchaser.trim() ? t('crm.mktGiftCardPurchaserNote', { p0: gcPurchaser.trim() }) : undefined,
      });
      await giftCardsQ.refetch();
      toast.success(t('crm.mktGiftCardIssued', { p0: res?.code || 'GC-88992' }));
      setGiftModalOpen(false);
      setGcRecipient('');
      setGcPurchaser('');
    } catch (err: any) {
      toast.danger(errorMessage(err));
    }
  };

  // 7. 保存积分规则
  const handleSaveLoyalty = async () => {
    try {
      await saveLoyaltyMut.mutateAsync({
        earnRateBp: parseInt(earnRate, 10) || 100,
        redeemRateBp: parseInt(redeemRate, 10) || 500,
        minRedeemPoints: parseInt(minRedeem, 10) || 100,
      });
      toast.success(t('crm.mktPointsRulesSaved'));
      setLoyaltyModalOpen(false);
    } catch (err: any) {
      toast.danger(errorMessage(err));
    }
  };

  // 8. 调整顾客积分
  const handleConfirmAdjustPoints = async () => {
    if (!adjustTargetCustomer) return;
    const delta = parseInt(adjustDelta, 10) || 0;
    try {
      await adjustLoyaltyMut.mutateAsync({
        customerId: adjustTargetCustomer.id,
        pointsDelta: delta,
        reason: adjustReason.trim() || t('crm.mktAdjustReasonManual'),
      });
      toast.success(t('crm.mktPointsAdjusted', {
        p0: adjustTargetCustomer.name,
        p1: delta >= 0 ? t('crm.mktPointsAdded', { p0: delta }) : t('crm.mktPointsDeducted', { p0: Math.abs(delta) }),
      }));
      setAdjustPointsModalOpen(false);
    } catch (err: any) {
      toast.danger(errorMessage(err));
    }
  };

  // 9. 切换自动化剧本开关
  const handleTogglePlaybook = (id: string) => {
    setPlaybooks((prev) =>
      prev.map((pb) => {
        if (pb.id === id) {
          const next = !pb.enabled;
          toast.success(`${t(pb.nameKey)}: ${next ? 'Active' : 'Paused'}`);
          return { ...pb, enabled: next };
        }
        return pb;
      }),
    );
  };

  // 10. 发起即时群发
  const handleSendCampaign = () => {
    if (!campaignTargetPlaybook) return;
    toast.info(t('email.comingSoon'));
    setCampaignModalOpen(false);
  };

  // 复制优惠券码
  const handleCopyCode = (code: string) => {
    navigator.clipboard.writeText(code);
    toast.success(t('crm.mktCodeCopied', { p0: code }));
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

  if (isInitialLoading) {
    return <PageLoading title={t('crm.mktLoading')} description={t('crm.mktLoadingDesc')} />;
  }

  if ((packagesQ.isError || couponsQ.isError) && !packagesQ.data && !couponsQ.data) {
    return (
      <PageError
        title={t('crm.mktLoadError')}
        error={packagesQ.error || couponsQ.error}
        onRetry={() => {
          void packagesQ.refetch();
          void couponsQ.refetch();
          void loyaltyQ.refetch();
          void giftCardsQ.refetch();
        }}
      />
    );
  }

  return (
    <div className="space-y-6 max-w-7xl mx-auto w-full pb-20">
      {/* 1. Page Header */}
      <PageHeader
        title={t('marketingTitle') || t('crm.mktTitle')}
        description={
          t('marketingSubtitle') ||
          t('crm.mktDesc')
        }
        actions={
          <div className="flex items-center gap-2">
            {activeTab === 'packages' && (
              <Button
                className="bg-teal-600 hover:bg-teal-700 text-white gap-1.5 font-bold text-xs shadow-xs"
                size="sm"
                onClick={() => setPackageModalOpen(true)}
              >
                <Plus className="w-4 h-4" />
                <span>{t('crm.mktNewPackage')}</span>
              </Button>
            )}
            {activeTab === 'coupons' && (
              <Button
                className="bg-teal-600 hover:bg-teal-700 text-white gap-1.5 font-bold text-xs shadow-xs"
                size="sm"
                onClick={() => setCouponModalOpen(true)}
              >
                <Plus className="w-4 h-4" />
                <span>{t('crm.mktNewCoupon')}</span>
              </Button>
            )}
            {activeTab === 'giftcards' && (
              <Button
                className="bg-teal-600 hover:bg-teal-700 text-white gap-1.5 font-bold text-xs shadow-xs"
                size="sm"
                onClick={() => setGiftModalOpen(true)}
              >
                <Plus className="w-4 h-4" />
                <span>{t('crm.mktSellGiftCard')}</span>
              </Button>
            )}
            {activeTab === 'loyalty' && (
              <Button
                className="bg-teal-600 hover:bg-teal-700 text-white gap-1.5 font-bold text-xs shadow-xs"
                size="sm"
                onClick={() => {
                  if (rules) {
                    setEarnRate(String(rules.earnRateBp));
                    setRedeemRate(String(rules.redeemRateBp));
                    setMinRedeem(String(rules.minRedeemPoints));
                  }
                  setLoyaltyModalOpen(true);
                }}
              >
                <Edit2 className="w-3.5 h-3.5" />
                <span>{t('crm.mktConfigurePoints')}</span>
              </Button>
            )}
            {activeTab === 'automation' && (
              <Button
                className="bg-indigo-600 hover:bg-indigo-700 text-white gap-1.5 font-bold text-xs shadow-xs"
                size="sm"
                onClick={() => {
                  setCampaignTargetPlaybook(playbooks[3] || playbooks[0]!);
                  setCampaignCustomText(playbooks[3]?.messageTemplate || '');
                  toast.info(t('email.comingSoon'));
                }}
              >
                <Send className="w-3.5 h-3.5" />
                <span>{t('crm.mktStartCampaign')}</span>
              </Button>
            )}
          </div>
        }
      />

      {/* 2. Top Growth & Revenue KPI Compass Dashboard (High Density) */}
      <div className="bg-white p-2.5 rounded-2xl border border-slate-200 shadow-xs flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 flex-wrap">
          <div className="flex items-center gap-1.5 px-3 py-1 rounded-xl bg-teal-50 border border-teal-200 text-xs font-bold text-teal-950">
            <Ticket className="w-3.5 h-3.5 text-teal-600" />
            <span>{t('crm.mktPackageValue')}</span>
            <strong className="font-mono text-sm ml-0.5">${metrics.totalPkgRevenue.toFixed(2)}</strong>
          </div>

          <div className="flex items-center gap-1.5 px-3 py-1 rounded-xl bg-emerald-50 border border-emerald-200 text-xs font-bold text-emerald-950">
            <Gift className="w-3.5 h-3.5 text-emerald-600" />
            <span>{t('crm.mktGiftCardPool')}</span>
            <strong className="font-mono text-sm ml-0.5">${metrics.totalGcPool.toFixed(2)}</strong>
          </div>

          <div className="flex items-center gap-1.5 px-3 py-1 rounded-xl bg-amber-50 border border-amber-200 text-xs font-bold text-amber-950">
            <Tag className="w-3.5 h-3.5 text-amber-600" />
            <span>{t('crm.mktActiveCampaigns')}</span>
            <strong className="font-mono text-sm ml-0.5">{metrics.activeCouponsCount}  {t('crm.mktCampaignUnit')}</strong>
          </div>

          <div className="flex items-center gap-1.5 px-3 py-1 rounded-xl bg-purple-50 border border-purple-200 text-xs font-bold text-purple-950">
            <Star className="w-3.5 h-3.5 text-purple-600" />
            <span>{t('crm.mktPointsIssued')}</span>
            <strong className="font-mono text-sm ml-0.5">{metrics.totalPointsAwarded} pts</strong>
          </div>
        </div>

        <div className="flex items-center gap-1.5 px-3 py-1 rounded-xl bg-indigo-50 border border-indigo-200 text-xs font-bold text-indigo-950 shrink-0">
          <Zap className="w-3.5 h-3.5 text-indigo-600" />
          <span>{t('crm.mktAutomationReach')}</span>
          <strong className="font-mono text-sm ml-0.5">{metrics.totalSmsSent}  {t('crm.mktReachUnit')}</strong>
        </div>
      </div>

      {/* 3. Five Core Marketing Pillars Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
        <TabsList className="w-full bg-white p-1 rounded-2xl border border-slate-200 shadow-xs grid grid-cols-2 sm:grid-cols-5 gap-1">
          <TabsTrigger value="packages" className="py-2.5 rounded-xl text-xs font-bold gap-1.5">
            <Ticket className="w-4 h-4" />
            <span>{t('crm.mktTabPackages')}</span>
          </TabsTrigger>
          <TabsTrigger value="coupons" className="py-2.5 rounded-xl text-xs font-bold gap-1.5">
            <Tag className="w-4 h-4" />
            <span>{t('crm.mktTabCoupons')}</span>
          </TabsTrigger>
          <TabsTrigger value="giftcards" className="py-2.5 rounded-xl text-xs font-bold gap-1.5">
            <Gift className="w-4 h-4" />
            <span>{t('crm.mktTabGiftCards')}</span>
          </TabsTrigger>
          <TabsTrigger value="loyalty" className="py-2.5 rounded-xl text-xs font-bold gap-1.5">
            <Star className="w-4 h-4" />
            <span>{t('crm.mktTabPoints')}</span>
          </TabsTrigger>
          <TabsTrigger value="automation" className="py-2.5 rounded-xl text-xs font-bold gap-1.5">
            <Zap className="w-4 h-4" />
            <span>{t('crm.mktTabAutomation')}</span>
          </TabsTrigger>
        </TabsList>

        {/* ── Tab 1: 次卡套餐与周期卡 ── */}
        <TabsContent value="packages" className="space-y-6 pt-4">
          <div className="space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs font-bold text-slate-700">
              <span>{t('crm.mktPackageTemplates')}{packages.length})</span>
              <div className="relative w-full sm:w-56">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-2.5" />
                <input
                  type="text"
                  value={pkgSearch}
                  onChange={(e) => setPkgSearch(e.target.value)}
                  placeholder={t('crm.mktPackageSearch')}
                  className="w-full h-8 pl-8 pr-2.5 rounded-xl border border-slate-200 bg-white text-xs placeholder:text-slate-400 focus:outline-none focus:border-teal-500 transition-all"
                />
              </div>
            </div>

            {packagesQ.isLoading ? (
              <div className="py-12 grid place-items-center">
                <Spinner />
              </div>
            ) : packages.length === 0 ? (
              <EmptyState
                icon={<Ticket className="w-10 h-10 text-slate-300" />}
                title={t('crm.mktNoPackages')}
                description={t('crm.mktNoPackagesDesc')}
                action={
                  <Button
                    onClick={() => setPackageModalOpen(true)}
                    className="bg-teal-600 text-white font-bold"
                  >
                    
                    {t('crm.mktCreateFirst')}
                  </Button>
                }
              />
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {packages.map((pkg) => {
                  // 折算单价在整数分上计算后再格式化 —— 先转美元浮点再除会引入无法对账的尾差
                  const unitPrice = pkg.totalUnits > 0
                    ? centsToDollars(Math.round(pkg.priceCents / pkg.totalUnits))
                    : null;
                  return (
                    <Card
                      key={pkg.id}
                      className="border-2 border-slate-200 hover:border-teal-400 transition-all rounded-2xl overflow-hidden shadow-xs hover:shadow-md flex flex-col justify-between"
                    >
                      <CardContent className="p-4.5 space-y-3">
                        <div className="flex justify-between items-start">
                          <div>
                            <h3 className="font-extrabold text-slate-900 text-base leading-snug">
                              {pkg.name}
                            </h3>
                            <p className="text-xs text-slate-500 mt-1">
                              
                              {t('crm.mktIncludesPrefix')} <strong>{pkg.totalUnits}</strong>  {t('crm.mktSessionsValidFor')} {formatValidityPeriod(pkg.validDays, t('crm.mktForever'), (days) => `${days} ${t('crm.mktDaysUnit')}`)}
                            </p>
                            <p className="text-[11px] text-slate-600 mt-1.5">
                              {(pkg.serviceNames?.length ? pkg.serviceNames : [pkg.serviceName]).join(' + ')}
                            </p>
                          </div>
                          <Badge className="bg-teal-100 text-teal-900 border-teal-300 font-black text-sm px-2.5 py-0.5">
                            ${centsToDollars(pkg.priceCents)}
                          </Badge>
                        </div>

                        <div className="p-2.5 rounded-xl bg-slate-50 border border-slate-100 flex items-center justify-between text-xs">
                          <span className="text-slate-500">{t('crm.mktPerSessionPrice')}</span>
                          <span className="font-bold text-teal-700 font-mono">
                            {unitPrice === null ? t('crm.mktForever') : `$${unitPrice} ${t('crm.mktPerSession')}`}
                          </span>
                        </div>
                        {pkg.savingsCents != null && pkg.savingsCents > 0 && (
                          <div className="flex items-center justify-between text-[11px]">
                            <span className="text-slate-500">
                              {t('crm.mktPkgCatalogValue')} ${centsToDollars(pkg.catalogValueCents ?? 0)}
                            </span>
                            <span className="font-bold text-emerald-700">
                              {t('crm.mktPkgSavings')} ${centsToDollars(pkg.savingsCents)}
                            </span>
                          </div>
                        )}
                      </CardContent>

                      <div className="p-3 bg-slate-50/80 border-t border-slate-100 flex items-center justify-between">
                        <Badge
                          className={
                            pkg.active
                              ? 'bg-emerald-100 text-emerald-800'
                              : 'bg-slate-100 text-slate-500'
                          }
                        >
                          {pkg.active ? t('crm.mktOnSale') : t('crm.mktWithdrawn')}
                        </Badge>
                        <Button
                          size="sm"
                          className="bg-teal-600 hover:bg-teal-700 text-white font-bold text-xs h-7 gap-1"
                          disabled={!pkg.active}
                          onClick={() => {
                            setIssueTargetPkg(pkg);
                            setIssueCustomerName('');
                            setIssueCustomerPhone('');
                            setIssueOverridePrice(centsToDollars(pkg.priceCents));
                            setIssuePackageModalOpen(true);
                          }}
                        >
                          <Send className="w-3 h-3" />
                          <span>{t('crm.mktSellToCustomer')}</span>
                        </Button>
                      </div>
                    </Card>
                  );
                })}
              </div>
            )}
          </div>

          {/* 顾客已购次卡与核销流水 */}
          <div className="space-y-3 pt-4 border-t border-slate-200">
            <div className="flex justify-between items-center text-xs font-bold text-slate-700">
              <span>{t('crm.mktPurchasedPackages')}{userPackages.length})</span>
            </div>

            {userPackages.length === 0 ? (
              <div className="p-8 text-center text-slate-400 bg-white rounded-2xl border border-slate-200 text-xs">
                
                {t('crm.mktNoPurchased')}
              </div>
            ) : (
              <div className="divide-y divide-slate-100 bg-white rounded-2xl border border-slate-200 overflow-hidden">
                {userPackages.map((up) => (
                  <div
                    key={up.id}
                    className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 hover:bg-slate-50/80 transition-colors text-xs"
                  >
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <strong className="text-slate-900 text-sm font-bold">
                          {up.customerName}
                        </strong>
                        <Badge className="bg-teal-50 text-teal-800 border-teal-200">
                          {up.templateName}
                        </Badge>
                      </div>
                      <p className="text-slate-500 text-[11px]">
                        
                        {t('crm.mktPurchasedOn')} {up.createdAt.slice(0, 10)}  {t('crm.mktValidUntil')} {up.expiresAt ? up.expiresAt.slice(0, 10) : t('crm.mktForever2')}
                      </p>
                      <p className="text-slate-600 text-[11px]">
                        {(up.serviceNames?.length ? up.serviceNames : [up.serviceName]).join(' + ')}
                      </p>
                    </div>

                    <div className="flex items-center gap-4 justify-between sm:justify-end">
                      <div className="text-right">
                        <span className="font-extrabold text-teal-700 font-mono text-sm">
                          
                          {t('crm.mktRemainingPrefix')} {up.remainingUnits} / {up.totalUnits}  {t('crm.mktSessionUnit')}
                        </span>
                        <div className="w-24 h-1.5 bg-slate-200 rounded-full overflow-hidden mt-1">
                          <div
                            className="h-full bg-teal-600 rounded-full"
                            style={{
                              width: `${up.totalUnits === 0 ? 100 : Math.round((up.remainingUnits / up.totalUnits) * 100)}%`,
                            }}
                          />
                        </div>
                      </div>

                      <Button
                        size="sm"
                        variant="secondary"
                        className="text-xs font-bold text-emerald-800 border-emerald-300 hover:bg-emerald-50 h-8"
                        onClick={() => handleRedeemUnitWithConfirm(up)}
                        disabled={up.remainingUnits <= 0}
                      >
                        <CheckCircle2 className="w-3.5 h-3.5 mr-1 text-emerald-600" />
                        <span>{t('crm.mktRedeemOne')}</span>
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </TabsContent>

        {/* ── Tab 2: 优惠券与折扣活动 ── */}
        <TabsContent value="coupons" className="space-y-4 pt-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs font-bold text-slate-700">
            <span>{t('crm.mktCouponsTitle')}{coupons.length})</span>
            <div className="relative w-full sm:w-56">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-2.5" />
              <input
                type="text"
                value={couponSearch}
                onChange={(e) => setCouponSearch(e.target.value)}
                placeholder={t('crm.mktCouponSearch')}
                className="w-full h-8 pl-8 pr-2.5 rounded-xl border border-slate-200 bg-white text-xs placeholder:text-slate-400 focus:outline-none focus:border-teal-500 transition-all"
              />
            </div>
          </div>

          {couponsQ.isLoading ? (
            <div className="py-12 grid place-items-center">
              <Spinner />
            </div>
          ) : coupons.length === 0 ? (
            <EmptyState
              icon={<Tag className="w-10 h-10 text-slate-300" />}
              title={t('crm.mktNoCoupons')}
              description={t('crm.mktNoCouponsDesc')}
              action={
                <Button
                  onClick={() => setCouponModalOpen(true)}
                  className="bg-teal-600 text-white font-bold"
                >
                  
                  {t('crm.mktPublishCoupon')}
                </Button>
              }
            />
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {coupons.map((cpn) => (
                <Card
                  key={cpn.id}
                  className="border-2 border-slate-200 hover:border-amber-400 transition-all rounded-2xl overflow-hidden shadow-xs flex flex-col justify-between"
                >
                  <CardContent className="p-4.5 space-y-3">
                    <div className="flex justify-between items-start gap-2">
                      <div>
                        <div className="flex items-center gap-1.5">
                          <button
                            onClick={() => handleCopyCode(cpn.code)}
                            className="font-mono font-black text-amber-950 bg-amber-100 hover:bg-amber-200 px-2 py-0.5 rounded text-sm tracking-wider flex items-center gap-1 transition-colors"
                            title={t('crm.mktCopyCode')}
                          >
                            <span>{cpn.code}</span>
                            <Copy className="w-3 h-3 text-amber-700" />
                          </button>
                        </div>
                        <h3 className="font-bold text-slate-800 text-sm mt-1.5">{cpn.name}</h3>
                      </div>
                      <span className="text-xl font-black text-amber-600">
                        {cpn.kind === 'amount'
                          ? `-$${centsToDollars(cpn.discountCents)}`
                          : `${(cpn.percentBp ?? 0) / 100}% OFF`}
                      </span>
                    </div>

                    <div className="text-xs text-slate-500 space-y-1 bg-slate-50 p-2.5 rounded-xl border border-slate-100">
                      <p>
                        
                        {t('crm.mktThresholdPrefix')} <strong>${centsToDollars(cpn.minSpendCents)}</strong>  {t('crm.mktThresholdSuffix')}
                      </p>
                      <p>{t('crm.mktValidityPrefix')} {cpn.validDays ?? 30}  {t('crm.mktValiditySuffix')}</p>
                    </div>
                  </CardContent>

                  <div className="p-3 bg-slate-50/80 border-t border-slate-100 flex items-center justify-between text-xs">
                    <Badge
                      className={
                        cpn.active
                          ? 'bg-emerald-100 text-emerald-800'
                          : 'bg-slate-100 text-slate-500'
                      }
                    >
                      {cpn.active ? t('crm.mktCouponActive') : '⚪ Voided'}
                    </Badge>
                    {cpn.active && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-red-600 hover:bg-red-50 text-xs h-7 gap-1 font-bold"
                        onClick={() => handleVoidCouponWithConfirm(cpn)}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        <span>{t('crm.mktVoidCoupon')}</span>
                      </Button>
                    )}
                  </div>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        {/* ── Tab 3: Gift Card发售与储值 ── */}
        <TabsContent value="giftcards" className="space-y-4 pt-4">
          <div className="flex items-center justify-between gap-4">
            <div className="relative max-w-sm flex-1">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                placeholder={t('crm.mktGiftCardSearch')}
                className="w-full h-9 pl-9 pr-3 rounded-xl border border-slate-200 bg-white text-xs focus:outline-none focus:border-teal-500"
                value={giftCardSearch}
                onChange={(e) => setGiftCardSearch(e.target.value)}
              />
            </div>
            <span className="text-xs text-slate-500 font-medium">{t('crm.mktTotalPrefix')} {giftCards.length}  {t('crm.mktCardUnit')}</span>
          </div>

          {giftCardsQ.isLoading ? (
            <div className="py-12 grid place-items-center">
              <Spinner />
            </div>
          ) : giftCards.length === 0 ? (
            <EmptyState
              icon={<Gift className="w-10 h-10 text-slate-300" />}
              title={t('crm.mktNoGiftCards')}
              description={t('crm.mktNoGiftCardsDesc')}
              action={
                <Button
                  onClick={() => setGiftModalOpen(true)}
                  className="bg-teal-600 text-white font-bold"
                >
                  
                  {t('crm.mktIssueGiftCard')}
                </Button>
              }
            />
          ) : (
            <div className="divide-y divide-slate-100 bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-xs">
              {giftCards.map((gc) => (
                <div
                  key={gc.id}
                  className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 hover:bg-slate-50 transition-colors text-xs"
                >
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <Gift className="w-4 h-4 text-teal-600" />
                      <span className="font-mono font-bold text-slate-900 text-sm">{gc.code}</span>
                      {gc.recipientName && (
                        <span className="text-slate-600 bg-slate-100 px-1.5 py-0.2 rounded font-medium">
                          
                          {t('crm.mktGiftedTo')} {gc.recipientName}
                        </span>
                      )}
                      {gc.purchaserName && (
                        <span className="text-slate-400">{t('crm.mktPurchaser')} {gc.purchaserName}</span>
                      )}
                    </div>
                    <p className="text-slate-400 text-[11px]">
                      
                      {t('crm.mktFaceValue')}{centsToDollars(gc.faceValueCents)}  {t('crm.mktSalePriceSep')}{centsToDollars(gc.salePriceCents)}  {t('crm.mktIssuedOn')} {gc.createdAt.slice(0, 10)}
                    </p>
                  </div>

                  <div className="flex items-center gap-4 justify-between sm:justify-end">
                    <div className="text-right">
                      <p className="font-mono font-extrabold text-base text-teal-700">
                        ${centsToDollars(gc.balanceCents)}
                      </p>
                      <span className="text-[10px] text-emerald-600 font-bold bg-emerald-50 px-1.5 py-0.2 rounded">
                        {giftCardStatusKey(gc.status) === 'active'
                          ? t('crm.mktGcActive')
                          : giftCardStatusKey(gc.status) === 'void'
                            ? t('crm.mktGcVoid')
                            : giftCardStatusKey(gc.status) === 'expired'
                              ? t('crm.mktGcExpired')
                              : gc.status}
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </TabsContent>

        {/* ── Tab 4: 会员积分与 VIP 体系 ── */}
        <TabsContent value="loyalty" className="space-y-6 pt-4">
          {/* 规则横幅 */}
          <Card className="p-5 bg-gradient-to-r from-teal-50 via-emerald-50 to-white border-teal-200 rounded-2xl shadow-xs">
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
              <div>
                <h3 className="font-extrabold text-teal-950 text-base flex items-center gap-2">
                  <Star className="w-5 h-5 text-teal-600 fill-teal-600" />
                  
                  {t('crm.mktPointRulesTitle')}
                </h3>
                <div className="flex flex-wrap gap-6 mt-2.5 text-xs text-teal-900 font-medium">
                  <div>
                    <span className="text-slate-500">{t('crm.mktEarnRate')}</span>{' '}
                    <strong className="font-mono">{t('crm.mktEarnRateValue')}</strong>
                  </div>
                  <div>
                    <span className="text-slate-500">{t('crm.mktRedeemValue')}</span>{' '}
                    <strong className="font-mono">{t('crm.mktRedeemRate')}{(rules?.redeemRateBp || 500) / 100}  {t('crm.mktRedeemCredit')}</strong>
                  </div>
                  <div>
                    <span className="text-slate-500">{t('crm.mktMinRedeem')}</span>{' '}
                    <strong className="font-mono">{rules?.minRedeemPoints ?? 100}  {t('crm.mktPointsUnit')}</strong>
                  </div>
                </div>
              </div>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  if (rules) {
                    setEarnRate(String(rules.earnRateBp));
                    setRedeemRate(String(rules.redeemRateBp));
                    setMinRedeem(String(rules.minRedeemPoints));
                  }
                  setLoyaltyModalOpen(true);
                }}
                className="font-bold text-xs"
              >
                
                {t('crm.mktEditPointRules')}
              </Button>
            </div>
          </Card>

          {/* VIP 等级权益指引卡片 */}
          <div className="space-y-3">
            <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider">
              
              {t('crm.mktVipTiers')}
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-5 gap-3">
              {VIP_TIER_PERKS.map((tier) => (
                <div
                  key={tier.tier}
                  className="p-3.5 rounded-2xl border border-slate-200 bg-white shadow-2xs space-y-1.5"
                >
                  <div className="flex justify-between items-center font-bold">
                    <span className="text-slate-900 text-xs">{t(tier.nameKey)}</span>
                    <Badge className="bg-amber-100 text-amber-900 border-amber-300 font-bold text-[10px]">
                      {t('crm.mktOff', { p0: tier.discountPercent })}
                    </Badge>
                  </div>
                  <p className="text-[11px] text-slate-500">{t('crm.mktTierSpend', { p0: tier.spend })}</p>
                  <p className="text-[11px] text-teal-700 font-semibold">{tier.points}</p>
                </div>
              ))}
            </div>
          </div>

          {/* 顾客积分排行榜 */}
          <div className="space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs font-bold text-slate-800">
              <span>{t('crm.mktPointsLeaderboard')}{customers.length})</span>
              <div className="relative w-full sm:w-56">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-2.5" />
                <input
                  type="text"
                  value={loyaltySearch}
                  onChange={(e) => setLoyaltySearch(e.target.value)}
                  placeholder={t('searchPlaceholder')}
                  className="w-full h-8 pl-8 pr-2.5 rounded-xl border border-slate-200 bg-white text-xs placeholder:text-slate-400 focus:outline-none focus:border-teal-500 transition-all"
                />
              </div>
            </div>

            {loyaltyQ.isLoading ? (
              <div className="py-8 grid place-items-center">
                <Spinner />
              </div>
            ) : customers.length === 0 ? (
              <p className="text-xs text-slate-400 py-6 text-center">{t('noData')}</p>
            ) : (
              <div className="divide-y divide-slate-100 bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-xs">
                {customers.map((c, i) => (
                  <div
                    key={c.customerId}
                    className="p-3.5 flex items-center justify-between text-xs hover:bg-slate-50 transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-7 h-7 rounded-xl bg-slate-100 text-slate-700 flex items-center justify-center font-bold font-mono text-xs">
                        {i + 1}
                      </div>
                      <div>
                        <p className="font-bold text-slate-900">{c.customerName}</p>
                        <p className="text-slate-400 font-mono text-[11px]">{c.phone ? formatPhoneDisplay(c.phone) : '—'}</p>
                      </div>
                    </div>

                    <div className="flex items-center gap-4">
                      <div className="text-right">
                        <span className="font-bold text-teal-700 text-sm font-mono">
                          {c.points} pts
                        </span>
                        <p className="text-[10px] text-slate-400">Total: {c.lifetimePoints} pts</p>
                      </div>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 text-xs text-teal-700 font-bold hover:bg-teal-50"
                        onClick={() => {
                          setAdjustTargetCustomer({
                            id: c.customerId,
                            name: c.customerName,
                            current: c.points,
                          });
                          setAdjustDelta('100');
                          setAdjustReason('VIP Bonus');
                          setAdjustPointsModalOpen(true);
                        }}
                      >
                        {t('edit')}
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </TabsContent>

        {/* ── Tab 5: 营销自动化与短信触达 ── */}
        <TabsContent value="automation" className="space-y-6 pt-4">
          <div className="space-y-3">
            <div className="flex justify-between items-center text-xs font-bold text-slate-700">
              <span>{t('playbooksTab') || t('crm.mktAutomationPlaybooks')}</span>
              <span className="text-slate-400 font-normal">Auto trigger via customer lifecycle</span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {playbooks.map((pb) => {
                const IconComp = pb.icon;
                return (
                  <Card
                    key={pb.id}
                    className={`border-2 rounded-2xl transition-all shadow-xs flex flex-col justify-between ${
                      pb.enabled
                        ? 'border-indigo-300 bg-gradient-to-br from-indigo-50/20 to-white'
                        : 'border-slate-200 bg-slate-50/60 opacity-85'
                    }`}
                  >
                    <CardContent className="p-4.5 space-y-3">
                      <div className="flex justify-between items-start gap-2">
                        <div className="flex items-center gap-2.5">
                          <div className="w-10 h-10 rounded-xl bg-indigo-100 text-indigo-700 flex items-center justify-center font-bold shrink-0">
                            <IconComp className="w-5 h-5" />
                          </div>
                          <div>
                            <h4 className="font-extrabold text-slate-900 text-sm">{t(pb.nameKey)}</h4>
                            <span className="text-[11px] text-slate-500 font-medium">
                              {t(pb.categoryKey)}
                            </span>
                          </div>
                        </div>

                        <div className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={pb.enabled}
                            onChange={() => handleTogglePlaybook(pb.id)}
                            className="w-5 h-5 rounded text-indigo-600 focus:ring-indigo-500 cursor-pointer"
                          />
                        </div>
                      </div>

                      <div className="text-xs space-y-1.5 bg-white p-3 rounded-xl border border-slate-200">
                        <p className="text-slate-700">
                          <strong className="text-slate-900">Trigger:</strong> {t(pb.triggerKey)}
                        </p>
                        <p className="text-slate-700">
                          <strong className="text-slate-900">Reward:</strong>{' '}
                          <span className="text-amber-700 font-semibold">{t(pb.rewardKey)}</span>
                        </p>
                        <div className="pt-1.5 border-t border-slate-100 text-slate-600 text-[11px] italic">
                          "{pb.messageTemplate}"
                        </div>
                      </div>
                    </CardContent>

                    <div className="p-3 bg-slate-50/80 border-t border-slate-100 flex items-center justify-between text-xs">
                      <div className="flex items-center gap-3 text-[11px] text-slate-500 font-mono">
                        <span>{t('crm.mktSentPrefix')} {pb.totalSent}  {t('crm.mktPeopleUnit')}</span>
                        <span>{t('crm.mktConversionRate')} {pb.conversionRate}%</span>
                      </div>
                      <Button
                        size="sm"
                        variant="secondary"
                        className="h-7 text-xs font-bold text-indigo-700 border-indigo-200 hover:bg-indigo-50"
                        onClick={() => {
                          setCampaignTargetPlaybook(pb);
                          setCampaignCustomText(pb.messageTemplate);
                          toast.info(t('email.comingSoon'));
                        }}
                      >
                        <Send className="w-3 h-3 mr-1" />
                        <span>{t('crm.mktSendNow')}</span>
                      </Button>
                    </div>
                  </Card>
                );
              })}
            </div>
          </div>
        </TabsContent>
      </Tabs>

      {/* ─────────────────────────────────────────────────────────────────── */}
      {/* 弹窗部分 (Modals)                                                  */}
      {/* ─────────────────────────────────────────────────────────────────── */}

      {/* 0. 通用二次确认 Modal */}
      <Modal
        isOpen={Boolean(confirmModal)}
        onOpenChange={(open) => {
          if (!open) setConfirmModal(null);
        }}
        size="sm"
        title={confirmModal?.title || t('crm.mktConfirmTitle')}
        footer={
          <div className="flex justify-end gap-2 w-full">
            <Button variant="secondary" onClick={() => setConfirmModal(null)}>
              {t('cancel') || t('crm.mktConfirmCancel')}
            </Button>
            <Button
              className={
                confirmModal?.confirmTone === 'danger'
                  ? 'bg-red-600 hover:bg-red-700 text-white font-bold'
                  : confirmModal?.confirmTone === 'emerald'
                    ? 'bg-emerald-600 hover:bg-emerald-700 text-white font-bold'
                    : 'bg-teal-600 hover:bg-teal-700 text-white font-bold'
              }
              onClick={handleExecuteConfirmModal}
              disabled={confirmPending}
            >
              {confirmPending ? t('crm.mktProcessing') : confirmModal?.confirmText || t('crm.mktConfirm')}
            </Button>
          </div>
        }
      >
        <div className="py-2 text-xs text-slate-700 font-medium leading-relaxed">
          {confirmModal?.description}
        </div>
      </Modal>

      {/* 1. 新建次卡套餐 Modal */}
      <Modal
        isOpen={packageModalOpen}
        onOpenChange={setPackageModalOpen}
        title={t('crm.mktNewPackageTitle')}
        footer={
          <div className="flex justify-end gap-2 w-full">
            <Button variant="secondary" onClick={() => setPackageModalOpen(false)}>
              {t('cancel') || t('crm.mktPkgCancel')}
            </Button>
            <Button
              className="bg-teal-600 hover:bg-teal-700 text-white font-bold"
              onClick={handleCreatePackage}
              disabled={savePackageMut.isPending}
            >
              {savePackageMut.isPending ? t('crm.mktPkgCreating') : t('crm.mktPkgPublish')}
            </Button>
          </div>
        }
      >
        <div className="space-y-4 py-1 text-xs">
          <div>
            <label className="block font-bold text-slate-700 uppercase mb-1">
              
              {t('crm.mktPkgNameLabel')}
            </label>
            <Input
              value={pkgName}
              onChange={(e) => setPkgName(e.target.value)}
              placeholder={t('crm.mktPkgNamePlaceholder')}
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block font-bold text-slate-700 uppercase mb-1">
                
                {t('crm.mktPkgPriceLabel')}
              </label>
              <Input
                type="number"
                value={pkgPrice}
                onChange={(e) => setPkgPrice(e.target.value)}
              />
            </div>

            <div>
              <label className="block font-bold text-slate-700 uppercase mb-1">
                
                {t('crm.mktPkgUnitsLabel')}
              </label>
              <Input
                type="number"
                min="1"
                value={pkgUnits}
                onChange={(e) => setPkgUnits(e.target.value)}
              />
            </div>

            <div>
              <label className="block font-bold text-slate-700 uppercase mb-1">
                
                {t('crm.mktPkgValidDaysLabel')}
              </label>
              <Input
                type="number"
                value={pkgValidDays}
                onChange={(e) => setPkgValidDays(e.target.value)}
              />
            </div>
          </div>

          <div>
            <label className="block font-bold text-slate-700 uppercase mb-1">
              {t('crm.mktPkgServicesLabel')}
            </label>
            <p className="mb-2 text-[11px] text-slate-500">{t('crm.mktPkgServicesHint')}</p>
            <div className="max-h-52 space-y-1.5 overflow-y-auto rounded-xl border border-slate-200 bg-slate-50 p-2">
              {(packagesQ.data?.availableServices ?? []).map((service) => {
                const checked = pkgServiceIds.includes(service.id);
                return (
                  <label key={service.id} className="flex cursor-pointer items-center justify-between gap-3 rounded-lg bg-white px-3 py-2 shadow-xs">
                    <span className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => setPkgServiceIds((current) => checked
                          ? current.filter((id) => id !== service.id)
                          : [...current, service.id])}
                        className="rounded border-slate-300 text-teal-600 focus:ring-teal-500"
                      />
                      <span className="font-semibold text-slate-800">{service.name}</span>
                    </span>
                    <span className="font-mono text-slate-500">${centsToDollars(service.priceCents)}</span>
                  </label>
                );
              })}
              {(packagesQ.data?.availableServices ?? []).length === 0 && (
                <p className="p-3 text-center text-amber-700">{t('crm.mktPkgNoServices')}</p>
              )}
            </div>
          </div>
        </div>
      </Modal>

      {/* 2. 发售次卡给指定顾客 Modal */}
      <Modal
        isOpen={issuePackageModalOpen}
        onOpenChange={setIssuePackageModalOpen}
        title={t('crm.mktSellPackageTitle', { p0: issueTargetPkg?.name ?? '' })}
        footer={
          <div className="flex justify-end gap-2 w-full">
            <Button variant="secondary" onClick={() => setIssuePackageModalOpen(false)}>
              {t('cancel') || t('crm.mktSellCancel')}
            </Button>
            <Button
              className="bg-teal-600 hover:bg-teal-700 text-white font-bold"
              onClick={handleConfirmIssuePackage}
              disabled={issuePackageMut.isPending}
            >
              {issuePackageMut.isPending ? t('crm.mktSelling') : t('crm.mktSellConfirm')}
            </Button>
          </div>
        }
      >
        <div className="space-y-4 py-1 text-xs">
          <div className="p-3 bg-teal-50 border border-teal-200 rounded-xl text-teal-950">
            <p className="font-bold">{t('crm.mktPackageLabel')}{issueTargetPkg?.name}</p>
            <p className="text-[11px] text-teal-800 mt-0.5">
              
              {t('crm.mktIncludesPrefix2')} {issueTargetPkg?.totalUnits}  {t('crm.mktSessionsAndPrice')}{issueTargetPkg && centsToDollars(issueTargetPkg.priceCents)}
            </p>
          </div>

          <div>
            <label className="block font-bold text-slate-700 uppercase mb-1">
              
              {t('crm.mktBuyerNameLabel')}
            </label>
            <Input
              value={issueCustomerName}
              onChange={(e) => setIssueCustomerName(e.target.value)}
              placeholder={t('crm.mktBuyerNamePlaceholder')}
            />
          </div>

          <div>
            <label className="block font-bold text-slate-700 uppercase mb-1">
              {t('crm.mktBuyerPhoneLabel')}
            </label>
            <Input
              value={issueCustomerPhone}
              onChange={(e) => setIssueCustomerPhone(e.target.value)}
              placeholder={t('crm.mktBuyerPhonePlaceholder')}
            />
          </div>

          <div>
            <label className="block font-bold text-slate-700 uppercase mb-1">

              {t('crm.mktActualAmountLabel')}
            </label>
            <Input
              value={issueOverridePrice}
              onChange={(e) => setIssueOverridePrice(e.target.value)}
              placeholder={t('crm.mktActualAmountPlaceholder')}
            />
          </div>
        </div>
      </Modal>

      {/* 3. 创建优惠券 Modal */}
      <Modal
        isOpen={couponModalOpen}
        onOpenChange={setCouponModalOpen}
        title={t('crm.mktNewCouponTitle')}
        footer={
          <div className="flex justify-end gap-2 w-full">
            <Button variant="secondary" onClick={() => setCouponModalOpen(false)}>
              {t('cancel') || t('crm.mktCouponCancel')}
            </Button>
            <Button
              className="bg-teal-600 hover:bg-teal-700 text-white font-bold"
              onClick={handleCreateCoupon}
              disabled={saveCouponMut.isPending}
            >
              {saveCouponMut.isPending ? t('crm.mktCouponPublishing') : t('crm.mktCouponPublish')}
            </Button>
          </div>
        }
      >
        <div className="space-y-4 py-1 text-xs">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block font-bold text-slate-700 uppercase mb-1">
                
                {t('crm.mktCouponCodeLabel')}
              </label>
              <Input
                value={cpnCode}
                onChange={(e) => setCpnCode(e.target.value)}
                placeholder={t('crm.mktCouponCodePlaceholder')}
              />
            </div>

            <div>
              <label className="block font-bold text-slate-700 uppercase mb-1">
                
                {t('crm.mktCouponNameLabel')}
              </label>
              <Input
                value={cpnName}
                onChange={(e) => setCpnName(e.target.value)}
                placeholder={t('crm.mktCouponNamePlaceholder')}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block font-bold text-slate-700 uppercase mb-1">
                
                {t('crm.mktCouponKindLabel')}
              </label>
              <select
                value={cpnKind}
                onChange={(e) => setCpnKind(e.target.value as any)}
                className="w-full h-10 px-3 rounded-xl border border-slate-200 bg-white text-xs font-medium text-slate-700"
              >
                <option value="amount">{t('crm.mktCouponKindFixed')}</option>
                <option value="percent">{t('crm.mktCouponKindPercent')}</option>
              </select>
            </div>

            <div>
              <label className="block font-bold text-slate-700 uppercase mb-1">
                
                {t('crm.mktCouponValueLabel')}{cpnKind === 'amount' ? '$' : '%'})
              </label>
              <Input
                type="number"
                value={cpnValue}
                onChange={(e) => setCpnValue(e.target.value)}
              />
            </div>

            <div>
              <label className="block font-bold text-slate-700 uppercase mb-1">
                
                {t('crm.mktCouponMinSpendLabel')}
              </label>
              <Input
                type="number"
                value={cpnMinSpend}
                onChange={(e) => setCpnMinSpend(e.target.value)}
              />
            </div>
          </div>
        </div>
      </Modal>

      {/* 4. 发售Gift Card Modal */}
      <Modal
        isOpen={giftModalOpen}
        onOpenChange={setGiftModalOpen}
        title={t('crm.mktGiftCardModalTitle')}
        footer={
          <div className="flex justify-end gap-2 w-full">
            <Button variant="secondary" onClick={() => setGiftModalOpen(false)}>
              {t('cancel') || t('crm.mktGcCancel')}
            </Button>
            <Button
              className="bg-teal-600 hover:bg-teal-700 text-white font-bold"
              onClick={handleCreateGiftCard}
              disabled={issueGiftCardMut.isPending}
            >
              {issueGiftCardMut.isPending ? t('crm.mktGcIssuing') : t('crm.mktGcConfirm')}
            </Button>
          </div>
        }
      >
        <div className="space-y-4 py-1 text-xs">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block font-bold text-slate-700 uppercase mb-1">
                
                {t('crm.mktGcFaceValueLabel')}
              </label>
              <Input
                type="number"
                value={gcFaceValue}
                onChange={(e) => setGcFaceValue(e.target.value)}
              />
            </div>

            <div>
              <label className="block font-bold text-slate-700 uppercase mb-1">
                
                {t('crm.mktGcSalePriceLabel')}
              </label>
              <Input
                type="number"
                value={gcSalePrice}
                onChange={(e) => setGcSalePrice(e.target.value)}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block font-bold text-slate-700 uppercase mb-1">
                
                {t('crm.mktGcPurchaserLabel')}
              </label>
              <Input
                value={gcPurchaser}
                onChange={(e) => setGcPurchaser(e.target.value)}
                placeholder={t('crm.mktGcPurchaserPlaceholder')}
              />
            </div>

            <div>
              <label className="block font-bold text-slate-700 uppercase mb-1">
                
                {t('crm.mktGcRecipientLabel')}
              </label>
              <Input
                value={gcRecipient}
                onChange={(e) => setGcRecipient(e.target.value)}
                placeholder={t('crm.mktGcRecipientPlaceholder')}
              />
            </div>
          </div>
        </div>
      </Modal>

      {/* 5. 积分规则与 VIP 配置 Modal */}
      <Modal
        isOpen={loyaltyModalOpen}
        onOpenChange={setLoyaltyModalOpen}
        title={t('crm.mktPointRulesModalTitle')}
        footer={
          <div className="flex justify-end gap-2 w-full">
            <Button variant="secondary" onClick={() => setLoyaltyModalOpen(false)}>
              {t('cancel') || t('crm.mktPointsCancel')}
            </Button>
            <Button
              className="bg-teal-600 hover:bg-teal-700 text-white font-bold"
              onClick={handleSaveLoyalty}
              disabled={saveLoyaltyMut.isPending}
            >
              {saveLoyaltyMut.isPending ? t('crm.mktPointsSaving') : t('crm.mktPointsSave')}
            </Button>
          </div>
        }
      >
        <div className="space-y-4 py-1 text-xs">
          <div>
            <label className="block font-bold text-slate-700 uppercase mb-1">
              
              {t('crm.mktEarnBpLabel')}
            </label>
            <Input
              type="number"
              value={earnRate}
              onChange={(e) => setEarnRate(e.target.value)}
            />
          </div>

          <div>
            <label className="block font-bold text-slate-700 uppercase mb-1">
              
              {t('crm.mktRedeemBpLabel')}
            </label>
            <Input
              type="number"
              value={redeemRate}
              onChange={(e) => setRedeemRate(e.target.value)}
            />
          </div>

          <div>
            <label className="block font-bold text-slate-700 uppercase mb-1">
              
              {t('crm.mktMinRedeemLabel')}
            </label>
            <Input
              type="number"
              value={minRedeem}
              onChange={(e) => setMinRedeem(e.target.value)}
            />
          </div>
        </div>
      </Modal>

      {/* 6. 手动调整积分 Modal */}
      <Modal
        isOpen={adjustPointsModalOpen}
        onOpenChange={setAdjustPointsModalOpen}
        title={t('crm.mktAdjustPointsTitle', { p0: adjustTargetCustomer?.name ?? '' })}
        footer={
          <div className="flex justify-end gap-2 w-full">
            <Button variant="secondary" onClick={() => setAdjustPointsModalOpen(false)}>
              {t('cancel') || t('crm.mktAdjustCancel')}
            </Button>
            <Button
              className="bg-teal-600 hover:bg-teal-700 text-white font-bold"
              onClick={handleConfirmAdjustPoints}
              disabled={adjustLoyaltyMut.isPending}
            >
              {adjustLoyaltyMut.isPending ? t('crm.mktAdjustSubmitting') : t('crm.mktAdjustConfirm')}
            </Button>
          </div>
        }
      >
        <div className="space-y-4 py-1 text-xs">
          <div className="p-3 bg-teal-50 border border-teal-200 rounded-xl text-teal-950">
            <p className="font-bold">{t('crm.mktAdjustCustomer')}{adjustTargetCustomer?.name}</p>
            <p className="text-[11px] text-teal-800 mt-0.5">
              
              {t('crm.mktAdjustCurrentPoints')}<strong>{adjustTargetCustomer?.current}</strong> pts
            </p>
          </div>

          <div>
            <label className="block font-bold text-slate-700 uppercase mb-1">
              
              {t('crm.mktAdjustDeltaLabel')}
            </label>
            <Input
              type="number"
              value={adjustDelta}
              onChange={(e) => setAdjustDelta(e.target.value)}
            />
          </div>

          <div>
            <label className="block font-bold text-slate-700 uppercase mb-1">
              
              {t('crm.mktAdjustReasonLabel')}
            </label>
            <Input
              value={adjustReason}
              onChange={(e) => setAdjustReason(e.target.value)}
              placeholder={t('crm.mktAdjustReasonPlaceholder')}
            />
          </div>
        </div>
      </Modal>

      {/* 7. 发起即时群发活动 Modal */}
      <Modal
        isOpen={campaignModalOpen}
        onOpenChange={setCampaignModalOpen}
        title={`💌 ${t('campaignsTab') || 'Marketing Campaign'} · ${campaignTargetPlaybook ? t(campaignTargetPlaybook.nameKey) : ''}`}
        footer={
          <div className="flex justify-end gap-2 w-full">
            <Button variant="secondary" onClick={() => setCampaignModalOpen(false)}>
              {t('cancel')}
            </Button>
            <Button
              className="bg-indigo-600 hover:bg-indigo-700 text-white font-bold gap-1.5"
              onClick={handleSendCampaign}
            >
              <Send className="w-3.5 h-3.5" />
              <span>{t('submit')}</span>
            </Button>
          </div>
        }
      >
        <div className="space-y-4 py-1 text-xs">
          <div className="p-3 bg-indigo-50 border border-indigo-200 rounded-xl text-indigo-950">
            <p className="font-bold">Target: {campaignTargetPlaybook ? t(campaignTargetPlaybook.nameKey) : ''}</p>
            <p className="text-[11px] text-indigo-800 mt-0.5">
              Channel: SMS · Interpolation supported
            </p>
          </div>

          <div>
            <label className="block font-bold text-slate-700 uppercase mb-1">
              
              {t('crm.mktSmsBodyLabel')}
            </label>
            <textarea
              rows={4}
              value={campaignCustomText}
              onChange={(e) => setCampaignCustomText(e.target.value)}
              className="w-full p-2.5 rounded-xl border border-slate-200 text-xs focus:outline-none focus:border-indigo-500 font-sans"
            />
          </div>
        </div>
      </Modal>
    </div>
  );
}

export function Marketing() {
  return (
    <ErrorBoundary fallbackTitleKey="marketing">
      <MarketingContent />
    </ErrorBoundary>
  );
}
