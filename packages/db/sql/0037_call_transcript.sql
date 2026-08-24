-- ════════════════════════════════════════════════════════════════════════════
--  0037 · 通话记录补齐：会话 id、转录、用过哪些工具、录音
--
--  ## 起因
--
--  2026-08-23 第一通真实电话之后，`phone_calls` 是**空的** —— 而 webhook
--  明明收到了两条。也就是说：一通真实通话打完，我们既不知道它有多长
--  （= 没计语音分钟 = 没扣客户额度），也不知道 AI 在里面说了什么。
--
--  查下来的结论是：**不能只靠 `call.hangup` 这一条 webhook**。它可能配在
--  Telnyx 的 connection 上而不是我们这个地址，也可能换了事件名。
--  而 Telnyx 手里有一份**更全**的东西：AI Assistant 的 conversation ——
--  每通电话一条，带 `to`/`from`/`call_session_id`/`called_tools`、
--  起止时间，以及**完整的逐句转录**（含每次工具调用和它的返回）。
--
--  所以计量改成两条腿：webhook 到了就当场记（快），没到就由对账任务从
--  Telnyx 拉回来补（准）。两条腿写的是同一条命令、同一个幂等键。
--
--  ## 这几列各自解决什么
--
--  · `conversation_id`  Telnyx 那边的会话 id。对账任务靠它幂等
--  · `transcript`       逐句转录（jsonb 数组）。前台「来电复核」屏要能
--                       直接看到 AI 到底答应了客人什么 —— 这是 AI 说错话
--                       之后唯一的证据，也是 `04` §9「AI 准不准」的度量来源
--  · `tools_used`       这通电话调过哪些工具。一眼看出它是「查完就挂」
--                       还是「真订了单」，不用逐句读
--  · `recording_url`    录音（Telnyx 侧开了才有）
--  · `summary`          一句话摘要，留给以后
--
--  ## ⚠️ 转录里有客人的个人信息
--
--  客人会在电话里说出全名、有时是生日或健康状况。这一列因此**跟着
--  phone_calls 的 RLS 走**（org 隔离），前台要看得到（她本来就在旁边听）,
--  但它不该出现在任何跨租户的统计里。
--
--  ⚠️ 录音还有第二层：加州是 two-party consent（`09` §4.4），
--  开录音必须在开场白里告知。**这一列只是存 URL，开不开在 Telnyx 那边。**
-- ════════════════════════════════════════════════════════════════════════════

alter table phone_calls
  add column if not exists conversation_id text,
  add column if not exists transcript      jsonb,
  add column if not exists tools_used      text[],
  add column if not exists recording_url   text,
  add column if not exists summary         text;

comment on column phone_calls.transcript is
  '逐句转录 [{role,text,at}]。含客人个人信息，只在门店内可见';
comment on column phone_calls.conversation_id is
  'Telnyx AI conversation id。对账任务（reconcileCalls）靠它幂等';

-- 对账任务按 conversation_id 找那一行；同一个会话只能有一条
create unique index if not exists phone_calls_conversation_idx
  on phone_calls (conversation_id) where conversation_id is not null;
