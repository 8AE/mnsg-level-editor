import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { importRomBytes } from "../core/rom";
import { NativeCollisionHarness } from "../core/authoring/native-harness";
import { compileCollision, decodeCollision, planeFromTriangle, nativePlaneValue, type CollisionBranch, type CollisionPlane, type CollisionVector, COLLISION_CELL_LIMIT, compileTriangleCollision } from "../core/authoring/collision";
const floor: CollisionPlane = { ...planeFromTriangle({ x: -10, y: 17, z: -10 }, { x: 10, y: 17, z: 10 }, { x: 10, y: 17, z: -10 }), classifier: 3, reserved: [1, 2, 3] };
const leaf = (plane: number): CollisionBranch => ({ plane, negative: null, positive: null });
const cell = (root: CollisionBranch) => ({ minimum: { x: -10, y: -32768, z: -10 }, maximum: { x: 10, y: 32767, z: 10 }, surface: 0x1234, unknownHalfword: 0x5678, root });
test("oriented collision planes preserve winding and native f32 equation", () => {
    assert.deepEqual(floor.normal, { x: 0, y: 1, z: 0 });
    assert.equal(floor.distance, -17);
    assert.equal(nativePlaneValue(floor, { x: 0, y: 17, z: 0 }), 0);
    const reverse = planeFromTriangle({ x: -10, y: 17, z: -10 }, { x: 10, y: 17, z: -10 }, { x: 10, y: 17, z: 10 });
    assert.equal(reverse.normal.y, -1);
    assert.equal(reverse.distance, 17);
    const oblique = planeFromTriangle({ x: 100, y: 30, z: -20 }, { x: 190, y: -5, z: 35 }, { x: -19, y: 83, z: 52 });
    assert.equal(nativePlaneValue(oblique, { x: 100, y: 30, z: -20 }), 0);
    assert.equal(Math.fround(oblique.normal.x), oblique.normal.x);
});
test("native collision bytes round-trip cell chain, bounds, surface, planes, shared BSP branches", () => {
    const shared = leaf(1), root: CollisionBranch = { plane: 0, negative: shared, positive: shared };
    const planes = [floor, { normal: { x: 1, y: 0, z: 0 }, distance: -5, classifier: 7 }];
    const compiled = compileCollision(planes, [cell(root), cell(root)]), decoded = decodeCollision(compiled);
    assert.equal(compiled.cellCount, 2);
    assert.equal(compiled.branchCount, 3);
    assert.equal(compiled.planes.length, 40);
    assert.equal(decoded.cells[0].next, decoded.cells[1].index);
    assert.equal(decoded.cells[1].next, 65535);
    assert.equal(decoded.cells[0].surface, 0x1234);
    assert.equal(decoded.cells[0].unknownHalfword, 0x5678);
    assert.equal(decoded.cells[0].minimum.y, -32768);
    assert.equal(decoded.cells[0].maximum.y, 32767);
    assert.deepEqual(decoded.planes[0], floor);
    const branch = decoded.branches.get(decoded.cells[0].root)!;
    assert.equal(branch.negative, branch.positive);
    assert.equal(decoded.branches.get(branch.negative)!.plane, 1);
    assert.equal(new DataView(compiled.tree.buffer).getUint16(2), 0x1234);
    assert.equal(new DataView(compiled.planes.buffer).getFloat32(12), -17);
});
test("collision compiler rejects degeneracy, nonfinite f32, bad topology and s16 bounds", () => {
    assert.throws(() => planeFromTriangle({ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 }, { x: 2, y: 2, z: 2 }), /Degenerate/);
    assert.throws(() => compileCollision([{ ...floor, distance: 1e50 }], [cell(leaf(0))]), /finite f32/);
    assert.throws(() => compileCollision([floor], [{ ...cell(leaf(0)), maximum: { x: 32768, y: 0, z: 0 } }]), /integer/);
    assert.throws(() => compileCollision([floor], [{ ...cell(leaf(0)), minimum: { x: 20, y: 0, z: 0 }, maximum: { x: 10, y: 1, z: 1 } }]), /inverted/);
    const cycle = leaf(0);
    cycle.negative = cycle;
    assert.throws(() => compileCollision([floor], [cell(cycle)]), /cycle/);
    assert.throws(() => compileCollision([floor], [cell(leaf(1))]), /plane index/);
});
test("decoder rejects malformed branch cycles and header overlap before traversal", () => {
    const compiled = compileCollision([floor], [cell(leaf(0))]);
    new DataView(compiled.tree.buffer).setUint16(3 * 6 + 2, 3);
    assert.throws(() => decodeCollision(compiled), /cycle/);
    new DataView(compiled.tree.buffer).setUint16(3 * 6 + 2, 1);
    assert.throws(() => decodeCollision(compiled), /overlaps/);
    assert.throws(() => decodeCollision({ planes: new Uint8Array(21), tree: new Uint8Array() }), /width/);
    const zero = compileCollision([floor], [cell(leaf(0))]);
    zero.planes.fill(0, 0, 12);
    assert.throws(() => decodeCollision(zero), /normal cannot be zero/);
    const overlap = compileCollision([floor], [cell(leaf(0)), cell(leaf(0))]);
    const tv = new DataView(overlap.tree.buffer);
    tv.setUint16(0, 2);
    tv.setUint16(12, 65535);
    assert.throws(() => decodeCollision(overlap), /headers overlap/);
});
test("decoder enforces the cell budget even when the excessive last cell terminates", () => {
    const tree = new Uint8Array((COLLISION_CELL_LIMIT + 1) * 24), v = new DataView(tree.buffer);
    for (let i = 0; i <= COLLISION_CELL_LIMIT; i++) {
        v.setUint16(i * 24, i === COLLISION_CELL_LIMIT ? 65535 : (i + 1) * 4);
        v.setUint16(i * 24 + 18, 0);
    }
    assert.throws(() => decodeCollision({ planes: compileCollision([floor], [cell(leaf(0))]).planes, tree }), /cell budget/);
});
const triangle = { vertices: [{ x: -100, y: 0, z: -100 }, { x: 0, y: 0, z: 100 }, { x: 100, y: 0, z: -100 }] as const, classifier: 1, surface: 0x1234 };
test("authored triangle compiler emits clipping planes and preserves native face winding", () => {
    const bytes = compileTriangleCollision([triangle]), decoded = decodeCollision(bytes);
    assert.equal(bytes.planeCount, 4);
    assert.equal(bytes.tree.length, 7 * 6);
    assert.equal(decoded.cells[0].surface, 0x1234);
    assert.deepEqual(decoded.planes.map(plane => plane.classifier), [0, 0, 0, 1]);
    assert.deepEqual(decoded.planes[3].normal, { x: 0, y: 1, z: 0 });
    for (let at = 3; at < 6; at++) {
        assert.equal(decoded.branches.get(at)!.negative, at + 1);
        assert.equal(decoded.branches.get(at)!.positive, 0);
    }
    assert.throws(() => compileTriangleCollision([{ ...triangle, classifier: 0 }]), /zero is reserved/);
});
test("compiled collision executes original native query instructions for polygon interior, backface and wall", { skip: !process.env.MNSG_TEST_ROM }, () => {
    const oracle = new NativeCollisionHarness(importRomBytes(readFileSync(process.env.MNSG_TEST_ROM!)).bytes);
    const floor = compileTriangleCollision([triangle]);
    const hit = oracle.query(floor, { origin: { x: 0, y: 20, z: 0 }, direction: { x: 0, y: -1, z: 0 }, maximumDistance: 100 });
    assert.equal(hit.status, 0x7fff);
    assert.deepEqual(hit.delta, { x: 0, y: -20, z: 0 });
    assert.deepEqual(hit.normal, { x: 0, y: 1, z: 0 });
    assert.equal(hit.surface, 0x1234);
    assert.equal(oracle.query(floor, { origin: { x: 95, y: 20, z: 0 }, direction: { x: 0, y: -1, z: 0 }, maximumDistance: 100 }).status, 0, "AABB inclusion must not replace triangle clipping");
    assert.equal(oracle.query(floor, { origin: { x: 0, y: -20, z: 0 }, direction: { x: 0, y: 1, z: 0 }, maximumDistance: 100 }).status, 0, "Winding remains one-sided");
    const wall = compileTriangleCollision([{ ...triangle, vertices: [{ x: 0, y: -100, z: -100 }, { x: 0, y: 100, z: -100 }, { x: 0, y: 0, z: 100 }] }]);
    const wallHit = oracle.query(wall, { origin: { x: 20, y: 0, z: 0 }, direction: { x: -1, y: 0, z: 0 }, maximumDistance: 100, kind: "horizontal" });
    assert.equal(wallHit.status, 0x7fff);
    assert.deepEqual(wallHit.normal, { x: 1, y: 0, z: 0 });
    assert.equal(wallHit.delta.x, -20);
    const stacked = compileTriangleCollision([triangle, { ...triangle, surface: 2, vertices: triangle.vertices.map(point => ({ ...point, y: 10 })) as [
                CollisionVector,
                CollisionVector,
                CollisionVector
            ] }]);
    for (const kind of ["vertical", "ray"] as const) {
        const nearest = oracle.query(stacked, { origin: { x: 0, y: 20, z: 0 }, direction: { x: 0, y: -1, z: 0 }, maximumDistance: 100, kind });
        assert.equal(nearest.status, 0x7fff);
        assert.equal(nearest.delta.y, -10);
        assert.equal(nearest.surface, 2);
    }
});
