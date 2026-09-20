import { PhoneInput } from '@gf/phone-input';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  HEALTH_FORM_EXPERIENCES,
  inferHealthFormCategory,
  normalizePhoneE164,
  parseBirthdate,
} from '@gf/contracts';
import { AlertCircle, ArrowLeft, Check, ChevronRight, Loader2, ShieldCheck, User } from 'lucide-react';
import { api } from '../api/client';
import { BodyMapSelector, type BodyMapValue } from '../components/BodyMapSelector';
import { BirthdateField } from '../components/BirthdateField';
import { SignaturePad } from '../components/SignaturePad';
import { useLanguage } from '../context/LanguageContext';
import { useDeviceAuthOptional } from '../context/DeviceAuthContext';
import type { FormQuestionDto, GuestIntake, KioskFormTemplateDto, QueueJoinResult } from '../types';
import { formatPhoneInput } from '../utils/phone';

interface LocationState {
  appointmentId?: string;
  queueId?: string;
  queueResult?: QueueJoinResult;
  forms?: KioskFormTemplateDto[];
  guests?: GuestIntake[];
  customerName?: string;
  visits?: { guest: GuestIntake; queueResult: QueueJoinResult; forms: KioskFormTemplateDto[] }[];
}

interface FormTask {
  guest: GuestIntake;
  form: KioskFormTemplateDto;
  appointmentId?: string;
  queueId?: string;
}

interface ClientInfo {
  fullName: string;
  dob: string;
  phone: string;
  occupation: string;
  emergencyName: string;
  emergencyPhone: string;
}

const clientInfoFor = (guest?: GuestIntake): ClientInfo => ({
  fullName: guest?.name ?? '',
  dob: '',
  phone: formatPhoneInput(guest?.phone ?? ''),
  occupation: '',
  emergencyName: '',
  emergencyPhone: '',
});

export function missingRequiredQuestionIds(
  questions: FormQuestionDto[],
  answers: Record<string, unknown>,
): string[] {
  return questions
    .filter((question) => !question.hidden && question.required)
    .filter((question) => {
      const value = answers[question.id];
      return value === undefined || value === null || value === ''
        || (Array.isArray(value) && value.length === 0);
    })
    .map((question) => question.id);
}

function makeIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export const HealthFormPage: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const { language, t, pickText } = useLanguage();
  const storeInfo = useDeviceAuthOptional()?.storeInfo ?? null;
  const state = (location.state as LocationState | null) ?? null;

  /*
   * 生日未来日校验的基准 = 门店**日历**今天（计划 §9.2：不用营业日 cutoff、
   * 不用设备 / UTC 日期）。kiosk 已配对，`storeInfo.timezone` 一定在；
   * `en-CA` 直接给出 YYYY-MM-DD。timezone 缺失时不传 today —— parseBirthdate
   * 不给 today 就不判未来日，仍好过用设备日期。
   */
  const storeCalendarToday = storeInfo?.timezone
    ? new Intl.DateTimeFormat('en-CA', { timeZone: storeInfo.timezone }).format(new Date())
    : undefined;

  const tasks = useMemo<FormTask[]>(() => {
    if (state?.visits) return state.visits.flatMap(visit => visit.forms.map(form => ({
      guest: visit.guest, form, appointmentId: visit.queueResult.appointmentId, queueId: visit.queueResult.queueId,
    })));
    // Legacy check-in navigation describes one visit only. Never attach several
    // guests to that shared identity; multi-guest intake must provide visits.
    if ((state?.guests?.length ?? 0) > 1) return [];
    const forms = state?.forms ?? [];
    const guests = state?.guests?.length
      ? state.guests
      : [{ id: 'guest-1', name: state?.customerName ?? '', phone: '', serviceId: null, addonIds: [] }];
    return guests.flatMap((guest) => forms.map((form) => ({ guest, form, appointmentId: state?.appointmentId, queueId: state?.queueId })));
  }, [state]);

  const [taskIndex, setTaskIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [clientInfo, setClientInfo] = useState<ClientInfo>(() => clientInfoFor(tasks[0]?.guest));
  const [painLevel, setPainLevel] = useState(0);
  const [painFrequency, setPainFrequency] = useState<'constant' | 'intermittent'>('intermittent');
  const [painDescription, setPainDescription] = useState('');
  const [bodyMap, setBodyMap] = useState<BodyMapValue>({ focus: [], avoid: [] });
  const [signerName, setSignerName] = useState(tasks[0]?.guest.name ?? '');
  const [signerRelation, setSignerRelation] = useState<'self' | 'guardian'>('self');
  const [signatureDataUrl, setSignatureDataUrl] = useState<string | undefined>();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idempotencyKeys = useRef(new Map<string, string>());

  const current = tasks[taskIndex];
  const queueResult = state?.queueResult;
  const experience = current
    ? HEALTH_FORM_EXPERIENCES[inferHealthFormCategory(current.form.key)]
    : HEALTH_FORM_EXPERIENCES.nail;
  const visibleQuestions = useMemo(
    () => current?.form.questions.filter((question) => !question.hidden) ?? [],
    [current],
  );
  const groupedQuestions = useMemo(() => {
    const safetyIds = new Set(experience.safetyQuestionIds);
    const assessmentIds = new Set(experience.assessmentQuestionIds);
    return {
      safety: visibleQuestions.filter((question) => safetyIds.has(question.id)),
      assessment: visibleQuestions.filter((question) => assessmentIds.has(question.id)),
      additional: visibleQuestions.filter((question) => !safetyIds.has(question.id) && !assessmentIds.has(question.id)),
    };
  }, [experience, visibleQuestions]);

  useEffect(() => {
    if (!queueResult || tasks.length === 0 || tasks.some(task => !task.appointmentId && !task.queueId)) {
      navigate('/', { replace: true });
    }
  }, [navigate, queueResult, state?.appointmentId, state?.queueId, tasks.length]);

  const resetForTask = (nextIndex: number) => {
    const next = tasks[nextIndex];
    setAnswers({});
    setClientInfo(clientInfoFor(next?.guest));
    setPainLevel(0);
    setPainFrequency('intermittent');
    setPainDescription('');
    setBodyMap({ focus: [], avoid: [] });
    setSignerName(next?.guest.name ?? '');
    setSignerRelation('self');
    setSignatureDataUrl(undefined);
    setError(null);
    setTaskIndex(nextIndex);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const finish = () => {
    navigate('/success', {
      replace: true,
      state: {
        queueResult,
        customerName: tasks[0]?.guest.name || clientInfo.fullName.trim() || state?.customerName,
        formSubmitted: true,
      },
    });
  };

  const setAnswer = (id: string, value: unknown) => {
    setAnswers((previous) => ({ ...previous, [id]: value }));
    setError(null);
  };

  const toggleMulti = (id: string, option: string) => {
    const currentValues = Array.isArray(answers[id]) ? answers[id] as string[] : [];
    setAnswer(id, currentValues.includes(option)
      ? currentValues.filter((value) => value !== option)
      : [...currentValues, option]);
  };

  const updateFullName = (value: string) => {
    setClientInfo((previous) => {
      if (signerName === previous.fullName) setSignerName(value);
      return { ...previous, fullName: value };
    });
    setError(null);
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!current || !queueResult) return;

    if (!clientInfo.fullName.trim()) {
      setError(t('walkin.nameRequired'));
      return;
    }
    const phoneE164 = normalizePhoneE164(clientInfo.phone);
    if (!phoneE164) {
      setError(t('checkin.phoneTooShort'));
      return;
    }
    const emergencyPhoneE164 = clientInfo.emergencyPhone.trim()
      ? normalizePhoneE164(clientInfo.emergencyPhone)
      : null;
    if (clientInfo.emergencyPhone.trim() && !emergencyPhoneE164) {
      setError(t('checkin.phoneTooShort'));
      return;
    }
    if (clientInfo.dob.trim()) {
      const dob = parseBirthdate(clientInfo.dob, { optional: true, today: storeCalendarToday });
      if (!dob.ok) {
        setError(t(dob.reason === 'future' ? 'health.dobFuture' : 'health.dobInvalid'));
        return;
      }
    }
    if (missingRequiredQuestionIds(current.form.questions, answers).length > 0) {
      setError(t('health.missingAnswers'));
      return;
    }
    if (!signerName.trim()) {
      setError(t('walkin.nameRequired'));
      return;
    }
    if (current.form.requiresSignature && !signatureDataUrl) {
      setError(t('health.signatureRequired'));
      return;
    }

    const taskKey = `${current.guest.id}:${current.form.templateId}`;
    const idempotencyKey = idempotencyKeys.current.get(taskKey) ?? makeIdempotencyKey();
    idempotencyKeys.current.set(taskKey, idempotencyKey);

    setIsSubmitting(true);
    setError(null);
    try {
      await api.submitForm({
        templateId: current.form.templateId,
        ...(current.appointmentId ? { appointmentId: current.appointmentId } : {}),
        ...(current.queueId ? { queueId: current.queueId } : {}),
        answers: {
          ...answers,
          clientInfo: {
            ...clientInfo,
            fullName: clientInfo.fullName.trim(),
            phone: phoneE164,
            emergencyPhone: emergencyPhoneE164,
          },
          painLevel,
          painFrequency,
          painDescription,
          bodyMapFocus: experience.assessmentMode === 'pain_body_map' ? bodyMap.focus : [],
          bodyMapAvoid: experience.assessmentMode === 'pain_body_map' ? bodyMap.avoid : [],
          kioskGuest: { phone: phoneE164, email: current.guest.email || null },
        },
        ...(signatureDataUrl ? { signatureDataUrl } : {}),
        signerName: signerName.trim(),
        signerRelation,
        locale: language,
        idempotencyKey,
      });

      if (taskIndex + 1 < tasks.length) resetForTask(taskIndex + 1);
      else finish();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to submit form');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!current || !queueResult) return null;

  const renderQuestions = (questions: FormQuestionDto[]) => (
    <div className="space-y-3">
      {questions.map((question, index) => {
        const value = answers[question.id];
        return (
          <fieldset key={question.id} className="rounded-2xl border border-slate-200 bg-slate-50/50 p-4">
            <legend className="w-full px-1 text-sm font-bold leading-snug text-slate-900">
              <span className="mr-1 text-teal-700">{index + 1}.</span>{pickText(question.label)}
              {question.required && <span className="ml-1 text-rose-600">*</span>}
            </legend>

            {question.type === 'bool' && (
              <div className="mt-3 grid grid-cols-2 gap-3">
                {([true, false] as const).map((option) => (
                  <button key={String(option)} type="button" onClick={() => setAnswer(question.id, option)}
                    className={`kiosk-touch-target rounded-xl border-2 py-3 font-bold ${value === option ? 'border-teal-600 bg-teal-600 text-white' : 'border-slate-200 bg-white text-slate-700'}`}>
                    {option ? t('health.yes') : t('health.no')}
                  </button>
                ))}
              </div>
            )}

            {question.type === 'choice' && (
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {(question.options ?? []).map((option) => (
                  <button key={option.value} type="button" onClick={() => setAnswer(question.id, option.value)}
                    className={`kiosk-touch-target flex items-center justify-between rounded-xl border-2 p-3 text-left font-semibold ${value === option.value ? 'border-teal-600 bg-teal-50 text-teal-950' : 'border-slate-200 bg-white text-slate-700'}`}>
                    {pickText(option.label)} {value === option.value && <Check className="h-5 w-5 text-teal-700" />}
                  </button>
                ))}
              </div>
            )}

            {question.type === 'multi' && (
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {(question.options ?? []).map((option) => {
                  const selected = Array.isArray(value) && value.includes(option.value);
                  return (
                    <button key={option.value} type="button" onClick={() => toggleMulti(question.id, option.value)}
                      className={`kiosk-touch-target flex items-center justify-between rounded-xl border-2 p-3 text-left font-semibold ${selected ? 'border-teal-600 bg-teal-50 text-teal-950' : 'border-slate-200 bg-white text-slate-700'}`}>
                      {pickText(option.label)} {selected && <Check className="h-5 w-5 text-teal-700" />}
                    </button>
                  );
                })}
              </div>
            )}

            {question.type === 'text' && (
              <textarea rows={3} maxLength={2000} value={typeof value === 'string' ? value : ''}
                onChange={(event) => setAnswer(question.id, event.target.value)}
                className="mt-3 w-full rounded-xl border-2 border-slate-200 bg-white p-3 text-base text-slate-900 outline-none focus:border-teal-600" />
            )}
          </fieldset>
        );
      })}
    </div>
  );

  return (
    <div className="flex-1 overflow-y-auto p-4 sm:p-8">
      <form onSubmit={handleSubmit} className="mx-auto max-w-4xl space-y-6 pb-16">
        <div className="flex items-center justify-between gap-4">
          <button type="button" onClick={() => navigate('/', { replace: true })}
            className="kiosk-touch-target flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-bold text-slate-700">
            <ArrowLeft className="h-4 w-4" /> {t('common.back')}
          </button>
          {tasks.length > 1 && (
            <span className="rounded-full border border-teal-200 bg-teal-50 px-3 py-1.5 text-xs font-bold text-teal-800">
              {taskIndex + 1} / {tasks.length}
            </span>
          )}
        </div>

        <header className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-start gap-4">
            <div className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-teal-50 text-teal-700">
              <ShieldCheck className="h-6 w-6" />
            </div>
            <div className="min-w-0">
              <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-teal-700">
                <User className="h-3.5 w-3.5" /> {current.guest.name || state?.customerName}
              </p>
              <h1 className="mt-1 text-2xl font-black text-slate-950 sm:text-3xl">
                {pickText(current.form.title, t('health.title'))}
              </h1>
              <p className="mt-2 text-sm text-slate-500">{t('health.subtitle')}</p>
            </div>
          </div>
        </header>

        <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="rounded-xl bg-slate-100 px-3 py-2 text-sm font-bold text-slate-800">{t('health.clientInfo')}</h2>
          <div className="mt-4 grid gap-4 md:grid-cols-3">
            <label className="text-sm font-bold text-slate-700">{t('health.fullName')} <span className="text-rose-600">*</span>
              <input value={clientInfo.fullName} maxLength={120} onChange={(event) => updateFullName(event.target.value)}
                className="mt-1.5 w-full rounded-xl border-2 border-slate-200 bg-slate-50 px-3 py-3 font-medium outline-none focus:border-teal-600 focus:bg-white" />
            </label>
            <BirthdateField
              label={t('health.dateOfBirth')}
              value={clientInfo.dob}
              onChange={(iso) => setClientInfo({ ...clientInfo, dob: iso })}
              today={storeCalendarToday}
              optional
            />
            <label className="text-sm font-bold text-slate-700">{t('health.phoneNumber')} <span className="text-rose-600">*</span>
              <PhoneInput type="tel" inputMode="tel" autoComplete="tel" value={clientInfo.phone}
                onChange={(event) => setClientInfo({ ...clientInfo, phone: event.target.value })}
                placeholder="(555) 000-0000"
                maxLength={32}
                className="mt-1.5 w-full rounded-xl border-2 border-slate-200 bg-slate-50 px-3 py-3 font-mono font-medium outline-none focus:border-teal-600 focus:bg-white" />
            </label>
            <label className="text-sm font-bold text-slate-700">{t('health.occupation')}
              <input value={clientInfo.occupation} maxLength={120}
                onChange={(event) => setClientInfo({ ...clientInfo, occupation: event.target.value })}
                className="mt-1.5 w-full rounded-xl border-2 border-slate-200 bg-slate-50 px-3 py-3 font-medium outline-none focus:border-teal-600 focus:bg-white" />
            </label>
            <label className="text-sm font-bold text-slate-700">{t('health.emergencyName')}
              <input value={clientInfo.emergencyName} maxLength={120}
                onChange={(event) => setClientInfo({ ...clientInfo, emergencyName: event.target.value })}
                className="mt-1.5 w-full rounded-xl border-2 border-slate-200 bg-slate-50 px-3 py-3 font-medium outline-none focus:border-teal-600 focus:bg-white" />
            </label>
            <label className="text-sm font-bold text-slate-700">{t('health.emergencyPhone')}
              <PhoneInput type="tel" inputMode="tel" autoComplete="tel" value={clientInfo.emergencyPhone}
                onChange={(event) => setClientInfo({ ...clientInfo, emergencyPhone: event.target.value })}
                placeholder="(555) 000-0000"
                maxLength={32}
                className="mt-1.5 w-full rounded-xl border-2 border-slate-200 bg-slate-50 px-3 py-3 font-mono font-medium outline-none focus:border-teal-600 focus:bg-white" />
            </label>
          </div>
        </section>

        {groupedQuestions.safety.length > 0 && (
          <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
            <h2 className="rounded-xl bg-slate-100 px-3 py-2 text-sm font-bold text-slate-800">{experience.safetyTitle}</h2>
            <p className="my-4 text-sm text-slate-500">{t('health.safetyInstructions')}</p>
            {renderQuestions(groupedQuestions.safety)}
          </section>
        )}

        {(groupedQuestions.assessment.length > 0 || experience.assessmentMode === 'pain_body_map') && (
          <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-slate-100 px-3 py-2">
              <h2 className="text-sm font-bold text-slate-800">{experience.assessmentTitle}</h2>
              <span className="text-xs font-semibold text-teal-700">{experience.assessmentHint}</span>
            </div>
            {experience.assessmentMode === 'pain_body_map' && (
              <div className="mt-4 space-y-5">
                <div className="rounded-2xl border border-teal-200 bg-teal-50/50 p-4">
                  <label className="text-sm font-bold text-slate-800">{t('health.painLevel')}: <span className="text-teal-700">{painLevel}</span></label>
                  <input type="range" min="0" max="10" value={painLevel} onChange={(event) => setPainLevel(Number(event.target.value))}
                    className="mt-3 w-full accent-teal-600" />
                  <div className="mt-4 grid grid-cols-2 gap-3">
                    {(['intermittent', 'constant'] as const).map((frequency) => (
                      <button key={frequency} type="button" onClick={() => setPainFrequency(frequency)}
                        className={`kiosk-touch-target rounded-xl border-2 py-3 font-bold ${painFrequency === frequency ? 'border-teal-600 bg-white text-teal-900' : 'border-slate-200 bg-white/60 text-slate-600'}`}>
                        {frequency === 'intermittent' ? t('health.freqIntermittent') : t('health.freqConstant')}
                      </button>
                    ))}
                  </div>
                  <textarea rows={2} maxLength={1000} value={painDescription} onChange={(event) => setPainDescription(event.target.value)}
                    placeholder={t('health.painDescription')}
                    className="mt-4 w-full rounded-xl border-2 border-slate-200 bg-white p-3 outline-none focus:border-teal-600" />
                </div>
                <BodyMapSelector value={bodyMap} onChange={setBodyMap} />
              </div>
            )}
            {groupedQuestions.assessment.length > 0 && <div className="mt-4">{renderQuestions(groupedQuestions.assessment)}</div>}
          </section>
        )}

        {groupedQuestions.additional.length > 0 && (
          <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
            <h2 className="rounded-xl bg-slate-100 px-3 py-2 text-sm font-bold text-slate-800">{t('health.additionalQuestions')}</h2>
            <div className="mt-4">{renderQuestions(groupedQuestions.additional)}</div>
          </section>
        )}

        <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="rounded-xl bg-slate-100 px-3 py-2 text-sm font-bold text-slate-800">{t('health.informedConsent')}</h2>
          <p className="mt-4 text-sm leading-relaxed text-slate-600">{t('health.consentBody')}</p>
          <label className="mt-5 block text-sm font-bold text-slate-800">{t('health.signerName')} <span className="text-rose-600">*</span>
            <input value={signerName} maxLength={120} onChange={(event) => setSignerName(event.target.value)}
              className="mt-2 w-full rounded-2xl border-2 border-slate-200 bg-slate-50 px-4 py-3 text-base font-semibold outline-none focus:border-teal-600 focus:bg-white" />
          </label>
          <p className="mt-5 text-sm font-bold text-slate-800">{t('health.signerRelation')}</p>
          <div className="mt-2 grid grid-cols-2 gap-3">
            {(['self', 'guardian'] as const).map((relation) => (
              <button key={relation} type="button" onClick={() => setSignerRelation(relation)}
                className={`kiosk-touch-target rounded-2xl border-2 py-3 font-bold ${signerRelation === relation ? 'border-teal-600 bg-teal-50 text-teal-900' : 'border-slate-200 bg-slate-50 text-slate-700'}`}>
                {relation === 'self' ? t('health.relationSelf') : t('health.relationGuardian')}
              </button>
            ))}
          </div>
        </section>

        {current.form.requiresSignature && (
          <SignaturePad key={`${current.guest.id}:${current.form.templateId}`} required
            onSave={setSignatureDataUrl} onClear={() => setSignatureDataUrl(undefined)} />
        )}

        {error && (
          <div role="alert" className="flex items-center gap-2 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm font-bold text-rose-700">
            <AlertCircle className="h-5 w-5 shrink-0" /> {error}
          </div>
        )}

        <button type="submit" disabled={isSubmitting}
          className="kiosk-touch-target flex w-full items-center justify-center gap-2 rounded-2xl bg-teal-600 py-5 text-xl font-extrabold text-white shadow-sm disabled:opacity-50">
          {isSubmitting ? <Loader2 className="h-6 w-6 animate-spin" /> : <ChevronRight className="h-6 w-6" />}
          {taskIndex + 1 < tasks.length ? t('common.next') : t('health.finishAll')}
        </button>
      </form>
    </div>
  );
};
