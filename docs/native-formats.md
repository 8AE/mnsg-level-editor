# Verified US-ROM formats

Research date: 2026-10-04. These findings combine the shared native API reference,
local US-ROM table reads, the sibling decompilation and symbol tables, and fresh
Ghidra decompilation/disassembly. They establish static formats and hook ordering;
they do not establish that exported edits have been exercised in the game.
All multibyte ROM fields below are big-endian. Runtime addresses must retain their
overlay identity: `0x08000000` is reused by many different resource files.

## ROM identification and decompression

| Representation | Size | SHA-1 after byte-order normalization |
| --- | --- | --- |
| Original US ROM | 16,777,216 | `df8083a54296b8c151917c5333e1c85f014a2a66` |
| Native decompressed US ROM | 33,554,432 | `6ea0ed71032ce08fc2745f412d84936382197494` |

The decompressed SHA-256 is
`e40bee20508c2e29e651dca4e47504e40f908f0a2186e34a582784bf5a64be4c`.
Detect byte order by the first word, not the filename: `80371240` is big-endian,
`37804012` swaps each pair of bytes, and `40123780` reverses each four-byte word.
One sibling `baserom.z64` is actually byte-swapped. Verify the normalized hash
before following pointers. The runtime also checks header bytes `0x3B..0x3E`
for `NG5E` and the original 16 MiB size.

Native runtime source:
`Goemon64Recomp/src/game/rom_decompression.cpp:34-99` is the LZKN64 decoder,
`:102-131` reconstructs file offsets, and `:134-175` validates and finalizes the
ROM. The corresponding decomp tool is
`mnsg-recomp-example/mnsg/tools/rommy.py:510-550,1189-1210,1270-1324`.
Expected hashes also occur in `mnsg/config/usa/mnsg.sha1` and
`mnsg/config/usa/mnsg.uncompressed.sha1`.

The 16-byte `Nisitenma-Ichigo` marker begins at ROM `0x57FC8`. The first actual
table entry, resource **1**, is at `0x57FD8`. Resource-ID indexing uses the virtual
base `0x57FD4`, so `entry(id) = u32(0x57FD4 + 4*id)`. Resource 0 is a sentinel;
it is not a file. The high bit of an entry means compressed; the lower 31 bits
are its offset. The next nonzero entry supplies the end. Duplicate adjacent
offsets are valid empty files. There are 1,311 actual files and a final nonzero
boundary, followed by zero. The zero is not the last file's end.

Each compressed file starts with its total compressed-stream size as a u32,
including the four-byte header. Starting at byte 4, decode:

| Command | Meaning |
| --- | --- |
| `00..7F` | Overlapping back-reference: distance `((command & 3)<<8) | nextByte`; length `((command & 0x7C)>>2)+2` |
| `80..9F` | Copy `command & 31` literal bytes |
| `A0..DF` | Repeat next byte `(command & 31)+2` times |
| `E0..FE` | Emit `(command & 31)+2` zero bytes |
| `FF` | Emit `nextByte+2` zero bytes |

Bound input reads and output size; reject a back-reference distance of zero or
greater than the produced output. Reconstruct file offsets in native order with
16-byte output alignment. Preserve the leading ROM region, round the final size
up to a power of two, and write CRC words `9CC11F4B` and `ABAA8538` at `0x10/0x14`.
Native `func_80005220_5E20`, main program `0x80005220`, also implements this decoder.

Researchers read local test inputs without adding them to this repository:

- A user-supplied US `baserom.z64`, 16 MiB.
- Its decompressed `mnsg.us.decompressed.z64`, 32 MiB.
- A second US ROM dump, 16 MiB, requiring 16-bit byte-order normalization.

## Resource and resident pointers

File 11 occupies decompressed ROM `0x587370..0x5C8770`, resident base `0x801CB460`.
File 12 occupies `0x5C8770..0x5F6840`, resident base `0x8020D2A0`.
Within those loaded sections, translate `ROM = fileStart + runtime - residentBase`.

Main `func_80001E50_2A50` selects a resource's segment from the table at runtime
`0x80054910`, ROM `0x55510`. Its four-byte records contain a u16 exclusive upper
file-ID bound and a segment byte at `+3`; a zero bound ends the table. It advances
while `fileId >= upperBound`. Do not assume every resource is segment 8.

Main `func_80014840_15440(int pointer, unsigned fileId)` resolves positive
segmented addresses through `func_800141C4_14DC4(fileId)`, subtracting the resource
segment times `0x1000000` and adding `(handle & 0xBFFFFFFF)`. Zero and negative
addresses pass through unchanged. When the resource lookup returns `FFFFFFFF`,
the resolver deliberately faults. Check availability before calling it. A tagged
registry handle is not an actor pointer. The actor-data waves examined here use
segment `08`.

## Room and actor data

File 12 table `D_80231300_5EC7D0` is at runtime `0x80231300`, decompressed ROM
`0x5EC7D0`. It contains 800 u32 metadata pointers indexed by room ID. The US-ROM
inventory has 374 nonzero metadata records, 333 actor-data wave selections,
292 nonempty actor rosters and 3,888 unique actor placements. Seven placements
are resident File12 sources. Table capacity is not a count of playable rooms.

Metadata has at least 0x1C bytes:

| Offset | Type | Meaning |
| --- | --- | --- |
| `00` | u32 | Resident actor instance list, direct File12 pointer |
| `04` | u32 | Resident name-table pointer; exact name schema not recovered here |
| `08` | u32 | Normal actor instance list, segmented into actor-data file |
| `0C` | u32 | Proximity grid: cell array of segmented instance-list pointers |
| `10` | u32 | Proximity grid configuration pointer |
| `14` | u16 | Actor-data resource ID |
| `16` | u16 | Unrecovered field/padding |
| `18` | u32 | **Room resource-loader callback** |

The callback at `+18` is not an event list. Fresh File12 decompilation confirms
`func_8020D670_5C8B40` compares it to the active callback, and
`func_8020D6BC_5C8B8C` assigns and invokes it. Room wrappers such as
`func_8020DE40_5C9310` and `func_8020DE64_5C9334` pass u16 resource lists to main
`func_80013AC4_146C4`. This corrects an initially tempting interpretation of
that field as event setup.

Instance lists use 20-byte records and end when the definition pointer is zero:

| Offset | Type | Meaning |
| --- | --- | --- |
| `00/02/04` | s16 | X/Y/Z |
| `06/08/0A` | u16 bits | Pitch/yaw/roll; preserve raw bits |
| `0C` | u32 | Actor definition pointer |
| `10` | u8 | Native spawn bookkeeping; proximity actors set it after spawning |
| `11..13` | bytes | Unrecovered; preserve |

Definitions use at least 16 bytes: u16 actor ID at `+0`, actor-specific u16 at
`+2`, and three opaque u32 payloads at `+4/+8/+C`. Multiple placements can share
one definition. The common initializer copies the payloads to task
`+D0/+D4/+D8`; it does not establish their universal meaning.

File12 `func_80218A54_5D3F24` resolves the definition before reading it, copies
signed positions to object floats at `+8/+C/+10`, copies raw rotation halfwords
to `+14/+16/+18`, and copies payload words to the task. Its disassembly at
`0x80218AD8..0x80218B18` uses `lh` for positions; `0x80218B1C..0x80218B38` uses
`lhu` for rotations. Native angle operations usually mask to `0x3FF`: 1,024 units
per turn, while `0x8000` is a significant sentinel. Do not treat every halfword
as a 65,536-unit angle or discard sentinel bits.

File12 `func_8020D848_5C8D18` is the earliest reviewed staging entry before
resident and normal source consumption. It waits for a local player object,
fetches the current room record, resolves wave-backed lists, and spawns resident
then normal actors. An export hook at its entry can retry while resources are
unavailable, check preimages, and apply edits before those readers. The earlier
`func_8020D724_5C8BF4` only schedules this stage. Resource dependencies still come
from the original loader callback: arbitrary new actor types may need code,
models or animations that the room never loads.

## Proximity cells and safe movement

The grid configuration stores u16 widths at `+0/+2/+4`, f32 origins at
`+8/+C/+10`, and u16 counts at `+14/+16/+18`. Zero widths are invalid. The cell
index is `x*countY*countZ + y*countZ + z`. Each cell points to a terminated
20-byte instance list; deduplicate actors by source offset while retaining all
their cell memberships.

`func_8020D2A0_5C8770` computes each player cell as
`trunc((position-origin)/width + count/2)`. Fresh disassembly proves **every
arithmetic step is f32**: `sub.S` at `8020D2C8`, `div.S` at `8020D2E4/2E8`,
`add.S` at `8020D2F0`, and `trunc.w.S` at `8020D2FC`, with corresponding Y/Z
instructions. `func_8020D36C_5C883C` visits the current cell and its neighbors
within ±1 on each axis. Moving an instance without moving its source-list
membership can change where it spawns or disappears.

JavaScript must round intermediate operations:

```ts
Math.trunc(Math.fround(
  Math.fround(Math.fround(position - origin) / width)
  + Math.fround(count / 2)
));
```

For positive cell `k`, the mathematical interval is
`[origin+(k-count/2)*width, origin+(k+1-count/2)*width)`.
Cell zero has the wider open interval
`(origin+(-1-count/2)*width, origin+(1-count/2)*width)` because truncation is
toward zero. The f32 predicate is authoritative at boundaries. Use actual
source-list cell membership, not an inferred cell from the original coordinate.
Edits outside the original cell require native grid migration, not just a
position write.

## Actor-driven room events

No independent, universal room event-placement table has been established.
Many native events are actor behaviors. The editor can attach a read-only event
description to its actor source, position, definition payload and verified
callback. Moving that linked actor moves the marker through the same actor
export path. This does not make its script, collision volume or flags editable.

The global actor entry table is File12 `D_802287BC_5E3C8C`, ROM `0x5E3C8C`.
The following IDs were looked up there and their overlay callbacks freshly
decompiled:

| Actor / applicability | Native evidence and decoded event |
| --- | --- |
| `226`, payload1 high byte 0/1 | File50 `08000000_70C820` selects the one-way switch chain. `08000204_70CA24` tests task status `+68` bit `80`. `0800032C_70CB4C` sets temporary flag in mode0 or save flag in mode1. Flag ID is payload0 upper16. |
| `23C`, payload0 high byte 0/1 | File43 `0800000C_6F34EC` selects `0800010C_6F35EC`: nonzero local contact latch `+DA` starts door animation/control. `08002254_6F5734` waits for animation completion and writes destination from task u16 `+D8`, payload2 upper16. |
| `242`, payload0 high byte 0..11 and low byte !=1 | File43 `08001D6C_6F524C` selects `08002190_6F5670`, then the same local door travel completion. The excluded low-byte case selects a different continuation. |
| `23F`, payload0 high byte 0..4 | File43 `08004750_6F7C30` selects contact/travel `0800496C_6F7E4C` and `08002254`. Subtype5 is a different special transition. |
| `23D`, payload0 high byte 1/3/4 | File43 `08003038_6F6518` selects barrier callback `08003410_6F68F0`. Hit status bit `80` and attacker type gate breakage; subtype3 sets save `1C2`, subtype4 sets save `1C3`. Other subtypes are not covered by this event classification. |
| `34A` | File30 `08004ED4_6C4624` selects `08004F74_6C46C4`: temporary room flag0 triggers rising-platform continuation `08004FDC_6C472C`. Mechanism event, not a general trigger volume. |
| `34B` | File43 `080060A0_6F9580` reads save flag `A4`. `08006174_6F9654` waits for it and starts a 120-tick phase; `080062A0_6F9780` tests local contact and opens the exit. |
| `3D6` | File62 `08002514_723B34` selects `080025A8_723BC8`, which tests hit bit `80` plus a nonnull local hitter. The following `0800266C_723C8C` checks save `EE` and temporary flag2 before creating the Silver Doll container child. |

These are selected verified families, not complete event coverage. In particular,
ID `23A` is a progression barrier rather than an ordinary travel door. Local
contact/collision, damage, camera and destination callbacks must never be replayed
merely to render an event preview.

## Room scene geometry

Main room group bounds are u16s at `D_8005BA10_5C610`, ROM `0x5C610`:
`0,300,350,400,540,544,549,561,588,607,613,618,619,620`.
Main `func_8000B3E4_BFE4` determines group and local room index. File11
`func_801F8F0C_5B4E1C` remaps original group0 rooms90..127 to geometry group4,
index `room-90`, and rooms128..299 to group5, index `room-128`. Otherwise it
retains the group/local index. The reviewed ordinary room tables have six groups;
special scene groups require separate research.

| File11 table | ROM offset | Per-room records |
| --- | --- | --- |
| `D_802098DC` | `5C57EC` | Group pointers to 20-byte primary model records |
| `D_802098F4` | `5C5804` | Group pointers to 8-byte optional secondary model records |
| `D_8020990C` | `5C581C` | Group pointers to four u16 additional resource IDs |
| `D_80209924` | `5C5834` | Group pointers to u32 collision-plane pointers |
| `D_8020993C` | `5C584C` | Group pointers to u32 collision-BSP pointers |

The primary record contains a tagged model pointer at `+0`, a native material
setup pointer at `+4`, and three u32 resource IDs at `+8/+C/+10`. The secondary
record contains another model and material pointer using the same resources.
File11 `func_801F95D8_5B54E8` passes these to main `func_80035A5C_3665C`.
Main `func_80014218_14E18` binds matching resource segments `08..0D`.

A common room model tag is `0x4800xxxx`: model type4 with direct segmented
F3DEX display-list address `0x0800xxxx`. Main `func_80016C44_17844` extracts
the model type with `& 0x70000000`, masks the address with `& 0x8FFFFFFE`, and
calls `func_800196F0_1A2F0` for type4. That path binds segments and emits the
display list. Room 0's primary model is `48001D80`, resolving through file138.
Material setup pointers are not additional room geometry roots.

The game uses **F3DEX**, not F3DEX2. The sibling SDK supplies exact definitions in
`mnsg/libultra/include/PR/gbi.h:114-145,1053-1069,1728-1740,1892-1898,1974-1987`:

- `04` VTX: count `(w0>>10)&63`, cache start `((w0>>16)&255)/2`, pointer `w1`.
- Vertices are 16 bytes: s16 XYZ, u16 flag, s16 UV, then four color bytes or
  signed normal bytes plus alpha. Preserve the original vertex source offset.
- `BF` TRI1 uses `w1` low24; `B1` TRI2 uses both words' low24. Each index byte
  is divided by two.
- `06` DL calls/branches another list; push flag0 returns, flag1 branches.
  `B8` ends the list. Vertex-cache state must follow nested lists.

Bound traversal by file range, command count, recursion depth and cycles.
Materials, textures, lighting, transforms, graph-model variants and unsupported
commands need explicit coverage tracking; a partial preview is not evidence
of complete native rendering.

A later bounded scan checked canonical room materials separately: twelve
resident main display-list roots contain state, fog and color commands, with
no vertex loads, matrices or segment-base changes. Canonical material commands
add no XYZ sources beyond the primary/secondary model traversal. Reviewed native
bind/render paths consume original lists and emit into a frame buffer; they do
not fix room command or collision topology bytes in place. Exact inventory and
consumer evidence are recorded in [runtime-validation.md](runtime-validation.md).

The texture renderer now reconstructs native wave allocations and packed PIC
parts separately from editable ROM sources. A bounded independent census decoded
all 537 room texture parts (510 RGB15 and27 indexed4 with RGBA16 palettes), with
every output fitting its allocation. Native UV scale is applied at vertex-load
time, and texture/tile/TMEM/material state is evaluated in command order. See
[native-textures.md](native-textures.md) for exact packed tables, PIC layouts,
TMEM addressing, combiner/alpha census and the declared lighting, fog, filtering
and animation limits of the static preview.

Collision is separate from visible geometry. File11 `func_801F8C4C_5B4B5C`
resolves the plane/BSP tables through the primary geometry resource. Main
`func_8002AAD8_2B6D8` reads 20-byte plane records (f32 normal XYZ and distance
at `+0/+4/+8/+C`, classifier byte at `+10`) and a compact branch/bounding-box
structure. A plane alone does not define a polygon. Further analysis recovered
the six-byte branch indices and 18-byte chained cell headers, supporting bounded
translation of static room visuals and collision together. Add the integer
translation to referenced visual XYZ and cell bounds; write each plane distance
as `f32(d - dot(normal, translation))`. Preserve normals, classifications, tree
indices and header links. Individual visual deformation cannot infer the
corresponding collision surface.

Current translation parsing supports 378 room IDs. It includes complete primary
and secondary traversal, bounds/signed-width checks, plane/tree validation and
physical-source deduplication. Every shared-source group receives one common
translation; the editor lists all affected rooms. Native pre-bind entry hooks
are File11 `func_801F8C4C_5B4B5C(void)` for collision and
`func_801F95D8_5B54E8(task*,object*)` for model binding. Generated patches guard
immutable display commands, plane normals, branch records and cell topology as
well as original/already-applied editable spans before committing writes.

This assumes canonical File11 geometry roots/resource tables and canonical wave
allocation sizes. Native availability/mapping does not expose the actual length
of arbitrary replacement payloads. Mods that rebind roots or shorten/resize
resources are incompatible, and dependency guards do not detect every other-mod
change. Full format, alias and lifecycle evidence is in
[room-geometry-editing.md](room-geometry-editing.md). Fresh runtime gameplay
collision/reload verification remains pending; user handoff guidance is in
[runtime-validation.md](runtime-validation.md).

## Evidence and remaining work

The shared API reference was checked first, especially
`docs/variables/D_80231300_5EC7D0.md`, `D_8015CDE0.md`,
`D_802287BC_5E3C8C.md`, and `docs/functions/func_8020D848_5C8D18.md` in the
sibling documentation repository. This pass adds the room callback correction,
F32 proximity arithmetic, concrete geometry table mapping, and selected
actor-event classifiers. Those additions have not been published to that site.

Actual research tools used: `rg`, `sed`, `nl`, Python `pathlib/hashlib/struct`
for local hashes and bounded table reads; the skill's `scripts/lookup.py` for
`room`, `D_80231300_5EC7D0` and `trigger`; Ghidra `list_open_programs`,
`decompile_function`, `get_xrefs_to`, and `disassemble_function`.
The following decompile groups carry the implementation evidence:

- Main: `80001E50,80005220,80013AC4,800141C4,80014840,8000B3E4,80035A5C,
  80014218,80016C44,800196F0,80018718,8002AA00,8002AAD8`.
- File12: `8020D2A0,8020D36C,8020D670,8020D6BC,8020D724,8020D848,
  8020DD78,8020DE40,8020DE64,8020DE88,8020DEAC,80218A54,80218F30`.
- File11: `801F8C4C,801F8F0C,801F95D8,801F9EE4`.
- File30: `08004ED4,08004F74`; File43:
  `0800000C,0800010C,08000AA8,08001D6C,08002190,08002254,08003038,
  08003410,080041C0,08004524,08004750,0800496C,080060A0,08006174,080062A0`;
  File50: `08000000,08000204,0800032C`; File62:
  `08002514,080025A8,0800266C`.

Disassembly additionally checked `80218A54` for widths/signedness and
`8020D2A0` for numeric precision. Xrefs to `80231300` identify metadata readers
`8020D670/8020D6BC/8020D848`; xrefs to `8020D848` identify scheduling in
`8020D724`. Exploratory decompilation of loader, renderer, dialogue and stage
functions was used to reject unsupported table interpretations; it does not
establish additional schemas.

Next native work: event/script coverage beyond the reviewed actor families;
special scene geometry and F3DEX state completeness; collision surface visualization;
resource dependency changes for actor substitutions; proximity grid migration;
arbitrary deformation and independent geometry cloning; and game tests covering room reloads,
shared resources, unedited actors and combinations with other mods.
