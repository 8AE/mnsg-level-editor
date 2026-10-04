import { MOUSE } from "three";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
export type CameraMouseMode = "pan" | "tilt";
/** Mapping changes affect the next gesture; active orbit/gizmo state is untouched. */
export function applyCameraMouseMode(
  controls: Pick<OrbitControls, "mouseButtons">,
  mode: CameraMouseMode,
): void {
  controls.mouseButtons.LEFT = mode === "pan" ? MOUSE.PAN : MOUSE.ROTATE;
  controls.mouseButtons.RIGHT = MOUSE.PAN;
  controls.mouseButtons.MIDDLE = MOUSE.DOLLY;
}
