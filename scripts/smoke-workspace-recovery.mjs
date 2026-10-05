import { _electron as electron } from "playwright";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, mkdir, writeFile, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Native windows and an actual process restart, using one disposable no-ROM
// profile. Run against either the source build or MNSG_TEST_APP's installed app.
const artifacts = await realpath(await mkdtemp(path.join(tmpdir(), "mnsg-workspace-recovery-")));
const profile = path.join(artifacts, "profile");
await mkdir(profile);
await writeFile(path.join(profile, "window-bounds.json"), JSON.stringify({
  main: { x: 50000, y: -50000, width: 1200, height: 800 },
  scene: { x: -50000, y: 50000, width: 900, height: 700 },
}));
const wrapper = path.join(artifacts, "launch.cjs");
await writeFile(wrapper, `const {app}=require('electron');app.setPath('userData',${JSON.stringify(profile)});require(${JSON.stringify(path.resolve("dist-electron/main.cjs"))});`);
const env = { ...process.env, PATH: "" };
delete env.ELECTRON_RUN_AS_NODE;
delete env.MNSG_DEV_URL;
const report = { status: "running", artifacts, executable: process.env.MNSG_TEST_APP ?? "source", checks: [], errors: [] };
const record = async (name, evidence = {}) => {
  report.checks.push({ name, ...evidence });
  await writeFile(path.join(artifacts, "recovery-checks.json"), JSON.stringify(report, null, 2));
  console.log(`PASS ${name}`);
};
const button = (scope, name) => scope.getByRole("button", { name, exact: true });
const key = "mnsg.workspace.layout.v1";
let app, main;
async function launch() {
  app = await electron.launch({
    ...(process.env.MNSG_TEST_APP ? { executablePath: process.env.MNSG_TEST_APP, args: [`--user-data-dir=${profile}`] } : { args: [wrapper] }),
    env, timeout: 30000,
  });
  main = await app.firstWindow();
  main.setDefaultTimeout(30000);
  main.on("pageerror", error => report.errors.push(error.message));
  await main.waitForFunction(() => Boolean(window.mnsg));
  await app.evaluate(({ session }) => session.defaultSession.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (_details, done) => done({ cancel: true })));
  assert.equal(await app.evaluate(({ app }) => app.getPath("userData")), profile);
  assert.equal((await main.evaluate(() => window.mnsg.getStatus())).rom, null);
  await button(main, "Open procedural sample").click();
  await main.getByTestId("viewport-navigation-canvas").waitFor();
}
async function withinDisplay(page) {
  const native = await app.browserWindow(page);
  const bounds = await native.evaluate(window => window.getBounds());
  const areas = await app.evaluate(({ screen }) => screen.getAllDisplays().map(display => display.workArea));
  assert(areas.some(area => bounds.x >= area.x && bounds.y >= area.y && bounds.x + bounds.width <= area.x + area.width + 1 && bounds.y + bounds.height <= area.y + area.height + 1), "Restored window must fit a currently connected display");
  return bounds;
}
async function popup(id) {
  const label = id[0].toUpperCase() + id.slice(1);
  const menu = main.locator(".workspace-menu-popup").filter({ has: main.locator("summary").filter({ hasText: /^Window$/ }) });
  await menu.locator("summary").click();
  const waiting = app.waitForEvent("window");
  await button(menu, `Pop out ${label} from menu`).click();
  const child = await waiting;
  child.on("pageerror", error => report.errors.push(error.message));
  await child.getByTestId(`workspace-panel-${id}`).waitFor();
  await menu.locator("summary").click();
  return child;
}
try {
  await launch();
  await record("off-monitor main window recovers on a connected display", { bounds: await withinDisplay(main) });
  const nativeMain = await app.browserWindow(main);
  await nativeMain.evaluate(window => window.setSize(1200, 800));
  const separator = main.getByTestId("resize-left");
  await separator.focus();
  await separator.press("ArrowRight");
  const expectedWidth = Number(await separator.getAttribute("aria-valuenow"));
  await main.waitForFunction(({ key, width }) => JSON.parse(localStorage.getItem(key))?.current.leftWidth === width, { key, width: expectedWidth });
  const expectedLayout = await main.evaluate(key => JSON.parse(localStorage.getItem(key)), key);
  const scene = await popup("scene");
  await record("off-monitor Scene popout recovers", { bounds: await withinDisplay(scene) });
  const nativeScene = await app.browserWindow(scene);
  await nativeScene.evaluate(window => window.setSize(700, 500));
  const expectedScene = await withinDisplay(scene);
  await app.close();
  app = null;
  const savedBounds = JSON.parse(await readFile(path.join(profile, "window-bounds.json"), "utf8"));
  assert.deepEqual(savedBounds.scene, expectedScene);
  await launch();
  assert.deepEqual(await main.evaluate(key => JSON.parse(localStorage.getItem(key)), key), expectedLayout);
  assert.equal(Number(await main.getByTestId("resize-left").getAttribute("aria-valuenow")), expectedWidth);
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
  await record("entire app restart preserves layout and cleans up native children", { leftWidth: expectedWidth, mainBounds: await withinDisplay(main) });
  const restoredScene = await popup("scene");
  assert.deepEqual(await withinDisplay(restoredScene), expectedScene);
  const closingScene = restoredScene.waitForEvent("close");
  await button(restoredScene, "Redock Scene").click();
  await closingScene;
  await record("popout bounds survive a process restart", { sceneBounds: expectedScene });

  for (const id of ["rooms", "scene", "hierarchy", "inspector", "assets", "console"]) {
    const child = await popup(id);
    const native = await app.browserWindow(child);
    await native.evaluate(window => window.setSize(360, 300));
    const measurements = [];
    for (const zoom of [1, 1.25, 2]) {
      await native.evaluate((window, zoom) => window.webContents.setZoomFactor(zoom), zoom);
      const label = id[0].toUpperCase() + id.slice(1);
      const action = button(child, `Redock ${label}`);
      await action.scrollIntoViewIfNeeded();
      const geometry = await action.evaluate(element => {
        const rect = element.getBoundingClientRect();
        return { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, width: innerWidth, height: innerHeight };
      });
      assert(geometry.x >= 0 && geometry.y >= 0 && geometry.right <= geometry.width + 1 && geometry.bottom <= geometry.height + 1, `${label} redock must remain reachable at ${zoom * 100}% zoom`);
      measurements.push({ zoom, ...geometry });
    }
    await native.evaluate(window => window.webContents.setZoomFactor(1));
    const closing = child.waitForEvent("close");
    await button(child, `Redock ${id[0].toUpperCase() + id.slice(1)}`).click();
    await closing;
    await record(`${id} compact native popout keeps its recovery action reachable`, { nativeSize: [360, 300], measurements });
  }
  assert.deepEqual(report.errors, []);
  assert.equal((await main.evaluate(() => window.mnsg.getStatus())).project, null);
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
  await main.screenshot({ path: path.join(artifacts, "recovered-workspace.png"), fullPage: true });
  report.status = "passed";
  await record("isolated offline window recovery without project mutation or renderer errors");
} catch (error) {
  report.status = "failed";
  report.failure = { message: error.message, stack: error.stack };
  if (main && !main.isClosed()) await main.screenshot({ path: path.join(artifacts, "failure.png"), fullPage: true }).catch(() => {});
  await writeFile(path.join(artifacts, "recovery-checks.json"), JSON.stringify(report, null, 2));
  throw error;
} finally {
  if (app) await app.close();
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `directory=${artifacts}\n`);
  console.log(`Artifacts: ${artifacts}`);
}
