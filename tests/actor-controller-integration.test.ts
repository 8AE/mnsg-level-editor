import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {importRomBytes,readFileTable,type ImportedRom} from "../core/rom";
import {RomReader} from "../core/rom/binary";
import {RenderWaves} from "../core/rom/waves";
import {ActorInitializer,nativeControllerResourceContract,type NativeActorInitInput} from "../core/rom/actor-init";
import {ActorVisuals} from "../core/rom/actors";
import {prototypeId} from "../core/authoring/catalog";
const zero={x:0,y:0,z:0},actual={skip:!process.env.MNSG_TEST_ROM},hash=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");
let imported:ImportedRom;
function native(bytes?:Uint8Array){
  imported??=importRomBytes(readFileSync(process.env.MNSG_TEST_ROM!));const reader=new RomReader(bytes??imported.bytes),files=new Map(readFileTable(reader.bytes).map(file=>[file.id,file]));
  const waves=new RenderWaves(reader,files,id=>{for(let at=0x55510;at<0x556c4;at+=4){const upper=reader.u16(at);if(!upper)break;if(id<upper)return reader.bytes[at+3];}throw Error("No native segment");});
  return {reader,files,waves,init:new ActorInitializer(reader,files,waves),visuals:new ActorVisuals(reader,files,waves),rom:imported};
}
function input(actorId:number,roomId:number):NativeActorInitInput{return {actorId,roomId,parameters:[0,0,0],position:zero,rotation:zero};}
const fixtures=[[0x23b,26,"actor:12a6198",43,true],[0x35e,50,"actor:12a73f4",24,false],[0x1bf,49,"actor:12a7158",30,false]] as const;

test("validated inputs precede guarded metadata and cannot become nonvisual on rejection",()=>{
  const init=new ActorInitializer(new RomReader(new Uint8Array(64)),new Map(),{wave:()=>{throw Error("No native execution");}});
  for(const actorId of [0x23b,0x35e,0x1bf])for(const bad of [{parameters:[-1,0,0]},{parameters:[0,0]},{parameters:new Array(3)},{parameters:[0,,0]},{parameters:{0:0,1:0,2:0,length:3} as unknown as number[]},{parameters:null as unknown as number[]},{position:{x:NaN,y:0,z:0}},{rotation:{x:0,y:Infinity,z:0}}]){
    const r=init.resolve({...input(actorId,0),...bad});assert.equal(r.status,"unsupported");assert.equal(r.completed,false);assert.equal(r.failureKind,"unresolved");assert.equal(r.instructionCount,0);assert.deepEqual(r.syntheticMemory,[]);assert.deepEqual(r.bindings,[]);assert.ok(!r.diagnostics.some(d=>d.includes("Metadata classification")));
  }
});

test("actual controller source placements classify without callbacks, tasks, or assets",actual,()=>{
  const n=native(),before=hash(n.reader.bytes);
  for(const [actorId,roomId,ref,overlay,completed] of fixtures){
    const actor=n.rom.loadRoom(roomId).actors.find(actor=>actor.id===ref)!;assert.ok(actor);assert.equal(actor.actorId,actorId);
    if(actorId===0x23b)assert.deepEqual(actor.parameters,[0x011c0001,0,0x30000]);
    const i={...input(actorId,roomId),parameters:actor.parameters,position:actor.position,rotation:actor.rotation},r=n.init.resolve(i);
    assert.equal(r.status,"nonvisual");assert.equal(r.completed,false);assert.equal(r.instructionCount,0);assert.deepEqual(r.bindings,[]);assert.deepEqual(r.syntheticMemory,[]);assert.deepEqual(r.readonlyMemory,[]);assert.deepEqual(r.deferredCallbacks,[]);assert.equal(r.diagnostics.length,2);assert.match(r.diagnostics[1],/Metadata classification executes no native behavior/);
    const visual=n.visuals.preview(i,ref);assert.equal(visual.actorVisuals[0].status,"nonvisual");assert.deepEqual(visual.actorModels,[]);assert.deepEqual(visual.actorVisuals[0].parts,[]);
    const deps=n.visuals.dependencies(i);assert.equal(deps.completed,false);assert.deepEqual(deps.fileIds,[overlay]);assert.equal(deps.proofKind,completed?"verified-controller-closure":undefined);if(completed)assert.match(deps.provenance!.join(" "),/CPU completion is not asserted/);assert.match(deps.warnings.join(" "),/Metadata classification executes no native behavior/);
  }
  assert.equal(hash(n.reader.bytes),before);
});

test("library and authored donor controller classifications preserve static proof separately from initializer completion",actual,()=>{
  const n=native();for(const [id,donor,,overlay,completed] of fixtures)for(const i of [input(id,donor),{...input(id,621),templateRoomId:donor}]){
    const r=n.init.resolve(i);assert.equal(r.status,"nonvisual");assert.equal(r.completed,false);assert.equal(r.instructionCount,0);assert.deepEqual(n.visuals.dependencies(i).fileIds,[overlay]);
  }
  const r=n.init.resolve({...input(0x23b,621),templateRoomId:26,parameters:[0xffffffff,0x80000000,0x12345678]});assert.equal(r.status,"nonvisual");assert.equal(r.completed,false);assert.equal(r.instructionCount,0);
});

test("existing authoring admission accepts only finite23B and preserves unresolved sound/camera controllers",actual,()=>{
  const n=native(),catalog=n.rom.getAuthoringCatalog(),context=n.rom.authoringExportContext();
  for(const [id,donor,ref,,completed] of fixtures){
    const actor=n.rom.loadRoom(donor).actors.find(actor=>actor.id===ref)!,half=actor.definitionSource?n.reader.u16(actor.definitionSource.romOffset+2):0,proto=prototypeId(id,actor.parameters as [number,number,number],half);assert.ok(catalog.actorPrototypes.some(p=>p.id===proto));
    const edits={parameters:actor.parameters as [number,number,number],position:actor.position,rotation:actor.rotation},target={roomId:621,templateRoomId:donor};
    if(completed){const d=context.prototype(proto,edits,target);assert.equal(d.actorId,id);assert.ok(d.resourceFileIds.includes(43));assert.equal(d.dependencyClosure,"verified-controller-closure");assert.match(d.dependencyProvenance.join(" "),/CPU completion is not asserted/);assert.ok(!d.dependencyProvenance.some(d=>d.includes("All selected native constructor")));assert.match(d.warnings.join(" "),/Metadata classification executes no native behavior/);}
    else assert.throws(()=>context.prototype(proto,edits,target),/unresolved resource dependency/);
  }
});

test("body, registry, overlay and PIC mutations fail closed before ordinary CPU/nonvisual shortcuts",actual,()=>{
  const n=native();for(const at of [0x6f57dc,0x6acd58,0x6c24e8,0x5e4578,0x5e4a04,0x5e4388,0x5e511c,0x5e5362,0x5e5024,0x6a5c8,0x6a57c,0x6a594,0x66398]){
    const changed=n.reader.bytes.slice();changed[at]^=1;const m=native(changed);for(const [id,room] of fixtures){const r=m.init.resolve(input(id,room));assert.equal(r.status,"unsupported");assert.equal(r.completed,false);assert.equal(r.failureKind,"unresolved");assert.equal(r.instructionCount,0);assert.deepEqual(r.bindings,[]);assert.deepEqual(r.syntheticMemory,[]);assert.deepEqual(r.readonlyMemory,[]);assert.match(r.diagnostics.join(" "),/unsupported guarded controller classification/);if(id===0x23b)assert.throws(()=>nativeControllerResourceContract(m.reader,m.files,id),/unsupported guarded controller classification/);}
  }
  const files=new Map(n.files),file=files.get(43)!;files.set(43,{...file,end:file.end-4});const init=new ActorInitializer(n.reader,files,n.waves),r=init.resolve(input(0x23b,26));assert.equal(r.completed,false);assert.equal(r.status,"unsupported");assert.equal(r.instructionCount,0);
});

test("guarded308/34E dependencies and scoped24C/35C preview completion do not broaden",actual,()=>{
  const n=native();for(const [id,resources] of [[0x308,[27]],[0x34e,[61,96]]] as const){
    const r=n.init.resolve({...input(id,621),templateRoomId:465});assert.equal(r.status,"nonvisual");assert.equal(r.completed,false);
    const d=n.visuals.dependencies({...input(id,621),templateRoomId:465});assert.equal(d.completed,false);assert.equal(d.proofKind,"verified-controller-closure");for(const file of resources)assert.ok(d.fileIds.includes(file));
  }
  for(const [id,donor] of [[0x24c,306],[0x35c,193]]){const r=n.init.resolve(input(id,donor));assert.equal(r.status,"conditional");assert.equal(r.completed,false);assert.ok(r.bindings.length);assert.ok(r.loaderPreview);}
});
