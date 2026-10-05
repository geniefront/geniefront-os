# GenieFront OS — 系统文档与开发索引

美国市场亚裔服务业（Spa / Nail / Massage / Foot Spa）AI 驱动的门店管理系统。
Monorepo 仓库结构：`apps/`（多端应用）与 `packages/`（共享业务引擎与数据库）。

---

## 先读这三份（2026-09 起）

| 你要什么 | 读 |
|---|---|
| **现在仓库实际长什么样、做到哪** | [`CURRENT-ARCHITECTURE.md`](CURRENT-ARCHITECTURE.md) |
| **怎么测、测什么、自动覆盖不到哪** | [`qa/TEST-PLAYBOOK.md`](qa/TEST-PLAYBOOK.md) |
| **写代码前不能违反的产品宪法** | [`03-ROADMAP.md`](03-ROADMAP.md) §A + §D |

然后按角色补：前端规范 [`16-FRONTEND-GUIDE.md`](16-FRONTEND-GUIDE.md)；设计理念 [`01-ARCHITECTURE.md`](01-ARCHITECTURE.md)（仓库树已过时）；接口 [`18-API-REFERENCE.md`](18-API-REFERENCE.md)。过时审计在 [`archive/`](archive/README.md)，不要用来判断能不能上线。

---

## 📚 文档目录索引（按业务领域）

### 1. 🏗️ 核心架构与规则
| 编号 | 文档 | 核心内容 |
|---|---|---|
| **00** | [`00-DISCOVERY.md`](00-DISCOVERY.md) | 行业调研：Spa/Nail/Massage 门店前台一天的真实业务、轮牌制度、小费法律与行业痛点 |
| **01** | [`01-ARCHITECTURE.md`](01-ARCHITECTURE.md) | 系统架构：托管状态层 + Fastify 无状态双实例、命令总线、容量模型、三大核心引擎 |
| **02** | [`02-DATA-MODEL.md`](02-DATA-MODEL.md) | Postgres 数据模型：全部数据表、强制 RLS、多店/一人多角色模式、审计日志 |
| **03** | [`03-ROADMAP.md`](03-ROADMAP.md) | **已定决策 24 条 + 项目宪法 19 条**（写代码前必读）与系统演进规划 |
| **04** | [`04-OPERATIONS-RISKS.md`](04-OPERATIONS-RISKS.md) | 运营与法律风险：获客、硬件兼容、SMS A2P 10DLC、HIPAA/PCI 安全护栏 |

### 2. 🖥️ 前端与多端系统
| 编号 | 文档 | 核心内容 |
|---|---|---|
| **16** | **[`16-FRONTEND-GUIDE.md`](16-FRONTEND-GUIDE.md)** | 前端开发规范与契约。现行端点地图见 `CURRENT-ARCHITECTURE.md`。Kiosk 是 `apps/ipad`（已可跑），`apps/ios` 仍是空壳。营销站 `apps/marketing`，预约页 `apps/booking` |
| **22** | [`22-SETUP-WORKSPACE-HANDOFF.md`](22-SETUP-WORKSPACE-HANDOFF.md) | 首次开店独立页面、服务端状态门禁、四步营业最小流程与验证记录 |
| **23** | [`23-PURCHASE-TO-OPEN-CHECKLIST.md`](23-PURCHASE-TO-OPEN-CHECKLIST.md) | 购买、订阅、激活、开店的验收历史；当前账号见 TEST_ACCOUNTS |

### 3. 🤖 AI、语音与电话集成
| 编号 | 文档 | 核心内容 |
|---|---|---|
| **05** | [`05-AI-INTEGRATION.md`](05-AI-INTEGRATION.md) | AI 规则即 JSON、价目表视觉识别提取（Claude Vision）、AI 前台副驾与成本模型 |
| **09** | [`09-TELNYX.md`](09-TELNYX.md) | Telnyx AI 电话与短信承载通道、SIP 配置、口音实测标准与落地指引 |
| **14** | [`14-VOICE-TOOLS.md`](14-VOICE-TOOLS.md) | AI 电话工具接口（Webhooks）、通话时长计量、录音与实时转录 |

### 4. 🌐 商业化、官网与公开服务
| 编号 | 文档 | 核心内容 |
|---|---|---|
| **11** | [`11-WEBSITE-INTEGRATION.md`](11-WEBSITE-INTEGRATION.md) | 门店官网 ↔ 系统对接契约（Stripe Checkout Metadata 联动） |
| **12** | [`12-SIGNUP-ACTIVATION.md`](12-SIGNUP-ACTIVATION.md) | 客户自助开户：从付款到建租户、激活信、认领门店的全流程 |
| **13** | [`13-PUBLIC-BOOKING-API.md`](13-PUBLIC-BOOKING-API.md) | 公开在线预约 API 与 iframe 嵌入方案，防刷防恶意占位的七层安全防护 |
| **15** | [`15-HEALTH-FORMS.md`](15-HEALTH-FORMS.md) | 电子健康免责表：六语言模板、AES-256 加密存储、读审计留痕、免责分享 |
| **17** | [`17-STOREFRONT-BRIEF.md`](17-STOREFRONT-BRIEF.md) | AI 官网建站工单模型（结构化需求输入 → 48小时快速交付） |

### 5. 🔌 接口参考与环境准备
| 编号 | 文档 | 核心内容 |
|---|---|---|
| **06** | [`06-EXTERNAL-SERVICES.md`](06-EXTERNAL-SERVICES.md) | 外部依赖服务与 API 准备清单（Supabase, Anthropic, Stripe, Telnyx 等） |
| **07** | [`07-CREDENTIALS-CHECKLIST.md`](07-CREDENTIALS-CHECKLIST.md) | 环境变量与凭据自检清单（去哪申请、格式校验、连通性检查） |
| **18** | [`18-API-REFERENCE.md`](18-API-REFERENCE.md) | ⭐⭐ **接口完整参考手册**：写命令、REST 读路由、错误码字典、权限矩阵 |

### 6. 测试与现行快照
| 文档 | 核心内容 |
|---|---|
| [`CURRENT-ARCHITECTURE.md`](CURRENT-ARCHITECTURE.md) | 现行应用/包/路由/认证/多语言地图 |
| [`qa/TEST-PLAYBOOK.md`](qa/TEST-PLAYBOOK.md) | 分批测试：自动门 + 10 批手测 |
| [`qa/TEST_ACCOUNTS.md`](qa/TEST_ACCOUNTS.md) | 当前 local/staging/prod 账号、最小 seed 与真实业务保护 |
| [`qa/SEED_SCENARIOS.md`](qa/SEED_SCENARIOS.md) | QA seed 场景与账号 |
| [`qa/QA_COVERAGE.md`](qa/QA_COVERAGE.md) | Playwright 已覆盖矩阵（英文 Chromium） |
| [`archive/`](archive/README.md) | 已过时的审计单与交接，仅供溯源 |

---

## 🛠️ 本地开发基线

```bash
# 启动 API 服务
pnpm --filter @gf/api dev

# 启动公开营销 / 开户站（端口 5180）
pnpm dev:marketing

# 启动统一 Web 前端
pnpm --filter @gf/web dev

# 全量质量验证（类型检查 + 单元测试；API/DB 必须隔离库）
pnpm verify

# 浏览器回归（不起 booking / ipad）
GF_QA_ALLOW_RESET=1 NODE_ENV=test pnpm test:e2e
```

手测批次与账号见 [`qa/TEST-PLAYBOOK.md`](qa/TEST-PLAYBOOK.md)。

## 组合项目套餐实施计划

- [组合项目套餐：全链路实施与验收计划](plans/2026-09-07-service-bundles-implementation.md)：导入、新建、看板、服务、结账、退款、提成及其他入口的执行任务与验收标准（待执行）。

## U01 开店向导重构

- [U01 实施计划与实时交接](plans/2026-09-08-u01-setup-refactor.md)：七步向导、房间门禁、健康表首发、AI 电话准备状态；包含逐步状态、验证矩阵及下一步入口。
