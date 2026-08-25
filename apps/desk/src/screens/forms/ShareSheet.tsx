/**
 * 把健康表发给客人 —— 二维码或邮件（`docs/15` §4）。
 *
 * ## 为什么默认是二维码
 *
 * 最常见的场景不是「提前一周发邮件」，是**客人已经站在柜台前**：
 * 前台把屏幕转过去，他用自己的手机扫，坐下等的时候填完。
 * 比递一台公用 iPad 快，而且他填的是真话 —— 那台 iPad 上
 * 后面还排着队，人会一路点「否」。
 *
 * ## ⚠️ 没有「发短信」这一档
 *
 * 不是没做，是**故意不做**（`docs/09` §5）：平台号发陌生短链是
 * 10DLC 通道被掐的头号原因，而掐掉影响的是所有店的预约确认短信。
 * 界面上要把这句话说出来，否则前台只会以为是漏了个功能。
 */

import { useState } from 'react';
import {
  QrCode, Mail, Copy, Check, Link2, CircleAlert, Search, UserRound, X,
} from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { ApiError, apiGet, runCommand } from '../../lib/api';
import { Button } from '../../ui/Button';
import { Field } from '../../ui/Field';
import { Sheet } from '../../ui/Overlay';
import { Badge } from '../../ui/Badge';
import { Sunken } from '../../ui/Card';
import { Toggle } from '../../ui/Toggle';
import { Segmented } from '../../ui/Segmented';
import { Label } from '../../ui/Page';
import { InfoDot } from '../../ui/Info';
import type { Locale } from '../../i18n';
import { pick, type I18nText } from './presets';

export interface ShareTarget {
  templateId: string;
  title: I18nText;
  requiresSignature: boolean;
}

interface ShareResult {
  shareId: string;
  url: string;
  qrSvg: string;
  expiresAt: string;
  emailQueued: boolean;
}

interface CustomerHit {
  id: string;
  displayName: string;
  phoneE164: string | null;
}

export function ShareSheet({
  open, onOpenChange, templates, membershipId, locale, preselectedIds, customer, onShared,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  templates: ShareTarget[];
  membershipId: string;
  /** 客人看到的语言。默认跟着前台当前的界面语言，但可以改 */
  locale: Locale;
  preselectedIds?: string[];
  /** 从客户档案点进来时已经知道是谁 */
  customer?: { id: string; displayName: string } | null;
  onShared: () => Promise<unknown>;
}) {
  const [picked, setPicked] = useState<string[]>(preselectedIds ?? templates.map((t) => t.templateId));
  const [channel, setChannel] = useState<'qr' | 'email'>('qr');
  const [email, setEmail] = useState('');
  const [who, setWho] = useState<CustomerHit | null>(
    customer ? { id: customer.id, displayName: customer.displayName, phoneE164: null } : null);
  const [formLocale, setFormLocale] = useState<Locale>(locale);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [result, setResult] = useState<ShareResult | null>(null);
  const [copied, setCopied] = useState(false);

  async function submit() {
    setBusy(true); setErr('');
    try {
      const { result } = await runCommand<ShareResult>('form.share', {
        templateIds: picked,
        customerId: who?.id ?? null,
        channel,
        ...(channel === 'email' ? { email: email.trim() } : {}),
        locale: formLocale,
        expiresInHours: 72,
      }, membershipId);
      setResult(result);
      await onShared();
    } catch (e) {
      setErr(e instanceof ApiError
        ? (e.details['reason'] === 'no_active_form_templates'
            ? '这家店还没有发布过健康表 —— 先去「模板」那一栏建一份'
            : `发不出去（${e.code}）`)
        : '发不出去');
    } finally { setBusy(false); }
  }

  function close() {
    setResult(null); setErr(''); setCopied(false);
    onOpenChange(false);
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(v) => (v ? onOpenChange(true) : close())}
      title={result ? '让客人扫这个码' : '发给客人填'}
      description={result
        ? '填完这条链接立刻失效。72 小时内没填也会失效。'
        : '客人在自己手机上填，到店当天不用在柜台前排队填。'}
      width={620}
      footer={result
        ? <Button variant="primary" size="lg" block onClick={close}>好了</Button>
        : (
          <>
            <Button onClick={close} disabled={busy}>取消</Button>
            <Button variant="primary" className="flex-1" disabled={busy || picked.length === 0
                      || (channel === 'email' && !email.includes('@'))}
                    onClick={() => void submit()}>
              {channel === 'qr' ? <><QrCode size={18} />生成二维码</> : <><Mail size={18} />发邮件</>}
            </Button>
          </>
        )}
    >
      {result ? <Done result={result} channel={channel} email={email}
                      copied={copied} onCopy={() => {
                        void navigator.clipboard.writeText(result.url);
                        setCopied(true);
                      }} />
        : (
          <div className="flex flex-col gap-6">
            {err && (
              <div role="alert" className="flex items-center gap-2 rounded bg-danger-soft px-4 py-3 text-danger">
                <CircleAlert size={17} /><span className="text-xs font-semibold">{err}</span>
              </div>
            )}

            {/* ① 签哪几份 */}
            <section>
              <Label>要他签哪几份</Label>
              <div className="mt-2.5 flex flex-col gap-2">
                {templates.map((t) => (
                  <Toggle
                    key={t.templateId}
                    checked={picked.includes(t.templateId)}
                    onChange={(v) => setPicked((cur) => v
                      ? [...cur, t.templateId]
                      : cur.filter((x) => x !== t.templateId))}
                    label={pick(t.title, locale) || '（没有标题）'}
                    hint={t.requiresSignature ? '要手写签名' : '不用签名'}
                  />
                ))}
              </div>
            </section>

            {/* ② 是谁 */}
            <section>
              <Label>是哪位客人</Label>
              <div className="mt-1 text-xs text-ink-3">
                挂到客户档案上，他签的表下次就不用再签一遍。
                <InfoDot text="不选也能发 —— 匿名的表照样有法律效力，只是它不会自动挂到某位客人名下，也不会把「避开哪里」回填进他的档案。他到店后前台可以再合并。" />
              </div>
              <div className="mt-2.5">
                {who ? (
                  <div className="flex min-h-tap items-center gap-3 rounded border border-ink bg-surface px-4">
                    <UserRound size={18} className="shrink-0 text-ink-3" />
                    <span className="flex-1 text-sm font-semibold">{who.displayName}</span>
                    <Button variant="ghost" size="icon" aria-label="换一位"
                            onClick={() => setWho(null)}><X size={17} /></Button>
                  </div>
                ) : <CustomerPicker membershipId={membershipId} onPick={setWho} />}
              </div>
            </section>

            {/* ③ 怎么发 */}
            <section>
              <Label>怎么发给他</Label>
              <div className="mt-2.5 flex flex-col gap-3">
                <Segmented
                  ariaLabel="发送方式"
                  className="w-full [&>button]:flex-1"
                  value={channel}
                  onChange={setChannel}
                  options={[
                    { value: 'qr', label: '当面扫码' },
                    { value: 'email', label: '发邮件' },
                  ]}
                />
                {channel === 'email' && (
                  <Field type="email" placeholder="客人的邮箱" value={email}
                         onChange={(e) => setEmail(e.target.value)} aria-label="客人的邮箱" />
                )}
                {/*
                  ⚠️ 这句话必须留在界面上。少了它，前台会一直以为
                  「发短信」是个还没做的功能，然后每周问一次
                */}
                <Sunken className="p-3.5 text-xs leading-relaxed text-ink-2">
                  <strong>没有「发短信」是故意的。</strong>
                  用店里的号码发一条带网页链接的短信，在运营商眼里和钓鱼短信长得一样 ——
                  被掐掉的是整条通道，连预约确认短信一起停。要发就当面扫码，或者发邮件。
                </Sunken>
              </div>
            </section>

            {/* ④ 哪种语言 */}
            <section>
              <Label>客人看哪种语言</Label>
              <div className="mt-1 text-xs text-ink-3">
                他打开之后还能自己换。看不懂的免责书在法律上等于没签。
              </div>
              <div className="mt-2.5 flex flex-wrap gap-2">
                {(['zh-Hans', 'en', 'vi', 'ko', 'zh-Hant', 'es'] as const).map((l) => (
                  <button key={l} type="button" onClick={() => setFormLocale(l)}
                          className={`min-h-tap-sm cursor-pointer rounded-sm border px-3.5 text-xs font-semibold ${
                            formLocale === l ? 'border-ink bg-ink text-white' : 'border-line-2 bg-surface text-ink-2'}`}>
                    {LOCALE_SHORT[l]}
                  </button>
                ))}
              </div>
            </section>
          </div>
        )}
    </Sheet>
  );
}

const LOCALE_SHORT: Record<string, string> = {
  'zh-Hans': '简体', en: 'English', vi: 'Tiếng Việt',
  ko: '한국어', 'zh-Hant': '繁體', es: 'Español',
};

/** 生成完之后那一屏：一个大码 + 一条能复制的链接 */
function Done({ result, channel, email, copied, onCopy }: {
  result: ShareResult; channel: string; email: string;
  copied: boolean; onCopy: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-5">
      {channel === 'email' ? (
        <div className="flex w-full items-center gap-3 rounded bg-ok-soft px-4 py-3.5 text-ok">
          <Mail size={18} className="shrink-0" />
          <span className="text-xs font-semibold">邮件已发往 {email}</span>
        </div>
      ) : null}

      {/*
        ⚠️ 这段 SVG 是**服务端生成的**（handlers/kiosk.ts → forms/qr.ts），
        里面没有脚本也没有外链 —— 唯一来自外部的东西是那条 URL，
        而它只被编码成方块，不会出现在标签里。
      */}
      <div className="rounded-lg border border-line-2 bg-white p-5 [&_svg]:size-[240px]"
           dangerouslySetInnerHTML={{ __html: result.qrSvg }} />

      <div className="text-center text-xs text-ink-3">
        把屏幕转向客人，让他用手机相机对着扫。
      </div>

      <div className="w-full">
        <Label>或者把链接发给他</Label>
        <div className="mt-2 flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded bg-sunken px-3.5 py-3 font-mono text-xs">
            {result.url}
          </code>
          <Button size="sm" onClick={onCopy} aria-label="复制链接">
            {copied ? <><Check size={15} />已复制</> : <><Copy size={15} />复制</>}
          </Button>
        </div>
      </div>

      <div className="flex w-full items-center gap-2 text-2xs text-ink-3">
        <Link2 size={13} className="shrink-0" />
        <span>
          这条链接只发给他一个人。填完立刻失效，
          {new Date(result.expiresAt).toLocaleString('zh-CN', {
            month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}
          {' '}之后也会失效。
        </span>
      </div>
    </div>
  );
}

/** 找客人。和「客户档案」那一屏同一条接口，只是这里只要一个结果 */
function CustomerPicker({ membershipId, onPick }: {
  membershipId: string;
  onPick: (c: CustomerHit) => void;
}) {
  const [term, setTerm] = useState('');
  const q = useQuery({
    queryKey: ['customers', membershipId, term],
    enabled: term.trim().length >= 2,
    queryFn: () => apiGet<{ customers: CustomerHit[] }>(
      `/v1/customers/search?q=${encodeURIComponent(term.trim())}`, membershipId),
  });
  const hits = q.data?.customers ?? [];

  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        <Search size={17} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-3" />
        <Field className="pl-11" placeholder="姓名或手机号，输两个字以上"
               value={term} onChange={(e) => setTerm(e.target.value)} aria-label="找客人" />
      </div>
      {hits.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {hits.slice(0, 5).map((c) => (
            <button key={c.id} type="button" onClick={() => onPick(c)}
                    className="flex min-h-tap cursor-pointer items-center gap-3 rounded border border-line-2 bg-surface px-4 text-left hoverable:hover:border-ink-3/40">
              <span className="flex-1 text-sm font-semibold">{c.displayName}</span>
              {c.phoneE164 && <Badge tone="line"><span className="tnum">{c.phoneE164}</span></Badge>}
            </button>
          ))}
        </div>
      )}
      {term.trim().length >= 2 && !q.isPending && hits.length === 0 && (
        <span className="text-xs text-ink-3">没找到 —— 不选客人也能发，他到店后再合并。</span>
      )}
    </div>
  );
}
