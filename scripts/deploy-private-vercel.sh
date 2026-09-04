#!/bin/bash
# OPTIONAL phone-reachable deployment of the OWNER build. Not run automatically.
#
# The private map is served locally by default (launchd com.user.discovery-map-private,
# http://127.0.0.1:8765). This script pushes the same dist-private/ bundle to Vercel as a
# *preview* deployment, which Vercel's default "Standard Protection" gates behind Vercel login
# (Vercel Authentication). Nothing here is public; the payload still carries your takes,
# hidden pins and provider advisories, so treat the deployment like the vault.
#
# One-time:  vercel login          (device-code flow; interactive)
# Then:      bash scripts/deploy-private-vercel.sh
#
# Verifies protection before printing the URL: an unauthenticated GET must NOT return 200.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f dist-private/private.json ] || { echo "no dist-private/ -- run npm run build:private first" >&2; exit 1; }

URL=$(vercel deploy dist-private --yes --name discovery-map-private 2>/dev/null | tail -1)
code=$(curl -s -o /dev/null -w '%{http_code}' "$URL")
if [ "$code" = "200" ]; then
  echo "REFUSING: $URL answered 200 without authentication -- deployment is NOT protected. Remove it: vercel remove discovery-map-private --yes" >&2
  exit 3
fi
echo "protected ($code without login): $URL"
