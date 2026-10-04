import type {GeometryMesh,GeometryTexture} from "../../shared/types";
import {RomReader} from "./binary";
import type {RomFile} from "./decompress";
import {geometryAuxiliaryRecord,graphicsLocation} from "./geometry";
import {NativeTextureMemory,textureCoordinate} from "./textures";
import {RenderWaves} from "./waves";

interface RenderVertex {position:number[];uv:number[];color:number[];normal:number[];lighting:boolean;texgen:boolean}
export interface RenderCoverage {triangles:number;textured:number;untextured:number;unsupported:number;formats:Record<string,number>}
export interface RenderedRoom {meshes:GeometryMesh[];textures:GeometryTexture[];warnings:string[];coverage:RenderCoverage;complete:boolean}
const COMBINERS:Record<string,{texture:boolean;shade:boolean;primitive:boolean;alphaPrimitive:boolean}>={
  "fc127e24:fffff3f9":{texture:true,shade:true,primitive:false,alphaPrimitive:false},
  "fc127fff:fffff238":{texture:true,shade:true,primitive:false,alphaPrimitive:false},
  "fc327e64:fffffdfe":{texture:false,shade:true,primitive:true,alphaPrimitive:false},
  "fc327fff:fffff638":{texture:false,shade:true,primitive:true,alphaPrimitive:true},
  "fcffffff:fffdfcfe":{texture:false,shade:false,primitive:true,alphaPrimitive:false},
  "fcffffff:fffdf638":{texture:false,shade:false,primitive:true,alphaPrimitive:true},
  "fcffffff:fffcf279":{texture:true,shade:false,primitive:false,alphaPrimitive:false},
  "fcffffff:fffcf238":{texture:true,shade:false,primitive:false,alphaPrimitive:false},
  "fcff97ff:ff2cfe7f":{texture:true,shade:false,primitive:false,alphaPrimitive:true},
};

/** Read-only presentation parser; structural translation proof never consumes this state. */
export function renderRoom(r:RomReader,roomId:number,files:Map<number,RomFile>,segment:(id:number)=>number,waves:RenderWaves):RenderedRoom {
  const result:RenderedRoom={meshes:[],textures:[],warnings:[],coverage:{triangles:0,textured:0,untextured:0,unsupported:0,formats:{}},complete:true};
  const location=graphicsLocation(r,roomId);if(!location)return result;
  const segments=new Map<number,number>();for(const field of [8,12,16]){const id=r.u32(location.record+field)&0xffff;if(id&&files.has(id))segments.set(segment(id),id);}
  const warnings=new Set<string>(),images=new Map<string,GeometryTexture>(),textureCache=new Map<string,GeometryTexture|Error>();
  const memory=new NativeTextureMemory((address,size)=>waves.read(address,size,segments));
  let mode=0,otherH=0,otherL=0,tile=0,textureOn=false,scaleS=1,scaleT=1,primitive=[1,1,1,1],blendAlpha=0;
  let combine0=0,combine1=0,vertexCache=new Map<number,RenderVertex>(),active=new Set<number>(),commands=0,pixelBytes=0,currentKey="",rootLabel="render",unsupportedState=false;
  const rgba=(word:number)=>[(word>>>24)/255,((word>>>16)&255)/255,((word>>>8)&255)/255,(word&255)/255];
  const resolve=(address:number,size:number):Uint8Array=>{
    if(address>=0x80000000){if(address>=0x80100000)throw new Error("Material display list has an unsupported resident address.");const at=address-0x80000000+0xc00;r.check(at,size);return r.bytes.subarray(at,at+size);}
    return waves.read(address,size,segments);
  };
  const triangle=(indices:number[])=>{
    if(++result.coverage.triangles>200000)throw new Error("Room render triangle budget exceeded.");
    const vertices=indices.map(index=>vertexCache.get(index));if(vertices.some(v=>!v))throw new Error("Rendered triangle uses unloaded vertices.");
    const rows=vertices as RenderVertex[],descriptor=memory.tiles[tile],filter=((otherH>>>12)&3)===0?"nearest":"linear";
    const combiner=COMBINERS[`${combine0.toString(16)}:${combine1.toString(16)}`];
    let texture:GeometryTexture|undefined,unsupported=unsupportedState||rows.some(vertex=>vertex.texgen)||!combiner;
    if(!combiner)warnings.add(`Unsupported native color combiner ${combine0.toString(16)}/${combine1.toString(16)}; affected surfaces use an untextured fallback.`);
    if(rows.some(vertex=>vertex.texgen))warnings.add("Native generated texture coordinates are unsupported; affected surfaces use an untextured fallback.");
    if(textureOn&&combiner?.texture&&!unsupported){
      const textureKey=JSON.stringify([memory.version,descriptor,(otherH>>>14)&3]);let decoded=textureCache.get(textureKey);
      if(!decoded){try{decoded=memory.decode(tile,(otherH>>>14)&3);if(!images.has(decoded.id)){const size=decoded.width*decoded.height*4;if(pixelBytes+size>16*1024*1024||images.size>=128)throw new Error("Room texture budget exceeded.");images.set(decoded.id,decoded);pixelBytes+=size;}}catch(error){decoded=error instanceof Error?error:new Error(String(error));}textureCache.set(textureKey,decoded);}
      if(decoded instanceof Error){unsupported=true;warnings.add(`Texture unavailable: ${decoded.message}`);}else texture=decoded;
    }
    const lighting=rows[0].lighting&&!!combiner?.shade,mixed=rows.some(vertex=>vertex.lighting!==rows[0].lighting);
    if(mixed){unsupported=true;warnings.add("A triangle mixes native lighting/color vertex modes; its lighting is approximated.");}
    const color:[number,number,number]=combiner?.primitive?[primitive[0],primitive[1],primitive[2]]:[1,1,1];
    // Surface identity includes raw combiner/primitive state even where lighting is approximate.
    const wrap=(bits:number):"repeat"|"mirror"|"clamp"=>(bits&2)?"clamp":(bits&1)?"mirror":"repeat";
    const material:NonNullable<GeometryMesh["material"]>={textureId:texture?.id,wrapS:wrap(descriptor.cms),wrapT:wrap(descriptor.cmt),filter,color,
      opacity:combiner?.alphaPrimitive?primitive[3]:1,alphaTest:(otherL&3)===1?Math.max(blendAlpha,1/255):0,vertexColors:!!combiner?.shade&&!rows[0].lighting&&!mixed,lighting};
    // Preserve contiguous command order, including translucent surfaces.
    const key=JSON.stringify([material,combine0,combine1,primitive]);
    let mesh=result.meshes[result.meshes.length-1];
    if(key!==currentKey||!mesh){if(result.meshes.length>=1024)throw new Error("Room material batch budget exceeded.");currentKey=key;mesh={id:`${rootLabel}:${roomId}:${result.meshes.length}`,source:"display-list",positions:[],indices:[],material,
      uvs:texture?[]:undefined,colors:material.vertexColors?[]:undefined,normals:lighting?[]:undefined};result.meshes.push(mesh);}
    for(const vertex of rows){mesh.indices.push(mesh.positions.length/3);mesh.positions.push(...vertex.position);
      if(mesh.uvs&&texture)mesh.uvs.push(textureCoordinate(vertex.uv[0],descriptor.shifts,descriptor.uls,texture.width,filter),textureCoordinate(vertex.uv[1],descriptor.shiftt,descriptor.ult,texture.height,filter));
      mesh.colors?.push(...vertex.color);mesh.normals?.push(...vertex.normal);}
    if(texture){result.coverage.textured++;result.coverage.formats[texture.format]=(result.coverage.formats[texture.format]??0)+1;}else result.coverage.untextured++;
    if(unsupported)result.coverage.unsupported++;
  };
  const run=(pointer:number,depth:number)=>{
    if(!pointer)return;if(depth>64||active.has(pointer))throw new Error("Material display-list cycle or depth limit.");active.add(pointer);
    try{for(let offset=0;offset<1024*1024;offset+=8){if(++commands>200000)throw new Error("Room material command budget exceeded.");const bytes=resolve(pointer+offset,8),view=new DataView(bytes.buffer,bytes.byteOffset,8),w0=view.getUint32(0),w1=view.getUint32(4),op=w0>>>24;
      if(op===0xb8)return;
      if(op===0x06){run(w1,depth+1);if(((w0>>>16)&255)===1)return;}
      else if(op===0x04){const count=(w0>>>10)&63,first=((w0>>>16)&255)/2;if(!count||!Number.isInteger(first)||first+count>64)throw new Error("Invalid render vertex range.");const data=resolve(w1,count*16),dv=new DataView(data.buffer,data.byteOffset,data.length);
        for(let i=0;i<count;i++){const at=i*16,lighting=(mode&0x20000)!==0;const signed=(n:number)=>n>=128?n-256:n;
          vertexCache.set(first+i,{position:[dv.getInt16(at),dv.getInt16(at+2),dv.getInt16(at+4)],uv:[dv.getInt16(at+8)/32*scaleS,dv.getInt16(at+10)/32*scaleT],
            color:[data[at+12]/255,data[at+13]/255,data[at+14]/255],normal:[signed(data[at+12])/127,signed(data[at+13])/127,signed(data[at+14])/127],lighting,texgen:(mode&0xc0000)!==0});}}
      else if(op===0xbf)triangle([((w1>>>16)&255)/2,((w1>>>8)&255)/2,(w1&255)/2]);
      else if(op===0xb1){triangle([((w0>>>16)&255)/2,((w0>>>8)&255)/2,(w0&255)/2]);triangle([((w1>>>16)&255)/2,((w1>>>8)&255)/2,(w1&255)/2]);}
      else if(op===0xb6)mode&=~w1;else if(op===0xb7)mode|=w1;
      else if(op===0xbb){textureOn=(w0&255)!==0;tile=(w0>>>8)&7;scaleS=(w1>>>16)/65536;scaleT=(w1&65535)/65536;}
      else if(op===0xba||op===0xb9){const shift=(w0>>>8)&255,length=w0&255;if(shift+length>32||!length)throw new Error("Invalid RDP other-mode field.");const mask=(length===32?0xffffffff:((2**length-1)<<shift))>>>0;if(op===0xba)otherH=((otherH&~mask)|(w1&mask))>>>0;else otherL=((otherL&~mask)|(w1&mask))>>>0;}
      else if(op===0xfd)memory.setImage(w0,w1);else if(op===0xf5)memory.setTile(w0,w1);else if(op===0xf2)memory.setTileSize(w0,w1);
      else if([0xf0,0xf3,0xf4].includes(op)){try{memory.load(op,w0,w1);}catch(error){memory.initialized.fill(0);memory.version++;warnings.add(`Texture load failed: ${error instanceof Error?error.message:String(error)}`);}}
      else if(op===0xfa)primitive=rgba(w1);else if(op===0xf9)blendAlpha=(w1&255)/255;else if(op===0xfc){combine0=w0;combine1=w1;}
      else if([0x01,0xb0,0xb2,0xbe].includes(op))throw new Error(`Unsupported position-changing render command 0x${op.toString(16)}.`);
      else if(op===0x03){if(((w0>>>16)&255)!==0x8a){unsupportedState=true;warnings.add("Unsupported native MOVEMEM render state; affected texture appearance is unavailable.");}}
      else if(op===0xbc){if(![0x02,0x08].includes(w0&255)){unsupportedState=true;warnings.add("Unsupported native MOVEWORD render state; affected texture appearance is unavailable.");}}
      else if(![0x00,0xc0,0xe6,0xe7,0xe8,0xe9,0xea,0xeb,0xec,0xed,0xee,0xef,0xf7,0xf8,0xfb,0xfe,0xff].includes(op)){unsupportedState=true;warnings.add(`Unsupported native render command 0x${op.toString(16)}; affected texture appearance is unavailable.`);}
    }throw new Error("Room material display list has no bounded terminator.");}finally{active.delete(pointer);}
  };
  const secondary=geometryAuxiliaryRecord(r,0x5c5804,location.group,location.index,8);
  for(const record of [location.record,secondary]){
    const model=r.u32(record),material=(r.u32(record+4)&0xbfffffff)>>>0;if(((model&0x8ffffffe)>>>0)===0)continue;
    vertexCache=new Map();currentKey="";rootLabel=record===secondary?"secondary":"render";
    try{if(material)run(material,0);run((model&0x8ffffffe)>>>0,0);}catch(error){result.complete=false;warnings.add(`Partial texture rendering: ${error instanceof Error?error.message:String(error)}`);}
  }
  result.textures=[...images.values()];result.warnings=[...warnings];
  if(result.meshes.length)result.warnings.push("Static texture pixels and surface UVs are decoded; native lighting, fog, three-point filtering and multi-stage color combining are approximated.");
  return result;
}
