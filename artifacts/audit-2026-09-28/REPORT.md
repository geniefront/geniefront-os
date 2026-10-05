# GenieFront OS 详细审查：2026-09-28

## 结论

本轮复核原 9 项，并新增 **4 项**：跨租户客户关联、撤销会话后的在途写入、幂等请求内容未校验、迁移测试遗留 schema 回退。当前清单为 **7 项 P1、6 项 P2**，其中原 P1-05 已有局部保护，必须按本轮收窄后的描述处理。

**未达到发布验收关闭条件。** 已确认的问题有真实本地反例；并不表示生产已经出现泄露、资金损失或备份损坏。没有修复业务代码、部署或访问生产业务数据。

这是一轮源码、完整现有测试、定向 HTTP/数据库及有限浏览器审查；不是 48 项所有状态组合的穷尽证明。[48 项覆盖矩阵](COVERAGE_MATRIX.md)逐项记录已验证与剩余边界。

## 基线、环境与方法

- HEAD：`fb433feecc2d37be1feabdfb1dc43c6f78e978f4`；包含开始时原有未提交修改。[baseline.json](baseline.json)记录状态及 1712 个源码/配置文件哈希；不保存 dotenv 内容。
- 新建容器 `gf-audit-20260928`，仅绑定 `127.0.0.1:57208`。未复用原 OS/V3 开发库。
- 子进程采用清理后的环境、虚构密钥、`NODE_ENV=test`、`GF_TEST_NO_DOTENV=1`、`SEED_SKIP_AUTH=1` 和显式测试连接；外部供应商由现有测试替身/capture 处理。未发送真实邮件、短信或执行真实资金操作。
- Node 24.19.0、pnpm 11.21.0；完整 PostgreSQL 17 版本见 [ticket-constraints.txt](ticket-constraints.txt)。数据库用仓库 bootstrap 模拟 Supabase 拥有的 schemas；真实 PG 事务/RLS 有效，但不是运行完整 Supabase Auth/Storage/Realtime 服务。
- 现有套件使用 `postgres` 库；发现测试污染后，另外建立 `audit_pristine`，重新 bootstrap、完整迁移、seed。新增 HTTP 反例与收银序列已在此**未运行迁移回退测试的干净库**重跑，主证据以该次为准。
- 管理员仅用于迁移、夹具、状态观测与故障注入。HTTP 业务请求用真实数据库 staff session，经正常路由/命令总线及 `app_user` 执行；没有把管理员直写称为业务授权通过。
- 采用 V3 的正反对照、证据层级、剩余关闭条件方法；没有照搬 V3 缺陷。

## 新增问题

### P1-06 工单可以绑定另一租户的客户

位置：[ticket.ts:113](/Users/naiyouzhu/siteadmin/geniefront-os/apps/api/src/handlers/ticket.ts:113)、[ticket.ts:299](/Users/naiyouzhu/siteadmin/geniefront-os/apps/api/src/handlers/ticket.ts:299)、[tickets.ts:46](/Users/naiyouzhu/siteadmin/geniefront-os/packages/db/src/schema/tickets.ts:46)。

**触发条件：**有效门店会话具有 `ticket.write`，调用者已知另一组织的客户 UUID；走无 appointmentId 的现场开单入口。

**实际反例：**以默认 Linh 技师会话执行 `ticket.open`，项目和技师都来自本店，仅 customerId 来自另一组织。返回 **201**。管理员只读核验已持久化 `tickets.org_id <> customers.org_id`。同一会话引用另一门店服务时返回 **404**，证明不是测试绕过全部租户隔离。

**原因与影响：**入口直接继承 input.customerId；单列客户 FK 只保证对象存在，不保证同组织。0076 迁移为 appointments/walkin_queue 补了复合 FK，却未覆盖 tickets。当前证据证明跨租户关联与数据完整性破坏；**未证明可读取对方客户详情或扣减对方余额**。

**修复与关闭：**现场开单检查客户在当前组织可见且状态有效；补 `(org_id, customer_id)` 同组织约束，并核查已有异常关联。先定义如何处理历史错误，不自动清空/改绑。真实 HTTP 覆盖本店合法、他组织、不存在、合并/停用客户，并证明拒绝时工单与项目零新增。

证据：[extended-http.json](extended-http.json) `crossCustomer/crossService`；[复现源](extended-http.mts)；[实际 FK](ticket-constraints.txt)。

### P1-07 已认证请求等待锁期间撤销会话，仍能提交新工单

位置：[staffSession.ts:109](/Users/naiyouzhu/siteadmin/geniefront-os/apps/api/src/auth/staffSession.ts:109)、[bus.ts:122](/Users/naiyouzhu/siteadmin/geniefront-os/apps/api/src/bus.ts:122)、[bus.ts:179](/Users/naiyouzhu/siteadmin/geniefront-os/apps/api/src/bus.ts:179)。

**实际序列：**另一个真实 PG 事务持有该门店/幂等键 advisory lock → 发起真实 HTTP 开单 → 用 pg_stat_activity 确认请求已经等锁 → 更新该会话 revoked_at 并提交 → 释放锁。

**结果：**在途请求仍返回 **201** 并持久化工单；撤销后新发的对照请求返回 **401**。

**边界：**是认证后的撤销竞态，不是已撤销 token 能从头登录；本次直接写入会话撤销字段进行故障注入，没有宣称完整 UI 离职流程已复现。业务权限只在锁之前从上下文判断，进入写入时未复核会话状态，无法满足敏感命令在撤销后停止提交的严格语义。

**修复与关闭：**将已验证会话身份带入事务，在等待业务锁后按约定复核撤销、任职与相关权限；针对资金/敏感命令建立明确的撤销线性化点。正常请求成功；barrier 撤销用例无业务写入/成功回执；不要把简单的提交前查询误称为已消除所有竞态。

证据：[extended-http.json](extended-http.json) `revocation`；[复现源](extended-http.mts)。

### P2-05 同一幂等键换请求内容仍被当成成功重放

位置：[bus.ts:181](/Users/naiyouzhu/siteadmin/geniefront-os/apps/api/src/bus.ts:181)。

**实际序列：**相同 key 调 `ticket.open`，第一次 walkInName 为 A；完全相同输入重试；随后把名字改为 B 再重试。

**结果：**首次 201，同输入 200/replayed；异输入也 **200/replayed**，返回同一个 ticketId，数据库仍为 A。现有逻辑只比较 command 名，没有保存/比较规范化输入。

**影响：**客户端复用 key、编辑后重试时可能把旧单当作新请求已完成，出现静默错绑/漏操作。此例没有重复扣款，也未证明跨角色回执泄露。

**修复与关闭：**回执保存稳定的规范化请求摘要，明确租户/主体范围及兼容策略；同 key 同输入保持安全重放，不同业务输入返回冲突。覆盖同内容字段顺序差异、默认值、不同内容、并发以及历史回执。

证据：[extended-http.json](extended-http.json) `idempotency`。

### P2-06 迁移回退测试全绿，却留下过时的函数定义

位置：[hostedBookingSlug.migration.test.ts:47](/Users/naiyouzhu/siteadmin/geniefront-os/packages/db/src/hostedBookingSlug.migration.test.ts:47)、[hostedBookingSlug.migration.test.ts:62](/Users/naiyouzhu/siteadmin/geniefront-os/packages/db/src/hostedBookingSlug.migration.test.ts:62)、[0101 加固迁移](/Users/naiyouzhu/siteadmin/geniefront-os/packages/db/sql/0101_hosted_booking_function_hardening.sql)。

**原因：**用例删除 slug 函数并回放 0095/0096；清理只补到 0097，账本中的 0101 仍标已应用。重新创建的 `gf_shop_slug_canonical` 丢失后续 `search_path` 设置。

**三组证据：**

1. 完整现有 DB 套件 **127/127 通过**，但之后导出的库恢复失败：COPY locations 时 `gf_normalize_shop_slug(text) does not exist`。
2. 恢复对照库只给 canonical 函数补 search_path 后，data/post-data 恢复成功；门店、订单、收款/退款总额和 132 张强制 RLS 表计数一致。
3. 全新库完整迁移+seed，**未经上述用例**，普通 dump/restore 正常。随后在恢复副本单独执行该测试：**1/1 通过**，却再次出现 proconfig 空、0101 账本仍存在。

**判断：**已确认是测试遗留污染，**撤回“当前完整迁移链无法备份恢复”的初步猜测**。它削弱后续测试对当前生产 schema 的代表性；再次 migrate 也不会自动重跑账本已有的 0101。

**修复与关闭：**迁移回退用例使用独立临时数据库或可完整还原的边界；恢复所有受影响的后续迁移/权限，不只修某个函数。断言测试前后关键函数定义、proconfig、授权和迁移账本一致，再运行后续业务套件。禁止在共享开发/生产库执行此回退测试。

证据：[restore-check.json](restore-check.json)、[pristine-restore.json](pristine-restore.json)、[migration-pollution.log](migration-pollution.log)。

## 原 9 项复核与更正

| ID | 本轮状态及实际证据 | 关闭条件 |
|---|---|---|
| P1-01 改价越权 | **再次复现并扩大**：默认技师无 discount 权限；4500 分目录项目覆盖为 0、-100、4600 均返回 201 并持久化对应小计；加项覆盖 0 也成功。目录价格正常路径同样成功。 | 所有改价入口授权；负数拒绝；有权改价与普通开单正向回归。 |
| P1-02 技师订单范围 | **再次复现**：最初 50 条中 39 条他人单含金额；扩展测试传其他员工 staffId，返回 13 条他人单。本人过滤只显示本人，说明过滤存在但可由调用者自行决定。另观察到能给他人单加项，是否应允许需与前台代操作政策区分，不另计缺陷。 | 服务端强制角色/归属范围，详情/列表/汇总一致，合法前台全店读取保留。 |
| P1-03 DNS 重绑定 | **再次本地复现**：校验解析公网，实际连接回环；内部命中 1 次，内容返回。 | 将校验绑定 socket 实际地址，每跳重定向一致；流式上限另验。 |
| P1-04 迁移目标 | **再次纯配置复现**：虚构 staging + 不同迁移目标，守卫退出 0。没有运行该配置的迁移或连接目标。 | 应用/管理员连接按真实项目身份一致校验，生产确认跟随实际目标。 |
| P1-05 测试目标 | **部分改善，未关闭**：loadEnv 仍接受远程 TEST_*；新 seed guard 已拒绝远程和 55322。纯函数对照仍接受 57322 等其他本机库，未验证数据库名/用途。DB 套件不经过 API seed 防线，迁移回退用例直接用 adminSql 改 DDL。不能继续声称现有 API seed 会直接写远程库。 | API/DB/脚本共用首次连接前目标身份验证；seed 保留二次保护；不得把其他本机库等同可销毁测试库。 |
| P2-01 表单 token URL | **源码仍成立**：分享链接仍带 ?t=，部署日志配置未见查询脱敏；有限浏览器验证失效链接不展示内容。未读取真实日志，未使用真实有效令牌验证泄露。 | 新链接与旧链接兼容保护、代理与应用日志过滤、有效/失效提交回归。 |
| P2-02 持久离线 | **源码+响应头仍成立**：订单响应 no-store，apiGet 因此不写 IndexedDB，业务代码仍未接入 apiGetCached。 | 允许缓存的最小字段、TTL/清理、真实离线刷新与重连验证；不可直接取消所有 no-store。 |
| P2-03 CI 门槛 | **源码复核**：自动 verify 仍只有规则/类型；完整测试仅手动工作流。本轮初跑 10 个失败未被这两项绿灯反映。 | 自动测试与发布 SHA 绑定，修复不稳定夹具和旧契约，再验证失败提交被阻断。未访问 GitHub branch protection。 |
| P2-04 依赖公告 | **重新扫描**：24 条（2 critical、12 high、10 moderate）。仍是依赖路径公告统计，不是 24 个已确认生产漏洞。 | 按实际运行时暴露面升级、重扫与回归；本轮不实施升级。 |

以上原问题的完整源码定位和原始语义见 [9 月 27 日报告](../audit-2026-09-27/REPORT.md)。本轮证据优先于旧运行状态。新证据：[extended-http.json](extended-http.json)、[http-repro.log](http-repro.log)、[dns-rebinding.log](dns-rebinding.log)、[migration-guard.log](migration-guard.log)、[test-target.log](test-target.log)、[seed-guard.log](seed-guard.log)、[dependency-audit.json](dependency-audit.json)。

## 本轮运行结果

| 验证 | 实际结果 | 证明边界 |
|---|---|---|
| 规则检查 | 通过 | 静态规则，不代替角色/金额验证 |
| 强制类型检查 | 16 任务通过、0 缓存 | iOS 仍有占位检查；不是运行证明 |
| 无数据库套件 | 1215 通过、1 失败 | 含 jsdom 组件测试，不是实际浏览器全链 |
| DB 套件 | 127 通过、0 失败 | 混合真实 PG 与源码断言；发现 P2-06 污染 |
| API 套件 | 1566 通过、9 失败；127 文件完成 | 混合 HTTP/直接业务调用/纯单元/源码断言，外部替身 |
| 初跑合计 | **2918 项，2908 通过、10 失败** | 重跑不覆盖此统计 |
| Copilot 专项重跑 | 23/23 通过 | 一次重跑通过不能消除初跑不稳定性 |
| 五前端构建 | 全通过 | web/booking 有 chunk 体积提示；产物在 /tmp |
| API esbuild | 通过 | 171.3 kB，外部包未打入；不是正式 Docker 镜像验收 |
| 完整迁移链 | 151 文件成功，RLS 断言通过 | 新库 bootstrap 模拟 Supabase-owned schemas |
| 干净库逻辑备份恢复 | 成功 | 非生产备份；未验证生产 PITR/密钥/对象存储恢复 |
| PostgreSQL 目录 | 132/132 public 表强制 RLS；app_user 无 superuser/bypassrls | 不等于每张表所有 actor/操作均已验证 |
| 暴露函数/视图抽查 | anon 不能执行检查到的 definer；authenticated 可执行 user_in_location；遗留视图 security_invoker=true 且客户端无 SELECT | 本地 catalog，不代表线上配置 |
| 定向真实 HTTP | 改价/读取越权、跨组织绑定、在途撤销、幂等内容冲突反例成立 | 最终业务反例已在干净库重跑 |
| 收银序列 | 开单→完工→混合收款→重放→部分退款→余款全退通过 | 本地现金/卡记账；无真实卡扣款/返款 |
| 浏览器 | 登录页与失效表单链接正确显示，捕获 error/warn 为空 | 仅两页，未登录；[浏览器边界](browser-check.md) |

### 收银正向证据

服务 4500 分、小费 100 分，现金+卡合计 4600 分。错金额请求返回 400 且 paymentRows=0；成功后同 key 重试返回 200/replayed，换 key 再结账返回 409。退款先 1500，再退 3100（含 100 小费）；超额退拒绝。最终 status=refunded，收款=4600、退款=4600，退款记录恰好 2 条。[money-http.json](money-http.json)

退款输入 refundAmountCents 包含 refundTipCents；初次审查脚本曾把小费当作另加而少退 100 分，核对契约后更正并重跑。此为审查脚本输入错误，不作为产品缺陷。

### 失败分类

- `Skeleton.test.tsx`：旧骨架块断言与当前 spinner 组件不一致。
- `phone.test.ts`：原测试只统计正式 membership_id，需同时检验预留技师容量；不直接判重复派人。
- `settings_enhancements.test.ts`：旧店主可写预期与 ops 管理 403 不一致。
- `notify_policy.test.ts`：旧抄送数量/正文契约与当前通知流程不一致。
- `voicePolicy.test.ts`：旧 TeXML timeLimit 断言；不能推出实际 direct SIP 无时限。
- `copilot/acceptance.test.ts`：初跑 5 个场景 failed，单独重跑 23/23。源码以随机 UUID 排序后取第一个 active service，没有限定非加项/技能匹配；这是不稳定夹具的重要线索。未保存初跑每个失败步骤完整错误对象，因此不把具体根因写成已完全证明。重跑后错误步骤查询记录见 copilot-errors.txt，但它不能回溯证明初跑失败原因。
- 上轮随机营销手机号失败本轮未出现，不据此宣称已修复。

## 剩余边界与处理顺序

先处理改价、读取范围、跨组织关联和抓取连接保护；统一实际数据库目标验证，再修复测试清理污染及在途授权。补齐幂等摘要、日志 token、离线契约、CI/依赖。

完整 Supabase Auth/Realtime/Storage、真实支付/通信供应商、独立 worker 在外部接受后的 kill/restart、登录后离线刷新、生产备份/PITR、正式镜像与发布拦截仍未验证。当前没有这些隔离供应商身份和环境的完整配置，不能使用现有生产/开发库来填补证据。

数据库机制参考 [Supabase 官方 RLS 文档](https://supabase.com/docs/guides/database/postgres/row-level-security)：权限与 RLS 需要同时成立。官方机制说明不替代本项目证据。

所有清单项的后续关闭必须引用具体基线、正反对照与运行证据，不能只看问题状态或测试数量。

收尾：已校验开始时1712个源码/配置文件，内容变更0，见 [source-integrity.json](source-integrity.json)。本轮新增文件仅在本审查目录；临时浏览器与本地API/Vite已关闭，新建审查容器已停止保留，未停止原OS/V3容器。
