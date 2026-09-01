/**
 * 投递模式 —— live（真发）还是 capture（只留底，不出网）。
 *
 * ## 为什么需要这个开关
 *
 * local 和 staging 用的是测试账号：`+1617555xxxx` 这种号码收不到短信，
 * `qa-xxx@maildrop.cc` 是一个**公开的一次性收件箱**（任何知道地址的人都能读）。
 * 于是「下单之后确认信长什么样」在上线前**从来没有人真正看过一眼**，
 * 只能等真实客人替我们发现问题。
 *
 * capture 模式把「发出去」这一步换成「留在发件箱里，标成 captured」：
 * 入队、渲染、分段、去重、重试计数这几步照常执行 —— 唯独最后那一下不出网。
 * 内容本来就整封存在 `email_outbox` / `sms_outbox` 里（sql/0029 的设计：
 * 写入时就渲染好），所以不需要第二张表，运营台那一页直接读它。
 *
 * ## ⭐ 为什么权威是 GF_ENV 而不是 NODE_ENV
 *
 * `deploy/deploy.sh` 给**staging 和 production 都写 `NODE_ENV=production`**
 * （前端构建、依赖裁剪要它）。拿 NODE_ENV 判环境的话，staging 会被当成
 * 生产而永远打不开 capture —— 这个开关也就等于不存在。
 * 环境的唯一权威是 `GF_ENV`（`scripts/env-guard.sh` 校验的也是它）。
 *
 * ⚠️ 但 `GF_ENV` 缺失时**按生产处理**：一个没打标签、却带着
 * `NODE_ENV=production` 的部署，最坏情况必须是「照常发信」，
 * 而不是「客人的确认信被静默吞掉」。
 */

export type DeliveryMode = 'live' | 'capture';

type Env = Record<string, string | undefined>;

/**
 * 这套环境是不是生产。
 *
 * ⚠️ 判据是 GF_ENV；GF_ENV 缺失而 NODE_ENV=production 时**也算生产**
 * （见文件头注释：宁可多拦，不可漏拦）。测试进程（NODE_ENV=test）不算。
 */
export function isProductionEnv(env: Env = process.env): boolean {
  const gf = env['GF_ENV'];
  if (gf) return gf === 'production';
  return env['NODE_ENV'] === 'production';
}

/** 当前投递模式。没配就是 live —— 默认必须是「真的发出去」。 */
export function deliveryMode(env: Env = process.env): DeliveryMode {
  return env['COMMUNICATION_DELIVERY_MODE'] === 'capture' ? 'capture' : 'live';
}

export function isCaptureMode(env: Env = process.env): boolean {
  return deliveryMode(env) === 'capture';
}

/**
 * 本机 Mailpit 的地址（Supabase 本地栈自带，`supabase/config.toml` 的
 * `[local_smtp]`，本仓库开在 55324）。
 *
 * capture 模式下**顺手**把邮件也投一份进去，这样本地开发能在一个真的
 * 邮件客户端界面里看渲染效果（HTML 排版、链接能不能点），而不是只看一段
 * HTML 源码。投失败不影响任何事 —— 发件箱那一份才是凭据。
 *
 * ⚠️ 只在 capture 模式下用，且只接受本机地址：这条路是「把邮件送到某个
 * 收件箱」，指到外网就等于绕过 capture 偷偷真发了。
 */
export function mailpitEndpoint(env: Env = process.env): string | null {
  if (!isCaptureMode(env)) return null;
  const raw = env['MAILPIT_URL'];
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') return null;
  return `${url.origin}/api/v1/send`;
}

/**
 * 启动闸门：生产环境带着测试用的开关**必须起不来**。
 *
 * 这三样东西共同的性质是：**打开之后失败是静默的**。
 *   · capture 模式在生产 = 所有确认信、收据、提醒被吞掉，没有任何报错，
 *     店主要等到客人打电话来问才会发现
 *   · 固定 OTP 在生产 = 任何人拿这个码就能上任何一台机器
 *
 * 静默失败只能用「起不来」来防 —— 日志里的一条警告没人会看见
 * （`ops/retention.ts` 里选择在应用内定时而不是 pg_cron 是同一个判断）。
 *
 * @throws Error 让 `main.ts` 直接退出。这里不用 AppError：它还没有 HTTP 语境。
 */
export function assertCommunicationSafety(env: Env = process.env): void {
  if (!isProductionEnv(env)) return;

  const violations: string[] = [];
  if (deliveryMode(env) === 'capture') {
    violations.push('COMMUNICATION_DELIVERY_MODE=capture（生产环境的邮件与短信必须真的发出去）');
  }
  if (env['STAGING_OTP_CODE']) {
    violations.push('STAGING_OTP_CODE 已配置（固定验证码在生产等于人人可上机）');
  }
  if (env['STAGING_OTP_PHONES']) {
    violations.push('STAGING_OTP_PHONES 已配置（测试号码白名单只属于 local/staging）');
  }
  if (env['MAILPIT_URL']) {
    violations.push('MAILPIT_URL 已配置（本机测试收件箱只属于 local）');
  }

  if (violations.length > 0) {
    throw new Error(
      '拒绝以生产身份启动：检测到只属于 local/staging 的通信测试开关。\n'
      + violations.map((v) => `  · ${v}`).join('\n')
      + '\n把它们从生产环境变量里删掉，或者确认这台机器的 GF_ENV 是不是设错了。',
    );
  }
}
