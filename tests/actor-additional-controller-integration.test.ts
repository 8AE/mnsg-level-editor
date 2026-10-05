import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {importRomBytes,readFileTable,type ImportedRom} from "../core/rom";
import {RomReader} from "../core/rom/binary";
import {RenderWaves} from "../core/rom/waves";
import {ActorInitializer,nativeControllerResourceContract,type NativeActorInitInput} from "../core/rom/actor-init";
import {ActorVisuals} from "../core/rom/actors";
const zero={x:0,y:0,z:0},ids=[0x079,0x07a,0x07b,0x07c,0x357],actual={skip:!process.env.MNSG_TEST_ROM},hash=(b:Uint8Array)=>createHash("sha256").update(b).digest("hex");
let rom:ImportedRom;
function native(bytes?:Uint8Array){
  rom??=importRomBytes(readFileSync(process.env.MNSG_TEST_ROM!));const reader=new RomReader(bytes??rom.bytes),files=new Map(readFileTable(reader.bytes).map(f=>[f.id,f]));
  const waves=new RenderWaves(reader,files,id=>{for(let at=0x55510;at<0x556c4;at+=4){const upper=reader.u16(at);if(!upper)break;if(id<upper)return reader.bytes[at+3];}throw Error("No segment");});
  return {reader,files,waves,init:new ActorInitializer(reader,files,waves),visuals:new ActorVisuals(reader,files,waves),rom};
}
function input(actorId:number,roomId?:number):NativeActorInitInput{return {actorId,roomId,parameters:[0,0,0],position:zero,rotation:zero};}
function metadataOnly(r:ReturnType<ActorInitializer["resolve"]>){assert.equal(r.status,"nonvisual");assert.equal(r.completed,false);assert.equal(r.instructionCount,0);assert.deepEqual(r.bindings,[]);assert.deepEqual(r.syntheticMemory,[]);assert.deepEqual(r.readonlyMemory,[]);assert.deepEqual(r.deferredCallbacks,[]);assert.equal(r.diagnostics.length,2);assert.match(r.diagnostics[1],/executes no native behavior/);}

test("dense validated inputs precede every new classification guard",()=>{
  let waves=0;const init=new ActorInitializer(new RomReader(new Uint8Array(64)),new Map(),{wave:()=>{waves++;throw Error("Unexpected wave access");}});
  for(const id of ids)for(const bad of [{parameters:[0,-1,0]},{parameters:new Array(3)},{parameters:[0,,0]},{parameters:[0,0]},{parameters:null as unknown as number[]},{parameters:{0:0,1:0,2:0,length:3} as unknown as number[]},{position:{x:NaN,y:0,z:0}},{rotation:{x:0,y:0,z:Infinity}}]){
    const r=init.resolve({...input(id),...bad});assert.equal(r.status,"unsupported");assert.equal(r.completed,false);assert.equal(r.failureKind,"unresolved");assert.equal(r.instructionCount,0);assert.deepEqual(r.syntheticMemory,[]);assert.ok(!r.diagnostics.some(d=>/guarded.*classification/.test(d)));
  }
  assert.equal(waves,0);
});

test("native357 placement retains scene effects as nonvisual metadata without executing work",actual,()=>{
  const n=native(),a=n.rom.loadRoom(113).actors.find(a=>a.id==="actor:12add54")!;assert.ok(a);assert.equal(a.actorId,0x357);
  const i={...input(a.actorId,113),parameters:a.parameters,position:a.position,rotation:a.rotation},before=JSON.stringify(i),romHash=hash(n.reader.bytes);let calls=0;
  const initializer=new ActorInitializer(n.reader,n.files,{wave:()=>{calls++;throw Error("No wave may be touched");}});metadataOnly(initializer.resolve(i));assert.equal(calls,0);assert.equal(JSON.stringify(i),before);
  const p=n.visuals.preview(i,a.id);assert.equal(p.actorVisuals[0].status,"nonvisual");assert.deepEqual(p.actorVisuals[0].parts,[]);assert.deepEqual(p.actorModels,[]);assert.match(p.actorVisuals[0].warnings.join(" "),/player.*progression.*camera\/light/);assert.equal(hash(n.reader.bytes),romHash);
});

test("all five library/origin/authored contexts are metadata-only with no wave loads",actual,()=>{
  const n=native(),catalog=n.rom.getAuthoringCatalog();let calls=0;const init=new ActorInitializer(n.reader,n.files,{wave:()=>{calls++;throw Error("No native wave load");}});
  for(const id of ids){
    for(const i of [input(id),input(id,id===0x357?113:0),{...input(id,621),templateRoomId:id===0x357?113:0}])metadataOnly(init.resolve(i));
    const proto=catalog.actorPrototypes.find(p=>p.actorId===id)!;assert.ok(proto);const p=n.rom.loadActorPrototype(proto.id),authored=n.rom.loadActorPrototypeForRoom(proto.id,{}, {roomId:621,templateRoomId:id===0x357?113:0});
    for(const payload of [p,authored]){assert.equal(payload.actorVisuals[0].status,"nonvisual");assert.deepEqual(payload.actorModels,[]);assert.deepEqual(payload.actorVisuals[0].parts,[]);}
  }
  assert.equal(calls,0);
});

test("only dynamic079/07C receive finite static File24 closure and foreign admission",actual,()=>{
  const n=native(),catalog=n.rom.getAuthoringCatalog(),context=n.rom.authoringExportContext();
  for(const id of ids){const proto=catalog.actorPrototypes.find(p=>p.actorId===id)!,target={roomId:621,templateRoomId:id===0x357?113:0},d=n.visuals.dependencies({...input(id,621),templateRoomId:target.templateRoomId});assert.equal(d.completed,false);
    if(id===0x079||id===0x07c){assert.equal(d.proofKind,"verified-controller-closure");assert.deepEqual(d.fileIds,[24]);assert.match(d.provenance!.join(" "),/full raw SHA256.*allocation0x08000000.*CPU completion is not asserted/);const exported=context.prototype(proto.id,{},target);assert.equal(exported.dependencyClosure,"verified-controller-closure");assert.ok(exported.resourceFileIds.includes(24));assert.match(exported.dependencyProvenance.join(" "),/CPU completion is not asserted/);assert.ok(!exported.dependencyProvenance.some(p=>p.includes("All selected native constructor")));}
    else{assert.equal(d.proofKind,undefined);assert.equal(nativeControllerResourceContract(n.reader,n.files,id),undefined);assert.throws(()=>context.prototype(proto.id,{},target),/unresolved resource dependency/);if(id!==0x357)assert.deepEqual(d.fileIds,[]);}
  }
});

test("mutated new classifier guards reject without task allocation, CPU fallback or static admission",actual,()=>{
  const n=native();for(const [id,offsets] of [[0x79,[0x6acb20,0x5e3e70,0x5e4d99,0x55788,0x6a57c,0x66398]],[0x7a,[0x5d03fc,0x5e3e74,0x55724,0x20fd4,0x6c33c]],[0x7b,[0x5d0480,0x5e4d9d,0x21040]],[0x7c,[0x6ac6dc,0x5e3e7c]],[0x357,[0x6bdbc4,0x5e49e8,0x5e5355,0x6a590,0x64340]]] as const){
    for(const at of offsets){const changed=n.reader.bytes.slice();changed[at]^=1;const m=native(changed),r=m.init.resolve(input(id,0));assert.equal(r.status,"unsupported");assert.equal(r.completed,false);assert.equal(r.failureKind,"unresolved");assert.equal(r.instructionCount,0);assert.deepEqual(r.syntheticMemory,[]);assert.deepEqual(r.readonlyMemory,[]);assert.deepEqual(r.bindings,[]);assert.match(r.diagnostics.join(" "),/unsupported guarded.*classification/);if(id===0x79||id===0x7c)assert.throws(()=>nativeControllerResourceContract(m.reader,m.files,id),/unsupported guarded.*classification/);}
  }
});

test("adjacent visual/controller IDs are not reclassified; older static and loader proofs stay separate",actual,()=>{
  const n=native();for(const id of [0x78,0x7d,0x358,0x35d]){const r=n.init.resolve(input(id,0));assert.notEqual(r.status,"nonvisual");assert.ok(!r.diagnostics.some(d=>d.includes("Metadata classification executes")||d.includes("Static metadata proof")));assert.equal(nativeControllerResourceContract(n.reader,n.files,id),undefined);}
  for(const [id,resources] of [[0x23b,[43]],[0x308,[27]],[0x34e,[61,96]]] as const){const d=n.visuals.dependencies({...input(id,621),templateRoomId:465});assert.equal(d.completed,false);assert.equal(d.proofKind,"verified-controller-closure");for(const file of resources)assert.ok(d.fileIds.includes(file));}
  for(const [id,donor] of [[0x24c,306],[0x35c,193]]){const r=n.init.resolve(input(id,donor));assert.equal(r.status,"conditional");assert.equal(r.completed,false);assert.ok(r.bindings.length);}
});
