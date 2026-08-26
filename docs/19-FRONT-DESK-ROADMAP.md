# 19 · 前台端拆分路线（对标 kuee）

> 把 `apps/front-desk-web` 拆成一串**一次坐下能做完**的小项目，一个一个来。
> 基准线是 kuee（`kuee-screen-shot/`，2026-08-24 抓的 77 张，本文看了其中 20 张，
> 跳过了重复页和官网营销页 —— 所以下面凡是写「kuee 没有」的，
> 准确说法是**这 20 张里没看到**，不是确证它没做）。

---

## 1. kuee 是什么形状

`kuee.io` 自我定位是 "AI-native studio platform"，做 spa / massage / wellness。
侧栏只有 **10 项**，比我们现在的 20 项克制得多：

| 分组 | 页面 |
|---|---|
| — | Home |
| Operations | Appointment、Customer、Order Management |
| Management | Dashboard、Marketing Assistant、Staff Performance |
| Settings | System Settings、About This Store、My Profile |
| — | Kuee Market（付费插件市场） |

**它把我们摊平在侧栏的东西折进了二级页**：房间、通信日志、AI 电话、支付、
健康表、服务项目、员工 —— 全在 System Settings 里，那一页自己有 11 个子项。
订单和结算合成一个 Order Management 的两个 tab。

### 各块的深度（这才是差距所在）

| kuee 的块 | 里面有什么 |
|---|---|
| **Appointment** | Day/Week/Month；模式 tab `Schedule(n) / Check In(n) / Operation(n)` 带计数；**按手机后四位或姓名搜**；`+ Book` / `Walk-in` / `Quick charge` 三个快捷按钮；右侧当日小计竖条 |
| **开单弹窗** | 一单**多服务**，每个服务**单独指派技师**（可留「未指派」），服务按分类搜索，时长金额自动汇总 |
| **预约抽屉** | 生命周期步进条 `Scheduled → Confirmed → Checked In → In Service → Completed` 带时间戳；标签 `Notes & Prefs / Progress / Billing / Benefits / Intake Form`；底部主 CTA 随状态变（`Check In & Start`） |
| **Customer** | `All Customers / New Today / Intake Forms`；批量自动关联；Intake Forms 是付费解锁 |
| **Order Management** | `Orders`（KPI 带迷你趋势线、按订单号/姓名/电话搜、筛选、导出）+ `Payouts`（Card volume / Stripe fees / Paid to bank / In transit、Sync now、Export statement、**「Revenue $X — why only $Y landed?」可展开解释**） |
| **Dashboard** | 顶部 **开店清单 6/13，分三组（基础操作 / 进阶功能 / 品牌），带百分比和「去设置」**；KPI 全部带「vs 上期」；有 **No-show Rate** 和 **Unredeemed Packages（递延收入）**；营收趋势带「服务人次 / 平均时长 / 总工时」；预约密度热力图（星期 × 小时） |
| **Marketing Assistant** | `Service Card / Points / Gift Cards / Coupons` 四个 tab **每个都是真功能**：积分有规则表+新建规则+趋势图+使用率分析+到期提醒；优惠券有 campaign 列表+自动发券规则+**AI 建议卡**（「90 天没来的客人发 -$15 召回券，预计拉回 40+ 人 → 让 AI 发」） |
| **Staff Performance** | **付费解锁**，免费版看不到 |
| **System Settings** | 门店设置 / 系统配置（记账方式现金制·权责制、技师非营业时间权限、顾客在线预约权限、自动确认、**在线预约闸门**）/ 健康表 / 支付设置（账户·POS 终端·交易流水·高级）/ 服务项目 / 房间设置 / 员工管理（角色·PIN·服务分配·提成）/ 通知设置 / AI 电话（号码池、开场白带 `{{store_name}}` 变量和预览、转接号、本月用量）/ 通信日志 |
| **Kuee AI Hub** | **全屏**工作台，不是抽屉：左侧会话历史、老板/前台视角切换、今日简报卡（AI 电话、今日预约、周报）、快捷提问 chips（本月营收 / 谁要流失 / 技师表现 / 发起活动）、「今天的决策都清了」空态 |
| **开店引导** | `/onboarding/store-setup` 两步向导，右侧**实时预览**顾客看到的门店页 |
| **顾客互动屏** | `/webrtc-server` 生成会话 → 扫码配对 iPad → 顾客侧自助签到/评价 |

---

## 2. 我们现在在哪

**页面数量上我们不落后，反而更多（20 vs 10）。差的是深度，不是广度。**

| | 我们 | kuee | 判断 |
|---|---|---|---|
| 日程/日历 | 日·周·月、技师分列、拖拽改期、冲突拦截 | 同左 + 后四位搜索 + Walk-in + Quick charge | **持平，差三个快捷路径** |
| 开单弹窗 | 单服务、单技师 | 多服务、每服务指派 | **落后** |
| 预约抽屉 | 状态点 + 四个标签 | 步进条带时间戳 + 状态化 CTA + Benefits/Intake | **落后** |
| 排队看板 | 四列可推进 | Check In / Operation 模式 tab | 持平（形式不同） |
| 收银 | 拆分收款、小费可改 | Quick charge | 持平 |
| 订单 | 表格 + 退款/作废 | + KPI 趋势线 + 导出 | 略落后 |
| 结算 | KPI + 批次表 | + Sync now + 「钱去哪了」解释 | 略落后 |
| 客户 | 列表 + 详情抽屉 + SOAP | + New Today + 批量关联 | 略落后 |
| 仪表盘 | KPI + 图表 | **+ 开店清单 + vs 上期 + 递延收入** | **落后** |
| 营销 | 四个 tab，**三个是占位** | 四个都是真功能 + AI 建议卡 | **明显落后** |
| 设置 | 4 个 tab | 11 个子项的 hub | **明显落后** |
| AI 副驾 | 侧边抽屉 | 全屏工作台 + 历史 + 简报 | **落后** |
| 开店引导 | 占位页 | 两步向导 + 实时预览 | **落后** |
| 员工绩效 | 有 | **付费才有** | **领先** |
| 健康表 | 后端有 | **付费才有** | **领先** |
| **技师轮牌** | 有（严格轮转账本） | 没看到 | **领先** |
| **打烊日结 Z 表** | 有（钱箱对账、多退少补） | 只有 payouts | **领先** |
| **微店建站** | 有 | 没看到 | **领先** |
| 硬件配对 | 有 | 有 | 持平 |

> 轮牌和日结是**给亚裔按摩/美甲店做的**，kuee 那套通用 spa 模板里没有。
> 这两块别在追平的过程中弄丢了 —— 它们是我们能赢的地方。

---

## 3. 拆成 14 个小项目

每个都能独立验收、独立上线。**阶段 0 是地基，不做完后面全是在假数据上打转。**

### 阶段 0 · 接上真数据（5 个）

| # | 项目 | 范围 | 做完了 = |
|---|---|---|---|
| **P1** | 登录 · 选店 · 断网 | Supabase 真登录；`/v1/me/locations` 一家直进多家出选择器；membership 进 context，所有请求带 `X-Membership-Id`；断网横幅 + 写操作置灰（`lib/offline.ts` 已就绪） | 真账号能进；切店后侧栏门店名跟着变；拔网线后横幅出现且不白屏 |
| **P2** | 日程接真数据 | `/v1/desk/day`；`appointment.create/update/cancel` 走 `runCommand`；**冲突改由后端 409 驱动**，删掉前端那套本地判断 | 新建的预约刷新后还在；后端拒绝的冲突前端能正确显示 |
| **P3** | 排队签到接真数据 | `/v1/desk/queue`；`appointment.checkIn/start/finish`；看板推进 = 真命令 | 签到后日程页状态跟着变 |
| **P4** | 收银接真数据 | `ticket.*` 命令；幂等键（`api.ts` 已有）；退款/作废接真 | 结完账订单页查得到，日结数字对得上 |
| **P5** | 客户接真数据 | `/v1/desk/customers`、`/v1/desk/customers/:id`、`/v1/customers/search` | 搜得到，详情页是真的到店记录 |

### 阶段 1 · 追平 kuee（7 个）

| # | 项目 | 对标 | 做完了 = |
|---|---|---|---|
| **P6** | 前台快捷路径 | kuee 日程页工具栏 | **手机后四位搜人**、Walk-in 一键落单、Quick charge 快速收款、右侧当日小计条。判据：一个到店散客，**不开任何弹窗 30 秒内开完单** |
| **P7** | 开单弹窗升级 | kuee 多服务开单 | 一单多服务、每服务单独指派技师、服务分类搜索、时长金额自动汇总。判据：一单点 3 个服务分给 2 个技师，日程上正确渲染 |
| **P8** | 预约抽屉补全 | kuee 预约详情 | 生命周期步进条带时间戳、CTA 随状态变、补 Benefits（套餐/积分抵扣）和 Intake Form 两个标签。判据：从抽屉里能把预约从「已约」一路推到「完成」 |
| **P9** | 设置中心重构 | kuee System Settings | 4 tab → 分组 hub；把 Rooms / CommunicationLogs / Calls / HardwareServer 收进去；服务项目、房间、员工（角色·PIN·提成）做成真 CRUD。判据：**侧栏从 20 项降到 10 项左右且没丢功能** |
| **P10** | 营销中心做实 | kuee Marketing Assistant | 积分规则引擎、礼品卡发行核销、优惠券 campaign + 自动发券规则。判据：三个 tab 不再是占位卡 |
| **P11** | 开店清单 | kuee Dashboard 顶部 | 分组清单（基础/进阶/品牌）+ 百分比 + 「去设置」直达 + 可关闭且记住。判据：新店登录第一屏就知道下一步干什么 |
| **P12** | AI Hub | kuee AI Hub | 抽屉 → 全屏工作台：会话历史、快捷提问、今日简报卡、老板/前台视角。判据：问「这个月营收」能拿到**真数字** |

### 阶段 2 · 守住领先（2 个）

| # | 项目 | 做完了 = |
|---|---|---|
| **P13** | 轮牌板接真数据 | `/v1/desk/rotation` + `rotation.skip`；跳过原因写进审计 |
| **P14** | 日结 Z 表接真数据 | `/v1/desk/dayclose`；钱箱实点金额回写；日结后当天锁定 |

---

## 4. 建议顺序

```
P1 ──> P2 ──> P3 ──> P4 ──> P5        阶段 0，必须按顺序（后面依赖前面的身份和数据）
        │      │      │
        └──────┴──────┴──> P6 P7 P8   日程/排队/收银通了之后随时可插
                       
P9 ──> P10                            设置先重构，营销才有地方放规则
P11                                   任何时候都能做，越早做越有用（新店第一印象）
P12                                   放最后：它要问的数字得先有
P13 P14                               和 P2~P4 并行也行，它们互不依赖
```

**如果只做三件事**：`P1`（没它什么都是假的）→ `P6`（前台每天省下来的时间最多）→ `P9`（侧栏 20 项是现在最劝退的地方）。

---

## 5. 两个提醒

**别照着 kuee 抄导航。** 它 10 项是因为它把复杂度藏进了 System Settings，
不是因为它功能少。我们 P9 要做的是同一件事：**把配置类页面收起来，
把前台每天点的 5 个页面留在外面**。

**AI 建议卡这个模式值得抄。** kuee 在优惠券页里直接放
「90 天没来的客人发召回券 → 预计拉回 40+ 人 → 让 AI 发」，
AI 提方案、人点确认。这比我们现在「有一个 Copilot 抽屉，你自己去问它」
主动得多，而且后端的命令总线本来就是为这个设计的（提案不执行，
前台点确认时用她自己的身份走 `/v1/commands/:name`）。

---

## 当前状态

- 前端 UI：20 页全部完成，交互跑通（本地 state），i18n 523 key × 5 语言，零报错
- 数据层：`lib/api.ts` + QueryClient 已就位，**尚未接进页面** ← P1 从这里开始
- 后端：`/v1/desk/*` 查询 + `/v1/commands/:name` 命令总线都在，见 [18-API-REFERENCE.md](18-API-REFERENCE.md)
