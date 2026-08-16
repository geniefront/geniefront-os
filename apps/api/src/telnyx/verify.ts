/**
 * Telnyx webhook 验签（09-TELNYX §3）
 *
 * ⭐ **这是整条电话链路上唯一的安全要害。**
 *
 * 没有验签，任何人只要知道我们的 URL，就能 POST 一条
 * 「客人预约了明天三点」进复核队列 —— 更糟的是触发计费事件，
 * 或者把一串垃圾灌进某家店的前台屏幕。这个接口没有 Bearer token 可依赖，
 * 签名就是**全部**的身份证明。
 *
 * 三条纪律，缺一条这道门就等于没关：
 *
 *   1. **先验签，再解析 body。** 验的必须是**原始字节**，不是
 *      `JSON.stringify(req.body)` —— 反序列化再序列化会改字节
 *      （键序、空格、Unicode 转义），签名当场对不上；更危险的是反过来：
 *      为了让它「能用」而去宽松比较，等于没验。
 *   2. **校验时间戳窗口。** 签名本身不含时效，抓到一个合法请求就能无限重放 ——
 *      同一条「预约草案」被塞进队列一百次。
 *   3. **public key 从环境变量读，不同环境不同 key。** 用测试环境的 key
 *      验生产的 webhook，等于把测试环境的任何人都变成生产的可信来源。
 *
 * ⚠️ `TELNYX_PUBLIC_KEY` 和 `TELNYX_API_KEY` 不是一个东西，最容易搞混：
 * 前者验「打进来的是不是 Telnyx」，后者是我们打出去用的。
 */

import { verify as edVerify } from 'node:crypto';
import { AppError, ERROR_CODES } from '@gf/contracts';

/** Telnyx 的签名头。v1 = Ed25519 over `${timestamp}|${rawBody}` */
export const SIGNATURE_HEADER = 'telnyx-signature-ed25519';
export const TIMESTAMP_HEADER = 'telnyx-timestamp';

/**
 * 允许的时钟偏差。
 *
 * 5 分钟是 Telnyx 文档的建议值，也够抗我们这边的 NTP 漂移。
 * 放宽到一小时的话，攻击者抓到一条请求后有整整一小时可以重放。
 */
export const MAX_SKEW_SECONDS = 300;

export interface VerifyArgs {
  /** 原始请求体字节。**不能**是解析过又序列化回来的 */
  rawBody: Buffer | string;
  signatureB64: string | undefined;
  timestamp: string | undefined;
  /** base64 的 Ed25519 公钥（控制台 → Webhook signing key） */
  publicKeyB64: string;
  /** 注入以便测试；默认取当前时刻 */
  nowSeconds?: number;
}

/**
 * 把 Telnyx 给的 32 字节裸公钥包成 SPKI DER，好让 node:crypto 认识它。
 *
 * Telnyx 控制台给的是 base64 的**裸** Ed25519 公钥（32 字节），
 * 而 `crypto.createPublicKey` 只吃 SPKI/PEM。前缀这 12 个字节是
 * Ed25519 的固定 SPKI 头（算法 OID 1.3.101.112），不随 key 变。
 */
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function toSpkiPem(publicKeyB64: string): string {
  const raw = Buffer.from(publicKeyB64, 'base64');
  if (raw.length !== 32) {
    throw new Error(`TELNYX_PUBLIC_KEY 不是 32 字节的 Ed25519 公钥（拿到 ${raw.length} 字节）——` +
      ' 别把 API Key 填到这里了，那是两个不同的东西');
  }
  const der = Buffer.concat([SPKI_ED25519_PREFIX, raw]);
  const b64 = der.toString('base64').replace(/(.{64})/g, '$1\n');
  return `-----BEGIN PUBLIC KEY-----\n${b64}\n-----END PUBLIC KEY-----\n`;
}

/**
 * 验一条 webhook。不通过一律抛 UNAUTHENTICATED，**不告诉对方是哪一步不对** ——
 * 「签名错」和「时间戳过期」的区别，只对攻击者有用。
 */
export function verifyTelnyxSignature(args: VerifyArgs): void {
  const { rawBody, signatureB64, timestamp, publicKeyB64 } = args;
  const now = args.nowSeconds ?? Math.floor(Date.now() / 1000);

  if (!signatureB64 || !timestamp) throw new AppError(ERROR_CODES.UNAUTHENTICATED);

  // ── 时间戳窗口（防重放）────────────────────────────────────────────────
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) throw new AppError(ERROR_CODES.UNAUTHENTICATED);
  // 两个方向都要挡：未来的时间戳同样是攻击者可控的输入
  if (Math.abs(now - ts) > MAX_SKEW_SECONDS) throw new AppError(ERROR_CODES.UNAUTHENTICATED);

  // ── Ed25519 ───────────────────────────────────────────────────────────
  // 签名对象是 `${timestamp}|${rawBody}` —— 时间戳被签进去了，
  // 所以攻击者改不动它，上面那个窗口检查才有意义。
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf8');
  const signed = Buffer.concat([Buffer.from(`${ts}|`, 'utf8'), body]);

  let ok = false;
  try {
    ok = edVerify(
      null,                                   // Ed25519 自带哈希，摘要算法必须传 null
      signed,
      toSpkiPem(publicKeyB64),
      Buffer.from(signatureB64, 'base64'),
    );
  } catch {
    ok = false;   // key 格式不对、签名不是合法 base64……一律当验签失败
  }

  if (!ok) throw new AppError(ERROR_CODES.UNAUTHENTICATED);
}
