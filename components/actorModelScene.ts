import * as THREE from "three";
import type {
  ProjectSceneActor,
  ActorModel,
  ActorVisual,
  ActorVisualPart,
  ActorVisualPayload,
  AxisFlags,
  Vec3,
} from "../shared/types";
import {
  nativeActorPlacementMatrix,
  nativeBillboardMatrix,
  nativeBoneBillboardMatrix,
} from "../core/rom/actors-pose";
import {
  createNativeSurfaceMaterial,
  linearNativeColors,
  RoomTexturePool,
} from "./roomMaterials";

export interface ActorRenderCoverage {
  rendered: number;
  renderedActorRefs: string[];
  supported: number;
  conditional: number;
  partial: number;
  nonvisual: number;
  unsupported: number;
  parts: number;
  texturedTriangles: number;
  warnings: string[];
  failures: Record<string, string>;
}
interface Surface {
  geometry: THREE.BufferGeometry;
  native: THREE.MeshBasicMaterial;
  solid: THREE.MeshBasicMaterial;
}
interface AssetResource {
  model: ActorModel;
  signature: string;
  surfaces: Surface[];
  pool: RoomTexturePool;
  texturedTriangles: number;
  warnings: string[];
}
interface PartInstance {
  data: ActorVisualPart;
  root: THREE.Group;
  nodes: THREE.Group[];
  asset: AssetResource;
  rotationKey?: string;
  cameraKey?: string;
}
interface ActorInstance {
  visual: ActorVisual;
  content: THREE.Group;
  parts: PartInstance[];
}
const aligned = (axes?: AxisFlags) =>
  Boolean(axes && (axes.x || axes.y || axes.z));
const rotationFor = (
  actor: ProjectSceneActor,
  part: ActorVisualPart,
): Vec3 => ({ ...actor.rotation, ...part.rotationOverrides });

function checkedMatrix(values: number[]): THREE.Matrix4 {
  if (values.length !== 16 || !values.every(Number.isFinite))
    throw new Error("An actor model has an invalid native transform.");
  return new THREE.Matrix4().fromArray(values);
}

/** Native model scale/pivot and constructor angles stay separate from actor XYZ. */
export function actorPartMatrix(
  actor: ProjectSceneActor,
  part: ActorVisualPart,
  cameraBack: Vec3,
): THREE.Matrix4 {
  const result = new THREE.Matrix4().fromArray(
    nativeActorPlacementMatrix(part.positionOffset, rotationFor(actor, part)),
  );
  result.multiply(checkedMatrix(part.rootMatrix));
  if (aligned(part.billboardAxes))
    result.multiply(
      new THREE.Matrix4().fromArray(
        nativeBillboardMatrix(cameraBack, part.billboardAxes),
      ),
    );
  return result;
}

/** Asset buffers/textures are shared by placements and disposed once per room. */
export class ActorModelLayer {
  private readonly assets = new Map<string, AssetResource>();
  private readonly instances = new Map<string, ActorInstance>();
  private actors = new Map<string, ProjectSceneActor>();
  private payload: ActorVisualPayload | null = null;
  private readonly box = new THREE.Box3();
  private readonly outline = new THREE.Box3Helper(this.box, 0x8cf5d5);
  private selected: string | null = null;
  private view = { actors: true, textures: true, wireframe: false };
  private readonly cameraBack = new THREE.Vector3();
  private coverage: ActorRenderCoverage = {
    rendered: 0,
    renderedActorRefs: [],
    supported: 0,
    conditional: 0,
    partial: 0,
    nonvisual: 0,
    unsupported: 0,
    parts: 0,
    texturedTriangles: 0,
    warnings: [],
    failures: {},
  };

  constructor(
    private readonly scene: THREE.Scene,
    private readonly proxies: Map<string, THREE.Mesh>,
    private readonly directions: Map<string, THREE.Group>,
  ) {
    this.outline.visible = false;
    this.outline.renderOrder = 20000;
    const outlineMaterials = Array.isArray(this.outline.material)
      ? this.outline.material
      : [this.outline.material];
    outlineMaterials.forEach((material) => {
      material.depthTest = false;
    });
    scene.add(this.outline);
  }

  syncActors(actors: ProjectSceneActor[]): void {
    this.actors = new Map(actors.map((actor) => [actor.id, actor]));
  }

  setPayload(payload: ActorVisualPayload | null): ActorRenderCoverage {
    if (
      payload === this.payload ||
      (payload &&
        payload.actorModels === this.payload?.actorModels &&
        payload.actorVisuals === this.payload?.actorVisuals)
    )
      return this.coverage;
    this.payload = payload;
    this.instances.forEach((instance) => instance.content.removeFromParent());
    this.instances.clear();
    const warnings = new Set<string>();
    const models = new Map(
      payload?.actorModels.map((model) => [model.id, model]),
    );
    const signatures = new Map(
      [...models].map(([id, model]) => [id, JSON.stringify(model)]),
    );
    for (const [id, asset] of this.assets)
      if (!models.has(id)) {
        this.disposeAsset(asset);
        this.assets.delete(id);
      }
    const coverage: ActorRenderCoverage = {
      rendered: 0,
      renderedActorRefs: [],
      supported: 0,
      conditional: 0,
      partial: 0,
      nonvisual: 0,
      unsupported: 0,
      parts: 0,
      texturedTriangles: 0,
      warnings: [],
      failures: {},
    };
    for (const visual of payload?.actorVisuals ?? []) {
      const proxy = this.proxies.get(visual.actorRef);
      if (!proxy || !this.actors.has(visual.actorRef)) continue;
      visual.warnings.forEach((warning) => warnings.add(warning));
      if (visual.status === "nonvisual") {
        coverage.nonvisual++;
        continue;
      }
      if (!visual.parts.length) {
        coverage.unsupported++;
        continue;
      }
      const content = new THREE.Group();
      const parts: PartInstance[] = [];
      for (const data of visual.parts) {
        try {
          const model = models.get(data.assetId);
          if (!model)
            throw new Error(
              "An actor model asset is missing from the decoded room.",
            );
          const signature = signatures.get(model.id)!;
          let asset = this.assets.get(model.id);
          if (asset?.signature !== signature) {
            if (asset) this.disposeAsset(asset);
            asset = this.createAsset(model, signature);
            this.assets.set(model.id, asset);
          }
          const part = this.createPart(data, asset, visual.actorRef);
          content.add(part.root);
          parts.push(part);
          asset.warnings.forEach((warning) => warnings.add(warning));
        } catch (error) {
          const reason =
            error instanceof Error
              ? error.message
              : "An actor model could not be displayed.";
          coverage.failures[visual.actorRef] = reason;
          warnings.add(reason);
        }
      }
      if (parts.length) {
        proxy.add(content);
        this.instances.set(visual.actorRef, { visual, content, parts });
        coverage.rendered++;
        coverage.renderedActorRefs.push(visual.actorRef);
      }
      if (
        visual.status === "unsupported" ||
        coverage.failures[visual.actorRef]
      ) {
        coverage.unsupported++;
        if (parts.length) coverage.partial++;
      } else if (visual.status === "conditional") coverage.conditional++;
      else coverage.supported++;
      coverage.parts += parts.length;
      coverage.texturedTriangles += parts.reduce(
        (sum, part) => sum + part.asset.texturedTriangles,
        0,
      );
    }
    this.coverage = { ...coverage, warnings: [...warnings] };
    this.updateView(this.selected, this.view);
    return this.coverage;
  }

  updateView(
    selected: string | null,
    view: { actors: boolean; textures: boolean; wireframe: boolean },
  ): void {
    this.selected = selected;
    this.view = view;
    const visuals = new Map(
      this.payload?.actorVisuals.map((visual) => [visual.actorRef, visual]),
    );
    for (const [id, actor] of this.actors) {
      const proxy = this.proxies.get(id);
      if (!proxy) continue;
      const instance = this.instances.get(id),
        visual = visuals.get(id);
      proxy.visible = view.actors;
      const material = proxy.material as THREE.MeshStandardMaterial;
      material.visible =
        !instance ||
        visual?.status === "unsupported" ||
        Boolean(this.coverage.failures[id]);
      material.color.setHex(
        visual?.status === "nonvisual"
          ? 0x91a4af
          : visual?.status === "unsupported" ||
              (visual?.status === "supported" && !instance)
            ? 0xeab77a
            : 0x63ddc5,
      );
      material.wireframe =
        visual?.status === "nonvisual" || Boolean(instance && material.visible);
      proxy.scale.setScalar(instance ? 1 : selected === actor.id ? 1.18 : 1);
      const direction = this.directions.get(id);
      if (direction) direction.visible = !instance;
      instance?.content.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          const surface = object.userData.surface as Surface;
          object.material = view.textures ? surface.native : surface.solid;
          surface.native.wireframe = surface.solid.wireframe = view.wireframe;
        }
      });
    }
    this.updateOutline();
  }

  updateCamera(camera: THREE.Camera): void {
    camera.getWorldDirection(this.cameraBack).negate();
    const back = {
      x: this.cameraBack.x,
      y: this.cameraBack.y,
      z: this.cameraBack.z,
    };
    const cameraKey = this.cameraBack.toArray().join(",");
    for (const [id, instance] of this.instances) {
      const actor = this.actors.get(id);
      if (!actor) continue;
      for (const part of instance.parts) {
        const rotation = rotationFor(actor, part.data),
          rotationKey = `${rotation.x},${rotation.y},${rotation.z}`;
        const rotationChanged = part.rotationKey !== rotationKey,
          cameraChanged = part.cameraKey !== cameraKey;
        if (
          rotationChanged ||
          (cameraChanged && aligned(part.data.billboardAxes))
        ) {
          part.root.matrix.copy(actorPartMatrix(actor, part.data, back));
          part.root.matrixWorldNeedsUpdate = true;
        }
        for (let index = 0; index < part.nodes.length; index++) {
          const source = part.asset.model.nodes[index],
            node = part.nodes[index];
          // Static bones already hold their verified local matrix. Only camera-
          // aligned bones need a new transform while navigating the viewport.
          if (
            !aligned(source.billboardAxes) ||
            (!rotationChanged && !cameraChanged)
          )
            continue;
          node.matrix.copy(checkedMatrix(source.matrix));
          node.matrix.multiply(
            new THREE.Matrix4().fromArray(
              nativeBoneBillboardMatrix(back, rotation, source.billboardAxes!),
            ),
          );
          node.matrixWorldNeedsUpdate = true;
        }
        part.rotationKey = rotationKey;
        part.cameraKey = cameraKey;
      }
      instance.content.updateWorldMatrix(true, true);
    }
    this.updateOutline();
  }

  pickObjects(): THREE.Object3D[] {
    return [...this.actors.keys()].flatMap((id) => {
      const proxy = this.proxies.get(id);
      if (!proxy?.visible) return [];
      const instance = this.instances.get(id);
      return [
        instance && !(proxy.material as THREE.Material).visible
          ? instance.content
          : proxy,
      ];
    });
  }
  bounds(id: string): THREE.Box3 | null {
    const object = this.instances.get(id)?.content;
    if (!object) return null;
    object.updateWorldMatrix(true, true);
    return new THREE.Box3().setFromObject(object);
  }
  hasModel(id: string): boolean {
    return this.instances.has(id);
  }

  dispose(): void {
    this.instances.forEach((instance) => instance.content.removeFromParent());
    this.instances.clear();
    this.assets.forEach((asset) => this.disposeAsset(asset));
    this.assets.clear();
    this.outline.removeFromParent();
    this.outline.geometry.dispose();
    const outlineMaterials = Array.isArray(this.outline.material)
      ? this.outline.material
      : [this.outline.material];
    outlineMaterials.forEach((material) => material.dispose());
  }

  private updateOutline(): void {
    const bounds =
      this.selected && this.view.actors ? this.bounds(this.selected) : null;
    this.outline.visible = Boolean(bounds && !bounds.isEmpty());
    if (bounds) {
      this.box.copy(bounds);
      this.box.expandByScalar(0.5);
    }
    const uncertain =
      this.selected &&
      (this.instances.get(this.selected)?.visual.status !== "supported" ||
        this.coverage.failures[this.selected]);
    const materials = Array.isArray(this.outline.material)
      ? this.outline.material
      : [this.outline.material];
    materials.forEach((material) => {
      (material as THREE.LineBasicMaterial).color.setHex(
        uncertain ? 0xeab77a : 0x8cf5d5,
      );
    });
  }
  private createAsset(model: ActorModel, signature: string): AssetResource {
    const pool = new RoomTexturePool(model.textures),
      surfaces: Surface[] = [],
      warnings = new Set(model.warnings);
    let texturedTriangles = 0;
    try {
      for (const data of model.meshes) {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute(
          "position",
          new THREE.Float32BufferAttribute(data.positions, 3),
        );
        geometry.setIndex(data.indices);
        if (
          data.colors?.length ===
          (data.positions.length / 3) * (data.colorItemSize ?? 3)
        )
          geometry.setAttribute(
            "color",
            new THREE.BufferAttribute(
              linearNativeColors(data.colors, data.colorItemSize ?? 3),
              data.colorItemSize ?? 3,
            ),
          );
        if (data.uvs?.length === (data.positions.length / 3) * 2)
          geometry.setAttribute(
            "uv",
            new THREE.Float32BufferAttribute(data.uvs, 2),
          );
        const native = createNativeSurfaceMaterial(data, pool);
        if (native.textured) texturedTriangles += data.indices.length / 3;
        if (native.warning) warnings.add(native.warning);
        surfaces.push({
          geometry,
          native: native.material,
          solid: new THREE.MeshBasicMaterial({
            color: 0x91b7ad,
            side: THREE.DoubleSide,
            toneMapped: false,
          }),
        });
      }
      return {
        model,
        signature,
        surfaces,
        pool,
        texturedTriangles,
        warnings: [...warnings],
      };
    } catch (error) {
      surfaces.forEach((surface) => {
        surface.geometry.dispose();
        surface.native.dispose();
        surface.solid.dispose();
      });
      pool.dispose();
      throw error;
    }
  }
  private createPart(
    data: ActorVisualPart,
    asset: AssetResource,
    actorRef: string,
  ): PartInstance {
    checkedMatrix(data.rootMatrix);
    const root = new THREE.Group();
    root.matrixAutoUpdate = false;
    const nodes = asset.model.nodes.map((source) => {
      const node = new THREE.Group();
      node.matrixAutoUpdate = false;
      node.matrix.copy(checkedMatrix(source.matrix));
      return node;
    });
    const assigned = new Set<number>();
    asset.model.nodes.forEach((source, index) => {
      if (
        source.parentIndex !== null &&
        (!Number.isInteger(source.parentIndex) ||
          source.parentIndex < 0 ||
          source.parentIndex >= index)
      )
        throw new Error("An actor model has an invalid native hierarchy.");
      (source.parentIndex === null ? root : nodes[source.parentIndex]).add(
        nodes[index],
      );
      for (const meshIndex of source.meshIndices) {
        const surface = asset.surfaces[meshIndex];
        if (!surface || assigned.has(meshIndex))
          throw new Error(
            "An actor surface has an invalid native node assignment.",
          );
        assigned.add(meshIndex);
        const mesh = new THREE.Mesh(surface.geometry, surface.native);
        mesh.userData = { actorRef, surface };
        mesh.renderOrder = 10000 + meshIndex;
        nodes[index].add(mesh);
      }
    });
    if (assigned.size !== asset.surfaces.length || !assigned.size)
      throw new Error(
        "An actor model has no complete decoded surface hierarchy.",
      );
    return { data, root, nodes, asset };
  }
  private disposeAsset(asset: AssetResource): void {
    asset.surfaces.forEach((surface) => {
      surface.geometry.dispose();
      surface.native.dispose();
      surface.solid.dispose();
    });
    asset.pool.dispose();
  }
}
