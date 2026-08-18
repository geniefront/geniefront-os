-- ════════════════════════════════════════════════════════════════════════════
--  0028 · 哪些语言是机器补的（05 §4.4）
--
--  项目名是 i18n map，但模型只认得出价目表上印的那一种语言，其余是补的。
--  `name_auto` 记的是**哪几个语言格是机器填的**。
--
--  为什么单独一列而不是塞进 name 里（比如 `{ _auto: [...] }`）：
--  `name` 那个 jsonb 被 pickText 当成纯粹的「语言 → 文本」表来读，
--  混一个下划线开头的键进去，任何一处忘了过滤就会把 `_auto` 当成一种语言
--  显示给客人看。
--
--  ⭐ 这一列只影响**显示**（淡色 + 「机器补的」提示），不影响任何计算。
--     老板改了某一格，那一格就从这个表里去掉 —— 不清的话他亲手写的名字
--     会一直显示成淡色，他会以为自己那次修改没保存。
-- ════════════════════════════════════════════════════════════════════════════

alter table blueprint_items
  add column if not exists name_auto jsonb not null default '[]'::jsonb;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'blueprint_items_name_auto') then
    alter table blueprint_items add constraint blueprint_items_name_auto
      check (jsonb_typeof(name_auto) = 'array');
  end if;
end $$;

comment on column blueprint_items.name_auto is
  '机器补齐的语言代码数组，如 ["zh-Hans","ko"]。老板改过某格就把它去掉。'
  '只影响显示（淡色），不参与任何计算。';
