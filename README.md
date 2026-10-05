# MNSG Level Editor

Browse textured rooms and native actor models from the US version of
**Mystical Ninja Starring Goemon**. Use the desktop app on macOS or Windows,
edit room and actor data, save projects, and export patches for
[Goemon64Recomp](https://github.com/klorfmorf/Goemon64Recomp).

The desktop targets macOS 14 or newer on Apple Silicon and Intel, and Windows x64. Linux is
outside the supported package targets. The app uses Electron, Next.js,
[Once UI](https://docs.once-ui.com/ai-coding) and Three.js. Bring your own US ROM; installers
contain no ROM or decoded game assets.

[Download 0.3.2 for macOS or Windows](https://github.com/8AE/mnsg-level-editor/releases/tag/v0.3.2).
Install the app, import your ROM, create a project, configure **Settings**, and export an NRM.
The app supplies the compiler, mod packager and each project's template.

## Import your ROM

Select your ROM on first launch. The importer accepts `.z64`, `.v64` and `.n64`
byte order, verifies the supported US revision, and decompresses the game's
LZKN64 resources. It preserves your input file and saves a verified, normalized
ROM cache in Electron's application data directory. You can reopen the editor
without selecting the ROM again.

## Workspace

The workspace has six panels: Rooms on the left, Scene in the center, separate Hierarchy
and Inspector panels on the right, and Assets/Console tabs below Scene. Drag a separator,
focus it and use the keyboard, or use its size buttons. Each panel has its own scroll area.

Use each panel's header to pop out, redock, maximize or close it. Assets and Console stay
available as bottom tabs, with popout/maximize actions beside the active tab; double-click a
bottom tab to pop it out. Close its native window to redock it. **Layout** offers Default, Wide,
Focus, saved layouts, Reset and recovery of hidden panels. The three icons beside Layout toggle
the docked regions. Popouts share one project and Undo/Redo history; layout changes remain view state.

| Shortcut | Action |
| --- | --- |
| Cmd/Ctrl+B | Hide/show the left panel |
| Cmd/Ctrl+Shift+B | Hide/show the right panels |
| Cmd/Ctrl+J | Hide/show the bottom panel |
| Cmd/Ctrl+C / V | Copy/paste the selected editor object |
| Cmd/Ctrl-click | Add/remove an item from the selection |

Keyboard shortcuts leave text editing and IME composition alone. Right-click actors, geometry,
rooms or library assets for Copy/Paste. Mesh copies keep UV/RGBA, material and linked collision;
face copies append private triangle vertices when the target material matches, otherwise they
create a separate mesh. Vertex copies require a selected destination mesh. Pasting a native
actor first creates an editable room replacement through the normal admission checks. Copies
stay in memory for this editor session and may be pasted between rooms/projects using the same
ROM. Event copying applies properties to an editable event of the same kind; native event
creation remains outside the supported authoring schema. Every successful paste participates
in Undo/Redo. Clipboard objects retain their copied values after the originals change.

The geometry Inspector shows the current material preview. **Choose material** opens a searchable
grid of lazy ROM texture/color thumbnails, including in a native Inspector window. Mesh and face
selections outline the actual edges; vertex selections have a contrasting screen-sized marker.
Hold **Cmd** on macOS or **Ctrl** on Windows while clicking to add or remove actors, events,
meshes, faces or vertices. This works in the viewport and Hierarchy, including mixed selections.
Choose face or vertex mode before selecting geometry elements. Press **T** and drag the shared
move gizmo, or enter X/Y/Z offsets in the group Inspector. Shared vertices move once, and one
Undo restores the entire move. Moving the group keeps its selection and outlines, including
short gizmo drags, so you can move it again immediately. Plain clicking selects one item; plain clicking empty space
clears the selection. Read-only items must be deselected or made editable before a group move.

Change the source ROM under **Settings → Source ROM**. Read the local checks and release gates below.

## Editing scope

Create version 2 projects, author rooms and export C/H or `.nrm` for admitted native data.
The existing geometry, collision, custom-door and sky tools remain available. Native preview
limits remain in force; the workspace overhaul does not add actor export admission.

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

The latest native census, recorded for 0.2.6, includes 361 candidate IDs: 74 supported, 174 conditional,
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
| F | Frame the selected items. |
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
No separate compiler installation is required.

**Prebuilt `.nrm` export** uses the app's bundled offline MIPS Clang, ELF linker and RecompModTool.
You do not select LLVM executables or an external template checkout. The desktop prepares a
separate managed build workspace for each project, then validates, compiles, links and packages
its current data. If bundled tools are missing or corrupt, repair/reinstall the application.

Open **Project and build settings** to edit the mod identity, version, descriptions, authors,
dependencies and native-library declarations. **Options** supports Enum, Number and String;
**Files** imports an icon, additional files, symbol tables or native-library sidecars; **Build
inputs** sets workspace-relative ELF/symbol paths and the NRM filename. Apply settings, then save
the project. The app normalizes PNG/JPEG icons to portable `thumb.png` data. It preserves these
settings and attachments when you save/reopen, with independent values for each project.

The GUI covers all 13 manifest and five input fields recognized by the pinned tool. Config
options define mod-menu fields; generated room code does not consume their values automatically.
The pinned Goemon runtime ignores `custom_gamemode`; `enabled_by_default` is not an effective
TOML option. Native-library filenames do not establish platform/ABI compatibility. Read the
[managed build contract](docs/WORKSPACE-AND-BUILD-PLAN.md) and
[known limitations](docs/KNOWN-LIMITATIONS.md) before distributing an export.

Generated patches check native source bytes and geometry dependencies before
writing. Mods that replace resource allocations or rebind the native geometry
tables can conflict with these edits. See [export details](docs/export.md) for
hook timing, compatibility limits and managed-build boundaries. Arbitrary event-script
editing remains outside the current export scope.

## Develop

Install Node.js 22 or newer and npm. Source developers also need a native C/C++ build environment,
CMake/Ninja, git, curl and tar to build the pinned tool bundle. Those prerequisites belong to
source development; installed users receive the tools with the app.

```sh
git clone https://github.com/8AE/mnsg-level-editor.git
cd mnsg-level-editor
npm ci
npm run managed:build -- --generator=Ninja --jobs=3
npm run managed:smoke
npm run dev
```

`managed:build` downloads verified source pins and builds the host's MIPS compiler/linker and
mod packager into ignored `resources/managed-tools/`. It can take substantial time. A matching
verified artifact from the [managed-tools workflow](https://github.com/8AE/mnsg-level-editor/actions/workflows/managed-tools.yml)
can supply the same bundle. Build and stage each architecture on its native host.

For production UI, run `npm run build` followed by `npm start`. `npm run dev:web` serves a
procedural preview at `http://127.0.0.1:3000`; use Electron for ROM import, project files,
native popouts and export. Run the default source checks:

```sh
npm run typecheck
npm test
npm run build
```

Optional checks use your ROM, a staged tool bundle or a GPU browser. The metadata export
example uses the managed executables; Windows uses the `.exe` filenames and PowerShell
`$env:NAME = 'value'` assignments.

```sh
MNSG_TEST_ROM=/path/to/us-rom.z64 MNSG_GPU_TEST=1 npm test

MNSG_EXPORT_TEST_TEMPLATE="$PWD/resources/managed-tools" \
  MNSG_EXPORT_TEST_CLANG="$PWD/resources/managed-tools/bin/clang" \
  MNSG_EXPORT_TEST_LINKER="$PWD/resources/managed-tools/bin/ld.lld" \
  MNSG_EXPORT_TEST_MOD_TOOL="$PWD/resources/managed-tools/bin/RecompModTool" \
  node --import tsx --test tests/export-mod-settings.test.ts

MNSG_TEST_ROM=/path/to/us-rom.z64 npm run test:desktop
MNSG_TEST_ROM=/path/to/us-rom.z64 npm run test:authoring
MNSG_TEST_ROM=/path/to/us-rom.z64 node scripts/smoke-workspace.mjs
npm run test:workspace:recovery
```

Build the app first. Desktop and authoring smokes use bundled tools for NRM checks by default.
`MNSG_TEST_SKIP_NRM=1` omits the desktop compiler check; `MNSG_SMOKE_UI_ONLY=1` omits authoring
exports. Those checkpoints leave export verification incomplete. The workspace smoke checks
layout/popout/history and project-settings interactions, including texture restoration after
Scene relocation. The recovery smoke uses a disposable no-ROM profile to check a full process
restart, saved window bounds, off-monitor recovery and compact popouts at 100%, 125% and 200%
zoom. Set `MNSG_TEST_APP` to check an installed executable. These checks do not launch the game.

On native Windows CI, the installer check runs the actual NSIS package in a disposable
directory containing spaces, an apostrophe and Japanese characters. The workflow compares its
installed payload with the packaged files, then runs startup, metadata/NRM and recovery checks
from that installed copy. A configured workflow is not a passed platform check; use the run's
results below.

## Package and validation status

After staging and checking the native tool bundle, package on the corresponding host:

```sh
npm run package:mac
npm run package:win
```

Find installers in `release/`. The build rejects a mismatched or incomplete tool bundle.
The [desktop workflow](https://github.com/8AE/mnsg-level-editor/actions/workflows/build.yml)
uses native macOS ARM64, macOS x64 and Windows x64 jobs. It stages pinned tools and includes
packaged offline probes; consult the revision's run for completed results. macOS packages use
ad hoc signing. Developer ID/notarization and Windows code signing require release credentials.

The 0.3.0 actual-ROM/GPU source suite passed 336 of 343 tests, with seven optional export skips
and no failures. Metadata/archive checks passed 5/5 with the ARM64 package's bundled tools,
covering the 18 fields, Unicode, PNG, uploaded symbols, additional files and config options.
Legacy-template exports passed 30/30 with host LLVM; that is separate from bundled-tool proof.
Production build, desktop smoke and the 15-milestone C/H/bundled-NRM authoring check passed.

The real-ROM workspace check passed 20 milestones: six native popouts, resize and redock,
shared editing/Undo, camera/WASD, saved-layout reload, Console and project settings. Settings
remained usable at the tested 125% and 200% zoom sizes. The ARM64 candidate passed strict deep
ad hoc signature and 44-file embedded-build parity checks. Its isolated no-ROM first boot
passed all six native panel lifecycles and child-IPC checks; its package contains no ROM,
project or NRM. The ARM64 standalone-tools CI bundle passed an independent local smoke.

The ARM64 candidate also passed isolated real-ROM checks: 383 cached rooms, native actor
selectors, four rooms' exact texture restoration and WASD. It built an NRM using only packaged
tools with an empty PATH and blocked HTTP/HTTPS. The installed application passed strict deep
signature checks and matched the candidate's ASAR/tool manifest. Source ROM, cache and
ROM-profile hashes remained unchanged.

The October 5 continuation fixed draft submission during forced popout closure and passed
21 real-ROM workspace milestones, including four rooms' exact texture restoration after Scene
relocation. A separate 11-milestone native-window check passed full-app restart, saved layouts
and window sizes, off-monitor recovery, and all six compact popouts' redock controls through
200% zoom. These checks used disposable profiles.
The installed ARM64 app also passed the 11 recovery milestones after a shutdown fix that
flushes pending window-position writes before quitting. Its 44 embedded build files match the
tested build; strict signature, cached-ROM offline export and five metadata/archive checks pass.
An installed-AppApi A/B check also built two projects offline with distinct templates, metadata,
config options and imported icons. Reopen restored the saved settings, the other project's files
stayed unchanged, and cancellation or incomplete symbols preserved the earlier NRM.

[Native desktop CI](https://github.com/8AE/mnsg-level-editor/actions/runs/37318750246) passed at
`df597e88`: ARM64, Intel and Windows each passed 254 source tests (89 optional skips), five
packaged-tool metadata/archive tests, offline first boot and 11 native recovery milestones.
Windows ran the actual NSIS installer into a path containing spaces, an apostrophe and Japanese
text, verified installed payload parity, and used those installed tools/executable for the checks.
Mac packages passed strict deep signature verification. The shutdown snapshot now captures all
live popouts before their opener destroys them, preserving their current size on every host.
The installed ARM64 copy repeated recovery and cached-ROM offline export after that fix.

The Intel CI guest has no usable WebGL: its visible rendering diagnostic and native panes were
checked, while physical Intel viewport rendering remains unverified. Normal-profile interactive
checks, manual cross-window drag, IME and Intel/Windows own-ROM editing remain separate.
Read the [acceptance matrix](docs/WORKSPACE-AND-BUILD-PLAN.md#acceptance-matrix)
for partial gates. Earlier release evidence does not certify these remaining scopes.

Native lighting, filtering, future waves and gameplay parity remain unverified. The workspace
and tool changes add no actor export admission. When handing off a generated mod, record its
path, affected rooms, changes and remaining uncertainties. You choose whether to install and
test it in Goemon64Recomp; the editor's build checks do not establish gameplay.

## Source and native evidence

The 0.3.2 multi-selection update passed [native desktop CI](https://github.com/8AE/mnsg-level-editor/actions/runs/37385049631)
at `5595dae5`: all six jobs succeeded. Each host passed 268 of 357 source tests (89 optional
skips), five packaged-tool metadata/archive checks, offline first boot with all six panel
lifecycles and 11 native recovery milestones. Windows checked the actual NSIS-installed
payload and tools. Mac signatures passed strict deep verification. Intel's virtual guest
checked the missing-WebGL diagnostic; physical Intel rendering remains unverified.

Local own-ROM validation passed 346 of 357 source tests (11 optional skips), typecheck and
production build. All six multi-selection native UI milestones and the nine existing UI
regression milestones passed. These include actual face/vertex raycasts, shared-vertex movement,
mixed groups, one-step Undo, a real Scene-popout gizmo drag and canvas focus-loss cancellation.
The installed ARM64 0.3.2 app repeated offline cached-ROM export and all 11 recovery checks.
Normal-profile interaction reopened the saved Oedo Town project, selected two outlined meshes
and enabled the shared move tool without editing project data. The ROM cache hash stayed unchanged.
Generated-mod gameplay and Windows/Intel own-ROM editing remain unverified.

The 0.3.1 follow-up passed [native desktop CI](https://github.com/8AE/mnsg-level-editor/actions/runs/37379510157)
at `c51e8d93`. Each host passed 261 source tests (89 optional skips), five packaged-tool
metadata/archive tests, offline no-ROM first boot and all 11 native recovery milestones.
Windows used the actual NSIS-installed executable and tools; Mac signatures passed strict deep
verification. The Intel guest's missing-WebGL diagnostic was checked; physical Intel rendering
and Intel/Windows own-ROM editing remain separate.

Local real-ROM tests passed 339/350 with 11 optional environment skips. Nine new native UI
milestones verified material previews/search, source Settings, panel shortcuts, bottom controls,
selection outlines, context menus, copy/paste with Undo, and Inspector popout focus/clipboard.
The installed ARM64 0.3.1 app repeated offline cached-ROM export and all 11 recovery milestones.
Normal-profile checks confirmed the compact asset-category spacing, relocated source controls
and material grid. The user's saved Oedo Town edits reopened, and the ROM cache hash stayed
unchanged. These results do not establish generated-mod gameplay.

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
