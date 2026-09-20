/**
 * 确认码与自助取消令牌（docs/13 §4.4–4.5）。
 *
 * ## 两样东西，两个用途，两种存法
 *
 * `confirmationCode`   给客人念、给前台搜。**明文存**，它不授权任何事
 * `manageToken`        自助取消的唯一凭证。**只存 SHA-256 摘要** ——
 *                      和设备令牌（0016）、技师会话令牌（0031）同一个套路
 *
 * ## ⭐ 为什么取消必须要令牌，不能只凭预约 id
 *
 * 预约 id 会出现在 URL、浏览器历史、转发出去的确认邮件、客服截图里。
 * 只凭它就能取消，等于**谁拿到那封信谁就能取消别人的预约**。
 *
 * ## 与 `email/render.ts` 那条「不放取消链接」的关系
 *
 * 那条决定当时是对的，现在**收窄**而不是推翻（2026-08-21）：
 *   · 只对 `source='web'` 的预约发链接 —— 前台手工建的单一如既往没有
 *   · 只能**取消**，不能改期。改期在公开页面上会变成「取消 + 重订」两步，
 *     中间那一格可能被人订走，客人两头落空
 *   · 开始前 N 小时就失效，那时候该打电话（店家也才有机会挽留）
 * 客人自己在官网上订的单，他自己取消是他本来就有的权利；
 * 把这条路堵死的结果是他直接不来（no-show），那比取消更糟。
 */

import {
  createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual,
} from 'node:crypto';

/** 明文令牌：`mt_` + 32 字节随机。前缀是为了在日志里一眼认出来 */
export function generateManageToken(): string {
  return `mt_${randomBytes(32).toString('base64url')}`;
}

export function hashManageToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** 定长比较。理由同 `kiosk/deviceAuth.ts` 的 `sameHash` */
export function sameDigest(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/**
 * Reconstructable manage URL for later notifications (Task 8 design lock).
 *
 * ## Why wrap exists
 *
 * The database stores only `manage_token_digest`. SHA-256 is not reversible,
 * so a later merchant-initiated reschedule, cancellation, or reminder cannot
 * rebuild `https://book.geniefront.com/l/{slug}#g/{token}` from the row.
 *
 * Rejected alternatives:
 *   · Mint a new token at notification time — invalidates the confirmation
 *     link the guest already has.
 *   · Store the raw token — a dump of appointments would become a pile of
 *     live management URLs.
 *   · Put the raw token in audit / application logs / analytics — the token
 *     is an authorization secret.
 *   · Switch lookup to a deterministic HMAC(appointmentId) — changes the
 *     validation contract and cannot recover already-issued random tokens.
 *
 * ## Design
 *
 * 1. Issuance still generates a random `mt_…` token.
 * 2. Store SHA-256 digest for lookup and validation (unchanged).
 * 3. Store AES-256-GCM ciphertext of the raw token in
 *    `appointments.manage_token_wrapped`.
 * 4. Unwrap keyring (first match wins on wrap; unwrap tries every key):
 *      MANAGE_TOKEN_WRAP_KEY            dedicated current (info dedicated:v1)
 *      MANAGE_TOKEN_WRAP_KEY_PREVIOUS   dedicated previous
 *      APP_JWT_SECRET                   legacy current (info gf-manage-token-wrap:v1)
 *      APP_JWT_SECRET_PREVIOUS          legacy previous, for JWT rotation
 * 5. If wrap/unwrap is impossible (missing secret, legacy row, corrupt
 *    blob, digest mismatch): omit `manage_url`. Never mint a replacement.
 *
 * Blob format: `[12-byte IV][16-byte GCM tag][ciphertext]`.
 *
 * Rotating APP_JWT_SECRET: keep the old value in APP_JWT_SECRET_PREVIOUS
 * (or introduce MANAGE_TOKEN_WRAP_KEY first, then rotate JWT freely).
 * Rotating the dedicated wrap key: keep the old value in
 * MANAGE_TOKEN_WRAP_KEY_PREVIOUS until every live wrap has been rewritten.
 */
const WRAP_INFO_JWT = 'gf-manage-token-wrap:v1';
const WRAP_INFO_DEDICATED = 'gf-manage-token-wrap:dedicated:v1';
const WRAP_IV_BYTES = 12;
const WRAP_TAG_BYTES = 16;
const MIN_WRAP_SECRET = 32;

type Env = Record<string, string | undefined>;

interface WrapKey {
  label: string;
  key: Buffer;
}

function deriveWrapKey(secret: string, info: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, '', info, 32));
}

function wrapKeyring(env: Env = process.env): WrapKey[] {
  const keys: WrapKey[] = [];
  const push = (label: string, secret: string | undefined, info: string) => {
    if (secret && secret.length >= MIN_WRAP_SECRET) {
      keys.push({ label, key: deriveWrapKey(secret, info) });
    }
  };
  push('dedicated', env['MANAGE_TOKEN_WRAP_KEY'], WRAP_INFO_DEDICATED);
  push('dedicated-prev', env['MANAGE_TOKEN_WRAP_KEY_PREVIOUS'], WRAP_INFO_DEDICATED);
  push('jwt', env['APP_JWT_SECRET'], WRAP_INFO_JWT);
  push('jwt-prev', env['APP_JWT_SECRET_PREVIOUS'], WRAP_INFO_JWT);
  return keys;
}

function wrapKey(env: Env = process.env): Buffer | null {
  return wrapKeyring(env)[0]?.key ?? null;
}

function isGuardedEnv(env: Env): boolean {
  const gf = env['GF_ENV'];
  if (gf) return gf === 'production' || gf === 'staging';
  return env['NODE_ENV'] === 'production';
}

/**
 * Deploy/startup guard: wrap secrets must be strong enough to derive AES-256.
 * Local/test may omit them (wrap then returns null and manage URLs are omitted).
 */
export function assertManageTokenWrapSafety(env: Env = process.env): void {
  if (!isGuardedEnv(env)) return;
  const jwt = env['APP_JWT_SECRET'] ?? '';
  if (jwt.length < MIN_WRAP_SECRET) {
    throw new Error(
      `APP_JWT_SECRET must be at least ${MIN_WRAP_SECRET} characters `
      + `(got ${jwt.length}). It still unwraps legacy manage-token wraps.`,
    );
  }
  for (const name of [
    'MANAGE_TOKEN_WRAP_KEY', 'MANAGE_TOKEN_WRAP_KEY_PREVIOUS', 'APP_JWT_SECRET_PREVIOUS',
  ] as const) {
    const v = env[name];
    if (v && v.length > 0 && v.length < MIN_WRAP_SECRET) {
      throw new Error(
        `${name} is too short (${v.length} characters). Use at least ${MIN_WRAP_SECRET}.`,
      );
    }
  }
}

function asBuffer(value: Buffer | Uint8Array): Buffer {
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

/** Encrypt a raw manage token for later reconstruction. Null if no wrap key. */
export function wrapManageToken(token: string, env: Env = process.env): Buffer | null {
  const key = wrapKey(env);
  if (!key) return null;
  const iv = randomBytes(WRAP_IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

/**
 * Recover the raw manage token for Task 8 URL construction.
 *
 * Returns null on any failure. Callers must omit `manage_url` rather than
 * mint a new token. Never log `wrapped` or the returned token.
 */
export function unwrapManageToken(
  wrapped: Buffer | Uint8Array | null | undefined,
  digest: string,
  env: Env = process.env,
): string | null {
  if (!wrapped || !digest) return null;
  const blob = asBuffer(wrapped);
  if (blob.length < WRAP_IV_BYTES + WRAP_TAG_BYTES + 1) return null;
  for (const { key } of wrapKeyring(env)) {
    try {
      const iv = blob.subarray(0, WRAP_IV_BYTES);
      const tag = blob.subarray(WRAP_IV_BYTES, WRAP_IV_BYTES + WRAP_TAG_BYTES);
      const body = blob.subarray(WRAP_IV_BYTES + WRAP_TAG_BYTES);
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      const token = Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
      if (sameDigest(hashManageToken(token), digest)) return token;
    } catch {
      /* try the next key */
    }
  }
  return null;
}

/**
 * 确认码：`店名两个字母 - 四位`。
 *
 * 字母表刻意去掉了 **I O 0 1** —— 客人是在电话里念这个码给前台听的，
 * 「零还是欧」这种来回一次就把这个码的价值抵消掉了。
 */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generateConfirmationCode(shopName: string): string {
  const letters = shopName.toUpperCase().replace(/[^A-Z]/g, '');
  const prefix = (letters.slice(0, 2) || 'GF').padEnd(2, 'X');
  const bytes = randomBytes(4);
  let body = '';
  for (const b of bytes) body += ALPHABET[b % ALPHABET.length];
  return `${prefix}-${body}`;
}

/** Recover the same capability only for the same high-entropy request key and
 * booking intent. The server secret prevents a known request ID becoming a
 * derivable management credential. Anti-bot token/timing are deliberately absent. */
export function replayableManageToken(locationId:string,key:string,intent:unknown,env:Env=process.env):string|null {
  const secret=env['MANAGE_TOKEN_WRAP_KEY']??env['APP_JWT_SECRET'];
  if(!secret || secret.length<32 || key.length<32)return null;
  return `mt_${createHmac('sha256',secret).update(JSON.stringify(['public-booking-v1',locationId,key,intent])).digest('base64url')}`;
}
