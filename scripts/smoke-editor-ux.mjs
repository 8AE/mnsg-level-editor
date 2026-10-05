import { _electron as electron } from "playwright";
import assert from "node:assert/strict";
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
  await mkdtemp(path.join(tmpdir(), "mnsg-editor-ux-")),
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
    path.join(artifacts, "editor-ux.json"),
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
  const nativeActorCount = await main.evaluate(
    async () => (await window.mnsg.loadRoom(465)).actors.length,
  );
  assert.equal(
    await main.getByText("ROM CONNECTED", { exact: true }).count(),
    0,
  );
  assert.equal(await button(main, "Library").count(), 0);
  assert.equal(
    await main
      .locator("summary")
      .filter({ hasText: /^Window$/ })
      .count(),
    0,
  );
  assert.equal(await button(main, "Close Assets").count(), 0);
  assert.equal(
    await main
      .getByTestId("authoring-library")
      .getByRole("button", { name: "Close", exact: true })
      .count(),
    0,
  );
  await button(main, "Project and build settings").click();
  await main.getByRole("button", { name: "Source ROM", exact: true }).click();
  assert(await button(main, "Change source ROM").isVisible());
  await button(main, "Close dialog").click();
  await record(
    "ROM source moved into Settings; redundant footer, Library, Close and Window menu removed",
  );
  const shortcut = process.platform === "darwin" ? "Meta" : "Control";
  const host = main.getByTestId("viewport-navigation-canvas");
  for (const [combo, panel] of [
    ["b", "rooms"],
    ["Shift+b", "inspector"],
    ["j", "assets"],
  ]) {
    await host.focus();
    await main.keyboard.press(`${shortcut}+${combo}`);
    assert(!(await main.getByTestId(`workspace-panel-${panel}`).isVisible()));
    await host.focus();
    await main.keyboard.press(`${shortcut}+${combo}`);
    assert(await main.getByTestId(`workspace-panel-${panel}`).isVisible());
  }
  const search = main.getByLabel("Search rooms");
  await search.fill("");
  await search.focus();
  await main.keyboard.press(`${shortcut}+b`);
  assert(await main.getByTestId("workspace-panel-rooms").isVisible());
  await record(
    "left, right and bottom shortcuts toggle panels and respect text fields",
  );
  await button(main, "Maximize Assets").click();
  assert(await button(main, "Restore Assets").isVisible());
  assert(!(await main.getByTestId("workspace-panel-scene").isVisible()));
  await button(main, "Restore Assets").click();
  const childWait = app.waitForEvent("window");
  await button(main, "Pop out Assets").click();
  const assets = await childWait;
  observe(assets);
  await assets.getByTestId("authoring-library").waitFor();
  await button(assets, "Redock Assets").click();
  await record("bottom tab has working inline maximize, popout and redock");
  // Read-only native meshes are selectable and copied through the existing authoring converter.
  const nativeCanvas = main.getByTestId("viewport-navigation-canvas");
  const canvasBox = await nativeCanvas.boundingBox();
  let pickedNativeMesh = false;
  for (const [x, y] of [
    [0.5, 0.5],
    [0.6, 0.5],
    [0.5, 0.65],
  ]) {
    await nativeCanvas.click({
      button: "right",
      position: { x: canvasBox.width * x, y: canvasBox.height * y },
    });
    if (
      (await main
        .getByTestId("viewport-canvas")
        .getAttribute("data-selection-outline")) === "mesh"
    ) {
      pickedNativeMesh = true;
      break;
    }
    await main.keyboard.press("Escape");
  }
  assert(
    pickedNativeMesh,
    "A native draw surface must be selectable by right-click",
  );
  await main.getByRole("menuitem", { name: /^Copy/ }).click();
  await idle();
  await main
    .locator(".status-bar [role=status]")
    .filter({ hasText: "Copied mesh." })
    .waitFor();
  await main.keyboard.press(`${shortcut}+v`);
  await idle();
  let nativeMeshGraph = await save();
  const originalMeshes = await main.evaluate(
    async () =>
      (await window.mnsg.loadRoom(465)).meshes.filter(
        (m) => m.source === "display-list",
      ).length,
  );
  assert.equal(
    nativeMeshGraph.authoredRooms[465].meshes.length,
    originalMeshes + 1,
  );
  await button(main, "Undo").click();
  await idle();
  assert(!(await save()).authoredRooms[465]);
  await record(
    "native draw-surface selection outlines and copy/paste preserve validated room conversion",
  );
  // Native actor duplication creates an editable replacement through the existing validator.
  await main.getByRole("tab", { name: /^Actors/ }).click();
  const actor = main
    .locator(".record-item")
    .filter({ hasText: "Sliding Door" })
    .first();
  await actor.click();
  await main.keyboard.press(`${shortcut}+c`);
  await main.keyboard.press(`${shortcut}+v`);
  await idle();
  let graph = await save();
  assert.equal(graph.authoredRooms[465].actors.length, nativeActorCount + 1);
  await button(main, "Undo").click();
  await idle();
  graph = await save();
  assert(!graph.authoredRooms[465]);
  await main.keyboard.press(`${shortcut}+v`);
  await idle();
  graph = await save();
  assert.equal(graph.authoredRooms[465].actors.length, nativeActorCount + 1);
  await record(
    "native actor copy/paste validates an editable replacement and Undo restores the native room",
  );
  await main.getByRole("tab", { name: "Geometry", exact: true }).click();
  const meshRow = main.locator("[data-mesh-id]").first();
  await meshRow.click();
  const meshId = await meshRow.getAttribute("data-mesh-id");
  const beforeMesh = graph.authoredRooms[465].meshes.length;
  await main.keyboard.press(`${shortcut}+c`);
  await main.keyboard.press(`${shortcut}+v`);
  await idle();
  graph = await save();
  assert.equal(graph.authoredRooms[465].meshes.length, beforeMesh + 1);
  assert.equal(
    await main
      .getByTestId("viewport-canvas")
      .getAttribute("data-selection-outline"),
    "mesh",
  );
  await button(main, "Undo").click();
  await idle();
  await meshRow.click();
  await button(main, "face").click();
  const faceBefore = (await save()).authoredRooms[465].meshes[0].indices.length;
  await main.keyboard.press(`${shortcut}+c`);
  await main.keyboard.press(`${shortcut}+v`);
  await idle();
  graph = await save();
  assert.equal(
    graph.authoredRooms[465].meshes[0].indices.length,
    faceBefore + 3,
  );
  assert.equal(
    await main
      .getByTestId("viewport-canvas")
      .getAttribute("data-selection-outline"),
    "face",
  );
  await button(main, "Undo").click();
  await idle();
  await meshRow.click();
  await button(main, "vertex").click();
  const vertexBefore = (await save()).authoredRooms[465].meshes[0].vertices
    .length;
  await main.keyboard.press(`${shortcut}+c`);
  await main.keyboard.press(`${shortcut}+v`);
  await idle();
  graph = await save();
  assert.equal(
    graph.authoredRooms[465].meshes[0].vertices.length,
    vertexBefore + 1,
  );
  assert.equal(
    await main
      .getByTestId("viewport-canvas")
      .getAttribute("data-selection-outline"),
    "vertex",
  );
  await record(
    "mesh, face and vertex copy/paste retain topology and display distinct outlines",
  );
  await button(main, "Undo").click();
  await idle();
  await meshRow.click();
  await meshRow.click({ button: "right" });
  await main.getByRole("menuitem", { name: /^Copy/ }).click();
  await meshRow.click({ button: "right" });
  await main.getByRole("menuitem", { name: /^Paste/ }).click();
  await idle();
  graph = await save();
  assert.equal(graph.authoredRooms[465].meshes.length, beforeMesh + 1);
  await record(
    "right-click geometry menu copies and pastes without browser menus",
  );
  await button(main, "Choose material").click();
  const picker = main.getByRole("dialog", {
    name: "Choose material",
    exact: true,
  });
  await picker.getByLabel("Search materials").fill("oedo");
  const tile = picker.locator(".material-tile").first();
  await tile.locator("img").waitFor({ timeout: 60000 });
  await picker.screenshot({
    path: path.join(artifacts, "material-picker.png"),
  });
  const label = await tile.innerText();
  await tile.click();
  await idle();
  assert((await button(main, "Choose material").innerText()).includes(label));
  await button(main, "Choose material").locator("img").waitFor();
  await record(
    "material popup filters a preview grid, applies a material and shows the current preview",
  );
  const inspectorWait = app.waitForEvent("window");
  await button(main, "Pop out Inspector").click();
  const inspector = await inspectorWait;
  observe(inspector);
  await inspector.getByTestId("workspace-panel-inspector").waitFor();
  await button(inspector, "Choose material").click();
  await inspector.getByLabel("Search materials").fill("not-a-material-123");
  assert(await inspector.getByText("No matching materials.").isVisible());
  await inspector.keyboard.press("Escape");
  assert(
    await button(inspector, "Choose material").evaluate(
      (node) => node.ownerDocument.activeElement === node,
    ),
  );
  await button(inspector, "mesh").click();
  await inspector.keyboard.press(`${shortcut}+c`);
  await inspector.keyboard.press(`${shortcut}+v`);
  await idle();
  assert((await save()).authoredRooms[465].meshes.length === beforeMesh + 2);
  await button(inspector, "Choose material").click();
  const inspectorNative = await app.browserWindow(inspector);
  const closed = inspector.waitForEvent("close");
  await inspectorNative.evaluate((window) => window.close());
  await closed;
  const redockedPicker = main.getByRole("dialog", {
    name: "Choose material",
    exact: true,
  });
  await redockedPicker.waitFor();
  await main.keyboard.press("Escape");
  assert(
    await button(main, "Choose material").evaluate(
      (node) => node.ownerDocument.activeElement === node,
    ),
  );
  await record(
    "material dialog focus and clipboard shortcuts work in a native Inspector popout",
  );
  assert.deepEqual(report.errors, []);
  await main.screenshot({ path: path.join(artifacts, "editor-ux.png") });
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.failure = String(error.stack || error);
  if (main && !main.isClosed()) {
    report.body = (await main.locator("body").innerText()).slice(0, 18000);
    await main
      .screenshot({ path: path.join(artifacts, "failure.png") })
      .catch(() => {});
  }
  throw error;
} finally {
  await writeFile(
    path.join(artifacts, "editor-ux.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(`Evidence: ${artifacts}`);
  await app.close();
}
