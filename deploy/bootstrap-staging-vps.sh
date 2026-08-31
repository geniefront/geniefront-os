#!/usr/bin/env bash
# Run only after the new public key is installed and the VPS host fingerprint is verified.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PUB_KEY="${HOME}/.ssh/geniefront-staging.pub"
[[ -s "$PUB_KEY" ]] || { echo "✗ 缺少 ${PUB_KEY}"; exit 1; }

ssh -o BatchMode=yes gf-staging-bootstrap true
scp -q "$ROOT/deploy/provision.sh" gf-staging-bootstrap:/tmp/gf-provision.sh
scp -q "$PUB_KEY" gf-staging-bootstrap:/tmp/gf-staging.pub
ssh gf-staging-bootstrap \
  "APP_USER=ubuntu APP_DIR=/opt/geniefront-staging APP_PUBLIC_KEY_FILE=/tmp/gf-staging.pub bash /tmp/gf-provision.sh"

# provision.sh disables root SSH but preserves the active connection; verify the final account now.
ssh -o BatchMode=yes -o ConnectTimeout=8 gf-staging true
echo "✓ staging VPS 已加固；后续使用 gf-staging"
