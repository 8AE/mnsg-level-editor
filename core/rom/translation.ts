import type { RoomData, Vec3 } from "../../shared/types";
import { RomReader } from "./binary";
import type { RomFile } from "./decompress";
import { decodeRoomGeometry, geometryAuxiliaryRecord, graphicsLocation } from "./geometry";

export type GeometryWriteKind = "vertexXYZ" | "planeDistance" | "cellBounds";
export interface GeometryWriteSpan {
  kind: GeometryWriteKind;
  fileId: number;
  segmentedAddress: number;
  romOffset: number;
  originalHex: string;
  replacementHex: string;
}
export interface GeometryGuard {
  kind:"planeNormal"|"treeBranch"|"cellTopology"|"displayCommand";
  fileId:number;segmentedAddress:number;romOffset:number;expectedHex:string;
}
export interface GeometryTranslation { roomId: number; spans: GeometryWriteSpan[]; guards:GeometryGuard[]; affectedRoomIds: number[] }
interface GeometrySource extends Omit<GeometryWriteSpan,"replacementHex"> { normal?: Vec3 }
interface GeometryPlan {
  roomId: number; sources: GeometrySource[]; guards:GeometryGuard[]; vertexCount: number; planeCount: number; cellCount: number;
  supported: boolean; reason?: string; affectedRoomIds: number[]; bounds?: {min:Vec3;max:Vec3};
}
const AXES = ["x","y","z"] as const;

export function translatePlaneDistance(distance: number, normal: Vec3, translation: Vec3): number {
  // Precompute one mathematical translation and round once to the stored f32.
  const result=Math.fround(distance-(normal.x*translation.x+normal.y*translation.y+normal.z*translation.z));
  if (!Number.isFinite(result)) throw new Error("Translated collision plane distance is not finite.");
  return result;
}

/** Bounded static collision traversal from cell slot 0; terminals are child index 0. */
export function extractCollision(r:RomReader,file:RomFile,planePointer:number,treePointer:number): {sources:GeometrySource[];guards:GeometryGuard[];planeCount:number;cellCount:number} {
  const absent=(pointer:number)=>pointer===0||pointer===0xffffffff;
  if (absent(planePointer)&&absent(treePointer)) return {sources:[],guards:[],planeCount:0,cellCount:0};
  if (absent(planePointer)||absent(treePointer)||file.compressed) throw new Error("Incomplete or compressed static collision resource.");
  const resolve=(pointer:number,size:number)=>{
    if ((pointer>>>24)!==8) throw new Error("Static collision pointer does not use native segment 8.");
    return r.check(file.start+(pointer&0xffffff),size,file.end);
  };
  const planeBase=resolve(planePointer,20),treeBase=resolve(treePointer,18);
  const headers:number[]=[],headerSlots=new Set<number>(),sources:GeometrySource[]=[],guards:GeometryGuard[]=[];
  let cell=0;
  while (true) {
    if (!Number.isInteger(cell)||cell<0||cell>0xfffc||headers.length>21845||headerSlots.has(cell)) throw new Error("Collision cell chain cycles or exceeds its bounded index range.");
    const at=r.check(treeBase+cell*6,18,file.end);
    for (let slot=cell;slot<cell+3;slot++) {
      if (headerSlots.has(slot)) throw new Error("Collision cell headers overlap.");
      headerSlots.add(slot);
    }
    for(let axis=0;axis<3;axis++) if(r.i16(at+12+axis*2)>r.i16(at+6+axis*2)) throw new Error("Collision cell bounds are inverted.");
    headers.push(cell);
    guards.push({kind:"cellTopology",fileId:file.id,segmentedAddress:treePointer+cell*6,romOffset:at,expectedHex:r.hex(at,6)});
    sources.push({kind:"cellBounds",fileId:file.id,segmentedAddress:treePointer+cell*6+6,romOffset:at+6,originalHex:r.hex(at+6,12)});
    cell=r.u16(at);
    if(cell===0xffff) break;
  }
  const states=new Uint8Array(65536),planes=new Set<number>();
  for(const header of headers) {
    const stack:[number,boolean][]=[[header+3,false]];
    while(stack.length) {
      const [index,leaving]=stack.pop()!;
      if(index===0) continue;
      if(index>0xffff||headerSlots.has(index)) throw new Error("Collision branch overlaps a header or exceeds its index range.");
      if(leaving){states[index]=2;continue;}
      if(states[index]===1) throw new Error("Collision decision tree contains a cycle.");
      if(states[index]===2) continue;
      states[index]=1;
      const at=r.check(treeBase+index*6,6,file.end),planeIndex=r.u16(at);
      guards.push({kind:"treeBranch",fileId:file.id,segmentedAddress:treePointer+index*6,romOffset:at,expectedHex:r.hex(at,6)});
      const plane=r.check(planeBase+planeIndex*20,20,file.end);
      const normal={x:r.view.getFloat32(plane),y:r.view.getFloat32(plane+4),z:r.view.getFloat32(plane+8)};
      if (![normal.x,normal.y,normal.z,r.view.getFloat32(plane+12)].every(Number.isFinite)) throw new Error("Static collision plane contains nonfinite values.");
      if(!planes.has(planeIndex)) {
        planes.add(planeIndex);
        guards.push({kind:"planeNormal",fileId:file.id,segmentedAddress:planePointer+planeIndex*20,romOffset:plane,expectedHex:r.hex(plane,12)});
        sources.push({kind:"planeDistance",fileId:file.id,segmentedAddress:planePointer+planeIndex*20+12,romOffset:plane+12,originalHex:r.hex(plane+12,4),normal});
      }
      stack.push([index,true],[r.u16(at+4),false],[r.u16(at+2),false]);
    }
  }
  return {sources,guards,planeCount:planes.size,cellCount:headers.length};
}

function deduplicate(sources:GeometrySource[]):GeometrySource[] {
  const unique=new Map<number,GeometrySource>(),occupied=new Map<number,number>();
  for(const source of sources) {
    const existing=unique.get(source.romOffset);
    if(existing) {
      if(existing.kind!==source.kind||existing.fileId!==source.fileId||existing.originalHex!==source.originalHex) throw new Error("Geometry sources overlap with incompatible interpretations.");
      continue;
    }
    for(let i=0;i<source.originalHex.length/2;i++) {
      if(occupied.has(source.romOffset+i)) throw new Error("Geometry source records partially overlap.");
      occupied.set(source.romOffset+i,source.romOffset);
    }
    unique.set(source.romOffset,source);
  }
  return [...unique.values()].sort((a,b)=>a.romOffset-b.romOffset);
}

function deduplicateGuards(guards:GeometryGuard[],sources:GeometrySource[]):GeometryGuard[] {
  const unique=new Map<number,GeometryGuard>();
  for(const guard of guards) {
    const previous=unique.get(guard.romOffset);
    if(previous&&(previous.kind!==guard.kind||previous.fileId!==guard.fileId||previous.expectedHex!==guard.expectedHex))throw new Error("Geometry guards have incompatible overlapping interpretations.");
    unique.set(guard.romOffset,guard);
  }
  const ranges=[...sources.map(source=>({start:source.romOffset,end:source.romOffset+source.originalHex.length/2})),
    ...[...unique.values()].map(guard=>({start:guard.romOffset,end:guard.romOffset+guard.expectedHex.length/2}))].sort((a,b)=>a.start-b.start);
  for(let i=1;i<ranges.length;i++)if(ranges[i-1].end>ranges[i].start)throw new Error("Geometry guards and editable spans overlap.");
  return [...unique.values()].sort((a,b)=>a.romOffset-b.romOffset);
}

function translationBounds(sources:GeometrySource[]):{min:Vec3;max:Vec3} {
  const min={x:-65535,y:-65535,z:-65535},max={x:65535,y:65535,z:65535};
  for(const source of sources) if(source.kind!=="planeDistance") {
    const data=Buffer.from(source.originalHex,"hex");
    const count=source.kind==="cellBounds"?6:3;
    for(let i=0;i<count;i++) {
      const axis=AXES[i%3],value=data.readInt16BE(i*2);
      min[axis]=Math.max(min[axis],-32768-value);max[axis]=Math.min(max[axis],32767-value);
    }
  }
  return {min,max};
}

export class GeometryTranslations {
  private readonly plans=new Map<number,GeometryPlan>();
  private indexed=false;
  constructor(private readonly reader:RomReader,private readonly files:Map<number,RomFile>,private readonly segment:(fileId:number)=>number) {}
  private extract(roomId:number):GeometryPlan {
    const cached=this.plans.get(roomId);if(cached)return cached;
    const plan:GeometryPlan={roomId,sources:[],guards:[],vertexCount:0,planeCount:0,cellCount:0,supported:false,affectedRoomIds:[roomId]};
    this.plans.set(roomId,plan);
    try {
      const location=graphicsLocation(this.reader,roomId);
      if(!location) throw new Error("Room has no verified ordinary static geometry record.");
      const {record,group,index}=location;
      const secondary=geometryAuxiliaryRecord(this.reader,0x5c5804,group,index,8);
      for(const [label,model] of [["Primary",this.reader.u32(record)],["Secondary",this.reader.u32(secondary)]] as const) {
        const visual=decodeRoomGeometry(this.reader,record,this.files,this.segment,{model,strict:true});
        plan.sources.push(...visual.vertices.map(vertex=>({...vertex,kind:"vertexXYZ" as const})));
        plan.guards.push(...visual.commands.map(command=>({...command,kind:"displayCommand" as const})));
        if(!visual.complete) throw new Error(`${label} visual traversal is incomplete: ${visual.warnings[0]??"unsupported commands"}`);
      }
      const planeAddress=geometryAuxiliaryRecord(this.reader,0x5c5834,group,index,4);
      const treeAddress=geometryAuxiliaryRecord(this.reader,0x5c584c,group,index,4);
      const file=this.files.get(this.reader.u32(record+8)&0xffff);
      if(!file) throw new Error("Primary static geometry resource is unavailable.");
      const collision=extractCollision(this.reader,file,this.reader.u32(planeAddress),this.reader.u32(treeAddress));
      plan.sources.push(...collision.sources);
      plan.guards.push(...collision.guards);
      plan.sources=deduplicate(plan.sources);
      plan.guards=deduplicateGuards(plan.guards,plan.sources);
      plan.vertexCount=plan.sources.filter(source=>source.kind==="vertexXYZ").length;
      plan.planeCount=collision.planeCount;plan.cellCount=collision.cellCount;
      if(!plan.vertexCount) throw new Error("Room has no editable static visual vertices.");
      plan.bounds=translationBounds(plan.sources);plan.supported=true;
      if(!collision.cellCount) plan.reason="No static collision is assigned to this room; translation changes visual geometry only.";
    } catch(error) {plan.supported=false;plan.reason=error instanceof Error?error.message:String(error);}
    return plan;
  }
  private indexAliases():void {
    if(this.indexed)return;
    for(let id=0;id<800;id++) if(graphicsLocation(this.reader,id))this.extract(id);
    const owners=new Map<number,{end:number;rooms:Set<number>}>();
    // Include sources found before unsupported commands, conservatively recording all known overlaps.
    for(const plan of this.plans.values())for(const source of plan.sources) {
      const entry=owners.get(source.romOffset)??{end:source.romOffset+source.originalHex.length/2,rooms:new Set<number>()};
      entry.end=Math.max(entry.end,source.romOffset+source.originalHex.length/2);entry.rooms.add(plan.roomId);owners.set(source.romOffset,entry);
    }
    const affected=new Map([...this.plans.keys()].map(id=>[id,new Set([id])]));
    const intervals=[...owners.entries()].sort((a,b)=>a[0]-b[0]);
    for(let i=0;i<intervals.length;i++) {
      const [start,entry]=intervals[i];
      for(const left of entry.rooms)for(const right of entry.rooms)affected.get(left)!.add(right);
      for(let j=i+1;j<intervals.length&&intervals[j][0]<entry.end;j++)for(const left of entry.rooms)for(const right of intervals[j][1].rooms){affected.get(left)!.add(right);affected.get(right)!.add(left);}
      void start;
    }
    for(const plan of this.plans.values()) {
      plan.affectedRoomIds=[...affected.get(plan.roomId)!].sort((a,b)=>a-b);
    }
    const signature=(plan:GeometryPlan)=>[...plan.sources.map(source=>`${source.romOffset}:${source.originalHex.length}:${source.kind}:${source.fileId}`),
      ...plan.guards.map(guard=>`${guard.romOffset}:${guard.expectedHex.length}:${guard.kind}:${guard.fileId}`)].sort().join("|");
    const signatures=new Map([...this.plans.values()].map(plan=>[plan.roomId,signature(plan)]));
    for(const plan of this.plans.values())for(const otherId of plan.affectedRoomIds) {
      const other=this.plans.get(otherId)!;
      if(signatures.get(plan.roomId)!==signatures.get(otherId)) {
        plan.supported=false;plan.reason="Room shares only part of its visual or collision sources with another room; translation requires verified resource cloning.";
      } else if(!other.supported&&other.reason?.includes("incomplete")) {
        plan.supported=false;plan.reason="Shared room geometry has an incomplete native traversal.";
      }
    }
    this.indexed=true;
  }
  summary(roomId:number):NonNullable<RoomData["geometryEdit"]> {
    this.indexAliases();const plan=this.extract(roomId);
    return {supported:plan.supported,reason:plan.reason,vertexCount:plan.vertexCount,planeCount:plan.planeCount,cellCount:plan.cellCount,
      affectedRoomIds:[...plan.affectedRoomIds],translationBounds:plan.bounds?structuredClone(plan.bounds):undefined};
  }
  translation(roomId:number,t:Vec3):GeometryTranslation {
    if(!t||AXES.some(axis=>!Number.isSafeInteger(t[axis])||t[axis]<-65535||t[axis]>65535))throw new Error("Geometry translation must contain integer coordinates in -65535..65535.");
    this.indexAliases();const plan=this.extract(roomId);
    if(!plan.supported)throw new Error(plan.reason??"Geometry translation is unsupported.");
    if(AXES.every(axis=>t[axis]===0))return {roomId,spans:[],guards:[],affectedRoomIds:[...plan.affectedRoomIds]};
    if(AXES.some(axis=>t[axis]<plan.bounds!.min[axis]||t[axis]>plan.bounds!.max[axis]))throw new Error("Geometry translation exceeds signed 16-bit vertex or collision bounds.");
    for(const guard of plan.guards)if(this.reader.hex(guard.romOffset,guard.expectedHex.length/2)!==guard.expectedHex)throw new Error("Geometry guard preimage differs from the imported ROM.");
    const spans=plan.sources.map(source=>{
      if(this.reader.hex(source.romOffset,source.originalHex.length/2)!==source.originalHex)throw new Error("Geometry preimage differs from the imported ROM.");
      const bytes=Buffer.from(source.originalHex,"hex");
      if(source.kind==="planeDistance")bytes.writeFloatBE(translatePlaneDistance(bytes.readFloatBE(),source.normal!,t));
      else for(let i=0;i<bytes.length/2;i++)bytes.writeInt16BE(bytes.readInt16BE(i*2)+t[AXES[i%3]],i*2);
      const {normal:_normal,...span}=source;
      return {...span,replacementHex:bytes.toString("hex")};
    });
    return {roomId,spans,guards:structuredClone(plan.guards),affectedRoomIds:[...plan.affectedRoomIds]};
  }
}
