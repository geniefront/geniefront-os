import { useRef, useState } from 'react';
import { toast } from '@heroui/react';
import { LifeBuoy } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { PageHeader } from '@/components/ui/PageHeader';
import { useLanguage } from '@/LanguageContext';
import { useErrorMessage } from '@/lib/errorMessage';
import {
  useSubmitSupportRequest,
  type SupportCategory,
} from '@/features/support/api';
import type { TranslationKey } from '@/i18n';

const CATEGORIES: Array<{ value: SupportCategory; labelKey: TranslationKey }> = [
  { value: 'general', labelKey: 'support.category.general' },
  { value: 'onboarding', labelKey: 'support.category.onboarding' },
  { value: 'billing', labelKey: 'support.category.billing' },
  { value: 'sms_10dlc', labelKey: 'support.category.sms_10dlc' },
  { value: 'storefront', labelKey: 'support.category.storefront' },
  { value: 'technical', labelKey: 'support.category.technical' },
  { value: 'other', labelKey: 'support.category.other' },
];

export function Support() {
  const { t } = useLanguage();
  const errorMessage = useErrorMessage();
  const submit = useSubmitSupportRequest();
  const [category, setCategory] = useState<SupportCategory>('general');
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [submittedId, setSubmittedId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inFlightRef = useRef(false);

  const handleSubmit = async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setSubmitting(true);
    const idempotencyKey = crypto.randomUUID();
    try {
      const result = await submit.mutateAsync({
        category,
        subject: subject.trim(),
        description: description.trim(),
        idempotencyKey,
      });
      setSubmittedId(result.requestId);
      setSubject('');
      setDescription('');
      toast.success(t('support.success'));
    } catch (err: unknown) {
      setSubmittedId(null);
      toast.danger(errorMessage(err));
    } finally {
      inFlightRef.current = false;
      setSubmitting(false);
    }
  };

  return (
    <div className="max-w-2xl space-y-6">
      <PageHeader
        title={t('support.title')}
        description={t('support.description')}
      />
      <Card className="border-slate-200 p-6 space-y-4">
        <div className="flex items-center gap-2 text-sm font-bold text-slate-800">
          <LifeBuoy className="size-4 text-teal-600" />
          {t('support.title')}
        </div>
        <label className="block space-y-1.5">
          <span className="text-xs font-bold text-slate-700">{t('support.category')}</span>
          <select
            className="h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm outline-none focus:border-teal-500"
            value={category}
            onChange={(event) => setCategory(event.target.value as SupportCategory)}
          >
            {CATEGORIES.map((item) => (
              <option key={item.value} value={item.value}>{t(item.labelKey)}</option>
            ))}
          </select>
        </label>
        <label className="block space-y-1.5">
          <span className="text-xs font-bold text-slate-700">{t('support.subject')}</span>
          <Input
            aria-label={t('support.subject')}
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
            maxLength={200}
          />
        </label>
        <label className="block space-y-1.5">
          <span className="text-xs font-bold text-slate-700">{t('support.message')}</span>
          <textarea
            aria-label={t('support.message')}
            className="min-h-32 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-teal-500"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            maxLength={8000}
          />
        </label>
        <div className="flex items-center justify-between gap-3">
          {submittedId ? (
            <p className="text-xs font-medium text-emerald-700">{t('support.success')}</p>
          ) : <span />}
          <Button
            className="bg-teal-600 text-white font-bold"
            disabled={submitting || submit.isPending || !subject.trim() || !description.trim()}
            onClick={() => void handleSubmit()}
          >
            {submitting || submit.isPending ? t('support.submitting') : t('support.submit')}
          </Button>
        </div>
      </Card>
    </div>
  );
}
