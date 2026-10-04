/** F3DEX geometry encoding verified against libultra PR/gbi.h.
 * Pointer words remain relocation records until the runtime payload linker
 * supplies owned native/GBI addresses. Unlinked buffers are never export-ready. */
export interface NativeVertexInput {
    position: {
        x: number;
        y: number;
        z: number;
    };
    uv: readonly [
        number,
        number
    ];
    rgba: readonly [
        number,
        number,
        number,
        number
    ];
}
export interface NativeGeometryInput {
    vertices: readonly NativeVertexInput[];
    triangles: readonly (readonly [
        number,
        number,
        number
    ])[];
}
export interface NativeBufferRelocation {
    offset: number;
    target: "vertices";
    addend: number;
}
export interface NativeGeometryPayload {
    vertices: Uint8Array;
    displayList: Uint8Array;
    relocations: NativeBufferRelocation[];
    triangleCount: number;
    vertexCount: number;
    batchCount: number;
}
const CACHE_VERTICES = 32;
export const NATIVE_TRIANGLE_LIMIT = 65536;
function int(value: number, min: number, max: number, label: string) { if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(`${label} must be an integer in ${min}..${max}.`); return value; }
export function normalizedUv(value: number, textureDimension: number): number {
    if (!Number.isFinite(value) || !Number.isSafeInteger(textureDimension) || textureDimension < 1 || textureDimension > 4096)
        throw new Error("Texture coordinates need finite normalized UV and a bounded native texture dimension.");
    return int(Math.round(value * textureDimension * 32), -32768, 32767, "Native fixed-point UV");
}
export function compileVertex(vertex: NativeVertexInput): Uint8Array {
    if (!vertex || !vertex.position || !Array.isArray(vertex.uv) || vertex.uv.length !== 2 || !Array.isArray(vertex.rgba) || vertex.rgba.length !== 4)
        throw new Error("Malformed authored native vertex.");
    const bytes = new Uint8Array(16), view = new DataView(bytes.buffer);
    [vertex.position.x, vertex.position.y, vertex.position.z].forEach((value, index) => view.setInt16(index * 2, int(value, -32768, 32767, "Native vertex XYZ")));
    vertex.uv.forEach((value, index) => view.setInt16(8 + index * 2, int(value, -32768, 32767, "Native vertex UV")));
    vertex.rgba.forEach((value, index) => view.setUint8(12 + index, int(value, 0, 255, "Native vertex RGBA")));
    return bytes;
}
/** Rebatch indexed faces into a bounded RSP cache without changing winding/UV seams. */
export function compileGeometry(input: NativeGeometryInput): NativeGeometryPayload {
    if (!input || !Array.isArray(input.vertices) || !Array.isArray(input.triangles) || input.vertices.length > 65536 || input.triangles.length > NATIVE_TRIANGLE_LIMIT)
        throw new Error("Authored geometry exceeds vertex/triangle budgets .");
    // Validate every vertex, including unused imported vertices, before emitting.
    const encoded = input.vertices.map(compileVertex), vertexRows: Uint8Array[] = [], commands: [
        number,
        number
    ][] = [], relocations: NativeBufferRelocation[] = [];
    let cache = new Map<number, number>(), faces: number[][] = [], batchCount = 0;
    const flush = () => {
        if (!faces.length)
            return;
        const count = cache.size, addend = vertexRows.length * 16;
        // gsSPVertex(v,count,0): opcode04 | count<<10 | (sizeof(Vtx)*count-1).
        relocations.push({ offset: commands.length * 8 + 4, target: "vertices", addend });
        commands.push([(0x04000000 | (count << 10) | (count * 16 - 1)) >>> 0, 0]);
        for (const original of cache.keys())
            vertexRows.push(encoded[original]);
        for (const [a, b, c] of faces)
            commands.push([0xbf000000, ((a * 2 << 16) | (b * 2 << 8) | c * 2) >>> 0]);
        batchCount++;
        cache = new Map();
        faces = [];
    };
    for (const triangle of input.triangles) {
        if (!Array.isArray(triangle) || triangle.length !== 3)
            throw new Error("Authored face must contain exactly three vertex indices.");
        const indices = triangle.map(value => int(value, 0, input.vertices.length - 1, "Face vertex index"));
        if (new Set(indices).size !== 3)
            throw new Error("Degenerate authored face repeats a vertex index.");
        const needed = new Set(indices.filter(index => !cache.has(index))).size;
        if (cache.size + needed > CACHE_VERTICES)
            flush();
        const local = indices.map(index => { const existing = cache.get(index); if (existing !== undefined)
            return existing; const next = cache.size; cache.set(index, next); return next; });
        faces.push(local);
    }
    flush();
    commands.push([0xb8000000, 0]);
    const vertices = new Uint8Array(vertexRows.length * 16);
    vertexRows.forEach((row, index) => vertices.set(row, index * 16));
    const displayList = new Uint8Array(commands.length * 8), view = new DataView(displayList.buffer);
    commands.forEach((words, index) => { view.setUint32(index * 8, words[0]); view.setUint32(index * 8 + 4, words[1]); });
    return { vertices, displayList, relocations, triangleCount: input.triangles.length, vertexCount: vertexRows.length, batchCount };
}
/** Pure linker helper. Caller supplies a verified segmented/physical buffer base. */
export function linkGeometry(payload: NativeGeometryPayload, vertexAddress: number): Uint8Array {
    int(vertexAddress, 1, 0xffffffff, "Native vertex base");
    if (vertexAddress % 16 || vertexAddress + payload.vertices.length > 0x100000000)
        throw new Error("Native vertex allocation is unaligned or wraps the address space.");
    const output = payload.displayList.slice(), view = new DataView(output.buffer);
    for (const relocation of payload.relocations) {
        if (!Number.isSafeInteger(relocation.offset) || relocation.offset < 0 || !Number.isSafeInteger(relocation.addend) || relocation.addend < 0 || relocation.target !== "vertices" || relocation.offset % 8 !== 4 || relocation.offset + 4 > output.length || relocation.addend % 16 || relocation.addend >= payload.vertices.length)
            throw new Error("Malformed native geometry relocation.");
        view.setUint32(relocation.offset, vertexAddress + relocation.addend);
    }
    return output;
}
export interface NativeProximityGrid {
    configuration: Uint8Array;
    origin: {
        x: number;
        y: number;
        z: number;
    };
    widths: {
        x: number;
        y: number;
        z: number;
    };
    counts: {
        x: number;
        y: number;
        z: number;
    };
    cellCount: number;
    /** Global actor indices remain stable; lists get independent terminators. */
    cells: Map<number, number[]>;
}
/** Compile owned cells with native sub.S/div.S/add.S/trunc.w.S membership.
 * Two guard cells surround each side of the placements. This is a generated
 * grid policy, not a claim that every canonical room used a 512-unit cell. */
export function compileProximityGrid(placements: readonly {
    index: number;
    position: {
        x: number;
        y: number;
        z: number;
    };
}[], cellWidth = 512): NativeProximityGrid {
    int(cellWidth, 1, 65535, "Native proximity width");
    if (placements.length > 4096)
        throw new Error("Native proximity placement budget exceeded.");
    const axes = ["x", "y", "z"] as const;
    const origin = { x: 0, y: 0, z: 0 }, widths = { x: cellWidth, y: cellWidth, z: cellWidth }, counts = { x: 4, y: 4, z: 4 };
    const indices = new Set<number>();
    for (const placement of placements) {
        int(placement.index, 0, 4095, "Proximity actor index");
        if (indices.has(placement.index))
            throw new Error("Proximity grid contains a duplicate actor index.");
        indices.add(placement.index);
        for (const axis of axes)
            int(placement.position[axis], -32768, 32767, "Proximity actor coordinate");
    }
    for (const axis of axes) {
        if (!placements.length)
            continue;
        const minimum = Math.min(...placements.map(placement => placement.position[axis]));
        const maximum = Math.max(...placements.map(placement => placement.position[axis]));
        origin[axis] = Math.fround((minimum + maximum) / 2);
        counts[axis] = int(Math.ceil((maximum - minimum) / cellWidth) + 4, 1, 65535, "Native proximity count");
    }
    const cellCount = counts.x * counts.y * counts.z;
    if (!Number.isSafeInteger(cellCount) || cellCount > 2400000)
        throw new Error("Native proximity grid exceeds its bounded pointer allocation. Increase its cell width.");
    const configuration = new Uint8Array(28), view = new DataView(configuration.buffer);
    axes.forEach((axis, index) => { view.setUint16(index * 2, widths[axis]); view.setFloat32(8 + index * 4, origin[axis]); view.setUint16(20 + index * 2, counts[axis]); });
    const cells = new Map<number, number[]>();
    for (const placement of placements) {
        const coord = axes.map(axis => Math.trunc(Math.fround(Math.fround(Math.fround(placement.position[axis] - origin[axis]) / widths[axis]) + Math.fround(counts[axis] / 2))));
        if (coord.some((value, index) => value < 0 || value >= counts[axes[index]]))
            throw new Error("Generated native proximity cell is out of range.");
        const index = coord[0] * counts.y * counts.z + coord[1] * counts.z + coord[2];
        const list = cells.get(index) ?? [];
        list.push(placement.index);
        cells.set(index, list);
    }
    return { configuration, origin, widths, counts, cellCount, cells };
}
