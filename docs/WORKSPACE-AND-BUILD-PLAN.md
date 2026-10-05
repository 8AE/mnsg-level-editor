# Workspace and managed build plan

**Status: 0.3.0 local workspace/build checks passed; release acceptance PARTIAL.** Source now
contains the six-panel workspace, native portal popouts, project settings and bundled-tool
integration. The baseline native data/admission rules remain. Earlier release checks do not
prove untested platform or installed-application behavior.

The desktop uses a compact editing workspace and a project-owned mod build without an external
compiler installation or template checkout. The root records fresh acceptance evidence before
reporting the release as validated.

## Workspace layout

Use the [design-system master](../design-system/mnsg-level-editor/MASTER.md) for visual and
interaction rules. Rooms occupy the left pane, Scene the center, and Hierarchy and Inspector
separate panes on the right. Assets and Console share bottom-center tabs. Each pane scrolls
its own content; the application toolbar stays visible.

| Pane | Contents and ownership |
| --- | --- |
| Rooms | ROM status, search, native room selection, new-room actions and cached import controls |
| Scene | Existing GPU viewport, frame/pick/gizmo controls, Pan/Tilt, focused WASD and visibility toggles |
| Hierarchy | Actors, derived Events, geometry and room-level selection; authored doors and entrances retain their identity |
| Inspector | Existing validated native/authored fields, saved/native recovery, room initialization and preview limits |
| Assets | ROM actor/geometry/sky cards, real thumbnails, diagnostic status, drag placement and Place at origin |
| Console | Bounded entries from actual operations, build output and diagnostics; source/severity filtering and Clear |

Resize with a pointer, keyboard separators or explicit controls. Provide Window actions to
reopen, pop out, redock, maximize and close a pane. Layout offers Default, Wide and Focus
presets, saved preferences and Reset. Keep layout, pane visibility, window bounds and camera
preferences outside project fingerprints and undo history. Closing a pane leaves the document
open; the main window retains the dirty-project close guard.

Default keeps the full editing arrangement. Wide gives Scene more horizontal space. Focus
prioritizes Scene while Window keeps hidden tools reachable. Reset must recover a usable
workspace from hidden panes, invalid saved sizes or a removed monitor. Preserve selection,
asset browsing and accepted previews through these operations.

The interaction model follows Unity's tabs, floating windows and layout menu, adapted to this
editor's six panes. It does not promise Unity's full docking system or arbitrary tab groups.
[Unity workspace reference](https://docs.unity3d.com/Manual/CustomizingYourWorkspace.html).

## Native popouts and shared state

Create real Electron windows for approved panel names through an allowlisted `about:blank`
request. Render each pane with a React portal from the single editor owner. Keep one project,
selection, operation lock, dirty fingerprint, saved snapshot and undo/redo stack. Child windows
must not mount another EditorPage or bootstrap their own ROM/project session.

Electron documents same-origin child access and notes that `about:blank` inherits the parent's
web preferences. Do not assume a child-specific override can remove that inherited preload.
Retain main-frame IPC sender checks: child senders get no direct ROM/file/build capabilities.
Reject unapproved window names, external URLs, navigation and webviews. Child closure follows
the opener's lifetime; main close/reload must clean up portals and GPU resources.
[Electron window-opening contract](https://www.electronjs.org/docs/latest/api/window-open).

Route edits and global Undo/Redo/Save through the shared owner. A stale whole-room draft must
resync or reject before it overwrites a newer edit. Busy and modal state applies across all
documents. Typing, IME, modifiers and focus guards remain part of keyboard routing; a shortcut
must produce one transaction, regardless of which pane owns focus.

Scene controls must use their canvas `ownerDocument` and `defaultView` for focus, pointer,
keyboard, visibility and blur handling. Capture a plain camera/target snapshot before moving
Scene between documents; restore it after remount without serializing Three.js objects. Cancel
active drags and gizmo previews before reparenting. Resize updates canvas size/projection while
retaining the camera and project. Dispose the old scene and thumbnail contexts on closure.

## Portable project-owned mod settings

Keep project format version 2 with an optional `mod` block whose schema version is 1. A project
stores logical manifest/input values and bounded PNG/icon attachments, not executable paths,
download URLs or permission to read host files. Preserve V1/V2 migration, project UUID, native
level fields and the legacy derived mod ID/output filename when settings are absent.

The GUI exposes the 18 fields recognized by the pinned RecompModTool parser. Both C/H export
and NRM building use the same resolved settings and attachment snapshot. A field displayed as
editable must affect the generated manifest or build; reject incompatible values before build.
The project name and mod display name can differ. Metadata edits participate in the existing
project dirty/save/undo model; workspace layout preferences do not.

### Complete field inventory

| Table | Field | GUI/build contract |
| --- | --- | --- |
| manifest | id | Valid mod identifier, separate from project UUID; preserve legacy default |
| manifest | version | Three U16 components; tool-supported label suffix when valid |
| manifest | display_name | Editable mod-menu name |
| manifest | description | Editable long description with TOML-safe escaping |
| manifest | short_description | Editable short description |
| manifest | authors | Ordered string list |
| manifest | game_id | Recognized string; require MNSG compatibility for generated native code |
| manifest | minimum_recomp_version | Three U16 components, no suffix |
| manifest | dependencies | Required dependency IDs or ID:version strings |
| manifest | optional_dependencies | Optional dependency IDs or ID:version strings |
| manifest | native_libraries | Tables with name and funcs; declarations do not install runtime libraries |
| manifest | config_options | Ordered Enum/Number/String tables for the pinned Goemon runtime |
| manifest | custom_gamemode | Recognized boolean; show that the pinned Goemon runtime ignores it |
| inputs | elf_path | Workspace-relative linked ELF path; builder must produce this exact path |
| inputs | mod_filename | Safe output basename without .nrm; packager/readback honor the value |
| inputs | func_reference_syms_file | Workspace-relative function table; check generated native symbols |
| inputs | data_reference_syms_files | Workspace-relative data-table list; emit the required key |
| inputs | additional_files | Declared project-owned attachments, safely staged and verified in the archive |

For each config option, expose `id`, `name`, `description` and `type`. Enum uses `options` and
`default`; Number uses `min`, `max`, `step`, `default`, integer `precision` and `percent`;
String uses `default`. Validate finite values, unique IDs/choices, consistent bounds and valid
defaults. The tool passes config tables through; the pinned runtime determines usable types.
Config metadata alone does not add behavior to generated C.

The pinned tool does not read a TOML `enabled_by_default` field. Do not expose that spelling as
an effective option. Bool/config-visibility features from newer runtime revisions are outside
this contract. Native-library names/functions describe runtime loading beside the NRM;
placing a DLL in an archive does not establish that runtime lookup will find it.

Import the icon through a trusted native file dialog, validate bounded decoded PNG content,
and store portable attachment bytes plus identity. Stage it as archive-root `thumb.png` through
`additional_files`; no TOML icon field exists. Reject duplicate/reserved archive basenames,
including `mod.json`, `mod_binary.bin` and `mod_syms.bin`. Avoid an unintended `thumb.dds`, which
the runtime selects ahead of PNG. Byte/pixel limits are editor policy, not native format limits.

## Owned build workspace and bundled tools

Materialize each project's generated template under
`userData/project-workspaces/<sha256-project-id>`. The trusted host chooses that root. Stage
generated C/H, linker/manifest files, bundled macro header, compatible US symbol tables and
declared attachments there. Project input paths are relative to this workspace and refer to
managed content. They cannot select host files, executables, scripts or arbitrary templates.
Keep outputs from project A separate from project B, including concurrent or stale completion.

Ship a lean offline runtime for each native host:

| Target | Selected tool build | Required host proof |
| --- | --- | --- |
| macOS ARM64, minimum 14 | LLVM 21.1.8 MIPS Clang + ELF LLD; pinned RecompModTool | Native ARM64 packaged offline export; dependency/minimum-OS audit |
| macOS x64, minimum 14 | Same pinned sources built for Intel | Native Intel packaged offline export; cross-packaging alone is insufficient |
| Windows x64 | Same pinned sources built for Windows | Native Windows packaged offline export; DLL/runtime closure audit |

Build only the compiler/linker/mod packager and required runtime dependencies. Put executable
resources outside ASAR and select them from trusted platform/architecture metadata. Existing
Homebrew binaries have local dylib/minimum-OS dependencies and cannot serve as the portable
bundle. No user-installed LLVM, Homebrew, Visual Studio, git or template checkout should be
required for the managed export flow. Ship local fonts and support files for offline startup.

Pin source revisions, binary hashes, platform/minimum OS, expected file paths and notices in a
bundle manifest. Verify resources before use. Readiness requires an actual MIPS compile, ELF
link, native hook/reference-symbol probe and NRM manifest/archive inspection; executable names
and `--print-targets` alone do not prove compatibility. Keep builds on fixed argument vectors
with a bounded environment/log/time budget and no project-supplied shell commands.

The selected source pins are LLVM `llvmorg-21.1.8`, N64Recomp
`ffb39cdad1da5de07eaaa48bd1db4a89a7986771` and Goemon's config runtime
`fc4592a31414daf0040c19907e0b1976b2e48a67`. Retain exact LLVM exceptions/third-party notices,
MIT notices for RecompModTool and its linked dependencies, header provenance and the symbol
tables' explicit redistribution basis. The bundle carries a dependency/license manifest and
pinned support provenance. Final package checks must verify the distributed copies and signatures.

Preserve native admission, preimage, allocation and symbol checks before compilation. Automatic
tools cannot make an unresolved actor, incompatible donor or invalid collision exportable.
The 0.2.6 water preview adds no new export admission. Retain the same original-definition
room-313 policy and rejection of changed-parameter/foreign contexts without a verified closure.

## Acceptance matrix

Current local evidence: the actual-ROM/GPU suite passed 336 of 343 tests with seven optional
export skips and no failures. The ARM64 package's bundled metadata/archive checks passed 5/5,
including all 18 fields, Unicode, PNG, uploaded symbols and additional files. Legacy-template
exports passed 30/30 using host LLVM. Production build, desktop smoke and 15 authoring
milestones passed, including C/H and bundled-tool NRM compilation.

The real-ROM workspace check passed 20 milestones. The ARM64 candidate passed strict deep
signature and 44-file tested-build parity checks; its no-ROM first boot passed six native panel
lifecycles, input/redock, child-IPC denial and main-close cleanup. It contains no ROM, project or
NRM. Its isolated real-ROM check restored 383 cached rooms, native selectors, four rooms' exact
texture toggle restoration and WASD. The package built an NRM with an empty PATH and blocked
HTTP/HTTPS. Installation passed strict deep signature and exact ASAR/tool-manifest parity;
source ROM, cache and ROM-profile hashes remained unchanged. The ARM64 standalone-tools CI
artifact passed an independent local smoke. Normal-profile interaction, manual cross-window
drag, Intel/Windows and remaining interaction scopes still need proof.

The October 5 continuation repeated the actual-ROM/GPU suite (336 passes, seven optional
export skips), installed ARM64 offline ROM/export check and five packaged-tool metadata tests.
It found and fixed draft submission on forced popout closure: losing native window focus
preserves a field draft, Enter submits it, and Escape discards it. The native recovery check
passed 11 milestones for process restart, saved layout/window sizes, off-monitor main/Scene
recovery and redock controls in six 360x300 popouts at 100%, 125% and 200% zoom. The real-ROM
workspace check passed 21 milestones, including exact restoration of four rooms' textures
after Scene relocation. The recovery check uses
an isolated no-ROM profile; it does not test room editing or gameplay.

A **LOCAL** status covers its named source, GUI or packaged-build observation. **PARTIAL**
identifies remaining observations in a broader gate. This matrix does not equate a candidate
build with an installed release or an editor check with gameplay.

| Gate | Required observation | Status |
| --- | --- | --- |
| Layout controls | Each named pane can resize by pointer, keyboard and explicit controls; Window reopen/popout/redock/maximize/close works | LOCAL GUI PASS |
| Presets and persistence | Default/Wide/Focus, Save/Reset and restart restore usable panes; corrupt/off-monitor preferences recover | LOCAL GUI PASS: presets/reload/corrupt storage/Reset, full process restart and off-monitor main/Scene recovery |
| Zoom and small windows | Native minimum size, compact popouts, wide screens and 125%/200% zoom keep actions and scroll areas reachable | PARTIAL: settings at 800/125% and 1000/200%, redock controls in all six 360x300 popouts at 100/125/200% passed; other content/monitor sizes pending |
| Camera/layout isolation | Resize/tab/preset/popout/redock retain camera and selection; fingerprint/history/dirty state stay unchanged | LOCAL GUI PASS |
| Real native windows | Electron creates approved OS windows; no duplicate project bootstrap/history; close/reopen/main-close/reload clean up children | LOCAL GUI/PACKAGE PASS |
| Shared edits and undo | Edit in popped Inspector; Undo/Redo from another window affect one document; stale drafts cannot overwrite newer edits | PARTIAL: Inspector/main Undo and uncommitted draft redock passed; concurrent stale-draft conflicts pending |
| Focus and modality | Correct child ownerDocument events, one shortcut transaction, typing/IME guards, global busy/modal lock and focus restoration | PARTIAL: typing/modal blocks and live child input passed; IME pending |
| GPU regression | Real rooms/actors, dual textures/TEXGEN and exact texture toggle restoration survive resizing and Scene redock without context leaks | PARTIAL: adopted native thumbnail, Scene rehost and four rooms' exact material-toggle restoration after relocation passed; full context leak accounting pending |
| Asset placement | Real cross-window drag and Place at origin insert trusted IDs; save/reopen/undo retain the graph and preview limits | PARTIAL: native Place at origin/Save/Undo passed; actual cross-window drag pending |
| Diagnostics | Console records real operations; Clear/filter is view-only; conditional/unsupported limits remain visible in cards/Inspector | LOCAL GUI PASS |
| Portable migration | Legacy V1/V2 fixtures preserve UUID, old mod ID/filename, ROM identity and all native/authored fields; new mod data roundtrips | PARTIAL: source migration and GUI graph roundtrips passed; full legacy GUI fixture matrix pending |
| All manifest fields | TOML parse and emitted mod.json match all 18 fields, ordered lists, dependency/native-library tables and supported config variants | LOCAL PACKAGED BUILD PASS |
| Input paths honored | Custom ELF/symbol paths/output filename resolve to managed workspace content and affect actual compile/package/readback | LOCAL PACKAGED BUILD PASS |
| Icons and attachments | Decode/reopen/hash roundtrip; NRM has exact valid thumb.png and declared members; reserved/duplicate/oversized members reject | LOCAL PACKAGED BUILD PASS |
| Project independence | A/B projects retain separate settings/workspaces/icons; Save As/switch/stale build cannot overwrite the other project | PARTIAL: settings Apply/Undo/Redo/Save/Reopen/Cancel passed; A/B and stale-build concurrency pending |
| Injection and corruption | Reject traversal, absolute/drive/UNC paths, symlink escapes, unsafe quoting, executable/URL fields, altered tool/symbol bundles | PARTIAL: source guards and packaged child-IPC denial passed; complete hostile-path runtime matrix pending |
| Admission regression | Invalid native preimages/dependencies/donors/budgets still reject after metadata edits; old output survives failed/cancelled builds | PARTIAL: source and 30 host-tool exports passed; failed/cancelled managed-output preservation pending |
| macOS ARM64 offline package | Clean profile, network off and host tools hidden; installed package uses bundled tools to compile/link/NRM and verify mod.json/ZIP | PARTIAL: real-ROM candidate builds passed with empty PATH and HTTP/HTTPS blocked; installed interactive checks pending |
| macOS Intel offline package | Same test on a native x64 host; audit architecture/minimum OS/libraries and verify output, without ARM/Rosetta substitution | PENDING |
| Windows x64 offline package | Same test on native Windows; spaces/Unicode/quoting paths and runtime dependencies work without installed LLVM/VS tools | PENDING |
| Packaging and onboarding | Own-ROM/cached-ROM paths, signed-package resource discovery and baseline project flows pass; no ROM/project/NRM/private assets bundled | PARTIAL: first boot/cached-ROM/signature/installed byte parity passed; normal-profile interaction pending |
| Release reporting | Source tests/build, three host compiler exports, package/installed UI and CI results have separate evidence; gameplay remains separate | PARTIAL: local/package/installation scopes separated; normal-profile and Intel/Windows evidence pending |

Do not install or launch generated NRMs as an acceptance shortcut. Builds and editor previews
do not prove Goemon64Recomp gameplay. The user chooses any mod installation/gameplay test.

## Source contract references

Current boundaries to preserve: `app/page.tsx`, `components/RoomViewport.tsx`,
`components/authoringState.ts`, `components/AssetLibrary.tsx`, `core/project.ts`,
`core/authoring/catalog.ts`, `core/export/nrm.ts`, `core/export/patch.ts`, `electron/main.ts`,
`electron/storage.ts`, `shared/types.ts` and `shared/mod-settings.ts`. Source under active
implementation needs fresh review; the planning inventory is not a frozen implementation proof.

- [Pinned tool parser](https://github.com/N64Recomp/N64Recomp/blob/ffb39cdad1da5de07eaaa48bd1db4a89a7986771/RecompModTool/main.cpp)
- [Pinned Goemon config/manifest parser](https://github.com/klorfmorf/N64ModernRuntime/blob/fc4592a31414daf0040c19907e0b1976b2e48a67/librecomp/src/mod_manifest.cpp)
- [LLVM source and license](https://github.com/llvm/llvm-project/tree/llvmorg-21.1.8)
- [Existing export bounds](export.md) and [room-authoring workflow](room-authoring.md)
