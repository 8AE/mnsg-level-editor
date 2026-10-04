# Exporting room geometry and actor edits

The patch bundle contains `mnsg_level_patch.c` and `mnsg_level_patch.h`, plus a
standalone manifest, linker script, and integration instructions. Add the C/H
pair to a compatible MNSG mod's source tree. Preserve the existing mod's manifest
when integrating into another mod. The desktop export dialog creates a new
bundle directory to keep the supplied standalone files together.

For a ready-to-load `.nrm`, configure an initialized
[MNSGRecompModTemplate](https://github.com/klorfmorf/MNSGRecompModTemplate)
checkout, LLVM Clang with a MIPS backend, LLVM `ld.lld`, and `RecompModTool`.
Template submodules must supply the US game symbol files. The exporter accepts
both `mnsg.us.syms.toml`/`mnsg.us.datasyms.toml` and the newer
`mnsg.syms.toml`/`mnsg.datasyms.toml` names. On macOS select Homebrew LLVM;
Apple Clang does not provide the required target. The template documents the
LLVM 19.1 MIPS problem on Windows and recommends a compatible LLVM release.

The desktop process selects toolchain paths. Projects never supply executable
paths or command arguments. Builds use fixed argument arrays with `execFile`,
without a shell, in a temporary directory. Only the template's modding header
and two symbol tables are copied; its source tree and original files remain
unchanged. No complete ROM, model, texture, or decoded room asset is bundled.
The C/H payload contains the original/edited native records and dependency
preimages needed to apply and validate the selected changes.

## Supported native changes

- Resident and normal actor position and rotation use their original signed
  16-bit coordinate storage. Native list lengths, terminators, partition
  membership, and mutable spawn flags stay intact.
- Partition actor rotations and definition data can change. Their positions can
  move within the original proximity cell when its configuration is verified.
  Moves across cells stay blocked until native proximity-cell migration is
  implemented; changing only the position would preserve the old trigger region.
  Cell validation mirrors native single-precision subtraction, division,
  addition and truncation rather than using JavaScript's default double
  precision at the boundary.
- Actor substitutions must use a type already present in that room's original
  roster. Arbitrary new types require modifying native resource dependencies.
- Three opaque unsigned 32-bit actor payload words are editable. Different
  actors can interpret these as resources or pointers. Their semantics are
  actor-specific, and require in-game checking. The unknown definition halfword
  at `+0x02` remains original.
- Static room translation updates the referenced visual vertices, collision
  plane distances and collision cell bounds together. Integer translation
  deltas can range from -65535 to 65535 when every resulting native coordinate
  remains in signed 16-bit range. Normals, tree links, surface flags and display
  commands remain unchanged. Actors, player entrances, camera paths, transitions
  and dynamic actor collision are separate data and do not move automatically.
- Geometry sources shared by rooms remain shared. The backend permits verified
  complete aliases and rejects incompatible partial sharing. Every affected room
  is identified in the export warnings; contradictory translations of the same
  source are rejected.
- Native event callback export remains unavailable. Editable actor-backed
  events are represented by their underlying actor edits. Room metadata's
  `+0x18` field is a resource loader callback, not an event placement list.

The generated hook uses the verified entry stage
[`func_8020D848_5C8D18`](https://8ae.github.io/mnsg-documentation/functions/func_8020D848_5C8D18/),
which precedes resident and normal actor initialization and retries while data
is loading. Every wave-backed pointer resolution first checks the non-faulting
`func_800141C4_14DC4` lookup for the missing-file sentinel. The native resolver
`func_80014840_15440` deliberately faults when asked to resolve an unavailable
wave, so checking only its return value would be too late.

Transform and definition preimages are compared before any write. Native spawn
flags are excluded from the comparison because the game changes them after
construction. Edited definitions live in private mod-owned storage: placements
that share the original definition retain their original data. The native
resolver passes negative mod-owned RAM pointers through unchanged, as confirmed
from the game source and Ghidra. Previous edits are restored at the next actor
staging pass before applying the current room's edits, preventing shared
resource reuse from leaking a room override into another room.

Other mods can alter the same placements; unexpected preimages cause the
generated patch to skip a record. The exporter does not promise compatibility
with actor randomizers or other mods that rewrite room sources.

Geometry uses two separately verified entry hooks:
`func_801F8C4C_5B4B5C(void)` before collision binding and
`func_801F95D8_5B54E8(void *task, void *object)` before render-object binding,
including temporary room previews. They apply all consistent project geometry
operations whose complete required resource sets are loaded. Geometry remains
edited until native resource unload; restoring it when the current room changes
could invalidate a concurrently retained preview object.

Each operation preflights every write span and its read-only dependencies before
writing anything. A write span must be entirely original or entirely desired;
mixed byte patterns are rejected. Original plane normals, tree branches, cell
topology and consumed display commands must also match. Those dependency guards
prevent a translated distance from being applied to another mod's changed
normal, or edited coordinates from being applied after display-list pointers
change. Guards are never written and cannot overlap a write span. Exact shared
write records may repeat; conflicting or partial overlapping records reject
export. The runtime rejects missing/null registry entries, retains tagged valid
handles for native resolution, and resolves pointers again on each staging call.

These checks assume the canonical native File11 model/collision roots and
resource tables. They do not detect mods that rebind those roots or change
resource allocations. Such mods are incompatible; byte checks within the
original sources cannot establish that altered native tables still reference
those sources.

Geometry export is limited to 65,536 write spans with 2 MiB of original/replacement
payload, plus 262,144 dependency guards with 4 MiB of original guard payload.
Exports exceeding these limits report an error so the project can be split.
The verified native format and hook evidence is in
[room-geometry-editing.md](./room-geometry-editing.md).

## Verification

Run the synthetic export checks with:

```sh
node --import tsx --test tests/export*.test.ts
```

To include a real local MIPS compile, link, package, and ZIP manifest check:

```sh
MNSG_EXPORT_TEST_TEMPLATE=/path/to/initialized/template \
  node --import tsx --test tests/export*.test.ts
```

The integration tests compile synthetic actor and combined geometry edits, read the resulting
`mod.json`, and verifies the `mnsg` game ID and generated mod ID. This confirms
the build/package pipeline; it does not establish gameplay correctness. Test
the actual room, reload it, visit a room sharing its source resources, and check
unedited actors before distributing an export. macOS local packaging has been
checked; native Windows execution and in-game actor/collision behavior still need
testing. An additional host harness compiles and executes the generated geometry
C against controlled resources. It checks missing/null resources, opaque
handles, each dependency-guard mismatch, bad/mixed write preimages, atomic writes,
idempotence, remapping after reload and adjacent-byte preservation. On arm64
macOS it uses an x86_64 executable under Rosetta so synthetic resource addresses
can fit the native 32-bit ABI. The harness exercises the generated helper but
does not execute Goemon64Recomp's mapper or live game hooks.
