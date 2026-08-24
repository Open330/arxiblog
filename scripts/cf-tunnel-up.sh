#!/usr/bin/env bash
# arxiblog용 Cloudflare Tunnel 구성 + foreground 실행
# 사전: `cloudflared tunnel login` 으로 jiun.dev 존 인증 (~/.cloudflared/cert.pem 생성)
# 원본 arxiblog 프로세스는 macos-launch-agent.sh 같은 supervisor로 먼저 실행해야 합니다.
set -euo pipefail

NAME="${1:-arxiblog}"
HOSTNAME="${2:-arxiblog.jiun.dev}"
PORT="${3:-8088}"
CFDIR="$HOME/.cloudflared"
CONFIG="$CFDIR/$NAME-config.yml"

if ! [[ "$NAME" =~ ^[A-Za-z0-9_-]+$ ]]; then
  echo "invalid tunnel name: $NAME" >&2
  exit 2
fi
if ! [[ "$HOSTNAME" =~ ^[A-Za-z0-9.-]+$ ]]; then
  echo "invalid hostname: $HOSTNAME" >&2
  exit 2
fi
if ! [[ "$PORT" =~ ^[0-9]+$ ]] || [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
  echo "invalid port: $PORT" >&2
  exit 2
fi

if [ ! -f "$CFDIR/cert.pem" ]; then
  echo "❌ $CFDIR/cert.pem 없음. 먼저 실행하세요:  cloudflared tunnel login"
  exit 1
fi

# 터널 생성 (이미 있으면 재사용)
if ! cloudflared tunnel list 2>/dev/null | awk -v n="$NAME" '$2==n{found=1} END{exit !found}'; then
  cloudflared tunnel create "$NAME"
fi
UUID="$(cloudflared tunnel list 2>/dev/null | awk -v n="$NAME" '$2==n{print $1}')"
if [ -z "$UUID" ]; then
  echo "tunnel UUID를 찾지 못했습니다: $NAME" >&2
  exit 1
fi
echo "tunnel: $NAME ($UUID)"

# DNS 라우팅 (arxiblog.jiun.dev → 터널)
cloudflared tunnel route dns "$NAME" "$HOSTNAME"

# 다른 cloudflared 서비스의 전역 config를 덮어쓰지 않고 전용 config 작성
cat > "$CONFIG" <<YML
tunnel: $UUID
credentials-file: $CFDIR/$UUID.json
ingress:
  - hostname: $HOSTNAME
    service: http://127.0.0.1:$PORT
  - service: http_status:404
YML
chmod 600 "$CONFIG"
echo "config: $CONFIG → http://127.0.0.1:$PORT"

# 502를 공개한 채 터널만 실행하지 않도록 원본 readiness를 먼저 확인
if ! curl --silent --show-error --fail --max-time 5 "http://127.0.0.1:$PORT/healthz" >/dev/null; then
  echo "원본 서버가 준비되지 않았습니다. 먼저 arxiblog LaunchAgent를 설치/시작하세요." >&2
  exit 1
fi
if ! curl --silent --show-error --fail --max-time 5 "http://127.0.0.1:$PORT/" >/dev/null; then
  echo "원본 서버에 게시된 홈페이지가 없습니다. 먼저 arxiblog build를 완료하세요." >&2
  exit 1
fi

echo "✅ 원본 정상. https://$HOSTNAME 터널을 foreground로 실행합니다."
echo "   상시 운영은 이 명령 자체도 launchd/systemd 같은 supervisor에 등록하세요."
exec cloudflared tunnel --config "$CONFIG" run "$NAME"
