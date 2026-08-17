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

export interface BillingData {
  plan: string;
  subscriptionStatus: string;
  currentPeriodEnd: string | null;
  hasSubscription: boolean;

  balanceCents: number;
  hasPaymentMethod: boolean;
  paymentMethodLabel: string | null;

  autoTopup: {
    enabled: boolean;
    thresholdCents: number;
    amountCents: number;
    failures: number;
    lastAt: string | null;
  };

  /** 套餐内额度：先用套餐里的，用完了才扣余额 */
  included: { used: number; total: number; remaining: number };
  monthToDate: Array<{ kind: string; qty: number; chargedCents: number }>;
  recent: Array<{
    id: string; kind: string; amountCents: number; balanceAfterCents: number;
    source: string | null; reason: string | null; at: string;
  }>;
  ledgerBreakAt: number | null;
  balanceMismatch: { cachedCents: number; ledgerCents: number } | null;
}

export interface BillingResponse {
  billing: BillingData | null;
  autoTopup: { charged: boolean; amountCents?: number; reason?: string };
}

/** 负数要带符号显示 —— 余额欠着的时候老板必须一眼看出来 */
const money = (c: number): string =>
  `${c < 0 ? '−' : ''}$${(Math.abs(c) / 100).toFixed(2)}`;

/**
 * 手动充值三档。⚠️ 卖的是**钱不是分钟数** —— Telnyx 单价还没实测，
 * 承诺「$100 = 200 分钟」等于在成本量出来之前锁死毛利，而改口比改价难十倍。
 */
const TOPUP_TIERS = [2000, 5000, 10000] as const;

/** 自动续充只给大额两档：$20 那一档做自动续充，忙店一个月要被扣 1.5 次 */
const AUTO_TOPUP_TIERS = [5000, 10000] as const;

const KIND_LABEL: Record<string, string> = {
  ai_assist: '前台副驾 / 拍照开店',
  ai_call_min: 'AI 电话（分钟）',
  sms: '短信',
  email: '邮件',
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
   * 而且它们背后每一次余额变动仍然是一条有审计的命令（见 stripe/routes.ts）。
   */
  async function post<T>(path: string, body: unknown): Promise<T> {
    const { data: s } = await supabase.auth.getSession();
    const res = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${s.session?.access_token ?? ''}`,
        'Content-Type': 'application/json',
        'X-Membership-Id': membershipId,
      },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(json.code ?? 'INTERNAL', json.details ?? {}, false, res.status);
    return json as T;
  }

  /** 跳去 Stripe 的托管页。卡号只在那边输入，我们这边从头到尾看不到 */
  async function toStripe(path: string, body: unknown, label: string) {
    setBusy(label); setErr('');
    try {
      const out = await post<{ url: string | null }>(path, body);
      if (out.url) window.location.href = out.url;
      else setErr('Stripe 没有返回付款页地址，请稍后再试');
    } catch (e) {
      setErr(describe(e));
    } finally { setBusy(''); }
  }

  if (!data) {
    return (
      <div className="stack" style={{ padding: '0 16px 24px', gap: 14 }}>
        <div className="card stack" style={{ padding: 28, gap: 14, textAlign: 'center' }}>
          <div style={{ fontSize: 'var(--text-xl)' }}>还没有开通订阅</div>
          <div className="muted">开通之后这里会显示余额、用量和账单。</div>
          <button className="btn btn-primary" style={{ minHeight: 56 }}
                  disabled={busy !== ''}
                  onClick={() => toStripe('/v1/billing/checkout', { plan: 'essential' }, 'checkout')}>
            {busy === 'checkout' ? <span className="spin" /> : '开通 Essential'}
          </button>
        </div>
      </div>
    );
  }

  const lowBalance = data.balanceCents < data.autoTopup.thresholdCents;

  return (
    <div className="stack" style={{ padding: '0 16px 24px', gap: 14 }}>
      {err && <div className="badge badge-danger" style={{ padding: '10px 14px' }}>✕ {err}</div>}

      {/*
        ⭐ 账实不符要**显红并且说清楚**，不能悄悄按缓存显示。
        账本是事实，缓存对不上是事故 —— 老板要知道这个数现在不可信。
      */}
      {(data.balanceMismatch || data.ledgerBreakAt !== null) && (
        <div className="card stack" style={{
          padding: '14px 18px', gap: 6,
          borderColor: 'var(--danger)', borderWidth: 2 }}>
          <strong>⚠️ 余额对账不一致，这个数字暂时不可信</strong>
          <div className="tiny">
            {data.balanceMismatch && (
              <>显示的是 {money(data.balanceMismatch.cachedCents)}，
                按流水算出来是 {money(data.balanceMismatch.ledgerCents)}。</>
            )}
            {data.ledgerBreakAt !== null && <>流水第 {data.ledgerBreakAt + 1} 条起接不上。</>}
            {' '}请联系我们，先别据此充值。
          </div>
        </div>
      )}

      {/* 刚刚自动续充过 —— 老板打开页面时会看到余额突然变多，得有个交代 */}
      {autoTopup.charged && (
        <div className="badge badge-ok" style={{ padding: '10px 14px' }}>
          ✓ 刚刚自动续充了 {money(autoTopup.amountCents ?? 0)}
        </div>
      )}

      {/* ── 1. 套餐内额度 + 余额 ───────────────────────────────────────── */}
      {/*
        ⭐ 额度排在余额**前面**：老板打开这一屏最先要知道的是
        「我这个月的额度还够不够」，而不是「我还有多少钱」。
        钱是额度用完之后的事。
      */}
      <div className="card stack" style={{ padding: '18px 20px', gap: 10 }}>
        <div className="row" style={{ gap: 12 }}>
          <span className="muted">本期套餐内还剩</span>
          <span className="grow" />
          <strong style={{ fontSize: 'var(--text-xl)', fontVariantNumeric: 'tabular-nums' }}>
            {data.included.remaining} / {data.included.total} 次
          </strong>
        </div>
        <div style={{ height: 10, borderRadius: 5, background: 'var(--line)', overflow: 'hidden' }}>
          <div style={{
            height: '100%',
            width: `${Math.min(100, (data.included.used / Math.max(1, data.included.total)) * 100)}%`,
            background: data.included.remaining === 0 ? 'var(--danger)' : 'var(--brand)',
          }} />
        </div>
        <div className="tiny muted">
          {data.included.remaining > 0
            ? '先用套餐里的，用完了才从下面的余额扣。'
            : '套餐内额度已用完，现在从余额扣。'}
          {data.currentPeriodEnd && ` 下次重置：${new Date(data.currentPeriodEnd).toLocaleDateString()}`}
        </div>
      </div>

      <div className="card stack" style={{ padding: '18px 20px', gap: 14 }}>
        <div className="row" style={{ gap: 12 }}>
          <span className="muted">预充值余额</span>
          <span className="grow" />
          <strong style={{
            fontSize: 'var(--text-2xl, 28px)', fontVariantNumeric: 'tabular-nums',
            color: data.balanceCents < 0 ? 'var(--danger)' : undefined }}>
            {money(data.balanceCents)}
          </strong>
        </div>

        {data.balanceCents < 0 && (
          <div className="tiny">
            余额是负的：AI 已经用掉的部分先记在账上，下次充值会自动补齐。
          </div>
        )}
        {data.balanceCents >= 0 && lowBalance && !data.autoTopup.enabled && (
          <div className="tiny">
            余额低于 {money(data.autoTopup.thresholdCents)}。打开自动续充可以避免半夜断服务。
          </div>
        )}

        <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
          {TOPUP_TIERS.map((t) => (
            <button key={t} className="btn" style={{ minHeight: 56, minWidth: 110 }}
                    disabled={busy !== '' || !data.hasPaymentMethod}
                    title={data.hasPaymentMethod ? undefined : '先绑一张卡'}
                    onClick={async () => {
                      setBusy(`topup-${t}`); setErr('');
                      try {
                        const out = await post<{ ok: boolean; pending?: boolean }>(
                          '/v1/billing/topup', { amountCents: t });
                        if (out.pending) setErr('这笔扣款还要在银行那边确认一下，稍后刷新看看');
                        await onChanged();
                      } catch (e) { setErr(describe(e)); }
                      finally { setBusy(''); }
                    }}>
              {busy === `topup-${t}` ? <span className="spin" /> : `充 ${money(t)}`}
            </button>
          ))}
        </div>

        <div className="tiny muted">
          充进来的钱不会过期，用不完一直留着。副驾和 AI 电话共用这一个余额 ——
          按实际用量扣，不用猜自己要买哪种包。
        </div>
        {!data.hasPaymentMethod && (
          <div className="tiny">要先绑一张卡才能充值。卡号只在 Stripe 的页面上输入。</div>
        )}
      </div>

      {/* ── 2. 这个月花在哪了 ───────────────────────────────────────────── */}
      <div className="card stack" style={{ padding: '18px 20px', gap: 10 }}>
        <strong>这个月用了多少</strong>
        {data.monthToDate.length === 0 ? (
          <div className="muted tiny">这个月还没有用量。</div>
        ) : data.monthToDate.map((u) => (
          <div key={u.kind} className="row" style={{ gap: 10 }}>
            <span className="grow">{KIND_LABEL[u.kind] ?? u.kind}</span>
            <span className="tiny muted">{u.qty.toLocaleString()}</span>
            <span style={{ fontVariantNumeric: 'tabular-nums', minWidth: 80, textAlign: 'right' }}>
              {money(u.chargedCents)}
            </span>
          </div>
        ))}
        {/* AI 电话的单价还没实测（09 §6），这时候显示 $0.00 会让人以为是免费的 */}
        {data.monthToDate.some((u) => u.kind === 'ai_call_min' && u.chargedCents === 0) && (
          <div className="tiny muted">AI 电话的分钟单价还在核价，暂未计费。</div>
        )}
      </div>

      {/* ── 3. 自动续充 ─────────────────────────────────────────────────── */}
      <AutoTopupPane data={data} membershipId={membershipId}
                     onChanged={onChanged} onError={setErr} />

      {/* ── 4. 套餐与支付方式 ───────────────────────────────────────────── */}
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
            下次扣费：{new Date(data.currentPeriodEnd).toLocaleDateString()}
          </div>
        )}

        <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
          {(['essential', 'growth'] as const).map((p) => (
            <button key={p} className="btn" style={{ minHeight: 56 }}
                    disabled={busy !== ''}
                    onClick={() => toStripe('/v1/billing/checkout', { plan: p }, `plan-${p}`)}>
              {busy === `plan-${p}` ? <span className="spin" />
                : data.hasSubscription && data.plan === p ? `${PLAN_LABEL[p]}（当前）`
                : `换成 ${PLAN_LABEL[p]}`}
            </button>
          ))}
        </div>

        <div className="row" style={{ gap: 10 }}>
          <span className="grow">
            支付方式：{data.paymentMethodLabel ?? '未绑定'}
          </span>
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

      {/* ── 5. 流水 ─────────────────────────────────────────────────────── */}
      <div className="card stack" style={{ padding: '18px 20px', gap: 8 }}>
        <strong>最近的账目</strong>
        {data.recent.length === 0 ? (
          <div className="muted tiny">还没有任何账目。</div>
        ) : (
          <div className="stack" style={{ gap: 6, maxHeight: 380, overflowY: 'auto' }}>
            {data.recent.map((r) => (
              <div key={r.id} className="row" style={{ gap: 10, fontSize: 'var(--text-sm)' }}>
                <span className="tiny muted" style={{ minWidth: 96 }}>
                  {new Date(r.at).toLocaleDateString()}{' '}
                  {new Date(r.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
                <span className="grow truncate">
                  {LEDGER_LABEL[r.kind] ?? r.kind}
                  {r.source && r.kind === 'usage' ? ` · ${KIND_LABEL[r.source] ?? r.source}` : ''}
                  {r.reason ? ` · ${r.reason}` : ''}
                </span>
                <span style={{
                  fontVariantNumeric: 'tabular-nums', minWidth: 84, textAlign: 'right',
                  color: r.amountCents < 0 ? undefined : 'var(--ok, green)' }}>
                  {r.amountCents > 0 ? '+' : ''}{money(r.amountCents)}
                </span>
                <span className="tiny muted"
                      style={{ fontVariantNumeric: 'tabular-nums', minWidth: 72,
                               textAlign: 'right' }}>
                  {money(r.balanceAfterCents)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 自动续充的设置块。
 *
 * 档位写死（自动续充 $50 / $100）—— 让客户填任意金额会引来拿被盗的卡
 * 试活的人，DB 那边也有 check 约束兜着。
 */
function AutoTopupPane({ data, membershipId, onChanged, onError }: {
  data: BillingData;
  membershipId: string;
  onChanged: () => Promise<unknown>;
  onError: (m: string) => void;
}) {
  const [enabled, setEnabled] = useState(data.autoTopup.enabled);
  const [threshold, setThreshold] = useState(data.autoTopup.thresholdCents);
  const [amount, setAmount] = useState<number>(data.autoTopup.amountCents);
  const [busy, setBusy] = useState(false);

  const dirty = enabled !== data.autoTopup.enabled
    || threshold !== data.autoTopup.thresholdCents
    || amount !== data.autoTopup.amountCents;

  return (
    <div className="card stack" style={{ padding: '18px 20px', gap: 12 }}>
      <div className="row" style={{ gap: 10 }}>
        <strong className="grow">余额不够时自动充值</strong>
        <button className="btn" style={{ minHeight: 56, minWidth: 92 }}
                onClick={() => setEnabled(!enabled)}
                aria-pressed={enabled}>
          {enabled ? '✓ 开着' : '关着'}
        </button>
      </div>

      {/*
        ⚠️ 连续失败被自动关掉之后要**说清楚为什么**。
        只显示一个「关着」的开关，老板会以为是自己关的，
        然后打开、再失败、再被关 —— 而那几次失败都记在他的卡上
      */}
      {data.autoTopup.failures > 0 && (
        <div className="badge badge-danger" style={{ padding: '10px 14px' }}>
          最近有 {data.autoTopup.failures} 次扣款没成功
          {!data.autoTopup.enabled && '，自动续充已暂停'}。
          建议换一张卡再打开。
        </div>
      )}

      {enabled && (
        <>
          <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
            <span style={{ minWidth: 96 }}>余额低于</span>
            {[500, 1000, 2000, 5000].map((t) => (
              <button key={t} className="btn" style={{
                minHeight: 56, minWidth: 84, borderWidth: 2,
                borderColor: threshold === t ? 'var(--brand)' : 'var(--line)',
                background: threshold === t ? 'var(--brand-soft)' : 'var(--surface)' }}
                onClick={() => setThreshold(t)}>{money(t)}</button>
            ))}
          </div>

          {/*
            ⚠️ 自动续充**只给 $50 / $100**，没有 $20 那一档。
            $20 是留给「第一次买，先试试水」的 —— 拿它做自动续充，
            一家忙店一个月要被扣 1.5 次，而自动续充要的恰恰是别让人注意到它。
          */}
          <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
            <span style={{ minWidth: 96 }}>每次充</span>
            {AUTO_TOPUP_TIERS.map((t) => (
              <button key={t} className="btn" style={{
                minHeight: 56, minWidth: 84, borderWidth: 2,
                borderColor: amount === t ? 'var(--brand)' : 'var(--line)',
                background: amount === t ? 'var(--brand-soft)' : 'var(--surface)' }}
                onClick={() => setAmount(t)}>{money(t)}</button>
            ))}
          </div>
          <div className="tiny muted">
            自动续充不给 $20 那一档：太小的话一个月要扣好几次。
          </div>

          {!data.hasPaymentMethod && (
            <div className="tiny">⚠️ 还没绑卡，打开了也充不上。</div>
          )}
        </>
      )}

      {dirty && (
        <button className="btn btn-primary" style={{ minHeight: 56 }} disabled={busy}
                onClick={async () => {
                  setBusy(true); onError('');
                  try {
                    await runCommand('billing.setAutoTopup', {
                      enabled, thresholdCents: threshold, amountCents: amount,
                    }, membershipId);
                    await onChanged();
                  } catch (e) { onError(describe(e)); }
                  finally { setBusy(false); }
                }}>
          {busy ? <span className="spin" /> : '保存'}
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
