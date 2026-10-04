import type { GeometryMesh } from "../../shared/types";
import { RomReader } from "./binary";
import type { RomFile } from "./decompress";

const FILE11_ROM = 0x587370, FILE11_VRAM = 0x801cb460, FILE11_SIZE = 0x41400;
const GRAPHICS_TABLE = 0x5c57ec;
// Verified array ends are the following collision-pointer tables in file 11.
const GRAPHICS_COUNTS = [90, 49, 40, 84, 38, 70] as const;

/** Geometry group selection recovered from func_801F95D8_5B54E8. */
export function graphicsLocation(r: RomReader, roomId: number): { group: number; index: number; record: number } | undefined {
  if (roomId < 0 || roomId >= 620) return undefined;
  let group = 0;
  while (group < 13 && roomId >= r.u16(0x5c610 + (group + 1) * 2)) group++;
  let index = roomId - r.u16(0x5c610 + group * 2);
  if (group === 0 && roomId >= 90) {
    group = roomId < 128 ? 4 : 5; index = roomId - (group === 4 ? 90 : 128);
  }
  // Only six native graphics groups are established; remaining scene types are diagnosed.
  if (group >= 6) return undefined;
  if (index < 0 || index >= GRAPHICS_COUNTS[group]) return undefined;
  const pointer = r.u32(GRAPHICS_TABLE + group * 4);
  if (pointer < FILE11_VRAM || pointer >= FILE11_VRAM + FILE11_SIZE) throw new Error("Invalid room graphics group pointer.");
  return {group,index,record:r.check(FILE11_ROM + pointer - FILE11_VRAM + index * 20, 20, FILE11_ROM + FILE11_SIZE)};
}

export function graphicsRecord(r: RomReader, roomId: number): number | undefined { return graphicsLocation(r,roomId)?.record; }

export function geometryAuxiliaryRecord(r: RomReader, table: number, group: number, index: number, stride: number): number {
  if (!Number.isInteger(group) || group < 0 || group >= 6 || !Number.isInteger(index) || index < 0 || index >= GRAPHICS_COUNTS[group])
    throw new Error("Invalid geometry array index.");
  const pointer=r.u32(table+group*4);
  if (pointer < FILE11_VRAM || pointer >= FILE11_VRAM + FILE11_SIZE) throw new Error("Invalid geometry auxiliary table pointer.");
  return r.check(FILE11_ROM + pointer - FILE11_VRAM + index * stride,stride,FILE11_ROM+FILE11_SIZE);
}

export interface GeometryVertexSource { fileId: number; segmentedAddress: number; romOffset: number; originalHex: string }
export interface GeometryCommandSource { fileId: number; segmentedAddress: number; romOffset: number; expectedHex: string }
export interface DecodedGeometry { meshes: GeometryMesh[]; warnings: string[]; complete: boolean; vertices: GeometryVertexSource[]; commands: GeometryCommandSource[] }

interface Vertex { x: number; y: number; z: number; color: number[] }
/** F3DEX primary geometry: native model type 0x40000000 submits this G_DL directly. */
export function decodeRoomGeometry(r: RomReader, record: number, files: Map<number, RomFile>, segment: (id: number) => number,
  options: { model?: number; id?: string; strict?: boolean } = {}): DecodedGeometry {
  const warnings: string[] = [], segments = new Map<number, RomFile>();
  for (let field = 8; field <= 16; field += 4) {
    const fileId = r.u32(record + field) & 0xffff;
    const file = files.get(fileId);
    if (fileId && file && !file.compressed) segments.set(segment(fileId), file);
  }
  const model = options.model ?? r.u32(record);
  if (!model || model === 0xffffffff || ((model & 0x8ffffffe) >>> 0) === 0) return { meshes: [], warnings: [], complete: true, vertices: [], commands: [] };
  if ((model & 0x70000000) !== 0x40000000) return { meshes: [], warnings: ["Room model uses an unsupported native model graph."], complete: false, vertices: [], commands: [] };
  const resolve = (pointer: number, size: number): number => {
    const file = segments.get(pointer >>> 24);
    if (!file) throw new Error(`Display list requires unmapped pointer 0x${pointer.toString(16)} (segment 0x${(pointer >>> 24).toString(16)}).`);
    return r.check(file.start + (pointer & 0xffffff), size, file.end);
  };
  const vertices = new Map<number, Vertex>(), positions: number[] = [], indices: number[] = [];
  const sources = new Map<number, GeometryVertexSource>();
  const commandSources = new Map<number,GeometryCommandSource>();
  const active = new Set<number>(); let commands = 0;
  const triangle = (a: number, b: number, c: number) => {
    const rows = [a, b, c].map(index => vertices.get(index));
    if (rows.some(row => !row)) throw new Error("Triangle references a vertex that was not loaded.");
    for (const row of rows as Vertex[]) { indices.push(positions.length / 3); positions.push(row.x, row.y, row.z); }
  };
  const run = (pointer: number, depth: number): void => {
    if (depth > 64 || active.has(pointer)) throw new Error("Display-list recursion exceeds a safe bound.");
    active.add(pointer);
    try {
      for (let offset = 0; offset < 1024 * 1024; offset += 8) {
        if (++commands > 200000) throw new Error("Display-list command budget exceeded.");
        const at = resolve(pointer + offset, 8), w0 = r.u32(at), w1 = r.u32(at + 4), opcode = w0 >>> 24;
        commandSources.set(at,{fileId:segments.get((pointer+offset)>>>24)!.id,segmentedAddress:pointer+offset,romOffset:at,expectedHex:r.hex(at,8)});
        if (opcode === 0xb8) return;
        if (opcode === 0x04) {
          const count = (w0 >>> 10) & 63, first = ((w0 >>> 16) & 255) / 2;
          if (!count || !Number.isInteger(first) || first + count > 64) throw new Error("Invalid F3DEX vertex range.");
          const base = resolve(w1, count * 16);
          for (let i = 0; i < count; i++) {
            const v = base + i * 16;
            sources.set(v,{fileId:segments.get(w1>>>24)!.id,segmentedAddress:w1+i*16,romOffset:v,originalHex:r.hex(v,6)});
            vertices.set(first + i, { x: r.i16(v), y: r.i16(v + 2), z: r.i16(v + 4), color: [r.bytes[v + 12] / 255, r.bytes[v + 13] / 255, r.bytes[v + 14] / 255] });
          }
        } else if (opcode === 0x06) {
          const branch=(w0>>>16)&255;
          if (branch!==0&&branch!==1) throw new Error("Invalid display-list push mode.");
          run(w1, depth + 1); if (branch === 1) return;
        } else if (opcode === 0xbf) {
          triangle(((w1 >>> 16) & 255) / 2, ((w1 >>> 8) & 255) / 2, (w1 & 255) / 2);
        } else if (opcode === 0xb1) {
          triangle(((w0 >>> 16) & 255) / 2, ((w0 >>> 8) & 255) / 2, (w0 & 255) / 2);
          triangle(((w1 >>> 16) & 255) / 2, ((w1 >>> 8) & 255) / 2, (w1 & 255) / 2);
        } else if (opcode === 0x01) throw new Error("Display list contains an unsupported matrix transform.");
        else if (opcode === 0xb0) throw new Error("Display list contains an unsupported branch-Z command.");
        else if (options.strict) {
          if (opcode===0x03) {
            const subtype=(w0>>>16)&255;
            if (subtype!==0x8a)
              throw new Error(`Unsupported MOVEMEM subtype 0x${subtype.toString(16)}.`);
          } else if (opcode===0xbc) {
            const subtype=w0&255;
            if (subtype!==0x02) throw new Error(`Unsupported MOVEWORD subtype 0x${subtype.toString(16)}.`);
          } else if (![0x00,0xb6,0xb7,0xb9,0xba,0xbb,0xc0,0xe6,0xe7,0xe8,0xe9,0xea,0xeb,0xec,0xed,0xee,0xef,0xf0,0xf2,0xf3,0xf4,0xf5,0xf7,0xf8,0xf9,0xfa,0xfb,0xfc,0xfd,0xfe,0xff].includes(opcode))
            throw new Error(`Unsupported geometry command 0x${opcode.toString(16)}.`);
        }
      }
      throw new Error("Display list has no bounded END command.");
    } finally { active.delete(pointer); }
  };
  let complete=true;
  try { run((model & 0x8ffffffe) >>> 0, 0); } catch (error) { complete=false; warnings.push(`Partial geometry: ${error instanceof Error ? error.message : String(error)}`); }
  if (positions.length) warnings.push("Geometry uses flat untextured material; native materials, vertex lighting and textures are not rendered.");
  // Vertex bytes may be normals under G_LIGHTING, so they are not reported as colors.
  return { meshes: positions.length ? [{ id: options.id ?? `geometry:${record.toString(16)}`, source: "display-list", positions, indices }] : [], warnings,
    complete, vertices:[...sources.values()],commands:[...commandSources.values()] };
}
