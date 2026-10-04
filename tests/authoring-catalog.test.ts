import assert from "node:assert/strict";
import {test} from "node:test";
import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {NativeAuthoringCatalog,prototypeId,ACTOR_INITIALIZER_CANDIDATE_COUNT} from "../core/authoring/catalog";
import {RomReader} from "../core/rom/binary";
import {ActorVisuals} from "../core/rom/actors";
import {RenderWaves} from "../core/rom/waves";
import {renderModelLists} from "../core/rom/render";
import {ACTOR_NAMES} from "../core/rom/actors-names";
import {importRomBytes} from "../core/rom";
import type {RoomData} from "../shared/types";

const zero={x:0,y:0,z:0};
test("prototype identities retain exact three words and opaque halfword",()=>{
  assert.equal(prototypeId(0x82,[0,0xffffffff,0x80000000],0x8001),"prototype:082:00000000:ffffffff:80000000:8001");
  assert.notEqual(prototypeId(0x82,[0,0,0],0),prototypeId(0x82,[0,0,0],1));
  assert.equal(Object.keys(ACTOR_NAMES).length,255);assert.equal(ACTOR_NAMES[0x190],"Flying Tile");
});
test("registration includes unplaced candidates without assuming model slot zero; preview inputs are bounded",()=>{
  const bytes=new Uint8Array(0x600000),r=new RomReader(bytes),v=r.view;
  const files=new Map([[12,{id:12,start:0x5c8770,end:0x5c8870,compressed:false}]]);
  v.setUint32(0x5e3c8c+3*4,0x8020d2a0);v.setUint32(0x5e3c8c+4*4,0x0800ffff);v.setInt16(0x5e4ca6+4*2,32);
  v.setUint32(0x5e3c8c+ACTOR_INITIALIZER_CANDIDATE_COUNT*4,0x80001000);
  let input:unknown;
  const actors={preview:(next:unknown)=>{input=next;return {actorModels:[],actorVisuals:[]};}} as unknown as ActorVisuals;
  const catalog=new NativeAuthoringCatalog(r,files,{} as RenderWaves,actors,()=>8,{listRooms:()=>[],loadBaseRoom:()=>{throw Error("Not used");},loadRoom:()=>{throw Error("Not used");}},"synthetic");
  const data=catalog.getCatalog();assert.deepEqual(data.actors.map(a=>a.actorId),[3,4]);assert.equal(data.actorPrototypes.length,2);assert.match(data.actors[1].warnings[0],/unresolved native code/);
  const id=data.actorPrototypes[0].id;catalog.loadActorPrototype(id,{parameters:[1,2,3],position:{x:-32768,y:32767,z:5}});
  assert.deepEqual(input,{actorId:3,parameters:[1,2,3],position:{x:-32768,y:32767,z:5},rotation:zero,unknownHalfword:0,roomId:undefined});
  assert.throws(()=>catalog.loadActorPrototype("unknown"),/Unknown/);
  const unresolved=data.actorPrototypes.find(p=>p.actorId===4)!;assert.equal(catalog.loadActorPrototype(unresolved.id).actorVisuals[0].status,"unsupported");assert.throws(()=>catalog.exportContext().prototype(unresolved.id),/cannot be exported/);
  assert.throws(()=>catalog.loadActorPrototype(id,{parameters:[0,-1,0]}),/u32/);
  assert.throws(()=>catalog.loadActorPrototype(id,{rotation:{x:32768,y:0,z:0}}),/signed16/);
  assert.throws(()=>catalog.loadActorPrototype(id,{parameters:[0,0,0],nativePointer:1} as never),/Invalid/);
  data.actors[0].name="corrupted";assert.notEqual(catalog.getCatalog().actors[0].name,"corrupted");
});
test("foreign or edited prototypes require completed dependency traces independently of visual decoding",()=>{
  const bytes=new Uint8Array(0x600000),reader=new RomReader(bytes),files=new Map([[12,{id:12,start:0x5c8770,end:0x5c8870,compressed:false}]]);reader.view.setUint32(0x5e3c8c+3*4,0x8020d2a0);
  const source={romOffset:0,expectedHex:"00".repeat(20)},room={id:0,name:"Synthetic native donor",source:{romOffset:0,expectedHex:""},actors:[{id:"original",index:0,actorId:3,name:"Synthetic actor",parameters:[1,2,3],position:zero,rotation:zero,source,sourceKind:"normal"}],meshes:[],textures:[],events:[],warnings:[]} as unknown as RoomData;
  let completed=false;
  const actors={preview:()=>({actorModels:[],actorVisuals:[{status:"unsupported",parts:[]}]}),dependencies:()=>({completed,status:"unsupported",failureKind:completed?undefined:"unresolved",fileIds:[],warnings:completed?["GPU-only appearance is unsupported."]:["Unknown native file-request branch."]})} as unknown as ActorVisuals;
  const catalog=new NativeAuthoringCatalog(reader,files,{} as RenderWaves,actors,()=>8,{listRooms:()=>[{id:0}] as never,loadBaseRoom:()=>room,loadRoom:()=>room},"synthetic"),id=catalog.getCatalog().actorPrototypes[0].id,context=catalog.exportContext();
  assert.equal(context.prototype(id).dependencyClosure,"canonical-context");assert.equal(context.prototype(id).sourceKind,"normal");
  assert.throws(()=>context.prototype(id,{parameters:[4,2,3]}),/unresolved resource dependency/);
  assert.throws(()=>context.prototype(id,{}, {roomId:620,templateRoomId:0}),/unresolved resource dependency/);
  completed=true;assert.equal(context.prototype(id,{parameters:[4,2,3]}, {roomId:620,templateRoomId:0}).dependencyClosure,"initializer-trace");
});
test("native source vertex IDs survive cache reuse and material batches without changing triangles",()=>{
  const bytes=new Uint8Array(256),v=new DataView(bytes.buffer);let at=0;
  const command=(a:number,b:number)=>{v.setUint32(at,a);v.setUint32(at+4,b);at+=8;};
  command(0xfcffffff,0xfffdfcfe);command(0xfa000000,0xff0000ff);command(0x04000c00,0x80);command(0xbf000000,0x00000204);command(0xfa000000,0x00ff00ff);command(0xbf000000,0x00040200);command(0xb8000000,0);
  for(let i=0;i<3;i++){v.setInt16(0x80+i*16,i);v.setInt16(0x82+i*16,i+10);}
  const read=(p:number,n:number)=>bytes.subarray(p,p+n),plain=renderModelLists(read,[{displayList:0x00}]);
  // Zero roots are sentinel; place the fixture at a real address.
  bytes.copyWithin(8,0,56);const a=renderModelLists(read,[{displayList:8}],0,undefined,{vertexProvenance:true,materialProvenance:true}),b=renderModelLists(read,[{displayList:8}]);
  assert.equal(a.complete,true);assert.equal(a.meshes.length,2);assert.deepEqual(a.vertexAddresses,[[0x80,0x90,0xa0],[0xa0,0x90,0x80]]);
  assert.deepEqual(a.meshes,b.meshes);assert.equal(plain.meshes.length,0);
  assert.deepEqual(a.materialCommands?.[0],[[0xfcffffff,0xfffdfcfe],[0xfa000000,0xff0000ff]]);
  assert.deepEqual(a.materialCommands?.[1]?.at(-1),[0xfa000000,0x00ff00ff]);
  assert.ok(a.materialCommands?.every(list=>list.every(([w])=>![0x04,0xbf,0xb8].includes(w>>>24))));
});

test("authored context accepts the full roster budget while executing only selected actors; thumbnail hints never enter dependency traces",()=>{
  const reader=new RomReader(new Uint8Array(0x600000)),files=new Map([[12,{id:12,start:0x5c8770,end:0x5c8870,compressed:false}]]);
  reader.view.setUint32(0x5e3c8c+0x147*4,0x8020d2a0);
  const room={id:0,actors:[],meshes:[],events:[],warnings:[],source:{romOffset:0,expectedHex:""}} as unknown as RoomData;
  const previews:unknown[]=[],dependencies:unknown[]=[];
  const actors={preview:(input:unknown)=>{previews.push(input);return {actorModels:[],actorVisuals:[]};},dependencies:(input:unknown)=>{dependencies.push(input);return {completed:true,status:"conditional",fileIds:[],warnings:[]};}} as unknown as ActorVisuals;
  const catalog=new NativeAuthoringCatalog(reader,files,{} as RenderWaves,actors,()=>8,{listRooms:()=>[{id:0}] as never,loadBaseRoom:()=>room,loadRoom:()=>room},"synthetic"),id=catalog.getCatalog().actorPrototypes[0].id;
  previews.length=0;
  const sibling={prototypeId:id,parameters:[0,0,0] as [number,number,number],position:zero,rotation:zero},context={roomId:620,templateRoomId:0,siblings:Array.from({length:4096},()=>sibling)};
  catalog.loadActorPrototypeForRoom(id,{},context);assert.equal(previews.length,1);assert.ok(!("thumbnailPlayerPosition" in (previews[0] as object)));
  assert.throws(()=>catalog.loadActorPrototypeForRoom(id,{}, {...context,siblings:[...context.siblings,sibling]}),/count bound/);
  catalog.loadActorPrototype(id);assert.deepEqual((previews[1] as {thumbnailPlayerPosition:unknown}).thumbnailPlayerPosition,zero);
  catalog.exportContext().prototype(id);catalog.exportContext().prototype(id,{},context);assert.equal(dependencies.length,2);assert.ok(dependencies.every(input=>!("thumbnailPlayerPosition" in (input as object))));
});

test("resource preflight bounds the even native copy and validates all decoded texture part writes",()=>{
  const reader=new RomReader(new Uint8Array(0x70000)),file={id:1,start:0x100,end:0x103,compressed:false},files=new Map([[1,file]]),view=reader.view;
  view.setUint32(0x556c4+8,0x08000000);view.setUint32(0x556c4+12,0x08000003);view.setUint32(0x6a51c+4,0x80001000);
  const waves=new RenderWaves(reader,files,()=>8),catalog=new NativeAuthoringCatalog(reader,files,waves,{} as ActorVisuals,()=>8,{listRooms:()=>[],loadBaseRoom:()=>{throw Error("Not used");},loadRoom:()=>{throw Error("Not used");}},"synthetic");
  assert.throws(()=>waves.wave(1),/allocation/);assert.throws(()=>catalog.exportContext().resourceFileBytes([1]),/allocation/);
  view.setUint32(0x556c4+12,0x08000004);assert.deepEqual(catalog.exportContext().resourceFileBytes([1,1]),{totalBytes:4,files:[{fileId:1,byteLength:4}]});
  // A fresh cache must reject an invalid part even though its raw file fits.
  view.setUint32(0x1c00,1);view.setUint32(0x1c04,0x08000003);
  const malformed=new NativeAuthoringCatalog(reader,files,new RenderWaves(reader,files,()=>8),{} as ActorVisuals,()=>8,{listRooms:()=>[],loadBaseRoom:()=>{throw Error("Not used");},loadRoom:()=>{throw Error("Not used");}},"synthetic");
  assert.throws(()=>malformed.exportContext().resourceFileBytes([1]),/part|budget|allocation|exceed/i);
});

test("actual US ROM authoring catalog, native previews, materials, source provenance and CI8 backgrounds",{skip:!process.env.MNSG_TEST_ROM},()=>{
  const rom=importRomBytes(readFileSync(process.env.MNSG_TEST_ROM!)),before=createHash("sha256").update(rom.bytes).digest("hex"),catalog=rom.getAuthoringCatalog();
  assert.equal(catalog.actors.length,361);assert.equal(catalog.actorPrototypes.length,2093);assert.equal(catalog.geometry.filter(g=>g.id.startsWith("geometry:")).length,213);assert.ok(catalog.geometry.some(g=>g.id.startsWith("component:")));assert.equal(catalog.skyboxes.length,4);
  assert.deepEqual([catalog.roomAdmission.minId,catalog.roomAdmission.maxId,catalog.roomAdmission.supported],[620,799,true]);assert.match(catalog.roomAdmission.reason??"",/donors0–539/);assert.match(catalog.roomAdmission.reason??"",/validation in the game/);
  for(const key of ["actors","actorPrototypes","geometry","materials","surfaces","nativeEntrances","skyboxes"] as const)assert.equal(new Set(catalog[key].map(e=>"id" in e?e.id:(e as {actorId:number}).actorId)).size,catalog[key].length,`${key} identifiers unique`);
  assert.ok(catalog.actors.every(a=>a.prototypeIds.length));assert.equal(catalog.actors.find(a=>a.actorId===0x226)?.name,ACTOR_NAMES[0x226]);
  assert.ok(catalog.actorPrototypes.some(p=>p.sourceRoomId===undefined));
  const house=catalog.geometry.find(g=>g.roomIds.includes(465))!,asset=rom.loadGeometryAsset(house.id);
  assert.equal(asset.vertexSources.length,455);assert.equal(asset.vertexRefs.length,asset.meshes.length);
  const sources=new Map(asset.vertexSources.map(v=>[v.id,v]));
  asset.meshes.forEach((m,i)=>{assert.equal(asset.vertexRefs[i].length,m.positions.length/3);assert.ok(catalog.materials.some(mat=>mat.id===m.materialId));for(let j=0;j<m.positions.length/3;j++){const source=sources.get(asset.vertexRefs[i][j])!;assert.deepEqual(m.positions.slice(j*3,j*3+3),[source.position.x,source.position.y,source.position.z]);assert.equal(source.source.expectedHex,Buffer.from(rom.bytes.subarray(source.source.romOffset,source.source.romOffset+16)).toString("hex"));}});
  const component=catalog.geometry.find(g=>g.id.startsWith("component:")&&g.roomIds.includes(465))!,part=rom.loadGeometryAsset(component.id);assert.equal(part.meshes.length,1);assert.equal(part.vertexRefs[0].length,part.meshes[0].positions.length/3);
  const materialId=asset.meshes.find(m=>m.material?.textureId)!.materialId!,material=rom.resolveAuthoringMaterial(materialId),native=rom.authoringExportContext().material(materialId);
  assert.ok(material.textures.length);assert.ok(native.commands.length);assert.ok(native.relocations.some(r=>r.offset%8===4));assert.ok(native.uv.scaleS>0);assert.ok(native.textureWidth>1);
  for(const sky of catalog.skyboxes){const preview=rom.loadSkyboxAsset(sky.id),pixels=Buffer.from(preview.texture.rgbaBase64,"base64");assert.equal(pixels.length,640*240*4);assert.equal(preview.texture.format,"CI8/TLUTRGBA16");assert.ok(new Set(pixels).size>16);}
  const collision=rom.authoringExportContext().collision(0);assert.ok(collision.planes.length>0&&collision.tree.length>0);assert.equal(collision.planes.length%20,0);assert.equal(collision.tree.length%6,0);
  const nativeHash=createHash("sha256").update(collision.planes).update(collision.tree).digest("hex");collision.planes.fill(0);assert.equal(createHash("sha256").update(rom.authoringExportContext().collision(0).planes).update(rom.authoringExportContext().collision(0).tree).digest("hex"),nativeHash);
  const delta={x:2,y:-3,z:4},plan=rom.geometryTranslation(0,delta),original=rom.authoringExportContext().collision(0),translated=rom.authoringExportContext().collision(0,delta),originalBytes=Buffer.from(rom.bytes);
  for(const kind of ["planeDistance","cellBounds"] as const){const base=kind==="planeDistance"?original.planes:original.tree,next=kind==="planeDistance"?translated.planes:translated.tree,spans=plan.spans.filter(span=>span.kind===kind),first=spans[0];assert.ok(first);
    // Locate the exact original native array in the immutable ROM, then compare
    // every verified distance/header-bound change. Normals/topology stay intact.
    const start=originalBytes.indexOf(Buffer.from(base));assert.ok(start>=0);const expected=base.slice();for(const span of spans){const offset=span.romOffset-start;assert.ok(offset>=0&&offset+span.originalHex.length/2<=expected.length);expected.set(Buffer.from(span.replacementHex,"hex"),offset);}assert.deepEqual(next,expected);
  }
  assert.equal(createHash("sha256").update(original.planes).update(original.tree).digest("hex"),nativeHash);assert.throws(()=>rom.authoringExportContext().collision(0,{x:0,y:100000,z:0}),/bounds|overflow|signed|range|translation/i);
  const arrival=rom.authoringExportContext().entrance(0,"arrival:0");assert.equal(arrival.entryParameter,rom.bytes[0x6c380+9]);assert.deepEqual(arrival.position,{x:Buffer.from(rom.bytes).readInt16BE(0x6c380),y:Buffer.from(rom.bytes).readInt16BE(0x6c382),z:Buffer.from(rom.bytes).readInt16BE(0x6c384)});
  assert.ok(rom.authoringExportContext().donor(0).environmentDefinitions.length);assert.equal(rom.nativeRoomSkyboxId(0),undefined);
  const actor=catalog.actorPrototypes.find(p=>p.actorId===0x256)!;
  const first=rom.loadActorPrototype(actor.id,{parameters:[0,actor.parameters[1],actor.parameters[2]]}),second=rom.loadActorPrototype(actor.id,{parameters:[0x01000000,actor.parameters[1],actor.parameters[2]]});
  assert.ok(first.actorModels.length);assert.notEqual(first.actorVisuals[0].parts[0].provenance.slot,second.actorVisuals[0].parts[0].provenance.slot);
  const context={roomId:620,templateRoomId:465},foreign=rom.loadActorPrototypeForRoom(actor.id,{},context);assert.ok(foreign.actorModels.length);assert.equal(rom.authoringExportContext().prototype(actor.id,{},context).dependencyClosure,"initializer-trace");assert.equal(rom.authoringExportContext().prototype(actor.id).dependencyClosure,"canonical-context");assert.throws(()=>rom.loadActorPrototypeForRoom(actor.id,{}, {roomId:620}),/donor/);
  for(const actorId of [0x2d3,0x2d4]){const npc=catalog.actorPrototypes.find(p=>p.actorId===actorId)!;const declaration=rom.authoringExportContext().prototype(npc.id,{},context);assert.equal(declaration.dependencyClosure,"initializer-trace");assert.ok(declaration.warnings.some(w=>w.includes("removal")));assert.ok(rom.loadActorPrototypeForRoom(npc.id,{},context).actorVisuals[0].parts.length);}
  const door=catalog.actorPrototypes.find(p=>p.actorId===0x23c)!,doorGeometry=rom.authoringExportContext().doorGeometry!(door.id,context);assert.equal(doorGeometry.meshes.length,2);assert.equal(doorGeometry.meshes.reduce((sum,mesh)=>sum+mesh.vertices.length,0),72);assert.deepEqual(doorGeometry.resourceFileIds,[340,504]);
  for(const mesh of doorGeometry.meshes){assert.ok(mesh.material.commands.length&&mesh.material.relocations.length);assert.ok(mesh.material.uv.scaleS>0&&mesh.material.uv.scaleT>0);assert.ok(mesh.indices.every(index=>Number.isInteger(index)&&index>=0&&index<mesh.vertices.length));assert.ok(mesh.vertices.every(vertex=>Object.values(vertex.position).every(n=>Number.isInteger(n)&&n>=-32768&&n<=32767)&&vertex.colorRGBAu8.every(n=>Number.isInteger(n)&&n>=0&&n<=255)));}
  const coin=catalog.actorPrototypes.find(p=>p.actorId===0x82)!;assert.throws(()=>rom.authoringExportContext().doorGeometry!(coin.id,context),/Camera-aligned/);
  const boss=catalog.actorPrototypes.find(p=>p.actorId===0x1b0)!,bossRoom=rom.loadRoom(boss.sourceRoomId!),bossActor=bossRoom.actors.find(a=>a.id===boss.sourceActorRef)!,siblingActor=bossRoom.actors.find(a=>a.actorId===0x287)!;
  const declaration=(actor:typeof bossActor)=>({prototypeId:prototypeId(actor.actorId,actor.parameters as [number,number,number],actor.definitionSource?Buffer.from(rom.bytes).readUInt16BE(actor.definitionSource.romOffset+2):0),parameters:actor.parameters as [number,number,number],position:actor.position,rotation:actor.rotation}),bossDeclaration=declaration(bossActor),siblingDeclaration=declaration(siblingActor),edits={parameters:bossDeclaration.parameters,position:bossDeclaration.position,rotation:bossDeclaration.rotation};
  const ordered=rom.loadActorPrototypeForRoom(boss.id,edits,{roomId:620,templateRoomId:341,siblings:[siblingDeclaration,bossDeclaration]}).actorVisuals[0];assert.ok(ordered.parts.length>=33);assert.ok(ordered.warnings.some(w=>w.includes("preserves the completed native actor287")));
  for(const siblings of [[bossDeclaration],[bossDeclaration,siblingDeclaration]]){const absent=rom.loadActorPrototypeForRoom(boss.id,edits,{roomId:341,siblings}).actorVisuals[0];assert.equal(absent.status,"unsupported");assert.ok(absent.warnings.some(w=>w.includes("requires actor287 earlier")));assert.throws(()=>rom.authoringExportContext().prototype(boss.id,edits,{roomId:341,siblings}),/unresolved resource dependency/);}
  assert.equal(createHash("sha256").update(rom.bytes).digest("hex"),before);assert.ok(rom.listRooms().every(r=>!("textures" in r)&&!("actorModels" in r)));
  assert.throws(()=>rom.loadGeometryAsset("geometry:forged"),/Unknown/);assert.throws(()=>rom.resolveAuthoringMaterial("material:forged"),/Unknown/);
});
