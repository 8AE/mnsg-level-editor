"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Column, Row, Spinner, Text } from "@once-ui-system/core";
import { FiArrowUpRight, FiBox, FiCheck, FiChevronRight, FiCornerUpLeft, FiCornerUpRight, FiDownload, FiFolder, FiGrid, FiLayers, FiMaximize, FiMove, FiPlus, FiSave, FiSearch, FiSettings, FiUpload, FiX } from "react-icons/fi";
import type { ActorOverride, AppApi, AppStatus, EditorProject, EventOverride, RoomData, RoomSummary, Vec3 } from "../shared/types";
import RoomViewport, { type ViewOptions } from "../components/RoomViewport";
import Inspector from "../components/Inspector";
import RoomInspector from "../components/RoomInspector";
import { roomTextureCoverage, type RenderTextureCoverage } from "../components/roomMaterials";
import { applyOverrides, checkedActorPosition, checkedGeometryTranslation, checkedPosition, countProjectChanges, effectiveGeometryTranslation, sampleRoom, sharedGeometryImpacts, withGeometryOverride } from "../components/editorModel";
import "./editor.scss";

type Modal = "new" | "export" | "discard" | null;
const fingerprint = (project: EditorProject | null) => project ? JSON.stringify({ name: project.name, roomOverrides: project.roomOverrides }) : "";
const messageOf = (error: unknown) => error instanceof Error ? error.message : "The operation could not be completed.";
const initialOptions: ViewOptions = { textures: true, grid: true, axes: true, wireframe: false, actors: true, events: true, translate: false };

function ModalShell({ title, children, onClose }: { title: string; children: React.ReactNode; onClose(): void }) {
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const element = dialog.current;
    element?.querySelector<HTMLElement>("input,button")?.focus();
    const keys = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "Tab" && element) {
        const items = [...element.querySelectorAll<HTMLElement>("button:not(:disabled),input:not(:disabled),[tabindex='0']")];
        const first = items[0], last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener("keydown", keys);
    return () => { document.removeEventListener("keydown", keys); before?.focus(); };
  }, [onClose]);
  return <div className="modal-backdrop"><div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="modal-title" className="editor-modal"><Column background="surface" border radius="l" padding="32" gap="24"><Row horizontal="between" vertical="center"><Text id="modal-title" variant="heading-strong-l">{title}</Text><Button size="s" variant="tertiary" aria-label="Close dialog" onClick={onClose}><FiX /></Button></Row>{children}</Column></div></div>;
}

export default function EditorPage() {
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [booting, setBooting] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [baseRoom, setBaseRoom] = useState<RoomData | null>(null);
  const [project, setProject] = useState<EditorProject | null>(null);
  const [saved, setSaved] = useState("");
  const [sample, setSample] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [roomSearch, setRoomSearch] = useState("");
  const [recordSearch, setRecordSearch] = useState("");
  const [tab, setTab] = useState<"actors" | "events" | "room">("actors");
  const [options, setOptions] = useState(initialOptions);
  const [frame, setFrame] = useState({ version: 0, selected: false });
  const [renderCoverage, setRenderCoverage] = useState<RenderTextureCoverage>({ roomId: -1, textured: 0, total: 0, images: 0, warnings: [] });
  const [past, setPast] = useState<EditorProject[]>([]);
  const [future, setFuture] = useState<EditorProject[]>([]);
  const [modal, setModal] = useState<Modal>(null);
  const [newName, setNewName] = useState("Untitled project");
  const [exportKind, setExportKind] = useState<"patch" | "nrm">("patch");
  const deferred = useRef<(() => void) | null>(null);
  const loadSequence = useRef(0);
  const busyLock = useRef(false);
  const room = useMemo(() => baseRoom ? applyOverrides(baseRoom, project) : null, [baseRoom, project]);
  const dirty = fingerprint(project) !== saved;
  const api = () => {
    const bridge: AppApi | undefined = window.mnsg;
    if (!bridge) throw new Error("ROM import and project files require the desktop application. Open MNSG Studio for macOS or Windows.");
    return bridge;
  };
  const run = useCallback(async (label: string, task: () => Promise<void>) => {
    if (busyLock.current) return;
    busyLock.current = true;
    setBusy(label); setError(""); setNotice("");
    try { await task(); } catch (issue) { setError(messageOf(issue)); } finally { busyLock.current = false; setBusy(""); }
  }, []);
  const loadRoom = async (id: number) => {
    const sequence = ++loadSequence.current;
    await run("Loading room", async () => {
      const data = await api().loadRoom(id);
      if (sequence !== loadSequence.current) return;
      setBaseRoom(data); setSelected(null); setFrame({ version: 0, selected: false });
    });
  };
  const acceptProject = (value: EditorProject) => { setProject(value); setSaved(fingerprint(value)); setPast([]); setFuture([]); setSample(false); };
  const readWorkspace = async (value: AppStatus, projectValue?: EditorProject) => {
    setStatus(value);
    if (!value.rom) return;
    const currentProject = projectValue ?? value.project ?? await api().newProject("Untitled project");
    acceptProject(currentProject);
    const list = await api().listRooms(); setRooms(list);
    const requestedId = Number(Object.keys(currentProject.roomOverrides)[0]);
    const first = list.find(item => item.id === requestedId) ?? list[0];
    if (first) { setBaseRoom(await api().loadRoom(first.id)); setSelected(null); }
  };
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        if (window.mnsg) {
          const value = await window.mnsg.getStatus();
          if (active) await readWorkspace(value);
        }
      } catch (issue) { if (active) setError(messageOf(issue)); }
      finally { if (active) setBooting(false); }
    })();
    return () => { active = false; };
    // Import happens once through the native desktop bridge.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const leave = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", leave);
    return () => window.removeEventListener("beforeunload", leave);
  }, [dirty]);
  const guard = (task: () => void) => { if (dirty) { deferred.current = task; setModal("discard"); } else task(); };
  const importRom = () => guard(() => { void run("Importing ROM", async () => { const value = await api().importRom(); if (value) { await readWorkspace(value); setNotice("ROM imported. Your source file stays unchanged."); } }); });
  const openProject = () => guard(() => { void run("Opening project", async () => { const value = await api().openProject(); if (value) await readWorkspace(await api().getStatus(), value); }); });
  const saveProject = async () => {
    if (!project || sample) return;
    await run("Saving project", async () => { const result = await api().saveProject(project); if (result) { setProject(result.project); setSaved(fingerprint(result.project)); setNotice(`Saved ${result.fileName}`); } });
  };
  const saveAndContinue = async () => {
    let next: (() => void) | null = null;
    await run("Saving project", async () => {
      if (!project) return;
      const result = await api().saveProject(project);
      if (!result) return;
      setProject(result.project); setSaved(fingerprint(result.project));
      next = deferred.current; deferred.current = null; setModal(null);
    });
    // Release the native-operation lock before the deferred file operation starts.
    (next as (() => void) | null)?.();
  };
  const edit = (kind: "actors" | "events", id: string, value: ActorOverride | EventOverride | null) => {
    if (!project || !room || sample || busyLock.current) return;
    const entity = kind === "actors" ? room.actors.find(actor => actor.id === id) : room.events.find(event => event.id === id);
    if (!entity?.editable) return;
    const roomKey = String(room.id);
    const overrides = project.roomOverrides[roomKey] ?? { actors: {}, events: {} };
    const records = { ...overrides[kind] };
    if (value === null) delete records[id]; else records[id] = { ...records[id], ...value };
    const updatedRoom = { ...overrides, [kind]: records };
    const roomOverrides = { ...project.roomOverrides, [roomKey]: updatedRoom };
    if (!Object.keys(updatedRoom.actors).length && !Object.keys(updatedRoom.events).length && !updatedRoom.geometry) delete roomOverrides[roomKey];
    setPast(history => [...history.slice(-99), project]); setFuture([]);
    setProject({ ...project, updatedAt: new Date().toISOString(), roomOverrides });
  };
  const editGeometry = (translation: Vec3 | null) => {
    if (!project || !baseRoom || sample || busyLock.current || !baseRoom.geometryEdit?.supported) return;
    const checked = translation ? checkedGeometryTranslation(baseRoom, translation) : null;
    const updated = withGeometryOverride(project, baseRoom.id, checked, baseRoom.geometryEdit.affectedRoomIds);
    if (fingerprint(updated) === fingerprint(project)) return;
    setPast(history => [...history.slice(-99), project]); setFuture([]); setProject(updated);
  };
  const undo = () => { const previous = past[past.length - 1]; if (!previous || !project || busyLock.current) return; setFuture(items => [project, ...items]); setProject(previous); setPast(items => items.slice(0, -1)); };
  const redo = () => { const next = future[0]; if (!next || !project || busyLock.current) return; setPast(items => [...items, project]); setProject(next); setFuture(items => items.slice(1)); };
  const frameRoom = (selectedOnly: boolean) => setFrame(value => ({ version: value.version + 1, selected: selectedOnly }));
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest("input,textarea,[contenteditable=true]") || modal || busyLock.current) return;
      if (event.metaKey || event.ctrlKey) {
        if (event.key.toLowerCase() === "s") { event.preventDefault(); void saveProject(); }
        if (event.key.toLowerCase() === "z") { event.preventDefault(); event.shiftKey ? redo() : undo(); }
      } else if (event.key.toLowerCase() === "f") { event.preventDefault(); frameRoom(Boolean(selected)); }
      else if (event.key.toLowerCase() === "g") setOptions(value => ({ ...value, grid: !value.grid }));
      else if (event.key.toLowerCase() === "w") setOptions(value => ({ ...value, translate: !value.translate }));
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
    // Actions depend on the current project/history, so refresh their closures.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, past, future, selected, modal]);
  const selectRecord = (id: string | null) => { setSelected(id); if (room?.events.some(event => event.id === id)) setTab("events"); else if (id) setTab("actors"); };
  const moveRecord = (id: string, position: Vec3) => { try { const actor = room?.actors.find(actor => actor.id === id); const checked = actor ? checkedActorPosition(actor, position) : checkedPosition(position); edit(actor ? "actors" : "events", id, { position: checked }); } catch (issue) { setError(messageOf(issue)); setOptions(value => ({ ...value, translate: false })); } };
  const selectedActor = room?.actors.find(actor => actor.id === selected);
  const selectedEvent = room?.events.find(event => event.id === selected);
  const selectedMovable = Boolean((selectedActor?.editable && (selectedActor.sourceKind !== "partition" || selectedActor.partition)) || (selectedEvent?.editable && selectedEvent.position));
  const sources = new Set(room?.meshes.map(mesh => mesh.source));
  const textureCoverage = room && renderCoverage.roomId === room.id ? renderCoverage : room ? roomTextureCoverage(room) : { textured: 0, total: 0, images: 0 };
  const roomWarnings = [...(room?.warnings ?? []), ...(renderCoverage.roomId === room?.id ? renderCoverage.warnings : [])];
  const geometryLabel = sample ? "Procedural sample" : textureCoverage.textured && options.textures ? "ROM texture preview" : sources.has("display-list") ? "Solid room geometry" : sources.has("collision") ? "Collision geometry" : "Placement markers";
  const overrides = project?.roomOverrides[String(room?.id)];
  const modified = Boolean(selected && (overrides?.actors[selectedEvent?.actorRef ?? selected] || overrides?.events[selected]));
  const modificationCount = countProjectChanges(project);
  const geometryTranslation = baseRoom ? effectiveGeometryTranslation(baseRoom, project) : null;
  const sharedImpacts = baseRoom ? sharedGeometryImpacts(baseRoom, project) : [];
  const visibleRooms = rooms.filter(item => `${item.name} ${item.id} ${item.id.toString(16)}`.toLowerCase().includes(roomSearch.toLowerCase()));
  const records = room ? tab === "actors" ? room.actors : tab === "events" ? room.events : [] : [];
  const visibleRecords = records.filter(item => `${item.name} ${item.index} ${"actorId" in item ? item.actorId.toString(16) : item.kind}`.toLowerCase().includes(recordSearch.toLowerCase()));
  const closeModal = useCallback(() => setModal(null), []);
  const showSample = () => { setSample(true); setProject(null); setSaved(""); setRooms([sampleRoom]); setBaseRoom(sampleRoom); setSelected(null); setError(""); setNotice(""); };

  return <Column as="main" fill className="mnsg-editor">
    <Row className="app-toolbar" vertical="center" horizontal="between" paddingX="20" borderBottom>
      <Row gap="12" vertical="center"><span className="studio-mark"><FiBox /></span><Column gap="2"><Text variant="label-strong-s">MNSG <span className="wordmark-light">STUDIO</span></Text><Text variant="label-default-xs" onBackground="neutral-weak">LEVEL & ACTOR EDITOR</Text></Column><span className="toolbar-divider" /><span className="project-title">{sample ? "Sample workspace" : project?.name ?? "No project"}</span>{dirty && <span className="dirty-state" title="Unsaved project changes">Unsaved</span>}</Row>
      <Row gap="8" vertical="center"><Button size="s" variant="tertiary" onClick={() => guard(() => setModal("new"))} disabled={!status?.rom || sample || Boolean(busy)}><FiPlus />New</Button><Button size="s" variant="tertiary" onClick={openProject} disabled={sample || Boolean(busy)}><FiFolder />Open</Button><Button size="s" variant="secondary" onClick={() => void saveProject()} disabled={!project || sample || Boolean(busy)} title="Save project · ⌘/Ctrl S"><FiSave />Save</Button><Button size="s" onClick={() => setModal("export")} disabled={!project || sample || !modificationCount || Boolean(busy)}><FiArrowUpRight />Export</Button></Row>
    </Row>

    {booting ? <Column fill center gap="16"><Spinner /><Text onBackground="neutral-weak">Opening workspace…</Text></Column> : !room && !status?.rom ? <Row fill center padding="32"><Column className="onboarding" maxWidth="m" gap="32"><Row gap="24" vertical="center"><span className="onboarding-mark"><FiLayers /></span><Column gap="12"><Text variant="label-default-s" onBackground="brand-medium">YOUR WORLD, UNDER THE SURFACE</Text><Text variant="display-strong-m">A closer look at Goemon.</Text></Column></Row><Text variant="body-default-l" onBackground="neutral-weak">Explore rooms, inspect actor placements, and turn your changes into a Recomp mod. Start with your own US copy of Mystical Ninja Starring Goemon.</Text><Column background="surface" border radius="l" padding="24" gap="20"><Row gap="16" vertical="center"><span className="step-number">01</span><Column gap="4"><Text variant="body-strong-m">Connect your ROM</Text><Text variant="body-default-s" onBackground="neutral-weak">Select it once. The app verifies the US release and handles decompression locally.</Text></Column></Row><Button size="l" onClick={importRom} loading={Boolean(busy)}><FiUpload />{busy || "Choose US ROM"}</Button><Text variant="body-default-xs" onBackground="neutral-weak">Your ROM stays on this computer. Project edits are stored separately from the source file.</Text></Column><Row horizontal="between" vertical="center"><Text variant="label-default-s" onBackground="neutral-weak">Just looking around?</Text><Button size="s" variant="tertiary" onClick={showSample}>Open procedural sample <FiChevronRight /></Button></Row>{!status && <div className="inline-notice">Browser preview · import and file export are available in the desktop app.</div>}{error && <div className="error-banner" role="alert">{error}</div>}</Column></Row> : <>
      <Row className="workspace" fill>
        <Column className="room-panel" borderRight>
          <Row className="panel-heading" horizontal="between" vertical="center" padding="20"><Row gap="8" vertical="center"><FiLayers /><Text variant="label-strong-s">ROOMS</Text></Row><span className="count-badge">{rooms.length}</span></Row>
          <label className="search-box"><FiSearch /><input aria-label="Search rooms" placeholder="Search rooms…" value={roomSearch} onChange={event => setRoomSearch(event.target.value)} /><kbd>/</kbd></label>
          <Row className="list-caption" paddingX="20" paddingY="12" horizontal="between" textVariant="label-default-xs" onBackground="neutral-weak"><span>{sample ? "PROCEDURAL WORKSPACE" : "US ROM · ROOM DIRECTORY"}</span></Row>
          <Column className="room-list" overflowY="auto" gap="4" paddingX="8">{visibleRooms.map(item => <Button variant="tertiary" size="s" horizontal="start" data-testid="room-button" data-room-id={item.id} className={`room-item ${room?.id === item.id ? "is-selected" : ""}`} key={item.id} onClick={() => !sample && void loadRoom(item.id)} disabled={Boolean(busy)} aria-current={room?.id === item.id ? "true" : undefined}><span className="room-index">{item.id.toString(16).toUpperCase().padStart(3, "0")}</span><span className="room-item-info"><span>{item.name}</span><span>{item.actorCount} actors <span className="tiny-dot">·</span> {item.eventCount} events</span></span>{project?.roomOverrides[String(item.id)] && <span className="modified-dot" />}{room?.id === item.id && <FiChevronRight />}</Button>)}{!visibleRooms.length && <Text padding="16" variant="body-default-s" onBackground="neutral-weak">No matching rooms.</Text>}</Column>
          <Column className="rom-summary" gap="12" padding="20" borderTop><Row gap="8" vertical="center"><span className="connection-dot" /><Text variant="label-strong-xs">{sample ? "SAMPLE · NO GAME ASSETS" : "ROM CONNECTED"}</Text></Row><Text variant="body-default-xs" onBackground="neutral-weak">{sample ? "A procedural scene for trying the viewport. Import your ROM to begin a project." : `${status?.rom?.title ?? "Mystical Ninja Starring Goemon"} · US`}</Text><Button size="s" variant="tertiary" fillWidth onClick={sample ? () => { setSample(false); setBaseRoom(null); setRooms([]); } : importRom}>{sample ? "Return to ROM setup" : "Change source ROM"}</Button></Column>
        </Column>
        <Column className="viewport-panel" flex={1}>
          <Row className="viewport-heading" vertical="center" horizontal="between" paddingX="20" borderBottom><Row gap="12" vertical="center"><Text variant="body-strong-s">{room?.name ?? "Choose a room"}</Text><span className="geometry-badge">{geometryLabel}</span></Row><Row gap="4"><Button size="s" variant="tertiary" aria-label="Undo" title="Undo · ⌘/Ctrl Z" disabled={!past.length || Boolean(busy)} onClick={undo}><FiCornerUpLeft /></Button><Button size="s" variant="tertiary" aria-label="Redo" title="Redo · ⌘/Ctrl Shift Z" disabled={!future.length || Boolean(busy)} onClick={redo}><FiCornerUpRight /></Button></Row></Row>
          <div className="viewport-stage">{room && <RoomViewport room={room} selected={selected} options={busy ? { ...options, translate: false } : options} frame={frame} onSelect={selectRecord} onMove={moveRecord} onCoverage={setRenderCoverage} />}
            <div className="viewport-top-overlay"><span className="view-tag">PERSPECTIVE <span>Y UP</span></span><div className="view-tool-stack"><Button variant="tertiary" size="s" horizontal="start" aria-label="Frame all geometry" title="Frame all geometry" onClick={() => frameRoom(false)}><FiMaximize /></Button><Button variant="tertiary" size="s" horizontal="start" aria-label="Frame selected record" title="Frame selected · F" disabled={!selectedActor && !selectedEvent?.position} onClick={() => frameRoom(true)}><span>F</span></Button><span className="stack-divider" /><Button variant="tertiary" size="s" horizontal="start" aria-label="Toggle translation gizmo" title="Translate · W" aria-pressed={options.translate} disabled={sample || Boolean(busy) || !selectedMovable} onClick={() => setOptions(value => ({ ...value, translate: !value.translate }))}><FiMove /></Button></div></div>
            <div className="viewport-bottom-overlay"><span className="axis-key"><i>X</i><i>Y</i><i>Z</i></span><span className="orbit-help">Drag to orbit <span>·</span> Right-drag to pan <span>·</span> Scroll to zoom</span></div>
            {room && !room.meshes.length && <div className="no-geometry">No verified geometry for this room. Positioned records are shown as markers.</div>}
            {busy && <div className="viewport-loading" role="status"><Spinner size="s" />{busy}…</div>}
          </div>
          <Row className="viewport-controls" vertical="center" horizontal="between" paddingX="16" borderTop><Row gap="4">{(["textures", "grid", "wireframe", "actors", "events", "axes"] as const).map(key => <Button variant="tertiary" size="s" horizontal="start" key={key} data-testid={key === "textures" ? "textures-toggle" : undefined} disabled={key === "textures" && !textureCoverage.textured} className={options[key] ? "view-toggle active" : "view-toggle"} aria-pressed={options[key]} onClick={() => setOptions(value => ({ ...value, [key]: !value[key] }))}>{key === "grid" && <FiGrid />}{key.charAt(0).toUpperCase() + key.slice(1)}</Button>)}</Row><Text variant="label-default-xs" onBackground="neutral-weak">{room?.meshes.reduce((sum, mesh) => sum + mesh.indices.length / 3, 0).toLocaleString()} triangles</Text></Row>
          <div className="viewport-note">{sharedImpacts.length > 0 ? `Shared geometry translation from room ${sharedImpacts.map(id => `0x${id.toString(16).toUpperCase()}`).join(", ")} · actor placements unchanged` : sample ? "Procedural sample · no ROM data · read only" : options.textures && textureCoverage.textured ? `ROM textures · ${textureCoverage.textured.toLocaleString()}/${textureCoverage.total.toLocaleString()} triangles · lighting, filtering and fog approximate` : "Solid room preview · actor models and event behavior are not rendered"}</div>
        </Column>
        <Column className="detail-panel" borderLeft>
          <Row className="panel-heading" padding="20" vertical="center" horizontal="between"><Text variant="label-strong-s">OUTLINER</Text><FiBox /></Row>
          <div className="outliner-tabs" role="tablist" aria-label="Room records">{(["actors", "events", "room"] as const).map(kind => <Button variant="tertiary" size="s" horizontal="start" role="tab" id={`${kind}-tab`} data-testid={kind === "room" ? "room-geometry-tab" : undefined} aria-controls="records-panel" aria-selected={tab === kind} className={tab === kind ? "active" : ""} key={kind} onClick={() => { setTab(kind); if (kind === "room") setSelected(null); }}>{kind.charAt(0).toUpperCase() + kind.slice(1)}{kind !== "room" && <span>{room?.[kind].length ?? 0}</span>}</Button>)}</div>
          {tab !== "room" && <><label className="search-box compact"><FiSearch /><input aria-label="Search records" placeholder={`Find ${tab}…`} value={recordSearch} onChange={event => setRecordSearch(event.target.value)} /></label>
          <div className="record-list" data-testid="actor-list" id="records-panel" role="tabpanel" aria-labelledby={`${tab}-tab`}>{visibleRecords.map(item => <Button variant="tertiary" size="s" horizontal="start" key={item.id} className={`record-item ${selected === item.id ? "is-selected" : ""}`} onClick={() => selectRecord(item.id)}><span className={`record-symbol ${tab}`}>{tab === "actors" ? <FiBox /> : "◇"}</span><span>{item.name}</span><code>{item.index.toString().padStart(2, "0")}</code>{(overrides?.actors["actorRef" in item && item.actorRef ? item.actorRef : item.id] || overrides?.events[item.id]) && <span className="modified-dot" />}</Button>)}{!visibleRecords.length && <div className="empty-records">{recordSearch ? "No matching records." : `No ${tab} in this room.`}</div>}</div></>}
          <Row className="inspector-heading" paddingX="20" paddingY="12" borderY horizontal="between"><Text variant="label-strong-xs">{tab === "room" ? "ROOM INSPECTOR" : "INSPECTOR"}</Text><Text variant="label-default-xs" onBackground="neutral-weak">{(tab === "room" ? Boolean(geometryTranslation) : modified) ? "Modified" : "Source values"}</Text></Row>
          <div className="inspector-scroll">{tab === "room" && baseRoom ? <div id="records-panel" role="tabpanel" aria-labelledby="room-tab"><RoomInspector key={`room:${project?.id}:${baseRoom.id}`} room={baseRoom} translation={geometryTranslation ?? { x: 0, y: 0, z: 0 }} modified={Boolean(geometryTranslation)} sample={sample} busy={Boolean(busy)} sharedImpacts={sharedImpacts} onChange={editGeometry} onReset={() => editGeometry(null)} onFrame={() => frameRoom(false)} /></div> : <Inspector key={selected ?? "none"} actor={selectedActor} event={selectedEvent} sample={sample} busy={Boolean(busy)} supportedActorIds={baseRoom?.actors.map(actor => actor.actorId) ?? []} modified={modified} onActor={value => selected && edit("actors", selected, value)} onEvent={value => selected && edit("events", selected, value)} onReset={() => selected && edit(selectedActor ? "actors" : "events", selected, null)} onFrame={() => frameRoom(true)} onInspectActor={id => { selectRecord(id); setTab("actors"); }} />}</div>
        </Column>
      </Row>
      {error && <div className="error-banner workspace-banner" role="alert"><span>{error}</span><Button variant="tertiary" size="s" horizontal="start" aria-label="Dismiss error" onClick={() => setError("")}><FiX /></Button></div>}
      {roomWarnings.length ? <details className="room-warnings"><summary>{roomWarnings.length} room {roomWarnings.length === 1 ? "note" : "notes"}</summary>{roomWarnings.map((warning, index) => <p key={index}>{warning}</p>)}</details> : null}
      <Row className="status-bar" vertical="center" horizontal="between" paddingX="20" borderTop><Row gap="8" vertical="center"><span className="connection-dot" /><span role="status">{busy || notice || (sample ? "Sample workspace" : dirty ? `${modificationCount} project changes · unsaved project` : "Ready")}</span></Row><Row gap="16"><span>{room && `${room.actors.length} actors / ${room.events.length} events`}</span><span className="status-version">MNSG STUDIO {status?.appVersion ?? "PREVIEW"}</span></Row></Row>
    </>}
    {modal === "new" && <ModalShell title="New project" onClose={closeModal}><Text variant="body-default-s" onBackground="neutral-weak">Keep a set of room and actor changes together. Your source ROM remains unchanged.</Text><label className="value-field"><span>Project name</span><input value={newName} maxLength={120} onChange={event => setNewName(event.target.value)} /></label><Button disabled={!newName.trim() || Boolean(busy)} onClick={() => void run("Creating project", async () => { acceptProject(await api().newProject(newName.trim())); setModal(null); setNotice("Project created. Select a record to begin editing."); })}>Create project</Button></ModalShell>}
    {modal === "discard" && <ModalShell title="Unsaved project changes" onClose={closeModal}><Text variant="body-default-s" onBackground="neutral-weak">Save your project before continuing, or discard the changes in this workspace.</Text><Row gap="8"><Button variant="secondary" onClick={closeModal}>Keep editing</Button><Button variant="danger" onClick={() => { const task = deferred.current; deferred.current = null; setModal(null); task?.(); }}>Discard & continue</Button><Button disabled={Boolean(busy)} onClick={() => void saveAndContinue()}><FiSave />Save & continue</Button></Row></ModalShell>}
    {modal === "export" && <ModalShell title="Bring your changes to Recomp" onClose={closeModal}><Text variant="body-default-s" onBackground="neutral-weak">Export {modificationCount} project {modificationCount === 1 ? "change" : "changes"} across {Object.keys(project?.roomOverrides ?? {}).length} rooms.</Text><Column gap="12">{(["patch", "nrm"] as const).map(kind => <Button variant="tertiary" size="s" horizontal="start" key={kind} className={`export-option ${exportKind === kind ? "active" : ""}`} onClick={() => setExportKind(kind)} aria-pressed={exportKind === kind}><span className="export-icon">{kind === "patch" ? <FiLayers /> : <FiBox />}</span><span><strong>{kind === "patch" ? "C / H patch files" : "Prebuilt Recomp mod"}</strong><small>{kind === "patch" ? "Add generated sources to your own mod project." : "Build a .nrm file with the configured mod toolchain."}</small></span>{exportKind === kind && <FiCheck />}</Button>)}</Column>{exportKind === "nrm" && <Column gap="12"><div className="inline-notice">{status?.toolchain.ready ? `Toolchain ready${status.toolchain.label ? ` · ${status.toolchain.label}` : ""}` : "A compatible Recomp mod toolchain is required to build an .nrm file."}{status?.toolchain.missing.length ? <p>Missing: {status.toolchain.missing.join(", ")}</p> : null}</div><Button variant="secondary" size="s" onClick={() => void run("Configuring toolchain", async () => { const toolchain = await api().configureToolchain(); if (toolchain) setStatus(value => value ? { ...value, toolchain } : value); })}><FiSettings />Configure toolchain</Button></Column>}<Button disabled={Boolean(busy) || (exportKind === "nrm" && !status?.toolchain.ready)} onClick={() => void run("Exporting changes", async () => { if (!project) return; const result = await (exportKind === "patch" ? api().exportPatch(project) : api().exportNrm(project)); if (result) { setModal(null); setNotice(`Exported ${result.fileNames.join(", ")}${result.warnings.length ? ` · ${result.warnings.join("; ")}` : ""}`); } })}><FiDownload />Export {exportKind === "patch" ? "patch files" : ".nrm mod"}</Button></ModalShell>}
  </Column>;
}
