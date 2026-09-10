# GenieFront 外部开源复用清单

核对日期：2026-09-09。范围：本地新版、七行业门店营业、AI 副驾、预约、员工、收银与平台运营。建站按用户最新决定沿用人工代办工单，不建设自助建站器。以下全部为外部项目，已经被本仓库采用的外部依赖也保留在清单中；不把本项目自写模块计为开源复用。

这是针对当前产品范围的选型目录，不声称穷尽互联网。已查官方仓库、官方文档及关键许可证；没有安装、执行或集成这些候选，也没有据此批准生产迁移。功能适配和取舍为本项目的工程判断。

用户已补充 HeroUI Pro 经 CollectUI 代理使用。它作为已有商业组件来源优先评估，不计作本清单的宽松开源库；配置与组件使用规则见 [HeroUI Pro 代理接入](../plans/2026-09-09-heroui-pro-collectui-integration.md)。

## 1. 默认组合

按用户最新决定，当前组合更新为：React/Vite + 以现有 HeroUI 为核心的自有设计系统 + TanStack Query/Table/Virtual + React Hook Form/Zod + 保留并重构自定义 Kanban/日程 + AI SDK/assistant-ui primitives + Fastify/Drizzle + 本地 Supabase + pg-boss + React Email/Mailpit + Playwright/MSW/fast-check/Storybook。shadcn 是个别组件的备选来源，通用日历不进入默认栈；具体执行以[重构计划](../plans/2026-09-09-v2-refactor-architecture-plan.md)为准。

按需求加入：JSON Forms/Signature Pad、Langfuse/promptfoo、CASL、Scalar。客服与 BI 如需完整后台，可独立部署 Chatwoot/Metabase，避免自写整套系统。Puck、Payload 不进入当前选型或实施计划；建站保留用户提交需求、平台经营者制作交付的现有方式。

“优先”仍需通过一个真实场景的集成验证，不等于无需适配即可投入营业。队列、认证、Agent 框架、日历同类方案默认择一，不同时引入多套。

## 2. 前端基础与业务组件

| 外部项目 | 复用能力 | 本项目取舍 | 授权/范围 |
| --- | --- | --- | --- |
| [shadcn/ui](https://github.com/shadcn-ui/ui) | 按钮、弹层、表单、菜单等可修改源码 | 备选；在统一 UI 层按收益选择，当前默认沿用 HeroUI 与现有视觉 | MIT；漂亮程度仍取决于设计 |
| [TanStack Query](https://github.com/TanStack/query) | 服务端数据缓存、失效、请求状态 | 继续复用，不再手写一套数据缓存 | MIT |
| [TanStack Table](https://github.com/TanStack/table) | 排序、筛选、分页、列选择等表格逻辑 | 优先；客户、订单、员工、日志共享 | MIT；需要自己的外观和后端查询 |
| [TanStack Virtual](https://github.com/TanStack/virtual) | 长列表/网格虚拟化 | 数据量需要时加入 | MIT |
| [React Hook Form](https://github.com/react-hook-form/react-hook-form) | 表单状态、校验接入、动态字段 | 优先；员工与服务设置等 | MIT |
| [Zod](https://github.com/colinhacks/zod) | 输入结构校验、TypeScript 推导 | 继续复用，建立前后端共享契约 | MIT；不能替代业务与数据库约束 |
| [dnd-kit](https://github.com/clauderic/dnd-kit) | 拖放、排序、输入设备支持 | 自定义轮牌排序等场景使用 | MIT；落点后仍需服务端校验 |
| [React Big Calendar](https://github.com/jquense/react-big-calendar) | 日/周日历、资源分组、拖动和缩放扩展 | 后备调研；优先保留自定义日程，不默认替换 | MIT；不是排班/容量引擎 |
| [FullCalendar](https://fullcalendar.io/docs/premium) | 成熟日历、资源时间线与资源列视图 | 接受组件采购时的备选 | 标准部分 MIT；资源类 Premium 单独授权 |
| [Schedule-X](https://schedule-x.dev/docs/calendar/resource-scheduler) | 日历、拖动、资源排程视图 | 日历备选，不与上两者叠加 | 核心与 Premium 分开；资源排程需有效许可 |
| [date-fns](https://github.com/date-fns/date-fns) | 日期计算、格式化；配套时区工具 | 优先使用成熟日期库；全链路保留门店时区 | 采用版本的包级 LICENSE 需锁定复核 |
| [rrule](https://github.com/jkbrzt/rrule) | 重复班表/重复预约日期展开 | 重复规则出现时加入 | BSD；仍需处理门店时区与例外日期 |
| [decimal.js](https://github.com/MikeMcl/decimal.js) | 精确十进制运算 | 百分比、税额等计算候选 | MIT；金额账本依然采用明确单位与舍入规则 |
| [Dinero.js](https://github.com/dinerojs/dinero.js) | 货币金额、精度与分配等基础操作 | 与现有整数金额方案对比后择用 | MIT；不能代替退款、提成和日结规则 |
| [react-i18next](https://github.com/i18next/react-i18next) | 国际化、复数、语言切换 | 多端文案系统候选 | MIT；现有词条需迁移 |
| [Recharts](https://github.com/recharts/recharts) | React 报表图表 | 继续复用；统一图表配色与金额口径 | MIT |
| [Tiptap](https://github.com/ueberdosis/tiptap) | 富文本编辑、结构化内容 | 门店介绍、通知模板和帮助内容 | 开源核心 MIT；付费扩展/托管服务分别核对 |
| [JSON Forms](https://github.com/eclipsesource/jsonforms) | JSON Schema 驱动的动态表单、规则和校验 | 健康表填写端优先候选；编写 shadcn renderer | MIT；不是现成的拖拽设计器 |
| [SurveyJS](https://surveyjs.io/licensing) | 问卷填写、条件逻辑、表单设计器等产品 | 愿意购买设计器时可节省更多工作 | Form Library MIT；Creator/PDF/Dashboard 商业授权 |
| [Signature Pad](https://github.com/szimek/signature_pad) | 手写签名采集 | iPad 健康表签字直接复用 | MIT；签署人、版本、时间和历史存证需业务实现 |

## 3. AI 与知识处理

| 外部项目 | 复用能力 | 本项目取舍 | 授权/范围 |
| --- | --- | --- | --- |
| [Vercel AI SDK](https://github.com/vercel/ai) | 模型适配、流式消息、工具调用、结构化结果 | 优先；替换通用模型通信代码 | Apache-2.0；保留业务任务服务 |
| [assistant-ui](https://github.com/assistant-ui/assistant-ui) | 聊天状态、消息/输入组件、工具结果交互 | 优先；采用 primitives 接入自有设计系统 | MIT；会话存储和业务卡片仍需适配 |
| [Langfuse](https://langfuse.com/handbook/chapters/open-source) | 调用链、延迟、用量、提示词管理及评估工具 | AI 调优阶段加入；独立服务 | 核心 MIT；ee 功能商业授权；需要控制敏感内容记录 |
| [promptfoo](https://github.com/promptfoo/promptfoo) | 提示词/模型回归评测 | 优先开发工具；把预约与澄清案例变成评测集 | 核心 MIT；模型调用有独立成本 |
| [Mastra](https://github.com/mastra-ai/mastra) | TypeScript Agent、工作流等框架能力 | 复杂工作流出现后，与 LangGraph 择一评估 | Apache-2.0 核心；ee 目录单独授权 |
| [LangGraph.js](https://github.com/langchain-ai/langgraphjs) | 有状态 Agent 图、持久化与中断恢复机制 | 多阶段 AI 任务备选；首版不叠加 | MIT；托管服务与代码许可分开 |
| [Docling](https://github.com/docling-project/docling) | 文档解析、版面/表格抽取与文档转化 | 大量 PDF/文档导入时单独 Python worker | MIT 代码；模型资产另核；价目表仍需人确认 |
| [pgvector](https://github.com/pgvector/pgvector) | PostgreSQL 向量检索 | 明确需要知识库检索时再启用 | PostgreSQL License；还需嵌入模型和访问过滤 |
| [LiveKit Agents](https://github.com/livekit/agents) | 实时语音 Agent、媒体与模型衔接 | 将来重做电话 AI 时的候选 | Apache-2.0；电话线路/模型服务另计 |
| [Pipecat](https://github.com/pipecat-ai/pipecat) | 实时语音/多模态处理管线 | LiveKit 路线的备选 | BSD-2-Clause；首版不替换电话系统 |

## 4. 后端、身份与异步任务

| 外部项目 | 复用能力 | 本项目取舍 | 授权/范围 |
| --- | --- | --- | --- |
| [Fastify](https://github.com/fastify/fastify) | HTTP 服务、插件体系、请求生命周期 | 继续复用 | MIT |
| [Drizzle](https://github.com/drizzle-team/drizzle-orm) | 类型化数据库访问、Schema 与迁移工具 | 继续复用 | Apache-2.0；事务/约束仍须明确设计 |
| [Supabase](https://supabase.com/docs/guides/self-hosting) | PostgreSQL、Auth、Storage、Realtime 与本地开发套件 | 优先延续现有底座，支持自托管 | 组合系统按组件许可；云服务功能与自托管范围分开 |
| [Better Auth](https://github.com/better-auth/better-auth) | 身份验证、会话与组织相关插件 | 只有明确替换 Auth 时采用，不与 Supabase Auth 双主并存 | MIT 核心；完整门店授权不是开箱即用 |
| [CASL](https://github.com/stalniy/casl) | 动作/资源/条件权限表达 | 复杂权限展示与统一策略候选 | MIT；服务端须重新判断，不能只限制前端按钮 |
| [OpenFGA](https://github.com/openfga/openfga) | 关系型权限决策服务 | 跨组织共享权限复杂后再上 | Apache-2.0；额外服务不适合当前简单默认栈 |
| [pg-boss](https://github.com/timgit/pg-boss) | PostgreSQL 任务队列、重试、延迟与计划任务 | 优先；通知、AI 导入、续期、对账 | MIT；外部副作用仍需稳定幂等键/Outbox |
| [BullMQ](https://github.com/taskforcesh/bullmq) | Redis 支撑的队列和任务调度 | 已有 Redis 或明确吞吐需求时备选 | MIT 核心；Pro 产品另算 |
| [Temporal](https://docs.temporal.io/) | 长时工作流、持久化执行、重试恢复 | 将来出现跨天复杂流程时再考虑 | Server MIT；有额外运维成本；Activity 副作用仍须幂等 |
| [ts-rest](https://github.com/ts-rest/ts-rest) | 类型化 REST 契约、客户端/服务端适配 | 共享契约的候选；先检验 Fastify/Zod 版本适配 | MIT；与既有契约渐进迁移 |
| [Scalar](https://github.com/scalar/scalar) | OpenAPI 交互文档、接口调试 UI | 优先用于 API 文档 | 开源核心 MIT；需要准确 OpenAPI 定义 |

## 5. 消息、内容与网站

| 外部项目 | 复用能力 | 本项目取舍 | 授权/范围 |
| --- | --- | --- | --- |
| [React Email](https://github.com/resend/react-email) | React 邮件模板和预览 | 预约、取消、收据、邀请邮件优先复用 | MIT；不绑定某家邮件发送商 |
| [Mailpit](https://github.com/axllent/mailpit) | 本地 SMTP 收件箱与邮件检查 | 本地版本优先，不向真实客人发送测试邮件 | MIT |
| [Novu](https://github.com/novuhq/novu) | 通知工作流、渠道与站内 Inbox | 多渠道通知产品化之后再接；首版 pg-boss +模板足够 | MIT 核心；enterprise 部分商业授权 |
| [Puck](https://github.com/puckeditor/puck) | React 可视化页面编辑器，拖放自己的组件 | 当前排除；用户不需要自助建站，条目仅保留调研记录 | MIT |
| [Payload](https://github.com/payloadcms/payload) | CMS、内容管理后台、多租户插件 | 当前排除；人工建站工单不需要新 CMS，条目仅保留调研记录 | MIT 核心；当前 Next.js 架构意味着额外运行服务 |
| [Activepieces](https://www.activepieces.com/docs/about/license) | 自动化连接器、工作流 | 平台内部自动化可选 | MIT 核心；enterprise/cloud 功能商业授权 |

## 6. 别人已经写好的完整系统

下表重点是系统级复用。“独立接入”表示另外运行应用，通过明确 API/事件同步；不会因此自动获得统一账户、数据语义、授权或视觉，也不代表自动免除许可证要求。

| 完整系统 | 可以省掉什么 | 推荐使用方式与边界 | 授权/技术成本 |
| --- | --- | --- | --- |
| [Cal.diy](https://github.com/calcom/cal.diy) | 通用公开预约、日历连接与可用时间配置 | 可运行对照；若采用必须选定唯一预约写入源。不能直接代表多项目轮牌与工位清洁 | 当前 MIT 社区版；Next.js 等运行栈；不把商业 Cal.com 功能都算进去 |
| [Easy!Appointments](https://github.com/alextselegidis/easyappointments) | 服务、服务人员、客户与预约管理 | 小店通用预约系统候选/对照，完整营业规则另核 | GPL-3.0；PHP 系统，嵌入现有 TS 产品有整合成本 |
| [Medusa](https://medusajs.com/modules) | 商品、库存、价格、促销、客户、订单与支付编排模块 | 零售功能扩大后，单独验证 Inventory/Promotion 等模块；不直接替代服务履约和员工账务 | MIT 核心；RBAC 等 Enterprise 材料商业授权；引入运行时/数据模型成本 |
| [ERPNext](https://github.com/frappe/erpnext) | 库存、采购、销售、会计、POS 等 ERP 能力 | 可作为独立 ERP 或业务对照；若整套采用属于另一条产品路线 | GPL-3.0；Frappe/Python 生态 |
| [Frappe HRMS](https://github.com/frappe/hrms) | 考勤、请假、员工与薪资管理 | 内部 HR 系统候选；店铺提成、小费、退款追溯仍需适配 | GPL-3.0；不能假设工资模块适用于所有地区和店规 |
| [Odoo Community](https://github.com/odoo/odoo) | CRM、POS、库存及其他社区业务模块 | 整套运营平台的备选路线，须逐模块核对社区可用性 | Community 主体 LGPL-3.0；Enterprise/第三方模块许可另核 |
| [Open Source POS](https://github.com/opensourcepos/opensourcepos) | 零售收银、货品、客户、报表等 | 可运行对照；与多技师服务单差别大 | 当前 LICENSE 含额外可见页脚保留条件，不能当标准 MIT 白标；PHP/MySQL |
| [Chatwoot](https://github.com/chatwoot/chatwoot) | 客服 Inbox、会话、客服协作、多渠道接入 | 最值得独立部署的候选之一；通过店铺/客户标识对接 | Community MIT；Enterprise 商业授权；渠道仍需供应商接入 |
| [Twenty](https://github.com/twentyhq/twenty) | 通用 CRM、客户关系、销售管线 | 平台获客/销售团队可独立用；门店客户档案仍需确定主数据源 | 主体 AGPL-3.0，部分 MIT 包与 Enterprise 文件；见完整 LICENSE |
| [Metabase](https://github.com/metabase/metabase) | 自助 BI、查询与经营报表探索 | 老板/平台内部分析可直接部署；稳定业务报表继续由产品提供 | OSS AGPL；Enterprise 商业许可；嵌入与白标要求单独核对 |
| [Refine](https://github.com/refinedev/refine) | 数据驱动管理后台框架 | 平台配置/工单/审核 CRUD 候选；可配自有 UI | MIT；不是完整业务后端，不能自动生成经营规则 |
| [React-admin](https://github.com/marmelab/react-admin) | 列表、编辑、数据/认证适配器 | 与 Refine 择一；默认视觉栈与 shadcn 统一成本需评估 | MIT 核心；Enterprise 模块另算 |
| [Appsmith](https://github.com/appsmithorg/appsmith) | 内部查询、操作与管理面板 | 平台内部工具可复用；不作为高端门店前台默认方案 | Apache-2.0 社区代码；付费功能另核 |
| [Plane](https://github.com/makeplane/plane) | 团队任务、问题与项目管理 | 一般内部项目管理备选；现有建站工单继续使用，不为其增加系统 | AGPL-3.0 核心；其他版本按对应许可 |

## 7. 开发与验证工具

| 项目 | 省掉的工作 | 推荐 |
| --- | --- | --- |
| [Playwright](https://github.com/microsoft/playwright) | 浏览器流程测试、截图对照 | 继续使用；Apache-2.0 |
| [MSW](https://github.com/mswjs/msw) | 网络层模拟与失败场景 | 新前端独立开发优先；MIT；验收仍接真实本地后端 |
| [fast-check](https://github.com/dubzzz/fast-check) | 自动生成大量组合输入与缩减失败例子 | 金额守恒、分配、轮牌和状态转换测试；MIT |
| [Storybook](https://github.com/storybookjs/storybook) | 组件展示、状态样例与交互验证环境 | 自有 Design System 优先；MIT；截图服务另选 |

## 8. 常见但不默认放进本产品的源码可见方案

这些不是上述宽松开源库的等价替代，单列是为了避免遗漏用户可能见过的名字。

| 方案 | 可用场景 | 不默认采用的原因 |
| --- | --- | --- |
| [n8n](https://docs.n8n.io/sustainable-use-license/) | 内部自动化和第三方集成 | Sustainable Use License 不是普通 MIT/Apache；给客户嵌入工作流/凭据管理需要按具体用法核对许可 |
| [Dify](https://github.com/langgenius/dify/blob/main/LICENSE) | 快速搭建 AI 应用、知识库与工作流 | 修改版 Apache 条款含多租户/品牌限制；不直接当作可白标门店 SaaS 底座 |
| [Open WebUI](https://docs.openwebui.com/license/) | 内部模型聊天和知识库测试 | 当前许可含品牌条款及例外；不默认作为 GenieFront 自有品牌聊天界面 |

## 9. 哪些规则仍需专门实现

复用上述引擎/组件后，仍要明确编写和验证：一客多项的履约状态；计划占用与实际占用；多人资源位置及清洁；技师资格与轮牌；预约加项/改期影响；混合支付、退款和历史对账；提成、小费、日结调整；跨店授权；AI 方案与正式业务命令的绑定。

原因是这些是产品规则而非通用组件。日期、金额、队列、表格不重写；具体何时允许开工、退款如何影响已发提成等，必须有本产品唯一的规则来源。现阶段没有验证到一个能直接覆盖 GF-01–GF-36 且无需重大改造的开源系统。

## 10. 接入顺序与验收

1. 固定组件设计体系，先在 Storybook 展示日历、订单表、服务卡、AI 方案卡和表单状态。
2. 迁移并拆解现有 Kanban 与自定义日程，用相同数据核对多技师/多工位、跨营业日、拖动改期、手机替代操作。只有局部实现出现明确维护成本问题时才比较外部替代，不默认启动整个日历迁移。
3. AI SDK + assistant-ui 接入既有任务契约，检验修改方案、确认、重复点击、刷新恢复与费用记录。
4. pg-boss + React Email + Mailpit 打通可观察的通知入队、发送、失败与重试，保留 Outbox/幂等。
5. JSON Forms/Signature Pad 按表单功能阶段加入，先完成真实端到端链路。建站只保留并接通现有人工代办工单，不做自助编辑器，不接入 Puck/Payload。
6. Chatwoot、Metabase、ERP 等独立系统仅在确定用户、主数据源和同步边界后启动验证，避免首版本地要同时维护十几个服务。

许可证记录是本轮技术选型核对，不是对所有发布/嵌入方式的一揽子结论。正式采用时记录准确版本/commit、包级 LICENSE、企业目录排除范围与通知文件。可商用不等于可任意白标；独立部署也不自动消除许可义务。

维护核对：同目录 `2026-09-09-upstream-repositories.json` 保存官方 GitHub 元数据，包括 archived 与 pushed_at；更新日期只说明仓库活动，不代表质量、无漏洞或兼容性。少数请求因限流/地址迁移失败，保留错误而不伪造状态；Novu 正确仓库为 `novuhq/novu`，rrule 为 `jkbrzt/rrule`，正文使用修正后的官方来源。关键混合许可证摘录见 `2026-09-09-upstream-license-excerpts.json`。
