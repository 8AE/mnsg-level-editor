import test from "node:test";
import assert from "node:assert/strict";
import { compileGeometry, compileVertex, linkGeometry, normalizedUv, compileProximityGrid, type NativeVertexInput } from "../core/authoring/native-compiler";
import { authoringUv, compileAuthoredRoom, resolveAuthoredDoorDestinations } from "../core/export/authoring";
import type { AuthoredRoom, EditorProjectV2 } from "../shared/types";
import type { AuthoringExportContext, NativeAuthoringMaterial } from "../core/authoring/catalog";
import { textureCoordinate } from "../core/rom/textures";
import { authoringDataSource, authoringMapperSource, authoringAddressModeSource, authoringAdmissionSource, authoringGeometryRuntimeSource, authoringSkySource, authoringDoorSource } from "../core/export/authoring-runtime";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
const vertex = (x: number, y = 0, z = 0): NativeVertexInput => ({ position: { x, y, z }, uv: [32, -64], rgba: [255, 128, 4, 255] });
test("authored vertices encode native signed coordinates, flags, fixed-point UV and RGBA", () => {
    const bytes = compileVertex(vertex(-32768, 32767, -1)), v = new DataView(bytes.buffer);
    assert.equal(bytes.length, 16);
    assert.equal(v.getInt16(0), -32768);
    assert.equal(v.getInt16(2), 32767);
    assert.equal(v.getUint16(6), 0);
    assert.equal(v.getInt16(8), 32);
    assert.equal(v.getInt16(10), -64);
    assert.deepEqual([...bytes.subarray(12)], [255, 128, 4, 255]);
    assert.equal(normalizedUv(0.5, 32), 512);
    assert.equal(normalizedUv(-1, 16), -512);
    assert.throws(() => normalizedUv(100, 32), /fixed-point UV/);
    assert.throws(() => compileVertex(vertex(32768)), /XYZ/);
    assert.throws(() => compileVertex(vertex(1.5)), /XYZ/);
});
test("F3DEX triangle batching preserves face ordering and emits explicit pointer relocations", () => {
    const vertices = Array.from({ length: 36 }, (_, index) => vertex(index, index % 3, index % 5)), triangles = Array.from({ length: 12 }, (_, index) => [index * 3, index * 3 + 2, index * 3 + 1] as const);
    const result = compileGeometry({ vertices, triangles });
    assert.equal(result.batchCount, 2);
    assert.equal(result.triangleCount, 12);
    assert.equal(result.relocations.length, 2);
    const linked = linkGeometry(result, 0x08000000), v = new DataView(linked.buffer), decoded: number[][] = [];
    let cache: number[] = [];
    for (let at = 0; at < linked.length; at += 8) {
        const op = v.getUint32(at), arg = v.getUint32(at + 4);
        if (op >>> 24 === 4) {
            const count = (op >>> 10) & 63, base = arg - 0x08000000;
            cache = Array.from({ length: count }, (_, i) => new DataView(result.vertices.buffer).getInt16(base + i * 16));
            assert.equal(op & 1023, count * 16 - 1);
        }
        else if (op >>> 24 === 0xbf)
            decoded.push([cache[(arg >>> 16 & 255) / 2], cache[(arg >>> 8 & 255) / 2], cache[(arg & 255) / 2]]);
    }
    assert.deepEqual(decoded, triangles);
    assert.equal(v.getUint32(linked.length - 8), 0xb8000000);
    assert.equal(new DataView(result.displayList.buffer).getUint32(4), 0, "Unlinked payload must retain relocation placeholders");
});
test("geometry compile/link rejects invalid indices, repeated corners and wrapped allocations", () => {
    assert.throws(() => compileGeometry({ vertices: [vertex(0)], triangles: [[0, 0, 0]] }), /Degenerate/);
    assert.throws(() => compileGeometry({ vertices: [vertex(0), vertex(1), vertex(2)], triangles: [[0, 1, 3]] }), /index/);
    const payload = compileGeometry({ vertices: [vertex(0), vertex(1), vertex(2)], triangles: [[0, 1, 2]] });
    assert.throws(() => linkGeometry(payload, 0x08000001), /unaligned/);
    assert.throws(() => linkGeometry(payload, 0xfffffff0), /wraps/);
    for (const addend of [-16, 0.5, NaN])
        assert.throws(() => linkGeometry({ ...payload, relocations: [{ offset: 4, target: "vertices", addend }] }, 0x08000000), /relocation/);
    for (const offset of [-4, 4.5, NaN])
        assert.throws(() => linkGeometry({ ...payload, relocations: [{ offset, target: "vertices", addend: 0 }] }, 0x08000000), /relocation/);
});
test("empty or deleted geometry produces a safe END-only native list", () => {
    const empty = compileGeometry({ vertices: [], triangles: [] });
    assert.equal(empty.vertices.length, 0);
    assert.equal(empty.relocations.length, 0);
    assert.equal(empty.triangleCount, 0);
    assert.deepEqual([...empty.displayList], [0xb8, 0, 0, 0, 0, 0, 0, 0]);
    const deleted = compileGeometry({ vertices: [vertex(0)], triangles: [] });
    assert.deepEqual(deleted.displayList, empty.displayList);
    assert.equal(deleted.vertexCount, 0);
});
function room(): AuthoredRoom { return { id: 620, name: "Fixture", kind: "new", templateRoomId: 0, collisionMode: "authored", meshes: [{ id: "mesh", materialId: "paint", vertices: [{ position: { x: 0, y: 0, z: 0 }, uv: [0.5, 0.25], color: [255, 4, 5, 255] }, { position: { x: 100, y: 0, z: 0 }, uv: [0, 1], color: [255, 4, 5, 255] }, { position: { x: 0, y: 0, z: 100 }, uv: [1, 0], color: [255, 4, 5, 255] }], indices: [0, 2, 1] }], materials: [{ id: "paint", sourceMaterialId: "rom:paint" }], collision: [], actors: [{ id: "actor", prototypeId: "rom:actor", parameters: [4, 5, 6], position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } }], doors: [], entrances: [] }; }
function context(): AuthoringExportContext {
    const material = { id: "rom:paint", commands: [[0xfd100000, 0x08000100], [0xfc327e64, 0xfffffdfe]], resourceFileIds: [138], relocations: [{ offset: 4, fileId: 138, segmentedAddress: 0x08000100 }], textureWidth: 32, textureHeight: 64, uv: { scaleS: 0.5, scaleT: 1, shiftS: 0, shiftT: 2, originS: 0, originT: 3, centerOffset: 0.5 }, state: {}, material: {} } as NativeAuthoringMaterial;
    return { doorAppearance: () => { throw Error("Unknown static appearance"); }, resourceFileBytes: fileIds => ({ totalBytes: fileIds.length * 256, files: fileIds.map(fileId => ({ fileId, byteLength: 256 })) }), collision: () => ({ planes: new Uint8Array(), tree: new Uint8Array(), resourceFileIds: [], planeCount: 0, cellCount: 0 }), material: () => material, prototype: (_id, edits) => ({ actorId: 0x400, parameters: edits!.parameters!, unknownHalfword: 17, placementWord: 0, dependencyClosure: "initializer-trace", dependencyProvenance: ["fixture"], resourceFileIds: [31, 30], warnings: [] }), donor: () => ({ roomId: 0, actorFileId: 10, metadataOffset: 20, graphicsOffset: 40, environmentDefinitions: [], resourceFileIds: [10] }), skybox: () => ({ nativeIndex: 1, fileId: 152 }), entrance: () => { throw Error("Unknown native entrance"); } };
}
test("authored geometry combines trusted materials into one native root with separate pointer relocations", () => {
    const result = compileAuthoredRoom(room(), context());
    assert.equal(result.geometry.triangleCount, 1);
    assert.equal(result.geometry.relocations.length, 1);
    assert.deepEqual(result.materialRelocations, [{ offset: 4, fileId: 138, segmentedAddress: 0x08000100 }]);
    assert.deepEqual(result.resources, [10, 30, 31, 127, 138]);
    assert.equal(result.actors[0].prototype.actorId, 0x400, "No original-room roster restriction");
    assert.deepEqual(result.actors[0].prototype.parameters, [4, 5, 6]);
    const commands = new DataView(result.geometry.displayList.buffer);
    assert.equal(commands.getUint32(16), 0xb6000000);
    assert.equal(commands.getUint32(20), 0xe0000, "Authored RGBA/UV must disable native lighting/texgen");
    const uv = new DataView(result.geometry.vertices.buffer);
    assert.equal(uv.getInt16(8), 992);
    assert.equal(uv.getInt16(10), 2368);
});
test("authored UV transform exactly inverts native shift, scale, tile origin and linear sample center", () => {
    for (const shift of [0, 2, 11, 15]) {
        const encoded = authoringUv(0.25, 32, 0.5, shift, 3, 0.5), decoded = textureCoordinate(encoded / 32 * 0.5, shift, 3 * 4, 32, "linear");
        assert.ok(Math.abs(decoded - 0.25) <= 1 / 32, `Native shift${shift} roundtrip`);
    }
    assert.throws(() => authoringUv(1024, 4096, 0.5, 0, 0, 0.5), /native material transform/);
});
test("authored compilation rejects geometry commands embedded in material sources and resolves empty rooms safely", () => {
    const bad = context(), material = bad.material("rom:paint");
    material.commands[0] = [0x06000000, 0x08000100];
    assert.throws(() => compileAuthoredRoom(room(), bad), /geometry, control flow/);
    const blank = { ...room(), meshes: [], materials: [], actors: [] };
    const result = compileAuthoredRoom(blank, context());
    assert.equal(result.geometry.displayList.length, 8);
    assert.equal(result.collision.tree.length, 0);
    assert.equal(result.actors.length, 0);
});
const hostClang = process.env.MNSG_HOST_CLANG ?? "clang";
let hostClangAvailable = false;
try {
    execFileSync(hostClang, ["--version"], { stdio: "ignore" });
    hostClangAvailable = true;
}
catch { /* Optional host compiler. */ }
test("generated native mapper C preserves every vanilla stage and actual custom room identity", { skip: !hostClangAvailable ? "Host Clang is unavailable; configured MIPS export tests remain opt-in." : false }, () => {
    const directory = mkdtempSync(path.join(tmpdir(), "mnsg-authored-mapper-"));
    try {
        const source = `#include <assert.h>\n#include <stdint.h>\ntypedef unsigned short u16;\n#define RECOMP_PATCH\ntypedef struct {u16 room,donor;} AuthoredRoomRegistry;\nstatic AuthoredRoomRegistry authored_rooms[]={{620,465},{621,128}};\nstatic void authored_install(AuthoredRoomRegistry *room){(void)room;}\nstatic AuthoredRoomRegistry *authored_find(u16 room){for(int i=0;i<2;i++)if(authored_rooms[i].room==room)return &authored_rooms[i];return 0;}\nstatic unsigned char storage[0x40000];\nunsigned char *D_8015C5C8_15D1C8=storage;\nu16 D_8005BA10_5C610[]={0,300,350,400,540,544,549,561,588,607,613,618,619,620};\n${authoringMapperSource()}\nint main(void){for(u16 room=0;room<800;room++){u16 mapped=room==620?465:room==621?128:room;unsigned int stage=0,index=0;for(unsigned int i=1;i<=13;i++)if(mapped<D_8005BA10_5C610[i]){stage=i-1;index=mapped-D_8005BA10_5C610[i-1];break;}*(u16*)(storage+0x3adf2)=room;func_8000B3E4_BFE4();assert(storage[0x3ade4]==stage);assert(*(u16*)(storage+0x3adf4)==index);func_801F8F0C_5B4E1C();if(stage==0&&mapped>89){if(mapped>127){stage=5;index=(u16)(index-128);}else{stage=4;index=(u16)(index-90);}}assert(storage[0x3adf6]==stage);assert(*(u16*)(storage+0x3adf8)==index);assert(*(u16*)(storage+0x3adf2)==room);}return 0;}\n`;
        const file = path.join(directory, "mapper.c"), binary = path.join(directory, "mapper");
        writeFileSync(file, source);
        execFileSync(hostClang, ["-std=c99", "-Wall", "-Wextra", "-Werror", file, "-o", binary]);
        execFileSync(binary, []);
    }
    finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
test("authored C payload compiles for MIPS including direct-pointer relocation and RT64 outer-draw mode", { skip: !process.env.MNSG_EXPORT_TEST_TEMPLATE }, () => {
    const directory = mkdtempSync(path.join(tmpdir(), "mnsg-authored-native-"));
    try {
        const authored = room();
        authored.actors[0].spawnPolicy = "proximity";
        const compiled = compileAuthoredRoom(authored, context());
        const header = readFileSync(path.join(process.env.MNSG_EXPORT_TEST_TEMPLATE!, "include/platform/modding.h"), "utf8");
        writeFileSync(path.join(directory, "modding.h"), header);
        writeFileSync(path.join(directory, "payload.c"), `#include "modding.h"\ntypedef unsigned int u32;typedef unsigned short u16;typedef signed short s16;\n${authoringDataSource([compiled])}\n${authoringMapperSource()}\n${authoringAdmissionSource([compiled])}\n${authoringGeometryRuntimeSource()}\n${authoringSkySource()}\n${authoringDoorSource()}\n${authoringAddressModeSource()}\n`);
        execFileSync("/opt/homebrew/opt/llvm/bin/clang", ["-target", "mips", "-mips2", "-mabi=32", "-O2", "-G0", "-mno-abicalls", "-mno-odd-spreg", "-fno-builtin", "-Wall", "-Wextra", "-Werror", "-nostdinc", "-I", directory, "-c", path.join(directory, "payload.c"), "-o", path.join(directory, "payload.o")]);
    }
    finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
test("owned proximity grid uses native f32 membership and keeps moved actors in rebuilt cells", () => {
    const positions = [{ index: 0, position: { x: -32768, y: -32768, z: -32768 } }, { index: 1, position: { x: 32767, y: 32767, z: 32767 } }, { index: 2, position: { x: 0, y: 0, z: 0 } }];
    const grid = compileProximityGrid(positions), view = new DataView(grid.configuration.buffer);
    assert.equal(view.getUint16(0), 512);
    assert.equal(view.getFloat32(8), -0.5);
    assert.equal(view.getUint16(20), 132);
    assert.equal(grid.cellCount, 132 ** 3);
    for (const placement of positions) {
        const coord = ["x", "y", "z"].map(axis => Math.trunc(Math.fround(Math.fround(Math.fround(placement.position[axis as "x"] - grid.origin[axis as "x"]) / 512) + Math.fround(132 / 2))));
        const index = coord[0] * 132 * 132 + coord[1] * 132 + coord[2];
        assert.ok(grid.cells.get(index)?.includes(placement.index));
    }
    const before = compileProximityGrid([{ index: 0, position: { x: 0, y: 0, z: 0 } }, { index: 1, position: { x: 4000, y: 0, z: 0 } }]);
    const after = compileProximityGrid([{ index: 0, position: { x: 3500, y: 0, z: 0 } }, { index: 1, position: { x: 4000, y: 0, z: 0 } }]);
    assert.equal(before.cells.size, 2);
    assert.equal(after.cells.size, 1);
    assert.equal([...after.cells.values()].flat().length, 2);
    assert.throws(() => compileProximityGrid([{ index: 0, position: { x: 0, y: 0, z: 0 } }, { index: 0, position: { x: 0, y: 0, z: 0 } }]), /duplicate/);
    assert.throws(() => compileProximityGrid(positions, 2), /pointer allocation/);
});
test("native admission preflights resources, preserves new room identity and reasserts failure suspension after setup", { skip: !hostClangAvailable ? "Host Clang is unavailable." : false }, () => {
    const directory = mkdtempSync(path.join(tmpdir(), "mnsg-authored-admission-"));
    try {
        const authored = room();
        authored.entrances = [{ id: "origin", name: "Origin", position: { x: 0, y: 0, z: 0 }, baseYaw: 256, entryParameter: 19 }];
        const compiled = compileAuthoredRoom(authored, context());
        compiled.actors[0].prototype.actorId=0x8e;
        compiled.actors[0].position={x:100,y:-200,z:0};
        compiled.actors[0].rotation={x:1,y:2,z:3};
        compiled.actors[0].prototype.parameters=[0x00010002,0x00030004,0];
        const source = `
#include <assert.h>
#include <stdint.h>
#include <stdarg.h>
typedef uint32_t u32;typedef uint16_t u16;typedef int16_t s16;
#define RECOMP_PATCH
#define RECOMP_HOOK(name)
#define RECOMP_HOOK_RETURN(name)
#define RECOMP_IMPORT(module, declaration) extern declaration
typedef struct {u32 w0,w1;} AuthoredCommand;
typedef struct {u32 command,file,pointer;} AuthoredMaterialPointer;
typedef struct {AuthoredCommand *model;AuthoredMaterialPointer *pointers;u32 pointer_count;} AuthoredDoorRegistry;
typedef struct {s16 transform[6];u32 definition,placement_word;} AuthoredInstance;
typedef struct {AuthoredInstance *resident;u32 names,normal,partition,partition_config;u16 source_wave,reserved;void(*load)(void);} AuthoredMetadata;
typedef struct {u16 room,donor;AuthoredCommand *model;AuthoredMaterialPointer *pointers;u32 pointer_count;unsigned char *planes,*tree;AuthoredInstance *instances;u16 *resources;u32 *resource_extents;AuthoredMetadata *metadata;u32 ready,sky_started;AuthoredDoorRegistry *doors;u32 door_count,doors_started;u32 sky_texture,sky_palette;} AuthoredRoomRegistry;
static unsigned char storage[0x40000];
unsigned char *D_8015C5C8_15D1C8=storage;
void *D_80231300_5EC7D0[800];
s16 D_8006B780_6C380[800*5];
unsigned char D_8015C80C_15D40C[16],D_8015C54D_15D14D[4],D_800C7B00[32];
s16 D_8015C550;
u32 D_80168F60_169B60,D_80168F64_169B64;
static AuthoredInstance authored_empty_instances[1],instances[2];
static AuthoredCommand model[]={{0xfd100000,0x08000100}};
static AuthoredMaterialPointer pointers[]={{0,138,0x08000100}};
static u16 resources[]={138,152,0};
static u32 resource_extents[]={256,256,0};
static AuthoredMetadata metadata;
static AuthoredRoomRegistry authored_rooms[]={{620,0,model,pointers,1,0,0,instances,resources,resource_extents,&metadata,0,0,0,0,0,0,0}};
static AuthoredRoomRegistry *authored_find(u16 id){return id==620?authored_rooms:0;}
unsigned char D_80167FC0_168BC0[49*8];
u32 D_80054ACC_556CC[512];
u32 func_80001DF4_29F4(u32 file){return file==152?0x40000000u:0;}
static unsigned int unavailable,loads,environment_resets;
u32 func_80013B14_14714(s16 file){++loads;return (unsigned int)(u16)file==unavailable?0:64;}
signed int func_800141C4_14DC4(unsigned int file){return file==unavailable?-1:(signed int)0x80400000;}
signed int func_80014840_15440(signed int pointer,unsigned int file){(void)file;return (signed int)(0x80400000u+((u32)pointer&0xffffffu));}
void func_801F97D4_5B56E4(void){++environment_resets;}
static unsigned char light[3];
void func_801FA3FC_5B630C(unsigned char r,unsigned char g,unsigned char b){light[0]=r;light[1]=g;light[2]=b;}
int recomp_printf(const char *format,...){(void)format;return 0;}
${authoringAdmissionSource([compiled])}
int main(void){
    *(u16*)(storage+0x3adf2)=620;
    mnsg_authored_install_before_metadata_load();
    assert(D_80231300_5EC7D0[620]==&metadata);
    assert(func_8020D670_5C8B40()==1);
    func_800214E4_220E4();
    s16 *saved=(s16*)(D_8015C80C_15D40C+4);
    assert(saved[0]==19&&saved[1]==0&&saved[2]==0&&saved[3]==0&&saved[4]==256);
    for(unsigned int j=0;j<256;j++){D_80054ACC_556CC[j*2]=0x08000000;D_80054ACC_556CC[j*2+1]=0x08000100;}
    *(u32 *)(D_80167FC0_168BC0+4)=0x80321500;
    assert(authored_resource_append_fits(138,256));
    assert(!authored_resource_append_fits(138,255));
    *(u32 *)(D_80167FC0_168BC0+4)=0x80593fc0;
    assert(!authored_resource_append_fits(138,65));
    assert(!authored_resource_append_fits(152,1));
    *(u32 *)(D_80167FC0_168BC0+4)=0x803214ff;
    assert(!authored_resource_append_fits(138,256));
    for(unsigned int j=0;j<48;j++)*(u16 *)(D_80167FC0_168BC0+j*8)=j+1;
    assert(!authored_resource_append_fits(138,256));
    assert(authored_resource_append_fits(30,256));
    for(unsigned int j=0;j<48;j++)*(u16 *)(D_80167FC0_168BC0+j*8)=0;
    *(u32 *)(D_80167FC0_168BC0+4)=0x80321500;
    authored_stage(authored_rooms);
    assert(authored_rooms[0].ready==1&&loads==2&&environment_resets==1);
    assert(*(s16*)(D_8015C54D_15D14D+1)==100&&D_8015C550==-200);
    assert(*(s16*)(D_800C7B00)==1&&*(s16*)(D_800C7B00+4)==2&&*(s16*)(D_800C7B00+8)==3&&*(s16*)(D_800C7B00+12)==4);
    assert(light[0]==1&&light[1]==2&&light[2]==3);
    assert(metadata.resident==instances&&model[0].w1==0x80400100);
    assert(*(u16*)(storage+0x3adf2)==620);
    unavailable=152;model[0].w1=0x11111111;
    authored_stage(authored_rooms);
    assert(!authored_rooms[0].ready&&authored_failed_room==620&&authored_failed_file==152);
    assert(model[0].w1==0x11111111&&metadata.resident==authored_empty_instances);
    assert(!metadata.normal&&!metadata.partition&&!metadata.partition_config);
    assert(D_80168F60_169B60==0&&D_80168F64_169B64==0);
    assert(*(u16*)(storage+0x3ae24)==7);
    *(u16*)(storage+0x3ae24)=14;mnsg_authored_guard_cold_setup();assert(*(u16*)(storage+0x3ae24)==7);
    *(u16*)(storage+0x3ae24)=14;mnsg_authored_guard_transition_setup();assert(*(u16*)(storage+0x3ae24)==7);
    *(u16*)(storage+0x3ae24)=0;mnsg_authored_guard_scheduler();assert(*(u16*)(storage+0x3ae24)==7);
    unavailable=0;authored_stage(authored_rooms);assert(!authored_rooms[0].ready);
    return 0;
}
`;
        const file = path.join(directory, "admission.c"), binary = path.join(directory, process.platform === "win32" ? "admission.exe" : "admission");
        writeFileSync(file, source);
        execFileSync(hostClang, ["-std=c99", "-Wall", "-Wextra", "-Werror", "-Wno-pointer-to-int-cast", file, "-o", binary]);
        execFileSync(binary, []);
    }
    finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
test("material lowering strips segment updates and relocates subsequent pointer commands exactly", () => {
    const trusted = context(), material = trusted.material("rom:paint");
    material.commands = [[0xbc000006, 0x08000000], [0xfd100000, 0x08000100], [0x03860010, 0x09000200], [0xfc327e64, 0xfffffdfe]];
    material.resourceFileIds = [138, 139];
    material.relocations = [{ offset: 12, fileId: 138, segmentedAddress: 0x08000100 }, { offset: 20, fileId: 139, segmentedAddress: 0x09000200 }];
    const result = compileAuthoredRoom(room(), trusted), view = new DataView(result.geometry.displayList.buffer);
    assert.equal(view.getUint32(0), 0xfd100000);
    assert.equal(view.getUint32(8), 0x03860010);
    assert.deepEqual(result.materialRelocations, [{ offset: 4, fileId: 138, segmentedAddress: 0x08000100 }, { offset: 12, fileId: 139, segmentedAddress: 0x09000200 }]);
    material.relocations.pop();
    assert.throws(() => compileAuthoredRoom(room(), trusted), /unrelocated positive pointer/);
});
test("generated doors lower checker texture, retain optional static native surface material and resolve named mutual entrances", () => {
    const a = room(), b = { ...room(), id: 621, name: "Second" };
    a.entrances = [{ id: "in", name: "First arrival", position: { x: 10, y: 20, z: 30 }, baseYaw: 256, entryParameter: 19 }];
    b.entrances = [{ id: "in", name: "Second arrival", position: { x: 40, y: 50, z: 60 }, baseYaw: -128, entryParameter: 21 }];
    const door = { id: "door", position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 256 }, dimensions: { x: 40, y: 80, z: 10 }, activation: "touch" as const, destination: { roomId: 621, entranceId: "in" } };
    a.doors = [door];
    b.doors = [{ ...door, destination: { roomId: 620, entranceId: "in" } }];
    const trusted = context(), compiled = [compileAuthoredRoom(a, trusted), compileAuthoredRoom(b, trusted)];
    resolveAuthoredDoorDestinations(compiled, trusted);
    assert.equal(compiled[0].doors[0].geometry.triangleCount, 12);
    assert.equal(compiled[0].doors[0].texture?.length, 512);
    assert.deepEqual(compiled[0].doors[0].arrival, { roomId: 621, position: { x: 40, y: 50, z: 60 }, baseYaw: -128, entryParameter: 21 });
    const source = authoringDataSource(compiled);
    assert.match(source, /authored_0_door_0_texture/);
    assert.match(source, /authored_1_door_0_model/);
    assert.match(source, /-4\.000000000e\+1f/, "Rotated bottom-origin box center must be X=-40");
    const native = context();
    native.doorGeometry = () => ({ meshes: [{ vertices: a.meshes[0].vertices.map(vertex => ({ position: vertex.position, uv: vertex.uv, colorRGBAu8: vertex.color })), indices: a.meshes[0].indices, material: native.material("rom:paint") }], resourceFileIds: [138], warnings: ["native initial-pose fixture"] });
    a.doors[0] = { ...door, appearancePrototypeId: "rom:appearance" };
    const appearance = compileAuthoredRoom(a, native).doors[0];
    assert.equal(appearance.texture, undefined);
    assert.equal(appearance.geometry.triangleCount, 1);
    assert.deepEqual(appearance.scale, { x: 1, y: 1, z: 1 });
    assert.equal(appearance.materialRelocations.length, 1);
    b.entrances = [];
    assert.throws(() => resolveAuthoredDoorDestinations([compiled[0], compileAuthoredRoom(b, trusted)], trusted), /no named destination/);
});
test("custom native door C checks full rotated bottom-origin volumes, arrival arming, selected controller and ordinary queue gates", { skip: !hostClangAvailable ? "Host Clang is unavailable." : false }, () => {
    const directory = mkdtempSync(path.join(tmpdir(), "mnsg-authored-door-"));
    try {
        const types = authoringDataSource([compileAuthoredRoom(room(), context())]).split("static void authored_stage")[0];
        const source = `
#include <assert.h>
#include <stdint.h>
typedef uint32_t u32;typedef uint16_t u16;typedef int16_t s16;
${types}
static unsigned char system_memory[0xd0000],control[0xf0],player_task[0xf0],player_object[0xa0];
unsigned char *D_8015C5C8_15D1C8=system_memory,*D_801FC600_5B8510=control,*D_801FC604_5B8514=player_task,*D_801FC60C_5B851C=player_object;
unsigned char D_800C7DB0_C89B0[4*0x18],D_8015C54D_15D14D[4];
static unsigned int authored_failed,queued,failed_allocations;
static int authored_resources_ready(AuthoredRoomRegistry *room){return room->ready;}
static void authored_fail(AuthoredRoomRegistry *room,unsigned int file){(void)room;(void)file;++failed_allocations;}
void *func_800358E8_364E8(void *parent,void(*callback)(void*,void*),u32 model,u32 material,float x,float y,float z,s16 rx,s16 ry,s16 rz,float sx,float sy,float sz,s16 gf,s16 mf){(void)parent;(void)callback;(void)model;(void)material;(void)x;(void)y;(void)z;(void)rx;(void)ry;(void)rz;(void)sx;(void)sy;(void)sz;(void)gf;(void)mf;return 0;}
void func_8000607C_6C7C(u16 room,s16 x,s16 y,s16 z,s16 base,s16 entry,s16 f90,int f91){assert(room==621&&x==40&&y==50&&z==60&&base==-128&&entry==21&&f90==0&&f91==0);assert(*(u32*)(system_memory+0x3ae2c)==0&&*(u16*)(system_memory+0x3ae30)==0);system_memory[0x3ae29]=1;++queued;}
${authoringDoorSource()}
int main(void){
    AuthoredDoorRegistry door={0};door.room=620;door.destination=621;door.half_size[0]=20;door.half_size[1]=40;door.half_size[2]=5;
    door.volume_center[0]=10;door.volume_center[1]=20;door.volume_center[2]=70;
    float inverse_x[9]={1,0,0,0,0,1,0,-1,0};for(int i=0;i<9;i++)door.inverse_rotation[i]=inverse_x[i];
    const float inside_x[3]={10,20,60},outside_x[3]={10,30,60};assert(authored_door_inside(&door,inside_x));assert(!authored_door_inside(&door,outside_x));
    door.volume_center[0]=-30;door.volume_center[1]=20;door.volume_center[2]=30;
    float inverse_z[9]={0,1,0,-1,0,0,0,0,1};for(int i=0;i<9;i++)door.inverse_rotation[i]=inverse_z[i];
    const float inside_z[3]={-20,20,30},outside_z[3]={-20,50,30};assert(authored_door_inside(&door,inside_z));assert(!authored_door_inside(&door,outside_z));
    u32 state[3]={0};door.touch=1;
    assert(!authored_door_activation(&door,state,1,0,1));assert(!authored_door_activation(&door,state,1,0,1));
    assert(!authored_door_activation(&door,state,0,0,1));assert(authored_door_activation(&door,state,1,0,1));assert(!authored_door_activation(&door,state,1,0,1));
    assert(!authored_door_activation(&door,state,0,0,1));assert(!authored_door_activation(&door,state,1,0,0));assert(!authored_door_activation(&door,state,1,0,1));
    door.touch=0;assert(!authored_door_activation(&door,state,1,0,1));assert(authored_door_activation(&door,state,1,1,1));
    player_task[0x90]=2;*(u16*)(D_800C7DB0_C89B0+2*0x18+2)=0x8000;assert(!authored_door_pressed_a());
    *(u16*)(D_800C7DB0_C89B0+4)=0x8000;assert(!authored_door_pressed_a());
    *(u16*)(D_800C7DB0_C89B0+2*0x18+4)=0x8000;assert(authored_door_pressed_a());player_task[0x90]=4;assert(!authored_door_pressed_a());
    system_memory[0x3add4]=13;system_memory[0x3adde]=1;*(u16*)(system_memory+0x3adf2)=620;assert(authored_door_live(&door));
    *(u16*)(system_memory+0x3ae26)=1;assert(!authored_door_live(&door));*(u16*)(system_memory+0x3ae26)=0;
    system_memory[0x3ae23]=1;assert(!authored_door_live(&door));system_memory[0x3ae23]=0;
    D_8015C54D_15D14D[0]=1;assert(!authored_door_live(&door));D_8015C54D_15D14D[0]=0;
    s16 arrival[5]={40,50,60,-128,21};for(int i=0;i<5;i++)door.arrival[i]=arrival[i];
    *(u32*)(system_memory+0x3ae2c)=0x12345678;*(u16*)(system_memory+0x3ae30)=256;authored_door_queue(&door);assert(queued==1&&!authored_door_live(&door));
    AuthoredRoomRegistry room={0};room.ready=1;room.doors=&door;room.door_count=1;authored_spawn_doors(0,&room);assert(failed_allocations==1&&!room.doors_started);
    return 0;
}
`;
        const file = path.join(directory, "door.c"), binary = path.join(directory, process.platform === "win32" ? "door.exe" : "door");
        writeFileSync(file, source);
        execFileSync(hostClang, ["-std=c99", "-Wall", "-Wextra", "-Werror", "-Wno-pointer-to-int-cast", file, "-o", binary]);
        execFileSync(binary, []);
    }
    finally {
        rmSync(directory, { recursive: true, force: true });
    }
});


test("production C/H and NRM include two authored rooms, rebuilt proximity grid and mutual generated doors", {skip: !process.env.MNSG_EXPORT_TEST_TEMPLATE}, async t => {
    const {generatePatch,exportNrm}=await import("../core/export");
    const a=room(), b={...room(),id:621,actors:[]};
    a.actors[0].spawnPolicy="proximity";
    a.entrances=[{id:"arrival",name:"Arrival",position:{x:10,y:20,z:30},baseYaw:256,entryParameter:16}];
    b.entrances=[{id:"arrival",name:"Arrival",position:{x:-10,y:40,z:-30},baseYaw:512,entryParameter:19}];
    a.doors=[{id:"door-a",position:{x:0,y:0,z:0},rotation:{x:128,y:256,z:64},dimensions:{x:100,y:200,z:50},activation:"touch",destination:{roomId:621,entranceId:"arrival"}}];
    b.doors=[{...a.doors[0],id:"door-b",activation:"interact",destination:{roomId:620,entranceId:"arrival"}}];
    const project:EditorProjectV2={format:"mnsg-level-project",version:2,id:"authored-fixture",name:"Authored fixture",createdAt:"2026-10-04T00:00:00Z",updatedAt:"2026-10-04T00:00:00Z",rom:{sha256:"a".repeat(64),normalizedSha256:"b".repeat(64),title:"Fixture",gameCode:"US",region:"US",byteLength:0x2000000,decompressed:true},roomOverrides:{},authoredRooms:{620:a,621:b}};
    const generated=await generatePatch(project,()=>{throw Error("No sparse room read");},undefined,()=>context());
    const inventory=JSON.parse(generated.files["authoring-inventory.json"]);
    assert.deepEqual(inventory.rooms.map((entry:{room:AuthoredRoom})=>entry.room),[a,b]);
    assert.match(generated.files["mnsg_level_patch.c"],/authored_0_reset_grid/);
    assert.match(generated.files["mnsg_level_patch.c"],/0x80594000u/);
    assert.match(generated.files["mnsg_level_patch.c"],/queued_script_file/);
    const output=await exportNrm(project,()=>{throw Error("No sparse room read");},{templatePath:process.env.MNSG_EXPORT_TEST_TEMPLATE!},undefined,()=>context());
    assert.ok(output.bytes.length>100);
    t.diagnostic(output.buildLog);
});

test("extended addressing recognizes only owned roots and sky resources and restores nested draw state", {skip: !hostClangAvailable}, () => {
    const directory=mkdtempSync(path.join(tmpdir(),"mnsg-authored-address-"));
    try {
        const source=`
#include <assert.h>
#include <stdint.h>
typedef uint32_t u32;typedef uint16_t u16;
#define RECOMP_HOOK(name)
#define RECOMP_HOOK_RETURN(name)
typedef struct{u32 w0,w1;}AuthoredCommand;
typedef struct{AuthoredCommand *model;}AuthoredDoorRegistry;
typedef struct{u16 room,skybox;u32 ready,sky_texture,sky_palette;AuthoredCommand *model;AuthoredDoorRegistry *doors;u32 door_count;}AuthoredRoomRegistry;
static AuthoredDoorRegistry doors[]={{(AuthoredCommand *)(uintptr_t)0x81002000u}};
static AuthoredRoomRegistry authored_rooms[]={{620,1,1,0x80350000u,0x80360000u,(AuthoredCommand *)(uintptr_t)0x81001000u,doors,1}};
#define AUTHORED_ROOM_COUNT 1
static unsigned char storage[0x40000],object[0x80];
unsigned char *D_8015C5C8_15D1C8=storage;
static AuthoredRoomRegistry *authored_find(u16 room){return room==620?authored_rooms:0;}
static u32 output[256];u32 *D_8015C5CC_15D1CC=output;
${authoringAddressModeSource()}
int main(void){
 *(u16 *)(storage+0x3adf2)=620;
 *(u32 *)(object+0x2c)=0xc1002000u;
 mnsg_authored_before_draw(object);assert(output[0]==0x6400002cu&&output[1]==1);assert(authored_extended_enabled);
 mnsg_authored_before_draw(0);mnsg_authored_after_draw();assert(authored_extended_enabled);
 mnsg_authored_after_draw();assert(output[2]==0x6400002cu&&output[3]==0&&!authored_extended_enabled);
 u32 *prior=D_8015C5CC_15D1CC;
 *(u32 *)(object+0x38)=0x80350001u;*(u32 *)(object+0x3c)=0x80360000u;
 mnsg_authored_before_background(object);mnsg_authored_after_background();assert(D_8015C5CC_15D1CC==prior);
 *(u32 *)(object+0x38)=0x80350000u;
 mnsg_authored_before_background(object);assert(authored_extended_enabled);mnsg_authored_after_background();assert(!authored_extended_enabled);
 authored_rooms[0].ready=0;prior=D_8015C5CC_15D1CC;mnsg_authored_before_background(object);mnsg_authored_after_background();assert(D_8015C5CC_15D1CC==prior);
 return 0;
}`;
        const file=path.join(directory,"address.c"),binary=path.join(directory,"address");
        writeFileSync(file,source);execFileSync(hostClang,["-std=c99","-Wall","-Wextra","-Werror","-Wno-pointer-to-int-cast",file,"-o",binary]);execFileSync(binary,[]);
    }finally{rmSync(directory,{recursive:true,force:true});}
});


test("effective startup environment follows edited resident08E order and ignores deleted or proximity controllers",()=>{
 const trusted=context(), original=trusted.prototype;
 trusted.prototype=(id,edits,roomContext)=>({...original(id,edits,roomContext),actorId:0x8e});
 const authored=room();
 authored.actors=[{...authored.actors[0],id:"first",position:{x:100,y:-200,z:0},rotation:{x:10,y:20,z:30},parameters:[0x00010002,0x00030004,0],spawnPolicy:"resident"},{...authored.actors[0],id:"last",position:{x:300,y:-400,z:0},rotation:{x:40,y:50,z:60},parameters:[0x00050006,0x00070008,0],spawnPolicy:"resident"}];
 let source=authoringAdmissionSource([compileAuthoredRoom(authored,trusted)]);
 assert.ok(source.indexOf("D_8015C550 = -200;")<source.indexOf("D_8015C550 = -400;"));
 assert.match(source,/func_801FA3FC_5B630C\(40, 50, 60\)/);
 authored.actors[1].spawnPolicy="proximity";
 source=authoringAdmissionSource([compileAuthoredRoom(authored,trusted)]);
 assert.match(source,/D_8015C550 = -200;/);assert.doesNotMatch(source,/D_8015C550 = -400;/);
 authored.actors=[];
 source=authoringAdmissionSource([compileAuthoredRoom(authored,trusted)]);
 assert.match(source,/D_8015C550 = -32768;/);assert.doesNotMatch(source,/D_8015C550 = -200;/);
});

test("native resource and resident object limits reject guaranteed overflow while proximity lists remain bounded declarations",()=>{
 const authored=room();
 authored.actors=Array.from({length:193},(_,i)=>({...authored.actors[0],id:`actor:${i}`,spawnPolicy:"resident" as const}));
 assert.throws(()=>compileAuthoredRoom(authored,context()),/kind-2/);
 authored.actors.forEach(actor=>actor.spawnPolicy="proximity");
 assert.equal(compileAuthoredRoom(authored,context()).actors.length,193);
 const heavy=context();heavy.resourceFileBytes=ids=>({totalBytes:ids.length*600000,files:ids.map(fileId=>({fileId,byteLength:600000}))});
 assert.throws(()=>compileAuthoredRoom(room(),heavy),/conservative world bank/);
 const large=context();large.donor=()=>({...context().donor(0),resourceFileIds:Array.from({length:49},(_,i)=>100+i)});
 assert.throws(()=>compileAuthoredRoom(room(),large),/48-ID/);
 const untextured=context(),material=untextured.material("rom:paint");material.uv.scaleS=material.uv.scaleT=0;material.material.textureId=undefined;
 assert.ok(compileAuthoredRoom(room(),untextured).warnings.some(w=>w.includes("unit-scale convention")));
});


test("aggregate permanent proximity BSS is admitted before C or NRM emission",async()=>{
 const {generatePatch}=await import("../core/export");
 const rooms:Record<string,AuthoredRoom>={};
 for(let id=620;id<628;id++){
  const candidate=room();candidate.id=id;candidate.meshes=[];candidate.materials=[];
  candidate.actors=[-32768,32767].map((coordinate,index)=>({...candidate.actors[0],id:`actor:${index}`,spawnPolicy:"proximity" as const,position:{x:coordinate,y:coordinate,z:coordinate}}));
  rooms[id]=candidate;
 }
 const project:EditorProjectV2={format:"mnsg-level-project",version:2,id:"bss-fixture",name:"BSS fixture",createdAt:"2026-10-04T00:00:00Z",updatedAt:"2026-10-04T00:00:00Z",rom:{sha256:"a".repeat(64),normalizedSha256:"b".repeat(64),title:"Fixture",gameCode:"US",region:"US",byteLength:0x2000000,decompressed:true},roomOverrides:{},authoredRooms:rooms};
 await assert.rejects(generatePatch(project,()=>{throw Error("No sparse read");},undefined,()=>context()),/aggregate 48 MiB native data allocation budget/);
});
