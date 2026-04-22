
Goal: stop the 502 loop by aligning the server setup with how this app actually runs now: SSR on port 4173, API on port 3000, and a deployment script that only reports success when SSR is really healthy.

Diagnosis
- Your latest logs show the app is serving locally on `http://127.0.0.1:4173/` with HTTP 200 and full HTML.
- That means the current app/runtime is not the thing returning 502.
- The repeated `ERR_MODULE_NOT_FOUND dist/server/server.js` entries are old PM2 error history from earlier failed boots, not proof of the current request path failing.
- The remaining failure is the web-server/proxy layer or deployment verification path, not the React app itself.

Implementation plan
1. Unify the self-hosting architecture in code and docs
- Treat the app as:
  - SSR app on `127.0.0.1:4173`
  - API on `127.0.0.1:3000`
- Remove the outdated “static frontend in `public/client`” deployment guidance from `DEPLOY.md`.
- Replace it with one canonical CloudPanel/nginx setup:
  - `/api/*` -> `127.0.0.1:3000`
  - all other traffic -> `127.0.0.1:4173`

2. Harden the SSR launcher so failures are explicit and cheap to detect
- Update `scripts/ssr-server.mjs` to expose a dedicated lightweight health endpoint such as `/_health`.
- Return a tiny `200 OK` response without invoking full app rendering.
- Add a startup file-existence check for the server bundle before PM2 readiness is signaled, with a clear fatal error message if the bundle is missing.

3. Tighten deployment health checks and rollback behavior
- Update `scripts/deploy.sh` to health-check `http://127.0.0.1:4173/_health` instead of `/`.
- Only mark deployment successful when that endpoint returns 200.
- Keep rollback logic, but make rollback health-check the same endpoint for consistency.
- Ensure deploy logs clearly distinguish:
  - build failure
  - missing SSR bundle
  - SSR boot failure
  - reverse-proxy issue

4. Align PM2 config with the hardened SSR flow
- Keep PM2 using `scripts/ssr-server.mjs`.
- Keep `wait_ready: true`.
- Ensure readiness is only emitted after the HTTP server is listening and the bundle has been loaded successfully.
- Add small operational hardening if needed (consistent env names, clearer process naming/logging).

5. Fix the self-hosting guide so future edits do not re-break production
- Rewrite `DEPLOY.md` so it no longer mixes old static hosting instructions with the newer SSR setup.
- Document the exact nginx/CloudPanel reverse proxy needed for this project.
- Document the one-time PM2 bootstrap command and the expected health checks.

6. Verify end-to-end after implementation
- Rebuild locally and confirm `/_health` returns 200.
- Confirm `/` returns 200 locally.
- After deploy, verify:
  - `curl -I http://127.0.0.1:4173/_health`
  - `curl -I http://127.0.0.1:4173/`
  - `curl -I https://www.ultrax.work`
- Check fresh PM2 logs after restart to confirm there are no new bundle-resolution errors.

Expected outcome
- App boots deterministically.
- Deploy script can detect broken SSR before declaring success.
- Rollbacks become reliable.
- Future Lovable changes won’t trigger the same 502 confusion caused by outdated deployment assumptions.

Technical details
- Files to update:
  - `scripts/ssr-server.mjs`
  - `scripts/deploy.sh`
  - `DEPLOY.md`
  - possibly `ecosystem.config.cjs` if readiness/logging needs a small adjustment
- No app-route refactor is needed for the current 502 issue.
- The key production correction is nginx/CloudPanel routing root traffic to port 4173, because the app is already proven healthy there.
