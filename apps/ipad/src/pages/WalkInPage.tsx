import React, { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLanguage } from '../context/LanguageContext';
import { useDeviceAuth } from '../context/DeviceAuthContext';
import { api } from '../api/client';
import type { GuestIntake } from '../types';
import { formatPhoneInput } from '../utils/phone';
import {
  ArrowLeft,
  User,
  Users,
  Sparkles,
  Phone,
  Mail,
  Clock,
  Plus,
  Trash2,
  Check,
  Loader2,
} from 'lucide-react';

export const WalkInPage: React.FC = () => {
  const navigate = useNavigate();
  const { t, pickText } = useLanguage();
  const { storeInfo } = useDeviceAuth();

  const services = storeInfo?.services ?? [];

  // 多位客人信息录入列表
  const [guests, setGuests] = useState<GuestIntake[]>([
    {
      id: 'guest-1',
      name: '',
      phone: '',
      email: '',
      serviceId: services[0]?.id ?? null,
      addonIds: [],
    },
  ]);

  const [activeGuestIdx, setActiveGuestIdx] = useState(0);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const idempotencyKey = useRef(
    typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-walkin`,
  );

  const handleUpdateGuest = (index: number, patch: Partial<GuestIntake>) => {
    setGuests((prev) => {
      const next = [...prev];
      next[index] = { ...next[index]!, ...patch };
      return next;
    });
    setErrorMsg(null);
  };

  const handleAddGuest = () => {
    if (guests.length >= 8) return;
    const nextIdx = guests.length + 1;
    setGuests((prev) => [
      ...prev,
      {
        id: `guest-${nextIdx}`,
        name: '',
        phone: prev[0]?.phone || '', // 默认继承主联系人电话，方便同伴快捷录入
        email: '',
        serviceId: services[0]?.id ?? null,
        addonIds: [],
      },
    ]);
    setActiveGuestIdx(guests.length);
  };

  const handleRemoveGuest = (index: number) => {
    if (guests.length <= 1) return;
    setGuests((prev) => prev.filter((_, i) => i !== index));
    if (activeGuestIdx >= index && activeGuestIdx > 0) {
      setActiveGuestIdx(activeGuestIdx - 1);
    }
  };

  const handleSelectService = (serviceId: string | null) => {
    handleUpdateGuest(activeGuestIdx, { serviceId });
  };

  const handleJoinQueue = async (e: React.FormEvent) => {
    e.preventDefault();

    // 校验每位客人的姓名与电话
    for (let i = 0; i < guests.length; i++) {
      const g = guests[i]!;
      if (!g.name.trim()) {
        setActiveGuestIdx(i);
        setErrorMsg(t('walkin.nameRequired'));
        return;
      }
      if (!g.phone.trim()) {
        setActiveGuestIdx(i);
        setErrorMsg(t('checkin.phoneTooShort'));
        return;
      }
    }

    setIsSubmitting(true);
    setErrorMsg(null);

    try {
      const leadGuest = guests[0]!;
      // 1. 发起 Walk-in 排队
      const queueRes = await api.walkIn({
        name: leadGuest.name.trim(),
        phone: leadGuest.phone.trim(),
        ...(leadGuest.email?.trim() ? { email: leadGuest.email.trim() } : {}),
        serviceId: leadGuest.serviceId ?? undefined,
        partySize: guests.length,
        idempotencyKey: idempotencyKey.current,
      });

      // 2. 检查所选服务是否需要健康表
      const formsRes = await api.getRequiredForms({
        appointmentId: queueRes.appointmentId,
      });

      if (formsRes.forms.length === 0) {
        navigate('/success', {
          replace: true,
          state: { queueResult: queueRes, customerName: leadGuest.name.trim() },
        });
        return;
      }

      // 逐位客人在 Kiosk 上完成后端持久化的健康表。
      navigate('/health-form', {
        state: {
          appointmentId: queueRes.appointmentId,
          queueId: queueRes.queueId,
          queueResult: queueRes,
          forms: formsRes.forms ?? [],
          guests: guests.map((g) => ({
            ...g,
            name: g.name.trim(),
            phone: g.phone.trim(),
            email: g.email?.trim() || '',
          })),
        },
      });
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to join queue');
      setIsSubmitting(false);
    }
  };

  const currentGuest = guests[activeGuestIdx] || guests[0]!;

  return (
    <div className="flex-1 flex flex-col p-6 sm:p-10 max-w-4xl w-full mx-auto select-none overflow-y-auto">
      {/* 顶部导航返回 */}
      <div className="flex items-center justify-between pb-4">
        <button
          type="button"
          onClick={() => navigate('/')}
          className="kiosk-touch-target px-4 py-2.5 rounded-2xl bg-white hover:bg-slate-100 text-slate-700 font-bold text-sm flex items-center gap-2 border border-slate-200 shadow-2xs transition-colors active:scale-95"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>{t('common.back')}</span>
        </button>

        <div className="flex items-center gap-2 text-xs font-bold text-teal-800 bg-teal-50 px-3.5 py-1.5 rounded-full border border-teal-200">
          <Users className="w-4 h-4 text-teal-600" />
          <span>
            {guests.length} {t('ticket.parties')}
          </span>
        </div>
      </div>

      <form onSubmit={handleJoinQueue} className="space-y-6 animate-fade-in pb-16">
        {/* 标题 */}
        <div className="text-center space-y-1">
          <h2 className="text-3xl sm:text-4xl font-extrabold text-slate-900">{t('walkin.title')}</h2>
          <p className="text-sm text-slate-500 max-w-md mx-auto">
            {t('home.walkInDesc')}
          </p>
        </div>

        {/* 多人切换标签栏 */}
        <div className="flex flex-wrap items-center gap-2.5 p-2 bg-white rounded-3xl border border-slate-200 shadow-xs">
          {guests.map((g, idx) => {
            const isCurrent = activeGuestIdx === idx;
            const displayName = g.name.trim() || t('walkin.guestTab', { index: idx + 1 });
            return (
              <button
                key={g.id}
                type="button"
                onClick={() => setActiveGuestIdx(idx)}
                className={`kiosk-touch-target px-4 py-2.5 rounded-2xl font-bold text-sm transition-all flex items-center gap-2 ${
                  isCurrent
                    ? 'bg-teal-600 text-white shadow-sm'
                    : 'bg-slate-50 text-slate-700 hover:bg-slate-100 border border-slate-200/80'
                }`}
              >
                <User className="w-4 h-4" />
                <span className="max-w-[120px] truncate">{displayName}</span>
              </button>
            );
          })}

          {guests.length < 6 && (
            <button
              type="button"
              onClick={handleAddGuest}
              className="kiosk-touch-target px-4 py-2.5 rounded-2xl bg-teal-50 hover:bg-teal-100 active:bg-teal-200 text-teal-800 font-bold text-sm border border-teal-200/80 flex items-center gap-1.5 transition-colors"
            >
              <Plus className="w-4 h-4 text-teal-600" />
              <span>{t('walkin.addGuest')}</span>
            </button>
          )}
        </div>

        {/* 当前选中客人的信息录入卡片 */}
        <div className="rounded-3xl bg-white border border-slate-200/90 p-6 sm:p-8 space-y-6 shadow-sm relative">
          <div className="flex items-center justify-between border-b border-slate-100 pb-4">
            <div className="flex items-center gap-2 text-teal-800 font-bold text-base">
              <User className="w-5 h-5 text-teal-600" />
              <span>
                {t('walkin.guestTab', { index: activeGuestIdx + 1 })}{' '}
                {currentGuest.name && `· ${currentGuest.name}`}
              </span>
            </div>

            {guests.length > 1 && (
              <button
                type="button"
                onClick={() => handleRemoveGuest(activeGuestIdx)}
                className="text-xs text-rose-600 hover:text-rose-700 hover:bg-rose-50 px-3 py-1.5 rounded-xl font-bold transition-colors flex items-center gap-1"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>{t('walkin.removeGuest')}</span>
              </button>
            )}
          </div>

          {/* 姓名、电话与邮箱 */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* 姓名 */}
            <div className="space-y-2">
              <label className="flex items-center gap-1.5 text-xs font-bold text-slate-700">
                <User className="w-3.5 h-3.5 text-teal-600" />
                <span>{t('walkin.nameTitle')}</span>
                <span className="text-rose-500">*</span>
              </label>
              <input
                type="text"
                value={currentGuest.name}
                onChange={(e) => handleUpdateGuest(activeGuestIdx, { name: e.target.value })}
                placeholder={t('walkin.namePlaceholder')}
                autoComplete="off"
                autoCorrect="off"
                spellCheck="false"
                className="kiosk-touch-target w-full px-4 py-3.5 rounded-2xl bg-slate-50 border border-slate-200 text-base font-bold text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-teal-600 focus:bg-white transition-colors shadow-inner"
              />
            </div>

            {/* 手机号码 */}
            <div className="space-y-2">
              <label className="flex items-center gap-1.5 text-xs font-bold text-slate-700">
                <Phone className="w-3.5 h-3.5 text-teal-600" />
                <span>{t('walkin.phoneTitle')}</span>
                <span className="text-rose-500">*</span>
              </label>
              <input
                type="tel"
                value={currentGuest.phone}
                onChange={(e) => handleUpdateGuest(activeGuestIdx, { phone: formatPhoneInput(e.target.value) })}
                placeholder="(555) 000-0000"
                maxLength={14}
                autoComplete="off"
                autoCorrect="off"
                className="kiosk-touch-target w-full px-4 py-3.5 rounded-2xl bg-slate-50 border border-slate-200 text-base font-bold text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-teal-600 focus:bg-white transition-colors shadow-inner"
              />
            </div>

            {/* 电子邮箱 */}
            <div className="sm:col-span-2 space-y-2">
              <div className="flex items-center justify-between">
                <label className="flex items-center gap-1.5 text-xs font-bold text-slate-700">
                  <Mail className="w-3.5 h-3.5 text-teal-600" />
                  <span>{t('walkin.emailTitle')}</span>
                </label>
                <span className="text-[11px] text-slate-400 font-medium">{t('common.optional')}</span>
              </div>
              <input
                type="email"
                value={currentGuest.email || ''}
                onChange={(e) => handleUpdateGuest(activeGuestIdx, { email: e.target.value })}
                placeholder={t('walkin.emailPlaceholder')}
                autoComplete="off"
                autoCorrect="off"
                spellCheck="false"
                className="kiosk-touch-target w-full px-4 py-3 rounded-2xl bg-slate-50 border border-slate-200 text-sm font-semibold text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-teal-600 focus:bg-white transition-colors shadow-inner"
              />
            </div>
          </div>

          {/* 选择主服务项目 */}
          <div className="space-y-3 pt-2">
            <div className="flex items-center justify-between">
              <label className="flex items-center gap-2 text-sm font-bold text-slate-900">
                <Sparkles className="w-4 h-4 text-teal-600" />
                <span>{t('walkin.serviceTitle')}</span>
              </label>
              <span className="text-xs text-slate-400 font-medium">{t('common.optional')}</span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2.5">
              {/* 先取号选项 */}
              <button
                type="button"
                onClick={() => handleSelectService(null)}
                className={`kiosk-touch-target p-3.5 rounded-2xl border-2 text-left transition-all flex flex-col justify-between gap-1 active:scale-95 ${
                  currentGuest.serviceId === null
                    ? 'bg-teal-50 border-teal-600 text-teal-950 font-bold shadow-xs'
                    : 'bg-slate-50 border-slate-200 text-slate-700 hover:border-slate-300'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold">{t('walkin.skipService')}</span>
                  {currentGuest.serviceId === null && <Check className="w-4 h-4 text-teal-600" />}
                </div>
              </button>

              {/* 门店主服务列表 */}
              {services.map((svc) => {
                const isSelected = currentGuest.serviceId === svc.id;
                const svcName = pickText(svc.name, 'Service');
                return (
                  <button
                    key={svc.id}
                    type="button"
                    onClick={() => handleSelectService(svc.id)}
                    className={`kiosk-touch-target p-3.5 rounded-2xl border-2 text-left transition-all flex flex-col justify-between gap-1.5 active:scale-95 ${
                      isSelected
                        ? 'bg-teal-50 border-teal-600 text-teal-950 font-bold shadow-xs'
                        : 'bg-slate-50 border-slate-200 text-slate-700 hover:border-slate-300'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-bold truncate">{svcName}</span>
                      {isSelected && <Check className="w-4 h-4 text-teal-600 shrink-0" />}
                    </div>
                    {svc.durationMin > 0 && (
                      <div className="flex items-center gap-1 text-[11px] text-slate-500 font-medium">
                        <Clock className="w-3 h-3 text-teal-600" />
                        <span>{svc.durationMin} {t('ticket.minutes')}</span>
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

        </div>

        {errorMsg && (
          <div className="p-4 rounded-2xl bg-rose-50 border border-rose-200 text-rose-600 text-sm font-semibold text-center">
            {errorMsg}
          </div>
        )}

        {/* 提交排队取号与健康表生成按钮 */}
        <div className="pt-2">
          <button
            type="submit"
            disabled={isSubmitting}
            className="kiosk-touch-target w-full py-5 rounded-2xl bg-teal-600 hover:bg-teal-700 active:scale-[0.98] disabled:opacity-40 text-white font-extrabold text-xl shadow-sm transition-all flex items-center justify-center gap-2"
          >
            {isSubmitting ? (
              <>
                <Loader2 className="w-6 h-6 animate-spin" />
                <span>{t('common.loading')}</span>
              </>
            ) : (
              <span>
                {guests.length > 1
                  ? `${t('walkin.joinButton')} (${guests.length} 位)`
                  : t('walkin.joinButton')}
              </span>
            )}
          </button>
        </div>
      </form>
    </div>
  );
};
