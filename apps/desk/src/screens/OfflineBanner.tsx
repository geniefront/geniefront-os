/**
 * 断网横幅 —— 常驻顶部，不遮挡内容。
 *
 * 明确说出「显示的是几点的数据」：让人分不清实时还是快照，比断网本身更危险。
 */
export function OfflineBanner({ since, cachedAt }: { since: number; cachedAt: number | null }) {
  const t = (ms: number) =>
    new Date(ms).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  const mins = Math.max(0, Math.round((Date.now() - since) / 60_000));

  return (
    <div className="row" role="status" style={{
      padding: '10px 16px', gap: 10, background: 'var(--warn-soft)',
      borderBottom: '2px solid var(--warn)', color: 'var(--warn)', fontWeight: 700,
      position: 'sticky', top: 0, zIndex: 20,
    }}>
      <span aria-hidden style={{ fontSize: 20 }}>⚠️</span>
      <span className="grow">
        网络已断开{mins > 0 ? `（${mins} 分钟）` : ''}
        {cachedAt ? ` · 显示的是 ${t(cachedAt)} 的数据` : ''}
      </span>
      <span className="tiny" style={{ color: 'var(--warn)' }}>正在重连…</span>
    </div>
  );
}
