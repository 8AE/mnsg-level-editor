import {createHash} from "node:crypto";
import type {ActorPrototype,ActorPrototypeEdits,ActorVisualPayload,AuthoringCatalog,GeometryAssetPayload,GeometryMesh,GeometryTexture,MaterialAssetEntry,NativeEntranceEntry,NativeActorParameters,RoomData,RoomSummary,SkyboxAssetPayload,Vec3} from "../../shared/types";
import {RomReader} from "../rom/binary";
import type {RomFile} from "../rom/decompress";
import {graphicsLocation,geometryAuxiliaryRecord} from "../rom/geometry";
import {renderRoom,type RenderTriangleState} from "../rom/render";
import {RenderWaves} from "../rom/waves";
import {ActorVisuals,type NativeDoorGeometry} from "../rom/actors";
import {ACTOR_NAMES,ACTOR_NAME_SOURCE} from "../rom/actors-names";
import {extractCollision,type GeometryTranslation} from "../rom/translation";
import type {NativeActorContext,NativeActorInitResult,NativeActorInitInput} from "../rom/actor-init";
import {decodeTexturePixel} from "../rom/textures";

const AXES=["x","y","z"] as const;
export const ACTOR_INITIALIZER_CANDIDATE_COUNT=0x406;
const digest=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
const zero=():Vec3=>({x:0,y:0,z:0});
export function prototypeId(actorId:number,parameters:NativeActorParameters,unknownHalfword:number):string {
  return `prototype:${actorId.toString(16).padStart(3,"0")}:${parameters.map(n=>n.toString(16).padStart(8,"0")).join(":")}:${unknownHalfword.toString(16).padStart(4,"0")}`;
}
export interface NativeAuthoringMaterial {
  id:string;commands:number[][];resourceFileIds:number[];
  relocations:{offset:number;fileId:number;segmentedAddress:number}[];
  textureWidth:number;textureHeight:number;state:RenderTriangleState;
  uv:{scaleS:number;scaleT:number;shiftS:number;shiftT:number;originS:number;originT:number;centerOffset:number};
  material:NonNullable<GeometryMesh["material"]>;
}
export interface NativeAuthoringPrototype {actorId:number;parameters:NativeActorParameters;unknownHalfword:number;resourceFileIds:number[];warnings:string[];placementWord:number;sourceKind?:"resident"|"normal"|"partition";dependencyClosure:"canonical-context"|"initializer-trace"|"verified-controller-closure";dependencyProvenance:string[]}
export interface NativeAuthoringDonor {roomId:number;actorFileId:number;resourceFileIds:number[];metadataOffset:number;graphicsOffset?:number;skyboxId?:string;environmentDefinitions:{actorId:number;parameters:NativeActorParameters;unknownHalfword:number;position:Vec3;rotation:Vec3;placementWord:number}[]}
export interface NativeAuthoringCollision {planes:Uint8Array;tree:Uint8Array;resourceFileIds:number[];planeCount:number;cellCount:number}
export interface AuthoringExportContext {
  prototype(id:string,edits?:ActorPrototypeEdits,context?:NativeActorContext):NativeAuthoringPrototype;
  doorAppearance(id:string,context?:NativeActorContext):NativeActorInitResult;
  doorGeometry?(id:string,context:NativeActorContext):NativeDoorGeometry;
  material(id:string):NativeAuthoringMaterial;
  skybox(id:string):{nativeIndex:number;fileId:number};
  donor(roomId:number):NativeAuthoringDonor;
  entrance(roomId:number,id:string):NativeEntranceEntry;
  collision(roomId:number,delta?:Vec3):NativeAuthoringCollision;
  resourceFileBytes(fileIds:readonly number[]):{totalBytes:number;files:{fileId:number;byteLength:number}[]};
}
interface CatalogHost {listRooms():RoomSummary[];loadBaseRoom(id:number):RoomData;loadRoom(id:number):RoomData;geometryTranslation?(roomId:number,t:Vec3):GeometryTranslation}
interface MaterialLocation {roomId:number;index:number}

/** Canonical identities and lazy native previews. No user supplied native pointers. */
export class NativeAuthoringCatalog {
  private catalog?:AuthoringCatalog;
  private readonly geometryRooms=new Map<string,{roomId:number;meshIndex?:number;parentId?:string}>();
  private readonly materials=new Map<string,MaterialLocation>();
  private readonly prototypes=new Map<string,ActorPrototype>();
  private readonly codeContextErrors=new Map<number,string>();
  private readonly assets=new Map<string,GeometryAssetPayload>();
  constructor(private readonly reader:RomReader,private readonly files:Map<number,RomFile>,private readonly waves:RenderWaves,private readonly actors:ActorVisuals,private readonly segment:(id:number)=>number,private readonly host:CatalogHost,private readonly romHash:string){}
  private resident(pointer:number,size:number):number {
    for(const [base,id] of [[0x801cb460,11],[0x8020d2a0,12]]){const f=this.files.get(id);if(f&&pointer>=base&&pointer+size<=base+f.end-f.start)return this.reader.check(f.start+pointer-base,size,f.end);}
    if(pointer>=0x80000450&&pointer+size<=0x8007e020)return this.reader.check(pointer-0x80000000+0xc00,size);
    throw new Error("Catalog references an unmapped resident address.");
  }
  private donorResources(roomId:number):number[] {
    const room=this.host.loadBaseRoom(roomId),resources=new Set<number>(),g=graphicsLocation(this.reader,roomId);
    if(g)for(const field of [8,12,16]){const id=this.reader.u32(g.record+field)&65535;if(id)resources.add(id);}
    if(room.source.expectedHex.length===56){const metadata=room.source.romOffset,file=this.reader.u16(metadata+20);if(file)resources.add(file);
      const callback=this.reader.u32(metadata+24);
      if(callback){const at=this.resident(callback,64),words=Array.from({length:16},(_,i)=>this.reader.u32(at+i*4));
        // These File12 wrappers load a fixed u16 list via 80013AC4.
        const call=words.findIndex(w=>(w>>>26)===3&&(((w&0x3ffffff)*4)|0x80000000)>>>0===0x80013ac4);
        if(call>=0){let address=0;for(let i=0;i<=Math.min(call+1,15);i++){const w=words[i],op=w>>>26,rs=(w>>>21)&31,rt=(w>>>16)&31,imm=w&65535;
          if(op===15&&rt===4)address=(imm*65536)>>>0;
          if((op===9||op===13)&&rs===4&&rt===4)address=(op===9?address+(imm>=0x8000?imm-65536:imm):address|imm)>>>0;}
          if(address){let ended=false;for(let i=0;i<512;i++){const id=this.reader.u16(this.resident(address+i*2,2));if(!id){ended=true;break;}if(id<0x8000&&!this.files.has(id))throw new Error("Room resource list references an unavailable file.");resources.add(id);}if(!ended)throw new Error("Room resource list has no bounded terminator.");}
        }
      }
    }
    return [...resources].sort((a,b)=>a-b);
  }
  getCatalog():AuthoringCatalog {
    if(this.catalog)return structuredClone(this.catalog);
    const catalog:AuthoringCatalog={romHash:this.romHash,actors:[],actorPrototypes:[],geometry:[],materials:[],surfaces:[],nativeEntrances:[],skyboxes:[],roomAdmission:{minId:620,maxId:799,supported:true,reason:"Native staging supports new rooms620–799 with verified ordinary world donors0–539. Other engine modes are restricted; generated patches still require user validation in the game."}};
    const registered=new Map<number,{overlay:number;warnings:string[]}>();
    for(let id=0;id<ACTOR_INITIALIZER_CANDIDATE_COUNT;id++){
      const entry=this.reader.u32(0x5e3c8c+id*4);if(!entry)continue;
      const overlay=this.reader.i16(0x5e4ca6+id*2),warnings:string[]=[];
      try{if(id===0x7d)throw new Error("Native initializer requires a fixed File15 CPU region that overlaps the resident File11 address map.");if(entry>=0x80000000)this.resident(entry,4);else{const file=this.files.get(overlay);if(!file||entry>>>24!==8)throw new Error();this.reader.check(file.start+(entry&0xffffff),4,file.end);}}
      catch(error){const reason=`Registered initializer has an unresolved native code context; ${error instanceof Error&&error.message?error.message:"its entry is not mapped by the verified standalone overlay."}`;warnings.push(reason);this.codeContextErrors.set(id,reason);}
      warnings.push(ACTOR_NAMES[id]?`Name source: ${ACTOR_NAME_SOURCE}.`:`Actor name is numeric; no supplied label for ID0x${id.toString(16)}.`);
      registered.set(id,{overlay,warnings});
    }
    const surfaces=new Map<string,{id:string;classifier:number;surface:number}>(),materialEntries=new Map<string,MaterialAssetEntry>();
    for(const summary of this.host.listRooms()){
      const room=this.host.loadBaseRoom(summary.id),donor=this.donorResources(room.id);
      const arrival=this.resident(0x8006b780+room.id*10,10),entryParameter=this.reader.i16(arrival+8)&255;
      catalog.nativeEntrances.push({id:`arrival:${room.id}`,roomId:room.id,name:`${room.name} · native default arrival`,position:{x:this.reader.i16(arrival),y:this.reader.i16(arrival+2),z:this.reader.i16(arrival+4)},baseYaw:this.reader.i16(arrival+6),entryParameter});
      for(const actor of room.actors){
        const p=actor.parameters as NativeActorParameters,unknown=actor.definitionSource?this.reader.u16(actor.definitionSource.romOffset+2):0,id=prototypeId(actor.actorId,p,unknown);
        if(!this.prototypes.has(id)){const overlay=registered.get(actor.actorId)?.overlay??0;
          const prototype:ActorPrototype={id,actorId:actor.actorId,name:ACTOR_NAMES[actor.actorId]??actor.name,parameters:[...p],unknownHalfword:unknown,sourceRoomId:room.id,sourceActorRef:actor.id,sourceKind:actor.sourceKind,resourceFileIds:[...new Set([...donor,...(overlay>0?[overlay]:[])])].sort((a,b)=>a-b),warnings:["Canonical native definition variant; game-state-dependent model visibility is reported by its preview."]};
          this.prototypes.set(id,prototype);}
        if(actor.actorId===0x8c){const p=actor.parameters,signed=(word:number)=>word>=0x8000?word-65536:word,destination=p[0]>>>16,player=p[2]&255;
          catalog.nativeEntrances.push({id:`transition:${room.id}:${actor.id}`,roomId:destination,name:`Arrival from ${room.name}`,position:{x:signed(p[0]&65535),y:signed(p[1]>>>16),z:signed(p[1]&65535)},baseYaw:signed(p[2]>>>16),entryParameter:player});}
      }
      const g=graphicsLocation(this.reader,room.id);if(!g)continue;
      const secondary=geometryAuxiliaryRecord(this.reader,0x5c5804,g.group,g.index,8),plane=geometryAuxiliaryRecord(this.reader,0x5c5834,g.group,g.index,4),tree=geometryAuxiliaryRecord(this.reader,0x5c584c,g.group,g.index,4);
      const id=`geometry:${digest([this.reader.hex(g.record,20),this.reader.hex(secondary,8),this.reader.u32(plane),this.reader.u32(tree)])}`;
      const existing=catalog.geometry.find(asset=>asset.id===id);
      if(existing){existing.roomIds.push(room.id);for(const component of catalog.geometry)if(component.id.startsWith(`component:${id.slice(9)}:`))component.roomIds.push(room.id);continue;}
      this.geometryRooms.set(id,{roomId:room.id});
      const rendered=renderRoom(this.reader,room.id,this.files,this.segment,this.waves,{materialProvenance:true});
      if(!rendered.meshes.length)continue;
      const file=this.files.get(this.reader.u32(g.record+8)&65535);
      const warnings=[...rendered.warnings];
      if(file){try{const collision=extractCollision(this.reader,file,this.reader.u32(plane),this.reader.u32(tree));
        const planeBase=file.start+(this.reader.u32(plane)&0xffffff),treeBase=file.start+(this.reader.u32(tree)&0xffffff);
        for(const header of collision.guards.filter(s=>s.kind==="cellTopology")){
          const surface=this.reader.u16(header.romOffset+2),visited=new Set<number>(),stack=[(header.romOffset-treeBase)/6+3];
          while(stack.length){const index=stack.pop()!;if(!index||visited.has(index))continue;visited.add(index);const at=this.reader.check(treeBase+index*6,6,file.end),classifier=this.reader.bytes[this.reader.check(planeBase+this.reader.u16(at)*20,20,file.end)+16],key=`surface:${classifier.toString(16).padStart(2,"0")}:${surface.toString(16).padStart(4,"0")}`;surfaces.set(key,{id:key,classifier,surface});stack.push(this.reader.u16(at+2),this.reader.u16(at+4));}
        }
      }catch(error){warnings.push(`Native collision catalog: ${error instanceof Error?error.message:String(error)}`);}}
      rendered.meshes.forEach((mesh,index)=>{if(!mesh.material)return;const materialId=this.materialId(room.id,index,mesh.material,rendered.materialCommands?.[index]??[]);this.materials.set(materialId,{roomId:room.id,index});if(!materialEntries.has(materialId))materialEntries.set(materialId,{id:materialId,name:`${room.name} · surface ${index+1}`,material:mesh.material,textureIds:mesh.material.textureId?[mesh.material.textureId]:[]});});
      catalog.geometry.push({id,name:room.name,roomIds:[room.id],meshCount:rendered.meshes.length,vertexCount:rendered.meshes.reduce((n,m)=>n+m.positions.length/3,0),triangleCount:rendered.coverage.triangles,warnings});
      rendered.meshes.forEach((mesh,index)=>{const componentId=`component:${id.slice(9)}:${index}`;this.geometryRooms.set(componentId,{roomId:room.id,meshIndex:index,parentId:id});catalog.geometry.push({id:componentId,name:`${room.name} · surface ${index+1}`,roomIds:[room.id],meshCount:1,vertexCount:mesh.positions.length/3,triangleCount:mesh.indices.length/3,warnings:["Independently placeable native draw surface; source collision is separate."]});});
      const bg=geometryAuxiliaryRecord(this.reader,0x5c587c,g.group,g.index,2),bgResource=geometryAuxiliaryRecord(this.reader,0x5c581c,g.group,g.index,8),nativeIndex=this.reader.u16(bg),bgFile=this.reader.i16(bgResource+6);
      if(nativeIndex&&bgFile&&!catalog.skyboxes.some(s=>s.nativeIndex===nativeIndex&&s.fileId===bgFile))catalog.skyboxes.push({id:`skybox:${nativeIndex}:${bgFile}`,name:`Native scrolling background ${nativeIndex}`,nativeIndex,fileId:bgFile,warnings:["Native 2D scrolling background; not a cube-map skybox."]});
    }
    for(const [actorId,{overlay,warnings}] of registered){
      if(![...this.prototypes.values()].some(p=>p.actorId===actorId)){
        const p:NativeActorParameters=[0,0,0],id=prototypeId(actorId,p,0),prototype:ActorPrototype={id,actorId,name:ACTOR_NAMES[actorId]??`Actor 0x${actorId.toString(16).toUpperCase().padStart(3,"0")}`,parameters:p,unknownHalfword:0,resourceFileIds:overlay>0?[overlay]:[],warnings:["This registered actor has no original room placement. Zero parameters are a preview seed, not a verified gameplay configuration."]};
        this.prototypes.set(id,prototype);
      }
      catalog.actors.push({actorId,name:ACTOR_NAMES[actorId]??`Actor 0x${actorId.toString(16).toUpperCase().padStart(3,"0")}`,prototypeIds:[...this.prototypes.values()].filter(p=>p.actorId===actorId).map(p=>p.id),warnings});
    }
    catalog.actorPrototypes=[...this.prototypes.values()];catalog.surfaces=[...surfaces.values()];catalog.materials=[...materialEntries.values()];
    this.catalog=catalog;
    // Prefer a verified visual seed for the library thumbnail while retaining
    // every exact canonical parameter variant for deliberate selection.
    for(const entry of catalog.actors){let best=entry.prototypeIds[0],score=-1;
      for(const id of entry.prototypeIds){const visual=this.loadActorPrototype(id).actorVisuals[0];
        const rank=visual?.parts.length?(visual.status==="supported"?5:visual.status==="conditional"?4:3):visual?.status==="nonvisual"?2:1;
        if(rank>score){best=id;score=rank;}if(rank===5)break;
      }
      entry.prototypeIds=[best,...entry.prototypeIds.filter(id=>id!==best)];
    }
    return structuredClone(catalog);
  }
  private materialId(roomId:number,index:number,material:GeometryMesh["material"],commands:number[][]):string {
    const g=graphicsLocation(this.reader,roomId)!;
    return `material:${digest([material,commands,[8,12,16].map(field=>this.reader.u32(g.record+field)&65535)])}`;
  }
  nativeSkyboxId(roomId:number):string|undefined {
    this.host.loadBaseRoom(roomId);const g=graphicsLocation(this.reader,roomId);if(!g)return undefined;
    const index=this.reader.u16(geometryAuxiliaryRecord(this.reader,0x5c587c,g.group,g.index,2)),file=this.reader.i16(geometryAuxiliaryRecord(this.reader,0x5c581c,g.group,g.index,8)+6);
    return index&&file?`skybox:${index}:${file}`:undefined;
  }
  nativeGeometryAssetId(roomId:number):string|undefined {
    this.host.loadBaseRoom(roomId);if(!this.catalog)this.getCatalog();return this.catalog!.geometry.find(entry=>entry.id.startsWith("geometry:")&&entry.roomIds.includes(roomId))?.id;
  }
  decorateRoom(room:RoomData):RoomData {
    const assetId=this.nativeGeometryAssetId(room.id);if(!assetId)return room;
    const asset=this.loadGeometryAsset(assetId);if(asset.meshes.length!==room.meshes.length)throw new Error("Native authoring mesh inventory changed.");
    for(let index=0;index<room.meshes.length;index++){
      const mesh=room.meshes[index],source=asset.meshes[index];
      if(digest([mesh.positions,mesh.indices,mesh.uvs,mesh.material])!==digest([source.positions,source.indices,source.uvs,source.material]))throw new Error("Native authoring mesh does not match its canonical asset.");
      mesh.id=source.id;mesh.materialId=source.materialId;
    }
    return room;
  }
  private prototype(id:string):ActorPrototype {if(!this.catalog)this.getCatalog();const p=this.prototypes.get(id);if(!p)throw new Error("Unknown ROM actor prototype ID.");return p;}
  private actorContext(context:NativeActorContext):NativeActorContext {
    if(!context||!Number.isInteger(context.roomId)||context.roomId<0||context.roomId>799)throw new Error("Invalid native actor room context.");
    const donor=context.templateRoomId??context.roomId;
    if(!Number.isInteger(donor)||donor<0||donor>=620||!this.host.listRooms().some(room=>room.id===donor))throw new Error("Actor context requires a verified native room donor.");
    this.host.loadBaseRoom(donor);
    // Match the authored room's 4096-placement budget. Only the required
    // predecessor constructor is executed; the other entries are metadata.
    if(context.siblings!==undefined){if(!Array.isArray(context.siblings)||context.siblings.length>4096)throw new Error("Native actor sibling roster exceeds its count bound.");
      for(const sibling of context.siblings){this.prototype(sibling.prototypeId);if(!Array.isArray(sibling.parameters)||sibling.parameters.length!==3||sibling.parameters.some(value=>!Number.isInteger(value)||value<0||value>0xffffffff))throw new Error("Invalid native sibling parameters.");
        for(const vector of [sibling.position,sibling.rotation])if(!vector||AXES.some(axis=>!Number.isInteger(vector[axis])||vector[axis]<-32768||vector[axis]>32767))throw new Error("Invalid native sibling transform.");}
    }
    return {roomId:context.roomId,...(context.templateRoomId===undefined?{}:{templateRoomId:donor}),...(context.siblings===undefined?{}:{siblings:structuredClone(context.siblings)})};
  }
  private actorInput(p:ActorPrototype,parameters:number[],position:Vec3,rotation:Vec3,context?:NativeActorContext):NativeActorInitInput {
    const input:NativeActorInitInput={actorId:p.actorId,parameters,position,rotation,unknownHalfword:p.unknownHalfword,roomId:context?.roomId??p.sourceRoomId,...(context?.templateRoomId===undefined?{}:{templateRoomId:context.templateRoomId})};
    if(p.actorId!==0x1b0)return input;
    let siblingInput:NativeActorInitInput|undefined;
    if(context?.siblings!==undefined){
      const index=context.siblings.findIndex(sibling=>sibling.prototypeId===p.id&&sibling.parameters.every((value,i)=>value===parameters[i])&&AXES.every(axis=>sibling.position[axis]===position[axis]&&sibling.rotation[axis]===rotation[axis]));
      const sibling=context.siblings.slice(0,Math.max(index,0)).find(sibling=>this.prototype(sibling.prototypeId).actorId===0x287);
      if(sibling){const proto=this.prototype(sibling.prototypeId);siblingInput={actorId:0x287,parameters:sibling.parameters,position:sibling.position,rotation:sibling.rotation,unknownHalfword:proto.unknownHalfword,roomId:input.roomId,templateRoomId:input.templateRoomId};}
    }else if(p.sourceRoomId!==undefined&&(!context||context.roomId===p.sourceRoomId)){
      const room=this.host.loadBaseRoom(p.sourceRoomId),index=room.actors.findIndex(actor=>actor.id===p.sourceActorRef),sibling=room.actors.slice(0,index).find(actor=>actor.actorId===0x287);
      if(sibling)siblingInput={actorId:0x287,parameters:sibling.parameters,position:sibling.position,rotation:sibling.rotation,unknownHalfword:sibling.definitionSource?this.reader.u16(sibling.definitionSource.romOffset+2):0,roomId:input.roomId,templateRoomId:input.templateRoomId};
    }
    if(siblingInput){const prior=this.actors.resolveNative(siblingInput);if(prior.completed&&prior.failureKind!=="unresolved")input.priorScene=prior;}
    if(!input.priorScene)input.requiredSiblingMissing=true;
    return input;
  }
  loadActorPrototypeForRoom(id:string,edits:ActorPrototypeEdits,context:NativeActorContext):ActorVisualPayload {return this.loadActorPrototype(id,edits,this.actorContext(context));}
  loadActorPrototype(id:string,edits:ActorPrototypeEdits={},context?:NativeActorContext):ActorVisualPayload {
    const p=this.prototype(id);if(!edits||typeof edits!=="object"||Array.isArray(edits)||Object.keys(edits).some(k=>!["parameters","position","rotation"].includes(k)))throw new Error("Invalid actor prototype edits.");
    const parameters=edits.parameters??p.parameters;if(!Array.isArray(parameters)||parameters.length!==3||parameters.some(n=>!Number.isInteger(n)||n<0||n>0xffffffff))throw new Error("Actor prototype requires three u32 parameters.");
    const position=edits.position??zero(),rotation=edits.rotation??zero();for(const value of [position,rotation])if(!value||Object.keys(value).length!==3||AXES.some(axis=>!Number.isInteger(value[axis])||value[axis]<-32768||value[axis]>32767))throw new Error("Actor prototype transforms must use signed16 coordinates.");
    const contextError=this.codeContextErrors.get(p.actorId);if(contextError&&p.actorId!==0x7d)return {actorModels:[],actorVisuals:[{actorRef:id,status:"unsupported",parts:[],reason:contextError,warnings:[contextError]}]};
    const input=this.actorInput(p,parameters,position,rotation,context);
    // A library-only display hint for the verified distance-gated constructor.
    // Dependency traces, placed previews and exports use their actual scene.
    if(p.actorId===0x147&&!context)input.thumbnailPlayerPosition=position;
    return this.actors.preview(input,id);
  }
  loadGeometryAsset(id:string):GeometryAssetPayload {
    if(!this.catalog)this.getCatalog();const cached=this.assets.get(id);if(cached){this.assets.delete(id);this.assets.set(id,cached);return structuredClone(cached);}
    const location=this.geometryRooms.get(id);if(!location||!this.catalog!.geometry.some(g=>g.id===id))throw new Error("Unknown native geometry asset ID.");
    if(location.meshIndex!==undefined){const parent=this.loadGeometryAsset(location.parentId!),mesh=parent.meshes[location.meshIndex],refs=parent.vertexRefs[location.meshIndex],used=new Set(refs);return {id,meshes:[mesh],textures:parent.textures.filter(t=>t.id===mesh.material?.textureId),vertexRefs:[refs],vertexSources:parent.vertexSources.filter(source=>used.has(source.id)),collision:[],warnings:["Native draw surface is independent from its room collision. Author collision for the placed component."]};}
    const roomId=location.roomId;
    const g=graphicsLocation(this.reader,roomId)!,rendered=renderRoom(this.reader,roomId,this.files,this.segment,this.waves,{vertexProvenance:true,materialProvenance:true});if(!rendered.complete)throw new Error("Native geometry asset traversal is incomplete.");
    const segments=new Map<number,RomFile>();for(const field of [8,12,16]){const file=this.files.get(this.reader.u32(g.record+field)&65535);if(file)segments.set(this.segment(file.id),file);}
    const sources=new Map<string,GeometryAssetPayload["vertexSources"][number]>();
    const vertexRefs=(rendered.vertexAddresses??[]).map(addresses=>addresses.map(address=>{
      const file=segments.get(address>>>24);if(!file)throw new Error("Geometry vertex provenance has no native file binding.");const at=this.reader.check(file.start+(address&0xffffff),16,file.end),key=`vertex:${file.id.toString(16)}:${(address&0xffffff).toString(16)}`;
      if(!sources.has(key))sources.set(key,{id:key,position:{x:this.reader.i16(at),y:this.reader.i16(at+2),z:this.reader.i16(at+4)},source:{fileId:file.id,segmentedAddress:address,romOffset:at,expectedHex:this.reader.hex(at,16)}});return key;
    }));
    rendered.meshes.forEach((mesh,index)=>{if(mesh.material)mesh.materialId=this.materialId(roomId,index,mesh.material,rendered.materialCommands?.[index]??[]);});
    const payload:GeometryAssetPayload={id,meshes:rendered.meshes,textures:rendered.textures,vertexRefs,vertexSources:[...sources.values()],collision:[],warnings:[...rendered.warnings,"Native collision uses BSP half-spaces; polygon collision reconstruction is not yet supplied. Author collision explicitly before exporting a replacement room."]};
    while(this.assets.size>=2)this.assets.delete(this.assets.keys().next().value!);this.assets.set(id,payload);return structuredClone(payload);
  }
  resolveMaterial(id:string):{material:NonNullable<GeometryMesh["material"]>;textures:GeometryTexture[]} {
    if(!this.catalog)this.getCatalog();const location=this.materials.get(id);if(!location)throw new Error("Unknown ROM material ID.");const rendered=renderRoom(this.reader,location.roomId,this.files,this.segment,this.waves),mesh=rendered.meshes[location.index];if(!mesh?.material)throw new Error("Native material batch changed.");
    return {material:structuredClone(mesh.material),textures:structuredClone(rendered.textures.filter(t=>t.id===mesh.material!.textureId))};
  }
  loadSkyboxAsset(id:string):SkyboxAssetPayload {
    if(!this.catalog)this.getCatalog();const sky=this.catalog!.skyboxes.find(s=>s.id===id);if(!sky||sky.nativeIndex<1||sky.nativeIndex>4)throw new Error("Unknown native scrolling background ID.");
    const wave=this.waves.wave(sky.fileId),image=this.reader.u32(0x5c57cc+(sky.nativeIndex-1)*4),palette=this.reader.u32(0x5c57dc+(sky.nativeIndex-1)*4),width=640,height=240;
    if(image>>>24!==10||palette>>>24!==10||(image&0xffffff)+width*height>wave.length||(palette&0xffffff)+512>wave.length)throw new Error("Native scrolling background exceeds its validated CI8 allocation.");
    const rgba=new Uint8Array(width*height*4),paletteOffset=palette&0xffffff,imageOffset=image&0xffffff;
    for(let pixel=0;pixel<width*height;pixel++){const at=paletteOffset+wave[imageOffset+pixel]*2,word=(wave[at]<<8)|wave[at+1];rgba.set(decodeTexturePixel(2,1,[0],word,2),pixel*4);}
    return {id,texture:{id:`sky-texture:${digest([sky.nativeIndex,sky.fileId,createHash("sha256").update(rgba).digest("hex")])}`,width,height,rgbaBase64:Buffer.from(rgba).toString("base64"),format:"CI8/TLUTRGBA16"},warnings:[...sky.warnings,"Preview shows the native source bitmap; game scrolling/camera projection is approximated."]};
  }
  exportContext():AuthoringExportContext {
    return {prototype:(id,edits={},context)=>{const p=this.prototype(id),parameters=edits.parameters??p.parameters,position=edits.position??zero(),rotation=edits.rotation??zero();
      if(this.codeContextErrors.has(p.actorId))throw new Error(`Actor0x${p.actorId.toString(16)} cannot be exported yet: ${this.codeContextErrors.get(p.actorId)}`);
      if(!Array.isArray(parameters)||parameters.length!==3||parameters.some(n=>!Number.isInteger(n)||n<0||n>0xffffffff))throw new Error("Invalid native actor parameters.");
      for(const value of [position,rotation])if(!value||AXES.some(axis=>!Number.isInteger(value[axis])||value[axis]<-32768||value[axis]>32767))throw new Error("Invalid native actor transform.");
      const target=context?this.actorContext(context):undefined;
      const nativeInput=this.actorInput(p,parameters,position,rotation,target),deps=this.actors.dependencies(nativeInput);
      const canonical=p.sourceRoomId!==undefined&&parameters.every((value,index)=>value===p.parameters[index])&&(!target||target.roomId===p.sourceRoomId&&(target.templateRoomId===undefined||target.templateRoomId===p.sourceRoomId));
      const controller=deps.proofKind==="verified-controller-closure";
      if(nativeInput.requiredSiblingMissing||!canonical&&!deps.completed&&!controller)throw new Error(`Actor0x${p.actorId.toString(16)} has an unresolved resource dependency path for the edited or destination-room context: ${deps.warnings.join(" ")}`);
      const source=p.sourceRoomId===undefined?undefined:this.host.loadBaseRoom(p.sourceRoomId).actors.find(actor=>actor.id===p.sourceActorRef);
      return {actorId:p.actorId,parameters:[...parameters],unknownHalfword:p.unknownHalfword,placementWord:source?this.reader.u32(source.source.romOffset+16):0,sourceKind:source?.sourceKind,resourceFileIds:[...new Set([...p.resourceFileIds,...deps.fileIds])].sort((a,b)=>a-b),warnings:[...p.warnings,...deps.warnings],dependencyClosure:controller?"verified-controller-closure":canonical?"canonical-context":"initializer-trace",dependencyProvenance:[...(controller?deps.provenance??[]:[canonical?`Verified canonical placement ${p.sourceRoomId}/${p.sourceActorRef} and its native donor load list.`:"All selected native constructor/deferred/child calls returned without an unresolved dependency path."]),`Destination room ${target?.roomId??p.sourceRoomId??0}; ancillary donor ${target?.templateRoomId??target?.roomId??p.sourceRoomId??0}. Live-state path remains conditional when reported by the initializer.`]};},
      doorAppearance:(id,context)=>{const p=this.prototype(id),target=context?this.actorContext(context):undefined;if(this.codeContextErrors.has(p.actorId))throw new Error(this.codeContextErrors.get(p.actorId));return this.actors.resolveNative({actorId:p.actorId,parameters:p.parameters,position:zero(),rotation:zero(),unknownHalfword:p.unknownHalfword,roomId:target?.roomId??p.sourceRoomId,...(target?.templateRoomId===undefined?{}:{templateRoomId:target.templateRoomId})});},
      doorGeometry:(id,context)=>{const p=this.prototype(id),target=this.actorContext(context);if(this.codeContextErrors.has(p.actorId))throw new Error(this.codeContextErrors.get(p.actorId));return this.actors.doorGeometry({actorId:p.actorId,parameters:p.parameters,position:zero(),rotation:zero(),unknownHalfword:p.unknownHalfword,...target});},
      material:id=>{
        if(!this.catalog)this.getCatalog();const location=this.materials.get(id);if(!location)throw new Error("Unknown native material ID.");
        const r=renderRoom(this.reader,location.roomId,this.files,this.segment,this.waves,{materialProvenance:true}),mesh=r.meshes[location.index],state=r.materialStates?.[location.index];
        if(!r.complete||!mesh.material||!state)throw new Error("Native material provenance is incomplete.");
        const texture=r.textures.find(t=>t.id===mesh.material!.textureId),g=graphicsLocation(this.reader,location.roomId)!,resourceFileIds=[8,12,16].map(field=>this.reader.u32(g.record+field)&65535).filter(Boolean),commands=r.materialCommands![location.index],relocations:NativeAuthoringMaterial["relocations"]=[];
        let scaleS=1,scaleT=1;
        commands.forEach(([w0,w1],index)=>{
          const op=w0>>>24;if(op===0xbb){scaleS=(w1>>>16)/65536;scaleT=(w1&65535)/65536;}
          if(op===0xfd||op===0x03){
            if(w1>=0x80000000){this.resident(w1,op===0x03?16:1);return;}
            const fileId=resourceFileIds.find(id=>this.segment(id)===w1>>>24);if(fileId===undefined)throw new Error("Native material pointer has no validated resource binding.");
            const wave=this.waves.wave(fileId);if((w1&0xffffff)>=wave.length)throw new Error("Native material pointer exceeds its resource allocation.");relocations.push({offset:index*8+4,fileId,segmentedAddress:w1});
          }
        });
        const tile=state.tiles[state.tile];return {id,commands,resourceFileIds,relocations,textureWidth:texture?.width??1,textureHeight:texture?.height??1,state,material:mesh.material,uv:{scaleS,scaleT,shiftS:tile.shifts,shiftT:tile.shiftt,originS:tile.uls/4,originT:tile.ult/4,centerOffset:mesh.material.filter==="linear"?0.5:0}};
      },
      skybox:id=>{if(!this.catalog)this.getCatalog();const sky=this.catalog!.skyboxes.find(s=>s.id===id);if(!sky)throw new Error("Unknown native background ID.");return {nativeIndex:sky.nativeIndex,fileId:sky.fileId};},
      entrance:(roomId,id)=>{if(!this.catalog)this.getCatalog();const entrance=this.catalog!.nativeEntrances.find(e=>e.id===id&&e.roomId===roomId);if(!entrance)throw new Error("Unknown native destination entrance ID.");return structuredClone(entrance);},
      resourceFileBytes:fileIds=>{
        if(!Array.isArray(fileIds)||fileIds.length>4096)throw new Error("Native resource list exceeds its count budget.");
        const files=[...new Set(fileIds)].map(fileId=>{
          if(!Number.isInteger(fileId)||fileId<=0||!this.files.has(fileId))throw new Error(`Native resource${fileId} has no verified whole-file allocation.`);
          const file=this.files.get(fileId)!,start=this.reader.u32(0x556c4+fileId*8),end=this.reader.u32(0x556c4+fileId*8+4),byteLength=end-start;
          const paddedLength=Math.ceil((file.end-file.start)/2)*2;
          if(!Number.isSafeInteger(byteLength)||byteLength<paddedLength||byteLength>16*1024*1024||(start>>>24)!==(end>>>24))throw new Error(`Native resource${fileId} allocation is invalid.`);
          // Prove the whole native load, including every PIC part, before any
          // patch is emitted. Plain code/path files use their allocation's own
          // segment rather than the rendering registry; only an empty part
          // list permits that separate, byte-copy-only path.
          try{if(this.waves.wave(fileId).length!==byteLength)throw new Error("Native resource allocation length changed.");}
          catch(error){const pointer=this.reader.u32(0x6a51c+fileId*4),empty=pointer>=0x80000000&&pointer<0x80100000&&this.reader.u32(pointer-0x80000000+0xc00)===0;
            if(!empty||(start>>>24)===this.segment(fileId))throw error;
          }
          return {fileId,byteLength};
        });return {totalBytes:files.reduce((sum,file)=>sum+file.byteLength,0),files};
      },
      collision:(roomId,delta)=>{
        const translation=delta&&AXES.some(axis=>delta[axis]!==0)?this.host.geometryTranslation?.(roomId,delta):undefined;
        if(delta&&AXES.some(axis=>delta[axis]!==0)&&!translation)throw new Error("Trusted native collision translation is unavailable.");
        const g=graphicsLocation(this.reader,roomId);if(!g)throw new Error("Donor room has no native collision record.");
        const file=this.files.get(this.reader.u32(g.record+8)&65535);if(!file)throw new Error("Native collision resource is unavailable.");
        const planePointer=this.reader.u32(geometryAuxiliaryRecord(this.reader,0x5c5834,g.group,g.index,4)),treePointer=this.reader.u32(geometryAuxiliaryRecord(this.reader,0x5c584c,g.group,g.index,4)),collision=extractCollision(this.reader,file,planePointer,treePointer);
        if(!collision.planeCount&&!collision.cellCount)return {planes:new Uint8Array(),tree:new Uint8Array(),resourceFileIds:[file.id],planeCount:0,cellCount:0};
        const planeStart=file.start+(planePointer&0xffffff),treeStart=file.start+(treePointer&0xffffff);
        const planeEnd=Math.max(...collision.sources.filter(source=>source.kind==="planeDistance").map(source=>source.romOffset+8));
        const treeEnd=Math.max(...collision.guards.filter(guard=>guard.kind==="treeBranch"||guard.kind==="cellTopology").map(guard=>guard.romOffset+(guard.kind==="cellTopology"?18:6)));
        this.reader.check(planeStart,planeEnd-planeStart,file.end);this.reader.check(treeStart,treeEnd-treeStart,file.end);
        const planes=this.reader.bytes.slice(planeStart,planeEnd),tree=this.reader.bytes.slice(treeStart,treeEnd);
        if(translation){
          for(const span of translation.spans){if(span.kind!=="planeDistance"&&span.kind!=="cellBounds")continue;
            const bytes=span.kind==="planeDistance"?planes:tree,start=span.kind==="planeDistance"?planeStart:treeStart,offset=span.romOffset-start;
            if(span.fileId!==file.id||offset<0||offset+span.originalHex.length/2>bytes.length||Buffer.from(bytes.subarray(offset,offset+span.originalHex.length/2)).toString("hex")!==span.originalHex)throw new Error("Native collision translation span does not match the preserved donor BSP.");
            bytes.set(Buffer.from(span.replacementHex,"hex"),offset);
          }
        }
        return {planes,tree,resourceFileIds:[file.id],planeCount:(planeEnd-planeStart)/20,cellCount:collision.cellCount};
      },
      donor:roomId=>{
        const room=this.host.loadBaseRoom(roomId),g=graphicsLocation(this.reader,roomId);let skyboxId:string|undefined;
        if(g){const index=this.reader.u16(geometryAuxiliaryRecord(this.reader,0x5c587c,g.group,g.index,2)),file=this.reader.i16(geometryAuxiliaryRecord(this.reader,0x5c581c,g.group,g.index,8)+6);if(index&&file)skyboxId=`skybox:${index}:${file}`;}
        return {roomId,actorFileId:room.source.expectedHex.length===56?this.reader.u16(room.source.romOffset+20):0,resourceFileIds:this.donorResources(roomId),metadataOffset:room.source.romOffset,graphicsOffset:g?.record,skyboxId,
          environmentDefinitions:room.actors.filter(actor=>actor.actorId===0x8e).map(actor=>({actorId:actor.actorId,parameters:actor.parameters as NativeActorParameters,unknownHalfword:actor.definitionSource?this.reader.u16(actor.definitionSource.romOffset+2):0,position:{...actor.position},rotation:{...actor.rotation},placementWord:this.reader.u32(actor.source.romOffset+16)}))};
      }};
  }
}
