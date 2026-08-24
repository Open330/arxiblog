#!/usr/bin/env bash
# Install a daily arxiblog `digest` run as a per-user macOS LaunchAgent.
# It fetches the latest arXiv papers by category, auto-publishes the top N new
# ones, and rebuilds _site (the serve LaunchAgent then serves the fresh build).
# The API key stays in arxiblog.toml; it is never copied into the plist.
#
# NOTE: this runs the LLM on a schedule and therefore spends tokens daily.
# It is intentionally NOT installed by default — enable it deliberately.
set -euo pipefail

ACTION="${1:-status}"
if [ "$#" -gt 0 ]; then shift; fi

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
SOURCE_DIR="$(dirname "$SCRIPT_DIR")"
PROJECT_DIR="$(pwd -P)"
LABEL="com.open330.arxiblog.digest"
HOUR="5"
MINUTE="0"
COUNT="2"
CATEGORIES="cs.LG,cs.CL,cs.AI"

usage() {
  cat <<'EOF'
Usage: scripts/macos-digest-agent.sh <install|run-now|status|uninstall> [options]

Options:
  --project <dir>      project containing arxiblog.toml and _site/ (default: cwd)
  --source <dir>       arxiblog source checkout (default: this repository)
  --label <label>      LaunchAgent label (default: com.open330.arxiblog.digest)
  --hour <0-23>        daily run hour, local time (default: 5)
  --minute <0-59>      daily run minute (default: 0)
  --count <n>          papers to publish per run (default: 2)
  --categories <list>  comma-separated arXiv categories (default: cs.LG,cs.CL,cs.AI)

Runs off-peak by default (05:00) so arXiv's API is not contended/throttled.
'run-now' triggers one digest immediately (useful to test).
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --project) PROJECT_DIR="${2:?}"; shift 2 ;;
    --source) SOURCE_DIR="${2:?}"; shift 2 ;;
    --label) LABEL="${2:?}"; shift 2 ;;
    --hour) HOUR="${2:?}"; shift 2 ;;
    --minute) MINUTE="${2:?}"; shift 2 ;;
    --count) COUNT="${2:?}"; shift 2 ;;
    --categories) CATEGORIES="${2:?}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ "$LABEL" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "Invalid label" >&2; exit 2; }
[[ "$HOUR" =~ ^[0-9]+$ ]] && [ "$HOUR" -le 23 ] || { echo "Invalid --hour" >&2; exit 2; }
[[ "$MINUTE" =~ ^[0-9]+$ ]] && [ "$MINUTE" -le 59 ] || { echo "Invalid --minute" >&2; exit 2; }
[[ "$COUNT" =~ ^[0-9]+$ ]] && [ "$COUNT" -ge 1 ] || { echo "Invalid --count" >&2; exit 2; }
[[ "$CATEGORIES" =~ ^[A-Za-z0-9.,_-]+$ ]] || { echo "Invalid --categories" >&2; exit 2; }

absolute_dir() { CDPATH= cd -- "$1" 2>/dev/null && pwd -P; }

USER_HOME="${HOME:?}"
PLIST_DIR="$USER_HOME/Library/LaunchAgents"
PLIST_PATH="$PLIST_DIR/$LABEL.plist"
STATE_DIR="$USER_HOME/Library/Logs/arxiblog/$LABEL"
LOG="$STATE_DIR/digest.log"
DOMAIN="gui/$(id -u)"

case "$ACTION" in
  install|run-now)
    PROJECT_DIR="$(absolute_dir "$PROJECT_DIR")" || { echo "Project dir not found" >&2; exit 2; }
    SOURCE_DIR="$(absolute_dir "$SOURCE_DIR")" || { echo "Source dir not found" >&2; exit 2; }
    BUN_BIN="$(command -v bun || true)"
    [ -x "$BUN_BIN" ] || { echo "Bun not found in PATH" >&2; exit 1; }
    ENTRYPOINT="$SOURCE_DIR/src/index.ts"
    [ -f "$ENTRYPOINT" ] || { echo "Entrypoint not found: $ENTRYPOINT" >&2; exit 2; }
    [ -f "$PROJECT_DIR/arxiblog.toml" ] || { echo "arxiblog.toml not found in $PROJECT_DIR" >&2; exit 2; }
    mkdir -p "$PLIST_DIR" "$STATE_DIR"; chmod 700 "$STATE_DIR"; touch "$LOG"; chmod 600 "$LOG"

    if [ "$ACTION" = "run-now" ]; then
      echo "Running digest now (count=$COUNT, categories=$CATEGORIES)…"
      ( cd "$PROJECT_DIR" && "$BUN_BIN" "$ENTRYPOINT" digest -n "$COUNT" -c "$CATEGORIES" )
      exit $?
    fi

    cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$BUN_BIN</string>
    <string>$ENTRYPOINT</string>
    <string>digest</string>
    <string>-n</string><string>$COUNT</string>
    <string>-c</string><string>$CATEGORIES</string>
  </array>
  <key>WorkingDirectory</key><string>$PROJECT_DIR</string>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>$HOUR</integer><key>Minute</key><integer>$MINUTE</integer></dict>
  <key>ProcessType</key><string>Background</string>
  <key>Umask</key><integer>63</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF
    chmod 600 "$PLIST_PATH"
    plutil -lint "$PLIST_PATH" >/dev/null
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    launchctl bootstrap "$DOMAIN" "$PLIST_PATH"
    echo "Installed $LABEL — runs daily at $HOUR:$(printf '%02d' "$MINUTE"), publishing $COUNT paper(s) from $CATEGORIES."
    echo "Log: $LOG"
    ;;
  status)
    launchctl print "$DOMAIN/$LABEL" 2>/dev/null | sed -n '1,20p' || echo "(not installed)"
    ;;
  uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$PLIST_PATH"
    echo "Uninstalled $LABEL (log remains in $STATE_DIR)."
    ;;
  -h|--help|help) usage ;;
  *) echo "Unknown action: $ACTION" >&2; usage >&2; exit 2 ;;
esac
