import {createHash} from "node:crypto";
import {RomReader} from "./binary";
import type {RomFile} from "./decompress";
import type {NativeActorInitInput} from "./actor-init";
import type {RenderWaves} from "./waves";
import {readFileTable} from "./decompress";
import {NativeLinkedArena,NativeResourceRegistry,NATIVE_REGISTRY_BYTES} from "./actor-init-resources";

const ROM_HASH="e40bee20508c2e29e651dca4e47504e40f908f0a2186e34a582784bf5a64be4c";
const GUARDS:readonly (readonly [string,number,number,string])[]=[
  ["common-list",0x587bf4,0x30,"cac4ec5c2e72aa558098621398b4f7e17b14f0961d780e9dc7badce63ee331b5"],
  ["animated",0x5d1b1c,0x1ec,"ae1cbf865a1e4c5e877805ef4bf99248a1a68026cfdfb6317a3ab0a64f69e69d"],
  ["plain",0x5d21b0,0x118,"f375990ad0d118689a77590cf678a6a1408e7674c12f295cd187178d66dd79a6"],
  ["segments",0x14e18,0xa4,"de7ba61c109d5a70a1f0387d5611d04fa3f2aa1610294e1ca7d2da98d28693e4"],
  ["dc630",0x598540,0xdc,"3a5e07e48763635e17a2429edb92d744c6a759d33592463019a25ac8eb49abf4"],
  ["room306cb",0x5cb02c,0x24,"c070ae23f1ab9dd74a23a2c30434f493d8a54f4ad3fbc939bb52ce716c3e760c"],
  ["room193cb",0x5cae34,0x24,"10e697d3da7a00e042993a35ab2a53c0ad6391458ee5c2f04383f33bde9fcd3e"],
  ["trim",0x145a4,0x80,"ff3c2c12bfbdfa141a84bd987113e40ad56401e3526a96a2968eaa602107791c"],
  ["bind-df8",0x5d22c8,0x24,"e9f31f0db084779f7943a9f26b3e528905b6494715d90ba79cb48e1c55a4b5d8"],
  ["bind-e1c",0x5d22ec,0x38,"218cd3e281055340d765ccb7c3771652b5cb7c6def74fd5a3280d13ebf9eb640"],
  ["bind-ed0",0x5d23a0,0x12c,"11c31ae4709d0bdf72817320f097347c77b3f27fb20893a7da7de6e2d8176dab"],
  ["bind-ffc",0x5d24cc,0x118,"211e99a4a6b799f4d52956dadeae150a1dcd213d77b9cbd437f3f70b494189f9"],
  ["bind-c0c",0x5dd0dc,0xc0,"6a723ee9ca6594a637ba86d4a504a8c1210457596b836f936933af3cf69dce19"],
  ["cold728c",0x5b319c,0x280,"91ebfad3f4e1f661e6ed125acb842757b78803509c26e6fa2f20a68dad777f4f"],
  ["hot7f78",0x5b3e88,0x318,"dd3f3b14a38df6e8367de9e1537241ebbaace338bc1c7b056e28c039113cd529"],
  ["donorLoad87f8",0x5b4708,0x454,"7d291fd0ea9c39da4b98571731db82412176040c7515c43aab5eade18efe41c1"],
  ["prefixBoundary8790",0x5b46a0,0x68,"c090462c0c3f02b67b0a909498be97b8f728c2ae42ee5ff207c804bd276ebff1"],
  ["142bc",0x14ebc,0x22c,"a0929620baefe974e70ac3e6c942b89caced2203e113e270c49a2a85012ed751"],
  ["nativeSegment",0x2a50,0x60,"8e41cf0dd7288f559d5535debdc7f807389d7dd517b7ece2bedf4e1573931c17"],
  ["nativeCodeTag",0x29f4,0x5c,"473fb38eff509e62825ece5edadc989c5a9f4ce861b35af8257cda91a2852d37"],
  ["overlayMap",0x1541c,0x24,"e2cdfa3d9515c49b1a6d25e93945a019190e3f033ae764a46961227927606794"],
  ["reset13940",0x14540,0x64,"baefeae9dbd81ff12f9d3dfb8c931e60f7307a1b2a76abcf71ad361b64c22b71"],
  ["cpuTLB",0x2ab0,0x138,"8361ccfbf9f476c692c4b0afdd2a35740f47f05b5042bc7c43c952694a792599"],
  ["CBD14",0x587c24,0x74,"9e74a46589782cbd05b574b917f9bc15bc2201ed1ca46480398622440f6687d6"],
  ["DC9C8",0x5988d8,0x9c,"7b1be4d16f3c5dc2fde8832328ec31c6d5be1d0fc4fabb8dc90656eb413565b0"],
  ["commonList",0x5b86c8,0x4,"94751be059d25844fadecb89656e16fe3ec44058475017859ec762f26173f014"],
  ["roomGroupPointers",0x5c581c,0x18,"703f3bf125c3a5fa0b1ed8a51fec4d39abf77dc853f517fe39284bcbb08028d6"],
  ["roomBoundaries",0x5c610,0x1e,"b3e5a225056fba1f7e7b63ab9a8ed4f0125dff5c267cff36ddba69f3ddef73b7"],
  ["characterGraphics",0x5bff30,0x8,"861df578c99352c93d993ff49b03bf0ff1aa7ac09f4dac302c22e5e7fc73de86"],
  ["characterPaths",0x5bff38,0x8,"ed8f519cd6f4bfdf673c633ac14278d197a51427f8ff831aed824d6be31644c1"],
  ["metadata306",0x5eb58c,0x1c,"65e73b7d19ff27e2be864880f49f917e00458250c96c5165551a9fe409d21e14"],
  ["roomResource306",0x5c2440,0x8,"8ed9604bd970118e1dd2a72320548ab274c50c7208803392a4ac570789da43a4"],
  ["roomCallbackList306",0x5e8b44,0x30,"cba333494c5713dafc47f651b968de4dac776249415d07d91c14928ac2694d9c"],
  ["metadata193",0x5eb404,0x1c,"a42c4417c6d3a1517e21bd8c1f730d59c6eadca070f9f0f19873da3f2c0c3403"],
  ["roomResource193",0x5c4668,0x8,"1d6f57547af6334d948ea3e7c643799e650f7192e34b63be227c98e934e9f428"],
  ["roomCallbackList193",0x5e89f0,0x24,"c9f32394b61ee20237877684c63572e8e8cf42547f9d4b3751c786719be2f0d0"],
  ["code45Interval",0x55524,0x4,"233a2a830f57d17f12de6d13f953279beddba9eb23f50c8d996921a46399155d"],
  ["code45Allocation",0x5582c,0x8,"97a4603fe3757a254e6573629f6c3f7efc1150afd847f0823c87b8b4f7ee7a6d"],
  ["code45PartsPointer",0x6a5d0,0x4,"a1e099c8af03f498f86fe1e3fd53976be51c2d1f9f8214597cf6c8c849f07d91"],
  ["code45PartsTerminator",0x66398,0x4,"df3f619804a92fdb4057192dc43dd748ea778adc52bc498ce80524c014b81119"],
  ["code74Interval",0x55524,0x4,"233a2a830f57d17f12de6d13f953279beddba9eb23f50c8d996921a46399155d"],
  ["code74Allocation",0x55914,0x8,"df0e99dbf67ddf5a6ac02a9e669127e8e28f989b41344cb49e45f46a97761fb0"],
  ["code74PartsPointer",0x6a644,0x4,"a1e099c8af03f498f86fe1e3fd53976be51c2d1f9f8214597cf6c8c849f07d91"],
  ["code74PartsTerminator",0x66398,0x4,"df3f619804a92fdb4057192dc43dd748ea778adc52bc498ce80524c014b81119"],
  ["helper40170-1",0x40d10,0x138,"ad040654b818eee517f03ea5cac67fc3ce1f4eb5f902224740abc263d04a5663"],
  ["loadBoundary1",0x734790,0xa8,"f8a94c25826845fb90d2214a8f187a91c11818955a5f9483f67e7347d9ac945f"],
  ["bookkeep0",0x14714,0xf8,"dd765e24fcbae49c2ced2466aee0497974b9129596388f121f07c44788da3572"],
  ["bookkeep1",0x154f0,0x138,"ab1ee8c7c6baef7bfe86ec795028fe37c941f927f92ba71729e064a9005f6bc6"],
  ["exactVisual1",0x7380b0,0x4c,"1dad4d40b12ead1ce88f04dbf58c2a9290540f1d1788271bd4b26fd383689dca"],
  ["exactVisual2",0x73734c,0xdc,"9fdefed22caffc791f4014d77e94b5a652a01a42e786b352d2afa047de750d41"],
  ["exactVisual3",0x5db8e0,0xec,"9e5deac46c3de48d83b6e6bb972179431a272d094f41f963f0bc4d9d2307e904"],
  ["lastTyped1",0x6fed54,0xec,"c5f1b704b8da68bf66f0f97d2ae30e42a06a63001b678b545d152cce4a82d7ed"],
  ["lastTyped2",0x2240,0xa4,"647f0c7107c0c50d4ff30aa31a9b9333d2f9d41678658f633df6c820542fa7ee"],
  ["lastTyped3",0x15774,0x8c,"fa6c65eec23dcccdb66bcb2f5061c11853ad4384c3b5b0706ea0ce30ea6b3051"],
  ["finalDMA2",0x700250,0x118,"98a8e8b5d1628d53a667fba84eb57fe534f9bcf4b514c3256da2bdfd1d78f8e2"],
  ["finalDMA3",0x734790,0xa8,"f8a94c25826845fb90d2214a8f187a91c11818955a5f9483f67e7347d9ac945f"],
  ["finalDMA4",0x40b50,0x1b8,"670bc2318186683cee58b0cfee3fcc8bd75a61a7242d287886dd8eb4f9a76790"],
  ["typedExtras3",0x6fea30,0x1ac,"ff3a25801a4189d40e3473f31982dbd7aba6ceaea208e5d63b159e192e53883b"],
  ["arenaInit1",0x154c0,0x30,"6ded35b26566e2f334363759c07d862eca07b8a84c2ec9fe6870bf97bc893814"],
  ["arenaInit3",0x2800,0x168,"19e65a3fda8160428dfd0af82f192d84bb03541d3a723958bda1627a82a140d4"],
  ["typedEnd1",0x734838,0x90,"cc68ee9c13514ffa9ca8e523ac569a100254dee670d9b3df0092eaf920a66c70"],
  ["typedEnd2",0x6ff1bc,0xb0,"46fcd9e0fc733679a0dda702767e7895f1ca757d61868a24a7aaa7138c266286"],
  ["gorgeousResourceList",0x738160,0x1e,"9831cfc8805fd005a3937d661510fc88d723ac492d7a85720256939b7e8a3510"],
];
const digest=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");
export const LOADER_REGISTRY_ADDRESS=0x80167fc0,LOADER_ARENA_DESCRIPTOR=0x80154c64;
export function verifiedLoaderPresentationCall(call:{actorId:number;codeFile:number;target:number;returnAddress:number;argument:number}):boolean {
  return call.actorId===0x35c&&call.codeFile===74&&((call.target===0x8003ff50&&call.returnAddress===0x08003938&&call.argument===0x40)||(call.target===0x80038bc8&&call.returnAddress===0x08003948&&call.argument===1));
}

/** Explicit conditional cold postcallback checkpoint, never a live occupancy claim. */
export class NativeLoaderPreview {
  readonly registry:NativeResourceRegistry;
  readonly arena=NativeLinkedArena.initialize(LOADER_ARENA_DESCRIPTOR,0x802f7000,new Uint8Array(0xa000));
  readonly donor:number;readonly overlay:number;readonly preloadedCount:number;readonly preloadedCursor:number;
  constructor(readonly reader:RomReader,readonly files:Map<number,RomFile>,readonly input:NativeActorInitInput,readonly waves:Pick<RenderWaves,"image">){
    this.donor=input.actorId===0x24c?306:input.actorId===0x35c?193:-1;this.overlay=input.actorId===0x24c?45:74;
    const actual=input.roomId;
    if(this.donor<0||actual===undefined||!Number.isInteger(actual)||actual<0||actual>799||(input.templateRoomId??actual)!==this.donor||!Array.isArray(input.parameters)||input.parameters.length!==3||[0,1,2].some(index=>input.parameters[index]!==0)||(input.unknownHalfword??0)!==0)throw new Error("Scoped loader preview requires the matching native donor and zero definition words/halfword; other scene contexts remain unresolved.");
    for(const [name,offset,length,expected] of GUARDS){reader.check(offset,length);if(digest(reader.bytes.subarray(offset,offset+length))!==expected)throw new Error(`Native loader preview ${name} byte/table guard changed.`);}
    if(digest(reader.bytes)!==ROM_HASH)throw new Error("Native loader preview requires the canonical decompressed US ROM identity.");
    for(const file of readFileTable(reader.bytes)){const supplied=files.get(file.id);if(!supplied||supplied.start!==file.start||supplied.end!==file.end||supplied.compressed!==file.compressed)throw new Error("Native loader file table/bounds changed.");}
    const expectedEntry=0x08000000,entry=reader.u32(0x5e3c8c+input.actorId*4),overlay=reader.i16(0x5e4ca6+input.actorId*2);
    if(entry!==expectedEntry||overlay!==this.overlay)throw new Error("Native loader actor entry/overlay changed.");
    for(const id of [45,74]){const file=files.get(id);if(!file||file.compressed||file.start!==(id===45?0x6fea30:0x734790)||file.end!==(id===45?0x701100:0x7386d0))throw new Error("Native loader CPU file bounds changed.");}
    const records=new Uint8Array(NATIVE_REGISTRY_BYTES);new DataView(records.buffer).setUint32(4,0x80321500);
    this.registry=new NativeResourceRegistry({bankStart:0x80304000,bankEnd:0x80594000,records,allocations:[]});
    this.loadListAt(0x801fc7b8);
    const roomRecord=this.donor===306?0x5c2440:0x5c4668;
    const primary=reader.u16(roomRecord),secondary=reader.u16(roomRecord+2),tertiary=reader.u16(roomRecord+4),background=reader.u16(roomRecord+6);
    this.registry.loadList([127,secondary,tertiary,primary,...(background?[background]:[])],id=>waves.image(id));
    this.loadListAt(this.donor===306?0x8022d674:0x8022d520);
    const snapshot=this.registry.snapshot();this.preloadedCount=snapshot.allocations.length;this.preloadedCursor=new DataView(snapshot.records.buffer).getUint32(this.preloadedCount*8+4);
    if(this.preloadedCount!==(this.donor===306?29:22)||this.preloadedCursor!==(this.donor===306?0x803f6500:0x803a0780))throw new Error("Native loader ordered checkpoint ledger changed.");
  }
  private residentOffset(pointer:number):number {
    if(pointer>=0x80000400&&pointer<0x8007e020)return this.reader.check(pointer-0x80000000+0xc00,2);
    const common=this.files.get(12);if(common&&pointer>=0x8020d2a0&&pointer+2<=0x8020d2a0+common.end-common.start)return this.reader.check(common.start+pointer-0x8020d2a0,2,common.end);
    const player=this.files.get(11);if(player&&pointer>=0x801cb460&&pointer+2<=0x801cb460+player.end-player.start)return this.reader.check(player.start+pointer-0x801cb460,2,player.end);
    if(this.overlay===74&&pointer===0x080039d0)return this.reader.check(this.files.get(74)!.start+0x39d0,2,this.files.get(74)!.end);
    throw new Error("Native loader list pointer has no guarded source.");
  }
  loadListAt(pointer:number):number {
    if(pointer!==0x801fc7b8&&pointer!==(this.donor===306?0x8022d674:0x8022d520)&&!(this.overlay===74&&pointer===0x080039d0))throw new Error("Native loader list pointer is outside the exact guarded callers.");
    const start=this.residentOffset(pointer),ids:number[]=[];
    for(let i=0;i<49;i++){const id=this.reader.u16(start+i*2);if(!id){if(!ids.length)throw new Error("Empty native loader list return is unproven.");return this.registry.loadList(ids,n=>this.waves.image(n));}ids.push(id);}
    throw new Error("Native loader resource list exceeds its guarded slot budget.");
  }
  load(id:number):number{return this.registry.load(id,n=>this.waves.image(n));}
  lookup(id:number):number{return this.registry.lookup(id);}
  base(id:number):number {const tagged=this.lookup(id);if(tagged===-1)throw new Error(`Missing native resource ${id}; lookup does not implicitly load.`);return (tagged&0xbfffffff)>>>0;}
  metadata(){const s=this.registry.snapshot(),count=s.allocations.length;return {donor:this.donor,preloadedCount:this.preloadedCount,preloadedCursor:this.preloadedCursor,finalCount:count,finalCursor:new DataView(s.records.buffer).getUint32(count*8+4)};}
}
