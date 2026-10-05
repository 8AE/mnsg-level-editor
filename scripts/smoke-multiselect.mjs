import { _electron as electron } from "playwright";
import assert from "node:assert/strict";
import * as THREE from "three";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Actual editor windows, one disposable profile, and the user's own ROM. No game
// execution, normal user projects, packaged-app installation, or generated mods.
const rom = process.env.MNSG_TEST_ROM;
if (!rom) throw new Error("Set MNSG_TEST_ROM to your own US MNSG ROM.");
const artifacts = await realpath(
  await mkdtemp(path.join(tmpdir(), "mnsg-multiselect-")),
);
const profile = path.join(artifacts, "profile"),
  projectPath = path.join(artifacts, "workspace.mnsgproj");
await mkdir(profile);
const wrapper = path.join(artifacts, "launch.cjs");
await writeFile(
  wrapper,
  `
const {app,dialog}=require('electron');
app.setPath('userData',${JSON.stringify(profile)});
globalThis.__workspaceSmoke={open:[],save:[],gone:[]};
app.on('browser-window-created',(_e,w)=>w.webContents.on('render-process-gone',(_e,d)=>globalThis.__workspaceSmoke.gone.push(d)));
dialog.showOpenDialog=async()=>({canceled:false,filePaths:globalThis.__workspaceSmoke.open.shift()||[]});
dialog.showSaveDialog=async()=>({canceled:false,filePath:globalThis.__workspaceSmoke.save.shift()});
dialog.showMessageBoxSync=()=>1;
require(${JSON.stringify(path.resolve("dist-electron/main.cjs"))});
`,
);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.MNSG_DEV_URL;
const app = await electron.launch({ args: [wrapper], env, timeout: 30000 });
const report = { artifacts, milestones: [], errors: [], dialogs: [] };
function observe(page) {
  page.on("pageerror", (e) => report.errors.push(e.message));
  page.on("dialog", (dialog) => {
    void dialog.accept().catch((error) => {
      if (/No dialog is showing/.test(error.message))
        report.dialogs.push(
          "Native beforeunload completed before CDP acceptance",
        );
      else report.errors.push(error.message);
    });
  });
}
let main;
const button = (page, name) =>
  page.getByRole("button", { name, exact: true }).filter({ visible: true });
const record = async (name) => {
  report.milestones.push(name);
  console.log(`PASS ${name}`);
  await writeFile(
    path.join(artifacts, "multiselect.json"),
    JSON.stringify(report, null, 2),
  );
};
try {
  main = await app.firstWindow();
  main.setDefaultTimeout(30000);
  observe(main);
  await main.waitForFunction(() => Boolean(window.mnsg));
  await app.evaluate(
    (_e, p) => globalThis.__workspaceSmoke.open.push([p]),
    rom,
  );
  await button(main, "Choose US ROM").click();
  await main
    .locator('[data-testid="room-button"][data-room-id="465"]')
    .waitFor({ timeout: 120000 });
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((w) => !w.getParentWindow())
      .setSize(1440, 960),
  );
  await main.locator('[data-testid="room-button"][data-room-id="465"]').click();
  await main.locator(".viewport-loading").waitFor({ state: "hidden" });
  const idle = async () => {
    await button(main, "Save").waitFor();
    await main.waitForFunction(() => !document.querySelector(".busy-state"));
    await main.locator(".viewport-loading").waitFor({ state: "hidden" });
    await main.waitForFunction(
      () =>
        !document.querySelector(
          '.app-toolbar button[disabled][aria-label="Project and build settings"]',
        ),
    );
  };
  let savedOnce = false;
  async function save() {
    await idle();
    if (!savedOnce) {
      await app.evaluate(
        (_e, p) => globalThis.__workspaceSmoke.save.push(p),
        projectPath,
      );
      savedOnce = true;
    }
    await button(main, "Save").click();
    await main
      .locator(".status-bar [role=status]")
      .filter({ hasText: `Saved ${path.basename(projectPath)}` })
      .waitFor();
    await main.locator(".dirty-state").waitFor({ state: "hidden" });
    return JSON.parse(await readFile(projectPath, "utf8"));
  }
  const initial = await save();
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  const shortcut = process.platform === "darwin" ? "Meta" : "Control";
  const host = () => main.getByTestId("viewport-canvas");
  const selected = async (scope) =>
    JSON.parse(
      await scope
        .getByTestId("viewport-canvas")
        .getAttribute("data-selection-choices"),
    );
  const count = async (scope, n) =>
    scope.waitForFunction(
      (n) =>
        Number(
          document.querySelector('[data-testid="viewport-canvas"]')?.dataset
            .selectionCount,
        ) === n,
      n,
    );
  const apply = async (x, y, z) => {
    for (const [axis, value] of [
      ["X", x],
      ["Y", y],
      ["Z", z],
    ])
      await main
        .getByLabel(`Move selection ${axis}`, { exact: true })
        .fill(String(value));
    await button(main, "Apply selection offset").click();
    await idle();
  };
  const equalPosition = (next, original, delta) =>
    assert.deepEqual(next, {
      x: original.x + delta.x,
      y: original.y + delta.y,
      z: original.z + delta.z,
    });
  let historyScope = main;
  const undo = async () => {
    await button(historyScope, "Undo").click();
    await idle();
  };
  // Native placements retain their original admission/partition restrictions.
  const native = await main.evaluate(async () => window.mnsg.loadRoom(465));
  const editable = native.actors
    .filter((a) => a.editable && a.sourceKind !== "partition")
    .slice(0, 2);
  assert.equal(editable.length, 2);
  await main.locator(`[data-record-id="${editable[0].id}"]`).click();
  await main
    .locator(`[data-record-id="${editable[1].id}"]`)
    .click({ modifiers: [modifier] });
  await count(main, 2);
  assert.equal(await main.locator(".record-item.is-selected").count(), 2);
  await apply(2, 3, -1);
  let graph = await save();
  for (const actor of editable)
    equalPosition(
      graph.roomOverrides[465].actors[actor.id].position,
      actor.position,
      { x: 2, y: 3, z: -1 },
    );
  await undo();
  assert.deepEqual((await save()).roomOverrides, initial.roomOverrides);
  await record(
    "native actor modifier selection moves together and one Undo restores both",
  );
  // A controlled portable fixture gives adjacent faces shared by four vertices.
  await main.getByRole("tab", { name: "Geometry", exact: true }).click();
  await button(main, "Make editable copy").click();
  await idle();
  graph = await save();
  const authored = graph.authoredRooms[465],
    materialId = authored.materials[0].id;
  const v = (x, z) => ({
    position: { x, y: 0, z },
    uv: [x / 200, z / 200],
    color: [255, 255, 255, 255],
  });
  authored.meshes = [
    {
      id: "selection-quad",
      materialId,
      vertices: [v(-100, -100), v(100, -100), v(100, 100), v(-100, 100)],
      indices: [0, 2, 1, 0, 3, 2],
    },
    {
      id: "selection-other",
      materialId,
      vertices: [v(300, -100), v(500, -100), v(500, 100), v(300, 100)],
      indices: [0, 2, 1, 0, 3, 2],
    },
  ];
  const fixturePath = path.join(artifacts, "shared-faces.mnsgproj");
  await writeFile(fixturePath, JSON.stringify(graph));
  await app.evaluate(
    (_e, p) => globalThis.__workspaceSmoke.open.push([p]),
    fixturePath,
  );
  await button(main, "Open").click();
  await idle();
  // The opened document already has a path, so save() follows that path below.
  const readGraph = async () => JSON.parse(await readFile(fixturePath, "utf8"));
  const savedFixture = async () => {
    await button(main, "Save").click();
    await main.locator(".dirty-state").waitFor({ state: "hidden" });
    await idle();
    return readGraph();
  };
  const scene = main.getByTestId("workspace-panel-scene");
  for (const name of ["Actors", "Events"]) {
    const toggle = button(scene, name);
    if ((await toggle.getAttribute("aria-pressed")) === "true")
      await toggle.click();
  }
  const quad = () => main.locator('[data-mesh-id="selection-quad"]');
  const other = () => main.locator('[data-mesh-id="selection-other"]');
  await main.getByRole("tab", { name: "Geometry", exact: true }).click();
  await quad().click();
  await other().click({ modifiers: [modifier] });
  await count(main, 2);
  assert.equal(
    Number(await host().getAttribute("data-selection-outline-count")),
    2,
  );
  const baseline = structuredClone(graph);
  await apply(9, -5, 3);
  let moved = await savedFixture();
  for (let m = 0; m < 2; m++)
    for (let i = 0; i < 4; i++)
      equalPosition(
        moved.authoredRooms[465].meshes[m].vertices[i].position,
        baseline.authoredRooms[465].meshes[m].vertices[i].position,
        { x: 9, y: -5, z: 3 },
      );
  assert.deepEqual(
    moved.authoredRooms[465].actors,
    baseline.authoredRooms[465].actors,
  );
  assert.deepEqual(
    moved.authoredRooms[465].collision,
    baseline.authoredRooms[465].collision,
  );
  await undo();
  assert.deepEqual(
    (await savedFixture()).authoredRooms,
    baseline.authoredRooms,
  );
  await record(
    "two outlined meshes move by one shared offset without changing template physics",
  );
  await other().click({ modifiers: [modifier] });
  await count(main, 1);
  await other().click();
  await count(main, 1);
  assert.equal((await selected(main))[0].choice.meshId, "selection-other");
  await quad().click();
  // Project native camera coordinates to actual screen points; clicks use the real raycaster.
  async function point(scope, position) {
    const canvas = scope.getByTestId("viewport-navigation-canvas"),
      box = await canvas.boundingBox();
    const data = await scope.getByTestId("viewport-canvas").evaluate((el) => ({
      position: el.dataset.cameraPosition,
      target: el.dataset.cameraTarget,
    }));
    const camera = new THREE.PerspectiveCamera(
      42,
      box.width / box.height,
      0.5,
      250000,
    );
    camera.position.fromArray(data.position.split(",").map(Number));
    camera.lookAt(
      new THREE.Vector3().fromArray(data.target.split(",").map(Number)),
    );
    camera.updateMatrixWorld();
    const projected = new THREE.Vector3(
      position.x,
      position.y,
      position.z,
    ).project(camera);
    return {
      x: box.x + ((projected.x + 1) * box.width) / 2,
      y: box.y + ((1 - projected.y) * box.height) / 2,
      camera,
    };
  }
  async function faceGroup() {
    await main.getByRole("tab", { name: "Geometry", exact: true }).click();
    await quad().click();
    await button(main, "face").click();
    await button(main.getByTestId("authoring-inspector"), "Frame").click();
    await main.evaluate(
      () =>
        new Promise((r) =>
          requestAnimationFrame(() => requestAnimationFrame(r)),
        ),
    );
    const first = await point(main, { x: 100 / 3, y: 0, z: -100 / 3 });
    const second = await point(main, { x: -100 / 3, y: 0, z: 100 / 3 });
    await main.mouse.click(first.x, first.y);
    await main.keyboard.down(modifier);
    await main.mouse.click(second.x, second.y);
    await main.keyboard.up(modifier);
    await count(main, 2);
    assert.deepEqual(
      (await selected(main)).map((v) => [
        v.choice.meshId,
        v.choice.mode,
        v.choice.faceIndex,
      ]),
      [
        ["selection-quad", "face", 0],
        ["selection-quad", "face", 1],
      ],
    );
  }
  await faceGroup();
  assert.equal(
    Number(await host().getAttribute("data-selection-outline-count")),
    2,
  );
  await apply(0, 0, 14);
  moved = await savedFixture();
  for (let i = 0; i < 4; i++)
    equalPosition(
      moved.authoredRooms[465].meshes[0].vertices[i].position,
      baseline.authoredRooms[465].meshes[0].vertices[i].position,
      { x: 0, y: 0, z: 14 },
    );
  assert.deepEqual(
    moved.authoredRooms[465].meshes[0].indices,
    baseline.authoredRooms[465].meshes[0].indices,
  );
  assert.deepEqual(
    moved.authoredRooms[465].meshes[1],
    baseline.authoredRooms[465].meshes[1],
  );
  await undo();
  await savedFixture();
  await record(
    "Cmd/Ctrl-click selects actual adjacent faces; their shared vertices move once",
  );
  await quad().click();
  await button(main, "vertex").click();
  const a = await point(main, { x: -98, y: 0, z: -98 }),
    b = await point(main, { x: 98, y: 0, z: 98 });
  await main.mouse.click(a.x, a.y);
  await main.keyboard.down(modifier);
  await main.mouse.click(b.x, b.y);
  await main.keyboard.up(modifier);
  await count(main, 2);
  assert.deepEqual(
    (await selected(main)).map((v) => v.choice.vertexIndex),
    [0, 2],
  );
  await apply(0, 6, 0);
  moved = await savedFixture();
  for (let i = 0; i < 4; i++)
    equalPosition(
      moved.authoredRooms[465].meshes[0].vertices[i].position,
      baseline.authoredRooms[465].meshes[0].vertices[i].position,
      { x: 0, y: i === 0 || i === 2 ? 6 : 0, z: 0 },
    );
  await undo();
  await savedFixture();
  await record(
    "multiple outlined vertices move together while unselected vertices stay fixed",
  );
  await quad().click();
  await main.getByRole("tab", { name: /^Actors/ }).click();
  const actorId = baseline.authoredRooms[465].actors[0].id;
  await main
    .locator(`[data-record-id="${actorId}"]`)
    .click({ modifiers: [modifier] });
  await count(main, 2);
  await apply(0, 7, 0);
  moved = await savedFixture();
  equalPosition(
    moved.authoredRooms[465].actors[0].position,
    baseline.authoredRooms[465].actors[0].position,
    { x: 0, y: 7, z: 0 },
  );
  for (let i = 0; i < 4; i++)
    equalPosition(
      moved.authoredRooms[465].meshes[0].vertices[i].position,
      baseline.authoredRooms[465].meshes[0].vertices[i].position,
      { x: 0, y: 7, z: 0 },
    );
  await undo();
  await savedFixture();
  await record(
    "mixed actor and mesh selection translates atomically with a single Undo",
  );
  await faceGroup();
  await button(main, "Move selected items").click();
  assert.equal(
    await host().getAttribute("data-transform-object-id"),
    "@selection",
  );
  const waiting = app.waitForEvent("window");
  await button(main, "Pop out Scene").click();
  const child = await waiting;
  historyScope = child;
  observe(child);
  await child.getByTestId("viewport-navigation-canvas").waitFor();
  await count(child, 2);
  const nativeChild = await app.browserWindow(child);
  await nativeChild.evaluate((w) => w.setSize(900, 720));
  await child.evaluate(
    () =>
      new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
  async function grabAxis() {
    const origin = (
      await child
        .getByTestId("viewport-canvas")
        .getAttribute("data-transform-preview-position")
    )
      .split(",")
      .map(Number);
    const pivot = { x: origin[0], y: origin[1], z: origin[2] },
      projected = await point(child, pivot);
    const factor =
      (projected.camera.position.distanceTo(new THREE.Vector3(...origin)) *
        1.9 *
        Math.tan((Math.PI * 42) / 360)) /
      4;
    for (const fraction of [0.35, 0.5, 0.65, 0.8, 1]) {
      const p = await point(child, {
        ...pivot,
        x: pivot.x + factor * fraction,
      });
      await child.mouse.move(p.x, p.y);
      await child.evaluate(() => new Promise((r) => requestAnimationFrame(r)));
      if (
        (await child
          .getByTestId("viewport-canvas")
          .getAttribute("data-transform-axis")) === "X"
      )
        return { origin, p };
    }
    throw Error("No real X-axis gizmo handle could be picked");
  }
  const { origin, p } = await grabAxis();
  await child.mouse.down();
  await child.waitForFunction(
    () =>
      document.querySelector('[data-testid="viewport-canvas"]').dataset
        .transformDragging === "true",
  );
  await child.mouse.move(p.x + 35, p.y - 10, { steps: 5 });
  const end = (
    await child
      .getByTestId("viewport-canvas")
      .getAttribute("data-transform-preview-position")
  )
    .split(",")
    .map(Number);
  const delta = {
    x: Math.round(end[0] - origin[0]),
    y: Math.round(end[1] - origin[1]),
    z: Math.round(end[2] - origin[2]),
  };
  assert(delta.x !== 0);
  await child.mouse.up();
  await idle();
  moved = await savedFixture();
  for (let i = 0; i < 4; i++)
    equalPosition(
      moved.authoredRooms[465].meshes[0].vertices[i].position,
      baseline.authoredRooms[465].meshes[0].vertices[i].position,
      delta,
    );
  await undo();
  await savedFixture();
  await count(child, 2);
  // Native focus loss cancels the entire preview rather than committing part of it.
  await app.evaluate(({ app }) => app.focus({ steal: true }));
  await nativeChild.evaluate((w) => w.focus());
  await child.waitForFunction(() => document.hasFocus());
  const canceled = await grabAxis();
  await child.mouse.down();
  await child.waitForFunction(
    () =>
      document.querySelector('[data-testid="viewport-canvas"]').dataset
        .transformDragging === "true",
  );
  await child.mouse.move(canceled.p.x + 25, canceled.p.y - 8, { steps: 4 });
  const nativeMain = await app.browserWindow(main);
  await nativeMain.evaluate((w) => w.focus());
  await child.waitForFunction(() => !document.hasFocus());
  await child.waitForFunction(
    () =>
      document.querySelector('[data-testid="viewport-canvas"]').dataset
        .transformDragging === "false",
  );
  await child.mouse.up();
  assert.deepEqual(
    (await savedFixture()).authoredRooms,
    baseline.authoredRooms,
  );
  const closing = child.waitForEvent("close");
  await button(child, "Redock Scene").click();
  await closing;
  await main.getByTestId("viewport-navigation-canvas").waitFor();
  await count(main, 2);
  await main.screenshot({
    path: path.join(artifacts, "multiselect.png"),
    fullPage: true,
  });
  await record(
    "native Scene popout retains multi-selection; real gizmo drag moves both faces, Undo and blur cancellation restore all",
  );
  assert.deepEqual(report.errors, []);
  report.status = "passed";
  await writeFile(
    path.join(artifacts, "multiselect.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(`Evidence: ${artifacts}`);
} catch (error) {
  report.status = "failed";
  report.failure = error.stack;
  await writeFile(
    path.join(artifacts, "multiselect.json"),
    JSON.stringify(report, null, 2),
  );
  if (main && !main.isClosed())
    await main
      .screenshot({ path: path.join(artifacts, "failure.png"), fullPage: true })
      .catch(() => {});
  throw error;
} finally {
  await app.close();
}
