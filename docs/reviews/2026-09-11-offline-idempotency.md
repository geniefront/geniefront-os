# C 线：弱网、中断与幂等

> 护栏脚本：`scripts/check-idempotency.mjs`（已接入 `lint-guards.sh` 第 13 条）

## 前提：为什么这条线重要

门店的网不稳，超时是常态 —— 而**超时不代表没写进去**。请求可能已经落库，
只是回程丢了。前台看到报错会再按一次，这时唯一能防住重复写入的就是幂等键。

命令契约层早就把这件事声明清楚了（`idempotency: 'required' | 'optional'`），
服务端也照着执行。问题全部出在**前端怎么生成那个键**。

---

## C-1 ⭐⭐ 幂等键随「调用」走而不是随「意图」走

`runCommand` 的第四个参数默认值是 `crypto.randomUUID()` —— **每次调用现生成**。
于是只要调用方不显式传一个稳定的键，`idempotency: 'required'` 就是个摆设：
重按一次 = 一个新键 = 服务端眼里两条互不相干的命令。

排查了全部 107 处命令调用，其中注册表要求必须带键的 15 处。发现 8 处不稳定：

| 位置 | 命令 | 重按一次的后果 |
|---|---|---|
| `features/dayclose/api.ts` | `dayclose.payTips` | **现金小费发两遍** |
| `features/rotation/api.ts` | `rotation.assign` | 同一位技师被派两次 |
| `features/tech/api.ts` | `staff.recordDirectCashTip` | 小费记两笔 |
| `pages/Queue.tsx` ×3 | `ticket.addItem` / `moveItemStaff` / `moveItemResource` | 加项加两条（会一路进结账金额）、房间占用写两条 |
| `components/AppointmentDrawer.tsx` ×2 | `ticket.addItem` / `appointment.addItem` | 同上 |

前三处把键生成在 `mutationFn` **内部**，后五处生成在**提交那一行**。
两种都是「随调用走」。

### 修法

新增 `lib/idempotency.ts` 的 `useAttemptKey`，语义是**一次意图一个键**：

```
第一次调用    → 生成键
失败后再调用  → 沿用同一个键   （这正是重试，服务端据此去重）
成功后再调用  → 换新键         （这是另一次意图，本来就该写第二条）
```

弹窗类的操作则沿用这个代码库**本来就有**的约定 —— 弹窗打开时铸一次
`attemptKey`，提交时拼进业务身份（`queue-movestaff-${ticketItemId}-${staffId}-${attemptKey}`）。
排队页的入座与签到弹窗本来就是这么写的，只是没推广到其余几处。

### 护栏的一个取舍

`scripts/check-idempotency.mjs` 只看**传给 mutation 调用**的键，
不看所有 `idempotencyKey: randomUUID()`。

「铸一次、存进 state、提交时复用」是**正确**写法 —— 排队页把现场加项先攒在
`addedAddOns` 里、每条带自己的键，提交时原样带上。不区分的话，这条检查会把
对的写法一起报红，然后它就会被整个忽略。

---

## C-2 ⭐⭐ 断网检测写好了，但没有任何调用方

`lib/offline.ts` 的 `watchNetwork` 对自家 `/health` 打心跳，注释写明了理由：

> 不只信 `navigator.onLine` —— 它只反映网卡有没有链路，门店最常见的情况是
> 「连着 WiFi 但路由器出不去」，那时 onLine 仍是 true。

**而它在全仓没有任何调用方。** `session.tsx` 用的正是这个模块说不够的那个信号：
裸的 `window.addEventListener('online' | 'offline')`。

所以那条最常见的门店故障 —— 连着 AP、上行断了 —— 系统完全察觉不到：
`isOnline` 一直是 true，`GuardedButton` 照常点亮，每一次写入以网络错误收场，
而整套离线只读降级从头到尾没有生效。

**已接上。** 顺带补了另一件：

### C-3 恢复联网后不会重取

`isOnline` 翻回 true 时此前什么也没发生。`refetchOnWindowFocus` 覆盖的是
「切走再切回」，而门店 iPad 常年开着不切走 —— 断网期间的旧数据会一直挂在屏上，
而前台没有理由怀疑它是旧的。

现在恢复联网时整体 `invalidateQueries()` 一次。

---

## C-4 复核通过的部分

- **自动重试不会造成重复写入**：`queryClient` 的 `retry: 1` 只配在 `queries` 上，
  mutation 默认不重试。真正的风险是**人工重按**，也就是 C-1。
- **乐观更新的回滚是完整的**：全仓只有通知模块用乐观更新，两处 `onMutate`
  都配了 `onError` 快照回滚与 `onSettled` 重取。
- **离线时的写入闸门是双层的**：`GuardedButton` 在界面层拦，
  `runCommand` 在数据层再拦一次（`commandGuardOnline`），
  防的是「有人忘了用 GuardedButton」。
- **不做离线写入队列是刻意的**，理由写在 `lib/permissions.ts`：轮牌顺序、派单、
  开单是全局强一致状态，离线改再合并必然冲突（两个前台各自派了同一个技师）。
  这个取舍是对的，不改。

---

## 验证

- `pnpm --filter @gf/web test` → 69 文件 **453 项**通过（本轮新增 3 条）
- `pnpm --filter @gf/web typecheck` → 干净
- `bash scripts/lint-guards.sh` → ✓ 全部通过（含新增第 13 条）
- 扫描口径本身也修过一次：命令名一度从 `runCommand<…>` 的**泛型**里取，
  把 `'no_tip' | 'received_direct'` 当成了命令名，于是漏报了两条。
  修正后 15 处要求带键的命令一个不少。
