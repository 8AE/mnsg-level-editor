import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {execFileSync} from 'node:child_process';
import {defaultModSettings,validateModSettings,decodeModAttachment} from '../shared/mod-settings';
import {renderModToml,modExportFiles,validateModAttachmentBytes,validateProjectIcon} from '../core/export/mod-settings';
import {createProject,validateProject} from '../core/project';
import {canonicalProject} from '../components/authoringModel';
import type {ModAttachment,RomIdentity,EditorProjectV2} from '../shared/types';
const rom:RomIdentity={sha256:'a'.repeat(64),normalizedSha256:'b'.repeat(64),title:'MYSTICAL NINJA',gameCode:'NG5E',region:'US',byteLength:33554432,decompressed:true};
function settings(){return defaultModSettings({id:'test-fixture',name:'Project'});}
function attachment(name:string,bytes:Uint8Array,mediaType='application/octet-stream'):ModAttachment{return {name,base64:Buffer.from(bytes).toString('base64'),byteLength:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),mediaType};}
function crc(bytes:Uint8Array){let n=0xffffffff;for(const b of bytes){n^=b;for(let i=0;i<8;i++)n=(n>>>1)^((n&1)?0xedb88320:0);}return (n^0xffffffff)>>>0;}
function chunk(type:string,bytes:Uint8Array){const b=Buffer.alloc(bytes.length+12);b.writeUInt32BE(bytes.length);b.write(type,4);b.set(bytes,8);b.writeUInt32BE(crc(b.subarray(4,bytes.length+8)),bytes.length+8);return b;}
function png(width=1,height=1,filter=0){const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=6;return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.from([filter,20,40,80,128]))),chunk('IEND',Buffer.alloc(0))]);}
test('mod settings migrate old projects without changing UUID, native records or version',()=>{
 const fresh=createProject('Portable',rom);assert.equal(fresh.mod?.manifest.display_name,'Portable');const {mod:_mod,...old}=fresh;
 const migrated=validateProject(old,rom,()=>{throw Error('No room calls');});assert.equal(migrated.id,fresh.id);assert.equal(migrated.version,2);assert.deepEqual((migrated as EditorProjectV2).mod,fresh.mod);assert.deepEqual(old.roomOverrides,migrated.roomOverrides);
 const custom=structuredClone(fresh);custom.mod!.manifest.display_name='Custom mod';assert.deepEqual(canonicalProject(custom).mod,custom.mod);assert.deepEqual(validateProject(custom,rom,()=>{throw Error('No room calls');}),custom);
});
test('TOML round trip preserves all 13+5 fields, Unicode/controls and large finite Number values',()=>{
 const mod=settings();mod.manifest.description='quotes " slash \\ newline\n tab\t nul\0 backspace\b formfeed\f DEL\x7f 🥷';mod.manifest.authors=['One','二'];mod.manifest.dependencies=['base:1.2.3'];mod.manifest.optional_dependencies=['optional'];mod.manifest.custom_gamemode=true;
 mod.manifest.native_libraries=[{name:'native_code',funcs:['native_api']}];mod.manifest.config_options=[{id:'visible',name:'Visibility',type:'Enum',description:'',options:['Enabled','Disabled'],default:'Enabled'},{id:'large',name:'Large',type:'Number',description:'',min:-1e20,max:1e20,step:0.5,default:1e20,precision:3,percent:true},{id:'message',name:'Message',type:'String',description:'text',default:'🦊\0'}];
 const canonical=validateModSettings(mod),toml=renderModToml(canonical);const parsed=JSON.parse(execFileSync('python3',['-c','import tomllib,json,sys;print(json.dumps(tomllib.loads(sys.stdin.read())))'],{input:toml,encoding:'utf8'}));assert.deepEqual(parsed,{manifest:canonical.manifest,inputs:canonical.inputs});assert.equal(Object.keys(parsed.manifest).length,13);assert.equal(Object.keys(parsed.inputs).length,5);assert.match(toml,/100000000000000000000\.0/);
});
test('portable staging rejects host paths, injection, archive collisions and template overwrites',()=>{
 for(const name of ['/tmp/private','../mod','a/../b','C:\\temp\\x','hello\'world','CON.dll','x/y.']){const mod=settings();mod.inputs.elf_path=name;assert.throws(()=>validateModSettings(mod),/relative|ELF/);}
 for(const name of ['project.mnsgproj','build-status.txt','mod.toml/foo','include','thumb.dds','sub/mod.json']){const mod=settings();mod.attachments=[attachment(name,Buffer.from('x'))];assert.throws(()=>validateModSettings(mod),/collid|overlap/);}
 const duplicate=settings();duplicate.attachments=[attachment('one/readme.txt',Buffer.from('1')),attachment('two/readme.txt',Buffer.from('2'))];duplicate.inputs.additional_files=duplicate.attachments.map(a=>a.name);assert.throws(()=>validateModSettings(duplicate),/basenames/);
 const elf=settings();elf.inputs.elf_path='mod.toml';assert.throws(()=>validateModSettings(elf),/ELF/);
 const options=settings();options.manifest.config_options=[{id:'bad',name:'Bad',type:'Enum',options:['A'],default:'B'}];assert.throws(()=>validateModSettings(options),/match a choice/);
});
test('backend rehashes portable bytes and validates effective PNG before open/save/export',()=>{
 const mod=settings();mod.icon=attachment('thumb.png',png(),'image/png');const canonical=validateModSettings(mod);validateModAttachmentBytes(canonical);assert.deepEqual(canonical.inputs.additional_files,['thumb.png']);assert.deepEqual(Buffer.from(decodeModAttachment(canonical.icon!)),png());
 const p=createProject('Icon',rom);p.mod=canonical;assert.deepEqual((validateProject(JSON.parse(JSON.stringify(p)),rom,()=>{throw Error('No rooms');}) as EditorProjectV2).mod,canonical);
 const forged=structuredClone(canonical);forged.icon!.base64=Buffer.from('x').toString('base64');forged.icon!.byteLength=1;assert.throws(()=>validateModAttachmentBytes(forged),/SHA256/);forged.icon!.sha256=createHash('sha256').update('x').digest('hex');assert.throws(()=>modExportFiles({id:p.id,name:p.name,mod:forged}),/PNG/);p.mod=forged;assert.throws(()=>validateProject(p,rom,()=>{throw Error('No rooms');}),/PNG/);
 for(const bad of [png(1025,1025),png(1,1,5),png(2,1),Buffer.concat([png(),Buffer.from('tail')])])assert.throws(()=>validateProjectIcon(bad),/pixels|filter|byte count|end/);
 const checksum=png();checksum[29]^=1;assert.throws(()=>validateProjectIcon(checksum),/checksum/);const invalidType=png();invalidType[12]=0xc9;invalidType.writeUInt32BE(crc(invalidType.subarray(12,29)),29);assert.throws(()=>validateProjectIcon(invalidType),/critical chunk/);
});
test('captured native libraries export beside NRM, icon once, with no architecture assertion',()=>{
 const mod=settings();mod.icon=attachment('thumb.png',png(),'image/png');mod.manifest.native_libraries=[{name:'native',funcs:['api']}];mod.attachments=[attachment('platform/native.dll',Buffer.from('DLL')),attachment('platform/native.so',Buffer.from('SO')),attachment('notes.txt',Buffer.from('Read me'))];mod.inputs.additional_files=['notes.txt'];mod.inputs.mod_filename='distinct_output';const result=modExportFiles({id:'test-fixture',name:'Project',mod},true);assert.equal(result.modId,'mnsg_level_test_fixture');assert.equal(result.fileName,'distinct_output.nrm');assert.deepEqual(Object.keys(result.nativeLibraryFiles).sort(),['native.dll','native.so']);assert.equal(result.settings.inputs.additional_files.filter(n=>n==='thumb.png').length,1);assert.ok(result.warnings.some(n=>n.includes('ABI')));assert.deepEqual(Object.keys(result.binaryFiles).sort(),['notes.txt','platform/native.dll','platform/native.so','thumb.png']);
 const foreign=structuredClone(mod);foreign.manifest.game_id='other';assert.equal(validateModSettings(foreign).manifest.game_id,'other');assert.throws(()=>modExportFiles({id:'id',name:'Name',mod:foreign},true),/targets MNSG/);
});
test('settings reject sparse arrays, invalid Unicode, nonfinite options, excessive attachment budget',()=>{
 const sparse=settings();sparse.manifest.authors=new Array(2);assert.throws(()=>validateModSettings(sparse),/missing/);
 const text=settings();text.manifest.description='\ud800';assert.throws(()=>validateModSettings(text),/Unicode/);
 const number=settings();number.manifest.config_options=[{id:'n',name:'n',type:'Number',min:0,max:1,step:0,default:0,precision:0,percent:false}];assert.throws(()=>validateModSettings(number),/positive step/);
 const excessive=settings();const bytes=Buffer.alloc(4*1024*1024);excessive.attachments=[attachment('one.bin',bytes),attachment('two.bin',bytes)];assert.throws(()=>validateModSettings(excessive),/6MiB/);
});

test('legacy mod defaults preserve old exportable ASCII IDs and safely namespace Unicode project identities',()=>{
 for(const id of ['a'.repeat(100),'Legacy_ID-with-dash','0']){const mod=defaultModSettings({id,name:'Legacy'});assert.equal(validateModSettings(mod).manifest.id,`mnsg_level_${id.replace(/-/g,'_').toLowerCase()}`);assert.equal(mod.inputs.mod_filename,mod.manifest.id);assert.equal(modExportFiles({id,name:'Legacy',mod},true).modId,mod.manifest.id);}
 const fresh=createProject('Legacy Unicode',rom);const {mod:_mod,...legacy}=fresh;legacy.id='../legacy identity 日本語';const frozen=JSON.stringify(legacy);const migrated=validateProject(legacy,rom,()=>{throw Error('No native rooms');});assert.equal(migrated.id,legacy.id);assert.equal(JSON.stringify(legacy),frozen);const again=validateProject(JSON.parse(JSON.stringify(migrated)),rom,()=>{throw Error('No native rooms');});assert.deepEqual(again,migrated);const {authoredRooms:_rooms,...v1Metadata}=legacy;const migratedV1=validateProject({...v1Metadata,version:1},rom,()=>{throw Error('No native rooms');});assert.equal(migratedV1.id,legacy.id);assert.deepEqual((migratedV1 as EditorProjectV2).mod,(migrated as EditorProjectV2).mod);assert.match((migrated as EditorProjectV2).mod!.manifest.id,/^mnsg_level_[a-z0-9_]+_[a-f0-9]{8}$/);assert.notEqual(defaultModSettings({id:'legacy_日本語',name:'One'}).manifest.id,defaultModSettings({id:'legacy_中文',name:'Two'}).manifest.id);
});
