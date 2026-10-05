# Known limitations

The 0.3.0 workspace, authoring and ARM64 real-ROM candidate have local passing checks.
Installation passed signature/byte-parity checks; normal-profile interaction and other-platform
results remain outstanding. Consult the
[validation record](../README.md#package-and-validation-status) for completed scopes.

## Native scenes and actors

The latest native census comes from 0.2.6: 361 library candidates include 74 supported,
174 conditional, 19 nonvisual and 94 unresolved IDs, including seven partial previews.
A preview establishes bounded initialization and initial parts, not later visibility,
spawning, animation, contact behavior or gameplay. Native lighting, fog and filtering can differ.

World-room exports use verified donors 0–539; new rooms use unoccupied IDs 620–799. Special
minigame/Impact scenes need their own lifecycle proof. A clone can retain native BSP/collision
while you edit its visible mesh; choose Generate collision from geometry to replace that physics.
Sparse proximity moves remain within the original verified cell. Events and room initialization
are read-only, partial inventories; the editor does not provide an arbitrary native script editor.

The Water 0x249 previews finite flat initial setup, retaining placement and native scale 0.16.
Future waves remain unverified. Its existing original-parameter room-313/replacement policy
remains; changed parameters and foreign/new-room contexts reject without a completed closure.
Actor 0x07D fixes its surface transform and remains outside export admission. Read the
[water guide](native-water-actor-preview.md), [procedural guide](native-procedural-actor-preview.md)
and [export bounds](export.md).

## Workspace and portable settings

Layout controls and native popouts share one editor session. Layout preferences stay outside
project history; closing the main application closes its children. The workspace is a six-pane
layout, not Unity's full arbitrary docking/tab-group system. Local checks covered Scene camera,
redock, input and shared Undo. Actual cross-window drag, IME, off-monitor recovery and entire-app
restart remain unverified.

Each .mnsgproj remains authoritative. The app-owned build directory is regenerable output;
external edits there do not update the portable project. Settings and uploaded attachments
travel with the project, under bounded size and path rules. Project data cannot select a tool
executable, download URL, host file or arbitrary build script. Uploaded reference tables must
resolve the emitted native symbols; changing paths cannot bypass those checks.

## Mod metadata and libraries

The pinned tool recognizes 13 manifest and five input fields. The supported Goemon runtime
accepts Enum, Number and String. Config schema defines mod-menu controls; generated room patches
do not consume the values. Bool/config-visibility features from newer runtimes remain outside
this target. The tool emits custom_gamemode, but the pinned Goemon runtime ignores it.
The tool does not emit enabled_by_default from TOML.

The app normalizes uploaded PNG/JPEG icons to thumb.png, with a 2 MiB and one-megapixel limit.
Attachments permit 4 MiB per file and 6 MiB combined, within the project's encoded-size budget.
Those are editor policies. Native libraries load beside the NRM; uploaded matching sidecars
can be copied there, but names do not establish ABI/platform compatibility. A packaged library
inside the ZIP alone does not satisfy runtime loading.

## Build, platforms and gameplay

Bundled MIPS Clang/ELF LLD/RecompModTool remove external tool installation from the desktop flow.
Corrupt or mismatched bundles reject; repair/reinstall the application. Automatic tools preserve
native admission, resource budgets and preimage checks. Unsupported native contexts remain
unsupported even when the compiler is ready.

Package targets are macOS 14+ ARM64/x64 and Windows x64. Linux has no supported package.
The ARM64 candidate passed no-ROM/cached-ROM startup, bundled metadata builds and an NRM build
with empty PATH and blocked HTTP/HTTPS. The installed app matches that candidate; normal-profile
interaction and native Intel/Windows checks remain outstanding. Source tests, compile/link and
NRM archive checks do not prove Goemon64Recomp gameplay. For any handoff, record the output path,
affected rooms, changes and uncertainties. The user chooses mod installation and game testing;
this task does not launch the game or install generated NRMs.
