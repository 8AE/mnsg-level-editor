import type { ActorModel, ActorVisualPayload, AuthoredActor, EditorProjectV2, GeometryMesh, GeometryTexture, ProjectRoomScene, ProjectSceneActor, RoomSummary, Vec3 } from "../../shared/types";
import type { GeometryTranslationLookup } from "../project";
import type { AuthoringLookup } from "./project";
import { AUTHORING_LIMITS as LIMITS } from "./limits";
import { actorEvent, actorEventDetails } from "../rom/events";

function textureBytes(texture: GeometryTexture): number {
  if (!Number.isSafeInteger(texture.width) || !Number.isSafeInteger(texture.height) || texture.width < 1 || texture.height < 1 || texture.width * texture.height > LIMITS.texturePixels)
    throw new Error("Resolved texture exceeds the bounded native preview dimensions.");
  const bytes = texture.width * texture.height * 4;
  if (typeof texture.rgbaBase64 !== "string" || texture.rgbaBase64.length !== Math.ceil(bytes / 3) * 4 || !/^[a-zA-Z0-9+/]*={0,2}$/.test(texture.rgbaBase64))
    throw new Error("Resolved texture does not contain the expected bounded RGBA data.");
  return bytes;
}
function meshBytes(mesh: GeometryMesh): number {
  const arrays = [mesh.positions, mesh.indices, mesh.colors ?? [], mesh.uvs ?? [], mesh.normals ?? []];
  if (arrays.some(values => !Array.isArray(values) || values.some(value => typeof value !== "number" || !Number.isFinite(value))))
    throw new Error("Resolved mesh contains nonfinite or unsupported geometry data.");
  return arrays.reduce((sum, values) => sum + values.length * 8, 0);
}
export function assertDecodedBudget(meshes: GeometryMesh[], textures: GeometryTexture[], models: ActorModel[] = []): void {
  let bytes = meshes.reduce((sum, mesh) => sum + meshBytes(mesh), 0) + textures.reduce((sum, texture) => sum + textureBytes(texture), 0);
  for (const model of models) {
    bytes += model.meshes.reduce((sum, mesh) => sum + meshBytes(mesh), 0) + model.textures.reduce((sum, texture) => sum + textureBytes(texture), 0);
    bytes += model.nodes.reduce((sum, node) => sum + node.matrix.length * 8 + node.meshIndices.length * 8, 0);
  }
  if (bytes > LIMITS.sceneDecodedBytes) throw new Error("Composed scene exceeds the 64 MiB decoded preview budget.");
}
function authoredSummary(room: EditorProjectV2["authoredRooms"][string], lookup: AuthoringLookup): RoomSummary {
  const eventCount = room.actors.filter(actor => {
    const prototype = lookup.catalog.actorPrototypes.find(prototype => prototype.id === actor.prototypeId);
    return prototype && actorEventDetails({ actorId: prototype.actorId, parameters: actor.parameters });
  }).length;
  return { id: room.id, name: room.name, actorCount: room.actors.length, eventCount, geometryAvailable: room.meshes.some(mesh => mesh.indices.length > 0), warnings: [] };
}
export function listProjectRooms(project: EditorProjectV2, lookup: AuthoringLookup): RoomSummary[] {
  const summaries = new Map(lookup.nativeRooms.map(room => [room.id, structuredClone(room)]));
  for (const room of Object.values(project.authoredRooms)) summaries.set(room.id, authoredSummary(room, lookup));
  return [...summaries.values()].sort((a, b) => a.id - b.id);
}
function bounds(meshes: GeometryMesh[]): { min: Vec3; max: Vec3 } | undefined {
  const min = { x: Infinity, y: Infinity, z: Infinity }, max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const mesh of meshes) for (let at = 0; at < mesh.positions.length; at += 3) for (const [index, axis] of (["x", "y", "z"] as const).entries()) {
    min[axis] = Math.min(min[axis], mesh.positions[at + index]); max[axis] = Math.max(max[axis], mesh.positions[at + index]);
  }
  return Number.isFinite(min.x) ? { min, max } : undefined;
}

/** Takes an already validated project and resolves its scene without mutating it. */
export function composeProjectRoom(project: EditorProjectV2, roomId: number, lookup: AuthoringLookup, getTranslation?: GeometryTranslationLookup): ProjectRoomScene {
  const authored = project.authoredRooms[String(roomId)];
  if (!authored) {
    if (!lookup.nativeRooms.some(room => room.id === roomId)) throw new Error("Room is absent from the validated project and native catalog.");
    const native = structuredClone(lookup.loadRoom(roomId));
    const override = project.roomOverrides[String(roomId)];
    native.actors = native.actors.map(actor => ({ ...actor, ...structuredClone(override?.actors[actor.id] ?? {}) }));
    // Derived behavior must follow effective type/parameters as well as position.
    // Independent events retain their original records unchanged.
    native.events = [...native.events.filter(event => !event.actorRef), ...native.actors.flatMap(actor => {
      const event = actorEvent(actor); return event ? [event] : [];
    })];
    native.eventCount = native.events.length;
    let translation: Vec3 | undefined;
    for (const [key, edits] of Object.entries(project.roomOverrides)) if (edits.geometry) {
      const affected = Number(key) === roomId || getTranslation?.(Number(key), edits.geometry.translation).affectedRoomIds.includes(roomId);
      if (affected) translation = edits.geometry.translation;
    }
    if (translation) {
      for (const mesh of native.meshes) mesh.positions = mesh.positions.map((coordinate, index) => coordinate + translation![("xyz"[index % 3]) as keyof Vec3]);
      native.bounds = bounds(native.meshes);
    }
    const skyboxId = lookup.nativeRoomSkyboxId(roomId), skybox = skyboxId ? structuredClone(lookup.loadSkyboxAsset(skyboxId)) : undefined;
    assertDecodedBudget(native.meshes, [...(native.textures ?? []), ...(skybox ? [skybox.texture] : [])]);
    return { ...native, kind: "native", authoredMeshes: [], collisionMode: "template", ...(translation ? { collisionTranslation: structuredClone(translation) } : {}), collision: [], doors: [], entrances: lookup.catalog.nativeEntrances.filter(entrance => entrance.roomId === roomId).map(({ roomId: _id, ...entrance }) => structuredClone(entrance)), ...(skybox ? { skybox } : {}) };
  }
  const resolved = new Map<string, ReturnType<AuthoringLookup["resolveMaterial"]>>();
  const textures = new Map<string, GeometryTexture>();
  for (const material of authored.materials) {
    const asset = lookup.resolveMaterial(material.sourceMaterialId);
    for (const texture of asset.textures) {
      textureBytes(texture);
      const previous = textures.get(texture.id);
      if (previous && (previous.width !== texture.width || previous.height !== texture.height || previous.rgbaBase64 !== texture.rgbaBase64)) throw new Error("Resolved texture IDs contain contradictory payloads.");
      textures.set(texture.id, texture);
    }
    if (asset.material.textureId && !textures.has(asset.material.textureId)) throw new Error("Resolved material texture is absent from its trusted asset.");
    resolved.set(material.id, asset);
  }
  const meshes: GeometryMesh[] = authored.meshes.map(mesh => {
    const asset = resolved.get(mesh.materialId);
    if (!asset) throw new Error("Authored mesh material was not resolved.");
    return { id: mesh.id, materialId: mesh.materialId, source: "display-list", positions: mesh.vertices.flatMap(vertex => [vertex.position.x, vertex.position.y, vertex.position.z]), indices: [...mesh.indices],
      uvs: mesh.vertices.flatMap(vertex => vertex.uv), colors: mesh.vertices.flatMap(vertex => vertex.color.map(channel => channel / 255)), colorItemSize: 4, material: { ...structuredClone(asset.material), vertexColors: true, lighting: false } };
  });
  for (const triangle of authored.collision) meshes.push({ id: `authored-collision:${triangle.id}`, source: "collision", positions: triangle.vertices.flatMap(vertex => [vertex.x, vertex.y, vertex.z]), indices: [0, 1, 2] });
  const prototypes = new Map(lookup.catalog.actorPrototypes.map(prototype => [prototype.id, prototype]));
  const actors: ProjectSceneActor[] = authored.actors.map((actor, index) => {
    const prototype = prototypes.get(actor.prototypeId);
    if (!prototype) throw new Error("Authored actor prototype was not resolved.");
    const policy = actor.spawnPolicy ?? (prototype.sourceKind === "partition" ? "proximity" : "resident");
    return { ...structuredClone(actor), index, actorId: prototype.actorId, name: prototype.name, sourceKind: policy === "proximity" ? "partition" : "resident", editable: true };
  });
  const events = actors.flatMap(actor => {
    const details = actorEventDetails(actor);
    return details ? [{ ...details, id: `event:${actor.id}`, actorRef: actor.id, index: actor.index, position: structuredClone(actor.position), values: [...actor.parameters], editable: false }] : [];
  });
  const skyboxId = authored.skyboxId === undefined ? lookup.nativeRoomSkyboxId(authored.templateRoomId) : authored.skyboxId;
  const skybox = skyboxId ? structuredClone(lookup.loadSkyboxAsset(skyboxId)) : undefined;
  if (skybox) textureBytes(skybox.texture);
  const warnings = authored.kind === "new" && !lookup.catalog.roomAdmission.supported ? [lookup.catalog.roomAdmission.reason ?? "Native room admission is pending; this room cannot be exported until the registry-aware hooks are available."] : [];
  if (authored.collisionMode === "template") warnings.push(`Native collision from template room ${authored.templateRoomId} is preserved. Visual mesh edits do not change its physics.`);
  assertDecodedBudget(meshes, [...textures.values(), ...(skybox ? [skybox.texture] : [])]);
  return { ...authoredSummary(authored, lookup), kind: authored.kind, actors, events, meshes, textures: structuredClone([...textures.values()]), warnings,
    authoredMeshes: structuredClone(authored.meshes), collisionMode: authored.collisionMode, ...(authored.collisionTranslation ? { collisionTranslation: structuredClone(authored.collisionTranslation) } : {}), collision: structuredClone(authored.collision), doors: structuredClone(authored.doors), entrances: structuredClone(authored.entrances), bounds: bounds(meshes), ...(skybox ? { skybox } : {}) };
}

export function composeProjectActorVisuals(project: EditorProjectV2, roomId: number, lookup: AuthoringLookup, loadNativeVisuals: (id: number, overrides: EditorProjectV2["roomOverrides"][string]["actors"]) => ActorVisualPayload): ActorVisualPayload {
  const room = project.authoredRooms[String(roomId)];
  if (!room) {
    if (!lookup.nativeRooms.some(room => room.id === roomId)) throw new Error("Actor preview room is absent from the native catalog.");
    const payload = loadNativeVisuals(roomId, project.roomOverrides[String(roomId)]?.actors ?? {});
    assertDecodedBudget([], [], payload.actorModels); return payload;
  }
  const models = new Map<string, ActorModel>(), actorVisuals: ActorVisualPayload["actorVisuals"] = [];
  const siblings = room.actors.map(({ prototypeId, parameters, position, rotation }) => ({ prototypeId, parameters: structuredClone(parameters), position: structuredClone(position), rotation: structuredClone(rotation) }));
  const appearances = room.doors.filter(door => door.appearancePrototypeId).map(door => ({ id: `door:${door.id}`, prototypeId: door.appearancePrototypeId!, position: door.position, rotation: door.rotation }));
  for (const actor of [...room.actors, ...appearances]) {
    const prototype = lookup.catalog.actorPrototypes.find(prototype => prototype.id === actor.prototypeId);
    if (!prototype) throw new Error("Actor preview prototype is absent from the trusted catalog.");
    const edits = { position: actor.position, rotation: actor.rotation, parameters: "parameters" in actor ? (actor as AuthoredActor).parameters : prototype.parameters };
    const payload = lookup.loadActorPrototypeForRoom
      ? lookup.loadActorPrototypeForRoom(actor.prototypeId, edits, { roomId: room.id, templateRoomId: room.templateRoomId, siblings })
      : lookup.loadActorPrototype(actor.prototypeId, edits);
    if (payload.actorVisuals.length !== 1) throw new Error("Native actor prototype preview did not return exactly one placement.");
    actorVisuals.push({ ...structuredClone(payload.actorVisuals[0]), actorRef: actor.id });
    for (const model of payload.actorModels) models.set(model.id, model);
    if (models.size > 256 || [...models.values()].reduce((sum, model) => sum + model.meshes.reduce((sum, mesh) => sum + mesh.indices.length / 3, 0), 0) > 200000) throw new Error("Authored actor preview exceeds its model or triangle budget.");
  }
  const actorModels = [...models.values()]; assertDecodedBudget([], [], actorModels);
  return { actorVisuals, actorModels: structuredClone(actorModels) };
}
