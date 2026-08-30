# GenieFront OS Applications

GenieFront 多端应用集合。前端按终端形态划分为 **Web 统一端、iOS 移动端、iPad 平板端** 三大客户端，内部按账号权限切工作台：

| 目录 | 定位 | 技术栈 / 状态 |
|---|---|---|
| [`web/`](./web) | **统一 Web 前端**（桌面浏览器 / 手机 Web / 平板 Web 自适应） | React 19 + Vite + Tailwind v4 + HeroUI · **主力开发中**（涵盖前台调度、老板看板、技师排班、自助签到） |
| `ipad/` | **iPad 平板端**（前台触屏调度 / 自助签到 Kiosk） | 触屏大尺寸工作台 / 骨架 |
| `ios/` | **iOS 移动端**（技师接单打卡 / 老板移动看板） | 移动端原生/跨端 App / 骨架 |
| `api/` | **Fastify 后端服务** | Fastify + Supabase + 命令总线 |
| [`platform/`](./platform) | **GenieFront 内部运营后台**（超管 / 客服，非客户应用） | React 19 + Vite + Tailwind · **Phase 1 MVP** |

> 详细开发规范与前后端契约见：[`docs/16-FRONTEND-GUIDE.md`](../docs/16-FRONTEND-GUIDE.md)。

