"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import type { RoomData, ProjectRoomScene, Vec3 } from "../shared/types";
import {
  createNativeSurfaceMaterial,
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
import { updateDoorVolume } from "./doorVolume";
import type { LibraryDrop } from "./AssetLibrary";
import { applyCameraMouseMode, type CameraMouseMode } from "./cameraMouse";
import { ActorModelLayer, type ActorRenderCoverage } from "./actorModelScene";

export interface ViewOptions {
  geometry: boolean;
  textures: boolean;
  grid: boolean;
  axes: boolean;
  wireframe: boolean;
  actors: boolean;
  events: boolean;
  translate: boolean;
}
interface Props {
  room: RoomData | ProjectRoomScene;
  selected: string | null;
  options: ViewOptions;
  frame: { version: number; selected: boolean };
  onSelect(id: string | null): void;
  onMove(id: string, position: Vec3): void;
  onCoverage(coverage: RenderTextureCoverage): void;
  onActorCoverage(coverage: ActorRenderCoverage & { roomId: number }): void;
  navigationEnabled: boolean;
  mouseMode?: CameraMouseMode;
  geometrySelection?: GeometrySelection | null;
  onGeometrySelect?(selection: GeometrySelection | null): void;
  onAssetDrop?(asset: LibraryDrop, position: Vec3): void;
}

export default function RoomViewport({
  room,
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
  onAssetDrop,
  mouseMode = "tilt",
}: Props) {
  const host = useRef<HTMLDivElement>(null);
  const callbacks = useRef({
    onSelect,
    onMove,
    onCoverage,
    onActorCoverage,
    onGeometrySelect,
    onAssetDrop,
  });
  callbacks.current = {
    onSelect,
    onMove,
    onCoverage,
    onActorCoverage,
    onGeometrySelect,
    onAssetDrop,
  };
  const geometryChoice = useRef(geometrySelection);
  geometryChoice.current = geometrySelection;
  const mousePreference = useRef(mouseMode);
  mousePreference.current = mouseMode;
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
  } | null>(null);

  useEffect(() => {
    const container = host.current;
    if (!container) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    } catch {
      setFailure(
        "3D rendering could not start. Enable hardware acceleration or update your graphics driver. Room data remains available in the inspector.",
      );
      return;
    }
    setFailure(null);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
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
    const selectionBounds = new THREE.Box3();
    const geometryOutline = new THREE.Box3Helper(selectionBounds, 0x87f2d4);
    geometryOutline.visible = false;
    scene.add(geometryOutline);
    const selectedPoint = new THREE.Mesh(
      new THREE.SphereGeometry(markerSize * 0.35, 12, 8),
      new THREE.MeshBasicMaterial({ color: 0xf9c778, depthTest: false }),
    );
    selectedPoint.visible = false;
    selectedPoint.renderOrder = 30000;
    scene.add(selectedPoint);
    materials.push(selectedPoint.material);
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
    const restoreGeometry = () =>
      authoredGeometry.forEach(({ surface, original }) => {
        const attr = surface.geometry.getAttribute(
          "position",
        ) as THREE.BufferAttribute;
        attr.array.set(original);
        attr.needsUpdate = true;
        surface.geometry.computeBoundingSphere();
      });
    const previewGeometry = () => {
      const object = transform.object;
      if (!object?.userData.geometry) return;
      const id = object.userData.id,
        entry = authoredGeometry.get(id),
        origin = geometryOrigin(latestRoom.current, id);
      if (!entry || !origin) return;
      const attr = entry.surface.geometry.getAttribute(
          "position",
        ) as THREE.BufferAttribute,
        choice = geometryChoice.current;
      attr.array.set(entry.original);
      const delta = object.position
        .clone()
        .sub(new THREE.Vector3(origin.x, origin.y, origin.z));
      const indices =
        choice?.mode === "vertex"
          ? [choice.vertexIndex]
          : choice?.mode === "face"
            ? (("authoredMeshes" in latestRoom.current
                ? latestRoom.current.authoredMeshes.find((m) => m.id === id)
                : undefined
              )?.indices.slice(
                choice.faceIndex * 3,
                choice.faceIndex * 3 + 3,
              ) ?? [])
            : Array.from({ length: attr.count }, (_, i) => i);
      for (const i of indices) {
        attr.setXYZ(
          i,
          entry.original[i * 3] + delta.x,
          entry.original[i * 3 + 1] + delta.y,
          entry.original[i * 3 + 2] + delta.z,
        );
      }
      attr.needsUpdate = true;
      entry.surface.geometry.computeBoundingSphere();
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
        source?.position ??
          extra?.position ??
          geometryOrigin(latestRoom.current, id),
      );
      restoreGeometry();
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
      { keyboard: window, canvas: renderer.domElement, window, document },
      navigationContext,
      () => document.hidden,
    );
    renderer.domElement.addEventListener("focus", canvasFocus);
    renderer.domElement.addEventListener("blur", clearMovement);
    renderer.domElement.addEventListener("pointerup", normalPointerUp, true);
    renderer.domElement.addEventListener("pointercancel", canceledPointer);
    renderer.domElement.addEventListener("lostpointercapture", canceledPointer);
    window.addEventListener("blur", clearMovement);
    document.addEventListener("visibilitychange", visibilityChanged);
    transform.addEventListener("dragging-changed", (event) => {
      moving = Boolean(event.value);
      orbit.enabled = !moving;
      if (moving) keyboard.beginGesture("transform");
      else keyboard.endGesture("transform");
      publishTransform();
    });
    transform.addEventListener("mouseUp", () => {
      const object = transform.object;
      if (object)
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
    runtime.current = {
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
      },
      frame(selectedOnly) {
        const object = selectedId ? markers.get(selectedId) : undefined;
        if (selectedOnly && object) {
          const modelBounds = object.userData.geometry
            ? new THREE.Box3().setFromObject(
                authoredGeometry.get(selectedId!)!.surface,
              )
            : selectedId
              ? actorModels.bounds(selectedId)
              : null;
          const center =
            modelBounds && !modelBounds.isEmpty()
              ? modelBounds.getCenter(new THREE.Vector3())
              : object.position.clone();
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
        selectedId = id;
        const choice = geometryChoice.current,
          entry = choice ? authoredGeometry.get(choice.meshId) : undefined;
        geometryOutline.visible = Boolean(entry && view.geometry);
        selectedPoint.visible = Boolean(
          entry && view.geometry && choice?.mode === "vertex",
        );
        if (entry) {
          selectionBounds.setFromObject(entry.surface);
          const origin = geometryOrigin(latestRoom.current, choice!.meshId);
          if (origin) selectedPoint.position.set(origin.x, origin.y, origin.z);
        }

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
            marker.userData.id === id ? 1.3 : 0.35;
          marker.scale.setScalar(marker.userData.id === id ? 1.18 : 1);
        });
        actorModels.updateView(id, view);
        const object = id ? markers.get(id) : undefined;
        const attached =
          view.translate && object?.userData.editable && object.visible
            ? object
            : undefined;
        syncTransformAttachment(transform, attached, cancelTransform);
        publishTransform();
      },
    };
    runtime.current.setMouseMode(mousePreference.current);
    runtime.current.update(selected, options);
    focus(false);
    const previousCamera = cameraState.current;
    if (previousCamera?.roomId === room.id) {
      camera.position.copy(previousCamera.position);
      orbit.target.copy(previousCamera.target);
      orbit.update();
    }
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let down = { x: 0, y: 0 };
    const pointerDown = (event: PointerEvent) => {
      renderer.domElement.focus({ preventScroll: true });
      down = { x: event.clientX, y: event.clientY };
    };
    const pointerUp = (event: PointerEvent) => {
      if (
        moving ||
        transform.dragging ||
        transform.axis ||
        event.button !== 0 ||
        Math.hypot(event.clientX - down.x, event.clientY - down.y) > 4
      )
        return;
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
      const geometryMode = geometryChoice.current;
      if (geometryMode) {
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
            callbacks.current.onGeometrySelect?.({
              meshId: id,
              mode: "vertex",
              vertexIndex,
            });
          } else
            callbacks.current.onGeometrySelect?.(
              geometryMode.mode === "face"
                ? { meshId: id, mode: "face", faceIndex }
                : { meshId: id, mode: "mesh" },
            );
        }
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
        callbacks.current.onGeometrySelect?.({
          meshId: hit.object.userData.meshId,
          mode: "mesh",
        });
        return;
      }
      if (hit?.object.userData.meshId) return;
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
    const resize = new ResizeObserver(() => {
      const width = container.clientWidth;
      const height = container.clientHeight;
      if (width < 1 || height < 1) return;
      renderer.setSize(width, height);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    });
    resize.observe(container);
    let animation = 0;
    let previousFrame = performance.now();
    const draw = (now: number) => {
      animation = requestAnimationFrame(draw);
      const deltaSeconds = (now - previousFrame) / 1000;
      previousFrame = now;
      orbit.update();
      keyboard.step(deltaSeconds, navigationContext());
      // Orbit's change threshold can omit the final damping increments.
      publishCamera();
      actorModels.updateCamera(camera);
      renderer.render(scene, camera);
    };
    animation = requestAnimationFrame(draw);
    return () => {
      cameraState.current = {
        roomId: room.id,
        position: camera.position.clone(),
        target: orbit.target.clone(),
      };
      cancelAnimationFrame(animation);
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
      window.removeEventListener("blur", clearMovement);
      document.removeEventListener("visibilitychange", visibilityChanged);
      resize.disconnect();
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
      geometryOutline.geometry.dispose();
      (geometryOutline.material as THREE.Material).dispose();
      geometryOutline.removeFromParent();
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
      runtime.current = null;
    };
    // Scene data changes intentionally rebuild and dispose all GPU resources.
    // Selection and visibility update separately below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    room.id,
    room.meshes,
    room.textures,
    markerRoster,
    "skybox" in room ? room.skybox : undefined,
  ]);

  useEffect(() => {
    runtime.current?.setMouseMode(mouseMode);
  }, [mouseMode]);
  useEffect(() => {
    runtime.current?.syncRoom(room);
    runtime.current?.update(selected, options);
  }, [selected, options, room, geometrySelection]);
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
