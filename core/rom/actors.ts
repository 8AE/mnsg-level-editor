import {createHash} from "node:crypto";
import type {ActorModel,ActorOverride,ActorVisual,ActorVisualPayload,RoomData,Vec3} from "../../shared/types";
import {ActorInitializer,nativeControllerResourceContract,type NativeActorBinding,type NativeActorInitInput,type NativeActorInitResult} from "./actor-init";
import {decodeNativeModelGraph,multiplyNativeMatrices} from "./actors-models";
import {renderModelLists} from "./render";
import {RomReader} from "./binary";
import type {RomFile} from "./decompress";
import {RenderWaves} from "./waves";
import {readNativeActorMemory,graphicsActorMemory,type NativeActorMemorySpan} from "./actors-memory";
import {nativePoseMatrix} from "./actors-pose";
import type {NativeAuthoringMaterial} from "../authoring/catalog";

export interface NativeDoorGeometry {
  meshes:{vertices:{position:Vec3;uv:[number,number];colorRGBAu8:[number,number,number,number]}[];indices:number[];material:NativeAuthoringMaterial}[];
  resourceFileIds:number[];warnings:string[];
}

const AXES=["x","y","z"] as const;
interface ReadonlyResource {address:number;fileId:number;byteLength:number;scope?:"cold-world-loader"}
const identity=()=>[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
const digest=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
const bytesFor=(model:ActorModel)=>model.meshes.reduce((sum,m)=>sum+(m.positions.length+m.indices.length+(m.uvs?.length??0)+(m.colors?.length??0)+(m.normals?.length??0))*8+(m.material?.texgen?128:0),0)+model.textures.reduce((sum,t)=>sum+t.width*t.height*4+t.rgbaBase64.length*2,0);

function inverse(matrix:number[]):number[] {
  const [a,b,c]=[matrix[0],matrix[4],matrix[8]],[d,e,f]=[matrix[1],matrix[5],matrix[9]],[g,h,i]=[matrix[2],matrix[6],matrix[10]],det=a*(e*i-f*h)-b*(d*i-f*g)+c*(d*h-e*g);
  if(!Number.isFinite(det)||Math.abs(det)<1e-12)throw new Error("Native actor node has a singular preview transform.");
  const output=[(e*i-f*h)/det,(f*g-d*i)/det,(d*h-e*g)/det,0,(c*h-b*i)/det,(a*i-c*g)/det,(b*g-a*h)/det,0,(b*f-c*e)/det,(c*d-a*f)/det,(a*e-b*d)/det,0,0,0,0,1];
  for(let row=0;row<3;row++)output[12+row]=-(output[row]*matrix[12]+output[4+row]*matrix[13]+output[8+row]*matrix[14]);return output;
}
function transform(point:number[],matrix:number[]):number[]{return [matrix[0]*point[0]+matrix[4]*point[1]+matrix[8]*point[2]+matrix[12],matrix[1]*point[0]+matrix[5]*point[1]+matrix[9]*point[2]+matrix[13],matrix[2]*point[0]+matrix[6]*point[1]+matrix[10]*point[2]+matrix[14]];}

/** All initializer state is private; asset reads consume canonical ROM/PIC caches. */
export class ActorVisuals {
  private readonly initializer:ActorInitializer;
  private readonly assetCache=new Map<string,{model:ActorModel;bytes:number;baseKey:string;dependencies:{address:number;size:number;expectedHex:string}[]}>();
  private readonly roomCache=new Map<string,ActorVisualPayload>();
  private cachedBytes=0;
  constructor(private readonly reader:RomReader,private readonly files:Map<number,RomFile>,private readonly waves:RenderWaves){this.initializer=new ActorInitializer(reader,files,waves);}
  private read(binding:NativeActorBinding,address:number,size:number,synthetic:NativeActorMemorySpan[]=[],readonly:ReadonlyResource[]=[]):Uint8Array {
    return readNativeActorMemory((at,length)=>this.readBase(binding,at,length,readonly),address,size,graphicsActorMemory(synthetic,binding.segments));
  }
  private readBase(binding:NativeActorBinding,address:number,size:number,readonly:ReadonlyResource[]=[]):Uint8Array {
    if(!Number.isSafeInteger(size)||size<0||size>8*1024*1024)throw new Error("Actor asset read exceeds its byte budget.");
    const allocation=readonly.find(span=>address>=span.address&&address+size<=span.address+span.byteLength);
    if(allocation){
      if(!Number.isSafeInteger(allocation.byteLength)||allocation.byteLength<0||allocation.byteLength>16*1024*1024||!this.files.has(allocation.fileId))throw new Error("Invalid native readonly resource allocation.");
      const offset=address-allocation.address;
      try{const wave=this.waves.wave(allocation.fileId);if(wave.length!==allocation.byteLength)throw new Error("Native readonly wave length changed.");return wave.subarray(offset,offset+size);}catch(error){
        const file=this.files.get(allocation.fileId)!,start=this.reader.u32(0x556c4+allocation.fileId*8),end=this.reader.u32(0x556c4+allocation.fileId*8+4),parts=this.reader.u32(0x6a51c+allocation.fileId*4);
        const header=this.readBase(binding,parts,4),empty=new DataView(header.buffer,header.byteOffset,4).getUint32(0)===0;
        if(!empty||end-start!==allocation.byteLength||allocation.byteLength<file.end-file.start||(end>>>24)!==(start>>>24))throw error;
        const output=new Uint8Array(size),available=Math.min(size,Math.max(0,file.end-file.start-offset));if(available)output.set(this.reader.bytes.subarray(file.start+offset,file.start+offset+available));return output;
      }
    }
    if(address>=0x80000000){
      for(const [base,id] of [[0x801cb460,11],[0x8020d2a0,12]]){const file=this.files.get(id);if(file&&address>=base&&address+size<=base+file.end-file.start){const at=this.reader.check(file.start+address-base,size,file.end);return this.reader.bytes.subarray(at,at+size);}}
      if(address>=0x80000450&&address+size<=0x8007e020){const at=this.reader.check(address-0x80000000+0xc00,size);return this.reader.bytes.subarray(at,at+size);}
      throw new Error(`Actor model uses an unmapped mutable/resident address 0x${address.toString(16)} (${size} bytes).`);
    }
    const segment=address<0x08000001?8:(address>>>24)&15,mapping=binding.segments.find(value=>value.segment===segment);
    if(!mapping)throw new Error(`Actor model has no native segment ${segment.toString(16)} binding.`);
    const wave=this.waves.wave(mapping.fileId),offset=(address&0xffffff)+mapping.offset;
    if(!Number.isSafeInteger(offset)||offset<0||offset+size>wave.length)throw new Error("Actor model exceeds its native wave allocation.");
    return wave.subarray(offset,offset+size);
  }
  private asset(binding:NativeActorBinding,synthetic:NativeActorMemorySpan[],readonly:ReadonlyResource[]):ActorModel {
    if(readonly.length>1024||readonly.some(span=>!Number.isSafeInteger(span.address)||!Number.isSafeInteger(span.byteLength)||span.byteLength<0||span.byteLength>16*1024*1024||!(span.address>=0x82000000&&span.address+span.byteLength<=0xbf000000||span.scope==="cold-world-loader"&&span.address>=0x80321500&&span.address+span.byteLength<=0x80594000&&span.address%64===0)))throw new Error("Native readonly actor resource mapping exceeds its bounded arena.");
    const lower=readonly.filter(span=>span.address<0x82000000).sort((a,b)=>a.address-b.address),ids=new Set<number>();
    if(lower.length>48)throw new Error("Scoped native readonly registry exceeds48slots.");
    for(const [index,span] of lower.entries()){
      if(!Number.isInteger(span.fileId)||span.fileId<=0||span.fileId>=0x520)throw new Error("Scoped native readonly file ID is invalid.");
      const file=this.files.get(span.fileId),start=this.reader.u32(0x556c4+span.fileId*8),end=this.reader.u32(0x556c4+span.fileId*8+4);
      if(!file||file.compressed||ids.has(span.fileId)||end-start!==span.byteLength||(start&0x40000000)!==(end&0x40000000)||index&&lower[index-1].address+lower[index-1].byteLength>span.address)throw new Error("Scoped native readonly allocation identity/extent/overlap changed.");ids.add(span.fileId);
      let segment=-1;for(let at=0x55510;at<0x556c4;at+=4){const upper=this.reader.u16(at);if(!upper)break;if(span.fileId<upper){segment=this.reader.bytes[at+3];break;}}
      if(segment<0||(segment===0x11||start&0x40000000)&&span.address%4096!==0)throw new Error("Scoped native readonly code alignment changed.");
    }
    const baseKey=digest([binding.modelPointer,binding.materialPointer,binding.segments,binding.animationFrame,binding.animationBlendCountdown,readonly]);
    for(const [key,cached] of this.assetCache){if(cached.baseKey===baseKey&&cached.dependencies.every(dep=>{try{return Buffer.from(this.read(binding,dep.address,dep.size,synthetic,readonly)).toString("hex")===dep.expectedHex;}catch{return false;}})){this.assetCache.delete(key);this.assetCache.set(key,cached);return cached.model;}}
    const dependencies=new Map<string,{address:number;size:number;expectedHex:string}>();let dependencyBytes=0;
    const graphicsMemory=graphicsActorMemory(synthetic,binding.segments);
    const read=(address:number,size:number)=>readNativeActorMemory((at,length)=>this.readBase(binding,at,length,readonly),address,size,graphicsMemory,(at,bytes)=>{const key=`${at}:${bytes.length}`;if(!dependencies.has(key)){if(dependencies.size>=4096||dependencyBytes+bytes.length>2*1024*1024)throw new Error("Actor material dependency budget exceeded.");dependencyBytes+=bytes.length;dependencies.set(key,{address:at,size:bytes.length,expectedHex:Buffer.from(bytes).toString("hex")});}});
    const graph=decodeNativeModelGraph(read,binding.modelPointer,binding.animationFrame,binding.animationBlendCountdown);
    // 800196F0 gates object material setup on 80168524: once at the first
    // drawable limb, then subsequent limbs inherit the native RDP state.
    const roots=graph.roots.map((root,index)=>({...root,label:`actor-node-${root.nodeIndex}`,material:index===0?(binding.materialPointer&0x8fffffff)>>>0:undefined}));
    const alignedAncestor=(index:number):boolean=>{for(let at:number|null=index;at!==null;at=graph.nodes[at].parentIndex){const axes=graph.nodes[at].billboardAxes;if(axes&&(axes.x||axes.y||axes.z))return true;}return false;};
    let crossNode=0,cameraCrossNode=0;
    const rendered=renderModelLists(read,roots,0,(loads,draw)=>{const node=roots[draw].nodeIndex;if(loads.some(load=>roots[load].nodeIndex!==node)){crossNode++;if(alignedAncestor(node)||loads.some(load=>alignedAncestor(roots[load].nodeIndex)))cameraCrossNode++;}},{inheritedTextureFallback:true});
    if(!rendered.complete)throw new Error(rendered.warnings.join("; ")||"Native actor model traversal is incomplete.");
    if(cameraCrossNode)throw new Error(`${cameraCrossNode} native actor triangles reuse vertices across camera-aligned skeleton nodes; dynamic alignment is unsupported.`);
    const key=digest([baseKey,[...dependencies.values()]]),model:ActorModel={id:`actor-model:${key}`,meshes:rendered.meshes,textures:rendered.textures,nodes:graph.nodes,warnings:[...graph.warnings,...rendered.warnings]};
    if(rendered.coverage.unsupported)model.warnings.push(`${rendered.coverage.unsupported} actor triangles use an unsupported native appearance state.`);
    if(crossNode)model.warnings.push(`${crossNode} native actor triangles preserve cross-node vertex cache state in the static initial pose.`);
    const world:number[][]=[];for(const node of model.nodes)world.push(node.parentIndex===null?node.matrix:multiplyNativeMatrices(world[node.parentIndex],node.matrix));
    const min:Vec3={x:Infinity,y:Infinity,z:Infinity},max:Vec3={x:-Infinity,y:-Infinity,z:-Infinity};
    for(const [index,mesh] of model.meshes.entries()){
      const nodeIndex=Number(mesh.id.match(/^actor-node-(\d+):/)?.[1]);if(!Number.isInteger(nodeIndex)||!model.nodes[nodeIndex])throw new Error("Actor mesh has no native skeleton node.");
      model.nodes[nodeIndex].meshIndices.push(index);const undo=inverse(world[nodeIndex]);
      for(let at=0;at<mesh.positions.length;at+=3){const point=mesh.positions.slice(at,at+3);AXES.forEach((axis,i)=>{min[axis]=Math.min(min[axis],point[i]);max[axis]=Math.max(max[axis],point[i]);});const local=transform(point,undo);if(!local.every(Number.isFinite))throw new Error("Native actor vertex transform is nonfinite.");for(let i=0;i<3;i++)mesh.positions[at+i]=local[i];}
    }
    if(Number.isFinite(min.x))model.localBounds={min,max};
    const bytes=bytesFor(model)+[...dependencies.values()].reduce((sum,dep)=>sum+dep.expectedHex.length*2+32,0);if(bytes>32*1024*1024)throw new Error("Native actor asset exceeds the decoded byte budget.");
    while(this.assetCache.size&&this.cachedBytes+bytes>32*1024*1024){const oldest=this.assetCache.keys().next().value!;this.cachedBytes-=this.assetCache.get(oldest)!.bytes;this.assetCache.delete(oldest);}
    this.assetCache.set(key,{model,bytes,baseKey,dependencies:[...dependencies.values()]});this.cachedBytes+=bytes;return model;
  }
  load(room:RoomData,overrides:Record<string,ActorOverride>):ActorVisualPayload {
    const cacheKey=`${room.id}:${digest(overrides)}`,cached=this.roomCache.get(cacheKey);if(cached){this.roomCache.delete(cacheKey);this.roomCache.set(cacheKey,cached);return structuredClone(cached);}
    const inputs:{actorRef:string;input:NativeActorInitInput}[]=room.actors.map(actor=>{const edit=overrides[actor.id]??{};return {actorRef:actor.id,input:{actorId:edit.actorId??actor.actorId,parameters:edit.parameters??actor.parameters,position:edit.position??actor.position,rotation:edit.rotation??actor.rotation,unknownHalfword:actor.definitionSource?this.reader.u16(actor.definitionSource.romOffset+2):0,roomId:room.id}};});
    for(const [index,entry] of inputs.entries())if(entry.input.actorId===0x1b0){const sibling=inputs.slice(0,index).find(entry=>entry.input.actorId===0x287);if(sibling){const prior=this.initializer.resolve(sibling.input);if(prior.completed&&prior.failureKind!=="unresolved")entry.input.priorScene=prior;}if(!entry.input.priorScene)entry.input.requiredSiblingMissing=true;}
    const payload=this.renderInputs(inputs);
    while(this.roomCache.size>=4)this.roomCache.delete(this.roomCache.keys().next().value!);this.roomCache.set(cacheKey,payload);return structuredClone(payload);
  }
  /** Independent native prototypes never fabricate an original room placement. */
  preview(input:NativeActorInitInput,actorRef:string):ActorVisualPayload {return structuredClone(this.renderInputs([{actorRef,input}]));}
  resolveNative(input:NativeActorInitInput):NativeActorInitResult {return this.initializer.resolve(input);}
  /** Trusted static initial-pose IR. No actor callbacks survive into the door. */
  doorGeometry(input:NativeActorInitInput):NativeDoorGeometry {
    const init=this.initializer.resolve(input);
    if(!init.completed||init.failureKind==="unresolved"||!init.bindings.length)throw new Error(`Native door appearance has an unresolved initialization path: ${init.diagnostics.join(" ")}`);
    const output:NativeDoorGeometry={meshes:[],resourceFileIds:[],warnings:[...init.diagnostics]},resources=new Set<number>();let vertexCount=0,triangleCount=0,commandCount=0,rounded=false;
    for(const binding of init.bindings){
      if(AXES.some(axis=>(binding.rotation[axis]&65535)===0x8000))throw new Error("Camera-aligned native actor roots cannot be flattened into a static door.");
      const read=(address:number,size:number)=>this.read(binding,address,size,init.syntheticMemory,init.readonlyMemory);
      const graph=decodeNativeModelGraph(read,binding.modelPointer,binding.animationFrame,binding.animationBlendCountdown);
      if(graph.nodes.some(node=>node.billboardAxes&&Object.values(node.billboardAxes).some(Boolean)))throw new Error("Camera-aligned native actor nodes cannot be flattened into a static door.");
      const rendered=renderModelLists(read,graph.roots.map((root,index)=>({...root,material:index===0?(binding.materialPointer&0x8fffffff)>>>0:undefined})),0,undefined,{vertexProvenance:true,materialProvenance:true});
      if(!rendered.complete||rendered.coverage.unsupported)throw new Error(`Native door appearance has unsupported geometry or material state: ${rendered.warnings.join(" ")}`);
      if(rendered.meshes.some(mesh=>mesh.material?.texgen))throw new Error("Native generated UVs cannot be flattened into authored static door UVs.");
      output.warnings.push(...graph.warnings,...rendered.warnings);
      const matrix=nativePoseMatrix({translation:binding.position,rotation:{x:binding.rotation.x&1023,y:binding.rotation.y&1023,z:binding.rotation.z&1023},scale:binding.scale,cameraAlignedAxes:{x:0,y:0,z:0}});
      for(const [index,mesh] of rendered.meshes.entries()){
        const commands=rendered.materialCommands?.[index],state=rendered.materialStates?.[index];if(!commands||!state||!mesh.material)throw new Error("Native door material provenance is incomplete.");
        vertexCount+=mesh.positions.length/3;triangleCount+=mesh.indices.length/3;commandCount+=commands.length;
        if(vertexCount>65535||triangleCount>32768||commandCount>65536||output.meshes.length>=512)throw new Error("Native static door geometry exceeds its staging budget.");
        const batchResources=new Set<number>(),relocations:NativeAuthoringMaterial["relocations"]=[];let scaleS=1,scaleT=1;
        for(const [commandIndex,[word,pointer]] of commands.entries()){
          const op=word>>>24;if(op===0xbb){scaleS=(pointer>>>16)/65536;scaleT=(pointer&65535)/65536;}
          if(op!==0xfd&&op!==0x03)continue;
          const allocation=init.readonlyMemory.find(span=>pointer>=span.address&&pointer<span.address+span.byteLength);
          const mapping=pointer<0x80000000?binding.segments.find(span=>span.segment===pointer>>>24):undefined;
          const fileId=allocation?.fileId??mapping?.fileId;
          if(fileId===undefined){if(pointer<0x80000450||pointer>=0x8007e020)throw new Error("Native door material pointer has no immutable resource relocation.");read(pointer,op===0x03?16:1);continue;}
          const offset=allocation?pointer-allocation.address:(pointer&0xffffff)+(mapping?.offset??0),wave=this.waves.wave(fileId);
          if(offset<0||offset+(op===0x03?16:1)>wave.length)throw new Error("Native door material resource pointer is out of bounds.");
          const start=this.reader.u32(0x556c4+fileId*8);batchResources.add(fileId);resources.add(fileId);relocations.push({offset:commandIndex*8+4,fileId,segmentedAddress:(start+offset)>>>0});
        }
        const texture=rendered.textures.find(texture=>texture.id===mesh.material!.textureId),tile=state.tiles[state.tile];
        const material:NativeAuthoringMaterial={id:`actor-material:${digest([commands,state,relocations])}`,commands,resourceFileIds:[...batchResources].sort((a,b)=>a-b),relocations,textureWidth:texture?.width??1,textureHeight:texture?.height??1,state,material:mesh.material,uv:{scaleS,scaleT,shiftS:tile.shifts,shiftT:tile.shiftt,originS:tile.uls/4,originT:tile.ult/4,centerOffset:mesh.material.filter==="linear"?0.5:0}};
        const vertices=Array.from({length:mesh.positions.length/3},(_,vertex)=>{
          const point=transform(mesh.positions.slice(vertex*3,vertex*3+3),matrix),quantized=point.map(Math.round);
          if(quantized.some(value=>!Number.isFinite(value)||value<-32768||value>32767))throw new Error("Native door pose exceeds signed16 geometry bounds.");
          if(point.some((value,axis)=>Math.abs(value-quantized[axis])>1e-6))rounded=true;
          const source=rendered.vertexAddresses?.[index][vertex];if(source===undefined)throw new Error("Native door vertex provenance is missing.");
          const alpha=read(source+15,1)[0],rgb=mesh.colors?.slice(vertex*3,vertex*3+3)??[1,1,1];
          return {position:{x:quantized[0],y:quantized[1],z:quantized[2]},uv:(mesh.uvs?.slice(vertex*2,vertex*2+2)??[0,0]) as [number,number],colorRGBAu8:[...rgb.map(value=>Math.max(0,Math.min(255,Math.round(value*255)))),alpha] as [number,number,number,number]};
        });
        output.meshes.push({vertices,indices:[...mesh.indices],material});
      }
    }
    if(rounded)output.warnings.push("Native static initial-pose coordinates are rounded to signed16 vertex units for the authored door.");
    output.resourceFileIds=[...resources].sort((a,b)=>a-b);output.warnings=[...new Set(output.warnings)];return output;
  }
  dependencies(input:NativeActorInitInput):{fileIds:number[];warnings:string[];completed:boolean;proofKind?:"verified-controller-closure";provenance?:string[];status:NativeActorInitResult["status"];failureKind:NativeActorInitResult["failureKind"]} {
    const contract=nativeControllerResourceContract(this.reader,this.files,input.actorId),result=this.initializer.resolve(input),overlay=this.reader.i16(0x5e4ca6+input.actorId*2);
    return {fileIds:[...new Set([...(overlay>0?[overlay]:[]),...(contract?.resourceFileIds??[]),...result.bindings.flatMap(binding=>binding.segments.map(s=>s.fileId)),...(result.readonlyMemory??[]).map(s=>s.fileId)])].sort((a,b)=>a-b),warnings:[...result.diagnostics,...(contract?.warnings??[])],completed:result.completed===true&&result.failureKind!=="unresolved",...(contract?{proofKind:contract.kind,provenance:contract.provenance}:{}),status:result.status,failureKind:result.failureKind};
  }
  private renderInputs(inputs:{actorRef:string;input:NativeActorInitInput}[]):ActorVisualPayload {
    const payload:ActorVisualPayload={actorVisuals:[],actorModels:[]},assets=new Map<string,ActorModel>();let bytes=0,triangles=0;
    for(const {actorRef,input} of inputs){
      const result=this.initializer.resolve(input);
      const visual:ActorVisual={actorRef,status:result.failureKind==="unresolved"?"unsupported":result.status==="nonvisual"?"nonvisual":result.status==="resolved"?"supported":result.status==="conditional"?"conditional":"unsupported",parts:[],warnings:[...result.diagnostics]};
      for(const binding of result.bindings){try{const model=this.asset(binding,result.syntheticMemory??[],result.readonlyMemory??[]);
        if(!assets.has(model.id)){const size=bytesFor(model),count=model.meshes.reduce((sum,m)=>sum+m.indices.length/3,0);if(bytes+size>64*1024*1024||triangles+count>200000||assets.size>=256)throw new Error("Room actor assets exceed the bounded preview budget.");assets.set(model.id,model);bytes+=size;triangles+=count;}
        const rootMatrix=identity();rootMatrix[0]=binding.scale.x;rootMatrix[5]=binding.scale.y;rootMatrix[10]=binding.scale.z;
        const rotationOverrides:Partial<Vec3>={};for(const axis of AXES)if(binding.rotationOverrideMask[axis])rotationOverrides[axis]=binding.rotation[axis];
        visual.parts.push({assetId:model.id,rootMatrix,positionOffset:binding.positionOffset,rotationOverrides,billboardAxes:{x:binding.rotation.x===-32768,y:binding.rotation.y===-32768,z:binding.rotation.z===-32768},pose:(binding.modelPointer&0x70000000)===0x40000000?"static":"initial-frame",provenance:{identity:binding.identity,slot:binding.slot,fileIds:[...new Set(binding.segments.map(s=>s.fileId))],modelPointer:binding.modelPointer,animationFrame:binding.animationFrame,animationBlendCountdown:binding.animationBlendCountdown}});
        // Rendering approximations do not erase a verified native model binding.
        for(const warning of model.warnings)if(!visual.warnings.includes(warning))visual.warnings.push(warning);
      }catch(error){visual.status="unsupported";visual.warnings.push(error instanceof Error?error.message:String(error));}}
      if(visual.status==="unsupported"||visual.status==="conditional")visual.reason=visual.warnings.join("; ")||"Native actor visual initialization is unresolved.";
      payload.actorVisuals.push(visual);
    }
    payload.actorModels=[...assets.values()];return payload;
  }
}
