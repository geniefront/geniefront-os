/**
 * 服务色卡。
 *
 * 服务端不下发颜色（`services` 表只有名称、时长、价格），但日历上必须能凭颜色
 * 快速区分项目 —— 前台扫一眼日程判断今天是什么结构，靠的就是色块分布。
 *
 * 取色规则为「按服务 id 的稳定散列取模」，保证同一服务在任何设备、任何会话下
 * 颜色一致。不使用随机或按数组下标取色：前者每次刷新都变，后者在服务增删后
 * 会整体错位，两者都会让前台重新建立记忆。
 *
 * 色板刻意避开语义色（红=异常、琥珀=等待、翠绿=完成），以免与状态标识混淆。
 */
const SERVICE_PALETTE = [
  'bg-teal-50 border-teal-500 text-teal-700',
  'bg-cyan-50 border-cyan-500 text-cyan-700',
  'bg-sky-50 border-sky-500 text-sky-700',
  'bg-amber-50 border-amber-500 text-amber-700',
  'bg-lime-50 border-lime-600 text-lime-700',
  'bg-stone-100 border-stone-500 text-stone-700',
] as const;

/** FNV-1a。选它是因为实现短、分布均匀，且不依赖运行环境。 */
function hash(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function serviceColor(serviceId: string | null | undefined): string {
  if (!serviceId) return 'bg-slate-50 border-slate-400 text-slate-600';
  return SERVICE_PALETTE[hash(serviceId) % SERVICE_PALETTE.length]!;
}
