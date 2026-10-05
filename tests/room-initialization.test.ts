import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { importRomBytes, type ImportedRom } from "../core/rom";
import { RomReader } from "../core/rom/binary";
import { readFileTable, type RomFile } from "../core/rom/decompress";
import { NativeRoomInitialization } from "../core/rom/room-initialization";
import type { RoomInitialization } from "../shared/room-initialization";
import type { AuthoredRoom, AuthoringCatalog, RoomData } from "../shared/types";
import type { AuthoringLookup } from "../core/authoring/project";
import { createProject } from "../core/project";
import { composeProjectRoom } from "../core/authoring/scene";

const real = { skip: !process.env.MNSG_TEST_ROM };
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
let imported: ImportedRom | undefined;
function database(): ImportedRom {
  return imported ??= importRomBytes(readFileSync(process.env.MNSG_TEST_ROM!));
}
function context(bytes = database().bytes): { reader: RomReader; files: Map<number, RomFile>; decoder: NativeRoomInitialization } {
  const reader = new RomReader(bytes), files = new Map(readFileTable(bytes).map(file => [file.id, file]));
  return { reader, files, decoder: new NativeRoomInitialization(reader, files) };
}
// Independent native census fixtures. No proprietary source bytes or game assets.
const fixtures = [
  { room: 0, metadata: 0x8022ea18, callback: 0x8020de40, list: 0x8022c240, wave: 822, stage: 0, local: 0, group: 0, index: 0,
    metadataHash: "8b1222c058f6d8b39a1a6a80b4653b2bd40daf310c4df41435b0dc67670da9ce", callbackHash: "7169144165233a889354a314aa11f96b4e1ad42b96b93fff7df819fbc8eff4ae", listHash: "f2cf5ea48413e8197035b2324d9fd3750508618b6175944c1112976d819b9906",
    files: [93,822,1155,401,338,32,408,345,43,420,504,340,419,37,416,341], cold: [127,131,133,138] },
  { room: 193, metadata: 0x8022ff34, callback: 0x8020f964, list: 0x8022d520, wave: 981, stage: 0, local: 193, group: 5, index: 65,
    metadataHash: "a42c4417c6d3a1517e21bd8c1f730d59c6eadca070f9f0f19873da3f2c0c3403", callbackHash: "10e697d3da7a00e042993a35ab2a53c0ad6391458ee5c2f04383f33bde9fcd3e", listHash: "c9f32394b61ee20237877684c63572e8e8cf42547f9d4b3751c786719be2f0d0",
    files: [95,120,101,807,814,697,981,1164,401,338,380,381,43,505,348,74,75], cold: [127,268,273,287] },
  { room: 306, metadata: 0x802300bc, callback: 0x8020fb5c, list: 0x8022d674, wave: 989, stage: 1, local: 6, group: 1, index: 6,
    metadataHash: "65e73b7d19ff27e2be864880f49f917e00458250c96c5165551a9fe409d21e14", callbackHash: "c070ae23f1ab9dd74a23a2c30434f493d8a54f4ad3fbc939bb52ce716c3e760c", listHash: "cba333494c5713dafc47f651b968de4dac776249415d07d91c14928ac2694d9c",
    files: [385,305,101,697,805,809,989,1166,401,338,724,70,45,690,369,43,507,367,26,402,32,407,345], cold: [127,145,149,168,125] },
  { room: 465, metadata: 0x802310ec, callback: 0x8021102c, list: 0x8022e8b8, wave: 1137, stage: 3, local: 65, group: 3, index: 65,
    metadataHash: "f442d600dfeed4a0ad1a39d537fa3394d132aa703b4fa3589da9be0e6e1d74f4", callbackHash: "b288a359064a7a00294bccdcd093d8dc4f7634b383caced272515be4d79b7be5", listHash: "3b8433d92b3c39cc6dd371e878b0c16977f44794605524ce89de07bdcb0ea797",
    files: [96,100,1137,401,338,643,364,644,35,448,405,32,407,345,43,515,54,27,61], cold: [127,240,241,253] },
  { room: 483, metadata: 0x802312e4, callback: 0x802112b4, list: 0x8022ea04, wave: 1154, stage: 3, local: 83, group: 3, index: 83,
    metadataHash: "e1928c71a6a9fcb902477c7f5e80d34d5cb58061032896fdd1513530f7fbd2d8", callbackHash: "f1035bffc179fe8d219a1cca39a4e8de78bab0a66a56b16d5b1fecbcc51f09d8", listHash: "7e0cea7572b7b1eb1ed90f52c1dad52a62b7b5c87b17327b20c2c81dd4449c58",
    files: [96,100,1154,338,43,515,27,61,60], cold: [127,240,241,253] },
];

test("initialization rejects invalid identities and noncanonical bytes before allocation/decoding", () => {
  const decoder = new NativeRoomInitialization(new RomReader(new Uint8Array(64)), new Map());
  for (const id of [-1, .5, 800, NaN, Infinity]) assert.throws(() => decoder.inspect(id), /Invalid native room initialization ID/);
  assert.throws(() => decoder.inspect(0), /canonical 32 MiB/);
});

test("actual native callback fixtures preserve signed delay-slot addresses, hashes and both resource orders", real, () => {
  const { decoder, reader } = context();
  const before = hash(reader.bytes);
  for (const fixture of fixtures) {
    const record = decoder.inspect(fixture.room);
    assert.equal(record.status, "world-metadata"); assert.equal(record.roomId, fixture.room);
    assert.equal(record.tableEntryRomOffset, 0x5ec7d0 + fixture.room * 4);
    assert.deepEqual(record.context, { stage: fixture.stage, localIndex: fixture.local, geometryGroup: fixture.group, geometryIndex: fixture.index });
    assert.equal(record.metadata!.source.cpuAddress, fixture.metadata); assert.equal(record.metadata!.source.sha256, fixture.metadataHash); assert.equal(record.metadata!.source.byteLength, 28);
    assert.equal(record.actorDataFileId, fixture.wave); assert.equal(record.reservedHalfword, 0);
    assert.equal(record.loadCallback!.source.cpuAddress, fixture.callback); assert.equal(record.loadCallback!.source.sha256, fixture.callbackHash); assert.equal(record.loadCallback!.source.byteLength, 36);
    assert.equal(record.loadCallback!.dependencyList.source.cpuAddress, fixture.list); assert.equal(record.loadCallback!.dependencyList.source.sha256, fixture.listHash);
    assert.equal(record.loadCallback!.dependencyList.source.byteLength, (fixture.files.length + 1) * 2);
    assert.deepEqual(record.loadCallback!.dependencyList.orderedFileIds, fixture.files);
    assert.deepEqual(record.geometry!.coldLoadOrder, fixture.cold);
    assert.match(record.reason, /does not decode.*full gameplay events/);
    // OR-ing native ADDIU's negative low immediate would yield an invalid 8023xxxx address.
    const immediate = reader.u16(record.loadCallback!.source.romOffset + 18);
    assert(immediate >= 0x8000);
    assert.notEqual((0x80230000 | immediate) >>> 0, fixture.list);
  }
  assert.equal(hash(reader.bytes), before);
});

test("actual 383-record sweep is bounded, complete for metadata and distinct from gameplay events", real, () => {
  const db = database(), { decoder } = context(); const before = hash(db.bytes);
  const rooms = db.listRooms(); assert.equal(rooms.length, 383);
  let world = 0, aliases = 0; const metadata = new Set<number>(), callbacks = new Set<number>(), lists = new Set<number>(), contents = new Set<string>();
  for (const room of rooms) {
    const record = decoder.inspect(room.id);
    assert(Buffer.byteLength(JSON.stringify(record)) < 8192, "Read-only inspection payload must remain bounded");
    const serialized = JSON.stringify(record);
    for (const field of ['"expectedHex"', '"bytes"', '"position"', '"rotation"', '"editable"', '"nativeExecuted"']) assert(!serialized.includes(field));
    if (record.status === "world-metadata") {
      world++; metadata.add(record.metadata!.source.cpuAddress); callbacks.add(record.loadCallback!.source.cpuAddress); lists.add(record.loadCallback!.dependencyList.source.cpuAddress); contents.add(record.loadCallback!.dependencyList.orderedFileIds.join(","));
      assert(record.loadCallback!.dependencyList.orderedFileIds.length >= 2 && record.loadCallback!.dependencyList.orderedFileIds.length <= 31);
    } else {
      aliases++; assert(room.id >= 540 && room.id <= 548);
      assert.equal(record.metadata, undefined); assert.equal(record.loadCallback, undefined); assert.equal(record.actorDataFileId, undefined);
      assert.equal(record.geometry!.ordinaryGeometryAliasRoomId, room.id <= 543 ? room.id - 450 : room.id - 416);
      assert.match(record.reason, /mode-specific scene\/event setup is not decoded/);
    }
  }
  assert.deepEqual([world, aliases, metadata.size, callbacks.size, lists.size, contents.size], [374,9,374,374,374,335]);
  for (const id of [201,299,349,399,549,619,620,799]) assert.throws(() => decoder.inspect(id), /no listed native/);
  assert.equal(hash(db.bytes), before);
});

test("supplied file maps cannot alter resident identities, resource bounds or plain allocations", real, () => {
  for (const change of [
    (files: Map<number, RomFile>) => files.delete(11),
    (files: Map<number, RomFile>) => files.set(12, { ...files.get(12)!, start: 0 }),
    (files: Map<number, RomFile>) => files.set(11, { ...files.get(11)!, end: files.get(11)!.end - 4 }),
    (files: Map<number, RomFile>) => files.set(12, { ...files.get(12)!, compressed: true }),
    (files: Map<number, RomFile>) => files.set(96, { ...files.get(96)!, id: 95 }),
    (files: Map<number, RomFile>) => files.set(96, { ...files.get(96)!, end: database().bytes.length + 1 }),
    (files: Map<number, RomFile>) => files.set(96, Object.assign(Object.create({ foreign: true }), files.get(96))),
  ]) {
    const { decoder, files } = context(); change(files);
    assert.throws(() => decoder.inspect(465), /supplied.*identity|identity\/bounds/);
  }
});

// White-box checks exercise the finite structural parser independently of the
// stronger public checksum gate. This private method is never exported or used
// by the application to admit altered ROM data.
function structure(decoder: NativeRoomInitialization, roomId = 0): RoomInitialization {
  return (decoder as unknown as { inspectStructure(id: number): RoomInitialization }).inspectStructure(roomId);
}
function mutate(write: (reader: RomReader, view: DataView) => void, pattern: RegExp): void {
  const bytes = database().bytes.slice(), { decoder, reader } = context(bytes);
  write(reader, reader.view);
  assert.throws(() => decoder.inspect(0), /checksum/);
  assert.throws(() => structure(decoder), pattern);
}
test("complete nine-instruction wrappers reject modified opcodes/registers/delay/return semantics", real, () => {
  for (let instruction = 0; instruction < 9; instruction++) mutate((reader, view) => {
    const at = 0x5c9310 + instruction * 4; view.setUint32(at, reader.u32(at) ^ (instruction === 4 ? 0x00010000 : 1));
  }, /complete verified nine-instruction/);
  mutate((_r, view) => view.setUint32(0x5c9310 + 16, 0x2484ffff), /dependency pointer/);
  mutate((_r, view) => view.setUint32(0x5c9310 + 16, 0x2484c241), /aligned list arena/);
});
test("metadata registry rejects null/aliased pointers, arena overruns and changed u16 fields", real, () => {
  for (const pointer of [0,0x8022ea14,0x80231300,0x8022ea19]) mutate((_r, view) => view.setUint32(0x5ec7d0, pointer), /metadata registry|inventory changed|arena start/);
  mutate((r, view) => view.setUint32(0x5ec7d0 + 4, r.u32(0x5ec7d0)), /aliased/);
  mutate((_r, view) => view.setUint32(0x5e9ee8 + 24, 0), /callback.*arena/);
  mutate((_r, view) => view.setUint16(0x5e9ee8 + 20, 0xffff), /invalid\/plain-file ID/);
  mutate((_r, view) => view.setUint16(0x5e9ee8 + 22, 1), /reserved halfword/);
  mutate((_r, view) => view.setUint32(0x5c57ec, 0), /group pointer\/index bounds/);
  mutate((_r, view) => view.setUint32(0x5c581c, 0x80205ada), /group pointer\/index bounds/);
  mutate((_r, view) => view.setUint16(0x5c610 + 2, 301), /stage boundary/);
});
test("dependency lists reject next-pointer overruns, last terminators, padding and invalid file IDs", real, () => {
  mutate((_r, view) => view.setUint16(0x5e7710, 0xffff), /invalid\/plain-file ID/);
  mutate((_r, view) => { for (let at = 0x5e7710; at < 0x5e7734; at += 2) view.setUint16(at, 96); }, /no terminator/);
  mutate((_r, view) => view.setUint16(0x5e7710 + 34, 96), /padding is nonzero/);
  mutate((_r, view) => view.setUint16(0x5e9ee8 - 2, 96), /no terminator/);
  mutate((_r, view) => view.setUint16(0x5e7710, 0), /omits.*canonical resources/);
  mutate((_r, view) => view.setUint16(0x587370 + (0x80205ad8 - 0x801cb460), 0xffff), /invalid\/plain-file ID/);
});

test("lazy attachment rechecks mutable bytes after a rendered-room cache hit", real, () => {
  const db = database();
  const internals = db as unknown as { initialization: NativeRoomInitialization };
  const original = internals.initialization.inspect.bind(internals.initialization); let calls = 0;
  internals.initialization.inspect = id => { calls++; return original(id); };
  try {
    const summaries = db.listRooms(); assert.equal(calls, 0); assert(summaries.every(room => !("initialization" in room)));
    const first = db.loadRoom(465); assert.equal(calls, 1); assert.equal(first.initialization!.roomId, 465);
    (first.initialization!.loadCallback!.dependencyList.orderedFileIds as number[])[0] = 999;
    const second = db.loadRoom(465); assert.equal(calls, 2); assert.equal(second.initialization!.loadCallback!.dependencyList.orderedFileIds[0], 96);
    const at = db.bytes.length - 1, old = db.bytes[at];
    try {
      db.bytes[at] ^= 1;
      const invalid = db.loadRoom(465); assert.equal(calls, 3); assert.equal(invalid.initialization, undefined);
      assert(invalid.warnings.some(warning => /initialization inspection unavailable.*checksum/.test(warning)));
    } finally { db.bytes[at] = old; }
    const restored = db.loadRoom(465); assert.equal(restored.initialization!.roomId, 465);
  } finally { internals.initialization.inspect = original; }
});

test("native and authored scenes retain separate native donor initialization without project mutation", real, () => {
  const db = database(), initialization = context().decoder.inspect(465);
  const native: RoomData = { id: 465, name: "Donor", actorCount: 0, eventCount: 0, geometryAvailable: false, actors: [], events: [], meshes: [], warnings: [], source: { romOffset: 0, expectedHex: "" }, initialization };
  const catalog: AuthoringCatalog = { romHash: db.identity.normalizedSha256, actors: [], actorPrototypes: [], geometry: [], materials: [], surfaces: [], nativeEntrances: [], skyboxes: [], roomAdmission: { minId: 620, maxId: 799, supported: true } };
  const lookup: AuthoringLookup = { catalog, nativeRooms: [native], loadRoom(id) { assert.equal(id, 465); return native; }, nativeRoomSkyboxId() { return undefined; }, loadSkyboxAsset() { throw Error("No skybox"); }, resolveMaterial() { throw Error("No material"); }, loadActorPrototype() { throw Error("No actor"); } };
  const project = createProject("Initialization donor", db.identity);
  const baseline = composeProjectRoom(project, 465, lookup); assert.equal(baseline.initialization!.roomId, 465);
  const authored: AuthoredRoom = { id: 620, name: "Clone", kind: "new", templateRoomId: 465, meshes: [], materials: [], collisionMode: "template", collision: [], actors: [], doors: [], entrances: [{ id: "spawn", name: "Start", position: { x: 0, y: 0, z: 0 }, baseYaw: 0, entryParameter: 16 }] };
  project.authoredRooms["620"] = authored; const before = JSON.stringify(project);
  const clone = composeProjectRoom(project, 620, lookup); assert.equal(clone.id, 620); assert.equal(clone.initialization!.roomId, 465); assert.deepEqual(clone.initialization, initialization);
  (clone.initialization!.loadCallback!.dependencyList.orderedFileIds as number[])[0] = 999;
  assert.equal(initialization.loadCallback!.dependencyList.orderedFileIds[0], 96); assert.equal(JSON.stringify(project), before);
  project.authoredRooms = { "465": { ...authored, id: 465, kind: "replacement" } };
  assert.equal(composeProjectRoom(project, 465, lookup).initialization!.roomId, 465);
});

test("a first-load inspection failure refreshes one warning and removes it after source restoration", real, () => {
  const db = importRomBytes(readFileSync(process.env.MNSG_TEST_ROM!));
  const at = db.bytes.length - 1, original = db.bytes[at];
  try {
    db.bytes[at] ^= 1;
    const first = db.loadRoom(306);
    assert.equal(first.initialization, undefined);
    assert.equal(first.warnings.filter(warning => warning.startsWith("Room initialization inspection unavailable:")).length, 1);
    const retry = db.loadRoom(306);
    assert.equal(retry.initialization, undefined);
    assert.equal(retry.warnings.filter(warning => warning.startsWith("Room initialization inspection unavailable:")).length, 1);
  } finally { db.bytes[at] = original; }
  const restored = db.loadRoom(306);
  assert.equal(restored.initialization!.roomId, 306);
  assert.equal(restored.warnings.some(warning => warning.startsWith("Room initialization inspection unavailable:")), false);
});
