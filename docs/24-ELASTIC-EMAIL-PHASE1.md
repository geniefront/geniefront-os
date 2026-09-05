# Elastic Email 第一期迁移

## 范围与授权

2026-09-05：用户授权执行、迁移生产（尚无真实客户），要求每阶段记录进度并简短汇报。
系统/订阅邮件使用 geniefront.com；预约默认 book.geniefront.com；子账户身份使用 shop-<location UUID>@tenant.geniefront.com；mkt.geniefront.com 预留。
营销模板、群发和自动营销本期不开放，界面提示 Coming soon / 即将上线，服务端同样禁止发送。

## 交付与验收

- [ ] P1：供应商适配、系统/订阅/预约邮件、账户及域名检查。
- [ ] P2：validation 缓存、超时策略、unsubscribe 正确反馈、投递回调与抑制。
- [ ] P3：后台发送领取、防重复、失败重试、消息状态、诊断。
- [ ] P4：子账户与独立密钥、域名工单/DNS 教程、自有预约发件域名切换。
- [ ] P5：店家与平台 UI、营销关闭、租户隔离/回归验证。
- [ ] P6：测试环境迁移、生产迁移/部署、认证 SMTP、真实受控测试、最终交接。

## 设计纪律

1. 业务邮件经现有 email_outbox，业务事务内只入队，外部请求在事务提交后。
2. validation 不代表营销同意；未知/风险/超时不判永久无效，明确不存在才阻止事务发送。
3. unsubscribe GET 不更改状态；POST 幂等；数据库故障和限流不得谎报成功。
4. 一期营销完全关闭，但旧退订链接继续有效。组织营销偏好兼容现有 customers 模型；供应商退订记录保留账户范围。
5. 已受理或发送结果不明的邮件不得盲目切换供应商重发。
6. 店家域名在真实发送账户验证并绑定租户后才可使用，平台域名与其他租户域名不可冒用。
7. 密钥仅保存在服务端，不写日志、文档、响应或前端；保留现有未提交改动。
8. 现有仓库用 packages/db/sql + _migrations 管理 SQL；不另建第二套迁移执行历史。

## 进度日志

### 2026-09-05 / 启动

- 已盘点：当前 provider 只有 Resend/SES；已有后台 outbox sweep，但领取/并发安全需加强。
- 已确认：现有 unsubscribe 在数据库失败/限流时仍返回成功，需修复；GET/POST 已分离。
- 已确认：现有营销正文按纯文本渲染，第二期再扩展模板。
- 实施前已有改动：.env 示例文件、前台 Queue 和相关测试/审计文档，迁移保持这些改动。

## 官方参考

- https://elasticemail.com/developers/api-documentation/rest-api
- https://help.elasticemail.com/en/articles/4934400-how-to-verify-your-domain
- https://help.elasticemail.com/en/articles/4804685-notification-settings
- https://help.elasticemail.com/en/articles/4799160-api-settings
- https://help.elasticemail.com/en/articles/3098546-email-verification-api-service

### 2026-09-05 / 实现与首轮验证

- 已实现：Elastic Email v4 事务发送适配、关闭追踪、防误开营销、收件验证缓存、账户范围抑制与事件 API 对账。
- 已实现：并发领取、最多三次明确失败重试；网络/服务端超时进入 uncertain，不自动跨供应商重发。
- 已实现：域名工单、DNS 所有权挑战、可复制记录、后台周期核验、预约自有域名切换；平台 /email 管理页和店家通知设置入口。
- 已修复：旧供应商 webhook 被统一登录鉴权挡住的问题；退订 form POST 支持和真实失败反馈。
- 初验：16 个 workspace 类型检查通过；lint guards 通过；新增 11 项集成/单元测试通过。
- 隔离库 0107 迁移及 RLS 检查通过；发现种子清理需纳入新增表，已修正后继续回归。
- 账户实查：三个域名 SPF/DKIM/DMARC=true，Verify=false；Verify 不能单独作为域名认证状态。仍需真实发送确认账户投递权限。
- 当前尚未切换生产，后续记录真实部署与测试结果。

### 2026-09-05 / 接手验收与暂停交接（用户要求尽快收工）

**当前状态：本期未完成。未部署 staging/production，未在这次接手中执行云数据库迁移，未切换 Auth SMTP。生产 `.env.production` 的 EMAIL_PROVIDER 仍为 resend。所有代码仍在工作区，未提交。**

已完成：
- 恢复原任务明确授权及范围：生产无真实客户，可迁移；营销本期关闭；每阶段记录。
- 本轮 16 个 workspace typecheck 全通过，lint guards 全通过（在本轮最后三处小修改之前）。
- API 全量初次回归：79 文件、1076 测试，1074 通过、2 失败。两项均是前次迁移留下的断言不一致：未知 provider 应抛错；关闭店家抄送仍须给顾客发送。已修正两项断言。
- 发现真实 validation 响应 `Result=Invalid, PredictedStatus=Invalid, Reason=Service error`。已修复 `interpretValidation`：服务错误、超时、临时故障等解释为 unknown；补充 Service error / Connection timeout 回归断言，避免正常预约邮件被永久拦截。
- 平台三个发件域名 SPF/DKIM/DMARC 均 true；账户 API 显示 Active、月订阅 49、非 trial，不能把以下限制直接认定为未购买 Pro。
- staging SSH 与 Docker 可用；未执行部署。

**首要阻塞：账户不允许关闭邮件追踪。**
- 现有适配器发送 `Options: {TrackOpens:false, TrackClicks:false}`，主 Key 与独立 SendHttp Key 均返回 HTTP 400：`You cannot change the tracking options`（RelatedTo: trackOpens）。
- 按官方旧 SDK 支持的 v2 `/account/updateadvancedoptions` 尝试关闭账户级追踪，返回 `success=false: You can not turn off tracking at this time`。复查 enableopentracking、enableclicktracking、linktracking 仍全部 true；没有成功改变设置。
- 去掉 Options 后仅发送一封无链接的受控邮件至用户可收的 `migration-check@tenant.geniefront.com`，From=`noreply@book.geniefront.com`；HTTP 200 接受。TransactionID=`171df11e-2778-01b4-e01e-86ef283d9706`，MessageID=`YLK7F9ozUMTzk6HlaI3zuQ2`。**仅 API 接受，尚未查询事件确认投递，也未确认收件箱。**
- 不要直接把 EMAIL_PROVIDER 切到 elasticemail：当前代码每封都带 false 参数，会全部失败。下一次先解决账户限制（可能需供应商处理），或明确评估采用账户默认追踪对预约/Auth 链接的影响后再调整；没有向供应商发送任何消息。

仍需完成，按优先级：
1. 收取修复后全量回归结果：已启动 `pnpm --filter @gf/api test --silent`，输出 `/tmp/gf-email-api-tests.log`（仍会有 Fastify 日志）。暂停时运行中，不能宣称通过；进程若已结束请看末尾汇总。新增故障判定也在此轮覆盖。补跑最终 typecheck。
2. 修正真实回调对接：当前 webhook POST 只接受 `x-geniefront-webhook-secret`，但官方 WebhookCreatePayload 只有 URL/事件选项，没有自定义请求头。官方通知使用 URL 参数；当前 GET 仅返回 ok，不处理事件。需实现供应商实际能发送的鉴权/提示协议（敏感令牌不得进入访问日志），仍坚持通过已认证 events API 验证事件再更改数据库。`/v4/webhook` 当前返回空列表，尚未注册。轮询对账代码已存在，但不足以声称 webhook 完成。
3. 补验 delivery reconciliation：使用上述受控 TransactionID 查询 events，验证 Sent/退信/投诉/重复/乱序和租户范围；现有 `reconcileEmail` 测试覆盖不足。
4. 进一步复核 validation 的批量额度与并发：现有 count>=250 只检查已有数量，没有按本次批量扣剩余额度；服务 sweep 清除 requested 后的失败恢复尚需验证。
5. 真实子账户建立及 key 加密保存尚未跑通生产（当前供应商账户列表有 1 个子账户，来源未核实）。需核验缺失子账户 GET 的实际错误码及创建返回字段。
6. 店家自有域名工单、所有权 TXT、DNS 教程、预约切换及失效回退需要端到端验收；本轮未配置任何店家 DNS。SPF redirect 情况目前 value 含人工 review 文本，应改为明确人工审核状态，避免被当可复制 DNS 值。
7. staging 0107 迁移、部署、UI 与 RLS 验收，再生产迁移及双节点部署、outbox 真实发送验收。保留仓库 `_migrations` 体系。部署前确认生产无待发旧测试数据，检查环境安全闸门。
8. SMTP credential 尚未生成。脚本 `smtp`/`auth` 尚未执行；`.env.production` 有 SUPABASE_ACCESS_TOKEN，staging 文件没有。Auth 切换需保留首次 SMTP 回滚备份（现脚本重复运行会覆盖备份，先修）。部署脚本运行时 DENY 尚未排除 SUPABASE_ACCESS_TOKEN 和 SMTP 密码，应先排除管理凭据再部署。
9. 补齐运维说明、回滚、DNS 指南和测试记录后，再勾选 P1-P6；目前未达到完成验收条件。

环境与工作区：
- `.env.production` 已由前次任务生成 SendHttp Key、EMAIL_CREDENTIAL_ENCRYPTION_KEY、ELASTICEMAIL_WEBHOOK_SECRET；本轮没轮换、没打印密钥。
- `.env.staging` 仍未 bootstrap 独立发送/加密/webhook 凭据；staging 通信模式须保持 capture。
- 不要覆盖 Queue、checkoutMath、相关 i18n/审计等既有无关改动。
- 官方核验来源：ElasticEmail/elasticemail-js 的 docs/Options.md、WebhookCreatePayload.md、RecipientEvent.md；ElasticEmail/ElasticEmail.WebApiClient-js 的 src/ElasticEmailClient.js（UpdateAdvancedOptions）；Supabase auth-smtp 文档及 2026-09-05 changelog。

### 2026-09-05 / 复盘遗留项并补齐可在代码内完成的部分

本次只处理上一段列出的遗留项中不依赖真实部署、真实 DNS 和供应商人工处理的部分。生产仍未切换：
`.env.production` 的 EMAIL_PROVIDER 保持 resend，未部署，未跑云库迁移，未切 Auth SMTP，改动仍未提交。

已修复（代码）：

1. **追踪限制不再是硬阻塞**（`apps/api/src/email/elastic.ts`）。`elasticRequest` 现在读取失败正文，只用于识别一小组
   固定的账户级限制（目前只有 `tracking_locked`），识别后立即丢弃，错误信息仍只含状态码。`elasticSendEmail` 首次
   遇到 `You cannot change the tracking options` 时记住该限制，改按账户默认设置重发，并对后续发送直接省略 Options，
   不再每封先失败一次。`ELASTICEMAIL_TRACKING_LOCKED=1` 可跳过每进程一次的探测。
   **仍未解决的实质问题**：账户默认开启点击追踪会改写正文链接，预约链接与 Auth 链接会经供应商跳转域。切换生产前
   仍需向供应商申请关闭，或确认跳转域的可用性与品牌影响。平台 `/email` 页现在会显示 `Tracking: account default
   (links rewritten)`，避免这一状态被静默接受。
2. **投递回调改为供应商真正能配置的形式**（`apps/api/src/email/routes.ts`、`server.ts`）。官方 `WebhookCreatePayload`
   只有 `Name`/`URL`/若干 `NotificationFor*` 布尔项，没有自定义请求头（已按 ElasticEmail/elasticemail-javascript 的
   `docs/WebhookCreatePayload.md` 与 `src/model/WebhookCreatePayload.js` 核对，JSON 字段为 PascalCase）。因此新增
   `/v1/webhooks/elasticemail/:token`：路径里的是 `sha256("elasticemail-webhook:"+secret)` 前 32 位这一**派生的公开标识**，
   不是密钥，进访问日志也无法用于其他接口；原有请求头方式保留。两种方式都只作为提示，事件仍经已认证 events API 复核后
   才改数据库。GET 与 POST 均支持，POST 同时接受表单正文和查询参数。
3. **注册脚本**：`scripts/elastic-email-setup.mjs webhook` 用上述 URL 创建或更新 `/v4/webhook`（Sent / Unsubscribed /
   AbuseReport / Error），需要 `API_HOST`。**尚未对生产执行**，`/v4/webhook` 仍为空。
4. **对账回归补齐**（`apps/api/src/elastic_email.test.ts`）：乱序（先 Bounce 后 Sent）不得回退状态、重复事件幂等、
   他人事务与他人 MsgID 一律忽略、硬退信写入抑制、投诉退订只影响本组织，另一组织同邮箱的顾客不受影响。
5. **验证额度按批扣减**（`apps/api/src/handlers/email.ts`）：原来只检查已有数量，单批可越过上限；现在按剩余额度封顶。
6. **验证请求不再被提前清除**（`apps/api/src/email/service.ts`）：改为先取待验证地址，真正尝试之后再逐个清除标记，
   进程中断不会静默丢弃排队地址。
7. **子账户重试不再重复签发密钥**（`apps/api/src/email/service.ts`）：已保存的密钥直接复用，避免供应商侧堆积无人回收的 key。
8. **SPF redirect 不再产出会被直接复制的假记录**（`apps/api/src/email/domains.ts`）：保留现有记录原值，动作标为
   `manual_review`；已包含 elasticemail include 的情况标为 `present`。
9. **运维凭据不再进入运行时**（`deploy/deploy.sh`）：DENY 增加 `SUPABASE_ACCESS_TOKEN` 与 `ELASTICEMAIL_SMTP_*`。
10. **Auth SMTP 回滚点不再被覆盖**（`scripts/elastic-email-setup.mjs`）：备份文件已存在时保留首次备份。
11. `smoke` 与运行时行为一致：账户拒绝按邮件关闭追踪时（仅 HTTP 400）退回账户默认设置重发，不让整体检查失败。
12. `.env.example` / `.env.production.example` / `.env.staging.example` 补齐 `ELASTICEMAIL_SEND_API_KEY`、
    `EMAIL_CREDENTIAL_ENCRYPTION_KEY`、`ELASTICEMAIL_WEBHOOK_SECRET`、`ELASTICEMAIL_TRACKING_LOCKED` 说明。

验证：16 个 workspace typecheck 通过；`@gf/api` 全量测试通过（含新增 4 项）；lint guards 通过。

仍未完成（需要真实环境或供应商配合，不能在代码内收尾）：

- 追踪限制的最终处置：向供应商申请关闭，或正式接受账户默认追踪并评估链接改写对预约/Auth 的影响。**这是切换生产的前置条件。**
- 受控测试邮件 TransactionID `171df11e-2778-01b4-e01e-86ef283d9706` 的投递结果仍未查询确认，收件箱也未确认。
- `webhook` 模式未对生产执行；`/v4/webhook` 仍为空，端到端回调未验证。
- 子账户在生产的真实建立与密钥落库未跑通；缺失子账户 GET 的实际错误码仍只按 404 处理，未经真实核实。
- 店家自有域名工单、所有权 TXT、DNS 教程、预约切换与失效回退的端到端验收未做，未配置任何店家 DNS。
- staging 0107 迁移与部署、UI 与 RLS 验收；生产迁移、双节点部署、outbox 真实发送验收。
- SMTP credential 未生成，`smtp` / `auth` 未执行，Auth SMTP 未切换。
- 验证额度的按批扣减只有代码保证，没有集成测试（走命令总线需要真实 membership 上下文，本轮未搭）。
- P1–P6 仍不勾选。

### 2026-09-05 / 上线与上线后修复

已执行：main 提交 `03ead32`（含前台队列结算改动）；staging 与生产均已应用 `sql/0107`；staging 部署
`03ead32-20260905165637`，生产双节点部署 `03ead32-20260905165750`，健康检查均通过。生产 EMAIL_PROVIDER 仍为 resend，
邮件供应商未切换。回调提示端点在两个环境返回 200，错误路径标识返回 401。

上线后发现并修复：邮件服务扫描在生产真正跑起来后，5 个门店的子账户开通全部失败（`elastic_email_http_400`），
每 15 分钟重试一次。实测确认**子账户不存在时供应商返回 HTTP 400 `{"Error":"Subaccount not found"}`，而不是 404**，
这正是上一段第 5 条标记为「未经核实」的假设。已将该正文纳入错误分类（`subaccount_missing`），
`provisionEmailAccount` 据此判断需要创建，并补了回归断言。
