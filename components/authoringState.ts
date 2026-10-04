import * as THREE from "three";
import type { Vec3 } from "../shared/types";

/** Structural geometry operations preserve each caller's material/source fields. */
export interface EditableVertex {
  position: Vec3;
  uv: [number, number];
  color: [number, number, number, number];
}
export interface EditableMesh<V extends EditableVertex = EditableVertex> {
  id: string;
  vertices: V[];
  indices: number[];
}
export type GeometrySelection =
  | { meshId: string; mode: "mesh" }
  | { meshId: string; mode: "vertex"; vertexIndex: number }
  | { meshId: string; mode: "face"; faceIndex: number };
export interface MeshTransform {
  translation?: Vec3;
  rotationDegrees?: Vec3;
  scale?: Vec3;
  pivot?: Vec3;
}
export interface DocumentHistory<T> {
  present: T;
  past: T[];
  future: T[];
  savedFingerprint: string;
}

export function documentFingerprint<T>(document: T): string {
  return JSON.stringify(document, (key, value: unknown) =>
    key === "updatedAt" ? undefined : value,
  );
}
export function createDocumentHistory<T>(document: T): DocumentHistory<T> {
  return {
    present: document,
    past: [],
    future: [],
    savedFingerprint: documentFingerprint(document),
  };
}
export function transactDocument<T>(
  history: DocumentHistory<T>,
  next: T,
): DocumentHistory<T> {
  if (documentFingerprint(next) === documentFingerprint(history.present))
    return history;
  return {
    ...history,
    present: next,
    past: [...history.past.slice(-99), history.present],
    future: [],
  };
}
export function undoDocument<T>(
  history: DocumentHistory<T>,
): DocumentHistory<T> {
  const previous = history.past.at(-1);
  if (!previous) return history;
  return {
    ...history,
    present: previous,
    past: history.past.slice(0, -1),
    future: [history.present, ...history.future],
  };
}
export function redoDocument<T>(
  history: DocumentHistory<T>,
): DocumentHistory<T> {
  const next = history.future[0];
  if (!next) return history;
  return {
    ...history,
    present: next,
    past: [...history.past, history.present],
    future: history.future.slice(1),
  };
}
export function markDocumentSaved<T>(
  history: DocumentHistory<T>,
): DocumentHistory<T> {
  return { ...history, savedFingerprint: documentFingerprint(history.present) };
}

export function nativeVertexPosition(value: Vec3): Vec3 {
  const result = { ...value };
  for (const axis of ["x", "y", "z"] as const)
    if (
      !Number.isInteger(result[axis]) ||
      result[axis] < -32768 ||
      result[axis] > 32767
    )
      throw new Error(
        "Vertex coordinates must be integers between -32768 and 32767.",
      );
  return result;
}
export function meshCenter(mesh: EditableMesh): Vec3 {
  if (!mesh.vertices.length) return { x: 0, y: 0, z: 0 };
  const bounds = new THREE.Box3();
  mesh.vertices.forEach((vertex) =>
    bounds.expandByPoint(
      new THREE.Vector3(
        vertex.position.x,
        vertex.position.y,
        vertex.position.z,
      ),
    ),
  );
  const center = bounds.getCenter(new THREE.Vector3());
  return { x: center.x, y: center.y, z: center.z };
}
function vertexIndex(mesh: EditableMesh, index: number): void {
  if (!Number.isInteger(index) || index < 0 || index >= mesh.vertices.length)
    throw new Error("Choose a vertex that exists in this mesh.");
}
function faceIndex(mesh: EditableMesh, index: number): void {
  if (
    !Number.isInteger(index) ||
    index < 0 ||
    index * 3 + 2 >= mesh.indices.length
  )
    throw new Error("Choose a triangle that exists in this mesh.");
}
export function triangleAreaSquared(
  mesh: EditableMesh,
  indices: number[],
): number {
  const [a, b, c] = indices.map((i) => mesh.vertices[i].position);
  return new THREE.Vector3(b.x - a.x, b.y - a.y, b.z - a.z)
    .cross(new THREE.Vector3(c.x - a.x, c.y - a.y, c.z - a.z))
    .lengthSq();
}
function triangle(
  mesh: EditableMesh,
  values: number[],
  requireArea = false,
): void {
  if (values.length !== 3 || new Set(values).size !== 3)
    throw new Error("A triangle needs three different vertex indices.");
  values.forEach((index) => vertexIndex(mesh, index));
  if (requireArea && !triangleAreaSquared(mesh, values))
    throw new Error("A new triangle cannot be collinear or overlapping.");
}

export function editVertex<M extends EditableMesh>(
  mesh: M,
  index: number,
  position: Vec3,
): M {
  vertexIndex(mesh, index);
  const checked = nativeVertexPosition(position);
  const vertices = mesh.vertices.map((vertex, at) =>
    at === index ? { ...vertex, position: checked } : vertex,
  );
  const next = { ...mesh, vertices };
  for (let at = 0; at < mesh.indices.length; at += 3)
    if (mesh.indices.slice(at, at + 3).includes(index))
      triangle(next, mesh.indices.slice(at, at + 3));
  return next;
}
export function addVertex<M extends EditableMesh>(
  mesh: M,
  vertex: M["vertices"][number],
): M {
  return {
    ...mesh,
    vertices: [
      ...mesh.vertices,
      {
        ...vertex,
        position: nativeVertexPosition(vertex.position),
        uv: [...vertex.uv],
        color: [...vertex.color],
      },
    ],
  };
}
export function editFace<M extends EditableMesh>(
  mesh: M,
  index: number,
  indices: number[],
): M {
  faceIndex(mesh, index);
  triangle(mesh, indices, true);
  const next = mesh.indices.slice();
  next.splice(index * 3, 3, ...indices);
  return { ...mesh, indices: next };
}
export function addFace<M extends EditableMesh>(mesh: M, indices: number[]): M {
  triangle(mesh, indices, true);
  return { ...mesh, indices: [...mesh.indices, ...indices] };
}
export function removeFace<M extends EditableMesh>(mesh: M, index: number): M {
  faceIndex(mesh, index);
  const indices = mesh.indices.slice();
  indices.splice(index * 3, 3);
  return { ...mesh, indices };
}
export function removeVertex<M extends EditableMesh>(
  mesh: M,
  index: number,
): M {
  vertexIndex(mesh, index);
  const indices: number[] = [];
  for (let at = 0; at < mesh.indices.length; at += 3) {
    const face = mesh.indices.slice(at, at + 3);
    if (!face.includes(index))
      indices.push(...face.map((value) => (value > index ? value - 1 : value)));
  }
  return {
    ...mesh,
    vertices: mesh.vertices.filter((_, at) => at !== index),
    indices,
  };
}

export function transformMesh<M extends EditableMesh>(
  mesh: M,
  transform: MeshTransform,
): M {
  const translation = transform.translation ?? { x: 0, y: 0, z: 0 },
    rotation = transform.rotationDegrees ?? { x: 0, y: 0, z: 0 },
    scale = transform.scale ?? { x: 1, y: 1, z: 1 },
    pivot = transform.pivot ?? meshCenter(mesh);
  if (
    ![translation, rotation, scale, pivot].every((vector) =>
      Object.values(vector).every(Number.isFinite),
    )
  )
    throw new Error("Mesh transforms must contain finite values.");
  if (!scale.x || !scale.y || !scale.z)
    throw new Error("A mesh cannot be scaled to zero.");
  const matrix = new THREE.Matrix4()
    .makeTranslation(
      pivot.x + translation.x,
      pivot.y + translation.y,
      pivot.z + translation.z,
    )
    .multiply(
      new THREE.Matrix4().makeRotationFromEuler(
        new THREE.Euler(
          ...([rotation.x, rotation.y, rotation.z].map(
            THREE.MathUtils.degToRad,
          ) as [number, number, number]),
          "XYZ",
        ),
      ),
    )
    .multiply(new THREE.Matrix4().makeScale(scale.x, scale.y, scale.z))
    .multiply(
      new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z),
    );
  const vertices = mesh.vertices.map((vertex) => {
    const point = new THREE.Vector3(
      vertex.position.x,
      vertex.position.y,
      vertex.position.z,
    ).applyMatrix4(matrix);
    return {
      ...vertex,
      position: nativeVertexPosition({
        x: Math.round(point.x),
        y: Math.round(point.y),
        z: Math.round(point.z),
      }),
    };
  });
  const indices = mesh.indices.slice();
  if (matrix.determinant() < 0)
    for (let at = 0; at < indices.length; at += 3)
      [indices[at + 1], indices[at + 2]] = [indices[at + 2], indices[at + 1]];
  const next = { ...mesh, vertices, indices };
  for (let at = 0; at < indices.length; at += 3) {
    triangle(next, indices.slice(at, at + 3));
    if (
      triangleAreaSquared(mesh, mesh.indices.slice(at, at + 3)) > 0 &&
      !triangleAreaSquared(next, indices.slice(at, at + 3))
    )
      throw new Error(
        "Quantization collapsed a previously valid triangle. Choose a larger scale.",
      );
  }
  return next;
}

export function moveGeometrySelection<M extends EditableMesh>(
  mesh: M,
  selection: GeometrySelection | null,
  target: Vec3,
): M {
  if (selection?.mode === "vertex")
    return editVertex(mesh, selection.vertexIndex, target);
  if (selection?.mode === "face") {
    faceIndex(mesh, selection.faceIndex);
    const indices = mesh.indices.slice(
      selection.faceIndex * 3,
      selection.faceIndex * 3 + 3,
    );
    const center = indices.reduce(
      (p, i) => ({
        x: p.x + mesh.vertices[i].position.x / 3,
        y: p.y + mesh.vertices[i].position.y / 3,
        z: p.z + mesh.vertices[i].position.z / 3,
      }),
      { x: 0, y: 0, z: 0 },
    );
    return {
      ...mesh,
      vertices: mesh.vertices.map((v, i) =>
        indices.includes(i)
          ? {
              ...v,
              position: nativeVertexPosition({
                x: Math.round(v.position.x + target.x - center.x),
                y: Math.round(v.position.y + target.y - center.y),
                z: Math.round(v.position.z + target.z - center.z),
              }),
            }
          : v,
      ),
    };
  }
  const center = meshCenter(mesh);
  return transformMesh(mesh, {
    translation: {
      x: target.x - center.x,
      y: target.y - center.y,
      z: target.z - center.z,
    },
  });
}
