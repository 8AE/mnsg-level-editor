# Room initialization

Version 0.2.4 shows read-only native setup details in **Room initialization**. Open the
collapsible section in the **Room** tab or the room-level authored inspector. Select the room
rather than an individual mesh, actor, door or entrance to use the authored view. Expand
**Native sources** and its nested entries to inspect file, CPU/ROM address, byte length and
SHA256 provenance.

This section separates the room's resource-loading callback from the actor-backed **Events**
view. Opening it leaves project data and history unchanged.

## Inspect setup provenance

Inspect metadata presence, native donor, stage/local and geometry group/index, actor-data
source file, opaque callback identity, and resource IDs in their native loading order.
The callback has no spatial coordinates. The section adds no viewport marker, executes no
callback and offers no editable pointer or script field.

The supported US ROM has 383 decoded room records. Of those, 374 have File12 metadata with
one resource-loading callback each. Each callback passes an ordered, zero-terminated `u16`
file-ID list to the native resource loader. This complete inventory covers that finite setup
schema. It does not decode all game events, later actor callbacks or scenario scripts.

The other nine decoded records, IDs 540–548, have no File12 metadata. They alias ordinary
File11 geometry: 540–543 use IDs 90–93, and 544–548 use IDs 128–132. The section shows
that special alias and missing world metadata. Special scenes can have their own event setup;
a null world-metadata slot does not mean that the scene has no events.

## Native room and authored donor

An authored room keeps its own identity and names its native template/service donor. A new
room 620 cloned from House room 465 retains room 620 as its authored identity. The inspector
shows **Template room 465 provides initialization** and the donor's native setup evidence.
Vanilla metadata slot 620 is null. The inspector must not present
the donor's callback as an original native callback assigned to room 620.

For House 465, the room callback loads these resource IDs in order:

```text
96,100,1137,401,338,643,364,644,35,448,405,32,407,345,43,515,54,27,61
```

The earlier cold geometry/group load uses `127,240,241,253`. Keep the two stages distinct.
The lists describe original native/template provenance, not the generated mod's effective
resource plan. Export computes that plan from the authored roster and geometry.
Neither list measures live cache occupancy: previous tasks and hot visits can load or trim
resources. A visible model, a saved project and this setup inventory do not establish export
admission or later gameplay correctness.

## Events remain separate

Use **Events** to inspect the verified actor-backed switches, doors, mechanisms and triggers
and follow them to their source actors. Their future behavior can depend on native flags,
player contact, dialogue, camera state and newly created children. Room initialization
reports resource setup provenance; it supplies no complete event graph or arbitrary event
script editor.

If native source bytes fail the dispatch/list guards, the initialization inventory is
unavailable. The inspector does not infer a callback from a room name or geometry alias.
Opening the section leaves ROM bytes and project history unchanged.

Read [native room-dispatch evidence](native-room-authoring.md#room-resource-callbacks-and-actor-events)
for field widths, dispatch preconditions and native addresses. Follow the
[authoring guide](room-authoring.md) for editable rooms and [export details](export.md) for
resource admission and user gameplay validation.


## Editor checks

Four actual Electron cases checked native House 465, special geometry alias 540, a new authored
clone and an editable replacement. The checks preserved project history and reported no page,
console or process errors. A normal installed 0.2.4 launch also displayed House 465's exact
19 callback and four cold-load IDs. Read the
[validation record](../README.md#package-and-validation-status) for source and package results.
These checks inspect setup provenance; they do not
execute the game callback or establish later gameplay behavior.
