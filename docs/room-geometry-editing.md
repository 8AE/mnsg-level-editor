# Room geometry and collision editing evidence

Research date: 2026-10-04. This is fresh static native analysis and bounded local
ROM validation. No native callback was executed and no ROM asset was copied into
the repository. The proposed edit primitive still requires implementation and
in-game validation.

## Supported first primitive

A bounded **translation of static room geometry and collision** is supported by
the recovered formats. Add an integer vector to every referenced F3DEX vertex;
translate the static collision planes and cell bounds by the same vector. Keep
display-list topology, collision tree indices, normals, classifications and
surface attributes unchanged. This is a geometry operation: actor placements,
player entrances, camera paths, room transitions and actor-owned dynamic
collision remain separate data.

Arbitrary vertex deformation cannot safely infer collision from the visible
mesh. Native static collision is a plane decision tree, not a triangle list
sharing those visual vertices. Deformation needs explicit collision editing or
reconstruction. Translation preserves its plane/tree topology mathematically.

## Correct table bounds

File11 is resident at `0x801CB460`, decompressed ROM `0x587370`. Translate its
resident pointers with `ROM = address - 0x801CB460 + 0x587370`.
The six primary model group pointers are at ROM `0x5C57EC` (`D_802098DC`).
The immediately following resource arrays identify exact primary array lengths:

| Group | Primary start | Following resource table | 20-byte record count |
| --- | --- | --- | --- |
| 0 | `802053D0` | `80205AD8` | 90 |
| 1 | `8020612C` | `80206500` | 49 |
| 2 | `80206874` | `80206B94` | 40 |
| 3 | `80206E64` | `802074F4` | 84 |
| 4 | `80207A34` | `80207D2C` | 38 |
| 5 | `80207FD8` | `80208550` | 70 |

The collision pointer arrays have matching counts. Native stage group boundaries
`0,300,350,400,540,544,549,...` include unused ID ranges. They are not array
lengths. Reading primary records up to those boundaries crosses into adjacent
tables and produces false model tags or invalid resource IDs.

Native main `func_8000B3E4_BFE4(void)` computes stage group and index; File11
`func_801F8F0C_5B4E1C(void)` remaps group0 rooms90..127 to group4 and rooms128+
to group5. Apply the array limits above after remapping. The resulting 380
geometry IDs consist of 371 unique table slots plus nine special IDs540..548
that alias group4/5 slots. A local scan found all 380 primary model tags are
type4 (`0x40000000`). All 371 unique nonzero secondary models also use type4.
The previously reported unsupported ordinary-room model graphs were primarily
unused table ranges, not evidence of 171 graph-model rooms.

## Visual sources

Primary records hold tagged model pointer `+0`, material pointer `+4`, and u32
resource IDs `+8/+C/+10`. Secondary records at group table `D_802098F4`, ROM
`0x5C5804`, hold model/material pointers and share the primary resource IDs.

File11 `func_801F95D8_5B54E8(void *task, void *object)` binds both models through
main `func_80035A5C_3665C`, passing zero translation/rotation and unit scale.
Main `func_80016C44_17844` selects model type4 and sends its masked segmented
display-list pointer to `func_800196F0_1A2F0`. The latter binds resource segments
8 through D and emits the list. F3DEX VTX records are 16 bytes, with signed
halfword XYZ at `+0/+2/+4`, as defined in
`mnsg/libultra/include/PR/gbi.h:1053-1069,1728-1740`.

An editable vertex needs provenance `(resourceId, resourceRelativeOffset)` and
its six original XYZ bytes. Deduplicate physical vertices referenced by several
lists before writing; preserve the other ten bytes. Include both primary and
secondary lists. Reject s16 overflow. A translation must require complete
supported traversal, not merely a rendered partial mesh: list matrices, modified
vertices, culling or unimplemented commands may change which sources contribute
and whether local-coordinate translation equals world translation.

Graph-model support is not required for these populated ordinary room tables.
For future models, native `func_80018718_19318` and `func_80018908_19508` traverse
24-byte nodes: a tagged display-list/reference pointer at `+0`, signed child and
sibling offsets at `+4/+5` multiplied by24, scale selectors at `+6/+8/+A`, angle
selectors at `+C/+E/+10` and translation selectors at `+12/+14/+16`.
`func_800192D0_19ED0` builds/pushes transforms through `func_80019ED8_1AAD8`.
Those selectors are not always literal s16 values: `func_8001A8E4_1B4E4`,
`func_8001AABC_1B6BC` and `func_8001ADBC_1B9BC` can obtain animated values.
The graph header includes animation data and node pointers. Rendering a graph
requires native selector decoding and matrix inheritance, not just finding its
display lists. This layout is decoded evidence, not a complete graph parser.

## Static collision layout

File11 plane groups are at `D_80209924`, ROM `0x5C5834`; BSP groups are at
`D_8020993C`, ROM `0x5C584C`. Each group is an array of u32 segmented pointers
indexed by the verified local room index. Both resolve through the primary
record's resource at `+8`, using segment8. File11
`func_801F8C4C_5B4B5C(void)` establishes main globals
`D_80168F60_169B60` (plane base) and `D_80168F64_169B64` (tree base).

The plane record is 20 bytes:

| Offset | Field |
| --- | --- |
| `0/4/8` | f32 normal X/Y/Z |
| `C` | f32 additive plane distance `d` |
| `10` | Native classifier byte; preserve |
| `11..13` | Remaining bytes; preserve |

The tree uses six-byte slot indices. A cell header occupies three slots,
18 bytes, at `treeBase + cellIndex*6`:

| Offset | Field |
| --- | --- |
| `0` | u16 next cell index; `FFFF` ends the cell chain |
| `2` | u16 surface attribute copied into query results |
| `4` | Unrecovered halfword; preserve |
| `6/8/A` | s16 maximum X/Y/Z |
| `C/E/10` | s16 minimum X/Y/Z |

The decision-tree root is slot `cellIndex+3`. Each branch is six bytes:
u16 plane index at `+0`, u16 negative-side child index at `+2`, u16 positive-side
child index at `+4`. Child0 is a terminal, not a branch at slot0. All indices
are relative to the common tree base, not the current cell. Different cells may
refer to shared branches or planes.

Main `func_8002AAD8_2B6D8`, `func_8002B3B0_2BFB0`,
`func_8002BDEC_2C9EC`, `func_80028BC0_297C0`, `func_80029560_2A160`
and `func_8002A168_2AD68` all use the same bounds and plane/tree records.
They evaluate `normalX*x + normalY*y + normalZ*z + d`. Equality-side handling
differs between some queries; translation preserves the underlying equation
rather than altering their branching rules.

Fresh main `func_8002AAD8_2B6D8` disassembly confirms:

- `8002ABDC`: unsigned next-header index; `8002ABEC/AC0C` signed max/min X.
- `8002AC2C/AC4C`: signed max/min Z; `8002AC80/ACB0` signed max/min Y.
- `8002AEE4`: header attribute; `8002AEEC`: root index plus3.
- `8002AF24`: unsigned plane index; `8002AF34..AF44`: f32 normal/distance.
- `8002AF48`: classifier byte; `8002AF40/AF54/AF5C/AF60/AF64`: single-
  precision plane products and additions.

## Bounded extraction and translation

Start the header chain at slot0. For each header, validate its 18-byte range,
non-inverted bounds and an acyclic next-header chain. Traverse both nonzero
children from `header+3`, bounding all six-byte branches and 20-byte plane
records to the same resource. Detect cycles and overlap with header slots.
Collect unique plane indices and unique headers. Do not scan an arbitrary
number of records following the last referenced plane.

This extraction passed all 372 populated ordinary collision graphs in the
local decompressed US ROM; eight geometry IDs have no static collision.
Summed per room, it visited 6,638 headers, 372,837 branches and 98,702 unique
planes with no range, finite-value, bounds-inversion or header-overlap failures.
These totals include aliased special room IDs, not unique ROM allocations.
Room0 uses resource138, plane ROM `0x82C190`, tree ROM `0x82C974`, with
12 headers, 506 branches and 101 unique referenced planes.

For integer translation `t`, compute:

```text
visualXYZ' = visualXYZ + t
cellMinimum' = cellMinimum + t
cellMaximum' = cellMaximum + t
planeNormal' = planeNormal
planeDistance' = f32(planeDistance - dot(planeNormal, t))
```

Generate absolute replacement values from the original data, never accumulate
the translation on repeated native initialization. Reject every visual/bounds
s16 overflow and nonfinite plane result. Emit precomputed f32 bits so preview
and exported data use exactly the same replacement. Floating-point rounding
can shift near-plane results slightly; exercise collision boundaries in-game.
The tree topology, classifier bytes and header attributes remain unchanged.

## Verified native staging hooks

The earliest reviewed common collision staging entry is
`RECOMP_HOOK("func_801F8C4C_5B4B5C")`, signature `void(void)`. The function
clears collision globals then resolves the current room's plane/tree resources;
it does not itself run collision queries.

Its File11 callers are freshly verified by xrefs and decompilation:

- `func_801F728C_5B319C`: synchronous room resources load via
  `func_801F87F8_5B4708(0)`, then collision binding, then room renderer and player
  tasks are scheduled.
- `func_801F7F78_5B3E88`: transition path binds collision before scheduling the
  room renderer and actor manager; prior transition resource loading must still
  be guarded by actual resource availability.
- `func_801FAB00_5B6A10` and `func_801FAEC0_5B6DD0`: temporarily set the room,
  load its resources, bind collision, then initialize the room render object.

`RECOMP_HOOK("func_801F95D8_5B54E8")`, signature
`void(void *task, void *object)`, provides an additional pre-render staging
entry. `func_801FADC4_5B6CD4` loads a temporary room and calls this initializer
without calling collision binding. It matters for visual-only/preview paths.
Use the native geometry group/index at system `+3ADF6/+3ADF8` for table identity;
temporary room initialization can change room fields only for the call duration.

`func_801F87F8_5B4708(0)` calls synchronous main
`func_80013AC4_146C4(short *terminatedFileList)`, which calls
`func_80013B14_14714(short fileId)`. The latter loads the resource and its parts
through `func_800142BC_14EBC` before returning. This ordering establishes that
the staging hooks can edit loaded data before their subsequent consumers, but
does not justify dereferencing a missing resource. Guard every file with
`func_800141C4_14DC4` before resolving the segmented address.

## Export design and sharing

Generate fixed allowlisted write spans for visual coordinates, plane distances
and bounds, each carrying resource ID, relative offset, original and replacement
bytes. Use the loaded resource resolver, preimage checks and idempotence. Verify
all required resources/preimages before applying a room operation so a missing
wave or competing mod cannot leave visual and collision halves inconsistent.
Both C/H and `.nrm` pipelines can use the same generated payload and hooks.

Resources and individual sources can be shared by several room IDs. Record
aliases and reject contradictory bytes across project edits. Show which other
rooms share modified sources. Native temporary preview rooms can coexist with
ordinary room render objects, so restoring all previous geometry writes each
time a different room stages can invalidate the earlier object's resources.
One bounded approach applies all consistent project writes belonging to a
loaded resource and treats them as resource edits until normal unload/reload;
preimage checks make repeated staging idempotent. Per-room isolation would need
verified runtime resource cloning and segment/collision rebinding.

No existing runtime pointer should survive unload without rechecking the
registry. Never patch command opcodes, arbitrary ROM offsets, plane/tree counts,
child indices or caller-owned collision callbacks from project input.

## Verification and remaining limits

Required implementation tests: translation invariance for plane equations and
cell bounds; unique-source deduplication; both visual roots; missing resources;
preimage rejection before writes; reload/idempotence; alias conflicts and s16
overflow. A successful native build is separate from game validation: test a
translated floor and walls, room reloads, room transitions, preview rooms,
shared resources, unmodified actors and other mods.

Open work is arbitrary deformation/collision reconstruction, script/camera/
entrance relocation, textures and complete F3DEX state coverage, special scene
overlays outside these six groups, and independent game verification. The
evidence supports a bounded translation primitive; it does not support claiming
every kind of room-data modification is safe.

Actual tools used in this pass: `rg`, Python `pathlib/struct/collections/math`
for bounded local inventory, Ghidra `decompile_function`, `get_xrefs_to`,
`disassemble_function`, and the already-discovered program inventory. Programs
were explicitly selected as `mnsg_main_static.elf` and
`mnsg_player_file_11.elf`; full native names above retain ROM/overlay identity.
