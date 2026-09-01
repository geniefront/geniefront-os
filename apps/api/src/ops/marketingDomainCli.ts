/**
 * 营销发件域名的运维入口（`email/marketingDomain.ts` 的三步流程）。
 *
 * ```
 * # 1. 看一眼要给谁开、算出来的子域长什么样（不动 Resend、不动库）
 * pnpm --filter @gf/api marketing-domain plan <operator-user-id> [搜索词]
 *
 * # 2. 在 Resend 建 domain，打印要加的 DNS 记录
 * pnpm --filter @gf/api marketing-domain create <operator-user-id> <location-id> [label]
 *
 * # 3. DNS 加完之后验证；通过才把发件地址写进 locations
 * pnpm --filter @gf/api marketing-domain verify <operator-user-id> <location-id> [label]
 * ```
 *
 * ⚠️ 三个子命令都要一个**平台运营账号的 user id**。门店信息与 `locations`
 * 的写入都是跨租户操作，而应用侧没有能看见所有租户的连接（宪法第 5 条）——
 * 直接 `select * from locations` 在 RLS 之下返回空集。因此一律走运营台那条
 * 已经带权限校验的路（`gf_platform_*`），拿到 orgId 之后再 `withTenant` 写入。
 *
 * ## ⚠️ 为什么是 CLI 而不是一条命令 / 一个设置页开关
 *
 * 中间那一步（加 DNS 记录）需要域名管理权限，不在本服务的能力范围内 ——
 * 做成设置页开关的话，店主点完看到的是「处理中」，然后永远处理中。
 * 这条流程本质上要人介入，那就让它显式地由人来跑。
 *
 * ⚠️ `plan` 之外的两个子命令都会**真的动 Resend 账号**。
 */

import { sql, withTenant, platformSearchStores, platformStoreDetail } from '@gf/db';
import {
  createDomain, verifyDomain, getDomain,
  domainLabelFromSlug, marketingDomainFor, marketingAddressFor,
  formatDnsInstructions,
} from '../email/marketingDomain';

function labelFor(loc: { slug: string }, override?: string): string {
  return override ?? domainLabelFromSlug(loc.slug);
}

/** `gf_platform_search_stores` 的返回里我们只用得上这三个字段。 */
interface StoreHit { locationId: string; slug: string | null; locationName: string | null }

async function plan(operatorUserId: string, query = ''): Promise<void> {
  const res = await platformSearchStores(operatorUserId, query, 100) as
    { items?: StoreHit[] } | null;
  const items = res?.items ?? [];
  if (items.length === 0) {
    console.log('没有匹配的门店（或这个 user id 不是平台运营账号）。');
    return;
  }

  console.log('门店 → 将要使用的营销发件地址（尚未创建）：\n');
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
       * ⚠️ 不自动加数字后缀。`lotusspa2@…` 看起来就像仿冒，
       * 第二家店叫什么必须由人来定。
       */
      console.log(`    ⚠️ 与 ${dup} 撞标签，create 时必须显式传 label 参数`);
    }
    console.log('');
  }
}

interface Overview { locationId: string; orgId: string; slug: string; locationName: string }

async function overviewOf(operatorUserId: string, locationId: string): Promise<Overview> {
  const detail = await platformStoreDetail(operatorUserId, locationId) as
    { overview?: Overview } | null;
  const ov = detail?.overview;
  if (!ov?.slug) {
    throw new Error(`拿不到门店 ${locationId}（id 不对，或这个 user id 不是平台运营账号）`);
  }
  return ov;
}

async function currentAddress(ov: Overview): Promise<string | null> {
  const [row] = await withTenant(
    { orgId: ov.orgId, locationId: ov.locationId, membershipId: null },
    (tx) => tx<{ from_addr: string | null }[]>`
      select marketing_email_from as from_addr from locations where id = ${ov.locationId}`);
  return row?.from_addr ?? null;
}

async function create(
  operatorUserId: string, locationId: string, label?: string,
): Promise<void> {
  const ov = await overviewOf(operatorUserId, locationId);
  const existing = await currentAddress(ov);
  if (existing) {
    throw new Error(`这家店已经配了 ${existing}，`
      + '要换域名请先清空该列并在 Resend 里删掉旧 domain');
  }

  const name = marketingDomainFor(labelFor(ov, label));
  console.log(`门店：${ov.locationName}`);
  console.log(`正在 Resend 创建 ${name} …\n`);
  const domain = await createDomain(name);
  console.log(formatDnsInstructions(domain));
  console.log('');
  console.log(`记下这个 domain id：${domain.id}`);
  console.log(`DNS 生效后跑：marketing-domain verify ${operatorUserId} ${locationId}`);
}

async function verify(
  operatorUserId: string, locationId: string, label?: string,
): Promise<void> {
  const ov = await overviewOf(operatorUserId, locationId);
  const name = marketingDomainFor(labelFor(ov, label));
  const { data } = await import('../email/marketingDomain')
    .then((m) => m.listDomains());
  const found = data.find((d) => d.name === name);
  if (!found) throw new Error(`Resend 里没有 ${name}，先跑 create`);

  await verifyDomain(found.id);
  const fresh = await getDomain(found.id);
  console.log(`${name} 当前状态：${fresh.status}`);

  if (fresh.status !== 'verified') {
    /*
     * ⚠️ 没验证通过就**不写库**。`marketing_email_from` 的语义是「已就绪」，
     * 提前写进去会让营销邮件在 DNS 还没生效时发出去，全部退信 ——
     * 而退信率同样计入发信信誉。
     */
    console.log('还没通过。DNS 传播通常要几分钟到几十分钟，稍后再跑一次。');
    console.log(formatDnsInstructions(fresh));
    return;
  }

  const addr = marketingAddressFor(labelFor(ov, label));
  await withTenant(
    { orgId: ov.orgId, locationId: ov.locationId, membershipId: null },
    (tx) => tx`update locations set marketing_email_from = ${addr}
               where id = ${locationId}`);
  console.log(`已写入 locations.marketing_email_from = ${addr}`);
  console.log('这家店的营销邮件从现在起可以发了（前提是通知规则也打开）。');
}

async function main(): Promise<void> {
  const [cmd, a, b, c] = process.argv.slice(2);
  switch (cmd) {
    case 'plan':
      if (!a) throw new Error('用法：marketing-domain plan <operator-user-id> [搜索词]');
      await plan(a, b ?? ''); break;
    case 'create':
      if (!a || !b) {
        throw new Error('用法：marketing-domain create <operator-user-id> <location-id> [label]');
      }
      await create(a, b, c); break;
    case 'verify':
      if (!a || !b) {
        throw new Error('用法：marketing-domain verify <operator-user-id> <location-id> [label]');
      }
      await verify(a, b, c); break;
    default:
      console.log('子命令：plan <operator-user-id> [搜索词]'
        + ' | create <operator-user-id> <location-id> [label]'
        + ' | verify <operator-user-id> <location-id> [label]');
      process.exitCode = 2;
  }
  await sql.end();
}

void main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
