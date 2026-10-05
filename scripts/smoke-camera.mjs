import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import * as THREE from "three";

const hash = (value) => createHash("sha256").update(value).digest("hex");
// The observational pose attributes round native camera doubles to five decimals.
const POSE_EPSILON = 1e-4;
const subtract = (a, b) => a.map((value, index) => value - b[index]);
const magnitude = (vector) => Math.hypot(...vector);
const normalize = (vector) => vector.map((value) => value / magnitude(vector));
const dot = (a, b) => a.reduce((sum, value, index) => sum + value * b[index], 0);
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().filter((key) => key !== "updatedAt").map((key) => [key, canonical(value[key])])) : value;
const fingerprint = (project) => hash(JSON.stringify(canonical(project)));

export async function cameraState(host) {
  return host.evaluate((element) => {
    const read = (name) => {
      const value = element.getAttribute(name);
      if (!value) throw new Error(`Missing observational camera attribute ${name}`);
      const vector = value.trim().startsWith("[") ? JSON.parse(value) : value.split(",").map(Number);
      if (!Array.isArray(vector) || vector.length !== 3 || vector.some((axis) => !Number.isFinite(axis))) throw new Error(`Invalid ${name}: ${value}`);
      return vector;
    };
    return { position: read("data-camera-position"), target: read("data-camera-target") };
  });
}

async function assertStopped(page, host, label) {
  // Orbit damping may need a frame after focus changes; movement must then stop.
  await page.waitForTimeout(150);
  const before = await cameraState(host);
  await page.waitForTimeout(300);
  const after = await cameraState(host);
  assert(magnitude(subtract(after.position, before.position)) < POSE_EPSILON, `${label}: camera position must stop`);
  assert(magnitude(subtract(after.target, before.target)) < POSE_EPSILON, `${label}: orbit target must stop`);
  return after;
}

export async function settlePose(page, host) {
  let previous = await cameraState(host);
  let stable = 0;
  const deadline = Date.now() + 6_000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(250);
    const current = await cameraState(host);
    stable = magnitude(subtract(current.position, previous.position)) < POSE_EPSILON
      && magnitude(subtract(current.target, previous.target)) < POSE_EPSILON ? stable + 1 : 0;
    previous = current;
    if (stable >= 2) return current;
  }
  throw new Error("Orbit gesture did not settle within six seconds");
}

export async function snapshot(page, canvas, destination) {
  const toolbar = page.getByTestId("workspace-panel-scene").locator(".view-tool-stack");
  assert.equal(await toolbar.count(), 1);
  assert(await toolbar.isVisible());
  await page.mouse.move(0, 0);
  let previous;
  let repeated = 0;
  const hashes = [];
  const deadline = Date.now() + 6_000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(250);
    const image = await canvas.screenshot({ mask: [toolbar], maskColor: "#000000" });
    const checksum = hash(image);
    hashes.push(checksum);
    repeated = checksum === previous ? repeated + 1 : 0;
    previous = checksum;
    await writeFile(destination, image);
    if (repeated >= 2) return { path: destination, sha256: checksum, stableFrames: 3, samples: hashes.length };
  }
  throw new Error(`Camera screenshot failed to settle: ${destination}; ${hashes.join(", ")}`);
}

async function checkTransformGestures(page, host, canvas, input, gizmo, artifacts) {
  if (await host.getAttribute("data-transform-dragging") === null) return { skipped: "This camera-only build lacks transform observation metadata." };
  const enabledBefore = await gizmo.getAttribute("aria-pressed");
  // Use the same first position-vector row as the camera helper's X input.
  const positionInputs = page.locator(".inspector-content .vector-fields").first().locator("input");
  const baseline = await positionInputs.evaluateAll((fields) => fields.map((field) => Number(field.value)));
  assert.equal(baseline.length, 3);
  const preview = async () => {
    const value = await host.getAttribute("data-transform-preview-position");
    assert(value, "The translation gizmo must have a real attached actor");
    return value.split(",").map(Number);
  };
  const hitXAxis = async () => {
    await page.getByTestId("workspace-panel-scene").getByRole("button", { name: "Frame selected record", exact: true }).click();
    await settlePose(page, host);
    const pose = await cameraState(host);
    const box = await canvas.boundingBox();
    assert(box);
    const camera = new THREE.PerspectiveCamera(42, box.width / box.height, 0.5, 250000);
    camera.position.fromArray(pose.position);
    camera.lookAt(new THREE.Vector3().fromArray(pose.target));
    camera.updateMatrixWorld();
    const origin = new THREE.Vector3().fromArray(await preview());
    // Three's public TransformControls uses this perspective size factor.
    // Hover observations confirm the real picker hit before any button press.
    const scale = origin.distanceTo(camera.position) * Math.min(1.9 * Math.tan(Math.PI * camera.fov / 360), 7) / 4;
    for (const offset of [0.45, 0.52, 0.35, 0.3, 0.55, -0.45, -0.52]) {
      const projected = origin.clone().add(new THREE.Vector3(scale * offset, 0, 0)).project(camera);
      const pointer = { x: box.x + (projected.x + 1) / 2 * box.width, y: box.y + (1 - projected.y) / 2 * box.height };
      await page.mouse.move(pointer.x, pointer.y);
      if (await host.getAttribute("data-transform-axis") === "X") return { pointer, camera, origin, box, scale };
    }
    throw new Error("Could not hit the actual TransformControls X-axis picker");
  };
  const startDrag = async () => {
    const hit = await hitXAxis();
    await page.mouse.down({ button: "left" });
    await page.waitForFunction(() => document.querySelector('[data-testid="viewport-canvas"]')?.getAttribute("data-transform-dragging") === "true");
    const projected = hit.origin.clone().add(new THREE.Vector3(hit.scale * 0.9, 0, 0)).project(hit.camera);
    const end = { x: hit.box.x + (projected.x + 1) / 2 * hit.box.width, y: hit.box.y + (1 - projected.y) / 2 * hit.box.height };
    await page.mouse.move(end.x, end.y, { steps: 8 });
    const moved = await preview();
    assert(magnitude(subtract(moved, baseline)) > 1, "A real gizmo drag must move the temporary actor preview");
    assert.equal(await page.locator(".dirty-state").count(), 0, "Gizmo preview must stay uncommitted until normal pointer drop");
    return { start: hit.pointer, end, preview: moved };
  };
  try {
    if (enabledBefore !== "true") await gizmo.click();
    const canceled = await startDrag();
    await input.focus();
    await page.waitForFunction(() => document.querySelector('[data-testid="viewport-canvas"]')?.getAttribute("data-transform-dragging") === "false");
    assert(magnitude(subtract(await preview(), baseline)) < POSE_EPSILON, "Canvas blur must discard the actual gizmo preview");
    await page.mouse.up({ button: "left" });
    await page.waitForTimeout(250);
    assert.equal(await page.locator(".dirty-state").count(), 0, "Late pointerup after cancellation must not commit an actor edit");
    assert.deepEqual(await positionInputs.evaluateAll((fields) => fields.map((field) => Number(field.value))), baseline);

    const dropped = await startDrag();
    const expected = dropped.preview.map(Math.round);
    await page.mouse.up({ button: "left" });
    await page.locator(".dirty-state").waitFor();
    await page.waitForFunction((coordinates) => {
      const fields = document.querySelector('.inspector-content .vector-fields')?.querySelectorAll('input');
      return fields?.length === 3 && [...fields].every((field, index) => Number(field.value) === coordinates[index]);
    }, expected);
    // Give the browser's normal lostpointercapture delivery time to occur.
    await page.waitForTimeout(300);
    assert.deepEqual(await positionInputs.evaluateAll((fields) => fields.map((field) => Number(field.value))), expected, "Normal drop must retain its committed coordinates after lost capture");
    assert.equal(await host.getAttribute("data-transform-dragging"), "false");
    const image = path.join(artifacts, "camera-gizmo-normal-drop.png");
    await page.screenshot({ path: image, fullPage: true });
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await page.locator(".dirty-state").waitFor({ state: "hidden" });
    assert.deepEqual(await positionInputs.evaluateAll((fields) => fields.map((field) => Number(field.value))), baseline, "One Undo must restore the project after one normal drop");
    return { canceled, dropped, expected, image, cancellationDiscardsPreview: true, normalDropCommitsOnce: true };
  } finally {
    await page.mouse.up({ button: "left" }).catch(() => {});
    if (enabledBefore !== "true" && await gizmo.getAttribute("aria-pressed") === "true") await gizmo.click();
  }
}

/** Call after selecting a saved project's editable actor in the native app. */
export async function checkCameraNavigation(page, artifacts, { projectPath } = {}) {
  const scene = page.getByTestId("workspace-panel-scene");
  const host = scene.getByTestId("viewport-canvas");
  const canvas = scene.getByTestId("viewport-navigation-canvas");
  const frame = scene.getByRole("button", { name: "Frame all geometry", exact: true });
  const gizmo = scene.getByRole("button", { name: "Toggle translation gizmo", exact: true });
  const grid = scene.getByRole("button", { name: "Grid", exact: true }).and(scene.locator(".view-toggle"));
  const input = page.locator(".inspector-content .vector-fields").first().locator("input").first();
  await input.waitFor();
  assert(await input.isEnabled(), "Camera smoke requires an editable actor inspector");
  assert.equal(await page.locator(".dirty-state").count(), 0, "Camera smoke starts with a saved project");
  const initialProject = projectPath ? JSON.parse(await readFile(projectPath, "utf8")) : (await page.evaluate(() => window.mnsg.getStatus())).project;
  assert(initialProject, "Camera smoke requires a native project");
  const projectFingerprint = fingerprint(initialProject);
  const report = { projectFingerprint, movements: [], sceneComparisonMask: ".view-tool-stack HTML overlay only" };
  try {
    for (const key of ["w", "s", "a", "d"]) {
      await frame.click();
      await canvas.focus();
      assert(await canvas.evaluate((element) => document.activeElement === element), "Viewport canvas must own keyboard focus");
      assert(await page.evaluate(() => document.hasFocus()), "Native window needs focus or explicit test-only focus emulation");
      const beforeImage = await snapshot(page, canvas, path.join(artifacts, `camera-${key}-before.png`));
      const before = await cameraState(host);
      const forward = normalize(subtract(before.target, before.position));
      const right = normalize([-forward[2], 0, forward[0]]);
      const expected = (key === "w" || key === "s" ? forward : right).map((value) => value * (key === "s" || key === "a" ? -1 : 1));
      await page.keyboard.down(key);
      await page.waitForTimeout(300);
      await page.keyboard.up(key);
      const after = await assertStopped(page, host, `Releasing ${key.toUpperCase()}`);
      const delta = subtract(after.position, before.position);
      assert(magnitude(delta) > 1, `${key.toUpperCase()} must move the camera by a visible distance`);
      assert(dot(normalize(delta), expected) > 0.999, `${key.toUpperCase()} must move in its declared camera direction`);
      assert(magnitude(subtract(subtract(after.target, before.target), delta)) < POSE_EPSILON, "Navigation must translate the eye and orbit target together");
      const afterImage = await snapshot(page, canvas, path.join(artifacts, `camera-${key}-after.png`));
      assert.notEqual(afterImage.sha256, beforeImage.sha256, `${key.toUpperCase()} must change rendered scene pixels`);
      const fullPage = path.join(artifacts, `camera-${key}-view.png`);
      await page.screenshot({ path: fullPage, fullPage: true });
      report.movements.push({ key, before, after, delta, beforeImage, afterImage, fullPage });
    }

    const gizmoBefore = await gizmo.getAttribute("aria-pressed");
    const gridBefore = await grid.getAttribute("aria-pressed");
    const originalValue = await input.inputValue();
    await input.fill("");
    const typingBefore = await cameraState(host);
    await input.pressSequentially("wasdftg", { delay: 40 });
    assert.equal(await input.inputValue(), "wasdftg", "Navigation letters must enter the focused inspector draft");
    const typingAfter = await assertStopped(page, host, "Typing in inspector");
    assert(magnitude(subtract(typingAfter.position, typingBefore.position)) < POSE_EPSILON, "Typing WASD/F in inspector must not move or frame the camera");
    assert.equal(await gizmo.getAttribute("aria-pressed"), gizmoBefore, "Typing T in inspector must not toggle the translation gizmo");
    assert.equal(await grid.getAttribute("aria-pressed"), gridBefore, "Typing G in inspector must not toggle the grid");
    await input.press("Escape");
    assert.equal(await input.inputValue(), originalValue, "Escape must cancel the inspector draft");
    report.inspectorTyping = "passed";

    await canvas.focus();
    const heldBefore = await cameraState(host);
    await page.keyboard.down("w");
    await page.waitForTimeout(250);
    await input.focus();
    const blurred = await assertStopped(page, host, "Blurring the viewport while W remains held");
    assert(magnitude(subtract(blurred.position, heldBefore.position)) > 1, "W must move before focus leaves the viewport");
    await canvas.focus();
    const refocused = await assertStopped(page, host, "Refocusing without a fresh keydown");
    assert(magnitude(subtract(refocused.position, blurred.position)) < POSE_EPSILON, "Refocus must not resume a stale held key");
    await page.keyboard.up("w");
    report.blurStopsHeldMovement = "passed";

    const modifiedBefore = await cameraState(host);
    await page.keyboard.down("Shift");
    await page.keyboard.down("w");
    const modifiedAfter = await assertStopped(page, host, "Shift-modified W");
    await page.keyboard.up("w");
    await page.keyboard.up("Shift");
    assert(magnitude(subtract(modifiedAfter.position, modifiedBefore.position)) < POSE_EPSILON, "Modified navigation keys must remain inactive");
    report.modifiedKeysIgnored = "passed";

    report.pointerGestures = [];
    for (const gesture of [{ name: "orbit", button: "left" }, { name: "pan", button: "right" }]) {
      await frame.click();
      await canvas.focus();
      const bounds = await canvas.boundingBox();
      assert(bounds);
      const pointer = { x: bounds.x + bounds.width * 0.55, y: bounds.y + bounds.height * 0.6 };
      await page.mouse.move(pointer.x, pointer.y);
      const heldStart = await cameraState(host);
      await page.keyboard.down("w");
      await page.waitForTimeout(250);
      await page.mouse.down({ button: gesture.button });
      const dragStart = await cameraState(host);
      assert(magnitude(subtract(dragStart.position, heldStart.position)) > 1, "W must move before the pointer gesture begins");
      await page.mouse.move(pointer.x + 80, pointer.y + 40, { steps: 8 });
      await page.waitForTimeout(150);
      const dragging = await cameraState(host);
      assert(magnitude(subtract(dragging.position, dragStart.position)) > 1, `${gesture.name} must perform a real camera gesture`);
      if (gesture.name === "orbit") {
        assert(magnitude(subtract(dragging.target, dragStart.target)) < POSE_EPSILON, "Held W must not translate the target during orbit drag");
        await page.waitForTimeout(250);
        assert(magnitude(subtract((await cameraState(host)).target, dragStart.target)) < POSE_EPSILON, "Orbit target must remain fixed while W is held during the drag");
      } else {
        assert(magnitude(subtract(dragging.target, dragStart.target)) > 1, "Right-button pan must move the orbit target");
        await settlePose(page, host);
        await assertStopped(page, host, "Holding the pan pointer stationary while W remains held");
      }
      await page.mouse.up({ button: gesture.button });
      const settled = await settlePose(page, host);
      await assertStopped(page, host, `Ending ${gesture.name} without releasing W`);
      await input.focus();
      await canvas.focus();
      const refocusedGesture = await assertStopped(page, host, `Refocusing after ${gesture.name} with a stale W hold`);
      assert(magnitude(subtract(refocusedGesture.position, settled.position)) < POSE_EPSILON, "Pointer gesture completion must not resume the old held key");
      await page.keyboard.up("w");
      await page.keyboard.down("w");
      await page.waitForTimeout(250);
      await page.keyboard.up("w");
      const freshKey = await assertStopped(page, host, `Fresh W after ${gesture.name}`);
      assert(magnitude(subtract(freshKey.position, settled.position)) > 1, "A fresh keydown must restore navigation after the gesture");
      const image = path.join(artifacts, `camera-${gesture.name}-gesture.png`);
      await page.screenshot({ path: image, fullPage: true });
      report.pointerGestures.push({ gesture: gesture.name, dragStart, dragging, settled, freshKey, image, staleHoldCleared: true });
    }
    report.transformGestures = await checkTransformGestures(page, host, canvas, input, gizmo, artifacts);

    assert.equal(await page.locator(".dirty-state").count(), 0, "Camera movement and cancelled typing must not dirty the project");
    if (projectPath) {
      // Save the actual UI project, so a renderer-only mutation cannot evade
      // comparison by leaving the main-process saved snapshot unchanged.
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await page.getByRole("status").filter({ hasText: `Saved ${path.basename(projectPath)}` }).waitFor();
      const finalProject = JSON.parse(await readFile(projectPath, "utf8"));
      assert.equal(fingerprint(finalProject), projectFingerprint, "Camera navigation must preserve the saved project data");
    } else {
      const finalProject = (await page.evaluate(() => window.mnsg.getStatus())).project;
      assert.equal(fingerprint(finalProject), projectFingerprint);
    }
    report.projectUnchanged = "passed";
    await frame.click();
    report.status = "passed";
    await writeFile(path.join(artifacts, "camera-checks.json"), `${JSON.stringify(report, null, 2)}\n`);
    return report;
  } catch (error) {
    report.status = "failed";
    report.error = error.message;
    await page.screenshot({ path: path.join(artifacts, "camera-failure.png"), fullPage: true }).catch(() => {});
    await writeFile(path.join(artifacts, "camera-checks.json"), `${JSON.stringify(report, null, 2)}\n`);
    throw error;
  } finally {
    for (const key of ["w", "a", "s", "d", "Shift"]) await page.keyboard.up(key).catch(() => {});
    for (const button of ["left", "right"]) await page.mouse.up({ button }).catch(() => {});
  }
}
