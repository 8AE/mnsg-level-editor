/** Guarded offline initial water setup. No game scheduler, future frame or export admission. */
import {createHash} from 'node:crypto';
import {RomReader} from './binary';
import {readFileTable,type RomFile} from './decompress';
import {RenderWaves} from './waves';
import {InitMachine,type InitMemory} from './actor-init-machine';
import {NativeLinkedArena,NativeResourceRegistry,NATIVE_REGISTRY_BYTES} from './actor-init-resources';
import type {NativeActorInitInput,NativeActorInitResult} from './actor-init';
const ROM_HASH='e40bee20508c2e29e651dca4e47504e40f908f0a2186e34a582784bf5a64be4c';
// Metadata-only native preimage attestations; no ROM images are bundled.
const GUARDS:readonly (readonly [number,number,string])[]=[
  [0x6ae7b0,8,'262c939cc0612f124c34d6fd50c0495a532ae7b7d454a4089456ecaf720e7be9'],
  [0x6ada28,320,'7268fb52917ae3fbd6eaa6f098d46745a9a1d0418e8526c1520bc8344ee250b2'],
  [0x6ae5e8,72,'e8a7fcf53fd5b35f1affaae4426433142aff330751b6ca885986057d6f2d6ad2'],
  [0x6eae0,128,'a29f267eba3b4761d334cdc06361aae42f3465829150e6f4a087d6abce744109'],
  [0x264d0,204,'e0a23cb593b21c650a58c73efcf26127f2f0cf1fda2566f9f321b4b34139a4e0'],
  [0x27be8,892,'542c637597ac749a1d0c06a730fa1a90c661bb6f693f2c03864efb5bbf46d697'],
  [0x6ad498,380,'93fdf4c4b0cf5f302a2506a92fdfe4eea51ddc7e08b2263da7d2b5247c02eda1'],
  [0x6ad74c,732,'77a3c88e53260394f7ab7d6149c64d12e891509e1f5ecd73143c4c419fc1b626'],
  [0x67ad4,12,'8379315d4e95f9b5fb7b6046623fbee6be442d70c10c3ff8374d7b1caf6fea83'],
  [0x67878,260,'7fe5b1d3ee62644b5fa4299fa4070e26bc52995eda1e1c876776a1cac1903675'],
  [0x5655c,16,'636fa7ab9d800a78b8384b0014e3095a89211298eda285d5c703a292be93402e'],
  [0x561e4,8,'72b024af32672a36c5551a5ddbdf68133811d03c5df4836652221891fbd6f2e1'],
  [0x6ea80,168,'208b23489e55b66477d67e13754b0729d8d02ac00e8e56b104c1e55090063861'],
  [0x55f10,4,'76be3f2ac3f846762787e8ecf62e6b2640bd40740ad9d4ccc0028ead7f254102'],
  [0x555e4,8,'7507db61a61c76e3139988ddbd675c296bdcddef047de9715d892cfc97eff25e'],
  [0x5624c,8,'191f586814b81ee256a650adae4ac9b3f3b2e1d8e32cbcc753e222a655cd65b4'],
  [0x5cb128,36,'45b680cdee183101865c28f538209520fd00d9448d6928d96d15814a3458c021'],
  [0x5e7830,44,'576c484f85c117ecb910af82b2642e84fda5329b5038cd0b6d8f93722988d198'],
  [0x14ec4,192,'f28b0b83081ed3f925ee0d8eddbe26f43cfd7211e48cb638e53b48d9068e5ad6'],
  [0x5e8c30,44,'4262f634a2e6f4a066f697f5f8cc17c203c75bcbc542e748b463608fd830dfbc'],
  [0x5eb710,28,'01d8af6218fd84c2d52d39b4c58e54102bbeb15f4939ab1db0b244534edbc911'],
  [0x755d8,8,'819e3a041e79fbedd49d956d4f41e3780167ba84b3a19c89abd6eb4e780880bf'],
  [0x14ebc,556,'a0929620baefe974e70ac3e6c942b89caced2203e113e270c49a2a85012ed751'],
  [0x5eb650,28,'24058269e87ba9cc3f9fe1d50bc69d33f16012abd34c2f1bdca54438996602d5'],
  [0x5e4680,4,'df3f619804a92fdb4057192dc43dd748ea778adc52bc498ce80524c014b81119'],
  [0x5e5208,2,'96a296d224f285c67bee93c30f8a309157f0daa35dc5b87e410b78630a09cfc7'],
  [0x561cc,8,'72b024af32672a36c5551a5ddbdf68133811d03c5df4836652221891fbd6f2e1'],
  [0x56154,8,'1909758b7caa0d8ad1374f1ec59f0cbf79869991dbabdd19b816da464bb670ed'],
  [0x6aaa0,4,'b16e17394fd242d1bba71540b325a54e1651e15eb37a5bbecc2d93d6995b520c'],
  [0x6aa64,4,'2df0180de98c2988227da72fef95890c19a2442ddf8cbc16700fb0b4bd4e113e'],
  [0x5d3f24,468,'76c9fe3491320d18986f66a86353371519086469aace67bf15b39b40bebda64c'],
  [0x5d475c,16,'79a4d02b2bf8d8fae95b3be62ccfb4a093207fa019bf6463d48e6b340d4ab280'],
  [0x5e45b0,4,'990e512ade50e029f22c328fce59f9e0a9d3254808b96d64ec778d7746894280'],
  [0x5e5138,2,'b35d9708f364a8e3b09f1ef3af3f2c36be29f3007e28cca15ab51a5161d276a0'],
  [0x5c8d18,1072,'cc111f36cdf908ac98040ad8284d581087859ab9c479021b1aef3d1d4946e4be'],
  [0x5d2614,100,'dccec1bde6e9334cf3011f6514783b3a0ae5c2fb2e01cd98a8a3c789e7abe944'],
  [0x3615c,152,'442e1df97c941d9d0af3049809d1ee1693d12d8e852d3226d3e1d920e64c06c7'],
  [0x36564,248,'c6bcc3b290a2eaff20725bb1507f816c0453aafe86d8165407ff218c270e385f'],
  [0x35a98,60,'cf2299446d32f7b7d96e8017cf0af8360814d6e91d71e4f67e8ba9ba39e20c24'],
  [0x358bc,104,'108fad174db7e66eb1dd9b37f6cd9349d9f0e26ea0639eb877259e0301e31fa4'],
  [0x14e18,164,'de7ba61c109d5a70a1f0387d5611d04fa3f2aa1610294e1ca7d2da98d28693e4'],
  [0x252bc,120,'b36b9a8011e096d6786e5a09975adf40a2f53a30d78f1ebce099b1315c778967'],
  [0x25270,76,'83c11e2d9ac904042ed64a02e86255f3658dbc9fb25918e11914d7516222e49b'],
  [0x369fc,240,'6014322e187215e9b5fdfd5c1255c460ff125e05437a8aa195945e229a672290'],
  [0x3698c,112,'be906bebe9a4f95983cd1bbc44c8d003e5d7350b561b643f4e7f970800ca1a41'],
  [0x154f0,312,'ab1ee8c7c6baef7bfe86ec795028fe37c941f927f92ba71729e064a9005f6bc6'],
  [0x41220,116,'5306341d7122fdbbae63d48917c76f7f6c2ee0321e490862302581561bf0474c'],
  [0x35758,244,'7a0ef772c26ace364b44ccb54e2da750c010d306f4a0ce828efeea08399c66b1'],
  [0x35924,180,'159920ded21bf0e6487b92c365f96a9d24a2bee6f99f79a552115dfdd60185e3'],
  [0x35610,168,'ec02a994bd22fc676d1dc41269c515800b17a0d7baf6f22d1d3c53403a595ebc'],
  [0x14dc4,84,'79822bca5da191c2bd89d27989bd5d258e993a62675281c943cea897caf24d9d'],
  [0x2a50,96,'8e41cf0dd7288f559d5535debdc7f807389d7dd517b7ece2bedf4e1573931c17'],
  [0xb1c4,80,'0f5842049608e62a458f580c7c3c10ea13681eb33fd1529593b76e7c0c902277'],
  [0x24d60,1296,'09d47414079cdd0b24b4d0996ccb3c767e596d1fe2b2f84f131a690bda1bd667'],
  [0x254bc,752,'720f89e7b3fbe94ac1e1a4832cb5a60d1fc9aeaec6223e52ff475400db26a112'],
  [0x257ac,1024,'3642c4327810f86b26709b96f56d51a68e7105bfa68c7c05b5ae87bb3388d1a6'],
  [0x35e1c,16,'da81978ba14dce675f95965010ada14b854c66fa51ad997f1986dc0ac118c81a'],
  [0x15440,128,'db639659cdb96153cbe92a818d7f92efd9078c52a01080da4921756341378fd0'],
  [0x14714,248,'dd765e24fcbae49c2ced2466aee0497974b9129596388f121f07c44788da3572'],
  [0x150e8,204,'e43e0080b2033eef6e16c8e0f35a1b1dc396e6a6993b4b18d7e9b09fb19a2600'],
  [0x151b4,228,'5b47c9245c8340bca4ffba6541443c4814d5a5706de726b7e3aaf57f26469124'],
  [0x15298,388,'716a2abfed84b58605bc394e865e96d14f2c6523762b3326383283a673d2085f'],
  [0x2800,360,'19e65a3fda8160428dfd0af82f192d84bb03541d3a723958bda1627a82a140d4'],
  [0x29f4,92,'473fb38eff509e62825ece5edadc989c5a9f4ce861b35af8257cda91a2852d37'],
  [0x15970,104,'ce25a545b14377a3f35d2622660d5f586f3785da5f4789ee365b4ff8ff772546'],
  [0x159d8,324,'528b6598e6f5d1e449e9e5c9866e01c3e992172ce1bc56d3d61575c4460c2c56'],
  [0x160b0,604,'24081e63afd9479e91312cfd4a7f93952440cad8a3de25f7e915603fe7cedf3a'],
  [0x1630c,356,'b332a1694b261d98af117d810fdee0e2a2bf045889ede31e99fe44baab90393f'],
  [0x16bdc,128,'015c0ac750cc89c4a7a41e7a8fc54a0117f5fb6906d4f8e7610510b32f6c67cb'],
  [0x158c4,172,'2947033b79736e553ae16b9ebd855d54d66910952478d6f1d3ec5182c5f707c2'],
  [0x16afc,92,'be4caec9401b3ea9d4df71caaf5ef8d0b3783eebb4975a73201caa0b31244467'],
  [0x16b58,132,'37d77f2199638bc01cdfd39cf9422c8311754115b5176137d15a345d5322c3b2'],
  [0x16c5c,196,'76048527b69ed6f6477aad6c22eacdc91ee6699290df3c323a1e2b03b9f720b1'],
  [0x16d20,208,'5d672565a3031d45bfd427fefe6f7a49e8a9189a833b0d5037d56ee6e14006c5'],
  [0x16df0,100,'69122b2ee7baf1b16b33e3269662e3d78e853926485b5139eed3273ae40cf1ab'],
  [0x16e54,160,'57f2278ca89568ee5004f0fe8a8f111ff1da80b1b7c3dec28fc787387d750ec7'],
  [0x16470,320,'f4408390401675d11a7b800c2171f6dfb6384485eb119ed0620c139eeae5b099'],
  [0x16ef4,100,'d98540b09c725b068413fb525ae91b9ed850ee7b4ad5e20de657b8189b8b7716'],
  [0x171c4,156,'7670d9be93bd880f6403487827c2350219f3d199aeb0021f7d4f4f8485627b5b'],
  [0x6ada3c,8,'16397a75121b973477ad186174e276186ab858b0c5da20df7302f33f5e044269'],
  [0x6ada54,8,'b16e0691f747a8eadf39921e6afc75d792185df8be8a1fb4a46269315fc05523'],
  [0x6adaa0,8,'b66c280de21b275da9d27530280e791fc62fc778d81420bde86c9b859358794d'],
  [0x6adad8,8,'ac45d9b8f29c1c9570015b759cb7505e2b320cee81a7d086b7248f77fdb511b8'],
  [0x6adb50,8,'593c4243b9693eeab50ae968977eaeb1ca5614ad65e36373c85c240c078c90a0'],
  [0x6ae600,8,'a99a99483c1d66b03a1ad014e369f6b065888c773724242a86c9c0cc132f963c'],
  [0x6ad5fc,8,'2e6c6af1954d7e13c120303e1a3c3a75eb24a140abcd41b12dd1f1269d56d35a'],
  [0x2654c,8,'7496ef49fde0f56f9e77edbf46574473d0f4dfc04b40a6fb8cafc46ac5e55b1f'],
  [0x27f48,8,'3c96baab7f9f59645fa108b0f719bf9688a5efeed1e1d8c5620ce817086b41ab'],
  [0x5cb134,8,'39ad956ae102a4a761bcdfef22444b23f2d514c08d96066e444e3cb84795b809'],
  [0x6ad8f0,8,'1ce484a373253f2aa0af6edf7690f45bfbf31950f7d485935aa9ec11428ea655'],
  [0x6ad97c,8,'f586d9560ec2b0bafec716ae0ff421c499bfa83171d4735c219eaf05e21e4908'],
  [0x5d3f54,8,'b6ed2c4ce4f18139ae7d7d40d8693c920f924aad7de9623ebc4b5cfeee40c74c'],
  [0x5d405c,8,'01e1d8002e44908aaea8c98aa14ade97446256f8ca78c12834bf5b2b34c28632'],
  [0x5d40bc,8,'d4bdab7951b1537c1f90f25372dfe507e89d0ab652a95c0c0a575c82c6e48676'],
  [0x5d40cc,8,'0f6d1edb978c230d6a8c1097ed3992964593064505bb6c6708b6d0a2e56a5e9a'],
  [0x5d40dc,8,'1bc642259e1366313a38cd3b6f20c60f7f02b098b24563bd6d86e5b0eef369ce'],
  [0x5c8df4,8,'28cc901c57d62e6fb4a1a3bc6055608e8e30ce690dd56734ff082676ae1475fe'],
  [0x5c8e08,8,'68fb3df2a117251ec385ed9b58c0a418768f7fe03d344c83013ce3ad710a9f4d'],
  [0x5c8e18,8,'9357dc10fc9ef60d2143b4fb2f7cb09d89513bbfe509ebf5e9b798605993a1a9'],
  [0x5c8f54,8,'fbe9d6bf0d48cd75849df8560576b927ab9bfab7837369a29888466b9d34a3e0'],
  [0x5c8fbc,8,'ca70819a7d76a6232fe7156227ae240b15616f79cadd95665e545351c0633230'],
  [0x5c8fcc,8,'d1f5b20a5ca3be70fa55e28a7f0e967cbe6f7a9e0efd6ac21d7fd03f5c90ac8c'],
  [0x5c9054,8,'5e4bbd8a273d29c9c89cde98c9305ecddd993d90c4104eb114a558106beb249e'],
  [0x5c9070,8,'7ee7080260a7e909eaf427fdd907c6fcead92254629a3d279fa17e0a1207aff7'],
  [0x5c90d8,8,'f3adcacd8989b38ca7f9790ee16e56c2a5f682d0609233b198c67fa926219f01'],
  [0x5c90e8,8,'d1f5b20a5ca3be70fa55e28a7f0e967cbe6f7a9e0efd6ac21d7fd03f5c90ac8c'],
  [0x5c9108,8,'6ac09084e77bf48955e3e82eff218573f95b8343273cb34c6537f4c7ff56a2c8'],
  [0x3660c,8,'fef5911f736af32cc97b583cc98f1456f19949a08674d0627ff8020bad512757'],
  [0x36170,8,'f9fd37825093c1601a0ee58bcb6308f9b9662d8c47007fc119c3508d8ea32e0c'],
  [0x361d8,8,'0e76102e851d21a0fc5493a665351c8a78446b48c1182fbc688783b2103efc4a'],
  [0x35ab4,8,'2aa82a71bfaf87cd9c31fd95033c8edd5684d7b6463e18f081a352a2cd5c9e3c'],
  [0x35abc,8,'ed6c9142660c12f1d189d940cee85f893160c7a72a4559fcce56acf617790dce'],
  [0x358cc,8,'6ad60dc811504c380d60b616850a2e010e5c42886fe753ef2a9242f5bf94978a'],
  [0x358f0,8,'c96e8f66325c9ff777d24e04bed8f57365a3529d53d67808cb4e4ba463b1775d'],
  [0x35900,8,'d0201ad1e68200a115945754548650f03ccd04b8f66c6a2bd49feadb1592fa71'],
  [0x14e58,8,'137387c966caa8c481c1e4dbefc0a11e824e4b08f8a5482ff7117f61a1dadb65'],
  [0x14e6c,8,'a7b18fd96e40c413c6c686a2aff967251844c9dc7cc4707bc35c34c5c62d65e6'],
  [0x14e84,8,'48f1026aac50be2427251c59c00d84943aecd0ceda1c0a86a419374044977578'],
  [0x58038,8,'9e82e06bc63d15bedd5902f081a714c443396e05aa876eaa9becda59a1250aa5'],
  [0x12be95c,20,'c10e1c37e887559eed44bd282dc1b9d35c292f44f688bddb3cec9f2b178f189c'],
  [0x12be880,16,'f46ec4b0954203838dff1a6588bfa89fdd66327f683e6892f9a21ea3f8554dd7'],
  [0x5eccb4,4,'a82ffdd5dba4fee02944b2893ac097ae0e72ab00edd86f3ebd34d1bf1a81c89d'],
  [0x58558,8,'af5723ff19f57ac89de58370ef21e965c755bf532e92851fd931a831f8dee909'],
  [0x5851c,8,'1e9d30c9d93bfbec4b0a257a36f00725b0847c8c33dfb219170247de22587612'],
  [0x585dc,8,'f1f53214809bcab213627eca044ab36482cc9210f92acf18550a8fa4b84b172f'],
  [0x585e0,8,'b9a6eb3f8c55fb9d2a412940ce10730f5c532112f075059c2ee6e0e0c4557ca5'],
  [0x64580,12,'a6aee82a34bc3e23c61759fff9e880b80beb9d510ec6501af38a55124fdc44b3'],
  [0x65150,8,'95a9b885fe5079ed49475f6c4f7c06e44421f9824d558efeecc8a01095302787'],
  [0x65078,8,'67ddf31828146486616b4cf58da42ad4e96b04c3270f7d15d39755ddfa4df853'],
  [0xf6f6d0,1200,'61ef7c62633916602f9b38aee0dcb9368b2e1284a7f01e05559e45e19e932a0e'],
  [0xf5df30,1424,'2d08445edf2c8bb1a068d0017d77c84bf5a146b070523c977217bab2a100246f'],
  [0xf57340,2432,'b25360455004f414638a030113b0a05b8a5733f2c6f80700d967d990b6286e7c'],
  [0x55510,436,'f2f43b1b1175d308a282d516506d121b33b463c050cd5d27056393ff86461679'],
  [0x5c2478,8,'07e9b2561659c8769bc5a5da388a4980ea6ad599de8ac1861c96f056a6fea104'],
];
const RESOURCES:readonly (readonly [number,number,string])[]=[
  [25,5152,'6a014dacc821da6bde33621997fa9ac1bd7d541f19a4cee72155aecd27115b89'],
  [353,4096,'2f9d635c2372c6a989e4efe735e1acdb6769af60b2d1f207730eb39fb0e38b0f'],
  [338,102784,'d2f395cf318ca151c19a1215ebc5c209c4654340e7bb3f0eff445a5c8190e668'],
];
const MATERIAL:readonly (readonly [number,number|null])[]=[
  [0x6000000,0x8006dee0],
  [0xfc111404,0xfffffffb],
  [0xfa000000,0xd0],
  [0xfd100000,null],
  [0xf5100000,0x7014060],
  [0xe6000000,0x0],
  [0xf3000000,0x77ff080],
  [0xe7000000,0x0],
  [0xf5102000,0x14060],
  [0xf2000005,0xfc07c],
  [0xfd100000,null],
  [0xf5100100,0x7014060],
  [0xe6000000,0x0],
  [0xf3000000,0x77ff080],
  [0xe7000000,0x0],
  [0xf5102100,0x1014060],
  [0xf201e000,0x10fc07c],
];
const digest=(b:Uint8Array|string)=>createHash('sha256').update(b).digest('hex');
const TASK=0x81000000,OBJECT=0x81000100,ARENA=0x81010000,DESC=0x80154c64,CURRENT=0x8016dab4,STOP=0xfffffff0;
const LIMIT=200000,EXPECTED_REQUESTS=[128,1156,1156,1156,1156,6144,3600,3600,2056,2056];
const BODIES:readonly (readonly [number,number])[]=[
  [0x800246bc,120],
  [0x80024670,76],
  [0x80024160,1296],
  [0x800248bc,752],
  [0x80024bac,1024],
  [0x8003521c,16],
  [0x80014840,128],
  [0x8000668,320],
  [0x8001228,72],
  [0x80000d8,380],
  [0x800258d0,204],
  [0x80026fe8,892],
];
const allocationRA=new Map([[0x80024694,128],[0x800241dc,1156],[0x800241f0,1156],[0x80024204,1156],[0x80024218,1156],[0x80024250,6144],[0x800242bc,3600],[0x80024354,2056]]);
interface Region {address:number;bytes:Uint8Array;readonly?:boolean;fileId?:number}
export class WaterActorMemory implements InitMemory {
  readonly regions:Region[]=[];readonly reads=new Map<string,{address:number;size:number}>();
  readonly unknown=[{address:TASK+0x77,size:1},{address:TASK+0x84,size:4},{address:OBJECT+0x44,size:2}];
  constructor(readonly reader:RomReader,readonly files:ReadonlyMap<number,RomFile>,readonly arena:NativeLinkedArena){}
  read(address:number,size:number){
    if(!Number.isSafeInteger(address)||!Number.isSafeInteger(size)||address<0||size<0||size>2*1024*1024||address+size>2**32)throw Error('Invalid full read span');
    this.reads.set(`${address}:${size}`,{address,size});
    if(this.unknown.some(u=>address<u.address+u.size&&address+size>u.address))throw Error(`Unproved live field read ${address.toString(16)}`);
    const region=this.regions.find(r=>address>=r.address&&address+size<=r.address+r.bytes.length);
    if(region)return region.bytes.slice(address-region.address,address-region.address+size);
    if(address>=DESC&&address+size<=DESC+12)return this.arena.descriptor.slice(address-DESC,address-DESC+size);
    if(address>=ARENA&&address+size<=ARENA+this.arena.bytes.length)return this.arena.read(address,size);
    if(address>=0x80000400&&address+size<=0x8007e020){const at=address-0x80000000+0xc00;this.reader.check(at,size);return this.reader.bytes.slice(at,at+size);}
    throw Error(`Unmapped native read ${address.toString(16)}/${size}`);
  }
  write(address:number,bytes:Uint8Array){
    if(!Number.isSafeInteger(address)||address<0||!(bytes instanceof Uint8Array)||address+bytes.length>2**32)throw Error('Invalid full write span');
    if(this.unknown.some(u=>address<u.address+u.size&&address+bytes.length>u.address))throw Error('Write to unconsumed/unproved live field');
    const overlaps=this.regions.filter(r=>address<r.address+r.bytes.length&&address+bytes.length>r.address);
    if(overlaps.some(r=>r.readonly))throw Error('Write overlaps immutable native resource');
    const region=overlaps.find(r=>address>=r.address&&address+bytes.length<=r.address+r.bytes.length);
    if(region){region.bytes.set(bytes,address-region.address);return;}
    if(overlaps.length)throw Error('Write crosses owned native allocation');
    if(address>=ARENA&&address+bytes.length<=ARENA+this.arena.bytes.length){this.arena.write(address,bytes);return;}
    throw Error(`Unmapped native write ${address.toString(16)}`);
  }
}
/** Internal bounded context seams; renderer IPC cannot submit these options. */
export interface WaterPreviewOptions {finiteD8?:boolean;arena?:import('./actor-init-resources').NativeArenaContext;preloadResourceIds?:readonly number[];futureEntryProbe?:0x80025b38|0x0800038c}
export interface WaterSetupSnapshot {label:'constructor-return'|'setup-return'|'finiteD8-return';instructions:number;nextCallback:number;workAddress:number;objectTRS:{position:number[];rotation:number[];scale:number[];bucket:number};flags:number;vertexBuffers:number[];commandBuffers:number[]}
export interface WaterPreviewEvidence {instructionLimit:number;snapshots:WaterSetupSnapshot[];allocationRequests:number[];payloadBytes:number;chargedBytes:number;vertices:{count:number;byteLength:number;sha256:string;bounds:{min:number[];max:number[]}}[];commands:{byteLength:number;triangles:number;sha256:string;materialSha256:string;materialPairs:number[][]}[];cacheFlushes:{caller:number;address:number;size:number}[];executedBodies:number[];readSpans:{address:number;size:number}[]}
export interface WaterActorPreviewResult extends NativeActorInitResult {setupEvidence?:WaterPreviewEvidence;futureProbeEvidence?:{entry:number;beforeInstructions:number;afterInstructions:number;beforeReads:number;afterReads:number;beforeBodies:number[];afterBodies:number[]}}
export function nativeWaterActorPreview(reader:RomReader,files:ReadonlyMap<number,RomFile>,input:NativeActorInitInput,waves:Pick<RenderWaves,'wave'>&Partial<Pick<RenderWaves,'image'>>,options:WaterPreviewOptions={}):WaterActorPreviewResult|undefined {
  if(input.actorId!==0x249)return undefined;
  const result:WaterActorPreviewResult={bindings:[],status:'unsupported',completed:false,failureKind:'unresolved',diagnostics:[],instructionCount:0,branches:[],deferredCallbacks:[],syntheticMemory:[],readonlyMemory:[]};
  let cpu:InitMachine|undefined;
  try{
  if(!Array.isArray(input.parameters)||input.parameters.length!==3||[0,1,2].some(i=>!Number.isInteger(input.parameters[i])||input.parameters[i]<0||input.parameters[i]>0xffffffff)||![input.position,input.rotation].every(v=>v&&[v.x,v.y,v.z].every(n=>Number.isInteger(n)&&n>=-32768&&n<=32767))||!Number.isInteger(input.unknownHalfword??0)||(input.unknownHalfword??0)<0||(input.unknownHalfword??0)>65535||(input.roomId!==undefined&&(!Number.isInteger(input.roomId)||input.roomId<0||input.roomId>799))||(input.templateRoomId!==undefined&&(!Number.isInteger(input.templateRoomId)||input.templateRoomId<0||input.templateRoomId>=620)))throw Error('Malformed native water definition or signed16 placement.');
  if(options.futureEntryProbe!==undefined&&options.futureEntryProbe!==0x80025b38&&options.futureEntryProbe!==0x0800038c)throw Error('Invalid narrow future-entry probe');
  const bytes=reader.bytes,beforeRom=digest(bytes);
  if(bytes.length!==0x2000000||beforeRom!==ROM_HASH)throw Error('Mutable canonical water ROM hash changed');
  for(const [at,size,hash] of GUARDS){reader.check(at,size);if(digest(bytes.subarray(at,at+size))!==hash)throw Error('Native water source guard changed');}
  const nativeFiles=readFileTable(bytes);if(files.size!==nativeFiles.length)throw Error('Native water file map size changed');
  for(const native of nativeFiles){const supplied=files.get(native.id);if(!supplied||supplied.id!==native.id||supplied.start!==native.start||supplied.end!==native.end||supplied.compressed!==native.compressed)throw Error('Native water file map changed');}
  if(!waves.image)throw Error('Native water requires a complete bounded image provider');
  const segment=(id:number)=>{for(let at=0x55510;at<0x556c4;at+=4)if(id<reader.u16(at))return bytes[at+3];throw Error('Unmapped resource interval');};
  const records=new Uint8Array(NATIVE_REGISTRY_BYTES);new DataView(records.buffer).setUint32(4,0x82000000);
  const registry=new NativeResourceRegistry({bankStart:0x82000000,bankEnd:0x83000000,records,allocations:[]});
  // Explicit completed subset, NOT a reconstruction of the canonical room's full live occupancy.
  const requested=options.preloadResourceIds??[25,353,338];if(!Array.isArray(requested)||requested.length>3||new Set(requested).size!==requested.length||requested.some(id=>![25,353,338].includes(id)))throw Error('Invalid explicit water preload subset');
  for(const id of requested){
    registry.load(id,fileId=>waves.image!(fileId));
    const allocation=registry.snapshot().allocations.find(a=>a.fileId===id)!,proof=RESOURCES.find(r=>r[0]===id)!;
    if(allocation.bytes.length!==proof[1]||digest(allocation.bytes)!==proof[2])throw Error('Reconstructed resource preimage changed');
    if(id!==25&&digest(waves.wave(id))!==proof[2])throw Error('Cached RSP resource preimage changed');
  }
  if([25,353,338].some(id=>registry.lookup(id)===-1))throw Error('Required explicit completed resource is absent');
  const arena=options.arena?new NativeLinkedArena(options.arena):NativeLinkedArena.initialize(DESC,ARENA,new Uint8Array(0x10000));const arenaDescriptor=new DataView(arena.descriptor.buffer);if(arena.descriptorAddress!==DESC||arenaDescriptor.getUint32(0)!==ARENA||arenaDescriptor.getUint32(4)>0x10000||arenaDescriptor.getUint32(8)!==0)throw Error('Water requires its explicit empty bounded private arena');const memory=new WaterActorMemory(reader,files,arena);
  const task=new Uint8Array(0xf0),object=bytes.slice(0x5c574,0x5c574+152),tv=new DataView(task.buffer),ov=new DataView(object.buffer);
  // Relevant fields ONLY, derived from guarded native3555C/35964/18A54 stores;
  // detached already-allocated pool object is conditional, full spawner never executes.
  tv.setUint32(0xc,0x08000668);tv.setUint32(0x18,OBJECT);tv.setUint32(0x1c,OBJECT);tv.setUint16(0x28,25);tv.setUint32(0x2c,registry.lookup(25)&0xbfffffff);
  tv.setUint16(0x5c,0x249);tv.setUint16(0x5e,0x249);[0xd0,0xd4,0xd8].forEach((at,i)=>tv.setUint32(at,input.parameters[i]));
  ov.setUint32(0,0);object[4]=2;object[5]=2;ov.setFloat32(8,input.position.x);ov.setFloat32(12,input.position.y);ov.setFloat32(16,input.position.z);
  [20,22,24].forEach((at,i)=>ov.setInt16(at,[input.rotation.x,input.rotation.y,input.rotation.z][i]));[28,32,36].forEach(at=>ov.setFloat32(at,.1));ov.setUint32(0x2c,0);ov.setUint32(0x30,0xc006d920);
  ov.setUint16(0x34,0);ov.setUint16(0x3c,0);[0x4c,0x54,0x5c].forEach(at=>ov.setUint32(at,0));object[0x64]=0;object[0x65]=0;
  memory.regions.push({address:TASK,bytes:task},{address:OBJECT,bytes:object},{address:0x813e0000,bytes:new Uint8Array(0x20000)});
  const word=(address:number,value:number)=>{const b=new Uint8Array(4);new DataView(b.buffer).setUint32(0,value);memory.regions.push({address,bytes:b});};
  word(0x8015c5c8,0x8008ccc0);word(CURRENT,TASK);
  const resourceSnapshot=registry.snapshot();for(const a of resourceSnapshot.allocations)memory.regions.push({address:a.address,bytes:a.bytes,readonly:true,fileId:a.fileId});
  // CPU overlay local08 is a distinct immutable namespace from RSP9/A images.
  const code=resourceSnapshot.allocations.find(a=>a.fileId===25)!;memory.regions.push({address:0x08000000,bytes:code.bytes,readonly:true,fileId:25});
  const requests:number[]=[],executed=new Set<number>(),cacheFlushes:{caller:number;address:number;size:number}[]=[],snapshots:WaterSetupSnapshot[]=[];
  cpu=new InitMachine(memory,{instructions:LIMIT,callDepth:64},(pc,m)=>{
    const [a,b,c]=[m.registers[4],m.registers[5],m.registers[6]],ra=m.registers[31];
    if(pc===0x80025b38||pc===0x0800038c)throw Error('Hard future callback fence');
    if(pc===0x800148f0){if(a!==DESC||allocationRA.get(ra)!==b)throw Error('Unproved arena caller/descriptor/payload');const ptr=arena.allocate(b);if(!ptr)throw Error('Explicit conditional arena exhausted');requests.push(b);m.registers[2]=ptr;m.returnFromIntercept();return true;}
    if(pc===0x800141c4){if(ra!==0x80014860||![353,338].includes(a))throw Error('Unproved lookup caller');m.registers[2]=registry.lookup(a)>>>0;m.returnFromIntercept();return true;}
    if(pc===0x80001e50){if(ra!==0x80014894||![353,338].includes(a))throw Error('Unproved segment caller');m.registers[2]=segment(a);m.returnFromIntercept();return true;}
    if(pc===0x80040620){
      const work=m.u32(TASK+0xd0);
      if(ra===0x80027350){
        // Preserve exactly native26FE8's emitted mask expression, not136B assumption.
        const start=m.registers[14]>>>0,end=m.registers[16]>>>0,expectedAddress=(start&0x8fffffff)>>>0,expectedSize=((end&((0x8fffffff-start)>>>0))&0x8fffffff)>>>0;
        if(a!==expectedAddress||b!==expectedSize||!([0x48,0x4c].map(o=>m.u32(work+o)+8).includes(a)))throw Error('Native material cache-mask arguments changed');
      }else if(ra===0x800245d4){if(b!==3600||![0x40,0x44].some(o=>m.u32(work+o)===a))throw Error('Native vertex cache span changed');}
      else if(ra===0x800245e0){if(b!==1856||![0x48,0x4c].some(o=>m.u32(work+o)===a))throw Error('Native list cache span changed');}
      else throw Error('Unproved cache caller');
      arena.read(a,b);cacheFlushes.push({caller:ra,address:a,size:b});m.returnFromIntercept();return true;
    }
    if(pc===0x8003521c&&!((ra===0x08000798&&a===0x80024160)||(ra===0x80024638&&a===0x080000d8)||(ra===0x08000244&&a===0x80025b38)))throw Error('Unproved callback registration');
    if(pc===0x80024670&&ra!==0x08000684)throw Error('Unproved work constructor caller');
    if(pc===0x800246bc&&(ra!==0x800246a4||a!==ARENA))throw Error('Unproved native default work caller');
    if(pc===0x80014840&&!((ra===0x080006e8&&a===0x09000000&&b===353)||(ra===0x08001248&&a===0x0a00c980&&b===338)))throw Error('Unproved resource pointer caller');
    if(pc===0x08001228&&ra!==0x08000720)throw Error('Unproved auxiliary pointer helper');
    if(pc===0x800248bc&&(ra!==0x800242f4||a!==TASK))throw Error('Unproved vertex builder caller');
    if(pc===0x80024bac&&(ra!==0x8002438c||a!==TASK))throw Error('Unproved list builder caller');
    if(pc===0x800258d0&&(ra!==0x80024c6c||a!==m.u32(TASK+0xd0)))throw Error('Unproved selected material builder');
    if(pc===0x80026fe8){const work=m.u32(TASK+0xd0);if(![0x48,0x4c].some(o=>a===m.u32(work+o)+8))throw Error("Unproved material destination");const expected=[null,0xd0,0x8006dee0,2,0x100,registry.lookup(353),64,32,0,5,30,0,6,5];for(let i=1;i<expected.length;i++)if(m.argument(i)!==expected[i])throw Error(`Unproved native tile-builder argument${i}`);if(ra!==0x80025954)throw Error('Unproved tile builder caller');}
    const body=BODIES.find(([start,size])=>pc>=start&&pc<start+size);if(!body)throw Error(`Left complete approved native bodies ${pc.toString(16)}`);executed.add(body[0]);return false;
  });
  cpu.registers[29]=0x813fff00;
  const machine=cpu;
  const capture=(label:WaterSetupSnapshot['label'])=>{
    if([8,12,16].some((offset,axis)=>machine.fromBits(machine.u32(OBJECT+offset))!==[input.position.x,input.position.y,input.position.z][axis])||[20,22,24].some((offset,axis)=>((machine.u16(OBJECT+offset)<<16)>>16)!==[input.rotation.x,input.rotation.y,input.rotation.z][axis])||[28,32,36].some(offset=>machine.u32(OBJECT+offset)!==0x3e23d70a)||machine.u8(OBJECT+5)!==5)throw Error(`Exact native returned TRS/bucket changed at ${label}`);
    const work=machine.u32(TASK+0xd0);snapshots.push({label,instructions:machine.instructions,nextCallback:machine.u32(TASK+0xc),workAddress:work,objectTRS:{position:[8,12,16].map(o=>machine.fromBits(machine.u32(OBJECT+o))),rotation:[20,22,24].map(o=>machine.u16(OBJECT+o)),scale:[28,32,36].map(o=>machine.fromBits(machine.u32(OBJECT+o))),bucket:machine.u8(OBJECT+5)},flags:machine.u32(work),vertexBuffers:[0x40,0x44].map(o=>machine.u32(work+o)),commandBuffers:[0x48,0x4c].map(o=>machine.u32(work+o))});};
  machine.run(0x08000668,[TASK,OBJECT],STOP);capture('constructor-return');if(machine.u32(TASK+0xc)!==0x80024160)throw Error('Unexpected setup callback');
  machine.run(0x80024160,[TASK],STOP);capture('setup-return');if(machine.u32(TASK+0xc)!==0x080000d8)throw Error('Unexpected finite D8 callback');
  const work=machine.u32(TASK+0xd0),vtx=[0x40,0x44].map(o=>machine.u32(work+o)),lists=[0x48,0x4c].map(o=>machine.u32(work+o)),vtxBefore=vtx.map(a=>digest(memory.read(a,3600)));
  if(machine.u32(OBJECT+0x2c)!==0xc006d308||machine.u32(OBJECT+0x30)!==((lists[1]|0x20000000)>>>0))throw Error('Exact native initial root/second-list material binding changed');
  if(options.finiteD8!==false){machine.run(0x080000d8,[TASK],STOP);capture('finiteD8-return');if(machine.u32(TASK+0xc)!==0x80025b38)throw Error('Unexpected future callback');}
  if(JSON.stringify(requests)!==JSON.stringify(EXPECTED_REQUESTS))throw Error('Allocation request sequence changed');
  const vertices=vtx.map((a,i)=>{const bytes=memory.read(a,3600),d=new DataView(bytes.buffer);if(digest(bytes)!==vtxBefore[i])throw Error('Finite D8 changed flat vertices');const xyz=Array.from({length:225},(_,i)=>[d.getInt16(i*16),d.getInt16(i*16+2),d.getInt16(i*16+4)]);if(xyz.some(v=>v[1]!==0))throw Error('Initial vertex Y was not flat');return {count:225,byteLength:bytes.length,sha256:digest(bytes),bounds:{min:[0,1,2].map(i=>Math.min(...xyz.map(v=>v[i]))),max:[0,1,2].map(i=>Math.max(...xyz.map(v=>v[i])))}};});
  const commands=lists.map((a,i)=>{let triangles=0,length=0;const pairs:number[][]=[];for(let at=0;at<2056;at+=8){const w0=machine.u32(a+at),w1=machine.u32(a+at+4);pairs.push([w0,w1]);if(w0>>>24===0xb1)triangles+=2;if(w0>>>24===0xb8){length=at+8;break;}}if(triangles!==392||length!==1856)throw Error('Native finite generated list inventory changed');const material=memory.read(a+8,136),materialPairs=Array.from({length:17},(_,n)=>[new DataView(material.buffer).getUint32(n*8),new DataView(material.buffer).getUint32(n*8+4)]);for(let pair=0;pair<17;pair++){const expected=MATERIAL[pair],expectedW1=expected[1]===null?registry.lookup(353):expected[1];if(materialPairs[pair][0]!==expected[0]||materialPairs[pair][1]!==expectedW1)throw Error(`Exact native material pair${pair} changed`);}return {byteLength:length,triangles,sha256:digest(memory.read(a,length)),materialSha256:digest(material),materialPairs};});
  if(options.finiteD8!==false){const field=machine.u32(work+0x58);for(const offset of [504,572,508,576])if(machine.u32(field+offset)!==0x43480000)throw Error('Native finite D8 four-cell200 stores changed');}
  for(const at of [0x800c7a8e,0x800c7a72])if([...memory.reads.values()].some(s=>at>=s.address&&at<s.address+s.size))throw Error('Unexpected future frame read');
  const untouched=beforeRom===digest(bytes)&&resourceSnapshot.allocations.every(a=>digest(a.bytes)===RESOURCES.find(r=>r[0]===a.fileId)![2]);if(!untouched)throw Error('ROM/resource mutation');
  if(options.futureEntryProbe!==undefined){
    const beforeInstructions=machine.instructions,beforeReads=memory.reads.size,beforeBodies=[...executed];
    try{machine.run(options.futureEntryProbe,[TASK],STOP);throw Error('Future-entry probe escaped its hard fence');}
    catch(error){if(!(error instanceof Error)||error.message!=='Hard future callback fence')throw error;
      throw Object.assign(error,{futureProbeEvidence:{entry:options.futureEntryProbe,beforeInstructions,afterInstructions:machine.instructions,beforeReads,afterReads:memory.reads.size,beforeBodies,afterBodies:[...executed]}});}
  }
  const state=arena.snapshot();
  result.codeFileIds=[25];result.readonlyMemory=resourceSnapshot.allocations.map(a=>({address:a.address,fileId:a.fileId,byteLength:a.bytes.length}));
  result.syntheticMemory=memory.regions.filter(r=>!r.readonly&&r.address!==0x813e0000).map(r=>({address:r.address,bytes:r.bytes.slice()}));result.syntheticMemory.push({address:DESC,bytes:state.descriptor},{address:ARENA,bytes:state.bytes});
  result.bindings.push({identity:0x249,slot:-1,sourceFileIds:[25,338,353],modelPointer:machine.u32(OBJECT+0x2c),materialPointer:machine.u32(OBJECT+0x30),segments:[],position:{...input.position},rotation:{...input.rotation},scale:{x:machine.fromBits(machine.u32(OBJECT+28)),y:machine.fromBits(machine.u32(OBJECT+32)),z:machine.fromBits(machine.u32(OBJECT+36))},positionOffset:{x:0,y:0,z:0},rotationOverrideMask:{x:false,y:false,z:false},animationFrame:0,animationBlendCountdown:0,objectIndex:0,provenance:[`Actual File25 constructor08000668, native24160 finite setup; ${options.finiteD8===false?'D8 remains pending':'completeD8 field initialization'}. Direct procedural object, no registry slot inferred.`,`Conditional detached kind2 native-template object, fresh prepared task, empty owned linked arena and completed25/353/338 resource subset; ${machine.instructions} offline instructions. Placement retained; native constructor scale0.16; no live occupancy, frame or PIC scratch-pressure parity.`]});
  result.status='conditional';result.failureKind='scene-gated';result.deferredCallbacks=[machine.u32(TASK+0xc),0x0800038c];result.diagnostics.push('Conditional initial native water surface. Placement is retained with native constructor scale; the first displayed state, animated waves, live scene readiness and export admission remain unverified.');
  result.setupEvidence={instructionLimit:LIMIT,snapshots,allocationRequests:requests,payloadBytes:22208,chargedBytes:22784,vertices,commands,cacheFlushes,executedBodies:[...executed],readSpans:[...memory.reads.values()]};
  }catch(error){result.diagnostics.push(error instanceof Error?error.message:String(error));if(error instanceof Error&&'futureProbeEvidence' in error)result.futureProbeEvidence=(error as Error&{futureProbeEvidence:NonNullable<WaterActorPreviewResult['futureProbeEvidence']>}).futureProbeEvidence;}
  if(cpu){result.instructionCount=cpu.instructions;result.branches=cpu.branches;}
  return result;
}
