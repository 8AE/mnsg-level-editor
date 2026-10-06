import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { emptyRoom } from "../components/authoringModel";
import { sampleRoom } from "../components/editorModel";
import { selectedGeometryVertices, type EditorSelection } from "../components/editorSelection";
import { rotateNativeAngles, rotateProjectSelection, rotationQuaternion } from "../components/selectionRotation";
import { nativeActorPlacementMatrix } from "../core/rom/actors-pose";
import { prepareEditableRoom } from "../components/editableRoom";
import { importRomBytes } from "../core/rom";
import { createProject } from "../core/project";
import { composeProjectRoom } from "../core/authoring/scene";
import { createDocumentHistory, transactDocument, undoDocument } from "../components/authoringState";
import type { EditorProjectV2, ProjectRoomScene } from "../shared/types";

function fixture() {
  const authored = emptyRoom(620, "Rotation", 465);
  authored.materials = [{ id: "material", sourceMaterialId: "native" }];
  authored.meshes = [{ id: "mesh", materialId: "material", vertices: [[0, 0], [20, 0], [0, 20], [20, 20], [100, 100]].map(([x, y]) => ({ position: { x, y, z: 0 }, uv: [x, y] as [number, number], color: [1, 2, 3, 255] as [number, number, number, number] })), indices: [0, 1, 2, 1, 3, 2] }];
  authored.actors = [{ id: "actor", prototypeId: "prototype", position: { x: 12, y: 3, z: 9 }, rotation: { x: 0, y: 0, z: 0 }, parameters: [1, 2, 3] }];
  const scene: ProjectRoomScene = { ...sampleRoom, id: 620, kind: "new", authoredMeshes: authored.meshes, actors: authored.actors.map(a => ({ ...a, index: 0, actorId: 1, name: "Actor", editable: true })), events: [{ id: "alias", actorRef: "actor", index: 0, name: "Alias", kind: "Actor", position: { ...authored.actors[0].position }, values: [], editable: false }], meshes: authored.meshes.map(m => ({ id: m.id, source: "display-list", positions: m.vertices.flatMap(v => [v.position.x, v.position.y, v.position.z]), indices: m.indices })), collisionMode: authored.collisionMode, collision: [], doors: [], entrances: [] };
  const project = { format: "mnsg-level-project", version: 2, id: "project", name: "Rotation", rom: { normalizedSha256: "a".repeat(64) }, createdAt: "time", updatedAt: "time", authoredRooms: { 620: authored }, roomOverrides: {} } as unknown as EditorProjectV2;
  const face = (faceIndex: number): EditorSelection => ({ kind: "geometry", choice: { meshId: "mesh", mode: "face", faceIndex } });
  return { authored, scene, project, face };
}
const quarterTurn = { x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 };
test("face-group rotation turns shared vertices once, preserves attributes and retains one Undo", () => {
  const { project, scene, authored, face } = fixture(), before = JSON.stringify(project), selections = [face(0), face(1)];
  assert.equal(selectedGeometryVertices(scene, selections).get("mesh")?.size, 4);
  const next = rotateProjectSelection(project, scene, selections, quarterTurn, { x: 10, y: 10, z: 0 }, false) as EditorProjectV2;
  assert.deepEqual(next.authoredRooms[620].meshes[0].vertices.map(v => v.position), [{ x: 20, y: 0, z: 0 }, { x: 20, y: 20, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 20, z: 0 }, { x: 100, y: 100, z: 0 }]);
  for (let i = 0; i < 5; i++) assert.deepEqual(next.authoredRooms[620].meshes[0].vertices[i].uv, authored.meshes[0].vertices[i].uv);
  assert.deepEqual(next.authoredRooms[620].meshes[0].indices, authored.meshes[0].indices);
  assert.equal(JSON.stringify(project), before);
  assert.deepEqual(undoDocument(transactDocument(createDocumentHistory(project), next)).present, project);
  assert.deepEqual(selections, [face(0), face(1)]);
});
test("mixed actor/event aliases rotate one placement and its orientation exactly once", () => {
  const { project, scene, face } = fixture();
  const selections: EditorSelection[] = [face(0), { kind: "record", id: "actor" }, { kind: "record", id: "alias" }];
  const next = rotateProjectSelection(project, scene, selections, quarterTurn, { x: 10, y: 10, z: 0 }, false) as EditorProjectV2;
  assert.deepEqual(next.authoredRooms[620].actors[0].position, { x: 17, y: 12, z: 9 });
  assert.deepEqual(next.authoredRooms[620].actors[0].rotation, { x: 0, y: 0, z: 256 });
  assert.deepEqual(next.authoredRooms[620].actors[0].parameters, [1, 2, 3]);
  assert.deepEqual(next.roomOverrides, {});
});
test("native rotation composes world axes in the native ZYX convention and keeps billboard sentinels", () => {
  const angles = { x: 100, y: 200, z: 300 }, q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 3);
  const result = rotateNativeAngles(angles, q);
  const original = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().fromArray(nativeActorPlacementMatrix({ x: 0, y: 0, z: 0 }, angles)));
  const actual = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().fromArray(nativeActorPlacementMatrix({ x: 0, y: 0, z: 0 }, result)));
  assert.ok(q.multiply(original).angleTo(actual) < Math.PI * 2 / 1024 * 2, "native quantization stays within two angle units");
  assert.deepEqual(rotateNativeAngles({ x: -32768, y: 0, z: -32768 }, rotationQuaternion(quarterTurn)), { x: -32768, y: 0, z: -32768 });
});
test("invalid rotations and coordinate overflow reject atomically", () => {
  const { project, scene, face } = fixture(), before = JSON.stringify(project);
  assert.throws(() => rotateProjectSelection(project, scene, [face(0)], { x: NaN, y: 0, z: 0, w: 1 }, { x: 0, y: 0, z: 0 }, false), /unit quaternion/);
  assert.throws(() => rotateProjectSelection(project, scene, [face(0)], quarterTurn, { x: 100000, y: 0, z: 0 }, false), /Vertex coordinates/);
  assert.equal(JSON.stringify(project), before);
  assert.equal(rotateProjectSelection(project, scene, [face(0)], { x: 0, y: 0, z: 0, w: 1 }, { x: 0, y: 0, z: 0 }, false), project);
});
test("native rooms stage editable geometry without changing the project, source, selection IDs or textures", { skip: !process.env.MNSG_TEST_ROM }, () => {
  const rom = importRomBytes(readFileSync(process.env.MNSG_TEST_ROM!)), catalog = rom.getAuthoringCatalog(), project = createProject("Staged rooms", rom.identity);
  const lookup = { catalog, nativeRooms: rom.listRooms(), loadRoom: rom.loadAuthoringRoom.bind(rom), resolveMaterial: rom.resolveAuthoringMaterial.bind(rom), loadActorPrototype: rom.loadActorPrototype.bind(rom), loadSkyboxAsset: rom.loadSkyboxAsset.bind(rom), nativeRoomSkyboxId: rom.nativeRoomSkyboxId.bind(rom) };
  const sourceHash = createHash("sha256").update(rom.bytes).digest("hex"), projectBefore = JSON.stringify(project);
  for (const id of [465, 353, 21, 99]) {
    const scene = composeProjectRoom(project, id, lookup), before = JSON.stringify(scene), entry = catalog.geometry.find(a => a.roomIds.includes(id) && a.id.startsWith("geometry:"));
    const staged = prepareEditableRoom(scene, catalog, entry ? rom.loadGeometryAsset(entry.id) : undefined);
    assert.deepEqual(staged.authored.meshes.map(m => m.id), scene.meshes.filter(m => m.source === "display-list").map(m => m.id));
    assert.deepEqual(staged.authored.actors.map(a => a.id), scene.actors.map(a => a.id));
    assert.equal(staged.scene.meshes, scene.meshes);
    assert.equal(staged.scene.textures, scene.textures);
    assert.equal(JSON.stringify(scene), before);
  }
  assert.equal(JSON.stringify(project), projectBefore);
  assert.equal(createHash("sha256").update(rom.bytes).digest("hex"), sourceHash);
});
