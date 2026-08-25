/**
 * 客人发进来的短信。
 *
 * ## ⭐ 这一页只为一件事存在
 *
 * 运营商强制 **CANCEL** 是**退订**关键词。而在预约系统里，客人打这六个字母
 * 十有八九想的是「取消我的预约」—— 他收到一条「已退订」，**以为办完了**，
 * 而店里那一格还占着，周六下午白空一小时，人也不来。
 *
 * 退订之后我们**再也发不了短信给他**（运营商在网络层就掐了）。
 * 所以这一页是那一刻唯一剩下的线索：前台看到「这个号发过 CANCEL、
 * 而他周六还有一单」，能主动打个电话问一句。
 *
 * ## 界面上的取舍
 *
 * **要处理的排最前，别的按时间。** 这一页平时是空的，前台不会主动来看 ——
 * 所以侧边栏有角标，而进来之后第一眼必须是「哪几条要打电话」。
 *
 * **不做回复框。** 我们不做短信对话（`docs/09` §5）：一是退订的人本来
 * 就发不出去，二是「能回一句」会让前台以为可以用短信谈事情，
 * 而对面可能十分钟后才看。要沟通就打电话，那按钮就在旁边。
 */

import { MessageSquare, Phone } from 'lucide-react';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { Badge } from '../ui/Badge';
import { Page, PageHeader, Empty, Label } from '../ui/Page';
import { cn } from '../ui/cn';

export interface InboundSmsMessage {
  id: string;
  fromE164: string;
  body: string;
  /** opt_out | opt_in | help | unknown */
  intent: string;
  receivedAt: string;
  customers: Array<{ id: string; name: string }>;
  upcoming: Array<{ appointmentId: string; startsAt: string; confirmationCode: string | null }>;
}

export interface SmsInboxData {
  messages: InboundSmsMessage[];
  needsAttention: number;
}

const INTENT_LABEL: Record<string, string> = {
  opt_out: '退订',
  opt_in: '重新订阅',
  help: '问帮助',
  unknown: '一句话',
};

/** 「要处理」= 退了订、而且名下还有没到的预约。就是 CANCEL 那个坑的形状 */
const needsCall = (m: InboundSmsMessage): boolean =>
  m.intent === 'opt_out' && m.upcoming.length > 0;

export function SmsInbox({ data, timezone }: { data: SmsInboxData; timezone: string }) {
  if (data.messages.length === 0) {
    return (
      <Page>
        <PageHeader title="客人短信" />
        <Empty
          icon={<MessageSquare size={34} />}
          title="还没有客人发短信进来"
          hint="客人回复的短信会出现在这里。回 STOP 或 CANCEL 的人尤其要看一眼 —— 那之后我们就发不了短信给他了。"
        />
      </Page>
    );
  }

  // 要处理的排最前
  const sorted = [...data.messages].sort((a, b) => {
    const d = Number(needsCall(b)) - Number(needsCall(a));
    return d !== 0 ? d : b.receivedAt.localeCompare(a.receivedAt);
  });

  return (
    <Page>
      <PageHeader title="客人短信"
                  sub={<><span className="tnum">{data.messages.length}</span> 条</>} />

      {data.needsAttention > 0 && (
        <div className="mb-4 rounded-lg border border-warn bg-warn-soft p-4">
          <strong className="text-sm text-warn">
            {data.needsAttention} 个人可能以为自己取消了预约
          </strong>
          <div className="mt-1.5 text-xs leading-relaxed text-warn">
            他们回复了 <strong>CANCEL</strong> 或 <strong>STOP</strong> —— 那是<strong>退订短信</strong>，
            不是取消预约。运营商规定这几个词必须退订，我们改不了。
            他们名下的预约还在，而且<strong>我们已经发不了短信给他们了</strong>。
            请打个电话确认一下。
          </div>
        </div>
      )}

      <div className="flex flex-col gap-3">
        {sorted.map((m) => <Row key={m.id} m={m} timezone={timezone} />)}
      </div>
    </Page>
  );
}

function Row({ m, timezone }: { m: InboundSmsMessage; timezone: string }) {
  const call = needsCall(m);
  const who = m.customers.map((c) => c.name).join(' / ');

  return (
    <Card className={cn('flex flex-col gap-2.5 p-5', call && 'border-2 border-warn')}>
      <div className="flex items-baseline justify-between gap-2.5">
        <strong className="text-lg font-bold tracking-[-0.02em]">{who || m.fromE164}</strong>
        <span className="text-xs text-ink-3">{when(m.receivedAt, timezone)}</span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={call ? 'danger' : 'mute'}>{INTENT_LABEL[m.intent] ?? m.intent}</Badge>
        <code className="tnum rounded bg-sunken px-2.5 py-1 font-mono text-xs">
          {m.body.slice(0, 120)}
        </code>
      </div>

      {/*
        ⚠️ 号码不脱敏：前台要照着它打电话，而她本来就有这个号
        （和「⚙ 开店配置」里技师手机号同一条口径）。技师端才脱敏（决策 16）。
      */}
      <div className="tnum text-xs text-ink-3">{m.fromE164}</div>

      {m.upcoming.length > 0 && (
        <div className="flex flex-col gap-1">
          <Label>名下还没到的预约</Label>
          {m.upcoming.map((u) => (
            <span key={u.appointmentId} className="text-xs text-ink-2">
              · {when(u.startsAt, timezone)}
              {u.confirmationCode ? `（${u.confirmationCode}）` : ''}
            </span>
          ))}
        </div>
      )}

      {call && (
        <Button asChild variant="primary" size="lg" block className="mt-1">
          <a href={`tel:${m.fromE164}`}><Phone size={18} />打给他确认</a>
        </Button>
      )}
    </Card>
  );
}

/** ⚠️ 一律门店时区 —— 前台看的是「店里的钟」（宪法第 8 条） */
function when(iso: string, timezone: string): string {
  const d = new Date(iso.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00'));
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: timezone, month: 'numeric', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(d);
}
