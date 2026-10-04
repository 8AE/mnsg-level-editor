# Author rooms

Use the desktop app with your own supported US ROM. Version 0.2.2 adds native generated
texture-coordinate previews to the version 2 authoring workflow. The 14-milestone authoring
smoke passed with C/H export and the full House roster. Read the [validation
record](../README.md#package-and-validation-status) for source, GPU, package and installed-app
checks. Live gameplay remains open.

## Choose a starting room

Open a project and select a room whose native services suit your scene. Choose
**New room**, enter a name, and select one of these starting points:

| Choice | Starting contents |
| --- | --- |
| **Blank room** | Empty geometry, actors and collision, with a Start entrance at the origin. The current room supplies the native service template. |
| **Clone current room** | A copy of the current geometry, actors, entrances and environment under a new room ID. A native clone retains its original template physics. |
| **Make editable copy** in Geometry | An authored replacement at the existing room ID. You keep the current placements and native service template while gaining mesh editing. |

New room IDs use the project's available range 620 through 799. Export supplies
the required native admission hooks and resource setup. Choose a world room
from IDs 0 through 539 as the service template. Export checks its native
geometry mapping and each actor's resource context before generating files.

Version 2 projects retain version 1 sparse edits through migration. Converting
a room to an editable replacement brings its current edits into that room's
authored data. Other rooms can still share the original native geometry;
inspect them after a shared translation or an authored replacement.

## Build and edit geometry

Open **Asset library**, choose **Geometry**, and search names or IDs. You can choose a complete
room asset or a decoded component from your ROM. Drag a card into the viewport to place it, or
choose **Place at origin**. You retain its native material references when you edit the imported
triangles. Generated actor texture coordinates depend on normals and vertex-load state; the
exporter rejects flattening those models into static custom-door appearance UVs.

Choose a mesh in **Geometry**. The inspector has three selection modes:

| Mode | Edits |
| --- | --- |
| **mesh** | Enter **Translate by**, **Rotate degrees XYZ** and scale, then choose **Apply mesh transform**. Rotation and scale use the mesh center. You can duplicate the mesh or change its material. |
| **vertex** | Choose a vertex index and edit position, UV coordinates and RGBA color. Colors use four integers from 0 to 255. Use **Add vertex** or **Remove vertex & incident faces** to change the vertex list. |
| **face** | Choose a triangle index and edit its three vertex indices. Use **Add triangle** or **Remove face** to change topology. |

Press **T** to show the translation gizmo for the current editable selection.
You can move a whole mesh, one vertex, or the three vertices of a selected face.
Faces that share those vertices move with them. Use **F** to frame the selection.
Cancel a gizmo drag to discard its preview; release it to commit an undoable edit.

Use mesh rotation in degrees. Actor rotations and entrance heading use their
native units. You edit integer vertex positions within the native signed
16-bit range. The editor rounds transformed positions and rejects overflow.
Check winding after topology changes, especially on surfaces you intend to
use for collision.

## Choose the physics you want

Inspect the room's **Collision** status before changing its visual shape.
A native clone or editable replacement starts with **original template
physics**. You can edit its visible triangles while retaining the original
native collision. A blank room starts with authored collision and zero
triangles.

To replace that physics, set the raw collision classifier and surface fields,
then choose **Generate collision from geometry**. You create collision
triangles from the room's visual meshes and replace the prior collision set.
The editor reports skipped zero-area triangles. Classifier zero belongs to
clipping planes; authored face classifiers range from 1 to 255. Surface values
range from 0 to 65535. These are native attributes without a verified list of
material or hazard names.

After generation, **Update linked collision with mesh edits** keeps linked
triangles aligned with later vertex, face and mesh edits. Turn it off to edit
visuals while retaining those collision triangles. Enabling it on a mesh
without linked collision creates triangles with classifier 1 and surface 0.
You can also retain separate collision supplied by an imported geometry asset.

Test winding, landing and wall contact in the game before distributing an
export. Triangle generation and an editor preview do not prove that a modified
scene preserves the original room's physics.

## Place native actors

Choose **Actors** in the asset library. Cards include native actor IDs and
prototype variants. You can keep nonvisual controllers and unresolved seed
candidates in the catalog; read their diagnostic status before placing them.
The library uses your ROM's model and texture data for supported thumbnails.
You may see conditional, partial or unavailable previews for other paths.

The catalog contains 361 candidate IDs: 74 supported, 170 conditional,
11 nonvisual and 106 unresolved, including seven partial previews. Keep the
status visible when choosing a prototype; export requires a verified native
resource context in addition to a preview.

Falling Barrel (0x19A) and Slicer (0x19D) offer conditional previews of their first timed child.
Barrel has 36 textured triangles and two CI4 textures. Slicer's eight triangles use a 32 by 64
RGBA16 texture from File384 with native generated coordinates. Unknown inherited LookAt uses an
explicit conditional editor-camera basis; mixed or unsupported vertex state retains an
untextured fallback. These previews stop before movement or further emissions, and do not admit
edited or foreign contexts to export.

Drag an actor card into the viewport or use **Place at origin**, then edit its
position, native rotation and three unsigned payload words. Payload meanings
depend on the actor; resource IDs, pointers and script choices need the matching
native behavior. A thumbnail shows a bounded initialization path and initial
pose. Later animation, child actors and game-state-dependent visibility need
runtime checks.

The **Actor loading** field offers **Always loaded** and **Near player**.
The first uses the resident roster. The second builds a native proximity grid
for spawning and cleanup. Clones retain their source loading policy. Native
players and services share the actor pools and resource cache, so the number
of project records is not the number that can be active together. Read the
export validation result and check spawning and re-entry in the game.

Resident environment controllers affect room startup. Their edited values
apply in roster order; deleting them restores the exporter's explicit defaults:
map heading 0, void threshold -32768, white lighting and reset camera state.
Proximity environment controllers apply only when the native game spawns them.
The exporter uses the effective authored roster, including edits and deletions.

Hide **Geometry** below the viewport to inspect actors whose initial pose sits
behind room surfaces. You change only the view with that toggle.

## Add entrances and custom doors

In the room inspector, choose **Add entrance** and give it a name. Set its
spawn position, **Base heading (1024 units per turn)**, and **Camera-start mode
+ direction byte**. One revolution uses 1024 heading units. The camera-start
parameter combines a native startup callback group and direction; the common
value is 16. Values 0 through 39 fit the native callback table, but that bound
does not prove that each combination suits your room.

Choose **Add custom door**, then set its trigger position, rotation and
positive dimensions. Choose **Interact** or **Touch**, followed by a
**Destination room** and a **Destination entrance**. Select a native appearance
prototype or retain **Generated door box**. The appearance and trigger volume
have separate roles; placing a vanilla visual door actor alone does not create
this named destination link.

For **Interact**, press A inside the trigger volume on the controller assigned
to your current player. Activation uses a new button press. For **Touch**, enter
the trigger volume after leaving it at least once; arriving inside a volume
does not immediately send you back. The ordinary door transition queues an arrival while
retaining the existing player task, selected controller and character.

Keep at least one entrance in a new room. Relink doors before removing a
referenced entrance or reverting to a saved room that lacks it. You can use
verified native entrances offered by the destination selector, or add an
entrance to an authored destination.

The editor stores these links and shows their trigger volumes. Export includes
their runtime behavior. Check entry, exit and revisit in Goemon64Recomp before
distributing the mod.

## Set the sky

Use the room inspector's **Skybox** selector or the asset library's **Sky**
cards:

| Choice | Background |
| --- | --- |
| **Inherit template sky** | The native service template's background. |
| **No skybox** | No background. |
| A native sky asset | The selected ROM background and palette. |

The native sky is a scrolling bitmap. The editor approximates its camera
projection, so compare the final background in the game. Sky selection changes
neither mesh topology nor collision.

## Save and recover edits

Save a `.mnsgproj` file to retain authored rooms, asset references and sparse
edits. You keep your original ROM file intact. Reopen the project with the
matching ROM, and use Undo or Redo for edit history.

Select the room inspector to access recovery controls:

| Control | Result |
| --- | --- |
| **Revert room to saved** | Restore this authored room from the last saved project snapshot. Door links to missing entrances can prevent the operation. |
| **Restore native room** | Remove an authored replacement and return to native room data. You retain any sparse override from the saved snapshot. Relink doors that depend on authored-only entrances first. |
| **Clear room contents** | Clear geometry, materials, actors, doors and collision from a new room without a saved authored snapshot. Keep its entrances, identity and sky choice. |

For sparse native records, use their existing Reset controls to restore ROM
values. Save after reviewing a recovery operation if you want that state to
become your new saved baseline.

## Move around the viewport

Click the viewport to focus it. Hold **W/S** to move forward or backward and
**A/D** to move sideways. Choose **Pan** for left-drag panning or **Tilt** for
left-drag orbiting. Right-drag pans in either mode; scroll or middle-drag to
zoom. Press **G** to toggle the grid.

Typing in a field, opening a dialog, losing viewport focus or starting a camera
or gizmo drag clears held movement. Release the movement key and press it again
to resume. Camera navigation leaves project data unchanged.

## Check an export

Choose C/H to generate a source bundle, or configure the native toolchain for
`.nrm` output. Export validates geometry, native services and actor resources
before generating an authored room. A context with unresolved resource children
or progression requirements rejects the export. Simplify that room or choose a
verified prototype, then retry. Keep the saved project for further editing.

A save/reopen check or rendered preview confirms editor behavior. Compile and
package checks confirm the build path; gameplay needs a separate check.

A House 465 clone can preserve all eight native actors through guarded static
resource contracts for camera actor 0x308 and progression controller 0x34E.
Their nonvisual status does not mean they have no dependencies. The desktop authoring smoke retained all eight in a room 621 clone, verified
File96 in its inventory, and exported C/H and `.nrm`. The compiled full-roster
room 620 handoff includes their resources and a native coin, copied House
geometry/BSP and reciprocal checker doors. Test the camera and progression
behavior in your save; static closure does not establish gameplay parity.

Other unresolved contexts still reject export with a diagnostic. Resolve the
reported dependency or remove the actor through the inspector before retrying.
Export keeps rejected actors in the project until you choose to remove them.

Build the app, then run the authoring integration check with your own ROM:

```sh
MNSG_TEST_ROM=/path/to/us-rom.z64 \
  MNSG_TEST_TEMPLATE=/path/to/initialized/template npm run test:authoring
```

The default check requires C/H export. `MNSG_TEST_TEMPLATE` adds optional
`.nrm` compile/link checks. `MNSG_SMOKE_UI_ONLY=1` runs an editor checkpoint and
leaves export verification pending.

Read [export details](export.md) for the toolchain, and
[native room authoring](native-room-authoring.md) for the native layouts and
remaining lifecycle requirements. You install and test a generated mod in your
chosen Goemon64Recomp profile. Check entry, collision, camera behavior, actors,
exit, teardown and revisit before sharing it. The team has not established
those gameplay results for the current authored-room work.

Keep ROMs, decoded game assets and generated test mods out of source control.
The application code uses the repository's MIT license; retain the existing
upstream and dependency attribution when distributing it.
