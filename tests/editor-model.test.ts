import assert from "node:assert/strict";
import test from "node:test";
import type { ActorData, EditorProject, RoomData } from "../shared/types";
import { applyOverrides, checkedActorPosition, checkedGeometryTranslation, countProjectChanges, effectiveGeometryTranslation, parseInteger, parseWords, withGeometryOverride } from "../components/editorModel";

const actor: ActorData = {
  id: "test:actor", index: 0, actorId: 0x23c, name: "Test actor", position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, parameters: [0, 0, 0x00020000],
  source: { romOffset: 100, expectedHex: "00".repeat(20) }, definitionSource: { romOffset: 200, expectedHex: "00".repeat(16) }, editable: true,
};
const room: RoomData = { id: 1, name: "Test record", actorCount: 1, eventCount: 0, geometryAvailable: false, warnings: [], actors: [actor], events: [], meshes: [], source: actor.source };
const project: EditorProject = { format: "mnsg-level-project", version: 1, id: "test", name: "Test", createdAt: "", updatedAt: "", rom: { sha256: "", normalizedSha256: "", title: "", gameCode: "", region: "US", byteLength: 0, decompressed: true }, roomOverrides: {} };

test("integer input rejects coercion and unsigned overflow while accepting boundary values", () => {
  assert.equal(parseInteger("0xFFFF", 0, 65535), 65535);
  assert.equal(parseInteger("-32768", -32768, 32767), -32768);
  for (const input of ["", "1.5", "1e3", "Infinity", "65536"]) assert.throws(() => parseInteger(input, 0, 65535));
  assert.deepEqual(parseWords("0, 0xFFFFFFFF, 42", 3), [0, 4294967295, 42]);
  assert.throws(() => parseWords("0, 42", 3));
  assert.throws(() => parseWords("0, 4294967296, 42", 3));
});

test("derived native event views follow edited actor placement and behavior payload", () => {
  const edited = { ...project, roomOverrides: { "1": { actors: { [actor.id]: { position: { x: 20, y: 30, z: 40 }, parameters: [0, 0, 0x00070000] } }, events: {} } } };
  const view = applyOverrides(room, edited);
  assert.deepEqual(view.events[0].position, { x: 20, y: 30, z: 40 });
  assert.match(view.events[0].name, /selector 0x7/);
  assert.doesNotMatch(view.events[0].name, /room 0x7/, "native selector is not a universal destination room ID");
  assert.equal(view.events[0].actorRef, actor.id);
  assert.equal(view.events[0].editable, false);
  assert.equal(view.actors[0].source, actor.source);
  assert.deepEqual(actor.position, { x: 0, y: 0, z: 0 }, "source data must remain unchanged");
  const retyped = { ...project, roomOverrides: { "1": { actors: { [actor.id]: { actorId: 0x8e } }, events: {} } } };
  assert.equal(applyOverrides(room, retyped).events.length, 0, "a non-event actor type removes its derived event");
});

test("partition movement keeps native spawn-cell membership and signed16 bounds", () => {
  const partitionActor: ActorData = { ...actor, sourceKind: "partition", partition: { origin: { x: 0, y: 0, z: 0 }, cellSize: { x: 100, y: 100, z: 100 }, cellCount: { x: 4, y: 4, z: 4 }, originalCell: { x: 2, y: 2, z: 2 } } };
  assert.deepEqual(checkedActorPosition(partitionActor, { x: 99, y: 20, z: 0 }), { x: 99, y: 20, z: 0 });
  assert.throws(() => checkedActorPosition(partitionActor, { x: 100, y: 0, z: 0 }), /original spawn-grid cell/);
  assert.throws(() => checkedActorPosition({ ...partitionActor, partition: undefined }, { x: 1, y: 0, z: 0 }), /not yet supported/);
  assert.throws(() => checkedActorPosition(actor, { x: 32768, y: 0, z: 0 }));
});

const geometryRoom: RoomData = { ...room, geometryAvailable: true, meshes: [{ id: "test-mesh", positions: [0, 10, 20, 30, 40, 50, 60, 70, 80], indices: [0, 1, 2], source: "display-list" }], geometryEdit: { supported: true, vertexCount: 3, planeCount: 0, cellCount: 0, affectedRoomIds: [1, 2], translationBounds: { min: { x: -10, y: -20, z: -30 }, max: { x: 10, y: 20, z: 30 } } } };

test("room translation preview moves native surfaces once while retaining placement and source data", () => {
  const moved = withGeometryOverride(project, 1, { x: 4, y: -2, z: 6 }, [1, 2]);
  const view = applyOverrides(geometryRoom, moved);
  assert.deepEqual(view.meshes[0].positions, [4, 8, 26, 34, 38, 56, 64, 68, 86]);
  assert.equal(view.meshes[0].indices, geometryRoom.meshes[0].indices);
  assert.deepEqual(view.actors[0].position, actor.position);
  assert.deepEqual(geometryRoom.meshes[0].positions, [0, 10, 20, 30, 40, 50, 60, 70, 80]);
  assert.equal(applyOverrides(geometryRoom, { ...moved, updatedAt: "later" }).meshes, view.meshes, "metadata changes must retain stable geometry resources");
  const alias = { ...geometryRoom, id: 2 };
  assert.deepEqual(effectiveGeometryTranslation(alias, moved), { x: 4, y: -2, z: 6 });
  assert.deepEqual(applyOverrides(alias, moved).meshes[0].positions, view.meshes[0].positions, "complete source aliases receive the same translation once");
  assert.equal(effectiveGeometryTranslation({ ...alias, geometryEdit: { ...alias.geometryEdit!, supported: false } }, moved), null, "unsupported partial aliases must not inherit a full-room preview");
});

test("shared geometry edit and reset preserve actor overrides and remove empty room edits", () => {
  const mixed: EditorProject = { ...project, roomOverrides: { "1": { actors: { [actor.id]: { rotation: { x: 0, y: 10, z: 0 } } }, events: {}, geometry: { translation: { x: 1, y: 0, z: 0 } } }, "2": { actors: {}, events: {}, geometry: { translation: { x: 1, y: 0, z: 0 } } } } };
  const updated = withGeometryOverride(mixed, 2, { x: 2, y: 0, z: 0 }, [1, 2]);
  assert.equal(updated.roomOverrides["1"].geometry, undefined);
  assert.deepEqual(updated.roomOverrides["1"].actors, mixed.roomOverrides["1"].actors);
  assert.equal(countProjectChanges(updated), 2);
  const reset = withGeometryOverride(updated, 2, null, [1, 2]);
  assert.equal(reset.roomOverrides["2"], undefined);
  assert.deepEqual(reset.roomOverrides["1"].actors, mixed.roomOverrides["1"].actors);
  assert.equal(countProjectChanges(reset), 1);
  assert.deepEqual(mixed.roomOverrides["1"].geometry?.translation, { x: 1, y: 0, z: 0 }, "undo snapshots remain unchanged");
  assert.equal(Object.keys(withGeometryOverride(project, 1, { x: 0, y: 0, z: 0 }).roomOverrides).length, 0);
});

test("geometry translation validates each native axis bound and verified eligibility", () => {
  assert.deepEqual(checkedGeometryTranslation(geometryRoom, { x: 10, y: -20, z: 30 }), { x: 10, y: -20, z: 30 });
  assert.throws(() => checkedGeometryTranslation(geometryRoom, { x: 11, y: 0, z: 0 }));
  assert.throws(() => checkedGeometryTranslation(geometryRoom, { x: 1.5, y: 0, z: 0 }));
  assert.throws(() => checkedGeometryTranslation(room, { x: 1, y: 0, z: 0 }), /not verified/);
});
