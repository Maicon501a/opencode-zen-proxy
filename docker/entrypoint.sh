#!/bin/sh
set -e

# ── Cloudflare WARP daemon bootstrap ──────────────────────────────────────────
# The proxy's WarpManager ACTIVATES WARP on demand via warp-cli. For that to
# work, the warp-svc daemon must already be running and the device registered.
# Both happen here, before the proxy starts.
#
# Requires at runtime: --network host, --cap-add NET_ADMIN and /dev/net/tun
# (see docker-compose.yml). ToS is accepted with the global --accept-tos flag,
# which headless/container WARP demands on every command.

mkdir -p /run/dbus
if ! pgrep -x dbus-daemon >/dev/null 2>&1; then
  dbus-daemon --system --fork
fi

if ! pgrep -x warp-svc >/dev/null 2>&1; then
  echo "[entrypoint] starting warp-svc daemon"
  warp-svc >/tmp/warp-svc.log 2>&1 &
fi

# Wait for the daemon to respond to warp-cli.
for i in $(seq 1 30); do
  if warp-cli --accept-tos status >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

# One-time registration (idempotent — ignores "already registered").
# Persisted under /var/lib/cloudflare-warp (mounted volume).
echo "[entrypoint] ensuring WARP device registration"
warp-cli --accept-tos registration new >/dev/null 2>&1 || true

echo "[entrypoint] starting OpenCode Zen Proxy"
exec node src/index.js
