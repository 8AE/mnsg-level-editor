"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import type { RoomData, Vec3 } from "../shared/types";
import { createNativeSurfaceMaterial, linearNativeColors, RoomTexturePool, type RenderTextureCoverage } from "./roomMaterials";
import { bindCameraKeyboardInput, CameraKeyboardControls, cancelTransformPreview, syncMarkerPosition, syncTransformAttachment, type NavigationContext } from "./cameraControls";
import { ActorModelLayer, type ActorRenderCoverage } from "./actorModelScene";

export interface ViewOptions { geometry: boolean; textures: boolean; grid: boolean; axes: boolean; wireframe: boolean; actors: boolean; events: boolean; translate: boolean }
interface Props {
  room: RoomData;
  selected: string | null;
  options: ViewOptions;
  frame: { version: number; selected: boolean };
  onSelect(id: string | null): void;
  onMove(id: string, position: Vec3): void;
  onCoverage(coverage: RenderTextureCoverage): void;
  onActorCoverage(coverage: ActorRenderCoverage & { roomId: number }): void;
  navigationEnabled: boolean;
}

export default function RoomViewport({ room, selected, options, frame, onSelect, onMove, onCoverage, onActorCoverage, navigationEnabled }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onSelect, onMove, onCoverage, onActorCoverage });
  callbacks.current = { onSelect, onMove, onCoverage, onActorCoverage };
  const navigationAllowed = useRef(navigationEnabled);
  navigationAllowed.current = navigationEnabled;
  const latestRoom = useRef(room);
  latestRoom.current = room;
  const [failure, setFailure] = useState<string | null>(null);
  const cameraState = useRef<{ roomId: number; position: THREE.Vector3; target: THREE.Vector3 } | null>(null);
  const markerRoster = `${room.actors.map(actor => actor.id).join("|")}/${room.events.map(event => event.id).join("|")}`;
  const runtime = useRef<{ frame(selectedOnly: boolean): void; update(selected: string | null, options: ViewOptions): void; syncRoom(room: RoomData): void } | null>(null);

  useEffect(() => {
    const container = host.current;
    if (!container) return;
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false }); }
    catch { setFailure("3D rendering could not start. Enable hardware acceleration or update your graphics driver. Room data remains available in the inspector."); return; }
    setFailure(null);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(renderer.domElement);
    renderer.domElement.tabIndex = 0;
    renderer.domElement.setAttribute("aria-label", "3D viewport. Focus here and hold W A S D to move the camera. Drag to orbit, right-drag to pan, scroll to zoom.");
    renderer.domElement.dataset.testid = "viewport-navigation-canvas";
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x111719);
    const camera = new THREE.PerspectiveCamera(42, 1, 0.5, 250000);
    const orbit = new OrbitControls(camera, renderer.domElement);
    orbit.enableDamping = true;
    orbit.dampingFactor = 0.12;
    orbit.maxDistance = 150000;
    const publishCamera = () => {
      container.dataset.cameraPosition = camera.position.toArray().map(value => value.toFixed(5)).join(",");
      container.dataset.cameraTarget = orbit.target.toArray().map(value => value.toFixed(5)).join(",");
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
    const surfaces: { mesh: THREE.Mesh; solid: THREE.MeshStandardMaterial; native: THREE.MeshBasicMaterial; edges: THREE.LineSegments; hasNativeMaterial: boolean }[] = [];
    let texturedTriangles = 0;
    const textureWarnings = new Set<string>();
    room.meshes.forEach((data, drawIndex) => {
      if (!data.positions.length || !data.indices.length) return;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(data.positions, 3));
      geometry.setIndex(data.indices);
      if (data.colors?.length === data.positions.length) geometry.setAttribute("color", new THREE.BufferAttribute(linearNativeColors(data.colors), 3));
      if (data.uvs?.length === data.positions.length / 3 * 2) geometry.setAttribute("uv", new THREE.Float32BufferAttribute(data.uvs, 2));
      if (data.normals?.length === data.positions.length) geometry.setAttribute("normal", new THREE.Float32BufferAttribute(data.normals, 3)); else geometry.computeVertexNormals();
      const material = new THREE.MeshStandardMaterial({ color: 0x55726b, roughness: 0.95, metalness: 0.08, side: THREE.DoubleSide, vertexColors: Boolean(data.colors?.length) });
      const native = createNativeSurfaceMaterial(data, texturePool);
      materials.push(material, native.material);
      if (native.textured) texturedTriangles += data.indices.length / 3;
      if (native.warning) textureWarnings.add(native.warning);
      const mesh = new THREE.Mesh(geometry, material);
      // Keep contiguous native batches in their source sequence, including the
      // transparent queue; depth sorting must not regroup alpha surfaces by hash.
      mesh.renderOrder = drawIndex;
      geometryGroup.add(mesh);
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 25), new THREE.LineBasicMaterial({ color: 0x84ae9f, transparent: true, opacity: 0.28 }));
      materials.push(edges.material);
      mesh.add(edges);
      surfaces.push({ mesh, solid: material, native: native.material, edges, hasNativeMaterial: Boolean(data.material) });
    });
    container.dataset.texturedTriangles = String(texturedTriangles);
    container.dataset.textureCount = String(texturePool.size);
    callbacks.current.onCoverage({ roomId: room.id, textured: texturedTriangles, total: room.meshes.reduce((sum, mesh) => sum + mesh.indices.length / 3, 0), images: texturePool.size, warnings: [...textureWarnings] });
    const geometryBounds = new THREE.Box3().setFromObject(geometryGroup);
    const span = geometryBounds.isEmpty() ? 1000 : Math.max(geometryBounds.getSize(new THREE.Vector3()).length(), 100);
    const markerSize = THREE.MathUtils.clamp(span / 70, 8, 90);
    const markers = new Map<string, THREE.Mesh>();
    const directions = new Map<string, THREE.Group>();
    const addMarker = (id: string, position: Vec3, event: boolean, editable: boolean) => {
      const geometry = event ? new THREE.OctahedronGeometry(markerSize, 0) : new THREE.CylinderGeometry(markerSize * 0.58, markerSize * 0.58, markerSize * 2.6, 8);
      geometry.translate(0, event ? markerSize : markerSize * 1.3, 0);
      const material = new THREE.MeshStandardMaterial({ color: event ? 0xeab77a : 0x63ddc5, emissive: event ? 0x795122 : 0x15564a, emissiveIntensity: 0.35, roughness: 0.5 });
      materials.push(material);
      const marker = new THREE.Mesh(geometry, material);
      marker.position.set(position.x, position.y, position.z);
      marker.userData = { id, event, editable };
      markers.set(id, marker);
      scene.add(marker);
      if (!event) {
        const direction = new THREE.Group();
        const tipGeometry = new THREE.ConeGeometry(markerSize * 0.35, markerSize, 6);
        tipGeometry.rotateX(Math.PI / 2);
        const tip = new THREE.Mesh(tipGeometry, material);
        tip.position.set(0, markerSize * 1.2, markerSize * 2.6);
        const shaft = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, markerSize * 1.2, markerSize * 0.5), new THREE.Vector3(0, markerSize * 1.2, markerSize * 2.4)]);
        const lineMaterial = new THREE.LineBasicMaterial({ color: 0x9ff6df });
        materials.push(lineMaterial);
        direction.add(tip, new THREE.LineSegments(shaft, lineMaterial));
        marker.add(direction);
        directions.set(id, direction);
      }
    };
    room.actors.forEach(actor => addMarker(actor.id, actor.position, false, actor.editable && (actor.sourceKind !== "partition" || Boolean(actor.partition))));
    room.events.forEach(event => { if (event.position) addMarker(event.id, event.position, true, event.editable); });
    const actorModels = new ActorModelLayer(scene, markers, directions);
    const bounds = geometryBounds.clone();
    if (bounds.isEmpty()) markers.forEach(marker => bounds.expandByObject(marker));
    if (bounds.isEmpty()) bounds.set(new THREE.Vector3(-500, -100, -500), new THREE.Vector3(500, 100, 500));
    const gridSize = Math.max(1000, Math.ceil(Math.max(bounds.getSize(new THREE.Vector3()).x, bounds.getSize(new THREE.Vector3()).z) / 500) * 700);
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
      container.dataset.transformPreviewPosition = transform.object?.position.toArray().map(value => value.toFixed(5)).join(",") ?? "";
    };
    transform.addEventListener("objectChange", publishTransform);
    transform.addEventListener("axis-changed", publishTransform);
    const orbitStart = () => keyboard.beginGesture("orbit");
    const orbitEnd = () => keyboard.endGesture("orbit");
    orbit.addEventListener("start", orbitStart);
    orbit.addEventListener("end", orbitEnd);
    const navigationContext = (target: EventTarget | null = document.activeElement): NavigationContext => ({
      focused: document.activeElement === renderer.domElement && document.hasFocus(),
      typing: Boolean((target as HTMLElement | null)?.closest?.("input,textarea,select,[contenteditable]:not([contenteditable='false']),[role='textbox']")),
      blocked: !navigationAllowed.current || moving || document.hidden || Boolean(document.querySelector("[role='dialog'][aria-modal='true']")),
    });
    const cancelTransform = () => {
      const id = transform.object?.userData.id;
      const source = latestRoom.current.actors.find(actor => actor.id === id) ?? latestRoom.current.events.find(event => event.id === id);
      cancelTransformPreview(transform, source?.position);
      moving = false; orbit.enabled = true; keyboard.cancelGestures(); publishTransform();
    };
    const clearMovement = () => { cancelTransform(); container.dataset.navigationActive = "false"; };
    let completingPointerUp = false;
    const normalPointerUp = () => { completingPointerUp = true; queueMicrotask(() => { completingPointerUp = false; }); };
    const canceledPointer = () => { if (!completingPointerUp) cancelTransform(); };
    const canvasFocus = () => { container.dataset.navigationActive = "true"; };
    const visibilityChanged = () => { if (document.hidden) clearMovement(); };
    const detachKeyboard = bindCameraKeyboardInput(keyboard, { keyboard: window, canvas: renderer.domElement, window, document }, navigationContext, () => document.hidden);
    renderer.domElement.addEventListener("focus", canvasFocus);
    renderer.domElement.addEventListener("blur", clearMovement);
    renderer.domElement.addEventListener("pointerup", normalPointerUp, true);
    renderer.domElement.addEventListener("pointercancel", canceledPointer);
    renderer.domElement.addEventListener("lostpointercapture", canceledPointer);
    window.addEventListener("blur", clearMovement);
    document.addEventListener("visibilitychange", visibilityChanged);
    transform.addEventListener("dragging-changed", event => {
      moving = Boolean(event.value); orbit.enabled = !moving;
      if (moving) keyboard.beginGesture("transform"); else keyboard.endGesture("transform");
      publishTransform();
    });
    transform.addEventListener("mouseUp", () => {
      const object = transform.object;
      if (object) callbacks.current.onMove(object.userData.id, { x: Math.round(object.position.x), y: Math.round(object.position.y), z: Math.round(object.position.z) });
    });
    const focus = (selectedOnly: boolean) => {
      const targetBounds = selectedOnly && transform.object ? new THREE.Box3().setFromObject(transform.object) : bounds;
      const target = targetBounds.getCenter(new THREE.Vector3());
      const radius = Math.max(targetBounds.getSize(new THREE.Vector3()).length() * (selectedOnly ? 2.5 : 0.75), markerSize * 20);
      orbit.target.copy(target);
      camera.position.copy(target).add(new THREE.Vector3(radius * 0.85, radius * 0.7, radius));
      camera.near = Math.max(0.5, radius / 10000);
      camera.far = Math.max(250000, radius * 10);
      camera.updateProjectionMatrix();
      orbit.update();
    };
    let selectedId: string | null = null;
    runtime.current = {
      syncRoom(data) {
        data.actors.forEach(actor => {
          syncMarkerPosition(markers.get(actor.id), actor.position, transform);
          const direction = directions.get(actor.id);
          if (direction) direction.rotation.y = (actor.rotation.y & 0x3ff) * Math.PI * 2 / 1024;
        });
        data.events.forEach(event => { if (event.position) syncMarkerPosition(markers.get(event.id), event.position, transform); });
        actorModels.syncActors(data.actors);
        const coverage = actorModels.setPayload(data.actorVisuals && data.actorModels ? { actorVisuals: data.actorVisuals, actorModels: data.actorModels } : null);
        container.dataset.actorModelCount = String(coverage.rendered);
        container.dataset.actorConditionalCount = String(coverage.conditional);
        container.dataset.actorPartialCount = String(coverage.partial);
        container.dataset.actorModelPartCount = String(coverage.parts);
        container.dataset.actorTexturedTriangles = String(coverage.texturedTriangles);
        callbacks.current.onActorCoverage({ ...coverage, roomId: data.id });
        actorModels.updateCamera(camera);
        bounds.makeEmpty().union(geometryBounds);
        if (geometryBounds.isEmpty()) markers.forEach(marker => bounds.expandByObject(marker));
        if (bounds.isEmpty()) bounds.set(new THREE.Vector3(-500, -100, -500), new THREE.Vector3(500, 100, 500));
      },
      frame(selectedOnly) {
        const object = selectedId ? markers.get(selectedId) : undefined;
        if (selectedOnly && object) {
          const modelBounds = selectedId ? actorModels.bounds(selectedId) : null;
          const center = modelBounds && !modelBounds.isEmpty() ? modelBounds.getCenter(new THREE.Vector3()) : object.position.clone();
          const distance = modelBounds && !modelBounds.isEmpty() ? Math.max(modelBounds.getSize(new THREE.Vector3()).length() * 1.3, markerSize * 10) : markerSize * 25;
          orbit.target.copy(center);
          camera.position.copy(center).add(new THREE.Vector3(distance, distance * 0.7, distance));
          orbit.update();
        } else focus(false);
      },
      update(id, view) {
        selectedId = id;
        geometryGroup.visible = view.geometry;
        container.dataset.geometryVisible = String(view.geometry);
        grid.visible = view.grid;
        axes.visible = view.axes;
        surfaces.forEach(surface => {
          const native = view.textures && surface.hasNativeMaterial;
          surface.mesh.material = native ? surface.native : surface.solid;
          surface.native.wireframe = surface.solid.wireframe = view.wireframe;
          surface.edges.visible = !native && !view.wireframe;
        });
        markers.forEach(marker => {
          marker.visible = marker.userData.event ? view.events : view.actors;
          (marker.material as THREE.MeshStandardMaterial).emissiveIntensity = marker.userData.id === id ? 1.3 : 0.35;
          marker.scale.setScalar(marker.userData.id === id ? 1.18 : 1);
        });
        actorModels.updateView(id, view);
        const object = id ? markers.get(id) : undefined;
        const attached = view.translate && object?.userData.editable && object.visible ? object : undefined;
        syncTransformAttachment(transform, attached, cancelTransform);
        publishTransform();
      },
    };
    runtime.current.update(selected, options);
    focus(false);
    const previousCamera = cameraState.current;
    if (previousCamera?.roomId === room.id) { camera.position.copy(previousCamera.position); orbit.target.copy(previousCamera.target); orbit.update(); }
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let down = { x: 0, y: 0 };
    const pointerDown = (event: PointerEvent) => { renderer.domElement.focus({ preventScroll: true }); down = { x: event.clientX, y: event.clientY }; };
    const pointerUp = (event: PointerEvent) => {
      if (moving || transform.dragging || transform.axis || event.button !== 0 || Math.hypot(event.clientX - down.x, event.clientY - down.y) > 4) return;
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      const eventMarkers = [...markers.values()].filter(marker => marker.userData.event && marker.visible);
      const hit = raycaster.intersectObjects([...actorModels.pickObjects(), ...eventMarkers], true)[0];
      let hitObject: THREE.Object3D | null = hit?.object ?? null;
      while (hitObject && !hitObject.userData.actorRef && !hitObject.userData.id) hitObject = hitObject.parent;
      callbacks.current.onSelect(hitObject ? hitObject.userData.actorRef ?? hitObject.userData.id : null);
    };
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
      const deltaSeconds = (now - previousFrame) / 1000; previousFrame = now;
      orbit.update(); if (keyboard.step(deltaSeconds, navigationContext())) publishCamera(); actorModels.updateCamera(camera); renderer.render(scene, camera);
    };
    animation = requestAnimationFrame(draw);
    return () => {
      cameraState.current = { roomId: room.id, position: camera.position.clone(), target: orbit.target.clone() };
      cancelAnimationFrame(animation);
      clearMovement();
      detachKeyboard();
      renderer.domElement.removeEventListener("focus", canvasFocus);
      renderer.domElement.removeEventListener("blur", clearMovement);
      renderer.domElement.removeEventListener("pointerup", normalPointerUp, true);
      renderer.domElement.removeEventListener("pointercancel", canceledPointer);
      renderer.domElement.removeEventListener("lostpointercapture", canceledPointer);
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
      transform.dispose(); orbit.dispose();
      actorModels.dispose();
      scene.traverse(object => { if (object instanceof THREE.Mesh || object instanceof THREE.LineSegments) object.geometry.dispose(); });
      materials.forEach(material => material.dispose());
      texturePool.dispose();
      const gridMaterial = grid.material;
      if (Array.isArray(gridMaterial)) gridMaterial.forEach(material => material.dispose()); else gridMaterial.dispose();
      if (Array.isArray(axes.material)) axes.material.forEach(material => material.dispose()); else axes.material.dispose();
      renderer.dispose();
      container.removeChild(renderer.domElement);
      runtime.current = null;
    };
    // Scene data changes intentionally rebuild and dispose all GPU resources.
    // Selection and visibility update separately below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.id, room.meshes, room.textures, markerRoster]);

  useEffect(() => { runtime.current?.syncRoom(room); runtime.current?.update(selected, options); }, [selected, options, room]);
  useEffect(() => { if (frame.version) runtime.current?.frame(frame.selected); }, [frame]);
  return <div className="scene-host" data-testid="viewport-canvas" ref={host} aria-label="Interactive 3D room viewport">{failure && <div className="scene-failure" role="alert">{failure}</div>}</div>;
}
