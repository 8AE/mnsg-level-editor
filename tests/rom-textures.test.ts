import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {decodeTexturePixel,NativeTextureMemory,textureCoordinate} from "../core/rom/textures";
import {decodePic} from "../core/rom/pic";
import {RomReader} from "../core/rom/binary";
import {readFileTable} from "../core/rom/decompress";
import {ImportedRom,importRomBytes} from "../core/rom";
import {decodeRoomGeometry,graphicsLocation,geometryAuxiliaryRecord} from "../core/rom/geometry";
import {renderRoom} from "../core/rom/render";
import type {RenderWaves} from "../core/rom/waves";

const hash=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");
const pixels=(memory:NativeTextureMemory,tlut=0)=>Array.from(Buffer.from(memory.decode(0,tlut).rgbaBase64,"base64"));
function memory(source:Uint8Array) {return new NativeTextureMemory((at,size)=>{if(at<0||at+size>source.length)throw new Error("source bounds");return source.subarray(at,at+size);});}
function tile(memory:NativeTextureMemory,fmt:number,siz:number,width:number,height:number,line=1){Object.assign(memory.tiles[0],{fmt,siz,line,lrs:(width-1)*4,lrt:(height-1)*4});}

test("exact hand-authored RGBA, IA, intensity and TLUT pixel formats",()=>{
  assert.deepEqual(decodeTexturePixel(0,2,[0xf8,1]),[255,0,0,255]);
  assert.deepEqual(decodeTexturePixel(0,2,[7,0xc0]),[0,255,0,0]);
  assert.deepEqual(decodeTexturePixel(0,3,[12,34,56,78]),[12,34,56,78]);
  assert.deepEqual(decodeTexturePixel(3,0,[15]),[255,255,255,255]);
  assert.deepEqual(decodeTexturePixel(3,0,[0]),[0,0,0,0]);
  assert.deepEqual(decodeTexturePixel(3,1,[0xa3]),[170,170,170,51]);
  assert.deepEqual(decodeTexturePixel(3,2,[201,31]),[201,201,201,31]);
  assert.deepEqual(decodeTexturePixel(4,0,[9]),[153,153,153,153]);
  assert.deepEqual(decodeTexturePixel(4,1,[44]),[44,44,44,44]);
  assert.deepEqual(decodeTexturePixel(2,0,[],0x7b25,3),[123,123,123,37]);
  assert.throws(()=>decodeTexturePixel(1,2,[0,0]),/Unsupported/);
});

test("TMEM LOADBLOCK honors load-size reinterpretation, DXT row swap and source bounds",()=>{
  const source=Uint8Array.from([0xf8,1,7,0xc1,0,0x3f,0xff,0xff,0,1,0xff,0xc1,0xf8,0x3f,7,0xff]);
  const m=memory(source);m.setImage(0xfd100003,0);Object.assign(m.tiles[7],{fmt:0,siz:2});
  m.load(0xf3,0,0x07007000|2048);tile(m,0,2,4,2);
  assert.deepEqual(Array.from(m.bytes.slice(8,16)),[0xf8,0x3f,7,0xff,0,1,0xff,0xc1]);
  assert.deepEqual(pixels(m).slice(0,8),[255,0,0,255,0,255,0,255]);
  assert.deepEqual(pixels(m).slice(16,24),[0,0,0,255,255,255,0,255]);
  const four=memory(Uint8Array.from([0x12,0x34,0x56,0x78,0x9a,0xbc,0xde,0xf0]));four.setImage(0xfd100000,0);Object.assign(four.tiles[7],{siz:2});four.load(0xf3,0,0x07003000);tile(four,4,0,16,1);
  assert.deepEqual(pixels(four).slice(0,8),[17,17,17,17,34,34,34,34]);
  const bad=memory(source);bad.setImage(0xfd100003,10);Object.assign(bad.tiles[7],{siz:2});assert.throws(()=>bad.load(0xf3,0,0x07007000),/bounds/);assert.ok(bad.initialized.every(x=>x===0));
});

test("TMEM RGBA32 split banks, LOADTILE stride, CI bank and TLUT replication",()=>{
  const m=memory(Uint8Array.from([10,20,30,40,50,60,70,80]));m.setImage(0xfd180001,0);Object.assign(m.tiles[7],{fmt:0,siz:3});m.load(0xf3,0,0x07001000);tile(m,0,3,2,1);
  assert.deepEqual(pixels(m),[10,20,30,40,50,60,70,80]);assert.deepEqual(Array.from(m.bytes.slice(2048,2052)),[30,40,70,80]);
  const rows=memory(Uint8Array.from({length:16},(_,i)=>i));rows.setImage(0xfd080007,0);Object.assign(rows.tiles[7],{fmt:4,siz:1,line:1});rows.load(0xf4,0,0x0701c004);tile(rows,4,1,8,2);assert.deepEqual(pixels(rows).filter((_,i)=>i%4===0),Array.from({length:16},(_,i)=>i));
  const palette=memory(Uint8Array.from([0xf8,1,7,0xc1]));palette.setImage(0xfd100001,0);Object.assign(palette.tiles[7],{siz:2,tmem:272});palette.load(0xf0,0,0x07004000);tile(palette,2,0,2,1);Object.assign(palette.tiles[0],{palette:1});palette.bytes[0]=1;palette.initialized[0]=1;
  assert.deepEqual(Array.from(palette.bytes.slice(2176,2184)),[0xf8,1,0xf8,1,0xf8,1,0xf8,1]);assert.deepEqual(pixels(palette,2),[255,0,0,255,0,255,0,255]);
  const absent=memory(new Uint8Array());tile(absent,0,2,1,1);assert.throws(()=>absent.decode(0,0),/uninitialized/);
});

test("mask period, clamped mirror folding and filter-aware signed UV sampling",()=>{
  const m=memory(new Uint8Array());tile(m,4,1,4,1);m.bytes.set([10,20,30,40]);m.initialized.fill(1);Object.assign(m.tiles[0],{masks:1});assert.equal(m.decode(0,0).width,2);
  Object.assign(m.tiles[0],{cms:3});assert.equal(m.decode(0,0).width,4);assert.deepEqual(pixels(m).filter((_,i)=>i%4===0),[10,20,20,10]);
  assert.equal(textureCoordinate(.75,0,0,4,"nearest"),.1875);assert.equal(Math.floor(textureCoordinate(.75,0,0,4,"nearest")*4),0);
  assert.equal(textureCoordinate(.75,0,0,4,"linear"),.3125);assert.equal(textureCoordinate(-.25,0,0,4,"nearest"),-.0625);
  assert.equal(textureCoordinate(2,15,4,4,"nearest"),.75);assert.equal(textureCoordinate(8,2,4,4,"nearest"),.25);
});

class BitWriter {bits:number[]=[];write(value:number,count:number){for(let i=count-1;i>=0;i--)this.bits.push((value>>>i)&1);}bytes(){const b=new Uint8Array(Math.ceil(this.bits.length/8));this.bits.forEach((v,i)=>b[i>>>3]|=v<<(7-(i&7)));return b;}}
function picHeader(bpp:number,width:number,height:number){const w=new BitWriter();for(const value of [80,73,67,26,0,0])w.write(value,8);w.write(0,8);w.write(bpp,16);w.write(width,16);w.write(height,16);return w;}
const one=(w:BitWriter)=>w.write(0,2);
test("PIC indexed palette, sparse nibble fill, RGB channel order and bounded errors",()=>{
  const w=picHeader(4,2,1);for(let i=0;i<16;i++){w.write(0,5);w.write(i===1?31:0,5);w.write(i===2?31:0,5);w.write(0,1);}one(w);w.write(1,4);w.write(0,1);one(w);w.write(2,4);w.write(0,1);one(w);
  const decoded=decodePic(w.bytes());assert.equal(decoded.length,40);assert.equal(decoded[0],0x12);assert.equal(new DataView(decoded.buffer).getUint16(10),0xf801);assert.equal(new DataView(decoded.buffer).getUint16(12),0x003f);
  const rgb=picHeader(15,1,1);one(rgb);rgb.write(0,1);rgb.write(31<<5,15);rgb.write(0,1);assert.equal(new DataView(decodePic(rgb.bytes()).buffer).getUint16(0),0xf801);
  assert.throws(()=>decodePic(w.bytes().subarray(0,12)),/Truncated/);assert.throws(()=>decodePic(w.bytes(),16),/allocation/);
});

function renderFixture(){
  const bytes=new Uint8Array(0x600000),v=new DataView(bytes.buffer);[0,300,350,400,540,544,549].forEach((n,i)=>v.setUint16(0x5c610+i*2,n));
  v.setUint32(0x5c57ec,0x801cb460);v.setUint32(0x5c5804,0x801cb860);v.setUint32(0x587370,0x48000020);v.setUint32(0x587378,1);
  const wave=new Uint8Array(1024),d=new DataView(wave.buffer);let at=0x20;const command=(a:number,b=0)=>{d.setUint32(at,a);d.setUint32(at+4,b);at+=8;};
  command(0xfc127e24,0xfffff3f9);command(0xbb000001,0x80008000);command(0xfd100003,0x08000300);command(0xf5100000,0x07000000);command(0xf3000000,0x07003000);command(0xf5100200,0);command(0xf2000000,0x0000c000);command(0x04000c2f,0x08000200);command(0xbf000000,0x00000204);
  command(0xbb000001,0xffffffff);command(0xb7000000,0x20000);command(0xbf000000,0x00000204);command(0xb8000000);
  for(let i=0;i<3;i++){d.setInt16(0x200+i*16,i*10);d.setInt16(0x208+i*16,64);wave.set([255,0,0,255],0x20c+i*16);}wave.set([0xf8,1,7,0xc1,0,0x3f,0xff,0xff],0x300);
  const waves={read:(address:number,size:number)=>wave.subarray(address&0xffffff,(address&0xffffff)+size)} as unknown as RenderWaves;
  return {reader:new RomReader(bytes),waves,wave,files:new Map([[1,{id:1,start:0,end:1024,compressed:false}]])};
}
test("RSP UV scale and lighting interpretation are captured at VTX load",()=>{
  const f=renderFixture(),room=renderRoom(f.reader,0,f.files,()=>8,f.waves);assert.equal(room.complete,true);assert.equal(room.coverage.textured,2);assert.equal(room.coverage.unsupported,0);
  assert.equal(room.meshes[0].material?.vertexColors,true);assert.deepEqual(room.meshes[0].uvs,[.25,0,.25,0,.25,0,.25,0,.25,0,.25,0]);assert.deepEqual(room.meshes[0].colors!.slice(0,3),[1,0,0]);
});

test("verified texture/primitive alpha and color combiners retain native material state",()=>{
  for(const [w0,w1,texture,shade,primitive,opacity] of [
    [0xfc127e24,0xfffff3f9,true,true,false,1],
    [0xfc327fff,0xfffff638,false,true,true,127/255],
    [0xfcffffff,0xfffdfcfe,false,false,true,1],
    [0xfcff97ff,0xff2cfe7f,true,false,false,127/255],
  ] as const){const f=renderFixture(),d=new DataView(f.wave.buffer);d.setUint32(0x20,w0);d.setUint32(0x24,w1);
    // The command after the first triangle supplies primitive state for the second.
    d.setUint32(0x68,0xfa000000);d.setUint32(0x6c,0x2040807f);
    const room=renderRoom(f.reader,0,f.files,()=>8,f.waves),material=room.meshes.at(-1)!.material!;
    assert.equal(!!material.textureId,texture);assert.equal(material.vertexColors,shade);assert.equal(material.opacity,opacity);assert.deepEqual(material.color,primitive?[32/255,64/255,128/255]:[1,1,1]);assert.equal(room.coverage.unsupported,0);
  }
});

test("local US texture census, independent PIC hashes and immutable native source inventory",{skip:!process.env.MNSG_TEST_ROM},()=>{
  const rom=importRomBytes(readFileSync(process.env.MNSG_TEST_ROM!)),before=hash(rom.bytes),r=new RomReader(rom.bytes),files=new Map(readFileTable(rom.bytes).map(f=>[f.id,f]));
  const segment=(id:number)=>{for(let p=0x55510;p<0x55910;p+=4){const upper=r.u16(p);if(!upper)break;if(id<upper)return rom.bytes[p+3];}throw new Error("segment");};
  for(const [id,expected] of [[0x8023,"076077e4f9ef377a32588fc0ed00d44712af577788c36f81e5e3a6329e05b6fa"],[0x8024,"0eaadce12c735955e2ad9bf6cf23db6b35f534532d7100600ae5eb7f3c25d5a0"]] as const){const parent=files.get(137)!,start=parent.start+(r.u32(0x445d4+id*4)&0xffffff),end=parent.start+(r.u32(0x445d4+(id+1)*4)&0xffffff);assert.equal(hash(decodePic(rom.bytes.subarray(start,end))),expected);}
  // Independently decoded native PIC4 resource 0x8137; only its hash is committed.
  const indexed=decodePic(rom.bytes.subarray(11364736,11364736+304));assert.equal(indexed.length,2080);
  assert.equal(hash(indexed),"c8667267bca60ecf245f4e626c1f11182ff530c4926e138d8599f2e6311f6c91");
  const summaries=rom.listRooms();assert.equal(summaries.length,383);assert.ok(summaries.every(s=>!("textures" in s)&&!("meshes" in s)));
  let triangles=0,textured=0,translucent=0,texturedRooms=0;
  for(const summary of summaries){const room=rom.loadRoom(summary.id),location=graphicsLocation(r,room.id);let actual:number[]=[];for(const mesh of room.meshes){triangles+=mesh.indices.length/3;if(mesh.material?.textureId)textured+=mesh.indices.length/3;if((mesh.material?.opacity??1)<1)translucent+=mesh.indices.length/3;actual.push(...mesh.positions);}if(room.textures?.length)texturedRooms++;
    assert.ok(!room.warnings.some(w=>/Texture unavailable|Texture load failed|Unsupported native|Partial texture|Texture preview failed/.test(w)),`${room.id}: ${room.warnings.join("; ")}`);
    if(location){const base=decodeRoomGeometry(r,location.record,files,segment),secondary=geometryAuxiliaryRecord(r,0x5c5804,location.group,location.index,8),extra=decodeRoomGeometry(r,location.record,files,segment,{model:r.u32(secondary),strict:true});assert.deepEqual(actual,[...base.meshes,...extra.meshes].flatMap(m=>m.indices.flatMap(index=>m.positions.slice(index*3,index*3+3))),`room ${room.id} geometry`);}}
  assert.equal(triangles,118110);assert.equal(texturedRooms,378);assert.equal(translucent,79);assert.equal(textured,114137);
  const operation=rom.geometryTranslation(0,{x:10,y:20,z:30});assert.equal(operation.spans.length,576);assert.equal(operation.guards.length,945);assert.equal(hash(rom.bytes),before);
  for(const id of [0,48,465]){const room=rom.loadRoom(id);assert.ok(room.textures!.length>10);assert.ok(room.textures!.some(t=>new Set(Buffer.from(t.rgbaBase64,"base64")).size>20));}
  const fallback=new ImportedRom(rom.bytes,rom.identity);
  (fallback as unknown as {renderWaves:RenderWaves}).renderWaves.read=()=>{throw new Error("Injected presentation failure");};
  const room=fallback.loadRoom(0),location=graphicsLocation(r,0)!;
  assert.match(room.warnings.join("; "),/Texture preview failed/);assert.deepEqual(room.textures,[]);
  assert.deepEqual(room.meshes,decodeRoomGeometry(r,location.record,files,segment).meshes);
  assert.equal(room.geometryEdit?.supported,true);assert.equal(hash(rom.bytes),before);
});
