/**
 * Yelp 一键填店信息（05-AI-INTEGRATION §4.1）
 *
 * 老板输**两个字段**——店名和邮编——就能把店建起来。这是开店向导里
 * 最省事的一条路，也是他最容易相信的一条（看到自己店的名字和评分出现在屏幕上）。
 *
 * 两个刻意的设计：
 *
 * 1. **命中多家一定让他点一家**，带地址和评价数（决策的同一条精神：
 *    同一条街上两家「Lucky Nails」在美国太常见，替他挑第一个
 *    就等于把别人家的信息填进他的店）。
 * 2. **逐项勾选，不是一键覆盖**。他可能只想要营业时间 ——
 *    店名早就自己起好了，被 Yelp 上八年没改的旧名字盖掉他不会立刻发现。
 */

import { useState } from 'react';
import { ApiError, apiGet, runCommand } from '../lib/api';
import { Button } from '../ui/Button';
import { Field } from '../ui/Field';
import { Badge } from '../ui/Badge';
import { Alert } from '../ui/Alert';
import { Card } from '../ui/Card';
import { Spinner } from '../ui/Spinner';

interface YelpBiz {
  yelpBusinessId: string;
  name: string;
  phoneE164: string | null;
  displayPhone: string | null;
  address: {
    line1: string | null; line2: string | null; city: string | null;
    state: string | null; zip: string | null; country: string | null;
    display: string[];
  };
  timezone: string;
  timezoneConfidence: 'high' | 'needs_confirm';
  businessHours: Record<string, { open: string; close: string } | null>;
  rating: number | null;
  reviewCount: number | null;
  isClosed: boolean;
  categories: string[];
  yelpUrl: string | null;
}

const DAYS: Array<[string, string]> = [
  ['mon', '周一'], ['tue', '周二'], ['wed', '周三'], ['thu', '周四'],
  ['fri', '周五'], ['sat', '周六'], ['sun', '周日'],
];

/**
 * 美国这九个时区的中文说法。开店向导和这一屏共用一份 ——
 * 抄两份的话，迟早有一份少一个「亚利桑那不调夏令时」。
 */
export const TZ_LABEL: Record<string, string> = {
  'America/New_York': '东部时间',
  'America/Chicago': '中部时间',
  'America/Denver': '山区时间',
  'America/Phoenix': '亚利桑那（不调夏令时）',
  'America/Los_Angeles': '太平洋时间',
  'America/Anchorage': '阿拉斯加',
  'Pacific/Honolulu': '夏威夷',
};
export const TZ_CHOICES = Object.keys(TZ_LABEL);

export function YelpFill({
  membershipId, onDone, onCancel,
}: {
  membershipId: string;
  onDone: () => Promise<unknown>;
  onCancel: () => void;
}) {
  const [term, setTerm] = useState('');
  const [zip, setZip] = useState('');
  const [hits, setHits] = useState<YelpBiz[] | null>(null);
  const [picked, setPicked] = useState<YelpBiz | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  // 逐项勾选。默认全勾上 —— 多数情况老板就是想全填
  const [take, setTake] = useState({
    name: true, phone: true, address: true, timezone: true, hours: true,
  });
  const [tz, setTz] = useState('');

  async function search() {
    setBusy(true); setErr(''); setHits(null); setPicked(null);
    try {
      const r = await apiGet<{ businesses: YelpBiz[] }>(
        `/v1/desk/yelp/search?term=${encodeURIComponent(term)}&location=${encodeURIComponent(zip)}`,
        membershipId);
      setHits(r.businesses);
      if (r.businesses.length === 0) setErr('没找到。换个写法试试，或者直接手工填。');
    } catch (e) {
      setErr(e instanceof ApiError && e.code === 'UPSTREAM_UNAVAILABLE'
        ? 'Yelp 暂时查不了，先手工填吧 —— 不影响开店。'
        : '搜索失败');
    } finally { setBusy(false); }
  }

  /** 点选之后再拉一次详情：**营业时间只有详情接口有** */
  async function pick(biz: YelpBiz) {
    setBusy(true); setErr('');
    try {
      const r = await apiGet<{ business: YelpBiz }>(
        `/v1/desk/yelp/search?id=${encodeURIComponent(biz.yelpBusinessId)}`, membershipId);
      setPicked(r.business);
      setTz(r.business.timezone);
    } catch {
      // 详情拉不到就用搜索结果凑合（少营业时间），别把整个流程堵死
      setPicked(biz);
      setTz(biz.timezone);
      setErr('营业时间没拉到，其余照常填，时间可以之后自己填。');
    } finally { setBusy(false); }
  }

  async function apply() {
    if (!picked) return;
    setBusy(true); setErr('');
    try {
      await runCommand('location.applyYelp', {
        yelpBusinessId: picked.yelpBusinessId,
        ...(take.name ? { name: picked.name } : {}),
        ...(take.phone && picked.phoneE164 ? { phone: picked.phoneE164 } : {}),
        ...(take.address ? { address: picked.address } : {}),
        ...(take.timezone ? { timezone: tz } : {}),
        ...(take.hours && Object.keys(picked.businessHours).length > 0
          ? { businessHours: picked.businessHours } : {}),
        ratingBp: picked.rating === null ? null : Math.round(picked.rating * 10000),
        reviewCount: picked.reviewCount,
      }, membershipId);
      await onDone();
    } catch (e) {
      setErr(e instanceof ApiError ? `保存失败（${e.code}）` : '保存失败');
    } finally { setBusy(false); }
  }

  // ── 搜索 ────────────────────────────────────────────────────────────────
  if (!picked) {
    return (
      <div className="flex max-w-[760px] flex-col gap-4 px-4 pb-6">
        <Card className="flex flex-col p-5 gap-2.5">
          <div className="text-xl font-extrabold">
            🔎 输店名和邮编，自动填店铺信息
          </div>
          <div className="text-xs text-ink-3" style={{ lineHeight: 1.7 }}>
            从 Yelp 上把地址、电话、营业时间一次填好。
            <strong>填之前你可以逐项勾选</strong>，不想要的不填。
          </div>
        </Card>

        <div className="flex items-center gap-3 flex-wrap">
          <label className="flex min-w-0 flex-1 flex-col gap-1.5" style={{ minWidth: 200 }}>
            <span className="text-xs text-ink-3">店名</span>
            <Field  value={term} autoFocus placeholder="例：Lotus Nails"
                   onChange={(e) => setTerm(e.target.value)}
                   onKeyDown={(e) => { if (e.key === 'Enter' && term && zip) void search(); }} />
          </label>
          <label className="flex flex-col gap-1.5" style={{ width: 180 }}>
            <span className="text-xs text-ink-3">邮编（或城市）</span>
            <Field mono  value={zip} placeholder="78704"
                   onChange={(e) => setZip(e.target.value)}
                   onKeyDown={(e) => { if (e.key === 'Enter' && term && zip) void search(); }} />
          </label>
        </div>

        {err && <Alert tone="warn">{err}</Alert>}

        <div className="flex items-center gap-3">
          <Button className="min-w-0 flex-1" style={{ minHeight: 'var(--tap)' }} onClick={onCancel}>
            返回
          </Button>
          <Button variant="primary" className="min-w-0 flex-1" disabled={busy || !term.trim() || !zip.trim()} style={{ minHeight: 'var(--tap-lg)', fontSize: 'var(--text-lg)' }} onClick={() => void search()}>
            {busy ? <Spinner /> : '搜索 →'}
          </Button>
        </div>

        {/* 命中多家一定让他点一家 —— 带地址和评价数，一眼能认出自己的店 */}
        {hits && hits.length > 0 && (
          <div className="flex flex-col gap-2.5">
            <div className="text-xs text-ink-3">
              找到 {hits.length} 家。<strong>点一下你自己的那家</strong>：
            </div>
            {hits.map((b) => (
              <button key={b.yelpBusinessId} className="flex items-center gap-3 rounded-lg border border-line bg-surface shadow-card" disabled={busy}
                      onClick={() => void pick(b)}
                      style={{ padding: '14px 16px', gap: 12, textAlign: 'left',
                               cursor: 'pointer', borderWidth: 2, width: '100%' }}>
                <div className="flex min-w-0 flex-1 flex-col gap-[3px]" style={{ minWidth: 0 }}>
                  <div className="flex items-center gap-2">
                    <strong className="text-lg">{b.name}</strong>
                    {b.isClosed && <Badge tone="danger" >已歇业</Badge>}
                  </div>
                  <span className="truncate text-xs text-ink-3">{b.address.display.join(' · ')}</span>
                  <span className="text-xs text-ink-3">
                    {b.rating !== null && `★ ${b.rating}`}
                    {b.reviewCount !== null && ` · ${b.reviewCount} 条评价`}
                    {b.displayPhone && ` · ${b.displayPhone}`}
                  </span>
                </div>
                <Badge tone="brand" >选这家 ›</Badge>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  // ── 逐项确认 ────────────────────────────────────────────────────────────
  const hoursCount = Object.keys(picked.businessHours).length;

  return (
    <div className="flex flex-col gap-3.5" style={{ maxWidth: 760 }}>
      <Card className="flex flex-col p-5 gap-1.5">
        <div className="text-xl font-extrabold">{picked.name}</div>
        <div className="text-xs text-ink-3">{picked.address.display.join(' · ')}</div>
        {picked.rating !== null && (
          <div className="text-xs text-ink-3">★ {picked.rating} · {picked.reviewCount} 条评价</div>
        )}
        {picked.isClosed && (
          <Alert tone="danger">Yelp 上标着「已歇业」—— 确认一下是不是选错了那一家</Alert>
        )}
      </Card>

      {err && <Alert tone="warn">{err}</Alert>}

      <div className="text-xs text-ink-3">要填哪些？不勾的不会动你现在的设置。</div>

      <Row on={take.name} onToggle={() => setTake({ ...take, name: !take.name })}
           label="店名" value={picked.name} />
      <Row on={take.phone} onToggle={() => setTake({ ...take, phone: !take.phone })}
           label="电话" value={picked.displayPhone ?? '（Yelp 上没有）'}
           disabled={!picked.phoneE164} />
      <Row on={take.address} onToggle={() => setTake({ ...take, address: !take.address })}
           label="地址" value={picked.address.display.join(', ')} />
      <Row on={take.hours} onToggle={() => setTake({ ...take, hours: !take.hours })}
           label="营业时间"
           value={hoursCount > 0 ? `${hoursCount} 天` : '（Yelp 上没有）'}
           disabled={hoursCount === 0} />

      {take.hours && hoursCount > 0 && (
        <Card className="flex flex-col p-3.5 gap-1.5">
          {DAYS.map(([k, label]) => {
            const v = picked.businessHours[k];
            return (
              <div key={k} className="flex items-center gap-2.5">
                <span style={{ width: 46, fontWeight: 600 }}>{label}</span>
                <span className="tnum text-xs text-ink-3">
                  {v ? `${v.open} – ${v.close}` : '休息'}
                </span>
              </div>
            );
          })}
          <div className="text-xs text-ink-3">填完还能在「营业时间」那一页改。</div>
        </Card>
      )}

      {/* ⭐ 时区单独摆出来，而且跨时区的州强制他看一眼 ——
          时区错了整家店的日结、提成、报表全部错一天 */}
      <Card className="flex flex-col gap-2.5" style={{ padding: 14,  borderColor: picked.timezoneConfidence === 'needs_confirm' ? 'var(--warn)' : 'var(--line)', background: picked.timezoneConfidence === 'needs_confirm' ? 'var(--warn-soft)' : 'var(--surface)' }}>
        <div className="flex items-center gap-2.5">
          <button aria-label="要不要填时区"
                  onClick={() => setTake({ ...take, timezone: !take.timezone })}
                  style={{ background: 'none', border: 0, fontSize: 24, padding: 0,
                           cursor: 'pointer', lineHeight: 1 }}>
            {take.timezone ? '☑' : '☐'}
          </button>
          <strong className="min-w-0 flex-1">时区</strong>
          {picked.timezoneConfidence === 'needs_confirm' && (
            <Badge tone="warn" >⚠ 这个州横跨两个时区，请确认</Badge>
          )}
        </div>
        {take.timezone && (
          <>
            <div className="flex items-center gap-2 flex-wrap">
              {TZ_CHOICES.map((z) => (
                <Button key={z} onClick={() => setTz(z)}
                        style={{
                          minHeight: 48, borderWidth: 2,
                          borderColor: tz === z ? 'var(--brand)' : 'var(--line)',
                          background: tz === z ? 'var(--brand-soft)' : 'var(--surface)',
                        }}>
                  {TZ_LABEL[z]}
                </Button>
              ))}
            </div>
            <div className="text-xs text-ink-3">
              选错了打烊日结和提成会整体错一天 —— 花三秒确认一下。
            </div>
          </>
        )}
      </Card>

      <div className="flex items-center gap-3">
        <Button style={{ minHeight: 'var(--tap)' }} disabled={busy} onClick={() => { setPicked(null); setErr(''); }}>
          换一家
        </Button>
        <span className="min-w-0 flex-1" />
        <Button variant="primary" disabled={busy} style={{ minHeight: 'var(--tap-lg)', fontSize: 'var(--text-lg)', minWidth: 220 }} onClick={() => void apply()}>
          {busy ? <Spinner /> : '✓ 填进我的店'}
        </Button>
      </div>
    </div>
  );
}

function Row({ on, onToggle, label, value, disabled }: {
  on: boolean; onToggle: () => void; label: string; value: string; disabled?: boolean;
}) {
  return (
    <Card className="flex items-center gap-3" style={{ padding: '12px 16px',  opacity: disabled ? .5 : 1 }}>
      <button aria-label={`要不要填${label}`} disabled={disabled} onClick={onToggle}
              style={{ background: 'none', border: 0, fontSize: 24, padding: 0,
                       cursor: disabled ? 'default' : 'pointer', lineHeight: 1 }}>
        {on && !disabled ? '☑' : '☐'}
      </button>
      <span style={{ width: 66, fontWeight: 600 }}>{label}</span>
      <span className="min-w-0 flex-1 truncate text-xs text-ink-3">{value}</span>
    </Card>
  );
}
