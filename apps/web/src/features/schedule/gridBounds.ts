/** 日历时间轴的范围推导。 */

/** 兜底范围。仅在门店营业时间缺失（新店尚未配置）时使用。 */
const FALLBACK_GRID_START = 8 * 60;
const FALLBACK_GRID_END = 22 * 60;

/** 时间轴上下各留出的余量，使贴边的单子不至于紧贴边框。 */
const GRID_PADDING_MIN = 60;

/**
 * 计算时间轴的起止。
 *
 * ⚠️ 不能写死 08:00–22:00。营业时间由各门店自行配置，而**营业时间之外同样可能
 * 存在单据** —— 老板开了非营业时间预约、或历史单的时间早于当前营业时间设置。
 * 一旦有单落在固定范围之外，它会被裁到视野外：前台看到的日程比实际少，
 * 而界面上没有任何迹象表明有东西被隐藏了。
 *
 * 因此范围取「营业时间 ∪ 当日全部单据」的并集，再向外取整到整点。
 */
export function gridBounds(
  openMin: number, closeMin: number, items: { startMins: number; endMins: number }[],
): { start: number; end: number } {
  let start = Number.isFinite(openMin) ? openMin : FALLBACK_GRID_START;
  let end = Number.isFinite(closeMin) ? closeMin : FALLBACK_GRID_END;
  for (const it of items) {
    if (it.startMins < start) start = it.startMins;
    if (it.endMins > end) end = it.endMins;
  }
  start = Math.floor((start - GRID_PADDING_MIN) / 60) * 60;
  end = Math.ceil((end + GRID_PADDING_MIN) / 60) * 60;
  return { start, end };
}
