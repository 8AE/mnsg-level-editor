import {createHash} from "node:crypto";
import {RomReader} from "./binary";
import {readFileTable,type RomFile} from "./decompress";
import type {NativeActorControllerClassification} from "./actor-controller-classification";

const ROM_SHA256="e40bee20508c2e29e651dca4e47504e40f908f0a2186e34a582784bf5a64be4c";
const BODY_SHA256="691e766163b1b8288cf1e76b4dc9eb7dde764cde7f749bf5aef916d919300f2b";
const ENTRIES:ReadonlyMap<number,{entry:number;overlay:number;fileId:number;rom:number}>=new Map([
  [0x079,{entry:0x080005d0,overlay:24,fileId:24,rom:0x6acb20}],
  [0x07a,{entry:0x80214f2c,overlay:0,fileId:12,rom:0x5d03fc}],
  [0x07b,{entry:0x80214fb0,overlay:0,fileId:12,rom:0x5d0480}],
  [0x07c,{entry:0x0800018c,overlay:24,fileId:24,rom:0x6ac6dc}],
]);
const FILES:ReadonlyMap<number,{start:number;end:number;allocationStart:number;allocationEnd:number;zeroTail:number;sha256:string}>=new Map([
  [12,{start:0x5c8770,end:0x5f6840,allocationStart:0x8020d2a0,allocationEnd:0x8023b450,zeroTail:0xe0,sha256:"1fe5547a5899a34c0cb94c3ca56576d88509c4cff9f7682202627e0df0eddc4e"}],
  [24,{start:0x6ac550,end:0x6ad3c0,allocationStart:0x08000000,allocationEnd:0x08000e80,zeroTail:0x10,sha256:"9b31e9e5fc9e7a30886bf5a240bd658b7fabf1360908f0e6c633df5d6a3ea43b"}],
]);
const FIXED_GUARDS:readonly (readonly [string,number,number,string])[]=[
  ["fixed loader 800203D4",0x20fd4,0x6c,"4e03628ca64d47eecfca1fb884f6ad29b37089ff7e7c427250ba8ddf54372f4b"],
  ["world startup 8001F914",0x20514,0x2c,"246e2a939cb0147a3ffeece60b6a0ff31e949381c7ecfb74bf5b8b521e557f13"],
  ["stage common 80020440",0x21040,0x294,"975d60c82aaf76d0b680553afa2c2b97b5a0e15030e09cbb2bfc3dd0ccba0596"],
  ["13 fixed stage pairs",0x6c33c,0x34,"0734a12dd6c13adcc8180e885a998048403faa32cbdfa844e8d36b7b6e86059c"],
];
const hash=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");
const hex=(value:number)=>`0x${value.toString(16)}`;

/** Metadata only: never executes instructions, creates work, or admits an actor to a destination stage.
 * Selected calls revalidate mutable bytes and supplied records; unrelated IDs touch neither input.
 * A separate resource-contract consumer may use dynamic File24's finite static closure.
 */
export function nativeEmptyControllerClassification(reader:RomReader,files:ReadonlyMap<number,RomFile>,actorId:number):NativeActorControllerClassification|undefined {
  const selected=ENTRIES.get(actorId);if(!selected)return undefined;
  try {
    if(reader.bytes.length!==0x2000000)throw new Error("canonical 32 MiB normalized US ROM is truncated or has a changed length");
    if(reader.u32(0x5e3c8c+actorId*4)!==selected.entry||reader.i16(0x5e4ca6+actorId*2)!==selected.overlay)throw new Error("selected initializer entry/signed overlay identity changed");
    const expected=FILES.get(selected.fileId)!,file=files.get(selected.fileId),actual=readFileTable(reader.bytes).find(file=>file.id===selected.fileId);
    if(!file||!actual||file.id!==selected.fileId||file.start!==actual.start||file.end!==actual.end||file.compressed!==actual.compressed||file.compressed||file.start!==expected.start||file.end!==expected.end)throw new Error("selected native/supplied file identity, bounds or plain-copy semantics changed");
    const allocation=0x556c4+selected.fileId*8;
    if(reader.u32(allocation)!==expected.allocationStart||reader.u32(allocation+4)!==expected.allocationEnd||expected.allocationEnd-expected.allocationStart-(file.end-file.start)!==expected.zeroTail)throw new Error("selected native allocation/BSS extent changed");
    if(reader.u32(0x6a51c+selected.fileId*4)!==0x80065798||reader.u32(0x66398)!==0)throw new Error("selected empty PIC-parts pointer/terminator changed");
    if(selected.rom!==file.start+selected.entry-expected.allocationStart||selected.entry+12>expected.allocationStart+file.end-file.start)throw new Error("selected fixed/dynamic CPU namespace changed");
    reader.check(selected.rom,12,file.end);
    // Complete native body: sw a0,0(sp); jr ra; sw a1,4(sp) in the delay slot.
    if(reader.u32(selected.rom)!==0xafa40000||reader.u32(selected.rom+4)!==0x03e00008||reader.u32(selected.rom+8)!==0xafa50004||hash(reader.bytes.subarray(selected.rom,selected.rom+12))!==BODY_SHA256)throw new Error("complete 12-byte empty body preimage changed");
    if(hash(reader.bytes.subarray(file.start,file.end))!==expected.sha256)throw new Error("selected full raw file preimage changed");
    if(selected.fileId===12)for(const [name,at,size,sha] of FIXED_GUARDS){reader.check(at,size);if(hash(reader.bytes.subarray(at,at+size))!==sha)throw new Error(`${name} preimage changed`);}
    if(hash(reader.bytes)!==ROM_SHA256)throw new Error("canonical normalized US ROM SHA256 identity changed");
    const provenance=[`Guarded canonical normalized US ROM SHA256 ${ROM_SHA256}. Metadata classification executes no native behavior; CPU completion is not asserted.`,
      `Actor${hex(actorId)} entry${hex(selected.entry)}, registry overlay${selected.overlay}, actual File${selected.fileId} CPU base${hex(expected.allocationStart)}, ROM${hex(selected.rom)}, complete 12-byte empty body SHA256 ${BODY_SHA256}.`];
    if(selected.fileId===24)return {entry:selected.entry,overlay:selected.overlay,completed:false,resourceFileIds:[24],provenance:[...provenance,"Finite static constructor dependency is dynamic plain File24 only, including its 16-byte zero-filled allocation tail. A separate guarded export resource contract is required; metadata does not execute or complete the CPU."],reason:"Registered empty native constructor has no intrinsic 3D mesh, model bind, dynamic request, child scheduling or future callback. Its entire body only spills the two incoming arguments to stack home slots. File24 is a static code dependency, not a visual asset or CPU execution result."};
    return {entry:selected.entry,overlay:selected.overlay,completed:false,provenance:[...provenance,"Fixed loader 800203D4, world startup 8001F914, stage common 80020440 and all 13 stage-pair preimages verified. Fixed upper File12 is selected only in native stages 0–3 and 11; actual destination readiness remains conditional."],reason:"Registered empty native constructor has no intrinsic 3D mesh or dynamic resource request. Its fixed File12 CPU entry requires native stages 0–3 or 11 readiness; other stages may replace this upper overlay. Do not load File12 through the dynamic registry or infer foreign-stage admission from the empty body. No runtime state or CPU behavior is executed."};
  }catch(issue){throw new Error(`Actor${hex(actorId)} unsupported guarded empty-controller classification: ${issue instanceof Error?issue.message:String(issue)}.`);}
}
