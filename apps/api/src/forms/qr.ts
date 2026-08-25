/**
 * 二维码 —— 前台屏上出一个码，客人当面用自己手机扫（`docs/15` §4）。
 *
 * ## 为什么在服务端画
 *
 * 一是**前台那台电脑可能是十年前的**：把编码库塞进 desk 的包里，
 * 每个前台每天第一次开页面都要多下载一份，而这个功能一天用不了几次。
 * 二是这样邮件和界面用的是同一份实现 —— 两处各画一次，
 * 迟早会出现「屏幕上扫得出、邮件里扫不出」。
 *
 * ## 为什么是 SVG 而不是 PNG
 *
 * 内联进页面，不产生一次网络请求，也不需要图床。
 * 前台按 Ctrl+P 把它打出来贴在柜台上时也不会糊。
 *
 * ⚠️ **纠错级别用 M 不用 L**：这个码会被打印出来、被贴在柜台上、
 * 被手指按脏。L 级在一张有折痕的纸上扫不出来的概率高得多，
 * 而 M 只让码密一点点。
 */

import QRCode from 'qrcode';

/**
 * 画一个码。返回一段自足的 `<svg>`（没有外链、没有脚本）。
 *
 * ⚠️ 调用方拿它 `dangerouslySetInnerHTML` 之前请确认 **url 是我们自己拼的**。
 * 这段 SVG 里唯一来自外部的东西就是 url，而 qrcode 只把它编码成方块 ——
 * 它不会出现在输出的文本里。
 */
export async function qrSvg(url: string): Promise<string> {
  return QRCode.toString(url, {
    type: 'svg',
    errorCorrectionLevel: 'M',
    margin: 1,
    // 让 SVG 自己按容器缩放：宽高交给 CSS，viewBox 保持比例
    width: 240,
    color: { dark: '#0f0f0f', light: '#ffffff' },
  });
}
