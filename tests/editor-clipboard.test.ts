import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { copyGeometry, pasteEntity } from "../components/editorClipboard";
import { emptyRoom } from "../components/authoringModel";
import { selectionSegments } from "../components/selectionOutline";
import type { AuthoredRoom } from "../shared/types";
const vertex = (x: number, y: number) => ({
  position: { x, y, z: 0 },
  uv: [x / 20, y / 20] as [number, number],
  color: [1, 2, 3, 255] as [number, number, number, number],
});
function fixture(): AuthoredRoom {
  const room = emptyRoom(620, "Test", 0);
  room.materials = [{ id: "local", sourceMaterialId: "native" }];
  room.meshes = [
    {
      id: "mesh",
      materialId: "local",
      sourceAssetId: "original",
      vertices: [vertex(0, 0), vertex(20, 0), vertex(0, 20)],
      indices: [0, 1, 2],
    },
  ];
  room.collision = [
    {
      id: "collision",
      sourceMeshId: "mesh",
      classifier: 1,
      surface: 7,
      vertices: room.meshes[0].vertices.map((v) => ({ ...v.position })) as [
        { x: number; y: number; z: number },
        { x: number; y: number; z: number },
        { x: number; y: number; z: number },
      ],
    },
  ];
  return room;
}
test("mesh clipboard snapshots attributes and remaps linked collision on every paste", () => {
  const room = fixture(),
    clip = copyGeometry(room, { meshId: "mesh", mode: "mesh" }, "rom");
  room.meshes[0].vertices[0].color[0] = 99;
  const first = pasteEntity(room, clip, null, false),
    second = pasteEntity(first.room, clip, null, false);
  const mesh = first.room.meshes.at(-1)!;
  assert.equal(mesh.vertices[0].color[0], 1);
  assert.equal(mesh.sourceAssetId, "original");
  assert.equal(mesh.materialId, "local");
  assert.equal(first.room.collision.at(-1)!.sourceMeshId, mesh.id);
  assert.equal(first.room.collision.at(-1)!.surface, 7);
  assert.notEqual(first.room.collision.at(-1)!.id, room.collision[0].id);
  assert.notEqual(second.selected, first.selected);
  assert.equal(second.room.materials.length, 1);
});
test("cross-room paste recreates the material and never attaches collision to donor BSP", () => {
  const clip = copyGeometry(fixture(), { meshId: "mesh", mode: "mesh" }, "rom"),
    target = emptyRoom(1, "Replacement", 1, "replacement");
  const result = pasteEntity(target, clip, null, true);
  assert.equal(result.room.collision.length, 0);
  assert.equal(result.room.materials[0].sourceMaterialId, "native");
  assert.equal(result.room.meshes[0].materialId, result.room.materials[0].id);
});
test("face paste appends private vertices with UV/RGBA and follows linked collision", () => {
  const room = fixture(),
    clip = copyGeometry(
      room,
      { meshId: "mesh", mode: "face", faceIndex: 0 },
      "rom",
    );
  const result = pasteEntity(
    room,
    clip,
    { meshId: "mesh", mode: "mesh" },
    true,
  );
  assert.deepEqual(result.room.meshes[0].indices, [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(
    result.room.meshes[0].vertices[4],
    room.meshes[0].vertices[1],
  );
  assert.equal(result.room.collision.length, 2);
  assert.deepEqual(result.geometry, {
    meshId: "mesh",
    mode: "face",
    faceIndex: 1,
  });
});
test("face paste into a different material creates a triangle mesh preserving the copied material", () => {
  const room = fixture(),
    clip = copyGeometry(
      room,
      { meshId: "mesh", mode: "face", faceIndex: 0 },
      "rom",
    );
  room.materials.push({ id: "other", sourceMaterialId: "other-native" });
  room.meshes[0].materialId = "other";
  const result = pasteEntity(
    room,
    clip,
    { meshId: "mesh", mode: "mesh" },
    false,
  );
  assert.equal(result.room.meshes.length, 2);
  assert.equal(result.room.meshes[0].indices.length, 3);
  assert.equal(result.room.meshes[1].materialId, "local");
});
test("vertex paste retains attributes and requires a destination mesh", () => {
  const room = fixture(),
    clip = copyGeometry(
      room,
      { meshId: "mesh", mode: "vertex", vertexIndex: 1 },
      "rom",
    );
  assert.throws(() => pasteEntity(room, clip, null, false), /destination mesh/);
  const result = pasteEntity(
    room,
    clip,
    { meshId: "mesh", mode: "mesh" },
    true,
  );
  assert.deepEqual(
    result.room.meshes[0].vertices.at(-1),
    room.meshes[0].vertices[1],
  );
  assert.equal(result.room.meshes[0].indices.length, 3);
  assert.deepEqual(result.geometry, {
    meshId: "mesh",
    mode: "vertex",
    vertexIndex: 3,
  });
});
test("actor, door and entrance copies preserve native fields and independent IDs", () => {
  const room = fixture();
  const actor = {
    id: "old",
    prototypeId: "trusted",
    parameters: [0, 0xffffffff, 3] as [number, number, number],
    position: { x: 0, y: 1, z: 2 },
    rotation: { x: 3, y: 4, z: 5 },
    spawnPolicy: "proximity" as const,
  };
  const a = pasteEntity(
    room,
    { kind: "actor", actor, romHash: "rom" },
    null,
    false,
  );
  assert.notEqual(a.selected, actor.id);
  assert.deepEqual(a.room.actors[0].parameters, actor.parameters);
  assert.equal(a.room.actors[0].spawnPolicy, "proximity");
  const door = {
    id: "door",
    position: actor.position,
    rotation: actor.rotation,
    dimensions: { x: 1, y: 2, z: 3 },
    activation: "touch" as const,
    destination: { roomId: 620, entranceId: room.entrances[0].id },
  };
  const d = pasteEntity(
    room,
    { kind: "door", door, romHash: "rom" },
    null,
    false,
  );
  assert.deepEqual(d.room.doors[0].destination, door.destination);
  assert.notEqual(d.room.doors[0].id, door.id);
  const e = pasteEntity(
    room,
    { kind: "entrance", entrance: room.entrances[0], romHash: "rom" },
    null,
    false,
  );
  assert.equal(e.room.entrances.length, 2);
  assert.notEqual(e.room.entrances[1].id, e.room.entrances[0].id);
});
test("face outline uses only its triangle, mesh outline covers topology and vertex outline uses a point", () => {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(
      [0, 0, 0, 20, 0, 0, 0, 20, 0, 20, 20, 0],
      3,
    ),
  );
  geometry.setIndex([0, 1, 2, 1, 3, 2]);
  assert.equal(
    selectionSegments(geometry, { meshId: "test", mode: "mesh" }).length,
    30,
  );
  const face = selectionSegments(geometry, {
    meshId: "test",
    mode: "face",
    faceIndex: 1,
  });
  assert.equal(face.length, 18);
  assert(face.includes(20));
  assert(!face.slice(0, 3).every((v) => v === 0));
  assert.deepEqual(
    selectionSegments(geometry, {
      meshId: "test",
      mode: "vertex",
      vertexIndex: 0,
    }),
    [],
  );
  assert.deepEqual(
    selectionSegments(geometry, {
      meshId: "test",
      mode: "face",
      faceIndex: 10,
    }),
    [],
  );
});
