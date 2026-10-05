# 48 项覆盖与剩余条件

基线与环境见 [REPORT.md](REPORT.md)。这里的“子场景通过”仅指列出的证据，不表示该项全部完成。现有套件日志为 [api.log](api.log)、[db.log](db.log)、[unit.log](unit.log)。D 表示真实本地数据库；HTTP 仅在明确写出时成立；B 为浏览器；S 为源码；M 表示存在替身。

| ID | 本轮证据/结论 | 未完成的关闭条件 |
|---|---|---|
| A01 | 子场景通过 D/M：systemOnly/server/core_loop/ghostStaff/kiosk 套件；默认 staff session HTTP 实测 | 真实 Supabase Auth 与全部 actor×入口组合 |
| A02 | **发现 P1-02/P1-06**：同店他人订单可读、跨组织客户可绑定；跨店服务 404 对照 | 全部读写/导出/附件入口统一矩阵 |
| A03 | **发现 P1-07**：真实 HTTP 等锁后撤销会话仍提交；之后新请求 401 | 修复后复验；Supabase JWT 撤销路径另测 |
| A04 | 子场景：staffContext 每次认证检查 revoked/status；ghostStaff 测试通过；在途缺口见 A03 | 浏览器切店、权限缓存、停用全流程 |
| A05 | S：actor/staffSession 合并角色及 deny override；现有 fieldPermissions/core_loop 测试通过 | 任意自定义角色与套餐限制的全入口对等性 |
| A06 | **P2-05** 回执不比较内容；当前总线回放前检查上下文权限 | 撤权后同 key/不同 actor 的回执字段读取专项 |
| A07 | D：DB 套件通过，132 表强制 RLS、app_user 无 bypassrls；跨租户 FK 缺口见 A02 | 每表四操作及全部 worker 来源权限矩阵 |
| A08 | D/S：withTenant 使用事务本地 set_config；已有 RLS 用例通过 | 高频池复用、异常回滚后连续 actor 切换专项 |
| B01 | 子场景通过 D：bus 中双预约竞争只成功一次；public/bus 套件通过 | 在线/前台/电话三入口同一窗口竞争 |
| B02 | 子场景通过 D：bus/bundle 重排与冲突用例 | 改期与另一预约的确定性并发 barrier |
| B03 | 子场景通过 D：rooms/workstations/bus 技能与资源约束 | 所有资源组合在可用时段查询与提交间的一致性 |
| B04 | 部分：phone 一项旧正式指派计数失败；预留机制源码存在 | 同时验证 reserved 与正式成员容量后再关闭 |
| B05 | 子场景通过 D：bundle 34 项、core_loop 22 项 | 所有套餐数量/缓冲/跨度组合；浏览器展示一致性 |
| B06 | 子场景通过：scheduling/offHours/公共预约时区测试 | 门店真实时区/DST边界的浏览器端到端 |
| B07 | 子场景通过 D：core_loop 到店/开单/重复活跃工单防线 | 三入口签到同时发生时的竞争回归 |
| B08 | 子场景通过 D：staff/workstations/排班相关现有测试 | 排班编辑后已有预约冲突的完整 UI 反馈 |
| C01 | D+HTTP：4500 服务+100小费合计4600；money/bundle 分摊套件通过；**P1-01 负数覆盖** | 非负校验修复；所有税/尾分组合 HTTP 验收 |
| C02 | D+HTTP 混合现金/卡通过；core_loop/giftcard 对储值与礼卡有用例 | 真实卡供应商与全部混合资产来源 |
| C03 | D+HTTP 同 key 原输入不重复，换 key 再结账409；**P2-05 异输入不冲突** | 摘要修复后并发/旧回执兼容 |
| C04 | 未进行真实资金未知结果恢复；Stripe 单元/租户映射有替身用例 | OS 收银卡路径为记账，先界定供应商执行适用范围；适用者需原 key 查询恢复 |
| C05 | D+HTTP 部分退款、相同 key 回放、超额拒绝、全退4600通过 | 不同 key 并发退款及全部混合资产返还 |
| C06 | 未执行外部成功后归账前 kill | 不能把本地退款记账当作真实 provider 返款或崩溃恢复 |
| C07 | 子场景通过 D：giftcard/core_loop 客户储值竞争不透支 | 全来源撤销、独立进程竞争与恢复 |
| C08 | 子场景通过 D：money/core_loop 结算、提成与退款冲销 | 已支付工资后的财务调整完整链 |
| C09 | 子场景通过 D：money/core_loop/gapdays 报表/日结；无真实导出浏览器验收 | 跨日/封账后更正与导出一致性全序列 |
| C10 | 未确认 OS 与 V3 同等的定金 provider 链，暂不套用 V3 要求 | 按实际产品承诺定位支持入口，确定适用范围 |
| D01 | D/S：bus 事务内审计与事件；outbox_delivery/notify 套件通过 | 业务提交与入队之间的定向失败注入 |
| D02 | D/M：sms_claims 同进程两个 flush 只发送一次 | 两个独立进程/真实租约竞争 |
| D03 | 未执行独立 worker kill/restart；预置超时 claim 测试通过 | 供应商接受后真实进程被终止，再恢复 |
| D04 | M/D：Stripe/Telnyx 验签、webhook.tenant、subscriptionLifecycle 通过 | 各 provider 乱序、丢失、重放全状态 |
| D05 | S：email/sms 有 ambiguous 与超时处理；相关替身测试通过 | 慢 TLS/header、总 deadline、SIGTERM、持续任务推进 |
| D06 | 子场景通过：billing/voice/license/voiceManagement 现有套件 | 免费/套餐/充值同一通话的逐来源资金账专项 |
| D07 | 子场景通过：subscriptionLifecycle/licenseSwitch 现有套件 | 用量修订、月切换与停机补发整链；不能继承 V3 实现结论 |
| D08 | 尚未证实 OS 存在 V3 同等 autopay 执行器，未执行此情景 | 确定适用入口后区分新派发授权与原派发恢复授权 |
| E01 | 子场景通过：formShare/kiosk/crypto/healthFormsFeatures；readSubmission 检查内容权限 | 实际浏览器导出、密钥轮换、全敏感日志面 |
| E02 | D/M：formShare/bookingToken/bookingAccess 通过；B：无效表单链接不展示内容 | **P2-01** URL/log token保护及有效链接浏览器提交 |
| E03 | S：存储迁移已抽查；本地只模拟 storage schema | 真实 Storage 签名 URL/对象权限/过期与路径伪造 |
| E04 | S/L：**P1-03** DNS 反例；email 模板转义测试通过 | 流式超大响应、所有模板/打印 HTML 浏览器攻击输入 |
| E05 | D/M：systemOnly/preflight/AI 相关测试；Copilot 初跑5失败重跑通过 | 稳定夹具、真实模型攻击输入与全部工具授权边界 |
| E06 | S：LOGGER_REDACT_PATHS 与代理配置；**P2-01** 未关闭 | 正式代理/错误追踪中的脱敏实测，不读取生产隐私日志来代替测试 |
| F01 | 五前端 build通过；B：web登录/失效表单页正常，无捕获error/warn | 登录后五端空态/失败/重试，真实 Auth 全链 |
| F02 | D+HTTP 重复收款受保护；**P2-05** 内容变更误回放 | 浏览器双击、切页、断网后重试 |
| F03 | **P2-02** 源码+响应头确认；未运行真实离线刷新 | Auth隔离环境中的快照恢复、换账号/门店与重连 |
| F04 | unit/jsdom 有多语言/组件用例；B仅两页 | 真设备触控/键盘、多语言金额布局、小票打印 |
| F05 | D：新库151迁移成功；**P2-06** 回退测试污染已复现 | 修复后保证测试前后schema一致；故障中断迁移专项 |
| F06 | 未演练正式版本切换/失败回退 | 明确API/DB兼容窗口与真实隔离发布演练 |
| F07 | D：干净完整迁移库dump/restore成功、关键计数/总额/RLS一致 | 生产实际备份/PITR/Storage对象和密钥恢复不在本轮 |
| F08 | 规则/types/五前端/API bundle通过；**P2-03** CI无自动测试 | 正式Docker镜像启动、健康依赖、GitHub保护及失败发布阻断 |

未完成项是验证缺口，不自动计为缺陷；不将本表换算成“功能完成率”。
