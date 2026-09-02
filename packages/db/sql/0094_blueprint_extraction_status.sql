-- ════════════════════════════════════════════════════════════════════════════
--  0094 · 拍照开店：把「提取」从同步请求改成后台任务
--
--  原来 POST /v1/blueprint/:id/extract 是同步的 —— 一路 await Claude Vision
--  再返回。密价目表一张要三四十秒，而 Fastify 的 requestTimeout 是 30s、
--  Cloudflare 回源上限 ~100s：老板拍完照等来的是 502 Bad Gateway，
--  草案却已经建好、照片也已经在提取，他只能重来。
--
--  改法：路由把校验（权限 / 图片格式 / 准入闸门）跑完就立刻返回 202，
--  真正的模型调用在后台进行，结果照旧走 blueprint.saveExtraction 落库。
--  确认页轮询 GET /v1/desk/blueprint/:id 看这三列的状态。
--
--  ── extraction_status ────────────────────────────────────────────────────
--    idle     还没提取过（只建了草案 / 只传了照片）
--    running  后台正在跑模型
--    done     结果已落库（此时 extracted_at 也已写上）
--    failed   六张全挂 / 模型拒答 / 进程重启把后台任务丢了
--
--  ── extraction_started_at ────────────────────────────────────────────────
--  置 running 的时刻。滚动部署时 app.close() 只等在途 HTTP 请求，
--  不等这个游离的后台 Promise —— 部署正好打断提取，这一行就会永远停在
--  running。读取侧（loadBlueprint）据此判定：running 且这个时刻早于
--  阈值，就当成 failed/timeout 返回，让老板看到「重试」而不是转圈到天荒地老。
--
--  这三列不是财务数据，是任务状态；直接 alter，无需回填（默认 idle 对
--  历史草案是对的 —— 它们要么早已 done、要么本来就没提取过，二者都不该
--  显示成「正在识别」）。
-- ════════════════════════════════════════════════════════════════════════════

alter table shop_blueprints
  add column if not exists extraction_status text not null default 'idle',
  add column if not exists extraction_error text,
  add column if not exists extraction_started_at timestamptz;

alter table shop_blueprints
  drop constraint if exists shop_blueprints_extraction_status_chk;
alter table shop_blueprints
  add constraint shop_blueprints_extraction_status_chk
  check (extraction_status in ('idle', 'running', 'done', 'failed'));

-- 已经提取过的历史草案（extracted_at 非空）标成 done，省得确认页把它们
-- 当成「从没提取」。running / failed 是新状态，历史数据里不会有。
update shop_blueprints
  set extraction_status = 'done'
  where extracted_at is not null and extraction_status = 'idle';
