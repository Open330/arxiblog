#!/usr/bin/env bash
# arxiblog.jiun.dev 용 Cloudflare Tunnel 구성 + 실행
# 사전: `cloudflared tunnel login` 으로 jiun.dev 존 인증 (~/.cloudflared/cert.pem 생성)
set -euo pipefail

NAME="${1:-arxiblog}"
HOSTNAME="${2:-arxiblog.jiun.dev}"
PORT="${3:-8088}"
CFDIR="$HOME/.cloudflared"

if [ ! -f "$CFDIR/cert.pem" ]; then
  echo "❌ $CFDIR/cert.pem 없음. 먼저 실행하세요:  cloudflared tunnel login"
  exit 1
fi

# 터널 생성 (이미 있으면 재사용)
if ! cloudflared tunnel list 2>/dev/null | grep -qw "$NAME"; then
  cloudflared tunnel create "$NAME"
fi
UUID="$(cloudflared tunnel list 2>/dev/null | awk -v n="$NAME" '$2==n{print $1}')"
echo "tunnel: $NAME ($UUID)"

# DNS 라우팅 (arxiblog.jiun.dev → 터널)
cloudflared tunnel route dns "$NAME" "$HOSTNAME" || true

# config 작성
cat > "$CFDIR/config.yml" <<YML
tunnel: $UUID
credentials-file: $CFDIR/$UUID.json
ingress:
  - hostname: $HOSTNAME
    service: http://localhost:$PORT
  - service: http_status:404
YML
echo "config: $CFDIR/config.yml → http://localhost:$PORT"

# 실행 (백그라운드)
pkill -f "cloudflared tunnel.*run.*$NAME" 2>/dev/null || true
sleep 1
nohup cloudflared tunnel run "$NAME" > /tmp/arxiblog-tunnel.log 2>&1 &
echo "✅ 터널 실행. https://$HOSTNAME (전파에 1~2분)"
echo "   로그: tail -f /tmp/arxiblog-tunnel.log"
