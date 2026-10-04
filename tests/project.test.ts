import test from "node:test";
import assert from "node:assert/strict";
import type { RomIdentity, RoomData } from "../shared/types";
import { createProject, validateProject } from "../core/project";
import { nativePartitionCell } from "../core/rom/partition";
import type { GeometryTranslation } from "../core/rom/translation";

const rom: RomIdentity = { sha256: "a".repeat(64), normalizedSha256: "b".repeat(64), title: "MYSTICAL NINJA", gameCode: "NG5E", region: "US", byteLength: 33554432, decompressed: true };
const room: RoomData = { id: 0, name: "Room", actorCount: 1, eventCount: 0, geometryAvailable: false, warnings: [], meshes: [], events: [], source: { romOffset: 100, expectedHex: "00" },
  actors: [{ id: "actor:100", index: 0, actorId: 139, name: "Sign", position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, parameters: [0, 1, 2], sourceKind: "normal",
    source: { romOffset: 256, expectedHex: "00".repeat(20), fileId: 12 }, definitionSource: { romOffset: 512, expectedHex: "00".repeat(16), fileId: 12 }, editable: true }] };
const project = () => { const p = createProject("Test", rom); p.roomOverrides["0"] = { actors: { "actor:100": { position: { x: -32768, y: 32767, z: 4 }, rotation: { x: 0, y: -32768, z: 0 }, parameters: [0, 0xffffffff, 1] } }, events: {} }; return p; };
test("project accepts native widths and returns independent canonical data", () => {
  const input = project(), validated = validateProject(input, rom, () => room);
  assert.deepEqual(validated, input);
  input.roomOverrides["0"].actors["actor:100"].position!.x = 99;
  assert.equal(validated.roomOverrides["0"].actors["actor:100"].position!.x, -32768);
});
test("project rejects stale identity, absent placements and resource-unsafe substitutions", () => {
  const p = project(); p.rom.normalizedSha256 = "c".repeat(64);
  assert.throws(() => validateProject(p, rom, () => room), /checksum/);
  const bad = project(); bad.roomOverrides["0"].actors["untrusted"] = {};
  assert.throws(() => validateProject(bad, rom, () => room), /absent/);
  const substitution = project(); substitution.roomOverrides["0"].actors["actor:100"].actorId = 99;
  assert.throws(() => validateProject(substitution, rom, () => room), /resource roster/);
});
test("project rejects nonnative scalar values and injected pointers", () => {
  const p = project(); p.roomOverrides["0"].actors["actor:100"].position!.x = 32768;
  assert.throws(() => validateProject(p, rom, () => room), /integer/);
  const polluted = JSON.parse(JSON.stringify(project()).replace('"roomOverrides":{', '"roomOverrides":{"__proto__":{},'));
  assert.throws(() => validateProject(polluted, rom, () => room), /canonical/);
  const injected = JSON.parse(JSON.stringify(project())); injected.roomOverrides["0"].actors["actor:100"].source = {romOffset:0};
  assert.throws(() => validateProject(injected, rom, () => room), /unsupported field/);
});
test("project rejects conflicting aliases, unverified events and partition movement", () => {
  const p = project(); p.roomOverrides["1"] = { actors: { "actor:100": { position: { x: 1, y: 2, z: 3 } } }, events: {} };
  assert.throws(() => validateProject(p, rom, () => room), /contradictory/);
  const events = project(); events.roomOverrides["0"].events.bad = {values:[1]};
  assert.throws(() => validateProject(events, rom, () => room), /read-only/);
  assert.throws(() => validateProject(project(), rom, () => ({ ...room, actors: room.actors.map(actor => ({ ...actor, sourceKind: "partition" })) })), /spawn-grid configuration/);
});

test("partition movement follows native truncation including asymmetric zero cell", () => {
  const partitionRoom: RoomData = {...room,actors:room.actors.map(actor=>({...actor,sourceKind:"partition",partition:{origin:{x:0,y:0,z:0},cellSize:{x:10,y:10,z:10},cellCount:{x:0,y:0,z:0},originalCell:{x:0,y:0,z:0}}}))};
  const p = project(); p.roomOverrides["0"].actors["actor:100"].position = {x:-9,y:9,z:0};
  validateProject(p,rom,()=>partitionRoom);
  p.roomOverrides["0"].actors["actor:100"].position!.x = -10;
  assert.throws(()=>validateProject(p,rom,()=>partitionRoom),/across native spawn-grid cells/);
});
test("partition arithmetic rounds to F32 at native operation boundaries", () => {
  assert.equal(nativePartitionCell(0, Math.fround(1e-8), 1, 2), 1);
  assert.equal(Math.trunc((0 - Math.fround(1e-8)) / 1 + 2 / 2), 0);
});

const geometryProject=()=>{const p=createProject("Geometry",rom);p.roomOverrides["0"]={actors:{},events:{},geometry:{translation:{x:1,y:2,z:3}}};return p;};
const translationLookup=(roomId:number,t:{x:number;y:number;z:number}):GeometryTranslation=>{
  const data=Buffer.alloc(6);data.writeInt16BE(t.x);data.writeInt16BE(t.y,2);data.writeInt16BE(t.z,4);
  return {roomId,affectedRoomIds:[0,1],guards:[{kind:"displayCommand",fileId:1,segmentedAddress:0x08000200,romOffset:2000,expectedHex:"00".repeat(8)}],
    spans:[{kind:"vertexXYZ",fileId:1,segmentedAddress:0x08000100,romOffset:1000,originalHex:"00".repeat(6),replacementHex:data.toString("hex")}]};
};
test("project geometry requires verified backend translation and drops zero edits",()=>{
  const p=geometryProject();assert.throws(()=>validateProject(p,rom,()=>room),/verified native translation/);
  assert.deepEqual(validateProject(p,rom,()=>room,translationLookup),p);
  p.roomOverrides["0"].geometry!.translation={x:0,y:0,z:0};
  assert.equal(validateProject(p,rom,()=>room).roomOverrides["0"].geometry,undefined);
});
test("project rejects contradictory geometry aliases and geometry/actor byte overlap",()=>{
  const p=geometryProject();p.roomOverrides["1"]={actors:{},events:{},geometry:{translation:{x:2,y:2,z:3}}};
  assert.throws(()=>validateProject(p,rom,()=>room,translationLookup),/contradictory/);
  p.roomOverrides["1"].geometry!.translation={x:1,y:2,z:3};validateProject(p,rom,()=>room,translationLookup);
  const actor=geometryProject();actor.roomOverrides["0"].actors["actor:100"]={position:{x:9,y:9,z:9}};
  assert.throws(()=>validateProject(actor,rom,()=>room,(id,t)=>({...translationLookup(id,t),spans:translationLookup(id,t).spans.map(span=>({...span,romOffset:256}))})),/contradictory/);
});
test("project protects read-only geometry guards and rejects injected span fields",()=>{
  const p=geometryProject();p.roomOverrides["0"].actors["actor:100"]={position:{x:9,y:9,z:9}};
  assert.throws(()=>validateProject(p,rom,()=>room,(id,t)=>({...translationLookup(id,t),guards:[{kind:"planeNormal",fileId:1,segmentedAddress:0x08000100,romOffset:256,expectedHex:"00".repeat(12)}]})),/guards conflict/);
  const injected=JSON.parse(JSON.stringify(geometryProject()));injected.roomOverrides["0"].geometry.spans=[];
  assert.throws(()=>validateProject(injected,rom,()=>room,translationLookup),/unsupported field/);
  assert.throws(()=>validateProject(geometryProject(),rom,()=>room,(id,t)=>({...translationLookup(id,t),spans:translationLookup(id,t).spans.map(span=>({...span,replacementHex:"00"}))})),/allowlisted native width/);
});
