import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import * as THREE from "three";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import type { ActorData, ActorModel, ActorOverride, ActorVisual, ActorVisualPart, ActorVisualPayload, AxisFlags } from "../shared/types";
import { ActorModelLayer, actorPartMatrix } from "../components/actorModelScene";
import { requestActorVisuals } from "../components/actorVisualRequests";
import { cancelTransformPreview, syncMarkerPosition, syncTransformAttachment } from "../components/cameraControls";

const identity = () => new THREE.Matrix4().toArray();
const actor: ActorData = { id: "fixture:actor", index: 0, actorId: 1, name: "Fixture", position: { x: 100, y: 200, z: 300 }, rotation: { x: 0, y: 256, z: 0 }, parameters: [0, 0, 0], source: { romOffset: 0, expectedHex: "" }, editable: true };
const noAxes: AxisFlags = { x: false, y: false, z: false };
const part: ActorVisualPart = { assetId: "fixture:model", rootMatrix: new THREE.Matrix4().makeScale(2, 2, 2).toArray(), positionOffset: { x: 0, y: 10, z: 0 }, rotationOverrides: {}, billboardAxes: noAxes, pose: "initial-frame", provenance: { identity: 1, slot: 0, fileIds: [], modelPointer: 0 } };
const model: ActorModel = {
  id: part.assetId, warnings: ["Fixture initial pose"], textures: [{ id: "white", width: 1, height: 1, rgbaBase64: "/////w==", format: "fixture" }],
  meshes: [{ id: "fixture:triangle", source: "display-list", positions: [1, 0, 0, 2, 0, 0, 1, 1, 0], indices: [0, 1, 2], uvs: [0, 0, 1, 0, 0, 1], material: { textureId: "white", wrapS: "repeat", wrapT: "repeat", filter: "nearest", color: [1, 1, 1], opacity: 1, alphaTest: 0, vertexColors: false, lighting: false } }],
  nodes: [{ parentIndex: null, matrix: new THREE.Matrix4().makeTranslation(3, 0, 0).toArray(), meshIndices: [] }, { parentIndex: 0, matrix: new THREE.Matrix4().makeTranslation(0, 0, 4).toArray(), meshIndices: [0] }],
};
const visual: ActorVisual = { actorRef: actor.id, status: "supported", parts: [part], warnings: ["Fixture visual warning"] };
const payload: ActorVisualPayload = { actorModels: [model], actorVisuals: [visual] };
function setup(actors = [actor]) {
  const scene = new THREE.Scene(), proxies = new Map<string, THREE.Mesh>();
  for (const source of actors) { const proxy = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial()); proxy.position.set(source.position.x, source.position.y, source.position.z); proxy.userData.id = source.id; scene.add(proxy); proxies.set(source.id, proxy); }
  const layer = new ActorModelLayer(scene, proxies, new Map()); layer.syncActors(actors);
  const camera = new THREE.PerspectiveCamera(42, 1); camera.position.set(0, 0, 100); camera.lookAt(0, 0, 0);
  return { scene, proxies, layer, camera, dispose() { layer.dispose(); proxies.forEach(proxy => { proxy.geometry.dispose(); (proxy.material as THREE.Material).dispose(); }); } };
}
function meshes(scene: THREE.Scene) { const result: THREE.Mesh[] = []; scene.traverse(object => { if (object instanceof THREE.Mesh && object.userData.actorRef) result.push(object); }); return result; }
function near(actual: THREE.Vector3, expected: number[]) { assert.ok(actual.distanceTo(new THREE.Vector3(...expected)) < 1e-5, `${actual.toArray()} != ${expected}`); }

test("native child hierarchy, root scale, placement offset and phase angles apply exactly once", () => {
  const fixture = setup(); fixture.layer.setPayload(payload); fixture.layer.updateCamera(fixture.camera);
  const mesh = meshes(fixture.scene)[0];
  near(new THREE.Vector3(1, 0, 0).applyMatrix4(mesh.matrixWorld), [108, 210, 292]);
  assert.equal(fixture.proxies.get(actor.id)!.position.x, 100, "gizmo proxy remains the source actor origin");
  const bounds = fixture.layer.bounds(actor.id)!; assert.ok(bounds.min.y >= 210);
  const overridden = actorPartMatrix(actor, { ...part, rotationOverrides: { y: -32768 } }, { x: 0, y: 0, z: 1 });
  near(new THREE.Vector3(1, 0, 0).applyMatrix4(overridden), [2, 10, 0]);
  const prior = mesh.geometry.getAttribute("position").array.slice();
  fixture.layer.syncActors([{ ...actor, position: { x: 100, y: 200, z: 300 }, rotation: { x: 0, y: 0, z: 0 } }]);
  fixture.layer.updateCamera(fixture.camera);
  near(new THREE.Vector3(1, 0, 0).applyMatrix4(mesh.matrixWorld), [108, 210, 308]);
  assert.deepEqual(mesh.geometry.getAttribute("position").array, prior, "live placement cannot bake transforms into shared vertices");
  fixture.dispose();
});

test("multipart placements share GPU assets; selection/view switches preserve native appearance and dispose once", () => {
  const other = { ...actor, id: "fixture:other", index: 1 };
  const fixture = setup([actor, other]);
  const coverage = fixture.layer.setPayload({ actorModels: [model], actorVisuals: [visual, { ...visual, actorRef: other.id, parts: [part, { ...part, positionOffset: { x: 20, y: 0, z: 0 } }] }] });
  assert.equal(coverage.rendered, 2); assert.equal(coverage.parts, 3); assert.equal(coverage.texturedTriangles, 3);
  assert.ok(coverage.warnings.includes("Fixture initial pose")); assert.ok(coverage.warnings.includes("Fixture visual warning"));
  const draws = meshes(fixture.scene); assert.equal(draws.length, 3);
  assert.equal(draws[0].geometry, draws[1].geometry); assert.equal(draws[0].material, draws[2].material);
  const native = draws[0].material as THREE.MeshBasicMaterial, nativeColor = native.color.clone(), texture = native.map!;
  fixture.layer.updateView(actor.id, { actors: true, textures: true, wireframe: false });
  assert.deepEqual(fixture.proxies.get(actor.id)!.scale.toArray(), [1, 1, 1]); assert.equal(native.color.equals(nativeColor), true);
  fixture.layer.updateView(actor.id, { actors: false, textures: false, wireframe: true });
  assert.equal(fixture.proxies.get(actor.id)!.visible, false); assert.equal(fixture.layer.pickObjects().length, 0);
  assert.notEqual(draws[0].material, native); assert.equal((draws[0].material as THREE.MeshBasicMaterial).wireframe, true);
  fixture.layer.updateView(actor.id, { actors: true, textures: true, wireframe: false }); assert.equal(draws[0].material, native);
  let geometryDisposals = 0, materialDisposals = 0, textureDisposals = 0;
  draws[0].geometry.addEventListener("dispose", () => geometryDisposals++); native.addEventListener("dispose", () => materialDisposals++); texture.addEventListener("dispose", () => textureDisposals++);
  fixture.dispose(); assert.equal(geometryDisposals, 1); assert.equal(materialDisposals, 1); assert.equal(textureDisposals, 1);
});

test("native root and bone billboards follow view direction without guessing Euler angles", () => {
  const sprite = { ...actor, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } };
  const fixture = setup([sprite]);
  const flatModel = { ...model, nodes: [{ parentIndex: null, matrix: identity(), meshIndices: [0] }] };
  const spritePart = { ...part, rootMatrix: identity(), positionOffset: { x: 0, y: 0, z: 0 }, billboardAxes: { x: false, y: true, z: false } };
  fixture.layer.setPayload({ actorModels: [flatModel], actorVisuals: [{ ...visual, parts: [spritePart] }] });
  fixture.layer.updateCamera(fixture.camera); const mesh = meshes(fixture.scene)[0]; near(new THREE.Vector3(1, 0, 0).applyMatrix4(mesh.matrixWorld), [1, 0, 0]);
  fixture.camera.position.set(100, 0, 0); fixture.camera.lookAt(0, 0, 0); fixture.layer.updateCamera(fixture.camera);
  near(new THREE.Vector3(1, 0, 0).applyMatrix4(mesh.matrixWorld), [0, 0, -1]);
  fixture.layer.syncActors([{ ...sprite, rotation: { x: 0, y: 256, z: 0 } }]);
  fixture.layer.setPayload({ actorModels: [{ ...flatModel, nodes: [{ ...flatModel.nodes[0], billboardAxes: { x: false, y: true, z: false } }] }], actorVisuals: [{ ...visual, parts: [{ ...spritePart, billboardAxes: noAxes }] }] });
  fixture.camera.position.set(0, 0, 100); fixture.camera.lookAt(0, 0, 0); fixture.layer.updateCamera(fixture.camera);
  near(new THREE.Vector3(1, 0, 0).applyMatrix4(meshes(fixture.scene)[0].matrixWorld), [1, 0, 0]);
  fixture.dispose();
});

test("recursive native surface picking returns actorRef and repeated payload arrays keep placements alive", () => {
  const source = { ...actor, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } };
  const fixture = setup([source]);
  const simple = { ...model, nodes: [{ parentIndex: null, matrix: identity(), meshIndices: [0] }] };
  const value = { actorModels: [simple], actorVisuals: [{ ...visual, parts: [{ ...part, rootMatrix: identity(), positionOffset: { x: 0, y: 0, z: 0 } }] }] };
  fixture.layer.setPayload(value); fixture.layer.updateCamera(fixture.camera);
  const content = fixture.layer.pickObjects()[0];
  const hits = new THREE.Raycaster(new THREE.Vector3(1.1, 0.1, 10), new THREE.Vector3(0, 0, -1)).intersectObjects(fixture.layer.pickObjects(), true);
  assert.equal(hits[0].object.userData.actorRef, actor.id);
  fixture.layer.setPayload({ ...value }); assert.equal(fixture.layer.pickObjects()[0], content);
  const before = fixture.camera.position.clone();
  fixture.layer.setPayload({ actorModels: [simple], actorVisuals: [{ ...value.actorVisuals[0], warnings: ["Refreshed fixture"] }] });
  assert.equal(fixture.camera.position.equals(before), true, "model refresh must not frame/reset the camera");
  fixture.dispose();
});

test("conditional and partial declarations render known assets while controllers and missing assets remain explicit", () => {
  const sources = [actor, { ...actor, id: "controller" }, { ...actor, id: "partial" }, { ...actor, id: "missing" }];
  const fixture = setup(sources);
  const coverage = fixture.layer.setPayload({ actorModels: [model], actorVisuals: [
    { ...visual, status: "conditional", reason: "Fixture visibility condition" },
    { actorRef: "controller", status: "nonvisual", parts: [], warnings: [] },
    { ...visual, actorRef: "partial", status: "unsupported", reason: "Fixture partial path" },
    { ...visual, actorRef: "missing", parts: [{ ...part, assetId: "absent" }] },
  ] });
  assert.equal(coverage.rendered, 2); assert.equal(coverage.conditional, 1); assert.equal(coverage.partial, 1); assert.equal(coverage.nonvisual, 1); assert.equal(coverage.unsupported, 2);
  assert.match(coverage.failures.missing, /missing/);
  assert.equal((fixture.proxies.get("controller")!.material as THREE.MeshStandardMaterial).wireframe, true);
  assert.equal((fixture.proxies.get("partial")!.material as THREE.MeshStandardMaterial).visible, true);
  assert.equal((fixture.proxies.get(actor.id)!.material as THREE.MeshStandardMaterial).visible, false);
  fixture.dispose();
});

test("actor visual requests retain the previous preview and reject stale success/error completion", async () => {
  const pending: { roomId: number; overrides: Record<string, ActorOverride>; resolve: (value: ActorVisualPayload) => void; reject: (error: Error) => void }[] = [];
  const load = (roomId: number, overrides: Record<string, ActorOverride>) => new Promise<ActorVisualPayload>((resolve, reject) => pending.push({ roomId, overrides, resolve, reject }));
  let displayed = payload, failures = 0, finishes = 0;
  const accept = (value: ActorVisualPayload) => { displayed = value; }, fail = () => { failures++; }, finish = () => { finishes++; };
  const fullOverrides = { [actor.id]: { actorId: 2, parameters: [1, 2, 3], position: { x: 10, y: 20, z: 30 }, rotation: { x: 0, y: 32, z: 0 } } };
  const cancelOld = requestActorVisuals(load, 0, fullOverrides, accept, fail, finish); await setImmediate();
  assert.deepEqual(pending[0].overrides, fullOverrides); assert.equal(displayed, payload);
  cancelOld(); const cancelReset = requestActorVisuals(load, 0, {}, accept, fail, finish); await setImmediate();
  const resetPayload = { actorModels: [], actorVisuals: [] };
  pending[1].resolve(resetPayload); await setImmediate(); pending[0].resolve(payload); await setImmediate();
  assert.equal(displayed, resetPayload); assert.equal(finishes, 1); assert.equal(failures, 0);
  cancelReset(); const cancelError = requestActorVisuals(load, 1, {}, accept, fail, finish); await setImmediate(); cancelError(); pending[2].reject(new Error("old error")); await setImmediate();
  assert.equal(failures, 0); assert.equal(finishes, 1);
});

test("an async native payload arriving during a real gizmo drag preserves preview, axis and one final commit", async () => {
  const source = { ...actor, position: { x: 0, y: 0, z: 0 } };
  const fixture = setup([source]); fixture.layer.setPayload(payload); fixture.layer.updateCamera(fixture.camera);
  const proxy = fixture.proxies.get(actor.id)!;
  const canvas = Object.assign(new EventTarget(), { style: { touchAction: "" } }) as unknown as HTMLElement;
  const transform = new TransformControls(fixture.camera, canvas); fixture.scene.add(transform.getHelper()); transform.attach(proxy);
  fixture.scene.updateMatrixWorld(); fixture.camera.updateMatrixWorld();
  let commits = 0; transform.addEventListener("mouseUp", () => { commits++; });
  transform.axis = "X";
  transform.pointerDown({ x: 0, y: 0, button: 0 } as PointerEvent);
  transform.pointerMove({ x: 0.2, y: 0, button: -1 } as PointerEvent);
  assert.equal(transform.dragging, true); assert.ok(proxy.position.x > 0);
  const preview = proxy.position.clone(), eye = fixture.camera.position.clone();
  let resolve!: (value: ActorVisualPayload) => void;
  const response = new Promise<ActorVisualPayload>(accept => { resolve = accept; });
  const cancelRequest = requestActorVisuals(() => response, 0, {}, value => {
    fixture.layer.syncActors([source]); syncMarkerPosition(proxy, source.position, transform);
    fixture.layer.setPayload(value);
    syncTransformAttachment(transform, proxy, () => cancelTransformPreview(transform, source.position));
    fixture.layer.updateCamera(fixture.camera);
  }, error => { throw error; }, () => {});
  resolve({ ...payload, actorVisuals: [{ ...visual, warnings: ["Fresh fixture payload"] }] }); await setImmediate();
  assert.equal(transform.object, proxy); assert.equal(transform.dragging, true); assert.equal(transform.axis, "X");
  assert.equal(proxy.position.equals(preview), true); assert.equal(fixture.camera.position.equals(eye), true); assert.equal(commits, 0);
  transform.pointerUp({ x: 0.2, y: 0, button: 0 } as PointerEvent);
  assert.equal(commits, 1); assert.equal(proxy.position.equals(preview), true); assert.deepEqual(source.position, { x: 0, y: 0, z: 0 });
  cancelRequest(); transform.dispose(); fixture.dispose();
});

test("generated actor surfaces retain native normals in shared hierarchical assets and toggle without mutation", () => {
  const other = { ...actor, id: "fixture:generated-other", rotation: { x: 0, y: 0, z: 256 } };
  const fixture = setup([actor, other]);
  const nativeNormals = [-128 / 127, 64 / 127, 0, 32 / 127, 0, 1, 0, 0, 0];
  const generated: ActorModel = { ...model, meshes: [{ ...model.meshes[0], uvs: undefined, normals: nativeNormals, material: { ...model.meshes[0].material!, texgen: { mode: "linear", basis: { kind: "editor-camera" }, scale: [1 / 1024, 1 / 1024], offset: [0, 0] } } }] };
  const value = { actorModels: [generated], actorVisuals: [visual, { ...visual, actorRef: other.id, parts: [{ ...part, rootMatrix: new THREE.Matrix4().makeScale(3, .5, 2).toArray() }] }] };
  const fingerprint = JSON.stringify(value);
  const coverage = fixture.layer.setPayload(value);
  assert.equal(coverage.texturedTriangles, 2);
  const draws = meshes(fixture.scene);
  assert.equal(draws[0].geometry, draws[1].geometry); assert.equal(draws[0].material, draws[1].material);
  assert.deepEqual([...draws[0].geometry.getAttribute("normal").array], [...new Float32Array(nativeNormals)]);
  assert.equal(draws[0].geometry.getAttribute("uv"), undefined);
  const native = draws[0].material;
  fixture.camera.position.set(100, 0, 0); fixture.camera.lookAt(0, 0, 0); fixture.layer.updateCamera(fixture.camera);
  fixture.layer.updateView(null, { actors: true, textures: false, wireframe: false });
  assert.notEqual(draws[0].material, native);
  fixture.layer.updateView(null, { actors: true, textures: true, wireframe: false });
  assert.equal(draws[0].material, native);
  assert.equal(JSON.stringify(value), fingerprint);
  fixture.dispose();
  const invalid = setup();
  const refused = invalid.layer.setPayload({ actorModels: [{ ...generated, meshes: [{ ...generated.meshes[0], normals: undefined }] }], actorVisuals: [visual] });
  assert.equal(refused.texturedTriangles, 0); assert.match(refused.warnings.join(" "), /complete verified native normals/);
  assert.equal(meshes(invalid.scene)[0].geometry.getAttribute("normal"), undefined);
  invalid.dispose();
});
