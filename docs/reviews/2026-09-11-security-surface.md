# F 线：安全面

> 本线只审前端可达的攻击面。权限越权见 [A 线](./2026-09-11-permission-matrix.md)。

## F-1 ⭐⭐ 上传的是原文件，不是压缩后的那一份

`lib/imageUpload.ts` 算出了 `optimizedDataUrl`（canvas 重编码、缩到 512px、
转 webp），然后**把原始 `File` 传了上去**。压缩结果只在云存储不可用时才用得上。

代码读起来像是做了清洗，实际没有。三个后果都是真的：

| | |
|---|---|
| 体积 | 15MB 的原图整份进公开 bucket，512px 上限从未生效 |
| 隐私 | 手机拍的照片带着 **EXIF** 一起公开 —— 其中包含拍摄地点的 GPS 坐标 |
| 载荷 | 原文件里夹带的任何东西都原样留下 |

而 canvas 重编码这一步本身就是清洗：出来的是一张纯位图，夹带内容不会留下。

**已修**：上传压缩后的 Blob。

### 顺带：扩展名此前取自用户给的文件名

`file.name.split('.').pop()` —— 等于让调用方决定这个对象以什么 Content-Type
被回吐出来。`logo.html` 会被存成 `.html`，直接访问那个公开 URL 时浏览器当网页渲染。
已改为取压缩结果的实际类型。

## F-2 ⭐ SVG 上传

SVG 是唯一绕开 canvas 重编码的格式（代码里有一条单独的早返回，直接读成 Data URL）。

经 `<img>` 渲染时 SVG 里的脚本**不会**执行 —— 这一层是安全的。危险在另一头：
文件原样存进公开 bucket，**直接访问那个存储 URL 时脚本会执行**，
而那是一个看起来完全可信的域名。跨源限制让它读不到本站数据，
但拿去做钓鱼页是够用的。

**已修：不再接受 SVG。** 不走「清洗 SVG」那条路 —— 按正则剔 `<script>`
与事件属性是出了名的挡不住（实体编码、命名空间、`<foreignObject>`…）。
而这条路径上 SVG 本来也没有优势：所有格式最终都被压成 512px 的 webp 位图，
矢量留不住。

两层都判：`accept` 属性只是文件选择器的提示，**拖拽进来的不受它约束**。

## F-3 复核通过

- **全站只有一处 `dangerouslySetInnerHTML`**（`HealthForms.tsx:1046`，渲染
  服务端生成的二维码 SVG）。这处是安全的：`qrSvg` 用 qrcode 库把 URL 编成方块，
  URL 不会出现在输出文本里，且 URL 由服务端自己拼。
  `apps/api/src/forms/qr.ts` 的注释本身就写明了这条边界。
- **没有任何 `.innerHTML =` 直接赋值。**
- **localStorage 里没有认证凭据** —— 只有语言、门户、门店选择、头像偏好。
  token 由 Supabase SDK 自己管。
- **公开端点有限流**：`public/rateLimit` 覆盖公开预约、健康表链接、
  密码重置、注册结账、Kiosk。
- **安全响应头齐全**（`deploy/Caddyfile`）：HSTS、`X-Content-Type-Options: nosniff`、
  `X-Frame-Options: SAMEORIGIN`、`Referrer-Policy`，而且有专门的
  `deploy/caddy-headers.test.sh` 守着。

## F-4 待办：没有 Content-Security-Policy

上面那组头里唯独缺 CSP。它是纵深防御的最后一层 —— 即便出现了 XSS，
CSP 能挡住外发与内联执行。

**本轮没有加**，理由是它不能盲改：React SPA 的内联样式、HeroUI、
Supabase 的连接目标都要逐一放行，而配错的表现是**白屏**。
这件事需要在 staging 上用 `Content-Security-Policy-Report-Only` 泡一段时间，
收集违规报告，再切成强制。

建议的起点（report-only）：

```
default-src 'self';
script-src 'self';
style-src 'self' 'unsafe-inline';          # Tailwind/HeroUI 的内联样式
img-src 'self' data: blob: <supabase-storage-host>;
connect-src 'self' <api-host> <supabase-host>;
frame-ancestors 'self';
base-uri 'self';
form-action 'self';
```

## 验证

- `apps/web/src/lib/imageUpload.test.ts` 4 条，全绿
- 反向验证：把上传参数改回原始 `File` 后红 1 条；把扩展名改回取自
  `file.name` 后再红 1 条 —— 两条断言都不是摆设
