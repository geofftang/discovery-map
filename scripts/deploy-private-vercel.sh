#!/bin/bash
# Phone-reachable deployment of the OWNER build, login-gated: https://discovery-map.vercel.app/
#
# The private map is also served locally (launchd com.user.discovery-map-private, http://127.0.0.1:8765).
# The payload carries takes, hidden pins and provider advisories: treat it like the vault.
#
# WHY THIS SHAPE (established empirically 2026-09-04, Hobby plan):
#   * Vercel Authentication cannot cover PRODUCTION deployments on Hobby ("not available on your plan
#     for production deployments", API 428). A project's production address -- <project>.vercel.app --
#     therefore serves anonymously. The first version of this script deployed --prod and served
#     private.json publicly for ~2 minutes before the project was removed.
#   * PREVIEW deployments are gated (302 -> vercel.com/sso-api), and a plain alias onto a preview
#     deployment stays gated. So: never --prod; deploy a preview; alias it to a readable name that is
#     NOT the project's production domain; verify the payload anonymously before printing anything.
#   * A <name>.vercel.app alias is gated only while it is NOT bound to the project as a production
#     domain. The project is named discovery-map-owner so that discovery-map.vercel.app is never its
#     auto-assigned production domain; the stale binding left by the first attempt was removed with
#     DELETE /v9/projects/discovery-map-owner/domains/discovery-map.vercel.app (2026-09-04). If the
#     anonymous check below ever returns 200 again, that binding is the first thing to look for.
#
# One-time:  vercel login          (device-code flow; interactive)
# Then:      bash scripts/deploy-private-vercel.sh
set -euo pipefail
cd "$(dirname "$0")/.."
PROJECT=discovery-map-owner
ALIAS=discovery-map.vercel.app
EXTRA_ALIASES="discovery-map-private.vercel.app"   # earlier name; kept so old bookmarks keep working
LOG=/tmp/discovery-map-vercel-deploy.log
[ -f dist-private/private.json ] || { echo "no dist-private/ -- run npm run build:private first" >&2; exit 1; }
[ -f "$HOME/Library/Application Support/com.vercel.cli/auth.json" ] || { echo "not logged in to Vercel -- run: vercel login" >&2; exit 1; }
case "$ALIAS" in "$PROJECT.vercel.app") echo "REFUSING: alias equals the production domain, which is public on this plan" >&2; exit 3;; esac

# vite's emptyOutDir wipes dist-private/.vercel each build, so relink every run
( cd dist-private && vercel link --yes --project "$PROJECT" >/dev/null 2>&1 )
( cd dist-private && vercel deploy --yes >"$LOG" 2>&1 ) || { echo "deploy failed -- see $LOG" >&2; exit 4; }
URL=$(grep -o 'https://[a-z0-9.-]*\.vercel\.app' "$LOG" | grep -v '^https://vercel.com' | head -1)
[ -n "$URL" ] || { echo "could not read the deployment URL from $LOG" >&2; exit 4; }

gate() { curl -s -o /dev/null -w '%{http_code}' "$1/private.json?verify=$(date +%s)"; }
code=$(gate "$URL")
if [ "$code" = "200" ]; then
  echo "REFUSING: $URL/private.json answered 200 without login -- removing that deployment" >&2
  vercel remove "$URL" --yes >/dev/null 2>&1 || true
  exit 5
fi
vercel alias set "$URL" "$ALIAS" >/dev/null 2>&1
sleep 2
code=$(gate "https://$ALIAS")
if [ "$code" = "200" ]; then
  echo "REFUSING: https://$ALIAS/private.json answered 200 without login -- removing alias + deployment" >&2
  vercel alias remove "$ALIAS" --yes >/dev/null 2>&1 || true
  vercel remove "$URL" --yes >/dev/null 2>&1 || true
  exit 5
fi
for extra in $EXTRA_ALIASES; do
  vercel alias set "$URL" "$extra" >/dev/null 2>&1
  [ "$(gate "https://$extra")" = "200" ] && { echo "REFUSING: https://$extra public -- removing alias" >&2; vercel alias remove "$extra" --yes >/dev/null 2>&1 || true; exit 5; }
done
echo "deployed and login-gated ($code anonymously): https://$ALIAS/  (also: $EXTRA_ALIASES)"
