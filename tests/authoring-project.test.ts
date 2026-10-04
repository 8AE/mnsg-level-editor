import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ActorPrototypeEdits, AuthoredRoom, AuthoringCatalog, EditorProjectV2, GeometryMesh, LegacyEditorProject, RomIdentity, RoomData, Vec3 } from "../shared/types";
import { createProject, validateProject } from "../core/project";
import { validatePrototypeEdits, type AuthoringActorContext, type AuthoringLookup } from "../core/authoring/project";
import { assertProjectBytes, MAX_PROJECT_BYTES, AUTHORING_LIMITS } from "../core/authoring/limits";
import { composeProjectActorVisuals, composeProjectRoom, listProjectRooms } from "../core/authoring/scene";
import { atomicWrite, readJson } from "../electron/storage";
import { actorEvent } from "../core/rom/events";

const zero = (): Vec3 => ({ x: 0, y: 0, z: 0 });
const rom: RomIdentity = { sha256: "a".repeat(64), normalizedSha256: "b".repeat(64), title: "MYSTICAL NINJA", gameCode: "NG5E", region: "US", byteLength: 33554432, decompressed: true };
const material: NonNullable<GeometryMesh["material"]> = { textureId: "texture:wood", wrapS: "repeat", wrapT: "repeat", filter: "nearest", color: [1, 1, 1], opacity: 1, alphaTest: 0, vertexColors: true, lighting: false };
const texture = { id: "texture:wood", width: 1, height: 1, format: "RGBA16", rgbaBase64: Buffer.from([255, 128, 0, 255]).toString("base64") };
const native: RoomData = { id: 0, name: "Native", actorCount: 1, eventCount: 0, geometryAvailable: true, warnings: [], source: { romOffset: 100, expectedHex: "00" },
  meshes: [{ id: "native:mesh", positions: [0, 0, 0, 16, 0, 0, 0, 0, 16], indices: [0, 1, 2], source: "display-list", material }], textures: [texture], events: [],
  actors: [{ id: "actor:100", index: 0, actorId: 139, name: "Sign", position: zero(), rotation: zero(), parameters: [0, 1, 2], editable: true, sourceKind: "normal", source: { romOffset: 256, expectedHex: "00".repeat(20), fileId: 12 }, definitionSource: { romOffset: 512, expectedHex: "00".repeat(16), fileId: 12 } }] };
const entrance = () => ({ id: "spawn", name: "Spawn", position: zero(), baseYaw: 0, entryParameter: 0x10 });
const catalog: AuthoringCatalog = { romHash: rom.normalizedSha256,
  actors: [{ actorId: 139, name: "Sign", prototypeIds: ["actor:8b:variant"], warnings: [] }],
  actorPrototypes: [{ id: "actor:8b:variant", actorId: 139, name: "Sign", parameters: [0, 1, 2], unknownHalfword: 0, resourceFileIds: [12], sourceRoomId: 0, sourceActorRef: "actor:100", warnings: [] }],
  geometry: [{ id: "geometry:wood", name: "Wood", roomIds: [0], meshCount: 1, vertexCount: 3, triangleCount: 1, warnings: [] }],
  materials: [{ id: "material:wood", name: "Wood", material, textureIds: [texture.id] }], surfaces: [{ id: "surface:opaque", classifier: 1, surface: 7 }],
  nativeEntrances: [{ ...entrance(), id: "native-start:0", roomId: 0 }], skyboxes: [{ id: "skybox:native:1", name: "Sky", nativeIndex: 1, fileId: 123, warnings: [] }],
  roomAdmission: { minId: 620, maxId: 799, supported: false, reason: "Registry hooks pending" } };
function lookup(calls: ActorPrototypeEdits[] = []): AuthoringLookup {
  return { catalog: structuredClone(catalog), nativeRooms: [{ id: 0, name: "Native", actorCount: 1, eventCount: 0, geometryAvailable: true, warnings: [] }],
    loadRoom(id) { assert.equal(id, 0); return structuredClone(native); }, resolveMaterial(id) { assert.equal(id, "material:wood"); return { material: structuredClone(material), textures: [structuredClone(texture)] }; },
    loadSkyboxAsset(id) { assert.equal(id, "skybox:native:1"); return { id, texture: structuredClone(texture), warnings: [] }; }, nativeRoomSkyboxId(id) { assert.equal(id, 0); return "skybox:native:1"; },
    loadActorPrototype(id, edits) {
      assert.equal(id, "actor:8b:variant"); if (edits) calls.push(structuredClone(edits));
      return { actorVisuals: [{ actorRef: "actor:100", status: "conditional", parts: [{ assetId: "model:sign", rootMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], positionOffset: zero(), rotationOverrides: {}, billboardAxes: { x: false, y: false, z: false }, pose: "static", provenance: { identity: 1, slot: 0, fileIds: [12], modelPointer: 0x80000000 } }], warnings: ["Initial state assumption"] }], actorModels: [{ id: "model:sign", meshes: structuredClone(native.meshes), textures: [structuredClone(texture)], nodes: [], warnings: [] }] };
    } };
}
function authored(id = 620): AuthoredRoom {
  return { id, name: "Authored", kind: "new", templateRoomId: 0,
    materials: [{ id: "paint", sourceMaterialId: "material:wood" }], meshes: [{ id: "floor", materialId: "paint", sourceAssetId: "geometry:wood", vertices: [
      { position: zero(), uv: [0, 0], color: [255, 128, 0, 127] }, { position: { x: 16, y: 0, z: 0 }, uv: [1, 0], color: [255, 255, 255, 255] }, { position: { x: 0, y: 0, z: 16 }, uv: [0, 1], color: [255, 255, 255, 255] }], indices: [0, 1, 2] }],
    collisionMode: "authored", collision: [{ id: "floor-collision", vertices: [zero(), { x: 16, y: 0, z: 0 }, { x: 0, y: 0, z: 16 }], classifier: 1, surface: 7, surfaceId: "surface:opaque", sourceMeshId: "floor" }],
    actors: [{ id: "sign", prototypeId: "actor:8b:variant", position: { x: 1, y: 2, z: 3 }, rotation: zero(), parameters: [0, 1, 0xffffffff] }], doors: [], entrances: [entrance()], skyboxId: "skybox:native:1" };
}
function project(): EditorProjectV2 { const value = createProject("Authored", rom); value.authoredRooms["620"] = authored(); return value; }
const validate = (value: unknown, context = lookup()) => validateProject(value, rom, context.loadRoom, undefined, context);

test("template BSP translation round trips and requires trusted native bounds", () => {
  const value = project(), room = value.authoredRooms["620"], context = lookup();
  room.collisionMode = "template"; room.collision = [];
  room.collisionTranslation = { x: 16, y: -8, z: 4 };
  assert.throws(() => validate(value), /trusted native bounds/);
  const calls: Vec3[] = [];
  const checked = validateProject(value, rom, context.loadRoom, (id, delta) => {
    assert.equal(id, 0); calls.push(structuredClone(delta));
    return { roomId: id, affectedRoomIds: [0], spans: [], guards: [] };
  }, context);
  assert.deepEqual(calls, [room.collisionTranslation]);
  assert.deepEqual(JSON.parse(JSON.stringify(checked)), value);
  const scene = composeProjectRoom(checked, 620, context);
  assert.deepEqual(scene.collisionTranslation, room.collisionTranslation);
  assert.deepEqual(scene.meshes[0].positions.slice(0, 3), [0, 0, 0], "Private physics delta must not translate authored visual vertices twice");
  assert.throws(() => validateProject(value, rom, context.loadRoom, () => { throw new Error("Translated cell bounds exceed s16"); }, context), /bounds exceed s16/);
  assert.throws(() => validateProject(value, rom, context.loadRoom, id => ({ roomId: id + 1, affectedRoomIds: [], spans: [], guards: [] }), context), /wrong donor/);
  room.collisionTranslation.x = 65536; assert.throws(() => validate(value), /65535/);
  room.collisionTranslation = zero(); assert.deepEqual(validate(value).authoredRooms["620"].collisionTranslation, zero());
  room.collisionMode = "authored"; assert.throws(() => validate(value), /requires template/);
});

test("native alias composition exposes the effective physics delta for promotion", () => {
  const value = createProject("Alias", rom), context = lookup();
  value.roomOverrides["1"] = { actors: {}, events: {}, geometry: { translation: { x: 16, y: 0, z: -8 } } };
  const scene = composeProjectRoom(value, 0, context, id => ({ roomId: id, affectedRoomIds: [0, 1], spans: [], guards: [] }));
  assert.deepEqual(scene.collisionTranslation, value.roomOverrides["1"].geometry!.translation);
  assert.deepEqual(scene.meshes[0].positions.slice(0, 3), [16, 0, -8]);
  scene.collisionTranslation!.x = 99;
  assert.equal(value.roomOverrides["1"].geometry!.translation.x, 16);
});

test("authored collision matches the compiler face classifier and u16 slot budgets", () => {
  const value = project(), room = value.authoredRooms["620"], triangle = structuredClone(room.collision[0]);
  room.collision[0].classifier = 0; assert.throws(() => validate(value), /1..255/);
  room.collision[0].classifier = 255; delete room.collision[0].surfaceId; validate(value);
  assert.equal(AUTHORING_LIMITS.collisionTrianglesPerRoom, 9362);
  room.collision = Array.from({ length: 9362 }, (_, index) => ({ ...structuredClone(triangle), id: `collision:${index}` }));
  assert.equal(validate(value).authoredRooms["620"].collision.length, 9362);
  room.collision.push({ ...triangle, id: "collision:overflow" });
  assert.throws(() => validate(value), /9362-item limit/);
});

test("authored actor spawn policy persists independently of its prototype default", () => {
  const value = project(), context = lookup();
  context.catalog.actorPrototypes[0].sourceKind = "partition";
  assert.equal(composeProjectRoom(validate(value, context), 620, context).actors[0].sourceKind, "partition");
  value.authoredRooms["620"].actors[0].spawnPolicy = "resident";
  let normalized = validate(JSON.parse(JSON.stringify(value)), context);
  assert.equal(normalized.authoredRooms["620"].actors[0].spawnPolicy, "resident");
  assert.equal(composeProjectRoom(normalized, 620, context).actors[0].sourceKind, "resident");
  value.authoredRooms["620"].actors[0].spawnPolicy = "proximity";
  normalized = validate(value, context);
  assert.equal(normalized.authoredRooms["620"].actors[0].spawnPolicy, "proximity");
  assert.equal(composeProjectRoom(normalized, 620, context).actors[0].sourceKind, "partition");
  const malformed = JSON.parse(JSON.stringify(value)); malformed.authoredRooms["620"].actors[0].spawnPolicy = "always";
  assert.throws(() => validate(malformed, context), /spawn policy/);
});

test("authored actor preview uses actual destination and donor rather than prototype source room", () => {
  const value = validate(project()), context = lookup(), calls: AuthoringActorContext[] = [];
  context.loadActorPrototypeForRoom = (id, edits, room) => { calls.push(structuredClone(room)); return context.loadActorPrototype(id, edits); };
  context.loadActorPrototype = context.loadActorPrototype.bind(context);
  const payload = composeProjectActorVisuals(value, 620, context, () => { throw new Error("Native roster path must not handle authored insertions"); });
  const actor = value.authoredRooms["620"].actors[0];
  assert.deepEqual(calls, [{ roomId: 620, templateRoomId: 0, siblings: [{ prototypeId: actor.prototypeId, parameters: actor.parameters, position: actor.position, rotation: actor.rotation }] }]);
  assert.equal(payload.actorVisuals[0].actorRef, "sign");
});
test("contextual preview receives complete authored spawn order and removes deleted siblings", () => {
  const value = project(), context = lookup(), calls: AuthoringActorContext[] = [];
  const current = structuredClone(value.authoredRooms["620"].actors[0]);
  value.authoredRooms["620"].actors.unshift({ ...current, id: "sibling", parameters: [10, 20, 30], position: { x: 16, y: 32, z: 64 } });
  context.loadActorPrototypeForRoom = (id, edits, room) => { calls.push(structuredClone(room)); return context.loadActorPrototype(id, edits); };
  composeProjectActorVisuals(validate(value, context), 620, context, () => { throw new Error("Native donor roster must not substitute for authored siblings"); });
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.deepEqual(call.siblings?.map(actor => actor.parameters), [[10, 20, 30], current.parameters]);
    assert.deepEqual(call.siblings?.[0].position, { x: 16, y: 32, z: 64 });
    assert.deepEqual(Object.keys(call.siblings![0]).sort(), ["parameters", "position", "prototypeId", "rotation"]);
  }
  calls[0].siblings![0].position.x = 999;
  assert.equal(value.authoredRooms["620"].actors[0].position.x, 16, "Trusted declarations must not share mutable project vectors");
  value.authoredRooms["620"].actors.shift(); calls.length = 0;
  composeProjectActorVisuals(validate(value, context), 620, context, () => { throw new Error("Unexpected native fallback"); });
  assert.equal(calls[0].siblings?.length, 1);
  assert.deepEqual(calls[0].siblings?.[0].parameters, current.parameters);
});

test("V1 migration preserves timestamps, identity and sparse edits without authoring data loss", () => {
  const fresh = createProject("Legacy", rom), { authoredRooms: _rooms, ...metadata } = fresh;
  const legacy: LegacyEditorProject = { ...metadata, version: 1, rom: { ...rom, sha256: "c".repeat(64), decompressed: false }, roomOverrides: { "0": { actors: { "actor:100": { position: { x: 1, y: 2, z: 3 }, parameters: [0, 1, 0xffffffff] } }, events: {} } } };
  const canonical = validate(legacy);
  assert.deepEqual(canonical, { ...legacy, version: 2, authoredRooms: {} });
  assert.equal(legacy.version, 1);
});
test("V2 round trip is independent and preserves explicit authored records", () => {
  const value = project(), canonical = validate(JSON.parse(JSON.stringify(value)));
  assert.deepEqual(canonical, value);
  value.authoredRooms["620"].meshes[0].vertices[0].color[3] = 0;
  assert.equal(canonical.authoredRooms["620"].meshes[0].vertices[0].color[3], 127);
  assert.deepEqual(validate(canonical), canonical);
});
test("scene selection IDs cannot alias actors, meshes, doors or entrances", () => {
  const cases: ((room: AuthoredRoom) => void)[] = [
    room => { room.actors[0].id = room.meshes[0].id; },
    room => { room.actors[0].id = `entrance:${room.entrances[0].id}`; },
    room => { room.meshes[0].id = `entrance:${room.entrances[0].id}`; room.collision = []; },
    room => { room.actors[0].id = "door:cross"; },
    room => { room.meshes[0].id = "door:cross"; room.collision = []; },
    room => { room.meshes[0].id = `event:${room.actors[0].id}`; room.collision = []; },
    room => { room.actors.push({ ...structuredClone(room.actors[0]), id: `event:${room.actors[0].id}` }); },
  ];
  for (const mutate of cases) {
    const value = project(), room = value.authoredRooms["620"];
    room.doors = [{ id: "cross", position: zero(), rotation: zero(), dimensions: { x: 8, y: 8, z: 8 }, activation: "touch", destination: { roomId: 620, entranceId: room.entrances[0].id } }];
    mutate(room); assert.throws(() => validate(value), /Duplicate scene selection/);
  }
  const distinct = project(); distinct.authoredRooms["620"].actors[0].id = "door:other";
  assert.equal(validate(distinct).authoredRooms["620"].actors[0].id, "door:other", "Prefixes themselves remain valid when no effective ID is duplicated");
});
test("new rooms require reserved unoccupied IDs, verified templates and explicit spawn", () => {
  for (const id of [619, 800]) { const value = project(); value.authoredRooms = { [id]: authored(id) }; assert.throws(() => validate(value), /ID|620/); }
  const missing = project(); missing.authoredRooms["620"].templateRoomId = 1; assert.throws(() => validate(missing), /verified vanilla/);
  const mismatch = project(); mismatch.authoredRooms["620"].id = 621; assert.throws(() => validate(mismatch), /disagree/);
  const spawn = project(); spawn.authoredRooms["620"].entrances = []; assert.throws(() => validate(spawn), /spawn entrance/);
  const occupied = lookup(); occupied.nativeRooms.push({ ...occupied.nativeRooms[0], id: 620 }); assert.throws(() => validate(project(), occupied), /unoccupied/);
});
test("full native replacements cannot silently consume sparse edits", () => {
  const value = project(); value.authoredRooms = { "0": { ...authored(0), kind: "replacement" } };
  validate(value);
  value.roomOverrides["0"] = { actors: { "actor:100": { position: zero() } }, events: {} };
  assert.throws(() => validate(value), /cannot also contain sparse/);
  delete value.roomOverrides["0"]; value.authoredRooms["0"].templateRoomId = 620;
  assert.throws(() => validate(value), /verified vanilla/);
});
test("forged resources, paths, native pointers and unknown fields are rejected", () => {
  const mutations: ((value: EditorProjectV2) => void)[] = [
    value => { value.authoredRooms["620"].actors[0].prototypeId = "actor:forged"; },
    value => { value.authoredRooms["620"].meshes[0].sourceAssetId = "geometry:forged"; },
    value => { value.authoredRooms["620"].materials[0].sourceMaterialId = "material:forged"; },
    value => { value.authoredRooms["620"].skyboxId = "skybox:forged"; },
    value => { value.authoredRooms["620"].actors[0].id = "../escape"; },
    value => { Object.assign(value.authoredRooms["620"].actors[0], { modelPointer: 0x80000000 }); },
    value => { Object.assign(value.authoredRooms["620"], { rawRomBytes: "AA==" }); },
    value => { Object.assign(value.authoredRooms["620"].meshes[0], { transform: { scale: 2 } }); },
    value => { Object.assign(value.rom, { cachePath: "/tmp/rom" }); },
  ];
  for (const mutate of mutations) { const value = project(); mutate(value); assert.throws(() => validate(value)); }
  const absent = project(); delete (absent as Partial<EditorProjectV2>).authoredRooms; assert.throws(() => validate(absent), /plain object/);
  const context = lookup(); context.catalog.romHash = "c".repeat(64); assert.throws(() => validate(project(), context), /different ROM/);
});
test("native positions, RGBA, UV and triangle topology are bounded without clamping", () => {
  const mutations: ((room: AuthoredRoom) => void)[] = [
    room => { room.meshes[0].vertices[0].position.x = 32768; }, room => { room.meshes[0].vertices[0].position.x = 0.5; },
    room => { room.meshes[0].vertices[0].color[3] = 256; }, room => { room.meshes[0].vertices[0].uv[0] = Infinity; },
    room => { room.meshes[0].vertices[0].uv[0] = NaN; }, room => { room.meshes[0].indices = [0, 1]; },
    room => { room.meshes[0].indices = [0, 1, 3]; }, room => { room.meshes[0].indices = [0, 0, 1]; },
    room => { room.actors[0].parameters[2] = 0x100000000; }, room => { room.entrances[0].entryParameter = 40; },
    room => { room.collision[0].classifier = 256; }, room => { room.collision[0].surface = -1; },
    room => { room.collision[0].surface = 8; }, room => { room.collision[0].sourceMeshId = "absent"; },
  ];
  for (const mutate of mutations) { const value = project(); mutate(value.authoredRooms["620"]); assert.throws(() => validate(value)); }
  const tiling = project(); tiling.authoredRooms["620"].meshes[0].vertices[0].uv = [-1, 2]; validate(tiling);
});
test("door activation, dimensions and cross-room arrival references are explicit", () => {
  const value = project(); value.authoredRooms["621"] = authored(621);
  const door = { id: "travel", position: zero(), rotation: zero(), dimensions: { x: 16, y: 32, z: 8 }, activation: "touch" as const, appearancePrototypeId: "actor:8b:variant", destination: { roomId: 621, entranceId: "spawn" } };
  value.authoredRooms["620"].doors.push(door); validate(value);
  door.destination.entranceId = "absent"; assert.throws(() => validate(value), /unknown destination/);
  door.destination = { roomId: 0, entranceId: "native-start:0" }; validate(value);
  door.dimensions.x = 0; assert.throws(() => validate(value), /dimensions/);
  door.dimensions.x = 16; door.id = "sign"; assert.throws(() => validate(value), /Duplicate placement/);
});
test("encoded project budget is symmetric and checked before deep composition", () => {
  assertProjectBytes("x".repeat(MAX_PROJECT_BYTES - 2));
  assert.throws(() => assertProjectBytes("x".repeat(MAX_PROJECT_BYTES - 1)), /16 MiB/);
  const value = project(); value.name = "x".repeat(MAX_PROJECT_BYTES); assert.throws(() => validate(value), /16 MiB/);
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic; assert.throws(() => validate(cyclic), /acyclic/);
});
test("aggregate vertex budget and duplicate entity IDs are rejected", () => {
  const value = project(); value.authoredRooms["620"].meshes[0].vertices = Array.from({ length: 16385 }, () => ({ position: zero(), uv: [0, 0] as [number, number], color: [255, 255, 255, 255] as [number, number, number, number] }));
  assert.throws(() => validate(value), /16384/);
  const duplicate = project(); duplicate.authoredRooms["620"].actors.push(structuredClone(duplicate.authoredRooms["620"].actors[0])); assert.throws(() => validate(duplicate), /Duplicate placement/);
});
test("authored composition preserves exact mesh IDs, alpha, explicit collision and independent state", () => {
  const value = validate(project()), original = JSON.stringify(value), scene = composeProjectRoom(value, 620, lookup());
  assert.equal(scene.kind, "new"); assert.equal(scene.source, undefined);
  assert.equal(scene.meshes[0].id, "floor"); assert.equal(scene.meshes[0].materialId, "paint"); assert.equal(scene.meshes[0].colorItemSize, 4); assert.equal(scene.meshes[0].colors![3], 127 / 255);
  assert.equal(scene.actors[0].prototypeId, "actor:8b:variant"); assert.equal(scene.actors[0].source, undefined);
  assert.equal(scene.collision[0].sourceMeshId, "floor"); assert.equal(scene.skybox!.id, "skybox:native:1"); assert.match(scene.warnings[0], /Registry hooks/);
  assert.deepEqual(listProjectRooms(value, lookup()).map(room => room.id), [0, 620]);
  scene.meshes[0].positions[0] = 999; assert.equal(JSON.stringify(value), original);
  const noCollision = project(); noCollision.authoredRooms["620"].collision = [];
  assert.equal(composeProjectRoom(validate(noCollision), 620, lookup()).meshes.some(mesh => mesh.source === "collision"), false);
});
test("native scene composition applies actor-linked events and translation without changing baseline", () => {
  const value = createProject("Sparse", rom); value.roomOverrides["0"] = { actors: { "actor:100": { position: { x: 4, y: 5, z: 6 } } }, events: {}, geometry: { translation: { x: 16, y: 0, z: 0 } } };
  const context = lookup(), baseline = context.loadRoom;
  context.loadRoom = id => { const room = baseline(id); room.actors[0].actorId = 0x23c; room.actors[0].parameters = [0, 1, 2]; room.events = [actorEvent(room.actors[0])!]; return room; };
  const scene = composeProjectRoom(value, 0, context);
  assert.deepEqual(scene.events[0].position, { x: 4, y: 5, z: 6 }); assert.equal(scene.meshes[0].positions[0], 16);
  assert.equal(native.meshes[0].positions[0], 0); assert.equal(native.actors[0].position.x, 0);
});
test("authored previews retain prototype parameters, remap local IDs and deduplicate native assets", () => {
  const value = project(); value.authoredRooms["620"].actors.push({ ...structuredClone(value.authoredRooms["620"].actors[0]), id: "second" });
  const calls: ActorPrototypeEdits[] = [], context = lookup(calls), normalized = validate(value, context);
  const payload = composeProjectActorVisuals(normalized, 620, context, () => { throw new Error("Authored actors must not use a native room roster."); });
  assert.deepEqual(payload.actorVisuals.map(visual => visual.actorRef), ["sign", "second"]); assert.equal(payload.actorModels.length, 1);
  assert.deepEqual(calls[0].parameters, [0, 1, 0xffffffff]); assert.deepEqual(calls[0].position, { x: 1, y: 2, z: 3 });
});
test("native scene regenerates effective event subtype and payload while preserving independent events", () => {
  const context = lookup(), baseline = context.loadRoom;
  const independent = { id: "native:independent", index: 17, name: "Independent", kind: "native-script", position: { x: 9, y: 8, z: 7 }, values: [42], source: { romOffset: 2048, expectedHex: "00" }, editable: false };
  context.loadRoom = id => {
    const room = baseline(id); room.actors[0].actorId = 0x23c;
    room.actors.push({ ...structuredClone(room.actors[0]), id: "actor:second", index: 1, actorId: 0x23d, parameters: [0x01000000, 0, 0], source: { romOffset: 1024, expectedHex: "00".repeat(20) }, definitionSource: { romOffset: 1536, expectedHex: "00".repeat(16) } });
    room.events = [actorEvent(room.actors[0])!, structuredClone(independent)]; return room;
  };
  const value = createProject("Events", rom);
  value.roomOverrides["0"] = { actors: { "actor:100": { parameters: [0, 0, 0x12340000] } }, events: {} };
  let scene = composeProjectRoom(validate(value, context), 0, context);
  assert.deepEqual(scene.events.find(event => event.id === independent.id), independent);
  const travel = scene.events.find(event => event.actorRef === "actor:100")!;
  assert.match(travel.name, /1234/); assert.deepEqual(travel.values, [0, 0, 0x12340000]);
  value.roomOverrides["0"].actors["actor:100"] = { actorId: 0x23d, parameters: [0x03000000, 0, 0] };
  scene = composeProjectRoom(validate(value, context), 0, context);
  const barrier = scene.events.find(event => event.actorRef === "actor:100")!;
  assert.equal(barrier.kind, "hit-trigger"); assert.match(barrier.name, /subtype 3/);
  value.roomOverrides["0"].actors["actor:100"].parameters = [0, 0, 0];
  scene = composeProjectRoom(validate(value, context), 0, context);
  assert.equal(scene.events.some(event => event.actorRef === "actor:100"), false, "Unsupported subtype must not retain a stale derived event");
  assert.equal(scene.eventCount, scene.events.length);
});
test("authored event details follow effective prototype/parameters without invented native provenance", () => {
  const context = lookup(), value = project();
  context.catalog.actorPrototypes[0].actorId = 0x23c;
  value.authoredRooms["620"].actors[0].parameters = [0, 0, 0x43210000];
  let scene = composeProjectRoom(validate(value, context), 620, context);
  assert.equal(scene.events.length, 1); assert.equal(scene.eventCount, 1);
  assert.equal(listProjectRooms(validate(value, context), context).find(room => room.id === 620)!.eventCount, 1);
  assert.equal(scene.events[0].actorRef, "sign"); assert.match(scene.events[0].name, /4321/);
  assert.deepEqual(scene.events[0].position, value.authoredRooms["620"].actors[0].position);
  assert.deepEqual(scene.events[0].values, [0, 0, 0x43210000]);
  assert.equal(Object.hasOwn(scene.events[0], "source"), false);
  context.catalog.actorPrototypes[0].actorId = 0x23d;
  value.authoredRooms["620"].actors[0].parameters = [0x04000000, 0, 0];
  scene = composeProjectRoom(validate(value, context), 620, context);
  assert.equal(scene.events[0].kind, "hit-trigger"); assert.match(scene.events[0].name, /subtype 4/);
  value.authoredRooms["620"].actors[0].parameters = [0, 0, 0];
  scene = composeProjectRoom(validate(value, context), 620, context);
  assert.deepEqual(scene.events, []); assert.equal(scene.eventCount, 0);
});
test("trusted backend texture corruption or excessive dimensions fail before GPU/IPC composition", () => {
  const value = validate(project()), context = lookup();
  context.resolveMaterial = () => ({ material, textures: [{ ...texture, width: 1024, height: 1024 }] });
  assert.throws(() => composeProjectRoom(value, 620, context), /bounded native/);
  context.resolveMaterial = () => ({ material, textures: [{ ...texture, rgbaBase64: "AAAA" }] });
  assert.throws(() => composeProjectRoom(value, 620, context), /bounded RGBA/);
});
test("prototype IPC validation accepts only three native words and bounded transforms", () => {
  const valid = { parameters: [0, 1, 0xffffffff], position: { x: -32768, y: 32767, z: 0 }, rotation: zero() };
  assert.deepEqual(validatePrototypeEdits(valid), valid);
  assert.deepEqual(validatePrototypeEdits(undefined), {});
  for (const bad of [null, [], { parameters: [0, 1] }, { parameters: [0, 1, 0x100000000] }, { position: { x: Infinity, y: 0, z: 0 } }, { rotation: { x: 32768, y: 0, z: 0 } }, { source: { romOffset: 0 } }, { command: "clang" }, { parameters: [0, 1, 2], nativePointer: 0x80000000 }]) assert.throws(() => validatePrototypeEdits(bad));
});
test("native clone physics stays explicit and visual collinear triangles preserve their indices", () => {
  const value = project(), room = value.authoredRooms["620"];
  room.collisionMode = "template"; room.collision = [];
  room.meshes[0].vertices[2].position = { x: 32, y: 0, z: 0 };
  const normalized = validate(value), scene = composeProjectRoom(normalized, 620, lookup());
  assert.deepEqual(scene.meshes[0].indices, [0, 1, 2]); assert.equal(scene.collisionMode, "template");
  assert(scene.warnings.some(warning => /Visual mesh edits do not change its physics/.test(warning)));
  room.collision = authored().collision; assert.throws(() => validate(value), /Template collision cannot/);
  room.collisionMode = "authored"; room.collision[0].vertices[2] = { x: 32, y: 0, z: 0 };
  assert.throws(() => validate(value), /degenerate/);
});
test("inherited skybox and explicit None remain distinct through persistence and composition", () => {
  const inherited = project(); delete inherited.authoredRooms["620"].skyboxId;
  const normalized = validate(JSON.parse(JSON.stringify(inherited)));
  assert.equal(Object.hasOwn(normalized.authoredRooms["620"], "skyboxId"), false);
  assert.equal(composeProjectRoom(normalized, 620, lookup()).skybox!.id, "skybox:native:1");
  const none = project(); none.authoredRooms["620"].skyboxId = null;
  const empty = validate(JSON.parse(JSON.stringify(none)));
  assert.equal(empty.authoredRooms["620"].skyboxId, null); assert.equal(composeProjectRoom(empty, 620, lookup()).skybox, undefined);
  assert.equal(composeProjectRoom(createProject("Native", rom), 0, lookup()).skybox!.id, "skybox:native:1");
});
test("authored RGBA overrides native lighting under the same compiler policy", () => {
  const context = lookup(); context.resolveMaterial = () => ({ material: { ...material, lighting: true }, textures: [texture] });
  const scene = composeProjectRoom(validate(project(), context), 620, context);
  assert.equal(scene.meshes[0].material!.lighting, false);
  assert.equal(scene.meshes[0].material!.vertexColors, true);
  assert.equal(scene.meshes[0].colorItemSize, 4);
  assert.equal(scene.meshes[0].colors![3], 127 / 255);
});
test("entrance ABI stores one native heading and rejects unused Euler/yaw fields", () => {
  const value = project(); value.authoredRooms["620"].entrances[0].baseYaw = -32768;
  assert.equal(validate(value).authoredRooms["620"].entrances[0].baseYaw, -32768);
  value.authoredRooms["620"].entrances[0].baseYaw = 32767; validate(value);
  for (const field of ["rotation", "cameraYaw", "playerYaw"]) {
    const bad = project(); Object.assign(bad.authoredRooms["620"].entrances[0], { [field]: field === "rotation" ? zero() : 0 });
    assert.throws(() => validate(bad), /unsupported field/);
  }
});
test("atomic project storage round trips the exact 16 MiB encoded boundary", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "mnsg-project-budget-")), file = path.join(directory, "boundary.mnsgproj");
  try {
    const boundary = "x".repeat(MAX_PROJECT_BYTES - 2);
    assertProjectBytes(boundary);
    await atomicWrite(file, JSON.stringify(boundary));
    assert.equal((await stat(file)).size, MAX_PROJECT_BYTES);
    assert.equal(await readJson(file, MAX_PROJECT_BYTES), boundary);
    const oversized = `${boundary}x`;
    assert.throws(() => assertProjectBytes(oversized), /16 MiB/);
    await atomicWrite(file, JSON.stringify(oversized));
    await assert.rejects(readJson(file, MAX_PROJECT_BYTES), /too large/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
