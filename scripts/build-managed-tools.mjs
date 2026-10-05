// Build on the native target host. Build prerequisites belong to CI/developers,
// never to an installed editor's runtime. No ROM or game assets are consumed.
import { execFileSync, spawn } from 'node:child_process';
import { cp, mkdir, readFile, writeFile, chmod, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { bundleFiles, bundleId, sha256, validateBundle } from './managed-tools-contract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const options = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const index = arg.indexOf('=');
  return index < 0 ? [arg.replace(/^--/, ''), true] : [arg.slice(2, index), arg.slice(index + 1)];
}));
if (!['darwin', 'win32'].includes(process.platform) || !['arm64', 'x64'].includes(process.arch)
  || (process.platform === 'win32' && process.arch !== 'x64')) throw new Error('Build requires a supported native host');
const work = path.resolve(options['work-dir'] || path.join(os.tmpdir(), 'mnsg-managed-tool-build'));
const destination = path.resolve(options.output || path.join(root, 'resources/managed-tools'));
const llvmArchiveName = 'llvm-project-21.1.8.src.tar.xz';
const llvmArchiveHash = '4633a23617fa31a3ea51242586ea7fb1da7140e426bd62fc164261fe036aa142';
const recompCommit = 'ffb39cdad1da5de07eaaa48bd1db4a89a7986771';
const submodules = {
  'lib/ELFIO': 'ad8b641f9682b6091ba8b9f7c8152255c1a2c803',
  'lib/fmt': '407c905e45ad75fc29bf0f9bb7c5c2fd3475976f',
  'lib/rabbitizer': 'e0d8003047938e2ec3697eaf8d61a84d11d17b43',
  'lib/sljit': 'f6326087b3404efb07c6d3deed97b3c3b8098c0c',
  'lib/tomlplusplus': '1f7884e59165e517462f922e7b6de131bd9844f3',
};
const llvmSource = path.resolve(options['llvm-source'] || path.join(work, 'llvm-project-21.1.8.src'));
const recompSource = path.resolve(options['recomp-source'] || path.join(work, 'N64Recomp'));
const llvmBuild = path.resolve(options['llvm-build'] || path.join(work, 'llvm-build'));
const recompBuild = path.resolve(options['recomp-build'] || path.join(work, 'recomp-build'));
const exists = async (target) => access(target).then(() => true, () => false);
const run = (file, args, cwd = work) => new Promise((resolve, reject) => {
  console.log(`> ${file} ${args.join(' ')}`);
  const child = spawn(file, args, { cwd, stdio: 'inherit', shell: false });
  child.on('error', reject);
  child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`${file} exited ${code}`)));
});
await mkdir(work, { recursive: true });
const template = path.join(root, 'resources/managed-template');
const supportProvenance = JSON.parse(await readFile(path.join(template, 'provenance.json'), 'utf8'));
for (const file of supportProvenance.files) {
  if (sha256(await readFile(path.join(template, file.path))) !== file.sha256) throw new Error(`Pinned support hash mismatch: ${file.path}`);
}
const patch = path.join(root, 'scripts/patches/recomp-powershell-paths.patch');
if (!options['stage-only']) {
  const archive = path.join(work, llvmArchiveName);
  if (!await exists(archive)) {
    await run('curl', ['-fL', '--retry', '3', `https://github.com/llvm/llvm-project/releases/download/llvmorg-21.1.8/${llvmArchiveName}`, '-o', archive]);
  }
  if (sha256(await readFile(archive)) !== llvmArchiveHash) throw new Error('LLVM source archive checksum mismatch');
  if (!await exists(path.join(llvmSource, 'llvm/CMakeLists.txt'))) await run('tar', ['-xJf', archive, '-C', work]);
  if (!await exists(path.join(recompSource, '.git'))) {
    await run('git', ['clone', '--no-checkout', 'https://github.com/N64Recomp/N64Recomp.git', recompSource]);
    await run('git', ['checkout', '--detach', recompCommit], recompSource);
    await run('git', ['submodule', 'update', '--init', '--recursive'], recompSource);
  }
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: recompSource, encoding: 'utf8' }).trim();
  if (head !== recompCommit) throw new Error('Recomp source revision mismatch');
  for (const [submodule, commit] of Object.entries(submodules)) {
    if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path.join(recompSource, submodule), encoding: 'utf8' }).trim() !== commit) throw new Error(`Dependency pin mismatch: ${submodule}`);
  }
  // Apply only the tracked, auditable packaging-path patch, never remote patches.
  try { execFileSync('git', ['apply', '--reverse', '--check', patch], { cwd: recompSource, stdio: 'pipe' }); }
  catch { await run('git', ['apply', '--check', patch], recompSource); await run('git', ['apply', patch], recompSource); }
  const generator = options.generator || (process.platform === 'win32' ? 'Ninja' : 'Unix Makefiles');
  const native = process.platform === 'darwin'
    ? ['-DCMAKE_OSX_DEPLOYMENT_TARGET=14.0', '-DCMAKE_C_COMPILER=/usr/bin/clang', '-DCMAKE_CXX_COMPILER=/usr/bin/clang++']
    : ['-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded', '-DLLVM_USE_CRT_RELEASE=MT', '-DLLVM_USE_CRT_MINSIZEREL=MT'];
  const common = ['-G', generator, '-DCMAKE_BUILD_TYPE=MinSizeRel', '-DBUILD_SHARED_LIBS=OFF', '-DCMAKE_POLICY_DEFAULT_CMP0091=NEW', ...native];
  await run('cmake', ['-S', path.join(llvmSource, 'llvm'), '-B', llvmBuild, ...common,
    '-DLLVM_ENABLE_PROJECTS=clang;lld', '-DLLVM_TARGETS_TO_BUILD=Mips', '-DLLVM_BUILD_LLVM_DYLIB=OFF',
    '-DLLVM_LINK_LLVM_DYLIB=OFF', '-DCLANG_LINK_CLANG_DYLIB=OFF', '-DLLVM_ENABLE_ZLIB=OFF',
    '-DLLVM_ENABLE_ZSTD=OFF', '-DLLVM_ENABLE_LIBXML2=OFF', '-DLLVM_ENABLE_LIBEDIT=OFF',
    '-DLLVM_INCLUDE_TESTS=OFF', '-DLLVM_INCLUDE_EXAMPLES=OFF', '-DLLVM_INCLUDE_BENCHMARKS=OFF',
    '-DLLVM_INCLUDE_DOCS=OFF', '-DLLVM_ENABLE_BINDINGS=OFF', '-DLLVM_ENABLE_ASSERTIONS=OFF',
    '-DCLANG_ENABLE_STATIC_ANALYZER=OFF', '-DCLANG_ENABLE_ARCMT=OFF',
    '-DLLVM_ENABLE_BACKTRACES=OFF', '-DLLVM_ENABLE_DUMP=OFF', '-DLLVM_ENABLE_RTTI=OFF', '-DLLVM_ENABLE_EH=OFF']);
  await run('cmake', ['--build', llvmBuild, '--target', 'clang', 'lld', '--parallel', String(options.jobs || 3)]);
  await run('cmake', ['-S', recompSource, '-B', recompBuild, ...common, '-DFMT_TEST=OFF', '-DFMT_DOC=OFF']);
  await run('cmake', ['--build', recompBuild, '--target', 'RecompModTool', '--parallel', String(options.jobs || 3)]);
}
// --stage-only is for already completed builds from these same pinned sources.
// It still checks source identity, pinned support and every packaged dependency.
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: recompSource, encoding: 'utf8' }).trim() !== recompCommit) throw new Error('Staged source revision mismatch');
const suffix = process.platform === 'win32' ? '.exe' : '';
await mkdir(path.join(destination, 'bin'), { recursive: true });
await cp(template, destination, { recursive: true });
await mkdir(path.join(destination, 'licenses'), { recursive: true });
for (const [source, target] of [
  [path.join(llvmBuild, `bin/clang${suffix}`), `bin/clang${suffix}`],
  [path.join(llvmBuild, `bin/lld${suffix}`), `bin/ld.lld${suffix}`],
  [path.join(recompBuild, `RecompModTool${suffix}`), `bin/RecompModTool${suffix}`],
]) {
  await cp(source, path.join(destination, target), { dereference: true });
  if (process.platform !== 'win32') await chmod(path.join(destination, target), 0o755);
}
for (const [source, target] of [
  [path.join(llvmSource, 'LICENSE.TXT'), 'LLVM-Apache-2.0-with-exceptions.txt'],
  [path.join(llvmSource, 'llvm/LICENSE.TXT'), 'LLVM-legacy-notices.txt'],
  [path.join(llvmSource, 'llvm/include/llvm/Support/LICENSE.TXT'), 'LLVM-Support-notices.txt'],
  [path.join(llvmSource, 'llvm/lib/Support/BLAKE3/LICENSE'), 'BLAKE3.txt'],
  [path.join(llvmSource, 'clang/LICENSE.TXT'), 'Clang-notices.txt'],
  [path.join(llvmSource, 'lld/LICENSE.TXT'), 'LLD-notices.txt'],
  [path.join(recompSource, 'LICENSE'), 'N64Recomp-MIT.txt'],
  [path.join(recompSource, 'lib/fmt/LICENSE'), 'fmt.txt'],
  [path.join(recompSource, 'lib/tomlplusplus/LICENSE'), 'tomlplusplus.txt'],
  [path.join(recompSource, 'lib/ELFIO/LICENSE.txt'), 'ELFIO.txt'],
]) await cp(source, path.join(destination, 'licenses', target));
const executables = [`bin/clang${suffix}`, `bin/ld.lld${suffix}`, `bin/RecompModTool${suffix}`];
for (const executable of executables) {
  const target = path.join(destination, executable);
  if (process.platform === 'darwin') {
    await run('/usr/bin/strip', ['-x', target]);
    const dependencies = execFileSync('/usr/bin/otool', ['-L', target], { encoding: 'utf8' });
    if (dependencies.split('\n').slice(1).some((line) => line.trim() && !/^\s+(\/usr\/lib\/|\/System\/Library\/)/.test(line))) throw new Error(`Non-system dynamic dependency in ${executable}: ${dependencies}`);
    const load = execFileSync('/usr/bin/otool', ['-l', target], { encoding: 'utf8' });
    const minimum = load.match(/\bminos\s+(\d+)\.(\d+)/);
    if (!minimum || Number(minimum[1]) > 14) throw new Error(`Unsupported macOS minimum in ${executable}`);
    await run('/usr/bin/codesign', ['--force', '--sign', '-', target]);
  } else {
    const dependencies = execFileSync('dumpbin', ['/DEPENDENTS', target], { encoding: 'utf8' });
    const imported = [...dependencies.matchAll(/^\s+([A-Za-z0-9_.-]+\.dll)\s*$/gim)].map((match) => match[1]);
    const system = /^(KERNEL32|USER32|ADVAPI32|SHELL32|OLE32|OLEAUT32|WS2_32|VERSION|NTDLL|CRYPT32|BCRYPT|SHLWAPI|COMDLG32|GDI32|RPCRT4|DBGHELP|PSAPI|api-ms-win-.+|ext-ms-win-.+)\.dll$/i;
    if (!imported.length || imported.some((name) => !system.test(name))) throw new Error(`Non-system Windows DLL in ${executable}: ${imported.join(', ')}`);
  }
}
await writeFile(path.join(destination, 'build-provenance.json'), JSON.stringify({
  format: 'mnsg-managed-tools-provenance', version: 1, bundleId,
  llvm: { version: '21.1.8', sourceArchive: llvmArchiveName, sha256: llvmArchiveHash },
  recomp: { repository: 'https://github.com/N64Recomp/N64Recomp', commit: recompCommit, submodules,
    patches: [{ path: 'recomp-powershell-paths.patch', sha256: sha256(await readFile(patch)) }] },
  template: supportProvenance, build: { type: 'MinSizeRel', targetBackend: 'Mips', staticLlvm: true, macOSMinimum: '14.0', windowsCrt: 'MT' },
}, null, 2) + '\n');
await cp(patch, path.join(destination, 'recomp-powershell-paths.patch'));
const files = [];
for (const relative of (await bundleFiles(destination)).filter((name) => name !== 'manifest.json')) {
  const bytes = await readFile(path.join(destination, relative));
  files.push({ path: relative, sha256: sha256(bytes), byteLength: bytes.length, executable: executables.includes(relative) });
}
await writeFile(path.join(destination, 'manifest.json'), JSON.stringify({
  format: 'mnsg-managed-tools', version: 1, bundleId, platform: process.platform, arch: process.arch, files,
  tools: { clang: executables[0], linker: executables[1], modTool: executables[2] },
  support: { header: 'include/modding.h', functions: 'Goemon64RecompSyms/mnsg.us.syms.toml', data: 'Goemon64RecompSyms/mnsg.us.datasyms.toml' },
}, null, 2) + '\n');
await validateBundle(destination);
console.log(`Verified native managed tools: ${destination}`);
