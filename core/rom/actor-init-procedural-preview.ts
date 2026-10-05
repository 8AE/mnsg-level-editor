import {createHash} from "node:crypto";
import {RomReader} from "./binary";
import {readFileTable,type RomFile} from "./decompress";
import {InitMachine,type InitMemory} from "./actor-init-machine";
import {NativeLinkedArena,NativeResourceRegistry,NATIVE_REGISTRY_BYTES,type NativeArenaContext} from "./actor-init-resources";
import type {RenderWaves} from "./waves";
import type {NativeActorInitInput,NativeActorInitResult} from "./actor-init";

const ROM_HASH="e40bee20508c2e29e651dca4e47504e40f908f0a2186e34a582784bf5a64be4c";
const WAVE_HASH="3a010a2aafc01d14abbc1c1e6298b3992e15434d6dac8c5f2ae19183d9abc3d9";
const TASK=0x81000000,OBJECT=0x81000100,ARENA_BASE=0x81010000,DESCRIPTOR=0x80154c64,REGISTRY=0x80167fc0,STOP=0xfffffff0;
const digest=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");
const BODIES:readonly (readonly [number,number,number,string])[]=[
  [0x800246bc,0x252bc,120,"b36b9a8011e096d6786e5a09975adf40a2f53a30d78f1ebce099b1315c778967"],
  [0x801cc978,0x65f828,300,"140cb7bf505e91abae4dfca8c88a6f08cba81fd3eebaa0535dd7f68231ebb9c9"],
  [0x80024160,0x24d60,1296,"09d47414079cdd0b24b4d0996ccb3c767e596d1fe2b2f84f131a690bda1bd667"],
  [0x800248bc,0x254bc,752,"720f89e7b3fbe94ac1e1a4832cb5a60d1fc9aeaec6223e52ff475400db26a112"],
  [0x80024bac,0x257ac,1024,"3642c4327810f86b26709b96f56d51a68e7105bfa68c7c05b5ae87bb3388d1a6"],
  [0x80024fac,0x25bac,1004,"4d138eeb810f86078207f6fe49be06754746265df13dd53b040c08bb69f732b9"],
  [0x80024670,0x25270,76,"83c11e2d9ac904042ed64a02e86255f3658dbc9fb25918e11914d7516222e49b"],
  [0x800119d4,0x125d4,100,"16f975fa49397781cd9b58e4aa565238630d0f6fe321f3c8b74d73f7a6ed66a7"],
  [0x80035d8c,0x3698c,112,"be906bebe9a4f95983cd1bbc44c8d003e5d7350b561b643f4e7f970800ca1a41"],
  [0x80035dfc,0x369fc,240,"6014322e187215e9b5fdfd5c1255c460ff125e05437a8aa195945e229a672290"],
  [0x80014840,0x15440,128,"db639659cdb96153cbe92a818d7f92efd9078c52a01080da4921756341378fd0"],
  [0x8003521c,0x35e1c,16,"da81978ba14dce675f95965010ada14b854c66fa51ad997f1986dc0ac118c81a"],
];
// Metadata-only attestations from the frozen native setup contracts. No game assets are bundled.
const GUARDS:readonly (readonly [number,number,string])[]=[
  [0x252bc,120,"b36b9a8011e096d6786e5a09975adf40a2f53a30d78f1ebce099b1315c778967"],
  [0x25270,76,"83c11e2d9ac904042ed64a02e86255f3658dbc9fb25918e11914d7516222e49b"],
  [0x2528c,8,"afd9cc8757c957aa4833a625777983171c6fbf0302ef11c74871d0b87b89cd97"],
  [0x2529c,8,"91d3f62b153f7e1416a7a52e0dac97fcbda50a23a8e0e5403e88a3996467398f"],
  [0x125d4,100,"16f975fa49397781cd9b58e4aa565238630d0f6fe321f3c8b74d73f7a6ed66a7"],
  [0x125e4,8,"7518cba49b3a1f2cb1bb041ca90a7c415ae2c34f0c7b4351c867403a64a804f4"],
  [0x369fc,240,"6014322e187215e9b5fdfd5c1255c460ff125e05437a8aa195945e229a672290"],
  [0x36a78,8,"9ed8810200cd56791dcbd90e2b9a2992bdd821fe3805ffedb1108285b3adaa28"],
  [0x3698c,112,"be906bebe9a4f95983cd1bbc44c8d003e5d7350b561b643f4e7f970800ca1a41"],
  [0x154f0,312,"ab1ee8c7c6baef7bfe86ec795028fe37c941f927f92ba71729e064a9005f6bc6"],
  [0x41220,116,"5306341d7122fdbbae63d48917c76f7f6c2ee0321e490862302581561bf0474c"],
  [0x35724,52,"0eab8ac0d64b399e5bbb84096877a33a3347d5f7542bf22c8828f60e2319a1a3"],
  [0x35740,8,"2a4c8b79e5773cd154e1af78973b3a5ad87cff80b868adc1e73c5c2b6a62e7d1"],
  [0x35758,244,"7a0ef772c26ace364b44ccb54e2da750c010d306f4a0ce828efeea08399c66b1"],
  [0x357bc,8,"6511d87eeb2851d76c16ed9452733ecfca717ce7ee3ac2f96bca042b321c5844"],
  [0x3580c,8,"00d89ce31de3b4cbb596f3a19036e1c8528df6e76bf9c823cdd74aa603c85928"],
  [0x35924,180,"159920ded21bf0e6487b92c365f96a9d24a2bee6f99f79a552115dfdd60185e3"],
  [0x35610,168,"ec02a994bd22fc676d1dc41269c515800b17a0d7baf6f22d1d3c53403a595ebc"],
  [0x154c0,48,"6ded35b26566e2f334363759c07d862eca07b8a84c2ec9fe6870bf97bc893814"],
  [0x14dc4,84,"79822bca5da191c2bd89d27989bd5d258e993a62675281c943cea897caf24d9d"],
  [0x2a50,96,"8e41cf0dd7288f559d5535debdc7f807389d7dd517b7ece2bedf4e1573931c17"],
  [0x25bac,1004,"4d138eeb810f86078207f6fe49be06754746265df13dd53b040c08bb69f732b9"],
  [0xb1c4,80,"0f5842049608e62a458f580c7c3c10ea13681eb33fd1529593b76e7c0c902277"],
  [0x24d60,1296,"09d47414079cdd0b24b4d0996ccb3c767e596d1fe2b2f84f131a690bda1bd667"],
  [0x24dd4,8,"3a41b63644b8b7f029ebec24f08e5c6aa0bb8591c1e3b1f94416def58c162c26"],
  [0x24de8,8,"9eaac697ca99ea980fddb3e883a1f1bf2bd838d7375f83bfaa7570f3f5268e1a"],
  [0x24dfc,8,"a522aa6ffe8f75598fa8b7d05a0c970c2037765c6b68808753d1e2f467802811"],
  [0x24e10,8,"62ce6a0d3cc790b80e522c2bd49049dcad0491a2ab0997d8a0b352d5e49e790b"],
  [0x24e48,8,"eb41f9a75ff47b58bd283c85545bf7ad9ed53fb04cae2683d7a7783ba4e67923"],
  [0x24eb4,8,"a3ef02ee9199ab91bb016e3d8ffb8abb3e26b6e3bc3dcf7975615b727d32daa2"],
  [0x24eec,8,"b3a04e73db4b61696b36ccfed8893c50787ce3eef4618eefb408136d4e8828fa"],
  [0x24f4c,8,"4d7966cf12704199299cf9cee6e2cea4a52a2c24d1e8efe484251b474cb96696"],
  [0x24f84,8,"ffbc78e2e921446fb83cf0b2f4f8cdf57ea22d818d39bf2ba6c78c227807aa52"],
  [0x251cc,8,"eb61065d8920cdcf5bdeacef54deb462a87b3da7c5cb291354a729b0637bf2f1"],
  [0x251d8,8,"3c588cd4b0b99406eba3e768f788f0b17ec1b81ead9b13cfa8c88a13b965f728"],
  [0x25230,8,"794f4240c9139a840a1c9aac13e7f0f709323c9cc3c84005a27805f9441ff743"],
  [0x25244,8,"77c438c0b80916bdc420b2cb28b7f5203620637e18056385f4f86375ffc28fd6"],
  [0x254bc,752,"720f89e7b3fbe94ac1e1a4832cb5a60d1fc9aeaec6223e52ff475400db26a112"],
  [0x257ac,1024,"3642c4327810f86b26709b96f56d51a68e7105bfa68c7c05b5ae87bb3388d1a6"],
  [0x25864,8,"ee55ee76c1d575ab2739e30ba9a78d8812709df0588413876b6a3963bf351e37"],
  [0x25874,8,"4ac3bdf1851dc5b5bf827f1ad8d5dc3fbf0680b27541c5d76b07eec8a35dfa2f"],
  [0x25890,8,"881732f90110f5f9d7138f40e13dadef59203b8d236360f5a2a59cd150eccbe1"],
  [0x258ac,8,"892e28c9a23ccc9adc8cf54a9f862f3feab8f0b1975528f19277b60a3723c6e1"],
  [0x258bc,8,"640b264f7abd81dccb317a97fa25b3fb6f8a7ed0e9e0c7601836a76d8be7492d"],
  [0x65f828,300,"140cb7bf505e91abae4dfca8c88a6f08cba81fd3eebaa0535dd7f68231ebb9c9"],
  [0x65f834,8,"1a28bc55c8597fddb9713a51beaadd32923798eaab54398e4b2684ada7b758ec"],
  [0x65f844,8,"3e0f0eaa35acee56daae7afcc4ab9cdb834b6d43fb0c011b1540804a9d5fe485"],
  [0x65f890,8,"94e55a21bfba73fe26234145a7b23821c9c4eeb8813ddf25f3eeb9268fd2c27e"],
  [0x65f8c8,8,"c114a9f68f7d89c8d5104f6c8f3d79acccd682f441d0b795ea8d7510bfc6c49a"],
  [0x65f93c,8,"9f1709768425c90d632747241ef6bdc1485626899032437057f383e62984ce0c"],
  [0x35e1c,16,"da81978ba14dce675f95965010ada14b854c66fa51ad997f1986dc0ac118c81a"],
  [0x15440,128,"db639659cdb96153cbe92a818d7f92efd9078c52a01080da4921756341378fd0"],
  [0x15458,8,"40f1a18116a184d9405f9aee8f7909847701d2cf05835f277170273879ec3610"],
  [0x1548c,8,"c2bcacc88b687354e56d7fb9349a313b60c514790e703b5e48c26d6478c1ca80"],
  [0x359d8,48,"186808855c886da1da5f073f5111133c9a0289cc563a27532841afa6f0203538"],
  [0x359e8,8,"422db867891ac3cc408eb1b592a938ea5c45f324fe52919bfaacbb0f0330dfc4"],
  [0x359f0,8,"ed6c9142660c12f1d189d940cee85f893160c7a72a4559fcce56acf617790dce"],
  [0x6dd98,64,"802f688c69b3e10917e709bc1c8ca343ec9f0c4d9ac3ba8dadeb6a3fea2e6c2f"],
  [0x6dd80,24,"6d3b7c2ade4d5e511f35c8e935d8b56a1f19220aacf0c07a8dca332c35e06517"],
  [0x6df50,24,"69127b82bf221db0c4b7efb63c8426992fd7cd05acd9d717940cf1f5c8b0bf8a"],
  [0x64530,8,"a696a1df30f5e74accc030b70e7fee93301ef6c65d3d91b960c28a431a7ee008"],
  [0x6df08,8,"a696a1df30f5e74accc030b70e7fee93301ef6c65d3d91b960c28a431a7ee008"],
  [0x667198,12,"0eaeb1b4e3741e9001bfb469df97e18fbaed62ac5fddcfc2e266ec8d0e989ad3"],
  [0x7cc9c,8,"e0df175f1e0be9851ad0bc4b4bda017df2f162a274ee2413a354f47b6bbc77e7"],
  [0x6dd98,144,"cc234d8b2c4ee3177d4b0c64fee9b40d8848c2a92cb0990f6ff7b15a2f8ad5ea"],
  [0x5c574,152,"56b5bfcb510d04aac9d76be599124a72b5c1ef272f477e94424cc8c352005ba1"],
  [0x6663c0,32,"64fe258af95d2e9e5f054e29e31aa7b1bb598c15deefbd6100e38452615a317a"],
  [0x5e3e80,4,"2dae80dd83fbacdfb20569897dbd49e961c0945a5eed2e1dd3d59140eb941c1f"],
  [0x5e4da0,2,"b35d9708f364a8e3b09f1ef3af3f2c36be29f3007e28cca15ab51a5161d276a0"],
  [0x58010,8,"ef405d93f5555af115bbda963b19ab645ac491c7332d820479ee57a1baa0ac8a"],
  [0x5573c,8,"797f17c0e7c38538591dd865699dc38fe3d2e467929ed5ad75dc96132dc6ec04"],
  [0x6c33c,52,"0734a12dd6c13adcc8180e885a998048403faa32cbdfa844e8d36b7b6e86059c"],
  [0x55698,8,"099a42921a92b68a283a034530cb52efc4c2e0b0c1b26a29fcaeef35f9706866"],
  [0x55510,436,"f2f43b1b1175d308a282d516506d121b33b463c050cd5d27056393ff86461679"],
  [0x57d2c,8,"b8f3ac6c5e9eb741069ba3afb71ebabbf203e27f6c3e4b78c9b5e29d649bd884"],
  [0x59308,8,"26ffa12fac447315e16bee893e59cefe35b770f7d239fcbbe592b26a57684534"],
  [0x6b850,4,"15c20562a19b12dbf7309179802bf3abca68aa7667f51dde341ccc068135e397"],
  [0x69c78,20,"04643d2cd813299fd971e05c6f26224b1ad5b8cec0b43e8a970344151aa0a8c4"],
  [0x6679b8,7,"9cbd24964be491134a4f255506a7c413c199a06ce84686d148d7c78f5cfafd82"],
  [0x6679c0,18,"afd1dcdc5b3dfe5d9a55be5dd6cbfd866e27ef25c64fb6a215018be56184d928"],
  [0x6679d4,11,"99933eec38b3385ee2587f30eefdf9e36287888e2c236a5863583011281a5763"],
  [0x667a14,8,"863aca50f537321551df2cff1c01241d1110996c884e1975093553290d78ebe2"],
  [0x667a1c,7,"b0f7375e1c7ee74bd6ef3211bb2dbc31ca8e624aee61c993962069c5a2759461"],
];
const ALLOCATIONS=new Map<number,number>([[0x80024694,128],[0x800241dc,1156],[0x800241f0,1156],[0x80024204,1156],[0x80024218,1156],[0x80024250,6144],[0x800242bc,3600],[0x80024354,2056]]);

/** Explicit conditional display context, never native live occupancy or admission. */
export interface ProceduralPreviewOptions {arena?:NativeArenaContext;availableObjects?:0|1;preloadResource?:boolean}
export interface ProceduralPreviewEvidence {instructionLimit:number;allocationRequests:number[];chargedBytes:number;workAddress:number;objectAddress:number;vertexBuffers:number[];commandBuffers:number[];executedBodies:number[];readSpans:{address:number;length:number}[]}
export interface ProceduralActorPreviewResult extends NativeActorInitResult {setupEvidence?:ProceduralPreviewEvidence}
interface Region {address:number;bytes:Uint8Array;readonly?:boolean}
export class ProceduralActorMemory implements InitMemory {
  readonly regions:Region[]=[];
  readonly reads=new Map<string,{address:number;length:number}>();
  constructor(readonly reader:RomReader,readonly arena:NativeLinkedArena){}
  read(address:number,length:number):Uint8Array {
    if(!Number.isSafeInteger(address)||address<0||!Number.isSafeInteger(length)||length<0||length>2*1024*1024||address+length>0x100000000)throw new Error("Invalid procedural native read span.");
    this.reads.set(`${address}:${length}`,{address,length});
    const region=this.regions.find(r=>address>=r.address&&address+length<=r.address+r.bytes.length);
    if(region)return region.bytes.slice(address-region.address,address-region.address+length);
    if(address>=DESCRIPTOR&&address+length<=DESCRIPTOR+12)return this.arena.descriptor.slice(address-DESCRIPTOR,address-DESCRIPTOR+length);
    const data=new DataView(this.arena.descriptor.buffer),base=data.getUint32(0),size=data.getUint32(4);
    if(address>=base&&address+length<=base+size)return this.arena.read(address,length);
    let offset:number|undefined;
    if(address>=0x80000400&&address+length<=0x8007e020)offset=address-0x80000000+0xc00;
    if(address>=0x801cb460&&address+length<=0x801d4ce0)offset=0x65e310+address-0x801cb460;
    if(offset!==undefined){this.reader.check(offset,length);return this.reader.bytes.slice(offset,offset+length);}
    throw new Error(`Unmapped procedural native read 0x${address.toString(16)}.`);
  }
  write(address:number,bytes:Uint8Array):void {
    if(!Number.isSafeInteger(address)||address<0||!(bytes instanceof Uint8Array)||address+bytes.length>0x100000000)throw new Error("Invalid procedural native write span.");
    const overlapping=this.regions.filter(r=>address<r.address+r.bytes.length&&address+bytes.length>r.address);
    if(overlapping.some(r=>r.readonly))throw new Error("Procedural write overlaps an immutable resource.");
    const region=overlapping.find(r=>address>=r.address&&address+bytes.length<=r.address+r.bytes.length);
    if(region){region.bytes.set(bytes,address-region.address);return;}
    if(overlapping.length)throw new Error("Procedural write crosses an owned allocation.");
    const data=new DataView(this.arena.descriptor.buffer),base=data.getUint32(0),size=data.getUint32(4);
    if(address>=base&&address+bytes.length<=base+size){this.arena.write(address,bytes);return;}
    throw new Error(`Unmapped procedural native write 0x${address.toString(16)}.`);
  }
}

/** Actual fixed-File15 constructor and finite setup; future callbacks never run. */
export function nativeProceduralActorPreview(reader:RomReader,files:ReadonlyMap<number,RomFile>,input:NativeActorInitInput,waves:Pick<RenderWaves,"wave">&Partial<Pick<RenderWaves,"image">>,options:ProceduralPreviewOptions={}):ProceduralActorPreviewResult|undefined {
  if(input.actorId!==0x07d)return undefined;
  const result:ProceduralActorPreviewResult={bindings:[],status:"unsupported",completed:false,failureKind:"unresolved",diagnostics:[],instructionCount:0,branches:[],deferredCallbacks:[],syntheticMemory:[],readonlyMemory:[]};
  let cpu:InitMachine|undefined;
  try{
    if(!Array.isArray(input.parameters)||input.parameters.length!==3||[0,1,2].some(i=>!Number.isInteger(input.parameters[i])||input.parameters[i]<0||input.parameters[i]>0xffffffff)||![input.position,input.rotation].every(v=>v&&[v.x,v.y,v.z].every(Number.isFinite))||!Number.isInteger(input.unknownHalfword??0)||(input.unknownHalfword??0)<0||(input.unknownHalfword??0)>65535)throw new Error("Malformed procedural actor definition or transform.");
    if(reader.bytes.length!==32*1024*1024||digest(reader.bytes)!==ROM_HASH)throw new Error("Procedural preview requires the mutable canonical US ROM preimage.");
    const nativeFiles=readFileTable(reader.bytes);if(files.size!==nativeFiles.length)throw new Error("Procedural native file map size changed.");
    for(const file of nativeFiles){const supplied=files.get(file.id);if(!supplied||supplied.id!==file.id||supplied.start!==file.start||supplied.end!==file.end||supplied.compressed!==file.compressed)throw new Error("Procedural native file map changed.");}
    for(const [offset,size,hash] of GUARDS)if(digest(reader.bytes.subarray(reader.check(offset,size),offset+size))!==hash)throw new Error("Procedural native body guard changed.");
    if(reader.u32(0x5e3c8c+0x7d*4)!==0x801cc978||reader.i16(0x5e4ca6+0x7d*2)!==25||!waves.image)throw new Error("Procedural fixed15/registry25 or image provider changed.");
    const registryBytes=new Uint8Array(NATIVE_REGISTRY_BYTES);new DataView(registryBytes.buffer).setUint32(4,0x82000000);
    const registry=new NativeResourceRegistry({bankStart:0x82000000,bankEnd:0x83000000,records:registryBytes,allocations:[]});
    if(options.preloadResource!==false){registry.load(0x4cd,id=>waves.image!(id));const owned=registry.snapshot().allocations[0],cached=waves.wave(0x4cd);if(owned.bytes.length!==0x2d10||digest(owned.bytes)!==WAVE_HASH||cached.length!==owned.bytes.length||digest(cached)!==WAVE_HASH)throw new Error("Procedural reconstructed or cached File4CD preimage changed.");}
    const arena=options.arena?new NativeLinkedArena(options.arena):NativeLinkedArena.initialize(DESCRIPTOR,ARENA_BASE,new Uint8Array(0x10000));
    const descriptor=new DataView(arena.descriptor.buffer);if(arena.descriptorAddress!==DESCRIPTOR||descriptor.getUint32(0)!==ARENA_BASE||descriptor.getUint32(4)>0x10000||descriptor.getUint32(8)!==0)throw new Error("Procedural context requires its explicit empty bounded private arena.");
    if(options.availableObjects!==undefined&&options.availableObjects!==0&&options.availableObjects!==1)throw new Error("Procedural object capacity is not explicit.");
    const memory=new ProceduralActorMemory(reader,arena),pointer=(address:number,value:number)=>{const bytes=new Uint8Array(4);new DataView(bytes.buffer).setUint32(0,value);memory.regions.push({address,bytes});};
    memory.regions.push({address:TASK,bytes:new Uint8Array(0xf0)},{address:OBJECT,bytes:reader.bytes.slice(0x5c574,0x5c574+152)},{address:0x813e0000,bytes:new Uint8Array(0x20000)},{address:0x801d4ce0,bytes:new Uint8Array(0x14ca0)},{address:REGISTRY,bytes:registry.records,readonly:true});
    pointer(0x8015c5c8,0x8008ccc0);pointer(0x8016dab4,TASK);pointer(0x8016dac8,options.availableObjects===0?0:OBJECT);pointer(0x8016dadc,0);
    const snapshot=registry.snapshot();for(const allocation of snapshot.allocations)memory.regions.push({address:allocation.address,bytes:allocation.bytes,readonly:true});
    let allocatedObject=false;const requests:number[]=[],executedBodies=new Set<number>();
    cpu=new InitMachine(memory,{instructions:200000,callDepth:64},(pc,m)=>{
      const [a,b,c]=[m.registers[4],m.registers[5],m.registers[6]],ra=m.registers[31];
      if(pc===0x80025b38||pc===0x801cc710)throw new Error("Procedural future callback fence crossed.");
      if(pc===0x801cca20&&m.registers[2]===0)throw new Error("Procedural kind2 pool allocation returned null; stopped before the unchecked constructor dereference.");
      if(pc===0x800148f0){if(a!==DESCRIPTOR||ALLOCATIONS.get(ra)!==b)throw new Error("Unverified procedural arena caller or size.");requests.push(b);const allocated=arena.allocate(b);if(!allocated)throw new Error("Procedural conditional arena capacity exhausted.");m.registers[2]=allocated;m.returnFromIntercept();return true;}
      if(pc===0x80035dfc){if(ra!==0x800119ec||a!==TASK||b!==2||c!==1||allocatedObject)throw new Error("Unverified procedural kind2 object allocation.");allocatedObject=true;}
      if(pc===0x80035d8c&&(ra!==0x80035e80||a!==2))throw new Error("Unverified procedural native free-pool pop caller.");
      if(pc===0x800141c4){if(ra!==0x80014860||a!==0x4cd)throw new Error("Unverified procedural lookup.");m.registers[2]=registry.lookup(a)>>>0;m.returnFromIntercept();return true;}
      if(pc===0x80001e50){if(ra!==0x80014894||a!==0x4cd)throw new Error("Unverified procedural segment lookup.");m.registers[2]=8;m.returnFromIntercept();return true;}
      if(pc===0x80040620){if(![0x800245d4,0x800245e0].includes(ra)||(ra===0x800245d4&&b!==3600)||(ra===0x800245e0&&b!==1816))throw new Error("Unverified procedural cache-maintenance caller.");const work=m.u32(TASK+0xd0),fields=ra===0x800245d4?[0x40,0x44]:[0x48,0x4c];if(!fields.some(field=>a===m.u32(work+field)))throw new Error("Procedural cache-maintenance pointer does not identify its exact buffer.");arena.read(a,b);m.returnFromIntercept();return true;}
      if(pc===0x80024670&&(ra!==0x801cc98c))throw new Error("Unverified procedural work preparation caller.");
      if(pc===0x800246bc&&(ra!==0x800246a4||a!==ARENA_BASE))throw new Error("Unverified procedural work-default caller.");
      if(pc===0x800119d4&&(ra!==0x801cca20||a!==TASK||b!==9))throw new Error("Unverified procedural object constructor caller.");
      if(pc===0x80014840&&(ra!==0x801cc9e8||a!==0x08001d10||b!==0x4cd))throw new Error("Unverified procedural texture resolver caller.");
      if(pc===0x800248bc&&(ra!==0x800242f4||a!==TASK))throw new Error("Unverified procedural vertex builder caller.");
      if(pc===0x80024bac&&(ra!==0x8002438c||a!==TASK))throw new Error("Unverified procedural command builder caller.");
      if(pc===0x80024fac&&(ra!==0x80024c7c||a!==m.u32(TASK+0xd0)))throw new Error("Unverified procedural material builder caller.");
      if(pc===0x8003521c&&!((ra===0x801cca94&&a===0x80024160)||(ra===0x8002464c&&a===0x80025b38)))throw new Error("Unverified procedural callback registration.");
      if(!BODIES.some(([start,,size])=>pc>=start&&pc<start+size))throw new Error(`Procedural execution left its guarded bodies at0x${pc.toString(16)}.`);
      for(const [start,,size] of BODIES)if(pc>=start&&pc<start+size)executedBodies.add(start);
      return false;
    });
    cpu.registers[29]=0x813fff00;cpu.run(0x801cc978,[TASK,0],STOP);
    if(cpu.u32(TASK+0xc)!==0x80024160||cpu.u32(TASK+0x18)!==OBJECT)throw new Error("Procedural constructor did not prepare its exact setup/object.");
    cpu.run(0x80024160,[TASK],STOP);
    const work=cpu.u32(TASK+0xd0),material=cpu.u32(OBJECT+0x30),first=cpu.u32(work+0x40),second=cpu.u32(work+0x44);
    if(requests.length!==10||requests.reduce((sum,n)=>sum+n,0)!==22208||cpu.u32(TASK+0xc)!==0x80025b38||cpu.u32(work+0x20)!==0x801cc710||cpu.u32(OBJECT+0x2c)!==0xc006d308||cpu.u8(OBJECT+4)!==2||cpu.u8(OBJECT+5)!==3||material!==((cpu.u32(work+0x4c)|0x20000000)>>>0))throw new Error("Procedural initial setup output changed.");
    if(digest(memory.read(first,3600))!==digest(memory.read(second,3600)))throw new Error("Procedural initial vertex buffers differ.");
    const commandBuffers=[cpu.u32(work+0x48),cpu.u32(work+0x4c)];
    for(const [index,start] of commandBuffers.entries()){
      let triangles=0,loaded=0,ended=false,textured=false;
      for(let offset=0;offset+8<=2056;offset+=8){const w0=cpu.u32(start+offset),w1=cpu.u32(start+offset+4),op=w0>>>24;
        if(op===0xb8){ended=true;break;}
        if(op===0x06&&w1!==0x8006d198)throw new Error("Procedural material baseline pointer changed.");
        if(op===0xfd){if(w1!==registry.lookup(0x4cd)+0x1d10)throw new Error("Procedural surface texture pointer changed.");textured=true;}
        if(op===0x04){loaded=(w0>>>10)&63;const vertex=([first,second][index]);if(loaded!==30||w1<vertex||w1+loaded*16>vertex+3600)throw new Error("Procedural vertex command exceeds its buffer.");}
        if(op===0xb1){for(const word of [w0&0xffffff,w1])for(const shift of [16,8,0]){const raw=(word>>>shift)&255;if(raw%2||raw/2>=loaded)throw new Error("Procedural triangle cache index is invalid.");}triangles+=2;}
      }
      if(!ended||!textured||triangles!==392)throw new Error("Procedural command buffer lacks its finite392-triangle textured surface.");
    }
    const position={x:cpu.fromBits(cpu.u32(OBJECT+8)),y:cpu.fromBits(cpu.u32(OBJECT+12)),z:cpu.fromBits(cpu.u32(OBJECT+16))},scale={x:cpu.fromBits(cpu.u32(OBJECT+28)),y:cpu.fromBits(cpu.u32(OBJECT+32)),z:cpu.fromBits(cpu.u32(OBJECT+36))},rotation={x:cpu.u16(OBJECT+20),y:cpu.u16(OBJECT+22),z:cpu.u16(OBJECT+24)};
    if(position.x!==10||position.y!==0||position.z!==-300||rotation.x!==256||rotation.y!==0||rotation.z!==0||Object.values(scale).some(n=>n!==Math.fround(0.2)))throw new Error("Procedural native initial TRS changed.");
    const state=arena.snapshot();result.syntheticMemory=memory.regions.filter(r=>!r.readonly&&r.address!==0x813e0000).map(r=>({address:r.address,bytes:r.bytes.slice()}));result.syntheticMemory.push({address:DESCRIPTOR,bytes:state.descriptor},{address:ARENA_BASE,bytes:state.bytes});
    result.readonlyMemory=snapshot.allocations.map(a=>({address:a.address,fileId:a.fileId,byteLength:a.bytes.length}));
    result.bindings.push({identity:0x7d,slot:-1,sourceFileIds:[15,1229],modelPointer:0xc006d308,materialPointer:material,segments:[],position,rotation,scale,positionOffset:{x:position.x-input.position.x,y:position.y-input.position.y,z:position.z-input.position.z},rotationOverrideMask:{x:true,y:true,z:true},animationFrame:0,animationBlendCountdown:0,provenance:["Actual fixedFile15 constructor801CC978 and finite24160 setup; registrycode25 is distinct. Direct procedural object, no registry slot inferred.",`Conditional isolated task/head0, arena80154C64/81010000, one kind2 object and fully decoded File4CD; ${cpu.instructions} offline instructions, no live occupancy/pressure simulation.`],objectIndex:0});
    result.setupEvidence={instructionLimit:200000,allocationRequests:requests,chargedBytes:requests.reduce((n,size)=>n+Math.floor((size+0x4f)/64)*64,0),workAddress:work,objectAddress:OBJECT,vertexBuffers:[first,second],commandBuffers,executedBodies:[...executedBodies],readSpans:[...memory.reads.values()]};
    result.codeFileIds=[15];result.status="conditional";result.failureKind="scene-gated";result.deferredCallbacks=[0x80025b38,0x801cc710];result.diagnostics.push("Conditional initial native procedural surface; the constructor fixes its transform. No future callback or frame ran; first displayed state, later animation and export admission remain unverified.");
  }catch(error){result.diagnostics.push(error instanceof Error?error.message:String(error));}
  if(cpu){result.instructionCount=cpu.instructions;result.branches=cpu.branches;}
  return result;
}
