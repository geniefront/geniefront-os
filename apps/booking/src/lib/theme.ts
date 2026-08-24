/**
 * 外观参数 —— 全部从 URL 上读（docs/13 §10.4）。
 *
 * ## 为什么是 URL 参数而不是别的
 *
 * 这一页会被嵌进上千家门店的官网，每一家的品牌都不一样。可选的做法有三种：
 *
 *   ① 每店在后台配一套外观      要建表、要界面、要教老板；而真正在意
 *                              「圆角是 8 还是 14」的是做官网的那个人，
 *                              他根本进不了老板的后台
 *   ② postMessage 传样式进来    父页面要写一段脚本，而且时序上会闪一下
 *                              （先用默认色渲染，再变成品牌色）
 *   ③ **URL 参数**             改一行 `src=` 就换个样子，首帧就是对的
 *
 * ③ 赢在「改的人和看到效果的人是同一个人，而且循环只有一次刷新」。
 *
 * ## ⚠️ 参数是**不可信输入**
 *
 * 这些值会变成 CSS 变量。`--accent: red; } body { display:none } .x {`
 * 这种东西一旦原样插进 style 属性就是一次 CSS 注入。所以每个参数都
 * **白名单校验**，认不出一律回退到默认值 —— 不报错，因为报错也没人看，
 * 而一个长得不对的按钮比一页错误信息容易发现得多。
 */

export type ThemeName = 'mono' | 'glass';
export type ModeName = 'light' | 'dark';

export interface Look {
  theme: ThemeName;
  /** 解析过的最终值。`auto` 在这里已经被 matchMedia 展开了 */
  mode: ModeName;
  /** 跟随系统 —— 需要挂监听，系统切换时跟着变 */
  followSystem: boolean;
  accent: string | null;
  accentInk: string | null;
  radius: number | null;
  maxWidth: number | null;
  showHeader: boolean;
  density: 'normal' | 'compact';
}

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** `?accent=111111` / `?accent=%23111111` 都收。认不出返回 null */
function readAccent(raw: string | null): string | null {
  if (!raw) return null;
  const v = raw.trim();
  if (!HEX.test(v)) return null;
  const hex = v.startsWith('#') ? v : `#${v}`;
  return hex.toLowerCase();
}

/**
 * 按亮度挑按钮上的字色。
 *
 * 老板给的品牌色可能是深蓝也可能是柠檬黄 —— 写死白字的话，
 * 黄底白字是**看不见的**。用感知亮度（sRGB 加权）判一次，比让人手填一个
 * 「字色」参数靠谱：会填错的人正是最需要这个默认值的人。
 */
export function inkOn(hex: string): string {
  const h = hex.slice(1);
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255) as
    [number, number, number];
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return L > 0.45 ? '#0b0b0b' : '#ffffff';
}

function readInt(raw: string | null, min: number, max: number): number | null {
  if (raw === null) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * 解析外观参数。
 *
 * ⚠️ 参数显式传进来（而不是在函数里读 `location`）是为了**能测**：
 * 这几行是一道安全边界（下面每一条 `readX` 都是白名单），
 * 而只能在浏览器里手点一遍的边界，等于没有边界。
 */
export function readLook(
  search: string = location.search,
  systemDark: boolean = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false,
): Look {
  const p = new URLSearchParams(search);
  const theme: ThemeName = p.get('theme') === 'glass' ? 'glass' : 'mono';

  const modeParam = p.get('mode');
  const followSystem = modeParam !== 'light' && modeParam !== 'dark';
  const mode: ModeName = followSystem ? (systemDark ? 'dark' : 'light')
    : (modeParam as ModeName);

  const accent = readAccent(p.get('accent'));

  return {
    theme,
    mode,
    followSystem,
    accent,
    accentInk: accent ? inkOn(accent) : null,
    radius: readInt(p.get('radius'), 0, 28),
    maxWidth: readInt(p.get('width'), 320, 900),
    // `?header=0` —— 官网上方已经写着店名了，再来一遍是重复
    showHeader: p.get('header') !== '0',
    density: p.get('density') === 'compact' ? 'compact' : 'normal',
  };
}

/** 把外观写到 `<html>` 上。CSS 里全靠这几个属性和变量取值 */
export function applyLook(look: Look): void {
  const el = document.documentElement;
  el.dataset['theme'] = look.theme;
  el.dataset['mode'] = look.mode;
  el.dataset['density'] = look.density;

  const set = (k: string, v: string | null) =>
    v === null ? el.style.removeProperty(k) : el.style.setProperty(k, v);

  set('--accent', look.accent);
  set('--accent-ink', look.accentInk);
  // 品牌色的浅底：同色 12% 透明。用 color-mix 会在旧 Safari 上整条失效，
  // 而这条失效的表现是「选中项没有底色」—— 不值得，直接算
  set('--accent-soft', look.accent ? `${look.accent}1f` : null);
  set('--accent-line', look.accent ? `${look.accent}59` : null);
  set('--r-lg', look.radius === null ? null : `${look.radius}px`);
  set('--r-md', look.radius === null ? null : `${Math.max(0, look.radius - 4)}px`);
  set('--r-sm', look.radius === null ? null : `${Math.max(0, look.radius - 6)}px`);
  set('--shell-w', look.maxWidth === null ? null : `${look.maxWidth}px`);
}

/**
 * 没显式指定 `?mode=` 时跟着系统走。
 *
 * ⚠️ 显式指定了就**不许**跟着变 —— 老板把 iframe 设成 `mode=light`
 * 是因为他的页面是白的，客人系统是深色不该把这块变黑。
 */
export function watchSystemMode(look: Look, onChange: (m: ModeName) => void): () => void {
  if (!look.followSystem || !window.matchMedia) return () => {};
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const fn = (e: MediaQueryListEvent) => onChange(e.matches ? 'dark' : 'light');
  mq.addEventListener('change', fn);
  return () => mq.removeEventListener('change', fn);
}
