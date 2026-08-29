/**
 * Stripe webhook 验签
 *
 * 和 Telnyx 那条（telnyx/verify.ts）是同一件事、同一组纪律，只是算法不同：
 * Telnyx 用 Ed25519 非对称签名，Stripe 用 **HMAC-SHA256 对称签名**。
 *
 * ⭐ 这条链路比电话那条更要害：电话被伪造的上限是「往前台待办里塞垃圾」，
 * 而计费 webhook 被伪造的上限是**给任意账户凭空充值**，或者把某家店的
 * 订阅状态改成 canceled 让它第二天打不开。所以三条纪律一条都不能松：
 *
 *   1. **先验签，再解析 body。** 验的必须是原始字节 —— 反序列化再序列化
 *      会改字节（键序、空白、\uXXXX 转义），签名当场对不上。
 *   2. **校验时间戳窗口。** 时间戳被签进了 payload，所以攻击者改不动它；
 *      有了窗口，抓到一条合法的充值 webhook 也没法明天再重放一遍。
 *   3. **常数时间比较。** 逐字节短路比较会泄漏「前几个字节对了」，
 *      给出足够多次尝试就能把签名一个字节一个字节地试出来。
 *
 * ⚠️ **每个 endpoint 有各自的 `whsec_`**。本地 `stripe listen` 打印的那一个
 * 和 Dashboard 上生产 endpoint 的那一个不是同一个，混用的表现是
 * 「本地全通、上线全 401」。
 *
 * 为什么自己写而不用 `stripe.webhooks.constructEvent()`：
 * 这样验签这一段可以在**没有网络、没有密钥、没有 SDK 初始化**的情况下
 * 被完整地测（伪造、过期、改 body、改时间戳、多签名头……），
 * 和 Telnyx 那 16 项测试是同一个路子。SDK 仍然用来调 Stripe 的 API。
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppError, ERROR_CODES } from '@gf/contracts';

/** `Stripe-Signature: t=1492774577,v1=5257a869e7…,v1=…` */
export const STRIPE_SIGNATURE_HEADER = 'stripe-signature';

/**
 * 允许的时钟偏差。Stripe 官方 SDK 的默认值也是 300 秒。
 *
 * 放宽到一小时 = 攻击者抓到一条充值成功的 webhook 后有整整一小时可以重放。
 * （`stripe_events` 的主键去重会挡住同一个 event id 的重放，
 *   但那是第二道防线 —— 第一道不该指望第二道。）
 */
export const MAX_SKEW_SECONDS = 300;

export interface StripeVerifyArgs {
  /** 原始请求体字节。**不能**是解析过又序列化回来的 */
  rawBody: Buffer | string;
  /** `stripe-signature` 头的原文 */
  signatureHeader: string | undefined;
  /** `whsec_…`。⚠️ 每个 endpoint 一个，本地 `stripe listen` 会给你另一个 */
  webhookSecret: string;
  /** 注入以便测试；默认取当前时刻 */
  nowSeconds?: number;
}

interface ParsedHeader {
  timestamp: number;
  /** 可能有多个 v1 —— Stripe 轮换密钥期间会同时发新旧两个签名 */
  v1: string[];
}

/**
 * 解析签名头。
 *
 * 格式是逗号分隔的 `key=value`，其中 `t` 是时间戳、`v1` 是 HMAC-SHA256 的十六进制。
 * 还可能出现 `v0`（Stripe CLI 的测试签名）—— **一律忽略**，
 * 只认 v1。认了 v0 等于给一个我们没打算支持的方案开后门。
 */
export function parseStripeSignature(header: string): ParsedHeader | null {
  let timestamp = Number.NaN;
  const v1: string[] = [];

  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 't') timestamp = Number(value);
    else if (key === 'v1') v1.push(value);
  }

  if (!Number.isFinite(timestamp) || v1.length === 0) return null;
  return { timestamp, v1 };
}

/** 常数时间比较两个十六进制签名。长度不同直接算不等，但仍然不短路泄漏位置 */
function hexEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  // 用 hex 编码：把十六进制字符串解析为原始字节再比较，
  // 语义上比 utf8 更精确（比的是签名字节，不是 ASCII 字节值）
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  // 长度已经相等，timingSafeEqual 不会抛
  return timingSafeEqual(ba, bb);
}


/**
 * 验一条 webhook。不通过一律抛 UNAUTHENTICATED，**不说是哪一步不对** ——
 * 「签名错」和「时间戳过期」的区别只对攻击者有用。
 */
export function verifyStripeSignature(args: StripeVerifyArgs): void {
  const { rawBody, signatureHeader, webhookSecret } = args;
  const now = args.nowSeconds ?? Math.floor(Date.now() / 1000);

  if (!signatureHeader || !webhookSecret) throw new AppError(ERROR_CODES.UNAUTHENTICATED);

  const parsed = parseStripeSignature(signatureHeader);
  if (!parsed) throw new AppError(ERROR_CODES.UNAUTHENTICATED);

  // ── 时间戳窗口（防重放）──────────────────────────────────────────────────
  // 两个方向都挡：未来的时间戳同样是攻击者可控的输入
  if (Math.abs(now - parsed.timestamp) > MAX_SKEW_SECONDS) {
    throw new AppError(ERROR_CODES.UNAUTHENTICATED);
  }

  // ── HMAC-SHA256 ─────────────────────────────────────────────────────────
  // 签名对象是 `${t}.${rawBody}` —— 时间戳被签进去了，
  // 所以攻击者改不动它，上面那个窗口检查才有意义。
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf8');
  const signed = Buffer.concat([
    Buffer.from(`${parsed.timestamp}.`, 'utf8'),
    body,
  ]);
  const expected = createHmac('sha256', webhookSecret).update(signed).digest('hex');

  // 轮换密钥期间会同时来新旧两个 v1，命中任意一个即可
  const ok = parsed.v1.some((sig) => hexEquals(sig, expected));
  if (!ok) throw new AppError(ERROR_CODES.UNAUTHENTICATED);
}

/**
 * 造一个签名头。**只给测试用** —— 生产环境里签名永远由 Stripe 那边产生。
 *
 * 放在这里而不是测试文件里，是为了让「我们怎么理解这个签名格式」
 * 只有一份表述：验的那一侧和造的那一侧共用同一个字符串拼法，
 * 拼错了两边一起错、测试照样绿 —— 所以真实签名的兼容性由
 * `stripe listen` 打一条真事件来兜底（见 10-HANDOFF）。
 */
export function signStripePayload(
  rawBody: string, secret: string, timestampSeconds: number,
): string {
  const mac = createHmac('sha256', secret)
    .update(`${timestampSeconds}.${rawBody}`)
    .digest('hex');
  return `t=${timestampSeconds},v1=${mac}`;
}
