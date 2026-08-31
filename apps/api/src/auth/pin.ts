/**
 * 技师 PIN 的存储与校验（AUD-11）。
 *
 * ## 原来有两个问题，第二个更要命
 *
 * **① 哈希方式**：`sha256('gf_pin_salt_' + pin)` —— 一个写死的全局盐、
 * 单轮、无 KDF。PIN 只有 4–6 位，全部可能性是一万到一百万种；
 * 全局盐意味着一张彩虹表能一次性打穿**所有门店所有人**的 PIN，
 * 而且相同 PIN 的人哈希值一样 —— 能读到这一列的人直接看得出谁和谁撞了 PIN。
 *
 * **② 写的和读的对不上**：`staff.setPin` 用上面那个全局盐方案写，
 * 而打卡校验 `assertPin` 用的是 `sha256(membershipId + ':' + pin)`。
 * 两个方案**永远不可能匹配** —— 也就是说：一位技师一旦设了 PIN，
 * 他从此再也打不了卡，每次都是「PIN 不对」。
 * 两处各自看起来都合理，凑在一起才是坏的，所以谁读单独一处都发现不了。
 *
 * ## 现在
 *
 * 一个模块、一种格式、一个写入方、一个校验方。
 *
 *   scrypt$<N>$<r>$<p>$<salt-base64>$<hash-base64>
 *
 * 每行一个 16 字节随机盐 —— 相同 PIN 存出来必然不同，
 * 彩虹表和「谁和谁撞了 PIN」两件事一起没了。
 *
 * ## 旧数据怎么办
 *
 * `verifyPin` 认三种格式：新格式、以及上面那两种历史 sha256。
 * 校验通过且是旧格式时返回 `needsRehash: true`，调用方就地升级 ——
 * 技师下一次打卡时无感迁移，不需要让全店重设 PIN
 * （让全店重设 PIN 这种迁移方案，实际结果是大家都把 PIN 设成 1234）。
 */

import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

/**
 * `promisify` 挑到的是 `scrypt(password, salt, keylen, cb)` 那个重载，
 * 带 options 的那个签名丢了。显式声明回来，而不是在每个调用点 `as any`。
 */
const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * ⚠️ `maxmem` 必须显式给。
 *
 * scrypt 大约要 `128 * N * r` 字节；N=32768、r=8 就是 33.5MB，
 * 而 Node 的默认上限正好是 32MB —— 差一点点，报的是
 * `memory limit exceeded`，看起来像参数写错了而不是上限太小。
 * 给 64MB 留出余量，以后调高 N 也不用同时想起来改这里。
 */
const MAXMEM = 64 * 1024 * 1024;

/**
 * scrypt 参数。
 *
 * N=32768 在这台机器上约 100–200ms。PIN 校验只发生在打卡和上机切换身份时，
 * 一天几十次，这个开销无感；而对离线爆破来说，一万种可能从「一瞬间」
 * 变成「每个哈希都要单独跑一遍」。
 *
 * ⚠️ 参数写进哈希串本身，所以以后调高不会让旧记录失效。
 */
const N = 32_768;
const R = 8;
const P = 1;
const KEYLEN = 32;
const SALT_BYTES = 16;

const NEW_PREFIX = 'scrypt$';

/** 历史格式一：`staff.setPin` 写的（全局盐）。 */
function legacyGlobalSalt(pin: string): string {
  return createHash('sha256').update(`gf_pin_salt_${pin}`, 'utf8').digest('hex');
}

/** 历史格式二：`assertPin` 期待的（membership 盐）。实际上从来没有人这么写过。 */
function legacyMembershipSalt(membershipId: string, pin: string): string {
  return createHash('sha256').update(`${membershipId}:${pin}`).digest('hex');
}

function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

/** 存一个新 PIN。每次调用都用新的随机盐。 */
export async function hashPin(pin: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const derived = await scrypt(pin, salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return [
    'scrypt', String(N), String(R), String(P),
    salt.toString('base64'), derived.toString('base64'),
  ].join('$');
}

export interface PinVerifyResult {
  ok: boolean;
  /** 校验通过、但存的是历史格式。调用方应就地写回新格式。 */
  needsRehash: boolean;
}

/**
 * 校验一个 PIN。
 *
 * @param membershipId 只用于识别历史格式二。新格式用不到它。
 */
export async function verifyPin(
  pin: string,
  stored: string,
  membershipId: string,
): Promise<PinVerifyResult> {
  if (stored.startsWith(NEW_PREFIX)) {
    const parts = stored.split('$');
    // scrypt$N$r$p$salt$hash
    if (parts.length !== 6) return { ok: false, needsRehash: false };
    const n = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) {
      return { ok: false, needsRehash: false };
    }
    const salt = Buffer.from(parts[4]!, 'base64');
    const expected = Buffer.from(parts[5]!, 'base64');
    const derived = await scrypt(pin, salt, expected.length, { N: n, r, p, maxmem: MAXMEM });
    const ok = derived.length === expected.length && timingSafeEqual(derived, expected);
    // 参数变了也算要升级：以后调高 N 时，老记录会随使用逐步跟上
    return { ok, needsRehash: ok && (n !== N || r !== R || p !== P) };
  }

  // 历史格式：64 位十六进制的 sha256
  if (/^[0-9a-f]{64}$/i.test(stored)) {
    const ok = safeEqualHex(legacyGlobalSalt(pin), stored)
      || safeEqualHex(legacyMembershipSalt(membershipId, pin), stored);
    return { ok, needsRehash: ok };
  }

  return { ok: false, needsRehash: false };
}
