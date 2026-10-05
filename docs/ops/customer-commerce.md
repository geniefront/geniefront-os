# 顾客商业功能：配置与运维

> 2026-10-05：全部代码与 37 个增量迁移已发布生产，现网迁移为 188；顾客商业收款全局开关及独立生产 webhook 仍未启用。详见[本次发布记录](2026-10-05-full-production-release.md)。下文阶段验收与“未发布”说明保留其当时状态，不代表现在的部署状态。

计划内本地实现与分层验收已完成，当前证据见 [A01–A22 最终验收](../qa/CUSTOMER_COMMERCE_ACCEPTANCE_2026-10-03.md) 与 [执行记录](../plans/2026-09-30-customer-commerce-implementation-log.md)。成功银行到账为未验证／用户豁免；生产未发布。下文注明迁移检查点的段落保留各批次操作记录，当前状态和复验方式以最终验收为准。

## 当前验收与复验

代码对应迁移链 188，A01–A22 的分层证据已收口。当前完整检查是 API 1,810、DB 127、非 DB 单元 1,378、浏览器 7、16 包类型检查，以及 web／booking／contracts 构建、guards 和迁移演练。正常收款／原路退款／续费使用实际 Stripe sandbox；并发与故障用真实隔离 DB 和 SDK 注入。成功银行提现及依赖它的实际自动到账仍为用户豁免／未验证。

`node --env-file=.env.local --env-file=.env.commerce-ci --env-file=.env.commerce-sandbox --import tsx scripts/commerce-e2e.ts` 复验当前保留库的真实样例。它从 evidence 中的资源 ID 读取原私有链接并取得新本机 QA Auth，不依赖历史临时 fixture 文件；只读、无 reset、无新增支付／退款，前后比较 10 张财务表。已过期或撤销的访问凭证应由有权限的店家按正常恢复流程处理，不能绕过访问限制。

同环境运行 `scripts/commerce-final-readonly-audit.ts`，检查当前原礼品卡、次卡、会员、定金与 A02 服务退款，并 retrieve 实际 sandbox PaymentIntent／退款。当前 payment 指纹为 `23:235c5b906f6520058e8a4c673c6a4a2a`，包含失败／过期尝试。不要重跑已结束样例的早期付款、核销或阶段 verifier；新演练另用新业务键。

后台与 booking 均可选择繁体中文，商业词条已有六语言。历史五语言 AI 健康摘要／分享沿用简中数据回退。新静态词典由 [OpenCC](https://github.com/BYVoid/OpenCC) 离线转换并通过完整性和页面检查，运行时无需安装转换库。

会员新销售开关保留测试前的关闭状态；管理员可以在“顾客收款”配置开启。关闭新销售仍可查看、履行、退款已有资产和管理原订阅。对 187／188 回退应用时须使用兼容当前结构的版本，保留账本和 provider 事实；不降级 SQL 或删财务数据。

## 配置

| 配置 | 用途 |
| --- | --- |
| `GF_CUSTOMER_COMMERCE_ENABLED=1` | 开放新商业订单命令；默认 0 |
| `COMMERCE_STRIPE_SECRET_KEY` | 可选独立顾客商业密钥。独立 sandbox 使用它；留空才复用平台 key，不修改 SaaS／AI 的 `STRIPE_SECRET_KEY` |
| `COMMERCE_STRIPE_MODE=test` | 必须与实际使用的顾客商业密钥 test／live 类型匹配 |
| `STRIPE_COMMERCE_WEBHOOK_SECRET` | 独立 Connect webhook 的签名密钥，不复用 SaaS endpoint 密钥 |
| `STRIPE_COMMERCE_ACCOUNT_WEBHOOK_SECRET` | 独立 v2 thin account 事件目的地签名密钥，不与 snapshot 支付 webhook 混用 |
| `COMMERCE_CONNECT_COUNTRY=US` | 新连接商户国家；在首次创建之前设置，商户详细身份和协议通过 Stripe 入驻流程确认 |
| `BOOKING_BASE_URL` | 顾客购买结果页所在来源；线上必须 HTTPS，本地允许 localhost |
| `BOOKING_PAGE_ORIGIN` | 公共预约允许的页面来源；本机预览固定为 `http://localhost:5296` |
| `BOOKING_MANAGE_PAGE_ENABLED=1` | 提供受保护的定金付款返回／管理页面 |
| `MANAGE_TOKEN_WRAP_KEY` | 服务端包装预约管理令牌的私有随机密钥；多实例保持一致，重启保留，不进入 artifacts |
| `APP_BASE_URL` | 店家 Connect 返回地址所在来源 |
| `GF_CUSTOMER_COMMERCE_WORKER_ENABLED` | 默认运行已有任务。关闭新销售不应关闭退款／付款事实处理；明确设置 0 才停 worker |

webhook endpoint：`POST /v1/stripe/commerce-webhook`。选择 connected account 事件；当前处理 `checkout.session.completed`、`checkout.session.async_payment_succeeded`、`refund.created/updated/failed`、`charge.dispute.created/updated/closed`、`account.updated`、`account.application.deauthorized`，以及下述付费会员账单／订阅事件。所有请求使用原始 body 验签，检查账户、业务域、模式和金额。

v2 账户状态目的地：`POST /v1/stripe/commerce-account-webhook`，选择 thin 事件 `v2.core.account.updated/closed`、`v2.core.account[configuration.merchant].capability_status_updated/updated`、`v2.core.account[requirements].updated`、`v2.core.account[identity].updated`、`v2.core.account[defaults].updated`。签名和 test/live 模式验证后，按服务端账户映射定位租户，再 retrieve 实际账户；事件载荷不直接授予收款能力。账户刷新事件按账户＋模式＋事件＋门店去重，支持多个已明确映射的门店分别刷新。

新开户使用 Accounts v2 merchant 配置，full Dashboard，`fees_collector=stripe` 和 `losses_collector=stripe`，不添加平台 SaaS 的 customer 配置、不代填身份声明或接受条款。既有 v1 映射默认保持 v1，刷新和入驻链接继续使用原接口；Checkout 和退款保留 connected-account 上下文。`scripts/commerce-sandbox-account.ts` 仅用 test key 建立隔离 QA 门店的真实测试账户，并把不含秘密的能力状态写入 artifacts；它不接受协议或伪造 active 能力。入驻链接过期会返回已认证前台并重新生成链接。

可复制 `.env.commerce-sandbox.example` 到忽略的 `.env.commerce-sandbox`，填入独立沙盒测试密钥，文件设为 0600；不要把密钥放进聊天、截图或 artifacts。网页端先切到沙盒，再在 Connect 选择“平台：商家将直接收款”。账号业务模式和条款由账号持有人确认；本任务没有启用生产收款。

门店 Stripe Connect 账户由服务端创建并映射到 org/location/mode。店家到“顾客收款”连接账户、刷新状态、开启销售；“商品配置”复用已有模板命令，可设置价格、面值／次数、期限、适用项目、范围、核销语义、提成与在线开关。仅有 `charges_enabled` 和 active `card_payments` 的关联账户可以新建线上订单。平台抽成默认 0。

顾客页：`/{slug}/shop`。成功返回页查询订单，不凭 Checkout redirect 声称已收款。邮件和浏览器保存的短效 token 仅能查询该笔订单；不得公开粘贴 token、完整卡号或二维码到日志／验收截图。

Stripe Checkout 的默认有效期与 15 分钟本地预约占位分开。省略动态 `expires_at` 参数以保持创建重试参数稳定；provider 的实际到期时间落库。本地过期／取消主动排入 expire 任务，若付款赢得竞争则处理已付事实并重新确认容量或退钱。

## 定金：当前 API／数据库子流程

迁移 158–171 提供限时占位、线下收款、公共线上付款、服务抵扣／退款、固定／百分比政策和不可变逐人报价。公共顾客结果与管理页已接定金状态，真实定金收款与原路退款已验证；前台原因化豁免及前台／顾客逐人取消已实现；语音待付定金 API／测试付款与前台收款已接入；待付部分变更和独立补款已由 187 实现，完整原生矩阵、全部入口和真实电话验收仍未完成；原政策下的明确保留决定已接 API／前台并验证实际余款退款。不要仅开启配置就宣称全部定金场景可用。

`commerce.holdAppointment` 需要预约权限、必填幂等键和永久 `businessKey`，载荷内的 `appointment` 复用既有预约 schema；超卖 override 仍要求独立权限。门店同时设置 `commerce.depositsEnabled=true` 与旧 `online_booking.deposit_required=true` 才可创建新占位，固定金额沿用 `deposit_amount_cents`；百分比使用 `deposit_percent_bps`，单位为基点，10000 为 100%。设置中两种方式互斥，定金不超过原服务合计。预约/资源实际被占用，独立定金状态为 pending，15 分钟到期由持久任务取消占用并保留历史；系统到期命令不对浏览器开放。

公共下单必须发送 `depositConsent={accepted:true,policyVersion,serviceTotalCents,amountCents}`。政策或金额变化时服务端拒绝整笔预约，顾客刷新并重新确认；前台启用逾期保留政策也需要显式同意。购买时的原政策、版本、同意时间与逐人金额不可变。

员工实际收到款项后，`commerce.recordOfflineDeposit` 记录 `holdId`、精确 `amountCents`、`method`（cash/card/external）与非空 `reference`。需要商业销售权限、幂等键和员工身份；只能确认仍有效的待付款占位。系统保存 commerce 订单／payment 和唯一 collected 流水，随后改成 paid 并排入既有预约确认通知。外部刷卡凭证不等于 Stripe 已验证线上付款。

公共预约启用定金时，创建预约和线上订单必须原子成功；账户和受保护管理页未就绪会拒绝整笔请求。员工可用 `commerce.startDepositCheckout` 为已有未过期占位建立同一笔线上订单。线上／线下渠道一旦锁定不能换成另一种付款事实。待付显示 pending，不发送已确认通知；只有实际支付和容量确认都成功才确认预约。

语音选中报价包含 `deposit` 时须取得明确同意，提交 `depositConsent` 并按 `status/bookingConfirmed` 判断；预约 ID 或 ok=true 不等于已确认。缺少邮箱／收款配置时转前台处理。有邮箱的未付请求使用 `appointment_deposit_pending`，`queued/captured` 不表示真实送达。后端付款后才确认，重放相同提交读取当前付款事实。外部模型工具须单独补充该 object 参数及明确同意提示词；当前仅保存仓库提示词，没有更新生产 agent。

前台详情的“记录已收到的定金”要求真实收款渠道与凭据；“准备支付链接”使用原占位；“发送定金说明邮件”要求顾客已有邮箱和操作原因。不能对已锁定线上支付的占位另记现金。占位未付时详情顶部、履约状态和下一步均显示待付，防止提前签到。

逾期／未到店后可通过 `commerce.retainAppointmentDeposit` 明确保留未用金额。需要 `commerce.retainDeposit` 员工权限、原同意政策、符合条件的取消客人、查看时的 `expectedGuestBalances`、金额与原因。按取消时的原时间判断；后续改期或当前配置不改旧依据。并发锁下重验，尚未批准的客人退款审核明确 declined，未保留余款重新 review；已提交退款不会被撤回。剩余有效客人的 booked／paid 状态保留，即使其定金份额为零。`retained` 与退款、抵扣是不同账本类型。

前台中断请求在发出前保存冻结输入与键到该浏览器会话；重新读取或挂载后只能恢复原结果，不能把新余额当成第二次保留。通知类型 `appointment_deposit_retained` 独立防重；仅真实送达才可宣称已通知。保留后的逆向处理和完整日结仍待实现，不能手工改不可变历史来退保留金额。

前台结账带出可用定金，勾选确认后用 `ticket.pay.depositApplication={holdId,amountCents}` 抵服务金额；不能抵小费、不能超可用余额，同一金额不再记为当天现金。$100 服务先付 $20 后新收 $80，服务价和提成基数保留。含定金的服务退款使用 `original_payment`，按原分配恢复定金，小费只退原现金／刷卡。恢复服务退款与退原购款是两个动作。

未用定金退款使用 `commerce.requestRefund` 与 `commerce.confirmOfflineRefund`：先预留可退金额，实际退钱后追加 refund 流水，不能改原 collected 行。取消使用购买时保存的截止时间：截止前自动申请全部未用金额，线上执行持久退款任务，线下仍需实际退款凭证。逾期和 no-show 进入前台核对，默认不罚没；退款失败释放预留并保留 review，可由有退款权限的员工再次申请。购买快照已保留逐人分摊。待付款项目／人数变更和独立补款按下方 187 重新报价流程处理；完整矩阵未验收，不要用手工改账本替代。

多人预约详情可勾选客人并执行 `appointment.cancelGuests={appointmentId,guestIndices,reason,expectedRefundCents}`，要求取消权限、非空原因和稳定幂等键。共享服务或同一组合单位必须一同取消全部参与客人；无法证明原客人对应项目或历史退款份额时先核对，不猜金额。剩余客人的项目价格、原政策和已付资金保留，被取消的项目释放容量并以只读历史显示。

截止前只预留被取消客人的未用定金，沿原 payment 退款；线下退款需要实际退钱参考号。逾期部分取消先保存 review 退款并继续预留，只能由有退款权限的员工带原因执行 `commerce.approveGuestRefund`，随后才创建 Stripe 任务或允许现金退还确认。失败的客人退款保留原失败记录、重新建立待审核预留，不把该客人的款放回另一位客人的服务抵扣。

顾客管理页通过原管理链接和手机号后四位执行 `/public/v1/bookings/:id/cancel-guests`，另传稳定 UUID `requestId`、所选客人、原因与精确退款报价；事务内重新核对 token、手机号和原截止政策。顾客操作以 `actor_source=customer`、空员工身份保存，不授予商业退款或其他顾客资产权限。服务抵扣与服务退款恢复都保存原客人资金份额，后续原路退款继续按原份额计算。待付定金只能取消全部剩余客人；部分修改当前要求先确认付款或批准豁免。

前台预约详情可批准定金豁免，必须有 `commerce.waiveDeposit` 权限及原因；默认 owner／manager。`commerce.waiveAppointmentDeposit={holdId,reason}` 要求稳定幂等键，只能豁免尚未收款、未过期的有效预约。豁免不是折扣或收款；服务全价继续待付。已收定金走实际退款，不能改为豁免。

豁免会停止原待付链接。若原支付已经在途，系统保存真实收款后全额原路退款，保留预约和豁免决定。退款失败进入核对，可授权重试；不要手工将该款改为可抵扣余额。购买金额、原政策和豁免原因不可改写。

管理页暂时加载失败会提供“重试”，无效或撤销的资源链接继续显示通用不可用信息，不披露其他顾客资料。

保持 worker 运行：到期清理无需 Stripe key，也不会因关闭新销售或 SaaS 欠费停止。Stripe 仅对 open Session 执行 expire，参见 [官方接口](https://docs.stripe.com/api/checkout/sessions/expire)。找回原订单 Session 后再处理外部过期；付款成功晚于释放会原子重新取得容量，失败则预留退款。本地占位到期不等于外部支付已取消。

## 当前销售与退款

- “记录已收到的款项”是线下现金或外部终端收款记录，必须填写实收金额、渠道和参考号。系统不把它描述成 Stripe 已验证扣款。
- 售卡订单、支付事实和资产发行在同一命令事务中关联。$80 售价／$100 面值分别保存；售卡没有虚拟服务工单。
- 礼品卡购买退款上限按未消费面值对应的实付比例计算。提交先预留对应余额，消费路径不能动用预留部分。
- 有限次卡按原价确定性分摊到整次权益；退款必须等于若干完整未用次数的价值。Unlimited 需要期限和限定服务，由有权限的操作员决定退款金额，累计不超过实付，退款成功终止该资产。
- 次卡购买退款处理中暂时冻结整张卡，拒绝并发退款和消费。新次卡记录原始执行单位的紧凑范围，核销、购买退款、恢复核销及再次核销都使用这些单位的原始分摊值；失败退回同一范围，防止恢复后重用已冲销单位。历史单位来源不明时进入核对，不猜测原始单位。
- `package.restore` 是撤销服务核销，需要退款权限、原因和幂等键。原始核销最多恢复一次；已结算服务单必须走服务退款分配，冻结或退款中的资产不能恢复。购买退款是另一个动作，不通过恢复核销退购买款。
- 线下退款先申请，再在实际退还款项后“确认已退还款项”并记录参考号。Stripe 退款等待 provider 成功事实后才冲销资产；失败释放预留。
- 旧 `giftcard.issue`、`package.issue` 和 `marketing.issuePackage` 已接到同一购买事务；需要 `channel`、永久 `businessKey`，以及线下凭证或赠送原因。不能传 `source=online` 冒充支付，也不再通过虚拟服务单发卡。自定义次卡价格／次数／期限需配置权限与原因。原有资产的消费保留。
- 无 metadata 的 Dashboard 外部退款和争议按账户／原 PaymentIntent 关联，冻结未用资产并列入待处理事项。争议胜诉释放冻结，迟到的旧事件不再冻结；败诉继续待处理。已确认的外部退款可由有退款权限的员工登记：只冲销剩余资产，不再向 Stripe 退款；超过剩余价值的事项保留冻结及人工核对。
- 既有消费退款与购买款退款分开。多来源服务退款、日结和统一报价尚须完成后续验收。
- 来源流水可查看礼品卡面值变化及次卡数量／实付分摊；未知历史次数价值不显示为已知现金价值。可撤销尚未结算服务的次卡核销，已结算服务须走服务退款分配。
- 挂失停止使用当前凭证并撤销旧查询链接；补发保留同一资产、余额和财务历史，旧卡号失效。只有退款权限的员工可操作，需原因及当前版本；重复操作不会增加价值。旧待发邮件停止发送，发送前再次验证凭证版本。
- 在购买记录展开“送达记录”可查看状态并带原因重新发送到原购买人／收礼人地址。测试捕获明确显示为测试记录，unknown/uncertain 不自动重试。顾客购买页可查询卡余额及二维码，查询不授予退款或客户资产权限。
- 若旧卡被额外赠送或人工增加面值，现金来源尚不能从旧账本准确分开。该卡的购卡退款需要核对；系统不会用新增赠送面值提高可退现金。P5 将补齐精确来源分配。

## 失败恢复

`commerce_tasks` 在数据库中认领，使用 `SKIP LOCKED` 和两分钟租约。外部网络调用在事务外，完成后由系统命令提交结果。重复任务使用固定 Stripe idempotency key。最大八次自动尝试后进入 review；不要删除订单或账本来“修好”失败。

支付已成功但未入账：先确认原 Session、connected account 和模式，再调用有权限的 `POST /v1/commerce/orders/{id}/reconcile`。同一对账实现也由数据库租约任务调用：先检索退款和争议，再补漏收的已支付事实，避免对已退钱的购买发资产。未付订单持续检查至过期；已付订单每小时复核，结算数据未可用时一分钟再查。全额退款且结算事实齐全后停止该任务。健康轮询重置错误次数；超过八次失败可在前台待处理区由有配置权限的员工带原因重试。

真实 SDK 获取 BalanceTransaction 后才记录 gross、fee、net、可用日期和支付发生时间。结算币种独立于原订单币种，不能混加换汇后的净额与门店原币服务收入。银行 payout 批次及日结汇总仍待 P5，不能把此处净额直接称为银行到账。

账户断开会禁止新线上销售并保留已付资产；这不会自动取消外部订阅。会员停用流程须按 P4 的独立生命周期处理。

## 隔离验证

```bash
node scripts/commerce-test-env.mjs
node --env-file=.env.commerce-ci scripts/commerce-test.mjs migrate
COMMERCE_QA_DATABASE=gf_commerce_stage_ci node --env-file=.env.commerce-ci scripts/commerce-test.mjs migrate
COMMERCE_QA_DATABASE=gf_commerce_stage_ci node --env-file=.env.local --env-file=.env.commerce-ci scripts/commerce-test.mjs test src/commerce.test.ts src/giftcard.test.ts
node --env-file=.env.commerce-ci scripts/commerce-migration-check.mjs
```

环境在 Docker 容器 `gf-customer-commerce-ci` 的本机端口 58332，凭据在忽略的 `.env.commerce-ci` 中。脚本拒绝常驻手工 QA 端口 55322。已有真实 sandbox 订单的 `gf_commerce_ci` 须保留：运行可重置测试时加 `COMMERCE_QA_DATABASE=gf_commerce_stage_ci`。可重置的 test／db-test／rebuild 默认使用 stage 库，脚本拒绝对 `gf_commerce_ci` 执行这些动作，即使显式指定也拒绝；`migrate` 可在保留历史的库做增量升级。迁移练习使用独立 empty/upgrade 数据库。

浏览器验证可运行 `commerce-browser-fixture.ts`，把已有 local QA Auth 身份映射到隔离业务库；不会重置真实 local Auth 用户或手工 QA 业务数据。然后以 `.env.local` 和 `.env.commerce-ci` 启动 `commerce-preview.mjs api|desk|booking`（3087、5297、5296）。这些预览默认 capture 邮件且仅绑定本机。

## 迁移、发布与回退

新增迁移从 `20260930154700_customer_commerce.sql` 开始，追加至 `20261002010907_customer_membership_discounts.sql`，位于 `packages/db/sql`，沿用 `_migrations`，当前共 175 条。空库和 151 条旧 schema 升级／重跑均已演练；先执行兼容的增量迁移，再发布应用。当前任务未发布 staging 或生产。

旧次卡 issue 货币和 redeem 次数的账本行不改写；生成列 `unit` 明确单位。新增独立次数账本，并捕获迁移时可用的规则。旧快照明确 `rulesProven=false`、`paymentVerified=false`，待核对，不伪造原购买合同或 Stripe 支付。模板以后修改不改变新售资产快照。

回退以关闭新销售入口及回退兼容应用为主，保留订单、支付、退款和所有账本。不得删表、清余额、清 webhook 去重记录。完整 A01–A22、真实 sandbox、订阅生命周期和财务验收通过前不得切换生产收款。

## 付费会员：首款、权益计划与自助管理

顾客收款页的“付费会员”由 owner/manager 配置。每次编辑追加计划版本，已售订阅按购买版本继续履行。月／年是收费频率；权益可按月发放或每收费期发放，年付默认 12 个日历月。0 次仅用于已配置折扣的会员，不表示 unlimited。适用服务、折扣项目和提成口径必须明确。

“允许新增付费会员订阅”只控制新开通，与礼品卡／次卡新销售独立。关闭开关不会取消 Stripe 自动续费，不会移除已付权益。当前顾客入口为 `/{slug}/memberships`；付款前显示自动续费和不结转条款，顾客明确同意后进入本门店账户下的 Checkout。保存的资源链接使用 `#m/cm_…`，令牌不进查询参数，只允许读取和管理该会员；当前有效期 30 天，服务端支持到期／撤销校验，长期重新认证、入口续期和重发仍需完善。

管理按钮调用 `POST /v1/public/shops/:slug/commerce/memberships/:id/portal`，携带该资源令牌并提交 `{locale,businessKey}`；业务键必须为 UUID。服务端先私有授权，再在事务外核验实际订阅、Customer 和门店映射；SDK 调用前后复查令牌，其他订阅或账单混入同一 Customer 时拒绝开放。返回临时托管 URL，不保存或记录该 URL。门户可更换付款方式、查看原账单、期末取消和撤回取消；新销售关闭仍可管理，断开账户则提示门店处理并保留历史。

Portal 配置和 Session 均使用原连接门店的 `Stripe-Account` 上下文，Session 显式指定专用配置，不修改平台 SaaS 配置。门店第一份配置可能成为该门店默认配置。套餐／数量／身份修改和托管登录关闭，取消使用 `at_period_end`／`no_prorations`。不要用平台账户的配置 ID 创建 direct merchant Session。

迁移 173 保存 `scheduled_cancel_at` 与 `provider_cancel_at_period_end` 原始事实；未知历史值为 NULL。effective `cancel_at_period_end` 同时识别传统 flag，以及 flexible 订阅的 `cancel_at` 精确等于已付期末；不以原始 flag=false 认定没有取消。其他取消日期单独展示。已付权益保留原有效期，取消／撤回不新增权益或现金。真实 signed subscription 事件同步状态；漏事件通过原订单 reconcile 从真实 SDK 恢复，不能手工补写支付或事件。

独立 Connect snapshot webhook 还需订阅 `invoice.paid`、`invoice.payment_failed`、`invoice.payment_action_required`、`customer.subscription.created/updated/deleted`，保留原 Checkout／refund／dispute 事件。只有 retrieve 核验的已付账单及 succeeded Intent 可以记现金和排权益；不能从 active 或返回页猜测支付成功。漏账单可经已有订单 reconcile 检查真实订阅账单。年付后续权益任务为 `membership_grant`，通过既有 DB 租约认领，未来批次在到期前不发放。

QA 夹具 `scripts/commerce-membership-browser-fixture.ts prepare|restore|discover|verify|portal-verify|reconcile|open-member [year] [stage]` 只允许 localhost、专用 58332 的保留库和 Stripe test key。月／年分别保存 0600 私有状态，已存在付款则拒绝再次 prepare；verify 和 portal-verify 只读真实支付及数据库事实，portal stage 为 canceled／resumed／method-updated／invoice-viewed；reconcile 调用已认证原订单接口；open-member 仅在私有运行时解包原资源链接。不要把该库用于 tests/rebuild；测试仍使用 gf_commerce_stage_ci。网页检查入口：左上角账号 → 切换到沙盒 → JAYSEN LABS LLC 沙盒 → Connect 子账户。当前网页已有 2 个启用的子账户。

已实测 $99 月付及 $999 年付首款、签名账单、一期一次权益与年付 12 个批次；真实 Portal 两轮取消／撤回、更换测试默认付款方式和原账单页面已验证。账单／收据下载按钮可见，本批未执行 PDF 下载。在立即终止验收前，原月付已用真实 Test Clock 验证自动续费、下一期拒付、恢复原付款方式支付同张失败账单及重复对账；最终累计 3 张 $99 已付账单，仍只有实际时间内一期权益可用。原年付年度自动续费成功，现有 2 张 $999 已付账单、24 批计划，当前仍只有一期可用。原已付服务核销／退回恢复与到期账本已实现并有浏览器／隔离验证；购买快照会员折扣已接；完整未来发放／漏跑矩阵、其他收银入口、认证失败 UI、下期换计划、期末自动终止矩阵、争议处理和长期安全入口仍未完成；A10–A13 未整项通过。生产发布继续关闭。

`scripts/commerce-membership-clock-fixture.ts` 复用原月付，不另开订阅；追加 `--year` 则操作独立保存的原年付及其时钟。模式按 `prepare → renew-boundary → renew-charge → verify renewed → fail-method → fail-boundary → fail-charge → verify failed → recover → verify recovered` 顺序执行；`reconcile` 后可 `verify reconciled`，`status` 只读观察。本次年付仅运行至成功续费及重复对账，未执行年付拒付。每次推进目标与稳定键私有保存，重试不会推进额外收费期。只使用官方测试 PaymentMethod，恢复绑定原失败周期 Invoice；恢复后禁止重新进入拒付阶段。应用／数据库真实时间不前移，所以虚拟未来付费批次仍等待真实 starts_at，不据此宣称未来发放验证完成。Stripe 时钟 30 天后自动清理关联测试对象，原财务快照与本地历史保存。原首款及门户校验要求单账单，现已成为历史证据；月／年最新生命周期事实改用 clock fixture，勿覆盖早先快照。

## 店长立即终止与原账单退款

在“顾客收款 → 付费会员”的原会员卡片打开“终止会员并退款”。默认 owner/manager 有 commerce.refund 权限；断网只读，关闭新增会员销售仍可处理原合同。先核对已付账单、已用／未用次数和未来批次，再选择收回全部未用权益，或保留核对时的当前已付权益周期。保留整周期的原价值从退款上限扣除，未来权益停止；不是自动按天按比例退款。

每张原账单单独输入本次退款金额，留空为不退款；累计成功／待处理／核对中的金额预留在原支付上限内。填写原因并勾选确认。内容发生变化需刷新重新核对。提交后先冻结，外部取消确认后才停止权益并提交原支付方式退款；取消状态与退款状态分别显示。不能把网页关闭、Toast 或订阅 canceled 当成已退款。退款失败保留原失败记录和终止状态；可带新原因核对后申请新的原账单退款，历史失败仍显示待核对。

网络结果未知时保留同一请求重试，重载仍沿用原输入及键，不新建另一退款。任务多次失败可在待处理区带原因重试；已取消的 provider 事实通过 SDK retrieve 恢复，不再次取消。对账持续检查待退款和缺失的 BalanceTransaction，即使订阅已 ended；后续退款会重新唤醒对账任务。出现争议或未知外部退款时冻结权益，原账单可退金额为零；会员外部退款的完整审核流程仍待完成，勿用普通售卡退款代替。

已终止会员的顾客页面仍保留原账单、退款金额和原权益流水。只有资源令牌仍有效且账户未断开／权益未冻结时开放受限账单 Portal；没有重新开启订阅按钮。终止后服务退款恢复原单位再追加到期事实，不能重新消费；服务退款与原购款退款仍是两个动作。

本批在原年付会员的两张 $999 账单上对第一张实际退 $500，并停止 23 个待发批次及收回 1 次；原 $49 次数／折扣会员实际全退 $49。两份真实 signed cancellation/refund 和结算证据见 p4-termination-*-sandbox.json。原 clock／service verifiers 是终止之前的历史快照，勿在终止后覆盖它们。当前改用 `commerce-membership-termination-fixture.ts prepare|verify|reconcile|replay|open-member year|discount`；prepare 只允许尚未终止的原实际购买，verify 只读核对实际 SDK、RLS、历史及签名事件，replay 复用网页命令凭证。私有链接、认证、命令准备状态仍保存在忽略的 0600 文件，证据不保存临时 Portal URL。无生产发布。

## 会员服务核销与退回

单客收银选择该客户的原已付周期，再勾选本次适用服务。已覆盖项目显示会员权益，另列本次新收款；小费仍按原服务价建议并由现金／刷卡承担。不得把未付、未来、过期、冻结的周期或其他客户次数用于结账；新销售关闭不会移除已付可用权益。组合套餐子项目不支持会员覆盖。

在订单记录中按“退回原权益与原支付来源”处理服务退款。部分金额退回先记录原项目分配，累积到完整覆盖才恢复一整次；恢复原单位、原提成价值与原到期日期，不新增现金、不延长期限。过期后退回保留 restore/expire 历史，可用次数仍为零。混合现金／刷卡部分沿用原退款来源。此操作不退会员购买账单，也不取消自动续费。

迁移 174 新增服务核销来源及不可变退回分配，原账本只追加；禁止给账本 UPDATE/DELETE/TRUNCATE 权限。周期发放任务同时处理已结束批次：历史漏跑批次不补发过期权益，当前已付批次仅发一次，并记录到期与去重通知。实际日历由 DB 时间决定，不能用 Stripe Test Clock 的未来日期强行开启权益。

本地 QA 可运行 `node --env-file=.env.local --env-file=.env.commerce-ci --env-file=.env.commerce-sandbox --import tsx scripts/commerce-membership-units-browser-fixture.ts prepare|open-desk|open-member|verify consumed|verify restored|verify-security`。夹具复用原付款会员，现有服务单 ID 已存于 0600 私有状态，重试不另造服务；付款／服务退款由实际收银页面完成，verify 模式只读。`verify consumed` 为退回前历史时点，已退回后只运行 `verify restored`；不要覆盖旧核销快照。`verify-security` 核对实际 app_user 权限与其他租户不可见，任何模式都不能对保留付款库执行 reset/rebuild。

## 购买快照会员折扣与价格记录

单客收银在次数覆盖后选择“付费会员折扣”，再选择优惠项目。金额取自服务端购买快照报价；项目、价格、原已付周期或版本变化时拒绝旧报价，需重新确认。没有剩余次数的已付会员仍可使用约定折扣，0 次方案不会被当成 unlimited。每行选择一种会员／普通价格优惠；已被次数覆盖的行不再打折。授权手工优惠只分到其他未覆盖且未选会员优惠的行，不可超出这些行的总金额。

迁移 175 的 ticket_price_adjustments 记录每项优惠来源与规则，只能追加。工单总折扣为会员及授权优惠之和；税以折后未覆盖服务计算，小费仍独立。次数权益按其购买提成口径，折扣服务按员工 gross/net 规则，纯折扣会员费不自动分入服务提成。退款沿原支付与权益来源，原优惠记录保留。收据中的“退回总额”可包括权益；会员权益退回与其他来源退回分别列示。

QA 初次准备／购买使用 `commerce-membership-browser-fixture.ts prepare discount`，实际网页完成 $49／1 次＋10% 的 sandbox 购买后运行 `discover discount`、`verify discount`；verify 是首次付款时点，在服务消费后不覆盖此历史快照。服务编排复用 `commerce-membership-units-browser-fixture.ts prepare --discount|open-desk --discount|open-member --discount|verify consumed --discount|verify restored --discount|verify-security --discount`，拥有独立 0600 私有状态和稳定命令键。实际收银／退款仍在网页完成；收银 $85 为本地现金 QA 记录。结束后运行原购买夹具 `restore discount` 恢复销售设置，不删除财务历史或退款该会员购款。

当前只完成这一批单客次数／会员优惠／授权优惠／现金组合；全部来源图、其他收银和完整日结尚未验收，不据此开生产收款。

## Payout 与原在线次卡验收（2026-10-02）

迁移 177 已在 empty/upgrade/stage 演练后增量应用于保留真实 sandbox 付款的库；不可改写该已推广迁移。新增账户级 payout 本金、SDK 状态观察和余额事务，强制 RLS、append-only。`payout_scan` 每页 20 条持久保存游标，完成整页后提交；`payout_reconcile` 持续追踪银行退回，长任务续租。店长「账户提现」只读查看，刷新只排对账任务。共享门店读取同一账户记录，不重复计算服务收款；manual payout 不猜付款来源。自动批次须全页完成且 count/net 与本金一致才显示已对账。

`scripts/commerce-payout-sandbox-fixture.ts probe|create|reconcile|replay|verify [original|success]` 仅用于专用本机库和原已确认 test merchant；新 payout 固定 $10、有稳定键和 0600 私有状态。`create` 保存过原 ID 后只 retrieve；创建重放仅在原创建后 23 小时内允许，避免依赖过期的 provider 幂等缓存。成功银行由商户在 Stripe 沙盒页面配置后，用 `discover-success-bank success` 只读核验，不能用 DB 余额或伪事件补验收。

本批原默认测试银行尾号 2227 是官方 insufficient_funds 样例，实际收到 payout.created/paid/failed/updated 的签名通知；当前 SDK failed，原扣款 -$10 和退回 +$10 均验证，没有新增顾客支付。成功提现和依赖成功提现的实际 automatic batch 原先未验收；2026-10-02 用户明确豁免其实际成功验证，现为“未验证／用户豁免”，不再要求更换测试银行。平台 API 添加外部银行曾返回 oauth_not_supported，未修改银行信息；保留历史失败／退回证据和对账实现。只在沙盒操作，不填写真实银行资料。[官方测试银行](https://docs.stripe.com/connect/testing#bank-numbers)。

`scripts/commerce-package-payout-fixture.ts` 保留一个真实浏览器 $500/10 次购买。`verify` 只验证首次发放时点，消费后不覆盖此历史证据。`prepare-service` 编排原顾客的 $100 服务，`edit-template` 只修改独立 QA 模板的后续价格/次数/服务/期限/范围/口径；`open-desk` 打开已有前台 session，实际核销和购买退款在网页完成。`verify-consumed` 保存剩 9 次、新增现金 0、原购价提成基数 $50；网页原路退未用 9 次/$450 后运行 `verify-unused-refund`，验证原 snapshot、genuine callbacks 和 refund balance；`reconcile` 再对原购款执行 3 次真实 SDK 对账。`restore` 仅恢复原销售开关，保留全部金融历史。

收银可用次卡读取购买快照的名称、服务和覆盖模式，并排除冻结资产；旧模板或门店设置变化不能改已售规则。公共购买页展示服务、次数、有效期及范围，原报价 hash 由服务端重算；未知购买响应保存原请求/键，已知条款变化要求重选。保护页显示累计已退款/处理中金额，持续刷新消费或退款变化，临时查询失败自动重试。已退款的剩余次数不当作新的可用权益。

本批证据见 [p1-payout-durable-acceptance.json](../../artifacts/customer-commerce/p1-payout-durable-acceptance.json)。次卡服务撤销/部分退款的原来源图、unlimited、跨店、完整日结/通知及其他全部阶段仍在实施，不能据此开生产收款。

SDK 退款/争议观察沿用验证适配器，内部 ID 以 `reconcile:` 开头并显式标记 sdk_reconciliation。它们是已检索事实的观察，不是签名通知；验收对照 evt_ ID 和 CLI 监听 HTTP 200，不能把全部 refund.updated 行数当作签名次数。历史内部观察保留。

### 原来源服务退款（本地／sandbox 178 检查点）

后台服务退款先显示返还去向，确认时重算原来源并验证预览版本。会员／次卡的服务覆盖金额与购买分摊价值分开；多次部分退款累计退完原服务覆盖后才恢复整次数。恢复仍遵守原有效期、终止状态、支付退款状态和挂失凭证，不能把已退款或已到期的购入资金变成可消费余额。预付来源不能通过服务退款转换为现金或新店内余额。

结果未知时使用弹窗或订单页的“重试已保存退款”。页面刷新保留原金额、原因、来源预览和幂等键；先解决这笔请求再发起其他退款。首次写入 HTTP 201、已执行请求重放 HTTP 200；判断以 `replayed` 和持久账本为准。认证、权限或限流拒绝一个未知请求的重试不证明原请求未执行，保留原请求后继续恢复访问。

`ticket_settlement_sources`、`ticket_source_receipts`、`ticket_source_refunds` 不允许 UPDATE／DELETE。旧工单只根据可解释的原支付／原核销创建 legacy projection；不明确的旧多单位核销需要人工核对。不要重置保留 sandbox 库，不要改已应用的 178 SQL；继续使用新迁移。验收记录见 `p5-source-acceptance.json`，该检查点不代表全部阶段完成。

### 按执行项目退回（本地／sandbox 179 检查点）

服务退款可选择原执行项目和各项退回金额，服务、税和费用沿原来源返回；小费需要另行明确勾选。不能选已全退项目或超出该项目原余额。一个次卡单位覆盖多个项目时，全部原覆盖退完才恢复整次。提成冲销使用原项目／技师／购入分摊金额，当前价格与税率变更不修改原结算。

旧工单缺乏可解释的原逐项提成、价格或核销事实时，“指定服务项目”不可用，保留有原来源依据的金额退款并提示核对。六张新增事实表不可更新或删除；179 已应用，不改写迁移。`scripts/commerce-item-return-fixture.ts` 仅允许专用本机验收库，复用原真实 sandbox 次卡，prepare 编排测试服务，verify-* 按阶段只读核对；各阶段证据不应在后续退款后重跑覆盖。`pay` 只是受限 API 编排能力，本批实际结算与退款均通过前台完成。现金部分为 QA 线下记录，不作为 Stripe 收款或退款证明。见 [p5-item-acceptance.json](../../artifacts/customer-commerce/p5-item-acceptance.json)。

### 结账报价与结果未知恢复（179 库、单客报价第 2 版）

独立 Checkout 显示“已核对的结账金额”后才可收款。提交时携带该报价指纹，价格或权益变更会要求刷新核对；首次报价不扣次数、不抵扣定金、不记收款。当前单客报价已包含所选礼品卡／店内储值、技师小费分配，原生独立页与 Queue 使用同一工作台；组单按以下流程核对。仍保留未带指纹的旧命令兼容，不能把当前实现视为所有历史入口均已验收。

收款超时／结果未知时，先用 Checkout 或 Queue 的“重试已保存收款”。即使工单已经消失在未结列表中，恢复入口仍可重放原请求。原金额、支付行、小费、报价及幂等键保存在当前浏览器 sessionStorage 的 membership 独立范围，重试不重新报价、不改为另一笔支付。不要在未知结果时清除浏览器数据。已明确拒绝的旧报价可刷新后重新确认；未知请求的权限／认证拒绝不证明原收款未执行。

`commerce-item-return-fixture.ts` 的 `quote`、`quote-retry` 第三个参数分别选取独立原生报价及响应丢失验收工单。`verify-quote` 比较真实 HTTP 报价前后账本；`verify-replay quote-retry` 对照原命令规范化 fingerprint、审计与唯一金融记录。仍复用同一原真实 Stripe 购买；历史阶段证据不可被后续状态覆盖。

### 队列内联收银工作台

Queue 的“结算收银出票”在原页面弹窗中打开固定工单，使用与独立 Checkout 相同的权益选择、报价确认与支付行。工单失效不会自动切到其他顾客。正在提交时禁止关闭弹窗；结果未知时先重试已保存请求，队列和弹窗共享保存状态。打印设置仍由门店控制。新版组单收款命令保存规范化金融请求指纹；同键换金额拒绝。

### 组单确认、逐客选择与恢复

Queue 或独立 Checkout 的“组单收银”先选择本次一起付款的工单。逐客打开“选择权益与小费”，选择原会员、次卡、定金、礼品卡或本人的店内储值；保存只保留选择，不扣资产。按技师录入的小费分配随选择保存。不同顾客的店内储值必须绑定各自工单，不得以付款顾客的余额默认为全组付款。

返回整组核对后选择现金、刷卡或外部收款通道；服务端按原服务、权益及税制计算金额并分配到各工单。整组额外优惠只能分配到仍可优惠的未覆盖服务。现金“找零转小费”增加到付款顾客，按其已选技师分配比例追加（原比例全为零时均分）；原小费选择保留。服务费与小费分阶段工单必须处于对应可结算阶段。最终确认一次事务结账，仍保留每人的项目、收据、提成和原来源退款。

结果未知时所有新单客／组单收款均等待恢复；刷新后在原页面“重试已保存组单收款”，只重放原输入和幂等键。服务端收到不同请求复用相同键会拒绝。既有无 fingerprint 历史凭证仍沿用原恢复行为，完整历史恢复审计尚待验收。

本地原生组单复用原已退款购买中的可用次卡 1 次和礼品卡 $30，另记 QA 线下现金 $180（含小费 $10）；确认、丢失成功响应、刷新重放及逐单退回已验证，未新增 Stripe 购买。`scripts/commerce-group-browser-fixture.ts` 仅允许专用本机保留库；`fill-gift` 与 `snapshot` 在内存处理已有凭证并遮盖输出，私有恢复文件不得提交。阶段性 `verify-paid` 证据不可在退款后重跑覆盖。完整币种／跨店、客户合并、日结及全部阶段矩阵仍在推进，见 [本批证据](../../artifacts/customer-commerce/p5-group-acceptance.json)。

### 日结、区间报表与跨日退回（180 库）

日结和业务数据页新增“顾客预付款”，按原币种分别显示礼品卡、次卡、定金和付费会员销售收款、购款退款、服务核销与资产退回。CSV 使用同一结构化汇总。店内预付现金进入钱箱预期，确认退回现金从钱箱扣除；店内终端／外部记账进入终端对账，Stripe 线上金额另列，不混入刷卡机 batch。Stripe gross／fee／net 按结算币种显示，银行 payout 作为独立转账列示，失败不等于到账。

服务退款恢复原资产，与“将服务退款转为新储值”分开。早期会员／定金使用原核销和退款账本，不依赖后来补建的来源图；缺少覆盖金额的旧次卡核销提示需要核对。有限次卡的次数与不限次合同数量分别统计，不把不限次消费计成负的剩余次数。余额是原账本口径，不替代有效期、冻结或预留校验，也不是完整会计收入确认。

新封账事件保存整份金额与预付款明细快照。支付平台迟到事实出现后，页面保留原封账金额并提供最新事实比较；授权重开后再按最新数据核对。未保存该明细的历史封账明确提示来源记录仍是当前查询。线下预付收款和现金退款与日结锁串行，当天已封账时先重开；平台异步确认仍可入账并触发差异提示。

180 允许后续营业日退款使用自己的逐笔退款凭证更新原单退款累计及追加资产／小费退回，不开放原项目、原价、支付行或封账快照修改。跨日小费按 earnings 的原业务日期与退款业务日期显示，避免全部退款后原日小费消失。实际跨日退款和封账／重开仅在隔离验收库执行；保留真实沙盒数据只做增量迁移与只读页面验证，九类金融表内容未变。

仍需继续核对普通服务收款跨营业日归属、更早历史期初余额、所有封账并发／时点、跨店与跨币种、Stripe 退款处理时刻与平台事实时刻、完整打印／多语言／离线及工资结转矩阵。此版本不表示 A19 或 P5 整项通过。见 [本批验收](../../artifacts/customer-commerce/p5-day-acceptance.json)。

## 顾客重复档案合并（181）

在客户页选中要保留的档案，通过“更多操作 → 合并重复档案”选择已确认属于同一人的原档案。核对源／目标后提交；系统保留原订单、预约、会员订阅、资产和账本的客户 ID，通过明确别名解析可用权益。共享电话／邮箱不自动合并。合并不能用来把不同人的金融资产转给另一人。旧姓名和电话仍可检索，详情列出关联原档案，旧档案链接提供前往保留档案的入口。

若提交后网络中断，刷新后使用“重试已保存的档案合并”，不要改源／目标后另提请求。原客户管理链接继续绑定原资源，合并不会新建 Stripe 订阅。核销与退款沿原权益及购买快照执行。已封账原记录不重写；此能力需要数据库迁移 181 与对应 API 同时可用。`scripts/commerce-merge-browser-fixture.ts` 只用于本机保留 QA 库，读取原月付样例且拒绝其他数据库；本批实际合并与核销已完成，禁止把 `prepare-target` 当成可反复合并的通用脚本。历史 `verify-merge` 是合并时点保留证据，服务核销后不再覆盖它。完整跨店／角色／并发矩阵仍按目标计划验收。

## 撤回保留的定金（182）

在预约详情的原保留记录下，选择“撤回保留并退款”。只有同时具备 `commerce.retainDeposit` 与 `commerce.refund` 权限且在线的员工可执行；核对仍保留金额，填写本次金额与原因。系统保留原决定，追加撤回凭证，并同时预留原付款退款。线上由 Stripe 原路处理；线下仍需在顾客收款中确认实际退钱，不把提交申请当作退款完成。未知响应通过“重试已保存的撤回”恢复，不更换金额／原因另提同笔申请。

历史显示每次撤回金额与关联退款状态。失败的退款不会重新恢复旧保留决定：确认失败后，释放的金额回到原定金可退款余额，可在原商业订单重新发起退款；仍不能累计超过原实收。保留与撤回日分别计入当日“保留定金净额”，实际退款在完成日列入退款，不能倒改原日或记成新增现金。通知走既有 outbox；本机 QA 使用 capture。

本次实际原 $20 定金已由 $12 部分退款和后续 $8 撤回退款完全退回。旧保留／部分退款样例文件是历史检查点；新验收使用 `scripts/commerce-retention-release-browser-fixture.ts` 与 [本批证据](../../artifacts/customer-commerce/p3-release-acceptance.json)，不重跑旧的 `refund` 或 `verify` 来制造相同状态。当前原商业支付指纹为 `14:99c54d5375794365efd655bf0a22cfda`，仅该付款的已全退状态发生预期变化。

## 会员账单的购入合同（183）

每张已付账单保存自己的计划版本、价格及权益快照。现有会员的核销、折扣、到期通知和周期页面从该账单读取规则；修改当前销售目录不改变已经付款的权益。会员查询短暂失败后可在原私人入口点击“刷新”，继续使用该资源令牌，不能另买一份会员来恢复查询。

183 回填在事务内暂停且恢复特定账单只追加触发器；若回填失败必须回滚整个迁移，不能手工跳过 NOT NULL 或删账单。`scripts/commerce-membership-invoice-upgrade.mjs` 只克隆专用 stage 库到独立演练库，须先运行会员集成测试生成已付历史；不可用于保留沙盒或生产库重置。下期换计划已通过后续 184 提供明确顾客确认和 Stripe schedule；不能通过直接改数据库快照或 Stripe 价格绕过。

## 会员下期换计划（184）

顾客在原保护管理页选择可售同币种计划，核对新金额、收费频率和下个收费周期日期后同意。安排成功不会立即扣款，当前已付权益继续按自己的原账单合同履行。下期实际付款确认后，新账单及权益使用批准的新合同；年付按月权益仍逐月到期发放，不因测试时钟或一次年费而提前可用。店家会员列表显示当前收费计划及待生效变更。

若提交响应丢失，保留页面保存的原请求并点击重试；不要改目标重新建立订阅。worker 的 membership_change 任务会用原业务键核查 Price 和 schedule，再持久绑定。数据库有请求而外部成功未绑定时，恢复流程验证原 schedule.created 事件的请求键；未知或别人管理的 schedule 进入拒绝／待核对，不得手工认领。已接受外部事实的绑定可在 SaaS past_due 时恢复；这不放开新销售或新换档。

184 已推广，禁止改写原迁移、会员开通 snapshot 或旧 invoice。当前真实验证覆盖原订阅月→月及月→年、丢响应重放、同一 schedule 复用、两笔实际测试续费和逐账单历史保护。待生效换档撤回已由后续 185 实现；期末取消和终止竞争仍在实施，不能把已验证换档当成完整取消矩阵。证据见 `artifacts/customer-commerce/p4-plan-change-acceptance.json`，测试通知仍 capture，无生产发布。

已确认排程的组织／会员／变更 metadata 或 phase 被外部更改时，恢复任务拒绝覆盖。应先核对外部变更与顾客已同意合同；不可把重试当成自动修复排程的操作。

## 撤回待生效计划（185）

在会员私有管理页找到待生效变更，确认保留当前计划及自动续费后点击撤回。页面显示“正在撤回”时，请等待 provider 核验；只有 Stripe 排程已释放、当前价格核对正确才显示已撤回。关闭新会员销售或软件欠费不应阻止此恢复操作。若响应丢失，刷新后重试已保存请求，系统会使用原业务键核对结果。撤回不退款、不取消当前订阅、不改变已付权益。

若排程被外部修改，任务拒绝处理并保留待核对状态；使用现有商业任务重试入口前先核对归属，禁止手动标记成功。若收费边界已发生，页面会显示变更已生效；需按现有合同处理后续换档或终止，不能自动按比例回滚。订阅 provider 已终止时，尚未生效的变更显示已取消；历史生效变更仍保留。

185 使用额外的 membership_change_withdraw 持久任务，安排／撤回／立即终止共享会员级事务锁。失败时保留请求和 provider 标识，不删除原记录，不创建替代订阅。当前真实证据为原年付订阅安排下年月付后撤回、丢失成功响应重放及无新资金变动；完整期末终止和外部竞争矩阵仍在实施。

## 换档后取消与期末终止的测试检查点

原真实测试订阅经过取消→恢复续费→再次取消，在原收费边界经 Stripe Test Clock 终止，历史账单保留，未新增扣款。此时只能查看原订阅和账单，不能把已永久取消的订阅作为可恢复续费对象。脚本 `commerce-membership-end-browser-fixture.ts` 验证原绑定及期末，禁止用于生产或替代订阅。

如果本地 webhook 未同步，先确认监听进程是否存在和 API 是否加载同一 signing secret；再使用原订单认证对账恢复，标明事件证据来源。不得把 SDK 对账记为签名 webhook。应用时钟未随 Stripe Test Clock 推进，因此完整日历发放／到期还需要隔离应用时钟验收。

原 30 天管理入口缺口已由后续 186 修复，已付账单延长未撤销凭据；过期／丢失／泄露后的恢复使用下方店家操作，不直接修改数据库期限或 token。

## 会员私有链接、停用与更换（186）

未付款开通请求的管理链接初始为 30 天。每张已确认付款的账单，将未撤销链接延长至已付周期结束后 30 天；重复事件不会另发凭据。已撤销链接不因续费恢复，付费权益和外部自动续费不受链接状态影响。迁移 186 为原已付账单执行相同回填，保留原凭据。

有 `commerce.configure` 权限的店家，在“客户收款 → 付费会员 → 会员私有链接”核对会员、登记邮箱、链接期限及状态。泄露链接使用“停用私有链接”；需要恢复时，核验身份及所示原会员登记邮箱、填写原因并确认“更换链接并发送给顾客”。更换立即使旧链接无效，新链接通过现有通知队列发送到所示邮箱。界面显示排队成功，不等于邮件已送达；按既有通知监控确认送达，测试环境只 capture。页面不提供明文凭据复制，命令响应和审计也不包含凭据。

请求响应丢失时，不改邮箱、会员或动作；刷新后重新打开同一会员面板并重试保存的请求。版本或邮箱发生变化，重新核对后再确认。两台前台按同一版本同时更换，最多一笔成功。已终止会员仍可恢复历史账单访问；此操作不恢复已终止的 Stripe 订阅。

顾客看到链接无效／到期／停用提示时，联系门店完成身份核验，使用新链接。同一浏览器打开替换链接也可恢复，并移除地址栏凭据 fragment。旧链接不可复用。凭据泄露后的停用和更换必须使用上述命令，不能清空 revoked 标记让旧秘密重新可用。数据库 rollback 保留访问版本、凭据和账目；回退兼容应用不会撤销已发生的凭据更换。

## Unlimited 购卡退款与未知请求恢复

Unlimited 的 0 次表示不限次数，能否使用仍取决于期限、冻结和资产状态。人工决定退款金额时以原实付及累计退款为上限，不按剩余次数折算。购卡退款成功会终止所有剩余使用权，即使仅退部分金额；店家必须勾选明确确认。原服务退回不能让已终止或已退款权益重新可用。顾客私有结果页显示服务端可用状态和门店时区期限。

购买退款表单保存本次订单、金额、原因、确认和业务键。响应丢失后刷新页面，先重试已保存请求；不要另开相同退款。线下退款仍须单独确认已退钱并记凭证，申请成功本身不等于钱已退回。日结分开列售卡现金与服务抵扣／退回，不能再次把权益消费计为收款。

本地 Unlimited 样例记录现金 $500，分 $200／$300 退回，均为测试记账凭证；没有真实纸币观察或 Stripe 支付。该 Unlimited 检查点保留测试库为 17 笔商业付款，原 16 笔仍保留。旧 16 笔整体校验脚本属于历史检查点，不能在新付款存在后套用总行数断言。


## 待付定金预约改期

同价改期保留原定金金额、政策、支付链接及付款截止时间。改期不重新计 15 分钟；截止后须按已过期预约流程处理，不能先占新时段等待后台清理。顾客用原管理链接及手机号后四位修改时间；前台同样走预约改期。两者都更新待付定金邮件，明确预约仍未确认，旧邮件保留历史；最终以管理页当前时段为准。系统只在收到实际付款事实后确认改期后的预约一次。

当前原生样例已在同一 $20 Stripe 测试订单付款；手续费 $0.88、net $19.12。保留库当前 18 笔，原 17 笔内容不变。实际邮件只 capture，非外部投递。项目／人数变化后的重新报价及独立补款由下方 187 提供；本段只证明同价改期样例，不代表后续金额变更的全矩阵。证据见 [待付改期验收](../../artifacts/customer-commerce/p3-pending-reschedule-acceptance.json)。


## 订金重新报价、补款与多来源退款（187）

前台预约抽屉的“加项目”“更换预约项目”以及待付款逐人取消，在金额变化时先返回服务器报价。页面展示新服务总价、原政策要求的订金、当前可用已付款、独立补款及可退多收金额；取得顾客同意后确认原报价。报价已变时重新确认。不会静默再次扣卡，也不会把多付金额转为小费。历史项目保留为已取消，待分配技师和改期默认只选择当前项目。

原 hold 的金额、订单和政策快照不改写。`commerce_deposit_requotes` 保存批准后的新报价；`commerce_deposit_requests` 保存原请求、替换请求和独立补款。未付预约改价会关闭旧请求；旧链接后来付款进入原路退款，不能将新报价标为已付。已确认预约新增补款仍保持确认；补款超时只关闭补款，不释放原预约。零订金的新报价可明确确认，不伪造付款。

“重新计算订金”可显式选择线上或线下请求及原因；“退回多收订金”按原政策要求的订金计算上限，并分配到原付款来源。线下补款必须核对当前请求金额、支付渠道和外部凭证。未知响应保留原命令键和参数；刷新后使用保存请求重试，不能另点一次制造新业务。已完成服务不再接收新补款；迟到付款退回其原来源。

每笔抵扣记录具体 `deposit_commerce_payment_id`。到店可合并展示可用订金，但服务退款按原结算分配恢复每笔来源；恢复订金余额与将订金退回银行卡是两步。完全恢复后，可在“顾客收款”的对应原购买记录分别申请退钱，线上 worker 核实 Stripe 退款成功才追加退款流水。不要把补款余额借给已用完的旧付款退款。

原生样例复用上一批 $20 订金：原政策是 20%，服务 $100→$10 后经确认原路退 $18；改回 $100 创建独立 $18 Checkout，顾客实际测试付款后可用订金 $20。工作台以原来源 $2+$18 抵扣并记录 $80 现金；服务分两次退 $40、$60，分别恢复订金 $0.80+$7.20 和 $1.20+$10.80，现金合计退 $80；最后两个购买来源分别原路退 $2、$18。这里的现金是隔离 QA 记账，没有真实现金转移。Stripe 三笔退款均 succeeded，订金余额、预留和服务提成均归零。当前测试库 19 笔支付，最终 hash `1e8a03fa966eab1c27950d57b6e277f2`；原 17 笔无关记录不变。[原生付款](../../artifacts/customer-commerce/p3-adjustments-native-verified.json)、[最终原路退款](../../artifacts/customer-commerce/p3-adjustments-final-audit.json)。

迁移 187 已应用到保留测试库，不得修改已推广迁移。演练先在私有复制库执行 186→187 及重放，原 18 笔支付和原金融表内容未变；保留库只增量迁移。`scripts/commerce-deposit-adjustment-upgrade.mjs` 的 186 检查点是推广前专用条件；推广后不应绕过条件重跑。后续回滚只能关闭新发起入口并保留兼容的对账／退款 worker：**186 及更早应用不理解多来源订金，不能直接回退处理已有补款**。不得删新请求、报价或来源列，也不得回滚已发生资金流水。

邮件仍为 capture；待付变价的完整原生场景、真实电话及角色／币种／跨店／语言／并发全矩阵尚未完全验收。P3 和完整 Goal 继续实施，未发布生产。


### 财务函数执行范围（188）

后续安全复查发现 24 个沿用的财务触发器／估值函数没有固定 `search_path`，包括 187 扩展的两个旧守卫。以新迁移 188 固定为 `pg_catalog, public, pg_temp`，不改函数体、调用者权限或 RLS。空库、151→188、执行器重放和 7 文件 188 项财务回归通过后推广；推广前后 10 张财务表内容相同。保留库安全告警由 30 条降至 6 条，本次财务函数无告警；剩余为既有 license／health 函数、btree_gist 扩展及三个共享通信策略，未将其宣称为全库安全零问题。[执行范围与原事实](../../artifacts/customer-commerce/p3-adjustments-search-paths-preservation.json)、[安全检查](../../artifacts/customer-commerce/p3-adjustments-advisors.json)。当前迁移检查点为 **188**，187 和 188 均不可改写。

成功银行提现范围调整的原始用户依据见[用户豁免记录](../../artifacts/customer-commerce/user-scope-payout-waiver.json)。该豁免不代表银行已成功到账，不影响收款、退款、权限、对账与故障恢复的其余验证要求，也不授权生产操作。


### 多人待付变更后的当前价格

客人取消和项目替换保留历史项目，但选择剩余客人的取消金额只从当前未取消项目计算。例如两人 $170、待付订金 $34，取消 $100 的客人后变为 $70／$14，再换为 $10 项目后当前订金是 $2；原报价 $34 仍保存在历史中，不是当前已收金额。旧 Checkout 在异步任务确认过期后不能付款；最后只支付当前 $2 时，原截止任务不会撤销已确认预约。店家和顾客使用同一报价数据，页面显示当前项目 $10／可退订金 $2。[实际流程](../../artifacts/customer-commerce/p3-pending-requote-acceptance.json)。
