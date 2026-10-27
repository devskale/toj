#!/bin/bash
# deploy.sh — push-then-pull deploy for the jot/toj instance on lubu.
#
# Flow: verify local build is green → verify local tree is pushed →
#       remote git pull → systemd restart → health + data-integrity checks.
#
# The remote runs jot.service off ~/code/hands/toj (npm-linked, dist/ committed),
# so a pull + restart is a complete deploy. Data in /var/lib/jot/data is never touched.
#
# Usage: bash scripts/deploy.sh [host]     # default host: lubu
set -euo pipefail

HOST="${1:-lubu}"
REMOTE_DIR="\$HOME/code/hands/toj"
SERVICE="jot"
PORT="3210"
DATA_DIR="/var/lib/jot/data"

cd "$(dirname "$0")/.."
echo "── deploy to $HOST ──"

# 1. Local gate: build must be green and tree clean (everything pushed)
echo "── [1/4] local build gate ──"
npm run build --silent
node --check public/app.js
node --check public/collab-editor.js
node --check public/collab-shared.js

if [ -n "$(git status --porcelain -- src public cli package.json)" ]; then
  echo "✗ uncommitted changes in src/public/cli/package.json — commit & push first:"
  git status --short -- src public cli package.json
  exit 1
fi
LOCAL_SHA="$(git rev-parse HEAD)"
REMOTE_REF="$(git ls-remote origin "refs/heads/$(git rev-parse --abbrev-ref HEAD)" | cut -f1)"
if [ "$LOCAL_SHA" != "$REMOTE_REF" ]; then
  echo "✗ HEAD $LOCAL_SHA is not on origin ($(git rev-parse --abbrev-ref HEAD) @ $REMOTE_REF) — push first"
  exit 1
fi
echo "  local $LOCAL_SHA is pushed ✓"

# 2. Remote: pull
echo "── [2/4] remote pull ──"
NOTE_COUNT_BEFORE="$(ssh "$HOST" "ls $DATA_DIR/notes/*.md 2>/dev/null | wc -l")"
ssh "$HOST" "cd $REMOTE_DIR && git pull --ff-only && git rev-parse --short HEAD"

# 3. Restart service
echo "── [3/4] restart $SERVICE ──"
ssh "$HOST" "sudo systemctl restart $SERVICE"

# 4. Verify: health endpoint, service state, data intact
echo "── [4/4] verify ──"
HEALTH=""
for i in $(seq 1 15); do
  HEALTH="$(ssh "$HOST" "curl -s -m 3 http://localhost:$PORT/health" || true)"
  [ "$HEALTH" = "ok" ] && break
  sleep 2
done
[ "$HEALTH" = "ok" ] || { echo "✗ health check failed"; ssh "$HOST" "journalctl -u $SERVICE -n 20 --no-pager"; exit 1; }

SERVICE_STATE="$(ssh "$HOST" "systemctl is-active $SERVICE")"
NOTE_COUNT_AFTER="$(ssh "$HOST" "ls $DATA_DIR/notes/*.md 2>/dev/null | wc -l")"
ssh "$HOST" "journalctl -u $SERVICE --since '30 seconds ago' --no-pager | grep -iE 'error|fatal' && { echo '✗ errors in journal'; exit 1; } || true"

echo "  health: ok ✓   service: $SERVICE_STATE ✓   notes: $NOTE_COUNT_BEFORE → $NOTE_COUNT_AFTER"
[ "$NOTE_COUNT_BEFORE" = "$NOTE_COUNT_AFTER" ] || echo "  (note count changed — check if someone was editing during deploy)"
echo "── deploy complete: $HOST @ $(ssh "$HOST" "cd $REMOTE_DIR && git rev-parse --short HEAD") ──"
