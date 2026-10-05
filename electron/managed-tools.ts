import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join, resolve, sep } from "node:path";
import { tmpdir, release } from "node:os";
import { inflateRawSync } from "node:zlib";
import type { ToolchainStatus } from "../shared/types";
import type { ToolchainConfig } from "../core/export";
import { atomicWrite, readJson } from "./storage";

export interface ManagedToolsManifest {
  format: "mnsg-managed-tools"; version: 1; bundleId: string;
  platform: "darwin" | "win32"; arch: "arm64" | "x64";
  files: { path: string; sha256: string; byteLength: number; executable: boolean }[];
  tools: { clang: string; linker: string; modTool: string };
  support: { header: string; functions: string; data: string };
}
function exact(value: unknown, keys: string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw Error(`${label} must be a plain object.`);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== [...keys].sort().join(",")) throw Error(`${label} contains missing or unknown fields.`);
  return record;
}
export function managedRelativePath(value: unknown): string {
  if (typeof value !== "string" || value.length > 240 || !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(value) || value.split("/").some(part => part === "." || part === ".." || part.endsWith("."))) throw Error("Managed tool file path is unsafe.");
  return value;
}
export function validateManagedManifest(value: unknown, platform: string, arch: string): ManagedToolsManifest {
  const record = exact(value, ["format", "version", "bundleId", "platform", "arch", "files", "tools", "support"], "Tool bundle manifest");
  if (record.format !== "mnsg-managed-tools" || record.version !== 1 || typeof record.bundleId !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(record.bundleId)) throw Error("Unsupported tool bundle manifest.");
  if (!["darwin", "win32"].includes(platform) || !["arm64", "x64"].includes(arch) || (platform === "win32" && arch !== "x64") || record.platform !== platform || record.arch !== arch) throw Error("The bundled tools do not match this operating system and architecture.");
  if (!Array.isArray(record.files) || record.files.length < 6 || record.files.length > 4096) throw Error("Invalid tool file inventory.");
  const seen = new Set<string>(); let total = 0;
  const files = record.files.map(value => {
    const file = exact(value, ["path", "sha256", "byteLength", "executable"], "Tool file");
    const path = managedRelativePath(file.path);
    if (path === "manifest.json" || seen.has(path.toLowerCase()) || typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.byteLength) || (file.byteLength as number) < 0 || (file.byteLength as number) > 1024 ** 3 || typeof file.executable !== "boolean") throw Error("Invalid tool file inventory entry.");
    seen.add(path.toLowerCase()); total += file.byteLength as number;
    return { path, sha256: file.sha256, byteLength: file.byteLength as number, executable: file.executable };
  });
  if (total > 2 * 1024 ** 3) throw Error("Tool bundle exceeds the supported size.");
  const tools = exact(record.tools, ["clang", "linker", "modTool"], "Tool executable roles");
  const support = exact(record.support, ["header", "functions", "data"], "Tool support roles");
  for (const [key, name] of Object.entries({ ...tools, ...support })) {
    const path = managedRelativePath(name); const file = files.find(file => file.path === path);
    if (!file || file.executable !== (key in tools)) throw Error("Tool roles must reference declared files with the correct executable permission.");
  }
  const suffix = platform === "win32" ? ".exe" : "";
  if (tools.clang !== `bin/clang${suffix}` || tools.linker !== `bin/ld.lld${suffix}` || tools.modTool !== `bin/RecompModTool${suffix}` || support.header !== "include/modding.h" || support.functions !== "Goemon64RecompSyms/mnsg.us.syms.toml" || support.data !== "Goemon64RecompSyms/mnsg.us.datasyms.toml") throw Error("Tool bundle roles do not match the fixed editor build layout.");
  return { format: "mnsg-managed-tools", version: 1, bundleId: record.bundleId, platform: record.platform as ManagedToolsManifest["platform"], arch: record.arch as ManagedToolsManifest["arch"], files, tools: tools as unknown as ManagedToolsManifest["tools"], support: support as unknown as ManagedToolsManifest["support"] };
}
async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256"); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest("hex");
}
export async function verifyManagedFiles(root: string, manifest: ManagedToolsManifest): Promise<void> {
  if ((await lstat(root)).isSymbolicLink()) throw Error("Tool bundle directory must not be a symlink.");
  const declared = new Set(manifest.files.map(file => file.path));
  const walk = async (relative = "") => {
    for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw Error(`Tool bundle contains a symlink: ${name}`);
      if (entry.isDirectory()) { if (![...declared].some(file => file.startsWith(`${name}/`))) throw Error(`Tool bundle contains an undeclared directory: ${name}`); await walk(name); }
      else if (!entry.isFile() || (!declared.has(name) && name !== "manifest.json")) throw Error(`Tool bundle contains an undeclared file: ${name}`);
    }
  };
  await walk();
  for (const file of manifest.files) {
    const path = resolve(root, file.path);
    if (!path.startsWith(`${resolve(root)}${sep}`)) throw Error("Tool bundle escapes its resource directory.");
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== file.byteLength || (manifest.platform !== "win32" && file.executable && !(info.mode & 0o111)) || await hashFile(path) !== file.sha256) throw Error(`Bundled tool file is corrupt or incomplete: ${file.path}`);
  }
}

/** Parse only the small, bounded files required to prove this fixed probe archive. */
export function inspectProbeNrm(bytes: Uint8Array): void {
  const data = Buffer.from(bytes);
  if (data.length < 22 || data.length > 8 * 1024 * 1024) throw Error("Invalid probe NRM size.");
  let end = -1;
  for (let at = data.length - 22; at >= Math.max(0, data.length - 65557); at--) if (data.readUInt32LE(at) === 0x06054b50 && at + 22 + data.readUInt16LE(at + 20) === data.length) { end = at; break; }
  if (end < 0 || data.readUInt16LE(end + 4) || data.readUInt16LE(end + 6) || data.readUInt16LE(end + 8) !== data.readUInt16LE(end + 10)) throw Error("Unsupported probe NRM archive.");
  const count = data.readUInt16LE(end + 10), length = data.readUInt32LE(end + 12), start = data.readUInt32LE(end + 16);
  if (count > 32 || start + length !== end) throw Error("Invalid probe NRM directory.");
  const decoded = new Map<string, Buffer>(); let at = start;
  for (let i = 0; i < count; i++) {
    if (at + 46 > end || data.readUInt32LE(at) !== 0x02014b50) throw Error("Invalid probe NRM entry.");
    const flags = data.readUInt16LE(at + 8), method = data.readUInt16LE(at + 10), compressed = data.readUInt32LE(at + 20), size = data.readUInt32LE(at + 24), names = data.readUInt16LE(at + 28), extra = data.readUInt16LE(at + 30), comment = data.readUInt16LE(at + 32), local = data.readUInt32LE(at + 42);
    const next = at + 46 + names + extra + comment;
    if (next > end || flags & 1 || ![0, 8].includes(method) || size > 4 * 1024 * 1024 || compressed > 4 * 1024 * 1024 || local + 30 > start || data.readUInt32LE(local) !== 0x04034b50) throw Error("Unsafe probe NRM entry.");
    const name = data.subarray(at + 46, at + 46 + names).toString("utf8");
    if (decoded.has(name) || !/^[A-Za-z0-9_.-]+$/.test(name)) throw Error("Unsafe probe NRM file name.");
    const begin = local + 30 + data.readUInt16LE(local + 26) + data.readUInt16LE(local + 28);
    if (begin + compressed > start) throw Error("Probe NRM entry exceeds its archive bounds.");
    const packed = data.subarray(begin, begin + compressed);
    const output = method === 0 ? Buffer.from(packed) : inflateRawSync(packed, { maxOutputLength: 4 * 1024 * 1024 });
    if (output.length !== size) throw Error("Probe NRM entry length mismatch.");
    decoded.set(name, output); at = next;
  }
  if (at !== end || !decoded.get("mod_binary.bin")?.length || !decoded.get("mod_syms.bin")?.length) throw Error("Probe NRM has no native binary or symbol payload.");
  const manifest = JSON.parse(decoded.get("mod.json")?.toString("utf8") ?? "null");
  if (manifest?.id !== "mnsg_managed_probe" || manifest?.game_id !== "mnsg") throw Error("Probe NRM manifest is incompatible.");
}
async function execute(path: string, args: string[], cwd: string): Promise<string> {
  // Only OS-owned archiver lookup; no user PATH, CPATH or loader overrides.
  const env: NodeJS.ProcessEnv = { NODE_ENV: "production" };
  for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR"]) if (process.env[key]) env[key] = process.env[key];
  if (process.platform === "win32") {
    const system = process.env.SystemRoot ?? "C:\\Windows";
    env.PATH = `${join(system, "System32")};${join(system, "System32", "WindowsPowerShell", "v1.0")}`;
  } else env.PATH = "/usr/bin:/bin";
  return new Promise((resolve, reject) => execFile(path, args, { cwd, env, timeout: 120_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => error ? reject(Error(`Bundled build probe failed: ${error.message}\n${stdout}${stderr}`)) : resolve(`${stdout}${stderr}`)));
}
export async function probeManagedTools(config: ToolchainConfig): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "mnsg-managed-probe-"));
  try {
    await mkdir(join(directory, "build"));
    await mkdir(join(directory, "include")); await mkdir(join(directory, "Goemon64RecompSyms"));
    await copyFile(join(config.templatePath, "include/modding.h"), join(directory, "include/modding.h"));
    await copyFile(join(config.templatePath, "Goemon64RecompSyms/mnsg.us.syms.toml"), join(directory, "Goemon64RecompSyms/mnsg.us.syms.toml"));
    await copyFile(join(config.templatePath, "Goemon64RecompSyms/mnsg.us.datasyms.toml"), join(directory, "Goemon64RecompSyms/mnsg.us.datasyms.toml"));
    const targets = await execute(config.clangPath!, ["--no-default-config", "--print-targets"], directory);
    if (!/\bmips\b/.test(targets)) throw Error("Bundled Clang has no MIPS target.");
    await writeFile(join(directory, "probe.c"), '#include "modding.h"\nRECOMP_HOOK("func_8020D848_5C8D18")\nvoid mnsg_managed_probe(void) {}\n');
    await writeFile(join(directory, "mod.ld"), "RAMBASE = 0x81000000;\nMEMORY { extram(ARWX) : ORIGIN = RAMBASE, LENGTH = 64M }\nSECTIONS { /DISCARD/ : { *(.got) *(.MIPS.abiflags) *(.reginfo) *(.pdr) *(.comment) } }\n");
    // ASCII relative paths avoid the upstream Windows narrow-path boundary.
    await writeFile(join(directory, "mod.toml"), `[manifest]\nid = "mnsg_managed_probe"\nversion = "1.0.0"\ndisplay_name = "Managed tools probe"\ndescription = "Editor compiler compatibility check"\nshort_description = "Compiler check"\nauthors = ["MNSG Level Editor"]\ngame_id = "mnsg"\nminimum_recomp_version = "0.1.0"\ndependencies = []\nnative_libraries = []\n[inputs]\nelf_path = "build/probe.elf"\nmod_filename = "mnsg_managed_probe"\nfunc_reference_syms_file = "Goemon64RecompSyms/mnsg.us.syms.toml"\ndata_reference_syms_files = ["Goemon64RecompSyms/mnsg.us.datasyms.toml"]\nadditional_files = []\n`);
    await execute(config.clangPath!, ["--no-default-config", "-target", "mips", "-mips2", "-mabi=32", "-O2", "-G0", "-mno-abicalls", "-mno-odd-spreg", "-mno-check-zero-division", "-fomit-frame-pointer", "-fno-builtin", "-fno-jump-tables", "-Wall", "-Wextra", "-Werror", "-nostdinc", "-I", "include", "-c", "probe.c", "-o", "build/probe.o"], directory);
    await execute(config.linkerPath!, ["build/probe.o", "-nostdlib", "-T", "mod.ld", "--unresolved-symbols=ignore-all", "--emit-relocs", "-e", "0", "--no-nmagic", "-o", "build/probe.elf"], directory);
    const elf = await readFile(join(directory, "build/probe.elf"));
    if (elf.length < 52 || elf.readUInt32BE(0) !== 0x7f454c46 || elf[4] !== 1 || elf[5] !== 2 || elf.readUInt16BE(18) !== 8) throw Error("Bundled linker did not produce a big-endian MIPS ELF32 binary.");
    await execute(config.modToolPath!, ["mod.toml", "build"], directory);
    inspectProbeNrm(await readFile(join(directory, "build/mnsg_managed_probe.nrm")));
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export class ManagedTools {
  private pending?: Promise<ToolchainConfig>;
  constructor(private readonly root: string, private readonly cachePath: string, private readonly platform = process.platform as string, private readonly arch = process.arch as string, private readonly probe = probeManagedTools) {}
  async ensure(): Promise<ToolchainConfig> {
    if (this.pending) return this.pending;
    this.pending = this.verify();
    try { return await this.pending; } finally { this.pending = undefined; }
  }
  private async verify(): Promise<ToolchainConfig> {
    if (this.platform === "darwin" && Number(release().split(".")[0]) < 23) throw Error("Managed NRM tools require macOS 14 or newer.");
    const manifest = validateManagedManifest(await readJson(join(this.root, "manifest.json"), 512 * 1024), this.platform, this.arch);
    await verifyManagedFiles(this.root, manifest);
    const config: ToolchainConfig = { templatePath: this.root, clangPath: join(this.root, manifest.tools.clang), linkerPath: join(this.root, manifest.tools.linker), modToolPath: join(this.root, manifest.tools.modTool) };
    const fingerprint = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
    let cached = false;
    try { const value = await readJson(this.cachePath, 4096) as Record<string, unknown>; cached = value?.probeVersion === 1 && value?.fingerprint === fingerprint && value?.bundleId === manifest.bundleId && value?.platform === this.platform && value?.arch === this.arch; } catch { /* Re-run the fixed probe when the cache is absent or damaged. */ }
    if (!cached) {
      await this.probe(config);
      await verifyManagedFiles(this.root, manifest);
      await atomicWrite(this.cachePath, JSON.stringify({ probeVersion: 1, fingerprint, bundleId: manifest.bundleId, platform: this.platform, arch: this.arch }));
    }
    return config;
  }
  async status(): Promise<ToolchainStatus> {
    try { await this.ensure(); return { configured: true, ready: true, label: "Bundled offline MNSG build tools", missing: [], warnings: ["A successful build does not verify gameplay in Goemon64Recomp."] }; }
    catch (error) { return { configured: true, ready: false, label: "Bundled offline MNSG build tools", missing: [`${error instanceof Error ? error.message : String(error)} Repair or reinstall the application to restore its bundled build tools.`], warnings: [] }; }
  }
}
