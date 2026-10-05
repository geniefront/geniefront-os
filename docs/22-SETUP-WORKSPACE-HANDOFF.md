# Setup 工作区交接

> **2026-09-27 账号清理更新：** 当前环境账号和 seed 命令以[环境账号清单](qa/TEST_ACCOUNTS.md)为准。下文旧账号、演示店及旧密码仅适用于历史记录或隔离测试 fixture，不能作为现行 local/staging/prod 登录配置；原 `ops` 管理员保留。


> 最后更新：2026-08-30
> 当前负责人：Codex `/root`
> 目标：把首次开店从后台里的 prototype 向导收敛为独立、可恢复、不可绕过的开店页面。

## 已完成

### 路由与访问边界

- `apps/web/src/App.tsx` 在 `SessionGate` 中以服务端返回的 `membership.locationStatus` 为事实源。
- 状态为 `setup` 时只挂载 `/setup` 与通配重定向；不会挂载后台 `Layout`、管理路由或技师工作台。
- 直接输入或收藏 `/dashboard`、`/settings`、`/tech/*` 等深链接都会回到 `/setup`。
- 顾客公开健康表 `/forms/:key` 不属于后台，setup 状态仍保留该公开链接，避免店主登录状态误伤顾客填表。
- 已完成门店访问 `/setup` 会回到当前工作台（技师工作台或 `/dashboard`）。
- setup gate 位于双身份工作台选择之前，避免未来新增 portal 选择逻辑后形成旁路。

### 首次开店范围

`apps/web/src/features/setup/flow.ts` 现在只有四个必需步骤，顺序固定为：

1. 确认门店资料（可从 Yelp / 官网导入，再核对店名、地址、时区、营业时间）
2. 设置项目与价格（可拍照识别价目表，或手工添加；至少一个启用项目）
3. 添加员工与排班（至少一位可接单员工）
4. 测试并正式开店

导入走已有 API（`/v1/desk/yelp/search`、官网 extract、`blueprint.extract`），**确认前不写入正式数据**。不依赖 Google Places。网站主页、通知提醒、AI 电话、品牌素材、POS/硬件和高级设置仍不阻塞首次向导。

### 数据与服务端确认

- 表单继续使用真实设置查询与命令总线，不使用 localStorage 假进度或假成功。
- `location.finishSetup` 在服务端重新检查 profile、营业时间、启用项目和可接单员工，然后原子地把 `locations.status` 从 `setup` 改为 `active`。
- 完成后 `useFinishSetup` 刷新设置缓存与门店列表，页面自动进入后台；中途退出后已保存字段可在下一次登录继续。
- 写入口使用 `GuardedButton`，同时受权限和在线状态约束。

## 关键文件

| 文件 | 责任 |
| --- | --- |
| `apps/web/src/App.tsx` | setup 路由树、深链接硬门禁、完成状态下的回退路由 |
| `apps/web/src/pages/SetupWizard.tsx` | 独立响应式页面、进度条、预览和开店后能力说明 |
| `apps/web/src/features/setup/flow.ts` | 四步领域定义（不保存假进度） |
| `apps/web/src/features/setup/StepForms.tsx` | 门店、项目、员工和正式开店表单 |
| `apps/web/src/features/settings/api.ts` | 设置查询、命令调用、完成后的门店列表刷新 |
| `apps/web/src/i18n/setup.ts` | setup 页面五种界面语言文案 |
| `apps/web/src/features/setup/flow.test.ts` | 四步顺序、必需项和可选设置排除测试 |

## 验证记录（2026-08-30）

- `pnpm lint:guards`：通过。
- 全工作区 11 个包的 `typecheck`：通过。
- Web：21 个文件、94 项测试通过；包含激活认领失败不得显示成功或进入 setup 的回归测试。
- API：40 个文件、651 项测试通过；包含购买开户、认领、setup 完成门禁、Billing、Kiosk 和 Stripe 签名验证。
- DB：29 项测试通过；迁移 `0071_stripe_event_retry_lease.sql` 已在隔离库执行，RLS 覆盖测试通过。
- Stripe 事件租约回归测试：3 项通过；新事件只认领一次、超时 processing 可重试、processed 永不重放。
- `git diff --check`：通过。
- 隔离 PostgreSQL/Supabase 已启动，`pnpm setup:test:reset` 已真实创建一间已付款、已认领、待 setup 的 Growth 测试店。

## 接手建议

1. 按 `23-PURCHASE-TO-OPEN-CHECKLIST.md` 完成浏览器级真实写入和两个长期测试账号验收。
2. 重点检查中途刷新、退出后重新登录、直接访问后台深链接，以及完成后访问 `/setup` 的回退行为。
3. 若要把节假日、技能、详细班表或通知纳入后续体验，先在后台设置页接入正式命令/查询，再从“开店后再完善”说明处增加入口；不要把这些可选项重新放回阻塞向导。
4. 不要把向导步骤编号或完成状态存入浏览器；门店状态和服务端 readiness 才是跨设备事实。
