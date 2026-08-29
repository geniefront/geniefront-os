import React, { useState, useMemo, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useLanguage } from '../context/LanguageContext';
import { useDeviceAuth } from '../context/DeviceAuthContext';
import type {
  KioskFormTemplateDto,
  GuestIntake,
  QueueJoinResult,
} from '../types';
import { QRCodeSVG } from 'qrcode.react';
import {
  ArrowLeft,
  QrCode,
  Tablet,
  CheckCircle2,
  User,
  ShieldCheck,
  ChevronRight,
  ExternalLink,
} from 'lucide-react';

interface LocationState {
  appointmentId?: string;
  queueId?: string;
  queueResult?: QueueJoinResult;
  forms?: KioskFormTemplateDto[];
  guests?: GuestIntake[];
  phone?: string;
  customerName?: string;
}

export const HealthFormPage: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const { t, pickText } = useLanguage();
  const { storeInfo } = useDeviceAuth();

  const state = (location.state as LocationState) || {};
  const appointmentId = state.appointmentId;
  const queueId = state.queueId;
  const queueResult = state.queueResult;

  // 标准化客人列表（支持单人与多人）
  const [guestList, setGuestList] = useState<GuestIntake[]>(() => {
    if (state.guests && state.guests.length > 0) {
      return state.guests;
    }
    return [
      {
        id: 'guest-1',
        name: state.customerName || 'Guest',
        phone: state.phone || '',
        email: '',
        serviceId: null,
        addonIds: [],
        isFormSubmitted: false,
      },
    ];
  });

  const [activeGuestIdx, setActiveGuestIdx] = useState(0);
  const [fillMode, setFillMode] = useState<'pad' | 'qr'>('pad');

  // 当前活动的健康表模板
  const formTemplate: KioskFormTemplateDto = useMemo(() => {
    if (state.forms && state.forms.length > 0) {
      return state.forms[0]!;
    }
    return {
      templateId: 'default-intake',
      key: 'massage_intake',
      version: 1,
      title: {
        'zh-Hans': '理疗与健康安全排查表',
        en: 'Health & Safety Intake Waiver',
        ko: '건강 및 안전 설문지',
        es: 'Formulario de Salud y Exención',
        vi: 'Phiếu Khai Báo Sức Khỏe & Miễn Trừ',
      },
      questions: [],
      requiresSignature: true,
    };
  }, [state.forms]);

  const currentGuest = guestList[activeGuestIdx] || guestList[0]!;

  // 构建前台 Web 健康表嵌入 URL
  const iframeUrl = useMemo(() => {
    const origin = window.location.origin.includes(':5178')
      ? window.location.origin.replace(':5178', ':5177')
      : window.location.origin;
    const formKey = formTemplate.key || 'massage_intake';
    const params = new URLSearchParams({
      name: currentGuest.name || '',
      phone: currentGuest.phone || '',
      kiosk: '1',
      ...(queueId ? { queueId } : {}),
      ...(appointmentId ? { appointmentId } : {}),
    });
    return `${origin}/forms/${formKey}?${params.toString()}`;
  }, [formTemplate.key, currentGuest.name, currentGuest.phone, queueId, appointmentId]);

  // 监听内嵌 iframe 发送的表单提交完成信令
  useEffect(() => {
    const handleMessage = (e: MessageEvent) => {
      if (e.data?.type === 'GF_KIOSK_FORM_SUBMITTED') {
        const updatedList = [...guestList];
        updatedList[activeGuestIdx] = {
          ...updatedList[activeGuestIdx]!,
          isFormSubmitted: true,
        };
        setGuestList(updatedList);

        const nextPendingIdx = updatedList.findIndex((g) => !g.isFormSubmitted);
        if (nextPendingIdx !== -1) {
          setActiveGuestIdx(nextPendingIdx);
        } else {
          handleFinishAll();
        }
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [guestList, activeGuestIdx]);

  const handleFinishAll = () => {
    navigate('/success', {
      state: {
        appointmentId,
        queueId,
        ticketNumber: queueResult?.ticketNumber,
        aheadCount: queueResult?.aheadCount,
        quotedWaitMin: queueResult?.quotedWaitMin,
        businessDate: queueResult?.businessDate || storeInfo?.businessDate,
        partySize: guestList.length,
      },
    });
  };

  // 生成供手机扫码填写的 URL
  const getMobileFormUrl = (guest: GuestIntake) => {
    const origin = window.location.origin.includes(':5178')
      ? window.location.origin.replace(':5178', ':5177')
      : window.location.origin;
    const formKey = formTemplate.key || 'massage_intake';
    const params = new URLSearchParams({
      name: guest.name,
      phone: guest.phone,
      ...(queueId ? { queueId } : {}),
      ...(appointmentId ? { appointmentId } : {}),
    });
    return `${origin}/forms/${formKey}?${params.toString()}`;
  };

  return (
    <div className="flex-1 flex flex-col p-4 sm:p-8 max-w-6xl w-full mx-auto select-none overflow-y-auto">
      {/* 顶部返回与模式切换 */}
      <div className="flex items-center justify-between pb-4">
        <button
          type="button"
          onClick={() => navigate(-1)}
          className="kiosk-touch-target px-4 py-2.5 rounded-2xl bg-white hover:bg-slate-100 text-slate-700 font-bold text-sm flex items-center gap-2 border border-slate-200 shadow-2xs transition-colors active:scale-95"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>{t('common.back')}</span>
        </button>

        {/* 模式切换：Pad 内嵌填写 vs 手机扫码填写 */}
        <div className="flex items-center gap-1.5 p-1 bg-slate-200/80 rounded-2xl">
          <button
            type="button"
            onClick={() => setFillMode('pad')}
            className={`kiosk-touch-target px-4 py-2 rounded-xl text-xs sm:text-sm font-bold transition-all flex items-center gap-1.5 ${
              fillMode === 'pad'
                ? 'bg-white text-teal-800 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <Tablet className="w-4 h-4 text-teal-600" />
            <span>{t('health.modePad')}</span>
          </button>
          <button
            type="button"
            onClick={() => setFillMode('qr')}
            className={`kiosk-touch-target px-4 py-2 rounded-xl text-xs sm:text-sm font-bold transition-all flex items-center gap-1.5 ${
              fillMode === 'qr'
                ? 'bg-white text-teal-800 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <QrCode className="w-4 h-4 text-teal-600" />
            <span>{t('health.modeQr')}</span>
          </button>
        </div>
      </div>

      <div className="space-y-4 animate-fade-in pb-12 flex-1 flex flex-col">
        {/* 标题说明 */}
        <div className="flex flex-col sm:flex-row items-center justify-between gap-3 border-b border-slate-200 pb-3">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-teal-50 border border-teal-200 text-teal-700 flex items-center justify-center font-bold">
              <ShieldCheck className="w-5 h-5 text-teal-600" />
            </div>
            <div>
              <h2 className="text-xl sm:text-2xl font-extrabold text-slate-900">
                {pickText(formTemplate.title, 'Health Intake Form')}
              </h2>
              <p className="text-xs text-slate-500">
                {t('health.multiGuestsDesc')}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={handleFinishAll}
            className="kiosk-touch-target px-5 py-2.5 rounded-2xl bg-teal-600 hover:bg-teal-700 active:scale-95 text-white font-bold text-sm shadow-sm transition-all flex items-center gap-1.5 shrink-0"
          >
            <span>{t('health.finishAll')}</span>
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>

        {/* 同行多客人切换标签栏 */}
        {guestList.length > 1 && (
          <div className="flex flex-wrap items-center gap-2 p-2 bg-white rounded-2xl border border-slate-200 shadow-2xs">
            {guestList.map((guest, idx) => {
              const isCurrent = activeGuestIdx === idx;
              const isDone = guest.isFormSubmitted;
              return (
                <button
                  key={guest.id}
                  type="button"
                  onClick={() => setActiveGuestIdx(idx)}
                  className={`kiosk-touch-target px-4 py-2 rounded-xl font-bold text-xs sm:text-sm transition-all flex items-center gap-2 ${
                    isCurrent
                      ? 'bg-teal-600 text-white shadow-xs'
                      : isDone
                        ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                        : 'bg-slate-50 text-slate-700 hover:bg-slate-100 border border-slate-200'
                  }`}
                >
                  <User className="w-3.5 h-3.5" />
                  <span>{guest.name || `Guest ${idx + 1}`}</span>
                  {isDone ? (
                    <span className="text-[10px] bg-emerald-600 text-white px-1.5 py-0.5 rounded-full font-black">
                      ✓
                    </span>
                  ) : (
                    <span className="text-[10px] opacity-75 font-normal">
                      {t('health.guestStatusPending')}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}

        {/* ── 模式 1：iPad 内嵌浏览器视图 (Embedded Web View) ── */}
        {fillMode === 'pad' && (
          <div className="w-full flex-1 min-h-[720px] bg-white rounded-3xl border border-slate-200 shadow-md overflow-hidden relative flex flex-col">
            <iframe
              key={`${currentGuest.id}-${activeGuestIdx}`}
              src={iframeUrl}
              title="Health Form Web View"
              className="w-full flex-1 border-0 rounded-3xl"
            />
          </div>
        )}

        {/* ── 模式 2：手机扫码填写 (QR Code Mode) ── */}
        {fillMode === 'qr' && (
          <div className="space-y-6 pt-2">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {guestList.map((guest, idx) => {
                const qrUrl = getMobileFormUrl(guest);
                const isDone = guest.isFormSubmitted;
                return (
                  <div
                    key={guest.id}
                    className={`rounded-3xl bg-white border p-6 flex flex-col items-center text-center space-y-4 shadow-sm transition-all ${
                      isDone
                        ? 'border-emerald-300 bg-emerald-50/30 ring-2 ring-emerald-400/20'
                        : 'border-slate-200/90'
                    }`}
                  >
                    <div className="flex items-center justify-between w-full border-b border-slate-100 pb-3">
                      <div className="flex items-center gap-2 text-sm font-extrabold text-slate-900">
                        <User className="w-4 h-4 text-teal-600" />
                        <span>
                          {guest.name || `Guest ${idx + 1}`}
                        </span>
                      </div>
                      {isDone ? (
                        <span className="px-2.5 py-0.5 rounded-full text-xs font-bold bg-emerald-100 text-emerald-800 border border-emerald-200">
                          {t('health.guestStatusDone')}
                        </span>
                      ) : (
                        <span className="px-2.5 py-0.5 rounded-full text-xs font-bold bg-amber-50 text-amber-800 border border-amber-200">
                          {t('health.guestStatusPending')}
                        </span>
                      )}
                    </div>

                    {/* 二维码展示 */}
                    <div className="p-4 bg-white rounded-2xl border border-slate-200 shadow-inner">
                      <QRCodeSVG
                        value={qrUrl}
                        size={180}
                        level="M"
                        includeMargin
                        className="rounded-lg"
                      />
                    </div>

                    <div className="space-y-1">
                      <p className="text-xs font-bold text-slate-700">{t('health.scanToFill')}</p>
                      <p className="text-[11px] text-slate-400 truncate max-w-xs">{qrUrl}</p>
                    </div>

                    {/* 快捷切换到 Pad 上填写该客人 */}
                    <button
                      type="button"
                      onClick={() => {
                        setActiveGuestIdx(idx);
                        setFillMode('pad');
                      }}
                      className="kiosk-touch-target w-full py-2.5 rounded-xl bg-slate-100 hover:bg-teal-50 text-teal-800 hover:text-teal-900 font-bold text-xs transition-colors flex items-center justify-center gap-1.5"
                    >
                      <Tablet className="w-3.5 h-3.5" />
                      <span>{t('health.switchGuest')}</span>
                    </button>
                  </div>
                );
              })}
            </div>

            {/* 完成并进入排队凭条 */}
            <div className="pt-4 flex justify-center">
              <button
                type="button"
                onClick={handleFinishAll}
                className="kiosk-touch-target px-10 py-4 rounded-2xl bg-teal-600 hover:bg-teal-700 text-white font-extrabold text-lg shadow-sm transition-all flex items-center gap-2"
              >
                <span>{t('health.finishAll')}</span>
                <ChevronRight className="w-5 h-5" />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
