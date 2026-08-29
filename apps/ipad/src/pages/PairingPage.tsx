import React, { useState } from 'react';
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
      setCode((prev) => prev + char);
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
    <div className="flex-1 flex flex-col items-center justify-center p-6 pb-20 bg-slate-50 select-none overflow-y-auto">
      <div className="w-full max-w-lg rounded-3xl bg-white border border-slate-200/90 p-8 shadow-xl space-y-6">
        {/* 顶部标题区 */}
        <div className="text-center space-y-2">
          <div className="w-16 h-16 rounded-2xl bg-teal-50 border border-teal-200 text-teal-600 mx-auto flex items-center justify-center shadow-xs">
            <Tablet className="w-8 h-8" />
          </div>
          <h2 className="text-2xl font-extrabold text-slate-900 tracking-tight">{t('pairing.title')}</h2>
          <p className="text-sm text-slate-500 max-w-sm mx-auto leading-relaxed">
            {t('pairing.subtitle')}
          </p>
        </div>

        {/* 6 位数字 Passcode 独立格子展示 */}
        <div className="space-y-4">
          <div className="flex items-center justify-center gap-2 sm:gap-3 py-2">
            {[0, 1, 2, 3, 4, 5].map((index) => {
              const digit = code[index];
              const isCurrent = code.length === index;
              return (
                <div
                  key={index}
                  className={`w-12 h-16 sm:w-14 sm:h-18 rounded-2xl border-2 flex items-center justify-center font-mono text-3xl font-black transition-all ${
                    digit
                      ? 'bg-teal-50/50 border-teal-600 text-teal-800 shadow-xs'
                      : isCurrent
                        ? 'bg-white border-teal-500 ring-4 ring-teal-500/15'
                        : 'bg-slate-50 border-slate-200 text-slate-300'
                  }`}
                >
                  {digit || '•'}
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
            <div className="flex items-center justify-center gap-2 text-rose-600 text-xs font-semibold bg-rose-50 p-3.5 rounded-2xl border border-rose-200 animate-shake">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{errorMsg}</span>
            </div>
          )}
        </div>

        {/* 触控大号数字键盘 */}
        <div className="pt-1">
          <VirtualKeypad
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
            className="kiosk-touch-target w-full py-4 rounded-2xl bg-teal-600 hover:bg-teal-700 active:scale-[0.98] disabled:opacity-40 disabled:pointer-events-none text-white font-bold text-base shadow-sm transition-all flex items-center justify-center gap-2"
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
