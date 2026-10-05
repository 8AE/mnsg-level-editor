import type {
  AuthoredActor,
  AuthoredCollisionTriangle,
  AuthoredDoor,
  AuthoredEntrance,
  AuthoredMaterial,
  AuthoredMesh,
  AuthoredRoom,
  AuthoredVertex,
} from "../shared/types";
import { newId, replaceMesh } from "./authoringModel";
import type { GeometrySelection } from "./authoringState";
import type { LibraryDrop } from "./AssetLibrary";

export type EditorClipboard = { romHash: string } & (
  | {
      kind: "mesh";
      mesh: AuthoredMesh;
      material: AuthoredMaterial;
      collision: AuthoredCollisionTriangle[];
    }
  | { kind: "face"; vertices: AuthoredVertex[]; material: AuthoredMaterial }
  | { kind: "vertex"; vertex: AuthoredVertex }
  | { kind: "actor"; actor: AuthoredActor }
  | { kind: "door"; door: AuthoredDoor }
  | { kind: "entrance"; entrance: AuthoredEntrance }
  | { kind: "room"; room: AuthoredRoom }
  | {
      kind: "event";
      eventKind: string;
      position?: import("../shared/types").Vec3;
      values: number[];
    }
  | { kind: "asset"; asset: LibraryDrop }
);
export function copyGeometry(
  room: AuthoredRoom,
  selection: GeometrySelection,
  romHash: string,
): EditorClipboard {
  const mesh = room.meshes.find((m) => m.id === selection.meshId);
  if (!mesh) throw new Error("Select a mesh to copy.");
  if (selection.mode === "vertex") {
    const vertex = mesh.vertices[selection.vertexIndex];
    if (!vertex) throw new Error("Select an existing vertex.");
    return structuredClone({ kind: "vertex", vertex, romHash });
  }
  const material = room.materials.find((m) => m.id === mesh.materialId);
  if (!material) throw new Error("The copied mesh has no material.");
  if (selection.mode === "face") {
    const indices = mesh.indices.slice(
      selection.faceIndex * 3,
      selection.faceIndex * 3 + 3,
    );
    if (indices.length !== 3) throw new Error("Select an existing face.");
    return structuredClone({
      kind: "face",
      vertices: indices.map((i) => mesh.vertices[i]),
      material,
      romHash,
    });
  }
  return structuredClone({
    kind: "mesh",
    mesh,
    material,
    collision: room.collision.filter((t) => t.sourceMeshId === mesh.id),
    romHash,
  });
}
export function pasteEntity(
  room: AuthoredRoom,
  clipboard: EditorClipboard,
  selection: GeometrySelection | null,
  followCollision: boolean,
): {
  room: AuthoredRoom;
  selected: string;
  geometry: GeometrySelection | null;
} {
  const result = (
    next: AuthoredRoom,
    selected: string,
    geometry: GeometrySelection | null = null,
  ) => ({ room: next, selected, geometry });
  // All new records receive fresh IDs; the clipboard stays an immutable snapshot.
  const copy = structuredClone(clipboard);
  if (copy.kind === "actor") {
    const actor = { ...copy.actor, id: newId("actor") };
    return result({ ...room, actors: [...room.actors, actor] }, actor.id);
  }
  if (copy.kind === "door") {
    const door = { ...copy.door, id: newId("door") };
    return result({ ...room, doors: [...room.doors, door] }, `door:${door.id}`);
  }
  if (copy.kind === "entrance") {
    const entrance = {
      ...copy.entrance,
      id: newId("entrance"),
      name: `${copy.entrance.name} copy`,
    };
    return result(
      { ...room, entrances: [...room.entrances, entrance] },
      `entrance:${entrance.id}`,
    );
  }
  let target = room.meshes.find((m) => m.id === selection?.meshId);
  if (copy.kind === "vertex") {
    if (!target)
      throw new Error("Select a destination mesh before pasting a vertex.");
    const index = target.vertices.length;
    target = { ...target, vertices: [...target.vertices, copy.vertex] };
    return result(replaceMesh(room, target, false), target.id, {
      meshId: target.id,
      mode: "vertex",
      vertexIndex: index,
    });
  }
  if (copy.kind !== "mesh" && copy.kind !== "face")
    throw new Error(
      "Choose an actor, mesh, face, vertex, door or entrance to paste here.",
    );
  const materials = [...room.materials];
  let material = materials.find(
    (m) => m.sourceMaterialId === copy.material.sourceMaterialId,
  );
  if (!material) {
    material = { ...copy.material, id: newId("material") };
    materials.push(material);
  }
  if (copy.kind === "face" && target?.materialId === material.id) {
    const vertexIndex = target.vertices.length,
      faceIndex = target.indices.length / 3;
    target = {
      ...target,
      vertices: [...target.vertices, ...copy.vertices],
      indices: [
        ...target.indices,
        vertexIndex,
        vertexIndex + 1,
        vertexIndex + 2,
      ],
    };
    return result(
      replaceMesh(
        room,
        target,
        followCollision && room.collisionMode === "authored",
      ),
      target.id,
      { meshId: target.id, mode: "face", faceIndex },
    );
  }
  const mesh: AuthoredMesh =
    copy.kind === "mesh"
      ? { ...copy.mesh, id: newId("mesh"), materialId: material.id }
      : {
          id: newId("mesh"),
          vertices: copy.vertices,
          indices: [0, 1, 2],
          materialId: material.id,
        };
  const collision =
    copy.kind === "mesh" && room.collisionMode === "authored"
      ? copy.collision.map((t) => ({
          ...t,
          id: newId("collision"),
          sourceMeshId: mesh.id,
        }))
      : [];
  const next = {
    ...room,
    materials,
    meshes: [...room.meshes, mesh],
    collision: [...room.collision, ...collision],
  };
  return result(
    copy.kind === "face" && followCollision && room.collisionMode === "authored"
      ? replaceMesh(next, mesh, true)
      : next,
    mesh.id,
    copy.kind === "face"
      ? { meshId: mesh.id, mode: "face", faceIndex: 0 }
      : { meshId: mesh.id, mode: "mesh" },
  );
}
