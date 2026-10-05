# 实际验证与复现入口

所有命令在 repo 根执行。**不要把这些连接替换成生产/共享开发库。** `run-isolated.py` 清理环境，固定新建本地审查容器；`run-pristine.py` 指向同容器中的干净 audit_pristine。

## 已执行

- bootstrap-postgres.sql → `pnpm db:migrate` → `pnpm db:seed`：成功，151迁移。
- `pnpm lint:guards`：0；`pnpm exec turbo run typecheck --force`：0，16任务。
- `pnpm test:unit`：1，1215通过/1失败。
- `pnpm --filter @gf/db test`：0，127通过；注意后置污染缺陷。
- `pnpm --filter @gf/api test`：1，1566通过/9失败。
- `pnpm --filter @gf/api exec vitest run src/copilot/acceptance.test.ts`：0，23通过，单独重跑。
- `pnpm --filter @gf/db exec vitest run src/hostedBookingSlug.migration.test.ts`：0，1通过，但后置schema不同。
- 各前端 `pnpm --filter @gf/<app> exec vite build --outDir /tmp/gf-audit-20260928-<app>`：均0。
- `pnpm exec esbuild apps/api/src/index.ts --bundle --platform=node --format=esm --packages=external --outfile=/tmp/gf-audit-20260928-api.mjs`：0。
- `pnpm audit --json`：输出24条公告；非零退出属于发现公告，详见JSON。
- 原库运行定向HTTP后，因DB测试污染，新增反例又在新建 audit_pristine 完整迁移+seed 后重跑。主 extended-http.json / money-http.json 是干净库结果。
- 浏览器只访问独立本地 Vite/API，详见 browser-check.md。
- 完整备份/恢复控制实验详见 restore-check.json、pristine-restore.json。

## 定向复现

在创建同名、同端口的全新本地容器，bootstrap/迁移/seed 干净测试库后：

```sh
python3 artifacts/audit-2026-09-28/run-pristine.py pnpm exec tsx artifacts/audit-2026-09-28/extended-http.mts
python3 artifacts/audit-2026-09-28/run-pristine.py pnpm exec tsx artifacts/audit-2026-09-28/money-http.mts
python3 artifacts/audit-2026-09-28/run-isolated.py pnpm exec tsx artifacts/audit-2026-09-28/dns-rebinding.mts
python3 artifacts/audit-2026-09-28/run-isolated.py pnpm exec tsx artifacts/audit-2026-09-28/test-target.mts
python3 artifacts/audit-2026-09-28/run-isolated.py pnpm exec tsx artifacts/audit-2026-09-28/seed-guard.mts
```

HTTP脚本会在一次性库新增虚构工单、会话与付款记录，不应在非审查库运行。脚本输出实际观察值，不是全部业务健康断言；报告中的异常结果就是要复现的反例。复跑前保存原证据，因为脚本会写同名结果文件。

恢复脚本是本轮执行记录，目标数据库名固定，非幂等工具；要重跑需使用新的空测试数据库，不要无条件删除已有库。pristine-restore.py 的 audit_pristine 在本轮已预先 createdb。restore-check.py 对照只修改恢复副本函数，不是源码修复。

## 未运行

真实Supabase Auth/Storage/Realtime；真实供应商支付、邮件、短信；独立worker外部接受后kill恢复；登录后浏览器离线流程；正式Docker镜像；生产/PITR恢复和GitHub分支保护。现有测试包含SQL夹具、外部替身、源码字符串断言，不能统称2918项真实HTTP/端到端测试。

运行期间曾有审查脚本自身的两处问题：退款金额误将小费另加，已核对后改正并重跑；新建pristine连接串拼接曾误改管理员用户名，连接认证失败、未写入，随后修正。均不计为项目缺陷。
