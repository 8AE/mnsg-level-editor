import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { generatePatch, exportNrm } from "../core/export";
import { geometryOperation, validateGeometryWrites, GEOMETRY_SPAN_LIMIT } from "../core/export/geometry";
import type { EditorProject, RoomData } from "../shared/types";
import type { GeometryTranslation } from "../core/rom/translation";
import { importRomBytes } from "../core/rom";
import { createProject, validateProject } from "../core/project";

function project(geometryOnly = true): EditorProject {
  return { format: "mnsg-level-project", version: 1, id: "geometry-fixture", name: "Geometry fixture", createdAt: "2026-10-04T00:00:00Z", updatedAt: "2026-10-04T00:00:00Z", rom: { sha256: "a".repeat(64), normalizedSha256: "b".repeat(64), title: "Fixture", gameCode: "US", region: "US", byteLength: 0x2000000, decompressed: true }, roomOverrides: { "1": { actors: geometryOnly ? {} : { "normal-0": { position: { x: 4, y: 5, z: 6 } } }, events: {}, geometry: { translation: { x: 257, y: 0, z: 0 } } } } };
}
function room(): RoomData {
  return { id: 1, name: "Fixture", actorCount: 1, eventCount: 0, geometryAvailable: true, warnings: [], events: [], meshes: [], source: { romOffset: 0, expectedHex: "" }, actors: [{ id: "normal-0", index: 0, actorId: 10, name: "Fixture", position: { x: 1, y: 2, z: 3 }, rotation: { x: 4, y: 5, z: 6 }, parameters: [1, 2, 3], editable: true, sourceKind: "normal", source: { romOffset: 0x1500, fileId: 30, segmentedAddress: 0x08000500, expectedHex: "0001000200030004000500060800060000000000" } }] };
}
function translation(): GeometryTranslation {
  return { roomId: 1, affectedRoomIds: [1, 2], guards: [
    { kind: "planeNormal", fileId: 9, segmentedAddress: 0x08000400, romOffset: 0x400, expectedHex: "3f8000000000000000000000" },
    { kind: "treeBranch", fileId: 9, segmentedAddress: 0x08000500, romOffset: 0x500, expectedHex: "000100020003" },
    { kind: "cellTopology", fileId: 10, segmentedAddress: 0x08000600, romOffset: 0x600, expectedHex: "ffff00010000" },
    { kind: "displayCommand", fileId: 9, segmentedAddress: 0x08000700, romOffset: 0x700, expectedHex: "0400300008000100" },
  ], spans: [
    { kind: "vertexXYZ", fileId: 9, segmentedAddress: 0x08000100, romOffset: 0x100, originalHex: "000100020003", replacementHex: "010200020003" },
    { kind: "planeDistance", fileId: 9, segmentedAddress: 0x08000200, romOffset: 0x200, originalHex: "3f800000", replacementHex: "40000000" },
    { kind: "cellBounds", fileId: 10, segmentedAddress: 0x08000300, romOffset: 0x300, originalHex: "001000100010fff0fff0fff0", replacementHex: "01110010001000f1fff0fff0" },
  ] };
}
test("geometry requires trusted translation callback and supports geometry-only output", async () => {
  await assert.rejects(generatePatch(project(), () => room()), /trusted native ROM/);
  const generated = await generatePatch(project(), () => room(), () => translation());
  assert.match(generated.files["mnsg_level_patch.c"], /mnsg_level_geometry_before_collision/);
  assert.match(generated.files["mnsg_level_patch.c"], /func_801F95D8_5B54E8/);
  assert.doesNotMatch(generated.files["mnsg_level_patch.c"], /static RoomEdit edits/);
  assert.ok(generated.warnings.some(value => value.includes("entrances")));
  assert.ok(generated.warnings.some(value => value.includes("sources: 2")));
  const largeDelta = project(); largeDelta.roomOverrides["1"].geometry!.translation.y = -32800;
  assert.ok((await generatePatch(largeDelta, () => room(), () => translation())).files["mnsg_level_patch.c"]);
  const missingGuards = translation(); delete (missingGuards as Partial<GeometryTranslation>).guards;
  await assert.rejects(generatePatch(project(), () => room(), () => missingGuards), /dependency guards/);
  const overlappingRoom = room(); overlappingRoom.actors[0].source.romOffset = 0x400;
  await assert.rejects(generatePatch(project(false), () => overlappingRoom, () => translation()), /overlap read-only geometry/);
});
test("geometry allowlist rejects changed widths, pointer injection, conflicts and partial records", () => {
  const badWidth = translation(); badWidth.spans[0].originalHex = "00";
  assert.throws(() => geometryOperation(badWidth, 1), /exactly 6/);
  const badPointer = translation(); badPointer.spans[0].segmentedAddress = 0x81000000;
  assert.throws(() => geometryOperation(badPointer, 1), /segmented address/);
  const badKind = translation(); (badKind.spans[0] as unknown as { kind: string }).kind = "callback";
  assert.throws(() => geometryOperation(badKind, 1), /write kind/);
  const badGuard = translation(); badGuard.guards[0].expectedHex = "00";
  assert.throws(() => geometryOperation(badGuard, 1), /exactly 12/);
  const duplicate = translation(); duplicate.spans.push({ ...duplicate.spans[0] });
  assert.equal(geometryOperation(duplicate, 1).spans.length, 3);
  const consistent = geometryOperation(translation(), 1);
  assert.doesNotThrow(() => validateGeometryWrites([consistent, consistent]));
  const conflicting = geometryOperation(translation(), 1); conflicting.spans[0].replacement[0] = 2;
  assert.throws(() => validateGeometryWrites([consistent, conflicting]), /Conflicting overlapping/);
  const guardOverlap = geometryOperation(translation(), 1);
  guardOverlap.guards[0].address = guardOverlap.spans[0].address;
  assert.throws(() => validateGeometryWrites([guardOverlap]), /read-only dependency guards/);
  const partial = geometryOperation(translation(), 1);
  partial.spans = [{ fileId: 9, address: 0x08000102, romOffset: 0x102, original: [0, 2, 0, 3], replacement: [0, 2, 0, 3] }];
  assert.throws(() => validateGeometryWrites([consistent, partial]), /Partially overlapping/);
  assert.throws(() => validateGeometryWrites([{ ...consistent, spans: Array(GEOMETRY_SPAN_LIMIT + 1).fill(consistent.spans[0]) }]), /Split this project/);
});

const localTemplate = process.env.MNSG_EXPORT_TEST_TEMPLATE;
test("real MIPS compiler/linker/packer accepts combined actors and geometry", { skip: !localTemplate }, async context => {
  const output = await exportNrm(project(false), () => room(), { templatePath: localTemplate! }, () => translation());
  context.diagnostic(output.buildLog);
  assert.ok(output.bytes.length > 100);
  assert.equal(output.fileName, "mnsg_level_geometry_fixture.nrm");
});
test("actual US ROM room 465 geometry-only production export", { skip: !localTemplate || !process.env.MNSG_TEST_ROM }, async context => {
  const database = importRomBytes(await readFile(process.env.MNSG_TEST_ROM!));
  const candidate = createProject("House translation test", database.identity);
  candidate.roomOverrides["465"] = { actors: {}, events: {}, geometry: { translation: { x: 0, y: -16, z: 0 } } };
  const loadRoom = (id: number) => database.loadRoom(id);
  const translate = (id: number, value: { x: number; y: number; z: number }) => database.geometryTranslation(id, value);
  const validated = validateProject(candidate, database.identity, loadRoom, translate);
  const generated = await generatePatch(validated, loadRoom, translate);
  assert.match(generated.files["mnsg_level_patch.c"], /mnsg_level_apply_geometry_edits/);
  assert.doesNotMatch(generated.files["mnsg_level_patch.c"], /static RoomEdit edits/);
  const output = await exportNrm(validated, loadRoom, { templatePath: localTemplate! }, translate);
  assert.ok(output.bytes.length > 100);
  const directory = await mkdtemp(path.join(process.platform === "darwin" ? "/private/tmp" : tmpdir(), "mnsg-house-translation-validation-"));
  const modPath = path.join(directory, output.fileName), projectPath = path.join(directory, "house_translation_test.mnsgproj");
  await writeFile(modPath, output.bytes);
  await writeFile(projectPath, JSON.stringify(validated, null, 2) + "\n");
  await writeFile(path.join(directory, "validation.txt"), output.buildLog + "\n" + output.warnings.join("\n") + "\n");
  context.diagnostic(`Retained for isolated in-game validation:\nNRM: ${modPath}\nProject: ${projectPath}\n${output.buildLog}`);
});
test("generated native geometry helper is atomic, idempotent and remaps on reload", { skip: !localTemplate || !["darwin", "linux"].includes(process.platform) }, async context => {
  const generated = await generatePatch(project(), () => room(), () => translation());
  const directory = await mkdtemp(path.join(tmpdir(), "mnsg-geometry-native-"));
  try {
    await mkdir(path.join(directory, "include"));
    await writeFile(path.join(directory, "include/modding.h"), "#define RECOMP_HOOK(name)\n");
    await writeFile(path.join(directory, "mnsg_level_patch.c"), generated.files["mnsg_level_patch.c"]);
    await writeFile(path.join(directory, "mnsg_level_patch.h"), generated.files["mnsg_level_patch.h"]);
    await writeFile(path.join(directory, "harness.c"), `
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include "mnsg_level_patch.c"
static unsigned char *base9, *base10;
static int handle10 = -1, unavailable_resolves;
static const unsigned char v_old[] = {0,1,0,2,0,3}, v_new[] = {1,2,0,2,0,3};
static const unsigned char p_old[] = {63,128,0,0}, p_new[] = {64,0,0,0};
static const unsigned char b_old[] = {0,16,0,16,0,16,255,240,255,240,255,240};
static const unsigned char b_new[] = {1,17,0,16,0,16,0,241,255,240,255,240};
int func_800141C4_14DC4(unsigned int file) { return file == 9 ? 0x40000001 : handle10; }
int func_80014840_15440(int address, unsigned int file) {
    if (!func_800141C4_14DC4(file) || func_800141C4_14DC4(file) == -1) { unavailable_resolves++; return 0; }
    return (int)(uintptr_t)((file == 9 ? base9 : base10) + (address & 0xffffff));
}
static void reset(void) {
    memcpy(base9+0x100,v_old,6); memcpy(base9+0x200,p_old,4); memcpy(base10+0x300,b_old,12);
    for (unsigned i=0;i<sizeof(geometry_guards)/sizeof(geometry_guards[0]);i++) {
        const GeometrySpan *guard=&geometry_guards[i];
        memcpy((guard->file==9?base9:base10)+(guard->address&0xffffff),geometry_guard_original+guard->offset,guard->length);
    }
    base9[0x106]=0xA5; base10[0x30C]=0x5A;
}
static void old_remaining(void) { assert(!memcmp(base9+0x200,p_old,4)); assert(!memcmp(base10+0x300,b_old,12)); }
static void all_new(void) {
    assert(!memcmp(base9+0x100,v_new,6)); assert(!memcmp(base9+0x200,p_new,4)); assert(!memcmp(base10+0x300,b_new,12));
    assert(base9[0x106]==0xA5 && base10[0x30C]==0x5A);
}
int main(void) {
    void *allocation=mmap((void *)(uintptr_t)0x10000000,0x30000,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANON|MAP_FIXED,-1,0);
    assert(allocation != MAP_FAILED); base9=allocation; base10=base9+0x10000;
    reset(); mnsg_level_geometry_before_collision(); assert(!memcmp(base9+0x100,v_old,6)); old_remaining();
    handle10=0; mnsg_level_geometry_before_render(0,0); assert(!memcmp(base9+0x100,v_old,6)); old_remaining();
    handle10=0x40000002; reset(); base10[0x300]^=0x80; mnsg_level_apply_geometry_edits();
    assert(!memcmp(base9+0x100,v_old,6)); assert(!memcmp(base9+0x200,p_old,4)); assert(base10[0x300]==0x80);
    for (unsigned i=0;i<sizeof(geometry_guards)/sizeof(geometry_guards[0]);i++) {
        const GeometrySpan *guard=&geometry_guards[i]; reset();
        unsigned char *pointer=(guard->file==9?base9:base10)+(guard->address&0xffffff);
        pointer[0]^=1; mnsg_level_apply_geometry_edits(); assert(!memcmp(base9+0x100,v_old,6)); old_remaining();
        assert(pointer[0]==(unsigned char)(geometry_guard_original[guard->offset]^1));
    }
    reset(); base9[0x100]=v_new[0]; mnsg_level_apply_geometry_edits();
    assert(base9[0x100]==v_new[0] && base9[0x101]==v_old[1]); old_remaining();
    reset(); memcpy(base9+0x200,p_new,4); mnsg_level_apply_geometry_edits(); all_new();
    mnsg_level_geometry_before_collision(); mnsg_level_geometry_before_render(0,0); all_new();
    base9=(unsigned char *)allocation+0x20000; reset(); mnsg_level_apply_geometry_edits(); all_new();
    assert(unavailable_resolves==0); assert(!memcmp((unsigned char *)allocation+0x100,v_new,6));
    assert(munmap(allocation,0x30000)==0); puts("PASS missing/null resource, opaque handles, each dependency guard, bad and mixed preimages, whole-operation writes, idempotence, reload, adjacent-byte preservation");
    return 0;
}
`);
    const compiler = process.env.MNSG_EXPORT_HARNESS_CC ?? (process.platform === "darwin" ? "/usr/bin/clang" : "clang");
    const args = ["-std=c11", "-D_DEFAULT_SOURCE", "-Wall", "-Wextra", "-Werror", "-Wno-int-to-pointer-cast", "-Wno-pointer-to-int-cast", "-I", "include", "harness.c", "-o", "harness", ...(process.platform === "darwin" ? ["-arch", "x86_64", "-Wl,-pagezero_size,0x10000"] : [])];
    execFileSync(compiler, args, { cwd: directory });
    const output = execFileSync(path.join(directory, "harness"), [], { cwd: directory, encoding: "utf8" });
    context.diagnostic(`${compiler} ${args.join(" ")}\n${output}`);
    assert.match(output, /PASS missing\/null resource/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
