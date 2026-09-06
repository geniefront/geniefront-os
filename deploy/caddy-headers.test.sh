#!/usr/bin/env bash
# Regression: hosted JSON keeps Referrer-Policy no-referrer; HTML /l keeps
# no-referrer, DENY, and frame-ancestors none. The site-wide
# strict-origin-when-cross-origin must not win on those paths.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="${CADDY_IMAGE:-caddy:2-alpine}"

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
hosted = []
manage = []

def paths_of(match):
    out = []
    if not isinstance(match, list):
        return out
    for m in match:
        if isinstance(m, dict) and "path" in m:
            out.extend(m["path"])
    return out

def headers_of(handle):
    found = []
    if not isinstance(handle, list):
        return found
    for h in handle:
        if not isinstance(h, dict):
            continue
        if h.get("handler") == "headers":
            found.append(h)
        nested = h.get("routes") or h.get("handle")
        if nested:
            found.extend(headers_of(nested if isinstance(nested, list) else [nested]))
    return found

def walk(o):
    if isinstance(o, dict):
        match = o.get("match")
        handle = o.get("handle")
        paths = paths_of(match)
        if "/public/v1/hosted" in paths or "/public/v1/hosted/*" in paths:
            hosted.extend(headers_of(handle) if isinstance(handle, list) else [])
        if "/l" in paths and "/l/*" in paths:
            manage.extend(headers_of(handle) if isinstance(handle, list) else [])
        # Caddy header matcher often sits as its own route with match+handle headers
        hdrs = headers_of(handle) if isinstance(handle, list) else []
        if hdrs and ("/public/v1/hosted" in paths or "/public/v1/hosted/*" in paths):
            hosted.extend(hdrs)
        for v in o.values():
            walk(v)
    elif isinstance(o, list):
        for v in o:
            walk(v)

walk(cfg)

def header_map(entries):
    resp = {}
    for h in entries:
        r = (h.get("response") or {})
        s = r.get("set") or r.get("add") or {}
        if isinstance(s, dict):
            for k, v in s.items():
                resp[k.lower()] = v
        elif isinstance(r.get("headers"), dict):
            for k, v in r["headers"].items():
                resp[k.lower()] = v
    return resp

# Also collect any route whose match is hosted_json via vars/path
def dump_referrer(entries):
    vals = []
    blob = json.dumps(entries)
    if "no-referrer" in blob:
        vals.append("no-referrer")
    if "strict-origin-when-cross-origin" in blob:
        vals.append("strict-origin")
    return vals, blob

hvals, hblob = dump_referrer(hosted if hosted else cfg)
if "no-referrer" not in json.dumps(cfg) or "@hosted_json" in str(cfg):
    pass
if "no-referrer" not in json.dumps(cfg):
    print("✗ adapted JSON has no no-referrer header")
    sys.exit(1)
# Hosted JSON and HTML manage must both keep no-referrer in the adapted config.
text = json.dumps(cfg)
if text.count("no-referrer") < 2:
    print("✗ adapted JSON should keep no-referrer for hosted JSON and HTML /l")
    sys.exit(1)
if "frame-ancestors 'none'" not in text and "frame-ancestors \\u0027none\\u0027" not in text:
    # Caddy may store as frame-ancestors 'none'
    if "frame-ancestors" not in text:
        print("✗ adapted JSON missing frame-ancestors")
        sys.exit(1)
if "DENY" not in text and "deny" not in text.lower():
    print("✗ adapted JSON missing X-Frame-Options DENY")
    sys.exit(1)
if text.count("no-store, no-cache, must-revalidate") < 5:
    print("✗ adapted JSON missing anti-cache headers for missing assets")
    sys.exit(1)
print("✓ caddy adapt: no-referrer + frame denial + asset cache defense present")
PY

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"; docker rm -f gf-caddy-headers >/dev/null 2>&1 || true' EXIT

mkdir -p "${WORKDIR}/srv/web/assets"
echo '/* test asset */' > "${WORKDIR}/srv/web/assets/app.js"

cat > "${WORKDIR}/Caddyfile" <<'EOF'
{
	admin off
	auto_https off
}
# Simulated Fastify upstream: it already emits no-referrer.
:8083 {
	header Referrer-Policy "no-referrer"
	respond "upstream" 200
}
# API+desk: site-wide strict-origin must not win on hosted JSON, and the
# downstream response must contain exactly one Referrer-Policy value.
:8080 {
	root * /srv/web
	handle /assets/* {
		@exists file
		header @exists Cache-Control "public, max-age=31536000, immutable"
		@notExists not file
		header @notExists Cache-Control "no-store, no-cache, must-revalidate"
		file_server
	}
	@hosted_json path /public/v1/hosted /public/v1/hosted/*
	handle @hosted_json {
		reverse_proxy 127.0.0.1:8083
	}
	handle {
		respond "other" 200
	}
	header {
		X-Frame-Options SAMEORIGIN
		-Server
	}
	@hosted_json_hdr path /public/v1/hosted /public/v1/hosted/*
	header @hosted_json_hdr >Referrer-Policy "no-referrer"
	@not_hosted_json not path /public/v1/hosted /public/v1/hosted/*
	header @not_hosted_json Referrer-Policy "strict-origin-when-cross-origin"
}
# Booking: HTML /l protections live here, not on the API vhost.
:8081 {
	@manage path /l /l/*
	handle @manage {
		header X-Frame-Options DENY
		header Content-Security-Policy "frame-ancestors 'none'"
		header Referrer-Policy "no-referrer"
		respond "manage" 200
	}
	handle {
		header -X-Frame-Options
		respond "book" 200
	}
	header {
		-Server
	}
}
EOF

docker rm -f gf-caddy-headers >/dev/null 2>&1 || true
docker run -d --name gf-caddy-headers \
  -v "${WORKDIR}/Caddyfile:/etc/caddy/Caddyfile:ro" \
  -v "${WORKDIR}/srv:/srv:ro" \
  -p 18081:8080 -p 18082:8081 \
  "$IMAGE" >/dev/null

for i in $(seq 1 20); do
  if curl -sf -o /dev/null http://127.0.0.1:18081/public/v1/shop \
     && curl -sf -o /dev/null http://127.0.0.1:18082/lotus-nails; then
    break
  fi
  sleep 0.2
done

hdr() { curl -sSI "$1" | tr -d '\r'; }

hosted_h=$(hdr http://127.0.0.1:18081/public/v1/hosted/manage)
other_h=$(hdr http://127.0.0.1:18081/public/v1/shop)
manage_h=$(hdr http://127.0.0.1:18082/l/lotus-nails)

echo "$hosted_h" | grep -qi '^referrer-policy: no-referrer$' \
  && echo "✓ hosted JSON Referrer-Policy is no-referrer" \
  || { echo "✗ hosted JSON headers:"; echo "$hosted_h"; exit 1; }

hosted_referrer_count=$(echo "$hosted_h" | grep -ci '^referrer-policy:' || true)
[[ "$hosted_referrer_count" -eq 1 ]] \
  && echo "✓ hosted JSON emits one Referrer-Policy header" \
  || { echo "✗ hosted JSON emitted ${hosted_referrer_count} Referrer-Policy headers"; echo "$hosted_h"; exit 1; }

echo "$other_h" | grep -qi '^referrer-policy: strict-origin-when-cross-origin$' \
  && echo "✓ ordinary API Referrer-Policy stays strict-origin-when-cross-origin" \
  || { echo "✗ ordinary API headers:"; echo "$other_h"; exit 1; }

echo "$manage_h" | grep -qi '^referrer-policy: no-referrer$' \
  && echo "$manage_h" | grep -qi '^x-frame-options: DENY$' \
  && echo "$manage_h" | grep -qi "frame-ancestors 'none'" \
  && echo "✓ HTML /l keeps no-referrer, DENY, frame-ancestors none" \
  || { echo "✗ HTML /l headers:"; echo "$manage_h"; exit 1; }

asset_hit_h=$(hdr http://127.0.0.1:18081/assets/app.js)
asset_miss_h=$(hdr http://127.0.0.1:18081/assets/missing.js)

echo "$asset_hit_h" | grep -qi '^cache-control: public, max-age=31536000, immutable$' \
  && echo "✓ existing asset Cache-Control is immutable" \
  || { echo "✗ existing asset headers:"; echo "$asset_hit_h"; exit 1; }

echo "$asset_miss_h" | grep -qi '^cache-control: no-store, no-cache, must-revalidate$' \
  && echo "✓ missing asset Cache-Control is no-store" \
  || { echo "✗ missing asset headers:"; echo "$asset_miss_h"; exit 1; }

echo "✓ Caddy hosted/HTML Referrer-Policy split & asset caching protection"
