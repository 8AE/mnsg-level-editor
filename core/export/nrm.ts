import { execFile } from "node:child_process";
import { access, copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { EditorProject, RoomData, ToolchainStatus } from "../../shared/types";
import { generatePatch } from "./patch";
import {defaultSymbolKind,modExportFiles} from "./mod-settings";
import type { GetGeometryTranslation } from "./geometry";
import type {GetAuthoringExportContext} from "./authoring";

/** Paths are selected in the trusted desktop process, never supplied by a project. */
export interface ToolchainConfig {
  templatePath: string;
  clangPath?: string;
  linkerPath?: string;
  modToolPath?: string;
}
interface ResolvedTools { clang: string; linker: string; modTool: string; header: string; functions: string; data: string }

async function firstExisting(candidates: string[], executable = false): Promise<string | undefined> {
  for (const candidate of candidates) {
    try { await access(candidate, executable && process.platform !== "win32" ? constants.X_OK : constants.R_OK); return candidate; } catch { /* Try the next installation. */ }
  }
  return undefined;
}
function executableCandidates(name: string): string[] {
  const suffix = process.platform === "win32" ? ".exe" : "";
  return [
    `/opt/homebrew/opt/${name === "ld.lld" ? "lld" : "llvm"}/bin/${name}`,
    `/usr/local/opt/${name === "ld.lld" ? "lld" : "llvm"}/bin/${name}`,
    ...((process.env.PATH ?? "").split(path.delimiter).filter(Boolean).map(dir => path.join(dir, name + suffix))),
    ...(process.platform === "win32" ? [path.join(process.env.ProgramFiles ?? "C:\\Program Files", "LLVM", "bin", name + suffix)] : []),
  ];
}
async function resolveTools(config: ToolchainConfig): Promise<{ tools?: ResolvedTools; missing: string[] }> {
  const template = path.resolve(config.templatePath);
  const [clang, linker, modTool, header, functions, data] = await Promise.all([
    firstExisting(config.clangPath ? [config.clangPath] : executableCandidates("clang"), true),
    firstExisting(config.linkerPath ? [config.linkerPath] : executableCandidates("ld.lld"), true),
    firstExisting(config.modToolPath ? [config.modToolPath] : [path.join(template, process.platform === "win32" ? "RecompModTool.exe" : "RecompModTool"), ...executableCandidates("RecompModTool")], true),
    firstExisting([path.join(template, "include/modding.h"), path.join(template, "include/platform/modding.h")]),
    firstExisting([path.join(template, "Goemon64RecompSyms/mnsg.us.syms.toml"), path.join(template, "Goemon64RecompSyms/mnsg.syms.toml")]),
    firstExisting([path.join(template, "Goemon64RecompSyms/mnsg.us.datasyms.toml"), path.join(template, "Goemon64RecompSyms/mnsg.datasyms.toml")]),
  ]);
  const missing = [[clang, "LLVM Clang with the MIPS target"], [linker, "LLVM ld.lld"], [modTool, "RecompModTool"], [header, "template include/modding.h"], [functions, "template MNSG function symbols"], [data, "template MNSG data symbols"]].filter(([file]) => !file).map(([, label]) => label!);
  return missing.length ? { missing } : { missing, tools: { clang: clang!, linker: linker!, modTool: modTool!, header: header!, functions: functions!, data: data! } };
}
/** Compilers cannot inherit host include/search/config injection from the editor process. */
function buildEnvironment():NodeJS.ProcessEnv {
  const env:NodeJS.ProcessEnv={NODE_ENV:'production'};
  for(const key of ['SystemRoot','WINDIR','TEMP','TMP','HOME','USERPROFILE','LANG'])if(process.env[key])env[key]=process.env[key];
  env.PATH=process.platform==='win32'?[path.join(process.env.SystemRoot??'C:\\Windows','System32'),path.join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0')].join(path.delimiter):'/usr/bin:/bin';
  return env;
}
function run(executable: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // execFile uses an argument vector. Project strings never enter a shell.
    execFile(executable, args, { cwd, env: buildEnvironment(), timeout: 120_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      const command = [executable, ...args].map(value => JSON.stringify(value)).join(" ");
      const log = `$ ${command}\n${stdout}${stderr}`;
      if (error) reject(new Error(`Mod build failed (${error.message}).\n${log}`)); else resolve(log);
    });
  });
}
export async function inspectToolchain(config?: ToolchainConfig): Promise<ToolchainStatus> {
  if (!config?.templatePath) return { configured: false, ready: false, missing: ["Choose an initialized MNSGRecompModTemplate checkout, LLVM, and RecompModTool"], warnings: [] };
  const resolved = await resolveTools(config);
  if (!resolved.tools) return { configured: true, ready: false, missing: resolved.missing, warnings: [] };
  try {
    await verifyTools(resolved.tools);
    return { configured: true, ready: true, label: path.basename(config.templatePath), missing: [], warnings: ["A successful build does not verify the patch in Goemon64Recomp."] };
  } catch (error) { return { configured: true, ready: false, missing: [error instanceof Error ? error.message : String(error)], warnings: [] }; }
}
async function verifyTools(tools: ResolvedTools): Promise<void> {
  const [targets, functions, data, header] = await Promise.all([run(tools.clang, ["--print-targets"], tmpdir()), readFile(tools.functions, "utf8"), readFile(tools.data, "utf8"), readFile(tools.header, "utf8")]);
  if (!/\bmips\b/.test(targets)) throw new Error("Selected Clang has no MIPS target. On macOS choose Homebrew LLVM; Apple Clang cannot compile this mod.");
  for (const symbol of ["func_8020D848_5C8D18", "func_80014840_15440", "func_800141C4_14DC4", "func_801F8C4C_5B4B5C", "func_801F95D8_5B54E8"]) {
    if (!functions.includes(`name = "${symbol}"`)) throw new Error(`Incompatible MNSG symbols: missing ${symbol}. Initialize the template submodules or use a compatible US symbol checkout.`);
  }
  for (const symbol of ["D_800C7AB2", "D_80231300_5EC7D0"]) if (!data.includes(`name = "${symbol}"`)) throw new Error(`Incompatible MNSG data symbols: missing ${symbol}.`);
  if (!header.includes(".recomp_hook.")) throw new Error("The template modding.h lacks RECOMP_HOOK support.");
}

export async function exportNrm(project: EditorProject, loadRoom: (id: number) => RoomData | Promise<RoomData>, config: ToolchainConfig, getTranslation?: GetGeometryTranslation,getAuthoringContext?:GetAuthoringExportContext): Promise<{ bytes: Uint8Array; fileName: string; buildLog: string; warnings: string[]; nativeLibraryFiles:Record<string,Uint8Array> }> {
  const generated = await generatePatch(project, loadRoom, getTranslation,getAuthoringContext);
  const resolved = await resolveTools(config);
  if (!resolved.tools) throw new Error(`Cannot build an NRM. Configure: ${resolved.missing.join(", ")}.`);
  const tools = resolved.tools;
  await verifyTools(tools);
  const mod=modExportFiles({...project,mod:project.version===2?project.mod:undefined},true);
  const symbolFiles:Record<string,string>={};
  async function symbolText(name:string,kind:'functions'|'data') {
    const uploaded=generated.binaryFiles[name];
    if(uploaded)return new TextDecoder('utf-8',{fatal:true}).decode(uploaded);
    if(defaultSymbolKind(name)!==kind)throw Error(`Upload ${name} as a ${kind} symbol TOML attachment, or select a bundled MNSG symbol alias.`);
    const value=await readFile(kind==='functions'?tools.functions:tools.data,'utf8');symbolFiles[name]=value;return value;
  }
  const functionSymbols=await symbolText(mod.settings.inputs.func_reference_syms_file,'functions');
  const dataSymbols=(await Promise.all(mod.settings.inputs.data_reference_syms_files.map(name=>symbolText(name,'data')))).join('\n');
  const payload = generated.files["mnsg_level_patch.c"];
  for (const symbol of new Set(payload.match(/\b(?:func_[A-Za-z0-9_]+|D_[A-Za-z0-9_]+)\b/g) ?? [])) {
    const reference = symbol.startsWith("func_") ? functionSymbols : dataSymbols;
    if (!reference.includes(`name = "${symbol}"`)) throw new Error(`Compatible native symbol ${symbol} is missing from the selected template. No NRM was emitted.`);
  }
  const directory = await mkdtemp(path.join(tmpdir(), "mnsg-level-export-"));
  try {
    async function stage(name:string,contents:string|Uint8Array) {const file=path.join(directory,name);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,contents);}
    await mkdir(path.join(directory,'build'),{recursive:true});
    await mkdir(path.join(directory,'include'),{recursive:true});
    await mkdir(path.dirname(path.join(directory,mod.settings.inputs.elf_path)),{recursive:true});
    for(const [name,contents] of Object.entries(generated.files))await stage(name,contents);
    for(const [name,contents] of Object.entries(generated.binaryFiles))await stage(name,contents);
    for(const [name,contents] of Object.entries(symbolFiles))await stage(name,contents);
    await copyFile(tools.header,path.join(directory,'include/modding.h'));
    let buildLog = await run(tools.clang, ["--no-default-config", "-target", "mips", "-mips2", "-mabi=32", "-O2", "-G0", "-mno-abicalls", "-mno-odd-spreg", "-mno-check-zero-division", "-fomit-frame-pointer", "-fno-builtin", "-fno-jump-tables", "-Wall", "-Wextra", "-Werror", "-nostdinc", "-I", "include", "-c", "mnsg_level_patch.c", "-o", "build/mod.o"], directory);
    buildLog += await run(tools.linker, ["build/mod.o", "-nostdlib", "-T", "mod.ld", "--unresolved-symbols=ignore-all", "--emit-relocs", "-e", "0", "--no-nmagic", "-o", mod.settings.inputs.elf_path], directory);
    buildLog += await run(tools.modTool, ["mod.toml", "build"], directory);
    let emitted:Record<string,unknown>;
    try {emitted=JSON.parse(await readFile(path.join(directory,'build/mod.json'),'utf8')) as Record<string,unknown>;}catch {throw Error('RecompModTool emitted invalid mod.json. The managed tool must support the requested metadata; no NRM was emitted.');}
    for(const key of ['id','version','display_name','game_id','minimum_recomp_version'] as const)if(emitted[key]!==mod.settings.manifest[key])throw Error(`RecompModTool changed requested manifest.${key}; no NRM was emitted.`);
    const fileName = mod.fileName;
    const bytes = new Uint8Array(await readFile(path.join(directory, "build", fileName)));
    if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new Error("RecompModTool did not produce an NRM ZIP archive.");
    return { bytes, fileName, buildLog, warnings: generated.warnings, nativeLibraryFiles:generated.nativeLibraryFiles };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
