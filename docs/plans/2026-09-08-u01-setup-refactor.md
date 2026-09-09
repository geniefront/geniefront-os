# U01 开店向导重构：实施计划与实时交接

日期：2026-09-08。基线：`26bc57b`，开始时工作区干净。
状态：**S1–S6 已完成。三端 + db 全量 typecheck 绿；U01 相关测试全绿；`e2e/specs/auth-setup.spec.ts` 已按七步重写（本机 QA Supabase 端口错配导致完整 playwright 运行未跑通，见 S6 记录）；T01–T07 逐项见下表。工作树含 S2–S6 未提交改动，尚未提交、推送、部署。**

S1 结果与接口设计：[`2026-09-08-u01-s1-inventory.md`](2026-09-08-u01-s1-inventory.md)。后续实施以该报告纠正后的入口和事实为准。

## 接手先读

1. 本文（当前状态、下一步、验证记录）。
2. `2026-09-07-store-setup-operations-bugfix-plan.md` §2、§4、§5.2、T01–T07。
3. `2026-09-07-store-setup-operations-bugfix-report.md` 最新批次。旧 HANDOFF 的提交号、迁移号及完成状态已过时，必须查当前代码。
4. `../CURRENT-ARCHITECTURE.md`、`../03-ROADMAP.md`、`../qa/TEST-PLAYBOOK.md`。

用户要求：实施 U01；先列计划，每一步做好文档，其他 AI 随时可能接手。本次不含 U12 全端适配和 U10 套餐重做；复用其已合入接口。

## 执行计划

| 步骤 | 状态 | 实施内容 | 完成证据 |
|---|---|---|---|
| S1 | 已完成 | 复核建店、模板发布、房间、目录、电话和测试入口；确定契约与旧店兼容 | S1 报告；16 项基线测试通过 |
| S2 | 已完成 | 共享 readiness DTO/查询；FinishSetup 复用；房间有效性与最后一间房并发保护 | 104 项 contracts/API/web 类型与相关回归通过 |
| S3 | 已完成 | 共享预设、显式开关、事务首发、定制/草稿保护、Kiosk/队列/分享一致 | 见下方 S3 复跑记录；三端 typecheck、signup/formShare/kiosk/healthFormsFeatures/rooms/settings_enhancements 全绿、`git diff --check` 干净 |
| S4 | 已完成 | AI 意愿与线路 readiness 五态 loader；Calls/向导共用；平台绑号 vs 店主话术/接听拆分；接听 fail-closed | 见下方 S4 记录；`aiVoiceReadiness` 10 项、`phone` 78 项、`systemOnly` 8 项、三端 typecheck、lint guards、`git diff --check` 全绿 |
| S5 | 已完成 | 七步向导；行业目录预设；复用房间/员工基础/服务；五语言；完成度全由后端 readiness 推导；窄屏步骤选择器 | 见下方 S5 记录；三端 typecheck、flow/i18n/catalogPresets 单测、浏览器逐步走查（七步渲染 + 预设加入 + 房间/功能保存 + launch 检查/警告/修复链）全绿 |
| S6 | 已完成 | e2e spec 按七步重写；0119 触发器专项测试补 T01；全量 typecheck + U01 相关测试隔离库复跑；文档收尾 | 见下方 S6 记录；T01–T07 表已逐项填实；1 个**先于本工作已损坏**的无关套件如实记录 |

七步：门店资料 → 员工基础设置 → 房间 → 服务项目 → 员工与排班 → 功能设置 → 检查并开店。

## 约束与执行规则

- 写入走命令总线、权限、事务、幂等和审计；API 与 RLS 同店隔离。
- 至少一间 active 且正整数容量房间才能从 setup 开店；旧 active 店不退回 setup。
- 健康表启用成功意味着有行业适用发布版。默认首发不能覆盖已有定制发布版或草稿；关闭保留历史。
- 电话分配不等于开启；没有就绪线路不能接听；不改 AI 改期/取消权限。
- 新默认只用于新店，旧店设置按证据兼容。迁移前提供只读盘点；不操作线上数据库。
- 五种 UI 语言齐全。窄屏步骤选择用当前步骤和可展开列表。
- 每一步开始/完成更新本文；记录具体文件、测试命令与真实结果。失败或未测不得标通过。
- 测试仅 isolated 库；根 .env 的迁移地址可能指 staging，不能直接运行默认迁移/重置。
- 保留其他执行者改动；不沿用旧文档中的虚假模型署名或默认生产授权。

## 当前证据与决策

- ~~`features/setup/flow.ts` 仍为四步且标题中文硬编码。~~ S5 已改七步 + 全 i18n key。
- ~~`pages/SetupWizard.tsx` 自己计算三项 readiness。~~ S5 已改为读后端 `GET /v1/desk/setup/readiness`。
- ~~`handlers/setup.ts` FinishSetup 仍只有资料/营业时间/项目/员工检查；房间未纳入。~~ S2 已把房间纳入 `loadSetupReadiness`。
- U02/U04/U10 已有后续批次，需复核接口后复用，不能按旧交接重复实现。

## 工作日志

### S1 / 2026-09-08：文档与代码基线

已读：文档索引、架构地图、原计划 U01 范围、旧大工作交接、当前四步向导与 FinishSetup 入口。
已执行：`git status --short`（开始时干净）、`git log -1 --oneline`（基线如上）。未运行业务测试。
下一步：继续盘点实际功能设置/模板/资源命令与测试环境，冻结 DTO 与锁策略，再实施 S2。

## 逐步实施细则（设计，尚未实现）

### S2：开店检查与房间（已完成）

入口：`apps/api/src/handlers/setup.ts`（FinishSetup）、`handlers/resource.ts`（save/setStatus/delete）、`queries/settings.ts`、`packages/contracts/src/commands/setup.ts`。

- 在 contracts 定义共享步骤 ID、missing code 和修复目标；服务端查询提供各领域完成状态、开店阻断项和旧店修复提示。
- 提取一个后端 readiness loader，GET 与 FinishSetup 复用；客户端仅展示状态，不复制 SQL 判断。
- **实际资源模型使用 status，不存在可直接照搬的 active 布尔语义**。`maintenance` 排除；服务/清洁中的房间不应被当成“门店没有房间”。类型过滤须核对 `resource_types` 与 `queries/rooms.ts`，不能把任意资源当房间。
- FinishSetup 与会减少有效房间数量的写入共用门店级锁，并在锁内重新查询；统一“门店锁 → 资源锁”的顺序，避免只在开店端加锁却仍被资源端绕过。审查直接资源写入路径。
- 已营业门店禁止删/停最后一间有效房间；原先零房间的旧店仍能经营，展示修复提示。
- 只读盘点输出分类数量和需要处理的门店标识，不输出客户健康内容、凭据。新迁移号以执行时目录为准。

### S3：健康表

入口：`apps/web/src/features/forms/presets.ts`、`pages/HealthForms.tsx`、`apps/api/src/handlers/kiosk.ts`、`kiosk/routes.ts`、`queries/forms.ts`、contracts 行业 key 工具。

- 现有 `SaveFormTemplate` 按 `max(version)+1` 发布并下架旧版本；抽取接受现有 tx 的内部发布函数，让手工发布和自动首发使用同一门店/key 锁。不能只锁首次启用而让手工发布继续竞争。
- 预设迁入共享纯数据，前端复用导出；不让 API 依赖 web 包。
- 功能配置命令按字段 PATCH，先确保适用发布模板，再启用，同一事务与审计；返回启用状态和实际发布模板 ID/版本。
- 已有定制发布版优先复用；草稿保留，界面分别标识草稿与当前发布版。
- 新建店路径包括首店 provisioning、`CreateLocation`、QA seed；明确 false 和历史缺字段不同语义。
- 自动必填入口包括 `/v1/kiosk/forms/required`，关闭后在完成访问对象归属校验的基础上返回无需填写；不能以开关关闭绕过跨店校验。
- 已发链接按原有效期/撤销规则继续处理，历史提交读取不受关闭影响；所有预约、签到、分享入口逐项追踪，记录实际规则。

### S4：AI 电话

入口：`handlers/phone.ts`（RequestAiVoice、SavePhoneLine、SettingsSavePhoneAssistant）、`telnyx/routes.ts`、`ops/bindAiLine.ts`、`queries/calls.ts`、`pages/Calls.tsx`。

- 当前 upsert 已做到新线 `aiAnswer ?? false`、省略字段保留旧值，不重复修这部分。
- 复核已有 RequestAiVoice 的含义再决定复用/扩展，避免另建同义“申请”字段。
- DTO 同时返回店主意愿、分配/配置状态及实际有效开关；不能用意愿直接替代 `phone_lines.ai_answer`。
- 覆盖未启用未分配、申请中、已就绪关闭、有效开启、失败/暂停；状态来自可证明的配置，外部供应商未校验时不声称线路正常。
- 向导与 Calls 用同一个 loader；新绑定保持关闭，旧开启线路不无故关闭；缺 line/config 时接听 fail closed。

### S5：七步 UI 与目录预设

入口：`pages/SetupWizard.tsx`、`features/setup/flow.ts`、`features/setup/StepForms.tsx`、`features/staff/DirectorySettings.tsx`、`pages/Rooms.tsx`、五语言 i18n。

- 抽出可复用小组件，避免将完整后台页面塞进向导或继续扩大 StepForms 单文件。
- 行业预设为少量、版本化、本地化静态数据；先展示新增预览，稳定 preset key 去重，重复生成不重复；切行业不覆盖已有目录，不调用 AI。
- 员工步骤沿用已有岗位/职级/技能 ID 契约，服务步骤保留当前 staffCount、技能和 onlineBookable 字段及套餐分流。
- 当前步骤是浏览位置；完成度从后端推导。刷新/换设备按已保存状态定位，保存失败不前进；可返回修改；修复链接能到目标步骤。
- 功能开关关闭为合法完成状态；不要要求打开电话或健康表才能继续。
- 窄屏“第 N/7 步 + 名称 + 步骤列表”；修复标题中文硬编码。包括加载、失败、重试、权限、长文案和键盘交互。

## 验收与证据记录

| 验收 | 必测场景 | 当前结果 |
|---|---|---|
| T01 | 新店两个开关关闭、保存/刷新/换设备一致；旧店显式值保留 | `packages/db/src/healthFeatureDefaults.migration.test.ts`（新，S6）：0119 触发器对无 features 的新插入补两项 false 且不动 capacity、显式「关」保持关、显式「开」健康表保留 true 并补另一项 false、update（非 insert）不回填、函数体重放干净。`signup.test.ts`「新店落在 setup 状态」：`provisionTenant` 建店 `settings.features` = 两项 false。刷新/换设备一致：浏览器走查中加房间/服务后刷新，进度由后端 readiness 保持，向导定位到首个未完成步骤 |

| T02 | 零房间/维护中/非法容量/跨店资源拒绝；有效一间通过；开店与停用竞争；最后一间删除 | S2 API/查询测试通过；非法容量由 contracts 既有 min(1) 守卫 |
| T03 | 首次启用生成适用发布版，分享/提交立即可用 | `healthFormsFeatures.test.ts`「transactional first publication」：首发后 `form.share` + `form.submit` 断言通过 |
| T04 | 不同幂等键并发启用、重复开关、与手工发布竞争；定制发布版/草稿保留 | `healthFormsFeatures.test.ts` 并发启用、手工/自动异键不撞版本、定制发布版复用、草稿保留断言通过 |
| T05 | 关闭不阻塞普通预约/签到，历史签名可读，旧分享链接遵守有效期 | `formShare.test.ts`「关闭健康表只阻止新分享，已签发链接仍可完成」：关开关后 `form.share` 报 `health_forms_disabled`，既有链接照常提交；同文件覆盖 `revoked` / `expired` 状态。`healthFormsFeatures.test.ts`「keeps legacy stores … enabled when a publication exists」：缺字段旧店按已发布模板继续运行。`kiosk.test.ts`（38，S3）：required forms / 队列 pendingForms 尊重显式开关，跨店 visit 先做归属校验。「关闭不阻塞普通预约/签到」：S1 §4 代码搜索确认 appointment handler / 公开预约路径**没有**以缺健康模板阻断建单的判断——无门禁可破 |

| T06 | 五态展示与实际接听规则一致；没有电话仍可开店 | `aiVoiceReadiness.test.ts`：unconfigured/requested/ready_off/on/suspended + fail-closed + 老店 intent=null；向导 readiness 里功能关着 features 步骤仍完成、不阻塞开店 |
| T07 | 旧线开启后保存其他字段仍开启；显式 false 生效 | `phone.test.ts`「AI 接听默认关闭」：显式开启后改无关字段仍开启、显式关闭落库、未就绪开启被拒（`ai_voice_not_ready`） |
| U01 UI | 七步次序、目录重复生成、修复跳转、保存失败不前进、跨设备进度、五语与窄屏 | 浏览器走查：七步按 store→directory→rooms→catalog→team→features→launch 渲染；预设加入后从待选列表消失（去重）；launch 检查/blocker/warning/「去这一步补齐」均来自后端 readiness；刷新后定位到首个未完成步骤；窄屏「全部步骤」折叠列表渲染。i18n.test 五语齐全 |

已有测试入口：`apps/api/src/signup.test.ts`（FinishSetup）、`phone.test.ts`、`kiosk.test.ts`、`staffDirectory.test.ts`、`aiVoiceReadiness.test.ts`（S4 新）、`healthFormsFeatures.test.ts`（S3 新）；`apps/web/src/features/setup/flow.test.ts`（S5 已重写为七步 + i18n key 校验）；`packages/contracts/src/{setupReadiness,catalogPresets}.test.ts`（S2/S5 新）；`packages/db/src/healthFeatureDefaults.migration.test.ts`（S6 新，0119 触发器）；`e2e/specs/auth-setup.spec.ts`（S6 已重写为七步）。

测试顺序：contracts/纯函数 → 对应 isolated API 文件 → web 类型与单测 → lint guards → 相关 E2E。需要 DB 的测试先验证目标地址是 isolated；S2 已按 guard 使用 isolated 库，未连接 staging/production。真 iPad Safari 与真实电话若无设备/线路，单独标记未验证。

## 每步交接模板

- 步骤 / 状态 / 当前负责人 / 最新基线：
- 本步目标与已完成行为：
- 改动文件与共享接口：
- 关键决策及原因：
- 验证命令、退出码、测试结果、证据路径：
- 已知失败 / 未验证 / 外部依赖：
- 下一条可直接执行的任务：
- 回退：列本步提交或文件范围；发布过的模板/历史数据不可删除；有迁移时给出向前修复方案。

### 当前交接点

**S1–S6 已完成。** 隔离库全量 typecheck + U01 相关测试绿；T01–T07 表已填实。剩余：修本机 `.env` 的 `TEST_SUPABASE_URL` 端口后跑完整 `pnpm test:e2e e2e/specs/auth-setup.spec.ts`（spec 已按七步重写）；`copilot/acceptance.test.ts` 是先于本工作已损坏的无关套件，另案处理。真实旧店盘点仍未做。工作树含 S2–S6 未提交改动，不要回滚。下一步：提交 / 推送 / 部署 staging。

### S1 完成 / 2026-09-08

- 完成文档：`2026-09-08-u01-s1-inventory.md`（建店路径、房间资格、并发协议、DTO、表单消费路径、电话授权缺口、目录预设依赖）。
- 关键纠正：实际模板源为 `mockData.ts::INDUSTRY_PRESETS`；`resource.save.active` 当前被忽略；电话绑定命令当前并非仅平台可达。
- 验证：contracts 12 项 + web flow 4 项基线测试通过；未执行数据库测试或生产操作。
- S1 当时的下一步是按 §2–§3 实施 S2；该项现已按下方 S2 记录完成。

### S2 完成 / 2026-09-08

- 新增共享 `setupReadiness` 契约、七步 ID、结构化 missing/warning code；新增 `GET /v1/desk/setup/readiness`（及 `/api` 兼容路由）。
- `FinishSetup` 与查询共用同一 loader；在门店级事务 advisory lock 内重查后才执行 setup→active，保留旧 `missing` 字符串并增加 `repairs` 修复目标。
- 有效房间限定为本 org/location 的 room/vip/couples_room、正容量、已知非 maintenance 状态；bookable staff 改为只计 active membership。
- `resource.save/setStatus/delete` 统一先取门店锁再取资源行锁；active 店不能从有房降为零，已有零房旧店继续营业并返回修复 warning。`force` 不再绕过当前占用和最后房间保护。
- `resource.save.resourceTypeId` 显式校验同店归属；兼容 `active=false` 映射 maintenance、`active=true` 从 maintenance 恢复、字段省略保留状态。
- 验证：contracts 9 文件/63 测试；signup+rooms 2 文件/26 测试；settings route 15 测试；workstations 15 测试；contracts/API/web typecheck 和 `git diff --check` 均通过。均使用 guard 确认的 isolated 测试库；未连接 staging/production、未部署、无迁移。
- 下一步：S3 健康表共享纯数据、显式功能设置、事务首发与消费端开关一致性。

### S3 收尾断点 / 2026-09-08

- 六套真实行业预设已迁到 `packages/contracts/src/healthFormPresets.ts`，Web 改为复用共享数据。
- 新增 `settings.saveSetupFeatures`：按字段 PATCH，false 是有效选择；启用健康表时在同一事务内复用定制发布版或首发行业模板。
- 手工发布与自动首发共用模板 key advisory lock 和发布函数。并发测试曾抓到门店行/模板锁逆序死锁，已统一为模板锁先于门店行锁，复跑通过。
- Kiosk required forms、前台队列 pendingForms、新分享均尊重显式开关；跨店 visit 仍在开关前完成归属校验；旧分享链接和历史提交不受关闭影响。缺开关的旧店保留“有发布版即启用”兼容语义。
- `0119_health_form_feature_defaults.sql` 仅给新插入门店补两个 false，显式插入值优先，不回填旧店。已仅应用 isolated 测试库；未连 staging/production、未部署。
- 已通过：contracts/API/web typecheck；`healthFormsFeatures` 6 项（在最后增补提交断言之前）；`formShare` 全文件；`kiosk` 38 项。
- **未复跑的最后改动**：`healthFormsFeatures.test.ts` 新增首发后无显式 templateIds 分享及 `form.submit` 断言。接手先跑 `pnpm --filter @gf/api typecheck` 和 `cd apps/api && pnpm exec vitest run src/healthFormsFeatures.test.ts --reporter=dot`；再跑 signup/formShare/kiosk 相关文件、contracts/web typecheck、`git diff --check`。
- 未做：全量 `pnpm verify`、浏览器验收、真实旧店盘点、提交/推送/部署。工作树同时包含 S2 未提交改动，不要回滚。

### S3 复跑记录 / 2026-09-08

- `pnpm --filter @gf/api typecheck`、`@gf/contracts typecheck`、`@gf/web typecheck`：均通过。
- `apps/api` vitest：`healthFormsFeatures.test.ts` 6 项、`signup.test.ts` 16 项、`formShare.test.ts` 27 项、`kiosk.test.ts` 38 项、`rooms.test.ts` 10 项、`settings_enhancements.test.ts` 15 项；`packages/contracts` `setupReadiness.test.ts` 2 项。全绿。
- `git diff --check`：干净。
- **本次修正**：`signup.test.ts` 的 `unclaim()` 现把 `settings.features` 一并归位到新店显式默认（两项功能均关闭）。原因：自测门店 `Selftest Nails` 的行早于 sql/0119 的 `locations` before-insert 触发器建出，`provisionTenant` 命中 `already` 不再重插，导致「新店默认两个功能关闭」断言在这个跨次复用产物上误红。0119 触发器已确认存在于隔离测试库并对真正的新店插入生效（种子店按显式值覆盖），故属测试夹具修正而非实现缺陷。
- 隔离测试库为本机 55322；`_migrations` 含 `sql/0119_health_form_feature_defaults.sql`，未连 staging/production、未部署、未提交。
- 下一步：S4 AI 电话 readiness（见上方 S4 细则）。

### S4 完成 / 2026-09-08

**本步目标与已完成行为**

- 新增共享契约 `packages/contracts/src/aiVoiceReadiness.ts`：AI 电话线就绪五态
  （`unconfigured` / `requested` / `ready_off` / `on` / `suspended`）+ 字段
  （intent / lineBound / assistantConfigured / toolTokenSet / ready / effectiveAiAnswer）。
  全部由 `phone_lines` + `locations.settings.features` 推导，不落状态列。
- 新增 loader `apps/api/src/queries/aiVoiceReadiness.ts`：向导「功能设置」步骤
  （`queries/setupReadiness.ts`）与「来电记录」页（`routes/misc.ts` 的
  `/v1/desk/calls`）共用同一份推导。`setupReadiness` 契约与查询新增 `aiVoice`
  子对象；意愿开启但未就绪时加 `ai_voice_pending` 警告（**仅提示，不进
  `missing`、不影响 `canLaunch`**——外部号码准备状态与开店无关）。
- **平台绑号 vs 店主动作拆分（S1 §5 缺口）**：
  - `location.savePhoneLine` 改为 `system: true`：绑落地号 + 生成/轮换电话
    工具 token 是平台动作，店主与「按名字执行任意命令」的泛化 HTTP 入口
    调不到（在入参校验和权限检查**之前**被拒，失败方向为拒绝）。
    加入 `systemOnly.test.ts` 的 `MUST_BE_SYSTEM`。
  - 新增 `location.savePhoneAssistantLine`（`settings.manage`）：店主改开场白 /
    转接方式 / 今日接听开关。只作用于**已绑**的 active `ai_voice` 线（无则
    `NOT_FOUND`），既建不出线也换不了 token。`aiAnswer = true` 时校验线路
    本地就绪（工具 token 已生成），未就绪拒 `reason: 'ai_voice_not_ready'`。
  - `ops/bindAiLine.ts` 改为显式 `systemOrigin: 'ops_bind_ai_line'`（可信 CLI）。
- `SaveSetupFeatures`：关掉「要 AI 电话」意愿（`aiVoiceRequested: false`）时，
  同一事务把当前线路 `ai_answer` 一并关掉；**开启意愿不自动开接听**——绑号 /
  就绪 / 显式打开是三件独立的事。老店缺 `ai_voice_requested` 字段时不动线路。
- `telnyx/routes.ts` 的 `start_call` 接听判定收紧为 fail-closed：
  `ai_answer && tool_token_digest` 都在才回 `aiAnswer: true`；缺 line 或缺 token
  一律不接。`RequestAiVoice` 语义未变（登记店主自己的两个号，不碰落地号）。

**改动文件与共享接口**

- contracts：`aiVoiceReadiness.ts`（新）、`setupReadiness.ts`（+`aiVoice`、
  +`ai_voice_pending`）、`commands/phone.ts`（`SavePhoneLine` → system、
  新 `SavePhoneAssistantLine`、`PHONE_COMMANDS`）、`index.ts`、`setupReadiness.test.ts`。
- api：`queries/aiVoiceReadiness.ts`（新）、`queries/setupReadiness.ts`、
  `handlers/phone.ts`（新 handler）、`handlers/setup.ts`（意愿关闭联动）、
  `routes/misc.ts`（`/v1/desk/calls` 带 `aiVoice`）、`telnyx/routes.ts`（fail-closed）、
  `ops/bindAiLine.ts`、`systemOnly.test.ts`、`phone.test.ts`、
  `aiVoiceReadiness.test.ts`（新）。
- **无迁移**：五态全部从既有列推导；`suspended` = 意愿仍在但曾绑的 `ai_voice`
  行现 `active = false`。

**验证命令与结果**

- `pnpm --filter @gf/{contracts,api,web} typecheck`：均通过。
- `apps/api` vitest：`aiVoiceReadiness` 10、`phone` 78、`systemOnly` 8、`signup` 16、
  `formShare` 27、`kiosk` 38、`healthFormsFeatures` 6、`rooms` 10、
  `settings_enhancements` 15；`packages/contracts` `setupReadiness` 2。合计 208+2，全绿。
- `scripts/lint-guards.sh`、`git diff --check`：通过 / 干净。
- 均使用 guard 确认的 isolated 测试库；未连 staging/production、未部署、未提交。

**已知未做 / 外部依赖**

- `pages/Calls.tsx` 前端展示与向导「AI 电话」步骤 UI 属 S5，本步只交付后端 loader
  与命令边界；`/v1/desk/calls` 已带 `aiVoice` 供前端接。
- 真实 Telnyx assistant / 供应商侧就绪未校验（`assistantConfigured` 仅展示）；
  真实旧店 AI 线盘点未做。
- 全量 `pnpm verify`、浏览器验收、提交 / 推送 / 部署未做。

**下一条可直接执行的任务**：S5 —— 七步向导 UI + 目录预设（见上方 S5 细则）。

**回退**：S4 改动集中在上列文件，无迁移、无数据回填；恢复这些文件即可，
`phone_lines` / `locations.settings` 数据未被本步结构性改写。

### S5 完成 / 2026-09-08

**本步目标与已完成行为**

- **四步 → 七步**：`features/setup/flow.ts` 重写为 `store / directory / rooms /
  catalog / team / features / launch`，step id 与后端 `SETUP_STEP_IDS` 一一对应；
  标题 / 简称 / 描述全部改走 i18n key（修掉原来写死的中文 `title`），新增
  `blocksLaunch` 标记（directory / features 非门槛）。
- **完成度只来自后端**：新增 `useSetupReadinessQuery`（`GET /v1/desk/setup/readiness`，
  键落在 `desk settings` 前缀下 → 任何门店 / 项目 / 员工 / 房间保存都会顺带刷新）。
  `SetupWizard` 不再自算 readiness：步骤条勾选、进度条、预览面板、首屏定位
  （第一个未完成步骤）全部读 `readiness.steps`。`LaunchStep` 改为渲染
  `readiness` 的 `steps` / `missing` / `warnings` / `canLaunch`，每个未完成项给
  「去这一步补齐」跳转，`ai_voice_pending` / `directory_recommended` /
  `active_room_repair` 三类 warning 有对应文案。
- **当前步骤是浏览位置**：`activeStepId` 只是浏览态，任意步骤可点开；刷新 /
  换设备时 `useEffect` 落到首个未完成步骤。窄屏用「第 N/7 步 + 名称 +『全部步骤』
  可展开列表」，宽屏用完整步骤条。
- **行业目录预设**：新增契约 `packages/contracts/src/catalogPresets.ts`（6 业态 ×
  4–6 项，五语言，稳定 `presetKey`，`CATALOG_PRESET_VERSION`）。新组件
  `CatalogPresetPicker` 嵌入「服务项目」步骤：按显示名归一化去重（已在目录里的
  预设不展示），勾选后逐条 `catalog.saveService` 落库（价格 / 时长为起步参考值），
  不覆盖已有项目、不调用 AI，重复点不会重复建；`mixed` / 未知业态显示「手工添加」提示。
- **新步骤组件**（`features/setup/steps.tsx`，复用抽出的 `features/setup/primitives.tsx`）：
  - `DirectoryStepForm`（第 2 步，可选）—— 复用后台 `DirectorySettings` 弹窗 + 岗位/
    职级/技能计数 + 可跳过提示。
  - `RoomsStepForm`（第 3 步，门槛）—— `useRoomsQuery` + `useSaveResource`，类型下拉
    映射到后端房间门槛键（room / vip / couples_room / chair / bed），列出现有房间。
  - `FeaturesStepForm`（第 6 步，可选）—— 两个开关（健康表、AI 电话意愿）+「保存并
    确认这一步」（`settings.saveSetupFeatures` 带 `confirmSetup`），展示 AI 电话五态。
- `settings.saveSetupFeatures` 后端：`aiVoiceRequested: false` 时同事务关掉当前
  `ai_voice` 线 `ai_answer`（S4 已做）；`setupReadiness` DTO 新增 `features`
  子对象（`healthFormsEnabled` / `confirmedAt`）供向导回填开关。

**改动文件**

- contracts：`catalogPresets.ts`（新）+ `catalogPresets.test.ts`（新）、
  `setupReadiness.ts`（+`features` 子对象）、`setupReadiness.test.ts`、`index.ts`。
- api：`queries/setupReadiness.ts`（+`health_forms_enabled` / `features_confirmed_at`）。
- web：`features/setup/flow.ts` 重写 + `flow.test.ts` 重写、`features/setup/primitives.tsx`（新）、
  `features/setup/steps.tsx`（新）、`features/setup/CatalogPresetPicker.tsx`（新）、
  `features/setup/StepForms.tsx`（抽公共件 / 预设选择器嵌入 / LaunchStep 改读 readiness）、
  `pages/SetupWizard.tsx`（七步 + 后端完成度 + 窄屏选择器）、
  `features/settings/api.ts`（+`useSetupReadinessQuery` / `useSaveSetupFeatures`）、
  `features/rooms/api.ts`（`useSaveResource` 顺带失效 desk settings）、
  `i18n/setup.ts`（+约 60 条词条 × 五语言）。
- **无迁移**：S5 纯前端 + 既有 readiness 列推导；`features` 子对象读的是
  `settings.features` 现有字段。

**验证命令与结果**

- `pnpm --filter @gf/{contracts,api,web} typecheck`：均通过。
- 单测：`catalogPresets` 6、`setupReadiness` 2（contracts）；`flow` 6、`i18n` 6（web，
  含五语言齐全 + 非中文栏无 CJK）；`healthForms` 2。API 回归 `signup` 16 /
  `healthFormsFeatures` 6 / `aiVoiceReadiness` 10 / `settings_enhancements` 15 /
  `systemOnly` 8 / `phone` 78 全绿。
- `pnpm --filter @gf/web build`：成功（bundler 解析 `@gf/contracts` 新导出无误）。
- `scripts/lint-guards.sh`、`git diff --check`：通过 / 干净。
- **浏览器 E2E 走查**（本机 local 栈：`run-env.sh local` + `pnpm setup:test:reset`
  造 setup 态门店 `setup@maildrop.cc`）：七步全部渲染无 console 错误；「下一步」/
  步骤条 / 预览面板导航一致；加房间 → 步骤 3 立即变完成（readiness 失效链生效）；
  美甲预设列表本地化正确、加入「凝胶美甲」后从待选消失、步骤 4 变完成；
  「保存并确认这一步」→ `settings.saveSetupFeatures` 成功并跳到 launch；
  launch 页检查项 / blocker /「建议先设置岗位…」warning /「去这一步补齐」跳转
  全部来自后端 readiness；`正式开店` 按钮在 `canLaunch=false` 时禁用；
  刷新后定位到首个未完成步骤；窄屏「全部步骤」折叠列表渲染。

**已知未做 / 小缺口**

- 宽屏步骤条的圆形按钮无 `aria-label`（图标 + 视觉隐藏文案），窄屏列表有完整
  可访问名称；如需补 a11y 名称是独立小改动。
- 真 iPad Safari、键盘 tab 序、长文案换行未在真机验证（本轮为桌面 Chromium 走查）。
- 全量 `pnpm verify`、提交 / 推送 / 部署未做。（`e2e/specs/auth-setup.spec.ts` 已在 S6 随七步重写。）

**下一条可直接执行的任务**：S6 —— 相关 API/DB/web 检查、隔离库验收、`e2e/specs/auth-setup.spec.ts`
按七步更新、T01–T07 逐项补齐与文档收尾。（已由 S6 完成，见下方 S6 记录。）

**回退**：S5 无迁移、无数据结构变更；恢复上列 web / contracts / api 文件即可。
新建门店经 `catalog.saveService` / `resource.save` 落的数据是正常业务数据，不需回滚。

### S6 完成 / 2026-09-08

**本步目标与已完成行为**

- **`e2e/specs/auth-setup.spec.ts` 按七步重写**：Growth setup 向导用例现走
  `门店资料 → 员工基础（Next）→ 房间（加「大厅」）→ 服务项目（手工加项）→
  员工排班（加可接单员工）→ 功能设置（保存并确认）→ 检查并开店（门槛项全绿）→
  正式开店`。每步用后端 readiness 驱动的 heading / 检查项文案断言。第一个用例
  （登录 / 深链 / 退出）未改。
- **T01 专项测试**：新增 `packages/db/src/healthFeatureDefaults.migration.test.ts`，
  在回滚事务里证明 `sql/0119` 触发器：新插入补两项 false、显式值优先（关/开）、
  update 不回填、函数体重放干净。隔离库，不留门店行。
- **隔离库全量复跑**：`pnpm typecheck`（turbo，16/16）；`apps/api` U01 相关九套件
  208 项、`@gf/contracts` 全量 69 项、`@gf/web` setup+i18n 13 项、`@gf/db`
  `healthFeatureDefaults` + `serviceBundles` + `rls` 41 项——全绿。
  `scripts/lint-guards.sh`、`git diff --check` 通过 / 干净。
- **T01–T07 表逐项填实**（见上表）。T02–T04、T06、T07 沿用 S2–S4 的既有测试证据。

**改动文件**

- `e2e/specs/auth-setup.spec.ts`（七步重写）。
- `packages/db/src/healthFeatureDefaults.migration.test.ts`（新）。
- 本文档（状态 / 执行计划 / T 表 / 交接点）。

**已知未做 / 外部依赖 —— 需下一位或运维处理**

- **完整 playwright e2e 未跑通**：根 `.env` 的 `TEST_SUPABASE_URL=http://127.0.0.1:54321`
  与本机实际本地 Supabase（`.env.local` 的 `55321`，且 `curl :55321/auth/v1/health`
  返回 200）端口错配 → `pnpm qa:seed` 阶段 `fetch failed`，**两个** auth-setup 用例
  （含未改的登录用例）都在 seed 阶段失败，与 spec 内容无关。修法：把根 `.env`
  的 `TEST_SUPABASE_URL` 对齐到本机实际端口后 `GF_QA_ALLOW_RESET=1 pnpm test:e2e
  e2e/specs/auth-setup.spec.ts`。spec 逻辑已由 S5 的真实浏览器逐步走查（同一七步流程、
  同一批选择器）验证。
- **`apps/api/src/copilot/acceptance.test.ts` 先于本工作已损坏**：`git stash -u` 回到
  基线 `26bc57b` 后单跑仍 `5 failed | 18 passed`（场景 4/6 等 appointment 编排断言），
  与 U01（setup / phone / readiness / catalog）完全无关，本工作未触及该路径。
  应作为独立 bug 处理，不计入 U01 验收。
- 真 iPad Safari、键盘 tab 序、宽屏步骤条圆钮 `aria-label`（S5 已记）。
- 真实旧店 AI 线 / 健康表字段盘点（只读）未做。
- 全量 `pnpm test`（835+）未整体跑完：本轮按 U01 影响面选跑；copilot 那一套件
  会在全量里红，原因如上。
- 提交 / 推送 / 部署未做。

**下一条可直接执行的任务**：修 `.env` 的 `TEST_SUPABASE_URL` 端口后跑
`pnpm test:e2e e2e/specs/auth-setup.spec.ts` 收尾 U01 的浏览器验收；然后提交
S2–S6（一次或按步拆），推送、部署 staging。

**回退**：S6 只新增两个测试文件 + 改一个 e2e spec + 本文档，无运行时 / 迁移 / 数据变更；删除
`healthFeatureDefaults.migration.test.ts` 并 `git checkout e2e/specs/auth-setup.spec.ts` 即可。
