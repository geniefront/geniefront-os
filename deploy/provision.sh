#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  VPS 基线加固 + Docker。可重复执行。
#
#  用法（从本机）：
#     scp deploy/provision.sh gf-a:/tmp/ && ssh gf-a 'sudo bash /tmp/provision.sh'
#
#  ⚠️ 会关掉密码登录。跑之前必须确认密钥登录可用 —— 脚本自己也会先检查。
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

APP_USER=ubuntu
APP_DIR=/opt/geniefront
log() { echo "  ▸ $*"; }

[[ $EUID -eq 0 ]] || { echo "要用 sudo 跑"; exit 1; }

# ── 0. 关密码登录之前，先确认这个账号真的装了公钥 ─────────────────────────────
# 顺序反了就会把自己锁在门外，而 OVH 的救援模式要走控制台，很麻烦。
AUTH_KEYS="/home/${APP_USER}/.ssh/authorized_keys"
if [[ ! -s "$AUTH_KEYS" ]]; then
  echo "✗ ${AUTH_KEYS} 不存在或为空 —— 先装公钥再跑这个脚本，否则会锁死"
  exit 1
fi
log "已确认 ${APP_USER} 有 $(grep -c '^ssh-' "$AUTH_KEYS") 把公钥"

export DEBIAN_FRONTEND=noninteractive
# unattended-upgrades 是开着的，随时可能占着 dpkg 锁。
# 等它最多 5 分钟，而不是直接失败 —— 否则这个脚本在自动更新窗口里永远跑不成。
APT="apt-get -o DPkg::Lock::Timeout=300 -qq"

# ── 1. 基础包 ────────────────────────────────────────────────────────────────
log "安装 ufw / fail2ban / docker"
$APT update
# 用发行版自带的 docker.io（29.x，与官方源同代）而不是挂第三方源：
# 少一个 apt 源，而且能被已启用的 unattended-upgrades 一起打补丁。
$APT install -y \
  ufw fail2ban docker.io docker-compose-v2 ca-certificates curl jq >/dev/null

# ── 2. 防火墙 ────────────────────────────────────────────────────────────────
# 先放行 22 再启用，顺序不能反。
log "配置 ufw"
ufw --force reset >/dev/null 2>&1 || true
ufw default deny incoming  >/dev/null
ufw default allow outgoing >/dev/null
ufw allow 22/tcp  comment 'ssh'   >/dev/null
ufw allow 80/tcp  comment 'http'  >/dev/null
ufw allow 443/tcp comment 'https' >/dev/null
ufw --force enable >/dev/null
log "ufw: $(ufw status | head -1)"

# ⚠️ Docker 会自己往 iptables 里插 DOCKER 链，绕过 ufw 的 INPUT 规则。
# 也就是说 -p 0.0.0.0:3000 发布的端口在 ufw 里看不见但外网能连。
# 解决办法是端口只绑回环，由本机的反向代理对外，见 compose 文件。
log "提醒：容器端口一律绑 127.0.0.1，Docker 会绕过 ufw"

# ── 3. fail2ban ─────────────────────────────────────────────────────────────
log "配置 fail2ban"
cat > /etc/fail2ban/jail.local <<'CONF'
[DEFAULT]
bantime  = 1h
findtime = 10m
maxretry = 5
backend  = systemd

[sshd]
enabled = true
CONF
systemctl enable --now fail2ban >/dev/null 2>&1
systemctl restart fail2ban

# ── 4. SSH：关掉密码登录 ─────────────────────────────────────────────────────
# 用 drop-in 而不是改主配置：升级时不会有 .dpkg-dist 冲突要人工合并。
#
# ⚠️ 文件名必须排在 50-cloud-init.conf 前面。
# sshd 对多数关键字是【首个匹配生效】，而 OVH 的 cloud-init 在 50- 里显式写了
# PasswordAuthentication yes（他们就是靠这个给你密码登录的）。
# 用 60- 会被它压住 —— Ubuntu 自带的 60-cloudimg-settings.conf 就是这么失效的。
log "关闭密码登录"
rm -f /etc/ssh/sshd_config.d/60-geniefront.conf
cat > /etc/ssh/sshd_config.d/10-geniefront.conf <<'CONF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
MaxAuthTries 3
CONF

# 配置写错会让 sshd 起不来 —— 先校验，过了才 reload。
if ! sshd -t; then
  echo "✗ sshd 配置校验失败，已回滚"
  rm -f /etc/ssh/sshd_config.d/10-geniefront.conf
  exit 1
fi
# reload 不是 restart：现有连接不会被掐断，万一有问题还能改回来
systemctl reload ssh 2>/dev/null || systemctl reload sshd
log "sshd: $(sshd -T | grep -E '^passwordauthentication|^permitrootlogin' | tr '\n' ' ')"

# ── 5. Docker ───────────────────────────────────────────────────────────────
log "配置 Docker"
usermod -aG docker "$APP_USER"
# 日志不限制的话，一个刷屏的容器能把 70G 磁盘写满
mkdir -p /etc/docker
cat > /etc/docker/daemon.json <<'CONF'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "20m", "max-file": "5" },
  "live-restore": true
}
CONF
systemctl enable --now docker >/dev/null 2>&1
systemctl restart docker

install -d -o "$APP_USER" -g "$APP_USER" -m 0750 "$APP_DIR"

# ── 6. 汇总 ─────────────────────────────────────────────────────────────────
echo
echo "  ── 完成 ──"
echo "  docker    $(docker --version | awk '{print $3}' | tr -d ,)"
echo "  compose   $(docker compose version --short 2>/dev/null || echo '-')"
echo "  ufw       $(ufw status | head -1 | awk '{print $2}')"
echo "  fail2ban  $(systemctl is-active fail2ban)"
echo "  密码登录  $(sshd -T | awk '/^passwordauthentication/{print $2}')"
echo "  应用目录  ${APP_DIR}"
