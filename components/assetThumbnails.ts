import * as THREE from "three";
import type {
  ActorPrototype,
  ActorVisualPayload,
  GeometryAssetPayload,
  SkyboxAssetPayload,
} from "../shared/types";
import { ActorModelLayer } from "./actorModelScene";
import {
  createNativeSurfaceMaterial,
  hasNativeNormals,
  decodeTexturePixels,
  linearNativeColors,
  RoomTexturePool,
} from "./roomMaterials";
let tail: Promise<unknown> = Promise.resolve();
let sharedRenderer: THREE.WebGLRenderer | undefined;
let lifecycleBound = false;
let suspended = false;

function previewRenderer(): THREE.WebGLRenderer {
  if (!lifecycleBound) {
    lifecycleBound = true;
    window.addEventListener("pagehide", () => {
      suspended = true;
      sharedRenderer?.dispose();
      sharedRenderer?.forceContextLoss();
      sharedRenderer = undefined;
    });
    window.addEventListener("pageshow", () => {
      suspended = false;
    });
  }
  if (suspended)
    throw new Error("Asset preview interrupted by page navigation.");
  if (!sharedRenderer) {
    sharedRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    sharedRenderer.setSize(240, 160);
    sharedRenderer.outputColorSpace = THREE.SRGBColorSpace;
  }
  return sharedRenderer;
}

/** All native thumbnails share one queued context; job assets are disposed separately. */
export function assetThumbnail(
  payload: ActorVisualPayload | GeometryAssetPayload | SkyboxAssetPayload,
  prototype?: ActorPrototype,
): Promise<string> {
  const job = tail.then(() => render(payload, prototype));
  tail = job.catch(() => {});
  return job;
}
function render(
  payload: ActorVisualPayload | GeometryAssetPayload | SkyboxAssetPayload,
  prototype?: ActorPrototype,
): string {
  if ("texture" in payload) {
    const t = payload.texture,
      pixels = decodeTexturePixels(t),
      canvas = document.createElement("canvas");
    canvas.width = t.width;
    canvas.height = t.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Image preview is unavailable.");
    ctx.putImageData(
      new ImageData(new Uint8ClampedArray(pixels), t.width, t.height),
      0,
      0,
    );
    return canvas.toDataURL("image/png");
  }
  const renderer = previewRenderer();
  const scene = new THREE.Scene(),
    camera = new THREE.PerspectiveCamera(38, 1.5, 0.1, 250000);
  let layer: ActorModelLayer | undefined, pool: RoomTexturePool | undefined;
  try {
    if ("actorVisuals" in payload) {
      if (!prototype) throw new Error("Actor prototype missing.");
      const markers = new Map<string, THREE.Mesh>();
      for (const v of payload.actorVisuals) {
        const proxy = new THREE.Mesh(
          new THREE.BufferGeometry(),
          new THREE.MeshBasicMaterial(),
        );
        markers.set(v.actorRef, proxy);
        scene.add(proxy);
      }
      layer = new ActorModelLayer(scene, markers, new Map());
      layer.syncActors(
        payload.actorVisuals.map((v) => ({
          id: v.actorRef,
          index: 0,
          actorId: prototype.actorId,
          name: prototype.name,
          position: { x: 0, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0 },
          parameters: prototype.parameters,
          editable: false,
        })),
      );
      const coverage = layer.setPayload(payload);
      layer.updateView(null, {
        actors: true,
        textures: true,
        wireframe: false,
      });
      if (!coverage.rendered)
        throw new Error(
          payload.actorVisuals[0]?.reason ?? "This actor has no visual model.",
        );
      layer.updateCamera(camera);
    } else {
      pool = new RoomTexturePool(payload.textures);
      payload.meshes
        .filter((d) => d.source === "display-list")
        .forEach((data) => {
          const g = new THREE.BufferGeometry();
          g.setAttribute(
            "position",
            new THREE.Float32BufferAttribute(data.positions, 3),
          );
          g.setIndex(data.indices);
          if (data.uvs)
            g.setAttribute("uv", new THREE.Float32BufferAttribute(data.uvs, 2));
          if (data.colors)
            g.setAttribute(
              "color",
              new THREE.BufferAttribute(
                linearNativeColors(data.colors, data.colorItemSize ?? 3),
                data.colorItemSize ?? 3,
              ),
            );
          if (hasNativeNormals(data))
            g.setAttribute("normal", new THREE.Float32BufferAttribute(data.normals!, 3));
          const m = createNativeSurfaceMaterial(data, pool!);
          scene.add(new THREE.Mesh(g, m.material));
        });
    }
    scene.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(scene);
    if (bounds.isEmpty()) throw new Error("No decoded surfaces to preview.");
    const center = bounds.getCenter(new THREE.Vector3()),
      distance = Math.max(
        bounds.getSize(new THREE.Vector3()).length() * 1.15,
        10,
      );
    camera.position
      .copy(center)
      .add(new THREE.Vector3(distance * 0.8, distance * 0.55, distance));
    camera.lookAt(center);
    camera.updateMatrixWorld();
    layer?.updateCamera(camera);
    renderer.render(scene, camera);
    return renderer.domElement.toDataURL("image/png");
  } finally {
    layer?.dispose();
    scene.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) =>
          m.dispose(),
        );
      }
    });
    pool?.dispose();
    scene.clear();
    // Release references to this job's objects while retaining the reusable context.
    renderer.renderLists.dispose();
    renderer.resetState();
  }
}
