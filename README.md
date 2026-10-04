# MNSG Level Editor

Browse textured rooms and edit actor placements from the US version of
**Mystical Ninja Starring Goemon**. Use the desktop app on macOS or Windows,
save your changes as projects, and export patches for
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

- **Rooms:** browse 383 native room records, including 378 rooms with decoded
  visual geometry. View original static textures, UVs, indexed palettes and
  supported material alpha. Toggle textures, wireframe and record markers;
  drag to orbit, right-drag to pan, and scroll to zoom.
- **Actors:** inspect source records and edit position, raw rotation values,
  actor type and three unsigned 32-bit payload words. Choose replacement types
  from the room's original actor roster. Proximity actors can move within their
  verified original spawn cell; cross-cell moves require a future grid migration.
- **Events:** inspect derived actor-backed switches, doors, mechanisms and
  other classified triggers. Follow each event to its source actor to edit its
  placement. Event descriptions are read-only; this view covers the verified
  classifications, not a complete room-script inventory.
- **Room translation:** move supported static visual geometry and collision
  together by an integer offset within the inspector's bounds. Rooms sharing
  a source receive the same translation. Actors, entrances and camera paths
  retain their positions. Vertex deformation and topology editing remain future
  work.
- **Projects:** save sparse edits and the ROM identity in `.mnsgproj` files.
  Reopen projects, undo or redo changes, and reset records against the imported
  ROM. Projects contain no complete ROM.

The viewport uses actor markers in place of character models. Native lighting,
fog, filtering, animation and blending can differ from the game. Use the preview
to inspect static surfaces and placements; test exported changes in Goemon64Recomp
before distributing a mod. See [texture evidence](docs/native-textures.md) and
[room translation limits](docs/room-geometry-editing.md).

Payload meanings depend on the actor and can include resource IDs or pointers.
Changing a payload word requires understanding that actor's native behavior.

## Export a mod

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
any tools the editor cannot find. The exporter compiles your actor edits and
supported room translations into a `.nrm` file. You install and test that file
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

# Optional renderer fixture; requires an installed Google Chrome.
MNSG_GPU_TEST=1 node --import tsx --test tests/editor-textures.test.ts
```

The desktop smoke checks ROM import and cache reuse, editing, save/reopen,
validation failures, textured rendering and source export. Set
`MNSG_TEST_TEMPLATE` to include `.nrm` compilation. Build the app before running
this smoke test.

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

Find installers in `release/`. The CI workflow has macOS ARM64, macOS x64 and
Windows x64 build targets. Distribution builds need signing and notarization
credentials for a signed macOS release, or code-signing credentials for Windows.

| Platform | Current evidence |
| --- | --- |
| Apple Silicon macOS | Desktop and packaged-app smoke passed with a user-supplied US ROM, textured rooms, project edits and exports. |
| Intel macOS | ZIP build passed; runtime testing remains open. |
| Windows x64 | NSIS installer build passed; runtime testing remains open. |

Compile, link, package and editor checks do not establish in-game collision,
reload behavior or compatibility with other mods. Test the affected rooms and
their shared sources in Goemon64Recomp before releasing an export.

## Source and native evidence

| Directory | Contents |
| --- | --- |
| `core/rom/` | ROM identification, decompression, native records, geometry and texture decoding. |
| `core/project.ts` | Project schema and native edit validation. |
| `core/export/` | Patch generation and the optional `.nrm` toolchain. |
| `electron/` | Sandboxed IPC, file dialogs, ROM cache and atomic project writes. |
| `app/`, `components/` | Once UI workspace and Three.js viewport. |

Read the [native formats](docs/native-formats.md),
[texture research](docs/native-textures.md) and [roadmap](docs/ROADMAP.md) for
verified layouts and remaining work. Native symbol references also live in the
[MNSG API documentation](https://8ae.github.io/mnsg-documentation/).

Keep ROMs, decoded assets, credentials and generated test mods out of source
control. The application source uses the [MIT license](LICENSE).
