# GenieFront OS — 系统文档与开发索引

美国市场亚裔服务业（Spa / Nail / Massage / Foot Spa）AI 驱动的门店管理系统。
Monorepo 仓库结构：`apps/`（多端应用）与 `packages/`（共享业务引擎与数据库）。

---

## ⚡ 开发者上手路线（减少上下文，按需阅读）

```
                     ┌───────────────────────────────┐
                     │   新人接手 / 日常开发指引       │
                     └──────────────┬────────────────┘
                                    │
            ┌───────────────────────┴───────────────────────┐
            ▼                                               ▼
┌───────────────────────┐                       ┌───────────────────────┐
│     后端 / 架构开发     │                       │     前端 / 客户端开发   │
│ 必读: 01 + 03 + 18    │                       │ 必读: 16 (单点真相)    │
└───────────────────────┘                       └───────────────────────┘
```

- **前端工程师 / 前端 AI 只需要读 1 篇**：直接阅读 **[`16-FRONTEND-GUIDE.md`](16-FRONTEND-GUIDE.md)**（架构、6 大规范、11 条真数据避坑、Kuee 路线图全在一份内）。
- **后端工程师 / 架构师 读 3 篇**：
  1. [`01-ARCHITECTURE.md`](01-ARCHITECTURE.md)（系统无状态架构与状态层设计）
  2. [`03-ROADMAP.md`](03-ROADMAP.md)（项目宪法 19 条与已定决策）
  3. [`18-API-REFERENCE.md`](18-API-REFERENCE.md)（完整接口与命令总线参考）

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
| **16** | **[`16-FRONTEND-GUIDE.md`](16-FRONTEND-GUIDE.md)** | ⭐⭐ **前端系统开发指南与交接**：终端架构（`web` / `ios` / `ipad`）、前后端契约、6 大开发规范、11 大真数据避坑指南、对标 Kuee 路线图 |

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
| **18** | [`18-API-REFERENCE.md`](18-API-REFERENCE.md) | ⭐⭐ **接口完整参考手册**：89 条写命令、REST 读路由、错误码字典、权限矩阵 |

---

## 🛠️ 本地开发基线

```bash
# 启动 API 服务
pnpm --filter @gf/api dev

# 启动统一 Web 前端
pnpm --filter @gf/web dev

# 全量质量验证（类型检查 + 单元测试）
pnpm verify
```
