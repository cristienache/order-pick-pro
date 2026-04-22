#!/usr/bin/env bash
# Auto-deploy script. Triggered by the GitHub webhook in server/index.js.
# Pulls the latest code, rebuilds the app, and gracefully reloads the live SSR
# process through PM2 so deploys do not drop the website with 502s.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_FILE="${HOME}/deploy.log"

SSR_APP_NAME="${SSR_APP_NAME:-ultrax-ssr}"
API_APP_NAME="${API_APP_NAME:-ultrax-api}"
SSR_HOST="${SSR_HOST:-127.0.0.1}"
SSR_PORT="${SSR_PORT:-4173}"
SSR_URL="http://${SSR_HOST}:${SSR_PORT}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-45}"
PM2_ECOSYSTEM="$PROJECT_DIR/ecosystem.config.cjs"
DIST_BACKUP_DIR="$PROJECT_DIR/dist.previous"
DIST_FAILED_DIR="$PROJECT_DIR/dist.failed"

exec >>"$LOG_FILE" 2>&1
echo ""
echo "===== $(date -Iseconds) deploy starting ====="
cd "$PROJECT_DIR"

rm_tree() {
  local target="$1"
  if [ -e "$target" ]; then
    find "$target" -depth -exec rm -rf {} + 2>/dev/null || true
    rm -rf "$target" || true
  fi
}

wait_for_ssr() {
  local deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if curl -fsS -o /dev/null -m 3 "$SSR_URL" 2>/dev/null; then
      return 0
    fi
    if curl -sS -o /dev/null -m 3 -w '%{http_code}' "$SSR_URL" 2>/dev/null | grep -qE '^[1-5][0-9][0-9]$'; then
      return 0
    fi
    sleep 1
  done
  return 1
}

reload_ssr() {
  echo "--- reloading ${SSR_APP_NAME} via PM2"
  if pm2 describe "$SSR_APP_NAME" >/dev/null 2>&1; then
    if pm2 reload "$PM2_ECOSYSTEM" --only "$SSR_APP_NAME" --update-env; then
      return 0
    fi
    echo "!!! PM2 reload failed; recreating ${SSR_APP_NAME} from ecosystem config"
    pm2 delete "$SSR_APP_NAME" || true
  fi
  pm2 start "$PM2_ECOSYSTEM" --only "$SSR_APP_NAME" --update-env
}

restore_previous_dist() {
  if [ -d "$DIST_BACKUP_DIR" ]; then
    echo "--- restoring previous dist/"
    rm_tree "$PROJECT_DIR/dist"
    rm_tree "$DIST_FAILED_DIR"
    if [ -d "$PROJECT_DIR/dist" ]; then
      mv "$PROJECT_DIR/dist" "$DIST_FAILED_DIR"
    fi
    mv "$DIST_BACKUP_DIR" "$PROJECT_DIR/dist"
    return 0
  fi
  return 1
}

# 1. Pull latest from GitHub
DEFAULT_BRANCH="$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's@^origin/@@' || echo main)"
git fetch --quiet origin
git checkout "$DEFAULT_BRANCH"
git reset --hard "origin/$DEFAULT_BRANCH"

# 2. Preserve the currently-working build for rollback, then build the new one.
rm_tree "$DIST_BACKUP_DIR"
rm_tree "$DIST_FAILED_DIR"
if [ -d "$PROJECT_DIR/dist" ]; then
  mv "$PROJECT_DIR/dist" "$DIST_BACKUP_DIR"
fi

echo "--- npm install (frontend)"
npm install --no-audit --no-fund

echo "--- npm run build"
if ! npm run build; then
  echo "!!! build failed — restoring previous dist/ and aborting"
  restore_previous_dist || true
  exit 1
fi

# 3. Backend deps + restart (only if server/ changed in this push)
if git diff --name-only "HEAD@{1}" HEAD 2>/dev/null | grep -q '^server/'; then
  echo "--- server/ changed, reinstalling + restarting API"
  (cd server && npm install --omit=dev --no-audit --no-fund)
  pm2 restart "$API_APP_NAME" || true
fi

# 4. Gracefully reload SSR against the new dist/ and verify it is serving.
reload_ssr

echo "--- waiting up to ${HEALTH_TIMEOUT}s for SSR at ${SSR_URL}"
if wait_for_ssr; then
  echo "--- SSR is up ✓"
  rm_tree "$DIST_BACKUP_DIR"
  pm2 save || true
  echo "===== $(date -Iseconds) deploy finished ====="
  exit 0
fi

# 5. Roll back to the last known-good dist/ if the new one does not boot.
echo "!!! SSR did not respond after reload — rolling back"
if restore_previous_dist; then
  reload_ssr
  if wait_for_ssr; then
    echo "--- SSR recovered after rollback ✓"
    pm2 save || true
    echo "===== $(date -Iseconds) deploy FAILED — rolled back to previous build ====="
    exit 1
  fi
fi

echo "!!! SSR is still down after rollback — manual intervention required"
echo "    check: pm2 logs ${SSR_APP_NAME} --lines 120 --nostream"
exit 2
