export interface NativeActorMemorySpan {address:number;bytes:Uint8Array;codeFile?:number}

/** CPU overlay08 and RSP segment08 are separate native address namespaces. */
export function graphicsActorMemory(spans:NativeActorMemorySpan[],segments:{segment:number;fileId:number;offset:number}[]):NativeActorMemorySpan[] {
  return spans.flatMap(span=>{
    if(span.address<0x08000000||span.address>=0x09000000)return [span];
    if(span.codeFile===undefined)return [];
    if(!Number.isInteger(span.codeFile)||span.codeFile<=0)throw new Error("Private actor overlay has no valid source file.");
    return segments.filter(mapping=>mapping.fileId===span.codeFile).flatMap(mapping=>{
      const source=span.address&0xffffff,start=Math.max(source,mapping.offset),end=Math.min(source+span.bytes.length,mapping.offset+0x1000000);if(start>=end)return [];
      return [{...span,address:mapping.segment*0x1000000+start-mapping.offset,bytes:span.bytes.subarray(start-source,end-source)}];
    });
  });
}

/** Private writes overlay ROM even when only part of a native command changed. */
export function readNativeActorMemory(baseRead:(address:number,size:number)=>Uint8Array,address:number,size:number,spans:NativeActorMemorySpan[],onPrivateRead?:(address:number,bytes:Uint8Array)=>void):Uint8Array {
  if(!Number.isSafeInteger(address)||address<0||!Number.isSafeInteger(size)||size<0||size>8*1024*1024||address+size>0x100000000||spans.length>4096)throw new Error("Actor memory read exceeds its bounded address range.");
  const end=address+size,relevant=spans.filter(span=>{if(!Number.isSafeInteger(span.address)||span.address<0||!(span.bytes instanceof Uint8Array)||span.address+span.bytes.length>0x100000000)throw new Error("Invalid private native actor memory span.");return span.address<end&&span.address+span.bytes.length>address;});
  if(!relevant.length)return baseRead(address,size);
  const boundaries=[address,end];for(const span of relevant){boundaries.push(Math.max(address,span.address),Math.min(end,span.address+span.bytes.length));}
  const sorted=[...new Set(boundaries)].sort((a,b)=>a-b),output=new Uint8Array(size);
  for(let i=0;i<sorted.length-1;i++){
    const start=sorted[i],length=sorted[i+1]-start;
    // Later private snapshots override earlier regions, as ActorMemory writes do.
    let snapshot:NativeActorMemorySpan|undefined;for(let j=relevant.length-1;j>=0;j--)if(start>=relevant[j].address&&start+length<=relevant[j].address+relevant[j].bytes.length){snapshot=relevant[j];break;}
    const bytes=snapshot?snapshot.bytes.subarray(start-snapshot.address,start-snapshot.address+length):baseRead(start,length);
    if(bytes.length!==length)throw new Error("Truncated native actor memory source.");
    output.set(bytes,start-address);if(snapshot)onPrivateRead?.(start,bytes);
  }
  return output;
}
