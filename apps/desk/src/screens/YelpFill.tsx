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
      <div className="stack" style={{ padding: '0 16px 24px', gap: 16, maxWidth: 760 }}>
        <div className="card stack" style={{ padding: 20, gap: 10 }}>
          <div style={{ fontSize: 'var(--text-xl)', fontWeight: 800 }}>
            🔎 输店名和邮编，自动填店铺信息
          </div>
          <div className="tiny" style={{ lineHeight: 1.7 }}>
            从 Yelp 上把地址、电话、营业时间一次填好。
            <strong>填之前你可以逐项勾选</strong>，不想要的不填。
          </div>
        </div>

        <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
          <label className="stack grow" style={{ gap: 6, minWidth: 200 }}>
            <span className="tiny">店名</span>
            <input className="field" value={term} autoFocus placeholder="例：Lotus Nails"
                   onChange={(e) => setTerm(e.target.value)}
                   onKeyDown={(e) => { if (e.key === 'Enter' && term && zip) void search(); }} />
          </label>
          <label className="stack" style={{ gap: 6, width: 180 }}>
            <span className="tiny">邮编（或城市）</span>
            <input className="field field-mono" value={zip} placeholder="78704"
                   onChange={(e) => setZip(e.target.value)}
                   onKeyDown={(e) => { if (e.key === 'Enter' && term && zip) void search(); }} />
          </label>
        </div>

        {err && <div className="badge badge-warn" style={{ padding: '12px 16px' }}>⚠ {err}</div>}

        <div className="row" style={{ gap: 12 }}>
          <button className="btn grow" style={{ minHeight: 'var(--tap)' }} onClick={onCancel}>
            返回
          </button>
          <button className="btn btn-primary grow" disabled={busy || !term.trim() || !zip.trim()}
                  style={{ minHeight: 'var(--tap-lg)', fontSize: 'var(--text-lg)' }}
                  onClick={() => void search()}>
            {busy ? <span className="spin" /> : '搜索 →'}
          </button>
        </div>

        {/* 命中多家一定让他点一家 —— 带地址和评价数，一眼能认出自己的店 */}
        {hits && hits.length > 0 && (
          <div className="stack" style={{ gap: 10 }}>
            <div className="tiny">
              找到 {hits.length} 家。<strong>点一下你自己的那家</strong>：
            </div>
            {hits.map((b) => (
              <button key={b.yelpBusinessId} className="card row" disabled={busy}
                      onClick={() => void pick(b)}
                      style={{ padding: '14px 16px', gap: 12, textAlign: 'left',
                               cursor: 'pointer', borderWidth: 2, width: '100%' }}>
                <div className="grow stack" style={{ gap: 3, minWidth: 0 }}>
                  <div className="row" style={{ gap: 8 }}>
                    <strong style={{ fontSize: 'var(--text-lg)' }}>{b.name}</strong>
                    {b.isClosed && <span className="badge badge-danger">已歇业</span>}
                  </div>
                  <span className="tiny truncate">{b.address.display.join(' · ')}</span>
                  <span className="tiny">
                    {b.rating !== null && `★ ${b.rating}`}
                    {b.reviewCount !== null && ` · ${b.reviewCount} 条评价`}
                    {b.displayPhone && ` · ${b.displayPhone}`}
                  </span>
                </div>
                <span className="badge badge-soft">选这家 ›</span>
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
    <div className="stack" style={{ padding: '0 16px 24px', gap: 14, maxWidth: 760 }}>
      <div className="card stack" style={{ padding: 20, gap: 6 }}>
        <div style={{ fontSize: 'var(--text-xl)', fontWeight: 800 }}>{picked.name}</div>
        <div className="tiny">{picked.address.display.join(' · ')}</div>
        {picked.rating !== null && (
          <div className="tiny">★ {picked.rating} · {picked.reviewCount} 条评价</div>
        )}
        {picked.isClosed && (
          <div className="badge badge-danger" style={{ padding: '8px 12px', alignSelf: 'flex-start' }}>
            ⚠ Yelp 上标着「已歇业」—— 确认一下是不是选错了那一家
          </div>
        )}
      </div>

      {err && <div className="badge badge-warn" style={{ padding: '10px 14px' }}>⚠ {err}</div>}

      <div className="tiny">要填哪些？不勾的不会动你现在的设置。</div>

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
        <div className="card stack" style={{ padding: 14, gap: 6 }}>
          {DAYS.map(([k, label]) => {
            const v = picked.businessHours[k];
            return (
              <div key={k} className="row" style={{ gap: 10 }}>
                <span style={{ width: 46, fontWeight: 600 }}>{label}</span>
                <span className="field-mono tiny">
                  {v ? `${v.open} – ${v.close}` : '休息'}
                </span>
              </div>
            );
          })}
          <div className="tiny">填完还能在「营业时间」那一页改。</div>
        </div>
      )}

      {/* ⭐ 时区单独摆出来，而且跨时区的州强制他看一眼 ——
          时区错了整家店的日结、提成、报表全部错一天 */}
      <div className="card stack" style={{
        padding: 14, gap: 10,
        borderColor: picked.timezoneConfidence === 'needs_confirm' ? 'var(--warn)' : 'var(--line)',
        background: picked.timezoneConfidence === 'needs_confirm' ? 'var(--warn-soft)' : 'var(--surface)',
      }}>
        <div className="row" style={{ gap: 10 }}>
          <button aria-label="要不要填时区"
                  onClick={() => setTake({ ...take, timezone: !take.timezone })}
                  style={{ background: 'none', border: 0, fontSize: 24, padding: 0,
                           cursor: 'pointer', lineHeight: 1 }}>
            {take.timezone ? '☑' : '☐'}
          </button>
          <strong className="grow">时区</strong>
          {picked.timezoneConfidence === 'needs_confirm' && (
            <span className="badge badge-warn">⚠ 这个州横跨两个时区，请确认</span>
          )}
        </div>
        {take.timezone && (
          <>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              {TZ_CHOICES.map((z) => (
                <button key={z} className="btn"
                        onClick={() => setTz(z)}
                        style={{
                          minHeight: 48, borderWidth: 2,
                          borderColor: tz === z ? 'var(--brand)' : 'var(--line)',
                          background: tz === z ? 'var(--brand-soft)' : 'var(--surface)',
                        }}>
                  {TZ_LABEL[z]}
                </button>
              ))}
            </div>
            <div className="tiny">
              选错了打烊日结和提成会整体错一天 —— 花三秒确认一下。
            </div>
          </>
        )}
      </div>

      <div className="row" style={{ gap: 12 }}>
        <button className="btn" style={{ minHeight: 'var(--tap)' }} disabled={busy}
                onClick={() => { setPicked(null); setErr(''); }}>
          换一家
        </button>
        <span className="grow" />
        <button className="btn btn-primary" disabled={busy}
                style={{ minHeight: 'var(--tap-lg)', fontSize: 'var(--text-lg)', minWidth: 220 }}
                onClick={() => void apply()}>
          {busy ? <span className="spin" /> : '✓ 填进我的店'}
        </button>
      </div>
    </div>
  );
}

function Row({ on, onToggle, label, value, disabled }: {
  on: boolean; onToggle: () => void; label: string; value: string; disabled?: boolean;
}) {
  return (
    <div className="card row" style={{ padding: '12px 16px', gap: 12, opacity: disabled ? .5 : 1 }}>
      <button aria-label={`要不要填${label}`} disabled={disabled} onClick={onToggle}
              style={{ background: 'none', border: 0, fontSize: 24, padding: 0,
                       cursor: disabled ? 'default' : 'pointer', lineHeight: 1 }}>
        {on && !disabled ? '☑' : '☐'}
      </button>
      <span style={{ width: 66, fontWeight: 600 }}>{label}</span>
      <span className="grow truncate tiny">{value}</span>
    </div>
  );
}
