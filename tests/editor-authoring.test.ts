import assert from "node:assert/strict";
import test from "node:test";
import {
  addFace,
  addVertex,
  createDocumentHistory,
  documentFingerprint,
  editFace,
  editVertex,
  markDocumentSaved,
  meshCenter,
  nativeVertexPosition,
  redoDocument,
  removeFace,
  removeVertex,
  transactDocument,
  transformMesh,
  undoDocument,
  type EditableVertex,
} from "../components/authoringState";

const vertex = (x: number, y: number, z: number): EditableVertex => ({
  position: { x, y, z },
  uv: [0, 0],
  color: [255, 255, 255, 255],
});
const mesh = {
  id: "mesh-1",
  materialId: "native-material",
  sourceAssetId: "source-1",
  vertices: [
    vertex(0, 0, 0),
    vertex(10, 0, 0),
    vertex(0, 10, 0),
    vertex(10, 10, 0),
  ],
  indices: [0, 1, 2, 1, 3, 2],
};

test("geometry edits preserve source/material/UV/color and leave undo snapshots immutable", () => {
  const source = JSON.stringify(mesh);
  const moved = editVertex(mesh, 0, { x: -2, y: 0, z: 0 });
  assert.equal(moved.materialId, mesh.materialId);
  assert.equal(moved.sourceAssetId, mesh.sourceAssetId);
  assert.deepEqual(moved.vertices[0].uv, [0, 0]);
  assert.deepEqual(moved.vertices[0].color, [255, 255, 255, 255]);
  assert.deepEqual(moved.vertices[0].position, { x: -2, y: 0, z: 0 });
  const changed = editFace(moved, 1, [0, 3, 2]);
  assert.deepEqual(changed.indices, [0, 1, 2, 0, 3, 2]);
  assert.equal(JSON.stringify(mesh), source);
  assert.deepEqual(
    editVertex(mesh, 0, { x: 0, y: 10, z: 0 }).vertices[0].position,
    { x: 0, y: 10, z: 0 },
    "visual topology may contain coincident vertices while authoring",
  );
  assert.throws(() => editFace(mesh, 0, [0, 1, 1]), /different/);
  assert.throws(() => editFace(mesh, 0, [0, 1, 99]), /exists/);
});

test("vertex removal deletes incident faces and remaps remaining topology without losing attributes", () => {
  const removed = removeVertex(mesh, 0);
  assert.deepEqual(removed.indices, [0, 2, 1]);
  assert.equal(removed.vertices.length, 3);
  assert.deepEqual(removed.vertices[0], mesh.vertices[1]);
  assert.equal(removed.materialId, mesh.materialId);
  const added = addVertex(removed, vertex(0, 0, 5));
  assert.equal(added.vertices.length, 4);
  assert.deepEqual(addFace(added, [0, 1, 3]).indices, [0, 2, 1, 0, 1, 3]);
  assert.deepEqual(removeFace(mesh, 1).indices, [0, 1, 2]);
  assert.throws(() => removeVertex(mesh, -1));
  assert.throws(() => removeFace(mesh, 2));
});

test("baked mesh translate/rotate/scale obey native coordinates and preserve winding when mirrored", () => {
  assert.deepEqual(meshCenter(mesh), { x: 5, y: 5, z: 0 });
  const moved = transformMesh(mesh, { translation: { x: 3, y: -4, z: 5 } });
  assert.deepEqual(moved.vertices[0].position, { x: 3, y: -4, z: 5 });
  const rotated = transformMesh(mesh, {
    rotationDegrees: { x: 0, y: 0, z: 90 },
  });
  assert.deepEqual(rotated.vertices[0].position, { x: 10, y: 0, z: 0 });
  const scaled = transformMesh(mesh, { scale: { x: 2, y: 2, z: 1 } });
  assert.deepEqual(scaled.vertices[0].position, { x: -5, y: -5, z: 0 });
  assert.deepEqual(
    transformMesh(mesh, { scale: { x: -1, y: 1, z: 1 } }).indices,
    [0, 2, 1, 1, 2, 3],
  );
  assert.throws(
    () => transformMesh(mesh, { scale: { x: 0, y: 1, z: 1 } }),
    /zero/,
  );
  assert.throws(
    () => transformMesh(mesh, { translation: { x: 32767, y: 0, z: 0 } }),
    /32767/,
  );
  assert.throws(
    () => transformMesh(mesh, { scale: { x: 0.01, y: 0.01, z: 1 } }),
    /collapsed/,
  );
  assert.throws(() => nativeVertexPosition({ x: 1.5, y: 0, z: 0 }));
  assert.deepEqual(nativeVertexPosition({ x: -32768, y: 32767, z: 0 }), {
    x: -32768,
    y: 32767,
    z: 0,
  });
});

test("one document history includes all authored content and native overrides through save/undo/redo", () => {
  const initial = {
    name: "Project",
    updatedAt: "first",
    roomOverrides: { "0": { actors: { source: { parameters: [1, 2, 3] } } } },
    authoredRooms: {} as Record<string, unknown>,
  };
  const first = {
    ...initial,
    authoredRooms: {
      "620": {
        name: "New room",
        meshes: [mesh],
        actors: [
          { id: "added", prototypeId: "npc", position: { x: 1, y: 2, z: 3 } },
        ],
        doors: [{ destination: { roomId: 0, entranceId: 0 } }],
        entrances: [{ id: 0, name: "Entry" }],
        skyboxId: "native-sky",
      },
    },
  };
  let history = transactDocument(createDocumentHistory(initial), first);
  assert.notEqual(
    documentFingerprint(history.present),
    history.savedFingerprint,
  );
  history = markDocumentSaved(history);
  const savedFingerprint = history.savedFingerprint;
  const second = {
    ...first,
    authoredRooms: {
      "620": { ...first.authoredRooms["620"], skyboxId: "another-native-sky" },
    },
  };
  history = transactDocument(history, second);
  assert.notEqual(documentFingerprint(history.present), savedFingerprint);
  history = undoDocument(history);
  assert.equal(documentFingerprint(history.present), savedFingerprint);
  history = undoDocument(history);
  assert.deepEqual(history.present, initial);
  history = redoDocument(redoDocument(history));
  assert.deepEqual(history.present, second);
  assert.deepEqual(
    history.present.roomOverrides,
    initial.roomOverrides,
    "authoring operations retain native patches",
  );
  assert.equal(
    transactDocument(history, {
      ...history.present,
      updatedAt: "metadata only",
    }),
    history,
  );
  const roundtrip = JSON.parse(JSON.stringify(history.present));
  assert.deepEqual(roundtrip, second);
});

import type {
  AuthoringCatalog,
  GeometryAssetPayload,
  ProjectRoomScene,
  EditorProject,
} from "../shared/types";
import {
  addActor,
  canonicalProject,
  cloneScene,
  emptyRoom,
  insertGeometry,
  replaceMesh,
  updateAuthoredRoom,
} from "../components/authoringModel";
import {
  createNativeSurfaceMaterial,
  linearNativeColors,
  RoomTexturePool,
} from "../components/roomMaterials";
const catalog = {
  actorPrototypes: [
    {
      id: "prototype",
      actorId: 8,
      name: "Native actor",
      parameters: [4, 5, 6],
      unknownHalfword: 0,
      resourceFileIds: [],
      warnings: [],
    },
  ],
  geometry: [{ id: "geometry:trusted", roomIds: [0] }],
  materials: [],
  nativeEntrances: [],
  skyboxes: [],
  roomAdmission: { minId: 620, maxId: 799, supported: true },
} as unknown as AuthoringCatalog;
const nativeAsset: GeometryAssetPayload = {
  id: "geometry:trusted",
  meshes: [
    {
      id: "native-component",
      materialId: "native-material",
      source: "display-list",
      positions: [0, 0, 0, 10, 0, 0, 0, 10, 0],
      indices: [0, 1, 2],
      uvs: [0, 0, 2, 0, 0, 2],
      colors: [1, 0, 0, 0.5, 0, 1, 0, 1, 0, 0, 1, 1],
      colorItemSize: 4,
    },
  ],
  textures: [],
  vertexRefs: [],
  vertexSources: [],
  collision: [],
  warnings: [],
};

test("native library insertion preserves trusted material, tiling and alpha; any verified prototype inserts at native coordinates", () => {
  const room = emptyRoom(620, "Blank", 0);
  assert.equal(room.collisionMode, "authored");
  assert.equal(room.entrances[0].entryParameter, 16);
  const inserted = insertGeometry(room, nativeAsset, { x: 100, y: 40, z: -20 });
  const placed = inserted.meshes[0];
  assert.equal(placed.sourceAssetId, "geometry:trusted");
  assert.equal(inserted.materials[0].sourceMaterialId, "native-material");
  assert.deepEqual(placed.vertices[1].uv, [2, 0]);
  assert.equal(placed.vertices[0].color[3], 128);
  assert.deepEqual(placed.vertices[0].position, { x: 95, y: 40, z: -20 });
  assert.equal(
    inserted.collision.length,
    0,
    "native physics is never inferred from visual triangles",
  );
  const actors = addActor(inserted, catalog.actorPrototypes[0], {
    x: -100,
    y: 30,
    z: 75,
  });
  assert.deepEqual(actors.actors[0].parameters, [4, 5, 6]);
  assert.deepEqual(actors.actors[0].position, { x: -100, y: 30, z: 75 });
  assert.equal(room.meshes.length, 0);
  assert.throws(
    () => insertGeometry(room, nativeAsset, { x: 32767, y: 0, z: 0 }),
    /32767/,
  );
});

test("promotion preserves edited native coordinates/parameters, retires only baked sparse overrides, and uses real asset IDs", () => {
  const scene = {
    id: 0,
    name: "Native",
    kind: "native",
    actors: [
      {
        id: "actor:source",
        index: 0,
        actorId: 8,
        name: "Native actor",
        position: { x: 3, y: 4, z: 5 },
        rotation: { x: 0, y: 17, z: 0 },
        parameters: [10, 20, 30],
        editable: true,
      },
    ],
    meshes: nativeAsset.meshes,
    events: [],
    entrances: [],
    doors: [],
    authoredMeshes: [],
    collision: [],
    collisionMode: "template",
    warnings: [],
    actorCount: 1,
    eventCount: 0,
    geometryAvailable: true,
  } as ProjectRoomScene;
  const promoted = cloneScene(scene, catalog, 0, "Editable", "replacement");
  assert.equal(promoted.collisionMode, "template");
  assert.equal(promoted.meshes[0].sourceAssetId, "geometry:trusted");
  assert.deepEqual(
    promoted.meshes[0].vertices.map((v) => v.position),
    [
      { x: 0, y: 0, z: 0 },
      { x: 10, y: 0, z: 0 },
      { x: 0, y: 10, z: 0 },
    ],
  );
  assert.deepEqual(promoted.actors[0].parameters, [10, 20, 30]);
  const project = {
    version: 1,
    roomOverrides: {
      "0": {
        actors: { "actor:source": { position: { x: 3, y: 4, z: 5 } } },
        events: {},
      },
      "1": { actors: { keep: { parameters: [1, 2, 3] } }, events: {} },
    },
  } as unknown as EditorProject;
  const next = updateAuthoredRoom(project, promoted);
  assert.equal(next.version, 2);
  assert.equal(next.roomOverrides["0"], undefined);
  assert.deepEqual(next.roomOverrides["1"], project.roomOverrides["1"]);
  assert.ok(project.roomOverrides["0"]);
  assert.equal(canonicalProject(project).version, 2);
});

test("linked collision updates explicitly with classifier1 and rejects degenerate physics while visual edits remain valid", () => {
  const room = insertGeometry(emptyRoom(620, "Blank", 0), nativeAsset, {
    x: 5,
    y: 0,
    z: 0,
  });
  const mesh = room.meshes[0];
  const collision = replaceMesh(room, mesh, true);
  assert.equal(collision.collisionMode, "authored");
  assert.equal(collision.collision[0].classifier, 1);
  assert.equal(collision.collision[0].sourceMeshId, mesh.id);
  const moved = editVertex(mesh, 1, { x: 20, y: 0, z: 0 });
  const changed = replaceMesh(collision, moved, true);
  assert.deepEqual(changed.collision[0].vertices[1], { x: 20, y: 0, z: 0 });
  assert.deepEqual(
    replaceMesh(collision, moved, false).collision,
    collision.collision,
  );
  const flat = editVertex(mesh, 2, mesh.vertices[0].position);
  assert.throws(() => replaceMesh(collision, flat, true), /nondegenerate/);
  assert.doesNotThrow(() => replaceMesh(collision, flat, false));
});

test("authored RGBA keeps alpha through linear color conversion and enables transparent material blending", () => {
  const colors = linearNativeColors([0.5, 0.5, 0.5, 0.25, 1, 0, 0, 1], 4);
  assert.equal(colors[3], 0.25);
  assert.equal(colors[7], 1);
  assert.ok(
    colors[0] < 0.25,
    "RGB is converted without gamma-converting alpha",
  );
  const pool = new RoomTexturePool();
  const material = createNativeSurfaceMaterial(
    {
      ...nativeAsset.meshes[0],
      material: {
        wrapS: "repeat",
        wrapT: "repeat",
        filter: "nearest",
        color: [1, 1, 1],
        opacity: 1,
        alphaTest: 0,
        vertexColors: true,
        lighting: false,
      },
    },
    pool,
  ).material;
  assert.equal(material.vertexColors, true);
  assert.equal(material.transparent, true);
  assert.equal(material.depthWrite, false);
  material.dispose();
  pool.dispose();
});

import { cloneAuthoredRoom } from "../components/authoringModel";
test("new native clones preserve trusted template physics and authored clones preserve graph links and collision", () => {
  const source = {
    id: 0,
    name: "Native",
    kind: "native",
    actors: [],
    meshes: nativeAsset.meshes,
    events: [],
    entrances: [],
    doors: [],
    authoredMeshes: [],
    collision: [],
    collisionMode: "template",
    warnings: [],
    actorCount: 0,
    eventCount: 0,
    geometryAvailable: true,
  } as ProjectRoomScene;
  const clone = cloneScene(source, catalog, 620, "New clone", "new");
  assert.equal(clone.kind, "new");
  assert.equal(clone.templateRoomId, 0);
  assert.equal(clone.collisionMode, "template");
  assert.deepEqual(clone.collision, []);
  let authored = insertGeometry(emptyRoom(620, "Authored", 0), nativeAsset, {
    x: 5,
    y: 0,
    z: 0,
  });
  authored = replaceMesh(authored, authored.meshes[0], true);
  authored.skyboxId = null;
  authored.doors = [
    {
      id: "door",
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      dimensions: { x: 10, y: 20, z: 10 },
      activation: "touch",
      destination: { roomId: 620, entranceId: authored.entrances[0].id },
    },
  ];
  const next = cloneAuthoredRoom(authored, 621, "Clone");
  assert.equal(next.templateRoomId, 0);
  assert.equal(next.collisionMode, "authored");
  assert.deepEqual(next.collision, authored.collision);
  assert.equal(next.skyboxId, null);
  assert.equal(next.doors[0].destination.roomId, 621);
  assert.equal(next.doors[0].destination.entranceId, next.entrances[0].id);
  assert.equal(authored.doors[0].destination.roomId, 620);
});

test("native promotion chooses effective substituted actor type while retaining verified definition halfword", () => {
  const original = catalog.actorPrototypes[0];
  const substituted = { ...original, id: "prototype-B", actorId: 9 };
  const modifiedCatalog = {
    ...catalog,
    actorPrototypes: [
      { ...original, sourceRoomId: 0, sourceActorRef: "source" },
      substituted,
    ],
  };
  const scene = {
    id: 0,
    name: "Native",
    kind: "native",
    actors: [
      {
        id: "source",
        index: 0,
        actorId: 9,
        name: "Substituted",
        position: { x: 1, y: 2, z: 3 },
        rotation: { x: 0, y: 0, z: 0 },
        parameters: [7, 8, 9],
        definitionSource: {
          romOffset: 0,
          expectedHex: "00080000" + "00".repeat(12),
        },
        editable: true,
      },
    ],
    meshes: [],
    events: [],
    entrances: [],
    doors: [],
    authoredMeshes: [],
    collision: [],
    collisionMode: "template",
    warnings: [],
    actorCount: 1,
    eventCount: 0,
    geometryAvailable: false,
  } as ProjectRoomScene;
  const next = cloneScene(scene, modifiedCatalog, 620, "Clone", "new");
  assert.equal(next.actors[0].prototypeId, "prototype-B");
  assert.deepEqual(next.actors[0].parameters, [7, 8, 9]);
  assert.throws(
    () =>
      cloneScene(
        scene,
        {
          ...modifiedCatalog,
          actorPrototypes: [modifiedCatalog.actorPrototypes[0]],
        },
        620,
        "Clone",
        "new",
      ),
    /No verified actor prototype/,
  );
});

test("replacement promotion preserves native entrance identities used by existing inbound doors", () => {
  const source = {
    id: 0,
    name: "Native",
    kind: "native",
    actors: [],
    meshes: [],
    events: [],
    entrances: [
      {
        id: "arrival:0",
        name: "Native arrival",
        position: { x: 10, y: 20, z: 30 },
        baseYaw: 256,
        entryParameter: 16,
      },
    ],
    doors: [],
    authoredMeshes: [],
    collision: [],
    collisionMode: "template",
    warnings: [],
    actorCount: 0,
    eventCount: 0,
    geometryAvailable: false,
  } as ProjectRoomScene;
  const promoted = cloneScene(source, catalog, 0, "Replacement", "replacement");
  const inbound = { destination: { roomId: 0, entranceId: "arrival:0" } };
  assert.equal(promoted.entrances[0].id, inbound.destination.entranceId);
  assert.deepEqual(promoted.entrances[0], source.entrances[0]);
  const clone = cloneScene(source, catalog, 620, "Clone", "new");
  assert.notEqual(clone.entrances[0].id, "arrival:0");
  assert.equal(clone.entrances[0].baseYaw, 256);
});

import { generateRoomCollision } from "../components/authoringModel";
test("native zero-area visual triangles remain movable and collision regeneration reports omitted faces", () => {
  const zeroArea = { ...mesh, indices: [0, 1, 2, 0, 1, 1] };
  // Use distinct indices with overlapping native positions, matching imported native batches.
  const native = {
    ...mesh,
    vertices: [...mesh.vertices, vertex(0, 0, 0)],
    indices: [0, 1, 2, 0, 1, 4],
  };
  const moved = transformMesh(native, { translation: { x: 20, y: -5, z: 3 } });
  assert.deepEqual(moved.indices, native.indices);
  assert.deepEqual(moved.vertices[4].position, { x: 20, y: -5, z: 3 });
  assert.throws(
    () => transformMesh(mesh, { scale: { x: 0.01, y: 0.01, z: 1 } }),
    /collapsed/,
  );
  assert.throws(
    () => transformMesh(zeroArea, { translation: { x: 1, y: 0, z: 0 } }),
    /different/,
  );
  const source = { ...emptyRoom(620, "Native-shaped", 0), meshes: [native] };
  const generated = generateRoomCollision(source);
  assert.equal(generated.skipped, 1);
  assert.equal(generated.room.collision.length, 1);
  assert.deepEqual(
    generated.room.meshes,
    source.meshes,
    "collision generation never removes native visual faces",
  );
  assert.doesNotThrow(() => replaceMesh(generated.room, moved, true));
});

test("translated native promotion copies template collision delta and transfers the alias owner without losing alias actor edits", () => {
  const source = {
    id: 465,
    name: "Native",
    kind: "native",
    actors: [],
    meshes: nativeAsset.meshes,
    events: [],
    entrances: [],
    doors: [],
    authoredMeshes: [],
    collision: [],
    collisionMode: "template",
    collisionTranslation: { x: 16, y: 0, z: -4 },
    warnings: [],
    actorCount: 0,
    eventCount: 0,
    geometryAvailable: true,
  } as ProjectRoomScene;
  const promoted = cloneScene(
    source,
    catalog,
    465,
    "Replacement",
    "replacement",
  );
  assert.deepEqual(promoted.collisionTranslation, source.collisionTranslation);
  assert.equal(promoted.collisionMode, "template");
  const project = {
    version: 2,
    authoredRooms: {},
    roomOverrides: {
      "465": {
        actors: { baked: { position: { x: 3, y: 4, z: 5 } } },
        events: {},
        geometry: { translation: { x: 16, y: 0, z: -4 } },
      },
      "483": { actors: { keep: { parameters: [1, 2, 3] } }, events: {} },
    },
  } as unknown as EditorProject;
  const next = updateAuthoredRoom(project, promoted, [465, 483]);
  assert.equal(next.roomOverrides["465"], undefined);
  assert.deepEqual(next.roomOverrides["483"].geometry, {
    translation: { x: 16, y: 0, z: -4 },
  });
  assert.deepEqual(
    next.roomOverrides["483"].actors,
    project.roomOverrides["483"].actors,
  );
  assert.ok(project.roomOverrides["465"]);
  const privateRoom = updateAuthoredRoom(project, promoted, [465]);
  assert.equal(privateRoom.roomOverrides["465"], undefined);
  assert.equal(privateRoom.authoredRooms["465"].collisionTranslation?.x, 16);
  const newClone = cloneScene(source, catalog, 620, "New clone", "new");
  assert.deepEqual(newClone.collisionTranslation, source.collisionTranslation);
  assert.equal(newClone.templateRoomId, 465);
  const generated = generateRoomCollision({
    ...promoted,
    meshes: [{ ...mesh }],
  });
  assert.equal(generated.room.collisionTranslation, undefined);
  assert.equal(generated.room.collisionMode, "authored");
});

import { moveGeometrySelection } from "../components/authoringState";
test("face gizmo moves only selected vertices and does not overflow unrelated signed16 geometry", () => {
  const source = { ...mesh, vertices: [...mesh.vertices, vertex(32760, 0, 0)] };
  const moved = moveGeometrySelection(
    source,
    { meshId: source.id, mode: "face", faceIndex: 0 },
    { x: 23, y: 3, z: 0 },
  );
  assert.deepEqual(moved.vertices[4], source.vertices[4]);
  assert.equal(moved.vertices[0].position.x, 20);
  assert.deepEqual(moved.indices, source.indices);
  assert.equal(source.vertices[0].position.x, 0);
});

test("actor loading policy belongs to the placement, preserves native partition origin and survives cloning", () => {
  const prototype = {
    ...catalog.actorPrototypes[0],
    sourceKind: "partition" as const,
  };
  const added = addActor(emptyRoom(620, "Room", 0), prototype, {
    x: 1,
    y: 2,
    z: 3,
  });
  assert.equal(added.actors[0].spawnPolicy, "proximity");
  const source = {
    id: 0,
    name: "Native",
    kind: "native",
    actors: [
      {
        id: "source",
        index: 0,
        actorId: 8,
        name: "Actor",
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        parameters: [4, 5, 6],
        sourceKind: "partition",
        editable: true,
      },
    ],
    meshes: [],
    events: [],
    entrances: [],
    doors: [],
    authoredMeshes: [],
    collision: [],
    collisionMode: "template",
    warnings: [],
    actorCount: 1,
    eventCount: 0,
    geometryAvailable: false,
  } as ProjectRoomScene;
  const promoted = cloneScene(source, catalog, 0, "Editable", "replacement");
  assert.equal(
    promoted.actors[0].spawnPolicy,
    "proximity",
    "canonical prototype default cannot override actual native placement kind",
  );
  promoted.actors[0].spawnPolicy = "resident";
  assert.equal(
    cloneAuthoredRoom(promoted, 621, "Clone").actors[0].spawnPolicy,
    "resident",
  );
});

// Bundle the installed UI package because its framework exports use extensionless imports.
// Rendering the production provider catches the actual thumbnail ClientFlex/useLayout path.
test("editor providers render native thumbnails and authored readonly events without native source addresses", async () => {
  const { build } = await import("esbuild");
  const { spawnSync } = await import("node:child_process");
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: `
        import React from "react";
        import {renderToStaticMarkup} from "react-dom/server";
        import {Media} from "@once-ui-system/core";
        import {EditorTheme} from "./app/once-config";
        import Inspector from "./components/Inspector";
        const wrap = child => React.createElement(EditorTheme, null, child);
        const image = renderToStaticMarkup(wrap(React.createElement(Media, {
          src: "data:image/png;base64,AAAA", alt: "ROM asset thumbnail", aspectRatio: "3 / 2"
        })));
        const event = renderToStaticMarkup(wrap(React.createElement(Inspector, {
          event: { id: "event:authored-door", actorRef: "authored-door", index: 0,
            name: "Travel door · selector 0x7", kind: "warp", position: {x: 12, y: 34, z: 56},
            values: [0, 0, 458752], editable: false },
          visualsPending: false, sample: false, busy: false, supportedActorIds: [], modified: false,
          onActor() {}, onEvent() {throw new Error("Readonly event was mutated");},
          onReset() {}, onFrame() {}, onInspectActor() {}
        })));
        console.log(JSON.stringify({ image, event }));
      `,
    },
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    loader: { ".css": "empty", ".scss": "empty" },
  });
  const result = spawnSync(process.execPath, [], {
    input: bundle.outputFiles[0].text,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr);
  const { image, event } = JSON.parse(result.stdout);
  assert.match(image, /ROM asset thumbnail/);
  assert.match(image, /data:image\/png;base64,AAAA/);
  assert.match(event, /Travel door/);
  assert.match(event, /Inspect source actor/);
  assert.match(event, /value="12"/);
  assert.match(event, /value="34"/);
  assert.match(event, /value="56"/);
  assert.match(event, /0x00070000/);
  assert.doesNotMatch(event, /ROM offset|SOURCE RECORD/);
  const inputs = event.match(/<input[^>]+>/g) ?? [];
  assert.equal(inputs.length, 4);
  for (const input of inputs) assert.match(input, /disabled/);
});

test("door volume matches native bottom-origin XYZ rotation and live dimension edits without moving its actor origin", async () => {
  const THREE = await import("three");
  const { updateDoorVolume } = await import("../components/doorVolume");
  const door = {
    id: "door-test",
    position: { x: 100, y: 200, z: 300 },
    rotation: { x: 256, y: 0, z: 0 },
    dimensions: { x: 40, y: 80, z: 20 },
    activation: "touch" as const,
    destination: { roomId: 620, entranceId: "start" },
  };
  const origin = new THREE.Group();
  origin.position.set(100, 200, 300);
  const volume = new THREE.LineSegments(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial(),
  );
  origin.add(volume);
  updateDoorVolume(volume, door);
  origin.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(volume),
    center = bounds.getCenter(new THREE.Vector3());
  assert.ok(
    center.distanceTo(new THREE.Vector3(100, 200, 340)) < 1e-4,
    "X quarter-turn rotates bottom-origin height offset into +Z",
  );
  assert.deepEqual(origin.position.toArray(), [100, 200, 300]);
  assert.ok(
    bounds
      .getSize(new THREE.Vector3())
      .distanceTo(new THREE.Vector3(40, 20, 80)) < 1e-4,
  );
  const originalGeometry = volume.geometry;
  let disposed = 0;
  originalGeometry.addEventListener("dispose", () => disposed++);
  updateDoorVolume(volume, {
    ...door,
    rotation: { x: 0, y: 0, z: 256 },
    dimensions: { x: 60, y: 100, z: 30 },
  });
  origin.updateMatrixWorld(true);
  assert.equal(disposed, 1);
  const nextBounds = new THREE.Box3().setFromObject(volume);
  assert.ok(
    nextBounds
      .getCenter(new THREE.Vector3())
      .distanceTo(new THREE.Vector3(50, 200, 300)) < 1e-4,
    "Z quarter-turn rotates height offset into -X",
  );
  assert.ok(
    nextBounds
      .getSize(new THREE.Vector3())
      .distanceTo(new THREE.Vector3(100, 60, 30)) < 1e-4,
  );
  assert.deepEqual(origin.position.toArray(), [100, 200, 300]);
  volume.geometry.dispose();
  (volume.material as import("three").Material).dispose();
});

test(
  "GPU native thumbnail jobs reuse one context, release job assets, recover after a rejected preview and release on pagehide",
  { skip: process.env.MNSG_GPU_TEST !== "1" },
  async () => {
    const { build } = await import("esbuild");
    const { chromium } = await import("playwright");
    const bundle = await build({
      stdin: {
        resolveDir: process.cwd(),
        contents: `
      import {assetThumbnail} from "./components/assetThumbnails";
      let contexts = 0, lost = 0;
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function(type, ...args) {
        const context = original.call(this, type, ...args);
        if (type === "webgl2" && context) { contexts++; this.addEventListener("webglcontextlost", () => {lost++;}); }
        return context;
      };
      window.runThumbnails = async () => {
        const material = { wrapS:"clamp", wrapT:"clamp", filter:"nearest", color:[1,1,1], opacity:1, alphaTest:0, vertexColors:false, lighting:false };
        const payload = { id:"fixture", name:"fixture", textures:[], meshes:[{id:"surface", source:"display-list", positions:[0,0,0,20,0,0,0,20,0], indices:[0,1,2], material}] };
        const images = await Promise.all(Array.from({length:24}, () => assetThumbnail(payload)));
        let rejection = false;
        try {await assetThumbnail({...payload, meshes:[]});} catch {rejection=true;}
        const restored = await assetThumbnail(payload);
        const before = contexts;
        window.dispatchEvent(new Event("pagehide"));
        await new Promise(resolve => setTimeout(resolve, 50));
        const afterHide = lost;
        window.dispatchEvent(new Event("pageshow"));
        const resumed = await assetThumbnail(payload);
        return {contexts, before, lost:afterHide, rejection, valid:images.every(image=>image.startsWith("data:image/png;base64,")), stable:images.every(image=>image===restored) && restored===resumed};
      };
    `,
      },
      bundle: true,
      write: false,
      platform: "browser",
      format: "iife",
      logLevel: "silent",
    });
    const browser = await chromium.launch({
      channel: "chrome",
      headless: true,
      args: [
        "--use-gl=angle",
        "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader",
      ],
    });
    try {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.text().includes("Too many active WebGL contexts"))
          errors.push(message.text());
      });
      await page.setContent("<html><body></body></html>");
      await page.addScriptTag({ content: bundle.outputFiles[0].text });
      const result = await page.evaluate(() => (window as any).runThumbnails());
      assert.equal(
        result.before,
        1,
        "24 queued previews and failed job share the same context",
      );
      assert.equal(
        result.contexts,
        2,
        "only pagehide/resume creates a replacement context",
      );
      assert.equal(result.lost, 1);
      assert.equal(result.rejection, true);
      assert.equal(result.valid, true);
      assert.equal(
        result.stable,
        true,
        "per-job cleanup preserves native surface appearance",
      );
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  },
);

test("authoring selects have stable exact names and deduplicated preview details follow the edit controls", async () => {
  const { build } = await import("esbuild");
  const { spawnSync } = await import("node:child_process");
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: `
      import React from "react";
      import {renderToStaticMarkup} from "react-dom/server";
      import {EditorTheme} from "./app/once-config";
      import Inspector from "./components/AuthoringInspector";
      import {emptyRoom} from "./components/authoringModel";
      import {previewMessages,PreviewStatus,PreviewDetails} from "./components/PreviewDiagnostics";
      const room=emptyRoom(620,"fixture",0);
      room.actors=[{id:"actor-1",prototypeId:"prototype-1",position:{x:0,y:0,z:0},rotation:{x:0,y:0,z:0},parameters:[0,0,0]}];
      room.meshes=[{id:"mesh-1",vertices:[{position:{x:0,y:0,z:0},uv:[0,0],color:[255,255,255,255]},{position:{x:10,y:0,z:0},uv:[1,0],color:[255,255,255,255]},{position:{x:0,y:10,z:0},uv:[0,1],color:[255,255,255,255]}],indices:[0,1,2],materialId:"material-1"}];
      room.materials=[{id:"material-1",sourceMaterialId:"native-material"}];
      room.doors=[{id:"door-1",position:{x:0,y:0,z:0},rotation:{x:0,y:0,z:0},dimensions:{x:80,y:120,z:40},activation:"interact",destination:{roomId:620,entranceId:room.entrances[0].id}}];
      const catalog={actorPrototypes:[{id:"prototype-1",name:"Native fixture",sourceKind:"resident"}],materials:[{id:"native-material",name:"Native material"}],skyboxes:[],surfaces:[]};
      const visual={actorRef:"actor-1",status:"conditional",parts:[],reason:"Save-state visibility is unknown.; Native lighting is approximated.",warnings:["Save-state visibility is unknown.","Native lighting is approximated."]};
      const props={room,catalog,geometrySelection:null,disabled:false,visual,visualsPending:false,destinationRooms:[{id:620,name:"fixture"}],loadEntrances:async()=>room.entrances,followCollision:false,referencedEntrances:new Set(),externalEntranceIds:new Set(),nativeEntranceIds:new Set(),onChange(){},onSelect(){},onGeometrySelect(){},onFrame(){},onRevertSaved(){},onRestoreNative(){},onFollowCollision(){}};
      const render=changes=>renderToStaticMarkup(React.createElement(EditorTheme,null,React.createElement(Inspector,{...props,...changes})));
      const actor=render({selected:"actor-1"}), mesh=render({selected:"mesh-1",geometrySelection:{meshId:"mesh-1",mode:"mesh"}}),door=render({selected:"door:door-1"}),settings=render({selected:null});
      const statuses=["supported","conditional","nonvisual","unsupported"].map(status=>renderToStaticMarkup(React.createElement(EditorTheme,null,React.createElement(PreviewStatus,{visual:{...visual,status}}))));
      console.log(JSON.stringify({actor,mesh,door,settings,statuses,messages:previewMessages({visual})}));
    `,
    },
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    loader: { ".css": "empty", ".scss": "empty" },
  });
  const result = spawnSync(process.execPath, [], {
    input: bundle.outputFiles[0].text,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr);
  const markup = JSON.parse(result.stdout);
  const cases: [string, string[]][] = [
    [markup.actor, ["Actor prototype", "Actor loading"]],
    [markup.mesh, ["Material"]],
    [
      markup.door,
      [
        "Activation",
        "Destination room",
        "Destination entrance",
        "Door appearance",
      ],
    ],
    [markup.settings, ["Skybox"]],
  ];
  for (const [html, names] of cases)
    for (const name of names)
      assert.ok(html.includes(`aria-label="${name}"`), name);
  assert.deepEqual(markup.messages, [
    "Save-state visibility is unknown.",
    "Native lighting is approximated.",
  ]);
  assert.ok(
    markup.actor.indexOf('aria-label="Actor loading"') <
      markup.actor.indexOf("<details"),
  );
  assert.ok(
    markup.actor.indexOf("Remove actor") < markup.actor.indexOf("<details"),
  );
  assert.doesNotMatch(markup.actor, /<details[^>]+open/);
  assert.match(markup.actor, /Conditional native model/);
  assert.match(markup.statuses[0], /Native initial pose/);
  assert.match(markup.statuses[2], /Nonvisual controller/);
  assert.match(markup.statuses[3], /Native model unavailable/);
  if (process.env.MNSG_GPU_TEST === "1") {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({
      channel: "chrome",
      headless: true,
    });
    try {
      const page = await browser.newPage();
      for (const [html, names] of cases) {
        await page.setContent(html);
        for (const name of names)
          assert.equal(
            await page.getByLabel(name, { exact: true }).count(),
            1,
            name,
          );
      }
      await page.setContent(markup.actor);
      assert.equal(
        await page
          .getByRole("combobox", { name: "Actor loading", exact: true })
          .count(),
        1,
      );
      assert.equal(await page.locator("details").getAttribute("open"), null);
      await page.locator("summary").click();
      assert.equal(await page.locator("details li").count(), 2);
    } finally {
      await browser.close();
    }
  }
});
