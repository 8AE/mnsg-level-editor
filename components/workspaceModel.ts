/** Workspace preferences are view state; they never enter an EditorProject. */
export const PANEL_IDS = [
  "rooms",
  "scene",
  "hierarchy",
  "inspector",
  "assets",
  "console",
] as const;
export type PanelId = (typeof PANEL_IDS)[number];
export type WorkspacePreset = "Default" | "Wide" | "Focus";
export const PANEL_LABELS: Record<PanelId, string> = {
  rooms: "Rooms",
  scene: "Scene",
  hierarchy: "Hierarchy",
  inspector: "Inspector",
  assets: "Assets",
  console: "Console",
};
export const WORKSPACE_STORAGE_KEY = "mnsg.workspace.layout.v1";
export interface WorkspaceLayout {
  version: 1;
  leftWidth: number;
  rightWidth: number;
  rightRatio: number;
  bottomHeight: number;
  visible: Record<PanelId, boolean>;
  activeBottom: "assets" | "console";
  compactPanel: PanelId;
  maximized: PanelId | null;
}
export interface WorkspacePreferences {
  current: WorkspaceLayout;
  saved: Record<string, WorkspaceLayout>;
}
const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));
export function workspacePreset(name: WorkspacePreset): WorkspaceLayout {
  return {
    version: 1,
    leftWidth: name === "Wide" ? 170 : 200,
    rightWidth: name === "Wide" ? 260 : 300,
    rightRatio: 0.42,
    bottomHeight: name === "Wide" ? 170 : 220,
    visible: {
      rooms: true,
      scene: true,
      hierarchy: true,
      inspector: true,
      assets: true,
      console: true,
    },
    activeBottom: "assets",
    compactPanel: "scene",
    maximized: name === "Focus" ? "scene" : null,
  };
}
export function validateWorkspaceLayout(
  value: unknown,
): WorkspaceLayout | null {
  if (!value || typeof value !== "object") return null;
  const input = value as WorkspaceLayout;
  if (
    input.version !== 1 ||
    ![
      input.leftWidth,
      input.rightWidth,
      input.rightRatio,
      input.bottomHeight,
    ].every(Number.isFinite) ||
    !input.visible ||
    PANEL_IDS.some((id) => typeof input.visible[id] !== "boolean") ||
    !["assets", "console"].includes(input.activeBottom) ||
    !PANEL_IDS.includes(input.compactPanel) ||
    (input.maximized !== null && !PANEL_IDS.includes(input.maximized))
  )
    return null;
  return {
    version: 1,
    leftWidth: clamp(input.leftWidth, 140, 520),
    rightWidth: clamp(input.rightWidth, 200, 640),
    rightRatio: clamp(input.rightRatio, 0.15, 0.85),
    bottomHeight: clamp(input.bottomHeight, 100, 640),
    visible: Object.fromEntries(
      PANEL_IDS.map((id) => [id, input.visible[id]]),
    ) as Record<PanelId, boolean>,
    activeBottom: input.activeBottom,
    compactPanel: input.compactPanel,
    maximized: input.maximized,
  };
}
export function readWorkspacePreferences(
  serialized: string | null,
): WorkspacePreferences {
  const fallback = { current: workspacePreset("Default"), saved: {} };
  if (!serialized || serialized.length > 65536) return fallback;
  try {
    const input = JSON.parse(serialized),
      current = validateWorkspaceLayout(input.current);
    if (!current) return fallback;
    const saved: Record<string, WorkspaceLayout> = Object.create(null);
    if (input.saved && typeof input.saved === "object")
      for (const [name, value] of Object.entries(input.saved).slice(0, 16)) {
        const layout = validateWorkspaceLayout(value);
        if (
          layout &&
          name.length > 0 &&
          name.length <= 48 &&
          !["__proto__", "constructor", "prototype"].includes(name)
        )
          saved[name] = layout;
      }
    return { current, saved };
  } catch {
    return fallback;
  }
}
export function fitWorkspace(
  layout: WorkspaceLayout,
  width: number,
  height: number,
  visible: Record<PanelId, boolean>,
) {
  const safeWidth = Math.max(0, Number.isFinite(width) ? width : 0),
    safeHeight = Math.max(0, Number.isFinite(height) ? height : 0);
  const compact = safeWidth < 760;
  const available = Math.max(0, safeWidth - 240 - 12);
  let left = visible.rooms
    ? clamp(layout.leftWidth, 140, Math.max(140, available * 0.44))
    : 0;
  let right =
    visible.hierarchy || visible.inspector
      ? clamp(layout.rightWidth, 200, Math.max(200, available - left))
      : 0;
  if (left + right > available) {
    const scale = available / Math.max(1, left + right);
    left *= scale;
    right *= scale;
  }
  const bottom =
    visible.assets || visible.console
      ? clamp(layout.bottomHeight, 100, Math.max(100, safeHeight - 180))
      : 0;
  return {
    compact,
    left: Math.round(left),
    right: Math.round(right),
    bottom: visible.scene
      ? Math.min(safeHeight, Math.round(bottom))
      : bottom
        ? safeHeight
        : 0,
  };
}
export interface CameraSnapshot {
  roomId: number;
  position: [number, number, number];
  target: [number, number, number];
}
export function validCameraSnapshot(
  value: CameraSnapshot | undefined,
  roomId: number,
): value is CameraSnapshot {
  return Boolean(
    value &&
      value.roomId === roomId &&
      [value.position, value.target].every(
        (vector) =>
          Array.isArray(vector) &&
          vector.length === 3 &&
          Array.from(vector).every(Number.isFinite),
      ),
  );
}
export interface WorkspaceLog {
  id: number;
  level: "error" | "warning" | "info";
  source: string;
  message: string;
  time: number;
}
export const WORKSPACE_LOG_MESSAGE_LIMIT = 32768;
export function appendWorkspaceLog(
  logs: WorkspaceLog[],
  entry: Omit<WorkspaceLog, "id">,
): WorkspaceLog[] {
  const marker = "[Earlier message omitted]\n";
  const message =
    entry.message.length > WORKSPACE_LOG_MESSAGE_LIMIT
      ? marker +
        entry.message.slice(-(WORKSPACE_LOG_MESSAGE_LIMIT - marker.length))
      : entry.message;
  if (!message.trim()) return logs;
  const normalized = { ...entry, message };
  const previous = logs.at(-1);
  if (
    previous?.message === normalized.message &&
    previous.source === entry.source &&
    previous.level === entry.level
  )
    return logs;
  return [...logs.slice(-199), { ...normalized, id: (previous?.id ?? 0) + 1 }];
}
