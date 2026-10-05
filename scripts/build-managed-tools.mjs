// Build on the native target host. Build prerequisites belong to CI/developers,
// never to an installed editor's runtime. No ROM or game assets are consumed.
import { execFileSync, spawn } from 'node:child_process';
import { cp, mkdir, readFile, writeFile, chmod, access, rm, stat, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { bundleFiles, bundleId, sha256, validateBundle } from './managed-tools-contract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const options = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const index = arg.indexOf('=');
  return index < 0 ? [arg.replace(/^--/, ''), true] : [arg.slice(2, index), arg.slice(index + 1)];
}));
if (options['preflight-only'] && !options['stage-only']) throw new Error('Preflight-only requires existing configured sources with stage-only');
if (options['source-compile-probe'] && (options['stage-only'] || options['extract-only'])) throw new Error('Source compile probe must run separately from stage-only/extract-only modes');
if (!['darwin', 'win32'].includes(process.platform) || !['arm64', 'x64'].includes(process.arch)
  || (process.platform === 'win32' && process.arch !== 'x64')) throw new Error('Build requires a supported native host');
const work = path.resolve(options['work-dir'] || path.join(os.tmpdir(), 'mnsg-managed-tool-build'));
const destination = path.resolve(options.output || path.join(root, 'resources/managed-tools'));
const llvmArchiveName = 'llvm-project-21.1.8.src.tar.xz';
const llvmArchiveHash = '4633a23617fa31a3ea51242586ea7fb1da7140e426bd62fc164261fe036aa142';
const llvmUnwindHeaders = {
  'libunwind/include/__libunwind_config.h': '5e963e752482bf8cefcabbb6b4f3f09ae3bff247f59b7a2f1d8fcabbe539c18b',
  'libunwind/include/libunwind.h': '9f9a52c31dbb093e09ccef880652fdced398070b6062515a2fa118361cf8afb7',
  'libunwind/include/mach-o/compact_unwind_encoding.h': '06f58e9d0058583b6da91ca2328fa663f80d089496a4979754ee7608fe9bd877',
  'libunwind/include/unwind.h': 'e4a58637fc8ca1d29cd600c3c4416aafed50085edf276fa076214c8d81c263f0',
  'libunwind/include/unwind_arm_ehabi.h': '80edc55ea33440f46e676e4ac805ecdc64a7222f2c9107f8ff6b1097eb8a51df',
  'libunwind/include/unwind_itanium.h': 'c8cc61d806e13a2e75e93f1c15afd432f93a99283d27d15f5a28a3ebee989cba',
};
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
const run = (file, args, cwd = work, phase = 'tool preparation', timeoutMs = 10 * 60 * 1000, windowsVerbatimArguments = false) => new Promise((resolve, reject) => {
  console.log(`> ${file} ${args.join(' ')}`);
  const started = Date.now();
  const child = spawn(file, args, { cwd, stdio: 'inherit', shell: false, detached: process.platform !== 'win32', windowsVerbatimArguments });
  const heartbeat = setInterval(() => console.log(`${phase}: running for ${Math.round((Date.now() - started) / 1000)}s`), 30000);
  const timer = setTimeout(() => {
    if (child.pid) {
      try {
        if (process.platform === 'win32') execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { timeout: 10000, stdio: 'pipe' });
        else process.kill(-child.pid, 'SIGKILL');
      } catch { child.kill('SIGKILL'); }
    }
    clearInterval(heartbeat);
    reject(new Error(`${phase} exceeded its ${timeoutMs / 60000}-minute subprocess budget; the ${phase} subprocess was stopped.`));
  }, timeoutMs);
  const clean = () => { clearTimeout(timer); clearInterval(heartbeat); };
  child.on('error', (error) => { clean(); reject(error); });
  child.on('close', (code) => { clean(); code === 0 ? resolve() : reject(new Error(`${phase}: ${file} exited ${code}`)); });
});
await mkdir(work, { recursive: true });
const template = path.join(root, 'resources/managed-template');
const supportProvenance = JSON.parse(await readFile(path.join(template, 'provenance.json'), 'utf8'));
for (const file of supportProvenance.files) {
  if (sha256(await readFile(path.join(template, file.path))) !== file.sha256) throw new Error(`Pinned support hash mismatch: ${file.path}`);
}
const patch = path.join(root, 'scripts/patches/recomp-powershell-paths.patch');
const readCache = async (directory) => Object.fromEntries((await readFile(path.join(directory, 'CMakeCache.txt'), 'utf8'))
  .split(/\r?\n/).filter((line) => /^[A-Za-z0-9_]+:[^=]+=/.test(line)).map((line) => {
    const match = line.match(/^([A-Za-z0-9_]+):[^=]+=(.*)$/);
    return [match[1], match[2]];
  }));
const requireCache = (cache, key, expected) => {
  if (cache[key] !== expected) throw new Error(`Build cache ${key} must be ${expected}, found ${cache[key]}`);
};
const canonicalIdentity = async (value) => {
  const resolved = await realpath(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};
const licenseSources = [
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
];
const admitConfiguredSources = async () => {
  if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: recompSource, encoding: 'utf8' }).trim() !== recompCommit) throw new Error('Staged source revision mismatch');
  for (const [submodule, commit] of Object.entries(submodules)) {
    if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path.join(recompSource, submodule), encoding: 'utf8' }).trim() !== commit) throw new Error(`Staged dependency pin mismatch: ${submodule}`);
  }
  execFileSync('git', ['apply', '--reverse', '--check', patch], { cwd: recompSource, stdio: 'pipe' });
  const llvmCache = await readCache(llvmBuild), recompCache = await readCache(recompBuild);
  for (const cache of [llvmCache, recompCache]) {
    requireCache(cache, 'CMAKE_BUILD_TYPE', 'MinSizeRel');
    requireCache(cache, 'BUILD_SHARED_LIBS', 'OFF');
    if (process.platform === 'darwin') requireCache(cache, 'CMAKE_OSX_DEPLOYMENT_TARGET', '14.0');
    else requireCache(cache, 'CMAKE_MSVC_RUNTIME_LIBRARY', 'MultiThreaded');
  }
  requireCache(llvmCache, 'LLVM_TARGETS_TO_BUILD', 'Mips');
  for (const key of ['LLVM_BUILD_LLVM_DYLIB', 'LLVM_LINK_LLVM_DYLIB', 'CLANG_LINK_CLANG_DYLIB',
    'CLANG_ENABLE_STATIC_ANALYZER', 'CLANG_ENABLE_ARCMT', 'LLVM_ENABLE_ZLIB', 'LLVM_ENABLE_ZSTD',
    'LLVM_ENABLE_LIBXML2', 'LLVM_ENABLE_LIBEDIT']) requireCache(llvmCache, key, 'OFF');
  if (process.platform === 'win32') {
    requireCache(llvmCache, 'LLVM_USE_CRT_MINSIZEREL', 'MT');
    requireCache(llvmCache, 'LLVM_USE_CRT_RELEASE', 'MT');
  }
  for (const [name, cache, expected] of [['LLVM', llvmCache, path.join(llvmSource, 'llvm')], ['Recomp', recompCache, recompSource]]) {
    if (typeof cache.CMAKE_HOME_DIRECTORY !== 'string' || !cache.CMAKE_HOME_DIRECTORY) throw new Error(`Missing ${name} build cache source root`);
    if (await canonicalIdentity(cache.CMAKE_HOME_DIRECTORY) !== await canonicalIdentity(expected)) throw new Error(`${name} build cache source root mismatch`);
  }
  for (const [header, expected] of Object.entries(llvmUnwindHeaders)) {
    if (sha256(await readFile(path.join(llvmSource, header))) !== expected) throw new Error(`Pinned LLVM include dependency mismatch: ${header}`);
  }
  for (const [file] of licenseSources) if (!(await stat(file)).isFile()) throw new Error(`Missing native tool license source: ${file}`);
  console.log('Configured source/cache/CRT/license preflight passed for LLVM and RecompModTool.');
  return { llvmCache, recompCache };
};
const validateNativeDependencies = (target, label) => {
  if (process.platform === 'darwin') {
    const dependencies = execFileSync('/usr/bin/otool', ['-L', target], { encoding: 'utf8' });
    if (dependencies.split('\n').slice(1).some((line) => line.trim() && !/^\s+(\/usr\/lib\/|\/System\/Library\/)/.test(line))) throw new Error(`Non-system dynamic dependency in ${label}: ${dependencies}`);
    const load = execFileSync('/usr/bin/otool', ['-l', target], { encoding: 'utf8' });
    const minimum = load.match(/\bminos\s+(\d+)\.(\d+)/);
    if (!minimum || Number(minimum[1]) > 14) throw new Error(`Unsupported macOS minimum in ${label}`);
  } else {
    const dependencies = execFileSync('dumpbin', ['/DEPENDENTS', target], { encoding: 'utf8' });
    const imported = [...dependencies.matchAll(/^\s+([A-Za-z0-9_.-]+\.dll)\s*$/gim)].map((match) => match[1]);
    const system = /^(KERNEL32|USER32|ADVAPI32|SHELL32|OLE32|OLEAUT32|WS2_32|VERSION|NTDLL|CRYPT32|BCRYPT|SHLWAPI|COMDLG32|GDI32|RPCRT4|DBGHELP|PSAPI|api-ms-win-.+|ext-ms-win-.+)\.dll$/i;
    if (!imported.length || imported.some((name) => !system.test(name))) throw new Error(`Non-system Windows DLL in ${label}: ${imported.join(', ')}`);
  }
};
if (!options['stage-only']) {
  const archive = path.join(work, llvmArchiveName);
  if (!await exists(archive)) {
    await run('curl', ['-fL', '--connect-timeout', '30', '--max-time', '300', '--retry', '3', `https://github.com/llvm/llvm-project/releases/download/llvmorg-21.1.8/${llvmArchiveName}`, '-o', archive], work, 'LLVM source download');
  }
  if (sha256(await readFile(archive)) !== llvmArchiveHash) throw new Error('LLVM source archive checksum mismatch');
  const useStreamingExtractor = process.platform === 'win32' || options['extract-only'] || options['source-compile-probe'];
  if (useStreamingExtractor) {
    const marker = path.join(llvmSource, '.mnsg-llvm-extraction.json');
    if (!await exists(marker)) {
      await run(process.env.MNSG_BUILD_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
        ['-u', path.join(root, 'scripts/extract-llvm-source.py'), '--archive', archive, '--destination', llvmSource],
        work, 'LLVM source extraction', 12 * 60 * 1000);
    }
    const extracted = JSON.parse(await readFile(marker, 'utf8'));
    if (extracted.format !== 'mnsg-llvm-source-extraction' || extracted.version !== 1 || extracted.selectionVersion !== 2 || extracted.sha256 !== llvmArchiveHash
      || extracted.method !== 'python-streaming-lzmafile-tar' || extracted.uncompressedBufferBytes !== 65536) throw new Error('LLVM extraction completion marker does not match the pinned archive/extractor; use a fresh work directory');
    for (const [header, expected] of Object.entries(llvmUnwindHeaders)) {
      if (extracted.requiredHeaderHashes?.[header] !== expected) throw new Error(`LLVM extraction marker omits the pinned include dependency: ${header}`);
    }
  } else if (!await exists(path.join(llvmSource, 'llvm/CMakeLists.txt'))) {
    await run('tar', ['-xJf', archive, '-C', work], work, 'LLVM source extraction');
  }
  for (const [header, expected] of Object.entries(llvmUnwindHeaders)) {
    if (sha256(await readFile(path.join(llvmSource, header))) !== expected) throw new Error(`Pinned LLVM include dependency mismatch: ${header}`);
  }
  if (options['extract-only']) {
    console.log(`Verified extraction-only source: ${llvmSource}; no compiler build or application launch performed.`);
    process.exit(0);
  }
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
    '-DLLVM_ENABLE_BACKTRACES=OFF', '-DLLVM_ENABLE_DUMP=OFF', '-DLLVM_ENABLE_RTTI=OFF', '-DLLVM_ENABLE_EH=OFF',
    ...(options['source-compile-probe'] ? ['-DCMAKE_EXPORT_COMPILE_COMMANDS=ON'] : [])]);
  await run('cmake', ['-S', recompSource, '-B', recompBuild, ...common, '-DFMT_TEST=OFF', '-DFMT_DOC=OFF']);
  await admitConfiguredSources();
  await run('cmake', ['--build', recompBuild, '--target', 'RecompModTool', '--parallel', String(options.jobs || 3)], work, 'RecompModTool build', 15 * 60 * 1000);
  validateNativeDependencies(path.join(recompBuild, `RecompModTool${process.platform === 'win32' ? '.exe' : ''}`), 'RecompModTool preflight');
  if (options['source-compile-probe']) {
    const object = `tools/lld/MachO/CMakeFiles/lldMachO.dir/Arch/ARM64.cpp.${process.platform === 'win32' ? 'obj' : 'o'}`;
    if (generator === 'Ninja') {
      // Preserve the order-only dependency inventory as evidence, but compile
      // this one header consumer directly instead of building unrelated generators.
      await run('ninja', ['-C', llvmBuild, '-t', 'query', object], work, 'LLVM consumer prerequisite inventory', 60000);
    } else if (!(process.platform === 'darwin' && generator === 'Unix Makefiles')) throw new Error('Source consumer probe requires Ninja, or Unix Makefiles on macOS');
    const nativePath = (value) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
    // Windows TEMP may use RUNNER~1 while CMake records runneradmin. Resolve
    // existing roots/files before comparing the generated command's identity.
    const canonicalBuild = await realpath(llvmBuild);
    const objectPath = path.join(canonicalBuild, object);
    const sourcePath = await realpath(path.join(llvmSource, 'lld/MachO/Arch/ARM64.cpp'));
    const database = JSON.parse(await readFile(path.join(llvmBuild, 'compile_commands.json'), 'utf8'));
    const entries = [];
    for (const entry of database) {
      if (typeof entry.directory !== 'string' || typeof entry.file !== 'string' || typeof entry.output !== 'string'
        || !entry.file.replaceAll('\\', '/').toLowerCase().endsWith('/lld/macho/arch/arm64.cpp')) continue;
      if (nativePath(await realpath(path.resolve(entry.directory, entry.file))) === nativePath(sourcePath)
        && nativePath(path.resolve(canonicalBuild, entry.output)) === nativePath(objectPath)) entries.push(entry);
    }
    if (entries.length !== 1) throw new Error('CMake must record exactly one compiler command for the expected LLVM consumer object');
    const entry = entries[0];
    const commandDirectory = await realpath(entry.directory);
    const relativeDirectory = path.relative(canonicalBuild, commandDirectory);
    if (relativeDirectory.startsWith('..') || path.isAbsolute(relativeDirectory)
      || typeof entry.command !== 'string' || !entry.command || /[\0\r\n]/.test(entry.command)) throw new Error('Invalid generated LLVM consumer compile command/directory');
    await mkdir(path.dirname(objectPath), { recursive: true });
    await rm(objectPath, { force: true });
    console.log(`CMake compiler command directory: ${commandDirectory}`);
    // This command is generated locally by CMake from the checksum-pinned source,
    // with the normal compiler flags. No project/mod/ROM data enters this shell.
    if (process.platform === 'win32') {
      const cmd = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/cmd.exe');
      // Match Node's native CMD shell quoting: retain the generated internal quotes
      // and disable additional argv quoting around the complete command string.
      await run(cmd, ['/d', '/s', '/c', `"${entry.command}"`], commandDirectory, 'LLVM missing-header consumer compile', 2 * 60 * 1000, true);
    } else await run('/bin/sh', ['-c', entry.command], commandDirectory, 'LLVM missing-header consumer compile', 2 * 60 * 1000);
    const output = await stat(objectPath);
    if (!output.isFile() || output.size === 0) throw new Error('LLVM consumer object was not produced');
    console.log(`Source consumer compile probe passed: ${object}; shared source/cache/CRT/license/DLL preflight and RecompModTool build passed; no full LLVM build or bundle staging performed.`);
    process.exit(0);
  }
  await run('cmake', ['--build', llvmBuild, '--target', 'clang', 'lld', '--parallel', String(options.jobs || 3)], work, 'LLVM compiler build', 150 * 60 * 1000);
}
const { llvmCache, recompCache } = await admitConfiguredSources();
if (options['preflight-only']) process.exit(0);
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
for (const [source, target] of licenseSources) await cp(source, path.join(destination, 'licenses', target));
const executables = [`bin/clang${suffix}`, `bin/ld.lld${suffix}`, `bin/RecompModTool${suffix}`];
for (const executable of executables) {
  const target = path.join(destination, executable);
  if (process.platform === 'darwin') {
    await run('/usr/bin/strip', ['-x', target]);
    validateNativeDependencies(target, executable);
    await run('/usr/bin/codesign', ['--force', '--sign', '-', target]);
  } else {
    validateNativeDependencies(target, executable);
  }
}
await writeFile(path.join(destination, 'build-provenance.json'), JSON.stringify({
  format: 'mnsg-managed-tools-provenance', version: 1, bundleId,
  llvm: { version: '21.1.8', sourceArchive: llvmArchiveName, sha256: llvmArchiveHash },
  recomp: { repository: 'https://github.com/N64Recomp/N64Recomp', commit: recompCommit, submodules,
    patches: [{ path: 'recomp-powershell-paths.patch', sha256: sha256(await readFile(patch)) }] },
  template: supportProvenance, build: { type: llvmCache.CMAKE_BUILD_TYPE, targetBackend: llvmCache.LLVM_TARGETS_TO_BUILD,
    staticLlvm: llvmCache.LLVM_LINK_LLVM_DYLIB === 'OFF', staticAnalyzer: false, arcMigration: false,
    macOSMinimum: process.platform === 'darwin' ? llvmCache.CMAKE_OSX_DEPLOYMENT_TARGET : null,
    windowsCrt: process.platform === 'win32' ? llvmCache.LLVM_USE_CRT_MINSIZEREL : null,
    llvmCacheSha256: sha256(await readFile(path.join(llvmBuild, 'CMakeCache.txt'))),
    recompCacheSha256: sha256(await readFile(path.join(recompBuild, 'CMakeCache.txt'))) },
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
