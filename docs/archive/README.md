# 归档文档

这些文件 **不再作为现行事实**。保留是为了查「当时发现过什么、怎么修的」，不要用它们判断能不能上线。

现行地图：[`../CURRENT-ARCHITECTURE.md`](../CURRENT-ARCHITECTURE.md)  
怎么测：[`../qa/TEST-PLAYBOOK.md`](../qa/TEST-PLAYBOOK.md)

| 原路径 | 为什么挪走 |
|---|---|
| `audit/FUNCTIONAL_AUDIT.md` | 2026-08-30 的缺陷清单，仍把 P0 写成未修。那些票已在后续批次关掉，留在原位会误导上线判断 |
| `audit/LAUNCH_BLOCKERS.md` | 同上，blocker 表过时 |
| `audit/IMPLEMENTATION_PLAN.md` | 对应那轮修复的施工单，已做完 |
| `21-TECH-WORKSPACE-HANDOFF.md` | 写技师端还是 localStorage prototype。现行实现是 `apps/web/src/features/tech` 接真 API |
| `superpowers/plans/*` | 已落地的施工计划（托管预约、消息模板），正文已吸收进 13 / 26 / 27 |

没有搬：`audit/CURRENT_STATE.md`（2026-08-31 快照，顶部已注明范围）、`audit/ENTERPRISE_AUDIT_TRACKER.md`（仍在记后续批次）、`audit/QUEUE_MODAL_AUDIT.md`（已修，留了一条「工时不可编辑」的产品边界）。
