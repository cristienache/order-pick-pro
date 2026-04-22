import { preview } from "vite";

const host = process.env.SSR_HOST || "127.0.0.1";
const port = Number(process.env.PORT || process.env.SSR_PORT || 4173);

let shuttingDown = false;
let httpServer;

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
  const server = await preview({
    preview: {
      host,
      port,
      strictPort: true,
    },
  });

  httpServer = server.httpServer;
  if (!httpServer) {
    throw new Error("Vite preview did not expose an HTTP server");
  }

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
