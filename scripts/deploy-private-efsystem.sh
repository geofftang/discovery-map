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

echo "Building private discovery map..."
npm run build:private

[ -f dist-private/private.json ] || { echo "ERROR: dist-private/private.json missing" >&2; exit 1; }

echo "Syncing dist-private/ to map.efsystem.uk ($TARGET_HOST:$REMOTE_DIR)..."
rsync -avz --delete -e "ssh -i $SSH_KEY" dist-private/ "$TARGET_HOST:$REMOTE_DIR"

echo "Verifying remote endpoint..."
STATUS=$(ssh -i "$SSH_KEY" -o BatchMode=yes "$TARGET_HOST" "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8082/")
if [ "$STATUS" != "200" ]; then
  echo "WARNING: Local probe returned HTTP $STATUS" >&2
else
  echo "Verified: internal service returned HTTP 200 on port 8082"
fi

echo "Deployed successfully to: https://map.efsystem.uk/"
