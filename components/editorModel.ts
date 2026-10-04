import type { ActorData, EditorProject, GeometryMesh, RoomData, Vec3 } from "../shared/types";
import { actorEvent } from "../core/rom/events";

export function applyOverrides(room: RoomData, project: EditorProject | null): RoomData {
  const overrides = project?.roomOverrides[String(room.id)];
  const translation = effectiveGeometryTranslation(room, project);
  if (!overrides && !translation) return room;
  const actors = room.actors.map(actor => {
    const override = overrides?.actors[actor.id];
    return { ...actor, ...override, name: override?.actorId !== undefined && override.actorId !== actor.actorId ? `Actor 0x${override.actorId.toString(16).toUpperCase().padStart(3, "0")} · changed` : actor.name };
  });
  const derived = actors.flatMap(actor => { const event = actorEvent(actor); return event ? [event] : []; });
  return {
    ...room,
    actors,
    events: [...room.events.filter(event => !event.actorRef).map(event => ({ ...event, ...overrides?.events[event.id] })), ...derived],
    meshes: translation ? translatedMeshes(room, translation) : room.meshes,
    bounds: translation && room.bounds ? { min: addVector(room.bounds.min, translation), max: addVector(room.bounds.max, translation) } : room.bounds,
  };
}

const addVector = (first: Vec3, second: Vec3): Vec3 => ({ x: first.x + second.x, y: first.y + second.y, z: first.z + second.z });

/** Supported geometry groups contain complete physical-source aliases, verified by the parser. */
export function effectiveGeometryTranslation(room: RoomData, project: EditorProject | null): Vec3 | null {
  const own = project?.roomOverrides[String(room.id)]?.geometry?.translation;
  if (own) return own;
  if (!room.geometryEdit?.supported) return null;
  for (const id of room.geometryEdit.affectedRoomIds) {
    const translation = project?.roomOverrides[String(id)]?.geometry?.translation;
    if (translation) return translation;
  }
  return null;
}

const geometryPreviewCache = new WeakMap<RoomData, Map<string, GeometryMesh[]>>();
function translatedMeshes(room: RoomData, translation: Vec3): GeometryMesh[] {
  if (!translation.x && !translation.y && !translation.z) return room.meshes;
  const key = `${translation.x},${translation.y},${translation.z}`;
  let cache = geometryPreviewCache.get(room);
  if (!cache) { cache = new Map(); geometryPreviewCache.set(room, cache); }
  const previous = cache.get(key);
  if (previous) return previous;
  const offsets = [translation.x, translation.y, translation.z];
  const meshes = room.meshes.map(mesh => ({ ...mesh, positions: mesh.positions.map((value, index) => value + offsets[index % 3]) }));
  if (cache.size >= 32) cache.delete(cache.keys().next().value!);
  cache.set(key, meshes);
  return meshes;
}

export function checkedGeometryTranslation(room: RoomData, translation: Vec3): Vec3 {
  if (!room.geometryEdit?.supported) throw new Error(room.geometryEdit?.reason ?? "Room geometry editing is not verified for this room.");
  const checked = { ...translation };
  for (const axis of ["x", "y", "z"] as const) {
    const min = room.geometryEdit.translationBounds?.min[axis] ?? -32768;
    const max = room.geometryEdit.translationBounds?.max[axis] ?? 32767;
    checked[axis] = parseInteger(String(translation[axis]), min, max);
  }
  return checked;
}

export function withGeometryOverride(project: EditorProject, roomId: number, translation: Vec3 | null, affectedRoomIds: number[] = [roomId]): EditorProject {
  const key = String(roomId);
  const roomOverrides = { ...project.roomOverrides };
  for (const id of new Set([roomId, ...affectedRoomIds])) {
    const existing = roomOverrides[String(id)];
    if (!existing?.geometry) continue;
    const retained = { ...existing };
    delete retained.geometry;
    if (!Object.keys(retained.actors).length && !Object.keys(retained.events).length) delete roomOverrides[String(id)];
    else roomOverrides[String(id)] = retained;
  }
  const override = { ...(roomOverrides[key] ?? { actors: {}, events: {} }) };
  if (!translation || (!translation.x && !translation.y && !translation.z)) delete override.geometry;
  else override.geometry = { translation: { ...translation } };
  roomOverrides[key] = override;
  if (!Object.keys(override.actors).length && !Object.keys(override.events).length && !override.geometry) delete roomOverrides[key];
  return { ...project, updatedAt: new Date().toISOString(), roomOverrides };
}

export function countProjectChanges(project: EditorProject | null): number {
  return project ? Object.values(project.roomOverrides).reduce((sum, override) => sum + Object.keys(override.actors).length + Object.keys(override.events).length + (override.geometry ? 1 : 0), 0) : 0;
}

export function sharedGeometryImpacts(room: RoomData, project: EditorProject | null): number[] {
  return room.geometryEdit?.affectedRoomIds.filter(id => id !== room.id && project?.roomOverrides[String(id)]?.geometry) ?? [];
}

export function formatAddress(value: number): string {
  return `0x${value.toString(16).toUpperCase().padStart(8, "0")}`;
}

export function parseInteger(value: string, min: number, max: number): number {
  const trimmed = value.trim();
  if (!/^(?:-?\d+|0x[\da-f]+)$/i.test(trimmed)) throw new Error("Enter an integer or a hexadecimal value.");
  const result = Number(trimmed);
  if (!Number.isSafeInteger(result) || result < min || result > max) throw new Error(`Value must be between ${min.toLocaleString()} and ${max.toLocaleString()}.`);
  return result;
}

export function parseWords(value: string, count: number, max = 0xffffffff): number[] {
  const values = value.trim().split(/[\s,]+/).filter(Boolean);
  if (values.length !== count) throw new Error(`This record requires exactly ${count} values.`);
  return values.map(item => parseInteger(item, 0, max));
}

export function checkedPosition(position: Vec3): Vec3 {
  return { x: parseInteger(String(Math.round(position.x)), -32768, 32767), y: parseInteger(String(Math.round(position.y)), -32768, 32767), z: parseInteger(String(Math.round(position.z)), -32768, 32767) };
}

export function checkedActorPosition(actor: ActorData, position: Vec3): Vec3 {
  const checked = checkedPosition(position);
  if (actor.sourceKind === "partition") {
    if (!actor.partition) throw new Error("Spatial partition relocation is not yet supported for this record.");
    const partition = actor.partition;
    for (const axis of ["x", "y", "z"] as const) {
      if (partition.cellSize[axis] < 1 || partition.cellCount[axis] < 1 || !Number.isFinite(partition.origin[axis])) throw new Error("Invalid native proximity cell configuration.");
      const cell = Math.trunc(Math.fround(Math.fround(Math.fround(checked[axis] - partition.origin[axis]) / partition.cellSize[axis]) + Math.fround(partition.cellCount[axis] / 2)));
      if (cell !== partition.originalCell[axis]) throw new Error("Keep this actor within its original spawn-grid cell. Moving between spatial partitions is not yet supported.");
    }
  }
  return checked;
}

const source = { romOffset: 0, expectedHex: "" };
const actor = (id: string, index: number, name: string, position: Vec3): ActorData => ({ id, index, name, position, actorId: index, rotation: { x: 0, y: 0, z: 0 }, parameters: [0, 0, 0], source, editable: false });

/** Procedural UI fixture. This contains no ROM or game assets. */
export const sampleRoom: RoomData = {
  id: 0, name: "Procedural study", actorCount: 4, eventCount: 2, geometryAvailable: true,
  warnings: ["Sample workspace: procedural geometry and markers. No game data. Editing and export are disabled."],
  source,
  actors: [actor("sample-1", 0, "Actor marker A", { x: -200, y: 0, z: -120 }), actor("sample-2", 1, "Actor marker B", { x: 140, y: 60, z: -180 }), actor("sample-3", 2, "Actor marker C", { x: 240, y: 0, z: 180 }), actor("sample-4", 3, "Actor marker D", { x: -100, y: 0, z: 180 })],
  events: [{ id: "sample-event-1", index: 0, name: "Event marker A", kind: "Sample", position: { x: 0, y: 0, z: 280 }, values: [0, 0], source, editable: false }, { id: "sample-event-2", index: 1, name: "Event marker B", kind: "Sample", position: { x: -320, y: 0, z: -40 }, values: [0, 0], source, editable: false }],
  meshes: [{ id: "sample-platform", source: "collision", positions: [-400, -20, -350, 400, -20, -350, 400, -20, 350, -400, -20, 350, -220, 40, -300, 0, 40, -300, 0, 40, -100, -220, 40, -100, 70, 110, -290, 290, 110, -290, 290, 110, -70, 70, 110, -70], indices: [0, 2, 1, 0, 3, 2, 4, 6, 5, 4, 7, 6, 8, 10, 9, 8, 11, 10] }],
};
