# Development roadmap

The first application version establishes a real US-ROM importer, project
workspace, native actor export and bounded static geometry/collision translation.
The actor preview extension adds ROM-driven model initialization, native parts
and initial poses, plus focused WASD camera movement and Geometry visibility.
Arbitrary mesh deformation, collision topology and script editing remain further
native research and implementation work.

## Frozen US-ROM preview coverage

The source census covers 383 native room records, including 378 with decoded
visual geometry. For the supported US ROM, it classifies 3,888 actor placements
and decodes 3,984 model parts:

| Placement classification | Count |
| --- | ---: |
| Resolved native preview | 1,228 |
| Conditional declaration | 1,271 |
| Verified nonvisual controller | 1,115 |
| Partial preview or unavailable model | 274 |

These counts describe bounded initialization and model decoding from the
[supported ROM](native-actors.md). They do not establish runtime visibility,
later animation or a complete inventory of actor definitions. Conditional paths
use stated save, collision or scene-state assumptions; edits can change a
placement's classification.

## Development phases

| Phase | Current capability | Work remaining |
| --- | --- | --- |
| 1: Read and display | Verified ROM import, byte-order normalization and decompression; native room records and actor-linked events; room geometry with static RGBA/CI textures, palette/PIC decoding and supported material alpha; bounded native actor initializer/model selectors, meshes/textures, initial integer poses, linked parts and billboards; model-surface picking, framing, focused WASD movement and Geometry visibility | Wider constructor/helper and material coverage, complete event/script coverage, native lighting/fog/filtering, later animation and runtime spawning, special scene overlays and collision visualization |
| 2: Modify | Project-scoped actor transforms, cancelable translation gizmo, room-supported actor substitution and three native payload words; verified selector-driven model refresh; undo/redo/reset; native F32 same-cell movement validation; bounded integer room translation with collision and shared-source groups | Individual mesh vertices and collision topology, event scripts/volumes, actor insertion/deletion, proximity grid migration and resource dependency changes |
| 3: C/H export | Generated actor and static translation patch source/header; availability and preimage guards; private actor definitions; room resource restoration; read-only geometry dependency guards and pre-bind collision/model hooks | Fresh in-game validation, geometry cloning for independent shared-room edits, broad other-mod compatibility, arbitrary event scripts |
| 4: Prebuilt `.nrm` | Local optional LLVM/RecompModTool pipeline from an initialized template; `.nrm` save dialog | Distributable bundled toolchain or guided installation, Windows native validation, signed app releases and in-game export regression coverage |

## Native work before broadening edits

1. Extend bounded actor initialization with verified helper semantics and explicit
   save, collision and scene-state assumptions. Preserve resolved, conditional,
   partial previews of known parts, unavailable and nonvisual controller distinctions. Initial
   model declarations do not prove runtime visibility or complete actor coverage.
2. Expand event classifiers with exact overlay entry and continuation evidence.
   Keep actor-linked events distinct from a hypothetical universal event table.
   Decode their fields per family, preserving opaque pointers and flag lifetimes.
3. Extend static texture rendering toward native lighting, fog, three-point
   filtering and animation parity, and expand scene graph coverage. Preserve
   original geometry provenance distinct from reconstructed texture waves.
4. Reconstruct collision BSP surfaces for visualization and arbitrary deformation.
   The recovered plane/tree schema supports translation while preserving topology;
   visible triangles and collision surfaces remain separate resources.
5. Have the user test translation pre-bind hooks in gameplay, including unload/reload and
   shared assets. Add geometry cloning and rebinding before supporting distinct
   edits to rooms that share one complete geometry/collision source group.
6. Implement proximity-list migration before allowing movement across spawn
   cells or adding/deleting proximity actors.
7. Decode room resource dependencies before allowing new actor types that are
   absent from a room's original roster. Preserve actor-specific definitions.

## Project evolution

Version 1 projects store a ROM identity, sparse actor overrides and bounded room
translations. Future schema versions should add mesh, collision and script edits with migrations,
strict source checks and clear unsupported-record handling. Never store project-
controlled native pointers or executable/toolchain commands. Continue checking
conflicting edits to resources shared by several rooms.

Translation exports assume canonical File11 root/resource tables and wave
allocation sizes. Export guards cover display commands, plane normals and
tree/header dependencies. Test compatibility with other mods in the game.

## Verification and release gates

- Keep bounded parser, project and export tests covering malformed input,
  shared records, signed widths, native angle sentinels and F32 cell boundaries.
- Check native model selection and parameter refresh through the validated
  desktop bridge. Test model-surface picking, frame bounds and material toggles
  on GPU fixtures and user-ROM samples. Hide room geometry to inspect occluded
  initial poses without changing their native placement.
- Test focused WASD movement, inspector typing, blur and pointer gestures against
  saved project data. Verify canceled gizmo previews and normal drop/undo order.
- Import the supplied local compressed and decompressed US ROM as separate inputs;
  confirm identical decoded results and the native decompressed hash.
- Test desktop import, room browsing, editing, save/reopen, C/H export and `.nrm`
  creation on macOS and Windows. Packaging for another OS does not prove runtime
  behavior there.
- Hand generated mods to the user with their file paths, affected rooms and exact
  changes. The user installs and tests them in Goemon64Recomp: verify actors,
  room reloads, transitions into rooms sharing resources, and missing/deferred
  resource handling. Static native analysis and successful MIPS builds cannot
  substitute for this gameplay check. Do not install or launch generated mods
  at the end of a task.
- Validate each release installer, then configure macOS signing/notarization and
  Windows signing for distribution. Keep game assets outside release artifacts.

Apple Silicon native editor checks cover textured rooms, project edits,
native actor body textures and depth-aware surface picking, selector refresh and
undo, Geometry visibility with exact pixel restoration, WASD and real gizmo
cancellation/drop. Those checks preserve the saved project. The frozen source
passed typecheck and the production build. In the test suite, 102 tests passed;
five optional GPU/toolchain checks skipped. The final desktop run generated no
`.nrm` and launched no Goemon64Recomp game.

The actor-preview revision passed public CI for macOS ARM64, macOS x64 and
Windows x64. The local ad hoc signed ARM64 package passed strict signature
verification and visible-window native checks with an isolated ROM cache:
four textured rooms with exact texture-toggle restoration, conditional body
parts, distinct door-selector assets, Geometry visibility and WASD movement.
The checks left the project and existing ROM cache unchanged.
The installed ARM64 app passed signature verification and restored the cached
ROM, textured house and native actor previews on a normal launch.
The [desktop workflow](https://github.com/8AE/mnsg-level-editor/actions/workflows/build.yml)
checks and packages source revisions. Intel macOS and Windows native runtime
validation remain open. The macOS build configuration uses ad hoc signing;
Developer ID distribution requires a certificate identity override and
notarization credentials. Windows distribution requires code-signing credentials.

Read [native-formats.md](native-formats.md) for layout evidence and uncertainty,
and [export.md](export.md) for actor export behavior and prerequisites.
[room-geometry-editing.md](room-geometry-editing.md) covers translation schemas
and staging; [runtime-validation.md](runtime-validation.md) covers gameplay
handoffs. Consult [native-textures.md](native-textures.md) for static texture
formats and preview limits, and [native-actors.md](native-actors.md) for actor
identity, initialization, initial-pose evidence and unresolved paths.
