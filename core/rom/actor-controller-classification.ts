import { createHash } from "node:crypto";
import { RomReader } from "./binary";
import { FILE_ID_BASE, readFileTable, type RomFile } from "./decompress";

export interface NativeActorControllerClassification {
  entry: number;
  overlay: number;
  reason: string;
  completed: boolean;
  resourceFileIds?: number[];
  provenance: string[];
}

const CANONICAL_SHA256 =
  "e40bee20508c2e29e651dca4e47504e40f908f0a2186e34a582784bf5a64be4c";
const CANONICAL_BYTES = 0x2000000;
const EMPTY_PARTS_POINTER = 0x80065798;
const EMPTY_PARTS_ROM = 0x66398;
interface BodyGuard {
  name: string;
  fileId: number;
  cpu: number;
  rom: number;
  bytes: number;
  sha256: string;
}
interface TableGuard {
  name: string;
  rom: number;
  bytes: number;
  sha256: string;
}
// Frozen finite disassembly proof: no controller-owned model binder occurs in these bodies.
// Existing-player animation is corroboration of external effects, not a closed dependency.
const BODIES: readonly BodyGuard[] = [
  {
    name: "noop",
    fileId: 43,
    cpu: 0x80022fc,
    rom: 0x6f57dc,
    bytes: 12,
    sha256: "691e766163b1b8288cf1e76b4dc9eb7dde764cde7f749bf5aef916d919300f2b",
  },
  {
    name: "audio",
    fileId: 24,
    cpu: 0x8000808,
    rom: 0x6acd58,
    bytes: 180,
    sha256: "a07d4fd5aee69bb5bd9b78b27614496cc7bcdd045020ff122424f42a2c72852d",
  },
  {
    name: "audioSetter",
    fileId: 24,
    cpu: 0x80008bc,
    rom: 0x6ace0c,
    bytes: 196,
    sha256: "18b588781a9413bda9babcb6b48fc54ab1aaaea37836d1dd8b518f9664f60d5b",
  },
  {
    name: "cameraCtor",
    fileId: 30,
    cpu: 0x8002d98,
    rom: 0x6c24e8,
    bytes: 196,
    sha256: "63096e7d30d0ea95d1f1232111ab19e3fda931b25cd48d7bc0cdd445d0dd3808",
  },
  {
    name: "cameraMain",
    fileId: 30,
    cpu: 0x8002e5c,
    rom: 0x6c25ac,
    bytes: 424,
    sha256: "9f64f0fd5d68500b21b978e26396b5049ac93929f99c7e7ab6fed27398b1f7ed",
  },
  {
    name: "cameraSpeech",
    fileId: 30,
    cpu: 0x8003044,
    rom: 0x6c2794,
    bytes: 204,
    sha256: "75841de53e8594dcd9590118ea669f9b58a70fe3e96bdd0e762d377b713c0c56",
  },
  {
    name: "cameraSpeechWait",
    fileId: 30,
    cpu: 0x8003110,
    rom: 0x6c2860,
    bytes: 84,
    sha256: "210d372c65d1cdeee41177989ca1c3175df99f99ea2c10b8548788d067ff39c9",
  },
  {
    name: "cameraPlayer",
    fileId: 30,
    cpu: 0x8003164,
    rom: 0x6c28b4,
    bytes: 388,
    sha256: "c68ec2bc1e2aa9635f9b744b2bf8b0b67579a6a16c5d1cf6433633d6e51b4472",
  },
  {
    name: "cameraAllocate",
    fileId: 0,
    cpu: 0x80012940,
    rom: 0x13540,
    bytes: 408,
    sha256: "1d0ff84c1d6f93517f071071c33790da8ccc86d2ba8787bcf687aed81d328dee",
  },
  {
    name: "cameraChild",
    fileId: 0,
    cpu: 0x80011cac,
    rom: 0x128ac,
    bytes: 1624,
    sha256: "42c6f5511b64b1f837b5de17c5b4abd7aee38d964ba4298aeb315813eac26e4f",
  },
  {
    name: "cameraCopyIn",
    fileId: 0,
    cpu: 0x80012878,
    rom: 0x13478,
    bytes: 136,
    sha256: "e0b15f25722e152961d45bb72ae751004c01b0552a70413872f9f09a78d60c0b",
  },
  {
    name: "cameraCopyOut",
    fileId: 0,
    cpu: 0x80012900,
    rom: 0x13500,
    bytes: 56,
    sha256: "8b39c71444408f6bd8f7b20011c6daf3d4ca5ba155c050d15865a4bcf3707026",
  },
  {
    name: "cameraDestructor",
    fileId: 0,
    cpu: 0x80012304,
    rom: 0x12f04,
    bytes: 124,
    sha256: "29743a8b8b6f5935f133e021570cd1298f5c4c04b3c24b6806dd64c2363cb6aa",
  },
  {
    name: "playerAnimation",
    fileId: 11,
    cpu: 0x801dad68,
    rom: 0x596c78,
    bytes: 492,
    sha256: "e9008c328e9e72bc585898c2ff9a13a09c95f0e46e51135cd42c79861e92f5f0",
  },
];
const TABLES: readonly TableGuard[] = [
  {
    name: "0x23bInitializer",
    rom: 0x5e4578,
    bytes: 4,
    sha256: "937f411959025e57503b5344ceaa6e3c3a186c106a0c6f8273003f5e4af51864",
  },
  {
    name: "0x23bCodeFile",
    rom: 0x5e511c,
    bytes: 2,
    sha256: "541232e2aa3f8edc67d9f9ea0c39d63311cda71c466343617fd9f6672ffd31a3",
  },
  {
    name: "0x23bFileBounds",
    rom: 0x58080,
    bytes: 8,
    sha256: "4c04038bc15d415bdc0897ae7654d7da27f43454a29b0481937bf405744d1bf7",
  },
  {
    name: "0x23bAllocation",
    rom: 0x5581c,
    bytes: 8,
    sha256: "fd9d1e54b11e47315318b7f7cfb6357e69c8b0f18bf0d274b018e8d108ced5cd",
  },
  {
    name: "0x23bPartsPointer",
    rom: 0x6a5c8,
    bytes: 4,
    sha256: "a1e099c8af03f498f86fe1e3fd53976be51c2d1f9f8214597cf6c8c849f07d91",
  },
  {
    name: "0x23bPartsTerminator",
    rom: 0x66398,
    bytes: 4,
    sha256: "df3f619804a92fdb4057192dc43dd748ea778adc52bc498ce80524c014b81119",
  },
  {
    name: "0x35eInitializer",
    rom: 0x5e4a04,
    bytes: 4,
    sha256: "96759dfa9b12de06eaf8b11094630dc6be6455b609c1f6417c3cb04d94d6e8dd",
  },
  {
    name: "0x35eCodeFile",
    rom: 0x5e5362,
    bytes: 2,
    sha256: "b5609376c87f00c645433e48648cb02e6a3f83467f2c827194de5d58f971c8f0",
  },
  {
    name: "0x35eFileBounds",
    rom: 0x58034,
    bytes: 8,
    sha256: "59aad1f5fe027d75f722ba4ad4be9a2d55707181b5f4bf29b179a8288bb1a81b",
  },
  {
    name: "0x35eAllocation",
    rom: 0x55784,
    bytes: 8,
    sha256: "c06de45996cc862bc931f01a228f1f8a894c8c9f26ea44b326f33aaa090361ce",
  },
  {
    name: "0x35ePartsPointer",
    rom: 0x6a57c,
    bytes: 4,
    sha256: "a1e099c8af03f498f86fe1e3fd53976be51c2d1f9f8214597cf6c8c849f07d91",
  },
  {
    name: "0x35ePartsTerminator",
    rom: 0x66398,
    bytes: 4,
    sha256: "df3f619804a92fdb4057192dc43dd748ea778adc52bc498ce80524c014b81119",
  },
  {
    name: "0x1bfInitializer",
    rom: 0x5e4388,
    bytes: 4,
    sha256: "e1137add03448ef7eef9c11b8dad68b189a1ed593df98901686d03fcb126e917",
  },
  {
    name: "0x1bfCodeFile",
    rom: 0x5e5024,
    bytes: 2,
    sha256: "b3fe2f9bd5354b63ae8d0df01e7ad3074f42cbc1ac1f693b64d76ab5e0806587",
  },
  {
    name: "0x1bfFileBounds",
    rom: 0x5804c,
    bytes: 8,
    sha256: "94c86e5bdce975bf0da8c21f1c7374d054064b5176948a85948cc620bab9a944",
  },
  {
    name: "0x1bfAllocation",
    rom: 0x557b4,
    bytes: 8,
    sha256: "7b5ead8b5837488f4ab09804dfa2bd6fa5ee7cf03eca0a8940fbe4d56d2f67aa",
  },
  {
    name: "0x1bfPartsPointer",
    rom: 0x6a594,
    bytes: 4,
    sha256: "a1e099c8af03f498f86fe1e3fd53976be51c2d1f9f8214597cf6c8c849f07d91",
  },
  {
    name: "0x1bfPartsTerminator",
    rom: 0x66398,
    bytes: 4,
    sha256: "df3f619804a92fdb4057192dc43dd748ea778adc52bc498ce80524c014b81119",
  },
];
const CONTROLLERS = [
  {
    actorId: 0x23b,
    entry: 0x80022fc,
    overlay: 43,
    start: 0x6f34e0,
    end: 0x6fb200,
    allocationStart: 0x8000000,
    allocationEnd: 0x8007d20,
    rawSha256:
      "5139b21f811295f9fa395a9eaa07a98f67ba736f4dcd68d8cd9e0df67a7d97cb",
  },
  {
    actorId: 0x35e,
    entry: 0x8000808,
    overlay: 24,
    start: 0x6ac550,
    end: 0x6ad3c0,
    allocationStart: 0x8000000,
    allocationEnd: 0x8000e80,
    rawSha256:
      "9b31e9e5fc9e7a30886bf5a240bd658b7fabf1360908f0e6c633df5d6a3ea43b",
  },
  {
    actorId: 0x1bf,
    entry: 0x8002d98,
    overlay: 30,
    start: 0x6bf750,
    end: 0x6c8210,
    allocationStart: 0x8000000,
    allocationEnd: 0x8008ac0,
    rawSha256:
      "00df5232273ac961458edd29c8d4b15a697f3f9cf3a3e1e7facd215b4d195d00",
  },
];
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const hex = (value: number) => `0x${value.toString(16)}`;

/** Metadata only. Never executes a callback, allocates native work or simulates engine state.
 * No parameter/name/CPU-address-only matching; bytes must be the canonical normalized US ROM.
 * Every invocation rechecks the mutable input bytes and supplied file records (no identity cache).
 */
export function nativeActorControllerClassification(
  reader: RomReader,
  files: ReadonlyMap<number, RomFile>,
  actorId: number,
): NativeActorControllerClassification | undefined {
  const selected = CONTROLLERS.find(
    (controller) => controller.actorId === actorId,
  );
  if (!selected) return undefined;
  try {
    if (reader.bytes.length !== CANONICAL_BYTES)
      throw new Error(
        "canonical normalized US ROM length changed or ROM is truncated",
      );
    const actualFiles = new Map(
      readFileTable(reader.bytes).map((file) => [file.id, file]),
    );
    const verifiedFiles = new Map<number, RomFile>();
    for (const id of [11, 24, 30, 43]) {
      const file = files.get(id),
        actual = actualFiles.get(id);
      if (
        !file ||
        !actual ||
        file.id !== id ||
        file.start !== actual.start ||
        file.end !== actual.end ||
        file.compressed !== actual.compressed ||
        file.compressed
      )
        throw new Error(
          `File${id} supplied identity/bounds/compression disagree with the native file table`,
        );
      reader.check(file.start, file.end - file.start);
      verifiedFiles.set(id, file);
    }
    for (const controller of CONTROLLERS) {
      if (
        reader.u32(0x5e3c8c + controller.actorId * 4) !== controller.entry ||
        reader.i16(0x5e4ca6 + controller.actorId * 2) !== controller.overlay
      )
        throw new Error(
          `Actor${hex(controller.actorId)} initializer entry/signed overlay identity changed`,
        );
      const file = verifiedFiles.get(controller.overlay)!;
      if (
        file.start !== controller.start ||
        file.end !== controller.end ||
        reader.u32(FILE_ID_BASE + controller.overlay * 4) !==
          controller.start ||
        reader.u32(FILE_ID_BASE + (controller.overlay + 1) * 4) !==
          controller.end
      )
        throw new Error(
          `File${controller.overlay} canonical ROM bounds/compression changed`,
        );
      const allocation = 0x556c4 + controller.overlay * 8;
      if (
        reader.u32(allocation) !== controller.allocationStart ||
        reader.u32(allocation + 4) !== controller.allocationEnd
      )
        throw new Error(
          `File${controller.overlay} exact native allocation changed`,
        );
      const rawLength = file.end - file.start,
        tail =
          controller.allocationEnd - controller.allocationStart - rawLength;
      if (tail !== (controller.actorId === 0x35e ? 16 : 0))
        throw new Error(
          `File${controller.overlay} raw/BSS-tail extent changed`,
        );
      if (
        reader.u32(0x6a51c + controller.overlay * 4) !== EMPTY_PARTS_POINTER ||
        reader.u32(EMPTY_PARTS_ROM) !== 0
      )
        throw new Error(
          `File${controller.overlay} empty PIC-parts pointer/terminator changed`,
        );
      const entryROM =
        file.start + controller.entry - controller.allocationStart;
      reader.check(entryROM, 4, file.end);
    }
    const provenance: string[] = [];
    for (const guard of BODIES) {
      const file = guard.fileId ? verifiedFiles.get(guard.fileId)! : undefined;
      if (file) {
        const start = reader.u32(0x556c4 + guard.fileId * 8);
        const end = reader.u32(0x556c8 + guard.fileId * 8);
        if (
          guard.rom !== file.start + guard.cpu - start ||
          guard.cpu < start ||
          guard.cpu + guard.bytes > end
        )
          throw new Error(
            `${guard.name} native CPU/file allocation mapping changed`,
          );
        reader.check(guard.rom, guard.bytes, file.end);
      } else {
        if (guard.rom !== guard.cpu - 0x80000000 + 0xc00)
          throw new Error(`${guard.name} resident CPU/ROM mapping changed`);
        reader.check(guard.rom, guard.bytes, actualFiles.get(1)!.start);
      }
      if (
        hash(reader.bytes.subarray(guard.rom, guard.rom + guard.bytes)) !==
        guard.sha256
      )
        throw new Error(`${guard.name} finite reachable body hash changed`);
      provenance.push(
        `${guard.name}: File${guard.fileId}, CPU${hex(guard.cpu)}, ROM${hex(guard.rom)}, ${guard.bytes} bytes, SHA256 ${guard.sha256}.`,
      );
    }
    for (const guard of TABLES) {
      reader.check(guard.rom, guard.bytes);
      if (
        hash(reader.bytes.subarray(guard.rom, guard.rom + guard.bytes)) !==
        guard.sha256
      )
        throw new Error(`${guard.name} canonical table hash changed`);
      provenance.push(
        `${guard.name}: ROM${hex(guard.rom)}, ${guard.bytes} bytes, SHA256 ${guard.sha256}.`,
      );
    }
    // The camera work template is read-only proof data, not an invented camera allocation.
    reader.check(0x64340, 96);
    if (
      hash(reader.bytes.subarray(0x64340, 0x643a0)) !==
      "3bf26d76595c263385918d994276f74562ebbf879c42ce8bae4913180eadd70f"
    )
      throw new Error("camera initial-work template hash changed");
    for (const controller of CONTROLLERS)
      if (
        hash(reader.bytes.subarray(controller.start, controller.end)) !==
        controller.rawSha256
      )
        throw new Error(
          `File${controller.overlay} canonical raw image hash changed`,
        );
    if (hash(reader.bytes) !== CANONICAL_SHA256)
      throw new Error("canonical normalized US ROM SHA256 identity changed");
    provenance.unshift(
      `Guarded canonical normalized US ROM SHA256 ${CANONICAL_SHA256}; all14 finite body and18 table preimages verified. Metadata classification executes no native behavior.`,
    );
    if (actorId === 0x23b)
      return {
        entry: selected.entry,
        overlay: selected.overlay,
        completed: true,
        resourceFileIds: [43],
        provenance,
        reason:
          "Registered native no-op has no intrinsic 3D mesh. Its complete three-instruction body only saves arguments to stack home slots and ignores all validated actor parameters. Completion certifies this finite empty constructor and its File43 code dependency only, not game installation or future lifecycle.",
      };
    if (actorId === 0x35e)
      return {
        entry: selected.entry,
        overlay: selected.overlay,
        completed: false,
        provenance,
        reason:
          "Persistent spatial-sound controller has no intrinsic 3D mesh. File24's 16-byte zero-filled allocation tail holds its live owner pointer; callbacks depend on current camera/audio/source-object ownership. Their state and future resource paths are not executed or certified.",
      };
    return {
      entry: selected.entry,
      overlay: selected.overlay,
      completed: false,
      provenance,
      reason:
        "Camera/scene controller has no intrinsic 3D world mesh. Its finite actor-owned callback graph manipulates typed camera work and the existing player, dialogue UI and interaction state. Camera allocation success and later player/UI resource paths are not executed or certified; these effects are retained, not treated as absent visuals.",
    };
  } catch (issue) {
    throw new Error(
      `Actor${hex(actorId)} unsupported guarded controller classification: ${issue instanceof Error ? issue.message : String(issue)}.`,
    );
  }
}
