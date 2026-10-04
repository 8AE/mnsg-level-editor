# MNSG Level Editor

Browse textured rooms and native actor models from the US version of
**Mystical Ninja Starring Goemon**. Use the desktop app on macOS or Windows,
edit room and actor data, save projects, and export patches for
[Goemon64Recomp](https://github.com/klorfmorf/Goemon64Recomp).

The app uses Electron, Next.js, [Once UI](https://docs.once-ui.com/ai-coding)
and Three.js. Bring your own US ROM; this repository and its installers contain
no ROM or decoded game assets.

## Import your ROM

Select your ROM on first launch. The importer accepts `.z64`, `.v64` and `.n64`
byte order, verifies the supported US revision, and decompresses the game's
LZKN64 resources. It preserves your input file and saves a verified, normalized
ROM cache in Electron's application data directory. You can reopen the editor
without selecting the ROM again.

## Editing scope

Version 0.2.1 includes version 2 projects, authored-room controls and C/H or
`.nrm` export. It adds guarded resource contracts for the House camera and
progression controllers, plus conditional first-child previews for Falling
Barrel and Slicer. Source, desktop authoring, timed-actor GPU, package and installed-launch checks
passed. Gameplay testing in Goemon64Recomp remains open.

- **Rooms:** browse 383 native room records, including 378 with decoded visual
  geometry. View original static textures, UVs, indexed palettes and supported
  material alpha. Toggle geometry, textures, wireframe and record markers.
- **Native actor edits:** inspect source records and edit position, raw rotation
  values, actor type and three unsigned 32-bit payload words. Choose replacement types
  from the room's original actor roster. Proximity actors can move within their
  verified original spawn cell; cross-cell moves require a future grid migration.
- **Actor previews:** inspect meshes and textures from your ROM, native model
  parts, skeleton transforms and initial poses sampled at an integer animation
  frame. The decoder follows bounded native initializer paths and model
  selectors, including camera-aligned parts and bones. Edit a verified selector
  through the actor's parameters to refresh its model. Click model surfaces to
  select their actor, or frame the selected model to inspect its bounds.
- **Events:** inspect derived actor-backed switches, doors, mechanisms and
  other classified triggers. Follow each event to its source actor to edit its
  placement. Event descriptions are read-only; this view covers the verified
  classifications, not a complete room-script inventory.
- **Room authoring:** create a blank room, clone the current room into a new ID,
  or choose **Make editable copy** to replace an existing room. Edit meshes,
  vertex positions, triangle indices, UVs and RGBA colors. Apply mesh
  translation, rotation and scale, or move a mesh, vertex or face with the
  translation gizmo.
- **Asset libraries:** browse actor prototypes, room geometry/components and
  native sky imagery from your ROM. Inspect thumbnail status, then drag a card
  into an authored room or use **Place at origin**. Choose actor loading,
  named entrances and custom door destinations in the inspector.
- **Collision and sky:** clones retain template physics until you choose
  **Generate collision from geometry**. Blank rooms start with empty authored
  collision. Choose inherited sky, no sky, or a native background. Preview
  camera projection differs from native scrolling.
- **Room translation:** move supported static visual geometry and collision
  together by an integer offset within the inspector's bounds. Rooms sharing
  a source receive the same translation. Actors, entrances and camera paths
  retain their positions. Use an editable replacement for vertex or topology
  changes.
- **Projects:** save sparse edits, authored rooms and the ROM identity in
  `.mnsgproj` files. Open version 1 projects through the version 2 migration,
  undo or redo edits, revert an authored room to its saved state, or restore its
  native source. Projects contain no complete ROM.

Follow the [room-authoring guide](docs/room-authoring.md) for creation, geometry,
collision, entrances and recovery controls.

Read the actor inspector's preview status before treating a model as evidence
of game behavior:

| Preview status | What you can inspect |
| --- | --- |
| Resolved native preview | Decoded parts and an initial pose from a resolved initializer path. Later behavior and visibility still depend on the game. |
| Conditional | Native model declarations reached with assumed save, collision or scene state. These declarations do not establish visibility in your save. |
| Partial | Known parts from a path or material state the decoder cannot finish. An amber origin marker identifies the uncertainty. |
| Unavailable | A placement marker and diagnostic details for an unresolved model. |
| Nonvisual controller | A hollow placement marker for a verified controller without a primary mesh. |

The actor library includes 361 candidate IDs: 74 supported, 170 conditional,
11 nonvisual and 106 unresolved. The unresolved group includes seven partial
previews. These counts describe bounded decoder results; they do not establish
later gameplay behavior or export admission for each candidate.

The census contains 497 decoded parts and 26,267 triangles: 22,903 textured
and 3,364 untextured. Across 255 IDs with canonical native placements, the
results are 54 supported, 152 conditional, 11 nonvisual and 38 unresolved.
Library seed previews can use different scene hints from the original
placements, so their status can differ.

Falling Barrel (0x19A) previews its first child with 36 textured triangles and
two CI4 textures. Slicer (0x19D) previews eight triangles with an untextured
fallback because native generated texture coordinates (TEXGEN) remain
unsupported. Both previews stop after the first child initializer. The decoder
does not establish later movement, repeated spawning or export resource closure
for an edited or foreign room context.

Some initial poses sit behind room surfaces. Geometry is visible by default.
Turn **Geometry** off below the viewport to inspect those models; this view
setting preserves their placement and your project data. Actor previews cover
bounded initialization and an initial pose. The editor does not simulate the full
game loop, spawning or later animation updates. Native lighting, fog, filtering
and shaders can differ from the game. Test exported changes in Goemon64Recomp
before distributing a mod.
See [actor evidence](docs/native-actors.md), [texture evidence](docs/native-textures.md)
and [room translation limits](docs/room-geometry-editing.md).

Payload meanings depend on the actor and can include resource IDs or pointers.
Changing a payload word requires understanding that actor's native behavior.

## Viewport controls

Click the viewport to focus it, then hold **W/A/S/D** to move the camera.
Choose **Pan** or **Tilt** below the viewport: left-drag pans in Pan mode and
orbits in Tilt mode. Right-drag pans in either mode. Scroll or middle-drag to
zoom. Camera movement leaves project data untouched.

| Control | Action |
| --- | --- |
| W / S | Move forward / backward along the view direction. |
| A / D | Move left / right relative to the view. |
| F | Frame the selected actor or event. |
| T | Toggle the translation gizmo for an editable selection. |
| G | Toggle the grid. |

WASD movement requires viewport focus. Typing in an inspector field,
opening a dialog, losing focus or starting an orbit, pan or gizmo drag clears
held movement. Release the key and press it again to resume. Modifier-key
combinations do not move the camera; there are no speed modifiers. Canceling a
gizmo drag discards its preview. A normal drop commits one edit that you can undo.

## Export a mod

Export sparse actor edits, supported room translations, authored replacements
and new rooms as C/H source or an optional `.nrm`. Authored exports include
geometry, collision, validated native actor dependencies, entrances, custom
doors and sky selection. The exporter rejects unresolved or unsafe native
contexts with a diagnostic. A saved project or preview does not establish
gameplay correctness.

**C/H export** creates a dedicated patch bundle with `mnsg_level_patch.c`,
`mnsg_level_patch.h`, standalone build files and integration instructions.
Copy the C/H pair into your compatible MNSG mod and retain your mod's manifest.
You need no compiler to generate these source files.

**Prebuilt `.nrm` export** requires these tools on your computer:

- An initialized [MNSGRecompModTemplate](https://github.com/klorfmorf/MNSGRecompModTemplate)
  checkout, including its symbol submodules and modding header.
- LLVM Clang with a MIPS target and LLVM `ld.lld`. On macOS, select LLVM Clang;
  Apple Clang lacks the required target.
- `RecompModTool` for packaging the linked mod.

Choose **Configure toolchain** in the export dialog to select the template and
any tools the editor cannot find. The exporter compiles the validated project into a `.nrm` file. Install and test that file
in Goemon64Recomp.

Generated patches check native source bytes and geometry dependencies before
writing. Mods that replace resource allocations or rebind the native geometry
tables can conflict with these edits. See [export details](docs/export.md) for
hook timing, compatibility limits and toolchain setup. Arbitrary event-script
editing remains outside the current export scope.

## Develop

Install Node.js 22 or newer and npm:

```sh
git clone https://github.com/8AE/mnsg-level-editor.git
cd mnsg-level-editor
npm ci
npm run dev
```

For the production UI, run `npm run build` followed by `npm start`.
`npm run dev:web` serves a procedural preview at `http://127.0.0.1:3000`.
Open that URL in your browser. Use the Electron app for ROM import, native
dialogs, project files and export.

Run the default checks:

```sh
npm run typecheck
npm test
npm run build
```

The default test suite skips checks that need a ROM, native toolchain or GPU
browser. Supply your own inputs to run those checks. These examples use a POSIX
shell; in PowerShell, assign each variable with `$env:NAME = 'value'` before
running the npm command.

```sh
MNSG_TEST_ROM=/path/to/us-rom.z64 \
  MNSG_EXPORT_TEST_TEMPLATE=/path/to/initialized/template npm test

MNSG_TEST_ROM=/path/to/us-rom.z64 \
  MNSG_TEST_TEMPLATE=/path/to/initialized/template npm run test:desktop

MNSG_TEST_ROM=/path/to/us-rom.z64 \
  MNSG_TEST_TEMPLATE=/path/to/initialized/template npm run test:authoring

# Optional renderer fixture; requires an installed Google Chrome.
MNSG_GPU_TEST=1 node --import tsx --test tests/editor-textures.test.ts
```

The desktop smoke checks ROM import and cache reuse, editing, save/reopen,
validation failures, textured rendering, actor model refresh, camera controls
and source export. Set
`MNSG_TEST_TEMPLATE` to include `.nrm` compilation. Build the app before running
this smoke test.

`npm run test:authoring` checks the authored-room editor workflow and requires
C/H export by default. Set `MNSG_TEST_TEMPLATE` to include `.nrm` compile/link
checks. `MNSG_SMOKE_UI_ONLY=1` selects an editor checkpoint that leaves export
verification pending; it does not count as the full authoring check.

## Package and validation status

```sh
npm run package:mac
npm run package:win
```

These commands rebuild the app and use the host's architecture. For the release
targets used in this project, build once and select each architecture:

```sh
npm run build
npx electron-builder --mac dmg zip --arm64 --publish never
npx electron-builder --mac zip --x64 --publish never
npx electron-builder --win nsis --x64 --publish never
```

Find installers in `release/`. The [desktop build workflow](https://github.com/8AE/mnsg-level-editor/actions/workflows/build.yml)
checks and packages source revisions for macOS ARM64, macOS x64 and Windows x64
on pushes to `main`. Consult its runs for a revision's results and build artifacts.
The macOS configuration uses ad hoc signing (`mac.identity: "-"`). For a
Developer ID release, override `mac.identity` with your certificate identity and
configure notarization credentials in electron-builder. Windows distribution
builds need code-signing credentials.

Current 0.2.1 source validation passed typecheck, the production build and the
test suite with the supported US ROM and LLVM/NRM template: 204 tests total,
202 passed and two optional GPU checks skipped. Separate timed-actor GPU checks
passed all four cases, including Barrel texture pixels and Slicer's explicit
untextured TEXGEN fallback, with no page/console errors or runtime crashes.

The real Electron authoring smoke passed 15 milestones: native import,
Pan/Tilt/WASD with unchanged project data, cloning, mesh transforms, UV/RGBA,
topology, picking, thumbnail drag/drop, collision, reciprocal doors, sky,
reset/history, save/reopen and hostile IPC rejection. It retained all eight
House 465 actors in room 621, verified File96 in the export inventory, generated
C/H and passed strict MIPS compilation, linking and `.nrm` packaging.

The full-roster House handoff generated C/H, compiled MIPS, linked and packaged
`.nrm`. Room 465 retains all eight native actors and adds a checker door to
room 620. Room 620 copies the House geometry and native BSP, retains those
eight actors, adds a native coin and a return door, and selects sky resource
123. Guarded static controller contracts retain File27 for camera actor 0x308
and File61 plus File96 for progression controller 0x34E. The clone requires no
actor-removal workaround. These contracts do not simulate later camera
callbacks or scenario-script execution.

The macOS ARM64 0.2.1 DMG and ZIP passed packaging and strict app-signature
verification. A visible packaged smoke checked rooms 0, 465, 376 and 322,
textured geometry, native body and door-selector previews, WASD and unchanged
cache data. The installed 0.2.1 app passed strict signature verification and a
normal cached-ROM launch: 383 rooms, House 465 with 249 triangles, 247 textured,
and Pan/Tilt controls present. ROM identity and normalized cache hashes stayed
unchanged. Consult the linked desktop workflow for each revision's macOS ARM64,
macOS x64 and Windows x64 build results. Intel macOS and Windows runtime checks
remain open.

Compile, link, package and editor checks do not establish in-game collision,
reload behavior or compatibility with other mods. Test the affected rooms and
their shared sources in Goemon64Recomp before releasing an export.

## Source and native evidence

| Directory | Contents |
| --- | --- |
| `core/rom/` | ROM identification, decompression, native records, geometry/textures and bounded actor initializer/model decoding. |
| `core/project.ts`, `core/authoring/` | Project migration, authored-room validation, ROM libraries and collision compilation. |
| `core/export/` | Patch generation and the optional `.nrm` toolchain. |
| `electron/` | Sandboxed IPC, file dialogs, ROM cache and atomic project writes. |
| `app/`, `components/` | Once UI workspace and Three.js viewport. |

Read the [native formats](docs/native-formats.md),
[texture research](docs/native-textures.md) and [roadmap](docs/ROADMAP.md) for
verified layouts and remaining work. Native symbol references also live in the
[MNSG API documentation](https://8ae.github.io/mnsg-documentation/).

Keep ROMs, decoded assets, credentials and generated test mods out of source
control. The application source uses the [MIT license](LICENSE).
