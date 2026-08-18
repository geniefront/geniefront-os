/**
 * 「订阅与余额」—— 老板一个人看的那一屏（决策 8 / 19）。
 *
 * 前台看不到这里：`billing.manage` 只在 owner 的预设里。历史营业报表
 * 都只给老板（决策 19 的极致隐私），账单更是。
 *
 * 这一屏要回答三个问题，页面就是这三块，顺序也是老板关心的顺序：
 *   1. **余额还剩多少** —— 打开这一屏九成是为了这个
 *   2. 这些钱花在哪了
 *   3. 套餐、卡、自动续充
 *
 * 卡号在这个文件里**一次都不出现**。绑卡是跳到 Stripe 托管的页面，
 * 回来时我们只拿到一句「Visa ···· 4242」。
 */

import { useState } from 'react';
import { API_BASE, ApiError, runCommand } from '../lib/api';
import { supabase } from '../lib/supabase';

/** 一种额度的完整状态。两种额度各一份，**互不相干**（决策 8） */
export interface QuotaData {
  unit: 'credit' | 'voice_minute';
  included: { used: number; total: number; remaining: number };
  /** 充值买来的余额（不过期）。**可以是负数** */
  balance: number;
  /** $50 能买多少个 */
  unitsPerTopup: number;
  autoTopup: {
    enabled: boolean; thresholdUnits: number; failures: number; lastAt: string | null;
  };
  usedThisMonth: number;
  ledgerBreakAt: number | null;
  balanceMismatch: { cached: number; ledger: number } | null;
}

export interface BillingData {
  plan: string;
  subscriptionStatus: string;
  currentPeriodEnd: string | null;
  hasSubscription: boolean;

  hasPaymentMethod: boolean;
  paymentMethodLabel: string | null;

  /** 一次充值多少钱（固定 $50） */
  topupPriceCents: number;

  /**
   * 两种额度各一份。
   *
   * ⚠️ **界面上必须分成两块**，不要合成一个「总额度」——
   * 一分钟电话的成本是一次副驾操作的 6.2 倍，合起来显示会让老板
   * 以为它们能互相顶用，而它们不能（决策 8）。
   */
  quotas: QuotaData[];

  recent: Array<{
    id: string; kind: string; unit: 'credit' | 'voice_minute';
    amount: number; balanceAfter: number; paidCents: number | null;
    source: string | null; reason: string | null; at: string;
  }>;
}

export interface BillingResponse {
  billing: BillingData | null;
  autoTopup: Array<{ unit: string; charged: boolean; units?: number; reason?: string }>;
}

/** 负数要带符号显示 —— 余额欠着的时候老板必须一眼看出来 */
const money = (c: number): string =>
  `${c < 0 ? '−' : ''}$${(Math.abs(c) / 100).toFixed(2)}`;

/** 每种额度的显示名与量词。前台那一屏全靠它，别在别处再写一遍 */
const UNIT_LABEL: Record<string, { name: string; unit: string; hint: string }> = {
  credit: {
    name: 'AI 积分', unit: '积分',
    hint: '副驾、拍照开店都用它。**关键词直接答的那些不算积分**。',
  },
  voice_minute: {
    name: 'AI 语音', unit: '分钟',
    hint: 'AI 接电话按分钟算，29 秒也算一分钟。',
  },
};

const SOURCE_LABEL: Record<string, string> = {
  desk_copilot: '前台副驾',
  price_list_vision: '拍照开店',
  ai_call_min: 'AI 电话',
  stripe: '充值',
};

const LEDGER_LABEL: Record<string, string> = {
  topup: '充值',
  usage: '用量',
  refund: '退款',
  adjustment: '人工调整',
  reversal: '冲销',
};

const PLAN_LABEL: Record<string, string> = { essential: 'Essential', growth: 'Growth' };

const STATUS_LABEL: Record<string, string> = {
  trialing: '试用中',
  active: '正常',
  past_due: '⚠️ 扣款失败',
  canceled: '已停用',
};

export function Billing({
  data, autoTopup, membershipId, onChanged,
}: {
  data: BillingData | null;
  autoTopup: BillingResponse['autoTopup'];
  membershipId: string;
  onChanged: () => Promise<unknown>;
}) {
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');

  /**
   * 计费的那几条不是命令，是编排路由（要调 Stripe，不能进数据库事务）。
   * 所以这里直接 fetch —— **这是宪法第 1 条唯一的例外形态**，
   * 而且它们背后每一次额度变动仍然是一条有审计的命令（见 stripe/routes.ts）。
   */
  async function post<T>(path: string, payload: unknown): Promise<T> {
    const { data: s } = await supabase.auth.getSession();
    const res = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${s.session?.access_token ?? ''}`,
        'Content-Type': 'application/json',
        'X-Membership-Id': membershipId,
      },
      body: JSON.stringify(payload),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(json.code ?? 'INTERNAL', json.details ?? {}, false, res.status);
    return json as T;
  }

  /** 跳去 Stripe 的托管页。卡号只在那边输入，我们这边从头到尾看不到 */
  async function toStripe(path: string, payload: unknown, label: string) {
    setBusy(label); setErr('');
    try {
      const out = await post<{ url: string | null }>(path, payload);
      if (out.url) window.location.href = out.url;
      else setErr('Stripe 没有返回付款页地址，请稍后再试');
    } catch (e) { setErr(describe(e)); } finally { setBusy(''); }
  }

  if (!data) {
    return (
      <div className="stack" style={{ padding: '0 16px 24px', gap: 14 }}>
        <div className="card stack" style={{ padding: 28, gap: 14, textAlign: 'center' }}>
          <div style={{ fontSize: 'var(--text-xl)' }}>还没有开通订阅</div>
          <div className="muted">开通之后这里会显示额度、用量和账单。</div>
          <button className="btn btn-primary" style={{ minHeight: 56 }} disabled={busy !== ''}
                  onClick={() => toStripe('/v1/billing/checkout', { plan: 'essential' }, 'checkout')}>
            {busy === 'checkout' ? <span className="spin" /> : '开通 Essential'}
          </button>
        </div>
      </div>
    );
  }

  const charged = autoTopup.filter((t) => t.charged);

  return (
    <div className="stack" style={{ padding: '0 16px 24px', gap: 14 }}>
      {err && <div className="badge badge-danger" style={{ padding: '10px 14px' }}>✕ {err}</div>}

      {/* 刚刚自动续充过 —— 老板打开页面会看到额度突然变多，得有个交代 */}
      {charged.map((t) => (
        <div key={t.unit} className="badge badge-ok" style={{ padding: '10px 14px' }}>
          ✓ 刚刚自动充了 {t.units} {UNIT_LABEL[t.unit]?.unit ?? ''}（{money(data.topupPriceCents)}）
        </div>
      ))}

      {/*
        ⭐ 两种额度**分成两块**，绝不合成一个「总额度」。
        一分钟电话的成本是一次副驾操作的 6.2 倍 —— 合起来显示会让老板
        以为它们能互相顶用，而它们不能（决策 8）。
      */}
      {data.quotas.map((q) => (
        <QuotaCard key={q.unit} q={q} data={data} membershipId={membershipId}
                   busy={busy} setBusy={setBusy} onError={setErr}
                   onChanged={onChanged} post={post} />
      ))}

      {/* ── 套餐与支付方式 ─────────────────────────────────────────────── */}
      <div className="card stack" style={{ padding: '18px 20px', gap: 12 }}>
        <div className="row" style={{ gap: 10 }}>
          <strong className="grow">套餐</strong>
          <span className="badge badge-soft">{PLAN_LABEL[data.plan] ?? data.plan}</span>
          <span className={`badge ${data.subscriptionStatus === 'active'
            || data.subscriptionStatus === 'trialing' ? 'badge-ok' : 'badge-danger'}`}>
            {STATUS_LABEL[data.subscriptionStatus] ?? data.subscriptionStatus}
          </span>
        </div>

        {data.currentPeriodEnd && (
          <div className="tiny muted">
            下次扣费与额度重置：{new Date(data.currentPeriodEnd).toLocaleDateString()}
          </div>
        )}

        <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
          {(['essential', 'growth'] as const).map((p) => (
            <button key={p} className="btn" style={{ minHeight: 56 }} disabled={busy !== ''}
                    onClick={() => toStripe('/v1/billing/checkout', { plan: p }, `plan-${p}`)}>
              {busy === `plan-${p}` ? <span className="spin" />
                : data.hasSubscription && data.plan === p ? `${PLAN_LABEL[p]}（当前）`
                : `换成 ${PLAN_LABEL[p]}`}
            </button>
          ))}
        </div>

        <div className="row" style={{ gap: 10 }}>
          <span className="grow">支付方式：{data.paymentMethodLabel ?? '未绑定'}</span>
          <button className="btn" style={{ minHeight: 56 }} disabled={busy !== ''}
                  onClick={() => toStripe('/v1/billing/payment-method', {}, 'pm')}>
            {busy === 'pm' ? <span className="spin" />
              : data.hasPaymentMethod ? '换一张卡' : '绑一张卡'}
          </button>
        </div>
        <div className="tiny muted">
          卡号在 Stripe 的页面上输入，我们这边只存「哪张卡」，看不到卡号。
        </div>
      </div>

      {/* ── 流水 ───────────────────────────────────────────────────────── */}
      <div className="card stack" style={{ padding: '18px 20px', gap: 8 }}>
        <strong>最近的账目</strong>
        {data.recent.length === 0 ? (
          <div className="muted tiny">还没有任何账目。</div>
        ) : (
          <div className="stack" style={{ gap: 6, maxHeight: 360, overflowY: 'auto' }}>
            {data.recent.map((r) => {
              const u = UNIT_LABEL[r.unit];
              return (
                <div key={r.id} className="row" style={{ gap: 10, fontSize: 'var(--text-sm)' }}>
                  <span className="tiny muted" style={{ minWidth: 92 }}>
                    {new Date(r.at).toLocaleDateString()}{' '}
                    {new Date(r.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                  <span className="grow truncate">
                    {LEDGER_LABEL[r.kind] ?? r.kind}
                    {r.source ? ` · ${SOURCE_LABEL[r.source] ?? r.source}` : ''}
                    {r.reason ? ` · ${r.reason}` : ''}
                    {r.paidCents ? `（${money(r.paidCents)}）` : ''}
                  </span>
                  <span style={{
                    fontVariantNumeric: 'tabular-nums', minWidth: 92, textAlign: 'right',
                    color: r.amount > 0 ? 'var(--ok, green)' : undefined }}>
                    {r.amount > 0 ? '+' : ''}{r.amount} {u?.unit ?? ''}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 一种额度的卡片：套餐内进度条 + 充值余额 + 买 + 自动续充。
 *
 * ⭐ **套餐内额度排在最上面**：老板打开这一屏最先要知道的是
 * 「我这个月还够不够用」，而不是「我买的还剩多少」。
 * 买的那部分是套餐用完之后的事。
 */
function QuotaCard({
  q, data, membershipId, busy, setBusy, onError, onChanged, post,
}: {
  q: QuotaData;
  data: BillingData;
  membershipId: string;
  busy: string;
  setBusy: (v: string) => void;
  onError: (m: string) => void;
  onChanged: () => Promise<unknown>;
  post: <T>(path: string, payload: unknown) => Promise<T>;
}) {
  const [threshold, setThreshold] = useState(q.autoTopup.thresholdUnits);
  const [enabled, setEnabled] = useState(q.autoTopup.enabled);
  const label = UNIT_LABEL[q.unit]!;
  const pct = Math.min(100, (q.included.used / Math.max(1, q.included.total)) * 100);
  const dirty = enabled !== q.autoTopup.enabled || threshold !== q.autoTopup.thresholdUnits;
  const key = `topup-${q.unit}`;

  return (
    <div className="card stack" style={{ padding: '18px 20px', gap: 12 }}>
      <div className="row" style={{ gap: 10 }}>
        <strong className="grow" style={{ fontSize: 'var(--text-lg)' }}>{label.name}</strong>
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>
          本期还剩 <strong>{q.included.remaining}</strong> / {q.included.total} {label.unit}
        </span>
      </div>

      <div style={{ height: 10, borderRadius: 5, background: 'var(--line)', overflow: 'hidden' }}>
        <div style={{
          height: '100%', width: `${pct}%`,
          background: q.included.remaining === 0 ? 'var(--danger)' : 'var(--brand)' }} />
      </div>

      {/*
        ⭐ 账实不符要**显红并且说清楚**，不能悄悄按缓存显示。
        账本是事实，缓存对不上是事故 —— 老板要知道这个数现在不可信。
      */}
      {(q.balanceMismatch || q.ledgerBreakAt !== null) && (
        <div className="badge badge-danger" style={{ padding: '10px 14px' }}>
          ⚠️ 这个数字对账不一致，暂时不可信
          {q.balanceMismatch && `（显示 ${q.balanceMismatch.cached}，按流水算是 ${q.balanceMismatch.ledger}）`}
          。请联系我们，先别据此充值。
        </div>
      )}

      <div className="row" style={{ gap: 10 }}>
        <span className="muted grow">
          买的余额（不过期）
        </span>
        <strong style={{
          fontVariantNumeric: 'tabular-nums',
          color: q.balance < 0 ? 'var(--danger)' : undefined }}>
          {q.balance} {label.unit}
        </strong>
      </div>

      {q.balance < 0 && (
        <div className="tiny">
          欠着 {-q.balance} {label.unit}：已经用掉的部分先记在账上，下次充值自动补齐。
        </div>
      )}

      <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
        <button className="btn btn-primary" style={{ minHeight: 56, minWidth: 180 }}
                disabled={busy !== '' || !data.hasPaymentMethod}
                title={data.hasPaymentMethod ? undefined : '先绑一张卡'}
                onClick={async () => {
                  setBusy(key); onError('');
                  try {
                    const out = await post<{ ok: boolean; pending?: boolean }>(
                      '/v1/billing/topup', { unit: q.unit });
                    if (out.pending) onError('这笔扣款还要在银行那边确认一下，稍后刷新看看');
                    await onChanged();
                  } catch (e) { onError(describe(e)); }
                  finally { setBusy(''); }
                }}>
          {busy === key ? <span className="spin" />
            : `${money(data.topupPriceCents)} 买 ${q.unitsPerTopup} ${label.unit}`}
        </button>
        <span className="tiny muted" style={{ alignSelf: 'center' }}>
          本月已用 {q.usedThisMonth} {label.unit}
        </span>
      </div>

      <div className="tiny muted">{label.hint}</div>
      {!data.hasPaymentMethod && (
        <div className="tiny">要先绑一张卡才能充值。卡号只在 Stripe 的页面上输入。</div>
      )}

      {/* ── 自动续充 ─────────────────────────────────────────────────── */}
      <div className="row" style={{ gap: 10, borderTop: '1px solid var(--line)', paddingTop: 12 }}>
        <span className="grow">不够时自动买</span>
        <button className="btn" style={{ minHeight: 56, minWidth: 92 }}
                aria-pressed={enabled} onClick={() => setEnabled(!enabled)}>
          {enabled ? '✓ 开着' : '关着'}
        </button>
      </div>

      {/*
        ⚠️ 连续失败被自动关掉之后要**说清楚为什么**。
        只显示一个「关着」的开关，老板会以为是自己关的，
        然后打开、再失败、再被关 —— 而那几次失败都记在他的卡上
      */}
      {q.autoTopup.failures > 0 && (
        <div className="badge badge-danger" style={{ padding: '10px 14px' }}>
          最近有 {q.autoTopup.failures} 次扣款没成功
          {!q.autoTopup.enabled && '，已暂停'}。建议换一张卡再打开。
        </div>
      )}

      {enabled && (
        <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
          <span style={{ minWidth: 110 }}>低于</span>
          {(q.unit === 'credit' ? [20, 50, 100, 200] : [10, 20, 50, 100]).map((t) => (
            <button key={t} className="btn" style={{
              minHeight: 56, minWidth: 76, borderWidth: 2,
              borderColor: threshold === t ? 'var(--brand)' : 'var(--line)',
              background: threshold === t ? 'var(--brand-soft)' : 'var(--surface)' }}
              onClick={() => setThreshold(t)}>{t}</button>
          ))}
          <span className="tiny muted" style={{ alignSelf: 'center' }}>
            {label.unit}时自动买 {q.unitsPerTopup} 个
          </span>
        </div>
      )}

      {dirty && (
        <button className="btn btn-primary" style={{ minHeight: 56 }} disabled={busy !== ''}
                onClick={async () => {
                  setBusy(`auto-${q.unit}`); onError('');
                  try {
                    await runCommand('billing.setAutoTopup', {
                      unit: q.unit, enabled, thresholdUnits: threshold,
                    }, membershipId);
                    await onChanged();
                  } catch (e) { onError(describe(e)); }
                  finally { setBusy(''); }
                }}>
          {busy === `auto-${q.unit}` ? <span className="spin" /> : '保存'}
        </button>
      )}
    </div>
  );
}

/** 把后端的错误码翻成老板看得懂的一句话 */
function describe(e: unknown): string {
  if (!(e instanceof ApiError)) return '操作失败，请稍后再试';
  if (e.code === 'UPSTREAM_UNAVAILABLE') {
    const reason = String(e.details['reason'] ?? '');
    // Stripe 的 decline_code 是老板最需要的那个信息：
    // 「余额不足」和「卡被银行拦了」要打的电话不是同一个
    if (reason === 'insufficient_funds') return '这张卡余额不足';
    if (reason === 'card_declined') return '这张卡被拒了，换一张试试';
    if (reason === 'expired_card') return '这张卡已过期';
    if (reason === 'authentication_required') return '银行要求验证，请换一张卡或联系发卡行';
    if (reason.includes('未配置')) return '计费还没配置好，请联系我们';
    return `扣款没成功（${reason}）`;
  }
  if (e.code === 'VALIDATION_FAILED' && e.details['reason'] === 'no_payment_method') {
    return '还没绑卡';
  }
  if (e.code === 'PERMISSION_DENIED') return '只有老板能看和改账单';
  return `操作失败（${e.code}）`;
}
