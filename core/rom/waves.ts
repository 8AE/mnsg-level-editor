import {RomReader} from "./binary";
import type {RomFile} from "./decompress";
import {decodePic} from "./pic";
import type {NativeResourceImage} from "./actor-init-resources";

/** Reconstruct only requested native waves; base LZKN64 and PIC parts are distinct. */
export class RenderWaves {
  private readonly cache=new Map<number,Uint8Array>();
  private cachedBytes=0;
  constructor(private readonly reader:RomReader,private readonly files:Map<number,RomFile>,private readonly segment:(id:number)=>number){}
  private resource(id:number):Uint8Array {
    if(id<0x8000){const file=this.files.get(id);if(!file||file.compressed)throw new Error("Render part resource is unavailable.");return this.reader.bytes.subarray(file.start,file.end);}
    for(let at=0x64540;at<0x65540;at+=4){const lower=this.reader.u16(at),upper=this.reader.u16(at+4);if(id<lower)break;if(upper&&id>=upper)continue;const parent=this.files.get(this.reader.u16(at+2));if(!parent)throw new Error("Texture part parent file is unavailable.");
      const first=this.reader.u32(0x445d4+id*4),next=this.reader.u32(0x445d4+(id+1)*4);
      const start=parent.start+(first&0xffffff),end=!next||(upper&&id+1>=upper)?parent.end:parent.start+(next&0xffffff);
      this.reader.check(start,end-start,parent.end);return this.reader.bytes.subarray(start,end);}
    throw new Error("Texture part index has no bounded native parent.");
  }
  /** Canonical native loader input; callers own all returned bytes. No cache mutation. */
  image(id:number):NativeResourceImage {
    const file=this.files.get(id);if(!Number.isInteger(id)||id<1||id>=0x520||!file||file.compressed)throw new Error("Native loader image is unavailable.");
    const nativeStart=this.reader.u32(0x556c4+id*8),nativeEnd=this.reader.u32(0x556c4+id*8+4),size=nativeEnd-nativeStart,start=(nativeStart&0xbfffffff)>>>0;
    if(size<0||size>16*1024*1024||(nativeStart&0x40000000)!==(nativeEnd&0x40000000))throw new Error("Native loader image raw allocation extent is invalid.");
    let lowerInclusive=0,interval:NativeResourceImage["interval"]|undefined;
    for(let at=0x55510;at<0x556c4;at+=4){const upperExclusive=this.reader.u16(at);if(!upperExclusive)break;if(upperExclusive<=lowerInclusive)throw new Error("Native loader interval ordering is invalid.");if(id<upperExclusive){const segment=this.reader.bytes[at+3];interval={lowerInclusive,upperExclusive,segment,codeTag:segment===0x11?0x40000000:nativeStart&0x40000000};break;}lowerInclusive=upperExclusive;}
    if(!interval)throw new Error("Native loader image has no interval.");
    const pointer=this.reader.u32(0x6a51c+id*4);if(pointer<0x80000400||pointer>=0x8007e020)throw new Error("Native loader parts pointer is not resident.");
    const parts:NativeResourceImage["parts"][number][]=[];let at=pointer-0x80000000+0xc00,terminated=false,partBytes=0;
    for(let count=0;count<4096;count++,at+=8){const resource=this.reader.u32(at);if(!resource){terminated=true;break;}const destination=this.reader.u32(at+4),offset=destination-start;if(offset<0||offset>=size)throw new Error("Native loader part destination is invalid.");const bytes=decodePic(this.resource(resource),Math.min(8*1024*1024,size-offset));partBytes+=bytes.length;if(offset+bytes.length>size||partBytes>32*1024*1024)throw new Error("Native loader decoded parts exceed allocation or budget.");parts.push({destination,bytes});}
    if(!terminated)throw new Error("Native loader parts lack a bounded terminator.");
    const rawLength=file.end-file.start,copyLength=Math.ceil(rawLength/2)*2;this.reader.check(file.start,copyLength);
    return {fileId:id,namespace:interval.segment===0x11?"cpu-code":"rsp",nativeStart,nativeEnd,interval,compressed:false,rawLength,rawCopy:this.reader.bytes.slice(file.start,file.start+copyLength),parts};
  }
  wave(id:number):Uint8Array {
    const cached=this.cache.get(id);if(cached){this.cache.delete(id);this.cache.set(id,cached);return cached;}
    const file=this.files.get(id);if(!file||file.compressed)throw new Error("Render wave is unavailable.");
    const start=this.reader.u32(0x556c4+id*8),end=this.reader.u32(0x556c4+id*8+4),size=end-start;
    const copyLength=Math.ceil((file.end-file.start)/2)*2;
    if(size<copyLength||size<0||size>16*1024*1024||(start>>>24)!==this.segment(id)||(end>>>24)!==(start>>>24))throw new Error("Render wave allocation is invalid.");
    const wave=new Uint8Array(size);wave.set(this.reader.bytes.subarray(file.start,file.end));
    const pointer=this.reader.u32(0x6a51c+id*4);if(pointer<0x80000000||pointer>=0x80100000)throw new Error("Render parts list has an unmapped resident pointer.");
    let at=pointer-0x80000000+0xc00,terminated=false;
    for(let part=0;part<4096;part++,at+=8){const resource=this.reader.u32(at),destination=this.reader.u32(at+4);if(!resource){terminated=true;break;}
      const offset=destination-start;if(!Number.isSafeInteger(offset)||offset<0||offset>=size)throw new Error("Texture part destination is outside its wave.");
      const decoded=decodePic(this.resource(resource),Math.min(8*1024*1024,size-offset));if(offset+decoded.length>size)throw new Error("Texture part exceeds its wave allocation.");wave.set(decoded,offset);}
    if(!terminated)throw new Error("Render parts list has no bounded terminator.");
    while(this.cache.size&&this.cachedBytes+wave.length>32*1024*1024){const oldest=this.cache.keys().next().value!;this.cachedBytes-=this.cache.get(oldest)!.length;this.cache.delete(oldest);}
    this.cache.set(id,wave);this.cachedBytes+=wave.length;return wave;
  }
  read(address:number,size:number,segments:Map<number,number>):Uint8Array {
    const id=segments.get(address>>>24);if(id===undefined)throw new Error(`Texture address uses unmapped segment 0x${(address>>>24).toString(16)}.`);
    const wave=this.wave(id),offset=address&0xffffff;if(offset+size>wave.length)throw new Error("Texture pointer exceeds its native wave allocation.");return wave.subarray(offset,offset+size);
  }
}
