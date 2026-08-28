import { useState, useEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AnimatePresence, motion } from 'motion/react';
import {
  User,
  Shield,
  KeyRound,
  Smartphone,
  Lock,
  Building,
  Scissors,
  Bell,
  Save,
  Check,
  LogOut,
  Sliders,
  Globe,
  Clock,
  Sparkles,
  CheckCircle2,
  AlertCircle,
  Eye,
  EyeOff,
  Tag,
  Mail,
  Phone,
  ShieldCheck,
  Laptop,
  Tablet,
  CheckCircle,
  Copy,
  Search,
  Plus,
  Trash2,
  Calendar,
  CreditCard,
  Users,
  Layers,
  ArrowRight,
  Delete,
  Store,
} from 'lucide-react';
import { toast } from '@heroui/react';
import { useLanguage } from '@/LanguageContext';
import { LANGUAGES, type Language } from '@/i18n';
import { useSession } from '@/lib/session';
import { useErrorMessage } from '@/lib/errorMessage';
import { roleLabelKey } from '@/lib/roles';
import { pickText } from '@gf/contracts';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { PageHeader } from '@/components/ui/PageHeader';
import { Modal, ConfirmDialog } from '@/components/ui/Modal';
import { PageLoading } from '@/components/ui/QueryState';
import { ImageUploader } from '@/components/ui/ImageUploader';
import {
  useUserProfileQuery,
  useUpdateUserProfile,
  useChangePassword,
  useSetPin,
  useActiveSessionsQuery,
  useRevokeSession,
  usePersonalNotificationPreferencesQuery,
  useSavePersonalNotificationPreferences,
} from '@/features/profile/api';
import type { PersonalNotificationPreferences } from '@/features/profile/types';

import {
  PRESET_USER_AVATARS,
  PRESET_AVATAR_GRADIENTS,
  getSavedUserAvatar,
  saveUserAvatar,
  type UserAvatarPreset,
} from '@/lib/avatarPresets';

const PRESET_AVATARS = PRESET_AVATAR_GRADIENTS;

const PRESET_SALON_SKILLS = [
  '日式光疗美甲',
  '水晶琉璃延长',
  '俄式极致修甲',
  '手足精油SPA',
  '火山热石理疗',
  '全身芳香开背',
  '足底全息反射',
  '日式单根美睫',
  '3D山茶花美睫',
  '头部舒压理疗',
  '半永久野生眉',
  '染烫色彩造型',
];

type ConfirmActionType =
  | 'sign_out'
  | 'save_general'
  | 'change_password'
  | 'set_pin'
  | 'save_provider'
  | 'save_notifications'
  | 'revoke_session'
  | 'switch_location';

export function Profile() {
  const errorMessage = useErrorMessage();
  const { t, language, setLanguage } = useLanguage();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = searchParams.get('tab') || 'general';

  const { session, membership, locations, context, selectMembership, signOut } = useSession();
  const { data: profile, isLoading: isProfileLoading } = useUserProfileQuery();
  const { data: sessions, isLoading: isSessionsLoading } = useActiveSessionsQuery();
  const { data: notifPrefs } = usePersonalNotificationPreferencesQuery();

  const updateProfileMutation = useUpdateUserProfile();
  const changePasswordMutation = useChangePassword();
  const setPinMutation = useSetPin();
  const revokeSessionMutation = useRevokeSession();
  const saveNotifPrefsMutation = useSavePersonalNotificationPreferences();

  // General Form State
  const [fullName, setFullName] = useState('');
  const [nickname, setNickname] = useState('');
  const [phone, setPhone] = useState('');
  const [bio, setBio] = useState('');
  
  // 丰富个人形象头像状态
  const [avatarMode, setAvatarMode] = useState<'emoji' | 'gradient' | 'custom'>('emoji');
  const [selectedUserAvatarId, setSelectedUserAvatarId] = useState('usr-2');
  const [selectedGradientId, setSelectedGradientId] = useState('grad-1');
  const [customAvatarUrl, setCustomAvatarUrl] = useState('');

  // 初始化加载已存储头像
  useEffect(() => {
    const saved = getSavedUserAvatar();
    if (saved) {
      if (saved.mode) setAvatarMode(saved.mode);
      if (saved.presetId) setSelectedUserAvatarId(saved.presetId);
      if (saved.gradientId) setSelectedGradientId(saved.gradientId);
      if (saved.customImageUrl) setCustomAvatarUrl(saved.customImageUrl);
    }
  }, []);

  // Security Form State
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  // PIN Form State
  const [pinCode, setPinCode] = useState('');
  const [pinModalOpen, setPinModalOpen] = useState(false);

  // Provider Settings State
  const [isBookable, setIsBookable] = useState(true);
  const [maxConcurrent, setMaxConcurrent] = useState('2');
  const [skills, setSkills] = useState<string[]>([]);
  const [newSkillInput, setNewSkillInput] = useState('');

  // Permissions filter state
  const [permissionQuery, setPermissionQuery] = useState('');

  // Notification Preferences State
  const [localNotifPrefs, setLocalNotifPrefs] = useState<PersonalNotificationPreferences | null>(null);

  // ── 两步确认状态机 ──────────────────────────────────────────────────────────
  const [confirmDialogState, setConfirmDialogState] = useState<{
    isOpen: boolean;
    type: ConfirmActionType | null;
    title: string;
    description: string;
    tone?: 'default' | 'danger';
    confirmLabel?: string;
    payload?: any;
  }>({
    isOpen: false,
    type: null,
    title: '',
    description: '',
  });

  // Sync loaded profile into form
  useEffect(() => {
    if (profile) {
      setFullName(profile.fullName || '');
      setNickname(profile.nickname || '');
      setPhone(profile.phone || '');
      setBio(profile.bio || '');
      if (profile.staffInfo) {
        setIsBookable(profile.staffInfo.isBookable);
        setMaxConcurrent(String(profile.staffInfo.maxConcurrentAppointments || 2));
        setSkills(profile.staffInfo.skills || []);
      }
    }
  }, [profile]);

  useEffect(() => {
    if (notifPrefs) {
      setLocalNotifPrefs(notifPrefs);
    }
  }, [notifPrefs]);

  const handleTabChange = (tabId: string) => {
    setSearchParams({ tab: tabId });
  };

  // Password strength calculation
  const passwordStrength = useMemo(() => {
    if (!newPassword) return { score: 0, label: '请输入密码', color: 'bg-slate-200' };
    let s = 0;
    if (newPassword.length >= 8) s += 1;
    if (/[a-z]/.test(newPassword) && /[A-Z]/.test(newPassword)) s += 1;
    if (/\d/.test(newPassword)) s += 1;
    if (/[^a-zA-Z0-9]/.test(newPassword)) s += 1;

    if (s <= 1) return { score: 1, label: '弱 (建议增加长度与符号)', color: 'bg-red-500' };
    if (s === 2) return { score: 2, label: '中等', color: 'bg-amber-500' };
    if (s === 3) return { score: 3, label: '良好', color: 'bg-blue-500' };
    return { score: 4, label: '强 (高安全性)', color: 'bg-emerald-500' };
  }, [newPassword]);

  // ── 两步确认触发器 ──────────────────────────────────────────────────────────
  const requestSignOut = () => {
    setConfirmDialogState({
      isOpen: true,
      type: 'sign_out',
      title: '确认退出系统登录？',
      description: '退出后当前设备上的会话将被注销，需要重新输入账号密码才能进入工作台。',
      tone: 'danger',
      confirmLabel: '确认退出',
    });
  };

  const requestSaveGeneralProfile = () => {
    if (!fullName.trim()) {
      toast.danger(t('settings.profNameRequired'));
      return;
    }
    setConfirmDialogState({
      isOpen: true,
      type: 'save_general',
      title: '确认保存个人基本档案更改？',
      description: `即将更新姓名「${fullName.trim()}」、昵称「${nickname.trim() || '无'}」、手机号与语言设置。`,
      tone: 'default',
      confirmLabel: '确认保存',
    });
  };

  const requestChangePassword = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newPassword || newPassword.length < 8) {
      toast.danger(t('settings.profPasswordTooShort'));
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.danger(t('settings.profPasswordMismatch'));
      return;
    }
    setConfirmDialogState({
      isOpen: true,
      type: 'change_password',
      title: '确认更新登录密码？',
      description: '密码更新后将立即生效，请妥善保管您的新登录凭据。',
      tone: 'danger',
      confirmLabel: '确认更新密码',
    });
  };

  const requestSetPin = () => {
    if (!/^\d{4,6}$/.test(pinCode)) {
      toast.danger(t('settings.profPinFormat'));
      return;
    }
    setConfirmDialogState({
      isOpen: true,
      type: 'set_pin',
      title: `确认设置 ${pinCode.length} 位 PIN 为快速解锁码？`,
      description: '设置后，您在前台共享 iPad 或收银终端上无需输入长密码，输入该 PIN 即可秒级切入个人操作台。',
      tone: 'default',
      confirmLabel: '确认保存 PIN',
    });
  };

  const requestSaveProviderSettings = () => {
    setConfirmDialogState({
      isOpen: true,
      type: 'save_provider',
      title: '确认更新技师接单与技能配置？',
      description: `即将更新：开放接单状态【${isBookable ? '开启' : '关闭'}】、最大并发【${maxConcurrent}人】及 ${skills.length} 项技能特长。`,
      tone: 'default',
      confirmLabel: '确认更新',
    });
  };

  const requestSaveNotificationPrefs = () => {
    setConfirmDialogState({
      isOpen: true,
      type: 'save_notifications',
      title: '确认保存个人通知偏好？',
      description: '即将更新您的应用内实时推送、短信直达与每日邮件报告通道配置。',
      tone: 'default',
      confirmLabel: '确认保存偏好',
    });
  };

  const requestRevokeSession = (sessionId: string, deviceLabel: string) => {
    setConfirmDialogState({
      isOpen: true,
      type: 'revoke_session',
      title: `确认强制踢下线设备「${deviceLabel}」？`,
      description: '强制注销后，该设备上的会话将立即失效并被踢出系统，下次使用需重新登录。',
      tone: 'danger',
      confirmLabel: '确认踢下线',
      payload: { sessionId },
    });
  };

  const requestSwitchLocation = (targetMembershipId: string, storeName: string) => {
    setConfirmDialogState({
      isOpen: true,
      type: 'switch_location',
      title: `确认切换进入门店「${storeName}」？`,
      description: '切换门店后，工作台将立即载入该门店的排班日历、大堂等位与收银账单数据。',
      tone: 'default',
      confirmLabel: '确认切换',
      payload: { membershipId: targetMembershipId },
    });
  };

  // 执行二次确认操作
  const executeConfirmedAction = async () => {
    const { type, payload } = confirmDialogState;
    setConfirmDialogState((prev) => ({ ...prev, isOpen: false }));

    try {
      switch (type) {
        case 'sign_out':
          await signOut();
          break;
        case 'save_general':
          await updateProfileMutation.mutateAsync({
            fullName: fullName.trim(),
            nickname: nickname.trim(),
            phone: phone.trim(),
            bio: bio.trim(),
            locale: language,
          });
          toast.success(t('settings.profSaved'));
          break;
        case 'change_password':
          await changePasswordMutation.mutateAsync({
            oldPassword,
            newPassword,
          });
          toast.success(t('passwordChangedSuccess'));
          setOldPassword('');
          setNewPassword('');
          setConfirmPassword('');
          break;
        case 'set_pin':
          await setPinMutation.mutateAsync({ pin: pinCode });
          toast.success(t('pinSetSuccess'));
          setPinModalOpen(false);
          setPinCode('');
          break;
        case 'save_provider':
          await updateProfileMutation.mutateAsync({
            isBookable,
            maxConcurrentAppointments: parseInt(maxConcurrent, 10) || 1,
            skills,
          });
          toast.success(t('settings.profBookingPrefsSaved'));
          break;
        case 'save_notifications':
          if (localNotifPrefs) {
            await saveNotifPrefsMutation.mutateAsync(localNotifPrefs);
            toast.success(t('settings.profNotifPrefsSaved'));
          }
          break;
        case 'revoke_session':
          if (payload?.sessionId) {
            await revokeSessionMutation.mutateAsync({ sessionId: payload.sessionId });
            toast.success(t('settings.profSessionRevoked'));
          }
          break;
        case 'switch_location':
          if (payload?.membershipId) {
            selectMembership(payload.membershipId);
            toast.success(t('settings.profLocationSwitched'));
          }
          break;
      }
    } catch (err: any) {
      toast.danger(errorMessage(err));
    }
  };

  const handlePinKeypadPress = (val: string) => {
    if (val === 'backspace') {
      setPinCode((prev) => prev.slice(0, -1));
    } else if (val === 'clear') {
      setPinCode('');
    } else if (pinCode.length < 6) {
      setPinCode((prev) => prev + val);
    }
  };

  const handleAddSkill = (skillToAdd?: string) => {
    const val = (skillToAdd || newSkillInput).trim();
    if (!val) return;
    if (skills.includes(val)) {
      toast.warning(t('settings.profSkillExists'));
      return;
    }
    setSkills([...skills, val]);
    if (!skillToAdd) setNewSkillInput('');
  };

  const handleRemoveSkill = (skillToRemove: string) => {
    setSkills(skills.filter((s) => s !== skillToRemove));
  };

  const handleCopyEmail = () => {
    if (!session?.user.email) return;
    void navigator.clipboard.writeText(session.user.email);
    toast.success(t('settings.profEmailCopied'));
  };

  if (isProfileLoading && !profile) {
    return <PageLoading title={t('settings.profLoading')} description={t('settings.profLoadingDesc')} />;
  }

  const currentStoreName = membership ? pickText(membership.locationName, language) : '—';
  const roleNames =
    membership?.roleKeys
      .map((r) => {
        const k = roleLabelKey(r);
        return k ? t(k) : r;
      })
      .join(' · ') || '—';

  const avatarInitial = (fullName || session?.user.email || 'U').slice(0, 1).toUpperCase();

  // Categorized permissions
  const allPermissions = context?.permissions || [
    'appointment.read',
    'appointment.write',
    'appointment.cancel',
    'ticket.read',
    'ticket.write',
    'ticket.discount',
    'customer.read',
    'customer.write',
    'rotation.view',
    'timeclock.punch_self',
    'reports.view',
    'staff.manage',
  ];

  const filteredPermissions = allPermissions.filter((p) =>
    permissionQuery.trim() ? p.toLowerCase().includes(permissionQuery.trim().toLowerCase()) : true,
  );

  const tabs = [
    { id: 'general', label: t('tabGeneral'), icon: User },
    { id: 'security', label: t('tabSecurity'), icon: Shield },
    { id: 'store_roles', label: t('tabStoreRoles'), icon: Building },
    { id: 'provider', label: t('tabProvider'), icon: Scissors },
    { id: 'notifications', label: t('tabNotificationPrefs'), icon: Bell },
  ];

  return (
    <div className="space-y-6 pb-12 max-w-6xl mx-auto">
      {/* 顶部标题与操作栏 */}
      <PageHeader
        title={
          <div className="flex items-center gap-3">
            <span>{t('profile')}</span>
            <Badge variant="default" className="gap-1 font-mono">
              <Sparkles className="w-3.5 h-3.5 text-teal-600" />
              <span>{session?.user.email}</span>
            </Badge>
          </div>
        }
        description={t('settings.profPageDesc')}
      />

      {/* 个人形象横幅卡片（修复文字被头像遮挡的 UI Bug） */}
      <Card className="border border-slate-200/90 shadow-sm rounded-2xl overflow-hidden bg-white">
        {/* Banner 区域：状态标识置于右上角，装饰图案在右下角，左侧完全留空给头像下压 */}
        <div className="h-32 bg-gradient-to-r from-teal-700 via-teal-800 to-slate-900 p-4 flex items-start justify-end relative overflow-hidden">
          <div className="absolute right-0 bottom-0 opacity-15 pointer-events-none">
            <Sparkles className="w-64 h-64 text-white transform translate-x-12 translate-y-12" />
          </div>
          <div className="px-3 py-1 rounded-full bg-black/25 backdrop-blur-md border border-white/15 text-white text-xs font-semibold flex items-center gap-2 relative z-10">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
            <span>{t('settings.profSignedIn')}</span>
          </div>
        </div>

        {/* 头像与信息栏：头像从底部干净下压，无任何文字遮挡冲突 */}
        <div className="px-6 pb-6 pt-0 flex flex-col sm:flex-row items-start sm:items-end justify-between gap-4 -mt-12 relative z-10">
          <div className="flex items-end gap-4">
            {(() => {
              const activeEmoji =
                PRESET_USER_AVATARS.find((a) => a.id === selectedUserAvatarId) || PRESET_USER_AVATARS[0];
              const activeGrad =
                PRESET_AVATAR_GRADIENTS.find((g) => g.id === selectedGradientId) || PRESET_AVATAR_GRADIENTS[0];

              if (avatarMode === 'custom' && customAvatarUrl) {
                return (
                  <img
                    src={customAvatarUrl}
                    alt={fullName}
                    className="w-24 h-24 rounded-2xl object-cover shadow-xl border-4 border-white shrink-0 bg-slate-100"
                    onError={() => setAvatarMode('emoji')}
                  />
                );
              }
              if (avatarMode === 'emoji') {
                return (
                  <div
                    className={`w-24 h-24 rounded-2xl bg-gradient-to-br ${activeEmoji.bg} flex items-center justify-center text-4xl shadow-xl border-4 border-white shrink-0 select-none`}
                  >
                    {activeEmoji.icon}
                  </div>
                );
              }
              return (
                <div
                  className={`w-24 h-24 rounded-2xl bg-gradient-to-br ${activeGrad.bg} ${activeGrad.text} flex items-center justify-center text-3xl font-black shadow-xl border-4 border-white shrink-0`}
                >
                  {avatarInitial}
                </div>
              );
            })()}

            <div className="space-y-1.5 mb-1">
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-xl font-black text-slate-900">{fullName || t('settings.profUnnamed')}</h2>
                {nickname && <span className="text-xs font-bold text-slate-500">({nickname})</span>}
                <Badge variant="secondary" className="text-[10px] font-bold">
                  {roleNames}
                </Badge>
              </div>
              <p className="text-xs text-slate-500 flex items-center gap-3 flex-wrap">
                <button
                  type="button"
                  onClick={handleCopyEmail}
                  className="flex items-center gap-1 hover:text-teal-700 transition-colors"
                  title={t('settings.profCopyEmail')}
                >
                  <Mail className="w-3.5 h-3.5 text-slate-400" />
                  <span>{session?.user.email}</span>
                  <Copy className="w-3 h-3 text-slate-400 ml-0.5" />
                </button>
                {phone && (
                  <span className="flex items-center gap-1">
                    <Phone className="w-3.5 h-3.5 text-slate-400" />
                    {phone}
                  </span>
                )}
                <span className="flex items-center gap-1 font-semibold text-teal-700">
                  <Building className="w-3.5 h-3.5" />
                  {currentStoreName}
                </span>
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={requestSignOut}
              className="text-red-600 hover:bg-red-50 hover:border-red-200 gap-1.5 rounded-xl text-xs font-bold"
            >
              <LogOut className="w-4 h-4" />
              <span>{t('signOut')}</span>
            </Button>
          </div>
        </div>
      </Card>

      {/* Tab 选项卡导航 */}
      <div className="flex items-center gap-2 overflow-x-auto border-b border-slate-200 pb-2 custom-scrollbar">
        {tabs.map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => handleTabChange(tab.id)}
              className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs font-bold transition-all shrink-0 ${
                isActive
                  ? 'bg-teal-600 text-white shadow-sm shadow-teal-600/20'
                  : 'bg-white text-slate-600 hover:bg-slate-100 hover:text-slate-900 border border-slate-200'
              }`}
            >
              <tab.icon className={`w-4 h-4 ${isActive ? 'text-white' : 'text-slate-400'}`} />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </div>

      {/* ── TAB 内容切换（带平滑动画）─────────────────────────────────── */}
      <AnimatePresence mode="wait">
        <motion.div
          key={activeTab}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.15 }}
        >
          {/* ── TAB 1: 基本资料 (General Profile) ──────────────────────────────── */}
          {activeTab === 'general' && (
            <Card className="border border-slate-200 shadow-sm rounded-2xl bg-white overflow-hidden">
              <CardHeader className="bg-slate-50/50 px-6 py-4 border-b border-slate-100 flex flex-row items-center justify-between">
                <div>
                  <CardTitle className="text-sm font-bold text-slate-900">{t('tabGeneral')}</CardTitle>
                  <CardDescription className="text-xs text-slate-500 mt-0.5">
                    
                    {t('settings.profBasicDesc')}
                  </CardDescription>
                </div>
                <Button
                  onClick={requestSaveGeneralProfile}
                  disabled={updateProfileMutation.isPending}
                  className="bg-teal-600 hover:bg-teal-700 text-white rounded-xl gap-2 text-xs font-bold"
                >
                  <Save className="w-4 h-4" />
                  <span>{t('save')}</span>
                </Button>
              </CardHeader>
              <CardContent className="p-6 space-y-6">
                {/* 丰富个性化头像选择器 */}
                <div className="space-y-3 p-4 bg-slate-50 border border-slate-200/80 rounded-2xl">
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <div>
                      <label className="text-xs font-bold text-slate-900 block">{t('settings.profAvatarTitle')}</label>
                      <span className="text-[11px] text-slate-500">
                        
                        {t('settings.profAvatarDesc')}
                      </span>
                    </div>

                    {/* 模式切换 Tabs */}
                    <div className="flex items-center gap-1 bg-white p-1 rounded-xl border border-slate-200 shadow-2xs">
                      <button
                        type="button"
                        onClick={() => {
                          setAvatarMode('emoji');
                          saveUserAvatar({
                            mode: 'emoji',
                            presetId: selectedUserAvatarId,
                            gradientId: selectedGradientId,
                            customImageUrl: customAvatarUrl,
                          });
                        }}
                        className={`px-3 py-1 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                          avatarMode === 'emoji'
                            ? 'bg-teal-600 text-white shadow-2xs'
                            : 'text-slate-600 hover:bg-slate-50'
                        }`}
                      >
                        
                        {t('settings.profAvatarProfessional')}{PRESET_USER_AVATARS.length})
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setAvatarMode('gradient');
                          saveUserAvatar({
                            mode: 'gradient',
                            presetId: selectedUserAvatarId,
                            gradientId: selectedGradientId,
                            customImageUrl: customAvatarUrl,
                          });
                        }}
                        className={`px-3 py-1 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                          avatarMode === 'gradient'
                            ? 'bg-teal-600 text-white shadow-2xs'
                            : 'text-slate-600 hover:bg-slate-50'
                        }`}
                      >
                        
                        {t('settings.profAvatarGradient')}{PRESET_AVATAR_GRADIENTS.length})
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setAvatarMode('custom');
                          saveUserAvatar({
                            mode: 'custom',
                            presetId: selectedUserAvatarId,
                            gradientId: selectedGradientId,
                            customImageUrl: customAvatarUrl,
                          });
                        }}
                        className={`px-3 py-1 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                          avatarMode === 'custom'
                            ? 'bg-teal-600 text-white shadow-2xs'
                            : 'text-slate-600 hover:bg-slate-50'
                        }`}
                      >
                        
                        {t('settings.profAvatarCustom')}
                      </button>
                    </div>
                  </div>

                  {/* 1. 职业形象 Emoji 列表 */}
                  {avatarMode === 'emoji' && (
                    <div className="grid grid-cols-4 sm:grid-cols-8 gap-2.5 pt-1">
                      {PRESET_USER_AVATARS.map((av) => (
                        <button
                          key={av.id}
                          type="button"
                          onClick={() => {
                            setSelectedUserAvatarId(av.id);
                            saveUserAvatar({
                              mode: 'emoji',
                              presetId: av.id,
                              gradientId: selectedGradientId,
                              customImageUrl: customAvatarUrl,
                            });
                          }}
                          className={`flex flex-col items-center gap-1 p-2 rounded-2xl border transition-all cursor-pointer ${
                            selectedUserAvatarId === av.id
                              ? 'bg-white border-teal-500 ring-2 ring-teal-500/20 shadow-sm scale-105'
                              : 'bg-white/60 border-slate-200 hover:bg-white hover:border-slate-300'
                          }`}
                        >
                          <div
                            className={`w-10 h-10 rounded-xl bg-gradient-to-br ${av.bg} flex items-center justify-center text-xl shadow-2xs`}
                          >
                            {av.icon}
                          </div>
                          <span className="text-[10px] font-bold text-slate-700 truncate w-full text-center">
                            {av.label}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}

                  {/* 2. 质感流光渐变列表 */}
                  {avatarMode === 'gradient' && (
                    <div className="grid grid-cols-3 sm:grid-cols-6 gap-2.5 pt-1">
                      {PRESET_AVATAR_GRADIENTS.map((av) => (
                        <button
                          key={av.id}
                          type="button"
                          onClick={() => {
                            setSelectedGradientId(av.id);
                            saveUserAvatar({
                              mode: 'gradient',
                              presetId: selectedUserAvatarId,
                              gradientId: av.id,
                              customImageUrl: customAvatarUrl,
                            });
                          }}
                          className={`flex items-center gap-2 p-2 rounded-2xl border transition-all cursor-pointer ${
                            selectedGradientId === av.id
                              ? 'bg-white border-teal-500 ring-2 ring-teal-500/20 shadow-sm scale-105'
                              : 'bg-white/60 border-slate-200 hover:bg-white hover:border-slate-300'
                          }`}
                        >
                          <div
                            className={`w-8 h-8 rounded-xl bg-gradient-to-br ${av.bg} flex items-center justify-center text-white text-xs font-black shadow-2xs shrink-0`}
                          >
                            {avatarInitial}
                          </div>
                          <span className="text-[11px] font-bold text-slate-700 truncate">
                            {av.label}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}

                  {/* 3. 自定义图片与本地上传 */}
                  {avatarMode === 'custom' && (
                    <div className="pt-1">
                      <ImageUploader
                        value={customAvatarUrl}
                        onChange={(url) => {
                          setCustomAvatarUrl(url);
                          saveUserAvatar({
                            mode: 'custom',
                            presetId: selectedUserAvatarId,
                            gradientId: selectedGradientId,
                            customImageUrl: url,
                          });
                        }}
                        aspectRatio="round"
                        bucket="avatars"
                        maxWidth={512}
                        maxHeight={512}
                        description={t('settings.profAvatarHint')}
                      />
                    </div>
                  )}
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <label className="text-xs font-bold text-slate-800 flex items-center gap-1">
                      <span>{t('settings.profLegalName')}</span>
                      <span className="text-red-500">*</span>
                    </label>
                    <Input
                      value={fullName}
                      onChange={(e) => setFullName(e.target.value)}
                      placeholder={t('settings.profNamePlaceholder')}
                      className="rounded-xl"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-xs font-bold text-slate-800">{t('settings.profNickname')}</label>
                    <Input
                      value={nickname}
                      onChange={(e) => setNickname(e.target.value)}
                      placeholder={t('settings.profNicknamePlaceholder')}
                      className="rounded-xl"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <label className="text-xs font-bold text-slate-800">{t('settings.profLoginEmail')}</label>
                    <Input
                      value={session?.user.email || ''}
                      disabled
                      className="bg-slate-50 text-slate-500 rounded-xl cursor-not-allowed"
                    />
                    <p className="text-[11px] text-slate-400">{t('settings.profEmailNote')}</p>
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-xs font-bold text-slate-800">{t('settings.profPhone')}</label>
                    <Input
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      placeholder="+1 (555) 019-2834"
                      className="rounded-xl"
                    />
                    <p className="text-[11px] text-slate-400">{t('settings.profPhoneNote')}</p>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <label className="text-xs font-bold text-slate-800 flex items-center gap-1.5">
                      <Globe className="w-4 h-4 text-teal-600" />
                      <span>{t('settings.profLanguage')}</span>
                    </label>
                    <select
                      value={language}
                      onChange={(e) => setLanguage(e.target.value as Language)}
                      className="w-full h-10 px-3 bg-white border border-slate-200 rounded-xl text-xs font-semibold text-slate-800 outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20"
                    >
                      {LANGUAGES.map((l) => (
                        <option key={l.code} value={l.code}>
                          {l.label} ({l.code})
                        </option>
                      ))}
                    </select>
                    <p className="text-[11px] text-slate-400">{t('settings.profLanguageNote')}</p>
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-xs font-bold text-slate-800 flex items-center gap-1.5">
                      <Clock className="w-4 h-4 text-slate-400" />
                      <span>{t('settings.profTimezone')}</span>
                    </label>
                    <Input
                      value={context?.timezone || 'America/New_York (EST)'}
                      disabled
                      className="bg-slate-50 text-slate-500 rounded-xl cursor-not-allowed"
                    />
                    <p className="text-[11px] text-slate-400">{t('settings.profTimezoneNote')}</p>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-bold text-slate-800">{t('settings.profBio')}</label>
                  <textarea
                    value={bio}
                    onChange={(e) => setBio(e.target.value)}
                    rows={3}
                    placeholder={t('settings.profBioPlaceholder')}
                    className="w-full p-3 bg-white border border-slate-200 rounded-xl text-xs text-slate-800 outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20"
                  />
                </div>
              </CardContent>
            </Card>
          )}

          {/* ── TAB 2: 安全与登录 (Security & Auth) ─────────────────────────────── */}
          {activeTab === 'security' && (
            <div className="space-y-6">
              {/* 修改密码 */}
              <Card className="border border-slate-200 shadow-sm rounded-2xl bg-white overflow-hidden">
                <CardHeader className="bg-slate-50/50 px-6 py-4 border-b border-slate-100">
                  <div className="flex items-center gap-2">
                    <KeyRound className="w-4 h-4 text-teal-600" />
                    <CardTitle className="text-sm font-bold text-slate-900">{t('changePassword')}</CardTitle>
                  </div>
                  <CardDescription className="text-xs text-slate-500 mt-0.5">
                    
                    {t('settings.profPasswordNote')}
                  </CardDescription>
                </CardHeader>
                <CardContent className="p-6">
                  <form onSubmit={requestChangePassword} className="space-y-4 max-w-xl">
                    <div className="space-y-1.5">
                      <label className="text-xs font-bold text-slate-800">{t('currentPassword')}</label>
                      <div className="relative">
                        <Input
                          type={showPassword ? 'text' : 'password'}
                          value={oldPassword}
                          onChange={(e) => setOldPassword(e.target.value)}
                          placeholder="••••••••"
                          className="rounded-xl pr-10"
                        />
                        <button
                          type="button"
                          onClick={() => setShowPassword(!showPassword)}
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                        >
                          {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                        </button>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div className="space-y-1.5">
                        <label className="text-xs font-bold text-slate-800">{t('newPassword')}</label>
                        <Input
                          type={showPassword ? 'text' : 'password'}
                          value={newPassword}
                          onChange={(e) => setNewPassword(e.target.value)}
                          placeholder={t('settings.profPasswordMin')}
                          className="rounded-xl"
                        />
                      </div>

                      <div className="space-y-1.5">
                        <label className="text-xs font-bold text-slate-800">{t('confirmNewPassword')}</label>
                        <Input
                          type={showPassword ? 'text' : 'password'}
                          value={confirmPassword}
                          onChange={(e) => setConfirmPassword(e.target.value)}
                          placeholder={t('settings.profPasswordRepeat')}
                          className="rounded-xl"
                        />
                      </div>
                    </div>

                    {/* 密码强度指示器 */}
                    {newPassword && (
                      <div className="space-y-1.5 p-3 rounded-xl bg-slate-50 border border-slate-100">
                        <div className="flex items-center justify-between text-[11px] font-bold">
                          <span className="text-slate-500">{t('settings.profPasswordStrength')}</span>
                          <span className="text-slate-800">{passwordStrength.label}</span>
                        </div>
                        <div className="w-full h-1.5 bg-slate-200 rounded-full overflow-hidden flex gap-1">
                          {[1, 2, 3, 4].map((step) => (
                            <div
                              key={step}
                              className={`h-full flex-1 rounded-full transition-all ${
                                step <= passwordStrength.score ? passwordStrength.color : 'bg-slate-200'
                              }`}
                            />
                          ))}
                        </div>
                      </div>
                    )}

                    <Button
                      type="submit"
                      disabled={changePasswordMutation.isPending}
                      className="bg-slate-900 hover:bg-slate-800 text-white rounded-xl text-xs font-bold gap-2"
                    >
                      <Lock className="w-4 h-4" />
                      <span>{t('settings.profUpdatePassword')}</span>
                    </Button>
                  </form>
                </CardContent>
              </Card>

              {/* POS 快速锁屏 PIN 码 */}
              <Card className="border border-slate-200 shadow-sm rounded-2xl bg-white overflow-hidden">
                <CardHeader className="bg-slate-50/50 px-6 py-4 border-b border-slate-100 flex flex-row items-center justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <Smartphone className="w-4 h-4 text-teal-600" />
                      <CardTitle className="text-sm font-bold text-slate-900">{t('pinCodeTitle')}</CardTitle>
                    </div>
                    <CardDescription className="text-xs text-slate-500 mt-0.5">{t('pinCodeDesc')}</CardDescription>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setPinCode('');
                      setPinModalOpen(true);
                    }}
                    className="rounded-xl text-xs font-bold gap-1.5 border-slate-300"
                  >
                    <Sliders className="w-4 h-4" />
                    <span>{t('settings.profSetPin')}</span>
                  </Button>
                </CardHeader>
                <CardContent className="p-6">
                  <div className="flex items-center justify-between p-4 rounded-xl bg-slate-50 border border-slate-100">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-xl bg-teal-100 text-teal-700 flex items-center justify-center font-bold text-lg">
                        ••••
                      </div>
                      <div>
                        <h4 className="text-xs font-bold text-slate-800">{t('settings.profPinActive')}</h4>
                        <p className="text-[11px] text-slate-500 mt-0.5">
                          
                          {t('settings.profPinDesc')}
                        </p>
                      </div>
                    </div>
                    <Badge variant="success">{t('settings.profPinEnabled')}</Badge>
                  </div>
                </CardContent>
              </Card>

              {/* 活跃登录设备列表 */}
              <Card className="border border-slate-200 shadow-sm rounded-2xl bg-white overflow-hidden">
                <CardHeader className="bg-slate-50/50 px-6 py-4 border-b border-slate-100">
                  <div className="flex items-center gap-2">
                    <Laptop className="w-4 h-4 text-teal-600" />
                    <CardTitle className="text-sm font-bold text-slate-900">{t('activeSessions')}</CardTitle>
                  </div>
                  <CardDescription className="text-xs text-slate-500 mt-0.5">
                    
                    {t('settings.profSessionsDesc')}
                  </CardDescription>
                </CardHeader>
                <CardContent className="p-6 space-y-3">
                  {(sessions || []).map((sess) => (
                    <div
                      key={sess.id}
                      className="flex items-center justify-between p-4 rounded-xl border border-slate-100 hover:border-slate-200 bg-slate-50/50 transition-colors"
                    >
                      <div className="flex items-center gap-3.5">
                        <div
                          className={`w-10 h-10 rounded-xl flex items-center justify-center ${
                            sess.isCurrent ? 'bg-teal-100 text-teal-700' : 'bg-slate-100 text-slate-600'
                          }`}
                        >
                          {sess.deviceLabel.includes('iPad') ? (
                            <Tablet className="w-5 h-5" />
                          ) : sess.deviceLabel.includes('iPhone') || sess.deviceLabel.includes('Android') ? (
                            <Smartphone className="w-5 h-5" />
                          ) : (
                            <Laptop className="w-5 h-5" />
                          )}
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            <strong className="text-xs font-bold text-slate-900">{sess.deviceLabel}</strong>
                            {sess.isCurrent && (
                              <span className="px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 text-[10px] font-bold flex items-center gap-1">
                                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
                                <span>{t('currentDevice')}</span>
                              </span>
                            )}
                          </div>
                          <p className="text-[11px] text-slate-500 mt-0.5">
                            {sess.browser} · IP: {sess.ipAddress} · {sess.lastActiveAt}
                          </p>
                        </div>
                      </div>

                      {!sess.isCurrent && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => requestRevokeSession(sess.id, sess.deviceLabel)}
                          className="text-red-600 hover:bg-red-50 hover:text-red-700 text-xs font-semibold"
                        >
                          {t('revokeSession')}
                        </Button>
                      )}
                    </div>
                  ))}
                </CardContent>
              </Card>
            </div>
          )}

          {/* ── TAB 3: 门店与权限 (Store & Permissions) ───────────────────────── */}
          {activeTab === 'store_roles' && (
            <div className="space-y-6">
              {/* 当前门店卡片 */}
              <Card className="border border-slate-200 shadow-sm rounded-2xl bg-white overflow-hidden">
                <CardHeader className="bg-slate-50/50 px-6 py-4 border-b border-slate-100">
                  <div className="flex items-center gap-2">
                    <Building className="w-4 h-4 text-teal-600" />
                    <CardTitle className="text-sm font-bold text-slate-900">{t('settings.profOrgTitle')}</CardTitle>
                  </div>
                  <CardDescription className="text-xs text-slate-500 mt-0.5">
                    
                    {t('settings.profOrgDesc')}
                  </CardDescription>
                </CardHeader>
                <CardContent className="p-6 space-y-6">
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div className="p-4 rounded-xl bg-slate-50 border border-slate-100">
                      <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('settings.profCurrentStore')}</span>
                      <p className="text-sm font-bold text-slate-900 mt-1">{currentStoreName}</p>
                    </div>
                    <div className="p-4 rounded-xl bg-slate-50 border border-slate-100">
                      <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('settings.profAssignedRole')}</span>
                      <p className="text-sm font-bold text-teal-700 mt-1">{roleNames}</p>
                    </div>
                    <div className="p-4 rounded-xl bg-slate-50 border border-slate-100">
                      <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{t('settings.profPermissionCount')}</span>
                      <p className="text-sm font-bold text-slate-900 mt-1">
                        {allPermissions.length}  {t('settings.profCapabilities')}
                      </p>
                    </div>
                  </div>

                  {/* 权限搜索与清单分解 */}
                  <div className="space-y-3">
                    <div className="flex items-center justify-between gap-4">
                      <h4 className="text-xs font-bold text-slate-800 flex items-center gap-2">
                        <ShieldCheck className="w-4 h-4 text-teal-600" />
                        <span>{t('settings.profEffectivePermissions')}{filteredPermissions.length})</span>
                      </h4>
                      <div className="relative w-48">
                        <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                        <input
                          type="text"
                          value={permissionQuery}
                          onChange={(e) => setPermissionQuery(e.target.value)}
                          placeholder={t('settings.profFilterPermissions')}
                          className="w-full h-8 pl-8 pr-2 text-xs bg-slate-50 border border-slate-200 rounded-lg outline-none focus:border-teal-500 font-medium"
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2.5 max-h-64 overflow-y-auto p-1 custom-scrollbar">
                      {filteredPermissions.map((perm) => (
                        <div
                          key={perm}
                          className="flex items-center gap-2 p-2.5 rounded-xl border border-slate-100 bg-slate-50/70 text-xs font-medium text-slate-700 hover:bg-teal-50/50 hover:border-teal-200 transition-colors"
                        >
                          <CheckCircle2 className="w-3.5 h-3.5 text-teal-600 shrink-0" />
                          <span className="font-mono text-[11px] truncate">{perm}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* 多店列表切换（带两步确认） */}
                  {locations.length > 1 && (
                    <div className="space-y-3 pt-4 border-t border-slate-100">
                      <h4 className="text-xs font-bold text-slate-800 flex items-center gap-2">
                        <Store className="w-4 h-4 text-teal-600" />
                        <span>{t('settings.profMultiStore')}</span>
                      </h4>
                      <div className="space-y-2">
                        {locations.map((loc) => {
                          const isCurrent = loc.membershipId === membership?.membershipId;
                          const locName = pickText(loc.locationName, language);
                          return (
                            <div
                              key={loc.membershipId}
                              className="flex items-center justify-between p-3.5 rounded-xl border border-slate-200 bg-white hover:border-teal-500/50 transition-colors"
                            >
                              <div>
                                <strong className="text-xs font-bold text-slate-900">
                                  {locName}
                                </strong>
                                <p className="text-[11px] text-slate-500 mt-0.5">
                                  
                                  {t('settings.profRolePrefix')} {loc.roleKeys.join(', ')}  {t('settings.profStatusPrefix')} {loc.locationStatus}
                                </p>
                              </div>
                              {isCurrent ? (
                                <Badge variant="default">{t('settings.profCurrentlyHere')}</Badge>
                              ) : (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => requestSwitchLocation(loc.membershipId, locName)}
                                  className="text-xs rounded-xl font-bold"
                                >
                                  
                                  {t('settings.profSwitchTo')}
                                </Button>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          )}

          {/* ── TAB 4: 技师接单偏好 (Provider Settings) ────────────────────────── */}
          {activeTab === 'provider' && (
            <Card className="border border-slate-200 shadow-sm rounded-2xl bg-white overflow-hidden">
              <CardHeader className="bg-slate-50/50 px-6 py-4 border-b border-slate-100 flex flex-row items-center justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <Scissors className="w-4 h-4 text-teal-600" />
                    <CardTitle className="text-sm font-bold text-slate-900">{t('tabProvider')}</CardTitle>
                  </div>
                  <CardDescription className="text-xs text-slate-500 mt-0.5">
                    
                    {t('settings.profBookingDesc')}
                  </CardDescription>
                </div>
                <Button
                  onClick={requestSaveProviderSettings}
                  disabled={updateProfileMutation.isPending}
                  className="bg-teal-600 hover:bg-teal-700 text-white rounded-xl gap-2 text-xs font-bold"
                >
                  <Save className="w-4 h-4" />
                  <span>{t('save')}</span>
                </Button>
              </CardHeader>
              <CardContent className="p-6 space-y-6">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="p-4 rounded-xl border border-slate-200 bg-slate-50/50 space-y-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <label className="text-xs font-bold text-slate-800">{t('settings.profBookable')}</label>
                        <p className="text-[11px] text-slate-500 mt-0.5">{t('settings.profBookableDesc')}</p>
                      </div>
                      <input
                        type="checkbox"
                        checked={isBookable}
                        onChange={(e) => setIsBookable(e.target.checked)}
                        className="w-4 h-4 rounded text-teal-600 focus:ring-teal-500 cursor-pointer"
                      />
                    </div>
                  </div>

                  <div className="p-4 rounded-xl border border-slate-200 bg-slate-50/50 space-y-2">
                    <label className="text-xs font-bold text-slate-800">{t('settings.profMaxConcurrent')}</label>
                    <select
                      value={maxConcurrent}
                      onChange={(e) => setMaxConcurrent(e.target.value)}
                      className="w-full h-9 px-3 bg-white border border-slate-200 rounded-lg text-xs font-semibold text-slate-800 outline-none"
                    >
                      <option value="1">{t('settings.profConcurrent1')}</option>
                      <option value="2">{t('settings.profConcurrent2')}</option>
                      <option value="3">{t('settings.profConcurrent3')}</option>
                    </select>
                  </div>
                </div>

                {/* 技能标签管理 */}
                <div className="space-y-3">
                  <label className="text-xs font-bold text-slate-800 flex items-center gap-1.5">
                    <Tag className="w-4 h-4 text-teal-600" />
                    <span>{t('settings.profSkillsHeld')}{skills.length})</span>
                  </label>

                  <div className="flex flex-wrap items-center gap-2">
                    {skills.map((skill) => (
                      <span
                        key={skill}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-teal-50 text-teal-800 border border-teal-200 text-xs font-bold shadow-xs"
                      >
                        <span>{skill}</span>
                        <button
                          type="button"
                          onClick={() => handleRemoveSkill(skill)}
                          className="text-teal-600 hover:text-teal-900 rounded-full font-bold ml-0.5"
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>

                  {/* 快捷推荐技能标签 */}
                  <div className="space-y-1.5 pt-2">
                    <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">
                      
                      {t('settings.profSuggestedSkills')}
                    </span>
                    <div className="flex flex-wrap gap-1.5">
                      {PRESET_SALON_SKILLS.filter((s) => !skills.includes(s)).map((preset) => (
                        <button
                          key={preset}
                          type="button"
                          onClick={() => handleAddSkill(preset)}
                          className="px-2.5 py-1 rounded-lg bg-slate-100 hover:bg-teal-50 hover:text-teal-700 text-slate-600 text-xs font-medium transition-colors border border-slate-200/60"
                        >
                          + {preset}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 max-w-md pt-2">
                    <Input
                      value={newSkillInput}
                      onChange={(e) => setNewSkillInput(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), handleAddSkill())}
                      placeholder={t('settings.profCustomSkillPlaceholder')}
                      className="rounded-xl text-xs"
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleAddSkill()}
                      className="rounded-xl text-xs font-bold shrink-0"
                    >
                      
                      {t('settings.profAddSkill')}
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {/* ── TAB 5: 个人通知偏好 (Notification Preferences) ────────────────── */}
          {activeTab === 'notifications' && (
            <Card className="border border-slate-200 shadow-sm rounded-2xl bg-white overflow-hidden">
              <CardHeader className="bg-slate-50/50 px-6 py-4 border-b border-slate-100 flex flex-row items-center justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <Bell className="w-4 h-4 text-teal-600" />
                    <CardTitle className="text-sm font-bold text-slate-900">{t('tabNotificationPrefs')}</CardTitle>
                  </div>
                  <CardDescription className="text-xs text-slate-500 mt-0.5">
                    
                    {t('settings.profNotifDesc')}
                  </CardDescription>
                </div>
                <Button
                  onClick={requestSaveNotificationPrefs}
                  disabled={saveNotifPrefsMutation.isPending}
                  className="bg-teal-600 hover:bg-teal-700 text-white rounded-xl gap-2 text-xs font-bold"
                >
                  <Save className="w-4 h-4" />
                  <span>{t('save')}</span>
                </Button>
              </CardHeader>
              <CardContent className="p-6 space-y-6">
                {localNotifPrefs && (
                  <div className="space-y-6">
                    {/* 应用内实时推送 */}
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <h4 className="text-xs font-bold text-slate-900 uppercase tracking-wider text-teal-800 flex items-center gap-2">
                          <Bell className="w-4 h-4" />
                          <span>{t('settings.profInAppTitle')}</span>
                        </h4>
                        <button
                          type="button"
                          onClick={() => {
                            setLocalNotifPrefs({
                              ...localNotifPrefs,
                              inApp: {
                                appointmentNew: true,
                                appointmentChanged: true,
                                appointmentCancelled: true,
                                paymentFailed: true,
                                customerFeedback: true,
                                payoutSettled: true,
                                systemSecurity: true,
                              },
                            });
                            toast.success(t('settings.profRecommendedApplied'));
                          }}
                          className="text-xs font-bold text-teal-600 hover:text-teal-700"
                        >
                          
                          {t('settings.profEnableAll')}
                        </button>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        {[
                          { key: 'appointmentNew', label: t('settings.profNotifNewBooking'), desc: t('settings.profNotifNewBookingDesc') },
                          { key: 'appointmentChanged', label: t('settings.profNotifChanged'), desc: t('settings.profNotifChangedDesc') },
                          { key: 'paymentFailed', label: t('settings.profNotifPaymentFailed'), desc: t('settings.profNotifPaymentFailedDesc') },
                          { key: 'customerFeedback', label: t('settings.profNotifReview'), desc: t('settings.profNotifReviewDesc') },
                          { key: 'payoutSettled', label: t('settings.profNotifPayout'), desc: t('settings.profNotifPayoutDesc') },
                          { key: 'systemSecurity', label: t('settings.profNotifSecurity'), desc: t('settings.profNotifSecurityDesc') },
                        ].map((item) => (
                          <div
                            key={item.key}
                            className="flex items-start justify-between p-3.5 rounded-xl border border-slate-100 bg-slate-50/50 hover:bg-slate-50 transition-colors"
                          >
                            <div className="space-y-0.5 pr-2">
                              <label className="text-xs font-bold text-slate-800">{item.label}</label>
                              <p className="text-[11px] text-slate-500">{item.desc}</p>
                            </div>
                            <input
                              type="checkbox"
                              checked={(localNotifPrefs.inApp as any)[item.key]}
                              onChange={(e) =>
                                setLocalNotifPrefs({
                                  ...localNotifPrefs,
                                  inApp: { ...localNotifPrefs.inApp, [item.key]: e.target.checked },
                                })
                              }
                              className="w-4 h-4 rounded text-teal-600 focus:ring-teal-500 mt-0.5 cursor-pointer"
                            />
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* 手机短信渠道 */}
                    <div className="space-y-3 pt-4 border-t border-slate-100">
                      <h4 className="text-xs font-bold text-slate-900 uppercase tracking-wider text-teal-800 flex items-center gap-2">
                        <Smartphone className="w-4 h-4" />
                        <span>{t('settings.profSmsTitle')}</span>
                      </h4>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        {[
                          { key: 'appointmentNew', label: t('settings.profSmsUrgent'), desc: t('settings.profSmsUrgentDesc') },
                          { key: 'emergencyAlerts', label: t('settings.profSmsOps'), desc: t('settings.profSmsOpsDesc') },
                        ].map((item) => (
                          <div
                            key={item.key}
                            className="flex items-start justify-between p-3.5 rounded-xl border border-slate-100 bg-slate-50/50"
                          >
                            <div className="space-y-0.5 pr-2">
                              <label className="text-xs font-bold text-slate-800">{item.label}</label>
                              <p className="text-[11px] text-slate-500">{item.desc}</p>
                            </div>
                            <input
                              type="checkbox"
                              checked={(localNotifPrefs.sms as any)[item.key]}
                              onChange={(e) =>
                                setLocalNotifPrefs({
                                  ...localNotifPrefs,
                                  sms: { ...localNotifPrefs.sms, [item.key]: e.target.checked },
                                })
                              }
                              className="w-4 h-4 rounded text-teal-600 focus:ring-teal-500 mt-0.5 cursor-pointer"
                            />
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* 邮件报告 */}
                    <div className="space-y-3 pt-4 border-t border-slate-100">
                      <h4 className="text-xs font-bold text-slate-900 uppercase tracking-wider text-teal-800 flex items-center gap-2">
                        <Mail className="w-4 h-4" />
                        <span>{t('settings.profEmailTitle')}</span>
                      </h4>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        {[
                          { key: 'dailyDigest', label: t('settings.profEmailDaily'), desc: t('settings.profEmailDailyDesc') },
                          { key: 'securityAlerts', label: t('settings.profEmailSecurity'), desc: t('settings.profEmailSecurityDesc') },
                        ].map((item) => (
                          <div
                            key={item.key}
                            className="flex items-start justify-between p-3.5 rounded-xl border border-slate-100 bg-slate-50/50"
                          >
                            <div className="space-y-0.5 pr-2">
                              <label className="text-xs font-bold text-slate-800">{item.label}</label>
                              <p className="text-[11px] text-slate-500">{item.desc}</p>
                            </div>
                            <input
                              type="checkbox"
                              checked={(localNotifPrefs.email as any)[item.key]}
                              onChange={(e) =>
                                setLocalNotifPrefs({
                                  ...localNotifPrefs,
                                  email: { ...localNotifPrefs.email, [item.key]: e.target.checked },
                                })
                              }
                              className="w-4 h-4 rounded text-teal-600 focus:ring-teal-500 mt-0.5 cursor-pointer"
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </motion.div>
      </AnimatePresence>

      {/* ── 现代化 PIN 码锁屏设置 Modal ───────────────────────────────────── */}
      <Modal isOpen={pinModalOpen} onOpenChange={setPinModalOpen} title="Set POS / iPad Unlock PIN">
        <div className="space-y-5 p-4">
          <p className="text-xs text-slate-500 text-center leading-relaxed">
            
            {t('settings.profPinModalDesc')}
          </p>

          {/* PIN 视觉圆点展示 */}
          <div className="flex items-center justify-center gap-3 py-3">
            {[0, 1, 2, 3, 4, 5].map((i) => {
              const isFilled = i < pinCode.length;
              return (
                <div
                  key={i}
                  className={`w-4 h-4 rounded-full border-2 transition-all ${
                    isFilled ? 'bg-teal-600 border-teal-600 scale-110 shadow-sm' : 'border-slate-300 bg-slate-100'
                  }`}
                />
              );
            })}
          </div>

          {/* 触控数字键盘 */}
          <div className="grid grid-cols-3 gap-2.5 max-w-xs mx-auto">
            {['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clear', '0', 'backspace'].map((key) => {
              if (key === 'clear') {
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => handlePinKeypadPress('clear')}
                    className="h-12 rounded-2xl bg-slate-100 hover:bg-slate-200 text-slate-600 text-xs font-bold transition-all active:scale-95"
                  >
                    
                    {t('settings.profPinClear')}
                  </button>
                );
              }
              if (key === 'backspace') {
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => handlePinKeypadPress('backspace')}
                    className="h-12 rounded-2xl bg-slate-100 hover:bg-slate-200 text-slate-600 flex items-center justify-center transition-all active:scale-95"
                  >
                    <Delete className="w-5 h-5" />
                  </button>
                );
              }
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => handlePinKeypadPress(key)}
                  className="h-12 rounded-2xl bg-white border border-slate-200 hover:bg-teal-50 hover:border-teal-500 text-slate-900 text-lg font-bold shadow-xs transition-all active:scale-95"
                >
                  {key}
                </button>
              );
            })}
          </div>

          <div className="flex justify-end gap-2 pt-3 border-t border-slate-100">
            <Button variant="ghost" onClick={() => setPinModalOpen(false)}>
              {t('cancel')}
            </Button>
            <Button
              onClick={requestSetPin}
              disabled={setPinMutation.isPending || pinCode.length < 4}
              className="bg-teal-600 hover:bg-teal-700 text-white font-bold"
            >
              
              {t('settings.profPinSavePrefix')}{pinCode.length}  {t('settings.profPinSaveSuffix')}
            </Button>
          </div>
        </div>
      </Modal>

      {/* ── 全局两步确认弹窗 (Two-Step Confirmation Dialog) ───────────────── */}
      <ConfirmDialog
        isOpen={confirmDialogState.isOpen}
        onOpenChange={(open) => !open && setConfirmDialogState((prev) => ({ ...prev, isOpen: false }))}
        title={confirmDialogState.title}
        description={confirmDialogState.description}
        tone={confirmDialogState.tone || 'default'}
        confirmLabel={confirmDialogState.confirmLabel || t('confirm')}
        onConfirm={executeConfirmedAction}
      />
    </div>
  );
}
