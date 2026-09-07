-- 0114_staff_directory_id_contract.sql
--
-- 员工目录 ID 契约（U02 / W2）。
--
-- 背景：`staff_profiles.level_id` 早已是 `staff_levels` 的外键，技能走
-- `staff_skills` 关联表，唯独岗位仍只有一列自由文本 `staff_profiles.job_title`。
-- `staff_job_titles` 目录表在 `0109` 建好并按 `job_title` 回填，但档案行与目录行
-- 之间没有稳定关联 —— 改名、切语言、跨店同名都会让「岗位」这个字段失联。
--
-- 这条迁移只做两件事，都在迁移流程里一次性完成，不恢复运行时自由创建：
--   1. 给 `staff_profiles` 补 `job_title_id`，按规范化同店同名回填；
--      仍匹配不到的历史值补建为本店目录项后再关联。
--   2. 提供一个只读盘点视图，供运营在切换前后核对遗留自由文本的归属。
--
-- 全文可重复执行。

-- 1. 关联列 -------------------------------------------------------------------

alter table staff_profiles
  add column if not exists job_title_id uuid references staff_job_titles(id);

create index if not exists staff_profiles_job_title_id_idx
  on staff_profiles (job_title_id);

-- 2. 回填：规范化（去空白 + 小写）后按同店同名匹配 --------------------------
--    `0109` 建 `staff_job_titles` 时用的是原始 `job_title` 值，可能带首尾空白，
--    因此这里用规范化比较，并在多行命中时取「启用优先、sort 靠前」的一条。

update staff_profiles sp
set job_title_id = (
  select jt.id from staff_job_titles jt
  where jt.location_id = sp.location_id
    and lower(btrim(jt.name)) = lower(btrim(sp.job_title))
  order by jt.active desc, jt.sort, jt.id
  limit 1
)
where sp.job_title_id is null
  and nullif(btrim(sp.job_title), '') is not null;

-- 3. 仍匹配不到的历史自由值：补建为本店目录项（迁移流程内，非运行时）------
--    命名冲突由 `staff_job_titles` 的 `unique(location_id, name)` 兜底，
--    `on conflict do nothing` 后下一句再关联。

insert into staff_job_titles (org_id, location_id, name, sort, active)
select distinct sp.org_id, sp.location_id, btrim(sp.job_title),
       9000,          -- 排在人工维护项之后
       true
from staff_profiles sp
where sp.job_title_id is null
  and nullif(btrim(sp.job_title), '') is not null
on conflict (location_id, name) do nothing;

update staff_profiles sp
set job_title_id = (
  select jt.id from staff_job_titles jt
  where jt.location_id = sp.location_id
    and lower(btrim(jt.name)) = lower(btrim(sp.job_title))
  order by jt.active desc, jt.sort, jt.id
  limit 1
)
where sp.job_title_id is null
  and nullif(btrim(sp.job_title), '') is not null;

-- 4. 只读盘点视图 -----------------------------------------------------------
--    切换 ID 契约前后运营用它核对：每个仍带自由文本岗位的档案是否已锁定到
--    一条目录行，以及该目录行是否启用。正常情况下 `resolved_job_title_id`
--    应当全部非空；若之后自由文本路径回归，未解析的行会在这里冒出来。

create or replace view staff_directory_legacy_audit
with (security_invoker = true) as
select
  sp.location_id,
  sp.membership_id,
  sp.job_title                                   as legacy_job_title_text,
  sp.job_title_id                                as resolved_job_title_id,
  jt.name                                        as resolved_job_title_name,
  jt.active                                      as resolved_job_title_active,
  case
    when nullif(btrim(sp.job_title), '') is null then 'none'
    when sp.job_title_id is null                 then 'unresolved'
    when lower(btrim(jt.name)) = lower(btrim(sp.job_title)) then 'exact'
    else 'normalized'
  end                                            as match_kind
from staff_profiles sp
left join staff_job_titles jt on jt.id = sp.job_title_id;

grant select on staff_directory_legacy_audit to app_user;
