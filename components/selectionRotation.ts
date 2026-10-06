import * as THREE from "three";
import type { EditorProject, Vec3 } from "../shared/types";
import { nativeActorPlacementMatrix } from "../core/rom/actors-pose";
import { checkedActorPosition, checkedPosition } from "./editorModel";
import { nativeVertexPosition } from "./authoringState";
import { replaceMesh } from "./authoringModel";
import { selectedGeometryVertices, selectedRecordIds, selectionMovable, type EditorSelection, type SelectionScene } from "./editorSelection";

export interface RotationDelta { x: number; y: number; z: number; w: number }
export function rotationQuaternion(value: RotationDelta): THREE.Quaternion {
  const values = [value.x, value.y, value.z, value.w];
  if (!values.every(Number.isFinite) || Math.abs(Math.hypot(...values) - 1) > 0.0001)
    throw new Error("Rotation must be a finite unit quaternion.");
  return new THREE.Quaternion(...values as [number, number, number, number]).normalize();
}
export function rotatePoint(point: Vec3, pivot: Vec3, rotation: THREE.Quaternion): Vec3 {
  const p = new THREE.Vector3(point.x - pivot.x, point.y - pivot.y, point.z - pivot.z).applyQuaternion(rotation);
  return { x: Math.round(p.x + pivot.x) || 0, y: Math.round(p.y + pivot.y) || 0, z: Math.round(p.z + pivot.z) || 0 };
}
export function rotateNativeAngles(angles: Vec3, rotation: THREE.Quaternion): Vec3 {
  const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().fromArray(nativeActorPlacementMatrix({ x: 0, y: 0, z: 0 }, angles)));
  const euler = new THREE.Euler().setFromQuaternion(rotation.clone().multiply(q), "ZYX");
  const phase = (radians: number) => ((Math.round(radians * 1024 / (Math.PI * 2)) % 1024) + 1024) % 1024;
  const preserve = (before: number, radians: number) => {
    if (before === -32768 || before === 32768) return before;
    const next = phase(radians);
    return next === (before & 1023) ? before : next;
  };
  return { x: preserve(angles.x, euler.x), y: preserve(angles.y, euler.y), z: preserve(angles.z, euler.z) };
}
export function selectionRotatable(scene: SelectionScene, selections: EditorSelection[]): boolean {
  if (!selectionMovable(scene, selections)) return false;
  if (selections.length > 1) return true;
  if (selections[0].kind === "geometry") return selections[0].choice.mode !== "vertex";
  const id = [...selectedRecordIds(scene, selections)][0];
  return scene.actors.some(actor => actor.id === id) || ("doors" in scene && scene.doors.some(door => `door:${door.id}` === id));
}

/** Rotate each shared vertex / actor-event alias once, around one world-space pivot. */
export function rotateProjectSelection(project: EditorProject, scene: SelectionScene, selections: EditorSelection[], delta: RotationDelta, pivot: Vec3, followCollision: boolean): EditorProject {
  const q = rotationQuaternion(delta);
  if (![pivot.x, pivot.y, pivot.z].every(Number.isFinite)) throw new Error("Rotation pivot must be finite.");
  if (!selectionRotatable(scene, selections)) throw new Error("Select editable geometry or an actor to rotate.");
  if (Math.abs(q.w) > 1 - 1e-12) return project;
  const records = selectedRecordIds(scene, selections);
  const authored = project.version === 2 ? project.authoredRooms[scene.id] : undefined;
  const rotatePosition = (p: Vec3) => checkedPosition(rotatePoint(p, pivot, q));
  let next = project;
  if (authored && project.version === 2) {
    let room = { ...authored,
      actors: authored.actors.map(a => records.has(a.id) ? { ...a, position: rotatePosition(a.position), rotation: rotateNativeAngles(a.rotation, q) } : a),
      doors: authored.doors.map(d => records.has(`door:${d.id}`) ? { ...d, position: rotatePosition(d.position), rotation: rotateNativeAngles(d.rotation, q) } : d),
      entrances: authored.entrances.map(e => records.has(`entrance:${e.id}`) ? { ...e, position: rotatePosition(e.position) } : e),
    };
    for (const [id, indices] of selectedGeometryVertices(scene, selections)) {
      const mesh = room.meshes.find(mesh => mesh.id === id)!;
      const rotated = { ...mesh, vertices: mesh.vertices.map((v, index) => indices.has(index) ? { ...v, position: nativeVertexPosition(rotatePoint(v.position, pivot, q)) } : v) };
      room = replaceMesh(room, rotated, room.collisionMode === "authored" && followCollision);
    }
    next = { ...project, authoredRooms: { ...project.authoredRooms, [scene.id]: room } };
  } else if (selectedGeometryVertices(scene, selections).size) throw new Error("Editable geometry was not staged in the project.");
  const override = next.roomOverrides[String(scene.id)] ?? { actors: {}, events: {} };
  const actors = { ...override.actors }, events = { ...override.events };
  let changed = false;
  for (const id of records) {
    if (authored && (authored.actors.some(a => a.id === id) || authored.doors.some(d => `door:${d.id}` === id) || authored.entrances.some(e => `entrance:${e.id}` === id))) continue;
    const actor = scene.actors.find(a => a.id === id);
    if (actor) actors[id] = { ...actors[id], position: checkedActorPosition(actor as import("../shared/types").ActorData, rotatePoint(actor.position, pivot, q)), rotation: rotateNativeAngles(actor.rotation, q) };
    else {
      const event = scene.events.find(e => e.id === id)!;
      events[id] = { ...events[id], position: rotatePosition(event.position!) };
    }
    changed = true;
  }
  return { ...next, updatedAt: new Date().toISOString(), roomOverrides: changed ? { ...next.roomOverrides, [String(scene.id)]: { ...override, actors, events } } : next.roomOverrides };
}
