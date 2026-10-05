import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { nativeSceneControllerClassification } from "../core/rom/actor-scene-controller";
import { RomReader, normalizeRomByteOrder } from "../core/rom/binary";
import {
  decompressUsRom,
  readFileTable,
  type RomFile,
} from "../core/rom/decompress";

const romPath = process.env.MNSG_TEST_ROM;
const canonicalHash =
  "e40bee20508c2e29e651dca4e47504e40f908f0a2186e34a582784bf5a64be4c";
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
let canonical: Uint8Array | undefined;
function fixture(copy = false) {
  if (!romPath)
    throw new Error("Set MNSG_TEST_ROM to the user's unmodified US ROM.");
  if (!canonical) {
    const normalized = normalizeRomByteOrder(readFileSync(romPath));
    canonical =
      hash(normalized) === canonicalHash
        ? normalized
        : decompressUsRom(normalized);
    assert.equal(hash(canonical), canonicalHash);
  }
  const bytes = copy ? canonical.slice() : canonical;
  return {
    bytes,
    reader: new RomReader(bytes),
    files: new Map(readFileTable(bytes).map((file) => [file.id, file])),
  };
}
const rejection =
  /Actor0x357 unsupported guarded scene-controller classification/;

// Independent frozen disassembly coordinates, including the LAST instruction of the
// state machine. No ROM bytes, model data or private proof JSON are stored in this test.
const bodyMutations: readonly [string, number][] = [
  ["sceneStateMachine", 0x6bdbc4],
  ["sceneStateMachine", 0x6be53b],
  ["cameraAllocate", 0x13540],
  ["cameraChild", 0x128ac],
  ["cameraCopyIn", 0x13478],
  ["cameraCopyOut", 0x13500],
  ["cameraDestructor", 0x12f04],
  ["lightAllocate", 0x1441c],
];
function flipped(bytes: Uint8Array, offset: number, verify: () => void) {
  const original = bytes[offset];
  bytes[offset] ^= 1;
  try {
    verify();
  } finally {
    bytes[offset] = original;
  }
}

test("only 0x357 matches, with zero reads for adjacent actors and invalid IDs", () => {
  const inaccessibleReader = new Proxy(new RomReader(new Uint8Array()), {
    get() {
      throw new Error("unexpected ROM read");
    },
  });
  const inaccessibleFiles = new Proxy(new Map<number, RomFile>(), {
    get() {
      throw new Error("unexpected file-map read");
    },
  });
  for (const id of [
    0,
    0x356,
    0x358,
    0x35d,
    0x23b,
    0x35e,
    0x1bf,
    -1,
    NaN,
    Infinity,
    0x357 + 0.5,
  ])
    assert.equal(
      nativeSceneControllerClassification(
        inaccessibleReader,
        inaccessibleFiles,
        id,
      ),
      undefined,
    );
});

test(
  "canonical 357 classifies intrinsic controller effects without completion, resources or input mutation",
  { skip: !romPath },
  () => {
    const { bytes, reader, files } = fixture();
    const before = hash(bytes),
      records = [...files].map(([id, file]) => [id, { ...file }]);
    const result = nativeSceneControllerClassification(reader, files, 0x357)!;
    assert.equal(result.entry, 0x0800a924);
    assert.equal(result.overlay, 29);
    assert.equal(result.completed, false);
    assert.equal(Object.hasOwn(result, "resourceFileIds"), false);
    assert.deepEqual(Object.keys(result).sort(), [
      "completed",
      "entry",
      "overlay",
      "provenance",
      "reason",
    ]);
    assert.match(result.reason, /No intrinsic 3D world mesh/);
    assert.match(result.reason, /camera, light and scene controller/);
    assert.match(result.reason, /live player and progression/);
    assert.match(result.reason, /future audio and dialogue\/UI effects/);
    assert.match(result.reason, /resource closure remain unsupported/);
    assert.ok(
      result.provenance.some((line) =>
        /executes no native behavior/.test(line),
      ),
    );
    assert.ok(result.provenance.some((line) => /0x20000000/.test(line)));
    assert.ok(
      result.provenance.some((line) => /0x30000000\/0x50000000/.test(line)),
    );
    assert.ok(result.provenance.some((line) => line.includes(canonicalHash)));
    for (const [name] of bodyMutations)
      assert.ok(
        result.provenance.some((line) => line.startsWith(`${name}:`)),
        name,
      );
    assert.equal(hash(bytes), before);
    assert.deepEqual([...files], records);
    // Classification does not retain or mutate returned provenance between requests.
    const expected = [...result.provenance];
    result.provenance.fill("caller mutation");
    assert.deepEqual(
      nativeSceneControllerClassification(reader, files, 0x357)!.provenance,
      expected,
    );
  },
);

test(
  "supplied File29 identity, bounds, compression and missing records fail closed",
  { skip: !romPath },
  () => {
    const { reader, files } = fixture();
    for (const changes of [
      { id: 30 },
      { start: 0x6b32a4 },
      { end: 0x6bf74c },
      { end: 0x6bf760 },
      { compressed: true },
      { start: -1 },
      { end: 0x2000004 },
    ]) {
      const changed = new Map(files);
      changed.set(29, { ...files.get(29)!, ...changes });
      assert.throws(
        () => nativeSceneControllerClassification(reader, changed, 0x357),
        /File29 supplied identity\/bounds\/compression/,
      );
    }
    const missing = new Map(files);
    missing.delete(29);
    // A record at the same CPU address under a different overlay cannot substitute.
    missing.set(0, files.get(29)!);
    assert.throws(
      () => nativeSceneControllerClassification(reader, missing, 0x357),
      rejection,
    );
    assert.throws(
      () => nativeSceneControllerClassification(reader, new Map(), 0x357),
      rejection,
    );
    // A previously valid map is checked again after in-place record mutation.
    const changed = new Map(files),
      record = { ...files.get(29)! };
    changed.set(29, record);
    assert.ok(nativeSceneControllerClassification(reader, changed, 0x357));
    record.compressed = true;
    assert.throws(
      () => nativeSceneControllerClassification(reader, changed, 0x357),
      rejection,
    );
  },
);

test(
  "entry, signed overlay, file table, exact allocation and empty PIC metadata cannot drift",
  { skip: !romPath },
  () => {
    const { bytes, reader, files } = fixture(true);
    const tableChanges: readonly [string, number][] = [
      ["initializer", 0x5e49e8],
      ["signed overlay", 0x5e5354],
      ["file start", 0x58048],
      ["file end", 0x5804c],
      ["allocation start", 0x557ac],
      ["allocation end", 0x557b0],
      ["parts pointer", 0x6a590],
      ["parts terminator", 0x66398],
    ];
    for (const [name, offset] of tableChanges)
      flipped(bytes, offset, () =>
        assert.throws(
          () => nativeSceneControllerClassification(reader, files, 0x357),
          rejection,
          name,
        ),
      );
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const overlay = view.getInt16(0x5e5354);
    view.setInt16(0x5e5354, -29);
    try {
      assert.throws(
        () => nativeSceneControllerClassification(reader, files, 0x357),
        /signed overlay identity/,
      );
    } finally {
      view.setInt16(0x5e5354, overlay);
    }
    const end = view.getUint32(0x557b0);
    view.setUint32(0x557b0, end + 16);
    try {
      assert.throws(
        () => nativeSceneControllerClassification(reader, files, 0x357),
        /allocation\/zero BSS-tail/,
      );
    } finally {
      view.setUint32(0x557b0, end);
    }
    assert.ok(nativeSceneControllerClassification(reader, files, 0x357));
  },
);

test(
  "complete finite scene and typed camera/light body preimages are guarded",
  { skip: !romPath },
  () => {
    const { bytes, reader, files } = fixture(true);
    for (const [name, offset] of bodyMutations)
      flipped(bytes, offset, () =>
        assert.throws(
          () => nativeSceneControllerClassification(reader, files, 0x357),
          new RegExp(`${name} finite body hash changed`),
        ),
      );
    flipped(bytes, 0x64340, () =>
      assert.throws(
        () => nativeSceneControllerClassification(reader, files, 0x357),
        /camera initial-work template hash/,
      ),
    );
    // An overlay byte OUTSIDE the classified function still invalidates the full image.
    flipped(bytes, 0x6b32a0, () =>
      assert.throws(
        () => nativeSceneControllerClassification(reader, files, 0x357),
        /File29 full canonical raw image hash/,
      ),
    );
    assert.ok(nativeSceneControllerClassification(reader, files, 0x357));
  },
);

test(
  "current full ROM identity is checked on every call even outside guarded bodies",
  { skip: !romPath },
  () => {
    const { bytes, reader, files } = fixture(true);
    assert.ok(nativeSceneControllerClassification(reader, files, 0x357));
    for (const offset of [0x10, 0x1000000, bytes.length - 1])
      flipped(bytes, offset, () =>
        assert.throws(
          () => nativeSceneControllerClassification(reader, files, 0x357),
          /canonical normalized US ROM SHA256 identity/,
        ),
      );
    assert.equal(hash(bytes), canonicalHash);
    assert.ok(nativeSceneControllerClassification(reader, files, 0x357));
  },
);

test(
  "truncated, unnormalized and wrong-sized ROM inputs reject clearly",
  { skip: !romPath },
  () => {
    const { bytes, files } = fixture();
    for (const length of [0, 64, 0x6be53c, bytes.length - 1])
      assert.throws(
        () =>
          nativeSceneControllerClassification(
            new RomReader(bytes.subarray(0, length)),
            files,
            0x357,
          ),
        /length changed or ROM is truncated/,
      );
    const oversized = new Uint8Array(bytes.length + 4);
    oversized.set(bytes);
    assert.throws(
      () =>
        nativeSceneControllerClassification(
          new RomReader(oversized),
          files,
          0x357,
        ),
      rejection,
    );
    const swapped = bytes.slice();
    for (let i = 0; i < swapped.length; i += 2) {
      const high = swapped[i];
      swapped[i] = swapped[i + 1];
      swapped[i + 1] = high;
    }
    assert.throws(
      () =>
        nativeSceneControllerClassification(
          new RomReader(swapped),
          files,
          0x357,
        ),
      rejection,
      "a byte-swapped 32MiB image cannot satisfy the normalized preimage",
    );
    // The user-owned compressed ROM is not the normalized decompressed preimage.
    if (romPath && readFileSync(romPath).length !== bytes.length)
      assert.throws(
        () =>
          nativeSceneControllerClassification(
            new RomReader(readFileSync(romPath)),
            files,
            0x357,
          ),
        rejection,
      );
  },
);
