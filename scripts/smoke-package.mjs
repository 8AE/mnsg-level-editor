import { _electron as electron } from "playwright";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
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
// Packaged Electron ignores Node's -r preload. Its native bootstrap applies this
// switch before ASAR startup, so cache restoration also uses the isolated copy.
const args = [`--user-data-dir=${userData}`];
const app = await electron.launch({ executablePath: binary, args, env, timeout: 30_000 });
try {
  const page = await app.firstWindow();
  const runtime = await app.evaluate(({ app }) => ({ name: app.getName(), userData: app.getPath("userData") }));
  assert.equal(await realpath(runtime.userData), await realpath(userData), "Packaged tests must never use the existing application data directory");
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
  assert.equal(await page.evaluate(() => typeof window.mnsg.loadActorVisuals), "function", "Packaged preload must expose validated native actor previews");
  let geometryTab = "No cached ROM; first-launch screen checked.";
  let textures = [];
  let actors = { skipped: "No canonical cached ROM is available." };
  if (status.rom) {
    await page.getByTestId("room-geometry-tab").click();
    await page.getByTestId("geometry-panel").waitFor();
    assert.equal(await page.getByTestId("geometry-x").inputValue(), "0");
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
  }
  if (cache.copied) {
    assert.equal(sha256(await readFile(path.join(cacheSource, "rom.json"))), cache.identitySha256);
    assert.equal(sha256(await readFile(path.join(cacheSource, "rom-cache", cache.romName))), cache.normalizedSha256);
  }
  assert.deepEqual(errors, []);
  const snapshot = path.join(artifacts, "packaged-app.png");
  await page.screenshot({ path: snapshot, fullPage: true });
  const report = { status: "passed", binary, runtime, appVersion: status.appVersion, roomCount: status.roomCount, romCached: Boolean(status.rom), existingCacheUnchanged: cache.copied, geometryTab, textures, actors, url: page.url(), snapshot };
  await writeFile(path.join(artifacts, "packaged-checks.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await app.close(); }
