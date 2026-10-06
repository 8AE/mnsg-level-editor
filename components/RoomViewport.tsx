"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import * as THREE from "three";
import { SelectionOutline } from "./selectionOutline";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { SceneCompass } from "./sceneCompass";
import { rotatePoint, rotateNativeAngles, selectionRotatable, type RotationDelta } from "./selectionRotation";
import type { RoomData, ProjectRoomScene, Vec3 } from "../shared/types";
import {
  createNativeSurfaceMaterial,
  bindNativeDualAttributes,
  hasNativeNormals,
  linearNativeColors,
  RoomTexturePool,
  type RenderTextureCoverage,
} from "./roomMaterials";
import {
  bindCameraKeyboardInput,
  CameraKeyboardControls,
  cancelTransformPreview,
  syncMarkerPosition,
  syncTransformAttachment,
  type NavigationContext,
} from "./cameraControls";
import type { GeometrySelection } from "./authoringState";
import { meshCenter } from "./authoringState";
import {
  geometryVertexIndices,
  selectedGeometryVertices,
  selectedRecordIds,
  recordPosition,
  selectionCenter,
  selectionKey,
  selectionMovable,
  type EditorSelection,
} from "./editorSelection";
import { updateDoorVolume } from "./doorVolume";
import type { LibraryDrop } from "./AssetLibrary";
import { applyCameraMouseMode, type CameraMouseMode } from "./cameraMouse";
import { ActorModelLayer, type ActorRenderCoverage } from "./actorModelScene";

import { validCameraSnapshot, type CameraSnapshot } from "./workspaceModel";

export interface ViewOptions {
  geometry: boolean;
  textures: boolean;
  grid: boolean;
  axes: boolean;
  wireframe: boolean;
  actors: boolean;
  events: boolean;
  translate: boolean;
  transformMode?: "translate" | "rotate";
}
interface Props {
  room: RoomData | ProjectRoomScene;
  cameraSnapshot?: RefObject<CameraSnapshot | undefined>;
  hostWindow?: Window | null;
  sceneVisible?: boolean;
  selected: string | null;
  options: ViewOptions;
  frame: { version: number; selected: boolean };
  onSelect(id: string | null, additive?: boolean): void;
  onMove(id: string, position: Vec3): void;
  onCoverage(coverage: RenderTextureCoverage): void;
  onActorCoverage(coverage: ActorRenderCoverage & { roomId: number }): void;
  navigationEnabled: boolean;
  mouseMode?: CameraMouseMode;
  geometrySelection?: GeometrySelection | null;
  onGeometrySelect?(
    selection: GeometrySelection | null,
    additive?: boolean,
  ): void;
  selections?: EditorSelection[];
  onTranslateSelection?(delta: Vec3): void;
  onRotateSelection?(rotation: RotationDelta, pivot: Vec3): boolean;
  onEditMenu?(
    location: import("./EditorContextMenu").ContextMenuLocation,
  ): void;
  onAssetDrop?(asset: LibraryDrop, position: Vec3): void;
}

export default function RoomViewport({
  room,
  cameraSnapshot,
  hostWindow,
  sceneVisible = true,
  selected,
  options,
  frame,
  onSelect,
  onMove,
  onCoverage,
  onActorCoverage,
  navigationEnabled,
  geometrySelection,
  onGeometrySelect,
  selections,
  onTranslateSelection,
  onRotateSelection,
  onAssetDrop,
  onEditMenu,
  mouseMode = "tilt",
}: Props) {
  const host = useRef<HTMLDivElement>(null);
  const callbacks = useRef({
    onSelect,
    onMove,
    onCoverage,
    onActorCoverage,
    onGeometrySelect,
    onTranslateSelection,
    onRotateSelection,
    onAssetDrop,
    onEditMenu,
  });
  callbacks.current = {
    onSelect,
    onMove,
    onCoverage,
    onActorCoverage,
    onGeometrySelect,
    onTranslateSelection,
    onRotateSelection,
    onAssetDrop,
    onEditMenu,
  };
  const geometryChoice = useRef(geometrySelection);
  geometryChoice.current = geometrySelection;
  const choices = useRef<EditorSelection[]>([]);
  choices.current =
    selections ??
    (geometrySelection
      ? [{ kind: "geometry", choice: geometrySelection }]
      : selected
        ? [{ kind: "record", id: selected }]
        : []);
  const mousePreference = useRef(mouseMode);
  mousePreference.current = mouseMode;
  const sceneShown = useRef(sceneVisible);
  sceneShown.current = sceneVisible;
  const navigationAllowed = useRef(navigationEnabled);
  navigationAllowed.current = navigationEnabled;
  const latestRoom = useRef(room);
  latestRoom.current = room;
  const [failure, setFailure] = useState<string | null>(null);
  const cameraState = useRef<{
    roomId: number;
    position: THREE.Vector3;
    target: THREE.Vector3;
  } | null>(null);
  const markerRoster = `${"doors" in room ? room.doors.map((d) => d.id).join("|") + room.entrances.map((e) => e.id).join("|") : ""}/${room.actors.map((actor) => actor.id).join("|")}/${room.events.map((event) => event.id).join("|")}`;
  const runtime = useRef<{
    frame(selectedOnly: boolean): void;
    update(selected: string | null, options: ViewOptions): void;
    syncRoom(room: RoomData | ProjectRoomScene): void;
    setMouseMode(mode: CameraMouseMode): void;
    setVisible(visible: boolean): void;
  } | null>(null);

  useEffect(() => {
    const container = host.current;
    if (!container) return;
    const document = container.ownerDocument;
    const viewWindow = document.defaultView;
    if (
      !viewWindow ||
      hostWindow === null ||
      (hostWindow && hostWindow !== viewWindow)
    )
      return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        canvas: document.createElement("canvas"),
        antialias: true,
        alpha: false,
      });
    } catch {
      setFailure(
        "3D rendering could not start. Enable hardware acceleration or update your graphics driver. Room data remains available in the inspector.",
      );
      return;
    }
    setFailure(null);
    renderer.setPixelRatio(Math.min(viewWindow.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(renderer.domElement);
    renderer.domElement.tabIndex = 0;
    renderer.domElement.setAttribute(
      "aria-label",
      "3D viewport. Focus here and hold W A S D to move the camera. Drag to orbit, right-drag to pan, scroll to zoom.",
    );
    renderer.domElement.dataset.testid = "viewport-navigation-canvas";
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x111719);
    const camera = new THREE.PerspectiveCamera(42, 1, 0.5, 250000);
    const compass = new SceneCompass(document);
    container.appendChild(compass.element);
    const orbit = new OrbitControls(camera, renderer.domElement);
    orbit.enableDamping = true;
    orbit.dampingFactor = 0.12;
    orbit.maxDistance = 150000;
    const publishCamera = () => {
      const position = camera.position
        .toArray()
        .map((value) => value.toFixed(5))
        .join(",");
      const target = orbit.target
        .toArray()
        .map((value) => value.toFixed(5))
        .join(",");
      if (container.dataset.cameraPosition !== position)
        container.dataset.cameraPosition = position;
      if (container.dataset.cameraTarget !== target)
        container.dataset.cameraTarget = target;
    };
    orbit.addEventListener("change", publishCamera);
    scene.add(new THREE.HemisphereLight(0xc8f2e6, 0x49515b, 2.3));
    const key = new THREE.DirectionalLight(0xe2f7f0, 2.2);
    key.position.set(800, 2000, 600);
    scene.add(key);
    const geometryGroup = new THREE.Group();
    scene.add(geometryGroup);
    const materials: THREE.Material[] = [];
    const texturePool = new RoomTexturePool(room.textures);
    const surfaces: {
      mesh: THREE.Mesh;
      solid: THREE.MeshStandardMaterial;
      native: THREE.MeshBasicMaterial;
      edges: THREE.LineSegments;
      hasNativeMaterial: boolean;
    }[] = [];
    let texturedTriangles = 0;
    const textureWarnings = new Set<string>();
    room.meshes.forEach((data, drawIndex) => {
      if (!data.positions.length || !data.indices.length) return;
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
      if (hasNativeNormals(data))
        geometry.setAttribute(
          "normal",
          new THREE.Float32BufferAttribute(data.normals!, 3),
        );
      else if (!data.material?.texgen) geometry.computeVertexNormals();
      const material = new THREE.MeshStandardMaterial({
        color: 0x55726b,
        roughness: 0.95,
        metalness: 0.08,
        side: THREE.DoubleSide,
        vertexColors: Boolean(data.colors?.length),
      });
      bindNativeDualAttributes(geometry, data);
      const native = createNativeSurfaceMaterial(data, texturePool);
      if (data.colorItemSize === 4) {
        material.transparent = native.material.transparent;
        material.depthWrite = native.material.depthWrite;
        material.alphaTest = native.material.alphaTest;
      }
      materials.push(material, native.material);
      if (native.textured) texturedTriangles += data.indices.length / 3;
      if (native.warning) textureWarnings.add(native.warning);
      const mesh = new THREE.Mesh(geometry, material);
      // Keep contiguous native batches in their source sequence, including the
      // transparent queue; depth sorting must not regroup alpha surfaces by hash.
      mesh.renderOrder = drawIndex;
      mesh.userData.meshId = data.id;
      geometryGroup.add(mesh);
      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(geometry, 25),
        new THREE.LineBasicMaterial({
          color: 0x84ae9f,
          transparent: true,
          opacity: 0.28,
        }),
      );
      materials.push(edges.material);
      mesh.add(edges);
      surfaces.push({
        mesh,
        solid: material,
        native: native.material,
        edges,
        hasNativeMaterial: Boolean(data.material),
      });
    });
    container.dataset.roomId = String(room.id);
    container.dataset.sceneKind = "kind" in room ? room.kind : "native";
    container.dataset.authoredMeshCount = String(
      "authoredMeshes" in room ? room.authoredMeshes.length : 0,
    );
    container.dataset.texturedTriangles = String(texturedTriangles);
    container.dataset.textureCount = String(texturePool.size);
    callbacks.current.onCoverage({
      roomId: room.id,
      textured: texturedTriangles,
      total: room.meshes.reduce(
        (sum, mesh) => sum + mesh.indices.length / 3,
        0,
      ),
      images: texturePool.size,
      warnings: [...textureWarnings],
    });
    let skyTexture: THREE.DataTexture | undefined;
    if ("skybox" in room && room.skybox) {
      const skyPool = new RoomTexturePool([room.skybox.texture]);
      skyTexture = skyPool.get(room.skybox.texture.id, {
        wrapS: "repeat",
        wrapT: "clamp",
        filter: "linear",
      }).texture;
      skyTexture.repeat.y = -1;
      skyTexture.offset.y = 1;
      scene.background = skyTexture;
    }
    const geometryBounds = new THREE.Box3().setFromObject(geometryGroup);
    const span = geometryBounds.isEmpty()
      ? 1000
      : Math.max(geometryBounds.getSize(new THREE.Vector3()).length(), 100);
    const markerSize = THREE.MathUtils.clamp(span / 70, 8, 90);
    const markers = new Map<string, THREE.Mesh>();
    const directions = new Map<string, THREE.Group>();
    const addMarker = (
      id: string,
      position: Vec3,
      event: boolean,
      editable: boolean,
    ) => {
      const geometry = event
        ? new THREE.OctahedronGeometry(markerSize, 0)
        : new THREE.CylinderGeometry(
            markerSize * 0.58,
            markerSize * 0.58,
            markerSize * 2.6,
            8,
          );
      geometry.translate(0, event ? markerSize : markerSize * 1.3, 0);
      const material = new THREE.MeshStandardMaterial({
        color: event ? 0xeab77a : 0x63ddc5,
        emissive: event ? 0x795122 : 0x15564a,
        emissiveIntensity: 0.35,
        roughness: 0.5,
      });
      materials.push(material);
      const marker = new THREE.Mesh(geometry, material);
      marker.position.set(position.x, position.y, position.z);
      marker.userData = { id, event, editable };
      markers.set(id, marker);
      scene.add(marker);
      if (!event) {
        const direction = new THREE.Group();
        const tipGeometry = new THREE.ConeGeometry(
          markerSize * 0.35,
          markerSize,
          6,
        );
        tipGeometry.rotateX(Math.PI / 2);
        const tip = new THREE.Mesh(tipGeometry, material);
        tip.position.set(0, markerSize * 1.2, markerSize * 2.6);
        const shaft = new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(0, markerSize * 1.2, markerSize * 0.5),
          new THREE.Vector3(0, markerSize * 1.2, markerSize * 2.4),
        ]);
        const lineMaterial = new THREE.LineBasicMaterial({ color: 0x9ff6df });
        materials.push(lineMaterial);
        direction.add(tip, new THREE.LineSegments(shaft, lineMaterial));
        marker.add(direction);
        directions.set(id, direction);
      }
    };
    room.actors.forEach((actor) =>
      addMarker(
        actor.id,
        actor.position,
        false,
        actor.editable &&
          (("prototypeId" in actor && Boolean(actor.prototypeId)) ||
            actor.sourceKind !== "partition" ||
            Boolean(actor.partition)),
      ),
    );
    room.events.forEach((event) => {
      if (event.position)
        addMarker(event.id, event.position, true, event.editable);
    });
    const doorVolumes = new Map<string, THREE.LineSegments>();
    const authoredGeometry = new Map<
      string,
      { surface: THREE.Mesh; original: Float32Array }
    >();
    if ("authoredMeshes" in room) {
      for (const mesh of room.authoredMeshes) {
        const p = meshCenter(mesh);
        addMarker(mesh.id, p, true, true);
        const marker = markers.get(mesh.id)!;
        marker.userData.geometry = true;
        (marker.material as THREE.Material).visible = false;
        const surface = surfaces.find(
          (s) => s.mesh.userData.meshId === mesh.id,
        )?.mesh;
        if (surface)
          authoredGeometry.set(mesh.id, {
            surface,
            original: new Float32Array(
              surface.geometry.getAttribute("position").array,
            ),
          });
      }
      for (const door of room.doors) {
        addMarker(`door:${door.id}`, door.position, false, true);
        const box = new THREE.LineSegments(
          new THREE.BufferGeometry(),
          new THREE.LineBasicMaterial({ color: 0xf0bd75 }),
        );
        doorVolumes.set(door.id, box);
        updateDoorVolume(box, door);
        markers.get(`door:${door.id}`)!.add(box);
        materials.push(box.material);
      }
      for (const entry of room.entrances)
        addMarker(`entrance:${entry.id}`, entry.position, true, true);
    }
    const surfaceFor = (id: string) =>
      authoredGeometry.get(id)?.surface ??
      surfaces.find((s) => s.mesh.userData.meshId === id)?.mesh;
    const selectionOutlines = new Map<string, SelectionOutline>();
    const recordOutlines = new Map<string, THREE.Box3Helper>();
    const groupAnchor = new THREE.Object3D();
    groupAnchor.userData.id = "@selection";
    scene.add(groupAnchor);
    const groupOrigin = () => {
      const p = selectionCenter(latestRoom.current, choices.current);
      return p ? new THREE.Vector3(p.x, p.y, p.z) : undefined;
    };
    const updateRecordOutlines = () => {
      const ids = selectedRecordIds(latestRoom.current, choices.current);
      for (const [id, outline] of recordOutlines)
        if (!ids.has(id)) {
          outline.removeFromParent();
          outline.geometry.dispose();
          (outline.material as THREE.Material).dispose();
          recordOutlines.delete(id);
        }
      for (const id of ids) {
        const marker = markers.get(id);
        if (!marker) continue;
        let outline = recordOutlines.get(id);
        if (!outline) {
          outline = new THREE.Box3Helper(new THREE.Box3(), 0xffcf68);
          outline.renderOrder = 40003;
          (outline.material as THREE.Material).depthTest = false;
          scene.add(outline);
          recordOutlines.set(id, outline);
        }
        outline.visible = marker.visible;
        outline.box.copy(
          actorModels.bounds(id) ?? new THREE.Box3().setFromObject(marker),
        );
        outline.box.expandByScalar(0.5);
      }
    };
    const updateSelectionOutlines = (visible = geometryGroup.visible) => {
      const keys = new Set<string>();
      for (const item of choices.current)
        if (item.kind === "geometry") {
          const key = selectionKey(item);
          keys.add(key);
          let outline = selectionOutlines.get(key);
          if (!outline) {
            outline = new SelectionOutline();
            scene.add(outline.group);
            selectionOutlines.set(key, outline);
          }
          outline.update(surfaceFor(item.choice.meshId), item.choice, visible);
        }
      for (const [key, outline] of selectionOutlines)
        if (!keys.has(key)) {
          outline.dispose();
          selectionOutlines.delete(key);
        }
      updateRecordOutlines();
    };
    const actorModels = new ActorModelLayer(scene, markers, directions);
    const bounds = geometryBounds.clone();
    if (bounds.isEmpty())
      markers.forEach((marker) => bounds.expandByObject(marker));
    if (bounds.isEmpty())
      bounds.set(
        new THREE.Vector3(-500, -100, -500),
        new THREE.Vector3(500, 100, 500),
      );
    const gridSize = Math.max(
      1000,
      Math.ceil(
        Math.max(
          bounds.getSize(new THREE.Vector3()).x,
          bounds.getSize(new THREE.Vector3()).z,
        ) / 500,
      ) * 700,
    );
    const grid = new THREE.GridHelper(gridSize, 40, 0x355249, 0x253530);
    grid.position.y = bounds.min.y - 0.2;
    scene.add(grid);
    const axes = new THREE.AxesHelper(markerSize * 8);
    axes.position.set(bounds.min.x, bounds.min.y, bounds.min.z);
    scene.add(axes);
    const transform = new TransformControls(camera, renderer.domElement);
    transform.setMode("translate");
    transform.setTranslationSnap(1);
    scene.add(transform.getHelper());
    let moving = false;
    const keyboard = new CameraKeyboardControls(camera, orbit.target);
    const publishTransform = () => {
      container.dataset.transformDragging = String(transform.dragging);
      container.dataset.transformAxis = transform.axis ?? "";
      container.dataset.transformObjectId = transform.object?.userData.id ?? "";
      container.dataset.transformPreviewRotation = transform.object?.quaternion.toArray().join(",") ?? "";
      container.dataset.transformPreviewPosition =
        transform.object?.position
          .toArray()
          .map((value) => value.toFixed(5))
          .join(",") ?? "";
    };
    transform.addEventListener("objectChange", publishTransform);
    transform.addEventListener("axis-changed", publishTransform);
    const orbitStart = () => keyboard.beginGesture("orbit");
    const orbitEnd = () => keyboard.endGesture("orbit");
    orbit.addEventListener("start", orbitStart);
    orbit.addEventListener("end", orbitEnd);
    const navigationContext = (
      target: EventTarget | null = document.activeElement,
    ): NavigationContext => ({
      focused:
        document.activeElement === renderer.domElement && document.hasFocus(),
      typing: Boolean(
        (target as HTMLElement | null)?.closest?.(
          "input,textarea,select,[contenteditable]:not([contenteditable='false']),[role='textbox']",
        ),
      ),
      blocked:
        !navigationAllowed.current ||
        !sceneShown.current ||
        moving ||
        document.hidden ||
        Boolean(document.querySelector("[role='dialog'][aria-modal='true']")),
    });
    const geometryOrigin = (data: RoomData | ProjectRoomScene, id: string) => {
      if (!("authoredMeshes" in data)) return undefined;
      const mesh = data.authoredMeshes.find((m) => m.id === id);
      if (!mesh) return undefined;
      const choice = geometryChoice.current;
      if (choice?.meshId === id && choice.mode === "vertex")
        return mesh.vertices[choice.vertexIndex]?.position;
      if (choice?.meshId === id && choice.mode === "face") {
        const ids = mesh.indices.slice(
          choice.faceIndex * 3,
          choice.faceIndex * 3 + 3,
        );
        if (ids.length === 3)
          return ids.reduce(
            (p, i) => ({
              x: p.x + mesh.vertices[i].position.x / 3,
              y: p.y + mesh.vertices[i].position.y / 3,
              z: p.z + mesh.vertices[i].position.z / 3,
            }),
            { x: 0, y: 0, z: 0 },
          );
      }
      return meshCenter(mesh);
    };
    let dragOrigin: THREE.Vector3 | undefined;
    let dragRotation: THREE.Quaternion | undefined;
    const modelActors = (data: RoomData | ProjectRoomScene) => [
      ...data.actors,
      ...("doors" in data ? data.doors.map((door, index) => ({ id: `door:${door.id}`, index, actorId: 0, name: "Door appearance", position: door.position, rotation: door.rotation, parameters: [], editable: true })) : []),
    ];
    const restoreGeometry = () => {
      authoredGeometry.forEach(({ surface, original }) => {
        const attr = surface.geometry.getAttribute(
          "position",
        ) as THREE.BufferAttribute;
        attr.array.set(original);
        attr.needsUpdate = true;
        surface.geometry.computeBoundingSphere();
      });
      for (const [id, marker] of markers) {
        const p = recordPosition(latestRoom.current, id);
        if (p) marker.position.set(p.x, p.y, p.z);
      }
      actorModels.syncActors(modelActors(latestRoom.current));
      for (const actor of latestRoom.current.actors) {
        const direction = directions.get(actor.id);
        if (direction) direction.rotation.y = (actor.rotation.y & 1023) * Math.PI * 2 / 1024;
      }
      if ("doors" in latestRoom.current) for (const door of latestRoom.current.doors) {
        const volume = doorVolumes.get(door.id);
        if (volume) updateDoorVolume(volume, door);
      }
      scene.updateMatrixWorld(true);
      updateSelectionOutlines();
    };
    const previewGeometry = () => {
      const object = transform.object;
      if (!object) return;
      const grouped = object === groupAnchor;
      if (!grouped && !object.userData.geometry) return;
      const singleOrigin = geometryOrigin(
        latestRoom.current,
        object.userData.id,
      );
      const origin = grouped
        ? (dragOrigin ?? groupOrigin())
        : singleOrigin
          ? new THREE.Vector3(singleOrigin.x, singleOrigin.y, singleOrigin.z)
          : undefined;
      if (!origin) return;
      const delta = object.position.clone().sub(origin);
      const rotating = transform.getMode() === "rotate";
      const rotation = object.quaternion.clone().multiply((dragRotation ?? new THREE.Quaternion()).clone().invert());
      if (grouped) delta.round();
      const selections = grouped
        ? choices.current
        : geometryChoice.current
          ? [{ kind: "geometry" as const, choice: geometryChoice.current }]
          : [];
      const vertices = selectedGeometryVertices(latestRoom.current, selections);
      for (const [id, entry] of authoredGeometry) {
        const attr = entry.surface.geometry.getAttribute(
          "position",
        ) as THREE.BufferAttribute;
        attr.array.set(entry.original);
        for (const index of vertices.get(id) ?? [])
          {
            const p = { x: entry.original[index * 3], y: entry.original[index * 3 + 1], z: entry.original[index * 3 + 2] };
            const next = rotating ? rotatePoint(p, origin, rotation) : { x: p.x + delta.x, y: p.y + delta.y, z: p.z + delta.z };
            attr.setXYZ(index, next.x, next.y, next.z);
          }
        attr.needsUpdate = true;
        entry.surface.geometry.computeBoundingSphere();
      }
      if (grouped)
        for (const id of selectedRecordIds(latestRoom.current, selections)) {
          const p = recordPosition(latestRoom.current, id),
            marker = markers.get(id);
          const next = p ? rotating ? rotatePoint(p, origin, rotation) : { x: p.x + delta.x, y: p.y + delta.y, z: p.z + delta.z } : undefined;
          if (next && marker) marker.position.set(next.x, next.y, next.z);
          for (const event of latestRoom.current.events)
            if (event.actorRef === id && event.position)
              markers
                .get(event.id)
                ?.position.set(
                  next?.x ?? event.position.x,
                  next?.y ?? event.position.y,
                  next?.z ?? event.position.z,
                );
        }
      if (rotating) {
        const ids = selectedRecordIds(latestRoom.current, selections);
        actorModels.syncActors(modelActors(latestRoom.current).map(actor => ids.has(actor.id) ? { ...actor, rotation: rotateNativeAngles(actor.rotation, rotation) } : actor));
        for (const actor of latestRoom.current.actors) if (ids.has(actor.id)) {
          const direction = directions.get(actor.id);
          if (direction) direction.rotation.y = rotateNativeAngles(actor.rotation, rotation).y * Math.PI * 2 / 1024;
        }
        if ("doors" in latestRoom.current) for (const door of latestRoom.current.doors) if (ids.has(`door:${door.id}`)) {
          const volume = doorVolumes.get(door.id);
          if (volume) updateDoorVolume(volume, { ...door, rotation: rotateNativeAngles(door.rotation, rotation) });
        }
        actorModels.updateCamera(camera);
      }
      scene.updateMatrixWorld(true);
      updateSelectionOutlines();
    };
    transform.addEventListener("objectChange", previewGeometry);
    const cancelTransform = () => {
      const id = transform.object?.userData.id;
      const source =
        latestRoom.current.actors.find((actor) => actor.id === id) ??
        latestRoom.current.events.find((event) => event.id === id);
      const extra =
        "doors" in latestRoom.current
          ? (latestRoom.current.doors.find((d) => `door:${d.id}` === id) ??
            latestRoom.current.entrances.find((e) => `entrance:${e.id}` === id))
          : undefined;
      cancelTransformPreview(
        transform,
        transform.object === groupAnchor
          ? (dragOrigin ?? groupOrigin())
          : (source?.position ??
              extra?.position ??
              geometryOrigin(latestRoom.current, id)),
      );
      if (transform.object) transform.object.quaternion.copy(dragRotation ?? new THREE.Quaternion());
      restoreGeometry();
      dragOrigin = undefined;
      dragRotation = undefined;
      moving = false;
      orbit.enabled = true;
      keyboard.cancelGestures();
      publishTransform();
    };
    const clearMovement = () => {
      cancelTransform();
      container.dataset.navigationActive = "false";
    };
    let completingPointerUp = false;
    const normalPointerUp = () => {
      completingPointerUp = true;
      queueMicrotask(() => {
        completingPointerUp = false;
      });
    };
    const canceledPointer = () => {
      if (!completingPointerUp) cancelTransform();
    };
    const canvasFocus = () => {
      container.dataset.navigationActive = "true";
    };
    const visibilityChanged = () => {
      if (document.hidden) clearMovement();
    };
    const detachKeyboard = bindCameraKeyboardInput(
      keyboard,
      {
        keyboard: viewWindow,
        canvas: renderer.domElement,
        window: viewWindow,
        document,
      },
      navigationContext,
      () => document.hidden,
    );
    renderer.domElement.addEventListener("focus", canvasFocus);
    renderer.domElement.addEventListener("blur", clearMovement);
    renderer.domElement.addEventListener("pointerup", normalPointerUp, true);
    renderer.domElement.addEventListener("pointercancel", canceledPointer);
    renderer.domElement.addEventListener("lostpointercapture", canceledPointer);
    viewWindow.addEventListener("blur", clearMovement);
    document.addEventListener("visibilitychange", visibilityChanged);
    transform.addEventListener("dragging-changed", (event) => {
      moving = Boolean(event.value);
      orbit.enabled = !moving;
      if (moving) {
        dragOrigin = transform.object?.position.clone();
        dragRotation = transform.object?.quaternion.clone();
        keyboard.beginGesture("transform");
      } else keyboard.endGesture("transform");
      publishTransform();
    });
    transform.addEventListener("mouseUp", () => {
      const object = transform.object;
      if (transform.getMode() === "rotate" && object === groupAnchor && dragOrigin && dragRotation) {
        const delta = object.quaternion.clone().multiply(dragRotation.clone().invert()).normalize();
        const committed = callbacks.current.onRotateSelection?.({ x: delta.x, y: delta.y, z: delta.z, w: delta.w }, { x: dragOrigin.x, y: dragOrigin.y, z: dragOrigin.z });
        if (!committed) {
          object.position.copy(dragOrigin);
          object.quaternion.copy(dragRotation);
          restoreGeometry();
        }
      } else if (object === groupAnchor && dragOrigin) {
        const delta = object.position.clone().sub(dragOrigin).round();
        callbacks.current.onTranslateSelection?.({
          x: delta.x,
          y: delta.y,
          z: delta.z,
        });
      } else if (object)
        callbacks.current.onMove(object.userData.id, {
          x: Math.round(object.position.x),
          y: Math.round(object.position.y),
          z: Math.round(object.position.z),
        });
    });
    const focus = (selectedOnly: boolean) => {
      const targetBounds =
        selectedOnly && transform.object
          ? new THREE.Box3().setFromObject(transform.object)
          : bounds;
      const target = targetBounds.getCenter(new THREE.Vector3());
      const radius = Math.max(
        targetBounds.getSize(new THREE.Vector3()).length() *
          (selectedOnly ? 2.5 : 0.75),
        markerSize * 20,
      );
      orbit.target.copy(target);
      camera.position
        .copy(target)
        .add(new THREE.Vector3(radius * 0.85, radius * 0.7, radius));
      camera.near = Math.max(0.5, radius / 10000);
      camera.far = Math.max(250000, radius * 10);
      camera.updateProjectionMatrix();
      orbit.update();
    };
    let selectedId: string | null = null;
    let attachedSelectionKey = "";
    runtime.current = {
      setVisible(visible) {
        clearMovement();
        if (visible && !animation) {
          previousFrame = viewWindow.performance.now();
          animation = viewWindow.requestAnimationFrame(draw);
        } else if (!visible) {
          viewWindow.cancelAnimationFrame(animation);
          animation = 0;
        }
      },
      setMouseMode(mode) {
        applyCameraMouseMode(orbit, mode);
        container.dataset.primaryDrag = mode;
        renderer.domElement.setAttribute(
          "aria-label",
          `3D viewport. Focus here and hold W A S D to move the camera. Left-drag to ${mode === "pan" ? "pan" : "tilt"}, right-drag to pan, scroll to zoom.`,
        );
      },
      syncRoom(data) {
        data.actors.forEach((actor) => {
          syncMarkerPosition(markers.get(actor.id), actor.position, transform);
          const direction = directions.get(actor.id);
          if (direction)
            direction.rotation.y =
              ((actor.rotation.y & 0x3ff) * Math.PI * 2) / 1024;
        });
        data.events.forEach((event) => {
          if (event.position)
            syncMarkerPosition(
              markers.get(event.id),
              event.position,
              transform,
            );
        });
        if ("authoredMeshes" in data) {
          for (const mesh of data.authoredMeshes) {
            const position = geometryOrigin(data, mesh.id);
            if (position)
              syncMarkerPosition(markers.get(mesh.id), position, transform);
          }
          for (const door of data.doors) {
            syncMarkerPosition(
              markers.get(`door:${door.id}`),
              door.position,
              transform,
            );
            const volume = doorVolumes.get(door.id);
            if (volume) updateDoorVolume(volume, door);
          }
          for (const e of data.entrances)
            syncMarkerPosition(
              markers.get(`entrance:${e.id}`),
              e.position,
              transform,
            );
        }
        actorModels.syncActors([
          ...data.actors,
          ...("doors" in data
            ? data.doors.map((d, index) => ({
                id: `door:${d.id}`,
                index,
                actorId: 0,
                name: "Door appearance",
                position: d.position,
                rotation: d.rotation,
                parameters: [],
                editable: true,
              }))
            : []),
        ]);
        const coverage = actorModels.setPayload(
          data.actorVisuals && data.actorModels
            ? { actorVisuals: data.actorVisuals, actorModels: data.actorModels }
            : null,
        );
        container.dataset.actorModelCount = String(coverage.rendered);
        container.dataset.actorConditionalCount = String(coverage.conditional);
        container.dataset.actorPartialCount = String(coverage.partial);
        container.dataset.actorModelPartCount = String(coverage.parts);
        container.dataset.actorTexturedTriangles = String(
          coverage.texturedTriangles,
        );
        callbacks.current.onActorCoverage({ ...coverage, roomId: data.id });
        actorModels.updateCamera(camera);
        bounds.makeEmpty().union(geometryBounds);
        if (geometryBounds.isEmpty())
          markers.forEach((marker) => bounds.expandByObject(marker));
        if (bounds.isEmpty())
          bounds.set(
            new THREE.Vector3(-500, -100, -500),
            new THREE.Vector3(500, 100, 500),
          );
        if (transform.dragging && transform.object === groupAnchor)
          previewGeometry();
      },
      frame(selectedOnly) {
        if (selectedOnly && choices.current.length > 1) {
          const box = new THREE.Box3();
          for (const id of selectedRecordIds(
            latestRoom.current,
            choices.current,
          )) {
            const model = actorModels.bounds(id),
              marker = markers.get(id);
            if (model) box.union(model);
            else if (marker) box.expandByObject(marker);
          }
          for (const item of choices.current)
            if (item.kind === "geometry") {
              const surface = surfaceFor(item.choice.meshId),
                mesh = latestRoom.current.meshes.find(
                  (value) => value.id === item.choice.meshId,
                );
              if (!surface || !mesh) continue;
              const positions = surface.geometry.getAttribute("position");
              for (const index of geometryVertexIndices(
                {
                  vertices: { length: positions.count },
                  indices: mesh.indices,
                },
                item.choice,
              ))
                box.expandByPoint(
                  new THREE.Vector3()
                    .fromBufferAttribute(positions, index)
                    .applyMatrix4(surface.matrixWorld),
                );
            }
          if (!box.isEmpty()) {
            const center = box.getCenter(new THREE.Vector3()),
              distance = Math.max(
                box.getSize(new THREE.Vector3()).length() * 1.3,
                markerSize * 10,
              );
            orbit.target.copy(center);
            camera.position
              .copy(center)
              .add(new THREE.Vector3(distance, distance * 0.7, distance));
            orbit.update();
          }
          return;
        }
        const object = selectedId ? markers.get(selectedId) : undefined;
        const surface = selectedId ? surfaceFor(selectedId) : undefined;
        if (selectedOnly && (object || surface)) {
          const modelBounds = surface
            ? new THREE.Box3().setFromObject(surface)
            : selectedId
              ? actorModels.bounds(selectedId)
              : null;
          const center =
            modelBounds && !modelBounds.isEmpty()
              ? modelBounds.getCenter(new THREE.Vector3())
              : (object?.position.clone() ?? new THREE.Vector3());
          const distance =
            modelBounds && !modelBounds.isEmpty()
              ? Math.max(
                  modelBounds.getSize(new THREE.Vector3()).length() * 1.3,
                  markerSize * 10,
                )
              : markerSize * 25;
          orbit.target.copy(center);
          camera.position
            .copy(center)
            .add(new THREE.Vector3(distance, distance * 0.7, distance));
          orbit.update();
        } else focus(false);
      },
      update(id, view) {
        const mode = view.transformMode ?? "translate";
        if (transform.getMode() !== mode) { cancelTransform();transform.setMode(mode); }
        container.dataset.transformMode = mode;
        selectedId = id;
        const choice = geometryChoice.current;
        const key = choices.current.map(selectionKey).join("|");
        if (attachedSelectionKey !== key && (moving || transform.dragging))
          cancelTransform();
        attachedSelectionKey = key;
        scene.updateMatrixWorld(true);
        updateSelectionOutlines(view.geometry);
        container.dataset.selectionCount = String(choices.current.length);
        container.dataset.selectionChoices = JSON.stringify(choices.current);
        const geometries = choices.current.filter(
          (value) => value.kind === "geometry",
        );
        container.dataset.selectionOutline =
          view.geometry && geometries.length
            ? (choice?.mode ?? geometries.at(-1)!.choice.mode)
            : "";
        container.dataset.selectionOutlineMesh = geometries
          .map((value) => value.choice.meshId)
          .join(",");
        container.dataset.selectionOutlineCount = String(
          view.geometry ? geometries.length : 0,
        );
        geometryGroup.visible = view.geometry;
        container.dataset.geometryVisible = String(view.geometry);
        grid.visible = view.grid;
        axes.visible = view.axes;
        surfaces.forEach((surface) => {
          const native = view.textures && surface.hasNativeMaterial;
          surface.mesh.material = native ? surface.native : surface.solid;
          surface.native.wireframe = surface.solid.wireframe = view.wireframe;
          surface.edges.visible = !native && !view.wireframe;
        });
        markers.forEach((marker) => {
          marker.visible = marker.userData.geometry
            ? view.geometry
            : marker.userData.event
              ? view.events
              : view.actors;
          (marker.material as THREE.MeshStandardMaterial).emissiveIntensity =
            selectedRecordIds(latestRoom.current, choices.current).has(
              marker.userData.id,
            )
              ? 1.3
              : 0.35;
          marker.scale.setScalar(
            selectedRecordIds(latestRoom.current, choices.current).has(
              marker.userData.id,
            )
              ? 1.18
              : 1,
          );
        });
        actorModels.updateView(choices.current.length > 1 ? null : id, view);
        updateRecordOutlines();
        const object = id ? markers.get(id) : undefined;
        const pivot = groupOrigin();
        if (!moving && pivot) groupAnchor.position.copy(pivot);
        if (!moving) groupAnchor.quaternion.identity();
        const groupVisible = choices.current.every((value) =>
          value.kind === "geometry"
            ? view.geometry
            : Boolean(
                markers.get(
                  latestRoom.current.events.find(
                    (event) => event.id === value.id,
                  )?.actorRef ?? value.id,
                )?.visible,
              ),
        );
        const attached =
          view.translate && (choices.current.length > 1 || mode === "rotate")
            ? (mode === "rotate" ? selectionRotatable(latestRoom.current, choices.current) : selectionMovable(latestRoom.current, choices.current)) &&
              groupVisible &&
              pivot
              ? groupAnchor
              : undefined
            : view.translate && object?.userData.editable && object.visible
              ? object
              : undefined;
        syncTransformAttachment(transform, attached, cancelTransform);
        publishTransform();
      },
    };
    runtime.current.setMouseMode(mousePreference.current);
    runtime.current.update(selected, options);
    focus(false);
    const sharedCamera = cameraSnapshot?.current;
    const previousCamera = validCameraSnapshot(sharedCamera, room.id)
      ? {
          roomId: sharedCamera.roomId,
          position: new THREE.Vector3(...sharedCamera.position),
          target: new THREE.Vector3(...sharedCamera.target),
        }
      : cameraState.current;
    if (previousCamera?.roomId === room.id) {
      camera.position.copy(previousCamera.position);
      orbit.target.copy(previousCamera.target);
      orbit.update();
    }
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let down = { x: 0, y: 0, transform: false };
    const pointerDown = (event: PointerEvent) => {
      renderer.domElement.focus({ preventScroll: true });
      // TransformControls starts the drag before this listener, then clears its
      // dragging/axis flags before our pointerup listener. Keep gesture ownership
      // until release so even a tiny move cannot become a selection click.
      down = {
        x: event.clientX,
        y: event.clientY,
        transform: moving || transform.dragging,
      };
    };
    const contextMenu = (event: MouseEvent) => {
      if (!navigationAllowed.current) return;
      event.preventDefault();
      cancelTransform();
      const pickGeometry = (choice: GeometrySelection) => {
        if (
          !choices.current.some(
            (value) =>
              selectionKey(value) ===
              selectionKey({ kind: "geometry", choice }),
          )
        )
          callbacks.current.onGeometrySelect?.(choice);
      };
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObjects(
        [
          ...actorModels.pickObjects(),
          ...[...markers.values()].filter(
            (m) => m.visible && !m.userData.geometry && m.userData.event,
          ),
          ...(geometryGroup.visible ? surfaces.map((s) => s.mesh) : []),
        ],
        true,
      )[0];
      let id: string | null = null;
      if (
        hit?.object.userData.meshId &&
        (authoredGeometry.has(hit.object.userData.meshId) ||
          room.meshes.some(
            (m) =>
              m.id === hit.object.userData.meshId &&
              m.source === "display-list",
          ))
      ) {
        id = hit.object.userData.meshId;
        const mode = authoredGeometry.has(id!)
          ? (geometryChoice.current?.mode ?? "mesh")
          : "mesh";
        if (mode === "vertex" && hit.face) {
          const attr = (hit.object as THREE.Mesh).geometry.getAttribute(
            "position",
          );
          const vertexIndex = [hit.face.a, hit.face.b, hit.face.c].sort(
            (a, b) =>
              new THREE.Vector3()
                .fromBufferAttribute(attr, a)
                .distanceToSquared(hit.point) -
              new THREE.Vector3()
                .fromBufferAttribute(attr, b)
                .distanceToSquared(hit.point),
          )[0];
          pickGeometry({
            meshId: id!,
            mode,
            vertexIndex,
          });
        } else
          pickGeometry(
            mode === "face"
              ? { meshId: id!, mode, faceIndex: hit.faceIndex ?? 0 }
              : { meshId: id!, mode: "mesh" },
          );
      } else {
        let object: THREE.Object3D | null = hit?.object ?? null;
        while (object && !object.userData.actorRef && !object.userData.id)
          object = object.parent;
        id = object?.userData.actorRef ?? object?.userData.id ?? null;
        if (
          id &&
          !selectedRecordIds(latestRoom.current, choices.current).has(id)
        )
          callbacks.current.onSelect(id);
      }
      callbacks.current.onEditMenu?.({
        document,
        x: event.clientX,
        y: event.clientY,
        id,
      });
    };
    renderer.domElement.addEventListener("contextmenu", contextMenu);
    const pointerUp = (event: PointerEvent) => {
      if (
        down.transform ||
        moving ||
        transform.dragging ||
        transform.axis ||
        event.button !== 0 ||
        Math.hypot(event.clientX - down.x, event.clientY - down.y) > 4
      )
        return;
      const additive = event.metaKey || event.ctrlKey;
      const pickGeometry = (choice: GeometrySelection) =>
        callbacks.current.onGeometrySelect?.(choice, additive);
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(pointer, camera);
      const eventMarkers = [...markers.values()].filter(
        (marker) =>
          marker.userData.event && !marker.userData.geometry && marker.visible,
      );
      const geometryMode =
        geometryChoice.current ??
        choices.current.filter((value) => value.kind === "geometry").at(-1)
          ?.choice;
      if (
        geometryMode &&
        geometryMode.mode !== "mesh" &&
        authoredGeometry.size
      ) {
        const hit = raycaster.intersectObjects(
          surfaces
            .map((s) => s.mesh)
            .filter(
              (m) =>
                geometryGroup.visible &&
                authoredGeometry.has(m.userData.meshId),
            ),
          false,
        )[0];
        if (hit) {
          const id = hit.object.userData.meshId;
          const faceIndex = hit.faceIndex ?? 0;
          if (geometryMode.mode === "vertex" && hit.face) {
            const surface = hit.object as THREE.Mesh;
            const attr = surface.geometry.getAttribute("position");
            const vertexIndex = [hit.face.a, hit.face.b, hit.face.c].sort(
              (a, b) =>
                new THREE.Vector3()
                  .fromBufferAttribute(attr, a)
                  .distanceToSquared(hit.point) -
                new THREE.Vector3()
                  .fromBufferAttribute(attr, b)
                  .distanceToSquared(hit.point),
            )[0];
            pickGeometry({
              meshId: id,
              mode: "vertex",
              vertexIndex,
            });
          } else
            pickGeometry(
              geometryMode.mode === "face"
                ? { meshId: id, mode: "face", faceIndex }
                : { meshId: id, mode: "mesh" },
            );
        } else callbacks.current.onSelect(null, additive);
        return;
      }
      const hit = raycaster.intersectObjects(
        [
          ...actorModels.pickObjects(),
          ...eventMarkers,
          ...(geometryGroup.visible ? [geometryGroup] : []),
        ],
        true,
      )[0];
      if (
        hit?.object.userData.meshId &&
        authoredGeometry.has(hit.object.userData.meshId)
      ) {
        pickGeometry({
          meshId: hit.object.userData.meshId,
          mode: "mesh",
        });
        return;
      }
      if (hit?.object.userData.meshId) {
        pickGeometry({
          meshId: hit.object.userData.meshId,
          mode: "mesh",
        });
        return;
      }
      let hitObject: THREE.Object3D | null = hit?.object ?? null;
      while (
        hitObject &&
        !hitObject.userData.actorRef &&
        !hitObject.userData.id
      )
        hitObject = hitObject.parent;
      callbacks.current.onSelect(
        hitObject
          ? (hitObject.userData.actorRef ?? hitObject.userData.id)
          : null,
        additive,
      );
    };
    const dropPosition = (event: DragEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        (-(event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(pointer, camera);
      const hit = geometryGroup.visible
        ? raycaster.intersectObjects(
            surfaces.map((s) => s.mesh),
            false,
          )[0]
        : undefined;
      const point =
        hit?.point ??
        raycaster.ray.intersectPlane(
          new THREE.Plane(new THREE.Vector3(0, 1, 0), 0),
          new THREE.Vector3(),
        );
      return point
        ? {
            x: Math.round(point.x),
            y: Math.round(point.y),
            z: Math.round(point.z),
          }
        : null;
    };
    const dragOver = (event: DragEvent) => {
      if (
        callbacks.current.onAssetDrop &&
        navigationAllowed.current &&
        event.dataTransfer?.types.includes("application/x-mnsg-asset")
      ) {
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        keyboard.cancelGestures();
      }
    };
    const drop = (event: DragEvent) => {
      if (!callbacks.current.onAssetDrop || !navigationAllowed.current) return;
      event.preventDefault();
      cancelTransform();
      try {
        const item = JSON.parse(
          event.dataTransfer?.getData("application/x-mnsg-asset") ?? "",
        );
        const position = dropPosition(event);
        if (
          position &&
          ["actor", "geometry", "skybox"].includes(item.kind) &&
          typeof item.id === "string"
        )
          callbacks.current.onAssetDrop(item, position);
      } catch {
        /* Foreign drag payload is not an editor asset. */
      }
    };
    renderer.domElement.addEventListener("dragover", dragOver);
    renderer.domElement.addEventListener("drop", drop);
    renderer.domElement.addEventListener("pointerdown", pointerDown);
    renderer.domElement.addEventListener("pointerup", pointerUp);
    const resize = new (
      viewWindow as Window & typeof globalThis
    ).ResizeObserver(() => {
      const width = container.clientWidth;
      const height = container.clientHeight;
      if (width < 1 || height < 1) return;
      renderer.setSize(width, height);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    });
    resize.observe(container);
    let animation = 0;
    let previousFrame = viewWindow.performance.now();
    const draw = (now: number) => {
      animation = 0;
      if (!sceneShown.current) return;
      animation = viewWindow.requestAnimationFrame(draw);
      const deltaSeconds = (now - previousFrame) / 1000;
      previousFrame = now;
      orbit.update();
      keyboard.step(deltaSeconds, navigationContext());
      // Orbit's change threshold can omit the final damping increments.
      publishCamera();
      compass.update(camera);
      if (cameraSnapshot)
        cameraSnapshot.current = {
          roomId: room.id,
          position: camera.position.toArray() as [number, number, number],
          target: orbit.target.toArray() as [number, number, number],
        };
      actorModels.updateCamera(camera);
      if (recordOutlines.size) updateRecordOutlines();
      if (container.clientWidth && container.clientHeight)
        renderer.render(scene, camera);
    };
    animation = viewWindow.requestAnimationFrame(draw);
    return () => {
      if (cameraSnapshot)
        cameraSnapshot.current = {
          roomId: room.id,
          position: camera.position.toArray() as [number, number, number],
          target: orbit.target.toArray() as [number, number, number],
        };
      cameraState.current = {
        roomId: room.id,
        position: camera.position.clone(),
        target: orbit.target.clone(),
      };
      viewWindow.cancelAnimationFrame(animation);
      clearMovement();
      detachKeyboard();
      renderer.domElement.removeEventListener("focus", canvasFocus);
      renderer.domElement.removeEventListener("blur", clearMovement);
      renderer.domElement.removeEventListener(
        "pointerup",
        normalPointerUp,
        true,
      );
      renderer.domElement.removeEventListener("pointercancel", canceledPointer);
      renderer.domElement.removeEventListener(
        "lostpointercapture",
        canceledPointer,
      );
      viewWindow.removeEventListener("blur", clearMovement);
      document.removeEventListener("visibilitychange", visibilityChanged);
      resize.disconnect();
      renderer.domElement.removeEventListener("contextmenu", contextMenu);
      renderer.domElement.removeEventListener("pointerdown", pointerDown);
      renderer.domElement.removeEventListener("pointerup", pointerUp);
      orbit.removeEventListener("change", publishCamera);
      orbit.removeEventListener("start", orbitStart);
      orbit.removeEventListener("end", orbitEnd);
      transform.removeEventListener("objectChange", publishTransform);
      transform.removeEventListener("axis-changed", publishTransform);
      transform.dispose();
      orbit.dispose();
      actorModels.dispose();
      selectionOutlines.forEach((outline) => outline.dispose());
      recordOutlines.forEach((outline) => {
        outline.removeFromParent();
        outline.geometry.dispose();
        (outline.material as THREE.Material).dispose();
      });
      scene.traverse((object) => {
        if (
          object instanceof THREE.Mesh ||
          object instanceof THREE.LineSegments
        )
          object.geometry.dispose();
      });
      materials.forEach((material) => material.dispose());
      texturePool.dispose();
      skyTexture?.dispose();
      transform.removeEventListener("objectChange", previewGeometry);
      renderer.domElement.removeEventListener("dragover", dragOver);
      renderer.domElement.removeEventListener("drop", drop);
      const gridMaterial = grid.material;
      if (Array.isArray(gridMaterial))
        gridMaterial.forEach((material) => material.dispose());
      else gridMaterial.dispose();
      if (Array.isArray(axes.material))
        axes.material.forEach((material) => material.dispose());
      else axes.material.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      container.removeChild(renderer.domElement);
      compass.element.remove();
      runtime.current = null;
    };
    // Scene data changes intentionally rebuild and dispose all GPU resources.
    // Selection and visibility update separately below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    hostWindow,
    room.id,
    room.meshes,
    room.textures,
    markerRoster,
    "skybox" in room ? room.skybox : undefined,
  ]);

  useEffect(() => {
    runtime.current?.setVisible(sceneVisible);
  }, [sceneVisible]);
  useEffect(() => {
    runtime.current?.setMouseMode(mouseMode);
  }, [mouseMode]);
  useEffect(() => {
    runtime.current?.syncRoom(room);
    runtime.current?.update(selected, options);
  }, [selected, options, room, geometrySelection, selections]);
  useEffect(() => {
    if (frame.version) runtime.current?.frame(frame.selected);
  }, [frame]);
  return (
    <div
      className="scene-host"
      data-testid="viewport-canvas"
      ref={host}
      aria-label="Interactive 3D room viewport"
    >
      {failure && (
        <div className="scene-failure" role="alert">
          {failure}
        </div>
      )}
    </div>
  );
}
