/**
 * 健康表 —— 生成 / 存储 / 同步 / 分享（`docs/15`）。
 *
 * ## 这一页要回答三个问题，所以是三栏
 *
 *   **模板** 这家店要客人签什么（生成）
 *   **已签** 谁签过、什么时候到期、他填了什么（存储 + 读取留痕）
 *   **链接** 发出去的表填了没有（分享）
 *
 * 拆成三个侧边栏入口的话，侧栏会长出三条一周点不了一次的东西 ——
 * 而它们其实是同一件事的三面。
 *
 * ## ⚠️ 一句必须留在界面上的话
 *
 * 健康表**不是**「填了就完事」的表单：它是出事时唯一的证据（`00` §2）。
 * 所以这一页处处在提醒三件事 —— 缺语言等于那种语言的客人没签、
 * 到期了要重签、看内容会留痕。少了这些提示，前台会把它当成一张问卷。
 */

import { useState } from 'react';
import {
  ClipboardList, FilePlus2, Send, PenLine, Eye, Link2, Ban, QrCode, Mail,
  TriangleAlert, ShieldCheck, Languages, Clock, CircleAlert,
} from 'lucide-react';
import { ApiError, runCommand } from '../lib/api';
import { Button } from '../ui/Button';
import { Card, Sunken } from '../ui/Card';
import { Badge } from '../ui/Badge';
import { Page, PageHeader, Empty, Label } from '../ui/Page';
import { Tabs, TabPanel } from '../ui/Tabs';
import { Modal } from '../ui/Overlay';
import { InfoDot } from '../ui/Info';
import type { Locale } from '../i18n';
import { FORM_PRESETS, pick, missingLocales, type I18nText } from './forms/presets';
import { Builder, draftFromPreset, blankDraft, type DraftTemplate } from './forms/Builder';
import { ShareSheet } from './forms/ShareSheet';
import { SubmissionView } from './forms/SubmissionView';

export interface FormTemplateView {
  templateId: string;
  key: string;
  version: number;
  title: I18nText;
  questions: Array<{
    id: string; type: 'bool' | 'text' | 'choice' | 'multi'; label: I18nText;
    options?: Array<{ value: string; label: I18nText }>;
    required?: boolean; sync?: 'avoid_areas' | 'health_flag';
  }>;
  requiresSignature: boolean;
  validDays: number | null;
  serviceIds: string[];
  publishedAt: string | null;
  signedCount: number;
}

export interface FormSubmissionView {
  submissionId: string;
  templateId: string;
  templateKey: string;
  templateTitle: I18nText;
  templateVersion: number;
  customerId: string | null;
  customerName: string | null;
  signerName: string | null;
  signerRelation: string;
  source: string;
  locale: string;
  signedAt: string | null;
  createdAt: string;
  expiresOn: string | null;
  expired: boolean;
  anonymized: boolean;
  hasSignature: boolean;
}

export interface FormShareView {
  shareId: string;
  customerId: string | null;
  customerName: string | null;
  channel: string;
  sentTo: string | null;
  templateCount: number;
  createdAt: string;
  expiresAt: string;
  openedAt: string | null;
  submittedAt: string | null;
  revokedAt: string | null;
  state: string;
}

export interface HealthFormsData {
  templates: FormTemplateView[];
  submissions: FormSubmissionView[];
  shares: FormShareView[];
  canViewContent: boolean;
}

const SOURCE_LABEL: Record<string, string> = {
  kiosk: '门口 iPad', desk: '前台代填', link: '客人自己填的',
};

/** ⚠️ 「点开了没填」和「根本没点开」要分开：前者打电话催，后者多半是没收到 */
const SHARE_STATE: Record<string, { label: string; tone: 'mute' | 'ok' | 'warn' | 'danger' }> = {
  pending: { label: '还没点开', tone: 'warn' },
  opened: { label: '点开了没填完', tone: 'warn' },
  done: { label: '填完了', tone: 'ok' },
  expired: { label: '已过期', tone: 'mute' },
  revoked: { label: '已吊销', tone: 'mute' },
};

function when(iso: string | null, timezone: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: timezone, month: 'numeric', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(d);
}

export function HealthForms({
  data, membershipId, locale, timezone, canManage, onChanged,
}: {
  data: HealthFormsData;
  membershipId: string;
  locale: Locale;
  timezone: string;
  /** 只有能管配置的人才能建模板；发给客人前台就能做 */
  canManage: boolean;
  onChanged: () => Promise<unknown>;
}) {
  const [tab, setTab] = useState('templates');
  const [draft, setDraft] = useState<DraftTemplate | null>(null);
  const [sharing, setSharing] = useState<string[] | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const [library, setLibrary] = useState(false);
  const [err, setErr] = useState('');

  const pendingShares = data.shares.filter((s) => s.state === 'pending' || s.state === 'opened');
  const expiringSoon = data.submissions.filter((s) => s.expired).length;

  async function revoke(shareId: string) {
    setErr('');
    try {
      await runCommand('form.revokeShare', { shareId }, membershipId);
      await onChanged();
    } catch (e) {
      setErr(e instanceof ApiError ? `吊销失败（${e.code}）` : '吊销失败');
    }
  }

  return (
    <Page>
      <PageHeader
        title="健康表"
        sub={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="tnum">{data.templates.length}</span> 份在用 ·
            近 30 天签了 <span className="tnum">{data.submissions.length}</span> 份
            {pendingShares.length > 0 && <> · <span className="tnum">{pendingShares.length}</span> 条发出去还没填</>}
            <InfoDot text="健康表是出事时唯一的证据（保险和纠纷都看它）。答案在服务端加密之后才进数据库，看内容要单独的权限，而且看一眼就留一条访问记录。" />
          </span>
        }
        actions={
          <>
            {data.templates.length > 0 && (
              <Button onClick={() => setSharing(data.templates.map((t) => t.templateId))}>
                <Send size={17} />发给客人
              </Button>
            )}
            {canManage && (
              <Button variant="primary" onClick={() => setLibrary(true)}>
                <FilePlus2 size={17} />新建
              </Button>
            )}
          </>
        }
      />

      {err && (
        <div role="alert" className="mb-4 flex items-center gap-2 rounded bg-danger-soft px-4 py-3 text-danger">
          <CircleAlert size={17} /><span className="text-xs font-semibold">{err}</span>
        </div>
      )}

      <Tabs
        value={tab}
        onValueChange={setTab}
        items={[
          { value: 'templates', label: '模板', count: data.templates.length },
          { value: 'signed', label: '已签', count: data.submissions.length },
          { value: 'shares', label: '发出去的', count: pendingShares.length },
        ]}
      >
        {/* ═══════════════ 模板 ═══════════════ */}
        <TabPanel value="templates">
          {data.templates.length === 0 ? (
            <Empty
              icon={<ClipboardList size={34} />}
              title="这家店还没有健康表"
              hint="按摩类在美国是法律与保险的刚需：禁忌症问卷、责任免除、遮盖同意。模板库里有三份现成的，六种语言，改改就能用。"
              action={canManage
                ? <Button variant="primary" size="lg" onClick={() => setLibrary(true)}>
                    <FilePlus2 size={18} />从模板库新建
                  </Button>
                : <span className="text-xs text-ink-3">建模板要「门店设置」权限，找老板</span>}
            />
          ) : (
            <div className="flex flex-col gap-3">
              {data.templates.map((t) => (
                <TemplateCard
                  key={t.templateId}
                  t={t}
                  locale={locale}
                  canManage={canManage}
                  onShare={() => setSharing([t.templateId])}
                  onEdit={() => setDraft({
                    key: t.key,
                    title: t.title,
                    questions: t.questions,
                    requiresSignature: t.requiresSignature,
                    validDays: t.validDays,
                    existingVersion: t.version,
                  })}
                />
              ))}
            </div>
          )}
        </TabPanel>

        {/* ═══════════════ 已签 ═══════════════ */}
        <TabPanel value="signed">
          {!data.canViewContent && (
            <Sunken className="mb-4 flex items-start gap-2.5 p-4">
              <ShieldCheck size={17} className="mt-0.5 shrink-0 text-ink-3" />
              <span className="text-xs leading-relaxed text-ink-2">
                你看得到<strong>谁签过、什么时候到期</strong>，但看不到内容 ——
                那要 <code className="font-mono">customer.view_health_form</code> 权限。
                技师在床边需要的那一条（「避开右膝」「有禁忌，见前台」）已经回填进客户档案了。
              </span>
            </Sunken>
          )}

          {expiringSoon > 0 && (
            <div className="mb-4 flex items-start gap-2.5 rounded bg-warn-soft px-4 py-3.5 text-warn">
              <Clock size={17} className="mt-0.5 shrink-0" />
              <span className="text-xs leading-relaxed">
                有 <strong>{expiringSoon}</strong> 份已经过期。
                过期的表在门口 iPad 和填表链接里会重新出现 ——
                「三年前签过一次」在法律上站不住，客人的身体状况会变。
              </span>
            </div>
          )}

          {data.submissions.length === 0 ? (
            <Empty icon={<PenLine size={34} />} title="近 30 天还没有人签"
                   hint="客人在门口 iPad 上签、前台代签、或者扫码在自己手机上签，都会出现在这里。" />
          ) : (
            <div className="flex flex-col gap-2">
              {data.submissions.map((s) => (
                <SubmissionRow key={s.submissionId} s={s} locale={locale} timezone={timezone}
                               onView={() => setViewing(s.submissionId)} />
              ))}
            </div>
          )}
        </TabPanel>

        {/* ═══════════════ 发出去的链接 ═══════════════ */}
        <TabPanel value="shares">
          {data.shares.length === 0 ? (
            <Empty icon={<Link2 size={34} />} title="还没发过填表链接"
                   hint="客人站在柜台前时，把屏幕转过去让他扫码，坐下等的时候就填完了 —— 比递一台公用 iPad 快，填的也更实在。" />
          ) : (
            <div className="flex flex-col gap-2">
              {data.shares.map((s) => (
                <ShareRow key={s.shareId} s={s} timezone={timezone}
                          onRevoke={() => void revoke(s.shareId)} />
              ))}
            </div>
          )}
        </TabPanel>
      </Tabs>

      {/* ── 模板库 ── */}
      <Modal open={library} onOpenChange={setLibrary} width="lg"
             title="从模板库新建"
             description="三份现成的表，六种语言。⚠️ 它们是起点不是合规保证 —— 各州对免责条款的要求不同，正式用之前请让你的保险或律师看一眼。">
        <div className="flex flex-col gap-3">
          {FORM_PRESETS.map((p) => (
            <button key={p.key} type="button"
                    onClick={() => { setDraft(draftFromPreset(p)); setLibrary(false); }}
                    className="cursor-pointer rounded border border-line-2 bg-surface p-4 text-left hoverable:hover:border-ink-3/40">
              <div className="text-base font-bold">{pick(p.title, locale)}</div>
              <div className="mt-1 text-xs text-ink-2">{pick(p.blurb, locale)}</div>
              <div className="mt-2.5 flex flex-wrap gap-1.5">
                <Badge tone="line">{p.questions.length} 题</Badge>
                <Badge tone="line">六种语言</Badge>
                {p.requiresSignature && <Badge tone="line">要手写签名</Badge>}
                {p.validDays && <Badge tone="line">{p.validDays} 天后重签</Badge>}
                {p.questions.some((q) => q.sync) && <Badge tone="brand">会回填客户档案</Badge>}
              </div>
            </button>
          ))}
          <button type="button" onClick={() => { setDraft(blankDraft()); setLibrary(false); }}
                  className="cursor-pointer rounded border border-dashed border-line-2 bg-sunken p-4 text-left hoverable:hover:border-ink-3/40">
            <div className="text-sm font-semibold">从空白开始</div>
            <div className="mt-1 text-xs text-ink-3">
              自己写题目。⚠️ 六种语言都要填，缺哪种，那种语言的客人签的表就不作数。
            </div>
          </button>
        </div>
      </Modal>

      {draft && (
        <Builder open onOpenChange={(v) => !v && setDraft(null)} draft={draft}
                 membershipId={membershipId} locale={locale}
                 onSaved={async () => { await onChanged(); setDraft(null); }} />
      )}

      {sharing && (
        <ShareSheet
          open
          onOpenChange={(v) => !v && setSharing(null)}
          templates={data.templates.map((t) => ({
            templateId: t.templateId, title: t.title, requiresSignature: t.requiresSignature,
          }))}
          preselectedIds={sharing}
          membershipId={membershipId}
          locale={locale}
          onShared={onChanged}
        />
      )}

      {viewing && (
        <SubmissionView submissionId={viewing} membershipId={membershipId} locale={locale}
                        canView={data.canViewContent} onClose={() => setViewing(null)} />
      )}
    </Page>
  );
}

function TemplateCard({ t, locale, canManage, onShare, onEdit }: {
  t: FormTemplateView;
  locale: Locale;
  canManage: boolean;
  onShare: () => void;
  onEdit: () => void;
}) {
  // 缺语言要在**列表上**就看得见 —— 展开才看得到的话，它会一直缺着
  const gaps = new Set<string>();
  for (const l of missingLocales(t.title)) gaps.add(l);
  for (const q of t.questions) for (const l of missingLocales(q.label)) gaps.add(l);

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-baseline gap-2.5">
        <strong className="text-lg font-bold tracking-tight">
          {pick(t.title, locale) || t.key}
        </strong>
        <Badge tone="line">v{t.version}</Badge>
        {t.requiresSignature && <Badge tone="mute"><PenLine size={11} />要签名</Badge>}
        {gaps.size > 0 && (
          <Badge tone="warn"><Languages size={11} />缺 {gaps.size} 种语言</Badge>
        )}
      </div>

      <div className="mt-2 text-xs text-ink-3">
        {t.questions.length} 题 ·
        {t.validDays ? ` ${t.validDays} 天后要重签 ·` : ' 永久有效 ·'}
        {' '}已经签过 <span className="tnum">{t.signedCount}</span> 次
        {t.questions.some((q) => q.sync) && ' · 会回填客户档案'}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2.5">
        <Button size="sm" onClick={onShare}><Send size={15} />发给客人</Button>
        {canManage && (
          <Button size="sm" onClick={onEdit}>改一版</Button>
        )}
        {t.signedCount > 0 && canManage && (
          <span className="text-2xs text-ink-3">
            改动会发 v{t.version + 1}；已经签过 v{t.version} 的 {t.signedCount} 位客人，记录仍指着他签的那一版
          </span>
        )}
      </div>
    </Card>
  );
}

function SubmissionRow({ s, locale, timezone, onView }: {
  s: FormSubmissionView; locale: Locale; timezone: string; onView: () => void;
}) {
  return (
    <Card className="flex flex-wrap items-center gap-3 px-5 py-4">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <strong className="text-sm font-bold">
            {s.customerName ?? s.signerName ?? '匿名'}
          </strong>
          {s.signerRelation === 'guardian' && <Badge tone="warn">监护人代签</Badge>}
          {s.expired && <Badge tone="danger"><TriangleAlert size={11} />已过期</Badge>}
          {s.anonymized && <Badge tone="mute">已匿名化</Badge>}
        </div>
        <div className="mt-1 text-xs text-ink-3">
          {pick(s.templateTitle, locale) || s.templateKey} v{s.templateVersion} ·
          {' '}{when(s.signedAt ?? s.createdAt, timezone)} ·
          {' '}{SOURCE_LABEL[s.source] ?? s.source}
          {s.expiresOn && !s.expired && ` · 有效期到 ${s.expiresOn}`}
        </div>
      </div>
      <Button size="sm" onClick={onView}><Eye size={15} />查看</Button>
    </Card>
  );
}

function ShareRow({ s, timezone, onRevoke }: {
  s: FormShareView; timezone: string; onRevoke: () => void;
}) {
  const st = SHARE_STATE[s.state] ?? { label: s.state, tone: 'mute' as const };
  const live = s.state === 'pending' || s.state === 'opened';

  return (
    <Card className="flex flex-wrap items-center gap-3 px-5 py-4">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <strong className="text-sm font-bold">{s.customerName ?? '没挂客户档案'}</strong>
          <Badge tone={st.tone}>{st.label}</Badge>
          <Badge tone="line">
            {s.channel === 'email' ? <><Mail size={11} />{s.sentTo}</> : <><QrCode size={11} />当面扫码</>}
          </Badge>
        </div>
        <div className="mt-1 text-xs text-ink-3">
          {s.templateCount} 份 · 发于 {when(s.createdAt, timezone)}
          {live && ` · ${when(s.expiresAt, timezone)} 失效`}
          {s.openedAt && !s.submittedAt && ` · 点开于 ${when(s.openedAt, timezone)}`}
        </div>
      </div>
      {live && (
        <Button size="sm" variant="danger" onClick={onRevoke}>
          <Ban size={15} />吊销
        </Button>
      )}
    </Card>
  );
}
