import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";

const checksum = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function settledCanvas(page, canvas, artifactPath) {
  // A locator screenshot also includes HTML controls stacked above the canvas.
  // Remove pointer hover consistently before comparing their rendered pixels.
  await page.mouse.move(0, 0);
  const toolbar = page.getByTestId("workspace-panel-scene").locator(".view-tool-stack");
  assert.equal(await toolbar.count(), 1, "Scene comparison expects one HTML viewport toolbar");
  assert(await toolbar.isVisible(), "Scene comparison toolbar must be visible");
  const samples = [];
  let previous;
  let identical = 0;
  const deadline = Date.now() + 6_000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(250);
    // Rounded backdrop-filter toolbar edges can composite a few pixels
    // differently after unrelated material switches. Compare scene pixels;
    // full-page screenshots below keep this small HTML overlay unmasked.
    const image = await canvas.screenshot({ mask: [toolbar], maskColor: "#000000" });
    const hash = checksum(image);
    samples.push(hash);
    identical = hash === previous ? identical + 1 : 0;
    previous = hash;
    // Require three identical frames across separate render intervals.
    if (identical >= 2) {
      await writeFile(artifactPath, image);
      return { image, sha256: hash, samples };
    }
    await writeFile(artifactPath, image);
  }
  throw new Error(`Canvas did not settle within six seconds; last frame: ${artifactPath}; hashes: ${samples.join(", ")}`);
}

async function compareRestoration(before, after) {
  if (before.sha256 === after.sha256) return { exact: true, maxChannelDelta: 0, changedPixels: 0, changedPixelFraction: 0 };
  // Next's installed image runtime decodes the PNG without adding a dependency.
  const { default: sharp } = await import("sharp");
  const first = await sharp(before.image).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const second = await sharp(after.image).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual(second.info, first.info, "Texture toggle must preserve canvas image dimensions");
  let maxChannelDelta = 0;
  let changedPixels = 0;
  for (let offset = 0; offset < first.data.length; offset += first.info.channels) {
    let changed = false;
    for (let channel = 0; channel < first.info.channels; channel++) {
      const delta = Math.abs(first.data[offset + channel] - second.data[offset + channel]);
      maxChannelDelta = Math.max(maxChannelDelta, delta);
      changed ||= delta !== 0;
    }
    if (changed) changedPixels++;
  }
  return { exact: false, maxChannelDelta, changedPixels, changedPixelFraction: changedPixels / (first.info.width * first.info.height) };
}

/** Checks user-ROM data through the same narrow preload bridge used by the UI. */
export async function checkTexturedRooms(page, artifacts, roomIds = [0, 465, 376, 322]) {
  const results = [];
  for (const roomId of roomIds) {
    const data = await page.evaluate(async (id) => {
      const room = await window.mnsg.loadRoom(id);
      const textures = room.textures ?? [];
      const pixels = new Map();
      let diverseTextures = 0;
      for (const texture of textures) {
        if (!texture.id || pixels.has(texture.id)) throw new Error("Texture IDs must be unique.");
        if (!Number.isInteger(texture.width) || !Number.isInteger(texture.height) || texture.width <= 0 || texture.height <= 0 || texture.width > 4096 || texture.height > 4096) throw new Error("Invalid ROM texture dimensions.");
        const bytes = atob(texture.rgbaBase64);
        if (bytes.length !== texture.width * texture.height * 4) throw new Error("Decoded ROM texture byte count is inconsistent.");
        const colors = new Set();
        let visible = 0;
        for (let offset = 0; offset < bytes.length; offset += 4) {
          if (bytes.charCodeAt(offset + 3)) { visible++; if (colors.size < 16) colors.add(bytes.slice(offset, offset + 3)); }
        }
        if (colors.size > 2 && visible) diverseTextures++;
        pixels.set(texture.id, { visible, format: texture.format });
      }
      const mapped = room.meshes.filter((mesh) => mesh.material?.textureId);
      for (const mesh of mapped) {
        if (!pixels.has(mesh.material.textureId)) throw new Error("Mesh references a missing ROM texture.");
        if (mesh.source !== "display-list") throw new Error("Texture binding must come from native visual geometry.");
        if (mesh.uvs?.length !== mesh.positions.length / 3 * 2 || mesh.uvs.some((value) => !Number.isFinite(value))) throw new Error("Textured mesh has invalid UV data.");
      }
      const formatTriangles = {};
      for (const mesh of mapped) {
        const format = pixels.get(mesh.material.textureId).format;
        formatTriangles[format] = (formatTriangles[format] ?? 0) + mesh.indices.length / 3;
      }
      const secondaryTranslucent = room.meshes.filter((mesh) => mesh.id.startsWith("secondary:") && mesh.material?.opacity < 1);
      for (const mesh of room.meshes) {
        if (mesh.material && (!Number.isFinite(mesh.material.opacity) || mesh.material.opacity < 0 || mesh.material.opacity > 1)) throw new Error("Invalid native surface opacity.");
      }
      return { roomId: id, textureCount: textures.length, mappedMeshCount: mapped.length, mappedTriangleCount: mapped.reduce((sum, mesh) => sum + mesh.indices.length / 3, 0), diverseTextures, formats: [...new Set(textures.map((texture) => texture.format))], formatTriangles, secondaryTranslucentTriangleCount: secondaryTranslucent.reduce((sum, mesh) => sum + mesh.indices.length / 3, 0), secondaryOpacities: [...new Set(secondaryTranslucent.map((mesh) => mesh.material.opacity))], dimensions: textures.map(({ width, height }) => ({ width, height })) };
    }, roomId);
    assert(data.textureCount > 0 && data.mappedMeshCount > 0, `Room ${roomId} must contain decoded ROM textures and material bindings`);
    assert(data.diverseTextures > 0, `Room ${roomId} must contain visible nonuniform ROM imagery`);
    if (roomId === 376) {
      assert(data.formats.includes("CI4/TLUTRGBA16"), "Room 376 must retain native CI4 palette decoding");
      assert.equal(data.formatTriangles["CI4/TLUTRGBA16"], 98, "Room 376 must bind all 98 native CI4 triangles");
    }
    if (roomId === 322) {
      assert.equal(data.secondaryTranslucentTriangleCount, 61, "Room 322 must preserve its 61 translucent secondary triangles");
      assert.deepEqual(data.secondaryOpacities, [127 / 255], "Room 322 must preserve native secondary primitive alpha");
    }
    await page.locator(`[data-testid="room-button"][data-room-id="${roomId}"]`).click();
    await page.waitForFunction((id) => document.querySelector(`[data-testid="room-button"][data-room-id="${id}"]`)?.getAttribute("aria-current") === "true", roomId);
    const scene = page.getByTestId("workspace-panel-scene");
    const toggle = scene.getByTestId("textures-toggle");
    assert.equal(await toggle.getAttribute("aria-pressed"), "true", "ROM textures must be enabled by default");
    await scene.getByRole("button", { name: "Frame all geometry", exact: true }).click();
    const host = scene.getByTestId("viewport-canvas");
    await page.waitForFunction((triangles) => Number(document.querySelector('[data-testid="viewport-canvas"]')?.getAttribute("data-textured-triangles")) === triangles, data.mappedTriangleCount);
    const canvas = host.locator("canvas");
    const actorsToggle = scene.getByRole("button", { name: "Actors", exact: true }).and(scene.locator(".view-toggle"));
    const hideHouseMarkers = roomId === 465 && await actorsToggle.getAttribute("aria-pressed") === "true";
    if (roomId === 465) {
      if (hideHouseMarkers) await actorsToggle.click();
      // Enter below the ceiling rather than stopping against its wood surface.
      await canvas.hover();
      await page.mouse.wheel(0, -3600);
    }
    const stem = `room-${roomId.toString(16).padStart(3, "0")}`;
    const textured = await settledCanvas(page, canvas, path.join(artifacts, `${stem}-textured-canvas.png`));
    const texturedPath = path.join(artifacts, `${stem}-textured.png`);
    await page.screenshot({ path: texturedPath, fullPage: true });
    await toggle.click();
    assert.equal(await toggle.getAttribute("aria-pressed"), "false");
    const solid = await settledCanvas(page, canvas, path.join(artifacts, `${stem}-solid-canvas.png`));
    assert.notEqual(textured.sha256, solid.sha256, `Room ${roomId} textured and solid views must render differently`);
    const solidPath = path.join(artifacts, `${stem}-solid.png`);
    await page.screenshot({ path: solidPath, fullPage: true });
    await toggle.click();
    assert.equal(await toggle.getAttribute("aria-pressed"), "true");
    const restored = await settledCanvas(page, canvas, path.join(artifacts, `${stem}-restored-canvas.png`));
    const restoredPath = path.join(artifacts, `${stem}-restored.png`);
    await page.screenshot({ path: restoredPath, fullPage: true });
    const restoration = await compareRestoration(textured, restored);
    await writeFile(path.join(artifacts, `${stem}-frame-checks.json`), `${JSON.stringify({ textured: textured.samples, solid: solid.samples, restored: restored.samples, restoration }, null, 2)}\n`);
    assert.equal(restored.sha256, textured.sha256, `Room ${roomId} texture toggle must exactly restore the settled scene image: ${JSON.stringify(restoration)}`);
    const renderedTextureCount = Number(await host.getAttribute("data-texture-count"));
    assert(renderedTextureCount > 0, `Room ${roomId} renderer must bind actual ROM texture images`);
    results.push({ ...data, renderedTextureCount, texturedPath, solidPath, restoredPath, sceneComparisonMask: ".view-tool-stack HTML overlay only", texturedCanvasSha256: textured.sha256, solidCanvasSha256: solid.sha256, restoredCanvasSha256: restored.sha256, settledFrameSamples: { textured: textured.samples.length, solid: solid.samples.length, restored: restored.samples.length }, restoration, restored: true });
    if (hideHouseMarkers) await actorsToggle.click();
  }
  await writeFile(path.join(artifacts, "texture-checks.json"), `${JSON.stringify(results, null, 2)}\n`);
  return results;
}
