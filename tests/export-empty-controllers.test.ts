import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {importRomBytes,type ImportedRom} from "../core/rom";
import {createProject,validateProject} from "../core/project";
import type {AuthoringLookup} from "../core/authoring/project";
import type {AuthoredRoom,EditorProjectV2} from "../shared/types";
import {compileAuthoredRoom} from "../core/export/authoring";
import {generatePatch} from "../core/export";
const actual={skip:!process.env.MNSG_TEST_ROM},zero={x:0,y:0,z:0},hash=(b:Uint8Array)=>createHash("sha256").update(b).digest("hex");
let rom:ImportedRom;
function fixture(actorIds:number[],templateRoomId=465){
  rom??=importRomBytes(readFileSync(process.env.MNSG_TEST_ROM!));const catalog=rom.getAuthoringCatalog();
  const lookup:AuthoringLookup={catalog,nativeRooms:rom.listRooms(),loadRoom:rom.loadRoom.bind(rom),resolveMaterial:rom.resolveAuthoringMaterial.bind(rom),loadActorPrototype:rom.loadActorPrototype.bind(rom),loadActorPrototypeForRoom:rom.loadActorPrototypeForRoom.bind(rom),loadSkyboxAsset:rom.loadSkyboxAsset.bind(rom),nativeRoomSkyboxId:rom.nativeRoomSkyboxId.bind(rom)};
  const actors=actorIds.map((id,index)=>{const prototype=catalog.actorPrototypes.find(p=>p.actorId===id)!;assert.ok(prototype);return {id:`library-${id.toString(16)}`,prototypeId:prototype.id,parameters:[...prototype.parameters] as [number,number,number],position:{x:index*30,y:0,z:0},rotation:{...zero},spawnPolicy:"resident" as const};});
  const room:AuthoredRoom={id:621,name:"Guarded empty controller export",kind:"new",templateRoomId,meshes:[],materials:[],collisionMode:"authored",collision:[],actors,doors:[],entrances:[{id:"spawn",name:"Spawn",position:{...zero},baseYaw:0,entryParameter:16}],skyboxId:null};
  const candidate:EditorProjectV2={...createProject("Empty controller C/H regression",rom.identity),authoredRooms:{621:room}};
  const project=validateProject(candidate,rom.identity,rom.loadRoom.bind(rom),rom.geometryTranslation.bind(rom),lookup);
  return {rom,project,context:rom.authoringExportContext()};
}
function integerArray(source:string,name:string):number[]{
  const match=source.match(new RegExp(`static u(?:16|32) ${name}\\[\\] = \\{([^}]+)\\};`));assert.ok(match,`Missing native ${name}`);return match[1].split(",").map(s=>Number(s.trim().replace(/u$/,"")));
}

test("validated authored621 exports079 and07C native definitions with one ordered File24 dependency",actual,async()=>{
  const f=fixture([0x079,0x07c]),beforeProject=JSON.stringify(f.project),beforeRom=hash(f.rom.bytes),room=f.project.authoredRooms[621],compiled=compileAuthoredRoom(room,f.context);
  assert.deepEqual(compiled.actors.map(a=>a.prototype.actorId),[0x079,0x07c]);assert.ok(compiled.actors.every(a=>a.prototype.dependencyClosure==="verified-controller-closure"));assert.ok(compiled.actors.every(a=>a.prototype.dependencyProvenance.some(p=>p.includes("CPU completion is not asserted"))));
  assert.equal(compiled.resources.filter(id=>id===24).length,1);assert.deepEqual(compiled.resourceAllocations.map(a=>a.fileId),compiled.resources);assert.equal(compiled.resourceAllocations.find(a=>a.fileId===24)!.byteLength,0xe80);
  const generated=await generatePatch(f.project,f.rom.loadRoom.bind(f.rom),f.rom.geometryTranslation.bind(f.rom),()=>f.context),source=generated.files["mnsg_level_patch.c"],header=generated.files["mnsg_level_patch.h"];
  assert.ok(source.includes('#include "mnsg_level_patch.h"'));assert.ok(header.includes("#ifndef")&&header.includes("#endif"));
  const resources=integerArray(source,"authored_0_resources"),extents=integerArray(source,"authored_0_resource_extents");assert.deepEqual(resources,[...compiled.resources,0]);assert.equal(resources.filter(id=>id===24).length,1);assert.deepEqual(extents,[...compiled.resourceAllocations.map(a=>a.byteLength),0]);
  const definitions=source.match(/static u32 authored_0_definitions\[\]\[4\][^{]*\{([\s\S]*?)\n\};/)!.at(1)!;
  const rows=[...definitions.matchAll(/\{\s*(0x[0-9a-f]+)u,\s*(0x[0-9a-f]+)u,\s*(0x[0-9a-f]+)u,\s*(0x[0-9a-f]+)u\s*\}/g)].map(row=>row.slice(1).map(Number));
  assert.deepEqual(rows,compiled.actors.map(a=>[(a.prototype.actorId*65536+a.prototype.unknownHalfword)>>>0,...a.prototype.parameters]));assert.deepEqual(rows.map(row=>row[0]>>>16),[0x079,0x07c]);assert.deepEqual(rows.map(row=>row.slice(1)),[[0,0,0],[0,0,0]]);
  const instances=source.match(/static AuthoredInstance authored_0_instances\[\] = \{([\s\S]*?)\n\};/)![1];assert.deepEqual([...instances.matchAll(/authored_0_definitions\[(\d+)\]/g)].map(m=>Number(m[1])),[0,1]);assert.match(source,/static AuthoredMetadata authored_0_metadata = \{ authored_0_instances/);
  const inventory=JSON.parse(generated.files["authoring-inventory.json"]),out=inventory.rooms[0];assert.equal(out.room.id,621);assert.equal(out.room.templateRoomId,465);assert.deepEqual(out.room.actors.map((a:{prototypeId:string})=>a.prototypeId),room.actors.map(a=>a.prototypeId));assert.deepEqual(out.resourceAllocations,compiled.resourceAllocations);
  assert.equal(JSON.stringify(f.project),beforeProject);assert.equal(hash(f.rom.bytes),beforeRom);
});

test("generated C/H export refuses fixed File12 actors and357 even with a matching native donor",actual,async()=>{
  for(const [id,donor] of [[0x07a,0],[0x07b,0],[0x357,113]]){
    const f=fixture([id],donor);
    const beforeProject=JSON.stringify(f.project),beforeRom=hash(f.rom.bytes);
    await assert.rejects(generatePatch(f.project,f.rom.loadRoom.bind(f.rom),f.rom.geometryTranslation.bind(f.rom),()=>f.context),/unresolved resource dependency/);
    assert.equal(JSON.stringify(f.project),beforeProject);assert.equal(hash(f.rom.bytes),beforeRom);
  }
});
