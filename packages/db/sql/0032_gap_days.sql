-- ════════════════════════════════════════════════════════════════════════════
--  0032 · 断档的日子：区分「那天做了 0 块」和「那天没人记」
--
--  背景：门店会有整天不用系统的时候 —— 前台请假、太忙、干脆用回纸本子。
--  这件事**本身完全正常**，系统不该阻止，也不该因此变成第二天的障碍。
--
--  但在 0032 之前，这三种情况在库里长得一模一样（都是「没有 tickets，
--  day_closes 要么没有要么停在 open」）：
--
--      A. 那天没营业（休息 / 下雪 / 装修）
--      B. 那天开着门，用纸记的
--      C. 那天该记但忘了，现在还想补
--
--  分不清的代价不是少个数字，而是**报表在撒谎且看不出来** ——
--  `group by business_date` 让没记的那天根本不出现在结果里，
--  周合计静默偏低。老板哪天发现周报是错的，从那一刻起
--  他不再信这个系统里的任何数字。断档不致命，因断档失去信任才致命。
--
--  所以加三个**终态**（终态 = 标完就不再进「没记完的日子」提醒）：
--
--    no_business  那天没营业。报表里是**真实的 0**，进平均值不失真。
--    paper_only   开着门用纸记的，不补了。报表里是**空白**，合计不含它。
--                 这不是错误，是一条诚实的记录。
--    summary_only 补了个总数进来。营业额对得上，**但提成算不出来** ——
--                 系统不知道哪一单是谁做的，所以别假装知道。
--
--  ⭐「不补」必须是一个正式的、点完就不再烦人的选择（paper_only）。
--     没有这条出路，横幅会一直挂着，而前台学会的第一件事是无视所有横幅。
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1. 补录列 ──────────────────────────────────────────────────────────────
--
-- 故意**不复用**上面那组 gross/net/tax 快照列。那一组是封账时从真实工单
-- 算出来的，这一组是人照着纸本子敲的。混在一列里，第二年查账的人
-- 就再也分不清哪个数背后有单据 —— 而这正是审计时唯一要紧的问题。
alter table day_closes add column if not exists backfill_gross_cents    integer;
alter table day_closes add column if not exists backfill_cash_cents     integer;
alter table day_closes add column if not exists backfill_card_cents     integer;
alter table day_closes add column if not exists backfill_tip_cash_cents integer;
alter table day_closes add column if not exists backfill_tip_card_cents integer;
alter table day_closes add column if not exists gap_note  text;
alter table day_closes add column if not exists marked_by uuid;
alter table day_closes add column if not exists marked_at timestamptz;

-- ── 2. status 放开到六个值 ─────────────────────────────────────────────────
alter table day_closes drop constraint if exists day_close_status_valid;
alter table day_closes add constraint day_close_status_valid
  check (status in (
    'open','counted','closed',                  -- 正常路径
    'no_business','paper_only','summary_only'   -- 断档终态
  ));

-- ⚠️ 0009 的 day_close_needs_count 说的是「closed 必须先点钞」。
-- 那条对断档终态天然不适用（status <> 'closed' 就放行），不用改。
-- 这行注释留着，是为了让下一个人不必再去翻 0009 确认这件事。

-- ── 3. ⭐ 补录的天必须真的带着数 ───────────────────────────────────────────
--
-- 「标成 summary_only 但一个数都没填」= 制造了一条比空白更坏的记录：
-- 报表会把它当成有数据的一天，而它其实是空的。DB 层兜死。
alter table day_closes drop constraint if exists summary_needs_numbers;
alter table day_closes add constraint summary_needs_numbers
  check (
    status <> 'summary_only'
    or (backfill_gross_cents is not null and backfill_gross_cents >= 0)
  );

-- 反过来也要兜：不是 summary_only 的天不许留着补录的数。
-- 否则「补了总数 → 又改成没营业」会留下一组孤儿数字，
-- 而报表那边只看 status，不会发现它们还在。
alter table day_closes drop constraint if exists backfill_only_when_summary;
alter table day_closes add constraint backfill_only_when_summary
  check (
    status = 'summary_only'
    or (backfill_gross_cents is null and backfill_cash_cents is null
        and backfill_card_cents is null and backfill_tip_cash_cents is null
        and backfill_tip_card_cents is null)
  );

-- 现金 + 刷卡不能超过总额。允许小于（老板可能只记得总数，懒得拆），
-- 但超过就一定是敲错了 —— 这种错第二天没人查得出来。
alter table day_closes drop constraint if exists backfill_split_sane;
alter table day_closes add constraint backfill_split_sane
  check (
    status <> 'summary_only'
    or coalesce(backfill_cash_cents, 0) + coalesce(backfill_card_cents, 0)
       <= backfill_gross_cents
  );

-- 补录金额一律非负。钱是整数分（宪法第 4 条），负的营业额没有含义。
alter table day_closes drop constraint if exists backfill_non_negative;
alter table day_closes add constraint backfill_non_negative
  check (
    coalesce(backfill_gross_cents,    0) >= 0
    and coalesce(backfill_cash_cents,     0) >= 0
    and coalesce(backfill_card_cents,     0) >= 0
    and coalesce(backfill_tip_cash_cents, 0) >= 0
    and coalesce(backfill_tip_card_cents, 0) >= 0
  );

-- ── 4. 报表要按日期区间铺满，这个索引是那条查询的支撑 ─────────────────────
-- 铺满区间意味着每天都要去 day_closes 找一次「这天被标过吗」。
create index if not exists day_closes_range_idx
  on day_closes (location_id, business_date, status);
