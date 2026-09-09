/**
 * 一封计费通知信的收件人与门店信息。
 *
 * ⭐ 从 `stripe/routes.ts` 抽出来（迁移 0120 / 计划批 5）：订阅码到期提醒
 * 要的是**一模一样**的一份「收件人 + 语言 + 时区 + 店名」。抄第二遍的话，
 * 两处对「找不到 owner 怎么办」「店名按哪种语言取」的处理迟早会不一致 ——
 * 而不一致的表现是某一类信里出现中英混排的店名，没人会当成 bug 报上来。
 */

import type postgres from 'postgres';
import { ownerLocaleOf, isZhLocale, type OwnerLocale } from './locale';

/**
 * 一封计费通知信的收件人与门店信息。
 *
 * ⭐ 收件人**只认 owner**。找不到就不发 —— 宁可不发，也不要发给一个
 * 「我们猜的」邮箱（那可能是某位前台，而信里写的是老板的卡和账单）。
 */
export interface OwnerShop {
  email: string;
  shopName: string;
  timezone: string;
  /** 店主的邮件语言。事实源是 `organizations.default_locale`（`email/locale.ts`） */
  locale: OwnerLocale;
  accountId: string;
  plan: string;
}

export async function ownerShopOf(
  tx: postgres.TransactionSql, locationId: string,
): Promise<OwnerShop | null> {
  const [owner] = await tx<{ email: string | null }[]>`
    select u.email
    from memberships m
    join users u on u.id = m.user_id
    join membership_roles mr on mr.membership_id = m.id
    join roles r on r.id = mr.role_id
    where m.location_id = ${locationId}
      and r.key = 'owner' and m.user_id is not null and u.email is not null
    order by m.created_at asc
    limit 1`;
  if (!owner?.email) return null;

  /*
   * ⚠️ 语言在**组织**上（`organizations.default_locale`），门店表没有这一列。
   * 取不到就退回英语 —— 一封信的语言选错，比因为一次 join 失败而
   * 整封信发不出去要轻得多。
   */
  const [loc] = await tx<{
    name: unknown; timezone: string; default_locale: string | null;
  }[]>`
    select l.name, l.timezone, o.default_locale
    from locations l
    join organizations o on o.id = l.org_id
    where l.id = ${locationId}`;
  const [acct] = await tx<{ id: string; plan: string }[]>`
    select id, plan from billing_accounts where location_id = ${locationId}`;
  if (!acct) return null;

  const nameObj = (loc?.name ?? {}) as Record<string, string>;
  const locale = ownerLocaleOf(loc?.default_locale);
  /*
   * ⚠️ 店名按**收件人的语言**取，英语优先。
   *
   * 此前的取值顺序是 `zh-Hans` 优先且兜底为中文的「你的门店」——
   * 于是一封英文账单邮件的标题与正文里出现中文店名。
   */
  const preferred = isZhLocale(locale)
    ? (nameObj['zh-Hans'] ?? nameObj['zh-Hant'] ?? nameObj['en'])
    : (nameObj['en'] ?? nameObj['zh-Hans']);
  return {
    email: owner.email,
    shopName: preferred ?? Object.values(nameObj)[0]
      ?? (isZhLocale(locale) ? '你的门店' : 'your shop'),
    timezone: loc?.timezone ?? 'UTC',
    locale,
    accountId: acct.id,
    plan: acct.plan,
  };
}
