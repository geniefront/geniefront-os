/**
 * 入站关键词识别（TCPA / CTIA 强制）。**纯函数**。
 *
 * 关键词由店主在 Telnyx 控制台登记,这里必须和那边逐字一致:
 *
 *   退订  STOP, UNSUBSCRIBE, CANCEL, QUIT
 *   订阅  START, YES
 *   帮助  HELP, INFO
 *
 * ## 🔴 CANCEL 是这套关键词里唯一一个有歧义的
 *
 * 在一个**预约系统**里,客人打 CANCEL 十有八九是想「取消我的预约」,
 * 而运营商规定这个词必须触发**退订短信**。两边都不由我们做主:
 * 不认 CANCEL 会违规,认了客人的预约还在。
 *
 * 所以三条一起做,缺一不可:
 *   1. 照认 —— 合规不能让步
 *   2. **我们发出去的短信里一个字都不提「回复 CANCEL」**（`render.ts`）
 *   3. 原话进 `sms_inbound` 留档 —— 前台事后看得到「这人发过 CANCEL」,
 *      能主动打个电话问一句。退订之后我们再也发不了短信给他了
 *
 * ## 匹配规则:整条只有这一个词才算
 *
 * 运营商的规则是「消息内容就是这个关键词」。做成包含匹配的话,
 * 「Can you cancel my 3pm?」会被判成退订 —— 那是把一个想改时间的客人
 * **永久**踢出短信通道。宁可漏判:漏了他会再打电话,误判他再也收不到。
 */

export type SmsIntent = 'opt_out' | 'opt_in' | 'help' | 'unknown';

const OPT_OUT = new Set(['STOP', 'UNSUBSCRIBE', 'CANCEL', 'QUIT']);
const OPT_IN = new Set(['START', 'YES']);
const HELP = new Set(['HELP', 'INFO']);

export function classify(body: string): SmsIntent {
  /**
   * 只做三件事:去首尾空白、转大写、剥掉结尾的标点。
   *
   * 「STOP.」和「stop」必须认 —— 手机键盘会自动补句点、自动首字母大写,
   * 这两种写法在真实流量里非常常见。而中间的空格不合并:
   * 「STOP IT」不是退订,是一句话。
   */
  const word = body.trim().toUpperCase().replace(/[.!?,;:]+$/u, '').trim();

  if (OPT_OUT.has(word)) return 'opt_out';
  if (OPT_IN.has(word)) return 'opt_in';
  if (HELP.has(word)) return 'help';
  return 'unknown';
}

/** 给人看的关键词清单,HELP 回复里要用 */
export const KEYWORDS = {
  optOut: [...OPT_OUT],
  optIn: [...OPT_IN],
  help: [...HELP],
} as const;
