#!/usr/bin/env bash
# Install arxiblog as a per-user macOS LaunchAgent.
# The API key remains in the project config; it is never copied into the plist.
set -euo pipefail

ACTION="${1:-status}"
if [ "$#" -gt 0 ]; then
  shift
fi

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
SOURCE_DIR="$(dirname "$SCRIPT_DIR")"
PROJECT_DIR="$(pwd -P)"
LABEL="com.open330.arxiblog"
HOST="127.0.0.1"
PORT="8088"

usage() {
  cat <<'EOF'
Usage: scripts/macos-launch-agent.sh <install|restart|status|health|uninstall> [options]

Options:
  --project <dir>  arxiblog project containing arxiblog.toml and _site/
  --source <dir>   arxiblog source checkout (defaults to this repository)
  --label <label>  LaunchAgent label (default: com.open330.arxiblog)
  --host <host>    bind address (default: 127.0.0.1)
  --port <port>    listen port (default: 8088)

Build the site before install. The service intentionally starts with --no-build
so a restart cannot publish a partially updated site.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --project) PROJECT_DIR="${2:?missing value for --project}"; shift 2 ;;
    --source) SOURCE_DIR="${2:?missing value for --source}"; shift 2 ;;
    --label) LABEL="${2:?missing value for --label}"; shift 2 ;;
    --host) HOST="${2:?missing value for --host}"; shift 2 ;;
    --port) PORT="${2:?missing value for --port}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if ! [[ "$LABEL" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "Invalid LaunchAgent label: $LABEL" >&2
  exit 2
fi
if ! [[ "$PORT" =~ ^[0-9]+$ ]] || [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
  echo "Invalid port: $PORT" >&2
  exit 2
fi
if ! [[ "$HOST" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "Invalid host: $HOST" >&2
  exit 2
fi

absolute_dir() {
  CDPATH= cd -- "$1" 2>/dev/null && pwd -P
}

reject_xml_chars() {
  case "$1" in
    *'<'*|*'>'*|*'&'*)
      echo "Paths and host names may not contain XML metacharacters." >&2
      exit 2
      ;;
  esac
}

USER_HOME="${HOME:?HOME is required for a per-user LaunchAgent}"
PLIST_DIR="$USER_HOME/Library/LaunchAgents"
PLIST_PATH="$PLIST_DIR/$LABEL.plist"
STATE_DIR="$USER_HOME/Library/Logs/arxiblog/$LABEL"
STDOUT_LOG="$STATE_DIR/server.log"
STDERR_LOG="$STATE_DIR/server-error.log"
DOMAIN="gui/$(id -u)"

health() {
  curl --silent --show-error --fail --max-time 5 \
    -H 'Accept: application/json' "http://$HOST:$PORT/healthz"
  printf '\n'
}

ready() {
  health >/dev/null
  curl --silent --show-error --fail --max-time 5 "http://$HOST:$PORT/" >/dev/null
}

case "$ACTION" in
  -h|--help|help)
    usage
    ;;
  install)
    PROJECT_DIR="$(absolute_dir "$PROJECT_DIR")" || {
      echo "Project directory not found: $PROJECT_DIR" >&2
      exit 2
    }
    SOURCE_DIR="$(absolute_dir "$SOURCE_DIR")" || {
      echo "Source directory not found: $SOURCE_DIR" >&2
      exit 2
    }
    reject_xml_chars "$PROJECT_DIR"
    reject_xml_chars "$SOURCE_DIR"
    reject_xml_chars "$HOST"

    BUN_BIN="$(command -v bun || true)"
    if [ -z "$BUN_BIN" ] || [ ! -x "$BUN_BIN" ]; then
      echo "Bun is required but was not found in PATH." >&2
      exit 1
    fi
    ENTRYPOINT="$SOURCE_DIR/src/index.ts"
    if [ ! -f "$ENTRYPOINT" ]; then
      echo "arxiblog entrypoint not found: $ENTRYPOINT" >&2
      exit 2
    fi
    if [ ! -f "$PROJECT_DIR/arxiblog.toml" ]; then
      echo "arxiblog.toml not found in $PROJECT_DIR" >&2
      exit 2
    fi
    mkdir -p "$PLIST_DIR" "$STATE_DIR"
    chmod 700 "$STATE_DIR"
    touch "$STDOUT_LOG" "$STDERR_LOG"
    chmod 600 "$STDOUT_LOG" "$STDERR_LOG"
    chmod 600 "$PROJECT_DIR/arxiblog.toml"
    for database_file in \
      "$PROJECT_DIR/arxiblog.db" \
      "$PROJECT_DIR/arxiblog.db-wal" \
      "$PROJECT_DIR/arxiblog.db-shm"; do
      if [ -e "$database_file" ]; then
        chmod 600 "$database_file"
      fi
    done

    cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$BUN_BIN</string>
    <string>$ENTRYPOINT</string>
    <string>serve</string>
    <string>--no-build</string>
    <string>--host</string>
    <string>$HOST</string>
    <string>--port</string>
    <string>$PORT</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$PROJECT_DIR</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>Umask</key>
  <integer>63</integer>
  <key>StandardOutPath</key>
  <string>$STDOUT_LOG</string>
  <key>StandardErrorPath</key>
  <string>$STDERR_LOG</string>
</dict>
</plist>
EOF
    chmod 600 "$PLIST_PATH"
    plutil -lint "$PLIST_PATH" >/dev/null
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    launchctl bootstrap "$DOMAIN" "$PLIST_PATH"
    launchctl kickstart -k "$DOMAIN/$LABEL"

    for _ in 1 2 3 4 5 6 7 8 9 10; do
      if ready >/dev/null 2>&1; then
        echo "Installed $LABEL; health and homepage checks passed at http://$HOST:$PORT/"
        echo "Private logs: $STATE_DIR"
        exit 0
      fi
      sleep 0.5
    done
    echo "Service was installed but did not become healthy. Check $STDERR_LOG" >&2
    exit 1
    ;;
  restart)
    launchctl kickstart -k "$DOMAIN/$LABEL"
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      if ready >/dev/null 2>&1; then
        echo "Restarted $LABEL; health and homepage checks passed."
        exit 0
      fi
      sleep 0.5
    done
    echo "Restarted $LABEL, but the health check failed." >&2
    exit 1
    ;;
  status)
    launchctl print "$DOMAIN/$LABEL" | sed -n '1,32p'
    health
    ;;
  health)
    health
    ;;
  uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$PLIST_PATH"
    echo "Uninstalled $LABEL (logs remain in $STATE_DIR)."
    ;;
  *)
    echo "Unknown action: $ACTION" >&2
    usage >&2
    exit 2
    ;;
esac
