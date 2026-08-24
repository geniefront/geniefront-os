/**
 * 没记完的日子 —— 整天没用系统之后，第二天回来把账说清楚。
 *
 * 后端（`/v1/desk/gaps` + `dayclose.markDay`，0032 迁移）上一轮就做完了，
 * 这一屏是补上它缺的入口。
 *
 * 守的是一句话：**「那天做了 0 块」和「那天没人记」不是同一件事。**
 * 混为一谈的后果不是少个数字，是老板某天发现周报是错的 ——
 * 从那一刻起他不再信这个系统里的任何数字。
 *
 * 四条规矩：
 *   1. **永不拦路。** 这一屏一件事不处理，今天照样开单结账封账。
 *   2. 先说清那天**系统里到底有没有东西** —— 有数据只是没封账，
 *      跟压根没人碰过，补法完全不同。
 *   3. 补录要当面讲清楚**补不了什么**：营业额补得上，提成补不上。
 *   4. 给「不补」一条体面的出路，点完就不再烦人。
 */

import { useState } from 'react';
import { ApiError, runCommand } from '../lib/api';
import { CalendarCheck2, TriangleAlert } from 'lucide-react';
import { InfoDot } from '../ui/Info';

export type GapStatus =
  | 'unclosed' | 'summary_only' | 'paper_only' | 'no_record' | 'ok' | 'no_business';

export interface GapDay {
  businessDate: string;
  status: GapStatus;
  ticketCount: number;
  grossCents: number;
  hasEarnings: boolean;
  note: string | null;
}

export interface GapsData {
  businessDate: string;
  days: GapDay[];
  unhandled: number;
}

const money = (c: number) => `$${(c / 100).toFixed(2)}`;

/** 中文里「8月17日 周一」比 "2026-08-17" 好认 */
function dayLabel(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  const wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getUTCDay()];
  return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日 ${wd}`;
}

const KIND: Record<string, { badge: string; text: string; cta: string; info: string }> = {
  unclosed: {
    badge: 'badge-ok', text: '待封账', cta: '前往日结',
    info: '当日工单与收款记录完整，仅未执行封账操作。',
  },
  summary_only: {
    badge: 'badge-warn', text: '仅汇总补录', cta: '修改补录金额',
    info: '已补录当日营业额汇总，但无逐单明细，因此不生成技师提成记录。',
  },
  paper_only: {
    badge: 'badge-mute', text: '已标记不补录', cta: '重新补录',
    info: '当日经营数据未录入系统，已确认不再补录。报表中计为无数据，不计入合计。',
  },
  no_record: {
    badge: 'badge-mute', text: '无记录', cta: '标记该日',
    info: '系统中无当日任何工单或日结记录。需确认当日为休业、纸质记账还是待补录。',
  },
};

export function GapDays({
  data, membershipId, onChanged, onOpenDayClose,
}: {
  data: GapsData;
  membershipId: string;
  onChanged: () => Promise<unknown>;
  /** 「去封账」跳到打烊日结，并带上那一天 */
  onOpenDayClose: (businessDate: string) => void;
}) {
  const [editing, setEditing] = useState<GapDay | null>(null);

  if (data.days.length === 0) {
    return (
      <div className="page">
        <div className="card" style={{ padding: 48, textAlign: 'center' }}>
          <CalendarCheck2 size={36} style={{ color: 'var(--ok)' }} />
          <div className="title" style={{ marginTop: 14 }}>记录完整</div>
          <div className="tiny" style={{ marginTop: 8 }}>区间内无待补录日期，报表数据可直接用于同比。</div>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-hd">
        <div className="grow">
          <h1 className="display">待补录</h1>
          <div className="tiny sub row" style={{ gap: 6 }}>
            <span><span className="num">{data.days.length}</span> 个日期需要确认</span>
            <InfoDot text="补录不影响当日经营：未处理这些日期，仍可正常开单、结账与日结。" />
          </div>
        </div>
      </div>

      <div className="stack" style={{ gap: 14 }}>

      {data.days.map((g) => {
        const k = KIND[g.status] ?? KIND['no_record']!;
        return (
          <div key={g.businessDate} className="card" style={{ padding: 18 }}>
            <div className="row wrap" style={{ gap: 10, marginBottom: 10 }}>
              <strong className="title">{dayLabel(g.businessDate)}</strong>
              <span className={`badge ${k.badge}`}>{k.text}</span>
              <InfoDot text={k.info} />
              <span className="grow" />
              {g.ticketCount > 0 && (
                <span className="tiny" style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {g.ticketCount} 张单
                </span>
              )}
              {g.grossCents > 0 && <strong className="money-sm">{money(g.grossCents)}</strong>}
            </div>

            {g.note && <div className="tiny" style={{ marginBottom: 10 }}>↳ {g.note}</div>}

            {/* ⭐ 补了汇总 ≠ 补了提成。这个提示要常驻，不能只在补录时出现一次 */}
            {g.status === 'summary_only' && !g.hasEarnings && (
              <div className="row tiny" style={{
                color: 'var(--warn)', background: 'var(--warn-soft)',
                borderRadius: 'var(--r-sm)', padding: '10px 12px',
                marginBottom: 12, gap: 6,
              }}>
                <TriangleAlert size={15} />
                <span>无提成明细，当日薪酬需手工核算</span>
                <InfoDot text="汇总补录只记录营业额与收付款方式。系统无法得知每一单由谁完成，因此不生成 earnings 记录，该日提成不会出现在薪酬报表中。" />
              </div>
            )}

            <div className="row wrap" style={{ gap: 10 }}>
              {g.status === 'unclosed' ? (
                <button className="btn btn-primary grow"
                        onClick={() => onOpenDayClose(g.businessDate)}>
                  {k.cta}
                </button>
              ) : (
                <button className="btn btn-primary grow" onClick={() => setEditing(g)}>
                  {k.cta}
                </button>
              )}
            </div>
          </div>
        );
      })}

      {editing && (
        <MarkSheet
          day={editing} membershipId={membershipId}
          onCancel={() => setEditing(null)}
          onDone={async () => { setEditing(null); await onChanged(); }}
        />
      )}
      </div>
    </div>
  );
}

/* ───────────────────────────────────────────────────────────── 补录抽屉 */

type Mode = 'no_business' | 'paper_only' | 'summary_only';

function MarkSheet({ day, membershipId, onCancel, onDone }: {
  day: GapDay; membershipId: string;
  onCancel: () => void; onDone: () => Promise<void>;
}) {
  const [mode, setMode] = useState<Mode | null>(null);
  const [gross, setGross] = useState('');
  const [cash, setCash] = useState('');
  const [tipCash, setTipCash] = useState('');
  const [tipCard, setTipCard] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  /** 输入是元，命令收的是分。整数分是全仓的规矩（宪法第 4 条） */
  const toCents = (v: string) => Math.round((Number(v.replace(/[^0-9.]/g, '')) || 0) * 100);
  const grossC = toCents(gross);
  const cashC = toCents(cash);
  const cardC = Math.max(0, grossC - cashC);

  const canSave = mode === 'summary_only'
    ? grossC > 0 && cashC <= grossC
    : mode !== null;

  async function save() {
    if (!mode) return;
    setBusy(true); setErr('');
    try {
      await runCommand('dayclose.markDay', {
        businessDate: day.businessDate,
        mark: mode,
        ...(mode === 'summary_only' ? {
          summary: {
            grossCents: grossC, cashCents: cashC, cardCents: cardC,
            tipCashCents: toCents(tipCash), tipCardCents: toCents(tipCard),
          },
        } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      }, membershipId);
      await onDone();
    } catch (e) {
      // 后端那条 guard 的原话值得原样透出来：有真实工单的天不许被概括盖掉
      setErr(e instanceof ApiError
        ? (String(e.details['hint'] ?? '') || `操作失败（${e.code}）`)
        : '操作失败');
    } finally { setBusy(false); }
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(26,25,23,.45)', zIndex: 60,
      display: 'grid', placeItems: 'center', padding: 20,
    }} onClick={onCancel}>
      <div className="card stack" onClick={(e) => e.stopPropagation()}
           style={{ width: 'min(560px,100%)', maxHeight: '92vh', overflow: 'auto',
                    padding: 20, gap: 16 }}>
        <div className="row">
          <strong className="title grow">{dayLabel(day.businessDate)}</strong>
          <button className="btn btn-sm" onClick={onCancel}>关闭</button>
        </div>

        {err && <div className="badge badge-danger" style={{ padding: '10px 14px' }} role="alert">✕ {err}</div>}

        <div className="stack" style={{ gap: 10 }}>
          <div className="label">选择该日情况</div>
          <ModeBtn on={mode === 'no_business'} onClick={() => setMode('no_business')}
                   title="当日休业"
                   sub="报表计为营业额 0，纳入统计"
                   info="休息日、装修、天气原因关门等。这是一个真实的零值，会正常参与日均、同比等计算。" />
          <ModeBtn on={mode === 'summary_only'} onClick={() => setMode('summary_only')}
                   title="补录营业汇总"
                   sub="营业额纳入报表，不生成提成明细"
                   info="适用于当日使用纸质记账的情况。填入营业额与收付款拆分后，报表合计即完整；但系统无从得知每一单由谁完成，该日提成需手工核算。" />
          <ModeBtn on={mode === 'paper_only'} onClick={() => setMode('paper_only')}
                   title="标记为不补录"
                   sub="报表计为无数据，不计入合计"
                   info="正式记录「当日数据不在系统内」，此后不再提醒。这与营业额 0 不同：报表会显式标注该日缺失，避免合计被误读为完整。随时可改回补录。" />
        </div>

        {mode === 'summary_only' && (
          <div className="stack" style={{ gap: 12 }}>
            <div>
              <div className="label" style={{ marginBottom: 6 }}>营业额（不含小费）</div>
              <input className="field field-mono" inputMode="decimal" value={gross}
                     onChange={(e) => setGross(e.target.value)} placeholder="0.00" />
            </div>
            <div className="row" style={{ gap: 12 }}>
              <div className="grow">
                <div className="label" style={{ marginBottom: 6 }}>其中现金</div>
                <input className="field field-mono" inputMode="decimal" value={cash}
                       onChange={(e) => setCash(e.target.value)} placeholder="0.00" />
              </div>
              <div className="grow">
                <div className="label" style={{ marginBottom: 6 }}>其中刷卡（自动）</div>
                <input className="field field-mono" readOnly value={(cardC / 100).toFixed(2)}
                       style={{ background: '#f4f2ef' }} />
              </div>
            </div>
            <div className="row" style={{ gap: 12 }}>
              <div className="grow">
                <div className="label" style={{ marginBottom: 6 }}>现金小费</div>
                <input className="field field-mono" inputMode="decimal" value={tipCash}
                       onChange={(e) => setTipCash(e.target.value)} placeholder="0.00" />
              </div>
              <div className="grow">
                <div className="label" style={{ marginBottom: 6 }}>刷卡小费</div>
                <input className="field field-mono" inputMode="decimal" value={tipCard}
                       onChange={(e) => setTipCard(e.target.value)} placeholder="0.00" />
              </div>
            </div>

            {cashC > grossC && (
              <div className="badge badge-danger" style={{ padding: '8px 12px' }}>
                现金金额超过营业额，请核对
              </div>
            )}

            {/*
              ⭐ 这一段必须在「补进去」按钮**上面**。
              放在下面等于没说 —— 他已经按下去了。
            */}
            {/* ⭐ 这一段必须在提交按钮**之上**：放在下面等于没说，人已经按下去了 */}
            <div className="row" style={{
              background: 'var(--warn-soft)', borderRadius: 'var(--r-sm)',
              padding: '12px 14px', gap: 8, color: 'var(--warn)',
            }}>
              <TriangleAlert size={17} />
              <span style={{ fontSize: 'var(--text-sm)', fontWeight: 600 }}>
                该日提成需手工核算
              </span>
              <InfoDot text="补录仅覆盖营业额与收付款拆分，报表合计会因此完整。但系统无法还原每一单的执行技师，不会生成提成记录，薪酬报表中该日为空。" />
            </div>
          </div>
        )}

        {mode === 'paper_only' && (
          <div className="row" style={{
            background: 'var(--sunken)', borderRadius: 'var(--r-sm)',
            padding: '12px 14px', gap: 8,
          }}>
            <span className="tiny" style={{ color: 'var(--ink-2)', fontWeight: 500 }}>
              报表将显式标注该日缺失，且不计入合计
            </span>
            <InfoDot text="这与「当日休业」不同：休业是营业额为 0 的真实记录，而此项表示当日有经营但数据不在系统内。显式标注可避免合计被误读为完整。随时可改回补录。" />
          </div>
        )}

        {mode && (
          <div>
            <div className="label" style={{ marginBottom: 6 }}>备注（选填）</div>
            <input className="field" value={note} onChange={(e) => setNote(e.target.value)}
                   placeholder="例：前台请假，当日纸质记账" />
          </div>
        )}

        <div className="row" style={{ gap: 12 }}>
          <button className="btn grow" onClick={onCancel}>取消</button>
          <button className="btn btn-primary grow" disabled={!canSave || busy} onClick={save}>
            {busy ? <span className="spin" />
              : mode === 'summary_only' ? '提交补录'
              : mode === 'no_business' ? '标记为休业'
              : mode === 'paper_only' ? '标记为不补录' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ModeBtn({ on, onClick, title, sub, info }: {
  on: boolean; onClick: () => void; title: string; sub: string; info: string;
}) {
  return (
    <div className="row" style={{
      gap: 4, padding: '14px 12px 14px 16px', minHeight: 'var(--tap)',
      borderRadius: 'var(--r)', cursor: 'pointer',
      boxShadow: on ? 'inset 0 0 0 2px var(--ink)' : 'inset 0 0 0 1px var(--line-2)',
      background: on ? 'var(--sunken)' : 'var(--surface)',
    }} onClick={onClick} role="radio" aria-checked={on} tabIndex={0}
       onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}>
      <div className="grow">
        <div style={{ fontWeight: 600 }}>{title}</div>
        <div className="tiny" style={{ marginTop: 2 }}>{sub}</div>
      </div>
      <InfoDot text={info} />
    </div>
  );
}
