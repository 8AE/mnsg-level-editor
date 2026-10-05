import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {deflateRawSync} from 'node:zlib';
import {readNrmArchive} from './helpers/nrm-archive';
import path from 'node:path';
import {generatePatch,exportNrm} from '../core/export';
import {defaultModSettings,validateModSettings} from '../shared/mod-settings';
import type {EditorProjectV2,RoomData,ModAttachment} from '../shared/types';
function attachment(name:string,bytes:Uint8Array):ModAttachment{return {name,byteLength:bytes.length,base64:Buffer.from(bytes).toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex'),mediaType:'application/octet-stream'};}
function project():EditorProjectV2 {const id='test-settings',name='Settings fixture';return {format:'mnsg-level-project',version:2,id,name,createdAt:'2026-10-04T00:00:00Z',updatedAt:'2026-10-04T00:00:00Z',rom:{sha256:'a'.repeat(64),normalizedSha256:'b'.repeat(64),title:'MYSTICAL NINJA',gameCode:'NG5E',region:'US',byteLength:33554432,decompressed:true},mod:defaultModSettings({id,name}),authoredRooms:{},roomOverrides:{'1':{actors:{'a':{position:{x:9,y:2,z:3}}},events:{}}}};}
function room():RoomData{return {id:1,name:'Room',actorCount:1,eventCount:0,geometryAvailable:false,warnings:[],events:[],meshes:[],source:{romOffset:0,expectedHex:''},actors:[{id:'a',index:0,actorId:10,name:'Synthetic',position:{x:1,y:2,z:3},rotation:{x:0,y:0,z:0},parameters:[1,2,3],editable:true,sourceKind:'normal',source:{romOffset:0x100,fileId:30,segmentedAddress:0x08000100,expectedHex:'0001000200030000000000000800020000000000'},definitionSource:{romOffset:0x200,fileId:30,segmentedAddress:0x08000200,expectedHex:'000a1234000000010000000200000003'}}]};}
// Independently construct ZIP32 fixtures: no filesystem/archive utility needed.
function zipFixture(files:{name:string;bytes:Buffer;deflate?:boolean;descriptor?:boolean}[]):Buffer {
 const locals:Buffer[]=[],central:Buffer[]=[];let offset=0;
 for(const file of files){
  const name=Buffer.from(file.name),data=file.deflate?deflateRawSync(file.bytes):file.bytes,method=file.deflate?8:0,flags=0x800|(file.descriptor?8:0);
  let crc=0xffffffff;for(const byte of file.bytes){crc^=byte;for(let bit=0;bit<8;bit++)crc=crc&1?(crc>>>1)^0xedb88320:crc>>>1;}crc=(crc^0xffffffff)>>>0;
  const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(flags,6);local.writeUInt16LE(method,8);local.writeUInt16LE(name.length,26);
  if(!file.descriptor){local.writeUInt32LE(crc,14);local.writeUInt32LE(data.length,18);local.writeUInt32LE(file.bytes.length,22);}
  const descriptor=Buffer.alloc(file.descriptor?16:0);if(file.descriptor){descriptor.writeUInt32LE(0x08074b50);descriptor.writeUInt32LE(crc,4);descriptor.writeUInt32LE(data.length,8);descriptor.writeUInt32LE(file.bytes.length,12);}
  const header=Buffer.alloc(46);header.writeUInt32LE(0x02014b50);header.writeUInt16LE(20,4);header.writeUInt16LE(20,6);header.writeUInt16LE(flags,8);header.writeUInt16LE(method,10);header.writeUInt32LE(crc,16);header.writeUInt32LE(data.length,20);header.writeUInt32LE(file.bytes.length,24);header.writeUInt16LE(name.length,28);header.writeUInt32LE(offset,42);
  locals.push(local,name,data,descriptor);central.push(header,name);offset+=local.length+name.length+data.length+descriptor.length;
 }
 const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...locals,directory,end]);
}
test('portable archive inspection checks every stored/deflated entry including Windows data descriptors',()=>{
 const files=[{name:'mod.json',bytes:Buffer.from('{"display_name":"Unicode 🥷"}'),deflate:true,descriptor:true},{name:'thumb.png',bytes:Buffer.from([0x89,0x50,0x4e,0x47,0,255])},{name:'mod_syms.bin',bytes:Buffer.from([0,1,255]),deflate:true},{name:'mod_binary.bin',bytes:Buffer.from([128,0,34])}];
 const zip=zipFixture(files),before=Buffer.from(zip),entries=readNrmArchive(zip);assert.deepEqual(entries,files.map(({name,bytes})=>({name,bytes})));assert.deepEqual(zip,before);assert.equal(JSON.parse(entries[0].bytes.toString('utf8')).display_name,'Unicode 🥷');
 const unsigned=Buffer.from(zip),central=unsigned.readUInt32LE(unsigned.length-6),compressed=unsigned.readUInt32LE(central+20),descriptor=30+Buffer.byteLength(files[0].name)+compressed;
 // Windows archives may omit the optional descriptor signature.
 const withoutSignature=Buffer.concat([unsigned.subarray(0,descriptor),unsigned.subarray(descriptor+4)]);const shiftedCentral=central-4;withoutSignature.writeUInt32LE(shiftedCentral,withoutSignature.length-6);let cursor=shiftedCentral;
 for(let i=0;i<files.length;i++){if(i>0)withoutSignature.writeUInt32LE(withoutSignature.readUInt32LE(cursor+42)-4,cursor+42);cursor+=46+withoutSignature.readUInt16LE(cursor+28);}
 assert.deepEqual(readNrmArchive(withoutSignature),entries);
});
test('portable archive inspection rejects corrupt entries, descriptors, ZIP64 and bounded expansion failures',()=>{
 const stored=zipFixture([{name:'mod.json',bytes:Buffer.from('verified metadata')}]),central=stored.readUInt32LE(stored.length-6),mutate=(fn:(zip:Buffer)=>void)=>{const copy=Buffer.from(stored);fn(copy);assert.throws(()=>readNrmArchive(copy));};
 mutate(zip=>{zip[30+8]^=1;}); // Contents differ from the CRC in both headers.
 mutate(zip=>{zip[30]^=1;}); // Local filename differs from the central directory.
 mutate(zip=>zip.writeUInt32LE(0xffffffff,central+24));
 mutate(zip=>zip.writeUInt32LE(central+1,zip.length-6));
 mutate(zip=>zip.writeUInt16LE(99,central+10));
 assert.throws(()=>readNrmArchive(stored.subarray(0,stored.length-1)));
 assert.throws(()=>readNrmArchive(zipFixture([{name:'thumb.png',bytes:Buffer.from('a')},{name:'thumb.png',bytes:Buffer.from('b')}])),/duplicate/);
 const deflated=zipFixture([{name:'mod.json',bytes:Buffer.alloc(8192,65),deflate:true,descriptor:true}]),deflatedCentral=deflated.readUInt32LE(deflated.length-6),compressed=deflated.readUInt32LE(deflatedCentral+20),descriptor=30+8+compressed;
 const wrongDescriptor=Buffer.from(deflated);wrongDescriptor[descriptor+4]^=1;assert.throws(()=>readNrmArchive(wrongDescriptor),/descriptor/);
 const smallClaim=Buffer.from(deflated);smallClaim.writeUInt32LE(1,deflatedCentral+24);smallClaim.writeUInt32LE(1,descriptor+12);assert.throws(()=>readNrmArchive(smallClaim));
});
test('configured manifest changes preserve generated native patch behavior and expose captured binary files',async()=>{
 const p=project(),before=JSON.stringify(p);p.mod!.manifest.id='configured_mod';p.mod!.inputs.mod_filename='output_name';p.mod!.inputs.elf_path='compiled/room.elf';p.mod!.manifest.native_libraries=[{name:'native',funcs:['exported_api']}];p.mod!.attachments=[attachment('sidecars/native.dll',Buffer.from('not executed')),attachment('notes.dat',Buffer.from('portable data'))];p.mod!.inputs.additional_files=['notes.dat'];const frozen=JSON.stringify(p),result=await generatePatch(p,()=>room());assert.equal(JSON.stringify(p),frozen);assert.notEqual(before,frozen);assert.equal(result.modId,'configured_mod');assert.match(result.files['mod.toml'],/mod_filename = "output_name"/);assert.match(result.files['mod.toml'],/elf_path = "compiled\/room.elf"/);assert.deepEqual(result.binaryFiles['notes.dat'],new Uint8Array(Buffer.from('portable data')));assert.deepEqual(result.nativeLibraryFiles['native.dll'],result.binaryFiles['sidecars/native.dll']);assert.match(result.files['mnsg_level_patch.c'],/func_800141C4_14DC4/);
 const invalid=structuredClone(p);invalid.mod!.attachments[0].sha256='0'.repeat(64);await assert.rejects(generatePatch(invalid,()=>room()),/SHA256/);const foreign=structuredClone(p);foreign.mod!.manifest.game_id='other';await assert.rejects(generatePatch(foreign,()=>room()),/targets MNSG/);
});
const template=process.env.MNSG_EXPORT_TEST_TEMPLATE;
const tools=()=>({templatePath:template!,modToolPath:process.env.MNSG_EXPORT_TEST_MOD_TOOL,clangPath:process.env.MNSG_EXPORT_TEST_CLANG,linkerPath:process.env.MNSG_EXPORT_TEST_LINKER});
async function supportSymbols(kind:'functions'|'data'){const names=kind==='functions'?['mnsg.us.syms.toml','mnsg.syms.toml']:['mnsg.us.datasyms.toml','mnsg.datasyms.toml'];for(const name of names){try{return await readFile(path.join(template!,'Goemon64RecompSyms',name));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}throw Error(`Missing bundled ${kind} symbols: ${names.join(' or ')}`);}
test('real toolchain honors ELF/filename, uploaded symbol TOMLs, option schema and packaged additional bytes',{skip:!template},async t=>{
 const p=project();p.mod!.manifest.id='settings_runtime';p.mod!.manifest.display_name='Portable settings 🥷';p.mod!.manifest.version='2.3.4';p.mod!.manifest.description='All settings with Unicode 🥷 and newline\n';p.mod!.manifest.short_description='Portable project';p.mod!.manifest.authors=['Author One','Author 二'];p.mod!.manifest.minimum_recomp_version='0.1.0';p.mod!.manifest.dependencies=['base:1.2.3'];p.mod!.manifest.optional_dependencies=['optional'];p.mod!.manifest.native_libraries=[{name:'native_api',funcs:['library_function']}];p.mod!.manifest.custom_gamemode=true;p.mod!.manifest.config_options=[{id:'visible',name:'Visible',type:'Enum',options:['Enabled','Disabled'],default:'Disabled'},{id:'speed',name:'Speed',type:'Number',min:0,max:1e20,step:1,default:1e20,precision:2,percent:true},{id:'text',name:'Text',type:'String',default:'Unicode 🥷'}];p.mod!.inputs.elf_path='compiled/native.elf';p.mod!.inputs.mod_filename='different_filename';p.mod!.inputs.func_reference_syms_file='symbols/functions.toml';p.mod!.inputs.data_reference_syms_files=['symbols/data.toml'];p.mod!.inputs.additional_files=['assets/extra.dat'];p.mod!.attachments=[attachment('symbols/functions.toml',await supportSymbols('functions')),attachment('symbols/data.toml',await supportSymbols('data')),attachment('assets/extra.dat',Buffer.from('actual additional bytes')),attachment('native_api.dll',Buffer.from('Captured sidecar only; not executed'))];p.mod!.icon={...attachment('thumb.png',Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMQ0QhoAAAB7QENM6F6eAAAAABJRU5ErkJggg==','base64')),mediaType:'image/png'};const frozen=JSON.stringify(p),out=await exportNrm(p,()=>room(),tools());assert.equal(out.fileName,'different_filename.nrm');assert.match(out.buildLog,/compiled\/native\.elf/);assert.match(out.buildLog,/--no-default-config/);assert.equal(JSON.stringify(p),frozen);t.diagnostic(out.buildLog);
 const entries=readNrmArchive(out.bytes);const entryBytes=(name:string)=>{const matches=entries.filter(e=>e.name===name);assert.equal(matches.length,1,`Exactly one ${name} archive entry`);return matches[0].bytes;};const manifest=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(entryBytes('mod.json')));assert.ok(entryBytes('mod_syms.bin').length>0);assert.ok(entryBytes('mod_binary.bin').length>0);assert.equal(entries.filter(e=>e.name==='thumb.png').length,1);assert.deepEqual(entryBytes('thumb.png'),Buffer.from(p.mod!.icon!.base64,'base64'));assert.equal(manifest.id,'settings_runtime');assert.equal(manifest.display_name,p.mod!.manifest.display_name);assert.equal(manifest.version,'2.3.4');assert.equal(manifest.description,p.mod!.manifest.description);assert.equal(manifest.short_description,p.mod!.manifest.short_description);assert.deepEqual(manifest.authors,p.mod!.manifest.authors);assert.deepEqual(manifest.dependencies,p.mod!.manifest.dependencies);assert.deepEqual(manifest.optional_dependencies,p.mod!.manifest.optional_dependencies);assert.deepEqual(manifest.native_libraries,{native_api:['library_function']});assert.equal(manifest.custom_gamemode,true);assert.deepEqual(out.nativeLibraryFiles['native_api.dll'],new Uint8Array(Buffer.from('Captured sidecar only; not executed')));assert.ok(out.warnings.some(s=>s.includes('ignored')));assert.deepEqual(manifest.config_schema.options,validateModSettings(p.mod!).manifest.config_options);assert.equal(entryBytes('extra.dat').toString('utf8'),'actual additional bytes');
 const bad=structuredClone(p);bad.mod!.attachments[0]=attachment('symbols/functions.toml',Buffer.from('[[section]]\nname="missing"'));await assert.rejects(exportNrm(bad,()=>room(),tools()),/symbol .*missing/);
});

test('legacy 100-character exportable project ID retains its exact historical mod and filename defaults',async()=>{
 const p=project();p.id='a'.repeat(100);delete p.mod;const frozen=JSON.stringify(p),result=await generatePatch(p,()=>room());assert.equal(result.modId,`mnsg_level_${p.id}`);assert.match(result.files['mod.toml'],new RegExp(`mod_filename = "mnsg_level_${p.id}"`));assert.equal(JSON.stringify(p),frozen);
});
