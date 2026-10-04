import type { Vec3 } from "../../shared/types";
import type { GeometryTranslation } from "../rom/translation";

/** Supplied by the trusted ROM backend, never deserialized from a project. */
export type GetGeometryTranslation = (roomId: number, translation: Vec3) => GeometryTranslation | Promise<GeometryTranslation>;
export interface ExportGeometrySpan { fileId: number; address: number; romOffset: number; original: number[]; replacement: number[] }
export interface ExportGeometryGuard { fileId: number; address: number; romOffset: number; expected: number[] }
export interface ExportGeometryOperation { roomId: number; spans: ExportGeometrySpan[]; guards: ExportGeometryGuard[]; affectedRoomIds: number[] }
export const GEOMETRY_SPAN_LIMIT = 65536;
export const GEOMETRY_PAYLOAD_LIMIT = 2 * 1024 * 1024;
export const GEOMETRY_GUARD_LIMIT = 262144;

function integer(value: number, min: number, max: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Geometry ${label} must be an integer in ${min}..${max}.`);
  return value;
}
function decode(value: string, width: number): number[] {
  if (typeof value !== "string" || !new RegExp(`^[a-f0-9]{${width * 2}}$`, "i").test(value)) throw new Error(`Geometry span requires exactly ${width} verified bytes.`);
  return Array.from({ length: width }, (_, index) => parseInt(value.slice(index * 2, index * 2 + 2), 16));
}
export function geometryOperation(result: GeometryTranslation, roomId: number): ExportGeometryOperation {
  if (result.roomId !== roomId || !Array.isArray(result.spans) || !Array.isArray(result.affectedRoomIds)) throw new Error("Trusted geometry operation does not match its room.");
  if (!Array.isArray(result.guards) || !result.guards.length) throw new Error("Geometry operation requires verified read-only dependency guards.");
  const spans: ExportGeometrySpan[] = [];
  const seen = new Map<string, ExportGeometrySpan>();
  for (const span of result.spans) {
    if (!["vertexXYZ", "planeDistance", "cellBounds"].includes(span.kind)) throw new Error("Unsupported native geometry write kind.");
    const width = { vertexXYZ: 6, planeDistance: 4, cellBounds: 12 }[span.kind];
    const fileId = integer(span.fileId, 1, 65535, "resource id");
    const address = integer(span.segmentedAddress, 0x01000000, 0x7fffffff, "segmented address");
    const romOffset = integer(span.romOffset, 0, Number.MAX_SAFE_INTEGER - width, "ROM offset");
    if (address % (width === 4 ? 4 : 2) || (address & 0xffffff) + width > 0x1000000) throw new Error("Unaligned or crossing native geometry span.");
    const original = decode(span.originalHex, width), replacement = decode(span.replacementHex, width);
    const key = `${fileId}:${address}`;
    const prior = seen.get(key);
    if (prior) {
      if (prior.romOffset !== romOffset || JSON.stringify([prior.original, prior.replacement]) !== JSON.stringify([original, replacement])) throw new Error("Contradictory duplicate geometry source.");
      continue;
    }
    const record = { fileId, address, romOffset, original, replacement };
    seen.set(key, record); spans.push(record);
  }
  if (spans.length > GEOMETRY_SPAN_LIMIT) throw new Error(`Geometry translation exceeds ${GEOMETRY_SPAN_LIMIT} spans. Export fewer rooms or a smaller operation.`);
  const guards: ExportGeometryGuard[] = [], guardKeys = new Map<string, ExportGeometryGuard>();
  for (const guard of result.guards) {
    if (!["planeNormal", "treeBranch", "cellTopology", "displayCommand"].includes(guard.kind)) throw new Error("Unsupported native geometry guard kind.");
    const width = { planeNormal: 12, treeBranch: 6, cellTopology: 6, displayCommand: 8 }[guard.kind];
    const fileId = integer(guard.fileId, 1, 65535, "guard resource id"), address = integer(guard.segmentedAddress, 0x01000000, 0x7fffffff, "guard segmented address");
    const romOffset = integer(guard.romOffset, 0, Number.MAX_SAFE_INTEGER - width, "guard ROM offset");
    if (address % (guard.kind === "planeNormal" ? 4 : guard.kind === "displayCommand" ? 8 : 2) || (address & 0xffffff) + width > 0x1000000) throw new Error("Unaligned or crossing native geometry guard.");
    const expected = decode(guard.expectedHex, width), key = `${fileId}:${address}`;
    const prior = guardKeys.get(key);
    if (prior) {
      if (prior.romOffset !== romOffset || JSON.stringify(prior.expected) !== JSON.stringify(expected)) throw new Error("Contradictory duplicate geometry guard.");
      continue;
    }
    const record = { fileId, address, romOffset, expected };
    guardKeys.set(key, record); guards.push(record);
  }
  if (guards.length > GEOMETRY_GUARD_LIMIT) throw new Error(`Geometry translation exceeds ${GEOMETRY_GUARD_LIMIT} dependency guards. Split this project into smaller exports.`);
  const affectedRoomIds = [...new Set(result.affectedRoomIds.map(value => integer(value, 0, 799, "shared room id")))].sort((a, b) => a - b);
  return { roomId, spans, guards, affectedRoomIds };
}
export function validateGeometryWrites(operations: ExportGeometryOperation[]): void {
  const nativeBytes = new Map<string, { original: number; replacement: number; start: number; width: number }>();
  const romBytes = new Map<number, { original: number; replacement: number }>();
  const nativeGuardBytes = new Map<string, number>(), romGuardBytes = new Map<number, number>();
  let count = 0, bytes = 0, guardCount = 0, guardBytes = 0;
  for (const operation of operations) for (const guard of operation.guards) {
    guardCount++; guardBytes += guard.expected.length;
    if (guardCount > GEOMETRY_GUARD_LIMIT || guardBytes > 4 * 1024 * 1024) throw new Error("Geometry dependency guards exceed 262144 records or 4 MiB. Split this project into smaller exports.");
    guard.expected.forEach((expected, index) => {
      const key = `${guard.fileId}:${guard.address + index}`, prior = nativeGuardBytes.get(key), romPrior = romGuardBytes.get(guard.romOffset + index);
      if ((prior !== undefined && prior !== expected) || (romPrior !== undefined && romPrior !== expected)) throw new Error("Conflicting original geometry dependency guards.");
      nativeGuardBytes.set(key, expected); romGuardBytes.set(guard.romOffset + index, expected);
    });
  }
  for (const operation of operations) for (const span of operation.spans) {
    count++; bytes += span.original.length * 2;
    if (count > GEOMETRY_SPAN_LIMIT || bytes > GEOMETRY_PAYLOAD_LIMIT) throw new Error(`Geometry export exceeds ${GEOMETRY_SPAN_LIMIT} spans or 2 MiB of payload. Split this project into smaller exports.`);
    span.original.forEach((original, index) => {
      const replacement = span.replacement[index];
      const key = `${span.fileId}:${span.address + index}`;
      if (nativeGuardBytes.has(key) || romGuardBytes.has(span.romOffset + index)) throw new Error("Geometry write spans overlap read-only dependency guards.");
      const nativePrior = nativeBytes.get(key), romPrior = romBytes.get(span.romOffset + index);
      if ((nativePrior && (nativePrior.original !== original || nativePrior.replacement !== replacement)) || (romPrior && (romPrior.original !== original || romPrior.replacement !== replacement))) throw new Error("Conflicting overlapping geometry edits. Shared sources must use identical translations.");
      if (nativePrior && (nativePrior.start !== span.address || nativePrior.width !== span.original.length)) throw new Error("Partially overlapping native geometry records are unsupported. Export complete identical source records.");
      nativeBytes.set(key, { original, replacement, start: span.address, width: span.original.length });
      romBytes.set(span.romOffset + index, { original, replacement });
    });
  }
}
export function geometrySource(operations: ExportGeometryOperation[]): string {
  if (!operations.length) return "";
  const spans: string[] = [], guards: string[] = [], operationRows: string[] = [], originals: number[] = [], replacements: number[] = [], guardOriginals: number[] = [];
  for (const operation of operations) {
    const first = spans.length;
    for (const span of operation.spans) {
      spans.push(`    { ${span.fileId}u, 0x${span.address.toString(16)}u, ${originals.length}u, ${span.original.length}u }`);
      originals.push(...span.original); replacements.push(...span.replacement);
    }
    const firstGuard = guards.length;
    for (const guard of operation.guards) {
      guards.push(`    { ${guard.fileId}u, 0x${guard.address.toString(16)}u, ${guardOriginals.length}u, ${guard.expected.length}u }`);
      guardOriginals.push(...guard.expected);
    }
    operationRows.push(`    { ${first}u, ${operation.spans.length}u, ${firstGuard}u, ${operation.guards.length}u }`);
  }
  const formatBytes = (values: number[]) => Array.from({ length: Math.ceil(values.length / 32) }, (_, index) => `    ${values.slice(index * 32, index * 32 + 32).join(", ")}`).join(",\n");
  return `
/* Static resource edits persist until unload; preview and gameplay objects may coexist. */
typedef struct { u32 file, address, offset, length; } GeometrySpan;
typedef struct { u32 first, count, first_guard, guard_count; } GeometryOperation;
static const unsigned char geometry_original[] = {
${formatBytes(originals)}
};
static const unsigned char geometry_replacement[] = {
${formatBytes(replacements)}
};
static const GeometrySpan geometry_spans[] = {
${spans.join(",\n")}
};
static const unsigned char geometry_guard_original[] = {
${formatBytes(guardOriginals)}
};
static const GeometrySpan geometry_guards[] = {
${guards.join(",\n")}
};
static const GeometryOperation geometry_operations[] = {
${operationRows.join(",\n")}
};
#define GEOMETRY_OPERATION_COUNT (sizeof(geometry_operations) / sizeof(geometry_operations[0]))
static unsigned char *geometry_resolve(const GeometrySpan *span) {
    signed int handle = func_800141C4_14DC4(span->file);
    /* Registry values can be tagged opaque handles; reject only missing/null.
     * Let the native mapper preserve its segment/handle interpretation. */
    if (handle == 0 || handle == -1) return 0;
    return (unsigned char *)func_80014840_15440((signed int)span->address, span->file);
}
static int geometry_matches(const unsigned char *pointer, const unsigned char *expected, u32 length) {
    u32 i;
    for (i = 0; i < length; ++i) if (pointer[i] != expected[i]) return 0;
    return 1;
}
void mnsg_level_apply_geometry_edits(void) {
    u32 operation_index, span_index, byte_index;
    for (operation_index = 0; operation_index < GEOMETRY_OPERATION_COUNT; ++operation_index) {
        const GeometryOperation *operation = &geometry_operations[operation_index];
        /* Normals, tree links, cell topology and display commands are required
         * unchanged dependencies of the precomputed translation, never writes. */
        for (span_index = 0; span_index < operation->guard_count; ++span_index) {
            const GeometrySpan *guard = &geometry_guards[operation->first_guard + span_index];
            unsigned char *pointer = geometry_resolve(guard);
            if (!pointer || !geometry_matches(pointer, geometry_guard_original + guard->offset, guard->length)) break;
        }
        if (span_index != operation->guard_count) continue;
        /* Validate every required wave and whole span before any operation write.
         * A span must be entirely original or entirely our desired value. */
        for (span_index = 0; span_index < operation->count; ++span_index) {
            const GeometrySpan *span = &geometry_spans[operation->first + span_index];
            unsigned char *pointer = geometry_resolve(span);
            if (!pointer || (!geometry_matches(pointer, geometry_original + span->offset, span->length) &&
                             !geometry_matches(pointer, geometry_replacement + span->offset, span->length))) break;
        }
        if (span_index != operation->count) continue;
        /* The synchronous mapper/lookup are read-only; no loading or callbacks
         * can invalidate preflight between these writes. Re-resolve each pointer
         * locally and retain no pointer across staging calls or unloads. */
        for (span_index = 0; span_index < operation->count; ++span_index) {
            const GeometrySpan *span = &geometry_spans[operation->first + span_index];
            unsigned char *pointer = geometry_resolve(span);
            for (byte_index = 0; byte_index < span->length; ++byte_index) pointer[byte_index] = geometry_replacement[span->offset + byte_index];
        }
    }
}
RECOMP_HOOK("func_801F8C4C_5B4B5C")
void mnsg_level_geometry_before_collision(void) {
    mnsg_level_apply_geometry_edits();
}
RECOMP_HOOK("func_801F95D8_5B54E8")
void mnsg_level_geometry_before_render(void *task, void *object) {
    (void)task;
    (void)object;
    mnsg_level_apply_geometry_edits();
}
`;
}
