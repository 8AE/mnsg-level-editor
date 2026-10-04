import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {NativeLinkedArena,NativeResourceRegistry,NATIVE_REGISTRY_BYTES,type NativeResourceImage,type NativeResourceContext} from "../core/rom/actor-init-resources";
import {importRomBytes,readFileTable} from "../core/rom";
import {RomReader} from "../core/rom/binary";
import {RenderWaves} from "../core/rom/waves";
import {decodePic} from "../core/rom/pic";

const BANK=0x80304000,ARENA=0x802f7000,DESCRIPTOR=0x80154c64;
const v=(b:Uint8Array)=>new DataView(b.buffer,b.byteOffset,b.byteLength);
const hash=(b:Uint8Array)=>createHash("sha256").update(b).digest("hex");
function context(size=0x100000):NativeResourceContext {
  const records=new Uint8Array(NATIVE_REGISTRY_BYTES);v(records).setUint32(4,BANK);
  return {bankStart:BANK,bankEnd:BANK+size,records,allocations:[]};
}
function image(id:number,size=64,codeTag=0):NativeResourceImage {
  return {fileId:id,namespace:"rsp",nativeStart:0x08000000+codeTag,nativeEnd:0x08000000+codeTag+size,interval:{lowerInclusive:1,upperExclusive:0x520,segment:8,codeTag},compressed:false,rawLength:2,rawCopy:Uint8Array.of(id&255,0x5a),parts:[]};
}
function arena(size=512){return NativeLinkedArena.initialize(DESCRIPTOR,ARENA,new Uint8Array(size).fill(0xa5));}

test("resource ownership, even raw copy, ordered parts and zero tail are independent of caller arrays",()=>{
  const ctx=context(),r=new NativeResourceRegistry(ctx),im=image(1,16);
  im.rawLength=3;im.rawCopy=Uint8Array.of(1,2,3,0xee);im.parts=[{destination:0x08000006,bytes:Uint8Array.of(7,8)},{destination:0x08000007,bytes:Uint8Array.of(9)}];
  assert.equal(r.load(1,()=>im),BANK+64);
  im.rawCopy.fill(0);im.parts[0].bytes.fill(0);ctx.records.fill(0);
  assert.deepEqual([...r.read(BANK,16)],[1,2,3,0xee,0,0,7,9,0,0,0,0,0,0,0,0]);
  const snap=r.snapshot();snap.allocations[0].bytes.fill(0);snap.records.fill(0);
  assert.equal(r.read(BANK,1)[0],1);assert.equal(r.lookup(0),0);assert.equal(r.lookup(2),-1);
  assert.throws(()=>r.read(BANK+15,2),/full span/);
  assert.throws(()=>r.read(BANK,.5),/Invalid/);
});

test("duplicate load returns live NEXT-slot DATA including tags introduced by a later append",()=>{
  const r=new NativeResourceRegistry(context());
  assert.equal(r.load(1,id=>image(id,70)),BANK+128);
  assert.equal(r.load(1,()=>{throw new Error("must not decode duplicate");}),BANK+128);
  const end=r.load(2,id=>image(id,65,0x40000000)),tagged=(BANK+4096+0x40000000)>>>0;
  assert.equal(r.lookup(2),tagged);assert.equal(end,BANK+4096+128);
  assert.equal(r.load(1,()=>{throw new Error("must not decode duplicate");}),tagged);
  assert.equal(r.load(2,()=>{throw new Error("must not decode duplicate");}),end);
  assert.throws(()=>r.read(BANK+69,2),/full span/);
});

test("explicit nonempty prefix retains occupancy and immutable payload ownership",()=>{
  const seeded=new NativeResourceRegistry(context());seeded.load(1,id=>image(id));seeded.load(2,id=>image(id,64,0x40000000));
  const prefix=seeded.snapshot(),r=new NativeResourceRegistry(prefix);prefix.allocations[0].bytes.fill(0);
  assert.equal(r.lookup(1),BANK);assert.equal(r.read(BANK,1)[0],1);
  assert.equal(r.load(3,id=>image(id)),BANK+4096+128);
  assert.equal(r.snapshot().allocations.length,3);
});

test("48-slot failure does not decode or mutate; a following duplicate still executes",()=>{
  const r=new NativeResourceRegistry(context());for(let id=1;id<=48;id++)r.load(id,n=>image(n,64,id===2?0x40000000:0));
  const before=r.snapshot();let calls=0;
  assert.equal(r.load(49,()=>{calls++;return image(49);}),0);assert.equal(calls,0);assert.deepEqual(r.snapshot(),before);
  assert.equal(r.loadList([49,1],()=>{calls++;throw new Error("must not decode");}),r.lookup(2));assert.equal(calls,0);
  assert.equal(r.loadList([49,48],()=>{throw new Error("must not decode");}),v(before.records).getUint32(48*8+4));
});

test("native list requests are sequential and retain earlier successes after a later rejection",()=>{
  const r=new NativeResourceRegistry(context());
  assert.throws(()=>r.loadList([1,2],id=>{if(id===2)throw new Error("PIC stream rejected");return image(id);}),/PIC stream/);
  assert.equal(r.lookup(1),BANK);assert.equal(r.lookup(2),-1);assert.equal(r.snapshot().allocations.length,1);
  const before=r.snapshot();assert.throws(()=>r.loadList([1,3],id=>({...image(id),rawCopy:new Uint8Array(1)})),/even-copy/);assert.deepEqual(r.snapshot(),before);
  assert.throws(()=>r.loadList([3,0],id=>image(id)),/file ID/);assert.equal(r.lookup(3),BANK+64);
  assert.throws(()=>r.loadList([],id=>image(id)),/unproven/);
  assert.equal(r.loadList([],id=>image(id),{emptyReturn:0x1234}),0x1234);
  assert.throws(()=>r.loadList([],id=>image(id),{emptyReturn:.5}),/Invalid/);
});

test("resource allocation descriptions reject identity, copy, interval, extent and part errors atomically",()=>{
  const r=new NativeResourceRegistry(context());r.load(1,id=>image(id));const before=r.snapshot();
  const invalid:((im:NativeResourceImage)=>NativeResourceImage)[]=[
    im=>({...im,fileId:3}),im=>({...im,compressed:true}),im=>({...im,nativeEnd:im.nativeStart-1}),
    im=>({...im,nativeEnd:0x09000000}),im=>({...im,rawLength:65,rawCopy:new Uint8Array(66)}),
    im=>({...im,rawLength:3,rawCopy:new Uint8Array(3)}),im=>({...im,interval:{...im.interval,segment:9}}),
    im=>({...im,interval:{...im.interval,lowerInclusive:3}}),im=>({...im,interval:{...im.interval,upperExclusive:2}}),
    im=>({...im,interval:{...im.interval,codeTag:256}}),im=>({...im,parts:[{destination:im.nativeStart-1,bytes:new Uint8Array(1)}]}),
    im=>({...im,parts:[{destination:im.nativeEnd-1,bytes:new Uint8Array(2)}]}),
    im=>({...im,parts:Array.from({length:4097},()=>({destination:im.nativeStart,bytes:new Uint8Array(0)}))}),
  ];
  for(const mutate of invalid){assert.throws(()=>r.load(2,id=>mutate(image(id))));assert.deepEqual(r.snapshot(),before);}
  const tiny=new NativeResourceRegistry(context(64));const empty=tiny.snapshot();
  assert.throws(()=>tiny.load(1,id=>image(id,65)),/owned bank/);assert.deepEqual(tiny.snapshot(),empty);
  tiny.load(1,id=>image(id));const filled=tiny.snapshot();assert.throws(()=>tiny.load(2,id=>image(id,1,0x40000000)),/even-copy|owned bank/);assert.deepEqual(tiny.snapshot(),filled);
});

test("supplied registry prefix and mutable native records fail closed when inconsistent",()=>{
  const r=new NativeResourceRegistry(context());r.load(1,id=>image(id));const good=r.snapshot();
  for(const change of [
    (c:NativeResourceContext)=>{c.allocations=[];},
    (c:NativeResourceContext)=>{v(c.records).setUint32(12,BANK+1);},
    (c:NativeResourceContext)=>{v(c.records).setUint16(16,3);},
    (c:NativeResourceContext)=>{v(c.records).setUint32(4,BANK+64);},
    (c:NativeResourceContext)=>{c.allocations[0].codeTag=0x40000000;c.allocations[0].address+=64;},
  ]){const c={...good,records:good.records.slice(),allocations:good.allocations.map(a=>({...a,bytes:a.bytes.slice()}))};change(c);assert.throws(()=>new NativeResourceRegistry(c));}
  v(r.records).setUint32(4,BANK+64);const corrupt=r.records.slice();let decoded=false;
  for(const action of [()=>r.snapshot(),()=>r.lookup(0),()=>r.read(BANK,1),()=>r.load(2,id=>{decoded=true;return image(id);})])assert.throws(action,/tagged base/);
  assert.equal(decoded,false);assert.deepEqual(r.records,corrupt);
});

test("CPU code namespaces accept only plain tagged 11 intervals with local 08 allocations",()=>{
  const r=new NativeResourceRegistry(context()),code={...image(45),namespace:"cpu-code" as const,interval:{lowerInclusive:13,upperExclusive:77,segment:0x11,codeTag:0x40000000}};
  assert.equal(r.load(45,()=>code),BANK+64);assert.equal(r.lookup(45),(BANK|0x40000000)>>>0);
  const before=r.snapshot();
  for(const malformed of [
    {...code,fileId:74,namespace:"rsp" as const},
    {...code,fileId:74,interval:{...code.interval,segment:0x12}},
    {...code,fileId:74,interval:{...code.interval,codeTag:0}},
    {...code,fileId:74,nativeStart:0x08000010},
    {...code,fileId:74,parts:[{destination:0x08000002,bytes:Uint8Array.of(7)}]},
  ]){assert.throws(()=>r.load(74,()=>malformed),/namespace|code tag/);assert.deepEqual(r.snapshot(),before);}
  const bounded=new NativeResourceRegistry(context(128));bounded.load(1,id=>image(id));const prefix=bounded.snapshot();
  assert.throws(()=>bounded.load(45,()=>code),/owned bank/);assert.deepEqual(bounded.snapshot(),prefix);
});

test("resource aggregate decoded-part and explicit bank budgets fail before append",()=>{
  const r=new NativeResourceRegistry(context()),before=r.snapshot(),large=new Uint8Array(12*1024*1024);
  assert.throws(()=>r.load(1,()=>({...image(1,large.length),parts:Array.from({length:3},()=>({destination:0x08000000,bytes:large}))})),/aggregate byte budget/);
  assert.deepEqual(r.snapshot(),before);
  assert.throws(()=>new NativeResourceRegistry({...context(),bankEnd:BANK+32*1024*1024+64}),/resource bank/);
  assert.throws(()=>new NativeResourceRegistry({...context(),records:new Uint8Array(NATIVE_REGISTRY_BYTES-8)}),/sentinel/);
});

test("raw native allocation extents reject asymmetric flags in both orientations before append",()=>{
  const r=new NativeResourceRegistry(context());r.load(1,id=>image(id));const before=r.snapshot();
  for(const [nativeStart,nativeEnd] of [[0x08000000,0x48000040],[0x48000000,0x08000040]]){
    const malformed={...image(2),nativeStart,nativeEnd,interval:{...image(2).interval,codeTag:nativeStart&0x40000000}};
    assert.throws(()=>r.load(2,()=>malformed),/raw allocation extent|flags differ/);assert.deepEqual(r.snapshot(),before);
  }
  const flagged=image(2,64,0x40000000);assert.equal(r.load(2,()=>flagged),BANK+4096+64);
  const entry=r.snapshot().allocations.find(a=>a.fileId===2)!;assert.equal(entry.bytes.length,64);assert.equal(entry.codeTag,0x40000000);
});

test("arena first fit uses native total rounding and real sorted reciprocal tail headers",()=>{
  const a=arena();assert.ok(a.bytes.every(b=>b===0));
  assert.equal(a.allocate(0x44),ARENA);const d=v(a.descriptor),b=v(a.bytes);
  assert.equal(d.getUint32(8),ARENA+0x70);assert.deepEqual([0,4,8,12].map(n=>b.getUint32(0x70+n)),[ARENA,0x80,0,0]);
  const second=a.allocate(1),third=a.allocate(1);assert.equal(second,ARENA+0x80);assert.equal(third,ARENA+0xc0);
  assert.equal(a.free(second),second);assert.equal(a.allocate(1),second);
  assert.equal(b.getUint32(0x78),ARENA+0xb0);assert.equal(b.getUint32(0xbc),ARENA+0x70);
  assert.equal(b.getUint32(0xb8),ARENA+0xf0);assert.equal(b.getUint32(0xfc),ARENA+0xb0);
});

test("arena free clears payload, padding and headers and unlinks head, middle, tail and only entry",()=>{
  for(const order of [[1,0,2],[0,2,1],[2,1,0]]){
    const a=arena(),p=[a.allocate(1),a.allocate(1),a.allocate(1)];for(const at of p)a.write(at,new Uint8Array(48).fill(0x5a));
    for(const i of order){assert.equal(a.free(p[i]),p[i]);assert.ok(a.read(p[i],64).every(b=>b===0));assert.equal(a.free(p[i]),0);}
    assert.equal(v(a.descriptor).getUint32(8),0);assert.ok(a.bytes.every(b=>b===0));
  }
  const a=arena();a.allocate(1);const before=a.snapshot();assert.equal(a.free(ARENA+1),0);assert.deepEqual(a.snapshot(),before);
});

test("arena capacity and arithmetic rejection preserve state; full-span writes stay atomic",()=>{
  const a=arena(64);a.allocate(1);const before=a.snapshot();assert.equal(a.allocate(1),0);assert.deepEqual(a.snapshot(),before);
  assert.throws(()=>a.allocate(0xffffffff),/overflows/);assert.deepEqual(a.snapshot(),before);
  for(const pointer of [DESCRIPTOR+.5,NaN,-1,0x100000000])assert.throws(()=>a.write(pointer,Uint8Array.of(1)),/Invalid/);
  assert.throws(()=>a.write(ARENA+63,new Uint8Array(2)),/owned span/);
  const invalidHeader=new Uint8Array(4);v(invalidHeader).setUint32(0,63);assert.throws(()=>a.write(ARENA+52,invalidHeader),/corrupt/);
  assert.deepEqual(a.snapshot(),before);const output=a.read(ARENA,1);output[0]=9;assert.equal(a.read(ARENA,1)[0],0);
  const original=new Uint8Array(64).fill(7);const own=NativeLinkedArena.initialize(DESCRIPTOR,ARENA,original);assert.ok(original.every(x=>x===7));assert.ok(own.bytes.every(x=>x===0));
});

test("CPU corruption is observed from authoritative bytes and every arena operation fails closed",()=>{
  const mutations=[
    (a:NativeLinkedArena)=>v(a.bytes).setUint32(56,ARENA+48), // self cycle
    (a:NativeLinkedArena)=>v(a.bytes).setUint32(124,0), // reciprocal link
    (a:NativeLinkedArena)=>v(a.bytes).setUint32(48,ARENA+1), // payload alignment
    (a:NativeLinkedArena)=>v(a.bytes).setUint32(52,63), // total alignment
    (a:NativeLinkedArena)=>v(a.bytes).setUint32(52,128), // header position
    (a:NativeLinkedArena)=>v(a.bytes).setUint32(112,ARENA), // overlap/order
    (a:NativeLinkedArena)=>v(a.bytes).setUint32(56,ARENA+512), // outside chain
    (a:NativeLinkedArena)=>v(a.descriptor).setUint32(8,ARENA-16), // outside head
  ];
  for(const mutate of mutations){const a=arena();a.allocate(1);a.allocate(1);mutate(a);const bytes=a.bytes.slice(),descriptor=a.descriptor.slice();
    for(const action of [()=>a.snapshot(),()=>a.allocate(1),()=>a.free(ARENA+7),()=>a.read(ARENA,1),()=>a.write(ARENA,Uint8Array.of(8))])assert.throws(action);
    assert.deepEqual(a.bytes,bytes);assert.deepEqual(a.descriptor,descriptor);
  }
});

test("arena contexts reject overlapping descriptors, incompatible extents and malformed supplied chains",()=>{
  const a=arena(),good=a.snapshot();
  assert.throws(()=>new NativeLinkedArena({...good,descriptorAddress:ARENA}),/overlap/);
  assert.throws(()=>new NativeLinkedArena({...good,descriptorAddress:DESCRIPTOR+1}),/Invalid/);
  assert.throws(()=>new NativeLinkedArena({...good,bytes:new Uint8Array(1)}),/extent/);
  const descriptor=good.descriptor.slice();v(descriptor).setUint32(0,ARENA+1);assert.throws(()=>new NativeLinkedArena({...good,descriptor}),/extent/);
  a.allocate(1);a.write(ARENA,Uint8Array.of(23));const restored=new NativeLinkedArena(a.snapshot());a.bytes[0]=99;assert.equal(restored.read(ARENA,1)[0],23);
});

test("canonical ROM code hashes and 14-file reconstructed outputs match archived native evidence",{skip:!process.env.MNSG_TEST_ROM},()=>{
  const db=importRomBytes(readFileSync(process.env.MNSG_TEST_ROM!)),before=hash(db.bytes),reader=new RomReader(db.bytes);
  for(const [at,size,expected] of [
    [0x14714,0xf8,"dd765e24fcbae49c2ced2466aee0497974b9129596388f121f07c44788da3572"],
    [0x154f0,0x138,"ab1ee8c7c6baef7bfe86ec795028fe37c941f927f92ba71729e064a9005f6bc6"],
    [0x154c0,0x30,"6ded35b26566e2f334363759c07d862eca07b8a84c2ec9fe6870bf97bc893814"],
    [0x15774,0x8c,"fa6c65eec23dcccdb66bcb2f5061c11853ad4384c3b5b0706ea0ce30ea6b3051"],
    [0x29f4,0x5c,"473fb38eff509e62825ece5edadc989c5a9f4ce861b35af8257cda91a2852d37"],
    [0x2a50,0x60,"8e41cf0dd7288f559d5535debdc7f807389d7dd517b7ece2bedf4e1573931c17"],
  ] as const)assert.equal(hash(db.bytes.subarray(at,at+size)),expected);
  const files=new Map(readFileTable(db.bytes).map(f=>[f.id,f]));
  const interval=(id:number)=>{let lowerInclusive=0;for(let at=0x55510;at<0x556c4;at+=4){const upperExclusive=reader.u16(at);if(!upperExclusive)break;if(id<upperExclusive)return {lowerInclusive,upperExclusive,codeTag:db.bytes[at+3]===0x11?0x40000000:reader.u32(0x556c4+id*8)&0x40000000,segment:db.bytes[at+3]};lowerInclusive=upperExclusive;}throw new Error("No native interval");};
  const waves=new RenderWaves(reader,files,id=>interval(id).segment);
  // Existing independently verified packed-resource/PIC decoder; no original assets committed.
  const packed=waves as unknown as {resource(id:number):Uint8Array};
  const provider=(id:number):NativeResourceImage=>{const f=files.get(id)!;let at=reader.u32(0x6a51c+id*4)-0x80000000+0xc00;const parts:NativeResourceImage["parts"][number][]=[];
    for(let n=0;n<4096;n++,at+=8){const part=reader.u32(at);if(!part)break;parts.push({destination:reader.u32(at+4),bytes:decodePic(packed.resource(part))});if(n===4095)throw new Error("Part terminator");}
    const rawLength=f.end-f.start,entry=interval(id);return {fileId:id,namespace:entry.segment===0x11&&entry.codeTag?"cpu-code":"rsp",nativeStart:reader.u32(0x556c4+id*8),nativeEnd:reader.u32(0x556c4+id*8+4),interval:entry,compressed:f.compressed,rawLength,rawCopy:db.bytes.slice(f.start,f.start+Math.ceil(rawLength/2)*2),parts};};
  // Explicit hypothetical empty prefix tests arithmetic only; not a live room registry claim.
  const r=new NativeResourceRegistry({...context(),bankEnd:0x80594000});
  const ids=[573,574,576,716,696,718,717,407,575,572,365,369,345,374];
  assert.equal(r.loadList(ids,provider),0x8034be80);const allocations=r.snapshot().allocations;
  assert.equal(allocations.reduce((n,a)=>n+a.bytes.length,0),294128);
  for(const a of allocations)assert.equal(hash(r.read(a.address,a.bytes.length)),hash(waves.wave(a.fileId)),`File ${a.fileId}`);
  assert.equal(hash(allocations.find(a=>a.fileId===572)!.bytes),"f7bfe44c303d98d6a5848d13243d54603c132a5061a1c320624d25e0080f25ef");
  assert.equal(hash(allocations.find(a=>a.fileId===365)!.bytes),"8947b954982e53c6946240040be44e2b956008c7b3c4d2a564d8989ebb2528a3");
  const codeRegistry=new NativeResourceRegistry(context());codeRegistry.load(573,provider);
  assert.deepEqual([...db.bytes.subarray(0x55524,0x55528)],[0,81,0,17]);
  for(const id of [45,74]){const im=provider(id);assert.equal(im.namespace,"cpu-code");assert.equal(im.interval.segment,0x11);assert.equal(im.interval.codeTag,0x40000000);assert.equal(im.parts.length,0);
    assert.deepEqual([im.interval.lowerInclusive,im.interval.upperExclusive],[7,81]);assert.equal(reader.u32(0x6a51c+id*4),0x80065798);assert.equal(reader.u32(0x66398),0);
    codeRegistry.load(id,()=>im);const entry=codeRegistry.snapshot().allocations.find(a=>a.fileId===id)!;
    assert.equal(entry.address%4096,0);assert.equal(codeRegistry.lookup(id),(entry.address|0x40000000)>>>0);
    assert.equal(entry.bytes.length,id===45?9936:16192);assert.deepEqual(entry.bytes.slice(0,im.rawLength),im.rawCopy.slice(0,im.rawLength));assert.ok(entry.bytes.slice(im.rawLength).every(b=>b===0));
    assert.equal(hash(entry.bytes),id===45?"2145e09369ad67285581573e66f293c4dd0f457042ed8348e056a22d4312dca2":"b9a902fad9e97ff47d2f1b5a629dd3b550d76c8b96221a6c2b9282b345a3fb78");
  }
  const a=arena(0xa000);assert.equal(a.allocate(0x44),ARENA);assert.equal(v(a.descriptor).getUint32(8),ARENA+0x70);assert.equal(a.free(ARENA),ARENA);
  assert.equal(hash(db.bytes),before);
});
