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

Version 0.2.6 supports version 2 room authoring and C/H or `.nrm` export for admitted data.
The water increment adds a conditional initial surface for **The Water (Husband and Wife Rocks)**,
actor 0x249. Native textured rooms, project editing, Pan/Tilt controls and the existing geometry,
collision, door and sky tools remain available.

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
- **Room initialization:** expand the section in the **Room** tab or the room-level authored
  inspector to inspect native callback/resource order and template provenance. Expand
  **Native sources** for addresses and hashes. This read-only setup inventory covers 374
  world metadata records and nine special geometry aliases; it does not decode all game events.
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
Read the [room-initialization guide](docs/room-initialization.md) for setup provenance and
its event-coverage limits.

Read the actor inspector's preview status before treating a model as evidence
of game behavior:

| Preview status | What you can inspect |
| --- | --- |
| Resolved native preview | Decoded parts and an initial pose from a resolved initializer path. Later behavior and visibility still depend on the game. |
| Conditional | Native model declarations reached with assumed save, collision or scene state. These declarations do not establish visibility in your save. |
| Partial | Known parts from a path or material state the decoder cannot finish. An amber origin marker identifies the uncertainty. |
| Unavailable | A placement marker and diagnostic details for an unresolved model. |
| Nonvisual controller | A hollow placement marker for a verified controller without a primary mesh. |

The 0.2.6 actor library includes 361 candidate IDs: 74 supported, 174 conditional,
19 nonvisual and 94 unresolved. The unresolved group includes seven partial
previews. These counts describe bounded decoder results; they do not establish
later gameplay behavior or export admission for each candidate.

The census contains 502 decoded parts and 27,223 triangles: 23,834 textured and 3,389
untextured. Across 255 IDs with canonical native placements, the results are 54 supported, 155
conditional, 15 nonvisual and 31 unresolved. Library seed previews can use different scene hints
from the original placements, so their status can differ.

**Water preview:** open native room 313 and select actor 0x249 to inspect its initial flat
surface, or use its actor-library card. The canonical record retains XYZ [0, 53, 0] and zero
angles, with native scale 0.16. The preview uses 392 textured triangles and two texture samples
with distinct coordinates. It stops before future waves and adds no export admission. The
existing policy permits its original parameter words in native room 313 or a room-313
replacement with template 313, including position and angle edits. Changed parameters or a
foreign/new-room context still reject. Read the [water guide](docs/native-water-actor-preview.md).

Actor 0x07D also previews an initial 392-triangle surface. Its constructor fixes XYZ at
[10, 0, -300], angles at [256, 0, 0] and scale at 0.2, so dragging or editing its record cannot
reposition that surface. It remains conditional and rejects export. Read the
[procedural guide](docs/native-procedural-actor-preview.md) for its separate native setup.

Other conditional previews include donor-scoped child models, Barrel/Slicer's first child and
Slicer's generated texture coordinates. Metadata-only controllers retain live effects outside
their markers. Some candidates remain partial or unavailable. Read the
[actor evidence](docs/native-actors.md) for per-family limits and resource admission.

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

Version 0.2.6 passed all 315 tests in the actual-ROM/toolchain/GPU suite, with no failures or
skips. Fresh nonincremental TypeScript and production builds passed. The ARM64 candidate
package passed strict deep ad hoc signature checks; its bundled main and HTML match the tested
build, and it contains no ROM, project or NRM. Actual Electron checks covered canonical water,
library thumbnail/drag placement, saved history and exact texture off/on pixel restoration.
The candidate-package smoke restored 383 cached rooms and checked four textured rooms, native
body/door selectors and focused WASD without changing the original cache. The installed
0.2.6 ARM64 app passed strict signature and candidate-byte parity checks. Normal launch restored
383 cached rooms without ROM reselection; room 313 displayed native textured water and its
conditional library details. Pan/Tilt responded, the project stayed clean, and source ROM,
cache and ROM-profile hashes remained unchanged. Consult the
[desktop workflow](https://github.com/8AE/mnsg-level-editor/actions/workflows/build.yml) for the
revision's platform packaging results; CI packaging does not establish platform runtime behavior.

Intel macOS and Windows runtime checks remain open. Native lighting, filtering, future waves
and gameplay parity remain unverified. This water increment creates no new generated NRM and
adds no actor export admission. Existing C/H and `.nrm` export keeps its canonical-context
policy for water in room 313; changed parameters or a foreign/new-room context remain rejected.
The user chooses whether to install and test generated mods in Goemon64Recomp.

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
