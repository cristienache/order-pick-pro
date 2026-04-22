#!/usr/bin/env bash
# Auto-deploy script. Triggered by the GitHub webhook in server/index.js.
# Pulls the latest code, rebuilds the frontend, swaps the public dir, and
# restarts pm2 processes. All output goes to ~/deploy.log so you can tail
# it from SSH if anything misbehaves.
#
# Safety: after restarting the SSR process we health-check it. If it does
# not come back up, we restore the previous public/ directory and restart
# SSR again so the site never stays 502 because of a bad build.
set -euo pipefail

# Resolve the project root (this script lives in <project>/scripts/)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_FILE="${HOME}/deploy.log"

# Port the SSR process listens on locally (nginx proxies to this).
SSR_PORT="${SSR_PORT:-4173}"
SSR_URL="http://127.0.0.1:${SSR_PORT}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-30}" # seconds to wait for SSR after restart

exec >>"$LOG_FILE" 2>&1
echo ""
echo "===== $(date -Iseconds) deploy starting ====="
cd "$PROJECT_DIR"

# Wait until SSR responds with any HTTP status (i.e. the socket is accepting
# requests and the app booted). Returns 0 on success, 1 on timeout.
wait_for_ssr() {
  local deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if curl -fsS -o /dev/null -m 3 "$SSR_URL" 2>/dev/null; then
      return 0
    fi
    # Accept any HTTP response (even 404/500) as "process is up"; only a
    # connection failure means it's still down.
    if curl -sS -o /dev/null -m 3 -w '%{http_code}' "$SSR_URL" 2>/dev/null | grep -qE '^[1-5][0-9][0-9]$'; then
      return 0
    fi
    sleep 1
  done
  return 1
}

# 1. Pull latest from GitHub (fast-forward only — never auto-merge a divergent server state)
git fetch --quiet origin
DEFAULT_BRANCH="$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's@^origin/@@' || echo main)"
git checkout "$DEFAULT_BRANCH"
git reset --hard "origin/$DEFAULT_BRANCH"

# 2. Frontend build
echo "--- npm install (frontend)"
npm install --no-audit --no-fund

# Always start from a clean dist/. If a previous build left a pathologically
# nested tree (e.g. dist/client/client/client/...), plain `rm -rf` can hit
# ENOTEMPTY because Node's rimraf bails on extreme path lengths. `find -depth`
# deletes from the leaves up so it always succeeds.
echo "--- cleaning dist/"
if [ -e dist ]; then
  find dist -depth -exec rm -rf {} + 2>/dev/null || true
  rm -rf dist || true
fi

echo "--- npm run build"
if ! npm run build; then
  echo "!!! npm run build failed — aborting deploy, leaving existing public/ untouched"
  exit 1
fi

# 3. Swap dist -> public atomically-ish.
# Guard: only swap if the build actually produced output. Keep the previous
# build in public.old so we can roll back if SSR fails to come up.
if [ -d dist ]; then
  echo "--- swapping dist -> public (keeping previous build as public.old for rollback)"
  # Discard any older rollback snapshot.
  if [ -e public.old ]; then
    find public.old -depth -exec rm -rf {} + 2>/dev/null || true
    rm -rf public.old || true
  fi
  if [ -e public ]; then
    mv public public.old
  fi
  mv dist public
else
  echo "!!! build produced no dist/ — keeping existing public/ in place"
  exit 1
fi

# 4. Backend deps + restart (only if server/ changed in this push)
if git diff --name-only "HEAD@{1}" HEAD 2>/dev/null | grep -q '^server/'; then
  echo "--- server/ changed, reinstalling + restarting API"
  (cd server && npm install --omit=dev --no-audit --no-fund)
  pm2 restart ultrax-api || true
fi

# 5. Restart SSR worker so the new build is served, then health-check it.
echo "--- restarting ultrax-ssr"
pm2 restart ultrax-ssr || true

echo "--- waiting up to ${HEALTH_TIMEOUT}s for SSR at ${SSR_URL}"
if wait_for_ssr; then
  echo "--- SSR is up ✓"
else
  echo "!!! SSR did not respond within ${HEALTH_TIMEOUT}s — rolling back"
  if [ -d public.old ]; then
    # Restore previous build.
    if [ -e public ]; then
      find public -depth -exec rm -rf {} + 2>/dev/null || true
      rm -rf public || true
    fi
    mv public.old public
    echo "--- rolled back public/ to previous build, restarting ultrax-ssr"
    pm2 restart ultrax-ssr || true
    if wait_for_ssr; then
      echo "--- SSR recovered after rollback ✓"
      echo "===== $(date -Iseconds) deploy FAILED — rolled back to previous build ====="
      exit 1
    else
      echo "!!! SSR still down after rollback — manual intervention required"
      echo "    check: pm2 logs ultrax-ssr --lines 80 --nostream"
      exit 2
    fi
  else
    echo "!!! no public.old to roll back to — manual intervention required"
    exit 2
  fi
fi

echo "===== $(date -Iseconds) deploy finished ====="
