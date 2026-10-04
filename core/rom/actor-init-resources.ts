/** Standalone native loading primitives. No constructor or engine integration. */
export const NATIVE_REGISTRY_SLOTS=48;
export const NATIVE_REGISTRY_BYTES=(NATIVE_REGISTRY_SLOTS+1)*8;
const FILE_LIMIT=0x520,FILE_BYTES=16*1024*1024,REGISTRY_BYTES=32*1024*1024,ARENA_BYTES=2*1024*1024;

export interface NativeResourceImage {
  fileId:number;
  /** CPU overlays have a loading interval distinct from their local 08 addresses. */
  namespace:"rsp"|"cpu-code";
  /** Unmodified allocation-table words, including the native bit-30 code flag. */
  nativeStart:number;
  nativeEnd:number;
  /** codeTag is 01DF4's u32 result (0 or 0x40000000), never interval byte +2. */
  interval:{lowerInclusive:number;upperExclusive:number;segment:number;codeTag:number};
  /** Canonical whole-ROM-decoded input only. Native compressed offsets differ. */
  compressed:boolean;
  rawLength:number;
  /** Exact even-aligned native copy, including the padding byte for odd length. */
  rawCopy:Uint8Array;
  /** Already decoded, ordered PIC/raw parts, with native segmented destinations. */
  parts:readonly {destination:number;bytes:Uint8Array}[];
}
export interface NativeRegistryAllocation {fileId:number;address:number;codeTag:number;bytes:Uint8Array}
export interface NativeResourceContext {
  bankStart:number;
  bankEnd:number;
  /** Explicit caller-supplied occupancy, including the following sentinel. */
  records:Uint8Array;
  allocations:readonly NativeRegistryAllocation[];
}
export interface NativeArenaContext {descriptorAddress:number;descriptor:Uint8Array;bytes:Uint8Array}

function integer(value:number,min:number,max:number,label:string):number {
  if(!Number.isSafeInteger(value)||value<min||value>max)throw new Error(`Invalid ${label}.`);return value;
}
const word=(value:number,label:string)=>integer(value,0,0xffffffff,label);
const fileId=(value:number)=>integer(value,1,FILE_LIMIT-1,"native file ID");
const align=(value:number,boundary:number)=>Math.ceil(value/boundary)*boundary;
function view(bytes:Uint8Array):DataView {return new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);}
function byteArray(bytes:Uint8Array,max:number,label:string):void {
  if(!(bytes instanceof Uint8Array)||bytes.length>max)throw new Error(`Invalid ${label} byte budget.`);
}
function span(address:number,length:number,start:number,end:number,label:string):void {
  word(address,label);integer(length,0,REGISTRY_BYTES,`${label} length`);
  if(address<start||address+length>end||address+length>0x100000000)throw new Error(`${label} exceeds its owned span.`);
}
function registryState(context:NativeResourceContext):{count:number;cursor:number} {
  word(context.bankStart,"resource bank start");word(context.bankEnd,"resource bank end");
  if(context.bankStart<0x80000000||context.bankEnd>0xc0000000||context.bankStart%64||context.bankEnd<=context.bankStart||context.bankEnd-context.bankStart>REGISTRY_BYTES)throw new Error("Invalid owned resource bank.");
  byteArray(context.records,NATIVE_REGISTRY_BYTES,"resource registry");if(context.records.length!==NATIVE_REGISTRY_BYTES)throw new Error("Registry must include 48 slots and its sentinel.");
  if(!Array.isArray(context.allocations)||context.allocations.length>NATIVE_REGISTRY_SLOTS)throw new Error("Invalid resource allocation count.");
  const data=view(context.records),ids=new Set<number>();let count=0,total=0,previousEnd=context.bankStart;
  while(count<NATIVE_REGISTRY_SLOTS&&data.getUint16(count*8))count++;
  if(data.getUint16(count*8)!==0)throw new Error("Resource registry has no sentinel.");
  if(context.allocations.length!==count)throw new Error("Registry allocation descriptions do not match occupancy.");
  const allocations=new Map<number,NativeRegistryAllocation>();
  for(const allocation of context.allocations){fileId(allocation.fileId);if(allocations.has(allocation.fileId))throw new Error("Duplicate resource allocation ID.");allocations.set(allocation.fileId,allocation);}
  for(let index=0;index<count;index++){
    const id=fileId(data.getUint16(index*8)),allocation=allocations.get(id);if(ids.has(id)||!allocation)throw new Error("Registry ID/allocation identity is inconsistent.");ids.add(id);
    if(allocation.codeTag!==0&&allocation.codeTag!==0x40000000)throw new Error("Invalid native resource code tag.");byteArray(allocation.bytes,FILE_BYTES,"resource allocation");
    span(allocation.address,allocation.bytes.length,context.bankStart,context.bankEnd,"resource allocation");
    if(allocation.address%64||(allocation.codeTag&&allocation.address%4096)||allocation.address<previousEnd)throw new Error("Resource allocations are misaligned, unordered or overlapping.");
    if(data.getUint32(index*8+4)!==((allocation.address|(allocation.codeTag?0x40000000:0))>>>0))throw new Error("Registry tagged base differs from its allocation.");
    previousEnd=allocation.address+allocation.bytes.length;total+=allocation.bytes.length;
  }
  const cursor=data.getUint32(count*8+4);
  if(cursor%64||cursor<previousEnd||cursor>context.bankEnd||total>REGISTRY_BYTES)throw new Error("Registry next cursor or aggregate byte budget is invalid.");
  for(let index=count+1;index<=NATIVE_REGISTRY_SLOTS;index++)if(data.getUint16(index*8))throw new Error("Resource IDs appear beyond the sentinel.");
  return {count,cursor};
}

function reconstruct(id:number,image:NativeResourceImage):{bytes:Uint8Array;codeTag:number} {
  if(!image||image.fileId!==id)throw new Error("Decoded resource file identity changed.");
  word(image.nativeStart,"native allocation start");word(image.nativeEnd,"native allocation end");
  // Native 01C00 subtracts the original table words before clearing address tags.
  // Clearing each independently would conceal asymmetric flags and huge extents.
  const size=image.nativeEnd-image.nativeStart;integer(size,0,FILE_BYTES,"native raw allocation extent");
  if((image.nativeStart&0x40000000)!==(image.nativeEnd&0x40000000))throw new Error("Native allocation start/end flags differ.");
  const interval=image.interval;if(!interval)throw new Error("Missing native resource interval.");
  integer(interval.lowerInclusive,0,0xffff,"resource interval lower");integer(interval.upperExclusive,1,0xffff,"resource interval upper");
  integer(interval.segment,0,255,"resource segment");
  const expectedTag=interval.segment===0x11?0x40000000:image.nativeStart&0x40000000;
  if(interval.codeTag!==expectedTag)throw new Error("Native 01DF4 resource code tag differs from its source words.");
  if(interval.lowerInclusive>=interval.upperExclusive||id<interval.lowerInclusive||id>=interval.upperExclusive)throw new Error("Native resource interval identity is invalid.");
  const start=(image.nativeStart&0xbfffffff)>>>0,end=(image.nativeEnd&0xbfffffff)>>>0;
  const sameSegment=(start>>>24)===interval.segment&&(end>>>24)===interval.segment;
  const plainCode=image.namespace==="cpu-code"&&interval.segment===0x11&&interval.codeTag===0x40000000&&start===0x08000000&&(end>>>24)===8&&Array.isArray(image.parts)&&image.parts.length===0;
  if((image.namespace==="rsp"&&!sameSegment)||(image.namespace==="cpu-code"&&!plainCode)||(image.namespace!=="rsp"&&image.namespace!=="cpu-code"))throw new Error("Native resource allocation namespace is invalid.");
  if(image.compressed!==false)throw new Error("Resource primitive requires canonical decompressed ROM input.");
  integer(image.rawLength,0,FILE_BYTES,"raw resource length");
  byteArray(image.rawCopy,FILE_BYTES,"raw resource copy");const copyLength=align(image.rawLength,2);
  if(image.rawCopy.length!==copyLength||copyLength>size)throw new Error("Native even-copy span exceeds or differs from its allocation.");
  if(!Array.isArray(image.parts)||image.parts.length>4096)throw new Error("Resource part count exceeds its bounded domain.");
  let decodedBytes=0;
  for(const part of image.parts){
    byteArray(part.bytes,FILE_BYTES,"decoded resource part");span(part.destination,part.bytes.length,start,end,"decoded resource part");
    decodedBytes+=part.bytes.length;if(decodedBytes>REGISTRY_BYTES)throw new Error("Decoded resource parts exceed their aggregate byte budget.");
  }
  const bytes=new Uint8Array(size);bytes.set(image.rawCopy);
  for(const part of image.parts)bytes.set(part.bytes,part.destination-start);
  return {bytes,codeTag:interval.codeTag};
}

/** Observable 13B14/141C4 semantics; PIC scratch pressure is NOT simulated. */
export class NativeResourceRegistry {
  /** Owned native bytes: a future CPU adapter may mutate them; each operation revalidates. */
  readonly records:Uint8Array;
  readonly bankStart:number;
  readonly bankEnd:number;
  private allocations:NativeRegistryAllocation[];
  constructor(context:NativeResourceContext){
    registryState(context);this.bankStart=context.bankStart;this.bankEnd=context.bankEnd;this.records=context.records.slice();
    this.allocations=context.allocations.map(allocation=>({...allocation,bytes:allocation.bytes.slice()}));
  }
  private context():NativeResourceContext {return {bankStart:this.bankStart,bankEnd:this.bankEnd,records:this.records,allocations:this.allocations};}
  snapshot():NativeResourceContext {registryState(this.context());return {...this.context(),records:this.records.slice(),allocations:this.allocations.map(allocation=>({...allocation,bytes:allocation.bytes.slice()}))};}
  lookup(id:number):number {
    integer(id,0,FILE_LIMIT-1,"native file ID");const {count}=registryState(this.context());if(!id)return 0;
    const data=view(this.records);for(let index=0;index<count;index++)if(data.getUint16(index*8)===id)return data.getUint32(index*8+4);return -1;
  }
  /** Decoder is never called for an existing ID or a full registry. */
  load(id:number,decode:(id:number)=>NativeResourceImage):number {
    fileId(id);const {count,cursor}=registryState(this.context()),data=view(this.records);
    for(let index=0;index<count;index++)if(data.getUint16(index*8)===id)return data.getUint32((index+1)*8+4);
    if(count===NATIVE_REGISTRY_SLOTS)return 0;
    const image=reconstruct(id,decode(id)),address=image.codeTag?align(cursor,4096):cursor,next=align(address+image.bytes.length,64);
    if(next>this.bankEnd||address>0xffffffff)throw new Error("Resource append exceeds its owned bank.");
    const records=this.records.slice(),staged=view(records);
    staged.setUint16(count*8,id);staged.setUint32(count*8+4,(address|(image.codeTag?0x40000000:0))>>>0);
    staged.setUint16((count+1)*8,0);staged.setUint32((count+1)*8+4,next);
    const allocations=[...this.allocations,{fileId:id,address,codeTag:image.codeTag,bytes:image.bytes}];
    registryState({bankStart:this.bankStart,bankEnd:this.bankEnd,records,allocations});
    this.records.set(records);this.allocations=allocations;return next;
  }
  /** Native sequential semantics: prior successful requests survive a later rejection. */
  loadList(ids:readonly number[],decode:(id:number)=>NativeResourceImage,options?:{emptyReturn:number}):number {
    registryState(this.context());if(!Array.isArray(ids)||ids.length>4096)throw new Error("Invalid native resource list budget.");
    if(!ids.length){if(options===undefined)throw new Error("Native empty resource-list return is unproven.");return word(options.emptyReturn,"explicit empty-list return");}
    let result=0;for(const id of ids)result=this.load(id,decode);return result;
  }
  read(address:number,length:number):Uint8Array {
    registryState(this.context());word(address,"resource read");integer(length,0,FILE_BYTES,"resource read length");
    const allocation=this.allocations.find(a=>address>=a.address&&address+length<=a.address+a.bytes.length);
    if(!allocation)throw new Error("Resource read exceeds its declared full span.");return allocation.bytes.slice(address-allocation.address,address-allocation.address+length);
  }
}

interface ArenaHeader {address:number;payload:number;total:number;next:number;previous:number}
function arenaState(context:NativeArenaContext):{base:number;size:number;headers:ArenaHeader[]} {
  word(context.descriptorAddress,"arena descriptor address");byteArray(context.descriptor,12,"arena descriptor");
  if(context.descriptor.length!==12||context.descriptorAddress+12>0x100000000)throw new Error("Invalid arena descriptor span.");
  byteArray(context.bytes,ARENA_BYTES,"arena");const data=view(context.descriptor),base=data.getUint32(0),size=data.getUint32(4),head=data.getUint32(8);
  if(!context.descriptorAddress||context.descriptorAddress%4||!base||size!==context.bytes.length||base%64||base+size>0x100000000||(context.descriptorAddress<base+size&&context.descriptorAddress+12>base))throw new Error("Invalid owned arena extent or descriptor overlap.");
  const bytes=view(context.bytes),headers:ArenaHeader[]=[],visited=new Set<number>();let address=head,previous=0,previousEnd=base;
  while(address){
    if(visited.has(address)||headers.length>=ARENA_BYTES/64)throw new Error("Native arena header cycle or count budget exceeded.");visited.add(address);
    span(address,16,base,base+size,"arena header");const offset=address-base,header={address,payload:bytes.getUint32(offset),total:bytes.getUint32(offset+4),next:bytes.getUint32(offset+8),previous:bytes.getUint32(offset+12)};
    if(!header.total||header.total%64||header.payload%64||header.payload<previousEnd||header.payload+header.total>base+size||header.address!==header.payload+header.total-16||header.previous!==previous)throw new Error("Native arena header bounds, ordering or reciprocal links are corrupt.");
    if(header.next&&header.next<=address)throw new Error("Native arena next link is unordered or cyclic.");
    headers.push(header);previous=address;previousEnd=header.payload+header.total;address=header.next;
  }
  return {base,size,headers};
}

/** Native 148C0/148F0/14B74 behavior on owned bytes, with no hidden allocation list. */
export class NativeLinkedArena {
  readonly descriptorAddress:number;
  /** These owned bytes are the authoritative CPU-visible state. */
  readonly descriptor:Uint8Array;
  readonly bytes:Uint8Array;
  constructor(context:NativeArenaContext){arenaState(context);this.descriptorAddress=context.descriptorAddress;this.descriptor=context.descriptor.slice();this.bytes=context.bytes.slice();}
  static initialize(descriptorAddress:number,base:number,initialBytes:Uint8Array):NativeLinkedArena {
    byteArray(initialBytes,ARENA_BYTES,"arena initialization");word(base,"arena base");
    const descriptor=new Uint8Array(12),data=view(descriptor);data.setUint32(0,base);data.setUint32(4,initialBytes.length);
    return new NativeLinkedArena({descriptorAddress,descriptor,bytes:new Uint8Array(initialBytes.length)});
  }
  private context():NativeArenaContext {return {descriptorAddress:this.descriptorAddress,descriptor:this.descriptor,bytes:this.bytes};}
  snapshot():NativeArenaContext {arenaState(this.context());return {...this.context(),descriptor:this.descriptor.slice(),bytes:this.bytes.slice()};}
  allocate(payloadBytes:number):number {
    integer(payloadBytes,0,0xffffffff,"arena payload size");const {base,size,headers}=arenaState(this.context()),total=Math.floor((payloadBytes+0x4f)/64)*64;
    if(total>0xffffffff)throw new Error("Native arena allocation size overflows.");
    let payload=base,previous:ArenaHeader|undefined,next:ArenaHeader|undefined;
    for(const header of headers){if(header.payload-payload>=total){next=header;break;}payload=header.payload+header.total;previous=header;}
    if(payload+total>base+size)return 0;
    const bytes=this.bytes.slice(),descriptor=this.descriptor.slice(),data=view(bytes),address=payload+total-16,offset=address-base;
    bytes.fill(0,payload-base,offset);data.setUint32(offset,payload);data.setUint32(offset+4,total);data.setUint32(offset+8,next?.address??0);data.setUint32(offset+12,previous?.address??0);
    if(previous)data.setUint32(previous.address-base+8,address);else view(descriptor).setUint32(8,address);
    if(next)data.setUint32(next.address-base+12,address);
    arenaState({descriptorAddress:this.descriptorAddress,descriptor,bytes});this.bytes.set(bytes);this.descriptor.set(descriptor);return payload;
  }
  free(payload:number):number {
    word(payload,"arena free pointer");const {base,headers}=arenaState(this.context()),header=headers.find(header=>header.payload===payload);if(!header)return 0;
    const bytes=this.bytes.slice(),descriptor=this.descriptor.slice(),data=view(bytes);
    if(header.previous)data.setUint32(header.previous-base+8,header.next);else view(descriptor).setUint32(8,header.next);
    if(header.next)data.setUint32(header.next-base+12,header.previous);bytes.fill(0,header.payload-base,header.payload-base+header.total);
    arenaState({descriptorAddress:this.descriptorAddress,descriptor,bytes});this.bytes.set(bytes);this.descriptor.set(descriptor);return payload;
  }
  read(address:number,length:number):Uint8Array {
    const {base,size}=arenaState(this.context());span(address,length,base,base+size,"arena read");return this.bytes.slice(address-base,address-base+length);
  }
  /** CPU writes through this method reject invalid partial state atomically. */
  write(address:number,source:Uint8Array):void {
    word(address,"arena write address");const {base,size}=arenaState(this.context());byteArray(source,ARENA_BYTES,"arena write");const bytes=this.bytes.slice(),descriptor=this.descriptor.slice();
    if(address>=this.descriptorAddress&&address+source.length<=this.descriptorAddress+12)descriptor.set(source,address-this.descriptorAddress);
    else {span(address,source.length,base,base+size,"arena write");bytes.set(source,address-base);}
    arenaState({descriptorAddress:this.descriptorAddress,descriptor,bytes});this.bytes.set(bytes);this.descriptor.set(descriptor);
  }
}
