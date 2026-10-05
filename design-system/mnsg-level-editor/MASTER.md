# MNSG Level Editor design-system master

**Status: 0.3.1 editor checks passed; full interaction/gameplay acceptance PARTIAL.** The
source implements this six-pane design with native portal popouts. Nine follow-up real-ROM GUI
checks and the existing workspace suites passed. The installed ARM64 app passed offline export
and 11 native recovery milestones. Normal-profile checks confirmed compact asset spacing,
Source ROM settings and the material preview grid. All three native CI package checks passed,
including Windows installation and 11 recovery milestones per host. Physical Intel GPU and
Intel/Windows own-ROM editing remain separate.
The root retains final release decisions.

## Design direction and source fit

Build a compact charcoal editor for room and actor authoring. Keep native Scene imagery central,
field labels readable and tool locations predictable. Use dense lists, restrained borders and
a single selection accent. Avoid hero sections, marketing cards and decoration over the scene.

The root reviewed UI/UX Pro Max at commit `477bcb28c9812b385cb51a4605ddf30d7b2266e2`.
Its refined search returned Minimalism & Swiss Style, dense dashboard spacing and a developer
palette. Those traits fit the task. Its FAQ/Documentation Landing pattern failed the editor
requirement after one retry and was rejected. The root selected the editor layout below; do
not describe it as the skill's recommended FAQ layout. Use bundled Inter rather than its
remote font-import recommendation.

[Pinned skill source](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill/tree/477bcb28c9812b385cb51a4605ddf30d7b2266e2).
Use [Unity's workspace reference](https://docs.unity3d.com/Manual/CustomizingYourWorkspace.html)
for tab/window/menu behavior, adapted to this editor's six panes.

## Workspace composition

```text
Application toolbar: project/file/build actions | panel toggles | Layout
+-------------+-------------------------------+------------------+
| Rooms       | Scene                         | Hierarchy        |
|             | Native GPU viewport           +------------------+
|             | Selection/navigation controls | Inspector        |
|             +-------------------------------+                  |
|             | Assets | Console              |                  |
+-------------+-------------------------------+------------------+
```

Rooms stays left; Scene keeps the central work area. Hierarchy and Inspector have separate
resize controls and scroll regions on the right. Assets and Console use bottom-center tabs.
Keep the project title, dirty state and New/Open/Save/Export reachable when panes close or float.
Do not merge Hierarchy and Inspector back into a single fixed-height records pane.

Headers expose pop out, redock, maximize and close. Bottom tabs expose pop out/maximize and remain available; whole-region toggles hide the docked tools. Layout recovers hidden panels. Layout exposes Default, Wide,
Focus, Save and Reset. Closing a pane does not close the project. Reset must recover hidden
panes and saved bounds from an absent monitor. The complete interaction and acceptance
contract lives in the [workspace/build plan](../../docs/WORKSPACE-AND-BUILD-PLAN.md).

## Semantic surfaces and colors

Keep Once UI 2.0 ThemeProvider/LayoutProvider and semantic tokens in both main and portal
documents. The charcoal/Swiss direction is a visual target; raw search-result hex values are
not component tokens. Root-owned theme configuration determines the final neutral/brand choice.
Do not alter native material colors, ROM pixels or vertex RGBA to match the application theme.

| Role | Semantic source | Use |
| --- | --- | --- |
| Workspace background | page-background | Dark canvas around panes |
| Pane surface | surface-background | Rooms, headers, lists and Inspector |
| Boundary | neutral-border-medium | One-pixel panel lines and field boundaries |
| Primary text | neutral-on-background-strong | Labels, selected record names and values |
| Secondary text | neutral-on-background-weak | Metadata and hints after contrast measurement |
| Selection/focus | brand-on-background-medium, brand-border-medium, brand-alpha-weak | Selected rows, active tabs and focus rings |
| Warning/error | warning/danger semantic schemes | Visible text/icon plus color; retain full diagnostics |
| Hover | neutral-alpha-weak | Stable bounds; no scale or layout shift |

Normal text must reach 4.5:1 contrast; meaningful icons, separators and focus indicators need
3:1 against adjacent surfaces. Measure actual composed colors. A weak token name does not
prove readable contrast. Keep conditional/partial/unavailable/nonvisual wording beside status
color. Disabled controls use disabled semantics and explain unavailable actions where needed.

## Typography and density

Bundle Inter for offline use. Use normal or medium weights for fields and lists; reserve
semibold for pane titles and current selection. Use the local code font for native IDs, paths
and numeric diagnostics. Font loading must not call a remote service.

Use 13–14px readable desktop body/list text, at least 12px for secondary labels, and a compact
4/8px spacing rhythm. Keep pane headings distinct through weight and alignment rather than
all-caps tracking or oversized wordmarks. These are design targets to verify under zoom,
not permission to hide overflow or shrink diagnostic text.

Use vector icons from the existing icon registry, with stable sizes and accessible names.
Keep native thumbnails as actual ROM renderings with their preview status. Generic thumbnails
must not imply a resolved actor model. No emoji navigation icons or synthetic game imagery.

## Resizing, focus and responsive behavior

Each splitter needs a unique accessible name, orientation, current/min/max values and keyboard
controls. Pointer capture, cancel, lost capture and blur must terminate resizing without moving
the Scene camera or committing an edit. Add explicit size/collapse controls as alternatives
to dragging. Keep focused controls visible inside the correct pane's scroll region.

Use independently scrolling panes at compact widths. Preserve reachability through tabs,
Layout recovery actions and presets when simultaneous panes no longer fit. Test native minimum size,
small popouts, wide displays and 125%/200% zoom. Do not disable zoom or squeeze controls below
their readable size. Desktop controls need adequate pointer targets; touch adaptation requires
its own larger-target assessment rather than copying a mobile landing-page layout.

Keep selection and keyboard traversal stable through tab changes, maximization and redocking.
Closing a panel restores focus to its opener or region control. Separate tab labels from panel
actions and expose selected/expanded/pressed state. Inline form errors remain with their fields;
multiple-error submission focuses a linked summary. Console notices should not steal focus.

## Native window and Scene continuity

A popout is a real Electron window containing a shared-owner React portal. Provide local
styles/tokens and bundled fonts in its document. Main-frame file/build IPC remains restricted;
the child uses owner callbacks, not a second project API session. Keep the window allowlist
and lifecycle policy in the trusted host.
[Electron contract](https://www.electronjs.org/docs/latest/api/window-open).

Use Scene's ownerDocument/defaultView for focus, keyboard and visibility. Retain a plain camera
position/target snapshot through relocation and restore it without a project transaction.
Keep Pan/Tilt, textures and visibility independent of dirty/history state. Cancel a gizmo or
navigation gesture before moving the canvas. Avoid duplicate listeners and stale GPU contexts.

## Mod settings and build feedback

Group the settings GUI by identity/descriptions, dependencies/libraries, config options,
managed build inputs and icon/attachments. Use visible field labels, add/remove list controls,
inline validation and previews of effective names/paths. Advanced input controls must change
the actual workspace-relative build paths; no decorative editable fields with ignored values.

Expose Enum, Number and String with their type-specific fields. Label custom_gamemode as
recognized by the tool but ignored by the pinned Goemon runtime. Do not invent enabled_by_default
support.
Explain that config metadata creates menu settings, not new generated game behavior. Show the
current project icon and the effective archive-root thumb.png choice.

Build status shows actual managed tool readiness, build progress, output location and bounded
compiler/package errors. Keep resource-admission failures separate from tool failures. Never
turn a preview status into a build permission. Successful packaging is not a gameplay result.

## Motion and implementation rules

Use brief color/focus feedback and reduced-motion support. Avoid animated width/height during
interactive resizing, entrance sequences or perpetual loading decoration. Preserve input and
camera responsiveness while thumbnails and build logs update.

Use the installed Once UI `ai/manifest.json`, compact rules, layouts and matching task/component
slices before TSX composition. Use semantic Row/Column and static pane surfaces; reserve Card
for interactive content. The installed SplitView has internal split state and unmounts its
inactive collapsed pane. Do not assume controlled persistence/docking support: use a workspace
adapter and lifted Scene state when the product contract requires them.

## Review gates

The 20-milestone real-ROM check covered six native popouts, pointer/keyboard/button resize,
redock and input routing, shared edits/Undo, camera/WASD, Console and settings. Settings fields,
footer, scroll and Cancel passed at 800px/125% and 1000px/200%. The ARM64 no-ROM candidate
passed all six panel lifecycles and denied child IPC.

The October 5 continuation passed 21 real-ROM workspace milestones and 11 isolated native
recovery milestones. Those cover full-app restart, off-monitor main/Scene recovery, saved
window sizes, recovery controls in all six compact popouts through 200% zoom, and exact texture
toggle restoration in four rooms after Scene relocation. Forced closure preserves field drafts;
Enter submits them and Escape discards them.
The installed ARM64 copy repeated the 11 recovery checks after a fix that flushes pending
window-position writes before quitting.

Visual/release acceptance remains **PARTIAL**: measure contrast and wider pane/monitor sizes;
check IME and cross-window drag. Native ARM64/Intel/Windows package and recovery checks passed;
Intel's virtual guest checked the unavailable-WebGL diagnostic and native panes. Normal-profile
interaction, physical Intel viewport rendering and Intel/Windows own-ROM editing remain separate.
Use the [acceptance matrix](../../docs/WORKSPACE-AND-BUILD-PLAN.md#acceptance-matrix) for tested scopes.
The skill search and source checks do not establish those remaining observations.

## 0.3.1 follow-up

User feedback overrides the earlier Window menu: use direct panel/tab actions. Keep the material
preview visible in the Inspector and offer search in a thumbnail grid with native modal focus.
Selection outlines follow actual mesh/face topology; vertices use a screen-sized outlined marker.
Copy/Paste uses immutable snapshots and shared project history across native windows. Preserve
text-field clipboard behavior. ROM source controls belong in Settings, and Assets has no close
or duplicate Library button. Local source, nine own-ROM UI checks and native recovery passed;
platform/gameplay limits above remain separate.

## Multiple selection

Cmd/Ctrl-click toggles selection membership in the Scene and Hierarchy. Keep every selected
item outlined and show the selection count. The group Inspector exposes one shared offset,
and the move tool uses one shared pivot. Frame the entire selection. Shared vertices and
actor/event aliases translate once; one Undo restores every changed item. Keep selection
state through native panel relocation, and cancel unsaved previews when the canvas loses focus.
