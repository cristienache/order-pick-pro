#!/usr/bin/env bash
# Auto-deploy script. Triggered by the GitHub webhook in server/index.js.
# Pulls the latest code, rebuilds the frontend, swaps the public dir, and
# restarts pm2 processes. All output goes to ~/deploy.log so you can tail
# it from SSH if anything misbehaves.
set -euo pipefail

# Resolve the project root (this script lives in <project>/scripts/)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_FILE="${HOME}/deploy.log"

exec >>"$LOG_FILE" 2>&1
echo ""
echo "===== $(date -Iseconds) deploy starting ====="
cd "$PROJECT_DIR"

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
npm run build

# 3. Swap dist -> public atomically-ish.
# Guard: only swap if the build actually produced output. If `public` already
# exists we MUST delete it before `mv dist public`, otherwise mv would move
# dist *inside* the existing public/, which is what caused the
# dist/client/client/client/... nesting on subsequent runs.
if [ -d dist ]; then
  echo "--- swapping dist -> public"
  rm -rf public.old || true
  if [ -e public ]; then
    mv public public.old
    # Wipe the old tree from the leaves up in case it inherited the nesting.
    find public.old -depth -exec rm -rf {} + 2>/dev/null || true
    rm -rf public.old || true
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

# 5. Restart SSR worker so the new build is served
pm2 restart ultrax-ssr || true

echo "===== $(date -Iseconds) deploy finished ====="
