import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {importRomBytes,readFileTable,type ImportedRom} from '../core/rom';
import {RomReader} from '../core/rom/binary';
import {RenderWaves} from '../core/rom/waves';
import {NativeLinkedArena} from '../core/rom/actor-init-resources';
import {ActorInitializer,type NativeActorInitInput} from '../core/rom/actor-init';
import {ActorVisuals} from '../core/rom/actors';
import {createProject,validateProject} from '../core/project';
import {generatePatch,exportNrm} from '../core/export';
import type {AuthoringLookup} from '../core/authoring/project';
import type {AuthoredRoom,EditorProjectV2} from '../shared/types';
import {nativeWaterActorPreview,WaterActorMemory,type WaterActorPreviewResult} from '../core/rom/actor-init-water-preview';
const actual={skip:!process.env.MNSG_TEST_ROM},zero={x:0,y:0,z:0},sha=(b:Uint8Array|string)=>createHash('sha256').update(b).digest('hex');
let rom:ImportedRom;
function native(){rom??=importRomBytes(readFileSync(process.env.MNSG_TEST_ROM!));const reader=new RomReader(rom.bytes),files=new Map(readFileTable(rom.bytes).map(f=>[f.id,f])),waves=new RenderWaves(reader,files,id=>{for(let at=0x55510;at<0x556c4;at+=4)if(id<reader.u16(at))return reader.bytes[at+3];throw Error('segment missing');});return {rom,reader,files,waves};}
function canonical():NativeActorInitInput{return {actorId:0x249,parameters:[0,0,0],unknownHalfword:0,position:{x:0,y:53,z:0},rotation:{...zero},roomId:313};}
function own(result:WaterActorPreviewResult,address:number,length:number){const s=result.syntheticMemory.find(s=>address>=s.address&&address+length<=s.address+s.bytes.length);assert.ok(s);return s.bytes.subarray(address-s.address,address-s.address+length);}
function u32(result:WaterActorPreviewResult,address:number){const b=own(result,address,4);return new DataView(b.buffer,b.byteOffset,4).getUint32(0);}

test('water selection and malformed input refuse before reading any source or creating CPU context',()=>{
  const reader=new Proxy(new RomReader(new Uint8Array(0)),{get(){throw Error('Unexpected ROM read');}}),files=new Proxy(new Map(),{get(){throw Error('Unexpected map read');}}),waves={wave(){throw Error('Unexpected wave read');}};
  for(const actorId of [0x248,0x24a,0x7d])assert.equal(nativeWaterActorPreview(reader,files,{...canonical(),actorId},waves),undefined);
  const inputs=[...([new Array(3),[0,,0],[0,0],null,{0:0,1:0,2:0,length:3},[0,0,2**32],[-1,0,0]] as unknown[]).map(parameters=>({...canonical(),parameters:parameters as number[]})),{...canonical(),position:{x:.1,y:0,z:0}},{...canonical(),rotation:{x:32768,y:0,z:0}},{...canonical(),unknownHalfword:65536}];
  for(const input of inputs){const result=nativeWaterActorPreview(reader,files,input,waves)!;assert.equal(result.status,'unsupported');assert.equal(result.completed,false);assert.equal(result.instructionCount,0);assert.match(result.diagnostics[0],/Malformed/);assert.deepEqual(result.bindings,[]);}
});

test('water owned CPU writes are full-span atomic and unknown live fields stay unavailable',()=>{
  const arena=NativeLinkedArena.initialize(0x80154c64,0x81010000,new Uint8Array(128)),memory=new WaterActorMemory(new RomReader(new Uint8Array(0)),new Map(),arena),mutable=new Uint8Array(16),immutable=new Uint8Array(16).fill(7);
  memory.regions.push({address:0x82000000,bytes:mutable},{address:0x82000010,bytes:immutable,readonly:true});
  assert.throws(()=>memory.write(0x8200000c,new Uint8Array(8).fill(9)),/immutable/);assert.deepEqual(mutable,new Uint8Array(16));assert.deepEqual(immutable,new Uint8Array(16).fill(7));
  assert.throws(()=>memory.write(0x82000000+.5,new Uint8Array(4)),/Invalid/);assert.throws(()=>memory.write(0x80001000,new Uint8Array(4)),/Unmapped/);assert.throws(()=>memory.read(0x81000084,4),/Unproved live/);assert.throws(()=>memory.read(0x81000144,2),/Unproved live/);
});

test('actual249 canonical finite setup matches the independently evaluated native inventory and D8 field-only prefix',actual,()=>{
  const n=native(),definition=canonical(),beforeDefinition=JSON.stringify(definition),beforeRom=sha(n.reader.bytes),beforePrimary=sha(n.waves.wave(353)),beforeAux=sha(n.waves.wave(338)),r=nativeWaterActorPreview(n.reader,n.files,definition,n.waves)!;
  assert.equal(r.status,'conditional',r.diagnostics.join());assert.equal(r.completed,false);assert.equal(r.failureKind,'scene-gated');assert.equal(r.instructionCount,80382);assert.equal(r.setupEvidence!.instructionLimit,200000);assert.deepEqual(r.codeFileIds,[25]);assert.deepEqual(r.deferredCallbacks,[0x80025b38,0x0800038c]);
  assert.deepEqual(r.setupEvidence!.allocationRequests,[128,1156,1156,1156,1156,6144,3600,3600,2056,2056]);assert.equal(r.setupEvidence!.payloadBytes,22208);assert.equal(r.setupEvidence!.chargedBytes,22784);
  assert.deepEqual(r.bindings[0].sourceFileIds,[25,338,353]);assert.deepEqual(r.bindings[0].segments,[]);assert.deepEqual(r.readonlyMemory.map(m=>m.fileId),[25,353,338]);assert.ok(r.readonlyMemory.every(m=>m.address>=0x82000000));assert.ok(!r.syntheticMemory.some(m=>m.address>>>24===8));assert.equal(r.bindings[0].slot,-1);assert.deepEqual(r.bindings[0].position,definition.position);assert.deepEqual(r.bindings[0].positionOffset,zero);assert.deepEqual(r.bindings[0].rotationOverrideMask,{x:false,y:false,z:false});assert.deepEqual(r.bindings[0].scale,{x:Math.fround(.16),y:Math.fround(.16),z:Math.fround(.16)});
  for(const v of r.setupEvidence!.vertices){assert.equal(v.count,225);assert.equal(v.byteLength,3600);assert.equal(v.sha256,'0104bdf048a16832c2c6223b439cf5067a28cc47f802ffee6c957fb39266780a');assert.equal(v.bounds.min[1],0);assert.equal(v.bounds.max[1],0);}
  for(const c of r.setupEvidence!.commands){assert.equal(c.triangles,392);assert.equal(c.byteLength,1856);assert.equal(c.materialPairs.length,17);assert.deepEqual(c.materialPairs[1],[0xfc111404,0xfffffffb]);assert.deepEqual(c.materialPairs[9],[0xf2000005,0xfc07c]);assert.deepEqual(c.materialPairs[16],[0xf201e000,0x010fc07c]);}
  assert.deepEqual(r.setupEvidence!.cacheFlushes.map(c=>c.size),[272,272,3600,1856,3600,1856]);
  const work=r.setupEvidence!.snapshots.at(-1)!.workAddress,field=u32(r,work+0x58);for(const offset of [504,572,508,576])assert.equal(u32(r,field+offset),0x43480000);
  assert.ok(!r.setupEvidence!.executedBodies.includes(0x80025b38));assert.ok(!r.setupEvidence!.executedBodies.includes(0x0800038c));for(const at of [0x800c7a8e,0x800c7a72])assert.ok(!r.setupEvidence!.readSpans.some(s=>at>=s.address&&at<s.address+s.size));
  const setup=nativeWaterActorPreview(n.reader,n.files,definition,n.waves,{finiteD8:false})!;assert.equal(setup.instructionCount,80299);assert.deepEqual(setup.deferredCallbacks,[0x080000d8,0x0800038c]);assert.deepEqual(setup.setupEvidence!.vertices,r.setupEvidence!.vertices);assert.deepEqual(setup.setupEvidence!.commands,r.setupEvidence!.commands);assert.deepEqual(setup.bindings,r.bindings.map(b=>({...b,provenance:setup.bindings[0].provenance})));
  assert.equal(JSON.stringify(definition),beforeDefinition);assert.equal(sha(n.reader.bytes),beforeRom);assert.equal(sha(n.waves.wave(353)),beforePrimary);assert.equal(sha(n.waves.wave(338)),beforeAux);
});

test('actual249 library and edited placement retain signed native angles without constructor transform overrides',actual,()=>{
  const n=native(),initializer=new ActorInitializer(n.reader,n.files,n.waves),library=initializer.resolve({...canonical(),position:{...zero},roomId:undefined});assert.equal(library.status,'conditional');assert.deepEqual(library.bindings[0].position,zero);
  const edited={...canonical(),parameters:[0xffffffff,123,456],unknownHalfword:65535,position:{x:-32768,y:123,z:32767},rotation:{x:-256,y:764,z:-32768},roomId:620,templateRoomId:313},result=initializer.resolve(edited);assert.equal(result.status,'conditional',result.diagnostics.join());assert.equal(result.completed,false);assert.deepEqual(result.bindings[0].position,edited.position);assert.deepEqual(result.bindings[0].rotation,edited.rotation);assert.deepEqual(result.bindings[0].positionOffset,zero);assert.deepEqual(result.bindings[0].rotationOverrideMask,{x:false,y:false,z:false});
});

test('actual249 source/map/resources/arena failures reject before any unsupported rendering or admission',actual,()=>{
  const n=native();
  for(const at of [0x6ada28,0x24d60,0x27be8,0x6ad498,0x5e45b0,0x5e5138,0x5c574,0x556c4+353*8,0x6a51c+338*4]){const bytes=n.reader.bytes.slice();bytes[at]^=1;const r=nativeWaterActorPreview(new RomReader(bytes),n.files,canonical(),n.waves)!;assert.equal(r.status,'unsupported');assert.equal(r.instructionCount,0);assert.equal(r.codeFileIds,undefined);assert.deepEqual(r.bindings,[]);}
  const files=new Map(n.files),old=files.get(25)!;files.set(25,{...old,end:old.end-4});assert.equal(nativeWaterActorPreview(n.reader,files,canonical(),n.waves)!.instructionCount,0);
  for(const missing of [25,353,338]){const r=nativeWaterActorPreview(n.reader,n.files,canonical(),n.waves,{preloadResourceIds:[25,353,338].filter(id=>id!==missing)})!;assert.equal(r.instructionCount,0);assert.match(r.diagnostics[0],/Required explicit/);assert.deepEqual(r.bindings,[]);}
  for(const id of [25,353,338]){const provider={wave:n.waves.wave.bind(n.waves),image:(file:number)=>{const image=n.waves.image(file);if(file===id){if(image.parts.length)image.parts[0].bytes=image.parts[0].bytes.slice().fill(0);else image.rawCopy=image.rawCopy.slice().fill(0);}return image;}};const r=nativeWaterActorPreview(n.reader,n.files,canonical(),provider)!;assert.equal(r.instructionCount,0);assert.match(r.diagnostics[0],/preimage/);assert.equal(r.completed,false);}
  const arena=NativeLinkedArena.initialize(0x80154c64,0x81010000,new Uint8Array(0x5000)).snapshot(),before=sha(arena.bytes),r=nativeWaterActorPreview(n.reader,n.files,canonical(),n.waves,{arena})!;assert.equal(r.status,'unsupported');assert.match(r.diagnostics[0],/arena exhausted/);assert.ok(r.instructionCount>0&&r.instructionCount<200000);assert.deepEqual(r.bindings,[]);assert.equal(sha(arena.bytes),before);
  for(const id of [353,338]){const cache=n.waves.wave(id),original=cache[0];cache[0]^=1;try{const r=nativeWaterActorPreview(n.reader,n.files,canonical(),n.waves)!;assert.equal(r.instructionCount,0);assert.match(r.diagnostics[0],/Cached RSP resource preimage/);}finally{cache[0]=original;}}
});

test('actual249 both future callbacks reject before any new body, instruction or field read',actual,()=>{
  const n=native();for(const entry of [0x80025b38,0x0800038c] as const){const r=nativeWaterActorPreview(n.reader,n.files,canonical(),n.waves,{futureEntryProbe:entry})!;assert.equal(r.status,'unsupported');assert.equal(r.completed,false);assert.deepEqual(r.bindings,[]);const e=r.futureProbeEvidence!;assert.ok(e);assert.equal(e.entry,entry);assert.equal(e.beforeInstructions,80382);assert.equal(e.afterInstructions,e.beforeInstructions);assert.equal(e.afterReads,e.beforeReads);assert.deepEqual(e.afterBodies,e.beforeBodies);assert.ok(!e.afterBodies.includes(entry));}
});

test('actual249 public placement/library visuals preserve physical owners and keep foreign C/H and NRM export closure unresolved',actual,async()=>{
  const n=native(),placement=n.rom.loadRoom(313).actors.find(a=>a.actorId===0x249)!;assert.ok(placement);assert.deepEqual(placement.position,{x:0,y:53,z:0});const visuals=new ActorVisuals(n.reader,n.files,n.waves),input={...canonical(),parameters:placement.parameters,position:placement.position,rotation:placement.rotation},payload=visuals.preview(input,placement.id),visual=payload.actorVisuals[0];assert.equal(visual.status,'conditional',visual.reason??'Missing conditional reason');assert.equal(visual.parts.length,1);assert.deepEqual(visual.parts[0].provenance.fileIds,[25,338,353]);assert.equal(payload.actorModels.flatMap(m=>m.meshes).reduce((sum,m)=>sum+m.indices.length/3,0),392);assert.match(visual.reason!,/animated waves.*export admission remain unverified/);
  const model=payload.actorModels[0];assert.equal(payload.actorModels.length,1);assert.equal(model.meshes.length,1);const mesh=model.meshes[0],material=mesh.material!;
  assert.equal(mesh.positions.length,392*3*3);assert.equal(mesh.uvs!.length,392*3*2);assert.equal(mesh.secondaryUvs!.length,mesh.uvs!.length);assert.notDeepEqual(mesh.secondaryUvs,mesh.uvs);
  assert.equal(sha(JSON.stringify(mesh.positions)),'c0534346c9bcf14d2841fb4ff059078b32654ac9c30b71267506835139bc075a');
  assert.equal(sha(JSON.stringify(mesh.uvs)),'8b555e94f150f401fef71f6bb3f4162e9fd100d30ceea8c9c107931dd2f45def');assert.equal(sha(JSON.stringify(mesh.secondaryUvs)),'441a45a38aed56d23244a619d8643401116124c5fddaa4a0d562c27c39f81d20');
  assert.deepEqual(material.dualTexture,{textureId:model.textures[1].id,wrapS:'repeat',wrapT:'repeat',filter:'linear',mode:'multiply-shade-primitive-alpha',opaqueFirstCycle:true});assert.equal(material.textureId,model.textures[0].id);assert.equal(material.opacity,208/255);assert.equal(material.alphaTest,0);assert.equal(material.lighting,true);
  assert.deepEqual(model.textures.map(t=>[t.width,t.height]),[[64,32],[64,32]]);assert.deepEqual(model.textures.map(t=>sha(Buffer.from(t.rgbaBase64,'base64'))),['14aa15262d24fc040e2db60182f8e566e493b300cc4a2efa03406e9e8e012999','34db7d1a814fc45a75383471eeabe6b9426cda0c1574ac83e0c5b739e5da1714']);
  assert.throws(()=>visuals.doorGeometry(input),/unresolved initialization path/);
  const dependencies=visuals.dependencies(input);assert.deepEqual(dependencies.fileIds,[25,338,353]);assert.equal(dependencies.completed,false);const prototype=n.rom.getAuthoringCatalog().actorPrototypes.find(p=>p.actorId===0x249)!;assert.throws(()=>n.rom.authoringExportContext().prototype(prototype.id,{parameters:[0,0,0]},{roomId:620,templateRoomId:313}),/unresolved resource dependency/);
  // Existing canonical donor admission is separate from the raw initializer's incomplete lifecycle.
  assert.equal(prototype.sourceRoomId,313);const canonicalEdits={parameters:[0,0,0] as [number,number,number],position:{x:120,y:-42,z:19},rotation:{x:-256,y:764,z:-75}},beforeEdits=JSON.stringify(canonicalEdits),canonicalContext={roomId:313,templateRoomId:313};
  const editedNative=visuals.resolveNative({...input,...canonicalEdits,...canonicalContext});assert.equal(editedNative.completed,false);assert.deepEqual(editedNative.bindings[0].position,canonicalEdits.position);assert.deepEqual(editedNative.bindings[0].rotation,canonicalEdits.rotation);assert.equal(visuals.dependencies({...input,...canonicalEdits,...canonicalContext}).completed,false);
  const canonicalAdmission=n.rom.authoringExportContext().prototype(prototype.id,canonicalEdits,canonicalContext);assert.equal(canonicalAdmission.dependencyClosure,'canonical-context');assert.deepEqual(canonicalAdmission.parameters,canonicalEdits.parameters);assert.ok(canonicalAdmission.dependencyProvenance.some(p=>p.includes('Verified canonical placement 313/')));assert.equal(JSON.stringify(canonicalEdits),beforeEdits);
  assert.throws(()=>n.rom.authoringExportContext().prototype(prototype.id,{...canonicalEdits,parameters:[1,0,0]},canonicalContext),/unresolved resource dependency/);
  const lookup:AuthoringLookup={catalog:n.rom.getAuthoringCatalog(),nativeRooms:n.rom.listRooms(),loadRoom:n.rom.loadRoom.bind(n.rom),resolveMaterial:n.rom.resolveAuthoringMaterial.bind(n.rom),loadActorPrototype:n.rom.loadActorPrototype.bind(n.rom),loadActorPrototypeForRoom:n.rom.loadActorPrototypeForRoom.bind(n.rom),loadSkyboxAsset:n.rom.loadSkyboxAsset.bind(n.rom),nativeRoomSkyboxId:n.rom.nativeRoomSkyboxId.bind(n.rom)};
  const room:AuthoredRoom={id:620,name:'Conditional water export refusal',kind:'new',templateRoomId:313,meshes:[],materials:[],collisionMode:'authored',collision:[],actors:[{id:'water',prototypeId:prototype.id,parameters:[0,0,0],position:{x:0,y:53,z:0},rotation:{...zero},spawnPolicy:'resident'}],doors:[],entrances:[{id:'spawn',name:'Spawn',position:{...zero},baseYaw:0,entryParameter:16}],skyboxId:null};
  const candidate:EditorProjectV2={...createProject('Water admission refusal',n.rom.identity),authoredRooms:{620:room}},project=validateProject(candidate,n.rom.identity,n.rom.loadRoom.bind(n.rom),n.rom.geometryTranslation.bind(n.rom),lookup),beforeProject=JSON.stringify(project),beforeRom=sha(n.rom.bytes),context=n.rom.authoringExportContext();
  await assert.rejects(generatePatch(project,n.rom.loadRoom.bind(n.rom),n.rom.geometryTranslation.bind(n.rom),()=>context),/unresolved resource dependency/);
  // exportNrm must fail at the same native admission boundary before inspecting tools or starting a compiler.
  await assert.rejects(exportNrm(project,n.rom.loadRoom.bind(n.rom),{templatePath:'/private/tmp/nonexistent-water-toolchain'},n.rom.geometryTranslation.bind(n.rom),()=>context),/unresolved resource dependency/);
  assert.equal(JSON.stringify(project),beforeProject);assert.equal(sha(n.rom.bytes),beforeRom);
});
