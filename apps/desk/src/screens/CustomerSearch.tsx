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
import { Search, TriangleAlert, ChevronRight, Star, UserPlus } from 'lucide-react';
import { apiGet } from '../lib/api';
import { Button } from '../ui/Button';
import { Field } from '../ui/Field';
import { Card } from '../ui/Card';
import { Badge } from '../ui/Badge';
import { Page, PageHeader, Empty } from '../ui/Page';
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
    <Page className="mx-auto max-w-[760px]">
      <PageHeader
        title={t('cust.title')}
        sub={<span className="flex items-center gap-1.5">
          <kbd className="rounded-sm border border-line-2 bg-sunken px-1.5 py-0.5 font-mono text-2xs">/</kbd>
          回到搜索框
          <kbd className="ml-1.5 rounded-sm border border-line-2 bg-sunken px-1.5 py-0.5 font-mono text-2xs">Enter</kbd>
          搜索
        </span>}
      />

      <form className="flex items-center gap-3"
            onSubmit={(e) => { e.preventDefault(); setSubmitted(term); }}>
        <div className="relative flex-1">
          <Search size={17}
                  className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-3" />
          <Field
            ref={inputRef}
            mono
            className="pl-11"
            inputMode="tel"
            autoComplete="off"
            placeholder={t('cust.searchHint')}
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            aria-label={t('cust.searchHint')}
          />
        </div>
        <Button type="submit" variant="primary" disabled={term.trim().length < 2}>
          {q.isFetching ? '…' : t('cust.search')}
        </Button>
      </form>

      {/* ⚠️ 同号多人：颜色 + 图标 + 文字三重提示，不只靠颜色（宪法第 11 条） */}
      {samePhone && (
        <div role="status"
             className="mt-4 flex items-start gap-3 rounded-lg border border-warn bg-warn-soft p-4">
          <TriangleAlert size={22} className="mt-0.5 shrink-0 text-warn" />
          <div className="min-w-0 flex-1">
            <div className="text-lg font-extrabold text-warn">
              {t('cust.multiWarn', { n: hits.length })}
            </div>
            <div className="mt-0.5 text-xs text-warn">{t('cust.multiHelp')}</div>
          </div>
        </div>
      )}

      {q.isError && (
        <Card className="mt-4 flex items-center gap-3 border-danger p-4">
          <span className="flex-1 text-sm">{t('common.error')}</span>
          <Button size="sm" onClick={() => q.refetch()}>{t('common.retry')}</Button>
        </Card>
      )}

      <div className="mt-4 flex flex-col gap-2.5">
        {hits.map((c) => (
          // 整张卡可点 —— 看起来能点的区域和真的能点的区域必须一样大
          <Card key={c.id} asChild>
            <button type="button" onClick={() => onPick(c)}
                    className="flex min-h-[88px] w-full cursor-pointer items-center gap-4 px-5 py-3.5 text-left hoverable:hover:border-ink-3/40">
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="flex flex-wrap items-center gap-2.5">
                  <span className="text-xl font-bold tracking-[-0.02em]">{c.displayName}</span>
                  {c.noShowCount >= 2 && (
                    // 高亮但不阻断（00 §1.9）—— 由前台决定是否接待
                    <Badge tone="danger">{t('cust.noShow', { n: c.noShowCount })}</Badge>
                  )}
                  {c.tags.includes('vip') && <Badge tone="brand"><Star size={11} />VIP</Badge>}
                </div>
                <div className="flex flex-wrap items-center gap-3.5 text-xs text-ink-2">
                  <span className="tnum font-semibold">{prettyPhone(c.phoneE164)}</span>
                  <span>
                    {c.lastVisitOn
                      ? `${t('cust.lastVisit')} ${daysAgo(c.lastVisitOn)}${c.lastStaffName ? ` · ${c.lastStaffName}` : ''}`
                      : t('cust.never')}
                  </span>
                </div>
              </div>
              <Badge tone="mute">{t('cust.select')}<ChevronRight size={13} /></Badge>
            </button>
          </Card>
        ))}

        {submitted && !q.isFetching && hits.length === 0 && (
          <Empty icon={<Search size={30} />} title={t('cust.noResult')} />
        )}
      </div>

      {/* 新建 / 匿名 walk-in 永远在手边：找不到人时不该让前台卡住 */}
      {submitted.trim().length >= 2 && !q.isFetching && (
        <div className="mt-4 flex items-center gap-3">
          <Button variant="primary" className="flex-1" onClick={() => onPick(null)}>
            <UserPlus size={17} />{t('cust.new')}
          </Button>
          <Button className="flex-1" onClick={() => onPick(null)}>{t('cust.anonymous')}</Button>
        </div>
      )}
    </Page>
  );
}
