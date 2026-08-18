-- ════════════════════════════════════════════════════════════════════════════
--  0027 · 转接方式放宽到运营商实际提供的四种（0026 的续）
--
--  0026 只给了 all / busy_no_answer 两档，但电话公司实际提供的是三个独立开关
--  （很多产品把后两个打包成一档）：
--
--    all             Call Forwarding Always      所有来电直接转，店里**不会响**
--    busy            Call Forward Busy           占线时转（前台正在通话）
--    no_answer       Call Forward No Answer      响几声没人接才转
--    busy_no_answer  Busy/No Answer（打包档）    上面两个一起，最常见的默认
--
--  ⭐ 为什么非要把 all 和其它三档分开 —— 这不是分类洁癖，是一条死循环的边界：
--
--    · all      电话**永远不会**在店里响，全部直达 AI。
--               此时「人工客服号 = 对外号」= AI 转给 AI，**100% 死循环**，
--               客人会听见同一句开场白第二遍。必须拦死。
--    · 其它三档 电话**会先在店里响**，AI 转人工时人有机会接起来。
--               两号相同不是必然死循环，只是「没人接就再绕一圈」——
--               **提醒即可，不该拦**。何况店家通常有两条线，本来就不会相同。
-- ════════════════════════════════════════════════════════════════════════════

do $$
begin
  alter table phone_lines drop constraint if exists phone_lines_forwarding_mode;
  alter table phone_lines add constraint phone_lines_forwarding_mode
    check (
      forwarding_mode is null
      or forwarding_mode in ('all','busy','no_answer','busy_no_answer')
    );
end $$;

comment on column phone_lines.forwarding_mode is
  '只对 purpose=main 有意义：这条线转给 AI 的方式。'
  'all=无条件全转（店里不会响）/ busy=占线转 / no_answer=无应答转 / '
  'busy_no_answer=两者打包（最常见）。null=店家还没选。'
  '⚠️ all 且人工客服号=本号 → 必然死循环，在 location.requestAiVoice 里拦死；'
  '其它三档只提醒不拦（电话会先在店里响，人有机会接）。';
