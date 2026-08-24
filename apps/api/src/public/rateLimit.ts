/**
 * 公开预约的限频（docs/13 §6.2）。
 *
 * ## 为什么不是门口 iPad 那套内存计数
 *
 * Kiosk 的限频（`kiosk/routes.ts`）按设备计数，放在进程内存里就够：
 * 两台实例各限一半，而攻击者手上只有一台 iPad。
 * 公开入口面对的是**分布式来源** —— 内存计数等于把上限翻倍，
 * 而且滚动发布时计数归零。所以这里必须是共享的。
 *
 * 用 Upstash 的 REST 接口而不是自建 Redis：宪法第 10 条（状态托管，
 * 不自管 Redis）。没有长连接，一次 HTTP 往返。
 *
 * ## ⚠️ 拿不到 Redis 时降级到进程内存，**不是拒绝**
 *
 * 这是个真实的取舍，不是偷懒：限频后端挂掉时拒绝所有预约，等于
 * 「Upstash 抖一下 = 所有门店当天收不到网上订单」。降级之后上限
 * 实际被放宽到「每实例一份」（两台机器 = 两倍），而 Turnstile、蜜罐、
 * 未完成预约上限三道**还在**（docs/13 §6）。
 * 一次限频放宽的代价是可能多进来几十条假单，前台看得见也撤得掉；
 * 拒绝的代价是真实营业额。所以降级，但要在日志里喊。
 */

const REST_URL = () => process.env['UPSTASH_REDIS_REST_URL'];
const REST_TOKEN = () => process.env['UPSTASH_REDIS_REST_TOKEN'];

export interface RateRule {
  /** 维度名，进 key 前缀，也用在错误详情里 */
  scope: string;
  /** 这个维度的取值（ip / 手机号 / location id） */
  id: string;
  limit: number;
  windowSec: number;
}

export interface RateVerdict {
  ok: boolean;
  scope?: string;
  retryAfterSec?: number;
}

/** 测试与本地开发用的内存回退。**不是**生产路径 —— 生产一定有 Upstash */
const MEMORY = new Map<string, { count: number; resetAt: number }>();

export function __resetRateLimit(): void {
  MEMORY.clear();
}

function memoryHit(key: string, rule: RateRule, now: number): RateVerdict {
  const cur = MEMORY.get(key);
  if (!cur || now > cur.resetAt) {
    MEMORY.set(key, { count: 1, resetAt: now + rule.windowSec * 1000 });
    return { ok: true };
  }
  cur.count += 1;
  if (cur.count > rule.limit) {
    return {
      ok: false, scope: rule.scope,
      retryAfterSec: Math.max(1, Math.ceil((cur.resetAt - now) / 1000)),
    };
  }
  return { ok: true };
}

/**
 * INCR + EXPIRE(NX) 一次往返。
 *
 * `NX` 很要紧：每次都无条件 EXPIRE 的话，持续打的人会把窗口一直往后推，
 * 于是那个 key 永远不过期 —— 计数只增不减，最后连他停手一小时之后
 * 都还在被拦。窗口要从**第一次**命中开始算。
 */
async function redisHit(key: string, rule: RateRule): Promise<RateVerdict | null> {
  /**
   * ⚠️ 测试里一律走内存。
   *
   * Upstash 是**共享的**：跑一次测试就在真实的计数器上留下痕迹，
   * 第二次跑同一批用例会撞上第一次留下的上限 —— 表现是「本地随机红一半」，
   * 而且查起来毫无头绪（代码没改，测试自己坏了）。
   */
  if (process.env['NODE_ENV'] === 'test') return null;

  const url = REST_URL();
  const token = REST_TOKEN();
  if (!url || !token) return null;

  const res = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([
      ['INCR', key],
      ['EXPIRE', key, String(rule.windowSec), 'NX'],
      ['TTL', key],
    ]),
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) return null;

  const out = (await res.json()) as Array<{ result?: unknown; error?: string }>;
  const count = Number(out[0]?.result ?? 0);
  if (!Number.isFinite(count) || count <= 0) return null;
  if (count <= rule.limit) return { ok: true };

  const ttl = Number(out[2]?.result ?? rule.windowSec);
  return {
    ok: false, scope: rule.scope,
    retryAfterSec: ttl > 0 ? ttl : rule.windowSec,
  };
}

/**
 * 依次检查多条规则，**第一条超限就返回**。
 *
 * 顺序有意义：先便宜的（IP）后贵的（手机号），而且一旦某条超了
 * 就不再给后面的计数 —— 否则被 IP 挡下的请求还会把那个手机号的额度耗掉，
 * 真客人换个网络重试时会撞上一个他自己没造成的上限。
 */
export async function checkRateLimits(
  rules: readonly RateRule[],
  log?: { warn: (o: unknown, m: string) => void },
): Promise<RateVerdict> {
  const now = Date.now();
  for (const rule of rules) {
    const key = `gf:pub:${rule.scope}:${rule.id}:${rule.windowSec}`;
    let verdict: RateVerdict | null = null;
    try {
      verdict = await redisHit(key, rule);
    } catch (e) {
      verdict = null;
      log?.warn({ err: e, scope: rule.scope }, 'rate limit backend unavailable');
    }
    // Upstash 没配或够不着 —— 退到进程内存。见文件头：宁可放宽也不拒真客人
    verdict ??= memoryHit(key, rule, now);
    if (!verdict.ok) return verdict;
  }
  return { ok: true };
}
