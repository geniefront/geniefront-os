/**
 * 通话记录 —— AI 电话的计量、转录、录音（`docs/14` §10）。
 *
 * ## ⭐ 这一屏为什么非有不可
 *
 * 决策 6 在 2026-08-22 改成了「AI 直接建单」：客人挂电话时单子已经落地，
 * 前台不再逐单复核。于是当客人到店说**「你们电话里明明说五点」**的时候，
 * 转录是唯一能对质的东西 —— 而在此之前它只存在于数据库里。
 *
 * 它同时是两个数字的出处：
 *   · **计费分钟** —— AI 语音按分钟从「订阅账户」的额度里扣（29 秒也算一分钟）
 *   · **订上几单** —— 老板问「这东西值不值」，问的就是这个比例
 *
 * ## 界面上的三个取舍
 *
 * **一眼能分辨「订上了」和「问完就挂」。** 列表上每通电话都有 `booked`
 * 徽章，不用点开逐句读 —— 一天几十通的店，逐句读等于不看。
 *
 * **搜索框搜的是转录内容，不只是号码。** 客人到店只会说「我上午打过电话，
 * 说的是五点」—— 他不会报自己的号码尾号。搜 "5" 或 "five" 能直接命中那一通。
 *
 * **号码跟着 `customer.view_contact` 脱敏。** 和来电复核屏同一条口径：
 * 看得见有这通电话，不等于能抄走客人的号码（决策 16 防挖客）。
 * 脱敏在**服务端**做，这里拿到的本来就已经是 `••••6667`。
 */

import { useMemo, useState } from 'react';
import {
  PhoneCall, CalendarCheck, Timer, Search, ChevronDown, ChevronRight,
  Play, Wrench, PhoneForwarded, PhoneMissed, CircleAlert,
} from 'lucide-react';
import { Card, Sunken } from '../ui/Card';
import { Badge } from '../ui/Badge';
import { Page, PageHeader, Empty, Label } from '../ui/Page';
import { Field } from '../ui/Field';
import { Button } from '../ui/Button';
import { Segmented } from '../ui/Segmented';
import { InfoDot } from '../ui/Info';
import { cn } from '../ui/cn';

export interface CallLine {
  role: 'user' | 'assistant' | 'tool' | 'system';
  text: string;
  at?: string;
  tool?: string;
}

export interface CallRecord {
  callId: string;
  /** 已按 `customer.view_contact` 在服务端脱敏 */
  fromE164: string | null;
  startedAt: string | null;
  durationSeconds: number | null;
  /** completed | no_answer | transferred_to_human | failed */
  outcome: string | null;
  toolsUsed: string[];
  booked: boolean;
  recordingUrl: string | null;
  transcript: CallLine[];
}

export interface CallLogData {
  calls: CallRecord[];
  bookedCount: number;
  totalMinutes: number;
}

export type CallRange = '7' | '30' | '90';

const OUTCOME: Record<string, { label: string; tone: 'mute' | 'ok' | 'warn' | 'danger' }> = {
  completed: { label: '正常结束', tone: 'mute' },
  transferred_to_human: { label: '转了人工', tone: 'warn' },
  no_answer: { label: '没接通', tone: 'mute' },
  failed: { label: '出错中断', tone: 'danger' },
};

/** 工具名 → 前台看得懂的话。列表上只显示这个，不显示函数名 */
const TOOL_LABEL: Record<string, string> = {
  start_call: '接通',
  lookup_customer: '查客户',
  list_services: '报项目',
  list_staff: '报技师',
  find_slots: '查空档',
  book_appointment: '建预约',
  request_callback: '留回电',
};

const ROLE_LABEL: Record<CallLine['role'], string> = {
  user: '客人',
  assistant: 'AI',
  tool: '工具',
  system: '系统',
};

/** mm:ss。**不要写成「3 分钟」** —— 计费向上取整，两者对不上时前台会以为记错了 */
function clock(sec: number | null): string {
  if (sec === null || sec < 0) return '—';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** ⚠️ 一律门店时区 —— 前台看的是「店里的钟」（宪法第 8 条） */
function when(iso: string | null, timezone: string): string {
  if (!iso) return '时间不详';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: timezone, month: 'numeric', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(d);
}

export function CallLog({
  data, timezone, range, onRangeChange,
}: {
  data: CallLogData;
  timezone: string;
  range: CallRange;
  onRangeChange: (r: CallRange) => void;
}) {
  const [q, setQ] = useState('');
  const [onlyBooked, setOnlyBooked] = useState<'all' | 'booked'>('all');

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return data.calls.filter((c) => {
      if (onlyBooked === 'booked' && !c.booked) return false;
      if (!needle) return true;
      // 号码、时间、以及**转录全文** —— 客人报不出号码，只报得出「说了五点」
      if ((c.fromE164 ?? '').toLowerCase().includes(needle)) return true;
      return c.transcript.some((l) => l.text.toLowerCase().includes(needle));
    });
  }, [data.calls, q, onlyBooked]);

  return (
    <Page>
      <PageHeader
        title="通话记录"
        sub={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="tnum">{data.calls.length}</span> 通电话 ·
            订上 <span className="tnum">{data.bookedCount}</span> 单 ·
            计费 <span className="tnum">{data.totalMinutes}</span> 分钟
            <InfoDot text="AI 语音按分钟从「订阅账户」的语音额度里扣，29 秒也算一分钟 —— 所以计费分钟数会比通话时长的总和略多。这里的数就是扣费的口径。" />
          </span>
        }
        actions={
          <Segmented
            ariaLabel="时间范围"
            value={range}
            onChange={onRangeChange}
            options={[
              { value: '7', label: '近 7 天' },
              { value: '30', label: '近 30 天' },
              { value: '90', label: '近 90 天' },
            ]}
          />
        }
      />

      {/*
        ⭐ 搜索框放在最上面，因为这一屏最常见的进入方式是「客人正站在柜台前」。
        那一刻要的不是浏览列表，是**立刻找到那一通**。
      */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative min-w-[16rem] flex-1">
          <Search size={17} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-3" />
          <Field
            className="pl-11"
            placeholder="搜号码尾号，或客人说过的话"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="搜索通话"
          />
        </div>
        <Segmented
          ariaLabel="筛选"
          value={onlyBooked}
          onChange={setOnlyBooked}
          options={[
            { value: 'all', label: '全部', count: data.calls.length },
            { value: 'booked', label: '订上单的', count: data.bookedCount },
          ]}
        />
      </div>

      {data.calls.length === 0 ? (
        <Empty
          icon={<PhoneCall size={34} />}
          title="这段时间还没有 AI 接过电话"
          hint="AI 每接一通电话，这里就多一条：多长、用了哪些工具、有没有订上单，以及完整的逐句转录。"
        />
      ) : shown.length === 0 ? (
        <Empty
          icon={<Search size={34} />}
          title="没有匹配的通话"
          hint="搜索会同时匹配来电号码和转录内容。换个词，或者把时间范围放宽。"
          action={<Button onClick={() => { setQ(''); setOnlyBooked('all'); }}>清空筛选</Button>}
        />
      ) : (
        <div className="flex flex-col gap-3">
          {shown.map((c) => <Row key={c.callId} call={c} timezone={timezone} />)}
        </div>
      )}
    </Page>
  );
}

function Row({ call, timezone }: { call: CallRecord; timezone: string }) {
  const [open, setOpen] = useState(false);
  const oc = OUTCOME[call.outcome ?? ''] ?? { label: call.outcome ?? '未知', tone: 'mute' as const };
  const billed = Math.ceil((call.durationSeconds ?? 0) / 60);
  /** 工具列表里去掉 start_call：每通都有，摆出来只是噪音 */
  const tools = call.toolsUsed.filter((t) => t !== 'start_call');

  return (
    <Card className={cn('overflow-hidden', call.booked && 'ring-1 ring-ok/25')}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full min-h-tap cursor-pointer items-center gap-3.5 px-5 py-4 text-left hoverable:hover:bg-sunken"
      >
        {open ? <ChevronDown size={18} className="shrink-0 text-ink-3" />
              : <ChevronRight size={18} className="shrink-0 text-ink-3" />}

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <strong className="tnum text-base font-bold tracking-tight">
              {call.fromE164 ?? '号码不详'}
            </strong>
            {call.booked
              ? <Badge tone="ok"><CalendarCheck size={12} />订上单了</Badge>
              : <Badge tone="mute">没订上</Badge>}
            {call.outcome && call.outcome !== 'completed' && (
              <Badge tone={oc.tone}>
                {call.outcome === 'transferred_to_human' ? <PhoneForwarded size={12} />
                  : call.outcome === 'no_answer' ? <PhoneMissed size={12} />
                  : <CircleAlert size={12} />}
                {oc.label}
              </Badge>
            )}
          </div>
          <div className="mt-1 text-xs text-ink-3">
            {when(call.startedAt, timezone)}
            {tools.length > 0 && ` · ${tools.map((t) => TOOL_LABEL[t] ?? t).join(' → ')}`}
          </div>
        </div>

        {/* 时长与计费分钟并排：29 秒算一分钟，两个数不一样是正常的 */}
        <div className="shrink-0 text-right">
          <div className="tnum text-lg font-bold leading-tight">{clock(call.durationSeconds)}</div>
          <div className="tnum text-2xs text-ink-3">计费 {billed} 分钟</div>
        </div>
      </button>

      {open && (
        <div className="border-t border-line bg-ground px-5 py-4">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Label>逐句转录</Label>
            <span className="flex-1" />
            {call.recordingUrl && (
              // 录音在 Telnyx 那边，是外链。⚠️ 加州 two-party consent 要开场告知，
              // 这个链接存在不代表告知过（docs/09 §4.4）
              <Button size="sm" asChild>
                <a href={call.recordingUrl} target="_blank" rel="noreferrer noopener">
                  <Play size={14} />听录音
                </a>
              </Button>
            )}
          </div>

          {call.transcript.length === 0 ? (
            <Sunken className="p-4 text-xs text-ink-3">
              这通电话还没有转录。挂机后由对账任务从 Telnyx 拉回来，
              通常几分钟内补齐；一直没有的话多半是 <code className="font-mono">TELNYX_RECONCILE_MINUTES</code> 没开。
            </Sunken>
          ) : (
            <div className="flex flex-col gap-2.5">
              {call.transcript.map((line, i) => <Line key={i} line={line} />)}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

/**
 * 一句话。
 *
 * 客人和 AI 左右分开摆 —— 纠纷发生时要看的是「谁说了什么」，
 * 而一整列同样缩进的文字读起来分不出说话人。
 * 工具调用单独一档、压到最轻：它是机器的动作，不是对话。
 */
function Line({ line }: { line: CallLine }) {
  if (line.role === 'tool') {
    return (
      <div className="flex items-center gap-2 pl-6 text-2xs text-ink-3">
        <Wrench size={12} className="shrink-0" />
        <span className="truncate">
          {line.tool ? (TOOL_LABEL[line.tool] ?? line.tool) : '工具'}
          {line.text && ` · ${line.text}`}
        </span>
      </div>
    );
  }

  const mine = line.role === 'assistant';
  return (
    <div className={cn('flex flex-col gap-1', mine ? 'items-start' : 'items-end')}>
      <span className="text-2xs font-bold uppercase tracking-wider text-ink-3">
        {ROLE_LABEL[line.role]}
      </span>
      <div className={cn(
        'max-w-[46rem] whitespace-pre-wrap rounded px-4 py-2.5 text-xs leading-relaxed',
        mine ? 'bg-surface border border-line-2 text-ink' : 'bg-ink text-white',
      )}>
        {line.text}
      </div>
    </div>
  );
}
