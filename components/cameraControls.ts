import * as THREE from "three";
import type { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import type { Vec3 } from "../shared/types";

export interface NavigationContext { focused: boolean; typing: boolean; blocked: boolean }
export interface NavigationKeyEvent {
  key: string;
  repeat?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  isComposing?: boolean;
  preventDefault(): void;
}

const movementKeys = new Set(["w", "a", "s", "d"]);
export const CAMERA_MOVE_SPEED = 350;

/** Cancel the unsaved gizmo preview without the mouseUp event that commits it. */
export function cancelTransformPreview(transform: TransformControls, sourcePosition?: Vec3): void {
  if (transform.dragging) transform.reset();
  if (transform.object && sourcePosition) transform.object.position.set(sourcePosition.x, sourcePosition.y, sourcePosition.z);
  transform.dragging = false;
  transform.axis = null;
}

/** Async model refreshes may update source data while an unsaved drag is active. */
export function syncMarkerPosition(marker: THREE.Object3D | undefined, sourcePosition: Vec3, transform: TransformControls): void {
  if (!marker || (transform.dragging && transform.object === marker)) return;
  marker.position.set(sourcePosition.x, sourcePosition.y, sourcePosition.z);
}

export function syncTransformAttachment(transform: TransformControls, desired: THREE.Object3D | undefined, cancel: () => void): void {
  if (transform.object === desired) return;
  if (transform.dragging) cancel();
  transform.detach(); if (desired) transform.attach(desired);
}

/** Hold-to-move state is separate from project state and OrbitControls gestures. */
export class CameraKeyboardControls {
  private readonly held = new Set<string>();
  private readonly gestures = new Set<"orbit" | "transform">();
  private readonly forward = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly delta = new THREE.Vector3();
  constructor(private readonly camera: THREE.Camera, private readonly orbitTarget: THREE.Vector3, private readonly speed = CAMERA_MOVE_SPEED) {}

  keyDown(event: NavigationKeyEvent, context: NavigationContext): boolean {
    if (!this.allowed(context) || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.isComposing) { this.clear(); return false; }
    const key = event.key.toLowerCase();
    if (!movementKeys.has(key) || (event.repeat && !this.held.has(key))) return false;
    this.held.add(key); event.preventDefault(); return true;
  }

  keyUp(event: Pick<NavigationKeyEvent, "key">): void { this.held.delete(event.key.toLowerCase()); }
  clear(): void { this.held.clear(); }
  beginGesture(source: "orbit" | "transform"): void { this.clear(); this.gestures.add(source); }
  endGesture(source: "orbit" | "transform"): void { this.gestures.delete(source); }
  cancelGestures(): void { this.clear(); this.gestures.clear(); }

  step(deltaSeconds: number, context: NavigationContext): boolean {
    if (!this.allowed(context)) { this.clear(); return false; }
    if (!Number.isFinite(deltaSeconds) || deltaSeconds <= 0 || !this.held.size) return false;
    const forward = Number(this.held.has("w")) - Number(this.held.has("s"));
    const right = Number(this.held.has("d")) - Number(this.held.has("a"));
    if (!forward && !right) return false;
    this.camera.getWorldDirection(this.forward);
    this.right.set(1, 0, 0).applyQuaternion(this.camera.quaternion).normalize();
    this.delta.copy(this.forward).multiplyScalar(forward).addScaledVector(this.right, right).normalize();
    // Clamp suspended/very slow frames so restoring a hidden window cannot teleport.
    this.delta.multiplyScalar(this.speed * Math.min(deltaSeconds, 0.1));
    this.camera.position.add(this.delta); this.orbitTarget.add(this.delta);
    return true;
  }

  private allowed(context: NavigationContext): boolean { return context.focused && !context.typing && !context.blocked && !this.gestures.size; }
}

export function bindCameraKeyboardInput(
  controls: CameraKeyboardControls,
  targets: { keyboard: EventTarget; canvas: EventTarget; window: EventTarget; document: EventTarget },
  context: (target?: EventTarget | null) => NavigationContext,
  isHidden: () => boolean,
): () => void {
  const keyDown = (event: Event) => { controls.keyDown(event as KeyboardEvent, context(event.target)); };
  const keyUp = (event: Event) => { controls.keyUp(event as KeyboardEvent); };
  const blur = () => controls.cancelGestures();
  const visibility = () => { if (isHidden()) controls.cancelGestures(); };
  targets.keyboard.addEventListener("keydown", keyDown);
  targets.keyboard.addEventListener("keyup", keyUp);
  targets.canvas.addEventListener("blur", blur);
  targets.canvas.addEventListener("pointercancel", blur);
  targets.canvas.addEventListener("lostpointercapture", blur);
  targets.window.addEventListener("blur", blur);
  targets.document.addEventListener("visibilitychange", visibility);
  return () => {
    controls.cancelGestures();
    targets.keyboard.removeEventListener("keydown", keyDown);
    targets.keyboard.removeEventListener("keyup", keyUp);
    targets.canvas.removeEventListener("blur", blur);
    targets.canvas.removeEventListener("pointercancel", blur);
    targets.canvas.removeEventListener("lostpointercapture", blur);
    targets.window.removeEventListener("blur", blur);
    targets.document.removeEventListener("visibilitychange", visibility);
  };
}
