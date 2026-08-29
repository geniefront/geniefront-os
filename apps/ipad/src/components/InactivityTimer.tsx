import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Clock } from 'lucide-react';
import { useLanguage } from '../context/LanguageContext';

interface InactivityTimerProps {
  onTimeout: () => void;
  idleTimeoutSeconds?: number;
  countdownSeconds?: number;
  enabled?: boolean;
}

export const InactivityTimer: React.FC<InactivityTimerProps> = ({
  onTimeout,
  idleTimeoutSeconds = 60,
  countdownSeconds = 15,
  enabled = true,
}) => {
  const { t } = useLanguage();
  const [showWarning, setShowWarning] = useState(false);
  const [remainingSeconds, setRemainingSeconds] = useState(countdownSeconds);

  const onTimeoutRef = useRef(onTimeout);
  onTimeoutRef.current = onTimeout;

  const idleTimeoutSecRef = useRef(idleTimeoutSeconds);
  idleTimeoutSecRef.current = idleTimeoutSeconds;

  const countdownSecRef = useRef(countdownSeconds);
  countdownSecRef.current = countdownSeconds;

  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdownIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearTimers = useCallback(() => {
    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
    if (countdownIntervalRef.current) {
      clearInterval(countdownIntervalRef.current);
      countdownIntervalRef.current = null;
    }
  }, []);

  const startIdleTimer = useCallback(() => {
    clearTimers();
    setShowWarning(false);
    setRemainingSeconds(countdownSecRef.current);

    idleTimerRef.current = setTimeout(() => {
      setShowWarning(true);
      setRemainingSeconds(countdownSecRef.current);

      countdownIntervalRef.current = setInterval(() => {
        setRemainingSeconds((prev) => {
          if (prev <= 1) {
            clearTimers();
            setShowWarning(false);
            onTimeoutRef.current();
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    }, idleTimeoutSecRef.current * 1000);
  }, [clearTimers]);

  useEffect(() => {
    if (!enabled) {
      clearTimers();
      setShowWarning(false);
      return;
    }

    const events = ['pointerdown', 'touchstart', 'keydown', 'scroll'];
    const handleActivity = () => {
      if (!idleTimerRef.current && countdownIntervalRef.current) return;
      startIdleTimer();
    };

    for (const evt of events) {
      window.addEventListener(evt, handleActivity, { passive: true });
    }

    startIdleTimer();

    return () => {
      clearTimers();
      for (const evt of events) {
        window.removeEventListener(evt, handleActivity);
      }
    };
  }, [clearTimers, enabled, startIdleTimer]);

  useEffect(() => {
    if (!enabled) return;

    const handleVisibilityChange = () => {
      if (document.hidden) {
        clearTimers();
        setShowWarning(false);
        onTimeoutRef.current();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('pagehide', handleVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('pagehide', handleVisibilityChange);
    };
  }, [clearTimers, enabled]);

  if (!showWarning) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-slate-900/60 backdrop-blur-xs animate-fade-in select-none">
      <div className="w-full max-w-lg rounded-3xl bg-white border border-slate-200 shadow-2xl p-8 space-y-6 text-center">
        <div className="w-16 h-16 rounded-full bg-teal-50 text-teal-600 border border-teal-200 mx-auto flex items-center justify-center">
          <Clock className="w-8 h-8" />
        </div>

        <div className="space-y-2">
          <h3 className="text-2xl font-bold text-slate-900">{t('inactivity.title')}</h3>
          <p className="text-sm text-slate-500 leading-relaxed max-w-md mx-auto">
            {t('inactivity.message')}
          </p>
        </div>

        {/* 倒计时数字大徽章 */}
        <div className="py-2">
          <span className="inline-flex items-center justify-center w-20 h-20 rounded-2xl bg-slate-50 border-2 border-teal-500/60 text-4xl font-black text-teal-800 shadow-inner font-mono">
            {remainingSeconds}
          </span>
        </div>

        <div className="flex items-center justify-center gap-4 pt-2">
          <button
            type="button"
            onClick={startIdleTimer}
            className="kiosk-touch-target px-8 py-4 rounded-2xl bg-teal-600 hover:bg-teal-700 active:bg-teal-800 text-white font-bold text-lg shadow-sm transition-transform active:scale-95"
          >
            {t('inactivity.continue')}
          </button>
        </div>
      </div>
    </div>
  );
};
