import type {AxisFlags,Vec3} from "../../shared/types";

export type NativePoseChannel="scale"|"rotation"|"translation";
export interface NativeSkeletonPose {
  scale:Vec3;
  rotation:Vec3;
  translation:Vec3;
  /** These axes need the native camera-dependent alignment pass. */
  cameraAlignedAxes:Vec3;
}

/** Initial-frame sampler for func_8001B2C8_1BEC8's bounded byte stream. */
export function nativeInitialAnimationValue(offset:number,readByte:(offset:number)=>number):number {
  return nativeAnimationFrameValue(offset,0,readByte);
}

/** Integer-frame sampling of the native literal/run channel bytecode. */
export function nativeAnimationFrameValue(offset:number,frame:number,readByte:(offset:number)=>number):number {
  if(!Number.isInteger(frame)||frame<0||frame>65535)throw new Error("Invalid native animation frame.");
  let cursor=offset&0xffff;
  const read=()=>{const byte=readByte(cursor);cursor=(cursor+1)&0xffff;if(!Number.isInteger(byte)||byte<0||byte>255)throw new Error("Invalid native animation byte.");return byte;};
  let high=0;
  for(let commands=0;commands<4096;commands++){
    const command=read();
    if(command>=0xf0){const count=command&15;
      if(!count||frame<count){cursor=(cursor+frame*2)&0xffff;return (read()<<8)|read();}
      cursor=(cursor+count*2-2)&0xffff;high=read();read();frame-=count;continue;
    }
    if(command<0x78){
      if(command>=0x60)high=read();else if(command>=0x40)high=(high+1)&255;else if(command>=0x20)high=(high-1)&255;
      const count=command&31;
      if(!count||frame<count){cursor=(cursor+frame)&0xffff;return (high<<8)|read();}
      cursor=(cursor+count)&0xffff;frame-=count;
    }else{
      if(command>=0xd8)high=read();else if(command>=0xb8)high=(high+1)&255;else if(command>=0x98)high=(high-1)&255;
      const length=(command-0x78)&31,count=length?length+2:0,value=read();
      if(!count||frame<count)return (high<<8)|value;
      frame-=count;
    }
  }
  throw new Error("Native animation channel command budget exceeded.");
}

/** Native encoded channels are constants or offsets, never plain s16 TRS. */
export function nativePoseChannel(encoded:number,kind:NativePoseChannel,readAnimationByte?:(offset:number)=>number,frame=0):number {
  if(!Number.isInteger(encoded)||encoded<0||encoded>0xffff)throw new Error("Invalid native pose channel.");
  const masked=encoded&0xbfff;
  let value:number;
  if(masked>0xa000)value=(masked+0x5000)&0xffff;
  else{
    if(!readAnimationByte)throw new Error("Native pose requires an animation stream.");
    value=nativeAnimationFrameValue((encoded&0x8000)?encoded&0x3fff:masked,(encoded&0x8000)?0:frame,readAnimationByte);
  }
  if(kind==="scale")return value/256;
  if(kind==="rotation")return value&0x3ff;
  return (value>=0x8000?value-0x10000:value)/32;
}

/** Skeleton is 24 bytes; offsets and transforms follow the native SDK struct. */
export function decodeNativeSkeletonPose(bytes:Uint8Array,readAnimationByte?:(offset:number)=>number,frame=0):NativeSkeletonPose {
  if(bytes.length<24)throw new Error("Truncated native skeleton record.");
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  const vector=(offset:number,kind:NativePoseChannel):Vec3=>({x:nativePoseChannel(view.getUint16(offset),kind,readAnimationByte,frame),y:nativePoseChannel(view.getUint16(offset+2),kind,readAnimationByte,frame),z:nativePoseChannel(view.getUint16(offset+4),kind,readAnimationByte,frame)});
  return {scale:vector(6,"scale"),rotation:vector(12,"rotation"),translation:vector(18,"translation"),cameraAlignedAxes:{x:(view.getUint16(12)&0x4000)?1:0,y:(view.getUint16(14)&0x4000)?1:0,z:(view.getUint16(16)&0x4000)?1:0}};
}

/** Column-major T*Rz*Ry*Rx*S, matching func_80019ED8_1AAD8. */
export function nativePoseMatrix(pose:NativeSkeletonPose):number[] {
  if(pose.cameraAlignedAxes.x||pose.cameraAlignedAxes.y||pose.cameraAlignedAxes.z)throw new Error("Native skeleton pose requires camera alignment.");
  const angle=(n:number)=>n*Math.PI*2/1024;
  const sx=Math.sin(angle(pose.rotation.x)),cx=Math.cos(angle(pose.rotation.x)),sy=Math.sin(angle(pose.rotation.y)),cy=Math.cos(angle(pose.rotation.y)),sz=Math.sin(angle(pose.rotation.z)),cz=Math.cos(angle(pose.rotation.z));
  const {x,y,z}=pose.scale,t=pose.translation;
  const matrix=[cy*cz*x,cy*sz*x,-sy*x,0,(sx*sy*cz-cx*sz)*y,(sx*sy*sz+cx*cz)*y,sx*cy*y,0,(cx*sy*cz+sx*sz)*z,(cx*sy*sz-sx*cz)*z,cx*cy*z,0,t.x,t.y,t.z,1].map(Math.fround);
  if(!matrix.every(Number.isFinite))throw new Error("Native skeleton matrix is not finite.");
  return matrix;
}

/** Browser-safe native object transform (8001E9B0), before camera alignment. */
export function nativeActorPlacementMatrix(position:Vec3,rotation:Vec3):number[] {
  const phase=(value:number)=>value===-32768||value===32768?0:value&1023;
  return nativePoseMatrix({translation:position,rotation:{x:phase(rotation.x),y:phase(rotation.y),z:phase(rotation.z)},scale:{x:1,y:1,z:1},cameraAlignedAxes:{x:0,y:0,z:0}});
}

/** 80019D40's masked direction and guAlignF(angle=0); no camera-roll replay. */
export function nativeBillboardMatrix(cameraBack:Vec3,axes:AxisFlags):number[] {
  let x=axes.y||axes.z?-cameraBack.x:0,y=axes.x||axes.z?-cameraBack.y:0,z=axes.x||axes.y?-cameraBack.z:0;
  const matrix=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
  if(!axes.x&&!axes.y&&!axes.z)return matrix;
  const length=Math.hypot(x,y,z);if(!length)return matrix;x/=length;y/=length;z/=length;
  const planar=Math.hypot(x,z);if(!planar)return matrix;
  matrix[0]=-z/planar;matrix[4]=-y*x/planar;matrix[8]=-x;
  matrix[1]=0;matrix[5]=planar;matrix[9]=-y;
  matrix[2]=x/planar;matrix[6]=-y*z/planar;matrix[10]=-z;
  return matrix.map(Math.fround);
}

/** Bone4000 flags insert inverse selected object-angle rotation, then guAlign. */
export function nativeBoneBillboardMatrix(cameraBack:Vec3,objectRotation:Vec3,axes:AxisFlags):number[] {
  const selected={x:axes.x?objectRotation.x:0,y:axes.y?objectRotation.y:0,z:axes.z?objectRotation.z:0};
  const forward=nativeActorPlacementMatrix({x:0,y:0,z:0},selected),inverse=forward.map((_,i)=>forward[(i%4)*4+Math.floor(i/4)]),align=nativeBillboardMatrix(cameraBack,axes),result=new Array<number>(16).fill(0);
  for(let c=0;c<4;c++)for(let r=0;r<4;r++)for(let k=0;k<4;k++)result[c*4+r]+=inverse[k*4+r]*align[c*4+k];
  return result.map(Math.fround);
}
