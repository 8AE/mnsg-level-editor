# Native water actor preview

The 0.2.6 water increment adds an initial surface for **The Water (Husband and Wife Rocks)**,
actor **0x249**. Its canonical placement appears in native room **313**. The surface has
392 textured triangles and remains conditional. The preview adds no export admission and
establishes no foreign-room resource readiness or future wave behavior.

## Inspecting the water

Import your supported US ROM, or reopen the editor with its existing verified cache. Select
room 313, then actor 0x249. Use **F** to frame the selection. Choose **Pan** or **Tilt** below
the viewport, or focus the viewport and hold **W/A/S/D** to move the camera. Toggle **Textures**
to compare the native initial material with solid geometry. Camera and visibility controls
leave your project unchanged.

You can also inspect its actor-library card and place a record in an authored room. Saving,
undo and redo preserve that record. An initial preview in your project does not establish that
the game's native resources or pools will be ready in the destination room.

| Field | Canonical room 313 value |
| --- | --- |
| Position | [0, 53, 0] |
| Raw phase angles | [0, 0, 0] |
| Scale | Float32 0.16 on each axis |

The constructor retains the record's position and angles and sets scale to 0.16. The library's
origin preview uses its own record position; it does not reproduce canonical room occupancy.
This differs from [actor 0x07D](native-procedural-actor-preview.md), whose constructor fixes
its visual transform. The water actor is a procedural display, separate from editable room
geometry and authored collision.

## Initial native setup

Actor 0x249 uses dynamic File25 constructor `08000668_6ADA28`, main surface setup
`80024160_24D60`, then finite File25 callback `080000D8_6AD498`. The guarded offline evaluation
executes 80,382 instructions within a scoped 200,000 limit. It creates two identical
225-vertex buffers and two lists, each drawing a flat 14 × 14 cell grid with 392 triangles.
Local vertex Y is zero; the canonical object position keeps the surface at Y53.

D8 writes four deferred heightfield cells after the vertex buffers exist. It leaves the
initial vertices, commands and object transform unchanged. The preview stops before main
`80025B38_26738` and File25 `0800038C_6AD74C`, which later update waves, normals and material
scrolling. The raw result retains `completed=false`.

This boundary describes finite initial setup. It does not establish the first water frame
that the game displays, contact behavior, later animation or gameplay correctness.

## Two native texture samples

The constructor needs completed resource banks 353 and 338. The initial material samples the
64×32 RGBA16 image produced from PIC82DF in bank 353. Bank 338 remains a real constructor
resource, even though this initial material does not sample its auxiliary image.

Two ordered native texture loads wrap through 4 KiB of TMEM. The resulting tile0 image has a
16-row cyclic rotation; tile1 retains the original image. Both repeat over 64×32, with mask
values 6/5. Their quarter-texel origins differ, so the two samples use distinct fractional UVs.
The preview must preserve those images and coordinates rather than bake one multiplied bitmap.

The native two-cycle mux `FC111404 / FFFFFFFB` computes RGB as texture0 × texture1 × shade.
Final alpha comes from primitive alpha, 208/255. The initial sampled images are opaque,
which satisfies the native first-cycle threshold comparison for any legal inherited threshold.
This evidence does not admit arbitrary transparent replacements or guessed blend state.
Native lighting, fog and three-point filtering remain appearance approximations.

## Context and export limits

The finite evaluation supplies an owned task/object, a bounded arena and completed resource
reconstructions. It checks source preimages, allocation and read/write spans, then stops at
the callback fence. These isolated capacities do not recover the game's live registry,
object-pool occupancy or loader scratch pressure. Missing or altered resources and exhausted
storage require rejection.

The 0.2.6 actual-ROM/toolchain/GPU suite passed all 315 tests without failures or skips. It
includes setup/resource rejection, retained transforms, fenced future callbacks and dual-sample
material checks. Actual Electron inspection checked canonical room 313, readable library
thumbnails, drag placement into room 620 and save/undo/redo. Texture off/on restored exact
pixels, with no page, console or process errors. Source builds and isolated ARM64 package smoke
passed. The installed ARM64 0.2.6 app matched the candidate and restored the normal ROM cache.
Room 313 displayed textured water; its library card retained the conditional/future-wave limits.
Pan/Tilt responded without editing the project, and source ROM, cache and ROM-profile hashes
stayed unchanged.
Read the [validation record](../README.md#package-and-validation-status) for completed release
results and [actor evidence](native-actors.md#version-026-water-preview) for coverage boundaries.

This increment creates no new generated NRM. The existing canonical-context export policy
accepts water's original three parameter words in native room 313 or a replacement with room
ID 313 and template 313. You can edit its position and angles within that context; those
transform edits do not establish future wave or contact correctness. Changed parameters and
foreign/new-room contexts, including a new room that uses donor 313, reject without a completed
resource closure. The raw preview remains incomplete and grants no additional admission.

Future wave callbacks, live resource readiness and gameplay require separate evidence. The
user chooses whether to install and test generated mods in Goemon64Recomp.
