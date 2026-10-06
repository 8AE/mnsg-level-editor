import { _electron as electron } from "playwright";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, copyFile, mkdir, mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { checkTexturedRooms } from "./smoke-textures.mjs";

if (process.env.MNSG_TEST_BACKGROUND === "1") {
  throw new Error("Packaged smoke requires a visible window. Set MNSG_TEST_BACKGROUND=0; use test:desktop for hidden source checks.");
}
const binary = process.env.MNSG_TEST_APP ?? (process.platform === "darwin" ? path.resolve("release/mac-arm64/MNSG Level Editor.app/Contents/MacOS/MNSG Level Editor") : path.resolve("release/win-unpacked/MNSG Level Editor.exe"));
const artifacts = await realpath(await mkdtemp(path.join(tmpdir(), "mnsg-package-smoke-")));
const userData = path.join(artifacts, "isolated-user-data");
await mkdir(userData);
const cacheSource = process.env.MNSG_TEST_CACHE_DIR ?? (process.platform === "darwin"
  ? path.join(homedir(), "Library", "Application Support", "mnsg-level-editor")
  : path.join(process.env.APPDATA ?? path.join(homedir(), "AppData", "Roaming"), "mnsg-level-editor"));
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
let cache = { copied: false };
try {
  const identityBytes = await readFile(path.join(cacheSource, "rom.json"));
  assert(identityBytes.length <= 32 * 1024, "Cache identity must respect the production size limit");
  const identity = JSON.parse(identityBytes);
  assert(/^[a-f0-9]{64}$/.test(identity.normalizedSha256), "Cache requires a canonical normalized ROM hash");
  const romName = `${identity.normalizedSha256}.z64`;
  const source = path.join(cacheSource, "rom-cache", romName);
  assert((await stat(source)).size <= 128 * 1024 * 1024);
  const bytes = await readFile(source);
  assert.equal(sha256(bytes), identity.normalizedSha256, "Copy only a verified canonical ROM cache");
  await mkdir(path.join(userData, "rom-cache"));
  await copyFile(source, path.join(userData, "rom-cache", romName));
  await writeFile(path.join(userData, "rom.json"), identityBytes);
  cache = { copied: true, source: cacheSource, romName, identitySha256: sha256(identityBytes), normalizedSha256: identity.normalizedSha256 };
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.MNSG_DEV_URL;
env.PATH = "";
for (const key of ["CPATH", "C_INCLUDE_PATH", "LIBRARY_PATH", "DYLD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES", "LLVM_CONFIG_PATH", "CLANG_CONFIG_FILE_SYSTEM_DIR", "CLANG_CONFIG_FILE_USER_DIR"]) delete env[key];
// Packaged Electron ignores Node's -r preload. Its native bootstrap applies this
// switch before ASAR startup, so cache restoration also uses the isolated copy.
const args = [`--user-data-dir=${userData}`];

async function checkProceduralWorkspace(app, page, artifacts, observe) {
  const evidence = { panels: [], resizes: [], search: [], project: "No ROM or project; editing/history stay disabled." };
  const panelIds = ["rooms", "scene", "hierarchy", "inspector", "assets", "console"];
  const button = (scope, name) => scope.getByRole("button", { name, exact: true });
  async function pop(id) {
    const label = id[0].toUpperCase() + id.slice(1);
    if (["assets","console"].includes(id)) await page.getByRole("tab", {name:label,exact:true}).click();
    const waiting = app.waitForEvent("window", { timeout: 30_000 });
    await button(page, `Pop out ${label}`).filter({visible:true}).click();
    const child = await waiting;
    observe(child);
    await child.getByTestId(`workspace-panel-${id}`).waitFor();
    assert.equal(await child.evaluate(() => window.name), `mnsg-panel-${id}`);
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 2, "A popout creates exactly one native child");
    assert.equal(await child.locator(".app-toolbar").count(), 0, "A panel portal must not bootstrap a second editor");
    assert.equal(await child.locator('[data-testid^="workspace-panel-"]').count(), 1);
    const native = await app.browserWindow(child);
    const preferences = await native.evaluate(window => {
      const value = window.webContents.getLastWebPreferences();
      return { sandbox: value.sandbox, contextIsolation: value.contextIsolation, nodeIntegration: value.nodeIntegration };
    });
    assert.deepEqual(preferences, { sandbox: true, contextIsolation: true, nodeIntegration: false });
    const ipc = await child.evaluate(async () => {
      if (!window.mnsg) return { exposed: false };
      try { await window.mnsg.getStatus(); return { exposed: true, rejected: false }; }
      catch (error) { return { exposed: true, rejected: true, message: error.message }; }
    });
    assert(!ipc.exposed || ipc.rejected, "Native child must not gain privileged IPC authority");
    return { child, ipc, preferences };
  }
  async function closeNative(child) {
    const closing = child.waitForEvent("close", { timeout: 30_000 });
    const native = await app.browserWindow(child);
    await native.evaluate(window => window.close());
    await closing;
  }
  async function search(scope, phase) {
    const rooms = scope.getByTestId("workspace-panel-rooms");
    const input = rooms.getByLabel("Search rooms", { exact: true });
    await input.fill("no-such-procedural-room");
    await scope.waitForFunction(() => document.querySelectorAll('[data-testid="room-button"]').length === 0);
    await input.fill("Procedural study");
    await rooms.getByTestId("room-button").waitFor();
    assert.equal(await rooms.getByTestId("room-button").count(), 1);
    await input.fill("");
    evidence.search.push({ phase, unmatched: 0, matched: 1, cleared: await rooms.getByTestId("room-button").count() });
  }
  async function cleanSample() {
    const current = await page.evaluate(() => window.mnsg.getStatus());
    assert.equal(current.rom, null);
    assert.equal(current.project, null);
    assert.equal(current.roomCount, 0, "Procedural portals must not populate the native ROM database");
    assert(await button(page.getByTestId("workspace-panel-scene"), "Undo").isDisabled());
    assert(await button(page.getByTestId("workspace-panel-scene"), "Redo").isDisabled());
    assert(await button(page.locator(".app-toolbar"), "Save").isDisabled());
    assert.equal(await page.locator(".dirty-state").count(), 0);
    assert.equal(await page.locator(".app-toolbar").count(), 1);
  }
  const nativeMain = await app.browserWindow(page);
  // Use a real native window size so compact-display CI hosts can exercise the
  // desktop separators; do not emulate a browser viewport or disable sandboxing.
  await nativeMain.evaluate(window => window.setSize(1440, 900));
  evidence.nativeWindowSize = await nativeMain.evaluate(window => window.getSize());
  await button(page, "Open procedural sample").click();
  const canvas = page.getByTestId("viewport-navigation-canvas"), unavailable = page.getByText(/^3D rendering could not start\./);
  await canvas.or(unavailable).first().waitFor();
  evidence.webgl = await canvas.count() ? "available" : "unavailable: native Intel CI guest; diagnostic checked";
  if (!await canvas.count()) {
    assert.equal(process.env.MNSG_TEST_ALLOW_NO_WEBGL, "1", "WebGL must initialize unless the explicit no-GPU CI scope is selected");
    assert(await unavailable.isVisible(), "Missing WebGL must leave its actionable diagnostic visible");
  }
  await page.getByTestId("workspace-panel-rooms").getByTestId("room-button").waitFor();
  await cleanSample();
  for (const [id, label] of [["left", "Rooms width"], ["right", "Hierarchy and Inspector width"]]) {
    const separator = page.getByTestId(`resize-${id}`);
    const panel = page.getByTestId(id === "left" ? "workspace-panel-rooms" : "workspace-panel-inspector");
    const widthBefore = (await panel.boundingBox()).width;
    const before = Number(await separator.getAttribute("aria-valuenow"));
    const max = Number(await separator.getAttribute("aria-valuemax"));
    const direction = before + 16 <= max ? 1 : -1;
    await separator.focus();
    await separator.press(direction === 1 ? "ArrowRight" : "ArrowLeft");
    await page.waitForFunction(({ id, expected }) => Number(document.querySelector(`[data-testid="resize-${id}"]`)?.getAttribute("aria-valuenow")) === expected, { id, expected: before + direction * 16 });
    const widthKeyboard = (await panel.boundingBox()).width;
    assert(Math.abs(widthKeyboard - widthBefore - direction * 16) < 1, "Keyboard resize must change the actual panel width");
    await button(separator, `${direction === 1 ? "Decrease" : "Increase"} ${label}`).click();
    assert.equal(Number(await separator.getAttribute("aria-valuenow")), before);
    evidence.resizes.push({ id, before, keyboard: before + direction * 16, buttonRestored: before, widthBefore, widthKeyboard });
  }
  await search(page, "main-before-popouts");
  for (const id of panelIds) {
    const label = id[0].toUpperCase() + id.slice(1);
    const first = await pop(id);
    if (id === "rooms") await search(first.child, "rooms-child-before-redock");
    const closed = first.child.waitForEvent("close", { timeout: 30_000 });
    await button(first.child, `Redock ${label}`).click();
    await closed;
    await page.getByTestId(`workspace-panel-${id}`).waitFor();
    const second = await pop(id);
    if (id === "rooms") await search(second.child, "rooms-child-before-native-close");
    await closeNative(second.child);
    await page.getByTestId(`workspace-panel-${id}`).waitFor();
    // An actual filter transition catches adopted nodes whose listeners were lost
    // during a native close, even when the preserved DOM looks intact.
    await search(page, `main-after-${id}-native-close`);
    await cleanSample();
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1, "Redocked/native-closed panels must not leave child windows behind");
    evidence.panels.push({ id, frameName: `mnsg-panel-${id}`, redock: "passed", nativeClose: "passed", childIpc: second.ipc, preferences: second.preferences });
  }
  evidence.snapshot = path.join(artifacts, "packaged-procedural-workspace.png");
  await page.screenshot({ path: evidence.snapshot, fullPage: true });
  const final = await pop("rooms");
  await search(final.child, "rooms-child-before-main-close");
  return { evidence, finalChild: final.child };
}

const app = await electron.launch({ executablePath: binary, args, env, timeout: 30_000 });
let appClosed = false;
app.on("close", () => { appClosed = true; });
let finalPanel;
let page;
const errors = [], dialogs = [], dialogTasks = new Set();
const observe = observed => {
  observed.on("pageerror", error => errors.push(error.message));
  observed.on("dialog", dialog => {
    const entry = { type: dialog.type(), message: dialog.message(), handling: "pending" };
    dialogs.push(entry);
    if (dialog.type() !== "beforeunload") errors.push(`Unexpected ${dialog.type()} dialog: ${dialog.message()}`);
    const handling = (dialog.type() === "beforeunload" ? dialog.accept() : dialog.dismiss())
      .then(() => { entry.handling = "handled"; })
      .catch(error => {
        entry.handling = error.message;
        // Electron may finish native closure before CDP answers the unload dialog.
        // Only that precise completed-dialog race is diagnostic; closure/input
        // assertions remain mandatory and every other protocol failure is fatal.
        if (!(dialog.type() === "beforeunload" && /No dialog is showing/.test(error.message))) errors.push(error.message);
      }).finally(() => dialogTasks.delete(handling));
    dialogTasks.add(handling);
  });
};
try {
  await app.evaluate(({ session }) => session.defaultSession.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (_request, callback) => callback({ cancel: true })));
  await app.evaluate(({ BrowserWindow, app }) => {
    globalThis.__packageRenderGone = [];
    const observe = window => window.webContents.on("render-process-gone", (_event, details) => globalThis.__packageRenderGone.push(details));
    BrowserWindow.getAllWindows().forEach(observe);
    app.on("browser-window-created", (_event, window) => observe(window));
  });
  page = await app.firstWindow();
  const runtime = await app.evaluate(({ app }) => ({ name: app.getName(), userData: app.getPath("userData") }));
  runtime.graphicsMode = "default";
  assert.equal(await realpath(runtime.userData), await realpath(userData), "Packaged tests must never use the existing application data directory");
  observe(page);
  await page.waitForFunction(() => Boolean(window.mnsg));
  const status = await page.evaluate(() => window.mnsg.getStatus());
  const expected = JSON.parse(await readFile("package.json", "utf8")).version;
  assert.equal(status.appVersion, expected);
  assert.equal(status.toolchain.ready, true, JSON.stringify(status.toolchain));
  await assert.rejects(readFile(path.join(userData, "toolchain.json")), { code: "ENOENT" });
  assert.equal(page.url(), "app://editor/");
  await page.locator("body").waitFor();
  await page.waitForTimeout(500);
  assert((await page.locator("body").innerText()).includes("MNSG"));
  assert.equal(await page.evaluate(() => typeof window.mnsg.loadActorVisuals), "function", "Packaged preload must expose validated native actor previews");
  let proceduralWorkspace = null;
  let geometryTab = "No cached ROM; first-launch screen checked.";
  let textures = [];
  let actors = { skipped: "No canonical cached ROM is available." };
  let managedBuild = { skipped: "No canonical cached ROM is available; fixed bundled compiler probe still passed." };
  if (!status.rom) {
    assert.equal(status.project, null);
    assert.equal(status.roomCount, 0);
    const result = await checkProceduralWorkspace(app, page, artifacts, observe);
    proceduralWorkspace = result.evidence;
    finalPanel = result.finalChild;
  }
  if (status.rom) {
    await page.getByRole("tab", { name: "Geometry", exact: true }).click();
    await page.getByTestId("authored-geometry-list").waitFor();
    assert(Number(await page.getByTestId("viewport-canvas").getAttribute("data-authored-mesh-count")) > 0, "Native geometry is editable without an explicit conversion");
    assert.deepEqual((await page.evaluate(() => window.mnsg.getStatus())).project.authoredRooms, {}, "Preparing geometry must leave the project unchanged");
    geometryTab = "passed";
    textures = await checkTexturedRooms(page, artifacts);
    actors = await page.evaluate(async () => {
      const room = await window.mnsg.loadRoom(465);
      const body = room.actors.find(actor => actor.actorId === 0x2d3);
      const door = room.actors.find(actor => actor.actorId === 0x256);
      if (!body || !door) throw new Error("Native house body/selector fixture is absent.");
      const payload = await window.mnsg.loadActorVisuals(465, {});
      const visual = payload.actorVisuals.find(visual => visual.actorRef === body.id);
      if (visual?.status !== "conditional" || visual.parts.length < 2) throw new Error("Native body plus shadow must retain conditional initialization metadata.");
      const assets = payload.actorModels.filter(model => visual.parts.some(part => part.assetId === model.id));
      if (!assets.some(model => model.meshes.some(mesh => mesh.material?.textureId) && model.textures.length)) throw new Error("Native actor body textures are absent.");
      const selectors = [];
      for (const selector of [0, 1]) {
        const parameters = [...door.parameters]; parameters[0] = ((parameters[0] & 0x00ffffff) | (selector << 24)) >>> 0;
        const selected = await window.mnsg.loadActorVisuals(465, { [door.id]: { parameters } });
        const declaration = selected.actorVisuals.find(visual => visual.actorRef === door.id);
        if (!declaration?.parts.some(part => part.provenance.slot === selector)) throw new Error("Packaged native door selector did not refresh.");
        selectors.push(declaration.parts.map(part => ({ assetId: part.assetId, slot: part.provenance.slot })));
      }
      if (JSON.stringify(selectors[0]) === JSON.stringify(selectors[1])) throw new Error("Packaged door selector returned identical native assets.");
      return { bodyRef: body.id, bodyIndex: body.index, bodyStatus: visual.status, bodyParts: visual.parts.length, selectors };
    });
    await page.locator('[data-testid="room-button"][data-room-id="465"]').click();
    await page.getByRole("tab", { name: /^Actors/ }).click();
    await page.getByTestId("actor-list").locator(".record-item").nth(actors.bodyIndex).click();
    await page.waitForFunction(() => Number(document.querySelector('[data-testid="viewport-canvas"]')?.dataset.actorModelCount) > 0);
    const host = page.getByTestId("viewport-canvas");
    const geometry = page.getByTestId("geometry-toggle");
    assert.equal(await geometry.getAttribute("aria-pressed"), "true");
    await geometry.click();
    assert.equal(await host.getAttribute("data-geometry-visible"), "false");
    const canvas = page.getByTestId("viewport-navigation-canvas");
    await canvas.focus();
    const before = (await host.getAttribute("data-camera-position")).split(",").map(Number);
    await page.keyboard.down("w"); await page.waitForTimeout(250); await page.keyboard.up("w");
    const after = (await host.getAttribute("data-camera-position")).split(",").map(Number);
    assert(Math.hypot(...after.map((axis, index) => axis - before[index])) > 1, "Packaged focused WASD must move the actual camera");
    assert.equal(await page.locator(".dirty-state").count(), 0, "Native previews and view controls must preserve project state");
    actors = { ...actors, geometryVisibility: "passed", nativeWasd: "passed" };
    const buildProject = await page.evaluate(async () => {
      const project = await window.mnsg.newProject("Packaged offline compiler check");
      const room = await window.mnsg.loadRoom(465);
      const door = room.actors.find(actor => actor.actorId === 0x256);
      if (!door?.editable) throw new Error("Packaged native door fixture must remain editable.");
      project.roomOverrides = { 465: { actors: { [door.id]: { position: { ...door.position, x: door.position.x + 1 } } }, events: {} } };
      return project;
    });
    const projectPath = path.join(artifacts, "managed-build.mnsgproj"), nrmPath = path.join(artifacts, "managed-build.nrm");
    await app.evaluate(({ dialog }, paths) => { const queue = [...paths]; dialog.showSaveDialog = async () => ({ canceled: false, filePath: queue.shift() }); }, [projectPath, nrmPath]);
    await page.evaluate(value => window.mnsg.saveProject(value), buildProject);
    const workspace = await page.evaluate(value => window.mnsg.workspaceStatus(value), buildProject);
    assert(workspace.path.startsWith(path.join(userData, "project-workspaces")), "Project templates stay in the isolated app-owned workspace");
    const snapshot = JSON.parse(await readFile(path.join(workspace.path, "project.mnsgproj"), "utf8"));
    assert.deepEqual(snapshot.roomOverrides, buildProject.roomOverrides);
    assert((await readFile(path.join(workspace.path, "mod.toml"), "utf8")).includes('game_id = "mnsg"'));
    const built = await page.evaluate(value => window.mnsg.exportNrm(value), buildProject);
    assert.equal(built.kind, "nrm"); assert.equal(built.outputPaths[0], nrmPath); assert((await stat(nrmPath)).size > 100);
    await writeFile(path.join(artifacts, "managed-build.log"), built.buildLog ?? "");
    assert((await readFile(path.join(workspace.path, "mnsg_level_patch.c"), "utf8")).includes("RECOMP_HOOK"));
    managedBuild = { toolchain: status.toolchain, workspace, outputPaths: built.outputPaths, roomIds: built.roomIds, changes: built.changes, hostPath: "empty", network: "HTTP/HTTPS blocked", gameplay: "Not run or installed" };
  }
  if (cache.copied) {
    assert.equal(sha256(await readFile(path.join(cacheSource, "rom.json"))), cache.identitySha256);
    assert.equal(sha256(await readFile(path.join(cacheSource, "rom-cache", cache.romName))), cache.normalizedSha256);
  }
  await Promise.all([...dialogTasks]);
  assert.deepEqual(errors, []);
  const renderGone = await app.evaluate(() => globalThis.__packageRenderGone);
  assert.deepEqual(renderGone, []);
  const snapshot = path.join(artifacts, "packaged-app.png");
  await page.screenshot({ path: snapshot, fullPage: true });
  const report = { status: "passed", binary, runtime, appVersion: status.appVersion, roomCount: status.roomCount, romCached: Boolean(status.rom), existingCacheUnchanged: cache.copied, geometryTab, textures, actors, managedBuild, proceduralWorkspace, renderGone, dialogs, evidenceScope: status.rom ? "Own-ROM native editor and managed NRM build; no gameplay." : "Packaged offline first boot and procedural native panels; real-ROM editing/rendering not exercised.", url: page.url(), snapshot };
  if (finalPanel) {
    const mainClosed = page.waitForEvent("close", { timeout: 30_000 });
    const childClosed = finalPanel.waitForEvent("close", { timeout: 30_000 });
    const native = await app.browserWindow(page);
    // Return from the native evaluation before Windows closes the app process.
    await native.evaluate(window => { setTimeout(() => window.close(), 0); });
    await Promise.all([mainClosed, childClosed]);
    await Promise.all([...dialogTasks]);
    assert.deepEqual(errors, []);
    proceduralWorkspace.mainCloseCleansChildren = "passed";
  }
  await writeFile(path.join(artifacts, "packaged-checks.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  const failure = { status: "failed", binary, artifacts, message: error.stack, errors, dialogs, body: page && !page.isClosed() ? await page.locator("body").innerText().catch(() => "unavailable") : "closed" };
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(artifacts, "packaged-failure.png"), fullPage: true }).catch(screenshotError => { failure.screenshotError = screenshotError.message; });
  await writeFile(path.join(artifacts, "packaged-failure.json"), JSON.stringify(failure, null, 2));
  console.error(`Packaged smoke failed; evidence: ${artifacts}`);
  throw error;
} finally {
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `directory=${artifacts}\n`);
  if (!appClosed) await app.close();
}
