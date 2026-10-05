import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {importRomBytes,readFileTable,type ImportedRom} from "../core/rom";
import {RomReader} from "../core/rom/binary";
import {RenderWaves} from "../core/rom/waves";
import {ActorInitializer,type NativeActorInitInput} from "../core/rom/actor-init";
import {ActorVisuals} from "../core/rom/actors";
import {NativeLinkedArena} from "../core/rom/actor-init-resources";
import {nativeProceduralActorPreview,ProceduralActorMemory,type ProceduralActorPreviewResult} from "../core/rom/actor-init-procedural-preview";

const actual={skip:!process.env.MNSG_TEST_ROM},zero={x:0,y:0,z:0},hash=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");
let imported:ImportedRom;
function native(bytes?:Uint8Array){
  imported??=importRomBytes(readFileSync(process.env.MNSG_TEST_ROM!));const reader=new RomReader(bytes??imported.bytes),files=new Map(readFileTable(reader.bytes).map(f=>[f.id,f]));
  const waves=new RenderWaves(reader,files,id=>{for(let at=0x55510;at<0x556c4;at+=4){const upper=reader.u16(at);if(id<upper)return reader.bytes[at+3];}throw Error("Missing segment");});
  return {reader,files,waves,rom:imported};
}
function input():NativeActorInitInput{return {actorId:0x7d,parameters:[0,0,0],position:{x:12,y:34,z:56},rotation:{x:7,y:8,z:9}};}
function read(result:ProceduralActorPreviewResult,address:number,size:number):Uint8Array {
  const span=result.syntheticMemory.find(s=>address>=s.address&&address+size<=s.address+s.bytes.length);assert.ok(span,`Missing native private span ${address.toString(16)}`);return span.bytes.slice(address-span.address,address-span.address+size);
}
function u32(result:ProceduralActorPreviewResult,address:number){const b=read(result,address,4);return new DataView(b.buffer).getUint32(0);}

test("procedural selection and malformed definitions do not access native sources",()=>{
  const reader=new Proxy(new RomReader(new Uint8Array(0)),{get(){throw Error("Unexpected ROM access");}}),files=new Proxy(new Map(),{get(){throw Error("Unexpected map access");}}),waves={wave(){throw Error("Unexpected provider");}};
  for(const id of [0x78,0x79,0x7c,0x7e])assert.equal(nativeProceduralActorPreview(reader,files,{...input(),actorId:id},waves),undefined);
  for(const parameters of [new Array(3),[0,,0],[0,0],{0:0,1:0,2:0,length:3},null,[0,-1,0],[0,0,2**32]]){const r=nativeProceduralActorPreview(reader,files,{...input(),parameters:parameters as number[]},waves)!;assert.equal(r.status,"unsupported");assert.equal(r.instructionCount,0);assert.equal(r.completed,false);assert.match(r.diagnostics[0],/Malformed/);}
});

test("procedural readonly crossing and unowned writes are atomic",()=>{
  const arena=NativeLinkedArena.initialize(0x80154c64,0x81010000,new Uint8Array(128)),memory=new ProceduralActorMemory(new RomReader(new Uint8Array(0)),arena),owned=new Uint8Array(16),immutable=new Uint8Array(16).fill(7);
  memory.regions.push({address:0x82000000,bytes:owned},{address:0x82000010,bytes:immutable,readonly:true});
  assert.throws(()=>memory.write(0x8200000c,new Uint8Array(8).fill(9)),/immutable/);assert.deepEqual(owned,new Uint8Array(16));assert.deepEqual(immutable,new Uint8Array(16).fill(7));
  assert.throws(()=>memory.write(0x82000008,new Uint8Array(32).fill(9)),/immutable/);assert.throws(()=>memory.write(0x80001000,new Uint8Array(4)),/Unmapped/);assert.throws(()=>memory.write(0x82000000+0.5,new Uint8Array(4)),/Invalid/);
});

test("actual07D constructor plus finite native setup produces both225-vertex392-triangle initial buffers",actual,()=>{
  const n=native(),definition=input(),beforeInput=JSON.stringify(definition),beforeRom=hash(n.reader.bytes),beforeWave=hash(n.waves.wave(0x4cd)),r=nativeProceduralActorPreview(n.reader,n.files,definition,n.waves)!;
  assert.equal(r.status,"conditional");assert.equal(r.failureKind,"scene-gated");assert.deepEqual(r.codeFileIds,[15]);assert.equal(r.completed,false);assert.equal(r.instructionCount,80083);assert.equal(r.setupEvidence!.instructionLimit,200000);
  assert.deepEqual(r.setupEvidence!.allocationRequests,[128,1156,1156,1156,1156,6144,3600,3600,2056,2056]);assert.equal(r.setupEvidence!.chargedBytes,22784);
  assert.deepEqual(r.deferredCallbacks,[0x80025b38,0x801cc710]);assert.ok(r.setupEvidence!.executedBodies.includes(0x800246bc));assert.ok(r.setupEvidence!.executedBodies.includes(0x80024fac));assert.ok(!r.setupEvidence!.executedBodies.includes(0x80025b38));assert.ok(!r.setupEvidence!.executedBodies.includes(0x801cc710));
  for(const at of [0x800c7a8e,0x800c7a72])assert.ok(!r.setupEvidence!.readSpans.some(s=>at>=s.address&&at<s.address+s.length),`Future prepared-system read ${at.toString(16)}`);
  assert.equal(r.bindings.length,1);const binding=r.bindings[0];assert.equal(binding.identity,0x7d);assert.equal(binding.slot,-1);assert.deepEqual(binding.position,{x:10,y:0,z:-300});assert.deepEqual(binding.positionOffset,{x:-2,y:-34,z:-356});assert.deepEqual(binding.rotation,{x:256,y:0,z:0});assert.deepEqual(binding.rotationOverrideMask,{x:true,y:true,z:true});assert.deepEqual(binding.scale,{x:Math.fround(.2),y:Math.fround(.2),z:Math.fround(.2)});
  assert.equal(u32(r,0x8016dac8),0);assert.equal(new DataView(read(r,0x8016dadc,2).buffer).getInt16(0),1);
  assert.equal(u32(r,0x81000018),0x81000100);assert.equal(u32(r,0x8100001c),0x81000100);assert.equal(u32(r,0x81000100),0);
  const template=n.reader.bytes.subarray(0x5c574,0x5c574+152),object=read(r,0x81000100,152);for(let at=0x38;at<152;at++)if(at!==0x65)assert.equal(object[at],template[at],`Untouched native kind2 template field ${at.toString(16)}`);
  const [first,second]=r.setupEvidence!.vertexBuffers,b0=read(r,first,3600),b1=read(r,second,3600);assert.deepEqual(b0,b1);const vertices=new DataView(b0.buffer);
  for(let i=0;i<225;i++){assert.equal(vertices.getInt16(i*16+2),0);assert.deepEqual([...b0.subarray(i*16+12,i*16+16)],[0,127,0,255]);}
  assert.equal(vertices.getInt16(0),-1000);assert.equal(vertices.getInt16(4),-1000);assert.ok([...Array(225)].some((_,i)=>vertices.getInt16(i*16+8)!==0));
  for(const pointer of r.setupEvidence!.commandBuffers){let triangles=0,texture=false,ended=false;for(let i=0;i<2056;i+=8){const w0=u32(r,pointer+i),w1=u32(r,pointer+i+4);if(w0>>>24===0xb1)triangles+=2;if(w0>>>24===0xf2)assert.equal(w1,0xfc07c);if(w0>>>24===0xfd)texture=w1===r.readonlyMemory[0].address+0x1d10;if(w0>>>24===0xb8){ended=true;break;}}assert.equal(triangles,392);assert.ok(texture&&ended);}
  const work=r.setupEvidence!.workAddress;for(const [offset,bits] of [[0x50,0],[0x54,0],[0x58,0],[0x5c,0x3f800000]]){const pointer=u32(r,work+offset);for(let i=0;i<289;i++)assert.equal(u32(r,pointer+i*4),bits);}
  assert.equal(hash(n.waves.wave(0x4cd).subarray(0x1d10,0x2d10)),"d9d3c21703510cd691cf386c9990a3db0870e164ff048455a3a5f21e931b7f8b");
  assert.equal(hash(n.reader.bytes),beforeRom);assert.equal(hash(n.waves.wave(0x4cd)),beforeWave);assert.equal(JSON.stringify(definition),beforeInput);
});

test("actual07D guarded failure paths refuse unavailable conditional context or altered sources",actual,()=>{
  const n=native();
  for(const options of [{availableObjects:0 as const},{preloadResource:false},{arena:NativeLinkedArena.initialize(0x80154c64,0x81010000,new Uint8Array(16384)).snapshot()}]){const r=nativeProceduralActorPreview(n.reader,n.files,input(),n.waves,options)!;assert.equal(r.completed,false);assert.equal(r.status,"unsupported");assert.equal(r.bindings.length,0);assert.ok(r.instructionCount<200000);}
  const corrupted=NativeLinkedArena.initialize(0x80154c64,0x81010000,new Uint8Array(65536)).snapshot();new DataView(corrupted.descriptor.buffer).setUint32(8,0x81010000);assert.equal(nativeProceduralActorPreview(n.reader,n.files,input(),n.waves,{arena:corrupted})!.instructionCount,0);
  for(const at of [0x65f828,0x252bc,0x24d60,0x25bac,0x6df08,0x5e3c8c+0x7d*4,0x5e4ca6+0x7d*2,0x556c4+15*8,0x6a51c+0x4cd*4,0x13d4a60]){const bytes=n.reader.bytes.slice();bytes[at]^=1;const r=nativeProceduralActorPreview(new RomReader(bytes),n.files,input(),n.waves)!;assert.equal(r.instructionCount,0);assert.equal(r.bindings.length,0);assert.equal(r.completed,false);assert.equal(r.codeFileIds,undefined);}
  for(const provider of [
    {...n.waves,image:(id:number)=>({...n.waves.image(id),fileId:id-1})},
    {...n.waves,image:(id:number)=>({...n.waves.image(id),nativeEnd:0x48002d10})},
    {...n.waves,image:(id:number)=>({...n.waves.image(id),parts:[{destination:0x08002d10,bytes:new Uint8Array(1)}]})},
  ]){const r=nativeProceduralActorPreview(n.reader,n.files,input(),{wave:n.waves.wave.bind(n.waves),image:provider.image})!;assert.equal(r.instructionCount,0);assert.equal(r.status,"unsupported");assert.equal(r.bindings.length,0);}
  const files=new Map(n.files),file=files.get(15)!;files.set(15,{...file,end:file.end-16});assert.equal(nativeProceduralActorPreview(n.reader,files,input(),n.waves)!.instructionCount,0);
  const cached=n.waves.wave(0x4cd),original=cached[0x1d10];cached[0x1d10]^=1;try{const r=nativeProceduralActorPreview(n.reader,n.files,input(),n.waves)!;assert.equal(r.instructionCount,0);assert.match(r.diagnostics[0],/cached File4CD/);}finally{cached[0x1d10]=original;}
});

test("actual07D public visual retains native absolute placement and unresolved export lifecycle",actual,()=>{
  const n=native(),initializer=new ActorInitializer(n.reader,n.files,n.waves),r=initializer.resolve(input());assert.equal(r.status,"conditional");assert.equal(r.completed,false);assert.equal(r.bindings.length,1);
  const visuals=new ActorVisuals(n.reader,n.files,n.waves),payload=visuals.preview(input(),"library:07d"),visual=payload.actorVisuals[0];assert.equal(visual.status,"conditional");assert.equal(visual.parts.length,1);assert.deepEqual(visual.parts[0].provenance.fileIds,[15,1229]);assert.equal(payload.actorModels.flatMap(m=>m.meshes).reduce((n,m)=>n+m.indices.length/3,0),392);assert.match(visual.reason!,/constructor fixes its transform/);
  const mesh=payload.actorModels.flatMap(m=>m.meshes).find(m=>m.material?.textureId)!;assert.ok(mesh);const texture=payload.actorModels.flatMap(m=>m.textures).find(t=>t.id===mesh.material!.textureId)!;assert.ok(texture);assert.equal(texture.width,64);assert.equal(texture.height,64);assert.equal(mesh.material!.opacity,128/255);
  const rgba=Buffer.from(texture.rgbaBase64,"base64");assert.equal(hash(rgba),"81e874f1d1857d5e8cd7be57c2d1c0f565e7d85bf22573e66e6d6ec0a85f1cce");assert.deepEqual(rgba.subarray(0,64*32*4),rgba.subarray(64*32*4));assert.equal(hash(rgba.subarray(0,64*32*4)),"27ec32d5e97cee4a1c951850a3258c2958048de28c99c82791c8b76f2d0cb450");
  const dependencies=visuals.dependencies(input());assert.equal(dependencies.completed,false);assert.deepEqual(dependencies.fileIds,[15,1229]);const catalog=n.rom.getAuthoringCatalog(),prototype=catalog.actorPrototypes.find(p=>p.actorId===0x7d)!;
  assert.throws(()=>n.rom.authoringExportContext().prototype(prototype.id,{parameters:[0,0,0]},{roomId:620,templateRoomId:465}),/cannot be exported yet:.*fixed File15/i);
});
