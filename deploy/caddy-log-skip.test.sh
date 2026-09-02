#!/usr/bin/env bash
# Regression: /l and /l/* must be skipped by Caddy access logs.
# Uses the same image as deploy/compose.yml (caddy:2-alpine).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="${CADDY_IMAGE:-caddy:2-alpine}"
fail=0

need() { command -v "$1" >/dev/null || { echo "✗ missing $1"; exit 1; }; }
need docker
need python3
need curl

echo "Caddy image: ${IMAGE}"
docker image inspect "$IMAGE" >/dev/null 2>&1 || docker pull "$IMAGE"

adapt_json="$(docker run --rm \
  -v "${ROOT}/deploy/Caddyfile:/etc/caddy/Caddyfile:ro" \
  -v "${ROOT}/deploy/certs/origin.pem:/etc/caddy/origin.pem:ro" \
  -v "${ROOT}/deploy/certs/origin.key:/etc/caddy/origin.key:ro" \
  -e API_HOST=api.test \
  -e DESK_HOST=desk.test \
  -e KIOSK_HOST=kiosk.test \
  -e PLATFORM_HOST=ops.test \
  -e MARKETING_HOST=www.test \
  -e MARKETING_WWW_HOST=www2.test \
  -e BOOKING_HOST=book.test \
  "$IMAGE" caddy adapt --config /etc/caddy/Caddyfile)"

python3 - "$adapt_json" <<'PY'
import json, sys
cfg = json.loads(sys.argv[1])
found = []

def walk(o):
    if isinstance(o, dict):
        if o.get("log_skip") is True:
            found.append(o)
        for v in o.values():
            walk(v)
    elif isinstance(o, list):
        for v in o:
            walk(v)

walk(cfg)
if not found:
    print("✗ adapted JSON has no log_skip: true handler")
    sys.exit(1)

# The skip route must match both /l and leftover /l/{slug}/g/{token} paths.
ok = False
def walk_routes(o):
    global ok
    if isinstance(o, dict):
        match = o.get("match")
        handle = o.get("handle")
        paths = []
        if isinstance(match, list):
            for m in match:
                if isinstance(m, dict) and "path" in m:
                    paths.extend(m["path"])
        skip = False
        if isinstance(handle, list):
            skip = any(isinstance(h, dict) and h.get("log_skip") is True for h in handle)
        if skip and "/l" in paths and "/l/*" in paths:
            ok = True
        for v in o.values():
            walk_routes(v)
    elif isinstance(o, list):
        for v in o:
            walk_routes(v)

walk_routes(cfg)
if not ok:
    print("✗ adapted JSON log_skip is not matched to path /l and /l/*")
    sys.exit(1)
print("✓ caddy adapt: log_skip on /l and /l/*")
PY

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"; docker rm -f gf-caddy-log-skip >/dev/null 2>&1 || true' EXIT

cat > "${WORKDIR}/Caddyfile" <<'EOF'
{
	admin off
	auto_https off
}
:8080 {
	@manage path /l /l/*
	handle @manage {
		header X-Frame-Options DENY
		header Content-Security-Policy "frame-ancestors 'none'"
		header Referrer-Policy "no-referrer"
		respond "manage" 200
	}
	handle {
		respond "book" 200
	}
	log {
		output stdout
		format json
	}
	@skip_manage path /l /l/*
	log_skip @skip_manage
}
EOF

docker rm -f gf-caddy-log-skip >/dev/null 2>&1 || true
docker run -d --name gf-caddy-log-skip \
  -v "${WORKDIR}/Caddyfile:/etc/caddy/Caddyfile:ro" \
  -p 18080:8080 \
  "$IMAGE" >/dev/null

for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -sf -o /dev/null http://127.0.0.1:18080/lotus-nails; then
    break
  fi
  sleep 0.2
done

token_path='/l/shop/g/raw-token'
curl -sf -o /dev/null "http://127.0.0.1:18080${token_path}"
curl -sf -o /dev/null "http://127.0.0.1:18080/l/shop"
curl -sf -o /dev/null "http://127.0.0.1:18080/lotus-nails"
sleep 0.3

logs="$(docker logs gf-caddy-log-skip 2>&1 || true)"
echo "$logs" > "${WORKDIR}/caddy.stdout"

python3 - "$logs" "$token_path" <<'PY'
import json, sys
raw, token_path = sys.argv[1], sys.argv[2]
lines = []
for line in raw.splitlines():
    line = line.strip()
    if not line.startswith("{"):
        continue
    try:
        lines.append(json.loads(line))
    except json.JSONDecodeError:
        continue

access = [e for e in lines if "request" in e and isinstance(e.get("request"), dict)]
uris = [e["request"].get("uri", "") for e in access]
blob = "\n".join(uris)
if token_path in blob or "raw-token" in blob:
    print("✗ access log captured raw token path:")
    print(blob)
    sys.exit(1)
if not any(u == "/lotus-nails" or u.startswith("/lotus-nails") for u in uris):
    print("✗ ordinary booking path was not logged; uris=", uris)
    sys.exit(1)
if any(u == "/l" or u.startswith("/l/") for u in uris):
    print("✗ /l request was logged; uris=", uris)
    sys.exit(1)
print("✓ live logs: /lotus-nails present, /l/shop/g/raw-token absent")
PY

echo "✓ Caddy /l access-log skip"
