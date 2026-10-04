import { _electron as electron } from "playwright";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { cameraState, settlePose, snapshot } from "./smoke-camera.mjs";
import * as THREE from "three";

// Real Electron/renderer/native-dialog integration. Never starts Goemon64Recomp,
// installs a mod, downloads a ROM, or writes an existing user's app profile.
const romPath = process.env.MNSG_TEST_ROM;
if (!romPath) throw new Error("Set MNSG_TEST_ROM to your own US MNSG ROM.");
// Explicit development checkpoint only. The default run requires full source
// export; UI-only evidence leaves native export and the overall goal pending.
const uiOnly = process.env.MNSG_SMOKE_UI_ONLY === "1";
const artifacts = await realpath(await mkdtemp(path.join(tmpdir(), "mnsg-authoring-smoke-")));
const userData = path.join(artifacts, "user-data");
const projectPath = path.join(artifacts, "authoring.mnsgproj");
const bundlePath = path.join(artifacts, "authoring-patch");
await mkdir(userData);
const wrapper = path.join(artifacts, "launch.cjs");
await writeFile(wrapper, `
const native = require('electron');
const { app, dialog } = native;
if (process.env.MNSG_TEST_BACKGROUND === '1') {
  const Module = require('node:module'), original = Module._load;
  const Window = native.BrowserWindow, wrapped = Object.create(native);
  Object.defineProperty(wrapped, 'BrowserWindow', { value: class extends Window {
    constructor(options) { super({ ...options, show: false, webPreferences: { ...options.webPreferences, backgroundThrottling: false } }); }
  } });
  Module._load = function(request) { return request === 'electron' ? wrapped : original.apply(this, arguments); };
}
app.setPath('userData', ${JSON.stringify(userData)});
globalThis.__authoringSmoke = { open: [], save: [], windows: [], dialogs: [], rendererGone: [], childGone: [] };
app.on('child-process-gone', (_event, details) => globalThis.__authoringSmoke.childGone.push(details));
app.on('browser-window-created', (_event, window) => {
  globalThis.__authoringSmoke.windows.push(window);
  window.webContents.on('render-process-gone', (_event, details) => globalThis.__authoringSmoke.rendererGone.push(details));
});
dialog.showOpenDialog = async (_window, options) => {
  globalThis.__authoringSmoke.dialogs.push(options.title);
  const filePaths = globalThis.__authoringSmoke.open.shift();
  if (!filePaths) throw new Error('Unqueued native open dialog');
  return { canceled: false, filePaths };
};
dialog.showSaveDialog = async (_window, options) => {
  globalThis.__authoringSmoke.dialogs.push(options.title);
  const filePath = globalThis.__authoringSmoke.save.shift();
  if (!filePath) throw new Error('Unqueued native save dialog');
  return { canceled: false, filePath };
};
dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
// Only this disposable test profile may discard edits during harness cleanup.
dialog.showMessageBoxSync = () => 1;
require(${JSON.stringify(path.resolve("dist-electron/main.cjs"))});
`);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.MNSG_DEV_URL;
const app = await electron.launch({ args: [wrapper], env, timeout: 30_000 });
const report = { artifacts, status: "running", milestones: [] };
const diagnostics = { pageErrors: [], console: [], stdout: [], stderr: [] };
const boundedPush = (items, item) => { items.push(item); if (items.length > 200) items.shift(); };
app.process().stdout?.on("data", chunk => boundedPush(diagnostics.stdout, String(chunk).slice(0, 4000)));
app.process().stderr?.on("data", chunk => boundedPush(diagnostics.stderr, String(chunk).slice(0, 4000)));
let page;
const fingerprint = value => {
  const { updatedAt: _updated, ...graph } = value;
  return JSON.stringify(graph);
};
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
async function record(name, evidence = {}) {
  report.milestones.push({ name, ...evidence });
  report.diagnostics = { ...diagnostics, native: await app.evaluate(() => ({ rendererGone: globalThis.__authoringSmoke.rendererGone, childGone: globalThis.__authoringSmoke.childGone })).catch(error => ({ unavailable: error.message })) };
  await writeFile(path.join(artifacts, "authoring-checks.json"), JSON.stringify(report, null, 2));
  console.log(`PASS ${name}`);
}

try {
  page = await app.firstWindow();
  page.setDefaultTimeout(30_000);
  if (env.MNSG_TEST_BACKGROUND === "1") {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  }
  const runtime = await app.evaluate(({ app }) => ({ userData: app.getPath("userData") }));
  assert.equal(await realpath(runtime.userData), await realpath(userData));
  page.on("pageerror", error => boundedPush(diagnostics.pageErrors, { message: error.message, stack: error.stack }));
  page.on("console", message => boundedPush(diagnostics.console, { type: message.type(), text: message.text().slice(0, 8000), location: message.location() }));
  page.on("crash", () => boundedPush(diagnostics.pageErrors, { message: "Playwright page crash" }));
  const idle = () => page.locator(".viewport-loading").waitFor({ state: "hidden" });
  const button = (name, root = page) => root.getByRole("button", { name, exact: true });
  const inspector = () => page.getByTestId("authoring-inspector");
  const field = (label, root = inspector()) => root.getByLabel(label, { exact: true });
  async function commit(label, value, root = inspector()) {
    const input = field(label, root);
    await input.fill(String(value));
    await input.press("Enter");
    await idle();
  }
  async function vector(label, axis, value) {
    // AuthoringVector has a visible group label and exactly XYZ inputs.
    // Narrow to the direct vector wrapper to avoid the whole inspector.
    const target = await inspector().getByText(label, { exact: true }).evaluate(element => {
      const wrapper = element.parentElement;
      return [...wrapper.querySelectorAll(".vector-fields input")].map(input => input.id);
    });
    assert.equal(target.length, 3, `Vector ${label} must expose only its three coordinates`);
    const coordinate = page.locator(`[id=${JSON.stringify(target[{ x: 0, y: 1, z: 2 }[axis]])}]`);
    await coordinate.fill(String(value));
    await coordinate.press("Enter");
    await idle();
  }
  let saveQueued = false;
  async function saved() {
    await idle();
    if (!saveQueued) {
      await app.evaluate((_electron, value) => globalThis.__authoringSmoke.save.push(value), projectPath);
      saveQueued = true;
    }
    await button("Save").click();
    await page.locator(".dirty-state").waitFor({ state: "hidden" });
    await idle();
    return JSON.parse(await readFile(projectPath, "utf8"));
  }
  async function room(id) {
    await idle();
    await page.locator(`[data-testid="room-button"][data-room-id="${id}"]`).click();
    await idle();
    await page.getByRole("tab", { name: "Room", exact: true }).click();
  }
  async function newRoom(name, clone = false) {
    await page.getByTestId("new-room-button").click();
    const modal = page.getByRole("dialog", { name: "New room", exact: true });
    await commit("Room name", name, modal);
    await button(clone ? "Clone current room" : "Blank room", modal).click();
    await page.getByTestId("create-room-button").click();
    await modal.waitFor({ state: "hidden" });
    await idle();
    return saved();
  }
  async function selectMesh(id) {
    await page.getByRole("tab", { name: "Geometry", exact: true }).click();
    await page.locator(`[data-testid="authored-geometry-list"] [data-mesh-id=${JSON.stringify(id)}]`).click();
  }

  await page.waitForFunction(() => Boolean(window.mnsg));
  await app.evaluate((_electron, value) => globalThis.__authoringSmoke.open.push([value]), romPath);
  await button("Choose US ROM").click();
  await page.locator('[data-testid="room-button"][data-room-id="0"]').waitFor({ timeout: 120_000 });
  await idle();
  const catalog = await page.evaluate(() => window.mnsg.getAuthoringCatalog());
  assert.equal(catalog.romHash, (await page.evaluate(() => window.mnsg.getStatus())).rom.normalizedSha256);
  const cloneDonorId = 465;
  const canonical = await page.evaluate(id => window.mnsg.loadRoom(id), cloneDonorId);
  const sourceHash = hash(await readFile(romPath));
  await record("isolated native ROM import", { roomCount: (await page.evaluate(() => window.mnsg.listRooms())).length, userData: runtime.userData });

  // Exercise the production primary-drag toggle with real pointer gestures.
  // Camera metadata is observational; no renderer control objects are exposed.
  const host = page.getByTestId("viewport-canvas");
  const canvas = page.getByTestId("viewport-navigation-canvas");
  const subtract = (a, b) => a.map((coordinate, axis) => coordinate - b[axis]);
  const length = vector => Math.hypot(...vector);
  report.navigation = { settling: [] };
  const settleNavigation = async label => {
    let previous = await cameraState(host), stable = 0;
    const started = Date.now(), samples = [];
    while (Date.now() - started < 12_000) {
      await page.waitForTimeout(150);
      const pose = await cameraState(host);
      const positionStep = length(subtract(pose.position, previous.position));
      const targetStep = length(subtract(pose.target, previous.target));
      samples.push({ elapsedMs: Date.now() - started, pose, positionStep, targetStep });
      stable = positionStep < 1e-5 && targetStep < 1e-5 ? stable + 1 : 0;
      previous = pose;
      // Four samples cover 600 ms of actual-frame pose stability. Unlike the
      // old Orbit change-event metadata, these observations include the tail
      // below OrbitControls' event-dispatch threshold.
      if (stable >= 4) {
        report.navigation.settling.push({ label, samples });
        return pose;
      }
    }
    report.navigation.settling.push({ label, samples, failed: true });
    throw new Error(`Camera did not settle for ${label}: ${JSON.stringify(samples.slice(-4))}`);
  };
  const projectBeforeNavigation = (await page.evaluate(() => window.mnsg.getStatus())).project;
  const primaryDrag = async label => {
    const bounds = await canvas.boundingBox(); assert(bounds);
    const start = { x: bounds.x + bounds.width * 0.55, y: bounds.y + bounds.height * 0.6 };
    await page.mouse.move(start.x, start.y); await page.mouse.down({ button: "left" });
    await page.mouse.move(start.x + 80, start.y + 40, { steps: 12 });
    await page.mouse.up({ button: "left" });
    return settleNavigation(label);
  };
  assert.equal(await page.getByTestId("camera-tilt").getAttribute("aria-pressed"), "true");
  const tiltBefore = await settleNavigation("before Tilt");
  const tiltBeforeImage = await snapshot(page, canvas, path.join(artifacts, "tilt-before.png"));
  const tiltAfter = await primaryDrag("after Tilt");
  const tiltAfterImage = await snapshot(page, canvas, path.join(artifacts, "tilt-after.png"));
  report.navigation.tilt = { before: tiltBefore, after: tiltAfter, cameraDelta: subtract(tiltAfter.position, tiltBefore.position), targetDelta: subtract(tiltAfter.target, tiltBefore.target), distanceDelta: length(subtract(tiltAfter.position, tiltAfter.target)) - length(subtract(tiltBefore.position, tiltBefore.target)) };
  assert(length(subtract(tiltAfter.position, tiltBefore.position)) > 1);
  assert(length(subtract(tiltAfter.target, tiltBefore.target)) < 1e-4, "Tilt must orbit around the existing target");
  assert(Math.abs(length(subtract(tiltBefore.position, tiltBefore.target)) - length(subtract(tiltAfter.position, tiltAfter.target))) < 1e-3, "Tilt must preserve camera-target distance");
  assert.notEqual(tiltBeforeImage.sha256, tiltAfterImage.sha256);
  await page.getByTestId("camera-pan").click();
  assert.equal(await host.getAttribute("data-primary-drag"), "pan");
  const panBefore = await settleNavigation("before Pan"), panAfter = await primaryDrag("after Pan");
  const cameraDelta = subtract(panAfter.position, panBefore.position), targetDelta = subtract(panAfter.target, panBefore.target);
  const orientationDelta = subtract(cameraDelta, targetDelta);
  report.navigation.pan = { before: panBefore, after: panAfter, cameraDelta, targetDelta, orientationDelta, orientationDeltaLength: length(orientationDelta), distanceDelta: length(subtract(panAfter.position, panAfter.target)) - length(subtract(panBefore.position, panBefore.target)) };
  assert(length(cameraDelta) > 1 && length(targetDelta) > 1, "Pan must move both camera and orbit target");
  assert(length(orientationDelta) < 1e-4, `Pan must preserve orientation and camera-target distance: ${JSON.stringify(report.navigation.pan)}`);
  const panImage = await snapshot(page, canvas, path.join(artifacts, "pan-after.png"));
  assert.notEqual(panImage.sha256, tiltAfterImage.sha256);
  await canvas.focus();
  const walkBefore = await settleNavigation("before WASD in Pan");
  await page.keyboard.down("w"); await page.waitForTimeout(250); await page.keyboard.up("w");
  const walkAfter = await settleNavigation("after WASD in Pan");
  report.navigation.walk = { before: walkBefore, after: walkAfter };
  assert(length(subtract(walkAfter.position, walkBefore.position)) > 1, "Focused WASD must still move in Pan mode");
  assert(length(subtract(subtract(walkAfter.position, walkBefore.position), subtract(walkAfter.target, walkBefore.target))) < 1e-4);
  assert.equal(fingerprint((await page.evaluate(() => window.mnsg.getStatus())).project), fingerprint(projectBeforeNavigation));
  assert.equal(await page.locator(".dirty-state").count(), 0);
  await record("primary Tilt/Pan gestures and focused WASD preserve project", { tiltBefore, tiltAfter, panBefore, panAfter, walkBefore, walkAfter });

  // Preserve House465's complete native roster before exercising the explicit
  // foreign-room controller admission gate at export. Room0 remains the
  // navigation/promotion fixture, not a full authored actor replacement donor.
  await room(cloneDonorId);
  let graph = await newRoom("Smoke blank A");
  const blankId = Number(Object.keys(graph.authoredRooms)[0]);
  assert(blankId >= 620 && blankId <= 799);
  assert.equal(graph.authoredRooms[blankId].meshes.length, 0);
  assert.equal(graph.authoredRooms[blankId].collisionMode, "authored");
  assert.equal(graph.authoredRooms[blankId].templateRoomId, cloneDonorId);
  assert(graph.authoredRooms[blankId].entrances.length > 0);
  assert.equal(await page.getByTestId("camera-pan").getAttribute("aria-pressed"), "true", "Primary drag choice must persist when a room is created");
  await room(cloneDonorId);
  graph = await newRoom("Smoke clone B", true);
  const cloneId = Number(Object.keys(graph.authoredRooms).find(id => Number(id) !== blankId));
  const cloned = graph.authoredRooms[cloneId];
  assert.equal(await host.getAttribute("data-primary-drag"), "pan", "Primary drag choice must persist across native/authored room switches");
  await page.getByTestId("camera-tilt").click();
  assert(cloned.meshes.length > 0 && cloned.actors.length === canonical.actors.length);
  assert.equal(cloned.templateRoomId, cloneDonorId);
  assert.equal(cloned.collisionMode, "template");
  assert.equal(cloned.collision.length, 0);
  assert.deepEqual(cloned.actors.map(actor => actor.spawnPolicy), canonical.actors.map(actor => actor.sourceKind === "partition" ? "proximity" : "resident"), "Clone must preserve per-placement native spawning, including shared prototypes");
  cloned.actors.forEach((actor, index) => {
    const original = canonical.actors[index];
    assert.equal(catalog.actorPrototypes.find(prototype => prototype.id === actor.prototypeId)?.actorId, original.actorId);
    assert.deepEqual(actor.position, original.position);
    assert.deepEqual(actor.rotation, original.rotation);
    assert.deepEqual(actor.parameters, original.parameters);
  });
  await record("blank and native clone", { blankId, cloneId, cloneDonorId, nativeMeshCount: cloned.meshes.length, nativeActorCount: canonical.actors.length });

  // Preserve translated native collision through the Make editable transition.
  await room(0);
  await page.getByTestId("geometry-x").fill("16");
  await page.getByTestId("geometry-x").press("Enter");
  await idle();
  await page.getByRole("tab", { name: "Geometry", exact: true }).click();
  await page.getByTestId("make-editable-button").click();
  await idle();
  graph = await saved();
  assert.deepEqual(graph.authoredRooms[0].collisionTranslation, { x: 16, y: 0, z: 0 });
  const promoted = await page.evaluate(value => window.mnsg.loadProjectRoom(value, 0), graph);
  assert.deepEqual(promoted.collisionTranslation, graph.authoredRooms[0].collisionTranslation);
  await button("Restore native room", inspector()).click();
  await idle();
  graph = await saved();
  assert.equal(graph.authoredRooms[0], undefined);
  await button("Undo").click(); await idle(); graph = await saved();
  assert(graph.authoredRooms[0]);
  await button("Redo").click(); await idle(); graph = await saved();
  assert.equal(graph.authoredRooms[0], undefined);
  await record("translated promotion, native reset and undo/redo");

  await room(cloneId);
  const nondegenerate = (mesh, indices) => {
    const [a, b, c] = indices.map(index => mesh.vertices[index].position);
    const u = [b.x - a.x, b.y - a.y, b.z - a.z], v = [c.x - a.x, c.y - a.y, c.z - a.z];
    return u[1] * v[2] !== u[2] * v[1] || u[2] * v[0] !== u[0] * v[2] || u[0] * v[1] !== u[1] * v[0];
  };
  const meshIndex = graph.authoredRooms[cloneId].meshes.findIndex(mesh => mesh.vertices.length >= 3 && mesh.indices.length >= 3 && nondegenerate(mesh, [0, 1, 2]) && nondegenerate(mesh, mesh.indices.slice(0, 3)));
  assert(meshIndex >= 0, "Native room must provide a nondegenerate topology-edit fixture");
  const meshId = graph.authoredRooms[cloneId].meshes[meshIndex].id;
  const originalMesh = structuredClone(graph.authoredRooms[cloneId].meshes[meshIndex]);
  await selectMesh(meshId);
  await vector("Translate by", "x", 16);
  await button("Apply mesh transform", inspector()).click();
  await idle(); graph = await saved();
  assert.deepEqual(graph.authoredRooms[cloneId].meshes[meshIndex].vertices.map(vertex => vertex.position), originalMesh.vertices.map(vertex => ({ ...vertex.position, x: vertex.position.x + 16 })));
  await button("vertex", inspector()).click();
  const vertexX = graph.authoredRooms[cloneId].meshes[meshIndex].vertices[0].position.x + 8;
  await vector("Vertex position", "x", vertexX);
  await commit("Texture coordinates U, V", "0.25, 0.75");
  await commit("Vertex color R, G, B, A", "255, 64, 32, 127");
  graph = await saved();
  assert.deepEqual(graph.authoredRooms[cloneId].meshes[meshIndex].vertices[0], { ...originalMesh.vertices[0], position: { ...originalMesh.vertices[0].position, x: vertexX }, uv: [0.25, 0.75], color: [255, 64, 32, 127] });
  const composed = await page.evaluate(({ value, id }) => window.mnsg.loadProjectRoom(value, id), { value: graph, id: cloneId });
  const visibleMesh = composed.meshes.find(mesh => mesh.id === meshId);
  assert.equal(visibleMesh.colorItemSize, 4);
  assert.equal(visibleMesh.colors[3], 127 / 255);
  assert.equal(visibleMesh.material.lighting, false);
  const beforeTopology = structuredClone(graph);
  await button("Add vertex", inspector()).click(); await idle();
  graph = await saved(); assert.equal(graph.authoredRooms[cloneId].meshes[meshIndex].vertices.length, originalMesh.vertices.length + 1);
  await button("Remove vertex & incident faces", inspector()).click(); await idle();
  graph = await saved(); assert.equal(fingerprint(graph), fingerprint(beforeTopology));
  await button("Add triangle", inspector()).click(); await idle();
  graph = await saved(); assert.equal(graph.authoredRooms[cloneId].meshes[meshIndex].indices.length, originalMesh.indices.length + 3);
  await commit("Triangle vertex indices", originalMesh.indices.slice(0, 3).join(", "));
  await button("Remove face", inspector()).click(); await idle();
  graph = await saved(); assert.equal(fingerprint(graph), fingerprint(beforeTopology));
  await record("mesh transform, vertex UV/RGBA and topology", { meshId, vertexX });
  await record("before opening native asset library", { consoleErrors: diagnostics.console.filter(message => message.type === "error") });

  // Real browser drag starts on the production native thumbnail card. It must
  // run the card MIME handler and the viewport hit-plane placement handler.
  await room(blankId);
  await button("Library").click();
  const library = page.getByTestId("authoring-library");
  const component = catalog.geometry.find(asset => asset.id.startsWith("component:") && asset.roomIds.includes(cloneDonorId) && asset.vertexCount >= 3 && asset.vertexCount < 256);
  assert(component, "A bounded native component fixture must exist");
  await button("Geometry", library).click();
  await library.getByLabel("Search native assets").fill(component.id);
  const componentCard = library.locator(`[data-testid="asset-card"][data-asset-id=${JSON.stringify(component.id)}]`);
  await componentCard.waitFor();
  await componentCard.dragTo(page.getByTestId("viewport-navigation-canvas"));
  await idle(); graph = await saved();
  assert(graph.authoredRooms[blankId].meshes.some(mesh => mesh.sourceAssetId === component.id), "A real component drag must persist trusted provenance");
  await page.getByTestId("camera-pan").click();
  await button("Frame all geometry").click();
  const pickingPose = await settlePose(page, host), pickingBounds = await canvas.boundingBox();
  assert(pickingBounds);
  const pickingCamera = new THREE.PerspectiveCamera(42, pickingBounds.width / pickingBounds.height, 0.5, 250000);
  pickingCamera.position.fromArray(pickingPose.position);
  pickingCamera.lookAt(new THREE.Vector3().fromArray(pickingPose.target)); pickingCamera.updateMatrixWorld();
  const componentMeshes = graph.authoredRooms[blankId].meshes.filter(mesh => mesh.sourceAssetId === component.id);
  let actualMeshPick;
  for (const mesh of componentMeshes) {
    for (let at = 0; at < Math.min(mesh.indices.length, 48) && !actualMeshPick; at += 3) {
      const center = new THREE.Vector3();
      for (const index of mesh.indices.slice(at, at + 3)) {
        const p = mesh.vertices[index].position; center.add(new THREE.Vector3(p.x, p.y, p.z));
      }
      center.multiplyScalar(1 / 3).project(pickingCamera);
      if (center.z < -1 || center.z > 1 || Math.abs(center.x) > 0.9 || Math.abs(center.y) > 0.9) continue;
      const click = { x: pickingBounds.x + (center.x + 1) * pickingBounds.width / 2, y: pickingBounds.y + (1 - center.y) * pickingBounds.height / 2 };
      await page.mouse.click(click.x, click.y); await idle(); await page.waitForTimeout(75);
      const selected = (await page.getByTestId("authored-geometry-list").locator(".is-selected").evaluateAll(elements => elements.map(element => element.getAttribute("data-mesh-id"))))[0];
      if (selected === mesh.id) actualMeshPick = { meshId: selected, triangle: at / 3, click, pose: pickingPose };
    }
    if (actualMeshPick) break;
  }
  assert(actualMeshPick, "Real primary click in Pan mode must still pick the imported native triangle surface");
  assert.equal(await host.getAttribute("data-primary-drag"), "pan");
  await record("native component triangle picking remains active in Pan mode", actualMeshPick);
  const houseNpc = canonical.actors.find(actor => actor.actorId === 0x2d3);
  assert(houseNpc, "House465 must contain the native NPC fixture");
  // sourceRoomId identifies a variant's first canonical exemplar, not every
  // room where it appears. Match the actual native placement's parameter data.
  const prototype = catalog.actorPrototypes.find(prototype => prototype.actorId === houseNpc.actorId
    && prototype.parameters.every((parameter, index) => parameter === houseNpc.parameters[index]));
  assert(prototype && !graph.authoredRooms[blankId].actors.some(actor => catalog.actorPrototypes.find(candidate => candidate.id === actor.prototypeId)?.actorId === prototype.actorId), "Blank room must not already contain the foreign native NPC fixture");
  await button("Actors", library).click();
  await library.getByLabel("Search native assets").fill(prototype.id);
  const actorCard = library.locator(`[data-testid="asset-card"][data-asset-id=${JSON.stringify(prototype.id)}]`);
  await actorCard.locator("img").waitFor({ timeout: 120_000 });
  const thumbnail = await actorCard.locator("img").evaluate(async image => {
    await image.decode();
    const canvas = document.createElement("canvas"); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d"); context.drawImage(image, 0, 0);
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data, colors = new Set();
    for (let at = 0; at < data.length && colors.size < 64; at += 4) colors.add(`${data[at]},${data[at + 1]},${data[at + 2]},${data[at + 3]}`);
    return { source: image.currentSrc, width: image.naturalWidth, height: image.naturalHeight, colors: colors.size };
  });
  assert(thumbnail.source.startsWith("data:image/png") && thumbnail.width > 0 && thumbnail.height > 0);
  assert(thumbnail.colors >= 16, "Thumbnail must contain native rendered surfaces rather than an empty canvas");
  await writeFile(path.join(artifacts, "native-actor-thumbnail.png"), Buffer.from(thumbnail.source.split(",")[1], "base64"));
  await actorCard.dragTo(page.getByTestId("viewport-navigation-canvas"));
  await idle(); graph = await saved();
  const inserted = graph.authoredRooms[blankId].actors.find(actor => actor.prototypeId === prototype.id);
  assert(inserted, "Foreign-room native actor must be placed through the library drag");
  const insertionPolicy = inserted.spawnPolicy;
  const changedPolicy = insertionPolicy === "proximity" ? "resident" : "proximity";
  await field("Actor loading").selectOption(changedPolicy); await idle(); graph = await saved();
  assert.equal(graph.authoredRooms[blankId].actors.find(actor => actor.id === inserted.id).spawnPolicy, changedPolicy);
  await button("Undo").click(); await idle(); graph = await saved();
  assert.equal(graph.authoredRooms[blankId].actors.find(actor => actor.id === inserted.id).spawnPolicy, insertionPolicy);
  const visual = await page.evaluate(({ value, id }) => window.mnsg.loadProjectActorVisuals(value, id), { value: graph, id: blankId });
  const placedVisual = visual.actorVisuals.find(entry => entry.actorRef === inserted.id);
  assert(placedVisual.parts.length >= 2 && visual.actorModels.some(model => model.textures.length > 0));
  await button("Close", library).click();
  await button("Frame", inspector()).click();
  await page.waitForFunction(() => Number(document.querySelector('[data-testid="viewport-canvas"]').dataset.actorTexturedTriangles) > 0);
  const acceptedActorCoverage = await page.getByTestId("viewport-canvas").evaluate(element => ({ models: Number(element.dataset.actorModelCount), parts: Number(element.dataset.actorModelPartCount), texturedTriangles: Number(element.dataset.actorTexturedTriangles) }));
  assert(acceptedActorCoverage.models > 0 && acceptedActorCoverage.parts >= 2);
  await page.getByTestId("geometry-toggle").click();
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(artifacts, "foreign-actor-drop.png"), fullPage: true });
  await page.getByTestId("geometry-toggle").click();
  await record("native component and foreign actor thumbnail drag/drop", { componentId: component.id, prototypeId: prototype.id, actorId: inserted.id, parts: placedVisual.parts.length, acceptedActorCoverage, thumbnail: { width: thumbnail.width, height: thumbnail.height, colors: thumbnail.colors } });

  // Explicitly generate editable collision; template physics is never inferred.
  await room(blankId);
  await button("Generate collision from geometry", inspector()).click(); await idle();
  graph = await saved();
  assert.equal(graph.authoredRooms[blankId].collisionMode, "authored");
  assert(graph.authoredRooms[blankId].collision.length > 0);
  assert(graph.authoredRooms[blankId].collision.every(triangle => triangle.classifier >= 1 && triangle.sourceMeshId));
  await button("Add entrance", inspector()).click(); await idle();
  await commit("Entrance name", "Return from B");
  await vector("Spawn position", "x", 32);
  await commit("Base heading (1024 units per turn)", 256);
  await commit("Camera-start mode + direction byte", 19);
  graph = await saved();
  const authoredEntry = graph.authoredRooms[blankId].entrances.at(-1);
  assert.equal(authoredEntry.baseYaw, 256); assert.equal(authoredEntry.entryParameter, 19);
  // The real-ROM catalog regression verifies this canonical travel-door
  // variant flattens to two native batches / 72 vertices. Its representative
  // source room need not be House465; validate each actual authored context.
  const doorPrototype = catalog.actorPrototypes.find(prototype => prototype.actorId === 0x23c);
  assert(doorPrototype, "Catalog must contain the verified native travel-door appearance");
  const doorContextChecks = [];
  for (const [from, to, entranceId] of [[blankId, cloneId, graph.authoredRooms[cloneId].entrances[0].id], [cloneId, blankId, authoredEntry.id]]) {
    const candidate = structuredClone(graph), fixtureId = "smoke-door-context";
    candidate.authoredRooms[from].doors.push({
      id: fixtureId,
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      dimensions: { x: 96, y: 120, z: 32 },
      activation: from === blankId ? "interact" : "touch",
      destination: { roomId: to, entranceId },
      appearancePrototypeId: doorPrototype.id,
    });
    const contextual = await page.evaluate(({ value, id }) => window.mnsg.loadProjectActorVisuals(value, id), { value: candidate, id: from });
    const appearance = contextual.actorVisuals.find(visual => visual.actorRef === `door:${fixtureId}`);
    assert(appearance?.parts.length > 0, "Door appearance must resolve in the actual authored room and donor context");
    const assets = new Set(appearance.parts.map(part => part.assetId));
    const models = contextual.actorModels.filter(model => assets.has(model.id));
    assert(models.some(model => model.meshes.some(mesh => mesh.indices.length > 0)), "Contextual door appearance must contain real native triangles");
    doorContextChecks.push({ roomId: from, templateRoomId: candidate.authoredRooms[from].templateRoomId, prototypeId: doorPrototype.id, canonicalExemplarRoomId: doorPrototype.sourceRoomId, parts: appearance.parts.length, models: models.length });
    await room(from);
    await button("Add custom door", inspector()).click(); await idle();
    await field("Destination room").selectOption(String(to)); await idle();
    await field("Destination entrance").selectOption(entranceId); await idle();
    await field("Activation").selectOption(from === blankId ? "interact" : "touch"); await idle();
    await field("Door appearance").selectOption(doorPrototype.id); await idle();
    await vector("Trigger dimensions", "x", 96);
    graph = await saved();
    const door = graph.authoredRooms[from].doors.at(-1);
    assert.deepEqual(door.destination, { roomId: to, entranceId });
    assert.equal(door.dimensions.x, 96); assert.equal(door.appearancePrototypeId, doorPrototype.id);
  }
  await record("explicit authored collision and reciprocal custom door entrances", { blankId, cloneId, returnEntrance: authoredEntry.id, doorContextChecks });

  await room(blankId);
  const skyId = catalog.skyboxes[0].id;
  await field("Skybox").selectOption(skyId); await idle(); graph = await saved();
  const sky = await page.evaluate(({ value, id }) => window.mnsg.loadProjectRoom(value, id), { value: graph, id: blankId });
  assert.equal(sky.skybox.id, skyId);
  assert.equal(Buffer.from(sky.skybox.texture.rgbaBase64, "base64").length, sky.skybox.texture.width * sky.skybox.texture.height * 4);
  await page.screenshot({ path: path.join(artifacts, "authored-skybox.png"), fullPage: true });
  await field("Skybox").selectOption("none"); await idle(); graph = await saved();
  assert.equal(graph.authoredRooms[blankId].skyboxId, null);
  assert.equal((await page.evaluate(({ value, id }) => window.mnsg.loadProjectRoom(value, id), { value: graph, id: blankId })).skybox, undefined);
  await field("Skybox").selectOption("inherit"); await idle(); graph = await saved();
  assert.equal(Object.hasOwn(graph.authoredRooms[blankId], "skyboxId"), false);
  const baseline = structuredClone(graph);
  await commit("Room name", "Discarded draft name");
  await button("Revert room to saved", inspector()).click(); await idle();
  graph = await saved(); assert.equal(fingerprint(graph), fingerprint(baseline));
  await button("Undo").click(); await idle(); graph = await saved();
  assert.equal(graph.authoredRooms[blankId].name, "Discarded draft name");
  await button("Redo").click(); await idle(); graph = await saved();
  assert.equal(fingerprint(graph), fingerprint(baseline));
  await record("skybox selection/None/inheritance and saved reset undo/redo");

  await app.evaluate((_electron, value) => globalThis.__authoringSmoke.open.push([value]), projectPath);
  await button("Open").click(); await idle();
  const reopened = (await page.evaluate(() => window.mnsg.getStatus())).project;
  assert.equal(fingerprint(reopened), fingerprint(graph));
  const projectRooms = await page.evaluate(value => window.mnsg.listProjectRooms(value), reopened);
  assert(projectRooms.some(room => room.id === blankId) && projectRooms.some(room => room.id === cloneId));
  await room(blankId);
  await page.screenshot({ path: path.join(artifacts, "reopened-authored-room.png"), fullPage: true });
  await record("save/reopen complete authored graph", { projectPath, bytes: (await stat(projectPath)).size });

  const rejections = await page.evaluate(async ({ value, id }) => {
    const changes = {
      unknownActor: room => { room.actors[0].prototypeId = "actor:forged"; },
      nativePointer: room => { room.actors[0].modelPointer = 0x80000000; },
      invalidUV: room => { room.meshes[0].vertices[0].uv[0] = Infinity; },
      clippingClassifier: room => { room.collision[0].classifier = 0; },
      unsafeTranslation: room => { room.collisionTranslation = { x: 16, y: 0, z: 0 }; },
      invalidDestination: room => { room.doors[0].destination.roomId = 619; },
      rawROM: room => { room.romBytes = [0, 1, 2]; },
      selectionNamespace: room => { room.actors[0].id = `door:${room.doors[0].id}`; },
      derivedEventNamespace: room => { room.actors.push({ ...structuredClone(room.actors[0]), id: `event:${room.actors[0].id}` }); },
    };
    const rejected = {};
    const before = JSON.stringify((await window.mnsg.getStatus()).project);
    for (const [name, change] of Object.entries(changes)) {
      const candidate = structuredClone(value); change(candidate.authoredRooms[id]);
      try { await window.mnsg.loadProjectRoom(candidate, id); rejected[name] = false; }
      catch { rejected[name] = true; }
    }
    return { rejected, unchanged: before === JSON.stringify((await window.mnsg.getStatus()).project) };
  }, { value: reopened, id: blankId });
  assert(Object.values(rejections.rejected).every(Boolean), JSON.stringify(rejections));
  assert.equal(rejections.unchanged, true);
  await record("project-aware IPC rejects hostile authoring data", rejections);

  if (uiOnly) {
    report.exports = "Explicit UI-only checkpoint: C/H and NRM checks skipped; native export and the overall goal remain pending.";
    await record("editor checkpoint only; export remains pending");
  } else {
    // These are compilation handoffs only. Nothing installs or starts the game.
    let exportProject = reopened;
    // Only these two independently reproduced blockers have reviewed fixture
    // removals. Any other actor or diagnostic fails instead of being skipped.
    const reviewedBlockers = [
      { actorId: 0x308, reason: "Native camera-controller allocator has no intrinsic 3D model." },
      { actorId: 0x34e, reason: "Native progression/script removal controller has no intrinsic 3D model." },
    ];
    for (const { actorId, reason } of reviewedBlockers) {
      const hex = actorId.toString(16);
      const blockedControllers = exportProject.authoredRooms[cloneId].actors.filter(actor =>
        catalog.actorPrototypes.find(prototype => prototype.id === actor.prototypeId)?.actorId === actorId);
      assert.equal(blockedControllers.length, 1, `Native clone must retain exactly one reviewed${hex} controller before its export admission check`);
      const blocked = await page.evaluate(async value => {
        try { await window.mnsg.exportPatch(value); return { accepted: true }; }
        catch (error) { return { accepted: false, diagnostic: error.message }; }
      }, exportProject);
      assert.equal(blocked.accepted, false, `Foreign House${hex} controller must fail the unresolved dependency gate`);
      assert(blocked.diagnostic.includes(`Actor0x${hex} has an unresolved resource dependency path for the edited or destination-room context: ${reason}`), blocked.diagnostic);
      assert.equal(fingerprint((await page.evaluate(() => window.mnsg.getStatus())).project), fingerprint(exportProject), "Rejected export must preserve the complete project");
      await record(`native clone export rejects unresolved${hex} controller`, { roomId: cloneId, actor: blockedControllers[0], diagnostic: blocked.diagnostic });

      // Use the actual outliner and inspector, not a project replacement API.
      await room(cloneId);
      await page.locator("#actors-tab").click();
      await page.getByLabel("Search records", { exact: true }).fill(hex);
      const controllerRows = page.getByTestId("actor-list").getByRole("button");
      assert.equal(await controllerRows.count(), 1, `Search${hex} must isolate the reviewed controller placement`);
      await controllerRows.click();
      assert.equal(await field("Actor prototype").inputValue(), blockedControllers[0].prototypeId);
      await button("Remove actor", inspector()).click(); await idle();
      const expected = structuredClone(exportProject);
      expected.authoredRooms[cloneId].actors = expected.authoredRooms[cloneId].actors.filter(actor => actor.id !== blockedControllers[0].id);
      exportProject = await saved();
      assert.equal(fingerprint(exportProject), fingerprint(expected), `Reviewed removal must change only the one cloned${hex} actor`);
      await page.getByLabel("Search records", { exact: true }).fill("");
      await record(`reviewed${hex} removal through inspector preserves remaining authored graph`, { roomId: cloneId, removedActorId: blockedControllers[0].id, actorId, remainingActors: exportProject.authoredRooms[cloneId].actors.length });
    }

    await app.evaluate((_electron, value) => globalThis.__authoringSmoke.save.push(value), bundlePath);
    const exported = await page.evaluate(value => window.mnsg.exportPatch(value), exportProject);
    assert.equal(exported.kind, "patch");
    assert(exported.outputPaths.some(file => file.endsWith(".c")) && exported.outputPaths.some(file => file.endsWith(".h")));
    assert(exported.roomIds.includes(blankId) && exported.roomIds.includes(cloneId));
    for (const file of exported.outputPaths) assert((await stat(file)).size > 0);
    const sources = await Promise.all(exported.outputPaths.filter(file => /\.(c|h|json)$/.test(file)).map(file => readFile(file, "utf8")));
    assert(sources.join("\n").includes(String(blankId)) && sources.join("\n").includes(String(cloneId)));
    assert(exported.changes.some(change => /doors/.test(change)));
    await record("authored C/H export", { outputPaths: exported.outputPaths, roomIds: exported.roomIds, changes: exported.changes, warnings: exported.warnings });
    if (env.MNSG_TEST_TEMPLATE) {
      await app.evaluate((_electron, value) => globalThis.__authoringSmoke.open.push([value]), env.MNSG_TEST_TEMPLATE);
      const tools = await page.evaluate(() => window.mnsg.configureToolchain());
      assert(tools.ready, JSON.stringify(tools));
      const nrmPath = path.join(artifacts, "authoring.nrm");
      await app.evaluate((_electron, value) => globalThis.__authoringSmoke.save.push(value), nrmPath);
      const built = await page.evaluate(value => window.mnsg.exportNrm(value), exportProject);
      assert.equal(built.kind, "nrm"); assert((await stat(nrmPath)).size > 0);
      await writeFile(path.join(artifacts, "authoring-nrm-build.log"), built.buildLog ?? "");
      await record("authored NRM compile/link only", { outputPaths: built.outputPaths, roomIds: built.roomIds, changes: built.changes, bytes: (await stat(nrmPath)).size });
    } else report.nrm = "Not requested; set MNSG_TEST_TEMPLATE for optional compile/link verification.";
  }
  assert.equal(hash(await readFile(romPath)), sourceHash, "ROM source must stay unchanged");
  assert.deepEqual(diagnostics.pageErrors, [], "Authoring must not introduce renderer exceptions");
  const security = await app.evaluate(() => {
    const options = globalThis.__authoringSmoke.windows[0].webContents.getLastWebPreferences();
    return { sandbox: options.sandbox, contextIsolation: options.contextIsolation, nodeIntegration: options.nodeIntegration };
  });
  assert.deepEqual(security, { sandbox: true, contextIsolation: true, nodeIntegration: false });
  report.status = uiOnly ? "editor-passed-export-pending" : "passed";
  report.security = security; report.sourceROMUnchanged = true;
} catch (error) {
  report.status = "failed"; report.error = error.stack ?? String(error);
  if (page && !page.isClosed()) {
    report.failureForms = await page.evaluate(() => {
      const inspector = document.querySelector('[data-testid="authoring-inspector"]');
      if (!inspector) return { inspectorPresent: false };
      return {
        inspectorPresent: true,
        scrollTop: inspector.scrollTop,
        scrollHeight: inspector.scrollHeight,
        clientHeight: inspector.clientHeight,
        fields: [...inspector.querySelectorAll("input, select, textarea")].map(control => ({
          tag: control.tagName,
          id: control.id,
          name: control.getAttribute("name"),
          ariaLabel: control.getAttribute("aria-label"),
          labels: [...(control.labels ?? [])].map(label => label.textContent?.trim().slice(0, 500)),
          value: control.value,
          disabled: control.disabled,
          visible: control.getClientRects().length > 0,
          options: control.tagName === "SELECT" ? [...control.options].map(option => ({
            value: option.value,
            text: option.text,
            selected: option.selected,
          })) : undefined,
        })),
      };
    }).catch(error => ({ unavailable: error.message }));
    await page.screenshot({ path: path.join(artifacts, "failure.png"), fullPage: true }).catch(() => {});
  }
  throw error;
} finally {
  report.diagnostics = { ...diagnostics, native: await app.evaluate(() => ({ rendererGone: globalThis.__authoringSmoke.rendererGone, childGone: globalThis.__authoringSmoke.childGone })).catch(error => ({ unavailable: error.message })) };
  await writeFile(path.join(artifacts, "authoring-checks.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    status: report.status,
    artifacts,
    reportPath: path.join(artifacts, "authoring-checks.json"),
    milestones: report.milestones.map(milestone => milestone.name),
    error: report.error?.split("\n")[0],
    pageErrors: diagnostics.pageErrors.length,
    consoleErrors: diagnostics.console.filter(message => message.type === "error").length,
    native: report.diagnostics.native,
  }, null, 2));
  await app.close();
}
