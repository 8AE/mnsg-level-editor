import {createHash} from "node:crypto";
import type {GeometryTexture} from "../../shared/types";

export interface TextureTile {fmt:number;siz:number;line:number;tmem:number;palette:number;cms:number;cmt:number;masks:number;maskt:number;shifts:number;shiftt:number;uls:number;ult:number;lrs:number;lrt:number}
export const emptyTile=():TextureTile=>({fmt:0,siz:0,line:0,tmem:0,palette:0,cms:0,cmt:0,masks:0,maskt:0,shifts:0,shiftt:0,uls:0,ult:0,lrs:0,lrt:0});
const expand5=(n:number)=>((n<<3)|(n>>>2));
export function decodeTexturePixel(fmt:number,siz:number,b:number[],paletteWord?:number,tlut=0):number[] {
  if(tlut) {
    if(paletteWord===undefined)throw new Error("Texture palette entry is missing.");
    if(tlut===2)return [expand5((paletteWord>>>11)&31),expand5((paletteWord>>>6)&31),expand5((paletteWord>>>1)&31),(paletteWord&1)?255:0];
    if(tlut===3)return [paletteWord>>>8,paletteWord>>>8,paletteWord>>>8,paletteWord&255];
    throw new Error("Unsupported texture lookup-table mode.");
  }
  if(fmt===0&&siz===2){const word=(b[0]<<8)|b[1];return decodeTexturePixel(2,0,[],word,2);}
  if(fmt===0&&siz===3)return b.slice(0,4);
  if(fmt===3&&siz===0){const i=Math.round((b[0]>>>1)*255/7);return [i,i,i,(b[0]&1)?255:0];}
  if(fmt===3&&siz===1){const i=(b[0]>>>4)*17;return [i,i,i,(b[0]&15)*17];}
  if(fmt===3&&siz===2)return [b[0],b[0],b[0],b[1]];
  if(fmt===4&&(siz===0||siz===1)){const i=siz===0?b[0]*17:b[0];return [i,i,i,i];}
  throw new Error(`Unsupported native texture format ${fmt}/${4<<siz}.`);
}

/** CPU translation of RT64 loadToTMEMCommon; ROM input is already big endian. */
export class NativeTextureMemory {
  readonly bytes=new Uint8Array(4096);
  readonly initialized=new Uint8Array(4096);
  readonly tiles=Array.from({length:8},emptyTile);
  private image={fmt:0,siz:0,width:1,address:0};
  version=0;
  constructor(private readonly read:(address:number,size:number)=>Uint8Array) {}
  setImage(w0:number,w1:number){this.image={fmt:(w0>>>21)&7,siz:(w0>>>19)&3,width:(w0&4095)+1,address:w1};}
  setTile(w0:number,w1:number){const tile=this.tiles[(w1>>>24)&7];Object.assign(tile,{fmt:(w0>>>21)&7,siz:(w0>>>19)&3,line:(w0>>>9)&511,tmem:w0&511,palette:(w1>>>20)&15,cmt:(w1>>>18)&3,maskt:(w1>>>14)&15,shiftt:(w1>>>10)&15,cms:(w1>>>8)&3,masks:(w1>>>4)&15,shifts:w1&15});}
  setTileSize(w0:number,w1:number){Object.assign(this.tiles[(w1>>>24)&7],{uls:(w0>>>12)&4095,ult:w0&4095,lrs:(w1>>>12)&4095,lrt:w1&4095});}
  load(opcode:number,w0:number,w1:number):void {
    const tile=this.tiles[(w1>>>24)&7],uls=(w0>>>12)&4095,ult=w0&4095,lrs=(w1>>>12)&4095,lrt=w1&4095;
    const tlut=opcode===0xf0,block=opcode===0xf3,rgba32=tile.fmt===0&&tile.siz===3;
    const count=tlut?((w1>>>14)&1023)+1:block?((lrs-uls)>>(4-tile.siz))+1:(((lrs>>>2)-(uls>>>2))>>(4-tile.siz))+1;
    const rows=tlut||block?1:(lrt>>>2)-(ult>>>2)+1;
    if(count<1||count>1024||rows<1||rows>1024||count*rows>16384)throw new Error("Texture load exceeds its bounded extent.");
    const sourceStride=(this.image.width<<this.image.siz)>>>1;
    const start=this.image.address+((block?uls:uls>>>2)<<this.image.siz>>>1)+sourceStride*(block?ult:ult>>>2);
    const stride=tile.line<<(tlut?5:3),mask=rgba32?2047:4095,advance=rgba32?4:8;
    let destination=(tile.tmem<<3)&mask,xor=0,counter=0;
    const put=(address:number,value:number)=>{address&=4095;this.bytes[address]=value;this.initialized[address]=1;};
    // Validate every source range before committing a TMEM load.
    const sourceRows=Array.from({length:rows},(_,row)=>this.read(start+row*sourceStride,count*(tlut?2:8)));
    for(let row=0;row<rows;row++) {
      let target=destination;
      for(let word=0;word<count;word++) {
        const source=sourceRows[row],base=word*(tlut?2:8);
        if(rgba32){for(let i=0;i<4;i++){const lowIndex=[0,1,4,5][i],highIndex=[2,3,6,7][i];put((target+i)^xor,source[base+(tlut?lowIndex&1:lowIndex)]);put(((target+i)^xor)|2048,source[base+(tlut?highIndex&1:highIndex)]);}}
        else for(let i=0;i<8;i++)put((target+i)^xor,source[base+(tlut?i&1:i)]);
        if(block){counter+=lrt;while(counter>=2048){target=(target+stride)&mask;counter-=2048;xor^=4;}}
        target=(target+advance)&mask;
      }
      destination=(destination+stride)&mask;if(!block)xor^=4;
    }
    this.version++;
  }
  decode(tileIndex:number,tlut:number):GeometryTexture {
    const tile=this.tiles[tileIndex];
    const extentS=(tile.lrs-tile.uls)/4+1,extentT=(tile.lrt-tile.ult)/4+1;
    if(!Number.isInteger(extentS)||!Number.isInteger(extentT)||extentS<1||extentT<1)throw new Error("Texture tile bounds are invalid or fractional.");
    const width=(tile.cms&2)||!tile.masks?extentS:2**tile.masks,height=(tile.cmt&2)||!tile.maskt?extentT:2**tile.maskt;
    if(width>1024||height>1024||width*height>262144)throw new Error("Decoded texture exceeds its pixel budget.");
    if(tile.line===0&&height>1)throw new Error("Texture tile has no row stride.");
    if(tile.fmt===2&&!tlut)throw new Error("CI texture has no active palette mode.");
    const rgba32=tile.fmt===0&&tile.siz===3,mask=(rgba32||tlut)?2047:4095,rgba=new Uint8Array(width*height*4);
    const get=(address:number)=>{address&=4095;if(!this.initialized[address])throw new Error("Texture samples uninitialized TMEM.");return this.bytes[address];};
    const fold=(coord:number,bits:number,mode:number)=>{if(!bits)return coord;const period=2**bits;if((mode&1)&&Math.floor(coord/period)%2)return period-1-(coord%period);return coord%period;};
    for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
      // Clamped tiles may contain internal mask/mirror repetition; bake that pattern.
      const sx=(tile.cms&2)?fold(x,tile.masks,tile.cms):x,sy=(tile.cmt&2)?fold(y,tile.maskt,tile.cmt):y;
      const address=(relative:number,bank=0)=>(((tile.tmem*8+sy*tile.line*8+relative)^((sy&1)?4:0))&mask)|bank;
      const p=(sx<<(rgba32?2:tile.siz))>>>1,byte=get(address(p)),nibble=(byte>>>((sx&1)?0:4))&15;
      let values=[tile.siz===0?nibble:byte];
      if(tile.siz>=2)values.push(get(address(p+1)));
      if(tile.siz===3)values.push(get(address(rgba32?p:p+2,rgba32?2048:0)),get(address(rgba32?p+1:p+3,rgba32?2048:0)));
      let paletteWord:number|undefined;
      if(tlut){const palette=2048+(tile.siz===0?tile.palette*128+nibble*8:byte*8);paletteWord=(get(palette)<<8)|get(palette+1);}
      rgba.set(decodeTexturePixel(tile.fmt,tile.siz,values,paletteWord,tlut),(y*width+x)*4);
    }
    const id=createHash("sha256").update(`${width}:${height}:`).update(rgba).digest("hex");
    return {id,width,height,rgbaBase64:Buffer.from(rgba).toString("base64"),format:tlut?`CI${4<<tile.siz}/TLUT${tlut===2?"RGBA16":"IA16"}`:`${["RGBA","YUV","CI","IA","I"][tile.fmt]??"unknown"}${4<<tile.siz}`};
  }
}

export function textureCoordinate(value:number,shift:number,origin:number,dimension:number,filter:"nearest"|"linear"="linear"):number {
  const shifted=shift<=10?value/2**shift:value*2**(16-shift);
  return (shifted-origin/4+(filter==="linear"?0.5:0))/dimension;
}
