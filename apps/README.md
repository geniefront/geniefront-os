# GenieFront OS Applications

GenieFront 多端应用集合。前端按终端形态划分为 **Web 统一端、iOS 移动端、iPad 平板端** 三大客户端，内部按账号权限切工作台：

| 目录 | 定位 | 技术栈 / 状态 |
|---|---|---|
| [`web/`](./web) | **统一 Web 前端**（桌面浏览器 / 手机 Web / 平板 Web 自适应） | React 19 + Vite + Tailwind v4 + HeroUI · 前台 + 老板 + 技师 `/tech` |
| `ipad/` | **门口 Kiosk**（配对、预约签到、walk-in、健康表） | 触屏；**不是骨架** |
| `ios/` | 原生 iOS | **空壳，未开始** |
| `api/` | **Fastify 后端服务** | Fastify + Supabase + 命令总线 |
| [`platform/`](./platform) | **GenieFront 内部运营后台**（超管 / 客服，非客户应用） | React 19 + Vite + Tailwind · **Phase 1 MVP** |
| [`marketing/`](./marketing) | **公开营销 / 自助开户**（落地定价 → Stripe Hosted Checkout） | React 19 + Vite + Tailwind · **最小生产入口**，不是最终官网 |
| [`booking/`](./booking) | **托管预约页** `book.geniefront.com/{slug}` and `/l/{slug}#g/{token}` | React 19 + Vite + Tailwind · English guest booking; manage links stay off until `BOOKING_MANAGE_PAGE_ENABLED=1` |

> 详细开发规范与前后端契约见：[`docs/16-FRONTEND-GUIDE.md`](../docs/16-FRONTEND-GUIDE.md)。

