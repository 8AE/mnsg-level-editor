# Export authored rooms and native edits

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
unchanged. No complete ROM is bundled. Sparse patches contain native records
and dependency preimages. Authored bundles also contain user-edited vertex and
display-list data, native collision, room metadata and runtime code, with
relocations to the required ROM material and asset resources. Keep generated
bundles and decoded game data out of this repository.

## Authored rooms

C/H and optional `.nrm` export support authored replacements and new rooms. A
replacement retains its native room ID and service template. New rooms use IDs
620 through 799. Service donors must be world rooms 0 through 539 with a verified
File11 geometry-group mapping. The runtime supplies owned metadata, a nonnull
load callback and a default entrance before native code dereferences them; an
unused metadata slot alone is insufficient to admit a new room.

The compiler emits the edited meshes, integer vertex positions, UVs, RGBA,
triangle display lists, material relocations, actor definitions and loading
rosters. `authoring-inventory.json` records the authored graph, sky and
environment policies, allocation extents and warnings for review.

### Collision

A native clone or editable replacement can retain original template physics.
The exporter copies its verified native collision planes, cells and BSP tree,
including the original attributes. Changing the visual mesh does not alter that
copied physics. **Generate collision from geometry** replaces it with compiled
native collision from the authored triangles. Linked collision follows later
mesh edits when enabled. A blank room starts with an empty collision set.
Classifier and surface values remain raw native fields; the editor does not
assign unverified material or hazard names to them.

### Actor resources and native capacity

Each actor needs a verified constructor and resource closure in the selected
context, including required executable overlays. An initial model preview alone
does not establish that closure. Unresolved child-resource, room-state or
progression paths reject the entire export with a diagnostic. A model-free
controller may be valid when its constructor is verified. For example, a full
room-0 clone into room 620 currently rejects actor 193's unresolved resource-child
and progression path; geometry-only export of that source is a separate check.

Resident actors use an owned static roster; **Near player** actors use a compiled
native proximity grid with native spawn flags, cleanup and rearming. Sparse
edits retain original grid membership, as described below. Players, effects,
cameras and other services share the native task/object pools. The initial
kind-2 pool has 192 objects. Export rejects resident actors, doors and the room
renderer exceeding that bound, but a smaller roster can still exhaust the pool
under runtime load. A project's 4096 placement limit is not a simultaneous
actor capacity guarantee.

Resource appends preserve the live world-bank prefix `[0x80304000,0x80321500)`.
The generated runtime checks the actual retained registry, its **48 shared ID
slots**, the live cursor, allocation-table extent equality, 4 KiB code alignment
and the next 64-byte-aligned end before appending. It enforces exclusive end
`0x80594000`, a conservative policy backed by the inspected native boot File10
bank. The native loader does not enforce that heap bound. This policy applies
to the verified ordinary-world layout; other mods that change allocations or
reserved regions are incompatible. Later native script loads also consume these
shared slots and memory; constructor closure does not prove later script parity.

A resource or owned-object allocation failure latches the generated failure
state, clears the room's spawn rosters and applies scheduler mask 7. Restart or
disable the mod to recover. The generated runtime keeps owned data alive through
native hierarchy teardown and resource-cache reuse; live revisit behavior still
requires testing.

The aggregate native allocation estimate permits **48 MiB of persistent data and
BSS**, including proximity pointer arrays and sparse payloads. It reserves
**16 MiB for code and alignment** within the 64 MiB mod linker region. The
inventory records that estimate. Exceeding the budget rejects export; split the
project across mods or reduce geometry, roster size and proximity-grid extent.

### Environment, sky and entrances

Authored startup uses explicit generated defaults: map heading 0, void threshold
-32768, white lighting and reset camera state. Effective resident actor `0x08E`
definitions then apply their edited environment values in authored roster order.
Deleting these controllers leaves the defaults. Proximity controllers apply
only when native spawning reaches them. Original donor definitions remain
provenance in the inventory; they do not override edits or deletions.

An omitted sky choice inherits the native service template's sky. **No skybox**
suppresses it, and a selected native asset uses its verified background and
palette resources. The owned sky renderer matches exact texture and palette
pointers before changing outer RT64 extended draw state. The editor approximates
the native scrolling bitmap; compare it in the game.

Named entrances store XYZ, base player Y heading in 1024 units per turn and a
packed camera-start byte, default 16. Values 0 through 39 are callback-index
safe for the inspected five-entry table; this does not establish that every
startup combination fits a room. The first entrance also supplies the authored
room's default arrival.

Custom doors test the full rotated volume, with the authored position at its
bottom and rotation order `Rz * Ry * Rx` in native 1024-unit phases. **Interact**
requires a newly pressed A inside that volume on the controller selected by the
live player task. **Touch** requires entering after leaving the volume at least
once, preventing an immediate return when an entrance lies inside it. A native
appearance or generated box is separate from that trigger behavior.

Door activation queues the ordinary native transition with destination XYZ,
base heading and camera-start parameter. The generated ordinary-entry policy
clears stale extended camera fields at system `+0x3AE2C/+0x3AE30`, then calls
`func_8000607C_6C7C` with queued script resource/address `0, 0`. Those final
arguments are script fields. The native hot transition retains the player task,
selected controller, character and form. Custom doors do not require a cold
system-step rebuild. Arbitrary event-script editing remains outside export.

## Sparse native changes

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

Run the export checks with:

```sh
node --import tsx --test tests/export*.test.ts
```

To include a real local MIPS compile, link, package, and ZIP manifest check:

```sh
MNSG_EXPORT_TEST_TEMPLATE=/path/to/initialized/template \
  node --import tsx --test tests/export*.test.ts
```

The integration tests compile actor, geometry and authored-room fixtures, read
the resulting `mod.json`, and verify the `mnsg` game ID and generated mod ID. This confirms
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

The frozen authored exporter passed 26 focused checks covering generated host C,
MIPS compilation, linking, packaging and offline original-collision data. An
independent compile also covered the authored House 465 and new-room 620 handoff.
A geometry-only corpus check compiled 369 world rooms; five were empty and nine
nonworld records were excluded. These results do not establish export of every
full native roster.

Current source typecheck, tests with the supported US ROM and LLVM/NRM template,
all 25 GPU authoring/texture checks and the production build passed. macOS ARM64
0.2.0 DMG/ZIP packaging and strict app-signature verification also passed. A
visible packaged smoke used an isolated ROM cache and checked four textured
rooms, native body and door-selector previews, WASD and unchanged cache data.

The final handoff generated C/H, compiled MIPS, linked and packaged `.nrm` for
a House 465 replacement with eight native actors and a new room 620 with a coin,
copied native BSP and reciprocal A-button checker doors. The real Electron authoring smoke passed 18 milestones. It checked native ROM
import, Pan/Tilt/WASD, geometry edits and picking, thumbnail drag/drop, collision,
reciprocal native-appearance doors, sky, reset/history, save/reopen and hostile
IPC rejection. Cloning the full House 465 roster into room 621 produced explicit
resource-closure diagnostics for camera actor 0x308 and progression controller
0x34E. The smoke removed each through the inspector, preserved the remaining
graph and exported production C/H, then compiled, linked and packaged `.nrm`.
The exporter leaves rejected actors in the project until the user removes them.
The smoke recorded no page/console errors or renderer/child crashes and left
the source ROM unchanged.

The installed 0.2.0 macOS ARM64 app passed strict signature verification and a
normal visible launch with its cached ROM, 383 rooms, textured House geometry
and Pan mode across room changes. The cache hash remained unchanged. Consult
the [desktop build workflow](https://github.com/8AE/mnsg-level-editor/actions/workflows/build.yml)
for each revision's macOS ARM64, macOS x64 and Windows x64 build results. No live
authored-room game run has been verified.

Build the app and check the desktop authoring workflow with your own ROM:

```sh
MNSG_TEST_ROM=/path/to/us-rom.z64 \
  MNSG_TEST_TEMPLATE=/path/to/initialized/template npm run test:authoring
```

That check requires C/H export by default; the template adds `.nrm` compilation.
`MNSG_SMOKE_UI_ONLY=1` selects a temporary editor checkpoint and leaves export
verification pending. Check actual entry, collision, camera startup, proximity
spawning, door traversal, teardown and revisits in Goemon64Recomp before sharing
an authored mod.
