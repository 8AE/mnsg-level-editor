import test from "node:test";
import assert from "node:assert/strict";
import {decodeNativeSkeletonPose,nativeAnimationFrameValue,nativeInitialAnimationValue,nativePoseChannel,nativePoseMatrix} from "../core/rom/actors-pose";

function animation(bytes:number[]){return (offset:number)=>{if(offset<0||offset>=bytes.length)throw new Error("Animation source bounds");return bytes[offset];};}

test("native initial animation channels cover literal and constant command families",()=>{
  for(const [bytes,value] of [
    [[0x01,0x34],0x0034],[[0x21,0x34],0xff34],[[0x41,0x34],0x0134],[[0x61,0x12,0x34],0x1234],
    [[0x78,0x34],0x0034],[[0x98,0x34],0xff34],[[0xb8,0x34],0x0134],[[0xd8,0x12,0x34],0x1234],[[0xf0,0x12,0x34],0x1234],
  ] as const)assert.equal(nativeInitialAnimationValue(0,animation([...bytes])),value);
  assert.throws(()=>nativeInitialAnimationValue(0,animation([0xf0,0x12])),/bounds/);
  assert.throws(()=>nativeInitialAnimationValue(0,()=>256),/Invalid/);
});

test("native skeleton channels decode constant bias, unsigned scale and signed translation",()=>{
  assert.equal(nativePoseChannel(0xb100,"scale"),1);assert.equal(nativePoseChannel(0xb080,"scale"),.5);
  assert.equal(nativePoseChannel(0xb040,"translation"),2);assert.equal(nativePoseChannel(0xafc0,"translation"),-2);
  assert.equal(nativePoseChannel(0xb100,"rotation"),256);assert.equal(nativePoseChannel(0xf100,"rotation"),256);
  assert.equal(nativePoseChannel(0xa001,"scale"),0xf001/256);
  assert.throws(()=>nativePoseChannel(0xa000,"scale"),/animation stream/);
  assert.equal(nativePoseChannel(0x8000,"translation",animation([0x21,0xc0])),-2);
});

test("integer animation frames cross literal/run boundaries with relative high-byte carry",()=>{
  const bytes=animation([0x62,0x12,0x34,0x56,0x42,0x78,0x9a,0x21,0xbc,0x79,0xde,0xf2,0x23,0x45,0x67,0x89,0x01,0xab,0x78,0xcd]);
  const expected=[0x1234,0x1256,0x1378,0x139a,0x12bc,0x12de,0x12de,0x12de,0x2345,0x6789,0x67ab,0x67cd,0x67cd];
  expected.forEach((value,frame)=>assert.equal(nativeAnimationFrameValue(0,frame,bytes),value,`frame ${frame}`));
  assert.equal(nativePoseChannel(0x0000,"translation",bytes,1),0x1256/32);
  assert.equal(nativePoseChannel(0x8000,"translation",bytes,1),0x1234/32);
  assert.throws(()=>nativeAnimationFrameValue(0,.5,bytes),/Invalid/);
  assert.throws(()=>nativeAnimationFrameValue(0,65536,bytes),/Invalid/);
  assert.throws(()=>nativeAnimationFrameValue(0,0,animation([0xf1,0x12])),/bounds/);
});

test("native skeleton TRS has verified fixed-point units and ZYX matrix order",()=>{
  const bytes=new Uint8Array(24),v=new DataView(bytes.buffer);
  for(const offset of [6,8,10])v.setUint16(offset,0xb100);
  for(const offset of [12,14,16,18,20,22])v.setUint16(offset,0xb000);
  v.setUint16(14,0xb100);v.setUint16(18,0xb040);
  const pose=decodeNativeSkeletonPose(bytes),m=nativePoseMatrix(pose);
  assert.deepEqual(pose.scale,{x:1,y:1,z:1});assert.deepEqual(pose.rotation,{x:0,y:256,z:0});assert.deepEqual(pose.translation,{x:2,y:0,z:0});
  const apply=(x:number,y:number,z:number)=>[m[0]*x+m[4]*y+m[8]*z+m[12],m[1]*x+m[5]*y+m[9]*z+m[13],m[2]*x+m[6]*y+m[10]*z+m[14]];
  assert.ok(Math.abs(apply(1,0,0)[0]-2)<1e-6);assert.ok(Math.abs(apply(1,0,0)[2]+1)<1e-6);
  v.setUint16(12,0xf000);assert.throws(()=>nativePoseMatrix(decodeNativeSkeletonPose(bytes)),/camera alignment/);
  assert.throws(()=>decodeNativeSkeletonPose(bytes.subarray(0,23)),/Truncated/);
});

import {decodeNativeModelGraph} from "../core/rom/actors-models";
import {nativeActorPlacementMatrix,nativeBillboardMatrix,nativeBoneBillboardMatrix} from "../core/rom/actors-pose";
import {renderModelLists} from "../core/rom/render";
function graphFixture(){
  const bytes=new Uint8Array(1024),v=new DataView(bytes.buffer);
  v.setUint32(0,0x80000101);v.setUint32(8,0x08000020);
  const node=(at:number,display:number,x:number,right=0,left=0)=>{v.setUint32(at,display);v.setInt8(at+4,right);v.setInt8(at+5,left);for(const p of [6,8,10])v.setUint16(at+p,0xb100);for(const p of [12,14,16,18,20,22])v.setUint16(at+p,0xb000);v.setUint16(at+18,0xb000+x*32);};
  node(0x20,0x08000200,9,1);node(0x38,0x08000200,2,1,2);node(0x50,0x08000200,3);node(0x68,0x08000200,4);
  let at=0x200;for(const [a,b] of [[0xfcffffff,0xfffdfcfe],[0x04000c2f,0x08000300],[0xbf000000,0x00000204],[0xb8000000,0]]){v.setUint32(at,a);v.setUint32(at+4,b);at+=8;}
  for(let i=0;i<3;i++)v.setInt16(0x300+i*16,i);
  const read=(address:number,size:number)=>{const offset=address&0xffffff;if(offset+size>bytes.length)throw new Error("Graph source bounds");return bytes.subarray(offset,offset+size);};
  return {v,bytes,node,read};
}
test("native graph root/sibling hierarchy and inherited-right matrices match draw traversal",()=>{
  const f=graphFixture(),g=decodeNativeModelGraph(f.read,0x18000000);
  assert.equal(g.nodes.length,4);assert.deepEqual(g.nodes.map(n=>n.parentIndex),[null,0,1,0]);assert.deepEqual(g.roots.map(r=>r.matrix![12]),[0,2,5,4]);
  f.v.setUint32(0,0x00000101);const noinherit=decodeNativeModelGraph(f.read,0x18000000);assert.deepEqual(noinherit.nodes.map(n=>n.parentIndex),[null,0,0,0]);assert.deepEqual(noinherit.roots.map(r=>r.matrix![12]),[0,2,3,4]);
  f.v.setUint32(0,0x80000101);const type0=decodeNativeModelGraph(f.read,0x08000000);assert.deepEqual(type0.roots.map(r=>r.matrix![12]),[9,11,14,13]);
  const render=renderModelLists(f.read,g.roots);assert.equal(render.complete,true);assert.equal(render.coverage.triangles,4);assert.equal(render.meshes[1].positions[0],2);
});
test("linked skeleton omits linked-root TRS, rejects control tags and detects cycles",()=>{
  const f=graphFixture();f.v.setUint32(0x20,0x18000080);f.v.setInt8(0x24,0);f.node(0x80,0x08000200,99,1);f.node(0x98,0x08000200,3);
  const g=decodeNativeModelGraph(f.read,0x18000000);assert.deepEqual(g.roots.map(r=>r.matrix![12]),[0,3]);
  f.v.setUint32(0x80,0x18000200);assert.equal(decodeNativeModelGraph(f.read,0x18000000).roots[0].displayList,0x18000200);
  f.v.setUint32(0x80,0x16000200);assert.throws(()=>decodeNativeModelGraph(f.read,0x18000000),/control tag/);
  const cycle=graphFixture();cycle.v.setInt8(0x54,-1);assert.throws(()=>decodeNativeModelGraph(cycle.read,0x18000000),/cycle/);
});
test("native embedded camera/light words skip before geometry roots, type6 initial pose and billboard metadata",()=>{
  const f=graphFixture();f.v.setUint32(0,0x91000101);f.v.setUint32(8,0x08000180);f.v.setUint32(12,0x08000190);f.v.setUint32(16,0x08000020);
  const g=decodeNativeModelGraph(f.read,0x18000000);assert.equal(g.roots.length,4);assert.match(g.warnings.join(),/camera\/light/);
  f.v.setUint32(0,0x80000101);f.v.setUint32(8,0x08000020);f.v.setUint16(0x44,0xf000);const cached=decodeNativeModelGraph(f.read,0x68000000);assert.equal(cached.roots.length,4);assert.equal(cached.nodes[1].billboardAxes?.x,true);
  const root=nativeActorPlacementMatrix({x:10,y:20,z:30},{x:-32768,y:256,z:0});assert.deepEqual(root.slice(12),[10,20,30,1]);
  const facing=nativeBillboardMatrix({x:0,y:0,z:1},{x:true,y:true,z:true});assert.ok(Math.abs(facing[0]-1)<1e-6);assert.ok(Math.abs(facing[10]-1)<1e-6);
  assert.ok(nativeBoneBillboardMatrix({x:0,y:0,z:1},{x:0,y:256,z:0},{x:true,y:true,z:true}).every(Number.isFinite));
  assert.throws(()=>decodeNativeModelGraph(f.read,0x18000000,.5),/fractional/);
  assert.throws(()=>decodeNativeModelGraph(f.read,0x18000000,0,1),/blending/);
});

test("model draw state and vertex-load ownership persist across native limbs",()=>{
  const f=graphFixture();let at=0x180;
  const command=(a:number,b:number)=>{f.v.setUint32(at,a);f.v.setUint32(at+4,b);at+=8;};
  command(0xfcffffff,0xfffdfcfe);command(0xfa000000,0xffffffff);command(0xb8000000,0);
  at=0x200;command(0xfa000000,0xff0000ff);command(0x04000c2f,0x08000300);command(0xbf000000,0x00000204);command(0xb8000000,0);
  at=0x240;command(0xbf000000,0x00000204);command(0xb8000000,0);
  const ownership:{loads:number[];draw:number}[]=[];
  const render=renderModelLists(f.read,[{displayList:0x08000200,material:0x08000180,preserveVertexCache:true},{displayList:0x08000240,preserveVertexCache:true}],0,(loads,draw)=>ownership.push({loads,draw}));
  assert.equal(render.complete,true);assert.deepEqual(render.meshes.map(m=>m.material!.color),[[1,0,0],[1,0,0]]);
  assert.deepEqual(ownership,[{loads:[0,0,0],draw:0},{loads:[0,0,0],draw:1}]);
});

import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {importRomBytes} from "../core/rom";
import {actorTextureColorVariant,actorTextureProductVariant,actorPrimitiveAlphaTexture,nativeCombinerClamp} from "../core/rom/actors-colors";
import {readNativeActorMemory,graphicsActorMemory,type NativeActorMemorySpan} from "../core/rom/actors-memory";
import {ActorVisuals} from "../core/rom/actors";
import {RomReader} from "../core/rom/binary";
import {RenderWaves} from "../core/rom/waves";
import {ActorInitializer,type NativeActorBinding} from "../core/rom/actor-init";
import {readFileTable} from "../core/rom/decompress";
import type {ActorModel} from "../shared/types";
test("readonly native resource aliases participate in asset cache identity",()=>{
  const f=graphFixture();let at=0x200;const command=(a:number,b=0)=>{f.v.setUint32(at,a);f.v.setUint32(at+4,b);at+=8;};
  command(0xfcffffff,0xfffcf238);command(0xbb000001,0xffffffff);command(0xfd100003,0x82000000);command(0xf5100000,0x07000000);command(0xf3000000,0x07003000);command(0xf5100200);command(0xf2000000,0x0000c000);command(0x04000c2f,0x08000300);command(0xbf000000,0x00000204);command(0xb8000000);
  const waves={wave:(id:number)=>id===99?f.bytes:Uint8Array.from(id===1?[0xf8,1,0xf8,1,0xf8,1,0xf8,1]:[7,0xc1,7,0xc1,7,0xc1,7,0xc1])} as unknown as RenderWaves;
  const files=new Map([1,2,99].map(id=>[id,{id,start:0,end:8,compressed:false}])),service=new ActorVisuals(new RomReader(new Uint8Array()),files,waves);
  const asset=(service as unknown as {asset:(b:NativeActorBinding,s:[],r:{address:number;fileId:number;byteLength:number}[])=>ActorModel}).asset.bind(service);
  const binding={identity:1,slot:0,modelPointer:0x48000200,materialPointer:0,segments:[{segment:8,fileId:99,offset:0}],animationFrame:0,animationBlendCountdown:0} as NativeActorBinding;
  const first=asset(binding,[],[{address:0x82000000,fileId:1,byteLength:8}]),second=asset(binding,[],[{address:0x82000000,fileId:2,byteLength:8}]);
  assert.notEqual(first.id,second.id);assert.notEqual(first.textures[0].rgbaBase64,second.textures[0].rgbaBase64);
  assert.equal(asset(binding,[],[{address:0x82000000,fileId:1,byteLength:8}]).id,first.id);
});
test("private native material snapshots overlay partial commands and adjacent spans",()=>{
  const canonical=Uint8Array.from([0xfa,0,0,0,255,255,255,255]),base=(at:number,n:number)=>{if(at<0x80001000||at+n>0x80001008)throw new Error("Unmapped fixture");return canonical.subarray(at-0x80001000,at-0x80001000+n);};
  const dependencies:{at:number;bytes:number[]}[]=[],red={address:0x80001004,bytes:Uint8Array.from([255,0,0,255])};
  assert.deepEqual([...readNativeActorMemory(base,0x80001000,8,[red],(at,bytes)=>dependencies.push({at,bytes:[...bytes]}))],[0xfa,0,0,0,255,0,0,255]);
  assert.deepEqual(dependencies,[{at:0x80001004,bytes:[255,0,0,255]}]);
  const adjacent=[{address:0x81000000,bytes:Uint8Array.from([1,2])},{address:0x81000002,bytes:Uint8Array.from([3,4])}];
  assert.deepEqual([...readNativeActorMemory(base,0x81000000,4,adjacent)],[1,2,3,4]);
  assert.deepEqual([...readNativeActorMemory(base,0x80001000,8,[{address:0x80001000,bytes:canonical},red])],[0xfa,0,0,0,255,0,0,255]);
  assert.throws(()=>readNativeActorMemory(base,0x81000000,5,adjacent),/Unmapped/);assert.deepEqual([...canonical],[0xfa,0,0,0,255,255,255,255]);
});
test("CPU overlay memory cannot shadow another RSP file and matching physical-file mappings retain private writes",()=>{
  const spans=[{address:0x08000e70,bytes:Uint8Array.from([1,2]),codeFile:24},{address:0x81000000,bytes:Uint8Array.from([3,4])}];
  const other=graphicsActorMemory(spans,[{segment:8,fileId:450,offset:0}]);assert.deepEqual(other,[spans[1]]);
  const same=graphicsActorMemory(spans,[{segment:9,fileId:24,offset:0x100}]);assert.equal(same[0].address,0x09000d70);assert.deepEqual([...same[0].bytes],[1,2]);
  const suffix=graphicsActorMemory([{address:0x08000e70,bytes:Uint8Array.from({length:256},(_,i)=>i),codeFile:24}],[{segment:9,fileId:24,offset:0xf00}]);assert.equal(suffix[0].address,0x09000000);assert.equal(suffix[0].bytes.length,112);assert.equal(suffix[0].bytes[0],144);
  const canonical=()=>Uint8Array.from([7,8]);assert.deepEqual([...readNativeActorMemory(canonical,0x08000e70,2,other)],[7,8]);assert.deepEqual([...readNativeActorMemory(canonical,0x09000d70,2,same)],[1,2]);
  assert.equal(graphicsActorMemory([{address:0x08000e70,bytes:Uint8Array.from([1,2])}],[{segment:8,fileId:450,offset:0}]).length,0);
});

test("actual overlay24 BSS stays CPU-only while287 copied private material remains readable",{skip:!process.env.MNSG_TEST_ROM},()=>{
  const rom=importRomBytes(readFileSync(process.env.MNSG_TEST_ROM!)),reader=new RomReader(rom.bytes),files=new Map(readFileTable(rom.bytes).map(f=>[f.id,f]));
  const segment=(id:number)=>{for(let at=0x55510;at<0x55910;at+=4)if(id<reader.u16(at))return reader.bytes[at+3];throw Error("No native resource segment");},waves=new RenderWaves(reader,files,segment),initializer=new ActorInitializer(reader,files,waves),service=new ActorVisuals(reader,files,waves);
  const read=(service as unknown as {read:(binding:NativeActorBinding,address:number,size:number,synthetic:NativeActorMemorySpan[],readonly:[])=>Uint8Array}).read.bind(service),zero={x:0,y:0,z:0};
  const result=initializer.resolve({actorId:0x134,parameters:[0,0,0],position:zero,rotation:zero,roomId:0}),binding=result.bindings[0];assert.ok(binding);assert.equal(binding.segments.find(s=>s.segment===8)?.fileId,450);
  assert.ok(result.syntheticMemory.some(s=>s.address===0x08000e70&&s.codeFile===24));
  const expected=waves.wave(450).subarray(0xe70,0xe80);assert.notDeepEqual([...expected],Array(16).fill(0));assert.deepEqual(read(binding,0x08000e70,16,result.syntheticMemory,[]),expected);
  const placement=rom.loadRoom(341).actors.find(actor=>actor.actorId===0x287)!;
  const dragon=initializer.resolve({actorId:0x287,parameters:placement.parameters,position:placement.position,rotation:placement.rotation,roomId:341}),body=dragon.bindings.find(binding=>binding.identity!==1)!;assert.ok(body);
  const material=(body.materialPointer&0x8fffffff)>>>0,span=dragon.syntheticMemory.find(s=>material>=s.address&&material+8<=s.address+s.bytes.length)!;assert.ok(span);assert.ok(material>=0x81000000);
  assert.deepEqual(read(body,material,8,dragon.syntheticMemory,[]),span.bytes.subarray(material-span.address,material-span.address+8));assert.ok(dragon.syntheticMemory.some(s=>s.address===0x08003f30&&s.codeFile===56));
  const words=new DataView(span.bytes.buffer,span.bytes.byteOffset,span.bytes.length),tags=Array.from({length:span.bytes.length/8},(_,index)=>words.getUint32(index*8)>>>24);assert.ok(tags.includes(0xfa)&&tags.includes(0xfd));
  const asset=(service as unknown as {asset:(binding:NativeActorBinding,synthetic:NativeActorMemorySpan[],readonly:typeof dragon.readonlyMemory)=>ActorModel}).asset.call(service,body,dragon.syntheticMemory,dragon.readonlyMemory);assert.ok(asset.meshes.length);assert.ok(asset.textures.length);
});
test("native actor environment color variants preserve source alpha and signed combiner wrap",()=>{
  const source={id:"fixture",format:"RGBA32",width:2,height:1,rgbaBase64:Buffer.from([64,128,192,17,255,0,0,201]).toString("base64")};
  const env=[32/255,64/255,16/255,128/255],before=source.rgbaBase64;
  assert.deepEqual([...Buffer.from(actorTextureColorVariant(source,"add-environment",env).rgbaBase64,"base64")],[96,192,208,17,255,64,16,201]);
  assert.deepEqual([...Buffer.from(actorTextureColorVariant(source,"environment",env).rgbaBase64,"base64")],[32,64,16,17,32,64,16,201]);
  const mixed=[...Buffer.from(actorTextureColorVariant(source,"mix-environment",env).rgbaBase64,"base64")];assert.deepEqual(mixed.slice(0,4),[48,96,104,17]);
  assert.equal(source.rgbaBase64,before);assert.equal(nativeCombinerClamp(2),0);assert.equal(nativeCombinerClamp(1.25),1);assert.equal(nativeCombinerClamp(-.25),0);
  assert.throws(()=>actorTextureColorVariant(source,"environment",[2,0,0,1]),/Invalid/);
  const product=actorTextureProductVariant(source,source,[0,0,0,.5]);assert.deepEqual([...Buffer.from(product.rgbaBase64,"base64")].slice(0,4),[16,64,145,255]);
  assert.ok([...Buffer.from(actorPrimitiveAlphaTexture(source).rgbaBase64,"base64")].filter((_,i)=>i%4===3).every(a=>a===255));
  assert.throws(()=>actorTextureProductVariant(source,{...source,width:1},[0,0,0,1]),/Unaligned/);
});

test("verified actor environment combiners retain pixels, alpha and cycle-specific state",()=>{
  for(const [w0,w1,cycle,textured,opacity] of [[0xfc629ac5,0xff34fe7f,0,true,128/255],[0xfc629ac5,0xff37ffff,0,true,128/255],[0xfc62fec5,0xfffdfafd,0,false,128/255],[0xfc121624,0xff2fffff,0,true,127/255],[0xfc327e64,0xfffefb7d,0,false,128/255],[0xfc567e04,0x1ffcf3f8,1,true,1],[0xfc121a24,0xff36ff7f,0,true,128/255]] as const){
    const f=graphFixture();let at=0x200;const command=(a:number,b=0)=>{f.v.setUint32(at,a);f.v.setUint32(at+4,b);at+=8;};
    command(0xfc000000|(w0&0xffffff),w1);command(0xfa000000,0x1020307f);command(0xfb000000,0x20406080);command(0xba001402,cycle<<20);
    command(0xbb000001,0xffffffff);command(0xfd100003,0x08000380);command(0xf5100000,0x07000000);command(0xf3000000,0x07003000);command(0xf5100200);command(0xf2000000,0x0000c000);if(w1===0xff36ff7f)command(0xb7000000,0x20000);command(0x04000c2f,0x08000300);command(0xbf000000,0x00000204);command(0xb8000000);
    f.bytes.set([0xf8,1,7,0xc1,0,0x3f,0xff,0xff],0x380);for(let i=0;i<3;i++)f.bytes.set([255,0,0,255],0x30c+i*16);
    const render=renderModelLists(f.read,[{displayList:0x08000200}]),material=render.meshes[0].material!;
    assert.equal(render.complete,true);assert.equal(render.coverage.unsupported,0);assert.equal(!!material.textureId,textured);assert.equal(material.opacity,opacity);
    if(w1===0xff34fe7f){const map=render.textures.find(t=>t.id===material.textureId)!;assert.deepEqual([...Buffer.from(map.rgbaBase64,"base64")].slice(0,4),[255,64,96,255]);}
    if(w1===0xff37ffff){const map=render.textures.find(t=>t.id===material.textureId)!;assert.deepEqual([...Buffer.from(map.rgbaBase64,"base64")].slice(0,4),[32,64,96,255]);}
    if(w1===0xfffdfafd)assert.deepEqual(material.color,[48/255,96/255,144/255]);
    if(w1===0xfffefb7d){assert.deepEqual(material.color,[1,1,1]);assert.deepEqual(render.meshes[0].colors!.slice(0,3),[48/255,64/255,96/255]);}
  }
});
test("unknown inherited actor material fallback is explicit, opt-in and limited to zero mux",()=>{
  const f=graphFixture();let at=0x200;const command=(a:number,b=0)=>{f.v.setUint32(at,a);f.v.setUint32(at+4,b);at+=8;};
  command(0xbb000001,0xffffffff);command(0xfd100003,0x08000380);command(0xf5100000,0x07000000);command(0xf3000000,0x07003000);command(0xf5100200);command(0xf2000000,0x0000c000);command(0x04000c2f,0x08000300);command(0xbf000000,0x00000204);command(0xb8000000);
  f.bytes.set([0xf8,1,7,0xc1,0,0x3f,0xff,0xff],0x380);
  const roots=[{displayList:0x08000200}],normal=renderModelLists(f.read,roots),fallback=renderModelLists(f.read,roots,0,undefined,{inheritedTextureFallback:true});
  assert.equal(normal.coverage.textured,0);assert.equal(fallback.coverage.textured,1);assert.equal(fallback.coverage.unsupported,1);assert.match(fallback.warnings.join(),/inherited scene material is unknown/);
  assert.deepEqual(fallback.meshes[0].material!.color,[1,1,1]);assert.equal(fallback.meshes[0].material!.opacity,1);assert.equal(fallback.meshes[0].material!.vertexColors,false);
  const saved=f.bytes.slice();
  f.v.setUint32(0x200,0xfcffffff);f.v.setUint32(0x204,0xabcdef01);const unknown=renderModelLists(f.read,roots,0,undefined,{inheritedTextureFallback:true});assert.equal(unknown.coverage.textured,0);
  f.bytes.set(saved);f.v.setUint32(0x200,0xb7000000);f.v.setUint32(0x204,0x40000);f.v.setUint32(0x208,0xbb000001);f.v.setUint32(0x20c,0xffffffff);const generated=renderModelLists(f.read,roots,0,undefined,{inheritedTextureFallback:true});assert.equal(generated.coverage.textured,0);assert.match(generated.warnings.join(),/generated texture coordinates/);
  f.bytes.set(saved);f.v.setUint32(0x200,0x99000000);const badState=renderModelLists(f.read,roots,0,undefined,{inheritedTextureFallback:true});assert.equal(badState.coverage.textured,0);
  f.bytes.set(saved);f.v.setUint32(0x218,0);const absent=renderModelLists(f.read,roots,0,undefined,{inheritedTextureFallback:true});assert.equal(absent.coverage.textured,0);assert.match(absent.warnings.join(),/uninitialized TMEM/);
});
test("two-texture actor material composes aligned samplers and preserves explicit partial fallbacks",()=>{
  const make=()=>{const f=graphFixture();let at=0x200;const command=(a:number,b=0)=>{f.v.setUint32(at,a);f.v.setUint32(at+4,b);at+=8;};
    command(0xfc1115ff,0xfffdfe3b);command(0xfa000000,0x1020307f);command(0xba001402,0x100000);command(0xbb000001,0xffffffff);
    command(0xfd100003,0x08000380);command(0xf5100000,0x07000000);command(0xf3000000,0x07003000);command(0xf5100200);command(0xf2000000,0x0000c000);
    command(0xfd100003,0x08000388);command(0xf5100001,0x07000000);const secondLoad=at;command(0xf3000000,0x07003000);command(0xf5100201,0x01000000);const secondSize=at;command(0xf2000000,0x0100c000);
    command(0x04000c2f,0x08000300);command(0xbf000000,0x00000204);command(0xbf000000,0x00000204);command(0xb8000000);
    f.bytes.set([0xf8,1,7,0xc1,0,0x3f,0xff,0xff,0x84,0x21,0x84,0x21,0x84,0x21,0x84,0x21],0x380);return {...f,secondLoad,secondSize};};
  const aligned=make(),a=renderModelLists(aligned.read,[{displayList:0x08000200}]),map=a.textures.find(t=>t.id===a.meshes[0].material!.textureId)!;
  assert.equal(a.coverage.textured,2);assert.equal(a.coverage.unsupported,0);assert.equal(a.meshes[0].material!.opacity,127/255);assert.deepEqual([...Buffer.from(map.rgbaBase64,"base64")].slice(0,4),[148,32,48,255]);
  const different=make();different.v.setUint32(different.secondSize,0xf2000004);const b=renderModelLists(different.read,[{displayList:0x08000200}]);assert.equal(b.coverage.textured,2);assert.equal(b.coverage.unsupported,2);assert.match(b.warnings.join(),/unaligned/);
  const missing=make();missing.v.setUint32(missing.secondLoad,0);const c=renderModelLists(missing.read,[{displayList:0x08000200}]);assert.equal(c.coverage.textured,2);assert.equal(c.coverage.unsupported,2);assert.match(c.warnings.join(),/second texture unavailable/);
});
test("local US native actor selectors, integer initial poses and immutable ROM sources",{skip:!process.env.MNSG_TEST_ROM},()=>{
  const rom=importRomBytes(readFileSync(process.env.MNSG_TEST_ROM!)),hash=()=>createHash("sha256").update(rom.bytes).digest("hex"),before=hash();
  const room=rom.loadRoom(465),actor=room.actors.find(a=>a.actorId===0x256)!;
  assert.ok(actor);const original=rom.loadActorVisuals(465),first=original.actorVisuals.find(v=>v.actorRef===actor.id)!;
  assert.equal(first.status,"supported");assert.equal(first.parts[0].provenance.slot,0);
  const edited=rom.loadActorVisuals(465,{[actor.id]:{parameters:[0x01000000,actor.parameters[1],actor.parameters[2]]}}),second=edited.actorVisuals.find(v=>v.actorRef===actor.id)!;
  assert.equal(second.status,"supported");assert.equal(second.parts[0].provenance.slot,1);assert.notEqual(first.parts[0].assetId,second.parts[0].assetId);
  for(const [roomId,actorId,frame] of [[22,0x23a,1],[362,0x3d6,2],[386,0x3d6,2]]){
    const placement=rom.loadRoom(roomId).actors.find(a=>a.actorId===actorId)!;assert.ok(placement);
    const payload=rom.loadActorVisuals(roomId),visual=payload.actorVisuals.find(v=>v.actorRef===placement.id)!;
    assert.ok(visual.parts.length);assert.equal(visual.parts[0].provenance.animationFrame,frame);assert.equal(visual.parts[0].provenance.animationBlendCountdown,0);
    assert.ok(payload.actorModels.find(m=>m.id===visual.parts[0].assetId)!.meshes.length);
  }
  const room0=rom.loadRoom(0),payload=rom.loadActorVisuals(0);assert.equal(payload.actorVisuals.length,room0.actors.length);
  assert.equal(new Set(payload.actorModels.map(m=>m.id)).size,payload.actorModels.length);
  assert.ok(payload.actorVisuals.every(v=>v.parts.every(part=>payload.actorModels.some(model=>model.id===part.assetId))));
  assert.ok(payload.actorModels.every(model=>model.nodes.every((node,index)=>node.parentIndex===null||node.parentIndex<index)));
  assert.ok(rom.listRooms().every(summary=>!("actorModels" in summary)&&!("actorVisuals" in summary)&&!("textures" in summary)));
  assert.throws(()=>rom.loadActorVisuals(465,{[actor.id]:{actorId:0xffff}}));
  let accounted=0,parts=0;for(const summary of rom.listRooms()){
    const native=rom.loadRoom(summary.id),p=rom.loadActorVisuals(summary.id);accounted+=p.actorVisuals.length;
    assert.deepEqual(p.actorVisuals.map(v=>v.actorRef),native.actors.map(a=>a.id));
    for(const visual of p.actorVisuals){assert.ok(["supported","conditional","nonvisual","unsupported"].includes(visual.status));if(visual.status==="nonvisual")assert.equal(visual.parts.length,0);parts+=visual.parts.length;}
    for(const model of p.actorModels){assert.ok(model.meshes.every(m=>m.positions.every(Number.isFinite)));assert.ok(model.textures.every(t=>Buffer.from(t.rgbaBase64,"base64").length===t.width*t.height*4));assert.equal(model.nodes.flatMap(n=>n.meshIndices).length,model.meshes.length);}
  }
  assert.equal(accounted,3888);assert.ok(parts>3700,"Native declarations must be rendered broadly, not a hardcoded subset");
  // Project/preview edits never change bytes used by patch and collision guards.
  assert.equal(rom.geometryTranslation(0,{x:10,y:20,z:30}).spans.length,576);assert.equal(hash(),before);
});
