# Native procedural actor preview

Version 0.2.5 adds an initial surface preview for **Actor 0x07D**. You can inspect its library
card and place its record in an authored room. The editor shows one conditional part with
392 textured triangles. Export rejects this actor because its fixed-stage and future callback
requirements remain unresolved for authored rooms.

## Inspecting the surface

Open the actor library, find Actor 0x07D and read its conditional diagnostic. Drag the card
into an authored room or choose **Place at origin**, then select the actor to inspect its part.
You can save the project and undo or redo the record placement.

The native constructor overrides the visual transform:

| Field | Native initial value |
| --- | --- |
| XYZ | [10, 0, -300] |
| Raw phase angles | [256, 0, 0], with 1024 units per turn |
| Scale | Float32 0.2 on each axis |

Dragging the record or editing its transform does not reposition this surface. Those controls
still edit the saved actor record; the constructor sets the same visual XYZ, angles and scale
on the next preview. Use **F** to frame the selected actor, or camera controls to inspect it.
This preview does not make the surface editable room geometry or generate collision for it.

No canonical native placement of 07D appears in the audited room roster. Its library card uses
an explicit isolated setup context. The verified File15 parent belongs to an options/settings
path; the editor assigns no official actor name or global scene label from that caller.

## Native setup and stop point

The editor executes fixed File15 constructor `801CC978_65F828`, then main
`80024160_24D60`. Native helpers build two 225-vertex buffers and command lists for the same
initial flat grid: 14 × 14 cells, two triangles per cell, for 392 triangles. The initial vertex
Y is zero, with generated signed UVs, normals [0,127,0] and alpha 255. Native setup installs
one buffer as the object's material.

The object uses an END-only model list at `C006D308`. Its generated inline material carries
vertex and triangle commands, so that empty root list does not imply a mesh-free controller.
The captured part uses direct slot -1 rather than an inferred model-registry slot.

The bounded canonical run executes 80,083 MIPS instructions under a scoped 200,000 limit.
It leaves these callbacks pending:

- Main `80025B38_26738`, the future surface update.
- Fixed File15 `801CC710_65F5C0`, the later heightfield callback.

The editor advances no future frame or wave update. It keeps the raw initializer result
`completed=false` and the preview conditional. The initial setup does not establish the first
surface that the game displays, later movement or gameplay behavior.

The actor registry lists codeFile25, while the constructor bytes belong to fixed File15.
The preview records source files 15 and 1229. These identities describe different native
namespaces; a registry code-file value cannot substitute for fixed-overlay readiness.

## Image and material

Native File4CD, decimal 1229, has a 0x2D10-byte post-processed allocation. Native resource
loading decodes two PIC images into its tail. The surface uses PIC8679 at segment address
`08001D10`, a 64×32 RGBA16 image. The sprite descriptor path uses the separate PIC8678 image
at `08000D10`; the editor preserves that distinction.

The native tile extent covers 64×32 texels. Mask S/T values 6/6 establish a 64×64 sampling
period, with TMEM wrap repeating the 32 image rows. The decoded preview texture therefore
spans 64×64. This repeat comes from native tile state rather than an enlarged source bitmap.

The guarded one-cycle combiner `FC127E24 / FFFFF7FB` computes RGB as texture × shade and
alpha from primitive alpha, 128/255. Primitive RGB and texture alpha do not enter that mux's
output. The renderer retains source pixels and uses a separate opaque-alpha texture variant
for this material expression. Native lighting, fog and filtering remain approximations;
the expression and sampling period do not establish pixel-identical game rendering.

## Owned memory and readiness

The preview uses a fresh owned task, one reset-template kind-2 object and a bounded linked
arena. It executes native `119D4`, `35DFC` and `35D8C` object setup: pop the pool record,
prepend it to the task, update the active counter and initialize the empty-list tail. Object
type byte +04 remains 2; draw bucket byte +05 changes to 3 in the constructor.

Ten guarded arena requests total 22,208 payload bytes and 22,784 charged bytes under native
`(payload + 0x4F) & ~0x3F` alignment and trailing headers. Successful allocation zero-fills the
payload and padding. The surface initializer writes vector X=0 and Y=1 but leaves Z untouched;
its zero value in this context comes from allocation, not an explicit surface-Z store.

The editor reconstructs File4CD before entry and checks read-only resource bounds, exact helper
callers and allocation sizes. Missing resources, exhausted object/arena capacity, changed
preimages or unowned reads/writes cause rejection. The supplied isolated capacities do not
establish live registry occupancy, native task/pool availability or loader scratch pressure.

## Validation and export limits

Focused tests cover both vertex/command buffers, resource hashes, native transform overrides,
allocation failures, changed guards, private-memory ownership and the callback fence. Separate
Electron/GPU checks cover the library card, mapped surface, drag/drop, save and undo/redo.
Read the [validation record](../README.md#package-and-validation-status) for each release's
source, package and installed-app checks.

A saved project preserves the actor record, but C/H and `.nrm` export reject 07D. This preview
supplies no foreign-room or fixed-stage resource admission. Future callbacks, live scene
readiness and gameplay require separate evidence. No game or generated NRM ran to validate
this initial preview.

Read [actor coverage](native-actors.md#version-025-procedural-preview-and-coverage),
[native room evidence](native-room-authoring.md#editor-025-procedural-setup-boundary) and
[export constraints](export.md) for the related boundaries.

## Related water surface

Version 0.2.6 adds the [0x249 water preview](native-water-actor-preview.md) for the actor in
native room 313. It retains the record's placement and uses a different dynamic constructor,
material and callback path. This 07D guide describes its fixed transform and File15 scope;
do not transfer those assumptions to 0x249. Both previews stop at finite initial setup. The
water preview adds no export closure; its existing original-definition, same-room policy
remains separate from 07D's rejection.
