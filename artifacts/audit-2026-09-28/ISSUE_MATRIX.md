# 问题复核矩阵

详细条件、源码定位、证据和关闭要求见 [REPORT.md](REPORT.md)。本轮不修复代码。

| ID | 优先级 | 问题 | 本轮状态 | 证据 |
|---|---|---|---|---|
| P1-01 | P1 | 无折扣权限覆盖价格，含负数 | 再次复现、影响扩展 | extended-http.json prices/addItem |
| P1-02 | P1 | 技师读取他人订单和金额 | 再次复现 | http-repro.log、extended-http.json orderFilters |
| P1-03 | P1 | DNS校验与实际连接脱节 | 再次复现 | dns-rebinding.log |
| P1-04 | P1 | 迁移守卫未验证管理员目标 | 纯配置再次复现；无连接 | migration-guard.log |
| P1-05 | P1 | 测试目标身份校验不完整 | 部分保护已新增，影响收窄 | test-target.log、seed-guard.log |
| P1-06 | P1 | 工单可关联另一组织客户 | 新增，干净库HTTP复现 | extended-http.json crossCustomer/crossService |
| P1-07 | P1 | 会话撤销后等锁请求仍提交 | 新增，干净库HTTP+PG barrier复现 | extended-http.json revocation |
| P2-01 | P2 | 健康表token进入URL/日志面 | 源码仍成立，真实日志未验证 | links.ts、Caddyfile；browser-check.md仅失效页 |
| P2-02 | P2 | 持久离线缓存与no-store冲突 | 源码+真实响应头确认 | api.ts、server.ts、http-repro.log |
| P2-03 | P2 | CI不自动执行测试 | 源码确认；初跑10失败 | verify.yml、unit.log、api.log |
| P2-04 | P2 | 锁文件安全公告未处理 | 重新扫描，24条 | dependency-audit.json |
| P2-05 | P2 | 幂等key不校验请求内容 | 新增，干净库HTTP复现 | extended-http.json idempotency |
| P2-06 | P2 | 迁移回退测试污染最新schema | 新增，独立测试+恢复对照复现 | migration-pollution.log、restore-check.json、pristine-restore.json |

没有已修复关闭项。原seed远程写入描述已收窄；备份恢复的初步生产疑虑已排除。未经验证的检查点不计入13项。
