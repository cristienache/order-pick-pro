import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";

const host = process.env.SSR_HOST || "127.0.0.1";
const port = Number(process.env.PORT || process.env.SSR_PORT || 4173);
const serverBundlePath = resolve("dist/server/server.js");
const serverBundleUrl = pathToFileURL(serverBundlePath).href;

let shuttingDown = false;
let httpServer;

function fatal(message) {
  console.error(`[ssr] FATAL: ${message}`);
  process.exit(1);
}

async function loadServerEntry() {
  if (!existsSync(serverBundlePath)) {
    fatal(
      `SSR bundle missing at ${serverBundlePath}. ` +
        `Run \`npm run build\` before starting PM2. ` +
        `If this happened during a deploy, the build step likely failed — check the deploy log.`,
    );
  }

  let mod;
  try {
    mod = await import(`${serverBundleUrl}?t=${Date.now()}`);
  } catch (error) {
    fatal(
      `Failed to import SSR bundle (${serverBundlePath}): ` +
        (error instanceof Error ? error.stack || error.message : String(error)),
    );
  }

  const entry = mod.default;
  if (!entry || typeof entry.fetch !== "function") {
    fatal("Built SSR bundle did not expose a fetch handler (expected `export default { fetch }`)");
  }

  return entry;
}

function createNodeRequest(req) {
  const protocolHeader = req.headers["x-forwarded-proto"];
  const protocol = Array.isArray(protocolHeader) ? protocolHeader[0] : protocolHeader || "http";
  const hostHeader = req.headers.host || `${host}:${port}`;
  const url = new URL(req.url || "/", `${protocol}://${hostHeader}`);
  const headers = new Headers();

  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      value.forEach((item) => headers.append(key, item));
    } else {
      headers.set(key, value);
    }
  }

  const body = req.method === "GET" || req.method === "HEAD" ? undefined : Readable.toWeb(req);

  return new Request(url, {
    method: req.method,
    headers,
    ...(body ? { body, duplex: "half" } : {}),
  });
}

function writeResponseHeaders(res, headers) {
  if (typeof headers.getSetCookie === "function") {
    const cookies = headers.getSetCookie();
    if (cookies.length > 0) {
      res.setHeader("set-cookie", cookies);
    }
  }

  headers.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie") return;
    res.setHeader(key, value);
  });
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;

  if (httpServer) {
    await new Promise((resolvePromise, reject) => {
      httpServer.close((error) => {
        if (error) reject(error);
        else resolvePromise();
      });
    }).catch((error) => {
      console.error("Failed to close SSR server cleanly:", error);
    });
  }

  process.exit(0);
}

async function main() {
  // Load + verify the bundle BEFORE we start listening or signal readiness.
  // If the bundle is missing or broken, PM2's `wait_ready` will time out and
  // the deploy script's health check will fail loudly instead of silently
  // restarting forever.
  const serverEntry = await loadServerEntry();

  httpServer = createServer(async (req, res) => {
    // Lightweight health endpoint — does NOT invoke the full app.
    // Used by scripts/deploy.sh and by external uptime monitors.
    if (req.url === "/_health" || req.url === "/_health/") {
      res.statusCode = 200;
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      res.end("ok");
      return;
    }

    try {
      const request = createNodeRequest(req);
      const response = await serverEntry.fetch(request);

      res.statusCode = response.status;
      if (response.statusText) {
        res.statusMessage = response.statusText;
      }

      writeResponseHeaders(res, response.headers);

      if (!response.body) {
        res.end();
        return;
      }

      Readable.fromWeb(response.body).pipe(res);
    } catch (error) {
      console.error(
        "[ssr] request failed:",
        error instanceof Error ? error.stack || error.message : error,
      );
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("content-type", "text/plain; charset=utf-8");
      }
      res.end("Internal Server Error");
    }
  });

  await new Promise((resolvePromise, reject) => {
    httpServer.listen(port, host, (error) => {
      if (error) reject(error);
      else resolvePromise();
    });
  });

  console.log(`[ssr] Ultrax SSR listening on http://${host}:${port} (health: /_health)`);

  // Only signal PM2 readiness after the HTTP server is actually accepting
  // connections AND the bundle has been verified to load. This is what makes
  // `wait_ready: true` in ecosystem.config.cjs meaningful.
  if (typeof process.send === "function") {
    process.send("ready");
  }
}

process.on("SIGINT", () => {
  void shutdown();
});

process.on("SIGTERM", () => {
  void shutdown();
});

process.on("message", (message) => {
  if (message === "shutdown") {
    void shutdown();
  }
});

main().catch((error) => {
  console.error("[ssr] startup failed:", error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
