import { useCan } from '@/lib/permissions';
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
  useMySupportRequests,
  useReplySupportRequest,
  useSubmitSupportRequest,
  type SupportCategory,
  type SupportStatus,
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

/** 状态 → 文案 key。显式列出，理由同 `errorMessage.ts`：拼接出来的 key 会被字典瘦身脚本删掉。 */
const STATUS_KEYS: Record<SupportStatus, TranslationKey> = {
  open: 'support.status.open',
  in_progress: 'support.status.in_progress',
  waiting: 'support.status.waiting',
  resolved: 'support.status.resolved',
  closed: 'support.status.closed',
};

export function Support() {
  const { t } = useLanguage();
  const errorMessage = useErrorMessage();
  const submit = useSubmitSupportRequest();
  const canManage = useCan('settings.manage');
  const [page, setPage] = useState(0);
  const history = useMySupportRequests(page * 50, canManage);
  const reply = useReplySupportRequest();
  const [replyText, setReplyText] = useState<Record<string,string>>({});
  const replyAttempt = useRef<{ payload: string; key: string } | null>(null);
  const replyLock = useRef(false);
  const respond = async (requestId: string, status?: 'open' | 'resolved') => {
    if (replyLock.current) return;
    const body = status ? undefined : replyText[requestId]?.trim();
    const payload = JSON.stringify({ requestId, body, status });
    if (replyAttempt.current?.payload !== payload) replyAttempt.current = { payload, key: crypto.randomUUID() };
    replyLock.current = true;
    try {
      await reply.mutateAsync({ requestId, body, status, idempotencyKey: replyAttempt.current.key });
      replyAttempt.current = null; setReplyText(old => ({ ...old, [requestId]: '' })); await history.refetch();
    } catch (error) { toast.danger(errorMessage(error)); }
    finally { replyLock.current = false; }
  };
  const [category, setCategory] = useState<SupportCategory>('general');
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [submittedId, setSubmittedId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inFlightRef = useRef(false);
  const attempt = useRef<{ payload: string; key: string } | null>(null);

  const handleSubmit = async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setSubmitting(true);
    const payload = JSON.stringify({ category, subject: subject.trim(), description: description.trim() });
    if (attempt.current?.payload !== payload) attempt.current = { payload, key: crypto.randomUUID() };
    const idempotencyKey = attempt.current.key;
    try {
      const result = await submit.mutateAsync({
        category,
        subject: subject.trim(),
        description: description.trim(),
        idempotencyKey,
      });
      attempt.current = null;
      setPage(0);
      setSubmittedId(result.requestId);
      setSubject('');
      setDescription('');
      // 提完立刻把列表拉一遍：客户要当场看到「它进去了、现在是待处理」
      void history.refetch();
      toast.success(t('support.success'));
    } catch (err: unknown) {
      setSubmittedId(null);
      toast.danger(errorMessage(err));
    } finally {
      inFlightRef.current = false;
      setSubmitting(false);
    }
  };

  if (!canManage) return <p role="alert" className="p-6">{t('errorPERMISSION_DENIED')}</p>;
  return (
    <div className="gf-service-page mx-auto max-w-6xl space-y-6">
      <PageHeader
        title={t('support')}
      />
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
      <Card className="border-slate-200 p-6 space-y-4">
        <div className="flex items-center gap-2 text-sm font-medium text-slate-800">
          <LifeBuoy className="size-4 text-teal-600" />
          {t('support.submit')}
        </div>
        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-slate-700">{t('support.category')}</span>
          <select
            className="h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm outline-none focus:border-teal-500"
            disabled={submitting}
            value={category}
            onChange={(event) => setCategory(event.target.value as SupportCategory)}
          >
            {CATEGORIES.map((item) => (
              <option key={item.value} value={item.value}>{t(item.labelKey)}</option>
            ))}
          </select>
        </label>
        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-slate-700">{t('support.subject')}</span>
          <Input
            aria-label={t('support.subject')}
            disabled={submitting}
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
            maxLength={200}
          />
        </label>
        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-slate-700">{t('support.message')}</span>
          <textarea
            aria-label={t('support.message')}
            className="min-h-32 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-teal-500"
            disabled={submitting}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            maxLength={8000}
          />
        </label>
        <div className="flex items-center justify-between gap-3">
          {submittedId ? (
            <p className="text-xs font-medium text-emerald-700">{t('support.success')}</p>
          ) : (!subject.trim() || !description.trim()) ? (
            <p className="text-xs text-slate-500">{t('support.requiredHint')}</p>
          ) : <span />}
          <Button
            isPending={submitting}
            className="bg-teal-600 text-white font-medium"
            disabled={submitting || submit.isPending || !subject.trim() || !description.trim()}
            onClick={() => void handleSubmit()}
          >
            {submitting || submit.isPending ? t('support.submitting') : t('support.submit')}
          </Button>
        </div>
      </Card>

      {/*
        ⭐ 我提交的请求（AUD-08）。
        原来这一页只有提交表单 —— 平台把状态改成「等你回复」之后，
        客户这边什么都看不到，工单成了单向投递口。
        ⛔ 这里只显示状态和「客服已更新」的时刻；运营的内部备注
        既不在接口里，数据库那一侧也已经按「必须是运营」收窄了 RLS。
      */}
      <Card className="border-slate-200 p-6 space-y-3">
        <div className="text-sm font-medium text-slate-800">{t('support.history')}</div>
        {history.isError ? <div role="alert"><p>{errorMessage(history.error)}</p><Button variant="secondary" onClick={() => history.refetch()}>{t('retry')}</Button></div> : history.isLoading ? (
          <p className="text-xs text-slate-500">{t('support.historyLoading')}</p>
        ) : (history.data?.requests.length ?? 0) === 0 ? (
          <p className="text-xs text-slate-500">{t('support.historyEmpty')}</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {history.data!.requests.map((r) => (
              <li key={r.id} className="py-3 space-y-1" data-testid="support-request-row">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-semibold text-slate-800">{r.subject}</span>
                  <span
                    className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700"
                    data-testid="support-request-status"
                  >
                    {t(STATUS_KEYS[r.status])}
                  </span>
                </div>
                <details className="text-sm"><summary className="cursor-pointer text-teal-700">{t('support.viewConversation')}</summary>
                  <p className="whitespace-pre-wrap py-3 text-slate-600">{r.description}</p>
                  {(r.messages ?? []).map(message => <div key={message.id} className="mb-2 rounded border p-3"><p className="text-xs text-slate-500">{t(message.authorKind === 'operator' ? 'support.operator' : 'support.you')} · {new Date(message.createdAt).toLocaleString()}</p><p className="whitespace-pre-wrap">{message.body}</p></div>)}
                  <textarea aria-label={t('support.reply')} maxLength={8000} className="w-full rounded border p-2" value={replyText[r.id] ?? ''} onChange={e => setReplyText(old => ({ ...old, [r.id]: e.target.value }))} />
                  <div className="flex gap-2"><Button disabled={!replyText[r.id]?.trim() || reply.isPending} onClick={() => void respond(r.id)}>{t('support.reply')}</Button>
                  <Button variant="secondary" disabled={reply.isPending} onClick={() => void respond(r.id, r.status === 'resolved' || r.status === 'closed' ? 'open' : 'resolved')}>{t(r.status === 'resolved' || r.status === 'closed' ? 'support.reopen' : 'support.resolve')}</Button></div>
                </details>
                {r.lastOperatorUpdateAt && (
                  <p className="text-xs text-teal-700">
                    {t('support.updatedAt')} · {new Date(r.lastOperatorUpdateAt).toLocaleString()}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-center justify-between gap-2 text-sm"><Button variant="secondary" disabled={!page || history.isFetching} onClick={() => setPage(p => p - 1)}>←</Button><span>{page * 50 + (history.data?.requests.length ? 1 : 0)}–{page * 50 + (history.data?.requests.length ?? 0)} / {history.data?.total ?? '—'}</span><Button variant="secondary" disabled={history.isFetching || (page + 1) * 50 >= (history.data?.total ?? 0)} onClick={() => setPage(p => p + 1)}>→</Button></div>
      </Card>
      </div>
    </div>
  );
}
