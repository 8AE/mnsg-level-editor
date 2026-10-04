# Development phases

The first application version establishes a real US-ROM importer, project
workspace, native actor export and bounded static geometry/collision translation.
Arbitrary mesh deformation, collision topology and script editing remain further
native research and implementation work.

| Phase | Current capability | Work remaining |
| --- | --- | --- |
| 1: Read and display | One-time verified ROM import with byte-order normalization and decompression; room metadata; resident, normal and proximity actors; selected actor-driven events; native F3DEX room geometry with original static RGBA/CI textures, palette/PIC decoding, UVs and wrapping; supported material color/alpha; marker selection and source inspection | Full event/script coverage, actor models, lighting/fog/native filtering and animation parity, complete display-list state, special scene overlays and collision visualization |
| 2: Modify | Project-scoped actor transforms, movement gizmo, room-supported actor substitution, three native payload words, undo/redo/reset; native F32 same-cell movement validation; integer static room translation for 378 room IDs with collision and complete shared-source groups | Individual mesh vertices and collision topology, event scripts/volumes, actor insertion/deletion, proximity grid migration and resource dependency changes |
| 3: C/H export | Generated actor and static translation patch source/header; availability and preimage guards; private actor definitions; room resource restoration; read-only geometry dependency guards and pre-bind collision/model hooks | Fresh in-game validation, geometry cloning for independent shared-room edits, broad other-mod compatibility, arbitrary event scripts |
| 4: Prebuilt `.nrm` | Local optional LLVM/RecompModTool pipeline from an initialized template; `.nrm` save dialog | Distributable bundled toolchain or guided installation, Windows native validation, signed app releases and in-game export regression coverage |

## Native work before broadening edits

1. Expand event classifiers with exact overlay entry and continuation evidence.
   Keep actor-linked events distinct from a hypothetical universal event table.
   Decode their fields per family, preserving opaque pointers and flag lifetimes.
2. Extend static texture rendering toward native lighting, fog, three-point
   filtering and animation parity, and expand scene graph coverage. Preserve
   original geometry provenance separately from reconstructed texture waves.
3. Reconstruct collision BSP surfaces for visualization and arbitrary deformation.
   The recovered plane/tree schema supports translation while preserving topology;
   visible triangles and collision surfaces remain separate resources.
4. Test translation pre-bind hooks in actual gameplay, including unload/reload and
   shared assets. Cloning and rebinding are needed for independent edits to rooms
   that currently share one complete geometry/collision source group.
5. Implement proximity-list migration before allowing movement across spawn
   cells or adding/deleting proximity actors.
6. Decode room resource dependencies before allowing new actor types that are
   absent from a room's original roster. Preserve actor-specific definitions.

## Project evolution

Version 1 projects store a ROM identity, sparse actor overrides and bounded room
translations. Future schema versions should add mesh, collision and script edits with migrations,
strict source checks and clear unsupported-record handling. Never store project-
controlled native pointers or executable/toolchain commands. Continue checking
conflicting edits to resources shared by several rooms.

Translation exports assume canonical File11 root/resource tables and wave
allocation sizes. Display commands, plane normals and tree/header dependencies
are guarded, but this does not prove compatibility with every other mod.

## Verification and release gates

- Keep bounded parser, project and export tests covering malformed input,
  shared records, signed widths, native angle sentinels and F32 cell boundaries.
- Import the supplied local compressed and decompressed US ROM independently;
  confirm identical decoded results and the native decompressed hash.
- Test desktop import, room browsing, editing, save/reopen, C/H export and `.nrm`
  creation on macOS and Windows. Packaging for another OS does not prove runtime
  behavior there.
- Hand generated mods to the user with their file paths, affected rooms and exact
  changes. The user installs and tests them in Goemon64Recomp: verify actors,
  room reloads, transitions into rooms sharing resources, and missing/deferred
  resource handling. Static native analysis and successful MIPS builds cannot
  substitute for this gameplay check. Do not install or launch generated mods
  automatically at the end of a task.
- Validate each release installer, then configure macOS signing/notarization and
  Windows signing for distribution. Keep game assets outside release artifacts.

The detailed format evidence and uncertainty are maintained in
[native-formats.md](native-formats.md); actor export behavior and prerequisites
are described in [export.md](export.md). Exact translation schemas and staging
evidence are in [room-geometry-editing.md](room-geometry-editing.md); isolated
gameplay handoff guidance is in [runtime-validation.md](runtime-validation.md).
Canonical static texture formats, census and preview limits are in
[native-textures.md](native-textures.md).
