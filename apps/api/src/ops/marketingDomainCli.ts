/**
 * 营销发件地址的运维入口。
 *
 * ```
 * # 看一眼每家门店会拿到什么地址，以及有没有标签冲突（不调供应商、不写库）
 * pnpm --filter @gf/api marketing-domain plan <operator-user-id> [搜索词]
 *
 * # 查营销域在当前供应商处的状态（只读）
 * pnpm --filter @gf/api marketing-domain status
 *
 * # 给一家店启用（核验通过才写 locations.marketing_email_from）
 * pnpm --filter @gf/api marketing-domain enable <operator-user-id> <location-id> [label]
 * ```
 *
 * ## ⚠️ 2026-09-02：`create` 子命令已移除
 *
 * 上一版每店一个子域，需要「建域名 → 人工加 DNS → 核验」三步，`create` 负责
 * 第一步。现在营销域是一个所有门店共用的固定域（`mkt.geniefront.com`），
 * 前两步都不存在了 —— 保留一个建域名的命令只会让人以为还需要为每家店做点什么。
 *
 * `plan` 之外的子命令都会**真的调用供应商接口**（只读核验，不做任何修改）。
 *
 * ⚠️ 带 `<operator-user-id>` 的子命令需要一个**平台运营账号的 user id**。门店
 * 信息与 `locations` 的写入都是跨租户操作，而应用侧没有可见全部租户的连接
 * （宪法第 5 条）—— 直接 `select * from locations` 在 RLS 之下返回空集。因此
 * 一律走运营台那条已带权限校验的路径（`gf_platform_*`），取得 orgId 之后再
 * `withTenant` 写入。
 */

import { sql, withTenant, platformSearchStores, platformStoreDetail } from '@gf/db';
import {
  marketingDomainStatus, marketingDomain, explainDomainProblem,
  domainLabelFromSlug, marketingAddressFor,
} from '../email/marketingDomain';
import { emailProvider } from '../email/provider';

function labelFor(loc: { slug: string }, override?: string): string {
  return override ?? domainLabelFromSlug(loc.slug);
}

/** `gf_platform_search_stores` 的返回中本模块只使用这三个字段。 */
interface StoreHit { locationId: string; slug: string | null; locationName: string | null }

async function plan(operatorUserId: string, query = ''): Promise<void> {
  const res = await platformSearchStores(operatorUserId, query, 100) as
    { items?: StoreHit[] } | null;
  const items = res?.items ?? [];
  if (items.length === 0) {
    console.log('没有匹配的门店（或该 user id 不是平台运营账号）。');
    return;
  }

  console.log(`营销发件域：${marketingDomain()}（供应商 ${emailProvider()}）\n`);
  console.log('门店 → 将要使用的营销发件地址：\n');
  const seen = new Map<string, string>();
  for (const hit of items) {
    if (!hit.slug) continue;
    const label = labelFor({ slug: hit.slug });
    const dup = seen.get(label);
    seen.set(label, hit.locationId);

    console.log(`  ${hit.locationName ?? hit.slug}`);
    console.log(`    id     ${hit.locationId}`);
    console.log(`    地址   ${marketingAddressFor(label)}`);
    if (dup) {
      /*
       * ⚠️ 不自动追加数字后缀。`lotusspa2@…` 在收件人看来近似仿冒，
       * 第二家门店使用何种标签必须由人工决定。
       */
      console.log(`    ⚠️ 与 ${dup} 标签冲突，enable 时必须显式传入 label 参数`);
    }
    console.log('');
  }
}

async function status(): Promise<void> {
  const d = await marketingDomainStatus();
  console.log(`供应商     ${emailProvider()}`);
  console.log(`营销发件域 ${d.name}`);
  console.log(`状态       ${d.status}`);
  if (d.status !== 'verified') {
    console.log('');
    console.log(explainDomainProblem(d));
  }
}

interface Overview { locationId: string; orgId: string; slug: string; locationName: string }

async function overviewOf(operatorUserId: string, locationId: string): Promise<Overview> {
  const detail = await platformStoreDetail(operatorUserId, locationId) as
    { overview?: Overview } | null;
  const ov = detail?.overview;
  if (!ov?.slug) {
    throw new Error(`无法取得门店 ${locationId}（id 有误，或该 user id 不是平台运营账号）`);
  }
  return ov;
}

async function enable(
  operatorUserId: string, locationId: string, label?: string,
): Promise<void> {
  const ov = await overviewOf(operatorUserId, locationId);
  const tenant = { orgId: ov.orgId, locationId: ov.locationId, membershipId: null };

  const [row] = await withTenant(tenant, (tx) => tx<{ from_addr: string | null }[]>`
    select marketing_email_from as from_addr from locations where id = ${ov.locationId}`);
  if (row?.from_addr) {
    throw new Error(`该门店已配置 ${row.from_addr}，如需更换请先清空该列`);
  }

  /*
   * ⚠️ 先核验再写库。`marketing_email_from` 的语义是「已就绪」，
   * 提前写入会让营销邮件从一个不可用的域发出去，整批退信 ——
   * 而退信率同样计入发信域名信誉。
   */
  const d = await marketingDomainStatus();
  if (d.status !== 'verified') {
    console.log(explainDomainProblem(d));
    return;
  }

  const addr = marketingAddressFor(labelFor(ov, label));
  await withTenant(tenant, (tx) => tx`
    update locations set marketing_email_from = ${addr} where id = ${locationId}`);
  console.log(`已写入 locations.marketing_email_from = ${addr}`);
  console.log('该门店的营销邮件自此可以发送（前提是通知规则也已开启）。');
}

async function main(): Promise<void> {
  const [cmd, a, b, c] = process.argv.slice(2);
  switch (cmd) {
    case 'plan':
      if (!a) throw new Error('用法：marketing-domain plan <operator-user-id> [搜索词]');
      await plan(a, b ?? ''); break;
    case 'status':
      await status(); break;
    case 'enable':
      if (!a || !b) {
        throw new Error('用法：marketing-domain enable <operator-user-id> <location-id> [label]');
      }
      await enable(a, b, c); break;
    case 'create':
    case 'verify':
      // 2026-09-02 起营销域只有一个固定域，这两步不复存在
      throw new Error(
        '营销域现在是所有门店共用的一个固定域，不需要逐店创建或验证。\n'
        + '查状态用：marketing-domain status；给一家店启用用：marketing-domain enable',
      );
    default:
      console.log('子命令：plan <operator-user-id> [搜索词]'
        + ' | status'
        + ' | enable <operator-user-id> <location-id> [label]');
      process.exitCode = 2;
  }
  await sql.end();
}

void main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
