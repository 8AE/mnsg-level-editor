"use client";

import {useRef,useState} from "react";
import {Button} from "@once-ui-system/core";
import type {EditorProject,ModSettings,ModAttachment,ModConfigOption} from "../shared/types";
import {defaultModSettings,validateModSettings,portableModPath,MOD_LIMITS} from "../shared/mod-settings";

export interface ModSettingsPanelProps {project:EditorProject;busy:boolean;onApply:(mod:ModSettings)=>void;onClose:()=>void}
type Tab='Identity'|'Options'|'Files'|'Build inputs';
const MAX_NATIVE_LIBRARIES=64;
const lines=(s:string)=>s.split(/\r?\n/);
const clean=(arr:string[])=>arr.map(v=>v.trim()).filter(Boolean);
type FieldIssue={id:string;tab:Tab;label:string;message:string};
const slug=(text:string)=>text.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
const fieldId=(tab:Tab,label:string,prefix='')=>`mod-${slug(tab)}-${prefix}${slug(label)}`;
function issueFor(candidate:ModSettings,fullMessage:string):FieldIssue {
  const base=defaultModSettings({id:'validation',name:'Validation'});
  const error=(mod:ModSettings)=>{try{validateModSettings(mod);return undefined;}catch(e){return e instanceof Error?e.message:String(e);}};
  const issue=(tab:Tab,label:string,message:string,prefix=''):FieldIssue=>({tab,label,id:fieldId(tab,label,prefix),message});
  const identity:[keyof ModSettings['manifest'],string][]=[['id','Mod ID'],['version','Version'],['display_name','Display name'],['minimum_recomp_version','Minimum recomp version'],['game_id','Game ID'],['authors','Authors'],['short_description','Short description'],['description','Description'],['dependencies','Required dependencies'],['optional_dependencies','Optional dependencies']];
  for(const [key,label] of identity){const isolated=structuredClone(base);Object.assign(isolated.manifest,{[key]:candidate.manifest[key]});const message=error(isolated);if(message)return issue('Identity',label,message);}
  const seenOptions=new Set<string>();
  for(const [index,o] of candidate.manifest.config_options.entries()){
    const prefix=`option-${index}-`,isolated=structuredClone(base);isolated.manifest.config_options=[o];
    if(seenOptions.has(o.id))return issue('Options','Option ID',`Duplicate option ${o.id}.`,prefix);seenOptions.add(o.id);
    const message=error(isolated);if(!message)continue;let label='Option ID';
    if(/Option name/.test(message))label='Name';else if(/description/.test(message))label='Description';else if(/Enum choices|Enum needs/.test(message))label='Choices';else if(/Enum default/.test(message))label='Default label';else if(/String default/.test(message))label='Default';
    else if(o.type==='Number'){
      const explicit=message.match(/Number (min|max|step|default|precision)/)?.[1];
      label=explicit??(o.min>o.max?'min':o.step<=0?'step':!Number.isInteger(o.precision)||o.precision<0||o.precision>15?'precision':'default');
    }
    return issue('Options',label,message,prefix);
  }
  if(candidate.manifest.native_libraries.length>MAX_NATIVE_LIBRARIES&&/^Native libraries exceeds /.test(fullMessage))return {id:'mod-native-libraries-group',tab:'Files',label:'Native libraries',message:fullMessage};
  const seenLibraries=new Set<string>();
  for(const [index,l] of candidate.manifest.native_libraries.entries()){
    const isolated=structuredClone(base);isolated.manifest.native_libraries=[l];const message=error(isolated);
    if(seenLibraries.has(l.name.toLowerCase()))return issue('Files','Library name without extension',`Duplicate native library ${l.name}.`,`library-${index}-`);seenLibraries.add(l.name.toLowerCase());
    if(message)return issue('Files',/function/i.test(message)?'Exported function names':'Library name without extension',message,`library-${index}-`);
  }
  for(const [index,a] of candidate.attachments.entries()){
    try{portableModPath(a.name);}catch(e){return issue('Files','Workspace relative filename',e instanceof Error?e.message:String(e),`attachment-${index}-`);}
    if(fullMessage.includes(`Attachment ${a.name}`))return issue('Files','Workspace relative filename',fullMessage,`attachment-${index}-`);
  }
  if(/Attachment|attachment|icon|PNG|base64|checksum/i.test(fullMessage))return {id:'mod-files-group',tab:'Files',label:'Project files and icon',message:fullMessage};
  if(/Workspace paths/.test(fullMessage)){const hit=candidate.attachments.findIndex(a=>fullMessage.includes(a.name));if(hit>=0)return issue('Files','Workspace relative filename',fullMessage,`attachment-${hit}-`);}
  const inputs:[keyof ModSettings['inputs'],string][]=[['elf_path','ELF output path'],['mod_filename','NRM filename'],['func_reference_syms_file','Function reference symbols'],['data_reference_syms_files','Data reference symbols'],['additional_files','Additional files']];
  for(const [key,label] of inputs){const isolated=structuredClone(base);isolated.attachments=candidate.attachments;isolated.icon=candidate.icon;Object.assign(isolated.inputs,{[key]:candidate.inputs[key]});const message=error(isolated);if(message)return issue('Build inputs',label,message);}
  if(/Symbol input/.test(fullMessage))return issue('Build inputs','Data reference symbols',fullMessage);
  if(/Workspace paths/.test(fullMessage))return issue('Build inputs','ELF output path',fullMessage);
  return {id:'mod-options-group',tab:'Options',label:'Config options',message:fullMessage};
}
export function ModSettingsPanel({project,busy,onApply,onClose}:ModSettingsPanelProps){
  const [draft,setDraft]=useState<ModSettings>(()=>structuredClone(project.version===2&&project.mod?project.mod:defaultModSettings(project)));
  const [tab,setTab]=useState<Tab>('Identity'),[issue,setIssue]=useState<FieldIssue|null>(null),[importing,setImporting]=useState(false),[numbers,setNumbers]=useState<Record<string,string>>({});
  const locked=busy||importing;
  const summaryRef=useRef<HTMLDivElement>(null);
  function update(fn:(mod:ModSettings)=>void){setDraft(old=>{const next=structuredClone(old);fn(next);return next;});}
  function manifest<K extends keyof ModSettings['manifest']>(key:K,value:ModSettings['manifest'][K]){update(m=>{m.manifest[key]=value;});}
  function option(index:number,fn:(o:ModConfigOption)=>void){update(m=>fn(m.manifest.config_options[index]));}
  function field(label:string,value:string,onChange:(s:string)=>void,hint?:string,multiline=false,prefix=''){
    const id=fieldId(tab,label,prefix),invalid=issue?.id===id,described=[hint?`${id}-hint`:'',invalid?`${id}-error`:''].filter(Boolean).join(' ')||undefined;
    const props={id,disabled:locked,'aria-invalid':invalid||undefined,'aria-describedby':described,onBlur:(e:React.FocusEvent<HTMLInputElement|HTMLTextAreaElement>)=>{
      // Action clicks must not move between pointer-down and pointer-up when an
      // inline error disappears. Apply validates; other actions retain the draft.
      if(e.relatedTarget instanceof HTMLElement&&e.relatedTarget.closest('button:not(:disabled)'))return;
      check();
    },onChange:(e:React.ChangeEvent<HTMLInputElement|HTMLTextAreaElement>)=>onChange(e.target.value)};
    return <label className="mod-field" htmlFor={id}><span>{label}</span>{multiline?<textarea {...props} value={value} rows={3}/>:<input {...props} value={value}/>} {hint&&<small id={`${id}-hint`}>{hint}</small>}{invalid&&<span id={`${id}-error`} className="mod-field-error">{issue.message}</span>}</label>;
  }
  const optionField=(index:number,label:string,value:string,onChange:(s:string)=>void,hint?:string,multiline=false)=>field(label,value,onChange,hint,multiline,`option-${index}-`);
  const libraryField=(index:number,label:string,value:string,onChange:(s:string)=>void,hint?:string,multiline=false)=>field(label,value,onChange,hint,multiline,`library-${index}-`);
  const attachmentField=(index:number,label:string,value:string,onChange:(s:string)=>void)=>field(label,value,onChange,undefined,false,`attachment-${index}-`);
  async function importFile(kind:'icon'|'additional'|'symbols'|'native-library'){
    setImporting(true);try{if(!window.mnsg)throw Error('File import requires the desktop application.');const attachment=await window.mnsg.importModFile(kind);if(!attachment)return;if(kind!=='icon'&&draft.attachments.some(a=>a.name.toLowerCase()===attachment.name.toLowerCase()))throw Error('A file with this name is already attached. Remove or rename it first.');update(m=>{if(kind==='icon'){m.icon=attachment;m.inputs.additional_files=m.inputs.additional_files.filter(n=>n!=='thumb.png');m.inputs.additional_files.push('thumb.png');}else{m.attachments.push(attachment);if(kind==='additional')m.inputs.additional_files.push(attachment.name);}});}catch(e){setIssue({id:'mod-files-group',tab:'Files',label:'Project files and icon',message:e instanceof Error?e.message:String(e)});}finally{setImporting(false);}
  }
  function candidate(){const value=structuredClone(draft);for(const [key,text] of Object.entries(numbers)){const [index,name]=key.split(':');const o=value.manifest.config_options[Number(index)];if(o?.type==='Number'&&['min','max','step','default','precision'].includes(name)){const trimmed=text.trim();Object.assign(o,{[name]:/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed)?Number(trimmed):NaN});}}for(const key of ['authors','dependencies','optional_dependencies'] as const)value.manifest[key]=clean(value.manifest[key]);for(const o of value.manifest.config_options)if(o.type==='Enum')o.options=clean(o.options);for(const l of value.manifest.native_libraries)l.funcs=clean(l.funcs);value.inputs.data_reference_syms_files=clean(value.inputs.data_reference_syms_files);value.inputs.additional_files=clean(value.inputs.additional_files);return value;}
  function check(){const value=candidate();try{const canonical=validateModSettings(value);setIssue(null);return {canonical};}catch(e){const next=issueFor(value,e instanceof Error?e.message:String(e));setIssue(next);return {issue:next};}}
  function focusIssue(next:FieldIssue){setTab(next.tab);requestAnimationFrame(()=>document.getElementById(next.id)?.focus());}
  function save(){const result=check();if(result.issue){setTab(result.issue.tab);requestAnimationFrame(()=>summaryRef.current?.focus());return;}try{onApply(result.canonical!);}catch(e){const next=issueFor(candidate(),e instanceof Error?e.message:String(e));setIssue(next);setTab(next.tab);requestAnimationFrame(()=>summaryRef.current?.focus());}}
  function renameAttachment(index:number,name:string){update(m=>{const old=m.attachments[index].name;m.attachments[index].name=name;m.inputs.additional_files=m.inputs.additional_files.map(n=>n===old?name:n);if(m.inputs.func_reference_syms_file===old)m.inputs.func_reference_syms_file=name;m.inputs.data_reference_syms_files=m.inputs.data_reference_syms_files.map(n=>n===old?name:n);});}
  function removeAttachment(a:ModAttachment,index:number){update(m=>{m.attachments.splice(index,1);m.inputs.additional_files=m.inputs.additional_files.filter(n=>n!==a.name);});}
  return <section className="mod-settings-panel" aria-label="Project mod settings">
    <header><div><h2>Project mod settings</h2><p>Saved with this project. Apply changes to include them in project undo and redo.</p></div><Button variant="tertiary" size="s" onClick={onClose} disabled={locked}>Cancel</Button></header>
    <nav aria-label="Mod settings sections">{(['Identity','Options','Files','Build inputs'] as Tab[]).map(name=><button key={name} type="button" aria-pressed={tab===name} onClick={()=>setTab(name)}>{name}</button>)}</nav>
    <div className="mod-settings-content">
      {issue&&<div id="mod-validation-summary" ref={summaryRef} role="alert" tabIndex={-1} className="mod-error"><strong>{issue.label}: </strong>{issue.message}<button type="button" className="mod-error-link" onClick={()=>focusIssue(issue)}>Go to {issue.label} · {issue.tab}</button></div>}
      {tab==='Identity'&&<>
        <div className="mod-field-grid">
          {field('Mod ID',draft.manifest.id,s=>manifest('id',s),'Letters, digits and underscores. Independent from the NRM filename.')}
          {field('Version',draft.manifest.version,s=>manifest('version',s),'major.minor.patch; optional prerelease or build suffix.')}
          {field('Display name',draft.manifest.display_name,s=>manifest('display_name',s))}
          {field('Minimum recomp version',draft.manifest.minimum_recomp_version,s=>manifest('minimum_recomp_version',s))}
          {field('Game ID',draft.manifest.game_id,s=>manifest('game_id',s),'Generated native room patches require mnsg to build.')}
          {field('Authors',draft.manifest.authors.join('\n'),s=>manifest('authors',lines(s)),'One author per line.',true)}
        </div>
        {field('Short description',draft.manifest.short_description,s=>manifest('short_description',s))}
        {field('Description',draft.manifest.description,s=>manifest('description',s),undefined,true)}
        <div className="mod-field-grid">{field('Required dependencies',draft.manifest.dependencies.join('\n'),s=>manifest('dependencies',lines(s)),'One id or id:major.minor.patch per line.',true)}{field('Optional dependencies',draft.manifest.optional_dependencies.join('\n'),s=>manifest('optional_dependencies',lines(s)),undefined,true)}</div>
        <label className="mod-check"><input type="checkbox" checked={draft.manifest.custom_gamemode} disabled={locked} onChange={e=>manifest('custom_gamemode',e.target.checked)}/>Custom game mode</label><p className="mod-hint">Recognized by RecompModTool; the currently supported Goemon runtime ignores this flag.</p>
      </>}
      {tab==='Options'&&<>
        <p id="mod-options-group" tabIndex={-1} aria-invalid={issue?.id==='mod-options-group'||undefined} aria-describedby={issue?.id==='mod-options-group'?'mod-options-group-error':undefined}>These options appear in the game mod menu. Generated room patches do not automatically read their values. The supported Goemon runtime accepts Enum, Number and String.</p>{issue?.id==='mod-options-group'&&<p id="mod-options-group-error" className="mod-field-error">{issue.message}</p>}
        {draft.manifest.config_options.map((o,index)=><fieldset key={index}><legend>Option {index+1} · {o.type}</legend><div className="mod-field-grid">{optionField(index,'Option ID',o.id,s=>option(index,v=>{v.id=s;}))}{optionField(index,'Name',o.name,s=>option(index,v=>{v.name=s;}))}</div>{optionField(index,'Description',o.description??'',s=>option(index,v=>{v.description=s;}))}
          {o.type==='Enum'&&<>{optionField(index,'Choices',o.options.join('\n'),s=>option(index,v=>{if(v.type==='Enum')v.options=lines(s);}),'One unique label per line.',true)}{optionField(index,'Default label',o.default,s=>option(index,v=>{if(v.type==='Enum')v.default=s;}),'Must match a choice exactly.')}</>}
          {o.type==='String'&&optionField(index,'Default',o.default,s=>option(index,v=>{if(v.type==='String')v.default=s;}),undefined,true)}
          {o.type==='Number'&&<><div className="mod-field-grid">{(['min','max','step','default','precision'] as const).map(key=>optionField(index,key,numbers[`${index}:${key}`]??String(o[key]),s=>setNumbers(n=>({...n,[`${index}:${key}`]:s})),key==='precision'?'Integer 0..15.':undefined))}</div><label className="mod-check"><input type="checkbox" checked={o.percent} disabled={locked} onChange={e=>option(index,v=>{if(v.type==='Number')v.percent=e.target.checked;})}/>Display as percent</label></>}
          <Button variant="tertiary" size="s" disabled={locked} onClick={()=>{update(m=>{m.manifest.config_options.splice(index,1);});setNumbers(old=>Object.fromEntries(Object.entries(old).flatMap(([key,value])=>{const [at,name]=key.split(':');const n=Number(at);return n===index?[]:[[`${n>index?n-1:n}:${name}`,value]];})));}}>Remove option</Button>
        </fieldset>)}
        <div className="mod-actions">{(['Enum','Number','String'] as const).map(type=><Button key={type} variant="secondary" size="s" disabled={locked||draft.manifest.config_options.length>=MOD_LIMITS.options} onClick={()=>update(m=>{let n=m.manifest.config_options.length+1;while(m.manifest.config_options.some(o=>o.id===`option_${n}`))n++;const common={id:`option_${n}`,name:`Option ${n}`,description:''};m.manifest.config_options.push(type==='Enum'?{...common,type,options:['Enabled','Disabled'],default:'Enabled'}:type==='Number'?{...common,type,min:0,max:100,step:1,default:0,precision:0,percent:false}:{...common,type,default:''});})}>Add {type}</Button>)}</div>
        <p className="mod-hint">Bool, hidden_from and disabled_from belong to newer runtime schemas and are unavailable with this supported Goemon version. enabled_by_default is not a mod.toml field.</p>
      </>}
      {tab==='Files'&&<>
        <div id="mod-files-group" tabIndex={-1} aria-invalid={issue?.id==='mod-files-group'||undefined} aria-describedby={issue?.id==='mod-files-group'?'mod-files-group-error':undefined}>{issue?.id==='mod-files-group'&&<p id="mod-files-group-error" className="mod-field-error">{issue.message}</p>}</div>
        <h3>Mod icon</h3><div className="mod-actions">{draft.icon&&<img className="mod-icon" src={`data:image/png;base64,${draft.icon.base64}`} alt="Project mod icon"/>}<Button variant="secondary" size="s" disabled={locked} onClick={()=>void importFile('icon')}>{draft.icon?'Replace icon':'Upload icon'}</Button>{draft.icon&&<Button variant="tertiary" size="s" disabled={locked} onClick={()=>update(m=>{delete m.icon;m.inputs.additional_files=m.inputs.additional_files.filter(n=>n!=='thumb.png');})}>Remove icon</Button>}</div><p className="mod-hint">Converted to thumb.png. Maximum 2 MiB and 1 million decoded pixels.</p>
        <h3>Project attachments</h3><div className="mod-actions">{(['additional','symbols','native-library'] as const).map(kind=><Button key={kind} variant="secondary" size="s" disabled={locked} onClick={()=>void importFile(kind)}>Upload {kind==='additional'?'additional file':kind==='symbols'?'symbol TOML':'native library'}</Button>)}</div>
        <p className="mod-hint">Files travel inside the project JSON. Maximum 4 MiB each, 6 MiB total. Additional files are archived by basename; symbol files are build inputs.</p>
        {draft.attachments.map((a,index)=><fieldset key={index}><legend>{a.byteLength.toLocaleString()} bytes</legend>{attachmentField(index,'Workspace relative filename',a.name,s=>renameAttachment(index,s))}<label className="mod-check"><input type="checkbox" checked={draft.inputs.additional_files.includes(a.name)} disabled={locked} onChange={e=>update(m=>{m.inputs.additional_files=m.inputs.additional_files.filter(n=>n!==a.name);if(e.target.checked)m.inputs.additional_files.push(a.name);})}/>Package as an additional file</label><Button variant="tertiary" size="s" disabled={locked} onClick={()=>removeAttachment(a,index)}>Remove file</Button></fieldset>)}
        <h3 id="mod-native-libraries-group" tabIndex={-1} aria-invalid={issue?.id==='mod-native-libraries-group'||undefined} aria-describedby={issue?.id==='mod-native-libraries-group'?'mod-native-libraries-group-error':undefined}>Native libraries</h3>{issue?.id==='mod-native-libraries-group'&&<p id="mod-native-libraries-group-error" className="mod-field-error">{issue.message}</p>}<p>The runtime loads .dll, .dylib or .so files beside the NRM. Uploaded matching libraries are exported as sidecars; filenames do not verify ABI or platform compatibility.</p>
        {draft.manifest.native_libraries.map((l,index)=><fieldset key={index}><legend>Native library {index+1}</legend>{libraryField(index,'Library name without extension',l.name,s=>update(m=>{m.manifest.native_libraries[index].name=s;}))}{libraryField(index,'Exported function names',l.funcs.join('\n'),s=>update(m=>{m.manifest.native_libraries[index].funcs=lines(s);}),undefined,true)}<Button variant="tertiary" size="s" disabled={locked} onClick={()=>update(m=>{m.manifest.native_libraries.splice(index,1);})}>Remove library</Button></fieldset>)}<Button variant="secondary" size="s" disabled={locked||draft.manifest.native_libraries.length>=MAX_NATIVE_LIBRARIES} onClick={()=>update(m=>{if(m.manifest.native_libraries.length>=MAX_NATIVE_LIBRARIES)return;m.manifest.native_libraries.push({name:`library_${m.manifest.native_libraries.length+1}`,funcs:[]});})}>Add native library</Button>
      </>}
      {tab==='Build inputs'&&<>
        <p>All paths are relative to the project-owned build workspace. Host paths and custom executables cannot be supplied by a project.</p>
        {field('ELF output path',draft.inputs.elf_path,s=>update(m=>{m.inputs.elf_path=s;}),'The generated native patch is linked here.')}
        {field('NRM filename',draft.inputs.mod_filename,s=>update(m=>{m.inputs.mod_filename=s;}),'Basename without .nrm; independent from the mod ID.')}
        {field('Function reference symbols',draft.inputs.func_reference_syms_file,s=>update(m=>{m.inputs.func_reference_syms_file=s;}),'Bundled Goemon64RecompSyms/mnsg.syms.toml or an uploaded symbol TOML.')}
        {field('Data reference symbols',draft.inputs.data_reference_syms_files.join('\n'),s=>update(m=>{m.inputs.data_reference_syms_files=lines(s);}),'One bundled or uploaded TOML path per line. Generated native references must resolve.',true)}
        {field('Additional files',draft.inputs.additional_files.join('\n'),s=>update(m=>{m.inputs.additional_files=lines(s);}),'Each path must match a project attachment; thumb.png is managed by icon upload.',true)}
      </>}
    </div>
    <footer><span>{importing?'Importing file…':'Changes take effect after Apply.'}</span><Button variant="primary" size="s" disabled={locked} onClick={save}>Apply settings</Button></footer>
  </section>;
}

export default ModSettingsPanel;
