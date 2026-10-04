# Native room authoring evidence

Research date: 2026-10-04. This document describes the US executable consumers
needed to author rooms, collision, actors, backgrounds, and doors. Findings are
from the shared native API reference, fresh Ghidra analysis of explicit overlay
programs, native source, and bounded original-instruction collision probes.
These are static/offline results. They do not establish that a generated mod has
been loaded in the game or that player movement and transitions pass gameplay
testing. No game, generated NRM, or damage callback was run for this research.

Canonical normalized US ROM SHA256:
`e40bee20508c2e29e651dca4e47504e40f908f0a2186e34a582784bf5a64be4c`.

## New room identifiers require an admission layer

`D_80231300_5EC7D0` is an 800-entry array of room actor-metadata pointers in
File12. The following symbol, `D_80231F80_5ED450`, establishes its byte extent
as `0xC80`. The canonical ROM has 374 non-null entries. Every entry for decimal
room IDs **620–799** is null. This is a useful checked allocation range for a
mod registry; it is not evidence that the vanilla room engine supports those
IDs without patches.

Main `func_8000B3E4_BFE4(void)` starts with stage byte `system+0x3ADE4=0` and
local index halfword `system+0x3ADF4=0`, then scans the 14 halfword boundaries at
`D_8005BA10_5C610`:

```
0, 300, 350, 400, 540, 544, 549, 561, 588, 607, 613, 618, 619, 620
```

A room at or above 620 falls through with both fields zero. File11
`func_801F8F0C_5B4E1C(void)` then sees stage zero and a room over 127, selects
geometry group 5, and computes the local index as `0-128`, stored as `u16`.
That becomes 65408 and causes out-of-range table reads. There is no native
assertion that turns an unused room into a safe empty room.

The ordinary File11 geometry arrays contain exactly 90, 49, 40, 84, 38, and 70
records. These counts differ from the stage boundary ranges. See
[room-geometry-editing.md](room-geometry-editing.md) for the six arrays and their
verified counts. A custom admission layer must establish bounded native
stage/group/index fields before any table consumer, while preserving the mod's
actual room identity. A checked donor context can supply native ancillary
services, while authored graphics, collision, rosters, background, starts, and
entrances use the custom registry. Replacing an occupied vanilla room does not
implement a new room.

Admission must also cover these independent consumers:

| Consumer | Verified read or action |
| --- | --- |
| `func_8000B364_BF64` | Assigns the prepared destination to the current room, calls `B3E4`, and unconditionally calls `800214E4`. |
| `func_800214E4_220E4` | Reads five `s16` values at `D_8006B780_6C380 + room*10`, without a custom-ID guard. This occurs even when explicit arrival coordinates were queued. |
| `func_801F8EDC_5B4DEC` | Calls the main stage mapper, File11 group mapper, and minimap/status setup. |
| `func_801FA03C_5B5F4C` | Temporarily substitutes the prepared destination room for a music preview, runs both mappers and the music reader, then restores the fields. Custom mapping must cover this temporary identity too. |
| `func_801F9EE4_5B5DF4` | Reads a room-indexed music halfword from group arrays rooted at ROM `0x5C5864`, with native story/room overrides. |
| `func_801FA7B0_5B66C0` | Uses native stage/group/floor/minimap metadata. It needs a valid ancillary context or an authored replacement. |
| `func_8020D670_5C8B40` | Dereferences `metadata[room]+0x18` without a null-metadata guard. |

Do not leave the real room ID temporarily changed across unrelated native
callbacks. Scoped donor substitution or direct custom handling must restore
state and cover nested callers. Imported canonical tables and allocation sizes
are prerequisites of these findings; another mod rebinding them requires a
separate compatibility policy.

## Resource and room setup order

File11 is resident at VRAM `0x801CB460`, decompressed ROM `0x587370`. File12
common is resident at `0x8020D2A0`, decompressed ROM `0x5C8770`. Ordinary group
arrays in File11 are rooted here:

| ROM offset | Native symbol | Record |
| --- | --- | --- |
| `0x5C57EC` | `D_802098DC` | Six pointers to 20-byte primary graphics records. |
| `0x5C5804` | `D_802098F4` | Six pointers to 8-byte secondary model/material records. |
| `0x5C581C` | `D_8020990C` | Six pointers to four-`s16` room resource records. |
| `0x5C5834` | `D_80209924` | Six pointers to collision-plane pointer arrays. |
| `0x5C584C` | `D_8020993C` | Six pointers to collision-tree pointer arrays. |
| `0x5C587C` | `D_8020996C` | Six pointers to `u16` scrolling-background selectors. |

`func_801F87F8_5B4708(char asynchronous)` builds a terminated native resource
list. It prefixes file `0x7F` and includes nonzero room resource halfwords in
the order **+2, +4, +0, +6**. It compares the previous stack, trims it through
`func_800139A4_145A4`, updates `system+0x3B022` and the stack boundary at
`+0x3B020`, and calls `80013C70` for asynchronous loading or `80013AC4` for
synchronous loading. Resource readiness and allocation failure must retain
their native meaning.

Room actor metadata is 28 bytes: resident roster pointer +0, names +4, normal
roster +8, partition pointer +0xC, partition configuration +0x10, `s16` source
wave ID +0x14, reserved halfword +0x16, and load callback +0x18. Fresh
`func_8020D6BC_5C8B8C(void)` stores the callback at `system+0x3B03C` and invokes
it as **`void(void)`**. It does not pass the room ID or metadata pointer.
The call is unconditional: a null callback is unsafe. A room without extra
dependencies still needs a valid no-op callback.
`D670` returns one only when that pointer differs from the previous pointer
at `system+0x3B03C`. Transition setup calls `D6BC` only for that difference
or a nonzero `system+0xCF88D`. One shared generated callback for every room
therefore needs explicit dependency-state handling; it does not automatically
run again when a room ID changes.

Cold setup `func_801F728C_5B319C(task)` runs room resources, the actor load
callback, optional background scheduling, collision binding, then renderer,
player, and actor-manager scheduling. Transition setup
`func_801F7F78_5B3E88(void)` checks/reloads actor resources, schedules the
background, binds collision, and schedules the actor manager and renderer.
Install custom metadata before either path can reach `D670` or `D6BC`, and
finish required actor code/model/resource loading before constructors run.

Room teardown `func_801F7C14_5B3B24` reinitializes the room arena at
`0x802F7000` with size `0xA000`, removes room renderer/background/actor-manager
tasks, and preserves the native player/transition ownership. Mod-owned arrays
must outlive all native pointers to them. Custom tasks should be parented into
the room-owned task subtree so teardown removes them.

Fresh `80034EF8_35AF8` calls `80034F44_35B44` before removing its parent.
The latter releases contiguous tasks whose hierarchy depth (`u16 +0x20`) is
strictly greater than the parent's. `80034B58_35758` inserts children at depth
parent plus one. Consequently, sky and door children of the room renderer are
removed by `801F7C14` before `801F7E1C` reaches the next `801F7F78` resource
callback, including an ordinary same-room hot transition. Reinitializing a
generated callback's started flags outside this teardown sequence does not
establish the same guarantee.

## Authored graphics and native object allocation

`func_801F95D8_5B54E8(task, object)` reads the primary record and calls
`func_80035A5C_3665C` with model +0, material +4 OR `0x40000000`, zero position
and angles, scales 1, and resource IDs from +8/+0xC/+0x10. It sets object byte
+5 to 1 and byte +0x65 to zero. A nonzero secondary model causes
`80035EEC(task,2,1)`; allocation failure removes the task. The secondary binds
with its material untagged and the same three resource IDs. The last bound
object receives `u16 +6=1`.

The native `80035A5C` object setter has 15 arguments:

```
task, model, material, f32 x, y, z, s16 rx, ry, rz,
f32 scaleX, scaleY, scaleZ, s16 primaryResource, materialResource, secondaryResource
```

It writes model +0x2C, material +0x30, XYZ +8/+0xC/+0x10, angles
+0x14/+0x16/+0x18, scales +0x1C/+0x20/+0x24, resource IDs
+0x34/+0x44/+0x3C, and invokes `80014218` to bind resources. Appending authored
mesh objects through `80035EEC` and this setter needs an allocation budget and
failure handling. The verified initial native kind-2 capacity is **192**, shared
with player, actors, and effects. A project limit of thousands of actors or
meshes is not evidence of equivalent runtime capacity.

CPU and graphics addresses have different rules. `80014840` preserves negative
CPU pointers, but an RSP display-list pointer such as `0x81000000` normally
means segment 1 plus a 24-bit offset. RT64's `fromSegmented` only treats a
high-bit pointer as extended RDRAM when its extended-RDRAM mode is enabled;
`maskPhysicalAddress` then subtracts `0x80000000`.

Upstream `patches/main.c` enables extended commands, but its
`gEXSetRDRAMExtended(...,1)` line is commented out. A compiled authored display
must therefore emit the mode command **before** the outer high-bit `G_DL`
pointer is followed, and restore the intended surrounding mode afterward.
Putting an enable command inside that unmapped root cannot fix the outer
pointer. The same addressing requirement applies to authored VTX and texture
image pointers. Evidence: `lib/rt64/src/hle/rt64_rsp.cpp:97–126`,
`patches/main.c:18–19`, and fresh native `800196F0` command emission.

## Actor insertion and lifetime

`func_8020D848_5C8D18(managerTask)` seeds globals `8015CC5C/60/64/68/6C/70`
from room metadata and enumerates resident and normal 20-byte instance records.
For resident records, the definition pointer is a direct CPU pointer; for normal
records it is resolved with the room source-wave ID. Both loops terminate when
the definition pointer at instance **+0xC is zero**. They do not terminate on
actor ID zero and do not use instance +0x10 as a static-spawn latch.

An instance contains six signed halfwords XYZ/rotation at +0..+0xA, a `u32`
definition pointer at +0xC, and four remaining bytes at +0x10. A definition is
16 bytes: `u16` actor ID +0, retained halfword +2, and payload words +4/+8/+0xC.
`func_80218A54_5D3F24(task, instance)` resolves the definition, copies the ID
to task +0x5C/+0x5E, copies transforms to the object, copies payload words to
task +0xD0/+0xD4/+0xD8, applies stats via `80217144`, and installs native cleanup
callbacks. It does not copy the definition's halfword +2 into those payloads.

Native spawning selects the owner category from the actor registry byte,
calls `80219CA0`, allocates with `8003555C`, and then calls `18A54`. The owner
allocator applies category quotas and global capacity checks; its null result
must not be ignored. A mod-owned resident roster can contain direct negative
definition pointers and avoids inventing a ROM wave for authored source lists.
Each fresh `D848` initialization enumerates the static list anew.

Partition spawning in `func_8020D36C_5C883C` is different: it checks instance
byte +0x10, allocates through `80035690`, marks that byte 1, sets task +0x68 to
8 and +0x70 to the instance address. Native cleanup eventually rearms that
source byte. Partition source records must be writable and remain alive for
cleanup. Preserving cell membership while moving a partition actor across its
native cell is unsafe; see the earlier partition evidence.

The same readers support owned negative CPU pointers for the grid,
configuration, cell lists and definitions with source-wave ID zero: `14840`
returns nonpositive pointers before looking up a wave. Configuration widths
are three u16 values at +0/+2/+4, float origins at +8/+0xC/+0x10, and u16
counts at +0x14/+0x16/+0x18. Grid indexing is
`(x*countY*countZ + y*countZ + z)*4`. `D36C` leaves the source latch zero
when either owner allocation or `35690` fails, allowing a later retry.

Rearming is proximity-based. `8021A328` compares source XYZ with the player
object: all three absolute differences smaller than
`(u8 task+0x76 / 10)*respectiveGridWidth` keep the task/source active. Outside
that box, it clears source byte +0x10, clears task +0x70, and sets task +0x68
to 2; `18F30` removes the task. On removal with a retained source, `18F30`
may allocate a model-free `80213ED0` task with the source pointer and byte
+0x76 increased by 5. This is an enlarged proximity hysteresis box, not a
timer duration. If that task allocation fails, the source latch is cleared
immediately. Owned source records must remain writable and alive through these
post callbacks and must be reset coherently for teardown/revisit.

The native initializer table starts at `D_802287BC_5E3C8C`. The next exported
symbol is `D_802297D6_5E4CA6`; this provides a bounded candidate scan of 1030
whole pointers, IDs `0x000..0x405`, before a two-byte remainder. A scan finds
361 nonzero candidates. Reviewed dispatchers do not check actor ID bounds, and
the symbols do not export an exact initializer-array size. This is an inspected
candidate catalog, not a promise that every candidate is playable anywhere.

Fixed overlay addresses repeat. Candidate `0x07D` at `0x801CC978` corresponds
to File15's `func_801CC978_65F828`, not ordinary File11 code merely because the
RAM ranges overlap. Candidate `0x08F` uses common File12 CPU code and task
resource context 28. Candidates `0x10D/0x10E` exceed the recorded File33 code
extent; `0x19B/0x19C/0x24B` contain segmented callbacks with zero declared code
resource. File33 occupies ROM `0x6D3A90` for `0x8B0` bytes, so offsets
`0x12E0/0x2284` exceed it. File25 occupies ROM `0x6AD3C0` for `0x1420` bytes;
the `0x07D` CPU entry instead belongs to fixed File15 at ROM
`0x65E310..0x667B90`. These contexts remain unresolved. Never guess an overlay from a
repeated PC or silently treat an unresolved constructor as nonvisual.

An original room load callback plus a known original definition variant is a
strong resource prerequisite. Initial model bindings alone do not prove the
closure of later child actors, animation states, sounds, paths, or dialog.
Inserting an arbitrary ID or zero-seeded unplaced definition must retain these
explicit diagnostics instead of being advertised as verified gameplay.

## Environment setup is part of an authored room

Native controller actor `0x08E`, `func_80215A74_5D0F44(task, object)`, sets
`8015C54E` from instance X and `8015C550` from instance Y, sets room light RGB
from instance angles through File11 `801FA3FC`, and fills native camera mode
and offsets at `800C7B00/04/08/0C` from payload words. It removes its own task.
`801F77F4` compares player Y to `8015C550` for void death. This invisible actor
is an authored environment controller, not dispensable decoration.

`D848` does not reset these values, and an empty custom roster can inherit the
previous room's camera, lighting, and void threshold. Authored admission needs
explicit bounded values, either via this verified controller or its equivalent
setup writes. Copying a donor's visual geometry does not copy its environment
or script behavior automatically.

The X-derived field `8015C54E` is a minimap orientation reference, not a floor
clamp. Fresh `func_80216228_5D16F8` compares it with 0, `0x100`, `0x200`, and
`0x300` to map player X/Z to the minimap marker, then subtracts player heading
and masks `0x3FF` to choose the marker's direction. Other values, including
-1, take the `0x300` coordinate branch. No disable-sentinel test was found.

For setup before player creation, equivalent writes avoid replaying a
constructor whose final `80034ED4` deletes the current task. The pure
`func_801F97D4_5B56E4(void)` clears camera mode/offset globals and ten camera
volume records of stride `0x28` at `800C7B10`.
`func_801FA3FC_5B630C(uint8_t r,uint8_t g,uint8_t b)` writes the three light
color bytes at `802099EF/F0/F1`. After the reset, apply a trusted donor's
`0x08E` fields: floor(instance X), with negative results replaced by -1, to
`s16 8015C54E`; converted instance Y to `s16 8015C550`; low eight bits of
instance rotations to light RGB; payload 0 upper `u16` to camera mode,
payload 0 lower `s16` to offset 0, and payload 1 upper/lower `s16` to offsets
1/2. A donor lacking this controller needs explicit validated defaults.
Camera mode/offsets zero are the verified reset values. White lighting,
void threshold -32768, and a chosen minimap orientation are mod policies,
not recovered universal native defaults.

## Scrolling sky background format

File11 `func_801F8494_5B43A4(task)` reads a per-room `u16` background selector,
subtracts one, and selects roots from four-entry arrays `D_802098BC` and
`D_802098CC` at ROM `0x5C57CC/0x5C57DC`. The inspected roots are texture
`0x0A000000` and palette `0x0A025800`; the fourth resource halfword in the room
resource record supplies this wave. Nonzero selector and that resource are both
needed by native scheduling.

It allocates a kind-5 background record and writes flags `0x2009`, width 640,
height 240, texture/palette pointers +0x38/+0x3C, scrolling coordinates
+0x14/+0x18, and clipping rectangle halfwords +0x2E..+0x34. Its callback
`801F8644` calls `801F8670(object,640,136)` to update scroll from the camera
position/look-at direction.

The allocator is specifically `func_80035DFC_369FC(task,5,1)`. Setup functions
`728C/7F78` first schedule a task with `80034DD8(801F8494,0)`, without a kind-2
object. `8494` attaches the kind-5 object at task +0x18, removes the task through
`80035044` if allocation fails, and switches its callback to `801F8644` through
`8003521C`. A generated installer can use checked explicit-parent task
allocation `80034B58(parent,callback,0)` followed by `80034D24(task)` and
the same kind-5 binding. The ordinary `800358E8` allocator creates kind-2
objects and is not a background allocator. A custom sky also needs scheduling
when the donor's fourth resource is zero; merely overriding `8494` cannot
create a task that the setup functions skipped.

Upstream `patches/background.c` verifies the image interpretation:

- Flag bit 13 means direct texture and palette pointers.
- Bit 3 selects 8-bit texels; bit 0 selects CI format.
- **640×240 CI8 = 153600 bytes**, exactly the gap to `0x0A025800`.
- The following palette has **256 RGBA16 entries**, 512 bytes.
- `80022A74` loads the 256-entry TLUT and draws clipped scrolling rectangles.

This is a native two-dimensional scrolling background, not a cube-map skybox.
Relevant source spans are `background.c:11–34,40–79,391–448,582–599`. The
recompiled background patch changes filtering to bilinear; editor background
presentation must describe its camera/scroll approximations accurately.

## Collision compilation from authored triangles

Static native collision is independent from the visible F3DEX mesh. Editing
visual triangles must not silently claim matching collision. The native plane
and tree layout is:

| Record | Fields |
| --- | --- |
| Plane, 20 bytes | Four big-endian `f32` values: normal XYZ and distance; classifier byte +0x10, retained bytes +0x11..+0x13. |
| Branch, 6 bytes | `u16` plane index, negative child, positive child. Child zero is terminal. |
| Cell header, 18 bytes/three slots | `u16` next-cell slot (+0; `0xFFFF` end), surface attribute (+2), unresolved halfword (+4), max XYZ `s16` (+6/+8/+0xA), min XYZ `s16` (+0xC/+0xE/+0x10). Root is header slot +3. |

Fresh original main instruction readers are
`func_8002AAD8_2B6D8` (vertical), `func_8002B3B0_2BFB0` (horizontal), and
`func_8002BDEC_2C9EC` (general ray). All use out pointer and f32 origin XYZ in
four argument registers; stack +0x10/+0x14/+0x18 contains f32 direction XYZ
and +0x1C contains the maximum travel parameter. The result has displacement
+0x18/+0x1C/+0x20, normal +0x24/+0x28/+0x2C, signed classifier +0x34, `u16`
surface +0x36, `u16` status +0x38, and f32 squared distance +0x3C. Status
`0x7FFF` is a hit. Vertical/horizontal specializations only consume their
respective direction components.

A bounded one-sided triangle compiler is now backed by native instructions:

1. Derive the oriented unit face normal from `(B-A)×(C-A)`, with distance
   `-normal·A`, stored as f32. Preserve winding.
2. Construct three normalized edge clipping planes perpendicular to the face.
   Choose their signs so the triangle interior is on the negative side.
   Give these planes classifier zero.
3. Chain those three branches through their negative children to the face
   branch; give every positive child zero. Give the face a nonzero classifier,
   normally 1, with both children zero.
4. Give the cell outward-rounded s16 triangle bounds, the explicit surface
   attribute, and unknown halfword zero. Link cells through next-cell indices.

This uses four planes and seven six-byte slots per independent triangle.
Native u16 indices and the `0xFFFF` next-cell sentinel bound the compiler;
practical room budgets should be substantially smaller because linked cells
are queried sequentially. Reject degenerate triangles, non-finite f32 plane
coefficients, inverted bounds, overflow, and invalid graph links.

Independent synthetic probes ran the original MIPS instructions over private
8 MiB arrays, without host-native callbacks or engine execution:

- 20/20 shape/query combinations passed for floor, slope, off-center slope,
  ceiling, X/Z walls, back-face misses, and points inside a cell AABB but outside
  its actual triangle. Hit normals and displacement matched the authored face.
- 100/100 combinations passed when repeating with nonzero classifiers
  1, 2, 127, 128, and 255. The output byte is signed; 128 returns -128 and 255
  returns -1. This proves query behavior only, not downstream material/hazard
  meanings.
- Two linked floor cells correctly returned the nearest face and its surface
  attribute, with the nearer cell both first and second in the chain.
- A face classifier of zero produced an edge normal in the initial floor
  probe. Zero must remain reserved for clipping planes in this representation.
- An off-center slope can report native epsilon displacement, approximately
  `-20.000999`, rather than mathematical `-20`.

These probes establish an authored triangle representation. They do not prove
that reconstructing every original BSP as triangles preserves its physics.
Original trees can have shared branches, multiple regions, and class-zero
crossing rules. A reverse conversion must clip each classified face by its path
halfspaces and cell bounds, handle region unions, and compare canonical tree
queries with reconstructed queries before enabling destructive replacement.
Preserving an imported plane/tree remains preferable when its reverse mapping
is incomplete. Surface numbers are opaque native attributes; this research
does not assign unverified names such as water, ice, or damage.

## Door destinations and named entrances

Native visual travel doors and transition controller `0x08C` are separate
actors. File43 `func_08002254_6F5734(task, object)` waits for animation bit 2 at
object +0x7C, clears state, and assigns the low byte of task halfword +0xD8 to
`system+0xCF898`. This is a door selector/latch, **not a destination room**.
The earlier interpretation of a visual door's payload-2 upper halfword as a
room ID is incorrect.

Common `func_80215230_5D0700` observes this selector and either matches a
four-bit transition selector or tests an oriented player volume. Ordinary
selectors match values 1–15; the selector-zero state is inactive. Values over
16 select the volume mode. `func_80215330_5D0800` then queues these fields:

| Authored controller field | Packed payload location | Native destination |
| --- | --- | --- |
| Room ID | Word 0 upper 16 | `u16 system+0x3AFE0` |
| X | Word 0 lower 16 | `s16 +0x3AFE4` |
| Y | Word 1 upper 16 | `s16 +0x3AFE6` |
| Z | Word 1 lower 16 | `s16 +0x3AFE8` |
| Base player Y heading | Word 2 upper 16 | `s16 +0x3AFEA` |
| Four-bit selector | Word 2 byte 1 low nibble | `u16 +0x3AE00` |
| Packed camera startup parameter | Word 2 low byte, sign extended | `s16 +0x3AFE2` |

The supplied external room dump swaps the word-1 Y/Z annotations. Fresh
disassembly `801CB600/620/634` in File11 `func_801CB5D0_5874E0` reads
`3AFE4/6/8` into the allocator's XYZ arguments; `800357BC→80035964` writes
object +8/+0xC/+0x10. Reverse writer `801F7B0C` copies those same object fields
back to the destination fields. Thus upper-word-1 is Y and lower-word-1 is Z
under the game's Y-up coordinate convention.

The default start table at `8006B780` is five s16 values: XYZ, base heading,
and the packed camera startup parameter. The base heading sets player object
Y angle +0x16 during `801CB5D0`; X/Z angles are zero. Fresh
`func_801CBD88_587C98` also writes it to player task +0x94 and writes
`heading<<6` to player work +0xA4. These are native 1024-phase heading and
65536-phase representations respectively: one revolution is 1024 heading
units, so degrees convert by `degrees*1024/360`. This heading also supplies
the camera's baseline. `CBD88` applies prepared XYZ with a native Y-minus-two
adjustment; that adjustment is not an axis swap.

File11 `801F9988` casts the fifth start value to **camera task**
`DAT_801FC624+0xBC`. Its ownership is established by camera allocator
`801D23D4`. `801D27A4` derives base camera angle +0x66 from the player's
heading +0x200 and its transformed direction, then sets camera angle +0x6A
to `entryByte*0x2000 + baseAngle`. It dispatches `callbacks[entryByte>>3]`
without a bounds check. Disassembly `801D2A2C/34/40/44` shows the byte load,
shift, callback-pointer load, and indirect call. Five callbacks start at
`801D2B58`, `801D2B8C`, `801D2BD8`, `801D2BF8`, and `801D2C40`.
The latter groups also consume `(entryByte&7)<<7`. Thus the fifth value is
a packed camera startup mode/direction, not a free player Euler yaw.
Values 0..39 fit the callback table; that alone does not establish that all
such combinations are suitable in every room.

A read-only canonical census found these complete distributions:

| Value | All 620 default-start rows | All 595 room-assigned `0x08C` placements |
| --- | ---: | ---: |
| 0 | 353 | 3 |
| 16 | 176 | 430 |
| 19 | 77 | 119 |
| 20 | 12 | 33 |
| 21 | 2 | 10 |

No other values appeared. An initial authoring policy can restrict startup
parameters to these observed values. A single `baseYaw` field represents
arrival heading; independent XYZ Euler rotation has no equivalent in this
native start contract.

No universal vanilla entrance-ID table was found. A mod may define its own
named entrance registry containing room ID, XYZ, base Y heading, and an
explicit validated camera startup parameter. Custom doors should resolve that
registry and own their activation callback; a vanilla visual-door/controller
pair is useful evidence but is not the required new custom actor behavior.

An explicit-parent custom task can use
`func_800358E8_364E8(parent, callback, model, material, x,y,z, rx,ry,rz,
sx,sy,sz, primaryResource, secondaryResource)`. Its allocation chain
`357BC→34CBC` allocates a child task and kind-2 object, `35964` binds the
object, and `34D24` schedules it. Handle null allocations and attach the task
to a room-owned parent. The wrapper `80035854` instead uses the implicit current
parent at `8016DAB4`, so it is less suitable for a generated registry installer.

The shared destination setter's verified ABI is:

```c
void func_8000607C_6C7C(uint16_t room, int16_t x, int16_t y, int16_t z,
                      int16_t baseHeading, int16_t packedCameraStart,
                      int16_t scriptResource, uint32_t scriptAddress);
```

It writes the prepared destination fields, sets byte `3AE29=1`, and stores
the final arguments at `3AE3A/3AE3C`. It leaves extended setup `3AE2C` and
option `3AE30` untouched. These fields need a verified lifecycle policy; do
not invent clearing rules or accept a stale override silently.

The final arguments are a script resource ID and segmented script address,
not player/controller fields. `80006298_6E98` loads the nonzero resource through
`13B14`, maps it using `01E50`/`141C4`, and starts the mapped script through
`80004964_5564`. A generated ordinary door supplies zero for both to avoid
starting a queued native script. The resource also has native sentinel `-1`
for other menu/demo behavior; that sentinel is not ordinary-door controller
selection.

The ordinary hot-transition sequence `801F7C14→801F7E1C→801F7F78` retains the
live player task while replacing room tasks, preserving its controller byte
+0x90 and character byte +0x60. Cold player allocation `801CB5D0_5874E0`
sets +0x90 to zero under native cold-start policy and copies selected character
from `8015C5DC` into +0x60. `801CC30C_58821C` initializes +0x91 to `0xB9`;
it is not the selected character. None of these bytes belong in the final
two transition arguments.

In live ordinary File11 gameplay, `func_801F77F4_5B3704` observes the pending
marker, calls `801FB270` and selects the normal transition sequence
`7AA4→7B0C→7C14→7F78`. `801FB270` sets scripted-input byte `3AE23=1` and
`801FB2A4` clears the seven native camera/input scratch fields at
`800C7DB2/DB4/DB6/DB8/DBC/DC0/DC4`. Calling the setter in that context queues
the existing transition; it is not enough in an unrelated game state.
`801FB240` freezes the live player-control task's +0x22 bit 4 before the same
reset and is used by the original animated door opening sequence.

Within `F77F4`, the relevant condition is pause halfword `3AE26==0`, pending
byte `800C7AE9` (the fixed alias of `system+3AE29`) nonzero, and
`8015C54D==0`. This calls `FB270`, sets `8015CD04` bit 0, and selects `F7AA4`.
`F7B0C` later checks pending bit `0x80`: clear follows ordinary room teardown;
set follows the special `F8428` path. The setter's value 1 selects the ordinary
path. Conservative additional mod ownership/lock guards are policy, not
additional conditions silently attributed to native actor `0x08C`.

An authored door must guard live ordinary world ownership, current room,
non-null/non-sentinel player, no pause, no pending transition, and native
script/control busy states. It should use its own activation latch. Derived
gameplay input is inline at `D_800C7DB0_C89B0`, four records of stride `0x18`,
with held/newly pressed u16 buttons at +2/+4; observe the normal input update,
do not invoke the blocking input sampler again. Native collision/damage
callbacks must not be replayed to detect contact. A pure oriented volume or an
existing normally-produced contact state provides a bounded activation test.

## Offline actor preview context closure

Missing initial models must not be classified as invisible merely because a
constructor reads a null provisional engine pointer. Fresh canonical readers
establish these context contracts:

| Native consumer | Verified context |
| --- | --- |
| `8020D848_5C8D18` | Sets `D_8015C5C8=0x8008CCC0` before room constructors. If live player object `801FC60C` exists, copies it to `8015CD60`. |
| `8021928C_5D475C` | Copies that player **object** pointer to actor task +0x84. |
| `8021B73C_5D6C0C` | Tests squared XYZ distance between task +0x18 object and task +0x84 target object against its f32 radius squared. |
| `802192B4_5D4784` | Reads system +0x3B07A and updates RNG state `8015CC78`; failure PC `802192DC` is inside this function. |
| `801FC590_5B84A0` | Reads system +0xCF8F0; for a non-null task clears its +0x22 bits `0x14`. Failure PC `801FC5A4` is inside this function. |
| `80032850_33450` | Dynamic-object ground query, using stage and owner `8015CCC8`; failure PC `8003289C` is inside it. Empty provisional state is not proof of canonical ground height. |

The live player task `801FC604` and object `801FC60C` have different types.
The manager's recurring `8020DD78_5C9248` copies the player task to `8015CD5C`
and object to `8015CD60`. A synthetic preview may provide these pointer chains
with explicit conditional scene provenance; it must not silently substitute
the actor itself for its player target.

Camera initialization `801D23D4_58E2E4` establishes `801FC624` as the camera
task and `801FC628` as its kind-2 object at task +0x18. The object graphics
word +0x2C is `0xA020CBF0`; masking with `0x8FFFFFFE` selects the 96-byte
camera data at `8020CBF0`, not a world display list. Native object XYZ are
250/15/250, angles zero and scales one. `801D25EC_58E4FC` copies a 96-byte
constant camera record from `801FC7E8` for stage 0/3, `801FC848` for stage 2,
or `801FC8A8` otherwise. Upstream `patches/types.h:135` defines this camera
structure. Several actors read this graphics word before binding their own
model: File24 spike floor `08000980_6ACED0`, File30 `08002D98_6C24E8`, and
File57 Tiny Ushiwaka `08001254_7180F4`. Anonymous zero memory alone cannot
represent this tagged pointer chain.

Fresh canonical File15 analysis resolves candidate `0x07D`'s repeated CPU
address: `801CC978_65F828` allocates work through `80024670`, resolves
resource `0x4CD` pointer `0x08001D10`, allocates a specialized object through
`800119D4(task,9)`, and installs callback `80024160` with work callback
`801CC710`. Its object uses XYZ 10/0/-300, draw layer 3 and X rotation `0x100`.
The byte at object +5 is the draw layer, not the tagged graphics type. This
is a mode-specific object path requiring its own fixed File15 context;
ordinary File11 bytes at the same RAM address are unrelated. Previously opened
raw binaries whose file numbers differ from the canonical file table cannot
serve as constructor evidence without matching their bytes and ROM range.

Registry-based `D848` and child spawning `80217360` pass the registry resource
halfword as argument 16 to `8003555C`, then through `34E98→34CBC→34B58`.
`34B58` stores it at task +0x28 and stores `141C4(resource)` at +0x2C.
`141C4(0)` explicitly returns zero. These allocation paths do **not** inherit
the parent's overlay for a zero registry entry. Upstream
`patches/required.c:74` relocates callbacks using the task's own resource fields
during `1481C`. The five unresolved contexts above therefore remain unresolved
until an actual alternate caller/context is verified.

The CP0 instruction at `80049520` belongs to SDK `__osDisableInt`: read Status,
clear its IE bit, return the previous IE bit. `__osRestoreInt` at `80049540`
reads Status and ORs its argument into it. Their complete disassembly supports
a narrow private Status-register emulation for offline initialization; it does
not justify accepting arbitrary CP0 instructions or modeling hardware timing.

## Allocation failure suspension boundary

`func_80034734_35334(void)` is the scheduler, not a pause-mask setter. Its gate
is `(task_u16_flags_at_22 & u16_system_mask_at_3AE24 & 7)!=0`. A skipped task
also suppresses following deeper descendants until a peer/ancestor depth at
+0x20 is reached. An eligible task restores resources through `1481C`, then
invokes callbacks at +0x08/+0x0C/+0x10 with `(task,task_object)`.

Changing the mask at scheduler entry does not abort a setup callback already
running in that pass. Cold `728C` calls the unchecked load callback, allocates
light tasks, schedules a background task, synchronously calls collision
binding `8C4C`, then schedules player/actor/render tasks and overwrites the
mask with `0x14` before returning. A failure latch therefore needs guards for
the intervening synchronous resource consumers and must reassert suspension
at `728C/7F78` return before the current scheduler pass resumes, as well as at
later scheduler entries. Newly scheduled tasks do not execute their constructors
inside these allocator calls. Merely publishing empty collision/rosters and
letting a player continue does not establish a safe failure response.

This suspension gate does not stop rendering, the game loop or external
Recomp UI. A generated failure policy still requires allocation/dependency
preflight, coherent owned state and user-visible diagnostics. No native
successful/failed return contract was found for the void room load callback.

## Evidence and reproducibility

Shared API pages were read before native analysis: `8000607C`, `80003728`,
`8006B780`, system-state fields, `80035A5C`, model/task allocator records,
actor registry readers, and derived gameplay-controller input. Missing or
incomplete reference facts identified here include custom-room admission,
File11 table consumers, packed entry-byte semantics, door-selector semantics,
background kind-5 flags, and a triangle collision compiler. No documentation
site edits or publication were performed.

Ghidra tools used: tool discovery, `list_open_programs`, `import_file` for
private canonical File15/File29 wrappers,
`decompile_function` with explicit program and address lists,
`disassemble_function`, `disassemble_bytes`, `get_xrefs_to`,
`get_function_xrefs`, and `get_bulk_xrefs`. Programs used for these consumers:
`mnsg_main_static.elf`, `mnsg_player_file_11.elf`,
`world_file_12_common.elf`, `world_file_43.elf`, File24/File30/File34/File46/
File56/File67 programs, `mini_ebisumaru_file42.bin`,
`sasuke_music_file47.bin`, and the private canonical File15/File29 programs.
ROM-suffixed symbol names
in this document preserve overlay identity. Data-symbol bounds were checked
against `Goemon64RecompSyms/mnsg.datasyms.toml`; code identities and extents
against `Goemon64RecompSyms/mnsg.syms.toml`.

Private offline shape/classifier/multiple-cell research scripts were run using
`node --import tsx` and `InitMachine`; they emitted only statistics and synthetic
query results. The production owner subsequently added the separately owned
`core/authoring/native-harness.ts` for reproducible canonical-ROM queries.
No ROM bytes, decoded game graphics, or palettes belong in the repository.

These native proofs do not independently establish generated custom-room
admission, allocation/dependency failure handling, custom-door behavior,
ancillary camera/minimap policy, or complete actor preview coverage.
Implementation checks belong to the corresponding compiler and runtime tests.
User gameplay validation remains necessary for entry, contact, movement, exit,
teardown, and revisit. Canonical collision reverse-conversion parity is not
claimed; preserving the original opaque BSP is the verified clone policy.

## Authored proximity roster lifecycle

Fresh `func_8020D36C_5C883C` resolves each grid cell through `14840` and
explicitly checks the resolved pointer against zero before reading an instance.
Sparse zero cell pointers are therefore valid. Nonempty cells contain writable
20-byte instances, terminated by a zero definition pointer at +0x0C. Byte
+0x10 is the native active latch: allocation failure leaves it zero; successful
`19CA0` and `35690` allocation sets it to one, initializes through `18A54`,
sets task +0x68 to 8 and saves the instance pointer at task +0x70.

The configuration is 28 bytes: three u16 widths at +0/+2/+4, two padding bytes,
three f32 origins at +8/+0x0C/+0x10, and three u16 counts at +0x14/+0x16/+0x18.
Cell pointer order is `(x*countY*countZ+y*countZ+z)*4`. `D848` resolves the
configuration, grid and normal list through `14840`; its negative CPU-pointer
passthrough supports source-wave zero when all owned pointers are direct CPU
addresses. `D848` checks the `3555C` allocation result before `18A54`.

`18F30` cleanup retains the writable source pointer in a subsequent task when
necessary. Its byte +0x76 is increased by five. This is proximity hysteresis,
not a duration: `8021A328_5D57F8` compares absolute source/player XYZ differences
against `(u8_task_76/10.0)*gridWidth` on all axes. Outside any threshold it clears
source byte +0x10, clears task +0x70 and sets task +0x68 to 2. `18F30` then
removes that task. Revisit initialization must reset owned latches only after
native tasks retaining those source pointers have been removed.

## Additional actor context proof

`func_80221F70_5DD440` dereferences player-task `801FC604` +0x5C as a pointer
to player work and clears its first u16. This field differs from an ordinary
actor task's u16 actor ID at +0x5C. Upstream `patches/types.h` describes
`PlayerTask.player` accordingly. A preview must preserve that separate task,
object and work pointer chain, with conditional scene provenance.

The camera constant record is **0x60 bytes (96 decimal)**. A 60-byte copy would
truncate the structure. `18A54` calls `1928C(task)` before the constructor and
copies player object `8015CD60` to actor task +0x84; setting the global alone
does not reproduce native task initialization.

`8020D724_5C8BF4` stores its manager task in `8015CCBC`. File67 initializer
`08000000_7295A0` passes that task to `08000DA4_72A344`, which creates a child
through `171A8`, chooses model identity `0x336`/slot zero, and supplies native
XYZ -4/-90/67. Substituting the actor itself as manager would change the native
ownership and copied placement. Missing manager state remains conditional.

The File54 house constructors `08000C18_711278` and `08000F18_711578` bind
identity `2D1/2D2`, perform initialization and scale writes, then test flag
`0x97`. The clear branch calls `80034ED4` using `jalr` at `08000C9C` or
`08000F9C`, with return addresses `08000CA4`/`08000FA4`; each immediately
branches to its epilogue. There is no later resource call on that removal
branch. The active branch installs `CCC/FCC`; its future behavior must be
analyzed separately. This supports narrow constructor dependency completion,
not blanket completion for every actor that declares a model before removal.

### Overlay trailing allocation

Fresh main `80001C00_2800` computes allocation extent from the native allocation
start/end table and zeroes bytes after the loaded file through that extent.
ROM code bounds and writable overlay scratch bounds are distinct. File24 has
ROM extent `6AC550…6AD3C0` (0xE70 bytes) and native allocation
`08000000…08000E80`; its 16-byte tail includes `08000E70`, written by
`08000808_6ACD58`. File65 has ROM extent `725C30…726490` (0x860 bytes) and
allocation `08000000…08000870`. These exact tails may be initialized to zero
in private preview memory. They do not authorize reads from adjacent ROM
files, arbitrary overlay bounds, or a generic guessed scratch region.

File15 `80024670_25270` allocates 0x80 bytes through `148F0`, then passes the
returned pointer to `246BC`. Disassembly confirms this argument despite its
omission in initial decompiler output. `246BC` sets its work defaults;
`119D4(task,u8_type)` allocates kind-2 object storage, checks failure, and writes
object type and the tagged graphics word `0xC0063930`. This specialized path
requires File15 context; it is not an ordinary actor model binder.

### Background and transition state

Kind-5 background initialization `801F8494_5B43A4` calls
`35DFC(task,5,1)` and checks failure. Texture and palette pointers occupy
+0x38/+0x3C; signed 16-bit dimensions are 640/240 at +0x10/+0x12. Flags
+0x0E are `0x2009`; +0x2E/+0x30/+0x32/+0x34 are u16 values
0/16/319/224. Float fields +0x14/+0x18 start at zero, +0x24 comes from
native `8020C688`, and +0x28 contains `0x436F0000` (239.0).
The installed callback `801F8644_5B4554(task,object)` calls
`801F8670_5B4580(object,640,136)`, which updates background offsets from the
current camera direction. It consumes the kind-5 object layout, not a kind-2
world object.

`8000607C` does not clear system +0x3AE2C/+0x3AE30. Scripted transition
`801FA420_5B6330` writes those fields and ORs bit 8 into the transition latch.
`801F8FD0_5B4EE0` subsequently reads the offset fields regardless of latch bit
8. Clearing both for a generated ordinary door is an explicit mod policy to
avoid stale scripted camera offsets, rather than a native queue side effect.

Native room-player callbacks `801DF3D8_59B2E8`, `801F6B34_5B2A44`, and
`801E7FB4_5A3EC4` choose input using **u8 player task +0x90**, multiplied by
the 0x18-byte input-record stride. Derived input records start at `800C7DB0`;
held buttons are u16 +2 and newly pressed buttons are u16 +4. The live player
task (`801FC604`/`801FC608`) differs from its world object
(`801FC60C`/`801FC610`). A generated door must validate the selected controller
index before reading its input; assuming controller zero discards native
ownership.

Kind-5 rendering `80022A74_23674(object)` uses a different path from world
model rendering. `80022EC0_23AC0` emits palette `SETTIMG` using object +0x3C
verbatim, and `80022500_23100` emits texture `SETTIMG` using object +0x38
verbatim. These commands do not strip a CPU pointer to a physical address.
Owned high-address background data therefore needs the verified RT64 extended
pointer mode around this draw path as well as around ordinary model draws.

Native `80022EC0_23AC0` consumes background alpha byte +0x2C only when flags
+0x0E include `0x10`. The ordinary sky flags `0x2009` leave that bit clear.
Original `801F8494` omits the alpha write, and the pool allocator does not
guarantee alpha 255; the unused byte is safe for these exact flags. An authored
background enabling the alpha flag would need an explicit alpha value.

### Fixed executable identity and dynamic resource readiness

`800141C4_14DC4(u32 id)` searches only the dynamic resource registry
`80167FC0`, in eight-byte records terminated by a zero ID. ID zero returns
zero; an absent nonzero ID returns `0xFFFFFFFF`. It has no special case for
fixed executable overlays. `800203D4_20FD4(s16 first,s16 second)` instead loads
nonzero fixed executable IDs through `80001C00_2800` at CPU bases `801CB460`
and `8020D2A0`. Code mapping and dynamic asset readiness are different facts.

A canonical catalog/donor dependency audit found no IDs 11 through 23 in the
then-current 383-room, 2,093-prototype lists. This bounded snapshot supports
their dynamic-resource preflight; it does not authorize adding a fixed code
file merely because a constructor executes at its CPU address. Future
initializer-derived resource closure must retain the actual loaded-resource
provenance and independently check any newly introduced fixed ID.

The registry has **48 accepted ID slots**, at `80167FC0+8*i` for `i=0…47`.
Fresh `80013B14_14714` disassembly advances the entry pointer by eight at
`80013B54` and tests it against exclusive limit `80168140` using `sltu` at
`80013B68`. A full registry returns zero without loading another ID. Loading
the last accepted entry writes the next zero terminator at `80168140` and
the next aligned end pointer at `80168144`; these addresses also serve as
loader scratch globals. `80013940_14540` clears the 48-entry range and seeds
the first destination pointer with `80304000`. `13B14` does not evict entries
to make room. A compiler must count the union of baseline and authored
resource IDs; a closure exceeding 48 is impossible for this loader. Passing
that count does not establish memory capacity, remaining slots for later
events, or successful allocations.

Room transitions truncate cached registry suffixes through a separate helper,
`800139A4_145A4(u16 registryIndex)`. It takes an **entry index**, not a file
ID. `801F7F78_5B3E88` calls it with system +0x3B020 before reloading the room
callback. `801F87F8_5B4708` compares the donor resource sequence beginning at
system +0x3B01E, truncates at the first mismatch, sets +0x3B020 to that base
plus donor-resource count, then loads the donor sequence. An authored load
callback therefore runs after a retained prefix. Counting its own resource
list alone does not prove capacity; runtime preflight must include the actual
retained registry entries and treat a zero loader result as failure.

### Conservative world cache backing policy

The canonical fixed allocation record for File10 is
`80304000…80594000`, a 0x290000-byte region. Main `80000580_1180` actually
loads File10 at `80304000` during startup; `80001C00_2800` zero-fills through
that allocation end. `80400000` is therefore not the documented native bank
end. The world cold setup `801F728C_5B319C` subsequently calls
`801DC630_598540` before common, donor and room-resource loading. That function
clears the registry and repurposes this same bank for player resources and the
append-only world cache:

| Reserved world state | Native location |
|---|---|
| Base work pointer `8020D224` | `80304000` |
| Four 0x1000-byte buffers in `8020D228…8020D234` | `80305500`, `80306500`, `80307500`, `80308500` |
| 0x18000-byte player buffer in `8020D220` | `80309500` |
| Initial dynamic registry destination `80167FC4` | `80321500` |

Disassembly `801DC640…801DC700` confirms those counts and strides. The world
prefix `[80304000,80321500)` must remain intact. A defensible conservative
authored-world policy uses exclusive cache end **80594000**, matching the
positive native backing-bank extent, and reads the live retained-prefix cursor
before every append. This is an explicit exported bound; the native loader
does not enforce it itself. It applies to the verified ordinary File11/File12
world mode, not arbitrary minigame, Impact, fixed-overlay or other-mod layouts.

Other fixed allocation records are disjoint: File8's framebuffer bank is
`80261000…802F7000`, File9 is `802F7000…80301800`, and fixed executable
Files11…23 lie below `8023D480`. Thread stacks initialized by
`80000450_1050`/`800004AC_10AC` are at `800841D0`, `80088380` and
`8008A530`. Audio initialization `800386E0_392E0` uses heap
`801729C8…801C09C8` and DMA ROM bank/sample addresses. The linker asset label
`audio_tables_VRAM_END=80556B40` is not evidence that all audio sample bytes
are permanently copied there at runtime.

The loader's exact allocation extent is
`u32(ROM556C4+fileId*8+4)-u32(ROM556C4+fileId*8)`, corresponding to
native `80054ACC[(fileId-1)]`. It is not the raw file length. A code resource
whose `80001DF4_29F4(fileId)` returns nonzero aligns its destination to 0x1000;
the next cursor is aligned to 0x40 after the allocation extent. Upstream
`patches/required.c:11–70` preserves these extent and zero-fill rules while
adding overlay relocation. PIC-part expansion `800142BC_14EBC` uses native
part offsets relative to this resource destination, with separate scratch
allocation at the `802F7000` arena or framebuffer workspace. Native raw file
copy length is `(rawLength+1)&~1`, so its even-aligned length must also fit the
allocation extent. Canonical validation must cover every part destination and
decoded length, with a bounded parts-list terminator, before treating the
extent as the complete write budget. The previous independent 537-PIC,
148-wave census establishes those canonical decoded bounds; it does not
authorize resource substitutions. Runtime replacement resources or relocated
native banks remain outside this fixed canonical contract.

Recomp maps more host memory and reserves PI handles at `80800000`, patch
memory at `80801000` and mod memory at `81000000`; none of those addresses
authorize extending the native world cache to the intervening bytes.

### Finite actor lifecycle classifications

These are native lifecycle evidence, not a claim that all corresponding
library previews or gameplay configurations are implemented:

| Actor | Verified native path | Consequence for preview |
|---|---|---|
| `0x23B` | File43 `080022FC_6F57DC` immediately returns. | Registered no-op; no graphics declaration or deferred child path. |
| `0x35E` | File24 `08000808_6ACD58` is the persistent callback. It stores its task in the zeroed overlay tail, then services a countdown and spatial sound through `8000F420_10020`. | No own model on either branch; do not invent a mesh from its name. |
| `0x19A` | File34 `080006EC_6D4A2C` selects callbacks `08000534_6D4874`, `08000594_6D48D4`, or `08000628_6D4968`. On countdown expiry they create actor `0x191`, or child callbacks `08000F50_6D5290`/`08001388_6D56C8`. | Timed spawner with no own mesh; child visuals remain separate. |
| `0x19D` | File30 `0800447C_6C3BCC` selects countdown `08004550_6C3CA0`; `08004594_6C3CE4` creates a child through `8021DDE8_5D92B8`. Child `08004694_6C3DE4` chooses identity `0x19D` and calls `8021664C_5D1B1C` with slot zero. | Timed native child model; returning before countdown is not proof of no visuals. |
| `0x147` | File36 `0800041C_6DA2EC` calls `8021B73C_5D6C0C(task,300.0)` before binding slot zero and creating its child. | Visual only when the native player-distance predicate passes. |
| `0x3DA` | File34 `080014B4_6D57F4` waits for player Z minus source Z in `(100,200)` before a later state chooses identity `0x191` and binds slot zero. | Conditional delayed own model; constructor silence is not mesh absence. |
| `0x3FC` | File39 persistent `08001994` sets its active state when player distance is below 50, then emits `080015E4` children on three countdown residues. | Proximity emitter with no own mesh; emitted children need separate preview support. |
| `0x142`, `0x1B2` | File42 `08001954` and File47 `08000AD4` wait for their native initial timers before creating minigame children. | Timed scene controllers; their child declarations must not be discarded. |

`8021B73C_5D6C0C` compares the squared XYZ distance between actor task +0x84's
player object and actor task +0x18's own object against squared radius. It
returns zero for distance greater than or equal to the radius. A preview may
report that scene-dependent gate; changing it silently would choose a different
native state.

Resource-closure completion is a separate classification from visible model
coverage. Exact File12 constructor `802151E0_5D06B0` for `0x08C` only writes
identity `0x7E`, object scales 0.2, task flags, and changes its callback to
`80215230_5D0700`; it requests no dynamic wave in that initialization path.
File24 `0x35E`'s complete persistent callback requests no dynamic wave either;
its eventual spatial-sound call is an audio operation. File30 `0x1BF`
constructor `08002D98_6C24E8` may allocate camera work through
`80012940_13540`, which uses the room arena and a type-two tagged camera graph,
not a model wave. This establishes no additional dynamic-wave request for
those exact constructors, not full future-script or gameplay parity. The
initializer's own overlay dependency remains required. A silent timed
spawner cannot receive the same classification without tracing its children.

Actor `0x1B0` in File46 has an additional sibling dependency. File56 actor
`0x287` initializer `08000000_712F70` writes its task to `8015CDB8` at
`08000014`; File46's `0x1B0` path reads that task's +0x18 object at
`08001FBC`. Canonical room 341 contains `0x287` before `0x1B0`. This supports
conditional evaluation of that actual sibling context, not an arbitrary task
substitution. File30 reuses the same global as floating-point state, so its
type is not universal across overlays.

Additional-object binder `80216E54_5D2324(task,slot)` calls
`80035EEC_36AEC(task,2,1)`, writes default material `C006D920` and scales
0.1, then calls `80216CE0_5D21B0`. It does not copy parent XYZ or angles.
`35EEC` appends objects to the task's +0x18/+0x1C chain; its pool allocator
`80035D8C_3698C` clears the next pointer and object-byte +4 bit seven and
increments the pool-use count, without initializing XYZ or angles. An offline
preview must therefore distinguish constructor-written transforms from
unwritten pool state. File46's `1B0` cloud callback `08001FE8_7030E8` writes
its generated objects' transforms explicitly; the linked-shadow helper has a
separate copy contract.

### Specialized generated graphics and light work

`800119D4_125D4(task,u8 layer)` writes kind two at object +4 and the layer at
+5, while choosing tagged graphics `0xC0063930` at +0x2C. The world renderer
`80016C44_17844` selects graph type from graphics bits `0x70000000`; the byte
at +5 does not turn that pointer into a different graph type. File15 actor
`0x07D` subsequently builds a rippling grid through `80024160_24D60`,
`800248BC_254BC`, and `80024BAC_257AC`. Capturing its initial placeholder
display list omits its authored generated vertices and commands.

`8001381C_1441C(task,u8 layer)` allocates light-controller work through
`80034E08_35A08` with callback `80012AD8_136D8`, seeds its native float fields,
and creates two kind-two objects with tagged graph pointers
`work+0x300000CC` and `work+0x500000D2`. Its return is that work task, or zero
on allocation failure. File29 actor `0x0CE` passes this result to
`800133E0_13FE0`, which writes three float words at +0x60/+0x6C/+0x78.
A null result caused by an incomplete offline allocator cannot be interpreted
as an authored zero model or a legitimate arbitrary live-state pointer.

### Exact house-controller constructor closure: 0x308 and 0x34E

These findings use the canonical decompressed ROM hash stated above and exact
overlay identities; an actor ID or a nonvisual label alone is insufficient.

`0x308` selects File27 entry `080020F4_6B1504` (size `0x50`).
Its only state read is signed word task +0xE0. It increments that word once,
and a second time when the previous value is below ten. Otherwise it calls
`8003521C_35E1C` with callback `08002144_6B1554`. There are no constructor
child, wave, model or table-resource requests. This proves bounded constructor
resource closure with its existing File27 code dependency. This finite
constructor-closure classification is defensible for an authored room 621
retaining donor 465's roster, because the inspected constructor and camera
callbacks introduce no actual-room-indexed resource access. It must remain
identified as a static constructor proof, rather than a claim that the
offline interpreter executed every future camera callback.

The installed callback allocates room-arena camera work through `80012940`,
reads source object XYZ, the live player at `801FC60C`, and camera object
`801FC628 +0x2C`, then installs `08002388` and paired callback `08002814`.
Inspected follow-up callbacks `08002388`, `0800246C`, `08002644` and
`0800284C` manipulate camera work and the native player/partner-task chain.
They contain no actual-room-ID indexed resource lookup. This avoids an
inferred room-621 table failure, but does not eliminate native scene inputs:
camera/player pointers, camera-work allocation success, and a valid partner
task are required. The partner-camera path divides by the measured camera
distance without a zero-distance guard. Constructor closure does not certify
later camera behavior or replace those live inputs with fabricated tasks.

`0x34E` selects File61 entry `0800098C_72125C` (size `0x64`).
It tests native flag `0x199`; when clear it sets that flag and calls
`8003D310_3DF10(0x137)`. Both branches then call current-task removal
`80034ED4_35AD4` at `080009D8`, returning to `080009E0` and the epilogue.
There are no deferred actor callbacks or child tasks from this constructor.
It is **not resource-free**: scenario startup can request a dynamic script
resource before removal.

Canonical scenario tables at ROM `0x785A0 + scenario*4` and
`0x79208 + scenario*2` map scenario `0x137` to script pointer `0x0800AA4C`
and resource **96 (0x60)**. File96 spans ROM `0x74ECE0…0x759DF0`, with native
allocation `0x08000000…0x0800B110`; the script pointer lies within it.
Fresh `80001E50_2A50` disassembly independently confirms File96's native
segment is **8**: record ROM `0x55528` has exclusive upper bound 82 and
segment 9, which does not match 96; the next record at `0x5552C` has exclusive
upper bound 123 and segment 8, which does. The function compares the current
record's own boundary before returning its byte +3. Advancing a boundary
without advancing its associated segment would produce an incorrect result.
Consequently, `3DDC4` resolves `0x0800AA4C` as loaded File96 base plus
`0xAA4C`, within extent `0xB110`. Native `01DF4(96)` returns zero, so this
resource does not use the code-tag 4 KiB destination alignment policy.
`8003D468_3E068` checks the scenario-manager task at `80077860`, then uses
`141C4`/`13B14` to obtain that exact resource if absent. `8003DDC4_3E9C4`
repeats the same-resource lookup when needed. `8003CFA0_3DBA0` is a pointer
table lookup, and `8003DE48_3EA48` translates the selected script pointer.
Stopping an existing script and `8000C838_D438` only clear/free existing
room-arena work in these inspected startup callees; they add no wave request.

A finite completion rule must retain File61, the actual flag branch, canonical
scenario-table provenance, and a captured File96 request when the clear-flag
path runs. Returning zero for scenario startup or accepting terminal removal
without capturing that request would miss the constructor's dependency.
The running scenario virtual machine may perform later native actions; that
future execution and gameplay remain outside this constructor proof.

A conservative declaration may include resource 96 for either initial flag
state, keyed to this exact constructor and the two canonical scenario-table
entries. Such a declaration is a **statically verified dependency contract**:
it must not say the CPU interpreter executed scenario startup or mark that
helper as a resource-free no-op. If interpreted-path completion is required,
the interpreter must handle the verified scenario-start ABI, capture that
request, retain branch provenance, and stop future script execution outside
its supported scope. An unavailable scenario-manager task is a scene-state
limitation, not evidence that the resource dependency disappears in-game.

Constructor byte hashes provide an additional identity guard:

| Entry | SHA-256 of its canonical byte range |
|---|---|
| File27 `080020F4`, size `0x50` | `e87911e696977b8c4096aa422a893ccaa6f4004972f5194df565f0b00d81653c` |
| File61 `0800098C`, size `0x64` | `1814198742678a03a59f45aa771b00c8f6f2ba37ea08acc6603204075cfa9410` |

This evidence was read with explicit-program Ghidra `decompile_function` and
`disassemble_function` calls for both entries and their named callees, plus
bounded Python `struct`/`hashlib` reads of the canonical ROM tables and byte
ranges. The constructor slices in both pinned Ghidra ELF inputs were compared
against their canonical ROM ranges through the ELF load segments and match
byte for byte. Symbol identity was also checked against `.file_27` and
`.file_61` in `Goemon64RecompSyms/mnsg.syms.toml`. The current shared API has
the actor-entry registry and flag/removal helpers, but does not document these
two constructors or scenario startup's resource-96 contract. No native
callbacks or game process were executed.

### Delayed first-model previews: 0x19A and 0x19D

This is a bounded preview contract for two native delayed visual prefixes.
It does not establish complete foreign-room resource closure or later
gameplay. The original task bodies, callback assignments and child binders
must execute in the bounded interpreter; no actor-ID-to-model shortcut is
justified by this evidence.

`0x19A` selects File34 constructor `080006EC_6D4A2C`. Its mode byte is
task `+D4`, taken from parameter-word 1's most significant byte. Mode 1
installs `08000594_6D48D4`; subtype byte `+D5` selects an initial unsigned
halfword counter at `+8A`: 1 for subtype 0, 50 for subtype 1, otherwise
100. The callback reads the **old** counter with `lhu`, stores its decrement
modulo 65536, and creates a child only when the old value equals zero.
The room91 placement `[00000000,01020000,00000000]` therefore requires
101 total callbacks, or 100 additional callbacks after the existing first
preview callback. A synthetic forced zero would bypass native timing.

The callback calls `802171A8_5D2678(parent,08000F50,0x0C)`. After a
successful allocation it writes the child's code-file identity 34 and wave
base and restores the parent's saved yaw. Child initializer
`08000F50_6D5290` assigns model identity `0x1A4`, then calls
`8021664C_5D1B1C` with slot 0, step `0.1f`, loop byte 1. The actual
descriptor at `80235358` selects files 476/352 and slot pointer
`08000058`. The native binder also requests baseline file 338. The child
inherits the parent's XYZ `(120,100,-400)` through the native allocator;
the allocator does not copy definition words into child `+D0/+D4/+D8`.
Mode 0 uses actor `0x191` through `80217360_5D2830` instead; mode 2
uses child `08001388_6D56C8`, identity `0x1A4`, slot 3 and scale `0.3f`.
These are distinct native paths, not substitutes for mode 1.

`0x19D` selects File30 constructor `0800447C_6C3BCC`. It initializes
unsigned counter `+8A` from parameter-word 0's byte at task `+D2` and
installs `08004550_6C3CA0`. Each countdown callback subtracts two,
masks to 16 bits, and changes the callback to `08004594_6C3CE4` only
when the **new** masked value is zero. Canonical room171 parameter
`00787800` yields 120: 60 countdown calls plus one birth callback. After
the existing first call, 59 countdown calls and one birth call remain.
Positive even byte values have at most 127 countdown calls; odd values
never reach zero by this recurrence. An initial zero needs 32768
decrements and is outside this short preview contract.

Mode 0 explicitly changes the Slicer parent position to `(-40,18,-190)`
and X rotation to 75 native units; mode 1 uses `(-40,5,-190)`. These are
constructor writes, so copying the original placement `(-40,10,-230)`
into the delayed child would be wrong. Birth callback `4594` calls
`8021DDE8_5D92B8(parent,08004694,owner=1,offset=(0,0,0),last=0)`.
The helper rotates the offset, adds parent XYZ, creates the child through
`171A8`, and stores its last argument at `+88`. After the helper returns,
the parent callback plays sound `0x271`, writes child code-file 30/wave
base, and sets child `+DC` to the parent task. The interpreter must finish
these assignments before running the queued child.

Child `08004694_6C3DE4` assigns identity `0x19D` and binds slot 0,
step `1.0f`, loop byte 0, with scales `0.1f`. Descriptor `802352F8`
selects files 470/384, slot pointer `0800001C`, plus baseline file 338.
Velocity depends on the parent's `+D3` byte, not copied child definition
data. Owner selection is native: owner 1 uses manager `8015CCD0`;
Barrel's owner `0x0C` uses `8015CCD4` and its native quota. Allocation
failure must remain a failure rather than a fabricated child object.

Slicer's material is a relocated **CPU File30** command stream. Both
constructor and child write the pointer with bit `0x20000000` set.
HI16/LO16 relocations at `08004484/0800448C` and
`080046A8/080046AC` target File30 local `0x7C30`. Recomp's generated
HI16/LO16 expressions use `section_addresses[section]+offset`, so the
runtime pointer is `(loaded File30 base+7C30)|20000000`, not RSP
segment 8 in model file470. Main `800196F0_1A2F0` masks
`0x8FFFFFFF` and, when that tag is present, CPU-copies material commands
inline until `B8000000/00000000`. The finite material spans `7C30…7CC0`
(`0x90` bytes), with END at `7CB8`. It has no nested DL/VTX commands
or material-range data relocations. Its sole address-bearing command is
`SETTIMG` at `7C78` with `09001000`, which remains a segment-9
texture in descriptor secondary file384. The span SHA-256 is
`67e77856e772fba00e4e76bac243fc102673b82e96820d3467fa779d3cf59ea3`.

Relevant upstream evidence is `N64Recomp/src/recompilation.cpp:164`,
`N64Recomp/src/cgenerator.cpp:109`, and `N64Recomp/include/recomp.h:461`
under `Goemon64Recomp/lib/N64ModernRuntime`. `patches/required.c:38`
loads an overlay then applies relocation entries; `patches/overlay_reloc.c`
handles `R_MIPS_32`, while recompiled HI16/LO16 instructions use the
section-aware expressions above. A blanket CPU-segment-8/model-segment-8
alias would select the wrong resource.

The exact `4594` sound call may be recorded and omitted in a silent
preview. Shared API `8000F420_10020` has signature
`void(u16,const sound_state*,const object*,f32 radius)`. Fresh main
disassembly confirms XYZ reads at object `+8/+C/+10` and float bits in
GPR `a3`. `F420→F6E8→FE1C` computes spatial pan/volume and calls
`80038C30_39830`, which writes only the eight-entry sound queue at
`801C0A00`, count byte `801C09FD`, and audio byte `801C09C9`.
It does not load model waves or mutate the parent/child task. This narrow
presentation omission does not license ignoring other unknown helpers.

The first installed post-bind callbacks were also inspected: Barrel
`08000EE0`/`08001318` enter native ground queries and later switch
callbacks; Slicer `0800488C_6C3FDC` enters native movement/removal
behavior using parent state. Those later physics paths, resource requests
and task lifetimes have not been fully traced. Stop the model preview after
the genuine child initialization; retain incomplete export dependency
status unless a separate full closure proof exists.

Canonical byte guards for the implemented mode-1 Barrel and Slicer paths:

| File / local range | SHA-256 |
|---|---|
| 34 `6EC`, size `F0` | `7d61ffaa555ffb96673ba6c5368ccbb0e4e26f136cd85e50ea29085a04dd93ec` |
| 34 `594`, size `94` | `aeafbf2ec9b147cd819ac0d1458beb718b808e3be43cafe3b125dfaf2dacfbbe` |
| 34 `F50`, size `12C` | `c78803cd9430e77b08a673792ace421cb1cdb72d71bc78bf8bc4805de536e640` |
| 30 `447C`, size `D4` | `b12300be7ca9fac17e87ef058b2237d0e0064ffd429490ac6013e7f0e8c027f4` |
| 30 `4550`, size `44` | `9b0d8f05113a18129880deab463a14699b1dbbb08f43a0a3a6e87d7a2e357375` |
| 30 `4594`, size `C0` | `37d2e25e4dea7ae6dfb7afd24d8ab6d52e0e41dda3621d3620da60f17ef86f03` |
| 30 `4694`, size `1F8` | `222a33c87e2c0819c21eebb4399c9c91259034408cfd32024a0c927cb05f23ec` |

Evidence came from explicit-program Ghidra `decompile_function` and
`disassemble_function` calls against `world_file_34.elf`,
`world_file_30.elf`, `mnsg_player_file_11.elf`, and `mnsg_main_static.elf`,
plus canonical-ROM `struct`/`hashlib` reads of those file ranges, registry
descriptors, and material commands. The private pure counter census
verified unsigned wraparound and the canonical call counts. The loaded
Ghidra programs remain available but their original temporary ELF paths
have expired; this timed proof makes no fresh on-disk ELF comparison claim.
The shared API documents the general binder/allocation/audio helpers but
does not contain these exact timed actor contracts. No game callbacks or
game process were executed.
