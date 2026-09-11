import { useSession } from '@/lib/session';
import { openPrintPreview } from '@/features/printing/preview';
import { Spinner } from '@heroui/react';
import { ArrowLeft, FileCheck2, Printer } from 'lucide-react';
import { useParams } from 'react-router-dom';
import { useGoBack } from '@/lib/navigation';
import { Button } from '@/components/ui/Button';
import { inferHealthFormCategory } from '@/features/forms/formExperience';
import { publicText } from '@/features/forms/publicCopy';
import { useHealthFormSubmissionQuery } from '@/features/schedule/appointmentDetail';
import { useErrorMessage } from '@/lib/errorMessage';
import { formatPhoneDisplay } from '@/lib/utils';

const CLIENT_FIELDS = ['fullName', 'dob', 'phone', 'occupation', 'emergencyName', 'emergencyPhone'] as const;
const CLIENT_LABELS: Record<(typeof CLIENT_FIELDS)[number], Record<string, string>> = {
  fullName: { 'zh-Hans': '姓名', en: 'Full name', ko: '성명', es: 'Nombre completo', vi: 'Họ và tên' },
  dob: { 'zh-Hans': '出生日期', en: 'Date of birth', ko: '생년월일', es: 'Fecha de nacimiento', vi: 'Ngày sinh' },
  phone: { 'zh-Hans': '电话号码', en: 'Phone number', ko: '전화번호', es: 'Teléfono', vi: 'Số điện thoại' },
  occupation: { 'zh-Hans': '职业', en: 'Occupation', ko: '직업', es: 'Ocupación', vi: 'Nghề nghiệp' },
  emergencyName: { 'zh-Hans': '紧急联系人', en: 'Emergency contact', ko: '비상 연락처', es: 'Contacto de emergencia', vi: 'Người liên hệ khẩn cấp' },
  emergencyPhone: { 'zh-Hans': '紧急联系人电话', en: 'Emergency contact phone', ko: '비상 연락처 전화번호', es: 'Teléfono de emergencia', vi: 'Số điện thoại khẩn cấp' },
};

function displayValue(value: unknown, language: string): string {
  if (value === true) return language === 'zh-Hans' ? '是' : language === 'ko' ? '예' : language === 'es' ? 'Sí' : language === 'vi' ? 'Có' : 'Yes';
  if (value === false) return language === 'zh-Hans' ? '否' : language === 'ko' ? '아니요' : language === 'es' ? 'No' : language === 'vi' ? 'Không' : 'No';
  if (value == null || value === '') return '—';
  if (Array.isArray(value)) return value.length ? value.map((item) => displayValue(item, language)).join(', ') : '—';
  if (typeof value === 'object') return Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== false && item != null && item !== '')
    .map(([key, item]) => `${key}: ${displayValue(item, language)}`)
    .join(' · ') || '—';
  return String(value);
}

export function CompletedHealthForm() {
  const { submissionId = '' } = useParams();
  const errorMessage = useErrorMessage();
  const submissionQ = useHealthFormSubmissionQuery(submissionId || null, Boolean(submissionId), 'export');
  const submission = submissionQ.data;
  const answers = submission?.answers ?? null;
  const clientInfo = answers && typeof answers.clientInfo === 'object' && answers.clientInfo
    ? answers.clientInfo as Record<string, unknown>
    : {};
  // The evidence page mirrors the English customer form regardless of staff UI language.
  const language = 'en';
  const locale = 'en-US';
  const { context } = useSession();
  const goBack = useGoBack('/queue');
  const timezone = context?.timezone || 'UTC';
  const isMassage = submission ? inferHealthFormCategory(submission.templateKey) === 'massage' : false;
  const signedLanguage = 'en';

  return (
    <main className="min-h-screen bg-slate-50 px-4 py-8 text-slate-950 print:bg-white print:p-0">
      <div className="mx-auto max-w-4xl">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3 print:hidden">
          {/*
            不能用 window.close()：非脚本打开的窗口关不掉，独立窗口（iPad
            添加到主屏幕）下这个按钮等于没有，前台只能强退应用。
          */}
          <Button variant="outline" onPress={goBack}>
            <ArrowLeft className="h-4 w-4" />
            Back
          </Button>
          <Button isDisabled={!submission || submissionQ.isFetching} onPress={async () => { const result = await submissionQ.refetch(); await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); if (result.data && !result.error) openPrintPreview(document.querySelector('[data-print-health-record]'), 'Completed health form record'); }}>
            <Printer className="h-4 w-4" />
            Print record
          </Button>
        </div>

        {submissionQ.isLoading && <div className="grid min-h-[60vh] place-items-center"><Spinner /></div>}
        {submissionQ.isError && (
          <section className="rounded-2xl border border-rose-200 bg-white p-8 text-center shadow-sm">
            <h1 className="text-xl font-bold">This health form cannot be viewed</h1>
            <p className="mt-2 text-sm text-rose-600">{errorMessage(submissionQ.error)}</p>
          </section>
        )}

        {submission && (
          <article data-print-health-record className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm print:rounded-none print:border-0 print:shadow-none">
            <header className="border-b border-slate-200 bg-slate-950 px-6 py-7 text-white sm:px-9">
              <div className="flex items-center gap-2 text-sm font-semibold text-teal-300"><FileCheck2 className="h-5 w-5" />Completed health form record</div>
              <h1 className="mt-3 text-2xl font-black sm:text-3xl">{submission.templateTitle.en ?? 'Health form'}</h1>
              <p className="mt-2 text-sm text-slate-300">Read-only record signed by the customer</p>
            </header>

            <div className="space-y-7 p-6 sm:p-9">
              <dl className="grid gap-4 rounded-2xl bg-slate-50 p-5 text-sm sm:grid-cols-2 lg:grid-cols-4">
                <div><dt className="text-xs font-semibold text-slate-500">Customer</dt><dd className="mt-1 font-semibold">{submission.customerName ?? submission.signerName ?? '—'}</dd></div>
                <div><dt className="text-xs font-semibold text-slate-500">Signed by</dt><dd className="mt-1 font-semibold">{submission.signerName ?? '—'}</dd></div>
                <div><dt className="text-xs font-semibold text-slate-500">Submitted at</dt><dd className="mt-1 font-semibold">{submission.signedAt ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: timezone }).format(new Date(submission.signedAt)) : '—'} ({timezone})</dd></div>
                <div><dt className="text-xs font-semibold text-slate-500">Form version / language</dt><dd className="mt-1 font-semibold">v{submission.templateVersion} · {submission.locale}</dd></div>
              </dl>

              {Object.keys(clientInfo).length > 0 && (
                <section>
                  <h2 className="mb-3 text-base font-bold">Client information</h2>
                  <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {CLIENT_FIELDS.filter((field) => clientInfo[field] != null && clientInfo[field] !== '').map((field) => (
                      <div key={field} className="rounded-xl border border-slate-200 p-3">
                        <dt className="text-xs font-semibold text-slate-500">{CLIENT_LABELS[field].en}</dt>
                        <dd className="mt-1 break-words text-sm font-medium">
                          {field === 'phone' || field === 'emergencyPhone'
                            ? formatPhoneDisplay(String(clientInfo[field]))
                            : displayValue(clientInfo[field], language)}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </section>
              )}

              <section>
                <h2 className="mb-3 text-base font-bold">Customer responses</h2>
                {submission.anonymized || !answers ? (
                  <p className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">This record has been anonymized and its original responses are no longer available.</p>
                ) : (
                  <div className="divide-y divide-slate-200 rounded-2xl border border-slate-200">
                    {submission.questions.map((question, index) => (
                      <div key={question.id} className="p-4 sm:p-5">
                        <p className="text-xs font-bold uppercase tracking-wide text-slate-400">{index + 1}</p>
                        <p className="mt-1 text-sm font-semibold">{question.label.en ?? question.id}</p>
                        <p className="mt-2 break-words text-sm text-slate-700">{displayValue(answers[question.id], language)}</p>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              {isMassage && answers && (
                <section>
                  <h2 className="mb-3 text-base font-bold">{publicText('painTitle', signedLanguage)}</h2>
                  <dl className="grid gap-3 sm:grid-cols-2">
                    <div className="rounded-xl border border-slate-200 p-3"><dt className="text-xs font-semibold text-slate-500">{publicText('painLevel', signedLanguage)}</dt><dd className="mt-1 text-sm font-medium">{displayValue(answers.painLevel, language)} / 10</dd></div>
                    <div className="rounded-xl border border-slate-200 p-3"><dt className="text-xs font-semibold text-slate-500">{publicText('painFrequency', signedLanguage)}</dt><dd className="mt-1 text-sm font-medium">{displayValue(answers.painFrequency, language)}</dd></div>
                    <div className="rounded-xl border border-slate-200 p-3 sm:col-span-2"><dt className="text-xs font-semibold text-slate-500">{publicText('painDescription', signedLanguage)}</dt><dd className="mt-1 text-sm font-medium">{displayValue(answers.painDescription, language)}</dd></div>
                    <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3"><dt className="text-xs font-semibold text-emerald-700">{publicText('focusAreas', signedLanguage)}</dt><dd className="mt-1 text-sm font-medium text-emerald-950">{displayValue(answers.bodyMapFocus, language)}</dd></div>
                    <div className="rounded-xl border border-rose-200 bg-rose-50 p-3"><dt className="text-xs font-semibold text-rose-700">{publicText('avoidAreas', signedLanguage)}</dt><dd className="mt-1 text-sm font-medium text-rose-950">{displayValue(answers.bodyMapAvoid, language)}</dd></div>
                  </dl>
                </section>
              )}

              <section className="rounded-2xl border border-slate-200 bg-slate-50 p-5">
                <h2 className="text-base font-bold">{publicText('waiverTitle', signedLanguage)}</h2>
                <p className="mt-3 text-sm leading-6 text-slate-700">{publicText('waiverBody', signedLanguage)}</p>
              </section>

              <section className="rounded-2xl border border-slate-200 p-5">
                <h2 className="text-base font-bold">Signature record</h2>
                {submission.signatureUrl ? <img src={submission.signatureUrl} alt="Customer signature" className="mt-4 max-h-44 max-w-full object-contain" /> : <p className="mt-3 text-sm text-slate-500">{submission.signerName ?? '—'}</p>}
                <p className="mt-3 text-xs text-slate-500">Authorized staff only. Every view is recorded in the health-data access audit log.</p>
              </section>
            </div>
          </article>
        )}
      </div>
    </main>
  );
}
