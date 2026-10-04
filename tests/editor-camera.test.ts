import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { bindCameraKeyboardInput, CAMERA_MOVE_SPEED, CameraKeyboardControls, cancelTransformPreview, type NavigationContext, type NavigationKeyEvent } from "../components/cameraControls";

const active: NavigationContext = { focused: true, typing: false, blocked: false };
function setup() {
  const camera = new THREE.PerspectiveCamera(42, 1, 0.5, 250000);
  camera.position.set(100, 200, 300);
  const target = new THREE.Vector3(100, 200, 0);
  camera.lookAt(target);
  return { camera, target, controls: new CameraKeyboardControls(camera, target) };
}
function key(key: string, extra: Partial<NavigationKeyEvent> = {}) {
  let prevented = false;
  return { event: { key, preventDefault() { prevented = true; }, ...extra }, prevented: () => prevented };
}
function close(actual: THREE.Vector3, expected: THREE.Vector3) { assert.ok(actual.distanceTo(expected) < 1e-8, `${actual.toArray()} != ${expected.toArray()}`); }

test("WASD uses the camera's current forward/right, preserves orbit offset and changes the view", () => {
  const { camera, target, controls } = setup();
  target.set(-200, 450, -100);
  camera.lookAt(target);
  camera.updateMatrixWorld();
  const beforePosition = camera.position.clone(), beforeTarget = target.clone(), quaternion = camera.quaternion.clone();
  const landmark = new THREE.Vector3(40, 0, 0);
  const projectedBefore = landmark.clone().project(camera);
  const forward = camera.getWorldDirection(new THREE.Vector3());
  controls.keyDown(key("w").event, active);
  assert.equal(controls.step(0.05, active), true);
  close(camera.position, beforePosition.clone().addScaledVector(forward, CAMERA_MOVE_SPEED * 0.05));
  close(target, beforeTarget.clone().addScaledVector(forward, CAMERA_MOVE_SPEED * 0.05));
  close(camera.position.clone().sub(target), beforePosition.clone().sub(beforeTarget));
  assert.deepEqual(camera.quaternion.toArray(), quaternion.toArray());
  camera.updateMatrixWorld();
  assert.ok(landmark.clone().project(camera).distanceTo(projectedBefore) > 0.001, "navigation changes the rendered view of stationary geometry");
  controls.clear();
  const start = camera.position.clone();
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
  controls.keyDown(key("d").event, active); controls.step(0.05, active);
  close(camera.position, start.clone().addScaledVector(right, CAMERA_MOVE_SPEED * 0.05));
  controls.keyUp({ key: "d" }); controls.keyDown(key("a").event, active); controls.step(0.05, active);
  close(camera.position, start);
  controls.keyUp({ key: "a" }); controls.keyDown(key("s").event, active); controls.step(0.05, active);
  close(camera.position, beforePosition);
});

test("movement speed is frame-rate independent, diagonals normalize and opposing keys cancel", () => {
  for (const fps of [30, 60, 144]) {
    for (const keys of [["w"], ["w", "d"]]) {
      const { camera, controls } = setup();
      const before = camera.position.clone();
      keys.forEach(value => controls.keyDown(key(value).event, active));
      for (let frame = 0; frame < fps; frame++) controls.step(1 / fps, active);
      assert.ok(Math.abs(camera.position.distanceTo(before) - CAMERA_MOVE_SPEED) < 1e-8);
    }
  }
  const { camera, controls } = setup();
  const before = camera.position.clone();
  ["w", "s", "a", "d"].forEach(value => controls.keyDown(key(value).event, active));
  assert.equal(controls.step(0.1, active), false); close(camera.position, before);
  controls.clear(); controls.keyDown(key("w").event, active);
  controls.step(8, active);
  assert.ok(Math.abs(camera.position.distanceTo(before) - CAMERA_MOVE_SPEED * 0.1) < 1e-8, "suspended frames cannot teleport the camera");
  for (const invalid of [0, -1, NaN, Infinity]) assert.equal(controls.step(invalid, active), false);
});

test("only focused movement prevents default; typing, dialogs and modifiers clear held keys", () => {
  const { camera, controls } = setup();
  const before = camera.position.clone();
  for (const context of [{ ...active, focused: false }, { ...active, typing: true }, { ...active, blocked: true }]) {
    const input = key("w"); assert.equal(controls.keyDown(input.event, context), false); assert.equal(input.prevented(), false);
    assert.equal(controls.step(0.05, active), false);
    controls.keyDown(key("w").event, active);
    assert.equal(controls.step(0.05, context), false, "losing permission clears an existing hold");
    assert.equal(controls.step(0.05, active), false);
  }
  for (const modifier of ["ctrlKey", "metaKey", "altKey", "shiftKey", "isComposing"] as const) {
    controls.keyDown(key("w").event, active);
    const input = key("w", { [modifier]: true });
    assert.equal(controls.keyDown(input.event, active), false); assert.equal(input.prevented(), false);
    assert.equal(controls.step(0.05, active), false);
  }
  const unrelated = key("f"); assert.equal(controls.keyDown(unrelated.event, active), false); assert.equal(unrelated.prevented(), false);
  const movement = key("W"); assert.equal(controls.keyDown(movement.event, active), true); assert.equal(movement.prevented(), true);
  controls.clear();
  const repeat = key("w", { repeat: true }); assert.equal(controls.keyDown(repeat.event, active), false); assert.equal(repeat.prevented(), false);
  close(camera.position, before);
});

test("orbit/transform gestures synchronously stop holds and require a fresh press after ending", () => {
  const { controls } = setup();
  for (const source of ["orbit", "transform"] as const) {
    controls.keyDown(key("w").event, active);
    controls.beginGesture(source);
    assert.equal(controls.step(0.01, active), false);
    const duringGesture = key("d");
    assert.equal(controls.keyDown(duringGesture.event, active), false);
    assert.equal(duringGesture.prevented(), false);
    controls.endGesture(source);
    assert.equal(controls.step(0.01, active), false);
    assert.equal(controls.keyDown(key("w", { repeat: true }).event, active), false);
    assert.equal(controls.keyDown(key("w").event, active), true);
    assert.equal(controls.step(0.01, active), true);
    controls.clear();
    controls.keyDown(key("w").event, active);
    controls.beginGesture(source); controls.endGesture(source);
    assert.equal(controls.step(0.01, active), false, "a complete gesture between frames still cancels the old hold");
  }
  controls.beginGesture("orbit"); controls.beginGesture("transform"); controls.endGesture("orbit");
  assert.equal(controls.keyDown(key("w").event, active), false, "ending one gesture must not release another control's block");
  controls.cancelGestures();
  assert.equal(controls.keyDown(key("w").event, active), true);
});

test("real TransformControls cancellation restores source placement without committing and unlocks orbit/navigation", () => {
  const { camera, controls } = setup();
  const scene = new THREE.Scene(), object = new THREE.Object3D();
  object.position.set(4, 5, 6); scene.add(object);
  const canvas = Object.assign(new EventTarget(), { style: { touchAction: "" } }) as unknown as HTMLElement;
  const transform = new TransformControls(camera, canvas);
  scene.add(transform.getHelper()); transform.attach(object);
  const orbit = { enabled: true };
  let commits = 0, moving = false;
  transform.addEventListener("mouseUp", () => { commits++; });
  transform.addEventListener("dragging-changed", event => {
    moving = Boolean(event.value); orbit.enabled = !moving;
    if (moving) controls.beginGesture("transform"); else controls.endGesture("transform");
  });
  scene.updateMatrixWorld(); camera.updateMatrixWorld();
  transform.axis = "X";
  // Three consumes normalized x/y/button here, despite the DOM PointerEvent type.
  transform.pointerDown({ x: 0, y: 0, button: 0 } as PointerEvent);
  assert.equal(transform.dragging, true); assert.equal(moving, true); assert.equal(orbit.enabled, false);
  object.position.set(900, 5, 6);
  cancelTransformPreview(transform, { x: 4, y: 5, z: 6 });
  controls.cancelGestures();
  assert.equal(commits, 0, "cancel must never emit the committing mouseUp event");
  assert.deepEqual(object.position.toArray(), [4, 5, 6]);
  assert.equal(transform.dragging, false); assert.equal(transform.axis, null);
  assert.equal(moving, false); assert.equal(orbit.enabled, true);
  assert.equal(controls.keyDown(key("w").event, active), true);
  assert.equal(controls.step(0.01, { ...active, blocked: moving }), true);
  transform.dispose();
});

test("input binding clears holds on canvas/window blur, hiding and detach until a fresh keydown", () => {
  const { controls } = setup();
  const targets = { keyboard: new EventTarget(), canvas: new EventTarget(), window: new EventTarget(), document: new EventTarget() };
  let context = active, hidden = false;
  const detach = bindCameraKeyboardInput(controls, targets, () => context, () => hidden);
  const dispatchKey = (type: string, value = "w", repeat = false) => {
    const event = new Event(type, { cancelable: true });
    Object.assign(event, { key: value, repeat });
    targets.keyboard.dispatchEvent(event); return event;
  };
  for (const trigger of [() => targets.canvas.dispatchEvent(new Event("blur")), () => targets.window.dispatchEvent(new Event("blur")), () => targets.canvas.dispatchEvent(new Event("pointercancel")), () => targets.canvas.dispatchEvent(new Event("lostpointercapture")), () => { hidden = true; targets.document.dispatchEvent(new Event("visibilitychange")); hidden = false; }]) {
    assert.equal(dispatchKey("keydown").defaultPrevented, true);
    assert.equal(controls.step(0.01, active), true);
    trigger(); assert.equal(controls.step(0.01, active), false);
    assert.equal(dispatchKey("keydown", "w", true).defaultPrevented, false);
    assert.equal(controls.step(0.01, active), false, "auto-repeat cannot resume a blurred hold");
    controls.beginGesture("orbit"); trigger();
    assert.equal(dispatchKey("keydown").defaultPrevented, true, "canceling a gesture must not leave navigation latched off");
    controls.clear();
  }
  for (const gate of [{ ...active, focused: false }, { ...active, typing: true }, { ...active, blocked: true }]) {
    context = gate;
    assert.equal(dispatchKey("keydown").defaultPrevented, false);
    assert.equal(controls.step(0.01, active), false);
  }
  context = active;
  dispatchKey("keydown"); dispatchKey("keyup"); assert.equal(controls.step(0.01, active), false);
  dispatchKey("keydown"); detach(); assert.equal(controls.step(0.01, active), false);
  assert.equal(dispatchKey("keydown").defaultPrevented, false);
  assert.equal(controls.step(0.01, active), false, "unmounted viewport has no live keyboard listeners");
});
