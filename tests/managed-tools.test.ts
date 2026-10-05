import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, chmod, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { ManagedTools, validateManagedManifest, verifyManagedFiles, inspectProbeNrm, type ManagedToolsManifest } from "../electron/managed-tools";

const fixturePlatform = process.platform === "win32" ? "win32" : "darwin";
const fixtureArch = fixturePlatform === "win32" ? "x64" : "arm64";
const fixture = (): ManagedToolsManifest => {
  const suffix = fixturePlatform === "win32" ? ".exe" : "";
  const paths = [`bin/clang${suffix}`, `bin/ld.lld${suffix}`, `bin/RecompModTool${suffix}`, "include/modding.h", "Goemon64RecompSyms/mnsg.us.syms.toml", "Goemon64RecompSyms/mnsg.us.datasyms.toml"];
  return { format: "mnsg-managed-tools", version: 1, bundleId: "fixture-v1", platform: fixturePlatform, arch: fixtureArch, files: paths.map((path, index) => ({ path, sha256: createHash("sha256").update(path).digest("hex"), byteLength: Buffer.byteLength(path), executable: index < 3 })), tools: { clang: paths[0], linker: paths[1], modTool: paths[2] }, support: { header: paths[3], functions: paths[4], data: paths[5] } };
};
async function bundle(root: string, manifest: ManagedToolsManifest) {
  await mkdir(root); for (const file of manifest.files) { await mkdir(dirname(join(root, file.path)), { recursive: true }); await writeFile(join(root, file.path), file.path); if (file.executable) await chmod(join(root, file.path), 0o755); }
  await writeFile(join(root, "manifest.json"), JSON.stringify(manifest));
}
test("managed manifest rejects wrong architecture, forged roles, paths and inventories", () => {
  const value = fixture(); assert.deepEqual(validateManagedManifest(value, fixturePlatform, fixtureArch), value);
  for (const candidate of [{ ...value, arch: fixtureArch === "x64" ? "arm64" : "x64" }, { ...value, url: "https://example.org" }, { ...value, tools: { ...value.tools, clang: "../clang" } }, { ...value, files: [...value.files, value.files[0]] }, { ...value, files: value.files.map((file, index) => index === 0 ? { ...file, executable: false } : file) }]) assert.throws(() => validateManagedManifest(candidate, fixturePlatform, fixtureArch));
});
test("cached probe skips execution only; mutable files are hashed on every reuse", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mnsg-managed-test-"));
  try {
    const root = join(directory, "tools"), manifest = fixture(); await bundle(root, manifest);
    let calls = 0; const tools = new ManagedTools(root, join(directory, "cache.json"), fixturePlatform, fixtureArch, async () => { calls++; });
    await tools.ensure(); await tools.ensure(); assert.equal(calls, 1);
    await writeFile(join(root, manifest.tools.clang), manifest.tools.clang.replace("bin/", "bad/"));
    await assert.rejects(tools.ensure(), /corrupt/); assert.equal(calls, 1);
    await writeFile(join(root, manifest.tools.clang), manifest.tools.clang); await tools.ensure(); assert.equal(calls, 1);
    await writeFile(join(root, "foreign"), "foreign"); await assert.rejects(verifyManagedFiles(root, manifest), /undeclared/);
    await rm(join(root, "foreign")); await rm(join(root, "include/modding.h")); await symlink(join(root, manifest.tools.clang), join(root, "include/modding.h")); await assert.rejects(verifyManagedFiles(root, manifest), /symlink/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("failed first setup never marks a bundle verified", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mnsg-managed-fail-"));
  try {
    const root = join(directory, "tools"); await bundle(root, fixture()); let calls = 0;
    const tools = new ManagedTools(root, join(directory, "cache.json"), fixturePlatform, fixtureArch, async () => { calls++; throw Error("probe compiler failed"); });
    await assert.rejects(tools.ensure(), /probe compiler/); await assert.rejects(tools.ensure()); assert.equal(calls, 2); await assert.rejects(readFile(join(directory, "cache.json")), { code: "ENOENT" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("probe archive rejects a ZIP signature without valid native content", () => {
  assert.throws(() => inspectProbeNrm(Uint8Array.from([0x50, 0x4b, 0x03, 0x04])));
  const empty = Buffer.alloc(22); empty.writeUInt32LE(0x06054b50); assert.throws(() => inspectProbeNrm(empty), /native binary/);
});
