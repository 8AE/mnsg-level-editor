import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { generatePatch, exportNrm, inspectToolchain } from "../core/export";
import type { ActorData, EditorProject, RoomData } from "../shared/types";

const actor: ActorData = {
  id: "normal-0", index: 0, actorId: 10, name: "Synthetic actor", position: { x: 1, y: 2, z: 3 }, rotation: { x: 4, y: 5, z: 6 }, parameters: [1, 2, 3], editable: true, sourceKind: "normal",
  source: { romOffset: 0x100, fileId: 30, segmentedAddress: 0x08000100, expectedHex: "0001000200030004000500060800020000000000" },
  definitionSource: { romOffset: 0x200, fileId: 30, segmentedAddress: 0x08000200, expectedHex: "000a1234000000010000000200000003" },
};
function room(): RoomData { return { id: 1, name: "Synthetic room", actorCount: 1, eventCount: 0, geometryAvailable: false, warnings: [], actors: [structuredClone(actor)], events: [], meshes: [], source: { romOffset: 0, expectedHex: "" } }; }
function project(): EditorProject {
  return { format: "mnsg-level-project", version: 1, id: "test-fixture", name: "Fixture", createdAt: "2026-10-04T00:00:00Z", updatedAt: "2026-10-04T00:00:00Z", rom: { sha256: "a".repeat(64), normalizedSha256: "b".repeat(64), title: "Mystical Ninja", gameCode: "US", region: "US", byteLength: 0x2000000, decompressed: true }, roomOverrides: { "1": { actors: { "normal-0": { position: { x: -32768, y: 12, z: 32767 }, parameters: [4, 5, 0xffffffff] } }, events: {} } } };
}
test("patch preserves the unknown halfword and clones shared definitions", async () => {
  const generated = await generatePatch(project(), () => room());
  const source = generated.files["mnsg_level_patch.c"];
  assert.match(source, /0x000a1234u, 0x00000004u, 0x00000005u, 0xffffffffu/);
  assert.match(source, /RECOMP_HOOK\("func_8020D848_5C8D18"\)/);
  assert.match(source, /\*definition_slot = \(u32\)edit->edited_definition/);
  assert.match(source, /func_800141C4_14DC4\(edit->file\) == -1/);
  assert.match(source, /\*definition_slot = edit->definition/);
  assert.equal(generated.modId, "mnsg_level_test_fixture");
  assert.ok(generated.warnings.some(value => value.includes("opaque")));
});
test("rejects unloaded new actor types, events, altered record widths and invalid transforms", async () => {
  const invalidType = project(); invalidType.roomOverrides["1"].actors["normal-0"].actorId = 999;
  await assert.rejects(generatePatch(invalidType, () => room()), /original roster/);
  const invalidEvent = project(); invalidEvent.roomOverrides["1"].events.event = { values: [1] };
  await assert.rejects(generatePatch(invalidEvent, () => room()), /native format/);
  const invalidTransform = project(); invalidTransform.roomOverrides["1"].actors["normal-0"].position!.x = 32768;
  await assert.rejects(generatePatch(invalidTransform, () => room()), /signed 16/);
  const malformedRoom = room(); malformedRoom.actors[0].source.expectedHex = "00";
  await assert.rejects(generatePatch(project(), () => malformedRoom), /20-byte preimage/);
  const invalidParameters = project(); invalidParameters.roomOverrides["1"].actors["normal-0"].parameters = [1, 2, 3, 4];
  await assert.rejects(generatePatch(invalidParameters, () => room()), /exactly three/);
  const partitionRoom = room(); partitionRoom.actors[0].sourceKind = "partition";
  await assert.rejects(generatePatch(project(), () => partitionRoom), /proximity cells/);
});
test("rejects no-op exports and malformed project identifiers", async () => {
  const empty = project(); empty.roomOverrides = {};
  await assert.rejects(generatePatch(empty, () => room()), /no supported changes/);
  const malicious = project(); malicious.id = "bad; $(touch PWNED)";
  await assert.rejects(generatePatch(malicious, () => room()), /Project id/);
  const partial = project(); partial.roomOverrides["1"].actors["normal-0"] = { position: { ...actor.position }, parameters: [...actor.parameters] };
  await assert.rejects(generatePatch(partial, () => room()), /no supported changes/);
});
test("partition actor moves stay in the original native cell", async () => {
  const partitionRoom = room(); partitionRoom.actors[0].sourceKind = "partition";
  partitionRoom.actors[0].partition = { origin: { x: 0, y: 0, z: 0 }, cellSize: { x: 100, y: 100, z: 100 }, cellCount: { x: 4, y: 4, z: 4 }, originalCell: { x: 2, y: 2, z: 2 } };
  const within = project(); within.roomOverrides["1"].actors["normal-0"].position = { x: 20, y: 30, z: 40 };
  assert.ok((await generatePatch(within, () => partitionRoom)).files["mnsg_level_patch.c"]);
  const crosses = project(); crosses.roomOverrides["1"].actors["normal-0"].position = { x: 100, y: 2, z: 3 };
  await assert.rejects(generatePatch(crosses, () => partitionRoom), /original proximity cells/);
  // Large native cell counts expose a boundary where double precision differs.
  partitionRoom.actors[0].source.expectedHex = "7fff" + partitionRoom.actors[0].source.expectedHex.slice(4);
  partitionRoom.actors[0].position.x = 32767;
  partitionRoom.actors[0].partition.cellSize.x = 65535;
  partitionRoom.actors[0].partition.cellCount.x = 65535;
  partitionRoom.actors[0].partition.originalCell.x = 32768;
  const floatBoundary = project(); floatBoundary.roomOverrides["1"].actors["normal-0"].position = { x: 32765, y: 2, z: 3 };
  assert.equal(Math.trunc(32765 / 65535 + 65535 / 2), 32767);
  assert.ok((await generatePatch(floatBoundary, () => partitionRoom)).files["mnsg_level_patch.c"]);
});
test("missing toolchain reports configuration without starting a build", async () => {
  assert.equal((await inspectToolchain()).configured, false);
  const status = await inspectToolchain({ templatePath: "/a/nonexistent/template", clangPath: "/no/clang", linkerPath: "/no/linker", modToolPath: "/no/modtool" });
  assert.equal(status.ready, false); assert.ok(status.missing.length >= 3);
});

const integrationTemplate = process.env.MNSG_EXPORT_TEST_TEMPLATE;
test("real MIPS compile/link/package and NRM manifest (opt-in local toolchain)", { skip: !integrationTemplate }, async context => {
  const output = await exportNrm(project(), () => room(), { templatePath: integrationTemplate! });
  context.diagnostic(output.buildLog);
  assert.equal(output.fileName, "mnsg_level_test_fixture.nrm");
  assert.ok(output.bytes.length > 100);
  assert.match(output.buildLog, /-target.*mips/);
  const temporary = await mkdtemp(path.join(tmpdir(), "mnsg-export-test-"));
  try {
    const archive = path.join(temporary, output.fileName); await writeFile(archive, output.bytes);
    const listing = execFileSync("unzip", ["-Z1", archive], { encoding: "utf8" });
    assert.match(listing, /mod.json/); assert.match(listing, /mod_binary.bin/);
    const manifest = JSON.parse(execFileSync("unzip", ["-p", archive, "mod.json"], { encoding: "utf8" }));
    assert.equal(manifest.game_id, "mnsg"); assert.equal(manifest.id, "mnsg_level_test_fixture");
    assert.equal((await readFile(archive))[0], 0x50);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
