# Development roadmap

The 0.3.0 source retains version 2 room authoring: blank rooms, native
clones and editable replacements; mesh, vertex and face editing; native asset
placement; collision generation; entrances, custom doors and sky selection.
It adds a resizable six-pane workspace with native popouts, portable project mod settings and
bundled offline C/H/NRM builds. Local workspace and ARM64 candidate checks passed;
native packages/builds passed on all three hosts. Normal-profile interaction, physical Intel GPU
and Intel/Windows own-ROM acceptance remain partial.
The [authoring guide](room-authoring.md) covers the workflow; this roadmap tracks
its supported bounds and remaining work.

## Preview coverage

The supported US ROM contains 383 decoded room records, including 378 with
visual geometry. The 0.2.6 actor census distinguishes library seed previews from
canonical native placements:

| Census | Candidate IDs | Supported | Conditional | Nonvisual | Unresolved |
| --- | ---: | ---: | ---: | ---: | ---: |
| Library seeds | 361 | 74 | 174 | 19 | 94 |
| IDs with canonical placements | 255 | 54 | 155 | 15 | 31 |

The library contains 502 parts and 27,223 triangles: 23,834 textured and 3,389 untextured.
Its unresolved group includes seven partial previews. The canonical census contains 455 parts
and 24,508 triangles, with 21,667 textured and 2,841 untextured. These counts
cover bounded initialization and initial model declarations. Library scene
hints can differ from canonical placement state; neither census establishes
later visibility, animation or export admission for each candidate.

Native signed-normal TEXGEN previews include Slicer's
File384 texture. Unknown inherited LookAt uses an explicit conditional
editor-camera basis. Mixed vertex state, partial LookAt and unsupported
load/draw roots retain an untextured fallback. Timed Barrel and Slicer previews
stop after the first child initializer and retain incomplete CPU results.
Read [actor evidence](native-actors.md) and [texture limits](native-textures.md)
for the distinctions.

Version 0.2.3 introduced immediate 0x24C/0x35C child previews under exact donor and zero-definition
checks. Both remain conditional and incomplete for CPU/export purposes. Metadata-only
0x23B/0x35E/0x1BF classifications execute no native instructions; only 0x23B adds a static File43
controller resource contract.

Version 0.2.4 classifies five more IDs as nonvisual: empty constructors 0x079/0x07A/0x07B/0x07C
and scene controller 0x357. All retain incomplete raw CPU results and execute no instructions.
Only dynamic 0x079/0x07C gain a static File24 export resource contract. Fixed File12 readiness
and later Tsurami scene effects remain separate requirements. That metadata update left mesh
and triangle totals unchanged. Actor coverage, later live behavior and foreign-room export
closure remain incomplete.

Version 0.2.5 adds a conditional [procedural 0x07D preview](native-procedural-actor-preview.md):
one initial surface with 392 textured triangles. The native constructor fixes the surface
transform, so actor dragging and transform edits cannot reposition it. Future wave callbacks,
first game draw and foreign-room readiness remain unproved; the exporter rejects 07D. This
unplaced library candidate changes no canonical-placement count.

The 0.2.6 water increment adds a conditional [0x249 initial surface](native-water-actor-preview.md)
for The Water (Husband and Wife Rocks), with canonical placement in room 313. Its finite setup
keeps a flat 392-triangle surface and distinct native texture samples. The preview adds no
export admission: the existing original-parameter policy for room 313 or its template-313
replacement remains; changed parameters and foreign/new-room contexts reject. Future waves,
live scene readiness, wider actor coverage and later animation remain open work.

The read-only [Room initialization](room-initialization.md) section covers the finite setup
schema for 374 world metadata callbacks and nine special geometry aliases. It distinguishes
native/template provenance from an authored export resource plan. Actor-linked Events and
future scenario behavior need their own evidence.

## Development phases

| Phase | Current capability | Work remaining |
| --- | --- | --- |
| 1: Read and display | US-ROM import, byte-order normalization and decompression; textured rooms and bounded native actor parts/initial poses; actor-linked event inspection and read-only room initialization; native asset libraries and thumbnails; picking, framing, Pan/Tilt and focused WASD; conditional TEXGEN, first timed-child previews, donor-scoped 0x24C/0x35C children and bounded 0x07D/0x249 initial surfaces | Wider verified actor/helper/material coverage; later animation and spawning; native lighting, fog and filtering parity; special scenes and broader collision inspection |
| 2: Author | Version 2 blank rooms, clones and editable replacements; independent authored geometry; mesh TRS, vertex XYZ/UV/RGBA, face topology and gizmos; actor insertion/deletion and loading policy; named entrances, editable custom-door volumes/destinations and sky inheritance/None/native assets; collision generation and linked updates; undo/redo and saved/native recovery | Direct native BSP editing and richer collision visualization; native event/script editing; migration of sparse actors across original proximity cells; broader scene support |
| 3: C/H export | Sparse actor/translation patches and authored room payloads; owned geometry, copied or generated native collision, rebuilt authored proximity grids, metadata/admission, entrances, doors and sky; constructor-resource checks, guarded controller contracts and dependency/preimage safeguards | User gameplay validation of entry, physics, camera, progression, teardown and revisit; more verified actor/resource contexts; compatibility with mods that change native roots or allocations; arbitrary scripts |
| 4: Prebuilt `.nrm` and desktop release | Offline bundled MIPS Clang/ELF LLD/RecompModTool, per-project workspaces and 18-field metadata GUI; three native packages/builds verified, Windows installer tested | Normal-profile interaction, physical Intel GPU and Intel/Windows own-ROM checks; Developer ID/notarization and Windows signing; user gameplay regression coverage |

## Supported bounds

- **Room admission:** authored exports use ordinary-world service donors
  0 through 539 with a verified File11 geometry-group mapping. New rooms use
  unoccupied IDs 620 through 799. Replacements retain their native room ID and
  service donor. Minigame, Impact and other special layouts require their own
  verified lifecycle; an unused ID alone does not establish support.
- **Geometry and sharing:** authored rooms own their editable meshes, so clones
  and replacements can diverge from native shared geometry. Sparse integer room
  translation still updates the complete shared visual/collision source group.
  It does not move actors, entrances or camera paths. Vertex positions must fit
  signed 16-bit storage; transformed edits round to integers and reject overflow.
- **Collision:** a native clone can preserve its copied template planes and BSP
  while its visible mesh changes. **Generate collision from geometry** explicitly
  replaces that physics; linked collision can follow later mesh edits. Authored
  collision permits up to 9,362 triangles with raw face classifiers 1 through
  255 and surface values 0 through 65535. Classifier zero belongs to clipping
  planes. Visual triangles do not define the original native collision, and
  arbitrary deformation cannot infer its attributes or gameplay effects.
- **Actors and proximity:** authored rooms permit insertion, deletion and a
  resident or near-player policy. Export checks the effective roster, spawn
  order and resource context; an unresolved dependency rejects the export.
  Authored proximity grids rebuild from those placements. Sparse native edits
  preserve original list lengths and cell membership, and moves must stay in
  the verified original cell. A preview or nonvisual label does not prove a
  resource-free constructor or later script closure.
- **Runtime capacity:** native players and services share resource slots and
  task/object pools with authored rooms. The exporter checks the 48-ID registry,
  native allocation extents and its ordinary-world cache bound; project record
  limits do not guarantee simultaneous actor capacity. Read
  [export details](export.md) for memory budgets and failure recovery.
- **Events and doors:** classified native events remain read-only details tied
  to their source actors. Authored Interact/Touch door volumes and named arrival
  links are editable and exportable. They do not provide a universal native
  event table or an arbitrary scenario-script editor.

## Native work still needed

1. Extend actor and resource coverage from exact constructor, helper and scene
   evidence. Preserve supported, conditional, partial, unavailable and nonvisual
   distinctions. Keep static controller contracts separate from executed
   initializer traces and later scenario VM behavior.
2. Recover more native event families and script lifecycles. Preserve opaque
   payload words, resource pointers, save-flag semantics and callback ownership
   before adding editable fields.
3. Expand material and scene-graph handling, including unsupported vertex-load
   provenance and inherited draw state. Keep camera-basis assumptions visible;
   pursue native lighting, fog, filtering and animation parity with evidence.
4. Add collision inspection and direct native BSP tools without conflating
   visual topology with original physics. Preserve copied attributes unless
   the user chooses an explicit collision replacement. Verify winding, clipping
   and contact behavior in gameplay.
5. Broaden scene admission and sparse proximity migration through verified
   native mapping, spawn and teardown paths. Existing authored room admission
   and rebuilt grids do not establish support for unrelated native modes.
6. Have the user test generated mods through normal entry, doors, reloads and
   shared-resource visits. Include actor progression, camera state, allocation
   failure, unload/revisit and other-mod interactions in those checks.

## Project and release verification

Version 2 projects already store authored meshes, collision, actors, doors,
entrances, sky choices and sparse overrides. Version 1 migration preserves ROM
identity and sparse edits. Continue testing malformed input, bounded native
fields, shared sources, graph references and saved-state recovery. Projects
must not supply native pointers, executable paths or toolchain arguments.

The 0.3.0 actual-ROM/GPU suite passed 336 of 343 tests with seven optional export skips and no
failures. The ARM64 package's bundled metadata/archive tests passed 5/5; host-LLVM regression
exports passed 30/30 as a separate scope. Production build, desktop smoke and the 15-milestone
C/H/bundled-NRM authoring check passed. The real-ROM workspace check passed 20 milestones,
including six native popouts, redock, shared Undo, camera and settings.

The ARM64 candidate passed strict deep signature, 44-file parity, no-ROM native-panel startup
and child-IPC checks. Its standalone-tools CI artifact passed an independent local smoke.
The real-ROM candidate restored 383 cached rooms and passed exact texture restoration, native
selectors and WASD; it built an NRM with empty PATH and HTTP/HTTPS blocked. Installation passed
strict deep signature and ASAR/tool-manifest parity, with source ROM, cache and ROM-profile
hashes unchanged. The final native run passed all three package/build and window-recovery jobs,
including Windows NSIS installation. Normal-profile interaction, manual cross-window drag,
physical Intel GPU and Intel/Windows own-ROM gates still need observations. Read the
[acceptance matrix](WORKSPACE-AND-BUILD-PLAN.md#acceptance-matrix) and
[validation record](../README.md#package-and-validation-status) for the scope of each result.

Static analysis, editor previews and successful native builds do not establish
Goemon64Recomp gameplay. Hand generated mods to the user with their paths,
affected rooms, changes and remaining uncertainties. The user chooses whether
to install and test them; do not install or launch generated NRMs at task end.
Keep ROMs, decoded game assets and generated test mods out of source control.

Read [native formats](native-formats.md),
[room translation evidence](room-geometry-editing.md), [export details](export.md)
and [runtime validation](runtime-validation.md) for native layouts, staging and
user gameplay handoffs.
