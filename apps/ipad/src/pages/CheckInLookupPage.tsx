import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLanguage } from '../context/LanguageContext';
import { VirtualKeypad } from '../components/VirtualKeypad';
import { api } from '../api/client';
import type { AppointmentMatchDto } from '../types';
import { ArrowLeft, Phone, Search, Clock, UserCheck, AlertCircle, Loader2 } from 'lucide-react';
import { formatPhoneInput } from '../utils/phone';

export const CheckInLookupPage: React.FC = () => {
  const navigate = useNavigate();
  const { t } = useLanguage();
  const [phone, setPhone] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [matches, setMatches] = useState<AppointmentMatchDto[]>([]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [checkingInId, setCheckingInId] = useState<string | null>(null);

  const handleKeyPress = (char: string) => {
    if (phone.length < 15) {
      setPhone((prev) => prev + char);
      setErrorMsg(null);
      setHasSearched(false);
    }
  };

  const handleDelete = () => {
    setPhone((prev) => prev.slice(0, -1));
    setErrorMsg(null);
    setHasSearched(false);
  };

  const handleClear = () => {
    setPhone('');
    setErrorMsg(null);
    setHasSearched(false);
    setMatches([]);
  };

  const handleSearch = async () => {
    const digits = phone.replace(/\D/g, '');
    if (digits.length < 7) {
      setErrorMsg(t('checkin.phoneTooShort'));
      return;
    }

    setIsSearching(true);
    setErrorMsg(null);
    try {
      const res = await api.lookupAppointments(digits);
      setMatches(res.matches);
      setHasSearched(true);
    } catch (err: any) {
      setErrorMsg(err.message || 'Lookup failed');
    } finally {
      setIsSearching(false);
    }
  };

  const handleConfirmCheckIn = async (match: AppointmentMatchDto) => {
    setCheckingInId(match.appointmentId);
    setErrorMsg(null);
    try {
      // 1. 签到进走单队列
      const queueRes = await api.checkIn(match.appointmentId);

      // 2. 检查这次预约是否需要填健康表
      const formsRes = await api.getRequiredForms({
        appointmentId: match.appointmentId,
        queueId: queueRes.queueId,
      });

      if (formsRes.forms && formsRes.forms.length > 0) {
        // 跳转健康表录入
        navigate('/health-form', {
          state: {
            appointmentId: match.appointmentId,
            queueId: queueRes.queueId,
            queueResult: queueRes,
            forms: formsRes.forms,
            customerName: match.maskedName,
            phone,
            guests: [
              {
                id: 'guest-1',
                // Do not persist a lookup-safe masked value as a legal name or
                // signature. The customer enters their full name on the form.
                name: '',
                phone,
                email: '',
                serviceId: null,
                addonIds: [],
                isFormSubmitted: false,
              },
            ],
          },
        });
      } else {
        // 无需健康表，直接展示排队号码
        navigate('/success', {
          state: {
            queueResult: queueRes,
            customerMaskedName: match.maskedName,
          },
        });
      }
    } catch (err: any) {
      setErrorMsg(err.message || 'Check-in failed');
      setCheckingInId(null);
    }
  };

  const formatTime = (isoString: string) => {
    try {
      const d = new Date(isoString);
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    } catch {
      return isoString;
    }
  };

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
      </div>

      <div className="space-y-6">
        {/* 标题区域 */}
        <div className="text-center space-y-2">
          <div className="w-14 h-14 rounded-2xl bg-teal-50 border border-teal-200 text-teal-600 mx-auto flex items-center justify-center shadow-xs">
            <Phone className="w-7 h-7" />
          </div>
          <h2 className="text-2xl sm:text-4xl font-extrabold text-slate-900">{t('checkin.lookupTitle')}</h2>
          <p className="text-sm sm:text-base text-slate-500 max-w-lg mx-auto">
            {t('checkin.lookupSubtitle')}
          </p>
        </div>

        {/* 手机号显示区域 */}
        <div className="space-y-3">
          <div className="flex items-center justify-center">
            <div className="w-full max-w-md h-18 rounded-2xl bg-white border-2 border-teal-500/70 flex items-center justify-center tracking-[0.2em] font-mono text-3xl font-extrabold text-teal-800 shadow-inner px-4">
              {phone ? formatPhoneInput(phone) : <span className="text-slate-300 font-sans tracking-normal text-base font-normal">(•••) •••-••••</span>}
            </div>
          </div>

          {errorMsg && (
            <div className="flex items-center justify-center gap-2 text-rose-600 text-sm font-semibold bg-rose-50 p-3 rounded-2xl border border-rose-200 max-w-md mx-auto">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{errorMsg}</span>
            </div>
          )}
        </div>

        {/* 尚未查询或查询结果展示 */}
        {!hasSearched ? (
          <div className="space-y-6 pt-2">
            <VirtualKeypad
              onKeyPress={handleKeyPress}
              onDelete={handleDelete}
              onClear={handleClear}
            />

            <div className="max-w-sm mx-auto">
              <button
                type="button"
                disabled={phone.length < 7 || isSearching}
                onClick={handleSearch}
                className="kiosk-touch-target w-full py-4 rounded-2xl bg-teal-600 hover:bg-teal-700 active:scale-[0.98] disabled:opacity-40 disabled:pointer-events-none text-white font-bold text-lg shadow-sm transition-all flex items-center justify-center gap-2"
              >
                {isSearching ? (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin" />
                    <span>{t('common.loading')}</span>
                  </>
                ) : (
                  <>
                    <Search className="w-5 h-5" />
                    <span>{t('checkin.search')}</span>
                  </>
                )}
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-6 pt-2 animate-fade-in max-w-2xl mx-auto">
            {matches.length === 0 ? (
              <div className="p-8 rounded-3xl bg-white border border-slate-200 text-center space-y-4 shadow-sm">
                <div className="w-14 h-14 rounded-2xl bg-slate-100 text-slate-400 mx-auto flex items-center justify-center">
                  <AlertCircle className="w-8 h-8" />
                </div>
                <div className="space-y-1">
                  <h3 className="text-xl font-bold text-slate-800">{t('checkin.noMatchTitle')}</h3>
                  <p className="text-sm text-slate-500 leading-relaxed max-w-md mx-auto">
                    {t('checkin.noMatchDesc')}
                  </p>
                </div>
                <div className="pt-2 flex flex-col sm:flex-row items-center justify-center gap-3">
                  <button
                    type="button"
                    onClick={() => {
                      setHasSearched(false);
                      setPhone('');
                    }}
                    className="kiosk-touch-target px-6 py-3 rounded-2xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-sm transition-colors"
                  >
                    {t('common.retry')}
                  </button>
                  <button
                    type="button"
                    onClick={() => navigate('/walk-in')}
                    className="kiosk-touch-target px-6 py-3 rounded-2xl bg-teal-600 hover:bg-teal-700 text-white font-bold text-sm shadow-sm transition-colors"
                  >
                    {t('home.walkInTitle')}
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <p className="text-sm font-bold text-teal-800 text-center">
                  {t('checkin.matchesFound')}
                </p>

                <div className="grid gap-4">
                  {matches.map((item) => (
                    <div
                      key={item.appointmentId}
                      className="p-6 rounded-3xl bg-white border-2 border-teal-200 hover:border-teal-500 shadow-sm flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 transition-all"
                    >
                      <div className="space-y-1.5">
                        <div className="flex items-center gap-2.5">
                          <span className="text-2xl font-black text-slate-900 tracking-wide">
                            {item.maskedName}
                          </span>
                          {item.alreadyQueued && (
                            <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-50 text-amber-700 border border-amber-200">
                              {t('checkin.alreadyQueued')}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2 text-sm text-slate-500 font-medium">
                          <Clock className="w-4 h-4 text-teal-600" />
                          <span>
                            {t('checkin.scheduledTime')}: <strong className="text-slate-800 font-bold">{formatTime(item.startsAt)}</strong>
                          </span>
                        </div>
                      </div>

                      <button
                        type="button"
                        disabled={checkingInId === item.appointmentId}
                        onClick={() => handleConfirmCheckIn(item)}
                        className="kiosk-touch-target w-full sm:w-auto px-8 py-3.5 rounded-2xl bg-teal-600 hover:bg-teal-700 active:scale-95 disabled:opacity-50 text-white font-bold text-base shadow-sm flex items-center justify-center gap-2 shrink-0 transition-all"
                      >
                        {checkingInId === item.appointmentId ? (
                          <>
                            <Loader2 className="w-5 h-5 animate-spin" />
                            <span>{t('common.loading')}</span>
                          </>
                        ) : (
                          <>
                            <UserCheck className="w-5 h-5" />
                            <span>{t('checkin.confirmMe')}</span>
                          </>
                        )}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
