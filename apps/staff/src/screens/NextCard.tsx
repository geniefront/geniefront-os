/**
 * ⭐ 下一位客人 —— 全屏大卡片。
 *
 * 这一屏是整个技师端存在的理由。设计约束全部来自使用场景
 * （`00` §2、宪法第 11 条）：**戴着手套、店里嘈杂、40–60 岁、英文不好**。
 *
 *   · 一屏一件事。滚动才能看全的信息等于没有
 *   · 名字和项目用最大字号，其余一律降级
 *   · **安全提示红底置顶**：避开部位 / 过敏 / 胶水敏感。
 *     这是戴着手套扫一眼最需要看到的东西（`02` §3.3）
 *   · 手机号是打码的（决策 16 防挖客），且脱敏在服务端做
 *   · 只有两个按钮：开始、完成。危险操作一个都不放这儿
 */

import type { T } from '../i18n';

export interface StaffTask {
  ticketId: string;
  ticketItemId: string;
  customerName: string;
  customerPhone: string | null;
  serviceName: string;
  durationMin: number;
  resourceName: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  state: 'waiting' | 'in_service' | 'done';
  isRequest: boolean;
  details: Array<{ key: string; label: string; value: string }>;
  alerts: string[];
  customerLocale: string | null;
  note: string | null;
}

const elapsed = (iso: string | null): string => {
  if (!iso) return '';
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  return `${m} min`;
};

export function NextCard({
  task, t, busy, flash, disabled, onStart, onFinish,
}: {
  task: StaffTask | null;
  t: T;
  busy: boolean;
  /** 刚收到派单：卡片翻转高亮，让人一眼知道"这是新的" */
  flash: boolean;
  /** 断网时写操作置灰（宪法第 18 条：不遮罩、不关页面，只是不让点） */
  disabled: boolean;
  onStart: (task: StaffTask) => void;
  onFinish: (task: StaffTask) => void;
}) {
  if (!task) {
    return (
      <div className="card" style={{
        margin: 16, padding: '48px 24px', textAlign: 'center',
        display: 'grid', gap: 10, placeItems: 'center',
      }}>
        <div style={{ fontSize: 56 }}>☕</div>
        <div className="muted" style={{ fontSize: 'var(--text-lg)' }}>{t('next.none')}</div>
      </div>
    );
  }

  const doing = task.state === 'in_service';

  return (
    <div
      className="card stack"
      style={{
        margin: 16, padding: 20, gap: 16,
        borderWidth: 3,
        borderColor: doing ? 'var(--ok)' : flash ? 'var(--brand)' : 'var(--line)',
        background: flash ? 'var(--brand-soft)' : 'var(--surface)',
        // 翻转动画：新单到达时卡片转一下 —— 手机在口袋里震动之后，
        // 掏出来那一眼要立刻知道"变了"
        animation: flash ? 'gf-flip .5s ease-out' : undefined,
      }}
    >
      {/* ⚠️ 安全提示永远在最上面，红底 */}
      {task.alerts.length > 0 && (
        <div className="stack" style={{
          gap: 6, padding: 14, borderRadius: 12,
          background: 'var(--danger)', color: '#fff',
        }}>
          <strong style={{ fontSize: 'var(--text-lg)' }}>{t('alert.title')}</strong>
          {task.alerts.map((a, i) => (
            <div key={i} style={{ fontSize: 'var(--text-lg)', fontWeight: 700 }}>{a}</div>
          ))}
        </div>
      )}

      <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
        <span className="badge badge-soft">
          {doing ? t('next.doing') : t('next.title')}
        </span>
        {task.isRequest && <span className="badge badge-warn">★ {t('next.request')}</span>}
        {task.resourceName && (
          <span className="badge badge-mute">{t('next.seat')} {task.resourceName}</span>
        )}
        {doing && <span className="badge badge-ok">{elapsed(task.startedAt)}</span>}
      </div>

      {/* 名字：最大字号。技师先认人，再看项目 */}
      <div style={{ fontSize: 'var(--text-2xl)', fontWeight: 800, lineHeight: 1.15 }}>
        {task.customerName}
      </div>

      <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 'var(--text-xl)', fontWeight: 700 }}>{task.serviceName}</span>
        <span className="badge badge-mute" style={{ fontSize: 'var(--text-lg)' }}>
          {task.durationMin} min
        </span>
      </div>

      {/* 落单要素：力度、重点部位、甲型色号… 只显示 to_staff = true 的 */}
      {task.details.length > 0 && (
        <div className="stack" style={{ gap: 8, padding: 14, borderRadius: 12, background: 'var(--bg)' }}>
          {task.details.map((d) => (
            <div key={d.key} className="row" style={{ gap: 10 }}>
              <span className="muted" style={{ minWidth: 96 }}>{d.label}</span>
              <strong style={{ fontSize: 'var(--text-lg)' }}>{d.value}</strong>
            </div>
          ))}
        </div>
      )}

      {task.note && <div className="tiny">{task.note}</div>}

      <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
        {/* 决策 16：技师端只看得到尾号，防私挖老客 */}
        {task.customerPhone && (
          <span className="badge badge-mute" style={{ fontVariantNumeric: 'tabular-nums' }}>
            {task.customerPhone}
          </span>
        )}
        {task.customerLocale && <span className="badge badge-mute">{task.customerLocale}</span>}
      </div>

      {/* 只有两个按钮，各占一整行宽 —— 戴手套点得中 */}
      {!doing ? (
        <button className="btn btn-primary btn-block" disabled={busy || disabled}
                style={{ minHeight: 88, fontSize: 'var(--text-xl)' }}
                onClick={() => onStart(task)}>
          {busy ? <span className="spin" /> : `▶ ${t('next.start')}`}
        </button>
      ) : (
        <button className="btn btn-block" disabled={busy || disabled}
                style={{
                  minHeight: 88, fontSize: 'var(--text-xl)',
                  borderWidth: 3, borderColor: 'var(--ok)',
                  background: 'var(--ok-soft)', color: 'var(--ok)', fontWeight: 800,
                }}
                onClick={() => onFinish(task)}>
          {busy ? <span className="spin" /> : `✓ ${t('next.finish')}`}
        </button>
      )}
    </div>
  );
}
