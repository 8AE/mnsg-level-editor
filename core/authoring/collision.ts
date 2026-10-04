/** Big-endian static collision records used by native 8002AAD8/8002B3B0.
 * This encoder accepts an explicit decision tree. Triangle-to-cell classification
 * is separate: the native side/terminal rules must not be guessed here. */
export interface CollisionVector {
    x: number;
    y: number;
    z: number;
}
export interface PlaneEquation {
    normal: CollisionVector;
    distance: number;
}
export interface CollisionPlane extends PlaneEquation {
    classifier: number;
    reserved?: readonly [
        number,
        number,
        number
    ];
}
export interface CollisionBranch {
    plane: number;
    negative: CollisionBranch | null;
    positive: CollisionBranch | null;
}
export interface CollisionCell {
    minimum: CollisionVector;
    maximum: CollisionVector;
    surface: number;
    unknownHalfword: number;
    root: CollisionBranch;
}
export interface CompiledCollision {
    planes: Uint8Array;
    tree: Uint8Array;
    cellCount: number;
    branchCount: number;
    planeCount: number;
}
const AXES = ["x", "y", "z"] as const;
export const COLLISION_SLOT_LIMIT = 65535;
export const COLLISION_DEPTH_LIMIT = 128;
/** Seven slots per independent triangle: three header slots and four branches. */
export const COLLISION_CELL_LIMIT = Math.floor(COLLISION_SLOT_LIMIT / 7);
function integer(value: number, min: number, max: number, label: string) { if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(`${label} must be an integer in ${min}..${max}.`); return value; }
function finite(value: number, label: string) { if (!Number.isFinite(value) || !Number.isFinite(Math.fround(value)))
    throw new Error(`${label} must fit finite f32.`); return Math.fround(value); }
function vector(value: CollisionVector, label: string) { if (!value || AXES.some(axis => !Number.isFinite(value[axis])))
    throw new Error(`${label} must have finite coordinates.`); }
/** Winding is preserved: (b-a) cross (c-a) gives the oriented normal. */
export function planeFromTriangle(a: CollisionVector, b: CollisionVector, c: CollisionVector): PlaneEquation {
    for (const [point, label] of [[a, "a"], [b, "b"], [c, "c"]] as const)
        vector(point, label);
    const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z, vx = c.x - a.x, vy = c.y - a.y, vz = c.z - a.z;
    const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx, length = Math.hypot(x, y, z);
    if (!Number.isFinite(length) || length <= 1e-10)
        throw new Error("Degenerate collision triangle has no stable plane.");
    const normal = { x: finite(x / length, "Normal X"), y: finite(y / length, "Normal Y"), z: finite(z / length, "Normal Z") };
    const dot = Math.fround(Math.fround(Math.fround(normal.x * a.x) + Math.fround(normal.y * a.y)) + Math.fround(normal.z * a.z));
    return { normal, distance: finite(-dot, "Plane distance") };
}
export function nativePlaneValue(plane: PlaneEquation, point: CollisionVector): number {
    return Math.fround(Math.fround(Math.fround(Math.fround(plane.normal.x * point.x) + Math.fround(plane.normal.y * point.y)) + Math.fround(plane.normal.z * point.z)) + plane.distance);
}
export function compileCollision(planes: readonly CollisionPlane[], cells: readonly CollisionCell[]): CompiledCollision {
    if (!Array.isArray(planes) || planes.length > 65536 || !Array.isArray(cells) || cells.length > COLLISION_CELL_LIMIT)
        throw new Error("Collision plane/cell budget exceeded.");
    if (!cells.length)
        return { planes: new Uint8Array(), tree: new Uint8Array(), cellCount: 0, branchCount: 0, planeCount: 0 };
    if (!planes.length)
        throw new Error("Collision cells need at least one plane.");
    const planeBytes = new Uint8Array(planes.length * 20), pv = new DataView(planeBytes.buffer);
    planes.forEach((plane, index) => {
        vector(plane.normal, "Plane normal");
        if (Math.hypot(plane.normal.x, plane.normal.y, plane.normal.z) < 1e-10)
            throw new Error("Collision plane normal cannot be zero.");
        AXES.forEach((axis, i) => pv.setFloat32(index * 20 + i * 4, finite(plane.normal[axis], `Plane ${index} normal`)));
        pv.setFloat32(index * 20 + 12, finite(plane.distance, `Plane ${index} distance`));
        pv.setUint8(index * 20 + 16, integer(plane.classifier, 0, 255, "Classifier"));
        if (plane.reserved) {
            if (plane.reserved.length !== 3)
                throw new Error("Plane reserved bytes need exactly three values.");
            plane.reserved.forEach((byte: number, i: number) => pv.setUint8(index * 20 + 17 + i, integer(byte, 0, 255, "Reserved plane byte")));
        }
    });
    const words: number[][] = [], headers: number[] = [], active = new Set<CollisionBranch>(), shared = new Map<CollisionBranch, number>();
    let branches = 0;
    const slots = (count: number) => { const first = words.length; if (first + count > COLLISION_SLOT_LIMIT)
        throw new Error("Collision tree exceeds native u16 slot capacity."); for (let i = 0; i < count; i++)
        words.push([0, 0, 0]); return first; };
    const emit = (node: CollisionBranch, depth: number, forced?: number): number => {
        if (!node || typeof node !== "object" || depth > COLLISION_DEPTH_LIMIT)
            throw new Error("Collision branch exceeds the depth bound.");
        if (active.has(node))
            throw new Error("Collision decision tree contains a cycle.");
        const prior = shared.get(node);
        if (prior !== undefined && forced === undefined)
            return prior;
        const index = forced ?? slots(1);
        active.add(node);
        if (prior === undefined)
            shared.set(node, index);
        const plane = integer(node.plane, 0, planes.length - 1, "Branch plane index"), negative = node.negative === null ? 0 : emit(node.negative, depth + 1), positive = node.positive === null ? 0 : emit(node.positive, depth + 1);
        words[index] = [plane, negative, positive];
        active.delete(node);
        branches++;
        return index;
    };
    for (const cell of cells) {
        vector(cell.minimum, "Cell minimum");
        vector(cell.maximum, "Cell maximum");
        const minimum = AXES.map(axis => integer(cell.minimum[axis], -32768, 32767, "Cell minimum")), maximum = AXES.map(axis => integer(cell.maximum[axis], -32768, 32767, "Cell maximum"));
        if (minimum.some((value, i) => value > maximum[i]))
            throw new Error("Collision cell bounds are inverted.");
        const header = slots(4);
        headers.push(header);
        words[header] = [65535, integer(cell.surface, 0, 65535, "Surface attribute"), integer(cell.unknownHalfword, 0, 65535, "Cell unknown halfword")];
        words[header + 1] = maximum;
        words[header + 2] = minimum;
        emit(cell.root, 0, header + 3);
    }
    headers.forEach((header, index) => words[header][0] = headers[index + 1] ?? 65535);
    const tree = new Uint8Array(words.length * 6), tv = new DataView(tree.buffer);
    words.forEach((row, index) => row.forEach((value, column) => tv.setUint16(index * 6 + column * 2, value & 65535)));
    return { planes: planeBytes, tree, cellCount: cells.length, branchCount: branches, planeCount: planes.length };
}
/** Inspect the emitted layout without following any host/native pointer. */
export function decodeCollision(compiled: Pick<CompiledCollision, "planes" | "tree">): {
    planes: CollisionPlane[];
    cells: {
        index: number;
        next: number;
        minimum: CollisionVector;
        maximum: CollisionVector;
        surface: number;
        unknownHalfword: number;
        root: number;
    }[];
    branches: Map<number, {
        plane: number;
        negative: number;
        positive: number;
    }>;
} {
    const { planes, tree } = compiled;
    if (!(planes instanceof Uint8Array) || !(tree instanceof Uint8Array) || planes.length > 65536 * 20 || tree.length > COLLISION_SLOT_LIMIT * 6)
        throw new Error("Native collision buffer budget exceeded.");
    if (planes.length % 20 || tree.length % 6)
        throw new Error("Native collision record width mismatch.");
    const pv = new DataView(planes.buffer, planes.byteOffset, planes.byteLength), tv = new DataView(tree.buffer, tree.byteOffset, tree.byteLength), output: CollisionPlane[] = [];
    for (let at = 0; at < planes.length; at += 20) {
        const normal = { x: pv.getFloat32(at), y: pv.getFloat32(at + 4), z: pv.getFloat32(at + 8) }, distance = pv.getFloat32(at + 12);
        vector(normal, "Decoded normal");
        if (Math.hypot(normal.x, normal.y, normal.z) < 1e-10)
            throw new Error("Decoded collision normal cannot be zero.");
        finite(distance, "Decoded distance");
        output.push({ normal, distance, classifier: pv.getUint8(at + 16), reserved: [pv.getUint8(at + 17), pv.getUint8(at + 18), pv.getUint8(at + 19)] });
    }
    const cells: {
        index: number;
        next: number;
        minimum: CollisionVector;
        maximum: CollisionVector;
        surface: number;
        unknownHalfword: number;
        root: number;
    }[] = [], headers = new Set<number>(), headerSlots = new Set<number>();
    const check = (index: number, size: number) => { if (index < 0 || index * 6 + size > tree.length)
        throw new Error("Collision tree index exceeds its buffer."); return index * 6; };
    if (tree.length) {
        let index = 0;
        for (let count = 0; count <= COLLISION_CELL_LIMIT; count++) {
            if (headers.has(index))
                throw new Error("Collision cell chain contains a cycle.");
            if (cells.length >= COLLISION_CELL_LIMIT)
                throw new Error("Collision cell budget exceeded.");
            headers.add(index);
            const at = check(index, 18);
            for (let i = 0; i < 3; i++) {
                if (headerSlots.has(index + i))
                    throw new Error("Collision cell headers overlap.");
                headerSlots.add(index + i);
            }
            const next = tv.getUint16(at), readVector = (offset: number) => ({ x: tv.getInt16(at + offset), y: tv.getInt16(at + offset + 2), z: tv.getInt16(at + offset + 4) }), minimum = readVector(12), maximum = readVector(6);
            if (AXES.some(axis => minimum[axis] > maximum[axis]))
                throw new Error("Decoded collision bounds are inverted.");
            cells.push({ index, next, minimum, maximum, surface: tv.getUint16(at + 2), unknownHalfword: tv.getUint16(at + 4), root: index + 3 });
            if (next === 65535)
                break;
            if (count === COLLISION_CELL_LIMIT)
                throw new Error("Collision cell budget exceeded.");
            index = next;
        }
    }
    const branches = new Map<number, {
        plane: number;
        negative: number;
        positive: number;
    }>(), active = new Set<number>();
    const walk = (index: number, depth: number) => { if (!index)
        return; if (depth > COLLISION_DEPTH_LIMIT || active.has(index))
        throw new Error("Collision branch cycle/depth exceeded."); if (headerSlots.has(index))
        throw new Error("Collision branch overlaps a cell header."); if (branches.has(index))
        return; active.add(index); const at = check(index, 6), branch = { plane: tv.getUint16(at), negative: tv.getUint16(at + 2), positive: tv.getUint16(at + 4) }; if (branch.plane >= output.length)
        throw new Error("Collision branch has no plane."); branches.set(index, branch); walk(branch.negative, depth + 1); walk(branch.positive, depth + 1); active.delete(index); };
    cells.forEach(cell => walk(cell.root, 0));
    return { planes: output, cells, branches };
}
export interface NativeCollisionTriangle {
    vertices: readonly [
        CollisionVector,
        CollisionVector,
        CollisionVector
    ];
    classifier: number;
    surface: number;
}
/** Native one-sided triangle representation, verified by original 8002AAD8,
 * 8002B3B0 and 8002BDEC instructions against floor/slope/wall/ceiling fixtures.
 * Edge planes clip the polygon; the nonzero face classifier selects its normal.
 * No triangle is enlarged to its AABB, and no winding is silently reversed. */
export function compileTriangleCollision(triangles: readonly NativeCollisionTriangle[]): CompiledCollision {
    if (!Array.isArray(triangles) || triangles.length > COLLISION_CELL_LIMIT)
        throw new Error(`Authored collision exceeds the native ${COLLISION_CELL_LIMIT}-triangle capacity (u16 BSP slots). Split or simplify the room collision.`);
    const planes: CollisionPlane[] = [], cells: CollisionCell[] = [];
    for (const [index, triangle] of triangles.entries()) {
        if (!triangle || !Array.isArray(triangle.vertices) || triangle.vertices.length !== 3)
            throw new Error(`Collision triangle ${index} needs three vertices.`);
        triangle.vertices.forEach((point: CollisionVector) => AXES.forEach(axis => integer(point[axis], -32768, 32767, `Collision triangle ${index} ${axis}`)));
        const classifier = integer(triangle.classifier, 1, 255, "Collision face classifier (zero is reserved for polygon clipping planes)");
        const face = planeFromTriangle(triangle.vertices[0], triangle.vertices[1], triangle.vertices[2]), first = planes.length;
        for (let edge = 0; edge < 3; edge++) {
            const a = triangle.vertices[edge], b = triangle.vertices[(edge + 1) % 3];
            planes.push({ ...planeFromTriangle(a, b, { x: a.x + face.normal.x, y: a.y + face.normal.y, z: a.z + face.normal.z }), classifier: 0 });
        }
        planes.push({ ...face, classifier });
        let root: CollisionBranch = { plane: first + 3, negative: null, positive: null };
        for (let edge = 2; edge >= 0; edge--)
            root = { plane: first + edge, negative: root, positive: null };
        const bound = (method: "min" | "max") => Object.fromEntries(AXES.map(axis => [axis, Math[method](...triangle.vertices.map((point: CollisionVector) => point[axis]))])) as unknown as CollisionVector;
        cells.push({ minimum: bound("min"), maximum: bound("max"), surface: integer(triangle.surface, 0, 65535, "Collision surface"), unknownHalfword: 0, root });
    }
    return compileCollision(planes, cells);
}
