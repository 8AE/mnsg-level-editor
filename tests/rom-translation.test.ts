import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {RomReader} from "../core/rom/binary";
import {GeometryTranslations,extractCollision,translatePlaneDistance} from "../core/rom/translation";
import {importRomBytes} from "../core/rom";
import type {RomFile} from "../core/rom/decompress";
import type {Vec3} from "../shared/types";

function fixture() {
  const bytes=new Uint8Array(0x700800),view=new DataView(bytes.buffer),reader=new RomReader(bytes);
  const file:RomFile={id:1,start:0x700000,end:bytes.length,compressed:false};
  const files=new Map([[1,file]]);
  [0,300,350,400,540,544,549,561,588,607,613,618,619,620].forEach((n,i)=>view.setUint16(0x5c610+i*2,n));
  const primary:number[]=[],secondary:number[]=[],planes:number[]=[],trees:number[]=[];
  for(let group=0;group<6;group++) {
    const offset=0x1000+group*0x4000,base=0x587370+offset;
    for(const [table,delta] of [[0x5c57ec,0],[0x5c5804,0x800],[0x5c5834,0xc00],[0x5c584c,0xe00]])view.setUint32(table+group*4,0x801cb460+offset+delta);
    primary.push(base);secondary.push(base+0x800);planes.push(base+0xc00);trees.push(base+0xe00);
  }
  for(const room of [0,1]) {
    const record=primary[0]+room*20;
    view.setUint32(record,0x48000020);view.setUint32(record+8,1);
    view.setUint32(secondary[0]+room*8,0x48000060);
    view.setUint32(planes[0]+room*4,0x08000180);view.setUint32(trees[0]+room*4,0x08000200);
  }
  for(const root of [0x20,0x60]) {
    view.setUint32(file.start+root,0x04000c2f);view.setUint32(file.start+root+4,0x08000080);
    view.setUint32(file.start+root+8,0xbf000000);view.setUint32(file.start+root+12,0x00000204);
    view.setUint32(file.start+root+16,0xb8000000);
  }
  for(let index=0;index<3;index++) {
    view.setInt16(file.start+0x80+index*16,index*10);
    view.setInt16(file.start+0x82+index*16,20-index*10);
    view.setInt16(file.start+0x84+index*16,-index*10);
  }
  view.setFloat32(file.start+0x180,1);view.setFloat32(file.start+0x18c,-10);
  view.setUint16(file.start+0x200,0xffff);view.setUint16(file.start+0x202,7);
  for(let i=0;i<3;i++){view.setInt16(file.start+0x206+i*2,100);view.setInt16(file.start+0x20c+i*2,-100);}
  // Root slot 3 points to plane 0 and two terminal children.
  const database=new GeometryTranslations(reader,files,()=>8);
  return {bytes,view,reader,file,files,primary,secondary,planes,trees,database};
}

test("translation moves unique vertices from both roots, planes and cell bounds",()=>{
  const f=fixture(),summary=f.database.summary(0);
  assert.equal(summary.supported,true);assert.equal(summary.vertexCount,3);assert.equal(summary.planeCount,1);assert.equal(summary.cellCount,1);
  assert.deepEqual(summary.affectedRoomIds,[0,1]);
  const operation=f.database.translation(0,{x:10,y:20,z:-30});
  assert.equal(operation.spans.length,5);assert.equal(new Set(operation.spans.map(s=>s.romOffset)).size,5);
  const first=Buffer.from(operation.spans.find(s=>s.kind==="vertexXYZ")!.replacementHex,"hex");
  assert.deepEqual([first.readInt16BE(0),first.readInt16BE(2),first.readInt16BE(4)],[10,40,-30]);
  assert.equal(Buffer.from(operation.spans.find(s=>s.kind==="planeDistance")!.replacementHex,"hex").readFloatBE(),-20);
  const cell=Buffer.from(operation.spans.find(s=>s.kind==="cellBounds")!.replacementHex,"hex");
  assert.deepEqual(Array.from({length:6},(_,i)=>cell.readInt16BE(i*2)),[110,120,70,-90,-80,-130]);
  assert.ok(operation.guards.some(g=>g.kind==="displayCommand"&&g.romOffset===f.file.start+0x60));
  assert.ok(operation.guards.some(g=>g.kind==="planeNormal"));
  assert.deepEqual(f.database.translation(0,{x:10,y:20,z:-30}),operation);
  assert.equal(f.view.getInt16(f.file.start+0x80),0,"source ROM remains unmodified");
  assert.deepEqual(f.database.translation(0,{x:0,y:0,z:0}).spans,[]);
});

test("plane translation preserves the native plane equation within f32 rounding",()=>{
  const normal={x:Math.fround(0.3),y:Math.fround(0.5),z:Math.fround(-0.8)},translation={x:11,y:-22,z:33},point={x:3,y:4,z:5},distance=Math.fround(12.25);
  const moved=translatePlaneDistance(distance,normal,translation);
  const evaluate=(p:Vec3,d:number)=>normal.x*p.x+normal.y*p.y+normal.z*p.z+d;
  assert.ok(Math.abs(evaluate(point,distance)-evaluate({x:point.x+translation.x,y:point.y+translation.y,z:point.z+translation.z},moved))<1e-5);
  assert.throws(()=>translatePlaneDistance(3e38,{x:3e38,y:0,z:0},{x:-10,y:0,z:0}),/finite/);
});

test("translation rejects s16 overflow and missing resources",()=>{
  const f=fixture();f.view.setInt16(f.file.start+0x80,32760);
  assert.throws(()=>f.database.translation(0,{x:8,y:0,z:0}),/signed 16-bit/);
  assert.throws(()=>f.database.translation(0,{x:0.5,y:0,z:0}),/integer/);
  const missing=new GeometryTranslations(f.reader,new Map(),()=>8);
  assert.equal(missing.summary(0).supported,false);
});

test("collision extraction rejects cycles, header overlap, malformed planes and inverted bounds",()=>{
  for(const mutate of [
    (f:ReturnType<typeof fixture>)=>f.view.setUint16(f.file.start+0x200,0),
    (f:ReturnType<typeof fixture>)=>f.view.setUint16(f.file.start+0x214,3),
    (f:ReturnType<typeof fixture>)=>f.view.setUint16(f.file.start+0x214,1),
    (f:ReturnType<typeof fixture>)=>f.view.setFloat32(f.file.start+0x180,Infinity),
    (f:ReturnType<typeof fixture>)=>f.view.setInt16(f.file.start+0x20c,101),
  ]) {
    const f=fixture();mutate(f);
    assert.throws(()=>extractCollision(f.reader,f.file,0x08000180,0x08000200));
  }
  const f=fixture();assert.throws(()=>extractCollision(f.reader,f.file,0x080007f0,0x08000200),/bounds/);
});

test("collision allows shared branch DAGs and deduplicates plane guards",()=>{
  const f=fixture();f.view.setUint16(f.file.start+0x214,4);f.view.setUint16(f.file.start+0x216,4);
  const collision=extractCollision(f.reader,f.file,0x08000180,0x08000200);
  assert.equal(collision.planeCount,1);assert.equal(collision.cellCount,1);
  assert.equal(collision.guards.filter(guard=>guard.kind==="treeBranch").length,2);
  assert.equal(collision.guards.filter(guard=>guard.kind==="planeNormal").length,1);
});

test("visual-only eligibility requires both collision pointers absent",()=>{
  const f=fixture();for(const room of [0,1]){f.view.setUint32(f.planes[0]+room*4,0);f.view.setUint32(f.trees[0]+room*4,0);}
  const summary=f.database.summary(0);assert.equal(summary.supported,true);assert.equal(summary.planeCount,0);assert.match(summary.reason!,/visual geometry only/);
  const invalid=fixture();invalid.view.setUint32(invalid.planes[0],0);
  assert.equal(invalid.database.summary(0).supported,false);
});

test("guard preimages reject competing changes to normals, topology and VTX pointers",()=>{
  for(const offset of [0x180,0x212,0x24]) {
    const f=fixture();f.database.summary(0);f.bytes[f.file.start+offset]^=1;
    assert.throws(()=>f.database.translation(0,{x:1,y:2,z:3}),/guard preimage/);
  }
  const f=fixture();f.database.summary(0);f.bytes[f.file.start+0x80]^=1;
  assert.throws(()=>f.database.translation(0,{x:1,y:2,z:3}),/preimage/);
});

test("strict traversal rejects matrices, modified vertices, culling and segment rebinding",()=>{
  for(const command of [0x01000000,0xb2000000,0xbe000000,0xbc000006,0x039e0000]) {
    const f=fixture();f.view.setUint32(f.file.start+0x20,command);
    const summary=f.database.summary(0);assert.equal(summary.supported,false);assert.match(summary.reason!,/incomplete/);
  }
});

test("partial source-sharing disables whole-room translation",()=>{
  const f=fixture();f.view.setUint32(f.primary[0]+20,0x480000c0);
  f.view.setUint32(f.secondary[0]+8,0x40000000);
  f.view.setUint32(f.file.start+0xc0,0x0400040f);f.view.setUint32(f.file.start+0xc4,0x08000080);
  f.view.setUint32(f.file.start+0xc8,0x0402081f);f.view.setUint32(f.file.start+0xcc,0x08000130);
  f.view.setUint32(f.file.start+0xd0,0xbf000000);f.view.setUint32(f.file.start+0xd4,0x00000204);f.view.setUint32(f.file.start+0xd8,0xb8000000);
  assert.equal(f.database.summary(0).supported,false);assert.equal(f.database.summary(1).supported,false);
  assert.match(f.database.summary(0).reason!,/shares only part/);
});

test("identical editable spans with different display command guards are not full aliases",()=>{
  const f=fixture();f.view.setUint32(f.primary[0]+20,0x480000c0);
  for(let offset=0;offset<24;offset++)f.bytes[f.file.start+0xc0+offset]=f.bytes[f.file.start+0x20+offset];
  assert.equal(f.database.summary(0).supported,false);assert.equal(f.database.summary(1).supported,false);
  assert.match(f.database.summary(0).reason!,/shares only part/);
});

test("local ROM translation inventory covers complete visuals and bounded collision",{skip:!process.env.MNSG_TEST_ROM},()=>{
  const rom=importRomBytes(readFileSync(process.env.MNSG_TEST_ROM!));
  const summaries=rom.listRooms();assert.ok(summaries.every(room=>!("geometryEdit" in room)));
  const rooms=summaries.map(summary=>rom.loadRoom(summary.id));
  assert.equal(rooms.filter(room=>room.geometryEdit?.supported).length,378);
  assert.equal(rooms.filter(room=>room.geometryEdit?.supported&&room.geometryEdit.cellCount===0).length,6);
  assert.equal(rooms.reduce((sum,room)=>sum+(room.geometryEdit?.cellCount??0),0),6638);
  assert.equal(rooms.reduce((sum,room)=>sum+(room.geometryEdit?.planeCount??0),0),98702);
  const room=rom.loadRoom(0);assert.equal(room.geometryEdit!.vertexCount,463);assert.equal(room.geometryEdit!.planeCount,101);assert.equal(room.geometryEdit!.cellCount,12);
  assert.deepEqual(room.geometryEdit!.affectedRoomIds,[0,1]);
  const operation=rom.geometryTranslation(0,{x:10,y:20,z:30});assert.equal(operation.spans.length,576);assert.equal(operation.guards.length,945);
  const alias=rom.geometryTranslation(1,{x:10,y:20,z:30});assert.deepEqual(alias.spans,operation.spans);assert.deepEqual(alias.guards,operation.guards);
  assert.ok(rooms.some(room=>room.meshes.some(mesh=>mesh.id.startsWith("secondary:"))));
});
