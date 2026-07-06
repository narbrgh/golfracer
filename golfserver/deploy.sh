#!/usr/bin/env bash
#
# deploy.sh — build the Go golf-server locally and push it to the AWS EC2 host.
#
# What it does:
#   1. Cross-compiles the server for linux/amd64 (a static-ish CGO-off binary).
#   2. scp's it to a temp path on the EC2 host (so a half-finished upload never
#      replaces the running binary).
#   3. Over SSH: stops the service, swaps the binary into place, restarts it,
#      and shows the last few log lines so you can confirm it came back up.
#
# One-time setup on the box: a systemd unit named "$SERVICE" that runs
# "$REMOTE_BIN". A minimal unit is documented at the bottom of this file.
#
# Usage:
#   ./deploy.sh              Build + push the server binary and restart it.
#   ./deploy.sh --courses    Also push local courses/ (add/update only — never
#                            deletes courses created on the server).
#   ./deploy.sh --help       Show this help.
#
set -euo pipefail

# ─── Config — EDIT THESE for your instance ──────────────────────────────────
HOST="18.119.220.87"                     # EC2 public DNS / IP / SSH alias
SSH_USER="ubuntu"                        # ec2-user for Amazon Linux, ubuntu for Ubuntu
PEM_KEY="$HOME/.ssh/BotKey02.pem"        # path to your .pem private key
SERVICE="golf"                           # systemd service name (no .service)
REMOTE_BIN="/home/ubuntu/golf-server"    # where the running binary lives (matches systemd ExecStart)
# The server reads/writes course JSON from ./courses relative to its systemd
# WorkingDirectory (/home/ubuntu), so courses live at /home/ubuntu/courses:
REMOTE_DIR="/home/ubuntu"
# Target platform for cross-compile (EC2 is x86_64):
GOOS_TARGET="linux"
GOARCH_TARGET="amd64"
# ────────────────────────────────────────────────────────────────────────────

# ─── Flags ──────────────────────────────────────────────────────────────────
#   --courses   Also sync local courses/ up to the server (adds/updates only;
#               never deletes courses that were created on the server).
SYNC_COURSES=0
for arg in "$@"; do
  case "$arg" in
    --courses) SYNC_COURSES=1 ;;
    -h|--help) sed -n '2,/^set -euo/{/^set -euo/!p;}' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) printf 'Unknown flag: %s\n' "$arg" >&2; exit 2 ;;
  esac
done

# Always run from this script's directory (the golfserver module root).
cd "$(dirname "$0")"

BIN_NAME="golf-server"
LOCAL_BIN="./${BIN_NAME}.deploy"          # build artifact, not the local dev binary
REMOTE_TMP="/tmp/${BIN_NAME}.new"
SSH_OPTS=(-i "$PEM_KEY" -o ConnectTimeout=10)

log()  { printf '\033[1;34m▶ %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[[ -f "$PEM_KEY" ]] || die "PEM key not found: $PEM_KEY (edit PEM_KEY in this script)"

# 1. Build ───────────────────────────────────────────────────────────────────
# Stamp the binary with a version = git short hash (+ -dirty) + build date, so
# the /version endpoint and the client's main-menu footer can report it.
GIT_HASH="$(git rev-parse --short HEAD 2>/dev/null || echo nogit)"
[[ -n "$(git status --porcelain 2>/dev/null)" ]] && GIT_HASH="${GIT_HASH}-dirty"
VERSION="${GIT_HASH} ($(date -u +%Y-%m-%d\ %H:%M))"
log "Building ${BIN_NAME} for ${GOOS_TARGET}/${GOARCH_TARGET} — version: ${VERSION}"
CGO_ENABLED=0 GOOS="$GOOS_TARGET" GOARCH="$GOARCH_TARGET" \
  go build -trimpath -ldflags="-s -w -X 'main.version=${VERSION}'" -o "$LOCAL_BIN" .
ok "Built $(du -h "$LOCAL_BIN" | cut -f1) → $LOCAL_BIN"

# 2. Upload to a temp path ───────────────────────────────────────────────────
log "Uploading to ${SSH_USER}@${HOST}:${REMOTE_TMP}…"
scp "${SSH_OPTS[@]}" "$LOCAL_BIN" "${SSH_USER}@${HOST}:${REMOTE_TMP}"
ok "Uploaded."

# 2b. Optionally sync courses/ (opt-in via --courses) ────────────────────────
# The server rewrites courses/ at runtime when players create/edit courses, so
# we ADD and UPDATE only — no --delete — to avoid clobbering server-made courses.
if [[ "$SYNC_COURSES" -eq 1 ]]; then
  if [[ -d ./courses ]]; then
    log "Syncing courses/ → ${REMOTE_DIR}/courses/ (add/update only)…"
    rsync -az --no-perms --omit-dir-times \
      -e "ssh ${SSH_OPTS[*]}" \
      ./courses/ "${SSH_USER}@${HOST}:${REMOTE_DIR}/courses/"
    ok "Courses synced."
  else
    die "--courses given but ./courses does not exist"
  fi
fi

# 3. Swap in place & restart ─────────────────────────────────────────────────
log "Restarting ${SERVICE} on the host…"
ssh "${SSH_OPTS[@]}" "${SSH_USER}@${HOST}" bash -s <<REMOTE
  set -euo pipefail
  sudo mkdir -p "\$(dirname "${REMOTE_BIN}")"
  sudo systemctl stop "${SERVICE}"
  sudo mv "${REMOTE_TMP}" "${REMOTE_BIN}"
  sudo chmod +x "${REMOTE_BIN}"
  sudo systemctl start "${SERVICE}"
  sleep 1
  systemctl is-active --quiet "${SERVICE}" && echo "service active" || { echo "SERVICE FAILED TO START"; exit 1; }
REMOTE

ok "Deployed. Recent logs:"
ssh "${SSH_OPTS[@]}" "${SSH_USER}@${HOST}" \
  "sudo journalctl -u ${SERVICE} -n 15 --no-pager" || true

rm -f "$LOCAL_BIN"
ok "Done — ${SERVICE} updated on ${HOST}."

# ─── One-time systemd unit (create as /etc/systemd/system/golf-server.service) ─
#
#   [Unit]
#   Description=Golf server
#   After=network.target
#
#   [Service]
#   ExecStart=/opt/golf-server/golf-server
#   WorkingDirectory=/opt/golf-server
#   Restart=always
#   User=ubuntu
#
#   [Install]
#   WantedBy=multi-user.target
#
# Then:  sudo systemctl daemon-reload && sudo systemctl enable --now golf-server
#
# NOTE: the only runtime data dir is courses/ (JSON), read from ./courses
# relative to WorkingDirectory. coursestore/holegeom/terrain/physics/rooms are
# Go packages compiled into the binary, not files to deploy. Use --courses to
# push local course JSON up.
