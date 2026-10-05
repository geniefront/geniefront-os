# 前台 Web 全页手测记录（只记录，不改代码）

> **2026-09-27 账号清理更新：** 当前环境账号和 seed 命令以[环境账号清单](TEST_ACCOUNTS.md)为准。下文旧账号、演示店及旧密码仅适用于历史记录或隔离测试 fixture，不能作为现行 local/staging/prod 登录配置；原 `ops` 管理员保留。


日期：2026-09-05  
账号：`owner@maildrop.cc` / `GenieDev!2026`（老板 · 金足足疗 / Golden Foot Spa · `America/Los_Angeles`）  
环境：本机 `http://localhost:5177` + API `:3000` + 本地 Supabase Kong `:55321`  
工具：Chrome DevTools MCP（`browser-use` MCP 未连上，已改用 Chrome DevTools）  
视口：1280×800；另抽 390×844  
语言：`zh-Hans` 走完全部侧栏；`en` / `ko` 抽测仪表盘；`es` / `vi` 只确认语言菜单存在  

**本轮不改代码。** 发现写在这里。

---

## 怎么测的 / 覆盖到哪

已登录并点过的路由：

`/` 登录 → `/dashboard` → `/schedule`（含预约抽屉四级 tab、新建预约弹窗、创建一单）→ `/queue`（签到弹窗 → 入座开工弹窗）→ `/checkout` → `/tickets` → `/customers`（含新建顾客弹窗）→ `/marketing`（5 个 tab）→ `/rotation` → `/rooms` → `/employee-performance` → `/business-data` → `/day-close` → `/payouts` → `/calls` → `/messages` → `/communication-logs` → `/storefront-builder` → `/health-forms` → `/settings`（13 个 tab）→ `/support` → `/profile`（基本/安全/通知）→ `/notifications` → ⌘K 命令面板 → AI 副驾抽屉。

本轮**没有**做完的（避免误标成「没 bug」）：

- 收银实收、作废、退款、日结封账确认
- 前台号 `mia@maildrop.cc`、技师 `/tech`、开店向导 `/setup`
- `apps/booking`、`apps/ipad`、营销站、平台后台
- 西语/越南语整页走读
- 日程周/月视图、客户合并/拉黑、礼品卡发售确认、轮牌规则弹窗
- Google 登录走完 OAuth

演示预约多在 2026-08-25～28。今天 09-05 默认空日历。已用 08-26 历史单 + 现场新建 `QA Test Guest` 09-05 16:30 验证。

---

## 严重度一览

| 级 | 条数 | 含义 |
|---|---:|---|
| P1 | 21 | 假数据/假合规、状态对不上、钱或房间丢了、i18n 词条泄漏、预约 503、快捷键误触 |
| P2 | 30 | 截断重叠、中英混排、创建后不跳日期、布局挤爆、公开页粘连 |
| 环境 | 3 | 本地 Auth 没起、Anthropic key、登录 Failed to fetch |

P1 建议先修。P2 是「店员每天会骂」的一类。

---

## P1

### 1. 签到填的禁忌和备注，下一屏消失（假实装）

- **页：** `/queue` 签到弹窗 → 入座开工弹窗
- **步骤：** 给 `QA Test Guest` 点「精油过敏」，备注 `QA check-in note: light pressure, warm tea`，确认到店；再点「安排工位并入座」。
- **期望：** 开工弹窗的「技师服务前重要提示」带出过敏和备注。
- **实际：** 提示框是空的。弹窗还写「✓ 顾客已完成电子健康问卷与知情同意书签署」「系统已核验无严重身体禁忌」。健康表 tab 明明是「尚未提交健康表」，且刚标了精油过敏。
- **依据：** 手测手册写过：Queue 弹窗字段填了必须在下一屏或后端看见，填了消失按 P0/P1。

### 2. 有电话仍标「散客无电话」

- **页：** 签到弹窗头
- **实际：** 姓名是 `QA Test Guest ((626) 555-0199)`，旁边徽章「散客无电话」。电话被拼进姓名，系统当没电话。

### 3. 预约抽屉把未完成单画成快完工

- **页：** `/schedule` 点 08-26 王明卡片
- **实际：** 日历上仍是预约卡，抽屉步进器「已预约 / 已到店 / 服务中」全打勾，当前步是数字 **4 / 已完工**。

### 4. 收银页丢掉刚分配的房间

- **页：** `/checkout` → 「服务中 (1)」
- **实际：** 工单写「未分配房间或工位」。`/rooms` 上 VIP 包厢 1 明确占用着同一客人。开工时选了 VIP 包厢 1。

### 5. 轮牌仍显示阿博空闲

- **页：** `/rotation`（开工之后）
- **实际：** 阿博已入座服务中，轮牌仍是「空闲待派 · 今日已做: 0 单 · 待打卡」。

### 6. 房间占用计时 182m（刚开工）

- **页：** `/rooms` VIP 包厢 1
- **实际：** 刚确认入座，计时显示 `182m`。约等于 3 小时，像用错时区（店是 LA）。

### 7. 优惠券金额 `-$NaN.NaN`

- **页：** `/marketing` → 优惠券
- **实际：** 券 `SPA20` / 「养生理疗立减 $20」金额渲染成 `-$NaN.NaN`。

### 8. 设置里整页 `⟦email.*⟧` / `⟦reviews.*⟧`

- **页：** `/settings?tab=notifications`、`/settings?tab=reviews`
- **实际：** 顾客通知页是 `⟦email.title⟧` `⟦email.intro⟧` …；口碑页是 `⟦reviews.title⟧` `⟦reviews.desc⟧` …。
- **线索：** `LanguageContext` 合并了 settings/crm 等，但 `i18n/email.ts`、`i18n/reviews.ts` 没并进去。

### 9. 控制台缺词条 `crm.custNotesLabel`

- **页：** 打开预约抽屉客户偏好 tab
- **实际：** `[i18n] 缺少文案词条：crm.custNotesLabel` 重复十几次。

### 10. 订单列表服务名变成代码

- **页：** `/tickets`
- **实际：** 历史行项目显示 `reflex60` / `swedish60` / `deep90` / `deep60`，不是中文项目名。时长一律 `(60m)`。列名 `TOTAL COLLECTED`。Tab：`Voided` `Refunded`。

### 11. 待收银单却显示「信用卡 (*4242)」

- **页：** `/tickets` 今日 `QA Test Guest` 行
- **实际：** 状态「待收银」，支付方式已是「信用卡 (*4242)」，小费 `No Tip`。

### 12. 通知中心 3 条未读、列表是空的

- **页：** `/notifications`
- **实际：** 顶栏「3 条未读 / 共 5 条历史」，分类徽章也有数字；主列表「暂无符合条件的通知消息」「所有未读事项均已处理完毕」。`GET /v1/desk/notifications` 和 `/stats` 都 200。点「全部通知」、取消「仅看未读」仍空。

### 13. AI 电话页 0 通来电却有漂亮转化率

- **页：** `/calls`
- **实际：** 「近 7 天进线总量 0 通」，同时「接通率 99.8% · 零漏接」「AI 自动成单数 14 单」「成单转化率 68.4%」「节省前台工时 28.5 小时/周」。仪表盘也写「Telnyx 语音引擎运转中」。

### 14. 经营数据把老客算成新客

- **页：** `/business-data`
- **实际：** 「总客流 42 · 新客 42 · 老客 0 · 复购 0%」。CRM 里王明/陈伟等到店 4～8 次。热力图工作日几乎同一组 0/0/0/67/67/67。

---

## P2

### 登录与壳

1. **登录页没有语言开关。** `AuthLayout` 只有 logo，地球仪要登录后才有。手册要求登录页中/英/韩都走。
2. **创建预约成功但不跳日期、无 toast。** `POST /v1/commands/appointment.create` 201，日历停在 08-26，点「今天」才看到 09-05 的 `QA Test Guest`。店员会以为没存上。
3. **仪表盘 0 单履约率 100%。**
4. **副驾 FAB 挡住「全部通知 →」。**
5. **同一店打烊时间两套：** 08-26 显示 23:00，09-05 显示 01:00。

### 日程

6. **工具栏挤爆（1280 宽）：** 「按技师分列」截成「技师分」；搜索框截断；日/周/月竖排成两字。
7. **「10:00 开门营业」胶囊压在 10:00 预约卡上**，陈伟显示「陈伟 (L」。
8. **抽屉头像「王(」**，英文括号把字切了。
9. **客户偏好 tab 泄漏内部字段名：** `顾客姓名 (NAME) *`、`PHONE E.164`、`BIRTHDAY, YYYY-MM-DD`、按钮「保存客户偏好变更 (确认)」。新建顾客弹窗同一套。
10. **新建预约标题把副标题拼进 h2：** 「新建预约 支持单单多项、双技师并行或顺次接力派单」。`Duration(分)`。Close/Dismiss 英文。
11. **卡片标题** `QA Test Guest ((626) 555-0199)`，电话进了姓名。

### 看板 / 收银 / 其它页

12. **运营看板 1280 仍挤：** 标题「运营看/板」换行；列「待收银 / Open · Unpaid」中英混排并截断；「已等候 0m」「60m」。
13. **收银默认停在「已完工 (0)」**，服务中那张要再点 tab。按钮文案字面量 `查看全部未结单据 &gt;`（HTML 实体没解码）。结账区大量英文：`Smart Tip Split` `Enter by Staff` `Custom Total Tip ($)` `Equal Split` `Total Tips`。
14. **员工中心挂「示例数据」横幅**，但人是真的阿博/华师傅；技能是美甲美睫英文（Japanese Gel Nail Art…），「可接服务 0 项」。职位筛选项「Lashes & Brows师」「Hair Styling师」。
15. **营销：** 次卡「有效期 永久 天」；礼品卡状态 `ACTIVE`；VIP `5% OFF` / `Tier Spend`；自动化剧本正文全英文。
16. **轮牌按钮「Pass Turn」** 和中文「跳过顺延」并存。
17. **房间状态「In Service」「Cleaning」** 英文混排。
18. **经营分析 `&lt;40%` 未解码**；「Gift Card」；「AI 智能经营诊断 Smart」。沟通日志在 0 次触达时仍写「仅 7.6% 需转人工」。支持页空提交无校验提示。

---

## P3

1. 登录密码框无障碍名 = 「密码 忘记密码？」（忘记密码嵌在 label 里）。
2. 日期控件 `Month Month` / `Day Day` / `Year Year` / `Show date picker`。
3. 日程上一/下一日按钮无名字。
4. 抽屉时长 `60 m`。
5. 搜索框 ⌘K 截图像 `%K`（源码是 `⌘K`，字体/glyph）。
6. 中文/韩语仪表盘仍有 `description="Completed: 0"`。
7. 副驾标题 `GenieFront Copilot`、输入框「问 Copilot」。快捷指令「房间3设为清洁」与本店「VIP 包厢」对不上。
8. 失败的副驾请求仍计 `1/10 轮`（本机 `ANTHROPIC_API_KEY 未配置`，属环境，但计数是产品问题）。
9. 健康表题型 `Single choice` / `Yes / No` / `Text`（顾客表单规定英语，后台编辑器也全英文）。
10. 设置服务卡 `Duration: 60 分钟 &bull;`、员工 `电话: — &bull;` 实体未解码。

---

## 分页面走读（通过 / 问题）

| 页面 | 结果 | 备注 |
|---|---|---|
| 登录 | 空提交通过；无语言器 | Auth 未起时 Failed to fetch（环境） |
| 仪表盘 | 能用 | 履约率、FAB、Telnyx 文案 |
| 语言 en/ko | 导航已译 | 店名/房间/技师保持业务数据中文 |
| 日程 | 能建单、能打开抽屉 | 截断、步进器、缺词条、创建后不跳日 |
| 运营看板 | 签到/开工命令 201 | 禁忌丢失、假健康签署、无电话徽章、布局 |
| 收银 | 能看到服务中单 | 房间丢失、默认 tab、英文结账文案、`&gt;` |
| 订单 | 有列表 | 服务代码、待收银却有卡号、英文列 |
| 客户 | 能开新建弹窗 | 字段名泄漏；`QA Test Guest` 未进 8 人名单 |
| 营销 | 5 tab 能切 | NaN 券、英文 VIP/剧本 |
| 轮牌 | 能看 3 人 | 在岗不同步、Pass Turn |
| 房间 | 占用正确 | 182m 计时、In Service 英文 |
| 员工 | 有人 | 示例数据横幅 + 错技能 |
| 经营数据 | 有图 | 新客 42/老客 0、`&lt;` |
| 日结 | 能打开，1 单未结 | 中英混排多 |
| 资金结算 | 干净 | 估算表可用 |
| AI 电话 | 0 通 | 假转化率、Phone Simulator |
| 消息 | 10DLC 门禁正确 | 空会话 |
| 沟通日志 | 空态 | 残留 7.6% 文案 |
| 微店 | 表单在 | 英文标签；流水线「Alex M. 已接单」像示例 |
| 健康表 | 编辑器在 | 顾客英语是产品决定 |
| 设置 13 tab | 都能点开 | **通知/口碑词条泄漏**；预约短链是 `http://127.0.0.1:5177/golden-foot` |
| 支持 | 表单在 | 空提交无提示 |
| 资料 | tab 能切 | IN-APP 英文 |
| 通知中心 | 计数与列表打架 | 见 P1-12 |
| ⌘K | 打开，6 条中文命令 | 通过 |
| 副驾 | 抽屉打开 | 无 Anthropic key 时中文报错（环境） |
| 390 宽 | 副驾变全屏 | 未系统测所有页窄屏 |

---

## 环境（不要当产品票）

1. 开始时本地 Supabase 只剩 Postgres，Kong/Auth 停着。Web 走 `.env.local` 的 `127.0.0.1:55321`，登录 `net::ERR_CONNECTION_REFUSED` / 「Failed to fetch」。`docker start` 相关容器后恢复。
2. `pnpm --filter @gf/api dev` 读的是仓库根 `.env`（staging），Web 读 `.env.local`。要对齐必须 `pnpm dev:api:local`。
3. 副驾：`ANTHROPIC_API_KEY 未配置，前台副驾不可用`。

---

## 建议修的顺序

1. 设置通知/口碑 i18n 词条泄漏（整页不可用）
2. Queue 签到字段同步到开工/技师须知；去掉假「已签健康表 / 无禁忌」
3. 房间分配在收银/工单上的投影；轮牌在岗状态
4. 优惠券 NaN
5. 通知列表 vs 计数
6. 电话号码不要写进姓名，徽章不要说「无电话」
7. 日程/看板 1280 工具栏和五列看板截断
8. 订单服务快照名、待收银支付方式
9. 把 `crm.custNotesLabel`、登录页语言器、HTML 实体 `&gt;` `&bull;` `&lt;` 清掉
10. 托管预约 `POST /public/v1/bookings` 503
11. 仪表盘把 16:30 的单画到 23:30（UTC）；已结单不算「已完」、客单 $0
12. 技师端 `⟦mins⟧` / `spa_pedi`
13. 输入框里按 `q` 会跳到运营看板

---

# 第二轮补测（同日，继续「全部页面」）

账号续测：老板把 `QA Test Guest` **完工 + 刷卡记账 $51.75（含 15% 小费）**；随后 `amy@maildrop.cc`（莲花美甲 · 技师/店长）走 `/tech`；`mia@maildrop.cc`（前台）西语/越南语走仪表盘和 settings 门禁。  
另起：`apps/booking :5176`、`apps/marketing :5180`、`apps/ipad :5178`。仍不改代码。

## 本轮新覆盖

- 日程周视图、月视图
- 完工核算弹窗、队列收银弹窗、刷卡记账成功
- 订单退款弹窗、导出弹窗（未确认退款）
- 客户搜索、短信弹窗、偏好弹窗、合并弹窗、黑名单弹窗
- 营销「新建次卡」弹窗；轮牌规则/日志
- 资料「门店与权限」「技师接单」
- 技师 `/tech/today|summary|profile`（含西语）
- 前台 `mia`：侧栏无设置；`/settings?tab=billing` 权限安全态（西语/越南语）
- 托管预约四步 + 提交；预约管理页无 token
- 营销站首页/定价/条款/隐私/checkout cancel
- iPad 配对页、语言菜单、未配对进 `/check-in` 被拉回
- 公开健康表 `/forms/demo`、退订 `/unsubscribe`
- 登录页随 localStorage 语言变化（西语）

## 新增 P1

### 15. 仪表盘用 UTC 画预约，已结单不算履约

- **页：** 老板 `/dashboard`（结账后）
- **实际：** 16:30 的 `QA Test Guest` 出现在 **23:30–00:30**（16:30 PDT = 23:30 UTC）。KPI「已完: 0 / 待到店: 0 / 服务中: 0」，履约率 0%，客单 **$0.00**，净额却是 $45.00、小费 $6.75。房间显示 VIP 包厢 1「待打扫」（这块对）。

### 16. 队列收银 0 税，独立收银页 8.875% NY 税

- **页：** 队列「结算收银出票」vs `/checkout`
- **实际：** 同一张 $45 单，队列弹窗销售税 **$0.00**、实收 $51.75（15% 小费）；`/checkout` 先前对服务中单算 **+$3.99（8.8750%）**。金足店时区是洛杉矶。日结页仍写 `NY Sales Tax 8.875%`。

### 17. 全额退款默认 $45，实收是 $51.75

- **页：** `/tickets` → 退款 · ORD-609FA
- **实际：** 头「Total Collected: $51.75」，「全额全单退款」金额 **$45.00**，小费要另勾「同时退还剩余小费 $6.75」。支付方式显示「多渠道结算」（当时只记了刷卡）。

### 18. 现场建的客人进不了 CRM

- **页：** `/customers` 搜 `QA Test`
- **实际：** 名录 (0)「没有匹配的客户档案」。此人已预约、签到、开工、结账。

### 19. 输入框里按 `q` 跳走

- **页：** 客户名录搜索框用键盘输入 `QA Test`
- **实际：** 一打 `Q` 就进 `/queue`（快捷键 `q`）。手册要求输入框内不触发。

### 20. 托管预约提交 503

- **页：** `http://localhost:5176/golden-foot` 四步填完 Name/Phone/Email，点 Book
- **实际：** `POST /public/v1/bookings` **503**，文案 “We could not complete this booking. Please try again.” Add-ons 分类点开是空的（火山热石/拔罐没出现）。

### 21. 技师端缺词条 + 服务代码

- **页：** `/tech/today`（Amy · 莲花美甲）
- **实际：** 派工卡 `spa_pedi`、时长 `0 ⟦mins⟧`。西语界面同样泄漏 `⟦mins⟧`。轮牌文案「当前轮牌位次第 - 位」。

## 新增 P2

1. **完工弹窗「工位: 未指定包厢」**，同时房间页 VIP 包厢 1 占用；执行工时 12 分钟 vs 预估 60。
2. **看板「今日已结营收」$45**，实收 $51.75；完成卡写「已完工 (17:30)」是预约结束点，不是实际完工时刻。
3. **月视图** 1–19 日几乎都有「2项 3人当班」，周视图那些天「暂无预约」——「项」像班次不是预约，店员会混。
4. **客户短信弹窗** `Send SMS` / `SMS BODY`；合并列表 `James Wilson(323)` 没空格；黑名单 `BLOCK REASON` / `No-show`；历史单据状态 `closed`。
5. **新建次卡弹窗** `PACKAGE NAME` / `PRICE` / `UNITS` / `VALID DAYS`。
6. **轮牌规则** 标题 `(Rotation Policy)`、`Carry Over`；今日已派工但日志「暂无日志记录」。
7. **资料权限 tab** 直接列出 `ai.execute_without_confirm` 等原始权限键。
8. **营销站** cancel 页 `Back to pricingSign in` 粘在一起。
9. **iPad** 空配对码点「完成门店绑定」无校验提示；未配对访问 `/check-in` 拉回 `/pair`（可接受）。
10. **退订无 token** 仍显示 “You are unsubscribed”（公开页，英文）。
11. **退出确认** 无障碍树把「取消」「确认退出」拼成一句。
12. **预约页** 今天下午最早 3:45 PM（店 10:00 开门；若因「现在 13:36」过滤上午，需确认 14:00–15:30 为何也没有）。

## 本轮通过 / 可用

| 面 | 结果 |
|---|---|
| 周视图 | 09-05 能看到 QA Test Guest |
| 完工 → 待收银 → 刷卡记账 | 命令成功，toast 有 $51.75 |
| 退款/导出弹窗能打开 | 未点确认退款 |
| 客户合并/黑名单/偏好弹窗 | 能开 |
| 前台 settings?tab=billing | 西语/越南语都是权限安全态，不是整页 Failed |
| 技师三页 + 西语 | 能切 Hoy/Resumen/Ajustes |
| 登录页随 gf.lang | 退出后西语登录页（仍无地球仪可改） |
| 预约缺店 /forms/demo | 有人话空态 |
| 营销定价 $99 / $199 | 在 |
| 条款/隐私 | 能打开 |
| signup/cancel | 有「Checkout canceled」 |
| 越南语侧栏 | 前台账号译文齐全 |

## 仍未点到的（不要当没 bug）

- 真 Stripe Checkout、真封账、真退款入账
- 礼品卡「发售」弹窗（次卡弹窗挡住了 tab，未再打开）
- 房间「新增工位」、日结零用金确认
- Google OAuth 走完
- 开店向导 `/setup`
- 平台后台 `apps/platform`
- iPad 配对成功后的签到/walk-in/健康表（没配对码）
- 预约管理页带真实 `#g/{token}`

---

# 第三轮（同日，冷启动后续）

账号：老板 `owner@maildrop.cc` · 金足 · `America/Los_Angeles`  
环境：`pnpm dev:api:local` + `@gf/web :5177` + `@gf/booking :5176` · Kong `:55321`  
本轮**改了代码，未 commit**。

## P1 回归（8 条）

| # | 结果 |
|---|---|
| 登录页语言器；输入框打 q 不跳 /queue | 通过（越语残留进登录页，地球仪可切中文；搜索框 `q` 仍停在仪表盘） |
| 设置 → 通知 / 口碑无 `⟦email.*⟧` / `⟦reviews.*⟧` | 通过 |
| 仪表盘 16:30 不画成 23:30；空日履约率 0% | 通过（现场建 `QA Guest Sep5` 16:30–17:30；空日 0%） |
| 日程新建客人 → CRM 能搜到；日历停在建单日；姓名不夹电话 | 通过 |
| 看板签到备注带到开工弹窗；没配健康表不写已签署 | 通过 |
| 订单中文服务名；待收银不伪造 *4242；全额退款默认含小费 | 通过（全额 $60 且「同时退还小费」默认勾上） |
| 电话页 0 通时 KPI 全是 0 | 通过 |
| 托管预约 `localhost:5176/golden-foot` 能提交 | 通过（确认码 `GO-TJZM`，无 503） |

回归中发现的尾巴：签到弹窗仍可能标「散客无电话」（预约日快照原先没带 `customerPhone`）。本轮已把电话打进 `GET /v1/desk/day`，09-01 快照已能看到 `+13235550402`。

## 本轮已改（浏览器走过）

- 金足缺收银设置时不再默认纽约 8.875%。种子 + 本机库写入：莲花 8.875%、金足 0。订单页文案变成「本店未开销售税」。
- `GET /v1/desk/day` 过夜打烊与 `/days` 对齐：09-05 `closeMin=1500`（不再是 60）。周六仍显示 01:00 打烊，周一显示 23:00，是按星期的真实营业时段。
- 看板「今日已结营收」口径改为日结净额 + 小费（今日无已结单，显示 $0.00）。
- 营销自动化剧本正文改中文；假发送数清零。
- 微店流水线「Alex M. 已接单」改为「示例：设计师待分配」。
- 月格点进去跳到该日日视图（9/1 月格「3 预约」→ 日视图 Grace / James / Kevin 三单）。
- 资料权限 tab 用人话词典（「AI 免确认执行」而不是 `ai.execute_without_confirm`）。
- 客户历史单据状态 `closed` → 「已结清」。

## 仍未点到 / 未改

- 真 Stripe Checkout、真封账、真退款入账
- 礼品卡发售确认、房间新增工位、日结零用金确认
- Google OAuth、`/setup`、`apps/platform`、iPad 配对后流程
- 预约管理页真实 `#g/{token}`
- 西语/越南语整页、技师 `/tech`
- 收银实收 / 作废 / 日结封账确认（本轮没点确认）

---

# 第四轮（同日，按建议顺序走真路径）

账号：老板 `owner@maildrop.cc` · 金足 · `America/Los_Angeles`  
环境：`pnpm dev:api:local` + `@gf/web :5177` · Kong `:55321`  
本轮**改了代码，未 commit**。

## 浏览器走过的真路径

现场建 `QA Clock Guest` / `(626) 555-0206` · 阿博 · 经络足道 $45 · 预约 19:00–20:00。

| 步 | 结果 |
|---|---|
| 签到弹窗头 | 徽章 `(626) 555-0206`，**没有**「散客无电话」 |
| VIP 包厢 1 开工 | 确认按钮带房间名；房间页计时 `0/60m`（不是 182m） |
| 完工弹窗 | `主理技师: 阿博 · 工位: VIP 包厢 1` |
| 含 15% 小费结账 | 实收 $51.75（刷卡记账） |
| 看板「今日已结营收」 | **$51.75**，不是服务价 $45 |
| 完工卡时刻 | **已完工 (15:47)**，不是预约结束点 20:00 |

（上一单 `QA Guest Round4` 被本轮 API 测试 `money.test.ts` 的日结复位挪走，所以用新单再走了一遍。）

## 本轮已改

- **完工时刻：** `GET /v1/desk/day` 带 `completedAt`（`ticket_items.finished_at`）。看板用门店时区墙上钟点，不再拿预约 `ends_at`。
- **服务端算税：** `ticket.close` / 组单结账按 `location_checkout_settings` 算税额，不信客户端 `taxCents`。金足 0、莲花 8.875%。收银台关掉开关也按门店税率。
- **月视图死代码弹窗** `expandedMonthDate` 已删。点 9/5 月格仍跳日视图，无弹窗。
- **1280 看板：** 「待收银 / Open · Unpaid」「今日已结 / Completed」改成中文短标题；去掉 `min-w-[1100px]`，五列能进 1280。
- **员工中心**标题是「员工中心」，无 `(Staff Directory)`。
- **微店流水线**未开始的步骤写「尚未开始」，不再假装 v1.1 评审中。
- 日程列头营收 `¥45` 改成 `$45`。

## 仍未点到

- 真 Stripe Checkout、真封账、真退款入账
- 礼品卡发售确认、房间新增工位、日结零用金确认
- Google OAuth、`/setup`、`apps/platform`、iPad 配对后流程
- 预约管理页真实 `#g/{token}`
- 西语/越南语整页、技师 `/tech`
- 收银实收 / 作废 / 日结封账确认

## P3 仍在（未改）

- 日期控件 Month Month / Show date picker；日程上一/下一日按钮无名字
- 中文仪表盘 `description="已完:: 0"`
- 副驾 Copilot、快捷指令「房间3」、失败仍计 1/10（本机无 Anthropic key）
- 健康表编辑器题型英文；设置服务卡 Duration 中英混排
- 退订无 token 公开页故意成功态

---

# 第五轮（同日，测未覆盖路径；真 Stripe 用户自己测）

账号：老板 `owner@maildrop.cc` · 金足 · `America/Los_Angeles`  
环境：`pnpm dev:api:local` + `@gf/web :5177` · Kong `:55321`  
本轮**只测、列 bug，中途暂停**。未 commit。  
暂停时：日结封账弹窗已点确认，`POST dayclose.finalize` **400**（还没点钞），日仍 Open。

## 本轮走过

| 面 | 结果 |
|---|---|
| 作废工单 | 通过。收银页作废服务中单 `Naiyou Zhu` / ORD-4B800，原因「客人改主意」，列表变已作废 |
| 真退款确认 | **失败 500**。`QA Clock Guest` ORD-F8E4A 全额 $51.75（含小费勾上），原路退回 |
| 礼品卡发售确认 | 通过。弹窗确认发售 $100，卡号 `5VFK-9BWA-5H79-WKV2-HN8B-2D`，储值池 $75→$175 |
| 新增工位 | 通过。新增「QA 工位 R5」，总工位 3→4 |
| 日结零用金确认 | 通过。耗材支出 $5.00 已入账 |
| 日结封账确认 | **失败 400**。点了「确认封账」，服务端拒：还没点钞 |

## 新发现（给下一任修 / 接着测）

### P1

1. **`ticket.refund` 500。**  
   `POST /v1/commands/ticket.refund` body：`ticketId=f8e4a647-…`（QA Clock Guest）、`refundAmountCents=5175`、`refundTipCents=675`、`refundMethod=original_payment`。  
   Postgres：`walkin_queue` 违反 `walkin_queue_left_reason`（`status='left'` 必须有 `left_reason`）。  
   代码：`apps/api/src/handlers/ticket.ts` 约 1231：全额退款把队列改成 `left` 却不写 `left_reason`。约束在 `packages/db/sql/0016_kiosk.sql`。  
   UI：弹窗不关，前台只看到 500 / INTERNAL，没有人话。

2. **作废工单不撤预约。**  
   收银作废 `Naiyou Zhu` 后，房间 VIP 包厢 2 仍挂「19:00 Naiyou Zhu（经络足道）180m」。工单已作废，日历/房态还当未取消预约。

3. **日结封账被点钞拦住，且弹窗关掉后页面仍写「今日营业中 (Open)」。**  
   `dayclose.finalize` 400：`reason: 还没点钞。「封了但没数」是最没用的一种日结`。代码有 `toast.danger`，本次快照没看到 toast。前台会以为没点到。

### P2

4. **日结大量中英混排：** `Open` `Net Sales` `Tender Total` `Cash $` `Variance` `Z-Report` `Amount ($)` `Stripe POS 刷卡机收款`。  
5. **小费结付看板写「0 人」**，同时当日小费 $6.75（阿博刷卡记账）。  
6. **底钱 $0 时记一笔零用金支出，账面应有现金变成 -$5.00**，差异显示「长款 +$5.00」。  
7. **礼品卡发售弹窗字段英文泄漏：** `FACE VALUE` `SALE PRICE` `PURCHASER` `RECIPIENT`。发售本身成功。  
8. **新增工位弹窗字段英文泄漏：** `NAME` `TYPE` `CAPACITY` `MAX STAFF`；帮助文案有弯引号。保存成功。  
9. **房间「安排客人入座 (Walk-in / 预约)」中英混排。**  
10. **订单页：** `营业日: 2026-09-05·` 缺空格；会员徽章 `Standard Member`；筛选项 `今日 (Today)`、`信用卡结算 (Visa/MC/Amex)`。  
11. **营销 KPI `0 pts`。**  
12. **登录会话会过期。** 测订单后退回登录页（refresh_token 400）。下一任若 Failed to fetch / 跳登录，重新登老板号。

### P3（前几轮未改，仍在）

- 日期控件 `Month Month` / `Show date picker`；日程上一/下一日按钮无名字  
- 仪表盘 `description="已完:: 0"`  
- 副驾 Copilot、快捷指令「房间3」、失败仍计 1/10（无 Anthropic key 是环境）  
- 健康表编辑器题型英文；设置服务卡 Duration 中英混排  
- 退订无 token 公开页故意成功态  

## 本轮通过、不要当没测过

- 作废：服务中单能作废，订单列表「已作废」  
- 礼品卡：确认发售成功，卡号进列表，储值池加面值  
- 新增工位：QA 工位 R5 出现  
- 零用金：$5 支出入账，日结 Movements -$5.00  

## 还没测（下一任按这个顺序）

真 Stripe Checkout **用户自己测，不要测。**

1. **收银现金实收 / 找零**（本轮作废了服务中单，没再结一单现金）  
2. **日结：先点钞保存，再封账**（本次卡在没点钞）  
3. **技师 `/tech`**（Amy `amy@maildrop.cc` / `GenieDev!2026` · 莲花）再看 `⟦mins⟧` / 服务代码  
4. **西语 / 越南语整页**（mia 只抽过仪表盘/settings）  
5. **Google OAuth**（登录页有「用 Google 登录」，没点完）  
6. **开店向导 `/setup`**  
7. **平台后台 `apps/platform :5179`**（需 `platform_operators`）  
8. **iPad `:5178` 配对成功后的签到 / walk-in / 健康表**（设置里可开配对码）  
9. **预约管理页真实 `#g/{token}`**（旧确认码 `GO-TJZM` 库里已经没了；需再提交一单托管预约拿 manageToken。booking 已起或 `pnpm --filter @gf/booking dev` → `:5176/golden-foot`）

## 怎么起（必须 geniefront-os，别混 staging）

```
# Kong/Auth 若停了：docker start supabase_kong_geniefront-os supabase_auth_geniefront-os …
pnpm dev:api:local          # API :3000，读 .env.local
pnpm --filter @gf/web dev   # :5177
# 需要再测再起：
pnpm --filter @gf/booking dev    # :5176
pnpm --filter @gf/ipad dev       # :5178
pnpm --filter @gf/platform dev   # :5179
```

账号：老板 `owner@maildrop.cc` · 店长 `amy@maildrop.cc` · 前台 `mia@maildrop.cc` · 密码都是 `GenieDev!2026`。

约束：金额整数分；时间用门店 IANA；禁止假数据/假合规；TDD；UI 改完用浏览器走通。未提交改动不要丢掉、不要 commit，除非用户要求。

第四轮已修且浏览器走过的（不要重做除非回归失败）：签到电话徽章、看板营收含小费、完工时刻 15:47、服务端算税、月弹窗死代码、看板中文短标题。

本机库税率：莲花 8.875%、金足 0。今日金足有 QA Clock Guest 已结 $51.75（退款没进去）、Naiyou Zhu 已作废、QA 工位 R5、礼品卡 $100。

---

# 第六轮（同日，修第五轮 P1；未 commit）

账号：老板 `owner@maildrop.cc` · 金足 · `America/Los_Angeles`  
环境：`pnpm dev:api:local` + `@gf/web :5177` · Kong `:55321`  
未提交改动保留，**没有 commit**。

## 修了什么

1. **`ticket.refund` 500。** 全额退款把 `walkin_queue` 标成 `left` 时补 `left_reason = refunded`。TDD：先写失败测试撞 `walkin_queue_left_reason`，再改 `apps/api/src/handlers/ticket.ts`。`core_loop` + `ticketLifecycle` 测试绿。
2. **作废不撤预约。** `guest_changed_mind` / `walk_out` / `paid_externally` 作废时取消预约与 appointment_items，排队 `left` 带原因。`input_error` 仍回到已签到、可重开替代单（原测试保留）。
3. **封账前没点钞。** 点「确认封账」若还没保存点钞：toast「请先在「钱箱面额精确盘点器」保存点钞，再封账」，切到盘点器 tab，不关弹窗乱跳。`ConfirmDialog` 失败时不再立刻关掉。概览在未点钞时显示「尚未点钞」，不再把账面负现金画成「长款」。

P2 顺手：日结顶栏中英混排（Open / Net Sales / Tender Total / Variance / Z-Report / Cash $ / Stripe POS）、礼品卡/工位弹窗去掉 uppercase 英文泄漏、房间「安排客人入座（现场 / 预约）」、订单页营业日空格 / 普通会员 / 今日 / 信用卡结算、营销 KPI「积分」代替 `pts`。小费结付看板 0 人：刷卡小费本来就不进现金抽屉发放，空态改成「今日小费已记入刷卡，现金抽屉无需发现金小费」。

## 浏览器走通

- 日结：未点钞点封账 → toast 上述文案 + 切到盘点器；页仍「今日营业中」+「尚未点钞」。没封账。
- 作废撤预约：新建 `QA Void Guest` 20:30 经络足道 → 签到 → 入座 VIP 包厢 2 → 收银作废（客人改主意）→ 工单从待结消失；VIP 包厢 2 变打扫、**不再挂客人名**；日程阿博列「暂无预约」。
- 退款 500：隔离库集成测试复现约束并修绿。本机今日看板空（第五轮 QA Clock Guest / Naiyou Zhu / QA 工位 R5 已不在今日列表），没有再拿那张 $51.75 单点退款。

## 还没测（顺序同第五轮）

真 Stripe **不要测。**

1. 收银现金实收 / 找零（本轮作废了服务中单，没结现金）
2. 点钞保存后再封账
3. 技师 `/tech`（Amy）
4. 西语 / 越南语整页
5. Google OAuth
6. `/setup`
7. platform `:5179`
8. iPad 配对后签到 / walk-in / 健康表
9. 托管预约 `#g/{token}`

P3 仍在：日期控件 Month Month；仪表盘 `已完:: 0`；副驾无 Anthropic key；健康表题型英文；设置 Duration 混排；退订无 token 公开页故意成功态。

## 本轮没修完 / 新发现（给下一任）

第五轮 3 条 P1 **已修**。下面还在，不要当全绿。

### 还没修的 P2（文案没收干净）

- 日结**正文**仍中英混排：`钱箱账面应有 (Expected Cash)`、`营业收入与税费拆解 (Sales Breakdown)`、盘点器 `纸币盘点 (BILLS)` / `硬币盘点 (COINS)` / `25¢ (Quarter)`、`账面应有 (Expected)`、`实点总计 (Counted)`、`盘点差异 (Variance)`、按钮「打印 Z-Report」
- 订单筛选项仍有 `昨日 (Yesterday)`
- 礼品卡/新增工位弹窗改了词条和去掉 `uppercase`，本轮**没再打开弹窗确认**

### 本轮新看到、没修

- **房间页「安排客人入座」400。** `/rooms` 给 VIP 包厢 1 填「QA Void Guest」点确认，toast「输入内容格式有误」。代码走 `resource.setStatus` → `in_service`，服务端拒 `resource_state_is_workflow_managed`（只能从排队入座推进）。按钮还在，点了没用。
- **仪表盘「签到」假成功。** 仪表盘卡片点签到 toast「已完成到店签到」，`/queue` 仍在「待到店」，要再到看板点「顾客到店签到」才进候客。

### 数据现状（2026-09-05 金足）

第五轮的 QA Clock Guest $51.75、Naiyou Zhu 作废单、QA 工位 R5 **今日列表里已经没了**（看板空过）。本轮建过并作废 `QA Void Guest`（VIP 包厢 2 现为打扫）。礼品卡 $100 卡号可能还在营销列表，没复核。

本地 API `:3000` 和 Web `:5177` 已关掉。Kong/Auth docker 没动。

---

# 第七轮（同日，修第六轮剩余 P2/P3；未 commit）

账号：老板 `owner@maildrop.cc` · 金足 · `America/Los_Angeles`  
环境：`pnpm dev:api:local` + `@gf/web :5177` · Kong `:55321`  
未提交改动保留，**没有 commit**。`deskCopy.test.ts` 8 条绿。

## 修了什么

1. **仪表盘签到假成功。** 卡片确认走 `joinQueue.mutateAsync(checkInJoinInput(...))`，失败 toast 后 `throw` 让 `ConfirmDialog` 不关。
2. **房间入座 400。** 不再 `resource.setStatus(in_service)`。确认入座：`queue.join` → `ticket.open`（带 `resourceId`）→ `ticket.startItem`。弹窗要选服务和技师。
3. **日结正文中英括号。** 去掉 Expected Cash / BILLS / COINS / Quarter / Counted / Variance；按钮「打印日结报表」；硬币标 `25¢`/`10¢`/`5¢`/`1¢`。订单筛选项「昨日」。
4. **P3 文案。** 仪表盘 `progressCountTitle` 不再 `已完:: 0`；日程 prev/next `aria-label` 上一/下一营业日，日期 `aria-label=选择日期`；健康表题型 是非/单选/多选/开放问答；设置服务卡「时长」；副驾快捷「空闲包厢标成打扫」；失败回合用 `copilotQueryCountAfterFailure` 退回计数。
5. **走查中顺手。** 健康表隐藏按钮 `title` 从缺失键 `healthForms.healthForms16/17` 改成已有的 `restoreVisibility` / `hideQuestion`。刷新后应不再出现 `⟦healthForms.healthForms17⟧`。

## 浏览器走通（本轮）

- 仪表盘 `已完: 0`（不是 `已完:: 0`）；按钮「AI 经营副驾」。
- 新建 `QA CheckIn Guest` 23:30 经络足道 / 阿博 → 仪表盘点签到 → 确认 → `POST /v1/commands/queue.join` **201** → 「大堂候客派工 (1)」出现该客人。
- 房间 VIP 包厢 1 入座 `QA Seat Guest` / 经络足道 / 阿博 → `queue.join` 201、`ticket.open` 201、`ticket.startItem` 201；房态变服务中，挂客人名；**没有** 400 / `resource.setStatus`。
- 日结：顶栏「钱箱账面应有」「营业收入与税费拆解」「打印日结报表」「尚未点钞」；盘点器「纸币盘点」「硬币盘点」「25¢」无英文括号。**没封账。**
- 订单筛选「昨日」无 `(Yesterday)`。
- 设置 → 服务项目：「时长: 60 分钟」。
- 健康表题目类型：单选题 / 是非题 / 开放问答题。
- 日程：按钮「上一营业日」「下一营业日」；点上一营业日到 2026-09-04 再点「今天」回来。原生 date 仍显示 Chrome a11y `Month Month`（只加了 `aria-label=选择日期`，不要改原生控件）。
- 副驾快捷「🧹 空闲包厢标成打扫」；无 Anthropic key 失败后计数仍 **0/10 轮**。

## 不要改（故意 / 环境）

- 退订无 token 公开页成功态（防枚举）。
- 会话刷新过期。
- 本机无 Anthropic key，副驾失败是预期。
- 小费结付看板不含刷卡小费（刷卡小费不进现金抽屉）。

## 还没测

真 Stripe **不要测。** 现金实收/找零、点钞后再封账、技师 `/tech`、西语/越南语、Google OAuth、`/setup`、platform `:5179`、iPad 配对、托管预约 `#g/{token}`、礼品卡/新增工位弹窗本轮没再打开。

## 数据现状（2026-09-05 金足，本轮留下的）

- `QA CheckIn Guest`：23:30 预约，已从仪表盘签到进候客。
- `QA Seat Guest`：VIP 包厢 1 **服务中** / 阿博 / 经络足道 60 分钟；工单 `ORD-748BF` **待收银 $45.00**。日结显示 1 单未结清。
- VIP 包厢 2、养生大厅空闲。
- 本地 API `:3000` 和 Web `:5177` **本轮结束时还在跑**。Kong/Auth docker 没动。

---

# 第八轮（同日，只测不改代码；未 commit）

账号：老板 `owner@maildrop.cc` · 金足 · `America/Los_Angeles`（前台主路径）；技师 `amy@maildrop.cc` · 莲花美甲 · `America/New_York`（`/tech`）  
环境：Kong `:55321` 上一轮还在；本轮开始时 API/Web 已停，只起了一套 `pnpm dev:api:local`（读 `.env.local`）+ `pnpm --filter @gf/web dev` `:5177`。未用 `@gf/api dev`。  
未提交改动保留，**没有 commit**。本轮**没改产品代码**（只追加本文件）。

## 本轮覆盖

1. 刷新 `/health-forms`：隐藏按钮 tooltip  
2. 收银现金实收 / 找零：`ORD-748BF` / QA Seat Guest $45（**没有**走 Stripe）  
3. 点钞保存后再封账  
4. 礼品卡发售弹窗、新增工位弹窗  
5. 技师 `/tech/today|summary|profile`（Amy）  
6. 西语 / 越南语：仪表盘、看板、日结、房间侧栏整页扫  
7. Google OAuth 点到 Auth；`/setup` 已有店老板登录后被拉回仪表盘  

没起：booking `:5176`、iPad `:5178`、platform `:5179`。托管预约 `#g/{token}`、iPad 配对后流程、平台后台 **仍未测**。

## 第七轮已修项回归（抽查，没重做）

| 项 | 结果 |
|---|---|
| 隐藏按钮不再 `⟦healthForms.healthForms17⟧` | **通过。** title/按钮文案都是「隐藏」 |
| 仪表盘 `已完: 1`（不是 `已完:: 1`） | 通过 |
| 日结「打印日结报表」「纸币盘点」「硬币盘点」「25¢」「账面应有/实点总计/盘点差异」无英文括号 | 通过 |
| 订单筛选「昨日」无 `(Yesterday)` | 通过 |
| 房间「安排客人入座（现场 / 预约）」 | 通过 |
| 营销 KPI「积分」不是 `pts` | 通过 |
| 未点钞拦封账（本轮先点钞再封，服务端放行） | 封账路径走通，见下 |

## 本轮走通的真路径

### 1. 健康表隐藏按钮

刷新 `/health-forms`。8 个「隐藏」按钮 `title="隐藏"`，页面正文无 `⟦healthForms.healthForms17⟧`。

**新尾巴：** 点「发送邀请」弹窗泄漏 `⟦healthForms.healthForms18⟧`（邮件频道按钮）和 `⟦healthForms.healthForms19⟧`（消息预览）。点「二维码」先 toast `⟦healthForms.warning12⟧`，弹窗没打开（share 失败）。代码里二维码弹窗还有 `healthForms22` / `healthForms24` 缺失键，本轮没看到弹窗本身。

### 2. 现金实收 / 找零（ORD-748BF）

开工状态仍是「服务中」，不是第七轮写的「待收银」。看板点「完工核算账单」→ `ticket.finishItem` **201**（实际 11m，预估 60）→ 待收银。`/checkout` 已完工 tab，房间仍是 VIP 包厢 1，金足税 $0.00。

支付改「现金」，客人给的现金 **$50.00**，找零 **$5.00**，「不用找零」未勾。`POST /v1/commands/ticket.pay` **201**：

```
method=cash, amountCents=4500, tenderedCents=5000, changeCents=500, keepChange=false, taxCents=0
```

收银页未结工单变 0。`/tickets`：`ORD-748BF` 20:34（LA）QA Seat Guest **现金支付 $45.00 / 已结清 / 无小费**。看板「今日已结营收」$45.00。**没有** Stripe。

**输入体验：** 实收框是受控金额，MCP `fill("50.00")` 被格式化成 `5.00`。整段写入 `50.00` 后找零才对。真人若逐字打也可能打不成 50，记 P2。

### 3. 点钞保存后再封账

日结先显示「全部已结清」「尚未点钞」、现金/账面应有 $45.00。盘点器切「直接录入总金额」填 $45.00 → 账实完全相符（差异 $0.00）。`POST /v1/commands/dayclose.saveCount` **201** `countedCashCents=4500, cashVarianceCents=0`。再点「确认封账」弹窗出现（不再 toast 要求先点钞）。`POST /v1/commands/dayclose.finalize` **201** `cashVarianceCents=0`。页顶变成「已正式打烊封账」。

**P1 显示错：** 保存/封账之后 UI 仍画「钱箱短款 -$45.00 / 实点总额 $0.00」。GET `/v1/desk/dayclose` 明明 `countedCashCents=4500`、`cashVarianceCents=0`、`status=closed`，但 `countBreakdown` 全是 0（直接录入没写面额）。`DayClose.tsx` 只要 `Object.keys(countBreakdown).length > 0` 就进面额模式，把已保存的 $45 盖成 0。封账归档是对的，前台看到的日结报表是假短款。

下日备用金输入框仍是 $200，saveCount body **没带** `closingFloatCents`，GET `closingFloatCents=0`、`safeDropCents=4500`。

封账时候客里还有 `QA CheckIn Guest`，未结工单是 0，服务端没拦。

### 4. 礼品卡 / 新增工位弹窗

- 发售弹窗：**通过。** 「礼品卡面值 ($)」「实际销售价格 ($)」「购买人姓名（可选）」「受赠人姓名（可选）」。没有 `FACE VALUE` / `PURCHASER`。没再点确认发售（日已封）。列表 `GC-RELAX-75` 状态「有效」；发售日显示 **2026-09-06**（像 UTC 日，店是 09-05 LA）。第五轮 $100 卡不在列表，储值池 $75。
- 新增工位弹窗：**通过（原 uppercase 泄漏）。** 「名称 *」「工位类型」「同时容纳客人数」「最多允许不同技师数（可选）」。类型选项仍夹英文 `(Private Room)` 等。没保存。总工位仍 3（第五轮 QA 工位 R5 不在）。VIP 包厢 1 结账后是打扫。

### 5. 技师 `/tech`（Amy · 莲花）

- `⟦mins⟧` **已没了**，时长显示「0 分钟」。
- 派工卡标题仍是 **`spa_pedi`**（`GET /v1/staff/me/today` 的 `serviceName`/`durationMin=0`）。Sophia Williams / `+12125550301`。
- 轮牌仍「当前轮牌位次第 - 位」。
- 「上班打卡」`timeclock.punch clock_in` 201 且 `onDuty:true`，UI 却是「暂休中 (不派单)」，「开始服务」禁用。点「回岗」`break_end` 201 `onDuty:true`，随后 `GET .../today` 仍 `rotation.onBreak:true`。三页能切；业绩总结 $0.00 干净；资料技能中文、班次 09:30–19:30。

### 6. 西语 / 越南语

侧栏和仪表盘/看板/日结/房间译文齐全，**没有** `⟦⟧`。西语技师标签是 `Personal`（中文仪表盘仍用「员工管理」）。越南语「Nhân viên」。日结假短款两种语言都在。房间业务名「VIP 包厢 1」「养生大厅 Hall」未译（数据）。扫完已切回 **中文**。

### 7. 可选路径（没走完）

- **Google OAuth：** 登录页「用 Google 登录」跳到 `127.0.0.1:55321/auth/v1/authorize?provider=google`，本地 Auth **400** `Unsupported provider: provider is not enabled`。本机环境，没走完 Google。
- **`/setup`：** 未登录是登录页；老板登录后访问 `/setup` **被拉回 `/dashboard`**，没看到向导。
- **platform `:5179`、iPad `:5178`、booking `#g/{token}`：** 本轮没起这些进程。

## 本轮新发现

### P1

1. **日结直接录入点钞保存后，UI 用全 0 面额画出假短款 $45。** 服务端 `countedCashCents=4500` / `cashVarianceCents=0` / `status=closed`。`DayClose.tsx` 约 146–148 行：`countBreakdown` 有 key 就当面额模式。封账本身成功。  
2. **技师端派工仍是服务代码 `spa_pedi`，时长 0 分钟。** 第五轮 P1-21 的 `⟦mins⟧` 已修，代码名没修。API 就返回 `spa_pedi` / `durationMin:0`。  
3. **技师打卡：命令说在岗，UI/轮牌仍暂休。** `clock_in`/`break_end` 都 201 `onDuty:true`，`GET /v1/staff/me/today` `rotation.onBreak:true`，开始服务禁用。

### P2

4. 健康表邀请弹窗 `⟦healthForms.healthForms18⟧` / `19`；二维码 toast `⟦healthForms.warning12⟧`（22/24 在二维码弹窗代码里，没打开）。  
5. 收银「客人给的现金」逐字输入会被格式化吃掉（`50.00`→`5.00`）。  
6. 日结「下日预留备用金 $200」保存点钞时没写入，GET `closingFloatCents=0`。  
7. 仪表盘在日结已封后仍写「实时营业中」；`QA CheckIn Guest` 已在候客，卡片仍是「签到」、KPI「待到店: 1」。  
8. 礼品卡发售日 `2026-09-06`（店历 09-05 LA）。新增工位类型选项夹 `(Private Room)` 等英文。  
9. 技师轮牌文案「当前轮牌位次第 - 位」（第二轮就有）。

### 走查文案（没当 bug 修）

- 仪表盘预约卡技师标签仍用「员工管理」（`t('staff')`）；西语 `Personal`、越南语 `Nhân viên`  
- 房间名「养生大厅 Hall」  
- 订单页「平均客单价 (AOV)」  
- 健康表顾客题干仍是英文（产品设定）

## 不要改（故意 / 环境）

- 退订无 token 公开页成功态  
- 会话刷新过期  
- 本机无 Anthropic key  
- 小费结付看板不含刷卡小费  
- 日程原生 date 的 Chrome a11y `Month Month`（已有 `aria-label=选择日期`）  
- 本机 Google provider 未启用（400）

## 数据现状（2026-09-05 金足，本轮留下的）

- **日已封账**（`status=closed`）。服务端点钞 $45、差异 $0、现金实收 $45。UI 仍显示假短款 -$45。  
- `QA Seat Guest` / `ORD-748BF`：**已结清 · 现金 $45.00 · 无小费**；VIP 包厢 1 **待打扫**。  
- `QA CheckIn Guest`：仍在候客（已等候约 26m，标超时），23:30 预约 / 阿博 / 经络足道。仪表盘卡片还写「签到」。  
- VIP 包厢 2、养生大厅空闲。  
- 莲花 Amy：已 `clock_in` + `break_end`，`/tech` 仍显示暂休。  
- 本地 API `:3000` 和 Web `:5177` **本轮结束时还在跑**。Kong/Auth docker 没动。

若下一任要在「今天」再收银，先日结页点「重新打开营业日」，或换到 09-06（视门店打烊时刻）。**不要**把未提交改动丢掉，**不要 commit**，除非用户明确要求。

# 第九轮（同日，修第八轮 P1/P2 并全量浏览器回归；未 commit）

## 修复项与验证矩阵

| 测试项 | 预期 | 本轮实际结果 | 判定 |
|---|---|---|---|
| **P1-1 (DayClose 假短款)** | 直接录入总金额点钞保存后，报表与顶栏根据实点值计算差异，不被全 0 面额覆盖 | 直接录入 $45.00，下日备用金 $200.00。保存后 UI 明确显示「实点总计 $45.00，账面应有 $45.00，盘点差异 $0.00，账实完全相符」，彻底消除假短款 `-$45.00` | **通过** |
| **P1-2 (技师派工卡)** | 技师端派工卡显示多语言服务名与真实时长，非 raw code `spa_pedi` 与 0 分钟 | Amy 登录 `/tech`，派工卡显示「基础足部护理」（中文），标准时长「45 分钟」，倒计时 44:59 | **通过** |
| **P1-3 (技师打卡状态)** | 上班打卡后状态为在岗接单中，「开始服务」可用；暂休变暂休且禁用按钮；回岗恢复 | 打卡后显示「在岗接单中」；点「暂休」变为「暂休中」且「开始服务」置灰；点「回岗」恢复在岗且按钮解禁；可顺利开始并完工 | **通过** |
| **P2-4 (健康表邀请 i18n)** | 发送邀请弹窗无 `⟦healthForms.healthForms18/19⟧` 缺失标记 | 打开弹窗显示「电子邮件」，模板消息预览完整无缺失键 | **通过** |
| **P2-5 (收银现金实收打字)** | 客人给的现金逐字输入 `50.00` 不会被提前格式化为 `5.00` | 连续键入 `50.00` 稳定保持，找零即时准确计算为 `$5.00`，提交 `tenderedCents: 5000, changeCents: 500` | **通过** |
| **P2-6 (备用金持久化)** | 日结预留备用金 $200.00 在点钞保存时写入服务端 | `saveCount` 请求体携带 `closingFloatCents: 20000`，重载后持久化保持 $200.00 | **通过** |
| **P2-7 (仪表盘封账角标)** | 日结已封后仪表盘角标显示「已打烊封账」，技师标签为「技师」 | 封账后仪表盘角标为「已打烊封账」，预约卡片中技师标签为「技师」而非「员工管理」 | **通过** |
| **代码隐患修复 (TDZ Crash)** | `Dashboard.tsx` 存在 `waitingQueue` TDZ 导致的白屏异常 | 修复声明顺序，带预约单的门店（如莲花美甲）访问 `/dashboard` 稳定渲染不再白屏 | **通过** |

## 本轮全量走通的真路径（真实浏览器与接口联动）

### 1. 技师工作台全生命周期（/tech · 莲花美甲 · Amy）
- 登录 `amy@maildrop.cc`，自动识别为莲花美甲并进入工作台。
- 初始状态显示「未打卡上班」。
- 点击「上班打卡」，API `timeclock.punch` 返回 201，工作台状态实时切换为「在岗接单中」。
- 收到派工任务卡片：标题「基础足部护理」、时长「45 分钟 标准时长」、顾客「Sophia Williams (`+12125550301`)」。「开始服务」按钮处于激活可点击状态。
- 点击「暂休」，工作台切换为「暂休中」，「开始服务」按钮即时被禁用。
- 点击「回岗」，工作台状态恢复为「在岗接单中」，「开始服务」重新可用。
- 点击「开始服务」，倒计时启动，剩余时间显示 44:59。
- 服务完成后点击「完成项目」，派工单转入「已完成项目与小费状态 / 基础足部护理 / 待收银确认」，今日完工计数变为「1 单」。

### 2. 金足足疗入座派工与前台完工（/rooms & /queue · 老板）
- 登录 `owner@maildrop.cc` 进入金足足疗。
- 访问 `/rooms`，在「VIP 包厢 1」卡片上点击「安排客人入座（现场 / 预约）」。
- 填入顾客姓名「QA Seat Guest」，服务选择「经络足道 60 分钟」，技师选择「阿博」，点击「确认入座并置为服务中」。
- 房间状态即时变为「服务中」，生成工单 `#9f56d09d`。
- 访问 `/queue`，看板「服务中」列出现「QA Seat Guest」卡片。
- 点击「完工核算账单」，在核对弹窗中点击「确认完工并转入待收银（$45.00）」，单据顺利移至待收银阶段。

### 3. 现金收银结算与找零体验（/checkout · 老板）
- 访问 `/checkout`，在「已完工」分类下选中「QA Seat Guest」工单（金额 $45.00）。
- 支付方式下拉选择「现金」。
- 在「客人给的现金」输入框连续输入 `50.00`，值稳定保持 `50.00`（未发生早期缩减为 `5.00` 的 Bug），系统自动计算找零为 `$5.00`。
- 点击「确认收银结算并打印小票 ($45.00)」，`POST /v1/commands/ticket.pay` 返回 **201**：
  ```json
  {
    "method": "cash",
    "amountCents": 4500,
    "tenderedCents": 5000,
    "changeCents": 500,
    "keepChange": false,
    "taxCents": 0
  }
  ```
- 收银结算完成，工单列表中待结工单归零。访问 `/tickets` 查验订单记录：`ORD-9F56D` 明确标示「已结清 · 现金支付 $45.00 · 无小费」。

### 4. 日结对账、备用金保存、封账与重新开账（/day-close · 老板）
- 访问 `/day-close`，系统准确汇总现金实收款 $45.00，账面应有现金 $45.00。
- 切换至「直接录入总金额」盘点模式，输入实点现金 $45.00，下日留存备用金确认 $200.00。
- 点击「保存点钞」，`POST /v1/commands/dayclose.saveCount` 返回 **201**（包含 `closingFloatCents: 20000`）。
- **核对修复结果：** 页面没有出现假短款 `-$45.00`，而是正确显示「账实完全相符（盘点差异: $0.00）」，实点总计 $45.00。
- 点击「确认封账」并在弹窗确认，`POST /v1/commands/dayclose.finalize` 返回 **201**，页面标题更新为「已正式打烊封账」。
- 访问 `/dashboard` 检查：顶栏角标正确显示为「已打烊封账」（非「实时营业中」），技师标签显示为「技师」。
- 再次访问 `/day-close` 测试重开流程：点击「重新打开营业日」，录入重开原因「Round 9 test recount and verify reopen」，点击「确认重开」，`POST /v1/commands/dayclose.reopen` 返回 **201**，营业日恢复为「今日营业中」。随后重新点击确认封账锁定。

### 5. 健康表邀请与多语言检查（/health-forms · es / vi）
- 访问 `/health-forms`，点击「发送邀请」，打开弹窗检查各 Tab，显示「电子邮件」且正文无未定义键 `⟦healthForms.18/19⟧`。
- 切换语言至西班牙语（`es`）和越南语（`vi`），重点走查 `/dashboard`、`/day-close`，均无任何缺失翻译占位符（`⟦...⟧`）。

## 测试套件执行结果

- `@gf/web`: 50 个测试套件，255 个测试用例全部 **PASS**。
- `@gf/api`: 84 个测试套件，1114 个测试用例全部 **PASS**。

## 数据现状与交接状态

- **门店状态：** 金足足疗（Gold Foot）当前已正式封账（`status: closed`），今日已结净营业额 $45.00，差异 $0.00。
- **技师端状态：** 莲花美甲（Lotus Nails）Amy 处于在岗状态，Sophia Williams 派工已完成。
- **进程状态：** 本地 API `:3000` 与前端 Web `:5177` 均保持在后台运行中，Kong/Auth (`127.0.0.1:55321`) 正常。
- **代码状态：** 所有修复改动均保留在工作区未 commit。未触碰真实 Stripe。

