# Full room authoring

The editor must support complete room construction and export, alongside the
existing sparse actor edits and shared-room translation. The goal includes
editable geometry, new rooms, an actor thumbnail library with drag and drop,
custom door destinations, native skyboxes and a reusable geometry library.
A saved preview alone does not complete this work.

## Project and scene contract

Version 2 projects retain version 1 sparse overrides and add full authored rooms
keyed by canonical numeric room ID. Loading a version 1 project must preserve
its metadata, actor edits and geometry translation while migrating its format.
The editor must include authored data in dirty tracking, undo, redo, reset and
atomic project persistence.

A full authored replacement owns that room's geometry, collision, actor list,
doors, entrances and environment. A sparse override and full replacement for
the same room require an explicit conversion; the backend must reject ambiguous
precedence. Shared vanilla geometry remains shared until a full replacement
creates independent compiled resources.

Projects contain data and stable asset references. They cannot select native
pointers, executable commands, filesystem paths or raw ROM payloads. The backend
resolves each actor prototype, material, collision surface and skybox against the
imported ROM. It must check scalar widths, references and memory budgets before
composing a scene or exporting it.

The same 16 MiB encoded limit applies to IPC, project saves and project opens.
Each authored room may contain at most 16,384 vertices, 32,768 visual triangles
and 4,096 combined actor/door placements. Explicit collision is limited to 9,362
triangles, with face classifiers 1–255; zero is reserved for clipping planes.
Native compiled allocation and table
limits require separate export checks.

`collisionMode: "template"` keeps the donor's original native BSP and requires
an empty authored collision array. Visual edits then leave native physics
unchanged, with a preview warning. `collisionMode: "authored"` uses explicit
collision triangles; an empty array means no physics. Native clones start in
template mode. A blank room starts in authored mode. Optional template-only
`collisionTranslation` preserves a prior shared-room translation when its visual
vertices become editable. The backend validates native bounds and planes before
copying and translating the donor BSP privately. It does not reconstruct native
physics from visible polygons.

Authored actor placements can select resident or proximity spawning. Native
clones preserve each source placement's policy; library defaults come from its
canonical prototype. New proximity placements require a rebuilt native spawn
grid. Export must reject them until that grid format and lifecycle are verified.

An omitted `skyboxId` inherits the donor background. `null` clears it. A stable
native skybox ID selects a replacement. Entrance records use the native packed
startup behavior/direction parameter and a signed base heading in 1024 units
per turn. The heading supplies native body orientation and the camera baseline;
there is no independent entrance Euler rotation.

## Deliverables and acceptance gates

| Area | Required result | Evidence before completion |
| --- | --- | --- |
| Geometry | Editable indexed triangles, per-vertex position/UV/color, materials and explicit collision triangles with surface metadata | Round-trip project tests, real textured preview and compiled native render/collision records with winding and bounds checks |
| New rooms | Create blank rooms or clone existing rooms; assign an unoccupied ID and entrances/spawn data | Verified room-loader admission, resource staging and owned room metadata; safe transitions without out-of-range graphics-table access |
| Actor library | Native prototype thumbnails, parameter-aware previews and drag/drop placements outside the original room roster | Authoritative initializer/resource dependencies, composed actor-list export and bounded asset loading; unsupported constructors remain explicit |
| Doors | Generated door records with destination room/entrance and trigger dimensions | Verified native door callback, destination encoding and lifetime; generated collision/trigger resources agree with preview |
| Skyboxes | Select and preview native environment assets | Verified bitmap/material format, room staging and cleanup; no invented background image substitutes |
| Geometry library | Browse and place pre-existing native geometry while retaining material provenance | Stable ROM-backed asset identity, alias handling, texture/resource dependencies and editable imported triangle data |
| Export | C/H bundles and optional compiled `.nrm` include every authored room feature | Export manifest, compiler/linker checks and explicit rejection of unsupported features; no silent omission |

The current reader has verified 383 room records and 378 visual rooms. Those
counts do not establish safe admission of a new room. Candidate unused IDs in
the native table require loader, graphics-group, collision and resource-lifetime
research before a generated patch can claim support.

## Validation boundaries

Unit tests must cover version 1 migration, hostile project fields, forged asset
references, unknown rooms/entrances, scalar overflow, degenerate triangles,
oversized input and collision/material mismatch. Composition tests must prove
that authored replacements and original sparse edits retain their intended
actors, events, transforms and textures. Native desktop checks must exercise
save/reopen, editing, drag/drop, thumbnails, undo/reset and exported source.

Compilation and an editor preview do not establish game behavior. Exported
assets must pass native format/lifecycle checks and report remaining gameplay
risks. The user installs and tests generated mods in Goemon64Recomp; agents must
provide the `.nrm` path, affected room IDs and exact changes without installing
or running those mods.

## Native risks to resolve

- New IDs can bypass valid graphics-array bounds or fail room resource selection.
  Generated metadata and hooks must cover each access before admitting a room.
- Actor constructors can read save state, collision, room-local overlays and
  other actor handles. A thumbnail does not prove that resource staging or
  runtime spawning is safe.
- Display lists require compatible vertex batches, texture/palette bindings,
  native UV widths and material state. Reject overflow instead of clamping.
- Collision needs verified plane, triangle, grid and surface records. Preserve
  triangle winding and keep collision edits explicit.
- Native doors and skyboxes have lifecycle and ownership requirements beyond
  their visible geometry. Research each callback and cleanup path.
- Large authored scenes can exceed native heap or renderer budgets. Enforce
  project and per-room limits, then validate compiled resource sizes.

See [native-formats.md](native-formats.md),
[native-actors.md](native-actors.md), [native-textures.md](native-textures.md)
and [runtime-validation.md](runtime-validation.md) for the existing evidence.
