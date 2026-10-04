/** Bounded, offline MIPS32/FPU interpreter. It never invokes host game code. */
export interface InitMemory {
  read(address:number,size:number):Uint8Array;
  write(address:number,bytes:Uint8Array):void;
}
export interface InitMachineLimits { instructions:number; callDepth:number }
const signed=(value:number)=>value|0;
const h=(value:number)=>`0x${(value>>>0).toString(16)}`;
function nearestEven(value:number):number {const lower=Math.floor(value),fraction=value-lower;return fraction<0.5?lower:fraction>0.5?lower+1:lower%2===0?lower:lower+1;}
export class InitMachine {
  readonly registers=new Uint32Array(32);
  readonly floating=new Uint32Array(32);
  pc=0; nextPc=0; hi=0; lo=0; condition=false; fcr31=0; instructions=0; depth=0;
  readonly branches:{pc:number;taken:boolean;target:number}[]=[];
  private readonly bits=new DataView(new ArrayBuffer(8));
  private inDelay=false;
  constructor(readonly memory:InitMemory,readonly limits:InitMachineLimits={instructions:100000,callDepth:64},readonly intercept?:(pc:number,machine:InitMachine)=>boolean){}
  u8(address:number){return this.memory.read(address>>>0,1)[0];}
  u16(address:number){const b=this.memory.read(address>>>0,2);return new DataView(b.buffer,b.byteOffset,2).getUint16(0);}
  u32(address:number){const b=this.memory.read(address>>>0,4);return new DataView(b.buffer,b.byteOffset,4).getUint32(0);}
  store(address:number,value:number,size:number){const b=new Uint8Array(size),v=new DataView(b.buffer);if(size===1)v.setUint8(0,value);else if(size===2)v.setUint16(0,value);else v.setUint32(0,value);this.memory.write(address>>>0,b);}
  floatBits(value:number){this.bits.setFloat32(0,value);return this.bits.getUint32(0);}
  fromBits(value:number){this.bits.setUint32(0,value);return this.bits.getFloat32(0);}
  f32(index:number){return this.fromBits(this.floating[index]);}
  setF32(index:number,value:number){this.floating[index]=this.floatBits(value);}
  f64(index:number){if(index&1)throw new Error("Odd paired-double FPU register.");this.bits.setUint32(0,this.floating[index+1]);this.bits.setUint32(4,this.floating[index]);return this.bits.getFloat64(0);}
  setF64(index:number,value:number){if(index&1)throw new Error("Odd paired-double FPU register.");this.bits.setFloat64(0,value);this.floating[index]=this.bits.getUint32(4);this.floating[index+1]=this.bits.getUint32(0);}
  argument(index:number){return index<4?this.registers[4+index]:this.u32(this.registers[29]+index*4);}
  returnFromIntercept(){this.pc=this.registers[31]>>>0;this.nextPc=(this.pc+4)>>>0;this.inDelay=false;this.depth=Math.max(0,this.depth-1);}
  run(entry:number,args:number[]=[],stop=0xfffffff0){
    this.pc=entry>>>0;this.nextPc=(this.pc+4)>>>0;this.registers[31]=stop;this.inDelay=false;this.depth=0;
    args.slice(0,4).forEach((value,index)=>{this.registers[index+4]=value;});
    while(this.pc!==stop){
      if(this.instructions>=this.limits.instructions)throw new Error(`Actor initialization instruction limit at ${h(this.pc)}.`);
      if(this.depth>this.limits.callDepth)throw new Error(`Actor initialization call-depth limit at ${h(this.pc)}.`);
      if(this.intercept?.(this.pc,this)){this.instructions++;this.registers[0]=0;continue;}
      this.step();
    }
    return this.registers[2];
  }
  step(){
    const pc=this.pc,word=this.u32(pc),op=word>>>26,rs=(word>>>21)&31,rt=(word>>>16)&31,rd=(word>>>11)&31,shift=(word>>>6)&31,funct=word&63,imm=word&65535,simm=(imm<<16)>>16;
    const r=this.registers,a=r[rs],b=r[rt],address=(a+simm)>>>0,wasDelay=this.inDelay;
    this.pc=this.nextPc;this.nextPc=(this.nextPc+4)>>>0;this.inDelay=false;this.instructions++;
    const transfer=(target:number)=>{if(wasDelay)throw new Error(`Control transfer in native branch delay slot ${h(pc)}.`);this.nextPc=target>>>0;this.inDelay=true;};
    const branch=(taken:boolean,likely=false)=>{
      const target=(pc+4+simm*4)>>>0;this.branches.push({pc,taken,target});
      if(taken)transfer(target);else if(likely){this.pc=(pc+8)>>>0;this.nextPc=(pc+12)>>>0;}else this.inDelay=true;
    };
    const multiply=(isSigned:boolean)=>{const product=(isSigned?BigInt(signed(a))*BigInt(signed(b)):BigInt(a)*BigInt(b));this.lo=Number(BigInt.asUintN(32,product));this.hi=Number(BigInt.asUintN(32,product>>32n));};
    if(op===0){
      switch(funct){
        case 0:r[rd]=b<<shift;break;case 2:r[rd]=b>>>shift;break;case 3:r[rd]=signed(b)>>shift;break;
        case 4:r[rd]=b<<(a&31);break;case 6:r[rd]=b>>>(a&31);break;case 7:r[rd]=signed(b)>>(a&31);break;
        case 8:if(rs===31)this.depth=Math.max(0,this.depth-1);transfer(a);break;
        case 9:r[rd]=pc+8;this.depth++;transfer(a);break;
        case 10:if(b===0)r[rd]=a;break;case 11:if(b!==0)r[rd]=a;break;
        case 15:break;case 16:r[rd]=this.hi;break;case 17:this.hi=a;break;case 18:r[rd]=this.lo;break;case 19:this.lo=a;break;
        case 24:multiply(true);break;case 25:multiply(false);break;
        case 26:if(!b)throw new Error(`Native signed division by zero at ${h(pc)}.`);this.lo=Math.trunc(signed(a)/signed(b))>>>0;this.hi=(signed(a)%signed(b))>>>0;break;
        case 27:if(!b)throw new Error(`Native unsigned division by zero at ${h(pc)}.`);this.lo=Math.trunc(a/b)>>>0;this.hi=(a%b)>>>0;break;
        case 32:case 33:r[rd]=a+b;break;case 34:case 35:r[rd]=a-b;break;
        case 36:r[rd]=a&b;break;case 37:r[rd]=a|b;break;case 38:r[rd]=a^b;break;case 39:r[rd]=~(a|b);break;
        case 42:r[rd]=signed(a)<signed(b)?1:0;break;case 43:r[rd]=a<b?1:0;break;
        case 13:throw new Error(`Native BREAK at ${h(pc)}.`);
        default:throw new Error(`Unknown native SPECIAL instruction ${h(word)} at ${h(pc)}.`);
      }
    }else if(op===1){
      const sign=signed(a),link=rt===16||rt===17||rt===18||rt===19;
      if(![0,1,2,3,16,17,18,19].includes(rt))throw new Error(`Unknown REGIMM instruction ${h(word)} at ${h(pc)}.`);
      const taken=(rt&1)?sign>=0:sign<0;if(link){r[31]=pc+8;if(taken)this.depth++;}branch(taken,rt===2||rt===3||rt===18||rt===19);
    }else if(op===2||op===3){if(op===3){r[31]=pc+8;this.depth++;}transfer((((pc+4)&0xf0000000)|((word&0x3ffffff)*4))>>>0);
    }else if(op===4||op===20)branch(a===b,op===20);
    else if(op===5||op===21)branch(a!==b,op===21);
    else if(op===6||op===22)branch(signed(a)<=0,op===22);
    else if(op===7||op===23)branch(signed(a)>0,op===23);
    else if(op===8||op===9)r[rt]=a+simm;
    else if(op===10)r[rt]=signed(a)<simm?1:0;
    else if(op===11)r[rt]=a<(simm>>>0)?1:0;
    else if(op===12)r[rt]=a&imm;else if(op===13)r[rt]=a|imm;else if(op===14)r[rt]=a^imm;else if(op===15)r[rt]=imm<<16;
    else if(op===17){
      if(rs===0)r[rt]=this.floating[rd];else if(rs===4)this.floating[rd]=r[rt];
      else if(rs===2)r[rt]=rd===31?((this.fcr31&~0x800000)|(this.condition?0x800000:0)):0;
      else if(rs===6){if(rd===31){this.fcr31=r[rt];this.condition=(r[rt]&0x800000)!==0;}}
      else if(rs===8)branch((rt&1)?this.condition:!this.condition,(rt&2)!==0);
      else {
        const fs=rd,ft=rt,fd=shift;
        if(![16,17,20].includes(rs))throw new Error(`Unknown native COP1 format ${rs} at ${h(pc)}.`);
        const x=rs===16?this.f32(fs):rs===17?this.f64(fs):signed(this.floating[fs]),y=rs===16?this.f32(ft):rs===17?this.f64(ft):signed(this.floating[ft]);
        const put=(value:number)=>{if(rs===17)this.setF64(fd,value);else this.setF32(fd,value);};
        const convertWord=(value:number)=>{
          if(!Number.isFinite(x)||value< -0x80000000||value>0x7fffffff){this.fcr31|=0x10040;this.floating[fd]=0x80000000;}
          else {if(value!==x)this.fcr31|=0x1004;this.floating[fd]=value>>>0;}
        };
        switch(funct){
          case 0:put(x+y);break;case 1:put(x-y);break;case 2:put(x*y);break;case 3:put(x/y);break;
          case 4:put(Math.sqrt(x));break;case 5:put(Math.abs(x));break;case 6:put(x);break;case 7:put(-x);break;
          case 12:convertWord(nearestEven(x));break;case 13:convertWord(Math.trunc(x));break;
          case 14:convertWord(Math.ceil(x));break;case 15:convertWord(Math.floor(x));break;
          case 32:this.setF32(fd,x);break;case 33:this.setF64(fd,x);break;
          case 36:{const mode=this.fcr31&3;convertWord(mode===1?Math.trunc(x):mode===2?Math.ceil(x):mode===3?Math.floor(x):nearestEven(x));break;}
          default:if(funct>=48){const unordered=Number.isNaN(x)||Number.isNaN(y);this.condition=((funct&1)!==0&&unordered)||((funct&2)!==0&&!unordered&&x===y)||((funct&4)!==0&&!unordered&&x<y);}else throw new Error(`Unknown native FPU operation ${h(word)} at ${h(pc)}.`);
        }
      }
    }else if(op===28){if(funct===2)r[rd]=Math.imul(a,b);else if(funct===32)r[rd]=Math.clz32(a);else if(funct===33)r[rd]=Math.clz32(~a);else throw new Error(`Unknown native SPECIAL2 operation ${h(word)} at ${h(pc)}.`);
    }else if(op===32)r[rt]=(this.u8(address)<<24)>>24;
    else if(op===33)r[rt]=(this.u16(address)<<16)>>16;
    else if(op===35||op===48)r[rt]=this.u32(address);
    else if(op===36)r[rt]=this.u8(address);else if(op===37)r[rt]=this.u16(address);
    else if(op===34){const n=address&3,mask=n?2**(8*n)-1:0;r[rt]=(this.u32(address&~3)<<(8*n))|(b&mask);}
    else if(op===38){const n=address&3,mask=n===3?0xffffffff:2**(8*(n+1))-1;r[rt]=(this.u32(address&~3)>>>(8*(3-n)))|(b&~mask);}
    else if(op===40)this.store(address,b,1);else if(op===41)this.store(address,b,2);else if(op===43)this.store(address,b,4);
    else if(op===42){const n=address&3;for(let i=n;i<4;i++)this.store((address&~3)+i,b>>>(8*(3-i+n)),1);}
    else if(op===46){const n=address&3;for(let i=0;i<=n;i++)this.store((address&~3)+i,b>>>(8*(n-i)),1);}
    else if(op===49)this.floating[rt]=this.u32(address);
    else if(op===57)this.store(address,this.floating[rt],4);
    else if(op===53){if(rt&1)throw new Error("Odd native LDC1 register.");this.floating[rt+1]=this.u32(address);this.floating[rt]=this.u32(address+4);}
    else if(op===61){if(rt&1)throw new Error("Odd native SDC1 register.");this.store(address,this.floating[rt+1],4);this.store(address+4,this.floating[rt],4);}
    else if(op===56){this.store(address,b,4);r[rt]=1;}
    else if(op===47||op===51){/* CACHE/PREF do not change architectural state. */}
    else throw new Error(`Unknown native instruction ${h(word)} at ${h(pc)}.`);
    r[0]=0;
  }
}
