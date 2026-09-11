import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from '@heroui/react';
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  ClipboardCheck,
  ClipboardList,
  Clock,
  Copy,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  FileCheck,
  FileText,
  Filter,
  Flame,
  Globe,
  Languages,
  Mail,
  MessageCircle,
  MessageSquare,
  PenLine,
  Phone,
  Plus,
  Printer,
  QrCode,
  RotateCcw,
  Save,
  Search,
  Send,
  Share2,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Tablet,
  Trash2,
  User,
  X,
} from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/Card';
import { GuardedButton } from '@/components/ui/GuardedButton';
import { Input } from '@/components/ui/Input';
import { ConfirmDialog, Modal } from '@/components/ui/Modal';
import { useLanguage } from '@/LanguageContext';
import { UI_LANGUAGES, type Language } from '@/i18n/types';
import { useErrorMessage } from '@/lib/errorMessage';
import { useDeskSettingsQuery } from '@/features/settings/api';
import {
  useFormsQuery,
  useAccessFormSubmission,
  useGenerateFormQuestions,
  useSaveFormTemplate,
  useShareForm,
  type FormShareResult,
  type FormSubmissionSummary,
  type FormQuestion,
  type FormQuestionType,
  type SaveFormTemplateInput,
} from '@/features/forms/api';
import {
  INDUSTRY_PRESETS,
  AI_QUICK_PROMPTS,
  generateAiHealthSummary,
  type FormSubmissionRecord,
  type IndustryPreset,
} from '@/features/forms/mockData';
import { BodyMapSelector, type BodyMapValue } from '@/components/forms/BodyMapSelector';
import { SignaturePad } from '@/components/forms/SignaturePad';
import {
  categoryForBusinessType,
  type HealthFormCategory,
} from '@/features/forms/formExperience';

const clone = <T,>(value: T): T => structuredClone(value);

const localized = (value: Partial<Record<string, string>> | undefined, language: string, defaultLanguage = 'zh-Hans'): string => {
  if (!value) return '';
  return value[language] ?? value[defaultLanguage] ?? value.en ?? Object.values(value)[0] ?? '';
};

// 带有隐藏标记的问题类型
export interface EditableFormQuestion extends FormQuestion {
  hidden?: boolean;
}

export interface EditableFormTemplate extends Omit<SaveFormTemplateInput, 'questions'> {
  questions: EditableFormQuestion[];
}

export function HealthForms() {
  const navigate = useNavigate();
  const { language, setLanguage, t } = useLanguage();
  const formsQ = useFormsQuery();
  const save = useSaveFormTemplate();
  const share = useShareForm();
  const accessSubmission = useAccessFormSubmission();
  const generateQuestions = useGenerateFormQuestions();
  const settingsQ = useDeskSettingsQuery();
  const errorMessage = useErrorMessage();

  // 当前选中的行业模板类别 (按摩 / 美容 / 美甲 / 头疗)
  const [activeCategory, setActiveCategory] = useState<HealthFormCategory>('nail');
  const [isViewingSubmissions, setIsViewingSubmissions] = useState(false);

  // 所有行业模板的编辑状态；真实已发布版本会在查询完成后覆盖对应预设。
  const [templateStore, setTemplateStore] = useState<Record<string, EditableFormTemplate>>(() => {
    const initial: Record<string, EditableFormTemplate> = {};
    INDUSTRY_PRESETS.forEach((preset) => {
      initial[preset.category] = clone(preset.template) as EditableFormTemplate;
    });
    return initial;
  });
  const hydratedVersions = useRef<Record<string, number>>({});
  const initializedFromBusinessType = useRef(false);

  useEffect(() => {
    if (!formsQ.data?.templates) return;
    setTemplateStore((current) => {
      const next = { ...current };
      for (const template of formsQ.data.templates) {
        const preset = INDUSTRY_PRESETS.find((item) => item.template.key === template.key);
        if (!preset || hydratedVersions.current[template.key] === template.version) continue;
        next[preset.category] = {
          key: template.key,
          title: template.title,
          questions: template.questions,
          requiresSignature: template.requiresSignature,
          validDays: template.validDays,
          serviceIds: template.serviceIds,
        };
        hydratedVersions.current[template.key] = template.version;
      }
      return next;
    });
  }, [formsQ.data?.templates]);

  useEffect(() => {
    const businessType = settingsQ.data?.location.businessType;
    if (!businessType || initializedFromBusinessType.current) return;
    const category = categoryForBusinessType(businessType);
    if (INDUSTRY_PRESETS.some((preset) => preset.category === category)) {
      setActiveCategory(category);
    }
    initializedFromBusinessType.current = true;
  }, [settingsQ.data?.location.businessType]);

  // 当前激活的模板草稿
  const draft = useMemo(() => {
    return templateStore[activeCategory] || (clone(INDUSTRY_PRESETS[0]!.template) as EditableFormTemplate);
  }, [templateStore, activeCategory]);

  const setDraft = (newDraft: EditableFormTemplate) => {
    setTemplateStore((prev) => ({ ...prev, [activeCategory]: newDraft }));
    setShareResult(null);
  };

  const submissionsList = formsQ.data?.submissions ?? [];

  const [selectedRecord, setSelectedRecord] = useState<FormSubmissionRecord | null>(null);

  // 弹窗状态
  const [aiModalOpen, setAiModalOpen] = useState(false);
  const [aiPrompt, setAiPrompt] = useState('');
  const [isAiGenerating, setIsAiGenerating] = useState(false);
  const [qrModalOpen, setQrModalOpen] = useState(false);
  const [dispatchModalOpen, setDispatchModalOpen] = useState(false);
  const [dispatchChannel, setDispatchChannel] = useState<'whatsapp' | 'email'>('whatsapp');
  const [dispatchEmail, setDispatchEmail] = useState('');
  const [shareResult, setShareResult] = useState<FormShareResult | null>(null);

  // 添加新问题弹窗
  const [addQuestionModalOpen, setAddQuestionModalOpen] = useState(false);
  const [newQuestionType, setNewQuestionType] = useState<FormQuestionType>('choice');
  const [newQuestionLabel, setNewQuestionLabel] = useState('');
  const [newQuestionRequired, setNewQuestionRequired] = useState(false);
  const [newQuestionOptions, setNewQuestionOptions] = useState<string[]>(['Option 1', 'Option 2']);

  // 当前行业预设对象
  const currentPreset = useMemo(() => {
    return INDUSTRY_PRESETS.find((p) => p.category === activeCategory) || INDUSTRY_PRESETS[0]!;
  }, [activeCategory]);

  // 切换行业模板
  const handleSelectPreset = (category: HealthFormCategory) => {
    setActiveCategory(category);
    setIsViewingSubmissions(false);
    setShareResult(null);
    const presetObj = INDUSTRY_PRESETS.find((p) => p.category === category);
    if (presetObj) {
      toast.success(t('healthForms.success1', { p0: localized(presetObj.name, language) }));
    }
  };

  // 切换某问题的显示 / 隐藏状态
  const handleToggleQuestionVisibility = (index: number) => {
    const questions = [...draft.questions];
    const target = questions[index]!;
    target.hidden = !target.hidden;
    setDraft({ ...draft, questions });
    if (target.hidden) {
      toast.warning(t('healthForms.warning2'));
    } else {
      toast.success(t('healthForms.success3'));
    }
  };

  // 删除问题
  const handleDeleteQuestion = (index: number) => {
    if (draft.questions.length <= 1) {
      toast.danger(t('healthForms.danger4'));
      return;
    }
    const questions = draft.questions.filter((_, idx) => idx !== index);
    setDraft({ ...draft, questions });
    toast.success(t('healthForms.success5'));
  };

  // 上下移动题目
  const handleMoveQuestion = (index: number, direction: 'up' | 'down') => {
    const targetIdx = direction === 'up' ? index - 1 : index + 1;
    if (targetIdx < 0 || targetIdx >= draft.questions.length) return;
    const questions = [...draft.questions];
    const temp = questions[index]!;
    questions[index] = questions[targetIdx]!;
    questions[targetIdx] = temp;
    setDraft({ ...draft, questions });
  };

  // 添加自定义新问题
  const handleConfirmAddQuestion = () => {
    if (!newQuestionLabel.trim()) {
      toast.danger(t('healthForms.danger6'));
      return;
    }

    const newQ: EditableFormQuestion = {
      id: `q_${crypto.randomUUID().slice(0, 8)}`,
      type: newQuestionType,
      label: {
        'zh-Hans': newQuestionLabel,
        en: newQuestionLabel,
        ko: newQuestionLabel,
        es: newQuestionLabel,
        vi: newQuestionLabel,
      },
      required: newQuestionRequired,
      hidden: false,
      options:
        newQuestionType === 'choice' || newQuestionType === 'multi'
          ? newQuestionOptions.filter((o) => o.trim()).map((opt, i) => ({
              value: `opt_${i + 1}`,
              label: {
                'zh-Hans': opt,
                en: opt,
                ko: opt,
                es: opt,
                vi: opt,
              },
            }))
          : undefined,
    };

    setDraft({
      ...draft,
      questions: [...draft.questions, newQ],
    });

    setAddQuestionModalOpen(false);
    setNewQuestionLabel('');
    setNewQuestionOptions(['Option 1', 'Option 2']);
    toast.success(t('healthForms.success7'));
  };

  // AI 智能出题 / 增补
  const handleRunAi = async (customPrompt?: string, actionType?: string) => {
    const promptToUse = customPrompt || aiPrompt;
    if (!promptToUse.trim()) {
      toast.danger(t('healthForms.danger8'));
      return;
    }

    setIsAiGenerating(true);
    try {
      const result = await generateQuestions.mutateAsync({
        prompt: promptToUse,
        actionType: actionType ?? 'generate_specialty',
        templateTitle: draft.title,
        existingQuestions: draft.questions,
      });
      const generated = result.questions.map((question) => ({ ...question, hidden: false }));
      if ((actionType ?? '') === 'translate_all') {
        setDraft({ ...draft, questions: generated });
        toast.success(t('healthForms.success9'));
      } else {
        const existingIds = new Set(draft.questions.map((question) => question.id));
        const additions = generated.filter((question) => !existingIds.has(question.id));
        if (additions.length === 0) throw new Error('AI 没有生成可添加的新问题');
        setDraft({ ...draft, questions: [...draft.questions, ...additions] });
        toast.success(t('healthForms.success10', { p0: additions.length }));
      }
      setAiModalOpen(false);
      setAiPrompt('');
    } catch (error) {
      toast.danger(errorMessage(error));
    } finally {
      setIsAiGenerating(false);
    }
  };

  // 保存并发布模板到后端与本地
  const handlePublishTemplate = async () => {
    try {
      await save.mutateAsync({ ...draft, questions: draft.questions });
      setShareResult(null);
      toast.success(t('healthForms.success11', { p0: localized(draft.title, language) }));
    } catch (error) {
      toast.danger(errorMessage(error));
    }
  };

  const activePublishedTemplate = formsQ.data?.templates.find((template) => template.key === draft.key);
  const intakeShareUrl = shareResult?.url ?? '';

  const createShareLink = async (channel: 'qr' | 'email' = 'qr', email?: string) => {
    if (!activePublishedTemplate) {
      toast.warning(t('healthForms.warning12'));
      return null;
    }
    try {
      const created = await share.mutateAsync({
        templateIds: [activePublishedTemplate.templateId],
        customerId: null,
        appointmentId: null,
        channel,
        ...(email ? { email } : {}),
        locale: 'en',
      });
      setShareResult(created);
      return created;
    } catch (error) {
      toast.danger(errorMessage(error));
      return null;
    }
  };

  const openStandaloneForm = async () => {
    const popup = window.open('', '_blank');
    const created = shareResult ?? await createShareLink();
    if (created) {
      if (popup) popup.location.href = created.url;
      else window.location.assign(created.url);
    } else {
      popup?.close();
    }
  };

  const copyShareLink = async () => {
    const created = shareResult ?? await createShareLink();
    if (!created) return;
    await navigator.clipboard.writeText(created.url);
    toast.success(t('healthForms.success13'));
  };

  const openSubmission = async (summary: FormSubmissionSummary) => {
    if (!formsQ.data?.canViewContent) {
      toast.warning(t('healthForms.warning14'));
      return;
    }
    try {
      const detail = await accessSubmission.mutateAsync(summary.submissionId);
      const answerRecord = (detail.answers ?? {}) as Record<string, any>;
      const avoidAreas = new Set<string>(
        Array.isArray(answerRecord.bodyMapAvoid) ? answerRecord.bodyMapAvoid : [],
      );
      let hasHealthFlag = false;
      for (const question of detail.questions) {
        const value = answerRecord[question.id];
        if (question.sync === 'avoid_areas') {
          for (const area of Array.isArray(value) ? value : [value]) {
            if (typeof area === 'string' && area !== 'none' && area !== 'no') avoidAreas.add(area);
          }
        }
        if (question.sync === 'health_flag') {
          const values = Array.isArray(value) ? value : [value];
          hasHealthFlag ||= values.some((item) => item !== undefined && item !== null && item !== false && item !== 'none' && item !== 'no');
        }
      }
      const generalConditions = answerRecord.conditions;
      if (generalConditions && typeof generalConditions === 'object') {
        hasHealthFlag ||= Object.values(generalConditions).some((value) => value === true);
      }
      const base: FormSubmissionRecord = {
        id: detail.submissionId,
        templateKey: summary.templateKey,
        templateTitle: detail.templateTitle,
        templateVersion: detail.templateVersion,
        customerName: detail.customerName ?? detail.signerName ?? 'Guest',
        customerPhone: String((answerRecord.clientInfo as { phone?: string } | undefined)?.phone ?? ''),
        submittedAt: detail.signedAt ?? summary.createdAt,
        expiresAt: detail.expiresOn,
        status: summary.expired ? 'expired' : 'valid',
        hasHealthFlag,
        avoidAreas: [...avoidAreas],
        answers: answerRecord,
        ...(detail.signatureUrl ? { signatureDataUrl: detail.signatureUrl } : {}),
      };
      const aiSummary = generateAiHealthSummary(base);
      setSelectedRecord({
        ...base,
        hasHealthFlag: aiSummary.riskLevel !== 'low',
        status: summary.expired ? 'expired' : aiSummary.riskLevel === 'low' ? 'valid' : 'flagged',
        aiSummary,
      });
    } catch (error) {
      toast.danger(errorMessage(error));
    }
  };

  const regenerateSelectedSummary = () => {
    setSelectedRecord((record) => {
      if (!record) return record;
      const aiSummary = generateAiHealthSummary(record);
      return {
        ...record,
        aiSummary,
        hasHealthFlag: aiSummary.riskLevel !== 'low',
        status: record.status === 'expired' ? 'expired' : aiSummary.riskLevel === 'low' ? 'valid' : 'flagged',
      };
    });
    toast.success(t('healthForms.success15'));
  };

  const visibleCount = draft.questions.filter((q) => !q.hidden).length;
  const hiddenCount = draft.questions.filter((q) => q.hidden).length;

  return (
    <div className="mx-auto max-w-6xl space-y-5 pb-28 pt-2">
      <div className="flex flex-col gap-4 border-b border-slate-200 pb-5 lg:flex-row lg:items-end lg:justify-between">
        <div className="space-y-1.5">
          <div className="flex items-center gap-2 text-teal-700">
            <ClipboardList className="h-5 w-5" />
            <span className="text-[11px] font-black uppercase tracking-[0.16em]">{t('healthForms.workspaceLabel')}</span>
          </div>
          <h1 className="text-2xl font-black tracking-tight text-slate-950 sm:text-3xl">{t('healthForms.managementTitle')}</h1>
          <p className="max-w-2xl text-sm text-slate-500">
            {t('healthForms.managementDesc')}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex h-9 items-center gap-2 rounded-xl border border-slate-300 bg-white px-3 text-xs font-bold text-slate-700 shadow-xs">
            <span className="text-slate-400">{t('healthForms.currentForm')}</span>
            <select
              value={activeCategory}
              onChange={(event) => handleSelectPreset(event.target.value as HealthFormCategory)}
              className="bg-transparent font-bold text-slate-900 outline-none"
            >
              {INDUSTRY_PRESETS.map((option) => (
                <option key={option.category} value={option.category}>{localized(option.name, language)}</option>
              ))}
            </select>
          </label>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setIsViewingSubmissions((current) => !current)}
            className="h-9 text-xs font-bold"
          >
            <ClipboardCheck className="mr-1.5 h-3.5 w-3.5" />
            {isViewingSubmissions ? t('healthForms.backToEditor') : t('healthForms.customerRecordsCount', { count: submissionsList.length })}
          </Button>
          <Button
            size="sm"
            onClick={() => void openStandaloneForm()}
            disabled={share.isPending}
            variant="outline"
            className="h-9 text-xs font-bold"
          >
            <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
            {t('healthForms.previewCustomerForm')}
          </Button>
          <Button
            size="sm"
            onClick={handlePublishTemplate}
            disabled={save.isPending}
            className="h-9 bg-slate-950 text-xs font-bold text-white hover:bg-slate-800"
          >
            <Save className="mr-1.5 h-3.5 w-3.5" />
            {save.isPending ? t('healthForms.savingPublish') : t('healthForms.savePublish')}
          </Button>
        </div>
      </div>

      {/* 视图分流：已归档记录 vs 模板配置与题目列表 */}
      {isViewingSubmissions ? (
        <div className="space-y-4">
          <Card className="border-slate-200">
            <CardHeader className="pb-3 border-b border-slate-100">
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-sm font-bold text-slate-900">
                    {t('healthForms.archivedRecords', { count: submissionsList.length })}
                  </CardTitle>
                  <CardDescription className="text-xs text-slate-500">
                    {t('healthForms.archivedRecordsDesc')}
                  </CardDescription>
                </div>
                <Button size="sm" variant="outline" onClick={() => setIsViewingSubmissions(false)}>
                  {t('healthForms.backToEditor')}
                </Button>
              </div>
            </CardHeader>
            <CardContent className="pt-4 space-y-3">
              {submissionsList.length === 0 && (
                <div className="rounded-2xl border border-dashed border-slate-200 p-8 text-center text-xs text-slate-500">
                  {t('healthForms.noArchivedRecords')}
                </div>
              )}
              {submissionsList.map((rec) => (
                <div
                  key={rec.submissionId}
                  className="flex items-center justify-between gap-4 p-4 rounded-2xl border border-slate-200 bg-white"
                >
                  <div className="flex items-center gap-3">
                    <div className="grid h-10 w-10 place-items-center rounded-xl bg-teal-50 font-bold text-teal-700 text-xs">
                      {(rec.customerName ?? rec.signerName ?? 'G').slice(0, 2).toUpperCase()}
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-xs text-slate-900">{rec.customerName ?? rec.signerName ?? 'Guest'}</span>
                        {rec.expired ? (
                          <Badge variant="destructive" className="text-[9px]">{t('healthForms.statusExpired')}</Badge>
                        ) : rec.anonymized ? (
                          <Badge variant="outline" className="text-[9px]">{t('healthForms.statusAnonymized')}</Badge>
                        ) : (
                          <Badge variant="default" className="text-[9px] bg-emerald-500">{t('healthForms.statusArchived')}</Badge>
                        )}
                      </div>
                      <p className="text-[11px] text-slate-500 mt-0.5">
                        {localized(rec.templateTitle, language)} · {new Date(rec.signedAt ?? rec.createdAt).toLocaleDateString()}
                      </p>
                    </div>
                  </div>
                  <Button
                    size="sm"
                    onClick={() => void openSubmission(rec)}
                    disabled={accessSubmission.isPending}
                    className="shrink-0 bg-teal-600 text-xs font-bold text-white hover:bg-teal-700"
                  >
                    <Sparkles className="mr-1.5 h-3.5 w-3.5" />
                    {accessSubmission.isPending ? t('healthForms.generatingSummary') : t('healthForms.generateSummary')}
                  </Button>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      ) : (
        <div className="space-y-6">
          <div>
            <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-lg font-black text-slate-950">{localized(currentPreset.name, language)}</h2>
                    <Badge className="bg-teal-600 text-[10px] text-white">{t('healthForms.enabledQuestions', { count: visibleCount })}</Badge>
                    {hiddenCount > 0 && <Badge variant="outline" className="text-[10px] text-amber-700">{t('healthForms.hiddenQuestions', { count: hiddenCount })}</Badge>}
                  </div>
                  <p className="max-w-xl text-xs leading-5 text-slate-500">{localized(currentPreset.description, language)}</p>
                </div>
                <Badge variant="outline" className="shrink-0 text-[10px] text-slate-600">Customer language: English</Badge>
              </div>

              <div className="mt-5 grid gap-4 border-t border-slate-100 pt-4 sm:grid-cols-[minmax(0,1fr)_170px]">
                <div>
                  <label className="mb-1.5 block text-[11px] font-bold text-slate-600">{t('healthForms.customerEnglishTitle')}</label>
                  <Input
                    value={draft.title.en ?? ''}
                    onChange={(e) => setDraft({ ...draft, title: { ...draft.title, en: e.target.value } })}
                    className="text-xs"
                  />
                </div>
                <div>
                  <label className="mb-1.5 block text-[11px] font-bold text-slate-600">{t('healthForms.validDays')}</label>
                  <div className="flex items-center gap-2">
                    <Input
                      type="number"
                      value={draft.validDays ?? ''}
                      placeholder={t('healthForms.validDaysUnlimited')}
                      onChange={(e) => setDraft({ ...draft, validDays: e.target.value ? Number(e.target.value) : null })}
                      className="text-xs"
                    />
                    <span className="text-xs text-slate-500">{t('healthForms.daysUnit')}</span>
                  </div>
                </div>
              </div>

              <div className="mt-4 flex flex-wrap gap-2 border-t border-slate-100 pt-4">
                <Button size="sm" variant="outline" onClick={() => void copyShareLink()} disabled={share.isPending} className="h-8 text-xs">
                  <Copy className="mr-1.5 h-3.5 w-3.5" />{t('healthForms.copyLink')}
                </Button>
                <Button size="sm" variant="outline" onClick={() => void (async () => {
                  const created = shareResult ?? await createShareLink();
                  if (created) setQrModalOpen(true);
                })()} disabled={share.isPending} className="h-8 text-xs">
                  <QrCode className="mr-1.5 h-3.5 w-3.5" />{t('healthForms.qrCode')}
                </Button>
                <Button size="sm" variant="outline" onClick={() => setDispatchModalOpen(true)} className="h-8 text-xs">
                  <Send className="mr-1.5 h-3.5 w-3.5" />{t('healthForms.inviteCustomer')}
                </Button>
                <Button size="sm" variant="outline" onClick={() => setAiModalOpen(true)} className="h-8 border-teal-200 bg-teal-50 text-xs text-teal-800">
                  <Sparkles className="mr-1.5 h-3.5 w-3.5" />{t('healthForms.aiAddQuestions')}
                </Button>
              </div>
            </section>

          </div>

          {/* 核心问题列表管理（店主自由切换显示/隐藏、添加、删除、编辑） */}
          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm space-y-4">
            <div className="flex flex-col gap-3 border-b border-slate-100 pb-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h3 className="text-sm font-black text-slate-900">{t('healthForms.customerQuestions', { count: draft.questions.length })}</h3>
                <p className="mt-1 text-[11px] text-slate-500">{t('healthForms.customerQuestionsDesc')}</p>
              </div>

              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  onClick={() => setAddQuestionModalOpen(true)}
                  className="h-8 text-xs bg-teal-600 text-white font-bold hover:bg-teal-700"
                >
                  <Plus className="mr-1 h-3 w-3" />
                  {t('healthForms.addQuestion')}
                </Button>
              </div>
            </div>

            {/* 题目卡片列表 */}
            <div className="space-y-3">
              {draft.questions.map((q, idx) => {
                const isHidden = Boolean(q.hidden);

                return (
                  <div
                    key={q.id}
                    className={`rounded-xl border p-4 transition-all space-y-3 ${
                      isHidden
                        ? 'border-amber-200 bg-amber-50/30 opacity-75'
                        : 'border-slate-200 bg-white shadow-xs hover:border-teal-300'
                    }`}
                  >
                    {/* 头部控制栏：序号、题型、显示/隐藏开关、排序与删除 */}
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-2.5">
                      <div className="flex items-center gap-2">
                        <span className="grid h-6 w-6 place-items-center rounded-lg bg-teal-50 text-xs font-bold text-teal-700">
                          {idx + 1}
                        </span>
                        <Badge variant="outline" className="text-[10px] text-slate-600 border-slate-200">
                          {q.type === 'bool'
                            ? t('healthForms.typeBool')
                            : q.type === 'text'
                            ? t('healthForms.typeText')
                            : q.type === 'choice'
                            ? t('healthForms.typeChoice')
                            : t('healthForms.typeMulti')}
                        </Badge>

                        {/* 显示 / 隐藏 状态徽章 */}
                        {isHidden ? (
                          <Badge variant="destructive" className="text-[9px] bg-amber-500">
                            {t('healthForms.hidden')}
                          </Badge>
                        ) : (
                          <Badge variant="default" className="text-[9px] bg-emerald-500">
                            {t('healthForms.customerVisible')}
                          </Badge>
                        )}

                        {q.required && <span className="text-red-500 text-xs font-bold">{t('healthForms.required')}</span>}
                      </div>

                      {/* 题目操作按钮组 */}
                      <div className="flex items-center gap-1.5">
                        {/* 🌟 核心功能：店主一键切换显示 / 隐藏 */}
                        <button
                          type="button"
                          onClick={() => handleToggleQuestionVisibility(idx)}
                          className={`flex items-center gap-1 px-2.5 py-1 rounded-xl text-xs font-bold border transition-all ${
                            isHidden
                              ? 'bg-amber-100 border-amber-300 text-amber-900 hover:bg-amber-200'
                              : 'bg-emerald-50 border-emerald-300 text-emerald-800 hover:bg-emerald-100'
                          }`}
                          title={isHidden ? t('healthForms.restoreVisibility') : t('healthForms.hideQuestion')}
                        >
                          {isHidden ? (
                            <>
                              <EyeOff className="h-3.5 w-3.5 text-amber-700" />
                              <span>{t('healthForms.restoreVisibility')}</span>
                            </>
                          ) : (
                            <>
                              <Eye className="h-3.5 w-3.5 text-emerald-600" />
                              <span>{t('healthForms.hideQuestion')}</span>
                            </>
                          )}
                        </button>

                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7 text-slate-400 hover:text-slate-700"
                          disabled={idx === 0}
                          onClick={() => handleMoveQuestion(idx, 'up')}
                        >
                          <ChevronUp className="h-4 w-4" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7 text-slate-400 hover:text-slate-700"
                          disabled={idx === draft.questions.length - 1}
                          onClick={() => handleMoveQuestion(idx, 'down')}
                        >
                          <ChevronDown className="h-4 w-4" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7 text-slate-400 hover:text-red-600"
                          onClick={() => handleDeleteQuestion(idx)}
                        >
                          <Trash2 className="h-3.5 w-3.5 text-red-500" />
                        </Button>
                      </div>
                    </div>

                    {/* 题干内容编辑 */}
                    <div className="space-y-1.5 text-xs">
                      <label className="font-bold text-slate-700 block">{t('healthForms.englishQuestion')}</label>
                      <Input
                        value={q.label.en ?? ''}
                        onChange={(e) => {
                          const questions = clone(draft.questions);
                          questions[idx]!.label.en = e.target.value;
                          setDraft({ ...draft, questions });
                        }}
                        className="text-xs"
                      />
                    </div>

                    {/* 选项预览 */}
                    {(q.type === 'choice' || q.type === 'multi') && (
                      <div className="space-y-1 text-xs pt-1">
                        <span className="text-[11px] font-bold text-slate-500 block">{t('healthForms.englishOptions')}</span>
                        <div className="flex flex-wrap gap-1.5">
                          {(q.options ?? []).map((opt, optIdx) => (
                            <span
                              key={optIdx}
                              className="rounded-lg bg-slate-100 px-2.5 py-1 text-slate-700 text-[11px] border border-slate-200"
                            >
                              {opt.label.en || 'Missing English option'}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* 弹窗 1: 店主添加新问题 Modal */}
      {/* ========================================================================= */}
      <Modal isOpen={addQuestionModalOpen} onOpenChange={setAddQuestionModalOpen} title={t('healthForms.addQuestion')} size="md">
        <div className="p-4 space-y-4 text-xs">
          <p className="text-slate-500">{t('healthForms.addQuestionDesc')}</p>

          <div>
            <label className="font-bold text-slate-700 block mb-1">{t('healthForms.questionType')}:</label>
            <div className="grid grid-cols-2 gap-2">
              {[
                { type: 'choice' as FormQuestionType, label: t('healthForms.typeChoice') },
                { type: 'multi' as FormQuestionType, label: t('healthForms.typeMulti') },
                { type: 'bool' as FormQuestionType, label: t('healthForms.typeBool') },
                { type: 'text' as FormQuestionType, label: t('healthForms.typeText') },
              ].map((item) => (
                <button
                  key={item.type}
                  type="button"
                  onClick={() => setNewQuestionType(item.type)}
                  className={`p-2 rounded-xl border text-xs font-bold transition-all ${
                    newQuestionType === item.type
                      ? 'border-teal-500 bg-teal-50 text-teal-900'
                      : 'border-slate-200 bg-white text-slate-700'
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="font-bold text-slate-700 block mb-1">{t('healthForms.englishQuestion')}</label>
            <Input
              value={newQuestionLabel}
              onChange={(e) => setNewQuestionLabel(e.target.value)}
              placeholder="For example: Have you had a recent allergic reaction?"
              className="text-xs"
            />
          </div>

          {/* 若为单选或多选，配置选项 */}
          {(newQuestionType === 'choice' || newQuestionType === 'multi') && (
            <div className="space-y-2">
              <label className="font-bold text-slate-700 block">{t('healthForms.optionSettings')}:</label>
              {newQuestionOptions.map((opt, oIdx) => (
                <div key={oIdx} className="flex items-center gap-2">
                  <Input
                    value={opt}
                    onChange={(e) => {
                      const arr = [...newQuestionOptions];
                      arr[oIdx] = e.target.value;
                      setNewQuestionOptions(arr);
                    }}
                    placeholder={`Option ${oIdx + 1}`}
                    className="text-xs h-8"
                  />
                  <Button
                    size="icon"
                    variant="ghost"
                    disabled={newQuestionOptions.length <= 1}
                    onClick={() => setNewQuestionOptions(newQuestionOptions.filter((_, i) => i !== oIdx))}
                    className="h-8 w-8 text-slate-400 hover:text-red-500"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setNewQuestionOptions([...newQuestionOptions, `Option ${newQuestionOptions.length + 1}`])}
                className="text-xs text-teal-700"
              >
                <Plus className="mr-1 h-3 w-3" />
                {t('healthForms.addOption')}
              </Button>
            </div>
          )}

          <div className="flex items-center gap-2 pt-1">
            <label className="flex items-center gap-2 font-bold text-slate-700 cursor-pointer">
              <input
                type="checkbox"
                checked={newQuestionRequired}
                onChange={(e) => setNewQuestionRequired(e.target.checked)}
                className="h-4 w-4 rounded accent-teal-600"
              />
              {t('healthForms.markRequired')}
            </label>
          </div>

          <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
            <Button variant="ghost" size="sm" onClick={() => setAddQuestionModalOpen(false)}>
              {t('cancel')}
            </Button>
            <Button size="sm" onClick={handleConfirmAddQuestion} className="bg-teal-600 text-white font-bold">
              {t('healthForms.confirmAdd')}
            </Button>
          </div>
        </div>
      </Modal>

      {/* 弹窗 2: AI 智能出题 Modal */}
      <Modal isOpen={aiModalOpen} onOpenChange={setAiModalOpen} title={`✨ ${t('healthForms.aiCopilotTitle')}`} size="md">
        <div className="p-4 space-y-4 text-xs">
          <p className="text-slate-500">
            {t('healthForms.aiCopilotSubtitle')}
          </p>

          <div className="space-y-1.5">
            <label className="font-bold text-slate-700 block">{t('healthForms.aiInputPlaceholder')}:</label>
            <textarea
              rows={3}
              value={aiPrompt}
              onChange={(e) => setAiPrompt(e.target.value)}
              placeholder={t('healthForms.aiInputPlaceholder')}
              className="w-full rounded-xl border border-slate-200 p-2.5 text-xs focus:border-teal-500 focus:outline-none"
            />
          </div>

          <div className="space-y-1.5">
            <span className="font-bold text-slate-600 block text-[11px]">{t('healthForms.aiQuickPresets')}:</span>
            <div className="flex flex-wrap gap-1.5">
              {AI_QUICK_PROMPTS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => void handleRunAi(item.prompt, item.actionType)}
                  className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] font-medium text-slate-700 hover:bg-teal-50 hover:border-teal-300 transition-colors"
                >
                  {localized(item.label, language)}
                </button>
              ))}
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
            <Button variant="ghost" size="sm" onClick={() => setAiModalOpen(false)}>
              {t('cancel')}
            </Button>
            <Button
              size="sm"
              disabled={isAiGenerating}
              onClick={() => void handleRunAi()}
              className="bg-teal-600 text-white font-bold"
            >
              {isAiGenerating ? t('healthForms.aiGenerating') : t('healthForms.aiSendPrompt')}
            </Button>
          </div>
        </div>
      </Modal>

      {/* 弹窗 3: 顾客直发邀请 Modal (免短信，走 WhatsApp / Email) */}
      <Modal isOpen={dispatchModalOpen} onOpenChange={setDispatchModalOpen} title={t('healthForms.dispatchTitle')} size="md">
        <div className="p-4 space-y-4 text-xs">
          <p className="text-slate-500">{t('healthForms.dispatchSubtitle')}</p>

          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setDispatchChannel('whatsapp')}
              className={`p-2.5 rounded-xl border font-bold text-center transition-all ${
                dispatchChannel === 'whatsapp' ? 'border-teal-500 bg-teal-50 text-teal-900 shadow-xs' : 'border-slate-200 bg-white text-slate-700'
              }`}
            >
              <MessageCircle className="inline mr-1.5 h-4 w-4 text-emerald-600" />
              WhatsApp
            </button>
            <button
              type="button"
              onClick={() => setDispatchChannel('email')}
              className={`p-2.5 rounded-xl border font-bold text-center transition-all ${
                dispatchChannel === 'email' ? 'border-teal-500 bg-teal-50 text-teal-900 shadow-xs' : 'border-slate-200 bg-white text-slate-700'
              }`}
            >
              <Mail className="inline mr-1.5 h-4 w-4 text-blue-600" />
              
              {t('healthForms.healthForms18')}
            </button>
          </div>

          <div className="space-y-1">
            {dispatchChannel === 'email' && (
              <div className="mb-3">
                <label className="font-bold text-slate-700 block mb-1">{t('healthForms.dispatchCustomer')}:</label>
                <Input
                  type="email"
                  value={dispatchEmail}
                  onChange={(event) => setDispatchEmail(event.target.value)}
                  placeholder="guest@example.com"
                  className="text-xs"
                />
              </div>
            )}
            <label className="font-bold text-slate-700 block">{t('healthForms.dispatchMessagePreview')}:</label>
            <div className="p-3 bg-slate-50 border rounded-xl text-slate-700 leading-relaxed font-sans">
              
              {t('healthForms.healthForms19')}
              <span className="text-teal-700 underline block font-mono mt-1">{intakeShareUrl}</span>
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
            <Button variant="ghost" size="sm" onClick={() => setDispatchModalOpen(false)}>
              {t('cancel')}
            </Button>
            <Button
              size="sm"
              disabled={share.isPending}
              onClick={() => void (async () => {
                if (dispatchChannel === 'email') {
                  if (!dispatchEmail.trim()) {
                    toast.danger(t('healthForms.danger20'));
                    return;
                  }
                  const created = await createShareLink('email', dispatchEmail.trim());
                  if (created) {
                    toast.success(t('healthForms.success21'));
                    setDispatchModalOpen(false);
                  }
                  return;
                }
                const created = shareResult ?? await createShareLink();
                if (!created) return;
                window.open(
                  `https://wa.me/?text=${encodeURIComponent(`Please complete your health form before arrival: ${created.url}`)}`,
                  '_blank',
                  'noopener,noreferrer',
                );
                setDispatchModalOpen(false);
              })()}
              className="bg-teal-600 text-white font-bold"
            >
              {t('healthForms.dispatchSend')}
            </Button>
          </div>
        </div>
      </Modal>

      {/* 弹窗 4: 二维码放大弹窗 */}
      <Modal isOpen={qrModalOpen} onOpenChange={setQrModalOpen} title={t('healthForms.qrCode')} size="sm">
        <div className="p-4 text-center space-y-4">
          <div className="mx-auto grid h-48 w-48 place-items-center rounded-2xl bg-white p-3 shadow-inner border border-slate-200">
            {shareResult?.qrSvg ? (
              <div className="h-full w-full [&>svg]:h-full [&>svg]:w-full" dangerouslySetInnerHTML={{ __html: shareResult.qrSvg }} />
            ) : (
              <QrCode className="h-28 w-28 text-teal-600" />
            )}
          </div>
          <div>
            <h4 className="font-bold text-xs text-slate-900">{localized(draft.title, language)}</h4>
            <p className="text-[11px] text-slate-400 mt-0.5">{t('healthForms.healthForms22')}</p>
          </div>
          <Button
            size="sm"
            disabled={!shareResult?.qrSvg}
            onClick={() => {
              if (!shareResult?.qrSvg) return;
              const url = URL.createObjectURL(new Blob([shareResult.qrSvg], { type: 'image/svg+xml' }));
              const anchor = document.createElement('a');
              anchor.href = url;
              anchor.download = `${draft.key}-qr.svg`;
              anchor.click();
              URL.revokeObjectURL(url);
              toast.success(t('healthForms.success23'));
              setQrModalOpen(false);
            }}
            className="w-full bg-teal-600 text-white font-bold"
          >
            
            {t('healthForms.healthForms24')}
          </Button>
        </div>
      </Modal>

      {/* 弹窗 5: 档案详情抽屉 (包含 ✨ AI 临床与施术简报及多语言适配) */}
      <Modal
        isOpen={Boolean(selectedRecord)}
        onOpenChange={(open) => {
          if (!open) setSelectedRecord(null);
        }}
        title={t('healthForms.summaryModalTitle')}
        size="lg"
      >
        {selectedRecord && (
          <div className="p-3 space-y-4 text-xs">
            {/* 顾客头部 */}
            <div className="flex items-center justify-between bg-slate-50 p-3.5 rounded-2xl border border-slate-200">
              <div className="flex items-center gap-3">
                <div className="grid h-10 w-10 place-items-center rounded-xl bg-teal-600 font-bold text-white text-xs shadow-xs">
                  {selectedRecord.customerAvatar || selectedRecord.customerName.slice(0, 2).toUpperCase()}
                </div>
                <div>
                  <h4 className="font-bold text-sm text-slate-900 flex items-center gap-2">
                    {selectedRecord.customerName}
                    <Badge variant="outline" className="text-[9px] text-teal-700 border-teal-300">
                      
                      {t('healthForms.healthForms25')}
                    </Badge>
                  </h4>
                  <p className="text-[11px] text-slate-500 font-mono">{selectedRecord.customerPhone}</p>
                </div>
              </div>
              <div className="text-right text-[11px] text-slate-500">
                <span className="block font-medium">{t('healthForms.healthForms26')}{new Date(selectedRecord.submittedAt).toLocaleString()}</span>
                <span className="block text-slate-400 font-mono">
                  
                  {t('healthForms.healthForms27')}{selectedRecord.templateVersion}
                </span>
              </div>
            </div>

            {/* ✨ 核心亮点：AI 临床与施术简报 (支持 5 语系即时切换与重新分析) */}
            {selectedRecord.aiSummary && (
              <div className="rounded-2xl border border-teal-200 bg-gradient-to-br from-teal-900 via-teal-800 to-slate-900 text-white p-4 shadow-md space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-teal-700/60 pb-2.5">
                  <div className="flex items-center gap-2">
                    <Sparkles className="h-4 w-4 text-teal-300 animate-pulse" />
                    <span className="font-bold text-xs text-white">{t('healthForms.aiSafetySummary')}</span>
                    <Badge
                      className={`text-[9px] ${
                        selectedRecord.aiSummary.riskLevel === 'high'
                          ? 'bg-rose-500 text-white'
                          : selectedRecord.aiSummary.riskLevel === 'moderate'
                          ? 'bg-amber-500 text-white'
                          : 'bg-emerald-500 text-white'
                      }`}
                    >
                      {selectedRecord.aiSummary.riskLevel === 'high'
                        ? `⚠️ ${t('healthForms.riskHigh')}`
                        : selectedRecord.aiSummary.riskLevel === 'moderate'
                        ? `⚡ ${t('healthForms.riskModerate')}`
                        : `🟢 ${t('healthForms.riskLow')}`}
                    </Badge>
                  </div>

                  <div className="flex items-center gap-1.5">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={regenerateSelectedSummary}
                      className="h-7 border border-teal-600/40 bg-teal-950/60 px-2 text-[10px] text-teal-100 hover:bg-teal-800 hover:text-white"
                    >
                      <RotateCcw className="mr-1 h-3 w-3" />{t('healthForms.reanalyze')}
                    </Button>
                    <div className="flex items-center gap-1.5 bg-teal-950/60 p-1 rounded-xl border border-teal-600/40">
                      <Languages className="h-3.5 w-3.5 text-teal-300 ml-1" />
                      <select
                        value={language}
                        onChange={(e) => setLanguage(e.target.value as Language)}
                        className="bg-transparent text-[11px] font-bold text-teal-100 focus:outline-none cursor-pointer pr-1"
                      >
                        {UI_LANGUAGES.map((l) => (
                          <option key={l.code} value={l.code} className="bg-slate-900 text-white">
                            {l.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>

                {/* 标语 */}
                <p className="text-xs font-semibold text-teal-100">
                  {selectedRecord.aiSummary.headline[language] || selectedRecord.aiSummary.headline['zh-Hans']}
                </p>

                {/* 核心警报与避开部位 */}
                <div className="grid gap-2 sm:grid-cols-2 text-[11px]">
                  {/* 红线警报 */}
                  <div className="rounded-xl bg-teal-950/50 p-2.5 border border-teal-600/30 space-y-1">
                    <span className="font-bold text-teal-300 block flex items-center gap-1">
                      <ShieldAlert className="h-3 w-3 text-rose-400" />
                      {t('healthForms.alerts')}:
                    </span>
                    <ul className="list-disc list-inside text-teal-100/90 space-y-0.5">
                      {(selectedRecord.aiSummary.keyAlerts[language] || selectedRecord.aiSummary.keyAlerts['zh-Hans'] || []).map((alert, aIdx) => (
                        <li key={aIdx}>{alert}</li>
                      ))}
                    </ul>
                  </div>

                  {/* 避开部位 */}
                  <div className="rounded-xl bg-teal-950/50 p-2.5 border border-teal-600/30 space-y-1">
                    <span className="font-bold text-teal-300 block flex items-center gap-1">
                      <span className="text-rose-400">🚫</span>
                      {t('healthForms.avoidAreas')}:
                    </span>
                    <div className="flex flex-wrap gap-1 pt-0.5">
                      {(selectedRecord.aiSummary.avoidAreasList[language] || selectedRecord.aiSummary.avoidAreasList['zh-Hans'] || []).map((area, aIdx) => (
                        <Badge key={aIdx} variant="destructive" className="text-[9px] bg-rose-600/80">
                          {area}
                        </Badge>
                      ))}
                    </div>
                  </div>
                </div>

                {/* 技师核心施术方案与建议 */}
                <div className="rounded-xl bg-teal-950/70 p-2.5 border border-teal-500/40 text-[11px] space-y-1">
                  <span className="font-bold text-teal-200 block">💡 {t('healthForms.technicianAdvice')}:</span>
                  <p className="text-teal-100 leading-relaxed">
                    {selectedRecord.aiSummary.technicianAdvice[language] || selectedRecord.aiSummary.technicianAdvice['zh-Hans']}
                  </p>
                </div>
              </div>
            )}

            {/* 人体解剖标注图 */}
            <BodyMapSelector
              value={{
                focus: selectedRecord.answers?.bodyMapFocus || [],
                avoid: selectedRecord.avoidAreas || [],
              }}
              readonly
              activeLanguage={language}
            />

            {/* 问答明细 */}
            <div className="p-3 bg-slate-50 rounded-xl border space-y-1">
              <span className="font-bold block text-slate-800">{t('healthForms.healthForms28')}</span>
              {Object.entries(selectedRecord.answers).map(([k, v]) => (
                <div key={k} className="flex justify-between py-0.5 border-b border-slate-100">
                  <span className="text-slate-500">{k}:</span>
                  <span className="font-medium text-slate-900">{Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : String(v)}</span>
                </div>
              ))}
            </div>

            {/* 底部打印与导出 */}
            <div className="flex justify-end gap-2 pt-2 border-t">
              <Button size="sm" variant="outline" onClick={() => { navigate(`/forms/submissions/${selectedRecord.id}`); }}>
                <Printer className="mr-1.5 h-3.5 w-3.5" />
                
                {t('healthForms.healthForms29')}
              </Button>
              <Button size="sm" onClick={() => setSelectedRecord(null)} className="bg-teal-600 text-white font-bold">
                {t('healthForms.completeView')}
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
