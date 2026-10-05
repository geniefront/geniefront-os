# 浏览器验证边界

2026-09-28，Codex 内置浏览器，独立临时页面。

- Vite：127.0.0.1:57209，API：127.0.0.1:57210；Supabase 配置为未运行的 127.0.0.1:59999 和虚构 key。没有使用真实 Auth。
- 登录页：正常显示邮箱、密码、登录、Google 登录按钮；已查看截图，无空白页和错误遮罩，捕获的 error/warn 日志为空。未输入凭据或执行 Google 登录。
- `/forms/intake?t=fs_audit_invalid`：最终显示 “This form link is no longer available” 及联系门店获取新链接的提示，无表单内容。捕获的 error/warn 日志为空。
- [失效表单截图](browser-invalid-form.png)、[可访问性文本](browser-invalid-form.txt)。
- 只验证以上两页。未验证登录后的看板、持久离线刷新、真实 Auth/Realtime/Storage、iPad 触控、多语言全量和打印布局。没有把以上结果当成整个前端 E2E 通过。
