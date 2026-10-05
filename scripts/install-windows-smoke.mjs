import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { validateBundle } from "./managed-tools-contract.mjs";

// The native Windows CI runner is disposable. This executes the actual NSIS
// installer; subsequent steps launch the installed executable with fresh data.
if (process.platform !== "win32" || process.arch !== "x64") throw Error("Installer smoke requires native Windows x64.");
const pkg = JSON.parse(await readFile("package.json", "utf8"));
const installers = (await readdir("release")).filter(name => name.endsWith(`-${pkg.version}-win-x64.exe`));
assert.equal(installers.length, 1, "Exactly one current Windows installer");
const destination = await mkdtemp(path.join(tmpdir(), "MNSG install O'Brien-日本語-"));
// NSIS requires /D to be the final, unquoted argument, including when it has
// spaces. execFile uses no shell. https://nsis.sourceforge.io/Docs/Chapter3.html
execFileSync(path.resolve("release", installers[0]), ["/S", `/D=${destination}`], {
  windowsVerbatimArguments: true, windowsHide: true, stdio: "inherit", timeout: 120000,
});
const executable = path.join(destination, `${pkg.build.productName}.exe`);
const bundle = path.join(destination, "resources", "managed-tools");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
for (const relative of [`${pkg.build.productName}.exe`, "resources/app.asar", "resources/managed-tools/manifest.json"]) {
  assert.equal(hash(await readFile(path.join(destination, relative))), hash(await readFile(path.join("release/win-unpacked", relative))), `Installer must preserve ${relative}`);
}
await validateBundle(bundle);
const report = { installer: installers[0], destination, executable, bundle, appVersion: pkg.version,
  payloadParity: true, toolInventoryVerified: true, nonAsciiApostropheAndSpaceInstallPath: true };
await writeFile("release/windows-install-check.json", JSON.stringify(report, null, 2));
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `executable=${executable}\nbundle=${bundle}\n`);
console.log(JSON.stringify(report, null, 2));
