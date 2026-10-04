import { _electron as electron } from "playwright";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkTexturedRooms } from "./smoke-textures.mjs";

const romPath = process.env.MNSG_TEST_ROM;
if (!romPath) throw new Error("Set MNSG_TEST_ROM to your US MNSG ROM. The smoke test never downloads or includes a ROM.");
const templatePath = process.env.MNSG_TEST_TEMPLATE;
const temporary = await mkdtemp(path.join(tmpdir(), "mnsg-editor-smoke-"));
const projectPath = path.join(temporary, "smoke.mnsgproj");
const bundlePath = path.join(temporary, "patch-bundle");
const nrmPath = path.join(temporary, "smoke.nrm");
const screenshotPath = path.join(temporary, "native-room.png");
const geometryScreenshotPath = path.join(temporary, "native-room-geometry.png");
const wrapperPath = path.join(temporary, "launch.cjs");
// Test-only main-process harness. Production code and renderer IPC have no path override.
await writeFile(wrapperPath, `const native=require('electron');const {app,dialog}=native;
if(process.env.MNSG_TEST_BACKGROUND==='1'){const Module=require('node:module');const original=Module._load;const Window=native.BrowserWindow;const wrapped=Object.create(native);Object.defineProperty(wrapped,'BrowserWindow',{value:class extends Window{constructor(options){super({...options,show:false,webPreferences:{...options.webPreferences,backgroundThrottling:false}})}}});Module._load=function(request){return request==='electron'?wrapped:original.apply(this,arguments)};}
app.setPath('userData',${JSON.stringify(path.join(temporary, "user-data"))});
globalThis.__mnsgSmoke={open:[],save:[],dialogs:[],unload:[],windows:[]};
app.on('browser-window-created',(_event,window)=>{globalThis.__mnsgSmoke.windows.push(window);window.on('closed',()=>{globalThis.__mnsgSmoke.windows=globalThis.__mnsgSmoke.windows.filter(entry=>entry!==window)})});
dialog.showOpenDialog=async(_window,options)=>{globalThis.__mnsgSmoke.dialogs.push(options.title);const paths=globalThis.__mnsgSmoke.open.shift();if(!paths)throw new Error('No open dialog answer queued');return {canceled:false,filePaths:paths}};
dialog.showSaveDialog=async(_window,options)=>{globalThis.__mnsgSmoke.dialogs.push(options.title);const filePath=globalThis.__mnsgSmoke.save.shift();if(!filePath)throw new Error('No save dialog answer queued');return {canceled:false,filePath}};
dialog.showMessageBox=async()=>({response:0,checkboxChecked:false});
dialog.showMessageBoxSync=()=>globalThis.__mnsgSmoke.unload.shift()??0;
require(${JSON.stringify(path.resolve("dist-electron/main.cjs"))});
`);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.MNSG_DEV_URL;
const desktop = await electron.launch({ args: [wrapperPath], env, timeout: 30_000 });
let summary;
try {
  const page = await desktop.firstWindow();
  // Electron handles beforeunload in its native main-process decision handler.
  // Disable Playwright's automatic dismissal of the already-handled browser event.
  page.on("dialog", () => {});
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error" && /Content Security Policy|Refused to|Uncaught/.test(message.text())) errors.push(message.text()); });
  await page.waitForFunction(() => Boolean(window.mnsg));
  assert.equal(await page.evaluate(() => typeof window.require), "undefined", "Renderer must not have Node require");
  assert.equal(await page.evaluate(() => typeof window.process), "undefined", "Renderer must not have Node process");
  await desktop.evaluate((_electron, input) => { globalThis.__mnsgSmoke.open.push([input]); }, romPath);
  const imported = await page.evaluate(() => window.mnsg.importRom());
  assert.equal(imported.rom.region, "US");
  assert(imported.roomCount > 0);
  const catalog = await page.evaluate(() => window.mnsg.listRooms());
  const fixture = await page.evaluate(async () => {
    for (const summary of await window.mnsg.listRooms()) {
      const room = await window.mnsg.loadRoom(summary.id);
      const actor = room.actors.find((entry) => entry.editable && entry.sourceKind !== "partition");
      if (actor) return { roomId: room.id, actor };
    }
    throw new Error("Imported ROM has no editable resident/normal actor fixture.");
  });
  const initial = await page.evaluate(() => window.mnsg.newProject("Desktop smoke project"));
  const modified = structuredClone(initial);
  const position = { ...fixture.actor.position, x: fixture.actor.position.x === 32767 ? 32766 : fixture.actor.position.x + 1 };
  modified.roomOverrides[String(fixture.roomId)] = { actors: { [fixture.actor.id]: { position } }, events: {} };
  await desktop.evaluate((_electron, input) => { globalThis.__mnsgSmoke.save.push(input); }, projectPath);
  const saved = await page.evaluate((input) => window.mnsg.saveProject(input), modified);
  assert.deepEqual(saved.project.roomOverrides, modified.roomOverrides);
  const onDisk = JSON.parse(await readFile(projectPath, "utf8"));
  assert.deepEqual(onDisk.roomOverrides, modified.roomOverrides);
  assert(!JSON.stringify(onDisk).includes(romPath), "Project must not store the ROM source path");
  await desktop.evaluate((_electron, input) => { globalThis.__mnsgSmoke.open.push([input]); }, projectPath);
  let reopened = await page.evaluate(() => window.mnsg.openProject());
  assert.deepEqual(reopened.roomOverrides, modified.roomOverrides);
  // Commit a second edit through the real inspector and Save control.
  await page.reload();
  const roomButton = page.locator(`[data-testid="room-button"][data-room-id="${fixture.roomId}"]`);
  await roomButton.waitFor();
  await roomButton.click();
  await page.getByTestId("actor-list").locator(".record-item").nth(fixture.actor.index).click();
  const nextX = position.x === 32767 ? 32766 : position.x + 1;
  const xInput = page.locator(".inspector-content .vector-fields").first().locator("input").first();
  await xInput.fill("1234");
  await xInput.press("Escape");
  assert.equal(await xInput.inputValue(), String(position.x), "Escape must restore the imported draft value");
  await xInput.fill(String(nextX));
  await xInput.press("Tab");
  await page.locator(".dirty-state").waitFor();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.locator(".dirty-state").waitFor({ state: "hidden" });
  await page.getByRole("status").filter({ hasText: "Saved smoke.mnsgproj" }).waitFor();
  reopened = (await page.evaluate(() => window.mnsg.getStatus())).project;
  assert.equal(reopened.roomOverrides[String(fixture.roomId)].actors[fixture.actor.id].position.x, nextX);
  const uiSaved = JSON.parse(await readFile(projectPath, "utf8"));
  assert.deepEqual(uiSaved.roomOverrides, reopened.roomOverrides);
  // Native room 0 has verified display-list and collision translation provenance.
  const geometryRoomId = 0;
  const geometryRoom = await page.evaluate((id) => window.mnsg.loadRoom(id), geometryRoomId);
  assert.equal(geometryRoom.geometryEdit?.supported, true, "Room 0 must expose its verified geometry translation schema");
  await page.locator(`[data-testid="room-button"][data-room-id="${geometryRoomId}"]`).click();
  await page.getByTestId("room-geometry-tab").click();
  const geometryX = page.getByTestId("geometry-x");
  await geometryX.fill("16");
  await geometryX.press("Tab");
  await page.locator(".dirty-state").waitFor();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.locator(".dirty-state").waitFor({ state: "hidden" });
  await page.getByRole("status").filter({ hasText: "Saved smoke.mnsgproj" }).waitFor();
  reopened = (await page.evaluate(() => window.mnsg.getStatus())).project;
  const geometryTranslation = { x: 16, y: 0, z: 0 };
  assert.deepEqual(reopened.roomOverrides[String(geometryRoomId)].geometry.translation, geometryTranslation);
  assert.equal(reopened.roomOverrides[String(fixture.roomId)].actors[fixture.actor.id].position.x, nextX, "Geometry edits must preserve existing actor edits");
  await desktop.evaluate((_electron, input) => { globalThis.__mnsgSmoke.open.push([input]); }, projectPath);
  reopened = await page.evaluate(() => window.mnsg.openProject());
  assert.deepEqual(reopened.roomOverrides[String(geometryRoomId)].geometry.translation, geometryTranslation, "Geometry translation must survive project reopen");
  assert.deepEqual(JSON.parse(await readFile(projectPath, "utf8")).roomOverrides, reopened.roomOverrides);
  await page.waitForTimeout(500);
  await page.screenshot({ path: geometryScreenshotPath, fullPage: true });
  const geometryRejections = await page.evaluate(async ({ project, roomId }) => {
    const hostile = structuredClone(project);
    hostile.roomOverrides[String(roomId)].geometry.spans = [{ romOffset: 0, expectedHex: "0000", replacementHex: "ffff" }];
    const overflow = structuredClone(project);
    overflow.roomOverrides[String(roomId)].geometry.translation.x = 32768;
    const fractional = structuredClone(project);
    fractional.roomOverrides[String(roomId)].geometry.translation.x = 0.5;
    const nonfinite = structuredClone(project);
    nonfinite.roomOverrides[String(roomId)].geometry.translation.x = Number.NaN;
    const result = {};
    for (const [name, value] of Object.entries({ hostile, overflow, fractional, nonfinite })) {
      try { await window.mnsg.saveProject(value); result[name] = false; } catch { result[name] = true; }
    }
    return result;
  }, { project: reopened, roomId: geometryRoomId });
  assert.deepEqual(geometryRejections, { hostile: true, overflow: true, fractional: true, nonfinite: true }, "Main-process geometry validation must reject forged spans and unsafe scalar values");
  // Reject forged room edits at the IPC boundary, rather than trusting renderer state.
  const rejected = await page.evaluate(async (input) => {
    input.roomOverrides["999"] = { actors: {}, events: {} };
    try { await window.mnsg.saveProject(input); return false; } catch { return true; }
  }, structuredClone(reopened));
  assert.equal(rejected, true);
  await desktop.evaluate((_electron, input) => { globalThis.__mnsgSmoke.save.push(input); }, bundlePath);
  const patch = await page.evaluate((input) => window.mnsg.exportPatch(input), reopened);
  assert.equal(patch.kind, "patch");
  const patchFiles = await readdir(bundlePath);
  assert(patchFiles.some((name) => name.endsWith(".c")) && patchFiles.some((name) => name.endsWith(".h")));
  const patchSource = await readFile(path.join(bundlePath, "mnsg_level_patch.c"), "utf8");
  for (const symbol of ["mnsg_level_apply_geometry_edits", "mnsg_level_geometry_before_collision", "mnsg_level_geometry_before_render"]) assert(patchSource.includes(symbol), `Mixed patch source must contain ${symbol}`);
  assert(patchSource.includes("func_801F8C4C_5B4B5C") && patchSource.includes("func_801F95D8_5B54E8"), "Geometry patch must hook both verified native collision and render paths");
  let nrm = { skipped: "Set MNSG_TEST_TEMPLATE to enable the native mod toolchain export check." };
  if (templatePath) {
    await desktop.evaluate((_electron, input) => { globalThis.__mnsgSmoke.open.push([input]); }, templatePath);
    const tools = await page.evaluate(() => window.mnsg.configureToolchain());
    assert.equal(tools.ready, true, `Toolchain is incomplete: ${tools.missing.join(", ")}`);
    await desktop.evaluate((_electron, input) => { globalThis.__mnsgSmoke.save.push(input); }, nrmPath);
    const built = await page.evaluate((input) => window.mnsg.exportNrm(input), reopened);
    assert.equal(built.kind, "nrm");
    assert((await stat(nrmPath)).size > 0);
    await writeFile(path.join(temporary, "nrm-build.log"), built.buildLog);
    nrm = { path: nrmPath, bytes: (await stat(nrmPath)).size };
  }
  const textures = await checkTexturedRooms(page, temporary);
  await page.reload();
  await page.waitForFunction(() => Boolean(window.mnsg));
  await page.locator(`[data-testid="room-button"][data-room-id="${fixture.roomId}"]`).click();
  await page.getByTestId("actor-list").locator(".record-item").nth(fixture.actor.index).click();
  await page.locator("canvas").waitFor({ timeout: 20_000 });
  await page.waitForTimeout(1000);
  const canvas = await page.locator("canvas").first().evaluate((element) => ({ width: element.width, height: element.height }));
  assert(canvas.width > 0 && canvas.height > 0, "3D canvas must have real dimensions");
  await page.screenshot({ path: screenshotPath, fullPage: true });
  assert.deepEqual(errors, [], "No renderer JavaScript or Content Security Policy errors");
  const isolation = await desktop.evaluate(() => { const settings = globalThis.__mnsgSmoke.windows[0].webContents.getLastWebPreferences(); return { sandbox: settings.sandbox, contextIsolation: settings.contextIsolation, nodeIntegration: settings.nodeIntegration }; });
  assert.deepEqual(isolation, { sandbox: true, contextIsolation: true, nodeIntegration: false });
  // Native close must respect the user's decision for unsaved inspector edits.
  await xInput.fill(String(nextX === 32767 ? 32766 : nextX + 1));
  await xInput.press("Enter");
  await page.locator(".dirty-state").waitFor();
  await desktop.evaluate(() => { globalThis.__mnsgSmoke.unload.push(0); globalThis.__mnsgSmoke.windows[0].close(); });
  await page.waitForTimeout(250);
  assert.equal(await desktop.evaluate(() => globalThis.__mnsgSmoke.windows.length), 1, "Keep editing must preserve the unsaved window");
  const closed = page.waitForEvent("close");
  await desktop.evaluate(() => { globalThis.__mnsgSmoke.unload.push(1); globalThis.__mnsgSmoke.windows[0].close(); });
  await closed;
  summary = { status: "passed", temporary, screenshotPath, geometryScreenshotPath, projectPath, roomCount: catalog.length, testedRoomId: fixture.roomId, actorId: fixture.actor.id, geometry: { roomId: geometryRoomId, translation: geometryTranslation, saveReopen: "passed", rejections: geometryRejections }, textures, patchFiles, nrm, isolation, canvas, nativeUnsavedClose: "passed", inspectorEscapeEnter: "passed" };
} finally { await desktop.close(); }
// Relaunch with the same cache: the app must restore the ROM without another picker.
const restoredApp = await electron.launch({ args: [wrapperPath], env, timeout: 30_000 });
try {
  const page = await restoredApp.firstWindow();
  await page.waitForFunction(() => Boolean(window.mnsg));
  const restored = await page.evaluate(() => window.mnsg.getStatus());
  assert.equal(restored.roomCount, summary.roomCount);
  assert.equal(restored.rom.region, "US");
  const cacheFiles = await readdir(path.join(temporary, "user-data", "rom-cache"));
  assert.equal(cacheFiles.length, 1, "One normalized ROM cache should survive app restart");
  summary.cacheRestore = "passed";
} finally { await restoredApp.close(); }
console.log(JSON.stringify(summary, null, 2));
