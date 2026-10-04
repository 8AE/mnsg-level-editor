import type {Vec3} from "../../shared/types";
import {RomReader} from "./binary";
import type {RomFile} from "./decompress";
import type {RenderWaves} from "./waves";
import {InitMachine,type InitMemory} from "./actor-init-machine";

export interface NativeActorInitInput {actorId:number;parameters:number[];position:Vec3;rotation:Vec3;unknownHalfword?:number;roomId?:number}
export interface NativeActorBinding {
  identity:number;slot:number;modelPointer:number;materialPointer:number;
  segments:{segment:number;fileId:number;offset:number}[];
  scale:Vec3;rotation:Vec3;position:Vec3;positionOffset:Vec3;
  rotationOverrideMask:{x:boolean;y:boolean;z:boolean};
  animationFrame:number;animationBlendCountdown:number;
  provenance:string[];objectIndex:number;
}
export interface NativeActorInitResult {
  bindings:NativeActorBinding[];
  status:"resolved"|"conditional"|"nonvisual"|"unsupported";
  diagnostics:string[];instructionCount:number;
  failureKind?:"scene-gated"|"unresolved";
  branches:{pc:number;taken:boolean;target:number}[];
  deferredCallbacks:number[];
  syntheticMemory:{address:number;bytes:Uint8Array}[];
  readonlyMemory:{address:number;fileId:number;byteLength:number}[];
}
interface Region {start:number;bytes:Uint8Array;readonly?:boolean}
interface ObjectState {address:number;task:number;index:number;identity?:number;slot?:number;segments:Map<number,{fileId:number;offset:number}>;rotationMask:{x:boolean;y:boolean;z:boolean};provenance:string[]}
const hex=(n:number)=>`0x${(n>>>0).toString(16)}`;
const AXES=["x","y","z"] as const;
const STOP=0xfffffff0;
class NativeSceneStateError extends Error {}
// Independently traced complete controller bodies, not actor→model guesses.
// Entry+overlay checks keep classification tied to the canonical implementation.
const MESH_FREE_CONTROLLERS=new Map<number,{entry:number;overlay:number;reason:string}>([
  [0x8c,{entry:0x802151e0,overlay:0,reason:"Native destination/transition trigger has no 3D model declaration."}],
  [0x8e,{entry:0x80215a74,overlay:0,reason:"Native room camera/start-state initializer removes its task without a 3D model."}],
  [0x90,{entry:0x80215b8c,overlay:0,reason:"Native camera/trigger table initializer removes its task without a 3D model."}],
  [0x31d,{entry:0x80221894,overlay:0,reason:"Native timer/speech controller has no intrinsic 3D model."}],
  [0x2ee,{entry:0x80221964,overlay:0,reason:"Native conditional speech-controller wrapper has no intrinsic 3D model."}],
  [0x308,{entry:0x080020f4,overlay:27,reason:"Native camera-controller allocator has no intrinsic 3D model."}],
  [0x3cc,{entry:0x80215ca4,overlay:0,reason:"Native menu/UI overlay controller has no world 3D model."}],
  [0x34e,{entry:0x0800098c,overlay:61,reason:"Native progression/script removal controller has no intrinsic 3D model."}],
  [0x33d,{entry:0x802219d4,overlay:0,reason:"Native scene/speech control wrapper has no intrinsic 3D model."}],
  [0x2dc,{entry:0x08002740,overlay:60,reason:"Native menu/script scheduler has no world 3D model."}],
  [0x3e1,{entry:0x08000c90,overlay:56,reason:"Native distance-based sound controller has no 3D display binders."}],
]);

/** Private synthetic state overlays canonical ROM bytes; original assets never change. */
class ActorMemory implements InitMemory {
  readonly regions:Region[]=[];
  readonly privateBytes=new Map<number,number>();
  readonly unknownReads=new Set<number>();
  next=0x81000000;phase=false;codeFile=0;
  readonly resourceBases=new Map<number,number>();
  readonly resourceSegments=new Map<number,number>();
  nextWave=0x82000000;
  onWrite?:(address:number,size:number)=>void;
  constructor(readonly reader:RomReader,readonly files:Map<number,RomFile>){}
  allocate(size:number):number {
    if(this.next+size>0x81200000)throw new Error("Synthetic actor memory budget exceeded.");
    const address=this.next;this.next=((this.next+size+15)&~15)>>>0;
    this.regions.push({start:address,bytes:new Uint8Array(size)});return address;
  }
  wave(fileId:number,segment:number,bytes:Uint8Array):number {
    const existing=this.resourceBases.get(fileId);if(existing!==undefined)return existing;
    if(bytes.length>16*1024*1024||this.nextWave+bytes.length>0xbf000000)throw new Error("Synthetic readonly wave budget exceeded.");
    const base=this.nextWave;this.nextWave=Math.ceil((base+bytes.length)/0x10000)*0x10000;
    this.regions.push({start:base,bytes,readonly:true});this.resourceBases.set(fileId,base);this.resourceSegments.set(segment,base);return base;
  }
  romOffset(address:number,size:number):number|undefined {
    if(address>=0x80000400&&address+size<=0x8007e020)return this.reader.check(address-0x80000000+0xc00,size);
    for(const [fileId,base] of [[11,0x801cb460],[12,0x8020d2a0]]) {
      const file=this.files.get(fileId);if(file&&address>=base&&address+size<=base+file.end-file.start)return this.reader.check(file.start+address-base,size,file.end);
    }
    if(address>=0x08000000&&address+size<=0x09000000&&this.codeFile){const file=this.files.get(this.codeFile);if(file&&!file.compressed)return this.reader.check(file.start+(address&0xffffff),size,file.end);}
    return undefined;
  }
  read(address:number,size:number):Uint8Array {
    if(!Number.isSafeInteger(address)||!Number.isSafeInteger(size)||size<0||address<0||address+size>0x100000000)throw new Error("Invalid offline native memory read.");
    const output=new Uint8Array(size);
    for(let i=0;i<size;i++){
      const at=address+i,privateValue=this.privateBytes.get(at);
      if(privateValue!==undefined){output[i]=privateValue;continue;}
      const region=this.regions.find(region=>at>=region.start&&at<region.start+region.bytes.length);
      if(region){output[i]=region.bytes[at-region.start];continue;}
      const offset=this.romOffset(at,1);
      if(offset!==undefined){output[i]=this.reader.bytes[offset];continue;}
      // Live engine/save/player BSS has no canonical ROM initial value. The
      // provisional zero is explicitly conditional, never evidence of absence.
      if(at>=0x8007e020&&at<0x801cb460){this.unknownReads.add(at);output[i]=0;continue;}
      throw new Error(`Unmapped offline native read at ${hex(at)}.`);
    }
    return output;
  }
  write(address:number,bytes:Uint8Array):void {
    if((address<0x80000400||address+bytes.length>0x81400000)&&!this.regions.some(r=>!r.readonly&&address>=r.start&&address+bytes.length<=r.start+r.bytes.length)&&!(this.codeFile&&address>=0x08000000&&address+bytes.length<=0x09000000&&this.romOffset(address,bytes.length)!==undefined))throw new Error(`Unmapped offline native write at ${hex(address)}.`);
    if(this.privateBytes.size+bytes.length>2*1024*1024)throw new Error("Synthetic native write budget exceeded.");
    for(let i=0;i<bytes.length;i++){
      const at=address+i,region=this.regions.find(region=>at>=region.start&&at<region.start+region.bytes.length);
      if(region)region.bytes[at-region.start]=bytes[i];else this.privateBytes.set(at,bytes[i]);
    }
    if(this.phase)this.onWrite?.(address,bytes.length);
  }
}

/** ROM-driven initializer evaluation. Actor IDs never act as a guessed model ID. */
export class ActorInitializer {
  constructor(readonly reader:RomReader,readonly files:Map<number,RomFile>,readonly waves:Pick<RenderWaves,"wave">){}
  resolve(input:NativeActorInitInput):NativeActorInitResult {
    const observed=new Set<number>(),initial=new Map<number,boolean>();
    const baseline=this.evaluate(input,initial,observed,12000);let used=baseline.instructionCount;
    if(baseline.bindings.length||baseline.status==="nonvisual"||!observed.size)return baseline;
    const queue:Map<number,boolean>[]=[],visited=new Set<string>();
    const key=(state:Map<number,boolean>)=>[...state].filter(([,v])=>v).map(([id])=>id).sort((a,b)=>a-b).join(",");
    const enqueue=(state:Map<number,boolean>,queried:Set<number>)=>{for(const id of queried){const next=new Map(state);next.set(id,!state.get(id));const signature=key(next);if(!visited.has(signature)){visited.add(signature);queue.push(next);}}};
    visited.add("");enqueue(initial,observed);
    for(let attempt=0;attempt<7&&queue.length&&used<12000;attempt++){
      const state=queue.shift()!,queried=new Set<number>(),candidate=this.evaluate(input,state,queried,12000-used);used+=candidate.instructionCount;
      if(candidate.bindings.length){candidate.status="conditional";candidate.failureKind??="scene-gated";candidate.instructionCount=used;
        const conditions=[...queried].sort((a,b)=>a-b).map(id=>`flag ${hex(id)} ${state.get(id)?"set":"clear"}`).join(", ");
        candidate.diagnostics.unshift(`Possible native progression state explored: ${conditions}. Actual save-state visibility is unknown.`);
        for(const binding of candidate.bindings)binding.provenance.push(`conditional native progression predicates: ${conditions}`);
        return candidate;
      }
      enqueue(state,queried);
    }
    baseline.instructionCount=used;baseline.diagnostics.push("Bounded progression-state alternatives produced no model declaration; visual behavior remains unresolved.");return baseline;
  }
  private evaluate(input:NativeActorInitInput,progression:Map<number,boolean>,observedFlags:Set<number>,instructionLimit:number):NativeActorInitResult {
    const diagnostics:string[]=[],bindings:NativeActorBinding[]=[],callbacks:number[]=[];
    const result:NativeActorInitResult={bindings,status:"unsupported",diagnostics,instructionCount:0,branches:[],deferredCallbacks:callbacks,syntheticMemory:[],readonlyMemory:[]};
    const memory=new ActorMemory(this.reader,this.files),objects:ObjectState[]=[];
    let currentTask=0,allocationCount=0,removed=false;
    const children:{task:number;entry:number;codeFile:number}[]=[];
    const cpu=new InitMachine(memory,{instructions:instructionLimit,callDepth:64},(pc,machine)=>intercept(pc,machine));
    const word=(at:number)=>cpu.u32(at),half=(at:number)=>cpu.u16(at),put=(at:number,value:number,size=4)=>cpu.store(at,value,size);
    const float=(at:number)=>cpu.fromBits(word(at)),setFloat=(at:number,value:number)=>put(at,cpu.floatBits(value));
    const objectFor=(task:number)=>{const address=word(task+0x18);const object=objects.find(object=>object.address===address);if(!object)throw new Error("Native helper requires a validated synthetic task/object.");return object;};
    const createObject=(task:number,defaults=true):ObjectState=>{
      if(++allocationCount>64)throw new Error("Native constructor object budget exceeded.");
      const address=memory.allocate(0x100),object:ObjectState={address,task,index:objects.length,segments:new Map(),rotationMask:{x:false,y:false,z:false},provenance:[]};objects.push(object);
      if(defaults){for(const offset of [0x1c,0x20,0x24])setFloat(address+offset,0.1);put(address+0x30,0xc006d920);put(address+5,2,1);}
      const old=word(task+0x18);if(!old)put(task+0x18,address);else put(word(task+0x1c),address);
      put(task+0x1c,address);return object;
    };
    const segmentFor=(fileId:number)=>{
      for(let at=0x55510;at<0x55910;at+=4){const threshold=this.reader.u16(at);if(!threshold)break;if(fileId<threshold)return this.reader.bytes[at+3];}
      throw new Error(`Native file ${fileId} has no segment mapping.`);
    };
    const resource=(fileId:number):Uint8Array=>{
      const file=this.files.get(fileId);if(!file||file.compressed)throw new Error(`Native resource ${hex(fileId)} is unavailable.`);
      // Registry141C4 also exposes code/path/plain-data files, whose allocation
      // is not a graphics/PIC wave. Read those canonical file bytes directly.
      try{return this.waves.wave(fileId);}catch(error){
        const start=this.reader.u32(0x556c4+fileId*8),end=this.reader.u32(0x556c4+fileId*8+4),length=end-start,parts=this.reader.u32(0x6a51c+fileId*4),partsAt=memory.romOffset(parts,4);
        if(partsAt===undefined||this.reader.u32(partsAt)!==0||length<file.end-file.start||length>16*1024*1024||(end>>>24)!==(start>>>24))throw new Error(`Native resource ${hex(fileId)}: ${error instanceof Error?error.message:String(error)}`);
        const bytes=new Uint8Array(length);bytes.set(this.reader.bytes.subarray(file.start,file.end));return bytes;
      }
    };
    const bind=(task:number,object:ObjectState,identity:number,slot:number,type:number)=>{
      if(!Number.isSafeInteger(identity)||identity<0||identity>0x406||!Number.isSafeInteger(slot)||slot<0||slot>=128)throw new Error("Native model selector exceeds the bounded registry.");
      const descriptor=this.reader.u32(0x5f1e54+identity*4),descriptorAt=memory.romOffset(descriptor,12);
      if(descriptorAt===undefined)throw new Error(`Unmapped native model descriptor for identity ${hex(identity)}.`);
      const filesAt=memory.romOffset(this.reader.u32(descriptorAt),4),slotsAt=memory.romOffset(this.reader.u32(descriptorAt+4)+slot*4,4);
      if(filesAt===undefined||slotsAt===undefined)throw new Error("Native model file pair or slot pointer is not resident.");
      const primary=this.reader.u16(filesAt),secondary=this.reader.u16(filesAt+2),model=this.reader.u32(slotsAt);
      if(!model)throw new Error(`Native identity ${hex(identity)} has an empty model slot ${slot}.`);
      object.identity=identity;object.slot=slot;object.segments.clear();
      for(const fileId of [primary,secondary,0x152])if(fileId){const segment=segmentFor(fileId);memory.wave(fileId,segment,this.waves.wave(fileId));object.segments.set(segment,{fileId,offset:0});}
      put(object.address+0x2c,(model+type)>>>0);
      for(let index=0;index<6;index++){
        const mapped=object.segments.get(8+index);put(object.address+0x34+index*8,mapped?.fileId??0,2);put(object.address+0x38+index*8,mapped?memory.resourceBases.get(mapped.fileId)!:0);
      }
      object.provenance.push(`native helper ${hex(cpu.pc)} selected identity ${hex(identity)}, slot ${slot}, type ${hex(type)}`);
    };
    const resetScale=(object:ObjectState)=>{for(const at of [0x1c,0x20,0x24])setFloat(object.address+at,0.1);};
    const animated=(task:number,object:ObjectState,slot:number,stepBits:number,loop:number)=>{
      bind(task,object,half(task+0x5e),slot,0x10000000);
      put(object.address+0x7e,Math.floor(cpu.fromBits(stepBits)*256),2);put(object.address+0x7c,loop&255,1);
      let frame=0;
      if(word(task+0x60)&0x01000000){const model=word(object.address+0x2c)&0x8ffffffe,mapped=object.segments.get(model>>>24);if(!mapped)throw new Error("Animated model has no bound wave.");const wave=this.waves.wave(mapped.fileId),at=(model&0xffffff)+mapped.offset;if(at+4>wave.length)throw new Error("Animated model header exceeds its wave.");frame=(new DataView(wave.buffer,wave.byteOffset+at,4).getUint32(0)&255)-1;}
      setFloat(object.address+0x28,frame);
    };
    const intercept=(pc:number,m:InitMachine):boolean=>{
      const a=m.registers[4],b=m.registers[5],c=m.registers[6],d=m.registers[7];
      let handled=true;
      if(pc===0x800240dc){
        if(a>0x7ff)throw new Error("Unverified progression flag index outside the native byte-array domain.");
        observedFlags.add(a);m.registers[2]=memory.read(0x8015c608+(a>>>3),1)[0]&(1<<(a&7));
        if(!diagnostics.some(value=>value.startsWith("Native progression predicates")))diagnostics.push("Native progression predicates use a coherent preview assignment; actual save-state visibility is unknown.");
      }
      else if(pc===0x80001e50)m.registers[2]=segmentFor(a);
      else if(pc===0x800141c4){m.registers[2]=a?memory.wave(a,segmentFor(a),resource(a)):0;}
      else if(pc===0x80014840){
        if((a|0)<=0)m.registers[2]=a;
        else {const segment=segmentFor(b),base=memory.wave(b,segment,resource(b)),offset=a-segment*0x1000000,wave=resource(b);if(offset<0||offset>=wave.length)throw new Error("Native segmented pointer exceeds its declared resource.");m.registers[2]=(base+offset)>>>0;}
      }
      else if(pc===0x80014218){
        const object=objects.find(value=>value.address===a);if(!object)throw new Error("Native resource commit requires a synthetic display object.");
        m.registers[2]=0;object.segments.clear();
        for(let index=0;index<6;index++){
          const fileId=half(a+0x34+index*8);if(!fileId){put(a+0x38+index*8,0);continue;}
          const segment=segmentFor(fileId);if(segment!==index+8){m.registers[2]=0xffffffff;continue;}
          const base=memory.wave(fileId,segment,this.waves.wave(fileId));put(a+0x38+index*8,base);object.segments.set(segment,{fileId,offset:0});
        }
        if(word(a+0x2c)&&object.identity===undefined){object.identity=half(object.task+0x5e);object.slot=-1;object.provenance.push("native direct object graphics/resource commit at 0x80014218; no registry slot was inferred");}
      }
      else if(pc===0x8003521c){put(currentTask+0xc,a);callbacks.push(a);}
      else if(pc===0x80035214)put(a+8,b);
      else if(pc===0x80035244)put(a+0x10,b);
      else if(pc===0x80034ed4||pc===0x80035020){removed=true;throw new Error(`Native actor removal/suspension at ${hex(pc)} depends on scene state.`);}
      else if(pc===0x8021664c||pc===0x80221c0c){const object=objectFor(a);animated(a,object,b,c,d);if(pc===0x80221c0c)put(a+0xa8,c);}
      else if(pc===0x80216ce0){const object=objects.find(value=>value.address===b);if(!object)throw new Error("Direct bind refers to an unknown object.");bind(a,object,half(a+0x5e),c,0x40000000);}
      else if([0x80216df8,0x80216e1c,0x80216ed0,0x80216ffc].includes(pc)){
        const object=objectFor(a),identity=pc===0x80216ed0?word(a+0xd0):pc===0x80216ffc?b:half(a+0x5e),slot=pc===0x80216ffc?c&255:b;
        if(pc!==0x80216df8)resetScale(object);bind(a,object,identity,slot,0x40000000);
      }else if(pc===0x80219e08){const object=objectFor(a),factor=cpu.fromBits(b);for(const offset of [0x1c,0x20,0x24])setFloat(object.address+offset,Math.fround(float(object.address+offset)*factor));}
      else if(pc===0x8021a310){const object=objectFor(a);for(const offset of [0x14,0x16,0x18])put(object.address+offset,0x8000,2);}
      else if(pc===0x800148f0){
        if((b|0)<=0||b>65536)throw new Error("Native arena allocation request exceeds the bounded preview domain.");
        memory.next=Math.ceil(memory.next/64)*64;m.registers[2]=memory.allocate(((b+0x4f)&~0x3f)-0x10);
        if(!diagnostics.includes("Native arena preview assumes zeroed allocation succeeds; memory-pressure failure is not simulated."))diagnostics.push("Native arena preview assumes zeroed allocation succeeds; memory-pressure failure is not simulated.");
      }
      else if(pc===0x80040620){/* Verified cache maintenance has no offline presentation side effect. */}
      else if(pc===0x8021c654){
        objectFor(a);result.failureKind??="scene-gated";diagnostics.push("Native collision ground settling is not simulated; preview keeps the constructor's source Y coordinate.");
      }
      else if(pc===0x80226840){
        if(b>=163)throw new Error("Native authored path index exceeds the bounded registry.");
        const pointer=this.reader.u32(0x5f3e50+b*4),fileId=this.reader.i16(0x5f40dc+b*2),object=objectFor(a);
        let resolved=pointer;
        if((pointer|0)>0){if(fileId<=0)throw new Error("Positive authored path has no resource file.");const segment=segmentFor(fileId),bytes=resource(fileId),offset=pointer-segment*0x1000000;if(offset<0||offset>=bytes.length)throw new Error("Authored path pointer exceeds its declared resource.");resolved=memory.wave(fileId,segment,bytes)+offset;}
        if(!resolved)throw new Error("Authored path registry entry is null.");
        put(a+0xc4,resolved);put(a+0xce,0,1);put(a+0xcf,0,1);
        for(let axis=0;axis<3;axis++)put(a+0xc8+axis*2,Math.trunc(float(object.address+8+axis*4)),2);
      }
      else if(pc===0x80220f70){const object=objectFor(a);if((word(a+0x68)&0x100)||memory.read(object.address+0x7c,1)[0]&8)throw new NativeSceneStateError("Native interaction state is required before authored path advancement.");m.registers[2]=0;}
      else if(pc===0x802268a8){
        const object=objectFor(a),path=word(a+0xc4);if(!path)throw new Error("Native authored path has not been initialized.");
        if(memory.read(a+0xce,1)[0]!==0)throw new NativeSceneStateError("Later authored path movement requires live timeline state.");
        let index=memory.read(a+0xcf,1)[0],selected=false;
        const s16=(at:number)=>(half(at)<<16)>>16;
        for(let commands=0;commands<32;commands++){
          const at=path+index*2,opcode=half(at);
          if(opcode===0xc){for(let axis=0;axis<3;axis++)setFloat(object.address+8+axis*4,s16(a+0xc8+axis*2)+s16(at+2+axis*2));index+=4;if(index>255)throw new Error("Authored path instruction index overflow.");put(a+0xcf,index,1);continue;}
          if(opcode===8||opcode===0x23){const speed=s16(at+(opcode===8?4:14))/10;animated(a,object,half(at+2),cpu.floatBits(speed),1);put(a+0xa8,cpu.floatBits(speed));selected=true;}
          else if(opcode===0x15){bind(a,object,half(a+0x5e),s16(at+2),0x40000000);selected=true;}
          else throw new Error(`Unmodeled initial authored path opcode ${hex(opcode)}.`);
          put(a+0xce,1,1);m.registers[2]=0;break;
        }
        if(!selected)throw new Error("Initial authored path command budget exceeded.");
        diagnostics.push("Initial authored path model/pose is evaluated; later path movement and interaction require live timeline state.");
      }
      else if(pc===0x8021b09c)throw new NativeSceneStateError("Native player-relative position/callback initialization requires live player state; declared models retain the source placement pose.");
      else if(pc===0x802209f0){
        memory.next=Math.ceil(memory.next/64)*64;const pointer=memory.allocate(0xa0);put(pointer,0xb8000000);put(pointer+4,0);m.registers[2]=pointer;
        diagnostics.push("Material preview assumes native arena allocation succeeds; native memory-pressure suspension is not simulated.");
      }
      else if(pc===0x800358e8){
        if(children.length>=32)throw new Error("Native child task budget exceeded.");
        const task=memory.allocate(0xf0),object=createObject(task,false),fileGraphics=m.argument(13)&65535,fileMaterial=m.argument(14)&65535;
        put(task+0xc,b);put(task+0x20,half(a+0x20)+1,2);put(task+0x28,fileGraphics,2);
        put(task+0x2c,fileGraphics?memory.wave(fileGraphics,segmentFor(fileGraphics),resource(fileGraphics)):0);put(object.address+5,2,1);
        put(object.address+0x2c,c);put(object.address+0x30,d);
        for(let axis=0;axis<3;axis++){setFloat(object.address+8+axis*4,cpu.fromBits(m.argument(4+axis)));put(object.address+0x14+axis*2,m.argument(7+axis),2);setFloat(object.address+0x1c+axis*4,cpu.fromBits(m.argument(10+axis)));}
        put(object.address+0x34,fileGraphics,2);put(object.address+0x3c,fileMaterial,2);
        object.provenance.push(`native raw 15-argument object-task allocation 0x800358e8, callback ${hex(b)}; parent stats/payload were not copied`);
        children.push({task,entry:b,codeFile:fileGraphics||memory.codeFile});m.registers[2]=task;
        diagnostics.push("Child-task preview assumes native task/object allocation succeeds; memory-pressure failure is not simulated.");
      }
      else if(pc===0x802171a8||pc===0x80217360){
        if(children.length>=32)throw new Error("Native child task budget exceeded.");
        const parent=objectFor(a),task=memory.allocate(0xf0),object=createObject(task);
        const actorId=b&65535;if(pc===0x80217360&&actorId>0x405)throw new Error("Native actor child ID exceeds the bounded initializer registry.");
        const childEntry=pc===0x80217360?this.reader.u32(0x5e3c8c+actorId*4):b,childFile=pc===0x80217360?this.reader.i16(0x5e4ca6+actorId*2):memory.codeFile;
        if(pc===0x80217360&&(childFile<0||!childEntry))throw new Error("Native actor child initialization has an unverified registry entry.");
        for(const [offset,size] of [[0x98,4],[0x5c,4],[0x74,1],[0x96,2],[0x48,4],[0x4e,6],[0x3c,6],[0x84,4]])memory.write(task+offset,memory.read(a+offset,size));
        for(const [offset,size] of [[8,12],[0x14,6]])memory.write(object.address+offset,memory.read(parent.address+offset,size));
        for(const [offset,value,size] of [[0x28,0xfffe,2],[0x2c,0xffffffff,4],[0x75,25,1],[0x76,20,1],[0x8d,1,1]])put(task+offset,value,size);
        setFloat(object.address+0x68,memory.read(a+0x99,1)[0]/2);setFloat(object.address+0x6c,memory.read(a+0x98,1)[0]);
        put(task+8,0x8021925c);put(task+0x10,0x80218f30);put(task+0xc,childEntry);
        if(pc===0x80217360){put(task+0x5c,actorId,2);put(task+0x5e,actorId,2);put(task+0x28,childFile,2);put(task+0x2c,childFile?memory.wave(childFile,segmentFor(childFile),resource(childFile)):0xffffffff);}
        object.provenance.push(`native child task created by ${hex(pc)}, callback ${hex(childEntry)}, category ${c&255}`);
        children.push({task,entry:childEntry,codeFile:childFile});m.registers[2]=task;
        diagnostics.push("Child-task preview assumes native task/object allocation succeeds; memory-pressure failure is not simulated.");
      }
      else if(pc===0x80035eec){let first=0;for(let i=0;i<(c&255);i++){const object=createObject(a,false);if(!first)first=object.address;}m.registers[2]=first;}
      else if(pc===0x80216e54||pc===0x80216838){
        const parent=objectFor(a),object=createObject(a);
        for(const [offset,size] of [[8,4],[12,4],[16,4],[20,2],[22,2],[24,2],[28,4],[32,4],[36,4],[48,4]])memory.write(object.address+offset,memory.read(parent.address+offset,size));
        if(pc===0x80216e54){resetScale(object);bind(a,object,half(a+0x5e),b,0x40000000);}else animated(a,object,b,c,d);
        m.registers[2]=object.address;
      }else if(pc===0x8021a764){
        const object=objectFor(a),sourceSegment=d===2?8:d===1?9:d===0?10:-1,targetSegment=8+c,source=object.segments.get(sourceSegment);
        if(!source||targetSegment<8||targetSegment>13)throw new Error("Native additional segment has no verified source wave.");
        const offset=source.offset+b-sourceSegment*0x1000000;object.segments.set(targetSegment,{fileId:source.fileId,offset});put(object.address+0x38+c*8,memory.resourceBases.get(source.fileId)!+offset);
      }else if(pc===0x80224ce0){const object=objectFor(a);put(a+0x90,b);put(a+0x9c,c);put(a+0xa0,d);animated(a,object,0,0,0);const primary=object.segments.get(8);if(!primary)throw new Error("Native billboard lacks its segment 8 wave.");const offset=primary.offset+b-0x08000000;object.segments.set(11,{fileId:primary.fileId,offset});put(object.address+0x50,memory.resourceBases.get(primary.fileId)!+offset);}
      else if(pc===0x80218da8){put(a+0x48,0xffffffff);put(a+0x4e,Math.trunc((b|0)/10),2);put(a+0x50,c,2);put(a+0x52,d,2);}
      else if(pc===0x80218d7c){put(a+0x3c,b,2);put(a+0x3e,c,2);put(a+0x40,d,2);put(a+0x48,0);}
      else if(pc===0x80218d90){put(a+0x98,b,1);put(a+0x99,c,1);put(a+0x9a,d,1);put(a+0x9b,m.argument(4),1);}
      else if(pc===0x8021b064){const object=objectFor(a);put(a+0xa0,Math.trunc(float(object.address+8)),2);put(a+0xa2,Math.trunc(float(object.address+0x10)),2);put(a+0x9c,b);put(a+0xa8,c);}
      else handled=false;
      if(handled){m.returnFromIntercept();return true;}
      // Execute other mapped instructions; unsupported calls/engine memory remain
      // explicit gaps rather than returning an invented zero from a native call.
      if(memory.codeFile){const base=memory.resourceBases.get(memory.codeFile),file=this.files.get(memory.codeFile);
        if(base!==undefined&&file&&pc>=base&&pc+4<=base+file.end-file.start){m.pc=0x08000000+pc-base;m.nextPc=m.pc+4;return true;}
      }
      if(memory.romOffset(pc,4)===undefined)throw new Error(`Unverified native call/PC ${hex(pc)}.`);
      return false;
    };
    try {
      if(!Number.isInteger(input.actorId)||input.actorId<0||input.actorId>0x405||input.parameters.length!==3||input.parameters.some(v=>!Number.isInteger(v)||v<0||v>0xffffffff))throw new Error("Actor initializer input must come from a validated native actor record.");
      for(const vector of [input.position,input.rotation])if(AXES.some(axis=>!Number.isFinite(vector[axis])))throw new Error("Native actor transform is not finite.");
      const knownController=MESH_FREE_CONTROLLERS.get(input.actorId);
      if(knownController&&this.reader.u32(0x5e3c8c+input.actorId*4)===knownController.entry&&this.reader.i16(0x5e4ca6+input.actorId*2)===knownController.overlay){result.status="nonvisual";diagnostics.push(knownController.reason);return result;}
      const task=memory.allocate(0xf0);currentTask=task;
      const object=createObject(task);
      memory.regions.push({start:0x813e0000,bytes:new Uint8Array(0x20000)});cpu.registers[29]=0x813fff00;
      memory.codeFile=this.reader.i16(0x5e4ca6+input.actorId*2);
      if(memory.codeFile<0)throw new Error("Actor registry code file is not a verified overlay.");
      // File56 declares a writable generated-material scratch list immediately
      // after its ROM-backed code. 20A60 overwrites all consumed command words.
      if(memory.codeFile===56&&this.files.get(56)!.end-this.files.get(56)!.start===0x3f30)memory.regions.push({start:0x08003f30,bytes:new Uint8Array(0x88)});
      put(task+0x28,memory.codeFile,2);
      for(const offset of [0x5c,0x5e])put(task+offset,input.actorId,2);
      input.parameters.forEach((value,index)=>put(task+0xd0+index*4,value));
      for(const [offset,value,size] of [[0x4e,2,2],[0x50,40,2],[0x3c,100,2],[0x3e,160,2],[0x48,0xffffffff,4],[0x4c,1,1],[0x98,10,1],[0x99,5,1],[0x9a,5,1],[0x8d,1,1],[0x75,25,1],[0x76,20,1],[0x96,1,2],[0x22,1,2]])put(task+offset,value,size);
      setFloat(object.address+0x68,2.5);setFloat(object.address+0x6c,10);
      AXES.forEach((axis,index)=>{setFloat(object.address+8+index*4,input.position[axis]);put(object.address+0x14+index*2,input.rotation[axis],2);});
      // Keep pure native predicate queries and direct byte-array reads coherent.
      // Only the explored initial assignment is supplied; later native writes
      // remain private and subsequent queries see those actual writes.
      const initialFlags=new Map<number,number>();for(const [index,set] of progression)if(set){const byte=index>>>3;initialFlags.set(byte,(initialFlags.get(byte)??0)|(1<<(index&7)));}
      for(const [byte,value] of initialFlags)put(0x8015c608+byte,value,1);
      put(0x8016dab4,task);if(input.roomId!==undefined)put(0x800c7ab2,input.roomId,2);
      memory.onWrite=(address,size)=>{for(const object of objects)for(const [index,axis] of AXES.entries()){const at=object.address+0x14+index*2;if(address<at+2&&address+size>at)object.rotationMask[axis]=true;}};
      memory.phase=true;
      const entry=this.reader.u32(0x5e3c8c+input.actorId*4);
      if(!entry)throw new Error("Actor registry entry is null; it may be a deferred controller or identity rewrite, not proof of invisibility.");
      cpu.run(entry,[task,object.address],STOP);
      if(memory.codeFile===56&&word(task+0xc)===0x08000534){
        const material=word(task+0xd4),region=memory.regions.find(r=>r.start===material&&r.bytes.length===0xa0&&!r.readonly);
        if(!region)throw new Error("Verified first-material builder has no validated synthetic output allocation.");
        cpu.run(0x0800056c,[task,material],STOP);
        object.provenance.push("evaluated native first-material builder File56:0x56C before recurring UV/movement callback 0x978; constructor originally installed an END-only list");
        diagnostics.push("Preview evaluates the verified first generated-material frame before recurring UV scrolling or movement.");
      }
      for(let stage=0;stage<4&&object.identity===undefined&&callbacks.length;stage++){
        const callback=callbacks[callbacks.length-1];if(!callback)break;
        callbacks.pop();object.provenance.push(`advanced deferred initializer ${hex(callback)}`);cpu.run(callback,[task,object.address],STOP);
      }
      if(object.identity===undefined&&callbacks.length){result.failureKind="unresolved";diagnostics.push("Primary deferred initializer remains unresolved after the advancement budget, even if a linked object declared a model.");}
      for(let index=0;index<children.length;index++){
        const child=children[index],childObject=objectFor(child.task);currentTask=child.task;memory.codeFile=child.codeFile;put(0x8016dab4,child.task);
        const entry=word(child.task+0xc);if(!entry)throw new Error("Native child task callback is null; visual behavior remains unresolved.");
        childObject.provenance.push(`executed configured native child callback ${hex(entry)} after parent setup`);cpu.run(entry,[child.task,childObject.address],STOP);
        for(let stage=0;stage<4&&childObject.identity===undefined;stage++){
          const callback=word(child.task+0xc);if(!callback||callback===entry)break;
          childObject.provenance.push(`advanced native child deferred initializer ${hex(callback)}`);cpu.run(callback,[child.task,childObject.address],STOP);
        }
        if(childObject.identity===undefined){result.failureKind="unresolved";diagnostics.push(`Native child callback ${hex(child.entry)} completed without a bound model; later behavior remains unresolved.`);}
      }
      if(objects.some(value=>value.identity!==undefined))result.status="resolved";
      else throw new Error(callbacks.length?"Deferred initializer budget ended with an unresolved callback; visual absence is not established.":"Constructor completed without a model declaration; child/deferred visual behavior is not established.");
    }catch(error){if(result.failureKind!=="unresolved")result.failureKind=removed||error instanceof NativeSceneStateError?"scene-gated":"unresolved";diagnostics.push(`${error instanceof Error?error.message:String(error)} [initializer PC ${hex(cpu.pc)}]`);}
    if(memory.unknownReads.size){if(!result.failureKind&&objects.some(o=>o.identity!==undefined))result.failureKind="scene-gated";diagnostics.push(`Read ${memory.unknownReads.size} bytes of live engine/save/player state without a ROM initial value; provisional zero path is conditional.`);}
    if(removed)diagnostics.push("Native removal gating was encountered; model declarations do not establish visibility in a particular save state.");
    for(const object of objects){
      if(object.identity===undefined||object.slot===undefined)continue;
      // Texture-sequence and other native helpers can write B/C/D bases directly.
      // Recover only bases inside resource allocations already validated above.
      for(let index=0;index<6;index++){
        const base=word(object.address+0x38+index*8);if(!base)continue;
        for(const [fileId,waveBase] of memory.resourceBases){const bytes=memory.regions.find(r=>r.start===waveBase)!.bytes;
          if(base>=waveBase&&base<waveBase+bytes.length){object.segments.set(8+index,{fileId,offset:base-waveBase});break;}
        }
      }
      const vector=(offset:number,stride:number,short=false):Vec3=>Object.fromEntries(AXES.map((axis,index)=>[axis,short?(half(object.address+offset+index*stride)<<16)>>16:float(object.address+offset+index*stride)])) as unknown as Vec3;
      const position=vector(8,4),rotation=vector(0x14,2,true),scale=vector(0x1c,4);
      if([...Object.values(position),...Object.values(scale)].some(value=>!Number.isFinite(value))){diagnostics.push("Constructor produced a nonfinite object transform.");continue;}
      bindings.push({identity:object.identity,slot:object.slot,modelPointer:word(object.address+0x2c),materialPointer:word(object.address+0x30),segments:[...object.segments].map(([segment,value])=>({segment,...value})),scale,rotation,position,positionOffset:{x:position.x-input.position.x,y:position.y-input.position.y,z:position.z-input.position.z},rotationOverrideMask:object.rotationMask,animationFrame:float(object.address+0x28),animationBlendCountdown:float(object.address+0x70),provenance:object.provenance,objectIndex:object.index});
    }
    if(diagnostics.length)result.status=bindings.length?"conditional":"unsupported";
    result.readonlyMemory=[...memory.resourceBases].map(([fileId,address])=>({address,fileId,byteLength:memory.regions.find(r=>r.start===address)!.bytes.length}));
    result.syntheticMemory=memory.regions.filter(region=>(region.start>=0x81000000&&region.start<0x81200000)||region.start===0x08003f30).map(region=>({address:region.start,bytes:region.bytes.slice()}));
    const privateAddresses=[...memory.privateBytes.keys()].sort((a,b)=>a-b);
    for(let start=0;start<privateAddresses.length;){let end=start+1;while(end<privateAddresses.length&&privateAddresses[end]===privateAddresses[end-1]+1)end++;
      result.syntheticMemory.push({address:privateAddresses[start],bytes:Uint8Array.from(privateAddresses.slice(start,end).map(at=>memory.privateBytes.get(at)!))});start=end;
    }
    result.instructionCount=cpu.instructions;result.branches=cpu.branches.slice(0,2048);return result;
  }
}
