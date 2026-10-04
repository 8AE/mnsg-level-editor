/** Offline native collision oracle. Executes bounded original MIPS instructions
 * over private synthetic RDRAM; never calls the game, JIT or a host callback. */
import {createHash} from "node:crypto";
import {InitMachine} from "../rom/actor-init-machine";
import {decodeCollision,type CollisionVector,type CompiledCollision} from "./collision";

export interface NativeCollisionQuery {origin:CollisionVector;direction:CollisionVector;maximumDistance:number;kind?:"vertical"|"horizontal"|"ray"}
export interface NativeCollisionHit {status:number;delta:CollisionVector;normal:CollisionVector;classifier:number;surface:number;squaredDistance:number;instructions:number}
const BASE=0x80000000,PLANES=0x80500000,TREE=0x80680000,OUTPUT=0x80700000,STACK=0x80710000;
const ENTRY={vertical:0x8002aad8,horizontal:0x8002b3b0,ray:0x8002bdec};
export class NativeCollisionHarness {
  private readonly original:Uint8Array;
  constructor(decompressedUsRom:Uint8Array){
    if(createHash("sha1").update(decompressedUsRom).digest("hex")!=="6ea0ed71032ce08fc2745f412d84936382197494")throw new Error("Native collision oracle requires the canonical decompressed US ROM.");
    // Main resident image: VRAM80000000 corresponds to ROM00000C00.
    this.original=decompressedUsRom.slice(0xc00,0x86380);
  }
  query(collision:CompiledCollision,query:NativeCollisionQuery):NativeCollisionHit {
    decodeCollision(collision);
    const values=[query.origin.x,query.origin.y,query.origin.z,query.direction.x,query.direction.y,query.direction.z,query.maximumDistance];
    if(values.some(value=>!Number.isFinite(value)||!Number.isFinite(Math.fround(value)))||query.maximumDistance<=0||Math.hypot(query.direction.x,query.direction.y,query.direction.z)===0)throw new Error("Native collision query requires finite f32 coordinates, nonzero direction and positive distance.");
    const memory=new Uint8Array(8*1024*1024),view=new DataView(memory.buffer);memory.set(this.original);
    memory.set(collision.planes,PLANES-BASE);memory.set(collision.tree,TREE-BASE);
    view.setUint32(0x80168f60-BASE,collision.planes.length?PLANES:0);view.setUint32(0x80168f64-BASE,collision.tree.length?TREE:0);
    const range=(address:number,size:number)=>{const offset=address-BASE;if(!Number.isSafeInteger(offset)||!Number.isSafeInteger(size)||offset<0||size<0||offset+size>memory.length)throw new Error(`Native collision oracle unmapped access at 0x${address.toString(16)}.`);return offset;};
    const machine=new InitMachine({read(address,size){const offset=range(address,size);return memory.slice(offset,offset+size);},write(address,bytes){memory.set(bytes,range(address,bytes.length));}},{instructions:1500000,callDepth:64});
    machine.registers[29]=STACK;
    [query.direction.x,query.direction.y,query.direction.z,query.maximumDistance].forEach((value,index)=>view.setFloat32(STACK-BASE+16+index*4,value));
    machine.run(ENTRY[query.kind??"vertical"],[OUTPUT,...[query.origin.x,query.origin.y,query.origin.z].map(value=>machine.floatBits(value))]);
    const at=OUTPUT-BASE,vector=(offset:number)=>({x:view.getFloat32(at+offset),y:view.getFloat32(at+offset+4),z:view.getFloat32(at+offset+8)});
    return {status:view.getUint16(at+0x38),delta:vector(0x18),normal:vector(0x24),classifier:view.getInt8(at+0x34),surface:view.getUint16(at+0x36),squaredDistance:view.getFloat32(at+0x3c),instructions:machine.instructions};
  }
}
