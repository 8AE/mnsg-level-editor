import { app, BrowserWindow, dialog, ipcMain, nativeImage, protocol, screen, session, type IpcMainInvokeEvent } from "electron";
import { createHash } from "node:crypto";
import { readFile, stat, mkdir } from "node:fs/promises";
import { basename, extname, join, resolve, sep } from "node:path";
import type { AppStatus, EditorProjectV2, RomIdentity } from "../shared/types";
import { importRomBytes, type ImportedRom } from "../core/rom";
import { createProject, validateProject } from "../core/project";
import { type AuthoringLookup, resourceId, validatePrototypeEdits } from "../core/authoring/project";
import { assertProjectBytes, MAX_PROJECT_BYTES } from "../core/authoring/limits";
import { assertDecodedBudget, composeProjectActorVisuals, composeProjectRoom, listProjectRooms } from "../core/authoring/scene";
import { generatePatch, exportNrm } from "../core/export";
import { atomicWrite, readJson, clampWindowBounds, panelName, writeConfinedBundle, nrmOutputName, nrmOutputFiles, type PanelName, type WindowBounds } from "./storage";
import { ManagedTools } from "./managed-tools";
import { iconDimensions, modAttachment, materializeProjectWorkspace, invalidateProjectWorkspace, projectTemplateFiles, projectWorkspaceKey } from "./project-workspaces";
import { MOD_LIMITS } from "../shared/mod-settings";

protocol.registerSchemesAsPrivileged([{ scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
app.enableSandbox();
const devUrl = !app.isPackaged && process.env.MNSG_DEV_URL === "http://127.0.0.1:3000" ? process.env.MNSG_DEV_URL : null;
let window: BrowserWindow | null = null;
let database: ImportedRom | null = null;
let romIdentity: RomIdentity | null = null;
let project: EditorProjectV2 | null = null;
let projectPath: string | null = null;
let managedTools: ManagedTools;
let busy = false;
const panelWindows = new Map<PanelName, BrowserWindow>();
const pendingPanels = new Set<PanelName>();
const savedBounds: Partial<Record<PanelName | "main", WindowBounds>> = {};
let boundsWrites = Promise.resolve();
const startupWarnings: string[] = [];
const dataPath = (...parts: string[]) => join(app.getPath("userData"), ...parts);
const requireDatabase = () => { if (!database || !romIdentity) throw new Error("Import your US MNSG ROM first."); return database; };
let authoringCache: { db: ImportedRom; lookup: AuthoringLookup } | undefined;
function authoringLookup(): AuthoringLookup {
  const db = requireDatabase();
  if (authoringCache?.db === db) return authoringCache.lookup;
  const lookup: AuthoringLookup = { catalog: db.getAuthoringCatalog(), nativeRooms: db.listRooms(), loadRoom: db.loadAuthoringRoom.bind(db), resolveMaterial: db.resolveAuthoringMaterial.bind(db), loadActorPrototype: db.loadActorPrototype.bind(db), loadActorPrototypeForRoom: db.loadActorPrototypeForRoom.bind(db), loadSkyboxAsset: db.loadSkyboxAsset.bind(db), nativeRoomSkyboxId: db.nativeRoomSkyboxId.bind(db) };
  authoringCache = { db, lookup }; return lookup;
}
const validate = (value: unknown) => {
  assertProjectBytes(value);
  const db = requireDatabase();
  const authored = value && typeof value === "object" && "authoredRooms" in value ? (value as Record<string, unknown>).authoredRooms : undefined;
  const lookup = authored && typeof authored === "object" && Object.keys(authored).length ? authoringLookup() : undefined;
  return validateProject(value, romIdentity!, db.loadRoom.bind(db), db.geometryTranslation.bind(db), lookup);
};
async function materialize(value: EditorProjectV2, generated?: Awaited<ReturnType<typeof generatePatch>>) {
  const tools = await managedTools.ensure();
  const manifest = await readJson(join(tools.templatePath, "manifest.json"), 512 * 1024) as { bundleId: string };
  return materializeProjectWorkspace(dataPath("project-workspaces"), value.id, manifest.bundleId, await projectTemplateFiles(value, tools, generated));
}
async function updateWorkspace(value: EditorProjectV2) {
  try { await invalidateProjectWorkspace(dataPath("project-workspaces"), value.id); await materialize(value); }
  catch (error) { const warning = `Project template could not be refreshed: ${error instanceof Error ? error.message : String(error)}`; if (!startupWarnings.includes(warning)) startupWarnings.push(warning); }
}
function roomId(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 799) throw new Error("Invalid room ID.");
  return value;
}
function exportDetails(value: EditorProjectV2) {
  const ids = new Set<number>(), changes: string[] = [];
  for (const [key, edits] of Object.entries(value.roomOverrides)) {
    ids.add(Number(key));
    if (edits.geometry) {
      for (const affected of requireDatabase().geometryTranslation(Number(key), edits.geometry.translation).affectedRoomIds) ids.add(affected);
      changes.push(`Room ${key} shared geometry translation ${JSON.stringify(edits.geometry.translation)}`);
    }
    for (const [actor, edit] of Object.entries(edits.actors)) if (Object.keys(edit).length) changes.push(`Room ${key} actor ${actor}: ${JSON.stringify(edit)}`);
  }
  for (const room of Object.values(value.authoredRooms)) {
    ids.add(room.id);
    changes.push(`Room ${room.id} ${room.kind}, template ${room.templateRoomId}: ${room.meshes.length} meshes/${room.meshes.reduce((count, mesh) => count + mesh.indices.length / 3, 0)} triangles, ${room.collisionMode} collision (${room.collision.length} authored triangles${room.collisionTranslation ? `, donor delta ${JSON.stringify(room.collisionTranslation)}` : ""}), ${room.actors.length} actors, ${room.doors.length} doors, ${room.entrances.length} entrances, skybox ${room.skyboxId === undefined ? "inherit-template" : room.skyboxId === null ? "none" : room.skyboxId}. Complete authored records are in the exported source/manifest.`);
    for (const door of room.doors) changes.push(`Room ${room.id} door ${door.id}: ${JSON.stringify(door)}`);
    for (const entrance of room.entrances) changes.push(`Room ${room.id} entrance ${entrance.id}: ${JSON.stringify(entrance)}`);
  }
  return { roomIds: [...ids].sort((a, b) => a - b), changes };
}

function assertSender(event: IpcMainInvokeEvent) {
  const url = event.senderFrame?.url ?? "";
  const trusted = devUrl ? new URL(url).origin === devUrl : url.startsWith("app://editor/");
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || !trusted) throw new Error("Untrusted editor request.");
}
function handle(name: string, operation: (...args: unknown[]) => unknown, mutation = false) {
  ipcMain.handle(`mnsg:${name}`, async (event, ...args: unknown[]) => {
    assertSender(event);
    if (busy) throw new Error("Another file operation is still running.");
    if (mutation) busy = true;
    try { return await operation(...args); } finally { if (mutation) busy = false; }
  });
}
async function status(): Promise<AppStatus> {
  return { desktop: true, appVersion: app.getVersion(), rom: romIdentity, roomCount: database ? (project ? listProjectRooms(project, authoringLookup()).length : database.listRooms().length) : 0, project, toolchain: await managedTools.status(), warnings: [...startupWarnings, ...(database?.warnings ?? [])] };
}
async function restore() {
  try {
    const bounds = await readJson(dataPath("window-bounds.json"), 16 * 1024);
    if (bounds && typeof bounds === "object" && !Array.isArray(bounds)) {
      for (const [key, value] of Object.entries(bounds)) if (key === "main" || panelName(`mnsg-panel-${key}`)) savedBounds[key as PanelName | "main"] = clampWindowBounds(value, screen.getAllDisplays().map(display => display.workArea), { x: 0, y: 0, width: 900, height: 700 });
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") startupWarnings.push("Saved window positions could not be read."); }
  try {
    const cached = await readJson(dataPath("rom.json"), 32 * 1024) as RomIdentity;
    if (!cached || !/^[a-f0-9]{64}$/.test(cached.normalizedSha256) || !/^[a-f0-9]{64}$/.test(cached.sha256) || typeof cached.decompressed !== "boolean") throw new Error("Invalid ROM cache identity.");
    const bytes = await readFile(dataPath("rom-cache", `${cached.normalizedSha256}.z64`));
    const parsed = importRomBytes(bytes);
    if (parsed.identity.normalizedSha256 !== cached.normalizedSha256) throw new Error("ROM cache checksum mismatch.");
    database = parsed; romIdentity = { ...parsed.identity, sha256: cached.sha256, decompressed: cached.decompressed };
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") startupWarnings.push("The ROM cache could not be restored. Please import your ROM again."); }
}
function registerOperations() {
  handle("get-status", status);
  handle("list-rooms", () => requireDatabase().listRooms());
  handle("load-room", (id) => requireDatabase().loadRoom(roomId(id)));
  handle("get-authoring-catalog", () => authoringLookup().catalog);
  handle("load-geometry-asset", id => {
    const asset = requireDatabase().loadGeometryAsset(resourceId(id, "Geometry asset ID"));
    assertDecodedBudget(asset.meshes, asset.textures); return asset;
  });
  handle("load-skybox-asset", id => {
    const asset = requireDatabase().loadSkyboxAsset(resourceId(id, "Skybox asset ID"));
    assertDecodedBudget([], [asset.texture]); return asset;
  });
  handle("load-actor-prototype", (id, edits) => {
    const payload = requireDatabase().loadActorPrototype(resourceId(id, "Actor prototype ID"), validatePrototypeEdits(edits));
    assertDecodedBudget([], [], payload.actorModels); return payload;
  });
  handle("list-project-rooms", value => listProjectRooms(validate(value), authoringLookup()));
  handle("load-project-room", (value, id) => composeProjectRoom(validate(value), roomId(id), authoringLookup(), requireDatabase().geometryTranslation.bind(requireDatabase())));
  handle("load-project-actor-visuals", (value, id) => composeProjectActorVisuals(validate(value), roomId(id), authoringLookup(), requireDatabase().loadActorVisuals.bind(requireDatabase())));
  handle("load-actor-visuals", (id, overrides) => {
    if (typeof id !== "number" || !Number.isInteger(id) || id < 0 || id > 799) throw new Error("Invalid room ID.");
    if (!overrides || typeof overrides !== "object" || Array.isArray(overrides) || ![Object.prototype, null].includes(Object.getPrototypeOf(overrides))) throw new Error("Actor visual overrides must be a plain object.");
    let serialized: string;
    try { serialized = JSON.stringify(overrides); } catch { throw new Error("Actor visual overrides must contain finite project data without cycles."); }
    if (Buffer.byteLength(serialized, "utf8") > 1024 * 1024) throw new Error("Actor visual overrides exceed the 1 MiB input limit.");
    const db = requireDatabase();
    const native = db.loadRoom(id);
    if (Object.keys(overrides).length > native.actors.length) throw new Error("Actor visual overrides exceed the room's native actor count.");
    // Run the same native record/type/parameter/transform checks as a saved
    // project. This temporary project never replaces the user's editor project.
    const preview = { ...createProject("Actor visual preview", romIdentity!), roomOverrides: { [String(id)]: { actors: overrides, events: {} } } };
    const normalized = validate(preview).roomOverrides[String(id)].actors;
    return db.loadActorVisuals(id, normalized);
  });
  handle("import-rom", async () => {
    const choice = await dialog.showOpenDialog(window!, { title: "Choose your US Mystical Ninja Starring Goemon ROM", properties: ["openFile"], filters: [{ name: "Nintendo 64 ROM", extensions: ["z64", "v64", "n64", "rom", "bin"] }] });
    if (choice.canceled) return null;
    const path = choice.filePaths[0];
    if ((await stat(path)).size > 128 * 1024 * 1024) throw new Error("ROM exceeds the supported size.");
    const imported = importRomBytes(await readFile(path));
    await atomicWrite(dataPath("rom-cache", `${imported.identity.normalizedSha256}.z64`), imported.bytes);
    await atomicWrite(dataPath("rom.json"), JSON.stringify(imported.identity, null, 2));
    database = imported; romIdentity = imported.identity; project = null; projectPath = null;
    return status();
  }, true);
  handle("new-project", async (name) => {
    requireDatabase();
    if (typeof name !== "string" || !name.trim() || name.trim().length > 120) throw new Error("Project name must be 1–120 characters.");
    const parsed = createProject(name.trim(), romIdentity!);
    await updateWorkspace(parsed);
    project = parsed; projectPath = null; return project;
  }, true);
  handle("open-project", async () => {
    requireDatabase();
    const choice = await dialog.showOpenDialog(window!, { title: "Open MNSG editor project", properties: ["openFile"], filters: [{ name: "MNSG project", extensions: ["mnsgproj", "json"] }] });
    if (choice.canceled) return null;
    const parsed = validate(await readJson(choice.filePaths[0], MAX_PROJECT_BYTES));
    await updateWorkspace(parsed);
    project = parsed; projectPath = choice.filePaths[0]; return project;
  }, true);
  handle("save-project", async (value) => {
    const parsed = validate(value);
    let destination = project?.id === parsed.id ? projectPath : null;
    if (!destination) {
      const choice = await dialog.showSaveDialog(window!, { title: "Save MNSG editor project", defaultPath: `${parsed.name.replace(/[^a-zA-Z0-9 _-]/g, "_")}.mnsgproj`, filters: [{ name: "MNSG project", extensions: ["mnsgproj"] }] });
      if (choice.canceled || !choice.filePath) return null;
      destination = choice.filePath;
    }
    parsed.updatedAt = new Date().toISOString();
    assertProjectBytes(parsed);
    // The encoded budget above measures this exact compact representation.
    // Pretty printing can expand a valid project beyond the reopen limit.
    await atomicWrite(destination, JSON.stringify(parsed));
    await updateWorkspace(parsed);
    project = parsed; projectPath = destination;
    return { project, fileName: basename(destination) };
  }, true);
  handle("export-patch", async (value) => {
    const parsed = validate(value);
    const db = requireDatabase();
    const generated = await generatePatch(parsed, db.loadRoom.bind(db), db.geometryTranslation.bind(db), () => db.authoringExportContext());
    const choice = await dialog.showSaveDialog(window!, { title: "Choose a new folder for the patch bundle", defaultPath: "mnsg_level_patch" });
    if (choice.canceled || !choice.filePath) return null;
    // Exporter produces a fixed allowlisted bundle. Never accept traversal from project data.
    const destination = choice.filePath;
    let existing = false;
    try { existing = (await stat(destination)).isDirectory(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (existing) { const answer = await dialog.showMessageBox(window!, { type: "warning", message: "Export into this existing bundle folder?", detail: "Files with matching names will be replaced. Choose a new folder to keep an earlier export.", buttons: ["Cancel", "Replace matching files"], cancelId: 0, defaultId: 0 }); if (answer.response === 0) return null; }
    const workspace = await materialize(parsed, generated);
    const tools = await managedTools.ensure();
    const files = await projectTemplateFiles(parsed, tools, generated);
    await writeConfinedBundle(destination, files);
    return { kind: "patch", fileNames: Object.keys(files).map((name) => `${basename(destination)}/${name}`), outputPaths: Object.keys(files).map(name => join(destination, name)), ...exportDetails(parsed), warnings: generated.warnings, workspace };
  }, true);
  handle("export-nrm", async (value) => {
    const parsed = validate(value);
    const toolchain = await managedTools.ensure();
    const choice = await dialog.showSaveDialog(window!, { title: "Export prebuilt MNSG mod", defaultPath: `${parsed.mod!.inputs.mod_filename}.nrm`, filters: [{ name: "Recomp mod", extensions: ["nrm"] }] });
    if (choice.canceled || !choice.filePath) return null;
    nrmOutputName(choice.filePath);
    const db = requireDatabase();
    const result = await exportNrm(parsed, db.loadRoom.bind(db), toolchain, db.geometryTranslation.bind(db), () => db.authoringExportContext());
    const files = nrmOutputFiles(choice.filePath, result.bytes, result.nativeLibraryFiles);
    const destination = resolve(choice.filePath, "..");
    const existing: string[] = [];
    for (const name of Object.keys(files)) { if (basename(name) !== name) throw Error("Native sidecar must have a portable basename."); try { await stat(join(destination, name)); existing.push(name); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
    if (existing.length) { const answer = await dialog.showMessageBox(window!, { type: "warning", message: "Replace existing mod output files?", detail: existing.join("\n"), buttons: ["Cancel", "Replace files"], defaultId: 0, cancelId: 0 }); if (answer.response === 0) return null; }
    await materialize(parsed, await generatePatch(parsed, db.loadRoom.bind(db), db.geometryTranslation.bind(db), () => db.authoringExportContext()));
    await writeConfinedBundle(destination, files);
    return { kind: "nrm", fileNames: Object.keys(files), outputPaths: Object.keys(files).map(name => join(destination, name)), ...exportDetails(parsed), warnings: result.warnings, buildLog: result.buildLog };
  }, true);
  handle("configure-toolchain", () => managedTools.status(), true);
  handle("toolchain-status", () => managedTools.status());
  handle("import-mod-file", async kind => {
    if (!["icon", "additional", "symbols", "native-library"].includes(kind as string)) throw Error("Invalid mod file import kind.");
    const choice = await dialog.showOpenDialog(window!, { title: kind === "icon" ? "Choose a mod icon" : "Choose a project mod file", properties: ["openFile"], filters: kind === "icon" ? [{ name: "Mod icon", extensions: ["png", "jpg", "jpeg"] }] : kind === "symbols" ? [{ name: "Reference symbols", extensions: ["toml"] }] : kind === "native-library" ? [{ name: "Native library", extensions: ["dll", "dylib", "so"] }] : [{ name: "Project file", extensions: ["*"] }] });
    if (choice.canceled || !choice.filePaths[0]) return null;
    const path = choice.filePaths[0]; const limit = kind === "icon" ? MOD_LIMITS.iconBytes : MOD_LIMITS.fileBytes;
    const info = await stat(path); if (!info.isFile() || info.size > limit) throw Error("Selected mod file exceeds its size limit.");
    let bytes: Buffer = await readFile(path); if (bytes.length > limit) throw Error("Selected mod file exceeds its size limit.");
    let name = basename(path), mediaType = "application/octet-stream";
    if (kind === "icon") {
      const dimensions = iconDimensions(bytes);
      if (dimensions.format === "dds") throw Error("Choose a PNG or JPEG icon; imported icons are normalized to PNG.");
      else {
        const image = nativeImage.createFromBuffer(bytes); const size = image.getSize();
        if (image.isEmpty() || size.width !== dimensions.width || size.height !== dimensions.height || size.width * size.height > MOD_LIMITS.iconPixels) throw Error("The icon could not be decoded safely.");
        bytes = image.toPNG(); if (bytes.length > MOD_LIMITS.iconBytes) throw Error("Normalized PNG icon exceeds the two-MiB limit."); name = "thumb.png"; mediaType = "image/png";
      }
    } else if (kind === "symbols") mediaType = "application/toml";
    return modAttachment(name, bytes, mediaType);
  }, true);
  handle("workspace-status", async value => {
    const parsed = validate(value); const tools = await managedTools.ensure();
    const manifest = await readJson(join(tools.templatePath, "manifest.json"), 512 * 1024) as { bundleId: string };
    return { path: dataPath("project-workspaces", projectWorkspaceKey(parsed.id)), templateVersion: manifest.bundleId };
  });
}
const mime: Record<string, string> = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".ico": "image/x-icon" };
function csp(html = "") {
  const hashes = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].filter((match) => match[1]).map((match) => `'sha256-${createHash("sha256").update(match[1]).digest("base64")}'`);
  return `default-src 'self'; script-src 'self' ${hashes.join(" ")}${devUrl ? " 'unsafe-inline' 'unsafe-eval'" : ""}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'${devUrl ? " ws://127.0.0.1:3000" : ""}; object-src 'none'; base-uri 'none'; frame-src 'none'; form-action 'none'`;
}
async function registerProtocol() {
  const root = resolve(__dirname, "../out");
  protocol.handle("app", async (request) => {
    try {
      const url = new URL(request.url);
      if (url.host !== "editor" || request.method !== "GET") return new Response("Forbidden", { status: 403 });
      let relative = decodeURIComponent(url.pathname);
      if (relative.endsWith("/")) relative += "index.html";
      const path = resolve(root, `.${relative}`);
      if (path !== root && !path.startsWith(`${root}${sep}`)) return new Response("Forbidden", { status: 403 });
      const bytes = await readFile(path);
      const type = mime[extname(path)] ?? "application/octet-stream";
      return new Response(bytes, { headers: { "Content-Type": type, "Content-Security-Policy": csp(type === "text/html" ? bytes.toString("utf8") : "") } });
    } catch { return new Response("Not found", { status: 404 }); }
  });
}
function createWindow() {
  const bounds = clampWindowBounds(savedBounds.main, screen.getAllDisplays().map(display => display.workArea), { x: 60, y: 60, width: 1520, height: 980 });
  window = new BrowserWindow({ ...bounds, minWidth: 800, minHeight: 600, title: "MNSG Level Editor", backgroundColor: "#101419", webPreferences: { preload: join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, webviewTag: false } });
  trackBounds(window, "main");
  window.webContents.setWindowOpenHandler(({ url, frameName }) => {
    const name = panelName(frameName);
    if (url !== "about:blank" || !name) return { action: "deny" };
    const existing = panelWindows.get(name);
    if (existing && !existing.isDestroyed()) { existing.focus(); return { action: "deny" }; }
    if (pendingPanels.has(name)) return { action: "deny" };
    pendingPanels.add(name);
    const geometry = clampWindowBounds(savedBounds[name], screen.getAllDisplays().map(display => display.workArea), { x: bounds.x + 60, y: bounds.y + 60, width: name === "scene" ? 1100 : 680, height: 760 });
    return { action: "allow", outlivesOpener: false, overrideBrowserWindowOptions: { ...geometry, minWidth: 300, minHeight: 240, title: `MNSG — ${name}`, backgroundColor: "#101419", webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, webviewTag: false } } };
  });
  window.webContents.on("did-create-window", (child, details) => {
    const name = panelName(details.frameName);
    if (!name || details.url !== "about:blank") { child.destroy(); return; }
    pendingPanels.delete(name); panelWindows.set(name, child);
    child.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    child.webContents.on("will-navigate", event => event.preventDefault());
    child.webContents.on("will-frame-navigate", event => event.preventDefault());
    child.webContents.on("will-redirect", event => event.preventDefault());
    child.webContents.on("will-attach-webview", event => event.preventDefault());
    trackBounds(child, name);
    child.on("closed", () => { panelWindows.delete(name); pendingPanels.delete(name); });
  });
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  window.webContents.on("will-prevent-unload", (event) => {
    const answer = dialog.showMessageBoxSync(window!, { type: "warning", message: "Discard unsaved project changes?", detail: "Save the project before closing to keep these changes.", buttons: ["Keep editing", "Discard changes"], defaultId: 0, cancelId: 0 });
    // Electron's event overrides the renderer's prevented unload when canceled.
    if (answer === 1) event.preventDefault();
  });
  window.on("closed", () => { window = null; pendingPanels.clear(); });
  void window.loadURL(devUrl ?? "app://editor/");
}
function trackBounds(target: BrowserWindow, key: PanelName | "main") {
  const save = () => {
    if (target.isDestroyed()) return;
    savedBounds[key] = target.getNormalBounds();
    const serialized = JSON.stringify(savedBounds);
    boundsWrites = boundsWrites.then(() => atomicWrite(dataPath("window-bounds.json"), serialized)).catch(error => console.error("Could not save window positions", error));
  };
  target.on("resized", save); target.on("moved", save); target.on("close", save);
}
app.whenReady().then(async () => {
  await mkdir(app.getPath("userData"), { recursive: true });
  const resources = app.isPackaged ? join(process.resourcesPath, "managed-tools") : resolve(__dirname, "../resources/managed-tools");
  managedTools = new ManagedTools(resources, dataPath("managed-tools", "verified.json"));
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  if (devUrl) session.defaultSession.webRequest.onHeadersReceived((details, callback) => callback({ responseHeaders: { ...details.responseHeaders, "Content-Security-Policy": [csp()] } }));
  await registerProtocol(); await restore(); registerOperations(); createWindow();
  app.on("activate", () => { if (!window) createWindow(); });
}).catch((error: unknown) => { console.error(error); app.quit(); });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
