# 2026-09-12 · v1 审查与 GitHub 问题清单

范围仅为当前 `geniefront-os` v1；不涉及 v2、v3。基线为 `ac19d2914b3cec0d6d096495bc914424f2811561`，审查时本地 main 与 GitHub main 相同，开始时工作区干净。没有修改业务代码、部署或操作生产数据。

本轮新增 **7 条 bug（3 条 P1、4 条 P2）**。每条 Issue 都包含提交基线、永久代码链接、复现前提、实际验证结果、验证边界和验收条件。

| 优先级 | 问题 | GitHub |
|---|---|---|
| P1 | 现场排队详情向无 contact 权限的成员返回完整手机号 | [#13](https://github.com/geniefront/geniefront-os/issues/13) |
| P1 | 营业报表不读取退款账本，跨日全额退款使原营业日销售消失 | [#14](https://github.com/geniefront/geniefront-os/issues/14) |
| P1 | 内含税订单全额退款把税款算进服务退款，税额未冲销 | [#15](https://github.com/geniefront/geniefront-os/issues/15) |
| P2 | 有资产流水的客户无法合并，触发 append-only 保护 | [#16](https://github.com/geniefront/geniefront-os/issues/16) |
| P2 | 储值支付被营业报表计为刷卡收入 | [#17](https://github.com/geniefront/geniefront-os/issues/17) |
| P2 | 健康表重填 route 未向必需幂等命令传键，合法请求失败 | [#18](https://github.com/geniefront/geniefront-os/issues/18) |
| P2 | 客户分群和指标只基于前200条，漏掉其他VIP/沉睡客户 | [#19](https://github.com/geniefront/geniefront-os/issues/19) |

## 方法与覆盖

- 阅读现行架构、路线图和测试手册，结合9月11日审查记录确认当前范围及已知缺口。
- 对照已有 GitHub #3–#12，避免重复提交。#4 的字段级折扣权限已在最新基线加入总线保护，不重新提报；其余旧问题不在本轮重复建票。未自动关闭旧 Issue。
- 全工作区强制重新类型检查，运行全仓无数据库测试及现有 lint guards。
- 深入检查命令总线、字段权限、幂等、客户/员工查询、预约与现场排队、收款、礼品卡/储值、退款、日结和报表；对照前台、预约页、iPad、平台页面的相关客户端路径。
- 数据层检查迁移的 RLS/触发器约束与运行时命令是否兼容；复现使用真实 app_user 角色和真实事务。
- 检查公开预约、表单重填、身份权限及 webhook 验签的相关代码和已有测试；未触发真实外部付款、短信或模型请求。

## 隔离复现证据

本次新建独立 Docker PostgreSQL 容器，监听本机独立端口；未使用工作区原有开发库，也未访问 v2/v3 数据库。

使用本地已有 PostgreSQL 17.6 镜像及仓库 bootstrap。镜像不含完整运行中的 Auth/Realtime 服务，因此在**临时库内**补充了测试所需 Auth 字段、identities 表及级联关系，并使用仓库 bootstrap 提供 Realtime 测试函数。应用了 v1 全部133个迁移文件，RLS覆盖检查通过，再灌入仓库回归种子。这不是生产 Auth/Realtime 服务验收，也不代表已修复已有 CI Issue #6。

六个后端问题的复现使用当前源码。初始已结账订单/支付使用合成 SQL fixture；退款、发卡、客户合并通过真实 dispatch 执行。健康表重填通过捕获原始注册 handler 执行，路由容器为测试替身。客户分群复现执行真实 SQL 和从原组件提取的参数/筛选代码，React hook 为替身。

```text
客户合并：SQLSTATE 23001，客人资产账本只能追加，整笔合并回滚。
排队详情：canViewContact=false，customer.phone 仍返回完整测试手机号。
表单重填：VALIDATION_FAILED，reason="form.submit 需要 idempotencyKey"。
储值支付：reportCard=5000，daycloseCard=0，daycloseCredit=5000。
跨日退款：原日报 total 10000 → 部分退款后10000 → 全额退款后0；原日结卡款仍10000。
内含税退款：amount=11000，service=11000，tax=0；应为service=10000，tax=1000。
客户分群：全店263人，前端取200人；VIP指标8，实际VIP9；服务端筛选能找到被界面漏掉的VIP。
```

## 自动验证

- `pnpm lint:guards`：通过。
- `pnpm exec turbo run typecheck --force`：16个任务全部通过，0缓存；其中原生iOS任务是仓库既有占位，不能计作功能验收。
- `pnpm test:unit`：131个测试文件、1034个测试通过（其中Web为72文件、465测试）。
- 隔离 API 集成测试：9个文件、201个测试全部通过，覆盖公开预约、Kiosk、收银、客户命令、多店、字段权限、Stripe/Telnyx验签及结账时机规则。采用仓库原有测试，不代表本轮发现的遗漏路径已被修复。

## 验证边界

本轮是代码、现有自动检查和针对性数据库复现审查，没有逐屏执行全部浏览器 E2E，没有验收实物打印机、真实设备、生产部署及真实外部供应商链路。既有测试通过不能排除本轮已经复现的遗漏路径。前次记录的 CSP、首屏加载体积、整体对比度和测试覆盖改进没有作为已证明业务故障重复建票。

临时数据库容器已在测试完成后清理。工作区仅新增本报告。
