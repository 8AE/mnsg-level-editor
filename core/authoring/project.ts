import type { ActorPrototypeEdits, ActorVisualPayload, AuthoredActor, AuthoredRoom, AuthoringCatalog, GeometryMesh, GeometryTexture, RoomData, RoomSummary, SkyboxAssetPayload, Vec3 } from "../../shared/types";
import { AUTHORING_LIMITS as LIMITS } from "./limits";
import type { GeometryTranslationLookup } from "../project";

/** Only the ROM backend supplies these callbacks; project JSON cannot supply them. */
export interface AuthoringActorContext {
  roomId: number;
  templateRoomId?: number;
  /** Complete validated authored spawn order, including the current placement. */
  siblings?: Pick<AuthoredActor, "prototypeId" | "parameters" | "position" | "rotation">[];
}
export interface AuthoringLookup {
  catalog: AuthoringCatalog;
  nativeRooms: RoomSummary[];
  loadRoom(id: number): RoomData;
  resolveMaterial(id: string): { material: NonNullable<GeometryMesh["material"]>; textures: GeometryTexture[] };
  loadActorPrototype(id: string, edits?: ActorPrototypeEdits): ActorVisualPayload;
  /** Internal validated scene context; never supplied by project JSON or IPC. */
  loadActorPrototypeForRoom?(id: string, edits: ActorPrototypeEdits, context: AuthoringActorContext): ActorVisualPayload;
  loadSkyboxAsset(id: string): SkyboxAssetPayload;
  nativeRoomSkyboxId(id: number): string | undefined;
}
export function plain(input: unknown, label: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input)))
    throw new Error(`${label} must be a plain object.`);
  return input as Record<string, unknown>;
}
export function exactKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${label} contains unsupported field ${key}.`);
}
export function number(input: unknown, min: number, max: number, label: string, integer = true): number {
  if (typeof input !== "number" || !Number.isFinite(input) || (integer && !Number.isSafeInteger(input)) || input < min || input > max)
    throw new Error(`${label} must be a ${integer ? "bounded integer" : "finite bounded number"} in ${min}..${max}.`);
  return input;
}
export function resourceId(input: unknown, label: string): string {
  if (typeof input !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,191}$/.test(input) || ["__proto__", "constructor", "prototype"].includes(input))
    throw new Error(`${label} must be a stable data ID, not a path or pointer.`);
  return input;
}
function name(input: unknown, label: string): string {
  if (typeof input !== "string" || !input.trim() || input.length > 120 || /[\u0000-\u001f]/.test(input)) throw new Error(`${label} is invalid.`);
  return input;
}
export function nativeVector(input: unknown, label: string, min = -32768, max = 32767): Vec3 {
  const value = plain(input, label); exactKeys(value, ["x", "y", "z"], label);
  return { x: number(value.x, min, max, `${label}.x`), y: number(value.y, min, max, `${label}.y`), z: number(value.z, min, max, `${label}.z`) };
}
function array(input: unknown, limit: number, label: string): unknown[] {
  if (!Array.isArray(input) || input.length > limit) throw new Error(`${label} exceeds its ${limit}-item limit or is not an array.`);
  return input;
}
function tuple(input: unknown, count: number, label: string): unknown[] {
  const values = array(input, count, label);
  if (values.length !== count) throw new Error(`${label} must contain exactly ${count} values.`);
  return values;
}
export function parameters(input: unknown): [number, number, number] {
  return tuple(input, 3, "Actor parameters").map((n, i) => number(n, 0, 0xffffffff, `Parameter ${i}`)) as [number, number, number];
}
export function validatePrototypeEdits(input: unknown): ActorPrototypeEdits {
  if (input === undefined) return {};
  const value = plain(input, "Actor prototype edits"); exactKeys(value, ["parameters", "position", "rotation"], "Actor prototype edits");
  return { ...(value.parameters === undefined ? {} : { parameters: parameters(value.parameters) }), ...(value.position === undefined ? {} : { position: nativeVector(value.position, "Prototype position") }), ...(value.rotation === undefined ? {} : { rotation: nativeVector(value.rotation, "Prototype rotation") }) };
}
function distinct(id: string, seen: Set<string>, label: string): string {
  if (seen.has(id)) throw new Error(`Duplicate ${label} ID ${id}.`);
  seen.add(id); return id;
}
function nondegenerate(vertices: Vec3[], label: string): void {
  const [a, b, c] = vertices;
  const u = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z }, v = { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z };
  if (u.y * v.z - u.z * v.y === 0 && u.z * v.x - u.x * v.z === 0 && u.x * v.y - u.y * v.x === 0)
    throw new Error(`${label} is degenerate.`);
}

/** Validates all rooms first, then cross-room door destinations. No input mutation. */
export function validateAuthoredRooms(input: unknown, lookup?: AuthoringLookup, getTranslation?: GeometryTranslationLookup): Record<string, AuthoredRoom> {
  const values = plain(input, "Authored rooms"), result: Record<string, AuthoredRoom> = {};
  if (Object.keys(values).length > LIMITS.rooms) throw new Error("Too many authored rooms.");
  if (!Object.keys(values).length) return result;
  if (!lookup) throw new Error("Authored rooms require the trusted ROM asset catalog.");
  const nativeIds = new Set(lookup.nativeRooms.map(room => room.id));
  const prototypes = new Set(lookup.catalog.actorPrototypes.map(asset => asset.id));
  const materials = new Set(lookup.catalog.materials.map(asset => asset.id));
  const geometry = new Set(lookup.catalog.geometry.map(asset => asset.id));
  const skyboxes = new Set(lookup.catalog.skyboxes.map(asset => asset.id));
  const surfaces = new Map(lookup.catalog.surfaces.map(asset => [asset.id, asset]));
  for (const [key, raw] of Object.entries(values)) {
    if (!/^(0|[1-9]\d*)$/.test(key)) throw new Error("Authored room keys must be canonical decimal IDs.");
    const room = plain(raw, "Authored room");
    exactKeys(room, ["id", "name", "kind", "templateRoomId", "meshes", "materials", "collisionMode", "collisionTranslation", "collision", "actors", "doors", "entrances", "skyboxId"], "Authored room");
    const id = number(room.id, 0, 799, "Authored room ID");
    if (String(id) !== key) throw new Error("Authored room key and ID disagree.");
    const templateRoomId = number(room.templateRoomId, 0, 799, "Template room ID");
    if (!nativeIds.has(templateRoomId)) throw new Error("Room template must be a verified vanilla room.");
    if (room.kind !== "replacement" && room.kind !== "new") throw new Error("Invalid authored room kind.");
    if (room.kind === "replacement" && (id !== templateRoomId || !nativeIds.has(id))) throw new Error("Replacement room ID must equal its verified native template.");
    if (room.kind === "new" && (id < LIMITS.newRoomMin || id > LIMITS.newRoomMax || nativeIds.has(id))) throw new Error("New rooms require an unoccupied reserved ID in 620..799.");
    const materialIds = new Set<string>();
    const validatedMaterials = array(room.materials, LIMITS.materialsPerRoom, "Room materials").map(raw => {
      const material = plain(raw, "Material"); exactKeys(material, ["id", "sourceMaterialId"], "Material");
      const id = distinct(resourceId(material.id, "Material ID"), materialIds, "material");
      const sourceMaterialId = resourceId(material.sourceMaterialId, "Material source ID");
      if (!materials.has(sourceMaterialId)) throw new Error(`Unknown ROM material ${sourceMaterialId}.`);
      return { id, sourceMaterialId };
    });
    const meshIds = new Set<string>(); let vertexCount = 0, triangleCount = 0;
    const meshes = array(room.meshes, LIMITS.meshesPerRoom, "Room meshes").map(raw => {
      const mesh = plain(raw, "Mesh"); exactKeys(mesh, ["id", "vertices", "indices", "materialId", "sourceAssetId"], "Mesh");
      const id = distinct(resourceId(mesh.id, "Mesh ID"), meshIds, "mesh"), materialId = resourceId(mesh.materialId, "Mesh material ID");
      if (!materialIds.has(materialId)) throw new Error(`Mesh ${id} references an absent material.`);
      const vertices = array(mesh.vertices, LIMITS.verticesPerRoom, "Mesh vertices").map(raw => {
        const vertex = plain(raw, "Vertex"); exactKeys(vertex, ["position", "uv", "color"], "Vertex");
        return { position: nativeVector(vertex.position, "Vertex position"),
          uv: tuple(vertex.uv, 2, "Vertex UV").map(n => number(n, -1024, 1024, "Vertex UV", false)) as [number, number],
          color: tuple(vertex.color, 4, "Vertex RGBA").map(n => number(n, 0, 255, "Vertex color")) as [number, number, number, number] };
      });
      const indices = array(mesh.indices, LIMITS.trianglesPerRoom * 3, "Mesh indices").map(n => number(n, 0, vertices.length - 1, "Triangle vertex index"));
      if (indices.length % 3) throw new Error("Mesh indices must contain complete triangles.");
      vertexCount += vertices.length; triangleCount += indices.length / 3;
      if (vertexCount > LIMITS.verticesPerRoom || triangleCount > LIMITS.trianglesPerRoom) throw new Error("Room exceeds its vertex or triangle budget.");
      for (let at = 0; at < indices.length; at += 3) if (new Set(indices.slice(at, at + 3)).size !== 3) throw new Error("Geometry triangle must use three distinct vertex indices.");
      const sourceAssetId = mesh.sourceAssetId === undefined ? undefined : resourceId(mesh.sourceAssetId, "Geometry source asset ID");
      if (sourceAssetId !== undefined && !geometry.has(sourceAssetId)) throw new Error("Unknown ROM geometry asset.");
      return { id, vertices, indices, materialId, ...(sourceAssetId === undefined ? {} : { sourceAssetId }) };
    });
    const collisionIds = new Set<string>();
    if (room.collisionMode !== "template" && room.collisionMode !== "authored") throw new Error("Collision mode must be template or authored.");
    const collisionTranslation = room.collisionTranslation === undefined ? undefined : nativeVector(room.collisionTranslation, "Template collision translation", -65535, 65535);
    if (collisionTranslation !== undefined) {
      if (room.collisionMode !== "template") throw new Error("Collision translation requires template collision mode.");
      if (Object.values(collisionTranslation).some(coordinate => coordinate !== 0)) {
        if (!getTranslation) throw new Error("Template collision translation requires trusted native bounds validation.");
        // The trusted backend checks stored s16 bounds and finite f32 planes.
        // Authored BSP data is copied privately; do not register these spans as
        // global sparse ROM writes or introduce alias mutation conflicts.
        const translated = getTranslation(templateRoomId, collisionTranslation);
        if (translated.roomId !== templateRoomId) throw new Error("Collision translation validation returned the wrong donor room.");
      }
    }
    const collision = array(room.collision, LIMITS.collisionTrianglesPerRoom, "Collision triangles").map(raw => {
      const triangle = plain(raw, "Collision triangle"); exactKeys(triangle, ["id", "vertices", "classifier", "surface", "surfaceId", "sourceMeshId"], "Collision triangle");
      const id = distinct(resourceId(triangle.id, "Collision ID"), collisionIds, "collision");
      const vertices = tuple(triangle.vertices, 3, "Collision vertices").map(v => nativeVector(v, "Collision position")) as [Vec3, Vec3, Vec3];
      nondegenerate(vertices, "Collision triangle");
      const classifier = number(triangle.classifier, 1, 255, "Collision classifier"), surface = number(triangle.surface, 0, 65535, "Collision surface");
      const surfaceId = triangle.surfaceId === undefined ? undefined : resourceId(triangle.surfaceId, "Collision source ID");
      if (surfaceId !== undefined) {
        const entry = surfaces.get(surfaceId);
        if (!entry || entry.classifier !== classifier || entry.surface !== surface) throw new Error("Collision source metadata does not match its trusted catalog entry.");
      }
      const sourceMeshId = triangle.sourceMeshId === undefined ? undefined : resourceId(triangle.sourceMeshId, "Collision linked mesh ID");
      if (sourceMeshId !== undefined && !meshIds.has(sourceMeshId)) throw new Error("Collision triangle references an absent visual mesh.");
      return { id, vertices, classifier, surface, ...(surfaceId === undefined ? {} : { surfaceId }), ...(sourceMeshId === undefined ? {} : { sourceMeshId }) };
    });
    if (room.collisionMode === "template" && collision.length) throw new Error("Template collision cannot also contain authored triangles; switch to authored physics explicitly.");
    const placementIds = new Set<string>();
    const actors = array(room.actors, LIMITS.actorsAndDoorsPerRoom, "Authored actors").map(raw => {
      const actor = plain(raw, "Authored actor"); exactKeys(actor, ["id", "prototypeId", "position", "rotation", "parameters", "spawnPolicy"], "Authored actor");
      const id = distinct(resourceId(actor.id, "Authored actor ID"), placementIds, "placement"), prototypeId = resourceId(actor.prototypeId, "Actor prototype ID");
      if (!prototypes.has(prototypeId)) throw new Error(`Unknown native actor prototype ${prototypeId}.`);
      if (actor.spawnPolicy !== undefined && actor.spawnPolicy !== "resident" && actor.spawnPolicy !== "proximity") throw new Error("Actor spawn policy must be resident or proximity.");
      return { id, prototypeId, position: nativeVector(actor.position, "Actor position"), rotation: nativeVector(actor.rotation, "Actor rotation"), parameters: parameters(actor.parameters), ...(actor.spawnPolicy === undefined ? {} : { spawnPolicy: actor.spawnPolicy as "resident" | "proximity" }) };
    });
    const doors = array(room.doors, LIMITS.actorsAndDoorsPerRoom, "Authored doors").map(raw => {
      const door = plain(raw, "Authored door"); exactKeys(door, ["id", "position", "rotation", "dimensions", "activation", "appearancePrototypeId", "destination"], "Authored door");
      const id = distinct(resourceId(door.id, "Door ID"), placementIds, "placement");
      if (door.activation !== "interact" && door.activation !== "touch") throw new Error("Invalid custom door activation.");
      const appearancePrototypeId = door.appearancePrototypeId === undefined ? undefined : resourceId(door.appearancePrototypeId, "Door appearance prototype ID");
      if (appearancePrototypeId !== undefined && !prototypes.has(appearancePrototypeId)) throw new Error("Unknown door appearance prototype.");
      const destination = plain(door.destination, "Door destination"); exactKeys(destination, ["roomId", "entranceId"], "Door destination");
      return { id, position: nativeVector(door.position, "Door position"), rotation: nativeVector(door.rotation, "Door rotation"), dimensions: nativeVector(door.dimensions, "Door trigger dimensions", 1, 32767), activation: door.activation as "interact" | "touch",
        ...(appearancePrototypeId === undefined ? {} : { appearancePrototypeId }), destination: { roomId: number(destination.roomId, 0, 799, "Door destination room"), entranceId: resourceId(destination.entranceId, "Door entrance ID") } };
    });
    if (actors.length + doors.length > LIMITS.actorsAndDoorsPerRoom) throw new Error("Room exceeds its combined actor and door budget.");
    const entranceIds = new Set<string>();
    const entrances = array(room.entrances, LIMITS.entrancesPerRoom, "Room entrances").map(raw => {
      const entrance = plain(raw, "Entrance"); exactKeys(entrance, ["id", "name", "position", "baseYaw", "entryParameter"], "Entrance");
      return { id: distinct(resourceId(entrance.id, "Entrance ID"), entranceIds, "entrance"), name: name(entrance.name, "Entrance name"), position: nativeVector(entrance.position, "Entrance position"), baseYaw: number(entrance.baseYaw, -32768, 32767, "Native base heading"), entryParameter: number(entrance.entryParameter, 0, 39, "Native entry parameter") };
    });
    if (room.kind === "new" && !entrances.length) throw new Error("New rooms require at least one explicit spawn entrance.");
    // The viewport/inspector uses raw actor and mesh IDs, and prefixes doors
    // and entrances. Validate that effective namespace, not just raw IDs.
    const selectionIds = new Set<string>();
    // Reserve every potential actor-derived event key too: parameter/type edits
    // can introduce events later without changing the actor's stable ID.
    for (const selectionId of [...meshes.map(mesh => mesh.id), ...actors.map(actor => actor.id), ...actors.map(actor => `event:${actor.id}`), ...doors.map(door => `door:${door.id}`), ...entrances.map(entrance => `entrance:${entrance.id}`)])
      distinct(selectionId, selectionIds, "scene selection");
    const skyboxId = room.skyboxId === undefined || room.skyboxId === null ? room.skyboxId : resourceId(room.skyboxId, "Skybox ID");
    if (typeof skyboxId === "string" && !skyboxes.has(skyboxId)) throw new Error("Unknown native skybox asset.");
    result[key] = { id, name: name(room.name, "Room name"), kind: room.kind, templateRoomId, meshes, materials: validatedMaterials, collisionMode: room.collisionMode, ...(collisionTranslation === undefined ? {} : { collisionTranslation }), collision, actors, doors, entrances, ...(skyboxId === undefined ? {} : { skyboxId }) };
  }
  for (const room of Object.values(result)) for (const door of room.doors) {
    const target = result[String(door.destination.roomId)];
    const exists = target ? target.entrances.some(e => e.id === door.destination.entranceId)
      : nativeIds.has(door.destination.roomId) && lookup.catalog.nativeEntrances.some(e => e.roomId === door.destination.roomId && e.id === door.destination.entranceId);
    if (!exists) throw new Error(`Door ${door.id} has an unknown destination room or entrance.`);
  }
  return result;
}
