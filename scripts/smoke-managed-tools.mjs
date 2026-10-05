// Offline compile/link/package proof, never launches Goemon64Recomp or a game.
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { inflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { validateBundle } from './managed-tools-contract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argument = process.argv.find((arg) => arg.startsWith('--bundle='));
const bundle = path.resolve(argument ? argument.slice(9) : path.join(root, 'resources/managed-tools'));
const manifest = await validateBundle(bundle);
const temporary = await mkdtemp(path.join(os.tmpdir(), "mnsg managed O'Brien-"));
const work = path.join(temporary, '日本語 probe with spaces');
const systemRoot = process.env.SystemRoot || 'C:\\Windows';
const env = process.platform === 'win32'
  ? { SystemRoot: systemRoot, WINDIR: systemRoot, PATH: `${systemRoot}\\System32;${systemRoot}\\System32\\WindowsPowerShell\\v1.0`, TEMP: temporary, TMP: temporary }
  : { PATH: '/usr/bin:/bin', HOME: temporary, TMPDIR: temporary, LANG: 'en_US.UTF-8' };
const run = (file, args) => execFileSync(file, args, { cwd: work, env, encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
const zipEntries = (bytes) => {
  const entries = new Map();
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65557) && bytes.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0 || bytes.readUInt32LE(end) !== 0x06054b50) throw new Error('NRM central directory missing');
  let offset = bytes.readUInt32LE(end + 16);
  const count = bytes.readUInt16LE(end + 10);
  for (let index = 0; index < count; index++) {
    if (bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error('Invalid NRM directory');
    const method = bytes.readUInt16LE(offset + 10);
    const size = bytes.readUInt32LE(offset + 20);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    const local = bytes.readUInt32LE(offset + 42);
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const compressed = bytes.subarray(start, start + size);
    if (entries.has(name) || (method !== 0 && method !== 8)) throw new Error('Unexpected NRM entry');
    entries.set(name, method === 8 ? inflateRawSync(compressed) : compressed);
    offset += 46 + nameLength + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
  }
  return entries;
};
try {
  await mkdir(path.join(work, 'build'), { recursive: true });
  await mkdir(path.join(work, "package O'Brien"), { recursive: true });
  await mkdir(path.join(work, 'include'), { recursive: true });
  await mkdir(path.join(work, 'Goemon64RecompSyms'), { recursive: true });
  await cp(path.join(bundle, manifest.support.header), path.join(work, 'include/modding.h'));
  await cp(path.join(bundle, manifest.support.functions), path.join(work, 'Goemon64RecompSyms/mnsg.us.syms.toml'));
  await cp(path.join(bundle, manifest.support.data), path.join(work, 'Goemon64RecompSyms/mnsg.us.datasyms.toml'));
  await writeFile(path.join(work, 'probe.c'), '#include "modding.h"\nextern void func_800353F8_35FF8(void);\nstatic volatile unsigned int counter;\nRECOMP_HOOK("func_8000D3B8_DFB8") void managed_probe(void) { counter++; func_800353F8_35FF8(); }\n');
  await writeFile(path.join(work, 'mod.ld'), 'RAMBASE = 0x81000000;\nMEMORY { extram(ARWX) : ORIGIN = RAMBASE, LENGTH = 64M }\nSECTIONS { /DISCARD/ : { *(.got) *(.MIPS.abiflags) *(.reginfo) *(.pdr) *(.comment) } }\n');
  await writeFile(path.join(work, 'mod.toml'), '[manifest]\nid="mnsg_managed_tools_probe"\nversion="1.0.0"\ndisplay_name="Managed tools probe"\ndescription="Offline build compatibility probe"\nshort_description="Offline probe"\nauthors=["MNSG Level Editor"]\ngame_id="mnsg"\nminimum_recomp_version="0.1.0"\ndependencies=[]\nnative_libraries=[]\n[inputs]\nelf_path="build/mod.elf"\nmod_filename="mnsg_managed_tools_probe"\nfunc_reference_syms_file="Goemon64RecompSyms/mnsg.us.syms.toml"\ndata_reference_syms_files=["Goemon64RecompSyms/mnsg.us.datasyms.toml"]\nadditional_files=[]\n');
  const clang = path.join(bundle, manifest.tools.clang);
  const targets = run(clang, ['--no-default-config', '--print-targets']);
  if (!/\bmips\b/i.test(targets)) throw new Error('Bundled compiler has no MIPS backend');
  run(clang, ['--no-default-config', '-target', 'mips', '-mips2', '-mabi=32', '-O2', '-G0', '-mno-abicalls', '-mno-odd-spreg', '-mno-check-zero-division', '-fomit-frame-pointer', '-fno-builtin', '-fno-jump-tables', '-Wall', '-Wextra', '-Werror', '-nostdinc', '-I', 'include', '-c', 'probe.c', '-o', 'build/mod.o']);
  run(path.join(bundle, manifest.tools.linker), ['build/mod.o', '-nostdlib', '-T', 'mod.ld', '--unresolved-symbols=ignore-all', '--emit-relocs', '-e', '0', '--no-nmagic', '-o', 'build/mod.elf']);
  // Relative arguments make the upstream narrow-character CLI independent of
  // the user's Unicode working-directory name on Windows.
  run(path.join(bundle, manifest.tools.modTool), ['mod.toml', "package O'Brien"]);
  const archive = await readFile(path.join(work, "package O'Brien/mnsg_managed_tools_probe.nrm"));
  const entries = zipEntries(archive);
  for (const required of ['mod.json', 'mod_binary.bin', 'mod_syms.bin']) if (!entries.get(required)?.length) throw new Error(`NRM missing ${required}`);
  const output = JSON.parse(entries.get('mod.json').toString('utf8'));
  if (output.id !== 'mnsg_managed_tools_probe' || output.game_id !== 'mnsg') throw new Error('NRM manifest identity mismatch');
  console.log(JSON.stringify({ bundle: manifest.bundleId, platform: process.platform, arch: process.arch, mips: true, nativeHook: true, nativeReference: true, isolatedSystemPath: true, nonAsciiAndApostrophePath: true, archiveEntries: [...entries.keys()], bytes: archive.length }));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
