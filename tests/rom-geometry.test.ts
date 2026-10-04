import test from "node:test";
import assert from "node:assert/strict";
import { RomReader } from "../core/rom/binary";
import { decodeRoomGeometry, graphicsRecord } from "../core/rom/geometry";
import { actorEvent } from "../core/rom/events";
import type { ActorData } from "../shared/types";

function fixture() {
  const bytes = new Uint8Array(256), view = new DataView(bytes.buffer);
  view.setUint32(0, 0x48000020); view.setUint32(8, 1);
  view.setUint32(32, 0x04000c2f); view.setUint32(36, 0x08000080);
  view.setUint32(40, 0xbf000000); view.setUint32(44, 0x00000204);
  view.setUint32(48, 0xb8000000);
  for (let index = 0; index < 3; index++) {
    view.setInt16(128 + index * 16, index * 10 - 10);
    view.setInt16(130 + index * 16, index * 20);
    view.setInt16(132 + index * 16, -index * 30);
  }
  return {bytes, view, files: new Map([[1, {id:1,start:0,end:256,compressed:false}]])};
}
test("F3DEX resolves native segmented vertices and triangle cache indices", () => {
  const {bytes, files} = fixture();
  const result = decodeRoomGeometry(new RomReader(bytes), 0, files, () => 8);
  assert.deepEqual(result.meshes[0].positions, [-10,0,0,0,20,-30,10,40,-60]);
  assert.deepEqual(result.meshes[0].indices, [0,1,2]);
  assert.equal(result.meshes[0].colors, undefined);
  assert.ok(!result.warnings.some(warning=>warning.startsWith("Partial")));
});
test("F3DEX retains explicit partial diagnostic after unsupported transform", () => {
  const {bytes, view, files} = fixture(); view.setUint32(48, 0x01000000);
  const result = decodeRoomGeometry(new RomReader(bytes),0,files,()=>8);
  assert.equal(result.meshes.length,1);
  assert.ok(result.warnings.some(warning=>warning.startsWith("Partial geometry:")&&warning.includes("matrix")));
});
test("F3DEX rejects cyclic display lists and unloaded vertex addresses", () => {
  const {bytes,view,files} = fixture(); view.setUint32(32,0x06000000);view.setUint32(36,0x08000020);
  const cyclic=decodeRoomGeometry(new RomReader(bytes),0,files,()=>8);
  assert.equal(cyclic.meshes.length,0);assert.ok(cyclic.warnings.some(w=>w.includes("recursion")));
  const missing=fixture();missing.view.setUint32(36,0x09000080);
  assert.ok(decodeRoomGeometry(new RomReader(missing.bytes),0,missing.files,()=>8).warnings.some(w=>w.includes("unmapped pointer")));
});
test("event classification preserves native barrier subtype exclusions", () => {
  const actor: ActorData = {id:"a",index:0,actorId:0x23d,name:"Actor",position:{x:1,y:2,z:3},rotation:{x:0,y:0,z:0},parameters:[0x03000000,0,0],editable:true,source:{romOffset:0,expectedHex:"00".repeat(20)},definitionSource:{romOffset:20,expectedHex:"00".repeat(16)}};
  const event=actorEvent(actor)!;
  assert.equal(event.actorRef,"a");assert.equal(event.editable,false);assert.match(event.name,/0x1C2/);
  actor.parameters[0]=0x02000000;
  assert.equal(actorEvent(actor),undefined);
  assert.deepEqual(event.values,[0x03000000,0,0]);
  actor.actorId=0x242;actor.parameters=[0x01000001,0,0x00300000];
  assert.equal(actorEvent(actor),undefined);
  actor.parameters[0]=0x01000000;
  assert.match(actorEvent(actor)!.name,/destination room 0x30/);
  actor.actorId=0x226;actor.parameters=[0x00a40000,0x01000000,0];
  assert.match(actorEvent(actor)!.name,/save flag 0xA4/);
  actor.parameters[1]=0x02000000;
  assert.equal(actorEvent(actor),undefined);
});

test("graphics group capacity excludes unused room gaps before reading adjacent tables", () => {
  const bytes = new Uint8Array(0x5d0000), view = new DataView(bytes.buffer);
  const ranges = [0,300,350,400,540,544,549,561,588,607,613,618,619,620];
  ranges.forEach((value,index)=>view.setUint16(0x5c610+index*2,value));
  const pointers = [0x802053d0,0x8020612c,0x80206874,0x80206e64,0x80207a34,0x80207fd8];
  pointers.forEach((pointer,index)=>view.setUint32(0x5c57ec+index*4,pointer));
  const reader = new RomReader(bytes);
  for (const id of [0,89,90,127,128,197,300,348,350,389,400,483,540,543,544,548]) assert.notEqual(graphicsRecord(reader,id),undefined);
  for (const id of [198,299,349,390,399,484,539,549,619,620]) assert.equal(graphicsRecord(reader,id),undefined);
  assert.equal(Array.from({length:800},(_,id)=>graphicsRecord(reader,id)).filter(record=>record!==undefined).length,380);
});
