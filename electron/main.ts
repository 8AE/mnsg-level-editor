import { app, BrowserWindow, dialog, ipcMain, protocol, session, type IpcMainInvokeEvent } from "electron";
import { createHash } from "node:crypto";
import { readFile, stat, mkdir } from "node:fs/promises";
import { basename, extname, join, resolve, sep } from "node:path";
import type { AppStatus, EditorProject, RomIdentity } from "../shared/types";
import { importRomBytes, type ImportedRom } from "../core/rom";
import { createProject, validateProject } from "../core/project";
import { generatePatch, exportNrm, inspectToolchain, type ToolchainConfig } from "../core/export";
import { atomicWrite, readJson } from "./storage";

protocol.registerSchemesAsPrivileged([{ scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
app.enableSandbox();
const devUrl = !app.isPackaged && process.env.MNSG_DEV_URL === "http://127.0.0.1:3000" ? process.env.MNSG_DEV_URL : null;
let window: BrowserWindow | null = null;
let database: ImportedRom | null = null;
let romIdentity: RomIdentity | null = null;
let project: EditorProject | null = null;
let projectPath: string | null = null;
let toolchain: ToolchainConfig | undefined;
let busy = false;
const startupWarnings: string[] = [];
const dataPath = (...parts: string[]) => join(app.getPath("userData"), ...parts);
const requireDatabase = () => { if (!database || !romIdentity) throw new Error("Import your US MNSG ROM first."); return database; };
const validate = (value: unknown) => {
  const db = requireDatabase();
  return validateProject(value, romIdentity!, db.loadRoom.bind(db), db.geometryTranslation.bind(db));
};

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
  return { desktop: true, appVersion: app.getVersion(), rom: romIdentity, roomCount: database?.listRooms().length ?? 0, project, toolchain: await inspectToolchain(toolchain), warnings: [...startupWarnings, ...(database?.warnings ?? [])] };
}
async function restore() {
  try {
    const config = await readJson(dataPath("toolchain.json"), 32 * 1024) as ToolchainConfig;
    if (config && typeof config.templatePath === "string") toolchain = config;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") startupWarnings.push("Saved toolchain configuration could not be read."); }
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
  handle("load-room", (id) => { if (!Number.isInteger(id) || (id as number) < 0) throw new Error("Invalid room ID."); return requireDatabase().loadRoom(id as number); });
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
  handle("new-project", (name) => {
    requireDatabase();
    if (typeof name !== "string" || !name.trim() || name.trim().length > 120) throw new Error("Project name must be 1–120 characters.");
    project = createProject(name.trim(), romIdentity!);
    projectPath = null; return project;
  }, true);
  handle("open-project", async () => {
    requireDatabase();
    const choice = await dialog.showOpenDialog(window!, { title: "Open MNSG editor project", properties: ["openFile"], filters: [{ name: "MNSG project", extensions: ["mnsgproj", "json"] }] });
    if (choice.canceled) return null;
    const parsed = validate(await readJson(choice.filePaths[0]));
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
    await atomicWrite(destination, JSON.stringify(parsed, null, 2));
    project = parsed; projectPath = destination;
    return { project, fileName: basename(destination) };
  }, true);
  handle("export-patch", async (value) => {
    const parsed = validate(value);
    const db = requireDatabase();
    const generated = await generatePatch(parsed, db.loadRoom.bind(db), db.geometryTranslation.bind(db));
    const choice = await dialog.showSaveDialog(window!, { title: "Choose a new folder for the patch bundle", defaultPath: "mnsg_level_patch" });
    if (choice.canceled || !choice.filePath) return null;
    // Exporter produces a fixed allowlisted bundle. Never accept traversal from project data.
    const destination = choice.filePath;
    let existing = false;
    try { existing = (await stat(destination)).isDirectory(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (existing) { const answer = await dialog.showMessageBox(window!, { type: "warning", message: "Export into this existing bundle folder?", detail: "Files with matching names will be replaced. Choose a new folder to keep an earlier export.", buttons: ["Cancel", "Replace matching files"], cancelId: 0, defaultId: 0 }); if (answer.response === 0) return null; }
    for (const name of Object.keys(generated.files)) {
      if (basename(name) !== name || !/^[a-zA-Z0-9_.-]+$/.test(name)) throw new Error("Unsafe exporter file name.");
    }
    for (const [name, content] of Object.entries(generated.files)) await atomicWrite(join(destination, name), content);
    return { kind: "patch", fileNames: Object.keys(generated.files).map((name) => `${basename(destination)}/${name}`), warnings: generated.warnings };
  }, true);
  handle("export-nrm", async (value) => {
    const parsed = validate(value);
    const readiness = await inspectToolchain(toolchain);
    if (!readiness.ready || !toolchain) throw new Error(`Configure the Recomp mod toolchain first. ${readiness.missing.join(", ")}`);
    const choice = await dialog.showSaveDialog(window!, { title: "Export prebuilt MNSG mod", defaultPath: "mnsg_level_patch.nrm", filters: [{ name: "Recomp mod", extensions: ["nrm"] }] });
    if (choice.canceled || !choice.filePath) return null;
    const db = requireDatabase();
    const result = await exportNrm(parsed, db.loadRoom.bind(db), toolchain, db.geometryTranslation.bind(db));
    await atomicWrite(choice.filePath, result.bytes);
    return { kind: "nrm", fileNames: [basename(choice.filePath)], warnings: result.warnings, buildLog: result.buildLog };
  }, true);
  handle("configure-toolchain", async () => {
    const choice = await dialog.showOpenDialog(window!, { title: "Choose MNSGRecompModTemplate folder", properties: ["openDirectory"] });
    if (choice.canceled) return null;
    const selected: ToolchainConfig = { templatePath: choice.filePaths[0] };
    let result = await inspectToolchain(selected);
    if (!result.ready) {
      const answer = await dialog.showMessageBox(window!, { type: "info", message: "Complete the mod toolchain setup", detail: result.missing.join("\n"), buttons: ["Use detected tools", "Choose executable paths"], defaultId: 0, cancelId: 0 });
      if (answer.response === 1) {
        for (const [key, label] of [["clangPath", "LLVM Clang compiler (MIPS target)"], ["linkerPath", "LLVM ld.lld linker"], ["modToolPath", "RecompModTool executable"]] as const) {
          const executable = await dialog.showOpenDialog(window!, { title: `Choose ${label}`, properties: ["openFile"] });
          if (executable.canceled) return null;
          selected[key] = executable.filePaths[0];
        }
        result = await inspectToolchain(selected);
      }
    }
    await atomicWrite(dataPath("toolchain.json"), JSON.stringify(selected, null, 2));
    toolchain = selected; return result;
  }, true);
  handle("toolchain-status", () => inspectToolchain(toolchain));
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
  window = new BrowserWindow({ width: 1520, height: 980, minWidth: 1000, minHeight: 650, title: "MNSG Level Editor", backgroundColor: "#101419", webPreferences: { preload: join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  window.webContents.on("will-prevent-unload", (event) => {
    const answer = dialog.showMessageBoxSync(window!, { type: "warning", message: "Discard unsaved project changes?", detail: "Save the project before closing to keep these changes.", buttons: ["Keep editing", "Discard changes"], defaultId: 0, cancelId: 0 });
    // Electron's event overrides the renderer's prevented unload when canceled.
    if (answer === 1) event.preventDefault();
  });
  window.on("closed", () => { window = null; });
  void window.loadURL(devUrl ?? "app://editor/");
}
app.whenReady().then(async () => {
  await mkdir(app.getPath("userData"), { recursive: true });
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  if (devUrl) session.defaultSession.webRequest.onHeadersReceived((details, callback) => callback({ responseHeaders: { ...details.responseHeaders, "Content-Security-Policy": [csp()] } }));
  await registerProtocol(); await restore(); registerOperations(); createWindow();
  app.on("activate", () => { if (!window) createWindow(); });
}).catch((error: unknown) => { console.error(error); app.quit(); });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
