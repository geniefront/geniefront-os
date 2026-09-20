import { formatPhoneDisplay } from '@gf/contracts';
import { useState, useMemo } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { toast } from '@heroui/react';
import {
  CheckCircle2,
  PenLine,
  Phone,
  ShieldAlert,
  Sparkles,
  User,
} from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { BirthdateField } from '@/components/ui/BirthdateField';
import { parseBirthdate } from '@gf/contracts';
import type { Language } from '@/i18n/types';
import { INDUSTRY_PRESETS } from '@/features/forms/mockData';
import { BodyMapSelector, type BodyMapValue } from '@/components/forms/BodyMapSelector';
import { SignaturePad } from '@/components/forms/SignaturePad';
import { Modal } from '@/components/ui/Modal';
import { usePublicForms, useSubmitPublicForm } from '@/features/forms/api';
import { publicText, type PublicFormCopyKey } from '@/features/forms/publicCopy';
import {
  HEALTH_FORM_EXPERIENCES,
  inferHealthFormCategory,
  type HealthFormCategory,
} from '@/features/forms/formExperience';
import { useErrorMessage } from '@/lib/errorMessage';
import { formatPhoneInput, normalizePhoneE164 } from '@gf/contracts';

const localized = (value: Partial<Record<string, string>> | undefined, language: string, defaultLanguage = 'en'): string => {
  if (!value) return '';
  return value[language] ?? value[defaultLanguage] ?? value.en ?? Object.values(value)[0] ?? '';
};

const localeByLanguage: Record<Language, string> = {
  'zh-Hans': 'zh-CN',
  en: 'en-US',
  ko: 'ko-KR',
  es: 'es-ES',
  vi: 'vi-VN',
};

export function PublicHealthForm() {
  const { key } = useParams<{ key: string }>();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('t')?.trim() ?? '';
  const errorMessage = useErrorMessage();

  const lang: Language = 'en';
  const publicForms = usePublicForms(token, lang);
  const submitForm = useSubmitPublicForm(token);
  const copy = (key: PublicFormCopyKey, vars?: Record<string, string | number>) =>
    publicText(key, lang, vars);

  // 一次性令牌只允许读取这次邀请点名的模板；无令牌时仅保留预设用于错误页骨架。
  const preset = useMemo(() => {
    const remote = publicForms.data?.forms.find((form) => form.key === key && !form.done)
      ?? publicForms.data?.forms.find((form) => !form.done)
      ?? publicForms.data?.forms[0];
    if (remote) {
      const category = inferHealthFormCategory(remote.key);
      return {
        category,
        name: remote.title,
        template: {
          key: remote.key,
          title: remote.title,
          questions: remote.questions,
          requiresSignature: remote.requiresSignature,
          validDays: null,
          serviceIds: [],
        },
        templateId: remote.templateId,
      };
    }

    const found = INDUSTRY_PRESETS.find(
      (p) => p.template.key === key || p.id === key || p.category === key,
    );
    const fallback = found || INDUSTRY_PRESETS[0]!;
    return { ...fallback, templateId: '' };
  }, [key, publicForms.data?.forms]);

  const template = preset.template;
  const experience = HEALTH_FORM_EXPERIENCES[preset.category as HealthFormCategory];

  // 过滤店主标记为隐藏的问题 (hidden === true)
  const visibleQuestions = useMemo(() => {
    return template.questions.filter((q: any) => !q.hidden);
  }, [template.questions]);
  const groupedQuestions = useMemo(() => {
    const safetyIds = new Set(experience.safetyQuestionIds);
    const assessmentIds = new Set(experience.assessmentQuestionIds);
    return {
      safety: visibleQuestions.filter((question: any) => safetyIds.has(question.id)),
      assessment: visibleQuestions.filter((question: any) => assessmentIds.has(question.id)),
      additional: visibleQuestions.filter((question: any) => !safetyIds.has(question.id) && !assessmentIds.has(question.id)),
    };
  }, [experience, visibleQuestions]);

  // 客户基本信息
  const [clientInfo, setClientInfo] = useState({
    fullName: '',
    dob: '',
    phone: '',
    occupation: '',
    emergencyName: '',
    emergencyPhone: '',
  });

  // 健康排查勾选 (参考 prototype)
  const [conditions, setConditions] = useState<Record<string, boolean>>({});
  const [pregnancyWeeks, setPregnancyWeeks] = useState('');
  const [recentSurgeries, setRecentSurgeries] = useState('');
  const [currentMedications, setCurrentMedications] = useState('');
  const [allergiesText, setAllergiesText] = useState('');

  // 疼痛评估 (0-10)
  const [painLevel, setPainLevel] = useState<number>(0);
  const [painFrequency, setPainFrequency] = useState<'constant' | 'intermittent'>('intermittent');
  const [painDescription, setPainDescription] = useState('');
  const [bodyMap, setBodyMap] = useState<BodyMapValue>({ focus: [], avoid: [] });

  // 动态题目答案
  const [answers, setAnswers] = useState<Record<string, any>>({});

  // 签名
  const [signatureDataUrl, setSignatureDataUrl] = useState<string | null>(null);
  const [signatureText, setSignatureText] = useState('');
  const [signatureDate, setSignatureDate] = useState(() => new Date().toISOString().split('T')[0]);
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [submissionId, setSubmissionId] = useState('');
  const [confirmSubmitOpen, setConfirmSubmitOpen] = useState(false);

  const handleConditionToggle = (cKey: string) => {
    setConditions((prev) => ({ ...prev, [cKey]: !prev[cKey] }));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    if (!clientInfo.fullName.trim()) {
      toast.danger(copy('nameRequired'));
      return;
    }
    if (!clientInfo.phone.trim()) {
      toast.danger(copy('phoneRequired'));
      return;
    }
    if (!normalizePhoneE164(clientInfo.phone)) {
      toast.danger(copy('phoneInvalid'));
      return;
    }
    if (clientInfo.emergencyPhone.trim() && !normalizePhoneE164(clientInfo.emergencyPhone)) {
      toast.danger(copy('phoneInvalid'));
      return;
    }

    if (clientInfo.dob.trim()) {
      const dob = parseBirthdate(clientInfo.dob, { today: publicForms.data?.today, optional: true });
      if (!dob.ok) {
        toast.danger(copy(dob.reason === 'future' ? 'dobFuture' : 'dobInvalid'));
        return;
      }
    }

    if (template.requiresSignature && !signatureDataUrl) {
      toast.danger(copy('signatureRequired'));
      return;
    }

    const missing = visibleQuestions
      .filter((question) => question.required)
      .filter((question) => {
        const value = answers[question.id];
        return value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
      });
    if (missing.length > 0) {
      toast.danger(copy('requiredQuestions'));
      return;
    }

    if (!token || !preset.templateId) {
      toast.danger(copy('invalidLink'));
      return;
    }

    setConfirmSubmitOpen(true);
  };

  const submitConfirmed = async () => {
    const submissionAnswers = {
      ...answers,
      clientInfo: {
        ...clientInfo,
        fullName: clientInfo.fullName.trim(),
        phone: normalizePhoneE164(clientInfo.phone),
        emergencyPhone: clientInfo.emergencyPhone.trim()
          ? normalizePhoneE164(clientInfo.emergencyPhone)
          : null,
      },
      conditions,
      pregnancyWeeks,
      recentSurgeries,
      currentMedications,
      allergiesText,
      painLevel,
      painFrequency,
      painDescription,
      bodyMapFocus: bodyMap.focus,
      bodyMapAvoid: bodyMap.avoid,
    };

    try {
      const result = await submitForm.mutateAsync({
        templateId: preset.templateId,
        answers: submissionAnswers,
        ...(signatureDataUrl ? { signatureDataUrl } : {}),
        signerName: signatureText.trim() || clientInfo.fullName.trim(),
        locale: lang,
      });
      setSubmissionId(result.submissionId);
      if (result.remaining > 0) {
        // 一条邀请可以包含多份必签表。交完当前这一份后刷新令牌会话，
        // 后端会把已完成模板标成 done，页面自动切到下一份。
        setConditions({});
        setPregnancyWeeks('');
        setRecentSurgeries('');
        setCurrentMedications('');
        setAllergiesText('');
        setPainLevel(0);
        setPainFrequency('intermittent');
        setPainDescription('');
        setBodyMap({ focus: [], avoid: [] });
        setAnswers({});
        setSignatureDataUrl(null);
        setSignatureText('');
        await publicForms.refetch();
        window.scrollTo({ top: 0, behavior: 'smooth' });
        toast.success(copy('formSaved', { count: result.remaining }));
      } else {
        setIsSubmitted(true);
        toast.success(copy('submittedToast'));
      }
      setConfirmSubmitOpen(false);
    } catch (error) {
      toast.danger(errorMessage(error));
    }
  };

  const renderQuestions = (questions: any[]) => (
    <div className="space-y-3">
      {questions.map((q: any, idx: number) => {
        const val = answers[q.id];
        return (
          <div key={q.id} className="rounded-xl border border-slate-200/80 bg-slate-50/50 p-4 space-y-2.5 text-xs">
            <label className="block font-bold text-slate-800 leading-snug">
              <span className="text-teal-700 mr-1">{idx + 1}.</span>
              {localized(q.label, lang)}
              {q.required && <span className="text-red-500 ml-1 font-bold">*</span>}
            </label>

            {q.type === 'choice' && (
              <div className="grid gap-2 sm:grid-cols-2">
                {(q.options ?? []).map((opt: any) => {
                  const selected = val === opt.value;
                  return (
                    <button key={opt.value} type="button" onClick={() => setAnswers({ ...answers, [q.id]: opt.value })}
                      className={`rounded-xl border p-2.5 text-left transition-all ${selected ? 'border-teal-500 bg-teal-50 font-bold text-teal-900' : 'border-slate-200 bg-white text-slate-700'}`}>
                      {localized(opt.label, lang)}
                    </button>
                  );
                })}
              </div>
            )}

            {q.type === 'bool' && (
              <div className="grid grid-cols-2 gap-2">
                <button type="button" onClick={() => setAnswers({ ...answers, [q.id]: true })}
                  className={`rounded-xl border py-2.5 font-bold ${val === true ? 'border-teal-500 bg-teal-500 text-white' : 'border-slate-200 bg-white text-slate-700'}`}>
                  Yes
                </button>
                <button type="button" onClick={() => setAnswers({ ...answers, [q.id]: false })}
                  className={`rounded-xl border py-2.5 font-bold ${val === false ? 'border-teal-500 bg-teal-500 text-white' : 'border-slate-200 bg-white text-slate-700'}`}>
                  No
                </button>
              </div>
            )}

            {q.type === 'multi' && (
              <div className="grid gap-2 sm:grid-cols-2">
                {(q.options ?? []).map((opt: any) => {
                  const selected = Array.isArray(val) ? val.includes(opt.value) : false;
                  return (
                    <label key={opt.value} className={`flex cursor-pointer items-center gap-2 rounded-xl border p-2.5 ${selected ? 'border-teal-500 bg-teal-50 font-bold text-teal-900' : 'border-slate-200 bg-white text-slate-700'}`}>
                      <input type="checkbox" checked={selected} onChange={() => {
                        const current = Array.isArray(val) ? val : [];
                        setAnswers({ ...answers, [q.id]: selected ? current.filter((item: string) => item !== opt.value) : [...current, opt.value] });
                      }} className="h-4 w-4 accent-teal-600" />
                      <span>{localized(opt.label, lang)}</span>
                    </label>
                  );
                })}
              </div>
            )}

            {q.type === 'text' && (
              <textarea rows={2} value={typeof val === 'string' ? val : ''}
                onChange={(event) => setAnswers({ ...answers, [q.id]: event.target.value })}
                placeholder="Enter details"
                className="w-full rounded-xl border border-slate-200 bg-white p-2.5 text-xs text-slate-800 placeholder:text-slate-400 focus:border-teal-500 focus:outline-none" />
            )}
          </div>
        );
      })}
    </div>
  );

  if (!token) {
    return (
      <div className="min-h-screen grid place-items-center bg-slate-50 p-6">
        <div className="max-w-md rounded-3xl border border-slate-200 bg-white p-8 text-center shadow-sm">
          <ShieldAlert className="mx-auto mb-4 h-10 w-10 text-amber-500" />
          <h1 className="text-lg font-black text-slate-900">{copy('incompleteTitle')}</h1>
          <p className="mt-2 text-sm text-slate-500">{copy('incompleteBody')}</p>
        </div>
      </div>
    );
  }

  if (publicForms.isLoading) {
    return <div className="min-h-screen grid place-items-center bg-slate-50 text-sm text-slate-500">{copy('loading')}</div>;
  }

  if (publicForms.isError || !publicForms.data || !preset.templateId) {
    return (
      <div className="min-h-screen grid place-items-center bg-slate-50 p-6">
        <div className="max-w-md rounded-3xl border border-slate-200 bg-white p-8 text-center shadow-sm">
          <ShieldAlert className="mx-auto mb-4 h-10 w-10 text-rose-500" />
          <h1 className="text-lg font-black text-slate-900">{copy('unavailableTitle')}</h1>
          <p className="mt-2 text-sm text-slate-500">{copy('unavailableBody')}</p>
          {publicForms.data?.shopPhone && <p className="mt-4 font-mono text-sm text-teal-700">{formatPhoneDisplay(publicForms.data.shopPhone)}</p>}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 py-8 px-4 sm:px-6 font-sans text-slate-800">
      <div className="mx-auto max-w-4xl space-y-6">
        <div className="relative flex flex-col items-center justify-center text-center space-y-2 border-b border-slate-200 pb-5">
          <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-teal-700">
            {publicForms.data.shopName}
          </p>
          <h1 className="text-2xl sm:text-3xl font-black tracking-tight text-slate-900">
            {localized(template.title, lang)}
          </h1>
          <p className="text-xs sm:text-sm text-slate-500 max-w-xl">
            {publicForms.data.forms.length > 1
              ? copy('formsProgress', {
                  total: publicForms.data.forms.length,
                  done: publicForms.data.forms.filter((form) => form.done).length,
                })
              : copy('encryptedNotice')}
          </p>
          {publicForms.data.maskedName && (
            <Badge variant="outline" className="text-[10px] text-slate-600">
              {copy('inviteFor')}: {publicForms.data.maskedName}
            </Badge>
          )}
        </div>

        {isSubmitted ? (
          /* 提交成功回执 */
          <div className="rounded-3xl border border-slate-200 bg-white p-8 text-center shadow-lg space-y-5">
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-emerald-50 text-emerald-600 shadow-inner">
              <CheckCircle2 className="h-10 w-10" />
            </div>
            <div>
              <h2 className="text-xl font-black text-slate-900">
                {copy('successTitle')}
              </h2>
              <p className="text-xs text-slate-500 mt-1">
                {copy('successBody')}
              </p>
            </div>

            <div className="rounded-2xl bg-slate-50 p-4 border border-slate-200 text-xs font-mono text-slate-600 space-y-1">
              <div>{copy('receiptId')}: #{submissionId}</div>
              <div>{copy('client')}: {clientInfo.fullName}</div>
              <div>{copy('timestamp')}: {new Date().toLocaleString(localeByLanguage[lang])}</div>
            </div>

            <Button
              variant="outline"
              size="sm"
              onClick={() => void navigator.clipboard.writeText(submissionId)}
            >
              <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />
              {copy('copyReceipt')}
            </Button>
          </div>
        ) : (
          /* 主表单 */
          <form onSubmit={handleSubmit} className="space-y-6">
            {/* 1. Client Information */}
            <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm space-y-4">
              <h3 className="text-xs font-bold text-slate-800 bg-slate-100 px-3 py-2 rounded-xl">
                {copy('clientInfo')}
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
                <div>
                  <label className="block font-bold text-slate-700 mb-1">
                    {copy('fullName')} <span className="text-red-500">*</span>
                  </label>
                  <Input
                    required
                    value={clientInfo.fullName}
                    onChange={(e) => setClientInfo({ ...clientInfo, fullName: e.target.value })}
                    placeholder="Jane Doe"
                    className="text-xs"
                  />
                </div>
                <BirthdateField
                  label={copy('dateOfBirth')}
                  value={clientInfo.dob}
                  onChange={(iso) => setClientInfo({ ...clientInfo, dob: iso })}
                  today={publicForms.data?.today}
                  optional
                  errorText={{
                    invalid_date: copy('dobBadDay'),
                    format: copy('dobInvalid'),
                    future: copy('dobFuture'),
                  }}
                />
                <div>
                  <label className="block font-bold text-slate-700 mb-1">
                    {copy('phoneNumber')} <span className="text-red-500">*</span>
                  </label>
                  <Input type="tel"
                    required
                    value={clientInfo.phone}
                    onChange={(e) => setClientInfo({ ...clientInfo, phone: e.target.value })}
                    placeholder="(555) 123-4567"
                    maxLength={32}
                    className="text-xs font-mono"
                  />
                </div>
                <div>
                  <label className="block font-bold text-slate-700 mb-1">
                    {copy('occupation')}
                  </label>
                  <Input
                    value={clientInfo.occupation}
                    onChange={(e) => setClientInfo({ ...clientInfo, occupation: e.target.value })}
                    placeholder="e.g. Office Worker / Driver"
                    className="text-xs"
                  />
                </div>
                <div>
                  <label className="block font-bold text-slate-700 mb-1">
                    {copy('emergencyName')}
                  </label>
                  <Input
                    value={clientInfo.emergencyName}
                    onChange={(e) => setClientInfo({ ...clientInfo, emergencyName: e.target.value })}
                    placeholder="Emergency Contact"
                    className="text-xs"
                  />
                </div>
                <div>
                  <label className="block font-bold text-slate-700 mb-1">
                    {copy('emergencyPhone')}
                  </label>
                  <Input type="tel"
                    value={clientInfo.emergencyPhone}
                    onChange={(e) => setClientInfo({ ...clientInfo, emergencyPhone: e.target.value })}
                    placeholder="(555) 987-6543"
                    maxLength={32}
                    className="text-xs font-mono"
                  />
                </div>
              </div>
            </div>

            {/* 2. Health Information & Contraindications (完全贴合 Prototype) */}
            <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm space-y-4">
              <h3 className="rounded-xl bg-slate-100 px-3 py-2 text-xs font-bold text-slate-800">
                {experience.safetyTitle}
              </h3>
              <p className="text-xs text-slate-500">Please answer these questions so the provider can determine whether the service can be performed safely.</p>
              {renderQuestions(groupedQuestions.safety)}
            </div>

            {false && (
            <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm space-y-4">
              <h3 className="text-xs font-bold text-slate-800 bg-slate-100 px-3 py-2 rounded-xl flex items-center justify-between">
                <span>{copy('healthTitle')}</span>
                <span className="text-[10px] text-amber-700 font-medium flex items-center gap-1">
                  <ShieldAlert className="h-3.5 w-3.5" />
                  {copy('safetyCheck')}
                </span>
              </h3>
              <p className="text-xs text-slate-500">
                {copy('conditionPrompt')}
              </p>

              <div className="grid grid-cols-2 md:grid-cols-3 gap-y-3 gap-x-3 text-xs">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={Boolean(conditions['high_low_bp'])}
                    onChange={() => handleConditionToggle('high_low_bp')}
                    className="h-4 w-4 rounded accent-teal-600"
                  />
                  <span>{copy('highLowBp')}</span>
                </label>

                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={Boolean(conditions['heart_condition'])}
                    onChange={() => handleConditionToggle('heart_condition')}
                    className="h-4 w-4 rounded accent-teal-600"
                  />
                  <span>{copy('heartCondition')}</span>
                </label>

                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={Boolean(conditions['diabetes'])}
                    onChange={() => handleConditionToggle('diabetes')}
                    className="h-4 w-4 rounded accent-teal-600"
                  />
                  <span>{copy('diabetes')}</span>
                </label>

                <label className="flex items-center gap-2 cursor-pointer text-rose-600 font-bold">
                  <input
                    type="checkbox"
                    checked={Boolean(conditions['pacemaker'])}
                    onChange={() => handleConditionToggle('pacemaker')}
                    className="h-4 w-4 rounded accent-rose-600"
                  />
                  <span>{copy('pacemaker')}</span>
                </label>

                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={Boolean(conditions['blood_clots'])}
                    onChange={() => handleConditionToggle('blood_clots')}
                    className="h-4 w-4 rounded accent-teal-600"
                  />
                  <span>{copy('bloodClots')}</span>
                </label>

                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={Boolean(conditions['cancer_oncology'])}
                    onChange={() => handleConditionToggle('cancer_oncology')}
                    className="h-4 w-4 rounded accent-teal-600"
                  />
                  <span>{copy('cancer')}</span>
                </label>

                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={Boolean(conditions['spine_neck'])}
                    onChange={() => handleConditionToggle('spine_neck')}
                    className="h-4 w-4 rounded accent-teal-600"
                  />
                  <span>{copy('spineNeck')}</span>
                </label>

                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={Boolean(conditions['arthritis'])}
                    onChange={() => handleConditionToggle('arthritis')}
                    className="h-4 w-4 rounded accent-teal-600"
                  />
                  <span>{copy('arthritis')}</span>
                </label>

                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={Boolean(conditions['fibromyalgia'])}
                    onChange={() => handleConditionToggle('fibromyalgia')}
                    className="h-4 w-4 rounded accent-teal-600"
                  />
                  <span>{copy('fibromyalgia')}</span>
                </label>

                <label className="flex items-center gap-2 cursor-pointer col-span-2">
                  <input
                    type="checkbox"
                    checked={Boolean(conditions['pregnancy'])}
                    onChange={() => handleConditionToggle('pregnancy')}
                    className="h-4 w-4 rounded accent-teal-600"
                  />
                  <span>{copy('pregnancy')}</span>
                  <input
                    type="number"
                    value={pregnancyWeeks}
                    onChange={(e) => setPregnancyWeeks(e.target.value)}
                    placeholder={copy('weeks')}
                    className="w-20 ml-2 border rounded-lg px-2 py-0.5 text-xs"
                  />
                </label>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs pt-2">
                <div>
                  <label className="block font-bold text-slate-700 mb-1">
                    {copy('recentSurgery')}:
                  </label>
                  <Input
                    value={recentSurgeries}
                    onChange={(e) => setRecentSurgeries(e.target.value)}
                    placeholder={copy('describeOrNone')}
                    className="text-xs"
                  />
                </div>
                <div>
                  <label className="block font-bold text-slate-700 mb-1">
                    {copy('medications')}:
                  </label>
                  <Input
                    value={currentMedications}
                    onChange={(e) => setCurrentMedications(e.target.value)}
                    placeholder={copy('listOrNone')}
                    className="text-xs"
                  />
                </div>
                <div className="md:col-span-2">
                  <label className="block font-bold text-slate-700 mb-1">
                    {copy('allergies')}:
                  </label>
                  <Input
                    value={allergiesText}
                    onChange={(e) => setAllergiesText(e.target.value)}
                    placeholder={copy('allergyPlaceholder')}
                    className="text-xs"
                  />
                </div>
              </div>
            </div>
            )}

            {/* 3. Pain Assessment & Interactive Body Map (疼痛评估与人体解剖模型) */}
            <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm space-y-5">
              <h3 className="text-xs font-bold text-slate-800 bg-slate-100 px-3 py-2 rounded-xl flex items-center justify-between">
                <span>{experience.assessmentTitle}</span>
                <span className="text-[10px] text-teal-700 font-medium">
                  {experience.assessmentHint}
                </span>
              </h3>

              {experience.assessmentMode === 'pain_body_map' && (
              <>
              {/* 疼痛滑尺 */}
              <div className="rounded-2xl border border-teal-200/80 bg-teal-50/40 p-4 space-y-4">
                <div className="flex flex-col md:flex-row gap-6 items-center">
                  <div className="flex-1 w-full space-y-2">
                    <label className="block font-bold text-slate-800 text-xs">
                      {copy('painLevel')}:
                      <span className="ml-2 text-sm font-black text-teal-700 bg-white px-2 py-0.5 rounded-lg border border-teal-200 shadow-xs">
                        {painLevel}
                      </span>
                    </label>
                    <input
                      type="range"
                      min="0"
                      max="10"
                      value={painLevel}
                      onChange={(e) => setPainLevel(Number(e.target.value))}
                      className="w-full accent-teal-600 cursor-pointer h-2 bg-slate-200 rounded-lg"
                    />
                    <div className="flex justify-between text-[10px] text-slate-500 font-medium">
                      <span>0 ({copy('painNone')})</span>
                      <span>5 ({copy('painModerate')})</span>
                      <span>10 ({copy('painSevere')})</span>
                    </div>
                  </div>

                  <div className="flex-1 w-full text-xs space-y-2">
                    <label className="block font-bold text-slate-800">
                      {copy('painFrequency')}:
                    </label>
                    <div className="flex gap-3">
                      <button
                        type="button"
                        onClick={() => setPainFrequency('constant')}
                        className={`flex-1 py-2 px-3 rounded-xl border text-xs font-bold transition-all ${
                          painFrequency === 'constant'
                            ? 'border-teal-500 bg-white text-teal-900 shadow-xs'
                            : 'border-slate-200 bg-white/60 text-slate-600'
                        }`}
                      >
                        {copy('constant')}
                      </button>
                      <button
                        type="button"
                        onClick={() => setPainFrequency('intermittent')}
                        className={`flex-1 py-2 px-3 rounded-xl border text-xs font-bold transition-all ${
                          painFrequency === 'intermittent'
                            ? 'border-teal-500 bg-white text-teal-900 shadow-xs'
                            : 'border-slate-200 bg-white/60 text-slate-600'
                        }`}
                      >
                        {copy('intermittent')}
                      </button>
                    </div>
                  </div>
                </div>

                <div className="text-xs">
                  <label className="block font-bold text-slate-800 mb-1">
                    {copy('painDescription')}:
                  </label>
                  <Input
                    value={painDescription}
                    onChange={(e) => setPainDescription(e.target.value)}
                    placeholder={copy('painPlaceholder')}
                    className="bg-white text-xs"
                  />
                </div>
              </div>

              {/* 互动人体模型 */}
              <BodyMapSelector
                value={bodyMap}
                onChange={setBodyMap}
                activeLanguage={lang}
              />
              </>
              )}

              {renderQuestions(groupedQuestions.assessment)}
            </div>

            {/* 4. 行业定制题目 (店主可在后台控制是否显示) */}
            {groupedQuestions.additional.length > 0 && (
              <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm space-y-4">
                <h3 className="text-xs font-bold text-slate-800 bg-slate-100 px-3 py-2 rounded-xl">
                  3. Additional questions
                </h3>

                <div className="space-y-4">
                  {groupedQuestions.additional.map((q: any, idx: number) => {
                    const val = answers[q.id];
                    return (
                      <div key={q.id} className="rounded-xl border border-slate-200/80 bg-slate-50/50 p-4 space-y-2.5 text-xs">
                        <label className="block font-bold text-slate-800 leading-snug">
                          <span className="text-teal-700 mr-1">{idx + 1}.</span>
                          {localized(q.label, lang)}
                          {q.required && <span className="text-red-500 ml-1 font-bold">*</span>}
                        </label>

                        {q.type === 'choice' && (
                          <div className="space-y-1.5">
                            {(q.options ?? []).map((opt: any) => {
                              const isSel = val === opt.value;
                              return (
                                <button
                                  key={opt.value}
                                  type="button"
                                  onClick={() => setAnswers({ ...answers, [q.id]: opt.value })}
                                  className={`flex w-full items-center gap-2.5 rounded-xl border p-2.5 text-left text-xs transition-all ${
                                    isSel
                                      ? 'border-teal-500 bg-teal-50/70 font-bold text-teal-900'
                                      : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                                  }`}
                                >
                                  <span
                                    className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                                      isSel ? 'border-teal-600 bg-teal-600 text-white' : 'border-slate-300'
                                    }`}
                                  >
                                    {isSel && <span className="h-1.5 w-1.5 rounded-full bg-white" />}
                                  </span>
                                  <span>{localized(opt.label, lang)}</span>
                                </button>
                              );
                            })}
                          </div>
                        )}

                        {q.type === 'bool' && (
                          <div className="grid grid-cols-2 gap-2">
                            <button
                              type="button"
                              onClick={() => setAnswers({ ...answers, [q.id]: true })}
                              className={`rounded-xl border py-2.5 text-xs font-bold transition-all ${
                                val === true
                                  ? 'border-teal-500 bg-teal-500 text-white shadow-xs'
                                  : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                              }`}
                            >
                              {copy('yes')}
                            </button>
                            <button
                              type="button"
                              onClick={() => setAnswers({ ...answers, [q.id]: false })}
                              className={`rounded-xl border py-2.5 text-xs font-bold transition-all ${
                                val === false
                                  ? 'border-teal-500 bg-teal-500 text-white shadow-xs'
                                  : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                              }`}
                            >
                              {copy('no')}
                            </button>
                          </div>
                        )}

                        {q.type === 'multi' && (
                          <div className="grid gap-2 sm:grid-cols-2">
                            {(q.options ?? []).map((opt: any) => {
                              const selected = Array.isArray(val) ? val.includes(opt.value) : false;
                              return (
                                <label
                                  key={opt.value}
                                  className={`flex cursor-pointer items-center gap-2 rounded-xl border p-2.5 transition-all ${
                                    selected
                                      ? 'border-teal-500 bg-teal-50 font-bold text-teal-900'
                                      : 'border-slate-200 bg-white text-slate-700'
                                  }`}
                                >
                                  <input
                                    type="checkbox"
                                    checked={selected}
                                    onChange={() => {
                                      const current = Array.isArray(val) ? val : [];
                                      setAnswers({
                                        ...answers,
                                        [q.id]: selected
                                          ? current.filter((item: string) => item !== opt.value)
                                          : [...current, opt.value],
                                      });
                                    }}
                                    className="h-4 w-4 accent-teal-600"
                                  />
                                  <span>{localized(opt.label, lang)}</span>
                                </label>
                              );
                            })}
                          </div>
                        )}

                        {q.type === 'text' && (
                          <textarea
                            rows={2}
                            value={typeof val === 'string' ? val : ''}
                            onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })}
                            placeholder={copy('detailsPlaceholder')}
                            className="w-full rounded-xl border border-slate-200 bg-white p-2.5 text-xs text-slate-800 placeholder:text-slate-400 focus:border-teal-500 focus:outline-none"
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* 5. Consent & Liability Waiver (免责与知情同意书 - 还原 Prototype) */}
            <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm space-y-4">
              <h3 className="text-xs font-bold text-slate-800 bg-slate-100 px-3 py-2 rounded-xl">
                {copy('waiverTitle')}
              </h3>

              <p className="text-xs text-slate-600 text-justify leading-relaxed bg-slate-50 p-4 rounded-xl border border-slate-200">
                {copy('waiverBody')}
              </p>

              {/* 手写签名板 */}
              <div className="pt-2 space-y-3">
                <SignaturePad
                  onSave={(dataUrl) => setSignatureDataUrl(dataUrl)}
                  onClear={() => setSignatureDataUrl(null)}
                  width={720}
                  activeLanguage={lang}
                />

                <div className="flex flex-col sm:flex-row items-center gap-3">
                  <div className="flex-1 w-full">
                    <label className="block text-[11px] font-bold text-slate-700 mb-1">
                      {copy('legalName')}:
                    </label>
                    <Input
                      value={signatureText}
                      onChange={(e) => setSignatureText(e.target.value)}
                      placeholder="Jane Doe"
                      className="text-xs font-serif italic"
                    />
                  </div>
                  <div className="w-full sm:w-44">
                    <label className="block text-[11px] font-bold text-slate-700 mb-1">
                      {copy('signingDate')}:
                    </label>
                    <Input
                      type="date"
                      value={signatureDate}
                      onChange={(e) => setSignatureDate(e.target.value)}
                      className="text-xs"
                    />
                  </div>
                </div>
              </div>

              <div className="pt-4">
                <Button
                  type="submit"
                  size="lg"
                  disabled={submitForm.isPending}
                  className="w-full bg-teal-600 hover:bg-teal-700 text-white font-bold py-3.5 shadow-md"
                >
                  <CheckCircle2 className="mr-2 h-5 w-5" />
                  {submitForm.isPending ? copy('submitting') : copy('submit')}
                </Button>
              </div>
            </div>
          </form>
        )}
      </div>
      <Modal
        isOpen={confirmSubmitOpen}
        onOpenChange={setConfirmSubmitOpen}
        title={copy('confirmSubmitTitle')}
        description={copy('confirmSubmitBody')}
        size="sm"
        footer={(
          /*
           * 装不下就换行，而不是挤成一行溢出去。
           *
           * ⚠️ 这里**不能用 `sm:` 这类断点** —— 断点跟的是视口宽度，而溢出
           * 取决于对话框自身的宽度：`size="sm"` 的弹窗只有 336px，1280px 的
           * 桌面视口下照样装不下「Review answers」+「Confirm and submit
           * securely」（138 + 224 + 8 = 370px）。原来就是这么溢出的：靠右对齐
           * 时多出来的部分从左边顶出去，看着像文字从药丸里挤了出来。
           *
           * `flex-wrap` 按真实可用空间决定换不换行，因此中文（「返回检查」
           * 「确认并安全提交」）仍是一行，英文自动折成两行。`shrink-0` 保证
           * 按钮不会被压缩到比自己的文字还窄。
           */
          <div className="flex w-full flex-wrap justify-end gap-2">
            <Button
              variant="outline"
              className="shrink-0"
              onClick={() => setConfirmSubmitOpen(false)}
            >
              {copy('cancel')}
            </Button>
            <Button
              isPending={submitForm.isPending}
              disabled={submitForm.isPending}
              onClick={() => void submitConfirmed()}
              className="shrink-0 bg-teal-600 font-bold text-white hover:bg-teal-700"
            >
              {submitForm.isPending ? copy('submitting') : copy('confirmSubmitAction')}
            </Button>
          </div>
        )}
      />
    </div>
  );
}
