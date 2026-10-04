import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { applyCameraMouseMode } from "../components/cameraMouse";
import { CameraKeyboardControls } from "../components/cameraControls";
function setup() {
  const document = new EventTarget();
  const canvas = Object.assign(new EventTarget(), {
    style: { touchAction: "" },
    ownerDocument: document,
    clientWidth: 800,
    clientHeight: 500,
    getRootNode: () => document,
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
  }) as unknown as HTMLElement;
  const camera = new THREE.PerspectiveCamera(42, 1.6, 0.1, 10000);
  camera.position.set(100, 200, 300);
  const orbit = new OrbitControls(camera, canvas);
  orbit.enableDamping = false;
  orbit.target.set(0, 0, 0);
  orbit.update();
  const pointer = (
    target: EventTarget,
    type: string,
    x: number,
    y: number,
    button = 0,
  ) => {
    const event = Object.assign(new Event(type, { cancelable: true }), {
      pointerId: 1,
      pointerType: "mouse",
      clientX: x,
      clientY: y,
      pageX: x,
      pageY: y,
      button,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
    });
    target.dispatchEvent(event);
  };
  const drag = (button = 0) => {
    pointer(canvas, "pointerdown", 200, 200, button);
    pointer(document, "pointermove", 260, 220, button);
    pointer(document, "pointerup", 260, 220, button);
  };
  return { camera, orbit, canvas, document, pointer, drag };
}
test("Pan/Tilt only remaps mouse buttons, leaving camera, target and disabled gizmo guard intact", () => {
  const { camera, orbit } = setup();
  const position = camera.position.clone(),
    target = orbit.target.clone();
  orbit.enabled = false;
  applyCameraMouseMode(orbit, "pan");
  assert.equal(orbit.mouseButtons.LEFT, THREE.MOUSE.PAN);
  assert.equal(orbit.mouseButtons.RIGHT, THREE.MOUSE.PAN);
  assert.equal(orbit.mouseButtons.MIDDLE, THREE.MOUSE.DOLLY);
  assert.equal(orbit.enabled, false);
  assert.deepEqual(camera.position.toArray(), position.toArray());
  assert.deepEqual(orbit.target.toArray(), target.toArray());
  applyCameraMouseMode(orbit, "tilt");
  assert.equal(orbit.mouseButtons.LEFT, THREE.MOUSE.ROTATE);
  assert.equal(orbit.enabled, false);
  orbit.dispose();
});
test("real primary Pan moves eye and target together; Tilt changes eye around target; right drag remains pan", () => {
  for (const mode of ["pan", "tilt"] as const) {
    const { camera, orbit, drag } = setup();
    applyCameraMouseMode(orbit, mode);
    const eye = camera.position.clone(),
      target = orbit.target.clone(),
      offset = eye.clone().sub(target);
    drag();
    assert.ok(camera.position.distanceTo(eye) > 1);
    if (mode === "pan") {
      assert.ok(orbit.target.distanceTo(target) > 1);
      assert.ok(
        camera.position.clone().sub(orbit.target).distanceTo(offset) < 1e-8,
      );
    } else assert.ok(orbit.target.distanceTo(target) < 1e-8);
    const before = camera.position.clone().sub(orbit.target);
    drag(2);
    assert.ok(
      camera.position.clone().sub(orbit.target).distanceTo(before) < 1e-8,
    );
    orbit.dispose();
  }
});
test("changing preference during a gesture preserves that gesture and orbit events continue to isolate WASD", () => {
  const { camera, orbit, canvas, document, pointer } = setup();
  const keyboard = new CameraKeyboardControls(camera, orbit.target),
    context = { focused: true, typing: false, blocked: false };
  orbit.addEventListener("start", () => keyboard.beginGesture("orbit"));
  orbit.addEventListener("end", () => keyboard.endGesture("orbit"));
  keyboard.keyDown({ key: "w", preventDefault() {} }, context);
  applyCameraMouseMode(orbit, "tilt");
  pointer(canvas, "pointerdown", 200, 200);
  const target = orbit.target.clone();
  applyCameraMouseMode(orbit, "pan");
  pointer(document, "pointermove", 260, 220);
  assert.ok(
    orbit.target.distanceTo(target) < 1e-8,
    "mapping does not change active Tilt gesture",
  );
  assert.equal(keyboard.step(0.1, context), false);
  pointer(document, "pointerup", 260, 220);
  assert.equal(
    keyboard.step(0.1, context),
    false,
    "fresh keyboard press required",
  );
  const eye = camera.position.clone();
  pointer(canvas, "pointerdown", 200, 200);
  pointer(document, "pointerup", 200, 200);
  assert.ok(
    camera.position.distanceTo(eye) < 1e-8,
    "click without drag keeps picking camera stable",
  );
  orbit.dispose();
});
