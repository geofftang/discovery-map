#!/bin/bash
# Phone-reachable deployment of the OWNER build to map.efsystem.uk
#
# Hosted on Oracle Cloud VPS (tang-infra) behind Cloudflare Tunnel.
# Origin-isolated at https://map.efsystem.uk
set -euo pipefail
cd "$(dirname "$0")/.."

SSH_KEY="$HOME/.ssh/oracle_vps_ed25519"
TARGET_HOST="ubuntu@158.101.127.81"
REMOTE_DIR="/home/ubuntu/discovery-map-vault/dist/"

[ -f "$SSH_KEY" ] || { echo "ERROR: SSH key $SSH_KEY not found" >&2; exit 1; }

echo "Running tests..."
node --test scripts/test_sw.mjs >/dev/null || { echo "ERROR: service-worker tests failed; not deploying" >&2; exit 1; }

echo "Building private discovery map..."
npm run build:private

[ -f dist-private/private.json ] || { echo "ERROR: dist-private/private.json missing" >&2; exit 1; }

echo "Syncing dist-private/ to map.efsystem.uk ($TARGET_HOST:$REMOTE_DIR)..."
rsync -avz --delete --exclude='assets/' -e "ssh -i $SSH_KEY" dist-private/ "$TARGET_HOST:$REMOTE_DIR"
rsync -avz -e "ssh -i $SSH_KEY" dist-private/assets/ "$TARGET_HOST:${REMOTE_DIR}assets/"

echo "Syncing dist-private/ to efsystem.uk/map ($TARGET_HOST:/home/ubuntu/homepage/map/)..."
rsync -avz --delete --exclude='assets/' -e "ssh -i $SSH_KEY" dist-private/ "$TARGET_HOST:/home/ubuntu/homepage/map/"
rsync -avz -e "ssh -i $SSH_KEY" dist-private/assets/ "$TARGET_HOST:/home/ubuntu/homepage/map/assets/"

echo "Verifying remote endpoint..."
STATUS=$(ssh -i "$SSH_KEY" -o BatchMode=yes "$TARGET_HOST" "sudo systemctl restart efsystem-homepage.service && curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8082/")
if [ "$STATUS" != "200" ]; then
  echo "WARNING: Local probe returned HTTP $STATUS" >&2
else
  echo "Verified: internal service returned HTTP 200 on port 8082"
fi

echo "Deployed successfully to: https://map.efsystem.uk/ and https://efsystem.uk/map"

# The live worker must be the one just built (a stale edge copy once left phones on the old one).
# A random query string bypasses any CDN copy, so this checks what the origin really serves.
BUILT=$(shasum -a 256 dist-private/sw.js | cut -d' ' -f1)
LIVE=""
for _ in 1 2 3 4 5 6; do  # the service was just restarted: allow it a few seconds to come back
  LIVE=$(curl -fsS "https://efsystem.uk/map/sw.js?verify=$RANDOM$RANDOM" 2>/dev/null | shasum -a 256 | cut -d' ' -f1) && [ -n "$LIVE" ] && break
  sleep 3
done
if [ "$BUILT" != "$LIVE" ]; then
  echo "ERROR: live /map/sw.js does not match this build (built $BUILT, live $LIVE)" >&2
  exit 1
fi
echo "Verified: live /map/sw.js matches this build."
