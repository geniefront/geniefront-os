# 02 · 数据模型（Postgres）

约定：
- 所有表有 `id uuid pk`、`org_id`、`created_at`、`updated_at`，业务表多数有 `location_id`
- 金额一律 **integer cents**，`currency` 存在 location 上
- 时间一律 `timestamptz`；需要"墙上时间"的地方额外存 `local_date` / `local_time` + `tz`
- 软删用 `archived_at`，**财务相关一律不删只作废**
- 多语言文本用 `jsonb`：`{"en": "...", "vi": "..."}`

---

## 1. 组织 / 门店 / 订阅

> **计费单位 = 门店。** 老板有两家店就是两个订阅。`organizations` 只是"同一个老板的店的分组"，
> 单店老板在 UI 里**完全看不到这个概念**（注册时自动创建）。多店老板才会看到"我的店铺"列表。

```
organizations            id, name, billing_customer_id(stripe), owner_user_id,
                         sharing(jsonb), default_locale, created_at
                         -- sharing: {customers:true, gift_cards:false, packages:false, staff:true}
locations                id, org_id, name(jsonb), slug, timezone, currency, address, phone,
                         business_hours(jsonb), holiday_calendar(jsonb),
                         business_day_cutoff(time, 默认 03:00),
                         business_type(nail|massage|foot_spa|hair|lash|mixed),
                         public_key, settings(jsonb), status(trial|active|past_due|suspended|closed)
location_subscriptions   id, location_id, org_id, plan, status, stripe_subscription_item_id,
                         trial_ends_on, current_period_end, cancel_at
location_features        location_id, key, enabled, config(jsonb)     -- 功能开关（按业态预设）
usage_events             org_id, location_id, kind, qty, cost_cents, at
                         -- kind ∈ email | sms | ai_assist | ai_call_min
                         -- ⚠️ ai_assist（副驾操作次数，~$0.012）与 ai_call_min（AI 电话分钟，
                         --    ~$0.10–0.20）成本差 10 倍以上，必须分开计量、分开售卖（04 §4.1）
```

**规则**
- 每个 `location` 独立订阅、独立停用。A 店欠费停用不影响 B 店。
- Stripe 侧：一个 org = 一个 Customer，一个 Subscription，**每家店一个 subscription item**（这样老板收到一张账单、看得懂每家店多少钱，也支持随时加店减店）。
- `sharing` 控制同一 org 内跨店共享什么。默认**共享顾客**（同一个老板的客人换店做很常见），礼品卡/套餐默认**不共享**（财务归属会吵架），可开。
- **跨 org 不共享任何数据**，即使同一个人是两家店的技师。

`settings(jsonb)` 存不值得单独建表的：预约提前量、时段粒度、取消政策文案、小费预设百分比等。其中**容量**部分（对应 `01` §7.1）：

```jsonc
"capacity": {
  "slot_minutes": 15,
  "max_concurrent_per_slot": null,  // null = 自动取该时段在岗且 is_bookable 的员工数
  "overbook": "warn"                // warn（默认）| block
                                    // 只作用于技师层与门店层；资源层永远是硬约束
}
```

### 业态差异（一套系统，按 `business_type` 出预设）

| 业态 | 默认开启的模块 |
|---|---|
| nail | 轮牌板、walk-in 队列、重叠排期、指甲照片、节日加价 |
| massage / foot spa | 房间资源、性别偏好、健康表/同意书、加钟、通话录音告知 |
| hair | 处理时间（染烫等待段）、助理 tip-out |
| lash / brow | 单人房、复诊周期提醒 |

一个 location 可以是 `mixed`（很多华人店同时做甲和足疗），模块按需勾选。

---

## 2. 身份 / 员工 / 权限

```
users                    id uuid pk, email, phone, full_name, locale, avatar_url
memberships              id, org_id, location_id(null=全组织), user_id, employment_type(w2|1099_booth),
                         status(active|suspended|left), started_on, ended_on
roles                    id, org_id, key, name, is_preset
role_permissions         role_id, permission
membership_roles         membership_id, role_id
permission_overrides     membership_id, permission, allow(bool)      -- 个别加减

staff_profiles           membership_id, display_name(jsonb), level_id, gender, bio(jsonb),
                         languages text[], hire_date, pin_hash, photo_url,
                         is_bookable(bool),                       -- ⭐ 店长/前台/老板也接客时打开
                                                                  --    默认：有 tech 角色 = true
                         max_concurrent_appointments(int 默认 1), -- ⭐ 美甲店可设 2（做手时脚在泡）
                         bookable_online(bool), color             -- 日程表配色
staff_levels             id, location_id, key, name, sort, price_modifier, tip_weight
skills                   id, location_id, key, name(jsonb)
staff_skills             membership_id, skill_id, proficiency
staff_licenses           membership_id, kind, number, issued_on, expires_on, doc_url   -- 到期提醒
device_tokens            id, location_id, label, token_hash, last_seen_at              -- 共享 iPad
```

**PIN 登录**：设备用 `device_token` 换取门店级会话；技师输 PIN → 服务端比对 `pin_hash` → 签发**受限 JWT**（scope 仅限该门店、仅限员工端能力、短有效期）。PIN 不可用于远程登录。

### 一个人 / 多家店（重要）

`users` 是**全局唯一**的（一个邮箱/手机号一个账号），`memberships` 是"这个人在这家店的身份"。由此自动满足：

- **老板有多家店** → 多条 membership（或一条 `location_id = null` 的 org 级 membership）。登录后出现**店铺选择器**；顶部可随时切店。
- **技师在两家店上班**（哪怕是两个不同老板的店）→ 两条 membership，分属两个 org。员工端顶部切店，打卡/排班/收入**各店独立统计**，两个老板互相看不到对方的数据。
- **同一个人在 A 店是技师、在 B 店是店长** → 角色按 membership 走，天生支持。
- `staff_profiles` 挂在 **membership** 上而不是 user 上：在 A 店叫 Amy 等级 Master，在 B 店叫 阿美 等级 Level 2，互不干扰。
- 登录流程：认证 → 查该 user 的所有 active membership → 只有一条就直接进；多条就出选择器（记住上次选择）。
- 离职：`membership.status = left` + `ended_on`。**历史业绩保留，但立刻失去所有数据访问权**。

```
user_last_location       user_id, location_id, at        -- 记住上次进的店
```

---

## 3. 项目 / 资源

```
service_categories       id, location_id, name(jsonb), sort
services                 id, location_id, category_id, name(jsonb), description(jsonb),
                         duration_min, buffer_before_min, buffer_after_min,
                         processing_gap(jsonb: [{active_min, wait_min, active_min}]),  -- 重叠排期
                         base_price_cents, taxable(bool),
                         staff_count(默认1),          -- 2 = 双技师项目
                         turn_value(numeric),          -- 轮牌折算，null=按规则算
                         online_bookable, active, sort
service_prices           service_id, staff_level_id, price_cents, duration_min   -- 按等级差异化
service_required_skills  service_id, skill_id
service_resources        service_id, resource_type_id, qty
addons                   id, location_id, name(jsonb), price_cents, duration_min, applies_to[]
resource_types           id, location_id, key, name(jsonb)          -- room / pedi_chair / bed / couples_room
resources                id, location_id, resource_type_id, name, status(available|occupied|cleaning|out_of_service),
                         capacity(默认1),              -- ⭐ 一间房能同时服务几位客人（Phase 1b）
                         max_staff(可空)               -- ⭐ 同时段最多几个不同技师，null = 不限
price_rules              id, location_id, kind(peak|holiday|promo), match(jsonb), adjust(jsonb), active_range

service_option_defs      id, location_id, key, label(jsonb), hint(jsonb),
                         input(single|multi|scale|bodymap|color|text|photo),
                         options(jsonb),          -- 选项列表，每项 {value, label(jsonb), icon}
                         applies_to(jsonb),       -- {business_types:[], service_ids:[], category_ids:[]}
                         sticky(bool),            -- ⭐ 记住上次选择，下次开单自动带出
                         to_staff(bool),          -- 是否显示在技师端"下一位客人"卡片上
                         required, sort, active
```

### 3.1 落单要素（Service Options）：一套机制，按业态出预设 ⭐

「按摩要选力度和部位、美甲要选甲型和色号」不该写成一堆硬编码的列 —— 那样每加一个业态就要改表。
做成**声明式选项目录**：`service_option_defs` 按 `business_type` 出预设（店主可增删改），
本次的答案存在 `appointment_items.details` / `ticket_items.details` 的 jsonb 里。

**三个关键属性：**

| 属性 | 作用 |
|---|---|
| `sticky` | 老客回头最常说的是"跟上次一样"。sticky 的选项在开单时自动带出上次的值，前台一眼确认即可。力度、甲型、色号、睫毛卷翘度都必须 sticky |
| `to_staff` | 决定这一项是否出现在技师端的"下一位客人"卡片上。**力度/部位/过敏要显示；健康问卷明细不显示**（那是 `customer.view_health_form` 权限的东西，见 `04` §11） |
| `input: bodymap` | 人体图点选（正面/背面），前台/客人直接点身体部位。**对英文不好的客人和技师，这比任何文字都有效** —— 符合宪法第 11 条"图标优先" |

**存储位置的分工：**

```
service_option_defs                 选项目录（店主可配，AI 可读，i18n 走 label(jsonb)）
customer_preferences.profile(jsonb) 这位客人的长期默认（sticky 的来源）
appointment_items.details(jsonb)    这一次预约的选择
ticket_items.details(jsonb)         结账时的最终快照（加钟改了力度也在这）
```

**为什么 details 也要落在 ticket 上**：客人事后说"上次那个师傅力度刚好"，前台要能翻出来；
技师之间交接（`00` §1.5.1 接力服务）也要看到前一位定的是什么。

---

### 3.2 各业态预设（Phase 0 种子数据，店主可改）

#### 按摩 / 足疗（massage / foot_spa）⭐

| key | 输入 | 选项 | sticky | 给技师看 |
|---|---|---|---|---|
| `pressure` **力度** | scale (5 档) | 轻柔 / 偏轻 / 适中 / 偏重 / 大力 | ✅ | ✅ |
| `focus_areas` **重点部位** | **bodymap** + multi | 头颈 / 肩 / 上背 / 下背腰 / 臀胯 / 大腿 / 小腿 / 足 / 手臂 / 腹 | ✅ | ✅ |
| `avoid_areas` **避开部位** ⚠️ | **bodymap** + multi | 同上 + 自由备注（近期手术、扭伤、静脉曲张、淤青、皮肤破损） | ✅ | ✅ **红色高亮** |
| `body_condition` 身体状况提示 | multi | 怀孕（+周数）/ 高血压 / 血栓史 / 近期手术 / 糖尿病 / 皮肤病 | ✅ | ⚠️ 只显示"有禁忌，见前台"，明细走健康表权限 |
| `room_temp` 室温 | single | 偏凉 / 适中 / 偏暖 | ✅ | ✅ |
| `music_light` 音乐灯光 | single | 安静无音乐 / 轻音乐 / 正常 | ✅ | ✅ |
| `talk_preference` 是否聊天 | single | 想安静 / 随意 / 喜欢聊 | ✅ | ✅ |
| `oil_preference` 精油/介质 | single + 过敏 | 无油 / 基础油 / 薰衣草 / 姜 / 薄荷 ⚠️**坚果油过敏必查**（杏仁油很常见） | ✅ | ✅ |
| `draping` 遮盖偏好 | single | 标准遮盖 / 加强遮盖 | ✅ | ✅ |
| `mark_consent` 刮痧/拔罐留痕同意 ⚠️ | single | 已告知并同意 / 不做留痕项目 | ❌ 每次单独确认 | ✅ |
| **足疗专属** | | | | |
| `water_temp` 泡脚水温 | single | 温 / 适中 / 热 | ✅ | ✅ |
| `callus_intensity` 去死皮力度 | scale (3 档) | 轻 / 适中 / 彻底 | ✅ | ✅ |
| `foot_condition` 足部状况 | multi | 灰指甲 / 脚气 / 伤口 / 糖尿病足 ⚠️ **触发一次性内衬 + 消毒记录**（`00` §1.9） | ✅ | ✅ |

> `avoid_areas` 与 `body_condition` 是**法律与保险相关**的，必须与 `form_submissions`（健康表）双向关联：
> 健康表里勾了"近期手术"，开单时自动把该部位预填进 `avoid_areas` 并要求前台确认。

#### 美甲（nail）

| key | 输入 | 选项 | sticky | 给技师看 |
|---|---|---|---|---|
| `system` **做法/系统** | single | 普通甲油 / 甲油胶(Gel) / 浸粉(Dip·SNS) / 水晶(Acrylic) / 硬胶 / Gel-X / 延长胶 | ✅ | ✅ |
| `removal` **是否需要卸甲** ⭐ | single | 不需要 / 卸同款 / 卸他店的（+时长+价） | ❌ 每次问 | ✅ |
| `shape` **甲型** | single + 图标 | 方 / 方圆 / 圆 / 椭圆 / 杏仁 / 棺材 / 尖 | ✅ | ✅ |
| `length` **长度** | single | 自然 / 短 / 中 / 长 / 超长 | ✅ | ✅ |
| `color_ref` **色号** | color + photo | 品牌 + 色号 + 上次照片（`customer_photos`） | ✅ | ✅ |
| `art` 款式 | multi | 素色 / 法式 / 渐变 / 猫眼 / 镜面 / 贴钻 / 手绘（+加价加时） | ✅ | ✅ |
| `cuticle` 死皮处理 | scale (3 档) | 轻 / 适中 / 彻底 | ✅ | ✅ |
| `nail_condition` 甲况 ⚠️ | multi | 易断 / 咬甲 / 甲床短 / 灰指甲 / **丙烯酸酯过敏** | ✅ | ✅ |
| `hand_foot_care` 附加护理 | multi | 去角质 / 手部按摩 / 热蜡(paraffin) | ✅ | ✅ |
| **修脚专属** | | | | |
| `pedi_water_temp` 水温 | single | 温 / 适中 / 热 | ✅ | ✅ |
| `callus_intensity` 去死皮力度 | scale (3 档) | 轻 / 适中 / 彻底（⚠️ 加州禁用 credo 刀片） | ✅ | ✅ |

> `removal`（卸甲）是**最容易漏、最容易吵架**的一项：漏了会少收 15–30 分钟和 $10–20，
> 而且会打乱后面的排期。开单时必问，不填不让进下一步。

#### 头疗 / 头皮护理（head spa）

| key | 输入 | 选项 | sticky | 给技师看 |
|---|---|---|---|---|
| `pressure` **力度** | scale (5 档) | 轻柔 → 大力 | ✅ | ✅ |
| `focus_areas` **重点部位** | multi + 头部图 | 头顶 / 两侧 / 后脑 / 颈肩 / 太阳穴 | ✅ | ✅ |
| `scalp_type` 头皮类型 | single | 油性 / 干性 / 混合 / 敏感 | ✅ | ✅ |
| `scalp_concern` 关注问题 | multi | 头屑 / 出油 / 脱发 / 头皮痒 / 毛囊堵塞 / 头皮痘 | ✅ | ✅ |
| `water_temp` 水温 | single | 温 / 适中 / 热 | ✅ | ✅ |
| `chemical_history` 染烫史 ⚠️ | single | 近 3 个月染 / 烫 / 漂 / 无 —— **影响产品选择** | ✅ | ✅ |
| `product_pref` 产品/香型 | single + 过敏 | 无香 / 茶树 / 薄荷（刺激感）/ 姜 ⚠️ 精油过敏必查 | ✅ | ✅ |
| `neck_shoulder_addon` 颈肩加钟 | single | 不加 / +15min / +30min（常见 upsell） | ❌ | ✅ |
| `blow_dry` 是否吹干造型 | single | 需要 / 不需要（影响时长） | ✅ | ✅ |
| `scope_photo` 头皮检测对比照 | photo | 前 / 后（需 `consents` 照片同意） | ❌ | ✅ |

#### 美睫（lash）

| key | 输入 | 选项 | sticky | 给技师看 |
|---|---|---|---|---|
| `lash_type` **类型** | single | 单根(Classic) / 混合(Hybrid) / 浓密(Volume) / 超浓密(Mega) | ✅ | ✅ |
| `service_kind` **新做 or 补睫** ⭐ | single | 全新 / 补（按上次到店天数自动建议，>3 周按全新算） | ❌ 每次判断 | ✅ |
| `curl` 卷翘度 | single | J / B / C / CC / D / L / M | ✅ | ✅ |
| `thickness` 粗细 | single | 0.03 / 0.05 / 0.07 / 0.10 / 0.15 / 0.20 | ✅ | ✅ |
| `length_mix` 长度搭配 | text | 如 `8-13mm 中间长` | ✅ | ✅ |
| `glue_sensitivity` **胶水敏感** ⚠️⚠️ | single | 无 / 曾红肿 / 需先做斑贴测试（**记录测试日期**） | ✅ | ✅ **红色高亮** |
| `eye_condition` 眼部状况 | multi | 干眼 / 戴隐形 / 结膜炎史 / 自然睫毛稀疏受损 | ✅ | ✅ |

> `glue_sensitivity` 是这一类里**唯一可能出人身伤害和索赔**的字段（氰基丙烯酸酯过敏会导致眼睑肿胀）。
> 选了"需斑贴测试"的客人，未记录测试通过日期时**禁止开单**，这是硬拦截。

---

### 3.3 前台与技师端的呈现

- **开单页**：只显示这个项目 `applies_to` 命中的选项，**大按钮/图标网格**，不用下拉框（宪法第 11 条）
- **sticky 回填**：老客开单时上次的选择已经填好并标"上次"，前台点一下确认即可 —— 这是"跟上次一样"的产品化
- **技师端卡片**（Phase 1c）：只显示 `to_staff = true` 的项，`avoid_areas` / 过敏 / 胶水敏感**红底高亮置顶**
- **AI 副驾**：`service_option_defs` 直接转成工具 schema，可以说"给王姐排个 60 分钟，力度重一点，重点做肩颈"
- **多语言**：`label` / `options` 全部 jsonb，AI 开店向导可一键补齐五种语言（`05` §4.4）

---

## 4. 排班 / 考勤

> **Phase 1b 已落地**：`shift_templates` / `shifts`（下方标 ✅ 的字段是实际实现，
> 与最初设想的差别写在小节末尾）。其余仍是规划。

```
shift_templates ✅        id, org_id, location_id, membership_id, weekday(0=周日),
                         start_min, end_min, break_min, active
shifts ✅                 id, org_id, location_id, membership_id, business_date,
                         start_min, end_min, break_min,
                         status(planned|published|off), off_reason, note,
                         from_template(bool),          -- 手工改过的班不会被下次一键铺开冲掉
                         published_at, updated_by
shift_swap_requests      id, from_shift_id, to_membership_id, status, decided_by, decided_at
shift_swap_requests      id, from_shift_id, to_membership_id, status, decided_by, decided_at
availability_prefs       membership_id, weekday, start_local, end_local, kind(preferred|unavailable)
time_off_requests        id, membership_id, starts_at, ends_at, type(vacation|sick|personal),
                         status(pending|approved|denied), note, decided_by
time_punches ✅           id, org_id, location_id, membership_id, business_date,
                         kind(clock_in|clock_out|break_start|break_end),
                         at, method(pin|desk|app),
                         on_behalf_by,          -- ⭐ 前台代打卡时的操作人
                         note, edited_by, edit_reason, ip
work_days                membership_id, business_date, worked_min, break_min, overtime_min  -- 汇总物化
```

### ⭐ 打卡是流水，不是状态（Phase 1c）

只记「谁在几点打了什么卡」，**「现在在不在岗」由重放流水得出**
（`replayPunches()`，和轮牌用事件溯源同一个理由：状态字段会和流水打架，
而打架时没人说得清哪个对）。休息段不计薪，重放时扣掉。

三种 `method` 的法律含义不同，必须分开记：
`pin` = 技师在共享设备上自己输 PIN 打的；`app` = 用自己手机（已登录）打的；
**`desk` = 前台代打的** —— Desk-Only 的店天天在用这条路，
而「谁替谁打的卡」是劳资纠纷里第一个被问的问题，所以 `on_behalf_by` 必填。

打卡记录**只能补录不能删除**（触发器挡住 app_user，与财务记录同源）。

**⚠️ 班次存「营业日 + 墙上分钟」，不是 timestamptz。**

宪法第 8 条说时间存 timestamptz —— 那条针对的是**事件发生的时刻**（预约几点开始、
几点结账）。排班是**计划的墙上时间**：「Amy 每周二 10:00 到 19:00」在 DST 切换那天
依然是 10:00 到 19:00。烤成时刻的话，春季那天全店班次会集体偏移一小时，
秋季那天会出现两个 01:30，而这两种错都要到发工资时才被发现。

跨夜班（足疗店 18:00–次日 02:00）用 `end_min > 1440` 表达（1080 → 1560），
不用「结束比开始小」—— 后者分不清是跨夜还是录错了。
**工时**按真实流逝时间算（`shiftRealMinutes()`），DST 当天的跨夜班名义 8 小时、
实际 7 或 9 小时，`packages/scheduling` 有对应测试。

**合规提示字段**：`work_days` 上跑规则检查（加州 5 小时内餐休、周 40h 加班），产出 `compliance_alerts`。

---

## 5. 顾客

```
customers                id uuid pk,                      -- ⭐ 唯一凭证是 id，不是手机号
                         org_id, primary_location_id,
                         display_name,                    -- 展示用全名，不强拆
                                                          -- （越南姓在前 / 西语双姓 / 中文有拼音与汉字两版）
                         first_name, last_name,           -- 仅供 CSV 导入与排序，可空
                         phone_e164, email, locale, gender, birthday,
                         notes, tags text[], vip_level,
                         marketing_sms_opt_in, marketing_email_opt_in,
                         no_show_count, late_cancel_count, blocked_at, blocked_reason,
                         -- blocked_at 仅由人工操作触发（如安全事件），系统不因爽约次数自动封禁
                         source(walkin|web|phone|ai|import), merged_into_id
customer_preferences     customer_id, preferred_staff_ids[], avoid_staff_ids[],
                         preferred_gender, temperature, allergies(jsonb), free_notes,
                         profile(jsonb)   -- ⭐ sticky 落单要素的长期默认，按 option key 存
                                          -- 如 {"pressure":4,"focus_areas":["neck","upper_back"],
                                          --     "avoid_areas":["lower_back"],"shape":"almond",
                                          --     "color_ref":{"brand":"OPI","code":"N45"}}
                                          -- 结构由 service_option_defs 定义，见 §3.1
customer_photos          id, customer_id, url, kind(nail_art|before|after|reference), consent_id, taken_at
consents                 id, customer_id, channel(sms|email|photo|treatment), purpose,
                         granted(bool), text_version, granted_at, ip, user_agent, source
customer_notes           id, customer_id, author_id, visibility(front_desk|staff|manager), body, at
incident_reports         id, location_id, customer_id, reported_by, severity, body, at   -- 安全事件
```

### 身份与去重：手机号不是唯一键 ⭐

夫妻、母女、一家人共用一个手机号在这类店里非常普遍。所以：

- **唯一凭证 = `customers.id`。** 手机号只是**查找键**，不建唯一约束。
- 弱唯一性只挡"同号 + 同名"的真重复录入：
  ```sql
  unique (org_id, phone_e164, lower(btrim(display_name)))
    where merged_into_id is null and phone_e164 is not null
  ```
- **前台录入流程**：输入手机号 → 若该号已有客户，**弹出该号下所有人让前台选**：
  「张女士 · 上次 8/2 · Amy／张先生 · 上次 7/14 · Linh／＋ 新建客人」。
  **默认不自动匹配第一个** —— 自动匹配会把妈妈的偏好、过敏、指甲照片挂到女儿头上。
- **同名同姓**（华人店里 5 个 "Amy Chen" 很正常）：所有客户列表一律显示 `姓名 · 尾号 ****5678 · 上次到店`。
- **匿名 walk-in**：允许 `phone_e164 = null` 的客户（只做一次的客人），事后可合并。
- **合并是命令**（`customer.merge`）：可撤销、有审计，历史工单跟着走，`merged_into_id` 留指针。

### 健康表 / 同意书（敏感，单独隔离）

```
form_templates           id, location_id, key, version, title(jsonb), schema(jsonb),
                         requires_signature, valid_days, published_at
form_submissions         id, location_id, customer_id, template_id, template_version,
                         answers_encrypted bytea,          -- 应用层信封加密
                         signature_url, signed_at, signer_name, signer_relation(self|guardian),
                         ip, user_agent, locale, expires_on
form_access_log          submission_id, user_id, at, reason   -- 读也要审计
```

> `answers_encrypted` 用应用层加密（密钥在 Worker Secret / KMS），DB 被拖库也拿不到健康数据。RLS 再限制只有 `customer.view_health_form` 权限可读。

---

## 6. 预约 / 等位 / 到店

```
appointments             id, org_id, location_id, customer_id, business_date,
                         starts_at, ends_at, status,
                         source(web|phone_ai|phone_manual|walkin|desk|repeat),
                         booking_channel_ref, party_size, notes,
                         deposit_payment_id, created_by, cancelled_at,
                         cancel_reason(duplicate_booking|walk_out|guest_changed_mind|input_error|no_show|other),
                         reminder_state(jsonb), idempotency_key
appointment_items        id, appointment_id, service_id, addon_ids[],
                         membership_id(技师, null=any/未定), is_request(bool),
                         resource_id, starts_at, ends_at,
                         price_cents_snapshot, duration_min, seq,
                         status(booked|in_service|done|no_show|cancelled),
                         overbooked(bool), overbook_reason,       -- ⭐ 软约束放行时必填
                         details(jsonb)                           -- ⭐ 本次落单要素（力度/部位/甲型…）
                                                                  --    结构见 §3.1，开单时从
                                                                  --    customer_preferences.profile 回填
appointment_item_blocks  id, item_id, resource_id, kind(active|wait), starts_at, ends_at
                         -- 处理时间拆段：染烫等待段、美甲泡脚/等干段
                         -- wait 段允许技师被复用；排他约束只建在 active 段上
appointment_links        appointment_id, linked_id, kind(couple|group)   -- 情侣/团体
walkin_queue             id, location_id, business_date, customer_id, requested_service_ids[],
                         requested_staff_id, joined_at, quoted_wait_min, status(waiting|called|seated|left),
                         called_at, seated_at, position
waitlist                 id, location_id, customer_id, service_id, staff_id,
                         window_start, window_end, notify_channel, status, created_at
```

**一个预约 = 多条 item**（多项目、多技师、多资源）。冲突检测在 item 级。

**约束强度按层区分**（对应 `01` §7.1）：

| 层 | 实现 | 可否覆盖 |
|---|---|---|
| 资源（房间 / 床 / 椅） | 数据库 `EXCLUDE USING gist` on `resource_id` | **不可** |
| 技师并发 | 应用层检查 `max_concurrent_appointments`，超出写 `overbooked = true` + 原因 | 可，前台选原因后放行 |
| 门店时段总量 | 应用层检查 `settings.capacity` | 可 |

> ⚠️ **不要给 `membership_id` 建排他约束。** 决策 17 默认允许超卖（客人到店泡脚等位是常态），
> DB 级硬拒绝会在上线第一天炸掉，而且前台看不懂那个报错。

---

## 7. 轮牌

```
rotation_policies        id, location_id, version, config(jsonb), effective_from
rotation_participants    location_id, business_date, membership_id, in_rotation(bool), note
                         -- ⭐ 店长/老板可 is_bookable 但 in_rotation=false（只接点钟，不吃 walk-in 轮）
                         -- 按营业日存：今天人手不够老板下场、明天又不下，是天天变的
rotation_events          id, location_id, business_date, membership_id, delta numeric,
                         reason, ticket_id, appointment_item_id, actor_id, at, note
rotation_state           location_id, business_date, computed(jsonb), computed_at   -- 物化缓存
```

`config` 举例：

```json
{
  "turn_value_mode": "by_amount",
  "amount_tiers": [{"max_cents": 3000, "turn": 0.5}, {"max_cents": null, "turn": 1}],
  "request_counts_as_turn": false,
  "skip_reinsert": "same_position",
  "owed_turn_priority": true,
  "reset": "daily"
}
```

---

## 8. 服务单 / 收款（ticket）

```
ticket_groups ✅          id, org_id, location_id, business_date, label, created_by, created_at
                         -- ⭐ 一起来的一组客人。每人各一张单，用组串起来
tickets                  id, org_id, location_id, business_date, customer_id, appointment_id,
                         group_id,                     -- ⭐ null = 单独来的（绝大多数）
                         status(open|in_service|ready_to_pay|closed|voided),
                         opened_at, closed_at, opened_by, closed_by,
                         subtotal_cents, discount_cents, tax_cents, tip_cents,
                         service_charge_cents, total_cents,
                         tip_policy_version, comp_plan_version,
                         void_reason(duplicate_booking|walk_out|guest_changed_mind|
                                     input_error|paid_externally|other),
                         voided_at, voided_by, void_note
ticket_items             id, ticket_id, kind(service|addon|retail|gift_card|package_redeem|fee),
                         ref_id, name_snapshot, qty, unit_price_cents,
                         discount_cents, tax_cents, total_cents,
                         started_at ✅, finished_at ✅,   -- ⭐ 技师点开始/完成（Phase 1c）
                         duration_min, seq,
                         details(jsonb)      -- ⭐ 结账时的最终快照（加钟改了力度/加了款式也在这）
ticket_item_staff        ticket_item_id, membership_id, role(primary|assistant),
                         minutes, weight     -- 双技师/助理/接力
payments                 id, ticket_id, method(cash|card|external),
                         amount_cents,                 -- ⚠️ 含小费，与刷卡机小票上的数一致
                         tip_cents, processor_ref, terminal_ref, at, taken_by,
                         tendered_cents ✅,             -- ⭐ 客人递过来多少现金
                         change_cents ✅, keep_change ✅, -- ⭐「不用找了」→ 找零转小费
                         group_payment_id ✅,           -- 一笔钱付一组单时，各单各留一行共用此 id
                         payer_ticket_id ✅             -- 掏钱的是哪一位
refunds                  id, ticket_id, payment_id, amount_cents, reason, at, by, approved_by
discounts                id, ticket_id, ticket_item_id, kind(percent|amount|coupon|promo),
                         value, coupon_code, reason, applied_by, approved_by
taxes                    location_id, kind, rate_bp, applies_to(service|retail)
```

**注意**：`tip_cents` 与 `service_charge_cents` 分离（法律上完全不同的东西，见 Discovery §3.2）。

### ⭐ 一组客人：合并付款还是各付各的（Phase 1b）

一起来的几位，**到掏钱那一刻才知道是谁请客**。所以：

- **每人各一张单**，永远不合并成一张。提成、小费、轮牌全部按人次算，
  合成一张之后就再也拆不回去了。
- 归组（`ticket.group`）对**已经开着的单**也能用 —— 「我请客」是在结账台说的。
- 各付各的：照常一张张 `ticket.close`，什么都不用改。
- 一人付全部：`ticket.closeGroup`。折扣与小费按各单金额用最大余额法摊，
  再用 `distributeBuckets()` 把实际收到的现金/刷卡额**填**进各单。

  两个精确性必须同时成立，而按比例摊只能保住一个：
  **每张单收到的钱**要正好等于它自己的金额（否则某人的营业额被静默改了），
  **每种支付方式的合计**要正好等于实际收了多少现金（否则打烊点钞对不上）。
  所以不摊，用整数桶填充：现金先冲抵前几张单，用完了刷卡顶上，
  前台也解释得清（`packages/payroll/src/split.ts`）。

### ⭐ 现金实收与「不用找了」（Phase 1b）

客人给 $100 做 $85 的活儿，说「不用找了」。那 $15 **必须落成小费**：
不记的话打烊点钞会平白多出 $15，而老板唯一能怀疑的对象是前台。

DB 层有 `payment_change_consistent` 约束兜底：`keep_change` 为真时找零必须是 0；
记了实收就必须够付。

### 流程必须走完，再决定去向 ⭐

顾客是付现金还是刷卡，**很多时候要到结账那一刻才知道**，所以「开单 → 加项/加钟 → 结账」这条链路不能跳。结账页选定支付方式后，前台有两条出口：

| 出口 | `status` | 结果 |
|---|---|---|
| **正常入账** | `closed` | 进营业额、进日结、进提成与小费结算 |
| **作废** | `voided` | 必选 `void_reason` + 备注。**记录保留不删**，但不计入营业额、不计入日结（宪法第 9 条） |

### 审计：留动作，不留金额 ⭐

`audit_log` 对 ticket / payment 相关命令**只记录 `command / actor_id / entity_id / at`，不写入 `before`/`after` 的金额字段**。字段级脱敏名单：

```
tickets.subtotal_cents / discount_cents / tax_cents / tip_cents
tickets.service_charge_cents / total_cents
ticket_items.unit_price_cents / discount_cents / total_cents
payments.*  /  refunds.amount_cents  /  discounts.value
```

折扣、作废、退款这些**动作本身照常留痕**（谁、几点、什么原因），只是不留金额快照。

> 代价说清楚：这会削弱 `04` §6 里"老板查谁改了金额"的防内盗能力。折中做法是——老板端报表仍然能看到**当前**的折扣率、作废单数量与现金差异（这些从 `tickets` 实时算，不依赖审计快照），只是失去"改动前是多少"的历史。这是明确的取舍，不是遗漏。

---

## 9. 小费与提成

> **Phase 1b 已落地**：标 ✅ 的是实际实现。

```
compensation_plans ✅     id, org_id, location_id, membership_id(null=门店默认),
                         version, config(jsonb), effective_from, created_by
                         -- config = @gf/payroll 的 CompensationPlan：
                         --   kind(commission|hourly|commission_vs_hourly|booth_rent)
                         --   rateBp, categoryRateBp{}, retailRateBp, hourlyRateCents
                         --   base(net|gross)   ← 折扣算谁的，必须显式选
tip_policies             id, location_id, version, config(jsonb), effective_from
tip_allocations          id, ticket_id, membership_id, amount_cents,
                         basis(jsonb),          -- 可读的计算依据
                         source(card|cash), policy_version,
                         reversed_at ✅, reversed_by ✅,   -- ⭐ 作废时冲销，不删除
                         created_at
earnings ✅               id, org_id, location_id, membership_id, business_date,
                         kind(commission|tip_cash|tip_card|hourly|adjustment),
                         amount_cents, base_cents, ticket_id, basis(jsonb),
                         plan_version, reversed_at, reversed_by, created_at
```

`earnings` 是门店经营记录与员工收入**估算**的事实来源。GenieFront 不创建工资批次、
不标记工资已支付，也不连接银行执行代发；老板端按最近 14 天实时汇总，实际工资由店家自行处理。

`tip_allocations.basis` 存人类可读结构，例如：
```json
{"rule":"by_active_minutes","my_min":50,"total_min":80,"level_weight":1.2,"share":0.66}
```
技师质疑时直接展示，这一条能省掉大量前台纠纷。

### ⭐ 提成引擎的三条硬规则（`packages/payroll/src/commission.ts`）

1. **小费永不进提成基数**。tip 在法律上不是门店收入，对它抽提成
   等于雇主占有小费 —— 和 `house_cut` 恒为 0 是同一条红线。
   引擎的输入类型里压根没有小费字段，调用方无从传入。
2. **提成基数是折后还是原价，必须显式选**（`base: net | gross`）。
   折扣算谁的是真店里的头号争议，不给默认值糊弄过去。
3. **多技师共做一个 item，营业额按「分钟 × 角色权重」分摊**，
   不是每人各算一遍全额 —— 后者会让一单产生 1.3 倍的提成支出，
   老板要到发工资那天才发现。

**保底（`commission_vs_hourly`）取提成与时薪的较大值，不是相加**。
相加是租椅或「时薪 + 小提成」结构，那是 Phase 2 的事。
小费永远不参与保底比较 —— 拿小费冲抵最低工资是违法的。

### ⭐ earnings 在结账那一刻写死，不事后重算

提成率和小费策略都会被改。改完再回头重算历史，
**技师当天看到的数字就会和月底工资单对不上** —— 那是最伤信任的一类 bug。
所以 `ticket.close` 当场落 `earnings`，方案版本号一并快照。
作废时写 `reversed_at` 冲销而不是删除（宪法第 9 条）。

---

## 10. 日结 / 现金

> **Phase 1b 已落地**。

```
day_closes ✅             id, org_id, location_id, business_date,
                         status(open|counted|closed),
                         opening_float_cents, closing_float_cents,
                         count_breakdown(jsonb: 面额→张数), counted_cash_cents,
                         expected_cash_cents, cash_variance_cents, cash_variance_reason,
                         card_terminal_cents,      -- 前台照着刷卡机 batch total 敲（含小费）
                         card_expected_cents, card_variance_cents, card_variance_reason,
                         gross/discount/net/tax/tip_cash/tip_card_cents,  -- 封账时快照
                         note, counted_by, counted_at, closed_by, closed_at
cash_movements ✅         id, org_id, location_id, business_date,
                         kind(opening_float|cash_drop|supply_purchase|
                              tip_payout|payout_owner|other),
                         amount_cents(正=进抽屉，负=出), note, tip_payout_id, actor_id, at
tip_payouts ✅            id, org_id, location_id, business_date, membership_id,
                         owed_cents, paid_cents, carry_in_cents, carry_out_cents,
                         bills(jsonb: 数了哪些面额), acknowledged, note, paid_by, at
daily_summaries          location_id, business_date, gross_cents, ... （规划中，
                         当前由 day_closes 的快照字段承担）
```

### 设计立场：不追求「不许差」，追求「差额有出处」

前台每天摸几千块现金，账实差几十块是常态。系统的价值不是拒绝差异，
而是让差额能说清楚：差在哪一步、谁经手、当时写了什么原因（`04` §6）。

- 现金差异 ≥ **$2** 才要求写原因（`VARIANCE_REASON_THRESHOLD_CENTS`）。
  再小是硬币找零的正常磨损，天天弹框前台会开始乱填。
- **刷卡差一分就要解释** —— 刷卡没有磨损，差了就是漏单、重复刷或退款没记。
- **封账前必须已经点过钞**（DB 约束 `day_close_needs_count`）。
  「封了但没数」是最没用的一种日结。
- 封账后当天的单不能再开、再改、再作废（`assertDayOpen`），
  封错了要走 `dayclose.reopen` 并留原因。

期望现金 = 备用金 + 现金收款（含小费）+ 现金进出净额 − 已发的现金小费。

> ⚠️ `opening_float` 那条流水**不计入**「现金进出净额」——
> 它已经作为起始额进了公式。两边都算就是把备用金数两遍，
> 症状是每天的差异恰好等于备用金，而前台会以为自己多收了钱。

### ⭐ 现金进出条目全部可选（决策 19）

决策 19 说「不记录店内琐碎零钱流水」，指的是**不逼老板记流水账**。
所以一条不填也能完成日结；但只要填了，就一定进期望现金的计算 ——
填了却不算，比不填更容易对不上。

### ⭐ 现金小费发放：数钞票 + 零头结转

打烊时按人列出「今日现金小费 + 昨日结转 − 已发」，**默认发到整元**，
每人给出要数的面额清单（`$20 × 1  $10 × 1  $5 × 1`），发不出的零头结转到明天。

欠 $37.60 就给 $37、记着六毛 —— 这不是我们发明的，
这是前台本子上原本就在记的东西。发放同时自动记一笔 `tip_payout` 现金出账，
点钞时才对得上。

DB 约束 `tip_payout_balances` 钉死：`owed = paid + carry_out`。

---

## 11. 会员 / 套餐 / 礼品卡 / 忠诚

```
packages                 id, location_id, name(jsonb), items(jsonb), price_cents, valid_days, active
customer_packages        id, customer_id, package_id, purchased_ticket_id, remaining(jsonb),
                         expires_on, status
customer_plans           id, location_id, name(jsonb), price_cents, interval, credits(jsonb), rollover_max
                         -- ⚠️ 原名 memberships_plans，与员工身份表 memberships 撞名，已改名
customer_plan_enrollments id, customer_id, plan_id, status, current_period_end, credit_balance(jsonb)
gift_cards               id, org_id, code_hash, initial_cents, balance_cents, issued_at,
                         issued_location_id, expires_on(null), recipient, purchaser_ticket_id, status
gift_card_txns           id, gift_card_id, ticket_id, delta_cents, at, by
loyalty_accounts         customer_id, points, tier
loyalty_txns             id, customer_id, ticket_id, delta, reason, at
```

> 礼品卡**跨门店通用与否**是连锁的必答题；`org_id` 级发行 + `redeemable_location_ids` 控制。
> 未兑付余额（breakage）要能出报表，涉及各州无人认领财产申报。

---

## 12. 零售 / 库存（轻量）

```
products                 id, location_id, name(jsonb), sku, price_cents, cost_cents, taxable, active
inventory                product_id, location_id, on_hand, reorder_point
inventory_moves          id, product_id, delta, reason(sale|receive|adjust|use), ref_id, at, by
```

---

## 13. 通讯

```
message_templates        id, location_id(null=平台默认), key, channel(sms|email),
                         locale, subject, body, version, active
message_threads          id, location_id, customer_id, channel, last_at
messages                 id, thread_id, direction(in|out), channel, template_key,
                         to_addr, body, status(queued|sent|delivered|failed|opted_out),
                         provider_ref, error, cost_cents, sent_at
suppressions             org_id, channel, addr, reason(stop|bounce|complaint), at
call_logs                id, location_id, from_e164, customer_id, direction, duration_s,
                         handled_by(ai|human|missed), recording_url, transcript_url, outcome, at
```

---

## 14. AI

```
ai_sessions              id, location_id, actor_membership_id, surface(desk|phone|owner),
                         started_at, ended_at, model, token_in, token_out, cost_cents
ai_messages              id, session_id, role, content(jsonb), at
ai_tool_calls            id, session_id, command_name, input(jsonb), proposed_at,
                         confirmed_by, confirmed_at, executed_at, result(jsonb),
                         status(proposed|confirmed|executed|rejected|failed|undone)
```

AI 的每一次写操作都能追到人、追到命令、可撤销。

---

## 15. 合规 / 审计

```
audit_log                id, org_id, location_id, actor_id, actor_kind(user|ai|system|api),
                         command, entity_type, entity_id,
                         before(jsonb), after(jsonb), ip, at, undo_of_id
                         -- append only（强制方式见下）
                         -- ⚠️ 金额字段在字段级脱敏名单里，不写入 before/after（见 §8）
sanitation_logs          id, location_id, resource_id, task_key, business_date,
                         performed_by, performed_at, method, photo_url    -- 足浴盆消毒等
compliance_alerts        id, location_id, kind(meal_break|overtime|license_expiry|min_wage),
                         subject_id, severity, detail(jsonb), resolved_at
dsar_requests            id, org_id, customer_id, kind(access|delete|opt_out), status, due_on, handled_by
retention_policies       org_id, entity, keep_days, action(anonymize|delete)
```

**append-only 要真的强制，不能只写在文档里：**

```sql
revoke update, delete, truncate on audit_log from app_user;

create or replace function audit_log_immutable() returns trigger as $$
begin
  raise exception 'audit_log is append-only (attempted %)', tg_op;
end $$ language plpgsql;

create trigger audit_log_no_change
  before update or delete on audit_log
  for each row execute function audit_log_immutable();
```

迁移用的 `postgres` 角色可以 `alter table ... disable trigger` 绕过，所以
**`service_role` / `postgres` 凭据不进应用运行时环境变量**，只放在迁移 CI 的 secret 里（`01` §4）。

---

## 16. 关键索引与约束（别忘）

```sql
-- 租户前缀索引
create index on appointments (org_id, location_id, business_date, status);
create index on appointment_items (location_id, membership_id, starts_at);
create index on tickets (location_id, business_date, status);

-- 客户：手机号是查找键，不是唯一键（共用手机号很常见）
create index on customers (org_id, phone_e164);
create unique index customers_no_exact_dup on customers (
  org_id, phone_e164, lower(btrim(display_name))
) where merged_into_id is null and phone_e164 is not null;

-- ⭐ 资源容量：一间房可以同时服务多人多技师（Phase 1b 改）
--
-- 从 GiST 排他约束换成了计数触发器 —— 排他约束表达不了「最多 N 个」，
-- 而足疗房排 6 张躺椅、双人房两张床两个技师是常态，「一房一客」反而是少数。
-- ⚠️ 约束【强度】没变：仍在数据库层，前台带 reason 也覆盖不了。
alter table resources add constraint resources_capacity_positive
  check (capacity >= 1 and (max_staff is null or max_staff >= 1));

create trigger resource_capacity_guard
  before insert or update of resource_id, starts_at, ends_at, status, membership_id
  on appointment_items
  for each row execute function resource_capacity_guard();
-- appointment_item_blocks 同理（处理时间拆段后只算 active 段）

-- 触发器里先 `select ... from resources where id = ... for update`：
-- 排他约束原本免费提供的并发保证，换成触发器之后必须自己拿回来。
-- 不锁的话，两个前台同时排最后一个位置，各自都只看到 5 个占用，双双通过。

-- ⭐ 钱的自洽（Phase 1b）
alter table payments add constraint payment_change_consistent
  check ((not keep_change or change_cents = 0)
     and (tendered_cents is null or tendered_cents >= amount_cents + change_cents));

alter table tip_payouts add constraint tip_payout_balances
  check (paid_cents >= 0 and owed_cents = paid_cents + carry_out_cents);

alter table day_closes add constraint day_close_needs_count
  check (status <> 'closed' or counted_cash_cents is not null);
-- 差异超 $2 / 刷卡差任意金额，封账时必须有原因（见 sql/0009）

-- 财务记录只冲销不删除：app_user 的 delete 被 revoke + 触发器双重挡住。
-- 触发器只挡 app_user，不挡迁移角色 —— 能用 postgres 连库的人本来就能 drop table，
-- 对他们摆一道触发器不增加安全性，只会让开发机重新灌种子数据时卡死。
```

> **技师并发不建数据库排他约束**（决策 17 默认允许超卖）。技师层的 `max_concurrent_appointments`
> 与门店层的时段上限都在应用层检查，超出时写 `overbooked = true` + `overbook_reason`，前台可放行。
> **硬约束只留给物理资源** —— 按摩/足疗店靠房间数天然被卡住，美甲店靠技师软告警，两种业态各归其位。

---

## 17. RLS 模板

```sql
alter table appointments enable row level security;
alter table appointments force row level security;

create policy tenant_isolation on appointments
  using (org_id = current_setting('app.org_id', true)::uuid)
  with check (org_id = current_setting('app.org_id', true)::uuid);

-- 员工端只看得到自己的单（叠加策略）
create policy staff_own_only on appointment_items
  for select using (
    current_setting('app.role_scope', true) <> 'staff_self'
    or membership_id = current_setting('app.membership_id', true)::uuid
  );
```

---

## 18. 外部评价（Google + Yelp）

两个平台、两条采集路径，性质完全不同，所以必须能分辨：

| 平台 | 来源 | 拿到什么 | 何时 |
|---|---|---|---|
| **Google** | Bright Data | 完整评价正文，Top 50 | Phase 3 |
| **Yelp** | **Fusion 官方 API** | 权威 `rating` / `review_count`，**外加只有 3 条、正文截断到约 160 字**的摘录 | Phase 2（开店向导已经在用同一个 key） |
| **Yelp** | Bright Data | 完整正文 | Phase 3，视 Fusion 够不够用再决定 |

```
locations                +yelp_business_id, +google_place_id
                         -- 开店向导用店名 + 邮编在 Yelp 搜到店时一并存下，
                         --    之后抓评价、拉营业时间都靠它（搜索有配额）

location_reviews         id, org_id, location_id,
                         platform(google|yelp),
                         source(yelp_fusion|bright_data),   -- 怎么拿到的
                         external_id, rating, author_name, content,
                         is_excerpt(bool),   -- ⚠️ 见下
                         url, posted_at, scraped_at, status(new|replied|ignored)
                         unique (location_id, platform, external_id)

location_review_stats    id, org_id, location_id, platform, on_date,
                         rating_bp,        -- 4.4 分存 44000，不用浮点
                         review_count, fetched_at
                         unique (location_id, platform, on_date)

review_summaries         id, org_id, location_id, period_start, period_end,
                         coverage(jsonb),        -- 覆盖了哪些平台、各几条
                         latest_review_id,       -- 增量判断，没新评价就不调模型
                         summary_content(jsonb),
                         excerpt_ratio_bp,       -- 结论里有多少比例来自截断正文
                         generated_at, token_cost_cents
```

### `is_excerpt` 为什么必须有 ⭐

Yelp Fusion 的 `/reviews` 端点**只返回 3 条，每条正文截断到约 160 字**，经常断在半句话上。

把截断的半句当成完整评价喂给模型，它会对着被切掉的句子下结论 ——
"服务很好但是等了很久所以" 这种残句，模型可能读成负面也可能读成正面。
所以正文带 `is_excerpt` 标记，摘要提示词里显式告诉模型哪些是残缺的，
并把 `excerpt_ratio_bp` 存进摘要：**这个比例高的时候，老板端要提示结论仅供参考**。

### 为什么 stats 单独一张表

Fusion API 每天一次就能拿到准确的 `rating` 和 `review_count`，免费且稳定；
完整正文却要靠抓取，可能失败、可能被限流。

分开存之后，老板端的「口碑趋势」只依赖 stats，**抓取挂了不影响看分数**。
这也是为什么即使只有 3 条摘录，接 Yelp 依然值得 —— 权威分数本身就有用。
