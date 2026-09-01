-- ════════════════════════════════════════════════════════════════════════════
--  0089 · 运营台看得到「这家店的外发消息卡在哪一道闸门」
--
--  ## 为什么需要
--
--  0088 给营销消息加了两道闸门：短信要门店 10DLC `approved`，邮件要门店
--  专属发件域名在 Resend 验证过。两道都关着时，店主把设置页里的开关全部
--  打开也一条都发不出去 —— **而这是有意的**。
--
--  但运营侧此前看不到发件域名这一项，「这家店为什么收不到营销邮件」这个
--  问题只能靠连库查一列来回答。
--
--  ## ⚠️ 为什么新开一个函数，而不是往 store_detail 里加字段
--
--  `gf_platform_store_detail` 是一个两百行的 `jsonb_build_object`，运营台
--  整个门店页都读它。为了两个字段去 `create or replace` 整份函数体，等于
--  把那两百行重抄一遍 —— 抄错一个列名不会报错，只会让运营台上某一块数据
--  静默变成 null，而那种缺陷要等有人发现「这里怎么空了」才暴露。
--
--  新开一个窄函数是纯增量的：老函数一个字符不动，新面板多发一次请求。
--
--  ⚠️ 本函数**只读**。写入走 `platform.setMarketingEmail`
--  （`apps/api/src/platform/commands.ts`），那一条会先问 Resend
--  域名验没验过，验过了才写。
-- ════════════════════════════════════════════════════════════════════════════

create or replace function gf_platform_messaging_panel(p_location_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  loc record;
begin
  perform gf_platform_assert_operator();
  if p_location_id is null then
    raise exception 'location_required' using errcode = '22023';
  end if;

  select
    l.id, l.org_id, l.slug, l.email,
    l.marketing_email_from, l.appointment_email_copy_to_shop,
    r.status as dlc_status, r.reviewed_at as dlc_reviewed_at
  into loc
  from locations l
  left join location_10dlc_registrations r on r.location_id = l.id
  where l.id = p_location_id;

  if loc.id is null then
    return null;
  end if;

  return jsonb_build_object(
    'locationId', loc.id,
    'orgId', loc.org_id,
    /*
     * ⭐ `slug` 要给出来：营销发件子域是按它算的
     * （`apps/api/src/email/marketingDomain.ts` 的 domainLabelFromSlug），
     * 运营在点「检查并启用」之前要能看出算出来会是哪个域名。
     */
    'slug', loc.slug,
    'shopEmail', loc.email,

    -- 闸门一：门店自己的 10DLC。营销短信、技师通知、前台手打都卡在这里
    'tenDlcStatus', coalesce(loc.dlc_status, 'not_submitted'),
    'tenDlcReviewedAt', loc.dlc_reviewed_at,

    -- 闸门二：营销邮件的门店专属发件地址。null = 未就绪，一封都不发
    'marketingEmailFrom', loc.marketing_email_from,

    -- 预约类邮件是否抄送门店（店主自己也能在设置页里改）
    'appointmentEmailCopyToShop', coalesce(loc.appointment_email_copy_to_shop, true)
  );
end;
$$;

revoke all on function public.gf_platform_messaging_panel(uuid)
  from public, anon, authenticated;
grant execute on function public.gf_platform_messaging_panel(uuid) to app_user;

comment on function public.gf_platform_messaging_panel(uuid) is
  '运营台：这家店的外发消息卡在哪一道闸门（10DLC 状态 + 营销发件地址）。'
  '只读；写入走 platform.setMarketingEmail，那一条会先向 Resend 核验域名（0089）。';
