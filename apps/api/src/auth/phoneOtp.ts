/**
 * 手机验证码：Telnyx Verify API（docs/09 §5）
 *
 * ## 为什么是 Verify API 而不是「我们自己发一条短信」
 *
 * 验证码的生成、有效期、尝试次数、重发节流，每一条自己实现都是一次
 * 可能写错的机会，而写错了没人会发现 —— 和 `12` §2.2 不自造激活链接
 * 是同一个判断。Verify API 把这些做完了，我们只问它一句「这个码对不对」。
 *
 * ## ⚠️ 10DLC 没批下来之前，这条路在美国是不通的
 *
 * 宪法第 13 条与 `09` §1.2 都写着「短信不进依赖链」。所以：
 *
 *   · 技师上机的**第一条路是上机码**（老板念给他，不经过任何运营商）
 *   · 这一条是第二条路，`TELNYX_VERIFY_PROFILE_ID` 没配就整条不可用，
 *     而不是「配了一半、发出去石沉大海」
 *
 * 界面上两条路并排，缺哪条都不影响开店。
 */

import { AppError, ERROR_CODES } from '@gf/contracts';

const BASE = 'https://api.telnyx.com/v2';

export function verifyConfigured(): boolean {
  return Boolean(process.env['TELNYX_API_KEY'] && process.env['TELNYX_VERIFY_PROFILE_ID']);
}

function config(): { key: string; profileId: string } {
  const key = process.env['TELNYX_API_KEY'];
  const profileId = process.env['TELNYX_VERIFY_PROFILE_ID'];
  if (!key || !profileId) {
    // 宁可整条路不可用，也不要「发了但没人收得到」——
    // 后者会让技师在登录页反复点「重发」，而每一次都真的花钱
    throw new AppError(ERROR_CODES.UPSTREAM_UNAVAILABLE, {
      details: { service: 'telnyx_verify', reason: 'TELNYX_VERIFY_PROFILE_ID 未配置' },
    });
  }
  return { key, profileId };
}

async function call(path: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const { key } = config();
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    // 技师站在登录页等着，卡半分钟他会以为是自己手机的问题
    signal: AbortSignal.timeout(15_000),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

/**
 * 发一条验证码短信。
 *
 * ⚠️ **调用方要先确认这个号码是店里某位在岗员工的**，否则等于
 * 给任意号码发短信的接口 —— 既花钱，又是一个能被用来骚扰别人的东西。
 */
export async function sendPhoneCode(phoneE164: string): Promise<void> {
  const { profileId } = config();
  const { status, json } = await call('/verifications/sms', {
    phone_number: phoneE164,
    verify_profile_id: profileId,
  });

  if (status >= 300) {
    throw new AppError(ERROR_CODES.UPSTREAM_UNAVAILABLE, {
      details: {
        service: 'telnyx_verify',
        // ⚠️ 只留错误码，不把 Telnyx 的原文抛给前端 —— 那里面带着我们的
        // profile id 和请求 id
        reason: telnyxErrorCode(json) ?? `http_${status}`,
      },
    });
  }
}

/**
 * 验一个码。返回 true = 通过。
 *
 * ⚠️ 码错了**不抛异常**：那是业务分支，不是故障。调用方要把
 * 「码不对」和「Telnyx 挂了」分开告诉技师 —— 前者他该重输，
 * 后者他重输一百次也没用。
 */
export async function checkPhoneCode(phoneE164: string, code: string): Promise<boolean> {
  const { profileId } = config();
  const { status, json } = await call(
    `/verifications/by_phone_number/${encodeURIComponent(phoneE164)}/actions/verify`,
    { code, verify_profile_id: profileId },
  );

  // Telnyx 对「码不对」返回的是 200 + response_code=rejected（不是 4xx）
  const responseCode = (json as { data?: { response_code?: string } })?.data?.response_code;
  if (status < 300) return responseCode === 'accepted';

  // 404 = 这个号码上没有进行中的验证（码过期了，或者压根没发过）。
  // 对技师来说这和「码不对」是同一件事：重新要一条
  if (status === 404) return false;

  throw new AppError(ERROR_CODES.UPSTREAM_UNAVAILABLE, {
    details: { service: 'telnyx_verify', reason: telnyxErrorCode(json) ?? `http_${status}` },
  });
}

function telnyxErrorCode(json: unknown): string | null {
  const errs = (json as { errors?: Array<{ code?: string | number }> })?.errors;
  const code = errs?.[0]?.code;
  return code === undefined ? null : String(code);
}
