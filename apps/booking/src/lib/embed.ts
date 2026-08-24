/**
 * 被嵌进老板官网的 iframe 里时要处理的两件事。
 *
 * ## 1. 高度
 *
 * iframe 不会跟着内容长高 —— 它是一个固定尺寸的窗口。不处理的话，
 * 客人滚到「填手机号」那一步会发现底下的按钮被切掉了，
 * 而这在**父页面**上完全看不出问题（是 iframe 内部在滚）。
 *
 * 所以我们把自己的高度 postMessage 给父页面，父页面那段三行的脚本
 * 负责改 iframe 的 height（docs/13 §11 有现成的片段）。
 *
 * ⚠️ `targetOrigin` 用 `'*'`。这是有意的：我们**不知道**自己被嵌在谁的站上
 * （老板换域名不会来通知我们）。发出去的内容只有一个数字，
 * 里面没有任何值得保护的东西 —— 用 `'*'` 的代价是零，
 * 而写死一个 origin 的代价是「换了域名就静默失效」。
 *
 * ## 2. 背景
 *
 * 嵌进去的时候我们的背景色斑要让位给他的页面，否则中间会突兀地出现
 * 一块和周围不搭的方形。`?embed=1` 时给 body 加个类，CSS 里处理。
 */

const q = () => new URLSearchParams(location.search);

export const isEmbedded = (): boolean =>
  q().get('embed') === '1' || (() => { try { return window.self !== window.top; } catch { return true; } })();

export const localeParam = (): string | undefined => q().get('locale') ?? undefined;

/**
 * 开始上报高度。返回一个停止函数。
 *
 * 用 ResizeObserver 而不是定时轮询：内容是一步步展开的（选完项目才出时段），
 * 每一次展开都要立刻上报，轮询会让父页面慢半拍地跳一下。
 */
export function reportHeight(): () => void {
  if (!isEmbedded()) return () => {};

  /**
   * ⚠️ `html` 也要放开 `height: 100%`，否则下面量出来的高度是**假的**。
   *
   * CSS 里那条 `html, body, #root { height: 100% }` 让 `documentElement`
   * 恒等于视口高。内容比视口短的时候（选完项目那一屏就是），
   * `scrollHeight` 被钉在视口高上不动 —— 父页面于是永远收不到「变矮了」，
   * iframe 底下留一大片空白，而所有数字看起来都正常。
   *
   * 用脚本改而不是写 CSS：从 body 的类选不到 html，
   * 而 `:has()` 在这个位置换来的可读性还不如一行赋值。
   */
  document.documentElement.style.height = 'auto';

  let last = 0;
  const send = () => {
    // 量 body 而不是 documentElement —— 理由同上
    const h = Math.ceil(Math.max(
      document.body.scrollHeight,
      document.querySelector('.shell')?.getBoundingClientRect().height ?? 0,
    ));
    if (h <= 0) return;
    // 抖 1px 不值得发一条消息 —— 父页面每收到一条就改一次样式
    if (Math.abs(h - last) < 2) return;
    last = h;
    window.parent.postMessage({ type: 'gf-booking:height', height: h }, '*');
  };

  /**
   * ⚠️ 观察 `document.body`，**不是** `documentElement`。
   *
   * `html` 被 CSS 钉在 `height: 100%` 上（styles.css 里 embed 模式会把
   * body 和 #root 放开，但 html 还是 100%），观察它等于观察视口 ——
   * 内容长了它一动不动，回调一次都不会跑。
   */
  /**
   * ⚠️ **不只靠 ResizeObserver。**
   *
   * 按说观察 `document.body` 就够了。实测里它在这一页上**一次都没触发** ——
   * 内容从 941px 变到 798px（换了一步），`scrollHeight` 确实变了，
   * 而 RO 的回调没跑。原因大概和这一页的盒模型有关（body 是 auto、
   * 里面有 sticky 和 fixed 的层），但**具体是哪一条不重要**：
   *
   * 这一处的失败模式是「iframe 静默地不跟着变高」—— 客人滚到底
   * 发现按钮被切掉了，而父页面那边一切正常、控制台一条报错都没有。
   * 为了不那么失败，多花一次 250ms 的 `scrollHeight` 读取是划算的。
   *
   * 所以三条腿一起走，谁先发现变化都行：
   *   · ResizeObserver —— 变化的那一帧就报，最灵敏
   *   · 250ms 轮询 —— 兜底，只在**真的变了**的时候才发消息
   *   · 头两秒补几次 —— React 挂载、字体回流、Turnstile 那个 iframe 塞进来
   */
  const ro = new ResizeObserver(send);
  ro.observe(document.body);
  const shell = document.querySelector('.shell');
  if (shell) ro.observe(shell);

  const poll = setInterval(send, 250);
  const timers = [80, 300, 900, 2000].map((ms) => setTimeout(send, ms));
  window.addEventListener('load', send);
  send();

  return () => {
    ro.disconnect();
    clearInterval(poll);
    timers.forEach(clearTimeout);
  };
}

/** 订成了也说一声 —— 老板的官网可能要埋转化统计 */
export function reportBooked(confirmationCode: string | null): void {
  if (!isEmbedded()) return;
  window.parent.postMessage({ type: 'gf-booking:booked', confirmationCode }, '*');
}
