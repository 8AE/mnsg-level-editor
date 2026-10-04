import assert from "node:assert/strict";
import { mkdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { importRomBytes } from "../core/rom.ts";
import { createProject, validateProject } from "../core/project.ts";
import { composeProjectRoom } from "../core/authoring/scene.ts";
import { NativeCollisionHarness } from "../core/authoring/native-harness.ts";
import { cloneScene } from "../components/authoringModel.ts";
import { generatePatch, exportNrm, inspectToolchain } from "../core/export/index.ts";
import { atomicWrite } from "../electron/storage.ts";

// Usage: node --import tsx scripts/create-authoring-handoff.mjs
//   --rom <own-US-ROM> --out <new-output-directory> --template <mod-template>
// Optional trusted executable paths: --clang, --linker, --mod-tool.
// Add --preserve-cloned-actors to retain House465's eight native placements in
// room620 alongside the coin. Constructor closure does not prove gameplay.
// This script only creates and compiles files. It never installs a mod, starts
// Goemon64Recomp, changes a game profile, or downloads/bundles a ROM.
const flags = new Map();
for (let at = 2; at < process.argv.length; at++) {
  const flag = process.argv[at];
  if (flag === "--preserve-cloned-actors" && !flags.has(flag)) {
    flags.set(flag, true); continue;
  }
  const value = process.argv[++at];
  if (!["--rom", "--out", "--template", "--clang", "--linker", "--mod-tool"].includes(flag) || !value || flags.has(flag))
    throw new Error("Use --rom <own-US-ROM> --out <new-directory> --template <mod-template>; optional --preserve-cloned-actors and --clang, --linker, --mod-tool executable paths.");
  flags.set(flag, value);
}
const romPath = flags.get("--rom") ?? process.env.MNSG_TEST_ROM;
const templatePath = flags.get("--template") ?? process.env.MNSG_TEST_TEMPLATE;
const output = flags.get("--out");
const preserveClonedActors = flags.has("--preserve-cloned-actors");
if (!romPath || !templatePath || !output) throw new Error("ROM, template and output directory are required. No gameplay test is performed.");
const outputPath = path.resolve(output);
try { await stat(outputPath); throw new Error("Choose a new output directory to preserve earlier handoff files."); }
catch (error) { if (error.code !== "ENOENT") throw error; }
await mkdir(outputPath, { recursive: true });
const destination = await realpath(outputPath);
const reportPath = path.join(destination, "handoff.json");
const projectPath = path.join(destination, preserveClonedActors ? "house-465-room-620-full-roster.mnsgproj" : "house-465-room-620.mnsgproj");
const report = { status: "preparing", roomIds: [465, 620], actorMode: preserveClonedActors ? "eight-native-actors-plus-coin" : "coin-only", outputDirectory: destination, reportPath, projectPath, gameplay: "Not installed or run. The user tests the generated NRM in Goemon64Recomp." };
const saveReport = () => atomicWrite(reportPath, JSON.stringify(report, null, 2));
const zero = () => ({ x: 0, y: 0, z: 0 });
const scalar = value => { if (!Number.isInteger(value) || value < -32768 || value > 32767) throw new Error("Handoff placement exceeds native s16 coordinates."); return value; };
const vector = point => Object.fromEntries(Object.entries(point).map(([axis, value]) => [axis, scalar(value)]));

try {
  const database = importRomBytes(new Uint8Array(await readFile(romPath)));
  const catalog = database.getAuthoringCatalog();
  const context = database.authoringExportContext();
  const lookup = {
    catalog, nativeRooms: database.listRooms(), loadRoom: database.loadAuthoringRoom.bind(database),
    resolveMaterial: database.resolveAuthoringMaterial.bind(database),
    loadActorPrototype: database.loadActorPrototype.bind(database),
    loadActorPrototypeForRoom: database.loadActorPrototypeForRoom.bind(database),
    loadSkyboxAsset: database.loadSkyboxAsset.bind(database),
    nativeRoomSkyboxId: database.nativeRoomSkyboxId.bind(database),
  };
  const translation = database.geometryTranslation.bind(database);
  const sourceRoom = 465, newRoomId = 620;
  assert(!lookup.nativeRooms.some(room => room.id === newRoomId), "Room620 must be unoccupied in the canonical ROM");
  const arrival = catalog.nativeEntrances.find(entry => entry.roomId === sourceRoom && entry.id === `arrival:${sourceRoom}`);
  assert(arrival, "House465 must have a verified native default arrival");
  report.rom = { normalizedSha256: database.identity.normalizedSha256, region: database.identity.region };
  report.nativeArrival = arrival;
  const fresh = createProject("House authoring gameplay handoff", database.identity);
  fresh.id = preserveClonedActors ? "house-authoring-handoff-465-620-full-roster" : "house-authoring-handoff-465-620";
  const nativeScene = composeProjectRoom(fresh, sourceRoom, lookup, translation);
  const assetId = database.nativeRoomGeometryAssetId(sourceRoom);
  assert(assetId, "House465 must have verified complete geometry/material provenance");
  const asset = database.loadGeometryAsset(assetId);
  const house = cloneScene(nativeScene, catalog, sourceRoom, "Goemon's House · authoring handoff", "replacement", asset);
  const room = cloneScene(nativeScene, catalog, newRoomId, "House clone · room620", "new", asset);

  // Stable editor IDs make repeated handoff runs easy to compare. Retain every
  // source field and native actor order; never encode runtime pointers here.
  const stabilizeGeometry = authored => {
    const materialIds = new Map(authored.materials.map((material, index) => [material.id, `material:${index}`]));
    authored.materials = authored.materials.map(material => ({ ...material, id: materialIds.get(material.id) }));
    authored.meshes = authored.meshes.map((mesh, index) => ({ ...mesh, id: `mesh:${index}`, materialId: materialIds.get(mesh.materialId) }));
  };
  stabilizeGeometry(house); stabilizeGeometry(room);
  house.actors = house.actors.map((actor, index) => ({ ...actor, id: `house-actor:${index}` }));
  room.actors = room.actors.map((actor, index) => ({ ...actor, id: `clone-actor:${index}` }));
  const clonedActorRoster = structuredClone(room.actors);
  if (preserveClonedActors) assert.equal(clonedActorRoster.length, 8, "Full-roster handoff requires all eight native House465 actors");
  house.skyboxId = undefined; // Preserve exactly the trusted donor environment.
  assert.equal(house.collisionMode, "template"); assert.equal(room.collisionMode, "template");
  assert.equal(house.actors.length, nativeScene.actors.length);
  assert(house.entrances.some(entry => entry.id === arrival.id));
  for (let index = 0; index < house.actors.length; index++) {
    const actor = house.actors[index], original = nativeScene.actors[index];
    assert.deepEqual(actor.position, original.position); assert.deepEqual(actor.rotation, original.rotation);
    assert.deepEqual(actor.parameters, original.parameters);
    assert.equal(actor.spawnPolicy, original.sourceKind === "partition" ? "proximity" : "resident");
    assert.equal(catalog.actorPrototypes.find(prototype => prototype.id === actor.prototypeId).actorId, original.actorId);
  }

  const collision = context.collision(sourceRoom);
  const oracle = new NativeCollisionHarness(database.bytes);
  const floorAt = (x, z) => {
    // Start just above native arrival height, not above the roof: a high ray
    // could select an inaccessible roof rather than the player's actual floor.
    const origin = vector({ x, y: arrival.position.y + 4, z });
    const hit = oracle.query(collision, { origin, direction: { x: 0, y: -1, z: 0 }, maximumDistance: 512 });
    if (!hit.status || hit.normal.y < 0.7) throw new Error(`No verified walkable donor floor at ${x},${z}`);
    const y = Math.round(origin.y + hit.delta.y);
    return { position: vector({ x, y, z }), nativeHit: hit };
  };
  const spawnFloor = floorAt(arrival.position.x, arrival.position.z);
  const offsets = [{ x: 64, z: 0 }, { x: -64, z: 0 }, { x: 0, z: 64 }, { x: 0, z: -64 }];
  const points = [];
  for (const offset of offsets) {
    try {
      const floor = floorAt(arrival.position.x + offset.x, arrival.position.z + offset.z);
      if (Math.abs(floor.position.y - spawnFloor.position.y) > 8) continue;
      const distance = Math.hypot(offset.x, offset.z);
      const wall = oracle.query(collision, {
        origin: { ...spawnFloor.position, y: spawnFloor.position.y + 20 },
        direction: { x: offset.x / distance, y: 0, z: offset.z / distance }, maximumDistance: distance, kind: "horizontal",
      });
      if (wall.status) continue;
      points.push({ offset, ...floor, wallProbe: wall });
    } catch { /* Test the next bounded spawn-relative candidate. */ }
  }
  report.floorCandidates = { spawn: spawnFloor, clearPoints: points };
  assert(points.length >= 1, "Handoff requires a clear, level floor position64units from verified native arrival");
  // The doors occupy separate rooms with identical donor geometry. One proven
  // point is sufficient; prefer a second only when the same bounded queries
  // independently verify it. Keep both arrivals outside either trigger volume.
  const outboundPoint = points[0], returnPoint = points[1] ?? points[0];
  const doorPosition = point => vector({ ...point.position, y: point.position.y - 4 });
  if (!preserveClonedActors) room.actors = [];
  room.doors = [];
  room.entrances = [{ id: "arrival:620", name: "House clone default arrival", position: structuredClone(arrival.position), baseYaw: arrival.baseYaw, entryParameter: arrival.entryParameter }];
  house.doors = [{ id: "to-room-620", position: doorPosition(outboundPoint), rotation: zero(), dimensions: { x: 64, y: 120, z: 32 }, activation: "interact", destination: { roomId: newRoomId, entranceId: "arrival:620" } }];
  room.doors = [{ id: "return-to-house-465", position: doorPosition(returnPoint), rotation: zero(), dimensions: { x: 64, y: 120, z: 32 }, activation: "interact", destination: { roomId: sourceRoom, entranceId: arrival.id } }];

  const coinPosition = vector({ ...spawnFloor.position, y: spawnFloor.position.y + 16 });
  const coinCandidates = catalog.actorPrototypes.filter(prototype => prototype.actorId === 0x082 && prototype.sourceRoomId !== undefined);
  const rejectedCoins = [];
  let selectedCoin;
  for (const prototype of coinCandidates) {
    const edits = { position: coinPosition, rotation: zero(), parameters: [...prototype.parameters] };
    const siblings = room.actors.map(({ prototypeId, parameters, position, rotation }) => ({ prototypeId, parameters, position, rotation }));
    const actorContext = { roomId: newRoomId, templateRoomId: sourceRoom, siblings: [...siblings, { prototypeId: prototype.id, ...edits }] };
    try {
      const native = context.prototype(prototype.id, edits, actorContext);
      const preview = database.loadActorPrototypeForRoom(prototype.id, edits, actorContext);
      assert.equal(native.actorId, 0x082);
      assert(preview.actorVisuals[0]?.parts.length > 0, "Coin must resolve native model bindings in the actual authored room context");
      selectedCoin = { prototype, edits, native, previewParts: preview.actorVisuals[0].parts.length }; break;
    } catch (error) { rejectedCoins.push({ prototypeId: prototype.id, error: error.message }); }
  }
  assert(selectedCoin, `No native082coin prototype passed contextual dependency/model checks: ${JSON.stringify(rejectedCoins)}`);
  room.actors.push({ id: "coin-082", prototypeId: selectedCoin.prototype.id, ...selectedCoin.edits, spawnPolicy: "resident" });
  const sky = catalog.skyboxes.find(asset => asset.nativeIndex === 1) ?? catalog.skyboxes[0];
  assert(sky, "A verified native skybox is required");
  context.skybox(sky.id); room.skyboxId = sky.id;
  fresh.authoredRooms = { [sourceRoom]: house, [newRoomId]: room };
  const project = validateProject(fresh, database.identity, database.loadRoom.bind(database), translation, lookup);
  const scenes = [sourceRoom, newRoomId].map(id => composeProjectRoom(project, id, lookup, translation));
  assert.equal(scenes[0].actors.length, nativeScene.actors.length);
  assert.equal(scenes[1].actors.length, preserveClonedActors ? 9 : 1);
  assert.equal(scenes[1].actors.at(-1).actorId, 0x082);
  if (preserveClonedActors) assert.deepEqual(project.authoredRooms[newRoomId].actors.slice(0, 8), clonedActorRoster, "Full-roster handoff must retain native actor order, parameters, transforms and spawn policies");
  assert.equal(scenes[0].skybox?.id, nativeScene.skybox?.id); assert.equal(scenes[1].skybox?.id, sky.id);
  await atomicWrite(projectPath, JSON.stringify(project));
  report.projectWritten = true;
  report.floorEvidence = { spawn: spawnFloor, outbound: outboundPoint, return: returnPoint, sharedCoordinatesAcrossSeparateRooms: points.length === 1, method: "Offline bounded original MIPS collision queries over private RAM; no game execution." };
  report.changes = [
    `Room465 preserves ${house.actors.length} native actors in source order, exact transforms/parameters/spawn policies, original mesh topology/material provenance/UV/RGBA, template BSP and inherited native sky.`,
    `Room465 adds checker door ${JSON.stringify(house.doors[0])}.`,
    preserveClonedActors ? "Room620 clones House465 geometry and exact template BSP; preserves all eight native actors in original order with exact transforms, parameters and spawn policies, then adds one resident native082coin." : "Room620 clones House465 geometry and exact template BSP; removes all original actors and inserts only one resident native082coin.",
    `Room620 coin ${JSON.stringify(room.actors.at(-1))}; native dependency closure ${selectedCoin.native.dependencyClosure}, preview parts ${selectedCoin.previewParts}.`,
    `Room620 adds checker return door ${JSON.stringify(room.doors[0])}.`,
    `Room620 entrance ${JSON.stringify(room.entrances[0])}; skybox ${sky.id}.`,
  ];
  report.inventory = Object.values(project.authoredRooms).map(authored => ({ id: authored.id, kind: authored.kind, templateRoomId: authored.templateRoomId, meshes: authored.meshes.length, vertices: authored.meshes.reduce((sum, mesh) => sum + mesh.vertices.length, 0), triangles: authored.meshes.reduce((sum, mesh) => sum + mesh.indices.length / 3, 0), materials: authored.materials, collisionMode: authored.collisionMode, collisionTranslation: authored.collisionTranslation ?? zero(), actors: authored.actors, doors: authored.doors, entrances: authored.entrances, skyboxId: authored.skyboxId ?? "inherit-template" }));
  report.status = "project-validated-export-pending";
  await saveReport();

  const tools = { templatePath, ...(flags.has("--clang") ? { clangPath: flags.get("--clang") } : {}), ...(flags.has("--linker") ? { linkerPath: flags.get("--linker") } : {}), ...(flags.has("--mod-tool") ? { modToolPath: flags.get("--mod-tool") } : {}) };
  const toolStatus = await inspectToolchain(tools);
  if (!toolStatus.ready) throw new Error(`NRM toolchain is not ready: ${toolStatus.missing.join("; ")}`);
  const generated = await generatePatch(project, database.loadRoom.bind(database), translation, () => context);
  const exportInventory = JSON.parse(generated.files["authoring-inventory.json"]);
  const exportedRoom = exportInventory.rooms.find(entry => entry.room.id === newRoomId);
  assert.deepEqual(exportedRoom?.room.actors, room.actors, "Compiler inventory must preserve the selected handoff actor roster");
  if (preserveClonedActors) {
    const scenarioResource = exportedRoom.resourceAllocations.find(file => file.fileId === 96);
    assert.equal(scenarioResource?.byteLength, 0xb110, "Full House clone requires the canonical File96 scenario allocation");
    report.controllerResourceProof = { roomId: newRoomId, actorIds: [0x308, 0x34e], scenario: 0x137, scenarioResource, scope: "Guarded static constructor resource closure; future camera callbacks require live camera/player/partner tasks, and scenario VM/gameplay behavior is unverified." };
    report.changes.push("Room620 retains native308 camera and34E scenario controllers; generated resource inventory includes File96 (45328bytes) for scenario0x137. Later camera inputs and scenario behavior require user gameplay testing.");
  }
  const patchDirectory = path.join(destination, "patch"); await mkdir(patchDirectory);
  report.patchPaths = [];
  for (const [name, contents] of Object.entries(generated.files)) {
    assert.equal(path.basename(name), name, "Compiler bundle filenames must stay inside its output folder");
    const file = path.join(patchDirectory, name); await atomicWrite(file, contents); report.patchPaths.push(file);
  }
  assert(report.patchPaths.some(file => file.endsWith(".c")) && report.patchPaths.some(file => file.endsWith(".h")));
  const nrm = await exportNrm(project, database.loadRoom.bind(database), tools, translation, () => context);
  assert(nrm.fileName.endsWith(".nrm") && nrm.bytes.byteLength > 0, "Compiler must return a nonempty native mod artifact");
  const nrmPath = path.join(destination, path.basename(nrm.fileName));
  await atomicWrite(nrmPath, nrm.bytes);
  const buildLogPath = path.join(destination, "build.log"); await atomicWrite(buildLogPath, nrm.buildLog);
  report.nrmPath = nrmPath; report.nrmBytes = nrm.bytes.byteLength; report.buildLogPath = buildLogPath;
  report.warnings = [...new Set([...generated.warnings, ...nrm.warnings])];
  report.status = "compiled-awaiting-user-gameplay";
  report.instructions = [
    "Install the reported NRM yourself, keeping other authored-room mods disabled for this test.",
    "Enter the ordinary Goemon's House room465 through normal gameplay. The generated checker door is64worldunits from the verified default arrival at the exact position recorded above.",
    "Walk into its volume and press A to enter room620. Confirm the house clone, native coin082 and native sky resource; the enclosed house roof may hide the background.",
    "Walk into room620's checker return door and press A. It targets room465's preserved named native default arrival; no debug room entry is needed.",
    "Report geometry/collision, actor/resource, door activation/arrival, sky, unload/reentry or crash issues. Compilation does not prove gameplay behavior.",
    ...(preserveClonedActors ? ["This mode also retains all eight House actors in room620. Native308 camera callbacks need live camera/player/partner state;34E can start scenario0x137 from File96. Test camera movement and native progression/script behavior yourself; this resource closure does not establish runtime parity."] : []),
  ];
  await saveReport();
  await atomicWrite(path.join(destination, "HANDOFF.txt"), [`Status: ${report.status}`, `NRM: ${nrmPath}`, `Project: ${projectPath}`, `Rooms:465 and620`, ...report.changes, "", ...report.instructions, "", ...report.warnings].join("\n") + "\n");
  console.log(JSON.stringify({ status: report.status, reportPath, projectPath, nrmPath, patchPaths: report.patchPaths, roomIds: report.roomIds }, null, 2));
} catch (error) {
  report.status = "failed-not-ready-for-gameplay"; report.error = error.stack ?? String(error);
  await saveReport();
  console.error(JSON.stringify({ status: report.status, reportPath, projectPath: report.projectWritten ? projectPath : undefined, error: error.message }, null, 2));
  process.exitCode = 1;
}
