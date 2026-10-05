# OVH Supabase 初始部署记录（历史）

> 已于 2026-09-28（纽约时间）完成生产切换。当前状态与操作方法见 [生产运维说明](./OVH-SUPABASE-PRODUCTION.md)。下文保留切换前的部署记录。

部署日期：2026-09-28。此实例独立于现有生产 Supabase；没有修改应用连接配置，没有迁移现有用户或业务数据。

## 访问

- HTTPS / Studio：<https://supabase.geniefront.com>
- VPS：`40.160.91.177`，Ubuntu 26.04，2 vCPU / 4GB RAM / 40GB disk。
- Cloudflare：仅新增 `supabase.geniefront.com` A 记录，DNS only，300 秒 TTL。未改现有站点记录。
- Caddy：自动申请和续期 HTTPS 证书。
- Studio：HTTP Basic Auth，用户名 `supabase`，随机密码。
- 本机凭据：`/Users/naiyouzhu/.ssh/ovh-supabase-40.160.91.177.credentials.json`。
- 本机完整 Supabase 配置副本：`/Users/naiyouzhu/.ssh/ovh-supabase-40.160.91.177.env`。
- SSH 私钥：`/Users/naiyouzhu/.ssh/ovh-supabase-40.160.91.177`。
- 上述文件权限为 0600，不在 Git 仓库内。初始 VPS 密码已按系统要求更换；SSH 已禁用密码和 root 登录。

```bash
ssh -i ~/.ssh/ovh-supabase-40.160.91.177 ubuntu@40.160.91.177
```

## 运行配置

服务器目录 `/opt/supabase`，仅 root 可访问。官方 Compose 基线为 `self-hosted/v0.8.2`，commit `564eab8ad7840b13324f68b1bfac074ef8d51c21`。

- `docker-compose.yml`：官方基线，启用 ES256/JWKS 配置。
- `docker-compose.production.yml`：资源限制、数据库调优、绑定 localhost。
- `.env`：新生成的实例凭据、域名、邮件配置。
- 使用 PostgreSQL 镜像 `supabase/postgres:17.6.1.178`，实际 `SELECT version()` 报告 PostgreSQL 17.6。
- 开启数据库、Auth、REST、Realtime、Storage、imgproxy、Studio、meta、Supavisor。
- 未开启日志分析；Edge Functions 设为可选 profile。
- 2GB swap，低 swappiness；Docker 日志轮转，journald 限额。
- PostgreSQL：shared_buffers 256MB、work_mem 4MB、max_connections 100。
- 公网仅允许 TCP 22/80/443。8000、5432、5433、6543 绑定 127.0.0.1。
- Auth 使用 ES256，issuer 为 `https://supabase.geniefront.com/auth/v1`，兼容当前项目 JWKS 校验方式。
- 邮件复用现有 Resend API key，通过 SMTP STARTTLS 587；已验证认证，未发送邮件。
- 公开注册关闭；匿名、电话登录和邮件自动确认关闭。切换时审核 redirect URLs 与注册策略。

```bash
sudo systemctl status supabase
sudo sh -c 'cd /opt/supabase && docker compose ps'
sudo sh -c 'cd /opt/supabase && docker compose logs --tail 100 auth'
sudo systemctl restart supabase
```

数据库访问使用 SSH 隧道，不能直接从公网连接：

```bash
ssh -i ~/.ssh/ovh-supabase-40.160.91.177 \
  -L 15433:127.0.0.1:5433 -L 16543:127.0.0.1:6543 \
  -N ubuntu@40.160.91.177
```

15433 为数据库直连，16543 为事务连接池。将来应用接入需创建/迁移受 RLS 约束的 `app_user`；不可用 postgres 或 service_role 替代运行时权限。

## 备份与恢复

- 每日 07:15 UTC（随机延迟最多 5 分钟），保留最新 7 份成功备份。
- 路径 `/var/backups/supabase`，root-only。
- 包含 `postgres`、`_supabase` 的 custom-format dump，globals/roles、配置、Storage 文件、数据库加密密钥卷，以及 SHA256 校验。
- 备份含敏感配置，不能分享或提交到 Git。
- 首份/最终配置备份另下载至本机 `~/.local/share/geniefront/supabase-ovh-backups/`。
- 尚未接入自动异地备份；电脑上的副本是一次性下载。
- 这不是 PITR，也不是高可用。接入业务后，数据库 dump 与 Storage 文件的跨服务一致性需要停写窗口或额外一致性方案。

```bash
sudo systemctl start supabase-backup.service
sudo journalctl -u supabase-backup.service -n 30
sudo bash /opt/supabase/ops/restore-check.sh
```

`restore-check.sh` 在独立容器、无网络中恢复角色、密钥、两个数据库，检查 schema/migration 表，结束后删除演练容器。不会覆盖当前实例。已成功恢复 33 张 public/auth/storage 表、77 条 Auth migration、70 条 Storage migration。

## 健康检查

每 5 分钟检查容器状态、HTTPS/Auth、磁盘和备份时效。结果写入 systemd journal；失败使对应 oneshot unit 失败。**尚无对外告警渠道**。

```bash
sudo systemctl start supabase-health.service
sudo journalctl -u supabase-health.service -n 20
sudo systemctl list-timers 'supabase-*'
```

## 已完成验证

- HTTPS 证书验证；Studio 未登录返回 401。
- API 创建临时测试用户、密码登录、refresh、用户查询。
- ES256 签名、issuer、audience 与公开 JWKS 验证；无对外泄漏私钥/对称密钥。
- REST 读写联通；RLS 隔离两个不同用户及匿名访问。
- 私有 Storage bucket 上传/下载；临时用户、表和文件均清理。
- SMTP STARTTLS + 登录认证，没有发送邮件。
- 完整逻辑备份及隔离恢复。
- VPS 完整重启后 10 个容器自动启动且健康；登录/RLS/Storage/SMTP 冒烟再次通过。
- 本机备份下载成功且 SHA256 校验通过。

这些是功能冒烟测试，不是业务负载或高可用验证。空闲时容器合计约 1.5GB 内存。

## 切换前仍需完成

1. **数据库安全补丁核对**：最新公告列出 PostgreSQL 17.11 修复，而本次官方常规镜像仍报告 17.6；尚未确认包含这些修复。接收正式数据前需要确认供应商回补情况或升级经过验证的兼容镜像。不能仅凭镜像发布时间断言已修复。参考 <https://supabase.com/changelog/postgres-15-19-17-11-breaking-changes>。
2. 自动异地备份与外部故障告警。
3. 迁移业务 schema/角色/RLS、现有 Auth 用户和数据；评估会话、密钥、Storage 迁移与回滚。
4. 验证实际认证邮件投递、登录回调和所需 OAuth 配置。
5. 应用与数据库之间的私网/VPN/受限连接方案，以及真实负载测试。
6. 最后才修改应用配置并切换流量；本次没有执行切换。
