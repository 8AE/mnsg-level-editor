import type {GeometryMesh,GeometryTexture} from "../../shared/types";
import {RomReader} from "./binary";
import type {RomFile} from "./decompress";
import {geometryAuxiliaryRecord,graphicsLocation} from "./geometry";
import {NativeTextureMemory,textureCoordinate,type TextureTile} from "./textures";
import {RenderWaves} from "./waves";
import {actorTextureColorVariant,actorTextureProductVariant,actorPrimitiveAlphaTexture,nativeCombinerClamp,type ActorTextureColor} from "./actors-colors";

interface RenderVertex {position:number[];uv:number[];color:number[];normal:number[];lighting:boolean;texgen:boolean;loadRoot:number;sourceAddress:number}
export interface RenderCoverage {triangles:number;textured:number;untextured:number;unsupported:number;formats:Record<string,number>}
export interface RenderedRoom {meshes:GeometryMesh[];textures:GeometryTexture[];warnings:string[];coverage:RenderCoverage;complete:boolean;vertexAddresses?:number[][];materialCommands?:number[][][];materialStates?:RenderTriangleState[]}
export interface ModelDisplayRoot {displayList:number;material?:number;label?:string;matrix?:number[];preserveVertexCache?:boolean}
export interface RenderTriangleState {combine0:number;combine1:number;otherH:number;otherL:number;tile:number;tiles:TextureTile[]}
export interface ModelRenderOptions {inheritedTextureFallback?:boolean;vertexProvenance?:boolean;materialProvenance?:boolean}
interface Combiner {texture:boolean;shade:boolean;primitive:boolean;alphaPrimitive:boolean;alphaEnvironment?:boolean;environment?:"constant-add"|"shade-add"|ActorTextureColor;cycle?:number;environmentAfterShade?:boolean;secondTexture?:boolean}
const COMBINERS:Record<string,Combiner>={
  "fc127e24:fffff3f9":{texture:true,shade:true,primitive:false,alphaPrimitive:false},
  "fc127fff:fffff238":{texture:true,shade:true,primitive:false,alphaPrimitive:false},
  "fc327e64:fffffdfe":{texture:false,shade:true,primitive:true,alphaPrimitive:false},
  "fc327fff:fffff638":{texture:false,shade:true,primitive:true,alphaPrimitive:true},
  "fcffffff:fffdfcfe":{texture:false,shade:false,primitive:true,alphaPrimitive:false},
  "fcffffff:fffdf638":{texture:false,shade:false,primitive:true,alphaPrimitive:true},
  "fcffffff:fffcf279":{texture:true,shade:false,primitive:false,alphaPrimitive:false},
  "fcffffff:fffcf238":{texture:true,shade:false,primitive:false,alphaPrimitive:false},
  "fcff97ff:ff2cfe7f":{texture:true,shade:false,primitive:false,alphaPrimitive:true},
  // Native actor states verified against SDK mux fields and RT64 runCycle.
  "fc629ac5:ff34fe7f":{texture:true,shade:false,primitive:false,alphaPrimitive:false,alphaEnvironment:true,environment:"add-environment",cycle:0},
  "fc629ac5:ff37ffff":{texture:true,shade:false,primitive:false,alphaPrimitive:false,alphaEnvironment:true,environment:"environment",cycle:0},
  "fc62fec5:fffdfafd":{texture:false,shade:false,primitive:false,alphaPrimitive:false,alphaEnvironment:true,environment:"constant-add",cycle:0},
  "fc121624:ff2fffff":{texture:true,shade:true,primitive:false,alphaPrimitive:true,cycle:0},
  "fc327e64:fffefb7d":{texture:false,shade:true,primitive:true,alphaPrimitive:false,alphaEnvironment:true,environment:"shade-add",cycle:0},
  "fc567e04:1ffcf3f8":{texture:true,shade:true,primitive:false,alphaPrimitive:false,environment:"mix-environment",cycle:1},
  "fc121a24:ff36ff7f":{texture:true,shade:true,primitive:false,alphaPrimitive:false,alphaEnvironment:true,environment:"add-environment",environmentAfterShade:true,cycle:0},
  "fc1115ff:fffdfe3b":{texture:true,shade:false,primitive:false,alphaPrimitive:true,secondTexture:true,cycle:1},
};

/** Read-only presentation parser; structural translation proof never consumes this state. */
export function renderModelLists(read:(address:number,size:number)=>Uint8Array,roots:ModelDisplayRoot[],roomId=0,onTriangle?:(loadRoots:number[],drawRoot:number,state:RenderTriangleState)=>void,options:ModelRenderOptions={}):RenderedRoom {
  const result:RenderedRoom={meshes:[],textures:[],warnings:[],coverage:{triangles:0,textured:0,untextured:0,unsupported:0,formats:{}},complete:true};
  if(options.vertexProvenance)result.vertexAddresses=[];
  if(options.materialProvenance){result.materialCommands=[];result.materialStates=[];}
  const stateCommands:number[][]=[];
  const warnings=new Set<string>(),images=new Map<string,GeometryTexture>(),textureCache=new Map<string,GeometryTexture|Error>(),variants=new Map<string,GeometryTexture>(),failedProducts=new Set<string>();
  const memory=new NativeTextureMemory(read);
  let mode=0,otherH=0,otherL=0,tile=0,textureOn=false,scaleS=1,scaleT=1,primitive=[1,1,1,1],environment=[0,0,0,1],blendAlpha=0;
  let rootMatrix:number[]|undefined,drawRoot=0;
  let combine0=0,combine1=0,vertexCache=new Map<number,RenderVertex>(),active=new Set<number>(),commands=0,pixelBytes=0,currentKey="",rootLabel="render",unsupportedState=false;
  const rgba=(word:number)=>[(word>>>24)/255,((word>>>16)&255)/255,((word>>>8)&255)/255,(word&255)/255];
  const addImage=(image:GeometryTexture)=>{if(!images.has(image.id)){const size=image.width*image.height*4;if(pixelBytes+size>16*1024*1024||images.size>=128)throw new Error("Room texture budget exceeded.");images.set(image.id,image);pixelBytes+=size;}};
  const resolve=read;
  const triangle=(indices:number[])=>{
    if(++result.coverage.triangles>200000)throw new Error("Room render triangle budget exceeded.");
    const vertices=indices.map(index=>vertexCache.get(index));if(vertices.some(v=>!v))throw new Error("Rendered triangle uses unloaded vertices.");
    const rows=vertices as RenderVertex[],descriptor=memory.tiles[tile],filter=((otherH>>>12)&3)===0?"nearest":"linear";
    onTriangle?.(rows.map(vertex=>vertex.loadRoot),drawRoot,{combine0,combine1,otherH,otherL,tile,tiles:memory.tiles});
    const inheritedFallback=!!options.inheritedTextureFallback&&!combine0&&!combine1&&textureOn&&!unsupportedState&&!rows.some(vertex=>vertex.texgen);
    const combiner=COMBINERS[`${combine0.toString(16)}:${combine1.toString(16)}`]??(inheritedFallback?{texture:true,shade:false,primitive:false,alphaPrimitive:false} as Combiner:undefined);
    const wrongCycle=combiner?.cycle!==undefined&&combiner.cycle!==((otherH>>>20)&3);
    let texture:GeometryTexture|undefined,unsupported=unsupportedState||rows.some(vertex=>vertex.texgen)||!combiner||wrongCycle||inheritedFallback;
    if(combiner?.environmentAfterShade&&rows.some(vertex=>!vertex.lighting)){unsupported=true;warnings.add("Native texture/shade plus environment color requires a per-pixel unlit combiner; affected surfaces use an untextured fallback.");}
    if(wrongCycle)warnings.add("Unsupported native actor combiner cycle type; affected surfaces use an untextured fallback.");
    if(inheritedFallback)warnings.add("Native actor inherited scene material is unknown; displaying decoded native texture/UVs with a neutral static color fallback.");
    else if(!combiner)warnings.add(`Unsupported native color combiner ${combine0.toString(16)}/${combine1.toString(16)}; affected surfaces use an untextured fallback.`);
    if(rows.some(vertex=>vertex.texgen))warnings.add("Native generated texture coordinates are unsupported; affected surfaces use an untextured fallback.");
    if(textureOn&&combiner?.texture&&(!unsupported||inheritedFallback)){
      const textureKey=JSON.stringify([memory.version,descriptor,(otherH>>>14)&3]);let decoded=textureCache.get(textureKey);
      if(!decoded){if(textureCache.size>=4096)throw new Error("Native texture state cache budget exceeded.");try{decoded=memory.decode(tile,(otherH>>>14)&3);addImage(decoded);}catch(error){decoded=error instanceof Error?error:new Error(String(error));}textureCache.set(textureKey,decoded);}
      if(decoded instanceof Error){unsupported=true;warnings.add(`Texture unavailable: ${decoded.message}`);}else{
        texture=decoded;
        if(combiner.environment&&!["constant-add","shade-add"].includes(combiner.environment)){
          const mode=combiner.environment as ActorTextureColor,key=`${decoded.id}:${mode}:${environment.join(",")}`;let variant=variants.get(key);
          if(!variant){if(variants.size>=128)throw new Error("Actor color variant budget exceeded.");variant=actorTextureColorVariant(decoded,mode,environment);addImage(variant);variants.set(key,variant);}texture=variant;
          warnings.add("Native actor environment color is baked into a static texture variant; filtering at color-clamp boundaries is approximated.");
        }
        if(combiner.secondTexture){
          const second=memory.tiles[(tile+1)&7],fields=["cms","cmt","masks","maskt","shifts","shiftt","uls","ult","lrs","lrt"] as const;
          const aligned=fields.every(field=>descriptor[field]===second[field])&&(otherL&3)===0;
          const key=JSON.stringify(["native-product",memory.version,decoded.id,primitive,descriptor,second,aligned]);let composed=variants.get(key);
          if(!composed){
            if(variants.size>=128)throw new Error("Actor color variant budget exceeded.");
            if(aligned){try{const other=memory.decode((tile+1)&7,(otherH>>>14)&3);addImage(other);composed=actorTextureProductVariant(decoded,other,primitive);}catch(error){failedProducts.add(key);warnings.add(`Native actor second texture unavailable: ${error instanceof Error?error.message:String(error)}`);}}
            if(!composed)composed=actorPrimitiveAlphaTexture(decoded);addImage(composed);variants.set(key,composed);
          }
          if(failedProducts.has(key))unsupported=true;
          if(!aligned){unsupported=true;warnings.add("Native actor two-texture UV/sampler or alpha-compare state is unaligned; displaying the actual primary texture with unsupported composite appearance.");}
          else if(!failedProducts.has(key))warnings.add("Aligned native actor texture multiplication is baked into a static variant; filtering between source pixels is approximated.");
          texture=composed;
        }
      }
    }
    const lighting=rows[0].lighting&&!!combiner?.shade,mixed=rows.some(vertex=>vertex.lighting!==rows[0].lighting);
    if(mixed){unsupported=true;warnings.add("A triangle mixes native lighting/color vertex modes; its lighting is approximated.");}
    let color:[number,number,number]=combiner?.primitive?[primitive[0],primitive[1],primitive[2]]:[1,1,1];
    if(combiner?.environment==="constant-add"||combiner?.environment==="shade-add")color=combiner.environment==="shade-add"&&!lighting?[1,1,1]:[0,1,2].map(i=>nativeCombinerClamp(environment[i]+primitive[i])) as [number,number,number];
    // Surface identity includes raw combiner/primitive state even where lighting is approximate.
    const wrap=(bits:number):"repeat"|"mirror"|"clamp"=>(bits&2)?"clamp":(bits&1)?"mirror":"repeat";
    const material:NonNullable<GeometryMesh["material"]>={textureId:texture?.id,wrapS:wrap(descriptor.cms),wrapT:wrap(descriptor.cmt),filter,color,
      opacity:combiner?.alphaEnvironment?environment[3]:combiner?.alphaPrimitive?primitive[3]:1,alphaTest:!inheritedFallback&&!combiner?.secondTexture&&(otherL&3)===1?Math.max(blendAlpha,1/255):0,vertexColors:!!combiner?.shade&&!rows[0].lighting&&!mixed,lighting};
    // Preserve contiguous command order, including translucent surfaces.
    const key=JSON.stringify([material,combine0,combine1,primitive,environment]);
    let mesh=result.meshes[result.meshes.length-1];
    if(key!==currentKey||!mesh){if(result.meshes.length>=1024)throw new Error("Room material batch budget exceeded.");currentKey=key;mesh={id:`${rootLabel}:${roomId}:${result.meshes.length}`,source:"display-list",positions:[],indices:[],material,
      uvs:texture?[]:undefined,colors:material.vertexColors?[]:undefined,normals:lighting?[]:undefined};result.meshes.push(mesh);result.vertexAddresses?.push([]);
      result.materialCommands?.push(stateCommands.map(command=>[...command]));result.materialStates?.push(structuredClone({combine0,combine1,otherH,otherL,tile,tiles:memory.tiles}));}
    for(const vertex of rows){mesh.indices.push(mesh.positions.length/3);mesh.positions.push(...vertex.position);
      result.vertexAddresses?.[result.meshes.length-1].push(vertex.sourceAddress);
      if(mesh.uvs&&texture)mesh.uvs.push(textureCoordinate(vertex.uv[0],descriptor.shifts,descriptor.uls,texture.width,filter),textureCoordinate(vertex.uv[1],descriptor.shiftt,descriptor.ult,texture.height,filter));
      mesh.colors?.push(...(combiner?.environment==="shade-add"?vertex.color.map((shade,i)=>nativeCombinerClamp(primitive[i]*shade+environment[i])):vertex.color));mesh.normals?.push(...vertex.normal);}
    if(texture){result.coverage.textured++;result.coverage.formats[texture.format]=(result.coverage.formats[texture.format]??0)+1;}else result.coverage.untextured++;
    if(unsupported)result.coverage.unsupported++;
  };
  const run=(pointer:number,depth:number)=>{
    if(!pointer)return;if(depth>64||active.has(pointer))throw new Error("Material display-list cycle or depth limit.");active.add(pointer);
    try{for(let offset=0;offset<1024*1024;offset+=8){if(++commands>200000)throw new Error("Room material command budget exceeded.");const bytes=resolve(pointer+offset,8),view=new DataView(bytes.buffer,bytes.byteOffset,8),w0=view.getUint32(0),w1=view.getUint32(4),op=w0>>>24;
      if(options.materialProvenance&&![0x04,0x06,0xb8,0xbf,0xb1].includes(op)){if(stateCommands.length>=32768)throw new Error("Material provenance command budget exceeded.");stateCommands.push([w0,w1]);}
      if(op===0xb8)return;
      if(op===0x06){run(w1,depth+1);if(((w0>>>16)&255)===1)return;}
      else if(op===0x04){const count=(w0>>>10)&63,first=((w0>>>16)&255)/2;if(!count||!Number.isInteger(first)||first+count>64)throw new Error("Invalid render vertex range.");const data=resolve(w1,count*16),dv=new DataView(data.buffer,data.byteOffset,data.length);
        for(let i=0;i<count;i++){const at=i*16,lighting=(mode&0x20000)!==0;const signed=(n:number)=>n>=128?n-256:n;
          const p=[dv.getInt16(at),dv.getInt16(at+2),dv.getInt16(at+4)],m=rootMatrix;
          const position=m?[m[0]*p[0]+m[4]*p[1]+m[8]*p[2]+m[12],m[1]*p[0]+m[5]*p[1]+m[9]*p[2]+m[13],m[2]*p[0]+m[6]*p[1]+m[10]*p[2]+m[14]]:p;
          vertexCache.set(first+i,{position,uv:[dv.getInt16(at+8)/32*scaleS,dv.getInt16(at+10)/32*scaleT],loadRoot:drawRoot,sourceAddress:w1+at,
            color:[data[at+12]/255,data[at+13]/255,data[at+14]/255],normal:[signed(data[at+12])/127,signed(data[at+13])/127,signed(data[at+14])/127],lighting,texgen:(mode&0xc0000)!==0});}}
      else if(op===0xbf)triangle([((w1>>>16)&255)/2,((w1>>>8)&255)/2,(w1&255)/2]);
      else if(op===0xb1){triangle([((w0>>>16)&255)/2,((w0>>>8)&255)/2,(w0&255)/2]);triangle([((w1>>>16)&255)/2,((w1>>>8)&255)/2,(w1&255)/2]);}
      else if(op===0xb6)mode&=~w1;else if(op===0xb7)mode|=w1;
      else if(op===0xbb){textureOn=(w0&255)!==0;tile=(w0>>>8)&7;scaleS=(w1>>>16)/65536;scaleT=(w1&65535)/65536;}
      else if(op===0xba||op===0xb9){const shift=(w0>>>8)&255,length=w0&255;if(shift+length>32||!length)throw new Error("Invalid RDP other-mode field.");const mask=(length===32?0xffffffff:((2**length-1)<<shift))>>>0;if(op===0xba)otherH=((otherH&~mask)|(w1&mask))>>>0;else otherL=((otherL&~mask)|(w1&mask))>>>0;}
      else if(op===0xfd)memory.setImage(w0,w1);else if(op===0xf5)memory.setTile(w0,w1);else if(op===0xf2)memory.setTileSize(w0,w1);
      else if([0xf0,0xf3,0xf4].includes(op)){try{memory.load(op,w0,w1);}catch(error){memory.initialized.fill(0);memory.version++;warnings.add(`Texture load failed: ${error instanceof Error?error.message:String(error)}`);}}
      else if(op===0xfa)primitive=rgba(w1);else if(op===0xfb)environment=rgba(w1);else if(op===0xf9)blendAlpha=(w1&255)/255;else if(op===0xfc){combine0=w0;combine1=w1;}
      else if([0x01,0xb0,0xb2,0xbe].includes(op))throw new Error(`Unsupported position-changing render command 0x${op.toString(16)}.`);
      else if(op===0x03){if(((w0>>>16)&255)!==0x8a){unsupportedState=true;warnings.add("Unsupported native MOVEMEM render state; affected texture appearance is unavailable.");}}
      else if(op===0xbc){if(![0x02,0x08].includes(w0&255)){unsupportedState=true;warnings.add("Unsupported native MOVEWORD render state; affected texture appearance is unavailable.");}}
      else if(![0x00,0xc0,0xe6,0xe7,0xe8,0xe9,0xea,0xeb,0xec,0xed,0xee,0xef,0xf7,0xf8,0xfb,0xfe,0xff].includes(op)){unsupportedState=true;warnings.add(`Unsupported native render command 0x${op.toString(16)}; affected texture appearance is unavailable.`);}
    }throw new Error("Room material display list has no bounded terminator.");}finally{active.delete(pointer);}
  };
  for(const [index,root] of roots.entries()){
    if(!root.displayList)continue;
    drawRoot=index;if(!root.preserveVertexCache)vertexCache=new Map();currentKey="";rootLabel=root.label??"render";rootMatrix=root.matrix;
    try{if(rootMatrix&&(rootMatrix.length!==16||!rootMatrix.every(Number.isFinite)))throw new Error("Model root matrix is invalid.");if(root.material)run(root.material,0);run(root.displayList,0);}catch(error){result.complete=false;warnings.add(`Partial texture rendering: ${error instanceof Error?error.message:String(error)}`);}
  }
  result.textures=[...images.values()];result.warnings=[...warnings];
  if(result.meshes.length)result.warnings.push("Static texture pixels and surface UVs are decoded; native lighting, fog, three-point filtering and multi-stage color combining are approximated.");
  return result;
}

/** Native room wrapper retains exactly the original resource and root order. */
export function renderRoom(r:RomReader,roomId:number,files:Map<number,RomFile>,segment:(id:number)=>number,waves:RenderWaves,options:ModelRenderOptions={}):RenderedRoom {
  const location=graphicsLocation(r,roomId);
  if(!location)return {meshes:[],textures:[],warnings:[],coverage:{triangles:0,textured:0,untextured:0,unsupported:0,formats:{}},complete:true};
  const segments=new Map<number,number>();for(const field of [8,12,16]){const id=r.u32(location.record+field)&0xffff;if(id&&files.has(id))segments.set(segment(id),id);}
  const read=(address:number,size:number):Uint8Array=>{
    if(address>=0x80000000){if(address>=0x80100000)throw new Error("Material display list has an unsupported resident address.");const at=address-0x80000000+0xc00;r.check(at,size);return r.bytes.subarray(at,at+size);}
    return waves.read(address,size,segments);
  };
  const secondary=geometryAuxiliaryRecord(r,0x5c5804,location.group,location.index,8);
  const roots=[location.record,secondary].map(record=>({displayList:(r.u32(record)&0x8ffffffe)>>>0,material:(r.u32(record+4)&0xbfffffff)>>>0,label:record===secondary?"secondary":"render"}));
  return renderModelLists(read,roots,roomId,undefined,options);
}
