/** Authored data is lowered through the trusted, canonical ROM catalog.
 * Projects identify assets; only this backend can supply commands or pointers. */
import type { AuthoredRoom, AuthoredDoor, AuthoredEntrance, EditorProjectV2, Vec3 } from "../../shared/types";
import type { AuthoringExportContext, NativeAuthoringDonor, NativeAuthoringPrototype, NativeAuthoringMaterial } from "../authoring/catalog";
import { AUTHORING_LIMITS } from "../authoring/limits";
import { compileGeometry, compileProximityGrid, type NativeProximityGrid, type NativeGeometryPayload } from "../authoring/native-compiler";
import { compileTriangleCollision, decodeCollision, type CompiledCollision } from "../authoring/collision";
export type GetAuthoringExportContext = () => AuthoringExportContext | Promise<AuthoringExportContext>;
export interface MaterialPointerRelocation {
    offset: number;
    fileId: number;
    segmentedAddress: number;
}
export interface CompiledAuthoredActor {
    position: Vec3;
    rotation: Vec3;
    prototype: NativeAuthoringPrototype;
    spawnPolicy: "resident" | "proximity";
}
export interface CompiledAuthoredDoor {
    door: AuthoredDoor;
    geometry: NativeGeometryPayload;
    materialRelocations: MaterialPointerRelocation[];
    texture?: Uint8Array;
    textureCommand?: number;
    scale: Vec3;
    arrival?: {
        roomId: number;
        position: Vec3;
        baseYaw: number;
        entryParameter: number;
    };
    warnings: string[];
}
export interface CompiledAuthoredRoom {
    room: AuthoredRoom;
    donor: NativeAuthoringDonor;
    geometry: NativeGeometryPayload;
    materialRelocations: MaterialPointerRelocation[];
    collision: CompiledCollision;
    actors: CompiledAuthoredActor[];
    doors: CompiledAuthoredDoor[];
    proximity?: NativeProximityGrid;
    resources: number[];
    resourceBytes: number;
    nativePayloadBytes: number;
    resourceAllocations: {fileId:number;byteLength:number}[];
    skybox: {
        nativeIndex: number;
        fileId: number;
    };
    warnings: string[];
}
const AXES = ["x", "y", "z"] as const;
function integer(value: number, min: number, max: number, label: string) { if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(`${label} must be an integer in ${min}..${max}.`); return value; }
function xyz(value: Vec3, label: string) { if (!value)
    throw new Error(`${label} is missing.`); AXES.forEach(axis => integer(value[axis], -32768, 32767, `${label}.${axis}`)); }
/** Inverse of native scale/shift/tile-origin and the decoder's sample-center correction. */
export function authoringUv(value: number, dimension: number, scale: number, shift: number, origin: number, centerOffset: number): number {
    if (!Number.isFinite(value) || !Number.isSafeInteger(dimension) || dimension < 1 || dimension > 4096 || !Number.isFinite(scale) || scale <= 0 || !Number.isFinite(origin) || !Number.isFinite(centerOffset))
        throw new Error("Authored UV requires finite native material scale/dimensions.");
    integer(shift, 0, 15, "Native tile shift");
    const coordinate = value * dimension - centerOffset + origin, inverseShift = shift <= 10 ? coordinate * 2 ** shift : coordinate / 2 ** (16 - shift);
    return integer(Math.round(inverseShift / scale * 32), -32768, 32767, "Authored UV after native material transform");
}
function validMaterial(material: NativeAuthoringMaterial): void {
    if (!material || !Array.isArray(material.commands) || material.commands.length > 32768 || !Array.isArray(material.relocations))
        throw new Error("Canonical material command budget exceeded.");
    const allowed = new Set([0x03, 0xe7, 0xba, 0xb9, 0xb6, 0xb7, 0xfc, 0xfd, 0xf5, 0xe6, 0xf3, 0xf2, 0xbb, 0xbc, 0xfa, 0xe8, 0xf0, 0xf8, 0xf9]);
    const relocated = new Set<number>();
    material.commands.forEach(words => { if (!Array.isArray(words) || words.length !== 2)
        throw new Error("Canonical material command is malformed."); words.forEach(word => integer(word, 0, 0xffffffff, "Native material word")); if (!allowed.has(words[0] >>> 24))
        throw new Error("Canonical material prefix contains geometry, control flow or an extension command."); });
    for (const relocation of material.relocations) {
        if (relocated.has(relocation.offset))
            throw new Error("Canonical material has duplicate pointer relocations.");
        relocated.add(relocation.offset);
        integer(relocation.offset, 0, material.commands.length * 8 - 1, "Material relocation offset");
        integer(relocation.fileId, 1, 65535, "Material resource");
        integer(relocation.segmentedAddress, 0x01000000, 0x0fffffff, "Material segmented pointer");
        if (relocation.offset % 8 !== 4 || material.commands[relocation.offset >>> 3][1] !== relocation.segmentedAddress || ![0xfd, 0x03].includes(material.commands[relocation.offset >>> 3][0] >>> 24) || !material.resourceFileIds.includes(relocation.fileId))
            throw new Error("Canonical material relocation does not match its pointer-bearing command and resource.");
    }
    material.commands.forEach((words, index) => {
        if ([0xfd, 0x03].includes(words[0] >>> 24) && words[1] > 0 && words[1] < 0x80000000 && !relocated.has(index * 8 + 4))
            throw new Error("Canonical material has an unrelocated positive pointer.");
    });
}
function materialUvScale(material: NativeAuthoringMaterial, axis: "S" | "T"): number {
    const scale = axis === "S" ? material.uv.scaleS : material.uv.scaleT;
    return scale === 0 && !material.material.textureId ? 1 : scale;
}
/** One room root contains all material/mesh batches, avoiding per-mesh task allocation. */
export function compileAuthoredRoom(room: AuthoredRoom, context: AuthoringExportContext): CompiledAuthoredRoom {
    integer(room.id, 0, 799, "Authored room ID");
    integer(room.templateRoomId, 0, 539, "Verified world room donor");
    if (room.kind === "new" && room.id < 620)
        throw new Error("New rooms use unoccupied native IDs620..799.");
    if (room.kind === "replacement" && room.id !== room.templateRoomId)
        throw new Error("Replacement room donor must preserve its native ID.");
    if (!["new", "replacement"].includes(room.kind)) throw new Error("Unknown authored room kind.");
    const donor = context.donor(room.templateRoomId);
    if (donor.graphicsOffset === undefined)
        throw new Error("Room donor lacks a verified File11 geometry-group/index; choose a world room template.");
    if (donor.roomId !== room.templateRoomId)
        throw new Error("Canonical donor does not match the room.");
    const resources = new Set<number>([127, ...donor.resourceFileIds]), materialMap = new Map(room.materials.map(material => [material.id, material]));
    if (materialMap.size !== room.materials.length)
        throw new Error("Authored material IDs must be unique.");
    const encodedVertices: Uint8Array[] = [], commands: number[][] = [], relocations: NativeGeometryPayload["relocations"] = [], materialRelocations: MaterialPointerRelocation[] = [], warnings: string[] = [];
    let vertexBytes = 0, vertexCount = 0, triangleCount = 0, batchCount = 0, inputVertexCount = 0;
    for (const mesh of room.meshes) {
        inputVertexCount += mesh.vertices.length;
        triangleCount += mesh.indices.length / 3;
        if (inputVertexCount > AUTHORING_LIMITS.verticesPerRoom || triangleCount > AUTHORING_LIMITS.trianglesPerRoom || !Number.isInteger(triangleCount))
            throw new Error("Authored room geometry exceeds the native project vertex/triangle budget.");
        const reference = materialMap.get(mesh.materialId);
        if (!reference)
            throw new Error(`Mesh ${mesh.id} has no authored material reference.`);
        const material = context.material(reference.sourceMaterialId);
        validMaterial(material);
        material.resourceFileIds.forEach(id => resources.add(id));
        if ((material.uv.scaleS === 0 || material.uv.scaleT === 0) && !material.material.textureId)
            warnings.push("Untextured native material disables its UV scale; authored UV is stored with a unit-scale convention while that material ignores texture coordinates.");
        const materialOffsets = new Map<number, number>();
        material.commands.forEach((row, index) => {
            // Pointer-bearing commands are lowered to absolute addresses. Original
            // segment updates have no remaining consumers and cannot leak into VTX.
            if ((row[0] >>> 24) === 0xbc && (row[0] & 255) === 6)
                return;
            materialOffsets.set(index * 8 + 4, commands.length * 8 + 4);
            commands.push([...row]);
        });
        for (const relocation of material.relocations)
            materialRelocations.push({ ...relocation, offset: materialOffsets.get(relocation.offset)! });
        // G_LIGHTING, G_TEXTURE_GEN and G_TEXTURE_GEN_LINEAR are incompatible with authored RGBA/UV.
        commands.push([0xb6000000, 0x000e0000]);
        const compiled = compileGeometry({ vertices: mesh.vertices.map(vertex => ({ position: vertex.position, uv: [authoringUv(vertex.uv[0], material.textureWidth, materialUvScale(material, "S"), material.uv.shiftS, material.uv.originS, material.uv.centerOffset), authoringUv(vertex.uv[1], material.textureHeight, materialUvScale(material, "T"), material.uv.shiftT, material.uv.originT, material.uv.centerOffset)], rgba: vertex.color })), triangles: Array.from({ length: mesh.indices.length / 3 }, (_, index) => mesh.indices.slice(index * 3, index * 3 + 3) as [
                number,
                number,
                number
            ]) });
        const geometryBase = commands.length * 8;
        for (const relocation of compiled.relocations)
            relocations.push({ ...relocation, offset: geometryBase + relocation.offset, addend: vertexBytes + relocation.addend });
        const view = new DataView(compiled.displayList.buffer);
        for (let offset = 0; offset < compiled.displayList.length - 8; offset += 8)
            commands.push([view.getUint32(offset), view.getUint32(offset + 4)]);
        encodedVertices.push(compiled.vertices);
        vertexBytes += compiled.vertices.length;
        vertexCount += compiled.vertexCount;
        batchCount += compiled.batchCount;
    }
    commands.push([0xb8000000, 0]);
    const vertices = new Uint8Array(vertexBytes);
    let vertexAt = 0;
    for (const bytes of encodedVertices) {
        vertices.set(bytes, vertexAt);
        vertexAt += bytes.length;
    }
    const displayList = new Uint8Array(commands.length * 8), view = new DataView(displayList.buffer);
    commands.forEach(([w0, w1], index) => { view.setUint32(index * 8, w0); view.setUint32(index * 8 + 4, w1); });
    let collision: CompiledCollision;
    if (room.collisionMode === "template") {
        if (room.collision.length)
            throw new Error("Template collision cannot also contain authored triangles. Select authored collision explicitly.");
        const original = context.collision(room.templateRoomId, room.collisionTranslation), decoded = decodeCollision(original);
        original.resourceFileIds.forEach(id => resources.add(id));
        collision = { planes: original.planes.slice(), tree: original.tree.slice(), planeCount: original.planeCount, cellCount: original.cellCount, branchCount: decoded.branches.size };
        warnings.push("Template collision preserves the original opaque native plane/tree exactly. Visual vertex edits do not change these colliders; rebuild authored collision explicitly when physics should follow the mesh.");
    }
    else if (room.collisionMode === "authored") {
        if (room.collisionTranslation && AXES.some(axis => room.collisionTranslation![axis] !== 0))
            throw new Error("Authored collision coordinates are already baked; collisionTranslation is only valid with template collision.");
        collision = compileTriangleCollision(room.collision);
    }
    else
        throw new Error("Authored room must select template or authored collision explicitly.");
    for (const actor of room.actors) {
        xyz(actor.position, "Actor position");
        xyz(actor.rotation, "Actor rotation");
        if (!Array.isArray(actor.parameters) || actor.parameters.length !== 3)
            throw new Error("Native actor requires three payload words.");
        actor.parameters.forEach(value => integer(value, 0, 0xffffffff, "Actor payload"));
    }
    const actorContext = { roomId: room.id, templateRoomId: room.templateRoomId, siblings: room.actors.map(actor => ({ prototypeId: actor.prototypeId, parameters: actor.parameters, position: actor.position, rotation: actor.rotation })) };
    const actors = room.actors.map(actor => {
        xyz(actor.position, "Actor position");
        xyz(actor.rotation, "Actor rotation");
        const prototype = context.prototype(actor.prototypeId, { parameters: actor.parameters, position: actor.position, rotation: actor.rotation }, actorContext);
        integer(prototype.actorId, 0, 0x405, "Native actor identity");
        integer(prototype.unknownHalfword, 0, 65535, "Native definition unknown halfword");
        if (prototype.parameters.length !== 3)
            throw new Error("Native actor requires exactly three payload words.");
        prototype.parameters.forEach(value => integer(value, 0, 0xffffffff, "Actor payload"));
        prototype.resourceFileIds.forEach(id => resources.add(id));
        warnings.push(...prototype.warnings);
        const spawnPolicy = actor.spawnPolicy ?? (prototype.sourceKind === "partition" ? "proximity" : "resident");
        if (!["resident", "proximity"].includes(spawnPolicy))
            throw new Error("Unknown native actor spawn policy.");
        return { position: { ...actor.position }, rotation: { ...actor.rotation }, prototype, spawnPolicy };
    });
    const proximityActors = actors.flatMap((actor, index) => actor.spawnPolicy === "proximity" ? [{ index, position: actor.position }] : []);
    const proximity = proximityActors.length ? compileProximityGrid(proximityActors) : undefined;
    const guaranteedObjects = actors.filter(actor => actor.spawnPolicy === "resident").length + room.doors.length + 1;
    if (guaranteedObjects > 192)
        throw new Error("Resident actors, doors and the room renderer exceed the native shared 192-object kind-2 pool. Use proximity spawning or reduce resident records.");
    const doors = room.doors.map(door => compileAuthoredDoor(door, room, context, resources));
    doors.forEach(door => warnings.push(...door.warnings));
    const skyboxId = room.skyboxId === undefined ? donor.skyboxId : room.skyboxId;
    const skybox = skyboxId ? context.skybox(skyboxId) : { nativeIndex: 0, fileId: 0 };
    integer(skybox.nativeIndex, 0, 4, "Native background index");
    if (skybox.fileId)
        resources.add(skybox.fileId);
    for (const entrance of room.entrances) {
        xyz(entrance.position, "Entrance position");
        integer(entrance.baseYaw, -32768, 32767, "Entrance base yaw");
        integer(entrance.entryParameter, 0, 39, "Entrance packed entry parameter");
    }
    if (actors.length + room.doors.length > AUTHORING_LIMITS.actorsAndDoorsPerRoom)
        throw new Error("Room exceeds the authored actor/door budget.");
    if (actors.length + room.doors.length)
        warnings.push("Native task/object pools are shared with players and game services (kind2 pool starts with192 objects). The4096-record project limit does not imply4096 simultaneous actors; allocation may fail under runtime load.");
    for (const id of resources)
        integer(id, 1, 65535, "Native room dependency");
    if (resources.size > 48)
        throw new Error(`Room ${room.id} (${room.name}) requires ${resources.size} unique resource files, exceeding the verified native 48-ID registry. Remove dependencies or split the authored scene into rooms; native services share these slots.`);
    const allocation = context.resourceFileBytes([...resources]);
    const resourceBytes = allocation.totalBytes;
    const resourceAllocations = [...resources].sort((a,b)=>a-b).map(fileId => {
        const record = allocation.files.find(file => file.fileId === fileId);
        if (!record) throw new Error(`Resource ${fileId} has no verified native allocation extent.`);
        integer(record.byteLength, 1, 16 * 1024 * 1024, `Resource ${fileId} allocation extent`);
        return record;
    });
    warnings.push("Authored world resource appends use a conservative 0x80594000 bank-end policy with live cursor, native alignment and 48-slot checks. A resource failure suspends gameplay until restart or disabling the mod.");
    integer(resourceBytes, 0, 16 * 1024 * 1024, "Native room resource allocation bytes");
    if (resourceBytes > 0x80594000 - 0x80321500) throw new Error(`Room ${room.id} requires ${resourceBytes} native resource bytes, exceeding the conservative world bank after the verified player prefix. Remove resource dependencies or split this scene into rooms.`);
    warnings.push("Authored geometry clears native lighting and generated texture coordinates, preserving vertex RGBA bytes. Canonical material combiners can ignore some vertex channels; this is an unlit authored presentation rather than a recreation of every native lighting effect.");
    warnings.push(`Canonical native resource closure allocates ${resourceBytes} bytes across ${resources.size} files, separate from the generated mod payload. Runtime resource-pool allocation can still fail; the compiler does not certify native heap headroom.`);
    const nativePayloadBytes = vertexBytes + displayList.length + collision.planes.length + collision.tree.length +
        (proximity?.cellCount ?? 0) * 4 + (proximity?.cells.size ?? 0) * 20 + actors.length * 40 +
        resources.size * 8 + materialRelocations.length * 12 + 1024 +
        doors.reduce((sum, door) => sum + door.geometry.vertices.length + door.geometry.displayList.length + (door.texture?.length ?? 0) + door.materialRelocations.length * 12 + 256, 0);
    if (nativePayloadBytes > 16 * 1024 * 1024)
        throw new Error("Authored native room payload exceeds16MiB.");
    return { room, donor, geometry: { vertices, displayList, relocations, triangleCount, vertexCount, batchCount }, materialRelocations, collision, actors, doors, proximity, resources: [...resources].sort((a, b) => a - b), resourceBytes, nativePayloadBytes, resourceAllocations, skybox, warnings: [...new Set(warnings)] };
}
export function authoredDestination(project: EditorProjectV2, roomId: number, entranceId: string): AuthoredEntrance | undefined {
    const room = project.authoredRooms[String(roomId)];
    return room?.entrances.find(entrance => entrance.id === entranceId);
}
function compileAuthoredDoor(door: AuthoredDoor, room: AuthoredRoom, context: AuthoringExportContext, resources: Set<number>): CompiledAuthoredDoor {
    xyz(door.position, "Door position");
    xyz(door.rotation, "Door rotation");
    for (const axis of AXES)
        integer(door.dimensions[axis], 1, 32767, `Door dimensions.${axis}`);
    if (!["touch", "interact"].includes(door.activation))
        throw new Error("Unknown custom door activation mode.");
    integer(door.destination.roomId, 0, 799, "Door destination room");
    if (typeof door.destination.entranceId !== "string" || !door.destination.entranceId.length)
        throw new Error("Custom door requires a named destination entrance.");
    if (door.appearancePrototypeId) {
        if (!context.doorGeometry)
            throw new Error("Native door appearance requires the trusted static-pose geometry backend.");
        const native = context.doorGeometry(door.appearancePrototypeId, { roomId: room.id, templateRoomId: room.templateRoomId, siblings: room.actors.map(actor => ({ prototypeId: actor.prototypeId, parameters: actor.parameters, position: actor.position, rotation: actor.rotation })) });
        const materials = new Map(native.meshes.map((mesh, index) => [`door-material:${index}`, mesh.material]));
        const replacement: AuthoredRoom = { ...room, meshes: native.meshes.map((mesh, index) => ({ id: `door-mesh:${index}`, materialId: `door-material:${index}`, vertices: mesh.vertices.map(vertex => ({ position: vertex.position, uv: vertex.uv, color: vertex.colorRGBAu8 })), indices: mesh.indices })), materials: [...materials.keys()].map(id => ({ id, sourceMaterialId: id })), collisionMode: "authored", collision: [], collisionTranslation: undefined, actors: [], doors: [], entrances: [], skyboxId: null };
        const lowered = compileAuthoredRoom(replacement, { ...context, material: id => materials.get(id) ?? context.material(id) });
        native.resourceFileIds.forEach(id => resources.add(id));
        lowered.resources.forEach(id => resources.add(id));
        return { door, geometry: lowered.geometry, materialRelocations: lowered.materialRelocations, scale: { x: 1, y: 1, z: 1 }, warnings: [...native.warnings, ...lowered.warnings, "Native appearance is a fixed initial pose; the generated custom door owns activation and transition behavior."] };
    }
    return defaultDoorBox(door);
}
/** Packet values were generated and checked against the project's libultra F3DEX GBI macros. */
function defaultDoorBox(door: AuthoredDoor): CompiledAuthoredDoor {
    const faces = [
        [[-50, -50, 50], [50, -50, 50], [50, 50, 50], [-50, 50, 50]],
        [[50, -50, -50], [-50, -50, -50], [-50, 50, -50], [50, 50, -50]],
        [[50, -50, 50], [50, -50, -50], [50, 50, -50], [50, 50, 50]],
        [[-50, -50, -50], [-50, -50, 50], [-50, 50, 50], [-50, 50, -50]],
        [[-50, 50, 50], [50, 50, 50], [50, 50, -50], [-50, 50, -50]],
        [[-50, -50, -50], [50, -50, -50], [50, -50, 50], [-50, -50, 50]],
    ];
    const uv = [[-16, -16], [496, -16], [496, 496], [-16, 496]] as [
        number,
        number
    ][];
    const vertices = faces.flatMap(face => face.map(([x, y, z], index) => ({ position: { x, y, z }, uv: uv[index], rgba: [255, 255, 255, 255] as [
            number,
            number,
            number,
            number
        ] })));
    const triangles = faces.flatMap((_face, index) => [[index * 4, index * 4 + 1, index * 4 + 2], [index * 4, index * 4 + 2, index * 4 + 3]] as [
        number,
        number,
        number
    ][]);
    const geometry = compileGeometry({ vertices, triangles });
    const prefix = [
        [0xe7000000, 0], [0xba001402, 0], [0xba000e02, 0], [0xba000c02, 0x2000],
        [0xba001301, 0x80000], [0xb9000002, 0], [0xb900031d, 0x00552078],
        [0xfc121824, 0xff33ffff], [0xb6000000, 0x000f3000], [0xb7000000, 0x205],
        [0xbb000001, 0xffffffff], [0xfd100000, 0], [0xf5100000, 0x07010040],
        [0xe6000000, 0], [0xf3000000, 0x070ff200], [0xe7000000, 0],
        [0xf5100800, 0x00010040], [0xf2000000, 0x0003c03c],
    ];
    const displayList = new Uint8Array(prefix.length * 8 + geometry.displayList.length), view = new DataView(displayList.buffer);
    prefix.forEach(([a, b], index) => { view.setUint32(index * 8, a); view.setUint32(index * 8 + 4, b); });
    displayList.set(geometry.displayList, prefix.length * 8);
    const texture = new Uint8Array(16 * 16 * 2), textureView = new DataView(texture.buffer);
    for (let y = 0; y < 16; y++)
        for (let x = 0; x < 16; x++)
            textureView.setUint16((y * 16 + x) * 2, ((x >> 2) ^ (y >> 2)) & 1 ? 0xb58b : 0x6ac5);
    return { door, geometry: { ...geometry, displayList, relocations: geometry.relocations.map(relocation => ({ ...relocation, offset: relocation.offset + prefix.length * 8 })) }, materialRelocations: [], texture, textureCommand: 11, scale: { x: door.dimensions.x / 100, y: door.dimensions.y / 100, z: door.dimensions.z / 100 }, warnings: ["Default custom door uses a generated checker texture. Dimensions define its oriented contact volume and visible box."] };
}
export function resolveAuthoredDoorDestinations(rooms: readonly CompiledAuthoredRoom[], context: AuthoringExportContext): void {
    const registry = new Map(rooms.map(room => [room.room.id, room]));
    for (const compiled of rooms)
        for (const door of compiled.doors) {
            const destination = door.door.destination, target = registry.get(destination.roomId);
            const arrival = target ? target.room.entrances.find(entrance => entrance.id === destination.entranceId) : context.entrance(destination.roomId, destination.entranceId);
            if (!arrival)
                throw new Error(`Door ${door.door.id} has no named destination entrance.`);
            if (!target && "roomId" in arrival && arrival.roomId !== destination.roomId)
                throw new Error("Native door entrance belongs to a different room.");
            xyz(arrival.position, "Door arrival position");
            integer(arrival.baseYaw, -32768, 32767, "Door arrival base heading");
            integer(arrival.entryParameter, 0, 39, "Door arrival startup parameter");
            door.arrival = { roomId: destination.roomId, position: { ...arrival.position }, baseYaw: arrival.baseYaw, entryParameter: arrival.entryParameter };
        }
}
