/**
 * 断网横幅 —— 常驻顶部，不遮挡内容。
 *
 * 明确说出「显示的是几点的数据」：让人分不清实时还是快照，比断网本身更危险。
 *
 * ⚠️ 用 `<TriangleAlert>` 而不是 ⚠️ emoji：emoji 在不同系统上大小和基线
 * 差得离谱，而这一条要和文字对齐（styles.css 开头那段有长注释）。
 */
import { TriangleAlert } from 'lucide-react';

export function OfflineBanner({ since, cachedAt }: { since: number; cachedAt: number | null }) {
  const t = (ms: number) =>
    new Date(ms).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  const mins = Math.max(0, Math.round((Date.now() - since) / 60_000));

  return (
    <div role="status"
         className="sticky top-0 z-20 flex items-center gap-2.5 border-b-2 border-warn bg-warn-soft px-4 py-2.5 font-bold text-warn">
      <TriangleAlert size={19} />
      <span className="flex-1 min-w-0">
        网络已断开{mins > 0 ? `（${mins} 分钟）` : ''}
        {cachedAt ? ` · 显示的是 ${t(cachedAt)} 的数据` : ''}
      </span>
      <span className="text-xs">正在重连…</span>
    </div>
  );
}
