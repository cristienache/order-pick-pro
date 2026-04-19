import { spawn } from "node:child_process";

const children = [];

function start(name, command, args, env = process.env) {
  const child = spawn(command, args, {
    stdio: "inherit",
    env,
    shell: false,
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

start("api", "node", ["server/index.js"], {
  ...process.env,
  NODE_ENV: process.env.NODE_ENV || "development",
});

start("vite", "vite", ["dev"], process.env);
