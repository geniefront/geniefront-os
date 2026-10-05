# 自建 Supabase：生产切换与运维

2026-09-28（纽约时间，UTC 为 2026-09-29）完成生产切换。源项目 `qiuyubvhirjtglonbkon` 保留，生产应用已使用 `https://supabase.geniefront.com`。staging/dev 仍使用原项目，没有迁移。

## 本次迁移范围与证据

- 132 张 public 业务表，以及 gf_private、Auth 用户/身份数据、Storage bucket/object 元数据、角色、RLS、函数、触发器。
- 最终导入逐表核对 161 个 COPY 数据块，全部行数匹配；2 个用户、4 个桶、3 个文件。
- 5 个托管版新增 Auth 表/字段对应的 COPY 块为空，兼容处理仅略过这些空块，没有丢弃任何有数据的表。
- 3 个 Storage 对象重新上传并校验 SHA256；保留原 owner_id；业务记录中原 Supabase 文件 URL 已更新。
- Google OAuth 管理项目为 `geniefrontos`（GenieFrontOS），已验证管理账号 `yisheng.live@gmail.com`。使用原客户端；新回调 `https://supabase.geniefront.com/auth/v1/callback` 已由用户保存，原回调保留。
- SMTP 切换为当前生产 Maileroo；自定义认证邮件模板和标题已复制；SMTP TLS/认证验证通过，没有主动发送测试邮件。
- 源和目标的业务 RLS 策略均为 165 条；源库 137 张表已安装写入保护，源 Vault secrets 数量为 0。
- 原用户通过新 Auth 获得的令牌，在 gf-a/gf-b 的身份、门店上下文、设置和员工列表接口验证通过。另一个无门店用户仍无门店可见。
- 保留线上 API 镜像 `geniefront/api:maileroo-production-1790635820741`，没有发布工作区其他业务代码。
- 前端直接基于线上已部署资源替换 Supabase URL/公开 key，JS 文件名增加 `-sb20260929`，更新 Service Worker cache 名称；Cloudflare cache 已清理。
- 新生产完整逻辑备份已在隔离容器恢复成功：Auth 用户 2、桶 4、public/auth/storage 表 166。
- 浏览器前台登录页正常。完整 Google 用户登录及实际认证邮件收件仍需用户用原生产账号做最终体验验证。

## 当前连接

| 节点 | 公网地址 | WireGuard 地址 |
|---|---|---|
| Supabase | 40.160.91.177 | 10.77.0.1 |
| gf-a | 40.160.83.74 | 10.77.0.2 |
| gf-b | 15.204.210.119 | 10.77.0.3 |

数据库仅绑定 localhost 和 WireGuard IP。应用通过 `10.77.0.1:6543` 的 Supavisor 事务池，用 `app_user.geniefront-ovh` 登录；实际数据库角色为 `app_user`，没有 SUPERUSER/BYPASSRLS。

WireGuard `gf-db` 开机启动；Supabase systemd unit 依赖它。数据库服务器 UDP 51820 只允许两台 API 的公网 IP。实测两台 API 到数据库的加密网络 RTT 约 0.6–0.8ms。

- Studio / API：<https://supabase.geniefront.com>。
- Studio 用户名 `supabase`，密码见本机 `~/.ssh/ovh-supabase-40.160.91.177.credentials.json`。
- SSH：`ssh -i ~/.ssh/ovh-supabase-40.160.91.177 ubuntu@40.160.91.177`。
- Supabase 配置：服务器 `/opt/supabase/.env`；本机副本 `~/.ssh/ovh-supabase-40.160.91.177.env`。
- 生产应用配置：本仓库 `.env.production` 与两台服务器 `/opt/geniefront/.env`。
- 新用户注册已恢复；匿名/电话登录仍关闭，符合原生产配置。
- 自建不支持原托管 Management API；生产 `.env.production` 中旧 `SUPABASE_ACCESS_TOKEN` 已清空，原 token 只保留在私密回滚快照中。

本机执行生产数据库维护前，先建立隧道（不要指向本地开发数据库）：

```bash
ssh -i ~/.ssh/ovh-supabase-40.160.91.177 \
  -L 127.0.0.1:15433:127.0.0.1:5433 \
  -N ubuntu@40.160.91.177
```

`.env.production` 的迁移连接已使用 `127.0.0.1:15433`。日常应用使用 WireGuard，不依赖这条人工隧道。

## 备份

- 每日 07:15 UTC（随机延迟最多 5 分钟），本机保留 7 份成功备份。
- R2 私有桶：`geniefront-prod-backups`，前缀 `supabase/ovh-production/`。
- 每份备份用独立 nonce 的 AES-256-GCM 加密后上传；上传后重新下载、校验认证标签和明文 SHA256。
- R2 当前保留上传的历史副本，没有配置自动过期规则；需要根据增长量后续设置生命周期。
- 本机 R2 凭据：`~/.ssh/geniefront-r2-backup.env`；服务器 `/opt/supabase/r2-backup.env`，均为 0600。
- 解密密钥在服务器 `/root/.config/geniefront/backup-encryption.key` 和本机 `~/.ssh/geniefront-supabase-backup-encryption.key`，**不要丢失**。密钥不随备份上传 R2。
- 包含两个数据库、角色、Supabase 配置、应用恢复配置、Storage 文件、数据库密钥卷、WireGuard 配置与邮件模板。
- 这是逻辑备份，不是 PITR；数据库和 Storage 文件跨服务严格一致的恢复点仍需停写备份窗口。

```bash
sudo systemctl start supabase-backup.service
sudo journalctl -u supabase-backup.service -n 20
sudo cat /opt/supabase/r2-last-success.json
sudo bash /opt/supabase/ops/restore-check.sh
```

`restore-check.sh` 在独立、无网络的容器恢复最近本机备份，不覆盖生产。R2 文件格式为 `GFBK1` + 12 字节 nonce + AES-GCM ciphertext + 16 字节 tag；验证标签成功后才可使用解密结果。

## 状态检查

```bash
sudo systemctl status supabase
sudo sh -c 'cd /opt/supabase && docker compose ps'
sudo systemctl start supabase-health.service
sudo journalctl -u supabase-health.service -n 20
sudo wg show gf-db latest-handshakes
```

健康检查每 5 分钟检查容器、HTTPS/Auth、磁盘、本机备份和 R2 备份时效。结果写 systemd journal；**尚未接入外部通知渠道**。

Cloudflare 对部分 Python HTTP 客户端返回 1010；没有为验证放宽 WAF。公网页面使用正常浏览器验证，受保护 API 的身份/数据验证通过 SSH 隧道分别直连两台 origin 完成。

## 旧库与回滚

源托管项目保留，未暂停、未删除；仍可能产生托管费用。

- 源 public/gf_private 业务表、auth.users/identities、storage.buckets/objects 添加了 `gf_ovh_migration_write_fence` 语句触发器，阻止旧连接写入。
- 源 Auth 新注册已关闭。
- 两台 API 的旧环境、镜像名和静态资源保存在 `/opt/geniefront-before-supabase-20260929`。
- 本机原始环境、导出、最终数据快照和检查记录：`~/.local/share/geniefront/supabase-migration-20260928/`，私密目录，不可提交 Git。
- 目标导入记录：`/opt/supabase/migration-20260928/`。

**切换后目标已经可能产生新写入，不能仅把连接指回旧库。** 回滚需要先冻结新实例写入、备份/回迁增量并验证，再恢复旧应用环境和静态资源，最后移除源库写入保护、恢复源注册。否则会丢失切换后的数据。

不要提前删除旧项目或上述快照。客户端切换后需重新登录；现有应用签发的设备/PIN 令牌所用 APP_JWT_SECRET 与业务加密密钥均保留。

## 尚需跟进的运维事项

- 当前源库和目标实际 PostgreSQL 都是 17.6。目标镜像为较新官方常规构建 `17.6.1.178`，但尚未证实包含 17.11 公告中的所有安全修复；仍需安排兼容镜像的补丁核对/升级。参考 <https://supabase.com/changelog/postgres-15-19-17-11-breaking-changes>。
- 外部告警渠道、R2 生命周期和真实高峰负载测试尚未配置/完成。
- 当前为单数据库节点，2C4G，不具备数据库高可用。
