import { createServer } from "node:http";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";

const host = process.env.SSR_HOST || "127.0.0.1";
const port = Number(process.env.PORT || process.env.SSR_PORT || 4173);
const serverBundleUrl = pathToFileURL(resolve("dist/server/server.js")).href;

let shuttingDown = false;
let httpServer;

async function loadServerEntry() {
  const mod = await import(`${serverBundleUrl}?t=${Date.now()}`);
  const entry = mod.default;

  if (!entry || typeof entry.fetch !== "function") {
    throw new Error("Built SSR bundle did not expose a fetch handler");
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
    await new Promise((resolve, reject) => {
      httpServer.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    }).catch((error) => {
      console.error("Failed to close SSR server cleanly:", error);
    });
  }

  process.exit(0);
}

async function main() {
  const serverEntry = await loadServerEntry();

  httpServer = createServer(async (req, res) => {
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
      console.error("SSR request failed:", error instanceof Error ? error.stack || error.message : error);
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

  console.log(`Ultrax SSR listening on http://${host}:${port}`);

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
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
