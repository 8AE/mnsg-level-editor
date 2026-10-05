import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {renderModelLists} from "../core/rom/render";
import {importRomBytes,readFileTable} from "../core/rom";
import {RomReader} from "../core/rom/binary";
import {RenderWaves} from "../core/rom/waves";
import {ActorVisuals} from "../core/rom/actors";
import type {ProceduralActorPreviewResult} from "../core/rom/actor-init-procedural-preview";
import {decodeTexturePixel} from "../core/rom/textures";

const hash=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");
const pixelBytes=(texture:{rgbaBase64:string})=>Buffer.from(texture.rgbaBase64,"base64");

function fixture(cycleCommands:number[][]=[[0xba001402,0]],mux=0xfffff7fb,primitive=0x10206080){
  const bytes=new Uint8Array(0x500),view=new DataView(bytes.buffer);let offset=0x20;
  const commands=[...cycleCommands,[0xfc127e24,mux],[0xfa000000,primitive],
    [0xbb000001,0x80008000],[0xfd100003,0x08000300],[0xf5100000,0x07000000],
    [0xf3000000,0x07003000],[0xf5100200,0],[0xf2000000,0x0000c000],
    [0x04000c2f,0x08000200],[0xbf000000,0x00000204],[0xb8000000,0]];
  for(const [w0,w1] of commands){view.setUint32(offset,w0);view.setUint32(offset+4,w1);offset+=8;}
  for(let i=0;i<3;i++){
    view.setInt16(0x200+i*16,i*10);view.setInt16(0x208+i*16,32*i);
    bytes.set([128,64,192,7],0x20c+i*16);
  }
  // Same non-white RGB with alpha0/1, plus two contrasting texels.
  bytes.set([0x82,0x08,0x82,0x09,0xf8,1,0x07,0xc0],0x300);
  const read=(address:number,size:number)=>{const at=address&0xffffff;assert.ok(at+size<=bytes.length);return bytes.subarray(at,at+size);};
  return {bytes,read,roots:[{displayList:0x08000020}]};
}

test("07D exact one-cycle mux preserves native RGB/shade and uses PRIM_A independently of texture/shade alpha",()=>{
  const f=fixture(),before=hash(f.bytes),result=renderModelLists(f.read,f.roots),mesh=result.meshes[0],material=mesh.material!;
  assert.equal(result.complete,true);assert.deepEqual(result.coverage,{triangles:1,textured:1,untextured:0,unsupported:0,formats:{RGBA16:1}});
  const source=result.textures.find(t=>!t.id.endsWith(":native-primitive-alpha"))!,mapped=result.textures.find(t=>t.id===material.textureId)!;
  assert.equal(mapped.id,`${source.id}:native-primitive-alpha`);assert.equal(source.width,4);assert.equal(source.height,1);
  assert.deepEqual([...pixelBytes(source)],[132,66,33,0,132,66,33,255,255,0,0,255,0,255,0,0]);
  assert.deepEqual([...pixelBytes(mapped)],[132,66,33,255,132,66,33,255,255,0,0,255,0,255,0,255]);
  assert.deepEqual(material.color,[1,1,1],"primitive RGB is absent from the RGB mux");
  assert.deepEqual(mesh.colors,[128/255,64/255,192/255,128/255,64/255,192/255,128/255,64/255,192/255]);
  assert.equal(material.vertexColors,true);assert.equal(material.lighting,false);assert.equal(material.opacity,128/255);assert.equal(material.alphaTest,0);
  // Independent SDK equation: RGB=(TEXEL0-0)*SHADE; A=PRIM_A.
  // Both source alpha extremes must give the same output alpha, not 0 or SHADE_A=7.
  for(const at of [0,4]){
    const mappedPixel=pixelBytes(mapped).subarray(at,at+4);
    const expected=[132*128/255,66*64/255,33*192/255];
    for(let channel=0;channel<3;channel++)assert.ok(Math.abs(mappedPixel[channel]*mesh.colors![channel]-expected[channel])<1e-12);
    assert.equal(mappedPixel[3]*material.opacity,128);
  }
  assert.deepEqual(mesh.uvs,[0,0,.125,0,.25,0]);assert.equal(hash(f.bytes),before);
});

test("procedural mux requires both explicit cycle bits and rejects two-cycle/copy/fill without remapping source alpha",()=>{
  for(const commands of [[],[[0xba001401,0]],[[0xba001501,0]],[[0xba001402,1<<20]],[[0xba001402,2<<20]],[[0xba001402,3<<20]],[[0xba001402,0],[0xef100000,0]]]){
    const f=fixture(commands),r=renderModelLists(f.read,f.roots);
    assert.equal(r.coverage.textured,0);assert.equal(r.coverage.untextured,1);assert.equal(r.coverage.unsupported,1);
    assert.equal(r.meshes[0].material!.textureId,undefined);assert.deepEqual(r.textures,[]);
    assert.match(r.warnings.join(" "),/combiner cycle type/);
  }
  const partials=fixture([[0xba001401,0],[0xba001501,0]]);
  assert.equal(renderModelLists(partials.read,partials.roots).coverage.textured,1,"both explicitly written bits establish the effective cycle");
  const overwritten=fixture([[0xba001402,0],[0xba001501,1<<21]]);
  assert.equal(renderModelLists(overwritten.read,overwritten.roots).coverage.textured,0,"a later partial write must change the effective cycle");
  const reestablished=fixture([[0xef100000,0],[0xba001402,0]]);
  assert.equal(renderModelLists(reestablished.read,reestablished.roots).coverage.textured,1,"explicit bits after an undecoded full write establish a fresh proof");
});

test("nested native baseline establishes cycle; adjacent known and unknown muxes retain previous source-alpha behavior",()=>{
  const f=fixture([]),v=new DataView(f.bytes.buffer);
  // A real nested DL call, not renderer initial-state defaults.
  v.setUint32(0x20,0x06000000);v.setUint32(0x24,0x08000400);
  v.setUint32(0x400,0xba001402);v.setUint32(0x404,0);v.setUint32(0x408,0xb8000000);
  // Move displaced SETCOMBINE to immediately after the call.
  v.setUint32(0x28,0xfc127e24);v.setUint32(0x2c,0xfffff7fb);
  assert.equal(renderModelLists(f.read,f.roots).coverage.textured,1);
  const adjacent=fixture([],0xfffff3f9),r=renderModelLists(adjacent.read,adjacent.roots);
  assert.equal(r.coverage.textured,1);assert.equal(r.textures.length,1);assert.equal(r.meshes[0].material!.opacity,1);
  assert.ok(!r.meshes[0].material!.textureId!.endsWith(":native-primitive-alpha"));assert.equal(pixelBytes(r.textures[0])[3],0);
  const unknown=fixture([[0xba001402,0]],0xfffff7fa);
  assert.equal(renderModelLists(unknown.read,unknown.roots).coverage.textured,0);
  for(const alpha of [0,255]){
    const input=fixture(undefined,0xfffff7fb,0xff402000|alpha),preview=renderModelLists(input.read,input.roots);
    assert.equal(preview.meshes[0].material!.opacity,alpha/255);assert.deepEqual(preview.meshes[0].material!.color,[1,1,1]);
  }
});

test("primitive-alpha variants are reused across opacity changes without leaking into the adjacent texture-alpha mux",()=>{
  const f=fixture(),view=new DataView(f.bytes.buffer);let at=0x20+11*8;
  assert.equal(view.getUint32(at),0xb8000000);
  const command=(w0:number,w1=0)=>{view.setUint32(at,w0);view.setUint32(at+4,w1);at+=8;};
  // Replace the first END with another primitive state/triangle, then a
  // known adjacent combiner sharing the same TMEM and cached VTX records.
  command(0xfa000000,0xffa0c040);command(0xbf000000,0x00000204);
  command(0xfc127e24,0xfffff3f9);command(0xbf000000,0x00000204);command(0xb8000000);
  const r=renderModelLists(f.read,f.roots);
  assert.equal(r.coverage.textured,3);assert.equal(r.coverage.unsupported,0);assert.equal(r.textures.length,2);
  assert.deepEqual(r.meshes.map(m=>m.material!.opacity),[128/255,64/255,1]);
  assert.equal(r.meshes[0].material!.textureId,r.meshes[1].material!.textureId);
  const source=r.textures.find(t=>!t.id.endsWith(":native-primitive-alpha"))!;
  assert.equal(r.meshes[2].material!.textureId,source.id);assert.equal(pixelBytes(source)[3],0);
  assert.deepEqual(r.meshes.map(m=>m.uvs),Array(3).fill([0,0,.125,0,.25,0]));
});

test("actual initial07D exposes392 mapped triangles and keeps PIC8679 source pixels distinct from opaque-alpha render variant",{skip:!process.env.MNSG_TEST_ROM},()=>{
  const rom=importRomBytes(readFileSync(process.env.MNSG_TEST_ROM!)),before=hash(rom.bytes),reader=new RomReader(rom.bytes),files=new Map(readFileTable(rom.bytes).map(file=>[file.id,file]));
  const waves=new RenderWaves(reader,files,id=>{for(let at=0x55510;at<0x556c4;at+=4){const upper=reader.u16(at);if(id<upper)return reader.bytes[at+3];}throw Error("No native segment");});
  const raw=waves.wave(0x4cd).subarray(0x1d10,0x2d10),rawBefore=hash(raw);
  assert.equal(rawBefore,"d9d3c21703510cd691cf386c9990a3db0870e164ff048455a3a5f21e931b7f8b");
  const service=new ActorVisuals(reader,files,waves),input={actorId:0x7d,parameters:[0,0,0],position:{x:12,y:34,z:56},rotation:{x:7,y:8,z:9}},inputBefore=JSON.stringify(input),payload=service.preview(input,"procedural:07d");
  const init=service.resolveNative(input) as ProceduralActorPreviewResult;
  assert.equal(init.completed,false);assert.ok(init.setupEvidence);
  const pointer=(init.bindings[0].materialPointer&0x8fffffff)>>>0,span=init.syntheticMemory.find(s=>pointer>=s.address&&pointer+104<=s.address+s.bytes.length)!;
  assert.ok(span);const commands=new DataView(span.bytes.buffer,span.bytes.byteOffset+pointer-span.address,104);
  assert.equal(commands.getUint32(0),0xe7000000);assert.equal(commands.getUint32(4),0);
  assert.equal(commands.getUint32(8),0x06000000);assert.equal(commands.getUint32(12),0x8006d198);
  assert.equal(reader.u32(0x6dda0),0xba001402);assert.equal(reader.u32(0x6dda4),0,"nested native baseline explicitly sets one-cycle");
  assert.equal(commands.getUint32(9*8),0xf2000000);assert.equal(commands.getUint32(9*8+4),0x000fc07c,"native directRGBA extent64x32 precedes mask-period expansion");
  assert.equal(commands.getUint32(12*8),0xfc127e24);assert.equal(commands.getUint32(12*8+4),0xfffff7fb);
  assert.equal(payload.actorVisuals[0].status,"conditional");assert.equal(payload.actorVisuals[0].parts.length,1);
  const models=payload.actorModels,meshes=models.flatMap(model=>model.meshes),textures=models.flatMap(model=>model.textures);
  assert.equal(meshes.reduce((n,m)=>n+m.indices.length/3,0),392);assert.equal(meshes.filter(m=>m.material?.textureId).reduce((n,m)=>n+m.indices.length/3,0),392);
  assert.ok(meshes.every(m=>m.uvs?.length===m.positions.length/3*2&&m.uvs.every(Number.isFinite)&&m.material!.opacity===128/255&&m.material!.lighting));
  assert.ok(!models.some(m=>m.warnings.some(w=>/Unsupported native color combiner|combiner cycle type/.test(w))));
  const source=textures.find(t=>!t.id.endsWith(":native-primitive-alpha"))!,variant=textures.find(t=>t.id===meshes[0].material!.textureId)!;
  assert.equal(source.width,64);assert.equal(source.height,64);assert.equal(source.format,"RGBA16");assert.equal(variant.id,`${source.id}:native-primitive-alpha`);
  // Native maskS/maskT6 expose a64x64 sampling period; the4096-byte
  // RGBA5551 source occupies64x32 and TMEM wraps the next32rows.
  const decoded=new Uint8Array(64*64*4);for(let i=0;i<64*64;i++){const at=(i%(64*32))*2;decoded.set(decodeTexturePixel(0,2,[raw[at],raw[at+1]]),i*4);}
  assert.deepEqual(pixelBytes(source),Buffer.from(decoded));
  const original=pixelBytes(source),mapped=pixelBytes(variant);
  assert.ok(original.every((value,i)=>i%4!==3||value===255),"this native initial bitmap is already opaque; synthetic alpha0/1 fixtures prove the distinction");
  for(let i=0;i<mapped.length;i++)assert.equal(mapped[i],i%4===3?255:original[i]);
  console.log(`Native07D material: ${JSON.stringify({triangles:392,mapped:392,opacity:128/255,rawSourceSha256:rawBefore,source:{id:source.id,width:source.width,height:source.height,rgbaSha256:hash(original)},renderVariant:{id:variant.id,rgbaSha256:hash(mapped)}})}`);
  assert.equal(hash(rom.bytes),before);assert.equal(hash(raw),rawBefore);assert.equal(JSON.stringify(input),inputBefore);
  assert.equal(service.dependencies(input).completed,false,"decoded material is not a claim of lifecycle completion or export admission");
});
