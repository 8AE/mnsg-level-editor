import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, symlink, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clampWindowBounds, panelName, writeConfinedBundle, nrmOutputName, nrmOutputFiles } from "../electron/storage";
import { materializeProjectWorkspace, invalidateProjectWorkspace, projectWorkspaceKey, iconDimensions, modAttachment, projectTemplateFiles } from "../electron/project-workspaces";
import { createProject } from "../core/project";

test("native panel tokens and saved bounds stay within current displays", () => {
  assert.equal(panelName("mnsg-panel-scene"), "scene");
  for (const name of ["scene", "mnsg-panel-scene-extra", "mnsg-panel-../scene", "mnsg-panel-"]) assert.equal(panelName(name), undefined);
  const display = { x: -1280, y: 0, width: 1280, height: 800 }, fallback = { x: 0, y: 0, width: 900, height: 700 };
  assert.deepEqual(clampWindowBounds({ x: 99999, y: -900, width: 99999, height: -1 }, [display], fallback), { x: -1280, y: 0, width: 1280, height: 260 });
  assert.deepEqual(clampWindowBounds({ x: NaN }, [display], fallback), { x: -900, y: 0, width: 900, height: 700 });
});
test("materialized templates replace stale files without reading project state from disk", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mnsg-workspace-test-"));
  try {
    const root = join(directory, "owned"); const a = await materializeProjectWorkspace(root, "project-A", "v1", { "mod.toml": "one", "thumb.png": "old", "extras/a.txt": "old" });
    await invalidateProjectWorkspace(root, "project-A");
    assert.match(await readFile(join(a.path, "build-status.txt"), "utf8"), /outdated/);
    await writeFile(join(a.path, "mod.toml"), "external change");
    const b = await materializeProjectWorkspace(root, "project-A", "v2", { "mod.toml": "two" });
    assert.equal(a.path, b.path); assert.equal(await readFile(join(b.path, "mod.toml"), "utf8"), "two"); assert.deepEqual(await readdir(b.path), ["mod.toml"]);
    assert.notEqual(projectWorkspaceKey("project-A"), projectWorkspaceKey("project-B"));
    const legacy = await materializeProjectWorkspace(root, "../legacy identity 日本語", "v1", { "mod.toml": "legacy" });
    assert.equal(legacy.path, join(root, projectWorkspaceKey("../legacy identity 日本語")));
    assert.match(projectWorkspaceKey("a".repeat(128)), /^[a-f0-9]{64}$/);
    for (const id of ["", " ", "a".repeat(129), "legacy\u0000id"]) assert.throws(() => projectWorkspaceKey(id));
    await assert.rejects(materializeProjectWorkspace(root, "project-A", "v1", { "../escape": "bad" })); assert.equal(await readFile(join(b.path, "mod.toml"), "utf8"), "two");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("an unchanged project gets its own settings and support without native admission", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mnsg-template-test-"));
  try {
    await mkdir(join(directory, "include")); await mkdir(join(directory, "Goemon64RecompSyms"));
    await writeFile(join(directory, "include/modding.h"), "verified macros");
    await writeFile(join(directory, "Goemon64RecompSyms/mnsg.us.syms.toml"), "functions");
    await writeFile(join(directory, "Goemon64RecompSyms/mnsg.us.datasyms.toml"), "data");
    const project = createProject("No room edits", { sha256: "a".repeat(64), normalizedSha256: "b".repeat(64), title: "MNSG", gameCode: "US", region: "US", byteLength: 0x2000000, decompressed: true });
    const files = await projectTemplateFiles(project, { templatePath: directory });
    assert.equal(Buffer.from(files["Goemon64RecompSyms/mnsg.syms.toml"]).toString(), "functions");
    assert.deepEqual(JSON.parse(files["project.mnsgproj"] as string), project);
    assert.match(files["mnsg_level_patch.c"] as string, /during export/);
    assert.match(files["mod.toml"] as string, /No room edits/);
    const forged = { ...project, mod: { ...project.mod!, attachments: [modAttachment("project.mnsgproj", Buffer.from("x"), "text/plain")] } };
    await assert.rejects(projectTemplateFiles(forged, { templatePath: directory }), /collid/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("export bundle preflight refuses symlink destinations before writing any file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mnsg-bundle-test-"));
  try {
    const output = join(directory, "output"), external = join(directory, "external"); await mkdir(output); await mkdir(external); await writeFile(join(external, "keep"), "untouched"); await symlink(external, join(output, "extras"));
    await assert.rejects(writeConfinedBundle(output, { "mod.toml": "bad", "extras/keep": "bad" }));
    await assert.rejects(readFile(join(output, "mod.toml")), { code: "ENOENT" }); assert.equal(await readFile(join(external, "keep"), "utf8"), "untouched");
    await assert.rejects(writeConfinedBundle(output, { "A": "one", "a": "two" }), /collide/);
    await assert.rejects(writeConfinedBundle(output, { "NUL.txt": "bad" }), /Unsafe/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("icon dimensions are checked before native image decoding and attachments are portable snapshots", () => {
  const png = Buffer.alloc(33); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png); png.writeUInt32BE(13, 8); png.write("IHDR", 12); png.writeUInt32BE(512, 16); png.writeUInt32BE(256, 20);
  assert.deepEqual(iconDimensions(png), { width: 512, height: 256, format: "png" });
  png.writeUInt32BE(65535, 16); assert.throws(() => iconDimensions(png), /megapixel/);
  const dds = Buffer.alloc(128); dds.write("DDS "); dds.writeUInt32LE(124, 4); dds.writeUInt32LE(32, 76); dds.writeUInt32LE(64, 12); dds.writeUInt32LE(128, 16);
  assert.deepEqual(iconDimensions(dds), { width: 128, height: 64, format: "dds" }); dds.write("DX10", 84); assert.throws(() => iconDimensions(dds), /truncated/);
  assert.throws(() => iconDimensions(Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 20])), /Truncated/);
  const attachment = modAttachment("extras/readme.txt", Buffer.from("hello"), "text/plain");
  assert.equal(Buffer.from(attachment.base64, "base64").toString(), "hello"); assert.equal(attachment.byteLength, 5); assert.match(attachment.sha256, /^[a-f0-9]{64}$/);
  assert.throws(() => modAttachment("../outside", Buffer.from("hello"), "text/plain"), /Unsafe/);
});
test("NRM output cannot be replaced by a sidecar or a case-insensitive filename collision", () => {
  const nrm = Buffer.from([0x50, 0x4b, 3, 4]), dll = Buffer.from("native library");
  assert.throws(() => nrmOutputFiles("library.dll", nrm, { "library.dll": dll }), /ending in \.nrm/);
  assert.throws(() => nrmOutputFiles("custom.NRM", nrm, { "CUSTOM.nrm": dll }), /collide/);
  assert.throws(() => nrmOutputFiles("custom.nrm", nrm, { "Foo.dll": dll, "foo.DLL": dll }), /collide/);
  assert.throws(() => nrmOutputFiles("custom.nrm", nrm, { "extras/library.dll": dll }), /basename/);
  assert.throws(() => nrmOutputName("NUL.nrm"), /Unsafe/);
  const files = nrmOutputFiles("renamed mod.NRM", nrm, { "library.dll": dll });
  assert.equal(files["renamed mod.NRM"], nrm); assert.equal(files["library.dll"], dll);
  assert.deepEqual(Object.keys(files), ["renamed mod.NRM", "library.dll"]);
});
