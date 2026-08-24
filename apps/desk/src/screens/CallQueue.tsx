/**
 * 来电待复核队列 —— 决策 6 的「直推前台 1 秒复核队列」。
 *
 * ⭐ 这一屏的设计只有一条原则：**把 AI「听到的」和「猜到的」并排摆出来**。
 *
 * 只显示匹配结果（「Gel Manicure · Amy · 明天 16:00」）的话，前台没法核对 ——
 * 那一行字看起来永远是对的。而客人说的可能是 "gel removal"，
 * 一个价格差一倍的完全不同的活儿。
 *
 * 所以每一项都是两行：上面是听到的原话，下面是匹配到的东西。
 * 对不上的时候前台一眼就看见了。
 */

import { useState } from 'react';
import { PhoneCall, CircleAlert, TriangleAlert, Check, Users } from 'lucide-react';
import { ApiError, runCommand } from '../lib/api';
import { Button } from '../ui/Button';
import { Card, Sunken } from '../ui/Card';
import { Badge } from '../ui/Badge';
import { Page, PageHeader, Empty } from '../ui/Page';
import { Sheet } from '../ui/Overlay';
import { InfoDot } from '../ui/Info';
import { cn } from '../ui/cn';

export interface CallDraft {
  draftId: string;
  status: string;
  fromE164: string | null;
  fromDisplay: string | null;
  createdAt: string;
  service: { heard: string | null; matchedId: string | null; matchedName: string | null };
  staff: { heard: string | null; matchedId: string | null; matchedName: string | null };
  time: { heard: string | null; slotStartsAt: string | null; durationMin: number | null };
  customer: { id: string | null; displayName: string | null } | null;
  candidates: Array<{ customerId: string; displayName: string; lastVisitOn: string | null }>;
  callerNameHeard: string | null;
  confidenceBp: number;
  lowConfidence: boolean;
  notes: string | null;
  readyToBook: boolean;
  missing: string[];
}

export interface CallQueueData {
  drafts: CallDraft[];
  pendingCount: number;
}

const DISMISS_REASONS: Array<[string, string]> = [
  ['not_a_booking', '只是问价格 / 问营业时间'],
  ['wrong_service', '项目听错了'],
  ['wrong_time', '时间听错了'],
  ['wrong_staff', '技师听错了'],
  ['duplicate', '已经用别的方式约过了'],
  ['customer_cancelled', '客人又说不用了'],
  ['spam', '骚扰电话'],
  ['other', '其他'],
];

function clockOf(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('zh-CN', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

function agoOf(iso: string): string {
  const sec = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (sec < 60) return '刚刚';
  if (sec < 3600) return `${Math.floor(sec / 60)} 分钟前`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} 小时前`;
  return `${Math.floor(sec / 86400)} 天前`;
}

export function CallQueue({
  data, membershipId, onChanged, onBook,
}: {
  data: CallQueueData;
  membershipId: string;
  onChanged: () => Promise<unknown>;
  /**
   * 去建单。**不在这一屏建** —— 建预约要走前台自己身份下的
   * `appointment.create`，容量检查、软约束放行一样不少（09 §4.2）。
   * 这一屏只负责把三要素摆清楚。
   */
  onBook: (draft: CallDraft) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [dismissing, setDismissing] = useState<CallDraft | null>(null);

  async function dismiss(draft: CallDraft, reason: string) {
    setBusy(true); setErr('');
    try {
      await runCommand('call.reviewDraft',
        { draftId: draft.draftId, decision: 'dismissed', dismissReason: reason },
        membershipId);
      setDismissing(null);
      await onChanged();
    } catch (e) {
      setErr(e instanceof ApiError ? `操作失败（${e.code}）` : '操作失败');
    } finally { setBusy(false); }
  }

  if (data.drafts.length === 0) {
    return (
      <Page>
        <PageHeader title="来电复核" />
        <Empty
          icon={<PhoneCall size={34} />}
          title="无待复核来电"
          hint="AI 接听并识别出客人需求后，草案会出现在这里等待确认。"
        />
      </Page>
    );
  }

  return (
    <Page>
      <PageHeader
        title="来电复核"
        sub={
          <span className="flex items-center gap-1.5">
            <span className="tnum">{data.pendingCount}</span> 条待确认
            <InfoDot text="AI 仅记录来电内容，尚未创建任何预约。只有你点击「建单」并在日程上落位后，系统里才会产生真实记录。" />
          </span>
        }
      />

      {err && (
        <div role="alert"
             className="mb-4 flex items-center gap-2 rounded bg-danger-soft px-4 py-3 text-danger">
          <CircleAlert size={17} /><span className="text-xs font-semibold">{err}</span>
        </div>
      )}

      <div className="flex flex-col gap-3">
        {data.drafts.map((d) => (
          <Card key={d.draftId} className={cn(
            'p-5',
            d.lowConfidence && 'ring-2 ring-warn/40 bg-warn-soft/40',
          )}>
            {/* 谁打来的 */}
            <div className="flex flex-wrap items-center gap-2.5">
              <strong className="text-lg font-bold tracking-tight">
                {d.customer?.displayName ?? d.callerNameHeard ?? '未知来电'}
              </strong>
              {d.fromDisplay && <Badge tone="line"><span className="tnum">{d.fromDisplay}</span></Badge>}
              {d.lowConfidence && (
                <Badge tone="warn"><TriangleAlert size={12} />识别置信度低</Badge>
              )}
              <span className="flex-1" />
              <span className="text-xs text-ink-3">{agoOf(d.createdAt)}</span>
            </div>

            {/* ⭐ 三要素：听到的 vs 匹配到的，并排摆 */}
            <div className="mt-4 flex flex-col gap-3">
              <Element label="项目" heard={d.service.heard} matched={d.service.matchedName} />
              <Element label="时间" heard={d.time.heard}
                       matched={d.time.slotStartsAt
                         ? `${clockOf(d.time.slotStartsAt)}${d.time.durationMin ? ` · ${d.time.durationMin} 分钟` : ''}`
                         : null} />
              <Element label="技师" heard={d.staff.heard} matched={d.staff.matchedName} optional />
            </div>

            {/* 同号多客户：决策 21，绝不替前台挑一个 */}
            {d.candidates.length > 1 && (
              <Sunken className="mt-4 p-3.5">
                <div className="flex items-center gap-1.5 text-xs font-semibold">
                  <Users size={14} className="text-ink-3" />
                  该号码下有 {d.candidates.length} 位客人
                  <InfoDot text="手机号不是唯一标识（夫妻、母女共用一号很常见）。系统不会自动匹配，建单时需要你指定是哪一位。" />
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {d.candidates.map((c) => (
                    <Badge key={c.customerId} tone="line">
                      {c.displayName}{c.lastVisitOn && ` · 上次 ${c.lastVisitOn}`}
                    </Badge>
                  ))}
                </div>
              </Sunken>
            )}

            {d.notes && (
              <div className="mt-4 whitespace-pre-wrap text-xs leading-relaxed text-ink-2">
                {d.notes}
              </div>
            )}

            {/* 缺什么就说什么 —— 灰掉按钮不给理由，前台只会以为系统坏了 */}
            {!d.readyToBook && (
              <div className="mt-3 text-xs text-ink-3">
                尚缺 <strong className="text-ink-2">{d.missing.join('、')}</strong>，建单时补齐即可。
              </div>
            )}

            <div className="mt-5 flex items-center gap-3">
              <Button disabled={busy} onClick={() => setDismissing(d)}>忽略</Button>
              <span className="flex-1" />
              <Button variant="primary" size="lg" disabled={busy}
                      className="min-w-[12rem]" onClick={() => onBook(d)}>
                {d.readyToBook ? <><Check size={18} />照此建单</> : '去建单 · 补齐信息'}
              </Button>
            </div>
          </Card>
        ))}
      </div>

      {/* 忽略必须给原因 —— 这是「AI 到底准不准」唯一诚实的度量（05 §9） */}
      <Sheet
        open={dismissing !== null}
        onOpenChange={(v) => !v && setDismissing(null)}
        title="忽略原因"
        description="这是评估 AI 电话识别质量的唯一依据，请如实选择。"
      >
        <div className="flex flex-col gap-2">
          {DISMISS_REASONS.map(([key, label]) => (
            <Button key={key} block disabled={busy} className="justify-start"
                    onClick={() => dismissing && void dismiss(dismissing, key)}>
              {label}
            </Button>
          ))}
        </div>
      </Sheet>
    </Page>
  );
}

/**
 * 一个要素两行：听到的 / 匹配到的。
 *
 * 匹配不上时**不留空**，明说「未匹配」—— 空白会被读成「客人没说」，
 * 而实际上客人说了、只是没听懂，那是两件完全不同的事。
 */
function Element({ label, heard, matched, optional }: {
  label: string; heard: string | null; matched: string | null; optional?: boolean;
}) {
  if (!heard && !matched) {
    return (
      <div className="flex items-baseline gap-3">
        <span className="w-10 shrink-0 text-2xs font-bold uppercase tracking-wider text-ink-3">
          {label}
        </span>
        <span className="text-xs text-ink-3">{optional ? '未提及（不指定）' : '客人未说明'}</span>
      </div>
    );
  }

  return (
    <div className="flex items-baseline gap-3">
      <span className="w-10 shrink-0 pt-0.5 text-2xs font-bold uppercase tracking-wider text-ink-3">
        {label}
      </span>
      <div className="min-w-0 flex-1">
        {matched
          ? <div className="text-base font-semibold">{matched}</div>
          : <Badge tone="warn"><TriangleAlert size={12} />未匹配，建单时选择</Badge>}
        {heard && <div className="mt-0.5 text-xs text-ink-3">客人原话：「{heard}」</div>}
      </div>
    </div>
  );
}
