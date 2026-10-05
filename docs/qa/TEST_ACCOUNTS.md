# 环境、账号与测试 seed

更新：2026-09-27。账号配置的唯一清单是 [`config/test-accounts.json`](../../config/test-accounts.json)。旧演示账号不再作为 local、staging 或 production 的登录入口。

## 环境职责

| 环境 | 用途 | 常驻账号 | 常驻门店 |
| --- | --- | --- | --- |
| local | 日常开发和手工 QA | 4 个新测试账号 + 原管理员 | 运营测试店、开店测试店 |
| staging | 发布前验证域名、登录、回调和部署配置 | 4 个新测试账号 + 原管理员 | 运营测试店、开店测试店 |
| production | 真实业务 | 栀子账号 + 原管理员 | Zhi Zi Massage |
| isolated test DB | API/DB 自动化回归、Seed V2 场景 | 按测试创建和销毁 | Lotus/Golden Foot 或指定 QA 场景 |

## 当前登录账号

| 用途 | local | staging | production |
| --- | --- | --- | --- |
| 运营店主 | `qa-local-owner@example.test` | `qa-staging-owner@example.test` | `zhiziappointments@gmail.com`（真实业务） |
| 前台 | `qa-local-desk@example.test` | `qa-staging-desk@example.test` | 不生成 |
| 技师 | `qa-local-tech@example.test` | `qa-staging-tech@example.test` | 不生成；真实店现有无登录员工保持原样 |
| 开店向导 | `qa-local-setup@example.test` | `qa-staging-setup@example.test` | 不生成 |
| 平台超级管理员 | `ops@maildrop.cc` | `ops@geniefront.test` | `ops@geniefront.test` |

管理员保留原身份、密码和权限，不由 baseline seed 重置。其他新测试账号的密码分别保存在 `.env.local` / `.env.staging` 的 `GF_BASELINE_PASSWORD`，两环境不同；不要写入文档、日志或 Git。`example.test` 不收真实邮件，使用密码登录和 capture 收件箱。

## 初始化与重复运行

```bash
pnpm db:seed local
pnpm db:seed staging
```

配置来自明确指定的 `.env.<environment>`；不会隐式采用 `.env` 或终端遗留的数据库配置。脚本核对 Supabase 项目、数据库主机/端口/用户名、`GF_ENV`、Stripe test key 和 capture 模式。生产 seed 一律拒绝。

每个环境创建两个带 `baseline_seed` 标记的独立组织/门店：

- 运营店：Growth active fixture，店主、前台、技师，3 个服务、2 个工位、1 个虚拟顾客、技师每周排班模板及创建当天排班。
- 开店店：Growth trialing fixture，1 个店主、空目录、`status=setup`，用于向导验收。

重复执行不会删数据、重置密码或再次创建门店；检测到部分数据或账号冲突时拒绝覆盖。原管理员必须已存在。全新安装的管理员应通过正常平台管理员配置流程建立，baseline 不自动创建替代管理员。

这套常驻 baseline 不等于真实 Stripe Checkout；`cus_qa_*` / `sub_qa_*` 是 fixture，不能用于 Billing Portal、续订或 webhook 的端到端验证。真实购买/邮件激活验收需要在 staging 使用可收邮件的专用邮箱和 Stripe test Checkout，测试结束再清理该轮数据；不能复制生产客户数据。

`COMMUNICATION_DELIVERY_MODE=capture` 保持开启，新 seed 不绑定电话、不发邮件/短信、不创建付款或发票。真实外部回调测试按 [测试通信](../25-TEST-COMMS.md) 单独配置。

## 自动化回归和旧工具

Lotus/Golden Foot 仍是 API 集成测试依赖的固定 fixture，只允许在独立的本机/CI 测试库运行：

```bash
# DATABASE_URL / MIGRATION_DATABASE_URL 必须显式指向独立测试库。
DATABASE_TEST_TARGET=isolated SEED_SKIP_AUTH=1 pnpm db:seed
```

旧 seed / `setup:test:reset` 拒绝所有托管库和本机常驻 QA 端口 55322。`qa:seed <scenario>` / `qa:reset` 同样拒绝端口 55322，只管理独立测试库中 Seed V2 标记的数据，不删除 baseline。详见 [场景目录](SEED_SCENARIOS.md)。

历史文档中的 `owner@…`、`mia@…`、`setup@…`、Oasis、Lotus、Golden Foot 和旧密码，属于历史验收或 isolated fixture，不能据此登录当前三个环境。`signup-smoke@geniefront.com` / `ops-smoke@geniefront.com` 是已废弃的旧计划，不是已配置账号。

## 真实业务保护

生产保护对象：

- 登录：`zhiziappointments@gmail.com`
- 组织：`92203dc9-8c2d-4bdb-9e30-55893b52a8a5`
- 门店：`1c708a61-b467-4062-af96-2cd6392e20e5`（Zhi Zi Massage）
- 原管理员：`ops@geniefront.test`

保护范围包括真实员工、顾客、预约、订单、支付、订阅、电话绑定、健康表、客服记录、订阅码及审计关联。账号清理不等于更换服务供应商 API key，也不自动取消/释放 Stripe、Telnyx 或邮件供应商资源。

2026-09-27 清理前已将三个环境的 public/auth/gf_private 数据及结构备份到本机私有目录 `/Users/naiyouzhu/.codex/backups/geniefront-account-reset-20260927/`（不进 Git）。删除只针对明确选中的旧测试数据，真实业务及管理员行逐行校验保留，提交前检查外键完整性。备份含敏感数据，恢复时先导入独立数据库验证，不能直接覆盖在线生产。

## 清理后核验（2026-09-27）

- local：删除 15 个旧登录身份、24 家旧测试店；保留原管理员，创建 4 个新测试账号和 2 家测试店。
- staging：删除 15 个旧登录身份、11 家旧测试店；保留原管理员，创建 4 个新测试账号和 2 家测试店。
- production：删除 12 个旧登录身份、7 家测试店；保留栀子与原管理员。栀子保留 3 个员工档案、19 位顾客、23 条预约，其他真实业务关联也逐行通过一致性校验。
- 8 个新测试账号均通过 Supabase 密码登录；staging 的门店选择接口返回预期门店和角色。local API 当时未启动，未做其 HTTP 门店接口验收。
- 两环境 seed 重跑均无新增或覆盖；生产 seed 拒绝执行。数据库外键完整性检查、类型检查、约束 lint 和 seed 安全测试通过。
- 未重新部署应用；改动为数据库清理、测试配置、开发工具和文档。Stripe/Telnyx/邮件供应商的远端资源未执行取消或释放。
