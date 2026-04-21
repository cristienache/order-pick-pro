# Ultrax Picklist — Self-Hosted Setup (CloudPanel + PM2)

Multi-user WooCommerce picklist generator. Frontend is a static React app, backend is Node + Express + SQLite.

- **Frontend**: served as static files from `htdocs/www.ultrax.work/public`
- **Backend**: Node API on `127.0.0.1:3000`, reverse-proxied by CloudPanel under `/api/*`
- **Database**: SQLite file at `server/data/ultrax.db`

Master admin email: `contact@ultrax.work` (auto-promoted on first login).

---

## 1. CloudPanel — create the site

1. Login to CloudPanel → **Sites** → **+ Add Site** → **Create a Node.js Site**
2. **Domain**: `www.ultrax.work` (also add `ultrax.work` as alias if you want both)
3. **Node.js version**: `20 LTS`
4. **App Port**: `3000`
5. **Site User**: e.g. `ultrax` — note this; you'll SSH as this user.

After creation, go to **SSL/TLS** → **Actions** → **New Let's Encrypt Certificate** to enable HTTPS.

---

## 2. SSH in and clone the repo

```bash
ssh ultrax@your-server-ip
cd ~/htdocs/www.ultrax.work
# CloudPanel pre-creates this folder. Clear placeholder content.
rm -rf ./*
git clone https://github.com/YOUR_USERNAME/YOUR_REPO.git .
```

---

## 3. Backend — install, configure, and start

```bash
cd ~/htdocs/www.ultrax.work/server
npm install --omit=dev

# Generate secrets
JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")
ENC_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")

cp .env.example .env
# Open .env in your editor and paste the generated values:
#   JWT_SECRET=...
#   ENCRYPTION_KEY=...
#   ADMIN_EMAIL=contact@ultrax.work
#   PORT=3000
#   CORS_ORIGIN=https://www.ultrax.work,https://ultrax.work
nano .env
```

> **Backup your `ENCRYPTION_KEY`!** If you lose it, every saved WooCommerce key in the database becomes unreadable.

Start with PM2 (auto-restart on crash, auto-start on reboot):

```bash
sudo npm install -g pm2
cd ~/htdocs/www.ultrax.work/server
pm2 start index.js --name ultrax-api
pm2 save
pm2 startup
# PM2 will print a command — copy/paste it, run with sudo, then:
pm2 save
```

Verify the API is up:

```bash
curl http://127.0.0.1:3000/api/health
# {"ok":true,"time":"..."}
```

---

## 4. Frontend — build the frontend bundle

The build outputs to `dist/` with separate `client/` and `server/` folders.

```bash
cd ~/htdocs/www.ultrax.work
npm install
npm run build
```

> Note: this project is built with TanStack Start for a Cloudflare-style SSR target, so it does **not** emit a standalone static `index.html` in `dist/client/` by default.

---

## 5. CloudPanel — reverse proxy `/api/*` to the Node backend

CloudPanel's Node.js site already proxies the root domain to your app port.
We need to **also serve static files from `public/`** and only proxy `/api/*` to Node.

Go to **Sites → www.ultrax.work → Vhost** and replace the contents with the
following (adapt the site user/path):

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
    root /home/ultrax/htdocs/www.ultrax.work/public/client;
    index index.html;

    {{nginx_access_log}}
    {{nginx_error_log}}

    if ($scheme != "https") {
        rewrite ^ https://$host$request_uri permanent;
    }

    # API → Node backend
    location /api/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;
    }

    # Static frontend (SPA fallback)
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Cache static assets
    location ~* \.(?:css|js|woff2?|ttf|eot|svg|png|jpg|jpeg|gif|webp|ico)$ {
        expires 30d;
        access_log off;
        add_header Cache-Control "public";
    }
}
```

Click **Save** (CloudPanel reloads nginx).

---

## 6. First login — create the master admin

1. Open `https://www.ultrax.work` in your browser.
2. You'll see a **First-time setup** screen with `contact@ultrax.work` pre-filled.
3. Choose a strong password (8+ chars). Click **Create master admin**.
4. You're now logged in as admin.

---

## 7. Inviting users

- Go to **Invites** in the top nav.
- Click **New invite**, enter an email, choose **User** or **Admin**.
- Copy the link and send it to them. They open it, set their password, and they're in.
- Each user manages their own sites and only sees their own data.

---

## Updating the app

### Manual update

```bash
cd ~/htdocs/www.ultrax.work
git pull

# Frontend
npm install
npm run build
rm -rf public && mv dist public

# Backend (only if server/ changed)
cd server
npm install --omit=dev
pm2 restart ultrax-api
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

3. Make sure both pm2 processes exist (the script restarts both):

```bash
pm2 list   # should show ultrax-api and ultrax-ssr
```

4. In GitHub, go to your repo → **Settings → Webhooks → Add webhook**:
   - **Payload URL**: `https://www.ultrax.work/api/deploy/github`
   - **Content type**: `application/json`
   - **Secret**: paste the `$SECRET` value from step 2
   - **Events**: *Just the push event*
   - **Active**: ✅
   - Save. GitHub sends a `ping` immediately — green tick = wired up.

5. Push to `main` (Lovable does this automatically when you accept changes).
   Within ~30 seconds the site rebuilds. Watch progress with:

```bash
tail -f ~/deploy.log
```

The script does: `git fetch && reset --hard origin/main`, `npm install`,
`npm run build`, swaps `dist` → `public`, reinstalls server deps only when
`server/` changed in the push, and restarts both pm2 processes.

---

## Backups

The entire user data lives in **one file**: `server/data/ultrax.db`.

Add a daily cron via CloudPanel → **Cron Jobs**:

```bash
0 3 * * * cp ~/htdocs/www.ultrax.work/server/data/ultrax.db ~/backups/ultrax-$(date +\%Y\%m\%d).db && find ~/backups -name "ultrax-*.db" -mtime +30 -delete
```

Also back up `server/.env` somewhere safe — without `ENCRYPTION_KEY` the DB is unreadable.

---

## Troubleshooting

```bash
pm2 logs ultrax-api          # backend logs
pm2 restart ultrax-api       # restart after .env changes
pm2 status                   # is it running?
curl http://127.0.0.1:3000/api/health   # backend health
sudo nginx -t                # validate nginx config after vhost edits
```

**"Invalid credentials" on first login** → you haven't bootstrapped yet. Refresh — the setup screen should appear if no users exist.

**API returns CORS errors** → check `CORS_ORIGIN` in `.env` matches the URL you're loading the frontend from. Restart pm2 after changes.

**Lost the encryption key** → the saved consumer keys can't be decrypted. Users will need to re-add their sites with fresh keys. Always back up `.env`.
