# Development roadmap

Version 0.2.5 supports version 2 room authoring: blank rooms, native
clones and editable replacements; mesh, vertex and face editing; native asset
placement; collision generation; entrances, custom doors and sky selection.
Export produces C/H source or an optional `.nrm` through the local toolchain.
The [authoring guide](room-authoring.md) covers the workflow; this roadmap tracks
its supported bounds and remaining work.

## Preview coverage

The supported US ROM contains 383 decoded room records, including 378 with
visual geometry. The 0.2.5 actor census distinguishes library seed previews from
canonical native placements:

| Census | Candidate IDs | Supported | Conditional | Nonvisual | Unresolved |
| --- | ---: | ---: | ---: | ---: | ---: |
| Library seeds | 361 | 74 | 173 | 19 | 95 |
| IDs with canonical placements | 255 | 54 | 154 | 15 | 32 |

The library contains 501 parts and 26,831 triangles: 23,442 textured and 3,389 untextured.
Its unresolved group includes seven partial previews. The canonical census retains 454 parts
and 24,116 triangles, with 21,275 textured and 2,841 untextured. These counts
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

The read-only [Room initialization](room-initialization.md) section covers the finite setup
schema for 374 world metadata callbacks and nine special geometry aliases. It distinguishes
native/template provenance from an authored export resource plan. Actor-linked Events and
future scenario behavior need their own evidence.

## Development phases

| Phase | Current capability | Work remaining |
| --- | --- | --- |
| 1: Read and display | US-ROM import, byte-order normalization and decompression; textured rooms and bounded native actor parts/initial poses; actor-linked event inspection and read-only room initialization; native asset libraries and thumbnails; picking, framing, Pan/Tilt and focused WASD; conditional TEXGEN, first timed-child previews, donor-scoped 0x24C/0x35C children and the bounded 0x07D initial surface | Wider verified actor/helper/material coverage; later animation and spawning; native lighting, fog and filtering parity; special scenes and broader collision inspection |
| 2: Author | Version 2 blank rooms, clones and editable replacements; independent authored geometry; mesh TRS, vertex XYZ/UV/RGBA, face topology and gizmos; actor insertion/deletion and loading policy; named entrances, editable custom-door volumes/destinations and sky inheritance/None/native assets; collision generation and linked updates; undo/redo and saved/native recovery | Direct native BSP editing and richer collision visualization; native event/script editing; migration of sparse actors across original proximity cells; broader scene support |
| 3: C/H export | Sparse actor/translation patches and authored room payloads; owned geometry, copied or generated native collision, rebuilt authored proximity grids, metadata/admission, entrances, doors and sky; constructor-resource checks, guarded controller contracts and dependency/preimage safeguards | User gameplay validation of entry, physics, camera, progression, teardown and revisit; more verified actor/resource contexts; compatibility with mods that change native roots or allocations; arbitrary scripts |
| 4: Prebuilt `.nrm` and desktop release | Optional local LLVM/LLD/RecompModTool pipeline using an initialized template; macOS ARM64 ad hoc signed package and installed-app checks | Toolchain distribution or guided installation; Intel macOS and Windows native runtime checks; Developer ID/notarization and Windows signing; user gameplay regression coverage |

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

The 0.2.5 typecheck, versioned build and actual-ROM/toolchain suite passed: 296 tests total,
293 passed, none failed and three optional GPU checks skipped. Ten focused procedural tests
and an isolated Electron/GPU run covered the library surface, drag/drop, save and history.
The ARM64 package passed signature, build-byte parity and candidate packaged-app smoke checks.
Normal installation and cached reopen remain pending. Consult the [validation record](
../README.md#package-and-validation-status) for the completed scope.

The historical 0.2.4 source checks passed fresh nonincremental typecheck, production build and the
actual-ROM/toolchain suite: 286 tests, 283 passed, none failed and three optional GPU checks
skipped. Four Electron initialization cases passed without errors or project-history changes.
The installed macOS ARM64 package passed signature and isolated cached-profile checks for 383
rooms, four native textured rooms, body/selector refresh, geometry visibility and focused WASD.
Texture toggles restored exact pixels; normal ROM/profile/cache hashes stayed unchanged.
A normal installed launch also restored 383 rooms and House 465's native initialization order,
actors, textures and Pan/Tilt controls.

Earlier GPU/thumbnail and full authoring smokes remain historical evidence. Consult the
[validation record](../README.md#package-and-validation-status) for the scope and counts, and the
[desktop workflow](https://github.com/8AE/mnsg-level-editor/actions/workflows/build.yml) for each
revision's platform builds. Intel macOS and Windows native runtime checks remain open;
packaging or CI alone does not establish editor behavior there.

Static analysis, editor previews and successful native builds do not establish
Goemon64Recomp gameplay. Hand generated mods to the user with their paths,
affected rooms, changes and remaining uncertainties. The user chooses whether
to install and test them; do not install or launch generated NRMs at task end.
Keep ROMs, decoded game assets and generated test mods out of source control.

Read [native formats](native-formats.md),
[room translation evidence](room-geometry-editing.md), [export details](export.md)
and [runtime validation](runtime-validation.md) for native layouts, staging and
user gameplay handoffs.
