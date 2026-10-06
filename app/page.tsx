"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Column, Row, Spinner, Text } from "@once-ui-system/core";
import {
  FiArrowUpRight,
  FiBox,
  FiCheck,
  FiChevronRight,
  FiCornerUpLeft,
  FiCornerUpRight,
  FiDownload,
  FiFolder,
  FiGrid,
  FiLayers,
  FiMaximize,
  FiMove,
  FiRotateCw,
  FiPlus,
  FiSave,
  FiSearch,
  FiSettings,
  FiUpload,
  FiX,
} from "react-icons/fi";
import type {
  ActorOverride,
  ActorVisualPayload,
  AppApi,
  AppStatus,
  EditorProject,
  EventOverride,
  RoomData,
  RoomSummary,
  Vec3,
  AuthoringCatalog,
  AuthoredRoom,
  ProjectRoomScene,
} from "../shared/types";
import RoomViewport, { type ViewOptions } from "../components/RoomViewport";
import TooltipButton from "../components/TooltipButton";
import { prepareEditableRoom } from "../components/editableRoom";
import { rotateProjectSelection, selectionRotatable, type RotationDelta } from "../components/selectionRotation";
import { ValueField } from "../components/Inspector";
import Inspector from "../components/Inspector";
import RoomInspector from "../components/RoomInspector";
import {
  roomTextureCoverage,
  type RenderTextureCoverage,
} from "../components/roomMaterials";
import type { CameraMouseMode } from "../components/cameraMouse";
import type { ActorRenderCoverage } from "../components/actorModelScene";
import { requestActorVisuals } from "../components/actorVisualRequests";
import {
  applyOverrides,
  checkedActorPosition,
  checkedGeometryTranslation,
  checkedPosition,
  countProjectChanges,
  effectiveGeometryTranslation,
  sampleRoom,
  sharedGeometryImpacts,
  withGeometryOverride,
} from "../components/editorModel";
import AuthoringInspector from "../components/AuthoringInspector";
import SelectionInspector from "../components/SelectionInspector";
import {
  selectItems,
  selectionId,
  selectionKey,
  selectionExists,
  selectionMovable,
  translateProjectSelection,
  type EditorSelection,
} from "../components/editorSelection";
import EditorContextMenu, {
  type ContextMenuLocation,
} from "../components/EditorContextMenu";
import {
  copyGeometry,
  pasteEntity,
  type EditorClipboard,
} from "../components/editorClipboard";
import AssetLibrary, { type LibraryDrop } from "../components/AssetLibrary";
import {
  addActor,
  availableRoomId,
  canonicalProject,
  cloneScene,
  cloneAuthoredRoom,
  emptyRoom,
  insertGeometry,
  newId,
  replaceMesh,
  updateAuthoredRoom,
} from "../components/authoringModel";
import {
  documentFingerprint,
  editVertex,
  meshCenter,
  moveGeometrySelection,
  transformMesh,
  type GeometrySelection,
} from "../components/authoringState";
import DockWorkspace, {
  type DockWorkspaceHandle,
} from "../components/DockWorkspace";
import {
  appendWorkspaceLog,
  type WorkspaceLog,
  type CameraSnapshot,
} from "../components/workspaceModel";
import { ModSettingsPanel } from "../components/ModSettingsPanel";
import "./editor.scss";
import "./mod-settings.scss";

type Modal = "new" | "export" | "discard" | "room-new" | "settings" | null;
const fingerprint = (project: EditorProject | null) =>
  project ? documentFingerprint(project) : "";
const messageOf = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "The operation could not be completed.";
const initialOptions: ViewOptions = {
  geometry: true,
  textures: true,
  grid: true,
  axes: true,
  wireframe: false,
  actors: true,
  events: true,
  translate: false,
  transformMode: "translate",
};

function ModalShell({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: React.ReactNode;
  onClose(): void;
  wide?: boolean;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const element = dialog.current;
    element?.querySelector<HTMLElement>("input,button")?.focus();
    const keys = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "Tab" && element) {
        const items = [
          ...element.querySelectorAll<HTMLElement>(
            "button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex='0']",
          ),
        ];
        const first = items[0],
          last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        }
        if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", keys);
    return () => {
      document.removeEventListener("keydown", keys);
      before?.focus();
    };
  }, [onClose]);
  return (
    <div className={`modal-backdrop${wide ? " modal-backdrop-wide" : ""}`}>
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        className={`editor-modal${wide ? " editor-modal-wide" : ""}`}
      >
        <Column
          background="surface"
          border
          radius="l"
          padding={wide ? "16" : "32"}
          gap={wide ? "12" : "24"}
          className={wide ? "editor-modal-wide-content" : undefined}
        >
          <Row
            horizontal="between"
            vertical="center"
            className={wide ? "editor-modal-wide-heading" : undefined}
          >
            <Text id="modal-title" variant="heading-strong-l">
              {title}
            </Text>
            <TooltipButton
              size="s"
              variant="tertiary"
              aria-label="Close dialog"
              onClick={onClose}
            >
              <FiX />
            </TooltipButton>
          </Row>
          {children}
        </Column>
      </div>
    </div>
  );
}

export default function EditorPage() {
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [booting, setBooting] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setErrorMessage] = useState("");
  const [errorSource, setErrorSource] = useState("Editor");
  const setError = useCallback((message: string, source = "Editor") => {
    setErrorMessage(message);
    setErrorSource(source);
  }, []);
  const [notice, setNotice] = useState("");
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [baseRoom, setBaseRoom] = useState<RoomData | ProjectRoomScene | null>(
    null,
  );
  const [project, setProject] = useState<EditorProject | null>(null);
  const [saved, setSaved] = useState("");
  const [savedSnapshot, setSavedSnapshot] = useState<EditorProject | null>(
    null,
  );
  const [sample, setSample] = useState(false);
  const [selections, setSelections] = useState<EditorSelection[]>([]);
  const primarySelection = selections.at(-1);
  const selected = primarySelection ? selectionId(primarySelection) : null;
  const geometrySelection =
    primarySelection?.kind === "geometry" ? primarySelection.choice : null;
  const setSelected = (id: string | null) =>
    setSelections(id ? [{ kind: "record", id }] : []);
  const [roomSearch, setRoomSearch] = useState("");
  const [recordSearch, setRecordSearch] = useState("");
  const [tab, setTab] = useState<"actors" | "events" | "room" | "geometry">(
    "actors",
  );
  const [options, setOptions] = useState(initialOptions);
  const [mouseMode, setMouseMode] = useState<CameraMouseMode>("tilt");
  const [frame, setFrame] = useState({ version: 0, selected: false });
  const [renderCoverage, setRenderCoverage] = useState<RenderTextureCoverage>({
    roomId: -1,
    textured: 0,
    total: 0,
    images: 0,
    warnings: [],
  });
  const [actorCoverage, setActorCoverage] = useState<
    ActorRenderCoverage & { roomId: number }
  >({
    roomId: -1,
    rendered: 0,
    renderedActorRefs: [],
    supported: 0,
    conditional: 0,
    partial: 0,
    nonvisual: 0,
    unsupported: 0,
    parts: 0,
    texturedTriangles: 0,
    warnings: [],
    failures: {},
  });
  const [actorPayload, setActorPayload] = useState<{
    source: RoomData | ProjectRoomScene;
    projectId: string | undefined;
    data: ActorVisualPayload;
  } | null>(null);
  const [actorPendingRoom, setActorPendingRoom] = useState<
    RoomData | ProjectRoomScene | null
  >(null);
  const [actorVisualError, setActorVisualError] = useState<{
    source: RoomData | ProjectRoomScene;
    message: string;
  } | null>(null);
  const [past, setPast] = useState<EditorProject[]>([]);
  const [future, setFuture] = useState<EditorProject[]>([]);
  const [modal, setModal] = useState<Modal>(null);
  const [newName, setNewName] = useState("Untitled project");
  const [exportKind, setExportKind] = useState<"patch" | "nrm">("patch");
  const [catalog, setCatalog] = useState<AuthoringCatalog | null>(null);
  const dock = useRef<DockWorkspaceHandle>(null);
  const [clipboard, setClipboard] = useState<EditorClipboard | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuLocation | null>(
    null,
  );
  const closeContextMenu = useCallback(() => setContextMenu(null), []);
  const cameraSnapshot = useRef<CameraSnapshot | undefined>(undefined);
  const [sceneHost, setSceneHost] = useState<{
    window: Window;
    visible: boolean;
  } | null>(null);
  const [popupWindows, setPopupWindows] = useState<Window[]>([]);
  useEffect(() => {
    setContextMenu(null);
  }, [project?.id, baseRoom?.id, modal, popupWindows]);

  const [workspaceInteraction, setWorkspaceInteraction] = useState(false);
  const [consoleLogs, setConsoleLogs] = useState<WorkspaceLog[]>([]);
  const [consoleFilter, setConsoleFilter] = useState("all");
  const [consoleSource, setConsoleSource] = useState("all");
  const [followCollision, setFollowCollision] = useState(true);
  const [newRoomName, setNewRoomName] = useState("New room");
  const [newRoomMode, setNewRoomMode] = useState<"blank" | "clone">("blank");
  const deferred = useRef<(() => void) | null>(null);
  const loadSequence = useRef(0);
  const busyLock = useRef(false);
  const sceneReady = useRef("");
  const projectAuthoredRoom = project?.version === 2 ? project.authoredRooms[String(baseRoom?.id)] : undefined;
  const nativeOverrideKey = JSON.stringify(project?.roomOverrides[String(baseRoom?.id)] ?? null);
  const [nativeDraft, setNativeDraft] = useState<{
    source: RoomData | ProjectRoomScene;
    projectId: string;
    overrideKey: string;
    prepared: ReturnType<typeof prepareEditableRoom>;
  } | null>(null);
  const editableDraft = nativeDraft?.source === baseRoom && nativeDraft?.projectId === project?.id && nativeDraft?.overrideKey === nativeOverrideKey && !projectAuthoredRoom ? nativeDraft.prepared : undefined;
  const room = useMemo(() => {
    if (!baseRoom) return null;
    const view =
      editableDraft?.scene ?? ("kind" in baseRoom && baseRoom.kind !== "native"
        ? baseRoom
        : applyOverrides(baseRoom as RoomData, project));
    return actorPayload?.source.id === baseRoom.id &&
      actorPayload?.projectId === project?.id
      ? { ...view, ...actorPayload.data }
      : view;
  }, [baseRoom, project, actorPayload, editableDraft]);
  useEffect(() => {
    if (!baseRoom || !project || !catalog || sample || projectAuthoredRoom || ("kind" in baseRoom && baseRoom.kind !== "native")) return;
    let active = true;
    void (async () => {
      const scene = await api().loadProjectRoom(project, baseRoom.id);
      const entry = catalog.geometry.find(asset => asset.roomIds.includes(scene.id) && asset.id.startsWith("geometry:"));
      const asset = entry ? await api().loadGeometryAsset(entry.id) : undefined;
      const prepared = prepareEditableRoom(scene, catalog, asset);
      if (active) setNativeDraft({ source: baseRoom, projectId: project.id, overrideKey: nativeOverrideKey, prepared });
    })().catch(issue => { if (active) setError(`Room editing could not initialize: ${messageOf(issue)}`); });
    return () => { active = false; };
    // Stage native geometry only when its effective source changes, never on selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseRoom, project?.id, nativeOverrideKey, catalog, sample, Boolean(projectAuthoredRoom)]);
  useEffect(() => {
    if (!room) return;
    setSelections((current) => {
      const valid = current.filter((value) => selectionExists(room, value));
      return valid.length === current.length ? current : valid;
    });
  }, [room]);
  const authoredRoom = projectAuthoredRoom ?? editableDraft?.authored;
  const authoredKey = JSON.stringify(projectAuthoredRoom ?? null);
  const actorOverrideKey = JSON.stringify(
    projectAuthoredRoom
      ? { actors: projectAuthoredRoom.actors, doors: projectAuthoredRoom.doors }
      : (project?.roomOverrides[String(baseRoom?.id)]?.actors ?? {}),
  );
  const actorRefreshing = Boolean(
    baseRoom && actorPendingRoom?.id === baseRoom.id,
  );
  const dirty = fingerprint(project) !== saved;
  const api = () => {
    const bridge: AppApi | undefined = window.mnsg;
    if (!bridge)
      throw new Error(
        "ROM import and project files require the desktop application. Open MNSG Studio for macOS or Windows.",
      );
    return bridge;
  };
  const run = useCallback(async (label: string, task: () => Promise<void>) => {
    if (busyLock.current) return;
    busyLock.current = true;
    setBusy(label);
    setError("");
    setNotice("");
    try {
      await task();
    } catch (issue) {
      setError(
        messageOf(issue),
        label === "Exporting changes" || label === "Checking bundled tools"
          ? "Build"
          : "Editor",
      );
    } finally {
      busyLock.current = false;
      setBusy("");
    }
  }, []);
  const loadRoom = async (id: number) => {
    const sequence = ++loadSequence.current;
    await run("Loading room", async () => {
      const data =
        project?.version === 2 && project.authoredRooms[id]
          ? await api().loadProjectRoom(project, id)
          : await api().loadRoom(id);
      if (sequence !== loadSequence.current) return;
      sceneReady.current = `${project?.id}/${id}/${JSON.stringify(project?.version === 2 ? (project.authoredRooms[id] ?? null) : null)}`;
      setBaseRoom(data);
      setSelected(null);
      setFrame({ version: 0, selected: false });
    });
  };
  const acceptProject = (value: EditorProject) => {
    setProject(value);
    setSaved(fingerprint(value));
    setSavedSnapshot(value);
    setPast([]);
    setFuture([]);
    setSample(false);
  };
  const readWorkspace = async (
    value: AppStatus,
    projectValue?: EditorProject,
  ) => {
    setStatus(value);
    if (!value.rom) return;
    const currentProject =
      projectValue ??
      value.project ??
      (await api().newProject("Untitled project"));
    acceptProject(currentProject);
    setCatalog(await api().getAuthoringCatalog());
    const list = await api().listProjectRooms(currentProject);
    setRooms(list);
    const requestedId = Number(
      Object.keys(
        currentProject.version === 2
          ? currentProject.authoredRooms
          : currentProject.roomOverrides,
      )[0],
    );
    const first = list.find((item) => item.id === requestedId) ?? list[0];
    if (first) {
      setBaseRoom(
        currentProject.version === 2 && currentProject.authoredRooms[first.id]
          ? await api().loadProjectRoom(currentProject, first.id)
          : await api().loadRoom(first.id),
      );
      setSelected(null);
    }
  };
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        if (window.mnsg) {
          const value = await window.mnsg.getStatus();
          if (active) await readWorkspace(value);
        }
      } catch (issue) {
        if (active) setError(messageOf(issue));
      } finally {
        if (active) setBooting(false);
      }
    })();
    return () => {
      active = false;
    };
    // Import happens once through the native desktop bridge.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const leave = (event: BeforeUnloadEvent) => {
      if (dirty) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", leave);
    return () => window.removeEventListener("beforeunload", leave);
  }, [dirty]);
  useEffect(() => {
    if (!baseRoom || sample || !window.mnsg) return;
    setActorPendingRoom(baseRoom);
    setActorVisualError(null);
    return requestActorVisuals(
      (id, overrides) =>
        projectAuthoredRoom && project
          ? api().loadProjectActorVisuals(project, id)
          : api().loadActorVisuals(id, overrides),
      baseRoom.id,
      projectAuthoredRoom
        ? {}
        : (JSON.parse(actorOverrideKey) as Record<string, ActorOverride>),
      (data) =>
        setActorPayload({ source: baseRoom, projectId: project?.id, data }),
      (issue) =>
        setActorVisualError({
          source: baseRoom,
          message: `Actor preview could not refresh: ${messageOf(issue)}`,
        }),
      () => setActorPendingRoom(null),
    );
    // Actor values, including reset and history, affect native constructor parts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseRoom?.id, actorOverrideKey, sample, project?.id]);
  useEffect(() => {
    if (!project || sample || !window.mnsg) return;
    let active = true;
    api()
      .listProjectRooms(project)
      .then((list) => {
        if (active) setRooms(list);
      })
      .catch((issue) => {
        if (active) setError(messageOf(issue));
      });
    if (
      !projectAuthoredRoom &&
      baseRoom &&
      "kind" in baseRoom &&
      baseRoom.kind !== "native"
    ) {
      api()
        .loadRoom(
          baseRoom.id < 620
            ? baseRoom.id
            : (rooms.find((r) => r.id < 620)?.id ?? 0),
        )
        .then((data) => {
          if (active) {
            setBaseRoom(data);
            if (data.id !== baseRoom.id) setSelected(null);
          }
        })
        .catch((issue) => {
          if (active) setError(messageOf(issue));
        });
    }
    if (
      projectAuthoredRoom &&
      sceneReady.current !== `${project.id}/${projectAuthoredRoom.id}/${authoredKey}`
    )
      api()
        .loadProjectRoom(project, projectAuthoredRoom.id)
        .then((data) => {
          if (active) setBaseRoom(data);
        })
        .catch((issue) => {
          if (active) setError(messageOf(issue));
        });
    return () => {
      active = false;
    };
    // Stable serialized authored data prevents response-driven reload loops.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authoredKey, project?.id, sample]);
  const transact = (next: EditorProject) => {
    if (
      !project ||
      sample ||
      busyLock.current ||
      fingerprint(next) === fingerprint(project)
    )
      return;
    const sourceProject = project;
    void run("Validating edit", async () => {
      const sceneId =
        baseRoom &&
        (baseRoom.id < 620 ||
          (next.version === 2 && next.authoredRooms[baseRoom.id]))
          ? baseRoom.id
          : (rooms.find((r) => r.id < 620)?.id ?? 0);
      const scene = await api().loadProjectRoom(next, sceneId);
      const preview =
        scene.kind === "native" ? await api().loadRoom(sceneId) : scene;
      sceneReady.current = `${next.id}/${sceneId}/${JSON.stringify(next.version === 2 ? (next.authoredRooms[sceneId] ?? null) : null)}`;
      setPast((history) => [...history.slice(-99), sourceProject]);
      setFuture([]);
      setProject(next);
      setBaseRoom(preview);
      if (sceneId !== baseRoom?.id) {
        setSelected(null);
      }
    });
  };
  const changeAuthoredRoom = (next: AuthoredRoom) => {
    if (project) transact(updateAuthoredRoom(project, next));
  };
  const savedAuthored =
    savedSnapshot?.version === 2 && savedSnapshot.id === project?.id
      ? savedSnapshot.authoredRooms[String(baseRoom?.id)]
      : undefined;
  const externalEntranceIds = new Set(
    project?.version === 2 && authoredRoom
      ? Object.values(project.authoredRooms)
          .filter((r) => r.id !== authoredRoom.id)
          .flatMap((r) =>
            r.doors
              .filter((d) => d.destination.roomId === authoredRoom.id)
              .map((d) => d.destination.entranceId),
          )
      : [],
  );
  const nativeEntranceIds = new Set(
    catalog?.nativeEntrances
      .filter((e) => e.roomId === authoredRoom?.id)
      .map((e) => e.id),
  );
  const inboundEntranceIds = new Set(
    project?.version === 2 && authoredRoom
      ? Object.values(project.authoredRooms).flatMap((r) =>
          r.doors
            .filter((d) => d.destination.roomId === authoredRoom.id)
            .map((d) => d.destination.entranceId),
        )
      : [],
  );
  const restoreNative = () => {
    if (!project || !projectAuthoredRoom || busyLock.current) return;
    const next = canonicalProject(project),
      authoredRooms = { ...next.authoredRooms },
      roomOverrides = { ...next.roomOverrides };
    delete authoredRooms[projectAuthoredRoom.id];
    const baseline =
      savedSnapshot?.id === project.id
        ? savedSnapshot.roomOverrides[projectAuthoredRoom.id]
        : undefined;
    if (baseline) roomOverrides[projectAuthoredRoom.id] = structuredClone(baseline);
    else delete roomOverrides[projectAuthoredRoom.id];
    transact({ ...next, authoredRooms, roomOverrides });
    // Source IDs remain stable, so Undo/restoration can retain existing selections.
  };
  const selectGeometry = (
    selection: GeometrySelection | null,
    additive = false,
  ) => {
    setSelections((current) =>
      selectItems(
        current,
        selection ? { kind: "geometry", choice: selection } : null,
        additive,
      ),
    );
    setTab("geometry");
  };
  const insertAsset = (asset: LibraryDrop, position?: Vec3) =>
    void run("Placing asset", async () => {
      if (!project || !authoredRoom || !catalog) return;
      const p = position ?? { x: 0, y: 0, z: 0 };
      let next = authoredRoom;
      if (asset.kind === "actor") {
        const prototype = catalog.actorPrototypes.find(
          (a) => a.id === asset.id,
        );
        if (!prototype)
          throw new Error("Actor is absent from the imported ROM catalog.");
        next = addActor(next, prototype, p);
        setSelected(next.actors.at(-1)!.id);
        setTab("actors");
      } else if (asset.kind === "geometry") {
        const payload = await api().loadGeometryAsset(asset.id);
        next = insertGeometry(next, payload, p);
        setNotice(payload.warnings.join(" · "));
      } else {
        if (!catalog.skyboxes.some((a) => a.id === asset.id))
          throw new Error("Skybox is absent from the imported ROM catalog.");
        next = { ...next, skyboxId: asset.id };
      }
      const updated = updateAuthoredRoom(project, next);
      const preview = await api().loadProjectRoom(updated, next.id);
      sceneReady.current = `${updated.id}/${next.id}/${JSON.stringify(next)}`;
      setPast((history) => [...history.slice(-99), project]);
      setFuture([]);
      setProject(updated);
      setBaseRoom(preview);
    });
  const createRoom = () =>
    void run("Creating room", async () => {
      if (!project || !catalog || !baseRoom) return;
      const id = availableRoomId(project, catalog),
        scene = await api().loadProjectRoom(project, baseRoom.id);
      const assetEntry = !authoredRoom
        ? catalog.geometry.find(
            (a) => a.roomIds.includes(scene.id) && a.id.startsWith("geometry:"),
          )
        : undefined;
      const nativeAsset = assetEntry
        ? await api().loadGeometryAsset(assetEntry.id)
        : undefined;
      const authored =
        newRoomMode === "clone"
          ? authoredRoom
            ? cloneAuthoredRoom(authoredRoom, id, newRoomName.trim())
            : cloneScene(
                scene,
                catalog,
                id,
                newRoomName.trim(),
                "new",
                nativeAsset,
              )
          : emptyRoom(
              id,
              newRoomName.trim(),
              authoredRoom?.templateRoomId ?? baseRoom.id,
            );
      const next = updateAuthoredRoom(project, authored);
      const preview = await api().loadProjectRoom(next, authored.id);
      sceneReady.current = `${next.id}/${authored.id}/${JSON.stringify(authored)}`;
      setPast((history) => [...history.slice(-99), project]);
      setFuture([]);
      setProject(next);
      setBaseRoom(preview);
      setSelected(null);
      setTab("room");
      setModal(null);
    });
  const guard = (task: () => void) => {
    if (dirty) {
      deferred.current = task;
      setModal("discard");
    } else task();
  };
  const importRom = () =>
    guard(() => {
      void run("Importing ROM", async () => {
        const value = await api().importRom();
        if (value) {
          await readWorkspace(value);
          setNotice("ROM imported. Your source file stays unchanged.");
        }
      });
    });
  const openProject = () =>
    guard(() => {
      void run("Opening project", async () => {
        const value = await api().openProject();
        if (value) await readWorkspace(await api().getStatus(), value);
      });
    });
  const saveProject = async () => {
    if (!project || sample) return;
    await run("Saving project", async () => {
      const result = await api().saveProject(project);
      if (result) {
        setProject(result.project);
        setSaved(fingerprint(result.project));
        setSavedSnapshot(result.project);
        setNotice(`Saved ${result.fileName}`);
      }
    });
  };
  const saveAndContinue = async () => {
    let next: (() => void) | null = null;
    await run("Saving project", async () => {
      if (!project) return;
      const result = await api().saveProject(project);
      if (!result) return;
      setProject(result.project);
      setSaved(fingerprint(result.project));
      setSavedSnapshot(result.project);
      next = deferred.current;
      deferred.current = null;
      setModal(null);
    });
    // Release the native-operation lock before the deferred file operation starts.
    (next as (() => void) | null)?.();
  };
  const edit = (
    kind: "actors" | "events",
    id: string,
    value: ActorOverride | EventOverride | null,
  ) => {
    if (!project || !room || sample || busyLock.current) return;
    const entity =
      kind === "actors"
        ? room.actors.find((actor) => actor.id === id)
        : room.events.find((event) => event.id === id);
    if (!entity?.editable) return;
    const roomKey = String(room.id);
    const overrides = project.roomOverrides[roomKey] ?? {
      actors: {},
      events: {},
    };
    const records = { ...overrides[kind] };
    if (value === null) delete records[id];
    else records[id] = { ...records[id], ...value };
    const updatedRoom = { ...overrides, [kind]: records };
    const roomOverrides = { ...project.roomOverrides, [roomKey]: updatedRoom };
    if (
      !Object.keys(updatedRoom.actors).length &&
      !Object.keys(updatedRoom.events).length &&
      !updatedRoom.geometry
    )
      delete roomOverrides[roomKey];
    transact({
      ...project,
      updatedAt: new Date().toISOString(),
      roomOverrides,
    });
  };
  const editGeometry = (translation: Vec3 | null) => {
    if (
      !project ||
      !baseRoom ||
      sample ||
      busyLock.current ||
      !baseRoom.geometryEdit?.supported
    )
      return;
    const checked = translation
      ? checkedGeometryTranslation(baseRoom as RoomData, translation)
      : null;
    const updated = withGeometryOverride(
      project,
      baseRoom.id,
      checked,
      baseRoom.geometryEdit.affectedRoomIds,
    );
    if (fingerprint(updated) === fingerprint(project)) return;
    transact(updated);
  };
  const undo = () => {
    const previous = past[past.length - 1];
    if (!previous || !project || busyLock.current) return;
    setFuture((items) => [project, ...items]);
    setProject(previous);
    setPast((items) => items.slice(0, -1));
  };
  const redo = () => {
    const next = future[0];
    if (!next || !project || busyLock.current) return;
    setPast((items) => [...items, project]);
    setProject(next);
    setFuture((items) => items.slice(1));
  };
  const frameRoom = (selectedOnly: boolean) =>
    setFrame((value) => ({
      version: value.version + 1,
      selected: selectedOnly,
    }));
  const copySelection = (id: string | null = selected, kind?: "room") => {
    if (!catalog || !room || sample || busyLock.current) return;
    if (kind === "room" || (!id && tab === "room")) {
      if (!project) return;
      const roomId = id?.startsWith("room:") ? Number(id.slice(5)) : room.id;
      void run("Copying room", async () => {
        const authored =
          project.version === 2 ? project.authoredRooms[roomId] : undefined;
        const scene = authored
          ? null
          : await api().loadProjectRoom(project, roomId);
        const entry =
          scene &&
          catalog.geometry.find(
            (a) => a.roomIds.includes(scene.id) && a.id.startsWith("geometry:"),
          );
        const asset = entry
          ? await api().loadGeometryAsset(entry.id)
          : undefined;
        const source =
          authored ??
          cloneScene(
            scene!,
            catalog,
            roomId,
            scene!.name,
            "replacement",
            asset,
          );
        setClipboard({
          kind: "room",
          room: structuredClone(source),
          romHash: catalog.romHash,
        });
        setNotice("Copied room.");
      });
      return;
    }
    if (
      !authoredRoom &&
      project &&
      room.meshes.some(
        (mesh) => mesh.id === id && mesh.source === "display-list",
      )
    ) {
      void run("Copying mesh", async () => {
        const scene = await api().loadProjectRoom(project, room.id);
        const sources = scene.meshes.filter(
          (mesh) => mesh.source === "display-list",
        );
        const index = sources.findIndex((mesh) => mesh.id === id);
        const entry = catalog.geometry.find(
          (a) => a.roomIds.includes(scene.id) && a.id.startsWith("geometry:"),
        );
        const asset = entry
          ? await api().loadGeometryAsset(entry.id)
          : undefined;
        const source = cloneScene(
          scene,
          catalog,
          scene.id,
          scene.name,
          "replacement",
          asset,
        );
        const mesh = source.meshes[index];
        if (!mesh)
          throw new Error("Select an existing native draw surface to copy.");
        setClipboard(
          copyGeometry(
            source,
            { meshId: mesh.id, mode: "mesh" },
            catalog.romHash,
          ),
        );
        setNotice("Copied mesh.");
      });
      return;
    }
    try {
      let copied: EditorClipboard;
      if (authoredRoom?.meshes.some((m) => m.id === id)) {
        copied = copyGeometry(
          authoredRoom,
          geometrySelection?.meshId === id
            ? geometrySelection
            : { meshId: id!, mode: "mesh" },
          catalog.romHash,
        );
      } else {
        const actor = authoredRoom?.actors.find((a) => a.id === id);
        const door = authoredRoom?.doors.find((d) => `door:${d.id}` === id);
        const entrance = authoredRoom?.entrances.find(
          (e) => `entrance:${e.id}` === id,
        );
        const native = room.actors.find(
          (a) =>
            a.id === (room.events.find((e) => e.id === id)?.actorRef ?? id),
        );
        const event = room.events.find(
          (e) => e.id === id && !e.actorRef && e.editable,
        );
        const halfword =
          native?.definitionSource?.expectedHex &&
          native.definitionSource.expectedHex.length >= 8
            ? parseInt(native.definitionSource.expectedHex.slice(4, 8), 16)
            : undefined;
        const prototype =
          native &&
          (catalog.actorPrototypes.find(
            (p) => p.sourceActorRef === native.id && p.sourceRoomId === room.id,
          ) ??
            catalog.actorPrototypes.find(
              (p) =>
                p.actorId === native.actorId &&
                (halfword === undefined || p.unknownHalfword === halfword),
            ));
        if (actor)
          copied = {
            kind: "actor",
            actor: structuredClone(actor),
            romHash: catalog.romHash,
          };
        else if (door)
          copied = {
            kind: "door",
            door: structuredClone(door),
            romHash: catalog.romHash,
          };
        else if (entrance)
          copied = {
            kind: "entrance",
            entrance: structuredClone(entrance),
            romHash: catalog.romHash,
          };
        else if (event)
          copied = {
            kind: "event",
            eventKind: event.kind,
            position: event.position ? { ...event.position } : undefined,
            values: [...event.values],
            romHash: catalog.romHash,
          };
        else if (native && prototype)
          copied = {
            kind: "actor",
            actor: {
              id: newId("actor"),
              prototypeId: prototype.id,
              position: { ...native.position },
              rotation: { ...native.rotation },
              parameters: [...native.parameters] as [number, number, number],
              spawnPolicy:
                native.sourceKind === "partition" ? "proximity" : "resident",
            },
            romHash: catalog.romHash,
          };
        else
          throw new Error(
            "Select an actor, mesh, face, vertex, door, entrance or editable room to copy.",
          );
      }
      setClipboard(copied);
      setNotice(`Copied ${copied.kind}.`);
    } catch (issue) {
      setError(messageOf(issue));
    }
  };
  const copyAsset = (asset: LibraryDrop) => {
    if (!catalog) return;
    setClipboard({
      kind: "asset",
      asset: { ...asset },
      romHash: catalog.romHash,
    });
    setNotice("Copied library asset.");
  };
  const pasteSelection = () => {
    if (
      !project ||
      !baseRoom ||
      !catalog ||
      !clipboard ||
      sample ||
      busyLock.current
    )
      return;
    if (clipboard.romHash !== catalog.romHash) {
      setError(
        "Copied objects belong to another source ROM. Copy an object from this ROM first.",
      );
      return;
    }
    if (clipboard.kind === "event") {
      const event = room?.events.find(
        (e) => e.id === selected && !e.actorRef && e.editable,
      );
      if (
        !event ||
        event.kind !== clipboard.eventKind ||
        event.values.length !== clipboard.values.length ||
        Boolean(event.position) !== Boolean(clipboard.position)
      ) {
        setError(
          "Select an editable event of the same kind to paste its properties.",
        );
        return;
      }
      edit("events", event.id, {
        position: clipboard.position,
        values: [...clipboard.values],
      });
      setNotice("Pasted event properties.");
      return;
    }
    void run("Pasting selection", async () => {
      let target = authoredRoom;
      if (!target) {
        const scene = await api().loadProjectRoom(project, baseRoom.id);
        const entry = catalog.geometry.find(
          (a) => a.roomIds.includes(scene.id) && a.id.startsWith("geometry:"),
        );
        const asset = entry
          ? await api().loadGeometryAsset(entry.id)
          : undefined;
        target = cloneScene(
          scene,
          catalog,
          scene.id,
          scene.name,
          "replacement",
          asset,
        );
      }
      let nextRoom: AuthoredRoom,
        nextSelected: string | null = null,
        nextGeometry: GeometrySelection | null = null;
      if (clipboard.kind === "asset") {
        if (clipboard.asset.kind === "actor") {
          const prototype = catalog.actorPrototypes.find(
            (a) => a.id === clipboard.asset.id,
          );
          if (!prototype)
            throw new Error("Actor is absent from the imported ROM catalog.");
          nextRoom = addActor(target, prototype, { x: 0, y: 0, z: 0 });
          nextSelected = nextRoom.actors.at(-1)!.id;
        } else if (clipboard.asset.kind === "geometry") {
          nextRoom = insertGeometry(
            target,
            await api().loadGeometryAsset(clipboard.asset.id),
            { x: 0, y: 0, z: 0 },
          );
          const mesh = nextRoom.meshes[target.meshes.length];
          if (mesh) {
            nextSelected = mesh.id;
            nextGeometry = { meshId: mesh.id, mode: "mesh" };
          }
        } else {
          if (!catalog.skyboxes.some((s) => s.id === clipboard.asset.id))
            throw new Error("Skybox is absent from the imported ROM catalog.");
          nextRoom = { ...target, skyboxId: clipboard.asset.id };
        }
      } else if (clipboard.kind === "room") {
        nextRoom = cloneAuthoredRoom(
          clipboard.room,
          availableRoomId(project, catalog),
          `${clipboard.room.name} copy`,
        );
      } else {
        const pasted = pasteEntity(
          target,
          clipboard,
          geometrySelection,
          followCollision,
        );
        nextRoom = pasted.room;
        nextSelected = pasted.selected;
        nextGeometry = pasted.geometry;
      }
      const next = updateAuthoredRoom(
        project,
        nextRoom,
        baseRoom.geometryEdit?.affectedRoomIds ?? [],
      );
      const preview = await api().loadProjectRoom(next, nextRoom.id);
      sceneReady.current = `${next.id}/${nextRoom.id}/${JSON.stringify(nextRoom)}`;
      setPast((history) => [...history.slice(-99), project]);
      setFuture([]);
      setProject(next);
      setBaseRoom(preview);
      setSelections(
        nextGeometry
          ? [{ kind: "geometry", choice: nextGeometry }]
          : nextSelected
            ? [{ kind: "record", id: nextSelected }]
            : [],
      );
      setTab(
        nextGeometry
          ? "geometry"
          : clipboard.kind === "room"
            ? "room"
            : "actors",
      );
      setNotice(`Pasted ${clipboard.kind}.`);
    });
  };
  const openContextMenu = (
    event: React.MouseEvent<HTMLElement>,
    id: string | null,
    kind?: "room",
  ) => {
    if (modal || busyLock.current || sample) return;
    event.preventDefault();
    setContextMenu({
      document: event.currentTarget.ownerDocument,
      x: event.clientX,
      y: event.clientY,
      id,
      kind,
    });
  };
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (
        event.defaultPrevented ||
        event.altKey ||
        event.isComposing ||
        event.keyCode === 229 ||
        ((event.metaKey || event.ctrlKey) &&
          event.key.toLowerCase() === "c" &&
          target.ownerDocument?.defaultView?.getSelection()?.isCollapsed ===
            false) ||
        target.closest?.(
          "input,textarea,select,[contenteditable]:not([contenteditable='false']),[role='textbox']",
        ) ||
        modal ||
        target.ownerDocument?.querySelector("dialog[open]") ||
        busyLock.current
      )
        return;
      if (event.metaKey || event.ctrlKey) {
        if (!event.repeat && event.key.toLowerCase() === "b") {
          event.preventDefault();
          dock.current?.toggleRegion(event.shiftKey ? "right" : "left");
        }
        if (!event.repeat && event.key.toLowerCase() === "j") {
          event.preventDefault();
          dock.current?.toggleRegion("bottom");
        }
        if (
          !event.shiftKey &&
          !event.repeat &&
          event.key.toLowerCase() === "c"
        ) {
          event.preventDefault();
          const card = target.closest<HTMLElement>(
            "[data-asset-id][data-asset-kind]",
          );
          if (card)
            copyAsset({
              id: card.dataset.assetId!,
              kind: card.dataset.assetKind as LibraryDrop["kind"],
            });
          else if (contextMenu) {
            if (contextMenu.asset) copyAsset(contextMenu.asset);
            else copySelection(contextMenu.id, contextMenu.kind);
          } else copySelection();
          setContextMenu(null);
        }
        if (
          !event.shiftKey &&
          !event.repeat &&
          event.key.toLowerCase() === "v"
        ) {
          event.preventDefault();
          pasteSelection();
          setContextMenu(null);
        }
        if (event.key.toLowerCase() === "s") {
          event.preventDefault();
          void saveProject();
        }
        if (event.key.toLowerCase() === "z") {
          event.preventDefault();
          event.shiftKey ? redo() : undo();
        }
      } else if (!event.repeat && event.key.toLowerCase() === "f") {
        event.preventDefault();
        frameRoom(Boolean(selected));
      } else if (!event.repeat && event.key.toLowerCase() === "g")
        setOptions((value) => ({ ...value, grid: !value.grid }));
      else if (!event.repeat && event.key.toLowerCase() === "t")
        setOptions((value) => ({ ...value, translate: value.transformMode !== "translate" || !value.translate, transformMode: "translate" }));
      else if (!event.repeat && event.key.toLowerCase() === "r")
        setOptions((value) => ({ ...value, translate: value.transformMode !== "rotate" || !value.translate, transformMode: "rotate" }));
    };
    const targets = [window, ...popupWindows];
    targets.forEach((target) => target.addEventListener("keydown", keydown));
    return () =>
      targets.forEach((target) =>
        target.removeEventListener("keydown", keydown),
      );
    // Actions depend on the current project/history, so refresh their closures.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    project,
    past,
    future,
    selected,
    modal,
    popupWindows,
    clipboard,
    geometrySelection,
    catalog,
    baseRoom,
    tab,
    followCollision,
    contextMenu,
  ]);
  const selectRecord = (id: string | null, additive = false) => {
    setSelections((current) =>
      selectItems(current, id ? { kind: "record", id } : null, additive),
    );
    if (room?.events.some((event) => event.id === id)) setTab("events");
    else if (id) setTab("actors");
  };
  const translateSelection = (delta: Vec3) => {
    if (!project || !room || sample || busyLock.current || modal || (!delta.x && !delta.y && !delta.z)) return;
    try {
      transact(
        translateProjectSelection(
          !projectAuthoredRoom && authoredRoom && selections.some(item => item.kind === "geometry")
            ? updateAuthoredRoom(project, authoredRoom, baseRoom?.geometryEdit?.affectedRoomIds ?? []) : project,
          room,
          selections,
          delta,
          followCollision,
        ),
      );
    } catch (issue) {
      setError(messageOf(issue));
      setOptions((value) => ({ ...value, translate: false }));
    }
  };
  const rotateSelection = (delta: RotationDelta, pivot: Vec3) => {
    if (!project || !room || sample || busyLock.current || modal || Math.hypot(delta.x, delta.y, delta.z) < 1e-10) return;
    try {
      const target = !projectAuthoredRoom && authoredRoom && selections.some(item => item.kind === "geometry")
        ? updateAuthoredRoom(project, authoredRoom, baseRoom?.geometryEdit?.affectedRoomIds ?? []) : project;
      const next = rotateProjectSelection(target, room, selections, delta, pivot, followCollision);
      transact(next);
    } catch (issue) { setError(messageOf(issue));setOptions(value => ({ ...value, translate: false })); }
  };
  const moveRecord = (id: string, position: Vec3) => {
    try {
      if (authoredRoom && (projectAuthoredRoom || authoredRoom.meshes.some(mesh => mesh.id === id))) {
        const checked = checkedPosition(position);
        const mesh = authoredRoom.meshes.find((m) => m.id === id);
        if (mesh) {
          const next = moveGeometrySelection(mesh, geometrySelection, checked);
          if (documentFingerprint(next) === documentFingerprint(mesh)) return;
          changeAuthoredRoom(
            replaceMesh(
              authoredRoom,
              next,
              authoredRoom.collisionMode === "authored" && followCollision,
            ),
          );
        } else
          changeAuthoredRoom({
            ...authoredRoom,
            actors: authoredRoom.actors.map((a) =>
              a.id === id ? { ...a, position: checked } : a,
            ),
            doors: authoredRoom.doors.map((d) =>
              `door:${d.id}` === id ? { ...d, position: checked } : d,
            ),
            entrances: authoredRoom.entrances.map((e) =>
              `entrance:${e.id}` === id ? { ...e, position: checked } : e,
            ),
          });
        return;
      }
      const actor = room?.actors.find((actor) => actor.id === id);
      const checked = actor
        ? checkedActorPosition(
            actor as import("../shared/types").ActorData,
            position,
          )
        : checkedPosition(position);
      edit(actor ? "actors" : "events", id, { position: checked });
    } catch (issue) {
      setError(messageOf(issue));
      setOptions((value) => ({ ...value, translate: false }));
    }
  };
  const selectedActor = room?.actors.find((actor) => actor.id === selected);
  const selectedEvent = room?.events.find((event) => event.id === selected);
  const sourceVisual = room?.actorVisuals?.find(
    (visual) => visual.actorRef === selected,
  );
  const visualFailure =
    actorCoverage.roomId === room?.id && selected
      ? actorCoverage.failures[selected]
      : undefined;
  const selectedVisual =
    sourceVisual && visualFailure
      ? {
          ...sourceVisual,
          status: "unsupported" as const,
          parts:
            selected && actorCoverage.renderedActorRefs.includes(selected)
              ? sourceVisual.parts
              : [],
          reason: visualFailure,
        }
      : sourceVisual;
  const selectedMovable = Boolean(room && selectionMovable(room, selections));
  const selectedRotatable = Boolean(room && selectionRotatable(room, selections));
  const sources = new Set(room?.meshes.map((mesh) => mesh.source));
  const textureCoverage =
    room && renderCoverage.roomId === room.id
      ? renderCoverage
      : room
        ? roomTextureCoverage(room)
        : { textured: 0, total: 0, images: 0 };
  const roomWarnings = [
    ...new Set([
      ...(room?.warnings ?? []),
      ...(renderCoverage.roomId === room?.id ? renderCoverage.warnings : []),
      ...(actorCoverage.roomId === room?.id ? actorCoverage.warnings : []),
      ...(actorVisualError?.source.id === baseRoom?.id && actorVisualError
        ? [actorVisualError.message]
        : []),
    ]),
  ];
  const geometryLabel = sample
    ? "Procedural sample"
    : textureCoverage.textured && options.textures
      ? "ROM texture preview"
      : sources.has("display-list")
        ? "Solid room geometry"
        : sources.has("collision")
          ? "Collision geometry"
          : "Placement markers";
  const overrides = project?.roomOverrides[String(room?.id)];
  const modified = Boolean(
    selected &&
      (overrides?.actors[selectedEvent?.actorRef ?? selected] ||
        overrides?.events[selected]),
  );
  const modificationCount =
    countProjectChanges(project) +
    (project?.version === 2
      ? Object.values(project.authoredRooms).reduce(
          (n, r) =>
            n +
            1 +
            r.meshes.length +
            r.actors.length +
            r.doors.length +
            r.entrances.length,
          0,
        )
      : 0);
  const geometryTranslation = baseRoom
    ? effectiveGeometryTranslation(baseRoom as RoomData, project)
    : null;
  const sharedImpacts = baseRoom
    ? sharedGeometryImpacts(baseRoom as RoomData, project)
    : [];
  const visibleRooms = rooms.filter((item) =>
    `${item.name} ${item.id} ${item.id.toString(16)}`
      .toLowerCase()
      .includes(roomSearch.toLowerCase()),
  );
  const records = room
    ? tab === "actors"
      ? room.actors
      : tab === "events"
        ? room.events
        : []
    : [];
  const visibleRecords = records.filter((item) =>
    `${item.name} ${item.index} ${"actorId" in item ? item.actorId.toString(16) : item.kind}`
      .toLowerCase()
      .includes(recordSearch.toLowerCase()),
  );
  const loadEntrances = useCallback(
    async (id: number) => {
      if (project?.version === 2 && project.authoredRooms[id])
        return project.authoredRooms[id].entrances;
      if (!project) return [];
      return (await window.mnsg!.loadProjectRoom(project, id)).entrances;
    },
    [project],
  );
  useEffect(() => {
    const add = (
      level: WorkspaceLog["level"],
      source: string,
      message: string,
    ) =>
      setConsoleLogs((logs) =>
        appendWorkspaceLog(logs, { level, source, message, time: Date.now() }),
      );
    if (error) add("error", errorSource, error);
    if (notice) add("info", "Project", notice);
  }, [error, errorSource, notice]);
  useEffect(() => {
    roomWarnings.forEach((message) =>
      setConsoleLogs((logs) =>
        appendWorkspaceLog(logs, {
          level: "warning",
          source: `Room ${room?.id ?? ""}`,
          message,
          time: Date.now(),
        }),
      ),
    );
  }, [room?.id, JSON.stringify(roomWarnings)]);
  useEffect(() => {
    if (modal) window.focus();
  }, [modal]);
  const closeModal = useCallback(() => setModal(null), []);
  const showSample = () => {
    setSample(true);
    setProject(null);
    setSaved("");
    setRooms([sampleRoom]);
    setBaseRoom(sampleRoom);
    setSelected(null);
    setError("");
    setNotice("");
  };

  return (
    <Column as="main" fill className="mnsg-editor">
      <Row
        className="app-toolbar"
        vertical="center"
        horizontal="between"
        paddingX="20"
        borderBottom
      >
        <Row gap="12" vertical="center">
          <span className="studio-mark">
            <FiBox />
          </span>
          <Column gap="2">
            <Text variant="label-strong-s">
              MNSG <span className="wordmark-light">STUDIO</span>
            </Text>
            <Text variant="label-default-xs" onBackground="neutral-weak">
              LEVEL & ACTOR EDITOR
            </Text>
          </Column>
          <span className="toolbar-divider" />
          <span className="project-title">
            {sample ? "Sample workspace" : (project?.name ?? "No project")}
          </span>
          {dirty && (
            <span className="dirty-state" title="Unsaved project changes">
              Unsaved
            </span>
          )}
        </Row>
        <Row gap="8" vertical="center">
          <Button
            size="s"
            variant="tertiary"
            aria-label="Project and build settings"
            disabled={Boolean(busy)}
            onClick={() => setModal("settings")}
          >
            <FiSettings />
            Settings
          </Button>
          <Button
            size="s"
            variant="tertiary"
            onClick={() => guard(() => setModal("new"))}
            disabled={!status?.rom || sample || Boolean(busy)}
          >
            <FiPlus />
            New
          </Button>
          <Button
            size="s"
            variant="tertiary"
            onClick={openProject}
            disabled={sample || Boolean(busy)}
          >
            <FiFolder />
            Open
          </Button>
          <Button
            size="s"
            variant="secondary"
            onClick={() => void saveProject()}
            disabled={!project || sample || Boolean(busy)}
            title="Save project · ⌘/Ctrl S"
          >
            <FiSave />
            Save
          </Button>
          <Button
            size="s"
            onClick={() => setModal("export")}
            disabled={!project || sample || !modificationCount || Boolean(busy)}
          >
            <FiArrowUpRight />
            Export
          </Button>
        </Row>
      </Row>

      {booting ? (
        <Column fill center gap="16">
          <Spinner />
          <Text onBackground="neutral-weak">Opening workspace…</Text>
        </Column>
      ) : !room && !status?.rom ? (
        <Row fill center padding="32">
          <Column className="onboarding" maxWidth="m" gap="32">
            <Row gap="24" vertical="center">
              <span className="onboarding-mark">
                <FiLayers />
              </span>
              <Column gap="12">
                <Text variant="label-default-s" onBackground="brand-medium">
                  YOUR WORLD, UNDER THE SURFACE
                </Text>
                <Text variant="display-strong-m">A closer look at Goemon.</Text>
              </Column>
            </Row>
            <Text variant="body-default-l" onBackground="neutral-weak">
              Explore rooms, inspect actor placements, and turn your changes
              into a Recomp mod. Start with your own US copy of Mystical Ninja
              Starring Goemon.
            </Text>
            <Column
              background="surface"
              border
              radius="l"
              padding="24"
              gap="20"
            >
              <Row gap="16" vertical="center">
                <span className="step-number">01</span>
                <Column gap="4">
                  <Text variant="body-strong-m">Connect your ROM</Text>
                  <Text variant="body-default-s" onBackground="neutral-weak">
                    Select it once. The app verifies the US release and handles
                    decompression locally.
                  </Text>
                </Column>
              </Row>
              <Button size="l" onClick={importRom} loading={Boolean(busy)}>
                <FiUpload />
                {busy || "Choose US ROM"}
              </Button>
              <Text variant="body-default-xs" onBackground="neutral-weak">
                Your ROM stays on this computer. Project edits are stored
                separately from the source file.
              </Text>
            </Column>
            <Row horizontal="between" vertical="center">
              <Text variant="label-default-s" onBackground="neutral-weak">
                Just looking around?
              </Text>
              <Button size="s" variant="tertiary" onClick={showSample}>
                Open procedural sample <FiChevronRight />
              </Button>
            </Row>
            {!status && (
              <div className="inline-notice">
                Browser preview · import and file export are available in the
                desktop app.
              </div>
            )}
            {error && (
              <div className="error-banner" role="alert">
                {error}
              </div>
            )}
          </Column>
        </Row>
      ) : (
        <>
          <DockWorkspace
            ref={dock}
            blocked={Boolean(busy) || Boolean(modal)}
            onWindowsChange={setPopupWindows}
            onSceneHostChange={setSceneHost}
            onInteraction={setWorkspaceInteraction}
            panels={{
              rooms: (
                <Column className="room-panel" borderRight>
                  <label className="search-box">
                    <FiSearch />
                    <input
                      aria-label="Search rooms"
                      placeholder="Search rooms…"
                      value={roomSearch}
                      onChange={(event) => setRoomSearch(event.target.value)}
                    />
                    <kbd>/</kbd>
                  </label>
                  {!sample && (
                    <Row paddingX="16" gap="4">
                      <Button
                        size="s"
                        variant="secondary"
                        disabled={!catalog || Boolean(busy)}
                        data-testid="new-room-button"
                        onClick={() => setModal("room-new")}
                      >
                        New room
                      </Button>
                    </Row>
                  )}
                  <Row
                    className="list-caption"
                    paddingX="20"
                    paddingY="12"
                    horizontal="between"
                    textVariant="label-default-xs"
                    onBackground="neutral-weak"
                  >
                    <span>
                      {sample ? "PROCEDURAL WORKSPACE" : "ROOM DIRECTORY"}
                    </span>
                  </Row>
                  <Column
                    className="room-list"
                    overflowY="auto"
                    gap="4"
                    paddingX="8"
                  >
                    {visibleRooms.map((item) => (
                      <Button
                        variant="tertiary"
                        size="s"
                        horizontal="start"
                        data-testid="room-button"
                        data-room-id={item.id}
                        onContextMenu={(event: React.MouseEvent<HTMLElement>) =>
                          openContextMenu(event, `room:${item.id}`, "room")
                        }
                        className={`room-item ${room?.id === item.id ? "is-selected" : ""}`}
                        key={item.id}
                        onClick={() => !sample && void loadRoom(item.id)}
                        disabled={Boolean(busy)}
                        aria-current={room?.id === item.id ? "true" : undefined}
                      >
                        <span className="room-index">
                          {item.id.toString(16).toUpperCase().padStart(3, "0")}
                        </span>
                        <span className="room-item-info">
                          <span>{item.name}</span>
                          <span>
                            {item.actorCount} actors{" "}
                            <span className="tiny-dot">·</span>{" "}
                            {item.eventCount} events
                          </span>
                        </span>
                        {(project?.roomOverrides[String(item.id)] ||
                          (project?.version === 2 &&
                            project.authoredRooms[item.id])) && (
                          <span className="modified-dot" />
                        )}
                        {room?.id === item.id && <FiChevronRight />}
                      </Button>
                    ))}
                    {!visibleRooms.length && (
                      <Text
                        padding="16"
                        variant="body-default-s"
                        onBackground="neutral-weak"
                      >
                        No matching rooms.
                      </Text>
                    )}
                  </Column>
                </Column>
              ),
              scene: (
                <Column className="viewport-panel" flex={1}>
                  <Row
                    className="viewport-heading"
                    vertical="center"
                    horizontal="between"
                    paddingX="20"
                    borderBottom
                  >
                    <Row gap="12" vertical="center">
                      <Text variant="body-strong-s">
                        {room?.name ?? "Choose a room"}
                      </Text>
                      <span className="geometry-badge">{geometryLabel}</span>
                      {selections.length > 0 && (
                        <span
                          className="geometry-badge"
                          data-testid="selection-summary"
                          aria-live="polite"
                        >
                          {selections.length} selected
                        </span>
                      )}
                    </Row>
                    <Row gap="4">
                      <TooltipButton
                        size="s"
                        variant="tertiary"
                        aria-label="Undo"
                        title="Undo · ⌘/Ctrl Z"
                        disabled={!past.length || Boolean(busy)}
                        onClick={undo}
                      >
                        <FiCornerUpLeft />
                      </TooltipButton>
                      <TooltipButton
                        size="s"
                        variant="tertiary"
                        aria-label="Redo"
                        title="Redo · ⌘/Ctrl Shift Z"
                        disabled={!future.length || Boolean(busy)}
                        onClick={redo}
                      >
                        <FiCornerUpRight />
                      </TooltipButton>
                    </Row>
                  </Row>
                  <div className="viewport-stage">
                    {room && (
                      <RoomViewport
                        room={room}
                        cameraSnapshot={cameraSnapshot}
                        hostWindow={sceneHost?.window ?? null}
                        sceneVisible={sceneHost?.visible ?? false}
                        selected={selected}
                        selections={selections}
                        onTranslateSelection={translateSelection}
                        onRotateSelection={rotateSelection}
                        options={
                          busy ? { ...options, translate: false } : options
                        }
                        frame={frame}
                        onSelect={selectRecord}
                        onMove={moveRecord}
                        onCoverage={setRenderCoverage}
                        onActorCoverage={setActorCoverage}
                        mouseMode={mouseMode}
                        navigationEnabled={
                          !modal && !busy && !workspaceInteraction
                        }
                        geometrySelection={geometrySelection}
                        onGeometrySelect={selectGeometry}
                        onAssetDrop={authoredRoom ? insertAsset : undefined}
                        onEditMenu={(location) => {
                          if (!modal && !busyLock.current && !sample)
                            setContextMenu(location);
                        }}
                      />
                    )}
                    <div className="viewport-top-overlay">
                      <div className="view-tool-stack">
                        <TooltipButton
                          variant="tertiary"
                          size="s"
                          horizontal="start"
                          aria-label="Frame all geometry"
                          title="Frame all geometry"
                          onClick={() => frameRoom(false)}
                        >
                          <FiMaximize />
                        </TooltipButton>
                        <TooltipButton
                          variant="tertiary"
                          size="s"
                          horizontal="start"
                          aria-label="Frame selected record"
                          title="Frame selected · F"
                          disabled={!selected}
                          onClick={() => frameRoom(true)}
                        >
                          <span>F</span>
                        </TooltipButton>
                        <span className="stack-divider" />
                        <TooltipButton
                          variant="tertiary"
                          size="s"
                          horizontal="start"
                          aria-label="Toggle translation gizmo"
                          title="Translate · T"
                          aria-pressed={options.translate && options.transformMode === "translate"}
                          disabled={sample || Boolean(busy) || !selectedMovable}
                          onClick={() =>
                            setOptions((value) => ({
                              ...value,
                              translate: value.transformMode !== "translate" || !value.translate,
                              transformMode: "translate",
                            }))
                          }
                        >
                          <FiMove />
                        </TooltipButton>
                        <TooltipButton
                          variant="tertiary" size="s" horizontal="start"
                          aria-label="Toggle rotation gizmo" title="Rotate selected items · R"
                          aria-pressed={options.translate && options.transformMode === "rotate"}
                          disabled={sample || Boolean(busy) || !selectedRotatable}
                          onClick={() => setOptions(value => ({ ...value, translate: value.transformMode !== "rotate" || !value.translate, transformMode: "rotate" }))}
                        ><FiRotateCw /></TooltipButton>
                      </div>
                    </div>
                    {room &&
                      !room.meshes.length &&
                      (actorCoverage.roomId !== room.id ||
                        actorCoverage.parts === 0) && (
                        <div className="no-geometry">
                          No verified room geometry. Actor previews remain
                          available.
                        </div>
                      )}
                    {!sample && room && (
                      <div
                        className="actor-preview-summary"
                        data-testid="actor-preview-summary"
                        role="status"
                      >
                        {actorRefreshing
                          ? "Refreshing actor models · previous preview retained"
                          : actorVisualError?.source.id === baseRoom?.id
                            ? "Actor preview refresh failed · previous preview retained"
                            : actorCoverage.roomId === room.id
                              ? `${actorCoverage.supported} native models · ${actorCoverage.conditional} conditional · ${actorCoverage.partial} partial · ${actorCoverage.nonvisual} controllers · ${actorCoverage.unsupported - actorCoverage.partial} unavailable`
                              : "Reading actor visuals"}
                      </div>
                    )}
                    {busy && (
                      <div className="viewport-loading" role="status">
                        <Spinner size="s" />
                        {busy}…
                      </div>
                    )}
                  </div>
                  <Row
                    className="viewport-controls"
                    vertical="center"
                    horizontal="between"
                    paddingX="16"
                    borderTop
                  >
                    <Row gap="4">
                      <Row
                        gap="2"
                        role="group"
                        aria-label="Left mouse drag mode"
                      >
                        {(["pan", "tilt"] as const).map((mode) => (
                          <Button
                            key={mode}
                            data-testid={`camera-${mode}`}
                            size="s"
                            variant="tertiary"
                            className={
                              mouseMode === mode
                                ? "view-toggle active"
                                : "view-toggle"
                            }
                            aria-pressed={mouseMode === mode}
                            title={`Left-drag to ${mode}`}
                            onClick={() => setMouseMode(mode)}
                          >
                            {mode === "pan" ? "Pan" : "Tilt"}
                          </Button>
                        ))}
                      </Row>
                      {(
                        [
                          "geometry",
                          "textures",
                          "grid",
                          "wireframe",
                          "actors",
                          "events",
                          "axes",
                        ] as const
                      ).map((key) => (
                        <Button
                          variant="tertiary"
                          size="s"
                          horizontal="start"
                          key={key}
                          data-testid={
                            key === "textures" || key === "geometry"
                              ? `${key}-toggle`
                              : undefined
                          }
                          title={
                            key === "geometry"
                              ? "Show or hide room surfaces to inspect actors in their initial pose"
                              : undefined
                          }
                          disabled={
                            key === "textures" &&
                            !textureCoverage.textured &&
                            !(
                              actorCoverage.roomId === room?.id &&
                              actorCoverage.texturedTriangles
                            )
                          }
                          className={
                            options[key] ? "view-toggle active" : "view-toggle"
                          }
                          aria-pressed={options[key]}
                          onClick={() =>
                            setOptions((value) => ({
                              ...value,
                              [key]: !value[key],
                            }))
                          }
                        >
                          {key === "grid" && <FiGrid />}
                          {key.charAt(0).toUpperCase() + key.slice(1)}
                        </Button>
                      ))}
                    </Row>
                    <Text
                      variant="label-default-xs"
                      onBackground="neutral-weak"
                    >
                      {room?.meshes
                        .reduce((sum, mesh) => sum + mesh.indices.length / 3, 0)
                        .toLocaleString()}{" "}
                      triangles
                    </Text>
                  </Row>
                  <div className="scene-navigation-bar" data-testid="viewport-navigation-hint">
                    <span>Click viewport · <kbd>WASD</kbd> to move</span>
                    <span>Left-drag to {mouseMode === "pan" ? "pan" : "tilt"} · right-drag to pan · scroll to zoom</span>
                  </div>
                  <div className="viewport-note">
                    {sharedImpacts.length > 0
                      ? `Shared geometry translation from room ${sharedImpacts.map((id) => `0x${id.toString(16).toUpperCase()}`).join(", ")} · actor placements unchanged`
                      : sample
                        ? "Procedural sample · no ROM data · read only"
                        : options.textures && textureCoverage.textured
                          ? `ROM textures · ${textureCoverage.textured.toLocaleString()}/${textureCoverage.total.toLocaleString()} triangles · lighting, filtering and fog approximate`
                          : "Solid preview · native actor initial poses · game behavior is not simulated"}
                  </div>
                </Column>
              ),
              hierarchy: (
                <Column className="hierarchy-content">
                  <div
                    className="outliner-tabs"
                    role="tablist"
                    aria-label="Room records"
                  >
                    {(["actors", "events", "geometry", "room"] as const).map(
                      (kind) => (
                        <Button
                          variant="tertiary"
                          size="s"
                          horizontal="start"
                          role="tab"
                          id={`${kind}-tab`}
                          data-testid={
                            kind === "room" ? "room-geometry-tab" : undefined
                          }
                          aria-controls="records-panel"
                          aria-selected={tab === kind}
                          className={tab === kind ? "active" : ""}
                          key={kind}
                          onClick={() => {
                            setTab(kind);
                            if (kind === "room") {
                              setSelected(null);
                            }
                          }}
                        >
                          {kind.charAt(0).toUpperCase() + kind.slice(1)}
                          {(kind === "actors" || kind === "events") && (
                            <span>{room?.[kind].length ?? 0}</span>
                          )}
                        </Button>
                      ),
                    )}
                  </div>
                  {tab !== "room" && tab !== "geometry" && (
                    <>
                      <label className="search-box compact">
                        <FiSearch />
                        <input
                          aria-label="Search records"
                          placeholder={`Find ${tab}…`}
                          value={recordSearch}
                          onChange={(event) =>
                            setRecordSearch(event.target.value)
                          }
                        />
                      </label>
                      <div
                        className="record-list"
                        data-testid="actor-list"
                        id="records-panel"
                        role="tabpanel"
                        aria-labelledby={`${tab}-tab`}
                      >
                        {visibleRecords.map((item) => (
                          <Button
                            variant="tertiary"
                            size="s"
                            horizontal="start"
                            key={item.id}
                            data-record-id={item.id}
                            className={`record-item ${selections.some((value) => selectionId(value) === item.id) ? "is-selected" : ""}`}
                            aria-pressed={selections.some(
                              (value) => selectionId(value) === item.id,
                            )}
                            onClick={(event: React.MouseEvent<HTMLElement>) =>
                              selectRecord(
                                item.id,
                                event.metaKey || event.ctrlKey,
                              )
                            }
                            onContextMenu={(
                              event: React.MouseEvent<HTMLElement>,
                            ) => {
                              if (
                                !selections.some(
                                  (value) => selectionId(value) === item.id,
                                )
                              )
                                selectRecord(item.id);
                              openContextMenu(event, item.id);
                            }}
                          >
                            <span className={`record-symbol ${tab}`}>
                              {tab === "actors" ? <FiBox /> : "◇"}
                            </span>
                            <span>{item.name}</span>
                            <code>
                              {item.index.toString().padStart(2, "0")}
                            </code>
                            {(overrides?.actors[
                              "actorRef" in item && item.actorRef
                                ? item.actorRef
                                : item.id
                            ] ||
                              overrides?.events[item.id]) && (
                              <span className="modified-dot" />
                            )}
                          </Button>
                        ))}
                        {!visibleRecords.length && (
                          <div className="empty-records">
                            {recordSearch
                              ? "No matching records."
                              : `No ${tab} in this room.`}
                          </div>
                        )}
                      </div>
                    </>
                  )}
                  {tab === "geometry" && (
                    <div
                      className="record-list"
                      data-testid="authored-geometry-list"
                    >
                      {authoredRoom ? (
                        authoredRoom.meshes.map((mesh, i) => (
                          <Button
                            size="s"
                            variant="tertiary"
                            className={`record-item ${selections.some((value) => selectionId(value) === mesh.id) ? "is-selected" : ""}`}
                            aria-pressed={selections.some(
                              (value) => selectionId(value) === mesh.id,
                            )}
                            key={mesh.id}
                            data-mesh-id={mesh.id}
                            onContextMenu={(
                              event: React.MouseEvent<HTMLElement>,
                            ) => {
                              if (
                                !selections.some(
                                  (value) => selectionId(value) === mesh.id,
                                )
                              )
                                selectGeometry({
                                  meshId: mesh.id,
                                  mode: "mesh",
                                });
                              openContextMenu(event, mesh.id);
                            }}
                            onClick={(event: React.MouseEvent<HTMLElement>) =>
                              selectGeometry(
                                { meshId: mesh.id, mode: "mesh" },
                                event.metaKey || event.ctrlKey,
                              )
                            }
                          >
                            Mesh {i + 1} · {mesh.vertices.length} vertices
                          </Button>
                        ))
                      ) : (
                        <Column padding="20" gap="12">
                          <Text variant="body-default-s">{sample ? "Import your ROM to edit room geometry." : "Preparing room geometry for editing…"}</Text>
                        </Column>
                      )}
                    </div>
                  )}
                </Column>
              ),
              inspector: (
                <Column className="inspector-panel-content">
                  {" "}
                  <Row
                    className="inspector-heading"
                    paddingX="20"
                    paddingY="12"
                    borderY
                    horizontal="between"
                  >
                    <Text
                      variant="label-default-xs"
                      onBackground="neutral-weak"
                    >
                      {projectAuthoredRoom
                        ? "Authored data"
                        : (
                              tab === "room"
                                ? Boolean(geometryTranslation)
                                : modified
                            )
                          ? "Modified"
                          : "Source values"}
                    </Text>
                  </Row>
                  <div
                    className="inspector-scroll"
                    onContextMenu={(event) => {
                      if (
                        !(event.target as HTMLElement).closest(
                          "input,textarea,select",
                        )
                      )
                        openContextMenu(
                          event,
                          selected,
                          tab === "room" ? "room" : undefined,
                        );
                    }}
                  >
                    {selections.length > 1 ? (
                      <SelectionInspector
                        key={selections.map(selectionKey).join("|")}
                        count={selections.length}
                        movable={Boolean(
                          room && selectionMovable(room, selections),
                        )}
                        disabled={sample || Boolean(busy) || Boolean(modal)}
                        onTranslate={translateSelection}
                        onFrame={() => frameRoom(true)}
                        translating={options.translate && options.transformMode === "translate"}
                        onToggleMove={() =>
                          setOptions((value) => ({
                            ...value,
                            translate: value.transformMode !== "translate" || !value.translate,
                              transformMode: "translate",
                          }))
                        }
                        rotatable={selectedRotatable}
                        rotating={options.translate && options.transformMode === "rotate"}
                        onToggleRotate={() => setOptions(value => ({ ...value, translate: value.transformMode !== "rotate" || !value.translate, transformMode: "rotate" }))}
                      />
                    ) : authoredRoom &&
                      (projectAuthoredRoom || geometrySelection || tab === "room" || tab === "geometry") &&
                      catalog &&
                      !(tab === "events" && selectedEvent) ? (
                      <AuthoringInspector
                        loadMaterialPreview={api().loadMaterialPreview}
                        key={selected ?? `room:${authoredRoom.id}`}
                        room={authoredRoom}
                        initialization={baseRoom?.initialization}
                        catalog={catalog}
                        selected={selected}
                        geometrySelection={geometrySelection}
                        disabled={Boolean(busy) || Boolean(modal)}
                        onChange={changeAuthoredRoom}
                        onSelect={selectRecord}
                        onGeometrySelect={selectGeometry}
                        onFrame={() => frameRoom(Boolean(selected))}
                        savedRoom={savedAuthored}
                        onRevertSaved={() =>
                          savedAuthored &&
                          changeAuthoredRoom(structuredClone(savedAuthored))
                        }
                        onRestoreNative={projectAuthoredRoom ? restoreNative : undefined}
                        followCollision={followCollision}
                        onFollowCollision={setFollowCollision}
                        visual={selectedVisual}
                        visualsPending={actorRefreshing}
                        externalEntranceIds={externalEntranceIds}
                        nativeEntranceIds={nativeEntranceIds}
                        referencedEntrances={inboundEntranceIds}
                        destinationRooms={rooms}
                        loadEntrances={loadEntrances}
                      />
                    ) : (
                      <>
                        {tab !== "room" &&
                        selectedActor &&
                        selectedVisual?.parts.length &&
                        !sample ? (
                          <div className="inspector-notice actor-occlusion-note">
                            An actor’s initial pose may be hidden behind room
                            surfaces. Use Geometry below the viewport to inspect
                            it.
                          </div>
                        ) : null}
                        {tab === "room" && baseRoom ? (
                          <div
                            id="records-panel"
                            role="tabpanel"
                            aria-labelledby="room-tab"
                          >
                            <RoomInspector
                              key={`room:${project?.id}:${baseRoom.id}`}
                              room={baseRoom as RoomData}
                              translation={
                                geometryTranslation ?? { x: 0, y: 0, z: 0 }
                              }
                              modified={Boolean(geometryTranslation)}
                              sample={sample}
                              busy={Boolean(busy) || Boolean(modal)}
                              sharedImpacts={sharedImpacts}
                              onChange={editGeometry}
                              onReset={() => editGeometry(null)}
                              onFrame={() => frameRoom(false)}
                            />
                          </div>
                        ) : (
                          <Inspector
                            key={selected ?? "none"}
                            actor={
                              selectedActor as
                                | import("../shared/types").ActorData
                                | undefined
                            }
                            event={selectedEvent}
                            visual={selectedVisual}
                            visualsPending={actorRefreshing}
                            sample={sample}
                            busy={Boolean(busy) || Boolean(modal)}
                            supportedActorIds={
                              baseRoom?.actors.map((actor) => actor.actorId) ??
                              []
                            }
                            modified={modified}
                            onActor={(value) =>
                              selected && edit("actors", selected, value)
                            }
                            onEvent={(value) =>
                              selected && edit("events", selected, value)
                            }
                            onReset={() =>
                              selected &&
                              edit(
                                selectedActor ? "actors" : "events",
                                selected,
                                null,
                              )
                            }
                            onFrame={() => frameRoom(true)}
                            onInspectActor={(id) => {
                              selectRecord(id);
                              setTab("actors");
                            }}
                          />
                        )}
                      </>
                    )}
                  </div>
                </Column>
              ),
              assets:
                catalog && window.mnsg ? (
                  <AssetLibrary
                    catalog={catalog}
                    api={window.mnsg}
                    disabled={!authoredRoom || Boolean(busy) || Boolean(modal)}
                    onInsert={insertAsset}
                    onContextMenu={(event, asset) => {
                      event.preventDefault();
                      setContextMenu({
                        document: event.currentTarget.ownerDocument,
                        x: event.clientX,
                        y: event.clientY,
                        id: null,
                        asset,
                      });
                    }}
                  />
                ) : (
                  <Text padding="16" onBackground="neutral-weak">
                    Import your US ROM to browse native assets.
                  </Text>
                ),
              console: (
                <Column className="workspace-console" fill>
                  <Row gap="8" padding="8">
                    <label>
                      Severity{" "}
                      <select
                        aria-label="Console severity"
                        value={consoleFilter}
                        onChange={(event) =>
                          setConsoleFilter(event.target.value)
                        }
                      >
                        <option value="all">All</option>
                        <option value="error">Errors</option>
                        <option value="warning">Warnings</option>
                        <option value="info">Information</option>
                      </select>
                    </label>
                    <label>
                      Source{" "}
                      <select
                        aria-label="Console source"
                        value={consoleSource}
                        onChange={(event) =>
                          setConsoleSource(event.target.value)
                        }
                      >
                        <option value="all">All sources</option>
                        {[
                          ...new Set(consoleLogs.map((entry) => entry.source)),
                        ].map((source) => (
                          <option key={source} value={source}>
                            {source}
                          </option>
                        ))}
                      </select>
                    </label>
                    <Button
                      variant="tertiary"
                      size="s"
                      onClick={() => setConsoleLogs([])}
                    >
                      Clear console
                    </Button>
                  </Row>
                  <div
                    className="console-records"
                    role="log"
                    aria-label="Editor console"
                  >
                    {consoleLogs
                      .filter(
                        (entry) =>
                          (consoleFilter === "all" ||
                            entry.level === consoleFilter) &&
                          (consoleSource === "all" ||
                            entry.source === consoleSource),
                      )
                      .map((entry) => (
                        <div
                          key={entry.id}
                          className={`console-entry console-${entry.level}`}
                        >
                          <time>
                            {new Date(entry.time).toLocaleTimeString()}
                          </time>
                          <strong>{entry.level}</strong>
                          <span>{entry.source}</span>
                          <p>{entry.message}</p>
                        </div>
                      ))}
                    {!consoleLogs.length && (
                      <Text
                        padding="16"
                        variant="body-default-s"
                        onBackground="neutral-weak"
                      >
                        No editor messages in this session.
                      </Text>
                    )}
                  </div>
                </Column>
              ),
            }}
          />
          {error && (
            <div className="error-banner workspace-banner" role="alert">
              <span>{error}</span>
              <TooltipButton
                variant="tertiary"
                size="s"
                horizontal="start"
                aria-label="Dismiss error"
                onClick={() => setError("")}
              >
                <FiX />
              </TooltipButton>
            </div>
          )}
          {roomWarnings.length ? (
            <details className="room-warnings">
              <summary>
                {roomWarnings.length} room{" "}
                {roomWarnings.length === 1 ? "note" : "notes"}
              </summary>
              {roomWarnings.map((warning, index) => (
                <p key={index}>{warning}</p>
              ))}
            </details>
          ) : null}
          <Row
            className="status-bar"
            vertical="center"
            horizontal="between"
            paddingX="20"
            borderTop
          >
            <Row gap="8" vertical="center">
              <span className="connection-dot" />
              <span role="status">
                {busy ||
                  notice ||
                  (sample
                    ? "Sample workspace"
                    : dirty
                      ? `${modificationCount} project changes · unsaved project`
                      : "Ready")}
              </span>
            </Row>
            <Row gap="16">
              <span>
                {room &&
                  `${room.actors.length} actors / ${room.events.length} events`}
              </span>
              <span className="status-version">
                MNSG STUDIO {status?.appVersion ?? "PREVIEW"}
              </span>
            </Row>
          </Row>
        </>
      )}
      {contextMenu && (
        <EditorContextMenu
          location={contextMenu}
          canCopy={Boolean(
            contextMenu.id || contextMenu.kind === "room" || contextMenu.asset,
          )}
          canPaste={Boolean(clipboard) && !busy}
          onCopy={() =>
            contextMenu.asset
              ? copyAsset(contextMenu.asset)
              : copySelection(contextMenu.id, contextMenu.kind)
          }
          onPaste={pasteSelection}
          onClose={closeContextMenu}
        />
      )}
      {modal === "settings" && (
        <ModalShell
          title="Project and build settings"
          onClose={closeModal}
          wide
        >
          {project && !sample ? (
            <ModSettingsPanel
              project={project}
              busy={Boolean(busy)}
              sourceRom={status?.rom?.title}
              onChangeSource={() => {
                setModal(null);
                importRom();
              }}
              onClose={closeModal}
              onApply={(mod) => {
                transact({ ...canonicalProject(project), mod });
                setModal(null);
              }}
            />
          ) : (
            <Column gap="16">
              <Text variant="body-default-s">
                Import your source ROM to begin editing.
              </Text>
              <Button
                onClick={() => {
                  setModal(null);
                  setSample(false);
                  setBaseRoom(null);
                  setRooms([]);
                  importRom();
                }}
              >
                Choose US ROM
              </Button>
            </Column>
          )}
        </ModalShell>
      )}
      {modal === "room-new" && (
        <ModalShell title="New room" onClose={closeModal}>
          <ValueField
            label="Room name"
            value={newRoomName}
            disabled={Boolean(busy)}
            commit={setNewRoomName}
          />
          <Row gap="8">
            <Button
              variant={newRoomMode === "blank" ? "secondary" : "tertiary"}
              onClick={() => setNewRoomMode("blank")}
            >
              Blank room
            </Button>
            <Button
              variant={newRoomMode === "clone" ? "secondary" : "tertiary"}
              onClick={() => setNewRoomMode("clone")}
            >
              Clone current room
            </Button>
          </Row>
          <Text variant="body-default-s" onBackground="neutral-weak">
            The current room supplies verified native service metadata. New room
            IDs use the project range 620–799. Add entrances, geometry,
            collision and actors before export.
          </Text>
          <Button
            disabled={!newRoomName.trim() || Boolean(busy)}
            data-testid="create-room-button"
            onClick={createRoom}
          >
            Create room
          </Button>
        </ModalShell>
      )}
      {modal === "new" && (
        <ModalShell title="New project" onClose={closeModal}>
          <Text variant="body-default-s" onBackground="neutral-weak">
            Keep a set of room and actor changes together. Your source ROM
            remains unchanged.
          </Text>
          <label className="value-field">
            <span>Project name</span>
            <input
              value={newName}
              maxLength={120}
              onChange={(event) => setNewName(event.target.value)}
            />
          </label>
          <Button
            disabled={!newName.trim() || Boolean(busy)}
            onClick={() =>
              void run("Creating project", async () => {
                acceptProject(await api().newProject(newName.trim()));
                setModal(null);
                setNotice("Project created. Select a record to begin editing.");
              })
            }
          >
            Create project
          </Button>
        </ModalShell>
      )}
      {modal === "discard" && (
        <ModalShell title="Unsaved project changes" onClose={closeModal}>
          <Text variant="body-default-s" onBackground="neutral-weak">
            Save your project before continuing, or discard the changes in this
            workspace.
          </Text>
          <Row gap="8">
            <Button variant="secondary" onClick={closeModal}>
              Keep editing
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                const task = deferred.current;
                deferred.current = null;
                setModal(null);
                task?.();
              }}
            >
              Discard & continue
            </Button>
            <Button
              disabled={Boolean(busy)}
              onClick={() => void saveAndContinue()}
            >
              <FiSave />
              Save & continue
            </Button>
          </Row>
        </ModalShell>
      )}
      {modal === "export" && (
        <ModalShell title="Bring your changes to Recomp" onClose={closeModal}>
          <Text variant="body-default-s" onBackground="neutral-weak">
            Export {modificationCount} project{" "}
            {modificationCount === 1 ? "change" : "changes"} across{" "}
            {
              new Set([
                ...Object.keys(project?.roomOverrides ?? {}),
                ...Object.keys(
                  project?.version === 2 ? project.authoredRooms : {},
                ),
              ]).size
            }{" "}
            rooms.
          </Text>
          <Column gap="12">
            {(["patch", "nrm"] as const).map((kind) => (
              <Button
                variant="tertiary"
                size="s"
                horizontal="start"
                key={kind}
                className={`export-option ${exportKind === kind ? "active" : ""}`}
                onClick={() => setExportKind(kind)}
                aria-pressed={exportKind === kind}
              >
                <span className="export-icon">
                  {kind === "patch" ? <FiLayers /> : <FiBox />}
                </span>
                <span>
                  <strong>
                    {kind === "patch"
                      ? "C / H patch files"
                      : "Prebuilt Recomp mod"}
                  </strong>
                  <small>
                    {kind === "patch"
                      ? "Add generated sources to your own mod project."
                      : "Build a .nrm file with the bundled offline tools."}
                  </small>
                </span>
                {exportKind === kind && <FiCheck />}
              </Button>
            ))}
          </Column>
          {exportKind === "nrm" && (
            <Column gap="12">
              <div className="inline-notice">
                {status?.toolchain.ready
                  ? `Bundled offline tools ready${status.toolchain.label ? ` · ${status.toolchain.label}` : ""}`
                  : "The bundled tools are unavailable for this platform. Recheck them to see the missing components."}
                {status?.toolchain.missing.length ? (
                  <p>Missing: {status.toolchain.missing.join(", ")}</p>
                ) : null}
              </div>
              <Button
                variant="secondary"
                size="s"
                onClick={() =>
                  void run("Checking bundled tools", async () => {
                    const toolchain = await api().configureToolchain();
                    if (toolchain)
                      setStatus((value) =>
                        value ? { ...value, toolchain } : value,
                      );
                  })
                }
              >
                <FiSettings />
                Recheck bundled tools
              </Button>
            </Column>
          )}
          <Button
            disabled={
              Boolean(busy) ||
              (exportKind === "nrm" && !status?.toolchain.ready)
            }
            onClick={() =>
              void run("Exporting changes", async () => {
                if (!project) return;
                const result = await (exportKind === "patch"
                  ? api().exportPatch(project)
                  : api().exportNrm(project));
                if (result) {
                  const buildEntries: Array<{
                    level: WorkspaceLog["level"];
                    message: string;
                  }> = [
                    ...result.warnings.map((message) => ({
                      level: "warning" as const,
                      message,
                    })),
                    ...(result.outputPaths ?? result.fileNames).map(
                      (message) => ({
                        level: "info" as const,
                        message: `Output: ${message}`,
                      }),
                    ),
                    ...(result.buildLog
                      ? [
                          {
                            level: "info" as const,
                            message:
                              result.buildLog.length > 32768
                                ? `[Earlier build output omitted]\n${result.buildLog.slice(-32768)}`
                                : result.buildLog,
                          },
                        ]
                      : []),
                  ];
                  setConsoleLogs((logs) =>
                    buildEntries.reduce(
                      (current, entry) =>
                        appendWorkspaceLog(current, {
                          ...entry,
                          source: "Build",
                          time: Date.now(),
                        }),
                      logs,
                    ),
                  );
                  setModal(null);
                  setNotice(
                    `Exported ${result.fileNames.join(", ")}${result.warnings.length ? ` · ${result.warnings.join("; ")}` : ""}`,
                  );
                }
              })
            }
          >
            <FiDownload />
            Export {exportKind === "patch" ? "patch files" : ".nrm mod"}
          </Button>
        </ModalShell>
      )}
    </Column>
  );
}
