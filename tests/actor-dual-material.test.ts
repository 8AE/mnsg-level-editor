import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {NativeTextureMemory} from "../core/rom/textures";
import {renderModelLists} from "../core/rom/render";
import {importRomBytes} from "../core/rom";
import {decodePic} from "../core/rom/pic";

const hash=(bytes:Uint8Array|string)=>createHash("sha256").update(bytes).digest("hex");
const pixels=(image:{rgbaBase64:string})=>Buffer.from(image.rgbaBase64,"base64");
const header=[[0xba001402,0x100000],[0xba000c02,0x2000],[0xba000e02,0],[0xba001001,0],[0xba001102,0],[0xb9000002,1],[0xb7000000,0x204],[0xbb000001,0x80008000]];
// The17 verified26FE8 commands, including its nested baseline.
const nativeMaterial=[[0x06000000,0x8006dee0],[0xfc111404,0xfffffffb],[0xfa000000,0x000000d0],
  [0xfd100000,0x09000000],[0xf5100000,0x07014060],[0xe6000000,0],[0xf3000000,0x077ff080],
  [0xe7000000,0],[0xf5102000,0x00014060],[0xf2000005,0x000fc07c],
  [0xfd100000,0x09000000],[0xf5100100,0x07014060],[0xe6000000,0],[0xf3000000,0x077ff080],
  [0xe7000000,0],[0xf5102100,0x01014060],[0xf201e000,0x010fc07c]];

function source(opaque=true){const bytes=new Uint8Array(4096);for(let y=0;y<32;y++)for(let x=0;x<64;x++){
  const word=(((x+3*y)&31)<<11)|(((3*x+y)&31)<<6)|(((x+7*y)&31)<<1)|Number(opaque||(x+y)%3!==0),at=(y*64+x)*2;
  bytes[at]=word>>>8;bytes[at+1]=word&255;
}return bytes;}
function rgba(bytes:Uint8Array){const output=new Uint8Array(8192),expand=(n:number)=>(n<<3)|(n>>>2);for(let i=0;i<2048;i++){
  const word=(bytes[i*2]<<8)|bytes[i*2+1];output.set([expand(word>>>11),expand((word>>>6)&31),expand((word>>>1)&31),(word&1)?255:0],i*4);
}return output;}
function memory(image:Uint8Array){const m=new NativeTextureMemory((address,size)=>{const at=address-0x09000000;assert.ok(at>=0&&at+size<=image.length);return image.subarray(at,at+size);});
  let first:Uint8Array|undefined;for(const [w0,w1] of nativeMaterial){const op=w0>>>24;
    if(op===0xfd)m.setImage(w0,w1);else if(op===0xf5)m.setTile(w0,w1);else if(op===0xf2)m.setTileSize(w0,w1);else if(op===0xf3){m.load(op,w0,w1);first??=m.bytes.slice();}}
  return {m,first:first!};}
function fixture(options:{image?:Uint8Array;prefix?:number[][];material?:number[][];tail?:number[][];beforeVtx?:number[][];rom?:Uint8Array}={}){
  const image=options.image??source(),bytes=new Uint8Array(0x9000),v=new DataView(bytes.buffer);let at=0x1000;
  const commands=[...(options.prefix??header),...(options.material??nativeMaterial.slice(1)),...(options.beforeVtx??[]),[0x04000c2f,0x08008000],...(options.tail??[]),[0xbf000000,0x00000204],[0xb8000000,0]];
  for(const [w0,w1] of commands){v.setUint32(at,w0);v.setUint32(at+4,w1);at+=8;}
  for(let i=0;i<3;i++){v.setInt16(0x8000+i*16,i*10);v.setInt16(0x8008+i*16,512+i*64);v.setInt16(0x800a+i*16,256-i*128);bytes.set([128,64,192,7],0x800c+i*16);}
  const read=(address:number,size:number)=>{
    if(address>=0x80000000){assert.ok(options.rom);const at=address-0x80000000+0xc00;assert.ok(at>=0&&at+size<=options.rom.length);return options.rom.subarray(at,at+size);}
    if(address>>>24===9){const at=address&0xffffff;assert.ok(at+size<=image.length);return image.subarray(at,at+size);}
    assert.equal(address>>>24,8);const at=address&0xffffff;assert.ok(at+size<=bytes.length);return bytes.subarray(at,at+size);
  };
  return {image,bytes,read,roots:[{displayList:0x08001000}]};
}
function rejected(f:ReturnType<typeof fixture>){const before=hash(f.image),r=renderModelLists(f.read,f.roots);
  assert.equal(r.coverage.textured,0);assert.equal(r.coverage.untextured,1);assert.equal(r.coverage.unsupported,1);
  assert.equal(r.meshes[0].material!.textureId,undefined);assert.equal(r.meshes[0].material!.dualTexture,undefined);
  assert.equal(r.meshes[0].uvs,undefined);assert.equal(r.meshes[0].secondaryUvs,undefined);assert.equal(hash(f.image),before);return r;
}

test("ordered dual LOADBLOCKs retain complete4KiB swizzle/wrap and distinct source-preserving sampling identities",()=>{
  const image=source(),before=hash(image),{m,first}=memory(image),expected=new Uint8Array(4096);
  for(let y=0;y<32;y++)for(let x=0;x<128;x++)expected[((2048+y*128+x)^((y&1)?4:0))&4095]=image[y*128+x];
  assert.deepEqual(m.bytes,expected);assert.ok(m.initialized.every(v=>v===1));assert.notEqual(hash(first),hash(m.bytes));
  const original=rgba(image),tile0=m.decode(0,0),tile1=m.decode(1,0);
  assert.notEqual(tile0.id,tile1.id);assert.deepEqual(pixels(tile1),Buffer.from(original));
  for(let y=0;y<32;y++)assert.deepEqual(pixels(tile0).subarray(y*256,(y+1)*256),Buffer.from(original).subarray(((y+16)%32)*256,((y+16)%32+1)*256));
  assert.deepEqual([tile0.width,tile0.height,tile1.width,tile1.height],[64,32,64,32]);
  assert.deepEqual([m.tiles[0].uls,m.tiles[0].ult,m.tiles[1].uls,m.tiles[1].ult],[0,5,30,0]);assert.equal(hash(image),before);
});

test("fractional quarter origins select nonclamped mask periods only, preserving clamped/unmasked bound rejection",()=>{
  const {m}=memory(source()),before=JSON.stringify(m.tiles);assert.equal(m.decode(0,0).height,32);assert.equal(m.decode(1,0).width,64);assert.equal(JSON.stringify(m.tiles),before);
  for(const [index,field,value] of [[0,"maskt",0],[0,"cmt",2],[1,"masks",0],[1,"cms",2],[0,"ult",125],[1,"uls",253],[1,"uls",NaN],[1,"lrs",4096]] as const){
    const {m}=memory(source());Object.assign(m.tiles[index],{[field]:value});assert.throws(()=>m.decode(index,0),/invalid or fractional/);
  }
  const clamped=memory(source()).m;clamped.tiles[0].ult=0;clamped.tiles[0].cmt=2;
  assert.equal(clamped.decode(0,0).height,32,"ordinary integer clamped extents retain existing behavior");
});

test("exact two-cycle mux emits two independent UV arrays, opacityPRIM_A and opaque first-cycle proof",()=>{
  const f=fixture({tail:[[0xbb000001,0xffffffff]]}),before=hash(f.bytes),sourceBefore=hash(f.image),r=renderModelLists(f.read,f.roots),mesh=r.meshes[0],material=mesh.material!;
  assert.equal(r.complete,true);assert.deepEqual(r.coverage,{triangles:1,textured:1,untextured:0,unsupported:0,formats:{RGBA16:1}});assert.equal(r.textures.length,2);
  assert.deepEqual(material.dualTexture,{textureId:r.textures[1].id,wrapS:"repeat",wrapT:"repeat",filter:"linear",mode:"multiply-shade-primitive-alpha",opaqueFirstCycle:true});
  assert.equal(material.textureId,r.textures[0].id);assert.equal(material.opacity,208/255);assert.equal(material.alphaTest,0);assert.deepEqual(material.color,[1,1,1]);
  assert.equal(material.vertexColors,true);assert.equal(material.lighting,false);assert.deepEqual(mesh.colors!.slice(0,3),[128/255,64/255,192/255]);
  assert.deepEqual(mesh.uvs,[8.5/64,3.25/32,9.5/64,1.25/32,10.5/64,-.75/32]);
  assert.deepEqual(mesh.secondaryUvs,[1/64,4.5/32,2/64,2.5/32,3/64,.5/32]);
  assert.equal(hash(f.bytes),before);assert.equal(hash(f.image),sourceBefore);
  // Literal SDK/RT64 equations, independent of renderer implementation.
  const t0=[.25,.5,.75,1],t1=[.8,.4,.2,1],shade=[.6,.3,.9,.1];
  const expected=[.12,.06,.135];for(let i=0;i<3;i++)assert.ok(Math.abs(t0[i]*t1[i]*shade[i]-expected[i])<1e-12);
  assert.equal(t0[3]*t1[3],1);assert.equal(material.opacity,208/255,"neither texture/shade alpha nor unused primitiveRGB multiplies final alpha");
});

test("independent shifts/samplers and quarter origins are captured per tile after VTX scale",()=>{
  const changed=nativeMaterial.slice(1).map(pair=>[...pair]);changed[14][1]=0x0101416f; // tile1 mirrorS, shiftS15
  const r=renderModelLists(fixture({material:changed}).read,fixture({material:changed}).roots),m=r.meshes[0];
  assert.equal(r.coverage.textured,1);assert.equal(m.material!.dualTexture!.wrapS,"mirror");
  assert.deepEqual(m.secondaryUvs,[9/64,4.5/32,11/64,2.5/32,13/64,.5/32]);
  assert.deepEqual(m.uvs,[8.5/64,3.25/32,9.5/64,1.25/32,10.5/64,-.75/32]);
});

test("both images must be opaque; first-cycle comparison cannot be replaced by post-primitive alpha",()=>{
  const r=rejected(fixture({image:source(false)}));assert.match(r.warnings.join(" "),/first-cycle alpha is not proven opaque/);
  const firstAlpha=0*1,finalAlpha=208/255;assert.ok(firstAlpha<.25&&finalAlpha>=.25);
  for(const threshold of [0,128,255]){const r=renderModelLists(fixture({tail:[[0xf9000000,threshold]]}).read,fixture().roots);
    assert.equal(r.coverage.textured,1);assert.equal(r.meshes[0].material!.alphaTest,0,"opaque first-cycle alpha1 passes every legal threshold including equality1");}
});

test("dual shading requires smooth mode at triangle draw, including changes before and after VTX",()=>{
  for(const options of [{prefix:header.map((pair,i)=>i===6?[0xb7000000,4]:pair)},
    {beforeVtx:[[0xb6000000,0x200]]},{tail:[[0xb6000000,0x200]]}]){
    const f=fixture(options);
    // Nonuniform native shade colors distinguish a smooth interpolant from
    // the flat/provoking-vertex result that this new material cannot render.
    [[255,0,0,19],[0,255,0,37],[0,0,255,53]].forEach((color,i)=>f.bytes.set(color,0x800c+i*16));
    const r=rejected(f);assert.match(r.warnings.join(" "),/flat/);
  }
  const restored=fixture({tail:[[0xb6000000,0x200],[0xb7000000,0x200]]});
  assert.equal(renderModelLists(restored.read,restored.roots).coverage.textured,1,"effective draw state, not the earlier vertex-load state, establishes smooth shading");
});

test("dual appearance rejects incomplete/inherited/overwritten modes, wrong muxes, primitive/shade holes and unsupported state",()=>{
  for(const missing of [0,1,2,3,4,5])rejected(fixture({prefix:header.filter((_,i)=>i!==missing)}));
  for(const [index,partial] of [[0,[0xba001401,0x100000]],[1,[0xba000c01,0]],[2,[0xba000e01,0]],[4,[0xba001101,0]],[5,[0xb9000001,1]]] as const){
    rejected(fixture({prefix:header.map((pair,i)=>i===index?[...partial]:pair)}));
  }
  for(const writes of [[[0xef100000,0],[0xba001402,0x100000]],[[0xba001402,0]],[[0xba001402,0x200000]],[[0xba001402,0x300000]],
    [[0xba001501,0x200000]],[[0xba000c02,0x3000]],[[0xba000c02,0x1000]],[[0xba000e02,0x8000]],[[0xba001001,0x10000]],[[0xba001102,0x20000]],[[0xb9000002,3]],[[0xb9000002,2]],[[0x99000000,0]]])rejected(fixture({beforeVtx:writes}));
  rejected(fixture({material:nativeMaterial.slice(1).filter((_,i)=>i!==1)})); // noPRIM command
  rejected(fixture({prefix:header.filter((_,i)=>i!==6)})); // noG_SHADE atVTX
  rejected(fixture({beforeVtx:[[0xb7000000,0x60000]]})); // generated coordinates
  rejected(fixture({beforeVtx:[[0xbb000000,0x80008000]]}));
  rejected(fixture({tail:[[0xfc111404,0xfffffffa]]}));
  const badFormat=nativeMaterial.slice(1).map(pair=>[...pair]);badFormat[14][0]=0xf5582100;rejected(fixture({material:badFormat}));
  const noTexture=fixture({image:new Uint8Array()});rejected(noTexture);
});

test("changed secondary origins/images/samplers split batches and retain independent immutable fingerprints",()=>{
  const first=fixture({tail:[[0xbf000000,0x00000204],[0xf201f000,0x010fc07c]]}),r=renderModelLists(first.read,first.roots);
  assert.equal(r.coverage.textured,2);assert.equal(r.meshes.length,2);assert.deepEqual(r.meshes[0].positions,r.meshes[1].positions);
  assert.equal(r.meshes[0].material!.textureId,r.meshes[1].material!.textureId);assert.deepEqual(r.meshes[0].uvs,r.meshes[1].uvs);
  assert.notDeepEqual(r.meshes[0].secondaryUvs,r.meshes[1].secondaryUvs);assert.notEqual(hash(JSON.stringify(r.meshes[0])),hash(JSON.stringify(r.meshes[1])));
  const imagesBefore=r.textures.map(t=>t.rgbaBase64),again=renderModelLists(first.read,first.roots);assert.deepEqual(again.textures.map(t=>t.rgbaBase64),imagesBefore);
  const sampler=fixture({tail:[[0xbf000000,0x00000204],[0xf5102100,0x01014160]]}),s=renderModelLists(sampler.read,sampler.roots);
  assert.equal(s.meshes.length,2);assert.notEqual(s.meshes[0].material!.dualTexture!.wrapS,s.meshes[1].material!.dualTexture!.wrapS);
  const image=fixture({tail:[[0xbf000000,0x00000204],[0xf5102000,0x01014060]]}),changed=renderModelLists(image.read,image.roots);
  assert.equal(changed.meshes.length,2);assert.deepEqual(changed.meshes[0].positions,changed.meshes[1].positions);
  assert.equal(changed.meshes[0].material!.textureId,changed.meshes[1].material!.textureId);
  assert.notEqual(changed.meshes[0].material!.dualTexture!.textureId,changed.meshes[1].material!.dualTexture!.textureId,"only secondary TMEM image changes its identity");
});

test("actual native26FE8 commands/PIC82DF and nested baseline support dual material on an explicitly synthetic triangle",{skip:!process.env.MNSG_TEST_ROM},()=>{
  const rom=importRomBytes(readFileSync(process.env.MNSG_TEST_ROM!)),before=hash(rom.bytes),image=decodePic(rom.bytes.subarray(0xf6f6d0,0xf6fb80));
  assert.equal(hash(image),"2f9d635c2372c6a989e4efe735e1acdb6769af60b2d1f207730eb39fb0e38b0f");
  const f=fixture({image,rom:rom.bytes,prefix:[],material:nativeMaterial}),r=renderModelLists(f.read,f.roots,0,undefined,{materialProvenance:true});
  assert.equal(r.complete,true);assert.equal(r.coverage.textured,1);assert.equal(r.coverage.unsupported,0);
  assert.equal((r.materialStates![0].otherH>>>20)&3,1);assert.equal(r.materialStates![0].otherL&3,1);
  assert.equal(hash(pixels(r.textures[0])),"14aa15262d24fc040e2db60182f8e566e493b300cc4a2efa03406e9e8e012999");
  assert.equal(hash(pixels(r.textures[1])),"34db7d1a814fc45a75383471eeabe6b9426cda0c1574ac83e0c5b739e5da1714");
  assert.equal(r.meshes[0].material!.opacity,208/255);assert.equal(r.meshes[0].material!.lighting,true);assert.equal(r.meshes[0].secondaryUvs!.length,6);
  assert.equal(hash(rom.bytes),before);assert.equal(hash(image),"2f9d635c2372c6a989e4efe735e1acdb6769af60b2d1f207730eb39fb0e38b0f");
});
