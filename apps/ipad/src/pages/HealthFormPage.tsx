import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { AlertCircle, ArrowLeft, Check, ChevronRight, Loader2, ShieldCheck, User } from 'lucide-react';
import { api } from '../api/client';
import { BodyMapSelector, type BodyMapValue } from '../components/BodyMapSelector';
import { SignaturePad } from '../components/SignaturePad';
import { useDeviceAuth } from '../context/DeviceAuthContext';
import { useLanguage } from '../context/LanguageContext';
import type { FormQuestionDto, GuestIntake, KioskFormTemplateDto, QueueJoinResult } from '../types';

interface LocationState {
  appointmentId?: string;
  queueId?: string;
  queueResult?: QueueJoinResult;
  forms?: KioskFormTemplateDto[];
  guests?: GuestIntake[];
  customerName?: string;
}

interface FormTask {
  guest: GuestIntake;
  form: KioskFormTemplateDto;
}

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
  const { storeInfo } = useDeviceAuth();
  const state = (location.state as LocationState | null) ?? null;

  const tasks = useMemo<FormTask[]>(() => {
    const forms = state?.forms ?? [];
    const guests = state?.guests?.length
      ? state.guests
      : [{ id: 'guest-1', name: state?.customerName ?? '', phone: '', serviceId: null, addonIds: [] }];
    return guests.flatMap((guest) => forms.map((form) => ({ guest, form })));
  }, [state]);

  const [taskIndex, setTaskIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [bodyMap, setBodyMap] = useState<BodyMapValue>({ focus: [], avoid: [] });
  const [signerName, setSignerName] = useState(tasks[0]?.guest.name ?? '');
  const [signerRelation, setSignerRelation] = useState<'self' | 'guardian'>('self');
  const [signatureDataUrl, setSignatureDataUrl] = useState<string | undefined>();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idempotencyKeys = useRef(new Map<string, string>());

  const current = tasks[taskIndex];
  const queueResult = state?.queueResult;

  useEffect(() => {
    if (!queueResult || tasks.length === 0 || (!state?.appointmentId && !state?.queueId)) {
      navigate('/', { replace: true });
    }
  }, [navigate, queueResult, state?.appointmentId, state?.queueId, tasks.length]);

  const resetForTask = (nextIndex: number) => {
    const next = tasks[nextIndex];
    setAnswers({});
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
        customerName: tasks[0]?.guest.name,
        formSubmitted: true,
      },
    });
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!current || !queueResult) return;

    const missing = missingRequiredQuestionIds(current.form.questions, answers);
    if (missing.length > 0) {
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
        ...(state?.appointmentId ? { appointmentId: state.appointmentId } : {}),
        ...(state?.queueId ? { queueId: state.queueId } : {}),
        answers: {
          ...answers,
          bodyMapFocus: bodyMap.focus,
          bodyMapAvoid: bodyMap.avoid,
          kioskGuest: { phone: current.guest.phone || null, email: current.guest.email || null },
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

  if (!current || !queueResult) return null;

  const showBodyMap = storeInfo?.deviceConfig.requireBodySorenessMap ?? false;

  return (
    <div className="flex-1 overflow-y-auto p-4 sm:p-8">
      <form onSubmit={handleSubmit} className="mx-auto max-w-4xl space-y-6 pb-16">
        <div className="flex items-center justify-between gap-4">
          <button type="button" onClick={() => navigate('/', { replace: true })}
            className="kiosk-touch-target flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-bold text-slate-700">
            <ArrowLeft className="h-4 w-4" /> {t('common.back')}
          </button>
          <span className="rounded-full border border-teal-200 bg-teal-50 px-3 py-1.5 text-xs font-bold text-teal-800">
            {taskIndex + 1} / {tasks.length}
          </span>
        </div>

        <header className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-start gap-4">
            <div className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-teal-50 text-teal-700">
              <ShieldCheck className="h-6 w-6" />
            </div>
            <div className="min-w-0">
              <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-teal-700">
                <User className="h-3.5 w-3.5" /> {current.guest.name}
              </p>
              <h1 className="mt-1 text-2xl font-black text-slate-950 sm:text-3xl">
                {pickText(current.form.title, t('health.title'))}
              </h1>
              <p className="mt-2 text-sm text-slate-500">{t('health.subtitle')}</p>
            </div>
          </div>
        </header>

        <section className="space-y-4">
          {current.form.questions.filter((question) => !question.hidden).map((question, index) => {
            const value = answers[question.id];
            return (
              <fieldset key={question.id} className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
                <legend className="w-full px-1 text-base font-bold text-slate-900">
                  <span className="mr-2 text-teal-700">{index + 1}.</span>{pickText(question.label)}
                  {question.required && <span className="ml-1 text-rose-600">*</span>}
                </legend>

                {question.type === 'bool' && (
                  <div className="mt-4 grid grid-cols-2 gap-3">
                    {([true, false] as const).map((option) => (
                      <button key={String(option)} type="button" onClick={() => setAnswer(question.id, option)}
                        className={`kiosk-touch-target rounded-2xl border-2 py-4 text-base font-bold ${value === option ? 'border-teal-600 bg-teal-600 text-white' : 'border-slate-200 bg-slate-50 text-slate-700'}`}>
                        {option ? t('health.yes') : t('health.no')}
                      </button>
                    ))}
                  </div>
                )}

                {question.type === 'choice' && (
                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    {(question.options ?? []).map((option) => (
                      <button key={option.value} type="button" onClick={() => setAnswer(question.id, option.value)}
                        className={`kiosk-touch-target flex items-center justify-between rounded-2xl border-2 p-4 text-left font-semibold ${value === option.value ? 'border-teal-600 bg-teal-50 text-teal-950' : 'border-slate-200 bg-slate-50 text-slate-700'}`}>
                        {pickText(option.label)} {value === option.value && <Check className="h-5 w-5 text-teal-700" />}
                      </button>
                    ))}
                  </div>
                )}

                {question.type === 'multi' && (
                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    {(question.options ?? []).map((option) => {
                      const selected = Array.isArray(value) && value.includes(option.value);
                      return (
                        <button key={option.value} type="button" onClick={() => toggleMulti(question.id, option.value)}
                          className={`kiosk-touch-target flex items-center justify-between rounded-2xl border-2 p-4 text-left font-semibold ${selected ? 'border-teal-600 bg-teal-50 text-teal-950' : 'border-slate-200 bg-slate-50 text-slate-700'}`}>
                          {pickText(option.label)} {selected && <Check className="h-5 w-5 text-teal-700" />}
                        </button>
                      );
                    })}
                  </div>
                )}

                {question.type === 'text' && (
                  <textarea rows={4} maxLength={2000} value={typeof value === 'string' ? value : ''}
                    onChange={(event) => setAnswer(question.id, event.target.value)}
                    className="mt-4 w-full rounded-2xl border-2 border-slate-200 bg-slate-50 p-4 text-base text-slate-900 outline-none focus:border-teal-600 focus:bg-white" />
                )}
              </fieldset>
            );
          })}
        </section>

        {showBodyMap && <BodyMapSelector value={bodyMap} onChange={setBodyMap} />}

        <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <label className="block text-sm font-bold text-slate-800">{t('health.signerName')} <span className="text-rose-600">*</span></label>
          <input value={signerName} maxLength={120} onChange={(event) => setSignerName(event.target.value)}
            className="mt-2 w-full rounded-2xl border-2 border-slate-200 bg-slate-50 px-4 py-3 text-base font-semibold outline-none focus:border-teal-600 focus:bg-white" />
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
