import {decodeNativeSkeletonPose,nativePoseMatrix} from "./actors-pose";
import type {ModelDisplayRoot} from "./render";
import type {ActorModelNode,AxisFlags} from "../../shared/types";

export interface NativeModelGraph {roots:(ModelDisplayRoot&{nodeIndex:number})[];nodes:ActorModelNode[];warnings:string[];pose:"static"|"initial-frame";nodeCount:number;frames:number}
const identity=()=>[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
export function multiplyNativeMatrices(parent:number[],local:number[]):number[] {
  const output=new Array<number>(16).fill(0);
  for(let column=0;column<4;column++)for(let row=0;row<4;row++)for(let k=0;k<4;k++)output[column*4+row]+=parent[k*4+row]*local[column*4+k];
  return output.map(Math.fround);
}

/** Bounded static/initial-frame implementation of native 16C44/18718/18908. */
export function decodeNativeModelGraph(read:(address:number,size:number)=>Uint8Array,modelPointer:number,animationFrame=0,blendCountdown=0):NativeModelGraph {
  if(!Number.isInteger(animationFrame)||animationFrame<0)throw new Error("Native actor initial pose has an unsupported fractional/negative frame.");
  if(blendCountdown!==0)throw new Error("Native actor initial pose requires cached animation blending.");
  const type=(modelPointer>>>28)&7,pointer=(modelPointer&0x8ffffffe)>>>0;
  const graph:NativeModelGraph={roots:[],nodes:[],warnings:[],pose:type===4?"static":"initial-frame",nodeCount:0,frames:0};
  if(!pointer)return graph;
  if(type===4){graph.nodes.push({parentIndex:null,matrix:identity(),meshIndices:[]});graph.roots.push({displayList:pointer,label:"actor",nodeIndex:0});return graph;}
  if(type!==0&&type!==1&&type!==6)throw new Error(`Unsupported native actor model graph type ${type}.`);
  const header=read(pointer,8),view=new DataView(header.buffer,header.byteOffset,header.byteLength),flags=view.getUint32(0),animation=view.getUint32(4);
  if(!flags)return graph;
  const preliminary=(flags>>>28)&7,weighted=(flags>>>24)&15,count=(flags>>>8)&0x7fff;
  if(preliminary||weighted)graph.warnings.push("Native embedded camera/light declarations are replaced by the editor viewport and approximate preview lighting.");
  if(count>256)throw new Error("Native actor skeleton root budget exceeded.");
  graph.frames=flags&255;
  if(type===6&&!(flags&0x80000000))return graph;
  const inheritedRight=type===6||(flags&0x80000000)!==0,active=new Set<number>();
  const byte=animation?(offset:number)=>read((animation+offset)>>>0,1)[0]:undefined;
  const u32=(at:number)=>{const b=read(at,4);return new DataView(b.buffer,b.byteOffset,b.byteLength).getUint32(0);};
  const emit=(display:number,matrix:number[],nodeIndex:number,raw=false)=>{
    if((display&0x0fffff00)===0x0fffff00)return;
    // Native 196F0 passes this word directly to G_DL. RT64 RSP::fromSegmented
    // selects only the low four segment bits, including tagged raw words.
    const displaySegment=(display>>>24)&15;
    if(raw&&display<0x80000000&&displaySegment!==0&&(displaySegment<8||displaySegment>13))throw new Error("Unsupported native linked display control tag.");
    graph.roots.push({displayList:raw?display:(display&0x8fffffff)>>>0,matrix,label:`actor-node-${nodeIndex}`,preserveVertexCache:true,nodeIndex});
  };
  const draw=(display:number,matrix:number[],nodeIndex:number,depth:number)=>{
    if(!display)return;
    if(display&0x10000000){
      const linked=(display&0x8fffffff)>>>0;
      if(active.has(linked)||depth>64)throw new Error("Native actor linked skeleton cycle or depth limit.");
      active.add(linked);
      try{const record=read(linked,24),v=new DataView(record.buffer,record.byteOffset,record.byteLength);
        const rootDisplay=v.getUint32(0);if(rootDisplay)emit(rootDisplay,matrix,nodeIndex,true);
        for(const offset of [v.getInt8(4),v.getInt8(5)])if(offset)walk(linked+offset*24,matrix,nodeIndex,depth+1,false);
      }finally{active.delete(linked);}
    }else if((display&0x8fffffff)>>>0)emit(display,matrix,nodeIndex);
  };
  const walk=(at:number,parent:number[],parentIndex:number|null,depth:number,root:boolean)=>{
    if(depth>64||active.has(at))throw new Error("Native actor skeleton cycle or depth limit.");
    if(++graph.nodeCount>4096)throw new Error("Native actor skeleton node budget exceeded.");
    active.add(at);
    try{const record=read(at,24),v=new DataView(record.buffer,record.byteOffset,record.byteLength);
      const pose=root&&type!==0?undefined:decodeNativeSkeletonPose(record,byte,animationFrame);
      const billboardAxes:AxisFlags|undefined=pose?{x:!!pose.cameraAlignedAxes.x,y:!!pose.cameraAlignedAxes.y,z:!!pose.cameraAlignedAxes.z}:undefined;
      const local=pose?nativePoseMatrix({...pose,cameraAlignedAxes:{x:0,y:0,z:0}}):identity(),matrix=multiplyNativeMatrices(parent,local),nodeIndex=graph.nodes.length;
      graph.nodes.push({parentIndex,matrix:local,billboardAxes,meshIndices:[]});
      draw(v.getUint32(0),matrix,nodeIndex,depth+1);
      const right=v.getInt8(4),left=v.getInt8(5);
      if(right)walk(at+right*24,root||inheritedRight?matrix:parent,root||inheritedRight?nodeIndex:parentIndex,depth+1,false);
      if(left)walk(at+left*24,root?matrix:parent,root?nodeIndex:parentIndex,depth+1,false);
    }finally{active.delete(at);}
  };
  const rootCount=type===6?1:count,start=type===6?0:preliminary+weighted;
  for(let index=0;index<start+rootCount;index++){
    const root=u32(pointer+8+index*4);if(index<start){if(root)read(root,4);continue;}
    if(root)walk(root,identity(),null,0,true);
  }
  return graph;
}
