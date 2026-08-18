/**
 * 提成方案 —— 门店默认 + 逐人覆盖。
 *
 * 提成引擎从 Phase 1b 就在算，但方案一直只能改数据库：老板要给某个人
 * 调一档提成率，得来找我们。这一屏把它交回给老板。
 *
 * ⭐ **方案是版本化的，改了只影响之后的单**（`02` 的长注释）。
 * 这不是技术洁癖：技师每天下班要看一次自己的收入，如果老板周三改了提成率、
 * 周一的数字跟着变了，这个系统就再也没人信了。界面上必须把这句话说出来 ——
 * 不说的话老板会以为改完是「全部重算」，然后拿着旧数字去跟技师对账。
 *
 * ⚠️ **「折扣算谁的」不给默认值**（契约里 base 是显式枚举）。
 * 这是真店里的头号争议：$100 的活打八折收 $80，提成按 100 算还是按 80 算，
 * 差的是技师的钱。糊一个默认值过去，等于替老板做了一个他没意识到自己做过的决定。
 */

import { useState } from 'react';
import { ApiError, runCommand } from '../lib/api';

export interface PlanConfig {
  version: number;
  kind: 'commission' | 'hourly' | 'commission_vs_hourly' | 'booth_rent';
  rateBp: number;
  categoryRateBp?: Record<string, number>;
  retailRateBp?: number;
  hourlyRateCents?: number;
  base?: 'net' | 'gross';
}

export interface PayrollPlansData {
  defaultPlan: PlanConfig | null;
  staff: Array<{ membershipId: string; name: string; plan: PlanConfig | null }>;
  categories: Array<{ id: string; name: string }>;
}

const KINDS: Array<{ v: PlanConfig['kind']; label: string; hint: string }> = [
  { v: 'commission', label: '纯提成', hint: '做多少拿多少，最常见' },
  { v: 'commission_vs_hourly', label: '保底', hint: '提成和时薪取高的那个（W-2 常见）' },
  { v: 'hourly', label: '纯时薪', hint: '按小时算，不看单量' },
];

const pct = (bp: number) => (bp / 100).toFixed(bp % 100 === 0 ? 0 : 1);
const toBp = (s: string) => Math.round(Number(s) * 100);

export function PayrollPlans({
  data, membershipId, onChanged,
}: {
  data: PayrollPlansData;
  membershipId: string;
  onChanged: () => Promise<unknown>;
}) {
  const [editing, setEditing] = useState<{ id: string | null; name: string } | null>(null);

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="card stack" style={{ padding: 14, gap: 8 }}>
        <strong>改了只影响以后的单</strong>
        <div className="tiny" style={{ lineHeight: 1.7 }}>
          今天之前算好的收入<strong>一分都不会变</strong>。技师每天下班都会看一次
          自己的收入，改一次提成率就把上周的数字改掉的话，这个表就没人信了。
          <br />
          所以：改完之后<strong>只有新开的单</strong>按新方案算。
        </div>
      </div>

      <PlanRow label="门店默认（新人自动套用）" plan={data.defaultPlan}
               onEdit={() => setEditing({ id: null, name: '门店默认' })} />

      <div className="tiny muted" style={{ marginTop: 4 }}>逐人覆盖（没设的跟门店默认走）</div>
      {data.staff.map((s) => (
        <PlanRow key={s.membershipId} label={s.name} plan={s.plan}
                 onEdit={() => setEditing({ id: s.membershipId, name: s.name })} />
      ))}

      {editing && (
        <PlanSheet
          who={editing}
          current={editing.id === null
            ? data.defaultPlan
            : data.staff.find((s) => s.membershipId === editing.id)?.plan ?? null}
          categories={data.categories}
          membershipId={membershipId}
          onCancel={() => setEditing(null)}
          onDone={async () => { await onChanged(); setEditing(null); }} />
      )}
    </div>
  );
}

function PlanRow({ label, plan, onEdit }: {
  label: string; plan: PlanConfig | null; onEdit: () => void;
}) {
  return (
    <div className="card row" style={{ padding: '14px 16px', gap: 12 }}>
      <div className="grow stack" style={{ gap: 3, minWidth: 0 }}>
        <strong className="truncate">{label}</strong>
        <div className="tiny">
          {plan ? (
            <>
              {KINDS.find((k) => k.v === plan.kind)?.label ?? plan.kind}
              {' · '}提成 {pct(plan.rateBp)}%
              {plan.kind !== 'commission' && plan.hourlyRateCents
                ? ` · 时薪 $${(plan.hourlyRateCents / 100).toFixed(2)}` : ''}
              {' · '}按{plan.base === 'gross' ? '原价' : '折后'}算
              {plan.categoryRateBp && Object.keys(plan.categoryRateBp).length > 0
                ? ` · ${Object.keys(plan.categoryRateBp).length} 个分类另定` : ''}
              <span className="muted"> · 第 {plan.version} 版</span>
            </>
          ) : <span className="muted">还没设 —— 跟门店默认走</span>}
        </div>
      </div>
      <button className="btn" style={{ minHeight: 44 }} onClick={onEdit}>
        {plan ? '改' : '设一个'}
      </button>
    </div>
  );
}

function PlanSheet({
  who, current, categories, membershipId, onCancel, onDone,
}: {
  who: { id: string | null; name: string };
  current: PlanConfig | null;
  categories: Array<{ id: string; name: string }>;
  membershipId: string;
  onCancel: () => void;
  onDone: () => Promise<void>;
}) {
  const [kind, setKind] = useState<PlanConfig['kind']>(current?.kind ?? 'commission');
  const [rate, setRate] = useState(pct(current?.rateBp ?? 4500));
  const [hourly, setHourly] = useState(
    current?.hourlyRateCents ? (current.hourlyRateCents / 100).toFixed(2) : '');
  const [retail, setRetail] = useState(pct(current?.retailRateBp ?? 1000));
  /** ⚠️ 没有默认值 —— 折扣算谁的是真店里的头号争议，必须让老板显式选 */
  const [base, setBase] = useState<'net' | 'gross' | null>(current?.base ?? null);
  const [catRates, setCatRates] = useState<Record<string, string>>(() => {
    const o: Record<string, string> = {};
    for (const [k, v] of Object.entries(current?.categoryRateBp ?? {})) o[k] = pct(v);
    return o;
  });
  const [showCats, setShowCats] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const needsHourly = kind !== 'commission';
  const ok = base !== null && rate.trim() !== ''
    && (!needsHourly || Number(hourly) > 0);

  async function save() {
    setBusy(true); setErr('');
    try {
      const catBp: Record<string, number> = {};
      for (const [id, v] of Object.entries(catRates)) {
        if (v.trim() !== '') catBp[id] = toBp(v);
      }
      await runCommand('payroll.savePlan', {
        membershipId: who.id,
        kind,
        rateBp: toBp(rate),
        categoryRateBp: catBp,
        retailRateBp: toBp(retail),
        hourlyRateCents: needsHourly ? Math.round(Number(hourly) * 100) : 0,
        base,
      }, membershipId);
      await onDone();
    } catch (e) {
      setErr(e instanceof ApiError ? `保存失败（${e.code}）` : '保存失败');
    } finally { setBusy(false); }
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(20,18,16,.45)',
      display: 'grid', placeItems: 'end center', zIndex: 55,
    }} onClick={onCancel}>
      <div className="card stack" onClick={(e) => e.stopPropagation()}
           style={{ width: 'min(620px,100%)', maxHeight: '92vh', overflow: 'auto',
                    padding: 24, gap: 16, borderRadius: '18px 18px 0 0' }}>
        <div style={{ fontSize: 'var(--text-xl)', fontWeight: 800 }}>{who.name} 的提成方案</div>

        {err && <div className="badge badge-danger" style={{ padding: '10px 14px' }}>✕ {err}</div>}

        <div className="stack" style={{ gap: 8 }}>
          {KINDS.map((k) => (
            <button key={k.v} className="btn" onClick={() => setKind(k.v)}
                    style={{
                      minHeight: 'var(--tap)', textAlign: 'left', borderWidth: 2,
                      borderColor: kind === k.v ? 'var(--brand)' : 'var(--line)',
                      background: kind === k.v ? 'var(--brand-soft)' : 'var(--surface)',
                    }}>
              <strong>{k.label}</strong> <span className="tiny">· {k.hint}</span>
            </button>
          ))}
        </div>

        <div className="row" style={{ gap: 12 }}>
          <label className="stack grow" style={{ gap: 6 }}>
            <span className="tiny">服务提成（%）</span>
            <input className="field field-mono" inputMode="decimal" value={rate}
                   placeholder="45" onChange={(e) => setRate(e.target.value)} />
          </label>
          {needsHourly && (
            <label className="stack grow" style={{ gap: 6 }}>
              <span className="tiny">时薪（美元）</span>
              <input className="field field-mono" inputMode="decimal" value={hourly}
                     placeholder="16.00" onChange={(e) => setHourly(e.target.value)} />
            </label>
          )}
          <label className="stack grow" style={{ gap: 6 }}>
            <span className="tiny">零售提成（%）</span>
            <input className="field field-mono" inputMode="decimal" value={retail}
                   placeholder="10" onChange={(e) => setRetail(e.target.value)} />
          </label>
        </div>

        {/*
          ⚠️ 这一问不给默认值。$100 的活打八折收 $80，提成按 100 还是按 80 算，
          差的是技师的钱 —— 这是真店里的头号争议。糊一个默认值过去，
          等于替老板做了一个他没意识到自己做过的决定，而技师会在第一次
          发工资时发现，然后来找他吵。
        */}
        <div className="card stack" style={{ padding: 14, gap: 10,
             background: base === null ? 'var(--warn-soft)' : 'var(--surface)',
             borderColor: base === null ? 'var(--warn)' : 'var(--line)' }}>
          <strong>打折的单，提成按哪个数算？</strong>
          <div className="tiny" style={{ lineHeight: 1.6 }}>
            $100 的活打八折收了 $80 —— 按 <strong>$80</strong> 给提成（折扣店里出），
            还是按 <strong>$100</strong>（折扣算店里让的，不影响技师）？
            <br />这一条最好开店时就跟技师说清楚。
          </div>
          <div className="row" style={{ gap: 10 }}>
            {([['net', '按折后（$80）'], ['gross', '按原价（$100）']] as const).map(([v, l]) => (
              <button key={v} className="btn grow" onClick={() => setBase(v)}
                      style={{
                        minHeight: 'var(--tap)', borderWidth: 2,
                        borderColor: base === v ? 'var(--brand)' : 'var(--line)',
                        background: base === v ? 'var(--brand-soft)' : 'var(--surface)',
                      }}>{l}</button>
            ))}
          </div>
        </div>

        {categories.length > 0 && (
          <div className="stack" style={{ gap: 8 }}>
            <button className="btn" style={{ minHeight: 40 }}
                    onClick={() => setShowCats((v) => !v)}>
              分类单独定提成（{Object.values(catRates).filter((v) => v.trim() !== '').length} 个）
              {showCats ? ' 收起' : ' 展开'}
            </button>
            {showCats && (
              <div className="stack" style={{ gap: 8 }}>
                <div className="tiny">留空 = 用上面的服务提成。蜡疗、贴片这类毛利高的常单独定。</div>
                {categories.map((c) => (
                  <label key={c.id} className="row" style={{ gap: 10 }}>
                    <span className="grow truncate tiny">{c.name}</span>
                    <input className="field field-mono" inputMode="decimal"
                           style={{ width: 90 }} placeholder={rate}
                           value={catRates[c.id] ?? ''}
                           onChange={(e) => setCatRates((o) => ({ ...o, [c.id]: e.target.value }))} />
                    <span className="tiny">%</span>
                  </label>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="row" style={{ gap: 10 }}>
          <button className="btn grow" style={{ minHeight: 'var(--tap)' }}
                  onClick={onCancel}>取消</button>
          <button className="btn btn-primary grow" disabled={busy || !ok}
                  style={{ minHeight: 'var(--tap)' }} onClick={() => void save()}>
            {busy ? <span className="spin" />
              : base === null ? '先回答上面那一问' : '保存（只影响以后的单）'}
          </button>
        </div>
      </div>
    </div>
  );
}
