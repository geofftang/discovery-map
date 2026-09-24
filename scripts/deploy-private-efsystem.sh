#!/bin/bash
# Phone-reachable deployment of the OWNER build to efsystem.uk: https://efsystem.uk/map/
#
# Hosted on Oracle Cloud VPS (tang-infra) behind Cloudflare Tunnel.
# Access-gated at the edge via Cloudflare Zero Trust (Passkey / Face ID / Touch ID).
set -euo pipefail
cd "$(dirname "$0")/.."

SSH_KEY="$HOME/.ssh/oracle_vps_ed25519"
TARGET_HOST="ubuntu@158.101.127.81"
REMOTE_DIR="/home/ubuntu/homepage/map/"

[ -f "$SSH_KEY" ] || { echo "ERROR: SSH key $SSH_KEY not found" >&2; exit 1; }

echo "Building private discovery map..."
npm run build:private

[ -f dist-private/private.json ] || { echo "ERROR: dist-private/private.json missing" >&2; exit 1; }

echo "Syncing dist-private/ to efsystem.uk ($TARGET_HOST:$REMOTE_DIR)..."
rsync -avz --delete -e "ssh -i $SSH_KEY" dist-private/ "$TARGET_HOST:$REMOTE_DIR"

echo "Verifying remote endpoint..."
STATUS=$(ssh -i "$SSH_KEY" -o BatchMode=yes "$TARGET_HOST" "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/map/private.json")
if [ "$STATUS" != "200" ]; then
  echo "WARNING: Local probe returned HTTP $STATUS" >&2
else
  echo "Verified: internal service returned HTTP 200 for private.json"
fi

echo "Deployed successfully to: https://efsystem.uk/map/"
