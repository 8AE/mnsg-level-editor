"use client";

import {
  forwardRef,
  createContext,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { Button, Column, Row, Text } from "@once-ui-system/core";
import {
  FiArrowUpRight,
  FiMaximize,
  FiMinimize,
  FiX,
  FiSidebar,
  FiLayout,
  FiColumns,
} from "react-icons/fi";
import { openPanelHost, type PopupHost } from "./popupHost";
import {
  fitWorkspace,
  PANEL_IDS,
  PANEL_LABELS,
  readWorkspacePreferences,
  workspacePreset,
  WORKSPACE_STORAGE_KEY,
  type PanelId,
  type WorkspaceLayout,
  type WorkspacePreferences,
  type WorkspacePreset,
} from "./workspaceModel";

/** Resolved after DOM adoption; consumers bind observers to this panel realm. */
export const WorkspacePanelWindowContext = createContext<Window | null>(null);

export interface DockWorkspaceHandle {
  showPanel(id: PanelId): void;
  closePanel(id: PanelId): void;
  toggleRegion(region: "left" | "right" | "bottom"): void;
}
interface Props {
  panels: Record<PanelId, ReactNode>;
  blocked?: boolean;
  onWindowsChange?(windows: Window[]): void;
  onSceneHostChange?(host: { window: Window; visible: boolean }): void;
  onInteraction?(active: boolean): void;
}
interface SeparatorProps {
  label: string;
  vertical: boolean;
  value: number;
  min: number;
  max: number;
  onChange(value: number): void;
  onInteraction(active: boolean): void;
  container: () => HTMLElement | null;
  kind: "left" | "right" | "bottom" | "ratio";
}
function Separator({
  label,
  vertical,
  value,
  min,
  max,
  onChange,
  onInteraction,
  container,
  kind,
}: SeparatorProps) {
  const stop = useRef<(() => void) | null>(null);
  useEffect(() => () => stop.current?.(), []);
  const bounded = (next: number) =>
    onChange(Math.max(min, Math.min(max, next)));
  return (
    <div
      className={`dock-separator ${vertical ? "vertical" : "horizontal"}`}
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation={vertical ? "vertical" : "horizontal"}
      aria-valuemin={Math.round(kind === "ratio" ? min * 100 : min)}
      aria-valuemax={Math.round(kind === "ratio" ? max * 100 : max)}
      aria-valuenow={Math.round(kind === "ratio" ? value * 100 : value)}
      aria-valuetext={
        kind === "ratio"
          ? `${Math.round(value * 100)} percent hierarchy`
          : undefined
      }
      data-testid={`resize-${kind}`}
      onKeyDown={(event) => {
        if (
          ![
            "ArrowLeft",
            "ArrowRight",
            "ArrowUp",
            "ArrowDown",
            "Home",
            "End",
          ].includes(event.key)
        )
          return;
        event.preventDefault();
        onInteraction(true);
        bounded(
          event.key === "Home"
            ? min
            : event.key === "End"
              ? max
              : value +
                (["ArrowLeft", "ArrowUp"].includes(event.key) ? -1 : 1) *
                  (kind === "ratio" ? 0.05 : 16),
        );
        onInteraction(false);
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        stop.current?.();
        const handle = event.currentTarget,
          document = handle.ownerDocument,
          window = document.defaultView;
        const box = container()?.getBoundingClientRect();
        if (!box || !window) return;
        onInteraction(true);
        handle.setPointerCapture(event.pointerId);
        const previous = document.body.style.userSelect;
        document.body.style.userSelect = "none";
        const move = (input: PointerEvent) =>
          bounded(
            kind === "left"
              ? input.clientX - box.left
              : kind === "right"
                ? box.right - input.clientX
                : kind === "bottom"
                  ? box.bottom - input.clientY
                  : (input.clientY - box.top) / Math.max(1, box.height),
          );
        const end = () => {
          document.removeEventListener("pointermove", move);
          document.removeEventListener("pointerup", end);
          document.removeEventListener("pointercancel", end);
          handle.removeEventListener("lostpointercapture", end);
          window.removeEventListener("blur", end);
          document.body.style.userSelect = previous;
          onInteraction(false);
          stop.current = null;
        };
        stop.current = end;
        document.addEventListener("pointermove", move);
        document.addEventListener("pointerup", end);
        document.addEventListener("pointercancel", end);
        handle.addEventListener("lostpointercapture", end);
        window.addEventListener("blur", end);
      }}
    >
      <Button
        size="s"
        variant="tertiary"
        type="button"
        tabIndex={-1}
        aria-label={`Decrease ${label}`}
        onPointerDown={(event: ReactPointerEvent<HTMLButtonElement>) =>
          event.stopPropagation()
        }
        onClick={() => bounded(value - (kind === "ratio" ? 0.05 : 16))}
      >
        −
      </Button>
      <Button
        size="s"
        variant="tertiary"
        type="button"
        tabIndex={-1}
        aria-label={`Increase ${label}`}
        onPointerDown={(event: ReactPointerEvent<HTMLButtonElement>) =>
          event.stopPropagation()
        }
        onClick={() => bounded(value + (kind === "ratio" ? 0.05 : 16))}
      >
        +
      </Button>
    </div>
  );
}

export default forwardRef<DockWorkspaceHandle, Props>(function DockWorkspace(
  {
    panels,
    blocked = false,
    onWindowsChange,
    onSceneHostChange,
    onInteraction,
  },
  ref,
) {
  const [preferences, setPreferences] = useState<WorkspacePreferences>(() => ({
    current: workspacePreset("Default"),
    saved: {},
  }));
  const [ready, setReady] = useState(false),
    [size, setSize] = useState({ width: 1200, height: 700 }),
    [hosts, setHosts] = useState<Partial<Record<PanelId, PopupHost>>>({}),
    [message, setMessage] = useState("");
  const workspace = useRef<HTMLDivElement>(null),
    right = useRef<HTMLDivElement>(null),
    center = useRef<HTMLDivElement>(null),
    hostRefs = useRef<Partial<Record<PanelId, PopupHost>>>({});
  const [containers, setContainers] = useState<
    Partial<Record<PanelId, HTMLElement>>
  >({});
  const [panelWindows, setPanelWindows] = useState<
    Partial<Record<PanelId, Window>>
  >({});
  const mounts = useRef<Partial<Record<PanelId, HTMLDivElement>>>({});
  useEffect(() => {
    setContainers(
      Object.fromEntries(
        PANEL_IDS.map((id) => [id, document.createElement("div")]),
      ),
    );
  }, []);
  // Adopt stable portal targets, retaining field drafts and library filters. Scene
  // explicitly remounts on host changes so its listeners use the correct window.
  useLayoutEffect(() => {
    for (const id of PANEL_IDS) {
      const node = containers[id],
        target = hosts[id]?.container ?? mounts.current[id];
      if (node && target && node.parentElement !== target) {
        node.className = "dock-portal-root";
        target.appendChild(node);
      }
    }
    const resolved = Object.fromEntries(
      PANEL_IDS.flatMap((id) => {
        const window = containers[id]?.ownerDocument.defaultView;
        return window ? [[id, window]] : [];
      }),
    ) as Partial<Record<PanelId, Window>>;
    setPanelWindows((previous) =>
      PANEL_IDS.every((id) => previous[id] === resolved[id])
        ? previous
        : resolved,
    );
  }, [containers, hosts]);
  const current = preferences.current;
  const update = (change: Partial<WorkspaceLayout>) =>
    setPreferences((previous) => ({
      ...previous,
      current: { ...previous.current, ...change },
    }));
  const interact = (value: boolean) => onInteraction?.(value);
  useEffect(() => {
    try {
      setPreferences(
        readWorkspacePreferences(localStorage.getItem(WORKSPACE_STORAGE_KEY)),
      );
    } catch {}
    setReady(true);
  }, []);
  useEffect(() => {
    if (ready)
      try {
        localStorage.setItem(
          WORKSPACE_STORAGE_KEY,
          JSON.stringify(preferences),
        );
      } catch {
        setMessage("Layout preferences could not be saved on this computer.");
      }
  }, [preferences, ready]);
  useEffect(() => {
    const element = workspace.current;
    if (!element) return;
    const observer = new ResizeObserver(() =>
      setSize({ width: element.clientWidth, height: element.clientHeight }),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    hostRefs.current = hosts;
    onWindowsChange?.(Object.values(hosts).map((host) => host!.window));
  }, [hosts, onWindowsChange]);
  useEffect(
    () => () => {
      Object.values(hostRefs.current).forEach((host) => host?.dispose());
    },
    [],
  );
  const show = (id: PanelId) =>
    setPreferences((previous) => ({
      ...previous,
      current: {
        ...previous.current,
        visible: { ...previous.current.visible, [id]: true },
        maximized: null,
        compactPanel: id,
        ...(id === "assets" || id === "console" ? { activeBottom: id } : {}),
      },
    }));
  const reclaim = (id: PanelId) => {
    const node = containers[id],
      target = mounts.current[id];
    if (node && target && node.parentElement !== target) {
      // Moving a focused field blurs it. Window movement preserves its draft;
      // it must not become a project edit through React's focusout handler.
      const suppressBlur = (event: Event) => event.stopImmediatePropagation();
      node.addEventListener("focusout", suppressBlur, true);
      try {
        target.appendChild(node);
      } finally {
        node.removeEventListener("focusout", suppressBlur, true);
      }
    }
  };
  const redock = (id: PanelId) => {
    interact(true);
    reclaim(id);
    hostRefs.current[id]?.dispose();
    setHosts((previous) => {
      const next = { ...previous };
      delete next[id];
      return next;
    });
    show(id);
    interact(false);
  };
  const close = (id: PanelId) => {
    reclaim(id);
    hostRefs.current[id]?.dispose();
    setHosts((previous) => {
      const next = { ...previous };
      delete next[id];
      return next;
    });
    setPreferences((previous) => ({
      ...previous,
      current: {
        ...previous.current,
        visible: { ...previous.current.visible, [id]: false },
        maximized:
          previous.current.maximized === id ? null : previous.current.maximized,
      },
    }));
  };
  const toggleRegion = (region: "left" | "right" | "bottom") => {
    const ids: PanelId[] =
      region === "left"
        ? ["rooms"]
        : region === "right"
          ? ["hierarchy", "inspector"]
          : ["assets", "console"];
    setPreferences((previous) => {
      const visible = { ...previous.current.visible };
      const next = !ids.some((id) => visible[id] && !hostRefs.current[id]);
      ids.forEach((id) => {
        if (!hostRefs.current[id]) visible[id] = next;
      });
      return {
        ...previous,
        current: { ...previous.current, visible, maximized: null },
      };
    });
  };
  useImperativeHandle(ref, () => ({
    showPanel: show,
    closePanel: close,
    toggleRegion,
  }));
  const popup = (id: PanelId) => {
    if (hosts[id]) {
      hosts[id]!.window.focus();
      return;
    }
    interact(true);
    try {
      const host = openPanelHost(
        window,
        id,
        () => {
          setHosts((previous) => {
            const next = { ...previous };
            delete next[id];
            return next;
          });
          show(id);
        },
        () => reclaim(id),
      );
      if (!host) {
        setMessage(
          "The panel window could not open. The docked panel is still available.",
        );
        return;
      }
      show(id);
      setHosts((previous) => ({ ...previous, [id]: host }));
    } catch {
      setMessage(
        "The panel window could not open. The docked panel is still available.",
      );
    } finally {
      interact(false);
    }
  };
  const dockVisible = Object.fromEntries(
    PANEL_IDS.map((id) => [
      id,
      current.visible[id] &&
        !hosts[id] &&
        (size.width < 760 || !current.maximized || current.maximized === id),
    ]),
  ) as Record<PanelId, boolean>;
  const fit = fitWorkspace(current, size.width, size.height, dockVisible);
  const activeBottom = dockVisible[current.activeBottom]
    ? current.activeBottom
    : dockVisible.assets
      ? "assets"
      : "console";
  const compactActive =
    current.visible[current.compactPanel] && !hosts[current.compactPanel]
      ? current.compactPanel
      : PANEL_IDS.find((id) => current.visible[id] && !hosts[id]);
  const sceneVisible = Boolean(
    hosts.scene ||
      (dockVisible.scene && (!fit.compact || compactActive === "scene")),
  );
  useLayoutEffect(() => {
    const window = containers.scene?.ownerDocument.defaultView;
    if (window) onSceneHostChange?.({ window, visible: sceneVisible });
  }, [containers, hosts, sceneVisible, onSceneHostChange]);
  const panel = (id: PanelId, extraHidden = false) => {
    const content = (
      <Column
        className={`dock-panel dock-${id}`}
        data-testid={`workspace-panel-${id}`}
        data-panel-id={id}
        style={{ display: extraHidden && !hosts[id] ? "none" : undefined }}
      >
        <Row
          className="dock-panel-title"
          horizontal="between"
          vertical="center"
          paddingX="8"
        >
          <Text variant="label-strong-xs">{PANEL_LABELS[id]}</Text>
          <Row gap="2">
            <Button
              size="s"
              variant="tertiary"
              aria-label={
                hosts[id]
                  ? `Redock ${PANEL_LABELS[id]}`
                  : `Pop out ${PANEL_LABELS[id]}`
              }
              title={
                hosts[id] ? "Return to workspace" : "Open in a native window"
              }
              onClick={() => (hosts[id] ? redock(id) : popup(id))}
            >
              <FiArrowUpRight />
            </Button>
            {!hosts[id] && (
              <Button
                size="s"
                variant="tertiary"
                aria-label={
                  current.maximized === id
                    ? `Restore ${PANEL_LABELS[id]}`
                    : `Maximize ${PANEL_LABELS[id]}`
                }
                onClick={() =>
                  update({ maximized: current.maximized === id ? null : id })
                }
              >
                {current.maximized === id ? <FiMinimize /> : <FiMaximize />}
              </Button>
            )}
            {id !== "assets" && id !== "console" && (
              <Button
                size="s"
                variant="tertiary"
                aria-label={`Close ${PANEL_LABELS[id]}`}
                onClick={() => close(id)}
              >
                <FiX />
              </Button>
            )}
          </Row>
        </Row>
        <div className="dock-panel-content" inert={blocked}>
          <WorkspacePanelWindowContext.Provider
            value={panelWindows[id] ?? null}
          >
            {panels[id]}
          </WorkspacePanelWindowContext.Provider>
        </div>
      </Column>
    );
    return (
      <div
        className="dock-panel-mount"
        ref={(node) => {
          if (node) mounts.current[id] = node;
        }}
      >
        {containers[id] ? createPortal(content, containers[id]!, id) : content}
      </div>
    );
  };
  const isHidden = (id: PanelId) =>
    fit.compact ? compactActive !== id : !dockVisible[id];
  const saveNamed = (form: HTMLFormElement) => {
    const field = form.elements.namedItem("layoutName") as HTMLInputElement;
    const name = field.value.trim().slice(0, 48);
    if (!name || ["__proto__", "constructor", "prototype"].includes(name))
      return;
    if (
      !preferences.saved[name] &&
      Object.keys(preferences.saved).length >= 16
    ) {
      setMessage("Up to 16 named layouts can be saved.");
      return;
    }
    setPreferences((previous) => ({
      ...previous,
      saved: { ...previous.saved, [name]: structuredClone(previous.current) },
    }));
    field.value = "";
    setMessage(`Saved layout “${name}”.`);
  };
  return (
    <Column className="dock-workspace" fill>
      <Row className="workspace-menu" gap="8" vertical="center" paddingX="8">
        <Row gap="2" className="panel-region-controls">
          {(["left", "right", "bottom"] as const).map((region, index) => (
            <Button
              key={region}
              size="s"
              variant="tertiary"
              aria-label={`Toggle ${region} panel`}
              title={`Toggle ${region} panel · ${index === 0 ? "⌘/Ctrl+B" : index === 1 ? "⌘/Ctrl+Shift+B" : "⌘/Ctrl+J"}`}
              onClick={() => toggleRegion(region)}
            >
              {region === "left" ? (
                <FiSidebar />
              ) : region === "right" ? (
                <FiColumns />
              ) : (
                <FiLayout />
              )}
            </Button>
          ))}
        </Row>
        <details className="workspace-menu-popup">
          <summary>Layout</summary>
          <Column className="workspace-menu-list" gap="4" padding="8">
            {PANEL_IDS.filter((id) => !current.visible[id]).map((id) => (
              <Button
                key={id}
                variant="tertiary"
                size="s"
                onClick={() => show(id)}
              >
                Show {PANEL_LABELS[id]}
              </Button>
            ))}
            {(["Default", "Wide", "Focus"] as WorkspacePreset[]).map((name) => (
              <Button
                key={name}
                variant="tertiary"
                size="s"
                onClick={() =>
                  setPreferences((previous) => ({
                    ...previous,
                    current: workspacePreset(name),
                  }))
                }
              >
                {name} layout
              </Button>
            ))}
            <form
              onSubmit={(event) => {
                event.preventDefault();
                saveNamed(event.currentTarget);
              }}
            >
              <label>
                Name
                <input
                  name="layoutName"
                  aria-label="Layout name"
                  maxLength={48}
                />
              </label>
              <Button size="s" variant="secondary" type="submit">
                Save layout
              </Button>
            </form>
            {Object.keys(preferences.saved).map((name) => (
              <Button
                key={name}
                size="s"
                variant="tertiary"
                onClick={() => update(structuredClone(preferences.saved[name]))}
              >
                Load {name}
              </Button>
            ))}
            <Button
              size="s"
              variant="tertiary"
              onClick={() =>
                setPreferences({
                  current: workspacePreset("Default"),
                  saved: {},
                })
              }
            >
              Reset workspace layout
            </Button>
          </Column>
        </details>
        {current.maximized && (
          <Button
            variant="tertiary"
            size="s"
            onClick={() => update({ maximized: null })}
          >
            Restore workspace
          </Button>
        )}
        <Text variant="label-default-xs" onBackground="neutral-weak">
          {message || "Resize with the dividers, arrow keys or − / +"}
        </Text>
      </Row>
      {fit.compact && (
        <Row
          className="compact-panel-tabs"
          gap="2"
          role="tablist"
          aria-label="Workspace panels"
        >
          {PANEL_IDS.filter((id) => current.visible[id] && !hosts[id]).map(
            (id) => (
              <Button
                key={id}
                size="s"
                variant="tertiary"
                role="tab"
                aria-selected={compactActive === id}
                onClick={() => update({ compactPanel: id })}
              >
                {PANEL_LABELS[id]}
              </Button>
            ),
          )}
        </Row>
      )}
      <div
        ref={workspace}
        className={`dock-grid ${fit.compact ? "is-compact" : current.maximized ? "is-single" : ""}`}
        data-testid="dock-workspace"
        style={{
          gridTemplateColumns:
            fit.compact || current.maximized
              ? "minmax(0,1fr)"
              : `${dockVisible.rooms ? fit.left : 0}px ${dockVisible.rooms ? 6 : 0}px minmax(0,1fr) ${dockVisible.hierarchy || dockVisible.inspector ? 6 : 0}px ${fit.right}px`,
        }}
      >
        <div
          className="dock-room-slot"
          style={{
            display: isHidden("rooms") ? "none" : undefined,
          }}
        >
          {panel("rooms", isHidden("rooms"))}
        </div>
        {!fit.compact && !current.maximized && dockVisible.rooms && (
          <Separator
            label="Rooms width"
            vertical
            value={fit.left}
            min={140}
            max={Math.max(140, size.width * 0.4)}
            kind="left"
            container={() => workspace.current}
            onChange={(leftWidth) => update({ leftWidth })}
            onInteraction={interact}
          />
        )}
        <div
          className="dock-center"
          ref={center}
          style={{
            gridTemplateRows: fit.compact
              ? "minmax(0,1fr)"
              : `${dockVisible.scene ? "minmax(0,1fr)" : "0px"} ${fit.bottom && dockVisible.scene ? 6 : 0}px ${fit.bottom}px`,
          }}
        >
          <div
            className="dock-scene-slot"
            style={{
              display: isHidden("scene") ? "none" : undefined,
            }}
          >
            {panel("scene", isHidden("scene"))}
          </div>
          {!fit.compact &&
            !current.maximized &&
            dockVisible.scene &&
            fit.bottom > 0 && (
              <Separator
                label="Assets and Console height"
                vertical={false}
                value={fit.bottom}
                min={100}
                max={Math.max(100, size.height - 180)}
                kind="bottom"
                container={() => center.current}
                onChange={(bottomHeight) => update({ bottomHeight })}
                onInteraction={interact}
              />
            )}
          <div
            className={`dock-bottom ${!fit.compact && !current.maximized ? "is-tabbed" : ""}`}
            style={{
              display: fit.compact
                ? undefined
                : fit.bottom
                  ? undefined
                  : "none",
            }}
          >
            {!fit.compact && !current.maximized && (
              <Row
                className="bottom-dock-tabs"
                role="tablist"
                aria-label="Assets and Console"
                gap="4"
              >
                <Row gap="4">
                  {(["assets", "console"] as const)
                    .filter((id) => dockVisible[id])
                    .map((id) => (
                      <Button
                        key={id}
                        size="s"
                        variant="tertiary"
                        role="tab"
                        aria-selected={activeBottom === id}
                        onClick={() => update({ activeBottom: id })}
                        onDoubleClick={() => popup(id)}
                      >
                        {PANEL_LABELS[id]}
                      </Button>
                    ))}
                </Row>
                <Row gap="2" className="bottom-panel-actions">
                  <Button
                    size="s"
                    variant="tertiary"
                    aria-label={`Pop out ${PANEL_LABELS[activeBottom]}`}
                    onClick={() => popup(activeBottom)}
                  >
                    <FiArrowUpRight />
                  </Button>
                  <Button
                    size="s"
                    variant="tertiary"
                    aria-label={`Maximize ${PANEL_LABELS[activeBottom]}`}
                    onClick={() =>
                      update({
                        maximized: activeBottom,
                      })
                    }
                  >
                    <FiMaximize />
                  </Button>
                </Row>
              </Row>
            )}
            {(["assets", "console"] as const).map((id) => (
              <div
                key={id}
                className="dock-bottom-slot"
                style={{
                  display:
                    (fit.compact
                      ? isHidden(id)
                      : !dockVisible[id] || activeBottom !== id) && !hosts[id]
                      ? "none"
                      : undefined,
                }}
              >
                {panel(id, fit.compact ? isHidden(id) : !dockVisible[id])}
              </div>
            ))}
          </div>
        </div>
        {!fit.compact &&
          !current.maximized &&
          (dockVisible.hierarchy || dockVisible.inspector) && (
            <Separator
              label="Hierarchy and Inspector width"
              vertical
              value={fit.right}
              min={200}
              max={Math.max(200, size.width * 0.5)}
              kind="right"
              container={() => workspace.current}
              onChange={(rightWidth) => update({ rightWidth })}
              onInteraction={interact}
            />
          )}
        <div
          className="dock-right"
          ref={right}
          style={{
            display:
              !dockVisible.hierarchy &&
              !dockVisible.inspector &&
              !hosts.hierarchy &&
              !hosts.inspector
                ? "none"
                : undefined,
            gridTemplateRows: fit.compact
              ? "minmax(0,1fr)"
              : dockVisible.hierarchy && dockVisible.inspector
                ? `minmax(0,${current.rightRatio}fr) 6px minmax(0,${1 - current.rightRatio}fr)`
                : "minmax(0,1fr)",
          }}
        >
          <div
            className="dock-hierarchy-slot"
            style={{
              display: isHidden("hierarchy") ? "none" : undefined,
            }}
          >
            {panel("hierarchy", isHidden("hierarchy"))}
          </div>
          {!fit.compact &&
            !current.maximized &&
            dockVisible.hierarchy &&
            dockVisible.inspector && (
              <Separator
                label="Hierarchy and Inspector split"
                vertical={false}
                value={current.rightRatio}
                min={0.15}
                max={0.85}
                kind="ratio"
                container={() => right.current}
                onChange={(rightRatio) => update({ rightRatio })}
                onInteraction={interact}
              />
            )}
          <div
            className="dock-inspector-slot"
            style={{
              display: isHidden("inspector") ? "none" : undefined,
            }}
          >
            {panel("inspector", isHidden("inspector"))}
          </div>
        </div>
        {!compactActive && fit.compact && (
          <Column center padding="24">
            <Text>No docked panels. Use Window to reopen a panel.</Text>
          </Column>
        )}
      </div>
    </Column>
  );
});
