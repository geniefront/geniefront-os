/**
 * 激活邮件：一封带一次性登录链接的信，收到它的人就是这家店的老板。
 *
 * ## 为什么不自己造一个「激活码」
 *
 * 按 `09` §5.2 的标准问一句：**捡到这个链接的人能干什么？**
 * 答案是「成为一家已付费门店的老板」—— 和登录同一个量级。
 * 那就别自己发明：token 的有效期、单次使用、撤销、重放，
 * 每一条自己实现都是一次可能写错的机会，而写错了没人会发现。
 *
 * 所以走 Supabase Auth 的 magic link（`signInWithOtp`）：
 * 那套东西本来就是干这个的，而且**anon key 就够** ——
 * 不需要 service_role（宪法第 5 条，docs/12 §2.2）。
 *
 * ## 为什么直接打 REST 而不是引 @supabase/supabase-js
 *
 * 这一侧只用得上这一个接口。为一次 POST 引一整个 SDK（连带它的
 * 会话管理、Realtime 客户端）进 API 镜像，只会让镜像变大、
 * 让「这个进程能干什么」变模糊。前端那两个 app 引 SDK 是另一回事，
 * 它们要的是会话管理本身。
 *
 * ## 邮件正文在哪改
 *
 * **Supabase 控制台 → Authentication → Email Templates → Magic Link。**
 * ⚠️ 不要再用 SES 补发一封「欢迎」信：两封信里只有一封的链接是活的，
 * 老板会点错那封，然后以为系统坏了（docs/12 §2.2）。
 */

export interface ActivationTarget {
  email: string;
  /** 点进来之后落在哪一页。必须在 Supabase 的 Redirect URLs 白名单里 */
  redirectTo: string;
}

/**
 * 激活链接的落点。
 *
 * ⚠️ 由 `links.ts` 统一构造：域名与路径均取自服务端配置，不接受任何外部
 * 输入，且按环境分流 —— staging 发出的激活信不得指向生产站点。
 *
 * 此处保留一层再导出，是为了让「激活流程的落点」在本文件中可被检索到。
 */
export { activationRedirectUrl } from '../links';

/**
 * 发一封激活信。
 *
 * ⚠️ **调用方必须先把建店那个事务提交掉再调这个函数。**
 * 反过来的话，事务回滚了而信已经飞出去了 —— 老板点进来看到
 * 「你不属于任何门店」，而钱已经付了（docs/12 §4.4）。
 *
 * 失败**不抛**：门店已经建好了，发不出信是可以人工补的，
 * 而把整条 webhook 判失败会让 Stripe 一直重投同一件已经做完的事。
 */
export async function sendActivationEmail(t: ActivationTarget): Promise<
  { ok: true } | { ok: false; reason: string }
> {
  const url = process.env['SUPABASE_URL'];
  const anon = process.env['SUPABASE_ANON_KEY'];
  if (!url || !anon) return { ok: false, reason: 'supabase_env_missing' };

  try {
    const res = await fetch(
      `${url.replace(/\/+$/, '')}/auth/v1/otp?redirect_to=${encodeURIComponent(t.redirectTo)}`,
      {
        method: 'POST',
        headers: { apikey: anon, Authorization: `Bearer ${anon}`, 'Content-Type': 'application/json' },
        // create_user: true —— 老板这一刻还没有账号，这封信同时也是注册
        body: JSON.stringify({ email: t.email, create_user: true }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, reason: `http_${res.status}:${body.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message.slice(0, 200) : 'unknown' };
  }
}
