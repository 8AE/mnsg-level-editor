import * as THREE from "three";
import type { AuthoredDoor } from "../shared/types";
import { nativeActorPlacementMatrix } from "../core/rom/actors-pose";

/** The runtime trigger is a native-rotated box with an actor-origin at its bottom. */
export function updateDoorVolume(
  volume: THREE.LineSegments,
  door: AuthoredDoor,
): void {
  const dimensions = `${door.dimensions.x},${door.dimensions.y},${door.dimensions.z}`;
  if (volume.userData.dimensions !== dimensions) {
    volume.geometry.dispose();
    const box = new THREE.BoxGeometry(
      door.dimensions.x,
      door.dimensions.y,
      door.dimensions.z,
    );
    volume.geometry = new THREE.EdgesGeometry(box);
    box.dispose();
    volume.userData.dimensions = dimensions;
  }
  volume.matrixAutoUpdate = false;
  volume.matrix.fromArray(
    nativeActorPlacementMatrix({ x: 0, y: 0, z: 0 }, door.rotation),
  );
  volume.matrix.multiply(
    new THREE.Matrix4().makeTranslation(0, door.dimensions.y / 2, 0),
  );
  volume.matrixWorldNeedsUpdate = true;
}
