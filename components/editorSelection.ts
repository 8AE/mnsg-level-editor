import type {
  AuthoredMesh,
  EditorProject,
  ProjectRoomScene,
  RoomData,
  Vec3,
} from "../shared/types";
import type { GeometrySelection } from "./authoringState";
import { nativeVertexPosition } from "./authoringState";
import { replaceMesh } from "./authoringModel";
import { checkedActorPosition, checkedPosition } from "./editorModel";

export type EditorSelection =
  | { kind: "record"; id: string }
  | { kind: "geometry"; choice: GeometrySelection };
export type SelectionScene = RoomData | ProjectRoomScene;
export const selectionId = (selection: EditorSelection) =>
  selection.kind === "record" ? selection.id : selection.choice.meshId;
export const selectionKey = (selection: EditorSelection): string =>
  selection.kind === "record"
    ? `record:${selection.id}`
    : `${selection.choice.meshId}/${selection.choice.mode}/${selection.choice.mode === "face" ? selection.choice.faceIndex : selection.choice.mode === "vertex" ? selection.choice.vertexIndex : ""}`;

/** Modifier-click toggles an item; a whole mesh supersedes its sub-elements. */
export function selectItems(
  current: EditorSelection[],
  item: EditorSelection | null,
  additive = false,
): EditorSelection[] {
  if (!item) return additive ? current : [];
  if (!additive) return [item];
  const key = selectionKey(item);
  if (current.some((value) => selectionKey(value) === key))
    return current.filter((value) => selectionKey(value) !== key);
  const retained =
    item.kind === "geometry"
      ? current.filter(
          (value) =>
            value.kind !== "geometry" ||
            value.choice.meshId !== item.choice.meshId ||
            (value.choice.mode !== "mesh" && item.choice.mode !== "mesh"),
        )
      : current;
  return [...retained, item];
}

export function geometryVertexIndices(
  mesh: { vertices: { length: number }; indices: number[] },
  choice: GeometrySelection,
): number[] {
  if (choice.mode === "mesh")
    return Array.from({ length: mesh.vertices.length }, (_v, i) => i);
  if (choice.mode === "vertex")
    return Number.isInteger(choice.vertexIndex) &&
      choice.vertexIndex >= 0 &&
      choice.vertexIndex < mesh.vertices.length
      ? [choice.vertexIndex]
      : [];
  if (
    !Number.isInteger(choice.faceIndex) ||
    choice.faceIndex < 0 ||
    choice.faceIndex * 3 + 2 >= mesh.indices.length
  )
    return [];
  return [
    ...new Set(
      mesh.indices.slice(choice.faceIndex * 3, choice.faceIndex * 3 + 3),
    ),
  ];
}

export function selectedGeometryVertices(
  scene: SelectionScene,
  selections: EditorSelection[],
): Map<string, Set<number>> {
  const result = new Map<string, Set<number>>();
  for (const item of selections) {
    if (item.kind !== "geometry") continue;
    const mesh =
      "authoredMeshes" in scene
        ? scene.authoredMeshes.find((value) => value.id === item.choice.meshId)
        : undefined;
    if (!mesh) continue;
    const indices = result.get(mesh.id) ?? new Set<number>();
    geometryVertexIndices(mesh, item.choice).forEach((index) =>
      indices.add(index),
    );
    result.set(mesh.id, indices);
  }
  return result;
}

export function selectedRecordIds(
  scene: SelectionScene,
  selections: EditorSelection[],
): Set<string> {
  return new Set(
    selections
      .filter((value) => value.kind === "record")
      .map((value) => {
        const id = selectionId(value);
        return scene.events.find((event) => event.id === id)?.actorRef ?? id;
      }),
  );
}
export function recordPosition(
  scene: SelectionScene,
  id: string,
): Vec3 | undefined {
  const event = scene.events.find((value) => value.id === id);
  return (
    scene.actors.find((value) => value.id === (event?.actorRef ?? id))
      ?.position ??
    event?.position ??
    ("doors" in scene
      ? (scene.doors.find((value) => `door:${value.id}` === id)?.position ??
        scene.entrances.find((value) => `entrance:${value.id}` === id)
          ?.position)
      : undefined)
  );
}
export function selectionExists(
  scene: SelectionScene,
  selection: EditorSelection,
): boolean {
  if (selection.kind === "record")
    return Boolean(
      scene.actors.some((v) => v.id === selection.id) ||
        scene.events.some((v) => v.id === selection.id) ||
        ("doors" in scene &&
          (scene.doors.some((v) => `door:${v.id}` === selection.id) ||
            scene.entrances.some((v) => `entrance:${v.id}` === selection.id))),
    );
  const mesh = scene.meshes.find(
    (value) => value.id === selection.choice.meshId,
  );
  if (!mesh) return false;
  return (
    selection.choice.mode === "mesh" ||
    geometryVertexIndices(
      {
        vertices: { length: mesh.positions.length / 3 },
        indices: mesh.indices,
      },
      selection.choice,
    ).length > 0
  );
}
export function selectionMovable(
  scene: SelectionScene,
  selections: EditorSelection[],
): boolean {
  if (!selections.length) return false;
  return selections.every((value) => {
    if (!selectionExists(scene, value)) return false;
    if (value.kind === "geometry")
      return (
        "authoredMeshes" in scene &&
        scene.authoredMeshes.some(
          (mesh) =>
            mesh.id === value.choice.meshId &&
            geometryVertexIndices(mesh, value.choice).length > 0,
        )
      );
    const id =
      scene.events.find((event) => event.id === value.id)?.actorRef ?? value.id;
    const actor = scene.actors.find((actor) => actor.id === id);
    if (actor)
      return (
        actor.editable &&
        (Boolean("prototypeId" in actor && actor.prototypeId) ||
          actor.sourceKind !== "partition" ||
          Boolean(actor.partition))
      );
    const event = scene.events.find((event) => event.id === id);
    return Boolean(
      event ? event.editable && event.position : recordPosition(scene, id),
    );
  });
}

/** A shared bounding-box center avoids weighting vertices shared by several faces. */
export function selectionCenter(
  scene: SelectionScene,
  selections: EditorSelection[],
): Vec3 | null {
  const points: Vec3[] = [];
  selectedRecordIds(scene, selections).forEach((id) => {
    const p = recordPosition(scene, id);
    if (p) points.push(p);
  });
  const seen = new Set<string>();
  for (const item of selections) {
    if (item.kind !== "geometry") continue;
    const mesh = scene.meshes.find((mesh) => mesh.id === item.choice.meshId);
    if (!mesh) continue;
    const count = mesh.positions.length / 3;
    const indices = geometryVertexIndices(
      { vertices: { length: count }, indices: mesh.indices },
      item.choice,
    );
    for (const index of indices) {
      const key = `${mesh.id}/${index}`;
      if (seen.has(key)) continue;
      seen.add(key);
      points.push({
        x: mesh.positions[index * 3],
        y: mesh.positions[index * 3 + 1],
        z: mesh.positions[index * 3 + 2],
      });
    }
  }
  if (!points.length) return null;
  const min = { x: Infinity, y: Infinity, z: Infinity },
    max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const p of points)
    for (const axis of ["x", "y", "z"] as const) {
      min[axis] = Math.min(min[axis], p[axis]);
      max[axis] = Math.max(max[axis], p[axis]);
    }
  return {
    x: (min.x + max.x) / 2,
    y: (min.y + max.y) / 2,
    z: (min.z + max.z) / 2,
  };
}

/** One immutable project transaction; validation failures leave every object untouched. */
export function translateProjectSelection(
  project: EditorProject,
  scene: SelectionScene,
  selections: EditorSelection[],
  delta: Vec3,
  followCollision: boolean,
): EditorProject {
  if (![delta.x, delta.y, delta.z].every(Number.isSafeInteger))
    throw new Error("Move offsets must be whole numbers.");
  if (!selectionMovable(scene, selections))
    throw new Error(
      "Some selected items are read-only. Make an editable room copy to move its geometry, or deselect the read-only records.",
    );
  if (!delta.x && !delta.y && !delta.z) return project;
  const add = (value: Vec3): Vec3 => ({
    x: value.x + delta.x,
    y: value.y + delta.y,
    z: value.z + delta.z,
  });
  const records = selectedRecordIds(scene, selections);
  let next = project;
  const authored =
    project.version === 2 ? project.authoredRooms[scene.id] : undefined;
  if (authored && project.version === 2) {
    let room = {
      ...authored,
      actors: authored.actors.map((value) =>
        records.has(value.id)
          ? { ...value, position: checkedPosition(add(value.position)) }
          : value,
      ),
      doors: authored.doors.map((value) =>
        records.has(`door:${value.id}`)
          ? { ...value, position: checkedPosition(add(value.position)) }
          : value,
      ),
      entrances: authored.entrances.map((value) =>
        records.has(`entrance:${value.id}`)
          ? { ...value, position: checkedPosition(add(value.position)) }
          : value,
      ),
    };
    for (const [id, indices] of selectedGeometryVertices(scene, selections)) {
      const mesh = room.meshes.find((value) => value.id === id)!;
      const moved: AuthoredMesh = {
        ...mesh,
        vertices: mesh.vertices.map((value, index) =>
          indices.has(index)
            ? { ...value, position: nativeVertexPosition(add(value.position)) }
            : value,
        ),
      };
      room = replaceMesh(
        room,
        moved,
        room.collisionMode === "authored" && followCollision,
      );
    }
    next = {
      ...project,
      authoredRooms: { ...project.authoredRooms, [scene.id]: room },
    };
  }
  const override = next.roomOverrides[String(scene.id)] ?? {
    actors: {},
    events: {},
  };
  const actors = { ...override.actors },
    events = { ...override.events };
  let overridesChanged = false;
  for (const id of records) {
    if (
      authored &&
      (authored.actors.some((v) => v.id === id) ||
        authored.doors.some((v) => `door:${v.id}` === id) ||
        authored.entrances.some((v) => `entrance:${v.id}` === id))
    )
      continue;
    const actor = scene.actors.find((value) => value.id === id);
    if (actor)
      actors[id] = {
        ...actors[id],
        position: checkedActorPosition(
          actor as import("../shared/types").ActorData,
          add(actor.position),
        ),
      };
    else
      events[id] = {
        ...events[id],
        position: checkedPosition(
          add(scene.events.find((value) => value.id === id)!.position!),
        ),
      };
    overridesChanged = true;
  }
  return {
    ...next,
    updatedAt: new Date().toISOString(),
    roomOverrides: overridesChanged
      ? {
          ...next.roomOverrides,
          [String(scene.id)]: { ...override, actors, events },
        }
      : next.roomOverrides,
  };
}
