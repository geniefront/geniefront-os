# 17 · 建站工单

> **批 8。** 我们**不做网站编辑器**（`01` §13）。定制官网走这条路：
> 店主填一张结构化需求单 → AI 出三版 → 老板选一版 → 人工精修 → 上线。
>
> 这一份定义那张需求单的**数据结构与状态机**。前端长什么样不在这里。

---

## 1. 为什么是工单不是编辑器

编辑器要做模板、拖拽、响应式、实时预览、发布、回滚、SEO、自定义域名、SSL 续期 ——
全都要做，做完店主还是做不出好看的东西。

工单的真正价值不是「省了编辑器」，是**它本身就是一张结构化的 prompt**：
第 3 节的 voice + 第 4 节的 sections + 第 6 节的自述，拼起来直接就能喂给模型。
竞品靠人做要 7 天，我们靠 AI 出初稿 + 人精修，目标 **48 小时**。

**默认层始终在**：没填工单的店，`book.geniefront.com/{slug}` 就是他们的预约入口，
设置里可复制链接和二维码。工单是升级路径，不是前置条件。

---

## 2. 状态机

```
draft ──submit──> submitted ──AI 90 秒──> drafted ──老板选一版──> chosen
                                                                    │
                                            人工精修 48h ───────────┘
                                                    │
                                                    v
                                                  live
```

| 状态 | 谁能改 | 说明 |
| :--- | :--- | :--- |
| `draft` | 店主 | 随便改，**不提交就不进我们的队列** |
| `submitted` | 只读 | 进队列。店主想改要先撤回 |
| `drafted` | 店主选 | AI 生成的三版摆出来 |
| `chosen` | 只读 | 人工精修中，SLA 48 小时 |
| `live` | — | 已上线，`public_url` 有值 |
| `withdrawn` | 店主 | 撤回，回到 `draft` |

⚠️ **`draft` 阶段一个字都不进我们的队列**，这条要在界面上明说
（竞品那句 "nothing goes to the team until you submit" 值得照抄）。

---

## 3. 表

### `storefront_briefs`

一店一行（`unique(location_id)`）。RLS 按门店收口，和其它业务表一致。

| 列 | 类型 | 说明 |
| :--- | :--- | :--- |
| `id` `org_id` `location_id` | uuid | 标配 |
| `status` | text | 见 §2 的六个值，check 约束 |
| `current_site_url` | text | 现有网站，可空 |
| `has_no_site` | bool | 「还没有网站」勾选 |
| `pain_points` | jsonb | 痛点数组，见 §4 |
| `pain_free_text` | text | 自由吐槽。**问的是「要避开什么」不是「要什么」** |
| `audience` | jsonb | ⭐ 客群数组，竞品没有，见 §5 |
| `top_questions` | jsonb | ⭐ 客人最常问的三件事，竞品没有，见 §5 |
| `brand_primary` `brand_accent` | text | `#RRGGBB` |
| `voice` | text | `warm` / `luxury` / `modern` / `traditional` |
| `reference_sites` | jsonb | 参考站点 URL 数组 |
| `sections` | jsonb | 要哪些区块，见 §4 |
| `usp` | text | 独特卖点 |
| `tone` | text | 想传达的调性，1–3 句 |
| `logo_key` `hero_key` `gallery_keys` | text / jsonb | Supabase Storage **私有桶**的 key |
| `submitted_at` `drafted_at` `live_at` | timestamptz | 各阶段时间戳 |
| `public_url` | text | 上线后填 |

### `storefront_drafts`

AI 生成的版本，一张工单多行。

| 列 | 说明 |
| :--- | :--- |
| `brief_id` | 外键 |
| `variant` | 1 / 2 / 3 |
| `content` | jsonb —— 每个区块的文案与结构 |
| `preview_key` | 截图存 Storage |
| `chosen_at` | 老板选中的那一版有值，其余为空 |
| `model` `input_tokens` `output_tokens` `cost_millicents` | 用量，整数毫分 |

生成走 `usage_events(kind='ai_assist')` 落账，和拍照开店同一套计价。

---

## 4. 照抄竞品的三组选项

**痛点**（可点即加的 chip，可多选）：
`poor_mobile` · `no_booking_entry` · `slow` · `dated_photos` ·
`unclear_pricing` · `not_in_search` · `template_feel` · `weak_brand`

**Voice**（四选一，每个都要写清会长什么样）：

| 值 | 界面上怎么说 |
| :--- | :--- |
| `warm` | 米色 · 衬线 · 私人诊所感 |
| `luxury` | 深底 · 金字 · 高端 spa |
| `modern` | 白底 · 无衬线 · 极简 |
| `traditional` | 大地色 · 手写体 · 中医感 |

**Sections**（勾选，取消勾 = 不显示）：
`hero` · `about` · `gallery` · `services` · `reviews` · `giftcards` · `faq` · `contact`

> `giftcards` 这一节只在门店**真的启用了礼品卡**（批 5）时才让勾，
> 否则会生成一个点进去 404 的购卡入口。

---

## 5. ⭐ 我们比竞品多问的两节

### `audience` —— 你的客人是谁

竞品问了痛点、调性、卖点，**唯独没问客群**。而客群直接决定首屏说什么：

`local_workers` · `tourists` · `seniors` · `insurance` · `chinese_community` · `members`

- 勾 `seniors` → 字号要大、电话要放首屏
- 勾 `chinese_community` → 中英双语首屏
- 勾 `insurance` → 要写「接受 HSA / FSA」

### `top_questions` —— 客人打电话最常问的三件事

华人店的官网真正决定成交的不是品牌调性，是三件事：
**停车怎么停、收不收现金 / 小费怎么给、会不会说中文。**

这三个答案直接变成 FAQ 区块。

> ⭐ **这一节可以不问老板。** 我们有 AI 通话记录（`phone_calls` + 转录）——
> 从他自己店里真实的来电里挖出最高频的三个问题，预填进去让他确认。
> 竞品有 AI Call Logs 但没把它接回建站表单，这是我们能做而他们没做的。

---

## 6. 命令与接口

| 命令 | 谁能调 | 说明 |
| :--- | :--- | :--- |
| `storefront.saveDraft` | owner / admin | 存草稿，可反复调 |
| `storefront.submit` | owner | `draft → submitted`，**校验必填**：店名、至少一个 section、usp 非空 |
| `storefront.withdraw` | owner | 撤回 |
| `storefront.chooseDraft` | owner | `drafted → chosen` |
| `storefront.publish` | **平台运营** | `chosen → live`，填 `public_url` |

生成那一步**不走命令总线**（模型调用要几十秒，塞进事务会占住连接）：

```
POST /v1/storefront/:id/generate      唯一的例外路由，同 blueprint/extract 的套路
```

只做编排，落库仍然是命令。

---

## 7. 定价

**明码标价，做成收入不是成本**：一次性 **$299** + **$19/月** 托管，年付套餐送一次。

免费送一定会做成拖累 —— 人工精修的时间必须有得花。
每一单工单都是正毛利，这条路才走得下去。
