import { randomUUID } from "node:crypto";
import type { ActorOverride, EditorProject, RomIdentity, RoomData, RoomOverride, Vec3 } from "../shared/types";
import { nativePartitionCell } from "./rom/partition";
import type { GeometryTranslation } from "./rom/translation";
export type GeometryTranslationLookup = (roomId:number,translation:Vec3)=>GeometryTranslation;

function object(input: unknown, label: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input)))
    throw new Error(`${label} must be a plain object.`);
  return input as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[], label: string) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${label} contains unsupported field ${key}.`);
}
function integer(input: unknown, min: number, max: number, label: string): number {
  if (typeof input !== "number" || !Number.isInteger(input) || input < min || input > max) throw new Error(`${label} must be an integer in ${min}..${max}.`);
  return input;
}
function text(input: unknown, limit: number, label: string): string {
  if (typeof input !== "string" || !input.trim() || input.length > limit || /[\u0000-\u001f]/.test(input)) throw new Error(`${label} is invalid.`);
  return input;
}
function vector(input: unknown, label: string,min=-32768,max=32767): Vec3 {
  const v = object(input, label); keys(v, ["x", "y", "z"], label);
  return { x: integer(v.x, min, max, `${label}.x`), y: integer(v.y, min, max, `${label}.y`), z: integer(v.z, min, max, `${label}.z`) };
}

export function createProject(name: string, rom: RomIdentity): EditorProject {
  const now = new Date().toISOString();
  return { format: "mnsg-level-project", version: 1, id: randomUUID(), name: text(name, 120, "Project name"),
    createdAt: now, updatedAt: now, rom: structuredClone(rom), roomOverrides: {} };
}

/** Validates sparse edits against current ROM records, with no project-controlled pointers. */
export function validateProject(input: unknown, rom: RomIdentity, loadRoom: (id: number) => RoomData,getTranslation?:GeometryTranslationLookup): EditorProject {
  const value = object(input, "Project");
  keys(value, ["format", "version", "id", "name", "createdAt", "updatedAt", "rom", "roomOverrides"], "Project");
  if (value.format !== "mnsg-level-project" || value.version !== 1) throw new Error("Unsupported project format/version.");
  const projectRom = object(value.rom, "Project ROM");
  if (projectRom.normalizedSha256 !== rom.normalizedSha256) throw new Error("Project requires a different ROM checksum.");
  const id = text(value.id, 128, "Project ID"), name = text(value.name, 120, "Project name");
  const timestamp = (v: unknown) => {
    const s = text(v, 64, "Project timestamp");
    if (!/^\d{4}-\d{2}-\d{2}T/.test(s) || !Number.isFinite(Date.parse(s))) throw new Error("Invalid project timestamp.");
    return s;
  };
  const createdAt = timestamp(value.createdAt), updatedAt = timestamp(value.updatedAt);
  const overrides = object(value.roomOverrides, "Room overrides"), roomOverrides: Record<string, RoomOverride> = {};
  if (Object.keys(overrides).length > 800) throw new Error("Project contains too many rooms.");
  // Shared placement lists occur in several rooms. Sparse edits to identical bytes must agree.
  const writes = new Map<number, number>();
  const reads = new Map<number,number>();
  const definitionEdits = new Map<number, Buffer>();
  const write = (offset: number, data: Uint8Array) => {
    for (let i = 0; i < data.length; i++) {
      const previous = writes.get(offset + i);
      if (previous !== undefined && previous !== data[i]) throw new Error("Project source records have contradictory overlapping edits.");
      const expected=reads.get(offset+i);
      if(expected!==undefined&&expected!==data[i])throw new Error("Project writes conflict with geometry topology or normal guards.");
      writes.set(offset + i, data[i]);
    }
  };
  const writeVec = (offset: number, v: Vec3) => {
    const data = new Uint8Array(6), view = new DataView(data.buffer);
    [v.x, v.y, v.z].forEach((n, i) => view.setInt16(i * 2, n)); write(offset, data);
  };
  let totalActors = 0;
  for (const [roomKey, rawRoom] of Object.entries(overrides)) {
    if (!/^(0|[1-9]\d*)$/.test(roomKey)) throw new Error("Project room keys must be canonical decimal IDs.");
    const roomId = integer(Number(roomKey), 0, 799, "Room ID"), native = loadRoom(roomId);
    const room = object(rawRoom, "Room override"); keys(room, ["actors", "events", "geometry"], "Room override");
    const actorEdits = object(room.actors, "Actor overrides"), eventEdits = object(room.events, "Event overrides");
    if (Object.keys(eventEdits).length) throw new Error("Event records are read-only; event record edits are unsupported for this format.");
    const records = new Map(native.actors.map(actor => [actor.id, actor]));
    const actors: Record<string, ActorOverride> = {};
    for (const [actorKey, rawActor] of Object.entries(actorEdits)) {
      if (++totalActors > 32768) throw new Error("Project contains too many actor overrides.");
      const actor = records.get(actorKey);
      if (!actor || !actor.editable) throw new Error(`Actor ${actorKey} is absent or read-only in room ${roomKey}.`);
      const edit = object(rawActor, "Actor override"); keys(edit, ["actorId", "position", "rotation", "parameters"], "Actor override");
      const result: ActorOverride = {};
      if (edit.position !== undefined) {
        result.position = vector(edit.position, "Position");
        if (actor.sourceKind === "partition") {
          const config = actor.partition;
          for (const axis of ["x", "y", "z"] as const) {
            if (!config || !Number.isFinite(config.origin[axis]) || !(config.cellSize[axis] > 0))
              throw new Error("Partition actor movement has no verified spawn-grid configuration.");
            const cell = nativePartitionCell(result.position[axis], config.origin[axis], config.cellSize[axis], config.cellCount[axis]);
            if (cell !== config.originalCell[axis]) throw new Error("Moving partition actors across native spawn-grid cells requires grid migration, which is not yet supported.");
          }
        }
        writeVec(actor.source.romOffset, result.position);
      }
      if (edit.rotation !== undefined) { result.rotation = vector(edit.rotation, "Rotation"); writeVec(actor.source.romOffset + 6, result.rotation); }
      if (edit.actorId !== undefined) {
        result.actorId = integer(edit.actorId, 0, 0x3ff, "Actor ID");
        if (!native.actors.some(candidate => candidate.actorId === result.actorId))
          throw new Error("Actor substitution requires an actor ID already present in this room's native resource roster.");
      }
      if (edit.parameters !== undefined) {
        if (!Array.isArray(edit.parameters) || edit.parameters.length !== 3) throw new Error("Actor parameters must contain exactly three native words.");
        result.parameters = edit.parameters.map((n, i) => integer(n, 0, 0xffffffff, `Parameter ${i}`));
      }
      if ((result.actorId !== undefined || result.parameters !== undefined) && !actor.definitionSource)
        throw new Error("Actor definition provenance is unavailable.");
      // Private definition cloning occurs in export. Shared placement aliases must use the same clone.
      if (result.actorId !== undefined || result.parameters !== undefined) {
        const definitionKey = actor.source.romOffset;
        const bytes = Buffer.from(JSON.stringify({actorId: result.actorId ?? actor.actorId, parameters: result.parameters ?? actor.parameters}));
        const prior = definitionEdits.get(definitionKey);
        if (prior && !prior.equals(bytes)) throw new Error("Shared actor placements have contradictory definition edits.");
        definitionEdits.set(definitionKey, bytes);
      }
      actors[actorKey] = result;
    }
    const validated:RoomOverride={actors,events:{}};
    if(room.geometry!==undefined) {
      const geometry=object(room.geometry,"Geometry override");keys(geometry,["translation"],"Geometry override");
      const translation=vector(geometry.translation,"Geometry translation",-65535,65535);
      if([translation.x,translation.y,translation.z].some(n=>n!==0)) {
        if(!getTranslation)throw new Error("Geometry edits require verified native translation validation.");
        const operation=getTranslation(roomId,translation);
        if(operation.roomId!==roomId||!Array.isArray(operation.spans)||operation.spans.length===0||!Array.isArray(operation.guards))throw new Error("Geometry validation returned an invalid translation operation.");
        for(const guard of operation.guards) {
          const width=guard.kind==="planeNormal"?12:guard.kind==="treeBranch"||guard.kind==="cellTopology"?6:guard.kind==="displayCommand"?8:0;
          if(!width||!Number.isSafeInteger(guard.romOffset)||guard.romOffset<0||guard.romOffset+width>rom.byteLength||!new RegExp(`^[a-f0-9]{${width*2}}$`).test(guard.expectedHex))
            throw new Error("Geometry validation returned a guard outside its allowlisted native width.");
          const expected=Buffer.from(guard.expectedHex,"hex");
          for(let i=0;i<expected.length;i++) {
            const previous=reads.get(guard.romOffset+i),written=writes.get(guard.romOffset+i);
            if((previous!==undefined&&previous!==expected[i])||(written!==undefined&&written!==expected[i]))throw new Error("Project geometry guards conflict with overlapping source edits.");
            reads.set(guard.romOffset+i,expected[i]);
          }
        }
        for(const span of operation.spans) {
          const width=span.kind==="vertexXYZ"?6:span.kind==="planeDistance"?4:span.kind==="cellBounds"?12:0;
          if(!width||!Number.isSafeInteger(span.romOffset)||span.romOffset<0||span.romOffset+width>rom.byteLength||
            !new RegExp(`^[a-f0-9]{${width*2}}$`).test(span.originalHex)||!new RegExp(`^[a-f0-9]{${width*2}}$`).test(span.replacementHex))
            throw new Error("Geometry validation returned a span outside its allowlisted native width.");
          write(span.romOffset,Buffer.from(span.replacementHex,"hex"));
        }
        validated.geometry={translation};
      }
    }
    roomOverrides[roomKey] = validated;
  }
  return { format: "mnsg-level-project", version: 1, id, name, createdAt, updatedAt, rom: structuredClone(rom), roomOverrides };
}
