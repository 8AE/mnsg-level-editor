import {inflateRawSync} from 'node:zlib';

export interface NrmArchiveEntry {name:string;bytes:Buffer}
const MAX_ARCHIVE=64*1024*1024,MAX_ENTRY=64*1024*1024,MAX_TOTAL=128*1024*1024,MAX_ENTRIES=128;
function requireZip(ok:boolean,reason:string):asserts ok {if(!ok)throw Error(`Invalid NRM ZIP: ${reason}`);}
function crc32(bytes:Uint8Array):number {let crc=0xffffffff;for(const byte of bytes){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0;}

/** Test-only, in-memory ZIP32 reader for the stored/deflated archives produced by
 * Info-ZIP and Windows Compress-Archive. Every entry is bounded and CRC-checked;
 * no archive path is written to disk and no external executable is needed. */
export function readNrmArchive(input:Uint8Array):NrmArchiveEntry[] {
 requireZip(input.length>=22&&input.length<=MAX_ARCHIVE,'archive byte budget');
 const zip=Buffer.from(input),span=(offset:number,length:number,limit=zip.length)=>{
  requireZip(Number.isInteger(offset)&&Number.isInteger(length)&&offset>=0&&length>=0&&offset+length<=limit,'truncated span');
 };
 let end=-1;
 for(let at=zip.length-22;at>=Math.max(0,zip.length-22-0xffff);at--){if(zip.readUInt32LE(at)===0x06054b50&&at+22+zip.readUInt16LE(at+20)===zip.length){end=at;break;}}
 requireZip(end>=0,'missing end record');
 const count=zip.readUInt16LE(end+10),centralSize=zip.readUInt32LE(end+12),centralOffset=zip.readUInt32LE(end+16);
 requireZip(zip.readUInt16LE(end+4)===0&&zip.readUInt16LE(end+6)===0&&zip.readUInt16LE(end+8)===count,'multi-disk archive');
 requireZip(count>0&&count<=MAX_ENTRIES&&centralSize!==0xffffffff&&centralOffset!==0xffffffff,'entry/ZIP32 budget');
 requireZip(centralOffset+centralSize===end,'central directory bounds');
 const entries:NrmArchiveEntry[]=[],occupied:{start:number;end:number}[]=[],names=new Set<string>();
 let at=centralOffset,total=0;
 for(let entry=0;entry<count;entry++){
  span(at,46,end);requireZip(zip.readUInt32LE(at)===0x02014b50,'central header');
  const flags=zip.readUInt16LE(at+8),method=zip.readUInt16LE(at+10),crc=zip.readUInt32LE(at+16),compressed=zip.readUInt32LE(at+20),size=zip.readUInt32LE(at+24);
  const nameLength=zip.readUInt16LE(at+28),extraLength=zip.readUInt16LE(at+30),commentLength=zip.readUInt16LE(at+32),localOffset=zip.readUInt32LE(at+42);
  requireZip((flags&~0x080e)===0&&(method===0||method===8),'unsupported compression/flags');
  requireZip(zip.readUInt16LE(at+34)===0&&size<=MAX_ENTRY&&compressed<=MAX_ARCHIVE&&localOffset!==0xffffffff,'entry bounds/ZIP64');
  requireZip(nameLength>0&&nameLength<=1024&&extraLength<=4096&&commentLength<=4096,'entry metadata budget');
  span(at+46,nameLength+extraLength+commentLength,end);
  const rawName=zip.subarray(at+46,at+46+nameLength);
  requireZip((flags&0x800)!==0||rawName.every(byte=>byte<128),'unsupported legacy filename encoding');
  const name=new TextDecoder('utf-8',{fatal:true}).decode(rawName);
  requireZip(!/[\x00-\x1f\x7f\\]/.test(name)&&!name.startsWith('/')&&name.split('/').every(part=>part!==''&&part!=='.'&&part!=='..'),'unsafe archive name');
  requireZip(!names.has(name.toLowerCase()),'duplicate archive name');names.add(name.toLowerCase());
  // ZIP64 lengths are not part of the bounded ModTool archive contract.
  const checkExtra=(start:number,length:number)=>{let cursor=start;while(cursor<start+length){span(cursor,4,start+length);const id=zip.readUInt16LE(cursor),bytes=zip.readUInt16LE(cursor+2);requireZip(id!==1,'ZIP64 extra field');span(cursor+4,bytes,start+length);cursor+=4+bytes;}};
  checkExtra(at+46+nameLength,extraLength);
  span(localOffset,30,centralOffset);requireZip(zip.readUInt32LE(localOffset)===0x04034b50,'local header');
  const localNameLength=zip.readUInt16LE(localOffset+26),localExtraLength=zip.readUInt16LE(localOffset+28);
  requireZip(zip.readUInt16LE(localOffset+6)===flags&&zip.readUInt16LE(localOffset+8)===method,'local state mismatch');
  requireZip(localNameLength===nameLength&&localExtraLength<=4096,'local metadata mismatch');
  span(localOffset+30,localNameLength+localExtraLength,centralOffset);
  requireZip(zip.subarray(localOffset+30,localOffset+30+localNameLength).equals(rawName),'local name mismatch');
  checkExtra(localOffset+30+localNameLength,localExtraLength);
  const dataOffset=localOffset+30+localNameLength+localExtraLength,dataEnd=dataOffset+compressed;
  span(dataOffset,compressed,centralOffset);let localEnd=dataEnd;
  if(flags&8){
   for(const [offset,value] of [[14,crc],[18,compressed],[22,size]]){const local=zip.readUInt32LE(localOffset+offset);requireZip(local===0||local===value,'local descriptor mismatch');}
   const signed=dataEnd+4<=centralOffset&&zip.readUInt32LE(dataEnd)===0x08074b50;
   const descriptor=dataEnd+(signed?4:0);span(descriptor,12,centralOffset);
   requireZip(zip.readUInt32LE(descriptor)===crc&&zip.readUInt32LE(descriptor+4)===compressed&&zip.readUInt32LE(descriptor+8)===size,'data descriptor mismatch');
   localEnd=descriptor+12;
  }else requireZip(zip.readUInt32LE(localOffset+14)===crc&&zip.readUInt32LE(localOffset+18)===compressed&&zip.readUInt32LE(localOffset+22)===size,'local sizes/CRC mismatch');
  total+=size;requireZip(total<=MAX_TOTAL,'decoded byte budget');
  const payload=zip.subarray(dataOffset,dataEnd);
  const bytes=method===0?Buffer.from(payload):inflateRawSync(payload,{maxOutputLength:Math.max(1,size)});
  requireZip(bytes.length===size&&crc32(bytes)===crc,'decoded size/CRC mismatch');
  occupied.push({start:localOffset,end:localEnd});entries.push({name,bytes});at+=46+nameLength+extraLength+commentLength;
 }
 requireZip(at===end,'central directory entry count mismatch');
 occupied.sort((a,b)=>a.start-b.start);
 for(let i=1;i<occupied.length;i++)requireZip(occupied[i].start>=occupied[i-1].end,'overlapping local entries');
 return entries;
}
