import { createHash } from "node:crypto";
import type { ActorData,ActorOverride,ActorVisualPayload, RomIdentity, RoomData, RoomSummary, SourceRecord } from "../shared/types";
import { RomReader, normalizeRomByteOrder } from "./rom/binary";
import { decompressUsRom, readFileTable, type RomFile } from "./rom/decompress";
import { ROOM_NAMES } from "./rom/catalog";
import { decodeRoomGeometry, geometryAuxiliaryRecord, graphicsLocation, graphicsRecord } from "./rom/geometry";
import { nativePartitionCell } from "./rom/partition";
import { actorEvent } from "./rom/events";
import { GeometryTranslations, type GeometryTranslation } from "./rom/translation";
import type { Vec3 } from "../shared/types";
import {RenderWaves} from "./rom/waves";
import {renderRoom} from "./rom/render";
import {ActorVisuals} from "./rom/actors";
import {createProject,validateProject} from "./project";

export { normalizeRomByteOrder } from "./rom/binary";
export { decompressLzkn64, readFileTable } from "./rom/decompress";
const COMPRESSED_SHA1 = "df8083a54296b8c151917c5333e1c85f014a2a66";
const DECOMPRESSED_SHA1 = "6ea0ed71032ce08fc2745f412d84936382197494";
const FILE12_ROM = 0x5c8770, FILE12_VRAM = 0x8020d2a0, FILE12_SIZE = 0x2e0d0;
const ROOM_TABLE = 0x5ec7d0;
const hash = (bytes: Uint8Array, algorithm = "sha256") => createHash(algorithm).update(bytes).digest("hex");

export class ImportedRom {
  readonly warnings: string[] = [];
  private readonly reader: RomReader;
  private readonly files: Map<number, RomFile>;
  private readonly rooms = new Map<number, RoomData>();
  private readonly translations: GeometryTranslations;
  private readonly renderWaves:RenderWaves;
  private readonly renderedRooms=new Map<number,RoomData>();
  private readonly actorVisuals:ActorVisuals;
  constructor(readonly bytes: Uint8Array, readonly identity: RomIdentity) {
    this.reader = new RomReader(bytes);
    this.files = new Map(readFileTable(bytes).map(file => [file.id, file]));
    if (this.files.get(12)?.start !== FILE12_ROM) throw new Error("ROM does not match the verified US native layout.");
    this.reader.check(ROOM_TABLE, 800 * 4);
    this.translations=new GeometryTranslations(this.reader,this.files,id=>this.segment(id));
    this.renderWaves=new RenderWaves(this.reader,this.files,id=>this.segment(id));
    this.actorVisuals=new ActorVisuals(this.reader,this.files,this.renderWaves);
  }
  private resident(pointer: number, size: number): number {
    if (pointer < FILE12_VRAM || pointer + size > FILE12_VRAM + FILE12_SIZE)
      throw new Error(`Unmapped resident pointer 0x${pointer.toString(16)}.`);
    return this.reader.check(FILE12_ROM + pointer - FILE12_VRAM, size);
  }
  private resolve(pointer: number, fileId: number, size: number): number {
    if (!pointer || pointer === 0xffffffff) throw new Error("Null or sentinel resource pointer.");
    if (pointer >= 0x80000000) return this.resident(pointer, size);
    const file = this.files.get(fileId);
    if (!file || file.compressed) throw new Error(`Actor data file ${fileId} is unavailable.`);
    // Native func_80001E50_2A50 selects each file's segment from threshold metadata.
    if ((pointer >>> 24) !== this.segment(fileId)) throw new Error(`Unknown actor-data segment 0x${(pointer >>> 24).toString(16)}.`);
    return this.reader.check(file.start + (pointer & 0xffffff), size, file.end);
  }
  private segment(fileId: number): number {
    for (let at = 0x55510; at < 0x55910; at += 4) {
      const threshold = this.reader.u16(at);
      if (!threshold) break;
      if (fileId < threshold) return this.bytes[at + 3];
    }
    throw new Error(`File ${fileId} has no native segment mapping.`);
  }
  private source(offset: number, size: number, pointer?: number, fileId?: number): SourceRecord {
    return { romOffset: offset, expectedHex: this.reader.hex(offset, size), segmentedAddress: pointer, fileId };
  }
  listRooms(): RoomSummary[] {
    const result: RoomSummary[] = [];
    for (let id = 0; id < 800; id++) {
      if (!this.reader.u32(ROOM_TABLE + id * 4) && graphicsRecord(this.reader, id) === undefined) continue;
      const room=this.loadBaseRoom(id);
      result.push({id:room.id,name:room.name,actorCount:room.actorCount,eventCount:room.eventCount,geometryAvailable:room.geometryAvailable,warnings:[...room.warnings]});
    }
    return result;
  }
  geometryTranslation(roomId:number,translation:Vec3):GeometryTranslation {
    if(!Number.isInteger(roomId)||roomId<0||roomId>=800)throw new Error("Invalid native room ID.");
    return this.translations.translation(roomId,translation);
  }
  loadActorVisuals(roomId:number,actorOverrides:Record<string,ActorOverride>={}):ActorVisualPayload {
    const room=this.loadBaseRoom(roomId),project=createProject("Actor preview",this.identity);
    project.roomOverrides[String(roomId)]={actors:actorOverrides,events:{}};
    const validated=validateProject(project,this.identity,id=>this.loadBaseRoom(id));
    return this.actorVisuals.load(room,validated.roomOverrides[String(roomId)]?.actors??{});
  }
  loadRoom(id: number): RoomData {
    const cached=this.renderedRooms.get(id);if(cached){this.renderedRooms.delete(id);this.renderedRooms.set(id,cached);return structuredClone(cached);}
    const room=this.loadBaseRoom(id);
    try {
      const rendered=renderRoom(this.reader,id,this.files,fileId=>this.segment(fileId),this.renderWaves);
      room.warnings.push(...rendered.warnings);
      if(!rendered.complete)throw new Error("Material traversal is incomplete.");
      room.meshes=rendered.meshes;room.textures=rendered.textures;
    } catch(error) {
      const location=graphicsLocation(this.reader,id);
      if(location){room.meshes=decodeRoomGeometry(this.reader,location.record,this.files,fileId=>this.segment(fileId)).meshes;
        const secondary=geometryAuxiliaryRecord(this.reader,0x5c5804,location.group,location.index,8);
        const decoded=decodeRoomGeometry(this.reader,location.record,this.files,fileId=>this.segment(fileId),{model:this.reader.u32(secondary),strict:true,id:`secondary:${secondary.toString(16)}`});
        if(decoded.complete)room.meshes.push(...decoded.meshes);}
      room.textures=[];room.warnings.push(`Texture preview failed; displaying untextured structural geometry: ${error instanceof Error?error.message:String(error)}`);
    }
    room.geometryAvailable=room.meshes.length>0;
    while(this.renderedRooms.size>=4)this.renderedRooms.delete(this.renderedRooms.keys().next().value!);
    this.renderedRooms.set(id,room);return structuredClone(room);
  }
  private loadBaseRoom(id:number):RoomData {
    if (!Number.isInteger(id) || id < 0 || id >= 800) throw new Error("Invalid native room ID.");
    const cached = this.rooms.get(id); if (cached) return structuredClone(cached);
    const pointer = this.reader.u32(ROOM_TABLE + id * 4);
    const metadata = pointer ? this.resident(pointer, 0x1c) : undefined, r = this.reader;
    const graphics = graphicsRecord(r, id);
    if (metadata === undefined && graphics === undefined) throw new Error(`Room 0x${id.toString(16)} has no verified native data.`);
    const fileId = metadata === undefined ? 0 : r.u16(metadata + 0x14);
    const warnings: string[] = [], actors: ActorData[] = [], seen = new Set<number>();
    const attempt = (label: string, parse: () => void) => {
      try { parse(); } catch (error) { warnings.push(`${label}: ${error instanceof Error ? error.message : String(error)}`); }
    };
    const parseList = (list: number, sourceKind: "resident" | "normal" | "partition") => {
      if (!list) return;
      const start = sourceKind === "resident" ? this.resident(list, 20) : this.resolve(list, fileId, 20);
      const fileEnd = sourceKind === "resident" ? FILE12_ROM + FILE12_SIZE : this.files.get(fileId)?.end ?? this.bytes.length;
      for (let index = 0; index < 4096; index++) {
        const at = r.check(start + index * 20, 20, fileEnd), definitionPointer = r.u32(at + 12);
        if (!definitionPointer) return;
        if (seen.has(at)) continue;
        const definition = sourceKind === "resident" ? this.resident(definitionPointer, 16) : this.resolve(definitionPointer, fileId, 16);
        const actorId = r.u16(definition), sourcePointer = list + index * 20;
        seen.add(at);
        actors.push({ id: `actor:${at.toString(16)}`, index: actors.length, actorId, name: `Actor 0x${actorId.toString(16).toUpperCase().padStart(3, "0")}`,
          position: { x: r.i16(at), y: r.i16(at + 2), z: r.i16(at + 4) },
          rotation: { x: r.i16(at + 6), y: r.i16(at + 8), z: r.i16(at + 10) },
          parameters: [r.u32(definition + 4), r.u32(definition + 8), r.u32(definition + 12)],
          source: this.source(at, 20, sourcePointer, sourceKind === "resident" ? 0 : fileId),
          definitionSource: this.source(definition, 16, definitionPointer, sourceKind === "resident" ? 0 : fileId), sourceKind, editable: true });
      }
      throw new Error("Actor list exceeds 4,096 records without a terminator.");
    };
    if (metadata !== undefined) {
    attempt("Resident actors", () => parseList(r.u32(metadata), "resident"));
    attempt("Normal actors", () => parseList(r.u32(metadata + 8), "normal"));
    attempt("Partition actors", () => {
      const gridPointer = r.u32(metadata + 12), configPointer = r.u32(metadata + 16);
      if (!gridPointer && !configPointer) return;
      const config = this.resolve(configPointer, fileId, 0x1a);
      const count = r.u16(config + 0x14) * r.u16(config + 0x16) * r.u16(config + 0x18);
      if (count > 65536) throw new Error("Actor partition grid exceeds its bounded limit.");
      if (!count) return;
      const grid = this.resolve(gridPointer, fileId, count * 4);
      for (let cell = 0; cell < count; cell++) attempt(`Partition ${cell}`, () => parseList(r.u32(grid + cell * 4), "partition"));
      const origin = {x: r.view.getFloat32(config + 8), y: r.view.getFloat32(config + 12), z: r.view.getFloat32(config + 16)};
      const cellSize = {x: r.u16(config), y: r.u16(config + 2), z: r.u16(config + 4)};
      const cellCount = {x: r.u16(config + 20), y: r.u16(config + 22), z: r.u16(config + 24)};
      if (![origin.x, origin.y, origin.z].every(Number.isFinite) || ![cellSize.x, cellSize.y, cellSize.z].every(n => n > 0))
        throw new Error("Invalid partition origin or cell dimensions; partition positions are read-only.");
      for (const actor of actors) if (actor.sourceKind === "partition") {
        const originalCell = {x:0,y:0,z:0};
        for (const axis of ["x", "y", "z"] as const) originalCell[axis] = nativePartitionCell(actor.position[axis], origin[axis], cellSize[axis], cellCount[axis]);
        actor.partition = {origin, cellSize, cellCount, originalCell};
      }
    });
    if (actors.some(actor => actor.sourceKind === "partition")) warnings.push("Partition actor positions can move within their original native spawn cell; crossing cells requires grid migration.");
    }
    const geometryEdit=this.translations.summary(id);
    if(geometryEdit.reason)warnings.push(geometryEdit.reason);
    const events = actors.flatMap(actor => { const event = actorEvent(actor); return event ? [event] : []; });
    events.forEach((event,index)=>{event.index=index;});
    warnings.push("Only verified actor-driven events are shown; room-specific event scripts and volumes are not decoded.");
    const room: RoomData = { id, name: ROOM_NAMES[id] ?? `Room 0x${id.toString(16).toUpperCase().padStart(3, "0")}`,
      actors, events, meshes: [], actorCount: actors.length, eventCount: events.length, geometryAvailable: geometryEdit.vertexCount > 0, warnings,
      geometryEdit,
      source: metadata === undefined ? this.source(graphics!, 20) : this.source(metadata, 0x1c, pointer, 0) };
    this.rooms.set(id, room); return structuredClone(room);
  }
}

export function importRomBytes(input: Uint8Array): ImportedRom {
  const normalized = normalizeRomByteOrder(input);
  const sha1 = hash(normalized, "sha1");
  if (sha1 !== COMPRESSED_SHA1 && sha1 !== DECOMPRESSED_SHA1)
    throw new Error("ROM checksum is not the supported unmodified US Mystical Ninja Starring Goemon release.");
  const bytes = sha1 === COMPRESSED_SHA1 ? decompressUsRom(normalized) : normalized;
  if (hash(bytes, "sha1") !== DECOMPRESSED_SHA1) throw new Error("Decompression did not reproduce the verified US ROM layout.");
  const identity: RomIdentity = { sha256: hash(input), normalizedSha256: hash(bytes),
    title: Buffer.from(bytes.subarray(0x20, 0x34)).toString("ascii").trim(),
    gameCode: Buffer.from(bytes.subarray(0x3b, 0x3f)).toString("ascii"), region: "US", byteLength: bytes.length, decompressed: true };
  return new ImportedRom(bytes, identity);
}
