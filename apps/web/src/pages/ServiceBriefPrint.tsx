import { openPrintPreview } from '@/features/printing/preview';
/**
 * 入座服务单一页纸（打印页）。
 *
 * 独立路由 `/print/service-brief/:ticketId` + `@media print` 固定版式。
 * ⚠️ **不要退回 `window.print()` 打整个后台界面** —— 侧边栏、看板、弹窗
 * 全都会跟着上纸，技师拿到的是一张找不到重点的截图。
 *
 * ## 打印语言与界面语言是两回事
 *
 * 纸是给技师看的，前台的界面语言不代表技师的语言。因此这一页自带语言
 * 选择，切换后整页（含健康建议）重新生成，默认取当前界面语言。
 *
 * ## 健康信息
 *
 * 店主已明确技师可以看到全部健康信息，因此问卷原文直接印在纸上。
 * 服务端每取一次都会写一条 `form_access_log`（理由 `export`），
 * 没有 `customer.view_health_form` 的账号只拿得到结论层。
 * 纸上固定印一行回收提示：服务结束后交回前台 —— 前台要留存归档，不销毁。
 */
import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useGoBack } from '@/lib/navigation';
import { ArrowLeft, Printer } from 'lucide-react';
import { apiGet } from '@/lib/api';
import { useQuery } from '@tanstack/react-query';
import { useSession } from '@/lib/session';
import { useLanguage } from '@/LanguageContext';
import { translations, UI_LANGUAGES } from '@/i18n';
import type { Language, TranslationKey } from '@/i18n';
import { centsToDollars } from '@/features/checkout/api';
import { formatIsoWallClock } from '@/lib/time';
import { formatI18n } from '@/lib/utils';
import { PageLoading, PageError } from '@/components/ui/QueryState';
import {
  AROMA_OIL_OPTIONS, AVOID_AREA_TAGS, FOCUS_AREA_TAGS, STRENGTH_OPTIONS,
} from './queue/model';
import { bodyPartText, publicText } from '@/features/forms/publicCopy';
import type { PublicFormCopyKey } from '@/features/forms/publicCopy';
import './serviceBriefPrint.css';

interface AdviceItem { code: string; severity: 'avoid' | 'caution' }

interface ServiceBriefDto {
  ticketId: string;
  ticketNumber: number | null;
  businessDate: string;
  openedAt: string;
  locationName: Record<string, string> | string;
  timezone: string;
  customerName: string;
  customerPhone: string | null;
  visitCount: number;
  isFirstVisit: boolean;
  items: Array<{
    ticketItemId: string;
    name: string;
    durationMin: number;
    totalCents: number;
    staffNames: string[];
    roomName: string | null;
    startedAt: string | null;
    finishedAt: string | null;
  }>;
  subtotalCents: number;
  preferences: {
    strength: string | null;
    oil: string | null;
    focusAreas: string[];
    avoidAreas: string[];
    quiet: boolean;
    freeNotes: string | null;
    allergies: string[];
  };
  handoffNote: string | null;
  health: {
    hasFlag: boolean;
    advice: AdviceItem[];
    form: {
      submissionId: string;
      templateTitle: Record<string, string>;
      signedAt: string | null;
      signerName: string | null;
      questions: unknown[];
      answers: Record<string, unknown> | null;
    } | null;
    canViewForm: boolean;
  };
}

/**
 * 偏好在库里存的是 id（`lavender` / `deep` / `right_knee`），不是文案 ——
 * 这样增加界面语言不会影响既有记录。纸上要印人读的词，因此在这里查表；
 * 查不到就原样印：那多半是前台手填的自由文本，原样才是对的。
 */
const PREFERENCE_LABELS: Record<string, TranslationKey> = Object.fromEntries(
  [...STRENGTH_OPTIONS, ...AROMA_OIL_OPTIONS, ...FOCUS_AREA_TAGS, ...AVOID_AREA_TAGS]
    .map((option) => [option.id, option.labelKey]),
);

/**
 * 顾客端健康排查项 → 顾客当时看到的那句话。
 *
 * 复用 `publicFormCopy` 而不是另写一份：纸上印的应当**就是客人勾的那一条**。
 * 两份文案各自演化的话，客人说「我勾的是静脉曲张」而纸上写着别的说法，
 * 这种分歧在纠纷里没法解释。
 */
const CONDITION_COPY: Record<string, PublicFormCopyKey> = {
  high_low_bp: 'highLowBp',
  heart_condition: 'heartCondition',
  diabetes: 'diabetes',
  pacemaker: 'pacemaker',
  blood_clots: 'bloodClots',
  cancer_oncology: 'cancer',
  spine_neck: 'spineNeck',
  arthritis: 'arthritis',
  fibromyalgia: 'fibromyalgia',
  pregnancy: 'pregnancy',
};

interface FormQuestion {
  id: string;
  label?: Record<string, string> | string;
  type?: string;
  hidden?: boolean;
  options?: Array<{ value: string; label?: Record<string, string> | string }>;
}

export function ServiceBriefPrint() {
  const { ticketId } = useParams<{ ticketId: string }>();
  const { language: uiLanguage } = useLanguage();
  const { status, membershipId } = useSession();
  const [printLanguage, setPrintLanguage] = useState<Language>(uiLanguage);
  const [format, setFormat] = useState<'letter' | 'thermal'>('letter');
  /* 这一页不套后台布局，没有侧边栏可点；独立窗口下缺了返回控件就是死路。 */
  const goBack = useGoBack('/queue');

  const query = useQuery({
    queryKey: ['desk', 'service-brief', membershipId, ticketId],
    queryFn: () => apiGet<ServiceBriefDto>(`/v1/desk/tickets/${ticketId}/service-brief`),
    enabled: status === 'ready' && Boolean(ticketId),
    /*
     * 每取一次服务端就写一条访问日志。反复轮询等于把日志刷成噪音，
     * 而这份日志正是纠纷时唯一能回答「谁看过」的东西 —— 所以不轮询。
     */
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });

  /**
   * 按**打印语言**取词，而不是界面语言。
   *
   * 页面内不能用 `useLanguage()` 的 `t` —— 那一份跟着前台界面走，
   * 前台是中文时越南语技师会拿到一张中文的纸。
   */
  const tp = useMemo(() => (key: TranslationKey, params?: Record<string, string | number>) => {
    let text = translations[printLanguage][key] ?? translations['en'][key] ?? String(key);
    if (params) {
      for (const [k, v] of Object.entries(params)) text = text.replaceAll(`{${k}}`, String(v));
    }
    return text;
  }, [printLanguage]);

  useEffect(() => {
    document.documentElement.lang = printLanguage;
  }, [printLanguage]);

  if (query.isLoading) return <PageLoading title={tp('print.briefTitle')} description={tp('print.briefLoading')} />;
  if (query.isError || !query.data) {
    return <PageError title={tp('print.briefFailed')} error={query.error} onRetry={() => void query.refetch()} />;
  }

  const brief = query.data;
  const tz = brief.timezone;
  const clock = (iso: string | null) => (iso ? formatIsoWallClock(iso, tz) : null);
  const itemTime = (item: ServiceBriefDto['items'][number]) => {
    if (!item.startedAt) return tp('print.notStarted');
    const end = item.finishedAt
      ?? new Date(Date.parse(item.startedAt) + item.durationMin * 60_000).toISOString();
    return `${clock(item.startedAt)}–${clock(end)}`;
  };

  /** 偏好 id → 打印语言的文案。查不到就原样印。 */
  const label = (value: string) => {
    const key = PREFERENCE_LABELS[value];
    if (key) return tp(key);
    // 人体图的部位另有一张对照表（顾客端与技师端共用），查不到才原样印。
    return bodyPartText(value, printLanguage);
  };
  const labelList = (values: string[]) => values.map(label).join('、');

  const prefs = brief.preferences;
  const answersRaw = brief.health.form?.answers ?? null;
  /*
   * 避开部位有两个来源：客户档案（前台在到店弹窗里勾的）与问卷人体图。
   * 两边都要印 —— 只印其中一个，技师就会漏掉另一半。
   */
  const bodyMapAvoid = Array.isArray(answersRaw?.['bodyMapAvoid'])
    ? (answersRaw['bodyMapAvoid'] as unknown[]).filter((v): v is string => typeof v === 'string')
    : [];
  const avoidAreas = [...new Set([...prefs.avoidAreas, ...bodyMapAvoid])];
  const checkedConditions = (() => {
    const raw = answersRaw?.['conditions'];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
    return Object.entries(raw as Record<string, unknown>)
      .filter(([, value]) => value === true)
      .map(([key]) => (CONDITION_COPY[key] ? publicText(CONDITION_COPY[key], printLanguage) : key));
  })();

  /*
   * 「有没有禁忌」有两个证据来源：客户档案上的 `health_flag`（由前台或问卷
   * 同步写入），以及本次问卷里实际勾选的排查项。任取其一为真即为真 ——
   * 只看前者的话，客人明明勾了三项，纸上却写着「问卷未标记禁忌」，
   * 而那三项就印在这句话下面，技师无从判断该信哪一句。
   */
  const flagged = brief.health.hasFlag || checkedConditions.length > 0 || brief.health.advice.length > 0;

  const hasPrefs = Boolean(prefs.strength || prefs.oil || prefs.focusAreas.length
    || prefs.allergies.length || prefs.freeNotes);

  const questions = (brief.health.form?.questions ?? []) as FormQuestion[];
  const answers = answersRaw;

  /** 把一个答案渲染成人读的文字。布尔走词典，其余按原样印。 */
  const renderAnswer = (value: unknown): string => {
    if (value === true) return tp('print.answerYes');
    if (value === false) return tp('print.answerNo');
    if (Array.isArray(value)) return value.map((v) => String(v)).join('、');
    if (value && typeof value === 'object') {
      return Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v === true)
        .map(([k]) => k)
        .join('、');
    }
    return value === null || value === undefined ? '' : String(value);
  };

  const answeredQuestions = questions.filter((q) => {
    if (q.hidden || !answers) return false;
    const value = answers[q.id];
    if (value === undefined || value === null || value === '') return false;
    return !(Array.isArray(value) && value.length === 0);
  });

  return (
    <div className={`sbp sbp--${format}`}>
      {/* 打印时整条隐藏。纸上不该出现任何界面控件。 */}
      <header className="sbp-chrome">
        <div className="sbp-chrome__identity">
          <button type="button" className="sbp-chrome__back" onClick={goBack}>
            <ArrowLeft aria-hidden />
            {tp('print.backAction')}
          </button>
          <div>
            <span className="sbp-chrome__eyebrow">{tp('print.briefTitle')}</span>
            <h1>{brief.customerName}</h1>
          </div>
        </div>
        <div className="sbp-chrome__controls">
          <label htmlFor="sbp-lang">{tp('print.langLabel')}</label>
          <select
            id="sbp-lang"
            value={printLanguage}
            onChange={(e) => setPrintLanguage(e.target.value as Language)}
          >
            {UI_LANGUAGES.map((entry) => (
              <option key={entry.code} value={entry.code}>{entry.label}</option>
            ))}
          </select>

          <label htmlFor="sbp-format">{tp('print.formatLabel')}</label>
          <select
            id="sbp-format"
            value={format}
            onChange={(e) => setFormat(e.target.value as 'letter' | 'thermal')}
          >
            <option value="letter">US Letter (8.5 × 11 in)</option>
            <option value="thermal">{tp('print.formatThermal')}</option>
          </select>

          <button type="button" className="sbp-chrome__print" disabled={query.isFetching} onClick={async () => { const result = await query.refetch(); await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); if (result.data && !result.error) openPrintPreview(document.querySelector('.sbp-sheet'), tp('print.briefTitle'), format); }}>
            <Printer aria-hidden />
            {tp('print.printAction')}
          </button>
        </div>
      </header>

      <article className="sbp-sheet">
        <div className="sbp-head">
          <div className="sbp-brand">
            {formatI18n(brief.locationName, printLanguage)}
            <small>{tp('print.briefTitle')}</small>
          </div>
          <div className="sbp-meta">
            {brief.ticketNumber !== null && <span className="sbp-meta__no">#{brief.ticketNumber}</span>}
            <span>{brief.businessDate} · {clock(brief.openedAt)}</span>
          </div>
        </div>

        <div className="sbp-rule" />

        <div className="sbp-guest">
          <span className="sbp-guest__name">{brief.customerName}</span>
          <span className="sbp-guest__chips">
            <span className="sbp-chip">
              {brief.isFirstVisit ? tp('print.firstVisit') : tp('print.visitNth', { p0: brief.visitCount })}
            </span>
            {prefs.quiet && <span className="sbp-chip sbp-chip--soft">{tp('print.quiet')}</span>}
          </span>
        </div>

        <section>
          <h2 className="sbp-sec">{tp('print.sectionItems')}</h2>
          <table className="sbp-table">
            <thead>
              <tr>
                <th />
                <th>{tp('print.colService')}</th>
                <th>{tp('print.colStaff')}</th>
                <th>{tp('print.colRoom')}</th>
                <th className="sbp-num">{tp('print.colTime')}</th>
                <th className="sbp-num">{tp('print.colAmount')}</th>
              </tr>
            </thead>
            <tbody>
              {brief.items.map((item, index) => (
                <tr key={item.ticketItemId}>
                  <td className="sbp-seq">{index + 1}</td>
                  <td className="sbp-svc">{item.name} <span className="sbp-dim">{item.durationMin}m</span></td>
                  <td>{item.staffNames.join(' / ') || tp('print.staffUnassigned')}</td>
                  <td>{item.roomName || tp('print.roomUnassigned')}</td>
                  <td className="sbp-num sbp-mono">{itemTime(item)}</td>
                  <td className="sbp-num sbp-mono">${centsToDollars(item.totalCents)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td />
                <td>{tp('print.itemCount', { p0: brief.items.length })}</td>
                <td />
                <td />
                <td />
                <td className="sbp-num sbp-mono">${centsToDollars(brief.subtotalCents)}</td>
              </tr>
            </tfoot>
          </table>
        </section>

        <div className="sbp-split">
          <section>
            <h2 className="sbp-sec">{tp('print.sectionPrefs')}</h2>
            {hasPrefs ? (
              <dl className="sbp-kv">
                {prefs.strength && <><dt>{tp('print.prefStrength')}</dt><dd>{label(prefs.strength)}</dd></>}
                {prefs.oil && <><dt>{tp('print.prefOil')}</dt><dd>{label(prefs.oil)}</dd></>}
                {prefs.focusAreas.length > 0 && (
                  <><dt>{tp('print.prefFocus')}</dt><dd>{labelList(prefs.focusAreas)}</dd></>
                )}
                {prefs.allergies.length > 0 && (
                  <><dt>{tp('print.prefAllergy')}</dt><dd>{prefs.allergies.join('、')}</dd></>
                )}
                {prefs.freeNotes && <><dt>{tp('print.prefNotes')}</dt><dd>{prefs.freeNotes}</dd></>}
              </dl>
            ) : (
              <p className="sbp-dim">{tp('print.prefNone')}</p>
            )}
          </section>

          <section>
            <h2 className="sbp-sec">{tp('print.sectionAvoid')}</h2>
            <div className="sbp-avoid">
              {avoidAreas.length > 0
                ? <span className="sbp-avoid__items">{avoidAreas.map(label).join(' · ')}</span>
                : <span className="sbp-dim">{tp('print.avoidNone')}</span>}
            </div>
          </section>
        </div>

        <section>
          <h2 className="sbp-sec">{tp('print.sectionHealth')}</h2>
          <p className={flagged ? 'sbp-flag' : 'sbp-dim'}>
            {!brief.health.form && brief.health.canViewForm
              ? tp('print.healthNoForm')
              : flagged ? tp('print.healthFlagged') : tp('print.healthClear')}
          </p>
          {checkedConditions.length > 0 && (
            <p className="sbp-conditions">{checkedConditions.join(' · ')}</p>
          )}
          {brief.health.advice.length > 0 && (
            <ul className="sbp-advice">
              {brief.health.advice.map((entry) => (
                <li key={entry.code} className={entry.severity === 'avoid' ? 'sbp-advice--avoid' : undefined}>
                  {tp(`print.advice${entry.code}` as TranslationKey)}
                </li>
              ))}
            </ul>
          )}
          {!brief.health.canViewForm && <p className="sbp-dim">{tp('print.healthNoPermission')}</p>}
        </section>

        {answeredQuestions.length > 0 && (
          <section>
            <h2 className="sbp-sec">{tp('print.sectionForm')}</h2>
            {brief.health.form?.signerName && brief.health.form.signedAt && (
              <p className="sbp-dim">
                {tp('print.formSignedBy', {
                  p0: brief.health.form.signerName,
                  p1: clock(brief.health.form.signedAt) ?? brief.health.form.signedAt,
                })}
              </p>
            )}
            <dl className="sbp-kv sbp-kv--wide">
              {answeredQuestions.map((q) => (
                <div key={q.id} className="sbp-kv__row">
                  <dt>{formatI18n(q.label ?? q.id, printLanguage)}</dt>
                  <dd>{renderAnswer(answers?.[q.id])}</dd>
                </div>
              ))}
            </dl>
          </section>
        )}

        {brief.handoffNote && (
          <section className="sbp-handoff">
            <span className="sbp-handoff__label">{tp('print.sectionHandoff')}</span>
            <span>{brief.handoffNote}</span>
          </section>
        )}

        <footer className="sbp-foot">{tp('print.confidential')}</footer>
      </article>
    </div>
  );
}
