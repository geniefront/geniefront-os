# 购买 → 订阅 → 激活 → 开店验收与上线清单

> 最后更新：2026-08-30
> 原则：生产运行优先；官网重制后置。所有付款测试必须明确区分 Stripe test/live，所有数据修改必须绑定专用测试账号和门店标记。

## 1. 当前进度

| 阶段 | 状态 | 验收事实 |
| --- | --- | --- |
| Checkout 契约 | 已完成代码与集成测试 | 价格只能由服务端 Price ID 决定；邮箱、店名、业态、时区和套餐写入受控 metadata |
| Stripe Webhook | 已修复并通过测试 | 验签、幂等、失败重试均覆盖；进程在 `processing` 中退出后，10 分钟租约到期可重新处理 |
| 订阅与建租户 | 已完成代码与集成测试 | Checkout 完成后创建 org/location/signup intent/billing account；重复事件不重复建店 |
| 激活与认领 | 已修复并通过测试 | 只有 claim 成功或已有有效 membership 才显示成功；认领失败不再误跳 `/setup` |
| Setup 服务端门禁 | 已完成代码与集成测试 | 门店资料、营业时间、启用项目、可接单员工缺一不可，检查与开店状态更新在服务端完成 |
| Setup 浏览器验收 | 已完成 | 真实保存门店资料、刷新恢复、项目、可接单员工与正式开店，完成后自动进入后台且 `/setup` 回退正确 |
| 开店后 Web/技师/Kiosk 回归 | 本地关键链路已完成 | Kiosk 取号 → 前台分配 → 技师完成 → 前台现金结账 → 归档已走通；价格/时长透传与工位状态重复写入问题已修复 |
| 两个生产长期测试账号 | 方案已确定，等待隔离 Stripe test 入口 | `signup-smoke@geniefront.com` 与 `ops-smoke@geniefront.com`；不得使用当前官网 live Checkout 做冒烟测试 |
| 官网重制 | 后置 | 最终营销站仍后置。最小生产入口是本仓 `apps/marketing`：定价 → `POST /v1/public/signup-checkout` → Stripe Hosted Checkout → 现有 webhook 建店 |
| 数据库迁移 | 生产仍需 | `0072`（invoice tenant）· `0073`（10DLC internal review）· `0074`（platform console）。本批**不改**这些迁移 |

## 2. 逐段验收

### A. 购买与订阅

- [x] 服务端创建 Checkout Session，不信任浏览器提交的金额或 Stripe Price。
- [x] Checkout metadata 能唯一还原店主邮箱、店名、业态、时区、语言和套餐。
- [x] Webhook 必须先验签，再记录 Stripe event ID。
- [x] 同一 event 重放不会重复建租户或重复记账。
- [x] 失败事件可重试；超时 `processing` 事件不会永久卡死。
- [x] 订阅状态、customer、subscription、period end 写入 billing account。
- [ ] 使用 Stripe test card `4242 4242 4242 4242` 完成一次真实 Checkout。
- [ ] 在 Stripe Dashboard 确认 Checkout、Customer、Subscription 和 Webhook delivery 相互对应。

### B. 激活与认领

- [x] 付款后只向 signup intent 中的店主邮箱发送激活链接。
- [x] 邮箱规范化支持 Gmail 点号/加号规则，不错误合并普通企业域邮箱。
- [x] 登录后只能认领与当前认证邮箱匹配且尚未认领的门店。
- [x] claim 幂等；刷新或重复点击不会创建第二份 membership/role/staff profile。
- [x] claim 失败时停留在激活页并显示错误，不显示“成功”。
- [ ] 从真实测试收件箱点击一次 magic link，并确认 URL token 不被日志、Analytics 或第三方脚本采集。
- [ ] 激活后刷新、退出再登录，仍进入同一个待 setup 门店。

### C. 首次开店

- [x] `location.status=setup` 时无法通过深链接进入后台或技师工作台。
- [x] 门店资料和营业时间写入数据库，刷新后可恢复。
- [x] 至少一个启用服务项目，价格与时长为有效值。
- [x] 至少一个 active、bookable 员工，并有可营业排班。
- [x] `location.finishSetup` 在服务端重新校验全部条件后才改为 `active`。
- [x] 浏览器中依次保存四步，并在门店资料保存后刷新验证真实恢复。
- [x] 正式开店后自动进入后台；再次访问 `/setup` 会回到工作台。

### D. 开店后的长期回归店

- [x] 前台/Kiosk/技师关键闭环：Kiosk 现场取号、前台分配项目/技师/工位、技师完成、前台现金结账和归档。
- [x] Kiosk 选择的项目价格与时长原样进入队列和服务单；`经络足道 60 分钟 / $45.00` 已做浏览器实测。
- [x] 启动项目时由服务单工作流管理工位占用，前端不再重复写入工位状态并把已成功操作误报为失败。
- [x] 纯技师账号只能挂载 `/tech/*` 路由；访问老板端路径会重定向到 `/tech/today`。
- [ ] 前台：新建/改期/取消预约、小费、退款和日结的生产测试店回归。
- [ ] 技师：打卡、个人日程、现金小费修改及更多越权矩阵。
- [ ] Kiosk：有预约签到、多人同行、健康表签署、断网恢复和非美国国际号码的浏览器路径。
- [ ] 设置：营业时间、员工、服务、角色权限、通知与 Billing 页面能读取真实数据。
- [ ] 公共预约/健康表：无后台身份也可打开；不能跨门店读取。
- [ ] 手机、平板和桌面断点各完成一轮关键路径。

## 3. 两个生产长期测试账号

### 账号 A：购买/订阅/激活/开店

- 每轮测试后归档上一间带 `smoke_test_account=purchase_activation` 标记的测试店，保留 Stripe 与审计记录，不硬删除。
- 账号必须使用可收邮件的专用别名；不能使用 `@example.test`，因为必须验收真实激活信。
- 默认使用 Stripe test mode；如果生产域名目前只接 live mode，先提供独立 staging Checkout，避免制造真实收费、退款和财务噪音。
- 每轮从 Checkout 开始，不能用数据库脚本伪造“已付款”来替代购买验收。

### 账号 B：已开店的运营回归店

- 固定保留一个 `location.status=active` 的门店，标记为 `smoke_test_account=operations`。
- 保留稳定的店主、前台、两位技师与 Kiosk 测试数据；预约和支付测试使用明确前缀并定期归档。
- 不复用真实客户手机号、邮箱、付款方式或健康表资料。
- 账号只授予测试所需权限；生产日志和告警应能排除或单独标识该门店，但业务校验与 RLS 不得绕过。

## 4. 上线前需要提供/确认的资料

1. 测试邮箱已确定：`signup-smoke@geniefront.com` 与 `ops-smoke@geniefront.com`。
2. 购买验收已确定使用 Stripe test mode。2026-08-30 只读检查发现当前官网仍创建 `cs_live_…` Checkout，不能用于测试账号。
3. Stripe 中 Starter/Growth 对应的 test 与 live Price ID，以及生产 Webhook endpoint 当前订阅的事件列表截图或只读核对权限。
4. 激活邮件的发信域、From 地址和回调域名；需要确认 Supabase Redirect URL 已包含生产 `/activate`。
5. 当前生产 API、Web、Kiosk 域名和部署方式，用于迁移、回滚和浏览器回归。

## 5. 2026-08-30 本地浏览器验收记录

- 新建待开店账号，依次保存门店资料、营业时间、服务项目和可接单员工；刷新后资料仍存在，正式开店后 `/setup` 正确回到工作台。
- 固定运营账号完成 Kiosk 设备配对，顾客 `Kiosk Price Check` 选择 `经络足道 60 分钟 / $45.00` 并取得 `#1`。
- 前台队列显示同一项目、60 分钟和 $45.00；分配燕姐与 `VIP 包厢 1` 后，技师端立即出现进行中任务。
- 技师端完成项目后前台进入 Open / Unpaid；选择 No Tip、Cash、实收 $45.00 后进入 Completed，今日营收为 $45.00。
- 全程使用本地隔离 Supabase 与 Stripe test 配置；未写入生产业务数据，也未发起真实扣款。

## 6. 2026-08-30 生产只读核对

- `https://www.geniefront.com` 正常打开，但订阅按钮当前进入 Stripe live Checkout。
- `https://desk.geniefront.com` 老板测试账号可登录，真实看板数据可读取。
- 纯技师本地回归发现深链接可挂载老板 Layout、随后才由 API 返回 `PERMISSION_DENIED`；现已改为纯技师/技师门户只挂载 `/tech/*` 路由树。
- `https://desk.geniefront.com/forms/intake?...` 示例健康表正常打开，未填写或提交任何健康资料。
- 本地现有 Stripe key 是 test key；Essential/Growth 的 test Price 分别为 $99/$199 月付且 active。
- 该 Stripe test account 当前没有 Webhook endpoint。完成 test mode 购买验收前必须先创建隔离 endpoint，并把签名 secret 配进对应的 test/staging API 环境。

## 7. 后续执行顺序

1. 部署本轮代码及数据库 migration `0070`、`0071`，确认 API/Web 版本与数据库版本一致。
2. 为 Stripe test mode 准备独立的 staging/test API 回调域名，创建 Webhook endpoint，并把其签名 secret 只配置到该环境。
3. 创建并保留 `ops-smoke@geniefront.com` 运营回归店，再用 `signup-smoke@geniefront.com` 从 test Checkout 完整跑真实邮件激活链路。
4. 补齐预约改期/取消、退款、日结、断网与移动端矩阵，保存验收证据和回滚点。
5. 最小开户入口是 `apps/marketing`（`pnpm dev:marketing`，端口 5180）。前端只提交 `shopName` / `ownerEmail` / `plan`；金额展示来自 `@gf/payroll` 的 `PLAN_PRICES_CENTS`，Stripe Price 始终由 API 的 `STRIPE_PRICE_*` 决定。最终营销站（模板 `geniefront-os-marketing-template`）仍后置。

## 8. 部署与回滚提醒

- `0070_onboarding_import_sources.sql` 和 `0071_stripe_event_retry_lease.sql` 必须先于新 API 流量完成迁移。
- 生产仍需已经落地的 `0072`、`0073`、`0074`。本批不修改这些迁移。
- Web、API 与数据库应作为同一发布批次；若回滚 API，不要回滚这两项向后兼容的新增表/字段迁移。
- Test 与 live Stripe key、Price、Webhook secret 必须分环境保存，禁止把 secret 提交到 Git 或发到聊天记录。
- 发布后先观察 signup、Stripe webhook、claim、finish setup、ticket start/finish 与 checkout 的错误率，再开放 test Checkout 冒烟入口。
