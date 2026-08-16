/**
 * 健康表答案的应用层加密（02-DATA-MODEL §5）
 *
 * ⭐ **为什么 RLS 不够。**
 *
 * RLS 挡的是「应用里的越权」——某个租户读到别的租户的行。它挡不住
 * **把整个数据库复制走的人**：备份泄露、误配的只读副本、被拿到 service_role
 * 的脚本。健康数据（怀孕周数、血栓史、近期手术）泄露一次就是永久的，
 * 所以它必须在**进数据库之前**就已经是密文。
 *
 * 密钥在环境变量（生产走 CI Secret），不在库里。拖库的人拿到的是一堆
 * 解不开的字节。
 *
 * ## 格式
 *
 *   `aes-256-gcm.v1` : [12 字节 IV][16 字节 auth tag][密文]
 *
 * IV 每次随机 —— 固定 IV 的 GCM 是**灾难性**的（同一密钥下重用 IV
 * 会直接泄露明文异或，且能伪造 tag）。auth tag 一并存，解密时验完整性：
 * 有人改了库里的字节，解密会失败而不是给出一段错误的明文。
 */

import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';

export const ENC_ALG = 'aes-256-gcm.v1';

const IV_BYTES = 12;    // GCM 的标准 IV 长度，别改成 16
const TAG_BYTES = 16;

/**
 * 从环境变量取密钥。
 *
 * 接受两种写法：64 位十六进制（32 字节）或 base64。
 * **不接受随便一个短口令** —— 那会让人以为「设了密钥」而实际强度很低。
 * 要用口令的话自己先做 KDF，别指望这里替你补齐。
 */
export function loadFormKey(raw: string | undefined): Buffer {
  if (!raw) {
    throw new Error(
      'FORM_ENCRYPTION_KEY 未设置 —— 健康表功能不可用。\n' +
      '生成一把：node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  }
  const key = /^[0-9a-fA-F]{64}$/.test(raw)
    ? Buffer.from(raw, 'hex')
    : Buffer.from(raw, 'base64');

  if (key.length !== 32) {
    throw new Error(
      `FORM_ENCRYPTION_KEY 必须是 32 字节（64 位 hex 或 base64），拿到 ${key.length} 字节。` +
      '短口令不会被自动拉长 —— 那只会让人以为已经加密了。');
  }
  return key;
}

/** 加密一份答案。输入是已经校验过的 JSON 对象。 */
export function encryptAnswers(answers: unknown, key: Buffer): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(answers), 'utf8')),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

/**
 * 解密。
 *
 * 密文被改过 / 密钥不对 → **抛异常**，不返回半个结果。
 * 健康表这种场景，「解出一段看起来像是答案的乱码」比直接失败危险得多。
 */
export function decryptAnswers(blob: Buffer, key: Buffer): unknown {
  if (blob.length < IV_BYTES + TAG_BYTES) {
    throw new Error('健康表密文长度不对，可能已损坏');
  }
  const iv = blob.subarray(0, IV_BYTES);
  const tag = blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const body = blob.subarray(IV_BYTES + TAG_BYTES);

  const d = createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  const plain = Buffer.concat([d.update(body), d.final()]);
  return JSON.parse(plain.toString('utf8'));
}

/**
 * 密钥指纹，用来在日志里认出「这条是哪把钥匙加的」。
 *
 * ⚠️ 只取前 8 位十六进制，而且是 SHA-256 之后的 —— 够区分两把钥匙，
 * 又不足以帮任何人还原密钥。整个指纹写进日志都是安全的。
 */
export function keyFingerprint(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 8);
}
