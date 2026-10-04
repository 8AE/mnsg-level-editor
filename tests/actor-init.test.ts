import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {InitMachine,type InitMemory} from "../core/rom/actor-init-machine";
import {ActorInitializer} from "../core/rom/actor-init";
import {RomReader} from "../core/rom/binary";
import {readFileTable} from "../core/rom/decompress";
import {RenderWaves} from "../core/rom/waves";
import {importRomBytes} from "../core/rom";

class Memory implements InitMemory {
  readonly bytes=new Uint8Array(4096);
  read(address:number,size:number){assert.ok(address+size<=this.bytes.length);return this.bytes.slice(address,address+size);}
  write(address:number,bytes:Uint8Array){assert.ok(address+bytes.length<=this.bytes.length);this.bytes.set(bytes,address);}
  code(...words:number[]){words.forEach((word,i)=>new DataView(this.bytes.buffer).setUint32(i*4,word));return this;}
}
const i=(op:number,rs:number,rt:number,imm:number)=>((op<<26)|(rs<<21)|(rt<<16)|(imm&65535))>>>0;
const r=(rs:number,rt:number,rd:number,fn:number)=>((rs<<21)|(rt<<16)|(rd<<11)|fn)>>>0;
const fp=(fmt:number,ft:number,fs:number,fd:number,fn:number)=>((17<<26)|(fmt<<21)|(ft<<16)|(fs<<11)|(fd<<6)|fn)>>>0;
const ret=r(31,0,0,8);

test("MIPS executes branch delay slots and annuls untaken likely slots",()=>{
  const memory=new Memory().code(i(9,0,8,1),i(4,8,8,2),i(9,0,2,7),i(9,0,2,99),i(20,8,0,1),i(9,0,2,66),ret,0);
  const cpu=new InitMachine(memory);cpu.run(0);assert.equal(cpu.registers[2],7);assert.deepEqual(cpu.branches.map(b=>b.taken),[true,false]);
});
test("signed halfword loads remain signed in SLT and SLTI",()=>{
  const memory=new Memory().code(i(33,0,8,100),r(8,0,2,42),i(10,8,3,0),ret,0);memory.write(100,new Uint8Array([0x80,0]));
  const cpu=new InitMachine(memory);cpu.run(0);assert.equal(cpu.registers[8],0xffff8000);assert.equal(cpu.registers[2],1);assert.equal(cpu.registers[3],1);
});
test("untaken REGIMM link branches do not consume call depth",()=>{
  const cpu=new InitMachine(new Memory().code(i(1,8,16,4),0,2<<26,0),{instructions:12,callDepth:2});cpu.registers[8]=1;
  assert.throws(()=>cpu.run(0),/instruction limit/);assert.equal(cpu.depth,0);
});
test("COP1 ROUND.W and CVT.W use nearest-even and preserve FCSR conversion flags",()=>{
  const memory=new Memory().code(fp(16,0,0,2,12),fp(16,0,4,6,36),fp(16,0,8,10,36),ret,0);
  const cpu=new InitMachine(memory);cpu.setF32(0,-1.5);cpu.setF32(4,2.5);cpu.setF32(8,NaN);cpu.run(0);
  assert.equal(cpu.floating[2],0xfffffffe);assert.equal(cpu.floating[6],2);assert.equal(cpu.floating[10],0x80000000);assert.ok(cpu.fcr31&0x1004);assert.ok(cpu.fcr31&0x10040);
});
test("COP1 paired double loads, conversion, and stores retain big-endian values",()=>{
  const memory=new Memory().code(i(53,0,0,128),fp(17,0,0,2,32),fp(16,0,2,4,33),i(61,0,4,144),ret,0);new DataView(memory.bytes.buffer).setFloat64(128,1.25);
  const cpu=new InitMachine(memory);cpu.run(0);assert.equal(cpu.f32(2),1.25);assert.equal(new DataView(memory.bytes.buffer).getFloat64(144),1.25);
});
test("instruction budget also bounds handled helpers returning to themselves",()=>{
  const cpu=new InitMachine(new Memory(),{instructions:5,callDepth:4},(_pc,m)=>{m.registers[31]=0;m.returnFromIntercept();return true;});assert.throws(()=>cpu.run(0),/instruction limit/);assert.equal(cpu.instructions,5);
});
test("unrecognized instructions and depth overflows stop with explicit diagnostics",()=>{
  assert.throws(()=>new InitMachine(new Memory().code(0xffffffff)).run(0),/Unknown native instruction/);
  const memory=new Memory().code((3<<26),0);assert.throws(()=>new InitMachine(memory,{instructions:100,callDepth:3}).run(0),/call-depth limit/);
});

test("a self-scheduling native-shaped initializer ends as unsupported at the deferred budget",()=>{
  const bytes=new Uint8Array(0x5f5000),v=new DataView(bytes.buffer);
  const code=[i(9,29,29,-24),i(43,29,31,20),i(15,0,25,0x8003),i(13,25,25,0x521c),i(15,0,4,0x8000),i(13,4,4,0x400),r(25,0,31,9),0,i(35,29,31,20),i(9,29,29,24),ret,0];
  code.forEach((word,index)=>v.setUint32(0x1000+index*4,word));v.setUint32(0x5e3c8c,0x80000400);
  const init=new ActorInitializer(new RomReader(bytes),new Map(),{wave:()=>{throw Error("Unexpected wave read");}}),zero={x:0,y:0,z:0};
  const result=init.resolve({actorId:0,parameters:[0,0,0],position:zero,rotation:zero});
  assert.equal(result.status,"unsupported");assert.equal(result.bindings.length,0);assert.match(result.diagnostics.join(" "),/Deferred initializer budget/);assert.ok(result.instructionCount<12000);
});
test("initializer rejects untrusted IDs and malformed payloads without native execution",()=>{
  const init=new ActorInitializer(new RomReader(new Uint8Array(0x600000)),new Map(),{wave:()=>new Uint8Array()}),zero={x:0,y:0,z:0};
  for(const input of [{actorId:0x407,parameters:[0,0,0]},{actorId:1,parameters:[-1,0,0]},{actorId:1,parameters:[0,0]}]){const result=init.resolve({...input,position:zero,rotation:zero});assert.equal(result.status,"unsupported");assert.equal(result.instructionCount,0);assert.match(result.diagnostics.join(" "),/validated native actor record/);}
});

const call=(address:number)=>[i(15,0,25,address>>>16),i(13,25,25,address&65535),r(25,0,31,9),0];
const enter=[i(9,29,29,-32),i(43,29,31,28),r(4,0,16,33)];
const leave=[i(35,29,31,28),i(9,29,29,32),ret,0];
const constant=(reg:number,value:number)=>[i(15,0,reg,value>>>16),i(13,reg,reg,value&65535)];
function synthetic(main:number[],callbacks:{pc:number;code:number[]}[]=[]){
  const bytes=new Uint8Array(0x600000),view=new DataView(bytes.buffer);
  main.forEach((word,index)=>view.setUint32(0x1000+index*4,word));
  callbacks.forEach(({pc,code})=>code.forEach((word,index)=>view.setUint32(pc-0x80000000+0xc00+index*4,word)));
  view.setUint32(0x5e3c8c,0x80000400);view.setUint32(0x5f1e54,0x80000500);view.setUint32(0x5f1e58,0x80000500);
  view.setUint32(0x1100,0x80000600);view.setUint32(0x1104,0x80000610);view.setUint16(0x1200,1);view.setUint32(0x1210,0x08000004);
  view.setUint16(0x55510,2);bytes[0x55513]=8;view.setUint16(0x55514,0x153);bytes[0x55517]=10;
  return new ActorInitializer(new RomReader(bytes),new Map(),{wave:()=>new Uint8Array(256)});
}
const input0={actorId:0,parameters:[0,0,0],position:{x:0,y:0,z:0},rotation:{x:0,y:0,z:0}};
test("secondary shadow declarations do not hide an unresolved primary callback budget",()=>{
  const main=[...enter,i(9,0,5,0),...call(0x80216e54),...constant(4,0x80000400),...call(0x8003521c),...leave];
  const result=synthetic(main).resolve(input0);assert.ok(result.bindings.length);assert.ok(result.bindings.every(b=>b.objectIndex>0));assert.equal(result.status,"conditional");assert.equal(result.failureKind,"unresolved");assert.match(result.diagnostics.join(" "),/Primary deferred initializer remains unresolved/);
});
test("child initialization observes parent payload assignment and replaced task callback",()=>{
  const main=[...enter,...constant(5,0x80000700),i(9,0,6,0),...call(0x802171a8),i(9,0,8,1),i(43,2,8,0xd0),...constant(8,0x80000800),i(43,2,8,0xc),...leave];
  const child=[...enter,i(9,0,5,0),...call(0x80216ed0),...leave];
  const result=synthetic(main,[{pc:0x80000700,code:[ret,0]},{pc:0x80000800,code:child}]).resolve(input0);
  assert.ok(result.bindings.some(b=>b.objectIndex===1&&b.identity===1&&b.provenance.some(p=>p.includes("0x80000800"))));assert.ok(!result.diagnostics.some(d=>d.includes("without a bound model")));
});
test("a known parent and unresolved child retain declarations with unresolved failure kind",()=>{
  const main=[...enter,i(9,0,5,1),i(9,0,6,0),...call(0x80216ffc),...constant(5,0x80000700),i(9,0,6,0),...call(0x802171a8),...leave];
  const result=synthetic(main,[{pc:0x80000700,code:[ret,0]}]).resolve(input0);assert.ok(result.bindings.some(b=>b.objectIndex===0));assert.equal(result.failureKind,"unresolved");assert.match(result.diagnostics.join(" "),/Native child callback.*without a bound model/);
});
test("progression alternatives preserve the exact native masked bit and coherent branch provenance",()=>{
  const main=[...enter,i(9,0,4,2),...call(0x800240dc),...constant(9,0x8015c608),i(36,9,8,0),i(4,2,8,5),0,...call(0x80034ed4),i(9,0,8,4),i(4,2,8,5),0,...call(0x80034ed4),r(16,0,4,33),i(9,0,5,1),i(9,0,6,0),...call(0x80216ffc),...leave];
  const result=synthetic(main).resolve(input0);assert.ok(result.bindings.some(b=>b.identity===1));assert.equal(result.status,"conditional");assert.equal(result.failureKind,"scene-gated");assert.match(result.diagnostics.join(" "),/flag 0x2 set/);assert.ok(result.instructionCount<=12000);
});

const native=()=>{
  const rom=importRomBytes(readFileSync(process.env.MNSG_TEST_ROM!)),reader=new RomReader(rom.bytes),files=new Map(readFileTable(rom.bytes).map(f=>[f.id,f]));
  const segment=(id:number)=>{for(let at=0x55510;at<0x55910;at+=4)if(id<reader.u16(at))return reader.bytes[at+3];throw new Error("No native resource segment.");};
  return {rom,initializer:new ActorInitializer(reader,files,new RenderWaves(reader,files,segment))};
};
test("canonical constructors select actual alternate identity/slots and angle writes",{skip:!process.env.MNSG_TEST_ROM},()=>{
  const {initializer}=native();const zero={x:0,y:0,z:0};
  for(const [id,identity,slot] of [[0x82,1,4],[0x84,1,3],[0xfe,0xfd,1],[0x2d3,0x2d1,0]]){
    const result=initializer.resolve({actorId:id,parameters:[0,0,0],position:zero,rotation:zero,roomId:0});assert.ok(result.bindings.some(b=>b.identity===identity&&b.slot===slot),JSON.stringify(result.diagnostics));assert.ok(result.instructionCount<=12000);
  }
  const coin=initializer.resolve({actorId:0x85,parameters:[0,0,0],position:zero,rotation:zero,roomId:0});const own=coin.bindings.find(b=>b.identity===0x85)!;
  assert.equal(own.slot,0);assert.deepEqual(own.rotation,{x:-32768,y:-32768,z:-32768});assert.deepEqual(own.rotationOverrideMask,{x:true,y:true,z:true});
});
test("canonical direct-field constructor064 captures root/resources and native scale",{skip:!process.env.MNSG_TEST_ROM},()=>{
  const {initializer}=native(),zero={x:0,y:0,z:0};const result=initializer.resolve({actorId:0x64,parameters:[0,0,0],position:zero,rotation:zero});
  const own=result.bindings.find(b=>b.identity===0x64);assert.ok(own,JSON.stringify(result.diagnostics));assert.equal(own.slot,-1);assert.equal(own.scale.x,10);assert.ok(own.modelPointer);assert.ok(own.segments.some(s=>s.segment===9&&s.fileId===0x181));
});
test("native first-material frame fills287allocatedcommands without recurring UV advancement",{skip:!process.env.MNSG_TEST_ROM},()=>{
  const {rom,initializer}=native();const room=rom.listRooms().find(r=>rom.loadRoom(r.id).actors.some(a=>a.actorId===0x287))!,actor=rom.loadRoom(room.id).actors.find(a=>a.actorId===0x287)!;
  const result=initializer.resolve({actorId:actor.actorId,parameters:actor.parameters,position:actor.position,rotation:actor.rotation,roomId:room.id});const own=result.bindings.find(b=>b.identity!==1)!;
  assert.ok(own.provenance.some(p=>p.includes("first-material builder")));const pointer=(own.materialPointer&0x8fffffff)>>>0,span=result.syntheticMemory.find(s=>s.address===pointer)!;assert.ok(span);
  const view=new DataView(span.bytes.buffer,span.bytes.byteOffset,span.bytes.length);assert.notEqual(view.getUint32(0),0xb8000000);assert.equal(view.getUint32(0),0x06000000);assert.equal(view.getUint32(4),0x8006df68);
  const tags=Array.from({length:span.bytes.length/8},(_,n)=>view.getUint32(n*8)>>>24);assert.ok(tags.includes(0xfa)&&tags.includes(0xfd)&&tags.includes(0xb8));
  const resident=new RomReader(rom.bytes),lists=[view.getUint32(4)],visited=new Set<number>();let foundCombine=false;
  while(lists.length&&visited.size<64){const pointer=lists.pop()!;if(visited.has(pointer))continue;visited.add(pointer);for(let n=0;n<64;n++){const offset=pointer-0x80000000+0xc00+n*8,word=resident.u32(offset);if(word>>>24===0xfc)foundCombine=true;if(word>>>24===0x06)lists.push(resident.u32(offset+4));if(word>>>24===0xb8)break;}}
  assert.ok(foundCombine,"Native material call chain must supply the combine command");
  for(let n=0;n<tags.length;n++)if(tags[n]===0xfd){const source=view.getUint32(n*8+4);assert.ok(result.readonlyMemory.some(mapping=>source>=mapping.address&&source<mapping.address+mapping.byteLength));}
});
test("house preview preserves source height when native collision settling is unavailable",{skip:!process.env.MNSG_TEST_ROM},()=>{
  const {initializer}=native(),result=initializer.resolve({actorId:0x2d3,parameters:[0,0,0],position:{x:0,y:-40,z:0},rotation:{x:0,y:0,z:0},roomId:465});const own=result.bindings.find(b=>b.identity===0x2d1)!;
  assert.ok(own);assert.equal(own.position.y,-40);assert.equal(result.failureKind,"scene-gated");assert.match(result.diagnostics.join(" "),/ground settling is not simulated/);
});
test("path parameters choose native NPC slots and authored relocation while segmentB survives native texture code",{skip:!process.env.MNSG_TEST_ROM},()=>{
  const {initializer}=native(),zero={x:0,y:0,z:0};const path=initializer.resolve({actorId:0x2bd,parameters:[144,0,0],position:zero,rotation:zero,roomId:378});const own=path.bindings.find(b=>b.identity===0x2bd)!;assert.ok(own);assert.equal(own.slot,1);assert.equal(own.positionOffset.z,197);
  const gem=initializer.resolve({actorId:0x82,parameters:[0,0,0],position:zero,rotation:zero});assert.ok(gem.bindings.find(b=>b.slot===4)!.segments.some(s=>s.segment===11&&s.fileId===0x152&&s.offset===2432));
});
test("all original placement constructors receive bounded evaluation without inventing model absence",{skip:!process.env.MNSG_TEST_ROM},()=>{
  const {rom,initializer}=native(),seen=new Set<string>();let total=0;const ids=new Set<number>();
  for(const room of rom.listRooms())for(const actor of rom.loadRoom(room.id).actors){if(seen.has(actor.id))continue;seen.add(actor.id);ids.add(actor.actorId);total++;
    const result=initializer.resolve({actorId:actor.actorId,parameters:actor.parameters,position:actor.position,rotation:actor.rotation,roomId:room.id});
    assert.ok(result.instructionCount<=12000);assert.ok(result.bindings.length<=64);if(result.status==="nonvisual")assert.ok(result.diagnostics.some(d=>/no.*3D|no intrinsic 3D|without.*3D/.test(d)));
    if(!result.bindings.length)assert.ok(result.status==="unsupported"||result.status==="nonvisual");
    for(const b of result.bindings)assert.ok(b.provenance.length&&b.segments.length);
  }
  assert.equal(total,3888);assert.equal(ids.size,255);
});
