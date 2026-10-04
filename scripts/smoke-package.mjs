import { _electron as electron } from "playwright";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkTexturedRooms } from "./smoke-textures.mjs";

const binary = process.env.MNSG_TEST_APP ?? (process.platform === "darwin" ? path.resolve("release/mac-arm64/MNSG Level Editor.app/Contents/MacOS/MNSG Level Editor") : path.resolve("release/win-unpacked/MNSG Level Editor.exe"));
const artifacts = await mkdtemp(path.join(tmpdir(), "mnsg-package-smoke-"));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.MNSG_DEV_URL;
const args = [];
if (process.env.MNSG_TEST_BACKGROUND === "1") {
  const preload = path.join(artifacts, "hidden-window.cjs");
  await writeFile(preload, `const native=require('electron');const Module=require('node:module');const original=Module._load;const Window=native.BrowserWindow;const wrapped=Object.create(native);Object.defineProperty(wrapped,'BrowserWindow',{value:class extends Window{constructor(options){super({...options,show:false,webPreferences:{...options.webPreferences,backgroundThrottling:false}})}}});Module._load=function(request){return request==='electron'?wrapped:original.apply(this,arguments)};`);
  args.push("-r", preload);
}
const app = await electron.launch({ executablePath: binary, args, env, timeout: 30_000 });
try {
  const page = await app.firstWindow();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForFunction(() => Boolean(window.mnsg));
  const status = await page.evaluate(() => window.mnsg.getStatus());
  const expected = JSON.parse(await readFile("package.json", "utf8")).version;
  assert.equal(status.appVersion, expected);
  assert.equal(page.url(), "app://editor/");
  await page.locator("body").waitFor();
  await page.waitForTimeout(500);
  assert((await page.locator("body").innerText()).includes("MNSG"));
  let geometryTab = "No cached ROM; first-launch screen checked.";
  let textures = [];
  if (status.rom) {
    await page.getByTestId("room-geometry-tab").click();
    await page.getByTestId("geometry-panel").waitFor();
    assert.equal(await page.getByTestId("geometry-x").inputValue(), "0");
    geometryTab = "passed";
    textures = await checkTexturedRooms(page, artifacts);
  }
  assert.deepEqual(errors, []);
  const snapshot = path.join(artifacts, "packaged-app.png");
  await page.screenshot({ path: snapshot, fullPage: true });
  console.log(JSON.stringify({ status: "passed", binary, appVersion: status.appVersion, roomCount: status.roomCount, romCached: Boolean(status.rom), geometryTab, textures, url: page.url(), snapshot }, null, 2));
} finally { await app.close(); }
