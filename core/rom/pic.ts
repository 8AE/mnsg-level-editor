/** Native PIC codec, verified against func_80014D70/14DD8/15118/154B0. */
class Bits {
  position=0;
  constructor(readonly bytes:Uint8Array){}
  read(count:number):number {let value=0;for(let i=0;i<count;i++){if(this.position>=this.bytes.length*8)throw new Error("Truncated PIC bitstream.");value=value*2+((this.bytes[this.position>>>3]>>>(7-(this.position&7)))&1);this.position++;}return value;}
}
export function decodePic(input:Uint8Array,maxBytes=8*1024*1024):Uint8Array {
  const bits=new Bits(input),magic=String.fromCharCode(bits.read(8),bits.read(8),bits.read(8));
  if(magic!=="PIC")return input.slice();
  let key:number|undefined,marker=bits.read(8);
  if(marker!==26){const text=String.fromCharCode(marker,bits.read(8),bits.read(8),bits.read(8));if(!/^[a-f\d]{4}$/i.test(text))throw new Error("PIC transparency key is invalid.");key=parseInt(text,16);let n=0;while(bits.read(8)!==26)if(++n>4096)throw new Error("PIC header exceeds its bound.");}
  let n=0;while(bits.read(8)!==0)if(++n>4096)throw new Error("PIC metadata exceeds its bound.");
  bits.read(8);const mode=bits.read(4);bits.read(4);const bpp=bits.read(16),width=bits.read(16),height=Math.min(bits.read(16),512);
  if(!width||!height||![4,8,15,16].includes(bpp))throw new Error("Unsupported PIC dimensions or bit depth.");
  const stride=bpp===4?(width+1)&~1:width,pixelBytes=bpp<=8?stride*height*bpp/8:width*height*2;
  const paletteOffset=Math.ceil(pixelBytes/8)*8,paletteCount=bpp===4?16:bpp===8?256:0,hasPalette=bpp<=8&&mode!==4;
  const outputSize=Math.ceil((hasPalette?paletteOffset+paletteCount*2:pixelBytes)/8)*8;
  if(outputSize>maxBytes||width*height>1048576)throw new Error("PIC allocation exceeds its bounded output.");
  const output=new Uint8Array(outputSize),view=new DataView(output.buffer);
  const run=()=>{let count=1;if(bits.read(1)){count++;while(bits.read(1)){if(++count>24)throw new Error("PIC run exceeds its bound.");}}return bits.read(count)+2**count-1;};
  let steps=0;
  const step=()=>{if(++steps>width*height*32+4096)throw new Error("PIC movement budget exceeded.");};
  const diagonal=(x:number,y:number,value:number,put:(x:number,y:number,v:number)=>void)=>{
    while(true){step();const move=bits.read(2);if(move===0){if(!bits.read(1))return;x+=bits.read(1)?2:-2;}else if(move===1)x--;else if(move===3)x++;
      if(x>=width)return;y++;if(y<height)put(x,y,value);}
  };
  if(bpp<=8){
    if(hasPalette)for(let i=0;i<paletteCount;i++){let a=bits.read(5),b=bits.read(5),c=bits.read(5);if(bits.read(1))a=b=c=1;let color=(b<<11)|(a<<6)|(c<<1)|1;if(key!==undefined&&(color&0xfffe)===key)color&=0xfffe;view.setUint16(paletteOffset+i*2,color);}
    const valid=new Uint8Array(stride*height);
    const put=(x:number,y:number,value:number)=>{if(x<0||x>=width||y<0||y>=height)return;const at=y*stride+x;valid[at]=1;if(bpp===4)output[at>>>1]|=value<<((at&1)?0:4);else output[at]|=value;};
    put(0,0,0);let index=-1;
    while(true){step();index+=run();if(index>=width*height)break;const value=bits.read(bpp);put(index%width,Math.floor(index/width),value);if(bits.read(1))diagonal(index%width,Math.floor(index/width),value,put);}
    let last=0;for(let at=0;at<stride*height;at++){if(valid[at])last=bpp===4?(output[at>>>1]>>>((at&1)?0:4))&15:output[at];if(bpp===4)output[at>>>1]|=last<<((at&1)?0:4);else output[at]|=last;}
    return output;
  }
  const palette=new Uint16Array(128),previous=Array.from({length:128},(_,i)=>(i+127)%128),next=Array.from({length:128},(_,i)=>(i+1)%128);let current=0;
  const pixels=new Uint16Array(width*height);
  const get=(x:number,y:number)=>{const pixel=pixels[y*width+x];return (((pixel&0x3e)>>>1)<<11)|(((pixel&0x7c0)>>>6)<<6)|(((pixel&0xf800)>>>11)<<1)|(pixel&1);};
  const put=(x:number,y:number,color:number)=>{if(x<0||x>=width||y<0||y>=height)return;pixels[y*width+x]=(((color&0x3e)>>>1)<<11)|(((color&0x7c0)>>>6)<<6)|(((color&0xf800)>>>11)<<1)|(bpp===16?color&1:1);};
  const color=()=>{
    if(!bits.read(1)){const raw=bits.read(bpp);const canonical=bpp===15?((raw>>>5)&0x3ff)|((raw&31)<<10):((raw&0xffc0)>>>5)|((raw&0x3e)<<10)|(raw&1);current=next[current];palette[current]=canonical;return bpp===15?canonical<<1:canonical;}
    const node=bits.read(7);if(node!==current){const oldPrev=previous[node],oldNext=next[node];previous[oldNext]=oldPrev;next[oldPrev]=oldNext;const currentNext=next[current];previous[currentNext]=node;next[node]=currentNext;next[current]=node;previous[node]=current;current=node;}
    return bpp===16?palette[node]:palette[node]<<1;
  };
  let index=-1,last=0;
  while(index<width*height-1){step();let repeats=run()-1;while(repeats--){if(++index>=pixels.length)break;const existing=get(index%width,Math.floor(index/width));if(existing)last=bpp===16?existing:existing&0xfffe;put(index%width,Math.floor(index/width),last);}
    if(++index>=pixels.length)break;last=color();put(index%width,Math.floor(index/width),last);if(bits.read(1))diagonal(index%width,Math.floor(index/width),last,put);}
  for(let i=0;i<pixels.length;i++){if(bpp===15&&key!==undefined&&(get(i%width,Math.floor(i/width))&0xfffe)===key)pixels[i]=0;view.setUint16(i*2,pixels[i]);}
  return output;
}
