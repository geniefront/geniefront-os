# GenieFront OS 全项目审查

审查日期：2026-09-27。基线：`fb433fe` 及开始审查时已有的未提交文件。

结论：发现 **5 项 P1、4 项 P2**。其中越权读取、零元开单、DNS 重绑定、两处环境守卫缺口均有本地复现。当前不宜把类型检查通过视为发布验收通过。此次仅审查，没有修复或部署业务代码。

## 生产数据保护与覆盖范围

- 没有连接生产数据库，没有读取或修改 zhizi 的生产记录，没有调用生产业务 API、发邮件、发短信、迁移生产库或执行部署。
- 新建一次性 PostgreSQL 17 容器，只绑定本机回环端口；所有数据库测试使用全新测试数据。测试进程使用清理后的环境、显式本地数据库地址、虚构密钥、`GF_TEST_NO_DOTENV=1` 和 `SEED_SKIP_AUTH=1`。
- 保留原有未提交改动；新增文件仅为本目录的审查报告和证据。构建产物位于 `/tmp`。
- 覆盖 API 身份认证、命令总线、权限与租户隔离、数据库迁移/RLS、预约/收银/退款相关实现与测试、健康表、通知/电话/计费、五个前端、部署脚本、CI 和依赖扫描。不是逐行穷尽证明。
- 没有核验线上部署版本、真实 RLS 配置、外部供应商账号、防火墙实际状态、生产备份恢复；没有运行真实 Supabase Auth/Realtime/Storage 浏览器 E2E 或人工多语言视觉验收。不能据此断言 zhizi 已受到这些问题影响。

## 问题清单

### P1-01 无折扣权限的技师可以覆盖价格，开出零元工单

位置：[ticket.ts:323](/Users/naiyouzhu/siteadmin/geniefront-os/apps/api/src/handlers/ticket.ts:323)、[ticket.ts:531](/Users/naiyouzhu/siteadmin/geniefront-os/apps/api/src/handlers/ticket.ts:531)、[命令契约:69](/Users/naiyouzhu/siteadmin/geniefront-os/packages/contracts/src/commands/ticket.ts:69)。

`ticket.open` 和 `ticket.addItem` 只要求 `ticket.write`，允许 `priceCentsOverride`，但没有对应的字段级折扣/改价权限检查。处理器直接用覆盖值写入金额。结账时的折扣检查无法弥补开单时已改变的原价。

复现：独立库中以默认 Linh 技师身份登录，`ticket.discount=false`、`report.view=false`、`queue.manage=false`。对目录价格 4,500 分的项目提交 `priceCentsOverride:0`，真实 HTTP 注入返回 **201**，结果 `subtotalCents:0`。详见 `evidence.json` 的 `AUDIT_PRICE_OVERRIDE`。

建议：在服务端对所有覆盖价格的入口统一判定改价/折扣权限，并限制金额非负；覆盖实际价格发生变化时才授权。回归用例应使用真实默认技师权限走 HTTP 路由。

### P1-02 默认技师可查询全店他人的订单与金额

位置：[orders.ts:32](/Users/naiyouzhu/siteadmin/geniefront-os/apps/api/src/routes/orders.ts:32)、[查询:79](/Users/naiyouzhu/siteadmin/geniefront-os/apps/api/src/queries/orders.ts:79)、[staffSession.ts:89](/Users/naiyouzhu/siteadmin/geniefront-os/apps/api/src/auth/staffSession.ts:89)、[client.ts:93](/Users/naiyouzhu/siteadmin/geniefront-os/packages/db/src/client.ts:93)。

`/v1/desk/orders` 接受 `ticket.read`，默认技师就具有此权限。`staffId` 由请求可选提供，未强制为当前技师；租户事务默认 `role_scope=full`。因此门店级 RLS 仍有效，但不能实现“技师只看自己的单”。前端只展示技师门户无法封闭这个 API。

复现：使用同一真实技师会话，`GET /v1/desk/orders` 返回 **200**、50 条订单，其中 **39 条没有分配给该技师，且返回了订单金额**。详见 `AUDIT_ORDERS`。这证明同店角色越权，不是跨租户泄露。

建议：区分前台/全店读取与技师自有读取；对技师强制服务归属过滤，并覆盖小票、订单列表、预约详情等同类入口。不能仅依赖未完整接入的 `staff_self` 标记。

### P1-03 官网导入的 DNS 检查与实际连接脱节，可绕过内网地址阻断

位置：[websiteFetch.ts:36](/Users/naiyouzhu/siteadmin/geniefront-os/apps/api/src/onboarding/websiteFetch.ts:36)、[websiteFetch.ts:46](/Users/naiyouzhu/siteadmin/geniefront-os/apps/api/src/onboarding/websiteFetch.ts:46)。

`validateUrl()` 先解析并检查 IP，随后 `fetch(url)` 按域名重新解析。第二次解析结果没有绑定到已验证的公网地址。拥有官网导入权限的调用者可通过受控域名的 DNS 变化，让检查通过后实际访问内网。

本地验证：校验阶段模拟返回公网 IP；真正 HTTP 连接阶段返回本机回环地址。仅使用本机临时 HTTP 服务，观察到 **1 次内部请求，内部页面文本被 `fetchWebsitePages()` 返回**。未访问外网内网资产或云元数据。详见 `dns_rebinding`。

建议：在实际 socket 的 DNS lookup/连接阶段校验并固定地址，同时保留正确 Host/SNI；重定向也采用同样的受控连接。另一个资源风险是 `res.text()` 读取完全部响应后才截断，缺少 Content-Length 的大响应仍可占用大量内存，应改为流式字节上限。

### P1-04 staging 迁移守卫没有校验真正执行迁移的数据库地址

位置：[migrate-env.sh:11](/Users/naiyouzhu/siteadmin/geniefront-os/scripts/migrate-env.sh:11)、[env-guard.sh:91](/Users/naiyouzhu/siteadmin/geniefront-os/scripts/env-guard.sh:91)。

守卫检查 `DATABASE_URL`、Supabase URL 和公开域名；`MIGRATION_DATABASE_URL` 没有进入目标一致性校验。迁移脚本仅要求此变量非空，且只有参数为 `production` 时要求生产确认。若 staging 文件的管理员连接串误填生产地址，`migrate:staging` 仍会按此地址执行迁移。

本地复现：用全虚构的 staging 配置，把迁移地址改为不同的 `production-wrong-target.invalid`，仅运行静态环境守卫，返回 **0/通过**。没有执行该地址的迁移，也没有建立连接。此项是已确认的防误操作缺口，不代表当前 staging 已误配。

建议：解析并校验应用连接、迁移连接和 Supabase 项目的实际目标一致性；考虑直接连接与 pooler 的地址差异，不能只比较字符串。生产目标的确认要求应跟随实际目标身份。

### P1-05 API/DB 测试的 isolated 标记不能证明数据库真的隔离

位置：[vitest.shared.ts:79](/Users/naiyouzhu/siteadmin/geniefront-os/vitest.shared.ts:79)、[resetDatabase.ts:17](/Users/naiyouzhu/siteadmin/geniefront-os/apps/api/src/test/resetDatabase.ts:17)、[seed.ts:186](/Users/naiyouzhu/siteadmin/geniefront-os/packages/db/src/seed.ts:186)。

测试配置验证字符串标记、协议和用户名，却不验证主机是否为本地/明确允许的测试环境。与开发/生产连接串的比较仅针对读到的普通 `.env` 原始值，`GF_TEST_NO_DOTENV=1` 时这项比较失效，也没有识别同一项目的其他连接形式。API setup 每个测试文件都会执行 seed；seed 只拒绝隐式 `.env` 管理员地址，不复用 QA 的本地主机保护。

纯配置复现：`TEST_*` 均使用虚构远程主机 `production.invalid`，加 `DATABASE_TEST_TARGET=isolated`，`loadEnv({database:true})` 接受配置。**连接次数为 0**。若真实运维误传生产凭据，测试初始化可执行真实写入，甚至修改共享数据库函数定义。

建议：API/DB 测试与 QA reset 共用强制的实际目标验证，并在 seed 自身加第二层防线；使用本地允许列表或经验证的专用测试项目身份，在首次连接/写入前失败。不能把自报的 isolated 字符串作为安全证明。

### P2-01 健康表填写令牌进入 URL 查询参数和访问日志

位置：[links.ts:232](/Users/naiyouzhu/siteadmin/geniefront-os/apps/api/src/links.ts:232)、[PublicHealthForm.tsx:50](/Users/naiyouzhu/siteadmin/geniefront-os/apps/web/src/pages/PublicHealthForm.tsx:50)、[Caddyfile:92](/Users/naiyouzhu/siteadmin/geniefront-os/deploy/Caddyfile:92)。

分享链接生成 `/forms/intake?t=fs_...`，浏览器首次请求就携带令牌；desk 的 Caddy 访问日志没有为此路径过滤查询参数。后续 API 使用 header 不能撤回首次文档请求的泄露，浏览器历史也保留查询参数。持有仍有效令牌者可冒充受邀者提交表单；本项不表示可读取历史健康表答案。

建议：像预约管理链接一样改用 URL fragment，并同步调整前端读取与旧链接兼容、日志过滤和 Referrer-Policy。证据来自代码与部署配置，未读取生产日志。

### P2-02 持久离线快照被所有 API 的 no-store 响应禁用

位置：[server.ts:169](/Users/naiyouzhu/siteadmin/geniefront-os/apps/api/src/server.ts:169)、[api.ts:92](/Users/naiyouzhu/siteadmin/geniefront-os/apps/web/src/lib/api.ts:92)。

服务端对全部非 health 响应设置 `Cache-Control: no-store`；客户端遇到该值就不写 IndexedDB。实际订单响应也验证带此头。因此现有 `apiGet` 无法生成文档描述的持久离线快照，且 `apiGetCached` 在当前业务代码没有调用者。

影响：已打开页面可能仍依赖 React Query 内存显示，但断网后重新挂载页面不能依赖声明的 IndexedDB 恢复机制。此次没有运行浏览器离线刷新实测，因此不把它扩大描述为所有断网场景都会白屏。

建议：保留敏感 API 的 HTTP no-store，单独设计允许持久保存的最小看板字段、过期与退出清理策略，并实际接入离线读取。不要通过取消所有 no-store 来修复。

### P2-03 日常 CI 不执行测试，已存在的失败不能阻止发布

位置：[verify.yml:31](/Users/naiyouzhu/siteadmin/geniefront-os/.github/workflows/verify.yml:31)、[full-verify.yml:3](/Users/naiyouzhu/siteadmin/geniefront-os/.github/workflows/full-verify.yml:3)、[deploy.sh:83](/Users/naiyouzhu/siteadmin/geniefront-os/deploy/deploy.sh:83)。

当前 push/PR 工作流只运行规则与类型检查；完整测试工作流仅手动触发，且该文件是开始审查时已有的未跟踪文件。部署脚本也未校验对应提交的完整测试结果。本次两项快速检查全绿，但实际总测试初跑有 **6 个失败**。

建议：至少将无数据库测试加入自动 CI；完整验证应在隔离数据库中作为发布门槛，并与待发布提交关联。先修订与现行产品行为不一致的测试，避免长期红灯。不能把所有失败直接当成线上业务故障，分类见下表。

### P2-04 锁文件有未修补安全公告，需要按实际暴露面升级

位置：[pnpm-lock.yaml](/Users/naiyouzhu/siteadmin/geniefront-os/pnpm-lock.yaml)、[扫描原始结果](/Users/naiyouzhu/siteadmin/geniefront-os/artifacts/audit-2026-09-27/dependency-audit.json)。

`pnpm audit --json` 报告 **24 项：2 critical、12 high、10 moderate**，包含重复依赖路径，不等于 24 个可利用的生产漏洞。

- Drizzle ORM 0.38.4 命中标识符转义公告，公告修复版本 0.45.2。项目业务查询主要使用 postgres.js，本次未确认不可信输入进入 Drizzle 标识符的可利用路径。[维护者公告](https://github.com/drizzle-team/drizzle-orm/security/advisories/GHSA-gpj5-g38j-94v9)
- Vitest 2.1.9 的 critical 公告涉及监听中的 UI server；此次运行的是 `vitest run`，不能将其表述为生产 API 远程代码执行。该公告修复版本为 3.2.6，扫描还列出了需要更新版本处理的其他 Vitest 公告。[维护者公告](https://github.com/vitest-dev/vitest/security/advisories/GHSA-5xrq-8626-4rwp)
- Fastify 5.12.0 命中两项 moderate 公告，扫描建议至少 5.12.1；另有 fast-uri、tar、Vite、esbuild 的传递依赖公告，完整范围与修复版本见 JSON。

建议：分别升级运行时和构建/测试依赖，按锁文件重新扫描、执行现有测试，不直接套用破坏性自动修复。本次未改依赖。

## 验证结果

| 项目 | 结果 |
|---|---|
| 仓库规则 `pnpm lint:guards` | 通过 |
| 强制类型检查 `turbo run typecheck --force` | 16 个任务通过、0 缓存；iOS 为占位任务，phone-input 无独立检查脚本 |
| 无数据库测试 `pnpm test:unit` | 1,215 通过，1 失败 |
| 全新本地 PostgreSQL 迁移 | 151 文件应用成功，RLS 覆盖断言通过 |
| 再次执行迁移 | 成功，0 个新文件；这证明迁移账本重跑，不等于每个 SQL 文件任意重复执行安全 |
| DB 测试 | 117/117 通过 |
| API 完整测试 | 1,570 通过，5 失败；127 文件全部运行 |
| 五个前端构建 | web / booking / ipad / platform / marketing 全部通过；web/booking 有 chunk 体积告警 |
| API esbuild 打包 | 通过；未构建/启动正式 Docker 镜像 |
| 本地定向复现 | 技师订单越权、零元开单、DNS 重绑定及两个守卫缺口成立 |
| 安全公告 | 24 项，需区分运行时/开发环境及利用前提 |

初跑合计 **2,908 项测试，2,902 通过、6 失败**。另外针对不稳定的营销用例重复运行该文件，12/12 通过；不将重跑结果覆盖初跑结果。

### 失败用例分类

| 用例 | 实际表现 | 审查判断 |
|---|---|---|
| `Skeleton.test.tsx:32` | 要求骨架块，但组件只渲染 spinner | 组件注释已明确统一 spinner，测试契约未同步；不是已证明的营业故障 |
| `phone.test.ts:820` | 两条 item 的 membership_id 去重后只有一个值 | 新流程支持人工指派前的 reserved_membership_id，旧测试只查正式指派；应同时验证预留的技师容量，不能直接宣称重复派人 |
| `settings_enhancements.test.ts:264` | 期望 200，实际 403/ops_managed_voice_settings | 当前配置转为运营管理，旧测试仍要求店主直接修改 |
| `notify_policy.test.ts:285` | 期望两封旧式抄送，实际一封 | 新 shopCopy 要求实际预约，且改发本地化店内通知；旧测试只提供任意 entityId，并要求正文逐字相同 |
| `voicePolicy.test.ts:15` | 旧 TeXML 的 timeLimit=600 断言失败 | 当前代码标注生产使用 direct SIP，不能据该失败断言生产通话没有时限；需清理旧契约并另测实际供应商配置 |
| `marketing.test.ts:258` | 随机手机号触发 VALIDATION_FAILED；单独重跑通过 | 测试生成任意 7 位尾号，可能出现无效 NANP 交换局号；应使用确定的有效测试号码，避免随机红灯 |

## 已验证的正向保护

事务内 `set_config(..., true)`、受限应用角色、默认角色的跨租户隔离测试、系统命令双层拒绝、健康表 AES-256-GCM、平台独立 operator 校验、Webhook 签名与时间窗口已有实现。本地 DB 套件与相关 API 测试提供支持。迁移后目录检查中，匿名角色不能执行检查到的 SECURITY DEFINER 函数，authenticated 可执行的为 `user_in_location(uuid)`。这不替代线上权限审计。

RLS 审查参考：[Supabase 官方 RLS 文档](https://supabase.com/docs/guides/database/postgres/row-level-security)。门店间隔离通过并不表示同店角色权限已正确，P1-02 就是两者的区别。

## 后续处理顺序

先修复价格权限、技师读取范围和 DNS 连接校验；在任何后续迁移或完整测试之前补齐实际数据库目标验证。随后处理填写令牌日志、离线功能契约、测试/CI 与依赖升级。所有改动先在独立环境回归，再单独安排部署；本次没有实施这些改动。

证据：[evidence.json](/Users/naiyouzhu/siteadmin/geniefront-os/artifacts/audit-2026-09-27/evidence.json)、[verification.txt](/Users/naiyouzhu/siteadmin/geniefront-os/artifacts/audit-2026-09-27/verification.txt)。证据仅含虚构测试数据与本地结果。
