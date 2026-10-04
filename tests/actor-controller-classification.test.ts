import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { nativeActorControllerClassification } from "../core/rom/actor-controller-classification";
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
function fixture() {
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
  return {
    bytes: canonical,
    reader: new RomReader(canonical),
    files: new Map(readFileTable(canonical).map((file) => [file.id, file])),
  };
}
const rejected = /unsupported guarded controller classification/;
const matched = [0x23b, 0x35e, 0x1bf];
// Independent frozen proof offsets. No ROM bytes, models or raw native dump are tracked.
const bodies: readonly [string, number][] = [
  ["noop", 0x6f57dc],
  ["audio", 0x6acd58],
  ["audioSetter", 0x6ace0c],
  ["cameraCtor", 0x6c24e8],
  ["cameraMain", 0x6c25ac],
  ["cameraSpeech", 0x6c2794],
  ["cameraSpeechWait", 0x6c2860],
  ["cameraPlayer", 0x6c28b4],
  ["cameraAllocate", 0x13540],
  ["cameraChild", 0x128ac],
  ["cameraCopyIn", 0x13478],
  ["cameraCopyOut", 0x13500],
  ["cameraDestructor", 0x12f04],
  ["playerAnimation", 0x596c78],
];
const tables: readonly [string, number, number][] = [
  ["23B initializer", 0x5e4578, 4],
  ["23B signed overlay", 0x5e511c, 2],
  ["23B file bounds", 0x58080, 8],
  ["23B allocation", 0x5581c, 8],
  ["23B parts pointer", 0x6a5c8, 4],
  ["23B terminator", 0x66398, 4],
  ["35E initializer", 0x5e4a04, 4],
  ["35E signed overlay", 0x5e5362, 2],
  ["35E file bounds", 0x58034, 8],
  ["35E allocation", 0x55784, 8],
  ["35E parts pointer", 0x6a57c, 4],
  ["35E terminator", 0x66398, 4],
  ["1BF initializer", 0x5e4388, 4],
  ["1BF signed overlay", 0x5e5024, 2],
  ["1BF file bounds", 0x5804c, 8],
  ["1BF allocation", 0x557b4, 8],
  ["1BF parts pointer", 0x6a594, 4],
  ["1BF terminator", 0x66398, 4],
];

test("unmatched actors return undefined without reading ROM, registry or supplied files", () => {
  const reader = new RomReader(new Uint8Array());
  const files = new Map<number, RomFile>();
  for (const actorId of [
    0,
    0x23c,
    0x35c,
    0x24c,
    0x1be,
    -1,
    NaN,
    Infinity,
    0x23b + 0.5,
  ])
    assert.equal(
      nativeActorControllerClassification(reader, files, actorId),
      undefined,
    );
});

test(
  "canonical finite controllers classify conservatively without execution, parameters or mutable input changes",
  { skip: !romPath },
  () => {
    const { bytes, reader, files } = fixture(),
      before = hash(bytes);
    const noop = nativeActorControllerClassification(reader, files, 0x23b)!;
    assert.deepEqual(
      {
        entry: noop.entry,
        overlay: noop.overlay,
        completed: noop.completed,
        resources: noop.resourceFileIds,
      },
      { entry: 0x080022fc, overlay: 43, completed: true, resources: [43] },
    );
    assert.match(noop.reason, /no intrinsic 3D/);
    assert.match(noop.reason, /empty constructor/);
    assert.equal(
      noop.provenance.length,
      33,
      "full identity plus14 body and18 table attestations",
    );
    for (const [name] of bodies)
      assert.ok(
        noop.provenance.some((line) => line.startsWith(`${name}:`)),
        name,
      );
    assert.match(noop.provenance[0], /executes no native behavior/);
    // Caller parameters remain independent of this exact native no-op classification.
    for (const parameters of [
      [0, 0, 0],
      [0xffffffff, 0xffffffff, 0xffffffff],
      [0x011c0001, 0, 0x00030000],
      [1, 2, 3],
    ]) {
      assert.ok(
        parameters.every(
          (word) => Number.isInteger(word) && word >= 0 && word <= 0xffffffff,
        ),
      );
      const input = { actorId: 0x23b, parameters };
      assert.deepEqual(
        nativeActorControllerClassification(reader, files, input.actorId),
        noop,
      );
      assert.deepEqual(input.parameters, parameters);
    }
    const sound = nativeActorControllerClassification(reader, files, 0x35e)!;
    assert.equal(sound.completed, false);
    assert.equal(sound.resourceFileIds, undefined);
    assert.match(sound.reason, /no intrinsic 3D/);
    assert.match(sound.reason, /16-byte zero-filled allocation tail/);
    const camera = nativeActorControllerClassification(reader, files, 0x1bf)!;
    assert.equal(camera.completed, false);
    assert.equal(camera.resourceFileIds, undefined);
    assert.match(camera.reason, /no intrinsic 3D world mesh/);
    assert.match(camera.reason, /existing player, dialogue UI/);
    // Returned metadata cannot corrupt a later classification or claim broader closure.
    noop.provenance.fill("tampered");
    noop.resourceFileIds!.push(11);
    assert.deepEqual(
      nativeActorControllerClassification(reader, files, 0x23b)!
        .resourceFileIds,
      [43],
    );
    assert.notEqual(
      nativeActorControllerClassification(reader, files, 0x23b)!.provenance[0],
      "tampered",
    );
    assert.equal(hash(bytes), before);
  },
);

test(
  "supplied file identities, bounds, compression and omissions cannot substitute for the actual file table",
  { skip: !romPath },
  () => {
    const { reader, files } = fixture();
    for (const id of [11, 24, 30, 43]) {
      for (const mutate of [
        (file: RomFile) => ({ ...file, id: 999 }),
        (file: RomFile) => ({ ...file, start: file.start + 4 }),
        (file: RomFile) => ({ ...file, end: file.end - 4 }),
        (file: RomFile) => ({ ...file, end: file.end + 16 }),
        (file: RomFile) => ({ ...file, compressed: true }),
      ]) {
        const changed = new Map(files);
        changed.set(id, mutate(files.get(id)!));
        assert.throws(
          () => nativeActorControllerClassification(reader, changed, 0x23b),
          rejected,
          `File${id}`,
        );
      }
      const missing = new Map(files);
      missing.delete(id);
      assert.throws(
        () => nativeActorControllerClassification(reader, missing, 0x23b),
        rejected,
        `missing File${id}`,
      );
    }
  },
);

test(
  "all14 finite reachable bodies and18 canonical registry/allocation/parts tables fail closed on mutation",
  { skip: !romPath },
  () => {
    const { bytes, files } = fixture(),
      changed = bytes.slice(),
      reader = new RomReader(changed);
    for (const [name, offset] of bodies) {
      changed[offset] ^= 1;
      for (const actorId of matched)
        assert.throws(
          () => nativeActorControllerClassification(reader, files, actorId),
          /finite reachable body hash changed/,
          name,
        );
      changed[offset] ^= 1;
    }
    for (const [name, offset, size] of tables) {
      changed[offset + size - 1] ^= 1;
      for (const actorId of matched)
        assert.throws(
          () => nativeActorControllerClassification(reader, files, actorId),
          rejected,
          name,
        );
      changed[offset + size - 1] ^= 1;
    }
    assert.equal(
      hash(changed),
      canonicalHash,
      "every test mutation was restored",
    );
  },
);

test(
  "same CPU entry under another signed overlay and a missing16-byte BSS allocation tail are unsupported",
  { skip: !romPath },
  () => {
    const { bytes, files } = fixture(),
      changed = bytes.slice(),
      reader = new RomReader(changed),
      view = new DataView(changed.buffer);
    for (const actorId of matched) {
      const at = 0x5e4ca6 + actorId * 2,
        old = reader.i16(at);
      view.setInt16(at, -1);
      assert.throws(
        () => nativeActorControllerClassification(reader, files, actorId),
        /signed overlay identity changed/,
      );
      view.setInt16(at, old);
    }
    view.setUint32(0x55788, 0x08000e70);
    assert.throws(
      () => nativeActorControllerClassification(reader, files, 0x35e),
      /exact native allocation changed/,
    );
    view.setUint32(0x55788, 0x08000e80);
    class NoPseudoBssReader extends RomReader {
      override u32(offset: number) {
        assert.ok(
          offset < 0x6ad3c0 || offset >= 0x6ad3d0,
          "native BSS is not fetched as adjacent ROM bytes",
        );
        return super.u32(offset);
      }
    }
    assert.equal(
      nativeActorControllerClassification(
        new NoPseudoBssReader(changed),
        files,
        0x35e,
      )!.completed,
      false,
    );
    assert.equal(hash(changed), canonicalHash);
  },
);

test(
  "full canonical identity, camera work template, raw overlay preimages and truncation remain mandatory",
  { skip: !romPath },
  () => {
    const { bytes, files } = fixture(),
      changed = bytes.slice(),
      reader = new RomReader(changed);
    for (const [offset, expected] of [
      [0x3e, /SHA256 identity changed/],
      [0x64340, /camera initial-work template hash changed/],
      [0x6f34e0, /canonical raw image hash changed/],
    ] as const) {
      changed[offset] ^= 1;
      assert.throws(
        () => nativeActorControllerClassification(reader, files, 0x23b),
        expected,
      );
      changed[offset] ^= 1;
    }
    for (const end of [64, 0x5e4388, 0x6ad3bf, bytes.length - 4])
      assert.throws(
        () =>
          nativeActorControllerClassification(
            new RomReader(bytes.subarray(0, end)),
            files,
            0x23b,
          ),
        /ROM is truncated/,
      );
    assert.equal(hash(bytes), canonicalHash);
  },
);
