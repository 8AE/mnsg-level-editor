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
import { cameraState, settlePose } from "./smoke-camera.mjs";

// Actual editor windows, one disposable profile, and the user's own ROM. No game
// execution, normal user projects, packaged-app installation, or generated mods.
const rom = process.env.MNSG_TEST_ROM;
if (!rom) throw new Error("Set MNSG_TEST_ROM to your own US MNSG ROM.");
const artifacts = await realpath(
  await mkdtemp(path.join(tmpdir(), "mnsg-workspace-smoke-")),
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
const report = {
  artifacts,
  status: "running",
  milestones: [],
  errors: [],
  dialogs: [],
  console: [],
};
const graph = (value) => {
  const { updatedAt, ...rest } = value;
  return JSON.stringify(rest);
};
const record = async (name, evidence = {}) => {
  report.milestones.push({ name, ...evidence });
  await writeFile(
    path.join(artifacts, "workspace-checks.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(`PASS ${name}`);
};
const observe = (page) => {
  // Electron may finish native beforeunload handling before Playwright's default
  // CDP auto-accept. Own this promise so that specific completed-dialog race is
  // recorded rather than becoming an unhandled rejection. All other failures
  // remain errors; native close and working input assertions still must pass.
  page.on("dialog", (dialog) => {
    const entry = {
      type: dialog.type(),
      message: dialog.message(),
      handling: "pending",
    };
    report.dialogs.push(entry);
    const handling =
      dialog.type() === "beforeunload" ? dialog.accept() : dialog.dismiss();
    void handling
      .then(() => {
        entry.handling = "handled";
      })
      .catch((error) => {
        entry.handling = error.message;
        if (
          !(
            dialog.type() === "beforeunload" &&
            /No dialog is showing/.test(error.message)
          )
        )
          report.errors.push(error.message);
      });
  });
  page.on("pageerror", (error) => report.errors.push(error.message));
  page.on("console", (message) => {
    if (report.console.length < 200)
      report.console.push({
        type: message.type(),
        text: message.text().slice(0, 3000),
      });
  });
};
let main;
try {
  main = await app.firstWindow();
  observe(main);
  main.setDefaultTimeout(30000);
  await main.waitForFunction(() => Boolean(window.mnsg));
  assert.equal(
    await app.evaluate(({ app }) => app.getPath("userData")),
    profile,
  );
  await app.evaluate(
    (_e, p) => globalThis.__workspaceSmoke.open.push([p]),
    rom,
  );
  await main
    .getByRole("button", { name: "Choose US ROM", exact: true })
    .click();
  await main
    .locator('[data-testid="room-button"][data-room-id="465"]')
    .waitFor({ timeout: 120000 });
  await main.locator('[data-testid="room-button"][data-room-id="465"]').click();
  await main.locator(".viewport-loading").waitFor({ state: "hidden" });
  const button = (page, name) =>
    page.getByRole("button", { name, exact: true });
  async function menu(name) {
    const item = main.locator(".workspace-menu-popup").filter({
      has: main.locator("summary").filter({ hasText: new RegExp(`^${name}$`) }),
    });
    await item.locator("summary").click();
    return item;
  }
  async function layout(name) {
    const item = await menu("Layout");
    await button(item, `${name} layout`).click();
    await item.locator("summary").click();
  }
  async function show(id) {
    const item = await menu("Window");
    await button(item, id).click();
    await item.locator("summary").click();
  }
  async function pop(id) {
    const waiting = app.waitForEvent("window");
    await button(main, `Pop out ${id}`).click();
    const page = await waiting;
    observe(page);
    await page.getByTestId(`workspace-panel-${id.toLowerCase()}`).waitFor();
    return page;
  }
  async function nativeClose(page) {
    const closed = page.waitForEvent("close");
    const window = await app.browserWindow(page);
    await window.evaluate((window) => window.close());
    await closed;
  }
  let savedOnce = false;
  async function saved() {
    if (!savedOnce) {
      await app.evaluate(
        (_e, p) => globalThis.__workspaceSmoke.save.push(p),
        projectPath,
      );
      savedOnce = true;
    }
    await button(main, "Save").click();
    await main.locator(".dirty-state").waitFor({ state: "hidden" });
    return JSON.parse(await readFile(projectPath, "utf8"));
  }
  const initial = await saved();
  await record("isolated native profile and docked project", { room: 465 });
  const host = () => main.getByTestId("viewport-canvas");
  const before = await settlePose(main, host());
  const split = main.getByTestId("resize-left");
  await split.focus();
  await split.press("ArrowRight");
  const changed = Number(await split.getAttribute("aria-valuenow"));
  assert(changed > 200);
  await split
    .getByRole("button", { name: "Decrease Rooms width", exact: true })
    .click();
  assert.equal(Number(await split.getAttribute("aria-valuenow")), changed - 16);
  const roomsPanel = main.getByTestId("workspace-panel-rooms");
  const pointerBefore = await roomsPanel.boundingBox(),
    divider = await split.boundingBox();
  assert(pointerBefore && divider);
  await main.mouse.move(divider.x + divider.width / 2, divider.y + 20);
  await main.mouse.down();
  await main.mouse.move(divider.x + divider.width / 2 + 40, divider.y + 20, {
    steps: 5,
  });
  await main.mouse.up();
  const pointerAfter = await roomsPanel.boundingBox();
  assert(
    pointerAfter.width - pointerBefore.width >= 32 &&
      pointerAfter.width - pointerBefore.width <= 48,
    "Genuine divider drag changes the measured panel width",
  );
  assert(
    Math.abs(
      pointerAfter.width - Number(await split.getAttribute("aria-valuenow")),
    ) <= 1,
  );
  assert.deepEqual(await settlePose(main, host()), before);
  await record(
    "real pointer resize changes measured dock width without camera/project edits",
    { before: pointerBefore.width, after: pointerAfter.width },
  );
  await layout("Wide");
  await layout("Default");
  await split.focus();
  await split.press("ArrowRight");
  const savedLayoutWidth = Number(await split.getAttribute("aria-valuenow"));
  const item = await menu("Layout");
  await item.getByLabel("Layout name", { exact: true }).fill("Native editing");
  await button(item, "Save layout").click();
  await item.locator("summary").click();
  const layoutKey = "mnsg.workspace.layout.v1";
  await main.waitForFunction(
    ({ key, width }) => {
      const prefs = JSON.parse(localStorage.getItem(key));
      return prefs?.saved?.["Native editing"]?.leftWidth === width;
    },
    { key: layoutKey, width: savedLayoutWidth },
  );
  const namedPreferences = await main.evaluate(
    (key) => JSON.parse(localStorage.getItem(key)),
    layoutKey,
  );
  await layout("Focus");
  assert(await main.getByTestId("workspace-panel-scene").isVisible());
  assert.equal(await roomsPanel.isVisible(), false);
  await button(main, "Restore workspace").click();
  await button(main, "Maximize Inspector").click();
  assert(await main.getByTestId("workspace-panel-inspector").isVisible());
  assert.equal(await host().isVisible(), false);
  await button(main, "Restore Inspector").click();
  await button(main, "Close Rooms").click();
  assert.equal(await roomsPanel.isVisible(), false);
  await show("Rooms");
  assert(await roomsPanel.isVisible());
  await layout("Wide");
  const loadingNamed = await menu("Layout");
  await button(loadingNamed, "Load Native editing").click();
  await loadingNamed.locator("summary").click();
  await main.waitForFunction(
    ({ key, current }) =>
      JSON.stringify(JSON.parse(localStorage.getItem(key)).current) ===
      JSON.stringify(current),
    { key: layoutKey, current: namedPreferences.saved["Native editing"] },
  );
  // A real reload reconstructs components and re-reads the same isolated profile;
  // no in-memory prefs stand in for persistence. The ROM is already cached.
  await main.reload();
  await main
    .locator('[data-testid="room-button"][data-room-id="465"]')
    .waitFor({ timeout: 120000 });
  await main.waitForFunction(
    ({ key, current }) =>
      JSON.stringify(JSON.parse(localStorage.getItem(key)).current) ===
      JSON.stringify(current),
    { key: layoutKey, current: namedPreferences.saved["Native editing"] },
  );
  assert.equal(
    Number(await split.getAttribute("aria-valuenow")),
    namedPreferences.saved["Native editing"].leftWidth,
  );
  const restoredPrefs = await main.evaluate(
    (key) => JSON.parse(localStorage.getItem(key)),
    layoutKey,
  );
  assert.deepEqual(restoredPrefs.saved, namedPreferences.saved);
  await main.evaluate(
    (key) => localStorage.setItem(key, "{broken-layout"),
    layoutKey,
  );
  await main.reload();
  await main
    .locator('[data-testid="room-button"][data-room-id="465"]')
    .waitFor({ timeout: 120000 });
  await main.waitForFunction((key) => {
    try {
      const p = JSON.parse(localStorage.getItem(key));
      return p.current.leftWidth === 200 && p.current.rightWidth === 300;
    } catch {
      return false;
    }
  }, layoutKey);
  assert.equal(Number(await split.getAttribute("aria-valuenow")), 200);
  const resetting = await menu("Layout");
  await button(resetting, "Reset workspace layout").click();
  await resetting.locator("summary").click();
  await main.waitForFunction(
    (key) =>
      Object.keys(JSON.parse(localStorage.getItem(key)).saved).length === 0,
    layoutKey,
  );
  await main.locator('[data-testid="room-button"][data-room-id="465"]').click();
  await main.locator(".viewport-loading").waitFor({ state: "hidden" });
  assert.equal(graph(await saved()), graph(initial));
  await record(
    "named layout restores after actual reload, corrupt storage recovers, Reset/maximize/reopen are functional",
  );
  await record(
    "pointer-independent resize, presets and saved layout leave project/camera unchanged",
  );

  // A genuine authored room makes shared edits obvious without altering any
  // existing/native room. Native initialization still comes from donor 465.
  await main.getByTestId("new-room-button").click();
  const modal = main.getByRole("dialog", { name: "New room", exact: true });
  await modal.getByLabel("Room name", { exact: true }).fill("Workspace probe");
  await modal.getByLabel("Room name", { exact: true }).press("Enter");
  await button(modal, "Blank room").click();
  await main.getByTestId("create-room-button").click();
  await modal.waitFor({ state: "hidden" });
  await main.getByRole("tab", { name: "Room", exact: true }).click();
  const baseline = await saved();
  assert.equal(baseline.authoredRooms[620].name, "Workspace probe");
  let inspector = await pop("Inspector");
  const childIpc = await inspector.evaluate(async () => {
    if (!window.mnsg) return { exposed: false };
    try {
      await window.mnsg.getStatus();
      return { exposed: true, rejected: false };
    } catch (error) {
      return { exposed: true, rejected: true, message: error.message };
    }
  });
  assert(
    !childIpc.exposed || childIpc.rejected,
    "Native child cannot service its own privileged IPC",
  );
  await record(
    "child privileged bridge absent or rejects direct IPC",
    childIpc,
  );
  const name = inspector
    .getByTestId("authoring-inspector")
    .getByLabel("Room name", { exact: true });
  await name.fill("Shared window edit");
  await name.press("Enter");
  await main.locator(".dirty-state").waitFor();
  assert.equal((await saved()).authoredRooms[620].name, "Shared window edit");
  await button(main, "Undo").click();
  await name.waitFor();
  assert.equal(await name.inputValue(), "Workspace probe");
  assert.equal(graph(await saved()), graph(baseline));
  await record(
    "native Inspector portal edits and main Undo share one project/history",
  );

  // Leave a text field draft without blur, then use the OS native window close.
  // A stable adopted portal must retain the draft, not replay a project edit.
  await name.fill("Uncommitted draft");
  await nativeClose(inspector);
  const restored = main
    .getByTestId("authoring-inspector")
    .getByLabel("Room name", { exact: true });
  await restored.waitFor();
  assert.equal(await restored.inputValue(), "Uncommitted draft");
  assert.equal(await main.locator(".dirty-state").count(), 0);
  await restored.press("Escape");
  assert.equal(await restored.inputValue(), "Workspace probe");
  await record(
    "OS popup close redocks an unsaved field draft without committing",
  );

  // Forced DevTools disappearance exercises pagehide/poll recovery separately
  // from the genuine BrowserWindow.close path above. Retain the same draft and
  // Escape behavior rather than accepting a dead-looking editable panel.
  inspector = await pop("Inspector");
  const forcedDraft = inspector
    .getByTestId("authoring-inspector")
    .getByLabel("Room name", { exact: true });
  await forcedDraft.fill("Force-close draft");
  await inspector.close();
  await restored.waitFor();
  assert.equal(await restored.inputValue(), "Force-close draft");
  await restored.press("Escape");
  assert.equal(await restored.inputValue(), "Workspace probe");
  await restored.fill("Post-close verified");
  await restored.press("Enter");
  await main.locator(".dirty-state").waitFor();
  assert.equal((await saved()).authoredRooms[620].name, "Post-close verified");
  await button(main, "Undo").click();
  assert.equal(graph(await saved()), graph(baseline));
  inspector = await pop("Inspector");
  const redockedWindow = inspector.waitForEvent("close");
  await button(inspector, "Redock Inspector").click();
  await redockedWindow;
  await restored.waitFor();
  await restored.fill("Redock button edit");
  await restored.press("Enter");
  await main.locator(".dirty-state").waitFor();
  assert.equal((await saved()).authoredRooms[620].name, "Redock button edit");
  await button(main, "Undo").click();
  assert.equal(graph(await saved()), graph(baseline));
  inspector = await pop("Inspector");
  const closedPanel = inspector.waitForEvent("close");
  await button(inspector, "Close Inspector").click();
  await closedPanel;
  await show("Inspector");
  await restored.waitFor();
  assert.equal(await restored.inputValue(), "Workspace probe");
  await record(
    "forced disappearance, native redock and panel-close preserve live input event routing",
  );

  const sceneBefore = await settlePose(main, host());
  const scene = await pop("Scene");
  const sceneHost = scene.getByTestId("viewport-canvas");
  assert.deepEqual(await settlePose(scene, sceneHost), sceneBefore);
  const canvas = scene.getByTestId("viewport-navigation-canvas");
  await canvas.focus();
  const walkBefore = await cameraState(sceneHost);
  await scene.keyboard.down("w");
  await scene.waitForTimeout(200);
  await scene.keyboard.up("w");
  const walkAfter = await settlePose(scene, sceneHost);
  assert(
    Math.hypot(
      ...walkAfter.position.map((v, i) => v - walkBefore.position[i]),
    ) > 2,
    "Child canvas owns keyboard movement",
  );
  const typingWindow = await pop("Inspector");
  const typedName = typingWindow
    .getByTestId("authoring-inspector")
    .getByLabel("Room name", { exact: true });
  await typedName.focus();
  await typingWindow.keyboard.type("wasdftg");
  await typingWindow.waitForTimeout(150);
  assert.deepEqual(
    await cameraState(sceneHost),
    walkAfter,
    "Typing in a child field cannot move or frame the Scene camera",
  );
  await typedName.press("Escape");
  assert.equal(await typedName.inputValue(), "Workspace probe");
  await button(main, "Project and build settings").click();
  const blockingModal = main.getByRole("dialog", {
    name: "Project and build settings",
    exact: true,
  });
  await blockingModal.waitFor();
  assert(
    await typingWindow
      .locator(".dock-panel-content")
      .evaluate((element) => element.inert),
    "Main modal blocks native child editing",
  );
  await typedName.evaluate((element) => element.focus());
  assert.equal(
    await typedName.evaluate(
      (element) => element.ownerDocument.activeElement === element,
    ),
    false,
    "An inert child field cannot receive typing focus",
  );
  await typingWindow.keyboard.type("blocked edit");
  assert.equal(await typedName.inputValue(), "Workspace probe");
  await scene.keyboard.down("w");
  await scene.waitForTimeout(150);
  await scene.keyboard.up("w");
  assert.deepEqual(
    await cameraState(sceneHost),
    walkAfter,
    "A main modal blocks native child Scene movement",
  );
  await button(main, "Close dialog").click();
  await blockingModal.waitFor({ state: "hidden" });
  await nativeClose(typingWindow);
  await button(main, "Close Rooms").click();
  await nativeClose(scene);
  await host().waitFor();
  assert.deepEqual(await settlePose(main, host()), walkAfter);
  assert.equal(
    await main.getByTestId("workspace-panel-rooms").isVisible(),
    false,
    "Native close must preserve later layout visibility changes",
  );
  await show("Rooms");
  assert.equal(graph(await saved()), graph(baseline));
  await record(
    "native Scene WASD/rehost camera and latest layout survive OS close",
  );

  // Every approved panel is a real native window, including the same-origin
  // React event route in the assets browser and readonly console.
  for (const id of ["Rooms", "Hierarchy", "Assets", "Console"]) {
    if (id === "Assets" || id === "Console") {
      let previouslyUnobservedId;
      if (id === "Assets") {
        assert.equal(
          await main
            .getByLabel("Search native assets", { exact: true })
            .inputValue(),
          "",
        );
        const pending = main
          .getByTestId("asset-card")
          .filter({ hasText: "0x2D3" })
          .first();
        await pending.waitFor({ state: "attached" });
        previouslyUnobservedId = await pending.getAttribute("data-asset-id");
        assert.equal(
          await pending.locator("img").count(),
          0,
          "Already-mounted distant card must not have loaded before adoption",
        );
        assert(
          await pending.evaluate(
            (element) =>
              element.getBoundingClientRect().top >
              element.closest(".asset-grid").getBoundingClientRect().bottom +
                100,
          ),
          "Fixture is outside the old observer's margin",
        );
        await pending.evaluate((element) => {
          element.dataset.workspaceObserverProbe = "mounted-before-popout";
        });
      }
      const windowMenu = await menu("Window");
      const waiting = app.waitForEvent("window");
      await button(windowMenu, `Pop out ${id} from menu`).click();
      await windowMenu.locator("summary").click();
      const page = await waiting;
      observe(page);
      await page.getByTestId(`workspace-panel-${id.toLowerCase()}`).waitFor();
      if (id === "Assets") {
        const pending = page.locator(
          `[data-testid="asset-card"][data-asset-id=${JSON.stringify(previouslyUnobservedId)}]`,
        );
        assert.equal(
          await pending.getAttribute("data-workspace-observer-probe"),
          "mounted-before-popout",
          "Card DOM and React state survive adoption",
        );
        assert.equal(
          await page
            .getByLabel("Search native assets", { exact: true })
            .inputValue(),
          "",
          "Catalogue/search remain untouched",
        );
        await pending.scrollIntoViewIfNeeded();
        await pending.locator("img").waitFor({ timeout: 120000 });
        assert(
          await pending
            .locator("img")
            .evaluate(
              (image) =>
                image.complete &&
                image.naturalWidth > 0 &&
                image.src.startsWith("data:image/png;base64,"),
            ),
          "Adopted offscreen card loads a real native PNG",
        );
        await page.screenshot({
          path: path.join(artifacts, "assets-adopted-offscreen.png"),
          fullPage: true,
        });
        await record(
          "previously unobserved mounted ROM card loads after native-window adoption",
          {
            assetId: previouslyUnobservedId,
            status: await pending
              .getByTestId("actor-visual-status")
              .textContent()
              .catch(() => pending.textContent()),
          },
        );
      }
      if (id === "Assets") {
        const coin = await main.evaluate(async () => {
          const catalog = await window.mnsg.getAuthoringCatalog();
          // Native actor085 is the coin fixture already covered by actor-init
          // tests. The current ROM catalogue supplies its actual prototype ID.
          const prototype = catalog.actorPrototypes.find(
            (p) => p.actorId === 0x85 && p.parameters.every((v) => v === 0),
          );
          if (!prototype)
            throw Error("Canonical native coin085 prototype is absent.");
          const payload = await window.mnsg.loadActorPrototype(prototype.id);
          const visual = payload.actorVisuals[0];
          const triangles = payload.actorModels.reduce(
            (n, m) =>
              n + m.meshes.reduce((n, mesh) => n + mesh.indices.length / 3, 0),
            0,
          );
          if (
            !visual?.parts.length ||
            !["supported", "conditional"].includes(visual.status) ||
            triangles <= 0
          )
            throw Error("Coin085 has no verified real native preview.");
          return { id: prototype.id, status: visual.status, triangles };
        });
        await page
          .getByLabel("Search native assets", { exact: true })
          .fill(coin.id);
        const coinCard = page.locator(
          `[data-testid="asset-card"][data-asset-id=${JSON.stringify(coin.id)}]`,
        );
        await coinCard.locator("img").waitFor({ timeout: 120000 });
        await button(coinCard, "Place at origin").click();
        await main.locator(".dirty-state").waitFor();
        const closingAssets = page.waitForEvent("close");
        await button(page, "Redock Assets").click();
        await closingAssets;
        const placed = await saved();
        const actors = placed.authoredRooms[620].actors;
        assert.equal(
          actors.length,
          baseline.authoredRooms[620].actors.length + 1,
        );
        assert.equal(actors.at(-1).prototypeId, coin.id);
        assert.deepEqual(actors.at(-1).position, { x: 0, y: 0, z: 0 });
        await button(main, "Undo").click();
        assert.equal(graph(await saved()), graph(baseline));
        await record(
          "real native Assets Place at origin callback, redock, Save and Undo preserve one graph",
          coin,
        );
      } else if (id === "Console") {
        await page
          .getByLabel("Console source", { exact: true })
          .selectOption("Project");
        await page
          .getByLabel("Console severity", { exact: true })
          .selectOption("info");
        const actualNotices = page.locator(".console-entry p");
        await actualNotices
          .filter({ hasText: "Saved workspace.mnsgproj" })
          .first()
          .waitFor();
        assert(
          (await actualNotices.count()) > 0,
          "Console contains real native save notices",
        );
        await page
          .getByLabel("Console severity", { exact: true })
          .selectOption("warning");
        assert.equal(
          await page.locator(".console-entry").count(),
          0,
          "Project info notices obey severity filtering",
        );
        await page
          .getByLabel("Console severity", { exact: true })
          .selectOption("info");
        await button(page, "Clear console").click();
        assert.equal(await page.locator(".console-entry").count(), 0);
        await nativeClose(page);
        assert.equal(graph(await saved()), graph(baseline));
        await record(
          "native Console real notice, source/severity filters and Clear preserve saved graph",
        );
      }
    } else {
      const page = await pop(id);
      await nativeClose(page);
    }
  }
  await record("all six native panel hosts and real lazy ROM thumbnails");
  assert.equal(graph(await saved()), graph(baseline));

  await button(main, "Project and build settings").click();
  const settings = main.getByRole("dialog", {
    name: "Project and build settings",
    exact: true,
  });
  const settingsButton = (name) => button(settings, name);
  const issueSummary = settings.locator("#mod-validation-summary");
  async function invalidSetting(id, value, linkedLabel) {
    const field = settings.locator(`#${id}`);
    await field.fill(value);
    await settingsButton("Apply settings").click();
    await issueSummary.waitFor();
    await main.waitForFunction(
      (id) => document.activeElement === document.getElementById(id),
      "mod-validation-summary",
      { timeout: 5000 },
    );
    assert(
      await issueSummary.evaluate(
        (element) => element.ownerDocument.activeElement === element,
      ),
      "Failed Apply focuses linked error summary",
    );
    assert.equal(await field.getAttribute("aria-invalid"), "true");
    assert(
      (await field.getAttribute("aria-describedby")).includes(`${id}-error`),
    );
    assert(
      (await settings.locator(`#${id}-error`).textContent()).trim().length > 0,
    );
    assert.equal(
      await field.inputValue(),
      value,
      "Invalid draft is retained verbatim",
    );
    await settingsButton(linkedLabel).click();
    await main.waitForFunction(
      (id) => document.activeElement === document.getElementById(id),
      id,
      { timeout: 5000 },
    );
    assert(
      await field.evaluate(
        (element) => element.ownerDocument.activeElement === element,
      ),
      "Error link focuses the actual field",
    );
    assert(
      await settings.isVisible(),
      "Invalid Apply cannot dismiss the settings draft",
    );
  }
  const modId = settings.locator("#mod-identity-mod-id"),
    originalModId = await modId.inputValue();
  await invalidSetting(
    "mod-identity-mod-id",
    "invalid id",
    "Go to Mod ID · Identity",
  );
  await settings
    .locator("#mod-identity-display-name")
    .fill("Unrelated draft edit");
  assert.equal(
    await modId.getAttribute("aria-invalid"),
    "true",
    "Unrelated edits cannot erase another field's error",
  );
  await modId.fill(originalModId);
  await settingsButton("Options").click();
  await settingsButton("Add Number").click();
  for (const [key, value] of [
    ["min", "   "],
    ["min", "not-a-number"],
    ["min", "200"],
    ["max", "not-a-number"],
    ["default", "101"],
  ]) {
    await invalidSetting(
      `mod-options-option-0-${key}`,
      value,
      `Go to ${key} · Options`,
    );
    await settings
      .locator(`#mod-options-option-0-${key}`)
      .fill(key === "max" ? "100" : "0");
  }
  await settingsButton("Add Enum").click();
  await invalidSetting(
    "mod-options-option-1-default-label",
    "missing choice",
    "Go to Default label · Options",
  );
  await settings.locator("#mod-options-option-1-default-label").fill("Enabled");
  await settingsButton("Build inputs").click();
  await invalidSetting(
    "mod-build-inputs-elf-output-path",
    "../outside.elf",
    "Go to ELF output path · Build inputs",
  );
  await settingsButton("Cancel").click();
  await settings.waitFor({ state: "hidden" });
  assert.equal(graph(await saved()), graph(baseline));
  await record(
    "settings invalid Apply preserves drafts, field errors, focus links and project history",
  );

  // Successful settings are one actual editor transaction, including the native
  // file dialog and canonical PNG attachment. No private importer substitutes.
  await button(main, "Project and build settings").click();
  await settings.waitFor();
  await settings
    .locator("#mod-identity-mod-id")
    .fill("workspace_integration_mod");
  await settings.locator("#mod-identity-version").fill("1.2.3-rc.1");
  await settings
    .locator("#mod-identity-display-name")
    .fill("Workspace integration mod");
  await settings
    .locator("#mod-identity-description")
    .fill("Portable project settings\nMetadata, options and an uploaded icon.");
  await settings
    .locator("#mod-identity-authors")
    .fill("Workspace tester\nPortable project fixture");
  await settingsButton("Options").click();
  await settingsButton("Add Number").click();
  await settings.locator("#mod-options-option-0-option-id").fill("amount");
  await settings.locator("#mod-options-option-0-name").fill("Amount");
  for (const [key, value] of [
    ["min", "0"],
    ["max", "10"],
    ["step", "1"],
    ["default", "5"],
    ["precision", "0"],
  ])
    await settings.locator(`#mod-options-option-0-${key}`).fill(value);
  await settingsButton("Add Enum").click();
  await settings.locator("#mod-options-option-1-option-id").fill("enabled");
  await settings.locator("#mod-options-option-1-name").fill("Enabled");
  await settings
    .locator("#mod-options-option-1-default-label")
    .fill("Disabled");
  await settingsButton("Add String").click();
  await settings.locator("#mod-options-option-2-option-id").fill("note");
  await settings.locator("#mod-options-option-2-name").fill("Note");
  await settings
    .locator("#mod-options-option-2-default")
    .fill("Persisted\nvalue");
  await settingsButton("Files").click();
  const iconPath = path.join(artifacts, "fixture-icon.png");
  const iconBase64 = await main.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 32;
    const context = canvas.getContext("2d");
    context.fillStyle = "#242424";
    context.fillRect(0, 0, 32, 32);
    context.fillStyle = "#55cabc";
    context.fillRect(4, 4, 24, 24);
    context.fillStyle = "#ffffff";
    context.fillRect(7, 14, 18, 4);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  await writeFile(iconPath, Buffer.from(iconBase64, "base64"));
  await app.evaluate(
    (_e, p) => globalThis.__workspaceSmoke.open.push([p]),
    iconPath,
  );
  await settingsButton("Upload icon").click();
  await settings
    .getByRole("img", { name: "Project mod icon", exact: true })
    .waitFor();
  await main.screenshot({
    path: path.join(artifacts, "settings-native-icon.png"),
    fullPage: true,
  });
  await settingsButton("Build inputs").click();
  await settings
    .locator("#mod-build-inputs-nrm-filename")
    .fill("workspace-preview");
  await settingsButton("Apply settings").click();
  await settings.waitFor({ state: "hidden" });
  await main.locator(".dirty-state").waitFor();
  const withSettings = await saved();
  assert.equal(withSettings.mod.manifest.id, "workspace_integration_mod");
  assert.equal(withSettings.mod.manifest.version, "1.2.3-rc.1");
  assert.deepEqual(withSettings.mod.manifest.authors, [
    "Workspace tester",
    "Portable project fixture",
  ]);
  assert.deepEqual(
    withSettings.mod.manifest.config_options.map((o) => [
      o.id,
      o.type,
      o.default,
    ]),
    [
      ["amount", "Number", 5],
      ["enabled", "Enum", "Disabled"],
      ["note", "String", "Persisted\nvalue"],
    ],
  );
  assert.equal(withSettings.mod.inputs.mod_filename, "workspace-preview");
  assert.equal(withSettings.mod.icon.name, "thumb.png");
  assert.equal(withSettings.mod.icon.mediaType, "image/png");
  const normalizedIcon = Buffer.from(withSettings.mod.icon.base64, "base64");
  assert.equal(normalizedIcon.length, withSettings.mod.icon.byteLength);
  assert.equal(
    createHash("sha256").update(normalizedIcon).digest("hex"),
    withSettings.mod.icon.sha256,
  );
  assert.equal(normalizedIcon.readUInt32BE(16), 32);
  assert.equal(normalizedIcon.readUInt32BE(20), 32);
  assert(withSettings.mod.inputs.additional_files.includes("thumb.png"));
  await button(main, "Undo").click();
  assert.equal(graph(await saved()), graph(baseline));
  await button(main, "Redo").click();
  assert.equal(graph(await saved()), graph(withSettings));
  await app.evaluate(
    (_e, p) => globalThis.__workspaceSmoke.open.push([p]),
    projectPath,
  );
  await button(main, "Open").click();
  await main.locator(".viewport-loading").waitFor({ state: "hidden" });
  await main.getByRole("tab", { name: "Room", exact: true }).click();
  await button(main, "Project and build settings").click();
  await settings.waitFor();
  assert.equal(
    await settings.locator("#mod-identity-mod-id").inputValue(),
    "workspace_integration_mod",
  );
  await settingsButton("Options").click();
  assert.equal(
    await settings.locator("#mod-options-option-0-default").inputValue(),
    "5",
  );
  assert.equal(
    await settings.locator("#mod-options-option-1-default-label").inputValue(),
    "Disabled",
  );
  await settingsButton("Files").click();
  assert.equal(
    await settings
      .getByRole("img", { name: "Project mod icon", exact: true })
      .getAttribute("src"),
    `data:image/png;base64,${withSettings.mod.icon.base64}`,
  );
  await settingsButton("Identity").click();
  await settings
    .locator("#mod-identity-display-name")
    .fill("Canceled metadata draft");
  await settingsButton("Cancel").click();
  await settings.waitFor({ state: "hidden" });
  assert.equal(graph(await saved()), graph(withSettings));
  await record(
    "GUI metadata/options/icon Apply, Undo, Redo, Save, Reopen and Cancel preserve the full graph",
    { iconSha256: withSettings.mod.icon.sha256 },
  );

  for (const [width, zoom] of [
    [1000, 1],
    [800, 1.25],
    [1000, 2],
  ]) {
    await app.evaluate(
      ({ BrowserWindow }, { width, zoom }) => {
        const main = BrowserWindow.getAllWindows().find(
          (w) => !w.getParentWindow(),
        );
        main.setSize(width, 800);
        main.webContents.setZoomFactor(zoom);
      },
      { width, zoom },
    );
    await main.waitForTimeout(300);
    assert(
      await main.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
      `No horizontal page overflow at ${width}/${zoom}`,
    );
    const tabs = main.getByRole("tablist", {
      name: "Workspace panels",
      exact: true,
    });
    if (await tabs.isVisible()) {
      await tabs.getByRole("tab", { name: "Inspector", exact: true }).click();
      assert(await main.getByTestId("authoring-inspector").isVisible());
      await tabs.getByRole("tab", { name: "Scene", exact: true }).click();
      assert(await host().isVisible());
    }
    await main.screenshot({
      path: path.join(artifacts, `workspace-${width}-${zoom}.png`),
      fullPage: true,
    });
    await button(main, "Project and build settings").click();
    await settings.waitFor();
    await settingsButton("Options").click();
    const content = settings.locator(".mod-settings-content");
    const sizing = await settings.evaluate((dialog) => {
      const panel = dialog.querySelector(".mod-settings-panel"),
        content = dialog.querySelector(".mod-settings-content");
      const container = content.getBoundingClientRect();
      return {
        viewport: [window.innerWidth, window.innerHeight],
        widths: [
          dialog,
          panel,
          content,
          ...dialog.querySelectorAll(".mod-field-grid"),
        ].map((element) => ({
          client: element.clientWidth,
          scroll: element.scrollWidth,
        })),
        fieldsContained: [...content.querySelectorAll("input,textarea")].every(
          (field) => {
            const bounds = field.getBoundingClientRect();
            return (
              bounds.left >= container.left - 1 &&
              bounds.right <= container.right + 1
            );
          },
        ),
      };
    });
    assert(sizing.fieldsContained, `Settings fields fit at ${width}/${zoom}`);
    assert(
      sizing.widths.every(({ client, scroll }) => scroll <= client + 1),
      `Settings form and field grids have no horizontal clipping at ${width}/${zoom}`,
    );
    for (const name of ["Apply settings", "Cancel"]) {
      const bounds = await settingsButton(name).boundingBox();
      assert(bounds && bounds.width > 0 && bounds.height > 0);
      assert(
        bounds.x >= 0 &&
          bounds.y >= 0 &&
          bounds.x + bounds.width <= sizing.viewport[0] + 1 &&
          bounds.y + bounds.height <= sizing.viewport[1] + 1,
        `${name} is inside the app viewport at ${width}/${zoom}`,
      );
    }
    const topField = settings.locator("#mod-options-option-0-option-id");
    await topField.scrollIntoViewIfNeeded();
    const scrollBefore = await content.evaluate((element) => element.scrollTop);
    assert(
      await content.evaluate(
        (element) => element.scrollHeight > element.clientHeight,
      ),
      "Options require the internal settings scroller",
    );
    await content.hover();
    await main.mouse.wheel(0, 1600);
    await main.waitForFunction(
      (before) =>
        document.querySelector(".mod-settings-content").scrollTop > before,
      scrollBefore,
    );
    const lastField = settings.locator("#mod-options-option-2-default");
    await lastField.scrollIntoViewIfNeeded();
    assert(
      await lastField.evaluate((field) => {
        const bounds = field.getBoundingClientRect(),
          scroller = field
            .closest(".mod-settings-content")
            .getBoundingClientRect();
        return (
          bounds.top >= scroller.top - 1 && bounds.bottom <= scroller.bottom + 1
        );
      }),
      "The lower option field is reachable inside the settings scroller",
    );
    await lastField.fill(`Canceled responsive draft ${width}/${zoom}`);
    await main.screenshot({
      path: path.join(artifacts, `settings-${width}-${zoom}.png`),
      fullPage: true,
    });
    await settingsButton("Cancel").click();
    await settings.waitFor({ state: "hidden" });
    assert.equal(graph(await saved()), graph(withSettings));
    await record(
      "responsive settings fields, footer, internal scroll and Cancel",
      {
        width,
        zoom,
        sizing,
      },
    );
  }
  await record("responsive native width and 125/200 percent zoom");
  assert.equal(graph(await saved()), graph(withSettings));
  assert.deepEqual(report.errors, []);
  const gone = await app.evaluate(() => globalThis.__workspaceSmoke.gone);
  assert.deepEqual(gone, []);
  report.status = "passed";
  await record("single history and error-free native portal lifecycle");
} catch (error) {
  report.status = "failed";
  report.error = { message: error.message, stack: error.stack };
  if (main)
    await main
      .screenshot({ path: path.join(artifacts, "failure.png"), fullPage: true })
      .catch(() => {});
  await writeFile(
    path.join(artifacts, "workspace-checks.json"),
    JSON.stringify(report, null, 2),
  );
  throw error;
} finally {
  await app.close();
  console.log(`Artifacts: ${artifacts}`);
}
