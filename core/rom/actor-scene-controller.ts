import { createHash } from "node:crypto";
import type { NativeActorControllerClassification } from "./actor-controller-classification";
import { RomReader } from "./binary";
import { FILE_ID_BASE, readFileTable, type RomFile } from "./decompress";

const CANONICAL_BYTES = 0x2000000;
const CANONICAL_SHA256 =
  "e40bee20508c2e29e651dca4e47504e40f908f0a2186e34a582784bf5a64be4c";
const ENTRY = 0x0800a924;
const OVERLAY = 29;
const FILE_START = 0x6b32a0;
const FILE_END = 0x6bf750;
const ALLOCATION_START = 0x08000000;
const ALLOCATION_END = 0x0800c4b0;
const RAW_SHA256 =
  "07505526ba319bef5e85e463153f05759c73b68c39222cc45136da7535328267";

interface BodyGuard {
  name: string;
  namespace: "overlay29" | "main-static";
  cpu: number;
  rom: number;
  bytes: number;
  sha256: string;
}
// Frozen 357 proof: the complete finite state-machine body has no intrinsic model binder.
// Typed camera/light allocation is corroboration of external effects, not resource closure.
// Main-static mappings below are CPU - 0x80000000 + 0xC00, never an overlay/resident guess.
const BODIES: readonly BodyGuard[] = [
  {
    name: "sceneStateMachine",
    namespace: "overlay29",
    cpu: 0x800a924,
    rom: 0x6bdbc4,
    bytes: 2424,
    sha256: "7c657f8a07f3eba9556c0c2d40cc0cc38b94957d224a88ff7b395c06f73bf401",
  },
  {
    name: "cameraAllocate",
    namespace: "main-static",
    cpu: 0x80012940,
    rom: 0x13540,
    bytes: 408,
    sha256: "1d0ff84c1d6f93517f071071c33790da8ccc86d2ba8787bcf687aed81d328dee",
  },
  {
    name: "cameraChild",
    namespace: "main-static",
    cpu: 0x80011cac,
    rom: 0x128ac,
    bytes: 1624,
    sha256: "42c6f5511b64b1f837b5de17c5b4abd7aee38d964ba4298aeb315813eac26e4f",
  },
  {
    name: "cameraCopyIn",
    namespace: "main-static",
    cpu: 0x80012878,
    rom: 0x13478,
    bytes: 136,
    sha256: "e0b15f25722e152961d45bb72ae751004c01b0552a70413872f9f09a78d60c0b",
  },
  {
    name: "cameraCopyOut",
    namespace: "main-static",
    cpu: 0x80012900,
    rom: 0x13500,
    bytes: 56,
    sha256: "8b39c71444408f6bd8f7b20011c6daf3d4ca5ba155c050d15865a4bcf3707026",
  },
  {
    name: "cameraDestructor",
    namespace: "main-static",
    cpu: 0x80012304,
    rom: 0x12f04,
    bytes: 124,
    sha256: "29743a8b8b6f5935f133e021570cd1298f5c4c04b3c24b6806dd64c2363cb6aa",
  },
  {
    name: "lightAllocate",
    namespace: "main-static",
    cpu: 0x8001381c,
    rom: 0x1441c,
    bytes: 284,
    sha256: "ae5b5121cd1e135635e389e70b4589e93e4a3f5041d59ad39f670ac35cbc7974",
  },
];
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const hex = (value: number) => `0x${value.toString(16)}`;

/** Static metadata proof only: never executes callbacks or fabricates native allocations.
 * Frozen evidence: mnsg-actors-357-358-35d census/proof (357-first0) and the earlier
 * 23B/35E/1BF typed camera proof. Placement names/parameters do not establish this role.
 * Rechecks current mutable bytes and supplied File29 identity on every invocation.
 * completed=false intentionally retains unknown future player/audio/UI dependencies.
 */
export function nativeSceneControllerClassification(
  reader: RomReader,
  files: ReadonlyMap<number, RomFile>,
  actorId: number,
): NativeActorControllerClassification | undefined {
  // No ROM, supplied-map or registry access for every other actor, including adjacent IDs.
  if (actorId !== 0x357) return undefined;
  try {
    if (reader.bytes.length !== CANONICAL_BYTES)
      throw new Error(
        "canonical normalized US ROM length changed or ROM is truncated",
      );
    const actualFiles = new Map(
      readFileTable(reader.bytes).map((file) => [file.id, file]),
    );
    const file = files.get(OVERLAY),
      actual = actualFiles.get(OVERLAY);
    if (
      !file ||
      !actual ||
      file.id !== OVERLAY ||
      file.start !== actual.start ||
      file.end !== actual.end ||
      file.compressed !== actual.compressed ||
      file.compressed
    )
      throw new Error(
        "File29 supplied identity/bounds/compression disagree with the native file table",
      );
    if (
      file.start !== FILE_START ||
      file.end !== FILE_END ||
      reader.u32(FILE_ID_BASE + OVERLAY * 4) !== FILE_START ||
      reader.u32(FILE_ID_BASE + (OVERLAY + 1) * 4) !== FILE_END
    )
      throw new Error("File29 exact canonical ROM bounds/compression changed");
    reader.check(file.start, file.end - file.start);
    if (reader.u32(0x5e49e8) !== ENTRY || reader.i16(0x5e5354) !== OVERLAY)
      throw new Error(
        "Actor0x357 initializer entry/signed overlay identity changed",
      );
    if (
      reader.u32(0x557ac) !== ALLOCATION_START ||
      reader.u32(0x557b0) !== ALLOCATION_END ||
      ALLOCATION_END - ALLOCATION_START !== file.end - file.start
    )
      throw new Error(
        "File29 exact native allocation/zero BSS-tail extent changed",
      );
    if (reader.u32(0x6a590) !== 0x80065798 || reader.u32(0x66398) !== 0)
      throw new Error("File29 empty PIC-parts pointer/terminator changed");
    const provenance = [
      "Static metadata proof: executes no native behavior, creates no task/camera/light objects, mutates no wave cache; completed=false is not export admission or resource closure.",
      `Actor0x357 initializer ROM0x5e49e8=${hex(ENTRY)}, signed overlay ROM0x5e5354=29; File29 plain ROM${hex(FILE_START)}..${hex(FILE_END)}, native allocation ${hex(ALLOCATION_START)}..${hex(ALLOCATION_END)}, zero BSS tail; PIC pointer ROM0x6a590=0x80065798, terminator ROM0x66398=0.`,
    ];
    const firstFile = actualFiles.get(1);
    if (!firstFile)
      throw new Error("native file table has no first-file boundary");
    for (const guard of BODIES) {
      if (guard.namespace === "overlay29") {
        if (
          guard.rom !== file.start + guard.cpu - ALLOCATION_START ||
          guard.cpu < ALLOCATION_START ||
          guard.cpu + guard.bytes > ALLOCATION_END
        )
          throw new Error(
            `${guard.name} overlay29 CPU/file allocation mapping changed`,
          );
        reader.check(guard.rom, guard.bytes, file.end);
      } else {
        if (guard.rom !== guard.cpu - 0x80000000 + 0xc00)
          throw new Error(`${guard.name} main-static CPU/ROM mapping changed`);
        reader.check(guard.rom, guard.bytes, firstFile.start);
      }
      if (
        hash(reader.bytes.subarray(guard.rom, guard.rom + guard.bytes)) !==
        guard.sha256
      )
        throw new Error(`${guard.name} finite body hash changed`);
      provenance.push(
        `${guard.name}: ${guard.namespace}, CPU${hex(guard.cpu)}, ROM${hex(guard.rom)}, ${guard.bytes} bytes, SHA256 ${guard.sha256}.`,
      );
    }
    // Read-only preimage supporting camera work layout; not a substituted allocation.
    reader.check(0x64340, 96);
    const templateHash =
      "3bf26d76595c263385918d994276f74562ebbf879c42ce8bae4913180eadd70f";
    if (hash(reader.bytes.subarray(0x64340, 0x643a0)) !== templateHash)
      throw new Error("camera initial-work template hash changed");
    provenance.push(
      `cameraTemplate: main-static CPU0x80063740, ROM0x64340, 96 bytes, SHA256 ${templateHash}.`,
    );
    if (hash(reader.bytes.subarray(file.start, file.end)) !== RAW_SHA256)
      throw new Error("File29 full canonical raw image hash changed");
    if (hash(reader.bytes) !== CANONICAL_SHA256)
      throw new Error("canonical normalized US ROM SHA256 identity changed");
    provenance.push(
      `File29 full raw-image SHA256 ${RAW_SHA256}; canonical normalized US ROM ${CANONICAL_BYTES} bytes, SHA256 ${CANONICAL_SHA256}.`,
    );
    provenance.push(
      "Finite 0x357 state machine has no intrinsic 3D world mesh. The guarded typed camera allocator uses a 0x20000000 render tag; the guarded light allocator produces task+0xCC/0xD2 objects with 0x30000000/0x50000000 tags, not mesh descriptors. These allocations and future callbacks were not executed.",
    );
    return {
      entry: ENTRY,
      overlay: OVERLAY,
      completed: false,
      reason:
        "No intrinsic 3D world mesh: camera, light and scene controller. Reads and changes the live player and progression state, allocates typed camera/light objects, and retains future audio and dialogue/UI effects; native state-machine execution and resource closure remain unsupported.",
      provenance,
    };
  } catch (error) {
    throw new Error(
      `Actor0x357 unsupported guarded scene-controller classification: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
