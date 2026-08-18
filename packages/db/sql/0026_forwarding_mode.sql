-- ════════════════════════════════════════════════════════════════════════════
--  0026 · 店家的转接方式（09-TELNYX §2）
--
--  店家在自己运营商那儿设转接时有两种选法，我们要知道他选了哪种 ——
--  因为它决定了「人工客服号 = 对外号」这种填法能不能成立：
--
--    all             所有来电都转给 AI（无条件）
--    busy_no_answer  忙线或没人接才转（默认，也是我们推荐的）
--
--  ⭐ 这一列不是给系统用的，是给**校验和话术**用的。真正生效的开关在
--     店家的运营商那边，我们改不了 —— 所以它记的是「店家说他设的是哪种」。
-- ════════════════════════════════════════════════════════════════════════════

alter table phone_lines
  add column if not exists forwarding_mode text;

do $$
begin
  if not exists (select 1 from pg_constraint
                 where conname = 'phone_lines_forwarding_mode') then
    alter table phone_lines add constraint phone_lines_forwarding_mode
      check (forwarding_mode is null
             or forwarding_mode in ('all','busy_no_answer'));
  end if;
end $$;

comment on column phone_lines.forwarding_mode is
  '只对 purpose=main 有意义：这条线转给 AI 的方式。'
  'all=无条件全转，busy_no_answer=忙线或无应答才转。'
  '⚠️ all + 人工客服号等于本号 = 死循环（转回来又被无条件转走），'
  '在 location.requestAiVoice 里拦死。';
