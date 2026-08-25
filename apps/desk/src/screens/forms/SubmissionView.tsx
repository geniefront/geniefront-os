/**
 * 打开一份已经签好的健康表（`docs/15` §5）。
 *
 * ## ⭐ 这一屏和别的「查看详情」不一样：**看之前要说为什么**
 *
 * 02 §5 要求健康表**读也审计**。所以这里不是点一下就展开 ——
 * 先选一个理由，那个理由会连同「谁、什么时候、从哪个 IP」
 * 一起写进 `form_access_log`。
 *
 * 多花的那一次点击买到的是：出纠纷时能回答「你们凭什么翻她的健康表」。
 * 一条只写「某某周二下午看过」的日志在那种场合几乎没有用。
 *
 * ## 导出 PDF 走浏览器的打印
 *
 * 不引 PDF 库：前台真正要的是「打一张出来夹进纸质档案」或者
 * 「存成 PDF 发给保险公司」，而浏览器的打印对话框两件事都能做，
 * 还自带纸张和页边距。代价是页眉页脚由浏览器控制 —— 可以接受。
 * 打印样式在 theme.css 末尾那一段。
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Printer, ShieldCheck, CircleAlert, PenLine } from 'lucide-react';
import { apiGet } from '../../lib/api';
import { Button } from '../../ui/Button';
import { Modal } from '../../ui/Overlay';
import { Badge } from '../../ui/Badge';
import { Sunken } from '../../ui/Card';
import { Label } from '../../ui/Page';
import type { Locale } from '../../i18n';
import { pick, type I18nText } from './presets';

/** 为什么要看。⚠️ 白名单和服务端那份是同一套（server.ts 的 FORM_ACCESS_REASONS）*/
const REASONS: Array<[string, string, string]> = [
  ['service_prep', '马上要给他做', '看一眼有没有禁忌 —— 九成是这条'],
  ['incident_review', '出事了要查', '客人投诉、受伤、或者保险要材料'],
  ['customer_request', '客人自己要看', '他有权要一份自己签过的东西'],
  ['export', '打印 / 导出', '夹进纸质档案，或者发给保险公司'],
];

interface Question {
  id: string;
  type: string;
  label: I18nText;
  options?: Array<{ value: string; label: I18nText }>;
  required?: boolean;
}

interface Detail {
  submissionId: string;
  templateTitle: I18nText;
  templateVersion: number;
  questions: Question[];
  answers: Record<string, unknown> | null;
  signerName: string | null;
  signerRelation: string;
  signatureUrl: string | null;
  signedAt: string | null;
  locale: string;
  source: string;
  ip: string | null;
  expiresOn: string | null;
  anonymized: boolean;
  customerName: string | null;
}

const SOURCE_LABEL: Record<string, string> = {
  kiosk: '门口 iPad',
  desk: '前台代填',
  link: '客人自己手机上填的',
};

export function SubmissionView({
  submissionId, membershipId, locale, canView, onClose,
}: {
  submissionId: string;
  membershipId: string;
  locale: Locale;
  /** 没有 customer.view_health_form 的人连理由都不用选 */
  canView: boolean;
  onClose: () => void;
}) {
  const [reason, setReason] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ['form-submission', submissionId, reason],
    enabled: Boolean(reason) && canView,
    // ⚠️ 不缓存、不复用：每看一次都要真的走一趟服务端，因为**那一趟就是留痕**。
    // 缓存住的话，第二次「查看」在日志里不存在
    gcTime: 0,
    staleTime: 0,
    queryFn: () => apiGet<Detail>(
      `/v1/desk/forms/submissions/${submissionId}?reason=${reason}`, membershipId),
  });

  if (!canView) {
    return (
      <Modal open onOpenChange={onClose} title="你看不到这份表的内容"
             footer={<Button block onClick={onClose}>知道了</Button>}>
        <div className="text-xs leading-relaxed text-ink-2">
          健康表的内容要 <code className="font-mono">customer.view_health_form</code> 权限，
          默认只有老板、店长和前台有 —— 技师看不到。
          <div className="mt-3">
            技师在床边需要知道的那一条（「避开右膝」「有禁忌，见前台」）
            已经在客人交表时回填进客户档案了，不用翻这张表。
          </div>
        </div>
      </Modal>
    );
  }

  if (!reason) {
    return (
      <Modal open onOpenChange={onClose} title="为什么要看这份表？"
             description="健康表读也留痕（谁、什么时候、为什么）。这条记录出纠纷时能自证清白。">
        <div className="flex flex-col gap-2">
          {REASONS.map(([key, label, hint]) => (
            <button key={key} type="button" onClick={() => setReason(key)}
                    className="flex min-h-tap cursor-pointer flex-col justify-center rounded border border-line-2 bg-surface px-4 py-3 text-left hoverable:hover:border-ink-3/40">
              <span className="text-sm font-semibold">{label}</span>
              <span className="mt-0.5 text-xs text-ink-3">{hint}</span>
            </button>
          ))}
        </div>
      </Modal>
    );
  }

  const d = q.data;

  return (
    <Modal
      open
      onOpenChange={onClose}
      width="lg"
      title={d ? pick(d.templateTitle, locale) || '健康表' : '打开中…'}
      {...(d ? { description: `第 ${d.templateVersion} 版 · ${SOURCE_LABEL[d.source] ?? d.source}` } : {})}
      footer={
        <>
          <Button onClick={onClose}>关掉</Button>
          <span className="flex-1" />
          <Button variant="primary" disabled={!d} onClick={() => window.print()}>
            <Printer size={18} />打印 / 存成 PDF
          </Button>
        </>
      }
    >
      {q.isPending && <div className="py-10 text-center text-xs text-ink-3">正在解密…</div>}

      {q.error && (
        <div role="alert" className="flex items-start gap-2.5 rounded bg-danger-soft px-4 py-3.5 text-danger">
          <CircleAlert size={17} className="mt-0.5 shrink-0" />
          <span className="text-xs leading-relaxed">
            打不开。最常见的原因只有一个：<code className="font-mono">FORM_ENCRYPTION_KEY</code> 换过了 ——
            那把钥匙一换，此前所有已签的表就都解不开了。
          </span>
        </div>
      )}

      {d && (
        <div id="form-print" className="flex flex-col gap-5">
          {/* 打印出来的那张纸也要能自证是谁、什么时候、第几版 */}
          <div className="hidden print:block">
            <h1 className="text-xl font-bold">{pick(d.templateTitle, locale)}</h1>
            <div className="mt-1 text-xs">
              第 {d.templateVersion} 版 · {d.customerName ?? d.signerName ?? '未挂客户档案'}
              {d.signedAt && ` · 签于 ${new Date(d.signedAt).toLocaleString('zh-CN')}`}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 print:hidden">
            <strong className="text-base font-bold">{d.customerName ?? '（没挂到客户档案）'}</strong>
            {d.signerRelation === 'guardian' && <Badge tone="warn">监护人代签</Badge>}
            {d.expiresOn && new Date(d.expiresOn) < new Date()
              ? <Badge tone="danger">已过期（{d.expiresOn}）</Badge>
              : d.expiresOn && <Badge tone="mute">有效期到 {d.expiresOn}</Badge>}
            <Badge tone="line">他看的是 {LOCALE_NAME[d.locale] ?? d.locale}</Badge>
          </div>

          {d.anonymized ? (
            <Sunken className="p-4 text-xs leading-relaxed text-ink-2">
              这份表已经**按客人要求匿名化**了：答案和签名都抹掉了，
              但「他在什么时候签过第几版」这个事实留着 —— 两头都留空的话，
              出事时我们既拿不出内容、也证明不了他签过。
            </Sunken>
          ) : (
            <div className="flex flex-col gap-3">
              {d.questions.map((qq) => (
                <Answer key={qq.id} q={qq} value={d.answers?.[qq.id]} locale={locale} />
              ))}
            </div>
          )}

          {d.signatureUrl && (
            <div>
              <Label>手写签名</Label>
              <div className="mt-2 rounded border border-line-2 bg-white p-3">
                {/* data URL 或私有桶里的链接，两种都直接渲染 */}
                <img src={d.signatureUrl} alt="客人的手写签名" className="max-h-32" />
              </div>
              <div className="mt-1.5 text-2xs text-ink-3">
                {d.signerName}
                {d.signedAt && ` · ${new Date(d.signedAt).toLocaleString('zh-CN')}`}
                {d.ip && ` · 从 ${d.ip}`}
              </div>
            </div>
          )}

          <div className="flex items-start gap-2 text-2xs text-ink-3 print:hidden">
            <ShieldCheck size={13} className="mt-0.5 shrink-0" />
            <span>
              你这次打开已经记进了访问日志（理由：
              {REASONS.find(([k]) => k === reason)?.[1]}）。
              这条记录出纠纷时是用来自证清白的。
            </span>
          </div>
        </div>
      )}
    </Modal>
  );
}

const LOCALE_NAME: Record<string, string> = {
  'zh-Hans': '简体中文', 'zh-Hant': '繁體中文', en: 'English',
  vi: 'Tiếng Việt', ko: '한국어', es: 'Español',
};

/**
 * 一题一答。
 *
 * ⚠️ **没答的题要明说「没答」**，不能留白 —— 空白会被读成「他答了否」，
 * 而「漏答」和「答否」在纠纷里完全不是一回事。
 */
function Answer({ q, value, locale }: { q: Question; value: unknown; locale: Locale }) {
  const optionLabel = (v: string) =>
    pick(q.options?.find((o) => o.value === v)?.label, locale) || v;

  let shown: React.ReactNode;
  if (value === undefined || value === null || value === '') {
    shown = <span className="text-ink-3">没答</span>;
  } else if (typeof value === 'boolean') {
    shown = value
      ? <span className="font-bold text-warn">是</span>
      : <span>否</span>;
  } else if (Array.isArray(value)) {
    shown = value.length === 0
      ? <span className="text-ink-3">没选</span>
      : value.map((v) => optionLabel(String(v))).join('、');
  } else {
    shown = optionLabel(String(value));
  }

  return (
    <div className="flex gap-4 border-b border-line pb-3 last:border-0">
      <div className="flex-1 text-xs text-ink-2">
        {pick(q.label, locale) || q.id}
        {q.required && <span className="ml-1 text-2xs text-ink-3">（必答）</span>}
      </div>
      <div className="w-[45%] shrink-0 text-sm font-semibold">{shown}</div>
    </div>
  );
}

/** 供列表页判断要不要显示「签名」小图标 */
export const SignatureMark = () => <PenLine size={13} className="text-ink-3" />;
