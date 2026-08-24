/**
 * Cloudflare Turnstile 校验 —— 公开预约页的第一道门（docs/13 §6.1）。
 *
 * 选 Turnstile 不选 reCAPTCHA 的理由在 `06-EXTERNAL-SERVICES.md`：免费，
 * 而且多数情况下客人**完全无感**（不用点消防栓）。在一个「客人订指甲」的
 * 场景里，多一步图片验证的流失比机器人贵。
 *
 * ⚠️ **它挡的是脚本，不是人。** 一个真人开着浏览器一条条填假单照样过 ——
 * 而恶意占位往往就是真人干的。挡那个的是限频 + 未完成预约上限 +
 * （必要时）手机验证码，见 docs/13 §6.5–6.6。
 */

import { AppError, ERROR_CODES } from '@gf/contracts';

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export interface TurnstileArgs {
  token: string;
  ip?: string;
  /**
   * 传给 Cloudflare 的 `idempotency_key`，用建单那个幂等键。
   *
   * ⭐ 没有它的话：客人第一次提交撞上 409（时段被抢走），前端重试时
   * 那个 token 已经在 Cloudflare 那边用过了 —— 于是第二次一定失败，
   * 而失败原因显示成「机器人校验没过」。真客人被自己的重试锁死在门外。
   */
  idempotencyKey?: string;
}

export type TurnstileVerifier = (args: TurnstileArgs) => Promise<boolean>;

async function callSiteverify({ token, ip, idempotencyKey }: TurnstileArgs): Promise<boolean> {
  const secret = process.env['TURNSTILE_SECRET_KEY'];
  /**
   * ⭐ **没配密钥就一律拒绝**，不是放行。
   *
   * 这是这个系统里唯一一个不需要身份就能写库的入口。密钥漏配时
   * 放行等于把它彻底敞开，而且**没有任何征兆** —— 直到某天早上
   * 前台看到三百条假预约。拒绝会在部署当天就炸出来，那正是我们想要的。
   */
  if (!secret) {
    throw new AppError(ERROR_CODES.UPSTREAM_UNAVAILABLE, {
      details: { reason: 'turnstile_not_configured' },
    });
  }

  const body = new URLSearchParams({ secret, response: token });
  if (ip) body.set('remoteip', ip);
  if (idempotencyKey) body.set('idempotency_key', idempotencyKey);

  const res = await fetch(SITEVERIFY, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new AppError(ERROR_CODES.UPSTREAM_UNAVAILABLE, {
    details: { reason: 'turnstile_http', status: res.status },
  });

  const json = (await res.json()) as { success?: boolean };
  return json.success === true;
}

let verifier: TurnstileVerifier = callSiteverify;

/**
 * 测试替身。**只在 NODE_ENV=test 下生效** ——
 * 一个能在生产里关掉验证码的开关，本身就是那个洞。
 */
export function __setTurnstileVerifierForTests(fn: TurnstileVerifier | null): void {
  if (process.env['NODE_ENV'] !== 'test') {
    throw new Error('__setTurnstileVerifierForTests 只能在测试环境用');
  }
  verifier = fn ?? callSiteverify;
}

/** 验不过抛 VALIDATION_FAILED，`details.reason = 'bot_check_failed'`（docs/13 §7） */
export async function assertHuman(args: TurnstileArgs): Promise<void> {
  const token = args.token?.trim();
  if (!token || token.length > 2048) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
      details: { reason: 'bot_check_failed' },
    });
  }
  if (!(await verifier({ ...args, token }))) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
      details: { reason: 'bot_check_failed' },
    });
  }
}
