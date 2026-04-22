// PM2 process config for Ultrax.
//
// We run the SSR app via scripts/ssr-server.mjs (NOT `vite preview`). The
// launcher signals readiness with `process.send("ready")` only after the
// dist/server/server.js bundle has been imported successfully AND the HTTP
// server is accepting connections. That is what makes `wait_ready: true`
// meaningful here — PM2 will not consider a worker "online" until SSR is
// genuinely serving requests, which in turn lets scripts/deploy.sh trust its
// /_health probe.
module.exports = {
  apps: [
    {
      name: "ultrax-ssr",
      cwd: __dirname,
      script: "scripts/ssr-server.mjs",
      instances: Number(process.env.SSR_INSTANCES || 2),
      exec_mode: "cluster",
      wait_ready: true,
      listen_timeout: Number(process.env.SSR_LISTEN_TIMEOUT || 30000),
      kill_timeout: Number(process.env.SSR_KILL_TIMEOUT || 5000),
      max_restarts: Number(process.env.SSR_MAX_RESTARTS || 10),
      restart_delay: Number(process.env.SSR_RESTART_DELAY || 2000),
      out_file: process.env.SSR_OUT_FILE || undefined,
      error_file: process.env.SSR_ERROR_FILE || undefined,
      merge_logs: true,
      env: {
        NODE_ENV: "production",
        SSR_HOST: process.env.SSR_HOST || "127.0.0.1",
        SSR_PORT: process.env.SSR_PORT || "4173",
        PORT: process.env.SSR_PORT || "4173",
      },
    },
  ],
};
