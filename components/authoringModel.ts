import type {
  ActorPrototype,
  AuthoredMesh,
  AuthoredRoom,
  AuthoringCatalog,
  EditorProject,
  EditorProjectV2,
  GeometryAssetPayload,
  ProjectRoomScene,
  Vec3,
} from "../shared/types";
import {
  nativeVertexPosition,
  triangleAreaSquared,
  transformMesh,
  type MeshTransform,
} from "./authoringState";
export const newId = (prefix: string) => `${prefix}:${crypto.randomUUID()}`;
export function canonicalProject(project: EditorProject): EditorProjectV2 {
  return project.version === 2
    ? project
    : { ...project, version: 2, authoredRooms: {} };
}
export function updateAuthoredRoom(
  project: EditorProject,
  room: AuthoredRoom,
  affectedRoomIds: number[] = [],
): EditorProjectV2 {
  const next = canonicalProject(project),
    roomOverrides = { ...next.roomOverrides };
  const owned = roomOverrides[room.id]?.geometry;
  delete roomOverrides[room.id];
  if (owned) {
    const alias = affectedRoomIds.find(
      (id) => id !== room.id && !next.authoredRooms[id],
    );
    if (alias !== undefined) {
      const prior = roomOverrides[alias] ?? { actors: {}, events: {} };
      roomOverrides[alias] = { ...prior, geometry: structuredClone(owned) };
    }
  }
  return {
    ...next,
    updatedAt: new Date().toISOString(),
    authoredRooms: { ...next.authoredRooms, [room.id]: room },
    roomOverrides,
  };
}
export function availableRoomId(
  project: EditorProject,
  catalog: AuthoringCatalog,
): number {
  const authored = canonicalProject(project).authoredRooms;
  for (
    let id = catalog.roomAdmission.minId;
    id <= catalog.roomAdmission.maxId;
    id++
  )
    if (!authored[id]) return id;
  throw new Error("All available new room IDs are in use.");
}
export function emptyRoom(
  id: number,
  name: string,
  templateRoomId: number,
  kind: AuthoredRoom["kind"] = "new",
): AuthoredRoom {
  return {
    id,
    name,
    templateRoomId,
    kind,
    meshes: [],
    materials: [],
    collisionMode: kind === "replacement" ? "template" : "authored",
    collision: [],
    actors: [],
    doors: [],
    entrances: [
      {
        id: newId("entrance"),
        name: "Start",
        position: { x: 0, y: 0, z: 0 },
        baseYaw: 0,
        entryParameter: 16,
      },
    ],
  };
}
export function insertGeometry(
  room: AuthoredRoom,
  asset: GeometryAssetPayload,
  position: Vec3,
): AuthoredRoom {
  const coordinates = asset.meshes
    .filter((m) => m.source === "display-list")
    .flatMap((m) => m.positions);
  const min = { x: Infinity, y: Infinity, z: Infinity },
    max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (let i = 0; i < coordinates.length; i += 3)
    for (const [n, axis] of (["x", "y", "z"] as const).entries()) {
      min[axis] = Math.min(min[axis], coordinates[i + n]);
      max[axis] = Math.max(max[axis], coordinates[i + n]);
    }
  const delta = Number.isFinite(min.x)
    ? {
        x: position.x - (min.x + max.x) / 2,
        y: position.y - min.y,
        z: position.z - (min.z + max.z) / 2,
      }
    : position;
  const nativeSources = new Map(
    asset.vertexSources.map((source) => [source.id, source]),
  );
  const materials = [...room.materials],
    ids = new Map<string, string>();
  const meshes = asset.meshes
    .filter((m) => m.source === "display-list")
    .map((source, meshIndex) => {
      if (!source.materialId)
        throw new Error(
          "This native surface has no trusted material library entry.",
        );
      let material = materials.find(
        (m) => m.sourceMaterialId === source.materialId,
      );
      if (!material) {
        material = {
          id: newId("material"),
          sourceMaterialId: source.materialId,
        };
        materials.push(material);
      }
      const id = newId("mesh");
      ids.set(source.id, id);
      const stride = source.colorItemSize ?? 3;
      const vertices = Array.from(
        { length: source.positions.length / 3 },
        (_, i) => ({
          position: nativeVertexPosition({
            x: Math.round(source.positions[i * 3] + delta.x),
            y: Math.round(source.positions[i * 3 + 1] + delta.y),
            z: Math.round(source.positions[i * 3 + 2] + delta.z),
          }),
          uv: [source.uvs?.[i * 2] ?? 0, source.uvs?.[i * 2 + 1] ?? 0] as [
            number,
            number,
          ],
          color: [0, 1, 2, 3].map((c) => {
            if (c === 3 && stride === 3) {
              const record = nativeSources.get(
                asset.vertexRefs[meshIndex]?.[i],
              );
              return record?.source.expectedHex.length === 32
                ? parseInt(record.source.expectedHex.slice(30, 32), 16)
                : 255;
            }
            if (c < 3 && !source.material?.vertexColors && stride === 3)
              return 255;
            return Math.round((source.colors?.[i * stride + c] ?? 1) * 255);
          }) as [number, number, number, number],
        }),
      );
      return {
        id,
        vertices,
        indices: [...source.indices],
        materialId: material.id,
        sourceAssetId: asset.id || undefined,
      };
    });
  const collision = asset.collision.map((t) => ({
    ...t,
    id: newId("collision"),
    sourceMeshId: t.sourceMeshId ? ids.get(t.sourceMeshId) : undefined,
    vertices: t.vertices.map((v) =>
      nativeVertexPosition({
        x: Math.round(v.x + delta.x),
        y: Math.round(v.y + delta.y),
        z: Math.round(v.z + delta.z),
      }),
    ) as [Vec3, Vec3, Vec3],
  }));
  return {
    ...room,
    meshes: [...room.meshes, ...meshes],
    materials,
    collision: [...room.collision, ...collision],
  };
}
export function cloneScene(
  scene: ProjectRoomScene,
  catalog: AuthoringCatalog,
  id: number,
  name: string,
  kind: AuthoredRoom["kind"],
  nativeAsset?: GeometryAssetPayload,
): AuthoredRoom {
  let room = emptyRoom(id, name, scene.id, kind);
  const sources = scene.meshes.filter((m) => m.source === "display-list");
  // Insert at original bounds origin, preserving every native coordinate.
  const minY = Math.min(
    0,
    ...sources.flatMap((m) => m.positions.filter((_, i) => i % 3 === 1)),
  );
  const xs = sources.flatMap((m) => m.positions.filter((_, i) => i % 3 === 0)),
    zs = sources.flatMap((m) => m.positions.filter((_, i) => i % 3 === 2));
  const center = {
    x: xs.length ? (Math.min(...xs) + Math.max(...xs)) / 2 : 0,
    y: minY,
    z: zs.length ? (Math.min(...zs) + Math.max(...zs)) / 2 : 0,
  };
  // Asset insertion translates by its own bottom; use exact bottom, not zero.
  if (sources.length)
    center.y = Math.min(
      ...sources.flatMap((m) => m.positions.filter((_, i) => i % 3 === 1)),
    );
  room = insertGeometry(
    room,
    {
      id: catalog.geometry.find((a) => a.roomIds.includes(scene.id))?.id ?? "",
      meshes: sources,
      textures: scene.textures ?? [],
      vertexRefs: nativeAsset?.vertexRefs ?? [],
      vertexSources: nativeAsset?.vertexSources ?? [],
      collision: scene.collision,
      warnings: [],
    },
    center,
  );
  room.collisionMode =
    scene.kind === "native" ? "template" : scene.collisionMode;
  room.collisionTranslation = scene.collisionTranslation
    ? { ...scene.collisionTranslation }
    : undefined;
  if (room.collisionMode === "template") room.collision = [];
  room.actors = scene.actors.map((actor) => {
    const definition = actor.definitionSource?.expectedHex;
    const halfword =
      definition && definition.length >= 8
        ? parseInt(definition.slice(4, 8), 16)
        : undefined;
    const prototype =
      catalog.actorPrototypes.find(
        (p) =>
          p.actorId === actor.actorId &&
          p.sourceRoomId === scene.id &&
          p.sourceActorRef === actor.id &&
          (halfword === undefined || p.unknownHalfword === halfword),
      ) ??
      catalog.actorPrototypes.find(
        (p) =>
          p.actorId === actor.actorId &&
          (halfword === undefined || p.unknownHalfword === halfword),
      );
    if (!prototype)
      throw new Error(`No verified actor prototype for ${actor.name}.`);
    return {
      id: newId("actor"),
      prototypeId: prototype.id,
      position: { ...actor.position },
      rotation: { ...actor.rotation },
      parameters: [...actor.parameters] as [number, number, number],
      spawnPolicy: actor.sourceKind === "partition" ? "proximity" : "resident",
    };
  });
  room.entrances = scene.entrances.length
    ? scene.entrances.map((e) => ({
        ...structuredClone(e),
        id: kind === "replacement" ? e.id : newId("entrance"),
      }))
    : room.entrances;
  if (scene.skybox) room.skyboxId = scene.skybox.id;
  return room;
}
export function addActor(
  room: AuthoredRoom,
  prototype: ActorPrototype,
  position: Vec3,
): AuthoredRoom {
  return {
    ...room,
    actors: [
      ...room.actors,
      {
        id: newId("actor"),
        prototypeId: prototype.id,
        position: nativeVertexPosition(position),
        rotation: { x: 0, y: 0, z: 0 },
        parameters: [...prototype.parameters],
        spawnPolicy:
          prototype.sourceKind === "partition" ? "proximity" : "resident",
      },
    ],
  };
}
/** Linked collision follows edits explicitly; unlinked native planes are preserved. */
export function replaceMesh(
  room: AuthoredRoom,
  mesh: AuthoredMesh,
  followCollision: boolean,
  classifier = 1,
  surface = 0,
): AuthoredRoom {
  const faces = Array.from({ length: mesh.indices.length / 3 }, (_, i) =>
    mesh.indices.slice(i * 3, i * 3 + 3),
  );
  const validFaces = faces.filter(
    (face) => triangleAreaSquared(mesh, face) > 0,
  );
  const previous = room.meshes.find((m) => m.id === mesh.id);
  const oldDegenerate = previous
    ? Array.from({ length: previous.indices.length / 3 }, (_, i) =>
        previous.indices.slice(i * 3, i * 3 + 3),
      ).filter((face) => !triangleAreaSquared(previous, face)).length
    : 0;
  if (followCollision && faces.length - validFaces.length > oldDegenerate)
    throw new Error(
      "Authored collision requires nondegenerate triangles. Disable linked collision for this visual edit, or repair the triangle.",
    );
  const linked = room.collision.filter((t) => t.sourceMeshId === mesh.id);
  const collision = followCollision
    ? [
        ...room.collision.filter((t) => t.sourceMeshId !== mesh.id),
        ...Array.from({ length: validFaces.length }, (_, i) => ({
          id: linked[i]?.id ?? newId("collision"),
          sourceMeshId: mesh.id,
          classifier: linked[i]?.classifier ?? classifier,
          surface: linked[i]?.surface ?? surface,
          vertices: validFaces[i].map((index) => ({
            ...mesh.vertices[index].position,
          })) as [Vec3, Vec3, Vec3],
        })),
      ]
    : room.collision;
  return {
    ...room,
    meshes: room.meshes.map((m) => (m.id === mesh.id ? mesh : m)),
    collisionMode: followCollision ? "authored" : room.collisionMode,
    collisionTranslation: followCollision
      ? undefined
      : room.collisionTranslation,
    collision,
  };
}
export function transformAuthoredMesh(
  room: AuthoredRoom,
  mesh: AuthoredMesh,
  transform: MeshTransform,
  followCollision: boolean,
): AuthoredRoom {
  return replaceMesh(room, transformMesh(mesh, transform), followCollision);
}

/** Room-local IDs remain stable; self-linked doors follow the cloned room. */
export function cloneAuthoredRoom(
  room: AuthoredRoom,
  id: number,
  name: string,
): AuthoredRoom {
  const copy = structuredClone(room);
  return {
    ...copy,
    id,
    name,
    kind: "new",
    doors: copy.doors.map((door) => ({
      ...door,
      destination:
        door.destination.roomId === room.id
          ? { ...door.destination, roomId: id }
          : door.destination,
    })),
  };
}

export function generateRoomCollision(
  room: AuthoredRoom,
  classifier = 1,
  surface = 0,
): { room: AuthoredRoom; skipped: number } {
  let next: AuthoredRoom = {
    ...room,
    collisionMode: "authored",
    collisionTranslation: undefined,
    collision: [],
  };
  let skipped = 0;
  for (const mesh of room.meshes) {
    const indices: number[] = [];
    for (let i = 0; i < mesh.indices.length; i += 3) {
      const face = mesh.indices.slice(i, i + 3);
      if (triangleAreaSquared(mesh, face) > 0) indices.push(...face);
      else skipped++;
    }
    next = replaceMesh(
      {
        ...next,
        meshes: next.meshes.map((m) =>
          m.id === mesh.id ? { ...mesh, indices } : m,
        ),
      },
      { ...mesh, indices },
      true,
      classifier,
      surface,
    );
  }
  return { room: { ...next, meshes: room.meshes }, skipped };
}
