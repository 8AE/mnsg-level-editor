import { randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink, readFile, stat, lstat } from "node:fs/promises";
import { basename, dirname, extname, resolve, join } from "node:path";

/** A sibling temporary file makes replacement atomic on both supported OSes. */
export async function atomicWrite(path: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(() => {}); }
}

export async function readJson(path: string, maxBytes = 16 * 1024 * 1024): Promise<unknown> {
  if ((await stat(path)).size > maxBytes) throw new Error("Project file is too large.");
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

export const PANEL_NAMES = ["scene", "rooms", "hierarchy", "inspector", "assets", "console"] as const;
export type PanelName = typeof PANEL_NAMES[number];
export interface WindowBounds { x: number; y: number; width: number; height: number }
export function panelName(frameName: string): PanelName | undefined {
  const name = frameName.replace(/^mnsg-panel-/, "");
  return frameName === `mnsg-panel-${name}` && PANEL_NAMES.includes(name as PanelName) ? name as PanelName : undefined;
}
/** Saved geometry is data only; keep every restored window within a current display. */
export function clampWindowBounds(value: unknown, areas: WindowBounds[], fallback: WindowBounds): WindowBounds {
  const input = value && typeof value === "object" ? value as Partial<WindowBounds> : {};
  const valid = [input.x, input.y, input.width, input.height].every(number => typeof number === "number" && Number.isFinite(number));
  const source = valid ? input as WindowBounds : fallback;
  const displays = areas.filter(area => [area.x, area.y, area.width, area.height].every(Number.isFinite) && area.width > 0 && area.height > 0);
  const area = displays.find(area => source.x >= area.x && source.x < area.x + area.width && source.y >= area.y && source.y < area.y + area.height) ?? displays[0] ?? fallback;
  const width = Math.min(area.width, Math.max(Math.min(360, area.width), Math.round(source.width)));
  const height = Math.min(area.height, Math.max(Math.min(260, area.height), Math.round(source.height)));
  return { width, height, x: Math.round(Math.max(area.x, Math.min(source.x, area.x + area.width - width))), y: Math.round(Math.max(area.y, Math.min(source.y, area.y + area.height - height))) };
}

export function bundleRelativePath(value: string): string {
  if (!value || value.length > 240 || !/^[A-Za-z0-9_. /-]+$/.test(value) || value.split("/").some(part => !part || part === "." || part === ".." || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw Error("Unsafe bundle file path.");
  return value;
}
export function nrmOutputName(outputPath: string): string {
  if (extname(outputPath).toLowerCase() !== ".nrm") throw Error("Choose an output filename ending in .nrm.");
  return bundleRelativePath(basename(outputPath));
}
export function nrmOutputFiles(outputPath: string, bytes: Uint8Array, sidecars: Record<string, Uint8Array>): Record<string, Uint8Array> {
  const name = nrmOutputName(outputPath), used = new Set([name.toLowerCase()]);
  const files: Record<string, Uint8Array> = { [name]: bytes };
  for (const [sidecar, contents] of Object.entries(sidecars)) {
    if (bundleRelativePath(sidecar) !== basename(sidecar)) throw Error("Native sidecar must have a portable basename.");
    if (used.has(sidecar.toLowerCase())) throw Error("The NRM output filename or native library sidecar names collide. Choose a different .nrm filename or library name.");
    used.add(sidecar.toLowerCase()); files[sidecar] = contents;
  }
  return files;
}
async function directoryWithoutSymlink(path: string): Promise<void> {
  try { const info = await lstat(path); if (!info.isDirectory() || info.isSymbolicLink()) throw Error("Bundle directory is not a regular directory."); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; await mkdir(path); }
}
/** Preflight every destination before writing: project attachment paths cannot follow symlinks. */
export async function writeConfinedBundle(destination: string, files: Record<string, string | Uint8Array>): Promise<void> {
  const names = Object.keys(files).map(bundleRelativePath);
  const lower = names.map(name => name.toLowerCase());
  if (new Set(lower).size !== lower.length || lower.some(name => lower.some(other => other.startsWith(`${name}/`)))) throw Error("Bundle file paths collide.");
  const root = resolve(destination);
  await directoryWithoutSymlink(root);
  for (const name of names) {
    const parts = name.split("/"); let parent = root;
    for (const part of parts.slice(0, -1)) { parent = join(parent, part); await directoryWithoutSymlink(parent); }
    try { const info = await lstat(join(root, name)); if (!info.isFile() || info.isSymbolicLink()) throw Error("Bundle target is not a regular file."); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  for (const name of names) await atomicWrite(join(root, name), files[name]);
}
