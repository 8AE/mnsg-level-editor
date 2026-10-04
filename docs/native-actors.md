# Native actor models

This research establishes the US ROM path from a placed actor to its display resources. It does not establish that every placed actor is visible in every save state. Constructors may delete themselves, create children, wait for progression flags, or change their model later. The editor must distinguish a verified model declaration, an unresolved visual, and a verified controller without a primary mesh.

The pinned decompressed ROM SHA256 is `e40bee20508c2e29e651dca4e47504e40f908f0a2186e34a582784bf5a64be4c`. Asset bytes are read locally from the user's ROM; none are included in this document or repository.

## Identity domains and constructor dispatch

The actor ID in the 16-byte definition selects native behavior. It is not a mesh number. Four distinct values must remain separate:

| Domain | Native source | Meaning |
| --- | --- | --- |
| Placed actor ID | Definition `u16 +0` | Constructor/scheduler identity. |
| Code overlay | ROM `0x5E4CA6 + actorId*2`, signed 16-bit | File containing the actor's behavior. Zero selects common resident code. |
| Display identity | Task `u16 +0x5E` | Index into the model registry. Initially actor ID; constructors can replace it. |
| Model slot | Native binder argument | Selects a display list or animation-tree record within that identity's resources. |

The initializer table is `D_802287BC_5E3C8C`: `u32` at ROM `0x5E3C8C + actorId*4`. For overlay zero, resident File 12 uses `ROM = PC - 0x8020D2A0 + 0x5C8770`. For positive overlay `n`, segmented code uses `ROM = file[n].start + (PC & 0xFFFFFF)`, with the one-based file table at `0x57FD4 + n*4`.

The native actor census contains 255 actor IDs, 3,888 placements and 3,476 distinct combinations of identity, parameters, position and rotation. The overlay table has 58 values, including zero for 1,218 placements. Zero overlay does not mean the actor lacks a model. Only 148 placed actor IDs have their own nonzero model-registry entry, covering 1,959 placements; other constructors can select a different identity.

Sources: local API pages `D_802287BC_5E3C8C.md`, `D_802297D6_5E4CA6.md`; fresh Ghidra `func_8003555C_3615C`, `func_80034B58_35758`, `func_80218A54_5D3F24`. The shared API's label “model ID” for the signed overlay table is misleading for mesh extraction.

## Synthetic startup state

The native constructor receives `a0=task`, `a1=primary display object`. This is the initializer ABI; a function found at the same runtime address in a different overlay is a different function.

`func_80034A10_35610` clears the task fields through `+0xEC`. `func_80218A54_5D3F24` then copies the room definition and instance:

| Destination | Storage | Source or initial value |
| --- | --- | --- |
| Task `+0x5C/+0x5E` | `u16` | Actor ID. |
| Task `+0xD0/+0xD4/+0xD8` | `u32` | Definition words `+4/+8/+0xC`. |
| Object `+8/+0xC/+0x10` | `f32` | Signed 16-bit XYZ converted to float. |
| Object `+0x14/+0x16/+0x18` | `s16` | Raw instance rotation copied unchanged. |
| Object `+0x1C/+0x20/+0x24` | `f32` | Allocator's default `0.1`, ROM `0x5F4FCC`. |
| Object `+0x28` | `f32` | Animation progress; initially zero. |
| Object `+0x30` | Tagged pointer | Default material context `0xC006D920`. |
| Object `+0x68/+0x6C` | `f32` | `2.5`, `10`. |
| Task `+0x60/+0x64` | `u32` | Zero before constructor-specific flags. |

`func_80217144_5D2614` sets task `u16 +0x4E=2`, `+0x50=40`, `+0x52=0`, `+0x3C=100`, `+0x3E=160`, `+0x40=0`; `u32 +0x48=-1`, `+0x34/+0x38=0`; byte `+0x4C=1`, `+0x44=0`, `+0x98=10`, `+0x99/+0x9A=5`, `+0x9B=0`, `+0x8D=1`. The room initializer additionally sets `+0x70=0`, byte `+0x75=25`, byte `+0x76=20`, `u16 +0x96=1`, `u16 +0x22=1`, and generation/state fields.

A bounded offline interpreter may seed these values. Player position, save flags, collision results, random values, allocation failures and scene-controller state must remain explicit unknowns unless a preview policy supplies them. Returning zero for every unknown helper falsely selects gameplay branches.

## Model registry and binders

`D_80236984_5F1E54` is a `u32` pointer table indexed by display identity. Each entry points to a descriptor with at least these fields:

```c
struct ModelDescriptorPrefix {
    uint32_t file_pair_pointer;       // +0: points to u16 file8, u16 file9
    uint32_t model_slots_pointer;     // +4: points to u32 modelSlots[]
    uint32_t texture_sequences;       // +8: pointer table of texture sequences
};
```

The file pair is indirect. Treating the descriptor's first two halfwords as file IDs produces plausible but incorrect values. Descriptor and slot-table pointers are resident File 12 addresses. The selected model pointer may be segmented into its loaded model resources.

| Function, runtime / ROM | Selection and effect |
| --- | --- |
| `8021664C / 5D1B1C` | `(task, slot, f32 step, u8 loop)`; identity from task `+0x5E`; object model `selected + 0x10000000`. |
| `80216CE0 / 5D21B0` | `(task, object, slot)`; same identity; direct model `selected + 0x40000000`; preserves scale. |
| `80216DF8 / 5D22C8` | Direct binder on task's primary object. |
| `80216E1C / 5D22EC` | Resets all scales to `0.1`, then direct binder. |
| `80216ED0 / 5D23A0` | Direct binder, scale `0.1`, identity from the complete word at task `+0xD0`. |
| `80216FFC / 5D24CC` | `(task, explicitIdentity, u8 slot)`; direct binder, scale `0.1`. |
| `80221C0C / 5DD0DC` | Animated-binder wrapper plus task animation-step storage. |
| `80216E54 / 5D2324` | Allocates one linked direct display object; scale `0.1`. |
| `80216838 / 5D1D08` | Allocates a linked animated object and copies primary transform, scale and material. |

The animated binder stores step `floor(step*256)` in object signed `+0x7E` (negative input becomes `-1`), loop byte at `+0x7C`, and progress at `+0x28`. Normal initial progress is zero. Task flag `0x01000000` selects animation length minus one for reverse playback.

Binders store file IDs at object `+0x34/+0x3C`, common resource `0x152` at `+0x44`. If the first file equals the second file or common resource, native code clears `+0x34`. `func_80014218_14E18` walks six `(u16 fileId, u32 base)` pairs spaced eight bytes apart, matches each resource's actual segment, and stores registry base masked with `0xBFFFFFFF`.

Fresh disassembly was required for `80216FFC`: the existing Ghidra decompiler mistakenly included it in the preceding function. Its actual prologue is at `80216FFC`; instructions at `80217024–80217050` explicitly index the registry by `a1`, then the slot table by low eight bits of `a2`.

## Texture state, extra segments and linked objects

`func_8021A764_5D5C34(task, pointer, index, source)` writes the base at object `+0x38 + index*8`. Source 2 uses segment 8, source 1 segment 9, source 0 segment A. Indices 3/4/5 provide segments B/C/D, often used for NPC expressions. Preserve these address bindings when decoding textures; using only model files loses faces and expression pages.

`func_80224ABC_5DFF8C` initializes a texture sequence through `80224560 / 5DFA30`. It follows descriptor `+8[sequence]` to a sequence whose first word is the initial image pointer. The chosen target segment defaults to B. Source base is A if task flags `+0x60 & 8`, otherwise 9 if `&0x10`, otherwise 8. Speed/loop fields and later updates advance the sequence; a static preview uses the initialized first frame and reports animation limitations.

`func_80224CE0_5E01B0` stores NPC expression pointers at task `+0x90/+0x9C/+0xA0`, binds animated slot zero, and initially binds segment B to the first expression pointer in segment 8.

`func_80219E70_5D5340` creates a linked shadow display: it temporarily changes display identity to 1, binds slot zero on a new object, then restores the original identity. This is not a no-op collision helper. A preview may intentionally omit the shadow, but must preserve its native allocation distinction from the primary model and other linked displays.

`func_8021A26C_5D573C` and `func_8021DEC4_5D9394` generate material display lists inside the object. They set object kind byte `+5=7`, material sequence `G_DL`, `G_SETENVCOLOR`, `G_ENDDL` at `+0x80…+0x94`, and return object `+0x80`. They can change visible color/alpha.

`func_80035EEC_36AEC(task, s16 kind, u8 count)` allocates linked objects: task `+0x18` is the primary, `+0x1C` the tail, object `+0` the next pointer. `func_802171A8_5D2678(parent, childCallback, u8 category)` creates a separate child task with copied parent position and angles, fresh scale `0.1`, default material, and inherited actor bookkeeping. Child task visuals must not be mistaken for the parent model.

## Hierarchy, angles and initial pose

Upstream `Goemon64Recomp/patches/types.h:119` defines 24-byte `Skeleton` records:

```c
uint32_t display;                  // +0
int8_t right, left;                // +4,+5: signed offsets in 24-byte records
int16_t scale[3];                  // +6,+8,+A: native selector, output /256
int16_t rotation[3];               // +C,+E,+10: native selector, period 1024
int16_t translation[3];            // +12,+14,+16: native selector, output /32
```

`AnimatedSkeleton` starts with flags `+0`, animation-stream pointer `+4`, then a variable pointer list at `+8`. Selectors must be decoded using native `8001A8E4`, `8001AABC`, `8001ADBC` and compressed-stream reader `8001B2C8`; treating every signed halfword as a literal collapses animated limbs.

Upstream `patches/anime.c:94–228` proves header pointer groups: bits 28–30 count camera/projection records (`800176F0`), bits 24–27 count light records (`800182DC`), bits 8–22 count geometry trees. These groups are **not an animated vertex prepass**. Geometry pointers follow camera and light pointers. A decoder that rejects nonzero groups must name the actual unsupported records.

Type zero applies root TRS; type `0x10000000` skips root TRS and transforms children. Native type `0x60000000` uses a mutable object tree for interpolation: `80018B28 / 19728` draws root display without root TRS, then creates/transforms children through `80018CA0 / 198A0`. First-pose extraction with interpolation progress zero can evaluate the child selectors without replaying scene callbacks. Other mutable pose state must remain unsupported or explicitly approximated.

A node display with bit `0x10000000` points to a linked 24-byte record. Native `80018718 / 19318` and `80018908 / 19508` draw that linked root display using the inherited matrix, then traverse its children. They do not apply the referenced root's TRS. Ordinary display pointers are masked `0x8FFFFFFF`; the linked-root branch delegates raw root display to the native display-list renderer. Sources: `patches/anime.c:450–475,520–555` and fresh Ghidra bodies.

Object rotations use a 1,024-unit revolution. `0x8000` is a signed sentinel, not an ordinary half turn. `80019D40 / 1A940` adds a camera-facing alignment when any object angle equals `-32768`; all three sentinels yield full billboard alignment. The shared API page for room initializer currently describes a 65,536-unit revolution; the renderer contradicts that description.

Bone rotation flag `0x4000` requests additional camera alignment. `800192D0 / 19ED0` pushes ordinary node TRS, then an inverse matrix from the selected **model object angles** (`801689F0/F2/F4`, written by `8001E2BC`) for flagged axes, then `guAlignF` using the negative camera-back vector (`80168980/84/88`). `8001B6D4` writes camera position minus look-at; `8001C7E4` rotates this vector by camera-object angles. Thus the alignment input is the corresponding masked look direction. Direction X is enabled by Y-or-Z flags, direction Y by X-or-Z, direction Z by X-or-Y. Traversal pops these extra matrices around the flagged node. This requires the editor camera at render time; a fixed arbitrary matrix cannot reproduce all views.

## Representative verified declarations

These are constructor paths, not arbitrary guesses from registry slot zero. `subtype` is the high byte of payload word zero unless stated otherwise.

| Actor | Native source | Display selection | Initial scale / notes |
| --- | --- | --- | --- |
| `0x064` | Common `80213F20 / 5CF3F0` | Direct object root from `80231FC4 / 5ED494[params0]`; file8 from `80231F80 / 5ED450[params0]`, file9 `181`, A `152` | Scale `10.0`; bypasses registry binders and commits through `80014218(object)`. |
| `0x082` | Common `80214654 / 5CFB24` | Identity 1, direct slot 4 | `0.1` subtype 0, `0.05` subtype 1; all angles `8000`. |
| `0x084` | Common `80214A34 / 5CFF04` | Identity 1, direct slot 3 | `0.1`, billboard. |
| `0x085/086/087` | File 26 `08000378/08000204/08000000` | Own identity, direct slot 0 | `0.1`, billboard; files `192/193/194` respectively. Progression gates some pickups. |
| `0x088` | File 26 `08000514` | Identity 1, direct slot 2 | Flag unset branch; billboard, scale `0.1`. |
| `0x089` | File 26 `08000740 / 6AEF20` | Identity 1, direct slot 1 | Flag unset branch; billboard, scale `0.1`. |
| `0x091` | File 26 `08000908 / 6AF0E8` | Own identity, direct slot zero | Flag unset branch; scale `0.02`, linked shadow and effect child. |
| `0x08B` | Common `80214BBC / 5D008C` | Own identity, direct slot 0 | `0.1`; model file `195`. |
| `0x0FA` | File 32 `08003604 / 6D26E4` | Own identity, animated slot 0 | Allocator `0.1`; loop enabled. |
| `0x0FE` | File 32 `08002734 / 6D1814` | Identity `0x0FD`, animated slot 1 | `0.1`; segments B/C point into own file at `08005520`. |
| `0x12C` | File 32 `08003E78 / 6D2F58` | Own identity, animated slot 0 | `0.1`; parameter-dependent behavior; camera-aligned bone. |
| `0x190` | File 37 `080021AC / 6E134C` | Explicit identity `190`, direct slot 0 | Constructor overrides scale to `1.0`. |
| `0x192` | File 28 `08000000 / 6B2FA0` | Own identity, direct slot 0 | Constructor overrides scale to `0.25`. |
| `0x226` | File 50 `08000000 / 70C820`, deferred `EC/3B8/644` | Own identity, animated slots 0/1/2 | `0.15`; mode high byte 0/1 selects 0, whole word 2 selects 1, whole word 3 selects 2. |
| `0x23C` | File 43 `0800000C / 6F34EC` | Own identity; subtype 0 slot 2, subtype 1 slot 5 | `0.1`. |
| `0x241` | File 43 `08002B60 / 6F6040` | Identity `240`, animated slot 0 | `0.102`. |
| `0x242` | File 43 `08001D6C / 6F524C` | Subtypes 0…11 select slots `[0,1,2,3,4,5,6,6,2,0,4,8]` | `0.1` for all reviewed subtypes. |
| `0x256` | File 43 `080038A8 / 6F6D88` | Own identity; subtype 0/1 selects slot 0/1 | `0.1`; house door. |
| `0x287` | File 56 `08000000 / 712F70` | Identity = low 16 bits of payload word 2; direct slot 0 | Constructor eventually sets scale `1.0`; generated material and multiple parameter-controlled modes. |
| `0x2C6/2C8/2CA` | File 59 `080014DC/184C/16D4` | Own identity, animated slot 0 through `80224CE0` | `0.1`; initial expression segment B offsets `28B0/19A0/1E00`. Other expression offsets are stored for later use. |
| `0x338` | File 68 `08000000` | Own identity, animated slot from payload word one | Progression gates; final scale `0.15`, step `0.25`. |
| `0x1FC` | File 44 `08001F44 / 6FD144` | `0x34`-byte table at `080032C0[params0]`: identity `u32 +28`, direct slot `u32 +2C` | Scale `0.1`; player-height branch selects absolute XYZ alternatives `+4/+8/+C` or `+10/+14/+18`. |
| `0x345` | File 43 `08005790 / 6F8C70` | Identity `312`, direct slot zero | Progression-gated; subtype changes absolute XYZ and scale. |
| `0x2D3/2D4` | File 54 `08000C18/0F18`, ROM `711278/711578` | Identity `2D1/2D2`, animated slot 0 | `0.12`; progression flag `97` controls presence. |

Room 465 contains the `256` door, `2D3/2D4` character declarations and controllers. Room zero contains `23C`, a parameter-selected `23E` variant, two `FE` actors and twenty `190` declarations. Room 376 contains two `241` doors and NPCs `2C6/2C8/2CA`.

Verified controller examples: `08E` initializes camera/start state then deletes itself (`80215A74`); `08C` is a transition trigger whose callback copies destination fields (`802151E0/80215330`); `308` waits then creates a camera controller (File 27 `20F4/2144`); `34E` checks/sets a progression flag, invokes a script and deletes itself (File 61 `98C`); `400` creates flag-dependent children with identities `132/08B/0FB` (File 61 `9F0/AC0`); `2EE` conditionally starts speech and suspends/deletes itself (`80221964/80221894`). A null model registry alone does not establish this classification.

## Bounds and remaining gaps

`8021C654 / 5D7B24` settles actors against native collision, lowering Y by three units up to twenty times while probing. The original placement Y is therefore not universally the rendered Y. An editor can show the source placement pose and label it accordingly; it must not invent a fixed floor correction.

Visibility flags, player-relative initial behavior, allocation results, emitted children, runtime expressions, later animation, procedural materials and camera-aligned bones remain separate from static model selection. Only support a declaration after its native selector and required resource/graph path are understood. Unknown calls/branches require a warning or unresolved status. Do not invoke a native damage, collision or progression callback to observe its appearance.

## Reproducible independent research census

A separate read-only research oracle imported metadata for all 3,888 original placements and interpreted bounded MIPS instructions in synthetic task/object/stack memory. Its metadata report records native declaration paths, resource files, slots, transforms, unknown calls and stopping reasons. Decoded game assets were kept out of this repository. The oracle is a research artifact, not a shipped dependency or a fallback model-selection table.

The independent census recovered model declarations for 2,391 placements, including 34 direct-write `064` declarations. It reported 1,576 raw stopping paths and no remaining opcode gaps after adding FPU status and double-conversion handling. Controller analysis explains many stops; a stop is not proof of missing geometry. **These counts are research declarations, not the application's supported visual coverage:** the oracle records unmodeled external helper calls instead of certifying their complete visual side effects. The production interpreter must have its own verified helper allowlist and explicit failure handling.

Ghidra tools actually used: `list_open_programs`, `list_project_files`, `open_program`, `import_file`, `decompile_function`, `disassemble_function`, `get_xrefs_to`. Every native call targeted an explicit program. Existing programs included `mnsg_main_static.elf`, `world_file_12_common.elf`, `world_file_26.elf`, `world_file_28.elf`, `world_file_32.elf`, `world_file_43.elf`, `world_file_50.elf`, `world_file_56_file287.elf`, and `world_file_59.elf`. Fresh private ELF wrappers preserved unmodified File 27/35/36/37/39/54/61/80 bytes at runtime base `08000000`; they were imported as `world_actor_file_<n>.elf`. The misleading old File 27 decompiler and merged `80216FFC` function boundaries were checked against fresh ROM bytes/disassembly. No game was launched and no native callback executed.


## Closure of the original placement census

The independent classification report covers all 3,888 placements and 255 IDs. It contains per-ID category counts, declared identity/slot pairs, unknown helper families, stopping reasons and native classification provenance. Manual classifications require actual native-body evidence; an unresolved external call never automatically implies absence of a display.

| Classification | Placements | Interpretation |
| --- | ---: | --- |
| Bound model declaration | 2,391 | A native selector/direct object write was observed. Required graph/material/transform support still needs production validation. |
| Verified controller without own mesh | 1,188 | Native bodies establish the behavior; emitted child displays are separate. |
| Verified conditional visual before unresolved state | 242 | The visual path is established, but save/player/trigger state controls its activation or position. |
| Remaining unresolved visual or behavior | 67 | No nonvisual assertion; explicit unsupported reason is required. |

All 2,391 declarations have numeric captured scale/rotation. Only 730 have no unmodeled external helper calls in this oracle. Numeric fields do not prove native final XYZ: collision settling, player-relative positioning, child allocation, material generation and later callbacks remain separate evidence. The production interpreter uses a different helper set and can legitimately produce different counts. Comparing counts alone does not establish model equivalence.

### Finite controller evidence

| Actor | Placements | Exact native body evidence |
| --- | ---: | --- |
| `08C` | 595 | Common `802151E0/80215230/80215330`: destination transition trigger. |
| `08E` | 286 | Common `80215A74`: camera/start state and removal. |
| `090` | 13 | Common `80215B8C`: camera/trigger table writes and removal. |
| `308` | 61 | File 27 `20F4/2144`: delayed camera manager creation. |
| `31D` | 48 | Common `80221894`: timer, speech start, suspend/remove. |
| `3CC` | 72 | Common `80215CA4`: menu/overlay objects with UI object kind. |
| `34E` | 2 | File 61 `98C`: flag/script/removal. |
| `2EE` | 10 | Common `80221964`: conditional speech controller `80221894`. |
| `193` | 30 | File 43 `1BC/21C`: gated child spawner; child display tasks have their own callbacks. |
| `400` | 1 | File 61 `9F0/AC0`: flag-dependent children `132/08B/0FB`. |
| `19A` | 10 | File 34 `6EC`, callbacks `534/594/628`: timer-driven child emitters. |
| `2DC` | 17 | File 60 `2740/26B8/1D2C`: menu/script scheduler loaded from resource `4E5`. |
| `33D` | 5 | Common `802219D4` disassembly: scene-context gate into speech controller `80221894`, otherwise suspension. |
| `3E1` | 6 | File 56 `C90/D60/DC4/EB4/F40`: distance/direction-based sound playback. |
| `35E` | 3 | File 24 `808`: timer-controlled positional sound; no display binder. |
| `19D` | 6 | File 30 `447C/4550/4594/4654`: timed child emitter; child `4694` binds identity `19D`, animated slot zero. |
| `3FC` | 3 | File 39 `1994`: proximity/timer emitter; child `15E4` binds identity `7E`, linked slot six. |
| `309` | 3 | File 61 entry zero: camera/cutscene controller; children `2FB/2F4` own their displays. |
| `288` | 4 | File 56 `292C`: two generated sprite children; sole primary callback `2C44` returns. |
| `3CB` | 3 | File 40 `1CFC`: six children; sole primary callback `1EC0` returns. |
| `149` | 2 | File 24 `1A4`: every 64 frames creates child `134`, animated slot zero. |
| `1B6` | 2 | File 46 `42F8`: every 128 frames creates child `FA`, animated slot zero near the player. |
| `3EC`, nonzero variant | 6 | File 30 `78E0/7984`: only payload word zero high byte zero binds direct slot zero. Canonical variants 1–6 have no primary binder. |

This list certifies absence of a primary mesh on these paths. It does not authorize dropping child visuals for `193`, `400`, or `19A`. `2FC` is a counterexample: File 27 `10A4` allocates a child through `F88`, then binds its own animated slot zero at step `0.25` and multiplies its scale by `1.25`. An unknown child-allocation result must not cause this actor to be classified as a controller.

### Child task and path-script semantics

`802171A8 / 5D2678(parent, callback, u8 category)` allocates through native `800358E8`, using copied parent XYZ/angles, default material, and fresh `0.1` scales. It applies `80218C28 / 5D40F8`, copying parent statistics, display/actor identities, collision/status fields and player reference; it sets child `u16 +28=FFFE`, `u32 +2C=FFFFFFFF`. Payload words `D0/D4/D8` are not copied. The parent often assigns them immediately after allocation, so child callbacks must be evaluated only after those assignments finish. Allocation-success previews need an explicit policy; actual native allocation may fail.

NPC `2BD` uses File 59 `E8/150` and common `80226840 / 5E1D10`, `802268A8 / 5E1D78`. Path initialization writes index `u16 task+C4`, instruction index byte `CF=0`, phase byte `CE=0`, timer `C6=0`, and signed home XYZ at `C8/CA/CC`. Pointers are `u32 ROM5F3E50[index]`; file IDs are `s16 ROM5F40DC[index]`. A nonzero file resolves the segmented path pointer with `80014840(pointer,fileId)`.

Verified bounded initial commands:

| Opcode | Halfwords | Initial effect |
| --- | ---: | --- |
| `0C` | 4 | Set object XYZ to signed words 1/2/3 plus signed home XYZ; advance four halfwords. |
| `24` | 5 | Same XYZ update plus raw yaw word 4; advance five halfwords. |
| `08` | 3 | Own identity animated slot signed word 1, step signed word 2 / 10, loop 1. |
| `15` | 2 | Own identity direct slot signed word 1, reset scale `0.1`. |
| `23` | 8 | Initial phase: animated slot signed word 1, step signed word 7 / 10, loop 1. Later phases select another slot and move; they are not initial preview work. |

All 13 original `2BD` placements were checked against these path tables. Path 35 starts `08`, slot 1. Paths 72/92/101/117/127/132/150/153 start `0C` then `08`, slot zero. Path 149 starts `0C` then `08`, slot one. Path 144 starts `0C` then `23`. This is parameter-selected native pose and relocation, not a universal slot-zero fallback. Other path opcodes can run gameplay logic and must remain explicitly unsupported until recovered.

### Registry and procedural-material bounds

Canonical descriptor registry `ROM5F1E54…5F2E70` contains 1,031 u32 words, indices `0…406`; the next symbol is `D_802379A0_5F2E70`. Tail entries `402…406` point to resident descriptor prefixes, while index `407` enters a distinct typed byte region. Validate each descriptor, file pair, slot pointer and selected resource; table range alone does not make an arbitrary selector safe. Initializer-table bounds differ: the gap to the overlay table is `0x101A` bytes, so it must not borrow the descriptor count. Actor `400` has a independently verified initializer; null initializer slots are invalid constructor entry points.

Actor `287` intentionally generates material commands. File 56 entry zero calls `0056C(task,08003F30)`, which forwards that overlay scratch address directly to `80220A60 / 5DBF30` as output argument seven. This is a private material scratch region after native overlay relocation, not an immutable model asset. `20A60` writes `G_DL`, primitive color, RGBA16 texture load/tile state and end commands: 80 bytes for mode one, 136 bytes for mode two. `802209F0 / 5DBEC0` allocates 160 bytes, initializes `G_ENDDL`, then the constructor installs the allocated pointer tagged `60000000` as the object's material. An offline preview can write only its private synthetic memory and must preserve the generated material for the graph decoder. Mutating original ROM bytes or silently ignoring the helper is incorrect.

Production implementation must separately verify save-state branches, allocation-conditioned child displays, player-relative distance, procedural materials, and conditional positions. Native evidence below establishes selectors for these families but does not certify the application's helper interpreter or visual coverage. The `08C` low-address failure is not a global-pointer-register ABI issue: disassembly `80215230…8021524C` loads system context through `8015C5C8` then adds `0xCF898`. A zero context fabricated by an interpreter creates the low address; actual scene context remains unknown unless supplied by a documented preview policy.

## Initial animation frame and material state

Fresh `8001B2C8 / 1BEC8` confirms integer-frame channel sampling. The stream cursor wraps to 16 bits and starts with high byte zero. Commands below `78` contain literal low bytes with count `command & 31`: `00…1F` keeps the high byte, `20…3F` decrements it, `40…5F` increments it, `60…77` reads a new high byte. Commands `78…EF` hold one low byte: duration is zero when `(command-78)&31` is zero, otherwise that value plus two; `98…B7` decrements high, `B8…D7` increments it, `D8…EF` reads it. Commands `F0…FF` contain BE u16 literals, count low four bits. A zero count supports open-ended frame indexing; it is not an end command. Crossing a u16 block retains the last literal's high byte. A frame equal to duration proceeds to the next command.

`8001B5AC / 1C1AC` returns animation header low-eight-bit length. Animated binder `8021664C` uses progress `length-1` when task flags contain `01000000`. Two original `3D6` placements, rooms 362 and 386, set this flag before binding slot zero, resource 592, length three: their initial frame is **two**, not zero. Encoded selector bit `8000` independently forces channel frame zero. The private oracle records `taskFlagsAtBind` and preserves these last-frame initial values; the initial frame-zero implementation was corrected after this independent census. Fractional animation interpolation and cached pose blending remain separate from the verified integer-frame sampler.

Fresh `800196F0 / 1A2F0` establishes material lifecycle: `80016C44` resets global `80168524` once per object; the first display call sets object segments, applies object material, then sets that global to one. Later limb/root displays preserve RDP state rather than reapplying the material. `80016AA4` sets up lighting, not object material. Generated-material bit `20000000` copies commands to the output list with pointer fixups; it does not mutate source commands during rendering.

Actor-only color combiners were decoded from SDK `libultra/include/PR/gbi.h:2851` and RT64 `src/shared/rt64_color_combiner.h:566`. For every cycle, RGB and alpha use `(A-B)*C+D`. RT64 executes mux cycle one for one-cycle mode, and cycles zero then one for two-cycle mode. The latter also changes texture input selection; the active OtherMode and tile states must accompany the mux pair.

| SETCOMBINE pair | RGB | Alpha |
| --- | --- | --- |
| `FC629AC5 / FF34FE7F` | Environment + Texel0 | Texel0 alpha × environment alpha |
| `FC629AC5 / FF37FFFF` | Environment | Texel0 alpha × environment alpha |
| `FC62FEC5 / FFFDFAFD` | Environment + primitive | Environment alpha |
| `FC121624 / FF2FFFFF` | Texel0 × shade | Texel0 alpha × primitive alpha |
| `FC327E64 / FFFEFB7D` | Primitive × shade + environment | Environment alpha |
| `FC567E04 / 1FFCF3F8`, cycle zero | `(environment − Texel0) × environment alpha + Texel0` | Texel0 alpha |
| Same pair, cycle one | Combined × shade | Combined alpha |

The canonical triangle census for these six new pairs establishes one-cycle mode for all rows except `FC567E04 / 1FFCF3F8`, which uses two-cycle mode. All reviewed render tiles are zero; tile one is uninitialized, and the two-cycle pair consumes combined color rather than a second texture. These are canonical census facts, not a rule for arbitrary modified display lists.

Additive environment color cannot be reproduced by an ordinary texture-multiply material. Texture pixels, environment/primitive colors, alpha and lighting policy must be represented explicitly. These expressions do not assert pixel-identical N64 filtering, fixed-point wrap/clamp or native lighting.

The save predicate is main `800240DC / 24CDC`, not a File 12 function at `802240DC`. It reads bit array `8015C608` and returns the **masked bit**, not a normalized boolean: for canonical nonnegative index, `array[(index/8)&FF] & (1 << (index&7))`. It does not write save state. Possible preview alternatives may use coherent per-flag assignments with explicit branch provenance; they do not establish the user's actual save state or permit invented player/context pointers.


Additional Ghidra evidence read during census closure: explicit `world_file_12_common.elf` bodies `80213F20`, `802171A8`, `80217360`, `80218C28`, `80219E70`, `8021DC14`, `8021A644`, `802209F0`, `80220A60`, `80221894`, `80221964`, `80221B48`, `80221A90`, `80226840`, `802268A8`; explicit `mnsg_main_static.elf` bodies `80001C00`, `80001E50`, `80013B14`, `800141C4`, `800142BC`, `800144E8`, `80014840`, `800148F0`, `80016AA4`, `800196F0`, `8001A8E4`, `8001B2C8`, `8001B5AC`, `800240DC`; disassembly `80014218`, `80215230`, `802209F0`; overlay bodies File 43 `1BC/21C/5790`, File 44 `1F44`, File 34 `534/594/628/6EC`, File 56 `0/56C/948/C90/D60/DC4/EB4/F40/1294`, File 60 `26B8/2740/1D2C`, and fresh File 27 `F88/10A4`. Function addresses are kept together with overlay identity throughout this document.


File 68 actor `338` uses distinct flag conditions: at least one of progression flags `2A/2C/2B` must be set; when original payload word two is zero, its own flag from original word zero must be unset. It then allocates one byte through `800148F0`; allocation failure removes the actor. Uniform all-set/all-clear flag experiments miss this permitted path. The native source establishes the conditions; preview branch assignments are never the user's save state.

Native `80035A5C / 3665C` writes material pointer from argument `a2` directly to object `+30`. It supplies no implicit default. Callers commonly provide `C006D920`; linked direct binder `80216E54` explicitly supplies it, and animated linked binder `80216838` copies the parent material. A genuine zero material emits only a pipeline sync in `800196F0`, preserving inherited scene RDP state. A static decoder must report that boundary or recover the specific caller's omitted material; it cannot invent a universal combiner. Additional pair `FC121A24 / FF36FF7F` decodes to RGB `Texel0 × shade + environment`, alpha `Texel0 alpha × environment alpha`; cycle-state verification remains necessary.


## Additional native closure and first-frame boundaries

Fresh explicit-program Ghidra decompilation reduced the independent census's unknown category from 185 to 67 placements. The newly certified visual branches below remain conditional declarations until production verifies their helper calls, graph parts, material dependencies and transforms. A child manager is classified by absence of a **primary** mesh, never by absence of all rendered children.

| Actor | Native entry / ROM | Verified initial declaration and unresolved state |
| --- | --- | --- |
| `2FC/2F6/302/306/307` | File 27 `10A4/1128/11AC/176C/14B0` | `F88` allocates a child, then each binds own animated slot zero, step `0.25`, loop one, multiplies current scale by `1.25`. Children have separate callbacks `1A54/1B5C/1BEC/1D14/1C78`. |
| `2D8/2D9` | File 59 `524/4B8`, ROM `71BFA4/71BF38` | Flag `18` gates identity `2BF/2C1`; deferred `284/3FC` calls `21B48`, then `24CE0`, animated slot zero. Expression tables: `08001DB0/2DB0/3DB0` and `08001710/2710/3710`. |
| `147` | File 36 `41C`, ROM `6DA2EC` | `8021B73C(task,300.0)` tests squared player distance. Near branch binds own animated slot zero, step `0.25`, loop one before player-relative aiming and a child allocation. Far branch leaves no model. |
| `10C` | File 36 `213C`, ROM `6DC00C` | Registers callback table `08004EB0` with `8021B064`, then `8021B09C(task,0,1)` chooses by player distance and home bounds. Callbacks `2274/2734/2900/2ABC` bind animated slots `2/0/0/6`; thresholds are `35/140/250`. No fabricated player reference is valid. |
| `104` | File 35 `28DC`, ROM `6D882C` | Deferred `2974` creates two child actor `10F` tasks, then binds own animated slot one, step `1/3`, loop one. |
| `3DE` | File 80 `46C`, ROM `73D83C` | Arena-success branch creates `B54[params0]` linked objects, identity one, initial slot six. Caller replaces graphics IDs/root with resource `152` and `base+6980` / `4A000640`, kind four, positions from `B3C[params0]`, scale `BFC`, angles `8000`, generated material `20ED0`. Post-binder writes are essential. |
| `28D` | File 56 `1FE0`, ROM `714F50` | Arena-success branch changes identity to `28C`; deferred `20C0/2324` creates 18 linked slot-one objects, scale `0.3`, billboard angles. Positions depend on native random samples and authored center coordinates. |
| `289` | File 56 `2E24`, ROM `715D94` | Arena-success branch creates three linked slot-zero objects, kind seven, scale `params0/100 + params1/100 × phase`, with phases `60/120/180`; generated materials `20ED0`. |
| `1FE` | File 44 `2E28`, ROM `6FE028` | Payload flag and progression `1A4` gate identity `1F9`, animated slot two, step zero, scale ten; emitted child has its own declaration. |
| `228` | File 44 `2600/26D0`, ROM `6FD800/6FD8D0` | Event predicate `80023E94` gates initialization. Byte `D9`, payload word two bits 16–23, selects identity/slot: `0→1F4/0`, `1→1A0/0`, `2→1F9/2`, `3→3E2/0`, `4→1F4/0`. Scales are ten, two, one, one, ten. `26E4` disassembly verifies `lbu a1,0xd9(a0)`. |
| `30A` | File 27 `295C`, ROM `6B1D6C` | Flag `98` selects first/last initial frame of own animated slot zero; step zero. Last-frame flags must reach the graph sampler. |
| `23D` | File 43 `3038`, ROM `6F6518` | Payload word zero high byte selects identities/slots `23C/2`, `242/7`, `242/1`, `3D7/direct0`; flags `1C2/1C3` gate variants three/four. |
| `339` | File 30 `4AF4`, ROM `6C4244` | Flag `32` unset binds identity `24F`, direct slot four, scale one, raw yaw `37F`, absolute XYZ. |
| `31E` | File 27 `9D8`, ROM `6AFDE8` | Room `1B0` plus progression flag `17` removes the task; otherwise identity `31B`, animated slot three at step `0.25`, loop one through `221C0C`. |

`8021B064 / 5D6534(task, callbackTable, u8 mode)` stores table at `+9C`, mode at `+A8` and signed truncated home X/Z at `+A0/+A2`. `8021B09C / 5D656C(task, distanceMode, forceSelection)` reads player reference `+84`, computes squared XZ or XYZ distance, checks home/collision boundaries, then schedules a table callback with `8003521C`. This helper changes the initial model through a deferred callback; treating it as a visual-safe no-op loses authored enemy models.

`80217360 / 5D2830(parent,u16 actorId,u8 category)` allocates at parent XYZ/angles or zero XYZ if no parent object, using default material `C006D920` and scales `0.1`. It selects the child's actual initializer and overlay from the two actor registries, applies `18C28`, and sets both actor/display identity to `actorId`. As with `171A8`, execute the child only after the caller finishes its field assignments.

### Raw allocator and object setup ABI

Fresh main decompilation plus `800358E8…80035960` disassembly establishes:

```c
Task* func_800358E8_364E8(Task* parent, void* callback,
    u32 graphics, u32 material, float x, float y, float z,
    u16 angleX, u16 angleY, u16 angleZ,
    float scaleX, float scaleY, float scaleZ,
    u16 graphicsFile, u16 materialFile);
Task* func_80035A5C_3665C(Task* task, u32 graphics, u32 material,
    float x, float y, float z, u16 angleX, u16 angleY, u16 angleZ,
    float scaleX, float scaleY, float scaleZ,
    u16 graphicsFile, u16 secondaryFile, u16 materialFile);
```

For `358E8`, entry-stack offsets `10/14/18` contain XYZ; `1C/20/24` angles; `28/2C/30` scales; `34/38` file IDs. `357BC` calls `34CBC(parent,callback,2,graphicsFile)`, then `35964`; `34D24` orders task links. `34B58/34A10` reset the task, set `+C` callback, `+20` parent depth plus one, `+28` graphics file, `+2C=141C4(graphicsFile)`. `35DFC` creates kind-two object and sets both task `+18/+1C`. This raw path does **not** call `18C28` and does not inherit arbitrary parent status/payload fields.

`35964` writes object graphics/material at `+2C/+30`, XYZ `+8/+C/+10`, raw angles `+14/+16/+18`, scales `+1C/+20/+24`, graphics/material file IDs at `+34/+3C`; secondary file `+44` comes from native scene context `+C2D90`. `35A5C` instead writes all three resource IDs from arguments. Both clear `+4C/+54/+5C`, call `14218(object)` for segment bases, and reset object state `+64/+65/+74/+78/+7C/+7E/+28/+68/+6C/+70`. A preview cannot silently invent the scene secondary file when a graph references that segment.

### Generated actor material's first frame

Actor `287` constructor File 56 entry zero builds scratch material through `0056C(task,08003F30)`, allocates a 160-byte END-only buffer via `209F0`, stores it at task `+D4`, and installs that buffer as object material. Deferred callback `00534` calls `0056C(task,task+D4)` **before** `00978` advances UV offsets. The constructor snapshot's END-only material is real native staging, not a missing default combiner. A bounded first-material-frame preview can evaluate only the verified builder stage, retaining the original UV phase; it must not execute the later gameplay callback to obtain appearance.

Generated pair `FC1115FF / FFFDFE3B` decodes via SDK `gbi.h:2851` and RT64 combiner selectors to cycle-zero RGB `Texel0 × Texel1 + primitive`, alpha `Texel0.a × Texel1.a`; cycle-one RGB `combined`, alpha `primitive.a`. In two-cycle mode this requires two actual texture inputs. It is not texture-times-shade or ENV alpha. Cycle mode, both tiles, TMEM addressing and signed wrap/clamp behavior must be checked before supporting it.

### House NPC height evidence

House room 465 source positions for `2D3/2D4` are Y `-40`. Fresh File 54 constructors `C18/F18` bind identities `2D1/2D2`, animated slot zero at step `0.5`, scale `0.12`, then call native ground settling through `21A90`; flag `97` controls presence. Deferred `CCC/FCC` handles interaction and a slot-zero rebind. No upward rise stage was established in those bodies. The current read-only service probe returned zero model position offset and zero root Y translation; local mesh Y bounds were `0…202` and `1…198.71` before the actor scale. These are constructor/source-pose facts, not final gameplay floor placement. A screenshot below the floor does not prove a scalar decoder error or justify a guessed settled height.

Additional exact tools used for this closure: `import_file` on private unmodified File 35/36/39/80 ELF wrappers; `decompile_function` against `mnsg-actor-native-census-file-35.elf`, `-36.elf`, `-39.elf`, `-80.elf` and existing explicit File 24/27/30/40/43/44/46/56/59/61 programs; `disassemble_function` at File 44 `080026D0` and main `800358E8`, `80035A5C`. Metadata-only classification was regenerated independently. `create_function` at fresh File 27 `080009D8` established its missing function boundary before decompilation. No native callback or game process was executed.

## Editor 0.2.2 TEXGEN implementation

The renderer now carries original signed vertex-normal bytes and the TEXGEN mode, texture
scales, LookAt state and load-root identity captured when VTX loads. It computes generated
coordinates per vertex through the verified model transform, then applies the tile origin,
shifts and wrapping. It does not normalize the raw signed normal or substitute reconstructed
face normals.

Slicer's first timed child now has eight textured triangles using the File384 32 by 64 RGBA16
bitmap. The bounded decoded corpus contains five unique TEXGEN assets: Slicer and actor 0x08A's
selected identity 0x314, slots 1, 2, 4 and 5. Together they contain 448 triangles, 432 with
generated coordinates. Seventeen canonical displayed parts contribute 1,172 generated-coordinate
triangles. These counts cover the decoded assets and initial parts, not later animation.

Unknown inherited LookAt state uses a labelled conditional editor-camera basis. A complete
explicit native MOVEMEM pair uses its decoded signed-byte axes. Partial or invalid LookAt, mixed
vertex modes/scales and unsupported load/draw root combinations keep the affected appearance
untextured. Model geometry remains visible. The exporter rejects flattening generated actor
coordinates into a static custom-door appearance.

The historical 0.2.2 metadata-only census reports 361 library candidate IDs: 74 supported,
170 conditional,
11 nonvisual and 106 unresolved, including seven partial previews. It contains 497 parts and
26,267 triangles: 22,911 textured and 3,356 untextured. For 255 IDs with canonical placements,
it reports 54 supported, 152 conditional, 11 nonvisual and 38 unresolved, with 451 parts and
23,944 triangles: 21,136 textured and 2,808 untextured. Library scene hints can differ from
canonical placement state. Actor status and offline CPU/export admission remain unchanged by
this texture work.

The fresh census confirmed unchanged normalized ROM bytes and actor statuses. The
analytical/texture/actor suite passed 16 checks; eight native actor and thumbnail checks passed
with no page/console errors. Those checks cover native normals, hierarchy, per-draw matrices and
the decoded TEXGEN examples. Read the [validation
record](../README.md#package-and-validation-status) for source, authoring, package and
installed-app results. No generated mod or native game was run.


## Scoped loader previews and metadata controllers

The loader preview reconstructs a cold native resource checkpoint for actor 0x24C in room 306
and actor 0x35C in room 193. An authored preview must use the matching template room. Both rules
require three zero payload words and a zero retained definition halfword; other contexts remain
unresolved. The decoder follows the immediate native child constructors and retains their
absolute position, yaw and scale.

| Actor | Immediate preview | Scope |
| --- | --- | --- |
| `0x24C` | Identity `0x1AF`, File484 + File338, 78 triangles; identity `0x317`, File690 + File338, 92 triangles | Flag 0x99-clear branch in donor 306; alternate File70 scene remains unresolved |
| `0x35C` | Identity `0x359`, File572 + File338, two textured triangles using one bitmap | Donor 193; first native texture-sequence image through segment B at File572 + `0x110` |

Both results remain conditional with raw initializer `completed=false`. The ordered registry
contains 29 IDs before 0x24C's children and 30 afterward; 0x35C's checkpoint grows from 22 to 36.
These counts describe the reconstructed cold postcallback checkpoint. Earlier tasks, resource
trimming and hot visits can change live occupancy. The decoder does not simulate transient
scratch pressure or later cutscene, motion and physics callbacks. These previews do not admit
foreign-room exports or establish native fog, sorting and framebuffer parity.

Three guarded metadata classifications add markers without evaluating native instructions:

| Actor | Native role | Resource evidence |
| --- | --- | --- |
| `0x23B` | Registered no-op, File43 `080022FC`; its 12-byte body saves arguments and returns | Static `verified-controller-closure` for File43 |
| `0x35E` | File24 spatial-sound controller with a persistent countdown and source-object pointer | Classification only; no export resource-closure proof |
| `0x1BF` | File30 camera/scene controller affecting existing player animation and speech/UI | Classification only; no export resource-closure proof |

All three raw initializer results keep `completed=false` and `instructionCount=0`. The separate
0x23B resource contract certifies its finite empty constructor; it does not assert CPU execution.
The other two classifications supply no `proofKind` or export admission. None owns an intrinsic
world mesh. Keep their live audio, camera, player and UI effects; a nonvisual marker does not
remove those behaviors.

The guards check the supported normalized ROM, initializer/overlay identity, body and callee
bytes, file bounds, allocation extent and empty parts tables. Changed or truncated evidence
remains unsupported. Read the [native loader and controller proof](
native-room-authoring.md#scoped-loader-and-controller-implementation) and [material evidence](
native-textures.md#loader-child-materials) for the checkpoint and appearance limits.


### Version 0.2.3 coverage

The fresh census reports 361 library IDs: 74 supported, 172 conditional, 14 nonvisual and 101
unresolved, including seven partial previews. Its 500 parts contain 26,439 triangles: 23,050
textured and 3,389 untextured. For 255 IDs with canonical placements, it reports 54 supported,
154 conditional, 14 nonvisual and 33 unresolved, with 454 parts and 24,116 triangles: 21,275
textured and 2,841 untextured.

Exactly five IDs changed status from 0.2.2: 0x24C/0x35C became conditional and 0x23B/0x35E/0x1BF
became nonvisual. ROM bytes and native room coverage stayed unchanged. Read the [validation
record](../README.md#package-and-validation-status) for revision-specific checks. Neither census
establishes later visibility or export admission for each candidate.


Four actual Electron/GPU checks covered both scoped native placements and their real library
cards. They confirmed 0x24C's 170 triangles with 137 textured and 0x35C's two textured triangles,
restored exact pixels after texture toggles, and preserved ROM/profile data with no page,
console or child-process errors. The raw completion and later-gameplay boundaries above remain.
