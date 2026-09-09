/**
 * 订阅码的运营侧数据库入口（sql/0120）。
 *
 * 与 `platform.ts` 同一条路子：连的仍然是 `app_user`（没有 BYPASSRLS），
 * 它能做的全部事情就是调用 sql/0120 里那几个 SECURITY DEFINER 窄口，
 * 而**判定逻辑在函数里，不在这一侧** ——
 *
 *   · `gf_license_issue`   自己判 super_admin，自己取 operator id
 *   · `gf_license_revoke`  自己判「兑换过的码不许撤」
 *   · 两个 list/panel 函数自己判 operator
 *
 * ⚠️ `license_codes` / `license_redemptions` 两张表对 `app_user` 是空的
 * （RLS enable + force 且没有 policy）。绕开这些函数直接查会得到零行，
 * 而不是一个报错 —— 所以别绕。
 */

import { withUser } from './client';

export interface LicenseIssueArgs {
  kind: 'subscription' | 'quota_pack' | 'store_open';
  /** sha256(规范化明文)。⚠️ 明文不进数据库 */
  codeHash: string;
  codePrefix: string;
  paymentNote: string;
  /** 码本身的可兑换截止时刻（ISO） */
  validUntil: string;
  plan?: string | null;
  durationDays?: number | null;
  unit?: string | null;
  amount?: number | null;
  amountCents?: number | null;
  targetOrgId?: string | null;
  targetLocationId?: string | null;
  maxRedemptions?: number;
}

export async function licenseIssue(userId: string, a: LicenseIssueArgs): Promise<string> {
  const [row] = await withUser(userId, (tx) => tx<{ id: string }[]>`
    select gf_license_issue(
      ${a.kind}, ${a.codeHash}, ${a.codePrefix}, ${a.paymentNote},
      ${a.validUntil}::timestamptz,
      ${a.plan ?? null}, ${a.durationDays ?? null},
      ${a.unit ?? null}, ${a.amount ?? null}, ${a.amountCents ?? null},
      ${a.targetOrgId ?? null}, ${a.targetLocationId ?? null},
      ${a.maxRedemptions ?? 1}) as id`);
  if (!row) throw new Error('gf_license_issue 没有返回行');
  return row.id;
}

export async function licenseRevoke(
  userId: string, codeId: string, reason: string,
): Promise<{ codeId: string; status: string; already: boolean }> {
  const [row] = await withUser(userId, (tx) => tx<{ d: {
    codeId: string; status: string; already: boolean;
  } }[]>`select gf_license_revoke(${codeId}::uuid, ${reason}) as d`);
  if (!row) throw new Error('gf_license_revoke 没有返回行');
  return row.d;
}

export async function platformListLicenses(
  userId: string,
  f: { status?: string | null; kind?: string | null; query?: string | null },
  limit = 50,
  offset = 0,
): Promise<unknown> {
  const [row] = await withUser(userId, (tx) => tx<{ d: unknown }[]>`
    select gf_platform_list_licenses(
      ${f.status ?? null}, ${f.kind ?? null}, ${f.query ?? null},
      ${limit}::int, ${offset}::int) as d`);
  return row!.d;
}

export async function platformLicensePanel(
  userId: string, locationId: string,
): Promise<unknown> {
  const [row] = await withUser(userId, (tx) => tx<{ d: unknown }[]>`
    select gf_platform_license_panel(${locationId}::uuid) as d`);
  return row!.d;
}
