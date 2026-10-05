import test from "node:test";
import assert from "node:assert/strict";
import { emptyRoom } from "../components/authoringModel";
import { sampleRoom } from "../components/editorModel";
import {
  createDocumentHistory,
  transactDocument,
  undoDocument,
  redoDocument,
} from "../components/authoringState";
import {
  selectItems,
  selectedGeometryVertices,
  selectionCenter,
  selectionExists,
  selectionMovable,
  translateProjectSelection,
  type EditorSelection,
} from "../components/editorSelection";
import type {
  AuthoredRoom,
  EditorProjectV2,
  ProjectRoomScene,
  RoomData,
} from "../shared/types";
const face = (index: number): EditorSelection => ({
  kind: "geometry",
  choice: { meshId: "mesh", mode: "face", faceIndex: index },
});
const record = (id: string): EditorSelection => ({ kind: "record", id });
function fixture() {
  const room: AuthoredRoom = emptyRoom(620, "Group", 0);
  const vertex = (x: number, y: number) => ({
    position: { x, y, z: 0 },
    uv: [x, y] as [number, number],
    color: [1, 2, 3, 255] as [number, number, number, number],
  });
  room.materials = [{ id: "material", sourceMaterialId: "native" }];
  room.meshes = [
    {
      id: "mesh",
      materialId: "material",
      sourceAssetId: "source",
      vertices: [
        vertex(0, 0),
        vertex(20, 0),
        vertex(0, 20),
        vertex(20, 20),
        vertex(100, 100),
      ],
      indices: [0, 1, 2, 1, 3, 2],
    },
  ];
  room.actors = [
    {
      id: "actor",
      prototypeId: "prototype",
      parameters: [0, 0, 0],
      position: { x: 12, y: 3, z: 9 },
      rotation: { x: 0, y: 0, z: 0 },
    },
  ];
  const scene: ProjectRoomScene = {
    ...sampleRoom,
    id: room.id,
    kind: "new",
    actors: room.actors.map((a, index) => ({
      ...a,
      index,
      actorId: 1,
      name: "Actor",
      parameters: [],
      editable: true,
    })),
    events: [],
    authoredMeshes: room.meshes,
    meshes: room.meshes.map((mesh) => ({
      id: mesh.id,
      source: "display-list",
      positions: mesh.vertices.flatMap((v) => [
        v.position.x,
        v.position.y,
        v.position.z,
      ]),
      indices: mesh.indices,
    })),
    collisionMode: room.collisionMode,
    collision: room.collision,
    doors: room.doors,
    entrances: room.entrances,
  };
  const project = {
    format: "mnsg-level-project",
    version: 2,
    id: "project",
    name: "Group",
    createdAt: "time",
    updatedAt: "time",
    rom: { normalizedSha256: "a".repeat(64) },
    roomOverrides: {},
    authoredRooms: { [room.id]: room },
  } as unknown as EditorProjectV2;
  return { room, scene, project };
}
test("modifier selection toggles exact faces and vertices; mesh selection supersedes its sub-elements", () => {
  let selected = selectItems([], face(0));
  selected = selectItems(selected, face(1), true);
  assert.equal(selected.length, 2);
  assert.equal(selectItems(selected, face(0), true).length, 1);
  const mesh: EditorSelection = {
    kind: "geometry",
    choice: { meshId: "mesh", mode: "mesh" },
  };
  assert.deepEqual(selectItems(selected, mesh, true), [mesh]);
  assert.deepEqual(selectItems([mesh], face(1), true), [face(1)]);
  assert.deepEqual(selectItems(selected, record("actor")), [record("actor")]);
  assert.equal(selectItems(selected, null, true), selected);
  assert.deepEqual(selectItems(selected, null), []);
});
test("adjacent selected faces translate shared vertices once and retain all other mesh data", () => {
  const { project, scene, room } = fixture(),
    before = JSON.stringify(project);
  assert.deepEqual(
    [
      ...selectedGeometryVertices(scene, [face(0), face(1)]).get("mesh")!,
    ].sort(),
    [0, 1, 2, 3],
  );
  const next = translateProjectSelection(
    project,
    scene,
    [face(0), face(1)],
    { x: 7, y: -2, z: 4 },
    false,
  ) as EditorProjectV2;
  const mesh = next.authoredRooms[620].meshes[0];
  for (let i = 0; i < 4; i++)
    assert.deepEqual(mesh.vertices[i].position, {
      x: room.meshes[0].vertices[i].position.x + 7,
      y: room.meshes[0].vertices[i].position.y - 2,
      z: 4,
    });
  assert.equal(mesh.vertices[4], room.meshes[0].vertices[4]);
  assert.deepEqual(mesh.indices, room.meshes[0].indices);
  assert.deepEqual(mesh.vertices[1].uv, room.meshes[0].vertices[1].uv);
  assert.deepEqual(mesh.vertices[1].color, room.meshes[0].vertices[1].color);
  assert.equal(mesh.materialId, "material");
  assert.equal(mesh.sourceAssetId, "source");
  assert.equal(JSON.stringify(project), before);
});
test("mixed geometry, actor and entrance translation is one undoable transaction", () => {
  const { project, scene, room } = fixture();
  const choices: EditorSelection[] = [
    face(0),
    face(1),
    record("actor"),
    record(`entrance:${room.entrances[0].id}`),
  ];
  const next = translateProjectSelection(
    project,
    scene,
    choices,
    { x: 4, y: 2, z: 8 },
    true,
  ) as EditorProjectV2;
  assert.deepEqual(next.authoredRooms[620].actors[0].position, {
    x: 16,
    y: 5,
    z: 17,
  });
  assert.deepEqual(next.authoredRooms[620].entrances[0].position, {
    x: 4,
    y: 2,
    z: 8,
  });
  assert.equal(next.authoredRooms[620].collision.length, 2);
  assert.deepEqual(
    next.authoredRooms[620].collision[1].vertices[0],
    next.authoredRooms[620].meshes[0].vertices[1].position,
  );
  const history = transactDocument(createDocumentHistory(project), next);
  assert.equal(history.past.length, 1);
  assert.deepEqual(undoDocument(history).present, project);
  assert.deepEqual(redoDocument(undoDocument(history)).present, next);
});
test("multiple vertices leave incident topology intact, bound the pivot and reject invalid indices", () => {
  const { scene, project } = fixture();
  const choices: EditorSelection[] = [
    {
      kind: "geometry",
      choice: { meshId: "mesh", mode: "vertex", vertexIndex: 0 },
    },
    {
      kind: "geometry",
      choice: { meshId: "mesh", mode: "vertex", vertexIndex: 3 },
    },
  ];
  assert.deepEqual(selectionCenter(scene, choices), { x: 10, y: 10, z: 0 });
  const next = translateProjectSelection(
    project,
    scene,
    choices,
    { x: 0, y: 0, z: 8 },
    false,
  ) as EditorProjectV2;
  assert.equal(next.authoredRooms[620].meshes[0].vertices[1].position.z, 0);
  assert.equal(next.authoredRooms[620].meshes[0].vertices[3].position.z, 8);
  assert.equal(selectionExists(scene, face(99)), false);
  assert.throws(
    () =>
      translateProjectSelection(
        project,
        scene,
        [face(99)],
        { x: 1, y: 0, z: 0 },
        false,
      ),
    /read-only/,
  );
});
test("native actor and actor-derived event aliases move once and retain previous overrides", () => {
  const { project } = fixture();
  project.authoredRooms = {};
  const actor = { ...sampleRoom.actors[0], id: "actor", editable: true };
  const scene: RoomData = {
    ...sampleRoom,
    actors: [actor],
    events: [
      {
        ...sampleRoom.events[0],
        id: "alias",
        actorRef: actor.id,
        editable: true,
        position: actor.position,
      },
    ],
  };
  project.roomOverrides[0] = {
    actors: { actor: { parameters: [8, 9] } },
    events: {},
  };
  const next = translateProjectSelection(
    project,
    scene,
    [record("actor"), record("alias")],
    { x: 2, y: 0, z: 0 },
    false,
  );
  assert.deepEqual(next.roomOverrides[0].actors.actor.position, {
    ...actor.position,
    x: actor.position.x + 2,
  });
  assert.deepEqual(next.roomOverrides[0].actors.actor.parameters, [8, 9]);
  assert.deepEqual(next.roomOverrides[0].events, {});
});
test("range, partition and read-only failures reject the entire group without partial edits", () => {
  const { project, scene } = fixture(),
    before = JSON.stringify(project);
  assert.throws(
    () =>
      translateProjectSelection(
        project,
        scene,
        [face(0), record("actor")],
        { x: 32767, y: 0, z: 0 },
        false,
      ),
    /between/,
  );
  assert.equal(JSON.stringify(project), before);
  const native: RoomData = {
    ...sampleRoom,
    actors: [
      { ...sampleRoom.actors[0], editable: true },
      {
        ...sampleRoom.actors[1],
        editable: true,
        sourceKind: "partition",
        partition: {
          origin: { x: 140, y: 60, z: -180 },
          cellSize: { x: 10, y: 10, z: 10 },
          cellCount: { x: 1, y: 1, z: 1 },
          originalCell: { x: 0, y: 0, z: 0 },
        },
      },
    ],
  };
  assert.throws(
    () =>
      translateProjectSelection(
        project,
        native,
        native.actors.map((actor) => record(actor.id)),
        { x: 40, y: 0, z: 0 },
        false,
      ),
    /original spawn-grid/,
  );
  native.actors[1].editable = false;
  assert.equal(
    selectionMovable(
      native,
      native.actors.map((actor) => record(actor.id)),
    ),
    false,
  );
  assert.throws(
    () =>
      translateProjectSelection(
        project,
        native,
        native.actors.map((actor) => record(actor.id)),
        { x: 1, y: 0, z: 0 },
        false,
      ),
    /read-only/,
  );
  assert.equal(JSON.stringify(project), before);
});
test("group authored edits retain other room overrides and template collision stays unchanged", () => {
  const { project, scene, room } = fixture();
  room.collisionMode = "template";
  room.collisionTranslation = { x: 3, y: 0, z: 0 };
  project.roomOverrides[620] = {
    actors: {},
    events: { untouched: { values: [7] } },
  };
  const next = translateProjectSelection(
    project,
    scene,
    [face(0), face(1)],
    { x: 1, y: 0, z: 0 },
    true,
  ) as EditorProjectV2;
  assert.deepEqual(next.roomOverrides, project.roomOverrides);
  assert.equal(next.authoredRooms[620].collision, room.collision);
  assert.deepEqual(
    next.authoredRooms[620].collisionTranslation,
    room.collisionTranslation,
  );
});
