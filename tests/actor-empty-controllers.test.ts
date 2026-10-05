import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {importRomBytes,readFileTable} from "../core/rom";
import {RomReader} from "../core/rom/binary";
import type {RomFile} from "../core/rom/decompress";
import {nativeEmptyControllerClassification as classify} from "../core/rom/actor-empty-controllers";
const actual={skip:!process.env.MNSG_TEST_ROM},ids=[0x79,0x7a,0x7b,0x7c],hash=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");
let bytes:Uint8Array;
function fixture(){bytes??=importRomBytes(readFileSync(process.env.MNSG_TEST_ROM!)).bytes;return {bytes,reader:new RomReader(bytes),files:new Map(readFileTable(bytes).map(f=>[f.id,f]))};}

test("unmatched/adjacent IDs return before any ROM or file-map access",()=>{
  const throwing=new Proxy({}, {get:()=>{throw Error("Input was touched");}});
  for(const id of [0x78,0x7d,0x77,0x7e,0,0x23b,-1,NaN,Infinity])assert.equal(classify(throwing as RomReader,throwing as ReadonlyMap<number,RomFile>,id),undefined);
});

test("exact dynamic24 and fixed12 entries expose no CPU completion or inferred fixed admission",actual,()=>{
  const {reader,files}=fixture();
  for(const [id,entry,overlay] of [[0x79,0x080005d0,24],[0x7a,0x80214f2c,0],[0x7b,0x80214fb0,0],[0x7c,0x0800018c,24]]){
    const r=classify(reader,files,id)!;assert.equal(r.entry,entry);assert.equal(r.overlay,overlay);assert.equal(r.completed,false);assert.match(r.provenance.join(" "),/CPU completion is not asserted/);assert.match(r.reason,/empty native constructor/);
    if(overlay===24){assert.deepEqual(r.resourceFileIds,[24]);assert.match(r.provenance.join(" "),/static constructor dependency.*File24/);assert.match(r.provenance[1],/CPU base0x8000000/);}
    else{assert.equal(r.resourceFileIds,undefined);assert.match(r.reason,/stages 0–3 or 11/);assert.match(r.reason,/Do not load File12 through the dynamic registry/);assert.match(r.provenance[1],/CPU base0x8020d2a0/);}
  }
});

test("ROM, supplied records and previous returned metadata remain independent and immutable",actual,()=>{
  const {reader,files,bytes}=fixture(),before=hash(bytes),records=JSON.stringify([...files]);
  const a=classify(reader,files,0x79)!;a.resourceFileIds![0]=12;a.provenance[0]="untrusted";a.completed=true;
  const b=classify(reader,files,0x79)!;assert.equal(b.completed,false);assert.deepEqual(b.resourceFileIds,[24]);assert.notEqual(b.provenance[0],"untrusted");
  assert.equal(hash(bytes),before);assert.equal(JSON.stringify([...files]),records);
});

test("selected constructor, entry/overlay, allocation/BSS and PIC preimages are rechecked after valid calls",actual,()=>{
  const {bytes,files}=fixture(),changed=bytes.slice(),reader=new RomReader(changed);
  for(const [id,body,file] of [[0x79,0x6acb20,24],[0x7a,0x5d03fc,12],[0x7b,0x5d0480,12],[0x7c,0x6ac6dc,24]]){
    assert.ok(classify(reader,files,id));
    for(const at of [body,body+4,body+8,0x5e3c8c+id*4,0x5e4ca6+id*2+1,0x556c4+file*8,0x556c4+file*8+7,0x6a51c+file*4,0x66398]){changed[at]^=1;assert.throws(()=>classify(reader,files,id),/unsupported guarded empty-controller classification/);changed[at]^=1;}
  }
  assert.equal(hash(changed),hash(bytes));
});

test("signed overlay replacement and fixed/dynamic CPU namespaces cannot substitute another mapping",actual,()=>{
  const {bytes,files}=fixture(),changed=bytes.slice(),reader=new RomReader(changed),v=reader.view;
  for(const id of ids){const at=0x5e4ca6+id*2,old=reader.i16(at);v.setInt16(at,-1);assert.throws(()=>classify(reader,files,id),/signed overlay identity changed/);v.setInt16(at,old);}
  v.setUint32(0x55724,0x08000000);assert.throws(()=>classify(reader,files,0x7a),/allocation\/BSS extent changed/);v.setUint32(0x55724,0x8020d2a0);
  v.setUint32(0x55784,0x8020d2a0);assert.throws(()=>classify(reader,files,0x79),/allocation\/BSS extent changed/);v.setUint32(0x55784,0x08000000);
  assert.equal(hash(changed),hash(bytes));
});

test("fixed stage readiness evidence remains guarded without admitting other stages",actual,()=>{
  const {bytes,files}=fixture(),changed=bytes.slice(),reader=new RomReader(changed);
  for(const at of [0x20fd4,0x20514,0x21040,0x6c33c,0x6c33c+12*4+3]){changed[at]^=1;for(const id of [0x7a,0x7b])assert.throws(()=>classify(reader,files,id),/preimage changed/);changed[at]^=1;}
  assert.equal(hash(changed),hash(bytes));
});

test("supplied file identity, missing file, bounds and compression corruption fail closed",actual,()=>{
  const {reader,files}=fixture();for(const [id,fileId] of [[0x79,24],[0x7a,12],[0x7b,12],[0x7c,24]]){
    for(const mutation of [{id:fileId+1},{start:files.get(fileId)!.start+4},{end:files.get(fileId)!.end-4},{compressed:true}]){const map=new Map(files);map.set(fileId,{...files.get(fileId)!,...mutation});assert.throws(()=>classify(reader,map,id),/file identity, bounds or plain-copy semantics changed/);}
    const map=new Map(files);map.delete(fileId);assert.throws(()=>classify(reader,map,id),/file identity, bounds or plain-copy semantics changed/);
  }
});

test("raw file, native file table, canonical full hash and truncation stay mandatory",actual,()=>{
  const {bytes,files}=fixture(),changed=bytes.slice(),reader=new RomReader(changed);
  for(const [id,at,reason] of [[0x79,0x6ac550,/full raw file preimage/],[0x7a,0x5c8770,/full raw file preimage/],[0x79,0x58037,/file identity/],[0x7a,0x58007,/file identity/],[0x79,0x3e,/SHA256 identity/]] as const){changed[at]^=1;assert.throws(()=>classify(reader,files,id),reason);changed[at]^=1;}
  for(const size of [64,0x5d03fc,0x6ad3bf,bytes.length-1])for(const id of ids)assert.throws(()=>classify(new RomReader(bytes.subarray(0,size)),files,id),/truncated or has a changed length/);
  assert.equal(hash(changed),hash(bytes));
});
