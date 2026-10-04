import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {importRomBytes,readFileTable,type ImportedRom} from "../core/rom";
import {RomReader} from "../core/rom/binary";
import {RenderWaves} from "../core/rom/waves";
import {ActorInitializer,ActorMemory,type NativeActorInitInput,type NativeActorInitResult} from "../core/rom/actor-init";
import {ActorVisuals} from "../core/rom/actors";
import {NativeLoaderPreview,verifiedLoaderPresentationCall,LOADER_REGISTRY_ADDRESS,LOADER_ARENA_DESCRIPTOR} from "../core/rom/actor-init-loader-preview";

const zero={x:0,y:0,z:0},hash=(b:Uint8Array)=>createHash("sha256").update(b).digest("hex");
let imported:ImportedRom;
function native(bytes?:Uint8Array){
  imported??=importRomBytes(readFileSync(process.env.MNSG_TEST_ROM!));const reader=new RomReader(bytes??imported.bytes),files=new Map(readFileTable(reader.bytes).map(f=>[f.id,f]));
  const waves=new RenderWaves(reader,files,id=>{for(let at=0x55510;at<0x556c4;at+=4){const upper=reader.u16(at);if(!upper)break;if(id<upper)return reader.bytes[at+3];}throw new Error("No segment");});
  return {reader,files,waves,init:new ActorInitializer(reader,files,waves),visuals:new ActorVisuals(reader,files,waves),rom:imported};
}
function input(actorId:number,roomId:number):NativeActorInitInput{return {actorId,roomId,parameters:[0,0,0],position:zero,rotation:zero};}
function read(result:NativeActorInitResult,address:number,length:number):DataView {
  const bytes=new Uint8Array(length);for(let i=0;i<length;i++){let found=false;for(const span of result.syntheticMemory)if(address+i>=span.address&&address+i<span.address+span.bytes.length){bytes[i]=span.bytes[address+i-span.address];found=true;}if(!found)throw new Error(`Missing synthetic byte ${address+i}`);}return new DataView(bytes.buffer);
}
function taskObjects(result:NativeActorInitResult){return result.syntheticMemory.filter(s=>s.bytes.length===0xf0&&new DataView(s.bytes.buffer,s.bytes.byteOffset).getUint32(0x18)).map(s=>({task:s.address,object:new DataView(s.bytes.buffer,s.bytes.byteOffset).getUint32(0x18)}));}
const actual={skip:!process.env.MNSG_TEST_ROM};

test("direct loader guards reject sparse, missing and non-array definition words before ROM reads",()=>{
  const reader=new RomReader(new Uint8Array(64)),files=new Map();let decoded=false;
  const waves={image:()=>{decoded=true;throw Error("No native image decode permitted");}};
  for(const id of [0x24c,0x35c])for(const parameters of [new Array(3),[0,,0],[0,0],{0:0,1:0,2:0,length:3},null])assert.throws(()=>new NativeLoaderPreview(reader,files,{...input(id,id===0x24c?306:193),parameters:parameters as number[]},waves),/zero definition words/);
  assert.equal(decoded,false);
});

test("CPU full-span readonly barriers reject before any private or cached byte changes",()=>{
  const m=new ActorMemory(new RomReader(new Uint8Array(0x1000)),new Map()),source=Uint8Array.of(1,2,3,4);m.regions.push({start:0x80321500,bytes:source,readonly:true});
  assert.throws(()=>m.write(0x803214fe,new Uint8Array(6).fill(9)),/readonly/);assert.deepEqual([...source],[1,2,3,4]);assert.equal(m.privateBytes.size,0);
  assert.throws(()=>m.write(0x80321500,Uint8Array.of(9)),/readonly/);assert.throws(()=>m.read(0x803214ff,2),/boundary/);
  assert.deepEqual([...m.read(0x80321500,4)],[1,2,3,4]);assert.throws(()=>m.write(0x80001000+.5,Uint8Array.of(9)),/Invalid/);
});

test("VI/audio omissions match exact verified File74 caller and arguments only",()=>{
  for(const target of [0x8003ff50,0x80038bc8]){const call={actorId:0x35c,codeFile:74,target,returnAddress:target===0x8003ff50?0x08003938:0x08003948,argument:target===0x8003ff50?0x40:1};assert.equal(verifiedLoaderPresentationCall(call),true);
    for(const [field,value] of [["actorId",0x24c],["codeFile",45],["target",0x80040170],["returnAddress",0x0800393c],["argument",0]] as const)assert.equal(verifiedLoaderPresentationCall({...call,[field]:value}),false);
  }
});

test("cold source tables build literal29/22-ID ledgers with native code tags, duplicate and missing lookup",actual,()=>{
  const n=native();for(const [id,room,count,cursor,code,base] of [[0x24c,306,29,0x803f6500,45,0x803cb000],[0x35c,193,22,0x803a0780,74,0x8039b000]]){
    const loader=new NativeLoaderPreview(n.reader,n.files,input(id,room),n.waves),s=loader.registry.snapshot();assert.equal(s.allocations.length,count);assert.equal(loader.preloadedCursor,cursor);assert.equal(loader.lookup(0),0);assert.equal(loader.lookup(1),-1);assert.equal(loader.base(code),base);assert.equal(loader.lookup(code),(base|0x40000000)>>>0);
    const index=s.allocations.findIndex(a=>a.fileId===code);assert.equal(loader.load(code),new DataView(s.records.buffer).getUint32((index+1)*8+4));assert.equal(loader.registry.snapshot().allocations.length,count);
    assert.ok(s.allocations.some(a=>a.fileId===338));assert.ok(!s.allocations.some(a=>[288,292,296,300].includes(a.fileId)));assert.equal(s.allocations[0].fileId,128);
    assert.throws(()=>loader.loadListAt(0x801fc7ba),/exact guarded/);assert.throws(()=>loader.base(1),/does not implicitly load/);
  }
});

test("24C executes the two actual native child constructors once and keeps draw bucket separate",actual,()=>{
  const n=native(),a=n.rom.loadRoom(306).actors.find(a=>a.actorId===0x24c)!,i={...input(0x24c,306),position:a.position,rotation:a.rotation,parameters:a.parameters};
  const r=n.init.resolve(i);assert.equal(r.status,"conditional");assert.equal(r.completed,false);assert.equal(r.failureKind,"scene-gated");assert.ok(r.instructionCount<12000);
  assert.deepEqual(r.loaderPreview,{donor:306,preloadedCount:29,preloadedCursor:0x803f6500,finalCount:30,finalCursor:0x803fb3c0});
  assert.deepEqual(r.bindings.map(b=>[b.identity,b.slot]),[[0x1af,0],[0x317,0]]);
  const [first,second]=r.bindings;assert.deepEqual(first.position,{x:1337,y:166,z:-262});assert.equal(first.rotation.y,0x2fc);assert.equal(first.scale.x,Math.fround(.7));assert.deepEqual(first.segments.map(s=>s.fileId),[484,338]);
  assert.deepEqual(second.position,{x:1328.800048828125,y:164,z:-185});assert.equal(second.rotation.y,0x216);assert.equal(second.scale.x,Math.fround(.1));assert.deepEqual(second.segments.map(s=>s.fileId),[690,338]);
  const children=taskObjects(r).filter(t=>[0x1af,0x317].includes(read(r,t.task+0x5e,2).getUint16(0)));assert.equal(children.length,2);
  for(const c of children){assert.equal(read(r,c.task+0x28,2).getUint16(0),45);assert.equal(read(r,c.task+0x2c,4).getUint32(0),0xc03cb000);assert.equal(read(r,c.object+4,1).getUint8(0),2);}
  assert.equal(read(r,children[0].object+5,1).getUint8(0),7);assert.ok(r.deferredCallbacks.includes(0x8022218c));assert.ok(r.deferredCallbacks.includes(0x08000410));
  const material=(first.materialPointer&0x8fffffff)>>>0;assert.equal(read(r,material+8,4).getUint32(0),0xfc567e04);assert.equal(read(r,material+12,4).getUint32(0),0x1ffcf3f8);assert.equal(read(r,material+20,4).getUint32(0),0xffffff00);
});

test("35C arena header, native texture sequence, camera and absolute child pose match first return",actual,()=>{
  const n=native(),r=n.init.resolve(input(0x35c,193));assert.equal(r.status,"conditional");assert.equal(r.completed,false);assert.equal(r.bindings.length,1);
  assert.deepEqual(r.loaderPreview,{donor:193,preloadedCount:22,preloadedCursor:0x803a0780,finalCount:36,finalCursor:0x803e8600});
  assert.equal(read(r,LOADER_ARENA_DESCRIPTOR,12).getUint32(8),0x802f7070);assert.deepEqual([0,4,8,12].map(at=>read(r,0x802f7070+at,4).getUint32(0)),[0x802f7000,0x80,0,0]);
  assert.equal(read(r,0x802f7060,4).getUint32(0),0x8020cbf0);const camera=read(r,0x801fc628,4).getUint32(0);assert.equal(read(r,camera+0x2c,4).getUint32(0),0xa020cbf0);
  assert.equal(r.syntheticMemory.find(s=>s.address===0x8020cbf0)?.bytes.length,0x60);
  const b=r.bindings[0];assert.equal(b.identity,0x359);assert.equal(b.slot,0);assert.deepEqual(b.position,{x:440,y:-20,z:0});assert.deepEqual(b.scale,{x:1,y:1,z:1});assert.deepEqual(b.rotation,zero);assert.deepEqual(b.segments.find(s=>s.segment===11),{segment:11,fileId:572,offset:0x110});
  const child=taskObjects(r).find(t=>read(r,t.task+0x5e,2).getUint16(0)===0x359)!;assert.ok(child);assert.equal(read(r,child.task+0x28,2).getUint16(0),74);assert.equal(read(r,child.task+0x2c,4).getUint32(0),0xc039b000);
  // Native constructor passes F32 3.0 in a2;24560 stores its derived half-rate byte, not a persistent F32 speed field.
  assert.equal(n.reader.u32(n.files.get(74)!.start+0x2c00),0x3c064040);
  assert.equal(read(r,child.task+0xab,1).getUint8(0),15);assert.equal(read(r,child.task+0xad,1).getUint8(0),0);assert.equal(read(r,child.task+0xac,1).getUint8(0),1);assert.equal(read(r,child.task+0xae,1).getUint8(0),7);assert.ok(read(r,child.task+0x60,4).getUint32(0)&4);
  const base=r.readonlyMemory.find(s=>s.fileId===572)!;assert.equal(read(r,child.object+0x50,4).getUint32(0),base.address+0x110);assert.equal(base.scope,"cold-world-loader");assert.ok(r.deferredCallbacks.includes(0x08000138)&&r.deferredCallbacks.includes(0x08002c98));
  assert.equal(r.diagnostics.filter(s=>s.includes("Omitted verified void")).length,2);
});

test("library origins and explicit authored donor previews retain actual room IDs without completing export closure",actual,()=>{
  const n=native();for(const [actorId,donor,newId] of [[0x24c,306,620],[0x35c,193,621]]){
    const base=n.init.resolve(input(actorId,donor)),authored=n.init.resolve({...input(actorId,newId),templateRoomId:donor});assert.equal(base.completed,false);assert.equal(authored.completed,false);assert.equal(authored.status,"conditional");assert.equal(read(authored,0x800c7ab2,2).getUint16(0),newId);assert.deepEqual(authored.bindings.map(b=>[b.identity,b.position,b.rotation,b.scale]),base.bindings.map(b=>[b.identity,b.position,b.rotation,b.scale]));
    for(const bad of [{...input(actorId,465)},{...input(actorId,newId),templateRoomId:465},{...input(actorId,donor),parameters:[1,0,0]},{...input(actorId,donor),unknownHalfword:1}]){const r=n.init.resolve(bad);assert.equal(r.status,"unsupported");assert.equal(r.bindings.length,0);assert.notEqual(r.completed,true);assert.ok(r.diagnostics.some(d=>d.includes("matching native donor")));}
  }
});

test("24C flag99-set alternate File70 scene is not completed or advanced into a guessed visual",actual,()=>{
  const n=native(),evaluate=n.init as unknown as {evaluate(i:NativeActorInitInput,flags:Map<number,boolean>,observed:Set<number>,limit:number):NativeActorInitResult};
  const r=evaluate.evaluate(input(0x24c,306),new Map([[0x99,true]]),new Set(),12000);
  assert.equal(r.completed,false);assert.equal(r.bindings.length,0);assert.equal(r.loaderPreview,undefined);assert.ok(r.diagnostics.some(d=>/removal\/suspension|alternate File70/.test(d)));
});

test("all guarded code/list/table/entry/overlay mutations reject the scoped preview before model capture",actual,()=>{
  const n=native();for(const at of [0x6fea30,0x6fed54,0x700250,0x6ff1bc,0x734790,0x7380b0,0x734838,0x73734c,0x5e8b44,0x5e89f0,0x55524,0x5582c,0x55914,0x66398,0x5e3c8c+0x24c*4,0x5e4ca6+0x35c*2]){
    const changed=n.reader.bytes.slice();changed[at]^=1;const m=native(changed);const r=m.init.resolve(input(at===0x5e4ca6+0x35c*2?0x35c:0x24c,at===0x5e4ca6+0x35c*2?193:306));assert.equal(r.bindings.length,0);assert.equal(r.status,"unsupported");assert.ok(r.diagnostics.some(d=>/guard changed|ROM identity|entry\/overlay/.test(d)));
  }
  const files=new Map(n.files),file=files.get(45)!;files.set(45,{...file,end:file.end-2});assert.throws(()=>new NativeLoaderPreview(n.reader,files,input(0x24c,306),n.waves),/file table\/bounds/);
  assert.throws(()=>new NativeLoaderPreview(n.reader,n.files,input(0x24c,306),{image:id=>({...n.waves.image(id),namespace:"cpu-code"})}),/namespace/);
  assert.throws(()=>new NativeLoaderPreview(n.reader,n.files,input(0x35c,193),{image:id=>({...n.waves.image(id),fileId:id+1})}),/identity/);
});

test("actual static assets and textures render in scoped previews without mutating ROM or cache bytes",actual,()=>{
  const n=native(),before=hash(n.reader.bytes),shared=n.waves.wave(338),cacheHash=hash(shared);
  for(const [id,room,tris] of [[0x24c,306,170],[0x35c,193,2]]){const p=n.visuals.preview(input(id,room),`fixture:${id}`);assert.equal(p.actorVisuals[0].status,"conditional");assert.equal(p.actorVisuals[0].parts.length,id===0x24c?2:1);assert.equal(p.actorModels.reduce((total,m)=>total+m.meshes.reduce((sum,x)=>sum+x.indices.length/3,0),0),tris);assert.ok(p.actorModels.every(m=>m.textures.length>0));assert.ok(p.actorModels.flatMap(m=>m.meshes).some(m=>m.material?.textureId));assert.ok(!p.actorVisuals[0].warnings.some(w=>/kind7.*unsupported/.test(w)));}
  assert.equal(hash(n.reader.bytes),before);assert.equal(hash(shared),cacheHash);
  const loader=new NativeLoaderPreview(n.reader,n.files,input(0x24c,306),n.waves),memory=new ActorMemory(n.reader,n.files);memory.loader=loader;memory.regions.push({start:LOADER_REGISTRY_ADDRESS,bytes:loader.registry.records});memory.syncLoader();
  assert.throws(()=>memory.write(0x803214fc,new Uint8Array(8).fill(9)),/readonly world-cache/);assert.equal(memory.privateBytes.size,0);assert.equal(hash(n.reader.bytes),before);
});

test("readonly low-bank asset aliases require trusted scope, exact extents, nonoverlap and code alignment",actual,()=>{
  const n=native(),r=n.init.resolve(input(0x24c,306));const asset=n.visuals as unknown as {asset(b:NativeActorInitResult["bindings"][number],s:NativeActorInitResult["syntheticMemory"],r:NativeActorInitResult["readonlyMemory"]):unknown};
  for(const mutate of [
    (s:NativeActorInitResult["readonlyMemory"])=>{s[0].scope=undefined;},
    (s:NativeActorInitResult["readonlyMemory"])=>{s[0].byteLength++;},
    (s:NativeActorInitResult["readonlyMemory"])=>{s[1].address=s[0].address;},
    (s:NativeActorInitResult["readonlyMemory"])=>{s.find(s=>s.fileId===45)!.address+=64;},
    (s:NativeActorInitResult["readonlyMemory"])=>{s[0].fileId=0;},
  ]){const aliases=r.readonlyMemory.map(s=>({...s}));mutate(aliases);assert.throws(()=>asset.asset(r.bindings[0],r.syntheticMemory,aliases));}
});
