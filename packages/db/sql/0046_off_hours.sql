-- 0046 · 非营业时间可不可以约（老板自己设）
--
-- 起因：`OUTSIDE_BUSINESS_HOURS` 这个错误码从第一天就在错误码表、在
-- `OVERRIDABLE_CODES`、在前台两份 i18n 里 —— **但代码里从来没有人抛过它**。
-- 建单那条路上根本没有营业时间这一层，前台想约凌晨三点就能约成。
--
-- 现在补上这一层，并且把「宽限多久」交给老板：
-- 九点半开门的店，客人想约八点半，老板说行就是行。
--
-- ## 为什么是 settings 里的一个子对象，而不是新建表
--
-- 和 `online_booking` / `ai_change` 同一个理由：它是**三个数字加一个开关**，
-- 不是实体。为它建张表只多出一处「两边不一致」的可能（决策同 0041）。
--
-- ## 默认值 = 现状
--
-- `enforce = false`。**这一条是刻意的**：闸门从来没生效过，
-- 一上来就打开会让所有已经排在营业时间外的单、所有还没配全营业时间的店
-- 在同一个早上集体报错，而没有任何人事先被告知。
-- 老板在后台看过这一页、自己勾上，才开始拦。

update locations
set settings = jsonb_set(
      settings, '{off_hours}',
      coalesce(settings->'off_hours', '{}'::jsonb) || jsonb_build_object(
        -- 总开关。关着 = 前台想约几点约几点（今天的行为）
        'enforce',             coalesce(settings->'off_hours'->'enforce', 'false'::jsonb),
        -- 开门前多久仍算「约得进去」。0 = 一分钟都不提前
        'before_open_minutes', coalesce(settings->'off_hours'->'before_open_minutes', '0'::jsonb),
        -- 关门后多久
        'after_close_minutes', coalesce(settings->'off_hours'->'after_close_minutes', '0'::jsonb),
        -- 超出上面那个窗口时怎么办：
        --   warn  = 前台带 reason 可以放行（和超卖同一个交互）
        --   block = 一律不许，连 reason 都不给
        'beyond',              coalesce(settings->'off_hours'->'beyond', '"warn"'::jsonb)
      ),
      true)
where settings->'off_hours' is null
   or settings->'off_hours'->'enforce' is null;

-- ⚠️ 这里**没有 CHECK 约束**。settings 是一整块 jsonb，给子键加约束
-- 等于让每一次 settings 写入都去解析整棵树 —— 而值域校验已经由
-- `location.saveOffHours` 的 zod 挡在命令总线那一层（宪法第 1 条：
-- 所有写操作走命令）。读取侧一律用 coalesce 兜底，读到脏值也不炸。
