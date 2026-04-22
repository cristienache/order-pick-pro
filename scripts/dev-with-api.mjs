import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const children = [];

function start(name, command, args, env = process.env, cwd = process.cwd()) {
  const child = spawn(command, args, {
    stdio: "inherit",
    env,
    shell: false,
    cwd,
  });

  child.on("exit", (code, signal) => {
    const details = signal ? `signal ${signal}` : `code ${code ?? 0}`;
    console.log(`[${name}] exited with ${details}`);

    if (name === "vite") {
      shutdown(code ?? 0);
    }
  });

  children.push(child);
  return child;
}

let shuttingDown = false;
function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  for (const child of children) {
    if (!child.killed) {
      child.kill("SIGTERM");
    }
  }

  setTimeout(() => process.exit(exitCode), 100);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

async function waitForApi(url, attempts = 40) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(url);
      if (response.ok || response.status === 401 || response.status === 404) return;
    } catch {}
    await delay(500);
  }

  throw new Error(`API did not become ready: ${url}`);
}

async function main() {
  start(
    "api",
    "node",
    ["index.js"],
    {
      ...process.env,
      NODE_ENV: process.env.NODE_ENV || "development",
    },
    "server",
  );

  await waitForApi("http://127.0.0.1:3000/api/auth/status");
  start("vite", "vite", ["dev"], process.env);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  shutdown(1);
});
