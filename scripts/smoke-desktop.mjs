import { _electron as electron } from "playwright";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkTexturedRooms } from "./smoke-textures.mjs";
import { checkCameraNavigation, cameraState, settlePose, snapshot } from "./smoke-camera.mjs";
import * as THREE from "three";

async function checkActorPreview(page, artifacts, projectPath) {
  if (await page.evaluate(() => typeof window.mnsg.loadActorVisuals) !== "function") return { skipped: "Actor visual bridge is absent from this camera-only build." };
  const before = JSON.parse(await readFile(projectPath, "utf8"));
  const fixture = await page.evaluate(async () => {
    const room = await window.mnsg.loadRoom(465);
    const payload = await window.mnsg.loadActorVisuals(465, {});
    const actor = room.actors.find(actor => actor.actorId === 0x2d3);
    const selector = room.actors.find(actor => actor.actorId === 0x256);
    const visual = payload.actorVisuals.find(visual => visual.actorRef === actor?.id);
    const uncertainDeclaration = visual?.status === "conditional" || (visual?.status === "unsupported" && visual.warnings.some(warning => /conditional|scene state/.test(warning)));
    if (!actor || !selector || !uncertainDeclaration || visual.parts.length < 2) throw new Error("House uncertain native body/shadow fixture is absent.");
    return { room, payload, actor, selector, visual };
  });
  await page.locator('[data-testid="room-button"][data-room-id="465"]').click();
  const host = page.getByTestId("viewport-canvas");
  const canvas = page.getByTestId("viewport-navigation-canvas");
  const list = page.getByTestId("actor-list");
  const ready = () => page.waitForFunction(() => {
    const summary = document.querySelector('[data-testid="actor-preview-summary"]')?.textContent ?? "";
    return /native models/.test(summary) && !/Refreshing|Reading/.test(summary);
  });
  await ready();
  const coverage = await host.evaluate(element => ({ models: Number(element.dataset.actorModelCount), conditional: Number(element.dataset.actorConditionalCount), partial: Number(element.dataset.actorPartialCount), parts: Number(element.dataset.actorModelPartCount), texturedTriangles: Number(element.dataset.actorTexturedTriangles) }));
  assert(coverage.models >= 3 && coverage.conditional + coverage.partial >= 2 && coverage.parts >= 5 && coverage.texturedTriangles > 0, "House must display accepted uncertain native body and shadow parts with actual textured surfaces");
  await list.locator(".record-item").nth(fixture.actor.index).click();
  await page.getByTestId("actor-visual-status").filter({ hasText: fixture.visual.status === "conditional" ? "Conditional native model declaration" : "Partial native model preview" }).waitFor();
  await page.getByRole("button", { name: "Frame selected record", exact: true }).click();
  const framed = await settlePose(page, host);
  assert(Math.abs(framed.target[1] - fixture.actor.position.y) > 1, "Framing must target actual model bounds rather than the actor origin");
  // Native initial declarations can be occluded by a room floor. Inspect them
  // with the real Geometry view toggle; retain constructor offsets and camera.
  // Keep canvas focus neutral before comparison: focus changes its HTML border.
  await page.locator(".inspector-content .vector-fields").first().locator("input").first().focus();
  const geometry = page.getByRole("button", { name: "Geometry", exact: true });
  assert.equal(await geometry.getAttribute("aria-pressed"), "true", "Room geometry must be visible by default");
  const geometryBefore = await snapshot(page, canvas, path.join(artifacts, "actor-house-geometry-on-canvas.png"));
  await geometry.click();
  const geometryHidden = await snapshot(page, canvas, path.join(artifacts, "actor-house-geometry-off-canvas.png"));
  assert.notEqual(geometryHidden.sha256, geometryBefore.sha256, "Geometry toggle must visibly hide occluding room surfaces");
  const pose = await cameraState(host);
  assert.deepEqual(pose, framed, "Hiding geometry must preserve the actual camera position and target");
  await geometry.click();
  const geometryRestored = await snapshot(page, canvas, path.join(artifacts, "actor-house-geometry-restored-canvas.png"));
  assert.equal(geometryRestored.sha256, geometryBefore.sha256, "Showing geometry must restore the settled room pixels exactly");
  await geometry.click();
  const textured = await snapshot(page, canvas, path.join(artifacts, "actor-house-textured-canvas.png"));
  await page.screenshot({ path: path.join(artifacts, "actor-house-conditional.png"), fullPage: true });
  const textures = page.getByTestId("textures-toggle");
  assert.equal(await textures.getAttribute("aria-pressed"), "true");
  await textures.click();
  const solid = await snapshot(page, canvas, path.join(artifacts, "actor-house-solid-canvas.png"));
  assert.notEqual(solid.sha256, textured.sha256, "Native actor framing must visibly respond to the real textures toggle");
  await textures.click();
  const restored = await snapshot(page, canvas, path.join(artifacts, "actor-house-restored-canvas.png"));
  assert.equal(restored.sha256, textured.sha256, "Texture restoration must preserve the settled actor scene exactly");
  const actors = page.getByRole("button", { name: "Actors", exact: true });
  await actors.click();
  const hidden = await snapshot(page, canvas, path.join(artifacts, "actor-house-hidden-canvas.png"));
  assert.notEqual(hidden.sha256, textured.sha256, "Hiding actors must visibly remove the actual model surfaces");
  await actors.click();
  const shown = await snapshot(page, canvas, path.join(artifacts, "actor-house-shown-canvas.png"));
  assert.equal(shown.sha256, textured.sha256, "Showing actors must restore the settled native model scene exactly");

  // The sliding door is another native actor, so Geometry must leave it
  // visible. Orbit around it before picking the NPC behind it; production
  // raycasting must continue selecting the closest visible actor surface.
  const orbitBox = await canvas.boundingBox();
  assert(orbitBox);
  const orbitStart = { x: orbitBox.x + orbitBox.width * 0.45, y: orbitBox.y + orbitBox.height * 0.45 };
  await page.mouse.move(orbitStart.x, orbitStart.y); await page.mouse.down({ button: "left" });
  await page.mouse.move(orbitStart.x + orbitBox.height * 0.38, orbitStart.y, { steps: 16 });
  await page.mouse.up({ button: "left" });
  const pickingPose = await settlePose(page, host);
  assert.deepEqual(pickingPose.target, pose.target, "Orbiting around an occluding actor must preserve the model-bound target");
  await page.locator(".inspector-content .vector-fields").first().locator("input").first().focus();
  const unobstructed = await snapshot(page, canvas, path.join(artifacts, "actor-house-unobstructed-canvas.png"));
  const unobstructedImage = path.join(artifacts, "actor-house-unobstructed.png");
  await page.screenshot({ path: unobstructedImage, fullPage: true });

  // Project decoded triangle centroids, then use a real pointer click. A hit far
  // from the actor origin demonstrates recursive surface picking, not markers.
  const box = await canvas.boundingBox();
  assert(box);
  const camera = new THREE.PerspectiveCamera(42, box.width / box.height, 0.5, 250000);
  camera.position.fromArray(pickingPose.position); camera.lookAt(new THREE.Vector3().fromArray(pickingPose.target)); camera.updateMatrixWorld();
  const origin = new THREE.Vector3(fixture.actor.position.x, fixture.actor.position.y, fixture.actor.position.z).project(camera);
  const candidates = [];
  for (const part of fixture.visual.parts) {
    if (Object.values(part.billboardAxes).some(Boolean)) continue;
    const model = fixture.payload.actorModels.find(model => model.id === part.assetId);
    const rotation = { ...fixture.actor.rotation, ...part.rotationOverrides };
    const angle = axis => rotation[axis] === -32768 ? 0 : (rotation[axis] & 1023) * Math.PI * 2 / 1024;
    const root = new THREE.Matrix4().makeTranslation(fixture.actor.position.x + part.positionOffset.x, fixture.actor.position.y + part.positionOffset.y, fixture.actor.position.z + part.positionOffset.z)
      .multiply(new THREE.Matrix4().makeRotationZ(angle("z"))).multiply(new THREE.Matrix4().makeRotationY(angle("y"))).multiply(new THREE.Matrix4().makeRotationX(angle("x")))
      .multiply(new THREE.Matrix4().fromArray(part.rootMatrix));
    const nodes = [];
    model.nodes.forEach((node, index) => {
      if (Object.values(node.billboardAxes ?? {}).some(Boolean)) throw new Error("Picking fixture must not depend on camera-aligned bones.");
      nodes[index] = (node.parentIndex === null ? root : nodes[node.parentIndex]).clone().multiply(new THREE.Matrix4().fromArray(node.matrix));
      for (const meshIndex of node.meshIndices) {
        const mesh = model.meshes[meshIndex];
        for (let triangle = 0; triangle < mesh.indices.length; triangle += 3) {
          const points = mesh.indices.slice(triangle, triangle + 3).map(vertex => new THREE.Vector3().fromArray(mesh.positions, vertex * 3).applyMatrix4(nodes[index]).project(camera));
          const center = points.reduce((sum, point) => sum.add(point), new THREE.Vector3()).divideScalar(3);
          if (Math.abs(center.x) > 0.9 || Math.abs(center.y) > 0.9 || center.z < -1 || center.z > 1) continue;
          const distanceFromOrigin = Math.hypot((center.x - origin.x) * box.width / 2, (center.y - origin.y) * box.height / 2);
          if (distanceFromOrigin < 25) continue;
          const area = Math.abs((points[1].x-points[0].x)*(points[2].y-points[0].y)-(points[1].y-points[0].y)*(points[2].x-points[0].x));
          candidates.push({ x: box.x + (center.x + 1) * box.width / 2, y: box.y + (1 - center.y) * box.height / 2, area, distanceFromOrigin });
        }
      }
    });
  }
  candidates.sort((a, b) => b.area - a.area);
  assert(candidates.length, "Decoded actor surfaces must produce a visible picking fixture away from the origin");
  await list.locator(".record-item").nth(fixture.selector.index).click();
  let picked;
  const pickingAttempts = [];
  for (const candidate of candidates.slice(0, 24)) {
    await page.mouse.click(candidate.x, candidate.y);
    await page.waitForTimeout(75);
    const inspector = await page.locator(".inspector-content").count() ? await page.locator(".inspector-content").innerText() : "No record selected";
    pickingAttempts.push({ ...candidate, selectedRecord: inspector.match(/Record \d{3}[^\n]*/)?.[0] ?? inspector });
    if (inspector.includes(`Record ${String(fixture.actor.index).padStart(3, "0")}`)) { picked = candidate; break; }
  }
  await writeFile(path.join(artifacts, "actor-picking-checks.json"), JSON.stringify({ pickingPose, actorRef: fixture.actor.id, candidateCount: candidates.length, pickingAttempts }, null, 2));
  assert(picked, "A real native model triangle click must recursively select its actor record");

  await list.locator(".record-item").nth(fixture.selector.index).click();
  await page.getByRole("button", { name: "Frame selected record", exact: true }).click();
  await settlePose(page, host);
  const selectorBefore = await snapshot(page, canvas, path.join(artifacts, "actor-selector-slot0-canvas.png"));
  const parameters = [...fixture.selector.parameters]; parameters[0] = ((parameters[0] & 0x00ffffff) | 0x01000000) >>> 0;
  const parameterInput = page.getByLabel("Parameters · 3 unsigned words", { exact: true });
  await parameterInput.fill(parameters.map(value => `0x${value.toString(16)}`).join(", "));
  await parameterInput.press("Enter");
  await page.locator(".dirty-state").waitFor();
  await ready();
  const selectorAfter = await snapshot(page, canvas, path.join(artifacts, "actor-selector-slot1-canvas.png"));
  assert.notEqual(selectorAfter.sha256, selectorBefore.sha256, "An inspector parameter edit must refresh the displayed native model");
  await page.screenshot({ path: path.join(artifacts, "actor-selector-slot1.png"), fullPage: true });
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await page.locator(".dirty-state").waitFor({ state: "hidden" }); await ready();
  const selectorUndo = await snapshot(page, canvas, path.join(artifacts, "actor-selector-undo-canvas.png"));
  assert.equal(selectorUndo.sha256, selectorBefore.sha256, "Undo must restore the native selector model and pixels");
  await geometry.click();
  assert.equal(await geometry.getAttribute("aria-pressed"), "true", "Restore the default Geometry visibility after actor inspection");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("status").filter({ hasText: `Saved ${path.basename(projectPath)}` }).waitFor();
  const after = JSON.parse(await readFile(projectPath, "utf8"));
  assert.deepEqual(after, { ...before, updatedAt: after.updatedAt }, "Actor preview toggles, picking and undone parameter editing must preserve the complete saved project apart from its save timestamp");
  const result = { roomId: 465, actorRef: fixture.actor.id, status: fixture.visual.status, coverage, modelBoundsFraming: framed, cameraPreservedWhileGeometryHidden: pose, geometryBefore, geometryHidden, geometryRestored, pickingPose, unobstructed, unobstructedImage, picked, textured, solid, restored, hidden, shown, selectorBefore, selectorAfter, selectorUndo, savedEditsPreserved: true };
  await writeFile(path.join(artifacts, "actor-preview-checks.json"), JSON.stringify(result, null, 2));
  return result;
}

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
  if (process.env.MNSG_TEST_BACKGROUND === "1") {
    // Test-only focus emulation lets a hidden native window exercise its real
    // document.hasFocus guard without taking focus from the user's application.
    const focusSession = await page.context().newCDPSession(page);
    await focusSession.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  }
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
  const actorVisualBridge = await page.evaluate(async ({ fixture, roomId }) => {
    if (typeof window.mnsg.loadActorVisuals !== "function") return { skipped: "Actor visual bridge is absent from this camera-only build." };
    const native = await window.mnsg.loadRoom(roomId);
    const beforeProject = JSON.stringify((await window.mnsg.getStatus()).project);
    const actorKey = fixture.actor.id;
    const one = (override) => ({ [actorKey]: override });
    const checks = {
      nullMap: null,
      arrayMap: [],
      dateMap: new Date(),
      unknownActor: { "actor:forged-record": {} },
      unknownPointerField: one({ modelPointer: 0x80100000 }),
      unknownPathField: one({ templatePath: "/untrusted/renderer/path" }),
      negativeActorSentinel: one({ actorId: -1 }),
      unsignedActorSentinel: one({ actorId: 0xffffffff }),
      negativeParameter: one({ parameters: [-1, 0, 0] }),
      parameterOverflow: one({ parameters: [0x100000000, 0, 0] }),
      parameterCount: one({ parameters: [0, 0] }),
      coordinateOverflow: one({ position: { ...fixture.actor.position, x: 32768 } }),
      nonfinitePosition: one({ position: { ...fixture.actor.position, x: Number.NaN } }),
      rotationOverflow: one({ rotation: { ...fixture.actor.rotation, x: 32768 } }),
      byteBudget: one({ ignored: "x".repeat(1024 * 1024 + 64) }),
      actorCount: Object.fromEntries(Array.from({ length: native.actors.length + 1 }, (_, index) => [`actor:fake-${index}`, {}])),
    };
    const rejected = {};
    for (const [name, overrides] of Object.entries(checks)) {
      try { await window.mnsg.loadActorVisuals(roomId, overrides); rejected[name] = false; } catch { rejected[name] = true; }
    }
    for (const id of [-1, 800, 0.5, "0"]) {
      try { await window.mnsg.loadActorVisuals(id, {}); rejected[`room-${id}`] = false; } catch { rejected[`room-${id}`] = true; }
    }
    const valid = await window.mnsg.loadActorVisuals(roomId, one({ actorId: fixture.actor.actorId, position: fixture.actor.position, rotation: fixture.actor.rotation, parameters: fixture.actor.parameters }));
    if (!Array.isArray(valid.actorVisuals) || !Array.isArray(valid.actorModels)) throw new Error("Native actor preview bridge returned an invalid payload.");
    const modelIds = new Set(valid.actorModels.map((model) => model.id));
    if (modelIds.size !== valid.actorModels.length) throw new Error("Actor preview models must be deduplicated.");
    for (const visual of valid.actorVisuals) {
      if (!native.actors.some((actor) => actor.id === visual.actorRef)) throw new Error("Actor preview must reference a native actor record.");
      for (const part of visual.parts) if (!modelIds.has(part.assetId)) throw new Error("Actor preview references a missing model asset.");
    }
    const house = await window.mnsg.loadRoom(465);
    const selectorActor = house.actors.find((actor) => actor.actorId === 0x256);
    if (!selectorActor) throw new Error("House actor 0x256 selector fixture is absent.");
    const refreshed = [];
    for (const selector of [0, 1]) {
      const parameters = [...selectorActor.parameters];
      parameters[0] = ((parameters[0] & 0x00ffffff) | (selector << 24)) >>> 0;
      const payload = await window.mnsg.loadActorVisuals(465, { [selectorActor.id]: { parameters } });
      const visual = payload.actorVisuals.find((entry) => entry.actorRef === selectorActor.id);
      if (!visual || visual.status !== "supported" || !visual.parts.some((part) => part.provenance.slot === selector)) throw new Error(`House parameter selector ${selector} did not refresh its verified native model slot.`);
      refreshed.push({ selector, actorRef: selectorActor.id, parts: visual.parts.map((part) => ({ assetId: part.assetId, slot: part.provenance.slot, modelPointer: part.provenance.modelPointer })) });
    }
    if (JSON.stringify(refreshed[0].parts) === JSON.stringify(refreshed[1].parts)) throw new Error("Parameter-selected actor visuals did not change between native slots.");
    const unchanged = beforeProject === JSON.stringify((await window.mnsg.getStatus()).project);
    return { rejected, unchanged, validActorCount: valid.actorVisuals.length, validModelCount: valid.actorModels.length, parameterSelectedRefresh: refreshed };
  }, { fixture, roomId: fixture.roomId });
  await writeFile(path.join(temporary, "actor-visual-bridge-checks.json"), JSON.stringify(actorVisualBridge, null, 2));
  if (!actorVisualBridge.skipped) {
    assert(Object.values(actorVisualBridge.rejected).every(Boolean), `Actor visual bridge accepted malformed input: ${JSON.stringify(actorVisualBridge.rejected)}`);
    assert.equal(actorVisualBridge.unchanged, true, "Actor preview validation must not replace the persisted project");
  }
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
  const camera = await checkCameraNavigation(page, temporary, { projectPath });
  const actorPreview = await checkActorPreview(page, temporary, projectPath);
  await page.locator(`[data-testid="room-button"][data-room-id="${fixture.roomId}"]`).click();
  await page.getByTestId("actor-list").locator(".record-item").nth(fixture.actor.index).click();
  await page.waitForTimeout(500);
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
  summary = { status: "passed", temporary, screenshotPath, geometryScreenshotPath, projectPath, roomCount: catalog.length, testedRoomId: fixture.roomId, actorId: fixture.actor.id, actorVisualBridge, actorPreview, geometry: { roomId: geometryRoomId, translation: geometryTranslation, saveReopen: "passed", rejections: geometryRejections }, textures, camera, patchFiles, nrm, isolation, canvas, nativeUnsavedClose: "passed", inspectorEscapeEnter: "passed" };
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
