/**
 * 找客人 —— 前台每天用得最多的一屏。
 *
 * 这一屏承载了两条决策：
 *   决策 21：手机号不是唯一键。夫妻/母女共号很普遍，同号多客户必须走选择器，
 *            **默认不自动匹配第一个** —— 匹配错会把偏好、过敏、上次样式挂到别人头上。
 *   决策 18：Desk 端键盘可完成高频操作，与大按钮双轨并存。
 */

import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../lib/api';
import type { makeT } from '../i18n';

export interface CustomerHit {
  id: string;
  displayName: string;
  phoneE164: string | null;
  lastVisitOn: string | null;
  lastStaffName: string | null;
  noShowCount: number;
  tags: string[];
}

/** 手机号显示成 917-555-0142，逐位核对时不容易看错 */
function prettyPhone(e164: string | null): string {
  if (!e164) return '—';
  const d = e164.replace(/\D/g, '').replace(/^1/, '');
  return d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : e164;
}

function daysAgo(iso: string | null): string | null {
  if (!iso) return null;
  const n = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (n <= 0) return '今天';
  if (n === 1) return '昨天';
  if (n < 30) return `${n} 天前`;
  if (n < 365) return `${Math.floor(n / 30)} 个月前`;
  return `${Math.floor(n / 365)} 年前`;
}

export function CustomerSearch({
  membershipId, t, onPick, onApiError,
}: {
  membershipId: string;
  t: ReturnType<typeof makeT>;
  onPick: (c: CustomerHit | null) => void;
  /** 返回 true 表示这个错误已被上层接管（例如身份失效已跳回选店器） */
  onApiError?: (e: unknown) => boolean;
}) {
  const [term, setTerm] = useState('');
  const [submitted, setSubmitted] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // 决策 18：进屏就聚焦，前台不用先摸鼠标。/ 键随时回到搜索框
  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '/' && document.activeElement !== inputRef.current) {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const q = useQuery({
    queryKey: ['customers', membershipId, submitted],
    enabled: submitted.trim().length >= 2,
    queryFn: () =>
      apiGet<{ customers: CustomerHit[] }>(
        `/v1/customers/search?q=${encodeURIComponent(submitted.trim())}`, membershipId),
  });

  useEffect(() => { if (q.error) onApiError?.(q.error); }, [q.error, onApiError]);

  const hits = q.data?.customers ?? [];
  // 同号多人：这是要高亮提示的情况，不是边缘案例
  const samePhone = hits.length > 1
    && hits[0]?.phoneE164
    && hits.every((h) => h.phoneE164 === hits[0]!.phoneE164);

  return (
    <div className="stack" style={{ maxWidth: 760, margin: '0 auto', padding: '20px 16px 40px' }}>
      <h1 style={{ fontSize: 'var(--text-2xl)', margin: '4px 0 0' }}>{t('cust.title')}</h1>

      <form
        className="row"
        onSubmit={(e) => { e.preventDefault(); setSubmitted(term); }}
      >
        <input
          ref={inputRef}
          className="field field-mono grow"
          inputMode="tel"
          autoComplete="off"
          placeholder={t('cust.searchHint')}
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          aria-label={t('cust.searchHint')}
        />
        <button className="btn btn-primary" type="submit" disabled={term.trim().length < 2}>
          {q.isFetching ? <span className="spin" /> : t('cust.search')}
        </button>
      </form>

      <div className="tiny row" style={{ gap: 8, marginTop: -4 }}>
        <kbd>/</kbd> 回到搜索框 · <kbd>Enter</kbd> 搜索
      </div>

      {/* ⚠️ 同号多人：颜色 + 图标 + 文字三重提示，不只靠颜色 */}
      {samePhone && (
        <div
          className="card"
          style={{ background: 'var(--warn-soft)', borderColor: 'var(--warn)', padding: 16 }}
          role="status"
        >
          <div className="row" style={{ alignItems: 'flex-start', gap: 12 }}>
            <span aria-hidden style={{ fontSize: 26, lineHeight: 1 }}>⚠️</span>
            <div className="grow">
              <div style={{ fontWeight: 800, color: 'var(--warn)', fontSize: 'var(--text-lg)' }}>
                {t('cust.multiWarn', { n: hits.length })}
              </div>
              <div className="tiny" style={{ color: 'var(--warn)', marginTop: 2 }}>
                {t('cust.multiHelp')}
              </div>
            </div>
          </div>
        </div>
      )}

      {q.isError && (
        <div className="card" style={{ padding: 16, borderColor: 'var(--danger)' }}>
          <div className="row">
            <span className="grow">{t('common.error')}</span>
            <button className="btn" onClick={() => q.refetch()}>{t('common.retry')}</button>
          </div>
        </div>
      )}

      <div className="stack">
        {hits.map((c) => (
          <button
            key={c.id}
            className="card row"
            onClick={() => onPick(c)}
            style={{
              minHeight: 88, padding: '14px 18px', textAlign: 'left',
              cursor: 'pointer', border: '1px solid var(--line)', gap: 16,
            }}
          >
            <div className="grow stack" style={{ gap: 4 }}>
              <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 'var(--text-xl)', fontWeight: 700 }}>{c.displayName}</span>
                {c.noShowCount >= 2 && (
                  // 高亮但不阻断（00 §1.9）——由前台决定是否接待
                  <span className="badge badge-danger">🔴 {t('cust.noShow', { n: c.noShowCount })}</span>
                )}
                {c.tags.includes('vip') && <span className="badge badge-soft">★ VIP</span>}
              </div>
              <div className="row muted" style={{ gap: 14, fontSize: 'var(--text-sm)' }}>
                <span className="field-mono" style={{ fontWeight: 600 }}>{prettyPhone(c.phoneE164)}</span>
                <span>
                  {c.lastVisitOn
                    ? `${t('cust.lastVisit')} ${daysAgo(c.lastVisitOn)}${c.lastStaffName ? ` · ${c.lastStaffName}` : ''}`
                    : t('cust.never')}
                </span>
              </div>
            </div>
            <span className="badge badge-mute">{t('cust.select')} ›</span>
          </button>
        ))}

        {submitted && !q.isFetching && hits.length === 0 && (
          <div className="card" style={{ padding: 20, textAlign: 'center' }}>
            <div className="muted">{t('cust.noResult')}</div>
          </div>
        )}
      </div>

      {/* 新建 / 匿名 walk-in 永远在手边：找不到人时不该让前台卡住 */}
      {submitted.trim().length >= 2 && !q.isFetching && (
        <div className="row" style={{ gap: 12 }}>
          <button className="btn btn-primary grow" onClick={() => onPick(null)}>
            ＋ {t('cust.new')}
          </button>
          <button className="btn grow" onClick={() => onPick(null)}>
            {t('cust.anonymous')}
          </button>
        </div>
      )}
    </div>
  );
}
