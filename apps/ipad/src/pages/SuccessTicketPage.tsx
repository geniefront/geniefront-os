import React, { useState, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useLanguage } from '../context/LanguageContext';
import type { QueueJoinResult } from '../types';
import { CheckCircle2, Users, Clock, ArrowRight } from 'lucide-react';

export const SuccessTicketPage: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const { t } = useLanguage();

  const state = location.state as {
    queueResult?: QueueJoinResult;
    customerMaskedName?: string;
    customerName?: string;
    formSubmitted?: boolean;
  } | null;

  const queueResult = state?.queueResult;
  const ticketNumber = queueResult?.ticketNumber ?? 1;
  const aheadCount = queueResult?.aheadCount ?? 0;
  const quotedWaitMin = queueResult?.quotedWaitMin ?? 0;
  const displayName = state?.customerMaskedName || state?.customerName || '';

  // 15 秒自动归位倒计时
  const [secondsLeft, setSecondsLeft] = useState(15);

  useEffect(() => {
    const timer = setInterval(() => {
      setSecondsLeft((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          navigate('/');
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [navigate]);

  return (
    <div className="flex-1 flex flex-col items-center justify-center p-6 sm:p-10 max-w-3xl w-full mx-auto select-none overflow-y-auto">
      <div className="w-full rounded-3xl bg-white border border-slate-200/90 p-8 sm:p-12 shadow-xl text-center space-y-8 animate-fade-in relative overflow-hidden">
        {/* 顶部图标与标题 */}
        <div className="space-y-3">
          <div className="w-20 h-20 rounded-full bg-emerald-50 text-emerald-600 mx-auto flex items-center justify-center border-2 border-emerald-200 shadow-xs animate-scale-in">
            <CheckCircle2 className="w-12 h-12" />
          </div>

          <div className="space-y-1">
            <h2 className="text-3xl sm:text-4xl font-black text-slate-900 tracking-tight">
              {t('ticket.successTitle')}
            </h2>
            {displayName && (
              <p className="text-base font-bold text-teal-700">
                {displayName}
              </p>
            )}
          </div>
        </div>

        {/* 大号排队号展示卡 */}
        <div className="p-6 sm:p-8 rounded-3xl bg-slate-50 border border-slate-200 shadow-inner space-y-2 max-w-md mx-auto">
          <span className="text-xs sm:text-sm font-bold uppercase tracking-widest text-slate-500 block">
            {t('ticket.yourNumber')}
          </span>
          <div className="text-6xl sm:text-8xl font-black text-teal-700 tracking-tight font-mono py-1">
            #{ticketNumber}
          </div>
        </div>

        {/* 等待统计指标卡 */}
        <div className="grid grid-cols-2 gap-4 max-w-md mx-auto">
          <div className="p-4 sm:p-5 rounded-2xl bg-white border border-slate-200 shadow-2xs space-y-1">
            <div className="flex items-center justify-center gap-1.5 text-xs text-slate-500 font-medium">
              <Users className="w-4 h-4 text-teal-600" />
              <span>{t('ticket.aheadCount')}</span>
            </div>
            <div className="text-2xl sm:text-3xl font-extrabold text-slate-900">
              {aheadCount} <span className="text-sm font-medium text-slate-400">{t('ticket.parties')}</span>
            </div>
          </div>

          <div className="p-4 sm:p-5 rounded-2xl bg-white border border-slate-200 shadow-2xs space-y-1">
            <div className="flex items-center justify-center gap-1.5 text-xs text-slate-500 font-medium">
              <Clock className="w-4 h-4 text-teal-600" />
              <span>{t('ticket.quotedWait')}</span>
            </div>
            <div className="text-2xl sm:text-3xl font-extrabold text-slate-900">
              {quotedWaitMin > 0 ? `~${quotedWaitMin}` : '0'}{' '}
              <span className="text-sm font-medium text-slate-400">{t('ticket.minutes')}</span>
            </div>
          </div>
        </div>

        {/* 候客区提示 */}
        <p className="text-xs sm:text-sm text-slate-500 leading-relaxed max-w-md mx-auto">
          {t('ticket.loungeNotice')}
        </p>

        {/* 倒计时与完成按钮 */}
        <div className="pt-2 space-y-3">
          <button
            type="button"
            onClick={() => navigate('/')}
            className="kiosk-touch-target w-full max-w-md py-4 rounded-2xl bg-teal-600 hover:bg-teal-700 active:scale-95 text-white font-bold text-lg shadow-sm transition-all flex items-center justify-center gap-2 mx-auto"
          >
            <span>{t('ticket.returnNow')}</span>
            <ArrowRight className="w-5 h-5" />
          </button>

          <p className="text-xs text-slate-400 font-medium">
            {secondsLeft} {t('ticket.autoReturn')}
          </p>
        </div>
      </div>
    </div>
  );
};
