/**
 * 走单队列 —— 前台叫号那一屏。
 *
 * ⚠️ **宪法第 14 条**：没有 iPad 的店，这一屏就是全部 ——
 * 前台自己在这里帮客人取号、叫号、标记入座。Kiosk 只是让客人自己动手。
 * 所以「＋ 手工加一位」这个按钮不是补充功能，它是 Desk-Only 模式的主路径。
 *
 * ⚠️ **不做叫号短信**（宪法第 13 条）。门店数 ≥ 10 且 10DLC 批准之前，
 * 叫号只有门口大屏和前台口头喊两条路。
 */

import { useState } from 'react';
import {
  Armchair, CircleAlert, Plus, TriangleAlert, Star, Tablet, CalendarCheck,
} from 'lucide-react';
import { ApiError, runCommand } from '../lib/api';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { Badge } from '../ui/Badge';
import { Page, PageHeader, Empty } from '../ui/Page';
import { Field } from '../ui/Field';
import { Sheet } from '../ui/Overlay';
import { cn } from '../ui/cn';

export interface QueueEntry {
  queueId: string;
  ticketNumber: number;
  status: string;
  displayName: string;
  phoneDisplay: string | null;
  customerId: string | null;
  serviceName: string | null;
  staffName: string | null;
  partySize: number;
  appointmentId: string | null;
  waitedMin: number;
  quotedWaitMin: number | null;
  overdue: boolean;
  source: string;
  joinedAt: string;
  pendingForms: number;
}

export interface QueueData {
  businessDate: string;
  waiting: QueueEntry[];
  called: QueueEntry[];
  seated: QueueEntry[];
  summary: { waiting: number; called: number; longestWaitMin: number; leftToday: number };
}

const LEFT_REASONS: Array<[string, string]> = [
  ['waited_too_long', '等太久，走了'],
  ['told_us', '说了一声，先去别处'],
  ['seated_elsewhere', '前台另作安排'],
  ['no_response', '叫了没人应'],
  ['other', '其他'],
];

export function QueueBoard({
  data, membershipId, onChanged,
}: {
  data: QueueData;
  membershipId: string;
  onChanged: () => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [leaving, setLeaving] = useState<QueueEntry | null>(null);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');

  async function run(name: string, input: unknown) {
    setBusy(true); setErr('');
    try {
      await runCommand(name, input, membershipId);
      await onChanged();
    } catch (e) {
      setErr(e instanceof ApiError ? `操作失败（${e.code}）` : '操作失败');
    } finally { setBusy(false); }
  }

  const nothing = data.waiting.length === 0 && data.called.length === 0;

  return (
    <Page>
      <PageHeader
        title="候客"
        sub={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span>等位 <span className="tnum">{data.summary.waiting}</span></span>
            {data.summary.called > 0 && (
              <span>· 已叫号 <span className="tnum">{data.summary.called}</span></span>
            )}
            {data.summary.longestWaitMin > 0 && (
              <span className={cn(data.summary.longestWaitMin > 40 && 'font-semibold text-warn')}>
                · 最长等待 <span className="tnum">{data.summary.longestWaitMin}</span> 分钟
              </span>
            )}
            {/* 今天走掉几个 —— 这是老板最该看到的数，它直接对应流失 */}
            {data.summary.leftToday > 0 && (
              <span>· 今日离店 <span className="tnum">{data.summary.leftToday}</span> 位</span>
            )}
          </span>
        }
        actions={
          <Button variant="primary" disabled={busy} onClick={() => setAdding(true)}>
            <Plus size={18} />手工取号
          </Button>
        }
      />

      {err && (
        <div role="alert"
             className="mb-4 flex items-center gap-2 rounded bg-danger-soft px-4 py-3 text-danger">
          <CircleAlert size={17} /><span className="text-xs font-semibold">{err}</span>
        </div>
      )}

      {nothing ? (
        <Empty
          icon={<Armchair size={34} />}
          title="当前无人等位"
          hint="客人在门口 iPad 自助签到后会自动出现在这里。没有 iPad 的门店可用「手工取号」。"
        />
      ) : (
        <div className="flex flex-col gap-6">
          {data.called.length > 0 && (
            <section>
              <div className="mb-2.5 text-2xs font-bold uppercase tracking-wider text-ink-3">
                已叫号 · 待入座
              </div>
              <div className="flex flex-col gap-2.5">
                {data.called.map((e) => (
                  <Row key={e.queueId} e={e} busy={busy}
                       onSeat={() => void run('queue.update', { queueId: e.queueId, status: 'seated' })}
                       onLeft={() => setLeaving(e)} />
                ))}
              </div>
            </section>
          )}

          {data.waiting.length > 0 && (
            <section>
              <div className="mb-2.5 text-2xs font-bold uppercase tracking-wider text-ink-3">
                等位中
              </div>
              <div className="flex flex-col gap-2.5">
                {data.waiting.map((e) => (
                  <Row key={e.queueId} e={e} busy={busy}
                       onCall={() => void run('queue.update', { queueId: e.queueId, status: 'called' })}
                       onLeft={() => setLeaving(e)} />
                ))}
              </div>
            </section>
          )}
        </div>
      )}

      {/*
        离店必须给原因 —— 「等太久走的」和「说了一声先去别处」是两回事，
        而前者直接对应流失。不强制就没人会填。
      */}
      <Sheet
        open={leaving !== null}
        onOpenChange={(v) => !v && setLeaving(null)}
        title={leaving ? `${leaving.ticketNumber} 号 · ${leaving.displayName}` : ''}
        description="记录离店原因。这个数据用于分析客流流失。"
      >
        <div className="flex flex-col gap-2">
          {LEFT_REASONS.map(([key, label]) => (
            <Button key={key} block disabled={busy}
                    className="justify-start"
                    onClick={async () => {
                      if (!leaving) return;
                      await run('queue.update',
                        { queueId: leaving.queueId, status: 'left', leftReason: key });
                      setLeaving(null);
                    }}>
              {label}
            </Button>
          ))}
        </div>
      </Sheet>

      <Sheet
        open={adding}
        onOpenChange={(v) => { if (!v) { setAdding(false); setNewName(''); } }}
        title="手工取号"
        description="与客人在门口 iPad 自助取号共用同一套号码，不会重号。"
        footer={
          <>
            <Button block onClick={() => { setAdding(false); setNewName(''); }}>取消</Button>
            <Button variant="primary" block disabled={busy || !newName.trim()}
                    onClick={async () => {
                      await run('queue.join', { walkInName: newName.trim(), source: 'desk' });
                      setAdding(false); setNewName('');
                    }}>
              {busy
                ? <span className="size-5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                : '取号'}
            </Button>
          </>
        }
      >
        <Field value={newName} autoFocus placeholder="客人称呼，例：陈女士"
               onChange={(e) => setNewName(e.target.value)} />
      </Sheet>
    </Page>
  );
}

function Row({ e, busy, onCall, onSeat, onLeft }: {
  e: QueueEntry; busy: boolean;
  onCall?: () => void; onSeat?: () => void; onLeft: () => void;
}) {
  return (
    <Card className={cn(
      'flex items-center gap-4 p-4',
      // 超过承诺时间的单独标出来 —— 这是最可能流失的那一位
      e.overdue && 'ring-2 ring-warn/40 bg-warn-soft/50',
    )}>
      <div className={cn(
        'grid size-14 shrink-0 place-items-center rounded-sm text-xl font-bold tnum',
        e.overdue ? 'bg-warn text-white' : 'bg-sunken text-ink-2',
      )}>
        {e.ticketNumber}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <strong className="text-lg font-bold tracking-tight">{e.displayName}</strong>
          {e.partySize > 1 && <Badge tone="line">{e.partySize} 位</Badge>}
          {e.appointmentId && <Badge tone="ok"><CalendarCheck size={12} />有预约</Badge>}
          {e.source === 'kiosk' && <Badge tone="line"><Tablet size={12} />自助</Badge>}
          {/* 前台在叫号【之前】就该知道还差表没签 */}
          {e.pendingForms > 0 && (
            <Badge tone="warn"><TriangleAlert size={12} />{e.pendingForms} 份表未签</Badge>
          )}
        </div>
        <div className="mt-0.5 truncate text-xs text-ink-3">
          已等 <span className="tnum">{e.waitedMin}</span> 分钟
          {e.quotedWaitMin !== null && <> · 承诺 <span className="tnum">{e.quotedWaitMin}</span> 分钟</>}
          {e.serviceName && ` · ${e.serviceName}`}
          {e.staffName && <> · <Star size={11} className="inline -mt-0.5" /> 指定 {e.staffName}</>}
          {e.phoneDisplay && <> · <span className="tnum">{e.phoneDisplay}</span></>}
        </div>
      </div>

      {onCall && (
        <Button variant="primary" className="min-w-[7rem]" disabled={busy} onClick={onCall}>
          叫号
        </Button>
      )}
      {onSeat && (
        <Button variant="primary" className="min-w-[7rem]" disabled={busy} onClick={onSeat}>
          入座
        </Button>
      )}
      <Button disabled={busy} onClick={onLeft}>离店</Button>
    </Card>
  );
}
