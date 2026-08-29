# 技师端生产化实施交接

> 最后更新：2026-08-29
> 当前负责人：Codex `/root`
> 工作分支：`main`（开始时 HEAD `e325b74`）

## 目标

把 `apps/web/src/features/tech` 从 localStorage 驱动的高保真 prototype 改成可供门店真实使用的企业级技师移动工作台。优先保证“查看今日任务 → 接收派单 → 打卡 → 开始服务 → 完成服务 → 收入同步”闭环；没有正式后端契约的交互不得伪造成功。

## 不可破坏的业务边界

- 技师端是前台工作台的可选增强端，故障时不能阻塞前台代办。
- 所有写操作继续走 `/v1/commands/:name`，不新增页面裸 POST。
- 服务端决定租户、权限、手机号脱敏、金额和工单状态；前端只负责呈现。
- 客户健康提醒、联系方式和服务备注不得写入日志、埋点或持久化浏览器偏好。
- 离线时只读，不排队重放开始、完成、打卡等动作。
- 真实数据来自带 RLS/权限的查询；Realtime 事件只触发重新拉取，不直接作为显示数据。

## 开始时现状

- `/tech/today`、`/tech/summary`、`/tech/profile` 三个路由已存在。
- 全部技师业务状态来自 `features/tech/lib/mockData.ts` 和 localStorage。
- 后端已有 `GET /v1/staff/me/today`、`ticket.startItem`、`ticket.finishItem`、`timeclock.punch`、`staff.setLocale`。
- 历史提交 `4cf09d8^` 中曾有可运行的 `apps/staff`，包含 Realtime、presence、60 秒轮询、`visibilitychange`/`online` 对齐和声音/震动；本轮迁移其可靠性模式到统一 `/tech`，不直接恢复旧 App。
- Web manifest 引用的 `icon-192.png`、`icon-512.png` 不存在，Web 端没有 Service Worker 注册。
- 技师端没有专项测试。

## 实施计划与进度

| 阶段 | 状态 | 说明 |
| --- | --- | --- |
| 0. 基线与交接记录 | 已完成 | 已完成仓库、后端契约、历史实现和构建基线审查；本文件已建立。 |
| 1. 今日工作真实闭环 | 已完成 | 已建立 tech API/query/type 层，接通今日快照、打卡、开始/完成、语言；加入技师路由门禁；移除生产界面的 mock、模拟派单、假拒单和假加项。 |
| 2. 实时与弱网 | 已完成 | 私有频道、presence、60 秒兜底、后台/联网对齐、连接状态、新派单声音/震动/视觉提醒已接入；事件仅触发授权快照刷新。 |
| 3. 业绩与个人中心 | 已完成（按现有契约） | 业绩页仅展示服务端今日收入和完成项；个人资料与 7 日已发布排班已真实化；无契约的周/月收入和期望工时已移除。 |
| 4. PWA 与可访问性 | 已完成 | 已补图标、SW、生产注册、安装入口、可缩放 viewport、设备本地声音/常亮偏好和安全缓存边界。 |
| 5. 测试与交付 | 已完成（有仓库外部阻塞） | Tech/Web/相关 API 验证均通过；全仓 `verify` 仅被既存 iPad 手机格式测试的 2 个失败阻断，详见下方。 |
| 6. 小费与派工闭环 | 已完成 | 现金直收不可变记账、项目小费状态、技师档案只读展示、presence 前台同步、服务技能要求、逐项目/多技师候选与开单约束均已完成；自动化及真实双标签浏览器流程通过。 |

## 验证基线

2026-08-29 开始实施前：

- `pnpm --filter @gf/web typecheck`：通过。
- `pnpm --filter @gf/web test`：13 个文件、71 项测试通过；无技师端测试。
- `pnpm --filter @gf/web build`：通过。

## 已知后端契约缺口

以下 prototype 功能不能直接上线，必须先找到或新增正式契约：

- 拒绝派单及原因记录。
- 技师自助加项所需的可售目录、价格快照、权限与命令输入规则。
- 技师本人周/月收入流水与趋势查询（`/v1/me/summary` 仅允许管理报表角色，不可复用）。
- 技师“期望上/下班时间”持久化。
- 换班、休息申请、已读排班等审批流。

## 接手方式

1. 先读本文件、`docs/00-DISCOVERY.md` 技师端章节、`docs/18-API-REFERENCE.md` §10。
2. 运行 `git status --short`，不要覆盖用户或其他代理的未提交改动。
3. 从表格中第一个未完成阶段继续；每完成一个可验证切片就更新状态、文件清单与验证结果。
4. 若需要改后端契约，先更新 contracts/schema/handler/query/test，再接 UI；不要用 localStorage 假装成功。

## 变更日志

- 2026-08-29：完成生产化分析；确认 prototype 构建正常但运行时全为 mock；建立本交接文件。
- 2026-08-29：新增 `features/tech/types.ts`、`api.ts`、`lib/realtime.ts`、`lib/useTechRealtime.ts`；今日工作接入真实服务端；删除生产界面的模拟与无契约交互；补角色门禁、权限按钮、错误/加载态、离线/实时状态及音频解锁。`@gf/web` typecheck 通过，本地路由返回 HTTP 200。
- 2026-08-29：业绩页改为真实今日收入与完成明细；个人页接真实个人资料与已发布排班；声音/常亮改为明确的设备本地偏好；删除 502 行 tech mock 数据和假加项弹窗。
- 2026-08-29：补 PWA 图标、Service Worker 和生产注册；API/写操作明确排除于 Cache Storage；恢复页面缩放。
- 2026-08-29：新增技师任务卡选择/计时、业绩组件、PWA 边界测试。Web 16 个测试文件、79 项通过；API `staff.test.ts` 21 项通过；生产构建通过；全仓 guard 与 11 个 workspace typecheck 均通过。
- 2026-08-29：新增 `staff.recordDirectCashTip`。只有被分配的技师可在项目完成后记录本人直收现金；修改走冲销旧 earnings + 新增 earnings，金额不进入前台钱箱和 `cashTipOwedCents`，命令需幂等键且金额从审计载荷脱敏。
- 2026-08-29：`/v1/staff/me/today` 的每个项目新增 `tip` 投影（待收银/无小费/本人已收/待结付/已结清）及可编辑边界；技师端完成项目列表展示状态并提供直收现金编辑。
- 2026-08-29：新增 `service_skill_requirements`（迁移 `0068`，强制 RLS、租户策略、FK/查询索引）；日快照下发员工等级、技能和项目 `staffCount`/必需技能。
- 2026-08-29：`ticket.open` 兼容旧单技师字段并新增 `staffAssignments[]`；服务端强制技师人数、唯一主理、技能资格、在职/可接单及并发容量。Queue 派工按项目展示候选，可处理多项目及单项目多技师。
- 2026-08-29：技师端 presence payload 标注 `client=tech`；前台只读订阅同一租户私有频道并在候选卡显示手机在线。在线是排序/可达性信号，不取代打卡、轮牌、技能和并发判定。
- 2026-08-29：多项目入座只启动第一项，后续已指派项目保持 waiting，由对应技师在前一项完成后启动，避免原实现把全部项目同时计时。
- 2026-08-29：前台“完成服务”只完成已开始的当前项目；有后续项目时订单保持服务中，最后一项完成后才进入待收银，消除顺序项目被批量提前完成的风险。
- 2026-08-29：个人资料技能更新同步规范化 `skills` / `staff_skills`，技师端只读档案与派工资格共用同一技能事实源；旧数组仅在技能集合完全一致时保留显示顺序。
- 2026-08-29：真实浏览器完成前台候选弹窗、技师只读档案及双标签 presence 验收；在线技师会即时去掉“手机在线离线”，但仍不会越过未到岗等硬门槛。

## 阶段 6 关键设计口径

- “客人直接把现金交给技师”与“前台钱箱收现金后再发给技师”是两条不同资金流。前者记 `earnings.kind=tip_cash` 且 `basis.method=direct_cash`，计入个人小费收入但从待发现金中扣除；后者仍由 checkout + day close + `tip_payouts` 管理。
- 小费状态是服务端投影，不允许前端根据按钮点击猜测。`tip_payouts` 当前按“营业日 + 技师”聚合，因此普通现金小费的“已结清”是当天该技师 payout 已足额且 acknowledged；不是伪造的逐项目发放凭证。
- Presence 只表示技师手机当前连接，不表示已到岗。派工硬门槛按技能、轮牌/在岗、休息、正在服务和 `maxConcurrentAppointments`；手机离线的合资格在岗技师仍可由前台判断后安排。
- 服务技能要求为空时保持兼容（不设硬门槛）；配置要求后，前端筛选和 `ticket.open` 服务端均校验，不能绕过 UI 派给无技能人员。
- 一项多技师在 `ticket_item_staff` 中一主多辅；`service.staff_count` 必须与提交人数相等。多人共享该项目的开始/完成时间，收入/小费继续按既有 `ticket_item_staff` 分配策略计算。

## 最终验证结果

- `bash scripts/lint-guards.sh`：通过。
- `turbo run typecheck`：11/11 workspace 通过。
- `pnpm --filter @gf/web test`：16 个文件、79 项通过。
- `pnpm --filter @gf/api exec vitest run src/staff.test.ts`（最终）：23 项通过（新增一项服务一主一辅、人数不足拒绝及持久化验证）。
- `pnpm --filter @gf/web test`（阶段 6）：17 个文件、81 项通过（新增派工候选硬门槛与在线软排序测试）。
- `pnpm --filter @gf/api exec vitest run --reporter=dot`：38 个文件、641 项全部通过。
- `pnpm --filter @gf/web build`：通过。
- `git diff --check`：通过。
- `pnpm verify`：前述 guard/typecheck/数据库及共享包测试通过，随后被 `apps/ipad/src/utils/phone.test.ts` 的 2 个既存期望差异阻断：显式 `+1` 与国际 `+84` 输入的格式化结果不符合旧测试。技师端未改 `apps/ipad`，接手者不要把该问题误判为本轮回归。

## 后续建议

现有契约范围内的技师端生产化已完成。下一轮若继续扩展，应按“已知后端契约缺口”先补服务端，再恢复对应 UI；优先级建议为本人周/月收入查询、正式加项目录/命令、休息或拒单审批，最后才是期望工时与换班流程。

补充边界：本轮多技师支持覆盖预约/候客入座时的正式服务项目；服务中临时 `ticket.addItem` 仍沿用单技师契约。若要让“临时加项”也支持多人协作，应先扩展该命令的 `staffAssignments[]`、相同技能/人数校验和前台加项选择器，不能只改 UI。
