import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as asar from "@electron/asar";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const filesUnder = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const name = path.join(directory, entry.name);
  return entry.isDirectory() ? filesUnder(name) : [name.replaceAll(path.sep, "/")];
});
const builtFiles = [...filesUnder("dist-electron"), ...filesUnder("out")];
const allowed = new Set([...builtFiles, "package.json"]);
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const archives = [
  "release/mac-arm64/MNSG Level Editor.app/Contents/Resources/app.asar",
  "release/mac/MNSG Level Editor.app/Contents/Resources/app.asar",
  "release/win-unpacked/resources/app.asar",
];
const results = archives.map((archive) => {
  const entries = asar.listPackage(archive).map((entry) => entry.replace(/^\/+/, ""));
  const files = entries.filter((entry) => !asar.statFile(archive, entry).files);
  const unexpected = files.filter((entry) => !allowed.has(entry));
  assert.deepEqual(unexpected, [], `${archive}: archive contains files outside the verified build`);
  const romFiles = entries.filter((entry) => /\.(z64|v64|n64|rom)$/i.test(entry));
  assert.deepEqual(romFiles, [], `${archive}: distribution must not contain ROM files`);
  for (const file of builtFiles) assert.equal(hash(asar.extractFile(archive, file)), hash(readFileSync(file)), `${archive}: ${file} differs from the current build`);
  const metadata = JSON.parse(asar.extractFile(archive, "package.json"));
  assert.equal(metadata.version, pkg.version);
  assert.equal(metadata.main, pkg.main);
  return { archive, sha256: hash(readFileSync(archive)), entries: entries.length, files: files.length, romFiles: romFiles.length, unexpectedFiles: unexpected.length, matchingBuiltFiles: builtFiles.length, appVersion: metadata.version };
});
writeFileSync("release/archive-audit.json", `${JSON.stringify(results, null, 2)}\n`);
console.log(JSON.stringify(results, null, 2));
// The ASAR library may retain workers on newer Node versions after a script.
process.exit(0);
