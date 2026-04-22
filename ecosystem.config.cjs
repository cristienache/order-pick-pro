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
      env: {
        NODE_ENV: "production",
        SSR_HOST: process.env.SSR_HOST || "127.0.0.1",
        SSR_PORT: process.env.SSR_PORT || "4173",
        PORT: process.env.SSR_PORT || "4173",
      },
    },
  ],
};
