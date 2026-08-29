import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDeviceAuth } from '../context/DeviceAuthContext';
import { useLanguage } from '../context/LanguageContext';
import { VirtualKeypad } from '../components/VirtualKeypad';
import { Tablet, KeyRound, AlertCircle, Loader2 } from 'lucide-react';

export const PairingPage: React.FC = () => {
  const navigate = useNavigate();
  const { pairDevice, isLoading: authLoading } = useDeviceAuth();
  const { t } = useLanguage();
  const [code, setCode] = useState('');
  const [label, setLabel] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleKeyPress = (char: string) => {
    if (code.length < 6) {
      setCode((prev) => (prev + char).toUpperCase());
      setErrorMsg(null);
    }
  };

  const handleDelete = () => {
    setCode((prev) => prev.slice(0, -1));
    setErrorMsg(null);
  };

  const handleClear = () => {
    setCode('');
    setErrorMsg(null);
  };

  // 支持实体外接键盘直接敲击输入
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // 忽略在 label 输入框内的打字
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;

      if (e.key === 'Backspace') {
        handleDelete();
      } else if (e.key === 'Escape') {
        handleClear();
      } else if (e.key === 'Enter') {
        if (code.length === 6) void handleSubmit();
      } else if (/^[a-zA-Z0-9]$/.test(e.key)) {
        handleKeyPress(e.key.toUpperCase());
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [code]);

  const handleSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (code.length !== 6 || isSubmitting || authLoading) return;

    setIsSubmitting(true);
    setErrorMsg(null);
    try {
      await pairDevice(code, label.trim() || undefined);
      navigate('/', { replace: true });
    } catch {
      setErrorMsg(t('pairing.invalidCode'));
      setCode('');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col items-center justify-center p-4 sm:p-6 pb-16 bg-slate-50 select-none overflow-y-auto">
      <div className="w-full max-w-2xl rounded-3xl bg-white border border-slate-200/90 p-6 sm:p-8 shadow-xl space-y-5">
        {/* 顶部标题区 */}
        <div className="text-center space-y-1.5">
          <div className="w-14 h-14 rounded-2xl bg-teal-50 border border-teal-200 text-teal-600 mx-auto flex items-center justify-center shadow-xs">
            <Tablet className="w-7 h-7" />
          </div>
          <h2 className="text-2xl sm:text-3xl font-extrabold text-slate-900 tracking-tight">{t('pairing.title')}</h2>
          <p className="text-xs sm:text-sm text-slate-500 max-w-md mx-auto leading-relaxed">
            {t('pairing.subtitle')}
          </p>
        </div>

        {/* 6 位数字/字母 Passcode 独立格子展示 */}
        <div className="space-y-3">
          <div className="flex items-center justify-center gap-2 sm:gap-3 py-1">
            {[0, 1, 2, 3, 4, 5].map((index) => {
              const char = code[index];
              const isCurrent = code.length === index;
              return (
                <div
                  key={index}
                  className={`w-12 h-16 sm:w-14 sm:h-18 rounded-2xl border-2 flex items-center justify-center font-mono text-2xl sm:text-3xl font-black transition-all ${
                    char
                      ? 'bg-teal-50/60 border-teal-600 text-teal-900 shadow-xs'
                      : isCurrent
                        ? 'bg-white border-teal-500 ring-4 ring-teal-500/15'
                        : 'bg-slate-50 border-slate-200 text-slate-300'
                  }`}
                >
                  {char || '•'}
                </div>
              );
            })}
          </div>

          {/* 设备名称输入 */}
          <div className="max-w-xs mx-auto">
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={t('pairing.labelPlaceholder')}
              autoComplete="off"
              autoCorrect="off"
              spellCheck="false"
              className="w-full px-4 py-2 rounded-xl bg-slate-50 border border-slate-200 text-xs font-semibold text-slate-800 placeholder:text-slate-400 focus:outline-none focus:border-teal-500 focus:bg-white transition-colors text-center"
            />
          </div>

          {errorMsg && (
            <div className="flex items-center justify-center gap-2 text-rose-600 text-xs font-semibold bg-rose-50 p-3 rounded-2xl border border-rose-200 animate-shake max-w-sm mx-auto">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{errorMsg}</span>
            </div>
          )}
        </div>

        {/* 触控全键盘（数字 + 字母 QWERTY） */}
        <div className="pt-1">
          <VirtualKeypad
            mode="alphanumeric"
            onKeyPress={handleKeyPress}
            onDelete={handleDelete}
            onClear={handleClear}
          />
        </div>

        {/* 提交绑定按钮：用户点击后才触发配对 */}
        <div className="pt-1">
          <button
            type="button"
            disabled={code.length !== 6 || isSubmitting || authLoading}
            onClick={() => handleSubmit()}
            className="kiosk-touch-target w-full max-w-xl mx-auto py-4 rounded-2xl bg-teal-600 hover:bg-teal-700 active:scale-[0.98] disabled:opacity-40 disabled:pointer-events-none text-white font-bold text-base shadow-sm transition-all flex items-center justify-center gap-2"
          >
            {isSubmitting || authLoading ? (
              <>
                <Loader2 className="w-5 h-5 animate-spin" />
                <span>{t('common.loading')}</span>
              </>
            ) : (
              <>
                <KeyRound className="w-5 h-5" />
                <span>{t('pairing.submit')}</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};
