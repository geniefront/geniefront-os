/**
 * Stripe webhook 的开户分支（docs/12 §3 A，契约见 docs/11 §3）。
 *
 * 官网和这个系统之间**只有一个接触面**：Checkout Session 上的 metadata。
 * 官网收钱、我们建店 —— webhook 只归我们收，两边都收必然出现
 *「官网以为开好了、我们这边没开」，而钱已经收了。
 *
 * ## 这条分支和别的 webhook 事件的区别
 *
 * 别的事件靠 `gf_location_id` 定位门店 —— 那是我们自己在创建 Stripe 对象时
 * 写进去的。而**新客还没有门店**，官网也不可能知道一个还不存在的 id。
 * 所以这条分支的顺序是反的：先建店，再把 id 回写到 Stripe 上，
 * 让**后续**所有事件（续费、退订、扣款失败）都能定位到这家店。
 *
 * 回写那一步漏掉的话，症状是：开店当时一切正常，一个月后第一次续费
 * 回来我们认不出是谁 —— 而那时候已经没人记得这里发生过什么。
 */

import type { FastifyBaseLogger } from 'fastify';
import { provisionTenant, withTenant } from '@gf/db';
import { stripeClient, type Stripe } from '../stripe/client';
import { sendActivationEmail, activationRedirectUrl } from './activation';
import { ownerLocaleFromStripe } from '../email/locale';

export interface SignupOutcome {
  orgId: string;
  locationId: string;
  /** true = Stripe 重投，这家店之前就建好了 */
  already: boolean;
}

/** 官网必须传的那一份（docs/11 §3）。少一个我们就建不出门店，而钱已经收了 */
interface SignupMetadata {
  shopName: string;
  ownerEmail: string;
  businessType: string;
  timezone: string;
  locale: string;
  plan: string;
  phone: string | null;
}

export function isSignupSession(session: Stripe.Checkout.Session): boolean {
  return session.metadata?.['gf_signup'] === '1'
    // 老客户在系统里自己点的订阅带的是 gf_location_id —— 那条路不是开户
    && !session.metadata?.['gf_location_id'];
}

/**
 * 邮箱一致性校验。
 *
 * 🔴 这是整份对接契约里**唯一一条安全要求**（docs/11 §3）：
 * 激活邮件发到哪个邮箱，决定了谁能成为这家店的老板。两个字段可以不一致的话，
 * 就存在「A 付钱、激活链接发给 B」这条路 —— 而 B 拿到的是一家已付费门店的
 * 完全控制权。
 *
 * 不一致就**一行都不写**，只告警。
 */
function emailsAgree(session: Stripe.Checkout.Session, claimed: string): boolean {
  const paid = session.customer_email ?? session.customer_details?.email ?? '';
  const norm = (s: string): string => s.trim().toLowerCase();
  return norm(paid) !== '' && norm(paid) === norm(claimed);
}

function readMetadata(session: Stripe.Checkout.Session): SignupMetadata {
  const m = session.metadata ?? {};
  /*
   * ⭐ 语言以**会话对象上的 `locale`** 为准，metadata 只作回退。
   *
   * 该字段即结账页实际渲染所用的语言（由 `signup/checkout.ts` 显式下发）。
   * 以它为准而非 metadata，是因为 metadata 可能因历史版本缺失或被人工改动，
   * 而 `session.locale` 由 Stripe 自身记录，与店主当时看到的页面一一对应。
   *
   * 二者皆不可用时回退 `'en'` —— 店主确认的默认语言。
   */
  const locale = ownerLocaleFromStripe(session.locale)
    ?? ownerLocaleFromStripe(m['gf_locale'])
    ?? 'en';
  return {
    shopName: m['gf_shop_name'] ?? '',
    ownerEmail: m['gf_owner_email'] ?? '',
    businessType: m['gf_business_type'] ?? '',
    timezone: m['gf_timezone'] ?? '',
    locale,
    plan: m['gf_plan'] ?? '',
    phone: m['gf_phone'] || null,
  };
}

/**
 * 建店。返回 null = **拒绝**（调用方照常回 200，别让 Stripe 重投一件
 * 我们本来就不会做的事）。
 *
 * 归一化（业态/语言/时区认不出时的回退）全在 `gf_provision_tenant` 里做：
 * 拒绝的话钱已经收了而店建不出来，所以那些字段一律回退 + 原样留档，
 * 让老板在开店向导第一步确认一次（docs/12 §3 C1）。
 */
export async function provisionFromSession(
  session: Stripe.Checkout.Session,
  log: FastifyBaseLogger,
): Promise<SignupOutcome | null> {
  const meta = readMetadata(session);

  if (!meta.ownerEmail || !emailsAgree(session, meta.ownerEmail)) {
    // ⭐ 告警，然后什么都不做。这是这条链路上最不该被静默吞掉的一件事
    log.error({
      session: session.id,
      customerEmail: session.customer_email ?? session.customer_details?.email ?? null,
      metadataEmail: meta.ownerEmail || null,
    }, 'signup rejected: gf_owner_email 与 customer_email 不一致');
    return null;
  }

  const out = await provisionTenant({
    checkoutSessionId: session.id,
    shopName: meta.shopName,
    ownerEmail: meta.ownerEmail,
    businessType: meta.businessType,
    timezone: meta.timezone,
    locale: meta.locale,
    plan: meta.plan,
    phone: meta.phone,
    metadata: { ...(session.metadata ?? {}) },
  });

  log.info({ session: session.id, ...out }, out.already ? 'signup replayed' : 'signup provisioned');
  return out;
}

/**
 * 开户被拒之后，把那条订阅取消掉。
 *
 * ⭐ 只在 `provisionFromSession` 返回 null（邮箱不一致）时走这条路。
 * 那一刻的事实是：**钱已经收了（或者试用已经开始），而门店一家都没建**。
 * 不取消的话，Stripe 那边留着一条活订阅，到期照扣，客户下个月看到
 * 一笔他既没有账号也没有门店的账单 —— 那是最难解释的一种投诉。
 *
 * ⚠️ 失败只记日志。调用方已经决定回 200（重投一百次答案也一样），
 * 为一次取消失败让整条 webhook 反复重投是错的；这一行日志足够人工补。
 */
export async function cancelDanglingSignupSubscription(
  session: Stripe.Checkout.Session,
  log: FastifyBaseLogger,
): Promise<void> {
  const subId = typeof session.subscription === 'string'
    ? session.subscription : session.subscription?.id;
  if (!subId) return;
  try {
    await stripeClient().subscriptions.cancel(subId);
    log.warn({ session: session.id, subscription: subId },
             'signup rejected: 已取消这条无主订阅');
  } catch (e) {
    log.error({ err: e, session: session.id, subscription: subId },
              'signup rejected: 取消无主订阅失败 —— 需要人工在 Stripe 后台处理');
  }
}

/**
 * 把门店 id 回写到 Stripe 的客户与订阅上。
 *
 * ⭐ **后续每一条事件都靠它定位门店。** 官网建 session 的时候写不了
 * （那时门店还不存在），所以只能在这里补。
 *
 * 失败只记日志：门店已经建好了，回写不上是可以人工补的，
 * 而为此把整条 webhook 判失败会让 Stripe 一直重投一件已经做完的事。
 */
export async function backfillStripeMetadata(
  session: Stripe.Checkout.Session,
  t: SignupOutcome,
  log: FastifyBaseLogger,
): Promise<void> {
  const meta = { gf_location_id: t.locationId, gf_org_id: t.orgId };
  const stripe = stripeClient();
  const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id;
  const subId = typeof session.subscription === 'string'
    ? session.subscription : session.subscription?.id;

  try {
    if (customerId) await stripe.customers.update(customerId, { metadata: meta });
    if (subId) await stripe.subscriptions.update(subId, { metadata: meta });
  } catch (e) {
    log.error({ err: e, session: session.id, ...t }, 'signup: 回写 Stripe metadata 失败');
  }
}

/**
 * 发激活信，并记下「发过了」。
 *
 * ⚠️ 三条顺序不能动：
 *   1. **先建店再发信**。反过来的话信发出去了但建店失败，
 *      老板点进来看到「你不属于任何门店」，而钱已经付了（docs/12 §3 A5）
 *   2. **在事务提交之后发**。事务里发的话，回滚了信也收不回来（§4.4）
 *   3. **一封就够**。Supabase 每发一封新的 magic link 就让上一封失效 ——
 *      两封信里只有一封是活的，老板会点错那封（§2.2）
 */
export async function sendActivationOnce(
  t: SignupOutcome,
  ownerEmail: string,
  log: FastifyBaseLogger,
): Promise<void> {
  const tenant = { orgId: t.orgId, locationId: t.locationId, membershipId: null };

  /**
   * ⭐ **先占位，再发信。**（和自动续充那一步同一个纪律：sql/0018）
   *
   * 反过来的话，两条并发的重投会同时看到「还没发过」，然后各发一封 ——
   * 而后发的那封会让先发的那封失效，老板手里两封信都点不动。
   * 这个 update 是原子的：只有抢到那一行的人才去发信。
   */
  const [claimed] = await withTenant(tenant, (tx) => tx<{ id: string }[]>`
    update signup_intents set activation_email_sent_at = now()
    where location_id = ${t.locationId} and activation_email_sent_at is null
    returning id`);

  if (!claimed) return;   // 发过了

  const res = await sendActivationEmail({
    email: ownerEmail, redirectTo: activationRedirectUrl(),
  });

  if (res.ok) {
    log.info({ ...t, email: ownerEmail }, 'signup: 激活信已发出');
    return;
  }

  /**
   * 发不出去**不回滚建店** —— 门店已经建好了，钱也收了，
   * 那家店本身是对的（docs/12 §3 A5）。把占位清掉让下一次重投能再试，
   * 清不掉也不要紧：这一列为空/非空都能一眼看出「这家店的信到底发出去没有」，
   * 客服照着补发就是了。
   */
  await withTenant(tenant, (tx) => tx`
    update signup_intents set activation_email_sent_at = null
    where id = ${claimed.id}`).catch(() => {});

  log.error({ ...t, email: ownerEmail, reason: res.reason },
    'signup: 激活信发送失败 —— 门店已建好，可人工补发');
}
