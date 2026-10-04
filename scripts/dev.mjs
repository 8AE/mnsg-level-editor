import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { Agent, request } from "node:http";
const require = createRequire(import.meta.url);
const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;
const runNode = (args) => spawn(process.execPath, args, { stdio: "inherit", env: childEnv });
const builder = runNode(["scripts/build-electron.mjs"]);
if (await new Promise((resolve) => builder.on("exit", resolve)) !== 0) process.exit(1);
const next = runNode(["node_modules/next/dist/bin/next", "dev", "--webpack", "--hostname", "127.0.0.1", "--port", "3000"]);
let desktop;
let stopped = false;
function stop(code = 0) { if (stopped) return; stopped = true; desktop?.kill(); next.kill(); process.exitCode = code; }
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
next.on("exit", (code) => stop(code ?? 1));
const deadline = Date.now() + 90_000;
const localhostAgent = new Agent();
const ready = () => new Promise((resolve) => {
  const probe = request({ hostname: "127.0.0.1", port: 3000, path: "/", method: "HEAD", agent: localhostAgent }, (response) => { response.resume(); resolve(response.statusCode === 200); });
  probe.setTimeout(5000, () => probe.destroy());
  probe.on("error", () => resolve(false));
  probe.end();
});
while (!stopped && Date.now() < deadline) {
  if (await ready()) break;
  await new Promise((resolve) => setTimeout(resolve, 500));
}
if (!stopped && Date.now() >= deadline) { console.error("Next.js did not become ready within 90 seconds."); stop(1); }
if (!stopped) {
  console.info("Opening MNSG Level Editor...");
  desktop = spawn(require("electron"), ["."], { stdio: "inherit", env: { ...childEnv, MNSG_DEV_URL: "http://127.0.0.1:3000" } });
  desktop.on("exit", (code) => stop(code ?? 0));
}
