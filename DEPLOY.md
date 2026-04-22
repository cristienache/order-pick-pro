# Ultrax Picklist — Self-Hosted Setup (CloudPanel + PM2)

Multi-user WooCommerce picklist generator. The app is a **TanStack Start SSR
React app** plus a **Node + Express + SQLite API**. Both run as PM2 processes
behind nginx (CloudPanel).

| Process | What it is | Listens on |
| --- | --- | --- |
| `ultrax-ssr` | Frontend SSR — `scripts/ssr-server.mjs` serving the built `dist/server/server.js` bundle | `127.0.0.1:4173` |
| `ultrax-api` | Backend API — Node + Express in `server/` | `127.0.0.1:3000` |

Master admin email: `contact@ultrax.work` (auto-promoted on first login).
Database is a single SQLite file at `server/data/ultrax.db`.

> ⚠️ **There is NO static `public/` build anymore.** Older versions of this
> guide told you to copy `dist/` to `public/` and serve it as static files.
> Don't. The current build emits an SSR Worker bundle that must be served by
> Node via `scripts/ssr-server.mjs`. nginx must reverse-proxy to it, not serve
> files from disk.

---

## 1. CloudPanel — create the site

1. Log in to CloudPanel → **Sites** → **+ Add Site** → **Create a Node.js Site**.
2. **Domain**: `www.ultrax.work` (also add `ultrax.work` as alias if you want both).
3. **Node.js version**: `20 LTS` or newer.
4. **App Port**: `3000` (this is just what CloudPanel pre-fills — we override
   the proxy ourselves in section 5).
5. **Site User**: e.g. `ultrax` — note this; you'll SSH as this user.

After creation, go to **SSL/TLS → Actions → New Let's Encrypt Certificate** to
enable HTTPS.

---

## 2. SSH in and clone the repo

```bash
ssh ultrax@your-server-ip
cd ~/htdocs/www.ultrax.work
# CloudPanel pre-creates this folder. Clear placeholder content.
rm -rf ./* ./.[!.]*
git clone https://github.com/YOUR_USERNAME/YOUR_REPO.git .
```

---

## 3. Backend (`ultrax-api`) — install, configure, start

```bash
cd ~/htdocs/www.ultrax.work/server
npm install --omit=dev

# Generate secrets
JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")
ENC_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")

cp .env.example .env
# Edit .env and paste the generated values:
#   JWT_SECRET=...
#   ENCRYPTION_KEY=...
#   ADMIN_EMAIL=contact@ultrax.work
#   PORT=3000
#   CORS_ORIGIN=https://www.ultrax.work,https://ultrax.work
nano .env
```

> 🔐 **Back up your `ENCRYPTION_KEY`!** Without it every saved WooCommerce key
> in the database becomes unreadable.

Install PM2 globally and start the API:

```bash
sudo npm install -g pm2
cd ~/htdocs/www.ultrax.work/server
pm2 start index.js --name ultrax-api
```

Verify the API is up:

```bash
curl http://127.0.0.1:3000/api/health
# {"ok":true,"time":"..."}
```

---

## 4. Frontend (`ultrax-ssr`) — build and start

```bash
cd ~/htdocs/www.ultrax.work
npm install --include=dev --no-audit --no-fund
npm run build
```

The build must produce **`dist/server/server.js`** (the SSR entry) and
**`dist/client/`** (browser assets). If `dist/server/server.js` is missing
after `npm run build`, the SSR launcher will refuse to start with a clear
error — fix the build before going further.

Start the SSR process via the bundled ecosystem config:

```bash
cd ~/htdocs/www.ultrax.work
pm2 start ecosystem.config.cjs --only ultrax-ssr
```

Persist both processes across reboots:

```bash
pm2 save
pm2 startup
# PM2 prints a `sudo ...` command — run it, then:
pm2 save
```

Verify SSR is healthy locally **before** touching nginx:

```bash
curl -I http://127.0.0.1:4173/_health   # → 200 OK, body: "ok"
curl -I http://127.0.0.1:4173/          # → 200 OK, HTML
```

If `/_health` is 200 but `/` is not, the SSR bundle has a runtime bug — check
`pm2 logs ultrax-ssr --lines 200 --nostream`. If `/_health` itself doesn't
respond, the SSR process never finished booting; check the same logs.

---

## 5. CloudPanel / nginx — reverse-proxy to both processes

This is the canonical vhost. Replace the entire CloudPanel vhost contents with
this (adapt the site user / paths if different):

```nginx
server {
    listen 80;
    listen [::]:80;
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;

    {{ssl_certificate_key}}
    {{ssl_certificate}}

    server_name www.ultrax.work ultrax.work;

    {{nginx_access_log}}
    {{nginx_error_log}}

    if ($scheme != "https") {
        rewrite ^ https://$host$request_uri permanent;
    }

    # Backend API → Node (ultrax-api)
    location /api/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;
    }

    # Everything else → SSR (ultrax-ssr) on port 4173.
    # No `root`, no `try_files`, no static folder. The SSR process serves
    # both the HTML and the bundled /assets/* files.
    location / {
        proxy_pass http://127.0.0.1:4173;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 120s;
    }
}
```

Click **Save** (CloudPanel reloads nginx). Then validate end-to-end:

```bash
curl -I http://127.0.0.1:4173/_health   # local SSR
curl -I https://www.ultrax.work/        # through nginx
```

> 💥 **If `127.0.0.1:4173/_health` is 200 but `https://www.ultrax.work` is 502,
> the bug is in this vhost — not in the app.** Common causes: `root` still
> pointing at a non-existent `public/client/` directory, an old `try_files`
> line, or the `location /` block missing `proxy_pass`.

---

## 6. First login — create the master admin

1. Open `https://www.ultrax.work` in your browser.
2. You'll see a **First-time setup** screen with `contact@ultrax.work`
   pre-filled.
3. Choose a strong password (8+ chars). Click **Create master admin**.
4. You're now logged in as admin.

---

## 7. Inviting users

- Go to **Invites** in the top nav.
- Click **New invite**, enter an email, choose **User** or **Admin**.
- Copy the link and send it. They open it, set their password, they're in.
- Each user manages their own sites and only sees their own data.

---

## Updating the app

### Manual update

```bash
cd ~/htdocs/www.ultrax.work
git pull

# Frontend
npm install --include=dev --no-audit --no-fund
npm run build
pm2 reload ultrax-ssr --update-env

# Backend (only if server/ changed)
cd server
npm install --omit=dev
pm2 restart ultrax-api
```

Then verify:

```bash
curl -I http://127.0.0.1:4173/_health
curl -I https://www.ultrax.work
```

### Automatic update on every git push (recommended)

The repo ships with `scripts/deploy.sh` and a webhook endpoint at
`POST /api/deploy/github` that runs it. After the first manual deploy:

```bash
# 1. Make the deploy script executable
chmod +x ~/htdocs/www.ultrax.work/scripts/deploy.sh

# 2. Generate a webhook secret and add it to server/.env
SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
echo "GITHUB_WEBHOOK_SECRET=$SECRET" >> ~/htdocs/www.ultrax.work/server/.env
echo "Webhook secret: $SECRET"   # copy this for step 4
pm2 restart ultrax-api
```

3. Confirm both PM2 processes exist (the deploy script reloads `ultrax-ssr`
   and restarts `ultrax-api` when `server/` changed):

```bash
pm2 list   # should show ultrax-api (fork) and ultrax-ssr (cluster, 2 workers)
```

4. In GitHub: **Settings → Webhooks → Add webhook**:
   - **Payload URL**: `https://www.ultrax.work/api/deploy/github`
   - **Content type**: `application/json`
   - **Secret**: paste `$SECRET` from step 2
   - **Events**: *Just the push event*
   - **Active**: ✅

5. Push to `main`. Watch the deploy:

```bash
tail -f ~/deploy.log
```

`scripts/deploy.sh` will:
1. `git fetch && reset --hard origin/main`
2. `npm install --include=dev` and `npm run build`
3. **Verify `dist/server/server.js` exists** (build sanity check)
4. Reinstall server deps + restart `ultrax-api` only if `server/` changed
5. `pm2 startOrReload` the SSR app
6. Poll `http://127.0.0.1:4173/_health` for up to `HEALTH_TIMEOUT` seconds
7. On failure: restore the previous `dist/` and reload again

A deploy is **only marked successful** when `/_health` returns 200. The
previous build is kept in `dist.previous/` until the new one is verified, so
broken pushes do not take the live site down.

---

## Backups

All user data lives in **one file**: `server/data/ultrax.db`. Add a daily
cron via CloudPanel → **Cron Jobs**:

```bash
0 3 * * * cp ~/htdocs/www.ultrax.work/server/data/ultrax.db ~/backups/ultrax-$(date +\%Y\%m\%d).db && find ~/backups -name "ultrax-*.db" -mtime +30 -delete
```

Also back up `server/.env` somewhere safe — without `ENCRYPTION_KEY` the DB
is unreadable.

---

## Troubleshooting

### Quick health snapshot

```bash
pm2 status
curl -I http://127.0.0.1:3000/api/health   # API
curl -I http://127.0.0.1:4173/_health      # SSR (cheap, no app render)
curl -I http://127.0.0.1:4173/             # SSR (full app render)
curl -I https://www.ultrax.work            # public, through nginx
```

### Decision tree

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `127.0.0.1:4173/_health` → connection refused | SSR process not running | `pm2 logs ultrax-ssr --lines 200 --nostream` — usually missing `dist/server/server.js` (rerun `npm run build`) |
| `/_health` → 200 but `/` → 500 | Runtime error inside the SSR bundle | `pm2 logs ultrax-ssr` for the stack trace |
| `127.0.0.1:4173/` → 200 but `https://www.ultrax.work` → 502 | nginx vhost is wrong (still pointing at old `public/client` or missing `proxy_pass`) | Re-apply the vhost in section 5, then `sudo nginx -t && sudo systemctl reload nginx` |
| `/api/...` → 502 | `ultrax-api` is down or vhost `/api/` block is missing | `pm2 restart ultrax-api`; recheck vhost |
| Deploy log shows `[BUILD FAILURE]` | `npm run build` failed in CI | Old `dist/` was restored automatically; site stays up. Fix the build error and push again. |
| Deploy log shows `[MISSING SSR BUNDLE]` | Build ran but didn't emit `dist/server/server.js` | Usually `vite.config.ts` regressed (e.g. `cloudflare: true` re-introduced). Ensure SSR target is Node. |
| Deploy log shows `[SSR BOOT FAILURE]` | New build crashes on boot | Old `dist/` was restored automatically. Inspect with `pm2 logs ultrax-ssr --lines 200 --nostream`. |

### Useful commands

```bash
pm2 logs ultrax-ssr --lines 200 --nostream
pm2 logs ultrax-api --lines 200 --nostream
pm2 reload ultrax-ssr --update-env
sudo nginx -t && sudo systemctl reload nginx
```

**"Invalid credentials" on first login** → you haven't bootstrapped yet.
Refresh — the setup screen should appear if no users exist.

**API returns CORS errors** → check `CORS_ORIGIN` in `server/.env` matches the
URL you're loading the frontend from. Restart `ultrax-api` after changes.

**Lost the encryption key** → saved consumer keys can't be decrypted. Users
will need to re-add their sites with fresh keys. Always back up `.env`.
