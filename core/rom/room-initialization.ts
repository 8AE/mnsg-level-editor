import { createHash } from "node:crypto";
import type { NativeInitializationSource, RoomInitialization } from "../../shared/room-initialization";
import type { RomReader } from "./binary";
import { readFileTable, type RomFile } from "./decompress";

const CANONICAL_SHA256 = "e40bee20508c2e29e651dca4e47504e40f908f0a2186e34a582784bf5a64be4c";
const ROM_SIZE = 0x2000000;
const ROOM_TABLE = 0x5ec7d0, ROOM_COUNT = 800;
const METADATA_START = 0x8022ea18, METADATA_END = 0x80231300;
const CALLBACK_START = 0x8020de40, CALLBACK_END = 0x802112d8;
const LIST_START = 0x8022c240, LIST_END = 0x8022ea18;
const RESIDENT = {
  11: { rom: 0x587370, cpu: 0x801cb460, size: 0x41400 },
  12: { rom: 0x5c8770, cpu: 0x8020d2a0, size: 0x2e0d0 },
} as const;
const BOUNDARIES = [0, 300, 350, 400, 540, 544, 549, 561, 588, 607, 613, 618, 619, 620];
const PRIMARY = [0x802053d0, 0x8020612c, 0x80206874, 0x80206e64, 0x80207a34, 0x80207fd8];
const RESOURCES = [0x80205ad8, 0x80206500, 0x80206b94, 0x802074f4, 0x80207d2c, 0x80208550];
const GRAPHICS_COUNTS = [90, 49, 40, 84, 38, 70];
const LIMITS = [
  "Room loader metadata does not decode full gameplay events or an event graph.",
  "Future actor callbacks, flags, contact branches and dynamic children are not evaluated.",
  "Absent ordinary-world metadata does not establish that a special scene has no events.",
  "No native callbacks are executed and no spatial markers or executable edits are generated.",
  "Cold geometry order is distinct from callback dependencies; live registry reuse is not simulated.",
];
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
// Frozen from the independent canonical census and checked native dispatcher paths.
const GUARDS = [
  {
    "name": "room-registry",
    "romOffset": 6211536,
    "byteLength": 3200,
    "sha256": "3297c2bced6dcdf7254092b6cf5ea178f156617106fb150341f48a1a33c698da"
  },
  {
    "name": "room-metadata",
    "romOffset": 6201064,
    "byteLength": 10472,
    "sha256": "b2767d5ad7e1fc1fd138d1e073b8f5da20d5a527d669c02522ed2427f2c305d5"
  },
  {
    "name": "load-callback-wrappers",
    "romOffset": 6066960,
    "byteLength": 13464,
    "sha256": "18e795a48b7dde8304854cfa1978d5c095bfba31b23512dafb2fb45caf8ef849"
  },
  {
    "name": "dependency-lists",
    "romOffset": 6190864,
    "byteLength": 10200,
    "sha256": "cbf6effa73d44653af5f4bee53746c06294f04e3c36344fb03056992f033d8fd"
  },
  {
    "name": "stage-boundaries",
    "romOffset": 378384,
    "byteLength": 28,
    "sha256": "64a64e70a104c96b5a59f22557dafa8e84d328bc607f7564127f17060441de1c"
  },
  {
    "name": "primary-group-pointers",
    "romOffset": 6051820,
    "byteLength": 24,
    "sha256": "03f89a8afa748896312180857f4ab7af2d0cbf812a59fc6bc821b0e0268bd6b5"
  },
  {
    "name": "resource-group-pointers",
    "romOffset": 6051868,
    "byteLength": 24,
    "sha256": "703f3bf125c3a5fa0b1ed8a51fec4d39abf77dc853f517fe39284bcbb08028d6"
  },
  {
    "name": "world-dispatch-compare",
    "romOffset": 6064960,
    "byteLength": 76,
    "sha256": "edc4929ed2837f290b95a917476049ca5d834059bcf289198b1a654a3ec06861"
  },
  {
    "name": "world-dispatch-invoke",
    "romOffset": 6065036,
    "byteLength": 104,
    "sha256": "3eb4d11a25875c3be7e8fb8716826b18bbfe00ab67a483713a2c10707d456aad"
  },
  {
    "name": "dependency-list-loader",
    "romOffset": 83652,
    "byteLength": 80,
    "sha256": "042d107fc3b3599759009fcee00646caab02a4fe278a5751e1c43cc98a2a2fb5"
  },
  {
    "name": "main-stage-mapper",
    "romOffset": 49124,
    "byteLength": 188,
    "sha256": "cbbf7a5c690b972aad92bc759b395e9e6724d443f4978b120c00b04544b830ca"
  },
  {
    "name": "world-group-mapper",
    "romOffset": 5983772,
    "byteLength": 196,
    "sha256": "d00f953643b4e1ebd6c37e83eaeba56733944c05b3c0792e98dd0e41dfa411af"
  }
] as const;

interface MetadataEntry { roomId: number; pointer: number; callback: number; list: number }

/** Finite native inspection only. Mutable input bytes/file maps are rechecked on
 * every call; neither constructor nor rendered-room caches establish trust.
 */
export class NativeRoomInitialization {
  constructor(private readonly reader: RomReader, private readonly files: ReadonlyMap<number, RomFile>) {}

  inspect(roomId: number): RoomInitialization {
    if (!Number.isSafeInteger(roomId) || roomId < 0 || roomId >= ROOM_COUNT)
      throw new Error("Invalid native room initialization ID.");
    if (this.reader.bytes.length !== ROM_SIZE || digest(this.reader.bytes) !== CANONICAL_SHA256)
      throw new Error("Room initialization requires the current canonical 32 MiB normalized US ROM checksum.");
    for (const guard of GUARDS) {
      this.reader.check(guard.romOffset, guard.byteLength);
      if (digest(this.reader.bytes.subarray(guard.romOffset, guard.romOffset + guard.byteLength)) !== guard.sha256)
        throw new Error(`Native room initialization ${guard.name} source guard failed.`);
    }
    return this.inspectStructure(roomId);
  }

  private resident(cpuAddress: number, byteLength: number, fileId: 11 | 12): number {
    const allocation = RESIDENT[fileId];
    if (!Number.isSafeInteger(cpuAddress) || !Number.isSafeInteger(byteLength) || byteLength < 0 ||
      cpuAddress < allocation.cpu || cpuAddress + byteLength > allocation.cpu + allocation.size)
      throw new Error(`Native File${fileId} initialization pointer exceeds the verified resident allocation.`);
    const romOffset = allocation.rom + cpuAddress - allocation.cpu;
    return this.reader.check(romOffset, byteLength, allocation.rom + allocation.size);
  }
  private source(cpuAddress: number, byteLength: number, fileId: 11 | 12): NativeInitializationSource {
    const romOffset = this.resident(cpuAddress, byteLength, fileId);
    return { fileId, cpuAddress, romOffset, byteLength, sha256: digest(this.reader.bytes.subarray(romOffset, romOffset + byteLength)) };
  }
  private validateFiles(): void {
    const canonical = readFileTable(this.reader.bytes);
    if (canonical.length !== this.files.size) throw new Error("Native initialization supplied file map has a different identity/count.");
    for (const expected of canonical) {
      const file = this.files.get(expected.id);
      if (!file || ![Object.prototype, null].includes(Object.getPrototypeOf(file)) ||
        !Number.isSafeInteger(file.id) || !Number.isSafeInteger(file.start) || !Number.isSafeInteger(file.end) ||
        typeof file.compressed !== "boolean" || file.id !== expected.id || file.start !== expected.start ||
        file.end !== expected.end || file.compressed !== expected.compressed)
        throw new Error(`Native initialization supplied File${expected.id} identity/bounds do not match the ROM table.`);
    }
    for (const id of [11, 12] as const) {
      const file = this.files.get(id)!, allocation = RESIDENT[id];
      if (file.start !== allocation.rom || file.end !== allocation.rom + allocation.size || file.compressed)
        throw new Error(`Native initialization File${id} must be the verified plain resident allocation.`);
    }
  }
  private validFileId(id: number): void {
    const file = this.files.get(id);
    if (!Number.isSafeInteger(id) || id < 1 || id > 0xffff || !file || file.compressed)
      throw new Error(`Native initialization resource list contains invalid/plain-file ID ${id}.`);
  }
  private context(roomId: number): RoomInitialization["context"] {
    let stage = 0, localIndex = 0;
    for (let upper = 1; upper < BOUNDARIES.length; upper++) if (roomId < BOUNDARIES[upper]) {
      stage = upper - 1; localIndex = roomId - BOUNDARIES[stage]; break;
    }
    let geometryGroup = stage, geometryIndex = localIndex;
    if (stage === 0 && roomId >= 90) {
      geometryGroup = roomId < 128 ? 4 : 5;
      geometryIndex = localIndex - (geometryGroup === 4 ? 90 : 128);
    }
    return { stage, localIndex, geometryGroup, geometryIndex: geometryIndex & 0xffff };
  }
  private geometry(roomId: number, context: RoomInitialization["context"]): RoomInitialization["geometry"] {
    const { geometryGroup: group, geometryIndex: index } = context;
    if (roomId >= 620 || group >= GRAPHICS_COUNTS.length || index >= GRAPHICS_COUNTS[group]) return undefined;
    const primary = PRIMARY[group] + index * 20, resources = RESOURCES[group] + index * 8;
    const at = this.resident(resources, 8, 11);
    const resourceHalfwords = [0, 2, 4, 6].map(offset => this.reader.u16(at + offset)) as [number, number, number, number];
    const coldLoadOrder = [127, ...[1, 2, 0, 3].map(index => resourceHalfwords[index]).filter(id => id !== 0)];
    coldLoadOrder.forEach(id => this.validFileId(id));
    return { primarySource: this.source(primary, 20, 11), resourceSource: this.source(resources, 8, 11), resourceHalfwords, coldLoadOrder,
      ...(roomId >= 540 && roomId <= 548 ? { ordinaryGeometryAliasRoomId: (group === 4 ? 90 : 128) + index } : {}) };
  }
  private callbackList(callback: number): number {
    if (callback < CALLBACK_START || callback + 36 > CALLBACK_END || (callback - CALLBACK_START) % 36)
      throw new Error("Native room load callback is outside the exact 36-byte wrapper arena.");
    const at = this.resident(callback, 36, 12);
    const words = Array.from({ length: 9 }, (_, index) => this.reader.u32(at + index * 4));
    const fixed = [0x27bdffe8, 0xafbf0014, 0x3c048023, 0x0c004eb1, undefined, 0x8fbf0014, 0x27bd0018, 0x03e00008, 0];
    if (fixed.some((word, index) => word !== undefined && words[index] !== word) || (words[4] >>> 16) !== 0x2484)
      throw new Error("Native room load callback does not match the complete verified nine-instruction wrapper.");
    // ADDIU executes in JAL's delay slot; its low halfword is SIGNED, not OR-ed.
    const low = words[4] & 0xffff, signedLow = low & 0x8000 ? low - 0x10000 : low;
    const list = ((words[2] & 0xffff) * 0x10000) + signedLow;
    if (list < LIST_START || list >= LIST_END || list % 2)
      throw new Error("Native callback dependency pointer exceeds the aligned list arena.");
    return list;
  }
  private inspectStructure(roomId: number): RoomInitialization {
    this.validateFiles();
    this.resident(0x80231300, ROOM_COUNT * 4, 12);
    if (BOUNDARIES.some((value, index) => this.reader.u16(0x5c610 + index * 2) !== value))
      throw new Error("Native stage boundary values changed.");
    for (let group = 0; group < 6; group++) {
      if (this.reader.u32(0x5c57ec + group * 4) !== PRIMARY[group] || this.reader.u32(0x5c581c + group * 4) !== RESOURCES[group] ||
        PRIMARY[group] + GRAPHICS_COUNTS[group] * 20 !== RESOURCES[group])
        throw new Error("Native geometry group pointer/index bounds changed.");
      this.resident(PRIMARY[group], GRAPHICS_COUNTS[group] * 20, 11);
      this.resident(RESOURCES[group], GRAPHICS_COUNTS[group] * 8, 11);
    }
    const entries: MetadataEntry[] = [];
    const metadata = new Set<number>(), callbacks = new Set<number>(), lists = new Set<number>();
    for (let id = 0; id < ROOM_COUNT; id++) {
      const pointer = this.reader.u32(ROOM_TABLE + id * 4);
      if (!pointer) continue;
      if (id >= 620 || pointer < METADATA_START || pointer + 28 > METADATA_END || (pointer - METADATA_START) % 28 || metadata.has(pointer))
        throw new Error("Native room metadata registry has an invalid, aliased or out-of-bounds pointer.");
      const at = this.resident(pointer, 28, 12), callback = this.reader.u32(at + 24);
      if (callbacks.has(callback)) throw new Error("Native room callback identities unexpectedly alias.");
      const list = this.callbackList(callback);
      if (lists.has(list)) throw new Error("Native callback dependency-list pointers unexpectedly alias.");
      const actorDataFileId = this.reader.u16(at + 20);
      if (actorDataFileId) this.validFileId(actorDataFileId);
      if (this.reader.u16(at + 22) !== 0) throw new Error("Native room metadata reserved halfword changed.");
      metadata.add(pointer); callbacks.add(callback); lists.add(list); entries.push({ roomId: id, pointer, callback, list });
    }
    if (entries.length !== 374 || metadata.size !== 374 || callbacks.size !== 374 || lists.size !== 374)
      throw new Error("Native room initialization registry inventory changed.");
    const sorted = [...lists].sort((a, b) => a - b);
    if (sorted[0] !== LIST_START) throw new Error("Native dependency arena start is not accounted for.");
    const dependencies = new Map<number, { source: NativeInitializationSource; orderedFileIds: number[] }>();
    for (let index = 0; index < sorted.length; index++) {
      const list = sorted[index], end = sorted[index + 1] ?? LIST_END, at = this.resident(list, end - list, 12);
      const orderedFileIds: number[] = []; let cursor = list;
      while (true) {
        if (cursor + 2 > end) throw new Error("Native dependency list has no terminator before the next distinct pointer/arena bound.");
        const id = this.reader.u16(at + cursor - list); cursor += 2;
        if (!id) break;
        this.validFileId(id); orderedFileIds.push(id);
        if (orderedFileIds.length > 31) throw new Error("Native dependency list exceeds the verified finite 31-file budget.");
      }
      if (orderedFileIds.length < 2) throw new Error("Native dependency list unexpectedly omits its canonical resources.");
      const padding = end - cursor;
      if (padding !== 0 && padding !== 2) throw new Error("Native dependency list has unexpected trailing allocation/padding.");
      if (padding && this.reader.u16(at + cursor - list) !== 0) throw new Error("Native dependency alignment padding is nonzero.");
      dependencies.set(list, { source: this.source(list, cursor - list, 12), orderedFileIds });
    }
    const context = this.context(roomId), geometry = this.geometry(roomId, context), entry = entries.find(entry => entry.roomId === roomId);
    if (!entry) {
      if (!geometry || roomId < 540 || roomId > 548) throw new Error("Room has no listed native initialization metadata or special geometry alias.");
      return { roomId, status: "special-geometry-alias", context, tableEntryRomOffset: ROOM_TABLE + roomId * 4, geometry,
        reason: "Special geometry alias has no ordinary-world File12 metadata. Its mode-specific scene/event setup is not decoded here.", limits: [...LIMITS] };
    }
    const at = this.resident(entry.pointer, 28, 12), source = this.source(entry.callback, 36, 12);
    return { roomId, status: "world-metadata", context, tableEntryRomOffset: ROOM_TABLE + roomId * 4,
      metadata: { source: this.source(entry.pointer, 28, 12) }, actorDataFileId: this.reader.u16(at + 20), reservedHalfword: this.reader.u16(at + 22),
      loadCallback: { source, symbol: `func_${entry.callback.toString(16).toUpperCase()}_${source.romOffset.toString(16).toUpperCase()}`, dependencyList: dependencies.get(entry.list)! },
      ...(geometry ? { geometry } : {}), reason: "Verified ordinary-world metadata and finite resource-loader assignment. This does not decode the room's full gameplay events.", limits: [...LIMITS] };
  }
}
