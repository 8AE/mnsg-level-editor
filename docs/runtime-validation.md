# Isolated Goemon64Recomp validation preparation

Research date: 2026-10-04. This document records read-only preparation and the
later user handoff. The game has not been copied or launched by this research
task. Native analysis and a successful `.nrm` build do not establish gameplay
behavior. The user installs and tests generated mods; do not launch, install or
test an NRM automatically at task completion.

## Current test handoff

Provide the user these files and changes:

- `test-mods/house_translation_test.nrm`: generated Recomp mod.
- `test-mods/house_translation_test.mnsgproj`: matching editor project.
- Rooms465 (`0x1D1`, Goemon's House) and483 (`0x1E3`, shared geometry alias):
  translate static room geometry and collision by `(0,-16,0)`. Actor placements,
  entrances and camera data are unchanged.

The user reported that the room appeared lower relative to the exit door in a
2026-10-04 screenshot. This is consistent with the intended visual shift. There
was no controlled before/after comparison, independently demonstrated collision
landing, or room reload verification. The user will check gameplay; do not turn
this report into a broad gameplay pass.

## Installed game and compatibility evidence

The installed bundle is `/Applications/Goemon64Recompiled.app`, executable
`Contents/MacOS/Goemon64Recompiled`. Its Info.plist reports version/build `1.0`,
bundle ID `com.github.goemon64recompiled` and minimum macOS 11. The executable
contains both arm64 and x86_64 slices. Filtered executable strings contain
`0.2.0-dev`, matching `Goemon64Recomp/src/main/main.cpp:60`. Bundle version 1.0
and the runtime mod API version are different fields.

`otool -L` finds bundled SDL2 and Freetype through
`@executable_path/../Frameworks/`, and system AppKit, Metal, QuartzCore,
CoreGraphics, IOKit, Foundation/CoreFoundation, Objective-C, C++ and system
libraries. Copy the complete bundle, including Resources and Frameworks.
This is not a bare executable that should be relocated on its own.

`nm -gU` confirms the following exact host symbol names in the installed binary:

- `func_800141C4_14DC4` and `func_80014840_15440`: availability and wave mapper.
- `func_801F8C4C_5B4B5C`: static collision binding, File11.
- `func_801F95D8_5B54E8`: primary/secondary room model binding, File11.
- `func_8020D848_5C8D18`: room actor initialization, File12.
- `func_8000B640_C240` and `func_8000B2A0_BEA0`: fresh-save/spawn consumption.

The numbers embedded in these names are native VRAM and ROM identities. Host
Mach-O `nm` addresses are different and must never be used as N64 addresses.
Presence alone does not verify hook registration or acceptance of a generated
mod. Check the isolated game's mod menu and logs during the actual test.

## Profile isolation

`src/game/config.cpp:134-188` chooses its application data directory in this
order: working-directory `portable.txt`; on macOS, `portable.txt` beside the
application bundle; then `APP_FOLDER_PATH`; then normal Application Support or
home-directory fallback. Use all three explicit isolation mechanisms with the
same private test directory. Do not alter `HOME`, the installed bundle, or the
user's existing Application Support directory.

The following commands are a preparation recipe, **not commands executed during
this research**. Use a new directory for each run and substitute the generated
mod's actual path when the mod is ready:

```sh
test_root=$(mktemp -d /private/tmp/mnsg-runtime.XXXXXX)
ditto /Applications/Goemon64Recompiled.app "$test_root/Goemon64Recompiled.app"
touch "$test_root/portable.txt"
mkdir "$test_root/mods"
# For the mod run only, copy the generated .nrm into this fresh mods directory.
cd "$test_root"
APP_FOLDER_PATH="$test_root" \
  "$test_root/Goemon64Recompiled.app/Contents/MacOS/Goemon64Recompiled" \
  >"$test_root/runtime.log" 2>&1
```

Launching the bundle's executable directly gives an explicit CWD and environment;
the neighboring portable marker also covers subsequent Finder launches of this
copied bundle. Do not launch the installed app through an existing Dock item.
Do not symlink or copy the user's normal profile into the test directory.
Import the user's ROM with this isolated application's own file picker. Its
normal validated cache and saves are then confined to the test root.

Expected files beneath the root, from current source:

| Path | Purpose/evidence |
| --- | --- |
| `general.json`, `graphics.json`, `controls.json`, `sound.json` | `config.cpp:21-24` |
| `mnsg.us.z64` | Registered game ID `mnsg.us` plus `.z64`; `main.cpp:358`, runtime `recomp.cpp:63-65` |
| `mods/` | Mod packages; runtime `mods.hpp:63`, `recomp.cpp:87,102` |
| `mods.json` | Enabled-mod configuration; runtime `recomp.cpp:89` |
| `mod_config/` | Per-mod configuration; runtime `mods.hpp:64`, `recomp.cpp:88-90` |
| `saves/mnsg.us.bin` and backup files | Runtime `pi.cpp:99-118,243-248` |
| `runtime.log` | Shell-redirection output for this test only |

For baseline and edited comparisons, make two fresh isolated roots. Complete a
baseline fresh adventure, stop the process cleanly, then copy only that test's
own save into the edited root. Never copy a save while its saving thread runs.
Keep the original baseline root intact for comparison. Store logs and
screenshots outside the repository; cached ROMs and saves are game data.

## Reachable room and controls

The shared API reference already describes the fresh-save initializer and
saved-spawn consumer. Fresh Ghidra reads in `mnsg_main_static.elf` confirm:

- `func_8000B640_C240(void)`, VRAM `8000B640`, ROM `C240`, `.main`: clears
  `0x304` save bytes, writes u16 room `8015C80C = 0x1D1` (465), entrance byte
  `8015C80E = 2`, spawn shorts `(-2,-40,8)` and zero angle, then mirrors save.
- `func_8000B2A0_BEA0(void)`, VRAM `8000B2A0`, ROM `BEA0`, `.main`: reads that
  saved room into state+`3AFE0` and current room `D_800C7AB2`; copies saved
  rotation, XYZ and camera fields and prepares stage/load bookkeeping.
- Its sole native call xref is `80002E38` in `func_80002DE4_39E4`, which uses
  this consumer before transition state `0xD` when `DAT_800548D8 == 0`.

Room 465 is Goemon's House (`src/game/scene_table.cpp:289`), a useful reachable
interior after the opening sequence. This is a statically proven default, not
proof that the first rendered intro frame is room465. Observe the normal fresh
adventure before choosing an edit. Room 0 is the Oedo Castle tile room, not the
fresh-save destination.

The current parser independently recognizes room465 with 249 visual triangles,
455 editable vertex sources, 102 static planes, 12 collision cells and 8 actors.
Its geometry/collision alias group is `[465,483]`; translating this source also
affects the other room. Room 353, Oedo Town Housing, has an independent group.
The current handed-off test lowers Y by 16. Compare it with an unmodified baseline
and check player landing and walls. Room translation does not move entrances,
actors or camera paths.

Default keyboard bindings in `src/game/input.cpp:332-395`:

| Native input | Key |
| --- | --- |
| Analog movement | W/A/S/D |
| A / B | Space / Left Shift |
| Start | Return |
| L / R / Z | E / R / Q |
| C buttons | Arrow keys |
| D-pad | I/J/K/L |
| Recomp menu / accept | Escape / Return |

Input labels are native buttons; confirm the action in the visible game before
automation. Default binding files are generated inside the isolated profile.

## Warp and command-line limitations

`main.cpp:558-604` ignores argv except Windows `--show-console`. There is no
verified CLI ROM import, start-room or warp option. Debug logging controlled by
`GOEMON64_DEBUG_LOG` is compiled only without `NDEBUG`; ordinary shell capture
does not rely on that optional code.

The bundled debug menu has Region/Scene/Entrance controls and `do_warp` calls
`src/game/debug.cpp`. However, a complete `rg` search of source, patches and
runtime found only the declaration and host definition of
`recomp_get_pending_warp`, no native patch consumer. Additionally `do_warp`
masks the selected scene ID to eight bits, which cannot represent room465.
Treat this UI as unverified. No trusted direct warp mod was activated or added.
Use the ordinary new-adventure route for the first test.

## User gameplay checks still required

1. Start the isolated baseline with an empty mods directory, import the ROM,
   reach the house normally, and record the floor, camera and player position.
2. Install the handed-off NRM in the user's chosen test profile. Record its exact
   changes and geometry alias group; this house test does not change actors.
3. Start the edited isolated root, confirm only the generated mod is enabled,
   load its own copied baseline save, and record the same view.
4. Observe shifted static geometry. Walk and jump onto the
   floor and near a wall: the player must settle on the shifted visible surface,
   remain blocked by the visible wall, and avoid falling through.
5. Leave/re-enter the room and load the same test save again; inspect aliased
   rooms if reachable. Check logs for rejected preimages or unresolved resources.

A screenshot alone proves appearance, not collision. Record movement/landing
or a video and a reproducible baseline comparison. Successful package loading
and room reload are separate checks from a MIPS build. Windows gameplay and
Intel Mac gameplay need their own runtime verification.

## Display-list inventory for strict parsing

A fresh Python read-only traversal of the canonical decompressed ROM examined
all 371 unique graphics slots with the verified six array lengths. It traversed
369 nonempty primary roots and three nonempty secondary roots (372 total), with
depth64, 200,000-command per-root budget and resource-file bounds; no failures.
The other 368 secondary records contain empty type4 sentinel `0x40000000`.
No primary and secondary roots had identical pointers.

Observed opcodes: `03,04,B1,B6,B7,B8,BA,BB,BC,BF,E6,E7,E8,F0,F2,F3,F5,FA,FC,FD`.
`03` MOVEMEM only used subtype `8A`; `BC` MOVEWORD only used subtype `02`.
Vertex loads totaled 15,222; TRI2 commands 57,462; TRI1 commands 1,183. These
are traversal totals, not deduplicated source-command counts.

Primary and secondary models share the primary graphics record's resource IDs,
but static collision is one room-level plane/tree pair, not separate collision
per model. The mapper does not establish a geometric correspondence between
visible triangles and collision planes. Deduplicate vertices by physical source
span and collision planes by plane index before translating; compare complete
source sets across room aliases. Use a narrow semantic allowlist, reject unknown
commands/subtypes, and do not infer safety merely from a rendered partial mesh.

The material pointer at primary/secondary `+4` was checked separately: 372
nonzero references across 371 slots use twelve unique resident main roots in
`8006D9F0..8006DC70`; the other 370 are null. Bounded recursive traversal found
only `06,B6,B7,B8,B9,BA,BC,E7,F8,F9,FA,FC`, with MOVEWORD subtype 08 (fog).
There were no vertex loads, matrix commands, modified vertices or segment-base
changes. Thus canonical materials contribute render state, not additional XYZ
sources. This does not establish compatibility with replacement materials.

Fresh native consumption checks in main `800196F0_1A2F0` and
`80035A5C_3665C`, and File11 `801F95D8/8C4C/87F8`, found writes to task render
objects, binding globals and frame command buffer `D_8015C5CC`. The renderer's
material-copy branch relocates copied commands in the frame buffer, preserving
source lists. These paths do not fix segmented room commands or plane/tree
records in place. This is evidence for the reviewed canonical consumers, not
a proof that every unrelated room callback or mod leaves a resource immutable.

## Commands and tools used

Read-only commands: `rg`, `nl`, `sed`, `plutil -p`, `file`, `otool -L`, filtered
`strings`, `nm -gU`; bounded Python aggregate ROM traversal; current importer
invoked through `node --import tsx` to print counts/provenance summaries only.
Ghidra MCP tools: discovered tool metadata first, then `decompile_function` and
`get_xrefs_to`, with explicit `mnsg_main_static.elf` program identity. Fresh
decompiles included `8000B640`, `8000B2A0`, `80002DE4`, `80005EDC`, `80002AB8`,
`8000B5D0`, `8000383C`, `800141C4`, `80014840`, `80013B14`, `800142BC`,
`80001E50`, `80001DF4` and the pure file-metadata accessors around `80001D68`.
No native callback was executed. No copyrighted asset bytes appear in this doc.
